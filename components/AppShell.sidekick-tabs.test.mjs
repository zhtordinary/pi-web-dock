import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

function callback(name, nextName) {
  const start = source.indexOf(`  const ${name} = useCallback(`);
  const end = source.indexOf(`  const ${nextName}`, start);
  assert.ok(start >= 0 && end > start, `${name} callback is present`);
  return source.slice(start, end).replace("tabId: string", "tabId");
}

function panel(initial = {}) {
  const state = {
    fileTabs: [], terminalTabs: [], activeFileTabId: "sidekick",
    sidekickRightPanelOpen: true, sidekickOpen: false, rightPanelOpen: true,
    ...initial,
  };
  const context = { ...state, SIDEKICK_TAB_ID: "sidekick", useCallback: (fn) => fn,
    confirmDiscardFileChanges: () => true, setSidekickCount() {}, setSelectionToolbar() {},
  };
  for (const key of Object.keys(state)) {
    const setter = `set${key[0].toUpperCase()}${key.slice(1)}`;
    context[setter] = (value) => { context[key] = typeof value === "function" ? value(context[key]) : value; };
  }
  context.layoutClears = 0;
  context.clearFileTabsLayout = () => { context.layoutClears += 1; context.rightPanelOpen = false; };
  const resetEffect = source.match(/useEffect\(\(\) => \{\s*setSidekickOpen\(false\);[\s\S]*?\}, \[remoteSession\?\.device\.id, remoteSession\?\.sessionInfo\?\.id, selectedSession\?\.id\]\);/)?.[0];
  assert.ok(resetEffect, "session identity change resets Sidekick");
  const handlers = runInNewContext([
    callback("handleCloseFileTab", "handleCloseAllFileTabs"),
    callback("toggleSidekick", "toggleSidekickRightPanel"),
    callback("toggleSidekickRightPanel", "closeSidekickRightPanel"),
    callback("closeSidekickRightPanel", "[selectionToolbar"),
    `const resetSession = () => { ${resetEffect.replace("useEffect(", "((fn) => fn())(").replace(/, \[remoteSession[\s\S]*$/, ");")} };`,
    "({ handleCloseFileTab, toggleSidekick, toggleSidekickRightPanel, closeSidekickRightPanel, resetSession })",
  ].join("\n"), context);
  return { handlers, layoutClears: () => context.layoutClears, snapshot: () => JSON.parse(JSON.stringify(Object.fromEntries(Object.keys(state).map((key) => [key, context[key]])))) };
}

for (const transition of ["toggleSidekick", "resetSession"]) {
  test(`${transition} removes the active Sidekick tab and falls back only to existing workspace tabs`, () => {
    for (const [fileTabs, terminalTabs, expected] of [
      [[{ id: "file" }], [{ id: "terminal" }], "file"],
      [[], [{ id: "terminal" }, { id: "closing", closing: "close" }], "terminal"],
      [[], [], null],
      [[], [{ id: "closing", closing: "close" }], null],
    ]) {
      const fixture = panel({ fileTabs, terminalTabs });
      fixture.handlers[transition]();
      const result = fixture.snapshot();
      assert.equal(result.activeFileTabId, expected);
      assert.equal(result.sidekickRightPanelOpen, false);
      assert.equal(result.sidekickOpen, transition === "toggleSidekick");
      assert.deepEqual(result.fileTabs, fileTabs);
      assert.deepEqual(result.terminalTabs, terminalTabs);
    }
  });

  test(`${transition} preserves a different active tab`, () => {
    for (const id of ["file", "terminal"]) {
      const fixture = panel({ fileTabs: [{ id: "file" }], terminalTabs: [{ id: "terminal" }], activeFileTabId: id });
      fixture.handlers[transition]();
      assert.equal(fixture.snapshot().activeFileTabId, id);
    }
  });
}

test("the right-panel toggle selects an existing inactive Sidekick tab and reopens a hidden panel", () => {
  const fixture = panel({ fileTabs: [{ id: "file" }], activeFileTabId: "file", rightPanelOpen: false });
  fixture.handlers.toggleSidekickRightPanel();
  assert.equal(fixture.snapshot().activeFileTabId, "sidekick");
  assert.equal(fixture.snapshot().rightPanelOpen, true);
  fixture.handlers.toggleSidekickRightPanel();
  assert.equal(fixture.snapshot().activeFileTabId, "file");
  assert.equal(fixture.snapshot().sidekickRightPanelOpen, false);
});

test("closing the last file or terminal retains the Sidekick tab", () => {
  for (const [fileTabs, terminalTabs, id] of [
    [[{ id: "file" }], [], "file"],
    [[], [{ id: "terminal" }], "terminal"],
  ]) {
    const fixture = panel({ fileTabs, terminalTabs, activeFileTabId: id });
    fixture.handlers.handleCloseFileTab(id);
    const result = fixture.snapshot();
    assert.equal(result.activeFileTabId, "sidekick");
    assert.equal(result.sidekickRightPanelOpen, true);
    assert.equal(result.rightPanelOpen, true);
  }
});

test("closing a lone Sidekick tab closes only the empty panel", () => {
  const fixture = panel();
  fixture.handlers.handleCloseFileTab("sidekick");
  assert.equal(fixture.snapshot().activeFileTabId, null);
  assert.equal(fixture.snapshot().rightPanelOpen, false);
  assert.equal(fixture.layoutClears(), 0, "explorer and reading layout are not reset");
});

test("the drawer close removes an inactive Sidekick tab instead of reselecting it", async () => {
  const fixture = panel({ fileTabs: [{ id: "file" }], activeFileTabId: "file" });
  fixture.handlers.closeSidekickRightPanel();
  const result = fixture.snapshot();
  assert.equal(result.sidekickRightPanelOpen, false);
  assert.equal(result.activeFileTabId, "file");
  assert.equal(result.rightPanelOpen, true);
  const idle = panel({ sidekickRightPanelOpen: false, fileTabs: [{ id: "file" }], activeFileTabId: "file" });
  idle.handlers.closeSidekickRightPanel();
  assert.deepEqual(idle.snapshot(), { ...result, sidekickRightPanelOpen: false });
  const chatWindow = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  assert.match(chatWindow, /if \(sidekickRightPanelIsOpen && onCloseSidekickRightPanel\) onCloseSidekickRightPanel\(\);/);
  assert.doesNotMatch(chatWindow, /onToggleSidekickRightPanel/);
});

test("Sidekick tabs use the existing panel and preserve embedded remote file routing", async () => {
  const tabBar = await readFile(new URL("./TabBar.tsx", import.meta.url), "utf8");
  assert.match(source, /const isSidekickTabActive = sidekickRightPanelOpen && activeFileTabId === SIDEKICK_TAB_ID/);
  assert.match(source, /display: isSidekickTabActive \? "flex" : "none"/);
  assert.match(source, /display: isSidekickTabActive \? "none" : "block"/);
  assert.match(tabBar, /kind\?: "file" \| "terminal" \| "sidekick"/);
  assert.match(tabBar, /tab\.kind === "sidekick"/);
  assert.match(source, /<SlashCommandDetailsSurface[\s\S]*remotePeer=\{embeddedSessionKey\?\.split\(":"\)\[0\] \?\? embeddedDeviceId \?\? embeddedResourceSession\?\.deviceId\}/);
});
