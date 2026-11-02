import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionActivityPanel.tsx", import.meta.url), "utf8");
const previewSource = await readFile(new URL("./SessionHoverPreview.tsx", import.meta.url), "utf8");
const sidebarComponentSource = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const activityMetaSource = await readFile(new URL("./SessionActivityMeta.tsx", import.meta.url), "utf8");
const activitySource = source.slice(source.indexOf("function SessionActivityRow("), source.indexOf("\nconst iconButtonStyle"));
const sidebarSource = source.slice(source.indexOf("function SessionActivitySidebarRow("), source.indexOf("\nfunction SessionRowExtraActions"));

test("hover preview exists only on activity sidebar rows and seeds recap/device", () => {
  assert.doesNotMatch(activitySource, /<SessionHoverPreview/);
  assert.equal((sidebarSource.match(/<SessionHoverPreview/g) ?? []).length, 1);
  assert.match(sidebarSource, /initialRecap=\{item\.lastRecap\}/);
  assert.match(sidebarSource, /activityItem=\{item\}/);
  assert.match(sidebarSource, /activitySort=\{sort\}/);
  assert.match(sidebarSource, /activityFormatTime=\{formatTime\}/);
  assert.match(sidebarSource, /activityStatusLabel=\{statusLabel\}/);
  assert.match(sidebarSource, /activityContextLabel=\{contextLabel\}/);
  assert.match(sidebarSource, /activityCostPeer=\{costPeer\}/);
  assert.match(sidebarSource, /activityCostRootRef=\{costRootRef\}/);
  assert.match(sidebarSource, /deviceId=\{item\.device\.id\}/);
  assert.match(sidebarSource, /footerActions=\{hasFooterActions \? <SessionCardQuickActions/);
  assert.match(source, /useSessionHover/);
});

test("coarse pointers and hover keep row actions visible with context menu support", () => {
  assert.match(sidebarSource, /const coarsePointer = useCoarsePointer\(\);/);
  assert.match(sidebarSource, /const actionsVisible = hover\.hovered \|\| coarsePointer;/);
  assert.match(sidebarSource, /<SessionContextMenu/);
  assert.match(source, /onOpenTalkMapForSession/);
  assert.match(source, /archive/);
  assert.match(source, /remove/);
});

test("hover preview keeps its frame and uses accessible question, recap, and todo tabs", () => {
  assert.match(previewSource, /PREVIEW_MAX_WIDTH = 390/);
  assert.match(previewSource, /closest<HTMLElement>\(\"#session-sidebar\"\)/);
  assert.match(previewSource, /sidebarRect\.right \+ PREVIEW_PANEL_GAP/);
  assert.match(previewSource, /resizeObserver\?\.observe\(sidebar\)/);
  assert.match(previewSource, /footerActions\?: ReactNode/);
  assert.match(previewSource, /onInteraction\?: \(\) => void/);
  assert.match(previewSource, /HOVER_INTERACTION_GRACE_MS = 1000/);
  assert.match(previewSource, /keepOpenBriefly/);
  assert.match(previewSource, /data-session-hover-footer/);
  assert.match(previewSource, /data-session-hover-footer-actions/);
  assert.match(previewSource, /data-session-hover-footer-meta/);
  assert.match(previewSource, /\{effectiveFooterActions\}/);
  assert.doesNotMatch(previewSource, /fontSize: 13/);
  assert.match(previewSource, /fontWeight: 700, lineHeight: 1.65/);
  assert.match(previewSource, /sessionActivity\.userQuestion[\s\S]*?fontSize: 12, lineHeight: 1.45/);
  assert.match(previewSource, /marginTop: 7, fontFamily: "var\(--font-mono\)", fontSize: 12, lineHeight: 1.45/);
  assert.match(previewSource, /type SessionPreviewTab = "questions" \| "recap" \| "todos"/);
  assert.match(previewSource, /const \[activeTab, setActiveTab\] = useState<SessionPreviewTab>\("questions"\)/);
  assert.match(previewSource, /id: "questions"[\s\S]*?id: "recap"[\s\S]*?id: "todos"/);
  assert.match(previewSource, /const tabs: \{ id: SessionPreviewTab; label: string \}\[\] =/);
  assert.match(previewSource, /justifyContent: "center"/);
  assert.match(previewSource, /textAlign: "center"/);
  assert.doesNotMatch(previewSource, /count:/);
  assert.match(previewSource, /if \(!visible\) setActiveTab\("questions"\)/);
  assert.match(previewSource, /useEffect\(\(\) => setActiveTab\("questions"\), \[deviceId, peer, sessionId\]\)/);
  assert.doesNotMatch(previewSource, /setActiveTab\("questions"\), \[deviceId, peer, sessionId, version\]/);
  assert.match(previewSource, /role="tablist"/);
  assert.match(previewSource, /role="tab"/);
  assert.match(previewSource, /aria-selected=\{selected\}/);
  assert.match(previewSource, /aria-controls=\{`\$\{tabsId\}-panel`\}/);
  assert.match(previewSource, /aria-labelledby=\{`\$\{tabsId\}-tab-\$\{activeTab\}`\}/);
  assert.match(previewSource, /role="tabpanel"/);
  const recapHeadingRenderIndex = previewSource.indexOf("{recapHeading && (");
  assert.ok(recapHeadingRenderIndex > previewSource.indexOf('role="tablist"'), "recap heading must not render outside the selected tab contents");
  assert.ok(recapHeadingRenderIndex > previewSource.indexOf('role="tabpanel"'), "recap heading must be inside the tab panel");
  assert.match(previewSource, /ArrowRight[\s\S]*ArrowLeft[\s\S]*Home[\s\S]*End/);
  assert.match(previewSource, /sessionActivity\.previewSections/);
  assert.match(previewSource, /sessionActivity\.noTodos/);
  assert.match(previewSource, /loadUserQuestions: visible/);
  assert.match(previewSource, /sessionActivity\.userQuestion/);
  assert.match(previewSource, /sessionActivity\.recap/);
  assert.match(previewSource, /displayQuestions\.map/);
  assert.match(previewSource, /data-session-hover-question-icon="heroicons-chat-bubble-oval-left-ellipsis"/);
  assert.match(previewSource, /<path d="M8\.625 12a\.375/);
  assert.match(previewSource, /<svg[\s\S]*?viewBox="0 0 24 24"[\s\S]*?strokeWidth=\{1\.5\}/);
  assert.doesNotMatch(previewSource, />›<\/span>/);
  assert.doesNotMatch(previewSource, /questionExpanded|recapExpanded|todosExpanded|aria-expanded=/);
  assert.doesNotMatch(previewSource, /expandQuestions|collapseQuestions|session-hover-questions-expand/);
  assert.match(previewSource, /data-session-hover-title/);
  assert.match(previewSource, /height: position\.height/);
  assert.match(previewSource, /minHeight: 28/);
  assert.match(previewSource, /formatUserQuestion\(q, 10\)/);
  assert.match(previewSource, /stripHiddenUserQuestion/);
  assert.match(previewSource, /WebkitLineClamp: 10/);
});


test("hover preview dismisses on outside interaction and every caller wires dismissal", () => {
  assert.match(previewSource, /const dismiss = useCallback/);
  assert.match(previewSource, /keepOpenUntilRef\.current = 0/);
  assert.match(previewSource, /hideTimerRef\.current = window\.setTimeout/);
  assert.match(previewSource, /dismiss\(\);\s*\n\s*\}, delay\)/);
  assert.match(previewSource, /onDismiss: \(\) => void/);
  assert.match(previewSource, /document\.addEventListener\("pointerdown", handlePointerDown, true\)/);
  assert.match(previewSource, /if \(!contains\(event\.target, true\)\) onDismiss\(\)/);
  assert.match(previewSource, /document\.addEventListener\("pointermove", handlePointerMove, true\)/);
  assert.match(previewSource, /if \(!contains\(event\.target, true\)\) onMouseLeave\(\)/);
  assert.match(previewSource, /window\.addEventListener\("blur", handleWindowBlur\)/);
  assert.match(previewSource, /document\.addEventListener\("visibilitychange", handleVisibilityChange\)/);
  assert.equal((source.match(/onDismiss=\{hover\.dismiss\}/g) ?? []).length, 1);
  assert.equal((sidebarComponentSource.match(/<SessionHoverPreview/g) ?? []).length, 2);
  assert.equal((sidebarComponentSource.match(/onDismiss=\{hover\.dismiss\}/g) ?? []).length, 2);
});

test("activity metadata puts status last with readable separator spacing", () => {
  assert.match(activityMetaSource, /margin: "0 5px"/);
  assert.match(activityMetaSource, /data-session-activity-status style=\{\{ color: sessionActivityStatusColor\(status\), flexShrink: 0/);
  const timeIndex = activityMetaSource.indexOf("<span title={timeValue}");
  const contextIndex = activityMetaSource.indexOf("{contextLabel &&");
  const subagentIndex = activityMetaSource.indexOf("sessionActivity.subagentCompleted");
  const statusIndex = activityMetaSource.indexOf("data-session-activity-status");
  assert.ok(timeIndex >= 0 && contextIndex > timeIndex && subagentIndex > contextIndex && statusIndex > subagentIndex, "status metadata must render after all other metadata");
});

test("session search rows reuse live activity status", () => {
  assert.match(source, /activityItems=\{activity\.data\?\.sessions\}/);
  assert.match(source, /activityItems: readonly SessionActivityItem\[\] = \[\]/);
  assert.match(source, /const current = activityItems\.find\(/);
  assert.match(source, /if \(current\) \{\s*return \{\s*\.\.\.current/);
  assert.match(source, /status: effectiveStatus\(current, viewedAtBySession\)/);
  assert.match(source, /viewedAtBySession=\{viewedAtBySession\}/);
  assert.match(source, /hit\.contentMatchCount > 0 \? searchQuery\.trim\(\) : undefined/);
});
