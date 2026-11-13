import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each test process owns its real activity persistence; parallel fixtures are not peer writers.
const originalActivityFile = process.env.PI_WEB_SESSION_ACTIVITY_FILE;
const activityRoot = await mkdtemp(join(tmpdir(), "reader-shutdown-activity-"));
process.env.PI_WEB_SESSION_ACTIVITY_FILE = join(activityRoot, "session-activity.json");
test.after(async () => {
  if (originalActivityFile === undefined) delete process.env.PI_WEB_SESSION_ACTIVITY_FILE;
  else process.env.PI_WEB_SESSION_ACTIVITY_FILE = originalActivityFile;
  await rm(activityRoot, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentSessionWrapper, listReaderRuntimeSafetySnapshot, getRpcSession, getRpcSessionByFile, getRpcSessionInfos,
  getWaitingForUserRpcSessionIds, getRunningRpcSessionIds, getWaitingForUserRequests } = await jiti.import("./rpc-manager.ts");

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("known terminal facts survive receipt disk failure and retry only persistence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reader-terminal-receipt-"));
  const previous = process.env.PI_WEB_CONTROL_RECEIPT_ROOT;
  process.env.PI_WEB_CONTROL_RECEIPT_ROOT = root;
  const { reserveControlReceipt, readControlReceipt, controlReceiptStorePath } = await jiti.import("./reader-control-receipts.ts");
  let commands = 0;
  const wrapper = new AgentSessionWrapper(makePromptInner(() => { commands++; return Promise.resolve(); }));
  wrapper.emit = () => {};
  t.after(async () => {
    for (const id of wrapper.controlReceiptBindings.keys()) wrapper.releaseControlReceiptBinding(id);
    wrapper.destroy();
    if (previous === undefined) delete process.env.PI_WEB_CONTROL_RECEIPT_ROOT; else process.env.PI_WEB_CONTROL_RECEIPT_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  });
  const until = async (predicate) => {
    for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 10)); }
    assert.fail("receipt persistence did not reach the observed boundary");
  };
  for (const handled of [true, false]) {
    const identity = { deviceId: "fixture", sessionId: "session-1", operation: handled ? "prompt" : "abort", idempotencyKey: `fixture-terminal-${handled}` };
    const reserved = await reserveControlReceipt({ ...identity, requestFingerprint: "fixture", cwd: "/tmp", bootId: "fixture" });
    wrapper.bindControlReceipt(reserved.receipt.receiptId, "prompt");
    const binding = wrapper.controlReceiptBindings.get(reserved.receipt.receiptId);
    binding.runId = "original-run"; binding.phase = "running"; wrapper.currentRunId = "original-run";
    const original = await readFile(controlReceiptStorePath(), "utf8");
    await writeFile(controlReceiptStorePath(), "invalid isolated fixture store");
    if (handled) wrapper.markControlReceiptAdmission({ readerControlReceiptId: reserved.receipt.receiptId }, "handled");
    else wrapper.settleBoundControlReceipts("aborted");
    await until(() => binding.terminalReceipt?.retryTimer !== undefined);
    assert.equal(wrapper.controlReceiptBindings.has(reserved.receipt.receiptId), true);
    assert.equal(wrapper.hasPendingControlReceiptPersistence(reserved.receipt.receiptId), true);
    // A later runtime event cannot replace the already observed terminal fact.
    wrapper.currentRunId = "later-run"; wrapper.settleBoundControlReceipts("unknown", "later teardown");
    await writeFile(controlReceiptStorePath(), original);
    await until(() => !wrapper.hasPendingControlReceiptPersistence(reserved.receipt.receiptId));
    const persisted = await readControlReceipt(identity);
    assert.equal(persisted.outcome, handled ? "completed" : "aborted");
    if (!handled) { assert.equal(persisted.runId, "original-run"); assert.equal(persisted.targetStopped, true); }
    assert.equal(commands, 0, "retry never sends or creates runtime work");
  }
});

test("managed CAS is rechecked after asynchronous admission and before SDK queue/start effects", async (t) => {
  let effects = 0;
  const inner = makePromptInner(() => { effects++; return Promise.resolve(); });
  inner.agent.steer = () => { effects++; };
  inner.agent.followUp = () => { effects++; };
  inner.agent.prompt = () => { effects++; return Promise.resolve(); };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => { for (const id of wrapper.controlReceiptBindings.keys()) wrapper.releaseControlReceiptBinding(id); wrapper.destroy(); });
  const expected = wrapper.getLiveRuntimeIdentity();
  wrapper.bindControlReceipt("fixture-atomic-cas", "prompt", expected);
  wrapper.waitForExtensionsBound = async () => { wrapper.liveEventCursor++; };
  await assert.rejects(wrapper.send({ type: "prompt", message: "fixture", readerControlReceiptId: "fixture-atomic-cas", readerControlExpectedBootId: expected.bootId, readerControlExpectedRevision: expected.revision }), { code: "revision_conflict" });
  assert.equal(effects, 0);
  for (const method of ["steer", "followUp", "prompt"]) {
    assert.throws(() => wrapper.controlReceiptAdmissionStorage.run("fixture-atomic-cas", () => inner.agent[method]({ role: "user", content: [] })), { code: "revision_conflict" });
    assert.equal(effects, 0);
  }
  await assert.rejects(wrapper.send({ type: "abort", readerControlReceiptId: "fixture-idle-abort" }), { code: "no_active_run" });
  assert.equal(wrapper.abortRequested, false);
});

test("destroy retains its registry owner until the actual terminal receipt has persisted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reader-destroy-receipt-"));
  const previousRoot = process.env.PI_WEB_CONTROL_RECEIPT_ROOT;
  const previousRegistry = globalThis.__piSessions;
  process.env.PI_WEB_CONTROL_RECEIPT_ROOT = root;
  const { reserveControlReceipt, readControlReceipt, controlReceiptStorePath } = await jiti.import("./reader-control-receipts.ts");
  const wrapper = new AgentSessionWrapper(makePromptInner(() => Promise.resolve()));
  wrapper.emit = () => {};
  const registry = new Map([[wrapper.sessionId, wrapper]]); globalThis.__piSessions = registry;
  let removed = 0; wrapper.onDestroy(() => { removed++; registry.delete(wrapper.sessionId); });
  t.after(async () => {
    for (const id of wrapper.controlReceiptBindings.keys()) wrapper.releaseControlReceiptBinding(id);
    wrapper.destroy(); globalThis.__piSessions = previousRegistry;
    if (previousRoot === undefined) delete process.env.PI_WEB_CONTROL_RECEIPT_ROOT; else process.env.PI_WEB_CONTROL_RECEIPT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  });
  const input = { deviceId: "fixture", sessionId: wrapper.sessionId, operation: "prompt", idempotencyKey: "destroy-terminal" };
  const reserved = await reserveControlReceipt({ ...input, requestFingerprint: "fixture", cwd: "/tmp", bootId: "fixture" });
  wrapper.bindControlReceipt(reserved.receipt.receiptId, "prompt");
  const original = await readFile(controlReceiptStorePath(), "utf8");
  await writeFile(controlReceiptStorePath(), "torn isolated fixture store");
  wrapper.destroy();
  await wrapper.waitUntilDisposed();
  assert.equal(wrapper.isAlive(), false);
  assert.equal(getRpcSession(wrapper.sessionId), wrapper);
  assert.equal(wrapper.hasPendingControlReceiptPersistence(reserved.receipt.receiptId), true);
  assert.equal(removed, 0);
  await writeFile(controlReceiptStorePath(), original);
  for (let i = 0; i < 200 && removed === 0; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(removed, 1);
  assert.equal(getRpcSession(wrapper.sessionId), undefined);
  assert.equal((await readControlReceipt(input)).outcome, "unknown");
});

test("rejected unadmitted controls release queue fences while admitted and pending facts remain bound", async (t) => {
  const inner = makePromptInner(() => Promise.resolve());
  inner.agent.steer = () => {}; inner.agent.followUp = () => {};
  inner.agent.steeringQueue = { messages: [] }; inner.agent.followUpQueue = { messages: [] };
  inner.clearQueue = () => ({ steering: [], followUp: [] });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => { for (const id of wrapper.controlReceiptBindings.keys()) wrapper.releaseControlReceiptBinding(id); wrapper.destroy(); });
  wrapper.bindControlReceipt("invalid-admission", "prompt");
  await assert.rejects(wrapper.send({ type: "prompt", message: "fixture", images: "invalid", readerControlReceiptId: "invalid-admission" }));
  assert.equal(wrapper.releaseRejectedControlReceiptBinding("invalid-admission"), true);
  const cleared = await wrapper.send({ type: "clear_queue", expectedQueueRevision: wrapper.getQueueIdentity().revision });
  assert.equal(cleared.clearedCounts.total, 0);
  wrapper.bindControlReceipt("admitted", "prompt");
  const admitted = wrapper.controlReceiptBindings.get("admitted"); admitted.phase = "queued";
  assert.equal(wrapper.releaseRejectedControlReceiptBinding("admitted", true), false);
  admitted.phase = "admitting"; admitted.terminalReceipt = { update: { outcome: "completed" }, writing: false, retryMs: 250 };
  assert.equal(wrapper.releaseRejectedControlReceiptBinding("admitted", true), false);
});

