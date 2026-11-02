import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const require = createRequire(import.meta.url); const core = require("../bin/session-wait-core.cjs");
const id = { deviceId: "sender", sessionId: "session-a" };
test("signed peer envelope pins device/channel/scope and deduplicates inbox", (t) => {
  const root = mkdtempSync(join(tmpdir(), "reader-peer-auth-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const keys = core.generatePeerKeyPair(); const envelope = core.createSignedEnvelope({ channel: "reader", sender: id, recipient: "receiver", operation: "wake", scope: ["resume_prior_work"], body: { waitId: "w" }, timestamp: Date.now() }, keys.privateKey);
  assert.equal(core.verifySignedEnvelope(envelope, keys.publicKey, { channel: "reader", recipient: "receiver", scope: "resume_prior_work" }).ok, true);
  assert.equal(core.verifySignedEnvelope({ ...envelope, body: { waitId: "tampered" } }, keys.publicKey, { channel: "reader" }).ok, false);
  assert.equal(core.acceptPeerEnvelope(root, "reader", envelope, { publicKeys: { sender: keys.publicKey }, recipient: "receiver" }).accepted, true);
  const duplicate = core.acceptPeerEnvelope(root, "reader", envelope, { publicKeys: { sender: keys.publicKey }, recipient: "receiver" }); assert.equal(duplicate.duplicate, true);
  assert.equal(core.acceptPeerEnvelope(root, "reader", envelope, { publicKeys: {}, recipient: "receiver" }).accepted, false);
  assert.equal(core.verifySignedEnvelope(envelope, keys.publicKey, { channel: "reader", scope: "pull_messages" }).reason, "scope_denied");
});

test("state instance identity follows the configured activity device, not hostname fallback", (t) => {
  const root = mkdtempSync(join(tmpdir(), "reader-peer-identity-")); const old = { config: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG, device: process.env.PI_WEB_DEVICE_ID }; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "configured-device", name: "Configured" } }); delete process.env.PI_WEB_DEVICE_ID; t.after(() => { rmSync(root, { recursive: true, force: true }); if (old.config === undefined) delete process.env.PI_WEB_SESSION_ACTIVITY_CONFIG; else process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = old.config; if (old.device === undefined) delete process.env.PI_WEB_DEVICE_ID; else process.env.PI_WEB_DEVICE_ID = old.device; });
  core.createWait(root, "reader", { id: "identity-wait", owner: { deviceId: "configured-device", sessionId: "owner" }, target: { deviceId: "configured-device", sessionId: "target" }, condition: "turn_settled" }); assert.equal(core.readState(root, "reader").instanceId, "configured-device");
});
