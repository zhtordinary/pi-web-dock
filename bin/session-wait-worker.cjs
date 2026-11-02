#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("./session-wait-core.cjs");
const lockIdentity = require("./session-wait-lock.cjs");

function defaultRoot() { return process.env.PI_WEB_SESSION_WAIT_STATE_ROOT || path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "session-control-waits"); }
function args(argv) {
  const out = { stateRoot: defaultRoot(), channel: process.env.PI_WEB_SESSION_WAIT_CHANNEL || "reader", pollMs: 1000, once: false, healthFile: null, peerUrl: null, allowedPeerUrls: [], privateKeyFile: null, senderDeviceId: null, senderSessionId: null, senderFile: null, mode: "push", pullPeerId: null, readerUrl: process.env.PI_WEB_SESSION_WAIT_READER_URL || null };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    const next = () => argv[++i];
    if (value === "--state-root") out.stateRoot = next(); else if (value.startsWith("--state-root=")) out.stateRoot = value.slice(13);
    else if (value === "--channel") out.channel = next(); else if (value.startsWith("--channel=")) out.channel = value.slice(10);
    else if (value === "--poll-ms") out.pollMs = Math.max(100, Math.min(60_000, Number(next()) || 1000)); else if (value.startsWith("--poll-ms=")) out.pollMs = Math.max(100, Math.min(60_000, Number(value.slice(10)) || 1000));
    else if (value === "--health-file") out.healthFile = next(); else if (value.startsWith("--health-file=")) out.healthFile = value.slice(14);
    else if (value === "--peer-url") out.peerUrl = next(); else if (value.startsWith("--peer-url=")) out.peerUrl = value.slice(11);
    else if (value === "--allowed-peer-url") out.allowedPeerUrls.push(next()); else if (value.startsWith("--allowed-peer-url=")) out.allowedPeerUrls.push(value.slice(19));
    else if (value === "--private-key-file") out.privateKeyFile = next(); else if (value.startsWith("--private-key-file=")) out.privateKeyFile = value.slice(19);
    else if (value === "--sender-device-id") out.senderDeviceId = next(); else if (value.startsWith("--sender-device-id=")) out.senderDeviceId = value.slice(19);
    else if (value === "--sender-session-id") out.senderSessionId = next(); else if (value.startsWith("--sender-session-id=")) out.senderSessionId = value.slice(19);
    else if (value === "--sender-file") out.senderFile = next(); else if (value.startsWith("--sender-file=")) out.senderFile = value.slice(14);
    else if (value === "--mode") out.mode = next(); else if (value.startsWith("--mode=")) out.mode = value.slice(7);
    else if (value === "--pull-peer-id") out.pullPeerId = next(); else if (value.startsWith("--pull-peer-id=")) out.pullPeerId = value.slice(16);
    else if (value === "--reader-url") out.readerUrl = next(); else if (value.startsWith("--reader-url=")) out.readerUrl = value.slice(13);
    else if (value === "--once") out.once = true;
    else if (value === "--help" || value === "-h") { console.log(JSON.stringify({ usage: "session-wait-worker --state-root DIR --channel NAME [--once]", notes: ["independent process", "does not call an LLM", "unknown external effects are not replayed", "peer bridge requires an explicit configured allowed-peer-url", "mode=pull consumes signed pull responses through the local Reader wake route"] }, null, 2)); process.exit(0); }
  }
  if (!out.stateRoot || !out.channel) throw new Error("state root and channel are required");
  if (!["push", "pull"].includes(out.mode)) throw new Error("mode must be push or pull");
  return out;
}
function writeHealth(options, status, extra = {}) { if (!options.healthFile) return; fs.mkdirSync(path.dirname(path.resolve(options.healthFile)), { recursive: true, mode: 0o700 }); fs.writeFileSync(options.healthFile, JSON.stringify({ schema: 1, pid: process.pid, channel: options.channel, status, updatedAt: new Date().toISOString(), ...extra }, null, 2) + "\n", { mode: 0o600 }); }
function workerLock(options) { return path.join(path.resolve(options.stateRoot), `.worker-${options.channel}.lock`); }
function pidStartToken(pid) { return lockIdentity.startIdentity(pid); }
function processAlive(pid, startToken) { return lockIdentity.isAlive(pid, startToken); }
function writeLockOwner(lock) { fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, startToken: pidStartToken(process.pid), nonce: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`, acquiredAt: new Date().toISOString() }) + "\n", { mode: 0o600 }); }
function acquireWorkerLock(options) {
  const lock = workerLock(options); fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  try { fs.mkdirSync(lock, { recursive: false, mode: 0o700 }); writeLockOwner(lock); return lock; }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let owner = null; try { owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")); } catch { /* incomplete lock is treated as unsafe */ }
    const alive = owner?.pid ? processAlive(owner.pid, owner.startToken) : false;
    if (alive || !owner?.pid || (process.platform === "linux" && !owner.startToken)) throw new Error("another session-wait worker already owns this channel or lock metadata is unsafe");
    const stale = `${lock}.stale-${owner.pid}-${Date.now()}`; fs.renameSync(lock, stale); fs.rmSync(stale, { recursive: true, force: true });
    fs.mkdirSync(lock, { recursive: false, mode: 0o700 }); writeLockOwner(lock); return lock;
  }
}
function releaseWorkerLock(lock) { fs.rmSync(lock, { recursive: true, force: true }); }
function configuredPeer(options) { return Boolean(options.peerUrl && options.privateKeyFile && options.senderDeviceId && options.senderSessionId); }
function trustedPeerUrl(options, peerId) {
  if (!options.peerUrl || !options.allowedPeerUrls.some((candidate) => core.sameOrigin(candidate, options.peerUrl))) return null;
  const configured = core.resolveConfiguredPeerUrl(peerId); if (!configured || !core.sameOrigin(configured, options.peerUrl)) return null;
  try { const pin = core.readState(options.stateRoot, options.channel).peers[peerId]; if (!pin || pin.revokedAt || (pin.peerUrl && !core.sameOrigin(pin.peerUrl, options.peerUrl))) return null; } catch { return null; }
  return options.peerUrl;
}
async function deliverLocalOutbox(options) {
  if (!options.readerUrl) return { mode: "unconfigured", attempted: 0 };
  const localDeviceId = options.senderDeviceId || core.configuredDeviceId(); const status = core.getStatus(options.stateRoot, options.channel); const results = []; let attempted = 0;
  for (const candidate of status.outbox.filter((item) => ["pending", "retrying"].includes(item.status) && item.recipient?.deviceId === localDeviceId)) {
    if (candidate.nextAttemptAt && Date.parse(candidate.nextAttemptAt) > Date.now()) continue;
    const claim = core.claimOutboxForDelivery(options.stateRoot, options.channel, candidate.id); if (!claim.claimed) continue; attempted += 1;
    try {
      const response = await fetch(new URL("/api/session-control/wake", options.readerUrl), { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ local: true, outbox: claim.item, claimId: claim.claimId }), signal: AbortSignal.timeout(10_000) });
      const payload = await response.json().catch(() => ({})); const resultStatus = response.ok && ["processed", "queued", "blocked", "cancelled", "unknown"].includes(payload.status) ? payload.status : response.ok ? "unknown" : "blocked";
      results.push({ messageId: candidate.messageId, status: resultStatus, httpStatus: response.status }); const completed = core.completeOutboxDelivery(options.stateRoot, options.channel, candidate.id, resultStatus, claim.claimId, { httpStatus: response.status, wakeStatus: payload.status });
      if (completed?.applied === false && payload.status === "processed") results.at(-1).status = "processed";
    } catch (error) { results.push({ messageId: candidate.messageId, status: "unknown", reason: error instanceof Error ? error.message : String(error) }); core.completeOutboxDelivery(options.stateRoot, options.channel, candidate.id, "unknown", claim.claimId, { reason: error instanceof Error ? error.message : String(error) }); }
  }
  return { mode: "local", attempted, results };
}
function envelopeBody(payload) {
  if (payload.operation === "report_result" && payload.resultEvent && typeof payload.resultEvent === "object") return { ...(payload.condition ? { condition: payload.condition } : {}), waitId: payload.waitId, planId: payload.planId, taskId: payload.taskId, generation: payload.generation, round: payload.round, authorizedScope: payload.authorizedScope, operation: payload.operation, target: payload.target, owner: payload.recipient, event: payload.resultEvent };
  if (payload.operation === "observe_wait") return { ...(payload.condition ? { condition: payload.condition } : {}), waitId: payload.waitId, planId: payload.planId, taskId: payload.taskId, generation: payload.generation, round: payload.round, authorizedScope: payload.authorizedScope, operation: payload.operation, target: payload.target, owner: payload.owner || payload.sender };
  return { ...(payload.condition ? { condition: payload.condition } : {}), waitId: payload.waitId, planId: payload.planId, taskId: payload.taskId, generation: payload.generation, round: payload.round, authorizedScope: payload.authorizedScope, operation: payload.operation, target: payload.target, owner: payload.owner || payload.sender, continuation: payload.continuation };
}
async function deliverPendingOutbox(options) {
  if (!configuredPeer(options) || options.mode !== "push") return { mode: "unconfigured", attempted: 0 };
  const privateKey = fs.readFileSync(path.resolve(options.privateKeyFile), "utf8"); const state = core.getStatus(options.stateRoot, options.channel); let attempted = 0; const results = [];
  const localDeviceId = options.senderDeviceId || core.configuredDeviceId();
  for (const item of state.outbox.filter((candidate) => ["pending", "retrying", "queued", "unknown"].includes(candidate.status) && candidate.recipient?.deviceId && candidate.recipient.deviceId !== localDeviceId)) {
    const peerUrl = trustedPeerUrl(options, item.recipient.deviceId); if (!peerUrl) { results.push({ messageId: item.messageId, status: "blocked", reason: "peer URL is not paired/configured" }); if (item.status !== "unknown") { try { core.claimOutbox(options.stateRoot, options.channel, item.id, "blocked"); } catch {} } continue; }
    const isObservation = item.status === "unknown" || item.status === "queued"; const claim = isObservation ? { claimed: true, claimId: null, item, capability: item.capability } : core.claimOutboxForDelivery(options.stateRoot, options.channel, item.id); if (!claim.claimed || (!isObservation && !claim.claimId) || !claim.capability) continue; attempted += 1;
    const payload = claim.capability;
    try {
      const event = payload.resultEvent && typeof payload.resultEvent === "object" ? payload.resultEvent : null; const sender = event?.identity && typeof event.identity === "object" ? event.identity : { deviceId: options.senderDeviceId, sessionId: options.senderSessionId, ...(options.senderFile ? { sessionFile: options.senderFile } : {}) };
      const operation = payload.operation === "report_result" ? "report_result" : payload.operation === "observe_wait" ? "observe_wait" : "wake"; const scope = Array.isArray(payload.authorizedScope) && payload.authorizedScope.length ? payload.authorizedScope : operation === "report_result" ? ["report_result"] : operation === "observe_wait" ? ["observe_wait"] : ["resume_prior_work"];
      if (item.status === "queued" || item.status === "unknown") {
        const query = core.createSignedEnvelope({ channel: options.channel, sender: { deviceId: options.senderDeviceId, sessionId: options.senderSessionId }, recipient: item.recipient.deviceId, operation: "receipt_query", scope: ["pull_messages"], body: { messageId: item.messageId, outboxId: item.id, capabilityDigest: item.capability?.digest } }, privateKey);
        const response = await fetch(new URL("/api/session-control/peer", peerUrl), { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(query), signal: AbortSignal.timeout(10_000) }); const remote = await response.json().catch(() => ({})); const resultStatus = response.ok && ["processed", "queued", "blocked", "unknown"].includes(remote.status) ? remote.status : "unknown"; results.push({ messageId: item.messageId, status: resultStatus, receiptQuery: true, httpStatus: response.status }); if (resultStatus === "processed" || resultStatus === "blocked") core.completeOutboxDelivery(options.stateRoot, options.channel, item.id, resultStatus, claim.claimId || undefined, { receiptQuery: true, httpStatus: response.status }); continue;
      }
      const envelope = core.createSignedEnvelope({ channel: options.channel, sender, recipient: item.recipient.deviceId, messageId: item.messageId, generation: payload.generation, round: payload.round, scope, operation, body: envelopeBody(payload) }, privateKey);
      const response = await fetch(new URL("/api/session-control/peer", peerUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(10_000) }); const remote = await response.json().catch(() => ({})); const resultStatus = !response.ok ? "blocked" : remote.status === "processed" ? "processed" : remote.status === "queued" ? "queued" : remote.status === "blocked" ? "blocked" : "unknown"; results.push({ messageId: item.messageId, status: resultStatus, recipientStatus: remote.status, httpStatus: response.status }); core.completeOutboxDelivery(options.stateRoot, options.channel, item.id, resultStatus, claim.claimId, { recipientReceipt: { status: resultStatus, at: new Date().toISOString() } });
    } catch (error) { results.push({ messageId: item.messageId, status: "unknown", reason: error instanceof Error ? error.message : String(error) }); core.completeOutboxDelivery(options.stateRoot, options.channel, item.id, "unknown", claim.claimId, { reason: error instanceof Error ? error.message : String(error) }); }
  }
  return { mode: "configured", attempted, results };
}
async function acknowledgePullReceipts(options, privateKey, peerUrl) {
  const receipts = core.listPullReceipts(options.stateRoot, options.channel).filter(receipt => receipt.peerId === options.pullPeerId && ["queued", "processed", "blocked", "unknown"].includes(receipt.status) && receipt.acknowledgedStatus !== receipt.status);
  for (const receipt of receipts) {
    const ack = core.createSignedEnvelope({ channel: options.channel, sender: { deviceId: options.senderDeviceId, sessionId: options.senderSessionId }, recipient: receipt.peerId, operation: "receipt", scope: ["pull_messages"], body: { messageId: receipt.sourceMessageId, outboxId: receipt.itemId, status: receipt.status, pullMessageId: receipt.pullMessageId, pullDigest: receipt.itemDigest } }, privateKey);
    try {
      const response = await fetch(new URL("/api/session-control/peer", peerUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ack), signal: AbortSignal.timeout(10_000) });
      const result = await response.json().catch(() => ({}));
      if (response.ok && result.accepted === true && result.status === "processed") core.acknowledgePullReceipt(options.stateRoot, options.channel, receipt.pullMessageId, receipt.itemId, receipt.status);
    } catch { /* Retry the receipt on the next poll, never the execution. */ }
  }
}
async function pullPeerMessages(options) {
  if (options.mode !== "pull" || !configuredPeer(options) || !options.pullPeerId || !options.readerUrl) return { mode: "unconfigured", pulled: 0 };
  const privateKey = fs.readFileSync(path.resolve(options.privateKeyFile), "utf8"); const peerUrl = trustedPeerUrl(options, options.pullPeerId); if (!peerUrl) return { mode: "blocked", pulled: 0, reason: "peer URL is not paired/configured" };
  await acknowledgePullReceipts(options, privateKey, peerUrl);
  const envelope = core.createSignedEnvelope({ channel: options.channel, sender: { deviceId: options.senderDeviceId, sessionId: options.senderSessionId }, recipient: options.pullPeerId, operation: "pull_messages", scope: ["pull_messages"], body: { request: "pull" } }, privateKey);
  const response = await fetch(new URL("/api/session-control/peer", peerUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(10_000) }); if (!response.ok) return { mode: "blocked", pulled: 0, httpStatus: response.status };
  const payload = await response.json(); const messages = Array.isArray(payload.outbox) ? payload.outbox : []; let processed = 0; let queued = 0; let blocked = 0;
  for (const item of messages) {
    if (item.recipient?.deviceId !== options.senderDeviceId || !item.continuation && item.operation !== "report_result" || !item.capability || typeof item.pullDigest !== "string") continue;
    const capability = core.verifyOutboxCapability(item); if (!capability.ok || capability.digest !== item.pullDigest) { blocked += 1; continue; }
    const pullMessageId = typeof item.pullMessageId === "string" ? item.pullMessageId : item.messageId; const pullReceipt = core.recordPullReceipt(options.stateRoot, options.channel, { pullMessageId, peerId: options.pullPeerId, itemId: item.id, sourceMessageId: item.messageId, itemDigest: item.pullDigest, itemCapability: item.capability });
    let localStatus = "unknown";
    try {
      const local = await fetch(new URL("/api/session-control/wake", options.readerUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outbox: item, pullReceipt: { pullMessageId, itemId: item.id, itemDigest: pullReceipt.itemDigest } }) });
      const localPayload = await local.json().catch(() => ({})); localStatus = typeof localPayload.status === "string" ? localPayload.status : "unknown";
      if (!local.ok || !["queued", "processed", "blocked"].includes(localStatus)) core.markUnclaimedPullReceiptUnknown(options.stateRoot, options.channel, pullMessageId, item.id);
    } catch { core.markUnclaimedPullReceiptUnknown(options.stateRoot, options.channel, pullMessageId, item.id); }
    if (localStatus === "processed") processed += 1; else if (localStatus === "queued") queued += 1; else blocked += 1;
  }
  await acknowledgePullReceipts(options, privateKey, peerUrl);
  const acknowledgementPending = core.listPullReceipts(options.stateRoot, options.channel).filter(receipt => receipt.peerId === options.pullPeerId && ["queued", "processed", "blocked", "unknown"].includes(receipt.status) && receipt.acknowledgedStatus !== receipt.status).length;
  return { mode: "pull", pulled: messages.length, processed, queued, blocked, acknowledgementPending };
}
async function once(options) {
  fs.mkdirSync(path.resolve(options.stateRoot), { recursive: true, mode: 0o700 }); const lock = acquireWorkerLock(options);
  try {
    core.recoverState(options.stateRoot, options.channel); writeHealth(options, "running");
    const tasks = core.listExternalTasks(options.stateRoot, options.channel); const children = []; const failures = []; const spawnedIds = [];
    for (const task of tasks.filter((candidate) => candidate.status === "queued")) { spawnedIds.push(task.id); const result = core.spawnStructuredTask(options.stateRoot, options.channel, task.id); if (result.error) failures.push(result.error); if (result.child) children.push(new Promise((resolve) => result.child.once("close", (code, signal) => resolve({ code, signal })))); }
    if (children.length) await Promise.all(children);
    const failedTasks = core.listExternalTasks(options.stateRoot, options.channel).filter((candidate) => spawnedIds.includes(candidate.id) && candidate.status === "failed"); if (failedTasks.length) failures.push(...failedTasks.map((candidate) => candidate.error || `external task ${candidate.id} failed`));
    if (failures.length) throw new Error(failures.join("; "));
    const local = await deliverLocalOutbox(options); const delivery = options.mode === "pull" ? await pullPeerMessages(options) : await deliverPendingOutbox(options); const status = core.getStatus(options.stateRoot, options.channel);
    writeHealth(options, "idle", { revision: status.revision, waits: status.waits.length, plans: status.plans.length, externalTasks: core.listExternalTasks(options.stateRoot, options.channel).length, delivery: { local, peer: delivery } }); return { status, delivery: { local, peer: delivery } };
  } finally { releaseWorkerLock(lock); }
}
async function main() { const options = args(process.argv.slice(2)); if (options.once) { const result = await once(options); console.log(JSON.stringify({ ok: true, mode: "once", channel: options.channel, revision: result.status.revision, waits: result.status.waits.length, plans: result.status.plans.length, delivery: result.delivery }, null, 2)); return; } let stopping = false; const stop = () => { stopping = true; }; process.once("SIGTERM", stop); process.once("SIGINT", stop); while (!stopping) { try { await once(options); } catch (error) { writeHealth(options, "blocked", { reason: error instanceof Error ? error.message : String(error) }); console.error(`[session-wait-worker] ${error instanceof Error ? error.message : String(error)}`); } if (!stopping) await new Promise((resolve) => setTimeout(resolve, options.pollMs)); } writeHealth(options, "stopped"); }
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
