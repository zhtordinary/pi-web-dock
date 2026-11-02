import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
const require = createRequire(import.meta.url);
const core = require("../bin/session-wait-core.cjs");
const { acquireStateWriteLock } = require("../bin/state-write-lock.cjs");
const owner = { deviceId: "dev", sessionId: "A", sessionFile: "/fixture/A.jsonl" };
const target = { deviceId: "dev", sessionId: "B", sessionFile: "/fixture/B.jsonl" };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "reader-ui-request-wait-"));
  const previous = process.env.PI_WEB_SESSION_ACTIVITY_CONFIG;
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: owner.deviceId } });
  t.after(() => { rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.PI_WEB_SESSION_ACTIVITY_CONFIG; else process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = previous; });
  return root;
}
function register(root, patch = {}) {
  return core.createWait(root, "test", { owner, target, condition: "ui_request", runtimeGeneration: "runtime-1", continuation: { target: owner, authorizedScope: ["resume_prior_work"], message: "Resume approved supervision" }, ...patch });
}
function event(patch = {}) {
  const value = { type: "ui_request", identity: target, runtimeGeneration: "runtime-1", requestId: "question-1", method: "select", summary: "Pick a backend", source: "rpc-manager", ...patch };
  return { ...value, id: core.sha256({ type: value.type, sessionId: value.identity.sessionId, runtimeGeneration: value.runtimeGeneration, requestId: value.requestId, ...(value.waitId ? { waitId: value.waitId } : {}) }) };
}

test("UI wait is local, file/generation bound, explicitly authorized and not a plan", t => {
  const root = fixture(t);
  for (const patch of [{ runtimeGeneration: undefined }, { target: { ...target, sessionFile: undefined } }, { target: { ...target, deviceId: "remote" } }, { owner: { ...owner, deviceId: "remote" } }, { planId: "plan" }, { taskId: "task" }, { continuation: undefined }, { continuation: { target: owner, message: "implicit scope" } }, { continuation: { target, message: "wrong recipient", authorizedScope: ["resume_prior_work"] } }]) {
    assert.throws(() => register(root, patch), /ui_request|runtimeGeneration/);
  }
  assert.throws(() => core.createPlan(root, "test", { owner, nodes: [{ id: "B", session: target, condition: "ui_request", continuation: { message: "work" } }] }), /one-shot/);
  const wait = register(root); assert.equal(wait.runtimeGeneration, "runtime-1"); assert.equal(wait.generation, 1); assert.equal(wait.round, 1);
});

test("native UI event preserves question identity and wakes each subscribed owner once", t => {
  const root = fixture(t), first = register(root), second = register(root);
  const result = core.runtimeEvent(root, "test", event());
  assert.equal(result.persisted, true); assert.equal(result.accepted, true);
  let state = core.readState(root, "test");
  for (const wait of [first, second]) {
    assert.equal(state.waits[wait.id].status, "completed");
    assert.deepEqual(state.waits[wait.id].lastResult, { summary: "Pick a backend", runtimeGeneration: "runtime-1", requestId: "question-1", method: "select", evidenceSource: "unspecified", evidenceSourceAuthority: "declared", success: false });
  }
  assert.equal(state.events[event().id].source, "rpc-manager");
  assert.equal(Object.keys(state.outbox).length, 2);
  const item = Object.values(state.outbox)[0];
  assert.equal(item.uiRequest.requestId, "question-1");
  assert.equal(item.capability.payload.uiRequest.runtimeGeneration, "runtime-1");
  assert.equal(core.verifyOutboxCapability(item).ok, true);
  assert.equal(core.runtimeEvent(root, "test", event()).duplicate, true);
  core.runtimeEvent(root, "test", event({ requestId: "question-2" }));
  state = core.readState(root, "test"); assert.equal(Object.keys(state.outbox).length, 2, "a one-shot subscription never wakes twice");
});

test("late registration replays a current snapshot with wait-specific deduplication", t => {
  const root = fixture(t); core.withTransaction(root, "test", () => {}, { commitUnchanged: true });
  assert.equal(core.runtimeEvent(root, "test", event()).event.outcome, "recorded_without_wait");
  const wait = register(root);
  assert.equal(core.runtimeEvent(root, "test", event()).duplicate, true);
  assert.equal(core.readState(root, "test").waits[wait.id].status, "waiting");
  assert.equal(core.runtimeEvent(root, "test", event({ waitId: wait.id })).accepted, true);
  assert.equal(core.runtimeEvent(root, "test", event({ waitId: wait.id })).duplicate, true);
  const later = register(root);
  core.runtimeEvent(root, "test", event({ waitId: later.id }));
  assert.equal(Object.keys(core.readState(root, "test").outbox).length, 2);
});

test("generation, exact file, source, lifecycle and targeted wait mismatches never wake", t => {
  const root = fixture(t), wait = register(root);
  for (const patch of [{ runtimeGeneration: "old" }, { identity: { ...target, sessionFile: "/different/B.jsonl" } }, { identity: { ...target, sessionId: "C" } }]) {
    assert.equal(core.applyEvent(root, "test", event({ ...patch, waitId: wait.id })).ignored, true);
  }
  for (const type of ["turn_settled", "progress", "task_failed"]) {
    const result = core.applyEvent(root, "test", { id: type, type, identity: target, waitId: wait.id }); assert.equal(result.ignored, true);
  }
  assert.throws(() => core.applyEvent(root, "test", event({ source: "report_result" })), /Reader runtime source/);
  assert.throws(() => core.applyEvent(root, "test", event({ identity: { ...target, deviceId: "remote" } })), /Reader runtime source/);
  assert.equal(core.readState(root, "test").waits[wait.id].status, "waiting"); assert.equal(Object.keys(core.readState(root, "test").outbox).length, 0);
});

