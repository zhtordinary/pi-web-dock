import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
const require = createRequire(import.meta.url);
const core = require("../bin/session-wait-core.cjs");
const workerPath = join(process.cwd(), "bin", "session-wait-worker.cjs");
const identity = (deviceId, sessionId) => ({ deviceId, sessionId, sessionFile: `/fixture/${deviceId}/${sessionId}.jsonl` });
import { runProcess as run, waitForWorkerIdle } from "../test-support/test-process.mjs";
function waitForExit(child) { return new Promise((resolve) => child.once("exit", resolve)); }

test("real worker subprocess survives restart, runs structured argv and HTTP peer ack is durable", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "reader-session-wait-e2e-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const health = join(root, "health.json"); const channel = "e2e"; const owner = identity("device-a", "session-a"); const receiver = identity("device-b", "session-b");
  const wait = core.createWait(root, channel, { id: "persistent", owner, target: receiver, condition: "acceptance_passed" });
  const running = spawn(process.execPath, [workerPath, "--state-root", root, "--channel", channel, "--health-file", health, "--poll-ms", "1000"], { stdio: "ignore" });
  t.after(() => { if (running.exitCode === null && running.signalCode === null) running.kill("SIGKILL"); });
  await waitForWorkerIdle(running, health);
  running.kill("SIGTERM"); await waitForExit(running);
  assert.equal(core.readState(root, channel).waits.persistent.status, "waiting");
  const restarted = await run(process.execPath, [workerPath, "--state-root", root, "--channel", channel, "--health-file", health, "--once"]);
  assert.equal(restarted.code, 0, restarted.stderr); assert.equal(core.readState(root, channel).waits.persistent.status, "waiting"); assert.equal(JSON.parse(readFileSync(health, "utf8")).status, "idle");

  const resultLocation = join(root, "task-result.txt");
  const externalIdentity = identity("worker", "external:argv-task");
  const externalWait = core.createWait(root, channel, { id: "external-wait", owner, target: externalIdentity, condition: "task_completed", taskId: "argv-task" });
  const task = core.enqueueExternalTask(root, channel, { id: "argv-task", argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'fixture-ok')", resultLocation], resultLocation, timeoutMs: 5000, identity: externalIdentity, waitId: externalWait.id });
  const taskRun = await run(process.execPath, [workerPath, "--state-root", root, "--channel", channel, "--once"]);
  assert.equal(taskRun.code, 0, taskRun.stderr); const savedTask = core.listExternalTasks(root, channel).find((candidate) => candidate.id === task.id); assert.equal(savedTask.status, "completed"); assert.equal(savedTask.exitCode, 0); assert.equal(savedTask.resultVerified, true); assert.equal(savedTask.pid > 0, true); assert.equal(core.getStatus(root, channel).waits.find((candidate) => candidate.id === externalWait.id), undefined); assert.equal(core.readState(root, channel).terminalWaits[externalWait.id].status, "completed");

  const keys = core.generatePeerKeyPair(); const resultKeys = core.generatePeerKeyPair(); const envelope = core.createSignedEnvelope({ channel, sender: receiver, recipient: receiver.deviceId, operation: "wake", scope: ["resume_prior_work"], body: { target: receiver, event: { id: "peer-event", type: "acceptance_passed", acceptance: { criterion: "fixture", digest: "fixture-digest" }, identity: receiver, waitId: wait.id, success: true, resultLocation } } }, resultKeys.privateKey);
  let wakeAdmissions = 0;
  const server = createServer((request, response) => {
    let body = ""; request.on("data", (chunk) => { body += chunk; }); request.on("end", () => {
      try {
        if (request.url?.endsWith("/api/session-control/wake")) { const { pullReceipt } = JSON.parse(body); const result = core.completePullReceipt(root, channel, pullReceipt.pullMessageId, pullReceipt.itemId, "processed", { submitted: true }); assert.equal(result.applied, true); wakeAdmissions += 1; response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ accepted: true, status: "processed" })); return; }
        const received = JSON.parse(body); const accepted = core.acceptPeerEnvelope(root, channel, received, { publicKeys: { [owner.deviceId]: keys.publicKey, [receiver.deviceId]: resultKeys.publicKey }, recipient: receiver.deviceId });
        if (!accepted.accepted) { response.writeHead(403, { "content-type": "application/json" }); response.end(JSON.stringify(accepted)); return; }
        if (received.operation === "pull_messages") { const outbox = core.getStatus(root, channel).outbox.filter((item) => ["pending", "retrying"].includes(item.status) && item.recipient?.deviceId === owner.deviceId).map((item) => ({ ...item, pullMessageId: item.pullMessageId || received.messageId, pullDigest: item.capability?.digest, capability: item.capability })); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ accepted: true, status: "accepted", pullMessageId: received.messageId, outbox })); return; }
        if (!accepted.duplicate) { const event = received.body?.event; if (received.operation === "receipt") { core.applyPeerReceipt(root, channel, received.body); core.completeInbox(root, channel, received.messageId, "processed", { operation: received.operation }); } else if (event) { core.applyEvent(root, channel, event); core.completeInbox(root, channel, received.messageId, "processed", { eventId: event.id }); } else { core.completeInbox(root, channel, received.messageId, "processed", { operation: received.operation }); } }
        response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ accepted: true, duplicate: accepted.duplicate, status: "processed" }));
      } catch (error) { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: String(error) })); }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close()); const address = server.address(); const port = typeof address === "object" && address ? address.port : 0;
  const previousActivityConfig = process.env.PI_WEB_SESSION_ACTIVITY_CONFIG; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: owner.deviceId, name: "owner" }, peers: [{ id: receiver.deviceId, name: "receiver", url: `http://127.0.0.1:${port}` }] }); t.after(() => { if (previousActivityConfig === undefined) delete process.env.PI_WEB_SESSION_ACTIVITY_CONFIG; else process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = previousActivityConfig; });
  core.pairPeer(root, channel, { deviceId: receiver.deviceId, peerUrl: `http://127.0.0.1:${port}`, publicKey: resultKeys.publicKey, sessions: [receiver.sessionId], operations: ["wake", "pull_messages", "receipt"], scopes: ["resume_prior_work", "pull_messages"] });
  const response = await fetch(`http://127.0.0.1:${port}/api/session-control/peer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) }); assert.equal(response.status, 200); assert.equal((await response.json()).accepted, true);
  const duplicateResponse = await fetch(`http://127.0.0.1:${port}/api/session-control/peer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) }); assert.equal((await duplicateResponse.json()).duplicate, true);
  const bridgePlan = core.createPlan(root, channel, { id: "bridge-plan", owner, maxRounds: 1, nodes: [{ id: "A", session: owner, condition: "task_completed", continuation: { message: "Run authorized bridge A", target: owner } }, { id: "B", session: receiver, condition: "acceptance_passed", continuation: { message: "Run authorized bridge B", target: receiver } }] });
  const initialBridgeOutbox = core.getStatus(root, channel).outbox.find((candidate) => candidate.planId === "bridge-plan"); assert.ok(initialBridgeOutbox); core.claimOutbox(root, channel, initialBridgeOutbox.id, "processed");
  core.applyEvent(root, channel, { id: "bridge-a", type: "task_completed", identity: owner, planId: "bridge-plan", waitId: bridgePlan.wait.id, generation: 1, round: 1, success: true, resultLocation });
  const bridgeKeys = keys; const keyFile = join(root, "worker-key.pem"); writeFileSync(keyFile, bridgeKeys.privateKey, { mode: 0o600 }); chmodSync(keyFile, 0o600);
  const bridgeRun = await run(process.execPath, [workerPath, "--state-root", root, "--channel", channel, "--once", "--peer-url", `http://127.0.0.1:${port}`, "--allowed-peer-url", `http://127.0.0.1:${port}`, "--private-key-file", keyFile, "--sender-device-id", owner.deviceId, "--sender-session-id", owner.sessionId]);
  assert.equal(bridgeRun.code, 0, bridgeRun.stderr); const bridgedOutbox = core.readState(root, channel).outbox[Object.keys(core.readState(root, channel).outbox).find((id) => core.readState(root, channel).outbox[id].planId === "bridge-plan" && core.readState(root, channel).outbox[id].recipient?.deviceId === receiver.deviceId)]; assert.equal(bridgedOutbox.status, "processed");
  const pullWait = core.createWait(root, channel, { id: "pull-wait", owner, target: receiver, condition: "task_completed", taskId: "pull-task", continuation: { target: owner, authorizedScope: ["resume_prior_work"], message: "Pull-only approved continuation" } });
  core.applyEvent(root, channel, { id: "pull-task-complete", type: "task_completed", identity: receiver, waitId: pullWait.id, taskId: "pull-task", success: true, resultLocation });
  const pullRun = await run(process.execPath, [workerPath, "--state-root", root, "--channel", channel, "--once", "--mode", "pull", "--peer-url", `http://127.0.0.1:${port}`, "--allowed-peer-url", `http://127.0.0.1:${port}`, "--reader-url", `http://127.0.0.1:${port}`, "--pull-peer-id", receiver.deviceId, "--private-key-file", keyFile, "--sender-device-id", owner.deviceId, "--sender-session-id", owner.sessionId]);
  assert.equal(pullRun.code, 0, pullRun.stderr); assert.match(pullRun.stdout, /"mode": "pull"/); assert.match(pullRun.stdout, /"processed": [1-9]/);
  const pullAgain = await run(process.execPath, [workerPath, "--state-root", root, "--channel", channel, "--once", "--mode", "pull", "--peer-url", `http://127.0.0.1:${port}`, "--allowed-peer-url", `http://127.0.0.1:${port}`, "--reader-url", `http://127.0.0.1:${port}`, "--pull-peer-id", receiver.deviceId, "--private-key-file", keyFile, "--sender-device-id", owner.deviceId, "--sender-session-id", owner.sessionId]); assert.equal(pullAgain.code, 0, pullAgain.stderr); assert.equal(JSON.parse(pullAgain.stdout).delivery.peer.processed, 0); assert.equal(wakeAdmissions, 1);
  const final = core.getStatus(root, channel); assert.equal(final.waits.find((candidate) => candidate.id === wait.id), undefined); assert.equal(core.readState(root, channel).terminalWaits[wait.id].status, "completed"); assert.equal(core.readState(root, channel).inbox[envelope.messageId].status, "processed"); const pullOutbox = Object.values(core.readState(root, channel).outbox).find((candidate) => candidate.waitId === pullWait.id && candidate.recipient?.deviceId === owner.deviceId); assert.equal(pullOutbox.status, "processed"); const persistedReceipt = core.listPullReceipts(root, channel).find((candidate) => candidate.sourceMessageId === pullOutbox.messageId); assert.equal(persistedReceipt.status, "processed"); assert.equal(persistedReceipt.acknowledgedStatus, "processed");
});
