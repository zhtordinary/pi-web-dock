import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { createJiti } from "jiti";
import { appendPersisted, emptyTranscript, upsertMessage, removeMessage, occurrenceId, withOccurrence } from "../lib/transcript-store.ts";
import { isSessionPeerAgentMessage } from "../lib/session-peer-message.ts";
import { agentEndErrorMessage, agentEndWasAborted, isNestedToolExecutionEvent } from "../lib/agent-event-wire.ts";
import { AgentCommandError, isPromptRejectedError } from "../lib/agent-client.ts";
const jiti = createJiti(import.meta.url, { fsCache: false });
const { TranscriptReader } = await jiti.import("../lib/transcript-reader.ts");
const { resetHistoryViewCacheForTests } = await jiti.import("../lib/session-view-cache.ts");
import { BranchNavigation, canWriteBranch } from "../lib/branch-navigation.ts";
import { CONFIGURED_TOOL_PRESET, getPresetFromToolNames } from "../lib/tool-presets.ts";
import { QueuedDraftProjection, readQueuedDraftState, recalledQueuedDrafts, getPendingQueueRecall, savePendingQueueRecall, clearPendingQueueRecall, queuedImageCount, getQueueRecallOperation, beginQueueRecallOperation, markQueueRecallRestored, assertUserQueueRecall, clearQueueRecallOperation } from "../lib/queued-draft.ts";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/sessions/[id]/route.ts", import.meta.url), "utf8");
const chatWindow = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");

function createPromptCompletionDeduper() {
  const start = source.indexOf("export function createPromptCompletionDeduper");
  const end = source.indexOf("export function useAgentSession", start);
  assert.ok(start >= 0 && end > start, "deduper helper must remain a standalone runtime helper");
  const context = {};
  vm.runInNewContext(
    `${stripTypeScriptTypes(source.slice(start, end).replace(/^export /gm, ""))}; globalThis.create = createPromptCompletionDeduper;`,
    context,
  );
  return context.create();
}

test("completion notifications deduplicate by server run, local fallback, and session scope", () => {
  const deduper = createPromptCompletionDeduper();
  assert.equal(deduper.claim("session-a", 1, "run-a"), true);
  assert.equal(deduper.claim("session-a", 2, "run-a"), false);
  assert.equal(deduper.claim("session-a", 3, "run-b"), true);
  assert.equal(deduper.claim("session-a", 4), true);
  assert.equal(deduper.claim("session-a", 4), false);
  assert.equal(deduper.claim("session-b", 4, "run-a"), true);
});





test("lightweight state polling keeps the peer and does not clear omitted prompt fields", () => {
  const start = source.indexOf("  const apiPath = useCallback");
  const end = source.indexOf("  const sendAgentCommandR = useCallback", start);
  assert.ok(start >= 0 && end > start);
  const context = { useCallback: (fn) => fn, remotePeerRef: { current: null } };
  vm.runInNewContext(`${stripTypeScriptTypes(source.slice(start, end))}\nglobalThis.path = apiPath;`, context);
  assert.equal(context.path("agent/a?systemPrompt=0"), "/api/agent/a?systemPrompt=0");
  context.remotePeerRef.current = "debian";
  assert.equal(context.path("agent/a?systemPrompt=0"), "/api/remote/agent/a?systemPrompt=0&peer=debian");
  assert.ok((source.match(/agent\/\$\{encodeURIComponent\(sid\)\}\?systemPrompt=0/g) ?? []).length >= 3);
  assert.match(source, /if \(state\.systemPrompt !== undefined\) setSystemPrompt/);
  assert.match(source, /if \(state\.runtimeInspection !== undefined\) setRuntimeInspection/);
  assert.match(source, /sendAgentCommandR<AgentStateResponse>\(sid, \{ type: "get_state" \}\)/);
});

test("metadata-only route returns no transcript bodies and keeps the default GET contract separate", () => {
  const start = route.indexOf("if (metadataOnly)");
  const end = route.indexOf("    const deferThinking", start);
  assert.ok(start >= 0 && end > start);
  const block = route.slice(start, end);
  assert.match(block, /metadataOnly: true/);
  assert.match(block, /context: \{ messages: \[\], entryIds: \[\]/);
  assert.doesNotMatch(block, /buildSessionContext|buildFullSessionContext|context\.messages\.push/);
  assert.match(route.slice(end), /const context = buildSessionContext/);
});

const chatWindowSource = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
const chatInputSource = await readFile(new URL("../components/ChatInput.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
const normalizeSource = await readFile(new URL("../lib/normalize.ts", import.meta.url), "utf8");
const streamingSource = await readFile(new URL("../lib/streaming-message.ts", import.meta.url), "utf8");
const phaseLabelSource = await readFile(new URL("../lib/chat-phase-label.ts", import.meta.url), "utf8");

function loadStreamingReducer() {
  const ctx = {};
  installRuntimeState(ctx);
  vm.createContext(ctx);
  const normalizeModule = normalizeSource
    .replace(/^import[\s\S]*?;\s*/gm, "")
    .replace(/export function /g, "function ");
  const streamModule = streamingSource
    .replace(/^import[\s\S]*?;\s*/gm, "")
    .replace(/^export type \{[^\n]*\} from[^\n]*;\s*/gm, "")
    .replace(/^export type StreamAction =[\s\S]*?^\s*\| \{ type: "end" \};\s*/m, "")
    .replace(/export const INITIAL_STREAMING_STATE/g, "const INITIAL_STREAMING_STATE")
    .replace(/export function streamReducer/g, "function streamReducer")
    .replace(/^export interface StreamingStore[\s\S]*$/m, "");
  vm.runInContext(stripTypeScriptTypes(`${normalizeModule}\n${streamModule}\nglobalThis.__streamingReducer = { INITIAL_STREAMING_STATE, streamReducer };`), ctx);
  return ctx.__streamingReducer;
}

const { INITIAL_STREAMING_STATE, streamReducer } = loadStreamingReducer();

const sendAgentCommandSource = source.slice(
  source.indexOf("  const sendAgentCommandR = useCallback"),
  source.indexOf("  const sessionDetailsVersion"),
);
const loadContextSource = source.slice(
  source.indexOf("  const loadContext = useCallback"),
  source.indexOf("  const recoverBranchPosition"),
);
const recoverBranchPositionSource = source.slice(
  source.indexOf("  const recoverBranchPosition"),
  source.indexOf("  const loadTools"),
);
const navigateBranchStart = source.indexOf("  const navigateBranch = useCallback");
const navigateBranchSource = source.slice(
  navigateBranchStart,
  source.indexOf("  const handleNavigate = useCallback", navigateBranchStart),
);
const handleAgentEventSource = source.slice(
  source.indexOf("  const handleAgentEvent = useCallback"),
  source.indexOf("  handleAgentEventRef.current = handleAgentEvent"),
);
function extractHistorySources(hookSource) {
  return {
    loadSessionSource: hookSource.slice(
      hookSource.indexOf("  const loadSession = useCallback"),
      hookSource.indexOf("  const loadContext = useCallback"),
    ),
    settleUiStageSource: hookSource.slice(
      hookSource.indexOf("  const settleUiStage = useCallback"),
      hookSource.indexOf("  const notifyPromptStage"),
    ),
    notifyPromptStageSource: hookSource.slice(
      hookSource.indexOf("  const notifyPromptStage = useCallback"),
      hookSource.indexOf("  const scheduleEventStreamClose"),
    ),
    handleAgentEventSource: hookSource.slice(
      hookSource.indexOf("  const handleAgentEvent = useCallback"),
      hookSource.indexOf("  handleAgentEventRef.current = handleAgentEvent"),
    ),
  };
}

function installRuntimeState(ctx) {
  ctx.useCallback ??= fn => fn;
  ctx.canWriteBranch ??= canWriteBranch;
  ctx.crypto ??= globalThis.crypto;
  ctx.AbortSignal ??= AbortSignal;
  ctx.CONFIGURED_TOOL_PRESET = CONFIGURED_TOOL_PRESET;
  ctx.getPresetFromToolNames = getPresetFromToolNames;
  ctx.sessionToolsPinnedRef ??= { current: false };
  ctx.promptDeliveriesRef ??= { current: new Map() };
  ctx.setUnconfirmedPrompts ??= () => {};
  ctx.confirmPromptDelivery ??= () => null;
  ctx.setToolPresetState ??= (value) => { ctx.toolPreset = value; };
  ctx.setAutoCompactionEnabled ??= (value) => { ctx.autoCompactionEnabled = value; };
  ctx.setLiveModel ??= (value) => { ctx.liveModel = value; };
  ctx.setLiveThinkingLevel ??= (value) => { ctx.liveThinkingLevel = value; };
  ctx.branchScopeRef ??= { current: `local:${ctx.sessionIdRef?.current ?? "s"}` };
  ctx.remotePeerRef ??= { current: null };
  Object.assign(ctx, { removeMessage, occurrenceId, upsertMessage, withOccurrence, isSessionPeerAgentMessage, agentEndErrorMessage, agentEndWasAborted, isNestedToolExecutionEvent });
  ctx.messagesRef ??= { current: [] };
  ctx.entryIdsRef ??= { current: [] };
  ctx.runtimeInvalidations ??= [];
  ctx.runtimeAvailableRef ??= { current: false };
  ctx.activeToolIdsRef ??= { current: new Set() };
  ctx.toolEventRevisionRef ??= { current: 0 };
  ctx.setActiveToolResults ??= () => {};
  ctx.setAgentPhase ??= () => {};
  ctx.setRuntimeAvailable ??= () => {};
  ctx.pendingUserMessageOccurrencesRef ??= { current: new Map() };
  ctx.pendingPeerMessageIdsRef ??= { current: new Set() };
  const update = (next) => { ctx.messagesRef.current = next.messages; ctx.entryIdsRef.current = next.entryIds; ctx.setMessages?.(next.messages); ctx.setEntryIds?.(next.entryIds); };
  let items = new Map(ctx.entryIdsRef.current.map((entryId,index)=>[entryId,{entryId,orderKey:[index,1,index],role:ctx.messagesRef.current[index].role,message:ctx.messagesRef.current[index],sourceType:'message',contentState:'full',process:false,toolCallCount:0,deferred:[],turnAnchor:null}]));
  ctx.reader ??= {
    recordUnseenEntry() {},
    getState: () => ({ transcript: { messages: ctx.messagesRef.current, entryIds: ctx.entryIdsRef.current } }),
    append: (message, entryId, delivery) => { const next=appendPersisted({...emptyTranscript(),items,messages:ctx.messagesRef.current,entryIds:ctx.entryIdsRef.current},message,entryId,delivery);items=next.items;update(next); },
    updateMessages: fn => update(fn({ messages: ctx.messagesRef.current, entryIds: ctx.entryIdsRef.current })),
    reconcileTail: async () => { ctx.runtimeInvalidations.push({ reason: "reconcile" }); },
    setScope() {}, reset: async () => ({}),
  };
  if (!ctx.appendMessage) {
    const helpers = source.slice(source.indexOf("  const appendMessage = useCallback"), source.indexOf("  const cacheKeyForSession"));
    vm.runInNewContext(stripTypeScriptTypes(helpers + "\nObject.assign(globalThis, { appendMessage, updateMessages });"), ctx);
  }
  if (!ctx.syncLiveModel) {
    const helper = source.slice(source.indexOf("function asConcreteThinkingLevel"), source.indexOf("const SESSION_LEASE_RENEW_INTERVAL_MS"));
    const sync = source.slice(source.indexOf("  const syncLiveModel = useCallback"), source.indexOf("  const composerDraftKey"));
    const deps = { ...ctx, useCallback: (fn) => fn };
    vm.runInNewContext(stripTypeScriptTypes(helper + sync + "\nglobalThis.syncLiveModel = syncLiveModel;"), deps);
    ctx.syncLiveModel = deps.syncLiveModel;
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsync() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function contextResponse(leafId = null) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      context: { messages: [{ role: "user", content: `context-${leafId ?? "root"}` }], entryIds: ["context-entry"], oldestEntryId: "context-entry", hasMore: false },
      history: { hasEarlierHistory: false, hasCompaction: false },
    }),
  };
}

function createBranchHarness({ legacy = false } = {}) {
  const branch = new BranchNavigation();
  branch.reset("local:s");
  branch.observeRuntime("runtime");
  const requests = [];
  const commands = [];
  const contextApplications = [];
  const writes = { clear: 0, messages: [], activeLeafIds: [] };
  const ctx = {
    useCallback: (fn) => fn,
    Map,
    apiPath: (url) => url,
    encodeURIComponent,
    URLSearchParams,
    BranchNavigation,
    canWriteBranch,
    sessionHookMountedRef: { current: true },
    sessionIdRef: { current: "s" },
    branchScope: "local:s",
    branchScopeRef: { current: "local:s" },
    isNewSession: false,
    remotePeerRef: { current: null },
    agentRunningRef: { current: false },
    sessionViewValidationPendingRef: { current: true },
    sessionLoadGenerationRef: { current: 0 },
    branchRef: { current: branch },
    fullHistoryAbortControllerRef: { current: null },
    fullHistoryExpandedRef: { current: false },
    hiddenRetryErrorIdsRef: { current: new Set() },
    historyCursorRef: { current: null },
    cacheKeyForSession: (sid) => sid,
    clearLoadedSessionView: () => { writes.clear += 1; },
    deleteSessionViewSnapshot() {},
    filterHiddenRetryErrors: (messages, entryIds) => ({ messages, entryIds }),
    messagesRef: { current: [] },
    setQuestionAnalysisJobs: () => contextApplications.push({ phase: branch.state.phase, pending: ctx.sessionViewValidationPendingRef.current }),
    setQuestionDraftViews() {},
    setMessages: (value) => { writes.messages.push(value); },
    setEntryIds() {},
    setData() {},
    setActiveLeafId: (value) => { writes.activeLeafIds.push(value); },
    setHasEarlierHistory() {},
    setHasCompaction() {},
    setHasEarlierMessages() {},
    dispatch() {},
    console: { error() {} },
    AgentCommandError: class AgentCommandError extends Error {
      constructor(message, status, code, retryable) {
        super(message);
        this.status = status;
        this.code = code;
        this.retryable = retryable;
      }
    },
    sendAgentCommand: async (sid, command, peer) => {
      commands.push({ sid, command, peer });
      if (command.type === "get_state") return ctx.getStateResult;
      if (command.type === "navigate_tree") return ctx.navigateResult;
      return { accepted: true };
    },
    getStateResult: { branchPosition: { leafId: null, pending: false } },
    navigateResult: { cancelled: false, leafId: "next" },
    fetch: (url) => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
  };
  installRuntimeState(ctx);
  vm.createContext(ctx);
  const effectiveLoadContextSource = legacy
    ? loadContextSource.replace(
      "      sessionViewValidationPendingRef.current = false;",
      "      if (branchRef.current?.state.phase === \"current\") sessionViewValidationPendingRef.current = false;",
    )
    : loadContextSource;
  vm.runInContext(stripTypeScriptTypes([
    sendAgentCommandSource,
    effectiveLoadContextSource,
    recoverBranchPositionSource,
    navigateBranchSource,
    "globalThis.sendAgentCommandR = sendAgentCommandR;",
    "globalThis.loadContext = loadContext;",
    "globalThis.recoverBranchPosition = recoverBranchPosition;",
    "globalThis.navigateBranch = navigateBranch;",
  ].join("\n")), ctx);
  return { ctx, branch, requests, commands, contextApplications, writes };
}

function sessionResponse(revision = "r1", leafId = "leaf") {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      sessionId: "s",
      filePath: "/tmp/s.jsonl",
      timing: { effectiveMs: 2 },
      leafId,
      snapshotRevision: revision,
      context: { messages: [{ role: "assistant", content: "server" }], entryIds: ["server-entry"], thinkingLevel: "auto", model: null, hasMore: false },
      history: { hasEarlierHistory: false, hasCompaction: false },
    }),
  };
}