test("removed queue facts retry the original receipt after disk recovery without clearing again", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reader-cleared-receipt-"));
  const previous = process.env.PI_WEB_CONTROL_RECEIPT_ROOT; process.env.PI_WEB_CONTROL_RECEIPT_ROOT = root;
  const { reserveControlReceipt, readControlReceipt, controlReceiptStorePath } = await jiti.import("./reader-control-receipts.ts");
  const message = { role: "user", content: [{ type: "text", text: "isolated queued message" }] };
  const inner = makePromptInner(() => Promise.resolve());
  inner.agent.steeringQueue = { messages: [] }; inner.agent.followUpQueue = { messages: [message] };
  let clears = 0;
  inner.clearQueue = () => { clears++; inner.agent.followUpQueue.messages = []; return { steering: [], followUp: ["isolated queued message"] }; };
  const wrapper = new AgentSessionWrapper(inner); wrapper.emit = () => {};
  t.after(async () => { for (const id of wrapper.controlReceiptBindings.keys()) wrapper.releaseControlReceiptBinding(id); wrapper.destroy(); if (previous === undefined) delete process.env.PI_WEB_CONTROL_RECEIPT_ROOT; else process.env.PI_WEB_CONTROL_RECEIPT_ROOT = previous; await rm(root, { recursive: true, force: true }); });
  const identity = { deviceId: "fixture", sessionId: "session-1", operation: "follow_up", idempotencyKey: "queued-persistence-fixture" };
  const reserved = await reserveControlReceipt({ ...identity, requestFingerprint: "fixture", cwd: "/tmp", bootId: "fixture" });
  const id = reserved.receipt.receiptId;
  wrapper.bindControlReceipt(id, "follow_up");
  Object.assign(wrapper.controlReceiptBindings.get(id), { phase: "queued", queueKind: "followUp", queueMessage: "isolated queued message", sdkMessage: message });
  const original = await readFile(controlReceiptStorePath(), "utf8"); await writeFile(controlReceiptStorePath(), "invalid isolated fixture store");
  await assert.rejects(wrapper.send({ type: "clear_queue", expectedQueueRevision: wrapper.getQueueIdentity().revision }), /persistence is pending/);
  assert.equal(clears, 1); assert.equal(inner.agent.followUpQueue.messages.length, 0);
  assert.equal(wrapper.hasPendingControlReceiptPersistence(id), true);
  await writeFile(controlReceiptStorePath(), original);
  for (let i = 0; i < 200 && wrapper.hasPendingControlReceiptPersistence(id); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(wrapper.hasControlReceiptLifecycleBinding(id), false); assert.equal(clears, 1);
  const receipt = await readControlReceipt(identity);
  assert.equal(receipt.outcome, "aborted"); assert.equal(receipt.targetStopped, false); assert.equal(receipt.error.code, "queued_control_cleared");
});

test("retractFollowUp removes one accepted peer message by exact SDK queue identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reader-retract-follow-up-"));
  const messageId = "a".repeat(64);
  const peerMessage = {
    customType: "pi-web:session-peer",
    content: "queued follow-up",
    display: true,
    details: { source: "session-control", messageId },
  };
  const sdkMessage = { role: "custom", ...peerMessage };
  const inner = makePromptInner(() => Promise.resolve());
  inner.agent.steer = () => {};
  inner.agent.followUp = () => {};
  inner.agent.followUpQueue = { messages: [sdkMessage] };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.emit = () => {};
  const submission = {
    message: peerMessage,
    delivery: "follow_up",
    triggerTurn: true,
    sessionMessageRoot: root,
    phase: "accepted",
    sdkMessage,
    accepted: true,
    stopVersion: 0,
    resolveAccepted: () => {},
    rejectAccepted: () => {},
    acceptedPromise: Promise.resolve(),
  };
  wrapper.nativePeerSubmissions.set(messageId, submission);
  await writeFile(join(root, `${messageId}.json`), JSON.stringify({
    version: 1,
    id: messageId,
    createdAt: new Date().toISOString(),
    sender: { deviceId: "a", deviceName: "A", sessionId: "sender", sessionFile: null, title: null, project: "/tmp" },
    recipient: wrapper.sessionId,
    replyTo: "sender",
    kind: "request",
    operation: "follow_up",
    responseRequired: true,
    body: "queued follow-up",
    transport: "accepted",
  }));
  t.after(async () => { wrapper.destroy(); await rm(root, { recursive: true, force: true }); });

  const previousQueueRevision = wrapper.getQueueIdentity().revision;
  const result = await wrapper.retractFollowUp(messageId, { expectedQueueRevision: previousQueueRevision });
  assert.equal(result.retracted, true);
  assert.equal(result.receiverStatus, "cleared");
  assert.deepEqual(inner.agent.followUpQueue.messages, []);
  assert.equal(JSON.parse(await readFile(join(root, `${messageId}.json`), "utf8")).receiverStatus, "cleared");
  assert.notEqual(result.queueRevision, previousQueueRevision);
});

test("extension gate distinguishes observation from all five execution commands", () => {
  const wrapper = new AgentSessionWrapper(makePromptInner(() => Promise.resolve()));
  try {
    assert.equal(wrapper.shouldWaitForExtensions("get_state"), false);
    for (const type of ["prompt", "steer", "follow_up", "get_commands", "set_fast_mode"]) {
      assert.equal(wrapper.shouldWaitForExtensions(type), true);
    }
  } finally {
    wrapper.destroy();
  }
});

test("Stop All cancels the scheduler and late notifications while observing background exit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = await mkdtemp(join(tmpdir(), "reader-stop-all-"));
  const previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
  process.env.PI_SUBAGENTS_TEMP_ROOT = root;
  const statusFile = join(root, "async-subagent-runs", "owned-child", "status.json");
  await mkdir(join(root, "async-subagent-runs", "owned-child"), { recursive: true });
  await writeFile(statusFile, JSON.stringify({ sessionId: "session-1", state: "running", pid: process.pid }));
  let modelCalls = 0, generatedOutputs = 0, aborts = 0, stops = 0, releaseAbort;
  const aborting = new Promise(resolve => { releaseAbort = resolve; });
  const delivered = [], trace = [];
  const inner = makePromptInner(() => {
    modelCalls++;
    generatedOutputs++;
    trace.push({ type: "model_call", runId: "old-run" }, { type: "assistant_output", runId: "old-run" });
    return Promise.resolve();
  });
  inner.isStreaming = true;
  inner.abort = async () => {
    aborts++;
    trace.push({ type: "stop_request", runId: "old-run" });
    await aborting;
    inner.isStreaming = false;
    trace.push({ type: "run_terminal", runId: "old-run" });
  };
  inner.sendCustomMessage = async (_message, options) => {
    delivered.push(options);
    trace.push({ type: "late_child_notification", runId: "old-run" });
  };
  const wrapper = new AgentSessionWrapper(inner, undefined, undefined, { stopBackgroundRun: async id => {
    assert.equal(id, "owned-child"); stops++;
    await writeFile(statusFile, JSON.stringify({ sessionId: "session-1", state: "stopped", processTerminal: { state: "observed" } }));
  } });
  wrapper.emit = () => {};
  wrapper.unattendedEnabled = true;
  wrapper.schedulerState = { active: true, reason: "error", attempt: 2, nextDelayMs: 1000, nextRetryAt: Date.now()+1000, key: "turn", errorMessage: "503" };
  wrapper.schedulerTimer = setTimeout(() => { modelCalls++; }, 1000);
  trace.push({ type: "run_started", runId: "old-run", sessionId: wrapper.sessionId, submissionId: "old-submission" });
  await inner.prompt("assistant output before Stop");
  assert.equal(generatedOutputs, 1);
  t.after(async () => { releaseAbort?.(); await wrapper.shutdown(); if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT; else process.env.PI_SUBAGENTS_TEMP_ROOT = previous; await rm(root, { recursive: true, force: true }); });
  const first = wrapper.stopAllExecution(); assert.equal(wrapper.stopAllExecution(), first);
  await nextTurn();
  await assert.rejects(wrapper.send({ type: "prompt", message: "must not revive while stopping" }), /stopping/);
  releaseAbort();
  const result = await first;
  trace.push({ type: "stop_result", runId: "old-run", stopped: result.stopped });
  assert.equal(result.stopped, true); assert.equal(aborts, 1); assert.equal(stops, 1); assert.equal(modelCalls, 1);
  assert.equal(wrapper.getUnattendedEnabled(), false); assert.equal(wrapper.getSchedulerState(), null);
  assert.equal(wrapper.getExecutionState().active, false);
  const terminalIndex = trace.findIndex((event) => event.type === "stop_result");
  assert.deepEqual(trace.slice(0, terminalIndex + 1), [
    { type: "run_started", runId: "old-run", sessionId: wrapper.sessionId, submissionId: "old-submission" },
    { type: "model_call", runId: "old-run" },
    { type: "assistant_output", runId: "old-run" },
    { type: "stop_request", runId: "old-run" },
    { type: "run_terminal", runId: "old-run" },
    { type: "stop_result", runId: "old-run", stopped: true },
  ]);
  await inner.sendCustomMessage({ customType: "child_done", content: "late completion" }, { triggerTurn: true, deliverAs: "followUp" });
  assert.deepEqual(delivered, [{ triggerTurn: false, deliverAs: "nextTurn" }]);
  t.mock.timers.tick(60_000);
  await nextTurn();
  assert.equal(modelCalls, 1, "neither the old retry deadline nor a late child notification can start inference");
  assert.equal(generatedOutputs, 1, "the old run has no new assistant output after its stopped result");
  assert.deepEqual(trace.slice(terminalIndex + 1), [{ type: "late_child_notification", runId: "old-run" }]);
});

