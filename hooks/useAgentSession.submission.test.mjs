import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const syntax = ts.createSourceFile("useAgentSession.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function actual(name, context) {
  let callback;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(syntax) === name) callback = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  assert.ok(callback, name);
  return vm.runInNewContext(ts.transpileModule(`(${callback.getText(syntax)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
}
const ref = current => ({ current });
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function harness() {
  const ready = deferred(), accepted = deferred(), posting = deferred();
  const messages = [], commands = [], restored = [], actions = [], notices = [], completions = [];
  let unconfirmed = [];
  const noop = () => {};
  const context = {
    session: { id: "session" }, isNew: false, newSessionCwd: null, newSessionModel: null,
    editEntryId: null, composerDraftKey: "draft",
    sessionStatePendingRef: ref(false), agentRunningRef: ref(false), bashRunningRef: ref(false), activeToolIdsRef: ref(new Set()), toolEventRevisionRef: ref(0),
    isCompacting: false, streamState: { isStreaming: false }, localCompactionPendingRef: ref(false),
    promptRunIdRef: ref(0), stateRunRevisionRef: ref(0), rpcPromptPendingRef: ref(false),
    promptDeliveriesRef: ref(new Map()), promptCompletionDeduperRef: ref({ claim: () => true }),
    setUnconfirmedPrompts: update => { unconfirmed = update(unconfirmed); }, onAgentEnd: () => completions.push("completed"),
    sessionHookMountedRef: ref(true), sessionIdRef: ref("session"), branchScopeRef: ref("local:session"),
    remotePeerRef: ref(null), sdkAgentActiveRef: ref(false), currentAgentRunIdRef: ref(null),
    sessionRunningRef: ref(false), sessionSettlementGenerationRef: ref(0),
    pendingScrollToUserRef: ref(false), pendingSessionLoadRef: ref(null),
    queuedDraftProjectionRef: ref({ generation: 0 }),
    messagesRef: ref(messages), entryIdsRef: ref([]),
    onRetryContinueStartedRef: ref(noop), latestRetryErrorEntry: () => "failed-entry",
    lastAgentErrorRef: ref(false), lastAgentAbortedRef: ref(false),
    reader: { reconcileTail: noop }, crypto: { randomUUID: () => "client-message" },
    withOccurrence: message => message,
    removeMessage: (current, message) => current.filter(item => item !== message),
    appendMessage: message => messages.push(message),
    updateMessages: update => messages.splice(0, messages.length, ...update(messages)),
    restoreSubmission: (...args) => restored.push(args),
    ensureEventsConnected: () => ready.promise,
    sendAgentCommandR: async (_sid, command) => {
      commands.push(command);
      if (command.type === "prompt" || command.type === "retry_continue") { posting.resolve(); await accepted.promise; }
    },
    loadAgentState: async () => ({ running: true, state: { isStreaming: false, isPromptRunning: false } }),
    loadSession: async () => {}, loadTools: noop, refreshSessionCost: async () => {},
    syncQueuedDraftResponse: noop,
    scheduleEventStreamClose: noop, cancelEventStreamGrace: noop, closeEvents: noop,
    setAgentRunning: noop, setAgentPhase: noop, setPromptAnchorActive: noop, setSessionStatePending: noop,
    setIsCompacting: noop, setActiveToolResults: noop, setRetryInfo: noop,
    onSessionReady: noop, setContextUsage: noop,
    dispatch: action => actions.push(action.type), addNotice: notice => notices.push(notice),
    isSessionMissingError: error => error?.code === "session_missing",
    isSubprojectAssignmentError: () => false,
    isPromptRejectedError: error => error?.accepted === false,
    isBranchPositionError: () => false,
    console: { error: noop }, Map, AbortController, window: { setTimeout, clearTimeout }, apiPath: path => path,
    fetch: async () => ({ ok: true, json: async () => ({ running: true, state: { isPromptRunning: false, isStreaming: false } }) }),
  };
  for (const name of ["settleUiStage", "confirmPromptDelivery", "notifyPromptStage", "finishPromptWithoutStream", "waitForPromptSettlement", "restoreLoadedRunState", "reconcileAgentState"]) {
    context[name] = actual(name, context);
  }
  return { context, ready, accepted, posting, messages, commands, restored, actions, notices, completions, get unconfirmed() { return unconfirmed; } };
}

test("idle connected, restore and reconciliation cannot settle an unaccepted local submission", async () => {
  const h = harness(), c = h.context;
  const send = actual("handleSend", c);
  const pending = send("first input");
  const owner = c.rpcPromptPendingRef.current;
  assert.equal(owner.runId, 1);
  const event = actual("handleAgentEvent", c);
  event({ type: "connected", runtimeAvailable: false, isStreaming: false, isPromptRunning: false });
  await Promise.resolve();
  c.restoreLoadedRunState("session", { running: false });
  await c.reconcileAgentState("session");
  assert.equal(c.rpcPromptPendingRef.current, owner);
  assert.equal(c.agentRunningRef.current, true);
  assert.deepEqual(h.actions, ["start"]);
  assert.equal(h.completions.length, 0);
  await send("second input");
  assert.deepEqual(h.restored[0], ["second input", undefined, "draft"]);
  assert.equal(h.messages.length, 1);
  h.ready.resolve();
  await h.posting.promise;
  assert.equal(h.commands.length, 1);
  assert.equal(owner.requestStarted, true);
  await c.reconcileAgentState("session");
  assert.equal(c.rpcPromptPendingRef.current, owner, "in-flight POST still owns settlement");
  h.accepted.resolve(); await pending;
  assert.equal(c.rpcPromptPendingRef.current, true, "accepted POST hands settlement back to runtime observations");
  await c.reconcileAgentState("session");
  assert.equal(c.agentRunningRef.current, false);
  assert.equal(h.completions.length, 1);
});

for (const retry of [false, true]) {
  test(`${retry ? "retry" : "send"} cannot dispatch after Stop releases a pending initialization`, async () => {
    const h = harness(), c = h.context;
    const pending = retry ? actual("handleRetryContinue", c)() : actual("handleSend", c)("unsent input");
    await actual("handleAbort", c)();
    h.ready.resolve(); h.accepted.resolve(); await pending;
    assert.deepEqual(h.commands.map(command => command.type), ["abort"]);
    assert.equal(c.rpcPromptPendingRef.current, false);
    assert.equal(c.agentRunningRef.current, false);
    assert.equal(h.completions.length, 0);
    if (!retry) {
      assert.equal(h.messages.length, 0);
      assert.deepEqual(h.restored, [["unsent input", undefined, "draft"]]);
    }
  });
  test(`${retry ? "retry" : "send"} cannot dispatch after its peer or session scope changes`, async () => {
    const h = harness(), c = h.context;
    const pending = retry ? actual("handleRetryContinue", c)() : actual("handleSend", c)("old scope input");
    c.remotePeerRef.current = "different-peer";
    c.branchScopeRef.current = "different-peer:session";
    h.ready.resolve(); h.accepted.resolve(); await pending;
    assert.equal(h.commands.length, 0);
    assert.equal(h.completions.length, 0);
  });
}

test("initialization opens read-only observation before waiting for runtime readiness", async () => {
  const h = harness(), c = h.context, calls = [];
  Object.assign(c, { branchScope: "local:session", isNewSession: false, branchRef: ref({ state: {} }),
    sessionViewValidationPendingRef: ref(true), canWriteBranch: () => false,
    eventConnectionRef: ref({ maintain: sid => calls.push(["observe", sid]) }),
    sendAgentCommand: async (_sid, command) => { calls.push(["command", command.type]); await h.ready.promise; },
  });
  const pending = actual("sendAgentCommandR", c)("session", { type: "initialize_runtime" });
  assert.deepEqual(calls, [["observe", "session"], ["command", "initialize_runtime"]]);
  h.ready.resolve(); await pending;
});

test("a terminal event before the POST response cannot resurrect a completed prompt", async () => {
  const h = harness(), c = h.context;
  const pending = actual("handleSend", c)("quick completion");
  h.ready.resolve(); await h.posting.promise;
  actual("handleAgentEvent", c)({ type: "prompt_done", runId: "server-run", clientMessageId: "client-message" });
  assert.equal(c.rpcPromptPendingRef.current, false);
  h.accepted.resolve(); await pending;
  assert.equal(c.rpcPromptPendingRef.current, false);
  assert.equal(c.agentRunningRef.current, false);
  assert.equal(h.completions.length, 1);
});

test("an unbound terminal event before a lost POST cannot claim delivery or completion", async () => {
  const h = harness(), c = h.context;
  const pending = actual("handleSend", c)("uncertain with image", [{ data: "image-data", mimeType: "image/png" }]);
  h.ready.resolve(); await h.posting.promise;
  actual("handleAgentEvent", c)({ type: "prompt_done", runId: "old-run" });
  assert.equal(h.completions.length, 0);
  h.accepted.reject(new Error("transport lost"));
  await pending;
  assert.equal(h.unconfirmed.length, 1);
  assert.equal(h.restored.length, 0);
  assert.equal(h.messages.length, 1);
  assert.equal(h.commands.length, 1);
  assert.equal(h.completions.length, 0);
  c.remotePeerRef.current = "other-peer";
  assert.equal(c.confirmPromptDelivery("client-message"), null);
  assert.equal(h.unconfirmed.length, 1);
});

test("Stop fences preparation immediately and its late response cannot settle a newer external run", async () => {
  const h = harness(), c = h.context, abort = deferred();
  c.sendAgentCommandR = async (_sid, command) => { h.commands.push(command); await abort.promise; };
  const first = actual("handleSend", c)("cancelled input");
  const stopping = actual("handleAbort", c)();
  await actual("handleAbort", c)();
  assert.equal(c.rpcPromptPendingRef.current.stopping, true, "the pending initializer cannot dispatch after Stop");
  await c.reconcileAgentState("session");
  c.restoreLoadedRunState("session", { running: false });
  assert.equal(c.agentRunningRef.current, true, "a new local prompt waits until abort has returned");
  await actual("handleSend", c)("too early");
  actual("handleAgentEvent", c)({ type: "agent_start", runId: "new-external-run" });
  h.ready.resolve(); await first;
  abort.resolve(); await stopping;
  assert.deepEqual(h.commands.map(command => command.type), ["abort"]);
  assert.equal(c.sdkAgentActiveRef.current, true);
  assert.equal(c.agentRunningRef.current, true);
  assert.equal(h.completions.length, 0);
});

test("an ambiguous POST failure leaves local ownership without replaying the prompt", async () => {
  const h = harness(), c = h.context;
  c.sendAgentCommandR = async (_sid, command) => { h.commands.push(command); throw new Error("transport lost"); };
  const pending = actual("handleSend", c)("possibly accepted");
  h.ready.resolve(); await pending;
  assert.equal(h.commands.length, 1);
  assert.equal(c.rpcPromptPendingRef.current, true);
  assert.equal(h.messages.length, 1);
  assert.equal(h.restored.length, 0);
  assert.equal(h.completions.length, 0);
  assert.equal(h.unconfirmed.length, 1);
  await c.reconcileAgentState("session");
  assert.equal(c.agentRunningRef.current, false);
  assert.equal(h.completions.length, 0, "idle is not positive delivery evidence");
  actual("handleAgentEvent", c)({ type: "prompt_done", clientMessageId: "another-message" });
  assert.equal(h.unconfirmed.length, 1);
  assert.equal(h.completions.length, 0);
  actual("handleAgentEvent", c)({ type: "prompt_done", clientMessageId: "client-message" });
  assert.equal(h.unconfirmed.length, 0);
  assert.equal(h.completions.length, 1);
});

test("a definite prompt rejection restores the draft and releases local ownership", async () => {
  const h = harness(), c = h.context;
  c.sendAgentCommandR = async () => { throw Object.assign(new Error("not admitted"), { accepted: false }); };
  const pending = actual("handleSend", c)("rejected input");
  h.ready.resolve(); await pending;
  assert.equal(c.rpcPromptPendingRef.current, false);
  assert.equal(c.agentRunningRef.current, false);
  assert.equal(h.messages.length, 0);
  assert.deepEqual(h.restored, [["rejected input", undefined, "draft"]]);
  assert.equal(h.completions.length, 0);
});
