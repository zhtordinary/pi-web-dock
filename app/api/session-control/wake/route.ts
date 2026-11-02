import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { applyPersistedEvent, getSessionWaitChannel, getSessionWaitStateRoot } from "@/lib/session-waits";
import { queueAuthorizedSessionWake } from "@/lib/session-control-wake";
import { localDeviceIdentity, readActivityConfig } from "@/lib/activity-peers";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const core = require("../../../../bin/session-wait-core.cjs") as typeof import("../../../../bin/session-wait-core.cjs");
export const dynamic = "force-dynamic";

/** Dispatch one authenticated wake payload to the addressed Reader session. */
async function dispatchPayload(payload: Record<string, unknown>, target: Record<string, unknown>, beforeSubmit?: () => boolean) {
  const continuation = payload.continuation && typeof payload.continuation === "object" ? payload.continuation as Record<string, unknown> : null;
  const wake = await queueAuthorizedSessionWake({ deviceId: String(target.deviceId), sessionId: String(target.sessionId), sessionFile: typeof target.sessionFile === "string" ? target.sessionFile : null, operation: typeof payload.operation === "string" ? payload.operation : undefined, authorizedScope: Array.isArray(payload.authorizedScope) ? payload.authorizedScope.filter((value): value is string => typeof value === "string") : [], continuation, messageId: typeof payload.messageId === "string" ? payload.messageId : undefined, beforeSubmit });
  return { status: wake.status === "submitted" ? "processed" : wake.status === "queued_busy" ? "pending" : wake.status === "blocked" ? "blocked" : "unknown",
    details: { wakeStatus: wake.status, sessionId: wake.sessionId } };
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const outbox = body.outbox && typeof body.outbox === "object" ? body.outbox as Record<string, unknown> : null;
    const root = getSessionWaitStateRoot(); const channel = getSessionWaitChannel(); const localId = localDeviceIdentity(readActivityConfig(), new Date().toISOString()).id;
    if (outbox && body.local === true) {
      const target = outbox.target && typeof outbox.target === "object" ? outbox.target as Record<string, unknown> : null; if (!target || target.deviceId !== localId) throw new Error("local wake target mismatch");
      if (typeof outbox.id !== "string" || typeof body.claimId !== "string") throw new Error("local wake claim is required");
      const state = core.readState(root, channel); const stored = state.outbox[outbox.id]; if (!stored || stored.status !== "in_flight" || stored.claim?.id !== body.claimId) throw new Error("local wake claim is unknown or stale");
      const capability = core.verifyOutboxCapability(outbox); if (!capability.ok || capability.digest !== stored.capability?.digest) throw new Error("local wake capability is mismatched");
      const payload = capability.payload as Record<string, unknown>; let status: "processed" | "queued" | "pending" | "blocked" | "cancelled" | "unknown"; let details: Record<string, unknown> = {};
      if (payload.operation === "observe_wait") { status = "processed"; details = { observation: true, waitId: payload.waitId, owner: payload.owner };
      } else if (payload.operation === "report_result" && payload.resultEvent && typeof payload.resultEvent === "object") {
        const applied = applyPersistedEvent(payload.resultEvent as Record<string, unknown>) as Record<string, unknown>; status = applied.accepted === true ? "processed" : applied.pending === true ? "queued" : "blocked"; details = { resultOutcome: applied.outcome ?? applied.reason };
      } else {
        const admission: { value?: ReturnType<typeof core.claimedOutboxDeliveryDecision> } = {};
        const beforeSubmit = () => { admission.value = core.claimedOutboxDeliveryDecision(root, channel, String(outbox.id), String(body.claimId)); return admission.value.allowed === true; };
        const dispatched = await dispatchPayload(payload, target, beforeSubmit);
        status = admission.value?.allowed === false ? "defer" in admission.value && admission.value.defer ? "pending" : "cancelled" : dispatched.status as typeof status;
        details = { ...dispatched.details, ...(admission.value?.allowed === false ? { reason: admission.value.reason } : {}) };
      }
      const completed = core.completeOutboxDelivery(root, channel, outbox.id, status, String(body.claimId), details) as Record<string, unknown>;
      return NextResponse.json({ ok: status !== "blocked" && status !== "cancelled", status: status === "pending" ? "queued" : status, outbox: completed });
    }
    if (outbox) {
      const target = outbox.target && typeof outbox.target === "object" ? outbox.target as Record<string, unknown> : outbox.recipient && typeof outbox.recipient === "object" ? outbox.recipient as Record<string, unknown> : null;
      if (!target || typeof target.deviceId !== "string" || typeof target.sessionId !== "string") throw new Error("wake outbox target identity is required");
      const pull = body.pullReceipt && typeof body.pullReceipt === "object" ? body.pullReceipt as Record<string, unknown> : null;
      if (!pull || typeof pull.pullMessageId !== "string" || typeof pull.itemDigest !== "string" || typeof outbox.id !== "string") throw new Error("wake outbox requires a persisted pull receipt capability");
      const capability = core.verifyOutboxCapability(outbox); if (!capability.ok || capability.digest !== pull.itemDigest) throw new Error("wake pull capability is unknown or mismatched");
      const claim = core.claimPullReceipt(root, channel, pull.pullMessageId, outbox.id) as { claimed?: boolean; claimId?: string; capability?: Record<string, unknown>; reason?: string; receipt?: Record<string, unknown> };
      if (!claim.claimed || !claim.claimId || !claim.capability) {
        const receipt = claim.receipt; if (receipt && ["queued", "processed", "blocked", "unknown"].includes(String(receipt.status))) return NextResponse.json({ ok: receipt.status !== "blocked", status: receipt.status, receipt });
        throw new Error(claim.reason || "wake pull receipt is not consumable");
      }
      const payload = claim.capability; let status: "processed" | "queued" | "blocked" | "unknown"; let details: Record<string, unknown> = {};
      try {
        if (payload.operation === "observe_wait") { status = "processed"; details = { observation: true, waitId: payload.waitId, owner: payload.owner };
        } else if (payload.operation === "report_result" && payload.resultEvent && typeof payload.resultEvent === "object") {
          const applied = applyPersistedEvent(payload.resultEvent as Record<string, unknown>) as Record<string, unknown>; status = applied.accepted === true ? "processed" : applied.pending === true ? "queued" : "blocked"; details = { resultOutcome: applied.outcome ?? applied.reason };
        } else {
          const payloadTarget = payload.target && typeof payload.target === "object" ? payload.target as Record<string, unknown> : target;
          const admission: { value?: ReturnType<typeof core.claimedPullReceiptDecision> } = {};
          const beforeSubmit = () => { admission.value = core.claimedPullReceiptDecision(root, channel, String(pull.pullMessageId), String(outbox.id), String(claim.claimId)); return admission.value.allowed === true; };
          const dispatched = await dispatchPayload(payload, payloadTarget, beforeSubmit);
          status = admission.value?.allowed === false ? "defer" in admission.value && admission.value.defer ? "queued" : "blocked" : dispatched.status === "pending" ? "queued" : dispatched.status === "processed" ? "processed" : dispatched.status === "unknown" ? "unknown" : "blocked";
          details = { ...dispatched.details, ...(admission.value?.allowed === false ? { reason: admission.value.reason } : {}) };
        }
      } catch (error) { status = "unknown"; details = { reason: error instanceof Error ? error.message : String(error) }; }
      const completed = core.completePullReceipt(root, channel, pull.pullMessageId, outbox.id, status, details, claim.claimId) as Record<string, unknown>;
      if (completed.applied !== true) return NextResponse.json({ ok: false, status: "unknown", receipt: completed });
      return NextResponse.json({ ok: status !== "blocked", status, receipt: completed });
    }
    throw new Error("wake requires a signed peer envelope or a persisted pull receipt capability");
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
}
