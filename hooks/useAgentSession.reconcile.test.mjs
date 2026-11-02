import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const slice = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return stripTypeScriptTypes(source.slice(a, b));
};

function restoreHarness() {
  const h = { running: true, bash: false, compacting: true, phase: null, actions: [] };
  const bindings = {
    useCallback: fn => fn,
    sessionIdRef: { current: "s" }, sessionHookMountedRef: { current: true },
    sessionSettlementGenerationRef: { current: 1 }, stateRunRevisionRef: { current: 2 },
    sessionRunningRef: { current: true }, agentRunningRef: { current: true }, bashRunningRef: { current: false },
    localCompactionPendingRef: { current: false }, activeToolIdsRef: { current: new Set() },
    sdkAgentActiveRef: { current: true }, rpcPromptPendingRef: { current: true },
    setAgentRunning: value => { h.running = value; }, setBashRunning: value => { h.bash = value; },
    setIsCompacting: value => { h.compacting = value; },
    setAgentPhase: value => { h.phase = typeof value === "function" ? value(h.phase) : value; },
    dispatch: action => h.actions.push(action), loadTools: () => {}, waitForPromptSettlement: () => {}, onSessionReady: () => {},
  };
  h.bindings = bindings;
  h.restore = new Function(...Object.keys(bindings), `${slice("  const restoreLoadedRunState = useCallback", "  // Reconcile client streaming state")}; return restoreLoadedRunState;`)(...Object.values(bindings));
  return h;
}

test("reconnecting to an idle runtime clears settled prompt and compaction signals", () => {
  const h = restoreHarness();
  h.restore("s", { running: false });
  assert.equal(h.running, false);
  assert.equal(h.bash, false);
  assert.equal(h.compacting, false);
  assert.equal(h.bindings.sessionRunningRef.current, false);
  assert.equal(h.actions.at(-1)?.type, "end");
});

test("a delayed idle mount snapshot cannot clear a newer run", () => {
  const h = restoreHarness();
  h.restore("s", { running: false }, 1, 1);
  assert.equal(h.running, true);
  assert.equal(h.bash, false);
  assert.equal(h.compacting, true);
  assert.equal(h.bindings.sessionRunningRef.current, true);
  assert.deepEqual(h.actions, []);
});

for (const field of ["isStreaming", "isPromptRunning", "isBashRunning", "isCompacting"]) {
  test(`restoring an active ${field} keeps its corresponding busy signal`, () => {
    const h = restoreHarness();
    h.restore("s", { running: true, state: { [field]: true } }, 1, 2);
    assert.equal(h.bindings.sessionRunningRef.current, true);
    if (field === "isBashRunning") assert.equal(h.bash, true);
    else if (field === "isCompacting") assert.equal(h.compacting, true);
    else assert.equal(h.running, true);
  });
}

test("a late streaming state cannot replace a replayed active tool", () => {
  const h = restoreHarness();
  h.phase = { kind: "running_tools", tools: [{ id: "tool-1", name: "bash" }] };
  h.bindings.activeToolIdsRef.current.add("tool-1");
  h.restore("s", { running: true, state: { isStreaming: true } }, 1, 2);
  assert.equal(h.phase.kind, "running_tools");
  assert.equal(h.phase.tools[0].id, "tool-1");
});

test("an older idle snapshot cannot settle a replayed active tool", () => {
  const h = restoreHarness();
  h.phase = { kind: "running_tools", tools: [{ id: "tool-1", name: "bash" }] };
  h.bindings.activeToolIdsRef.current.add("tool-1");
  h.restore("s", { running: false }, 1, 2);
  assert.equal(h.running, true);
  assert.equal(h.phase.kind, "running_tools");
  assert.deepEqual(h.actions, []);
});

test("a live submission retains its ownership across idle restoration", () => {
  const h = restoreHarness();
  const submission = { runId: 2, requestStarted: false, stopping: false };
  h.bindings.rpcPromptPendingRef.current = submission;
  h.restore("s", { running: false }, 1, 2);
  assert.equal(h.bindings.rpcPromptPendingRef.current, submission);
  assert.equal(h.running, true);
  assert.deepEqual(h.actions, []);
});

