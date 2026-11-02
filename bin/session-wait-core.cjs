/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const { acquireStateWriteLock, legacyStateWriterLockEntries } = require("./state-write-lock.cjs");
const { sanitizeProjectCommandEnvironment } = require("./project-command-env.cjs");

const SCHEMA_VERSION = 1;
const CONDITIONS = new Set(["turn_settled", "task_completed", "acceptance_passed", "ui_request"]);
const WAIT_STATUSES = new Set(["waiting", "running", "retrying", "blocked", "paused", "completed", "failed", "cancelled"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const EVENT_TYPES = new Set(["ui_request", "turn_settled", "task_completed", "acceptance_passed", "task_failed", "progress", "handoff_accepted", "wake_accepted", "wake_processed", "runtime_event"]);
const OUTBOX_STATUSES = new Set(["pending", "in_flight", "accepted", "retrying", "queued", "blocked", "unknown", "processed", "cancelled"]);
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 64 * 1024;

function isoNow() { return new Date().toISOString(); }
function randomId(prefix = "") { return `${prefix}${crypto.randomBytes(16).toString("hex")}`; }
function isRecord(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function clone(value) {
  try { return JSON.parse(JSON.stringify(value)); }
  catch (error) { throw new Error("state value is not cloneable", { cause: error }); }
}
function shortText(value, max = 4000) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
function assertString(value, label, max = 512) {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}
function assertId(value, label) {
  const id = assertString(value, label, 256);
  if (!/^[A-Za-z0-9._:@/-]+$/.test(id)) throw new Error(`${label} contains unsupported characters`);
  return id;
}
function assertCondition(value) {
  if (!CONDITIONS.has(value)) throw new Error(`unsupported completion condition: ${value}`);
  return value;
}
function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
}
function canonicalJson(value) { return JSON.stringify(sortedValue(value)); }
function sha256(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return crypto.createHash("sha256").update(value).digest("hex");
  return crypto.createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}
function normalizeIdentity(value, label = "identity") {
  if (!isRecord(value)) throw new Error(`${label} is required`);
  return {
    deviceId: assertId(value.deviceId, `${label}.deviceId`),
    sessionId: assertId(value.sessionId, `${label}.sessionId`),
    ...(value.sessionFile == null ? {} : { sessionFile: assertString(value.sessionFile, `${label}.sessionFile`, 2000) }),
    ...(value.title == null ? {} : { title: assertString(value.title, `${label}.title`, 512) }),
  };
}
function sameIdentity(left, right) { return left?.deviceId === right?.deviceId && left?.sessionId === right?.sessionId; }
function samePath(left, right) {
  if (!left || !right) return left === right;
  try { return fs.realpathSync(left) === fs.realpathSync(right); } catch { return left === right; }
}
function ensureChannel(channel) { return assertId(channel || "default", "channel"); }
function normalizeRoot(root) { return path.resolve(assertString(root, "stateRoot", 2000)); }
function stateFile(root, channel) { return path.join(normalizeRoot(root), `${ensureChannel(channel)}.json`); }
function lockDir(root, channel) { return `${stateFile(root, channel)}.lock`; }
function pidStartToken(pid) {
  if (process.platform !== "linux") return null;
  try {
    const fields = fs.readFileSync(`/proc/${pid}/stat`, "utf8").trim().split(" ");
    return fields[21] || null;
  } catch { return null; }
}
function processAlive(pid, startToken) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (error) { return error?.code === "EPERM"; }
  return !startToken || !pidStartToken(pid) || pidStartToken(pid) === startToken;
}
function claimIdentity() { return { pid: process.pid, startToken: pidStartToken(process.pid), nonce: randomId("claim-") }; }
function claimIsAlive(claim) { return Boolean(claim && processAlive(claim.pid, claim.startToken)); }
const { readActivityConfig, localDeviceId } = require("./device-identity.cjs");
function configuredDeviceId() { return assertId(localDeviceId(), "deviceId"); }
function resolveConfiguredPeerUrl(peerId) { const config = readActivityConfig(); const peers = Array.isArray(config?.peers) ? config.peers : []; const peer = peers.find((candidate) => candidate?.id === peerId && typeof candidate.url === "string"); return peer?.url || null; }
function sameOrigin(left, right) { try { return new URL(left).origin === new URL(right).origin; } catch { return false; } }

function initialState(channel, instanceId = configuredDeviceId()) {
  return {
    schema: SCHEMA_VERSION, channel: ensureChannel(channel), instanceId: assertId(instanceId, "instanceId"),
    revision: 0, createdAt: isoNow(), updatedAt: isoNow(),
    waits: {}, terminalWaits: {}, plans: {}, events: {}, eventOrder: [], pendingEvents: {}, inbox: {}, outbox: {}, receipts: {},
    externalTasks: {}, cursors: {}, notifications: {}, peers: {}, pullReceipts: {}, remoteBindings: {},
  };
}
function validateState(state, channel) {
  if (!isRecord(state) || state.schema !== SCHEMA_VERSION) throw new Error("state schema is unknown; refusing to reset");
  if (state.channel !== ensureChannel(channel)) throw new Error("state channel mismatch");
  for (const key of ["waits", "plans", "events", "pendingEvents", "inbox", "outbox", "receipts", "externalTasks", "cursors", "notifications"]) {
    if (!isRecord(state[key])) throw new Error(`state.${key} is corrupt`);
  }
  if (!isRecord(state.peers)) state.peers = {};
  if (!isRecord(state.pullReceipts)) state.pullReceipts = {};
  if (!isRecord(state.remoteBindings)) state.remoteBindings = {};
  if (!isRecord(state.terminalWaits)) state.terminalWaits = {};
  if (!Array.isArray(state.eventOrder)) throw new Error("state.eventOrder is corrupt");
  return state;
}
function readState(root, channel, options = {}) {
  const file = stateFile(root, channel);
  if (!fs.existsSync(file)) return initialState(channel, options.instanceId);
  try { return validateState(JSON.parse(fs.readFileSync(file, "utf8")), channel); }
  catch (error) { throw new Error(`state is corrupt and was not reset: ${error instanceof Error ? error.message : String(error)}`); }
}
function fsyncDirectory(directory) {
  try { const fd = fs.openSync(directory, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch (error) { if (!["EINVAL", "ENOTSUP"].includes(error?.code)) throw error; }
}
function atomicWriteJson(file, value) {
  try { if (fs.lstatSync(file).isSymbolicLink()) file = fs.realpathSync(file); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file); fsyncDirectory(path.dirname(file));
}
function readLockOwner(lock) {
  try {
    const lockStat = fs.lstatSync(lock);
    if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) return null;
    const ownerPath = path.join(lock, "owner.json");
    const ownerStat = fs.lstatSync(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) return null;
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    if (!isRecord(owner) || !Number.isInteger(owner.pid) || owner.pid <= 0) return null;
    if (process.platform === "linux" && (typeof owner.startToken !== "string" || !/^[0-9]+$/.test(owner.startToken))) return null;
    if (process.platform !== "linux" && owner.startToken !== null && owner.startToken !== undefined && typeof owner.startToken !== "string") return null;
    return owner;
  } catch { return null; }
}
function stateLockConflict(channel) {
  return Object.assign(new Error(`state lock conflict for channel ${channel}`), { code: "ELOCKED" });
}
function acquireLock(root, channel) {
  const release = acquireStateWriteLock(stateFile(root, channel));
  try {
    // Legacy owner locks are migrated only under the new kernel writer lock.
    // Operators must stop old-version writers before the upgrade.
    const existingLocks = legacyStateWriterLockEntries(stateFile(root, channel));
    if (existingLocks.length > 0) {
      for (const lock of existingLocks) {
        const previous = readLockOwner(lock);
        if (!previous || processAlive(previous.pid, previous.startToken)) throw stateLockConflict(channel);
      }
      for (const lock of existingLocks) {
        try { fs.rmSync(lock, { recursive: true }); }
        catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
    }
    return release;
  } catch (error) { release(); throw error; }
}
function withTransaction(root, channel, mutator, options = {}) {
  const normalizedRoot = normalizeRoot(root); const normalizedChannel = ensureChannel(channel);
  fs.mkdirSync(normalizedRoot, { recursive: true, mode: 0o700 });
  const release = acquireLock(normalizedRoot, normalizedChannel);
  try {
    const state = readState(normalizedRoot, normalizedChannel, options);
    const before = canonicalJson(state);
    const compactedBefore = compactRuntimeHistory(state);
    const result = mutator(state);
    const cleanedAfter = cleanupFinishedWaits(state);
    const compactedAfter = compactRuntimeHistory(state);
    if (result?.__abortCommit && !compactedBefore && !cleanedAfter && !compactedAfter) return result.value;
    const changed = compactedBefore || cleanedAfter || compactedAfter || canonicalJson(state) !== before;
    if (!changed && options.commitUnchanged !== true) return result === undefined ? clone(state) : result;
    state.revision += 1; state.updatedAt = isoNow();
    atomicWriteJson(stateFile(normalizedRoot, normalizedChannel), state);
    return result?.__abortCommit ? result.value : result === undefined ? clone(state) : result;
  } finally { release(); }
}
function withRead(root, channel) { return readState(root, channel); }
function abortCommit(value) { return { __abortCommit: true, value }; }
function workerIdentity(state) { return { deviceId: state.instanceId, sessionId: "session-wait-worker" }; }
const RUNTIME_HISTORY_LIMIT = 256;
function compactRuntimeHistory(state) {
  // Control facts remain durable for idempotence. Only unreferenced observations
  // are a rolling audit window; references in waits/receipts/plans stay intact.
  const referenced = new Set();
  const visit = (value) => {
    if (typeof value === "string") { if (state.events[value]) referenced.add(value); }
    else if (Array.isArray(value)) value.forEach(visit);
    else if (isRecord(value)) Object.values(value).forEach(visit);
  };
  for (const [key, value] of Object.entries(state)) if (key !== "events" && key !== "eventOrder") visit(value);
  for (const event of Object.values(state.events)) if (event?.type !== "runtime_event") visit(event);
  let kept = 0; const removed = new Set();
  for (let i = state.eventOrder.length - 1; i >= 0; i -= 1) {
    const id = state.eventOrder[i];
    if (state.events[id]?.type !== "runtime_event" || referenced.has(id)) continue;
    if (kept++ >= RUNTIME_HISTORY_LIMIT) removed.add(id);
  }
  const ordered = new Set(state.eventOrder);
  for (const [id, event] of Object.entries(state.events)) {
    if (event?.type === "runtime_event" && !ordered.has(id) && !referenced.has(id)) removed.add(id);
  }
  if (!removed.size) return false;
  for (const id of removed) delete state.events[id];
  state.eventOrder = state.eventOrder.filter((id) => !removed.has(id));
  return true;
}
function waitHasOpenRemoteBinding(state, waitId) {
  return Object.entries(state.remoteBindings).some(([bindingId, binding]) => {
    if (binding.waitId !== waitId || binding.consumedAt) return false;
    const receipt = state.inbox[binding.messageId || bindingId];
    return !receipt || !["processed", "cancelled", "unknown"].includes(receipt.status);
  });
}
function waitHasUnsettledRecords(state, waitId) {
  if (Object.values(state.outbox).some((item) => item.waitId === waitId && !["processed", "cancelled"].includes(item.status))) return true;
  if (Object.values(state.inbox).some((receipt) => receipt.body?.waitId === waitId && !["processed", "cancelled", "unknown"].includes(receipt.status))) return true;
  return waitHasOpenRemoteBinding(state, waitId);
}
function waitHasLiveCancellationRecords(state, waitId) {
  if (Object.values(state.outbox).some((item) => item.waitId === waitId && ["pending", "in_flight", "accepted", "retrying", "queued"].includes(item.status))) return true;
  if (Object.values(state.inbox).some((receipt) => receipt.body?.waitId === waitId && ["accepted", "in_flight", "queued"].includes(receipt.status))) return true;
  return waitHasOpenRemoteBinding(state, waitId);
}
function cleanupFinishedWaits(state) {
  let changed = false;
  for (const [id, wait] of Object.entries(state.waits)) {
    if (!wait || !["completed", "cancelled"].includes(wait.status)) continue;
    if (wait.status === "completed" ? waitHasUnsettledRecords(state, id) : waitHasLiveCancellationRecords(state, id)) continue;
    state.terminalWaits[id] = { id, status: wait.status, updatedAt: wait.updatedAt || isoNow() };
    delete state.waits[id];
    for (const [bindingId, binding] of Object.entries(state.remoteBindings)) if (binding.waitId === id) delete state.remoteBindings[bindingId];
    changed = true;
  }
  return changed;
}
function pushHistory(state, item) {
  const id = item.id || randomId("transition-"); const record = { id, at: isoNow(), ...item };
  state.events[id] = record; state.eventOrder.push(id);
  return record;
}
function normalizeContinuation(value, fallbackTarget) {
  if (!isRecord(value)) return null;
  const target = value.target ? normalizeIdentity(value.target, "continuation.target") : normalizeIdentity(fallbackTarget, "continuation.target");
  const message = assertString(value.message || value.prompt, "continuation.message", 20_000);
  const scope = Array.isArray(value.authorizedScope) ? value.authorizedScope.map((item) => assertString(item, "continuation.authorizedScope", 160)).slice(0, 20) : ["resume_prior_work"];
  if (!scope.includes("resume_prior_work")) throw new Error("continuation requires resume_prior_work scope");
  return { operation: "resume_prior_work", target, message, authorizedScope: scope, ...(value.taskId ? { taskId: assertId(value.taskId, "continuation.taskId") } : {}) };
}
function outboxPayloadFromInput(input, messageId, recipient, target, authorizedScope) {
  return {
    kind: input.kind || "wake",
    ...(input.condition ? { condition: assertCondition(input.condition) } : {}),
    waitId: input.waitId ?? null,
    planId: input.planId ?? null,
    generation: input.generation ?? null,
    round: input.round ?? null,
    taskId: input.taskId ?? null,
    sender: input.sender || null,
    recipient,
    operation: input.operation || "resume_prior_authorized_work",
    authorizedScope,
    continuation: input.continuation || null,
    target,
    ...(input.owner ? { owner: input.owner } : {}),
    messageId,
    ...(input.resultEvent ? { resultEvent: clone(input.resultEvent) } : {}),
    ...(input.uiRequest ? { uiRequest: clone(input.uiRequest) } : {}),
  };
}
function makeOutbox(state, input) {
  const recipient = normalizeIdentity(input.recipient, "outbox.recipient");
  const target = normalizeIdentity(input.target || recipient, "outbox.target");
  const authorizedScope = Array.isArray(input.authorizedScope) ? input.authorizedScope.map((value) => assertString(value, "outbox.authorizedScope", 160)).slice(0, 20) : ["resume_prior_work"];
  const sender = input.sender ? normalizeIdentity(input.sender, "outbox.sender") : workerIdentity(state);
  const owner = input.owner ? normalizeIdentity(input.owner, "outbox.owner") : null;
  const messageId = input.messageId || randomId("wake-");
  const payload = outboxPayloadFromInput({ ...input, sender }, messageId, recipient, target, authorizedScope);
  const id = input.id || sha256(payload);
  if (state.outbox[id]) return state.outbox[id];
  const item = {
    id, ...(input.condition ? { condition: assertCondition(input.condition) } : {}), kind: assertString(input.kind || "wake", "outbox.kind", 80), status: "pending", createdAt: isoNow(), attempts: 0,
    waitId: input.waitId, planId: input.planId, generation: input.generation, round: input.round, taskId: input.taskId,
    sender, recipient, operation: input.operation || "resume_prior_authorized_work",
    authorizedScope, continuation: input.continuation || null, target, ...(owner ? { owner } : {}), messageId, nextAttemptAt: isoNow(),
    capability: { version: 1, digest: sha256(payload), payload: clone(payload) }, pullMessageId: null,
    ...(input.resultEvent ? { resultEvent: clone(input.resultEvent) } : {}),
    ...(input.uiRequest ? { uiRequest: clone(input.uiRequest) } : {}),
  };
  state.outbox[id] = item; return item;
}
function outboxCapabilityPayload(item) {
  if (!isRecord(item?.capability) || item.capability.version !== 1 || !isRecord(item.capability.payload) || typeof item.capability.digest !== "string") return null;
  const payload = item.capability.payload;
  if (sha256(payload) !== item.capability.digest) return null;
  if (payload.messageId !== item.messageId || payload.operation !== item.operation || payload.waitId !== (item.waitId ?? null) || payload.planId !== (item.planId ?? null) || payload.generation !== (item.generation ?? null) || payload.round !== (item.round ?? null) || payload.taskId !== (item.taskId ?? null)) return null;
  if (!sameIdentity(payload.sender, item.sender) || !sameIdentity(payload.recipient, item.recipient) || !sameIdentity(payload.target, item.target)) return null;
  if (item.owner && (!payload.owner || !sameIdentity(payload.owner, item.owner))) return null;
  if (item.condition && payload.condition !== item.condition) return null;
  if (canonicalJson(payload.authorizedScope || []) !== canonicalJson(item.authorizedScope || [])) return null;
  if (canonicalJson(payload.continuation || null) !== canonicalJson(item.continuation || null)) return null;
  if (item.resultEvent && canonicalJson(payload.resultEvent || null) !== canonicalJson(item.resultEvent)) return null;
  if (canonicalJson(payload.uiRequest || null) !== canonicalJson(item.uiRequest || null)) return null;
  return clone(payload);
}
function verifyOutboxCapability(item) {
  const payload = outboxCapabilityPayload(item);
  return payload ? { ok: true, digest: item.capability.digest, payload } : { ok: false, reason: "outbox_capability_mismatch" };
}
function validateNode(node, index) {
  if (!isRecord(node)) throw new Error(`plan.nodes[${index}] is required`);
  const id = assertId(node.id, `plan.nodes[${index}].id`); const session = normalizeIdentity(node.session || node.target, `plan.nodes[${index}].session`);
  const condition = assertCondition(node.condition || "acceptance_passed"); const dependsOn = Array.isArray(node.dependsOn) ? node.dependsOn.map((value) => assertId(value, "plan dependency")) : [];
  if (condition === "ui_request") throw new Error("ui_request is a local one-shot wait, not a plan condition");
  const taskId = node.taskId == null ? undefined : assertId(node.taskId, "plan node taskId");
  const continuation = normalizeContinuation(node.continuation, session);
  if (!continuation) throw new Error(`plan.nodes[${index}].continuation is required`);
  return { id, session, condition, dependsOn, taskId, continuation, acceptance: isRecord(node.acceptance) ? { criterion: assertString(node.acceptance.criterion, "node.acceptance.criterion", 400), digest: assertString(node.acceptance.digest, "node.acceptance.digest", 256) } : undefined, role: typeof node.role === "string" ? node.role.slice(0, 120) : id, scope: Array.isArray(node.scope) ? node.scope.map((v) => assertString(v, "node.scope", 160)).slice(0, 20) : continuation.authorizedScope, nextOnSuccess: node.nextOnSuccess == null ? undefined : assertId(node.nextOnSuccess, "nextOnSuccess"), nextOnFailure: node.nextOnFailure == null ? undefined : assertId(node.nextOnFailure, "nextOnFailure") };
}
function makeWaitInState(state, input) {
  const id = input.id ? assertId(input.id, "wait.id") : randomId("wait-"); if (state.waits[id] || state.terminalWaits[id]) throw new Error(`wait already exists: ${id}`);
  const owner = normalizeIdentity(input.owner, "wait.owner"); const target = normalizeIdentity(input.target || owner, "wait.target"); const condition = assertCondition(input.condition || "turn_settled");
  const continuation = input.continuation ? normalizeContinuation(input.continuation, owner) : null;
  let runtimeGeneration;
  if (condition === "ui_request") {
    if (input.planId || owner.deviceId !== state.instanceId || (target.deviceId !== state.instanceId && !resolveConfiguredPeerUrl(target.deviceId))) throw new Error("ui_request waits require a local owner and a local or trusted Reader target, without a plan");
    if (!target.sessionFile) throw new Error("ui_request wait target.sessionFile is required");
    if (input.taskId != null) throw new Error("ui_request waits bind runtimeGeneration, not taskId");
    runtimeGeneration = assertString(input.runtimeGeneration, "wait.runtimeGeneration", 256);
    if (!continuation || !Array.isArray(input.continuation.authorizedScope) || input.continuation.authorizedScope.length !== 1 || input.continuation.authorizedScope[0] !== "resume_prior_work") throw new Error("ui_request wait requires explicit resume_prior_work continuation authorization");
    if (!sameIdentity(continuation.target, owner) || (continuation.target.sessionFile && continuation.target.sessionFile !== owner.sessionFile)) throw new Error("ui_request continuation target must be the wait owner");
  }
  state.waits[id] = { ...(runtimeGeneration ? { runtimeGeneration } : {}), id, status: "waiting", createdAt: isoNow(), updatedAt: isoNow(), owner, target, condition, planId: input.planId, taskId: input.taskId, generation: input.generation || 1, round: input.round || 1, continuation, authorizedScope: continuation?.authorizedScope || input.authorizedScope || ["resume_prior_work"], progress: "", lastEventId: null, eventCursor: 0, reason: null, nextAction: "wait_for_result" };
  return id;
}
function createWait(root, channel, input) { return withTransaction(root, channel, (state) => { const waitId = makeWaitInState(state, input); const wait = state.waits[waitId]; const observeDispatch = input.dispatchObserve === true || input.operation === "observe_wait" || (Array.isArray(input.authorizedScope) && input.authorizedScope.includes("observe_wait")); const remoteObservation = observeDispatch && wait.target.deviceId !== wait.owner.deviceId; pushHistory(state, { type: "wait_created", waitId, condition: wait.condition, generation: wait.generation, round: wait.round, observation: true, observeDispatch: remoteObservation }); if (remoteObservation) { makeOutbox(state, { kind: "observe_wait", condition: wait.condition, waitId: wait.id, generation: wait.generation, round: wait.round, taskId: wait.taskId, recipient: wait.target, target: wait.target, owner: wait.owner, operation: "observe_wait", authorizedScope: ["observe_wait"], continuation: null }); wait.observationStatus = "pending"; wait.nextAction = "register_observation"; } return clone(wait); }); }
function createPlan(root, channel, input) {
  const planId = input.id ? assertId(input.id, "plan.id") : randomId("plan-"); const owner = normalizeIdentity(input.owner, "plan.owner");
  if (!Array.isArray(input.nodes) || input.nodes.length < 1 || input.nodes.length > 100) throw new Error("plan.nodes must contain 1..100 nodes");
  const nodes = input.nodes.map(validateNode); const ids = new Set(nodes.map((node) => node.id)); if (ids.size !== nodes.length) throw new Error("plan node ids must be unique");
  for (const node of nodes) { for (const dependency of node.dependsOn) if (!ids.has(dependency)) throw new Error(`unknown dependency ${dependency}`); for (const next of [node.nextOnSuccess, node.nextOnFailure]) if (next && !ids.has(next)) throw new Error(`unknown next node ${next}`); }
  const firstNodeId = assertId(input.firstNodeId || nodes[0].id, "firstNodeId"); if (!ids.has(firstNodeId)) throw new Error("firstNodeId is not in plan.nodes");
  const maxRounds = Number.isInteger(input.maxRounds) ? Math.max(1, Math.min(100, input.maxRounds)) : 2;
  const budget = { maxRounds, maxWakeups: Number.isInteger(input.maxWakeups) ? Math.max(1, Math.min(10_000, input.maxWakeups)) : 100, maxNoProgress: Number.isInteger(input.maxNoProgress) ? Math.max(1, Math.min(100, input.maxNoProgress)) : 3, wakeups: 0, noProgress: 0 };
  return withTransaction(root, channel, (state) => {
    if (state.plans[planId]) throw new Error(`plan already exists: ${planId}`); const node = nodes.find((candidate) => candidate.id === firstNodeId);
    if (node.dependsOn.length) throw new Error("first plan node cannot have unresolved dependencies");
    const plan = { id: planId, owner, status: "waiting", createdAt: isoNow(), updatedAt: isoNow(), generation: 1, round: 1, currentNodeId: firstNodeId, firstNodeId, nodes, nodeResults: {}, history: [], budget, handoffStatus: "pending", stopCondition: isRecord(input.stopCondition) ? clone(input.stopCondition) : { finalNodeId: nodes[nodes.length - 1].id, maxRounds }, authorization: Array.isArray(input.authorization) ? input.authorization.map((v) => assertString(v, "plan.authorization", 200)).slice(0, 40) : ["resume_prior_work"], progress: typeof input.progress === "string" ? input.progress.slice(0, 1000) : "", error: null, nextAction: "wait_for_result" };
    state.plans[planId] = plan;
    const waitId = makeWaitInState(state, { planId, owner, target: node.session, condition: node.condition, generation: 1, round: 1, taskId: node.taskId, continuation: node.continuation });
    plan.waitId = waitId; plan.history.push({ at: isoNow(), type: "created", nodeId: firstNodeId, generation: 1, round: 1, waitId });
    makeOutbox(state, { condition: node.condition, planId, waitId, generation: 1, round: 1, taskId: node.taskId, recipient: node.session, owner: plan.owner, continuation: node.continuation, authorizedScope: node.scope });
    pushHistory(state, { type: "plan_created", planId, waitId, generation: 1, round: 1 }); return { plan: clone(plan), wait: clone(state.waits[waitId]) };
  });
}
function eventCondition(type) { if (type === "ui_request") return "ui_request"; if (type === "turn_settled") return "turn_settled"; if (type === "task_completed") return "task_completed"; if (type === "acceptance_passed") return "acceptance_passed"; return null; }
class ResultValidationError extends Error {}
function validateStructuredResult(event) { const result = isRecord(event.result) ? event.result : {}; const evidenceSource = event.evidenceSource || result.evidenceSource || "unspecified"; if (!["unspecified", "self_report", "check_program", "independent_review", "user_confirmation"].includes(evidenceSource)) throw new ResultValidationError("unsupported evidence source"); const success = event.success === true || result.success === true; if ((event.type === "task_completed" || event.type === "acceptance_passed") && !success) throw new ResultValidationError(`${event.type} requires success=true`); if ((event.type === "task_completed" || event.externalTask) && typeof (event.resultLocation || result.resultLocation) !== "string") throw new ResultValidationError("completed task requires a resultLocation"); const acceptance = event.acceptance || result.acceptance; if (event.type === "acceptance_passed" && (!isRecord(acceptance) || typeof acceptance.criterion !== "string" || typeof acceptance.digest !== "string")) throw new ResultValidationError("acceptance_passed requires a criterion and digest receipt"); return { ...result, ...(event.type === "ui_request" ? { runtimeGeneration: event.runtimeGeneration, requestId: event.requestId, method: event.method } : {}), ...(event.resultLocation ? { resultLocation: event.resultLocation } : {}), ...(event.summary ? { summary: shortText(event.summary, 2000) } : {}), ...(acceptance ? { acceptance: clone(acceptance) } : {}), evidenceSource, evidenceSourceAuthority: "declared", success }; }
function validatePlanResult(event, plan) {
  const result = validateStructuredResult(event);
  const acceptance = plan && planNode(plan)?.acceptance;
  if (event.type === "acceptance_passed" && acceptance
    && (result.acceptance?.criterion !== acceptance.criterion || result.acceptance?.digest !== acceptance.digest)) {
    throw new ResultValidationError("acceptance receipt does not match the pre-approved plan node");
  }
  return result;
}
function eventIdentity(event) { return normalizeIdentity(event.identity || { deviceId: event.deviceId, sessionId: event.sessionId, sessionFile: event.sessionFile }, "event.identity"); }
function matchingWait(wait, event) { if (!wait || !["waiting", "running", "retrying"].includes(wait.status)) return false; const identity = eventIdentity(event); if (!sameIdentity(identity, wait.target)) return false; if (wait.target.sessionFile && identity.sessionFile !== wait.target.sessionFile) return false; if (wait.condition === "ui_request") return event.type === "ui_request" && event.runtimeGeneration === wait.runtimeGeneration; if (wait.taskId && event.taskId !== wait.taskId) return false; if (wait.planId) { if (wait.taskId && event.taskId !== wait.taskId || event.generation !== wait.generation || event.round !== wait.round) return false; } else { if (event.generation !== undefined && event.generation !== wait.generation) return false; if (event.round !== undefined && event.round !== wait.round) return false; } return event.type === "progress" || event.type === "task_failed" || eventCondition(event.type) === wait.condition; }
function planNode(plan) { return plan.nodes.find((node) => node.id === plan.currentNodeId); }
function markWait(wait, status, reason, event) { wait.status = status; wait.updatedAt = isoNow(); wait.reason = reason || null; wait.lastEventId = event?.id || wait.lastEventId; wait.eventCursor += 1; wait.nextAction = status === "completed" || status === "cancelled" ? "none" : "inspect_or_resume"; }
function advancePlan(state, plan, event, result) {
  const node = planNode(plan); if (!node) { plan.status = "blocked"; plan.error = "current node is missing"; return { kind: "blocked" }; }
  plan.nodeResults[node.id] = { ...result, eventId: event.id, generation: plan.generation, round: plan.round, completedAt: isoNow() };
  const explicitNext = node.nextOnSuccess; const finalNodeId = plan.stopCondition?.finalNodeId || plan.nodes.at(-1).id;
  if (node.id === finalNodeId && plan.round >= plan.budget.maxRounds) { plan.status = "completed"; plan.handoffStatus = "accepted"; plan.nextAction = "none"; plan.history.push({ at: isoNow(), type: "completed", nodeId: node.id, generation: plan.generation, round: plan.round }); return { kind: "completed" }; }
  let nextId = explicitNext; if (!nextId) { const index = plan.nodes.findIndex((candidate) => candidate.id === node.id); nextId = plan.nodes[index + 1]?.id || (plan.round < plan.budget.maxRounds ? plan.firstNodeId : undefined); }
  if (!nextId) { plan.status = "completed"; plan.nextAction = "none"; return { kind: "completed" }; }
  if (nextId === plan.firstNodeId || (node.id === plan.nodes.at(-1)?.id && !explicitNext)) { if (plan.round >= plan.budget.maxRounds) { plan.status = "completed"; plan.nextAction = "none"; return { kind: "completed" }; } plan.round += 1; plan.generation += 1; }
  const next = plan.nodes.find((candidate) => candidate.id === nextId); if (!next) { plan.status = "blocked"; plan.error = `next node missing: ${nextId}`; return { kind: "blocked" }; }
  if (next.dependsOn.some((dependency) => { const result = plan.nodeResults[dependency]; return !result || result.success !== true || result.generation !== plan.generation || result.round !== plan.round; })) { plan.status = "blocked"; plan.error = `dependencies not satisfied for ${next.id}`; plan.nextAction = "dependency_review_required"; return { kind: "blocked" }; }
  plan.currentNodeId = next.id; plan.status = "waiting"; plan.handoffStatus = "pending"; plan.nextAction = "wait_for_result"; plan.budget.wakeups += 1; plan.progress = "";
  if (plan.budget.wakeups > plan.budget.maxWakeups) { plan.status = "paused"; plan.error = "wake-up budget exhausted"; plan.nextAction = "user_review_required"; return { kind: "paused" }; }
  const nextWaitId = makeWaitInState(state, { planId: plan.id, owner: plan.owner, target: next.session, condition: next.condition, generation: plan.generation, round: plan.round, taskId: next.taskId, continuation: next.continuation }); plan.waitId = nextWaitId;
  plan.history.push({ at: isoNow(), type: "advanced", from: node.id, to: next.id, generation: plan.generation, round: plan.round, waitId: nextWaitId });
  makeOutbox(state, { condition: next.condition, planId: plan.id, waitId: nextWaitId, generation: plan.generation, round: plan.round, taskId: next.taskId, recipient: next.session, owner: plan.owner, continuation: next.continuation, authorizedScope: next.scope }); return { kind: "advanced", waitId: nextWaitId, next: next.id };
}
function remoteBindingForEvent(state, event, identity) {
  if (event.type === "ui_request") return undefined;
  return Object.values(state.remoteBindings || {}).find((binding) =>
    !binding.consumedAt && binding.waitId === event.waitId
    && (!binding.planId || binding.planId === event.planId)
    && sameIdentity(binding.target, identity)
    && (!binding.taskId || binding.taskId === event.taskId)
    && (binding.generation === undefined || event.generation === undefined || binding.generation === event.generation)
    && (binding.round === undefined || event.round === undefined || binding.round === event.round)
  );
}
function resultEventForOutbox(event, identity, binding) {
  return {
    ...clone(event),
    identity: clone(identity),
    ...(binding?.waitId && !event.waitId ? { waitId: binding.waitId } : {}),
    ...(binding?.planId && !event.planId ? { planId: binding.planId } : {}),
    ...(binding?.taskId && !event.taskId ? { taskId: binding.taskId } : {}),
    ...(binding?.generation !== undefined && event.generation === undefined ? { generation: binding.generation } : {}),
    ...(binding?.round !== undefined && event.round === undefined ? { round: binding.round } : {}),
    ...(event.result && isRecord(event.result) ? { result: clone(event.result) } : {}),
  };
}
function validateUiRequestEvent(event, instanceId) {
  if (event.type !== "ui_request") return;
  const identity = eventIdentity(event);
  if (event.source !== "rpc-manager" || (instanceId && identity.deviceId !== instanceId && !resolveConfiguredPeerUrl(identity.deviceId)) || event.planId) throw new Error("ui_request events require a local or trusted Reader runtime source");
  assertString(identity.sessionFile, "ui_request identity.sessionFile", 2000);
  assertString(event.runtimeGeneration, "ui_request runtimeGeneration", 256);
  assertString(event.requestId, "ui_request requestId", 512);
  assertString(event.method, "ui_request method", 160);
}
function makeOwnerContinuation(state, wait, event) {
  if (!wait.continuation) return;
  const uiRequest = event.type === "ui_request" ? { identity: eventIdentity(event), runtimeGeneration: event.runtimeGeneration, requestId: event.requestId, method: event.method, summary: shortText(event.summary || "UI request", 2000) } : null;
  makeOutbox(state, { waitId: wait.id, taskId: wait.taskId, recipient: wait.owner, target: wait.owner, continuation: { ...wait.continuation, target: wait.owner }, authorizedScope: wait.continuation.authorizedScope, ...(uiRequest ? { condition: "ui_request", uiRequest } : {}) });
}
function applyEventInState(state, event) {
    validateUiRequestEvent(event, state.instanceId);
    const id = event.id ? assertId(event.id, "event.id") : sha256({ type: event.type, waitId: event.waitId, planId: event.planId, identity: event.identity || { deviceId: event.deviceId, sessionId: event.sessionId }, generation: event.generation, round: event.round, taskId: event.taskId, ...(event.type === "ui_request" ? { runtimeGeneration: event.runtimeGeneration, requestId: event.requestId } : {}), result: event.result, createdAt: event.createdAt || "" });
    if (state.events[id]) return { duplicate: true, event: clone(state.events[id]), state: projectState(state) };
    if (!EVENT_TYPES.has(event.type)) throw new Error(`unsupported event type: ${event.type}`);
    if (!event.identity && (!event.deviceId || !event.sessionId)) throw new Error("event identity is required");
    const identity = eventIdentity(event);
    if (event.type === "ui_request" && Array.isArray(event.supersededWaitIds) && event.supersededWaitIds.length) {
      invalidateUiRequestWaitsInState(state, { identity, runtimeGeneration: event.runtimeGeneration, reason: "runtime_replaced", waitIds: event.supersededWaitIds });
    }
    const record = {
      id, type: event.type, createdAt: event.createdAt || isoNow(), identity,
      waitId: event.waitId, planId: event.planId, generation: event.generation, round: event.round,
      taskId: event.taskId, result: isRecord(event.result) ? clone(event.result) : undefined,
      success: event.success, resultLocation: event.resultLocation,
      acceptance: event.acceptance ? clone(event.acceptance) : undefined,
      reason: event.reason, progress: event.progress, externalTask: event.externalTask,
      evidenceSource: event.evidenceSource,
      ...(event.type === "ui_request" ? { runtimeGeneration: event.runtimeGeneration, requestId: event.requestId, method: event.method, source: event.source, ...(event.supersededWaitIds?.length ? { supersededWaitIds: clone(event.supersededWaitIds) } : {}) } : {}),
      summary: event.summary ? shortText(event.summary, 2000) : undefined,
    };
    state.events[id] = record; state.eventOrder.push(id);
    if (event.type === "handoff_accepted") {
      const plan = event.planId ? state.plans[event.planId] : undefined;
      if (!plan || event.generation !== plan.generation || event.round !== plan.round) { record.outcome = "ignored_stale_or_identity_mismatch"; return { accepted: false, ignored: true, reason: "stale_handoff", event: clone(record), state: projectState(state) }; }
      const node = planNode(plan);
      if (!node || !sameIdentity(identity, node.session)) { record.outcome = "ignored_identity_mismatch"; return { accepted: false, ignored: true, reason: "handoff_identity_mismatch", event: clone(record), state: projectState(state) }; }
      plan.handoffStatus = "accepted"; plan.history.push({ at: isoNow(), type: "handoff_accepted", nodeId: node.id, generation: plan.generation, round: plan.round }); record.outcome = "handoff_accepted";
      const pendingApplied = applyPendingEvents(state, { planId: plan.id, waitId: plan.waitId, generation: plan.generation, round: plan.round });
      return { accepted: true, event: clone(record), pendingApplied, state: projectState(state) };
    }
    let wait = event.waitId ? state.waits[event.waitId] : undefined;
    if (!wait && event.waitId && state.terminalWaits[event.waitId]) {
      record.outcome = "ignored_terminal_wait";
      return { accepted: false, ignored: true, reason: `wait_${state.terminalWaits[event.waitId].status}`, event: clone(record), state: projectState(state) };
    }
    let plan = event.planId ? state.plans[event.planId] : undefined;
    const remoteBinding = !wait && event.waitId ? remoteBindingForEvent(state, event, identity) : undefined;
    if (event.planId && (!event.waitId || !wait || wait.planId !== event.planId) && !remoteBinding) { record.outcome = "ignored_plan_binding"; return { accepted: false, ignored: true, reason: "plan_wait_mismatch", event: clone(record), state: projectState(state) }; }
    if (wait?.planId) {
      if (event.planId && event.planId !== wait.planId) { record.outcome = "ignored_plan_binding"; return { accepted: false, ignored: true, reason: "wait_plan_mismatch", event: clone(record), state: projectState(state) }; }
      plan = state.plans[wait.planId];
      if (!plan || plan.waitId !== wait.id) { record.outcome = "ignored_plan_binding"; return { accepted: false, ignored: true, reason: "wait_is_not_current_plan_wait", event: clone(record), state: projectState(state) }; }
      if (!event.waitId || event.generation === undefined || event.round === undefined || (wait.taskId && event.taskId === undefined)) { record.outcome = "ignored_plan_binding"; return { accepted: false, ignored: true, reason: "plan_event_missing_binding", event: clone(record), state: projectState(state) }; }
    }
    if (!wait && !event.waitId && !event.planId && ["turn_settled", "task_failed"].includes(event.type)) {
      // Native lifecycle events carry execution identity, not the remote owner's
      // wait ID. Fan out through registered bindings in this same transaction.
      const bindings = Object.values(state.remoteBindings || {}).filter((binding) =>
        !binding.consumedAt
        && (event.type === "task_failed" || binding.condition === event.type)
        && sameIdentity(binding.target, identity)
        && (!binding.target.sessionFile || binding.target.sessionFile === identity.sessionFile)
        && (!binding.taskId || binding.taskId === event.taskId)
        && (event.generation === undefined || binding.generation === undefined || event.generation === binding.generation)
        && (event.round === undefined || binding.round === undefined || event.round === binding.round));
      for (const binding of bindings) {
        applyEventInState(state, { ...resultEventForOutbox(event, identity, binding), id: sha256({ eventId: id, bindingId: binding.id }) });
      }
      if (bindings.length) record.remoteBindingIds = bindings.map((binding) => binding.id);
    }
    if (!wait && !event.waitId && !event.planId) {
      const matches = Object.values(state.waits).filter((candidate) => !candidate.planId && matchingWait(candidate, event));
      if (matches.length > 0) {
        record.matchedWaitIds = matches.map((match) => match.id);
        if (event.type === "progress") {
          const progress = shortText(event.progress || event.summary || "", 1000);
          for (const match of matches) { if (progress) match.progress = progress; match.updatedAt = isoNow(); match.lastEventId = event.id || match.lastEventId; match.eventCursor += 1; }
          record.outcome = "progress_recorded";
          return { accepted: true, event: clone(record), state: projectState(state) };
        }
        if (event.type === "task_failed") {
          for (const match of matches) markWait(match, "failed", shortText(event.reason || event.summary || "task failed", 1000), event);
        } else {
          const result = validateStructuredResult(event);
          for (const match of matches) {
            markWait(match, "completed", null, event);
            makeOwnerContinuation(state, match, event);
            match.lastResult = clone(result);
          }
        }
        record.outcome = event.type === "task_failed" ? "fanout_failed" : "fanout_completed";
        return { accepted: true, event: clone(record), state: projectState(state) };
      }
    }
    if (wait && !matchingWait(wait, event)) { record.outcome = "ignored_stale_or_identity_mismatch"; return { accepted: false, ignored: true, reason: "stale_generation_round_or_identity_or_condition", event: clone(record), state: projectState(state) }; }
    if (plan && !["waiting", "running"].includes(plan.status) && ["turn_settled", "task_completed", "acceptance_passed", "task_failed"].includes(event.type)) {
      record.outcome = "ignored_plan_gate"; return { accepted: false, ignored: true, reason: `plan_${plan.status}`, event: clone(record), state: projectState(state) };
    }
    // Admission and replay use the same domain check, before pending storage or
    // handoff advancement. Only explicit result rejection is recoverable here.
    let validatedResult;
    if (plan && wait && event.type !== "progress" && event.type !== "task_failed") {
      try { validatedResult = validatePlanResult(event, plan); }
      catch (error) {
        if (!(error instanceof ResultValidationError)) throw error;
        record.outcome = "rejected_invalid_result"; record.reason = error.message;
        return { accepted: false, rejected: true, reason: record.reason, event: clone(record), state: projectState(state) };
      }
    }
    if (plan && plan.handoffStatus !== "accepted" && event.type !== "progress" && event.type !== "task_failed") {
      state.events[id] = undefined; delete state.events[id]; const index = state.eventOrder.indexOf(id); if (index >= 0) state.eventOrder.splice(index, 1);
      record.outcome = "pending_handoff"; state.pendingEvents[id] = record; return { accepted: false, pending: true, ignored: false, reason: "handoff_not_accepted", event: clone(record), state: projectState(state) };
    }
    if (event.type === "progress") {
      if (plan && ["paused", "cancelled", "failed", "blocked", "completed"].includes(plan.status)) { record.outcome = "progress_observed_while_blocked"; return { accepted: true, event: clone(record), state: projectState(state) }; }
      if (plan && event.generation === plan.generation && event.round === plan.round) {
        const progress = shortText(event.progress || event.summary || "", 1000);
        if (progress && progress !== plan.progress) { plan.progress = progress; plan.budget.noProgress = 0; }
        else plan.budget.noProgress += 1;
        if (plan.budget.noProgress >= plan.budget.maxNoProgress) { plan.status = "paused"; plan.error = "no progress threshold reached"; plan.nextAction = "user_review_required"; }
      }
      record.outcome = "progress_recorded"; return { accepted: true, event: clone(record), state: projectState(state) };
    }
    if (!wait && event.waitId) {
      const binding = remoteBinding || remoteBindingForEvent(state, event, identity);
      if (binding) {
        const peer = state.peers?.[binding.owner.deviceId];
        if (binding.owner.deviceId !== state.instanceId && (!peer || peer.revokedAt || (Array.isArray(peer.sessions) && !peer.sessions.includes(binding.owner.sessionId)))) {
          record.outcome = "ignored_owner_peer_not_authorized";
          return { accepted: false, ignored: true, reason: "owner_peer_not_authorized", event: clone(record), state: projectState(state) };
        }
        const result = validateStructuredResult(event);
        const outbox = makeOutbox(state, {
          kind: "result", waitId: event.waitId, planId: event.planId || binding.planId, taskId: event.taskId || binding.taskId,
          generation: event.generation ?? binding.generation, round: event.round ?? binding.round,
          sender: identity, recipient: binding.owner, target: identity, operation: "report_result",
          authorizedScope: ["report_result"], resultEvent: resultEventForOutbox(event, identity, binding),
        });
        if (event.type === "task_failed" || binding.condition === event.type) {
          binding.consumedAt = isoNow(); binding.consumedEventId = id; binding.resultOutboxId = outbox.id;
        }
        record.outcome = "queued_for_owner"; record.outboxId = outbox.id; record.result = clone(result);
        return { accepted: true, event: clone(record), outbox: clone(outbox), state: projectState(state) };
      }
    }
    if (!wait) { record.outcome = "recorded_without_wait"; return { accepted: true, event: clone(record), state: projectState(state) }; }
    if (event.type === "task_failed") {
      markWait(wait, "failed", shortText(event.reason || event.summary || "task failed", 1000), event);
      if (plan) {
        plan.status = "failed"; plan.error = wait.reason; plan.nextAction = "failure_branch_or_user_review";
        const node = planNode(plan);
        if (node?.nextOnFailure) {
          const next = plan.nodes.find((candidate) => candidate.id === node.nextOnFailure);
          if (next) {
            if (next.dependsOn.some((dependency) => { const result = plan.nodeResults[dependency]; return !result || result.success !== true || result.generation !== plan.generation || result.round !== plan.round; })) plan.status = "blocked";
            else {
              plan.budget.wakeups += 1;
              if (plan.budget.wakeups > plan.budget.maxWakeups) { plan.status = "paused"; plan.error = "wake-up budget exhausted"; plan.nextAction = "user_review_required"; }
              else {
                plan.generation += 1; plan.currentNodeId = next.id; plan.status = "waiting"; plan.handoffStatus = "pending";
                const nextWaitId = makeWaitInState(state, { planId: plan.id, owner: plan.owner, target: next.session, condition: next.condition, generation: plan.generation, round: plan.round, taskId: next.taskId, continuation: next.continuation });
                plan.waitId = nextWaitId; makeOutbox(state, { condition: next.condition, planId: plan.id, waitId: nextWaitId, generation: plan.generation, round: plan.round, taskId: next.taskId, recipient: next.session, target: next.session, owner: plan.owner, continuation: next.continuation, authorizedScope: next.scope });
              }
            }
          }
        }
      }
      record.outcome = "failed"; return { accepted: true, event: clone(record), state: projectState(state) };
    }
    const result = validatedResult || validateStructuredResult(event);
    markWait(wait, "completed", null, event); wait.lastResult = clone(result);
    if (plan) {
      plan.status = "running"; const advancement = advancePlan(state, plan, event, result); if (advancement.kind === "completed") plan.status = "completed"; record.outcome = advancement.kind; record.advancement = advancement;
    } else {
      record.outcome = "completed";
      makeOwnerContinuation(state, wait, event);
    }
    return { accepted: true, event: clone(record), state: projectState(state) };
}
function applyEvent(root, channel, event) {
  return withTransaction(root, channel, (state) => applyEventInState(state, event));
}
function applyPendingEvents(state, item) {
  const results = [];
  for (const [id, event] of Object.entries(state.pendingEvents || {})) {
    if (event.planId !== item.planId || event.waitId !== item.waitId
      || event.generation !== item.generation || event.round !== item.round) continue;
    // Legacy pending events pass through the same domain validation as new
    // events; a rejection is committed without swallowing operational errors.
    const result = applyEventInState(state, event);
    if (!result.pending) delete state.pendingEvents[id];
    results.push(result);
  }
  return results;
}
function transitionWait(root, channel, waitId, action, reason, actor) { return withTransaction(root, channel, (state) => { const wait = state.waits[assertId(waitId, "waitId")]; if (!wait) throw new Error("wait not found"); if (actor && !sameIdentity(wait.owner, actor)) throw new Error("wait owner mismatch"); if (action === "cancel") { wait.status = "cancelled"; wait.reason = reason || "cancelled by user"; wait.nextAction = "none"; for (const item of Object.values(state.outbox)) if (item.waitId === wait.id && ["pending", "retrying", "queued"].includes(item.status)) { item.status = "cancelled"; item.cancelledAt = isoNow(); } for (const receipt of Object.values(state.inbox)) if (receipt.body?.waitId === wait.id && ["accepted", "queued"].includes(receipt.status)) { receipt.status = "cancelled"; receipt.processedAt = isoNow(); receipt.reason = "wait cancelled before recipient processing"; } } else if (action === "pause") { if (!TERMINAL_STATUSES.has(wait.status)) { wait.status = "paused"; wait.reason = reason || "paused by user"; wait.nextAction = "resume_or_cancel"; } } else if (action === "resume") { if (["paused", "blocked", "failed"].includes(wait.status)) { wait.status = "waiting"; wait.reason = null; wait.nextAction = "wait_for_result"; } } else throw new Error(`unsupported wait transition: ${action}`); wait.updatedAt = isoNow(); if (wait.planId) { const plan = state.plans[wait.planId]; if (plan) { plan.status = action === "cancel" ? "cancelled" : action === "pause" ? "paused" : "waiting"; plan.nextAction = action === "cancel" ? "none" : action === "pause" ? "resume_or_cancel" : "wait_for_result"; plan.updatedAt = isoNow(); } } pushHistory(state, { type: `wait_${action}`, waitId, planId: wait.planId, reason: wait.reason }); return clone(wait); }); }
function invalidateUiRequestWaitsInState(state, input) {
  const identity = normalizeIdentity(input.identity, "ui_request.identity");
  const runtimeGeneration = assertString(input.runtimeGeneration, "ui_request.runtimeGeneration", 256);
  if (!["runtime_closed", "runtime_replaced"].includes(input.reason)) throw new Error("unsupported UI wait invalidation reason");
  if ((identity.deviceId !== state.instanceId && !resolveConfiguredPeerUrl(identity.deviceId)) || !identity.sessionFile) throw new Error("UI wait invalidation requires the exact local or trusted runtime identity");
  const cancelledWaitIds = []; const cancelledOutboxIds = [];
  for (const wait of Object.values(state.waits)) {
    if ((input.waitIds && !input.waitIds.includes(wait.id)) || wait.condition !== "ui_request" || !sameIdentity(wait.target, identity) || wait.target.sessionFile !== identity.sessionFile
      || (input.reason === "runtime_closed" ? wait.runtimeGeneration !== runtimeGeneration : wait.runtimeGeneration === runtimeGeneration)) continue;
    if (!TERMINAL_STATUSES.has(wait.status)) {
      markWait(wait, "cancelled", input.reason); wait.nextAction = "renew_ui_wait"; cancelledWaitIds.push(wait.id);
    }
    for (const item of Object.values(state.outbox)) if (item.waitId === wait.id && ["pending", "retrying", "queued"].includes(item.status)) {
      item.status = "cancelled"; item.cancelledAt = isoNow(); item.error = input.reason; item.nextAttemptAt = null; cancelledOutboxIds.push(item.id);
    }
  }
  if (cancelledWaitIds.length || cancelledOutboxIds.length) pushHistory(state, { type: "ui_waits_invalidated", identity, runtimeGeneration, reason: input.reason, cancelledWaitIds, cancelledOutboxIds });
  return { cancelledWaitIds, cancelledOutboxIds };
}
function invalidateUiRequestWaits(root, channel, input) {
  return withTransaction(root, channel, state => invalidateUiRequestWaitsInState(state, input));
}
function getStatus(root, channel, filter = {}) { const state = withRead(root, channel); return { runtimeInboxWarnings: clone(state.runtimeInboxWarnings || []), bindingWarnings: projectState(state).bindingWarnings, schema: state.schema, channel: state.channel, revision: state.revision, updatedAt: state.updatedAt, waits: clone(Object.values(state.waits).filter((wait) => !filter.waitId || wait.id === filter.waitId)), plans: clone(Object.values(state.plans).filter((plan) => !filter.planId || plan.id === filter.planId)), outbox: clone(Object.values(state.outbox).filter((item) => item.status !== "processed")), notifications: clone(Object.values(state.notifications).filter((notification) => !notification.acknowledged)), worker: { stateRoot: normalizeRoot(root), channel: state.channel } }; }
function projectState(state) { return { runtimeInboxWarnings: clone(state.runtimeInboxWarnings || []), bindingWarnings: Object.values(state.remoteBindings || {}).filter(binding => !binding.condition && !binding.consumedAt).map(binding => ({ bindingId: binding.id, waitId: binding.waitId, reason: "condition_required", nextAction: "reregister_observation_with_explicit_condition" })), schema: state.schema, channel: state.channel, revision: state.revision, updatedAt: state.updatedAt, waits: Object.values(state.waits).map(clone), plans: Object.values(state.plans).map(clone), outbox: Object.values(state.outbox).map(clone) }; }
function peerPinAllowsOutbox(state, item) {
  if (item.recipient?.deviceId === state.instanceId) return { allowed: true };
  const pin = state.peers?.[item.recipient?.deviceId];
  if (!pin || pin.revokedAt) return { allowed: false, reason: "peer_not_paired", terminal: true };
  if (Array.isArray(pin.sessions) && pin.sessions.length > 0 && !pin.sessions.includes(item.recipient.sessionId)) return { allowed: false, reason: "peer_session_not_paired", terminal: true };
  const transportOperation = item.operation === "report_result" ? "report_result" : item.operation === "observe_wait" ? "observe_wait" : "wake";
  if (Array.isArray(pin.operations) && pin.operations.length > 0 && !pin.operations.includes(transportOperation)) return { allowed: false, reason: "peer_operation_not_paired", terminal: true };
  if (Array.isArray(pin.scopes) && pin.scopes.length > 0 && (item.authorizedScope || []).some((scope) => !pin.scopes.includes(scope))) return { allowed: false, reason: "peer_scope_not_paired", terminal: true };
  return { allowed: true };
}
function outboxAuthorityForState(state, item) {
  if (!outboxCapabilityPayload(item)) return { allowed: false, reason: "outbox_capability_mismatch", terminal: true };
  const peer = peerPinAllowsOutbox(state, item); if (!peer.allowed) return peer;
  if (item.waitId) {
    const wait = state.waits[item.waitId];
    const terminalWait = state.terminalWaits[item.waitId];
    if (terminalWait) return { allowed: false, reason: `wait_${terminalWait.status}`, terminal: true };
    if (wait?.status === "cancelled" || wait?.status === "failed" || wait?.status === "blocked") return { allowed: false, reason: `wait_${wait.status}`, terminal: true };
    if (wait?.status === "paused") return { allowed: false, reason: "wait_paused", defer: true };
    if (wait && item.generation !== undefined && item.generation !== wait.generation) return { allowed: false, reason: "wait_generation_mismatch", terminal: true };
    if (wait && item.round !== undefined && item.round !== wait.round) return { allowed: false, reason: "wait_round_mismatch", terminal: true };
  }
  if (item.planId) {
    const plan = state.plans[item.planId];
    if (plan?.status === "cancelled" || plan?.status === "failed" || plan?.status === "blocked" || plan?.status === "completed") return { allowed: false, reason: `plan_${plan.status}`, terminal: true };
    if (plan?.status === "paused") return { allowed: false, reason: "plan_paused", defer: true };
    if (plan && plan.waitId !== item.waitId) return { allowed: false, reason: "plan_wait_mismatch", terminal: true };
    if (plan && item.generation !== undefined && item.generation !== plan.generation) return { allowed: false, reason: "plan_generation_mismatch", terminal: true };
    if (plan && item.round !== undefined && item.round !== plan.round) return { allowed: false, reason: "plan_round_mismatch", terminal: true };
  }
  return { allowed: true, item: clone(item), capability: outboxCapabilityPayload(item) };
}
function deliveryDecisionForState(state, item) {
  if (!item) return { allowed: false, reason: "outbox_not_found" };
  if (!OUTBOX_STATUSES.has(item.status) || !["pending", "retrying", "queued"].includes(item.status)) return { allowed: false, reason: `outbox_status_${item.status}` };
  return outboxAuthorityForState(state, item);
}
function claimedOutboxDeliveryDecision(root, channel, id, claimId) {
  const state = withRead(root, channel); const item = state.outbox[assertString(id, "outboxId")];
  if (!item || item.status !== "in_flight" || item.claim?.id !== claimId) return { allowed: false, reason: "outbox_claim_stale", terminal: true };
  if (item.claim.messageId !== item.messageId || item.claim.capabilityDigest !== item.capability?.digest) return { allowed: false, reason: "outbox_claim_mismatch", terminal: true };
  return outboxAuthorityForState(state, item);
}
function outboxDeliveryDecision(root, channel, id) {
  const state = withRead(root, channel); return deliveryDecisionForState(state, state.outbox[assertString(id, "outboxId")]);
}
function claimOutboxForDelivery(root, channel, id, options = {}) {
  return withTransaction(root, channel, (state) => {
    const item = state.outbox[assertString(id, "outboxId")];
    // UI waits are driven only by Reader events. The polling worker cannot
    // claim a popup notification or bypass the live request preflight guard.
    if (item?.condition === "ui_request" && options.localUiRequestDelivery !== true) return { claimed: false, reason: "ui_request_requires_live_reader_delivery" };
    const decision = deliveryDecisionForState(state, item);
    if (!decision.allowed) return { claimed: false, ...decision };
    const claimId = randomId("claim-"); item.status = "in_flight"; item.claim = { id: claimId, ...claimIdentity(), messageId: item.messageId, capabilityDigest: item.capability.digest, claimedAt: isoNow() }; item.attempts += 1; item.lastAttemptAt = isoNow(); item.nextAttemptAt = null;
    return { claimed: true, claimId, item: clone(item), capability: clone(decision.capability) };
  });
}
function uiRequestOutboxClaimIsCurrent(root, channel, id, claimId) {
  const state = withRead(root, channel); const item = state.outbox[id];
  const wait = item?.waitId ? state.waits[item.waitId] : null;
  const payload = outboxCapabilityPayload(item);
  return Boolean(item?.condition === "ui_request" && item.status === "in_flight" && item.claim?.id === claimId && payload?.uiRequest
    && wait?.condition === "ui_request" && wait.status === "completed" && !wait.planId
    && wait.owner.deviceId === state.instanceId && (wait.target.deviceId === state.instanceId || Boolean(resolveConfiguredPeerUrl(wait.target.deviceId)))
    && sameIdentity(payload.uiRequest.identity, wait.target) && payload.uiRequest.identity.sessionFile === wait.target.sessionFile
    && payload.uiRequest.runtimeGeneration === wait.runtimeGeneration && payload.uiRequest.requestId === wait.lastResult?.requestId);
}
function completeOutboxDelivery(root, channel, id, status, claimId, details = {}) {
  if (!OUTBOX_STATUSES.has(status)) throw new Error(`unsupported outbox status: ${status}`);
  const result = withTransaction(root, channel, (state) => {
    const item = state.outbox[assertString(id, "outboxId")]; if (!item) throw new Error("outbox item not found");
    if (claimId && (item.status !== "in_flight" || item.claim?.id !== claimId)) return { applied: false, reason: "outbox_claim_stale", item: clone(item) };
    if (item.status === "processed" && status !== "processed") return { applied: false, reason: "outbox_status_regression", item: clone(item) };
    item.status = status; Object.assign(item, clone(details)); item.lastAttemptAt = item.lastAttemptAt || isoNow();
    if (status === "accepted") { item.acceptedAt = item.acceptedAt || isoNow(); if (item.planId && state.plans[item.planId]) { const plan = state.plans[item.planId]; if (plan.waitId === item.waitId && plan.generation === item.generation && plan.round === item.round) { plan.handoffStatus = "accepted"; plan.history.push({ at: isoNow(), type: "handoff_accepted", generation: item.generation, round: item.round, waitId: item.waitId, receipt: "preflight" }); } } }
    if (status === "unknown") { item.nextAttemptAt = null; item.error = details.reason || "delivery outcome unknown; inspect recipient before retry"; }
    if (status === "queued") { item.nextAttemptAt = null; item.error = null; }
    if (status === "retrying") { item.nextAttemptAt = new Date(Date.now() + Math.min(60_000, Math.max(1_000, item.attempts * item.attempts * 1_000))).toISOString(); item.error = "delivery retry scheduled"; }
    if (status === "blocked" || status === "cancelled") { item.nextAttemptAt = null; item.error = item.error || details.reason || "delivery blocked"; if (status === "blocked" && !state.notifications[`outbox:${item.id}`]) state.notifications[`outbox:${item.id}`] = { id: `outbox:${item.id}`, kind: "final_failure", outboxId: item.id, createdAt: isoNow(), reason: item.error, acknowledged: false }; }
    if (status === "processed") { item.processedAt = isoNow(); if (item.planId && state.plans[item.planId]) { const plan = state.plans[item.planId]; if (plan.waitId === item.waitId && plan.generation === item.generation && plan.round === item.round) { plan.handoffStatus = "accepted"; plan.history.push({ at: isoNow(), type: "handoff_accepted", generation: item.generation, round: item.round, waitId: item.waitId, receipt: "processed" }); } } }
    const pendingApplied = (status === "accepted" || status === "processed") ? applyPendingEvents(state, item) : [];
    return { applied: true, item: clone(item), pendingApplied };
  });
  return result;
}
function acceptOutboxHandoff(root, channel, id, claimId, details = {}) {
  return withTransaction(root, channel, (state) => {
    const item = state.outbox[assertString(id, "outboxId")]; if (!item) throw new Error("outbox item not found");
    if (item.status !== "in_flight" || (claimId && item.claim?.id !== claimId)) return { applied: false, reason: "outbox_claim_stale", item: clone(item) };
    item.acceptedAt = item.acceptedAt || isoNow(); Object.assign(item, clone(details));
    if (item.planId && state.plans[item.planId]) { const plan = state.plans[item.planId]; if (plan.waitId === item.waitId && plan.generation === item.generation && plan.round === item.round) { plan.handoffStatus = "accepted"; plan.history.push({ at: isoNow(), type: "handoff_accepted", generation: item.generation, round: item.round, waitId: item.waitId, receipt: "preflight" }); } }
    const pendingApplied = applyPendingEvents(state, item);
    return { applied: true, item: clone(item), pendingApplied };
  });
}
function claimOutboxForPull(root, channel, id, peerId, pullMessageId) {
  return withTransaction(root, channel, (state) => {
    const item = state.outbox[assertString(id, "outboxId")];
    if (!item || item.recipient?.deviceId !== assertId(peerId, "peer.deviceId")) return { claimed: false, reason: "outbox_peer_mismatch" };
    const decision = deliveryDecisionForState(state, item); if (!decision.allowed) return { claimed: false, ...decision };
    const claimId = randomId("pull-claim-"); item.status = "in_flight"; item.claim = { id: claimId, ...claimIdentity(), messageId: item.messageId, capabilityDigest: item.capability.digest, claimedAt: isoNow(), mode: "pull" }; item.pullMessageId = item.pullMessageId || assertString(pullMessageId, "pullMessageId"); item.attempts += 1; item.lastAttemptAt = isoNow(); item.nextAttemptAt = null;
    return { claimed: true, claimId, item: clone(item), capability: clone(decision.capability) };
  });
}
function listOutboxForPeer(root, channel, peerId) {
  const state = withRead(root, channel); return Object.values(state.outbox).filter((item) => item.recipient?.deviceId === peerId && ["pending", "retrying", "queued"].includes(item.status)).map(clone);
}
function claimOutbox(root, channel, id, status = "accepted") {
  if (!OUTBOX_STATUSES.has(status)) throw new Error(`unsupported outbox status: ${status}`);
  return withTransaction(root, channel, (state) => {
    const item = state.outbox[assertString(id, "outboxId")]; if (!item) throw new Error("outbox item not found"); item.attempts += 1; item.status = status; item.lastAttemptAt = isoNow();
    if (status === "unknown") { item.nextAttemptAt = null; item.error = "delivery outcome unknown; inspect recipient before retry"; }
    if (status === "retrying") { item.nextAttemptAt = new Date(Date.now() + Math.min(60_000, Math.max(1_000, item.attempts * item.attempts * 1_000))).toISOString(); item.error = "delivery retry scheduled"; }
    if (status === "blocked") { item.nextAttemptAt = null; item.error = item.error || "delivery blocked"; if (!state.notifications[`outbox:${item.id}`]) state.notifications[`outbox:${item.id}`] = { id: `outbox:${item.id}`, kind: "final_failure", outboxId: item.id, createdAt: isoNow(), reason: item.error, acknowledged: false }; }
    if (status === "processed") { item.processedAt = isoNow(); if (item.planId && state.plans[item.planId]) { state.plans[item.planId].handoffStatus = "accepted"; state.plans[item.planId].history.push({ at: isoNow(), type: "handoff_accepted", generation: item.generation, round: item.round, waitId: item.waitId, receipt: "processed" }); } }
    return clone(item);
  });
}
function recordPullReceipt(root, channel, input) {
  const pullMessageId = assertString(input.pullMessageId, "pullMessageId"); const itemId = assertString(input.itemId, "pull.itemId"); const digest = assertString(input.itemDigest, "pull.itemDigest", 128);
  const capability = input.itemCapability && isRecord(input.itemCapability) ? clone(input.itemCapability) : null;
  if (capability?.payload?.condition === "ui_request" || capability?.payload?.uiRequest || capability?.payload?.resultEvent?.type === "ui_request") throw new Error("ui_request is local-only and cannot arrive through pull transport");
  if (capability && (capability.version !== 1 || capability.digest !== digest || !isRecord(capability.payload) || sha256(capability.payload) !== digest)) throw new Error("pull capability digest mismatch");
  return withTransaction(root, channel, (state) => {
    const key = `${pullMessageId}:${itemId}`; const existing = state.pullReceipts[key]; if (existing) return clone(existing);
    const payload = capability?.payload || {}; const receipt = { id: key, pullMessageId, itemId, sourceMessageId: assertString(input.sourceMessageId || pullMessageId, "pull.sourceMessageId"), peerId: assertId(input.peerId, "pull.peerId"), itemDigest: digest, capability, status: "received", claim: null, createdAt: isoNow(), processedAt: null };
    state.pullReceipts[key] = receipt;
    if (payload.waitId && payload.target && payload.recipient) {
      try {
        const owner = payload.operation === "report_result" ? payload.recipient : payload.owner || payload.sender;
        state.remoteBindings[key] = { id: key, condition: payload.condition ? assertCondition(payload.condition) : undefined, messageId: payload.messageId, owner: normalizeIdentity(owner, "pull.binding.owner"), target: normalizeIdentity(payload.target, "pull.binding.target"), waitId: assertId(payload.waitId, "pull.binding.waitId"), planId: payload.planId ? assertId(payload.planId, "pull.binding.planId") : undefined, taskId: payload.taskId ? assertId(payload.taskId, "pull.binding.taskId") : undefined, generation: payload.generation, round: payload.round, operation: payload.operation, authorizedScope: Array.isArray(payload.authorizedScope) ? payload.authorizedScope.slice() : [] };
      } catch { receipt.status = "blocked"; receipt.reason = "pull binding is incomplete"; }
    }
    return clone(receipt);
  });
}
function pullReceiptAuthorityForState(state, receipt) {
  if (!receipt.capability || receipt.capability.version !== 1 || receipt.capability.digest !== receipt.itemDigest || sha256(receipt.capability.payload) !== receipt.itemDigest) return { allowed: false, reason: "pull_capability_mismatch", terminal: true, receipt: clone(receipt) };
  const payload = receipt.capability.payload; const pin = state.peers?.[receipt.peerId];
  if (receipt.peerId !== state.instanceId && (!pin || pin.revokedAt)) return { allowed: false, reason: "pull_peer_not_authorized", terminal: true, receipt: clone(receipt) };
  const transportOperation = payload.operation === "report_result" ? "report_result" : "wake";
  if (pin && Array.isArray(pin.operations) && pin.operations.length && !pin.operations.includes(transportOperation)) return { allowed: false, reason: "pull_operation_not_paired", terminal: true, receipt: clone(receipt) };
  if (pin && Array.isArray(pin.scopes) && pin.scopes.length && (payload.authorizedScope || []).some((scope) => !pin.scopes.includes(scope))) return { allowed: false, reason: "pull_scope_not_paired", terminal: true, receipt: clone(receipt) };
  if (payload.waitId) { const wait = state.waits[payload.waitId]; const terminalWait = state.terminalWaits[payload.waitId]; if (terminalWait) return { allowed: false, reason: `wait_${terminalWait.status}`, terminal: true, receipt: clone(receipt) }; if (wait && ["cancelled", "failed", "blocked"].includes(wait.status)) return { allowed: false, reason: `wait_${wait.status}`, terminal: true, receipt: clone(receipt) }; if (wait?.status === "paused") return { allowed: false, reason: "wait_paused", defer: true, receipt: clone(receipt) }; if (wait && payload.generation !== undefined && wait.generation !== payload.generation) return { allowed: false, reason: "wait_generation_mismatch", terminal: true, receipt: clone(receipt) }; if (wait && payload.round !== undefined && wait.round !== payload.round) return { allowed: false, reason: "wait_round_mismatch", terminal: true, receipt: clone(receipt) }; }
  if (payload.planId) { const plan = state.plans[payload.planId]; if (plan && ["cancelled", "failed", "blocked", "completed"].includes(plan.status)) return { allowed: false, reason: `plan_${plan.status}`, terminal: true, receipt: clone(receipt) }; if (plan?.status === "paused") return { allowed: false, reason: "plan_paused", defer: true, receipt: clone(receipt) }; }
  return { allowed: true, capability: clone(payload) };
}
function claimPullReceipt(root, channel, pullMessageId, itemId) {
  return withTransaction(root, channel, (state) => {
    const key = `${assertString(pullMessageId, "pullMessageId")}:${assertString(itemId, "pull.itemId")}`; const receipt = state.pullReceipts[key]; if (!receipt) return { claimed: false, reason: "pull_receipt_not_found" };
    if (!["received", "queued"].includes(receipt.status)) return { claimed: false, reason: `pull_receipt_status_${receipt.status}`, receipt: clone(receipt) };
    const decision = pullReceiptAuthorityForState(state, receipt);
    if (!decision.allowed) {
      if (decision.defer || decision.terminal) { receipt.status = decision.defer ? "queued" : "blocked"; receipt.reason = decision.reason; receipt.processedAt = decision.defer ? null : isoNow(); }
      return { claimed: false, ...decision, receipt: clone(receipt) };
    }
    const claimId = randomId("pull-consume-"); receipt.status = "in_flight"; receipt.claim = { id: claimId, ...claimIdentity(), claimedAt: isoNow(), capabilityDigest: receipt.itemDigest }; return { claimed: true, claimId, receipt: clone(receipt), capability: decision.capability };
  });
}
function claimedPullReceiptDecision(root, channel, pullMessageId, itemId, claimId) {
  const state = withRead(root, channel); const key = `${assertString(pullMessageId, "pullMessageId")}:${assertString(itemId, "pull.itemId")}`; const receipt = state.pullReceipts[key];
  if (!receipt || receipt.status !== "in_flight" || receipt.claim?.id !== claimId || receipt.claim.capabilityDigest !== receipt.itemDigest) return { allowed: false, reason: "pull_claim_stale", terminal: true };
  return pullReceiptAuthorityForState(state, receipt);
}
function completePullReceipt(root, channel, pullMessageId, itemId, status, details = {}, claimId) {
  if (!["queued", "processed", "blocked", "unknown"].includes(status)) throw new Error(`unsupported pull receipt status: ${status}`);
  return withTransaction(root, channel, (state) => {
    const key = `${assertString(pullMessageId, "pullMessageId")}:${assertString(itemId, "pull.itemId")}`; const receipt = state.pullReceipts[key]; if (!receipt) throw new Error("pull receipt not found");
    if (claimId && (receipt.status !== "in_flight" || receipt.claim?.id !== claimId)) return { applied: false, reason: "pull_claim_stale", receipt: clone(receipt) };
    if (receipt.status === "processed" && status !== "processed") return { applied: false, reason: "pull_receipt_status_regression", receipt: clone(receipt) };
    receipt.status = status; receipt.processedAt = status === "queued" ? null : isoNow(); Object.assign(receipt, clone(details)); return { applied: true, receipt: clone(receipt) };
  });
}
function markUnclaimedPullReceiptUnknown(root, channel, pullMessageId, itemId) {
  return withTransaction(root, channel, (state) => {
    const key = `${assertString(pullMessageId, "pullMessageId")}:${assertString(itemId, "pull.itemId")}`; const receipt = state.pullReceipts[key];
    if (!receipt || receipt.status !== "received") return { applied: false, reason: "pull_receipt_changed" };
    receipt.status = "unknown"; receipt.processedAt = isoNow(); receipt.reason = "local wake outcome unknown; inspect before retry";
    return { applied: true, receipt: clone(receipt) };
  });
}
function listPullReceipts(root, channel, pullMessageId) { return Object.values(withRead(root, channel).pullReceipts).filter((receipt) => !pullMessageId || receipt.pullMessageId === pullMessageId).map(clone); }
function acknowledgePullReceipt(root, channel, pullMessageId, itemId, status) {
  return withTransaction(root, channel, (state) => {
    const key = `${assertString(pullMessageId, "pullMessageId")}:${assertString(itemId, "pull.itemId")}`; const receipt = state.pullReceipts[key];
    if (!receipt || receipt.status !== status) return { applied: false, reason: "pull_receipt_changed" };
    receipt.acknowledgedStatus = status;
    return { applied: true };
  });
}

function envelopeContainsUiRequest(envelope) { return envelope?.body?.condition === "ui_request" || envelope?.body?.event?.type === "ui_request" || envelope?.body?.resultEvent?.type === "ui_request" || Boolean(envelope?.body?.uiRequest); }
function acceptInbox(root, channel, envelope) {
  if (envelopeContainsUiRequest(envelope)) throw new Error("ui_request is local-only and cannot arrive through peer transport");
  return withTransaction(root, channel, (state) => {
    const id = assertString(envelope.messageId, "messageId"); if (state.inbox[id]) return { duplicate: true, receipt: clone(state.inbox[id]) };
    const body = clone(envelope.body || {}); const receipt = { messageId: id, sender: clone(envelope.sender), recipient: envelope.recipient, operation: envelope.operation, body, generation: envelope.generation, round: envelope.round, acceptedAt: isoNow(), status: "accepted", processedAt: null, claim: null };
    state.inbox[id] = receipt; state.receipts[id] = receipt;
    const target = body.target && isRecord(body.target) ? normalizeIdentity(body.target, "binding.target") : body.event?.identity && isRecord(body.event.identity) ? normalizeIdentity(body.event.identity, "binding.target") : null;
    const ownerInput = body.owner || body.returnOwner || body.event?.owner || envelope.sender;
    if (body.waitId && target) state.remoteBindings[id] = { id, condition: body.condition ? assertCondition(body.condition) : undefined, messageId: id, owner: normalizeIdentity(ownerInput, "binding.owner"), target, waitId: assertId(body.waitId, "binding.waitId"), planId: body.planId ? assertId(body.planId, "binding.planId") : undefined, taskId: body.taskId || body.continuation?.taskId || body.event?.taskId ? assertId(body.taskId || body.continuation?.taskId || body.event.taskId, "binding.taskId") : undefined, generation: envelope.generation ?? body.generation ?? body.event?.generation, round: envelope.round ?? body.round ?? body.event?.round, operation: envelope.operation, authorizedScope: Array.isArray(body.authorizedScope) ? body.authorizedScope.slice() : Array.isArray(body.event?.authorizedScope) ? body.event.authorizedScope.slice() : [] };
    return { duplicate: false, receipt: clone(receipt) };
  });
}
function completeInbox(root, channel, messageId, status, details = {}, claimId) {
  return withTransaction(root, channel, (state) => {
    const receipt = state.inbox[assertString(messageId, "messageId")]; if (!receipt) throw new Error("inbox message not found");
    if (claimId && (receipt.status !== "in_flight" || receipt.claim?.id !== claimId)) return { applied: false, reason: "inbox_claim_stale", receipt: clone(receipt) };
    receipt.status = status; receipt.processedAt = status === "queued" ? null : isoNow(); Object.assign(receipt, clone(details)); state.receipts[receipt.messageId] = receipt; return { applied: true, receipt: clone(receipt) };
  });
}
function listPendingInboxes(root, channel, sessionId) { return Object.values(withRead(root, channel).inbox).filter((item) => item.status === "queued" && item.body?.target?.sessionId === sessionId).map(clone); }
function inboxWakeDecisionFromState(state, receipt, sessionId, sessionFile, deviceId, expectedStatus = "queued") {
  if (!receipt) return { allowed: false, reason: "inbox_message_not_found" };
  if (receipt.status !== expectedStatus) return { allowed: false, reason: `inbox_status_${receipt.status}` };
  const body = receipt.body || {}; const target = body.target && isRecord(body.target) ? body.target : body.continuation?.target;
  if (target?.deviceId && deviceId && target.deviceId !== deviceId) return { allowed: false, reason: "inbox_target_device_mismatch" };
  if (target?.sessionId && target.sessionId !== sessionId) return { allowed: false, reason: "inbox_target_session_mismatch" };
  if (target?.sessionFile && sessionFile && !samePath(target.sessionFile, sessionFile)) return { allowed: false, reason: "inbox_target_session_file_mismatch" };
  const pin = state.peers?.[receipt.sender?.deviceId]; if (receipt.sender?.deviceId !== state.instanceId && (!pin || pin.revokedAt || (Array.isArray(pin.sessions) && !pin.sessions.includes(receipt.sender.sessionId)))) return { allowed: false, reason: "inbox_sender_not_authorized", terminal: true };
  const transportOperation = receipt.operation === "report_result" ? "report_result" : receipt.operation === "observe_wait" ? "observe_wait" : "wake";
  if (pin && Array.isArray(pin.operations) && pin.operations.length > 0 && !pin.operations.includes(transportOperation)) return { allowed: false, reason: "inbox_operation_not_authorized", terminal: true };
  const bodyScopes = Array.isArray(body.authorizedScope) ? body.authorizedScope : [];
  if (pin && Array.isArray(pin.scopes) && pin.scopes.length > 0 && bodyScopes.some((scope) => !pin.scopes.includes(scope))) return { allowed: false, reason: "inbox_scope_not_authorized", terminal: true };
  if (body.authorizedScope && (!Array.isArray(body.authorizedScope) || body.authorizedScope.some((scope) => !body.continuation?.authorizedScope?.includes(scope)))) return { allowed: false, reason: "inbox_scope_mismatch", terminal: true };
  if (body.waitId) { const wait = state.waits[body.waitId]; const terminalWait = state.terminalWaits[body.waitId]; if (terminalWait) return { allowed: false, reason: `wait_${terminalWait.status}`, terminal: true }; if (wait?.status === "paused") return { allowed: false, reason: "wait_paused", defer: true }; if (wait && !["waiting", "running", "retrying"].includes(wait.status)) return { allowed: false, reason: `wait_${wait.status}`, terminal: true }; if (wait && body.generation !== undefined && wait.generation !== body.generation) return { allowed: false, reason: "wait_generation_mismatch" }; if (wait && body.round !== undefined && body.round !== wait.round) return { allowed: false, reason: "wait_round_mismatch" }; }
  if (body.planId) { const plan = state.plans[body.planId]; if (plan?.status === "paused") return { allowed: false, reason: "plan_paused", defer: true }; if (plan && !["waiting", "running"].includes(plan.status)) return { allowed: false, reason: `plan_${plan.status}`, terminal: true }; }
  return { allowed: true };
}
function inboxWakeDecision(root, channel, messageId, sessionId, sessionFile, deviceId) { const state = withRead(root, channel); return inboxWakeDecisionFromState(state, state.inbox[assertString(messageId, "messageId")], sessionId, sessionFile, deviceId); }
function claimedInboxWakeDecision(root, channel, messageId, sessionId, sessionFile, deviceId, claimId) {
  const state = withRead(root, channel); const receipt = state.inbox[assertString(messageId, "messageId")];
  if (!receipt || receipt.status !== "in_flight" || !claimId || receipt.claim?.id !== claimId) return { allowed: false, reason: "inbox_claim_stale", terminal: true };
  return inboxWakeDecisionFromState(state, receipt, sessionId, sessionFile, deviceId, "in_flight");
}
function claimInboxForDelivery(root, channel, messageId, sessionId, sessionFile, deviceId, expectedStatus = "queued") {
  if (!["accepted", "queued"].includes(expectedStatus)) throw new Error("unsupported inbox claim status");
  return withTransaction(root, channel, (state) => {
    const receipt = state.inbox[assertString(messageId, "messageId")]; const decision = inboxWakeDecisionFromState(state, receipt, sessionId, sessionFile, deviceId, expectedStatus);
    if (!decision.allowed) {
      if (receipt?.status === expectedStatus && (decision.defer || decision.terminal || expectedStatus === "accepted")) { receipt.status = decision.defer ? "queued" : "blocked"; receipt.reason = decision.reason; receipt.processedAt = decision.defer ? null : isoNow(); state.receipts[receipt.messageId] = receipt; }
      return { claimed: false, ...decision, ...(receipt ? { receipt: clone(receipt) } : {}) };
    }
    const claimId = randomId("inbox-claim-"); receipt.status = "in_flight"; receipt.claim = { id: claimId, ...claimIdentity(), claimedAt: isoNow() }; return { claimed: true, claimId, receipt: clone(receipt) };
  });
}
function applyPeerReceipt(root, channel, input) {
  const messageId = assertString(input.messageId, "receipt.messageId"); const status = assertString(input.status, "receipt.status");
  if (!["queued", "processed", "blocked", "unknown"].includes(status)) throw new Error("unsupported receipt status");
  return withTransaction(root, channel, (state) => {
    const item = Object.values(state.outbox).find((candidate) => candidate.messageId === messageId && (!input.outboxId || candidate.id === input.outboxId));
    if (!item) throw new Error("outbox receipt target not found");
    if (input.outboxId && item.id !== input.outboxId) throw new Error("outbox receipt id mismatch");
    const pullDigest = input.details?.pullDigest || input.pullDigest; const pullMessageId = input.details?.pullMessageId;
    const pullRequest = pullMessageId && state.inbox[pullMessageId];
    const samePullSender = pullMessageId && item.pullMessageId === pullMessageId && pullDigest && pullDigest === item.capability?.digest && pullRequest?.operation === "pull_messages" && sameIdentity(pullRequest.sender, input.sender) && input.sender?.deviceId === item.recipient?.deviceId;
    if (input.sender && !sameIdentity(input.sender, item.recipient) && !samePullSender) throw new Error("outbox receipt sender identity mismatch");
    if (pullDigest && item.capability?.digest && pullDigest !== item.capability.digest) throw new Error("outbox receipt capability mismatch");
    if (item.status === "processed" && status !== "processed") throw new Error("outbox receipt would regress processed state");
    const alreadyProcessed = item.status === "processed";
    const current = item.planId ? state.plans[item.planId] : item.waitId ? state.waits[item.waitId] : null;
    const currentBinding = item.planId ? Boolean(current && current.waitId === item.waitId && current.generation === item.generation && current.round === item.round) : Boolean(current && current.id === item.waitId && (current.status === "waiting" || current.status === "running" || current.status === "completed"));
    item.recipientReceipt = { status, at: isoNow(), ...clone(input.details || {}) }; item.status = status; item.lastAttemptAt = item.lastAttemptAt || isoNow(); item.processedAt = status === "processed" ? isoNow() : item.processedAt || null;
    if (status === "processed" && item.planId && state.plans[item.planId] && currentBinding) { state.plans[item.planId].handoffStatus = "accepted"; if (!alreadyProcessed) state.plans[item.planId].history.push({ at: isoNow(), type: "handoff_accepted", generation: item.generation, round: item.round, waitId: item.waitId, receipt: "processed" }); if (!alreadyProcessed && ["waiting", "running"].includes(state.plans[item.planId].status)) applyPendingEvents(state, item); }
    if (status === "blocked") { item.error = input.reason || "recipient blocked"; if (!state.notifications[`outbox:${item.id}`]) state.notifications[`outbox:${item.id}`] = { id: `outbox:${item.id}`, kind: "final_failure", outboxId: item.id, createdAt: isoNow(), reason: item.error, acknowledged: false }; }
    return clone(item);
  });
}
function verifyResultLocation(location, baseline = null) {
  try {
    if (!path.isAbsolute(location)) return null;
    const stat = fs.lstatSync(location);
    if (!stat.isFile() || stat.size > MAX_RESULT_BYTES) return null;
    if (baseline && (stat.mtimeMs <= baseline.mtimeMs || stat.ino === baseline.ino)) return null;
    const bytes = fs.readFileSync(location); return { bytes: bytes.length, sha256: sha256(bytes), mtimeMs: stat.mtimeMs };
  } catch { return null; }
}
function validateExternalTaskSpec(spec) {
  if (!isRecord(spec)) throw new Error("external task spec is required");
  if (spec.kind && spec.kind !== "argv") throw new Error(`unsupported external task kind: ${spec.kind}`);
  if (!Array.isArray(spec.argv) || spec.argv.length < 1 || spec.argv.length > 64 || spec.argv.some((arg) => typeof arg !== "string" || arg.length > 4000)) throw new Error("external task argv must be a bounded string array");
  if (spec.shell === true) throw new Error("shell execution is unsupported");
  const resultLocation = assertString(spec.resultLocation, "external task resultLocation", 2000);
  if (!path.isAbsolute(resultLocation)) throw new Error("external task resultLocation must be absolute");
  if (fs.existsSync(resultLocation)) throw new Error("external task resultLocation must not already exist");
  const id = assertId(spec.id || randomId("task-"), "external task id"); const timeoutMs = Number.isInteger(spec.timeoutMs) ? Math.max(100, Math.min(86_400_000, spec.timeoutMs)) : 60_000;
  return { id, kind: "argv", argv: spec.argv.slice(), cwd: spec.cwd ? path.resolve(assertString(spec.cwd, "external task cwd", 2000)) : undefined, env: {}, resultLocation, timeoutMs, ...(spec.identity ? { identity: normalizeIdentity(spec.identity, "external task identity") } : {}), ...(spec.waitId ? { waitId: assertId(spec.waitId, "external task waitId") } : {}), ...(spec.planId ? { planId: assertId(spec.planId, "external task planId") } : {}), ...(Number.isInteger(spec.generation) ? { generation: spec.generation } : {}), ...(Number.isInteger(spec.round) ? { round: spec.round } : {}), status: "queued", createdAt: isoNow(), startedAt: null, finishedAt: null, pid: null, startToken: null, resultBaseline: null, exitCode: null, signal: null, timedOut: false, error: null };
}
function enqueueExternalTask(root, channel, spec) {
  const task = validateExternalTaskSpec(spec);
  return withTransaction(root, channel, (state) => {
    if (state.externalTasks[task.id]) throw new Error(`external task already exists: ${task.id}`);
    const normalizedPath = path.resolve(task.resultLocation);
    if (Object.values(state.externalTasks).some((candidate) => path.resolve(candidate.resultLocation) === normalizedPath)) throw new Error("external task resultLocation is already bound to another task");
    state.externalTasks[task.id] = task; pushHistory(state, { type: "external_task_queued", taskId: task.id }); return clone(task);
  });
}
function listExternalTasks(root, channel) { return Object.values(withRead(root, channel).externalTasks).map(clone); }
function updateExternalTask(root, channel, id, patch) { return withTransaction(root, channel, (state) => { const task = state.externalTasks[assertId(id, "taskId")]; if (!task) throw new Error("external task not found"); Object.assign(task, clone(patch), { updatedAt: isoNow() }); return clone(task); }); }
function appendBounded(current, chunk) { const next = current + chunk.toString(); return next.length <= MAX_OUTPUT_CHARS ? next : `${next.slice(0, MAX_OUTPUT_CHARS)}… [truncated]`; }
function killChild(child) { try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch {} setTimeout(() => { try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {} }, 1000).unref(); }
function spawnStructuredTask(root, channel, taskId) {
  const task = withRead(root, channel).externalTasks[assertId(taskId, "taskId")]; if (!task) throw new Error("external task not found"); if (task.status !== "queued") return { task: clone(task), child: null };
  if (fs.existsSync(task.resultLocation)) throw new Error("external task resultLocation appeared before start");
  const startToken = randomId("start-"); const startedAt = isoNow(); updateExternalTask(root, channel, task.id, { status: "running", startedAt, pid: null, startToken, resultBaseline: null });
  let child;
  try { child = childProcess.spawn(task.argv[0], task.argv.slice(1), { cwd: task.cwd || process.cwd(), env: sanitizeProjectCommandEnvironment({ ...process.env, ...task.env }), shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error); updateExternalTask(root, channel, task.id, { status: "failed", finishedAt: isoNow(), exitCode: null, signal: null, error: message, stdout: "", stderr: message });
    if (task.waitId && task.identity) { try { applyEvent(root, channel, { id: randomId("external-error-"), type: "task_failed", identity: task.identity, waitId: task.waitId, planId: task.planId, generation: task.generation, round: task.round, taskId: task.id, reason: message, summary: "external task spawn failed" }); } catch {} }
    return { task: { ...task, status: "failed", startToken, error: message }, child: null, error: message };
  }
  updateExternalTask(root, channel, task.id, { pid: child.pid || null }); let stdout = ""; let stderr = ""; let timedOut = false; let finished = false;
  const timeout = setTimeout(() => { timedOut = true; killChild(child); }, task.timeoutMs);
  const finish = (patch) => { if (finished) return false; finished = true; clearTimeout(timeout); updateExternalTask(root, channel, task.id, { ...patch, stdout, stderr, timedOut }); return true; };
  const report = (ok, patch, code) => { if (task.waitId && task.identity) { try { applyEvent(root, channel, { id: randomId("external-result-"), type: ok ? "task_completed" : "task_failed", identity: task.identity, waitId: task.waitId, planId: task.planId, generation: task.generation, round: task.round, taskId: task.id, success: ok, resultLocation: task.resultLocation, reason: ok ? undefined : patch.error || "external task result failed", result: { success: ok, resultLocation: task.resultLocation, evidence: patch.resultEvidence, evidenceSource: "check_program", exitCode: code } }); } catch (error) { try { updateExternalTask(root, channel, task.id, { error: `result event blocked: ${error instanceof Error ? error.message : String(error)}` }); } catch {} } } };
  child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); }); child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
  child.once("error", (error) => { const message = error instanceof Error ? error.message : String(error); if (finish({ status: "failed", finishedAt: isoNow(), exitCode: null, signal: null, error: message })) report(false, { error: message }, null); });
  child.once("close", (code, signal) => { const evidence = code === 0 ? verifyResultLocation(task.resultLocation) : null; const ok = code === 0 && Boolean(evidence) && !timedOut; const patch = { status: ok ? "completed" : "failed", finishedAt: isoNow(), exitCode: code, signal: signal || null, resultVerified: Boolean(evidence), resultEvidence: evidence, error: ok ? null : (timedOut ? "external task timed out" : code === 0 ? "result location missing or unverifiable" : `external task exited ${code ?? signal}`) }; if (finish(patch)) report(ok, patch, code); });
  return { task: { ...task, status: "running", startToken }, child };
}
function pairPeer(root, channel, input) {
  const deviceId = assertId(input.deviceId, "peer.deviceId"); const publicKey = assertString(input.publicKey, "peer.publicKey", 10000); if (!publicKey.includes("PUBLIC KEY")) throw new Error("peer.publicKey must be a public key PEM");
  const sessions = Array.isArray(input.sessions) ? input.sessions.map((value) => assertId(value, "peer.session")).slice(0, 100) : []; if (!sessions.length) throw new Error("peer.sessions requires at least one explicit session");
  const peerUrl = assertString(input.peerUrl, "peer.peerUrl", 2000); const configuredUrl = resolveConfiguredPeerUrl(deviceId); if (!configuredUrl || !sameOrigin(configuredUrl, peerUrl)) throw new Error("peer.peerUrl is not the configured activity peer URL");
  const operations = Array.isArray(input.operations) ? input.operations.map((value) => assertString(value, "peer.operation", 100)).slice(0, 20) : ["wake", "pull_messages", "report_result", "observe_wait", "receipt", "receipt_query"];
  const scopes = Array.isArray(input.scopes) ? input.scopes.map((value) => assertString(value, "peer.scope", 100)).slice(0, 20) : ["resume_prior_work", "report_result", "observe_wait", "pull_messages"];
  if (operations.some((value) => !["wake", "pull_messages", "report_result", "observe_wait", "receipt", "receipt_query"].includes(value))) throw new Error("peer.operations contains unsupported operation"); if (scopes.some((value) => !["resume_prior_work", "report_result", "observe_wait", "pull_messages"].includes(value))) throw new Error("peer.scopes contains unsupported scope");
  return withTransaction(root, channel, (state) => { state.peers[deviceId] = { deviceId, peerUrl, publicKey, sessions, operations, scopes, pairedAt: isoNow(), revokedAt: null }; return clone(state.peers[deviceId]); });
}
function revokePeer(root, channel, deviceId) { return withTransaction(root, channel, (state) => { const peer = state.peers[assertId(deviceId, "peer.deviceId")]; if (!peer) throw new Error("peer not paired"); peer.revokedAt = isoNow(); return clone(peer); }); }
function listPeerPins(root, channel) { return Object.values(withRead(root, channel).peers).map(clone); }
function buildPeerPayload(envelope) { const copy = { ...envelope }; delete copy.signature; delete copy.messageDigest; return canonicalJson(copy); }
function createSignedEnvelope(input, privateKey) { const envelope = { version: 1, messageId: input.messageId || randomId("msg-"), channel: ensureChannel(input.channel), sender: normalizeIdentity(input.sender, "envelope.sender"), recipient: assertId(input.recipient, "envelope.recipient"), operation: assertString(input.operation || "wake", "envelope.operation", 100), scope: Array.isArray(input.scope) ? input.scope.map((v) => assertString(v, "envelope.scope", 160)).slice(0, 20) : ["resume_prior_work"], generation: input.generation, round: input.round, body: isRecord(input.body) ? clone(input.body) : {}, nonce: input.nonce || crypto.randomBytes(16).toString("hex"), timestamp: input.timestamp || Date.now() }; envelope.signature = crypto.sign(null, Buffer.from(buildPeerPayload(envelope)), privateKey).toString("base64url"); envelope.messageDigest = sha256(buildPeerPayload(envelope)); return envelope; }
function verifySignedEnvelope(envelope, publicKey, options = {}) { if (!isRecord(envelope) || envelope.version !== 1 || typeof envelope.signature !== "string") return { ok: false, reason: "malformed_signature_envelope" }; try { if (options.channel && envelope.channel !== options.channel) return { ok: false, reason: "channel_mismatch" }; if (options.recipient && envelope.recipient !== options.recipient) return { ok: false, reason: "recipient_mismatch" }; if (options.sender && envelope.sender?.deviceId !== options.sender) return { ok: false, reason: "sender_mismatch" }; if (options.operation && envelope.operation !== options.operation) return { ok: false, reason: "operation_mismatch" }; if (options.maxSkewMs !== undefined && Math.abs(Date.now() - Number(envelope.timestamp)) > options.maxSkewMs) return { ok: false, reason: "stale_timestamp" }; if (options.scope && (!Array.isArray(envelope.scope) || !envelope.scope.includes(options.scope))) return { ok: false, reason: "scope_denied" }; if (!crypto.verify(null, Buffer.from(buildPeerPayload(envelope)), publicKey, Buffer.from(envelope.signature, "base64url"))) return { ok: false, reason: "invalid_signature" }; return { ok: true, digest: sha256(buildPeerPayload(envelope)) }; } catch (error) { return { ok: false, reason: `invalid_signature:${error instanceof Error ? error.message : String(error)}` }; } }
function generatePeerKeyPair() { const keys = crypto.generateKeyPairSync("ed25519"); return { publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString() }; }
function loadPublicKeyPins(raw) { if (!raw) return {}; try { const parsed = JSON.parse(raw); if (!isRecord(parsed)) return {}; return Object.fromEntries(Object.entries(parsed).filter(([id, key]) => typeof id === "string" && (typeof key === "string" || isRecord(key)))); } catch { return {}; } }
function pinDetails(pin) { return typeof pin === "string" ? { publicKey: pin } : pin; }
function acceptPeerEnvelope(root, channel, envelope, options = {}) {
  if (envelopeContainsUiRequest(envelope)) return { accepted: false, status: "blocked", reason: "ui_request_local_only" };
  const statePins = withRead(root, channel).peers; if (options.requirePersistentPin && !statePins[envelope?.sender?.deviceId]) return { accepted: false, status: "blocked", reason: "peer_not_paired" }; const pins = options.requirePersistentPin ? statePins : { ...(options.publicKeys || loadPublicKeyPins(process.env.PI_WEB_SESSION_CONTROL_PEER_PUBLIC_KEYS)), ...statePins }; const pin = pinDetails(pins[envelope?.sender?.deviceId]); if (!pin?.publicKey || pin.revokedAt) return { accepted: false, status: "blocked", reason: "peer_not_paired" };
  if (Array.isArray(pin.sessions) && pin.sessions.length > 0 && !pin.sessions.includes(envelope.sender.sessionId)) return { accepted: false, status: "blocked", reason: "peer_session_not_paired" };
  const requiredScope = envelope.operation === "pull_messages" || envelope.operation === "receipt" || envelope.operation === "receipt_query" ? "pull_messages" : envelope.operation === "report_result" ? "report_result" : envelope.operation === "observe_wait" ? "observe_wait" : envelope.operation === "wake" ? "resume_prior_work" : null;
  if (!["wake", "pull_messages", "report_result", "observe_wait", "receipt", "receipt_query"].includes(envelope.operation)) return { accepted: false, status: "blocked", reason: "operation_denied" }; if (Array.isArray(pin.operations) && pin.operations.length > 0 && !pin.operations.includes(envelope.operation)) return { accepted: false, status: "blocked", reason: "operation_denied" }; if (Array.isArray(pin.scopes) && pin.scopes.length > 0 && envelope.scope?.some((scope) => !pin.scopes.includes(scope))) return { accepted: false, status: "blocked", reason: "scope_denied" }; if (requiredScope && (!Array.isArray(envelope.scope) || !envelope.scope.includes(requiredScope))) return { accepted: false, status: "blocked", reason: "scope_denied" };
  if (isRecord(envelope.body) && Array.isArray(envelope.body.authorizedScope) && envelope.body.authorizedScope.some((scope) => !envelope.scope?.includes(scope))) return { accepted: false, status: "blocked", reason: "scope_denied" }; const nestedContinuation = isRecord(envelope.body?.continuation) ? envelope.body.continuation : null; if (nestedContinuation && Array.isArray(nestedContinuation.authorizedScope) && nestedContinuation.authorizedScope.some((scope) => !envelope.scope?.includes(scope))) return { accepted: false, status: "blocked", reason: "continuation_scope_denied" }; if (nestedContinuation?.target && envelope.body?.target && (!sameIdentity(nestedContinuation.target, envelope.body.target) || (nestedContinuation.target.sessionFile && envelope.body.target.sessionFile && nestedContinuation.target.sessionFile !== envelope.body.target.sessionFile))) return { accepted: false, status: "blocked", reason: "continuation_target_mismatch" };
  const verified = verifySignedEnvelope(envelope, pin.publicKey, { channel, recipient: options.recipient, maxSkewMs: options.maxSkewMs ?? 5 * 60_000 }); if (!verified.ok) return { accepted: false, status: "blocked", reason: verified.reason }; const state = withRead(root, channel); if (state.inbox[envelope.messageId]) return { accepted: true, duplicate: true, receipt: state.inbox[envelope.messageId] }; const accepted = acceptInbox(root, channel, envelope); return { accepted: true, duplicate: accepted.duplicate, receipt: accepted.receipt, digest: verified.digest };
}
function consumeWake(root, channel, messageId, event) { return withTransaction(root, channel, (state) => { const receipt = state.inbox[assertString(messageId, "messageId")]; if (!receipt) throw new Error("inbox message not found"); if (receipt.status === "processed") return clone(receipt); receipt.status = "processed"; receipt.processedAt = isoNow(); receipt.eventId = event?.id || null; if (event) { const id = event.id || randomId("wake-event-"); if (!state.events[id]) { state.events[id] = { id, ...clone(event), createdAt: event.createdAt || isoNow(), outcome: "wake_processed" }; state.eventOrder.push(id); } } return clone(receipt); }); }
function recoverState(root, channel) {
  drainRuntimeEvents(root, channel);
  return withTransaction(root, channel, (state) => {
    let changed = false;
    for (const item of Object.values(state.outbox)) if (item.status === "in_flight" && !claimIsAlive(item.claim)) { item.status = "unknown"; item.nextAttemptAt = null; item.error = "recovery requires recipient acknowledgement; automatic replay disabled"; changed = true; }
    for (const receipt of Object.values(state.inbox)) if (receipt.status === "in_flight" && !claimIsAlive(receipt.claim)) { receipt.status = "unknown"; receipt.processedAt = isoNow(); receipt.reason = "recipient side effect may have occurred; automatic replay disabled"; changed = true; }
    for (const receipt of Object.values(state.pullReceipts)) if (receipt.status === "in_flight" && !claimIsAlive(receipt.claim)) { receipt.status = "unknown"; receipt.processedAt = isoNow(); receipt.reason = "pull consumer outcome is unknown; inspect the source receipt before retry"; changed = true; }
    for (const task of Object.values(state.externalTasks)) if (task.status === "running" && !processAlive(task.pid, task.startToken)) { task.status = "blocked"; task.error = "unknown execution outcome after worker restart; inspect result before retry"; task.updatedAt = isoNow(); changed = true; }
    if (changed) pushHistory(state, { type: "worker_recovered" }); return changed ? projectState(state) : abortCommit(projectState(state));
  });
}
function runtimeInbox(root, channel) { return `${stateFile(root, channel)}.events`; }
const runtimeProducerId = randomId("producer-");
let runtimeProducerSequence = 0;
function isRuntimeInboxBusy(error) { return error?.code === "ELOCKED" || String(error?.message).startsWith("state lock conflict for channel "); }
const runtimeInboxFilePattern = /^[a-f0-9]{64}(?:\.[a-f0-9]{32})?\.json$/;
function publishRuntimeEvent(root, channel, event) {
  const directory = runtimeInbox(root, channel);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Dependencies name a unique publication, not a replayable domain event ID.
  // Replaying A after its import must not resurrect B -> A while adding A -> B.
  const file = path.join(directory, `${sha256(event.id)}.${randomId()}.json`);
  const predecessors = fs.readdirSync(directory).filter(name => runtimeInboxFilePattern.test(name));
  const record = { version: 1, producerId: runtimeProducerId, producerSequence: ++runtimeProducerSequence, predecessors, event };
  atomicWriteJson(file, record);
  // Retried for every publication, even if a prior failed acknowledgement left
  // the directory visible. Publication never waits on a shared writer mutex.
  fsyncDirectory(path.dirname(directory));
}
function readOrderedRuntimeEvents(directory) {
  const remaining = new Map();
  for (const name of fs.readdirSync(directory).filter(name => runtimeInboxFilePattern.test(name)).sort()) {
    const file = path.join(directory, name);
    try {
      remaining.set(name, JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (error) {
      throw new Error(`runtime inbox record is invalid: ${file}`, { cause: error });
    }
  }
  const ordered = [];
  while (remaining.size) {
    const ready = [...remaining].filter(([, record]) => !(record.predecessors || []).some(name => remaining.has(name)));
    if (!ready.length) throw new Error("runtime inbox predecessor cycle");
    ready.sort(([a, left], [b, right]) => left.producerId === right.producerId && left.producerId ? left.producerSequence - right.producerSequence : a.localeCompare(b));
    for (const entry of ready) { ordered.push(entry); remaining.delete(entry[0]); }
  }
  return ordered;
}
function drainRuntimeEvents(root, channel, wantedId) {
  const directory = runtimeInbox(root, channel);
  if (!fs.existsSync(directory)) return;
  // One crash-released consumer mutex; publishers never acquire it. The files
  // themselves are the durable inbox, with no second queue database to reconcile.
  const release = acquireStateWriteLock(`${stateFile(root, channel)}.events-drain`);
  try {
    let result;
    for (let batch = 0; batch < 16; batch++) {
      const ordered = readOrderedRuntimeEvents(directory);
      if (!ordered.length) return result;
      const legacy = ordered.filter(([, record]) => !record.event).map(([name]) => name);
      if (legacy.length) withTransaction(root, channel, state => {
        const warning = { reason: "legacy_runtime_event_order_unknown", files: legacy, recoveryOrder: "legacy_filename_order" };
        if (canonicalJson(state.runtimeInboxWarnings || []) === canonicalJson([warning])) return abortCommit();
        state.runtimeInboxWarnings = [warning];
      });
      for (const [name, record] of ordered) {
        const event = record.event || record;
        const applied = applyEvent(root, channel, event);
        // Domain commit first. Crash before unlink replays the same business
        // event idempotently, retaining its immutable publication dependencies.
        fs.unlinkSync(path.join(directory, name)); fsyncDirectory(directory);
        if (event.id === wantedId) result = applied;
      }
      // Publications arriving during this snapshot are included in the next
      // pass, rather than waiting for an unrelated future lifecycle event.
    }
    if (fs.readdirSync(directory).some(name => runtimeInboxFilePattern.test(name))) {
      // Bound one synchronous drain's work; existing caller/worker retry owns
      // the remainder. This never changes already durable admission.
      throw Object.assign(new Error("runtime inbox has more pending events"), { code: "ELOCKED" });
    }
    return result;
  } finally { release(); }
}
function runtimeEvent(root, channel, event) {
  if (!fs.existsSync(stateFile(root, channel))) return { skipped: true, reason: "state_not_initialized" };
  if (!EVENT_TYPES.has(event.type)) throw new Error(`unsupported event type: ${event.type}`);
  eventIdentity(event);
  validateUiRequestEvent(event, configuredDeviceId());
  const durableEvent = { ...clone(event), id: event.id ? assertId(event.id, "event.id") : randomId("runtime-") };
  publishRuntimeEvent(root, channel, durableEvent);
  try { return { ...drainRuntimeEvents(root, channel, durableEvent.id), persisted: true }; }
  catch (error) {
    if (!isRuntimeInboxBusy(error)) throw error;
    return { queued: true, persisted: true, eventId: durableEvent.id };
  }
}
module.exports = { SCHEMA_VERSION, CONDITIONS, WAIT_STATUSES, TERMINAL_STATUSES, isoNow, randomId, canonicalJson, sha256, normalizeIdentity, sameIdentity, samePath, configuredDeviceId, stateFile, readState, withRead, withTransaction, atomicWriteJson, abortCommit, createWait, createPlan, applyEvent, transitionWait, invalidateUiRequestWaits, getStatus, projectState, claimOutbox, claimOutboxForDelivery, uiRequestOutboxClaimIsCurrent, completeOutboxDelivery, acceptOutboxHandoff, claimOutboxForPull, listOutboxForPeer, outboxDeliveryDecision, claimedOutboxDeliveryDecision, verifyOutboxCapability, acceptInbox, completeInbox, claimInboxForDelivery, claimedInboxWakeDecision, listPendingInboxes, inboxWakeDecision, recordPullReceipt, claimPullReceipt, claimedPullReceiptDecision, completePullReceipt, markUnclaimedPullReceiptUnknown, listPullReceipts, acknowledgePullReceipt, applyPeerReceipt, consumeWake, recoverState, runtimeEvent, drainRuntimeEvents, validateExternalTaskSpec, enqueueExternalTask, listExternalTasks, updateExternalTask, spawnStructuredTask, pairPeer, revokePeer, listPeerPins, resolveConfiguredPeerUrl, sameOrigin, createSignedEnvelope, verifySignedEnvelope, generatePeerKeyPair, loadPublicKeyPins, acceptPeerEnvelope };
