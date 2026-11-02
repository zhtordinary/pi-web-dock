import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
const require = createRequire(import.meta.url);
const core = require("../bin/session-wait-core.cjs");
const id = (deviceId, sessionId, sessionFile = undefined) => ({ deviceId, sessionId, ...(sessionFile ? { sessionFile } : {}) });
const root = (name) => mkdtempSync(join(tmpdir(), `session-review-${name}-`));

test("ordinary event fans out to every matching subscription and deduplicates once", (t) => {
  const r = root("fanout"); t.after(() => rmSync(r, { recursive: true, force: true }));
  const target = id("device", "worker");
  for (const [waitId, owner] of [["one", id("device", "owner-one")], ["two", id("device", "owner-two")]]) core.createWait(r, "reader", { id: waitId, owner, target, condition: "turn_settled", continuation: { target: owner, authorizedScope: ["resume_prior_work"], message: waitId } });
  const result = core.applyEvent(r, "reader", { id: "fanout-event", type: "turn_settled", identity: target });
  assert.deepEqual(result.event.matchedWaitIds.sort(), ["one", "two"]);
  assert.deepEqual(Object.values(core.readState(r, "reader").waits).map((wait) => wait.status), ["completed", "completed"]);
  assert.equal(Object.values(core.readState(r, "reader").outbox).length, 2);
  assert.equal(core.applyEvent(r, "reader", { id: "fanout-event", type: "turn_settled", identity: target }).duplicate, true);
});

test("paused plan is an authoritative result and delivery gate; resume is explicit", (t) => {
  const r = root("pause-gate"); t.after(() => rmSync(r, { recursive: true, force: true }));
  const owner = id("d", "owner"), target = id("d", "worker");
  const created = core.createPlan(r, "reader", { id: "paused", owner, maxRounds: 1, maxNoProgress: 1, nodes: [{ id: "A", session: target, condition: "task_completed", taskId: "A-task", continuation: { target, authorizedScope: ["resume_prior_work"], message: "A" } }, { id: "B", session: target, condition: "task_completed", taskId: "B-task", continuation: { target, authorizedScope: ["resume_prior_work"], message: "B" } }] });
  const initial = Object.values(core.readState(r, "reader").outbox)[0]; core.claimOutbox(r, "reader", initial.id, "processed");
  core.applyEvent(r, "reader", { id: "progress-one", type: "progress", identity: target, planId: "paused", waitId: created.wait.id, generation: 1, round: 1, taskId: "A-task", progress: "same" });
  core.applyEvent(r, "reader", { id: "progress-two", type: "progress", identity: target, planId: "paused", waitId: created.wait.id, generation: 1, round: 1, taskId: "A-task", progress: "same" });
  assert.equal(core.readState(r, "reader").plans.paused.status, "paused");
  const blocked = core.applyEvent(r, "reader", { id: "late-result", type: "task_completed", identity: target, planId: "paused", waitId: created.wait.id, generation: 1, round: 1, taskId: "A-task", success: true, resultLocation: "/fixture/result" });
  assert.equal(blocked.reason, "plan_paused"); assert.equal(core.readState(r, "reader").plans.paused.currentNodeId, "A");
  core.transitionWait(r, "reader", created.wait.id, "resume", undefined, owner);
  const resumed = core.applyEvent(r, "reader", { id: "resumed-result", type: "task_completed", identity: target, planId: "paused", waitId: created.wait.id, generation: 1, round: 1, taskId: "A-task", success: true, resultLocation: "/fixture/result" });
  assert.equal(resumed.accepted, true); assert.equal(core.readState(r, "reader").plans.paused.currentNodeId, "B");
});