function createRefreshHarness({ hookSource = source, realTerminalHelpers = false } = {}) {
  const requests = [];
  let streamState = INITIAL_STREAMING_STATE;
  let activeToolResults = new Map();
  let agentPhase = null;
  const writes = {
    activeToolResults: [],
    data: [],
    messages: [],
    entryIds: [],
    activeLeafIds: [],
    questionAnalysisJobs: [],
    questionDraftViews: [],
    errors: [],
    clear: 0,
    cache: [],
    deleted: 0,
    branch: [],
    stream: [],
    loading: [],
    agentRunning: [],
    notifications: [],
  };
  let messages = [{ role: "assistant", content: "seed" }];
  let entryIds = ["seed-entry"];
  const branch = {
    state: { phase: "current" },
    observeRuntime(leafId) { writes.branch.push(["observe", leafId]); },
    markUnconfirmed(error) { writes.branch.push(["unconfirmed", String(error)]); },
  };
  const ctx = {
    useCallback: (fn) => fn,
    Map,
    apiPath: (url) => url,
    encodeURIComponent,
    URLSearchParams,
    sessionHookMountedRef: { current: true },
    sessionIdRef: { current: "s" },
    remotePeerRef: { current: null },
    branchScopeRef: { current: "local:s" },
    sessionLoadGenerationRef: { current: 1 },
    blockingLoadOwnerRef: { current: null },
    pendingSessionLoadRef: { current: null },
    sessionViewValidationPendingRef: { current: false },
    fullHistoryExpandedRef: { current: false },
    modelSwitchPendingRef: { current: false },
    stateRunRevisionRef: { current: 0 },
    currentAgentRunIdRef: { current: null },
    promptRunIdRef: { current: 1 },
    promptCompletionDeduperRef: { current: createPromptCompletionDeduper() },
    transcriptMutationRevisionRef: { current: 0 },
    sessionSettlementGenerationRef: { current: 0 },
    sessionRunningRef: { current: false },
    branchRef: { current: branch },
    messagesRef: { current: messages },
    entryIdsRef: { current: entryIds },
    historyCursorRef: { current: "seed-entry" },
    hasEarlierHistory: false,
    hasEarlierMessages: true,
    hasCompaction: false,
    hiddenRetryErrorIdsRef: { current: new Set() },
    readHiddenRetryErrorIds: () => new Set(),
    filterHiddenRetryErrors: (nextMessages, nextEntryIds) => ({ messages: nextMessages, entryIds: nextEntryIds }),
    cacheKeyForSession: (sid) => sid,
    clearLoadedSessionView: () => { writes.clear += 1; },
    // Legacy history access is forbidden in the runtime-owner harness.
    writeSettledSessionViewSnapshot: () => assert.fail("Runtime metadata must not write durable history"),
    deleteSessionViewSnapshot: () => assert.fail("Runtime metadata must not delete durable history"),
    setData: (value) => { const next = typeof value === "function" ? value(ctx.data ?? null) : value; ctx.data = next; writes.data.push(next); },
    setLoading: (value) => { writes.loading.push(value); },
    setSessionStatsOverride() {},
    setSessionRunning: (value) => { writes.sessionRunning = value; },
    setSystemPrompt() {},
    setRuntimeInspection() {},
    setActiveLeafId() {},
    setFastModeSelection() {},
    setFastModeRuntimeStatus() {},
    setQuestionAnalysisJobs() {},
    setQuestionDraftViews() {},
    setMessages: (value) => { messages = typeof value === "function" ? value(messages) : value; writes.messages.push(messages); },
    setEntryIds: (value) => { entryIds = typeof value === "function" ? value(entryIds) : value; writes.entryIds.push(entryIds); },
    setHasEarlierHistory() {},
    setHasCompaction() {},
    setHasEarlierMessages() {},
    setError: (value) => { writes.errors.push(value); },
    fetch: (url, options = {}) => new Promise((resolve, reject) => requests.push({ url, resolve, reject, signal: options?.signal })),
    onBeforeApplyHistoryRef: { current: null },
    console: { error() {} },
    dispatch: (action) => {
      streamState = streamReducer(streamState, action);
      writes.stream.push(action);
    },
    setAgentRunning: (value) => { writes.agentRunning.push(value); },
    setAgentPhase: (value) => { agentPhase = typeof value === "function" ? value(agentPhase) : value; },
    activeToolIdsRef: { current: new Set() },
    CODEMODE_TOOL_NAME: "codemode",
    setActiveToolResults: (update) => {
      activeToolResults = typeof update === "function" ? update(activeToolResults) : update;
      assert.ok(activeToolResults instanceof Map, "active tool results retain real Map state");
      writes.activeToolResults.push(activeToolResults);
    },
    setRetryInfo() {},
    setIsCompacting() {},
    setCompactError() {},
    setCompactResult() {},
    setCurrentModelOverride() {},
    setThinkingLevel() {},
    setQueuedMessages() {},
    setSessionStatePending() {},
    addNotice() {},
    t: (key) => key,
    onAgentError() {},
    onAgentEnd: (serverRunId) => { writes.notifications.push(serverRunId); },
    cancelEventStreamGrace() {},
    loadAgentState: async () => null,
    loadFullHistory: async () => null,
    restoreLoadedRunState() {},
    notifyPromptStage() { return false; },
    refreshSessionCost: async () => {},
    scheduleEventStreamClose() {},
    scrollToBottom() {},
    settleUiStage: () => false,
    handleExtensionUiRequest() {},
    syncQueuedDrafts() {},
    syncQueuedDraftResponse() {},
    normalizeQueuedMessages: (value) => value,
    queuedMessagesSummary: (value) => value,
    normalizeToolCalls: (value) => value,
    invalidateSessionDetailsForSession() {},
    getToolExecutionProgress: () => null,
    readCompactResult: () => null,
    thinkingLevelOverrideRef: { current: null },
    syncUnattendedEnabledRef: { current: null },
    syncUnattendedStateRef: { current: null },
    queuedDraftProjectionRef: { current: new QueuedDraftProjection() },
    pendingUserMessageCountsRef: { current: new Map() },
    sessionStatePendingRef: { current: false },
    sdkAgentActiveRef: { current: false },
    rpcPromptPendingRef: { current: false },
    agentRunningRef: { current: false },
    lastAgentErrorRef: { current: false },
    lastAgentAbortedRef: { current: false },
    pendingScrollToUserRef: { current: false },
    displayedLiveTailRef: { current: true },
    readingIntentRef: { current: "reading" },
    liveFollowFrameRef: { current: null },
  };
  const {
    loadSessionSource: loadSource,
    settleUiStageSource,
    notifyPromptStageSource,
    handleAgentEventSource: eventSource,
  } = extractHistorySources(hookSource);
  installRuntimeState(ctx);
  vm.createContext(ctx);
  vm.runInContext(stripTypeScriptTypes([
    loadSource,
    ...(realTerminalHelpers ? [settleUiStageSource, notifyPromptStageSource] : []),
    eventSource,
    "globalThis.loadSession = loadSession;",
    "globalThis.handleAgentEvent = handleAgentEvent;",
  ].join("\n")), ctx);
  return {
    ctx,
    requests,
    writes,
    branch,
    get messages() { return messages; },
    get entryIds() { return entryIds; },
    get streamState() { return streamState; },
    get activeToolResults() { return activeToolResults; },
    get agentPhase() { return agentPhase; },
  };
}


function durablePage(scope, request, { entryId = "saved-entry", text = "saved body", revision = "history-r1" } = {}) {
  return { sessionId: scope.sessionId, leafId: scope.leafId ?? null, revision, kind: "window",
    items: [{ entryId, orderKey:[0,1,0], role:'assistant', contentState:'full', process:false, toolCallCount:0, sourceType: "message", messageIndex: 0, turnAnchor: null, message: { role: "assistant", content: text }, deferred: [] }],
    totalMessages: 1, firstUserEntryId: null, lastUserEntryId: null, nodeCount: 1, nodeOffset: 0,
    before: null, after: null, coverage: { start: true, end: true }, processSummaries: [] };
}

test("metadata bootstrap has a deadline instead of leaving cached content indefinitely unvalidated", async () => {
  const h = createRefreshHarness();
  const deadline = new AbortController();
  h.ctx.AbortSignal = { timeout: ms => { assert.equal(ms, 15000); return deadline.signal; } };
  const reading = h.ctx.loadSession("s", true);
  assert.equal(h.requests[0].signal, deadline.signal);
  h.requests[0].reject(new DOMException("Timed out", "TimeoutError"));
  await reading;
  assert.deepEqual(h.writes.loading, [true, false]);
  assert.match(h.writes.errors.at(-1), /Timed out/);
});

function createDurableHistoryHarness(scope = { sessionId: "s", peer: null, leafId: "leaf" }) {
  resetHistoryViewCacheForTests();
  const requests = [];
  const controller = new TranscriptReader(scope, (requestScope, request, signal) => new Promise((resolve, reject) => requests.push({ scope: requestScope, request, signal, resolve, reject })));
  return { controller, requests, resolve(request, overrides) { request.resolve(durablePage(request.scope, request.request, overrides)); } };
}

function terminalSessionBody(revision = "terminal-r2") {
  return {
    sessionId: "s",
    filePath: "/tmp/s.jsonl",
    timing: {
      effectiveMs: 420,
      agentTotalMs: 420,
      modelResponseMs: 180,
      modelResponsePercent: 42.86,
      toolMs: 40,
      otherMs: 200,
      retryWaitMs: 0,
      userWaitMs: 0,
      parent: { agentTotalMs: 300, modelResponseMs: 120 },
      children: { count: 2, agentTotalMs: 120, modelResponseMs: 60, missingRecords: 0 },
      turns: [],
      quality: "complete",
      scope: "session",
    },
    tree: [],
    leafId: "leaf-final",
    context: {
      messages: [
        { role: "user", content: "question-final" },
        { role: "assistant", content: "answer-final" },
      ],
      entryIds: ["question-final", "answer-final"],
      thinkingLevel: "high",
      model: { provider: "test-provider", modelId: "test-model" },
      oldestEntryId: "question-final",
      hasMore: false,
    },
    questionAnalysisJobs: [{ id: "job-final", status: "complete" }],
    questionDraftViews: { "question-final": { text: "draft-final", status: "ready" } },
    history: { hasEarlierHistory: false, hasCompaction: true },
    snapshotRevision: revision,
  };
}

function createTerminalHarness({ hookSource = source } = {}) {
  const harness = createRefreshHarness({ hookSource, realTerminalHelpers: true });
  const { ctx, writes, branch } = harness;
  branch.state = { phase: "current", runtimeLeafId: "leaf", viewedLeafId: "leaf", ready: true, error: null };
  ctx.setData = (value) => { const next = typeof value === "function" ? value(ctx.data ?? null) : value; writes.data.push(next); ctx.data = next; };
  ctx.setActiveLeafId = (value) => { writes.activeLeafIds.push(value); ctx.activeLeafId = value; };
  ctx.setQuestionAnalysisJobs = (value) => { writes.questionAnalysisJobs.push(value); };
  ctx.setQuestionDraftViews = (value) => { writes.questionDraftViews.push(value); };
  return harness;
}

async function runTerminalInterleave({ hookSource = source, jsonPending = false, promptPending = false, dedupeNotification = false } = {}) {
  const harness = createTerminalHarness({ hookSource });
  const runId = "run-terminal";
  if (promptPending) harness.ctx.rpcPromptPendingRef.current = true;
  harness.ctx.handleAgentEvent({ type: "agent_start", runId });
  const runRevision = harness.ctx.stateRunRevisionRef.current;
  if (promptPending) {
    harness.ctx.handleAgentEvent({ type: "agent_settled", runId });
    assert.equal(harness.ctx.stateRunRevisionRef.current, runRevision, "pending agent_settled only records SDK inactivity");
    assert.equal(harness.ctx.sdkAgentActiveRef.current, false);
    if (dedupeNotification) harness.ctx.promptCompletionDeduperRef.current.claim("s", harness.ctx.promptRunIdRef.current, runId);
  } else {
    harness.ctx.handleAgentEvent({ type: "agent_settled", runId });
    assert.equal(harness.requests.length, 1, "agent_settled starts the only final history GET");
    assert.equal(harness.ctx.stateRunRevisionRef.current, runRevision + 1);
    harness.ctx.handleAgentEvent({ type: "agent_settled", runId });
    assert.equal(harness.ctx.stateRunRevisionRef.current, runRevision + 1, "duplicate settled does not advance identity");
  }

  let responseJson;
  let request;
  if (!promptPending) {
    request = harness.requests.shift();
    if (jsonPending) {
      responseJson = deferred();
      request.resolve({ ok: true, status: 200, json: () => responseJson.promise });
      await flushAsync();
    }
  }
  const beforePromptDoneRevision = harness.ctx.stateRunRevisionRef.current;
  harness.ctx.handleAgentEvent({ type: "prompt_done", runId });
  if (!promptPending) {
    assert.equal(harness.ctx.stateRunRevisionRef.current, beforePromptDoneRevision, "deduped no-op prompt_done preserves the final GET identity");
    assert.equal(harness.requests.length, 0, "deduped no-op prompt_done does not schedule a successor");
  } else {
    assert.equal(harness.ctx.stateRunRevisionRef.current, beforePromptDoneRevision + 1, "pending prompt_done advances one real lifecycle");
    assert.equal(harness.requests.length, 1, "pending prompt_done starts the current-identity refresh");
    request = harness.requests.shift();
  }

  const body = terminalSessionBody();
  if (promptPending || !jsonPending) {
    request.resolve({ ok: true, status: 200, json: async () => body });
  } else {
    responseJson.resolve(body);
  }
  await flushAsync();
  await flushAsync();
  const finalData = harness.writes.data.at(-1);
  return {
    harness,
    body,
    finalData,
    finalApplied: finalData?.snapshotRevision === body.snapshotRevision
      && harness.messages.length === 1
      && harness.entryIds.length === 1
      && harness.writes.activeLeafIds.at(-1) === body.leafId
      && JSON.stringify(harness.writes.questionAnalysisJobs.at(-1)) === JSON.stringify(body.questionAnalysisJobs)
      && JSON.stringify(harness.writes.questionDraftViews.at(-1)) === JSON.stringify(body.questionDraftViews)
      && harness.ctx.runtimeInvalidations.some(event => event.reason === "reconcile")
      && harness.writes.cache.length === 0,
    finalRequestCount: harness.requests.length,
    finalRevision: harness.ctx.stateRunRevisionRef.current,
  };
}

const sameRunMutationTypes = ["message_end", "message_update"];

function assistantMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "test-model",
    provider: "test-provider",
  };
}

function prepareSameRunMutation(harness, mutation) {
  harness.ctx.handleAgentEvent({ type: "agent_start", runId: "run-stable" });
  if (mutation === "message_update") {
    harness.ctx.handleAgentEvent({
      type: "message_start",
      runId: "run-stable",
      message: assistantMessage("stream-before"),
    });
  }
}

function emitSameRunMutation(harness, mutation) {
  if (mutation === "message_end") {
    harness.ctx.handleAgentEvent({
      type: "message_end",
      runId: "run-stable",
      message: assistantMessage("stream-end"),
    });
    return;
  }
  harness.ctx.handleAgentEvent({
    type: "message_update",
    runId: "run-stable",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "-update" },
  });
}

function prepareMessageStartMutation(harness) {
  harness.ctx.handleAgentEvent({ type: "agent_start", runId: "run-stable" });
}

function emitMessageStartMutation(harness) {
  harness.ctx.handleAgentEvent({
    type: "message_start",
    runId: "run-stable",
    message: assistantMessage("stream-start"),
  });
}

function assertStableRunMutation(harness, runRevision, runId, previousContentRevision) {
  assert.equal(harness.ctx.stateRunRevisionRef.current, runRevision);
  assert.equal(harness.ctx.currentAgentRunIdRef.current, runId);
  assert.ok(harness.ctx.transcriptMutationRevisionRef.current > previousContentRevision);
}

function prepareMainLoad(harness, mutation) {
  harness.ctx.handleAgentEvent({ type: "agent_start", runId: "run-stable" });
  if (mutation === "message_update") {
    harness.ctx.handleAgentEvent({
      type: "message_start",
      runId: "run-stable",
      message: assistantMessage("stream-before"),
    });
  }
  const load = harness.ctx.loadSession("s", true);
  return { load };
}

function emitMainLoadMutation(harness, mutation) {
  if (mutation === "message_start") {
    emitMessageStartMutation(harness);
    return;
  }
  emitSameRunMutation(harness, mutation);
}

function assertStaleMainLoad(harness, liveMessages, liveStream, result, label) {
  assert.equal(result, null, label);
  assert.deepEqual(harness.messages, liveMessages, label);
  assert.deepEqual(harness.streamState, liveStream, label);
  assert.equal(harness.writes.data.length, 0, label);
  assert.equal(harness.writes.cache.length, 0, label);
  assert.equal(harness.writes.deleted, 0, label);
  assert.equal(harness.writes.clear, 0, label);
  assert.equal(harness.writes.errors.length, 0, label);
  assert.deepEqual(harness.writes.branch, [], label);
  assert.deepEqual(harness.writes.loading, [true, false], label);
  assert.equal(harness.ctx.blockingLoadOwnerRef.current, null, label);
}

test("real main load rejects same-run message mutations across deferred responses", async () => {
  const mutations = ["message_start", "message_update", "message_end"];
  const outcomes = [
    ["success", (request) => request.resolve(sessionResponse("r1", "leaf"))],
    ["404", (request) => request.resolve({ ok: false, status: 404 })],
    ["HTTP", (request) => request.resolve({ ok: false, status: 503 })],
    ["fetch", (request) => request.reject(new Error("network down"))],
  ];
  for (const mutation of mutations) {
    for (const [kind, finish] of outcomes) {
      const harness = createRefreshHarness();
      const { load } = prepareMainLoad(harness, mutation);
      await flushAsync();
      assert.equal(harness.requests.length, 1, `${mutation}:${kind}`);
      const request = harness.requests.shift();
      const initialRunRevision = harness.ctx.stateRunRevisionRef.current;
      const initialRunId = harness.ctx.currentAgentRunIdRef.current;
      const initialContentRevision = harness.ctx.transcriptMutationRevisionRef.current;
      emitMainLoadMutation(harness, mutation);
      assertStableRunMutation(harness, initialRunRevision, initialRunId, initialContentRevision);
      const liveMessages = harness.messages.slice();
      const liveStream = harness.streamState;
      finish(request);
      assertStaleMainLoad(harness, liveMessages, liveStream, await load, `${mutation}:${kind}`);
    }

    const harness = createRefreshHarness();
    const { load } = prepareMainLoad(harness, mutation);
    await flushAsync();
    const request = harness.requests.shift();
    const json = deferred();
    request.resolve({ ok: true, status: 200, json: () => json.promise });
    await flushAsync();
    emitMainLoadMutation(harness, mutation);
    const liveMessages = harness.messages.slice();
    const liveStream = harness.streamState;
    json.resolve(await sessionResponse("r1", "leaf").json());
    assertStaleMainLoad(harness, liveMessages, liveStream, await load, `${mutation}:json-pending`);
  }
});

