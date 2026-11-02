import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { acceptSessionControlEnvelope } from "@/lib/session-control-auth";
import { localDeviceIdentity, readActivityConfig } from "@/lib/activity-peers";
import { applyPersistentEvent, getSessionWaitChannel, getSessionWaitStateRoot } from "@/lib/session-waits";
import { createRequire } from "node:module";
import { queueAuthorizedSessionWake } from "@/lib/session-control-wake";
const require = createRequire(import.meta.url);
const core = require("../../../../bin/session-wait-core.cjs") as typeof import("../../../../bin/session-wait-core.cjs");
export const dynamic = "force-dynamic";
function blocked(reason: string, status = 403) { return NextResponse.json({ accepted: false, status: "blocked", reason }, { status }); }
function preflightEnvelope(envelope: Record<string, unknown>, localId: string): void {
  const operation = typeof envelope.operation === "string" ? envelope.operation : ""; const sender = envelope.sender && typeof envelope.sender === "object" ? envelope.sender as Record<string, unknown> : null; const body = envelope.body && typeof envelope.body === "object" ? envelope.body as Record<string, unknown> : {};
  if (!sender || typeof sender.deviceId !== "string" || typeof sender.sessionId !== "string") throw new Error("sender identity is required");
  if (operation === "pull_messages") return;
  if (operation === "receipt_query") { if (typeof body.messageId !== "string") throw new Error("receipt query messageId is required"); return; }
  if (operation === "receipt") { const receipt = body.receipt && typeof body.receipt === "object" ? body.receipt as Record<string, unknown> : body; if (typeof receipt.messageId !== "string" || typeof receipt.status !== "string") throw new Error("receipt binding is required"); return; }
  const target = body.target && typeof body.target === "object" ? body.target as Record<string, unknown> : null;
  const event = body.event && typeof body.event === "object" ? body.event as Record<string, unknown> : null;
  if (event) {
    const identity = event.identity && typeof event.identity === "object" ? event.identity as Record<string, unknown> : null;
    if (!identity || identity.deviceId !== sender.deviceId || identity.sessionId !== sender.sessionId || !target || target.deviceId !== sender.deviceId || target.sessionId !== sender.sessionId) throw new Error("event actor/target must match signed sender");
    if (identity.sessionFile && sender.sessionFile && identity.sessionFile !== sender.sessionFile) throw new Error("event session file must match signed sender");
    if (envelope.generation !== undefined && event.generation !== undefined && envelope.generation !== event.generation) throw new Error("generation mismatch");
    if (envelope.round !== undefined && event.round !== undefined && envelope.round !== event.round) throw new Error("round mismatch");
    return;
  }
  if (!target || target.deviceId !== localId || typeof target.sessionId !== "string") throw new Error("wake target must match local recipient");
  if (operation === "observe_wait") {
    const owner = body.owner && typeof body.owner === "object" ? body.owner as Record<string, unknown> : null;
    if (!Array.isArray(envelope.scope) || !envelope.scope.includes("observe_wait")) throw new Error("observe_wait scope is not authorized");
    if (typeof body.waitId !== "string" || !body.waitId.trim()) throw new Error("observe_wait waitId is required");
    if (!owner || typeof owner.deviceId !== "string" || typeof owner.sessionId !== "string" || !owner.deviceId || !owner.sessionId) throw new Error("observe_wait owner identity is required");
    if (!target || target.deviceId !== localId || typeof target.sessionId !== "string" || !target.sessionId) throw new Error("observe_wait target identity is required");
    if (body.continuation !== undefined) throw new Error("observe_wait cannot carry an executable continuation");
    return;
  }
  if (operation !== "wake" || body.operation !== "resume_prior_authorized_work") throw new Error("unsupported wake operation");
  const continuation = body.continuation && typeof body.continuation === "object" ? body.continuation as Record<string, unknown> : null; const continuationTarget = continuation?.target && typeof continuation.target === "object" ? continuation.target as Record<string, unknown> : null;
  if (!continuationTarget || continuationTarget.deviceId !== target.deviceId || continuationTarget.sessionId !== target.sessionId || (continuationTarget.sessionFile && target.sessionFile && continuationTarget.sessionFile !== target.sessionFile)) throw new Error("continuation target must match wake target");
  if (!Array.isArray(body.authorizedScope) || !body.authorizedScope.includes("resume_prior_work")) throw new Error("wake scope is not authorized");
}
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return blocked("untrusted_api_request");
  if (!hasJsonContentType(request)) return blocked("content_type_required", 415);
  try {
    const envelope = await request.json() as Record<string, unknown>;
    const operation = typeof envelope.operation === "string" ? envelope.operation : "";
    if (!["wake", "pull_messages", "report_result", "observe_wait", "receipt", "receipt_query"].includes(operation)) return blocked("operation_denied");
    const localId = localDeviceIdentity(readActivityConfig(), new Date().toISOString()).id;
    preflightEnvelope(envelope, localId);
    const result = acceptSessionControlEnvelope(getSessionWaitStateRoot(), getSessionWaitChannel(), envelope, { recipient: localId, requirePersistentPin: true });
    if (!result.accepted) return blocked(result.reason || "peer_message_rejected");
    const messageId = typeof envelope.messageId === "string" ? envelope.messageId : "";
    const receipt = result.receipt as Record<string, unknown> | undefined;
    if (result.duplicate) {
      const status = receipt?.status === "processed" ? "processed" : receipt?.status === "queued" ? "queued" : receipt?.status === "blocked" ? "blocked" : "unknown";
      return NextResponse.json({ accepted: true, duplicate: true, status, receipt });
    }
    if (operation === "observe_wait") {
      core.completeInbox(getSessionWaitStateRoot(), getSessionWaitChannel(), messageId, "processed", { observation: true, target: (envelope.body as Record<string, unknown>)?.target });
      return NextResponse.json({ accepted: true, duplicate: false, status: "processed", receipt, observation: true });
    }
    if (operation === "pull_messages") {
      const root = getSessionWaitStateRoot(); const channel = getSessionWaitChannel(); core.completeInbox(root, channel, messageId, "in_flight");
      const peerId = (envelope.sender as { deviceId?: string })?.deviceId || ""; const outbox: Array<Record<string, unknown>> = [];
      for (const candidate of core.listOutboxForPeer(root, channel, peerId) as Array<Record<string, unknown>>) {
        const claimed = core.claimOutboxForPull(root, channel, String(candidate.id), peerId, messageId) as { claimed?: boolean; item?: Record<string, unknown>; capability?: Record<string, unknown> };
        if (claimed.claimed && claimed.item && claimed.capability) outbox.push({ ...claimed.item, pullMessageId: claimed.item.pullMessageId, pullDigest: (claimed.item.capability as Record<string, unknown>).digest, capability: claimed.item.capability });
      }
      core.completeInbox(root, channel, messageId, "processed", { outboxCount: outbox.length }); return NextResponse.json({ accepted: true, duplicate: false, status: "accepted", receipt, pullMessageId: messageId, outbox });
    }
    const body = envelope.body && typeof envelope.body === "object" ? envelope.body as Record<string, unknown> : {};
    if (operation === "receipt_query") {
      const targetMessageId = typeof body.messageId === "string" ? body.messageId : ""; const senderDevice = (envelope.sender as Record<string, unknown>)?.deviceId; const state = core.readState(getSessionWaitStateRoot(), getSessionWaitChannel()); const target = state.inbox[targetMessageId];
      if (target && target.sender?.deviceId === senderDevice) { const status = ["processed", "queued", "blocked", "unknown"].includes(target.status) ? target.status : "unknown"; return NextResponse.json({ accepted: true, duplicate: false, status, receipt, targetReceipt: target }); }
      const outbox = (Object.values(state.outbox) as Array<Record<string, unknown>>).find((candidate) => { const recipient = candidate.recipient as Record<string, unknown> | undefined; const capability = candidate.capability as Record<string, unknown> | undefined; return candidate.messageId === targetMessageId && (!body.outboxId || candidate.id === body.outboxId) && recipient?.deviceId === senderDevice && (!body.capabilityDigest || capability?.digest === body.capabilityDigest); });
      if (outbox) { const outboxStatus = typeof outbox.status === "string" ? outbox.status : "unknown"; const status = ["processed", "queued", "blocked", "unknown", "accepted", "in_flight"].includes(outboxStatus) ? outboxStatus : "unknown"; const capability = outbox.capability as Record<string, unknown> | undefined; return NextResponse.json({ accepted: true, duplicate: false, status, receipt, targetReceipt: { id: outbox.id, messageId: outbox.messageId, status, capabilityDigest: capability?.digest } }); }
      const pull = (Object.values(state.pullReceipts) as Array<Record<string, unknown>>).find((candidate) => candidate.sourceMessageId === targetMessageId && candidate.peerId === senderDevice && (!body.outboxId || candidate.itemId === body.outboxId));
      if (pull) return NextResponse.json({ accepted: true, duplicate: false, status: typeof pull.status === "string" ? pull.status : "unknown", receipt, targetReceipt: pull });
      return NextResponse.json({ accepted: true, duplicate: false, status: "unknown", receipt });
    }
    if (operation === "receipt") {
      core.completeInbox(getSessionWaitStateRoot(), getSessionWaitChannel(), messageId, "in_flight"); const receiptBody = body.receipt && typeof body.receipt === "object" ? body.receipt as Record<string, unknown> : body;
      const applied = core.applyPeerReceipt(getSessionWaitStateRoot(), getSessionWaitChannel(), { messageId: receiptBody.messageId, outboxId: receiptBody.outboxId, status: receiptBody.status, sender: envelope.sender, details: { sender: envelope.sender, pullMessageId: receiptBody.pullMessageId, pullDigest: receiptBody.pullDigest }, reason: receiptBody.reason });
      core.completeInbox(getSessionWaitStateRoot(), getSessionWaitChannel(), messageId, "processed", { outboxId: applied.id, receiptStatus: applied.status });
      return NextResponse.json({ accepted: true, duplicate: false, status: "processed", receipt, outbox: applied });
    }
    const target = body.target && typeof body.target === "object" ? body.target as Record<string, unknown> : null;
    if (operation === "report_result" || (operation === "wake" && body.event)) {
      const event = body.event && typeof body.event === "object" ? body.event as Record<string, unknown> : null;
      const identity = event?.identity && typeof event.identity === "object" ? event.identity as Record<string, unknown> : null;
      const sender = envelope.sender as Record<string, unknown>;
      if (!event || !identity || identity.deviceId !== sender.deviceId || identity.sessionId !== sender.sessionId || (identity.sessionFile && sender.sessionFile && identity.sessionFile !== sender.sessionFile)) return blocked("event_identity_does_not_match_signed_sender", 403);
      if (operation === "wake" && (!Array.isArray(envelope.scope) || !(envelope.scope as unknown[]).includes("resume_prior_work"))) return blocked("scope_denied");
      if (operation === "report_result" && (!Array.isArray(envelope.scope) || !(envelope.scope as unknown[]).includes("report_result"))) return blocked("scope_denied");
      if (!target || target.deviceId !== sender.deviceId || target.sessionId !== sender.sessionId || (target.sessionFile && identity.sessionFile && target.sessionFile !== identity.sessionFile)) return blocked("event_target_does_not_match_signed_sender", 403);
      if (envelope.generation !== undefined && event.generation !== undefined && envelope.generation !== event.generation) return blocked("generation_mismatch", 422);
      if (envelope.round !== undefined && event.round !== undefined && envelope.round !== event.round) return blocked("round_mismatch", 422);
      core.completeInbox(getSessionWaitStateRoot(), getSessionWaitChannel(), messageId, "in_flight"); const applied = applyPersistentEvent(event);
      const appliedRecord = applied as Record<string, unknown>; const accepted = appliedRecord.accepted === true; const pending = appliedRecord.pending === true;
      core.completeInbox(getSessionWaitStateRoot(), getSessionWaitChannel(), messageId, accepted ? "processed" : pending ? "queued" : "blocked", { eventOutcome: accepted ? "accepted" : pending ? "pending_handoff" : "ignored" });
      return NextResponse.json({ accepted: true, duplicate: false, status: accepted ? "processed" : pending ? "queued" : "blocked", receipt, event: applied });
    }
    if (!target || target.deviceId !== localId || typeof target.sessionId !== "string") return blocked("wake_target_mismatch", 422);
    if (typeof body.operation !== "string" || body.operation !== "resume_prior_authorized_work") return blocked("unsupported_wake_operation", 422);
    const continuation = body.continuation && typeof body.continuation === "object" ? body.continuation as Record<string, unknown> : null;
    if (!continuation || !continuation.target || typeof continuation.target !== "object") return blocked("continuation_target_required", 422);
    const root = getSessionWaitStateRoot(), channel = getSessionWaitChannel();
    const claim = core.claimInboxForDelivery(root, channel, messageId, target.sessionId, typeof target.sessionFile === "string" ? target.sessionFile : null, localId, "accepted");
    if (!claim.claimed || !claim.claimId) {
      const state = core.readState(root, channel) as { inbox?: Record<string, { status?: string; reason?: string }> };
      const current = state.inbox?.[messageId];
      if (current?.status === "blocked" || current?.status === "cancelled") return blocked(current.reason || claim.reason || "wake_blocked", 422);
      return NextResponse.json({ accepted: true, duplicate: false, status: current?.status === "queued" ? "queued" : "unknown", receipt: current || receipt });
    }
    const claimId = claim.claimId;
    const admission: { value?: ReturnType<typeof core.claimedInboxWakeDecision> } = {};
    const beforeSubmit = () => { admission.value = core.claimedInboxWakeDecision(root, channel, messageId, String(target.sessionId), typeof target.sessionFile === "string" ? target.sessionFile : null, localId, claimId); return admission.value.allowed === true; };
    const wake = await queueAuthorizedSessionWake({ deviceId: target.deviceId, sessionId: target.sessionId, sessionFile: typeof target.sessionFile === "string" ? target.sessionFile : null, operation: body.operation, authorizedScope: Array.isArray(body.authorizedScope) ? body.authorizedScope.filter((value): value is string => typeof value === "string") : [], continuation, messageId, beforeSubmit });
    const receiptStatus = admission.value?.allowed === false ? admission.value.defer ? "queued" : "blocked" : wake.status === "queued_busy" ? "queued" : wake.status === "unknown" ? "unknown" : wake.status === "blocked" ? "blocked" : "processed";
    const reason = admission.value?.allowed === false ? admission.value.reason : wake.reason;
    const completed = core.completeInbox(root, channel, messageId, receiptStatus, { wakeStatus: wake.status, sessionId: wake.sessionId, resumed: (wake as { resumed?: unknown }).resumed === true, ...(reason ? { reason } : {}) }, claimId);
    if (completed.applied !== true) return NextResponse.json({ accepted: true, duplicate: false, status: "unknown", receipt: completed.receipt, wake });
    if (receiptStatus === "blocked") return blocked(reason || "wake_blocked", 422);
    return NextResponse.json({ accepted: true, duplicate: false, status: receiptStatus, receipt, wake });
  } catch (error) { return blocked(error instanceof Error ? error.message : String(error), 400); }
}
