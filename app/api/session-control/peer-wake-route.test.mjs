import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
const require = createRequire(import.meta.url); const core = require("../../../bin/session-wait-core.cjs");

test("actual peer wake route submits a pre-authorized continuation to the exact live session", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-peer-wake-route-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = { root: process.env.PI_WEB_SESSION_WAIT_STATE_ROOT, device: process.env.PI_WEB_DEVICE_ID, config: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG, keys: process.env.PI_WEB_SESSION_CONTROL_PEER_PUBLIC_KEYS };
  process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = root; process.env.PI_WEB_DEVICE_ID = "device-a"; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "device-a", name: "A" }, peers: [{ id: "device-b", name: "B", url: "http://peer.test" }] });
  const keys = core.generatePeerKeyPair(); process.env.PI_WEB_SESSION_CONTROL_PEER_PUBLIC_KEYS = JSON.stringify({ "device-b": keys.publicKey });
  core.pairPeer(root, "reader", { deviceId: "device-b", peerUrl: "http://peer.test", publicKey: keys.publicKey, sessions: ["session-b"], operations: ["wake", "pull_messages"], scopes: ["resume_prior_work", "pull_messages"] });
  const calls = []; const fake = { sessionId: "session-a", sessionFile: "/fixture/session-a.jsonl", isAlive: () => true, isRunning: () => false, inner: { isBashRunning: false, isCompacting: false }, hasPendingUserInteraction: () => false, sendNativePeerMessage: async (message, options) => { calls.push({ message, options }); } };
  const previous = globalThis.__piSessions; globalThis.__piSessions = new Map([["session-a", fake]]);
  t.after(() => { globalThis.__piSessions = previous; for (const [key, value] of Object.entries({ PI_WEB_SESSION_WAIT_STATE_ROOT: old.root, PI_WEB_DEVICE_ID: old.device, PI_WEB_SESSION_ACTIVITY_CONFIG: old.config, PI_WEB_SESSION_CONTROL_PEER_PUBLIC_KEYS: old.keys })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const sender = { deviceId: "device-b", sessionId: "session-b" }; const envelope = core.createSignedEnvelope({ channel: "reader", sender, recipient: "device-a", operation: "wake", scope: ["resume_prior_work"], body: { operation: "resume_prior_authorized_work", authorizedScope: ["resume_prior_work"], target: { deviceId: "device-a", sessionId: "session-a", sessionFile: fake.sessionFile }, continuation: { target: { deviceId: "device-a", sessionId: "session-a" }, authorizedScope: ["resume_prior_work"], message: "Continue the approved next round" } } }, keys.privateKey);
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }); const route = await jiti.import("./peer/route.ts");
  const response = await route.POST(new Request("http://127.0.0.1/api/session-control/peer", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1" }, body: JSON.stringify(envelope) }));
  assert.equal(response.status, 200); const payload = await response.json(); assert.equal(payload.wake.status, "submitted"); assert.equal(calls[0].message.customType, "pi-web:session-peer"); assert.equal(calls[0].message.content, "Continue the approved next round"); assert.equal(calls[0].message.details.source, "session-control-wake"); assert.equal(calls[0].options.triggerTurn, true);
});

for (const deadClaim of [false, true]) test(`peer wake recovery scan preserves a live claim and rejects a dead claim (${deadClaim})`, async t => {
  const root = mkdtempSync(join(tmpdir(), "session-peer-recovery-"));
  const old = { root: process.env.PI_WEB_SESSION_WAIT_STATE_ROOT, device: process.env.PI_WEB_DEVICE_ID, config: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG };
  process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = root; process.env.PI_WEB_DEVICE_ID = "device-a"; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "device-a" }, peers: [{ id: "device-b", url: "http://peer.test" }] });
  const keys = core.generatePeerKeyPair(), sender = { deviceId: "device-b", sessionId: "sender" }, target = { deviceId: "device-a", sessionId: "target", sessionFile: "/fixture/target.jsonl" };
  core.pairPeer(root, "reader", { deviceId: "device-b", peerUrl: "http://peer.test", publicKey: keys.publicKey, sessions: [sender.sessionId], operations: ["wake"], scopes: ["resume_prior_work"] });
  const envelope = core.createSignedEnvelope({ channel: "reader", sender, recipient: "device-a", operation: "wake", scope: ["resume_prior_work"], body: { operation: "resume_prior_authorized_work", authorizedScope: ["resume_prior_work"], target, continuation: { target, authorizedScope: ["resume_prior_work"], message: "approved" } } }, keys.privateKey);
  const previous = globalThis.__piSessions; let submitted = 0;
  globalThis.__piSessions = new Map([[target.sessionId, { sessionId: target.sessionId, sessionFile: target.sessionFile, isAlive: () => true, isRunning: () => false, inner: {}, sendNativePeerMessage: async (_message, options) => {
    await Promise.resolve();
    if (deadClaim) core.withTransaction(root, "reader", state => { if (state.inbox[envelope.messageId].claim) state.inbox[envelope.messageId].claim.pid = 99999999; });
    core.recoverState(root, "reader");
    if (options.beforeSubmit && !options.beforeSubmit()) throw new Error("notification_no_longer_pending");
    submitted += 1;
  } }]]);
  t.after(() => { globalThis.__piSessions = previous; for (const [key, value] of Object.entries({ PI_WEB_SESSION_WAIT_STATE_ROOT: old.root, PI_WEB_DEVICE_ID: old.device, PI_WEB_SESSION_ACTIVITY_CONFIG: old.config })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); });
  const route = await createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }).import("./peer/route.ts");
  const response = await route.POST(new Request("http://127.0.0.1/api/session-control/peer", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1" }, body: JSON.stringify(envelope) }));
  const payload = await response.json(); assert.equal(submitted, deadClaim ? 0 : 1);
  assert.equal(core.readState(root, "reader").inbox[envelope.messageId].status, deadClaim ? "unknown" : "processed");
  assert.equal(payload.status, deadClaim ? "unknown" : "processed");
});

