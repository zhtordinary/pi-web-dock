import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const core = require("../bin/session-wait-core.cjs");
const root = (name) => mkdtempSync(join(tmpdir(), `session-reverification-${name}-`));
const id = (deviceId, sessionId, sessionFile = undefined) => ({ deviceId, sessionId, ...(sessionFile ? { sessionFile } : {}) });
const cont = (target, message = "approved continuation") => ({ target, authorizedScope: ["resume_prior_work"], message });
const state = (r) => core.readState(r, "reader");

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

test("R1 and NEW1 reject persisted pull/queued effects after pin gate changes", (t) => {
  const r = root("admission"); t.after(() => rmSync(r, { recursive: true, force: true }));
  const owner = id("a", "owner"), target = id("b", "worker");
  const keys = core.generatePeerKeyPair();
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "b" }, peers: [{ id: "a", url: "http://a.test" }] });
  t.after(() => restoreEnv("PI_WEB_SESSION_ACTIVITY_CONFIG", undefined));
  core.pairPeer(r, "reader", { deviceId: "a", sessions: ["owner"], publicKey: keys.publicKey, peerUrl: "http://a.test", operations: ["wake"], scopes: ["resume_prior_work"] });
  const plan = core.createPlan(r, "reader", { id: "admission-plan", owner, maxRounds: 1, nodes: [{ id: "worker", session: target, taskId: "task", condition: "task_completed", continuation: cont(target) }] });
  const wait = plan.wait;
  const box = Object.values(state(r).outbox)[0];
  core.recordPullReceipt(r, "reader", { pullMessageId: "pull-1", peerId: "a", itemId: box.id, sourceMessageId: box.messageId, itemDigest: box.capability.digest, itemCapability: box.capability });
  core.revokePeer(r, "reader", "a");
  assert.equal(core.claimPullReceipt(r, "reader", "pull-1", box.id).claimed, false);
  core.withTransaction(r, "reader", (s) => { s.peers.a.revokedAt = null; s.peers.a.operations = ["wake"]; s.peers.a.scopes = ["resume_prior_work"]; });
  const env = core.createSignedEnvelope({ channel: "reader", sender: owner, recipient: "b", operation: "wake", scope: ["resume_prior_work"], body: { target, waitId: wait.id, continuation: cont(target) } }, keys.privateKey);
  core.acceptPeerEnvelope(r, "reader", env, { recipient: "b", requirePersistentPin: false, publicKeys: { a: keys.publicKey } });
  core.completeInbox(r, "reader", env.messageId, "queued");
  const pin = state(r).peers.a;
  core.withTransaction(r, "reader", (s) => { s.peers.a = { ...pin, operations: ["pull_messages"], scopes: ["pull_messages"] }; });
  assert.equal(core.inboxWakeDecision(r, "reader", env.messageId, target.sessionId, undefined, target.deviceId).allowed, false);
});

test("a pull receipt deferred before admission remains queued until its wait resumes", (t) => {
  const r = root("pull-deferred"), old = process.env.PI_WEB_SESSION_ACTIVITY_CONFIG; t.after(() => { rmSync(r, { recursive: true, force: true }); restoreEnv("PI_WEB_SESSION_ACTIVITY_CONFIG", old); });
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "b" }, peers: [{ id: "a", url: "http://a.test" }] });
  const owner = id("a", "owner"), target = id("b", "worker"), keys = core.generatePeerKeyPair();
  core.pairPeer(r, "reader", { deviceId: "a", sessions: ["owner"], publicKey: keys.publicKey, peerUrl: "http://a.test", operations: ["wake"], scopes: ["resume_prior_work"] });
  const plan = core.createPlan(r, "reader", { id: "paused-plan", owner, maxRounds: 1, nodes: [{ id: "worker", session: target, condition: "task_completed", continuation: cont(target) }] });
  const box = Object.values(state(r).outbox)[0]; core.transitionWait(r, "reader", plan.wait.id, "pause");
  core.recordPullReceipt(r, "reader", { pullMessageId: "pull", peerId: "a", itemId: box.id, sourceMessageId: box.messageId, itemDigest: box.capability.digest, itemCapability: box.capability });
  const deferred = core.claimPullReceipt(r, "reader", "pull", box.id); assert.equal(deferred.claimed, false); assert.equal(deferred.defer, true); assert.equal(core.listPullReceipts(r, "reader", "pull")[0].status, "queued");
  core.transitionWait(r, "reader", plan.wait.id, "resume"); assert.equal(core.claimPullReceipt(r, "reader", "pull", box.id).claimed, true);
});

