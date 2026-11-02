import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionActivityPanel.tsx", import.meta.url), "utf8");
const filters = await readFile(new URL("../lib/session-activity-filters.ts", import.meta.url), "utf8");

test("status-first session rows share selected display time", () => {
  assert.match(source, /return sessionActivityDisplayTime\(item, sort\);/);
  assert.match(filters, /sort === "asked" \|\| sort === "status"/);
  assert.match(source, /return itemTime\(b, "recent"\)\.localeCompare\(itemTime\(a, "recent"\)\);/);
  assert.match(source, /const timeLabel = state\.sort === "asked" \|\| state\.sort === "status"/);
  assert.match(source, /formatTime\(itemTime\(item, sort\)\)/);
});
