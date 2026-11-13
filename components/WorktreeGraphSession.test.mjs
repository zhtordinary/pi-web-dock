import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import test from "node:test";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false, jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { mergeAssociatedWorktreeSessions, preferredWorktreePath } = await jiti.import("./WorktreeGraphOverlay.tsx");
const { useAppShellWorktree } = await jiti.import("./app-shell-worktree.tsx");
const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const worktreeShell = await readFile(new URL("./app-shell-worktree.tsx", import.meta.url), "utf8");
const graph = await readFile(new URL("./WorktreeGraphOverlay.tsx", import.meta.url), "utf8");
const docs = await readFile(new URL("../docs/worktrees.md", import.meta.url), "utf8");

test("new session from the worktree graph reuses the selected checkout", () => {
  const start = worktreeShell.indexOf("const handleWorktreeGraphNewSession");
  const end = worktreeShell.indexOf("const handleOpenTalkMapForSession", start);
  assert.ok(start >= 0 && end > start);
  const handler = worktreeShell.slice(start, end);
  assert.match(handler, /handleNewActivitySession\(worktree\.path/);
  assert.match(handler, /worktreeBinding/);
  assert.doesNotMatch(handler, /addWorktree|fetch\([^\n]*worktrees/);
  assert.match(graph, /worktreeGraph\.newSessionFromMain/);
  assert.match(graph, /worktreeGraph\.newSessionFromWorktree/);
  assert.match(graph, /worktreeGraph\.newSessionReuseHint/);
});

test("worktree documentation keeps physical creation separate from session creation", () => {
  assert.match(docs, /New session.*never create another Git worktree/s);
  assert.match(docs, /New worktree\.\.\./);
  assert.match(docs, /DevSpace, task/);
});

test("worktree inspector lists sessions by cwd with an explicit empty state", () => {
  assert.match(graph, /session-runs\?scope=local/);
  assert.match(graph, /sameWorktreePath\(item\.session\.cwd, selectedPath\)/);
  assert.match(graph, /data-testid="worktree-associated-sessions"/);
  assert.match(graph, /worktreeGraph\.noAssociatedSessions/);
  assert.match(graph, /worktreeGraph\.sessionId/);
  assert.match(graph, /item\.id\.slice\(0, 8\)/);
  assert.match(graph, /sessionActivity\.status\.\$\{item\.status\}/);
  assert.match(docs, /cwd.*matches the selected worktree path/);
  assert.match(graph, /worktreeGraph\.relationTaskRoot/);
});

test("associated session rows open the exact local or remote session", () => {
  assert.match(graph, /onOpenSession\(item\.id, selectedWorktree\.path\)/);
  assert.match(graph, /data-worktree-associated-session=\{item\.id\}/);
  const associatedRowStart = graph.indexOf("data-worktree-associated-session={item.id}");
  const associatedRowEnd = graph.indexOf("</button>", associatedRowStart);
  assert.ok(associatedRowStart >= 0 && associatedRowEnd > associatedRowStart);
  assert.doesNotMatch(graph.slice(associatedRowStart, associatedRowEnd), /onClose\(\)/);
  assert.match(graph, /type="button"/);
  assert.match(appShell, /onOpenSession=\{handleWorktreeGraphOpenSession\}/);
  const start = worktreeShell.indexOf("const handleWorktreeGraphOpenSession");
  const end = worktreeShell.indexOf("const handleOpenTalkMapForSession", start);
  assert.ok(start >= 0 && end > start);
  const handler = worktreeShell.slice(start, end);
  assert.match(handler, /loadLocalSession\(sessionId\)/);
  assert.match(handler, /openRemoteSession\(device, sessionId/);
  assert.match(handler, /requestSerial !== worktreeOpenRequestSerialRef\.current/);
  assert.doesNotMatch(handler, /callbacksRef\.current !== callbacks/);
  assert.match(handler, /Session \$\{sessionId\} not found/);
});

test("opening the graph prefers the current session worktree", () => {
  assert.match(graph, /preferredWorktreePath\(graph\?\.worktrees \?\? \[\], currentWorktreePath, currentSessionId, creationHistory\)/);
  assert.match(graph, /sameWorktreePath\(w\.path, sessionPreferredPath\)/);
  assert.match(graph, /currentWorktreePath && sameWorktreePath\(currentWorktreePath, wt\.path\)/);
  assert.match(appShell, /openWorktreeGraph\(topBarProjectPath, device, \{ id: topBarSession\?\.id \?\? null, cwd: topBarSession\?\.cwd \?\? null \}\)/);
  assert.match(appShell, /currentSessionId=\{worktreeGraphSessionId \?\? topBarSessionId\}/);
});

test("a verified creation record selects the linked worktree for its current session", () => {
  const worktrees = [
    { path: "/repo", isMain: true },
    { path: "/repo/.worktrees/task", isMain: false },
  ];
  assert.equal(preferredWorktreePath(worktrees, "/repo", "creator", {
    partial: false,
    records: [{ worktreePath: "/repo/.worktrees/task", sessionId: "creator", createdAt: "2026-01-01" }],
  }), "/repo/.worktrees/task");
});

test("verified worktree creators appear in the associated-session list", () => {
  assert.match(graph, /creationHistory: "1"/);
  assert.match(graph, /mergeAssociatedWorktreeSessions\(selectedPath, associatedSessions, creationHistory\)/);
  assert.match(graph, /data-testid="worktree-associated-sessions"/);
  assert.doesNotMatch(graph, /data-testid="worktree-creation-history"|worktreeGraph\.creationHistory/);
  assert.match(graph, /associatedSessionsIncomplete/);
  assert.match(graph, /associatedSessionsRefreshKey, fetchCreationHistory/);
  assert.match(docs, /whose `cwd` matches the selected worktree path, sessions whose successful tool history confirms they created that worktree, and sessions with a verified structured/);
});

test("cwd sessions and verified creators share one list without duplicate IDs", () => {
  const activity = (id, cwd, name, status, relation) => ({ session: { id, cwd, name, firstMessage: "", path: `/tmp/${id}.jsonl`, created: "2026-01-01", modified: "2026-01-01", messageCount: 1, ...(relation ? { relation } : {}) }, status });
  const result = mergeAssociatedWorktreeSessions("/repo/.worktrees/task", [
    activity("cwd-session", "/repo/.worktrees/task", "Runs here", "running"),
    activity("creator-session", "/repo", "Created it", "idle"),
  ], { partial: false, records: [
    { worktreePath: "/repo/.worktrees/task", sessionId: "cwd-session", sessionName: "Duplicate title", createdAt: "2026-01-01" },
    { worktreePath: "/repo/.worktrees/task", sessionId: "creator-session", sessionName: "Older title", createdAt: "2026-01-01" },
    { worktreePath: "/repo/.worktrees/task", sessionId: "history-only", sessionName: "History session", createdAt: "2026-01-01" },
  ], bindings: [
    { worktreePath: "/repo/.worktrees/task", sessionId: "task-owner", sessionName: "Task owner", relation: "task-root", createdAt: "2026-01-01" },
    { worktreePath: "/repo/.worktrees/task", sessionId: "creator-session", sessionName: "Duplicate binding", relation: "task-root", createdAt: "2026-01-01" },
  ] });
  assert.deepEqual(result, [
    { id: "cwd-session", title: "Runs here", status: "running", relations: ["cwd", "creator"] },
    { id: "creator-session", title: "Created it", status: "idle", relations: ["creator", "task-root"] },
    { id: "history-only", title: "History session", relations: ["creator"] },
    { id: "task-owner", title: "Task owner", relations: ["task-root"] },
  ]);
});

test("collapses subagent-associated sessions to their owning main session", () => {
  const activity = (id, cwd, name, status, relation) => ({ session: { id, cwd, name, firstMessage: "", path: `/tmp/${id}.jsonl`, created: "2026-01-01", modified: "2026-01-01", messageCount: 1, ...(relation ? { relation } : {}) }, status });
  const subagent = (id, parentSessionId, description) => ({ kind: "subagent", parentSessionId, profile: "worker", description, status: "completed" });
  const result = mergeAssociatedWorktreeSessions("/repo/.worktrees/task", [
    activity("main", "/repo", "Main session", "idle"),
    activity("child", "/repo/.worktrees/task", "Child session", "failed", subagent("child", "main", "Child")),
    activity("grandchild", "/repo/.worktrees/task", "Grandchild session", "running", subagent("grandchild", "child", "Grandchild")),
  ], { partial: false, records: [
    { worktreePath: "/repo/.worktrees/task", sessionId: "grandchild", sessionName: "Child creator", createdAt: "2026-01-01" },
  ] });
  assert.deepEqual(result, [
    { id: "main", title: "Main session", status: "idle", relations: ["cwd", "creator"] },
  ]);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://reader.test/" });
  const previous = new Map();
  const globals = {
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
  };
  for (const [name, value] of Object.entries(globals)) {
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

function WorktreeHookHarness({ callbacksRef, stateRef }) {
  stateRef.current = useAppShellWorktree({
    callbacksRef,
    localDeviceId: "local-device",
    localDeviceName: "Local",
    translate: (key) => key,
  });
  return null;
}

function makeCallbacks({ loadLocalSession, selected, remoteOpened, onInvalidate, onDeleted } = {}) {
  return {
    handleSelectSession: (session) => selected?.push(session),
    openRemoteSession: (...args) => remoteOpened?.push(args),
    loadLocalSession: loadLocalSession ?? (async () => null),
    invalidateWorkspaceRestore: onInvalidate ?? (() => {}),
    handleNewActivitySession() {},
    handleSessionDeleted: onDeleted ?? (() => {}),
    mutateRemoteSession: async () => true,
    handleCwdChange() {},
  };
}

async function mountWorktree(callbacks) {
  const restoreDom = installDom();
  const callbacksRef = { current: callbacks };
  const stateRef = { current: null };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(WorktreeHookHarness, { callbacksRef, stateRef }));
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

async function beginLocalOpen(stateRef, sessionId) {
  await React.act(async () => {
    stateRef.current.openWorktreeGraph("/repo", undefined, { id: sessionId, cwd: "/repo/.worktrees/task" });
    await tick();
  });
  await React.act(async () => {
    stateRef.current.handleWorktreeGraphOpenSession(sessionId, "/repo/.worktrees/task");
    await tick();
  });
}

test("local associated session selects once after graph close rerenders and replaces callbacks", async () => {
  const request = deferred();
  const selected = [];
  const callbacks = makeCallbacks({ loadLocalSession: () => request.promise, selected });
  const mounted = await mountWorktree(callbacks);
  try {
    await beginLocalOpen(mounted.stateRef, "local-session");
    // AppShell replaces the callback bundle on every render. The request stays
    // valid because its production guard is the request serial, not callback identity.
    mounted.callbacksRef.current = {
      ...callbacks,
      handleSelectSession: (session) => selected.push(session),
    };
    const session = { id: "local-session", cwd: "/repo/.worktrees/task" };
    request.resolve(session);
    await React.act(async () => {
      await request.promise;
      await tick();
    });
    assert.deepEqual(selected, [session]);
  } finally {
    await unmountWorktree(mounted);
  }
});

test("local associated session reports load failures and missing sessions", async () => {
  for (const [sessionId, loadLocalSession, expected] of [
    ["failed-session", async () => { throw new Error("load failed"); }, "load failed"],
    ["missing-session", async () => null, "Session missing-session not found"],
  ]) {
    const selected = [];
    const callbacks = makeCallbacks({ loadLocalSession, selected });
    const mounted = await mountWorktree(callbacks);
    const alerts = [];
    window.alert = (message) => alerts.push(message);
    try {
      await beginLocalOpen(mounted.stateRef, sessionId);
      await React.act(async () => { await tick(); });
      assert.equal(selected.length, 0);
      assert.deepEqual(alerts, [expected]);
    } finally {
      await unmountWorktree(mounted);
    }
  }
});

test("newer graph requests and explicit navigation/deletion cancellation suppress stale success and errors", async () => {
  const first = deferred();
  const second = deferred();
  const selected = [];
  const alerts = [];
  const callbacks = makeCallbacks({
    loadLocalSession: (sessionId) => sessionId === "first" ? first.promise : second.promise,
    selected,
  });
  const mounted = await mountWorktree(callbacks);
  window.alert = (message) => alerts.push(message);
  try {
    await beginLocalOpen(mounted.stateRef, "first");
    await React.act(async () => {
      mounted.stateRef.current.openWorktreeGraph("/repo", undefined, { id: "second", cwd: "/repo/.worktrees/task" });
      await tick();
    });
    await React.act(async () => {
      mounted.stateRef.current.handleWorktreeGraphOpenSession("second", "/repo/.worktrees/task");
      await tick();
    });
    first.resolve({ id: "first" });
    second.resolve({ id: "second" });
    await React.act(async () => {
      await Promise.all([first.promise, second.promise]);
      await tick();
    });
    assert.deepEqual(selected, [{ id: "second" }]);
    assert.deepEqual(alerts, []);

    const cancelled = deferred();
    const cancelCallbacks = makeCallbacks({ loadLocalSession: () => cancelled.promise, selected });
    mounted.callbacksRef.current = cancelCallbacks;
    await beginLocalOpen(mounted.stateRef, "cancelled");
    mounted.stateRef.current.cancelWorktreeGraphOpen();
    cancelled.reject(new Error("stale failure"));
    await React.act(async () => {
      await cancelled.promise.catch(() => {});
      await tick();
    });
    assert.deepEqual(alerts, []);

    const navigated = deferred();
    mounted.callbacksRef.current = makeCallbacks({
      loadLocalSession: () => navigated.promise,
      selected,
      // Deliberately does NOT cancel here: the real wiring is asserted below,
      // so this test cannot pass by re-implementing the cancellation itself.
    });
    await beginLocalOpen(mounted.stateRef, "navigated");
    mounted.stateRef.current.cancelWorktreeGraphOpen();
    navigated.resolve({ id: "navigated" });
    await React.act(async () => {
      await navigated.promise;
      await tick();
    });
    assert.deepEqual(selected, [{ id: "second" }]);

    const deleted = deferred();
    mounted.callbacksRef.current = makeCallbacks({
      loadLocalSession: () => deleted.promise,
      selected,
    });
    await beginLocalOpen(mounted.stateRef, "deleted");
    mounted.stateRef.current.cancelWorktreeGraphOpen();
    deleted.reject(new Error("deleted failure"));
    await React.act(async () => {
      await deleted.promise.catch(() => {});
      await tick();
    });
    assert.deepEqual(selected, [{ id: "second" }]);
    assert.deepEqual(alerts, []);
  } finally {
    await unmountWorktree(mounted);
  }
});

test("remote associated sessions keep the remote open path", async () => {
  const selected = [];
  const remoteOpened = [];
  const callbacks = makeCallbacks({ selected, remoteOpened, loadLocalSession: async () => { throw new Error("local path used"); } });
  const mounted = await mountWorktree(callbacks);
  try {
    await React.act(async () => {
      mounted.stateRef.current.openWorktreeGraph("/remote/repo", { id: "remote-device", name: "Remote" }, { id: "remote-session", cwd: "/remote/repo/task" });
      await tick();
    });
    await React.act(async () => {
      mounted.stateRef.current.handleWorktreeGraphOpenSession("remote-session", "/remote/repo/task");
      await tick();
    });
    assert.equal(remoteOpened.length, 1);
    assert.deepEqual(remoteOpened[0].slice(0, 3), [{ id: "remote-device", name: "Remote" }, "remote-session", null]);
    assert.deepEqual(selected, []);
  } finally {
    await unmountWorktree(mounted);
  }
});

test("AppShell navigation and deletion invalidate in-flight graph opens in production wiring", () => {
  const restore = appShell.slice(
    appShell.indexOf("const invalidateWorkspaceRestore = useCallback"),
    appShell.indexOf("const clearEmbeddedReaderOwner"),
  );
  assert.ok(restore.length > 0, "invalidateWorkspaceRestore must exist");
  assert.match(restore, /cancelWorktreeGraphOpen\?\.\(\)/);
  assert.match(restore, /\[cancelWorktreeGraphOpen, invalidateEmbeddedSessionRequest\]|\[cancelWorktreeGraphOpen/, "cancelWorktreeGraphOpen must be a dependency");

  const deletion = appShell.slice(
    appShell.indexOf("const handleSessionDeleted = useCallback"),
    appShell.indexOf("const handleOpenFile"),
  );
  assert.ok(deletion.length > 0, "handleSessionDeleted must exist");
  assert.match(deletion, /invalidateWorkspaceRestore\(\)/, "deleting a session must reuse the navigating invalidation");
});
