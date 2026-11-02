import { createRequire } from "node:module";
import { getSessionWaitChannel, getSessionWaitStateRoot, localWaitIdentity } from "./session-waits";
import { SESSION_PEER_CUSTOM_TYPE } from "./session-peer-message.ts";
const require = createRequire(import.meta.url);
const core = require("../bin/session-wait-core.cjs") as typeof import("../bin/session-wait-core.cjs");

type WakeDrainSession = { sessionId?: string; sessionFile?: string | null; isRunning?: () => boolean; inner?: { isBashRunning?: boolean; isCompacting?: boolean }; hasPendingUserInteraction?: () => boolean; sendNativePeerMessage?: (message: { customType: typeof SESSION_PEER_CUSTOM_TYPE; content: string; display: boolean; details: { source: "session-control-wake"; messageId: string; [key: string]: unknown } }, options?: { triggerTurn?: boolean; beforeSubmit?: () => boolean }) => Promise<unknown> };
export async function drainPendingSessionWakes(sessionId: string, session: WakeDrainSession) {
  const root = getSessionWaitStateRoot(); const channel = getSessionWaitChannel();
  let pending: Array<Record<string, unknown>>;
  try { pending = core.listPendingInboxes(root, channel, sessionId); } catch (error) { return { status: "blocked", reason: error instanceof Error ? error.message : String(error), processed: 0 }; }
  let processed = 0;
  const deviceId = localWaitIdentity(sessionId, session.sessionFile).deviceId;
  for (const receipt of pending) {
    if (session.isRunning?.() || session.inner?.isBashRunning || session.inner?.isCompacting || session.hasPendingUserInteraction?.()) break;
    const messageId = String(receipt.messageId);
    const claim = core.claimInboxForDelivery(root, channel, messageId, sessionId, session.sessionFile, deviceId) as { claimed?: boolean; claimId?: string; reason?: string; terminal?: boolean; receipt?: Record<string, unknown> };
    if (!claim.claimed || !claim.claimId) continue;
    const body = claim.receipt?.body && typeof claim.receipt.body === "object" ? claim.receipt.body as Record<string, unknown> : {};
    const continuation = body.continuation && typeof body.continuation === "object" ? body.continuation as { message?: unknown; prompt?: unknown } : null;
    if (typeof continuation?.message !== "string" && typeof continuation?.prompt !== "string") { core.completeInbox(root, channel, messageId, "blocked", { reason: "missing persisted continuation" }, claim.claimId); continue; }
    const admission: { value?: ReturnType<typeof core.claimedInboxWakeDecision> } = {};
    const beforeSubmit = () => { admission.value = core.claimedInboxWakeDecision(root, channel, messageId, sessionId, session.sessionFile, deviceId, claim.claimId); return admission.value.allowed === true; };
    try {
      if (typeof session.sendNativePeerMessage !== "function") throw new Error("native peer delivery unavailable");
      const continuationMessage = String(continuation.message ?? continuation.prompt);
      const authorizedScope = Array.isArray(body.authorizedScope)
        ? body.authorizedScope.filter((value): value is string => typeof value === "string")
        : ["resume_prior_work"];
      await session.sendNativePeerMessage({
        customType: SESSION_PEER_CUSTOM_TYPE,
        content: continuationMessage,
        display: true,
        details: {
          source: "session-control-wake",
          messageId,
          operation: "resume_prior_authorized_work",
          sessionId,
          sessionFile: session.sessionFile || null,
          authorizedScope,
          target: { deviceId, sessionId, sessionFile: session.sessionFile },
        },
      }, { triggerTurn: true, beforeSubmit });
      core.completeInbox(root, channel, messageId, "processed", { submitted: true, sessionId }, claim.claimId);
      processed += 1;
    } catch (error) {
      const status = admission.value?.allowed === false ? admission.value.defer ? "queued" : "blocked" : "unknown";
      core.completeInbox(root, channel, messageId, status, { reason: admission.value?.allowed === false ? admission.value.reason : error instanceof Error ? error.message : String(error) }, claim.claimId);
    }
  }
  return { status: pending.length === processed ? "processed" : processed ? "partial" : "queued", processed, pending: pending.length };
}
