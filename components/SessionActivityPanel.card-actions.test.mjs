import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const panelSource = await readFile(new URL("./SessionActivityPanel.tsx", import.meta.url), "utf8");
const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing section: ${startMarker}`);
  assert.ok(end > start, `missing section boundary: ${endMarker}`);
  return source.slice(start, end);
}

test("session cards expose the three top-bar actions in top-bar order", () => {
  const actions = section(panelSource, "function SessionCardQuickActions", "const sidebarSelectStyle");
  const labels = ["talkMap.locateSession", "talkMap.injectContext", "session.copySourceInfo"];
  const positions = labels.map((label) => actions.indexOf(label));
  assert.ok(positions.every((position) => position >= 0), "all card action labels are present");
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "card actions keep Map / inject / copy order");
  assert.match(actions, /data-session-card-actions=\{item\.session\.id\}/);
  assert.match(actions, /<MapIcon/);
  assert.match(actions, /<FileInput/);
  assert.match(actions, /<Copy/);
});

test("floating copy action shows feedback only after copy resolves", () => {
  const actions = section(panelSource, "function SessionCardQuickActions", "const sidebarSelectStyle");
  assert.match(actions, /const \[copied, setCopied\] = useState\(false\)/);
  assert.match(actions, /await onCopySessionInfo\(item\)/);
  assert.match(actions, /t\("session\.copied"\)/);
  assert.match(actions, /opacity: copied \? 0 : 1/);
  assert.match(actions, /opacity: copied \? 1 : 0/);

});

test("activity rows put card actions behind More controls while hover previews keep their footer", () => {
  assert.match(panelSource, /onOpenTalkMapForSession\?: SessionActivityCardAction/);
  assert.match(panelSource, /onInjectContext\?: SessionActivityCardAction/);
  assert.match(panelSource, /onCopySessionInfo\?: SessionActivityCardAction/);
  const activityRow = section(panelSource, "function SessionActivityRow(", "function SessionActivitySidebarRow(");
  const sidebarRow = section(panelSource, "function SessionActivitySidebarRow(", "function SessionRowExtraActions");
  const extraActions = section(panelSource, "function SessionRowExtraActions", "function SessionDeleteActions");
  const sidebarInlineActions = section(sidebarRow, ") : actionsVisible && !editing && (", "{contextMenuPoint && (");
  assert.doesNotMatch(activityRow, /<SessionCardQuickActions item=\{item\}/, "activity panel does not keep secondary card actions in row");
  assert.doesNotMatch(sidebarInlineActions, /SessionCardQuickActions/, "touch fallback uses More controls instead of a second inline action group");
  assert.match(extraActions, /<SessionCardQuickActions[\s\S]*onOpenTalkMapForSession=/, "More controls contains card actions");
  assert.match(extraActions, /onInjectContext=/);
  assert.match(extraActions, /onCopySessionInfo=/);
  assert.match(sidebarRow, /footerActions=\{hasFooterActions \? <SessionCardQuickActions item=\{item\}/, "sidebar keeps desktop card actions in hover preview footer");
  const searchRow = section(panelSource, "function ActivitySearchHitRow", "function searchHitToItem");
  assert.match(searchRow, /onOpenTalkMapForSession/);
  assert.match(searchRow, /onInjectContext/);
  assert.match(searchRow, /onCopySessionInfo/);
});

test("AppShell preserves remote device, project scope, focus session, and source-info semantics", () => {
  assert.match(shellSource, /handleOpenTalkMapForSession\(item\.session\.projectRoot \?\? item\.session\.cwd, item\.device, item\.session\.id\)/);
  assert.match(shellSource, /handleTalkMapInjectContext\(item\.session, item\.device\)/);
  assert.doesNotMatch(shellSource, /lastRecap/);
  assert.match(shellSource, /sourceDevice: item\.device\.name/);
  assert.match(shellSource, /const deviceLabel = device\?\.name \?\? localDeviceName \?\? "本机"/);
  assert.doesNotMatch(shellSource, /sourceDevice: `\$\{item\.device\.name\} \(\$\{item\.device\.id\}\)`/);
  assert.match(shellSource, /sourceSessionId: item\.session\.id/);
  assert.match(shellSource, /sourcePath: item\.session\.path/);
  assert.match(shellSource, /sourceProject: item\.session\.projectRoot \?\? item\.session\.cwd \?\? ""/);
  assert.match(shellSource, /return handleCopySessionField\("sourceInfo", sourceInfo\)/);
  assert.equal((shellSource.match(/onOpenTalkMapForSession=\{handleActivityTalkMap\}/g) ?? []).length, 2, "panel and sidebar both receive Talk Map action");
  assert.equal((shellSource.match(/onInjectContext=\{handleActivityInjectContext\}/g) ?? []).length, 2, "panel and sidebar both receive injection action");
  assert.equal((shellSource.match(/onCopySessionInfo=\{handleActivityCopySessionInfo\}/g) ?? []).length, 3, "panel, sidebar, and Talk Map receive copy action");
});
