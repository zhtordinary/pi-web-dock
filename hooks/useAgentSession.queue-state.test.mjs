import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { QueuedDraftProjection, readQueuedDraftState, getPendingQueueRecall, getQueueRecallOperation, savePendingQueueRecall, clearPendingQueueRecall, clearQueueRecallOperation } from "../lib/queued-draft.ts";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const callbacks = [
  between("function normalizeQueuedMessages(", "type ExtensionUiDialogRequest"),
  between("  const syncQueuedDrafts =", "  const eventConnectionRef"),
  between("  const loadAgentState = useCallback", "  const loadSession = useCallback"),
  between("  const settleUiStage = useCallback", "  const notifyPromptStage = useCallback"),
  between("  const finishPromptWithoutStream = useCallback", "  // 非流式命令"),
  between("  const reconcileAgentState = useCallback", "  // Keep a bounded foreground fallback"),
  between("  const handleAgentEvent = useCallback", "  handleAgentEventRef.current = handleAgentEvent"),
].join("\n");
const item = (itemId = "queued") => ({ itemId, role: "user", text: itemId, hasImages: false, imageCount: 0 });
const snapshot = (queueRevision, steering = [], bootId = "boot") => ({ bootId, queueRevision, steering, followUp: [] });
const response = (data, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => data });
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  clearPendingQueueRecall("s"); clearQueueRecallOperation("s");
  let queue = { steering: [], followUp: [] };
  const requests = [], writes = [];
  const projection = new QueuedDraftProjection(); projection.reset("s");
  const streamState = { isStreaming: false };
  const ctx = {
    useCallback: fn => fn, AbortSignal, AbortController, encodeURIComponent, Map, Set,
    console: { error() {} }, window: { setTimeout, clearTimeout },
    cacheKeyForSession: sid => sid, apiPath: path => path,
    QueuedDraftProjection, readQueuedDraftState, getPendingQueueRecall, getQueueRecallOperation,
    queuedDraftProjectionRef: { current: projection }, sessionHookMountedRef: { current: true },
    sessionIdRef: { current: "s" }, remotePeerRef: { current: null }, branchScopeRef: { current: "local:s" },
    stateRunRevisionRef: { current: 0 }, currentAgentRunIdRef: { current: "run" }, promptRunIdRef: { current: 1 },
    stateLoadInFlightRef: { current: null }, stateLoadGenerationRef: { current: 0 }, runtimeSettingsReadGenerationRef: { current: 0 },
    branchRef: { current: null }, sessionStatePendingRef: { current: false }, agentRunningRef: { current: true }, activeToolIdsRef: { current: new Set() }, toolEventRevisionRef: { current: 0 },
    bashRunningRef: { current: false }, streamState, streamingStore: { getState: () => streamState }, sdkAgentActiveRef: { current: false }, rpcPromptPendingRef: { current: true },
    sessionRunningRef: { current: true }, sessionSettlementGenerationRef: { current: 0 },
    lastAgentErrorRef: { current: false }, lastAgentAbortedRef: { current: false },
    fetch: url => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
    setQueuedMessages: value => { queue = value; }, loadSession: async () => {}, refreshSessionCost: async () => {},
    notifyPromptStage: () => true, agentEndErrorMessage: () => null, agentEndWasAborted: () => false,
    scheduleEventStreamClose() {}, dispatch() {}, syncLiveModel() {}, reader: { recordUnseenEntry() {}, reconcileTail: async () => {} }, runtimeAvailableRef: { current: false },
  };
  for (const match of callbacks.matchAll(/\b(set[A-Z]\w*)\(/g)) {
    if (!(match[1] in ctx)) ctx[match[1]] = value => writes.push([match[1], value]);
  }
  // Only unrelated hook dependencies are inert; queue/run reducers and all
  // three asynchronous HTTP callback bodies below execute production source.
  for (const match of callbacks.matchAll(/\}, \[([^\]]*)\]\);/g)) {
    for (const key of match[1].split(",").map(value => value.trim())) {
      if (/^[A-Za-z_$][\w$]*$/.test(key) && !(key in ctx)) ctx[key] = () => {};
    }
  }
  vm.createContext(ctx);
  vm.runInContext(stripTypeScriptTypes(callbacks + "\nglobalThis.sync=syncQueuedDrafts; globalThis.load=loadAgentState; globalThis.reconcile=reconcileAgentState; globalThis.event=handleAgentEvent;"), ctx);
  ctx.sync("s", snapshot(1, [item()]));
  return { ctx, projection, requests, writes, get queue() { return queue; } };
}

async function startRead(h, reader) {
  if (reader === "agent_end") { h.ctx.event({ type: "agent_end", runId: "run" }); return null; }
  return { pending: reader === "load" ? h.ctx.load("s") : h.ctx.reconcile("s") };
}
async function finishRead(h, started, value) {
  h.requests[0].resolve(value);
  if (started) await started.pending;
  await tick();
}