test("actual claims fence concurrent delivery and crash recovery to unknown", (t) => {
  const previous = { device: process.env.PI_WEB_DEVICE_ID, config: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG }; process.env.PI_WEB_DEVICE_ID = "d"; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "d" } }); const r = root("claim"); t.after(() => { rmSync(r, { recursive: true, force: true }); for (const [key, value] of Object.entries({ PI_WEB_DEVICE_ID: previous.device, PI_WEB_SESSION_ACTIVITY_CONFIG: previous.config })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const owner = id("d", "owner"), target = id("d", "worker"); const wait = core.createWait(r, "reader", { id: "claim-wait", owner, target, condition: "task_completed", taskId: "task", continuation: { target: owner, authorizedScope: ["resume_prior_work"], message: "continue" } });
  core.applyEvent(r, "reader", { id: "claim-event", type: "task_completed", identity: target, waitId: wait.id, taskId: "task", success: true, resultLocation: "/fixture/result" }); const item = Object.values(core.readState(r, "reader").outbox)[0];
  const first = core.claimOutboxForDelivery(r, "reader", item.id); const second = core.claimOutboxForDelivery(r, "reader", item.id); assert.equal(first.claimed, true); assert.equal(second.claimed, false); assert.equal(second.reason, "outbox_status_in_flight");
  core.withTransaction(r, "reader", (state) => { state.outbox[item.id].claim.pid = 999999; state.outbox[item.id].claim.startToken = "dead"; });
  core.recoverState(r, "reader"); assert.equal(core.readState(r, "reader").outbox[item.id].status, "unknown"); assert.equal(core.outboxDeliveryDecision(r, "reader", item.id).allowed, false);
});

test("queued inbox admission rechecks exact path and peer revocation", (t) => {
  const previous = process.env.PI_WEB_SESSION_ACTIVITY_CONFIG; const r = root("admission"); t.after(() => { rmSync(r, { recursive: true, force: true }); if (previous === undefined) delete process.env.PI_WEB_SESSION_ACTIVITY_CONFIG; else process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = previous; });
  const keys = core.generatePeerKeyPair(); process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "device-b" }, peers: [{ id: "device-a", url: "http://a.test" }] }); core.pairPeer(r, "reader", { deviceId: "device-a", peerUrl: "http://a.test", publicKey: keys.publicKey, sessions: ["owner"], operations: ["wake"], scopes: ["resume_prior_work"] });
  const target = id("device-b", "receiver", "/fixture/original.jsonl"); const env = core.createSignedEnvelope({ channel: "reader", sender: id("device-a", "owner"), recipient: "device-b", operation: "wake", scope: ["resume_prior_work"], body: { target, waitId: "missing", continuation: { target, authorizedScope: ["resume_prior_work"], message: "approved" } } }, keys.privateKey); core.acceptPeerEnvelope(r, "reader", env, { recipient: "device-b", requirePersistentPin: true }); core.completeInbox(r, "reader", env.messageId, "queued");
  assert.equal(core.inboxWakeDecision(r, "reader", env.messageId, "receiver", "/fixture/replacement.jsonl", "device-b").allowed, false); core.revokePeer(r, "reader", "device-a"); assert.equal(core.inboxWakeDecision(r, "reader", env.messageId, "receiver", target.sessionFile, "device-b").allowed, false);
});

test("a rejected queued inbox claim never overwrites a later cancellation", async t => {
  const r = root("inbox-rejected-claim"), keys = ["PI_WEB_SESSION_WAIT_STATE_ROOT", "PI_WEB_SESSION_WAIT_CHANNEL", "PI_WEB_DEVICE_ID", "PI_WEB_SESSION_ACTIVITY_CONFIG"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = r; process.env.PI_WEB_SESSION_WAIT_CHANNEL = "reader"; process.env.PI_WEB_DEVICE_ID = "device-b";
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "device-b" }, peers: [{ id: "device-a", url: "http://a.test" }] });
  const keysA = core.generatePeerKeyPair(), sender = id("device-a", "owner"), target = id("device-b", "receiver", "/fixture/receiver.jsonl");
  core.pairPeer(r, "reader", { deviceId: "device-a", peerUrl: "http://a.test", publicKey: keysA.publicKey, sessions: ["owner"], operations: ["wake"], scopes: ["resume_prior_work"] });
  core.createWait(r, "reader", { id: "wait", owner: target, target: sender, condition: "turn_settled" });
  const envelope = core.createSignedEnvelope({ channel: "reader", sender, recipient: "device-b", operation: "wake", scope: ["resume_prior_work"], body: { target, waitId: "wait", authorizedScope: ["resume_prior_work"], continuation: { target, authorizedScope: ["resume_prior_work"], message: "approved" } } }, keysA.privateKey);
  core.acceptPeerEnvelope(r, "reader", envelope, { recipient: "device-b", requirePersistentPin: true }); core.completeInbox(r, "reader", envelope.messageId, "queued"); core.revokePeer(r, "reader", "device-a");
  const originalClaim = core.claimInboxForDelivery; let afterCancellation;
  core.claimInboxForDelivery = (...args) => { const claim = originalClaim(...args); assert.equal(claim.terminal, true); core.transitionWait(r, "reader", "wait", "cancel"); afterCancellation = core.readState(r, "reader").inbox[envelope.messageId].status; return claim; };
  t.after(() => { core.claimInboxForDelivery = originalClaim; for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } rmSync(r, { recursive: true, force: true }); });
  const { drainPendingSessionWakes } = await createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }).import("./session-control-wake-queue.ts");
  await drainPendingSessionWakes("receiver", { sessionFile: target.sessionFile, isRunning: () => false, inner: {} });
  assert.equal(core.readState(r, "reader").inbox[envelope.messageId].status, afterCancellation);
});

