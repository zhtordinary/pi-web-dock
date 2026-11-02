import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionActivityPanel.tsx", import.meta.url), "utf8");

test("expanded activity recap gives task tree a circular task-flow heading", () => {
  assert.match(source, /data-session-task-flow/);
  assert.match(source, /sessionActivity\.taskFlow/);
  assert.match(source, /recapDisplay\.taskFlow\.length > 0 \? \(\s*<div data-session-task-flow>/);
  assert.match(source, /borderRadius: "50%"/);
});

test("activity filter triggers use the same readable font size in panel and sidebar", () => {
  assert.match(source, /const selectStyle: React\.CSSProperties = \{[\s\S]*fontSize: 11/);
  assert.match(source, /const sidebarSelectStyle: React\.CSSProperties = \{[\s\S]*fontSize: 11/);
  assert.equal((source.match(/optionFontSize=\{11\}/g) ?? []).length, 2);
});