test("a rejected first peer claim cannot overwrite concurrent cancellation", async t => {
  const root = mkdtempSync(join(tmpdir(), "session-peer-rejected-claim-"));
  const old = { root: process.env.PI_WEB_SESSION_WAIT_STATE_ROOT, device: process.env.PI_WEB_DEVICE_ID, config: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG };
  process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = root; process.env.PI_WEB_DEVICE_ID = "device-a"; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "device-a" }, peers: [{ id: "device-b", url: "http://peer.test" }] });
  const keys = core.generatePeerKeyPair(), sender = { deviceId: "device-b", sessionId: "sender" }, target = { deviceId: "device-a", sessionId: "target", sessionFile: "/fixture/target.jsonl" };
  core.pairPeer(root, "reader", { deviceId: "device-b", peerUrl: "http://peer.test", publicKey: keys.publicKey, sessions: [sender.sessionId], operations: ["wake"], scopes: ["resume_prior_work"] });
  core.createWait(root, "reader", { id: "wait", owner: target, target: sender, condition: "turn_settled" }); core.transitionWait(root, "reader", "wait", "pause");
  const envelope = core.createSignedEnvelope({ channel: "reader", sender, recipient: "device-a", operation: "wake", scope: ["resume_prior_work"], body: { operation: "resume_prior_authorized_work", waitId: "wait", authorizedScope: ["resume_prior_work"], target, continuation: { target, authorizedScope: ["resume_prior_work"], message: "approved" } } }, keys.privateKey);
  const originalClaim = core.claimInboxForDelivery; let afterCancellation;
  core.claimInboxForDelivery = (...args) => { const claim = originalClaim(...args); assert.equal(claim.defer, true); core.transitionWait(root, "reader", "wait", "cancel"); afterCancellation = core.readState(root, "reader").inbox[envelope.messageId].status; return claim; };
  t.after(() => { core.claimInboxForDelivery = originalClaim; for (const [key, value] of Object.entries({ PI_WEB_SESSION_WAIT_STATE_ROOT: old.root, PI_WEB_DEVICE_ID: old.device, PI_WEB_SESSION_ACTIVITY_CONFIG: old.config })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); });
  const route = await createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }).import("./peer/route.ts");
  const response = await route.POST(new Request("http://127.0.0.1/api/session-control/peer", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1" }, body: JSON.stringify(envelope) }));
  assert.equal(response.status, 422); assert.equal(afterCancellation, "cancelled"); assert.equal(core.readState(root, "reader").inbox[envelope.messageId].status, afterCancellation);
});