test("Stop All neither cancels Side Asks nor counts them as main-session execution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reader-stop-all-side-ask-"));
  const previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
  process.env.PI_SUBAGENTS_TEMP_ROOT = root;
  const inner = makePromptInner(() => Promise.resolve());
  inner.abort = async () => {};
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.emit = () => {};
  let closes = 0;
  const sideAsk = {
    running: true,
    hasActiveRun() { return this.running; },
    snapshots() { throw new Error("execution state must not project the Side Ask log"); },
    async whenIdle() {},
    close() { closes++; },
  };
  wrapper.sideAskRuntime = sideAsk;
  t.after(async () => { await wrapper.shutdown(); if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT; else process.env.PI_SUBAGENTS_TEMP_ROOT = previous; await rm(root, { recursive: true, force: true }); });
  assert.equal(wrapper.getExecutionState().active, false, "a running Side Ask is not main execution, so it shows no Stop button");
  assert.equal(wrapper.hasActiveSideAsk(), true, "archive still sees it");
  const result = await wrapper.stopAllExecution();
  assert.equal(result.stopped, true);
  assert.equal(closes, 0, "Stop All leaves the Side Ask running");
  assert.equal(wrapper.peekQuickAskRuntime(), sideAsk);
  assert.equal(wrapper.hasActiveSideAsk(), true);
  sideAsk.running = false;
  assert.equal(wrapper.hasActiveSideAsk(), false);
});

function makePromptInner(prompt) {
  return {
    sessionId: "session-1",
    isBashRunning: false,
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
    autoRetryEnabled: false,
    autoCompactionEnabled: false,
    systemPrompt: "",
    extensionRunner: {},
    sessionManager: { getCwd: () => "/tmp" },
    agent: { state: {} },
    getContextUsage: () => null,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    settingsManager: {
      setProjectTrusted: () => {},
      getDefaultThinkingLevel: () => "off",
      reload: async () => {},
      isProjectTrusted: () => true,
      flush: async () => {},
      getEnabledModels: () => [],
      getDefaultProvider: () => undefined,
      getDefaultModel: () => undefined,
      getProjectSettings: () => ({}),
      getGlobalSettings: () => ({}),
      setProjectPackages: () => {},
      setProjectSkillPaths: () => {},
      setProjectExtensionPaths: () => {},
    },
    prompt,
    dispose() {},
  };
}

test("model config refresh replaces the active model with refreshed metadata", async (t) => {
  const previousModel = { provider: "provider", id: "model", contextWindow: 256_000 };
  const refreshedModel = { provider: "provider", id: "model", contextWindow: 512_000 };
  let refreshCalls = 0;
  const inner = {
    isBashRunning: false,
    isStreaming: false,
    isCompacting: false,
    model: previousModel,
    modelRuntime: {
      refresh: async () => { refreshCalls += 1; },
      getModel: () => refreshedModel,
    },
    extensionRunner: {},
    sessionManager: { getCwd: () => "/tmp" },
    agent: { state: { model: previousModel } },
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());

  assert.equal(await wrapper.refreshModelConfig(), true);
  assert.equal(refreshCalls, 1);
  assert.equal(inner.agent.state.model, refreshedModel);
  assert.equal(inner.agent.state.model.contextWindow, 512_000);
});

const settleWithin = (promise, timeoutMs = 250) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`promise did not settle within ${timeoutMs}ms`)), timeoutMs);
  promise.then(
    (value) => {
      clearTimeout(timer);
      resolve(value);
    },
    (error) => {
      clearTimeout(timer);
      reject(error);
    },
  );
});

test("get_state observes a pending extension UI request and refreshes after binding", async (t) => {
  const inner = makePromptInner(() => Promise.resolve());
  inner.sessionId = "pending-extension-session";
  inner.agent.state.systemPrompt = "before extensions";
  inner.bindExtensions = async ({ uiContext }) => {
    const confirmed = await uiContext.confirm("Allow extension", "Enable extension resources?");
    if (confirmed) inner.agent.state.systemPrompt = "after extensions";
  };

  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  wrapper.beginExtensionBinding();
  await nextTurn();

  const request = events.find((event) => event.type === "extension_ui_request" && event.method === "confirm");
  assert.ok(request);
  assert.equal(wrapper.pendingUiRequests.size, 1);
  assert.equal(wrapper.pendingUiResponses.size, 1);

  const replay = [];
  const unsubscribe = wrapper.onEvent((event) => replay.push(event));
  unsubscribe();
  assert.deepEqual(replay.find((event) => event.id === request.id), { ...request, replay: true });

  const state = await settleWithin(wrapper.send({ type: "get_state" }));
  assert.equal(state.systemPrompt, "before extensions");
  assert.equal(
    state.runtimeInspection.systemPrompt.sha256,
    createHash("sha256").update(state.systemPrompt).digest("hex"),
  );
  assert.equal(wrapper.pendingUiRequests.size, 1);
  assert.equal(wrapper.pendingUiResponses.size, 1);

  const ready = wrapper.waitUntilReady();
  await wrapper.send({ type: "extension_ui_response", id: request.id, runtimeGeneration: request.runtimeGeneration, confirmed: true });
  await ready;
  const refreshed = await settleWithin(wrapper.send({ type: "get_state" }));
  assert.equal(refreshed.systemPrompt, "after extensions");
  assert.notEqual(refreshed.runtimeInspection.systemPrompt.sha256, state.runtimeInspection.systemPrompt.sha256);
  assert.equal(wrapper.pendingUiRequests.size, 0);
  assert.equal(wrapper.pendingUiResponses.size, 0);
});

test("extension-gated commands wait for binding while observation remains independent", async (t) => {
  let promptCalls = 0;
  const promptOptions = [];
  let commandReads = 0;
  let skillReads = 0;
  const inner = makePromptInner((_message, options) => {
    promptCalls += 1;
    promptOptions.push(options);
    options.preflightResult?.(true);
    return Promise.resolve();
  });
  inner.sessionId = "gated-extension-session";
  inner.extensionRunner = {
    getRegisteredCommands: () => {
      commandReads += 1;
      return [{ invocationName: "choose", description: "Choose", sourceInfo: undefined }];
    },
  };
  inner.promptTemplates = [];
  inner.resourceLoader = {
    getSkills: () => {
      skillReads += 1;
      return { skills: [] };
    },
  };
  inner.bindExtensions = async ({ uiContext }) => {
    await uiContext.confirm("Allow extension", "Enable extension resources?");
  };

  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  wrapper.beginExtensionBinding();
  await nextTurn();
  const request = events.find((event) => event.type === "extension_ui_request" && event.method === "confirm");
  assert.ok(request);

  let commandsSettled = false;
  const pending = [
    wrapper.send({ type: "prompt", message: "prompt" }),
    wrapper.send({ type: "steer", message: "steer" }),
    wrapper.send({ type: "follow_up", message: "follow" }),
    wrapper.send({ type: "get_commands" }).then((value) => {
      commandsSettled = true;
      return value;
    }),
  ];
  await nextTurn();
  assert.equal(promptCalls, 0);
  assert.equal(commandReads, 0);
  assert.equal(skillReads, 0);
  assert.equal(commandsSettled, false);

  await wrapper.send({ type: "extension_ui_response", id: request.id, runtimeGeneration: request.runtimeGeneration, confirmed: true });
  const [, , , commands] = await Promise.all(pending);
  assert.equal(promptCalls, 3);
  assert.ok(promptOptions.some((options) => options.streamingBehavior === "steer"));
  assert.ok(promptOptions.some((options) => options.streamingBehavior === "followUp"));
  assert.ok(promptOptions.some((options) => options.streamingBehavior === undefined));
  assert.ok(commandReads > 0);
  assert.equal(skillReads, 1);
  assert.equal(commands.commands[0].name, "choose");
});

test("failed extension binding leaves observation readable but rejects gated execution", async (t) => {
  let promptCalls = 0;
  const inner = makePromptInner(() => { promptCalls++; return Promise.resolve(); });
  inner.agent.state.systemPrompt = "available without extensions";
  inner.bindExtensions = async () => { throw new Error("extension bind failed"); };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  wrapper.beginExtensionBinding();
  await assert.rejects(wrapper.waitUntilReady(), /extension bind failed/);
  const state = await settleWithin(wrapper.send({ type: "get_state" }));
  assert.equal(state.systemPrompt, "available without extensions");
  await assert.rejects(wrapper.send({ type: "prompt", message: "blocked" }), /extension bind failed/);
  await assert.rejects(wrapper.send({ type: "get_commands" }), /extension bind failed/);
  assert.equal(promptCalls, 0);
});

