import { localDeviceId } from "./activity-peers";
import { LIVE_EVENT_BOOT_ID } from "./live-agent-events";
import { controlRequestFingerprint, listMutationControlReceipts, readControlReceipt, reserveControlReceipt, updateControlReceipt, type ReaderControlReceipt } from "./reader-control-receipts";
import type { SessionMutationIdentity, SessionMutationRecoveryPage } from "./session-mutation-recovery";
import { unknownSessionMutation, type SessionMutationCommand, type SessionMutationReceipt } from "./session-mutation-command";

const OPERATION = "session_mutation";
function projection(command: Pick<SessionMutationCommand, "operationId" | "deviceId" | "sessionId">, receipt: ReaderControlReceipt): SessionMutationReceipt {
  const stale = ["accepted", "running"].includes(receipt.outcome) && receipt.bootId !== LIVE_EVENT_BOOT_ID;
  const response = receipt.response as { httpStatus?: number } | undefined;
  return { operationId: command.operationId, deviceId: command.deviceId, sessionId: command.sessionId,
    status: stale || receipt.outcome === "aborted" ? "unknown" : receipt.outcome,
    ...(response?.httpStatus ? { httpStatus: response.httpStatus } : {}),
    ...(receipt.error ? { error: receipt.error.message } : {}) };
}

export async function querySessionMutation(command: Pick<SessionMutationCommand, "operationId" | "deviceId" | "sessionId">): Promise<SessionMutationReceipt> {
  if (command.deviceId !== localDeviceId()) return { ...unknownSessionMutation(command), status: "conflict", error: "Wrong target device" };
  const receipt = await readControlReceipt({ deviceId: command.deviceId, sessionId: command.sessionId,
    operation: OPERATION, idempotencyKey: command.operationId });
  if (!receipt) return { ...unknownSessionMutation(command), status: "not_found" };
  return projection(command, receipt);
}

/** Reservation is persisted before invoking the existing business handler. */
export async function executeSessionMutation(command: SessionMutationCommand, execute: () => Promise<Response>): Promise<SessionMutationReceipt> {
  if (command.deviceId !== localDeviceId()) return { ...unknownSessionMutation(command), status: "conflict", error: "Wrong target device" };
  const reservation = await reserveControlReceipt({ deviceId: command.deviceId, sessionId: command.sessionId,
    operation: OPERATION, idempotencyKey: command.operationId, requestFingerprint: controlRequestFingerprint(command),
    cwd: "session-mutation", bootId: LIVE_EVENT_BOOT_ID, mutationCommand: command });
  if (reservation.conflict) return { ...unknownSessionMutation(command), status: "conflict", error: "Operation id already belongs to another request" };
  if (reservation.replayed) return projection(command, reservation.receipt);
  const receiptId = reservation.receipt.receiptId;
  try {
    const running = await updateControlReceipt(receiptId, { outcome: "running", startedAt: new Date().toISOString() });
    if (!running || running.outcome !== "running") return unknownSessionMutation(command);
    const result = await execute();
    // A handler can fail after partial effects. Preserve uncertainty for 5xx.
    const outcome = result.ok ? "completed" : result.status >= 500 ? "unknown" : "failed";
    const receipt = await updateControlReceipt(receiptId, { outcome, completedAt: new Date().toISOString(), response: { httpStatus: result.status },
      ...(result.ok ? {} : { error: { code: "session_mutation_rejected", message: `Session mutation returned HTTP ${result.status}` } }) });
    return receipt ? projection(command, receipt) : unknownSessionMutation(command);
  } catch {
    try { await updateControlReceipt(receiptId, { outcome: "unknown", error: { code: "session_mutation_unknown", message: "Inspect the existing operation before trying another mutation" } }); } catch { /* Reservation still prevents another execution. */ }
    return unknownSessionMutation(command, "The operation result has not been confirmed");
  }
}

/** Recovery is scoped to the device, not to a still-existing session row. */
export async function listSessionMutations(after = ""): Promise<SessionMutationRecoveryPage> {
  const receipts = await listMutationControlReceipts(localDeviceId(), after);
  return { operations: receipts.map(receipt => ({ receipt: projection({ operationId: receipt.idempotencyKey,
    deviceId: receipt.deviceId, sessionId: receipt.sessionId }, receipt),
    ...(receipt.mutationCommand ? { command: receipt.mutationCommand } : {}), updatedAt: receipt.updatedAt })),
    ...(receipts.length === 100 ? { nextCursor: receipts[receipts.length - 1].receiptId } : {}) };
}

/** Acknowledgement hides recovery UI only. The original fact and anti-replay
 * identity remain durable, including when the user manually reviewed unknown. */
export async function acknowledgeSessionMutation(identity: SessionMutationIdentity, reviewedUnknown: boolean): Promise<boolean> {
  if (identity.deviceId !== localDeviceId()) return false;
  const receipt = await readControlReceipt({ deviceId: identity.deviceId, sessionId: identity.sessionId,
    operation: OPERATION, idempotencyKey: identity.operationId });
  if (!receipt) return false;
  const status = projection(identity, receipt).status;
  if (["accepted", "running"].includes(status) || (status === "unknown" && !reviewedUnknown)) return false;
  const updated = await updateControlReceipt(receipt.receiptId, { recoveryReviewedAt: new Date().toISOString() });
  return Boolean(updated?.recoveryReviewedAt);
}
