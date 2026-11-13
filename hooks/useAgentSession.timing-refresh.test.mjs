import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const start = source.indexOf("  const refreshSessionTiming = useCallback");
const end = source.indexOf("  const refreshSessionStats = useCallback", start);
assert.ok(start >= 0 && end > start);
const callback = stripTypeScriptTypes(`${source.slice(start, end)}\nglobalThis.refresh = refreshSessionTiming;`);
const statsStart = source.indexOf("  const refreshSessionStats = useCallback");
const statsEnd = source.indexOf("  // A transcript page carries", statsStart);
assert.ok(statsStart >= 0 && statsEnd > statsStart);
const statsCallback = stripTypeScriptTypes(`${source.slice(statsStart, statsEnd)}\nglobalThis.refreshStats = refreshSessionStats;`);

function harness(state = { phase: "current", runtimeLeafId: "history", viewedLeafId: "history", ready: true }) {
  const requests = [];
  const ctx = {
    useCallback: (fn) => fn,
    apiPath: (path) => `/api/${path}`,
    URLSearchParams,
    AbortSignal,
    encodeURIComponent,
    sessionIdRef: { current: "s" },
    remotePeerRef: { current: null },
    branchScopeRef: { current: "local:s" },
    branchRef: { current: { state } },
    sessionHookMountedRef: { current: true },
    sessionLoadGenerationRef: { current: 1 },
    sessionTimingRequestGenerationRef: { current: 0 },
    data: { sessionId: "s", timing: { effectiveMs: -1 } },
    fetch: (url) => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
    setData: (update) => { ctx.data = update(ctx.data); },
  };
  vm.createContext(ctx);
  vm.runInContext(callback, ctx);
  return { ctx, requests };
}

function statsHarness() {
  const requests = [];
  const overrides = [];
  const ctx = {
    useCallback: (fn) => fn,
    sessionIdRef: { current: "s" },
    remotePeerRef: { current: null },
    sessionStatsRequestGenerationRef: { current: 0 },
    sendAgentCommandR: (_sid, command) => new Promise((resolve, reject) => requests.push({ command, resolve, reject })),
    setSessionStatsOverride: (value) => overrides.push(value),
  };
  vm.createContext(ctx);
  vm.runInContext(statsCallback, ctx);
  return { ctx, requests, overrides };
}

function response(timing, leafId = "history") {
  return { ok: true, json: async () => ({ sessionId: "s", leafId, timing }) };
}

test("session stats refresh fails safely, then recovers the current lightweight metrics", async () => {
  const h = statsHarness();
  const failed = h.ctx.refreshStats("s");
  assert.equal(h.requests.length, 1);
  h.requests[0].reject(new Error("stats unavailable"));
  await failed;
  assert.equal(h.overrides.length, 0);

  const recovered = h.ctx.refreshStats("s");
  h.requests[1].resolve({ sessionId: "s", tokens: 220, totalMessages: 4, cost: 0, costStatus: "unavailable" });
  await recovered;
  assert.equal(h.overrides.length, 1);
  assert.equal(h.overrides[0].stats.tokens, 220);
  assert.equal(h.overrides[0].peer, null);
});

test("session stats ignore out-of-order, session and peer-scope changes", async () => {
  const h = statsHarness();
  const older = h.ctx.refreshStats("s");
  const newer = h.ctx.refreshStats("s");
  h.requests[1].resolve({ sessionId: "s", tokens: 2 });
  await newer;
  h.requests[0].resolve({ sessionId: "s", tokens: 1 });
  await older;
  assert.equal(h.overrides.at(-1).stats.tokens, 2);

  const changes = [
    (ctx) => { ctx.sessionIdRef.current = "other"; },
    (ctx) => { ctx.remotePeerRef.current = "debian"; },
  ];
  for (const change of changes) {
    const before = h.overrides.length;
    const pending = h.ctx.refreshStats("s");
    change(h.ctx);
    h.requests.at(-1).resolve({ sessionId: "s", tokens: 99 });
    await pending;
    assert.equal(h.overrides.length, before);
    h.ctx.sessionIdRef.current = "s";
    h.ctx.remotePeerRef.current = null;
  }
});

test("timing refresh always requests the viewed leaf, including current history and root", async () => {
  for (const [phase, leaf] of [["current", "history"], ["preview", "preview"], ["current", null], ["preview", null]]) {
    const h = harness({ phase, runtimeLeafId: "history", viewedLeafId: leaf, ready: true });
    const pending = h.ctx.refresh("s");
    assert.equal(h.requests.length, 1);
    const query = new URL(h.requests[0].url, "http://fixture").searchParams;
    const historyTiming = { effectiveMs: 6_000, modelResponseMs: 4_000 };
    const diskHeadTiming = { effectiveMs: 10_000, modelResponseMs: 6_000 };
    h.requests[0].resolve(response(query.has("leafId") && query.get("leafId") === (leaf ?? "") ? historyTiming : diskHeadTiming, leaf));
    await pending;
    assert.equal(query.get("metadataOnly"), "1");
    assert.equal(query.has("leafId"), true, `${phase}:${leaf}`);
    assert.equal(query.get("leafId"), leaf ?? "", `${phase}:${leaf}`);
    assert.equal(h.ctx.data.timing.effectiveMs, 6_000, `${phase}:${leaf}`);
    assert.equal(h.ctx.data.timing.modelResponseMs, 4_000, `${phase}:${leaf}`);
  }
});