test("peer wake rechecks revocation after asynchronous preparation", async t => {
  const root = mkdtempSync(join(tmpdir(), "session-peer-final-admission-"));
  const old = { root: process.env.PI_WEB_SESSION_WAIT_STATE_ROOT, device: process.env.PI_WEB_DEVICE_ID, config: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG };
  process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = root; process.env.PI_WEB_DEVICE_ID = "device-a"; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "device-a" }, peers: [{ id: "device-b", url: "http://peer.test" }] });
  const keys = core.generatePeerKeyPair(), sender = { deviceId: "device-b", sessionId: "sender" }, target = { deviceId: "device-a", sessionId: "target", sessionFile: "/fixture/target.jsonl" };
  core.pairPeer(root, "reader", { deviceId: "device-b", peerUrl: "http://peer.test", publicKey: keys.publicKey, sessions: [sender.sessionId], operations: ["wake"], scopes: ["resume_prior_work"] });
  const previous = globalThis.__piSessions; let submitted = 0;
  globalThis.__piSessions = new Map([[target.sessionId, { sessionId: target.sessionId, sessionFile: target.sessionFile, isAlive: () => true, isRunning: () => false, inner: {}, sendNativePeerMessage: async (_message, options) => {
    await Promise.resolve(); core.revokePeer(root, "reader", "device-b");
    if (options.beforeSubmit && !options.beforeSubmit()) throw new Error("notification_no_longer_pending");
    submitted += 1;
  } }]]);
  t.after(() => { globalThis.__piSessions = previous; for (const [key, value] of Object.entries({ PI_WEB_SESSION_WAIT_STATE_ROOT: old.root, PI_WEB_DEVICE_ID: old.device, PI_WEB_SESSION_ACTIVITY_CONFIG: old.config })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); });
  const envelope = core.createSignedEnvelope({ channel: "reader", sender, recipient: "device-a", operation: "wake", scope: ["resume_prior_work"], body: { operation: "resume_prior_authorized_work", authorizedScope: ["resume_prior_work"], target, continuation: { target, authorizedScope: ["resume_prior_work"], message: "approved" } } }, keys.privateKey);
  const route = await createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }).import("./peer/route.ts");
  const response = await route.POST(new Request("http://127.0.0.1/api/session-control/peer", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1" }, body: JSON.stringify(envelope) }));
  assert.equal(response.status, 422); assert.equal(submitted, 0);
  assert.equal(core.readState(root, "reader").inbox[envelope.messageId].status, "blocked");
});

