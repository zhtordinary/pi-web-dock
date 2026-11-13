import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { QueuedDraftProjection, readQueuedDraftState, recalledQueuedDrafts, getPendingQueueRecall, savePendingQueueRecall, clearPendingQueueRecall, queuedImageCount, getQueueRecallOperation, beginQueueRecallOperation, markQueueRecallRestored, assertUserQueueRecall, clearQueueRecallOperation } from "../lib/queued-draft.ts";
import { isSessionPeerAgentMessage } from "../lib/session-peer-message.ts";
import { AgentCommandError, isPromptRejectedError, isSessionMissingError, sendAgentCommand } from "../lib/agent-client.ts";
import { appendPersisted, emptyTranscript, upsertMessage, removeMessage, occurrenceId, withOccurrence } from "../lib/transcript-store.ts";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");

function createQueueHarness({ hookSource = source, command, fresh = false } = {}) {
  let runtime = emptyTranscript();
  let queue = { steering: [], followUp: [] };
  const calls = [], restored = [], invalidations = [];
  let server = { bootId: "queue-boot", queueRevision: 0, steering: [], followUp: [] };
  let nextItemId = 0;
  const projection = new QueuedDraftProjection();
  projection.reset("s");
  projection.apply("s", server);
  clearPendingQueueRecall("s");
  clearQueueRecallOperation("s");
  const ctx = {
    useCallback: (fn) => fn, console: { error() {} }, Map, Set, crypto: globalThis.crypto,
    normalizeToolCalls: (message) => message,
    isSessionPeerAgentMessage,
    removeMessage, occurrenceId, upsertMessage, withOccurrence,
    QueuedDraftProjection, readQueuedDraftState, recalledQueuedDrafts, getPendingQueueRecall,
    savePendingQueueRecall, clearPendingQueueRecall, queuedImageCount, getQueueRecallOperation,
    beginQueueRecallOperation, markQueueRecallRestored, assertUserQueueRecall, clearQueueRecallOperation,
    cacheKeyForSession: sid => sid,
    queuedDraftProjectionRef: { current: projection },
    queueRecallInFlightRef: { current: false }, serverCopyOperationRef: { current: null },
    sessionHookMountedRef: { current: true }, remotePeerRef: { current: null },
    branchRef: { current: { state: { phase: "preview", runtimeLeafId: "runtime", viewedLeafId: "preview", ready: true, error: null } } },
    canWriteBranch: () => false,
    branchScopeRef: { current: "local:s" },
    setQueueRecallState() {}, refreshQueueRecovery() {}, async ensureQueueRecoveryAvailable() {},
    composerDraftKey: "s", editEntryId: null,
    historyDraftKey: (sid, peer) => ({ kind: "history", sessionId: sid, peer: peer ?? null }),
    sessionDraftKey: (sid, peer) => ({ kind: "session", sessionId: sid, peer: peer ?? null }),
    pendingHistoryEdits: new Map(), getDraft: () => null, setEdit() {},
    isNew: fresh, newSessionCwd: fresh ? "/project" : null, newSessionModel: null,
    session: fresh ? null : { id: "s" },
    sessionIdRef: { current: fresh ? null : "s" }, currentAgentRunIdRef: { current: null },
    ensuringNewSessionRef: { current: null }, ensureNewSession: async () => null,
    stateRunRevisionRef: { current: 0 }, promptRunIdRef: { current: 0 },
    rpcPromptPendingRef: { current: false }, promptDeliveriesRef: { current: new Map() }, setUnconfirmedPrompts() {}, sessionRunningRef: { current: false },
    sessionSettlementGenerationRef: { current: 0 },
    sdkAgentActiveRef: { current: false },
    setSessionStatePending() {},
    bashRunningRef: { current: false }, isSubprojectAssignmentError: () => false,
    isBranchPositionError: () => false,
    sessionStatePendingRef: { current: false }, agentRunningRef: { current: false }, activeToolIdsRef: { current: new Set() }, toolEventRevisionRef: { current: 0 },
    lastAgentErrorRef: { current: false }, lastAgentAbortedRef: { current: false },
    pendingScrollToUserRef: { current: false }, displayedLiveTailRef: { current: true }, readingIntentRef: { current: "reading" },
    liveFollowFrameRef: { current: null }, transcriptMutationRevisionRef: { current: 0 },
    pendingUserMessageOccurrencesRef: { current: new Map() }, pendingPeerMessageIdsRef: { current: new Set() },
    pendingQueuedUserMessagesRef: { current: [] },
    restoreSubmission: (...args) => restored.push(args),
    isPromptRejectedError, isSessionMissingError,
    opts: { chatInputRef: { current: {
      availableImageSlots: () => 10, hasQueuedDraft: () => false, isQueuedDraftDurable: () => true,
      prependQueuedDraft: (...args) => { restored.push(args); return true; },
      prependText: (...args) => restored.push(args),
    } } },
    setQueuedMessages: (value) => { queue = value; },
    setAgentPhase() {}, setAgentRunning() {}, setActiveToolResults() {}, setRetryInfo() {}, dispatch() {},
    cancelInitialLanding() {}, setPromptAnchorActive() {},
    reader: { recordUnseenEntry() {}, reconcileTail: async () => {}, followPersistedTail: () => false },
    appendMessage: (message, entryId = "", delivery) => { runtime = appendPersisted(runtime, message, entryId, delivery); },
    updateMessages: (update) => {
      const next = update(runtime);
      runtime = next;
    },
    sendAgentCommandR: async (sid, request) => {
      calls.push({ sid, ...request });
      if (command) return command(request, { ctx });
      if (request.type === "ack_queue_recall") return { acknowledged: true };
      if (request.type === "clear_queue") {
        assert.equal(request.expectedQueueIdentity.bootId, server.bootId);
        assert.equal(request.expectedQueueIdentity.queueRevision, server.queueRevision);
        const clearedQueue = server;
        server = { ...server, queueRevision: server.queueRevision + 1, steering: [], followUp: [] };
        ctx.handleAgentEvent({ type: "queue_update", queueSnapshot: server });
        return { clearedQueue, queueSnapshot: server };
      }
      const kind = request.streamingBehavior === "steer" ? "steering" : "followUp";
      const images = request.images?.map(({ data, mimeType }) => ({ data, mimeType })) ?? [];
      const item = { itemId: `item-${++nextItemId}`, role: "user", text: request.message,
        hasImages: images.length > 0, imageCount: images.length, ...(images.length ? { images } : {}) };
      server = { ...server, queueRevision: server.queueRevision + 1, [kind]: [...server[kind], item] };
      ctx.handleAgentEvent({ type: "queue_update", queueSnapshot: server });
      return null;
    },
  };
  const eventSource = source.slice(source.indexOf("  const handleAgentEvent = useCallback"), source.indexOf("  handleAgentEventRef.current = handleAgentEvent"));
  const sendSource = hookSource.slice(hookSource.indexOf("  const sendStreamingPrompt"), hookSource.indexOf("  const handleSteer"));
  const recallSource = source.slice(source.indexOf("  const handleRecallQueue"), source.indexOf("  // Continue button"));
  const directSource = source.slice(source.indexOf("  const handleSend = useCallback"), source.indexOf("  const handleRetryContinue"));
  const normalizeSource = source.slice(source.indexOf("function normalizeQueuedMessages("), source.indexOf("type ExtensionUiDialogRequest"));
  const syncSource = source.slice(source.indexOf("  const syncQueuedDrafts ="), source.indexOf("  const eventConnectionRef"));
  const settleSource = source.slice(source.indexOf("  const settleUiStage = useCallback"), source.indexOf("  const notifyPromptStage"));
  const code = normalizeSource + syncSource + settleSource + eventSource + sendSource + recallSource + directSource;
  // Only dependency-array callbacks are inert. Message/queue state transitions
  // above are real and the production callback bodies run unchanged.
  for (const match of code.matchAll(/\}, \[([^\]]*)\]\);/g)) {
    for (const key of match[1].split(",").map((key) => key.trim())) {
      if (/^[A-Za-z_$][\w$]*$/.test(key) && !(key in ctx)) ctx[key] = () => {};
    }
  }
  vm.createContext(ctx);
  vm.runInContext(stripTypeScriptTypes(code + "\nglobalThis.handleAgentEvent = handleAgentEvent; globalThis.send = sendStreamingPrompt; globalThis.recall = handleRecallQueue; globalThis.sendDirect = handleSend; globalThis.settleUiStage = settleUiStage;"), ctx);
  return { ctx, calls, restored, invalidations, get messages() { return runtime.messages; }, get entryIds() { return runtime.entryIds; }, get queue() { return queue; }, get server() { return server; } };
}

