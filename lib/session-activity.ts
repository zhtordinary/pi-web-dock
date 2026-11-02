import { withStateFileTransaction } from "./state-file-transaction.ts";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { emitActivityEvent } from "./activity-events.ts";
import type { SchedulerState } from "./continue-logic";
import type { SessionRunRecord, SessionRunStatus } from "./session-activity-types";
export { agentEndErrorMessage } from "./agent-event-wire.ts";

const MAX_RUNS = 500;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVITY_FILE = process.env.PI_WEB_SESSION_ACTIVITY_FILE
  ?? join(process.env.HOME ?? ".", ".config", "pi-web-reader", "session-activity.json");

export interface PersistedUnattendedState {
  enabled: boolean;
  schedulerState: SchedulerState | null;
  updatedAt: string;
}

interface RuntimeState {
  loaded: boolean;
  records: SessionRunRecord[];
  activeBySession: Map<string, string>;
  unattended: Map<string, PersistedUnattendedState>;
}

declare global {
  var __piSessionActivityRuntime: RuntimeState | undefined;
}

function runtime(): RuntimeState {
  if (!globalThis.__piSessionActivityRuntime) {
    globalThis.__piSessionActivityRuntime = {
      loaded: false,
      records: [],
      activeBySession: new Map(),
      unattended: new Map(),
    };
  }
  return globalThis.__piSessionActivityRuntime;
}

function now(): string {
  return new Date().toISOString();
}

function validRecord(value: unknown): value is SessionRunRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SessionRunRecord>;
  return typeof record.runId === "string"
    && typeof record.sessionId === "string"
    && typeof record.cwd === "string"
    && typeof record.startedAt === "string"
    && typeof record.updatedAt === "string"
    && ["running", "completed", "failed", "aborted", "unknown"].includes(record.status ?? "");
}

function prune(records: SessionRunRecord[]): SessionRunRecord[] {
  const cutoff = Date.now() - RETENTION_MS;
  return records
    .filter((record) => {
      const started = Date.parse(record.startedAt);
      return !Number.isFinite(started) || record.status === "running" || started >= cutoff;
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .slice(-MAX_RUNS);
}

function validSchedulerState(value: unknown): value is SchedulerState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<SchedulerState>;
  return typeof state.active === "boolean"
    && ["error", "limit", "fatal", "idle", "canceled", "manual", "restart"].includes(state.reason ?? "")
    && typeof state.attempt === "number"
    && Number.isFinite(state.attempt)
    && (state.nextDelayMs === null || (typeof state.nextDelayMs === "number" && Number.isFinite(state.nextDelayMs)))
    && (state.errorMessage === null || typeof state.errorMessage === "string")
    && (state.nextRetryAt === undefined || state.nextRetryAt === null || (typeof state.nextRetryAt === "number" && Number.isFinite(state.nextRetryAt)))
    && (state.key === undefined || state.key === null || typeof state.key === "string");
}

function validUnattendedState(value: unknown): value is PersistedUnattendedState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<PersistedUnattendedState>;
  return typeof state.enabled === "boolean"
    && (state.schedulerState === null || validSchedulerState(state.schedulerState))
    && typeof state.updatedAt === "string";
}

function cloneSchedulerState(state: SchedulerState | null): SchedulerState | null {
  return state ? { ...state } : null;
}

function cloneUnattendedState(state: PersistedUnattendedState): PersistedUnattendedState {
  return { ...state, schedulerState: cloneSchedulerState(state.schedulerState) };
}

function pruneUnattended(states: Map<string, PersistedUnattendedState>): void {
  const cutoff = Date.now() - RETENTION_MS;
  for (const [sessionId, state] of states) {
    if (Date.parse(state.updatedAt) < cutoff) states.delete(sessionId);
  }
  if (states.size <= MAX_RUNS) return;
  const oldest = [...states.entries()]
    .sort(([, a], [, b]) => a.updatedAt.localeCompare(b.updatedAt))
    .slice(0, states.size - MAX_RUNS);
  for (const [sessionId] of oldest) states.delete(sessionId);
}

function loadPersistedUnattended(
  value: unknown,
  target: Map<string, PersistedUnattendedState>,
): void {
  if (!value || typeof value !== "object") return;
  for (const [sessionId, candidate] of Object.entries(value)) {
    if (validUnattendedState(candidate)) target.set(sessionId, cloneUnattendedState(candidate));
  }
  pruneUnattended(target);
}

