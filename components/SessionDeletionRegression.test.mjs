import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import test from "node:test";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const activityPanel = await readFile(new URL("./SessionActivityPanel.tsx", import.meta.url), "utf8");
const worktreeShell = await readFile(new URL("./app-shell-worktree.tsx", import.meta.url), "utf8");
const { useAppShellWorktree } = await createJiti(import.meta.url, { fsCache: false, jsx: { runtime: "automatic" }, tsconfigPaths: true }).import("./app-shell-worktree.tsx");

function deletionHandler(source) {
  const start = source.indexOf("const handleSessionDeleted");
  const end = source.indexOf("const handleOpenFile", start);
  assert.ok(start >= 0 && end > start, "session deletion handler not found");
  return source.slice(start, end);
}

test("current embedded deletion unmounts the stale reader document", () => {
  const deletion = deletionHandler(appShell);
  const embeddedBranch = deletion.slice(
    deletion.indexOf("if (embeddedOwnsSession)"),
    deletion.indexOf("clearTalkMapSelection"),
  );
  assert.match(embeddedBranch, /setEmbeddedSessionKey\(null\)/);
  assert.match(embeddedBranch, /setEmbeddedIframeSessionId\(null\)/);
  assert.match(embeddedBranch, /setEmbeddedReaderUrl\(null\)/);
});

test("activity search deletion reaches the shell invalidation callback", () => {
  const panelSearch = activityPanel.slice(activityPanel.indexOf("visibleSearchResults.map"));
  const sidebarSearch = activityPanel.slice(activityPanel.lastIndexOf("visibleSearchResults.map"));
  assert.match(panelSearch, /<ActivitySearchHitRow[\s\S]*?onSessionDeleted=\{onSessionDeleted\}/);
  assert.match(sidebarSearch, /<ActivitySearchHitRow[\s\S]*?onSessionDeleted=\{onSessionDeleted\}/);

  const searchHit = activityPanel.slice(activityPanel.indexOf("function ActivitySearchHitRow"));
  assert.match(searchHit, /onSessionDeleted/);
  assert.match(searchHit, /<SessionActivitySidebarRow[\s\S]*?onSessionDeleted=\{onSessionDeleted\}/);
});

test("session deletion avoids global refreshKey broadcast and hard reload", () => {
  const deletion = deletionHandler(appShell);
  assert.doesNotMatch(deletion, /setRefreshKey\(/);
  assert.match(deletion, /const subprojectId = selectedSession\.subprojectId \?\? null;/);
  assert.match(deletion, /setNewSessionSubprojectId\(subprojectId\);/);
  assert.doesNotMatch(appShell, /window\.location\.replace\(window\.location\.pathname\)/);
});

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://reader.test/" });
  const previous = new Map();
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Text: dom.window.Text,
    Document: dom.window.Document,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    DOMException: dom.window.DOMException,
  })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return () => {
    dom.window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

function HookHarness({ callbacksRef, stateRef }) {
  stateRef.current = useAppShellWorktree({
    callbacksRef,
    localDeviceId: "local-device",
    localDeviceName: "Local",
    translate: (key) => key,
  });
  return null;
}

function makeCallbacks() {
  return {
    handleSelectSession() {},
    openRemoteSession() {},
    loadLocalSession: async () => null,
    invalidateWorkspaceRestore() {},
    handleNewActivitySession() {},
    handleSessionDeleted() {},
    mutateRemoteSession: async () => true,
    handleCwdChange() {},
    bumpRefresh() {},
  };
}

async function mountWorktree() {
  const restoreDom = installDom();
  const callbacksRef = { current: makeCallbacks() };
  const stateRef = { current: null };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(HookHarness, { callbacksRef, stateRef }));
    await tick();
  });
  return { callbacksRef, stateRef, root, restoreDom };
}

async function unmountWorktree({ root, restoreDom }) {
  await React.act(async () => {
    root.unmount();
    await tick();
  });
  restoreDom();
}

test("Talk Map deletion notifications clear only the matching live highlight", async () => {
  const deletion = deletionHandler(appShell);
  assert.match(deletion, /clearTalkMapSelection\(sessionId\)/);
  assert.doesNotMatch(deletion, /clearTalkMapSelection\(\);/);
  assert.match(worktreeShell, /clearTalkMapSelection\(session\.id\)/);
  const mounted = await mountWorktree();
  try {
    await React.act(async () => {
      mounted.stateRef.current.openTalkMap("/repo", undefined, "session-a");
      await tick();
    });
    mounted.stateRef.current.handleTalkMapSelectCard({ id: "session-b" });
    await React.act(async () => { await tick(); });
    await React.act(async () => {
      mounted.stateRef.current.clearTalkMapSelection("session-a");
      await tick();
    });
    assert.equal(mounted.stateRef.current.talkMapSidebarSessionId, "session-b");
    await React.act(async () => {
      mounted.stateRef.current.clearTalkMapSelection("session-b");
      await tick();
    });
    assert.equal(mounted.stateRef.current.talkMapSidebarSessionId, null);
  } finally {
    await unmountWorktree(mounted);
  }
});

test("Talk Map mutation preserves a newer selection and does not clear on failure", async () => {
  const previousFetch = globalThis.fetch;
  const pending = [];
  globalThis.fetch = async () => new Promise((resolve) => pending.push(resolve));
  const mounted = await mountWorktree();
  try {
    await React.act(async () => {
      mounted.stateRef.current.openTalkMap("/repo", undefined, "session-a");
      await tick();
    });
    const mutation = mounted.stateRef.current.handleTalkMapSessionMutation({ id: "session-a", cwd: "/repo" }, "delete");
    mounted.stateRef.current.handleTalkMapSelectCard({ id: "session-b" });
    await React.act(async () => { await tick(); });
    assert.equal(pending.length, 1);
    pending[0]({ ok: true, status: 200 });
    await React.act(async () => {
      await mutation;
      await tick();
    });
    assert.equal(mounted.stateRef.current.talkMapSidebarSessionId, "session-b");

    await React.act(async () => {
      mounted.stateRef.current.handleTalkMapSelectCard({ id: "session-a" });
      await tick();
    });
    const archived = mounted.stateRef.current.handleTalkMapSessionMutation({ id: "session-a", cwd: "/repo" }, "archive");
    assert.equal(pending.length, 2);
    pending[1]({ ok: true, status: 200 });
    await React.act(async () => {
      await archived;
      await tick();
    });
    assert.equal(mounted.stateRef.current.talkMapSidebarSessionId, null);

    await React.act(async () => {
      mounted.stateRef.current.handleTalkMapSelectCard({ id: "session-a" });
      await tick();
    });
    const failed = mounted.stateRef.current.handleTalkMapSessionMutation({ id: "session-a", cwd: "/repo" }, "archive");
    assert.equal(pending.length, 3);
    pending[2]({ ok: false, status: 500 });
    await assert.rejects(failed, /Talk Map session HTTP 500/);
    assert.equal(mounted.stateRef.current.talkMapSidebarSessionId, "session-a");
  } finally {
    globalThis.fetch = previousFetch;
    await unmountWorktree(mounted);
  }
});