async function checkQueueLifecycle(hookSource = source, behavior = "steer") {
  const h = createQueueHarness({ hookSource });
  await h.ctx.send("queued next", behavior);
  const kind = behavior === "steer" ? "steering" : "followUp";
  assert.equal(h.queue[kind].length, 1);
  assert.equal(h.messages.length, 0, "undelivered queue must not enter transcript");
  assert.equal(h.ctx.pendingScrollToUserRef.current, false);
  assert.equal(h.calls[0].type, "prompt");
  assert.equal(h.calls[0].streamingBehavior, behavior);
  assert.equal(h.calls[0].requireQueueIdentity, true);
  assert.equal(h.queue[kind][0].itemId, h.server[kind][0].itemId);
  h.ctx.handleAgentEvent({ type: "queue_update", queueSnapshot: { ...h.server, queueRevision: h.server.queueRevision + 1, steering: [], followUp: [] } });
  const message = { role: "user", content: "queued next", timestamp: 2 };
  h.ctx.handleAgentEvent({ type: "message_start", message });
  h.ctx.handleAgentEvent({ type: "message_end", message, entryId: "persisted-user" });
  assert.equal(h.queue[kind].length, 0);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].content, "queued next");
  assert.equal(h.entryIds[0], "persisted-user");
}

for (const behavior of ["steer", "followUp"]) {
  test(behavior + " stays queued until its actual delivery", () => checkQueueLifecycle(source, behavior));
}