test("failed extension binding closes its owned runtime and releases the writer", async (t) => {
  let promptCalls = 0;
  const inner = makePromptInner(() => {
    promptCalls += 1;
    return Promise.resolve();
  });
  inner.sessionId = "failed-extension-session";
  inner.agent.state.systemPrompt = "available without extensions";
  inner.bindExtensions = async () => {
    throw new Error("extension bind failed");
  };

  let releases = 0;
  const wrapper = new AgentSessionWrapper(inner, undefined, undefined, { runtimeOwnership: { release() { releases++; } } });
  t.after(() => wrapper.destroy());
  wrapper.beginExtensionBinding();
  await assert.rejects(wrapper.waitUntilReady(), /extension bind failed/);
  await wrapper.shutdown();
  await nextTurn();
  assert.equal(releases, 1);
  assert.equal(wrapper.isAlive(), false);
  await assert.rejects(wrapper.send({ type: "get_state" }), /Session is no longer available/);
  await assert.rejects(wrapper.send({ type: "prompt", message: "blocked" }), /Session is no longer available/);
  await assert.rejects(wrapper.send({ type: "get_commands" }), /Session is no longer available/);
  assert.equal(promptCalls, 0);
});

test("prompt commands wait for SDK preflight acceptance before acknowledging", async (t) => {
  let acceptPreflight;
  let finishPrompt;
  const inner = makePromptInner((_message, options) => new Promise((resolve) => {
    acceptPreflight = () => options.preflightResult(true);
    finishPrompt = resolve;
  }));
  inner.sessionManager.getEntries = () => [];
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.controlQueueCaptureRestore = () => {};
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));

  let acknowledged = false;
  const sending = wrapper.send({ type: "prompt", message: "hello", clientMessageId: "client-accepted" }).then(() => {
    acknowledged = true;
  });
  await nextTurn();

  assert.equal(acknowledged, false);
  assert.equal(wrapper.isRunning(), true);

  acceptPreflight();
  await sending;

  assert.equal(acknowledged, true);
  assert.equal(wrapper.isRunning(), true);
  assert.equal(events.some((event) => event.type === "prompt_done"), false);

  finishPrompt();
  await nextTurn();

  assert.equal(wrapper.isRunning(), false);
  assert.equal(events.filter((event) => event.type === "prompt_done").length, 1);
  assert.equal(events.find((event) => event.type === "prompt_done").clientMessageId, "client-accepted");
});

test("prompt commands reject when SDK preflight fails", async (t) => {
  const inner = makePromptInner((_message, options) => {
    options.preflightResult(false);
    return Promise.reject(new Error("Authentication failed"));
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));

  await assert.rejects(
    wrapper.send({ type: "prompt", message: "hello" }),
    /Authentication failed/,
  );

  assert.equal(wrapper.isRunning(), false);
  assert.equal(wrapper.getUnattendedConfigured(), false);
  assert.deepEqual(events, []);
});

test("accepted prompt failures still finish through the event stream", async (t) => {
  let failPrompt;
  const inner = makePromptInner((_message, options) => {
    options.preflightResult(true);
    return new Promise((_resolve, reject) => {
      failPrompt = () => reject(new Error("post-accept failure"));
    });
  });
  inner.sessionManager.getEntries = () => [];
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.controlQueueCaptureRestore = () => {};
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));

  await wrapper.send({ type: "prompt", message: "hello", clientMessageId: "client-failed" });
  failPrompt();
  await nextTurn();

  assert.deepEqual(events.map((event) => event.type), ["unattended_state", "prompt_error", "prompt_done"]);
  assert.equal(events.find((event) => event.type === "prompt_done").clientMessageId, "client-failed");
});

test("queued prompt commands forward their streaming behavior and acknowledge acceptance", async (t) => {
  let receivedOptions;
  const inner = makePromptInner((_message, options) => {
    receivedOptions = options;
    options.preflightResult(true);
    return Promise.resolve();
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));

  await wrapper.send({
    type: "prompt",
    message: "next",
    streamingBehavior: "followUp",
  });
  await nextTurn();

  assert.equal(receivedOptions.streamingBehavior, "followUp");
  assert.equal(receivedOptions.source, "rpc");
  assert.equal(wrapper.isRunning(), false);
  assert.deepEqual(events, [{ type: "unattended_state", enabled: true, configured: true, state: null }]);
});