function compactionHarness(runtimeState) {
  const h = { compacting: true, fetches: 0, intervals: 0, queueReads: 0, finishes: 0 };
  const bindings = {
    useCallback: fn => fn, useEffect: effect => { h.cleanup = effect(); },
    agentRunning: false, bashRunning: false, isCompacting: true, streamState: { isStreaming: false },
    agentRunningRef: { current: false }, bashRunningRef: { current: false }, activeToolIdsRef: { current: new Set() }, toolEventRevisionRef: { current: 0 },
    sessionRunningRef: { current: false }, localCompactionPendingRef: { current: false }, sessionIdRef: { current: "s" }, sessionHookMountedRef: { current: true },
    promptRunIdRef: { current: 1 }, stateRunRevisionRef: { current: 1 }, currentAgentRunIdRef: { current: "run-1" },
    branchScopeRef: { current: "main" }, remotePeerRef: { current: undefined }, queuedDraftProjectionRef: { current: { generation: 1 } },
    sdkAgentActiveRef: { current: false }, rpcPromptPendingRef: { current: false },
    window: { setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => { h.intervals++; return 1; }, clearInterval: () => {}, addEventListener: () => {}, removeEventListener: () => {} },
    document: { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} },
    fetch: async () => { h.fetches++; return { ok: true, json: async () => runtimeState }; },
    apiPath: path => path, syncQueuedDraftResponse: () => { h.queueReads++; }, loadSession: async () => {}, finishPromptWithoutStream: async () => { h.finishes++; },
    setIsCompacting: value => { h.compacting = value; }, setBashRunning: () => {}, setPendingBash: () => {},
  };
  const body = slice("  const reconcileAgentState = useCallback", "  useEffect(() => {\n    agentRunningRef.current = agentRunning;");
  h.reconcile = new Function(...Object.keys(bindings), `${body}; return reconcileAgentState;`)(...Object.values(bindings));
  h.bindings = bindings;
  return h;
}

test("a missed stream-end event is reconciled even when the agent flag already cleared", async () => {
  const h = compactionHarness({ running: false });
  h.bindings.isCompacting = false;
  h.bindings.streamState.isStreaming = true;
  await h.reconcile("s");
  assert.equal(h.fetches, 1);
  assert.equal(h.finishes, 1);
  h.cleanup?.();
});

test("a missed compaction-end event is reconciled without a running parent prompt", async () => {
  const h = compactionHarness({ running: true, state: { isCompacting: false } });
  await h.reconcile("s");
  assert.equal(h.fetches, 1);
  assert.equal(h.intervals, 1);
  assert.equal(h.compacting, false);
  h.cleanup?.();
});

test("a fresh idle reconciliation can settle after a tool-end event was missed", async () => {
  const h = compactionHarness({ running: false });
  h.bindings.agentRunningRef.current = true;
  h.bindings.activeToolIdsRef.current.add("old-tool");
  await h.reconcile("s");
  assert.equal(h.finishes, 1);
  h.cleanup?.();
});

test("an idle reconciliation cannot settle across a newer tool event", async () => {
  let resolve;
  const h = compactionHarness(new Promise(done => { resolve = done; }));
  h.bindings.agentRunningRef.current = true;
  const pending = h.reconcile("s");
  h.bindings.activeToolIdsRef.current.add("new-tool");
  h.bindings.toolEventRevisionRef.current += 1;
  resolve({ running: false });
  await pending;
  assert.equal(h.finishes, 0);
  h.cleanup?.();
});

test("compaction recovery keeps a genuinely active compaction live", async () => {
  const h = compactionHarness({ running: true, state: { isCompacting: true } });
  await h.reconcile("s");
  assert.equal(h.fetches, 1);
  assert.equal(h.compacting, true);
  h.cleanup?.();
});

test("in-flight local submission cannot be settled by compaction reconciliation", async () => {
  const h = compactionHarness({ running: false });
  const submission = { runId: 1, requestStarted: false, stopping: false };
  h.bindings.rpcPromptPendingRef.current = submission;
  await h.reconcile("s");
  assert.equal(h.fetches, 0);
  assert.equal(h.bindings.rpcPromptPendingRef.current, submission);
  assert.equal(h.compacting, true);
  h.cleanup?.();
});

test("an idle snapshot cannot cancel a locally admitted compaction", async () => {
  const h = compactionHarness({ running: true, state: { isCompacting: false } });
  h.bindings.localCompactionPendingRef.current = true;
  await h.reconcile("s");
  assert.equal(h.compacting, true);
  h.cleanup?.();
});

test("an idle snapshot from the previous revision cannot end new compaction", async () => {
  let resolve;
  const h = compactionHarness(new Promise(done => { resolve = done; }));
  const pending = h.reconcile("s");
  h.bindings.stateRunRevisionRef.current += 1;
  resolve({ running: true, state: { isCompacting: false } });
  await pending;
  assert.equal(h.compacting, true);
  h.cleanup?.();
});

test("a malformed runtime response preserves compaction while still reconciling queue data", async () => {
  const h = compactionHarness({});
  await h.reconcile("s");
  assert.equal(h.fetches, 1);
  assert.equal(h.queueReads, 1);
  assert.equal(h.compacting, true);
  h.cleanup?.();
});