test("identical queued texts remain distinct delivered turns with distinct identities", async () => {
  const h = createQueueHarness();
  await h.ctx.send("same", "steer");
  await h.ctx.send("same", "steer");
  assert.equal(h.queue.steering.length, 2);
  assert.notEqual(h.queue.steering[0].itemId, h.queue.steering[1].itemId);
  assert.equal(h.messages.length, 0);
  for (let index = 0; index < 2; index++) {
    const message = { role: "user", content: "same", timestamp: index + 1 };
    h.ctx.handleAgentEvent({ type: "message_start", message });
    h.ctx.handleAgentEvent({ type: "message_end", message, entryId: `entry-${index}` });
  }
  assert.equal(h.messages.length, 2);
  assert.deepEqual(Array.from(h.entryIds), ["entry-0", "entry-1"]);
});

test("queue recall restores images without modifying transcript", async () => {
  const h = createQueueHarness();
  const images = [{ data: "AAAA", mimeType: "image/png" }];
  await h.ctx.send("inspect", "followUp", images);
  await h.ctx.recall();
  assert.equal(h.queue.followUp.length, 0);
  assert.equal(h.messages.length, 0);
  assert.equal(h.restored[0][0], "inspect");
  assert.deepEqual(Array.from(h.restored[0][1]), images);
  assert.deepEqual(h.calls.map(call => call.type), ["prompt", "clear_queue", "ack_queue_recall"]);
  assert.equal(h.calls[1].requireQueueIdentity, true);
  assert.equal(h.calls[1].expectedQueueIdentity.bootId, "queue-boot");
  assert.equal(h.calls[1].expectedQueueIdentity.queueRevision, 1);
  assert.equal(h.calls[2].queueRecallOperationId, h.calls[1].queueRecallOperationId);
  assert.equal(h.restored[0][2], h.calls[1].queueRecallOperationId);
  assert.equal(getPendingQueueRecall("s"), null);
  assert.equal(getQueueRecallOperation("s"), null);
});

for (const rejected of [true, false]) {
  test("streaming failure restores only definitive rejection: " + rejected, async () => {
    const h = createQueueHarness({ command: async () => {
      throw rejected ? new AgentCommandError("failed", 500, "prompt_rejected", false) : new TypeError("connection reset");
    } });
    await h.ctx.send("queued next", "steer");
    assert.equal(h.messages.length, 0);
    assert.equal(h.restored.length, rejected ? 1 : 0);
  });
}

test("a settled runtime can turn a queued submission into a real user delivery", async () => {
  const h = createQueueHarness({ command: async (request, { ctx }) => {
    const message = { role: "user", content: request.message, timestamp: 2 };
    ctx.handleAgentEvent({ type: "message_start", message });
    ctx.handleAgentEvent({ type: "message_end", message, entryId: "entry-now" });
  } });
  await h.ctx.send("start now", "steer");
  assert.equal(h.queue.steering.length, 0);
  assert.equal(h.messages.length, 1);
});

