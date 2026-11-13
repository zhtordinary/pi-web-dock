import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { hideRetriedErrors, latestRetryErrorEntry, readHiddenRetryErrors, rememberHiddenRetryError, retryDisplayScope } from "../lib/retry-display-state.ts";
import { emptyTranscript, mergeTranscriptPage, appendPersisted, transcriptView } from "../lib/transcript-store.ts";

const [chatInput, idRoute, activityPanel, fileExplorer, explorerSection, floatingSelect, selectorRow, appShell, revealRoute, chatWindow, modelsConfig, skillsConfig, pluginsConfig, embeddedModal, useContinueController, agentSession, zhCN, en, sessionSearchInput, sessionSidebar, globalsCss, rpcManager, sessionRunsRoute, sessionReader, useThemeSrc, layoutSrc, archiveRoute, remoteRoute, searchRoute, sessionContextMenu, worktreeBuckets] = await Promise.all([
  readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/api/sessions/[id]/route.ts", import.meta.url), "utf8"),
  readFile(new URL("./SessionActivityPanel.tsx", import.meta.url), "utf8"),
  readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8"),
  readFile(new URL("./ExplorerSection.tsx", import.meta.url), "utf8"),
  readFile(new URL("./ReaderFloatingSelect.tsx", import.meta.url), "utf8"),
  readFile(new URL("./SelectorRow.tsx", import.meta.url), "utf8"),
  readFile(new URL("./AppShell.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/api/files/reveal/route.ts", import.meta.url), "utf8"),
  readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8"),
  readFile(new URL("./ModelsConfig.tsx", import.meta.url), "utf8"),
  readFile(new URL("./SkillsConfig.tsx", import.meta.url), "utf8"),
  readFile(new URL("./PluginsConfig.tsx", import.meta.url), "utf8"),
  readFile(new URL("../lib/embedded-modal.ts", import.meta.url), "utf8"),
  readFile(new URL("../hooks/useContinueController.ts", import.meta.url), "utf8"),
  readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/i18n/messages/zh-CN.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/i18n/messages/en.ts", import.meta.url), "utf8"),
  readFile(new URL("./SessionSearchInput.tsx", import.meta.url), "utf8"),
  readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  readFile(new URL("../lib/rpc-manager.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/session-runs/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/session-reader.ts", import.meta.url), "utf8"),
  readFile(new URL("../hooks/useTheme.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/api/sessions/[id]/archive/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/remote/[...path]/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/sessions/search/route.ts", import.meta.url), "utf8"),
  readFile(new URL("./SessionContextMenu.tsx", import.meta.url), "utf8"),
  readFile(new URL("./WorktreeSessionBuckets.tsx", import.meta.url), "utf8"),
]);
const worktreeShell = await readFile(new URL("./app-shell-worktree.tsx", import.meta.url), "utf8");
const sessionTopBarStats = await readFile(new URL("./SessionTopBarStats.tsx", import.meta.url), "utf8");
const resourceToolbar = await readFile(new URL("./app-shell-resource-toolbar.tsx", import.meta.url), "utf8");
const topBarSource = `${appShell}\n${sessionTopBarStats}`;
const resourceToolbarSource = `${appShell}\n${resourceToolbar}`;

