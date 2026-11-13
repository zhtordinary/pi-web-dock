import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import test from "node:test";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false, jsx: { runtime: "automatic" }, tsconfigPaths: true });
const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const sidekickSource = await readFile(new URL("./app-shell-sidekick.tsx", import.meta.url), "utf8");
const { useAppShellSidekick, useAppShellSidekickLifecycle, buildSidekickButtonLabel, SidekickMessageIcon, AppShellSidekickRightPanel } = await jiti.import("./app-shell-sidekick.tsx");
const { EMBEDDED_SIDEKICK_DISMISS_EVENT } = await jiti.import("../lib/embedded-modal.ts");

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

function SidekickHarness({ stateRef, sessionIdentity, fileTabs, terminalTabs, initialActiveTabId, initialRightPanelOpen }) {
  const [activeFileTabId, setActiveFileTabId] = React.useState(initialActiveTabId);
  const [rightPanelOpen, setRightPanelOpen] = React.useState(initialRightPanelOpen);
  const state = useAppShellSidekick({
    sessionIdentity,
    activeFileTabId,
    fileTabs,
    terminalTabs,
    rightPanelOpen,
    setActiveFileTabId,
    setRightPanelOpen,
  });
  useAppShellSidekickLifecycle({ sessionId: sessionIdentity, sessionActive: true, onToggle: state.toggleSidekick });
  stateRef.current = { ...state, activeFileTabId, rightPanelOpen, fileTabs, terminalTabs };
  return null;
}

async function mountSidekick({ sessionIdentity = "local:a", fileTabs = [], terminalTabs = [], activeFileTabId = "sidekick", rightPanelOpen = true, iframeParent = false } = {}) {
  const restoreDom = installDom();
  if (iframeParent) Object.defineProperty(window, "parent", { configurable: true, value: { name: "parent-window" } });
  const stateRef = { current: null };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (props = {}) => React.createElement(SidekickHarness, {
    stateRef,
    sessionIdentity,
    fileTabs,
    terminalTabs,
    initialActiveTabId: activeFileTabId,
    initialRightPanelOpen: rightPanelOpen,
    ...props,
  });
  await React.act(async () => {
    root.render(render());
    await tick();
  });
  return {
    root,
    stateRef,
    rerender: async (props) => React.act(async () => {
      root.render(render(props));
      await tick();
    }),
    restoreDom,
  };
}

async function unmountSidekick(mounted) {
  await React.act(async () => {
    mounted.root.unmount();
    await tick();
  });
  mounted.restoreDom();
}

function snapshot(stateRef) {
  const state = stateRef.current;
  return {
    activeFileTabId: state.activeFileTabId,
    rightPanelOpen: state.rightPanelOpen,
    sidekickOpen: state.sidekickOpen,
    sidekickRightPanelOpen: state.sidekickRightPanelOpen,
    sidekickCount: state.sidekickCount,
    selectionToolbar: state.selectionToolbar,
    fileTabs: state.fileTabs,
    terminalTabs: state.terminalTabs,
  };
}

