import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { pendingSideAskPromotions, queueSideAskPromotion } from "../lib/side-ask-promotion.ts";

const chatWindow = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const drawer = readFileSync(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");

function between(source, startMarker, endMarker) {
  const end = source.indexOf(endMarker);
  assert.ok(end >= 0, endMarker);
  const start = startMarker === null ? source.lastIndexOf("  useEffect(() => {", end) : source.indexOf(startMarker);
  assert.ok(start >= 0 && start < end, String(startMarker));
  return stripTypeScriptTypes(source.slice(start, end + endMarker.length));
}

const collapseEffect = between(chatWindow, null,
  "  }, [activeLeafId, activeSideTabId, latestLeafId, session?.id, settleSideAskPromotions, sideTabs]);");

function collapse(overrides = {}) {
  const log = [];
  const values = new Map();
  const localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } };
  const sideTabs = [{ tabId: "side-1", anchorLeafId: "L1" }, { tabId: "side-9", anchorLeafId: "L9" }];
  const context = {
    useEffect: (callback) => callback(), JSON, localStorage,
    session: { id: "s" }, activeSideTabId: "side-1", activeLeafId: "L2", latestLeafId: "L2", sideTabs,
    queueSideAskPromotion: (storage, sessionId, branchId) => { log.push(["queue", branchId]); queueSideAskPromotion(storage, sessionId, branchId); },
    settleSideAskPromotions: async () => { log.push(["settle", pendingSideAskPromotions(localStorage, "s")]); },
    setActiveSideTabId: (value) => { log.push(["active", value]); },
    setSideTabs: (update) => { log.push(["tabs", update(sideTabs).map((tab) => tab.tabId)]); },
    ...overrides,
  };
  vm.runInNewContext(collapseEffect, context);
  return { log, values };
}

test("a branch tab that becomes the newest line is queued for its move before it disappears", () => {
  const { log, values } = collapse();
  assert.deepEqual(log, [["active", "main"], ["queue", "side-1"], ["settle", ["side-1"]], ["tabs", ["side-9"]]]);
  assert.equal(values.get("pi-web:side-tabs:s"), JSON.stringify([{ tabId: "side-9", anchorLeafId: "L9" }]));
  assert.equal(values.get("pi-web:side-ask-promotions:s"), JSON.stringify(["side-1"]));
});

test("nothing moves while the tab is still on its own line", () => {
  for (const overrides of [
    { activeLeafId: "L1", latestLeafId: "L1" },
    { activeSideTabId: "main" },
    { latestLeafId: "L3" },
    { sideTabs: [] },
  ]) assert.deepEqual(collapse(overrides).log, [], JSON.stringify(overrides));
});

test("the drawer is told through one revision number and reads the history once per change", () => {
  assert.match(chatWindow, /historyRevision=\{sidekickHistoryRevision\}/);
  assert.match(chatWindow, /if \(moved > 0\) setSidekickHistoryRevision\(\(revision\) => revision \+ 1\)/);
  const effect = between(drawer, "  const seenHistoryRevisionRef = useRef(historyRevision);",
    "  }, [historyController, historyRevision, quickAskUrl, sessionId]);");
  const ref = { current: 0 }, log = [];
  const render = (historyRevision) => vm.runInNewContext(effect, {
    useRef: () => ref, useEffect: (callback) => callback(), historyRevision, sessionId: "s", quickAskUrl: "/q",
    historyController: { invalidate: (...args) => log.push(["invalidate", ...args]), load: async (...args) => { log.push(["load", ...args]); } },
  });
  render(0); render(0);
  assert.deepEqual(log, []);
  render(1); render(1);
  assert.deepEqual(log, [["invalidate", "s", "/q"], ["load", "s", "/q"]]);
  render(2);
  assert.equal(log.length, 4);
});