test("prompt admission waits for the preceding preflight and keeps overlapping runs counted", async (t) => {
  let callCount = 0;
  let acceptFirst;
  let finishFirst;
  const inner = makePromptInner((_message, options) => {
    callCount += 1;
    if (callCount === 1) {
      return new Promise((resolve) => {
        acceptFirst = () => {
          inner.isStreaming = true;
          options.preflightResult(true);
        };
        finishFirst = () => {
          inner.isStreaming = false;
          resolve();
        };
      });
    }

    assert.equal(inner.isStreaming, true);
    options.preflightResult(true);
    return Promise.resolve();
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());

  const first = wrapper.send({ type: "prompt", message: "first" });
  await nextTurn();
  const queued = wrapper.send({
    type: "prompt",
    message: "queued",
    streamingBehavior: "followUp",
  });
  await nextTurn();

  assert.equal(callCount, 1);
  acceptFirst();
  await Promise.all([first, queued]);
  await nextTurn();

  assert.equal(callCount, 2);
  assert.equal((await wrapper.send({ type: "get_state" })).isPromptRunning, true);

  finishFirst();
  await nextTurn();

  assert.equal((await wrapper.send({ type: "get_state" })).isPromptRunning, false);
});

test("prompt admission continues after the preceding preflight rejects", async (t) => {
  let callCount = 0;
  let rejectFirst;
  const inner = makePromptInner((_message, options) => {
    callCount += 1;
    if (callCount === 1) {
      return new Promise((_resolve, reject) => {
        rejectFirst = () => {
          options.preflightResult(false);
          reject(new Error("first rejected"));
        };
      });
    }
    options.preflightResult(true);
    return Promise.resolve();
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());

  const firstRejected = assert.rejects(
    wrapper.send({ type: "prompt", message: "first" }),
    /first rejected/,
  );
  await nextTurn();
  const second = wrapper.send({ type: "prompt", message: "second" });
  await nextTurn();
  assert.equal(callCount, 1);

  rejectFirst();
  await Promise.all([firstRejected, second]);

  assert.equal(callCount, 2);
  assert.equal(wrapper.isRunning(), false);
});

test("a failing event listener cannot reject prompt completion", async (t) => {
  const originalConsoleError = console.error;
  t.after(() => {
    console.error = originalConsoleError;
  });
  console.error = () => {};

  const inner = makePromptInner((_message, options) => {
    options.preflightResult(true);
    return Promise.resolve();
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const delivered = [];
  wrapper.onEvent(() => {
    throw new Error("listener failed");
  });
  wrapper.onEvent((event) => delivered.push(event.type));

  await wrapper.send({ type: "prompt", message: "hello" });
  await nextTurn();

  assert.deepEqual(delivered, ["unattended_state", "prompt_done"]);
  assert.equal(wrapper.isRunning(), false);
});

test("session shutdown notifies extensions before disposing the SDK session", async () => {
  const calls = [];
  const inner = {
    isBashRunning: false,
    agent: { state: {} },
    extensionRunner: {
      async emit(event) {
        calls.push(["emit", event]);
      },
    },
    dispose() {
      calls.push(["dispose"]);
    },
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onDestroy(() => calls.push(["destroy"]));

  await Promise.all([wrapper.shutdown(), wrapper.shutdown()]);

  assert.deepEqual(calls, [
    ["emit", { type: "session_shutdown", reason: "quit" }],
    ["dispose"],
    ["destroy"],
  ]);
  assert.equal(wrapper.isAlive(), false);
});

test("session shutdown still disposes the SDK session when an extension fails", async () => {
  const calls = [];
  const inner = {
    isBashRunning: false,
    agent: { state: {} },
    extensionRunner: {
      async emit() {
        calls.push("emit");
        throw new Error("shutdown hook failed");
      },
    },
    dispose() {
      calls.push("dispose");
    },
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onDestroy(() => calls.push("destroy"));

  await assert.rejects(wrapper.shutdown(), /shutdown hook failed/);

  assert.deepEqual(calls, ["emit", "dispose", "destroy"]);
  assert.equal(wrapper.isAlive(), false);
});

test("direct destruction disposes the SDK session before unregistering the wrapper", async () => {
  const calls = [];
  const inner = {
    isBashRunning: false,
    agent: { state: {} },
    extensionRunner: {},
    dispose() {
      calls.push("dispose");
    },
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onDestroy(() => calls.push("destroy"));

  wrapper.destroy();
  wrapper.destroy();
  await wrapper.waitUntilDisposed();

  assert.deepEqual(calls, ["dispose", "destroy"]);
  assert.equal(wrapper.isAlive(), false);
});

test("stuck abort force-disposes the SDK session", async () => {
  const calls = [];
  const inner = {
    sessionId: "stuck-session",
    isBashRunning: false,
    isStreaming: true,
    isCompacting: false,
    agent: { state: {} },
    extensionRunner: {},
    abort() {
      return new Promise(() => {});
    },
    dispose() {
      calls.push("dispose");
    },
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onDestroy(() => calls.push("destroy"));

  await wrapper.send({ type: "abort" });

  assert.deepEqual(calls, ["dispose", "destroy"]);
  assert.equal(wrapper.isAlive(), false);
});
test("restored unattended retry waits for manual confirmation", (t) => {
  const inner = makePromptInner(() => Promise.resolve());
  inner.sessionId = "restart-session";
  inner.sessionFile = undefined;
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());

  const schedulerState = {
    active: true,
    reason: "error",
    attempt: 3,
    nextDelayMs: 120_000,
    nextRetryAt: Date.now() + 120_000,
    errorMessage: "503 Service Unavailable",
    key: "user:turn-1:继续",
  };
  wrapper.restoreUnattendedState({
    enabled: true,
    schedulerState,
    updatedAt: new Date().toISOString(),
  });

  assert.equal(wrapper.getUnattendedEnabled(), true);
  assert.deepEqual(wrapper.getSchedulerState(), {
    ...schedulerState,
    active: false,
    reason: "restart",
    nextDelayMs: null,
    nextRetryAt: null,
  });
  assert.equal(wrapper.isRunning(), false);
});

test("direct bash commands use sanitized project operations with current shell settings", async (t) => {
  let received;
  let shellPath = "/bin/bash";
  const inner = {
    isBashRunning: false,
    isStreaming: false,
    isCompacting: false,
    extensionRunner: {},
    settingsManager: {
      getShellPath: () => shellPath,
    },
    sessionManager: {
      getCwd: () => process.cwd(),
      getSessionFile: () => undefined,
    },
    agent: { state: {} },
    getContextUsage: () => null,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    executeBash: async (command, _onChunk, options) => {
      received = { command, options };
      return { output: "", exitCode: 0 };
    },
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());

  shellPath = "/custom/bash";
  await wrapper.send({
    type: "bash",
    command: "echo ready",
    excludeFromContext: true,
  });

  assert.equal(received.command, "echo ready");
  assert.equal(received.options.excludeFromContext, true);
  assert.equal(typeof received.options.operations.exec, "function");
});

// Regression cases introduced by upstream v0.10.0, retained with Reader cases.

const { registerSessionLivenessProvider } = await jiti.import("./session-liveness.ts");


test("get_state observes the live prompt while extension binding is pending", async (t) => {
  let finishBinding;
  const inner = makePromptInner(() => Promise.resolve());
  inner.systemPrompt = "before extensions";
  inner.bindExtensions = () => new Promise((resolve) => {
    finishBinding = () => {
      // Binding extensions can rewrite the prompt, so get_state must read it afterwards.
      inner.systemPrompt = "after extensions";
      resolve();
    };
  });

  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  wrapper.beginExtensionBinding();

  let settled = false;
  const statePromise = wrapper.send({ type: "get_state" }).then((state) => {
    settled = true;
    return state;
  });
  await nextTurn();

  assert.equal(settled, true);
  assert.equal((await statePromise).systemPrompt, "before extensions");
  finishBinding();
  await wrapper.waitUntilReady();
  const state = await wrapper.send({ type: "get_state" });

  assert.equal(state.systemPrompt, "after extensions");
});


test("lightweight get_state omits prompt inspection and estimation but retains runtime and queue state", async (t) => {
  const inner = makePromptInner(() => Promise.resolve());
  inner.systemPrompt = "visible system prompt";
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const full = await wrapper.send({ type: "get_state" });
  assert.equal(full.systemPrompt, "visible system prompt");
  assert.ok(full.runtimeInspection);
  wrapper.skillRuntimeTracker.snapshot = () => { throw new Error("light state inspected skills"); };
  wrapper.estimateSystemPromptCost = () => { throw new Error("light state estimated prompt cost"); };
  const light = await wrapper.send({ type: "get_state", systemPrompt: false });
  assert.equal(Object.hasOwn(light, "systemPrompt"), false);
  assert.equal(Object.hasOwn(light, "runtimeInspection"), false);
  for (const key of ["isStreaming", "isPromptRunning", "isBashRunning", "isCompacting", "queueCounts", "queueRevision", "queuedMessages", "contextUsage", "model", "autoCompactionEnabled"]) {
    assert.deepEqual(light[key], full[key], key);
  }
});

test("get_state reports the prompt of a session that has not run anything yet", async (t) => {
  // Pi 0.86 replays agent.state.systemPrompt from the transcript, so it is empty until the
  // first run persists a system message. Reporting that empty string made the System panel
  // claim "the prompt is empty (tools are disabled)" on every brand-new session.
  const inner = makePromptInner(() => Promise.resolve());
  Object.defineProperty(inner.agent.state, "systemPrompt", {
    get: () => "",
    enumerable: true,
  });
  inner.systemPrompt = "Pi rendered prompt";

  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());

  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.systemPrompt, "Pi rendered prompt");
});


test("get_state keeps chat-only prompts empty when the live SDK prompt is rendered", async (t) => {
  const inner = makePromptInner(() => Promise.resolve());
  inner.systemPrompt = "Pi rendered prompt";
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  wrapper.setForceEmptySystemPrompt(true);

  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.systemPrompt, "");
});


test("get_state keeps reporting the replayed prompt once the transcript has one", async (t) => {
  // After a run the session getter falls back to the base options, which no longer carry the
  // sections a before_agent_start handler changed for that run; the transcript still does.
  const inner = makePromptInner(() => Promise.resolve());
  Object.defineProperty(inner.agent.state, "systemPrompt", {
    get: () => "base prompt\n\nextension section",
    enumerable: true,
  });
  inner.systemPrompt = "base prompt";

  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());

  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.systemPrompt, "base prompt\n\nextension section");
});


test("accepted agent runs remain active until prompt completion settles", async (t) => {
  let finishPrompt;
  let sdkListener;
  const events = [];
  const inner = makePromptInner((_message, options) => new Promise((resolve) => {
    inner.isStreaming = true;
    options.preflightResult("started");
    finishPrompt = () => {
      inner.isStreaming = false;
      resolve();
    };
  }));
  inner.subscribe = (listener) => {
    sdkListener = listener;
    return () => {};
  };

  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  wrapper.start();
  wrapper.onEvent((event) => events.push(event.type));

  await wrapper.send({ type: "prompt", message: "hello" });
  sdkListener({ type: "agent_start" });
  sdkListener({ type: "agent_end" });
  sdkListener({ type: "agent_end" });
  inner.isStreaming = false;
  sdkListener({ type: "agent_settled" });
  assert.equal(wrapper.isRunning(), true);

  finishPrompt();
  await nextTurn();
  assert.equal(wrapper.isRunning(), false);
  assert.deepEqual(events, ["unattended_state", "agent_start", "agent_end", "agent_end", "agent_settled", "prompt_done"]);

  sdkListener({ type: "agent_settled" });
  assert.equal(wrapper.isRunning(), false);
});


// The SDK emits agent_settled before the prompt() promise resolves, so the
// prompt lifecycle (prompt_done / prompt_error) always trails the settled run.
// Clients discard a terminal event that lacks the run id they are tracking, so
// those trailing events must keep carrying it, while control receipts (steer /
// abort) must stop seeing the settled run as active.
for (const outcome of ["resolves", "rejects"]) {
  test(`prompt lifecycle after agent_settled keeps the settled run id when the prompt ${outcome}`, async (t) => {
    let finishPrompt;
    let sdkListener;
    const events = [];
    const inner = makePromptInner((_message, options) => new Promise((resolve, reject) => {
      inner.isStreaming = true;
      options.preflightResult("started");
      finishPrompt = () => {
        inner.isStreaming = false;
        if (outcome === "rejects") reject(new Error("post-settle failure"));
        else resolve();
      };
    }));
    inner.subscribe = (listener) => {
      sdkListener = listener;
      return () => {};
    };

    const wrapper = new AgentSessionWrapper(inner);
    t.after(() => wrapper.destroy());
    wrapper.start();
    wrapper.onEvent((event) => events.push(event));

    await wrapper.send({ type: "prompt", message: "hello" });
    sdkListener({ type: "agent_start" });
    const started = events.find((event) => event.type === "agent_start");
    assert.equal(typeof started.runId, "string");
    assert.equal(wrapper.getActiveControlRunId(), started.runId);

    sdkListener({ type: "agent_end" });
    inner.isStreaming = false;
    sdkListener({ type: "agent_settled" });
    assert.equal(events.find((event) => event.type === "agent_settled").runId, started.runId);
    assert.equal(wrapper.getActiveControlRunId(), null, "a control receipt must not bind to a settled run");

    finishPrompt();
    await nextTurn();
    const trailing = events.filter((event) => event.type === "prompt_error" || event.type === "prompt_done");
    assert.deepEqual(trailing.map((event) => event.type), outcome === "rejects" ? ["prompt_error", "prompt_done"] : ["prompt_done"]);
    for (const event of trailing) assert.equal(event.runId, started.runId, `${event.type} carries the settled run id`);
    assert.equal(wrapper.getActiveControlRunId(), null);

    // Nothing from the settled run leaks into the next one.
    sdkListener({ type: "agent_start" });
    const next = events.filter((event) => event.type === "agent_start")[1];
    assert.equal(typeof next.runId, "string");
    assert.notEqual(next.runId, started.runId);
  });
}

test("a prompt that never ran an agent is not stamped with the previous run's id", async (t) => {
  let sdkListener;
  let finishFirst;
  const events = [];
  const inner = makePromptInner((message, options) => {
    options.preflightResult("started");
    if (message === "first") return new Promise((resolve) => { finishFirst = resolve; });
    return Promise.resolve();
  });
  inner.subscribe = (listener) => {
    sdkListener = listener;
    return () => {};
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  wrapper.start();
  wrapper.onEvent((event) => events.push(event));

  await wrapper.send({ type: "prompt", message: "first" });
  sdkListener({ type: "agent_start" });
  sdkListener({ type: "agent_settled" });
  finishFirst();
  await nextTurn();
  await wrapper.send({ type: "prompt", message: "second" });
  await nextTurn();

  const done = events.filter((event) => event.type === "prompt_done");
  assert.equal(done.length, 2);
  assert.equal(typeof done[0].runId, "string", "the run's own prompt_done is stamped");
  assert.equal(done[1].runId, undefined, "the stamp is cleared once the prompt lifecycle ends");
});


test("extension-injected runs stay active until agent_settled", (t) => {
  let sdkListener;
  const events = [];
  const inner = makePromptInner(() => Promise.resolve());
  inner.subscribe = (listener) => {
    sdkListener = listener;
    return () => {};
  };

  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  wrapper.start();
  wrapper.onEvent((event) => events.push(event.type));

  inner.isStreaming = true;
  sdkListener({ type: "agent_start" });
  sdkListener({ type: "agent_end" });
  assert.equal(wrapper.isRunning(), true);

  inner.isStreaming = false;
  sdkListener({ type: "agent_settled" });
  assert.equal(wrapper.isRunning(), false);
  assert.deepEqual(events, ["agent_start", "agent_end", "agent_settled"]);
});


test("new event listeners receive the latest active tool update", (t) => {
  let sdkListener;
  const inner = makePromptInner(() => Promise.resolve());
  inner.subscribe = (listener) => {
    sdkListener = listener;
    return () => {};
  };

  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  wrapper.start();

  sdkListener({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash" });
  sdkListener({ type: "tool_execution_update", toolCallId: "tool-1", toolName: "bash", partialResult: { content: [{ type: "text", text: "one" }] } });
  const latest = { type: "tool_execution_update", toolCallId: "tool-1", toolName: "bash", partialResult: { content: [{ type: "text", text: "one\ntwo" }] } };
  sdkListener(latest);

  const replayed = [];
  const unsubscribe = wrapper.onEvent((event) => replayed.push(event));
  assert.deepEqual(replayed, [latest]);

  unsubscribe();
  sdkListener({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash" });
  const afterEnd = [];
  wrapper.onEvent((event) => afterEnd.push(event));
  assert.deepEqual(afterEnd, []);
});


function startToolEventWrapper(t) {
  let sdkListener;
  const inner = makePromptInner(() => Promise.resolve());
  inner.subscribe = (listener) => {
    sdkListener = listener;
    return () => {};
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  wrapper.start();
  const replay = () => {
    const replayed = [];
    wrapper.onEvent((event) => replayed.push(event))();
    return replayed;
  };
  return { emit: (event) => sdkListener(event), replay };
}


test("does not replay the nested calls of a running codemode script", (t) => {
  const { emit, replay } = startToolEventWrapper(t);
  const parentStart = { type: "tool_execution_start", toolCallId: "call-1", toolName: "codemode", args: { code: "" } };
  emit(parentStart);
  emit({ type: "tool_execution_start", toolCallId: "call-1/1", toolName: "read", args: {}, parentToolCallId: "call-1" });
  emit({ type: "tool_execution_update", toolCallId: "call-1/1", toolName: "read", args: {}, partialResult: {}, parentToolCallId: "call-1" });
  const snapshot = {
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "codemode",
    partialResult: { content: [], details: { calls: [{ id: "call-1/?", name: "read", status: "running" }] } },
  };
  emit(snapshot);
  emit({ type: "tool_execution_start", toolCallId: "call-1/2", toolName: "read", args: {}, parentToolCallId: "call-1" });

  assert.deepEqual(replay(), [snapshot]);
});


test("a tool call's end also forgets calls recorded under its id", (t) => {
  const { emit, replay } = startToolEventWrapper(t);
  const other = { type: "tool_execution_start", toolCallId: "call-2", toolName: "bash", args: {} };
  emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "codemode", args: {} });
  // A nested call that reached the wrapper without its parent id.
  emit({ type: "tool_execution_start", toolCallId: "call-1/1", toolName: "read", args: {} });
  emit({ type: "tool_execution_start", toolCallId: "call-1/1/1", toolName: "read", args: {} });
  emit(other);
  emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "codemode", isError: false });

  assert.deepEqual(replay(), [other]);
});


test("tolerates a nested end after its parent ended", (t) => {
  const { emit, replay } = startToolEventWrapper(t);
  const other = { type: "tool_execution_start", toolCallId: "call-2", toolName: "bash", args: {} };
  emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "codemode", args: {} });
  emit(other);
  emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "codemode", isError: false });
  emit({ type: "tool_execution_end", toolCallId: "call-1/1", toolName: "read", isError: true, parentToolCallId: "call-1" });

  assert.deepEqual(replay(), [other]);
});