test("R2 receipt identity is exact and processed state is monotonic", (t) => {
  const r = root("receipt"); t.after(() => rmSync(r, { recursive: true, force: true }));
  const owner = id("a", "owner"), one = id("b", "one"), two = id("b", "two");
  const plan = core.createPlan(r, "reader", { id: "p", owner, maxRounds: 1, nodes: [{ id: "one", session: one, taskId: "t1", condition: "task_completed", continuation: cont(one) }, { id: "two", session: two, taskId: "t2", condition: "task_completed", continuation: cont(two) }] });
  const old = Object.values(state(r).outbox)[0]; core.claimOutbox(r, "reader", old.id, "processed");
  core.applyEvent(r, "reader", { id: "done-one", type: "task_completed", identity: one, waitId: plan.wait.id, planId: "p", generation: 1, round: 1, taskId: "t1", success: true, resultLocation: "/fixture/result" });
  assert.throws(() => core.applyPeerReceipt(r, "reader", { messageId: old.messageId, outboxId: old.id, sender: two, status: "processed", details: { pullDigest: old.capability.digest } }));
  assert.equal(state(r).plans.p.handoffStatus, "pending");
  assert.throws(() => core.applyPeerReceipt(r, "reader", { messageId: old.messageId, outboxId: old.id, sender: one, status: "queued", details: { pullDigest: old.capability.digest } }));
});

test("R3 external argv uses project environment filtering", async (t) => {
  const r = root("env"); t.after(() => rmSync(r, { recursive: true, force: true }));
  const previous = { PI_WEB_PASSWORD: process.env.PI_WEB_PASSWORD, PORT: process.env.PORT, NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH };
  Object.assign(process.env, { PI_WEB_PASSWORD: "__HOST_SENTINEL__", PORT: "9999", NODE_ENV: "test" });
  t.after(() => Object.entries(previous).forEach(([key, value]) => restoreEnv(key, value)));
  const resultPath = join(r, "result.json");
  const task = core.enqueueExternalTask(r, "reader", { id: "env-task", resultLocation: resultPath, argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ password: process.env.PI_WEB_PASSWORD, port: process.env.PORT, node: process.env.NODE_ENV, path: Boolean(process.env.PATH) }));", resultPath] });
  const worker = spawn(process.execPath, ["bin/session-wait-worker.cjs", "--state-root", r, "--channel", "reader", "--once"], { cwd: process.cwd(), env: { ...process.env, PI_WEB_SESSION_WAIT_STATE_ROOT: r, PI_WEB_SESSION_WAIT_CHANNEL: "reader" }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => { worker.once("error", reject); worker.once("close", resolve); });
  const saved = core.listExternalTasks(r, "reader").find((candidate) => candidate.id === task.id);
  const actual = JSON.parse(readFileSync(resultPath, "utf8"));
  assert.equal(saved.status, "completed");
  assert.equal(actual.password, undefined);
  assert.equal(actual.port, undefined);
  assert.equal(actual.node, undefined);
  assert.equal(actual.path, true);
});