for (const code of ["session_runtime_owned", "session_archived"]) {
  test(`${code} cannot leave an old question after later completed turns`, async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => Response.json({ error: "Session cannot accept this prompt", code, accepted: false }, { status: 409 });
    let submissions = 0;
    const h = createQueueHarness({ command: async (request, { ctx }) => {
      if (++submissions === 1) return sendAgentCommand("s", request);
      const runId = `run-${submissions}`;
      const user = { role: "user", content: request.message, timestamp: submissions * 10 };
      const answer = { role: "assistant", content: [{ type: "text", text: `answer ${submissions}` }], stopReason: "stop" };
      ctx.handleAgentEvent({ type: "agent_start", runId });
      ctx.handleAgentEvent({ type: "message_start", runId, message: user });
      ctx.handleAgentEvent({ type: "message_end", runId, message: user, entryId: `user-${submissions}`, orderKey: [submissions * 2, 1, submissions * 2], clientMessageId: request.clientMessageId });
      ctx.handleAgentEvent({ type: "message_end", runId, message: answer, entryId: `answer-${submissions}`, orderKey: [submissions * 2 + 1, 1, submissions * 2 + 1] });
      ctx.settleUiStage();
    } });
    await h.ctx.sendDirect("old question");
    // An idle-state reconciliation uses this same production settlement path.
    h.ctx.settleUiStage();
    await h.ctx.sendDirect("new question");
    await h.ctx.sendDirect("another question");
    assert.equal(submissions, 3);
    assert.deepEqual(h.entryIds, ["user-2", "answer-2", "user-3", "answer-3"], "a definitively rejected row must not survive at the transcript tail");
    assert.equal(h.restored.length, 1, "the refused submission must return to the composer");
    assert.equal(h.restored[0][0], "old question");
  });
}

for (const [code, status] of [["session_runtime_owned", 409], ["session_archived", 409], ["session_missing", 404], ["request_denied", 403]]) {
  test(`streaming ${code} restores only the refused queued input`, async () => {
    const h = createQueueHarness({ command: async () => { throw new AgentCommandError("Prompt was not admitted", status, code, false); } });
    await h.ctx.send("queued next", "steer");
    assert.equal(h.messages.length, 0);
    assert.equal(h.restored.length, 1);
    assert.equal(h.restored[0][0], "queued next");
  });
}

test("an ambiguous prompt transport failure retains its row until matching delivery", async () => {
  const h = createQueueHarness({ command: async () => { throw new TypeError("connection reset"); } });
  await h.ctx.sendDirect("possibly accepted");
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.entryIds, [""]);
  assert.equal(h.restored.length, 0);
  const clientMessageId = h.calls[0].clientMessageId;
  h.ctx.handleAgentEvent({ type: "message_end", runId: "accepted-run", message: { role: "user", content: "possibly accepted", timestamp: 2 }, entryId: "accepted-user", orderKey: [1, 1, 1], clientMessageId });
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.entryIds, ["accepted-user"]);
});

test("post-accept prompt errors do not duplicate the user submission", () => {
  const h = createQueueHarness();
  h.ctx.handleAgentEvent({ type: "prompt_error", runId: "run-1", errorMessage: "failed" });
  assert.equal(h.messages.length, 0);
  assert.equal(h.restored.length, 0);
});

test("a fresh-session creation rejection removes only its optimistic occurrence", async () => {
  const h = createQueueHarness({ fresh: true });
  await h.ctx.sendDirect("not sent");
  assert.equal(h.messages.length, 0);
  assert.equal(h.restored.length, 1);
  assert.equal(h.ctx.agentRunningRef.current, false);
});

test("a definitive prompt rejection preserves another identical occurrence", async () => {
  const h = createQueueHarness({ command: async (_request, { ctx }) => {
    ctx.appendMessage({ role: "user", content: "same", timestamp: 2 });
    throw new AgentCommandError("rejected", 500, "prompt_rejected", false);
  } });
  await h.ctx.sendDirect("same");
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].timestamp, 2);
  assert.equal(h.restored.length, 1);
});

for (const size of [32768, 1024 * 1024]) {
  test("image prompt start/end uses the same occurrence despite preview bounding: " + size, async () => {
    const data = "A".repeat(size);
    const h = createQueueHarness({ command: async (request, { ctx }) => {
      const message = { role: "user", content: [{ type: "text", text: request.message }, ...request.images], timestamp: 2 };
      ctx.handleAgentEvent({ type: "message_start", message });
      ctx.handleAgentEvent({ type: "message_end", message, entryId: "persisted-image", clientMessageId: request.clientMessageId, orderKey: [1,1,1] });
    } });
    await h.ctx.sendDirect("picture", [{ data, mimeType: "image/png" }]);
    assert.equal(h.messages.length, 1);
    assert.deepEqual(Array.from(h.entryIds), ["persisted-image"]);
    const image = h.messages[0].content.find((block) => block.type === "image");
    if (image) assert.equal(image.data ?? image.source?.data, data);
    else assert.ok(h.messages[0].content.some((block) => block.type === "text" && /image.*deferred/i.test(block.text)));
  });
}