test("main load freezes default run identity and keeps explicit guards additive", async () => {
  for (const mutation of ["revision", "run-id"]) {
    const harness = createRefreshHarness();
    const load = harness.ctx.loadSession("s", false);
    await flushAsync();
    const request = harness.requests.shift();
    if (mutation === "revision") harness.ctx.stateRunRevisionRef.current += 1;
    else harness.ctx.currentAgentRunIdRef.current = "run-new";
    request.resolve(sessionResponse("r1", "leaf"));
    assert.equal(await load, null, mutation);
    assert.equal(harness.writes.data.length, 0, mutation);
    assert.equal(harness.writes.cache.length, 0, mutation);
    assert.equal(harness.writes.errors.length, 0, mutation);
  }

  const explicit = createRefreshHarness();
  explicit.ctx.stateRunRevisionRef.current = 4;
  explicit.ctx.currentAgentRunIdRef.current = "run-a";
  const load = explicit.ctx.loadSession("s", false, null, { stateRunRevision: 4 });
  await flushAsync();
  explicit.ctx.currentAgentRunIdRef.current = "run-b";
  explicit.requests.shift().resolve(sessionResponse("r1", "leaf"));
  assert.equal(await load, null, "explicit guard still checks the default run id");
});

test("late metadata success and errors cannot cross session, peer, branch, or unmount boundaries", async () => {
  const transitions = {
    session: ctx => { ctx.sessionIdRef.current = "other"; },
    peer: ctx => { ctx.remotePeerRef.current = "other-peer"; },
    branch: ctx => { ctx.branchScopeRef.current = "local:other"; },
    unmount: ctx => { ctx.sessionHookMountedRef.current = false; },
  };
  for (const [scope, change] of Object.entries(transitions)) for (const outcome of ["success", "404", "fetch", "json-pending"]) {
    const h = createRefreshHarness();
    const load = h.ctx.loadSession("s", true);
    const request = h.requests.shift();
    const json = deferred();
    if (outcome === "json-pending") {
      request.resolve({ ok: true, status: 200, json: () => json.promise });
      await flushAsync();
    }
    change(h.ctx);
    if (outcome === "success") request.resolve(sessionResponse());
    else if (outcome === "404") request.resolve({ ok: false, status: 404 });
    else if (outcome === "fetch") request.reject(new Error("old request failed"));
    else json.resolve(await sessionResponse().json());
    assert.equal(await load, null, `${scope}:${outcome}`);
    assert.equal(h.writes.data.length, 0, `${scope}:${outcome}`);
    assert.equal(h.writes.errors.length, 0, `${scope}:${outcome}`);
    assert.equal(h.writes.clear, 0, `${scope}:${outcome}`);
    assert.equal(h.ctx.runtimeInvalidations.length, 0, `${scope}:${outcome}`);
    assert.deepEqual(h.writes.loading, [true], "old scope cannot close a new scope's loading owner");
    assert.deepEqual(h.messages, [{ role: "assistant", content: "seed" }]);
  }
});

test("preview refresh updates runtime metadata without moving the viewed branch or live overlay", async () => {
  for (const viewedLeafId of ["old-branch", null]) {
    const h = createRefreshHarness();
    const branch = new BranchNavigation();
    branch.reset("local:s");
    branch.observeRuntime("old-runtime");
    assert.equal(await branch.preview(viewedLeafId, async () => true), true);
    h.ctx.branchRef.current = branch;
    h.ctx.data = { sessionId: "s", context: {} };
    h.ctx.setActiveLeafId = value => h.writes.activeLeafIds.push(value);
    h.ctx.setQuestionAnalysisJobs = value => h.writes.questionAnalysisJobs.push(value);
    h.ctx.setQuestionDraftViews = value => h.writes.questionDraftViews.push(value);
    const load = h.ctx.loadSession("s", true);
    const metadata = await sessionResponse("fresh-preview-metadata", "new-runtime").json();
    metadata.questionAnalysisJobs = [{ id: "fresh-job" }];
    metadata.questionDraftViews = { user: { status: "ready" } };
    metadata.toolNames = ["read"];
    h.requests.shift().resolve({ ok: true, status: 200, json: async () => metadata });
    assert.equal(await load, metadata);
    assert.equal(h.ctx.data.snapshotRevision, "fresh-preview-metadata");
    assert.deepEqual(h.writes.questionAnalysisJobs, [metadata.questionAnalysisJobs]);
    assert.deepEqual(h.writes.questionDraftViews, [metadata.questionDraftViews]);
    assert.equal(h.ctx.sessionToolsPinnedRef.current, true);
    assert.deepEqual(h.writes.activeLeafIds, [viewedLeafId]);
    assert.equal(branch.state.viewedLeafId, viewedLeafId);
    assert.equal(branch.state.runtimeLeafId, "new-runtime");
    assert.equal(branch.state.phase, "preview");
    assert.equal(canWriteBranch(branch.state), false);
    assert.deepEqual(h.messages, [{ role: "assistant", content: "seed" }]);
    assert.deepEqual(h.entryIds, ["seed-entry"]);
    assert.equal(h.ctx.data.context.messages.length, 0, "metadata is body-free");

    assert.deepEqual(h.writes.loading, [true, false]);
  }
});

test("metadata refresh cannot publish over a pending preview or acknowledged navigation", async () => {
  for (const phase of ["loading", "switching"]) {
    const h = createRefreshHarness();
    h.branch.state = { phase, viewedLeafId: "preview", runtimeLeafId: "runtime", ready: true };
    const load = h.ctx.loadSession("s", true);
    h.requests.shift().resolve(sessionResponse("pending", "new-runtime"));
    assert.equal(await load, null);
    assert.equal(h.writes.data.length, 0);
    assert.equal(h.ctx.runtimeInvalidations.length, 0);
    assert.deepEqual(h.writes.loading, [true, false]);
  }
});

test("current metadata load delegates history while blocking owners close independently", async () => {
  const current = createRefreshHarness();
  const first = current.ctx.loadSession("s", false);
  await flushAsync();
  current.requests.shift().resolve(sessionResponse("r1", "leaf"));
  assert.equal((await first)?.sessionId, "s");
  assert.equal(current.writes.data.length, 1);
  assert.equal(current.writes.cache.length, 0, "runtime owner never writes durable history cache");
  assert.deepEqual(current.messages, [{ role: "assistant", content: "seed" }], "metadata cannot replace the live overlay");



  const overlap = createRefreshHarness();
  const ownerA = overlap.ctx.loadSession("s", true);
  await flushAsync();
  const requestA = overlap.requests.shift();
  const ownerB = overlap.ctx.loadSession("s", true);
  await flushAsync();
  const requestB = overlap.requests.shift();
  requestA.resolve({ ok: false, status: 404 });
  assert.equal(await ownerA, null);
  assert.deepEqual(overlap.writes.loading, [true, true]);
  requestB.resolve(sessionResponse("r1", "leaf"));
  assert.equal((await ownerB)?.sessionId, "s");
  assert.deepEqual(overlap.writes.loading, [true, true, false]);

  const nonBlocking = createRefreshHarness();
  const blocking = nonBlocking.ctx.loadSession("s", true);
  await flushAsync();
  const blockingRequest = nonBlocking.requests.shift();
  const background = nonBlocking.ctx.loadSession("s", false);
  await flushAsync();
  const backgroundRequest = nonBlocking.requests.shift();
  backgroundRequest.resolve(sessionResponse("r1", "leaf"));
  assert.equal((await background)?.sessionId, "s");
  assert.deepEqual(nonBlocking.writes.loading, [true]);
  blockingRequest.resolve({ ok: false, status: 503 });
  assert.equal(await blocking, null);
  assert.deepEqual(nonBlocking.writes.loading, [true, false]);
});

test("connected replaces cold and cache validation reads without weakening stale guards", async () => {
  for (const [label, showLoading] of [["cold", true], ["cache", false]]) {
    const harness = createRefreshHarness();
    const durable = createDurableHistoryHarness();
    const saved = durable.controller.reconcileTail();
    durable.resolve(durable.requests.shift(), { text: "cached durable body" });
    await saved;
    const cachedPage = durable.controller.getState().transcript;
    harness.ctx.sessionViewValidationPendingRef.current = true;
    const initial = harness.ctx.loadSession("s", showLoading);
    await flushAsync();
    const first = harness.requests.shift();
    assert.ok(first, `${label}: initial request`);
    const visibleBeforeConnected = harness.messages.slice();

    harness.ctx.handleAgentEvent({ type: "connected" });
    assert.equal(harness.ctx.stateRunRevisionRef.current, 1, label);
    assert.equal(harness.ctx.currentAgentRunIdRef.current, null, label);
    assert.equal(harness.requests.length, 1, `${label}: exactly one replacement`);
    const replacement = harness.requests.shift();
    assert.ok(replacement, `${label}: replacement request`);

    first.resolve(sessionResponse("r1", "leaf"));
    assert.equal(await initial, null, `${label}: stale initial response`);
    assert.deepEqual(harness.messages, visibleBeforeConnected, `${label}: stale response preserved display`);
    assert.equal(harness.ctx.sessionViewValidationPendingRef.current, true, `${label}: validation remains pending`);
    if (showLoading) assert.deepEqual(harness.writes.loading, [true, true], `${label}: successor owns blocking loading`);

    replacement.resolve(sessionResponse("r2", "leaf"));
    await flushAsync();
    assert.deepEqual(harness.messages, visibleBeforeConnected, `${label}: metadata preserves live overlay`);
    assert.deepEqual(harness.entryIds, ["seed-entry"], `${label}: metadata preserves live entry ids`);
    assert.equal(harness.ctx.data.snapshotRevision, "r2", `${label}: replacement metadata applies`);
    assert.equal(durable.controller.getState().transcript, cachedPage, `${label}: runtime validation cannot overwrite history owner`);

    assert.equal(harness.ctx.sessionViewValidationPendingRef.current, false, `${label}: validation completed`);
    assert.equal(harness.branch.state.phase, "current", `${label}: branch remains current`);
    assert.equal(harness.ctx.blockingLoadOwnerRef.current, null, `${label}: blocking owner closed`);
    if (showLoading) assert.deepEqual(harness.writes.loading, [true, true, false], `${label}: loading closed by successor`);
    else assert.deepEqual(harness.writes.loading, [], `${label}: cache validation stays nonblocking`);
    assert.equal(harness.requests.length, 0, `${label}: no follow-up reload`);

    harness.ctx.handleAgentEvent({ type: "connected" });
    assert.equal(harness.requests.length, 0, `${label}: validated idle connected does not reload`);
    durable.controller.dispose();
  }
});

test("a new connection clears old tool output before replaying only live tools", () => {
  const harness = createRefreshHarness();
  harness.ctx.handleAgentEvent({ type: "tool_execution_start", toolCallId: "old", toolName: "bash" });
  harness.ctx.handleAgentEvent({ type: "tool_execution_update", toolCallId: "old", toolName: "bash", partialResult: { content: [{ type: "text", text: "old output" }] } });
  assert.equal(harness.agentPhase.kind, "running_tools");
  assert.equal(harness.activeToolResults.has("old"), true);

  harness.ctx.handleAgentEvent({ type: "connected", isStreaming: true });
  assert.equal(harness.agentPhase.kind, "waiting_model");
  assert.equal(harness.activeToolResults.size, 0, "output from a tool that ended while disconnected is stale");
  harness.ctx.handleAgentEvent({ type: "tool_execution_start", toolCallId: "live", toolName: "bash" });
  assert.equal(harness.agentPhase.kind, "running_tools");
  assert.equal(harness.agentPhase.tools[0].id, "live");
  harness.ctx.handleAgentEvent({ type: "tool_execution_end", toolCallId: "live", toolName: "bash" });
  assert.equal(harness.agentPhase.kind, "waiting_model");

  harness.ctx.handleAgentEvent({ type: "tool_execution_start", toolCallId: "stale", toolName: "bash" });
  harness.ctx.handleAgentEvent({ type: "connected", isStreaming: false, isPromptRunning: false });
  assert.equal(harness.agentPhase, null, "an idle reconnect must not retain the previous tool");
});

test("parallel live tools survive intervening message events and ignore nested calls", () => {
  const harness = createRefreshHarness();
  harness.ctx.agentRunningRef.current = true;
  harness.ctx.handleAgentEvent({ type: "tool_execution_start", toolCallId: "a", toolName: "bash" });
  harness.ctx.handleAgentEvent({ type: "tool_execution_start", toolCallId: "b", toolName: "bash" });
  harness.ctx.handleAgentEvent({ type: "tool_execution_start", toolCallId: "a/child", parentToolCallId: "a", toolName: "bash" });
  harness.ctx.handleAgentEvent({ type: "message_end" });
  assert.equal(harness.agentPhase.kind, "running_tools");
  assert.deepEqual(Array.from(harness.agentPhase.tools, tool => tool.id), ["a", "b"]);
  harness.ctx.handleAgentEvent({ type: "tool_execution_end", toolCallId: "a", toolName: "bash" });
  assert.deepEqual(Array.from(harness.agentPhase.tools, tool => tool.id), ["b"]);
  harness.ctx.handleAgentEvent({ type: "tool_execution_end", toolCallId: "b", toolName: "bash" });
  assert.equal(harness.agentPhase.kind, "waiting_model");
});

test("connected replacement stays bounded across JSON-pending and consecutive identities", async () => {
  const harness = createRefreshHarness();
  harness.ctx.sessionViewValidationPendingRef.current = true;
  const initial = harness.ctx.loadSession("s", true);
  await flushAsync();
  const first = harness.requests.shift();
  const json = deferred();
  first.resolve({ ok: true, status: 200, json: () => json.promise });
  await flushAsync();

  harness.ctx.handleAgentEvent({ type: "connected" });
  assert.equal(harness.requests.length, 1, "one replacement while JSON is pending");
  const second = harness.requests.shift();
  harness.ctx.handleAgentEvent({ type: "connected" });
  assert.equal(harness.requests.length, 1, "one successor for the second identity");
  const third = harness.requests.shift();

  json.resolve(await sessionResponse("r1", "leaf").json());
  assert.equal(await initial, null, "old JSON response stays stale");
  assert.deepEqual(harness.writes.loading, [true, true, true], "old finally cannot clear the latest owner");
  second.resolve(sessionResponse("r2", "leaf"));
  third.resolve(sessionResponse("r3", "leaf"));
  await flushAsync();
  assert.deepEqual(harness.messages, [{ role: "assistant", content: "seed" }]);
  assert.deepEqual(harness.entryIds, ["seed-entry"]);
  assert.equal(harness.ctx.data.snapshotRevision, "r3");

  assert.equal(harness.ctx.sessionViewValidationPendingRef.current, false);
  assert.equal(harness.ctx.blockingLoadOwnerRef.current, null);
  assert.deepEqual(harness.writes.loading, [true, true, true, false]);
  assert.equal(harness.requests.length, 0, "no reload loop after the final identity");

  const idle = createRefreshHarness();
  idle.ctx.handleAgentEvent({ type: "connected" });
  assert.equal(idle.requests.length, 0, "connected with no pending load does not fetch history");
});

test("terminal settling keeps the final production history read alive through no-op prompt_done", async () => {
  for (const jsonPending of [false, true]) {
    const current = await runTerminalInterleave({ jsonPending });
    assert.equal(current.finalApplied, true, `final response converges after ${jsonPending ? "JSON" : "fetch"} pending`);
    assert.equal(current.finalRequestCount, 0, "no successor or retry GET follows the no-op terminal event");
    assert.equal(current.finalData?.timing?.effectiveMs, 420);
    assert.equal(current.finalData?.timing?.children.count, 2);
    assert.equal(current.harness.messages.length, 1, "settle retains the transcript until additive reconciliation completes");
    assert.equal(current.harness.entryIds.length, 1);

    assert.equal(current.harness.ctx.sessionViewValidationPendingRef.current, false);
    assert.equal(current.harness.ctx.agentRunningRef.current, false);
    assert.equal(current.harness.ctx.sdkAgentActiveRef.current, false);
    assert.equal(current.harness.writes.notifications.length, 1, "settled event notifies once");
  }
});

test("prompt_done retains legitimate refreshes for pending and already-notified prompts", async () => {
  for (const dedupeNotification of [false, true]) {
    const current = await runTerminalInterleave({ promptPending: true, dedupeNotification });
    assert.equal(current.finalApplied, true, `pending prompt refreshes when notification ${dedupeNotification ? "is deduped" : "is new"}`);
    assert.equal(current.finalRequestCount, 0);
    assert.equal(current.harness.ctx.sessionViewValidationPendingRef.current, false);
    assert.equal(current.harness.ctx.agentRunningRef.current, false);
    assert.equal(current.harness.ctx.sdkAgentActiveRef.current, false);
    assert.equal(current.harness.ctx.data.timing?.effectiveMs, 420);
    assert.equal(current.harness.writes.notifications.length, dedupeNotification ? 0 : 1);
  }
});