test("R4 preflight acceptance permits an in-round report before transport completion", (t) => {
  const r = root("preflight"); t.after(() => rmSync(r, { recursive: true, force: true }));
  const owner = id("d", "owner"), target = id("d", "target");
  const plan = core.createPlan(r, "reader", { id: "preflight-plan", owner, maxRounds: 1, nodes: [{ id: "node", session: target, taskId: "task", condition: "task_completed", continuation: cont(target) }] });
  const outbox = Object.values(state(r).outbox)[0]; const claim = core.claimOutboxForDelivery(r, "reader", outbox.id);
  core.completeOutboxDelivery(r, "reader", outbox.id, "accepted", claim.claimId, { preflight: true });
  const applied = core.applyEvent(r, "reader", { id: "in-round", type: "task_completed", identity: target, waitId: plan.wait.id, planId: plan.id, generation: 1, round: 1, taskId: "task", success: true, resultLocation: "/fixture/result" });
  assert.equal(applied.accepted, true);
});

test("R5 paired remote register wait creates a non-executing observation binding intent", (t) => {
  const r = root("observe"); t.after(() => rmSync(r, { recursive: true, force: true }));
  const oldConfig = process.env.PI_WEB_SESSION_ACTIVITY_CONFIG; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "a" }, peers: [{ id: "b", url: "http://b.test" }] }); t.after(() => restoreEnv("PI_WEB_SESSION_ACTIVITY_CONFIG", oldConfig));
  const keys = core.generatePeerKeyPair(); core.pairPeer(r, "reader", { deviceId: "b", sessions: ["worker"], publicKey: keys.publicKey, peerUrl: "http://b.test", operations: ["observe_wait", "report_result"], scopes: ["observe_wait", "report_result"] });
  const owner = id("a", "owner"), target = id("b", "worker");
  const wait = core.createWait(r, "reader", { id: "observe-wait", owner, target, taskId: "task", condition: "task_completed", operation: "observe_wait", dispatchObserve: true, continuation: cont(owner) });
  const outbox = Object.values(state(r).outbox); assert.equal(outbox.length, 1); assert.equal(outbox[0].operation, "observe_wait"); assert.equal(outbox[0].target.sessionId, target.sessionId); assert.equal(outbox[0].owner.sessionId, owner.sessionId); assert.equal(outbox[0].capability.payload.owner.sessionId, owner.sessionId); assert.equal(wait.observationStatus, "pending");
  const blockedRoot = root("observe-blocked"); t.after(() => rmSync(blockedRoot, { recursive: true, force: true })); const blockedWait = core.createWait(blockedRoot, "reader", { id: "observe-blocked", owner, target, taskId: "task", condition: "task_completed", operation: "observe_wait", dispatchObserve: true, continuation: cont(owner) }); assert.equal(blockedWait.observationStatus, "pending");
});

test("R6 progress updates ordinary waits without completing them", (t) => {
  const r = root("progress"); t.after(() => rmSync(r, { recursive: true, force: true }));
  const target = id("d", "worker");
  for (const [waitId, condition] of [["task", "task_completed"], ["acceptance", "acceptance_passed"]]) core.createWait(r, "reader", { id: waitId, owner: id("d", waitId), target, taskId: "task", condition, continuation: cont(id("d", waitId)) });
  const applied = core.applyEvent(r, "reader", { id: "progress", type: "progress", identity: target, taskId: "task", progress: "50%" });
  assert.equal(applied.event.outcome, "progress_recorded");
  assert.deepEqual(Object.values(state(r).waits).map((wait) => wait.status), ["waiting", "waiting"]);
  assert.equal(Object.values(state(r).outbox).length, 0);
});

test("R7 pull receipt persists a result return binding", (t) => {
  const r = root("pull-binding"); t.after(() => rmSync(r, { recursive: true, force: true }));
  const owner = id("a", "owner"), target = id("b", "worker");
  const event = { type: "task_completed", identity: target, waitId: "wait", planId: "plan", generation: 1, round: 1, taskId: "task", success: true, resultLocation: "/fixture/result" };
  const payload = { kind: "result", waitId: "wait", planId: "plan", generation: 1, round: 1, taskId: "task", sender: target, recipient: owner, operation: "report_result", authorizedScope: ["report_result"], continuation: null, target, messageId: "message", resultEvent: event };
  const box = { id: "outbox", messageId: "message", capability: { version: 1, payload, digest: createHash("sha256").update(JSON.stringify(payload)).digest("hex") } };
  box.capability.digest = core.sha256(payload);
  core.recordPullReceipt(r, "reader", { pullMessageId: "pull", peerId: "b", itemId: box.id, sourceMessageId: box.messageId, itemDigest: box.capability.digest, itemCapability: box.capability });
  assert.ok(Object.values(state(r).remoteBindings).length > 0);
});