test("a rejected submission preserves a different run reported by the server", () => {
  const start = source.indexOf("  const reconcileAgentState = useCallback");
  const end = source.indexOf("  // Keep a bounded foreground fallback", start);
  assert.ok(end > start);
  const code = source.slice(start, end);
  assert.match(code, /sessionIdRef\.current !== sid/);
  assert.match(code, /if \(busy \|\| localCompactionPendingRef\.current\) \{[\s\S]*?sdkAgentActiveRef\.current = Boolean\(state\.isStreaming\)/);
  assert.match(code, /rpcPromptPendingRef\.current = Boolean\(state\.isPromptRunning\)/);
  assert.match(code, /if \(!agentRunningRef\.current && !clientStreamActive\) return;[\s\S]*?finishPromptWithoutStream/);
});

for (const endBeforeRejection of [false, true]) {
  test(`another run's same-text SSE occurrence survives local rejection: persisted=${endBeforeRejection}`, async () => {
    let localOccurrence;
    const message = { role: "user", content: "same", timestamp: 2 };
    const h = createQueueHarness({ command: async (_request, { ctx }) => {
      localOccurrence = occurrenceId(h.messages[0]);
      ctx.sdkAgentActiveRef = { current: false };
      ctx.setSessionStatePending = () => {};
      ctx.handleAgentEvent({ type: "agent_start", runId: "remote-run-B" });
      ctx.handleAgentEvent({ type: "message_start", message });
      assert.equal(h.messages.length, 1);
      assert.equal(occurrenceId(h.messages[0]), localOccurrence, "message_start cannot replace the local pending identity");
      if (endBeforeRejection) ctx.handleAgentEvent({ type: "message_end", message, entryId: "persisted-B", orderKey: [1,1,1] });
      throw new AgentCommandError("busy rejection for local A", 500, "prompt_rejected", false);
    } });
    await h.ctx.sendDirect("same");
    assert.equal(h.messages.length, endBeforeRejection ? 1 : 0, "only a completed external row is authoritative");
    if (!endBeforeRejection) h.ctx.handleAgentEvent({ type: "message_end", message, entryId: "persisted-B", orderKey: [1,1,1] });
    assert.equal(h.messages.length, 1);
    assert.deepEqual(Array.from(h.entryIds), ["persisted-B"]);
    assert.equal(h.messages[0].timestamp, 2);
    assert.equal(h.restored.length, 1);
    assert.equal(h.restored[0][0], "same");
  });
}

test("same-text completions use entry identity and orderKey regardless of arrival order", () => {
  for (const differentRun of [false, true]) {
    const h = createQueueHarness();
    const first = { role: "user", content: "same", timestamp: 10 };
    const second = { role: "user", content: "same", timestamp: differentRun ? 10 : 20 };
    const runA = "run-a", runB = differentRun ? "run-b" : runA;
    h.ctx.handleAgentEvent({ type: "message_start", runId: runA, message: first });
    h.ctx.handleAgentEvent({ type: "message_start", runId: runB, message: second });
    assert.equal(h.messages.length, 0);
    h.ctx.handleAgentEvent({ type: "message_end", runId: runB, message: second, entryId: "second", orderKey: [2,1,2] });
    h.ctx.handleAgentEvent({ type: "message_end", runId: runA, message: first, entryId: "first", orderKey: [1,1,1] });
    assert.deepEqual(Array.from(h.entryIds), ["first", "second"]);
  }
});

test("an end-only persisted SSE message never acquires a rejected local prompt's rollback identity", async () => {
  const h = createQueueHarness({ command: async (_request, { ctx }) => {
    const localId = occurrenceId(h.messages[0]);
    ctx.handleAgentEvent({ type: "message_end", message: { role: "user", content: "same", timestamp: 2 }, entryId: "remote-entry", orderKey: [1,1,1] });
    assert.notEqual(occurrenceId(h.messages[0]), localId);
    throw new AgentCommandError("rejected", 500, "prompt_rejected", false);
  } });
  await h.ctx.sendDirect("same");
  assert.equal(h.messages.length, 1);
  assert.deepEqual(Array.from(h.entryIds), ["remote-entry"]);
  assert.equal(h.restored.length, 1);
});
