import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const require = createRequire(import.meta.url); const core = require("../../../bin/session-wait-core.cjs");

test("actual peer route handler verifies signature, persists inbox and applies result", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-peer-route-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = { root: process.env.PI_WEB_SESSION_WAIT_STATE_ROOT, device: process.env.PI_WEB_DEVICE_ID, keys: process.env.PI_WEB_SESSION_CONTROL_PEER_PUBLIC_KEYS, config: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG };
  process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = root; process.env.PI_WEB_DEVICE_ID = "device-a"; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "device-a", name: "A" }, peers: [{ id: "device-b", name: "B", url: "http://peer.test" }] });
  const keys = core.generatePeerKeyPair(); const resultKeys = core.generatePeerKeyPair(); process.env.PI_WEB_SESSION_CONTROL_PEER_PUBLIC_KEYS = JSON.stringify({ "device-a": keys.publicKey, "device-b": resultKeys.publicKey });
  t.after(() => { for (const [key, value] of Object.entries({ PI_WEB_SESSION_WAIT_STATE_ROOT: old.root, PI_WEB_DEVICE_ID: old.device, PI_WEB_SESSION_CONTROL_PEER_PUBLIC_KEYS: old.keys, PI_WEB_SESSION_ACTIVITY_CONFIG: old.config })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const owner = { deviceId: "device-a", sessionId: "session-a" }; const target = { deviceId: "device-b", sessionId: "session-b" };
  core.pairPeer(root, "reader", { deviceId: "device-b", peerUrl: "http://peer.test", publicKey: resultKeys.publicKey, sessions: [target.sessionId], operations: ["wake", "pull_messages"], scopes: ["resume_prior_work", "pull_messages"] });
  const wait = core.createWait(root, "reader", { id: "route-wait", owner, target, condition: "task_completed", taskId: "route-task" });
  const envelope = core.createSignedEnvelope({ channel: "reader", sender: target, recipient: "device-a", operation: "wake", scope: ["resume_prior_work"], body: { target, event: { id: "route-event", type: "task_completed", identity: target, waitId: wait.id, taskId: "route-task", success: true, resultLocation: "/fixture/result.json" } } }, resultKeys.privateKey);
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
  const route = await jiti.import("./peer/route.ts");
  const request = () => new Request("http://127.0.0.1/api/session-control/peer", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1" }, body: JSON.stringify(envelope) });
  const response = await route.POST(request()); const payload = await response.json(); assert.equal(response.status, 200); assert.equal(payload.accepted, true); assert.equal(payload.status, "processed"); assert.equal(core.getStatus(root, "reader").waits.length, 0); assert.equal(core.readState(root, "reader").terminalWaits[wait.id].status, "completed");
  const pullWait = core.createWait(root, "reader", { id: "pull-wait", owner, target, condition: "task_completed", taskId: "pull-task", continuation: { target: owner, authorizedScope: ["resume_prior_work"], message: "Pull-approved continuation" } });
  core.applyEvent(root, "reader", { id: "pull-event", type: "task_completed", identity: target, waitId: pullWait.id, taskId: "pull-task", success: true, resultLocation: "/fixture/pull-result.json" }); const pullPlan = core.createPlan(root, "reader", { id: "pull-plan", owner, nodes: [{ id: "target", session: target, condition: "task_completed", taskId: "pull-plan-task", continuation: { target, authorizedScope: ["resume_prior_work"], message: "Pull plan" } }] });
  const pullEnvelope = core.createSignedEnvelope({ channel: "reader", sender: target, recipient: "device-a", operation: "pull_messages", scope: ["pull_messages"], body: { request: "pull" } }, resultKeys.privateKey);
  const pullResponse = await route.POST(new Request("http://127.0.0.1/api/session-control/peer", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1" }, body: JSON.stringify(pullEnvelope) }));
  assert.equal(pullResponse.status, 200); const pullPayload = await pullResponse.json(); assert.equal(pullPayload.accepted, true); assert.ok(pullPayload.outbox.some((item) => item.recipient?.deviceId === "device-b" && item.planId === pullPlan.plan.id));
});

test("peer route rejects sender/event actor mismatch before persisting inbox side effects", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-peer-actor-mismatch-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = { root: process.env.PI_WEB_SESSION_WAIT_STATE_ROOT, device: process.env.PI_WEB_DEVICE_ID, keys: process.env.PI_WEB_SESSION_CONTROL_PEER_PUBLIC_KEYS, config: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG }; process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = root; process.env.PI_WEB_DEVICE_ID = "device-a"; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "device-a", name: "A" } });
  const keys = core.generatePeerKeyPair(); process.env.PI_WEB_SESSION_CONTROL_PEER_PUBLIC_KEYS = JSON.stringify({ "device-a": keys.publicKey }); t.after(() => { for (const [key, value] of Object.entries({ PI_WEB_SESSION_WAIT_STATE_ROOT: old.root, PI_WEB_DEVICE_ID: old.device, PI_WEB_SESSION_CONTROL_PEER_PUBLIC_KEYS: old.keys, PI_WEB_SESSION_ACTIVITY_CONFIG: old.config })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const owner = { deviceId: "device-a", sessionId: "owner" }; const target = { deviceId: "device-b", sessionId: "target" }; const wait = core.createWait(root, "reader", { id: "mismatch-wait", owner, target, condition: "task_completed", taskId: "mismatch-task" });
  const envelope = core.createSignedEnvelope({ channel: "reader", sender: owner, recipient: "device-a", operation: "wake", scope: ["resume_prior_work"], body: { target, event: { id: "mismatch-event", type: "task_completed", identity: target, waitId: wait.id, taskId: "mismatch-task", success: true, resultLocation: "/fixture/result" } } }, keys.privateKey);
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }); const route = await jiti.import("./peer/route.ts"); const response = await route.POST(new Request("http://127.0.0.1/api/session-control/peer", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1" }, body: JSON.stringify(envelope) }));
  assert.equal(response.status, 400); assert.equal(core.readState(root, "reader").inbox[envelope.messageId], undefined);
});
