import type { SubagentTerminalState } from "./session-activity-types.ts";

export interface SessionRetryStatusSignals {
  streaming: boolean;
  retryInFlight: boolean;
  userPromptActive: boolean;
  schedulerActive: boolean;
  active: boolean;
  hasErrorTail: boolean;
  latestRunStatus?: "running" | "completed" | "failed" | "aborted" | "unknown" | null;
}

/**
 * A retry label describes queued retry work. Once the provider has resumed an
 * actual model stream, the user needs the ordinary running state instead.
 */
export function shouldShowRetryingStatus(signals: SessionRetryStatusSignals): boolean {
  if (signals.streaming) return false;
  // A live retry is authoritative even before its next run record is written.
  if (signals.retryInFlight) return true;
  // A completed or aborted terminal run is newer evidence than a stale
  // scheduler flag. Do not let an old retry label survive the final outcome.
  if (signals.latestRunStatus === "completed" || signals.latestRunStatus === "aborted") return false;
  return !signals.userPromptActive && (signals.schedulerActive || (signals.active && signals.hasErrorTail));
}

/** Activity states that leave the latest session turn available for Continue. */
const CONTINUE_RECOVERY_STATUSES = new Set(["unknown", "failed", "aborted", "retrying", "terminated"]);

export function shouldShowContinueForActivityStatus(status: unknown): boolean {
  return typeof status === "string" && CONTINUE_RECOVERY_STATUSES.has(status);
}
export interface SubagentCompletionSignals {
  parentRunStatus?: string;
  parentRunStartedAt?: string;
  subagentTerminalState?: SubagentTerminalState;
  subagentTerminalAt?: number;
}

/** Keep parent-stream failure visible while exposing a completed delegated task. */
export function isSubagentCompletionConfirmed(signals: SubagentCompletionSignals): boolean {
  if (signals.parentRunStatus !== "failed" || signals.subagentTerminalState !== "completed") return false;
  if (typeof signals.subagentTerminalAt !== "number" || !Number.isFinite(signals.subagentTerminalAt)) return false;
  const parentStartedAt = Date.parse(signals.parentRunStartedAt ?? "");
  return Number.isFinite(parentStartedAt) && signals.subagentTerminalAt >= parentStartedAt;
}
