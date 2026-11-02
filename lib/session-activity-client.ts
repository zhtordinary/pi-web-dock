import type {
  SessionActivityDevice,
  SessionActivityItem,
  SessionActivityResponse,
  SessionActivityStatus,
  SessionRunRecord,
  SessionRunStatus,
} from "./session-activity-types";

/** The browser-safe shape forwarded by /api/activity/events and /relay. */
export interface SessionActivityEventPayload {
  type: "activity";
  device?: string;
  bootId?: string;
  seq?: number;
  at?: number;
  kind?: "run" | "session";
  sessionId?: string;
  runId?: string;
  status?: SessionRunStatus;
  unattended?: boolean;
  /** True when this event came from an SSE buffer replay rather than live push. */
  replay?: boolean;
}

export interface SessionActivityPeerStatePayload {
  type: "peer_state";
  device?: string;
  online?: boolean;
}

export interface SessionActivityPatchResult {
  response: SessionActivityResponse;
  matched: boolean;
  changed: boolean;
}

const RUN_STATUSES = new Set<SessionRunStatus>(["running", "completed", "failed", "aborted", "unknown"]);

function eventTime(at: number | undefined): { ms: number; iso: string } {
  const ms = typeof at === "number" && Number.isFinite(at) ? at : Date.now();
  return { ms, iso: new Date(ms).toISOString() };
}

function runStatusToActivityStatus(status: SessionRunStatus): SessionActivityStatus {
  switch (status) {
    case "running": return "running";
    case "completed": return "just_completed";
    case "failed": return "failed";
    case "aborted": return "aborted";
    case "unknown": return "unknown";
  }
}

function parsedTime(value: string | undefined): number {
  if (!value) return Number.NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function mergeRun(item: SessionActivityItem, event: SessionActivityEventPayload, at: { iso: string }): SessionRunRecord {
  const status = event.status!;
  const existing = item.runs.find((run) => run.runId === event.runId) ?? (
    item.latestRun?.runId === event.runId ? item.latestRun : undefined
  );
  const startedAt = existing?.startedAt ?? (status === "running" ? at.iso : item.session.modified || at.iso);
  return {
    runId: event.runId!,
    sessionId: event.sessionId!,
    cwd: existing?.cwd ?? item.session.cwd,
    startedAt,
    updatedAt: at.iso,
    status,
    ...(status === "running" ? {} : { completedAt: at.iso }),
    ...(existing?.error && status === "failed" ? { error: existing.error } : {}),
  };
}

/**
 * Apply one live run event without waiting for the snapshot endpoint.
 *
 * The snapshot remains authoritative for metadata, but this function owns the
 * latency-sensitive projection used by the sidebars. It deliberately refuses
 * to let an older run event move a newer run backwards.
 */
export function applySessionActivityEvent(
  response: SessionActivityResponse,
  event: SessionActivityEventPayload,
): SessionActivityPatchResult {
  if (
    event.type !== "activity"
    || event.kind === "session"
    || typeof event.sessionId !== "string"
    || typeof event.runId !== "string"
    || !RUN_STATUSES.has(event.status as SessionRunStatus)
  ) {
    return { response, matched: false, changed: false };
  }

  const index = response.sessions.findIndex((item) => (
    item.session.id === event.sessionId
    && (!event.device || item.device.id === event.device)
  ));
  if (index < 0) return { response, matched: false, changed: false };

  const item = response.sessions[index];
  const at = eventTime(event.at);
  const current = item.latestRun;
  const currentTime = parsedTime(current?.updatedAt ?? current?.completedAt ?? current?.startedAt);
  if (current && current.runId !== event.runId && Number.isFinite(currentTime) && currentTime > at.ms) {
    return { response, matched: true, changed: false };
  }

  const nextRun = mergeRun(item, event, at);
  const runs = [nextRun, ...item.runs.filter((run) => run.runId !== nextRun.runId)]
    .sort((a, b) => parsedTime(b.startedAt) - parsedTime(a.startedAt))
    .slice(0, 8);
  const nextStatus = runStatusToActivityStatus(nextRun.status);
  const lastActivityAt = item.session.modified;
  const nextItem: SessionActivityItem = {
    ...item,
    ...(typeof event.unattended === "boolean" ? { unattended: event.unattended } : {}),
    status: nextStatus,
    lastActivityAt,
    latestRun: nextRun,
    runs,
  };
  const changed = item.status !== nextItem.status
    || item.latestRun?.runId !== nextRun.runId
    || item.latestRun?.status !== nextRun.status
    || item.latestRun?.updatedAt !== nextRun.updatedAt;
  if (!changed) return { response, matched: true, changed: false };

  const sessions = response.sessions.slice();
  sessions[index] = nextItem;
  return { response: { ...response, sessions }, matched: true, changed: true };
}

/** Project one live run event onto a Talk Map's session-only activity state. */
export function applySessionActivityItemsEvent(
  sessions: SessionActivityItem[],
  event: SessionActivityEventPayload,
): { sessions: SessionActivityItem[]; matched: boolean; changed: boolean } {
  if (sessions.length === 0) return { sessions, matched: false, changed: false };
  const result = applySessionActivityEvent({
    schemaVersion: 1,
    scope: "local",
    generatedAt: "",
    device: sessions[0].device,
    devices: [sessions[0].device],
    sessions,
  }, event);
  return { sessions: result.response.sessions, matched: result.matched, changed: result.changed };
}

/** Apply a peer online/offline transition immediately; the next snapshot fills in lastSeenAt/error details. */
export function applySessionActivityPeerState(
  response: SessionActivityResponse,
  event: SessionActivityPeerStatePayload,
): SessionActivityPatchResult {
  if (event.type !== "peer_state" || typeof event.device !== "string" || typeof event.online !== "boolean") {
    return { response, matched: false, changed: false };
  }

  const current = response.devices.find((device) => device.id === event.device);
  if (!current) return { response, matched: false, changed: false };
  const next: SessionActivityDevice = event.online
    ? { ...current, online: true, error: undefined, lastSeenAt: new Date().toISOString() }
    : { ...current, online: false, error: "offline" };
  const changed = current.online !== next.online || current.error !== next.error;
  if (!changed) return { response, matched: true, changed: false };
  const devices = response.devices.map((device) => device.id === event.device ? next : device);
  const sessions = response.sessions.map((item) => item.device.id === event.device ? { ...item, device: next } : item);
  const device = response.device.id === event.device ? next : response.device;
  return { response: { ...response, device, devices, sessions }, matched: true, changed: true };
}

export function isTerminalSessionRunStatus(status: unknown): status is Exclude<SessionRunStatus, "running"> {
  return status === "completed" || status === "failed" || status === "aborted" || status === "unknown";
}

export function activityStatusForRun(status: Exclude<SessionRunStatus, "running">): SessionActivityStatus {
  return runStatusToActivityStatus(status);
}
