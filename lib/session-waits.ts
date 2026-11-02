import { createRequire } from "node:module";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { waitReadiness, workerHealth } from "./session-wait-ui";
import { localDeviceIdentity, readActivityConfig } from "./activity-peers";
import { createWaitDrainScheduler } from "./session-wait-drain";
import { getRpcSession } from "./rpc-manager";
import { createRemoteUiObservers } from "./session-ui-remote";
import { requestRemoteSessionControl, trustedSessionPeer } from "./session-control-remote";
import { emitActivityEvent, subscribeActivityEvents } from "./activity-events";

const require = createRequire(import.meta.url);
const core = require("../bin/session-wait-core.cjs") as typeof import("../bin/session-wait-core.cjs");

export type SessionIdentity = {
  deviceId: string;
  sessionId: string;
  sessionFile?: string | null;
  title?: string | null;
};
export type WaitCondition = "turn_settled" | "task_completed" | "acceptance_passed" | "ui_request";
export type WaitStatus = "waiting" | "running" | "retrying" | "blocked" | "paused" | "completed" | "failed" | "cancelled";

export function getSessionWaitStateRoot(): string {
  return process.env.PI_WEB_SESSION_WAIT_STATE_ROOT?.trim()
    || join(getAgentDir(), "session-control-waits");
}
export function getSessionWaitChannel(): string {
  return process.env.PI_WEB_SESSION_WAIT_CHANNEL?.trim() || "reader";
}
export function localWaitIdentity(sessionId: string, sessionFile?: string | null): SessionIdentity {
  return {
    deviceId: localDeviceIdentity(readActivityConfig(), new Date().toISOString()).id,
    sessionId,
    ...(sessionFile ? { sessionFile } : {}),
  };
}

type RemoteRuntime = { observers: ReturnType<typeof createRemoteUiObservers>; close: () => void };
const remoteRuntimeKey = Symbol.for("pi-web.remote-ui-waits");
const remoteRuntimes = ((globalThis as Record<symbol, unknown>)[remoteRuntimeKey] ??= new Map()) as Map<string, RemoteRuntime>;
const remoteRuntimeId = () => JSON.stringify([getSessionWaitStateRoot(), getSessionWaitChannel()]);
function remoteUiSnapshot(target: SessionIdentity) { return remoteRuntimes.get(remoteRuntimeId())?.observers.snapshot(target) ?? null; }

