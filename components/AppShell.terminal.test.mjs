import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { newTerminalTab, restoreTerminalTabs } from "./terminal-tab-state.ts";
import { terminalApiPath, terminalEventPath } from "../lib/terminal-client.ts";

test("restored workspace tabs retain terminal identity and never request a new shell", () => {
  const first = newTerminalTab("/repo/worktree-a");
  const second = newTerminalTab("/repo/worktree-b");
  assert.notEqual(first.id, second.id);
  const saved = restoreTerminalTabs(JSON.stringify({ tabs: [first, second], activeId: second.id, open: true }));
  assert.deepEqual(saved, {
    tabs: [{ ...first, restored: true }, { ...second, restored: true }],
    activeId: second.id,
    open: true,
  });
});

test("storage corruption cannot create invalid or duplicate terminal tabs", () => {
  assert.deepEqual(restoreTerminalTabs("broken"), { tabs: [], activeId: null, open: false });
  assert.deepEqual(restoreTerminalTabs(null), { tabs: [], activeId: null, open: false });
  const tab = newTerminalTab("/repo");
  const saved = restoreTerminalTabs(JSON.stringify({
    tabs: [null, {}, tab, tab, { ...tab, id: "../../bad" }, { ...tab, cwd: null }],
    activeId: "missing",
  }));
  assert.deepEqual(saved, { tabs: [{ ...tab, restored: true }], activeId: null, open: false });
});

test("terminal tabs retain peer identity and do not deduplicate different devices", () => {
  const first = newTerminalTab("/repo", "device-a");
  const second = newTerminalTab("/repo", "device-b");
  const saved = restoreTerminalTabs(JSON.stringify({ tabs: [first, second], activeId: second.id, open: true }));
  assert.deepEqual(saved.tabs.map((tab) => tab.peer), ["device-a", "device-b"]);
  assert.equal(saved.activeId, second.id);
});

test("remote terminal requests preserve the selected peer for shell, events, and input", () => {
  assert.equal(terminalApiPath("/api/terminal", "debian"), "/api/remote/terminal?peer=debian");
  assert.equal(terminalApiPath("/api/terminal/id", "debian"), "/api/remote/terminal/id?peer=debian");
  assert.equal(terminalEventPath("id", "debian", 12), "/api/remote/terminal/id/events?after=12&peer=debian");
});

test("AppShell opens manual terminals from the preserved mainline context and keeps terminal panels mounted", async () => {
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(source, /data-terminal-open="true"/);
  assert.doesNotMatch(source, /onOpenTerminal=/);
  assert.match(source, /const context = manualFileContext \?\? activityExplorerContext/);
  assert.match(source, /handleOpenTerminal\(context\.cwd, context\.deviceId/);
  assert.match(source, /tabs=\{panelTabs\}/);
  assert.match(source, /terminalTabs\.map\(\(tab\) =>/);
  assert.match(source, /<TerminalPanel/);
});