test("replays no tool call once the run has ended", (t) => {
  const { emit, replay } = startToolEventWrapper(t);
  emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: {} });
  emit({ type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", partialResult: {} });
  emit({ type: "agent_end", messages: [] });

  assert.deepEqual(replay(), []);
});


test("suppressed sessions do not emit completion notifications", (t) => {
  let sdkListener;
  const events = [];
  const inner = makePromptInner(() => Promise.resolve());
  inner.subscribe = (listener) => {
    sdkListener = listener;
    return () => {};
  };

  const wrapper = new AgentSessionWrapper(inner);
  wrapper.setSuppressCompletionNotifications(true);
  t.after(() => wrapper.destroy());
  wrapper.start();
  wrapper.onEvent((event) => events.push(event.type));

  inner.isStreaming = true;
  sdkListener({ type: "agent_start" });
  inner.isStreaming = false;
  sdkListener({ type: "agent_settled" });
  assert.equal(wrapper.hasSuppressedCompletionNotifications(), true);
  assert.deepEqual(events, ["agent_start", "agent_settled"]);
});


test("an exact system prompt leaves the SDK prompt state untouched", async (t) => {
  // Since Pi 0.86 the SDK prompt state is a getter replayed from the transcript.
  // The exact prompt reaches the model through before_agent_start instead, so
  // the wrapper must never assign it, even around prompt preflight.
  const inner = makePromptInner((_message, options) => {
    options.preflightResult("started");
    return Promise.resolve();
  });
  Object.defineProperty(inner.agent.state, "systemPrompt", {
    get: () => "Pi structured sections",
    enumerable: true,
  });
  inner.systemPrompt = "context prompt";
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());

  await wrapper.send({ type: "prompt", message: "hello" });
  await nextTurn();

  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.systemPrompt, "Pi structured sections");
  assert.equal(inner.agent.state.systemPrompt, "Pi structured sections");
  assert.equal(inner.agent.prepareNextTurnWithContext, undefined);
});