test("Sidekick state belongs to its module, while AppShell keeps workspace wiring", () => {
  assert.match(sidekickSource, /const \[sidekickOpen, setSidekickOpen\] = useState\(false\)/);
  assert.match(sidekickSource, /const \[sidekickCount, setSidekickCount\] = useState\(0\)/);
  assert.match(sidekickSource, /const \[sidekickRightPanelOpen, setSidekickRightPanelOpen\] = useState\(false\)/);
  assert.match(sidekickSource, /sessionIdentity/);
  assert.match(sidekickSource, /setSidekickCount\(0\)/);
  assert.doesNotMatch(source, /const \[sidekickOpen/);
  assert.doesNotMatch(source, /const \[sidekickCount/);
  assert.doesNotMatch(source, /const \[sidekickRightPanelOpen/);
  assert.doesNotMatch(source, /setSidekickOpen\(/);
  assert.doesNotMatch(source, /setSidekickCount\(0\)/);
  assert.match(source, /useAppShellSidekick\(/);
});

test("drawer toggle falls back only to existing workspace tabs and preserves tab arrays", async () => {
  for (const [fileTabs, terminalTabs, expected] of [
    [[{ id: "file" }], [{ id: "terminal" }], "file"],
    [[], [{ id: "terminal" }, { id: "closing", closing: "close" }], "terminal"],
    [[], [], null],
    [[], [{ id: "closing", closing: "close" }], null],
  ]) {
    const mounted = await mountSidekick({ fileTabs, terminalTabs });
    try {
      await React.act(async () => {
        mounted.stateRef.current.toggleSidekick();
        await tick();
      });
      const result = snapshot(mounted.stateRef);
      assert.equal(result.activeFileTabId, expected);
      assert.equal(result.sidekickRightPanelOpen, false);
      assert.equal(result.sidekickOpen, true);
      assert.deepEqual(result.fileTabs, fileTabs);
      assert.deepEqual(result.terminalTabs, terminalTabs);
    } finally {
      await unmountSidekick(mounted);
    }
  }
});

test("drawer toggle preserves a different active workspace tab", async () => {
  const mounted = await mountSidekick({ fileTabs: [{ id: "file" }], terminalTabs: [{ id: "terminal" }], activeFileTabId: "file" });
  try {
    await React.act(async () => {
      mounted.stateRef.current.toggleSidekick();
      await tick();
    });
    assert.equal(mounted.stateRef.current.activeFileTabId, "file");
  } finally {
    await unmountSidekick(mounted);
  }
});

test("right-panel toggle selects Sidekick, reopens hidden panels, and falls back on close", async () => {
  const mounted = await mountSidekick({ fileTabs: [{ id: "file" }], activeFileTabId: "file", rightPanelOpen: false });
  try {
    await React.act(async () => {
      mounted.stateRef.current.toggleSidekickRightPanel();
      await tick();
    });
    assert.equal(mounted.stateRef.current.activeFileTabId, "sidekick");
    assert.equal(mounted.stateRef.current.rightPanelOpen, true);
    assert.equal(mounted.stateRef.current.sidekickRightPanelOpen, true);
    await React.act(async () => {
      mounted.stateRef.current.toggleSidekickRightPanel();
      await tick();
    });
    assert.equal(mounted.stateRef.current.activeFileTabId, "file");
    assert.equal(mounted.stateRef.current.sidekickRightPanelOpen, false);
    assert.equal(mounted.stateRef.current.rightPanelOpen, true);
  } finally {
    await unmountSidekick(mounted);
  }
});

test("session identity resets Sidekick count, selection actions, and active tab without dropping files or terminals", async () => {
  const mounted = await mountSidekick({ fileTabs: [{ id: "file" }], terminalTabs: [{ id: "terminal" }], activeFileTabId: "file" });
  try {
    await React.act(async () => {
      mounted.stateRef.current.toggleSidekickRightPanel();
      mounted.stateRef.current.setSidekickCount(3);
      mounted.stateRef.current.handleSelectionToolbarChange({ askCurrent() {}, askSidekick() {}, dismiss() {} });
      await tick();
    });
    assert.equal(mounted.stateRef.current.sidekickCount, 3);
    await mounted.rerender({ sessionIdentity: "remote:device-b" });
    const result = snapshot(mounted.stateRef);
    assert.equal(result.sidekickOpen, false);
    assert.equal(result.sidekickRightPanelOpen, false);
    assert.equal(result.sidekickCount, 0);
    assert.equal(result.selectionToolbar, null);
    assert.equal(result.activeFileTabId, "file");
    assert.deepEqual(result.fileTabs, [{ id: "file" }]);
    assert.deepEqual(result.terminalTabs, [{ id: "terminal" }]);
  } finally {
    await unmountSidekick(mounted);
  }
});

test("docked Sidekick reserves the bottom safe area once", () => {
  assert.match(source, /id=\{SIDEKICK_RIGHT_PANEL_TARGET_ID\}[\s\S]*?paddingBottom: "env\(safe-area-inset-bottom\)"/);
  const markup = renderToStaticMarkup(React.createElement(AppShellSidekickRightPanel, { active: true },
    React.createElement("div", { style: { paddingBottom: "env(safe-area-inset-bottom)" } }),
  ));
  assert.equal((markup.match(/safe-area-inset-bottom/g) ?? []).length, 1);
});

test("parent dismiss leaves docked Sidekick and an unrelated empty panel open", async () => {
  for (const docked of [false, true]) {
    const mounted = await mountSidekick({ activeFileTabId: null, rightPanelOpen: true, iframeParent: true });
    try {
      if (docked) {
        await React.act(async () => { mounted.stateRef.current.toggleSidekickRightPanel(); await tick(); });
      }
      const before = snapshot(mounted.stateRef);
      await React.act(async () => {
        window.dispatchEvent(new window.MessageEvent("message", {
          source: window.parent,
          data: { type: EMBEDDED_SIDEKICK_DISMISS_EVENT },
        }));
        await tick();
      });
      assert.equal(mounted.stateRef.current.rightPanelOpen, true, "a parent click must not close the workspace panel");
      assert.equal(mounted.stateRef.current.sidekickRightPanelOpen, before.sidekickRightPanelOpen);
      assert.equal(mounted.stateRef.current.activeFileTabId, before.activeFileTabId);
    } finally {
      await unmountSidekick(mounted);
    }
  }
});

test("closing the lone Sidekick surface closes only the empty panel", async () => {
  const mounted = await mountSidekick();
  try {
    await React.act(async () => {
      mounted.stateRef.current.closeSidekickRightPanel();
      await tick();
    });
    assert.equal(mounted.stateRef.current.activeFileTabId, null);
    assert.equal(mounted.stateRef.current.rightPanelOpen, false);
    assert.equal(mounted.stateRef.current.sidekickRightPanelOpen, false);
  } finally {
    await unmountSidekick(mounted);
  }
});

test("Sidekick tabs use the existing panel and preserve embedded remote file routing", async () => {
  const tabBar = await readFile(new URL("./TabBar.tsx", import.meta.url), "utf8");
  assert.match(sidekickSource, /isSidekickTabActive: sidekickRightPanelOpen && activeFileTabId === SIDEKICK_TAB_ID/);
  assert.match(source, /display: isSidekickTabActive \? "flex" : "none"/);
  assert.match(source, /display: isSidekickTabActive \? "none" : "block"/);
  assert.match(tabBar, /kind\?: "file" \| "terminal" \| "sidekick"/);
  assert.match(tabBar, /tab\.kind === "sidekick"/);
  assert.match(source, /<SlashCommandDetailsSurface[\s\S]*remotePeer=\{embeddedSessionKey\?\.split\(":"\)\[0\] \?\? embeddedDeviceId \?\? embeddedResourceSession\?\.deviceId\}/);
});

test("AppShell leaves parent dismissal to the drawer and preserves workspace fallback wiring", () => {
  assert.doesNotMatch(source, /onDismiss: dismissSidekick/);
  assert.match(source, /handleSelectFileTab[\s\S]*closeSidekickRightPanel\(\)/);
  assert.match(source, /if \(tabId === SIDEKICK_TAB_ID\) \{[\s\S]*closeSidekickTab\(\)/);
  assert.match(source, /sidekickRightPanelOpen \? SIDEKICK_TAB_ID/);
});

function LifecycleHarness({ sessionId, sessionActive, onToggle, onDismiss }) {
  useAppShellSidekickLifecycle({ sessionId, sessionActive, onToggle, onDismiss });
  return null;
}

async function mountLifecycle(props) {
  const restoreDom = installDom();
  const parentSource = { name: "parent-window" };
  Object.defineProperty(window, "parent", { configurable: true, value: props.iframeParent ? parentSource : window });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (next = {}) => React.createElement(LifecycleHarness, { ...props, ...next });
  await React.act(async () => {
    root.render(render());
    await tick();
  });
  return {
    parentSource: window.parent,
    rerender: async (next) => React.act(async () => {
      root.render(render(next));
      await tick();
    }),
    unmount: async () => {
      await React.act(async () => {
        root.unmount();
        await tick();
      });
      restoreDom();
    },
  };
}

function keydown(win, init) {
  win.document.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

test("shell lifecycle drives Cmd and Ctrl+J only while the session is active and cleans the listener", async () => {
  let toggles = 0;
  const mounted = await mountLifecycle({ sessionId: "local:a", sessionActive: true, onToggle: () => { toggles += 1; } });
  const win = window;
  try {
    keydown(win, { key: "j", metaKey: true });
    keydown(win, { key: "J", ctrlKey: true });
    keydown(win, { key: "k", metaKey: true });
    keydown(win, { key: "j" });
    assert.equal(toggles, 2, "only Cmd+J and Ctrl+J toggle the drawer");
    await mounted.rerender({ sessionActive: false });
    keydown(win, { key: "j", metaKey: true });
    assert.equal(toggles, 2, "an inactive session must not toggle");
    await mounted.rerender({ sessionActive: true });
    keydown(win, { key: "j", metaKey: true });
    assert.equal(toggles, 3, "reactivating returns the shortcut");
    await mounted.unmount();
    keydown(win, { key: "j", metaKey: true });
    assert.equal(toggles, 3, "unmount removes the keydown listener");
  } finally {
    try { await mounted.unmount(); } catch {}
  }
});

test("shell lifecycle does not independently dismiss on parent messages", async () => {
  let dismissals = 0;
  const mounted = await mountLifecycle({ sessionId: "local:a", sessionActive: true, iframeParent: true, onToggle: () => {}, onDismiss: () => { dismissals += 1; } });
  const win = window;
  const emit = (source, type) => win.dispatchEvent(new win.MessageEvent("message", { data: { type }, source }));
  try {
    emit(win, EMBEDDED_SIDEKICK_DISMISS_EVENT);
    assert.equal(dismissals, 0, "a same-window message is not from the parent");
    emit({ name: "other-parent" }, EMBEDDED_SIDEKICK_DISMISS_EVENT);
    assert.equal(dismissals, 0, "another window is not this page's parent");
    emit(mounted.parentSource, "pi-web:other-event");
    assert.equal(dismissals, 0, "a non-matching type is ignored");
    emit(mounted.parentSource, EMBEDDED_SIDEKICK_DISMISS_EVENT);
    assert.equal(dismissals, 0, "the drawer alone handles parent dismissal");
    await mounted.unmount();
    emit(mounted.parentSource, EMBEDDED_SIDEKICK_DISMISS_EVENT);
    assert.equal(dismissals, 0, "unmount leaves no shell message listener");
  } finally {
    try { await mounted.unmount(); } catch {}
  }
});

test("Sidekick count drives the top-bar label and the icon fill", async () => {
  const translate = (key) => (key === "sidekick.title" ? "Sidekick" : key);
  assert.equal(buildSidekickButtonLabel(0, translate), "Sidekick");
  assert.equal(buildSidekickButtonLabel(3, translate), "Sidekick (3)");

  const restoreDom = installDom();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (count) => React.createElement(SidekickMessageIcon, { count });
  try {
    await React.act(async () => { root.render(render(0)); await tick(); });
    const emptyIcon = container.querySelector("svg");
    assert.ok(emptyIcon, "the Sidekick icon must render");
    assert.equal(emptyIcon.getAttribute("fill"), "none");

    await React.act(async () => { root.render(render(4)); await tick(); });
    const filledIcon = container.querySelector("svg");
    assert.match(filledIcon.getAttribute("fill"), /var\(--accent\)/, "a non-empty Sidekick fills the icon");
    assert.equal(filledIcon.getAttribute("aria-hidden"), "true");
  } finally {
    await React.act(async () => { root.unmount(); await tick(); });
    restoreDom();
  }
});

test("each session identity transition resets Sidekick and keeps workspace tabs", async () => {
  for (const [from, to] of [
    ["local:a", "local:b"],
    ["local:a", "remote:device-b:session-x"],
    ["remote:device-b:session-x", "remote:device-c:session-y"],
  ]) {
    const mounted = await mountSidekick({ sessionIdentity: from, fileTabs: [{ id: "file" }], terminalTabs: [{ id: "terminal" }], activeFileTabId: "file" });
    try {
      await React.act(async () => {
        mounted.stateRef.current.toggleSidekickRightPanel();
        mounted.stateRef.current.toggleSidekick();
        mounted.stateRef.current.setSidekickCount(2);
        mounted.stateRef.current.handleSelectionToolbarChange({ askCurrent() {}, askSidekick() {}, dismiss() {} });
        await tick();
      });
      assert.equal(mounted.stateRef.current.sidekickCount, 2);
      await mounted.rerender({ sessionIdentity: to });
      const result = snapshot(mounted.stateRef);
      assert.equal(result.sidekickOpen, false, `${from} -> ${to} closes the drawer`);
      assert.equal(result.sidekickRightPanelOpen, false, `${from} -> ${to} closes the Sidekick panel`);
      assert.equal(result.sidekickCount, 0, `${from} -> ${to} clears the count`);
      assert.equal(result.selectionToolbar, null, `${from} -> ${to} drops stale selection actions`);
      assert.equal(result.activeFileTabId, "file");
      assert.deepEqual(result.fileTabs, [{ id: "file" }]);
      assert.deepEqual(result.terminalTabs, [{ id: "terminal" }]);
    } finally {
      await unmountSidekick(mounted);
    }
  }
});