function load(): RuntimeState {
  const state = runtime();
  const next: RuntimeState = { loaded: true, records: [], activeBySession: new Map(state.activeBySession), unattended: new Map() };
  try {
    if (existsSync(ACTIVITY_FILE)) {
      const parsed = JSON.parse(readFileSync(ACTIVITY_FILE, "utf8")) as { records?: unknown; unattended?: unknown };
      next.records = prune(Array.isArray(parsed.records) ? parsed.records.filter(validRecord) : []);
      loadPersistedUnattended(parsed.unattended, next.unattended);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return next;
}

function persist(state: RuntimeState): void {
  mkdirSync(dirname(ACTIVITY_FILE), { recursive: true });
  writePrivateFileAtomicSync(ACTIVITY_FILE, `${JSON.stringify({
    schemaVersion: 1,
    records: prune(state.records),
    unattended: Object.fromEntries([...state.unattended.entries()].map(([sessionId, value]) => [sessionId, cloneUnattendedState(value)])),
  }, null, 2)}\n`);
  globalThis.__piSessionActivityRuntime = state;
}

export function getPersistedUnattendedState(sessionId: string): PersistedUnattendedState | null {
  const state = load().unattended.get(sessionId);
  return state ? cloneUnattendedState(state) : null;
}

export function listPersistedUnattendedStates(): Array<{ sessionId: string; state: PersistedUnattendedState }> {
  return [...load().unattended.entries()]
    .filter(([, state]) => state.enabled)
    .map(([sessionId, state]) => ({ sessionId, state: cloneUnattendedState(state) }));
}

export function setPersistedUnattendedState(
  sessionId: string,
  enabled: boolean,
  schedulerState: SchedulerState | null,
): void {
  return withStateFileTransaction(ACTIVITY_FILE, () => {
  const state = load();
  state.unattended.set(sessionId, {
    enabled,
    schedulerState: cloneSchedulerState(schedulerState),
    updatedAt: now(),
  });
  pruneUnattended(state.unattended);
  persist(state);
  });
}

function activeRecord(
  state: RuntimeState,
  sessionId: string,
  expectedRunId?: string | null,
): SessionRunRecord | undefined {
  const runId = expectedRunId === undefined ? state.activeBySession.get(sessionId) : expectedRunId;
  return runId ? state.records.find((record) => record.runId === runId && record.sessionId === sessionId) : undefined;
}

export function recordSessionRunStart(sessionId: string, cwd: string): SessionRunRecord {
  return withStateFileTransaction(ACTIVITY_FILE, () => {
  const state = load();
  const existing = activeRecord(state, sessionId);
  if (existing) {
    existing.updatedAt = now();
    persist(state);
    return { ...existing };
  }
  const timestamp = now();
  const record: SessionRunRecord = {
    runId: randomUUID(),
    sessionId,
    cwd,
    startedAt: timestamp,
    updatedAt: timestamp,
    status: "running",
  };
  state.records.push(record);
  state.activeBySession.set(sessionId, record.runId);
  persist(state);
  emitActivityEvent({ sessionId, runId: record.runId, status: record.status });
  return { ...record };
  });
}

export function touchSessionRun(sessionId: string, runId?: string | null): void {
  return withStateFileTransaction(ACTIVITY_FILE, () => {
  const state = load();
  const record = activeRecord(state, sessionId, runId);
  if (!record || (record.status !== "running" && record.status !== "unknown")) return;
  record.updatedAt = now();
  persist(state);
  });
}

export function recordSessionRunError(sessionId: string, error?: string, unattended?: boolean, runId?: string | null): void {
  updateActive(sessionId, "failed", error, unattended, runId);
}

export function recordSessionRunAbort(sessionId: string, unattended?: boolean, runId?: string | null): void {
  updateActive(sessionId, "aborted", undefined, unattended, runId);
}

export function recordSessionRunSettled(sessionId: string, runId?: string | null): void {
  return withStateFileTransaction(ACTIVITY_FILE, () => {
  const state = load();
  const record = activeRecord(state, sessionId, runId);
  if (!record || (record.status !== "running" && record.status !== "unknown")) return;
  const timestamp = now();
  record.completedAt = timestamp;
  record.updatedAt = timestamp;
  record.status = "completed";
  if (state.activeBySession.get(sessionId) === record.runId) state.activeBySession.delete(sessionId);
  persist(state);
  emitActivityEvent({ sessionId, runId: record.runId, status: record.status });
  });
}

export function recordSessionRunUnknown(sessionId: string, runId?: string | null): void {
  updateActive(sessionId, "unknown", undefined, undefined, runId);
}

function updateActive(sessionId: string, status: SessionRunStatus, error?: string, unattended?: boolean, runId?: string | null): void {
  return withStateFileTransaction(ACTIVITY_FILE, () => {
  const state = load();
  const record = activeRecord(state, sessionId, runId);
  if (!record || (record.status !== "running" && record.status !== "unknown") || record.status === status) return;
  const timestamp = now();
  record.status = status;
  record.updatedAt = timestamp;
  if (error?.trim()) record.error = error.trim().slice(0, 280);
  if (status !== "running") {
    record.completedAt = timestamp;
    if (state.activeBySession.get(sessionId) === record.runId) state.activeBySession.delete(sessionId);
  }
  persist(state);
  emitActivityEvent({
    sessionId,
    runId: record.runId,
    status: record.status,
    ...(typeof unattended === "boolean" ? { unattended } : {}),
  });
  });
}

export function getSessionRunRecords(): SessionRunRecord[] {
  const state = load();
  state.records = prune(state.records);
  return state.records
    .slice()
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((record) => ({ ...record, status: record.status === "running" && state.activeBySession.get(record.sessionId) !== record.runId ? "unknown" : record.status }));
}