export function synchronizeRemoteUiWaits(): void {
  const root = getSessionWaitStateRoot(); const channel = getSessionWaitChannel();
  if (!existsSync(core.stateFile(root, channel))) return;
  const key = remoteRuntimeId();
  let runtime = remoteRuntimes.get(key);
  if (!runtime) {
    const observers = createRemoteUiObservers(channel, (target, snapshot) => {
      const state = core.readState(root, channel);
      for (const value of Object.values(state.waits)) {
        const wait = value as { id: string; condition: string; status: string; target: SessionIdentity; runtimeGeneration: string };
        if (wait.condition !== "ui_request" || wait.target.deviceId !== target.deviceId || wait.target.sessionId !== target.sessionId) continue;
        if (snapshot.runtimeStatus !== "live" || snapshot.runtimeGeneration !== wait.runtimeGeneration || snapshot.sessionFile !== wait.target.sessionFile) {
          core.invalidateUiRequestWaits(root, channel, { identity: wait.target, runtimeGeneration: snapshot.runtimeGeneration, reason: snapshot.runtimeGeneration === wait.runtimeGeneration ? "runtime_closed" : "runtime_replaced", waitIds: [wait.id] });
          continue;
        }
        if (!["waiting", "running", "retrying"].includes(wait.status)) continue;
        for (const request of snapshot.requests) {
          if (!["select", "confirm", "input", "editor"].includes(request.method) || (typeof request.expiresAt === "number" && request.expiresAt <= Date.now())) continue;
          core.runtimeEvent(root, channel, { id: core.sha256({ waitId: wait.id, runtimeGeneration: snapshot.runtimeGeneration, requestId: request.id }), type: "ui_request", identity: wait.target, runtimeGeneration: snapshot.runtimeGeneration, requestId: request.id, method: request.method, source: "rpc-manager", waitId: wait.id, summary: "Pending " + request.method + " popup; use targetDeviceId=" + target.deviceId + " with pending_ui before answering." });
          break;
        }
      }
    }, () => { emitActivityEvent({ kind: "wait" }); scheduleLocalOwnerOutboxDrain(); });
    let releaseWatch: (() => void) | undefined;
    const stop = subscribeActivityEvents(event => { if (event.kind === "wait") synchronizeRemoteUiWaits(); });
    const closers = ((globalThis as Record<symbol, unknown>)[Symbol.for("pi-web.agentEventStreamClosers")] ??= new Set()) as Set<() => void>;
    const close = () => { observers.close(); stop(); releaseWatch?.(); remoteRuntimes.delete(key); closers.delete(close); };
    runtime = { observers, close }; remoteRuntimes.set(key, runtime); closers.add(close);
    void import("./session-wait-events").then(({ subscribeSessionWaitChanges }) => { if (remoteRuntimes.get(key) === runtime) releaseWatch = subscribeSessionWaitChanges(root, channel); });
  }
  try {
    const status = core.getStatus(root, channel) as { waits: Array<{ id: string; condition: string; status: string; target: SessionIdentity }>; outbox: Array<{ waitId?: string; status: string }> };
    const localId = localDeviceIdentity(readActivityConfig(), new Date().toISOString()).id;
    runtime.observers.sync(status.waits.filter(wait => wait.condition === "ui_request" && wait.target.deviceId !== localId
      && (["waiting", "running", "retrying"].includes(wait.status) || (wait.status === "completed" && status.outbox.some(item => item.waitId === wait.id && ["pending", "retrying", "queued", "in_flight"].includes(item.status))))).map(wait => wait.target));
  } catch (error) { runtime.observers.sync([]); console.error("[session-wait] remote UI state unavailable:", error instanceof Error ? error.message : String(error)); }
}
export function closeRemoteUiWaits(): void { remoteRuntimes.get(remoteRuntimeId())?.close(); }

export function observeWaitCapability(deviceId: string, sessionId: string): { allowed: boolean; reason?: string } {
  const root = getSessionWaitStateRoot(); const channel = getSessionWaitChannel();
  try {
    const peer = (core.listPeerPins(root, channel) as Array<Record<string, unknown>>).find((candidate) => candidate.deviceId === deviceId);
    if (!peer || peer.revokedAt) return { allowed: false, reason: "observe_wait_peer_not_paired" };
    const sessions = Array.isArray(peer.sessions) ? peer.sessions : []; if (!sessions.includes(sessionId)) return { allowed: false, reason: "observe_wait_session_not_paired" };
    const operations = Array.isArray(peer.operations) ? peer.operations : []; const scopes = Array.isArray(peer.scopes) ? peer.scopes : [];
    if (!operations.includes("observe_wait") || !scopes.includes("observe_wait")) return { allowed: false, reason: "observe_wait_capability_not_paired" };
    if (typeof peer.peerUrl !== "string" || !core.resolveConfiguredPeerUrl(deviceId) || !core.sameOrigin(peer.peerUrl, core.resolveConfiguredPeerUrl(deviceId) as string)) return { allowed: false, reason: "observe_wait_peer_url_not_configured" };
    return { allowed: true };
  } catch (error) { return { allowed: false, reason: error instanceof Error ? error.message : String(error) }; }
}

export function createPersistentWait(input: Record<string, unknown>) {
  const wait = core.createWait(getSessionWaitStateRoot(), getSessionWaitChannel(), input);
  if (wait.condition === "ui_request") synchronizeRemoteUiWaits();
  return projectRegisteredWait(wait);
}
const ownerDrain = createWaitDrainScheduler(drainLocalOwnerOutbox);
let uiDrainRequested = false;
function scheduleLocalOwnerOutboxDrain(): void { uiDrainRequested = true; ownerDrain.request(); }
export function createHandoffPlan(input: Record<string, unknown>) {
  const result = core.createPlan(getSessionWaitStateRoot(), getSessionWaitChannel(), input);
  scheduleLocalOwnerOutboxDrain();
  return { ...result, wait: projectRegisteredWait(result.wait as Record<string, unknown>) };
}
const localOutboxDrains = new Set<string>();
export function drainLocalOwnerOutboxes(): Promise<void> { uiDrainRequested = true; return ownerDrain.flush(); }

