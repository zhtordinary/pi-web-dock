import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [meta, panel, map] = await Promise.all([
  readFile(new URL("./SessionActivityMeta.tsx", import.meta.url), "utf8"),
  readFile(new URL("./SessionActivityPanel.tsx", import.meta.url), "utf8"),
  readFile(new URL("./TalkMapOverlay.tsx", import.meta.url), "utf8"),
]);

test("uses compact metadata separator spacing", () => {
  assert.match(meta, /margin: "0 5px"/);
  assert.doesNotMatch(meta, /margin: "0 8px"/);
});

test("activity metadata shows partial cost as a lower bound, not unpriced", () => {
  assert.ok(meta.includes("costStatus === \"partial\""));
  assert.ok(meta.includes("`≥$${"));
  assert.ok(meta.includes("missingPriceModels.length > 0 && !partialCost"));
  assert.ok(panel.includes("costStatus === \"partial\""));
  assert.ok(panel.includes("`≥$${"));
  assert.ok(panel.includes("missingPriceModels.length > 0 && !partialCost"));
});

test("activity metadata exposes pending usage separately from missing prices", () => {
  assert.ok(meta.includes("pendingUsageCount"));
  assert.ok(panel.includes("pendingUsageCount"));
});

test("model placement prioritizes hover width and preserves Map time", () => {
  assert.match(meta, /type ModelPlacement = "replace-time" \| "after-time"/);
  assert.match(meta, /const modelName = modelPlacement \? item\.modelName\?\.trim\(\) : undefined/);
  assert.match(meta, /modelPlacement === "replace-time" && Boolean\(modelName\)/);
  assert.match(meta, /data-session-activity-model="replace-time"/);
  assert.match(meta, /modelPlacement === "after-time" && modelName/);
  assert.match(meta, /data-session-activity-model="after-time"/);
  assert.match(meta, /title=\{modelName\}/);
  assert.match(meta, /minWidth: 0, flexShrink: 1, overflow: "hidden", textOverflow: "ellipsis"/);
  assert.match(meta, /const nonModelFlexStyle: CSSProperties = modelPlacement \? \{ flexShrink: 0 \} : \{\}/);
  assert.equal((meta.match(/\.\.\.nonModelFlexStyle/g) ?? []).length, 5, "time and other textual metadata stay fixed in model layouts");
  assert.match(meta, /\{replaceTimeWithModel \? \([\s\S]*?data-session-activity-model="replace-time"[\s\S]*?\) : \([\s\S]*?<span title=\{timeValue\}/);
  const timeIndex = meta.indexOf("<span title={timeValue}");
  const mapModelIndex = meta.indexOf('data-session-activity-model="after-time"');
  assert.ok(timeIndex >= 0 && mapModelIndex > timeIndex, "Map model must follow the retained time");
});

test("Talk Map expands questions with the card and gives copy feedback", () => {
  assert.match(map, /expanded=\{recapExpanded\}/);
  assert.doesNotMatch(map, /data-talk-map-questions-expand/);
  assert.match(map, /data-talk-map-copy-session-info/);
  assert.match(map, /session\.copied/);
  assert.match(map, /transform: actionKey === `copy:\$\{session\.id\}`/);
});