test("R8 recovery preserves an in-flight claim held by a live executor", (t) => {
  const r = root("live-claim"); t.after(() => rmSync(r, { recursive: true, force: true }));
  const previousDevice = process.env.PI_WEB_DEVICE_ID; const previousActivityConfig = process.env.PI_WEB_SESSION_ACTIVITY_CONFIG;
  process.env.PI_WEB_DEVICE_ID = "d"; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "d" } });
  t.after(() => { restoreEnv("PI_WEB_DEVICE_ID", previousDevice); restoreEnv("PI_WEB_SESSION_ACTIVITY_CONFIG", previousActivityConfig); });
  const owner = id("d", "owner"), target = id("d", "target");
  const wait = core.createWait(r, "reader", { id: "wait", owner, target, condition: "task_completed", continuation: cont(owner) });
  core.applyEvent(r, "reader", { id: "done", type: "task_completed", identity: target, waitId: wait.id, success: true, resultLocation: "/fixture/result" });
  const outbox = Object.values(state(r).outbox)[0]; const claim = core.claimOutboxForDelivery(r, "reader", outbox.id); assert.equal(claim.claimed, true);
  core.recoverState(r, "reader");
  assert.equal(state(r).outbox[outbox.id].status, "in_flight");
});

test("R9 recovery closes a dead pull consumer conservatively", (t) => {
  const r = root("pull-recovery"); t.after(() => rmSync(r, { recursive: true, force: true }));
  const previousDevice = process.env.PI_WEB_DEVICE_ID; const previousActivityConfig = process.env.PI_WEB_SESSION_ACTIVITY_CONFIG;
  process.env.PI_WEB_DEVICE_ID = "b"; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "b" } });
  t.after(() => { restoreEnv("PI_WEB_DEVICE_ID", previousDevice); restoreEnv("PI_WEB_SESSION_ACTIVITY_CONFIG", previousActivityConfig); });
  const owner = id("a", "owner"), target = id("b", "target");
  const payload = { waitId: "wait", planId: null, generation: 1, round: 1, taskId: "task", sender: target, recipient: owner, operation: "report_result", authorizedScope: ["report_result"], continuation: null, target, messageId: "message" };
  const box = { id: "outbox", messageId: "message", capability: { version: 1, payload, digest: core.sha256(payload) } };
  core.recordPullReceipt(r, "reader", { pullMessageId: "pull", peerId: "b", itemId: box.id, sourceMessageId: box.messageId, itemDigest: box.capability.digest, itemCapability: box.capability });
  const claimed = core.claimPullReceipt(r, "reader", "pull", box.id); assert.equal(claimed.claimed, true);
  core.withTransaction(r, "reader", (s) => { s.pullReceipts["pull:outbox"].claim.pid = 999999; s.pullReceipts["pull:outbox"].claim.startToken = "dead"; });
  core.recoverState(r, "reader");
  assert.equal(state(r).pullReceipts["pull:outbox"].status, "unknown");
});

