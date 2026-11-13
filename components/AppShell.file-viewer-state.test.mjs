import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

function fileContentBlock() {
  const start = source.indexOf("{/* Only the active viewer");
  const end = source.indexOf("</div>\n      </div>\n    </div>", start);
  assert.notEqual(start, -1, "file content comment not found");
  assert.notEqual(end, -1, "end of file content block not found");
  return source.slice(start, end);
}

test("only the active file tab mounts a FileViewer", () => {
  const block = fileContentBlock();
  assert.match(block, /activeFileTab\?\.filePath \? \(/);
  assert.doesNotMatch(block, /fileTabs\.map\(/);
  assert.equal(block.match(/<FileViewer/g)?.length, 1);
});

test("the active viewer restores tab state and saves it with a revision", () => {
  const block = fileContentBlock();
  assert.match(block, /key=\{`\$\{activeFileTab\.id\}:\$\{activeFileTab\.viewerRevision \?\? 0\}`\}/);
  assert.match(block, /initialState=\{activeFileTab\.viewerState\}/);
  assert.match(block, /handleFileViewerStateChange\(\s*activeFileTab\.id,\s*activeFileTab\.viewerRevision \?\? 0,/);
});

test("closing the file panel pauses the active viewer watcher", () => {
  assert.match(fileContentBlock(), /watchEnabled=\{rightPanelOpen\}/);
});

test("last-file and close-all cleanup clears Explorer, exits Reader and closes only document panel", () => {
  const start = source.indexOf("const handleCloseFileTab");
  const end = source.indexOf("const handleOpenHiddenView", start);
  assert.ok(start >= 0 && end > start);
  const handlers = source.slice(start, end);
  assert.match(handlers, /if \(remaining\.length === 0\)[\s\S]{0,140}clearFileTabsLayout\(\);/);
  assert.match(handlers, /const handleCloseAllFileTabs = useCallback/);
  assert.match(handlers, /setFileTabs\(\[\]\);\s*setActiveFileTabId\(null\);\s*clearFileTabsLayout\(\);/);
  const cleanupStart = source.indexOf("const clearFileTabsLayout");
  const cleanupEnd = source.indexOf("const handleOpenFileFromExplorer", cleanupStart);
  const cleanup = source.slice(cleanupStart, cleanupEnd);
  assert.match(cleanup, /closeExplorerContexts\(\)/);
  assert.match(cleanup, /setReaderMode\(false\)/);
  assert.match(cleanup, /setReaderConversationLayout\(true\)/);
  assert.match(cleanup, /setRightPanelOpen\(false\)/);
  const closePreviewStart = source.indexOf("const closeFilePreview");
  const closePreviewEnd = source.indexOf("const toggleRightPanel", closePreviewStart);
  const closePreview = source.slice(closePreviewStart, closePreviewEnd);
  assert.match(closePreview, /setRightPanelOpen\(false\)/);
  assert.doesNotMatch(closePreview, /setActivityExplorerOpen|setEmbeddedWorkspaceExplorerOpen|setSessionSidebarExplorerOpen|setSessionListOpen|setSidebarOpen/);
  assert.match(source, /const exitReaderMode = useCallback\(\(\) => \{[\s\S]{0,420}setRightPanelOpen\(false\)/);
  assert.ok(!/if \(fileTabs\.length > 0\) return;\s*if \(readerMode\)/.test(source), "empty tabs must not auto-exit reader mode");
  assert.doesNotMatch(source, /if \(readerMode \|\| fileTabs\.length > 0 \|\| !rightPanelOpen\) return;/, "manual empty right panel must remain open");
  assert.match(source, /data-file-tabs-close-all=\"true\"[\s\S]{0,180}onClick=\{handleCloseAllFileTabs\}/);
});

test("session list collapse control anchors to far left across sidebar and top surfaces", () => {
  assert.match(source, /type LayoutControlSurface = "top" \| "panel" \| "panel-action" \| "recovery" \| "sidebar"/);
  assert.match(source, /renderLayoutControl\("sessions", "sidebar"\)/);
  assert.match(source, /const deriveSessionControlPlacement =/);
  assert.match(source, /sessionControlPlacement === "sidebar-header"/);
  assert.match(source, /sessionControlPlacement === "activity-toolbar"/);
  assert.match(source, /const sidebarHeaderVisible = !readerMode[\s\S]{0,180}!activitySidebarMode/);
  assert.doesNotMatch(source, /const activitySidebarControlHeader =/);
  assert.match(source, /sessionControlPlacement === "top-bar"/);
  const sidebarHeaderIdx = source.indexOf('renderLayoutControl("sessions", "sidebar")');
  const titleIdx = source.indexOf('<PiWebTitle />', sidebarHeaderIdx);
  assert.ok(sidebarHeaderIdx >= 0 && titleIdx > sidebarHeaderIdx, 'sidebar header must render session control to the left of title');
});

test("reader chain keeps one session toggle owner in the left Explorer toolbar", () => {
  assert.match(source, /const sessionControlPlacement = deriveSessionControlPlacement\(/);
  assert.match(source, /sessionControlPlacement === "explorer-toolbar"/);
  assert.match(source, /embeddedSessionControlOverlayAvailable/);
  assert.match(source, /embeddedSessionControlOverlayAvailable = Boolean\(embeddedReaderUrl\)[\s\S]{0,240}!embeddedModalOpen/);
  assert.match(source, /reserveParentSessionControlSlot/);
  assert.match(source, /shouldReserveParentSessionControlSlot\(/);
  assert.match(source, /data-layout-control-reserved="sessions"/);
  assert.match(source, /sessionControlPlacement === "explorer-toolbar" \? renderLayoutControl\("sessions", "sidebar"\) : undefined/);
  assert.match(source, /explorerLeadingControl=\{sessionControlPlacement === "explorer-toolbar" \? renderLayoutControl\("sessions", "sidebar"\) : undefined\}/);
  assert.match(source, /sessionControlPlacement === "right-panel"/);
  assert.match(source, /renderLayoutControl\("sessions", "panel"\)/);
  assert.match(source, /sessionControlPlacement === "recovery"/);
  assert.match(source, /renderLayoutControl\("sessions", "recovery"\)/);
});

test("top bar anchors document control to far right and session-only iframe suppresses inner session list", () => {
  const start = source.indexOf("{/* Keep cost, cache-hit rate, and context usage in the top bar");
  const end = source.indexOf("{/* Top panel dropdown", start);
  assert.ok(start >= 0 && end > start);
  const controls = source.slice(start, end);
  assert.match(controls, /marginLeft:\s*"auto",\s*display:\s*"flex",\s*alignItems:\s*"center"/);
  assert.match(controls, /<BatchContinueButton\s*\/>[\s\S]*renderLayoutControl\("document", "top"\)\}\s*<\/div>/);
  assert.match(source, /const baseSidebarShellOpen = isEmbeddedSessionOnly\s*\?\s*explorerContentVisible/);
  assert.match(source, /showSessionToggle=\{!readerMode && !activityWorkspaceActive && !isEmbeddedSessionOnly\}/);
  assert.match(source, /\{!isEmbeddedSessionOnly && \(\s*<SessionActivitySidebar/);
});

test("top bar exposes A/B/C in fixed order and right panel exposes A/B/C/D", () => {
  const topStart = source.indexOf("/* Top bar layout controls");
  const topEnd = source.indexOf("<button\n             type=\"button\"\n             onClick=\{handleActivityButtonClick\}", topStart);
  const top = source.slice(topStart, topEnd);
  assert.ok(top.indexOf('renderLayoutControl("sessions", "top")') >= 0);
  assert.ok(top.indexOf('renderLayoutControl("explorer", "top")') > top.indexOf('renderLayoutControl("sessions", "top")'));
  assert.ok(top.indexOf('renderLayoutControl("reader", "top")') > top.indexOf('renderLayoutControl("explorer", "top")'));
  const topSurfaceEnd = source.indexOf("{/* Top panel dropdown", topStart);
  const topSurface = source.slice(topStart, topSurfaceEnd);
  assert.match(topSurface, /renderLayoutControl\("document", "top"\)/);
  assert.doesNotMatch(topSurface, /translate\("files\.showPanel"\)/);

  const panelStart = source.indexOf("{/* Right panel tab bar */}");
  const panelEnd = source.indexOf("{/* Only the active viewer", panelStart);
  const panel = source.slice(panelStart, panelEnd);
  assert.match(panel, /renderLayoutControl\("reader", "panel-action"\)/);
  assert.match(source, /data-layout-control-group="leading"/);
  assert.match(source, /sessionControlPlacement === "right-panel"/);
  assert.match(panel, /renderLayoutControl\("document", "panel"\)/);
  assert.match(panel, /<TabBar/);
  assert.match(panel, /data-file-tabs-close-all=\"true\"/);
});

test("Reader controls share one model across top, panel and recovery surfaces", () => {
  assert.match(source, /const layoutControls: Record<LayoutControlId/);
  assert.match(source, /sessions: \{[\s\S]{0,420}disabled: \(isEmbeddedSessionOnly && !parentSidebarReady\)/);
  assert.match(source, /explorer: \{[\s\S]{0,420}disabled: embeddedDeviceWorkspaceActive \|\| !activityExplorerCwd/);
  assert.match(source, /reader: \{[\s\S]{0,360}disabled: !readerMode && isEmbeddedSessionOnly && !parentSidebarReady/);
  assert.doesNotMatch(source, /hasReadableFile/);
  assert.doesNotMatch(source, /请先打开可阅读文件/);
  assert.match(source, /document: \{[\s\S]{0,520}onClick: toggleRightPanel/);
  assert.equal((source.match(/renderLayoutControl\("reader", "(?:top|panel|recovery)"\)/g) ?? []).length, 3);
  const recoveryStart = source.indexOf("Recovery strip keeps D reachable");
  const recoveryEnd = source.indexOf("{/* skillsConfigOpen", recoveryStart);
  const recovery = source.slice(recoveryStart, recoveryEnd);
  const ids = ["sessions", "explorer", "reader", "document"].map((id) => recovery.indexOf(`renderLayoutControl(\"${id}\", \"recovery\")`));
  assert.ok(ids.every((index) => index >= 0), "recovery strip must keep all controls reachable");
  assert.deepEqual([...ids].sort((a, b) => a - b), ids, "recovery control order must be A/B/C/D");
  assert.match(source, /data-reader-mode-toggle=\{id === "reader" \? readerMarker : undefined\}/);
  assert.match(source, /data-file-panel-toggle=\{id === "document" \?/);
});

test("Reader mode transaction opens Explorer and closes document preview on exit", () => {
  assert.match(source, /const activateReaderMode = useCallback\(\(cwdOverride\?: string \| null, peerOverride\?: string \| null\) => \{/);
  assert.match(source, /const requestedCwd = cwdOverride\?\.trim\(\)/);
  assert.match(source, /const requestedOwner = requestedCwd/);
  assert.match(source, /setExplorerForContext\(true, \{ openMobileDrawer: false, workspace \}\)/);
  assert.match(source, /const exitReaderMode = useCallback\(\(\) => \{[\s\S]{0,420}setExplorerForContext\(false, \{ openMobileDrawer: false \}\)[\s\S]{0,420}setReaderConversationLayout\(true\)[\s\S]{0,420}setRightPanelOpen\(false\)/);
  assert.match(source, /const setReaderConversationLayout = useCallback\(\(open: boolean\) => \{[\s\S]{0,320}toggleParentSidebar\(open, \{ openDrawer: open \|\| !isMobileViewport\(\) \}\)/);
  assert.match(source, /const closeExplorerContexts = useCallback\(\(\) => \{[\s\S]{0,220}setSessionSidebarExplorerOpen\(false\)[\s\S]{0,220}setActivityExplorerOpen\(false\)[\s\S]{0,220}setEmbeddedWorkspaceExplorerOpen\(false\)/);
});

test("file explorer opens Reader while session file links keep modal behavior", () => {
  const explorerStart = source.indexOf("const handleOpenFileFromExplorer");
  const explorerEnd = source.indexOf("const handleOpenLinkedFile", explorerStart);
  assert.ok(explorerStart >= 0 && explorerEnd > explorerStart);
  const explorerHandler = source.slice(explorerStart, explorerEnd);
  assert.match(explorerHandler, /resolveMainlineFileContext\(\{[\s\S]{0,260}activityExplorerPeerRef\.current[\s\S]{0,260}activityExplorerCwdRef\.current/);
  assert.match(explorerHandler, /activateReaderMode\(context\.cwd, context\.deviceId\);/);
  assert.doesNotMatch(explorerHandler, /enterReaderMode\(\);/);

  const linkedStart = source.indexOf("const handleOpenLinkedFile");
  const linkedEnd = source.indexOf("const handleCloseFileTab", linkedStart);
  assert.ok(linkedStart >= 0 && linkedEnd > linkedStart);
  const linkedHandler = source.slice(linkedStart, linkedEnd);
  assert.doesNotMatch(linkedHandler, /enterReaderMode/);
  assert.match(linkedHandler, /embeddedReaderMode[\s\S]{0,220}window\.parent\.postMessage/);
  assert.match(linkedHandler, /type: EMBEDDED_OPEN_FILE_EVENT/);
  assert.match(source, /const handleEmbeddedFileOpen = \(event: MessageEvent\)/);
  assert.match(source, /event\.source !== embeddedIframeRef\.current\?\.contentWindow/);
  assert.match(source, /setSessionPopupFile\(\{[\s\S]{0,260}remotePeer: deviceId/);
  assert.match(source, /<ExplorerSection[\s\S]{0,900}onOpenFile=\{handleOpenFileFromExplorer\}/);
  const sidebarStart = source.indexOf("<SessionSidebar");
  const sidebarEnd = source.indexOf("/>", sidebarStart);
  assert.ok(sidebarStart >= 0 && sidebarEnd > sidebarStart);
  assert.match(source.slice(sidebarStart, sidebarEnd), /onOpenFile=\{handleOpenFileFromExplorer\}/);
  const popupStart = source.indexOf("onOpenInReaderView={(filePath, page, anchor) => {");
  const popupEnd = source.indexOf("onClose={() => setSessionPopupFile(null)}", popupStart);
  assert.ok(popupStart >= 0 && popupEnd > popupStart);
  const popupHandler = source.slice(popupStart, popupEnd);
  assert.ok(popupHandler.indexOf("handleOpenFile(") < popupHandler.indexOf("activateReaderMode(target.cwd, target.remotePeer)"), "open tab before entering Reader");
  assert.match(popupHandler, /handleOpenFile\(filePath, getFileName\(filePath\), \{[\s\S]*?remotePeer: target\.remotePeer,[\s\S]*?sourceSessionId: target\.sourceSessionId,[\s\S]*?cwd: target\.cwd,[\s\S]*?page,[\s\S]*?anchor,/);
  assert.match(popupHandler, /activateReaderMode\(target\.cwd, target\.remotePeer\);/);
});

test("mobile and remote context use actual visibility and one cwd source", () => {
  assert.match(source, /const activityExplorerContext = embeddedReaderUrl\s*\?/);
  assert.match(source, /const requestedCwd = cwdOverride\?\.trim\(\)/);
  assert.match(source, /peerOverride === activePeerIdRef\.current/);
  assert.match(source, /resolveEmbeddedContextCwd\(\{/);
  assert.match(source, /resourceSession: embeddedResourceSession/);
  assert.match(source, /activeFilePeer: activeFileTab\?\.remotePeer \?\? null/);
  assert.match(source, /selectedSession\?\.cwd/);
  assert.match(source, /const explorerContentVisible = !embeddedDeviceWorkspaceActive[\s\S]{0,220}!isMobile \|\| sidebarOpen/);
  assert.match(source, /const sessionListBlockedByExplorer = activityWorkspaceActive && embeddedWorkspaceExplorerOpen/);
  assert.match(source, /const shouldShowActivitySidebarContainer =/);
  assert.match(source, /const activitySidebarContainerVisible = mobileFullDeviceSelectorVisible \|\| shouldShowActivitySidebarContainer\(\{/);
  assert.match(source, /display: activitySidebarContainerVisible \? "flex" : "none"/);
  assert.match(source, /const shouldRenderExplorerSection =/);
  assert.match(source, /const explorerSectionRendered = !embeddedDeviceWorkspaceActive && shouldRenderExplorerSection\(\{/);
  assert.match(source, /explorerSectionRendered &&/);
  assert.match(source, /const conversationSidebarVisible = isEmbeddedSessionOnly[\s\S]{0,160}parentSidebarReady && parentSidebarOpen/);
  assert.match(source, /parentSidebarReady/);
  assert.match(source, /const parseEmbeddedParentSidebarToggle =/);
  assert.match(source, /typeof message\.open !== "boolean"/);
  assert.match(source, /typeof message\.openDrawer !== "boolean"/);
  assert.match(source, /openDrawer: command\.openDrawer/);
  assert.match(source, /setSidebarOpen\(!mobile \|\| options\.openDrawer !== false \? visible : false\)/);
  assert.match(source, /openDrawer: sidebarOpen/);
  assert.match(source, /const \[parentSidebarDrawerOpen, setParentSidebarDrawerOpen\] = useState\(false\)/);
  assert.match(source, /setParentSidebarDrawerOpen\(typeof data\.openDrawer === "boolean" \? data\.openDrawer : data\.open\)/);
  assert.match(source, /setSessionListOpen\(visible\)/);
  assert.match(source, /const resolveActiveFileCwd =/);
  assert.match(source, /An explicit tab context owns its own path\/device/);
});

test("markdown TOC toggle sits inside file-viewer toolbar", async () => {
  const fileViewer = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");
  assert.match(fileViewer, /aria-label=\{t\("toc\.title"\)\}/);
  assert.ok(!/<span>目录<\/span>/.test(fileViewer), "TOC is icon-only; text moved to title tooltip");
});
