import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url); const core = require("../bin/session-wait-core.cjs");
const owner = { deviceId: "dev", sessionId: "A", sessionFile: "/fixture/A.jsonl" };
const target = { deviceId: "dev", sessionId: "B", sessionFile: "/fixture/B.jsonl" };
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "reader-ui-notification-"));
  const keys = ["PI_WEB_SESSION_WAIT_STATE_ROOT", "PI_WEB_SESSION_WAIT_CHANNEL", "PI_WEB_DEVICE_ID", "PI_WEB_SESSION_ACTIVITY_CONFIG"];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = root; process.env.PI_WEB_SESSION_WAIT_CHANNEL = "ui"; process.env.PI_WEB_DEVICE_ID = "dev"; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "dev" } });
  const previous = globalThis.__piSessions;
  const state = { busy: false, pending: true, generation: "runtime-1", calls: [], beforeAdmission: null };
  const B = { sessionId: "B", sessionFile: target.sessionFile, isAlive: () => true, getPendingUiRequestsSnapshot: () => ({ runtimeStatus: "live", runtimeGeneration: state.generation, requests: state.pending ? [{ id: "question", method: "select", expiresAt: state.expiresAt }] : [] }) };
  const A = { sessionId: "A", sessionFile: owner.sessionFile, isAlive: () => true, isRunning: () => state.busy, inner: {}, hasPendingUserInteraction: () => false, sendNativePeerMessage: async (message, options) => {
    await state.beforeAdmission?.();
    if (options.beforeSubmit && !options.beforeSubmit()) throw new Error("notification_no_longer_pending");
    state.calls.push(message);
  } };
  globalThis.__piSessions = new Map([["A", A], ["B", B]]);
  t.after(() => { rmSync(root, { recursive: true, force: true }); globalThis.__piSessions = previous; for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } });
  const waits = await createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }).import("./session-waits.ts");
  const register = (id = "subscription", patch = {}) => waits.createPersistentWait({ id, owner, target, condition: "ui_request", runtimeGeneration: "runtime-1", continuation: { target: owner, authorizedScope: ["resume_prior_work"], message: "Continue approved work" }, ...patch });
  const publish = patch => waits.persistSessionUiRequestEvent({ sessionId: "B", sessionFile: target.sessionFile, runtimeGeneration: "runtime-1", requestId: "question", method: "select", summary: "Pick a backend", ...patch });
  const outbox = () => Object.values(core.readState(root, "ui").outbox);
  return { root, state, waits, register, publish, outbox, A, B };
}

test("native publisher skips unsubscribed requests and delivers exact details once", async t => {
  const f = await fixture(t);
  assert.equal(f.publish().skipped, true);
  const wait = f.register(); f.publish(); await f.waits.drainLocalOwnerOutboxes();
  assert.equal(f.state.calls.length, 1); const message = f.state.calls[0].content;
  assert.equal(f.state.calls[0].customType, "pi-web:session-peer");
  assert.match(message, /notification only, not authorization; re-read pending_ui/);
  assert.match(message, /"requestId":"question"/); assert.match(message, /"runtimeGeneration":"runtime-1"/); assert.match(message, /"method":"select"/);
  assert.equal(f.outbox()[0].status, "processed");
  f.publish(); f.publish({ waitId: wait.id }); await f.waits.drainLocalOwnerOutboxes(); assert.equal(f.state.calls.length, 1);
});

test("busy UI notification waits for a lifecycle event and never idle-polls the owner", async t => {
  const f = await fixture(t); f.state.busy = true; f.register(); f.publish(); await f.waits.drainLocalOwnerOutboxes();
  assert.equal(f.outbox()[0].status, "queued"); assert.equal(f.state.calls.length, 0);
  f.state.busy = false; await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(f.state.calls.length, 0, "no scheduled polling wake after owner becomes idle");
  f.waits.persistSessionWaitEvent({ type: "agent_end", sessionId: "A", sessionFile: owner.sessionFile }); await f.waits.drainLocalOwnerOutboxes();
  assert.equal(f.state.calls.length, 1); assert.equal(f.outbox()[0].status, "processed");
});

test("answered questions and changed runtimes cancel undelivered notifications", async t => {
  const f = await fixture(t);
  for (const mode of ["answered", "generation", "file"]) {
    f.state.busy = true; f.state.pending = true; f.state.generation = "runtime-1"; f.B.sessionFile = target.sessionFile;
    f.register(mode); f.publish({ waitId: mode }); await f.waits.drainLocalOwnerOutboxes();
    if (mode === "answered") f.state.pending = false;
    if (mode === "generation") f.state.generation = "runtime-2";
    if (mode === "file") f.B.sessionFile = "/other/B.jsonl";
    f.state.busy = false; await f.waits.drainLocalOwnerOutboxes();
    assert.equal(f.outbox().find(item => item.waitId === mode).status, "cancelled");
  }
  assert.equal(f.state.calls.length, 0);
});