test("FU1 preserves an explicitly approved steer reply mode", async (t) => {
  const { deliverSessionMessage } = await import("./session-messages.ts");
  const r = root("reply-mode"); t.after(() => rmSync(r, { recursive: true, force: true }));
  const sender = { deviceId: "a", deviceName: "A", sessionId: "a-session", sessionFile: null, title: "A", project: r };
  const recipient = { deviceId: "b", deviceName: "B", sessionId: "b-session", sessionFile: null, title: "B", project: r };
  const sent = [];
  const request = await deliverSessionMessage({ root: r, callId: "request", sender, recipient: recipient.sessionId, kind: "request", responseRequired: true, replyDelivery: "steer", body: "Do the task", send: async (...args) => sent.push(args) });
  const reply = await deliverSessionMessage({ root: r, callId: "reply", sender: recipient, recipient: sender.sessionId, kind: "reply", inReplyTo: request.messageId, workStatus: "completed", body: "Done", send: async (...args) => sent.push(args) });
  assert.equal(reply.replyDelivery, "steer");
  assert.equal(sent.at(-1)[1], "steer");
});


test("R5 register_wait tool persists a non-executing remote observation", async (t) => {
  const r = root("register-tool"); t.after(() => rmSync(r, { recursive: true, force: true }));
  const old = { root: process.env.PI_WEB_SESSION_WAIT_STATE_ROOT, channel: process.env.PI_WEB_SESSION_WAIT_CHANNEL, device: process.env.PI_WEB_DEVICE_ID, config: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG };
  Object.assign(process.env, { PI_WEB_SESSION_WAIT_STATE_ROOT: r, PI_WEB_SESSION_WAIT_CHANNEL: "reader", PI_WEB_DEVICE_ID: "a", PI_WEB_SESSION_ACTIVITY_CONFIG: JSON.stringify({ device: { id: "a" } }) });
  t.after(() => Object.entries({ PI_WEB_SESSION_WAIT_STATE_ROOT: old.root, PI_WEB_SESSION_WAIT_CHANNEL: old.channel, PI_WEB_DEVICE_ID: old.device, PI_WEB_SESSION_ACTIVITY_CONFIG: old.config }).forEach(([key, value]) => restoreEnv(key, value)));
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }); const { createSessionControlExtension } = await jiti.import("./session-control.ts"); let definition;
  createSessionControlExtension().factory({ registerTool(value) { definition = value; } });
  const context = { cwd: r, sessionManager: { getSessionId: () => "owner", getSessionFile: () => "/fixture/a/owner.jsonl", getHeader: () => ({ id: "owner", cwd: r }) } };
  const blocked = JSON.parse((await definition.execute("register-blocked", { action: "register_wait", waitId: "observe-tool-blocked", target: "worker", targetDeviceId: "b", condition: "task_completed", taskId: "task", continuation: cont(id("a", "owner")) }, undefined, undefined, context)).content[0].text); assert.equal(blocked.status, "blocked");
  const keys = core.generatePeerKeyPair(); process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "a" }, peers: [{ id: "b", url: "http://b.test" }] }); core.pairPeer(r, "reader", { deviceId: "b", sessions: ["worker"], publicKey: keys.publicKey, peerUrl: "http://b.test", operations: ["observe_wait", "report_result"], scopes: ["observe_wait", "report_result"] });
  const result = JSON.parse((await definition.execute("register", { action: "register_wait", waitId: "observe-tool", target: "worker", targetDeviceId: "b", condition: "task_completed", taskId: "task", continuation: cont(id("a", "owner")) }, undefined, undefined, context)).content[0].text);
  assert.equal(result.status, "pending"); assert.equal(result.observation, "observe_wait"); assert.equal(Object.values(state(r).outbox).length, 1); assert.equal(state(r).waits["observe-tool"].owner.sessionId, "owner");
});

