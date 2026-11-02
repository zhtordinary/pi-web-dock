import type { SessionActivityItem } from "./session-activity-types.ts";
import { AgentCommandError, sendAgentCommand } from "./agent-client.ts";

export const MIN_BATCH_CONTINUE_SESSIONS = 2;

export interface BatchContinueIssue {
  sessionId: string;
  deviceId: string;
  label: string;
  error: string;
  code?: string;
  uncertain: boolean;
}

export interface BatchContinueResult {
  /** Request acceptance, not proof that the resumed model run completed. */
  succeeded: string[];
  failed: string[];
  issues: BatchContinueIssue[];
}

export function filterContinuableSessions(
  sessions: SessionActivityItem[] | undefined | null,
): SessionActivityItem[] {
  if (!Array.isArray(sessions)) return [];
  return sessions.filter((item) => item.status === "unknown" || item.status === "failed");
}

export function shouldShowBatchContinue(count: number): boolean {
  return Number.isFinite(count) && count >= MIN_BATCH_CONTINUE_SESSIONS;
}

/**
 * Submit one recovery request per observed run.
 *
 * The first command is retry-only so an ambiguous transport failure can never
 * create a second business turn. A typed `retry_unavailable` rejection is
 * different: the server has confirmed that no retry was admitted, so the
 * explicit batch action may use the existing manual fallback exactly once.
 */
export async function continueSession(
  item: SessionActivityItem,
  localDeviceId?: string,
): Promise<{ success: boolean; sessionId: string; issue?: BatchContinueIssue }> {
  const sessionId = item.session.id;
  const remotePeer = item.device?.id && item.device.id !== localDeviceId ? item.device.id : undefined;

  try {
    if (!item.latestRun?.runId) {
      throw new AgentCommandError("Session run identity is unavailable; refresh activity before continuing", 409, "retry_target_changed", false);
    }
    const expectedRunId = item.latestRun.runId;
    try {
      await sendAgentCommand(sessionId, { type: "retry_continue_only", expectedRunId }, remotePeer);
    } catch (error) {
      if (!(error instanceof AgentCommandError)
        || error.accepted !== false
        || error.code !== "retry_unavailable") {
        throw error;
      }
      // The retry-only request was rejected before execution. Reuse the
      // single-session command's guarded fallback; a lost/unknown response
      // never reaches this branch and therefore cannot be replayed.
      await sendAgentCommand(sessionId, { type: "retry_continue", expectedRunId }, remotePeer);
    }
    return { success: true, sessionId };
  } catch (error) {
    return {
      success: false,
      sessionId,
      issue: {
        sessionId,
        deviceId: item.device.id,
        label: item.session.name || sessionId,
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof AgentCommandError ? error.code : undefined,
        uncertain: !(error instanceof AgentCommandError && error.accepted === false),
      },
    };
  }
}

export async function continueAllSessions(
  sessions: SessionActivityItem[],
  localDeviceId?: string,
): Promise<BatchContinueResult> {
  const results = await Promise.all(sessions.map((item) => continueSession(item, localDeviceId)));
  const batch: BatchContinueResult = { succeeded: [], failed: [], issues: [] };
  for (const result of results) {
    if (result.success) batch.succeeded.push(result.sessionId);
    else {
      batch.failed.push(result.sessionId);
      batch.issues.push(result.issue!);
    }
  }
  return batch;
}
