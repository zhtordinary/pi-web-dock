import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const leaseStart = source.indexOf("  // Only the foreground Reader owns");
const leaseEnd = source.indexOf("  const respondToExtensionUi", leaseStart);
const selectedStart = source.indexOf("  // Selected sessions receive");
assert.ok(selectedStart >= 0 && leaseStart > selectedStart && leaseEnd > leaseStart);
const leaseEffect = stripTypeScriptTypes(source.slice(leaseStart, leaseEnd));
const selectedEffect = stripTypeScriptTypes(source.slice(selectedStart, leaseStart));
const ref = current => ({ current });
const flush = () => new Promise(resolve => setImmediate(resolve));

function lifecycleHarness({ background = false, fetch } = {}) {
  const calls = [], effects = [], listeners = new Map();
  let cleanup, tick, cleared = 0;
  const ctx = {
    session: { id: "s" }, opts: { background }, remotePeer: "peer-A",
    branchScopeRef: ref("peer-A:s"), sessionHookMountedRef: ref(true),
    sessionIdRef: ref("s"), sessionPropIdRef: ref("s"), remotePeerRef: ref("peer-A"),
    SESSION_LEASE_RENEW_INTERVAL_MS: 1000,
    useEffect: fn => { cleanup = fn(); },
    setInterval: (fn, milliseconds) => { assert.equal(milliseconds, 1000); tick = fn; return 7; },
    clearInterval: id => { assert.equal(id, 7); cleared++; },
    document: { visibilityState: "visible", addEventListener: (key, fn) => listeners.set(key, fn),
      removeEventListener: (key, fn) => { assert.equal(listeners.get(key), fn); listeners.delete(key); } },
    apiPath: path => `/peer-A/${path}`,
    fetch: async (...args) => { calls.push(args); return fetch ? fetch(...args) : { ok: true, json: async () => ({ renewed: 0 }) }; },
    closeEvents: () => effects.push("close"), maintainEventsConnected: sid => effects.push(sid),
    agentRunning: false, bashRunning: false, sessionRunning: false, runtimeAvailable: true, runtimeAvailableRef: ref(true), setRuntimeAvailable: value => effects.push(["available", value]),
    agentRunningRef: ref(false), bashRunningRef: ref(false), sessionRunningRef: ref(false),
    eventStreamGraceActiveRef: ref(false), eventConnectionRef: ref({ close: () => effects.push("connection-close") }),
  };
  vm.createContext(ctx);
  return { ctx, calls, effects, listeners, mountLease: () => vm.runInContext(leaseEffect, ctx),
    mountSelected: () => vm.runInContext(selectedEffect, ctx), tick: () => tick?.(),
    cleanup: () => cleanup?.(), get scheduled() { return Boolean(tick); }, get cleared() { return cleared; } };
}

test("foreground selected session lease uses the selected peer and closes an absent runtime instead of reconnecting on renewed zero", async () => {
  const h = lifecycleHarness();
  h.mountLease();
  h.tick(); await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], "/peer-A/agent/s/lease");
  assert.equal(h.calls[0][1].method, "POST");
  assert.equal(h.calls[0][1].cache, "no-store");
  assert.deepEqual(h.effects, ["close", ["available", false]]);
  h.cleanup();
  h.tick(); await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.cleared, 1);
});

for (const field of ["remotePeerRef", "sessionIdRef", "sessionPropIdRef", "branchScopeRef", "sessionHookMountedRef"]) {
  test(`lease ownership change fences interval and late replies: ${field}`, async () => {
    let resolve;
    const h = lifecycleHarness({ fetch: () => new Promise(done => { resolve = done; }) });
    h.mountLease();
    h.tick();
    h.tick(); // One renewal in flight.
    assert.equal(h.calls.length, 1);
    h.ctx[field].current = field === "sessionHookMountedRef" ? false : "different";
    resolve({ ok: true, json: async () => ({ renewed: 0 }) });
    await flush();
    h.tick(); await flush();
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.effects, []);
    h.cleanup();
  });
}

test("lease cleanup also fences an in-flight JSON response and removes the visibility listener", async () => {
  let resolveJson;
  const h = lifecycleHarness({ fetch: async () => ({ ok: true, json: () => new Promise(done => { resolveJson = done; }) }) });
  h.mountLease(); h.tick(); await flush();
  const visible = h.listeners.get("visibilitychange");
  h.cleanup();
  resolveJson({ renewed: 0 }); await flush();
  visible(); await flush();
  assert.deepEqual(h.effects, []);
  assert.equal(h.calls.length, 1);
  assert.equal(h.listeners.size, 0);
});

test("background readers neither renew a lease nor connect an idle selected session", () => {
  const h = lifecycleHarness({ background: true });
  h.mountLease();
  assert.equal(h.scheduled, false);
  assert.equal(h.listeners.size, 0);
  h.mountSelected();
  assert.deepEqual(h.effects, []);
});

test("Strict Mode re-subscription restores mounted ownership before maintaining the selected stream", () => {
  const h = lifecycleHarness();
  const maintains = [];
  h.ctx.maintainEventsConnected = sid => maintains.push([sid, h.ctx.sessionHookMountedRef.current]);
  for (let mount = 0; mount < 2; mount++) {
    h.ctx.sessionHookMountedRef.current = false;
    h.mountSelected();
    h.cleanup();
  }
  assert.deepEqual(maintains, [["s", true], ["s", true]]);
  assert.deepEqual(h.effects, ["connection-close", "connection-close"]);
});

test("a cold selected session observes its file without renewing a nonexistent runtime", () => {
  const h = lifecycleHarness(); h.ctx.runtimeAvailable = false; h.ctx.runtimeAvailableRef.current = false;
  h.mountSelected(); h.mountLease(); assert.deepEqual(h.effects, ["s"]); assert.equal(h.scheduled, false);
  assert.deepEqual(h.calls, []);
});