test("R4 AgentSessionWrapper preflight accepts a deferred continuation before turn completion", async (t) => {
  const r = root("wrapper-preflight"); t.after(() => rmSync(r, { recursive: true, force: true }));
  const old = { root: process.env.PI_WEB_SESSION_WAIT_STATE_ROOT, channel: process.env.PI_WEB_SESSION_WAIT_CHANNEL, device: process.env.PI_WEB_DEVICE_ID, config: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG };
  Object.assign(process.env, { PI_WEB_SESSION_WAIT_STATE_ROOT: r, PI_WEB_SESSION_WAIT_CHANNEL: "reader", PI_WEB_DEVICE_ID: "d", PI_WEB_SESSION_ACTIVITY_CONFIG: JSON.stringify({ device: { id: "d" } }) });
  t.after(() => Object.entries({ PI_WEB_SESSION_WAIT_STATE_ROOT: old.root, PI_WEB_SESSION_WAIT_CHANNEL: old.channel, PI_WEB_DEVICE_ID: old.device, PI_WEB_SESSION_ACTIVITY_CONFIG: old.config }).forEach(([key, value]) => restoreEnv(key, value)));
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }); const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts"); const { queueAuthorizedSessionWake } = await jiti.import("./session-control-wake.ts");
  const owner = id("d", "owner"), target = id("d", "worker"); const plan = core.createPlan(r, "reader", { id: "wrapper-plan", owner, maxRounds: 1, nodes: [{ id: "node", session: target, taskId: "task", condition: "task_completed", continuation: cont(target) }] });
  const box = Object.values(state(r).outbox)[0]; const claim = core.claimOutboxForDelivery(r, "reader", box.id); assert.equal(claim.claimed, true);
  let release; const turn = new Promise((resolve) => { release = resolve; }); let entered = false;
  const inner = { ...target, isStreaming: false, isBashRunning: false, isCompacting: false, extensionRunner: {}, sessionManager: { getCwd: () => r }, agent: { state: {} }, getContextUsage: () => null, getSteeringMessages: () => [], getFollowUpMessages: () => [], settingsManager: { getProjectSettings: () => ({}), getGlobalSettings: () => ({}) }, dispose() {}, sendCustomMessage: async () => { entered = true; } };
  const wrapper = new AgentSessionWrapper(inner); const previous = globalThis.__piSessions; globalThis.__piSessions = new Map([[target.sessionId, wrapper]]); t.after(() => { globalThis.__piSessions = previous; wrapper.destroy(); });
  const wake = queueAuthorizedSessionWake({ deviceId: target.deviceId, sessionId: target.sessionId, sessionFile: target.sessionFile, continuation: cont(target), onAccepted: () => core.acceptOutboxHandoff(r, "reader", box.id, claim.claimId, { preflight: true }) });
  const accepted = await new Promise(async (resolve, reject) => { const deadline = Date.now() + 3000; const poll = () => { if (entered) resolve(wake); else if (Date.now() > deadline) reject(new Error("preflight callback timeout")); else setTimeout(poll, 10); }; poll(); });
  const outcome = await accepted; assert.equal(outcome.status, "submitted"); assert.equal(state(r).plans[plan.plan.id].handoffStatus, "accepted"); assert.equal(state(r).outbox[box.id].status, "in_flight");
  const report = core.applyEvent(r, "reader", { id: "wrapper-result", type: "task_completed", identity: target, waitId: plan.wait.id, planId: plan.plan.id, generation: 1, round: 1, taskId: "task", success: true, resultLocation: "/fixture/result" }); assert.equal(report.accepted, true); release();
});

test("R10 worker spawn failure closes the wait and worker lock", async (t) => {
  const r = root("spawn-failure"); t.after(() => rmSync(r, { recursive: true, force: true }));
  const owner = id("d", "owner"), target = id("d", "worker"); const wait = core.createWait(r, "reader", { id: "spawn-wait", owner, target, condition: "task_completed", taskId: "spawn-task" });
  const task = core.enqueueExternalTask(r, "reader", { id: "spawn-task", argv: [join(r, "missing-executable")], resultLocation: join(r, "result.json"), identity: target, waitId: wait.id });
  const health = join(r, "health.json"); const worker = spawn(process.execPath, ["bin/session-wait-worker.cjs", "--state-root", r, "--channel", "reader", "--once", "--health-file", health], { cwd: process.cwd(), env: { ...process.env, PI_WEB_SESSION_WAIT_STATE_ROOT: r, PI_WEB_SESSION_WAIT_CHANNEL: "reader" }, stdio: ["ignore", "pipe", "pipe"] });
  const code = await new Promise((resolve) => worker.once("close", (value) => resolve(value))); assert.notEqual(code, 0); assert.equal(state(r).externalTasks[task.id].status, "failed"); assert.equal(state(r).waits[wait.id].status, "failed"); assert.equal(existsSync(join(r, ".worker-reader.lock")), false);
});


