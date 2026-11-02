import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import fs, { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { createSealedPublicInputEnvironment } from "../test-support/sealed-public-inputs.mjs";

const environment = await createSealedPublicInputEnvironment("queue-identity");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
test.after(() => environment.restore());

async function fixture(t, Wrapper = AgentSessionWrapper) {
  const faux = fauxProvider({ models: [{ id: "queue-test" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(environment.agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({});
  const resourceLoader = new DefaultResourceLoader({ cwd: environment.root, agentDir: environment.agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: environment.root, agentDir: environment.agentDir, modelRuntime, model: faux.getModel("queue-test"), sessionManager: SessionManager.inMemory(environment.root), settingsManager, resourceLoader });
  const wrapper = new Wrapper(session);
  // Pricing is unrelated to queue identity; no model run or network is needed.
  wrapper.estimateSystemPromptCost = async () => undefined;
  wrapper.start();
  const events = [];
  wrapper.onEvent(event => { if (event.type === "queue_update") events.push(event); });
  t.after(() => wrapper.destroy());
  return { session, wrapper, events, faux };
}
const image = data => ({ type: "image", data, mimeType: "image/png" });
const expected = state => ({ bootId: state.bootId, queueRevision: state.queueRevision });

for (const stage of ["prepareInputRuntime", "prepareMcpForInput"]) {
  test(`Recall during ${stage} prevents a deferred prompt from reaching the SDK`, { timeout: 10000 }, async t => {
    const { wrapper, faux } = await fixture(t);
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const prepare = wrapper[stage].bind(wrapper);
    wrapper[stage] = async (...args) => {
      enter();
      await gate;
      return prepare(...args);
    };
    const submit = wrapper.promptWithDisplayTracking.bind(wrapper);
    let submissions = 0;
    wrapper.promptWithDisplayTracking = (...args) => {
      submissions += 1;
      return submit(...args);
    };
    faux.setResponses([fauxAssistantMessage([fauxText("unexpected delivery")])]);
    wrapper.deferPromptDuringCompaction({
      kind: "prompt", message: "withdrawn", images: [image("AAAA")], streamingBehavior: "followUp",
    });
    const snapshot = (await wrapper.send({ type: "get_state", systemPrompt: false })).queueSnapshot;
    const flush = wrapper.flushDeferredCompactionPrompts();
    try {
      await entered;
      const result = await wrapper.send({ type: "clear_queue", requireQueueIdentity: true, expectedQueueIdentity: expected(snapshot) });
      assert.equal(result.clearedQueue.followUp[0].text, "withdrawn");
      assert.equal(result.clearedQueue.followUp[0].images[0].data, "AAAA");
    } finally {
      release();
    }
    await flush;
    assert.equal(submissions, 0, "a successfully recalled prompt must never reach the SDK");
    assert.equal(wrapper.pendingPromptCount, 0);
  });
}

test("Recall cannot claim success while a deferred prompt is entering the SDK", { timeout: 10000 }, async t => {
  const { wrapper } = await fixture(t);
  let enter, accept;
  const entered = new Promise(resolve => { enter = resolve; });
  wrapper.promptWithDisplayTracking = (_message, options) => new Promise(resolve => {
    accept = () => { options.preflightResult("queued"); resolve(); };
    enter();
  });
  t.after(() => accept?.());
  wrapper.deferPromptDuringCompaction({ kind: "prompt", message: "handoff", streamingBehavior: "followUp" });
  const snapshot = (await wrapper.send({ type: "get_state", systemPrompt: false })).queueSnapshot;
  const flush = wrapper.flushDeferredCompactionPrompts();
  try {
    await entered;
    await assert.rejects(
      wrapper.send({ type: "clear_queue", requireQueueIdentity: true, expectedQueueIdentity: expected(snapshot) }),
      { code: "queue_admission_pending" },
    );
  } finally {
    accept?.();
  }
  await flush;
});

test("actual SDK producer, state and clear retain B after consuming same-text A", async t => {
  const { session, wrapper, events } = await fixture(t);
  await session.steer("same", [image("AAAA")]);
  await session.steer("same", [image("BBBB")]);
  const before = (await wrapper.send({ type: "get_state" })).queueSnapshot;
  assert.equal(before.steering.length, 2);
  assert.deepEqual(events.at(-1).queueSnapshot, before);
  assert.equal(before.steering.some(item => item.images), false);
  assert.equal(session.agent.steeringQueue.drain().length, 1);
  const after = (await wrapper.send({ type: "get_state" })).queueSnapshot;
  assert.equal(after.steering[0].itemId, before.steering[1].itemId);
  await assert.rejects(wrapper.send({ type: "clear_queue", requireQueueIdentity: true, expectedQueueIdentity: expected(before) }), /changed before recall/);
  assert.equal(session.agent.steeringQueue.messages.length, 1, "failed CAS must not clear the queue");
  const result = await wrapper.send({ type: "clear_queue", requireQueueIdentity: true, expectedQueueIdentity: expected(after) });
  assert.deepEqual(result.steering, ["same"]);
  assert.equal(result.clearedQueue.steering[0].itemId, before.steering[1].itemId);
  assert.deepEqual(result.clearedQueue.steering[0].images, [{ data: "BBBB", mimeType: "image/png" }]);
  assert.equal(result.queueSnapshot.steering.length, 0);
  assert.ok(result.queueSnapshot.queueRevision > after.queueRevision);
});

test("image-only core consumption updates events even when the SDK text mirror stays stale", async t => {
  const { session, wrapper, events } = await fixture(t);
  await session.followUp("", [image("AAAA")]);
  await session.followUp("", [image("BBBB")]);
  const before = (await wrapper.send({ type: "get_state" })).queueSnapshot;
  session.agent.followUpQueue.drain();
  assert.equal(events.at(-1).queueSnapshot.followUp.length, 1);
  assert.equal(events.at(-1).queueSnapshot.followUp[0].itemId, before.followUp[1].itemId);
  const state = await wrapper.send({ type: "get_state" });
  assert.deepEqual(state.queuedMessages.followUp, [""]);
  const result = await wrapper.send({ type: "clear_queue", requireQueueIdentity: true, expectedQueueIdentity: expected(state.queueSnapshot) });
  assert.equal(result.clearedQueue.followUp[0].text, "");
  assert.equal(result.clearedQueue.followUp[0].images[0].data, "BBBB");
});

test("compaction items and core items recall in the producer's per-kind order", async t => {
  const { session, wrapper } = await fixture(t);
  await session.steer("core", [image("AAAA")]);
  wrapper.deferPromptDuringCompaction({ message: "deferred", images: [image("BBBB")], streamingBehavior: "steer" });
  wrapper.deferPromptDuringCompaction({ message: "", images: [image("CCCC")], streamingBehavior: "followUp" });
  const state = await wrapper.send({ type: "get_state" });
  const result = await wrapper.send({ type: "clear_queue", requireQueueIdentity: true, expectedQueueIdentity: expected(state.queueSnapshot) });
  assert.deepEqual(result.clearedQueue.steering.map(item => item.text), ["core", "deferred"]);
  assert.equal(result.clearedQueue.followUp[0].images[0].data, "CCCC");
  assert.equal(wrapper.deferredCompactionPrompts.length, 0);
});

test("a committed clear with a lost response replays its original images without clearing new items", async t => {
  const { session, wrapper } = await fixture(t);
  await session.followUp("same", [image("AAAA")]);
  const state = await wrapper.send({ type: "get_state" });
  const command = { type: "clear_queue", requireQueueIdentity: true, expectedQueueIdentity: expected(state.queueSnapshot), queueRecallOperationId: crypto.randomUUID() };
  // Simulate the caller losing a successfully committed response.
  await wrapper.send(command);
  await session.followUp("same", [image("BBBB")]);
  const replay = await wrapper.send(command);
  assert.equal(replay.clearedQueue.followUp[0].images[0].data, "AAAA");
  assert.equal(session.agent.followUpQueue.messages.length, 1);
  assert.equal(session.agent.followUpQueue.messages[0].content[1].data, "BBBB");
});

test("receipt settlement failure is repaired on replay using only the original receipt IDs", async t => {
  const { session, wrapper } = await fixture(t);
  const receipts = await jiti.import("./reader-control-receipts.ts");
  const { acquireStateWriteLock } = await jiti.import("./state-file-transaction.ts");
  async function enqueue(data) {
    await session.steer("same", [image(data)]);
    const { receipt } = await receipts.reserveControlReceipt({ deviceId: "queue-test", sessionId: session.sessionId, operation: "prompt", idempotencyKey: crypto.randomUUID(), requestFingerprint: "queue-test", cwd: environment.root });
    wrapper.controlReceiptBindings.set(receipt.receiptId, { operation: "prompt", runId: null, phase: "queued", queueKind: "steering", queueMessage: "same", sdkMessage: session.agent.steeringQueue.messages.at(-1) });
    return receipt;
  }
  const original = await enqueue("AAAA");
  const state = await wrapper.send({ type: "get_state" });
  const command = { type: "clear_queue", requireQueueIdentity: true, expectedQueueIdentity: expected(state.queueSnapshot), queueRecallOperationId: crypto.randomUUID() };
  const release = acquireStateWriteLock(receipts.controlReceiptStorePath());
  try { await assert.rejects(wrapper.send(command), { code: "ELOCKED" }); } finally { release(); }
  assert.equal(session.agent.steeringQueue.messages.length, 0);
  const newer = await enqueue("BBBB");
  const replay = await wrapper.send(command);
  assert.equal(replay.clearedQueue.steering[0].images[0].data, "AAAA");
  assert.equal((await receipts.readControlReceipt({ deviceId: "queue-test", sessionId: session.sessionId, receiptId: original.receiptId })).outcome, "aborted");
  assert.equal((await receipts.readControlReceipt({ deviceId: "queue-test", sessionId: session.sessionId, receiptId: newer.receiptId })).outcome, "accepted");
  assert.equal(session.agent.steeringQueue.messages[0].content.at(-1).data, "BBBB");
  assert.equal(wrapper.hasControlReceiptLifecycleBinding(original.receiptId), false);
});

test("HTTP recall replay survives runtime eviction without starting another runtime", async t => {
  const { session, wrapper } = await fixture(t);
  await session.steer("image", [image("AAAA")]);
  const state = await wrapper.send({ type: "get_state" });
  const command = { type: "clear_queue", requireQueueIdentity: true, expectedQueueIdentity: expected(state.queueSnapshot), queueRecallOperationId: crypto.randomUUID() };
  await wrapper.send(command);
  wrapper.destroy();
  const routeJiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: true, tsconfigPaths: true });
  const route = await routeJiti.import("../app/api/agent/[id]/route.ts");
  const { getRpcSession } = await routeJiti.import("./rpc-manager.ts");
  assert.equal(getRpcSession(session.sessionId), undefined);
  const response = await route.POST(new Request("http://localhost/api/agent/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) }), { params: Promise.resolve({ id: session.sessionId }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.clearedQueue.steering[0].images[0].data, "AAAA");
  assert.equal(getRpcSession(session.sessionId), undefined);
});

test("prepared-only recovery is explicit unknown and never clears a second time", async t => {
  const { session, wrapper } = await fixture(t);
  await session.steer("still queued", [image("AAAA")]);
  const captured = wrapper.queueIdentityTracker.snapshot([], true);
  const { prepareQueueRecall, readQueueRecallResult } = await jiti.import("./queue-recall-store.ts");
  const operationId = crypto.randomUUID();
  prepareQueueRecall(session.sessionId, operationId, expected(captured), captured);
  assert.throws(() => readQueueRecallResult(session.sessionId, operationId, expected(captured)), /durable prepared record/);
  await assert.rejects(wrapper.send({ type: "clear_queue", requireQueueIdentity: true, expectedQueueIdentity: expected(captured), queueRecallOperationId: operationId }), /durable prepared record/);
  assert.equal(session.agent.steeringQueue.messages.length, 1);
});


test("custom peer messages preserve their role and cannot be recalled as user input", async t => {
  const { session, wrapper } = await fixture(t);
  await session.steer("user", [image("AAAA")]);
  const peerMessage = { role: "custom", customType: "reader.peer-message", content: "trusted peer context", display: true, timestamp: Date.now() };
  session.agent.steer(peerMessage);
  const state = (await wrapper.send({ type: "get_state" })).queueSnapshot;
  assert.equal(state.steering[0].role, "user");
  assert.equal(state.steering[1].role, "custom");
  assert.equal(state.steering[1].customType, "reader.peer-message");
  await assert.rejects(wrapper.send({ type: "clear_queue", requireQueueIdentity: true, expectedQueueIdentity: expected(state), queueRecallOperationId: crypto.randomUUID() }), { code: "queue_contains_non_user_messages" });
  assert.equal(session.agent.steeringQueue.messages.length, 2);
  assert.equal(session.agent.steeringQueue.messages[1], peerMessage);
});

test("ack removes attachment bytes, preserves a replay tombstone and works without runtime", async t => {
  const { session, wrapper } = await fixture(t);
  await session.steer("image", [image("AAAA")]);
  const state = (await wrapper.send({ type: "get_state" })).queueSnapshot;
  const operationId = crypto.randomUUID();
  const command = { type: "clear_queue", requireQueueIdentity: true, expectedQueueIdentity: expected(state), queueRecallOperationId: operationId };
  await wrapper.send(command);
  wrapper.destroy();
  const routeJiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: true, tsconfigPaths: true });
  const route = await routeJiti.import("../app/api/agent/[id]/route.ts");
  const post = body => route.POST(new Request("http://localhost/api/agent/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: session.sessionId }) });
  const ack = { ...command, type: "ack_queue_recall" };
  assert.equal((await post(ack)).status, 200);
  assert.equal((await post(ack)).status, 200, "lost ack responses can be retried");
  const root = join(environment.agentDir, "queue-recalls");
  const record = readdirSync(root, { recursive: true }).filter(name => String(name).endsWith(".json")).map(name => JSON.parse(readFileSync(join(root, String(name)), "utf8"))).find(value => value.operationId === operationId);
  assert.equal(record.status, "acknowledged");
  assert.equal(record.result, undefined);
  assert.equal(record.clearedQueue, undefined);
  assert.equal(JSON.stringify(record).includes("AAAA"), false);
  const replay = await post(command);
  assert.equal((await replay.json()).code, "queue_recall_acknowledged");
  const { getRpcSession } = await routeJiti.import("./rpc-manager.ts");
  assert.equal(getRpcSession(session.sessionId), undefined);
});

test("a rebuilt store repairs the exact committed receipt settlement before replay", async t => {
  const { session, wrapper } = await fixture(t);
  const receipts = await jiti.import("./reader-control-receipts.ts");
  const { acquireStateWriteLock } = await jiti.import("./state-file-transaction.ts");
  await session.followUp("image", [image("AAAA")]);
  const { receipt } = await receipts.reserveControlReceipt({ deviceId: "queue-test", sessionId: session.sessionId, operation: "prompt", idempotencyKey: crypto.randomUUID(), requestFingerprint: "queue-test", cwd: environment.root });
  wrapper.controlReceiptBindings.set(receipt.receiptId, { operation: "prompt", runId: null, phase: "queued", queueKind: "followUp", queueMessage: "image", sdkMessage: session.agent.followUpQueue.messages[0] });
  const state = (await wrapper.send({ type: "get_state" })).queueSnapshot;
  const operationId = crypto.randomUUID();
  const release = acquireStateWriteLock(receipts.controlReceiptStorePath());
  try { await assert.rejects(wrapper.send({ type: "clear_queue", expectedQueueIdentity: expected(state), queueRecallOperationId: operationId }), { code: "ELOCKED" }); } finally { release(); }
  const freshJiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
  const rebuilt = await freshJiti.import("./queue-recall-store.ts");
  const replay = await rebuilt.replayQueueRecall(session.sessionId, operationId, expected(state));
  assert.equal(replay.clearedQueue.followUp[0].images[0].data, "AAAA");
  assert.equal((await receipts.readControlReceipt({ deviceId: "queue-test", sessionId: session.sessionId, receiptId: receipt.receiptId })).outcome, "aborted");
  wrapper.releaseControlReceiptBinding(receipt.receiptId);
});


test("full recall recovery storage rejects before clear and preserves every attachment", async t => {
  const previous = process.env.PI_WEB_QUEUE_RECALL_ROOT;
  const root = join(environment.root, "full-recall-store");
  mkdirSync(root);
  // Exercise the real wrapper with no available filesystem capacity, without
  // allocating a giant file or relying on corrupt reservation metadata.
  const statfs = t.mock.method(fs, "statfsSync", () => ({ bavail: 0, bsize: 4096 }));
  syncBuiltinESMExports();
  t.after(() => { statfs.mock.restore(); syncBuiltinESMExports(); });
  // Existing Jiti modules may hold a previous builtin snapshot. Import this
  // wrapper after the mock so the real store reads the exhausted filesystem.
  const isolatedJiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
  const { AgentSessionWrapper: CapacityWrapper } = await isolatedJiti.import("./rpc-manager.ts");
  const { session, wrapper } = await fixture(t, CapacityWrapper);
  process.env.PI_WEB_QUEUE_RECALL_ROOT = root;
  t.after(() => { if (previous === undefined) delete process.env.PI_WEB_QUEUE_RECALL_ROOT; else process.env.PI_WEB_QUEUE_RECALL_ROOT = previous; });
  await session.steer("image", [image("AAAA")]);
  const state = (await wrapper.send({ type: "get_state" })).queueSnapshot;
  await assert.rejects(wrapper.send({ type: "clear_queue", expectedQueueIdentity: expected(state), queueRecallOperationId: crypto.randomUUID() }), { code: "queue_recall_store_full" });
  assert.equal(session.agent.steeringQueue.messages[0].content.at(-1).data, "AAAA");
  assert.equal(readdirSync(root).filter(name => name.endsWith(".json")).length, 0);
});

test("committed recall survives replacement runtime without a queue identity adapter", async t => {
  const { session, wrapper } = await fixture(t);
  await session.steer("same", [image("AAAA")]);
  const state = (await wrapper.send({ type: "get_state" })).queueSnapshot;
  const command = { type: "clear_queue", requireQueueIdentity: true, expectedQueueIdentity: expected(state), queueRecallOperationId: crypto.randomUUID() };
  const committed = await wrapper.send(command);
  await wrapper.shutdown();

  // A genuinely new AgentSession and wrapper share only the session history.
  // The replacement's adapter is unavailable; recovery must use disk alone.
  const { session: nextSession } = await createAgentSession({
    cwd: environment.root, agentDir: environment.agentDir,
    modelRuntime: session.modelRuntime, model: session.model,
    sessionManager: session.sessionManager, settingsManager: session.settingsManager,
    resourceLoader: session.resourceLoader,
  });
  const replacement = new AgentSessionWrapper(nextSession);
  replacement.estimateSystemPromptCost = async () => undefined;
  replacement.start();
  t.after(() => replacement.shutdown());
  assert.equal(replacement.sessionId, wrapper.sessionId);
  assert.notEqual(replacement.getLiveRuntimeIdentity().bootId, state.bootId);
  replacement.queueIdentityTracker.dispose();
  replacement.queueIdentityTracker = null;
  await nextSession.steer("same", [image("BBBB")]);
  const newMessage = nextSession.agent.steeringQueue.messages[0];

  const replay = await replacement.send(command);
  assert.deepEqual(replay, committed);
  assert.equal(replay.clearedQueue.steering[0].images[0].data, "AAAA");
  assert.equal(replacement.queueIdentityTracker, null);
  assert.deepEqual(nextSession.agent.steeringQueue.messages, [newMessage]);
  assert.equal(newMessage.content.at(-1).data, "BBBB");
  await assert.rejects(replacement.send({ ...command, queueRecallOperationId: crypto.randomUUID() }), { code: "queue_identity_unavailable" }, "a new clear still requires the adapter");
});

test("malformed recall ack rejects before a persisted session can start a runtime", async t => {
  const routeJiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: true, tsconfigPaths: true });
  const route = await routeJiti.import("../app/api/agent/[id]/route.ts");
  const { cacheSessionPath, invalidateSessionPathCache, resolveSessionPath } = await routeJiti.import("./session-reader.ts");
  const { getRpcSession } = await routeJiti.import("./rpc-manager.ts");
  const manager = SessionManager.create(environment.root, join(environment.agentDir, "malformed-ack-sessions"));
  manager.appendMessage({ role: "user", content: "persisted session", timestamp: Date.now() });
  const id = manager.getSessionId();
  const path = manager.getSessionFile();
  cacheSessionPath(id, path);
  assert.equal(await resolveSessionPath(id), path, "the route must have a real reopenable session, not just a missing ID");
  assert.equal(getRpcSession(id), undefined);
  const previousLocks = globalThis.__piStartLocks;
  let startAttempts = 0;
  // Observe the actual startRpcSession admission boundary. If the guard ever
  // regresses, fail before constructing a runtime or making external calls.
  class ObservedStartLocks extends Map {
    get(key) {
      if (key === id) { startAttempts++; throw new Error("Unexpected runtime start for malformed ack"); }
      return super.get(key);
    }
  }
  globalThis.__piStartLocks = new ObservedStartLocks(previousLocks);
  t.after(() => {
    globalThis.__piStartLocks = previousLocks;
    invalidateSessionPathCache(id);
  });
  for (const queueRecallOperationId of [undefined, null, 42, {}]) {
    const response = await route.POST(new Request("http://localhost/api/agent/test", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "ack_queue_recall", queueRecallOperationId }),
    }), { params: Promise.resolve({ id }) });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, "invalid_queue_recall_operation");
    assert.equal(body.accepted, false);
    assert.equal(startAttempts, 0);
    assert.equal(getRpcSession(id), undefined);
  }
});

