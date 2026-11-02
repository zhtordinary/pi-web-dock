import type { SessionActivityItem, SessionActivityResponse } from "./session-activity-types";

/** A non-replay start observed before the first inventory supplies run metadata. */
export interface InitialSessionRunStart {
  device: string;
  sessionId: string;
  runId: string;
}

/** Compare registry snapshots, never infer completion from a missing/offline session. */
export function completedSessionRuns(
  previous: SessionActivityResponse | null,
  current: SessionActivityResponse,
  initialStarts: readonly InitialSessionRunStart[] = [],
): SessionActivityItem[] {
  if (!previous && initialStarts.length === 0) return [];
  return current.sessions.filter((item) => {
    const run = item.latestRun;
    if (!run?.runId || !["completed", "failed", "aborted"].includes(run.status)) return false;
    if (item.device.online === false || item.currentActivity?.active
      || ["running", "retrying", "waiting_user"].includes(item.status)) return false;
    if (initialStarts.some((start) => start.device === item.device.id
      && start.sessionId === item.session.id && start.runId === run.runId)) return true;
    const before = previous?.sessions.find((candidate) => (
      candidate.device.id === item.device.id && candidate.session.id === item.session.id
    ));
    const oldRun = before?.runs.find((candidate) => candidate.runId === run.runId)
      ?? (before?.latestRun?.runId === run.runId ? before.latestRun : null);
    if (oldRun) return oldRun.status === "running" || (
      before?.latestRun?.runId === run.runId
      && (before.currentActivity?.active === true || ["running", "retrying", "waiting_user"].includes(before.status))
    );
    return false;
  });
}
