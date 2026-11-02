import type { SessionRunRecord } from "./session-activity-types";

/** Runtime activity is a separate fact; it cannot promote unknown history. */
export function projectSessionRuns(records: SessionRunRecord[], sessionId: string, active: boolean) {
  const runs = records.filter(record => record.sessionId === sessionId).slice(0, 8);
  return {
    runs,
    currentActivity: { active, runId: active ? runs.find(record => record.status === "running")?.runId ?? null : null },
  };
}
