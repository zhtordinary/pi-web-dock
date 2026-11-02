import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { resolveMainlineFileContext } from "../lib/file-context.ts";

const appPath = process.env.READER_NAVIGATION_SOURCE || new URL("./AppShell.tsx", import.meta.url);
function parse(name) {
  return ts.createSourceFile(name, readFileSync(name === "./AppShell.tsx" ? appPath : new URL(name, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
const app = parse("./AppShell.tsx");
const activityFile = parse("./SessionActivityPanel.tsx");
const appSource = readFileSync(appPath, "utf8");
function find(root, predicate) {
  if (predicate(root)) return root;
  return ts.forEachChild(root, (node) => find(node, predicate));
}
function declaration(name) {
  const node = find(app, (node) => ts.isVariableDeclaration(node) && node.name.getText(app) === name);
  assert.ok(node, name);
  return node.initializer.getText(app);
}
function evaluate(code, scope) {
  const js = ts.transpileModule(`(${code})`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText.trim().replace(/;$/, "");
  return new Function("scope", `with (scope) { return ${js}; }`)(scope);
}

function workspaceOwnerResolver() {
  const node = find(app, (candidate) => ts.isVariableDeclaration(candidate) && candidate.name.getText(app) === "resolveWorkspaceOwner");
  assert.ok(node, "workspace owner pair resolver must exist before verifying cwd/peer ownership");
  const scope = {};
  scope.resolveEmbeddedContextCwd = evaluate(declaration("resolveEmbeddedContextCwd"), scope);
  return evaluate(node.initializer.getText(app), scope);
}
function harness({ mobile = false, cwd = "/project", embedded = false, parentReady = true, parentSessionListOpen = true } = {}) {
  const state = {
    readerMode: false,
    undefined,
    embeddedReaderUrl: embedded ? "https://device.test/" : null,
    embeddedResourceSession: null,
    embeddedSessionKey: null,
    embeddedDeviceId: null,
    embeddedIframeSessionId: null,
    embeddedScopeAll: false,
    aggregateWorkspaceActive: false,
    hiddenView: false,
    favoritesView: false,
    embeddedDeviceWorkspaceActive: false,
    embeddedModalOpen: false,
    embeddedModalKind: null,
    embeddedFileViewerOpen: false,
    embeddedExplorerTakesLeftLayout: false,
    embeddedIframeRef: { current: embedded ? { contentWindow: {} } : null },
    embeddedIframeReadyRef: { current: parentReady },
    embeddedSessionRequestSerialRef: { current: 0 },
    embeddedSessionRequestTimerRef: { current: null },
    activeNewSessionDraftKeyRef: { current: null },
    remoteNewSessionDraftKeyRef: { current: null },
    EMBEDDED_LAYOUT_STATE_EVENT: "pi-web:layout-state",
    EMBEDDED_PARENT_SIDEBAR_TOGGLE_EVENT: "pi-web:parent-sidebar-toggle",
    EMBEDDED_PARENT_SIDEBAR_REQUEST_EVENT: "pi-web:parent-sidebar-request",
    EMBEDDED_PARENT_SIDEBAR_STATE_EVENT: "pi-web:parent-sidebar-state",
    EMBEDDED_OPEN_SESSION_REQUEST_EVENT: "pi-web:open-session-request",
    EMBEDDED_NEW_SESSION_EVENT: "pi-web:new-session",
    EMBEDDED_ACTIVITY_SIDEBAR_PARAM: "piWebActivitySidebar",
    hasLegacyWorkspaceLayout: (params) => params.get("monitor") === "on" || params.get("fullview") === "1",
    fixedConversationSidebarVisible: true,
    fixedConversationSidebarPreference: "show",
    sidebarOpen: !mobile,
    sessionListOpen: true,
    sessionSidebarExplorerOpen: false,
    activityExplorerOpen: false,
    embeddedWorkspaceExplorerOpen: false,
    embeddedWorkspaceExplorerVisible: false,
    explorerSectionOpen: false,
    explorerContentVisible: false,
    conversationSidebarVisible: true,
    isEmbeddedSessionOnly: embedded,
    sessionListBlockedByExplorer: false,
    parentSidebarReady: parentReady,
    rightPanelOpen: false,
    activeTopPanel: "activity",
    activitySidebarMode: false,
    activityWorkspaceActive: false,
    sessionOnlyMode: embedded,
    sidebarOnlyMode: false,
    embeddedReaderMode: embedded,
    isEmbeddedSessionOnly: embedded,
    parentSidebarOpen: true,
    parentSidebarDrawerOpen: false,
    parentPhysicalSidebarOpen: !mobile,
    parentSidebarReady: parentReady,
    isMobile: mobile,
    activityExplorerCwd: cwd,
    selectedSession: cwd ? { id: "current-session", cwd } : null,
    remoteSession: null,
    newSessionCwd: null,
    activeCwdRef: { current: cwd },
    activeFileTabCwdRef: { current: null },
    activeFileTabPeerRef: { current: null },
    activePeerIdRef: { current: embedded ? "device-1" : undefined },
    localDeviceId: "device-1",
    resourceToolbarOwnedByParent: false,
    closeTalkMap: () => {},
    applyActivityArchiveView: () => {},
    handleSelectSession: () => {},
    markActivitySessionViewed: () => {},
    router: { replace: () => {} },
    searchParams: new URLSearchParams(),
    activityExplorerCwdRef: { current: cwd },
    activityExplorerPeerRef: { current: embedded ? "device-1" : undefined },
    manualFileContextRef: { current: null },
    manualFileContext: null,
    pendingAgentSelectionRef: { current: null },
    terminalTabs: [],
    fileTabs: [{ id: "file-1", filePath: "README.md" }],
    activeFileTabId: "file-1",
    openedFiles: [],
    handleOpenFile: (filePath, fileName, options) => {
      state.openedFiles.push({ filePath, fileName, options });
    },
    resolveMainlineFileContext,
    updateManualFileContext: (context) => { state.manualFileContext = context; state.manualFileContextRef.current = context; },
    confirmResult: true,
    translate: (key) => key,
    writeFixedConversationSidebarPreference: () => {},
    timerCallbacks: new Map(),
    clearedTimerIds: [],
    nextTimerId: 1,
    window: {
      confirm: () => state.confirmResult,
      location: { origin: "https://parent.test/" },
      setTimeout: (callback) => {
        const id = state.nextTimerId++;
        state.timerCallbacks.set(id, callback);
        return id;
      },
      clearTimeout: (id) => {
        state.clearedTimerIds.push(id);
      },
    },
    confirmDiscardFileChanges: (tab) => !tab?.dirty || state.confirmResult,

    useCallback: (fn) => fn,
    isMobileViewport: () => mobile,
    updateFixedConversationSidebarVisibility: (visible, options = {}) => {
      state.fixedConversationSidebarVisible = visible;
      if (options.persist !== false) state.fixedConversationSidebarPreference = visible ? "show" : "hide";
      state.sidebarOpen = mobile ? state.sidebarOpen : visible;
      state.sessionListOpen = visible;
    },
    toggleParentSidebar: (open, options = {}) => {
      if (!parentReady) return false;
      const message = {
        type: "pi-web:parent-sidebar-toggle",
        ...(typeof open === "boolean" ? { open } : {}),
        ...(typeof options.openDrawer === "boolean" ? { openDrawer: options.openDrawer } : {}),
      };
      state.parentMessages.push(message);
      state.applyParentSidebarMessage({
        source: state.embeddedIframeRef.current?.contentWindow,
        data: message,
      });
      return true;
    },
    closeFilePreview: () => { state.rightPanelOpen = false; },
    setHiddenView: (value) => { state.hiddenView = typeof value === "function" ? value(state.hiddenView) : value; },
    setFavoritesView: (value) => { state.favoritesView = typeof value === "function" ? value(state.favoritesView) : value; },
    setToDiscussView: (value) => { state.toDiscussView = typeof value === "function" ? value(state.toDiscussView) : value; },
    setToReviseView: (value) => { state.toReviseView = typeof value === "function" ? value(state.toReviseView) : value; },
    setCompletedView: (value) => { state.completedView = typeof value === "function" ? value(state.completedView) : value; },
    setActivitySidebarMode: (value) => { state.activitySidebarMode = typeof value === "function" ? value(state.activitySidebarMode) : value; },
    setEmbeddedSessionKey: (value) => { state.embeddedSessionKey = typeof value === "function" ? value(state.embeddedSessionKey) : value; },
    setEmbeddedResourceSession: (value) => { state.embeddedResourceSession = typeof value === "function" ? value(state.embeddedResourceSession) : value; },
    setEmbeddedDeviceId: (value) => { state.embeddedDeviceId = typeof value === "function" ? value(state.embeddedDeviceId) : value; },
    setEmbeddedIframeSessionId: (value) => { state.embeddedIframeSessionId = typeof value === "function" ? value(state.embeddedIframeSessionId) : value; },
    setEmbeddedScopeAll: (value) => { state.embeddedScopeAll = typeof value === "function" ? value(state.embeddedScopeAll) : value; },
    setAggregateWorkspaceActive: (value) => { state.aggregateWorkspaceActive = typeof value === "function" ? value(state.aggregateWorkspaceActive) : value; },
    setEmbeddedDeviceWorkspaceActive: (value) => { state.embeddedDeviceWorkspaceActive = typeof value === "function" ? value(state.embeddedDeviceWorkspaceActive) : value; },
    setEmbeddedReaderUrl: (value) => { state.embeddedReaderUrl = typeof value === "function" ? value(state.embeddedReaderUrl) : value; },
    writeDeviceUrlCache: () => {},
    buildEmbeddedReaderUrl: (device, { sessionOnly, activitySidebar }) => `https://${device.id}.test/?${sessionOnly ? "piWebSessionOnly=1" : activitySidebar ? "piWebActivitySidebar=1" : ""}`,
    setReaderMode: (value) => { state.readerMode = typeof value === "function" ? value(state.readerMode) : value; },
    setFixedConversationSidebarPreference: (value) => { state.fixedConversationSidebarPreference = typeof value === "function" ? value(state.fixedConversationSidebarPreference) : value; },
    setFixedConversationSidebarVisible: (value) => { state.fixedConversationSidebarVisible = typeof value === "function" ? value(state.fixedConversationSidebarVisible) : value; },
    setSidebarOpen: (value) => { state.sidebarOpen = typeof value === "function" ? value(state.sidebarOpen) : value; },
    setSessionListOpen: (value) => { state.sessionListOpen = typeof value === "function" ? value(state.sessionListOpen) : value; },
    setFileTabs: (value) => { state.fileTabs = typeof value === "function" ? value(state.fileTabs) : value; },
    setTerminalTabs: (value) => { state.terminalTabs = typeof value === "function" ? value(state.terminalTabs) : value; },
    setActiveFileTabId: (value) => { state.activeFileTabId = typeof value === "function" ? value(state.activeFileTabId) : value; },
    setExplorerOpen: (value) => {
      const next = typeof value === "function" ? value(state.activityExplorerOpen) : value;
      state.sessionSidebarExplorerOpen = next;
      state.activityExplorerOpen = next;
      state.embeddedWorkspaceExplorerOpen = next;
      state.explorerSectionOpen = next;
    },
    setSessionSidebarExplorerOpen: (value) => {
      state.sessionSidebarExplorerOpen = typeof value === "function" ? value(state.sessionSidebarExplorerOpen) : value;
      if (!state.activityWorkspaceActive && !state.activitySidebarMode) state.explorerSectionOpen = state.sessionSidebarExplorerOpen;
    },
    setActivityExplorerOpen: (value) => {
      state.activityExplorerOpen = typeof value === "function" ? value(state.activityExplorerOpen) : value;
      if (!state.activityWorkspaceActive && state.activitySidebarMode) state.explorerSectionOpen = state.activityExplorerOpen;
    },
    setEmbeddedWorkspaceExplorerOpen: (value) => {
      state.embeddedWorkspaceExplorerOpen = typeof value === "function" ? value(state.embeddedWorkspaceExplorerOpen) : value;
      if (state.activityWorkspaceActive) state.explorerSectionOpen = state.embeddedWorkspaceExplorerOpen;
    },
    setEmbeddedExplorerTakesLeftLayout: (value) => {
      state.embeddedExplorerTakesLeftLayout = typeof value === "function" ? value(state.embeddedExplorerTakesLeftLayout) : value;
    },
    setRightPanelOpen: (value) => { state.rightPanelOpen = typeof value === "function" ? value(state.rightPanelOpen) : value; },
    setActiveTopPanel: (value) => { state.activeTopPanel = typeof value === "function" ? value(state.activeTopPanel) : value; },
  };
  const parentState = {
    fixedConversationSidebarVisible: !mobile,
    fixedConversationSidebarPreference: mobile ? null : "show",
    sidebarOpen: !mobile,
    sessionListOpen: parentSessionListOpen,
  };
  state.parentState = parentState;
  state.parentSidebarOpen = parentState.fixedConversationSidebarVisible && parentState.sessionListOpen;
  state.parentSidebarDrawerOpen = parentState.sidebarOpen;
  state.parentPhysicalSidebarOpen = parentState.sidebarOpen;
  const scope = new Proxy(state, {
    has: () => true,
    get: (target, key) => key === Symbol.unscopables ? undefined : key in target ? target[key] : globalThis[key] ?? key,
  });
  const parentSetters = {
    setFixedConversationSidebarPreference: (value) => { parentState.fixedConversationSidebarPreference = typeof value === "function" ? value(parentState.fixedConversationSidebarPreference) : value; },
    setFixedConversationSidebarVisible: (value) => { parentState.fixedConversationSidebarVisible = typeof value === "function" ? value(parentState.fixedConversationSidebarVisible) : value; },
    setSessionListOpen: (value) => { parentState.sessionListOpen = typeof value === "function" ? value(parentState.sessionListOpen) : value; },
    setSidebarOpen: (value) => { parentState.sidebarOpen = typeof value === "function" ? value(parentState.sidebarOpen) : value; },
  };
  const parentScope = new Proxy(state, {
    has: () => true,
    get: (target, key) => {
      if (key === Symbol.unscopables) return undefined;
      if (key === "fixedConversationSidebarVisible") return parentState.fixedConversationSidebarVisible;
      if (key === "fixedConversationSidebarPreference") return parentState.fixedConversationSidebarPreference;
      if (key === "sessionListOpen") return parentState.sessionListOpen;
      if (key === "sidebarOpen") return parentState.sidebarOpen;
      if (key in parentSetters) return parentSetters[key];
      return key in target ? target[key] : globalThis[key] ?? key;
    },
  });
  state.explorerSectionOpen = false;
  state.parentMessages = [];
  state.parseEmbeddedParentSidebarToggle = evaluate(declaration("parseEmbeddedParentSidebarToggle"), scope);
  state.updateFixedConversationSidebarVisibility = evaluate(declaration("updateFixedConversationSidebarVisibility"), scope);
  state.parentUpdateFixedConversationSidebarVisibility = evaluate(declaration("updateFixedConversationSidebarVisibility"), parentScope);
  state.applyParentSidebarMessage = (event) => {
    assert.equal(event.source, state.embeddedIframeRef.current?.contentWindow);
    const command = state.parseEmbeddedParentSidebarToggle(event.data);
    assert.ok(command, "parent sidebar command must parse");
    const visible = "open" in command
      ? Boolean(command.open)
      : !(parentState.fixedConversationSidebarVisible && parentState.sessionListOpen);
    state.parentUpdateFixedConversationSidebarVisibility(visible, {
      persist: false,
      ...(typeof command.openDrawer === "boolean" ? { openDrawer: command.openDrawer } : {}),
    });
    state.parentSidebarOpen = parentState.fixedConversationSidebarVisible && parentState.sessionListOpen;
    state.parentSidebarDrawerOpen = parentState.sidebarOpen;
    state.parentPhysicalSidebarOpen = parentState.sidebarOpen;
  };
  state.invalidateEmbeddedSessionRequest = evaluate(declaration("invalidateEmbeddedSessionRequest"), scope);
  state.workspaceRestoreInvalidations = 0;
  state.invalidateWorkspaceRestore = () => {
    state.workspaceRestoreInvalidations += 1;
    state.invalidateEmbeddedSessionRequest();
  };
  state.readEmbeddedLayoutState = evaluate(declaration("readEmbeddedLayoutState"), scope);
  state.handleEmbeddedLayoutMessage = evaluate(declaration("handleEmbeddedLayoutMessage"), scope);
  state.shouldParentYieldLeftLayout = evaluate(declaration("shouldParentYieldLeftLayout"), scope);
  state.deriveEmbeddedLeftSlotState = evaluate(declaration("deriveEmbeddedLeftSlotState"), scope);
  state.embeddedWorkspaceUrlShape = evaluate(declaration("embeddedWorkspaceUrlShape"), scope);
  state.resolveEmbeddedContextCwd = evaluate(declaration("resolveEmbeddedContextCwd"), scope);
  state.resolveWorkspaceOwner = evaluate(declaration("resolveWorkspaceOwner"), scope);
  state.resolveActiveFileCwd = evaluate(declaration("resolveActiveFileCwd"), scope);
  state.shouldShowEmbeddedDeviceSwitch = evaluate(declaration("shouldShowEmbeddedDeviceSwitch"), scope);
  state.shouldShowActivitySidebarContainer = evaluate(declaration("shouldShowActivitySidebarContainer"), scope);
  state.handleSidebarToggle = evaluate(declaration("handleSidebarToggle"), scope);
  state.shouldRenderExplorerSection = evaluate(declaration("shouldRenderExplorerSection"), scope);
  state.setExplorerForContext = evaluate(declaration("setExplorerForContext"), scope);
  state.toggleExplorer = evaluate(declaration("toggleExplorer"), scope);
  state.setReaderConversationLayout = evaluate(declaration("setReaderConversationLayout"), scope);
  state.closeExplorerContexts = evaluate(declaration("closeExplorerContexts"), scope);
  state.activateReaderMode = evaluate(declaration("activateReaderMode"), scope);
  state.enterReaderMode = evaluate(declaration("enterReaderMode"), scope);
  state.exitReaderMode = evaluate(declaration("exitReaderMode"), scope);
  state.toggleReaderMode = evaluate(declaration("toggleReaderMode"), scope);
  state.clearFileTabsLayout = evaluate(declaration("clearFileTabsLayout"), scope);
  state.handleCloseFileTab = evaluate(declaration("handleCloseFileTab"), scope);
  state.handleCloseAllFileTabs = evaluate(declaration("handleCloseAllFileTabs"), scope);
  state.handleOpenFileFromExplorer = evaluate(declaration("handleOpenFileFromExplorer"), scope);
  state.handleChangeActivityDevice = evaluate(declaration("handleChangeActivityDevice"), scope);
  state.toggleRightPanel = evaluate(declaration("toggleRightPanel"), scope);
  return { state, scope };
}

function localVector(state, mobile = false) {
  return {
    a: mobile
      ? Boolean(state.sidebarOpen && state.sessionListOpen)
      : Boolean(state.fixedConversationSidebarVisible && state.sessionListOpen),
    b: Boolean(state.sessionSidebarExplorerOpen),
    c: Boolean(state.readerMode),
    d: Boolean(state.rightPanelOpen),
  };
}


test("workspace owner rejects stale tab cwd for a new remote peer", () => {
  const h = harness({ cwd: "/local/project" });
  const cwd = h.state.resolveActiveFileCwd({
    tabCwd: "/device-A/project",
    tabPeer: "device-A",
    activePeer: "device-B",
    remoteSessionPeer: "device-B",
    remoteSessionCwd: "/device-B/project",
    localCwd: "/local/project",
  });
  assert.equal(cwd, null, "workspace pair must reject device-A cwd when the active peer is device-B");
});

test("workspace owner keeps a remote owner closed when cwd is missing", () => {
  const resolveWorkspaceOwner = workspaceOwnerResolver();
  assert.deepEqual(resolveWorkspaceOwner({
    embeddedReaderUrl: false,
    activePeer: "device-B",
    embeddedResourceSession: null,
    remoteSessionPeer: "device-B",
    remoteSessionCwd: null,
    activeFilePeer: null,
    activeFileCwd: null,
    selectedSessionCwd: "/local/project",
    newSessionCwd: null,
    activeCwd: "/local/project",
  }), { cwd: null, remotePeer: null });
});

test("workspace owner pairs matching embedded cwd and peer", () => {
  const resolveWorkspaceOwner = workspaceOwnerResolver();
  assert.deepEqual(resolveWorkspaceOwner({
    embeddedReaderUrl: true,
    activePeer: "device-B",
    embeddedResourceSession: { deviceId: "device-A", cwd: "/device-A/project" },
    remoteSessionPeer: null,
    remoteSessionCwd: null,
    activeFilePeer: "device-B",
    activeFileCwd: "/device-B/project",
    selectedSessionCwd: "/local/project",
    newSessionCwd: null,
    activeCwd: "/local/project",
  }), { cwd: "/device-B/project", remotePeer: "device-B" });
});

test("workspace owner matrix covers remote drafts, restores, forks, switches and local fallback", () => {
  const resolveWorkspaceOwner = workspaceOwnerResolver();
  const base = {
    embeddedReaderUrl: false,
    activePeer: null,
    embeddedResourceSession: null,
    remoteSessionPeer: null,
    remoteSessionCwd: null,
    activeFilePeer: null,
    activeFileCwd: null,
    selectedSessionCwd: null,
    newSessionCwd: null,
    activeCwd: null,
  };
  const cases = [
    ["remote draft", { ...base, activePeer: "device-B", remoteSessionPeer: "device-B", remoteSessionCwd: "/device-B/draft" }, { cwd: "/device-B/draft", remotePeer: "device-B" }],
    ["existing remote session", { ...base, activePeer: "device-B", remoteSessionPeer: "device-B", remoteSessionCwd: "/device-B/session" }, { cwd: "/device-B/session", remotePeer: "device-B" }],
    ["session-only URL restore", { ...base, embeddedReaderUrl: true, activePeer: "device-B", embeddedResourceSession: { deviceId: "device-B", cwd: "/device-B/restored" } }, { cwd: "/device-B/restored", remotePeer: "device-B" }],
    ["remote fork Reader context", { ...base, embeddedReaderUrl: true, activePeer: "device-B", activeFilePeer: "device-B", activeFileCwd: "/device-B/fork" }, { cwd: "/device-B/fork", remotePeer: "device-B" }],
    ["stale device switch tab", { ...base, embeddedReaderUrl: true, activePeer: "device-B", activeFilePeer: "device-A", activeFileCwd: "/device-A/old" }, { cwd: null, remotePeer: null }],
    ["local selected/new/active fallback", { ...base, selectedSessionCwd: "/local/selected", newSessionCwd: "/local/new", activeCwd: "/local/active" }, { cwd: "/local/selected", remotePeer: null }],
  ];
  for (const [name, input, expected] of cases) assert.deepEqual(resolveWorkspaceOwner(input), expected, String(name));
});

test("resource toolbar owner uses the production workspace pair for embedded sessions", () => {
  const resolveWorkspaceOwner = workspaceOwnerResolver();
  assert.deepEqual(resolveWorkspaceOwner({
    embeddedReaderUrl: true,
    activePeer: "device-B",
    embeddedResourceSession: { deviceId: "device-B", sessionId: "session-B", cwd: "/device-B/project", path: "/device-B/.pi/session.jsonl" },
    remoteSessionPeer: null,
    remoteSessionCwd: null,
    activeFilePeer: null,
    activeFileCwd: null,
    selectedSessionCwd: "/local/project",
    newSessionCwd: null,
    activeCwd: "/local/project",
  }), { cwd: "/device-B/project", remotePeer: "device-B" });
});

test("Explorer context uses the production workspace pair and fails closed without remote cwd", () => {
  const h = harness({ cwd: null, embedded: true });
  h.state.activityWorkspaceActive = true;
  h.state.embeddedResourceSession = {
    deviceId: "device-1",
    sessionId: "session-1",
    cwd: "/device-1/project",
    path: "/device-1/.pi/session.jsonl",
  };
  h.state.setExplorerForContext(true);
  assert.equal(h.state.embeddedWorkspaceExplorerOpen, true);
  h.state.embeddedResourceSession = null;
  h.state.setExplorerForContext(false);
  h.state.setExplorerForContext(true);
  assert.equal(h.state.embeddedWorkspaceExplorerOpen, false);
});

test("session A placement matrix has one deterministic owner and reserves A/B/C order", () => {
  const place = evaluate(declaration("deriveSessionControlPlacement"), {});
  const reserve = evaluate(declaration("shouldReserveParentSessionControlSlot"), {});
  const base = {
    nestedSessionOnlyFrame: false,
    sidebarHeaderVisible: false,
    sidebarShellOpen: true,
    activityToolbarAvailable: false,
    explorerToolbarAvailable: true,
    topBarAvailable: true,
    rightPanelAvailable: true,
    recoveryAvailable: true,
    embeddedOverlayAvailable: false,
  };
  assert.equal(place({ ...base, sidebarHeaderVisible: true }), "sidebar-header");
  assert.equal(place({ ...base }), "explorer-toolbar");
  assert.equal(place({ ...base, sidebarShellOpen: false }), "top-bar");
  assert.equal(place({ ...base, activityToolbarAvailable: true }), "activity-toolbar");
  assert.equal(place({ ...base, sidebarShellOpen: false, topBarAvailable: false, embeddedOverlayAvailable: true }), "embedded-overlay");
  assert.equal(place({ ...base, sidebarShellOpen: false, topBarAvailable: false }), "right-panel");
  assert.equal(place({ ...base, sidebarShellOpen: false, topBarAvailable: false, rightPanelAvailable: false }), "recovery");
  assert.equal(place({ ...base, nestedSessionOnlyFrame: true }), "hidden");
  assert.equal(place({ ...base, sidebarShellOpen: false, topBarAvailable: false, rightPanelAvailable: false, recoveryAvailable: false }), "hidden");
  assert.equal(reserve({ nestedSessionOnlyFrame: false, parentSidebarReady: true, parentSidebarOpen: false, parentSidebarDrawerOpen: false, isMobile: false }), false);
  assert.equal(reserve({ nestedSessionOnlyFrame: true, parentSidebarReady: false, parentSidebarOpen: false, parentSidebarDrawerOpen: false, isMobile: false }), false);
  assert.equal(reserve({ nestedSessionOnlyFrame: true, parentSidebarReady: true, parentSidebarOpen: true, parentSidebarDrawerOpen: true, isMobile: false }), false);
  assert.equal(reserve({ nestedSessionOnlyFrame: true, parentSidebarReady: true, parentSidebarOpen: false, parentSidebarDrawerOpen: false, isMobile: false }), true);
  assert.equal(reserve({ nestedSessionOnlyFrame: true, parentSidebarReady: true, parentSidebarOpen: true, parentSidebarDrawerOpen: false, isMobile: true }), true);
  assert.equal(reserve({ nestedSessionOnlyFrame: true, parentSidebarReady: true, parentSidebarOpen: true, parentSidebarDrawerOpen: true, isMobile: true }), false);
  assert.equal(reserve({ nestedSessionOnlyFrame: true, parentSidebarReady: true, parentSidebarOpen: false, parentSidebarDrawerOpen: false, isMobile: false, sidebarShellOpen: true }), false);
  assert.match(appSource, /data-layout-control-group="leading"/);
  assert.match(appSource, /sessionControlPlacement === "top-bar" && renderLayoutControl\("sessions", "top"\)/);
});

test("Explorer visibility shares one intent across sidebar contexts", () => {
  assert.match(appSource, /const \[explorerOpen, setExplorerOpen\] = useState\(\(\) => !activitySidebarMode && !isEmbeddedSessionOnly\);/);
  assert.match(appSource, /const sessionSidebarExplorerOpen = explorerOpen;/);
  assert.match(appSource, /const activityExplorerOpen = explorerOpen;/);
  assert.match(appSource, /const embeddedWorkspaceExplorerOpen = explorerOpen;/);
  assert.doesNotMatch(appSource, /if \(!activityWorkspaceActive\) setEmbeddedWorkspaceExplorerOpen\(false\);/);
});

test("cross-device Explorer closes only for the actual iframe navigation path", () => {
  assert.match(appSource, /const isLocalSession = item\.device\.id === localDeviceId;/);
  assert.doesNotMatch(appSource, /const remoteSessionInShell/);
  assert.match(appSource, /if \(!embeddedUrl\) return false;\s+setExplorerOpen\(false\);/);
  assert.match(appSource, /setExplorerOpen\(false\);\s+embeddedIframeRef\.current\.contentWindow\.postMessage\(/);
  assert.match(appSource, /setExplorerOpen\(false\);\s+setEmbeddedResourceSession\(\{/);
});

test("trusted full-device layout callback drives parent slot ownership and DOM model", () => {
  const h = harness();
  const iframeSource = {};
  h.state.embeddedIframeRef.current = { contentWindow: iframeSource };
  const valid = { source: iframeSource, data: { type: "pi-web:layout-state", takesLeftLayout: true } };
  h.state.handleEmbeddedLayoutMessage(valid);
  let takesLeftLayout = h.state.embeddedExplorerTakesLeftLayout;
  assert.equal(takesLeftLayout, true);
  const ownedMobile = h.state.deriveEmbeddedLeftSlotState({
    embeddedDeviceWorkspaceActive: true,
    readerMode: false,
    takesLeftLayout,
    isMobile: true,
    sidebarOpen: true,
    sidebarShellOpen: true,
  });
  assert.deepEqual(ownedMobile, {
    ownsLeftLayout: true,
    sidebarShellOpen: false,
    mobileBackdropVisible: false,
  });
  h.state.handleEmbeddedLayoutMessage({
    source: iframeSource,
    data: { type: "pi-web:layout-state", takesLeftLayout: false },
  });
  takesLeftLayout = h.state.embeddedExplorerTakesLeftLayout;
  const releasedMobile = h.state.deriveEmbeddedLeftSlotState({
    embeddedDeviceWorkspaceActive: true,
    readerMode: false,
    takesLeftLayout,
    isMobile: true,
    sidebarOpen: true,
    sidebarShellOpen: true,
  });
  assert.deepEqual(releasedMobile, {
    ownsLeftLayout: false,
    sidebarShellOpen: true,
    mobileBackdropVisible: true,
  });
  h.state.handleEmbeddedLayoutMessage({
    source: {},
    data: { type: "pi-web:layout-state", takesLeftLayout: true },
  });
  assert.equal(h.state.embeddedExplorerTakesLeftLayout, false);
  h.state.handleEmbeddedLayoutMessage({
    source: iframeSource,
    data: { type: "pi-web:layout-state", takesLeftLayout: "yes" },
  });
  assert.equal(h.state.embeddedExplorerTakesLeftLayout, false);
  assert.equal(h.state.readEmbeddedLayoutState({
    source: {},
    data: { type: "pi-web:layout-state", takesLeftLayout: true },
  }, iframeSource), null);
  assert.equal(h.state.readEmbeddedLayoutState({
    source: iframeSource,
    data: { type: "pi-web:layout-state", takesLeftLayout: "yes" },
  }, iframeSource), null);
  const parentReader = h.state.deriveEmbeddedLeftSlotState({
    embeddedDeviceWorkspaceActive: true,
    readerMode: true,
    takesLeftLayout: true,
    isMobile: false,
    sidebarOpen: false,
    sidebarShellOpen: true,
  });
  assert.deepEqual(parentReader, {
    ownsLeftLayout: false,
    sidebarShellOpen: true,
    mobileBackdropVisible: false,
  });
});

test("device session URL marker distinguishes full-device from session-only restore", () => {
  const h = harness();
  assert.equal(h.state.embeddedWorkspaceUrlShape(new URLSearchParams("device=device-1&session=session-1&piWebActivitySidebar=1")), "full-device");
  assert.equal(h.state.embeddedWorkspaceUrlShape(new URLSearchParams("device=device-1&session=session-1")), "session-only");
  assert.equal(h.state.embeddedWorkspaceUrlShape(new URLSearchParams("device=device-1")), "device-only");
  assert.equal(h.state.embeddedWorkspaceUrlShape(new URLSearchParams("device=device-1&session=session-1&monitor=on")), "full-device");
});

test("C uses embedded resource cwd when local cwd is absent", () => {
  const h = harness({ cwd: null, embedded: true });
  h.state.embeddedResourceSession = {
    deviceId: "device-1",
    sessionId: "session-1",
    cwd: "/remote/project",
    path: "/remote/project/.pi/session.jsonl",
  };
  h.state.activeCwdRef.current = null;
  h.state.enterReaderMode();
  assert.equal(h.state.readerMode, true);
  assert.equal(h.state.sessionSidebarExplorerOpen, true);
  assert.equal(h.state.rightPanelOpen, true);
});

test("parent Reader opens Explorer from file cwd before active tab state commits", () => {
  const h = harness({ cwd: null, embedded: true });
  h.state.embeddedResourceSession = null;
  h.state.activeCwdRef.current = null;
  h.state.activateReaderMode("/remote/project");
  assert.equal(h.state.readerMode, true);
  assert.equal(h.state.sessionSidebarExplorerOpen, true);
  assert.equal(h.state.rightPanelOpen, true);
});

test("embedded Explorer file opens inherit current cwd and peer before Reader activation", () => {
  const h = harness({ cwd: null, embedded: true });
  h.state.activePeerIdRef.current = "device-1";
  h.state.activityExplorerCwdRef.current = "/remote/project";
  h.state.handleOpenFileFromExplorer("docs/next.md", "next.md");
  assert.deepEqual(h.state.openedFiles, [{
    filePath: "docs/next.md",
    fileName: "next.md",
    options: { remotePeer: "device-1", cwd: "/remote/project", projectRoot: "/remote/project" },
  }]);
  assert.equal(h.state.readerMode, true);
  assert.equal(h.state.sessionSidebarExplorerOpen, true);
});

test("embedded Reader does not borrow local cwd when remote resource cwd is absent", () => {
  const h = harness({ cwd: "/local/project", embedded: true });
  h.state.embeddedResourceSession = null;
  h.state.activeCwdRef.current = "/local/project";
  h.state.enterReaderMode();
  assert.equal(h.state.readerMode, true);
  assert.equal(h.state.sessionSidebarExplorerOpen, false);
  assert.equal(h.state.rightPanelOpen, true);
});

test("embedded Explorer file without cwd keeps remote tab context unavailable instead of using local cwd", () => {
  const h = harness({ cwd: "/local/project", embedded: true });
  h.state.embeddedResourceSession = null;
  h.state.activePeerIdRef.current = "device-1";
  h.state.activityExplorerCwdRef.current = null;
  h.state.activeCwdRef.current = "/local/project";
  h.state.handleOpenFileFromExplorer("docs/no-cwd.md", "no-cwd.md");
  assert.deepEqual(h.state.openedFiles, [], "remote file actions without a source cwd must not create an ownerless tab");
  assert.equal(h.state.readerMode, false);
  assert.equal(h.state.sessionSidebarExplorerOpen, false);
});

test("outer embedded B opens parent Explorer after D leaves Reader", () => {
  const h = harness({ cwd: "/remote/project" });
  h.state.embeddedReaderUrl = "https://device.test/";
  h.state.activitySidebarMode = true;
  h.state.activityWorkspaceActive = false;
  h.state.activePeerIdRef.current = "device-1";
  h.state.embeddedResourceSession = {
    deviceId: "device-1",
    sessionId: "session-1",
    cwd: "/remote/project",
    path: null,
  };
  h.state.readerMode = false;
  h.state.toggleExplorer();
  assert.equal(h.state.activityExplorerOpen, true);
  assert.equal(h.state.explorerSectionOpen, true);
  assert.equal(h.state.shouldRenderExplorerSection({
    explorerSectionOpen: h.state.explorerSectionOpen,
    activityExplorerCwd: h.state.activityExplorerCwdRef.current,
  }), true);
});

test("device switch invalidates and clears in-place activity-session fallback before old timer runs", () => {
  const h = harness({ cwd: "/device-A/project" });
  const posted = [];
  h.state.embeddedDeviceId = "device-A";
  h.state.embeddedSessionKey = "device-A:session-old";
  h.state.embeddedReaderUrl = "https://device-a.test/";
  h.state.embeddedIframeReadyRef.current = true;
  h.state.embeddedIframeRef.current = {
    contentWindow: {
      postMessage: (message) => posted.push(message),
    },
  };
  const buildCalls = [];
  h.state.buildEmbeddedReaderUrl = (...args) => {
    buildCalls.push(args);
    return `https://${args[0].id}.test/?${args[2] ? "piWebSessionOnly=1" : "piWebActivitySidebar=1"}`;
  };
  h.state.handleOpenActivitySession = evaluate(declaration("handleOpenActivitySession"), h.scope);
  const itemA = {
    device: { id: "device-A", url: "https://device-a.test/" },
    session: { id: "session-A", cwd: "/device-A/project", path: null },
  };

  h.state.handleOpenActivitySession(itemA);
  assert.equal(posted.length, 1);
  assert.equal(h.state.embeddedSessionRequestTimerRef.current, 1);
  const serialAfterRequest = h.state.embeddedSessionRequestSerialRef.current;
  const oldTimer = h.state.timerCallbacks.get(1);
  assert.equal(typeof oldTimer, "function");

  h.state.handleChangeActivityDevice({ id: "device-B", url: "https://device-b.test/" });
  assert.equal(h.state.embeddedDeviceId, "device-B");
  assert.equal(h.state.embeddedSessionRequestTimerRef.current, null);
  assert.deepEqual(h.state.clearedTimerIds, [1]);
  assert.equal(h.state.embeddedSessionRequestSerialRef.current, serialAfterRequest + 1);
  const buildCallsAfterDeviceChange = buildCalls.length;

  oldTimer();
  assert.equal(buildCalls.length, buildCallsAfterDeviceChange, "cleared stale timer must not fallback to session A");
  assert.equal(h.state.embeddedDeviceId, "device-B");
  assert.equal(h.state.embeddedSessionKey, null);
});

test("new embedded draft invalidates an old in-place session fallback timer", () => {
  const h = harness({ cwd: "/device-A/project" });
  const posted = [];
  h.state.embeddedDeviceId = "device-A";
  h.state.embeddedSessionKey = "device-A:session-old";
  h.state.embeddedReaderUrl = "https://device-a.test/";
  h.state.embeddedIframeReadyRef.current = true;
  h.state.embeddedIframeRef.current = {
    contentWindow: {
      postMessage: (message) => posted.push(message),
    },
  };
  const buildCalls = [];
  h.state.buildEmbeddedReaderUrl = (...args) => {
    buildCalls.push(args);
    return `https://${args[0].id}.test/?${args[2] ? "piWebSessionOnly=1" : "piWebActivitySidebar=1"}`;
  };
  h.state.handleOpenActivitySession = evaluate(declaration("handleOpenActivitySession"), h.scope);
  h.state.handleNewSessionMessage = evaluate(declaration("handleNewSessionMessage"), h.scope);
  const itemA = {
    device: { id: "device-A", url: "https://device-a.test/" },
    session: { id: "session-A", cwd: "/device-A/project", path: null },
  };

  h.state.handleOpenActivitySession(itemA);
  assert.equal(posted.length, 1);
  assert.equal(h.state.embeddedSessionRequestTimerRef.current, 1);
  const serialAfterRequest = h.state.embeddedSessionRequestSerialRef.current;
  const oldTimer = h.state.timerCallbacks.get(1);
  assert.equal(typeof oldTimer, "function");

  h.state.handleNewSessionMessage({
    source: h.state.embeddedIframeRef.current.contentWindow,
    data: {
      type: "pi-web:new-session",
      cwd: "/device-A/project",
      subprojectId: "draft-subproject",
      subprojectLabel: "Draft",
    },
  });
  assert.equal(h.state.embeddedSessionRequestSerialRef.current, serialAfterRequest + 1);
  assert.equal(h.state.embeddedSessionRequestTimerRef.current, null);
  assert.deepEqual(h.state.clearedTimerIds, [1]);
  assert.equal(h.state.embeddedSessionKey, "device-A:new:/device-A/project:subproject:draft-subproject:label:Draft");
  assert.deepEqual(h.state.embeddedResourceSession, {
    deviceId: "device-A",
    sessionId: null,
    cwd: "/device-A/project",
    path: null,
  });
  const buildCallsAfterDraft = buildCalls.length;

  oldTimer();
  assert.equal(buildCalls.length, buildCallsAfterDraft, "stale fallback must not rebuild session A after new draft");
  assert.equal(h.state.embeddedSessionKey, "device-A:new:/device-A/project:subproject:draft-subproject:label:Draft");
});

test("full-device parent B is disabled/no-op while ordinary embedded B renders Explorer", () => {
  const fullDevice = harness({ cwd: "/device-A/project" });
  fullDevice.state.embeddedDeviceWorkspaceActive = true;
  fullDevice.state.explorerSectionOpen = true;
  fullDevice.state.explorerContentVisible = true;
  fullDevice.state.embeddedDeviceId = "device-A";
  fullDevice.state.activityExplorerOpen = true;
  fullDevice.state.layoutControls = evaluate(declaration("layoutControls"), fullDevice.scope);
  const fullDeviceExplorer = fullDevice.state.layoutControls.explorer;
  assert.equal(fullDeviceExplorer.disabled, true);
  assert.equal(fullDeviceExplorer.open, false);
  assert.equal(fullDeviceExplorer.title, "layout.explorerControlledByDevice");
  assert.equal(fullDeviceExplorer.ariaLabel, "layout.explorerControlledByDevice");
  fullDeviceExplorer.onClick();
  assert.equal(fullDevice.state.activityExplorerOpen, true, "full-device parent B click must be no-op");
  assert.equal(evaluate(declaration("explorerSectionRendered"), fullDevice.scope), false);

  const ordinaryEmbedded = harness({ cwd: "/remote/project", embedded: true });
  ordinaryEmbedded.state.embeddedDeviceWorkspaceActive = false;
  ordinaryEmbedded.state.explorerSectionOpen = true;
  ordinaryEmbedded.state.explorerContentVisible = true;
  ordinaryEmbedded.state.layoutControls = evaluate(declaration("layoutControls"), ordinaryEmbedded.scope);
  const ordinaryExplorer = ordinaryEmbedded.state.layoutControls.explorer;
  assert.equal(ordinaryExplorer.disabled, false);
  assert.equal(ordinaryExplorer.open, true);
  assert.equal(evaluate(declaration("explorerSectionRendered"), ordinaryEmbedded.scope), true);
});

test("full-device device selection keeps switch reachable when sidebar is hidden", () => {
  const h = harness({ cwd: null });
  h.state.fixedConversationSidebarVisible = false;
  h.state.fixedConversationSidebarPreference = "hide";
  h.state.sidebarOpen = false;
  h.state.embeddedExplorerTakesLeftLayout = false;
  h.state.handleChangeActivityDevice({ id: "device-B", url: "https://device-b.test/" });
  assert.equal(h.state.embeddedDeviceWorkspaceActive, true);
  assert.equal(h.state.embeddedDeviceId, "device-B");
  assert.match(h.state.embeddedReaderUrl, /device-B/);
  assert.equal(h.state.sidebarOpen, false);
  const selectorOverlay = h.state.shouldShowEmbeddedDeviceSwitch({
    embeddedDeviceWorkspaceActive: h.state.embeddedDeviceWorkspaceActive,
    readerMode: false,
    isMobile: false,
    takesLeftLayout: h.state.embeddedExplorerTakesLeftLayout,
  });
  const selectorWrapperDisplay = h.state.shouldShowActivitySidebarContainer({
    conversationSidebarVisible: false,
    embeddedDeviceWorkspaceActive: h.state.embeddedDeviceWorkspaceActive,
    readerMode: false,
    isMobile: false,
    takesLeftLayout: h.state.embeddedExplorerTakesLeftLayout,
  }) ? "flex" : "none";
  assert.equal(selectorOverlay, true);
  assert.equal(selectorWrapperDisplay, "flex");
  assert.equal(selectorOverlay && selectorWrapperDisplay !== "none", true);
  assert.equal(h.state.shouldShowActivitySidebarContainer({
    conversationSidebarVisible: false,
    embeddedDeviceWorkspaceActive: true,
    readerMode: false,
    isMobile: false,
    takesLeftLayout: true,
  }), false);
});

test("mobile full-device selector restores container after A is closed", () => {
  const h = harness({ mobile: true, cwd: null });
  h.state.sidebarOpen = true;
  h.state.sessionListOpen = true;
  h.state.handleSidebarToggle();
  assert.equal(h.state.sidebarOpen, false);
  assert.equal(h.state.sessionListOpen, false);
  h.state.handleChangeActivityDevice({ id: "device-B", url: "https://device-b.test/" });
  assert.equal(h.state.embeddedDeviceWorkspaceActive, true);
  assert.equal(h.state.sidebarOpen, true);
  assert.equal(h.state.sessionListOpen, true);
  const selectorWrapperDisplay = h.state.shouldShowActivitySidebarContainer({
    conversationSidebarVisible: true,
    embeddedDeviceWorkspaceActive: h.state.embeddedDeviceWorkspaceActive,
    readerMode: false,
    isMobile: true,
    takesLeftLayout: false,
  }) ? "flex" : "none";
  assert.equal(selectorWrapperDisplay, "flex");
  assert.equal(h.state.shouldShowEmbeddedDeviceSwitch({
    embeddedDeviceWorkspaceActive: true,
    readerMode: false,
    isMobile: true,
    takesLeftLayout: false,
  }), false);
  assert.equal(h.state.deriveEmbeddedLeftSlotState({
    embeddedDeviceWorkspaceActive: true,
    readerMode: false,
    takesLeftLayout: true,
    isMobile: true,
    sidebarOpen: true,
    sidebarShellOpen: true,
  }).ownsLeftLayout, true);
});

test("mobile full-device selector stays reachable after backdrop close and returns after child Explorer releases", () => {
  const h = harness({ mobile: true, cwd: null });
  h.state.embeddedDeviceWorkspaceActive = true;
  h.state.embeddedReaderUrl = "https://device-a.test/";
  h.state.sidebarOpen = true;
  h.state.sessionListOpen = true;
  h.state.readerMode = false;
  h.state.embeddedExplorerTakesLeftLayout = false;
  h.state.rightPanelOpen = false;
  h.state.embeddedModalOpen = false;
  h.state.embeddedFileViewerOpen = false;
  h.state.conversationSidebarVisible = true;
  h.state.embeddedLeftSlotState = {
    ownsLeftLayout: false,
    sidebarShellOpen: true,
    mobileBackdropVisible: true,
  };
  const selectorVisible = () => {
    const visible = evaluate(declaration("mobileFullDeviceSelectorVisible"), h.scope);
    h.state.mobileFullDeviceSelectorVisible = visible;
    return visible;
  };
  const containerVisible = () => evaluate(declaration("activitySidebarContainerVisible"), h.scope);
  const shellOpen = () => evaluate(declaration("sidebarShellOpen"), h.scope);

  assert.equal(selectorVisible(), true);
  assert.equal(containerVisible(), true);
  assert.equal(shellOpen(), true);

  // Simulate actual backdrop click: backdrop only closes drawer; it does not call device change.
  h.state.setSidebarOpen(false);
  h.state.conversationSidebarVisible = false;
  h.state.embeddedLeftSlotState = {
    ownsLeftLayout: false,
    sidebarShellOpen: false,
    mobileBackdropVisible: false,
  };
  assert.equal(selectorVisible(), true);
  assert.equal(containerVisible(), true, "selector wrapper must stay displayed after backdrop close");
  assert.equal(shellOpen(), true, "selector shell must stay on-screen after backdrop close");

  h.state.embeddedExplorerTakesLeftLayout = true;
  assert.equal(selectorVisible(), false, "parent selector must yield while child owns left layout");
  h.state.embeddedExplorerTakesLeftLayout = false;
  assert.equal(selectorVisible(), true, "selector must recover after child Explorer releases ownership");

  h.state.handleChangeActivityDevice({ id: "device-B", url: "https://device-b.test/" });
  assert.equal(h.state.embeddedDeviceWorkspaceActive, true);
  assert.equal(h.state.embeddedDeviceId, "device-B");
  assert.equal(h.state.sidebarOpen, true);
  assert.equal(h.state.sessionListOpen, true);
});

test("full-device device switch never binds old remote tab cwd to new peer", () => {
  const h = harness({ cwd: "/device-A/project", embedded: true });
  h.state.embeddedDeviceWorkspaceActive = true;
  h.state.activityWorkspaceActive = true;
  h.state.embeddedResourceSession = null;
  h.state.activePeerIdRef.current = "device-B";
  h.state.activeFileTabPeerRef.current = "device-A";
  h.state.activeFileTabCwdRef.current = "/device-A/project";
  assert.equal(h.state.resolveEmbeddedContextCwd({
    resourceSession: null,
    activePeer: "device-B",
    activeFilePeer: "device-A",
    activeFileCwd: "/device-A/project",
  }), null);
  assert.equal(h.state.resolveEmbeddedContextCwd({
    resourceSession: { deviceId: "device-A", sessionId: "session-A", cwd: "/device-A/project", path: null },
    activePeer: "device-B",
    activeFilePeer: null,
    activeFileCwd: null,
  }), null);
  assert.equal(h.state.resolveEmbeddedContextCwd({
    resourceSession: { deviceId: "device-B", sessionId: "session-B", cwd: "/device-B/project", path: null },
    activePeer: "device-B",
    activeFilePeer: "device-A",
    activeFileCwd: "/device-A/project",
  }), "/device-B/project");
  h.state.activeFileCwd = h.state.resolveActiveFileCwd({
    tabCwd: undefined,
    tabPeer: "device-B",
    activePeer: "device-B",
    remoteSessionPeer: "device-A",
    remoteSessionCwd: "/device-A/project",
    localCwd: "/local/project",
  });
  assert.equal(h.state.activeFileCwd, null);
  assert.equal(h.state.resolveActiveFileCwd({
    tabCwd: undefined,
    tabPeer: "device-B",
    activePeer: "device-B",
    remoteSessionPeer: "device-B",
    remoteSessionCwd: "/device-B/project",
    localCwd: "/local/project",
  }), "/device-B/project");
  h.state.activeFileTabPeerRef.current = "device-B";
  h.state.activeFileTabCwdRef.current = null;
  h.state.activityExplorerCwdRef.current = null;
  h.state.setExplorerForContext(true);
  assert.equal(h.state.embeddedWorkspaceExplorerOpen, false);
  h.state.handleOpenFileFromExplorer("docs/new-device.md", "new-device.md");
  assert.deepEqual(h.state.openedFiles, [], "device-switched remote file actions without cwd must not create an ownerless tab");
  assert.equal(h.state.readerMode, false);
  h.state.readerMode = false;
  h.state.rightPanelOpen = false;
  h.state.activateReaderMode("/device-A/project", "device-A");
  assert.equal(h.state.readerMode, true);
  assert.equal(h.state.embeddedWorkspaceExplorerOpen, false);
});

test("C enters reading layout transaction and opens Explorer when cwd exists", () => {
  const h = harness();
  h.state.enterReaderMode();
  assert.deepEqual(localVector(h.state), { a: false, b: true, c: true, d: true });
});

test("C exits reading layout, restores sessions, closes Explorer and document preview, preserves tabs", () => {
  const h = harness();
  const tabs = h.state.fileTabs;
  h.state.enterReaderMode();
  h.state.exitReaderMode();
  assert.deepEqual(localVector(h.state), { a: true, b: false, c: false, d: false });
  assert.equal(h.state.fileTabs, tabs);
});

test("A from Reader opens the activity list without changing Reader, Explorer or document", () => {
  const h = harness();
  h.state.enterReaderMode();
  h.state.handleSidebarToggle();
  assert.deepEqual(localVector(h.state), { a: true, b: true, c: true, d: true });
});

test("B toggles the shared Explorer visibility intent", () => {
  const h = harness();
  h.state.rightPanelOpen = true;
  h.state.toggleExplorer();
  assert.deepEqual(localVector(h.state), { a: true, b: true, c: false, d: true });
  h.state.toggleExplorer();
  assert.deepEqual(localVector(h.state), { a: true, b: false, c: false, d: true });
});

test("D toggles only document visibility and preserves tabs", () => {
  const h = harness();
  const tabs = h.state.fileTabs;
  h.state.toggleRightPanel();
  assert.deepEqual(localVector(h.state), { a: true, b: false, c: false, d: true });
  h.state.toggleRightPanel();
  assert.deepEqual(localVector(h.state), { a: true, b: false, c: false, d: false });
  assert.equal(h.state.fileTabs, tabs);
});

test("C enters reading layout without an active readable file", () => {
  const h = harness();
  h.state.fileTabs = [];
  h.state.activeFileTabId = null;
  h.state.toggleReaderMode();
  assert.deepEqual(localVector(h.state), { a: false, b: true, c: true, d: true });
});

test("Explorer command is no-op without cwd and never changes conversation", () => {
  const h = harness({ cwd: null });
  h.state.activeCwdRef.current = null;
  h.state.toggleExplorer();
  assert.deepEqual(localVector(h.state), { a: true, b: false, c: false, d: false });
});

test("Reader can focus document without cwd while B stays closed", () => {
  const h = harness({ cwd: null });
  h.state.enterReaderMode();
  assert.deepEqual(localVector(h.state), { a: false, b: false, c: true, d: true });
});

test("C on mobile keeps Explorer intent but closes drawer for document-first view", () => {
  const h = harness({ mobile: true });
  h.state.enterReaderMode();
  assert.equal(h.state.sessionSidebarExplorerOpen, true);
  assert.equal(h.state.sidebarOpen, false);
  assert.equal(h.state.sessionListOpen, false);
  assert.equal(h.state.readerMode, true);
  assert.equal(h.state.rightPanelOpen, true);
});

test("B on mobile opens Explorer drawer after C instead of closing intent", () => {
  const h = harness({ mobile: true });
  h.state.enterReaderMode();
  h.state.toggleExplorer();
  assert.equal(h.state.sessionSidebarExplorerOpen, true);
  assert.equal(h.state.sidebarOpen, true);
  assert.equal(h.state.readerMode, true);
  assert.equal(h.state.rightPanelOpen, true);
  h.state.toggleExplorer();
  assert.equal(h.state.sessionSidebarExplorerOpen, false);
  assert.equal(h.state.sidebarOpen, false);
  assert.equal(h.state.readerMode, true);
  assert.equal(h.state.rightPanelOpen, true);
});

test("C exit on mobile restores session intent and closes document preview", () => {
  const h = harness({ mobile: true });
  h.state.enterReaderMode();
  h.state.exitReaderMode();
  assert.equal(h.state.sessionSidebarExplorerOpen, false);
  assert.equal(h.state.sessionListOpen, true);
  assert.equal(h.state.sidebarOpen, true);
  assert.equal(h.state.readerMode, false);
  assert.equal(h.state.rightPanelOpen, false);
});

test("A on mobile opens activity drawer from Reader without changing Reader or document", () => {
  const h = harness({ mobile: true });
  h.state.enterReaderMode();
  h.state.handleSidebarToggle();
  assert.equal(h.state.readerMode, true);
  assert.equal(h.state.sessionListOpen, true);
  assert.equal(h.state.sidebarOpen, true);
  assert.equal(h.state.sessionSidebarExplorerOpen, true);
  assert.equal(h.state.rightPanelOpen, true);
});

test("B on mobile opens drawer and closing B keeps visible session list", () => {
  const h = harness({ mobile: true });
  h.state.sidebarOpen = false;
  h.state.toggleExplorer();
  assert.equal(h.state.sessionSidebarExplorerOpen, true);
  assert.equal(h.state.sidebarOpen, true);
  h.state.toggleExplorer();
  assert.equal(h.state.sessionSidebarExplorerOpen, false);
  assert.equal(h.state.sidebarOpen, true);
});

test("embedded C uses deterministic parent open values and blocks before handshake", () => {
  const h = harness({ embedded: true, parentReady: true });
  h.state.enterReaderMode();
  assert.equal(h.state.parentSidebarOpen, false);
  assert.equal(h.state.parentPhysicalSidebarOpen, false);
  assert.equal(h.state.readerMode, true);
  h.state.exitReaderMode();
  assert.equal(h.state.parentSidebarOpen, true);
  assert.equal(h.state.parentSidebarDrawerOpen, true);
  assert.equal(h.state.parentPhysicalSidebarOpen, true);
  assert.equal(h.state.readerMode, false);
  h.state.handleSidebarToggle();
  assert.equal(h.state.parentSidebarOpen, false);
  assert.equal(h.state.parentSidebarDrawerOpen, false);
  assert.equal(h.state.parentPhysicalSidebarOpen, false);
  h.state.handleSidebarToggle();
  assert.equal(h.state.parentSidebarOpen, true);
  assert.equal(h.state.parentSidebarDrawerOpen, true);
  assert.equal(h.state.parentPhysicalSidebarOpen, true);

  const mobile = harness({ embedded: true, mobile: true, parentReady: true });
  mobile.state.enterReaderMode();
  assert.equal(mobile.state.parentSidebarOpen, false);
  assert.equal(mobile.state.parentPhysicalSidebarOpen, false);
  mobile.state.exitReaderMode();
  assert.equal(mobile.state.parentSidebarOpen, true);
  assert.equal(mobile.state.parentSidebarDrawerOpen, true);
  assert.equal(mobile.state.parentPhysicalSidebarOpen, true);
  assert.equal(mobile.state.sidebarOpen, false);
  assert.equal(mobile.state.rightPanelOpen, false);
  const parentSource = mobile.state.embeddedIframeRef.current.contentWindow;
  mobile.state.applyParentSidebarMessage({
    source: parentSource,
    data: { type: "pi-web:parent-sidebar-toggle", open: true, openDrawer: false },
  });
  assert.equal(mobile.state.parentSidebarOpen, true);
  assert.equal(mobile.state.parentSidebarDrawerOpen, false);
  assert.equal(mobile.state.parentPhysicalSidebarOpen, false);
  mobile.state.handleSidebarToggle();
  assert.equal(mobile.state.parentSidebarOpen, true);
  assert.equal(mobile.state.parentSidebarDrawerOpen, true);
  assert.equal(mobile.state.parentPhysicalSidebarOpen, true);
  assert.equal(mobile.state.sidebarOpen, false);
  mobile.state.handleSidebarToggle();
  assert.equal(mobile.state.parentSidebarOpen, false);
  assert.equal(mobile.state.parentSidebarDrawerOpen, false);
  assert.equal(mobile.state.parentPhysicalSidebarOpen, false);
  assert.equal(mobile.state.sidebarOpen, false);

  const mobileExplorer = harness({ embedded: true, mobile: true, parentReady: true });
  mobileExplorer.state.embeddedResourceSession = {
    deviceId: "device-1",
    sessionId: "session-1",
    cwd: "/remote/project",
    path: null,
  };
  mobileExplorer.state.enterReaderMode();
  mobileExplorer.state.toggleExplorer();
  assert.equal(mobileExplorer.state.sidebarOpen, true);
  assert.equal(mobileExplorer.state.parentSidebarDrawerOpen, false);
  mobileExplorer.state.handleSidebarToggle();
  assert.equal(mobileExplorer.state.readerMode, true);
  assert.equal(mobileExplorer.state.parentSidebarOpen, true);
  assert.equal(mobileExplorer.state.parentSidebarDrawerOpen, true);
  assert.equal(mobileExplorer.state.parentPhysicalSidebarOpen, true);
  assert.equal(mobileExplorer.state.sidebarOpen, true);
  mobileExplorer.state.handleSidebarToggle();
  assert.equal(mobileExplorer.state.parentSidebarOpen, false);
  assert.equal(mobileExplorer.state.parentSidebarDrawerOpen, false);
  assert.equal(mobileExplorer.state.parentPhysicalSidebarOpen, false);
  assert.equal(mobileExplorer.state.sidebarOpen, true);

  const blocked = harness({ embedded: true, parentReady: false });
  blocked.state.enterReaderMode();
  assert.equal(blocked.state.readerMode, false);
  assert.equal(blocked.state.rightPanelOpen, false);
});

test("mobile session-only C opens the parent session drawer before A toggle", () => {
  const h = harness({ embedded: true, mobile: true, parentReady: true, parentSessionListOpen: false });
  h.state.enterReaderMode();
  h.state.exitReaderMode();
  assert.equal(h.state.parentSidebarOpen, true);
  assert.equal(h.state.parentSidebarDrawerOpen, true);
  assert.equal(h.state.parentState.sessionListOpen, true);
  assert.equal(h.state.parentState.sidebarOpen, true);
  assert.equal(h.state.sidebarOpen, false);
  h.state.handleSidebarToggle();
  assert.equal(h.state.parentSidebarOpen, false);
  assert.equal(h.state.parentSidebarDrawerOpen, false);
  assert.equal(h.state.parentState.sessionListOpen, false);
  assert.equal(h.state.parentState.sidebarOpen, false);
  assert.equal(h.state.sidebarOpen, false);
  h.state.handleSidebarToggle();
  assert.equal(h.state.parentSidebarOpen, true);
  assert.equal(h.state.parentSidebarDrawerOpen, true);
  assert.equal(h.state.parentState.sessionListOpen, true);
  assert.equal(h.state.parentState.sidebarOpen, true);
  assert.equal(h.state.sidebarOpen, false);
});

test("last-file layout cleanup clears every Explorer context and restores sessions", () => {
  const h = harness();
  h.state.sessionSidebarExplorerOpen = true;
  h.state.activityExplorerOpen = true;
  h.state.embeddedWorkspaceExplorerOpen = true;
  h.state.readerMode = true;
  h.state.fixedConversationSidebarVisible = false;
  h.state.sessionListOpen = false;
  h.state.rightPanelOpen = true;
  h.state.clearFileTabsLayout();
  assert.equal(h.state.sessionSidebarExplorerOpen, false);
  assert.equal(h.state.activityExplorerOpen, false);
  assert.equal(h.state.embeddedWorkspaceExplorerOpen, false);
  assert.deepEqual(localVector(h.state), { a: true, b: false, c: false, d: false });
});

test("dirty confirm cancel is executable no-op for close-last, close-all, and D", () => {
  const h = harness();
  h.state.fileTabs = [{
    id: "dirty-file",
    filePath: "README.md",
    dirty: true,
    viewerState: { displayMode: "preview", wrapLines: true },
  }];
  h.state.activeFileTabId = "dirty-file";
  h.state.sessionSidebarExplorerOpen = true;
  h.state.activityExplorerOpen = true;
  h.state.embeddedWorkspaceExplorerOpen = true;
  h.state.readerMode = true;
  h.state.fixedConversationSidebarVisible = false;
  h.state.sessionListOpen = false;
  h.state.rightPanelOpen = true;
  h.state.confirmResult = false;
  const snapshot = () => JSON.stringify({
    tabs: h.state.fileTabs,
    activeFileTabId: h.state.activeFileTabId,
    layout: localVector(h.state),
    explorerContexts: [h.state.sessionSidebarExplorerOpen, h.state.activityExplorerOpen, h.state.embeddedWorkspaceExplorerOpen],
  });
  const before = snapshot();
  h.state.handleCloseFileTab("dirty-file");
  assert.equal(snapshot(), before);
  h.state.handleCloseAllFileTabs();
  assert.equal(snapshot(), before);
  const tabs = h.state.fileTabs;
  const viewerState = h.state.fileTabs[0].viewerState;
  h.state.toggleRightPanel();
  assert.equal(h.state.rightPanelOpen, false);
  assert.equal(h.state.fileTabs, tabs);
  assert.equal(h.state.fileTabs[0].viewerState, viewerState);
  h.state.toggleRightPanel();
  assert.equal(h.state.rightPanelOpen, true);
  assert.equal(h.state.fileTabs, tabs);
  assert.equal(h.state.activeFileTabId, "dirty-file");
});

test("SessionSidebar has no Reader transition writes for C or E", () => {
  const source = readFileSync(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /if \(readerMode\) \{[\s\S]{0,180}setSessionsOpen\(/);
  assert.doesNotMatch(source, /previousReaderModeRef/);
});


function findNode(root, predicate) {
  if (predicate(root)) return root;
  return ts.forEachChild(root, (node) => findNode(node, predicate));
}

function activityDeviceFilterCallback(componentName, index = 0) {
  const component = findNode(activityFile, (node) => ts.isFunctionDeclaration(node) && node.name?.text === componentName);
  assert.ok(component, componentName);
  const filters = [];
  const visit = (node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      if (opening.tagName.getText(activityFile) === "ActivityDeviceFilter") {
        const attribute = opening.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.text === "onChange");
        const expression = attribute?.initializer;
        if (expression && ts.isJsxExpression(expression) && expression.expression && ts.isArrowFunction(expression.expression)) {
          filters.push(expression.expression.getText(activityFile));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(component);
  assert.ok(filters[index], `${componentName} device filter callback ${index}`);
  return filters[index];
}

test("normal activity device filters do not navigate workspace; legacy switch still does", () => {
  const devices = [{ id: "device-B", url: "https://device-b.test/" }];
  const layoutSnapshot = (state, mobile) => ({
    layout: localVector(state, mobile),
    embeddedReaderUrl: state.embeddedReaderUrl,
    embeddedDeviceWorkspaceActive: state.embeddedDeviceWorkspaceActive,
    embeddedDeviceId: state.embeddedDeviceId,
    embeddedSessionKey: state.embeddedSessionKey,
    embeddedResourceSession: state.embeddedResourceSession,
    embeddedIframeSessionId: state.embeddedIframeSessionId,
    embeddedScopeAll: state.embeddedScopeAll,
    aggregateWorkspaceActive: state.aggregateWorkspaceActive,
    readerMode: state.readerMode,
    rightPanelOpen: state.rightPanelOpen,
    sessionSidebarExplorerOpen: state.sessionSidebarExplorerOpen,
    activityExplorerOpen: state.activityExplorerOpen,
    embeddedWorkspaceExplorerOpen: state.embeddedWorkspaceExplorerOpen,
    activeFileTabId: state.activeFileTabId,
    fileTabs: state.fileTabs,
  });
  const exerciseLayout = (filtered, baseline, mobile) => {
    const operations = [
      (state) => state.handleSidebarToggle(),
      (state) => state.toggleExplorer(),
      (state) => state.toggleReaderMode(),
      (state) => state.toggleRightPanel(),
      (state) => state.toggleReaderMode(),
      (state) => state.toggleExplorer(),
      (state) => state.handleSidebarToggle(),
    ];
    for (const operation of operations) {
      operation(filtered.state);
      operation(baseline.state);
      assert.deepEqual(layoutSnapshot(filtered.state, mobile), layoutSnapshot(baseline.state, mobile));
    }
  };

  for (const mobile of [false, true]) {
    const panelHarness = harness({ mobile, cwd: "/project" });
    const panelBaseline = harness({ mobile, cwd: "/project" });
    panelHarness.state.hiddenView = true;
    panelHarness.state.favoritesView = true;
    const panelPatches = [];
    const panelFilterExit = evaluate(declaration("handleActivityDeviceFilterChange"), panelHarness.scope);
    evaluate(activityDeviceFilterCallback("SessionActivityPanel"), {
      activity: { devices },
      updateState: (patch) => panelPatches.push(patch),
      onActivityDeviceFilterChange: panelFilterExit,
      onDeviceChange: panelHarness.state.handleChangeActivityDevice,
    })("device-B");
    assert.deepEqual(panelPatches, [{ device: "device-B", project: [] }]);
    assert.equal(panelHarness.state.hiddenView, false, "panel filter must leave hidden view without changing layout");
    assert.equal(panelHarness.state.favoritesView, false, "panel filter must leave favorites view without changing layout");
    assert.equal(panelHarness.state.workspaceRestoreInvalidations, 0, "panel filter must not invalidate workspace restore");
    assert.deepEqual(layoutSnapshot(panelHarness.state, mobile), layoutSnapshot(panelBaseline.state, mobile));
    assert.equal(panelHarness.state.embeddedDeviceWorkspaceActive, false, "panel filter must not enter full-device mode");
    assert.equal(panelHarness.state.embeddedReaderUrl, null, "panel filter must not create an iframe");
    exerciseLayout(panelHarness, panelBaseline, mobile);

    const sidebarHarness = harness({ mobile, cwd: "/project" });
    const sidebarBaseline = harness({ mobile, cwd: "/project" });
    const sidebarPatches = [];
    const sidebarFilterExit = evaluate(declaration("handleActivityDeviceFilterChange"), sidebarHarness.scope);
    evaluate(activityDeviceFilterCallback("SessionActivitySidebar", 1), {
      activity: { devices },
      setFilters: (patch) => sidebarPatches.push(patch),
      onActivityDeviceFilterChange: sidebarFilterExit,
      onDeviceChange: sidebarHarness.state.handleChangeActivityDevice,
    })("device-B");
    assert.deepEqual(sidebarPatches, [{ device: "device-B", project: [] }]);
    assert.deepEqual(layoutSnapshot(sidebarHarness.state, mobile), layoutSnapshot(sidebarBaseline.state, mobile));
    assert.equal(sidebarHarness.state.embeddedDeviceWorkspaceActive, false, "sidebar filter must not enter full-device mode");
    assert.equal(sidebarHarness.state.embeddedReaderUrl, null, "sidebar filter must not create an iframe");
    exerciseLayout(sidebarHarness, sidebarBaseline, mobile);
  }

  const legacyHarness = harness({ cwd: "/project" });
  evaluate(activityDeviceFilterCallback("SessionActivitySidebar", 0), {
    activity: { devices },
    setFilters: () => {},
    onDeviceChange: legacyHarness.state.handleChangeActivityDevice,
  })("device-B");
  assert.equal(legacyHarness.state.embeddedDeviceWorkspaceActive, true, "legacy device switch must retain full-device navigation");
  assert.match(legacyHarness.state.embeddedReaderUrl, /device-B/);
});


test("workspace owner follows active terminal cwd and peer atomically", () => {
  const resolveWorkspaceOwner = workspaceOwnerResolver();
  const base = {
    embeddedReaderUrl: false,
    embeddedResourceSession: null,
    remoteSessionPeer: null,
    remoteSessionCwd: null,
    activeFilePeer: null,
    activeFileCwd: null,
    selectedSessionCwd: "/local/session",
    newSessionCwd: null,
    activeCwd: "/local/active",
  };
  assert.deepEqual(resolveWorkspaceOwner({
    ...base,
    activePeer: "device-B",
    activeWorkspacePeer: "device-B",
    activeWorkspaceCwd: "/same/cwd",
  }), { cwd: "/same/cwd", remotePeer: "device-B" });
  assert.deepEqual(resolveWorkspaceOwner({
    ...base,
    activePeer: "device-A",
    activeWorkspacePeer: "device-B",
    activeWorkspaceCwd: "/same/cwd",
  }), { cwd: null, remotePeer: null }, "a stale terminal peer must not borrow the current session owner");
  assert.deepEqual(resolveWorkspaceOwner({
    ...base,
    activePeer: "device-B",
    remoteSessionPeer: "device-B",
    remoteSessionCwd: "/device-B/session",
    activeWorkspacePeer: null,
    activeWorkspaceCwd: "/local/old-terminal",
  }), { cwd: "/device-B/session", remotePeer: "device-B" }, "an opened remote session must outrank a stale local terminal tab");
});

function navigationHarness(options = {}) {
  const h = harness(options);
  const s = h.state;
  Object.assign(s, {
    toDiscussView: false, toReviseView: false, completedView: false,
    sessionKey: 0,
    pendingTalkMapGhostConversionRef: { current: null }, pendingEmbeddedNewSessionRef: { current: null },
    activeProjectKeyRef: { current: null }, workspaceRestoreTokenRef: { current: 0 }, urlRestoreTokenRef: { current: 0 },
    suppressActivityPanelRestoreRef: { current: false }, suppressCwdBumpRef: { current: false },
    embeddedImagePreviewRef: { current: null },
    EMBEDDED_READER_PARAM: "piWebEmbedded", EMBEDDED_SESSION_PARAM: "piWebSessionOnly",
    EMBEDDED_RESOURCE_TOOLBAR_PARAM: "piWebResourceToolbar", EMBEDDED_RESOURCE_TOOLBAR_OWNER: "outer",
    EMBEDDED_OPEN_SESSION_EVENT: "pi-web:open-session", EMBEDDED_NEW_SESSION_REQUEST_EVENT: "pi-web:new-session-request",
    closeWorktreeGraph: () => {}, rememberProjectPath: () => {}, ensureCwdAllowed: () => {},
    replaceWorkspaceRoot: () => {}, workspaceParams: () => new URLSearchParams(),
    workspaceKeyOf: (session) => session.projectRoot ?? session.cwd,
    handleInitialRestoreDone: () => { s.initialSessionRestored = true; },
    getThemeSnapshot: () => ({ theme: "light" }),
    readSharedFilters: () => ({ archiveView: "active" }),
    document: undefined,
    mountRestorePendingRef: { current: false }, aggregatedUrlSyncedRef: { current: true },
    readDeviceUrlCache: () => null,
  });
  s.window.location = new URL("https://parent.test:30144/");
  s.router.replace = (value) => { s.window.location = new URL(value, s.window.location); };
  s.posted = [];
  s.alerts = [];
  s.window.alert = (message) => s.alerts.push(message);
  s.window.parent = { postMessage: (message) => s.posted.push(message) };
  s.embeddedIframeRef.current = { contentWindow: { postMessage: (message) => s.posted.push(message) } };
  for (const name of ["selectedSession", "remoteSession", "pendingRestoreMessage", "pendingContextSourceSessionId",
    "newSessionCwd", "newSessionSubprojectId", "newSessionSubprojectLabel", "sessionKey", "branchTree", "branchActiveLeafId", "systemPrompt",
    "highlightTerm", "initialSessionRestored", "embeddedModalOpen", "embeddedModalKind", "embeddedSlashDetails", "embeddedImagePreview", "embeddedFileViewerOpen"]) {
    s[`set${name[0].toUpperCase()}${name.slice(1)}`] = (value) => { s[name] = typeof value === "function" ? value(s[name]) : value; };
  }
  for (const name of ["buildEmbeddedReaderUrl", "loadLocalSession", "buildNewSessionDraftKey", "stripLegacyWorkspaceLayout"]) {
    const node = find(app, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (node) s[name] = evaluate(`(() => { ${node.getText(app)}; return ${name}; })()`, h.scope);
  }
  for (const name of ["invalidateWorkspaceRestore", "clearEmbeddedReaderOwner", "handleSelectSession", "handleNewSession", "handleNewActivitySession", "handleOpenActivitySession", "restoreFromParams", "restoreWithDeviceUrl", "openRemoteSession"]) {
    s[name] = evaluate(declaration(name), h.scope);
  }
  return h;
}

function localItem(id = "local-session") {
  return { device: { id: "device-1", name: "local", url: "https://local-alias.test:30143" },
    session: { id, cwd: "/project", projectRoot: "/project", path: `/sessions/${id}.jsonl` } };
}

for (const [parentPort, httpPort, httpsPort] of [[30144, 30142, 30144], [30142, 30142, 30144], [30143, 30141, 30143], [30141, 30141, 30143]]) {
  test(`navigation: browser channel ${parentPort} keeps device document in the same channel`, () => {
    const h = navigationHarness();
    h.state.window.location = new URL(`https://parent.test:${parentPort}/`);
    for (const [scheme, configuredPort, expectedPort] of [["http", 30141, httpPort], ["http", 30142, httpPort], ["https", 30143, httpsPort], ["https", 30144, httpsPort]]) {
      const value = h.state.buildEmbeddedReaderUrl({ id: "remote", url: `${scheme}://peer.test:${configuredPort}/` }, {
        localDeviceId: "device-1", sessionId: "chosen", sessionOnly: true, parentSidebar: true,
      });
      const url = new URL(value);
      assert.equal(url.port, String(expectedPort));
      assert.equal(url.protocol, `${scheme}:`);
      assert.equal(url.hostname, "peer.test");
      assert.equal(url.searchParams.get("session"), "chosen");
      assert.equal(url.searchParams.get("piWebSessionOnly"), "1");
      assert.equal(url.searchParams.get("theme"), "light");
    }
  });
}

test("navigation: full-device local documents use current origin and custom peer ports stay unchanged", () => {
  const h = navigationHarness();
  h.state.handleChangeActivityDevice(localItem().device);
  const local = new URL(h.state.embeddedReaderUrl);
  assert.equal(local.origin, h.state.window.location.origin);
  assert.equal(local.searchParams.get("piWebActivitySidebar"), "1");
  assert.equal(local.searchParams.has("piWebSessionOnly"), false);
  assert.equal(h.state.embeddedDeviceWorkspaceActive, true);
  const custom = new URL(h.state.buildEmbeddedReaderUrl({ id: "remote", url: "https://peer.test:8443/" }, { localDeviceId: "device-1" }));
  assert.equal(custom.origin, "https://peer.test:8443");
  assert.equal(h.state.buildEmbeddedReaderUrl({ id: "remote", url: "javascript:alert(1)" }, { localDeviceId: "device-1" }), null);
});

test("navigation: local new then existing session drops old iframe and remote slot without losing draft metadata", () => {
  const h = navigationHarness();
  const s = h.state;
  s.embeddedReaderUrl = "https://old.test:30143/";
  s.embeddedSessionKey = "device-1:old-session";
  s.remoteSession = { device: { id: "remote" }, sessionInfo: { id: "remote-session" } };
  s.handleNewActivitySession("/project", localItem().device, "sub", "Subproject", {
    initialMessage: "question", contextSourceSessionId: "source", talkMapGhost: { ghostId: "ghost", projectRoot: "/project" },
  });
  assert.equal(s.embeddedReaderUrl, null);
  assert.equal(s.remoteSession, null);
  assert.equal(s.newSessionCwd, "/project");
  assert.equal(s.newSessionSubprojectId, "sub");
  assert.deepEqual(s.pendingRestoreMessage, { role: "user", content: "question" });
  assert.equal(s.pendingContextSourceSessionId, "source");
  assert.equal(s.pendingTalkMapGhostConversionRef.current.ghostId, "ghost");
  assert.deepEqual(s.posted, []);
  s.handleOpenActivitySession(localItem(), "needle", "device-1");
  assert.equal(s.selectedSession.id, "local-session");
  assert.equal(s.highlightTerm, "needle");
  assert.equal(s.embeddedReaderUrl, null);
  assert.equal(s.remoteSession, null);
  assert.equal(s.newSessionCwd, null);
  assert.equal(s.embeddedSessionRequestTimerRef.current, null);
  assert.deepEqual(s.posted, []);
});

test("navigation: selecting the same local session clears stale owner before the no-remount return", () => {
  const h = navigationHarness();
  const s = h.state;
  s.selectedSession = localItem().session;
  s.embeddedReaderUrl = "https://old.test:30143/";
  s.remoteSession = { device: { id: "remote" } };
  s.handleSelectSession(localItem().session);
  assert.equal(s.embeddedReaderUrl, null);
  assert.equal(s.remoteSession, null);
  assert.equal(s.sessionKey, 0);
});

test("navigation: local device link restores active and archived sessions in the local slot with search", async () => {
  for (const archived of [false, true]) {
    const h = navigationHarness();
    const s = h.state;
    const calls = [];
    s.fetch = async (url) => {
      calls.push(url);
      return { ok: true, json: async () => ({ sessions: archived && !url.includes("archived") ? [] : [localItem().session] }) };
    };
    await s.restoreFromParams(new URLSearchParams({ device: "device-1", session: "local-session", scope: "all", hl: "needle" }), localItem().device.url);
    assert.equal(s.selectedSession.id, "local-session");
    assert.equal(s.remoteSession, null);
    assert.equal(s.embeddedReaderUrl, null);
    assert.equal(s.highlightTerm, "needle");
    assert.deepEqual(calls, archived ? ["/api/sessions", "/api/sessions?archived=1"] : ["/api/sessions"]);
  }
});

test("navigation: a local collection link never enters the remote session slot", async () => {
  const h = navigationHarness();
  h.state.fetchSessionActivity = async () => ({ sessions: [localItem()] });
  await h.state.restoreFromParams(new URLSearchParams({ device: "device-1", session: "local-session", scope: "favorites" }));
  assert.equal(h.state.selectedSession.id, "local-session");
  assert.equal(h.state.remoteSession, null);
  assert.equal(h.state.favoritesView, true);
});

test("navigation: embedded forwarding uses device id rather than a shared hostname", () => {
  const h = navigationHarness({ embedded: true });
  h.state.handleOpenActivitySession({ ...localItem(), device: { id: "remote", url: "https://parent.test:30143/" } });
  assert.equal(h.state.posted.length, 1);
  assert.equal(h.state.posted[0].type, "pi-web:open-session");
  assert.equal(h.state.posted[0].device.id, "remote");
});

test("navigation: a forwarded local session resolves locally and a stale lookup cannot replace a newer draft", async () => {
  const h = navigationHarness();
  const s = h.state;
  s.fetch = async () => ({ ok: true, json: async () => ({ sessions: [localItem().session] }) });
  s.openRemoteSession(localItem().device, "local-session");
  await new Promise(setImmediate);
  assert.equal(s.selectedSession.id, "local-session");
  assert.equal(s.embeddedReaderUrl, null);
  let finish;
  s.fetch = () => new Promise((resolve) => { finish = resolve; });
  s.openRemoteSession(localItem().device, "local-session");
  s.handleNewSession("new", "/next");
  finish({ ok: true, json: async () => ({ sessions: [localItem().session] }) });
  await new Promise(setImmediate);
  assert.equal(s.selectedSession, null);
  assert.equal(s.newSessionCwd, "/next");
});

test("navigation: local forwarding reports lookup failure without pretending the target opened", async () => {
  for (const missing of [false, true]) {
    const h = navigationHarness();
    const s = h.state;
    s.fetch = async () => ({ ok: missing, status: 503, json: async () => ({ sessions: [] }) });
    s.openRemoteSession(localItem().device, "missing-session");
    await new Promise(setImmediate);
    assert.deepEqual(s.alerts, [missing ? "Session not found" : "Session list HTTP 503"]);
    assert.equal(s.selectedSession.id, "current-session");
    assert.equal(s.embeddedReaderUrl, null);
  }
});

function runNavigationEffect(h, marker) {
  const node = find(app, (node) => ts.isCallExpression(node) && node.expression.getText(app) === "useEffect" && node.arguments[0]?.getText(app).includes(marker));
  assert.ok(node, marker);
  return evaluate(node.arguments[0].getText(app), h.scope)();
}

test("navigation: mount restore releases pending and subsequent remote navigation updates the URL", async () => {
  const h = navigationHarness();
  const s = h.state;
  s.window.location = new URL("https://parent.test:30144/?device=device-1&session=local-session&scope=all&hl=needle");
  s.fetch = async () => ({ ok: true, json: async () => ({ sessions: [localItem().session] }) });
  s.fetchSessionActivity = () => { throw new Error("local restore must not require peer discovery"); };
  runNavigationEffect(h, "const cancelRestore = () =>");
  await new Promise(setImmediate);
  assert.equal(s.selectedSession.id, "local-session");
  assert.equal(s.embeddedReaderUrl, null);
  assert.equal(s.mountRestorePendingRef.current, false);
  runNavigationEffect(h, "if (!aggregatedUrlSyncedRef.current)");
  assert.equal(s.window.location.searchParams.get("session"), "local-session");
  assert.equal(s.window.location.searchParams.get("hl"), "needle");
  assert.equal(s.window.location.searchParams.has("device"), false);
  s.handleOpenActivitySession({ ...localItem("remote-session"), device: { id: "remote", name: "remote", url: "https://remote.test:30143" } });
  runNavigationEffect(h, "if (!aggregatedUrlSyncedRef.current)");
  assert.equal(s.window.location.searchParams.get("session"), "remote-session");
  assert.equal(s.window.location.searchParams.get("device"), "remote");
});

test("navigation: collection click and restore keep scope session and search through URL synchronization", async () => {
  for (const scope of ["hidden", "favorites", "to_discuss", "to_revise", "completed"]) {
    for (const restore of [false, true]) {
      const h = navigationHarness();
      const s = h.state;
      s.window.location = new URL(`https://parent.test:30144/?scope=${scope}${restore ? "&device=device-1&session=local-session&hl=needle" : ""}`);
      s.fetchSessionActivity = async () => ({ sessions: [localItem()] });
      if (restore) {
        await s.restoreFromParams(new URLSearchParams(s.window.location.search));
      } else {
        s.hiddenView = scope === "hidden";
        s.favoritesView = scope === "favorites";
        s.toDiscussView = scope === "to_discuss";
        s.toReviseView = scope === "to_revise";
        s.completedView = scope === "completed";
        s.handleOpenActivitySession(localItem(), "needle");
      }
      runNavigationEffect(h, "if (!aggregatedUrlSyncedRef.current)");
      assert.equal(s.window.location.searchParams.get("scope"), scope);
      assert.equal(s.window.location.searchParams.get("session"), "local-session");
      assert.equal(s.window.location.searchParams.get("hl"), "needle");
      assert.equal(s.window.location.searchParams.has("device"), false);
    }
  }
});

test("navigation: local full-device restore needs neither configured URL nor cache", async () => {
  const h = navigationHarness();
  const s = h.state;
  s.window.location = new URL("https://parent.test:30144/?device=device-1");
  s.readDeviceUrlCache = () => { throw new Error("local restore must not require URL cache"); };
  s.fetchSessionActivity = () => { throw new Error("local restore must not require peer discovery"); };
  runNavigationEffect(h, "const cancelRestore = () =>");
  await new Promise(setImmediate);
  assert.equal(s.embeddedDeviceWorkspaceActive, true);
  assert.equal(new URL(s.embeddedReaderUrl).origin, s.window.location.origin);
  assert.equal(s.mountRestorePendingRef.current, false);
  s.restoreWithDeviceUrl(new URLSearchParams({ device: "device-1" }));
  await new Promise(setImmediate);
  assert.equal(new URL(s.embeddedReaderUrl).origin, s.window.location.origin);
  assert.equal(s.mountRestorePendingRef.current, false);
});

test("navigation: request-time device identity is supplied before client navigation", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.match(page, /localDeviceIdentity\(readActivityConfig\(\)/);
  assert.match(page, /<AppShell localDeviceId=\{id\} localDeviceName=\{name\}/);
  assert.doesNotMatch(appSource, /setLocalDeviceId|setLocalDeviceName/);
});


test("restoring the same session/project twice preserves the mounted ChatWindow key", () => {
  const { state: s } = navigationHarness();
  const item = localItem();
  s.handleSelectSession(item.session, true);
  assert.equal(s.sessionKey, 1);
  s.handleSelectSession({ ...item.session }, true);
  assert.equal(s.sessionKey, 1, "URL restore must not remount the already selected session");
  assert.equal(s.initialSessionRestored, true);
  s.handleSelectSession(item.session, false, "search result");
  assert.equal(s.sessionKey, 1);
  assert.equal(s.highlightTerm, "search result");
  s.handleSelectSession({ ...item.session, id: "other" }, true);
  assert.equal(s.sessionKey, 2, "a different session must still mount");
  s.handleSelectSession(item.session, false);
  assert.equal(s.sessionKey, 3, "returning after leaving must mount again");
  s.handleSelectSession({ ...item.session, projectRoot: "/moved" }, true);
  assert.equal(s.sessionKey, 4, "a changed project must not reuse the old mount");
  s.handleNewSession("", "/fresh");
  assert.equal(s.selectedSession, null);
  assert.equal(s.newSessionCwd, "/fresh");
  assert.equal(s.sessionKey, 5, "new drafts still have a new mount key");
});
