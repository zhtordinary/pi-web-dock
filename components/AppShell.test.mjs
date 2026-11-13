import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { THEME_INIT_SCRIPT } from "../lib/theme.ts";
import test from "node:test";

const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const resourceSource = await readFile(new URL("./SessionInfoResourcePanel.tsx", import.meta.url), "utf8");
const topBarSource = await readFile(new URL("./SessionTopBarStats.tsx", import.meta.url), "utf8");
const worktreeSource = await readFile(new URL("./app-shell-worktree.tsx", import.meta.url), "utf8");
const source = appShellSource;
const themeSource = await readFile(new URL("../lib/theme.ts", import.meta.url), "utf8");


test("pre-hydration theme source covers official palettes and blocked storage", () => {
  for (const theme of ["light", "dark", "mist", "rose", "pine", "auto"]) {
    assert.match(themeSource, new RegExp(`id: "${theme}"`));
  }
  assert.match(themeSource, /var stored = null/);
  assert.match(themeSource, /localStorage\.getItem[\s\S]*catch/);
  assert.match(themeSource, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(themeSource, /root\.classList\.toggle\("dark"/);
});

test("first-paint theme init falls back to system when storage is blocked", () => {
  const root = { dataset: {}, classList: { values: {}, toggle(name, value) { this.values[name] = value; } } };
  runInNewContext(THEME_INIT_SCRIPT, {
    URLSearchParams: class { get() { return null; } },
    localStorage: { getItem() { throw new Error("blocked"); } },
    window: { location: { search: "" }, matchMedia: () => ({ matches: true }) },
    document: { documentElement: root },
  });
  assert.equal(root.dataset.theme, "dark");
  assert.equal(root.classList.values.dark, true);
});

test("shows effective duration, agent total, model response total and share in that order", () => {
  assert.doesNotMatch(resourceSource, /session\.responseTotal/);
  assert.match(resourceSource, /\{agentTotalValue\}/);
  assert.match(resourceSource, /\{modelResponseValue\}/);
  assert.match(resourceSource, /color: "var\(--accent\)"/);
  const timingSection = resourceSource.slice(resourceSource.indexOf('translate("session.timing")'), resourceSource.length);
  const order = ["session.effectiveDuration", "session.agentTotalDuration", "session.modelResponseTotal", "session.modelResponseShare"]
    .map((key) => timingSection.indexOf(`translate("${key}")`));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual([...order].sort((left, right) => left - right), order);
  assert.match(resourceSource, /session\.timingUserWait/);
  assert.match(resourceSource, /session\.timingMissingChildren/);
});

test("AppShell wires the production resource panel for lightweight stats before pricing", () => {
  assert.match(source, /<SessionInfoResourcePanel/);
  assert.match(resourceSource, /statsSource === "reader-file"/);
  assert.match(resourceSource, /data-session-stats-scope/);
  assert.match(resourceSource, /costState === "loading"/);
  assert.match(`${source}\n${topBarSource}`, />…<\/span>/);
});

test("AppShell wires guarded top-bar stats into the production component", () => {
  assert.match(source, /import \{ SessionTopBarStats \} from "\.\/SessionTopBarStats";/);
  assert.match(source, /<SessionTopBarStats\s+sessionActive=\{topBarSessionActive\}\s+sessionStats=\{sessionStats\}\s+contextUsage=\{contextUsage\}\s+active=\{activeTopPanel === "session"\}\s+onOpen=\{handleSessionStatsButtonClick\}\s*\/>/s);
});

test("shows available partial session costs as conservative lower bounds", () => {
  const costSource = `${source}\n${resourceSource}\n${topBarSource}`;
  assert.ok(costSource.includes('costStatus === "partial"'));
  assert.ok(costSource.includes('`≥$${(Math.floor(cost * 100) / 100).toFixed(2)}`'));
  assert.ok(costSource.includes('`≥$${(Math.floor(amount * 10_000) / 10_000).toFixed(4)}`'));
  assert.ok(costSource.includes("missingPriceModels.join(", ")"));
});

test("shows other pending usage separately without adding a partial-cost label", () => {
  const costSource = `${source}\n${resourceSource}`;
  assert.match(costSource, /sessionCostPresentation/);
  assert.match(costSource, /session\.pendingUsageCount/);
  assert.match(costSource, /extensionPresentation\.pendingUsageCount/);
  assert.match(costSource, /session\.costPartialHint/);
  assert.doesNotMatch(costSource, /session\.recordedCost/);
});

test("labels child-agent cost rows with the agent count directly", () => {
  assert.match(resourceSource, /translate\("session\.childCostCount", \{ count: childSessionCount \}\)/);
  assert.doesNotMatch(resourceSource, /\$\{translate\("session\.childCost"\)\} \(\$\{childSessionCount\}\)/);
});

test("session statistics section headings use the primary text color", () => {
  const panelSource = `${source}\n${resourceSource}`;
  const headingRows = panelSource.match(/fontSize: 11, fontWeight: 600, color: "var\(--text\)"/g) ?? [];
  assert.equal(headingRows.length, 6);
  assert.doesNotMatch(panelSource, /translate\("session\.(infoSection|projectSection|messages|tokens|cost|timing)"\)[\s\S]{0,80}color: "var\(--text-muted\)"/);
});

test("closes every top panel when the pointer lands outside its trigger or content", () => {
  assert.match(source, /const topPanelRef = useRef<HTMLDivElement>\(null\);/);
  assert.match(source, /if \(!activeTopPanel\) return;[\s\S]*?document\.addEventListener\("pointerdown", handlePointerDown\)/);
  assert.match(source, /topBarRef\.current\?\.contains\(target\) \|\| topPanelRef\.current\?\.contains\(target\)/);
  assert.match(source, /<div ref=\{topPanelRef\} style=\{\{/);
  assert.match(source, /<div className="session-info-popover" style=\{\{/);
});

test("renders the response share only from available timing", () => {
  const shareStart = resourceSource.indexOf("const modelResponseShareValue = ") + "const modelResponseShareValue = ".length;
  const shareEnd = resourceSource.indexOf(";\n", shareStart);
  assert.ok(shareStart > 0 && shareEnd > shareStart);
  const formatShare = (timing) => runInNewContext(resourceSource.slice(shareStart, shareEnd), {
    timing,
    timingAvailable: typeof timing?.effectiveMs === "number" && timing.quality !== "unavailable",
    translate: (key) => key === "session.timingUnavailable" ? "unavailable" : key,
  });

  assert.equal(formatShare({ effectiveMs: 1, quality: "complete", modelResponsePercent: 96.666 }), "96.7%");
  assert.equal(formatShare({ effectiveMs: 1, quality: "partial", modelResponsePercent: 50 }), "50.0%");
  assert.equal(formatShare({ effectiveMs: 0, quality: "unavailable" }), "unavailable");
  assert.equal(formatShare(undefined), "unavailable");
  assert.match(resourceSource, /const formatCostModels/);
  assert.match(resourceSource, /formatCostModels\(sessionStats\.parentCost\)/);
  assert.match(resourceSource, /\.join\(\", \"\)/);
});

test("wraps full session file paths instead of ellipsizing them", () => {
  assert.match(source, /const isFile = row\.copyField === "file"/);
  assert.match(source, /overflow: isFile \? "visible" : "hidden"/);
  assert.match(source, /textOverflow: isFile \? "clip" : "ellipsis"/);
  assert.match(source, /overflowWrap: isFile \? "anywhere" : "normal"/);
});

test("leaving or forking a session does not mount hidden ChatWindows", () => {
  assert.doesNotMatch(source, /backgroundSessions|setBackgroundSessions|rememberActiveSession|backgroundChatInputRef/);
  assert.doesNotMatch(source, /<ChatWindow[^>]*\bbackground\b/s);
  assert.match(source, /useSessionRunCompletions\(embeddedReaderMode \? "local" : "all", handleSessionRunComplete\)/);
});

test("uses the fork response path for immediate sidebar hydration", () => {
  const forkSource = source.slice(source.indexOf("const handleSessionForked"), source.indexOf("const handleInitialRestoreDone"));
  assert.match(forkSource, /const \{ newSessionId, newSessionPath \} = result/);
  assert.match(forkSource, /path: newSessionPath/);
  assert.match(forkSource, /if \(!newSessionPath\) hydrateSelectedSession\(newSessionId\)/);
});

test("passes the active resource cwd to the model configuration panel", () => {
  assert.match(source, /const workspaceOwner = resolveWorkspaceOwner\(\{/);
  assert.match(source, /const resourceCwd = workspaceOwner\.cwd/);
  assert.match(source, /cwd=\{resourceCwd \?\? undefined\}/);
});

test("legacy workspace params stay inside a bounded adapter", () => {
  assert.match(source, /function hasLegacyWorkspaceLayout[\s\S]*params.get\("monitor"\)[\s\S]*params.get\("fullview"\)/);
  assert.match(source, /function stripLegacyWorkspaceLayout[\s\S]*next.delete\("monitor"\)[\s\S]*next.delete\("fullview"\)/);
  assert.doesNotMatch(source, /const monitorOn/);
});

test("canonical URL writer never emits legacy layout params", () => {
  const sync = source.slice(source.indexOf("const next = stripLegacyWorkspaceLayout"), source.indexOf("const DEVICE_URL_CACHE_KEY"));
  assert.doesNotMatch(sync, /next\.set\("monitor"/);
  assert.doesNotMatch(sync, /next\.set\("fullview"/);
  assert.match(sync, /next\.set\("device"/);
});

test("theme URL sync accepts every resolved official palette", () => {
  assert.match(source, /isThemePreference\(urlTheme\)/);
  for (const theme of ["mist", "rose", "pine"]) {
    assert.match(source, new RegExp(`theme\.${theme}`));
  }
  assert.match(source, /const \{ preference, isDark, toggleTheme \} = useTheme\(\)/);
});

test("fixed sidebar preference has responsive defaults and storage", () => {
  assert.match(source, /FIXED_CONVERSATION_SIDEBAR_STORAGE_KEY = "pi-fixed-conversation-sidebar-v1"/);
  assert.match(source, /FIXED_CONVERSATION_SIDEBAR_WIDE_QUERY = "\(min-width: 1200px\)"/);
  assert.match(source, /window\.innerWidth <= 640/);
  assert.match(source, /fixedConversationSidebarPreference === "show"/);
  assert.match(source, /fixedConversationSidebarPreference === null/);
});

test("session A changes only session-list layout preference", () => {
  const start = source.indexOf("const handleSidebarToggle");
  const end = source.indexOf("const setExplorerForContext", start);
  assert.ok(start >= 0 && end > start);
  const toggle = source.slice(start, end);
  assert.match(toggle, /const conversationVisible = fixedConversationSidebarVisible[\s\S]{0,260}sessionListOpen/);
  assert.doesNotMatch(toggle, /setReaderMode\(false\)/);
  assert.match(toggle, /updateFixedConversationSidebarVisibility\(!conversationVisible\)/);
  assert.doesNotMatch(toggle, /handleChangeActivityDevice|restoreWithDeviceUrl|setEmbeddedReaderUrl/);
});
test("seeds remote chat from the activity item’s running status and preserves owner identity", () => {
  assert.equal(
    [...source.matchAll(/sessionRunning: item\.status === "running" \|\| item\.status === "retrying"/g)].length,
    3,
  );
  assert.equal([...source.matchAll(/selectRemoteActivitySession\(item, searchTerm\)/g)].length, 2);
  assert.match(source, /sessionRunning=\{Boolean\(\s*remoteSession\.sessionInfo && remoteSession\.sessionRunning\s*\)\}/);
  assert.match(source, /sessionRunning: false/);
  assert.match(source, /onAgentEnd=\{\(\) => handleAgentEnd\(remoteSession\.sessionInfo\?\.id \?\? undefined, remoteSession\.device\.id\)\}/);
  assert.match(source, /onAgentError=\{\(\) => handleRemoteAgentError\(/);
  assert.doesNotMatch(source, /onAgentError=\{\(\) => handleAgentEnd/);
  assert.match(source, /const handleRemoteAgentError = useCallback\(\(sourceSessionId: string \| null, sourcePeer: string\) => \{/);
  const remoteErrorStart = source.indexOf("const handleRemoteAgentError = useCallback");
  const remoteErrorEnd = source.indexOf("const handleAttentionNeeded = useCallback", remoteErrorStart);
  assert.ok(remoteErrorStart >= 0 && remoteErrorEnd > remoteErrorStart);
  const remoteError = source.slice(remoteErrorStart, remoteErrorEnd);
  assert.match(remoteError, /current\.sessionInfo\.id !== sourceSessionId/);
  assert.match(remoteError, /return \{ \.\.\.current, sessionRunning: false \}/);
  assert.match(source, /sessionInfo: null, sessionRunning: false, newSessionCwd: cwd/);
  assert.match(source, /const handleAgentEnd = useCallback\(\(completedRemoteSessionId\?: string, completedRemotePeer\?: string\) => \{[\s\S]*?current\.device\.id === completedRemotePeer && current\.sessionInfo\?\.id === completedRemoteSessionId && current\.sessionRunning[\s\S]*?sessionRunning: false/);
  assert.match(source, /if \(isSubagentSession\(item\.session\)\) return;/);
  assert.match(source, /sessionRunning=\{Boolean\(selectedSession && runningSessionIds\.has\(selectedSession\.id\)\)\}/);
});

test("status sounds follow mounted activity producer topology", () => {
  assert.match(source, /const activityOwnsBackgroundStatusSounds = embeddedActivityWorkspace[\s\S]*activitySidebarMode/);
  assert.doesNotMatch(source, /activitySidebarMode && \(aggregateWorkspaceActive \|\| embeddedDeviceWorkspaceActive\)/);
});

test("top activity panel primes its position before the active render", () => {
  assert.match(source, /const updateTopPanelPosition = useCallback/);
  assert.match(source, /const toggleTopPanel = useCallback[\s\S]{0,900}updateTopPanelPosition\(\)/);
  assert.match(source, /\{activeTopPanel && topPanelPos && typeof document !== "undefined" && createPortal\([\s\S]{0,220}position: "fixed"/);
});

test("branch panel uses the shared top-panel host", () => {
  assert.match(worktreeSource, /import \{ BranchNavigator, BranchNavigatorPanel \} from "\.\/BranchNavigator";/);
  assert.match(worktreeSource, /<BranchNavigator /);
  assert.match(worktreeSource, /<BranchNavigatorPanel /);
  assert.match(source, /<AppShellWorktreeBranchPanel/);
  assert.match(source, /onToggle=\{\(\) => toggleTopPanel\("branches"\)\}/);
  assert.match(source, /tree=\{branchTree\}/);
});

test("mobile responsive layout keeps device selection separate from fixed sidebar", () => {
  assert.match(source, /const mobileAggregateSessionOpen = isMobileViewport\(\) && aggregateWorkspaceActive/);
  assert.match(source, /if \(sidebarOnlyMode \|\| embeddedDeviceWorkspaceActive \|\| \(aggregateWorkspaceActive && !mobileAggregateSessionOpen\)\) return true;/);
  assert.match(source, /const \[fixedConversationSidebarVisible/);
  assert.match(source, /onDeviceChange=\{!embeddedReaderMode \? handleChangeActivityDevice : undefined\}/);
});

test("session selection closes an open Talk Map before navigation", () => {
  const selectStart = source.indexOf("const handleSelectSession");
  const selectEnd = source.indexOf("const handleNewSession", selectStart);
  assert.ok(selectStart >= 0 && selectEnd > selectStart);
  assert.match(source.slice(selectStart, selectEnd), /closeTalkMap\(\)/);
  const activityStart = source.indexOf("const handleOpenActivitySession");
  const activityEnd = source.indexOf("const handleRemoteSessionCreated", activityStart);
  assert.ok(activityStart >= 0 && activityEnd > activityStart);
  assert.match(source.slice(activityStart, activityEnd), /closeTalkMap\(\)/);
});

test("session search updates highlight when clicking current session", () => {
  const start = source.indexOf("const handleSelectSession");
  const end = source.indexOf("const handleNewSession", start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);
  const highlightUpdate = handler.indexOf("setHighlightTerm(searchTerm?.trim() || null);");
  const sameSessionGuard = handler.indexOf("if (selectedSession.id === session.id && sameProject)");
  assert.ok(highlightUpdate >= 0, "same-session search must update highlight term");
  assert.ok(highlightUpdate < sameSessionGuard, "search highlight must update before same-session early return");
});

test("Talk Map context injection carries its source independently of the editable prompt", () => {
  const start = worktreeSource.indexOf("const handleTalkMapInjectContext");
  const end = worktreeSource.indexOf("const handleTalkMapFork", start);
  assert.ok(start >= 0 && end > start);
  assert.match(worktreeSource.slice(start, end), /contextSourceSessionId: session\.id/);
  assert.doesNotMatch(worktreeSource.slice(start, end), /firstMessage|context:/);
  assert.match(source, /newSessionContextSourceId=\{effectiveNewSessionCwd \? pendingContextSourceSessionId : null\}/);
  assert.match(source, /newSessionContextSourceId=\{remoteSession\.newSessionContextSourceId \?\? null\}/);
});

test("Talk Map fork keeps the latest user entry as the backend boundary", () => {
  const start = worktreeSource.indexOf("const handleTalkMapFork");
  const end = worktreeSource.indexOf("const handleActivityTalkMap", start);
  assert.ok(start >= 0 && end > start);
  const handler = worktreeSource.slice(start, end);
  assert.match(handler, /messages\[index\]\?\.role === "user" && typeof entryIds\[index\] === "string"/);
  assert.doesNotMatch(handler, /isSubagentWakeMessage/);
  assert.match(handler, /type: "fork", entryId: entryIds\[userIndex\]/);
});

test("new session actions close an open Talk Map", () => {
  const newSessionStart = source.indexOf("  const handleNewSession = useCallback");
  const newSessionEnd = source.indexOf("  const handleActivityProjectCwdChange", newSessionStart);
  assert.ok(newSessionStart >= 0 && newSessionEnd > newSessionStart);
  assert.match(source.slice(newSessionStart, newSessionEnd), /closeTalkMap\(\)/);
  assert.match(source.slice(newSessionStart, newSessionEnd), /closeWorktreeGraph\(\)/);
  assert.doesNotMatch(source.slice(newSessionStart, newSessionEnd), /setFileTabs\(\[\]\)/);
  assert.doesNotMatch(source.slice(newSessionStart, newSessionEnd), /setTerminalTabs\(/);
  assert.match(source.slice(newSessionStart, newSessionEnd), /updateManualFileContext\(resolveMainlineFileContext/);
  assert.match(source.slice(newSessionStart, newSessionEnd), /deviceId: null/);
  assert.match(source.slice(newSessionStart, newSessionEnd), /: boolean/);
  assert.match(source.slice(newSessionStart, newSessionEnd), /return true/);

  const activityStart = source.indexOf("const handleNewActivitySession");
  const activityEnd = source.indexOf("// 嵌入页收到外层活动面板的新建请求", activityStart);
  assert.ok(activityStart >= 0 && activityEnd > activityStart);
  assert.match(source.slice(activityStart, activityEnd), /closeTalkMap\(\)/);
  assert.match(source.slice(activityStart, activityEnd), /closeWorktreeGraph\(\)/);
  assert.match(worktreeSource, /onNewSession=\{onTalkMapNewSession\}/);
});

test("same-device activity navigation updates the outer selection before iframe acknowledgement", () => {
  const start = source.indexOf("const handleOpenActivitySession");
  const end = source.indexOf("const handleRemoteSessionCreated", start);
  assert.ok(start >= 0 && end > start);
  const open = source.slice(start, end);
  const requestStart = open.indexOf("const requestSerial = ++embeddedSessionRequestSerialRef.current;");
  const requestEnd = open.indexOf("embeddedSessionRequestTimerRef.current = window.setTimeout", requestStart);
  assert.ok(requestStart >= 0 && requestEnd > requestStart);
  const request = open.slice(requestStart, requestEnd);

  // The outer list must move to B immediately; waiting for iframe ack leaves A
  // highlighted while B is already opening (and can strand the old highlight).
  assert.match(request, /if \(embeddedSessionKey\) \{[\s\S]*?setEmbeddedSessionKey\(`\$\{item\.device\.id\}:\$\{item\.session\.id\}`\)/);
  // Navigating away also invalidates a pending fresh-session completion for A.
  assert.match(open, /activeNewSessionDraftKeyRef\.current = null/);
});

test("removes the top-bar full-history export control", () => {
  assert.doesNotMatch(source, /const handleViewFullHistory/);
  assert.doesNotMatch(source, /onClick=\{handleViewFullHistory\}/);
  assert.doesNotMatch(source, /translate\("history\\.(full|unsaved|label)"\)/);
});

test("keeps session-only iframe ready across in-place changes and cancels stale fallbacks", () => {
  const readyHandler = source.indexOf("const handleEmbeddedReaderReady");
  const readyStart = source.lastIndexOf("  useEffect(() => {", readyHandler);
  const readyEnd = source.indexOf("\n\n  useEffect(() => {", readyStart);
  assert.ok(readyStart >= 0 && readyEnd > readyStart);
  const readyEffect = source.slice(readyStart, readyEnd);

  // Session-only navigation keeps one iframe document alive. Its ready state
  // must therefore follow the document URL, not the selected session key.
  assert.match(source, /const embeddedSessionKeyRef = useRef<string \| null>\(null\)/);
  assert.match(source, /const embeddedDeviceIdRef = useRef<string \| null>\(null\)/);
  assert.match(readyEffect, /embeddedSessionKeyRef\.current\?\.split/);
  assert.match(readyEffect, /embeddedDeviceIdRef\.current/);
  assert.match(readyEffect, /\}, \[embeddedReaderUrl, syncCollapsedProvidersToIframe\]\);/);
  assert.doesNotMatch(readyEffect, /\}, \[embeddedDeviceId, embeddedReaderUrl, embeddedSessionKey, syncCollapsedProvidersToIframe\]\);/);

  const activityStart = source.indexOf("const handleOpenActivitySession");
  const fallbackStart = source.indexOf("const fallbackToEmbeddedSession", activityStart);
  const fallbackEnd = source.indexOf("const currentEmbeddedDeviceId", fallbackStart);
  assert.ok(activityStart >= 0 && fallbackStart > activityStart && fallbackEnd > fallbackStart);
  const fallback = source.slice(fallbackStart, fallbackEnd);
  // A URL fallback supersedes any pending in-place request and its timeout.
  assert.match(fallback, /invalidateEmbeddedSessionRequest\(\)/);
  const invalidationStart = source.indexOf("const invalidateEmbeddedSessionRequest");
  const invalidationEnd = source.indexOf("// Session changes inside one iframe", invalidationStart);
  assert.ok(invalidationStart >= 0 && invalidationEnd > invalidationStart);
  const invalidation = source.slice(invalidationStart, invalidationEnd);
  assert.match(invalidation, /embeddedSessionRequestSerialRef\.current \+= 1/);
  assert.match(invalidation, /window\.clearTimeout\(embeddedSessionRequestTimerRef\.current\)/);
  assert.match(invalidation, /embeddedSessionRequestTimerRef\.current = null/);
});

test("activity device and session replacement paths invalidate in-place request guard", () => {
  const deviceStart = source.indexOf("const handleChangeActivityDevice");
  const deviceEnd = source.indexOf("const handleOpenActivitySession", deviceStart);
  assert.ok(deviceStart >= 0 && deviceEnd > deviceStart);
  assert.match(source.slice(deviceStart, deviceEnd), /invalidateWorkspaceRestore\(\)/);
  assert.match(source, /const invalidateWorkspaceRestore = useCallback\(\(\) => \{[\s\S]*?urlRestoreTokenRef\.current \+= 1/);

  const openStart = source.indexOf("const openRemoteSession");
  const openEnd = source.indexOf("// 嵌入页（大面板恒为全部设备）点异设备会话时", openStart);
  assert.ok(openStart >= 0 && openEnd > openStart);
  assert.match(source.slice(openStart, openEnd), /invalidateWorkspaceRestore\(\)/);
  assert.match(source, /const invalidateWorkspaceRestore = useCallback[\s\S]*?invalidateEmbeddedSessionRequest\(\)/);

  const activityStart = source.indexOf("const handleOpenActivitySession");
  const activityEnd = source.indexOf("const handleRemoteSessionCreated", activityStart);
  assert.ok(activityStart >= 0 && activityEnd > activityStart);
  assert.match(source.slice(activityStart, activityEnd), /invalidateWorkspaceRestore\(\)/);
  assert.match(source.slice(activityStart, activityEnd), /clearEmbeddedReaderOwner\(\)/);
});

test("aggregate remote navigation clears the previous embedded Reader owner", () => {
  const start = source.indexOf("const handleOpenActivitySession");
  const end = source.indexOf("const handleRemoteSessionCreated", start);
  assert.ok(start >= 0 && end > start);
  const open = source.slice(start, end);
  const aggregate = open.indexOf("if ((aggregateWorkspaceActive || hiddenView || favoritesView || isMobileViewport() || aggregateDeviceScope) && !embeddedReaderMode)");
  assert.ok(aggregate >= 0);
  const branch = open.slice(aggregate, open.indexOf("    if (fallbackToEmbeddedSession()", aggregate));
  assert.ok(branch.indexOf("clearEmbeddedReaderOwner();") < branch.indexOf("selectRemoteActivitySession(item, searchTerm)"));
});

test("aggregate remote drafts clear the previous embedded Reader owner", () => {
  const start = source.indexOf("const handleNewActivitySession");
  const end = source.indexOf("// 嵌入页收到外层活动面板的新建请求", start);
  assert.ok(start >= 0 && end > start);
  const branch = source.slice(start, end);
  assert.ok(branch.indexOf("clearEmbeddedReaderOwner();") < branch.indexOf("setRemoteSession({ device, sessionInfo: null"));
});

test("embedded new draft invalidates in-place request before replacing session key", () => {
  const start = source.indexOf("const handleNewSessionMessage");
  const end = source.indexOf("// 嵌入页内部打开会话（同设备）上报", start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);
  const invalidation = handler.indexOf("invalidateEmbeddedSessionRequest();");
  const keyUpdate = handler.indexOf("setEmbeddedSessionKey(");
  const iframeSessionUpdate = handler.indexOf("setEmbeddedIframeSessionId(null);");
  assert.ok(invalidation >= 0, "new draft must invalidate pending iframe request");
  assert.ok(keyUpdate > invalidation || iframeSessionUpdate > invalidation, "request invalidation must precede draft state replacement");
});

test("stale remote fresh-session completion cannot replace a later activity selection", () => {
  const start = source.indexOf("const handleRemoteSessionCreated");
  const end = source.indexOf("const effectiveNewSessionCwd", start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);
  assert.match(handler, /sourceDraftKey/);
  assert.match(handler, /remoteNewSessionDraftKeyRef\.current !== sourceDraftKey/);
  assert.match(handler, /remoteNewSessionDraftKeyRef\.current = null/);
});

test("stale embedded fresh-session completion cannot notify parent selection", () => {
  const start = source.indexOf("const handleSessionCreated = useCallback");
  const end = source.indexOf("const deliverSessionNotification", start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);
  const guard = handler.indexOf("if (activeNewSessionDraftKeyRef.current !== sourceDraftKey) return;");
  const parentNotify = handler.indexOf("window.parent.postMessage(");
  const ghostConversion = handler.indexOf("completeTalkMapGhostConversion(session.id, sourceDraftKey)");
  assert.ok(guard >= 0, "fresh-session source guard missing");
  assert.ok(parentNotify > guard, "stale fresh-session completion notifies parent before source guard");
  assert.ok(ghostConversion > guard, "stale completion must not consume the active draft's Talk Map conversion");
});
test("skill action preserves current composer draft while inserting command", () => {
  assert.match(source, /const handleUseSkill = useCallback\(\(skillName: string\) =>/);
  assert.match(source, /input\.prependText\(command\)/);
  assert.doesNotMatch(source, /input\.insertText\(command\)/);
});
test("skill action reaches embedded composer through parent message", () => {
  assert.match(source, /const EMBEDDED_INSERT_SKILL_EVENT = "pi-web:insert-skill"/);
  assert.ok(source.includes('iframe.postMessage({ type: EMBEDDED_INSERT_SKILL_EVENT, command }, "*")'));
  assert.match(source, /event\.source !== window\.parent/);
  assert.match(source, /pendingEmbeddedSkillRef/);
  assert.match(source, /const handleChatInputReady = useCallback/);
  assert.match(source, /onChatInputReady={handleChatInputReady}/);
});
test("embedded image preview belongs to the global surface rather than the Reader iframe", () => {
  assert.match(source, /reduceEmbeddedImagePreview\(embeddedImagePreviewRef\.current, event\.data\)/);
  assert.match(source, /embeddedModalOpen && embeddedModalKind === "sidekick" \? \{ position: "fixed", inset: 0, zIndex: 1400 \}/);
  assert.match(source, /embeddedImagePreview && embeddedImagePreview\.phase !== "closed"[\s\S]*?<ImageLightbox/);
  assert.doesNotMatch(source, /data-embedded-image-preview-backdrop/);
  assert.doesNotMatch(source, /embeddedModalOpen && \(embeddedModalKind === "sidekick" \|\| embeddedModalKind === "image-preview"\) \? \{ position: "fixed", inset: 0, zIndex: 1400 \}/);
  assert.doesNotMatch(source, /embeddedModalKind === "image-preview" \? \{ position: "fixed", top: "50%", left: "50%"/);
  assert.match(source, /zIndex: 1400/);
  assert.match(source, /onLoad=\{\(\) => \{[^\n]*embeddedImagePreviewRef\.current = null;[^\n]*setEmbeddedImagePreview\(null\)/);
});
test("session info omits cumulative token total row", () => {
  assert.doesNotMatch(source, /tokenTotalRow/);
  assert.doesNotMatch(source, /总计.*累计/);
});

test("refreshes full session statistics when opening the top-bar panel", () => {
  assert.match(source, /sessionStatsRefreshRef = useRef/);
  assert.match(source, /const handleSessionStatsButtonClick = useCallback\(\(\) => \{[\s\S]*?activeTopPanelRef\.current !== "session"[\s\S]*?sessionStatsRefreshRef\.current\?\.\(\)[\s\S]*?refreshTopBarSessionMetadata\(\)[\s\S]*?toggleTopPanel\("session"\)/);
  assert.match(topBarSource, /onClick=\{onOpen\}/);
  assert.match(source, /onOpen=\{handleSessionStatsButtonClick\}/);
  assert.match(source, /const refreshTopBarSessionMetadata = useCallback/);
  assert.match(source, /sessionStatsRefreshRef=\{sessionStatsRefreshRef\}/);
});

test("keeps top-bar live data bound to the active local or remote session", () => {
  assert.match(source, /const topBarSession = remoteSession \? remoteSession\.sessionInfo : selectedSession;/);
  assert.match(source, /const topBarSessionId = remoteSession \? remoteSession\.sessionInfo\?\.id \?\? null : selectedSession\?\.id \?\? null;/);
  assert.match(source, /sessionStatsSnapshot\?\.sessionId === topBarSessionId[\s\S]*?sessionStatsSnapshot\.generation === activeSessionGeneration/);
  assert.match(source, /liveContextUsageSnapshot\?\.sessionId === topBarSessionId[\s\S]*?liveContextUsageSnapshot\.generation === activeSessionGeneration/);
  assert.match(source, /active\.sessionId !== sessionId \|\| active\.peer !== peer \|\| active\.generation !== generation/);
  assert.match(source, /latestIdentity\.generation !== sessionGeneration/);
  const autoNameSource = source.slice(source.indexOf("const handleAutoName"), source.indexOf("const handleExplorerRefresh"));
  assert.match(autoNameSource, /current\?\.device\.id === sessionPeer && current\.sessionInfo\?\.id === sessionId/);

  const endSource = source.slice(source.indexOf("const handleAgentEnd"), source.indexOf("const handleAttentionNeeded"));
  assert.match(endSource, /refreshTopBarSessionMetadata\(\)/);
  const metadataRefreshSource = source.slice(source.indexOf("const refreshTopBarSessionMetadata"), source.indexOf("const handleSessionStatsButtonClick"));
  assert.match(metadataRefreshSource, /fetch\(`\/api\/remote\/sessions\?peer=\$\{encodeURIComponent\(peerId\)\}`/);
  assert.match(metadataRefreshSource, /current\?\.device\.id === peerId && current\.sessionInfo\?\.id === sessionId/);
  assert.match(metadataRefreshSource, /hydrateSelectedSession\(selectedSession\.id\)/);
  assert.match(source, /onSessionStatsChange=\{reportSessionStatsChange\}/);
  assert.match(source, /onContextUsageChange=\{reportContextUsageChange\}/);
});

test("abandoned draft context source is cleared when selecting an existing session", () => {
  const start = source.indexOf("const handleSelectSession");
  const end = source.indexOf("const handleNewSession", start);
  assert.ok(start >= 0 && end > start);
  assert.match(source.slice(start, end), /setPendingContextSourceSessionId\(null\)/);
});

test("session info renders canonical extension costs only", () => {
  assert.match(resourceSource, /extensionCosts\.map\(\(summary\)/);
  assert.match(resourceSource, /session\.extensionCost/);
  assert.match(resourceSource, /session\.extensionHistoricalUnpriced/);
  assert.match(resourceSource, /\.replace\(\/\\s\+usage\$\/i, ""\)/);
  assert.match(resourceSource, /session\.extensionCost", \{ name \}/);
  assert.match(resourceSource, /session\.extensionHistoricalEstimated/);
  assert.match(resourceSource, /session\.extensionHistoricalEstimatedPartial/);
  assert.doesNotMatch(resourceSource, /extensionUsageRows/);
  assert.doesNotMatch(resourceSource, /session\.extensionUsageNote/);
  assert.doesNotMatch(resourceSource, /session\.extensionUsage"/);
  assert.doesNotMatch(resourceSource, /usage\.cost\.toFixed/);
});

test("session info groups plugin costs and removes the recap cache row", () => {
  assert.match(resourceSource, /mergeSessionCostSummaries\(\[/);
  assert.match(resourceSource, /label: translate\("session\.pluginCost"\)/);
  assert.match(resourceSource, /details: pluginCostDetails/);
  assert.doesNotMatch(resourceSource, /recapCacheHitRate/);
  assert.doesNotMatch(resourceSource, /key: "recapCache"/);
});

test("session info cost breakdown allows expanding cost details and specific models", () => {
  assert.match(source, /const \[expandedCostModels, setExpandedCostModels\] = useState<Record<string, boolean>>/);
  assert.match(source, /const toggleCostModels = useCallback/);
  assert.match(resourceSource, /const hasMultipleModels = row\.models\.length > 1/);
  assert.match(resourceSource, /const hasDetails = \(row\.details\?\.length \?\? 0\) > 0/);
  assert.match(resourceSource, /const isExpandable = hasDetails \|\| hasMultipleModels/);
  assert.match(resourceSource, /onClick=\{\(\) => toggleCostModels\(row\.key\)\}/);
  const costRow = resourceSource.slice(resourceSource.indexOf("const renderCostDetailRow"), resourceSource.indexOf("{isExpanded && hasDetails"));
  assert.match(costRow, /aria-expanded=\{isExpanded\}/);
  assert.match(costRow, /<span aria-hidden="true"/);
  assert.match(costRow, /isExpanded \? "▾" : "▸"/);
  assert.match(resourceSource, /row\.details\?\.map\(renderCostDetailRow\)/);
  assert.match(resourceSource, /row\.models\.map\(\(model\) =>/);
  assert.match(resourceSource, /gridColumn:\s*"1 \/ -1"/);
  assert.match(resourceSource, /filter\(\(model\) => Boolean\(model\) && model !== "unknown\/unknown"\)/);
});


test("AppShell forwards the embedded slash target peer to its document-level surface", () => {
  assert.match(source, /<SlashCommandDetailsSurface[\s\S]*remotePeer=\{embeddedSessionKey\?\.split\(\":\"\)\[0\] \?\? embeddedDeviceId \?\? embeddedResourceSession\?\.deviceId\}/);
});

test("renders BatchContinueButton right next to the top-bar document layout control", () => {
  assert.match(source, /import\s*\{\s*BatchContinueButton\s*\}\s*from\s*"\.\/BatchContinueButton";/);
  assert.match(source, /<BatchContinueButton\s*\/>\s*\{\/\* Scheme A: fixed right panel toggle always anchored in top-right \*\/\}\s*\{renderLayoutControl\("document", "top"\)\}/);
});