for (const timing of ["before", "during"]) test(`pull wake preserves a blocked receipt when peer authorization is revoked (${timing})`, async t => {
  const root = mkdtempSync(join(tmpdir(), "session-pull-final-admission-")); const source = mkdtempSync(join(tmpdir(), "session-pull-source-"));
  const old = { root: process.env.PI_WEB_SESSION_WAIT_STATE_ROOT, device: process.env.PI_WEB_DEVICE_ID, config: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG };
  process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = root; process.env.PI_WEB_DEVICE_ID = "device-b"; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "device-b" }, peers: [{ id: "device-a", url: "http://peer.test" }] });
  const keys = core.generatePeerKeyPair(), owner = { deviceId: "device-a", sessionId: "owner" }, target = { deviceId: "device-b", sessionId: "target", sessionFile: "/fixture/target.jsonl" };
  core.pairPeer(root, "reader", { deviceId: "device-a", peerUrl: "http://peer.test", publicKey: keys.publicKey, sessions: [owner.sessionId], operations: ["wake"], scopes: ["resume_prior_work"] });
  core.createPlan(source, "reader", { id: "plan", owner, maxRounds: 1, nodes: [{ id: "node", session: target, condition: "task_completed", continuation: { target, authorizedScope: ["resume_prior_work"], message: "approved" } }] });
  const item = core.getStatus(source, "reader").outbox[0];
  core.recordPullReceipt(root, "reader", { pullMessageId: "pull", peerId: "device-a", itemId: item.id, sourceMessageId: item.messageId, itemDigest: item.capability.digest, itemCapability: item.capability });
  const previous = globalThis.__piSessions; let submitted = 0;
  globalThis.__piSessions = new Map([[target.sessionId, { sessionId: target.sessionId, sessionFile: target.sessionFile, isAlive: () => true, isRunning: () => false, inner: {}, sendNativePeerMessage: async (_message, options) => {
    await Promise.resolve(); if (timing === "during") core.revokePeer(root, "reader", "device-a");
    if (options.beforeSubmit && !options.beforeSubmit()) throw new Error("notification_no_longer_pending");
    submitted += 1;
  } }]]);
  t.after(() => { globalThis.__piSessions = previous; for (const [key, value] of Object.entries({ PI_WEB_SESSION_WAIT_STATE_ROOT: old.root, PI_WEB_DEVICE_ID: old.device, PI_WEB_SESSION_ACTIVITY_CONFIG: old.config })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); rmSync(source, { recursive: true, force: true }); });
  const route = await createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }).import("./wake/route.ts");
  if (timing === "before") core.revokePeer(root, "reader", "device-a");
  const response = await route.POST(new Request("http://127.0.0.1/api/session-control/wake", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1" }, body: JSON.stringify({ outbox: item, pullReceipt: { pullMessageId: "pull", itemId: item.id, itemDigest: item.capability.digest } }) }));
  const payload = await response.json();
  assert.equal(submitted, 0); assert.equal(payload.status, "blocked");
  assert.equal(core.listPullReceipts(root, "reader", "pull")[0].status, "blocked");
});

test("local wake rechecks its claimed continuation after cancellation during admission", async t => {
  const root = mkdtempSync(join(tmpdir(), "session-local-wake-cancel-"));
  const old = { root: process.env.PI_WEB_SESSION_WAIT_STATE_ROOT, device: process.env.PI_WEB_DEVICE_ID, config: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG };
  process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = root; process.env.PI_WEB_DEVICE_ID = "device-a"; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "device-a" } });
  const owner = { deviceId: "device-a", sessionId: "owner", sessionFile: "/fixture/owner.jsonl" }, target = { deviceId: "device-a", sessionId: "target" };
  const previous = globalThis.__piSessions; let calls = 0;
  globalThis.__piSessions = new Map([["owner", { sessionId: "owner", sessionFile: owner.sessionFile, isAlive: () => true, isRunning: () => false, inner: {}, sendNativePeerMessage: async (_message, options) => {
    await Promise.resolve(); core.transitionWait(root, "reader", "wait", "cancel");
    if (options.beforeSubmit && !options.beforeSubmit()) throw new Error("notification_no_longer_pending");
    calls += 1;
  } }]]);
  t.after(() => { globalThis.__piSessions = previous; for (const [key, value] of Object.entries({ PI_WEB_SESSION_WAIT_STATE_ROOT: old.root, PI_WEB_DEVICE_ID: old.device, PI_WEB_SESSION_ACTIVITY_CONFIG: old.config })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); });
  core.createWait(root, "reader", { id: "wait", owner, target, condition: "task_completed", continuation: { target: owner, authorizedScope: ["resume_prior_work"], message: "continue" } });
  core.applyEvent(root, "reader", { id: "done", type: "task_completed", identity: target, waitId: "wait", success: true, resultLocation: "/fixture/result" });
  const item = core.getStatus(root, "reader").outbox[0], claim = core.claimOutboxForDelivery(root, "reader", item.id);
  const route = await createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }).import("./wake/route.ts");
  const response = await route.POST(new Request("http://127.0.0.1/api/session-control/wake", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1" }, body: JSON.stringify({ local: true, outbox: claim.item, claimId: claim.claimId }) }));
  const payload = await response.json();
  assert.equal(calls, 0); assert.equal(payload.status, "cancelled");
  assert.equal(core.readState(root, "reader").outbox[item.id].status, "cancelled");
});