test("keeps the session event stream open through the idle grace window", () => {
  const finishSource = source.slice(
    source.indexOf("const finishPromptWithoutStream"),
    source.indexOf("  // Reconcile client streaming state"),
  );
  const graceSource = source.slice(
    source.indexOf("const scheduleEventStreamClose"),
    source.indexOf("const finishPromptWithoutStream"),
  );
  const agentEndSource = source.slice(
    source.indexOf('case "agent_end"'),
    source.indexOf('case "agent_settled"'),
  );
  const agentStartSource = source.slice(
    source.indexOf('case "agent_start"'),
    source.indexOf('case "agent_end"'),
  );
  const agentSettledSource = source.slice(
    source.indexOf('case "agent_settled"'),
    source.indexOf('case "prompt_done"'),
  );
  const promptDoneSource = source.slice(
    source.indexOf('case "prompt_done"'),
    source.indexOf('case "prompt_error"'),
  );
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );

  assert.match(source, /const EVENT_STREAM_IDLE_GRACE_MS = 30_000/);
  assert.match(graceSource, /setTimeout\(\(\) => \{/);
  assert.match(graceSource, /EVENT_STREAM_IDLE_GRACE_MS/);
  assert.doesNotMatch(graceSource, /checkServerIdle|fetch\(apiPath/);
  assert.match(graceSource, /closeEvents\(\)/);
  assert.match(finishSource, /scheduleEventStreamClose\(sid\)/);
  assert.doesNotMatch(finishSource, /closeEvents\(\)/);
  assert.doesNotMatch(agentEndSource, /closeEvents\(\)/);
  assert.match(agentStartSource, /cancelEventStreamGrace\(\)/);
  assert.match(agentSettledSource, /scheduleEventStreamClose\(sid\)/);
  assert.match(agentSettledSource, /notifyPromptStage\(promptRunIdRef\.current, serverRunId\)/);
  assert.match(promptDoneSource, /notifyPromptStage\(runId, serverRunId\)/);
  assert.match(promptDoneSource, /scheduleEventStreamClose\(sid\)/);
  assert.match(sendSource, /const definitivelyRejected = !submission\.requestStarted/);
  // 快速 prompt 结算恢复仅用于非流式斜杠命令；普通 prompt 发送由 SSE 驱动。
  assert.match(sendSource, /if \(isSlashCommandPrompt && sentSessionId\) \{\s+void waitForPromptSettlement\(sentSessionId, promptRunId\);/);
  assert.doesNotMatch(sendSource, /waitForBashSettlement/);
  assert.match(sendSource, /restoreSubmission\(message, images, composerDraftKey\);[\s\S]*?if \(sentSessionId\) \{[\s\S]*?reconcileAgentState\(sentSessionId\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?closeEvents\(\)/);
  assert.match(sendSource, /if \(submission\.requestStarted\) \{[\s\S]*?rpcPromptPendingRef\.current = true;[\s\S]*?return;/);
  assert.match(sendSource, /if \(sentSessionId\) \{[\s\S]*?reconcileAgentState\(sentSessionId\);/);
  assert.match(source, /window\.setInterval\(reconcile, 15_000\)/);
  assert.match(source, /window\.setTimeout\(\(\) => controller\.abort\(\), 5_000\)/);
});


test("completion dedup uses server run identity, local fallback, and session scope", () => {
  const helperStart = source.indexOf("export function createPromptCompletionDeduper");
  const helperEnd = source.indexOf("export function useAgentSession", helperStart);
  const helperSource = stripTypeScriptTypes(source.slice(helperStart, helperEnd).replace(/^export /gm, ""));
  const sandbox = {};
  vm.runInNewContext(`${helperSource}; globalThis.makeDeduper = createPromptCompletionDeduper;`, sandbox);
  const deduper = sandbox.makeDeduper();
  const notifications = [];
  const notify = (sessionId, localRunId, serverRunId, terminal) => {
    if (deduper.claim(sessionId, localRunId, serverRunId)) notifications.push({ serverRunId: serverRunId ?? null, localRunId, terminal });
  };

  notify("session-a", 0, "external-a", "settled");
  notify("session-a", 0, "external-a", "prompt_done");
  notify("session-a", 0, "external-b", "settled");
  notify("session-a", 1, undefined, "local-1");
  notify("session-a", 1, undefined, "local-1-duplicate");
  notify("session-a", 2, undefined, "local-2");
  notify("session-a", 0, undefined, "missing-identity");
  notify("session-a", 0, undefined, "missing-identity-duplicate");
  notify("session-b", 0, "external-a", "new-session");

  assert.deepEqual(notifications, [
    { serverRunId: "external-a", localRunId: 0, terminal: "settled" },
    { serverRunId: "external-b", localRunId: 0, terminal: "settled" },
    { serverRunId: null, localRunId: 1, terminal: "local-1" },
    { serverRunId: null, localRunId: 2, terminal: "local-2" },
    { serverRunId: null, localRunId: 0, terminal: "missing-identity" },
    { serverRunId: "external-a", localRunId: 0, terminal: "new-session" },
  ]);
  assert.match(source, /notifyPromptStage\(promptRunIdRef\.current, serverRunId\)/);
  assert.match(source, /notifyPromptStage\(runId, serverRunId\)/);
  assert.match(chatWindowSource, /canPlaySoundProp\("done"\)/);
});

test("lets get_state clear an activity-seeded idle session", () => {
  const mountSource = source.slice(
    source.indexOf("// Load session on mount"),
    source.indexOf("  useEffect(() => {\n    onSystemPromptChange"),
  );

  assert.match(mountSource, /const loadSettlementGeneration = sessionSettlementGenerationRef\.current/);
  assert.match(mountSource, /const loadRunRevision = stateRunRevisionRef\.current/);
  assert.match(mountSource, /restoreLoadedRunState\(session\.id, agentState, loadSettlementGeneration, loadRunRevision\)/);
  assert.match(source, /expectedRunRevision !== undefined && stateRunRevisionRef\.current !== expectedRunRevision/);
  assert.match(source, /sessionRunningRef\.current = serverBusy/);
  assert.doesNotMatch(chatWindowSource, /observedSessionRunning/);
});

test("ignores an older session reload after a newer transcript snapshot", () => {
  const loadSource = source.slice(
    source.indexOf("  const loadSession = useCallback"),
    source.indexOf("  const loadContext = useCallback"),
  );
  // An error-end reload can return after the successful retry reload. The
  // older response must not replace the newer transcript and restore the
  // stale error as the last message.
  const generationGuard = loadSource.indexOf("const isCurrentLoad = () =>");
  const messageWrite = loadSource.indexOf("setData(");
  assert.notEqual(generationGuard, -1);
  assert.notEqual(messageWrite, -1);
  assert.ok(generationGuard < messageWrite);
  assert.match(loadSource, /if \(!isCurrentLoad\(\)\) return null;/);
});





test("local prompt start invalidates pending state snapshots", () => {
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const handleRetryContinue", source.indexOf("  const handleSend = useCallback")),
  );
  assert.match(sendSource, /const promptRunId = promptRunIdRef\.current \+ 1;[\s\S]*?stateRunRevisionRef\.current \+= 1;/);
});

test("historical edit keeps its identity until the atomic server admission", () => {
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback", source.indexOf("  const handleSend = useCallback")),
  );
  assert.match(sendSource, /const historyEditEntryId = editEntryId/);
  assert.match(sendSource, /type: "edit_history"/);
  assert.match(sendSource, /pendingHistoryEdits\.get\(historyEditKey\)/);
  assert.doesNotMatch(sendSource, /temporarily unavailable until branch navigation and prompt admission are atomic/);
  assert.doesNotMatch(sendSource, /handleNavigateRef\.current\?\.\(targetLeafId\)/);
});

test("historical edit follows the acknowledged leaf after an idempotent response", () => {
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback", source.indexOf("  const handleSend = useCallback")),
  );
  assert.match(sendSource, /const acknowledgedLeafId = result\?\.leafId !== undefined \? result\.leafId : result\?\.parentId/);
  assert.match(sendSource, /observeRuntime\(acknowledgedLeafId\)/);
  assert.match(sendSource, /setActiveLeafId\(acknowledgedLeafId\)/);
});

test("cancelled historical edit keeps its identity for a later retry", () => {
  const editSource = source.slice(source.indexOf("  const setEdit = useCallback"), source.indexOf("  const sessionStats = useMemo"));
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback", source.indexOf("  const handleSend = useCallback")),
  );
  assert.match(editSource, /const cancelEdit = useCallback\([\s\S]*?setEditEntryId\(null\)/);
  assert.doesNotMatch(editSource, /const cancelEdit = useCallback\(\(\) => setEdit\(null\)/);
  assert.match(sendSource, /const storedHistoryEdit = session\?\.id \? getDraft\(historyDraftKey\(session\.id, remotePeerRef\.current\)\)\?\.historyEdit/);
  assert.match(sendSource, /const pendingHistoryEdit = historyEditKey[\s\S]*?pendingHistoryEdits\.get\(historyEditKey\)/);
  assert.match(sendSource, /const historyEditEntryId = editEntryId \?\? pendingHistoryEdit\?\.entryId \?\? null/);
});

test("retry branch preflight rejection restores idle without hiding the failure", async () => {
  const retrySource = source.slice(
    source.indexOf("  const handleRetryContinue = useCallback"),
    source.indexOf("  const executeBash = useCallback", source.indexOf("  const handleRetryContinue = useCallback")),
  );
  let sendCalls = 0;
  let started = 0;
  let closed = 0;
  const writes = { running: [], phases: [], actions: [] };
  const ctx = {
    useCallback: (fn) => fn,
    sessionIdRef: { current: "s" },
    session: { id: "s" },
    sessionHookMountedRef: { current: true },
    branchScopeRef: { current: "local:s" },
    agentRunningRef: { current: false },
    bashRunningRef: { current: false },
    remotePeerRef: { current: null },
    messagesRef: { current: [] },
    entryIdsRef: { current: [] },
    latestRetryErrorEntry: () => "failed-entry",
    cancelInitialLanding() {},
    promptRunIdRef: { current: 0 },
    stateRunRevisionRef: { current: 0 },
    cancelEventStreamGrace() {},
    rpcPromptPendingRef: { current: false },
    setAgentRunning: (value) => writes.running.push(value),
    setAgentPhase: (value) => writes.phases.push(value),
    dispatch: (action) => writes.actions.push(action),
    ensureEventsConnected: async () => {},
    onRetryContinueStartedRef: { current: () => { started += 1; } },
    sendAgentCommandR: async () => {
      sendCalls += 1;
      throw new AgentCommandError("Return to the current conversation", 409, "prompt_rejected", false);
    },
    isPromptRejectedError,
    closeEvents: () => { closed += 1; },
    sessionRunningRef: { current: false },
    console: { error() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(stripTypeScriptTypes(`${retrySource}\nglobalThis.retry = handleRetryContinue;`), ctx);

  await ctx.retry();
  assert.equal(sendCalls, 1);
  assert.equal(started, 0, "local rejection must not hide the failed retry entry");
  assert.deepEqual(writes.running, [true, false]);
  assert.equal(writes.phases[0].kind, "waiting_model");
  assert.equal(writes.phases[1], null);
  assert.equal(writes.actions[0].type, "start");
  assert.equal(writes.actions[1].type, "end");
  assert.equal(ctx.rpcPromptPendingRef.current, false);
  assert.equal(ctx.agentRunningRef.current, false);
  assert.equal(closed, 1);
});

test("late agent_end transcript reload cannot overwrite a newer run", async () => {
  const loadSource = source.slice(
    source.indexOf("  const loadSession = useCallback"),
    source.indexOf("  const loadContext = useCallback"),
  );
  const writes = {};
  const ctx = {
    useCallback: (fn) => fn,
    Map,
    apiPath: (url) => url,
    encodeURIComponent,
    URLSearchParams,
    sessionHookMountedRef: { current: true },
    sessionIdRef: { current: "s" },
    branchScopeRef: { current: "local:s" },
    sessionViewValidationPendingRef: { current: false },
    sessionLoadGenerationRef: { current: 0 },
    blockingLoadOwnerRef: { current: null },
    pendingSessionLoadRef: { current: null },
    transcriptMutationRevisionRef: { current: 0 },
    branchRef: { current: { observeRuntime() {}, state: { phase: "current" } } },
    stateRunRevisionRef: { current: 7 },
    currentAgentRunIdRef: { current: "run-a" },
    remotePeerRef: { current: null },
    setSessionStatsOverride() {},
    setLoading() {},
    setData: (value) => { writes.data = typeof value === "function" ? value(writes.data ?? null) : value; },
    setFastModeSelection() {},
    setFastModeRuntimeStatus() {},
    setQuestionAnalysisJobs() {},
    setQuestionDraftViews() {},
    setActiveLeafId() {},
    hiddenRetryErrorIdsRef: { current: new Set() },
    readHiddenRetryErrorIds: () => new Set(),
    filterHiddenRetryErrors: (messages, entryIds) => ({ messages, entryIds }),
    messagesRef: { current: [] },
    onBeforeApplyHistoryRef: { current: null },
    setMessages: (value) => { writes.messages = value; },
    setEntryIds: (value) => { writes.entryIds = value; },
    setHasEarlierHistory() {},
    setHasCompaction() {},
    historyCursorRef: { current: null },
    setHasEarlierMessages() {},
    setCurrentModelOverride() {},
    modelSwitchPendingRef: { current: false },
    setError: (value) => { writes.error = value; },
    setThinkingLevel() {},
    fullHistoryExpandedRef: { current: false },
    loadFullHistory() {},
    getSessionViewSnapshot: () => null,
    setSessionViewSnapshot: () => true,
    deleteSessionViewSnapshot() {},
    cacheKeyForSession: (sid) => sid,
    snapshotCoversLoadedEntries: () => true,
    clearLoadedSessionView() {},
    writeSettledSessionViewSnapshot() {},
  };
  const responses = [];
  ctx.fetch = () => new Promise((resolve) => responses.push(resolve));
  installRuntimeState(ctx);
  vm.createContext(ctx);
  vm.runInContext(stripTypeScriptTypes(`${loadSource}\nglobalThis.load = loadSession;`), ctx);

  assert.equal(typeof ctx.load, "function");
  const stale = ctx.load("s", false, null, { stateRunRevision: 7, serverRunId: "run-a" });
  ctx.stateRunRevisionRef.current = 8;
  ctx.currentAgentRunIdRef.current = "run-b";
  await Promise.resolve();
  assert.equal(responses.length, 1, `pending responses: ${responses.length}`);
  responses.shift()({
    ok: true,
    status: 200,
    json: async () => ({
      sessionId: "s",
      filePath: "/tmp/s.jsonl",
      timing: { effectiveMs: 1 },
      leafId: null,
      context: { messages: [{ role: "assistant", content: "old" }], entryIds: [], thinkingLevel: "auto", model: null },
    }),
  });
  assert.equal(await stale, null);
  assert.equal(writes.messages, undefined);

  const current = ctx.load("s", false, null, { stateRunRevision: 8, serverRunId: "run-b" });
  await Promise.resolve();
  responses.shift()({
    ok: true,
    status: 200,
    json: async () => ({
      sessionId: "s",
      filePath: "/tmp/s.jsonl",
      timing: { effectiveMs: 2 },
      leafId: null,
      context: { messages: [{ role: "assistant", content: "new" }], entryIds: [], thinkingLevel: "auto", model: null },
    }),
  });
  assert.equal((await current)?.sessionId, "s");
  assert.equal(writes.messages, undefined, "metadata cannot replace durable or live messages");
  assert.equal(writes.data.timing?.effectiveMs, 2);

});

test("keeps a readable transcript when remote branch position is temporarily unknown", async () => {
  const loadSource = source.slice(
    source.indexOf("  const loadSession = useCallback"),
    source.indexOf("  const loadContext = useCallback"),
  );
  const writes = {};
  const ctx = {
    useCallback: (fn) => fn,
    Map,
    apiPath: (url) => url,
    encodeURIComponent,
    URLSearchParams,
    sessionHookMountedRef: { current: true },
    sessionIdRef: { current: "remote" },
    branchScopeRef: { current: "debian:remote" },
    sessionViewValidationPendingRef: { current: false },
    sessionLoadGenerationRef: { current: 0 },
    blockingLoadOwnerRef: { current: null },
    pendingSessionLoadRef: { current: null },
    transcriptMutationRevisionRef: { current: 0 },
    branchRef: { current: { observeRuntime() {}, state: { phase: "unknown" } } },
    stateRunRevisionRef: { current: 0 },
    currentAgentRunIdRef: { current: null },
    remotePeerRef: { current: "debian" },
    setSessionStatsOverride() {},
    setLoading: (value) => { writes.loading = value; },
    setData: (value) => { writes.data = typeof value === "function" ? value(writes.data ?? null) : value; },
    setFastModeSelection() {},
    setFastModeRuntimeStatus() {},
    setQuestionAnalysisJobs() {},
    setQuestionDraftViews() {},
    setActiveLeafId() {},
    hiddenRetryErrorIdsRef: { current: new Set() },
    readHiddenRetryErrorIds: () => new Set(),
    filterHiddenRetryErrors: (messages, entryIds) => ({ messages, entryIds }),
    messagesRef: { current: [] },
    onBeforeApplyHistoryRef: { current: null },
    setMessages: (value) => { writes.messages = value; },
    setEntryIds() {},
    setHasEarlierHistory() {},
    setHasCompaction() {},
    historyCursorRef: { current: null },
    setHasEarlierMessages() {},
    setCurrentModelOverride() {},
    setThinkingLevel() {},
    modelSwitchPendingRef: { current: false },
    setError: (value) => { writes.error = value; },
    fullHistoryExpandedRef: { current: false },
    loadFullHistory() {},
    getSessionViewSnapshot: () => null,
    setSessionViewSnapshot() {},
    deleteSessionViewSnapshot() {},
    cacheKeyForSession: (sid) => sid,
    snapshotCoversLoadedEntries: () => true,
    clearLoadedSessionView() {},
    writeSettledSessionViewSnapshot() {},
  };
  ctx.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        sessionId: "remote",
        filePath: "/tmp/remote.jsonl",
        timing: { effectiveMs: 1 },
        leafId: null,
        context: { messages: [{ role: "assistant", content: "remote" }], entryIds: [], thinkingLevel: "auto", model: null },
      };
    },
  });
  installRuntimeState(ctx);
  vm.createContext(ctx);
  vm.runInContext(stripTypeScriptTypes(`${loadSource}\nglobalThis.load = loadSession;`), ctx);

  const result = await ctx.load("remote", true);
  assert.equal(result?.sessionId, "remote");
  assert.equal(writes.messages, undefined, "runtime metadata does not own durable remote transcript");
  const history = createDurableHistoryHarness({ sessionId: "remote", peer: "debian", leafId: null });
  const read = history.controller.reconcileTail();
  history.resolve(history.requests.shift(), { text: "remote" });
  await read;
  assert.equal(history.controller.getState().transcript.messages[0].content, "remote");

  history.controller.dispose();
  assert.equal(writes.loading, false);
  assert.equal(writes.error, null);
});



test("a rejected submission preserves a different run reported by the server", () => {
  const reconcileSource = source.slice(
    source.indexOf("  const reconcileAgentState = useCallback"),
    source.indexOf("  // Recovery check for missed SSE events"),
  );

  assert.match(reconcileSource, /sessionIdRef\.current !== sid/);
  assert.match(reconcileSource, /if \(busy \|\| localCompactionPendingRef\.current\) \{[\s\S]*?sdkAgentActiveRef\.current = Boolean\(state\.isStreaming\)/);
  assert.match(reconcileSource, /rpcPromptPendingRef\.current = Boolean\(state\.isPromptRunning\)/);
  assert.match(reconcileSource, /if \(!agentRunningRef\.current && !clientStreamActive\) return;[\s\S]*?finishPromptWithoutStream/);
  assert.match(reconcileSource, /streamingStore\.getState\(\)\.isStreaming/);
});

test("opening System lazily starts a dormant session without sending a prompt", () => {
  const loadSystemPromptSource = source.slice(
    source.indexOf("  const loadSystemPrompt = useCallback"),
    source.indexOf("  const loadSlashCommands = useCallback"),
  );
  const loaderEffectSource = source.slice(
    source.indexOf("  useEffect(() => {\n    onSystemPromptLoaderChange"),
    source.indexOf("  useEffect(() => {\n    if (!onBranchDataChange) return;"),
  );

  assert.match(loadSystemPromptSource, /sessionIdRef\.current \?\? await ensureNewSession\(\)/);
  assert.doesNotMatch(loadSystemPromptSource, /promoteNewSession\(\)/);
  // 会话级命令一律 sendAgentCommandR（远程会话带 peer）：裸 sendAgentCommand
  // 在远程场景会打到本机 /api/agent。
  assert.match(loadSystemPromptSource, /sendAgentCommandR<AgentStateResponse>\(sid, \{ type: "get_state" \}\)/);
  assert.doesNotMatch(loadSystemPromptSource, /type: "prompt"/);
  assert.match(loadSystemPromptSource, /setSystemPrompt\(state\.systemPrompt \?\? ""\)/);
  assert.match(loaderEffectSource, /onSystemPromptLoaderChange\?\.\(loadSystemPrompt\)/);
  assert.match(loaderEffectSource, /onSystemPromptLoaderChange\?\.\(null\)/);
  assert.match(appShellSource, /onClick=\{\(\) => handleSystemInfoToggle\("system", mobile\)\}/);
  // Tools are now exposed through the unified system/resources surface; the
  // retired standalone top-bar tools toggle must not reappear.
  assert.doesNotMatch(appShellSource, /handleSystemInfoToggle\("tools"/);
  assert.match(appShellSource, /systemPromptLoaderRef\.current/);
  assert.doesNotMatch(appShellSource, /systemPrompt !== null \|\| systemPromptLoading/);
  assert.match(appShellSource, /systemPromptLoadIdRef\.current \+= 1/);
  assert.match(appShellSource, /systemPromptLoaderRef\.current = loader/);
  assert.match(appShellSource, /handleSystemPromptLoaderChange[\s\S]*?systemPromptLoadIdRef\.current \+= 1;/);
});

test("local full-session stats keep the normalized local peer across reload reset", () => {
  const loadStart = source.indexOf("  const loadSession = useCallback");
  const loadEnd = source.indexOf("  const loadTools = useCallback", loadStart);
  assert.ok(loadStart >= 0 && loadEnd > loadStart);
  const loadSource = source.slice(loadStart, loadEnd);
  assert.match(loadSource, /current\.peer === \(loadPeer \?\? null\)/);
});

test("new-session promotion drops late completion after hook generation changes", () => {
  const promoteSource = source.slice(
    source.indexOf("  const promoteNewSession = useCallback"),
    source.indexOf("  const ensureNewSession = useCallback"),
  );
  assert.match(source, /newSessionLifecycleGenerationRef/);
  assert.match(promoteSource, /const promotionGeneration = newSessionLifecycleGenerationRef\.current/);
  assert.match(promoteSource, /promotionGeneration !== newSessionLifecycleGenerationRef\.current/);
  assert.match(promoteSource, /sessionIdRef\.current !== sid/);
});

test("new-session promotion rekeys drafts before publishing the real session", () => {
  const promoteSource = source.slice(
    source.indexOf("  const promoteNewSession = useCallback"),
    source.indexOf("  const ensureNewSession = useCallback"),
  );

  assert.match(promoteSource, /const ownedDraftKey = sessionDraftKey\(sid, remotePeer\)/);
  assert.match(promoteSource, /draftKeyAliasesRef\.current\.set\(provisionalDraftKey, ownedDraftKey\)/);
  assert.match(promoteSource, /for \(let attempt = 0; attempt < 3; attempt \+= 1\)/);
  assert.match(promoteSource, /transient_session_assignment_forbidden/);
  assert.match(promoteSource, /subprojectId: assignmentError \? undefined : newSessionSubprojectId \?\? undefined/);
  assert.match(promoteSource, /throw assignmentError/);
  assert.match(promoteSource, /input\.rekeyDraft\(provisionalDraftKey, ownedDraftKey\)/);
  assert.ok(
    promoteSource.indexOf("input.rekeyDraft(provisionalDraftKey, ownedDraftKey)")
      < promoteSource.indexOf("onSessionCreated?.({"),
  );
  assert.match(promoteSource, /}, provisionalDraftKey\)/);
  assert.match(chatWindowSource, /sessionDraftKey\(session\.id, remotePeer\)/);
  assert.match(chatWindowSource, /draftKey=\{composerDraftKey\}/);
});

test("new-session promotion leaves pending client identity in the transcript owner", () => {
  const resetSource = source.slice(
    source.indexOf("  useEffect(() => {\n    runtimeSettingsRevisionRef.current"),
    source.indexOf("  const draftKeyAliasesRef", source.indexOf("  useEffect(() => {\n    runtimeSettingsRevisionRef.current")),
  );

  assert.doesNotMatch(resetSource, /optimisticUserMessageKeyRef|pendingUserMessageOccurrencesRef/);
  assert.match(source, /clientMessageId: clientId/);
});

test("new sessions pass explicit Talk Map context source metadata to the device API", () => {
  const ensureSource = source.slice(
    source.indexOf("  const ensureNewSession = useCallback"),
    source.indexOf("  // Opening the System panel", source.indexOf("  const ensureNewSession = useCallback")),
  );
  assert.match(ensureSource, /contextSourceSessionId: newSessionContextSourceId/);
  assert.match(source, /contextSourceSessionId: newSessionContextSourceId \?\? undefined/);
  assert.match(chatWindowSource, /newSessionContextSourceId/);
});

test("fresh prompt recovery recreates a draft only for definitive session-missing", () => {
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );
  const toolsSource = source.slice(
    source.indexOf("  const handleToolPresetChange = useCallback"),
    source.indexOf("  const scrollUserMsgToTop"),
  );

  assert.match(sendSource, /isSessionMissingError\(error\)/);
  assert.match(sendSource, /sessionIdRef\.current = null;[\s\S]*?const recoveredSid = await ensureNewSession\(\)/);
  assert.match(sendSource, /await sendAgentCommandR\(recoveredSid, promptCommand\)/);
  assert.match(sendSource, /Generic 4xx\/5xx and transport failures never enter this/);
  assert.match(sendSource, /void reconcileAgentState\(sentSessionId\)/);
  assert.match(toolsSource, /const activeSessionId = result\?\.sessionId \?\? sid/);
  assert.match(toolsSource, /activeSessionId !== sid \|\| result\?\.recreated/);
  assert.match(toolsSource, /sessionIdRef\.current = activeSessionId/);
  assert.match(toolsSource, /maintainEventsConnected\(activeSessionId\)/);
});

test("fresh sessions restore the preferred tool preset without overriding existing sessions", () => {
  const preferenceSource = source.slice(
    source.indexOf("  const setToolPresetState"),
    source.indexOf("  const scrollToBottom"),
  );
  const loadToolsSource = source.slice(
    source.indexOf("  const loadTools = useCallback"),
    source.indexOf("  const promoteNewSession"),
  );
  const changeSource = source.slice(
    source.indexOf("  const handleToolPresetChange = useCallback"),
    source.indexOf("  const scrollUserMsgToTop"),
  );

  assert.match(
    preferenceSource,
    /useLayoutEffect\(\(\) => \{\s*if \(!isNew \|\| sessionIdRef\.current\) return;\s*setToolPresetState\(getPreferredToolPreset\(\)\)/,
  );
  assert.match(changeSource, /setPreferredToolPreset\(preset\)/);
  assert.match(changeSource, /sendAgentCommandR(?:<[^>]+>)?\(sid, \{\s*type: "set_tools",\s*\.\.\.\(toolNames !== undefined \? \{ toolNames \} : \{\}\)/);
  assert.doesNotMatch(loadToolsSource, /setPreferredToolPreset/);
});

test("Fast mode has a session override independent from thinking level", () => {
  assert.match(source, /fastModeOverrideRef/);
  assert.match(source, /id: selectedModelInfo\.id,\s*api: selectedModelInfo\.fastModeSupported/);
  assert.match(source, /fastMode: selectedFastMode/);
  assert.match(source, /type: "set_fast_mode", mode/);
  assert.match(source, /handleFastModeChange/);
  assert.match(chatWindowSource, /fastMode=\{fastMode\}/);
  assert.match(chatWindowSource, /onFastModeChange=\{session \|\| isNew \? handleFastModeChange/);
});test("submission recovery updates live refs before a possible session rekey", () => {
  const restoreMethod = chatInputSource.slice(
    chatInputSource.indexOf("    restoreSubmission(text:"),
    chatInputSource.indexOf("    insertText(text:"),
  );

  assert.ok(
    restoreMethod.indexOf("valueRef.current = restoredDraft.value")
      < restoreMethod.indexOf("setValue((current) =>"),
  );
  assert.ok(
    restoreMethod.indexOf("attachedImagesRef.current = restoredImages")
      < restoreMethod.indexOf("setAttachedImages((current) =>"),
  );
});

test("stale fresh-session completion cannot replace the active composer", () => {
  const cwdChangeSource = appShellSource.slice(
    appShellSource.indexOf("  const handleCwdChange = useCallback"),
    appShellSource.indexOf("  const handleSelectSession = useCallback"),
  );
  const newSessionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleNewSession = useCallback"),
    appShellSource.indexOf("  // Global keyboard shortcuts"),
  );
  const createdSource = appShellSource.slice(
    appShellSource.indexOf("  const handleSessionCreated = useCallback"),
    appShellSource.indexOf("  const handleAgentEnd = useCallback"),
  );

  assert.match(newSessionSource, /const draftKey = buildNewSessionDraftKey\(cwd, nextSubprojectId\)/);
  assert.match(newSessionSource, /setNewSessionSubprojectId\(nextSubprojectId\)/);
  assert.match(newSessionSource, /activeNewSessionDraftKeyRef\.current = draftKey/);
  assert.match(createdSource, /activeNewSessionDraftKeyRef\.current !== sourceDraftKey/);
  assert.match(cwdChangeSource, /const currentFreshCwd = newSessionCwd \?\? activeCwd/);
  assert.match(
    cwdChangeSource,
    /currentProject === newProject\s*&& \(selectedSession !== null \|\| currentFreshCwd === cwd\)/,
  );
  assert.doesNotMatch(cwdChangeSource, /setFileTabs\(\[\]\)/);
  assert.doesNotMatch(cwdChangeSource, /setTerminalTabs\(/);
  assert.match(cwdChangeSource, /Manual file tabs and terminals are independent of Agent execution/);
  assert.match(
    appShellSource,
    /useLayoutEffect\(\(\) => \{\s*activeNewSessionDraftKeyRef\.current = newSessionDraftKey;/,
  );
  assert.ok(
    createdSource.indexOf("activeNewSessionDraftKeyRef.current !== sourceDraftKey")
      < createdSource.indexOf("setSelectedSession(session)"),
  );
});

test("current-session auto-compaction recreates an evicted transient draft", () => {
  const autoCompactionSource = source.slice(
    source.indexOf("  const handleAutoCompactionChange = useCallback"),
    source.indexOf("  const handleRecallQueue = useCallback"),
  );

  assert.match(autoCompactionSource, /sendTransientSessionCommand/);
  assert.match(autoCompactionSource, /sessionId: sessionIdRef\.current/);
  assert.match(autoCompactionSource, /resetSession: \(\) => \{ sessionIdRef\.current = null; \}/);
  assert.match(autoCompactionSource, /type: "set_auto_compaction"/);
});

test("fresh-session drafts are preserved across session navigation and rejected submissions are guarded", () => {
  const restoreSource = source.slice(
    source.indexOf("  const restoreSubmission = useCallback"),
    source.indexOf("  const sessionStats = useMemo"),
  );

  assert.match(restoreSource, /destinationDraftKey/);
  assert.match(restoreSource, /restoreDraftSubmission\(destinationDraftKey, text, draftImages\)/);
});

test("streaming submissions cannot be stranded in an idle direct queue", () => {
  const queueSource = source.slice(
    source.indexOf("  // Let AgentSession.prompt decide atomically"),
    source.indexOf("  const handleAbortCompaction"),
  );

  assert.match(queueSource, /type: "prompt"/);
  assert.match(queueSource, /streamingBehavior: behavior/);
  assert.match(queueSource, /if \(isPromptRejectedError\(e\)\) restore\(\)/);
  assert.doesNotMatch(queueSource, /type: "steer"/);
  assert.doesNotMatch(queueSource, /type: "follow_up"/);
});

function queueSnapshot(queueRevision, steering = [], followUp = [], bootId = "queue-boot") {
  const normalize = item => ({ role: "user", imageCount: item.images?.length ?? (item.hasImages ? 1 : 0), ...item });
  return { bootId, queueRevision, steering: steering.map(normalize), followUp: followUp.map(normalize) };
}

function createQueueHarness({ hookSource = source, command, ack } = {}) {
  const h = createRefreshHarness();
  clearPendingQueueRecall("s");
  clearQueueRecallOperation("s");
  const calls = [], restored = [];
  let queue = { steering: [], followUp: [] };
  let server = queueSnapshot(0); let id = 0;
  const projection = new QueuedDraftProjection();
  projection.reset("s"); projection.apply("s", server);
  Object.assign(h.ctx, {
    composerDraftKey: "s", editEntryId: null,
    cancelInitialLanding() {}, setPromptAnchorActive() {},
    QueuedDraftProjection, readQueuedDraftState, recalledQueuedDrafts, getPendingQueueRecall, savePendingQueueRecall, clearPendingQueueRecall, queuedImageCount, getQueueRecallOperation, beginQueueRecallOperation, markQueueRecallRestored, assertUserQueueRecall, clearQueueRecallOperation,
    queuedDraftProjectionRef: { current: projection },
    queueRecallInFlightRef: { current: false }, serverCopyOperationRef: { current: null },
    setQueueRecallState() {}, refreshQueueRecovery() {}, async ensureQueueRecoveryAvailable() {},
    // Historical mutation fixtures deliberately exercise the removed text-based projection.
    userMessageKey: message => JSON.stringify(message.content),
    mergeUserMessage: (messages, incoming) => ({messages:[...messages,incoming],consumedOptimistic:false}),
    // Only the historical optimistic fixture uses these removed text mirrors.
    queuedDraftMessagesRef: { current: { steering: [], followUp: [] } },
    rememberQueuedDraftMessage(state, kind, text, images) { state[kind].push({ text, images }); },
    forgetQueuedDraftMessage() {}, setQueuedDrafts() {},
    pendingQueuedUserMessagesRef: { current: [] },
    restoreSubmission: (...args) => restored.push(args),
    restoreDraftSubmission: (...args) => restored.push(args),
    isPromptRejectedError: (error) => error.rejected === true,
    setQueuedMessages: (value) => { queue = value; },
    opts: { chatInputRef: { current: { availableImageSlots: () => 10, hasQueuedDraft: () => false, isQueuedDraftDurable: () => true, prependQueuedDraft: (...args) => { restored.push(args); return true; }, prependText: (...args) => restored.push(args) } } },
    sendAgentCommandR: async (sid, request) => {
      calls.push({ sid, ...request });
      if (request.type === "ack_queue_recall") return ack ? ack(request, h) : { acknowledged: true };
      if (command) return command(request, h);
      if (request.type === "clear_queue") {
        assert.equal(request.expectedQueueIdentity.bootId, server.bootId);
        assert.equal(request.expectedQueueIdentity.queueRevision, server.queueRevision);
        const clearedQueue = server;
        server = queueSnapshot(server.queueRevision + 1);
        h.ctx.handleAgentEvent({ type: "queue_update", queueSnapshot: server });
        return { clearedQueue, queueSnapshot: server };
      }
      const kind = request.streamingBehavior === "steer" ? "steering" : "followUp";
      const item = { itemId: `item-${++id}`, role: "user", text: request.message, hasImages: Boolean(request.images?.length), imageCount: request.images?.length ?? 0, ...(request.images?.length ? { images: request.images.map(({ data, mimeType }) => ({ data, mimeType })) } : {}) };
      server = { ...server, queueRevision: server.queueRevision + 1, [kind]: [...server[kind], item] };
      h.ctx.handleAgentEvent({ type: "queue_update", queueSnapshot: server });
      return null;
    },
  });
  const normalizeSource = source.slice(source.indexOf("function normalizeQueuedMessages("), source.indexOf("type ExtensionUiDialogRequest"));
  const syncSource = source.slice(source.indexOf("  const syncQueuedDrafts ="), source.indexOf("  const eventConnectionRef"));
  vm.runInContext(stripTypeScriptTypes(normalizeSource + syncSource + "\nglobalThis.syncQueuedDrafts = syncQueuedDrafts;"), h.ctx);
  const sendSource = hookSource.slice(hookSource.indexOf("  const sendStreamingPrompt"), hookSource.indexOf("  const handleSteer"));
  const recallSource = source.slice(source.indexOf("  const handleRecallQueue"), source.indexOf("  // Continue button"));
  vm.runInContext(stripTypeScriptTypes(sendSource + recallSource + "\nglobalThis.send = sendStreamingPrompt; globalThis.recall = handleRecallQueue;"), h.ctx);
  return { ...h, get messages() { return h.messages; }, get queue() { return queue; }, get server() { return server; }, calls, restored };
}

async function checkQueueLifecycle(hookSource = source, behavior = "steer") {
  const h = createQueueHarness({ hookSource });
  const before = h.messages.length;
  await h.ctx.send("queued next", behavior);
  const kind = behavior === "steer" ? "steering" : "followUp";
  assert.equal(h.queue[kind].length, 1);
  assert.equal(h.messages.length, before, "undelivered queue must not enter transcript");
  assert.equal(h.ctx.pendingScrollToUserRef.current, false);
  assert.equal(h.calls[0].type, "prompt");
  assert.equal(h.calls[0].streamingBehavior, behavior);

  await h.ctx.reader.reconcileTail();
  assert.equal(h.messages.length, before, "history restoration must not project the queue");
  h.ctx.handleAgentEvent({ type: "queue_update", queueSnapshot: queueSnapshot(h.server.queueRevision + 1) });
  const message = { role: "user", content: "queued next", timestamp: 2 };
  h.ctx.handleAgentEvent({ type: "message_start", message });
  h.ctx.handleAgentEvent({ type: "message_end", message });
  assert.equal(h.queue[kind].length, 0);
  assert.equal(h.messages.length, before + 1);
  assert.equal(h.messages.at(-1).content, "queued next");
}

for (const behavior of ["steer", "followUp"]) {
  test(behavior + " stays in the queue until runtime delivery", () => checkQueueLifecycle(source, behavior));
}

test("queue lifecycle regression probe fails on the Reader optimistic projection", async () => {
  const historical = await readFile(new URL("./fixtures/queued-streaming-optimistic.txt", import.meta.url), "utf8");
  await assert.rejects(checkQueueLifecycle(historical), /undelivered queue must not enter transcript/);
});

test("identical queued texts remain distinct delivered turns", async () => {
  const h = createQueueHarness();
  const before = h.messages.length;
  await h.ctx.send("same", "steer");
  await h.ctx.send("same", "steer");
  assert.equal(h.queue.steering.length, 2);
  assert.equal(h.messages.length, before);
  for (let index = 0; index < 2; index++) {
    h.ctx.handleAgentEvent({ type: "queue_update", queueSnapshot: queueSnapshot(h.server.queueRevision + index + 1, index === 0 ? h.server.steering.slice(1) : []) });
    const message = { role: "user", content: "same", timestamp: index + 1 };
    h.ctx.handleAgentEvent({ type: "message_start", message });
    h.ctx.handleAgentEvent({ type: "message_end", message });
  }
  assert.equal(h.messages.length, before + 2);
});

test("queue recall restores images without touching transcript messages", async () => {
  const h = createQueueHarness();
  const images = [{ data: "AAAA", mimeType: "image/png" }];
  const before = h.messages;
  await h.ctx.send("inspect", "followUp", images);
  assert.equal(h.calls[0].images[0].data, images[0].data);
  await h.ctx.recall();
  assert.equal(h.queue.followUp.length, 0);
  assert.equal(h.messages, before);
  assert.equal(h.restored[0][0], "inspect");
  assert.deepEqual(Array.from(h.restored[0][1]), images);
});

for (const rejected of [true, false]) {
  test("streaming prompt failure restores only a definitive rejection: " + rejected, async () => {
    const h = createQueueHarness({ command: async () => { throw Object.assign(new Error("failed"), { rejected }); } });
    const before = h.messages;
    await h.ctx.send("queued next", "steer");
    assert.equal(h.messages, before);
    assert.equal(h.restored.length, rejected ? 1 : 0);
  });
}

test("streaming submission starts a real turn if the runtime already settled", async () => {
  const h = createQueueHarness({ command: async (request, harness) => {
    const message = { role: "user", content: request.message, timestamp: 2 };
    harness.ctx.handleAgentEvent({ type: "message_start", message });
    harness.ctx.handleAgentEvent({ type: "message_end", message });
  } });
  const before = h.messages.length;
  await h.ctx.send("start now", "steer");
  assert.equal(h.queue.steering.length, 0);
  assert.equal(h.messages.length, before + 1);
});

test("post-accept prompt errors do not duplicate the user submission", () => {
  const promptErrorSource = source.slice(
    source.indexOf('case "prompt_error"'),
    source.indexOf('case "extension_error"'),
  );

  assert.match(promptErrorSource, /addNotice/);
  assert.doesNotMatch(promptErrorSource, /restoreSubmission/);
});

test("delegates event stream readiness and hides an empty agent phase", () => {
  const ensureSource = source.slice(
    source.indexOf("const ensureEventsConnected"),
    source.indexOf("const respondToExtensionUi"),
  );

  assert.match(source, /new AgentEventConnection\(\{/);
  assert.match(source, /shouldMaintain: \(sid\)[\s\S]*?sessionIdRef\.current === sid/);
  assert.match(ensureSource, /eventConnectionRef\.current!\.ensureRuntimeConnected\(sid\)/);
  assert.match(ensureSource, /eventConnectionRef\.current!\.maintain\(sid\)/);
  assert.match(chatWindowSource, /const hasStreamingContent = Boolean\(atLiveTail && hasStoreStreamingContent\)/);
  assert.match(chatWindowSource, /isStreaming && hasStreamingContent && \(\s*<StreamingReply/);
  assert.match(chatWindowSource, /agentRunning && !hasStreamingContent && \(agentPhase \|\| isCompacting\)/);
  assert.match(chatWindowSource, /phaseLabel\(agentPhase, t, isCompacting\)/);
  assert.match(phaseLabelSource, /return null;/);
});

test("keeps background ChatWindow instances out of active controls", () => {
  assert.match(chatWindowSource, /background\?: boolean/);
  assert.match(chatWindowSource, /onSessionReady\?\:/);
  assert.match(chatWindowSource, /if \(background\) return;/);
  assert.match(chatWindowSource, /const sessionBusy = Boolean\([\s\S]*?sessionRunning[\s\S]*?isStreaming[\s\S]*?isCompacting/);
});

test("plays the wait sound once per request id across ChatWindow mounts", () => {
  // 等待音按 extension UI 请求 id 模块级去重：同一弹窗跨实例挂载
  // （进入/离开会话、后台重挂载、SSE 重连回放）只播报一次。
  assert.match(chatWindowSource, /tryPlaySoundRequest\(waitSoundRequestId\(extensionDialog\.id\), playWaitSoundRef\.current, \(\) => canPlayLocalSound\("wait"\)\)/);
  assert.match(chatWindowSource, /tryPlaySoundRequest\(waitSoundRequestId\(extensionCustomUi\.id\), playWaitSoundRef\.current, \(\) => canPlayLocalSound\("wait"\)\)/);
  assert.match(chatWindowSource, /playWaitSoundRef\.current/);
  assert.match(chatWindowSource, /statusSoundRequestId\(session\?\.id, "done", serverRunId\)/);
  assert.doesNotMatch(chatWindowSource, /soundedExtensionDialogIdRef/);
  assert.doesNotMatch(chatWindowSource, /soundedExtensionCustomUiIdRef/);
});

test("uses one absolute agent-readiness deadline instead of a five-second transport deadline", () => {
  assert.match(source, /EVENT_STREAM_READY_TIMEOUT_MS = 60_000/);
  assert.doesNotMatch(source, /EVENT_STREAM_OPEN_TIMEOUT_MS/);
});





test("keeps run state separate from transcript generation and unknown results", () => {
  const stateSource = source.slice(source.indexOf("  const loadAgentState = useCallback"), source.indexOf("  const loadSession = useCallback"));
  assert.ok(stateSource.length > 0);
  assert.doesNotMatch(stateSource, /sessionLoadGenerationRef/);
  assert.match(stateSource, /stateLoadGenerationRef/);
  assert.match(source, /Promise\.all\(\[loadSession\(session\.id, true\), loadAgentState\(session\.id\)\]\)/);
  assert.match(source, /if \(!agentState \|\| sessionIdRef\.current !== sid/);
  assert.match(source, /stateRunRevisionRef\.current !== runRevision/);
  assert.match(source, /sessionStatePendingRef\.current/);
  assert.match(source, /void loadAgentState\(sid\)\.then\(\(state\) => restoreLoadedRunState\(sid, state\)\)/);
  assert.match(source, /window\.setInterval\(retry, 15_000\)/);
  assert.match(source, /if \(sessionStatePendingRef\.current \|\| agentRunningRef\.current/);
  assert.match(chatInputSource, /statePending\?: boolean/);
  assert.match(chatInputSource, /disabled=\{statePending \|\|/);
});

test("state fetch survives history expansion, but never overwrites a newer SSE run", async () => {
  const stateSource = source.slice(source.indexOf("  const loadAgentState = useCallback"), source.indexOf("  const loadSession = useCallback"));
  const writes = {};
  const branch = new BranchNavigation();
  branch.reset("local:s");
  const ctx = {
    useCallback: (fn) => fn, apiPath: (url) => url, cacheKeyForSession: sid => sid, encodeURIComponent,
    sessionHookMountedRef: { current: true }, sessionIdRef: { current: "s" },
    stateLoadGenerationRef: { current: 0 }, stateLoadInFlightRef: { current: null }, runtimeSettingsReadGenerationRef: { current: 0 }, AbortSignal, sessionLoadGenerationRef: { current: 0 },
    stateRunRevisionRef: { current: 0 }, sessionStatePendingRef: { current: true },
    transcriptMutationRevisionRef: { current: 0 }, sessionViewValidationPendingRef: { current: true },
    branchRef: { current: branch }, canWriteBranch,
    queuedDraftProjectionRef: { current: new QueuedDraftProjection() },
    syncQueuedDrafts() {}, syncQueuedDraftResponse() {}, normalizeQueuedMessages: (value) => value,
    currentAgentRunIdRef: { current: null }, promptRunIdRef: { current: 0 },
    queuedMessagesSummary: (value) => value, setQueuedDrafts() {}, sendAgentCommandR: async () => { throw new Error("offline"); }, console: { error() {} },
  };
  for (const match of stateSource.matchAll(/\b(set[A-Z]\w*)\(/g)) ctx[match[1]] = (value) => { writes[match[1]] = value; };
  let release;
  ctx.fetch = () => new Promise((resolve) => { release = (payload) => resolve({ ok: true, json: async () => payload }); });
  installRuntimeState(ctx);
  vm.createContext(ctx);
  vm.runInContext(stripTypeScriptTypes(`${stateSource}\nglobalThis.load = loadAgentState;`), ctx);
  const first = ctx.load("s");
  ctx.sessionLoadGenerationRef.current++;
  ctx.transcriptMutationRevisionRef.current++;
  release({ running: true, state: { isStreaming: true, branchPosition: { leafId: "live-leaf", pending: false }, extensionStatuses: [{ key: "status", text: "working" }] } });
  assert.equal((await first)?.running, true);
  assert.equal(writes.setExtensionStatuses[0].text, "working");
  assert.equal(ctx.sessionStatePendingRef.current, false);
  assert.equal(ctx.sessionViewValidationPendingRef.current, false);
  assert.equal(branch.state.runtimeLeafId, "live-leaf");
  assert.equal(writes.setMessages, undefined, "fresh runtime metadata never replaces streamed history");

  const second = ctx.load("s");
  ctx.stateRunRevisionRef.current++;
  release({ running: false, state: { branchPosition: { leafId: "stale-leaf", pending: false } } });
  assert.equal(await second, null);
  assert.equal(ctx.stateLoadGenerationRef.current, 2);
  assert.equal(branch.state.runtimeLeafId, "live-leaf");

  const third = ctx.load("s");
  release({ running: true, state: { isPromptRunning: true, extensionWidgets: [{ key: "widget", lines: ["ready"] }] } });
  assert.equal((await third)?.state.isPromptRunning, true);
  assert.equal(writes.setExtensionWidgets[0].lines[0], "ready");

  ctx.sessionStatePendingRef.current = true;
  const fourth = ctx.load("s");
  release({ running: true });
  assert.equal(await fourth, null);
  assert.equal(ctx.sessionStatePendingRef.current, true);

  ctx.sessionViewValidationPendingRef.current = true;
  const pending = ctx.load("s");
  release({ running: true, state: { branchPosition: { leafId: "live-leaf", pending: true } } });
  await pending;
  assert.equal(ctx.sessionViewValidationPendingRef.current, true);
  assert.equal(branch.state.phase, "unknown");
});

test("late agent_end reconciliation is guarded by run generation and identity", () => {
  const endSource = source.slice(source.indexOf('case "agent_end"'), source.indexOf('case "agent_settled"'));
  assert.match(endSource, /const eventRunRevision = stateRunRevisionRef\.current/);
  assert.match(endSource, /stateRunRevisionRef\.current !== eventRunRevision/);
  assert.match(endSource, /currentAgentRunIdRef\.current !== serverRunId/);
  assert.match(endSource, /sessionHookMountedRef\.current/);
});

test("consumes both activity edges so an idle snapshot cannot keep the selected session busy", () => {
  assert.match(source, /const sessionRunningSignalRef = useRef\(Boolean\(sessionRunning\)\)/);
  assert.match(source, /else if \(sessionRunning && !sessionRunningSignalRef\.current\)[\s\S]*?sessionRunningRef\.current = true/);
  assert.match(source, /else if \(!sessionRunning && sessionRunningSignalRef\.current\)[\s\S]*?sessionRunningRef\.current = false/);
  assert.match(chatWindowSource, /const sessionBusy = Boolean\([\s\S]*?sessionRunning[\s\S]*?agentRunning/);
  assert.doesNotMatch(chatWindowSource, /observedSessionRunning/);
  assert.match(chatWindowSource, /const canStopExecution = Boolean\(sessionBusy/);
  assert.match(chatWindowSource, /active=\{isLiveTail\}/);
  const settleSource = source.slice(source.indexOf("const settleUiStage"), source.indexOf("const notifyPromptStage"));
  assert.match(settleSource, /sessionRunningRef\.current = false/);
});

test("keeps one store-owned assistant partial and consumes Pi JSON deltas", () => {
  const connectedSource = source.slice(
    source.indexOf('case "connected"'),
    source.indexOf('case "agent_start"'),
  );
  const streamSource = source.slice(
    source.indexOf('case "message_start"'),
    source.indexOf('case "message_end"'),
  );
  const messageEndSource = source.slice(
    source.indexOf('case "message_end"'),
    source.indexOf('case "tool_execution_start"'),
  );

  assert.match(source, /createStreamingStore,[\s\S]*type ClientAssistantMessageEvent/);
  assert.doesNotMatch(source, /streamingMessageRef/);
  assert.match(connectedSource, /dispatch\(\{ type: "end" \}\)/);
  assert.match(connectedSource, /event\.isStreaming === true/);
  assert.match(connectedSource, /agentRunningRef\.current = true/);
  assert.match(streamSource, /msg\?\.role === "assistant"[\s\S]*dispatch\(\{ type: "snapshot", message: msg \}\)/);
  assert.match(streamSource, /event\.assistantMessageEvent as ClientAssistantMessageEvent/);
  assert.match(streamSource, /dispatch\(\{ type: "delta", event: delta \}\)/);
  assert.match(streamSource, /delta\.type !== "toolcall_start" && delta\.type !== "toolcall_delta"/);
  assert.doesNotMatch(streamSource, /case "message_delta"/);
  assert.match(messageEndSource, /const completed = event\.message as AgentMessage/);
  assert.match(messageEndSource, /normalizeToolCalls\(completed\)/);
  assert.match(messageEndSource, /dispatch\(\{ type: "end" \}\)/);
  assert.doesNotMatch(messageEndSource, /streamState\.streamingMessage/);
});

test("shows the latest streamed tool execution progress in the running phase", () => {
  const updateSource = source.slice(
    source.indexOf('case "tool_execution_update"'),
    source.indexOf('case "tool_execution_end"'),
  );

  assert.match(updateSource, /getToolExecutionProgress\(event\.partialResult\)/);
  assert.match(updateSource, /tools: \[\.\.\.tools\.filter\([\s\S]*?, updated\]/);
  assert.match(chatWindowSource, /phaseLabel\(agentPhase, t, isCompacting\)/);
  const ctx = {};
  installRuntimeState(ctx);
  vm.createContext(ctx);
  vm.runInContext(stripTypeScriptTypes(phaseLabelSource.replace(/^import[^\n]*\n/gm, "").replace(/export /g, "") + "\nglobalThis.phaseLabel = phaseLabel;"), ctx);
  assert.equal(ctx.phaseLabel({ kind: "running_tools", tools: [{ name: "old", progress: "old progress" }, { name: "new", progress: "latest progress" }] }, (key, params) => `${key}:${params?.name}`), "chat.runningNamedTool:new latest progress");
});

test("plays the enabled sound once for each extension dialog", () => {
  assert.match(chatWindowSource, /tryPlaySoundRequest\(waitSoundRequestId\(extensionDialog\.id\), playWaitSoundRef\.current, \(\) => canPlayLocalSound\("wait"\)\);/);
  const agentEndSource = source.slice(
    source.indexOf('case "agent_end"'),
    source.indexOf('case "agent_settled"'),
  );
  assert.match(source, /onAgentError\?: \(serverUnattended\?: boolean, serverRunId\?: string\) => void/);
  assert.match(agentEndSource, /typeof event\.errorMessage === "string"/);
  assert.match(agentEndSource, /onAgentError\?\.\(typeof event\.unattended === "boolean" \? event\.unattended : undefined, serverRunId\)/);
  assert.match(chatWindowSource, /onAgentError: wrappedOnAgentError/);
  assert.match(chatWindowSource, /tryPlaySoundRequest\(soundKey, playErrorSoundRef\.current, \(\) => canPlayLocalSound\("error"\)\)/);
  assert.match(chatWindowSource, /serverUnattended \?\? unattendedRef\.current/);
});

test("defers early wait sounds and suppresses custom-ui follow-up after interaction", () => {
  assert.match(chatWindowSource, /const \[waitSoundRetry, setWaitSoundRetry\] = useState\(0\)/);
  assert.match(chatWindowSource, /window\.setTimeout\(\(\) => setWaitSoundRetry/);
  assert.match(chatWindowSource, /wasSessionDialogRecentlyInteracted\(session\.id\)/);
});

test("does not claim terminal sound without server run identity", () => {
  assert.match(chatWindowSource, /const soundKey = statusSoundRequestId\(session\?\.id, "done", serverRunId\)/);
  assert.match(chatWindowSource, /if \(soundKey\) \{/);
  assert.match(chatWindowSource, /const soundKey = statusSoundRequestId\(session\?\.id, "error", serverRunId\)/);
});

test("suppresses the done sound when the tail assistant message failed", () => {
  // 失败/自动重试路径里 agent_settled 与 prompt_done 同样会触发 onAgentEnd，
  // 最后 assistant 消息为 error 时不得播完成音（由错误音负责）；
  // 同一 server run 使用同一 claim key，重复终态不会再次播报。
  assert.match(chatWindowSource, /tailMessagesRef = useRef<AgentMessage\[\] \| null>\(null\)/);
  assert.match(chatWindowSource, /last\?\.role === "assistant"/);
  assert.match(chatWindowSource, /last\.stopReason === "error" \|\| Boolean\(last\.errorMessage\)/);
  assert.match(chatWindowSource, /if \(!lastFailed\) \{[\s\S]*?statusSoundRequestId\(session\?\.id, "done", serverRunId\)/);
  assert.match(chatWindowSource, /tryPlaySoundRequest/);
  assert.match(chatWindowSource, /last\?\.role === "custom"/);
  assert.doesNotMatch(chatWindowSource, /lastErrorSoundAtRef/);
});

test("plays file-based status sounds with a shared decode cache", async () => {
  const audioSource = await readFile(new URL("./useAudio.ts", import.meta.url), "utf8");
  assert.match(audioSource, /complete_fanfare\.wav/);
  assert.match(audioSource, /error_down\.wav/);
  assert.match(audioSource, /wait_q_base\.wav/);
  assert.match(audioSource, /bufferCache = new Map<SoundKey, AudioBuffer>/);
  assert.match(audioSource, /tryPlaySoundRequest/);
  assert.match(audioSource, /pendingUnlockSounds/);
  assert.match(audioSource, /decodeAudioData/);
  assert.match(audioSource, /playDoneSound/);
  assert.match(audioSource, /playErrorSound/);
  assert.match(audioSource, /playWaitSound/);
  assert.match(audioSource, /pi-sound-enabled/);
  // 模块级共享 AudioContext：后台会话（display:none 挂载）也能用前台解锁的 ctx 播放
  assert.match(audioSource, /let sharedCtx: AudioContext \| null = null/);
  assert.match(audioSource, /lastPlayedAt\[key\]/);
});

test("background sessions delegate completion sounds to the sidebar owner", () => {
  // Background ChatWindow instances stay mounted for SSE/state updates but do
  // not own completion sounds; SessionSidebar detects their settled run and
  // routes one shared notification through AppShell.
  assert.match(chatWindowSource, /const ownsStatusSounds = statusSoundOwner === "chat"/);
  assert.match(chatWindowSource, /const ownsCompletionSound = ownsStatusSounds && !background/);
  assert.match(chatWindowSource, /if \(soundEnabledRef\.current && ownsCompletionSound\) \{/);
  assert.match(chatWindowSource, /if \(!ownsStatusSounds \|\| !soundEnabledRef\.current \|\| \(serverUnattended \?\? unattendedRef\.current\)\) return/);
});

test("keeps extension custom panel text selectable and copyable", () => {
  assert.match(chatWindowSource, /\.closest\("button"\)/);
  assert.match(chatWindowSource, /userSelect: "text"/);
  assert.match(chatWindowSource, /WebkitUserSelect: "text"/);
  assert.match(chatWindowSource, /copyText\(text \?\? getPanelText\(\)\)/);
  assert.match(chatWindowSource, /stripAnsi/);
  assert.match(chatWindowSource, /lines\.map\(stripAnsi\)\.join/);
  assert.match(chatWindowSource, /event\.key\.toLowerCase\(\) === "c"/);
  assert.match(chatWindowSource, /onMouseUp=\{\(event\) =>/);
  assert.match(chatWindowSource, /restoreInputFocus/);
  assert.match(chatWindowSource, /\.finally\(restoreInputFocus\)/);
  assert.match(chatWindowSource, /selectedTextRef/);
  assert.match(chatWindowSource, /getSelectedPanelText/);
});

test("routes blocking extension requests through deduplicated browser attention notifications", () => {
  const completionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleSessionRunComplete = useCallback"),
    appShellSource.indexOf("  useSessionRunCompletions", appShellSource.indexOf("  const handleSessionRunComplete = useCallback")),
  );
  const extensionRequestSource = source.slice(
    source.indexOf("  const handleExtensionUiRequest = useCallback"),
    source.indexOf("  const settleUiStage = useCallback"),
  );
  const attentionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleAttentionNeeded = useCallback"),
    appShellSource.indexOf("  const handleAutoName = useCallback"),
  );

  assert.match(
    extensionRequestSource,
    /isBlockingExtensionUiRequest\(request\)[\s\S]*?onAttentionNeeded\?\.\(request\)/,
  );
  assert.match(chatWindowSource, /onAttentionNeeded, onSessionCreated/);
  assert.match(completionSource, /if \(isSubagentSession\(item\.session\)\) return/);
  assert.match(completionSource, /kind !== "done" \|\| !shouldShowBrowserNotification\(\)/);
  assert.doesNotMatch(completionSource, /document\.visibilityState === "visible"/);
  assert.match(attentionSource, /shouldShowBrowserNotification\(\)/);
  assert.match(attentionSource, /claimExtensionAttentionNotification\(request, notifiedAttentionRequestIdsRef\.current\)/);
  assert.match(attentionSource, /tag: `pi-extension-ui:\$\{request\.id\}`/);
  assert.match(appShellSource, /onAttentionNeeded=\{\(request\) => handleAttentionNeeded\(request, selectedSession\)\}/);
  assert.match(appShellSource, /onAttentionNeeded=\{\(request\) => handleAttentionNeeded\(request, remoteSession\.sessionInfo\)\}/);
});







test("exposes the open-position choice in General settings", async () => {
  const generalConfigSource = await readFile(
    new URL("../components/GeneralConfig.tsx", import.meta.url),
    "utf8",
  );
  assert.match(generalConfigSource, /t\("settings\.sessionOpenScroll"\)/);
  assert.match(generalConfigSource, /name="sessionOpenScroll"/);
  assert.match(generalConfigSource, /handleSessionOpenScrollChange/);
  assert.match(generalConfigSource, /\{ id: "last-question", label: "settings\.sessionOpenScrollLastQuestion" \}/);
  assert.match(generalConfigSource, /\{ id: "answer-bottom", label: "settings\.sessionOpenScrollAnswerBottom" \}/);
});

test("projects external user occurrences and pairs each end without text-based deduplication", () => {
  const h = createRefreshHarness();
  const before = h.messages.length;
  for (const id of ["external-one", "external-two"]) {
    const message = { role: "user", content: "same external text" };
    h.ctx.handleAgentEvent({ type: "message_start", message });
    h.ctx.handleAgentEvent({ type: "message_end", message, entryId: id });
  }
  assert.equal(h.messages.length, before + 2);
  assert.deepEqual(h.entryIds.slice(-2), ["external-one", "external-two"]);
  assert.notEqual(h.entryIds.at(-1), h.entryIds.at(-2));
  assert.equal(h.ctx.pendingUserMessageOccurrencesRef.current.size, 0);
  assert.equal(h.requests.length, 0, "durable history is requested through invalidation, not legacy context reads");
  assert.equal(h.messages.length, 3, "SSE appends are visible without history invalidation");
});

test("native peer runtime events remain custom and do not consume same-text user occurrences", () => {
  const h = createRefreshHarness();
  const before = h.messages.length;
  const user = { role: "user", content: "same body" };
  const peer = { role: "custom", customType: "pi-web:session-peer", content: "same body", display: true,
    details: { source: "session-control", messageId: "peer-occurrence" } };
  h.ctx.handleAgentEvent({ type: "message_start", message: user });
  h.ctx.handleAgentEvent({ type: "message_start", message: peer });
  h.ctx.handleAgentEvent({ type: "message_end", message: peer, entryId: "peer-entry", orderKey:[2,1,2] });
  assert.equal(h.ctx.pendingPeerMessageIdsRef.current.size, 0);
  h.ctx.handleAgentEvent({ type: "message_end", message: user, entryId: "user-entry", orderKey:[1,1,1] });
  assert.equal(h.messages.length, before + 2);
  assert.equal(h.messages.at(-1).role, "custom");
  assert.equal(h.messages.at(-1).details.messageId, "peer-occurrence");
  assert.deepEqual(h.entryIds.slice(-2), ["user-entry", "peer-entry"]);
  assert.equal(h.ctx.pendingUserMessageOccurrencesRef.current.size, 0);
});

test("backfills persisted entry IDs on the matching external or optimistic occurrence", () => {
  for (const optimistic of [false, true]) {
    const h = createRefreshHarness();
    const before = h.messages.length;
    const message = { role: "user", content: "the prompt" };
    if (optimistic) {
      h.ctx.appendMessage(withOccurrence(message,'pending-client','pending-client'),'',{clientMessageId:'pending-client'});
    }
    h.ctx.handleAgentEvent({ type: "message_start", message });
    h.ctx.handleAgentEvent({ type: "message_end", message, entryId: "persisted-user", orderKey:[1,1,1],clientMessageId:optimistic?'pending-client':undefined });
    assert.equal(h.messages.length, before + 1, `optimistic=${optimistic}`);
    assert.equal(h.entryIds.at(-1), "persisted-user");
    assert.equal(h.entryIds.filter(id=>id==='persisted-user').length,1);

  }
});

test("keeps prompt anchor measurement outside the React update cycle", () => {
  const anchorEffectStart = chatWindowSource.indexOf(
    "useLayoutEffect(() => {\n    const spacer = promptAnchorSpacerRef.current;",
  );
  assert.notEqual(anchorEffectStart, -1);
  const syncEffectStart = chatWindowSource.indexOf(
    "const updatePromptAnchor = useCallback",
    anchorEffectStart,
  );
  assert.notEqual(syncEffectStart, -1);
  const anchorLifecycleEffectSource = chatWindowSource.slice(
    anchorEffectStart,
    syncEffectStart,
  );
  const anchorSyncEffectSource = chatWindowSource.slice(
    syncEffectStart,
    chatWindowSource.indexOf("const availableThinkingLevels"),
  );

  assert.doesNotMatch(anchorLifecycleEffectSource, /\bset[A-Z][A-Za-z0-9]*\s*\(/);
  assert.doesNotMatch(anchorSyncEffectSource, /\bset[A-Z][A-Za-z0-9]*\s*\(/);
  assert.doesNotMatch(chatWindowSource, /setPromptAnchorSpacer|useState[^\n]*promptAnchorSpacer/);
  assert.doesNotMatch(anchorLifecycleEffectSource, /streamState\.streamingMessage/);
  assert.match(anchorLifecycleEffectSource, /spacer\.style\.height = nextPromptAnchorSpacerHeight > 0/);
  assert.match(anchorLifecycleEffectSource, /promptAnchorUpdateRef\.current = updatePromptAnchorSpacer/);
  assert.match(anchorLifecycleEffectSource, /new ResizeObserver\(schedulePromptAnchorMeasure\)/);
  assert.match(anchorLifecycleEffectSource, /observer\?\.observe\(messageContent\)/);
  assert.match(anchorLifecycleEffectSource, /if \(disposed \|\| promptAnchorMeasureFrameRef\.current !== null\) return/);
  assert.match(anchorLifecycleEffectSource, /promptAnchorMeasureFrameRef\.current = requestAnimationFrame\(\(\) => \{\s*promptAnchorMeasureFrameRef\.current = null;\s*updatePromptAnchorSpacer\(\)/);
  assert.match(anchorLifecycleEffectSource, /disposed = true;[\s\S]*?promptAnchorUpdateRef\.current === updatePromptAnchorSpacer[\s\S]*?cancelAnimationFrame\(promptAnchorMeasureFrameRef\.current\)/);
  assert.match(chatWindowSource, /useLayoutEffect\(updatePromptAnchor, \[isStreaming, hasStreamingContent, updatePromptAnchor\]\)/);
  assert.match(chatWindowSource, /<div ref=\{messageContentRef\} style=\{\{/);
});

test("uses the prompt anchor as the only trailing message spacer", () => {
  assert.match(chatWindowSource, /<div ref=\{promptAnchorSpacerRef\} aria-hidden="true" \/>/);
  assert.doesNotMatch(chatWindowSource, /<div ref=\{messagesEndRef\} \/>/);
  assert.doesNotMatch(chatWindowSource, /bottomComposer(?:Ref|Height|ScrollFrameRef)/);
  assert.doesNotMatch(chatWindowSource, /new ResizeObserver\(updateBottomComposerHeight\)/);
});





test("exposes a guarded /clone builtin that creates a new session branch", () => {
  assert.match(chatInputSource, /name: "clone", description: "chat.commandClone"/);
  assert.match(source, /case "clone":/);
  assert.match(source, /Cannot clone while the session is running/);
  assert.match(source, /type: "clone"/);
  assert.match(source, /onSessionForked\?\.\(\{ newSessionId: result\.newSessionId, newSessionPath: result\.newSessionPath, subprojectAssignmentFailed: result\.subprojectAssignmentFailed \}\)/);
});

test("gates completion notifications once per prompt run", () => {
  const notifySource = source.slice(source.indexOf("const notifyPromptStage"), source.indexOf("const scheduleEventStreamClose"));
  const finishSource = source.slice(source.indexOf("const finishPromptWithoutStream"), source.indexOf("  // Reconcile client streaming state"));
  const settledSource = source.slice(source.indexOf('case "agent_settled"'), source.indexOf('case "prompt_done"'));
  assert.match(notifySource, /promptCompletionDeduperRef\.current\.claim\(sessionIdRef\.current, runId, serverRunId\)/);
  assert.match(finishSource, /notifyPromptStage\(runId, currentAgentRunIdRef\.current \?\? undefined\)/);
  assert.doesNotMatch(finishSource, /onAgentEnd\?\.\(\)/);
  assert.match(settledSource, /notifyPromptStage\(promptRunIdRef\.current, serverRunId\)/);
  assert.doesNotMatch(settledSource, /onAgentEnd\?\.\(\)/);
});

test("publishes complete session metrics and refreshes the matching details cache key", () => {
  assert.match(chatWindowSource, /const statsKey = sessionStats \? JSON\.stringify\(sessionStats\) : null;/);
  assert.match(chatWindowSource, /sessionStatsRefreshRef,/);

  const refreshSource = source.slice(
    source.indexOf("const refreshSessionStats"),
    source.indexOf("// Load the raw parent chain"),
  );
  assert.match(refreshSource, /sendAgentCommandR<SessionStatsInfo>\(sid, \{ type: "get_session_stats" \}\)/);
  assert.match(refreshSource, /requestGeneration === sessionStatsRequestGenerationRef\.current/);
  assert.match(refreshSource, /sessionStatsRefreshRef\.current = refresh/);
  assert.match(refreshSource, /modelConfigRevision: modelsRefreshKey/);
  assert.match(refreshSource, /invalidateSessionDetails\(request\)/);
  assert.match(refreshSource, /if \((\(modelsRefreshKey \?\? 0\) > 0)\) \{\s+invalidateSessionDetails\(\{ \.\.\.request, modelConfigRevision: undefined \}\)/);
  assert.match(refreshSource, /ensureSessionCost\(request\)/);
  assert.match(refreshSource, /await refreshSessionStats\(sid\)/);
  const statsSource = source.slice(source.indexOf("const sessionStats = useMemo"), source.indexOf("const loadSession = useCallback"));
  assert.match(statsSource, /input: sessionUsageTotals\.inputTokens/);
  assert.match(statsSource, /data\?\.stats/);
  assert.match(statsSource, /: baseStats\.tokens/);
  assert.match(refreshSource, /\}, \[ensureSessionCost, invalidateSessionDetailsForSession, modelsRefreshKey, refreshSessionStats, session\?\.id, sessionDetailsVersion\]\)/);
  assert.doesNotMatch(source, /setSessionStatsOverride\(null\);\s+\}, \[messages,/);
});

test("wires the current-session automatic compaction toggle", () => {
  assert.match(source, /autoCompactionEnabled/);
  assert.match(source, /set_auto_compaction/);
  assert.match(source, /handleAutoCompactionChange/);
  assert.match(chatWindowSource, /onAutoCompactionChange/);
  assert.match(chatInputSource, /aria-pressed=\{runtimeSettingsRead\?\.status === "error" \? undefined : autoCompactionEnabled \?\? undefined\}/);
});

test("idle settings use a read-only route and fresh-session hydration keeps identity guards", () => {
  const stateSource = source.slice(source.indexOf("  const loadAgentState = useCallback"), source.indexOf("  const loadSession = useCallback"));
  assert.match(stateSource, /sessions\/\$\{encodeURIComponent\(sid\)\}\/state/);
  assert.match(stateSource, /typeof liveState\?\.autoCompactionEnabled === "boolean"/);
  assert.match(stateSource, /settingsGeneration === runtimeSettingsReadGenerationRef\.current/);
  assert.match(stateSource, /stateLoadInFlightRef/);
  assert.doesNotMatch(stateSource, /sendAgentCommandR.*get_state/);
  assert.match(source, /const realId = applyNewSessionResponse[\s\S]*?sendAgentCommandR<AgentStateResponse>\(realId/);
  assert.match(source, /if \(!isCurrent\(\) \|\| sessionIdRef\.current !== realId\) return null/);
});

test("a persisted runtime message resumes tail following only on the selected current branch", () => {
  const h = createRefreshHarness();
  let followed = 0;
  h.ctx.reader.followPersistedTail = () => { followed++; };
  h.ctx.canWriteBranch = canWriteBranch;
  h.branch.state = { phase: "current", runtimeLeafId: "anchor", viewedLeafId: "anchor", ready: true, error: null };
  const message = { role: "user", content: "new turn" };
  h.ctx.handleAgentEvent({ type: "message_end", message, entryId: "new", orderKey: [1, 1, 1] });
  assert.equal(followed, 1);
  h.ctx.handleAgentEvent({ type: "message_end", message });
  assert.equal(followed, 1, "an unpersisted event cannot advance the history source");
  h.branch.state = { ...h.branch.state, phase: "preview", viewedLeafId: "preview" };
  h.ctx.handleAgentEvent({ type: "message_end", message, entryId: "other", orderKey: [2, 1, 2] });
  assert.equal(followed, 1, "a read-only preview cannot follow the runtime branch");
});

test("branch navigation rejects writes until the viewed and runtime leaves are confirmed", () => {
  assert.match(source, /new BranchNavigation\(renderBranch\)/);
  assert.match(source, /branchRef\.current\?\.reset\(branchScope, isNewSession\)/);
  assert.match(source, /sessionViewValidationPendingRef\.current/);
  assert.match(source, /writesContext && !isNewSession && \(sessionViewValidationPendingRef\.current \|\| !canWriteBranch\(position\)\)/);
  assert.match(source, /canWriteBranch\(position\)/);
  assert.match(source, /expectedLeafId: position\.runtimeLeafId/);
  assert.match(source, /sessionHookMountedRef\.current/);
  assert.match(source, /transcriptMutationRevisionRef/);
  assert.doesNotMatch(chatWindow, /navigateTree/);
});

test("queue recall cannot erase a newer enqueue while the clear response is in flight", async () => {
  const initial = { itemId: "old", text: "old", hasImages: true, images: [{ data: "AAAA", mimeType: "image/png" }] };
  const newer = { itemId: "new", text: "new", hasImages: true, images: [{ data: "BBBB", mimeType: "image/png" }] };
  const h = createQueueHarness({ command: async (_request, harness) => {
    harness.ctx.handleAgentEvent({ type: "queue_update", queueSnapshot: queueSnapshot(3, [newer]) });
    return { clearedQueue: queueSnapshot(1, [initial]), queueSnapshot: queueSnapshot(2) };
  } });
  h.ctx.handleAgentEvent({ type: "queue_update", queueSnapshot: queueSnapshot(1, [initial]) });
  await h.ctx.recall();
  assert.equal(h.queue.steering[0].itemId, "new");
  assert.equal(h.restored[0][0], "old");
  assert.equal(h.restored[0][1][0].data, "AAAA");
});

test("failed queue CAS and legacy peers do not clear drafts or mutate the server queue", async () => {
  const initial = { itemId: "one", text: "same", hasImages: true };
  const h = createQueueHarness({ command: async () => { throw new Error("queue_revision_conflict"); } });
  h.ctx.handleAgentEvent({ type: "queue_update", queueSnapshot: queueSnapshot(1, [initial]) });
  await h.ctx.recall();
  assert.equal(h.queue.steering[0].itemId, "one");
  assert.deepEqual(h.restored, []);
  const legacy = createQueueHarness();
  legacy.ctx.queuedDraftProjectionRef.current.reset("s");
  legacy.ctx.handleAgentEvent({ type: "queue_update", steering: ["same"], followUp: [] });
  await legacy.ctx.recall();
  assert.equal(legacy.calls.length, 0, "text-only peers must not be cleared before attachments can be identified");
  assert.equal(legacy.queue.steering[0].text, "same");
});

test("a recalled queue returning after a peer switch restores only the original composer draft", async () => {
  const initial = { itemId: "one", text: "same", hasImages: true, images: [{ data: "AAAA", mimeType: "image/png" }] };
  const h = createQueueHarness({ command: async (_request, harness) => {
    harness.ctx.remotePeerRef.current = "peer-B";
    return { clearedQueue: queueSnapshot(1, [initial]), queueSnapshot: queueSnapshot(2) };
  } });
  h.ctx.handleAgentEvent({ type: "queue_update", queueSnapshot: queueSnapshot(1, [initial]) });
  await h.ctx.recall();
  assert.equal(h.restored.length, 0, "a late response must not touch the new peer's composer");
  assert.equal(getPendingQueueRecall("s").steering[0].images[0].data, "AAAA");
  clearPendingQueueRecall("s");
  clearQueueRecallOperation("s");
});

test("queue image capacity is checked before clear, including current draft capacity", async () => {
  for (const [count, available] of [[11, 10], [3, 2]]) {
    const h = createQueueHarness();
    h.ctx.opts.chatInputRef.current.availableImageSlots = () => available;
    h.ctx.handleAgentEvent({ type: "queue_update", queueSnapshot: queueSnapshot(1, [{ itemId: "images", text: "same", hasImages: true, imageCount: count }]) });
    await h.ctx.recall();
    assert.equal(h.calls.length, 0);
    assert.equal(h.queue.steering[0].itemId, "images");
    assert.equal(h.restored.length, 0);
  }
});

test("capacity lost during clear retains all recalled images and retries without clearing twice", async () => {
  const initial = { itemId: "one", text: "same", hasImages: true, images: [{ data: "AAAA", mimeType: "image/png" }] };
  const h = createQueueHarness({ command: async (_request, harness) => {
    harness.ctx.opts.chatInputRef.current.prependQueuedDraft = () => false;
    return { clearedQueue: queueSnapshot(1, [initial]), queueSnapshot: queueSnapshot(2) };
  } });
  h.ctx.handleAgentEvent({ type: "queue_update", queueSnapshot: queueSnapshot(1, [initial]) });
  await h.ctx.recall();
  assert.equal(h.queue.recallPending, true);
  assert.equal(getPendingQueueRecall("s").steering[0].images[0].data, "AAAA");
  h.ctx.opts.chatInputRef.current.prependQueuedDraft = (...args) => { h.restored.push(args); return true; };
  await h.ctx.recall();
  assert.equal(h.calls.filter(call => call.type === "clear_queue").length, 1, "retry consumes only the retained clear result");
  assert.equal(h.restored[0][1][0].data, "AAAA");
  assert.equal(getPendingQueueRecall("s"), null);
});

test("a lost clear response retries the same operation ID and cannot clear newer queued images", async () => {
  const initial = { itemId: "old", text: "same", hasImages: true, images: [{ data: "AAAA", mimeType: "image/png" }] };
  const newer = { itemId: "new", text: "same", hasImages: true, images: [{ data: "BBBB", mimeType: "image/png" }] };
  let attempts = 0;
  const h = createQueueHarness({ command: async (_request, harness) => {
    attempts++;
    if (attempts === 1) {
      harness.ctx.handleAgentEvent({ type: "queue_update", queueSnapshot: queueSnapshot(3, [newer]) });
      throw new TypeError("response lost");
    }
    return { clearedQueue: queueSnapshot(1, [initial]), queueSnapshot: queueSnapshot(2) };
  } });
  h.ctx.handleAgentEvent({ type: "queue_update", queueSnapshot: queueSnapshot(1, [initial]) });
  await h.ctx.recall();
  assert.equal(h.queue.recallPending, true);
  const operation = getQueueRecallOperation("s");
  assert.ok(operation);
  await h.ctx.recall();
  assert.equal(h.calls[0].queueRecallOperationId, h.calls[1].queueRecallOperationId);
  assert.equal(h.calls[1].expectedQueueIdentity.queueRevision, 1);
  assert.equal(h.restored[0][1][0].data, "AAAA");
  assert.equal(h.queue.steering[0].itemId, "new");
  assert.equal(getQueueRecallOperation("s"), null);
});

test("recovering an old-boot recall never rewinds the current runtime queue", async () => {
  const old = { itemId: "old", text: "old", hasImages: true, images: [{ data: "AAAA", mimeType: "image/png" }] };
  const fresh = { itemId: "fresh", text: "fresh", hasImages: false };
  const oldSnapshot = queueSnapshot(1, [old]);
  const h = createQueueHarness({ command: async () => ({ clearedQueue: oldSnapshot, queueSnapshot: queueSnapshot(2) }) });
  h.ctx.handleAgentEvent({ type: "queue_update", queueSnapshot: oldSnapshot });
  beginQueueRecallOperation("s", oldSnapshot);
  h.ctx.handleAgentEvent({ type: "queue_update", queueSnapshot: queueSnapshot(1, [fresh], [], "new-boot") });
  await h.ctx.recall();
  assert.equal(h.queue.steering[0].itemId, "fresh");
  assert.equal(h.ctx.queuedDraftProjectionRef.current.snapshot.bootId, "new-boot");
  assert.equal(h.restored[0][1][0].data, "AAAA");
});


test("mixed custom/user queues are preserved rather than forged into user input", async () => {
  const h = createQueueHarness();
  h.ctx.handleAgentEvent({ type: "queue_update", queueSnapshot: queueSnapshot(1, [
    { itemId: "user", text: "same", hasImages: false },
    { itemId: "peer", role: "custom", customType: "reader.peer-message", text: "peer context", hasImages: false },
  ]) });
  await h.ctx.recall();
  assert.equal(h.calls.length, 0);
  assert.equal(h.queue.steering.length, 2);
  assert.equal(h.restored.length, 0);
});

test("lost ack response retries ack only without duplicating the restored draft", async () => {
  let acknowledgements = 0;
  const h = createQueueHarness({ ack: async () => {
    if (++acknowledgements === 1) throw new Error("ack response lost");
    return { acknowledged: true };
  } });
  await h.ctx.send("same", "steer", [{ data: "AAAA", mimeType: "image/png" }]);
  await h.ctx.recall();
  assert.equal(getQueueRecallOperation("s").restored, true);
  assert.equal(h.restored.length, 1);
  assert.equal(h.queue.recallPending, true);
  h.ctx.opts.chatInputRef.current.availableImageSlots = () => 0;
  await h.ctx.recall();
  assert.equal(h.calls.filter(call => call.type === "clear_queue").length, 1);
  assert.equal(h.calls.filter(call => call.type === "ack_queue_recall").length, 2);
  assert.equal(h.restored.length, 1);
  assert.equal(getQueueRecallOperation("s"), null);
});

test("failed durable composer save retains recovery and does not acknowledge attachments", async () => {
  const h = createQueueHarness();
  await h.ctx.send("same", "steer", [{ data: "AAAA", mimeType: "image/png" }]);
  h.ctx.opts.chatInputRef.current.prependQueuedDraft = () => { throw new Error("storage full"); };
  await h.ctx.recall();
  assert.equal(h.calls.some(call => call.type === "ack_queue_recall"), false);
  assert.equal(getQueueRecallOperation("s").restored, undefined);
  assert.equal(getPendingQueueRecall("s").steering[0].images[0].data, "AAAA");
  clearQueueRecallOperation("s");
  clearPendingQueueRecall("s");
});


test("a rejected ack after a scope change retains the already-restored operation identity", async () => {
  const h = createQueueHarness({ ack: async (_request, harness) => {
    harness.ctx.remotePeerRef.current = "peer-B";
    throw Object.assign(new Error("conversation changed"), { accepted: false });
  } });
  await h.ctx.send("same", "steer", [{ data: "AAAA", mimeType: "image/png" }]);
  await h.ctx.recall();
  assert.equal(getQueueRecallOperation("s").restored, true);
  assert.equal(h.restored.length, 1);
  assert.equal(getPendingQueueRecall("s").steering[0].images[0].data, "AAAA");
  clearQueueRecallOperation("s");
  clearPendingQueueRecall("s");
});


test("localStorage quota fallback leaves a usable input and a discoverable server copy without ACK", async () => {
  const h = createQueueHarness();
  const states = []; let state = "idle", refreshes = 0;
  h.ctx.setQueueRecallState = next => { state = typeof next === "function" ? next(state) : next; states.push(state); };
  h.ctx.refreshQueueRecovery = () => { refreshes++; };
  h.ctx.opts.chatInputRef.current.isQueuedDraftDurable = () => false;
  await h.ctx.send("same", "steer", [{ data: "AAAA", mimeType: "image/png" }]);
  await h.ctx.recall();
  assert.equal(h.calls.filter(call => call.type === "clear_queue").length, 1);
  assert.equal(h.calls.some(call => call.type === "ack_queue_recall"), false);
  assert.equal(h.restored.length, 1);
  assert.equal(h.restored[0][1][0].data, "AAAA");
  assert.equal(state, "server_copy");
  assert.equal(states[0], "recalling");
  assert.equal(refreshes, 1);
  assert.equal(getQueueRecallOperation("s"), null, "discovery no longer depends on the browser operation hint");
  assert.equal(getPendingQueueRecall("s"), null);
});


test("a user recall on an old peer explains the upgrade without clearing or creating an operation", async () => {
  const h = createQueueHarness();
  await h.ctx.send("same", "steer", [{ data: "AAAA", mimeType: "image/png" }]);
  h.ctx.ensureQueueRecoveryAvailable = async () => { throw Object.assign(new Error("This device does not support queue recovery. Update Reader on that device."), { notSent: true }); };
  await h.ctx.recall();
  assert.equal(h.calls.some(call => call.type === "clear_queue"), false);
  assert.equal(h.restored.length, 0);
  assert.equal(h.server.steering[0].images[0].data, "AAAA");
  assert.equal(getQueueRecallOperation("s"), null);
});

test("a peer switch while checking recovery capability cannot clear either peer", async () => {
  const h = createQueueHarness();
  await h.ctx.send("same", "steer", [{ data: "AAAA", mimeType: "image/png" }]);
  h.ctx.ensureQueueRecoveryAvailable = async () => { h.ctx.remotePeerRef.current = "peer-B"; };
  await h.ctx.recall();
  assert.equal(h.calls.some(call => call.type === "clear_queue"), false);
  assert.equal(h.restored.length, 0);
  assert.equal(getQueueRecallOperation("s"), null);
});


test("ordinary composer handle recreation during capability and clear awaits restores through the current handle", async () => {
  const h = createQueueHarness();
  await h.ctx.send("same", "steer", [{ data: "AAAA", mimeType: "image/png" }]);
  const inputRef = h.ctx.opts.chatInputRef;
  const original = inputRef.current;
  let currentPrepend = 0;
  h.ctx.ensureQueueRecoveryAvailable = async () => {
    // Models useImperativeHandle after the normal busy-state render, with the
    // same mounted composer/ref and unchanged conversation scope.
    inputRef.current = { ...original, prependQueuedDraft: () => { throw new Error("stale pre-clear handle"); } };
  };
  const send = h.ctx.sendAgentCommandR;
  original.prependQueuedDraft = () => { throw new Error("stale initial handle"); };
  // Keep the captured implementation separate from the deliberately stale handle.
  const currentImplementation = (...values) => { h.restored.push(values); return true; };
  h.ctx.sendAgentCommandR = async (...args) => {
    const result = await send(...args);
    if (args[1].type === "clear_queue") inputRef.current = { ...original, prependQueuedDraft: (...values) => { currentPrepend++; return currentImplementation(...values); } };
    return result;
  };
  await h.ctx.recall();
  assert.equal(h.calls.filter(call => call.type === "clear_queue").length, 1);
  assert.equal(h.calls.filter(call => call.type === "ack_queue_recall").length, 1);
  assert.equal(currentPrepend, 1);
  assert.equal(h.restored[0][1][0].data, "AAAA");
});

test("a recreated handle with exhausted capacity rejects before clear", async () => {
  const h = createQueueHarness();
  await h.ctx.send("same", "steer", [{ data: "AAAA", mimeType: "image/png" }]);
  h.ctx.ensureQueueRecoveryAvailable = async () => {
    h.ctx.opts.chatInputRef.current = { ...h.ctx.opts.chatInputRef.current, availableImageSlots: () => 0 };
  };
  await h.ctx.recall();
  assert.equal(h.calls.some(call => call.type === "clear_queue"), false);
  assert.equal(h.restored.length, 0);
  assert.equal(h.server.steering[0].images[0].data, "AAAA");
});

test("explicitly settling the matching server copy clears only its notice and leaves the dirty composer intact", async () => {
  const h = createQueueHarness();
  let settled;
  let state = "server_copy";
  const input = h.ctx.opts.chatInputRef.current;
  h.ctx.serverCopyOperationRef.current = "operation-A";
  Object.assign(h.ctx, {
    session: { id: "s" }, remotePeer: undefined,
    setQueueRecallState: next => { state = typeof next === "function" ? next(state) : next; },
    useQueueRecovery: (_session, _peer, _input, _restored, onSettled, retainedOperation) => {
      assert.equal(retainedOperation, h.ctx.serverCopyOperationRef);
      settled = onSettled;
      return { view: {}, refresh() {}, async ensureAvailable() {} };
    },
  });
  const begin = source.indexOf("  const { view: queueRecoveryView");
  const end = source.indexOf("  const handleRecallQueue", begin);
  vm.runInContext(stripTypeScriptTypes(source.slice(begin, end)), h.ctx);
  settled("other-operation");
  assert.equal(state, "server_copy");
  settled("operation-A");
  assert.equal(state, "idle");
  assert.equal(h.ctx.serverCopyOperationRef.current, null);
  assert.equal(h.ctx.opts.chatInputRef.current, input);
  assert.equal(h.restored.length, 0);
  assert.equal(h.calls.length, 0, "settling a saved copy cannot submit or clear anything");
});