async function drainLocalOwnerOutbox(): Promise<boolean> {
  const root = getSessionWaitStateRoot(); const channel = getSessionWaitChannel();
  if (!existsSync(core.stateFile(root, channel))) return false;
  // Drain durably accepted lifecycle input before projecting pending owner work.
  // A live lock throws to the scheduler, which retains one bounded retry timer.
  core.drainRuntimeEvents(root, channel);
  // A retry timer for unrelated ordinary work is not a UI notification event.
  const includeQueuedUi = uiDrainRequested; uiDrainRequested = false;
  let status: Record<string, unknown>;
  try { status = core.getStatus(root, channel) as Record<string, unknown>; } catch { return false; }
  const localDeviceId = localDeviceIdentity(readActivityConfig(), new Date().toISOString()).id;
  const outbox = Array.isArray(status.outbox) ? status.outbox as Array<Record<string, unknown>> : [];
  let retry = false;
  for (const item of outbox) {
    const recipient = item.recipient && typeof item.recipient === "object" ? item.recipient as Record<string, unknown> : null;
    if (!recipient || recipient.deviceId !== localDeviceId || !["pending", "retrying", ...(item.condition === "ui_request" && includeQueuedUi ? ["queued"] : [])].includes(String(item.status))) continue;
    const observedUi = item.uiRequest as { identity?: SessionIdentity } | undefined;
    if (observedUi?.identity && observedUi.identity.deviceId !== localDeviceId && !remoteUiSnapshot(observedUi.identity)) continue;
    if (item.nextAttemptAt && Date.parse(String(item.nextAttemptAt)) > Date.now()) { retry = true; continue; }
    const id = String(item.id); if (localOutboxDrains.has(id)) continue; localOutboxDrains.add(id);
    let claim: { claimed?: boolean; claimId?: string; capability?: Record<string, unknown>; reason?: string; terminal?: boolean } | undefined;
    try {
      claim = core.claimOutboxForDelivery(root, channel, id, { localUiRequestDelivery: true }) as NonNullable<typeof claim>;
      if (!claim.claimed || !claim.claimId || !claim.capability) { if (claim.terminal) { try { core.claimOutbox(root, channel, id, "cancelled"); } catch (error) { console.error("[session-wait] terminal outbox cleanup failed:", error); } } continue; }
      const claimId = claim.claimId;
      const payload = claim.capability;
      if (payload.operation === "report_result" && payload.resultEvent && typeof payload.resultEvent === "object") {
        const applied = core.applyEvent(root, channel, payload.resultEvent as Record<string, unknown>) as Record<string, unknown>;
        core.completeOutboxDelivery(root, channel, id, applied.accepted === true ? "processed" : "blocked", claimId, { resultOutcome: applied.outcome ?? applied.reason });
      } else {
        const { queueAuthorizedSessionWake } = await import("./session-control-wake");
        const target = payload.target && typeof payload.target === "object" ? payload.target as Record<string, unknown> : recipient;
        let continuation = payload.continuation && typeof payload.continuation === "object" ? payload.continuation as Record<string, unknown> : null;
        const uiRequest = payload.uiRequest && typeof payload.uiRequest === "object" ? payload.uiRequest as Record<string, unknown> : null;
        const admission: { value?: ReturnType<typeof core.claimedOutboxDeliveryDecision> } = {};
        let beforeSubmit = () => {
          admission.value = core.claimedOutboxDeliveryDecision(root, channel, id, claimId);
          return admission.value.allowed === true;
        };
        if (uiRequest) {
          const identity = uiRequest.identity as SessionIdentity;
          if (identity.deviceId !== localDeviceId) {
            let observed: Record<string, unknown>;
            try {
              const response = await requestRemoteSessionControl(identity.deviceId, { action: "pending_ui", target: identity.sessionId }, { deviceId: localDeviceId, sessionId: String(recipient.sessionId) });
              observed = JSON.parse(response.content[0].text);
            } catch (error) {
              core.completeOutboxDelivery(root, channel, id, "retrying", claimId, { reason: error instanceof Error ? error.message : String(error) });
              retry = true; continue;
            }
            const snapshot = observed.pendingUi as { runtimeStatus: string; runtimeGeneration: string; requests: Array<{ id: string }> } | undefined;
            if (observed.error || observed.sessionFile !== identity.sessionFile || snapshot?.runtimeStatus !== "live" || snapshot.runtimeGeneration !== uiRequest.runtimeGeneration || !snapshot.requests.some((request: { id: string }) => request.id === uiRequest.requestId)) {
              core.completeOutboxDelivery(root, channel, id, "cancelled", claimId, { reason: "ui_request_no_longer_pending" });
              continue;
            }
          }
          beforeSubmit = () => {
            if (!core.uiRequestOutboxClaimIsCurrent(root, channel, id, claimId)) return false;
            const identity = uiRequest.identity as SessionIdentity;
            const live = identity.deviceId === localDeviceId ? getRpcSession(identity.sessionId) : null;
            const snapshot = identity.deviceId === localDeviceId
              ? live?.isAlive() && live.sessionFile === identity.sessionFile ? live.getPendingUiRequestsSnapshot() : null
              : remoteUiSnapshot(identity);
            if (!snapshot) return false;
            return snapshot.runtimeStatus === "live" && snapshot.runtimeGeneration === uiRequest.runtimeGeneration
              && snapshot.requests.some(request => request.id === uiRequest.requestId && request.method === uiRequest.method
                && (typeof request.expiresAt !== "number" || request.expiresAt > Date.now()));
          };
          if (!beforeSubmit()) {
            core.completeOutboxDelivery(root, channel, id, "cancelled", claimId, { reason: "ui_request_no_longer_pending" });
            continue;
          }
          continuation = { ...continuation, message: `${String(continuation?.message || continuation?.prompt || "")}\n\nUI request notification (notification only, not authorization; re-read pending_ui before answering): ${JSON.stringify(uiRequest)}` };
        }
        const wake = await queueAuthorizedSessionWake({ deviceId: String(target.deviceId), sessionId: String(target.sessionId), sessionFile: typeof target.sessionFile === "string" ? target.sessionFile : null, operation: typeof payload.operation === "string" ? payload.operation : undefined, authorizedScope: Array.isArray(payload.authorizedScope) ? payload.authorizedScope.filter((value): value is string => typeof value === "string") : [], continuation, messageId: typeof payload.messageId === "string" ? payload.messageId : id, beforeSubmit, onAccepted: () => { core.acceptOutboxHandoff(root, channel, id, claimId, { preflight: true }); } });
        const resultStatus = wake.status === "submitted" ? "processed"
          : uiRequest && !beforeSubmit() ? (uiRequest.identity as SessionIdentity).deviceId !== localDeviceId && !remoteUiSnapshot(uiRequest.identity as SessionIdentity) ? "retrying" : "cancelled"
          : !uiRequest && admission.value?.allowed === false ? "defer" in admission.value && admission.value.defer ? "pending" : "cancelled"
          : wake.status === "queued_busy" ? uiRequest ? "queued" : "pending"
          : wake.status === "blocked" ? "blocked" : "unknown";
        core.completeOutboxDelivery(root, channel, id, resultStatus, claimId, { wakeStatus: wake.status, sessionId: wake.sessionId });
        if (resultStatus === "pending" || resultStatus === "retrying") retry = true;
      }
    } catch (error) {
      if (!claim?.claimId) retry = true;
      if (claim?.claimId && existsSync(core.stateFile(root, channel))) {
        try { core.completeOutboxDelivery(root, channel, id, "unknown", claim.claimId, { reason: error instanceof Error ? error.message : String(error) }); } catch { /* preserve the original claim when the state is unavailable */ }
        console.error("[session-wait] local owner continuation delivery failed:", error instanceof Error ? error.message : String(error));
      }
    } finally { localOutboxDrains.delete(id); }
  }
  synchronizeRemoteUiWaits();
  return retry;
}