test("cancel before event, before delivery and after claim prevent future admission", t => {
  const root = fixture(t), beforeEvent = register(root);
  core.transitionWait(root, "test", beforeEvent.id, "cancel"); core.runtimeEvent(root, "test", event({ waitId: beforeEvent.id }));
  assert.equal(Object.keys(core.readState(root, "test").outbox).length, 0);
  const beforeDelivery = register(root); core.runtimeEvent(root, "test", event({ waitId: beforeDelivery.id }));
  let item = Object.values(core.readState(root, "test").outbox)[0];
  assert.equal(core.claimOutboxForDelivery(root, "test", item.id).reason, "ui_request_requires_live_reader_delivery", "polling worker may not wake UI subscribers");
  core.transitionWait(root, "test", beforeDelivery.id, "cancel");
  assert.equal(core.claimOutboxForDelivery(root, "test", item.id, { localUiRequestDelivery: true }).claimed, false);
  const afterClaim = register(root); core.runtimeEvent(root, "test", event({ waitId: afterClaim.id }));
  item = Object.values(core.readState(root, "test").outbox).find(value => value.waitId === afterClaim.id);
  const claim = core.claimOutboxForDelivery(root, "test", item.id, { localUiRequestDelivery: true });
  assert.equal(core.uiRequestOutboxClaimIsCurrent(root, "test", item.id, claim.claimId), true);
  core.transitionWait(root, "test", afterClaim.id, "cancel");
  assert.equal(core.uiRequestOutboxClaimIsCurrent(root, "test", item.id, claim.claimId), false);
});

test("durable runtime inbox recovers once across process restart", t => {
  const root = fixture(t), wait = register(root), release = acquireStateWriteLock(core.stateFile(root, "test"));
  try { assert.equal(core.runtimeEvent(root, "test", event()).queued, true); } finally { release(); }
  const child = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(require.resolve("../bin/session-wait-core.cjs"))}).recoverState(${JSON.stringify(root)},"test")`], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  core.recoverState(root, "test"); core.runtimeEvent(root, "test", event());
  const state = core.readState(root, "test"); assert.equal(state.waits[wait.id].status, "completed"); assert.equal(Object.keys(state.outbox).length, 1);
});

test("remote observation and report_result cannot inject a UI request", t => {
  const root = fixture(t); register(root);
  for (const body of [{ condition: "ui_request", target, waitId: "remote" }, { event: event() }, { resultEvent: event() }, { uiRequest: { requestId: "question-1" } }]) {
    assert.throws(() => core.acceptInbox(root, "test", { messageId: "remote", sender: { deviceId: "remote", sessionId: "B" }, operation: "report_result", body }), /local-only/);
    assert.equal(core.acceptPeerEnvelope(root, "test", { body }).reason, "ui_request_local_only");
  }
});

test("queued native publication racing registration and replay produces one wake", t => {
  const root = fixture(t), early = register(root), release = acquireStateWriteLock(core.stateFile(root, "test"));
  try { assert.equal(core.runtimeEvent(root, "test", event()).queued, true); } finally { release(); }
  const late = register(root);
  core.runtimeEvent(root, "test", event({ waitId: late.id }));
  const state = core.readState(root, "test");
  assert.equal(state.waits[early.id].status, "completed"); assert.equal(state.waits[late.id].status, "completed");
  assert.equal(Object.values(state.outbox).filter(item => item.waitId === late.id).length, 1);
  assert.equal(Object.values(state.outbox).length, 2);
});

test("restart never blindly repeats a possibly admitted UI wake", t => {
  const root = fixture(t); register(root); core.runtimeEvent(root, "test", event());
  const item = Object.values(core.readState(root, "test").outbox)[0];
  const child = spawnSync(process.execPath, ["-e", `const c=require(${JSON.stringify(require.resolve("../bin/session-wait-core.cjs"))}); if(!c.claimOutboxForDelivery(${JSON.stringify(root)},"test",${JSON.stringify(item.id)},{localUiRequestDelivery:true}).claimed) process.exit(1)`], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  core.recoverState(root, "test");
  assert.equal(core.readState(root, "test").outbox[item.id].status, "unknown");
  assert.equal(core.claimOutboxForDelivery(root, "test", item.id, { localUiRequestDelivery: true }).claimed, false);
});


test("delayed replacement invalidation cannot cancel a later generation subscription", t => {
  const root = fixture(t), old = register(root), release = acquireStateWriteLock(core.stateFile(root, "test"));
  try { core.runtimeEvent(root, "test", event({ runtimeGeneration: "runtime-2", supersededWaitIds: [old.id] })); } finally { release(); }
  const newest = register(root, { runtimeGeneration: "runtime-3" });
  core.drainRuntimeEvents(root, "test");
  const state = core.readState(root, "test");
  assert.equal(state.waits[old.id], undefined); assert.equal(state.terminalWaits[old.id].status, "cancelled");
  assert.equal(state.waits[newest.id].status, "waiting"); assert.equal(Object.keys(state.outbox).length, 0);
});
