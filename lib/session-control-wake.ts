import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { getRpcSession, startRpcSession } from "./rpc-manager";
import { resolveSessionPath } from "./session-reader";
import { localDeviceIdentity, readActivityConfig } from "./activity-peers";
import { SESSION_PEER_CUSTOM_TYPE, type SessionPeerMessage } from "./session-peer-message.ts";

export type AuthorizedWakeInput = {
  deviceId: string;
  sessionId: string;
  sessionFile?: string | null;
  operation?: string;
  authorizedScope?: string[];
  continuation?: { message?: string; prompt?: string; target?: { deviceId?: string; sessionId?: string; sessionFile?: string | null }; authorizedScope?: string[]; taskId?: string } | null;
  messageId?: string;
  onAccepted?: () => void | Promise<void>;
  beforeSubmit?: () => boolean;
};

function samePath(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return left === right;
  try { return realpathSync(left) === realpathSync(right); } catch { return left === right; }
}
function continuationMessage(input: AuthorizedWakeInput): string {
  const continuation = input.continuation;
  if (!continuation || typeof (continuation.message ?? continuation.prompt) !== "string") throw new Error("authorized continuation message is required");
  if (!Array.isArray(continuation.authorizedScope) || !continuation.authorizedScope.includes("resume_prior_work") || continuation.authorizedScope.some((scope) => scope !== "resume_prior_work")) throw new Error("continuation scope is not authorized");
  if (continuation.target?.deviceId && continuation.target.deviceId !== input.deviceId) throw new Error("continuation target device mismatch");
  if (continuation.target?.sessionId && continuation.target.sessionId !== input.sessionId) throw new Error("continuation target session mismatch");
  if (continuation.target?.sessionFile && input.sessionFile && !samePath(continuation.target.sessionFile, input.sessionFile)) throw new Error("continuation target session file mismatch");
  return String(continuation.message ?? continuation.prompt).trim();
}
type WakeSession = { sessionId?: string; sessionFile?: string | null; isAlive?: () => boolean; isRunning?: () => boolean; inner?: { isBashRunning?: boolean; isCompacting?: boolean }; hasPendingUserInteraction?: () => boolean; sendNativePeerMessage?: (message: SessionPeerMessage, options?: { triggerTurn?: boolean; beforeSubmit?: () => boolean }) => Promise<unknown> };
export function createAuthorizedWakePeerMessage(session: WakeSession, input: AuthorizedWakeInput, message: string): SessionPeerMessage {
  const messageId = input.messageId || `wake:${createHash("sha256").update(JSON.stringify({
    sessionId: input.sessionId,
    operation: input.operation || "resume_prior_authorized_work",
    taskId: input.continuation?.taskId || null,
    message,
  })).digest("hex")}`;
  return {
    customType: SESSION_PEER_CUSTOM_TYPE,
    content: message,
    display: true,
    details: {
      source: "session-control-wake",
      messageId,
      operation: input.operation || "resume_prior_authorized_work",
      sessionId: session.sessionId || input.sessionId,
      sessionFile: session.sessionFile || input.sessionFile || null,
      authorizedScope: input.authorizedScope?.length ? [...input.authorizedScope] : ["resume_prior_work"],
      ...(input.continuation?.target ? { target: input.continuation.target } : {}),
      ...(input.continuation?.taskId ? { taskId: input.continuation.taskId } : {}),
    },
  };
}
async function submitContinuation(session: WakeSession, input: AuthorizedWakeInput, message: string, onAccepted?: () => void | Promise<void>, beforeSubmit?: () => boolean) {
  if (beforeSubmit && !beforeSubmit()) return { status: "blocked", reason: "notification_no_longer_pending" };
  if (!session?.isAlive?.()) return { status: "blocked", reason: "session_not_alive" };
  if (session.isRunning?.() || session.inner?.isBashRunning || session.inner?.isCompacting || session.hasPendingUserInteraction?.()) {
    return { status: "queued_busy", reason: "target_busy_or_waiting_user" };
  }
  if (typeof session.sendNativePeerMessage !== "function") return { status: "blocked", reason: "native peer delivery unavailable" };
  try {
    await session.sendNativePeerMessage(createAuthorizedWakePeerMessage(session, input, message), { triggerTurn: true, ...(beforeSubmit ? { beforeSubmit } : {}) });
    await onAccepted?.();
    return { status: "submitted", resumed: true, nextAction: "authorized continuation accepted at the native peer admission boundary" };
  } catch (error) {
    return { status: "blocked", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Restore the exact active session and submit only the previously authorized continuation. */
export async function queueAuthorizedSessionWake(input: AuthorizedWakeInput) {
  const localDeviceId = localDeviceIdentity(readActivityConfig(), new Date().toISOString()).id;
  if (input.deviceId !== localDeviceId) return { status: "blocked", reason: "target device is not this Reader", sessionId: input.sessionId };
  if (input.operation && input.operation !== "resume_prior_authorized_work") return { status: "blocked", reason: "unsupported wake operation", sessionId: input.sessionId };
  let message: string;
  try { message = continuationMessage(input); } catch (error) { return { status: "blocked", reason: error instanceof Error ? error.message : String(error), sessionId: input.sessionId }; }
  const live = getRpcSession(input.sessionId);
  if (live?.isAlive()) {
    if (input.sessionFile && !samePath(live.sessionFile, input.sessionFile)) return { status: "blocked", reason: "live session file identity conflict", sessionId: input.sessionId };
    try { return { ...(await submitContinuation(live, input, message, input.onAccepted, input.beforeSubmit)), sessionId: live.sessionId || input.sessionId, sessionFile: live.sessionFile || input.sessionFile || null }; }
    catch (error) { return { status: "unknown", reason: error instanceof Error ? error.message : String(error), sessionId: input.sessionId }; }
  }
  const resolvedPath = await resolveSessionPath(input.sessionId, { archived: false });
  if (!resolvedPath) return { status: "blocked", reason: "session_missing_or_archived", sessionId: input.sessionId };
  if (input.sessionFile && !samePath(resolvedPath, input.sessionFile)) return { status: "blocked", reason: "persisted session file identity conflict", sessionId: input.sessionId };
  try {
    const started = await startRpcSession(input.sessionId, resolvedPath, undefined);
    const result = await submitContinuation(started.session, input, message, input.onAccepted, input.beforeSubmit);
    return { ...result, sessionId: started.session.sessionId || input.sessionId, sessionFile: started.session.sessionFile || resolvedPath };
  } catch (error) { return { status: "blocked", reason: error instanceof Error ? error.message : String(error), sessionId: input.sessionId }; }
}