test("timing refresh recovers when the initial metadata load failed", async () => {
  const h = harness();
  h.ctx.data = null;
  const pending = h.ctx.refresh("s");
  h.requests[0].resolve({ ok: true, json: async () => ({
    sessionId: "s", filePath: "/session.jsonl", tree: [], leafId: "history",
    context: { messages: [], entryIds: [], thinkingLevel: "off", model: null },
    timing: { effectiveMs: 6_000, modelResponseMs: 4_000 },
  }) });
  await pending;
  assert.equal(h.ctx.data?.sessionId, "s");
  assert.equal(h.ctx.data?.timing.effectiveMs, 6_000);
  assert.equal(h.ctx.data?.timing.modelResponseMs, 4_000);
});

test("timing refresh rejects metadata for a different session", async () => {
  for (const data of [null, { sessionId: "s", timing: { effectiveMs: -1 } }]) {
    const h = harness();
    h.ctx.data = data;
    const pending = h.ctx.refresh("s");
    h.requests[0].resolve({ ok: true, json: async () => ({ sessionId: "other", leafId: "history", timing: { effectiveMs: 6_000 } }) });
    await pending;
    assert.equal(h.ctx.data, data);
  }
});

test("timing refresh rejects metadata for a different branch", async () => {
  const h = harness();
  const original = h.ctx.data;
  const pending = h.ctx.refresh("s");
  h.requests[0].resolve(response({ effectiveMs: 6_000 }, "other"));
  await pending;
  assert.equal(h.ctx.data, original);
});

test("timing refresh does not create partial metadata after a failed load", async () => {
  const h = harness();
  h.ctx.data = null;
  const pending = h.ctx.refresh("s");
  h.requests[0].resolve(response({ effectiveMs: 6_000 }));
  await pending;
  assert.equal(h.ctx.data, null);
});

test("queued timing updates cannot cross a session or branch change", async () => {
  for (const change of [
    (ctx) => { ctx.sessionIdRef.current = "other"; },
    (ctx) => { ctx.branchRef.current.state = { ...ctx.branchRef.current.state, viewedLeafId: "other" }; },
  ]) {
    const h = harness();
    const original = h.ctx.data;
    let update;
    h.ctx.setData = (fn) => { update = fn; };
    const pending = h.ctx.refresh("s");
    h.requests[0].resolve(response({ effectiveMs: 6_000 }));
    await pending;
    assert.equal(typeof update, "function");
    change(h.ctx);
    assert.equal(update(original), original);
  }
});

test("timing refresh does not guess a branch before it is ready", async () => {
  for (const state of [
    { phase: "current", viewedLeafId: null, ready: false },
    { phase: "preview", viewedLeafId: "history", ready: false },
    { phase: "loading", viewedLeafId: "history", ready: true },
    { phase: "switching", viewedLeafId: "history", ready: true },
    { phase: "unknown", viewedLeafId: "history", ready: false },
  ]) {
    const h = harness(state);
    const pending = h.ctx.refresh("s");
    const requestCount = h.requests.length;
    if (requestCount > 0) h.requests[0].resolve(response({ effectiveMs: 10_000 }));
    await pending;
    assert.equal(requestCount, 0, state.phase);
    assert.equal(h.ctx.data.timing.effectiveMs, -1);
  }
});

test("newer same-branch refresh wins even when an older response arrives last", async () => {
  const h = harness();
  const older = h.ctx.refresh("s");
  const newer = h.ctx.refresh("s");
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve(response({ effectiveMs: 6_000 }));
  await newer;
  h.requests[0].resolve(response({ effectiveMs: 10_000 }));
  await older;
  assert.equal(h.ctx.data.timing.effectiveMs, 6_000);
});

test("late timing cannot cross a branch round-trip, session, peer, scope, or unmount", async () => {
  const changes = {
    "branch round-trip": (ctx) => {
      const original = ctx.branchRef.current.state;
      ctx.branchRef.current.state = { ...original, viewedLeafId: "other" };
      ctx.sessionLoadGenerationRef.current += 1;
      ctx.branchRef.current.state = original;
      ctx.sessionLoadGenerationRef.current += 1;
    },
    session: (ctx) => { ctx.sessionIdRef.current = "other"; },
    peer: (ctx) => { ctx.remotePeerRef.current = "other"; },
    scope: (ctx) => { ctx.branchScopeRef.current = "other"; },
    unmount: (ctx) => { ctx.sessionHookMountedRef.current = false; },
    unready: (ctx) => { ctx.branchRef.current.state = { ...ctx.branchRef.current.state, ready: false }; },
    phase: (ctx) => { ctx.branchRef.current.state = { ...ctx.branchRef.current.state, phase: "preview" }; },
    branch: (ctx) => { ctx.branchRef.current.state = { ...ctx.branchRef.current.state, viewedLeafId: "other" }; },
  };
  for (const [name, change] of Object.entries(changes)) {
    const h = harness();
    const pending = h.ctx.refresh("s");
    change(h.ctx);
    h.requests[0].resolve(response({ effectiveMs: 10_000 }));
    await pending;
    assert.equal(h.ctx.data.timing.effectiveMs, -1, name);
  }
});
