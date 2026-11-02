import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { readFile } from "node:fs/promises";
import { QueuedDraftProjection } from "../lib/queued-draft.ts";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const callback = source.slice(source.indexOf("  const updateRuntimeSettings = useCallback("), source.indexOf("  const handleModelChange = useCallback("));
function harness(send) {
  const writes = [];
  const ctx = { useCallback: fn => fn, t: key => key, sendAgentCommandR: send, sessionIdRef: { current: "one" }, remotePeerRef: { current: "local" }, sessionHookMountedRef: { current: true }, modelSwitchPendingRef: { current: false }, runtimeSettingsRevisionRef: { current: 0 }, ensuringNewSessionRef: { current: null }, agentRunningRef: { current: true }, isNew: false, addNotice: value => writes.push(["notice", value]), setRuntimeSettingsUpdating: value => writes.push(["pending", value]), setModelSwitching: value => writes.push(["modelPending", value]), setCurrentModelOverride: value => writes.push(["model", value]), setNewSessionModel() {}, setThinkingLevel: value => writes.push(["thinking", value]), setCurrentThinkingOverride() {}, asConcreteThinkingLevel: value => value, setFastModeSelection() {}, setFastModeRuntimeStatus() {} };
  vm.createContext(ctx);
  vm.runInContext(stripTypeScriptTypes(`${callback} globalThis.update = updateRuntimeSettings;`), ctx);
  return { ctx, writes };
}
test("runtime settings serialize commands while a stream is active without reloading history", async () => {
  let resolve;
  let sends = 0;
  const { ctx, writes } = harness(() => { sends++; return new Promise(done => { resolve = done; }); });
  const applied = [];
  const first = ctx.update({ type: "set_model" }, result => applied.push(result));
  await ctx.update({ type: "set_thinking_level" }, assert.fail);
  assert.equal(sends, 1);
  resolve({ model: "next" });
  await first;
  assert.deepEqual(applied, [{ model: "next" }]);
  assert.equal(ctx.modelSwitchPendingRef.current, false);
  assert.ok(writes.some(([kind, value]) => kind === "notice" && value.type === "info"));
  assert.doesNotMatch(callback, /loadSession|setMessages|dispatch\(/);
});
test("late settings reply cannot write into another session or peer", async () => {
  let resolve;
  const { ctx, writes } = harness(() => new Promise(done => { resolve = done; }));
  const pending = ctx.update({ type: "set_fast_mode" }, assert.fail);
  ctx.remotePeerRef.current = "other";
  resolve({ mode: "fast" });
  await pending;
  assert.equal(writes.filter(([kind]) => kind === "notice").length, 0);
});
test("a failed settings response reconciles authoritative runtime state, not speculative success", async () => {
  let calls = 0;
  const { ctx, writes } = harness(async () => {
    if (++calls === 1) throw new Error("connection lost");
    return { model: { provider: "test", id: "accepted" }, thinkingLevel: "high" };
  });
  await ctx.update({ type: "set_model" }, assert.fail);
  assert.equal(calls, 2);
  assert.ok(writes.some(([kind]) => kind === "model"));
  assert.ok(writes.some(([kind, value]) => kind === "thinking" && value === "high"));
});

const stateCallback = source.slice(source.indexOf("  const loadAgentState = useCallback"), source.indexOf("  const loadSession = useCallback"));
const queueResponseCallback = source.slice(source.indexOf("  const syncQueuedDraftResponse ="), source.indexOf("  const eventConnectionRef"));
function stateHarness(get, hydrate) {
  const writes = [];
  const ctx = {
    useCallback: fn => fn, AbortSignal, encodeURIComponent, apiPath: path => path,
    sessionHookMountedRef: { current: true }, sessionIdRef: { current: "one" },
    currentAgentRunIdRef: { current: null }, promptRunIdRef: { current: 0 },
    stateLoadGenerationRef: { current: 0 }, stateLoadInFlightRef: { current: null }, stateRunRevisionRef: { current: 0 }, runtimeSettingsReadGenerationRef: { current: 0 },
    branchScopeRef: { current: "local:one" }, remotePeerRef: { current: "local" },
    branchRef: { current: null }, sessionStatePendingRef: { current: true }, runtimeAvailableRef: { current: false }, activeToolIdsRef: { current: new Set() }, toolEventRevisionRef: { current: 0 },
    queuedDraftProjectionRef: { current: new QueuedDraftProjection() },
    cacheKeyForSession: sid => `local:${sid}`,
    syncLiveModel() {}, syncQueuedDrafts: (...args) => writes.push(["syncQueuedDrafts", ...args]),
    fetch: get, sendAgentCommandR: hydrate, console: { error() {} },
  };
  for (const match of stateCallback.matchAll(/\b(set[A-Z]\w*)\(/g)) {
    ctx[match[1]] = value => writes.push([match[1], value]);
  }
  vm.createContext(ctx);
  vm.runInContext(stripTypeScriptTypes(`${queueResponseCallback}\n${stateCallback} globalThis.load = loadAgentState;`), ctx);
  return { ctx, writes };
}
const response = payload => ({ ok: true, json: async () => payload });

test("idle unknown preference is retryable without POST and a later persisted result recovers", async () => {
  let gets = 0, posts = 0;
  const { ctx, writes } = stateHarness(async () => ++gets === 1
    ? { ok: false, status: 409, json: async () => ({ running: false, code: "session_state_unavailable" }) }
    : response({ running: false, state: { autoCompactionEnabled: false } }), () => { posts++; assert.fail("cold read must not POST"); });
  assert.equal((await ctx.load("one")).running, false);
  assert.ok(writes.some(([name, state]) => name === "setRuntimeSettingsRead" && state.status === "error"));
  assert.equal(ctx.sessionStatePendingRef.current, false);
  assert.equal(writes.some(([name]) => name === "setAutoCompactionEnabled"), false);
  assert.equal((await ctx.load("one")).state.autoCompactionEnabled, false);
  assert.equal(gets, 2); assert.equal(posts, 0);
});

test("a state read straddling a tool start is retried without revoking availability", async () => {
  let gets = 0, release;
  const { ctx, writes } = stateHarness(() => ++gets === 1
    ? new Promise(resolve => { release = resolve; })
    : Promise.resolve(response({ running: true, state: { isStreaming: true, autoCompactionEnabled: false } })), assert.fail);
  ctx.runtimeAvailableRef.current = true;
  const pending = ctx.load("one");
  ctx.activeToolIdsRef.current.add("active-tool");
  ctx.toolEventRevisionRef.current += 1;
  release(response({ running: false }));
  assert.equal((await pending).running, true);
  assert.equal(gets, 2);
  assert.equal(ctx.runtimeAvailableRef.current, true);
  assert.equal(writes.some(([name, value]) => name === "setRuntimeAvailable" && value === false), false);
});

test("a second tool transition during the retry leaves availability intact and reports an error", async () => {
  const requests = [];
  const { ctx, writes } = stateHarness(() => new Promise(resolve => requests.push(resolve)), assert.fail);
  ctx.runtimeAvailableRef.current = true;
  const pending = ctx.load("one");
  ctx.activeToolIdsRef.current.add("active-tool");
  ctx.toolEventRevisionRef.current += 1;
  requests[0](response({ running: false }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  ctx.toolEventRevisionRef.current += 1;
  requests[1](response({ running: false }));
  assert.equal(await pending, null);
  assert.equal(ctx.runtimeAvailableRef.current, true);
  assert.equal(writes.some(([name, value]) => name === "setRuntimeAvailable" && value === false), false);
  assert.ok(writes.some(([name, value]) => name === "setRuntimeSettingsRead" && value.status === "error"));
});

test("a fresh idle snapshot clears tools that ended while their end event was missed", async () => {
  const { ctx, writes } = stateHarness(async () => response({ running: false, state: { autoCompactionEnabled: false } }), assert.fail);
  ctx.activeToolIdsRef.current.add("old-tool");
  assert.equal((await ctx.load("one")).running, false);
  assert.equal(ctx.activeToolIdsRef.current.size, 0);
  assert.ok(writes.some(([name, value]) => name === "setActiveToolResults" && value.size === 0));
});

test("late idle GET cannot hydrate a different session or peer", async () => {
  for (const key of ["sessionIdRef", "remotePeerRef", "branchScopeRef"]) {
    let resolve;
    let posts = 0;
    const { ctx, writes } = stateHarness(() => new Promise(done => { resolve = done; }), async () => { posts++; });
    const pending = ctx.load("one");
    const initialWrites = writes.length;
    ctx[key].current = "other";
    resolve(response({ running: false }));
    assert.equal(await pending, null);
    assert.equal(posts, 0);
    assert.equal(writes.length, initialWrites);
  }
});

test("late persisted GET or read error cannot overwrite a newer run, session or peer", async () => {
  for (const key of ["stateRunRevisionRef", "remotePeerRef", "sessionIdRef"]) {
    for (const failure of [true, false]) {
      let resolve, reject;
      const { ctx, writes } = stateHarness(() => new Promise((done, fail) => { resolve = done; reject = fail; }), assert.fail);
      const pending = ctx.load("one"); const before = writes.length;
      ctx[key].current = key === "stateRunRevisionRef" ? 1 : "other";
      if (key === "stateRunRevisionRef") ctx.currentAgentRunIdRef.current = "new-run";
      if (failure) reject(new Error("late failure"));
      else resolve(response({ running: false, state: { autoCompactionEnabled: true } }));
      assert.equal(await pending, null); assert.equal(writes.length, before);
    }
  }
});

test("missing preference is an error rather than a global default or an off value", async () => {
  const { ctx, writes } = stateHarness(async () => response({ running: true, state: {} }), assert.fail);
  await ctx.load("one");
  assert.ok(writes.some(([name, value]) => name === "setRuntimeSettingsRead" && value.status === "error"));
  assert.equal(writes.some(([name]) => name === "setAutoCompactionEnabled"), false);
});

test("late automatic compaction writes cannot update another session or peer", async () => {
  const callback = source.slice(source.indexOf("  const handleAutoCompactionChange = useCallback"), source.indexOf("  const retryRuntimeSettings = useCallback"));
  for (const key of ["sessionIdRef", "remotePeerRef"]) {
    let resolve;
    const commands = [];
    const writes = [];
    const ctx = {
      useCallback: fn => fn, isNew: false, newSessionDraftKey: null,
      sessionHookMountedRef: { current: true }, sessionIdRef: { current: "one" },
      remotePeerRef: { current: "local" }, branchScopeRef: { current: "local:one" },
      runtimeSettingsReadGenerationRef: { current: 0 }, newSessionPromotedRef: { current: true },
      ensureNewSession() {}, sendAgentCommandR: (_sid, command) => { commands.push(command.type); return new Promise(done => { resolve = done; }); },
      sendTransientSessionCommand: async options => options.send(options.sessionId),
      setRuntimeSettingsRead: value => writes.push(["read", value]),
      setAutoCompactionEnabled: value => writes.push(["enabled", value]),
      addNotice: value => writes.push(["notice", value]),
    };
    vm.createContext(ctx);
    vm.runInContext(stripTypeScriptTypes(`${callback} globalThis.change = handleAutoCompactionChange;`), ctx);
    const pending = ctx.change(false);
    const initialWrites = writes.length;
    ctx[key].current = "other";
    resolve({});
    await pending;
    assert.equal(writes.length, initialWrites);
    assert.deepEqual(commands, ["initialize_runtime"]);
  }
});

for (const enabled of [true, false]) {
  test(`explicit cold compaction choice ${enabled} initializes before writing without sending a prompt`, async () => {
    const callback = source.slice(source.indexOf("  const handleAutoCompactionChange = useCallback"), source.indexOf("  const retryRuntimeSettings = useCallback"));
    const calls = [];
    const ctx = {
      useCallback: fn => fn, isNew: false, newSessionDraftKey: null,
      sessionHookMountedRef: { current: true }, sessionIdRef: { current: "one" },
      remotePeerRef: { current: "local" }, branchScopeRef: { current: "local:one" },
      runtimeSettingsReadGenerationRef: { current: 0 }, newSessionPromotedRef: { current: true },
      ensureNewSession: assert.fail,
      sendAgentCommandR: async (sid, command) => calls.push([sid, command.type, command.enabled]),
      sendTransientSessionCommand: async options => options.send(options.sessionId),
      setRuntimeSettingsRead() {}, setAutoCompactionEnabled: value => calls.push(["applied", value]),
      addNotice: assert.fail,
    };
    vm.createContext(ctx);
    vm.runInContext(stripTypeScriptTypes(`${callback} globalThis.change = handleAutoCompactionChange;`), ctx);
    await ctx.change(enabled);
    assert.deepEqual(calls, [["one", "initialize_runtime", undefined], ["one", "set_auto_compaction", enabled], ["applied", enabled]]);
  });
}

test("a newer preference result invalidates older preference hydration without discarding run state", async () => {
  let resolve;
  const { ctx, writes } = stateHarness(() => new Promise(done => { resolve = done; }), assert.fail);
  const pending = ctx.load("one");
  ctx.runtimeSettingsReadGenerationRef.current++;
  resolve(response({ running: true, state: { autoCompactionEnabled: false } }));
  assert.equal((await pending).running, true);
  assert.equal(writes.some(([name]) => name === "setAutoCompactionEnabled"), false);
  assert.equal(ctx.sessionStatePendingRef.current, false);
});

test("a settings read error stops the automatic retry timer rather than polling indefinitely", () => {
  const start = source.indexOf("  // Unknown run state stays fail-closed;");
  const effect = source.slice(start, source.indexOf("  const retrySessionRead = useCallback", start));
  let scheduled = 0;
  const ctx = {
    useEffect: callback => callback(), session: { id: "one" }, sessionStatePending: true,
    runtimeSettingsRead: { status: "error", error: "HTTP 500" },
    loadAgentState: assert.fail, maintainEventsConnected: assert.fail, restoreLoadedRunState: assert.fail,
    window: { setInterval() { scheduled++; }, addEventListener: assert.fail },
  };
  vm.createContext(ctx);
  vm.runInContext(stripTypeScriptTypes(effect), ctx);
  assert.equal(scheduled, 0);
});

test("explicit settings retry uses the current session and restores its authoritative run state", async () => {
  const callback = source.slice(source.indexOf("  const retryRuntimeSettings = useCallback"), source.indexOf("  const { view: queueRecoveryView"));
  const calls = [];
  const state = { running: false, state: { autoCompactionEnabled: false } };
  const ctx = {
    useCallback: fn => fn, sessionIdRef: { current: "one" }, sessionSettlementGenerationRef: { current: 3 },
    setRuntimeSettingsRead: value => calls.push(["read", value.status]),
    setSettingsRetryRevision: assert.fail,
    maintainEventsConnected: sid => calls.push(["events", sid]),
    loadAgentState: async sid => { calls.push(["load", sid]); return state; },
    restoreLoadedRunState: (...args) => calls.push(["restore", ...args]),
  };
  vm.createContext(ctx);
  vm.runInContext(stripTypeScriptTypes(`${callback} globalThis.retry = retryRuntimeSettings;`), ctx);
  await ctx.retry();
  assert.deepEqual(calls, [["read", "loading"], ["events", "one"], ["load", "one"], ["restore", "one", state, 3]]);
});

test("global draft preference never hydrates an existing session, even if its runtime is unavailable", () => {
  const effect = source.slice(source.indexOf("  useEffect(() => {\n    if (!isNew || sessionIdRef.current) return;"), source.indexOf("  const [systemPrompt"));
  let loads = 0;
  const ctx = {
    useEffect: callback => callback(), isNew: true, sessionIdRef: { current: "existing" },
    apiPath() {}, remotePeer: "local", settingsRetryRevision: 0, newSessionDraftKey: "draft",
    setAutoCompactionEnabled: assert.fail, fetch: () => { loads++; },
  };
  vm.createContext(ctx);
  vm.runInContext(stripTypeScriptTypes(effect), ctx);
  assert.equal(loads, 0);
});


test("one bounded GET cannot be superseded by retry intervals and explicit retry recovers", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let gets = 0, posts = 0, recover = false;
  const { ctx, writes } = stateHarness((_path, options) => {
    gets++;
    assert.ok(options.signal);
    if (recover) return Promise.resolve(response({ running: false, state: { autoCompactionEnabled: false } }));
    return new Promise((_, fail) => setTimeout(() => fail(new Error("state GET deadline exceeded")), 15_000));
  }, () => { posts++; assert.fail("GET-only state read"); });
  const start = source.indexOf("  // Unknown run state stays fail-closed;");
  const effect = source.slice(start, source.indexOf("  const retrySessionRead = useCallback", start));
  let cleanup;
  const renderEffect = () => { cleanup?.(); cleanup = undefined; vm.runInContext(stripTypeScriptTypes(effect), ctx); };
  ctx.session = { id: "one" };
  ctx.sessionStatePending = true;
  ctx.runtimeSettingsRead = { status: "loading" };
  ctx.sessionSettlementGenerationRef = { current: 0 };
  ctx.setSettingsRetryRevision = assert.fail;
  ctx.maintainEventsConnected = () => {};
  ctx.restoreLoadedRunState = () => {};
  ctx.window = { setInterval, clearInterval, addEventListener() {}, removeEventListener() {} };
  ctx.useEffect = callback => { cleanup = callback(); };
  ctx.setRuntimeSettingsRead = value => {
    writes.push(["setRuntimeSettingsRead", value]);
    const previous = ctx.runtimeSettingsRead.status;
    ctx.runtimeSettingsRead = value;
    if (previous !== value.status) renderEffect();
  };
  ctx.setAutoCompactionEnabled = value => {
    writes.push(["setAutoCompactionEnabled", value]);
    ctx.runtimeSettingsReadGenerationRef.current++;
    ctx.setRuntimeSettingsRead({ status: "ready" });
  };
  ctx.setSessionStatePending = value => {
    if (ctx.sessionStatePending !== value) { ctx.sessionStatePending = value; renderEffect(); }
  };
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  renderEffect();
  t.after(() => cleanup?.());
  const first = ctx.load("one");
  t.mock.timers.tick(1_000); await flush();
  assert.equal(posts, 0);
  t.mock.timers.tick(14_000); await flush(); // real effect's first 15s interval joins the existing chain
  assert.equal(gets, 1);
  assert.equal(ctx.stateLoadGenerationRef.current, 1);
  t.mock.timers.tick(1_000); await flush();
  assert.equal(await first, null);
  assert.equal(ctx.runtimeSettingsRead.status, "error");
  assert.match(ctx.runtimeSettingsRead.error, /deadline/);
  t.mock.timers.tick(45_000); await flush(); // several more intervals must not restart error polling
  assert.equal(gets, 1);
  assert.equal(posts, 0);
  recover = true;
  const retry = source.slice(source.indexOf("  const retryRuntimeSettings = useCallback"), source.indexOf("  const { view: queueRecoveryView"));
  vm.runInContext(stripTypeScriptTypes(`${retry} globalThis.retry = retryRuntimeSettings;`), ctx);
  const retried = ctx.retry();
  t.mock.timers.tick(1_000); await flush();
  await retried;
  assert.equal(gets, 2);
  assert.equal(posts, 0);
  assert.equal(ctx.runtimeSettingsRead.status, "ready");
  assert.ok(writes.some(([name, value]) => name === "setAutoCompactionEnabled" && value === false));
});

test("single-flight joins only the same scope and run; late old finally cannot clear a new flight", async () => {
  const releases = [];
  const { ctx } = stateHarness(() => new Promise(done => releases.push(done)), assert.fail);
  const first = ctx.load("one");
  assert.equal(ctx.load("one"), first);
  ctx.stateRunRevisionRef.current++;
  const next = ctx.load("one");
  assert.notEqual(next, first);
  releases[0](response({ running: true, state: { autoCompactionEnabled: true } }));
  assert.equal(await first, null);
  assert.equal(ctx.stateLoadInFlightRef.current.promise, next);
  releases[1](response({ running: true, state: { autoCompactionEnabled: false } }));
  assert.equal((await next).state.autoCompactionEnabled, false);
  assert.equal(ctx.stateLoadInFlightRef.current, null);
});


for (const preferenceSource of ["persisted", "inherited"]) for (const value of [true, false]) {
  test(`cold GET ${preferenceSource} ${value} is used without a POST runtime hydration`, async () => {
    let posts = 0;
    const { ctx, writes } = stateHarness(async () => response({ running: false, source: preferenceSource, state: { autoCompactionEnabled: value } }), () => { posts++; throw new Error("Git authority unavailable"); });
    const state = await ctx.load("one");
    assert.equal(state.state.autoCompactionEnabled, value);
    assert.equal(posts, 0);
    assert.ok(writes.some(([name, observed]) => name === "setAutoCompactionEnabled" && observed === value));
  });
}
test("cold GET with no verifiable effective value never invokes POST or borrows a global default", async () => {
  let posts = 0;
  const { ctx, writes } = stateHarness(async () => response({ running: false }), async () => { posts++; return { autoCompactionEnabled: true }; });
  const result = await ctx.load("one");
  assert.equal(posts, 0); assert.equal(result.running, false);
  assert.equal(writes.some(([name]) => name === "setAutoCompactionEnabled"), false);
  assert.ok(writes.some(([name, state]) => name === "setRuntimeSettingsRead" && state.status === "error"));
});
test("persisted GET arriving after a preference write cannot overwrite the live choice", async () => {
  let resolve;
  const { ctx, writes } = stateHarness(() => new Promise(done => { resolve = done; }), assert.fail);
  const pending = ctx.load("one");
  ctx.runtimeSettingsReadGenerationRef.current++;
  resolve(response({ running: false, source: "persisted", state: { autoCompactionEnabled: true } }));
  await pending;
  assert.equal(writes.some(([name]) => name === "setAutoCompactionEnabled"), false);
});

test("idle preference projection never overwrites model or live inspection with missing fields", async () => {
  const { ctx } = stateHarness(async () => response({ running: false, state: { autoCompactionEnabled: false } }), assert.fail);
  ctx.syncLiveModel = assert.fail;
  await ctx.load("one");
});

for (const newerQueueEvent of [false, true]) {
  test(`idle state read resets the producer queue only without a newer queue event: ${newerQueueEvent}`, async () => {
    let resolve;
    const { ctx, writes } = stateHarness(() => new Promise(done => { resolve = done; }), assert.fail);
    const projection = ctx.queuedDraftProjectionRef.current;
    const queue = revision => ({ bootId: "boot", queueRevision: revision, steering: [{
      itemId: `item-${revision}`, role: "user", text: "same", hasImages: false, imageCount: 0,
    }], followUp: [] });
    projection.apply("local:one", queue(1));
    const pending = ctx.load("one");
    if (newerQueueEvent) projection.apply("local:one", queue(2));
    resolve(response({ running: false, state: { autoCompactionEnabled: false } }));
    assert.equal((await pending).running, false);
    if (newerQueueEvent) {
      assert.equal(projection.snapshot.queueRevision, 2);
      assert.equal(projection.snapshot.steering[0].itemId, "item-2");
      assert.equal(writes.some(([name]) => name === "syncQueuedDrafts"), false);
    } else {
      assert.equal(projection.snapshot, null);
      assert.deepEqual(writes.filter(([name]) => name === "syncQueuedDrafts"), [["syncQueuedDrafts", "one", null]]);
    }
    assert.ok(writes.some(([name, value]) => name === "setAutoCompactionEnabled" && value === false));
  });
}
