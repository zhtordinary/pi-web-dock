import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
const require = createRequire(import.meta.url); const core = require("../../../bin/session-wait-core.cjs");

test("remote report_result tool uses persisted binding and creates signed return outbox", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "remote-result-return-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = { root: process.env.PI_WEB_SESSION_WAIT_STATE_ROOT, device: process.env.PI_WEB_DEVICE_ID, config: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG };
  process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = root; process.env.PI_WEB_DEVICE_ID = "device-b"; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "device-b" }, peers: [{ id: "device-a", url: "http://device-a.test" }] });
  t.after(() => { for (const [key, value] of Object.entries({ PI_WEB_SESSION_WAIT_STATE_ROOT: old.root, PI_WEB_DEVICE_ID: old.device, PI_WEB_SESSION_ACTIVITY_CONFIG: old.config })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const keys = core.generatePeerKeyPair(); const owner = { deviceId: "device-a", sessionId: "owner", sessionFile: "/fixture/a/owner.jsonl" }; const target = { deviceId: "device-b", sessionId: "worker", sessionFile: "/fixture/b/worker.jsonl" };
  core.pairPeer(root, "reader", { deviceId: "device-a", peerUrl: "http://device-a.test", publicKey: keys.publicKey, sessions: [owner.sessionId], operations: ["wake", "report_result"], scopes: ["resume_prior_work", "report_result"] });
  const previous = globalThis.__piSessions; globalThis.__piSessions = new Map([[target.sessionId, { sessionId: target.sessionId, sessionFile: target.sessionFile, isAlive: () => true, isRunning: () => false, inner: { isBashRunning: false, isCompacting: false }, hasPendingUserInteraction: () => false, sendNativePeerMessage: async () => {} }]]); t.after(() => { globalThis.__piSessions = previous; });
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }); const peerRoute = await jiti.import("./peer/route.ts");
  const wake = core.createSignedEnvelope({ channel: "reader", sender: owner, recipient: target.deviceId, operation: "wake", scope: ["resume_prior_work"], body: { operation: "resume_prior_authorized_work", authorizedScope: ["resume_prior_work"], waitId: "remote-wait", generation: 1, round: 1, taskId: "remote-task", target, continuation: { target, authorizedScope: ["resume_prior_work"], message: "run approved task" } } }, keys.privateKey);
  const response = await peerRoute.POST(new Request("http://127.0.0.1/api/session-control/peer", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1" }, body: JSON.stringify(wake) })); assert.equal(response.status, 200); assert.equal((await response.json()).status, "processed");
  let definition; const { createSessionControlExtension } = await jiti.import("../../../lib/session-control.ts"); createSessionControlExtension().factory({ registerTool(value) { definition = value; } });
  const manager = { getSessionId: () => target.sessionId, getSessionFile: () => target.sessionFile, getHeader: () => ({ id: target.sessionId, cwd: "/fixture" }), getSessionName: () => "worker" };
  const result = JSON.parse((await definition.execute("report", { action: "report_result", waitId: "remote-wait", taskId: "remote-task", event: { type: "task_completed", success: true, resultLocation: "/fixture/result.json" } }, undefined, undefined, { cwd: "/fixture", sessionManager: manager })).content[0].text);
  assert.equal(result.accepted, true); assert.equal(result.event.outcome, "queued_for_owner"); const outbox = Object.values(core.readState(root, "reader").outbox).find((item) => item.operation === "report_result"); assert.equal(outbox.recipient.deviceId, owner.deviceId); assert.equal(outbox.resultEvent.identity.sessionId, target.sessionId); assert.equal(outbox.capability.payload.resultEvent.resultLocation, "/fixture/result.json");
});