for (const reader of ["load", "reconcile", "agent_end"]) {
  test(`${reader}: confirmed absent producer clears stale queue but retains recall recovery`, async () => {
    for (const recall of [false, true]) {
      const h = harness();
      if (recall) savePendingQueueRecall("s", snapshot(1, [item("recovery-copy")]));
      const started = await startRead(h, reader);
      await finishRead(h, started, response({ running: false, state: { autoCompactionEnabled: true } }));
      assert.equal(h.projection.snapshot, null);
      assert.equal(h.queue.steering.length, recall ? 1 : 0);
      if (recall) {
        assert.equal(h.queue.recallPending, true);
        assert.equal(h.queue.steering[0].itemId, "recovery-copy");
      }
      clearPendingQueueRecall("s");
    }
  });

  test(`${reader}: transport errors and incomplete state never prove a producer absent`, async () => {
    for (const [payload, ok] of [[{}, true], [{ running: true }, true], [{ running: false }, false], [{ running: false, code: "session_state_unavailable" }, false]]) {
      const h = harness(); const started = await startRead(h, reader);
      await finishRead(h, started, response(payload, ok));
      assert.equal(h.queue.steering[0].itemId, "queued");
      assert.equal(h.projection.snapshot.queueRevision, 1);
    }
    const h = harness(); const started = await startRead(h, reader);
    h.requests[0].reject(new Error("offline"));
    if (started) await started.pending;
    await tick();
    assert.equal(h.queue.steering[0].itemId, "queued");
  });

  test(`${reader}: terminal UI revision does not discard a valid newer queue snapshot`, async () => {
    const h = harness(); const started = await startRead(h, reader);
    h.ctx.event({ type: "prompt_done", runId: "run" });
    assert.equal(h.ctx.agentRunningRef.current, false);
    await finishRead(h, started, response({ running: true, state: { queueSnapshot: snapshot(2), contextUsage: { percent: 77 } } }));
    assert.equal(h.queue.steering.length, 0);
    assert.equal(h.projection.snapshot.queueRevision, 2);
    assert.equal(h.writes.some(([name]) => name === "setContextUsage"), false, "run-scoped metadata remains guarded");
  });

  test(`${reader}: late absence cannot erase a newer boot or a newly started run`, async () => {
    for (const change of ["queue", "run"]) {
      const h = harness(); const started = await startRead(h, reader);
      if (change === "queue") h.ctx.event({ type: "queue_update", queueSnapshot: snapshot(1, [item("fresh")], "new-boot") });
      else { h.ctx.currentAgentRunIdRef.current = "new-run"; h.ctx.promptRunIdRef.current++; }
      await finishRead(h, started, response({ running: false }));
      assert.equal(h.queue.steering[0].itemId, change === "queue" ? "fresh" : "queued");
    }
  });

  test(`${reader}: HTTP queue reads cannot cross session, peer, scope, or unmount`, async () => {
    for (const ref of ["sessionIdRef", "remotePeerRef", "branchScopeRef", "sessionHookMountedRef"]) {
      const h = harness(); const started = await startRead(h, reader);
      h.ctx[ref].current = ref === "sessionHookMountedRef" ? false : "other";
      await finishRead(h, started, response({ running: true, state: { queueSnapshot: snapshot(2) } }));
      assert.equal(h.queue.steering[0].itemId, "queued");
    }
  });
}

test("newer absent load fences an older reconciliation after its same-scope clear", async () => {
  const h = harness(); const stale = h.ctx.reconcile("s"); const current = h.ctx.load("s");
  h.requests[1].resolve(response({ running: false, state: { autoCompactionEnabled: true } }));
  await current;
  assert.equal(h.projection.snapshot, null);
  // The caller restores the newer result's idle run state before the old GET arrives.
  h.ctx.agentRunningRef.current = false;
  h.requests[0].resolve(response({ running: true, state: { queueSnapshot: snapshot(1, [item()]), isStreaming: true } }));
  await stale;
  assert.equal(h.queue.steering.length, 0);
  assert.equal(h.projection.snapshot, null);
});

test("same-boot newer HTTP revision wins over intervening queue events, older revisions do not", async () => {
  for (const revision of [1, 3]) {
    const h = harness(); const pending = h.ctx.reconcile("s");
    h.ctx.event({ type: "queue_update", queueSnapshot: snapshot(2, [item("newer")]) });
    h.requests[0].resolve(response({ running: true, state: { queueSnapshot: snapshot(revision), isStreaming: true } }));
    await pending;
    assert.equal(h.queue.steering.length, revision === 3 ? 0 : 1);
    assert.equal(h.projection.snapshot.queueRevision, revision === 3 ? 3 : 2);
  }
});