test("T03 real two-root observe_wait registration returns report_result to the owner", async (t) => {
  const base = root("observe-e2e"); const rootA = join(base, "a"); const rootB = join(base, "b");
  const keyA = core.generatePeerKeyPair(); const keyB = core.generatePeerKeyPair(); const owner = id("a", "owner", "/fixture/a/owner.jsonl"); const target = id("b", "worker", "/fixture/b/worker.jsonl");
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }); const peerRoute = await jiti.import("../app/api/session-control/peer/route.ts");
  async function startPeerServer(serverRoot, deviceId, config) {
    const server = createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const previous = { root: process.env.PI_WEB_SESSION_WAIT_STATE_ROOT, device: process.env.PI_WEB_DEVICE_ID, config: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG };
      Object.assign(process.env, { PI_WEB_SESSION_WAIT_STATE_ROOT: serverRoot, PI_WEB_SESSION_WAIT_CHANNEL: "reader", PI_WEB_DEVICE_ID: deviceId, PI_WEB_SESSION_ACTIVITY_CONFIG: config });
      try { const result = await peerRoute.POST(new Request(`http://127.0.0.1${request.url}`, { method: request.method, headers: { host: "127.0.0.1", "content-type": request.headers["content-type"] || "application/json" }, body: Buffer.concat(chunks) })); response.writeHead(result.status, Object.fromEntries(result.headers.entries())); response.end(Buffer.from(await result.arrayBuffer())); }
      catch (error) { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: String(error) })); }
      finally { restoreEnv("PI_WEB_SESSION_WAIT_STATE_ROOT", previous.root); restoreEnv("PI_WEB_DEVICE_ID", previous.device); restoreEnv("PI_WEB_SESSION_ACTIVITY_CONFIG", previous.config); }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); return server;
  }
  const serverB = await startPeerServer(rootB, "b", "{}"); const urlB = `http://127.0.0.1:${serverB.address().port}`; const serverA = await startPeerServer(rootA, "a", "{}"); const urlA = `http://127.0.0.1:${serverA.address().port}`;
  t.after(() => { serverA.close(); serverB.close(); rmSync(base, { recursive: true, force: true }); });
  const cfgA = JSON.stringify({ device: { id: "a" }, peers: [{ id: "b", url: urlB }] }); const cfgB = JSON.stringify({ device: { id: "b" }, peers: [{ id: "a", url: urlA }] });
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = cfgA; core.pairPeer(rootA, "reader", { deviceId: "b", sessions: ["worker"], publicKey: keyB.publicKey, peerUrl: urlB, operations: ["observe_wait", "report_result"], scopes: ["observe_wait", "report_result"] });
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = cfgB; core.pairPeer(rootB, "reader", { deviceId: "a", sessions: ["worker", "owner"], publicKey: keyA.publicKey, peerUrl: urlA, operations: ["observe_wait", "report_result"], scopes: ["observe_wait", "report_result"] });
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = cfgA; const wait = core.createWait(rootA, "reader", { id: "observe-e2e-wait", owner, target, condition: "task_completed", taskId: "task", operation: "observe_wait", dispatchObserve: true, continuation: cont(owner, "owner follow-up") });
  const keyFileA = join(base, "a-key.pem"); const keyFileB = join(base, "b-key.pem"); writeFileSync(keyFileA, keyA.privateKey, { mode: 0o600 }); writeFileSync(keyFileB, keyB.privateKey, { mode: 0o600 });
  const runWorker = (rootDir, deviceId, peerUrl, keyFile) => new Promise((resolve, reject) => { const child = spawn(process.execPath, ["bin/session-wait-worker.cjs", "--state-root", rootDir, "--channel", "reader", "--once", "--peer-url", peerUrl, "--allowed-peer-url", peerUrl, "--private-key-file", keyFile, "--sender-device-id", deviceId, "--sender-session-id", "worker"], { cwd: process.cwd(), env: { ...process.env, PI_WEB_SESSION_ACTIVITY_CONFIG: deviceId === "a" ? cfgA : cfgB }, stdio: ["ignore", "pipe", "pipe"] }); let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; }); child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `worker exit ${code}`))); });
  await runWorker(rootA, "a", urlB, keyFileA); assert.equal(Object.values(core.readState(rootA, "reader").outbox)[0].status, "processed"); assert.equal(Object.keys(core.readState(rootB, "reader").remoteBindings).length, 1);
  process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = rootB; process.env.PI_WEB_SESSION_WAIT_CHANNEL = "reader"; process.env.PI_WEB_DEVICE_ID = "b"; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = cfgB;
  const { createSessionControlExtension } = await jiti.import("./session-control.ts"); let definition; createSessionControlExtension().factory({ registerTool(value) { definition = value; } });
  const report = JSON.parse((await definition.execute("observe-report", { action: "report_result", waitId: wait.id, taskId: "task", event: { type: "task_completed", success: true, resultLocation: "/fixture/result.json" } }, undefined, undefined, { cwd: rootB, sessionManager: { getSessionId: () => "worker", getSessionFile: () => target.sessionFile, getHeader: () => ({ id: "worker", cwd: rootB }) } })).content[0].text); assert.equal(report.event.outcome, "queued_for_owner");
  await runWorker(rootB, "b", urlA, keyFileB); const ownerState = core.readState(rootA, "reader"); assert.equal(ownerState.waits[wait.id].status, "completed"); assert.equal(Object.values(ownerState.outbox).filter((item) => item.recipient?.sessionId === owner.sessionId).length, 1);
});