test("raw wake outbox injection is rejected without a persisted pull capability", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-peer-raw-wake-")); t.after(() => rmSync(root, { recursive: true, force: true })); const old = { root: process.env.PI_WEB_SESSION_WAIT_STATE_ROOT, device: process.env.PI_WEB_DEVICE_ID, config: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG }; process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = root; process.env.PI_WEB_DEVICE_ID = "device-a"; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "device-a", name: "A" } }); t.after(() => { for (const [key, value] of Object.entries({ PI_WEB_SESSION_WAIT_STATE_ROOT: old.root, PI_WEB_DEVICE_ID: old.device, PI_WEB_SESSION_ACTIVITY_CONFIG: old.config })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }); const route = await jiti.import("./wake/route.ts"); const response = await route.POST(new Request("http://127.0.0.1/api/session-control/wake", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1" }, body: JSON.stringify({ outbox: { id: "forged", target: { deviceId: "device-a", sessionId: "session-a" }, authorizedScope: ["resume_prior_work"], continuation: { target: { deviceId: "device-a", sessionId: "session-a" }, authorizedScope: ["resume_prior_work"], message: "forged" } } }) })); assert.equal(response.status, 400);
});

test("peer wake rejects continuation scope and file target expansion", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-peer-nested-scope-")); t.after(() => rmSync(root, { recursive: true, force: true })); const old = { root: process.env.PI_WEB_SESSION_WAIT_STATE_ROOT, device: process.env.PI_WEB_DEVICE_ID, config: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG, keys: process.env.PI_WEB_SESSION_CONTROL_PEER_PUBLIC_KEYS }; process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = root; process.env.PI_WEB_DEVICE_ID = "device-a"; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "device-a", name: "A" } }); const keys = core.generatePeerKeyPair(); process.env.PI_WEB_SESSION_CONTROL_PEER_PUBLIC_KEYS = JSON.stringify({ "device-b": keys.publicKey }); t.after(() => { for (const [key, value] of Object.entries({ PI_WEB_SESSION_WAIT_STATE_ROOT: old.root, PI_WEB_DEVICE_ID: old.device, PI_WEB_SESSION_ACTIVITY_CONFIG: old.config, PI_WEB_SESSION_CONTROL_PEER_PUBLIC_KEYS: old.keys })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const envelope = core.createSignedEnvelope({ channel: "reader", sender: { deviceId: "device-b", sessionId: "sender" }, recipient: "device-a", operation: "wake", scope: ["resume_prior_work"], body: { operation: "resume_prior_authorized_work", authorizedScope: ["resume_prior_work"], target: { deviceId: "device-a", sessionId: "session-a", sessionFile: "/fixture/a.jsonl" }, continuation: { target: { deviceId: "device-a", sessionId: "session-a", sessionFile: "/fixture/other.jsonl" }, authorizedScope: ["resume_prior_work", "report_result"], message: "bad" } } }, keys.privateKey); const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }); const route = await jiti.import("./peer/route.ts"); const response = await route.POST(new Request("http://127.0.0.1/api/session-control/peer", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1" }, body: JSON.stringify(envelope) })); assert.equal(response.status, 400); assert.equal(core.readState(root, "reader").inbox[envelope.messageId], undefined);
});

test("raw wake event injection is rejected without signed peer capability", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-peer-raw-event-")); t.after(() => rmSync(root, { recursive: true, force: true })); const old = { root: process.env.PI_WEB_SESSION_WAIT_STATE_ROOT, device: process.env.PI_WEB_DEVICE_ID, config: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG }; process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = root; process.env.PI_WEB_DEVICE_ID = "device-a"; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "device-a", name: "A" } }); t.after(() => { for (const [key, value] of Object.entries({ PI_WEB_SESSION_WAIT_STATE_ROOT: old.root, PI_WEB_DEVICE_ID: old.device, PI_WEB_SESSION_ACTIVITY_CONFIG: old.config })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }); const route = await jiti.import("./wake/route.ts"); const response = await route.POST(new Request("http://127.0.0.1/api/session-control/wake", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1" }, body: JSON.stringify({ event: { id: "forged-event", type: "task_completed", identity: { deviceId: "device-a", sessionId: "session-a" }, success: true, resultLocation: "/fixture/result" } }) })); assert.equal(response.status, 400); assert.equal(core.readState(root, "reader").events["forged-event"], undefined);
});