test("destroy notifies event listeners so attached SSE streams can close", () => {
  const inner = {
    isBashRunning: false,
    agent: { state: {} },
    extensionRunner: {},
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  const events = [];
  wrapper.onEvent((event) => events.push(event.type));
  wrapper.destroy();
  assert.deepEqual(events, ["session_shutdown"]);
});


test("a listener that unsubscribes while handling an event does not hide it from the next one", () => {
  const inner = {
    isBashRunning: false,
    agent: { state: {} },
    extensionRunner: {},
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  const received = [];
  const stopFirst = wrapper.onEvent((event) => {
    received.push(["first", event.type]);
    stopFirst();
  });
  wrapper.onEvent((event) => received.push(["second", event.type]));
  wrapper.onEvent((event) => received.push(["third", event.type]));

  wrapper.destroy();

  assert.deepEqual(received, [
    ["first", "session_shutdown"],
    ["second", "session_shutdown"],
    ["third", "session_shutdown"],
  ]);
});


test("direct destruction emits session_shutdown before dispose when extensions are present", async () => {
  const calls = [];
  const inner = {
    isBashRunning: false,
    agent: { state: {} },
    extensionRunner: {
      async emit(event) {
        calls.push(["emit", event]);
      },
    },
    dispose() {
      calls.push(["dispose"]);
    },
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onDestroy(() => calls.push(["destroy"]));

  wrapper.destroy();
  wrapper.destroy();

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [
    ["emit", { type: "session_shutdown", reason: "quit" }],
    ["dispose"],
    ["destroy"],
  ]);
  assert.equal(wrapper.isAlive(), false);
});


test("direct destruction still disposes when session_shutdown throws synchronously", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls = [];
  const inner = {
    isBashRunning: false,
    agent: { state: {} },
    extensionRunner: {
      emit() {
        throw new Error("shutdown hook failed");
      },
    },
    dispose() {
      calls.push("dispose");
    },
  };
  const wrapper = new AgentSessionWrapper(inner);

  wrapper.destroy();
  await nextTurn();

  assert.deepEqual(calls, ["dispose"]);
  assert.equal(wrapper.isAlive(), false);
});


test("idle timer preserves extension-owned session work until it becomes inactive", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  let active = true;
  const inner = makePromptInner(() => Promise.resolve());
  inner.subscribe = () => () => {};
  inner.extensionRunner = {
    async emit(event) {
      calls.push(["emit", event]);
    },
  };
  inner.dispose = () => calls.push(["dispose"]);
  const release = registerSessionLivenessProvider({
    name: "test-extension",
    sessionId: "session-1",
    isActive: () => active,
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(release);
  t.after(() => wrapper.destroy());
  wrapper.start();

  t.mock.timers.tick(10 * 60 * 1000);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);
  assert.deepEqual(calls, []);

  active = false;
  t.mock.timers.tick(10 * 60 * 1000);
  await nextTurn();
  assert.equal(wrapper.isAlive(), false);
  assert.deepEqual(calls, [
    ["emit", { type: "session_shutdown", reason: "quit" }],
    ["dispose"],
  ]);
});


test("idle timer preserves active work but reaps a run stuck after Stop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  let resolveAbort;
  const aborted = new Promise(resolve => { resolveAbort = resolve; });
  const inner = makePromptInner(() => Promise.resolve());
  inner.isStreaming = true;
  inner.subscribe = () => () => {};
  inner.abort = () => { calls.push(["abort"]); return aborted; };
  inner.extensionRunner = {
    async emit(event) {
      calls.push(["emit", event]);
    },
  };
  inner.dispose = () => calls.push(["dispose"]);
  const release = registerSessionLivenessProvider({
    name: "test-extension",
    sessionId: "session-1",
    isActive: () => true,
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(release);
  t.after(() => wrapper.destroy());
  wrapper.start();

  t.mock.timers.tick(10 * 60 * 1000);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);
  assert.deepEqual(calls, []);

  const stopping = wrapper.send({ type: "abort" });
  await nextTurn();
  await wrapper.send({ type: "get_state" });
  t.mock.timers.tick(10 * 60 * 1000);
  await nextTurn();

  assert.equal(wrapper.isAlive(), false);
  assert.deepEqual(calls, [["abort"], ["emit", { type: "session_shutdown", reason: "quit" }], ["dispose"]]);
  inner.isStreaming = false;
  resolveAbort();
  await stopping;
});


test("queue revision follows queue state independently of live event cursor and runtime identity", (t) => {
  const inner = makePromptInner(() => Promise.resolve());
  const steering = ["steer-one"];
  const followUp = ["follow-one"];
  inner.getSteeringMessages = () => steering;
  inner.getFollowUpMessages = () => followUp;
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const original = wrapper.getQueueIdentity();
  assert.deepEqual(original.counts, { steering: 1, followUp: 1, total: 2 });
  wrapper.liveEventCursor += 10;
  assert.deepEqual(wrapper.getQueueIdentity(), original, "assistant/tool traffic must not invalidate queue CAS");
  steering.push("steer-two");
  assert.notEqual(wrapper.getQueueIdentity().revision, original.revision, "unobserved SDK queue content changes must invalidate CAS");
  const other = new AgentSessionWrapper(inner);
  t.after(() => other.destroy());
  assert.notEqual(other.getQueueIdentity().revision, wrapper.getQueueIdentity().revision, "queue identity is bound to its runtime boot");
});

test("clear_queue rejects a stale CAS before clearing and does not bind its own receipt to queued runs", async (t) => {
  const inner = makePromptInner(() => Promise.resolve());
  const followUp = ["keep-me"];
  inner.getFollowUpMessages = () => followUp;
  let clearCalls = 0;
  inner.clearQueue = () => { clearCalls += 1; return { steering: [], followUp: followUp.splice(0) }; };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const original = wrapper.getQueueIdentity();
  followUp.push("newer-message");
  wrapper.bindControlReceipt("clear-control", "clear_queue");
  assert.equal(wrapper.controlReceiptBindings.has("clear-control"), false);
  await assert.rejects(wrapper.send({ type: "clear_queue", expectedQueueRevision: original.revision }), (error) => error.code === "queue_revision_conflict");
  assert.equal(clearCalls, 0);
  assert.deepEqual(followUp, ["keep-me", "newer-message"]);
});

test("clear_queue clears SDK and compaction queues once without aborting the active run", async (t) => {
  const inner = makePromptInner(() => Promise.resolve());
  let followUp = ["sdk-follow-up"];
  inner.getFollowUpMessages = () => followUp;
  inner.isStreaming = true;
  let clearCalls = 0;
  inner.clearQueue = () => { clearCalls += 1; const cleared = followUp; followUp = []; return { steering: [], followUp: cleared }; };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  // Keep this runtime unit test in memory; route and receipt tests separately
  // cover persistence. No user event ledger is touched.
  const events = [];
  wrapper.emit = (event) => { events.push(event); };
  wrapper.deferredCompactionPrompts.push({ kind: "prompt", message: "deferred-steer", streamingBehavior: "steer" });
  const original = wrapper.getQueueIdentity();
  const cleared = await wrapper.send({ type: "clear_queue", expectedQueueRevision: original.revision });
  assert.equal(clearCalls, 1);
  assert.deepEqual(cleared.steering, ["deferred-steer"]);
  assert.deepEqual(cleared.followUp, ["sdk-follow-up"]);
  assert.deepEqual(cleared.clearedCounts, { steering: 1, followUp: 1, total: 2 });
  assert.equal(cleared.previousQueueRevision, original.revision);
  assert.notEqual(cleared.queueRevision, original.revision);
  assert.equal(wrapper.getQueueIdentity().counts.total, 0);
  assert.equal(inner.isStreaming, true, "clearing pending messages must not abort the running prompt");
  assert.equal(events.filter((event) => event.type === "queue_update").length, 1);
  await assert.rejects(wrapper.send({ type: "clear_queue", expectedQueueRevision: original.revision }), (error) => error.code === "queue_revision_conflict");
  assert.equal(clearCalls, 1);
});


test("clear_queue blocks a managed prompt awaiting admission instead of claiming it was cleared", async (t) => {
  const inner = makePromptInner(() => Promise.resolve());
  let clearCalls = 0;
  inner.clearQueue = () => { clearCalls += 1; return { steering: [], followUp: [] }; };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => { wrapper.controlReceiptBindings.clear(); wrapper.destroy(); });
  wrapper.bindControlReceipt("pending-admission", "prompt");
  const queue = wrapper.getQueueIdentity();
  await assert.rejects(wrapper.send({ type: "clear_queue", expectedQueueRevision: queue.revision }), (error) => error.code === "queue_admission_pending");
  assert.equal(clearCalls, 0);
  assert.equal(wrapper.controlReceiptBindings.get("pending-admission").phase, "admitting");
});

test("managed steering distinguishes its queued and consumed lifecycle within the current run", (t) => {
  const inner = makePromptInner(() => Promise.resolve());
  inner.getSteeringMessages = () => ["admitted-steer"];
  inner.agent.steer = () => {};
  inner.agent.followUp = () => {};
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => { wrapper.controlReceiptBindings.clear(); wrapper.destroy(); });
  // Bind before a run starts so this fixture does not touch durable receipts.
  wrapper.bindControlReceipt("steer-receipt", "steer");
  wrapper.currentRunId = "active-run";
  const message = { role: "user", content: [{ type: "text", text: "admitted-steer" }] };
  wrapper.controlReceiptAdmissionStorage.run("steer-receipt", () => inner.agent.steer(message));
  wrapper.markControlReceiptAdmission({ readerControlReceiptId: "steer-receipt", type: "steer" }, "queued");
  assert.equal(wrapper.controlReceiptBindings.get("steer-receipt").phase, "queued");
  assert.equal(wrapper.controlReceiptBindings.get("steer-receipt").queueMessage, "admitted-steer");
  wrapper.markQueuedControlConsumed({ ...message });
  assert.equal(wrapper.controlReceiptBindings.get("steer-receipt").phase, "queued", "equal text is not message identity");
  wrapper.markQueuedControlConsumed(message);
  wrapper.markControlReceiptAdmission({ readerControlReceiptId: "steer-receipt", type: "steer" }, "queued");
  assert.equal(wrapper.controlReceiptBindings.get("steer-receipt").phase, "running");
  assert.equal(wrapper.controlReceiptBindings.get("steer-receipt").runId, "active-run");
});

