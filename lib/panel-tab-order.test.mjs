import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { orderPanelTabs, movePanelTab } = await jiti.import("./panel-tab-order.ts");
const ids = (tabs) => tabs.map((tab) => tab.id);

test("moves panel tabs before or after another tab without mutating the input", () => {
  const initial = ["file:a", "file:b", "terminal:1", "file:c"];
  assert.deepEqual(movePanelTab(initial, "file:c", "file:a", false), ["file:c", "file:a", "file:b", "terminal:1"]);
  assert.deepEqual(movePanelTab(initial, "file:a", "terminal:1", true), ["file:b", "terminal:1", "file:a", "file:c"]);
  assert.deepEqual(initial, ["file:a", "file:b", "terminal:1", "file:c"]);
  assert.equal(movePanelTab(initial, "file:a", "file:a", true), initial);
  assert.equal(movePanelTab(initial, "missing", "file:a", false), initial);
});

test("drops closed tabs and appends newly opened tabs", () => {
  const tabs = ["file:a", "terminal:1", "file:new"].map((id) => ({ id }));
  const order = ["file:closed", "terminal:1", "file:a"];
  assert.deepEqual(ids(orderPanelTabs(tabs, order)), ["terminal:1", "file:a", "file:new"]);
  assert.deepEqual(orderPanelTabs(tabs, []), tabs);
});
