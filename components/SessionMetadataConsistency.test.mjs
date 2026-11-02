import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (name) => readFile(new URL(name, root), "utf8");

test("Talk Map and hover preview reuse session metadata projections", async () => {
  const [map, hover, sidebar, activityPanel, activityMeta] = await Promise.all([
    read("components/TalkMapOverlay.tsx"),
    read("components/SessionHoverPreview.tsx"),
    read("components/SessionSidebar.tsx"),
    read("components/SessionActivityPanel.tsx"),
    read("components/SessionActivityMeta.tsx"),
  ]);

  assert.match(map, /<SessionActivityMeta item=\{activity\} sort=\{sharedFilters\.sort\}/);
  assert.match(map, /<SessionActivityMeta item=\{activity\} sort=\{sharedFilters\.sort\} modelPlacement="after-time"/);
  assert.match(hover, /<SessionActivityMeta item=\{activityItem\}[\s\S]*?modelPlacement="replace-time"/);
  assert.match(hover, /querySelector<HTMLElement>\("\.activity-session-meta"\)/);
  assert.match(hover, /<SessionActivityMeta item=\{activityItem\}/);
  assert.match(sidebar, /<SessionListMeta session=\{session\} isRunning=\{isRunning\} isUnread=\{isUnread\}/);
  assert.match(activityPanel, /className="activity-session-meta"/);
  for (const field of ["item.status", "sessionActivityDisplayTime(item, sort)", "costText", "unpricedText", "cacheHitText", "contextLabel"]) {
    assert.match(activityMeta, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `shared activity metadata missing ${field}`);
  }
});

test("Talk Map keeps status sort after other sort choices", async () => {
  const map = await read("components/TalkMapOverlay.tsx");
  const options = map.split("\\n").find((line) => line.includes("talkMap.sortStatus")) ?? "";
  assert.ok(options.indexOf('value: "asked"') < options.indexOf('value: "manual"'));
  assert.ok(options.indexOf('value: "manual"') < options.indexOf('value: "status"'));
});