test("T03 malformed observe_wait envelopes fail before inbox side effects", async (t) => {
  const r = root("observe-malformed"); t.after(() => rmSync(r, { recursive: true, force: true })); const key = core.generatePeerKeyPair(); const old = { root: process.env.PI_WEB_SESSION_WAIT_STATE_ROOT, device: process.env.PI_WEB_DEVICE_ID, config: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG };
  Object.assign(process.env, { PI_WEB_SESSION_WAIT_STATE_ROOT: r, PI_WEB_SESSION_WAIT_CHANNEL: "reader", PI_WEB_DEVICE_ID: "b", PI_WEB_SESSION_ACTIVITY_CONFIG: JSON.stringify({ device: { id: "b" }, peers: [{ id: "a", url: "http://a.test" }] }) }); t.after(() => { restoreEnv("PI_WEB_SESSION_WAIT_STATE_ROOT", old.root); restoreEnv("PI_WEB_DEVICE_ID", old.device); restoreEnv("PI_WEB_SESSION_ACTIVITY_CONFIG", old.config); });
  core.pairPeer(r, "reader", { deviceId: "a", sessions: ["owner"], publicKey: key.publicKey, peerUrl: "http://a.test", operations: ["observe_wait"], scopes: ["observe_wait"] }); const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }); const route = await jiti.import("../app/api/session-control/peer/route.ts");
  const target = id("b", "worker", "/fixture/b/worker.jsonl"); const owner = id("a", "owner", "/fixture/a/owner.jsonl"); const bodies = [{ target, owner }, { target, waitId: "wait" }, { owner, waitId: "wait" }];
  for (const body of bodies) { const envelope = core.createSignedEnvelope({ channel: "reader", sender: owner, recipient: "b", operation: "observe_wait", scope: ["observe_wait"], body }, key.privateKey); const response = await route.POST(new Request("http://127.0.0.1/api/session-control/peer", { method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify(envelope) })); assert.ok(response.status >= 400); }
  assert.equal(Object.keys(core.readState(r, "reader").inbox).length, 0); assert.equal(Object.keys(core.readState(r, "reader").remoteBindings).length, 0);
});
