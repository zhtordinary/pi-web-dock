import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./TalkMapOverlay.tsx", import.meta.url), "utf8");

test("Talk Map footer stays close to card content without losing actions or metadata", () => {
  const footerStart = source.indexOf("data-talk-map-card-footer");
  const footerEnd = source.indexOf("const subprojectClientCenter", footerStart);
  assert.ok(footerStart >= 0 && footerEnd > footerStart, "Talk Map card footer section must exist");
  const footer = source.slice(footerStart, footerEnd);
  assert.match(footer, /style=\{\{ display: "flex"/);
  assert.match(footer, /marginTop: 4/);
  assert.doesNotMatch(footer, /marginTop: "auto"/);
  assert.match(footer, /data-talk-map-fork/);
  assert.match(footer, /data-talk-map-inject/);
  assert.match(footer, /data-talk-map-copy-session-info/);
  assert.match(footer, /session\.copied/);
  assert.match(footer, /data-talk-map-archive/);
  assert.match(footer, /data-talk-map-delete/);
  assert.match(footer, /<SessionSubprojectMenu/);
  assert.match(footer, /data-talk-map-card-meta/);
  assert.match(footer, /<SessionActivityMeta item=\{activity\}/);
  assert.match(footer, /<SessionListMeta session=\{session\}/);
});


test("Talk Map session-card title starts with the session-list status dot", () => {
  const renderStart = source.indexOf("const renderSessionCard =");
  const headerStart = source.indexOf('<div style={{ display: "flex", alignItems: "center", gap: 6 }}>', renderStart);
  const headerEnd = source.indexOf('<button type="button" data-talk-map-open-session', headerStart);
  assert.ok(renderStart >= 0 && headerStart > renderStart && headerEnd > headerStart, "session-card header must exist");
  const header = source.slice(headerStart, headerEnd);
  assert.match(header, /aria-hidden="true"[\s\S]*data-talk-map-card-status[\s\S]*width: 7,[\s\S]*height: 7,[\s\S]*borderRadius: "50%"[\s\S]*background: statusColor\(status\)/);
  assert.ok(header.indexOf("data-talk-map-card-status") < header.indexOf("<strong style="), "status dot must precede the card title");
});
