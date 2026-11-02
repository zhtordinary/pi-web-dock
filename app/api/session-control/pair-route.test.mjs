import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const require = createRequire(import.meta.url); const core = require("../../../bin/session-wait-core.cjs");

test("authenticated pair route persists and revokes a peer pin", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-peer-pair-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = { root: process.env.PI_WEB_SESSION_WAIT_STATE_ROOT, config: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG }; process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = root; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "local", name: "Local" }, peers: [{ id: "peer", name: "Peer", url: "http://peer.test" }] }); t.after(() => { if (old.root === undefined) delete process.env.PI_WEB_SESSION_WAIT_STATE_ROOT; else process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = old.root; if (old.config === undefined) delete process.env.PI_WEB_SESSION_ACTIVITY_CONFIG; else process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = old.config; });
  const keys = core.generatePeerKeyPair(); const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }); const route = await jiti.import("./pair/route.ts");
  const request = (body) => new Request("http://127.0.0.1/api/session-control/pair", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1" }, body: JSON.stringify(body) });
  const paired = await route.POST(request({ deviceId: "peer", peerUrl: "http://peer.test", publicKey: keys.publicKey, sessions: ["session"], operations: ["wake"], scopes: ["resume_prior_work"] })); assert.equal(paired.status, 200);
  const listed = await route.GET(new Request("http://127.0.0.1/api/session-control/pair", { headers: { host: "127.0.0.1" } })); assert.equal((await listed.json()).peers[0].deviceId, "peer");
  const revoked = await route.POST(request({ action: "revoke", deviceId: "peer" })); assert.equal(revoked.status, 200); assert.ok(core.listPeerPins(root, "reader")[0].revokedAt);
  const envelope = core.createSignedEnvelope({ channel: "reader", sender: { deviceId: "peer", sessionId: "session" }, recipient: "local", operation: "pull_messages", scope: ["pull_messages"], body: {} }, keys.privateKey);
  assert.equal(core.acceptPeerEnvelope(root, "reader", envelope, { recipient: "local" }).reason, "peer_not_paired");
});