export function initializeSessionWaitRuntime(): void {
  const root = getSessionWaitStateRoot(); const channel = getSessionWaitChannel();
  if (!existsSync(core.stateFile(root, channel))) return;
  try { core.recoverState(root, channel); } catch (error) { console.error("[session-wait] startup recovery failed:", error instanceof Error ? error.message : String(error)); return; }
  synchronizeRemoteUiWaits();
  void drainLocalOwnerOutboxes().catch((error) => console.error("[session-wait] startup owner continuation drain failed:", error instanceof Error ? error.message : String(error)));
}
export function applyPersistentEvent(input: Record<string, unknown>) {
  if (input.type === "ui_request") throw new Error("ui_request is produced only by the live runtime; external reports cannot synthesize popup notifications");
  const result = core.applyEvent(getSessionWaitStateRoot(), getSessionWaitChannel(), input);
  scheduleLocalOwnerOutboxDrain();
  return result;
}
export function applyPersistedEvent(input: Record<string, unknown>) { return applyPersistentEvent(input); }
export function transitionPersistentWait(waitId: string, action: "pause" | "cancel" | "resume", reason?: string, actor?: SessionIdentity) {
  const result = core.transitionWait(getSessionWaitStateRoot(), getSessionWaitChannel(), waitId, action, reason, actor); synchronizeRemoteUiWaits(); if (action === "resume") scheduleLocalOwnerOutboxDrain(); return { ...projectRegisteredWait(result), controlEffect: "future_continuations_only", targetStopped: false };
}
export function readPersistentWaitStatus(filter: Record<string, unknown> = {}) {
  const root = getSessionWaitStateRoot(); const channel = getSessionWaitChannel();
  const status = core.getStatus(root, channel, filter) as Record<string, unknown>;
  status.peers = core.listPeerPins(root, channel);
  const healthFile = process.env.PI_WEB_SESSION_WAIT_HEALTH_FILE?.trim() || join(root, `worker-${channel}.health.json`);
  try { status.worker = { ...(status.worker as Record<string, unknown>), healthFile, health: JSON.parse(readFileSync(healthFile, "utf8")) }; }
  catch { status.worker = { ...(status.worker as Record<string, unknown>), healthFile, health: { status: "blocked", reason: "health file missing" } }; }
  const localDeviceId = localDeviceIdentity(readActivityConfig(), new Date().toISOString()).id;
  const worker = status.worker as Record<string, unknown>;
  const healthy = workerHealth(worker.health).status === "healthy";
  const tasks = core.listExternalTasks(root, channel);
  const outbox = Array.isArray(status.outbox) ? status.outbox as Array<Record<string, unknown>> : [];
  status.waits = (status.waits as Array<Record<string, unknown>>).map(wait => {
    const target = wait.target as SessionIdentity;
    const remote = target.deviceId !== localDeviceId;
    const pins = status.peers as Array<Record<string, unknown>>;
    const pin = pins.find(pin => pin.deviceId === target.deviceId);
    const plan = wait.planId ? (status.plans as Array<Record<string, unknown>>).find(plan => plan.id === wait.planId) : undefined;
    const nodes = Array.isArray(plan?.nodes) ? plan.nodes as Array<Record<string, unknown>> : [];
    const node = nodes.find(node => node.id === plan?.currentNodeId);
    const scopes = Array.isArray(node?.scope) ? node.scope : ["resume_prior_work"];
    const peer = !remote || wait.condition === "ui_request" ? undefined : !wait.planId ? observeWaitCapability(target.deviceId, target.sessionId)
      : { allowed: Boolean(pin && !pin.revokedAt && Array.isArray(pin.sessions) && pin.sessions.includes(target.sessionId) && Array.isArray(pin.operations) && pin.operations.includes("wake") && Array.isArray(pin.scopes) && scopes.every(scope => (pin.scopes as unknown[]).includes(scope)) && typeof pin.peerUrl === "string" && core.sameOrigin(pin.peerUrl, core.resolveConfiguredPeerUrl(target.deviceId) ?? "")), reason: "handoff_peer_not_authorized_or_configured" };
    const readiness = waitReadiness(wait as { status?: unknown; condition?: unknown; target?: { deviceId?: unknown } }, { localDeviceId, workerHealthy: healthy, externalTask: tasks.some(task => task.waitId === wait.id && !["completed", "failed"].includes(String(task.status))), peerReason: peer?.allowed === false ? peer.reason : undefined, unknownDelivery: outbox.some(item => item.waitId === wait.id && item.status === "unknown") });
    if (wait.condition === "ui_request" && !["completed", "failed", "cancelled"].includes(String(wait.status))) {
      const live = !remote ? getRpcSession(target.sessionId) : null;
      const snapshot = remote ? remoteUiSnapshot(target) : live?.isAlive() ? live.getPendingUiRequestsSnapshot() : null;
      let reason = !snapshot || snapshot.runtimeStatus !== "live" ? remote ? "remote_ui_unavailable" : "runtime_not_live"
        : (remote ? (snapshot as { sessionFile?: string }).sessionFile : live?.sessionFile) !== target.sessionFile ? "runtime_session_file_mismatch"
        : snapshot.runtimeGeneration !== wait.runtimeGeneration ? "runtime_replaced" : null;
      if (remote) { try { trustedSessionPeer(target.deviceId); } catch { reason = "remote_ui_unavailable"; } }
      if (reason) Object.assign(readiness, { status: "blocked", reason, nextAction: "renew_ui_wait" });
    }
    return { ...wait, registered: true, readiness, continuationStatus: outbox.find(item => item.waitId === wait.id && !["cancelled", "processed"].includes(String(item.status)))?.status ?? null, evidenceSource: (wait.lastResult as Record<string, unknown> | undefined)?.evidenceSource ?? "unspecified" };
  });
  return status;
}
function projectRegisteredWait(wait: Record<string, unknown>): Record<string, unknown> {
  const status = readPersistentWaitStatus({ waitId: wait.id });
  return (status.waits as Array<Record<string, unknown>>)[0] ?? wait;
}
export function claimPersistentOutbox(id: string, status: "in_flight" | "accepted" | "queued" | "unknown" | "processed" | "blocked" | "retrying" | "cancelled" = "accepted") {
  return core.claimOutbox(getSessionWaitStateRoot(), getSessionWaitChannel(), id, status);
}
export function recoverPersistentWaitState() {
  return core.recoverState(getSessionWaitStateRoot(), getSessionWaitChannel());
}
export function enqueueStructuredExternalTask(input: Record<string, unknown>) {
  return core.enqueueExternalTask(getSessionWaitStateRoot(), getSessionWaitChannel(), input);
}
export function listStructuredExternalTasks() {
  return core.listExternalTasks(getSessionWaitStateRoot(), getSessionWaitChannel());
}
export function recordStructuredExternalTaskResult(taskId: string, patch: Record<string, unknown>) {
  return core.updateExternalTask(getSessionWaitStateRoot(), getSessionWaitChannel(), taskId, patch);
}