for (const delivery of ["steer", "followUp"]) {
  test(`actual SDK consumption clears ${delivery} image-only pending count despite stale SDK text mirror`, async t => {
    const { session, wrapper, faux, events } = await fixture(t);
    faux.setResponses([
      () => fauxAssistantMessage([fauxText("first fixture answer")]),
      () => fauxAssistantMessage([fauxText("queued fixture answer")]),
    ]);
    await session[delivery]("", [image("AAAA")]);
    const queued = await wrapper.send({ type: "get_state" });
    assert.equal(queued.pendingMessageCount, 1);
    await session.prompt("start");
    const settled = await wrapper.send({ type: "get_state" });
    assert.equal(session.messages.filter(message => message.role === "user").length, 2);
    assert.equal(session.pendingMessageCount, 1, "exercise the pinned SDK's stale empty-text mirror");
    assert.equal(settled.pendingMessageCount, 0);
    assert.equal(settled.queueCounts.total, 0);
    assert.deepEqual(settled.queuedMessages, { steering: [], followUp: [] });
    assert.equal(events.at(-1).queueSnapshot.steering.length + events.at(-1).queueSnapshot.followUp.length, 0);
    assert.equal(wrapper.pendingQueueCount(), 0, "compaction decisions use the same actual queue, not the mirror");
  });
}