test("queued inbox rechecks peer revocation after asynchronous preparation", async t => {
  const r = root("inbox-final-admission");
  const keys = ["PI_WEB_SESSION_WAIT_STATE_ROOT", "PI_WEB_SESSION_WAIT_CHANNEL", "PI_WEB_DEVICE_ID", "PI_WEB_SESSION_ACTIVITY_CONFIG"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = r; process.env.PI_WEB_SESSION_WAIT_CHANNEL = "reader"; process.env.PI_WEB_DEVICE_ID = "device-b";
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "device-b" }, peers: [{ id: "device-a", url: "http://a.test" }] });
  t.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } rmSync(r, { recursive: true, force: true }); });
  const keysA = core.generatePeerKeyPair(), sender = id("device-a", "owner"), target = id("device-b", "receiver", "/fixture/receiver.jsonl");
  core.pairPeer(r, "reader", { deviceId: "device-a", peerUrl: "http://a.test", publicKey: keysA.publicKey, sessions: ["owner"], operations: ["wake"], scopes: ["resume_prior_work"] });
  const envelope = core.createSignedEnvelope({ channel: "reader", sender, recipient: "device-b", operation: "wake", scope: ["resume_prior_work"], body: { target, authorizedScope: ["resume_prior_work"], continuation: { target, authorizedScope: ["resume_prior_work"], message: "approved" } } }, keysA.privateKey);
  core.acceptPeerEnvelope(r, "reader", envelope, { recipient: "device-b", requirePersistentPin: true }); core.completeInbox(r, "reader", envelope.messageId, "queued");
  let submitted = 0;
  const session = { sessionFile: target.sessionFile, isRunning: () => false, inner: {}, sendNativePeerMessage: async (_message, options) => {
    await Promise.resolve(); core.revokePeer(r, "reader", "device-a");
    if (options.beforeSubmit && !options.beforeSubmit()) throw new Error("notification_no_longer_pending");
    submitted += 1;
  } };
  const { drainPendingSessionWakes } = await createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }).import("./session-control-wake-queue.ts");
  await drainPendingSessionWakes("receiver", session);
  assert.equal(submitted, 0); assert.equal(core.readState(r, "reader").inbox[envelope.messageId].status, "blocked");
});

test("capability binds content and external results use fresh bytes", async (t) => {
  const r = root("capability-result"); t.after(() => rmSync(r, { recursive: true, force: true })); const owner = id("d", "owner"), target = id("d", "target"); const wait = core.createWait(r, "reader", { id: "cap-wait", owner, target, condition: "task_completed", taskId: "task", continuation: { target: owner, authorizedScope: ["resume_prior_work"], message: "approved" } }); core.applyEvent(r, "reader", { id: "cap-event", type: "task_completed", identity: target, waitId: wait.id, taskId: "task", success: true, resultLocation: "/fixture/result" }); const item = Object.values(core.readState(r, "reader").outbox)[0]; const forged = { ...item, continuation: { ...item.continuation, message: "forged" } }; assert.equal(core.verifyOutboxCapability(forged).ok, false);
  const oldFile = join(r, "old.bin"); writeFileSync(oldFile, Buffer.from("old")); assert.throws(() => core.enqueueExternalTask(r, "reader", { id: "old-task", argv: [process.execPath, "-e", "process.exit(0)"], resultLocation: oldFile }), /resultLocation/);
  const resultPath = join(r, "fresh.bin"); const task = core.enqueueExternalTask(r, "reader", { id: "fresh-task", argv: [process.execPath, "-e", "require(\"node:fs\").writeFileSync(process.argv[1], Buffer.from([0,1,2,3]))", resultPath], resultLocation: resultPath }); const running = core.spawnStructuredTask(r, "reader", task.id); await new Promise((resolve) => running.child.once("close", resolve)); const saved = core.listExternalTasks(r, "reader").find((candidate) => candidate.id === task.id); assert.equal(saved.status, "completed"); assert.equal(saved.resultEvidence.sha256, createHash("sha256").update(Buffer.from([0,1,2,3])).digest("hex"));
});