test("answer or wait cancellation while recipient admission awaits suppresses the wake", async t => {
  const f = await fixture(t);
  for (const mode of ["answered", "cancelled"]) {
    f.state.pending = true; f.register(mode);
    f.state.beforeAdmission = async () => {
      await Promise.resolve();
      if (mode === "answered") f.state.pending = false;
      else core.transitionWait(f.root, "ui", mode, "cancel");
    };
    f.publish({ waitId: mode }); await f.waits.drainLocalOwnerOutboxes();
    assert.equal(f.outbox().find(item => item.waitId === mode).status, "cancelled");
  }
  assert.equal(f.state.calls.length, 0);
});


test("stale subscription readiness is read-only and runtime shutdown cancels explicitly", async t => {
  const f = await fixture(t); const wait = f.register();
  const revision = core.readState(f.root, "ui").revision;
  for (const mode of ["missing", "generation", "file"]) {
    f.B.isAlive = () => mode !== "missing";
    f.state.generation = mode === "generation" ? "runtime-2" : "runtime-1";
    f.B.sessionFile = mode === "file" ? "/other/B.jsonl" : target.sessionFile;
    const projected = f.waits.readPersistentWaitStatus({ waitId: wait.id }).waits[0];
    assert.equal(projected.status, "waiting", "readiness does not claim a persisted cancellation");
    assert.equal(projected.readiness.status, "blocked"); assert.equal(projected.readiness.nextAction, "renew_ui_wait");
    assert.equal(projected.readiness.reason, mode === "missing" ? "runtime_not_live" : mode === "generation" ? "runtime_replaced" : "runtime_session_file_mismatch");
    assert.equal(core.readState(f.root, "ui").revision, revision);
  }
  f.waits.invalidateSessionUiRequestWaits({ sessionId: "B", sessionFile: target.sessionFile, runtimeGeneration: "runtime-1", reason: "runtime_closed" });
  const state = core.readState(f.root, "ui"); assert.equal(state.waits[wait.id], undefined); assert.equal(state.terminalWaits[wait.id].status, "cancelled");
  assert.equal(f.state.calls.length, 0);
});

test("new runtime invalidates old subscription through durable ingress even under a lock", async t => {
  const f = await fixture(t); const wait = f.register(); f.state.generation = "runtime-2";
  const { acquireStateWriteLock } = require("../bin/state-write-lock.cjs");
  const release = acquireStateWriteLock(core.stateFile(f.root, "ui"));
  try { assert.equal(f.publish({ runtimeGeneration: "runtime-2" }).queued, true); } finally { release(); }
  await f.waits.drainLocalOwnerOutboxes();
  const state = core.readState(f.root, "ui"); assert.equal(state.waits[wait.id], undefined); assert.equal(state.terminalWaits[wait.id].status, "cancelled");
  assert.equal(f.state.calls.length, 0);
});

test("expired question never wakes while its timeout callback is still pending", async t => {
  const f = await fixture(t); f.register(); f.state.expiresAt = Date.now() - 1;
  f.publish(); await f.waits.drainLocalOwnerOutboxes();
  assert.equal(f.outbox()[0].status, "cancelled"); assert.equal(f.state.calls.length, 0);
});


test("ordinary outbox retry timers cannot incidentally wake a queued UI subscriber", async t => {
  const f = await fixture(t); let ordinaryBusy = true;
  globalThis.__piSessions.set("C", { sessionId: "C", sessionFile: "/fixture/C.jsonl", isAlive: () => true, isRunning: () => ordinaryBusy, inner: {}, sendNativePeerMessage: async () => {} });
  f.state.busy = true; f.register(); f.publish();
  const ordinaryOwner = { deviceId: "dev", sessionId: "C", sessionFile: "/fixture/C.jsonl" };
  core.createWait(f.root, "ui", { id: "ordinary", owner: ordinaryOwner, target, condition: "turn_settled", continuation: { target: ordinaryOwner, authorizedScope: ["resume_prior_work"], message: "Continue ordinary work" } });
  f.waits.applyPersistentEvent({ id: "ordinary-done", type: "turn_settled", identity: target });
  await f.waits.drainLocalOwnerOutboxes(); f.state.busy = false;
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(f.state.calls.length, 0, "the other owner's retry timer does not admit this notification");
  ordinaryBusy = false;
  f.waits.persistSessionWaitEvent({ type: "agent_end", sessionId: "A", sessionFile: owner.sessionFile });
  await f.waits.drainLocalOwnerOutboxes(); assert.equal(f.state.calls.length, 1);
});

test("generic HTTP/report event bridge cannot impersonate native popup publication", async t => {
 const f=await fixture(t);f.register();
 assert.throws(()=>f.waits.applyPersistentEvent({type:'ui_request',source:'rpc-manager',identity:target,runtimeGeneration:'runtime-1',requestId:'question',method:'select'}),/only by the live runtime/);
 assert.equal(core.readState(f.root,'ui').waits.subscription.status,'waiting');assert.equal(f.outbox().length,0);
 f.publish();await f.waits.drainLocalOwnerOutboxes();assert.equal(f.state.calls.length,1);
});