/**
 * Persist wait semantics, not token/tool deltas. Safe lifecycle boundaries also
 * wake the coalesced owner drain; busy recipients have a bounded timer retry.
 * Only explicit result producers can assert task or acceptance success.
 */
export function persistSessionWaitEvent(event: {
  type: string;
  sessionId: string;
  runId?: string | null;
  sessionFile?: string | null;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
}): void {
  const mapped = event.type === "agent_settled"
    ? "turn_settled"
    : event.type === "prompt_error"
      ? "task_failed"
      : null;
  const drainBoundary = ["agent_end", "prompt_done", "compaction_end", "auto_compaction_end"].includes(event.type);
  if (!mapped && !drainBoundary) return;
  if (!existsSync(core.stateFile(getSessionWaitStateRoot(), getSessionWaitChannel()))) return;
  if (!mapped) { scheduleLocalOwnerOutboxDrain(); return; }
  try {
    core.runtimeEvent(getSessionWaitStateRoot(), getSessionWaitChannel(), {
      id: event.runId ? core.sha256({ sessionId: event.sessionId, runId: event.runId, type: mapped }) : core.randomId("rpc-wait-"),
      type: mapped,
      identity: localWaitIdentity(event.sessionId, event.sessionFile),
      ...(event.runId ? { taskId: event.runId } : {}),
      ...(mapped === "task_failed" ? { reason: event.errorMessage || "Reader prompt error" } : {}),
      summary: event.toolName ? `${event.type}:${event.toolName}` : event.type,
      source: "rpc-manager",
    });
    scheduleLocalOwnerOutboxDrain();
  } catch (error) {
    console.error("[session-wait] lifecycle event persistence failed:", error instanceof Error ? error.message : String(error));
  }
}