test("runtime safety inventory includes every registry entry without initializing or reading session storage", (t) => {
  const previousRegistry = globalThis.__piSessions;
  const previousStarts = globalThis.__piStartLocks;
  t.after(() => { globalThis.__piSessions = previousRegistry; globalThis.__piStartLocks = previousStarts; });
  delete globalThis.__piSessions;
  const empty = listReaderRuntimeSafetySnapshot();
  assert.equal(empty.coverage.complete, true);
  assert.equal(empty.coverage.runtimeCount, 0);
  assert.equal(globalThis.__piSessions, undefined, "safe inventory must not initialize registry/listeners");
  const signals = ["exit", "SIGINT", "SIGTERM"].map(name => process.listenerCount(name));
  assert.equal(getRpcSession("absent"), undefined);
  assert.equal(getRpcSessionByFile("/tmp/absent"), undefined);
  assert.deepEqual(getRpcSessionInfos(), []);
  assert.deepEqual(getWaitingForUserRpcSessionIds(), []);
  assert.deepEqual(getRunningRpcSessionIds(), []);
  assert.deepEqual(getWaitingForUserRequests(), []);
  assert.equal(globalThis.__piSessions, undefined);
  assert.deepEqual(["exit", "SIGINT", "SIGTERM"].map(name => process.listenerCount(name)), signals);
  const makeRuntime = (id, alive, active) => ({
    sessionId: id,
    cwd: "/secret/not-returned",
    getQueueIdentity: () => ({ revision: "queue-revision", counts: { steering: 0, followUp: 0, total: 0 } }),
    getLiveRuntimeIdentity: () => ({ bootId: "runtime-boot" }),
    isAlive: () => alive,
    isShuttingDown: () => !alive,
    isRunning: () => active,
    hasPendingSettingsMutation: () => id === "hidden-idle",
    isStreaming: active,
    isPromptRunning: active,
    isUserPromptActive: () => id === "hidden-idle",
    inner: { isBashRunning: false, isCompacting: false, sessionManager: new Proxy({}, { get: () => { throw new Error("session storage must not be read"); } }) },
    hasPendingUserInteraction: () => false,
  });
  globalThis.__piSessions = new Map([
    ["hidden-idle", makeRuntime("hidden-idle", true, false)],
    ["transient", makeRuntime("transient", true, true)],
    ["shutting-down", makeRuntime("shutting-down", false, false)],
  ]);
  globalThis.__piStartLocks = new Map([["starting-runtime", Promise.resolve()]]);
  const snapshot = listReaderRuntimeSafetySnapshot();
  assert.equal(snapshot.coverage.runtimeCount, 3);
  assert.equal(snapshot.runtimes[0].isPromptRunning, true, "pending admission blocks a safe restart even before SDK streaming starts");
  assert.equal(snapshot.coverage.startingRuntimeCount, 1);
  assert.deepEqual(snapshot.runtimes.map((row) => row.sessionId), ["hidden-idle", "transient", "shutting-down"]);
  assert.equal(snapshot.runtimeStartAttempted, false);
  assert.equal(snapshot.writeSideEffects, false);
  assert.equal(JSON.stringify(snapshot).includes("/secret"), false);
});

test("failed admission binding can be released without blocking the next clear", async (t) => {
  const inner = makePromptInner(() => Promise.resolve());
  let clearCalls = 0;
  inner.clearQueue = () => { clearCalls += 1; return { steering: [], followUp: [] }; };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  wrapper.emit = () => {};
  wrapper.bindControlReceipt("failed-prompt", "prompt");
  wrapper.releaseControlReceiptBinding("failed-prompt");
  await wrapper.send({ type: "clear_queue", expectedQueueRevision: wrapper.getQueueIdentity().revision });
  assert.equal(clearCalls, 1);
  assert.equal(wrapper.controlReceiptBindings.size, 0);
});

test("concurrent managed enqueues retain their exact SDK messages before delayed preflight callbacks", async (t) => {
  const inner = makePromptInner(() => Promise.resolve());
  const queued = [];
  inner.agent.steer = (message) => queued.push(message);
  inner.agent.followUp = (message) => queued.push(message);
  const originalSteer = inner.agent.steer;
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => { wrapper.controlReceiptBindings.clear(); wrapper.destroy(); });
  wrapper.bindControlReceipt("first", "steer");
  wrapper.bindControlReceipt("second", "steer");
  const first = { role: "user", content: [{ type: "text", text: "same text" }] };
  const second = { role: "user", content: [{ type: "text", text: "same text" }] };
  await Promise.all([["first", first], ["second", second]].map(([id, message]) =>
    wrapper.controlReceiptAdmissionStorage.run(id, async () => {
      inner.agent.steer(message);
      await Promise.resolve();
      wrapper.markControlReceiptAdmission({ readerControlReceiptId: id, type: "steer" }, "queued");
    })));
  assert.equal(queued.length, 2);
  assert.equal(wrapper.controlReceiptBindings.get("first").sdkMessage, first);
  assert.equal(wrapper.controlReceiptBindings.get("second").sdkMessage, second);
  wrapper.markQueuedControlConsumed(second);
  assert.equal(wrapper.controlReceiptBindings.get("first").phase, "queued");
  assert.equal(wrapper.controlReceiptBindings.get("second").phase, "running");
  wrapper.controlReceiptAdmissionStorage.run("second", () => {
    inner.agent.steer({ role: "custom", content: "extension event" });
    inner.agent.steer({ role: "user", content: [{ type: "text", text: "extension follow-up" }] });
  });
  assert.equal(wrapper.controlReceiptBindings.get("second").phase, "running", "later messages inheriting ALS context cannot retarget the original receipt");
  assert.equal(wrapper.controlReceiptBindings.get("second").sdkMessage, undefined);
  wrapper.controlQueueCaptureRestore();
  assert.equal(inner.agent.steer, originalSteer);
});

test("clear_queue cannot report a core-drained message as cleared before message_start", async (t) => {
  const inner = makePromptInner(() => Promise.resolve());
  const message = { role: "user", content: [{ type: "text", text: "already-drained" }] };
  inner.agent.steeringQueue = { messages: [message] };
  inner.agent.followUpQueue = { messages: [] };
  inner.agent.steer = (item) => inner.agent.steeringQueue.messages.push(item);
  inner.agent.followUp = (item) => inner.agent.followUpQueue.messages.push(item);
  inner.getSteeringMessages = () => ["already-drained"];
  inner.clearQueue = () => {
    inner.agent.steeringQueue.messages = [];
    inner.agent.followUpQueue.messages = [];
    return { steering: ["already-drained"], followUp: [] };
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => { wrapper.controlReceiptBindings.clear(); wrapper.destroy(); });
  wrapper.emit = () => {};
  wrapper.bindControlReceipt("drained-receipt", "steer");
  Object.assign(wrapper.controlReceiptBindings.get("drained-receipt"), {
    phase: "queued", queueKind: "steering", queueMessage: "already-drained", sdkMessage: message,
  });
  const beforeDrain = wrapper.getQueueIdentity();
  inner.agent.steeringQueue.messages = []; // core owns the item; SDK mirror still lags
  const afterDrain = wrapper.getQueueIdentity();
  assert.notEqual(afterDrain.revision, beforeDrain.revision);
  assert.equal(afterDrain.counts.total, 0);
  await assert.rejects(wrapper.send({ type: "clear_queue", expectedQueueRevision: beforeDrain.revision }), (error) => error.code === "queue_revision_conflict");
  const cleared = await wrapper.send({ type: "clear_queue", expectedQueueRevision: afterDrain.revision });
  assert.equal(cleared.clearedCounts.total, 0);
  assert.equal(wrapper.controlReceiptBindings.has("drained-receipt"), true);
  wrapper.currentRunId = "run-drained";
  wrapper.markQueuedControlConsumed(message);
  assert.equal(wrapper.controlReceiptBindings.get("drained-receipt").phase, "running");
});


test("abort preserves deferred, core-drained and newly enqueued receipt bindings until an actual clear", async (t) => {
  const inner = makePromptInner(() => Promise.resolve());
  const drained = { role: "user", content: [{ type: "text", text: "core-drained" }] };
  const queued = { role: "user", content: [{ type: "text", text: "still-queued" }] };
  inner.agent.steeringQueue = { messages: [queued] };
  inner.agent.followUpQueue = { messages: [] };
  let entered;
  let finish;
  const started = new Promise(resolve => { entered = resolve; });
  inner.abort = () => { entered(); return new Promise(resolve => { finish = resolve; }); };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => { wrapper.controlReceiptBindings.clear(); wrapper.destroy(); });
  wrapper.emit = () => {};
  wrapper.deferredCompactionPrompts.push({ message: "deferred", streamingBehavior: "followUp" });
  const bind = (id, message, kind = "steering") => {
    wrapper.bindControlReceipt(id, "steer");
    Object.assign(wrapper.controlReceiptBindings.get(id), { phase: "queued", queueKind: kind, queueMessage: typeof message === "string" ? message : message.content[0].text, ...(typeof message === "string" ? {} : { sdkMessage: message }) });
  };
  bind("drained", drained);
  bind("queued", queued);
  bind("deferred", "deferred", "followUp");
  let falselySettled = 0;
  wrapper.settleQueuedControlReceipts = async () => { falselySettled += 1; };
  const stopping = wrapper.send({ type: "abort" });
  await started;
  const late = { role: "user", content: [{ type: "text", text: "admitted-during-abort" }] };
  inner.agent.followUpQueue.messages.push(late);
  bind("late", late, "followUp");
  finish();
  await stopping;
  assert.equal(falselySettled, 0, "abort is not a queue-clear operation");
  assert.equal(wrapper.deferredCompactionPrompts.length, 1);
  assert.deepEqual(inner.agent.steeringQueue.messages, [queued]);
  assert.deepEqual(inner.agent.followUpQueue.messages, [late]);
  for (const id of ["drained", "queued", "deferred", "late"]) assert.equal(wrapper.controlReceiptBindings.get(id).phase, "queued");
  wrapper.currentRunId = "eventual-run";
  wrapper.markQueuedControlConsumed(drained);
  assert.equal(wrapper.controlReceiptBindings.get("drained").phase, "running");
});
