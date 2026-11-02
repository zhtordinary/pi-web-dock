import type { SessionActivityItem, SessionActivityStatus } from "./session-activity-types.ts";

export type SessionActivitySort = "asked" | "recent" | "status";

function statusRank(status: SessionActivityStatus | undefined): number {
  switch (status) {
    case "waiting_user": return 0;
    case "just_completed": return 1;
    case "running": return 2;
    case "retrying": return 3;
    case "failed": return 4;
    case "aborted": return 5;
    case "unknown": return 6;
    default: return 7;
  }
}

export function sessionActivityDisplayTime(
  item: Pick<SessionActivityItem, "lastAskedAt" | "lastActivityAt">,
  sort: SessionActivitySort,
): string {
  return sort === "asked" || sort === "status"
    ? item.lastAskedAt || item.lastActivityAt
    : item.lastActivityAt;
}

function itemTime(item: Pick<SessionActivityItem, "lastAskedAt" | "lastActivityAt">, sort: SessionActivitySort): string {
  return sessionActivityDisplayTime(item, sort);
}

export function compareSessionActivityItems(
  a: Pick<SessionActivityItem, "status" | "lastAskedAt" | "lastActivityAt">,
  b: Pick<SessionActivityItem, "status" | "lastAskedAt" | "lastActivityAt">,
  sort: SessionActivitySort,
): number {
  if (sort === "status") {
    const rankDiff = statusRank(a.status) - statusRank(b.status);
    if (rankDiff !== 0) return rankDiff;
    return itemTime(b, "recent").localeCompare(itemTime(a, "recent"));
  }
  return itemTime(b, sort).localeCompare(itemTime(a, sort));
}

export type ActivityTimeRange = "all" | "1" | "3" | "7" | "14" | "30" | "90";

export const ACTIVITY_TIME_RANGE_VALUES = new Set<ActivityTimeRange>(["all", "1", "3", "7", "14", "30", "90"]);

export function isActivityTimeRange(value: unknown): value is ActivityTimeRange {
  return typeof value === "string" && ACTIVITY_TIME_RANGE_VALUES.has(value as ActivityTimeRange);
}

export function isWithinActivityTimeRange(timestamp: string, days: ActivityTimeRange, nowMs: number): boolean {
  if (days === "all") return true;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && parsed >= nowMs - Number(days) * 24 * 60 * 60 * 1000;
}

export function filterSessionsByActivityTime<T extends { id: string; modified: string }>(
  sessions: readonly T[],
  activities: readonly SessionActivityItem[],
  days: ActivityTimeRange,
  nowMs: number,
): T[] {
  if (days === "all") return [...sessions];
  const activityBySessionId = new Map(activities.map((item) => [item.session.id, item.lastActivityAt]));
  return sessions.filter((session) => isWithinActivityTimeRange(activityBySessionId.get(session.id) ?? session.modified, days, nowMs));
}