export type SessionUiRequestEvent = {
  sessionId: string;
  sessionFile: string;
  runtimeGeneration: string;
  requestId: string;
  method: string;
  summary: string;
  waitId?: string;
};

/** Publish a native question, or replay the current snapshot to one new wait.
 * Targeted replay has its own durable ID so a previously observed request does
 * not disappear behind global event deduplication. Never use report_result.
 */
export function persistSessionUiRequestEvent(input: SessionUiRequestEvent) {
  const { sessionId, sessionFile, runtimeGeneration, requestId, method, summary, waitId } = input;
  const root = getSessionWaitStateRoot(); const channel = getSessionWaitChannel();
  if (!existsSync(core.stateFile(root, channel))) return { skipped: true, reason: "state_not_initialized" };
  const identity = localWaitIdentity(sessionId, sessionFile);
  const current = core.readState(root, channel);
  const subscriptions = Object.values(current.waits).filter(value => {
    const wait = value as Record<string, unknown>; const target = wait.target as SessionIdentity;
    return (!waitId || wait.id === waitId) && wait.condition === "ui_request" && ["waiting", "running", "retrying"].includes(String(wait.status))
      && target.deviceId === identity.deviceId && target.sessionId === sessionId;
  });
  if (!subscriptions.length) return { skipped: true, reason: "no_matching_ui_wait" };
  if (!sessionFile) throw new Error("ui_request identity.sessionFile is required for an active subscription");
  if (!subscriptions.some(value => (value as { target: SessionIdentity }).target.sessionFile === sessionFile)) return { skipped: true, reason: "ui_request_session_file_mismatch" };
  // Capture exact obsolete IDs now: a delayed old publication must never
  // invalidate a subscription registered later for a newer runtime.
  const supersededWaitIds = subscriptions.filter(value => {
    const wait = value as { id: string; target: SessionIdentity; runtimeGeneration: string };
    return wait.target.sessionFile === sessionFile && wait.runtimeGeneration !== runtimeGeneration;
  }).map(value => (value as { id: string }).id);
  const result = core.runtimeEvent(root, channel, {
    id: core.sha256({ type: "ui_request", sessionId, runtimeGeneration, requestId, ...(waitId ? { waitId } : {}) }),
    type: "ui_request", identity: localWaitIdentity(sessionId, sessionFile), runtimeGeneration, requestId, method, summary,
    source: "rpc-manager", ...(waitId ? { waitId } : {}), ...(supersededWaitIds.length ? { supersededWaitIds } : {}),
  });
  scheduleLocalOwnerOutboxDrain();
  return result;
}

/** A closed wrapper cannot carry a subscription into a restored runtime. */
export function invalidateSessionUiRequestWaits(input: {
  sessionId: string; sessionFile: string; runtimeGeneration: string; reason: "runtime_closed" | "runtime_replaced";
}) {
  const root = getSessionWaitStateRoot(); const channel = getSessionWaitChannel();
  if (!existsSync(core.stateFile(root, channel))) return { skipped: true, reason: "state_not_initialized" };
  const state = core.readState(root, channel);
  const matching = Object.values(state.waits).some(value => {
    const wait = value as { condition: string; target: SessionIdentity; runtimeGeneration: string };
    return wait.condition === "ui_request" && wait.target.sessionId === input.sessionId
      && (input.reason === "runtime_closed" ? wait.runtimeGeneration === input.runtimeGeneration : wait.runtimeGeneration !== input.runtimeGeneration);
  });
  if (!matching) return { skipped: true, reason: "no_matching_ui_wait" };
  return core.invalidateUiRequestWaits(root, channel, { identity: localWaitIdentity(input.sessionId, input.sessionFile), runtimeGeneration: input.runtimeGeneration, reason: input.reason });
}

export function projectWaitStatus(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  return value;
}
