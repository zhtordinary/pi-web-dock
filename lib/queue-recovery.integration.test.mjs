import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { createJiti } from "jiti";
import { fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createSealedPublicInputEnvironment } from "../test-support/sealed-public-inputs.mjs";

const environment = await createSealedPublicInputEnvironment("queue-recovery-product");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: true, tsconfigPaths: true });
const store = await jiti.import("./queue-recall-store.ts");
const route = await jiti.import("../app/api/sessions/[id]/queue-recovery/route.ts");
const { createQueueRecoveryClient, queueRecoveryUrl } = await jiti.import("./queue-recovery-client.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { isBase64ImageWithinLimits } = await jiti.import("./image-attachments.ts");
const source = readFileSync(new URL("../components/ChatInput.tsx", import.meta.url), "utf8");
const methodStart = source.indexOf("    availableImageSlots() {");
const methodEnd = source.indexOf("    prependText(text:", methodStart);
test.after(() => environment.restore());

function browserStorage(t, capacity = Infinity) {
  const previous = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      const other = [...values.entries()].filter(([existing]) => existing !== key).reduce((sum, [, saved]) => sum + saved.length, 0);
      if (other + value.length > capacity) throw Object.assign(new Error("Quota exceeded"), { name: "QuotaExceededError" });
      values.set(key, value);
    },
    removeItem: key => values.delete(key),
  };
  t.after(() => { if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous; });
  return values;
}
async function composer(key) {
  // A new module instance models a new tab: no old in-memory draft/op cache.
  const draft = await createJiti(import.meta.url, { interopDefault: true, moduleCache: false }).import("./draft-store.ts");
  const ctx = {
    MAX_ATTACHED_IMAGES: 10, getDraft: draft.getDraft, setRecalledDraft: draft.setRecalledDraft, isRecalledDraftDurable: draft.isRecalledDraftDurable,
    draftKey: key, quotesRef: { current: [] }, attachedImagesRef: { current: [] }, pendingImageCountRef: { current: 0 },
    textareaRef: { current: null }, valueRef: { current: "" }, pendingDraftFocusRef: { current: null },
    isBase64ImageWithinLimits, draftImageToAttachedImage: image => ({ ...image, previewUrl: "test-preview" }),
    setValue() {}, setAttachedImages() {}, setAtQuery() {},
  };
  vm.runInNewContext(stripTypeScriptTypes(`globalThis.handle = {${source.slice(methodStart, methodEnd)}};`), ctx);
  return ctx;
}
async function fixture(t) {
  const faux = fauxProvider({ models: [{ id: "queue-test" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(environment.agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({});
  const resourceLoader = new DefaultResourceLoader({ cwd: environment.root, agentDir: environment.agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: environment.root, agentDir: environment.agentDir, modelRuntime, model: faux.getModel("queue-test"), sessionManager: SessionManager.inMemory(environment.root), settingsManager, resourceLoader });
  const wrapper = new AgentSessionWrapper(session);
  wrapper.estimateSystemPromptCost = async () => undefined;
  wrapper.start();
  let clears = 0;
  const clear = session.clearQueue.bind(session);
  session.clearQueue = () => { clears++; return clear(); };
  t.after(() => wrapper.shutdown());
  return { session, wrapper, get clears() { return clears; } };
}
const image = data => ({ type: "image", data, mimeType: "image/gif" });
const identity = state => ({ bootId: state.bootId, queueRevision: state.queueRevision });
async function capture(f, data = "AAAA") {
  await f.session.steer("same", [image(data)]);
  const state = (await f.wrapper.send({ type: "get_state" })).queueSnapshot;
  const operationId = crypto.randomUUID();
  const command = { type: "clear_queue", requireQueueIdentity: true, expectedQueueIdentity: identity(state), queueRecallOperationId: operationId };
  await f.wrapper.send(command);
  return { state, operationId, command };
}
function transport(sessionId, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url, ...init });
    const request = new Request(`http://localhost${url}`, { ...init, headers: { host: "localhost", ...init.headers } });
    const params = { params: Promise.resolve({ id: sessionId }) };
    return init.method === "POST" ? route.POST(request, params) : route.GET(request, params);
  };
}
function client(sessionId, input, request = transport(sessionId)) {
  const h = { current: true, input, state: null, downloads: [], calls: [] };
  h.client = createQueueRecoveryClient({ sessionId, peer: null, request,
    isCurrent: () => h.current, input: () => h.input,
    changed: state => { h.state = state; },
    download: (html, name) => h.downloads.push({ html, name }),
  });
  return h;
}

test("a legal 6 MiB attachment exceeds an empty 5 MiB browser quota but still completes recovery", async t => {
  const storage = browserStorage(t, 5 * 1024 * 1024);
  const f = await fixture(t);
  const data = Buffer.alloc(6 * 1024 * 1024, 0x47).toString("base64");
  assert.equal(isBase64ImageWithinLimits(image(data)), true);
  const { operationId, command } = await capture(f, data);
  const input = await composer(f.session.sessionId);
  const h = client(f.session.sessionId, input.handle);
  await h.client.refresh();
  assert.equal(h.state.entries[0].operationId, operationId);
  await h.client.restore(operationId);
  assert.equal(input.valueRef.current, "same");
  assert.equal(input.attachedImagesRef.current[0].data, data);
  assert.equal(input.handle.isQueuedDraftDurable(operationId), false);
  assert.equal(storage.size, 0, "no truncation or partial localStorage draft");
  assert.equal(h.state.notice, "memoryOnly");
  assert.equal(store.listQueueRecoveries(f.session.sessionId).recoveries.length, 1, "memory-only restoration must not ACK");
  await h.client.restore(operationId);
  assert.equal(input.attachedImagesRef.current.length, 1, "repeated restoration does not duplicate images");
  // Closing this memory-only tab also loses its input and its operation marker.
  // A fresh tab still discovers the complete server copy without either.
  const reopened = await composer(`reopened-large:${f.session.sessionId}`);
  const reopenedClient = client(f.session.sessionId, reopened.handle);
  await reopenedClient.client.refresh();
  await reopenedClient.client.restore(operationId);
  assert.equal(reopened.attachedImagesRef.current[0].data, data);
  assert.equal(reopenedClient.state.notice, "memoryOnly");
  await h.client.exportCopy(operationId);
  assert.ok(h.downloads[0].html.includes(data));
  assert.equal(store.listQueueRecoveries(f.session.sessionId).recoveries.length, 1, "download initiation alone must not ACK");
  await h.client.confirmSaved(h.state.entries[0], true);
  assert.equal(store.listQueueRecoveries(f.session.sessionId).recoveries.length, 0);
  await assert.rejects(f.wrapper.send(command), { code: "queue_recall_acknowledged" });
  assert.equal(f.clears, 1);
});

test("closing the original tab after clear and losing all local IDs still exposes the saved copy", async t => {
  browserStorage(t);
  const f = await fixture(t);
  const { operationId } = await capture(f);
  // No local operation is passed to the new client. Session discovery is the
  // only path to the original record after a lost response and closed tab.
  const input = await composer(`reopened:${f.session.sessionId}`);
  const h = client(f.session.sessionId, input.handle);
  await h.client.refresh();
  assert.equal(h.state.entries.length, 1);
  assert.equal(h.state.entries[0].operationId, operationId);
  await h.client.restore(operationId);
  assert.equal(input.attachedImagesRef.current[0].data, "AAAA");
  assert.equal(h.state.notice, "restored");
  assert.equal(store.listQueueRecoveries(f.session.sessionId).recoveries.length, 0);
  assert.equal(f.clears, 1);
});

for (const clearedBeforeCrash of [false, true]) {
  test(`prepared crash ${clearedBeforeCrash ? "after SDK clear" : "before SDK clear"} can be inspected/exported/confirmed without guessing execution`, async t => {
    browserStorage(t);
    const f = await fixture(t);
    await f.session.steer("original <script>alert('no')</script>", [image("AAAA")]);
    const captured = f.wrapper.queueIdentityTracker.snapshot([], true);
    const operationId = crypto.randomUUID();
    const receipts = await jiti.import("./reader-control-receipts.ts");
    const { receipt } = await receipts.reserveControlReceipt({ deviceId: "recovery-test", sessionId: f.session.sessionId, operation: "prompt", idempotencyKey: crypto.randomUUID(), requestFingerprint: "test", cwd: environment.root });
    store.prepareQueueRecall(f.session.sessionId, operationId, identity(captured), captured, [{ receiptId: receipt.receiptId, update: { outcome: "aborted", error: { code: "queued_control_cleared", message: "must not invent this fact" } } }]);
    if (clearedBeforeCrash) f.session.clearQueue();
    const originalMessages = [...f.session.agent.steeringQueue.messages];
    const freshStore = await createJiti(import.meta.url, { interopDefault: true, moduleCache: false }).import("./queue-recall-store.ts");
    assert.equal(freshStore.listQueueRecoveries(f.session.sessionId).recoveries[0].status, "prepared");
    const input = await composer(`prepared:${f.session.sessionId}`);
    const h = client(f.session.sessionId, input.handle);
    await h.client.refresh();
    await h.client.inspect(operationId);
    assert.equal(h.state.copy.queue.steering[0].images[0].data, "AAAA");
    await h.client.restore(operationId);
    assert.match(h.state.error, /outcome is unknown/);
    assert.equal(input.attachedImagesRef.current.length, 0);
    await h.client.exportCopy(operationId);
    assert.match(h.downloads[0].html, /Clear outcome unknown/);
    assert.match(h.downloads[0].html, /&lt;script&gt;/);
    assert.doesNotMatch(h.downloads[0].html, /<script>/);
    await h.client.confirmSaved(h.state.entries[0], false);
    assert.equal(freshStore.listQueueRecoveries(f.session.sessionId).recoveries.length, 1);
    await h.client.confirmSaved(h.state.entries[0], true);
    assert.equal(freshStore.listQueueRecoveries(f.session.sessionId).recoveries.length, 0);
    assert.deepEqual(f.session.agent.steeringQueue.messages, originalMessages);
    assert.equal((await receipts.readControlReceipt({ deviceId: "recovery-test", sessionId: f.session.sessionId, receiptId: receipt.receiptId })).outcome, "accepted");
    await assert.rejects(f.wrapper.send({ type: "clear_queue", requireQueueIdentity: true, queueRecallOperationId: operationId, expectedQueueIdentity: identity(captured) }), { code: "queue_recall_acknowledged" });
    assert.equal(f.clears, clearedBeforeCrash ? 1 : 0);
  });
}

test("late recovery responses cannot restore or download into a different session/peer", async t => {
  browserStorage(t);
  const f = await fixture(t);
  const { operationId } = await capture(f);
  const input = await composer(f.session.sessionId);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const request = transport(f.session.sessionId);
  const h = client(f.session.sessionId, input.handle, async (...args) => { const res = await request(...args); await blocked; return res; });
  const restore = h.client.restore(operationId);
  h.current = false; release(); await restore;
  assert.equal(input.attachedImagesRef.current.length, 0);
  assert.equal(store.listQueueRecoveries(f.session.sessionId).recoveries.length, 1);
  assert.equal(h.downloads.length, 0);
  assert.equal(queueRecoveryUrl("shared/session", "peer A", operationId), `/api/remote/sessions/shared%2Fsession/queue-recovery?peer=peer+A&operationId=${operationId}`);
  assert.equal(store.listQueueRecoveries("another-session").recoveries.length, 0);
  assert.throws(() => store.readQueueRecoveryCopy("another-session", operationId), { code: "queue_recovery_missing" });
});

test("HTML copies cannot inject tags, attributes, script or external fetches", () => {
  const attack = '</pre><script src="https://invalid.test/no-request"></script><img src=x onerror=alert(1)>';
  const html = store.queueRecoveryHtml({ sessionId: attack, operationId: "safe", status: "prepared", createdAt: "now", expected: { bootId: attack, queueRevision: 1 }, queue: { bootId: "b", queueRevision: 1, steering: [{ itemId: attack, role: "user", text: attack, hasImages: true, imageCount: 1, images: [{ data: "AAAA", mimeType: 'image/png" onerror="alert(1)' }] }], followUp: [] } });
  assert.doesNotMatch(html, /<script|<img src=x|src="https:/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /&lt;\/pre&gt;/);
  assert.match(html, /image\/png&amp;quot;|image\/png&quot;/);
});

test("recovery endpoints require explicit confirmation and reject cross-site writes", async t => {
  const f = await fixture(t);
  const { operationId, state } = await capture(f);
  for (const [body, headers, status] of [
    [{ action: "confirm_saved", operationId, expected: identity(state) }, {}, 400],
    [{ action: "confirm_saved", operationId, expected: identity(state), confirmStored: true }, { "origin": "https://evil.invalid", "sec-fetch-site": "cross-site" }, 403],
  ]) {
    const result = await route.POST(new Request("http://localhost/api/sessions/x/queue-recovery", { method: "POST", headers: { host: "localhost", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: f.session.sessionId }) });
    assert.equal(result.status, status);
    assert.equal(store.listQueueRecoveries(f.session.sessionId).recoveries.length, 1);
  }
});


test("slow ACK exposes confirmation state, ignores repeated clicks, and reconciles a lost ACK reply", async t => {
  browserStorage(t);
  const f = await fixture(t);
  const { operationId } = await capture(f);
  const input = await composer(f.session.sessionId);
  const calls = [];
  const request = transport(f.session.sessionId, calls);
  let reachedAck, releaseAck;
  const reached = new Promise(resolve => { reachedAck = resolve; });
  const release = new Promise(resolve => { releaseAck = resolve; });
  const h = client(f.session.sessionId, input.handle, async (url, init = {}) => {
    const result = await request(url, init);
    if (init.method === "POST") {
      reachedAck(); await release;
      throw new Error("ACK reply was lost after the server committed it");
    }
    return result;
  });
  await h.client.refresh();
  const restoring = h.client.restore(operationId);
  await reached;
  assert.deepEqual(h.state.busy, { operationId, action: "confirm" });
  assert.equal(h.client.hasDurableDraft(operationId), true);
  await h.client.restore(operationId);
  await h.client.exportCopy(operationId);
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
  assert.equal(h.downloads.length, 0);
  releaseAck(); await restoring;
  assert.match(h.state.error, /ACK reply was lost/);
  assert.equal(input.attachedImagesRef.current.length, 1);
  await h.client.refresh();
  assert.equal(h.state.entries.length, 0, "a lost ACK reply is reconciled without another clear or prepend");
  assert.equal(h.state.error, null);
  assert.equal(f.clears, 1);
});


test("recovery uses the current production composer handle after an ordinary rerender during its read", async t => {
  browserStorage(t);
  const f = await fixture(t);
  const { operationId } = await capture(f);
  const input = await composer(f.session.sessionId);
  const request = transport(f.session.sessionId);
  const staleHandle = input.handle;
  let currentHandle = staleHandle;
  let writes = 0;
  const h = client(f.session.sessionId, currentHandle, async (...args) => {
    const result = await request(...args);
    if (String(args[0]).includes("operationId=")) {
      // Re-evaluate the actual ChatInput imperative methods against the same
      // state/refs, exactly as useImperativeHandle does on a normal rerender.
      vm.runInNewContext(stripTypeScriptTypes(`globalThis.handle = {${source.slice(methodStart, methodEnd)}};`), input);
      currentHandle = input.handle;
      const prepend = currentHandle.prependQueuedDraft;
      currentHandle.prependQueuedDraft = (...values) => { writes++; return prepend(...values); };
      h.input = currentHandle;
      staleHandle.prependQueuedDraft = () => { throw new Error("must not use the stale imperative handle"); };
    }
    return result;
  });
  await h.client.refresh();
  await h.client.restore(operationId);
  assert.notEqual(staleHandle, currentHandle);
  assert.equal(writes, 1);
  assert.equal(input.valueRef.current, "same");
  assert.equal(input.attachedImagesRef.current[0].data, "AAAA");
  assert.equal(h.state.notice, "restored");
  assert.equal(store.listQueueRecoveries(f.session.sessionId).recoveries.length, 0);
  assert.equal(f.clears, 1);
});

test("retrying the first of 33 unacknowledged restores never duplicates content in the dirty composer", async t => {
  browserStorage(t);
  const f = await fixture(t);
  const input = await composer(f.session.sessionId);
  input.valueRef.current = "dirty original";
  input.attachedImagesRef.current = [{ data: "AAAA", mimeType: "image/png", previewUrl: "existing" }];
  const request = transport(f.session.sessionId);
  const h = client(f.session.sessionId, input.handle, (url, init = {}) => init.method === "POST"
    ? Promise.resolve(Response.json({ error: "temporary ACK failure" }, { status: 503 })) : request(url, init));
  const operations = [];
  for (let index = 1; index <= 33; index++) {
    await f.session.steer(`queued-${index}`);
    const state = (await f.wrapper.send({ type: "get_state" })).queueSnapshot;
    const operationId = crypto.randomUUID(); operations.push(operationId);
    await f.wrapper.send({ type: "clear_queue", requireQueueIdentity: true, expectedQueueIdentity: identity(state), queueRecallOperationId: operationId });
    await h.client.restore(operationId);
    assert.match(h.state.error, /temporary ACK failure/);
  }
  const before = input.valueRef.current;
  await h.client.restore(operations[0]);
  assert.equal(input.valueRef.current, before);
  assert.equal(input.attachedImagesRef.current.length, 1);
  assert.equal(input.attachedImagesRef.current[0].data, "AAAA");
  assert.ok(input.valueRef.current.endsWith("dirty original"));
});
