import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./TalkMapOverlay.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("Talk Map exposes direct add and separate relation management", () => {
  const toolbarStart = source.indexOf('className="talk-map-toolbar-actions"');
  const relationsStart = source.indexOf("data-talk-map-relations-toggle", toolbarStart);
  const addStart = source.lastIndexOf("data-talk-map-add-edge", relationsStart);
  const lockStart = source.indexOf("data-talk-map-lock", relationsStart);
  const panelStart = source.indexOf('id="talk-map-relations"');
  assert.ok(addStart >= 0 && relationsStart > addStart && lockStart > relationsStart && panelStart > lockStart);
  const addAction = source.slice(source.lastIndexOf("<button", addStart), relationsStart);
  assert.match(addAction, /onClick=\{edgeMode \? cancelEdgeMode : startEdgeMode\}/);
  assert.match(addAction, /aria-pressed=\{edgeMode\}/);
  assert.match(addAction, /talkMap\.addEdge/);
  assert.match(addAction, /talkMap\.cancelEdge/);
  assert.doesNotMatch(source.slice(panelStart), /data-talk-map-add-edge/);
  assert.doesNotMatch(source.slice(panelStart), /data-talk-map-cancel-edge/);
  assert.match(source, /target\.closest\("\[data-talk-map-relations\], \[data-talk-map-relations-toggle\], \[data-talk-map-add-edge\], \[data-talk-map-edge\]"\)/);
  assert.match(source.slice(panelStart), /data-talk-map-relations-close/);
  assert.match(source.slice(panelStart), /top: "calc\(100% \+ 8px\)"/);
  assert.doesNotMatch(styles, /\.talk-map-relations-panel\s*\{[^}]*top:/s);
});

test("Talk Map relation geometry accounts for fixed subproject panels", () => {
  assert.match(source, /talkMapSubprojectPointInRect/);
  assert.match(source, /talkMapSubprojectContentYForClient/);
  assert.match(source, /subprojectPanelRefs/);
  assert.match(source, /subprojectScrollRefs/);
});

test("Talk Map relation lifecycle gives selection, save, success, and failure an exit", () => {
  const startStart = source.indexOf("const startEdgeMode = useCallback");
  const startEnd = source.indexOf("const closeRelationPanel", startStart);
  assert.ok(startStart >= 0 && startEnd > startStart);
  assert.match(source.slice(startStart, startEnd), /setRelationPanelOpen\(true\);/);
  assert.match(source, /const cancelEdgeMode = useCallback/);
  assert.match(source, /const closeRelationPanel = useCallback/);
  assert.match(source, /if \(edgeSaving\) return;/);
  assert.match(source, /const savedBoard = await persistMutation\(\{ op: "upsert-edge"/);
  assert.match(source, /if \(!savedBoard\) \{[\s\S]*?setEdgeSource\(source\);/);
  assert.match(source, /setEdgeMode\(false\);[\s\S]*?setSelectedEdgeId\(savedEdge\?\.id/);
  assert.match(source, /setRelationNotice\(t\(duplicate \? "talkMap\.relationExists" : "talkMap\.relationAdded"\)\)/);
  assert.match(source, /const savedBoard = await persistMutation\(\{ op: "delete-edge"/);
  assert.match(source, /setRelationNotice\(t\("talkMap\.relationDeleted"\)\)/);
});

test("Talk Map relation list remains usable after filters and selection", () => {
  assert.match(source, /const sessionById = useMemo/);
  assert.match(source, /if \(!needle\) return relationEdges;/);
  assert.match(source, /sourceSession \? sessionTitle\(sourceSession\)/);
  assert.match(source, /data-talk-map-relation-row disabled=\{edgeMode \|\| edgeSaving\}/);
  assert.match(source, /aria-pressed=\{selected\}/);
  const rowStart = source.indexOf("data-talk-map-relation-row");
  const rowEnd = source.indexOf("</button>", rowStart);
  assert.ok(rowStart >= 0 && rowEnd > rowStart);
  assert.doesNotMatch(source.slice(rowStart, rowEnd), /setRelationPanelOpen\(false\)/);
  assert.match(source, /if \(!edgeMode && !edgeSaving\) \{ setSelectedEdgeId\(edge\.id\);[\s\S]*?setRelationPanelOpen\(true\)/);
});

test("Talk Map Escape closes the narrowest relation state first", () => {
  const escapeStart = source.indexOf('if (event.key !== "Escape") return;');
  const escapeEnd = source.indexOf('window.addEventListener("keydown"', escapeStart);
  const handler = source.slice(escapeStart, escapeEnd);
  assert.ok(escapeStart >= 0 && escapeEnd > escapeStart);
  assert.match(handler, /if \(edgeMode\) \{[\s\S]*?cancelEdgeMode\(\);/);
  assert.match(handler, /if \(relationPanelOpen\) \{[\s\S]*?closeRelationPanel\(\);/);
  assert.ok(handler.indexOf("cancelEdgeMode()") < handler.indexOf("closeRelationPanel()"));
  assert.ok(handler.indexOf("closeRelationPanel()") < handler.indexOf("onClose()"));
});