test("generation and activity selectors use one floating checked-menu pattern", () => {
  assert.match(floatingSelect, /font: "inherit",\s*fontSize: 11,[\s\S]*\.\.\.triggerStyle/);
  const genOptionSelect = chatInput.slice(chatInput.indexOf("function GenOptionSelect"), chatInput.indexOf("export function getDefaultGenOptions"));
  assert.match(genOptionSelect, /placement=\"above\"/);
  assert.match(genOptionSelect, /optionFontSize=\{12\}/);
  assert.match(genOptionSelect, /renderOption=\{\(option\) =>/);
  assert.match(floatingSelect, /props\.mode === \"single\" && props\.renderOption && !option\.action/);
  assert.match(floatingSelect, /<SelectorRow[\s\S]*gutter=\{false\}[\s\S]*onSelect=\{\(\) => selectOption\(option\)\}/);
  assert.match(floatingSelect, /createPortal\(menu, document\.body\)/);
  assert.match(chatInput, /<ReaderFloatingSelect[\s\S]*placement=\"above\"/);
  assert.match(activityPanel, /<ReaderFloatingSelect[\s\S]*placement=\"below\"/);
  assert.match(chatInput, /announceReaderMenuOpen\("chat-model"\)/);
  assert.match(chatInput, /function ChatInputSelectTrigger/);
  assert.match(chatInput, /aria-label=\{ariaLabel\}[\s\S]*aria-haspopup="listbox"[\s\S]*aria-expanded=\{open\}/);
  assert.match(chatInput, /renderTrigger=\{\(\{ triggerRef, open, disabled, onToggle \}\)/);
  assert.match(chatInput, /<ChatInputSelectTrigger[\s\S]*announceReaderMenuOpen\("chat-fast-mode"\)/);
  assert.match(chatInput, /<SelectorRow[\s\S]*disabled=\{mode === "fast" && !fastMode\.supported\}/);
  assert.match(chatInput, /<span style=\{\{ flex: 1 \}\}>\{mode\}<\/span>/);
  assert.match(chatInput, /role="listbox"\s+aria-label=\{t\("chat\.changeModel"\)\}/);
  assert.match(chatInput, /role="group"\s+aria-label=\{group\.provider\}/);
  assert.match(chatInput, /role="listbox"\s+aria-label=\{t\("chat\.changeFastMode"\)\}/);
  assert.match(chatInput, /role="listbox"\s+aria-label=\{t\("chat\.changeReasoningLabel"\)\}/);
  assert.match(chatInput, /role="listbox"\s+aria-label=\{t\("chat\.changeToolPreset"\)\}/);
  assert.match(selectorRow, /role="option"[\s\S]*aria-selected=\{active\}/);
  assert.match(floatingSelect, /renderTrigger\?:/);
  assert.match(activityPanel, /<ReaderFloatingMultiSelect[\s\S]*allValue=\"__all_projects__\"/);
  assert.doesNotMatch(activityPanel, /<details/);
  assert.doesNotMatch(activityPanel, /data-reader-menu-id/);
  assert.match(activityPanel, /archiveView/);
  assert.match(activityPanel, /ACTIVITY_DEVICE_SLOT_WIDTH/);
  assert.match(activityPanel, /onClose={activity\.handleProjectFilterClose}/);
  assert.match(floatingSelect, /if \(props\.mode === \"multiple\"\)[\s\S]*<button[\s\S]*role=\"option\"/);
  // Both activity surfaces expose the same empty-project new-session action.
  assert.match(activityPanel, /export function SessionActivityPanel[\s\S]*?ActivityNewSessionButton/);
  assert.match(activityPanel, /export function SessionActivitySidebar[\s\S]*?ActivityNewSessionButton/);
});

test("project groups expose Git navigation while the top toolbar keeps its Git button", async () => {
  const talkMapOverlay = await readFile(new URL("./TalkMapOverlay.tsx", import.meta.url), "utf8");
  const talkMapTypes = await readFile(new URL("../lib/talk-map-types.ts", import.meta.url), "utf8");
  const talkMapLib = await readFile(new URL("../lib/talk-map.ts", import.meta.url), "utf8");
  const activityPanelMain = activityPanel.slice(activityPanel.indexOf("export function SessionActivityPanel"), activityPanel.indexOf("export function SessionActivitySidebar"));
  assert.match(activityPanel, /onOpenWorktreeGraph\?: \(projectRoot: string, device\?: SessionActivityDevice\) => void/);
  assert.match(activityPanelMain, /onOpenWorktreeGraph\(groupPath, groupDeviceInfo\)/);
  assert.match(activityPanelMain, /<GitFork size=\{14\} strokeWidth=\{1\.8\}/);
  assert.doesNotMatch(activityPanelMain, /onOpenTalkMap\(groupPath, groupDeviceInfo\)/);
  assert.match(activityPanelMain, /<ActivityNewSessionButton[\s\S]*onNewSession=\{onNewSession\}/);
  assert.match(appShell, /topBarProjectPath && topBarIsGit[\s\S]*data-top-bar-worktree-graph="true"[\s\S]*handleTopBarWorktreeGraph/);
  const sessionTopBarStart = appShell.indexOf("const sessionTopBar");
  const sessionTopBarEnd = appShell.indexOf("  const chatWindowContent", sessionTopBarStart);
  assert.doesNotMatch(appShell.slice(sessionTopBarStart, sessionTopBarEnd), /worktreeGraph\.open/);
  // Known-project git state is read from the project cache; a first-time git probe never holds the response.
  assert.match(sessionRunsRoute, /const projectInfo = peekProject\(project\.path\)/);
  assert.doesNotMatch(sessionRunsRoute, /await resolveProject\(/);
  assert.match(sessionRunsRoute, /isGit: projectInfo\.isGit/);
  assert.match(appShell, /talkMapDevice/);
  assert.match(worktreeShell, /remotePeer=\{talkMapDevice && localDeviceId/);
  assert.match(talkMapOverlay, /remotePeer\?: string/);
  assert.match(talkMapOverlay, /apiPathForPeer\(remotePeer/);
  assert.match(talkMapOverlay, /deviceName\?: string \| null/);
  assert.match(talkMapOverlay, /focusSessionId\?: string \| null/);
  assert.match(talkMapOverlay, /projectDisplayName/);
  assert.match(talkMapOverlay, /mapLabel/);
  assert.match(talkMapOverlay, /reset-view/);
  assert.match(talkMapOverlay, /fontSize: 12/);
  assert.doesNotMatch(talkMapOverlay, /recap\?\.title|sessionRecapDisplay\([^)]*\)\.title/);
  assert.match(talkMapOverlay, /const recapText = sessionRecapDisplay\(activity\?\.lastRecap\)\.body;/);
  assert.match(talkMapOverlay, /data-talk-map-focused/);
  assert.match(talkMapOverlay, /outline: isFocused \?/);
  assert.doesNotMatch(talkMapOverlay, /session\.worktreeBranch \|\| session\.cwd/);
  assert.doesNotMatch(talkMapOverlay, /new Date\(session\.modified\)/);
  assert.match(talkMapOverlay, /lastX/);
  assert.match(talkMapOverlay, /event\.clientX - drag\.lastX/);
  assert.match(talkMapOverlay, /Math\.hypot\(event\.clientX - drag\.startX, event\.clientY - drag\.startY\)/);
  assert.match(worktreeShell, /deviceName=\{talkMapDevice\?\.name/);
  assert.match(worktreeShell, /focusSessionId=\{talkMapFocusSessionId\}/);
  assert.match(appShell, /talkMap\.locateSession/);
  assert.match(appShell, /talkMap\.open/);
  assert.match(appShell, /const topBarTalkMapLabel = topBarSessionId[\s\S]*talkMap\.locateSession[\s\S]*talkMap\.open/);
  assert.match(appShell, /topBarProjectPath && \(\s*<button[\s\S]*title=\{topBarTalkMapLabel\}[\s\S]*aria-label=\{topBarTalkMapLabel\}/);
  assert.match(appShell, /handleOpenTalkMapForSession\(topBarProjectPath, device, topBarSessionId\)/);
  assert.match(appShell, /data-top-bar-inject-context/);
  assert.match(appShell, /handleTopBarInjectContext/);
  assert.match(appShell, /<FileInput size=\{14\} strokeWidth=\{1\.8\}/);
  const topBarStart = appShell.indexOf("const sessionTopBar");
  const mapButtonOffset = appShell.indexOf('title={topBarTalkMapLabel}', topBarStart);
  const injectButtonOffset = appShell.indexOf("data-top-bar-inject-context", topBarStart);
  const deviceNameOffset = appShell.indexOf("{topBarDeviceName}", topBarStart);
  assert.ok(topBarStart >= 0 && mapButtonOffset >= 0 && injectButtonOffset > mapButtonOffset && deviceNameOffset >= 0 && injectButtonOffset < deviceNameOffset);
  assert.doesNotMatch(talkMapOverlay, /sessions\?force=1/);
  assert.match(talkMapOverlay, /void fetchActivities/);
  assert.match(talkMapOverlay, /activitySnapshotReady/);
  assert.match(talkMapOverlay, /data-talk-map-edges/);
  assert.match(talkMapOverlay, /op: "upsert-edge"/);
  assert.match(talkMapOverlay, /data-talk-map-add-edge/);
  assert.match(talkMapOverlay, /data-talk-map-edge-toggle/);
  assert.match(talkMapOverlay, /data-talk-map-fork/);
  assert.match(talkMapOverlay, /data-talk-map-inject/);
  assert.match(talkMapOverlay, /data-talk-map-frame/);
  assert.match(talkMapOverlay, /data-talk-map-add-ghost/);
  assert.match(talkMapOverlay, /data-talk-map-fit/);
  assert.match(talkMapOverlay, /data-talk-map-ghost-card/);
  assert.match(talkMapOverlay, /new EventSource\(apiPathForPeer\(remotePeer, "activity\/events"\)\)/);
  assert.match(talkMapOverlay, /source\.onmessage = \(event\) =>[\s\S]*payload\.type !== "activity"/);
  assert.match(talkMapOverlay, /return \(\) => \{\s*source\.close\(\);\s*if \(refreshTimer\) clearTimeout\(refreshTimer\)/);
  assert.match(talkMapOverlay, /data-talk-map-refresh-area/);
  assert.match(talkMapOverlay, /data-talk-map-refresh/);
  assert.doesNotMatch(talkMapOverlay, /\{loading \? t\("talkMap\.loading"\) : t\("talkMap\.refresh"\)\}/);
  assert.match(talkMapOverlay, /ReaderFloatingSelect/);
  assert.doesNotMatch(talkMapOverlay, /<select/);
  assert.match(talkMapOverlay, /data-talk-map-hide-empty-subprojects/);
  assert.doesNotMatch(talkMapOverlay, /disableAutoHideEmptySubprojects/);
  assert.match(talkMapOverlay, /color: autoHideEmptySubprojects \? "var\(--text-dim\)" : "var\(--accent\)"/);
  assert.match(talkMapOverlay, /data-talk-map-time-range/);
  assert.match(talkMapOverlay, /filterSessionsByActivityTime/);
  assert.match(talkMapOverlay, /useSharedActivityFilters/);
  assert.match(talkMapOverlay, /data-talk-map-card-meta/);
  assert.match(talkMapOverlay, /data-talk-map-selected-card-title/);
  assert.match(talkMapOverlay, /data-talk-map-new-session/);
  assert.match(talkMapOverlay, /data-talk-map-subproject-new-session/);
  assert.match(talkMapOverlay, /data-talk-map-convert-ghost/);
  assert.match(talkMapOverlay, /isSubprojectView && onConvertGhost/);
  assert.match(talkMapOverlay, /module\.id !== UNCLASSIFIED_SUBPROJECT_ID/);
  assert.doesNotMatch(talkMapOverlay, /className="talk-map-primary-action"/);
  assert.match(worktreeShell, /onNewSession=\{onTalkMapNewSession\}/);
  assert.match(worktreeShell, /onConvertGhost=\{onTalkMapConvertGhost\}/);
  assert.match(appShell, /mutation: \{ op: "append-session", sessionId \}/);
  assert.match(worktreeShell, /onSelectCard=\{onTalkMapSelectCard\}/);
  assert.match(appShell, /sessionInfo\?\.projectRoot \?\? remoteSession\.sessionInfo\?\.cwd/);
  assert.match(appShell, /selectedSession\?\.projectRoot \?\? selectedSession\?\.cwd/);
  assert.match(appShell, /padding: "8px 14px 8px 8px"/);
  assert.match(worktreeShell, /onArchiveSession=\{\(session\) => onTalkMapSessionMutation\(session, "archive"\)\}/);
  assert.match(worktreeShell, /onDeleteSession=\{\(session\) => onTalkMapSessionMutation\(session, "delete"\)\}/);
  assert.match(appShell, /highlightedSessionId=\{talkMapSidebarSessionId\}/);
  assert.match(sessionSidebar, /data-talk-map-highlighted=\{isHighlighted \? "true" : undefined\}/);
  assert.match(activityPanel, /highlightedSessionId\?: string \| null/);
  assert.match(activityPanel, /data-talk-map-highlighted=\{highlighted \? "true" : undefined\}/);
  assert.match(appShell, /selectedSessionKey=\{activeActivitySessionKey\}[\s\S]*?highlightedSessionId=\{talkMapSidebarSessionId\}/);
  assert.match(floatingSelect, /action\?: ReaderSelectOptionAction/);
  assert.match(floatingSelect, /triggerLabel\?: ReactNode/);
  assert.match(zhCN, /"sessionActivity\.hideEmptySubprojects"/);
  assert.match(en, /"sessionActivity\.hideEmptySubprojects"/);
  assert.match(zhCN, /"talkMap\.addGhost": "新建占位"/);
  assert.match(zhCN, /"talkMap\.ghostTitle": "新建占位卡片"/);
  assert.match(zhCN, /"talkMap\.ghostBody": "说明"/);
  assert.match(zhCN, /"talkMap\.ghostDelete": "删除占位"/);
  assert.match(zhCN, /"talkMap\.ghost": "占位"/);
  assert.match(zhCN, /"talkMap\.lockCards": "锁定卡片"/);
  assert.match(zhCN, /"talkMap\.unlockCards": "解锁卡片"/);
  assert.match(en, /"talkMap\.relationsHint": "View, search, and manage existing relations"/);
  assert.match(talkMapOverlay, /loadBoard\(projectRoot, \{ background: true \}\)/);
  assert.match(talkMapOverlay, /sessionsRef/);
  assert.match(talkMapOverlay, /data-talk-map-relations-toggle/);
  assert.match(talkMapOverlay, /data-talk-map-relations-toggle[\s\S]*data-talk-map-add-edge/);
  assert.match(talkMapOverlay, /isSubprojectView \? \([\s\S]*?subprojectLayout\.modules\.map/);
  assert.match(talkMapOverlay, /data-talk-map-subproject-scroll[\s\S]*?overflowY: "auto"/);
  assert.match(talkMapOverlay, /data-talk-map-relations/);
  assert.match(talkMapOverlay, /talkMap\.relationsHint/);
  assert.match(talkMapOverlay, /talk-map\/relations/);
  assert.match(talkMapOverlay, /handleFramePointerDown/);
  assert.match(worktreeShell, /onForkSession=\{onTalkMapFork\}/);
  assert.match(worktreeShell, /onInjectContext=\{onTalkMapInjectContext\}/);
  assert.match(worktreeShell, /sendAgentCommand<[\s\S]*type: "fork"/);
  assert.match(talkMapTypes, /op: "upsert-edge"/);
  assert.match(talkMapTypes, /op: "delete-edge"/);
  assert.match(talkMapTypes, /op: "upsert-frame"/);
  assert.match(talkMapTypes, /op: "upsert-ghost"/);
  assert.match(talkMapTypes, /op: "append-session"/);
  assert.match(talkMapLib, /export function queryTalkMapRelations/);
  assert.match(talkMapLib, /export function applyTalkMapMutation/);
  assert.match(talkMapLib, /newTalkMapEdgeId\(\)/);
  assert.doesNotMatch(sessionSidebar, /onOpenTalkMap/);
});

test("Talk Map injection creates a visible editable prompt with source identity", () => {
  const start = worktreeShell.indexOf("const handleTalkMapInjectContext");
  const end = worktreeShell.indexOf("const handleTalkMapFork", start);
  assert.ok(start >= 0 && end > start);
  const handler = worktreeShell.slice(start, end);
  assert.match(handler, /buildTalkMapInjectPrompt/);
  assert.match(handler, /sourceSessionId: session\.id/);
  assert.match(handler, /sourcePath: session\.path/);
  assert.match(handler, /sourceProject: session\.projectRoot \?\? session\.cwd/);
  assert.doesNotMatch(handler, /context:|来源摘要|firstMessage/);
  assert.match(handler, /handleNewActivitySession\(session\.cwd, device, session\.subprojectId, undefined, \{ initialMessage, contextSourceSessionId: session\.id \}\)/);
  assert.doesNotMatch(appShell, /talkMapContext|newSessionTalkMapContext/);
  assert.doesNotMatch(chatWindow, /TalkMapInjectedContext|talkMapContext/);
  assert.doesNotMatch(agentSession, /talkMapContext|TALK_MAP_CONTEXT_CUSTOM_TYPE/);
  assert.doesNotMatch(rpcManager, /inject_talk_map_context/);
  assert.match(rpcManager, /sendNativePeerMessage/);
});

test("subproject visibility is available from project menus and management", () => {
  assert.match(activityPanel, /hasSubprojects/);
  assert.match(activityPanel, /onToggleAutoHideEmptySubprojects/);
  assert.match(activityPanel, /toggleAutoHideEmptySubprojects/);
  assert.match(activityPanel, /data-subproject-auto-hide/);
  assert.match(activityPanel, /autoHideEmptySubprojects/);
  assert.doesNotMatch(activityPanel, /t\(autoHideEmptySubprojects \? "sessionActivity\.disableAutoHideEmptySubprojects"/);
  assert.doesNotMatch(activityPanel, /t\(sortSetting\?\.autoHideEmptySubprojects \? "sessionActivity\.disableAutoHideEmptySubprojects"/);
  assert.match(activityPanel, /color: autoHideEmptySubprojects \? "var\(--text-dim\)" : "var\(--accent\)"/);
  assert.match(activityPanel, /onClick=\{\(\) => void toggleVisibility\(subproject\)\}/);
  assert.match(activityPanel, /hidden: !subproject\.hidden/);
  assert.match(sessionSidebar, /useSharedActivityFilters/);
  assert.match(sessionSidebar, /isWithinActivityTimeRange/);
  assert.match(sessionSidebar, /autoHiddenSubprojectIds/);
  assert.match(sessionSidebar, /projectSubprojects/);
});

test("activity sort lists 最后提问时间 first with asked metadata plumbing", () => {
  // asked is the first SortValue and the first dropdown option in both surfaces.
  assert.match(activityPanel, /type SortValue = "asked" \| "recent" \| "status";/);
  assert.equal((activityPanel.match(/\{ value: "asked", label: t\("sessionActivity\.sortAsked"\) \}/g) ?? []).length, 2);
  // The big panel option list order: asked → recent → status (started dropped).
  const panelMain = activityPanel.slice(activityPanel.indexOf("export function SessionActivityPanel"), activityPanel.indexOf("export function SessionActivitySidebar"));
  assert.ok(panelMain.indexOf("value: \"asked\"") < panelMain.indexOf("value: \"recent\""));
  assert.ok(!/value: "started"/.test(panelMain));
  // Row time display uses shared selected-sort time and falls back to last activity when unknown.
  assert.match(activityPanel, /return sessionActivityDisplayTime\(item, sort\);/);
  // Sidebar row timer follows the active sort (prop) instead of hardcoding recent.
  assert.match(activityPanel, /formatTime\(itemTime\(item, sort\)\)/);
  assert.match(activityPanel, /sort=\{filters\.sort\}/);
  // i18n keys in both locales.
  assert.match(zhCN, /"sessionActivity\.sortAsked": "最后提问时间"/);
  assert.match(zhCN, /"sessionActivity\.sortAskedHint"/);
  assert.match(en, /"sessionActivity\.sortAsked": "Last question time"/);
  assert.match(en, /"sessionActivity\.sortAskedHint"/);
  // a0f844e4 误删了 chat.genRequest 翻译，导致生图选择器显示原始 key。
  assert.match(zhCN, /"chat\.genRequest": "按请求"/);
  assert.match(en, /"chat\.genRequest": "Request"/);
  // Server plumbing: metadata follows the latest substantive user question;
  // continuation prompts remain activity-only.
  assert.match(sessionRunsRoute, /lastAskedAt\?: string/);
  assert.match(sessionRunsRoute, /if \(message && !isContinuationPrompt\(message\)\) \{/);
  assert.match(sessionRunsRoute, /if \(typeof entry\.timestamp === "string"\) lastAskedAt = entry\.timestamp;/);
});

test("activity search rows use selected time sort", () => {
  const rowStart = activityPanel.indexOf("function ActivitySearchHitRow(");
  const rowEnd = activityPanel.indexOf("\nfunction searchHitToItem", rowStart);
  assert.ok(rowStart >= 0 && rowEnd > rowStart);
  const searchRow = activityPanel.slice(rowStart, rowEnd);
  assert.match(searchRow, /sort: SortValue/);
  assert.match(searchRow, /sort=\{sort\}/);

  const panelStart = activityPanel.indexOf("export function SessionActivityPanel");
  const sidebarStart = activityPanel.indexOf("export function SessionActivitySidebar");
  const panelSearchStart = activityPanel.indexOf("<ActivitySearchHitRow", panelStart);
  const panelSearchEnd = activityPanel.indexOf("/>", panelSearchStart);
  const sidebarSearchStart = activityPanel.indexOf("<ActivitySearchHitRow", sidebarStart);
  const sidebarSearchEnd = activityPanel.indexOf("/>", sidebarSearchStart);
  assert.match(activityPanel.slice(panelSearchStart, panelSearchEnd), /sort=\{state.sort\}/);
  assert.match(activityPanel.slice(sidebarSearchStart, sidebarSearchEnd), /sort=\{filters.sort\}/);
});

test("activity time display does not expose future timestamps as an ETA", () => {
  const formatTimeStart = activityPanel.indexOf("const formatTime =");
  const formatTime = activityPanel.slice(formatTimeStart, activityPanel.indexOf("const formatDuration =", formatTimeStart));
  assert.match(formatTime, /if \(deltaSeconds < 0\)[\s\S]*numeric: "auto"[\s\S]*format\(0, "second"\)/);
  assert.doesNotMatch(formatTime, /direction = deltaSeconds >= 0 \? -1 : 1/);
});

test("outer theme seeds and syncs embedded iframes (no half-light/half-dark split)", () => {
  // The embedded page is cross-origin with its aggregate shell, so the theme
  // must travel explicitly: URL param on load + postMessage broadcast on switch.
  assert.match(useThemeSrc, /readUrlThemeParam\(\) \?\? readStoredPreference\(\)/);
  assert.match(useThemeSrc, /THEME_URL_PARAM = "theme"/);
  assert.match(useThemeSrc, /THEME_CHANGE_EVENT = "pi-theme-changed"/);
  assert.match(useThemeSrc, /broadcastTheme\(theme\);/);
  assert.match(useThemeSrc, /handleThemeMessage\(event: MessageEvent\)/);
  assert.match(useThemeSrc, /export function getThemeSnapshot\(\)/);
  // The iframe URL builder stamps the current resolved theme onto every embed.
  assert.match(appShell, /target\.searchParams\.set\("theme", getThemeSnapshot\(\)\.theme\);/);
  // Pre-hydration script honors ?theme= too, so a reload of an embedded page
  // cannot fall back to its own origin's storage and split away from the shell.
  assert.match(layoutSrc, /new URLSearchParams\(location\.search\)\.get\("theme"\)/);
  // In-app URL rewrites keep the seeded theme param.
  assert.match(appShell, /const urlTheme = new URLSearchParams\(window\.location\.search\)\.get\("theme"\);/);
  // Embedded pages report their own theme switches back to the parent shell.
  assert.match(useThemeSrc, /window\.parent\.postMessage\(\{ type: THEME_CHANGE_EVENT, theme \}, "\*"\);/);
});

test("theme palette selectors match or exceed html.dark specificity", () => {
  // html.dark has specificity (0, 1, 1).
  // Pine theme has isDarkTheme = true, which adds .dark class to root.
  // To avoid html.dark overriding pine palette, html[data-theme="pine"] must be defined.
  assert.match(globalsCss, /html\[data-theme="pine"\],\s*\[data-theme="pine"\]/);
  assert.match(globalsCss, /html\[data-theme="mist"\],\s*\[data-theme="mist"\]/);
  assert.match(globalsCss, /html\[data-theme="rose"\],\s*\[data-theme="rose"\]/);
});

test("workspace-memory restore never hijacks the URL session or drops embedded params", () => {
  // The URL session restore owns the selection while it is still in flight.
  assert.match(appShell, /if \(!initialSessionRestoredRef\.current\) return;/);
  // The remembered-session URL rewrite preserves embedded-mode params instead
  // of replacing the URL with a bare ?session= (which turned the embedded
  // session page back into the full aggregate shell / popped side panel).
  assert.match(appShell, /const params = workspaceParams\(\);\n\s*params\.set\("session", s\.id\);/);
});

test("archived sessions resolve and restore like active ones", () => {
  // Fix A: the archived scan populates the id→path cache exactly like the
  // active scan (two cacheSessionPath call sites, one per list builder), so
  // view/rename/delete/unarchive stop 404ing after a server restart.
  assert.equal((sessionReader.match(/cacheSessionPath\(s\.id, s\.path\);/g) ?? []).length, 2);
  // Fix B: the ?session= shell restore falls back to the archived list when
  // the id is not in the active list (archived links/iframe URLs must open).
  assert.match(appShell, /loadLocalSession\(initialSessionId\)/);
  assert.match(appShell, /for \(const query of \["", "\?archived=1"\]\)/);
  // Collection links must restore the same active/archived dataset that was
  // visible before refresh, including favorites and hidden sessions.
  assert.match(appShell, /const collectionArchiveQuery = params\.get\("view"\) === "archived"[\s\S]*?"&archived=1"/);
  assert.match(appShell, /`\/api\/session-runs\?scope=\$\{hiddenScope \? "hidden" : "favorites"\}\$\{collectionArchiveQuery\}`/);
  // Aggregate monitor links also fall back when local session moves to archive.
  assert.match(appShell, /loadLocalSession\(sessionParam\)/);
});

test("search uses one compact control across Reader surfaces", () => {
  assert.match(sessionSearchInput, /className="session-search-input"/);
  assert.match(explorerSection, /import \{ SessionSearchInput \} from "\.\/SessionSearchInput"/);
  assert.match(explorerSection, /<SessionSearchInput[\s\S]*files\.searchPlaceholder/);
  assert.doesNotMatch(explorerSection, /<input[\s\S]*files\.searchPlaceholder/);
  assert.match(sessionSearchInput, /event\.key === "Escape"/);
  assert.match(sessionSearchInput, /className="session-search-clear"/);
  assert.equal((activityPanel.match(/<SessionSearchInput/g) ?? []).length, 2);
  assert.match(sessionSidebar, /<SessionSearchInput[\s\S]*sidebar\.searchPlaceholder/);
  // Activity panel: filters row first, search on its own full-width row below.
  assert.match(activityPanel, /flexWrap: "wrap", gap: 6, padding: "8px 14px 0", flexShrink: 0 \}\}>[\s\S]*?<ActivityProjectFilter/);
  assert.match(activityPanel, /padding: "8px 14px", borderBottom: "1px solid var\(--border\)", flexShrink: 0 \}\}>\n\s*<SessionSearchInput/);
  // Inside the activity panel (not the sidebar), search must come after the filters row.
  const panelMain = activityPanel.slice(activityPanel.indexOf("export function SessionActivityPanel"), activityPanel.indexOf("export function SessionActivitySidebar"));
  assert.ok(panelMain.indexOf("<ActivityProjectFilter") < panelMain.indexOf("<SessionSearchInput"));
  assert.match(activityPanel, /height: 26, padding: "0 5px"[\s\S]*borderRadius: 4/);
  assert.doesNotMatch(activityPanel, /minWidth: 106/);
  assert.doesNotMatch(activityPanel, /minWidth: 150, width: "max-content"/);
  assert.doesNotMatch(activityPanel, /borderTop: "1px solid var\(--border\)", position: "relative"/);
  assert.match(globalsCss, /\.session-search-input[\s\S]*height: 26px/);
  const sessionSearchInputCss = globalsCss.slice(globalsCss.indexOf(".session-search-input {"), globalsCss.indexOf(".session-search-input::placeholder"));
  assert.match(sessionSearchInputCss, /font-size: 11px;/);
  assert.match(globalsCss, /textarea,\s*input,\s*select \{\s*font-size: 16px !important;\s*\}/);
  assert.match(globalsCss, /\.session-search-input \{\s*font-size: 11px !important;\s*\}/);
  assert.match(globalsCss, /\.session-search-match-filter-select \{\s*font-size: 11px !important;\s*\}/);
  assert.match(globalsCss, /\.worktree-graph-search-input \{\s*font-size: 11px !important;\s*\}/);
  const searchMatchFilterStart = activityPanel.indexOf('ariaLabel={t("sessionActivity.searchMatchFilterLabel")}');
  const searchMatchFilterEnd = activityPanel.indexOf(">", searchMatchFilterStart);
  assert.ok(searchMatchFilterStart >= 0 && searchMatchFilterEnd > searchMatchFilterStart);
  assert.match(activityPanel.slice(searchMatchFilterStart, searchMatchFilterEnd), /fontSize: 11/);
  assert.doesNotMatch(activityPanel.slice(searchMatchFilterStart, searchMatchFilterEnd), /fontSize: 12/);
  assert.match(activityPanel, /containerClassName="session-search-match-filter-select"/);
  for (const styleName of ["selectStyle", "sidebarSelectStyle"]) {
    const styleDeclaration = activityPanel.match(new RegExp(`const ${styleName}: React\\.CSSProperties = \\{([^}]+)\\}`));
    assert.ok(styleDeclaration, `${styleName} must be defined`);
    assert.match(styleDeclaration[1], /(?:^|,)\s*fontSize:\s*11\s*(?=,|$)/);
  }
  assert.equal((activityPanel.match(/optionFontSize=\{11\}/g) ?? []).length, 2);
  assert.match(chatInput, /const mobileControlsVisible = isMobile && \(controlsMenuOpen \|\| isStreaming \|\| canStop\);/);
  assert.match(chatInput, /gridColumn: "1 \/ -1", gridRow: 2/);
  assert.match(chatInput, /position: "static",[\s\S]*width: "100%",[\s\S]*flexWrap: "wrap"/);
});

test("left activity sidebar is a contiguous pointer surface (inputs stay text cursor)", () => {
  // 整个左面板应为手指：外层容器（设备/筛选/标签行及间隙）不再露默认箭头，
  // 仅可编辑输入框保留 I 型文本光标。
  assert.match(globalsCss, /\.session-activity-sidebar \{\s*cursor: pointer;\s*\}/);
  assert.match(globalsCss, /\.session-activity-sidebar input,\s*\.session-activity-sidebar textarea \{\s*cursor: text;\s*\}/);
});

test("device grouping keeps the owning project name on session rows", () => {
  assert.match(activityPanel, /function rowContextLabel/);
  assert.match(activityPanel, /if \(group === "device"\) return item\.projectLabel/);
  assert.match(activityPanel, /contextLabel=\{rowContextLabel\(item, state\.group, activityScope, state\.device === "all"\)\}/);
  assert.match(activityPanel, /contextLabel=\{rowContextLabel\(item, filters\.group, activityScope, filters\.device === "all"\)\}/);
});

test("empty project groups stay visible and own path removal", () => {
  assert.match(activityPanel, /type ActivityGroup = readonly/);
  assert.match(activityPanel, /if \(\(filters\.group === "project" \|\| filters\.group === "worktree"\)\)/);
  assert.match(activityPanel, /if \(!grouped\.has\(key\)\) grouped\.set\(key, \[\]\)/);
  assert.match(activityPanel, /canDeleteProject = Boolean\([\s\S]*groupProject\?\.saved && groupDeviceId\)/);
  assert.match(activityPanel, /onDelete=\{state\.group === "project" && canDeleteProject && groupProject/);
  assert.match(activityPanel, /onDelete=\{filters\.group === "project" && canDeleteProject && groupProject/);
  assert.doesNotMatch(activityPanel, /onContextMenu: \(event: React\.MouseEvent<HTMLDivElement>\)/);
  assert.match(activityPanel, /onSessionDeleted\?: \(sessionId: string\) => void/);
  assert.match(activityPanel, /onSessionDeleted\?\.\(item\.session\.id\)/);
  assert.match(appShell, /<SessionActivityPanel[\s\S]*onSessionDeleted=\{handleSessionDeleted\}/);
  assert.match(appShell, /<SessionActivitySidebar[\s\S]*onSessionDeleted=\{handleSessionDeleted\}/);
  assert.match(appShell, /<SessionActivitySidebar[\s\S]{0,2000}remotePeer=\{activePeerId\}/);
  assert.match(appShell, /<SessionActivityPanel[\s\S]*onNewSession=\{handleNewActivitySession\}/);
});

test("project removal routes to owner and filter options expose context menu", () => {
  assert.match(activityPanel, /hasSessions\?: boolean/);
  assert.match(activityPanel, /onContextMenu\?: \(info: ActivityProjectInfo/);
  assert.match(activityPanel, /onDeleteProject\?: \(info: ActivityProjectInfo/);
  assert.match(activityPanel, /onDeleteProject=\{activity\.handleDeleteKnownProject\}/);
  assert.match(activityPanel, /const endpoint = isLocal \? "\/api\/projects" : `\/api\/remote\/projects\?peer=/);
  assert.match(activityPanel, /openAt=\{contextMenu\.point\}/);
  assert.match(activityPanel, /hasSessions=\{groupProject\?\.hasSessions \?\? visibleItems\.length > 0\}/);
  assert.doesNotMatch(activityPanel, /items\.length === 0 && groupDeviceId === localDeviceId/);
});

test("project deletion requires no sessions and uses inline confirm matching subproject style", () => {
  assert.match(activityPanel, /!hasProjectSessions && groupProject\?.saved && groupDeviceId/);
  assert.match(activityPanel, /canDelete={Boolean\(contextMenu\.info\.saved && !contextMenu\.info\.hasSessions\)}/);
  assert.match(activityPanel, /{canDelete && onDelete && !hasSessions && \(/);
  assert.match(activityPanel, /activity-project-delete-confirm activity-subproject-delete-confirm/);
  assert.match(activityPanel, /onRequestDelete={\(\) => {[\s\S]*?setProjectDeleteConfirmKey\(groupKey\);/);
  assert.match(globalsCss, /\.activity-subproject-delete-confirm,\s*\.activity-project-delete-confirm\s*{/);
  assert.match(globalsCss, /\.activity-project-delete-confirm\s*{\s*padding-left:\s*10px;\s*}/);
});


test("activity menus close outside and archive view shares one control", () => {
  assert.match(floatingSelect, /onClose\?: \(\) => void/);
  assert.match(floatingSelect, /document\.addEventListener\("pointerdown", closeOnPointerDown, true\)/);
  assert.match(floatingSelect, /document\.addEventListener\("focusin", closeOnFocusIn\)/);
  assert.match(floatingSelect, /window\.addEventListener\("blur", closeOnWindowBlur\)/);
  const projectContextMenu = activityPanel.slice(activityPanel.indexOf("function ProjectPathContextMenu"), activityPanel.indexOf("interface FilterOption"));
  assert.ok(projectContextMenu.length > 0);
  assert.match(projectContextMenu, /event\.target instanceof HTMLIFrameElement/);
  assert.match(projectContextMenu, /document\.activeElement instanceof HTMLIFrameElement/);
  assert.match(projectContextMenu, /document\.addEventListener\("focusin", closeOnFocusIn\)/);
  assert.match(projectContextMenu, /window\.addEventListener\("blur", closeOnWindowBlur\)/);
  assert.match(activityPanel, /sessionActivity.activeSessions/);
  assert.match(activityPanel, /sessionActivity.archivedSessions/);
});

test("opening a session preserves the all-device activity list", () => {
  const openStart = activityPanel.indexOf("const openActivitySession = useCallback");
  const openEnd = activityPanel.indexOf("const focusFirstProjectSession", openStart);
  assert.ok(openStart >= 0 && openEnd > openStart);
  assert.match(activityPanel.slice(openStart, openEnd), /onOpenSession\(item, searchTerm\)/);
  assert.doesNotMatch(activityPanel.slice(openStart, openEnd), /updateSharedFilters/);
  assert.match(activityPanel, /openActivitySession\(first\)/);

  // Big activity panel keeps all-device scope when opening a session.
  const panelRenderStart = appShell.indexOf("<SessionActivityPanel");
  const panelRenderEnd = appShell.indexOf("/>", panelRenderStart);
  assert.ok(panelRenderStart >= 0 && panelRenderEnd > panelRenderStart);
  const panelRender = appShell.slice(panelRenderStart, panelRenderEnd);
  assert.doesNotMatch(panelRender, /onDeviceChange=\{/);
  assert.match(panelRender, /onActivityDeviceFilterChange=\{!embeddedReaderMode \? handleActivityDeviceFilterChange : undefined\}/);
});

test("activity button locates the open session without recap controls", () => {
  assert.match(activityPanel, /return \(\) => \{[\s\S]*?saveState\(\{ \.\.\.readState\(\), expanded: \[\] \}\);/);
  assert.match(appShell, /const activeActivitySessionKey = embeddedSessionKey[\s\S]*?embeddedIframeSessionId/);
  assert.match(appShell, /focusSessionId=\{activeActivitySessionId\} focusSessionKey=\{activeActivitySessionKey\}/);
  assert.match(activityPanel, /focusSessionId\?: string \| null/);
  assert.match(activityPanel, /focusSessionKey\?: string \| null/);
  assert.match(activityPanel, /handledFocusSessionRef/);
  assert.match(activityPanel, /pendingScrollKeyRef/);
  assert.match(activityPanel, /data-session-key=\{itemKey\(item\)\}/);
  assert.doesNotMatch(activityPanel, /autoRecap/);
  assert.doesNotMatch(activityPanel, /autoRecapTriggeredRef/);
  assert.doesNotMatch(activityPanel, /questionsSinceRecap/);
  assert.doesNotMatch(activityPanel, /requestRecap/);
  assert.doesNotMatch(activityPanel, /sessionActivity\.recapRun/);
  assert.match(activityPanel, /if \(!key \|\| key !== locateKey\) return;/);
  assert.match(activityPanel, /recapPeer=\{item\.device\.id === localDeviceId \? undefined : item\.device\.id\}/);
  assert.match(activityPanel, /updateState\(\{ device: "all", archiveView: "active", project: \[\], status: "all", days: "all" \}\)/);
});
test("remote device and session views use one complete Reader document", () => {
  assert.match(appShell, /const EMBEDDED_SESSION_PARAM = "piWebSessionOnly"/);
  assert.match(appShell, /const EMBEDDED_CHAT_PARAM = "piWebChatOnly"/);
  assert.match(appShell, /const EMBEDDED_SIDEBAR_PARAM = "piWebSidebarOnly"/);
  assert.match(appShell, /buildEmbeddedReaderUrl\(item\.device, \{ localDeviceId, sessionId: item\.session\.id, sessionOnly: true \}\)/);
  assert.doesNotMatch(appShell, /target\.origin === currentOrigin/);
  assert.match(appShell, /if \(sessionOnlyMode\) target\.searchParams\.set\(EMBEDDED_SESSION_PARAM, "1"\);/);
  assert.match(appShell, /else target\.searchParams\.delete\(EMBEDDED_SESSION_PARAM\);/);
  assert.match(appShell, /const embeddedSessionKey =|const \[embeddedSessionKey, setEmbeddedSessionKey\]/);
  assert.match(appShell, /const remoteWorkspaceUrl = embeddedReaderUrl/);
  assert.doesNotMatch(appShell, /remoteChatUrl|remoteSidebarUrl|title="Remote session sidebar"/);
  assert.doesNotMatch(appShell, /flex: "0 0 min\(40vh, 360px\)"/);
  assert.match(appShell, /chatOnlyMode \? \{ display: "none" \}/);
  assert.match(appShell, /const chatOpen = !sidebarOnlyMode/);
  assert.match(appShell, /selectedSessionKey=\{activeActivitySessionKey\}/);
  // 完整设备视图只保留覆盖 iframe 顶部的设备切换条；iframe 仍是完整 Reader。
  assert.match(appShell, /deviceSwitchOnly/);
  assert.match(appShell, /deviceSwitchValue/);
  assert.match(appShell, /activityDeviceOverlayWidth/);
  assert.match(appShell, /onDeviceChange=\{!embeddedReaderMode \? handleChangeActivityDevice : undefined\}/);
  assert.match(appShell, /<iframe ref=\{embeddedIframeRef\} key=\{remoteWorkspaceUrl\}/);
  assert.match(appShell, /readerMode=\{readerMode \|\| isEmbeddedSessionOnly\}/);
});

test("remote activity clicks use the live mobile viewport", () => {
  assert.match(appShell, /const MOBILE_VIEWPORT_QUERY = "\(max-width: 640px\)"/);
  assert.match(appShell, /function isMobileViewport\(\): boolean/);
  assert.match(appShell, /setSidebarOpen\(\(open\) => \{[\s\S]{0,220}if \(sessionOnlyMode\) return false;/);
  assert.match(appShell, /if \(embeddedSessionKey && isMobileViewport\(\)\) setSidebarOpen\(false\)/);
  assert.match(appShell, /if \(isMobileViewport\(\) && !isRestore\) setSidebarOpen\(false\)/);
  assert.match(appShell, /setSidebarOpen\(!isMobileViewport\(\)\)/);
});


test("embedded config modals still relay state to the shell", () => {
  // iframe 内配置面板打开时，外层设备切换条区域同步显示遮罩，避免透出底层控件。
  assert.match(appShell, /EMBEDDED_MODAL_STATE_EVENT/);
  assert.match(appShell, /event\.source !== embeddedIframeRef\.current\?\.contentWindow/);
  assert.match(appShell, /data-embedded-modal-shield/);
  assert.match(appShell, /zIndex: 310/);
  for (const config of [modelsConfig, skillsConfig, pluginsConfig]) {
    assert.match(config, /notifyEmbeddedModalState\(true\)/);
    assert.match(config, /notifyEmbeddedModalState\(false\)/);
  }
  assert.match(embeddedModal, /window\.parent\.postMessage/);
  assert.match(embeddedModal, /EMBEDDED_MODAL_STATE_EVENT/);
});

test("embedded Talk Map hides the parent full-device control", async () => {
  const talkMap = await readFile(new URL("./TalkMapOverlay.tsx", import.meta.url), "utf8");
  assert.match(talkMap, /notifyEmbeddedModalState\(true, "talk-map"\)/);
  assert.match(talkMap, /notifyEmbeddedModalState\(false, "talk-map"\)/);
  assert.match(appShell, /embeddedModalKind/);
  assert.match(appShell, /embeddedModalKind === "talk-map" \|\| embeddedFileViewerOpen \? "none" : "flex"/);
  assert.match(appShell, /embeddedModalKind !== "talk-map"/);
  assert.match(appShell, /const embeddedTalkMapOpen = Boolean\([\s\S]*embeddedModalKind === "talk-map"/);
  assert.match(appShell, /embeddedTalkMapOpen \? \{ display: "none" \} : \{\}/);
  assert.match(appShell, /!embeddedTalkMapOpen/);
});

test("embedded file previews hide the parent full-device control", () => {
  assert.match(embeddedModal, /EmbeddedModalKind = "config" \| "talk-map" \| "file-viewer" \| "image-preview" \| "sidekick" \| "slash-detail"/);
  assert.match(appShell, /notifyEmbeddedModalState\(rightPanelOpen, "file-viewer"\)/);
  assert.match(appShell, /setEmbeddedFileViewerOpen\(data\.open\)/);
  assert.match(appShell, /embeddedFileViewerOpen/);
});

test("embedded image previews use an acknowledged global surface with a stable iframe", () => {
  assert.match(embeddedModal, /EmbeddedModalKind = "config" \| "talk-map" \| "file-viewer" \| "image-preview" \| "sidekick" \| "slash-detail"/);
  assert.match(appShell, /data\.kind === "image-preview"/);
  assert.match(appShell, /embeddedModalKind === "talk-map" \|\| embeddedFileViewerOpen \? "none" : "flex"/);
  assert.doesNotMatch(appShell, /data-embedded-image-preview-shield/);
  assert.match(appShell, /embeddedModalOpen && embeddedModalKind === "sidekick" \? \{ position: "fixed", inset: 0, zIndex: 1400 \}/);
  assert.match(appShell, /onReady=\{acknowledgeEmbeddedImagePreview\}/);
  assert.match(appShell, /embeddedImagePreview && embeddedImagePreview\.phase !== "closed"[\s\S]*?<ImageLightbox/);
  assert.doesNotMatch(appShell, /data-embedded-image-preview-backdrop/);
  assert.doesNotMatch(appShell, /embeddedModalKind === "image-preview" \? \{ position:/);
  // File-viewer open state must be cleared on explicit close AND on the
  // generic !open branch so a stale viewer never keeps the shield mounted.
  assert.match(appShell, /if \(data\.kind === "file-viewer"\) \{\s*setEmbeddedFileViewerOpen\(data\.open\);/);
  assert.match(appShell, /if \(data\.kind === "config"\) setEmbeddedFileViewerOpen\(false\);/);
  // Shield condition keeps clear grouping so && / || cannot be misread.
  assert.match(appShell, /\(embeddedModalOpen && embeddedModalKind !== "talk-map" && embeddedModalKind !== "image-preview"\) \|\| embeddedFileViewerOpen/);
});

test("embedded slash command details use the outer document modal host", () => {
  assert.match(embeddedModal, /EMBEDDED_SLASH_DETAILS_EVENT/);
  assert.match(embeddedModal, /EMBEDDED_SLASH_DETAILS_CLOSE_EVENT/);
  assert.match(chatInput, /prepareEmbeddedModal\("slash-detail"\)/);
  assert.match(chatInput, /window\.parent\.postMessage\(state, "\*"\)/);
  assert.match(chatInput, /editablePrompt \?/);
  assert.match(embeddedModal, /editablePrompt\?: CustomPromptEditValue/);
  assert.match(appShell, /typeof rawPrompt\.content === "string" && rawPrompt\.content\.length <= 4 \* 1024 \* 1024/);
  assert.match(appShell, /\.\.\.\(editablePrompt \? \{ editablePrompt \} : \{\}\)/);
  assert.match(appShell, /event\.origin === expectedOrigin/);
  assert.match(appShell, /EMBEDDED_SLASH_DETAILS_EVENT/);
  assert.match(appShell, /setEmbeddedModalKind\("slash-detail"\)/);
  assert.match(appShell, /<SlashCommandDetailsSurface[\s\S]*onClose=\{closeEmbeddedSlashDetails\}/);
  assert.match(appShell, /const closeEmbeddedSlashDetails = useCallback/);
  assert.match(appShell, /EMBEDDED_SLASH_DETAILS_CLOSE_EVENT/);
  assert.match(appShell, /handleOpenEmbeddedSlashFile/);
  assert.match(chatInput, /slashDetailCommand && !embeddedInParent/);
});

test("embedded session navigation preserves session-only parameters", () => {
  const openStart = appShell.indexOf("const handleOpenActivitySession");
  const openEnd = appShell.indexOf("const handleRemoteSessionCreated", openStart);
  assert.ok(openStart >= 0 && openEnd > openStart);
  const open = appShell.slice(openStart, openEnd);
  assert.match(open, /if \(embeddedReaderMode\) \{[\s\S]*target\.searchParams\.set\(EMBEDDED_READER_PARAM, "1"\)/);
  assert.match(open, /target\.searchParams\.set\(EMBEDDED_SESSION_PARAM, "1"\)/);
});


test("embedded new-session navigation keeps the Reader scope", () => {
  assert.match(appShell, /const replaceWorkspaceRoot = useCallback/);
  assert.match(appShell, /if \(embeddedReaderMode\) params\.set\(EMBEDDED_READER_PARAM, "1"\)/);
  assert.match(appShell, /if \(sessionOnlyMode\) params\.set\(EMBEDDED_SESSION_PARAM, "1"\)/);
  const newSessionStart = appShell.indexOf("const handleNewSession");
  const newSessionEnd = appShell.indexOf("const handleNewActivitySession", newSessionStart);
  assert.ok(newSessionStart >= 0 && newSessionEnd > newSessionStart);
  assert.match(appShell.slice(newSessionStart, newSessionEnd), /replaceWorkspaceRoot\(\)/);
});


test("device scope limits project options", () => {
  assert.match(activityPanel, /matchesActivityDevice\(item\.device\.id, filters\.device, activityScope\)/);
  assert.match(activityPanel, /matchesActivityDevice\(entry\.deviceId, filters\.device, activityScope\)/);
  assert.match(activityPanel, /setFilters\(\{ device: value, project: \[\] \}\)/);
});

test("project groups expose path actions and reveal on the owning device", () => {
  assert.match(activityPanel, /ProjectPathContextMenu/);
  assert.match(activityPanel, /path: item\.session\.projectRoot \?\? item\.session\.cwd/);
  assert.match(activityPanel, /sessionActivity\.copyProjectPath/);
  assert.match(activityPanel, /sessionActivity\.openProjectPath/);
  assert.match(activityPanel, /deviceId \? \{ deviceId \} : \{\}/);
  assert.match(revealRoute, /getRevealDeviceTarget/);
  assert.match(revealRoute, /AbortSignal\.timeout\(10_000\)/);
});

test("project path context menu fits its action labels", () => {
  assert.match(activityPanel, /const projectContextMenuStyle[\s\S]*?width: "max-content"/);
  assert.match(activityPanel, /const projectContextMenuItemStyle[\s\S]*?width: "max-content"/);
  assert.match(activityPanel, /whiteSpace: "nowrap"/);
  assert.doesNotMatch(activityPanel, /const projectContextMenuStyle[\s\S]*?minWidth: 210/);
});

test("project context menu repositions from its measured size", () => {
  const projectContextMenu = activityPanel.slice(activityPanel.indexOf("function ProjectPathContextMenu"), activityPanel.indexOf("interface FilterOption"));
  assert.match(activityPanel, /clampFloatingMenuPosition/);
  assert.match(projectContextMenu, /getBoundingClientRect\(\)/);
  assert.match(projectContextMenu, /visibility: menuPosition \? "visible" : "hidden"/);
  assert.match(activityPanel, /maxHeight: "calc\(100vh - 16px\)"/);
  assert.doesNotMatch(projectContextMenu, /window\.innerHeight - 120/);
});

test("project context menu uses a full divider before project visibility actions", () => {
  const projectContextMenu = activityPanel.slice(activityPanel.indexOf("function ProjectPathContextMenu"), activityPanel.indexOf("interface FilterOption"));
  const separator = projectContextMenu.indexOf('role="separator"');
  const visibilityAction = projectContextMenu.indexOf("{(onHide || onUnhide) &&");
  const deleteAction = projectContextMenu.indexOf("{canDelete && onDelete &&");
  assert.ok(separator >= 0 && separator < visibilityAction);
  assert.ok(visibilityAction >= 0 && visibilityAction < deleteAction);
  assert.match(projectContextMenu, /role="separator"[\s\S]*height: 1[\s\S]*alignSelf: "stretch"/);
  assert.doesNotMatch(projectContextMenu, /color: "#dc2626", borderTop:/);
});

test("project title context menu clears native text selection", () => {
  const projectContextMenu = activityPanel.slice(activityPanel.indexOf("function ProjectPathContextMenu"), activityPanel.indexOf("interface FilterOption"));
  assert.match(projectContextMenu, /userSelect: "none"/);
  assert.match(projectContextMenu, /window\.getSelection\(\)\?\.removeAllRanges\(\)/);
});

test("empty new chat header shows unlabelled project and device identity", () => {
  assert.match(chatWindow, /const activityUrl = remotePeer[\s\S]*?api\/remote\/session-runs/);
  assert.match(chatWindow, /getFileName\(projectPath\)/);
  assert.match(chatWindow, /join\(" · "\)/);
  assert.match(chatWindow, /deviceName\?: string/);
  assert.match(chatWindow, /\[projectName, deviceName\]\.filter\(Boolean\)\.join\(" · "\)/);
  assert.match(chatWindow, /display: "flex", alignItems: "baseline", gap: isMobile \? 7 : 10/);
  assert.match(chatWindow, /maxWidth: "35%", lineHeight: 1\.4, paddingBottom: 7, overflow/);
  assert.doesNotMatch(chatWindow, /display: "flex", alignItems: "center", gap: 10/);
  // The whole header row centre-aligns line boxes like upstream; the brand
  // paddingBottom compensation keeps glyph ink centred inside its box.
  assert.match(chatWindow, /alignItems: "center",\s*justifyContent: "space-between",\s*gap: 12,\s*marginLeft: 16,\s*marginRight: isMobile \? 16 : 52/);
  assert.match(chatWindow, /justifyContent: "flex-start"/);
  assert.match(chatWindow, /alignItems: "center"/);
  assert.match(chatWindow, /fontSize: 12/);
  assert.doesNotMatch(chatWindow, /t\("chat\.(project|device)"\)/);
});

test("activity filter preferences use persistent local storage with legacy migration", () => {
  assert.match(activityPanel, /window\.localStorage\.getItem\(SHARED_FILTERS_KEY\)/);
  assert.match(activityPanel, /window\.localStorage\.setItem\(SHARED_FILTERS_KEY, raw\)/);
  assert.match(activityPanel, /window\.localStorage\.setItem\(SHARED_FILTERS_KEY, JSON\.stringify\(sharedFilters\)\)/);
  assert.doesNotMatch(activityPanel, /sessionStorage\.setItem\(SHARED_FILTERS_KEY/);
});

test("file explorer invalidates loaded child directories after filter changes", () => {
  const reloadStart = fileExplorer.indexOf("// Re-fetch open directories when the tree refreshes");
  const reloadEnd = fileExplorer.indexOf("// Load children as soon as a directory becomes open", reloadStart);
  assert.ok(reloadStart >= 0 && reloadEnd > reloadStart);
  const reloadEffect = fileExplorer.slice(reloadStart, reloadEnd);
  assert.match(reloadEffect, /childListingsRef\.current\.cancel\(\)/);
  assert.match(reloadEffect, /if \(!node\.isDir\) return;\s+setLoaded\(false\);\s+setLoading\(false\);\s+if \(open\) void loadChildren\(true\);/);
  assert.match(reloadEffect, /\[refreshToken, filter, node\.fullPath, node\.isDir, peer\]/);
  const applyFilterStart = fileExplorer.indexOf("const applyFilter = useCallback");
  const applyFilterEnd = fileExplorer.indexOf("const handleRequestDelete", applyFilterStart);
  assert.ok(applyFilterStart >= 0 && applyFilterEnd > applyFilterStart);
  assert.doesNotMatch(fileExplorer.slice(applyFilterStart, applyFilterEnd), /setExpandedPaths\(new Set\(\)\)/);
});

test("file explorer context menu copies relative and absolute paths", () => {
  assert.match(fileExplorer, /import \{ copyText \} from "@\/lib\/clipboard";/);
  assert.match(fileExplorer, /kind === "relative" \? getRelativeFilePath\(node\.fullPath, cwd\) : node\.fullPath/);
  assert.match(fileExplorer, /handleCopyPath\("relative"\)/);
  assert.match(fileExplorer, /handleCopyPath\("absolute"\)/);
  assert.match(fileExplorer, /t\("files\.copyRelativePath"\)/);
  assert.match(fileExplorer, /t\("files\.copyAbsolutePath"\)/);
  assert.match(zhCN, /"files\.copyRelativePath": "复制相对路径"/);
  assert.match(zhCN, /"files\.copyAbsolutePath": "复制绝对路径"/);
  assert.match(en, /"files\.copyRelativePath": "Copy relative path"/);
  assert.match(en, /"files\.copyAbsolutePath": "Copy absolute path"/);
});

test("fresh-page default project lock only accepts local device sessions", () => {
  // A peer session carries a foreign absolute cwd that would fail local
  // project-trust / model requests, so the lock must use the local scope.
  assert.match(appShell, /session-runs\?scope=local/);
  assert.match(appShell, /embeddedReaderMode \? "local" : "all"/);
  assert.doesNotMatch(appShell, /scope=\$\{scope\}/);
});

test("fresh-page default lock follows a persisted single-project filter", () => {
  // A saved one-project activity filter must own the lock even when that
  // project has zero sessions (it resolves against local known projects);
  // resolution stays inside the scope=local response so foreign device
  // paths can never become the local default project.
  assert.match(appShell, /readSharedFilters\(\)\.project/);
  assert.match(appShell, /byKey\.get\(filterProjects\[0\]\)/);
  assert.match(appShell, /runs\?\.knownProjects \?\? \[\]/);
  assert.match(appShell, /item\.session\.projectRoot \?\? item\.session\.cwd/);
  assert.match(appShell, /scope=local/);
});


test("device dropdown keeps server order (no reverse, no name localeCompare)", () => {
  // 顺序由服务端按本机配置 order 字段给出，客户端不再 reverse / 字典序重排。
  assert.doesNotMatch(activityPanel, /\.reverse\(\)\.map/);
  assert.doesNotMatch(activityPanel, /a\.name\.localeCompare\(b\.name\)/);
  assert.match(activityPanel, /顺序由服务端按本机配置 order 字段给出/);
});

test("device dropdown offers add-device entry writing via POST /api/peers", () => {
  assert.match(activityPanel, /ADD_DEVICE_VALUE/);
  assert.match(activityPanel, /showAddDevice/);
  assert.match(activityPanel, /fetch\("\/api\/peers"/);
  assert.match(activityPanel, /addDevicePlaceholder/);
  assert.match(zhCN, /"sessionActivity\.addDevice"/);
  assert.match(en, /"sessionActivity\.addDevice"/);
});

test("activity costs load lazily per visible row", () => {
  assert.match(activityPanel, /function useLazySessionCost\(/);
  assert.match(activityPanel, /new IntersectionObserver/);
  assert.match(activityPanel, /root: rootRef\?\.current \?\? null/);
  assert.match(activityPanel, /rootMargin: "240px 0px"/);
  assert.match(activityPanel, /useSessionDetails/);
  assert.match(activityPanel, /loadCost: nearViewport/);
  assert.doesNotMatch(activityPanel, /fetch\(url, \{ cache: "no-store"/);
  assert.doesNotMatch(activityPanel, /initialCost|item\.totalCost/);
  assert.match(activityPanel, /cost: cost\?\.amount \?\? null/);
  assert.match(activityPanel, /costRootRef=\{scrollRef\}/);
  assert.doesNotMatch(sessionRunsRoute, /calculatedSessionCost/);
  assert.doesNotMatch(sessionRunsRoute, /sessionCostScript/);
  assert.doesNotMatch(sessionRunsRoute, /totalCost: metadata\.totalCost/);
});

test("activity costs use one red threshold and the same color in panel and sidebar", () => {
  assert.match(activityPanel, /import \{[^}]*sessionCostColor[^}]*\} from "@\/lib\/session-cost";/);
  assert.match(topBarSource, /import \{[^}]*sessionCostColor[^}]*\} from "@\/lib\/session-cost";/);
  assert.equal((activityPanel.match(/sessionCostColor\(costValue\)/g) ?? []).length, 2);
  assert.match(activityPanel, /className="session-activity-sidebar-row"/);
  assert.equal((activityPanel.match(/style=\{\{ color: sessionCostColor\(costValue\) \}\}>\{costText\}/g) ?? []).length, 2);
  assert.doesNotMatch(activityPanel, /<span style=\{\{ color: "var\(--text-dim\)" \}\}>\{costText\}<\/span>/);
  assert.match(activityPanel, /useSessionDetails/);
  assert.doesNotMatch(activityPanel, /sessionCacheHitColor/);
  assert.match(topBarSource, /sessionCacheHitRate/);
  assert.doesNotMatch(appShell, /sessionCacheHitColor/);
  assert.doesNotMatch(activityPanel, /sessionActivity\.totalCost/);
  assert.doesNotMatch(activityPanel, /function costColor/);
  assert.doesNotMatch(topBarSource, /function sessionCostColor/);
});

test("activity panel uses status metadata as its second row", () => {
  const row = activityPanel.slice(activityPanel.indexOf("function SessionActivityRow("), activityPanel.indexOf("function SessionActivitySidebarRow("));
  const titleRow = row.indexOf('className="activity-session-title-row"');
  const metaRow = row.indexOf('className="activity-session-meta"');
  assert.ok(titleRow >= 0 && metaRow > titleRow, "title row must precede metadata row");
  assert.match(row.slice(metaRow), /statusLabel\(item\.status\)/);
  assert.match(row.slice(metaRow), /className="activity-session-time"/);
  assert.doesNotMatch(row, /questionPreview|lastUserMessage/);
});

test("activity panel session rows expose right-click context menu and inline edit button", () => {
  assert.match(activityPanel, /<Pencil size=\{12\}/, "session rows expose inline rename button");
  assert.match(activityPanel, /onContextMenu/, "session rows handle context menu");
  assert.match(activityPanel, /<SessionContextMenu/, "session rows render SessionContextMenu");
});

test("cache hit keeps its dot separator even when cost is absent", () => {
  // 修复：缓存命中前的间隔点此前由 costText 门控，金额未生成时 CH 紧贴时间、缺间隔点。
  // 现改为 cacheHitText 存在即无条件补 MetaSeparator/·（主面板行与侧栏行两处）。
  assert.ok(!activityPanel.includes("{costText && <MetaSeparator />}<span"), "main row: cache-hit separator must not be gated by costText");
  assert.ok(!activityPanel.includes("{costText && <span aria-hidden=\"true\" style={{ color: \"var(--text-dim)\" }}>·</span>}<span"), "sidebar row: cache-hit separator must not be gated by costText");
  assert.ok(activityPanel.includes("{cacheHitText && <><MetaSeparator /><span>{cacheHitText}</span></>}"), "main panel row cache hit should use unconditional MetaSeparator");
  assert.ok(activityPanel.includes("{cacheHitText && <><span aria-hidden=\"true\" style={{ color: \"var(--text-dim)\" }}>·</span><span style={{ color: \"var(--text-dim)\" }}>{cacheHitText}</span></>}"), "sidebar row cache hit should use unconditional dot separator");
});

test("session-runs orders devices by config order field", () => {
  assert.match(sessionRunsRoute, /orderOf/);
  assert.match(sessionRunsRoute, /config\.device\?\.order/);
  assert.match(sessionRunsRoute, /orderOf\.get\(a\.id\)/);
});

test("session activity does not let a stale retry mask an active user prompt", () => {
  assert.match(rpcManager, /isRetryInFlight\(\): boolean/);
  assert.match(rpcManager, /isUserPromptActive\(\): boolean/);
  assert.match(sessionRunsRoute, /const schedulerActive = Boolean\(/);
  assert.match(sessionRunsRoute, /const retryInFlight = rpc\?\.isRetryInFlight\(\) === true/);
  assert.match(sessionRunsRoute, /const userPromptActive = rpc\?\.isUserPromptActive\(\) === true/);
  assert.match(sessionRunsRoute, /const retrying = shouldShowRetryingStatus\(\{/);
  assert.match(sessionRunsRoute, /streaming: rpc\?\.isStreaming === true/);
});

test("archived sessions read activity from the archived catalog", () => {
  assert.match(chatWindow, /const activityUrl = remotePeer[\s\S]*session\?\.archived \? "&archived=1" : ""/);
  assert.match(chatWindow, /: `\/api\/session-runs\?scope=local\$\{session\?\.archived \? "&archived=1" : ""\}`/);
});

test("abnormal runs (unknown/failed/aborted/retrying) surface the continue button", () => {
  // 异常运行（unknown 服务中断 / failed 失败 / aborted 中止）的会话：打开时
  // 查询 session-runs，status 命中恢复态则把发送按钮合并为 continue 状态。
  assert.match(chatWindow, /abnormalRun/);
  assert.match(chatWindow, /applyActivityStatus\(item\.status, item\.execution\)/);
  assert.match(chatWindow, /const activityUrl = remotePeer[\s\S]*?api\/remote\/session-runs/);
  assert.match(chatWindow, /fetchSessionActivity/);
  assert.match(chatWindow, /sessionIdForAbnormal/);
  assert.match(chatWindow, /abnormalUserMessageKeyRef/);
  // SSE 驱动首选，状态检查保留有界的前台兜底。
  assert.match(chatWindow, /window\.setInterval\(check, 15_000\)/);
  assert.match(chatWindow, /window\.clearInterval\(timer\)/);
  assert.match(chatWindow, /activityStatusRequestRef/);
  // 历史/custom hydration 不应被消息总数变化误判为新用户消息。
  assert.match(chatWindow, /if \(loading\) return;/);
  assert.match(chatWindow, /if \(latestUserMessageKey !== abnormalUserMessageKeyRef\.current\)/);
  assert.doesNotMatch(chatWindow, /abnormalMessagesLengthRef/);
  // 手动停止立即同步、会话中止尾部立即呈现继续按钮、清除短期活动缓存与运行中守卫
  assert.match(chatWindow, /isTailAborted/);
  assert.match(chatWindow, /clearSessionActivityCache/);
  assert.match(chatWindow, /handleAbortSession/);
  assert.match(chatWindow, /if \(sessionBusy\) return;/);
});

test("manual abort settles the selected chat runtime after the server aborts", () => {
  const abortStart = agentSession.indexOf("const handleAbort = useCallback");
  const abortSource = agentSession.slice(abortStart, agentSession.indexOf("const handleFork", abortStart));
  assert.match(abortSource, /await sendAgentCommandR\(sid, \{ type: abortingBash \? "abort_bash" : "abort" \}\)/);
  assert.match(abortSource, /setIsCompacting\(false\);[\s\S]*settleUiStage\(\)/);
  const settleStart = agentSession.indexOf("const settleUiStage = useCallback");
  const settleSource = agentSession.slice(settleStart, agentSession.indexOf("const notifyPromptStage", settleStart));
  assert.match(settleSource, /sdkAgentActiveRef\.current = false/);
  assert.match(settleSource, /rpcPromptPendingRef\.current = false/);
});

test("state surfaces use SSE with bounded foreground fallbacks", () => {
  assert.match(appShell, /openReaderEventSource\(\["running"\]\)/);
  assert.match(appShell, /RUNNING_SESSIONS_POLL_MS|fetch\("\/api\/agent\/running"/);
  assert.match(activityPanel, /window\.setInterval\(\(\) => \{[\s\S]{0,120}?void refresh\(\)/);
  assert.match(chatWindow, /window\.setInterval\(check, 15_000\)/);
  assert.match(agentSession, /window\.setInterval\(reconcile, 15_000\)/);
  // 快速 prompt 结算恢复是保留的有界回退（见 waitForPromptSettlement）；
  // bash 结算不再依赖 waitForBashSettlement（已由 reconcile/loadSession 覆盖）。
  assert.match(agentSession, /waitForPromptSettlement/);
  assert.doesNotMatch(agentSession, /waitForBashSettlement/);
});

test("keyboard menus recover after IME or focus interruption", () => {
  assert.match(chatInput, /window\.addEventListener\("blur", resetComposition\)/);
  assert.match(chatInput, /window\.addEventListener\("focus", restoreMenuFocus\)/);
  assert.match(chatInput, /onBlur=\{\(\) => \{[\s\S]*?isComposingRef\.current = false/);
  assert.match(chatWindow, /window\.addEventListener\("keydown", handleGlobalKeyDown, true\)/);
  assert.match(chatWindow, /window\.addEventListener\("blur", resetComposition\)/);
  assert.match(chatWindow, /editorRef\.current\?\.focus\(\)/);
  assert.match(chatWindow, /const \[selectedIndex, setSelectedIndex\]/);
  assert.match(chatWindow, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
  assert.match(chatWindow, /optionRefs\.current\[next\]\?\.focus\(\)/);
});

test("archive mutations cannot wait forever on stale runtime or peer state", () => {
  assert.match(archiveRoute, /await closeIdleSession\(bundleId, source\)/);
  assert.match(archiveRoute, /await controlSiblingSession\(bundleId, "shutdown"\)/);
  assert.match(archiveRoute, /sessionArchiveFiles\(source\)/);
  assert.match(archiveRoute, /acquireStateWriteLock\(file\)/);
  assert.match(remoteRoute, /AbortSignal\.timeout\(isMcpTest \? 65_000 : 12_000\)/);
  assert.match(appShell, /createRemoteSessionMutationClient/);
  assert.doesNotMatch(appShell, /proxyController\.abort\(\)/);
});

test("archive refreshes bypass stale session and activity snapshots", () => {
  assert.match(sessionSidebar, /showArchived \? `\/api\/sessions\?archived=1\$\{force \? "&force=1" : ""\}`/);
  assert.equal((sessionSidebar.match(/onSessionArchived=\{\(id\) => \{ onSessionDeleted\?\.\(id\); loadSessions\(false, true\); \}\}/g) ?? []).length, 1); // one shared virtual renderer covers flat, subproject, and worktree paths
  assert.match(sessionReader, /export async function listArchivedSessions\(options: \{ force\?: boolean[^}]*\} = \{\}\)/);
  assert.equal((activityPanel.match(/onChanged=\{\(\) => void activity\.refresh\(item\.device\.id, true\)\}/g) ?? []).length, 2);
});


test("subagent lifecycle actions stay with the parent bundle", () => {
  assert.match(archiveRoute, /session_child_lifecycle_requires_parent/);
  assert.match(sessionSidebar, /lifecycleManagedByParent/);
  assert.match(activityPanel, /lifecycleManagedByParent/);
  assert.match(activityPanel, /subagentLifecycleRequiresParent/);
  assert.match(sessionContextMenu, /disabled=\{archiveDisabled \|\| !canMutateAny \|\| busy\}/);
  assert.match(sessionContextMenu, /disabled=\{deleteDisabled \|\| !canMutateAny \|\| busy\}/);
});

test("archive rows leave only after the move is confirmed", () => {
  const rowStart = activityPanel.indexOf("function SessionActivityRow(");
  const sidebarRowStart = activityPanel.indexOf("function SessionActivitySidebarRow(", rowStart);
  const rowSources = [
    activityPanel.slice(rowStart, sidebarRowStart),
    activityPanel.slice(sidebarRowStart),
  ];
  for (const row of rowSources) {
    const archiveStart = row.indexOf("const archive = async");
    const removeStart = row.indexOf("const remove = async", archiveStart);
    const archiveSource = row.slice(archiveStart, removeStart);
    assert.doesNotMatch(archiveSource, /setBusy\(true\);\s*onRemoved\?\.\(item\.session\.id\)/);
    assert.match(archiveSource, /if \(!ok\) throw new Error[\s\S]*?onRemoved\?\.\(item\.session\.id\)/);
  }
});
test("archive rejections stay visible and retryable", () => {
  assert.match(sessionSidebar, /assertSessionMutationOk\(res\)/);
  assert.match(sessionSidebar, /const \[archiveError, setArchiveError\]/);
  assert.match(sessionSidebar, /archiveError &&/);
  assert.match(activityPanel, /assertSessionMutationOk\(response\)/);
  assert.ok((activityPanel.match(/const \[archiveError, setArchiveError\]/g) ?? []).length >= 2);
});
test("archive errors clear when opening the session", () => {
  assert.match(sessionSidebar, /setArchiveError\(null\);\s*setDeleteError\(null\);\s*onClick\(\);/);
  assert.match(sessionSidebar, /setArchiveError\(null\);\s*onSelect\(\);/);
  assert.equal((activityPanel.match(/setArchiveError\(null\);\s*onOpen\(\);/g) ?? []).length, 2);
});


test("unattended retry failure sounds use server truth across all producers", () => {
  assert.match(rpcManager, /recordSessionRunError\(this\.inner\.sessionId, errorMessage, this\.unattendedEnabled, this\.currentRunId\)/);
  assert.match(rpcManager, /private emit\(event: AgentEvent\)[\s\S]*?unattended: this\.unattendedEnabled/);
  assert.match(sessionRunsRoute, /getUnattendedConfigured\(\)/);
  assert.match(activityPanel, /const unattended = liveEvent\.unattended \?\? currentItem\?\.unattended/);
  assert.match(activityPanel, /if \(unattended && \(liveEvent\.status === "failed" \|\| liveEvent\.status === "aborted"\)\) return/);
  assert.match(agentSession, /onAgentError\?: \(serverUnattended\?: boolean, serverRunId\?: string\) => void/);
  assert.match(agentSession, /onAgentError\?\.\(typeof event\.unattended === "boolean" \? event\.unattended : undefined, serverRunId\)/);
  assert.match(chatWindow, /serverUnattended \?\? unattendedRef\.current/);
});

test("embedded reader delegates wait-sound to the outer shell (no double play)", () => {
  // 内嵌 iframe 的 AppShell 全局等待 SSE 通道不得独立播报等待音：外层聚合壳才是
  // 跨设备「不在看才播」的单一声音权威；iframe 通过已校验的父级 claim 协议参与。
  assert.match(appShell, /if \(embeddedReaderMode\) return;/);
  assert.match(appShell, /\}, \[embeddedReaderMode, playWaitSound, canPlayWaitSound\]\);/);
  assert.match(appShell, /SOUND_CLAIM_REQUEST_EVENT/);
  assert.match(appShell, /event\.source !== source/);
  assert.match(appShell, /event\.origin !== expectedOrigin/);
  assert.match(appShell, /tryPlaySoundRequest\(waitSoundRequestId\(requestId\), playWaitSound, \(\) => canPlayWaitSound\("wait"\)\)/);
  // 浮层面板同样在嵌入态静音，与 SessionActivitySidebar 的 soundAlerts={!embeddedReaderMode} 一致。
  assert.match(appShell, /soundAlerts=\{!embeddedReaderMode\}/);
});

test("shell revives its audio context on validated gestures reported by an embedded Reader", async () => {
  // 完整设备视图里状态音由外层播，而用户的手势落在 iframe 内、到不了外层文档：
  // iframe 转告手势，外层在校验 source 与 origin 之后才恢复自己的 AudioContext。
  const audio = await readFile(new URL("../hooks/useAudio.ts", import.meta.url), "utf8");
  assert.match(appShell, /event\.origin !== expectedOrigin\) return;\s*if \(data\.type === SOUND_UNLOCK_EVENT\) \{\s*unlockAudio\(\);\s*return;\s*\}/);
  assert.match(audio, /window\.parent\.postMessage\(\{ type: SOUND_UNLOCK_EVENT \}, targetOrigin\)/);
  // 手势、可见性与 statechange 的监听统一在 useAudio 模块里，AppShell 不再另挂一份。
  assert.match(audio, /for \(const type of AUDIO_GESTURE_EVENTS\) \{\s*window\.addEventListener\(type, onUserGesture, \{ capture: true, passive: true \}\)/);
  assert.match(audio, /document\.addEventListener\("visibilitychange", onPresence\)/);
  assert.doesNotMatch(appShell, /window\.addEventListener\(evt, unlock, \{ capture: true \}\)/);
});

test("status sounds use atomic claims and replay-aware Activity delivery", async () => {
  const audio = await readFile(new URL("../hooks/useAudio.ts", import.meta.url), "utf8");
  const events = await readFile(new URL("../app/api/activity/events/route.ts", import.meta.url), "utf8");
  assert.match(audio, /navigator as Navigator & \{ locks\?: SoundLockManager \}/);
  assert.match(audio, /locks\.request\(soundLockName\(requestId\)/);
  assert.match(audio, /const SOUND_CLAIM_TTL_MS = 7 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(audio, /const SOUND_CLAIM_MAX = 4096/);
  assert.match(audio, /claim 不因播放结果 rollback/);
  assert.match(appShell, /event\.source !== source/);
  assert.match(appShell, /event\.origin !== expectedOrigin/);
  assert.doesNotMatch(chatWindow, /postMessage\(\{ type: "pi-web-session-sounded"/);
  assert.match(events, /activityEventsSince\(since\)/);
  assert.match(events, /replay: true/);
  assert.match(activityPanel, /pendingActivityEventsRef/);
  assert.match(activityPanel, /liveEvent\.replay && prevStateKeysRef\.current === null/);
  assert.match(rpcManager, /pendingUiRequests\.values\(\)\) listener\(\{ \.\.\.structuredClone\(event\), replay: true \}\)/);
  assert.match(chatWindow, /replay\?: unknown/);
});

test("slash commands and prompt-running re-entry use prompt settlement fallback", () => {
  // 非流式命令（斜杠命令）及重入未流式 prompt 走 waitForPromptSettlement 兜底；
  // 普通 prompt 发送严禁挂 waitForPromptSettlement，由 SSE 事件驱动。
  assert.match(agentSession, /const waitForPromptSettlement = useCallback\(/);
  assert.match(agentSession, /PROMPT_SETTLE_INITIAL_DELAY_MS = 800/);
  assert.match(agentSession, /if \(isSlashCommandPrompt && sentSessionId\) \{\s+void waitForPromptSettlement\(sentSessionId, promptRunId\);/);
  assert.match(agentSession, /\n\s*while \(agentRunningRef\.current && Date\.now\(\) - startedAt < PROMPT_SETTLE_MAX_MS\)/);
});

test("unattended auto-retry countdown exposes a stop control", () => {
  // 服务端无人值守倒计时期间 isStreaming=false：无人值守按钮与“停止自动继续”
  // 必须按 continueUi running 状态渲染，不能只依赖流式状态，否则倒计时期间
  // 没有任何停止入口。停止动作复用 set_unattended(false) 清理服务端调度器。
  assert.match(chatInput, /\(canStop \|\| \(continueUi && continueUi\.kind === "running"\)\) && onUnattendedChange/);
  assert.match(chatInput, /onStopContinue\?: \(\) => void/);
  assert.match(chatInput, /continueUi && continueUi\.kind === "running" && unattended && onStopContinue/);
  assert.match(chatInput, /\{t\("chat\.stopAutoContinue"\)\}/);
  assert.match(chatWindow, /onStopContinue=\{stopAutoRetry\}/);
  assert.match(useContinueController, /const stopAutoRetry = useCallback/);
  assert.match(useContinueController, /setUnattended\(false\)/);
  assert.doesNotMatch(useContinueController, /stopContinue/);
});
test("countdown intervals always clear the previous one (no orphan flicker)", () => {
  // 本地 effect 创建倒计时 interval 前必须先 clearTimer()：直接覆盖
  // countdownTimerRef 会把旧 interval 变成孤儿，其曲线耗尽后每 250ms 写
  // nextDelayMs=0，与有效 interval 交替覆盖，按钮在 Ns 和 0s 之间闪跳。
  // 两处（unattended 分支与 manual 分支）都必须先清理。
  const creations = useContinueController.match(/clearTimer\(\);\s[\s\S]{0,80}?countdownTimerRef\.current = setInterval/g) ?? [];
  assert.ok(creations.length >= 1, "manual countdown clears its predecessor; unattended countdown uses the server deadline");
});

test("pure-error assistant messages fold into process details", async () => {
  // 纯错误 assistant（无有效回答、带错误信息）一律折叠进 ProcessDetailsGroup
  // （默认收起），不独立展示红色错误框；不再区分是否等待重试/最后锚点轮次，
  // 历史失败同样折叠。无人值守开启期间失败音一律静音，仅手动模式播报。
  // 过程/回答视图的拆分已抽到 lib/turn-views.ts，ChatWindow 只消费 finalViews。
  const turnViews = await readFile(new URL("../lib/turn-views.ts", import.meta.url), "utf8");
  assert.match(turnViews, /const failed = split\.answerBlocks\.length === 0\s*&&\s*getAssistantErrorMessage\(message\) !== null/);
  assert.match(turnViews, /split\.processBlocks\.length > 0[\s\S]*?:\s*failed\s*\?\s*message\s*:\s*null/);
  assert.match(turnViews, /const answer = split\.answerBlocks\.length > 0 \|\| isAssistantTruncated\(message\)/);
  assert.match(chatWindow, /const finalProcessMessage = finalViews\?\.process \?\?/);
  assert.match(chatWindow, /const finalAnswerMessage = finalViews\?\.answer \?\? null;/);
  assert.match(chatWindow, /无人值守开启期间失败一律静音/);
  assert.match(chatWindow, /serverUnattended \?\? unattendedRef\.current/);
  assert.doesNotMatch(chatWindow, /continueUiRef/);
  assert.doesNotMatch(chatWindow, /pendingErrorSoundTimerRef/);
  assert.doesNotMatch(chatWindow, /failedPendingRetry/);
});

test("session lists nest forks and injected-context sessions with distinct markers", () => {
  // Both relation types share the tree, but only native parentSessionId gets the fork glyph.
  assert.match(activityPanel, /function buildSessionLineageTree\(items: SessionActivityItem\[\], sort: SortValue\): ActivitySessionNode\[\]/);
  assert.match(activityPanel, /function SessionLineageBranchList\(/);
  assert.match(activityPanel, /const latestByNode = new Map/);
  assert.match(activityPanel, /compareBySort\(childLatest, latest, sort\)/);
  assert.match(activityPanel, /compareBySort\(latestByNode\.get\(left\)!, latestByNode\.get\(right\)!, sort\)/);
  assert.match(activityPanel, /buildSessionLineageTree\(visibleItems, state\.sort\)/);
  assert.match(activityPanel, /buildSessionLineageTree\(visibleItems, filters\.sort\)/);
  assert.match(activityPanel, /lineageParentId\(item\.session\)/);
  assert.match(activityPanel, /resolveAncestor/);
  assert.match(activityPanel, /node\.children\.length > 0/);
  assert.match(activityPanel, /const guideBorder = "1px solid color-mix\(in srgb, var\(--text-dim\) 28%, transparent\)"/);
  assert.doesNotMatch(activityPanel, /const armTop/);
  assert.doesNotMatch(activityPanel, /background: isSidebar \? "var\(--bg-panel\)"/);
  assert.match(activityPanel, /forked=\{Boolean\(item\.session\.parentSessionId\)\}/);
  assert.match(activityPanel, /contextInjected=\{Boolean\(item\.session\.contextSourceSessionId\)\}/);
  assert.match(activityPanel, /contextInjected=\{Boolean\(hit\.contextSourceSessionId\)\}/);
  assert.match(activityPanel, /sessionActivity\.forkedSession/);
  assert.match(activityPanel, /sessionActivity\.contextInjectedSession/);
  assert.match(activityPanel, /buildSessionLineageTree\(visibleItems, state\.sort\)/);
  assert.match(sessionSidebar, /lineageParentId\(s\)/);
  assert.match(sessionSidebar, /session\.contextSourceSessionId && \(\n/);
  assert.match(sessionSidebar, /session\.parentSessionId \|\| \(!session\.contextSourceSessionId && depth > 0\)/);
  assert.match(zhCN, /"sessionActivity\.forkedSession"/);
  assert.match(zhCN, /"sessionActivity\.contextInjectedSession"/);
  assert.match(zhCN, /"sessionActivity\.expandBranch"/);
  assert.match(en, /"sessionActivity\.contextInjectedSession"/);
  assert.match(en, /"sessionActivity\.expandBranch"/);
  assert.match(activityPanel, /branchCollapsed/);
  assert.match(activityPanel, /sessionActivity\.expandBranch/);
  assert.match(activityPanel, /sessionActivity\.collapseBranch/);
});

test("session lineage preserves hierarchy across missing intermediate nodes", () => {
  // 当中间节点被归档或被过滤时，子孙节点向上查到最近可用祖先，不突兀变成孤儿
  assert.match(activityPanel, /const knownSessionParents = new Map<string, string>\(\)/);
  assert.match(activityPanel, /function registerSessionLineage\(/);
  assert.match(activityPanel, /for \(const \[key, parentKey\] of knownSessionParents\) \{\s*parentOf\.set\(key, parentKey\);\s*\}/);
  assert.match(sessionRunsRoute, /resolveNearestLineageAncestorAsync/);
  assert.match(sessionRunsRoute, /getStoredParentSessionId/);
  assert.match(sessionRunsRoute, /session\.parentSessionId = nearest/);
});

test("favorites page mirrors aggregate controls and supports archive/delete", () => {
  assert.match(activityPanel, /type ActivityScope = "local" \| "all" \| "hidden" \| "favorites"/);
  assert.match(activityPanel, /const FAVORITES_PAGE_VALUE = "__favorites_page__"/);
  assert.match(activityPanel, /<Star size=\{12\}/);
  assert.match(activityPanel, /activityScope === "favorites"[\s\S]{0,400}"&scope=favorites"/);
  assert.doesNotMatch(activityPanel, /allowDelete=\{activityScope !== "favorites" && activityScope !== "hidden"\}/);
  assert.doesNotMatch(activityPanel, /archiveLocked=\{activityScope === "hidden"\}/);
  assert.doesNotMatch(archiveRoute, /favorite_removal_required|hidden_removal_required|isSessionFavorite\(id\)|isSessionHidden\(filePath, id\)/);
  assert.match(activityPanel, /onOpenFavorites\?: \(\) => void/);
  assert.match(activityPanel, /const collectionGroupOption = \{ value: "__group_collection__"/);
  assert.match(activityPanel, /collectionPageGroup/);
  assert.match(activityPanel, /collectionOptions = \[/);
  assert.doesNotMatch(activityPanel, /favoritesGroupOption/);
  assert.match(zhCN, /"sessionActivity\.collectionPageGroup": "收纳"/);
  assert.match(en, /"sessionActivity\.collectionPageGroup": "Collections"/);
  assert.match(appShell, /const \[favoritesView, setFavoritesView\] = useState\(false\)/);
  assert.match(appShell, /collectionScope = hiddenView \? "hidden" : "favorites"/);
  assert.match(appShell, /params\.get\("scope"\) === "favorites"/);
  assert.match(sessionRunsRoute, /scope === "favorites"/);
  assert.match(sessionRunsRoute, /scopeQuery = scope === "hidden"[\s\S]*favorites/);
  assert.doesNotMatch(idRoute, /favorite_removal_required|hidden_removal_required|isSessionFavorite\(id\)/);
  assert.match(idRoute, /setFavorite\(id, false\)/);
  assert.match(activityPanel, /onFavorite=\{\(\) => activity\.setFavorite\(hit\.id, true, hit\.device\?\.id\)\}/);
  assert.match(activityPanel, /onUnfavorite=\{\(\) => activity\.setFavorite\(hit\.id, false, hit\.device\?\.id\)\}/);
});

test("session hover actions keep inline edit and move collections/subprojects to context menu", () => {
  assert.match(activityPanel, /const \[contextMenuPoint, setContextMenuPoint\] = useState/);
  assert.match(activityPanel, /<Pencil size=\{12\}/);
  assert.match(activityPanel, /data-session-id=\{item\.session\.id\}/);
  assert.match(activityPanel, /setName\(item\.session\.name \?\? \"\"\); setEditing\(true\);/);
  assert.match(activityPanel, /item\.session\.archived \? t\("sessionActivity\.restore"\) : t\("sessionActivity\.archive"\)/);
  assert.match(activityPanel, /t\("sessionActivity\.delete"\)/);
});

test("session context menu includes subprojects first, collections, and closes on outside click", () => {
  assert.match(sessionContextMenu, /t\("sessionActivity\.moveToSubproject"\)/);
  assert.match(sessionContextMenu, /t\("sessionActivity\.toDiscuss"\)/);
  assert.match(sessionContextMenu, /t\("sessionActivity\.toRevise"\)/);
  assert.match(sessionContextMenu, /t\("sessionActivity\.completed"\)/);
  assert.match(sessionContextMenu, /document\.addEventListener\("pointerdown", closeOnPointerDown, true\)/);
  assert.match(sessionContextMenu, /document\.addEventListener\("contextmenu", closeOnContextMenu, true\)/);
  assert.match(sessionContextMenu, /document\.addEventListener\("focusin", closeOnFocusIn\)/);
  assert.match(sessionContextMenu, /window\.addEventListener\("blur", closeOnWindowBlur\)/);
});

test("worktree context menu closes on outside click, blur, focusin, and contextmenu", () => {
  assert.match(worktreeBuckets, /function WorktreeContextMenu/);
  assert.match(worktreeBuckets, /document\.addEventListener\("pointerdown", closeOnPointerDown, true\)/);
  assert.match(worktreeBuckets, /document\.addEventListener\("contextmenu", closeOnContextMenu, true\)/);
  assert.match(worktreeBuckets, /document\.addEventListener\("focusin", closeOnFocusIn\)/);
  assert.match(worktreeBuckets, /window\.addEventListener\("blur", closeOnWindowBlur\)/);
  assert.match(worktreeBuckets, /document\.addEventListener\("keydown", closeOnKeyDown\)/);
});

test("device filter lists devices in config order, default stays all", () => {
  // 设备下拉按服务端（本机配置 order 字段）给出的顺序展示；默认值仍为 "all"。
  // 选项从 devices 顺序构建（deviceOptions 常量，含隐藏页/添加/隐藏设备等收纳入口）。
  assert.match(activityPanel, /const deviceOptions = devices\.map\(\(device\) =>/);
  assert.doesNotMatch(activityPanel, /\.\.\.\[\.\.\.devices\]\.reverse\(\)\.map/);
  assert.match(activityPanel, /\{ value: "all", label:/);
});

test("all activity device selectors expose add-device and hide-device actions", () => {
  const selectors = [...activityPanel.matchAll(/<ActivityDeviceFilter\b[\s\S]*?\/>/g)].map(([selector]) => selector);
  assert.equal(selectors.length, 3);
  for (const selector of selectors) {
    assert.match(selector, /\bshowAddDevice\b/);
    assert.match(selector, /\bonHideDevice=\{/);
  }
  const panelMain = activityPanel.slice(activityPanel.indexOf("export function SessionActivityPanel"), activityPanel.indexOf("interface SessionActivitySidebarProps"));
  assert.match(panelMain, /onHideDevice=\{\(device\) => void activity\.setHidden\("device", device\.id, true, device\.id\)\}/);
  assert.match(activityPanel, /const onHideDevice = useCallback\(\(device: SessionActivityDevice\) => \{\s*void activity\.setHidden\("device", device\.id, true, device\.id\);/);
});

test("hidden page switch: scope change clears stale sessions but preserves device roster; hide-device popover closes outside click", () => {
  // 点「隐藏页」时清掉旧会话，保留设备 roster，避免慢请求期间设备筛选器消失。
  assert.match(activityPanel, /stateKeyRef\.current !== stateKey\) return;/);
  assert.match(activityPanel, /const previous = activityDataRef\.current;[\s\S]*?scope: activityScope,[\s\S]*?sessions: \[\],/);
  assert.doesNotMatch(activityPanel, /activityDataRef\.current = null;/);
  // 无周期轮询：即时性由事件通道承担（seq 游标续传 + 缓冲回放），轮询是冗余。
  assert.doesNotMatch(activityPanel, /REFRESH_MS/);
  assert.doesNotMatch(activityPanel, /setInterval\(\(\) => void refresh\(\)\)/);
  assert.match(activityPanel, /if \(refreshInFlightRef\.current === stateKey\) \{[\s\S]*await refreshPromiseRef\.current/);
  assert.match(activityPanel, /if \(ok\) await refresh\(deviceId, true\)/);
  // 「隐藏设备…」弹层必须有外部点击关闭（与添加设备共用容器 ref 监听）。
  assert.match(activityPanel, /if \(!addOpen && !hideOpen\) return;/);
  assert.match(activityPanel, /setAddOpen\(false\);\n        setHideOpen\(false\);/);
  assert.match(activityPanel, /\}, \[addOpen, hideOpen\]\);/);
});

test("storage-page deletion clears markers after the operation", () => {
  assert.doesNotMatch(idRoute, /isSessionFavorite\(id\)|isSessionHidden\(filePath, id\)|favorite_removal_required|hidden_removal_required/);
  assert.match(idRoute, /clearSessionHidden\(id\)/);
  assert.match(idRoute, /setFavorite\(id, false\)/);
  assert.doesNotMatch(activityPanel, /archiveLocked/);
  assert.doesNotMatch(activityPanel, /allowDelete=\{activityScope !== \"favorites\" && activityScope !== \"hidden\"\}/);
});

test("hidden page entry: distinct shelf/action icons, grouped options, session-compatible URL", () => {
  // 隐藏页（收纳视图）与隐藏设备（动作）用不同图标+分组，避免「页面 vs 动作」混淆。
  assert.match(activityPanel, /<Archive size=\{12\}/);
  assert.match(activityPanel, /<MonitorOff size=\{12\}/);
  assert.match(activityPanel, /kind: "group" as const/);
  // 隐藏页内点会话不退出隐藏页：URL 保持 scope=hidden 并携带 monitor/device/session。
  // 隐藏页与聚合页同构：完整 filter（monitor 可用）+ 侧栏控件保留 + 搜索走隐藏域。
  assert.match(appShell, /data-activity-sidebar-toggle=\{id === "sessions" \? "true" : undefined\}/);
  assert.match(appShell, /fixedConversationSidebarVisible/);
  assert.doesNotMatch(activityPanel, /if \(hiddenView\) return select;/);
  assert.match(activityPanel, /activityScope === "hidden"[\s\S]{0,400}"&scope=hidden"/);
  assert.match(activityPanel, /activityScope === "favorites"[\s\S]{0,400}"&scope=favorites"/);
  assert.match(activityPanel, /activityScope !== "all"[\s\S]{0,400}"&scope=all"/);
  assert.match(activityPanel, /{!headerOnly && \(/);
  // 进隐藏页 = 聚合总览（monitor off）；点会话才进聚合完整视图。
  assert.match(appShell, /if \(\(aggregateWorkspaceActive \|\| hiddenView \|\| favoritesView \|\| isMobileViewport\(\) \|\| aggregateDeviceScope\) && !embeddedReaderMode\) \{/);
  // 搜索路由：scope=hidden 只返回隐藏会话（selectHiddenSessions 与 filterHiddenSessions 互逆）。

  assert.match(appShell, /next\.set\("scope", collectionScope\)/);
  assert.match(appShell, /if \(collectionScope && !sessionParam\)/);
  assert.match(appShell, /params\.get\("scope"\) === "hidden" \|\| params\.get\("scope"\) === "favorites"/);
  assert.match(appShell, /\/api\/session-runs\?scope=\$\{hiddenScope \? "hidden" : "favorites"\}/);
  // 项目隐藏必须传纯 projectKey（组合键含设备 id，与过滤端 isHidden 的 key 不匹配会静默失效）。
  assert.match(activityPanel, /setHidden\("project", project\.projectKey, hidden, project\.deviceId\)/);

  // 隐藏页会话恢复走 scope=hidden 数据源反查（隐藏会话不在 /api/sessions 列表）。
  assert.match(appShell, /candidate\.session\.id === sessionParam/);
  // 单设备完整视图（deviceSwitchOnly 下拉）也提供隐藏页入口。
  assert.match(activityPanel, /if \(deviceSwitchOnly\) return \([\s\S]*?onOpenHidden=\{onOpenHidden\}/);
});

test("hidden-page sessions can leave inherited project hiding", () => {
  // Hidden project membership is inherited by default, but a child session can
  // opt out through the same hidden-page action in both activity surfaces.
  assert.match(activityPanel, /onHide=\{activityScope !== "hidden"/);
  assert.match(activityPanel, /onUnhide=\{activityScope === "hidden" \? \(\) => void activity\.setHidden\(\"session\", item\.session\.id, false, item\.device\.id\)/);
  assert.match(activityPanel, /onUnhide=\{activityScope === "hidden" \? \(\) => void activity\.setHidden\(\"session\", hit\.id, false, hit\.device\?\.id\)/);
  assert.match(activityPanel, /onUnhide=\{onUnhide\}/);
});

test("reader explorer auto-reveals active file and expands its parent path", () => {
  assert.match(fileExplorer, /locateFile: \(filePath: string\) => void/);
  assert.match(fileExplorer, /setLocatedPath\(normalized\)/);
  assert.match(fileExplorer, /expandPath\(getFileDirectory\(normalized\)\)/);
  assert.match(fileExplorer, /scrollIntoView\(\{ block: "nearest" \}\)/);
  assert.match(explorerSection, /activeFilePath\?: string \| null/);
  assert.match(explorerSection, /autoLocateKeyRef/);
  assert.match(explorerSection, /handleLocateActiveFile\(\)/);
  assert.doesNotMatch(explorerSection, /files\.locateCurrentFile/);
  assert.match(sessionSidebar, /activeFilePath=\{activeFilePath\}/);
  assert.match(appShell, /activeFilePath=\{activeFilePath\}/);
});

test("keeps file @ references available on every Reader file surface", () => {
  assert.match(fileExplorer, /title=\{t\("files\.insertPath"\)\}/);
  assert.match(explorerSection, /!node\.isDir && onAtMention && \(/);
  assert.match(explorerSection, /onAtMention=\{onAtMention\}/);
  assert.match(explorerSection, /onAtMentions=\{onAtMentions\}/);
  assert.doesNotMatch(explorerSection, /disableAtMention/);
  assert.doesNotMatch(sessionSidebar, /atMentionDisabled|disableAtMention/);
  assert.doesNotMatch(appShell, /disableAtMention|atMentionDisabled/);
  assert.match(appShell, /onAtMention=\{handleAtMention\}/);
  assert.match(appShell, /onAtMentions=\{handleAtMentions\}/);
});

test("aggregate content search preserves device scope and highlight navigation", () => {
  assert.match(activityPanel, /state\.device === "all"/);
  assert.match(activityPanel, /filters\.device === "all"/);
  assert.match(activityPanel, /&scope=local&device=\$\{encodeURIComponent\(filters\.device\)\}/);
  assert.match(activityPanel, /scope=hidden&device=/);
  assert.match(activityPanel, /scope=favorites&device=/);
  assert.match(activityPanel, /device\?\.id \?\? "local"/);
  assert.match(activityPanel, /onOpenSession: handleOpenSession/);
  assert.match(activityPanel, /onOpenSession\(item, searchTerm, filters\.device\)/);
  assert.match(activityPanel, /hit\.contentMatchCount > 0 \? searchQuery\.trim\(\) : undefined/);
  assert.match(sessionSidebar, /row\.session\.contentMatchCount > 0 \? searchQuery\.trim\(\) : undefined/);
  assert.doesNotMatch(activityPanel, /function searchHitHasContentMatch/);
  assert.doesNotMatch(sessionSidebar, /function searchHitHasContentMatch/);
  assert.match(searchRoute, /countQueryInSessionFile/);
  assert.match(searchRoute, /titleMatchCount/);
  assert.match(searchRoute, /idMatches = ordered\.filter/);
  assert.match(appShell, /function withSearchHighlight\(url: string, searchTerm\?: string \| null\)/);
  assert.match(appShell, /function applyActivityArchiveView\(target: URL\)/);
  assert.match(appShell, /withSearchHighlight\(url, searchTerm\)/);
  assert.match(appShell, /withSearchHighlight\(embeddedUrl, searchTerm\)/);
});

test("activity content search follows selected time range", () => {
  assert.match(activityPanel, /&days=\$\{encodeURIComponent\(state\.days\)\}/);
  assert.match(activityPanel, /&days=\$\{encodeURIComponent\(filters\.days\)\}/);
  assert.match(activityPanel, /\[activityScope, searchQuery, state\.archiveView, state\.days, state\.device, searchNonce, t\]/);
  assert.match(activityPanel, /\[activityScope, filters\.archiveView, filters\.days, filters\.device, searchQuery, searchNonce, t\]/);
});

test("activity search follows active device/project/status filters", () => {
  assert.match(activityPanel, /const visibleSearchResults = filterSearchResults\(/);
  assert.match(activityPanel, /matchesActivityDevice\(item\.device\.id, filters\.device, activityScope\)/);
  assert.match(activityPanel, /filters\.project\.length > 0/);
  assert.match(activityPanel, /filters\.status !== "all" && item\.status !== filters\.status/);
  assert.match(activityPanel, /matched\.sort\(\(a, b\) => \{[\s\S]*?Boolean\(a\.hit\.idMatch\)[\s\S]*?compareBySort\(a\.item, b\.item, filters\.sort\)/);
  assert.match(activityPanel, /SessionSearchMatchFilterSelect/);
  assert.match(activityPanel, /searchLabels/);
  assert.match(sessionSidebar, /sessionSearchResultMatchesFilter/);
  assert.match(sessionSidebar, /SessionSearchMatchFilterSelect/);
});


test("explicit full-device views embed while ordinary local drafts use the local slot", () => {
  assert.match(appShell, /const handleChangeActivityDevice = useCallback\(\(device: SessionActivityDevice \| null\) =>/);
  assert.match(appShell, /buildEmbeddedReaderUrl\(device, \{ localDeviceId, activitySidebar: true \}\)/);
  assert.match(appShell, /if \(!device \|\| device\.id === localDeviceId \|\| embeddedReaderMode\) \{\s*handleNewSession\(`activity-\$\{Date\.now\(\)\}`, cwd, subprojectId, subprojectLabel, options\);/);
});

test("embedded session clicks follow device identity and keep activity-sidebar param", () => {
  assert.match(appShell, /if \(isRemoteSession\)/);
  assert.match(appShell, /const isLocalSession = item\.device\.id === localDeviceId;/);
  assert.match(appShell, /if \(isLocalSession\)/);
  // router.replace 前保留 piWebActivitySidebar，重挂载不退回原始文件目录侧栏。
  assert.match(appShell, /searchParams\.get\(EMBEDDED_ACTIVITY_SIDEBAR_PARAM\) === "1"\) target\.searchParams\.set\(EMBEDDED_ACTIVITY_SIDEBAR_PARAM, "1"\)/);
  // 内层转发会话 → 聚合形态，恢复外层聚合侧栏。
  assert.match(appShell, /setEmbeddedDeviceWorkspaceActive\(false\); \/\/ 内层转发会话 = 聚合形态/);
});



test("aggregate remote sessions keep top-bar status and right-side toggles", () => {
  assert.match(appShell, /const topBarSessionActive = showChat \|\| Boolean\(remoteSession\)/);
  assert.match(appShell, /const topBarSession = remoteSession \? remoteSession\.sessionInfo : selectedSession/);
  assert.match(appShell, /<SessionTopBarStats\s+sessionActive=\{topBarSessionActive\}\s+sessionStats=\{sessionStats\}\s+contextUsage=\{contextUsage\}/s);
  assert.match(topBarSource, /if \(!sessionActive \|\| \(!sessionStats && !contextUsage\)\) return null;/);
  assert.match(appShell, /topBarSessionActive && \(\n\s*<div style=\{\{ display: "flex", alignItems: "stretch", height: "100%" \}\}>/);
  // Keep enough room for the optional selection-action toolbar in the shared ChatWindow header.
  assert.match(appShell, /remotePeer=\{remoteSession\.device\.id\}/);
  assert.match(appShell, /onContextUsageChange=\{reportContextUsageChange\}/);
  assert.match(appShell, /const route = `\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/auto-name`/);
  assert.match(appShell, /`\/api\/remote\$\{route\}\?peer=\$\{encodeURIComponent\(topBarPeer\)\}`/);
});

test("aggregate remote new sessions stay in the outer ChatWindow", () => {
  const start = appShell.indexOf("const handleNewActivitySession");
  const end = appShell.indexOf("// 嵌入页收到外层活动面板", start);
  assert.ok(start >= 0 && end > start);
  const handler = appShell.slice(start, end);
  // Monitor off has no loaded iframe, so remote project new-session must use
  // the same in-place remote draft path as Monitor on.
  assert.match(handler, /if \(!device \|\| device\.id === localDeviceId \|\| embeddedReaderMode\)/);
  assert.match(handler, /if \(aggregateWorkspaceActive \|\| isMobileViewport\(\) \|\| !embeddedReaderUrl\)/);
  assert.match(handler, /setRemoteSession\(\{ device, sessionInfo: null, searchTerm: null/);
  assert.match(handler, /sessionRunning: false/);
  assert.match(handler, /newSessionContextSourceId: options\?\.contextSourceSessionId \?\? null/);
  assert.ok(handler.indexOf("setRemoteSession({ device") < handler.indexOf("const remoteUrl = buildEmbeddedReaderUrl(device, { localDeviceId, sessionOnly: true })"));
  // A remote draft must render without promoting Monitor off to aggregateWorkspaceActive.
  assert.match(appShell, /: \(aggregateWorkspaceActive \|\| remoteSession\) && !embeddedReaderUrl \? \(/);
});

test("remote ChatWindow keeps extension status shelf visible", () => {
  assert.equal((chatWindow.match(/!remotePeer && <ExtensionStatusBar/g) ?? []).length, 0);
  assert.equal((chatWindow.match(/<ExtensionStatusBar statuses=\{extensionStatuses\} widgets=\{extensionWidgets\} sessionId=\{session\?\.id\} remotePeer=\{remotePeer\} \/>/g) ?? []).length, 2);
});

test("reader mode keeps only the target file explorer in aggregate activity mode", () => {
  assert.match(appShell, /const sidebarContent = ([\s\S]{0,120}\{activitySidebarMode \? \()/);
  assert.match(appShell, /display: activitySidebarContainerVisible \? "flex" : "none"/);
  assert.doesNotMatch(appShell, /\{sessionListOpen && \(\s*<SessionActivitySidebar/);
  assert.match(appShell, /<ExplorerSection[\s\S]{0,400}readerMode=\{readerMode\}/);
  assert.match(appShell, /open=\{explorerSectionOpen\}/);
  assert.ok(appShell.includes('flex: explorerSectionOpen ? "1 1 0" : "0 0 auto"'));
  assert.match(sessionSidebar, /display: sessionsOpen && !readerMode \? "flex" : "none"/);
});

test("top bar hides recap controls and exposes branch and sidekick controls", () => {
  assert.match(appShell, /useSessionDetails/);
  assert.match(appShell, /topBarSessionVersion[\s\S]{0,320}modelConfigRevision: modelsRefreshKey/);
  assert.match(agentSession, /sessionDetailsVersion[\s\S]{0,320}modelConfigRevision: modelsRefreshKey/);
  assert.match(appShell, /loadPreview: false/);
  assert.doesNotMatch(appShell, /questionsSinceRecap/);
  assert.doesNotMatch(appShell, /handleTopBarRecap/);
  assert.doesNotMatch(appShell, /sessionActivity\.recapRun/);
  assert.match(worktreeShell, /<BranchNavigator/);
  assert.match(appShell, /<AppShellWorktreeBranchNavigator/);
  assert.match(appShell, /hasSession=\{Boolean\(topBarSession\)\}/);
  assert.match(appShell, /hideInlineButton=\{!topBarSession\}/);
  assert.match(appShell, /sidekickOpen/);
  assert.match(appShell, /MessageSquare/);
});

test("activity top action opens project picker without changing project-session actions", () => {
  assert.match(activityPanel, /<NewProjectButton onRefresh=\{activity\.refresh\} remotePeer=\{remotePeer\} \/>/);
  assert.equal((activityPanel.match(/<NewProjectButton onRefresh=\{activity\.refresh\} remotePeer=\{remotePeer\} \/>/g) ?? []).length, 2);
  assert.match(activityPanel, /import \{ DirectoryPicker \} from "\.\/DirectoryPicker"/);
  assert.match(activityPanel, /remotePeer \? `\/api\/remote\/projects\?peer=\$\{encodeURIComponent\(remotePeer\)\}` : "\/api\/projects"/);
  assert.match(activityPanel, /method: "POST"/);
  assert.match(activityPanel, /<FolderPlus size=\{14\}/);
  assert.match(activityPanel, /function ActivityNewSessionButton/);
  assert.match(activityPanel, /<MessageSquarePlus size=\{14\}/);
  assert.match(activityPanel, /onNewSession\?\.\(cwd, device(?:, subprojectId, subprojectLabel)?\)/);
  assert.doesNotMatch(activityPanel, /newSessionPickerOpen/);
  assert.doesNotMatch(activityPanel, /handleNewSessionClick/);
  assert.match(zhCN, /"sessionActivity\.newProject": "新建项目"/);
  assert.match(en, /"sessionActivity\.newProject": "New project"/);
});

test("activity grouping follows device scope", () => {
  assert.match(activityPanel, /function normalizeActivityFilterScope/);
  assert.match(activityPanel, /setState\(\(current\) => normalizeActivityFilterScope\(\{ \.\.\.current, \.\.\.patch \}\)\)/);
  assert.match(activityPanel, /showProjectDeviceGroups = activityScope === "all" && filters\.device === "all"/);
  assert.match(activityPanel, /kind: "group" as const/);
  assert.match(activityPanel, /activityScope === "all" && state\.device === "all"/);
  assert.match(activityPanel, /activityScope === "all" && filters\.device === "all"/);
  assert.doesNotMatch(activityPanel, /showProjectDeviceSuffix/);
  assert.match(activityPanel, /activityScope === "local" && state\.group === "device"/);
  assert.match(activityPanel, /activityScope === "local" && filters\.group === "device"/);
});

test("full-device iframe sidebar state is local to the iframe", () => {
  assert.match(appShell, /const EMBEDDED_LAYOUT_STATE_EVENT = "pi-web:layout-state"/);
  assert.match(appShell, /const readEmbeddedLayoutState =/);
  assert.match(appShell, /const handleEmbeddedLayoutMessage = useCallback/);
  assert.match(appShell, /setEmbeddedExplorerTakesLeftLayout\(takesLeftLayout\)/);
  assert.match(appShell, /window\.addEventListener\("message", handleEmbeddedLayoutMessage\)/);
  assert.match(appShell, /event\.source !== embeddedIframeRef\.current\?\.contentWindow/);
  assert.doesNotMatch(appShell, /setSidebarOpen\(data\.open\)/);
});

test("full-device Explorer ownership releases parent left slot and parent Reader keeps Explorer", () => {
  assert.match(appShell, /const shouldParentYieldLeftLayout =/);
  assert.match(appShell, /const deriveEmbeddedLeftSlotState =/);
  assert.match(appShell, /const embeddedExplorerOwnsLeftLayout = embeddedLeftSlotState\.ownsLeftLayout/);
  assert.match(appShell, /const sidebarShellOpen = embeddedLeftSlotState\.sidebarShellOpen \|\| mobileFullDeviceSelectorVisible/);
  assert.match(appShell, /embeddedLeftSlotState\.mobileBackdropVisible/);
  const sidebarStart = appShell.indexOf('id="session-sidebar"');
  const sidebarEnd = appShell.indexOf("{sidebarContent}", sidebarStart);
  assert.ok(sidebarStart >= 0 && sidebarEnd > sidebarStart);
  const sidebar = appShell.slice(sidebarStart, sidebarEnd);
  assert.match(sidebar, /embeddedExplorerOwnsLeftLayout \? \{[\s\S]{0,180}display: "none"/);
  assert.match(appShell, /const shouldShowEmbeddedDeviceSwitch =/);
  assert.match(sidebar, /shouldShowEmbeddedDeviceSwitch\(\{[\s\S]{0,240}takesLeftLayout: embeddedExplorerTakesLeftLayout/);
  assert.match(sidebar, /pointerEvents: "auto"/);
  assert.match(appShell, /const shouldRenderExplorerSection =/);
  assert.match(appShell, /const explorerSectionRendered = !embeddedDeviceWorkspaceActive && shouldRenderExplorerSection\(\{/);
  assert.match(appShell, /explorerSectionRendered &&/);
  assert.match(appShell, /mobileBackdropVisible: isMobile && sidebarOpen && !ownsLeftLayout/);
});

test("full-device device selector stays outside fixed sidebar visibility gate", () => {
  assert.match(appShell, /const handleChangeActivityDevice = useCallback/);
  assert.match(appShell, /setEmbeddedDeviceWorkspaceActive\(true\)/);
  assert.match(appShell, /setEmbeddedDeviceId\(device\.id\)/);
  assert.match(appShell, /shouldShowEmbeddedDeviceSwitch\(\{/);
  assert.match(appShell, /takesLeftLayout: embeddedExplorerTakesLeftLayout/);
  assert.match(appShell, /width: activityDeviceOverlayWidth/);
  assert.match(appShell, /pointerEvents: "auto"/);
  assert.doesNotMatch(appShell, /shouldShowEmbeddedDeviceSwitch\([\s\S]{0,240}sidebarShellOpen/);
});

test("mobile full-device selector remains a physical recovery overlay after backdrop close", () => {
  assert.match(appShell, /const mobileFullDeviceSelectorVisible = isMobile[\s\S]{0,260}embeddedDeviceWorkspaceActive[\s\S]{0,260}!rightPanelOpen[\s\S]{0,220}!embeddedFileViewerOpen/);
  assert.match(appShell, /const activitySidebarContainerVisible = mobileFullDeviceSelectorVisible \|\| shouldShowActivitySidebarContainer/);
  const sidebarStart = appShell.indexOf('id="session-sidebar"');
  const sidebarEnd = appShell.indexOf("{sidebarContent}", sidebarStart);
  assert.ok(sidebarStart >= 0 && sidebarEnd > sidebarStart);
  const sidebar = appShell.slice(sidebarStart, sidebarEnd);
  assert.match(sidebar, /mobileFullDeviceSelectorVisible \? \{[\s\S]{0,520}position: "fixed"[\s\S]{0,520}pointerEvents: "auto"[\s\S]{0,520}transform: "none"[\s\S]{0,520}zIndex: 300/);
  assert.match(appShell, /sidebarShellOpen && !mobileFullDeviceSelectorVisible && !chatOnlyMode/);
  assert.match(appShell, /display: activitySidebarContainerVisible \? "flex" : "none"/);
});

test("device plus session URL shape keeps full-device activity-sidebar restore distinct from session-only", () => {
  assert.match(appShell, /const embeddedWorkspaceUrlShape =/);
  assert.match(appShell, /const workspaceShape = embeddedWorkspaceUrlShape\(params\)/);
  assert.match(appShell, /const fullDeviceSession = workspaceShape === "full-device"/);
  assert.match(appShell, /Boolean\(sessionId\) && !fullDeviceSession/);
  assert.match(appShell, /fullDeviceSession \|\| !sessionId/);
  assert.match(appShell, /if \(sessionId && !fullDeviceSession\) \{/);
  assert.match(appShell, /else if \(fullDeviceSession\) \{/);
  assert.match(appShell, /if \(fromEmbeddedIframe\) next\.set\(EMBEDDED_ACTIVITY_SIDEBAR_PARAM, "1"\)/);
});

test("full-device activity identity binds embedded cwd to current peer", () => {
  assert.match(appShell, /const resolveEmbeddedContextCwd =/);
  assert.match(appShell, /const resolveActiveFileCwd =/);
  assert.match(appShell, /resourceSession && resourceSession\.deviceId === activePeer && resourceSession\.cwd/);
  assert.match(appShell, /activeFilePeer && activeFilePeer === activePeer/);
  assert.match(appShell, /tabPeer !== activePeer \|\| tabPeer !== remoteSessionPeer/);
  assert.match(appShell, /const activeFileCwd = resolveActiveFileCwd\(\{/);
  const peerStart = appShell.indexOf("const activePeerId =");
  const peerEnd = appShell.indexOf("// One activity identity", peerStart);
  assert.ok(peerStart >= 0 && peerEnd > peerStart);
  const peerSource = appShell.slice(peerStart, peerEnd);
  assert.ok(peerSource.indexOf("embeddedDeviceId") < peerSource.indexOf("remoteSession?.device.id"), "full-device peer must prefer selected device");
  assert.match(appShell, /activeFileTabPeerRef\.current = activeFileTab\?\.remotePeer \?\? null/);
});

test("big activity panel shows all devices in shell, local in embedded pages; cross-device clicks relay to shell", () => {
  // 外层壳大面板恒为全部设备聚合；嵌入页（完整设备视图）内大面板只显示本机
  // （activityScope local），避免出现“当前设备”/其他设备选项。
  assert.match(appShell, /const EMBEDDED_OPEN_SESSION_EVENT = "pi-web:open-session"/);
  assert.match(appShell, /type: EMBEDDED_OPEN_SESSION_EVENT,\n\s*device: item\.device,/);
  assert.match(appShell, /const openRemoteSession = useCallback/);
  assert.match(appShell, /data\?\.type !== EMBEDDED_OPEN_SESSION_EVENT/);
  assert.match(appShell, /openRemoteSession\([\s\S]{0,100}data\.device,\s*data\.sessionId,/);
  const lines = appShell.split("\n");
  const sidebarIdx = lines.findIndex((line) => line.includes("<SessionActivitySidebar"));
  const panelIdx = lines.findIndex((line) => line.includes("<SessionActivityPanel"));
  assert.ok(sidebarIdx >= 0 && lines.slice(sidebarIdx, sidebarIdx + 15).some((line) => line.includes("activityScope=")), "sidebar has activityScope");
  assert.ok((appShell.match(/activityScope=\{hiddenView \? "hidden" : favoritesView \? "favorites" : embeddedReaderMode \? "local" : "all"\}/g) || []).length >= 1, "sidebar keeps local scope in embedded mode and collection scopes in shell");
  assert.ok(panelIdx >= 0 && lines.slice(panelIdx, panelIdx + 3).some((line) => line.includes("activityScope={embeddedReaderMode ? \"local\" : hiddenView ? \"hidden\" : favoritesView ? \"favorites\" : \"all\"}")), "big panel keeps local scope in embedded mode and collection scopes in shell");
  assert.doesNotMatch(explorerSection, /<span>.*files\.readerTitle/);
  assert.match(zhCN, /"files\.readerTitle": "文件"/);
  assert.match(en, /"files\.readerTitle": "Files"/);
});

test("all-device activity clicks keep aggregate shell scope", () => {
  assert.match(appShell, /const aggregateDeviceScope = deviceFilter === undefined \|\| deviceFilter === "all"/);
  assert.match(appShell, /setEmbeddedScopeAll\(aggregateDeviceScope\)/);
  assert.match(appShell, /aggregateWorkspaceActive \|\| hiddenView \|\| favoritesView \|\| isMobileViewport\(\) \|\| aggregateDeviceScope/);
});

test("same-device ready iframes open sessions in place with a reload fallback", () => {
  assert.ok(appShell.includes('const EMBEDDED_OPEN_SESSION_REQUEST_EVENT = "pi-web:open-session-request";'));
  assert.ok(appShell.includes("embeddedIframeReadyRef.current"));
  assert.ok(appShell.includes("type: EMBEDDED_OPEN_SESSION_REQUEST_EVENT"));
  assert.ok(appShell.includes("session: item.session"));
  assert.ok(appShell.includes("data?.type !== EMBEDDED_OPEN_SESSION_REQUEST_EVENT"));
  assert.ok(appShell.includes("handleSelectSession(session, false"));
  assert.ok(appShell.includes("fallbackToEmbeddedSession"));
});

test("resource toolbar owner follows embedded workspace shape", () => {
  // session-only iframe 由外层侧栏承载资源入口；单设备完整 iframe 自己承载，
  // 这样两种形态都只有一套资源入口，不会出现左下悬浮补丁。
  assert.match(appShell, /const EMBEDDED_RESOURCE_TOOLBAR_PARAM = "piWebResourceToolbar"/);
  assert.match(appShell, /if \(sessionOnly\) \{[\s\S]{0,180}target\.searchParams\.set\(EMBEDDED_RESOURCE_TOOLBAR_PARAM, EMBEDDED_RESOURCE_TOOLBAR_OWNER\)/);
  assert.match(appShell, /else \{[\s\S]{0,180}target\.searchParams\.delete\(EMBEDDED_RESOURCE_TOOLBAR_PARAM\)/);
  assert.match(appShell, /const resourceToolbarOwnedByParent = embeddedReaderMode/);
  // resource cwd/peer/session identity now comes from the production workspace
  // resolver; its behavior is exercised by AppShell.reader-mode.test.mjs.
  assert.match(appShell, /const workspaceOwner = resolveWorkspaceOwner\(\{/);
  assert.match(appShell, /const resourceCwd = workspaceOwner\.cwd/);
  assert.match(appShell, /const resourceSessionFile = embeddedReaderUrl[\s\S]{0,220}embeddedResourceSession/);
  assert.match(appShell, /const resourcePeer = workspaceOwner\.remotePeer/);
  assert.match(appShell, /const resourceToolbar = !readerMode && !embeddedWorkspaceExplorerVisible && !resourceToolbarOwnedByParent && !embeddedDeviceWorkspaceActive/);
  assert.doesNotMatch(appShell, /floating=\{embeddedDeviceWorkspaceActive\}/);
  assert.match(appShell, /setEmbeddedResourceSession\(\{ deviceId: item\.device\.id, sessionId: item\.session\.id, cwd: item\.session\.cwd, path: item\.session\.path \}\)/);
  assert.match(appShell, /sessionId=\{resourceSessionId\}/);
  assert.match(appShell, /cwd=\{resourceCwd \?\? undefined\}/);
  assert.match(appShell, /remotePeer=\{resourcePeer\}/);
  assert.match(appShell, /skillsConfigOpen && resourceCwd/);
});



test("resource toolbar exposes models, skills, plugins, and subagents with equal spacing", () => {
  assert.match(appShell, /onOpenAgents=\{\(\) => setSettingsModalTab\("agents"\)\}/);
  assert.match(resourceToolbarSource, /label: t\("common\.agents"\),/);
  assert.doesNotMatch(resourceToolbarSource, /onOpenPrompts/);
  assert.match(resourceToolbarSource, /justifyContent: "space-between",\s*alignItems: "center"/);
});

test("session-only remote workspaces collapse the directory sidebar by default", () => {
  assert.match(appShell, /setSidebarOpen\(\(open\) => \{[\s\S]{0,220}if \(sessionOnlyMode\) return false;/);
  assert.match(appShell, /readerMode=\{readerMode \|\| isEmbeddedSessionOnly\}/);
  assert.match(appShell, /compactReaderMode=\{sidebarOnlyMode\}/);
  assert.match(sessionSidebar, /onEnsureOpen=\{\(\) => setExplorerOpen\(true\)\}/);
});

test("retry_continue falls back to a plain continue prompt when no retry turn exists", () => {
  // 客户端按已加载消息判定可重试，但服务端 live 消息可能已被上次重试剥离或
  // 已产出真实输出：此时降级为发送「继续」消息，不向用户抛
  // "No continue turn is available to retry"。
  assert.match(rpcManager, /No continue turn is available to retry/);
  assert.match(rpcManager, /this\.promptWithDisplayTracking\(\"继续\", \{ source: \"rpc\" \}\)/);
});

test("session creation keeps the embed shape in the URL", () => {
  // 嵌入工作区内新建/派生会话获得真实 id 后，URL 必须保留
  // piWebEmbedded/piWebSessionOnly，否则 iframe 退化成完整 Reader，
  // 内部活动会话侧栏重新出现，与外层聚合列表重复。
  assert.match(appShell, /const workspaceParams = useCallback/);
  assert.match(appShell, /params\.set\("session", session\.id\)/);
  assert.match(appShell, /const params = workspaceParams\(\);\n\s*params\.set\("session", newSessionId\)/);
  assert.match(appShell, /if \(embeddedReaderMode\) params\.set\(EMBEDDED_READER_PARAM, "1"\)/);
  assert.match(appShell, /if \(searchParams\.get\(EMBEDDED_ACTIVITY_SIDEBAR_PARAM\) === "1"\) params\.set\(EMBEDDED_ACTIVITY_SIDEBAR_PARAM, "1"\)/);
});

test("panel filter changes stop the focus-locate reset", () => {
  // 用户手动改过任一筛选后，focus 定位不得再把 device/project/status
  // 重置回全部（否则点项目/状态筛选被立即还原，表现为点击无反应）。
  assert.match(activityPanel, /handledFocusSessionRef\.current = focusSessionId \?\? "adjusted"/);
  assert.match(activityPanel, /if \(handledFocusSessionRef\.current === focusSessionId\) return;/);
});

test("opening a session marks it viewed on every path", () => {
  // 已读标记三路径全覆盖：本机 handleSelectSession 已标；外层切 iframe 嵌入
  // 与嵌入页点异设备会话（postMessage 转发）两条路径也补 markActivitySessionViewed。
  const count = (appShell.match(/markActivitySessionViewed\(item\.session\.id\)/g) || []).length;
  assert.ok(count >= 2, `expected >=2 call sites, got ${count}`);
  assert.match(appShell, /markActivitySessionViewed\(item\.session\.id\);/);
  // 已加载 iframe 的握手路径也必须无条件标记已读（d7c7b6b9 曾改成「仅当前会话相同才标」，
  // 导致 monitor-off 点开不同于当前显示会话的会话时漏标，需点两次才转空闲）。
  assert.doesNotMatch(appShell, /currentEmbeddedSessionId === item\.session\.id\) markActivitySessionViewed/);
  assert.doesNotMatch(appShell, /currentEmbeddedSessionId/);
  // 握手路径不再用 currentEmbeddedSessionId 条件门控，点击会话一律标记已读。
});

test("URL-restore session entry marks it viewed on the viewing device", () => {
  // restoreFromParams 的两种会话显示恢复分支都必须把会话标记已读：
  // 1) monitor-off sessionOnly（?device=X&session=Y&scope=all，无 monitor）：在 if 分支内补 markActivitySessionViewed(sessionId)。
  // 2) monitor-on 远程会话（sessionParam && sessionId && scopeAll）：remotSession 分支补 markActivitySessionViewed(item.session.id)。
  // 修复「monitor-off 经 URL 重进/刷新/换浏览器后《刚处理完》不消失」——聚合视图按查看设备自己的 viewed 裁决。
  assert.match(
    appShell,
    /if \(sessionId && !fullDeviceSession\) \{[\s\S]{0,180}markActivitySessionViewed\(sessionId\);/,
  );
  assert.match(
    appShell,
    /markActivitySessionViewed\(item\.session\.id\);\s*setSelectedSession\(null\);\s*setRemoteSession\(\{ device: item\.device, sessionInfo: item\.session/,
  );
  assert.match(appShell, /\}, \[handleSelectSession, handleInitialRestoreDone, invalidateEmbeddedSessionRequest, localDeviceId, markActivitySessionViewed\]\);/);
  // 标记已读后立即 refresh 活动面板：避免「刚处理完」不刷新就不消失。
  assert.match(
    appShell,
    /const markActivitySessionViewed = useCallback\(\(sessionId: string\) => \{[\s\S]{0,120}mergeActivityViewedAt\(\{ \[sessionId\]: viewedAt \}\);\s*\/\/ 标记已读后立即刷新活动面板/,
  );
});

test("folder toggle collapses the complete Explorer panel", () => {
  assert.match(sessionSidebar, /\{\(selectedCwdProp \|\| selectedCwd\) && explorerOpen && \(/);
  assert.match(appShell, /const setExplorerForContext = useCallback/);
  // Explorer opens from the same verified workspace owner pair; the production
  // resolver/Explorer harness covers remote cwd and missing-cwd behavior.
  assert.match(appShell, /const workspace = options\.workspace \?\? resolveWorkspaceOwner\(\{/);
  assert.match(appShell, /if \(open && !workspace\.cwd\) return;/);
  assert.match(appShell, /embeddedReaderUrl \?/);
  assert.doesNotMatch(appShell, /if \(!open && \(readerMode \|\| sessionOnlyMode \|\| sidebarOnlyMode\)\) setSidebarOpen\(false\)/);
});

test("activity sidebar toggle stays in the activity toolbar", () => {
  assert.match(appShell, /data-activity-sidebar-toggle=\{id === "sessions" \? "true" : undefined\}/);
  assert.match(appShell, /const layoutControls: Record<LayoutControlId/);
  assert.match(appShell, /onClick: handleSidebarToggle/);
  assert.doesNotMatch(activityPanel, /fixedConversationSidebarVisible|onToggleFixedConversationSidebar/);
  assert.match(appShell, /const conversationVisible = fixedConversationSidebarVisible[\s\S]{0,260}sessionListOpen/);
  assert.match(appShell, /updateFixedConversationSidebarVisibility\(!conversationVisible\)/);
  assert.doesNotMatch(appShell.slice(appShell.indexOf("const handleSidebarToggle"), appShell.indexOf("const setExplorerForContext")), /setReaderMode\(false\)/);
});

test("collapsing activity sessions keeps refresh and sound owner mounted", () => {
  const start = appShell.indexOf("const sidebarContent = (");
  const end = appShell.indexOf("// 主区聊天窗口", start);
  assert.ok(start >= 0 && end > start);
  const sidebar = appShell.slice(start, end);
  assert.doesNotMatch(sidebar, /\{sessionListOpen && \([\s\S]{0,220}<SessionActivitySidebar/);
  assert.match(sidebar, /display: activitySidebarContainerVisible \? "flex" : "none"/);
  assert.match(sidebar, /soundAlerts=\{!embeddedReaderMode\}/);
  assert.match(sidebar, /statusSoundOwner=\{activityOwnsBackgroundStatusSounds \? "activity" : "chat"\}/);
});

test("top-bar sidebar, Reader and Explorer controls stay visually neutral", () => {
  const start = appShell.indexOf("const renderLayoutControl");
  const end = appShell.indexOf("const sidebarContent =", start);
  assert.ok(start >= 0 && end > start);
  const renderer = appShell.slice(start, end);
  assert.match(renderer, /background: surface === "recovery" \? "var\(--bg-panel\)" : "none"/);
  assert.match(renderer, /color: "var\(--text-muted\)"/);
  assert.match(renderer, /boxShadow: "none"/);
  assert.match(renderer, /opacity: control.disabled \? 0.5 : 1/);
  assert.match(appShell, /position: "fixed", top: "env\(safe-area-inset-top\)", right: "env\(safe-area-inset-right\)", zIndex: 300, display: "flex", borderBottom: "1px solid var\(--border\)"/);
});
test("session top bar uses the shared panel surface", () => {
  const start = appShell.indexOf("const sessionTopBar");
  const end = appShell.indexOf("  const chatWindowContent", start);
  assert.ok(start >= 0 && end > start);
  const sessionTopBar = appShell.slice(start, end);
  assert.match(sessionTopBar, /background: "var\(--bg-panel\)"/);
  assert.match(sessionTopBar, /background: "var\(--bg-panel\)"[\s\S]*borderBottom: "1px solid var\(--border\)"/);
});
test("normal chat does not mount recovery document control over the primary top bar", () => {
  const start = appShell.indexOf("const readerRecoveryVisible");
  const end = appShell.indexOf("const embeddedSessionControlOverlayAvailable", start);
  assert.ok(start >= 0 && end > start);
  const visibility = appShell.slice(start, end);
  assert.match(visibility, /const filePanelRecoveryVisible = !rightPanelOpen && \(readerRecoveryVisible \|\| \(fileTabs\.length > 0 && \(!chatOpen \|\| Boolean\(embeddedReaderUrl\)\)\)\);/);
});

test("mobile top-bar A remains above drawer hit surface", () => {
  assert.match(globalsCss, /@media \(max-width: 640px\) \{[\s\S]*?\.app-top-bar \{[\s\S]*?position: relative;[\s\S]*?z-index: 210;/);
  assert.match(globalsCss, /\.app-top-bar button \{[\s\S]*?min-height: 44px;/);
  assert.match(appShell, /surface === "top" && id === "sessions"[\s\S]{0,180}"top-bar-sidebar-toggle"/);
  assert.match(appShell, /data-activity-sidebar-toggle=\{id === "sessions" \? "true" : undefined\}/);
  assert.match(appShell, /aria-controls="session-sidebar"/);
});

test("session-only A always delegates semantic parent conversation command", () => {
  assert.match(appShell, /const isEmbeddedSessionOnly = embeddedReaderMode && \(sessionOnlyMode \|\| resourceToolbarOwnedByParent\);/);
  const start = appShell.indexOf("const handleSidebarToggle");
  const end = appShell.indexOf("const setExplorerForContext", start);
  assert.ok(start >= 0 && end > start);
  const handler = appShell.slice(start, end);
  assert.match(handler, /if \(isEmbeddedSessionOnly\) \{[\s\S]{0,220}const mobile = isMobileViewport\(\);[\s\S]{0,220}const parentDrawerOpen = mobile \? parentSidebarDrawerOpen : undefined;[\s\S]{0,260}toggleParentSidebar\(\s*mobile \? !parentDrawerOpen : undefined,[\s\S]{0,160}openDrawer: !parentDrawerOpen/);
  assert.match(appShell, /const parseEmbeddedParentSidebarToggle =/);
  assert.match(appShell, /typeof message\.open !== "boolean"/);
  assert.match(appShell, /openDrawer: sidebarOpen/);
  assert.match(appShell, /parentSidebarDrawerOpen/);
  assert.match(appShell, /openDrawer: open \|\| !isMobileViewport\(\)/);
  assert.match(appShell, /event\.source !== embeddedIframeRef\.current\?\.contentWindow/);
});

test("device plus session refresh restores session-only iframe instead of aggregate chat", () => {
  assert.match(appShell, /if \(\(\(isMobileViewport\(\) && !fullDeviceSession\) \|\| \(scopeAll && !deviceParam\)\) && sessionId\) \{/);
  assert.match(appShell, /target\.searchParams\.set\(EMBEDDED_SESSION_PARAM, "1"\)/);
  assert.match(appShell, /window\.parent\.postMessage\(\{ type: EMBEDDED_PARENT_SIDEBAR_REQUEST_EVENT \}, "\*"\)/);
  assert.match(appShell, /data\?\.type !== EMBEDDED_READER_READY_EVENT/);
});

test("embedded aggregate delegates parent activity sidebar control to the active embedded session", () => {
  // Outer shell keeps one top bar hidden; embedded session delegates A through parent protocol.
  assert.match(appShell, /<div ref=\{topBarRef\} className="app-top-bar" style=\{\{ display: embeddedReaderUrl \? "none" : "flex",/);
  assert.match(appShell, /data-activity-sidebar-toggle=\{id === "sessions" \? "true" : undefined\}/);
  assert.match(appShell, /const EMBEDDED_PARENT_SIDEBAR_TOGGLE_EVENT = "pi-web:parent-sidebar-toggle"/);
  assert.match(appShell, /const EMBEDDED_PARENT_SIDEBAR_STATE_EVENT = "pi-web:parent-sidebar-state"/);
  assert.match(appShell, /typeof message\.openDrawer !== "boolean"/);
  assert.match(appShell, /openDrawer: command\.openDrawer/);
  assert.match(appShell, /setSessionListOpen\(visible\)/);
  assert.match(appShell, /setSidebarOpen\(!mobile \|\| options\.openDrawer !== false \? visible : false\)/);
});
test("embedded file explorer has no duplicate parent activity-sidebar toggle", () => {
  assert.doesNotMatch(sessionSidebar, /showParentSidebarToggle/);
  assert.doesNotMatch(explorerSection, /showParentSidebarToggle/);
  assert.doesNotMatch(explorerSection, /parentSidebarOpen/);
});

test("embedded pages keep activity sidebar opt-in and raw session-only file sidebar", () => {
  // 完整设备视图经 piWebActivitySidebar=1 显式开启活动会话侧栏；标准
  // sessionOnly 工作区保留 readerMode 的原始 SessionSidebar 作为文件浏览器。
  assert.match(appShell, /activitySidebarMode, setActivitySidebarMode.*!embeddedReaderMode && !sessionOnlyMode\) \|\| searchParams\.get\(EMBEDDED_ACTIVITY_SIDEBAR_PARAM\) === "1"/);
  assert.match(appShell, /setActivitySidebarMode\(\(!embeddedReaderMode && !sessionOnlyMode\) \|\| searchParams\.get\(EMBEDDED_ACTIVITY_SIDEBAR_PARAM\) === "1"\)/);
  assert.doesNotMatch(appShell, /sessionOnlyMode && !sidebarOnlyMode \? null : \(/);
  assert.match(appShell, /readerMode=\{readerMode \|\| isEmbeddedSessionOnly\}/);
});

test("cross-device sharedFilters replicate via revision protocol (no loop)", () => {
  // 跨窗口复制协议：用户操作（updateSharedFilters）递增版本并广播 {filters, rev}；
  // 接收端只在 rev 更大时应用（applyRemoteSharedFilters），应用不回发 → 结构上无回环。
  assert.match(appShell, /const EMBEDDED_FILTERS_CHANGED_EVENT = "pi-web:filters-changed"/);
  assert.match(appShell, /const EMBEDDED_REQUEST_FILTERS_EVENT = "pi-web:request-filters"/);
  assert.match(appShell, /data\?\.type === EMBEDDED_FILTERS_CHANGED_EVENT && data\.filters && typeof data\.rev === "number"/);
  assert.match(appShell, /applyRemoteSharedFilters\(data\.rev, data\.filters, data\.epoch, data\.initial === true\)/);
  assert.match(appShell, /subscribeSharedFiltersBroadcast/);
  assert.match(appShell, /rev: readSharedRevision\(\)/);
  assert.match(appShell, /window\.parent\.postMessage\(\{ type: EMBEDDED_REQUEST_FILTERS_EVENT, filterProtocol: 2 \}, "\*"\)/);
  assert.doesNotMatch(appShell, /setSharedFilters\(data\.filters\)/);
  assert.doesNotMatch(appShell, /areFiltersEqual/);
  assert.doesNotMatch(appShell, /piWebFilterDevice/);
  assert.match(activityPanel, /applyRemoteSharedFilters\(rev: number, filters: SharedActivityFilters, epoch/);
  assert.match(activityPanel, /if \(!remoteFilterCursor\.accept\(epoch, rev, initial\)\) return false;/);
  assert.match(activityPanel, /applyRemoteSharedFilters/);
});


function retryStorage(t) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const values = new Map();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
  } });
  t.after(() => { if (saved) Object.defineProperty(globalThis, "sessionStorage", saved); else delete globalThis.sessionStorage; });
  return values;
}

test("retry continue hides the replaced failed assistant through the real display owner (JSONL append-only)", (t) => {
  retryStorage(t);
  const syntax = ts.createSourceFile("ChatWindow.tsx", chatWindow, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function find(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(syntax) === "onRetryContinueStarted") return node.initializer;
    return ts.forEachChild(node, find);
  }
  const callback = find(syntax);
  assert.ok(callback, "the ChatWindow display owner must receive the retry-start event");
  const scope = retryDisplayScope("s", "peer-a");
  let hidden = null;
  const context = { retryDisplayScope, readHiddenRetryErrors, rememberHiddenRetryError,
    retryDisplayScopeRef: { current: scope },
    setRetryHidden: (update) => { hidden = update(hidden); } };
  const invoke = vm.runInNewContext(ts.transpileModule(`(${callback.getText(syntax)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  invoke({ sessionId: "s", peer: "peer-b", entryId: "retried-error" });
  invoke({ sessionId: "other", peer: "peer-a", entryId: "retried-error" });
  invoke({ sessionId: "s", peer: "peer-a", entryId: null });
  invoke({ sessionId: "s", peer: "peer-a", entryId: "" });
  assert.equal(hidden, null, "a late event cannot hide a row in another session/peer");
  invoke({ sessionId: "s", peer: "peer-a", entryId: "retried-error" });
  assert.deepEqual(Array.from(hidden.ids), ["retried-error"]);
  assert.deepEqual(Array.from(readHiddenRetryErrors(scope)), ["retried-error"], "reload restores the exact hidden entry");
  assert.equal(readHiddenRetryErrors(retryDisplayScope("s", "peer-b")).size, 0);
  assert.equal(readHiddenRetryErrors(retryDisplayScope("other", "peer-a")).size, 0);
  assert.match(agentSession, /await ensureEventsConnected\(sid\);\s*if \(!ownsSubmission\(\)\) return;\s*submission\.requestStarted = true;\s*await sendAgentCommandR\(sid, \{ type: "retry_continue" \}\);[\s\S]*?onRetryContinueStartedRef\.current\?\.\(\{ sessionId: sid, peer: retryPeer, entryId: retryEntryId \}\)/);
  assert.match(chatWindow, /hideRetriedErrors\(view,/);
  assert.match(chatWindow, /const messages = visibleHistory\.messages;\s*const entryIds = visibleHistory\.entryIds;/);
});

test("retry display filtering preserves same-text entries and the complete history/runtime frontier", (t) => {
  retryStorage(t);
  const scope = retryDisplayScope("s", null);
  const error = { role: "assistant", stopReason: "error", content: [{ type: "text", text: "same failure" }] };
  const next = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "recovered" }] };
  const items = ["first-error", "retried-error"].map((entryId, messageIndex) => ({ entryId, orderKey:[messageIndex,1,messageIndex], role:'assistant',contentState:'full',process:true,toolCallCount:0,messageIndex,message: error,deferred:[] }));
  const page = { sessionId: "s", leafId: "retried-error", revision: "r1", items, before: null, after: null, coverage: { start: true, end: true } };
  const pages = [page], runtimeMessages = [error, error, next], runtimeIds = ["first-error", "retried-error", "new-answer"];
  rememberHiddenRetryError(scope, "retried-error");
  let state = mergeTranscriptPage(emptyTranscript(), page, "reset");
  for (let i = 0; i < runtimeMessages.length; i++) state = appendPersisted(state, runtimeMessages[i], runtimeIds[i]);
  const merged = transcriptView(state);
  const visible = hideRetriedErrors(merged, readHiddenRetryErrors(scope));
  assert.deepEqual(merged.entryIds, ["first-error", "retried-error", "new-answer"], "frontier matching happens before display filtering");
  assert.deepEqual(visible.entryIds, ["first-error", "new-answer"]);
  assert.deepEqual(visible.messages.map(message => message.content), [error.content, next.content]);
  assert.equal(visible.messageIndexByEntryId.get("new-answer"), 1);
  assert.equal(state.after, null);
  assert.deepEqual(page.items.map((item) => item.entryId), ["first-error", "retried-error"], "persisted history is never deleted");
  assert.deepEqual(runtimeIds, ["first-error", "retried-error", "new-answer"], "runtime identity is never rewritten");
  assert.equal(latestRetryErrorEntry([error], [""]), null, "an unpersisted preview is not a hideable entry");
  assert.equal(latestRetryErrorEntry([error, next], ["first-error", "new-answer"]), null, "success after an old error cannot hide that historical failure");
  const detachedPage = { ...page, leafId: "first-error", items: [items[0]], after: "first-error", coverage: { start: true, end: false } };
  const detached = hideRetriedErrors(transcriptView(mergeTranscriptPage(emptyTranscript(), detachedPage, "reset")), readHiddenRetryErrors(scope));
  assert.deepEqual(detached.entryIds, ["first-error"], "retrying target B cannot hide error A in an older reading window");
  assert.equal(detachedPage.after, "first-error");
});

test("the real retry hook captures its authoritative entry before waiting and emits nothing on connection failure", async () => {
  const syntax = ts.createSourceFile("useAgentSession.ts", agentSession, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(syntax) === "handleRetryContinue") return node.initializer.arguments[0];
    return ts.forEachChild(node, find);
  }
  const callback = find(syntax);
  assert.ok(callback);
  const code = ts.transpileModule(`(${callback.getText(syntax)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const outcome of ["accepted", "connection-failed", "peer-changed"]) {
    const calls = [];
    let resolve, reject;
    const connected = new Promise((yes, no) => { resolve = yes; reject = no; });
    const context = {
      sessionIdRef: { current: "s" }, session: { id: "s" }, agentRunningRef: { current: false }, bashRunningRef: { current: false },
      sessionHookMountedRef: { current: true }, branchScopeRef: { current: "peer-a:s" },
      remotePeerRef: { current: "peer-a" }, messagesRef: { current: [{ role: "assistant", stopReason: "error", content: [] }] },
      entryIdsRef: { current: ["current-error-B"] }, latestRetryErrorEntry,
      promptRunIdRef: { current: 0 }, stateRunRevisionRef: { current: 0 }, rpcPromptPendingRef: { current: false }, sessionRunningRef: { current: false },
      cancelInitialLanding() {}, cancelEventStreamGrace() {}, setAgentRunning() {}, setAgentPhase() {}, dispatch() {}, closeEvents() {},
      console: { error() {} }, isPromptRejectedError: (error) => error?.code === "prompt_rejected" && error?.accepted === false,
      ensureEventsConnected: () => connected,
      onRetryContinueStartedRef: { current: (event) => calls.push(["hide", event.sessionId, event.peer, event.entryId]) },
      sendAgentCommandR: async (id, command) => calls.push(["post", id, command.type]),
    };
    const pending = vm.runInNewContext(code, context)();
    assert.deepEqual(calls, []);
    if (outcome === "peer-changed") { context.remotePeerRef.current = "peer-b"; context.branchScopeRef.current = "peer-b:s"; }
    context.messagesRef.current = [{ role: "assistant", stopReason: "stop", content: [] }];
    context.entryIdsRef.current = ["new-answer"];
    if (outcome === "connection-failed") reject(new Error("no event connection")); else resolve();
    await pending;
    assert.deepEqual(calls, outcome === "accepted" ? [["post", "s", "retry_continue"], ["hide", "s", "peer-a", "current-error-B"]] : []);
  }
});

test("aggregate remote workspace keeps owner routing independent of fixed sidebar", () => {
  assert.match(appShell, /const handleSidebarToggle[\s\S]*const conversationVisible = fixedConversationSidebarVisible[\s\S]{0,260}sessionListOpen/);
  assert.match(appShell, /updateFixedConversationSidebarVisibility\(!conversationVisible\)/);
});


test("in-session search exposes a find overlay with match navigation", async () => {
  const highlights = await readFile(new URL("./TranscriptHighlights.tsx", import.meta.url), "utf8");
  assert.match(chatWindow, /role="search"/);
  assert.match(highlights, /data-session-search-match/);
  assert.match(chatWindow, /sessionSearchMatchIndex/);
  assert.match(chatWindow, /navigateSessionSearch\(-1\)/);
  assert.match(chatWindow, /navigateSessionSearch\(1\)/);
  assert.match(chatWindow, /chat\.findInSession/);
  assert.match(chatWindow, /chat\.findMatchCount/);
  assert.match(chatWindow, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(chatWindow, /m\.role !== "user" && m\.role !== "assistant"/);
  assert.match(chatWindow, /data-session-searchable='true'/);
  assert.match(chatWindow, /querySelectorAll<HTMLElement>\("\[data-session-searchable='true'\]"\)/);
  assert.match(chatWindow, /scrollSessionSearchTarget/);
  assert.match(chatWindow, /data-session-search-exclude/);
  assert.match(chatWindow, /createTreeWalker\(root, NodeFilter\.SHOW_TEXT\)/);
  assert.doesNotMatch(chatWindow, /createTreeWalker\(container, NodeFilter\.SHOW_TEXT\)/);
});

test("in-session search cancels stale retries and owns one active run", () => {
  assert.match(chatWindow, /const searchEffectRunRef = useRef\(0\)/);
  assert.match(chatWindow, /const pendingTimers = new Set/);
  assert.match(chatWindow, /return cleanup;/);
  assert.match(chatWindow, /clearHighlights\(\);\s*setSessionSearchMountedMatchCount\(0\);\s*const lowerTerm/);
  assert.match(chatWindow, /const isCurrent = \(\) => !disposed && searchEffectRunRef\.current === runId/);
  assert.match(chatWindow, /disposed = true;\s*observer\?\.disconnect\(\);\s*for \(const timer of pendingTimers\) clearTimeout\(timer\);\s*pendingTimers\.clear\(\)/);
  // Server search owns the cursor; DOM repaint must not reset it to match zero.
  assert.match(chatWindow, /reader\.searchHistory\(\{ q: query \}\)\.then\(\(page\) => \{\s*if \(!page \|\| page\.query !== query\) return;\s*setSessionSearchSessionTotal\(page\.total\);\s*setSessionSearchMatchIndex\(-1\)/);
});

test("ChatInput receives remotePeer and routes file-index autocomplete through peer proxy", () => {
  assert.match(chatWindow, /remotePeer=\{remotePeer\}/);
  assert.match(chatInput, /remotePeer\?: string;/);
  assert.match(chatInput, /const apiPath = useCallback\(\(path: string\) => apiPathForPeer\(remotePeer, path\), \[remotePeer\]\)/);
  assert.match(chatInput, /function fileIndexRequestPath\(cwd: string, query: string \| undefined, hideGitIgnored: boolean\)/);
  assert.match(chatInput, /fetch\(apiPath\(fileIndexRequestPath\(fetchCwd, query, hideGitIgnored\)\)/);
  assert.match(chatInput, /fetch\(apiPath\(fileIndexRequestPath\(fetchCwd, undefined, hideGitIgnored\)\)/);
});

test("remoteSession ChatWindow receives restoreMessage and chatInputRef", () => {
  assert.match(appShell, /restoreMessage=\{pendingRestoreMessage\}/);
  assert.match(appShell, /onRestoreMessageApplied=\{handleRestoreMessageApplied\}/);
  assert.match(appShell, /chatInputRef=\{chatInputRef\}/);
});

test("reader-mode sidebar follows resizable width and has a collapse toggle", () => {
  assert.match(globalsCss, /\.layout-reader \.sidebar-container\.sidebar-open \{\s*width: var\(--sidebar-width, 280px\);\s*min-width: var\(--sidebar-width, 280px\);\s*\}/);
  assert.match(globalsCss, /\.layout-reader \.sidebar-container > \* \{\s*width: var\(--sidebar-width, 280px\);\s*min-width: var\(--sidebar-width, 280px\);\s*\}/);
  assert.match(appShell, /readerMode && !isMobile && \(\s*<>\s*\{sessionControlPlacement === "right-panel" && renderLayoutControl\("sessions", "panel"\)/);
  assert.match(appShell, /renderLayoutControl\("document", "panel"\)/);
});
test("mobile activity panel shows row metadata on second row and keeps map/actions tappable", async () => {
  const talkMapOverlay = await readFile(new URL("./TalkMapOverlay.tsx", import.meta.url), "utf8");
  const handlerStart = appShell.indexOf("const handleNewActivitySession");
  const handlerEnd = appShell.indexOf("// 嵌入页收到外层活动面板", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handler = appShell.slice(handlerStart, handlerEnd);

  assert.match(activityPanel, /className="activity-session-title"/);
  assert.match(activityPanel, /className="activity-session-meta"/);
  assert.match(activityPanel, /className="activity-session-time"/);
  assert.doesNotMatch(globalsCss, /\.session-activity-panel \.activity-session-meta-extra \{\s*display: none !important;/);
  assert.doesNotMatch(globalsCss, /\.session-activity-panel \.activity-session-time \{\s*display: none !important;/);
  assert.match(globalsCss, /\.session-activity-panel \.activity-session-title \{[\s\S]*?max-width: none !important;/);

  assert.match(appShell, /className="app-top-bar"/);
  assert.match(appShell, /surface === "top" && id === "sessions"[\s\S]{0,180}"top-bar-sidebar-toggle"/);
  assert.match(appShell, /aria-controls=\{id === "sessions" \|\| id === "explorer" \? "session-sidebar"/);
  assert.match(appShell, /const toggleTopPanel = useCallback[\s\S]*?isMobileViewport\(\)[\s\S]*?\}, \[\]\);/);
  assert.match(globalsCss, /\.app-top-bar \{[\s\S]*?overflow-x: auto;/);
  assert.match(globalsCss, /\.top-bar-sidebar-toggle \{[\s\S]*?min-width: 44px;[\s\S]*?min-height: 44px;/);
  assert.match(handler, /setActiveTopPanel\(null\);\s*if \(isMobileViewport\(\)\) setSidebarOpen\(false\);[\s\S]*?setRemoteSession\(/);
  assert.match(activityPanel, /className="activity-group-toggle"/);
  assert.match(activityPanel, /className="activity-session-toggle"/);
  assert.match(activityPanel, /className="activity-action-button"/);

  assert.match(talkMapOverlay, /className="talk-map-overlay"/);
  assert.match(talkMapOverlay, /className="talk-map-toolbar"/);
  assert.match(talkMapOverlay, /className="talk-map-toolbar-identity"/);
  assert.match(talkMapOverlay, /className="talk-map-toolbar-top"/);
  assert.match(talkMapOverlay, /data-talk-map-refresh-area[\s\S]*?data-talk-map-time-range[\s\S]*?data-talk-map-refresh/);
  assert.match(talkMapOverlay, /data-talk-map-subproject-panel-toggle[\s\S]*?data-talk-map-layout/);
  assert.doesNotMatch(talkMapOverlay, /data-talk-map-visible-count/);
  assert.doesNotMatch(talkMapOverlay, /className="talk-map-primary-action"/);
  assert.doesNotMatch(talkMapOverlay, /data-talk-map-subproject-filter/);
  assert.match(talkMapOverlay, /className="talk-map-subproject-name"[\s\S]*?data-talk-map-subproject-open/);
  assert.match(talkMapOverlay, /data-talk-map-subproject-new-session[\s\S]*?disabled=\{!mapProjectKey\}/);
  assert.match(talkMapOverlay, /groupBySubproject\([\s\S]*?compareBySort/);
  assert.doesNotMatch(talkMapOverlay, /<strong>\{t\("talkMap\.subprojectVisibility"\)\}<\/strong>/);
  assert.doesNotMatch(talkMapOverlay, /talk-map-subproject-sidebar-header/);
  assert.match(talkMapOverlay, /data-talk-map-lock/);
  assert.match(talkMapOverlay, /data-talk-map-add-ghost/);
  assert.match(talkMapOverlay, /data-talk-map-fit/);
  assert.match(talkMapOverlay, /data-talk-map-reset/);
  assert.doesNotMatch(talkMapOverlay, /data-talk-map-more/);
  assert.match(globalsCss, /\.talk-map-toolbar-top \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(globalsCss, /\.talk-map-toolbar-identity \{[\s\S]*?align-items: center;/);
  assert.match(globalsCss, /\.talk-map-toolbar-names \{[\s\S]*?align-items: center;[\s\S]*?flex-wrap: nowrap;/);
  assert.match(globalsCss, /\.talk-map-title,[\s\S]*?white-space: nowrap;/);
  assert.match(globalsCss, /\.talk-map-toolbar-top \{[\s\S]*?display: flex;/);
  assert.match(globalsCss, /\.talk-map-toolbar-actions \{[\s\S]*?flex-wrap: nowrap;/);
  assert.match(globalsCss, /\.talk-map-subproject-sidebar \{[\s\S]*?width: fit-content;[\s\S]*?max-width: min\(320px, 35vw\);/);
  assert.match(globalsCss, /\.talk-map-subproject-sidebar-item \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto auto;/);
  assert.match(globalsCss, /\.talk-map-subproject-sidebar \{[\s\S]*?width: fit-content;[\s\S]*?max-width: min\(320px, calc\(100vw - 44px\)\);/);
  assert.match(globalsCss, /\.talk-map-toolbar-top-actions button,[\s\S]*?min-height: 44px !important;/);

});

test("reader-mode keeps the session sidebar above the compact right-panel backdrop", () => {
  const sidebarStart = appShell.indexOf('id="session-sidebar"');
  const sidebarEnd = appShell.indexOf("{sidebarContent}", sidebarStart);
  assert.ok(sidebarStart >= 0 && sidebarEnd > sidebarStart);
  assert.match(appShell.slice(sidebarStart, sidebarEnd), /zIndex: 245/);
  // The compact desktop backdrop covers the chat area, but must not hide or block
  // the left session-list control; the right panel remains above both layers.
  assert.match(globalsCss, /@media \(min-width: 641px\) and \(max-width: 959px\) \{[\s\S]*?\.right-panel-overlay-backdrop \{[\s\S]*?z-index: 240;[\s\S]*?\}\s*\.right-panel-overlay-backdrop\.is-open/);
  assert.match(globalsCss, /@media \(min-width: 641px\) and \(max-width: 959px\) \{[\s\S]*?\.right-panel-container \{[\s\S]*?z-index: 250;/);
});

test("reader-mode hides the right-panel resize handle so it cannot overlap the sidebar handle", () => {
  // With the chat column hidden, the right-panel handle lands on top of the sidebar
  // handle and swallows sidebar drags at desktop width; it must be hidden in reader mode.
  assert.match(globalsCss, /\.layout-reader \.right-panel-resize-handle \{\s*display: none;\s*\}/);
});


test("closing final file exits preview and offers close-all action", () => {
  const start = appShell.indexOf("const handleCloseFileTab");
  const end = appShell.indexOf("const handleOpenHiddenView", start);
  assert.ok(start >= 0 && end > start);
  const handler = appShell.slice(start, end);
  assert.match(handler, /if \(remaining\.length === 0\) \{[\s\S]{0,160}terminalTabs\.length === 0[\s\S]{0,160}clearFileTabsLayout\(\);/);
  assert.match(handler, /terminalList\.length > 0[\s\S]{0,80}setRightPanelOpen\(true\)/);
  assert.match(handler, /setFileTabs\(\[\]\);\s*setActiveFileTabId\(null\);\s*clearFileTabsLayout\(\);/);
  assert.match(appShell, /const clearFileTabsLayout = useCallback\(\(\) => \{[\s\S]{0,420}closeExplorerContexts\(\)[\s\S]{0,420}setReaderConversationLayout\(true\)[\s\S]{0,420}setRightPanelOpen\(false\)/);
  assert.match(appShell, /const closeFilePreview = useCallback\(\(\) => \{\s*setRightPanelOpen\(false\);/);
  assert.match(appShell, /const exitReaderMode = useCallback\(\(\) => \{[\s\S]{0,420}setRightPanelOpen\(false\)/);
  assert.match(appShell, /readerMode && !chatOpen && !rightPanelOpen/);
  assert.match(appShell, /data-file-tabs-close-all="true"/);
  assert.match(appShell, /onClick=\{handleCloseAllFileTabs\}/);
  assert.doesNotMatch(sessionSidebar, /previousReaderModeRef/);
  assert.match(sessionSidebar, /flex: explorerOpen \? "1 1 0" : "0 0 auto"/);
  assert.ok(!sessionSidebar.includes("setExplorerOpen(!compactReaderMode)"));
  assert.match(zhCN, /"files\.closeAll": "关闭全部文件"/);
  assert.match(en, /"files\.closeAll": "Close all files"/);
});
test("reader directory control sits inside file-viewer toolbar", async () => {
  const fileViewer = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");
  assert.match(fileViewer, /aria-label=\{t\("toc\.title"\)\}/);
  assert.ok(!/<span>目录<\/span>/.test(fileViewer), "TOC is icon-only; text moved to title tooltip");
});


test("collection scopes reconcile unavailable project filters", () => {
  assert.match(activityPanel, /data.scope !== activityScope/);
  assert.match(activityPanel, /filters.project.filter[\s\S]*projectKeysMatch/);
  assert.match(activityPanel, /onFilterChange\(\{ project: next \}\)/);
});

test("content search uses activity time and routes remote favorites to their owner", () => {
  assert.match(searchRoute, /searchActivityTime/);
  assert.match(activityPanel, /setFavorite\(hit\.id, true, hit\.device\?\.id\)/);
  assert.match(activityPanel, /lastActivityAt: hit\.activityAt \?\? hit\.modified/);
  assert.match(activityPanel, /pi-known-projects-changed/);
  assert.match(activityPanel, /deviceId === "string"/);
});


test("deleting the current session leaves no stale chat target", () => {
  const deletion = appShell.slice(appShell.indexOf("const handleSessionDeleted"));
  assert.match(deletion, /setSelectedSession\(null\)/);
  assert.match(deletion, /setNewSessionCwd\(cwd \?\? null\)/);
  assert.match(deletion, /clearLastOpen\(workspaceKeyOf\(selectedSession\)\)/);
  assert.match(appShell, /EMBEDDED_SESSION_INVALIDATE_REQUEST_EVENT/);
  assert.match(appShell, /EMBEDDED_SESSION_INVALIDATED_EVENT/);
  assert.match(appShell, /handleSessionDeleted\(data\.sessionId, false\)/);
  assert.match(sessionSidebar, /onSessionDeleted=\{onSessionDeleted\}/);
});

test("in-session branches follow the newest timeline leaf without manual promotion", () => {
  assert.match(chatWindow, /findLatestLeafId/);
  assert.match(chatWindow, /activeLeafId !== latestLeafId/);
  assert.doesNotMatch(chatWindow, /mainLeafId/);
  assert.doesNotMatch(chatWindow, /promoteToMain/);
  assert.doesNotMatch(chatWindow, /pi-web:main-leaf/);
});


test("session-only shell still propagates actual reader-mode transitions", () => {
  assert.ok(appShell.includes("readerMode={readerMode || isEmbeddedSessionOnly}"));
  assert.ok(appShell.includes("readerModeTransition={readerMode}"));
  assert.ok(!appShell.includes("explorerCloseKey"));
});


test("keeps abnormal-session Continue latched across refresh and transcript hydration", async () => {
  const { shouldShowContinueForActivityStatus } = await import("../lib/session-activity-status.ts");
  for (const status of ["unknown", "failed", "aborted", "retrying", "terminated"]) {
    assert.equal(shouldShowContinueForActivityStatus(status), true, status);
  }
  assert.equal(shouldShowContinueForActivityStatus("idle"), false);

  assert.match(chatWindow, /const abnormalUserMessageKeyRef = useRef<string \| null>\(null\)/);
  assert.doesNotMatch(chatWindow, /const abnormalMessagesLengthRef = useRef/);
  assert.match(chatWindow, /if \(latestUserMessageKey !== abnormalUserMessageKeyRef\.current\)/);
  assert.match(chatWindow, /applyActivityStatus\(item\.status, item\.execution\)/);
  assert.match(chatWindow, /activityStatusRequestRef/);
});

test("batch continue button surfaces beside the document toggle for two unknown or failed sessions", async () => {
  const { shouldShowBatchContinue, MIN_BATCH_CONTINUE_SESSIONS } = await import("../lib/batch-continue.ts");
  assert.equal(MIN_BATCH_CONTINUE_SESSIONS, 2);
  assert.equal(shouldShowBatchContinue(1), false);
  assert.equal(shouldShowBatchContinue(2), true);
  assert.equal(shouldShowBatchContinue(3), true);

  assert.match(appShell, /<BatchContinueButton\s*\/>/);
  assert.match(zhCN, /"session\.batchContinue"/);
  assert.match(zhCN, /"session\.batchContinueTitle"/);
  assert.match(en, /"session\.batchContinue"/);
});
