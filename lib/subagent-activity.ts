import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, join, resolve } from "node:path";
import type { SubagentTerminalState } from "./session-activity-types.ts";

export interface SubagentSessionIdentity {
  id: string;
  path: string;
}

export interface SubagentSessionActivity {
  active: boolean;
  terminalState?: SubagentTerminalState;
  terminalAt?: number;
}

interface RawSubagentStatus {
  sessionId?: unknown;
  state?: unknown;
  status?: unknown;
  activityState?: unknown;
  currentTool?: unknown;
  pid?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  lastUpdate?: unknown;
  processTerminal?: { state?: unknown };
  steps?: unknown;
}

const LIVE_STATES = new Set(["queued", "running"]);
const TERMINAL_STATES = new Set(["complete", "completed", "failed", "stopped", "rejected", "partial", "blocked"]);

function tempScopeId(): string {
  if (typeof process.getuid === "function") return `uid-${process.getuid()}`;
  for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
    const value = process.env[key]?.trim();
    if (value) return `user-${value.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
  }
  try {
    const username = userInfo().username?.trim();
    if (username) return `user-${username.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
  } catch {
    // Fall through to a shared scope.
  }
  return "shared";
}

function asyncRunRoot(): string {
  const configured = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  return join(configured ? resolve(configured) : join(tmpdir(), `pi-subagents-${tempScopeId()}`), "async-subagent-runs");
}

function samePath(left: string, right: string): boolean {
  try {
    const a = resolve(left);
    const b = resolve(right);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return left === right;
  }
}

function sessionForOwner(owner: string, sessions: readonly SubagentSessionIdentity[]): SubagentSessionIdentity | undefined {
  return sessions.find((session) => session.id === owner || session.path === owner || samePath(session.path, owner)
    || (basename(owner) === basename(session.path) && basename(owner).endsWith(`_${session.id}.jsonl`)));
}

function readStatus(path: string): RawSubagentStatus | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as RawSubagentStatus : undefined;
  } catch {
    return undefined;
  }
}

function liveState(value: unknown): boolean {
  return typeof value === "string" && LIVE_STATES.has(value);
}

function statusSteps(status: RawSubagentStatus): RawSubagentStatus[] {
  return Array.isArray(status.steps)
    ? status.steps.filter((step): step is RawSubagentStatus => Boolean(step) && typeof step === "object" && !Array.isArray(step))
    : [];
}

function processAlive(status: RawSubagentStatus): boolean {
  if (status.processTerminal?.state === "observed") return false;
  if (typeof status.pid !== "number" || !Number.isInteger(status.pid) || status.pid <= 0) return true;
  try {
    process.kill(status.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
function terminalStateForStatus(status: RawSubagentStatus): SubagentTerminalState | undefined {
  switch (status.state) {
    case "complete":
    case "completed": return "completed";
    case "failed": return "failed";
    case "partial": return "partial";
    case "stopped": return "stopped";
    case "rejected": return "rejected";
    default: return undefined;
  }
}

function terminalObserved(status: RawSubagentStatus): boolean {
  return status.processTerminal?.state === "observed"
    || (typeof status.pid === "number" && !processAlive(status));
}

function terminalAt(status: RawSubagentStatus): number | undefined {
  for (const value of [status.endedAt, status.lastUpdate, status.startedAt]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}
function activityForStatus(status: RawSubagentStatus): SubagentSessionActivity | undefined {
  const terminalState = terminalStateForStatus(status);
  if (terminalState && status.processTerminal?.state === "pending" && processAlive(status)) return { active: true };
  if (terminalState && terminalObserved(status)) {
    return {
      active: false,
      terminalState,
      terminalAt: terminalAt(status),
    };
  }
  if (!processAlive(status)) return undefined;
  const steps = statusSteps(status);
  const terminal = typeof status.state === "string" && TERMINAL_STATES.has(status.state);
  // pi-subagents supervisor/attention states are internal coordination, not a
  // user-facing ask_user request. Keep the parent visibly active without
  // projecting them into Reader's waiting_user state or wait sound.
  const internalAttention = !terminal && ((status.activityState === "needs_attention" && status.currentTool === "contact_supervisor")
    || (status.state === "paused" && status.activityState === "needs_attention")
    || steps.some((step) => step.activityState === "needs_attention" && step.currentTool === "contact_supervisor"));
  const active = !terminal && (liveState(status.state) || steps.some((step) => liveState(step.status)) || internalAttention);
  if (!active) return undefined;
  return { active };
}

function* sessionSubagentActivities(sessions: readonly SubagentSessionIdentity[]) {
  if (!sessions.length) return;
  const root = asyncRunRoot();
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = join(root, entry.name, "status.json");
    try { if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const status = readStatus(path);
    if (!status || typeof status.sessionId !== "string") continue;
    const owner = sessionForOwner(status.sessionId, sessions);
    if (!owner) continue;
    const activity = activityForStatus(status);
    if (activity) yield { owner, activity, runId: entry.name };
  }
}

/** The same owned run inventory drives activity, stop and archive admission. */
export function getSessionBackgroundRunIds(session: SubagentSessionIdentity): string[] {
  return [...sessionSubagentActivities([session])].filter(item => item.activity.active).map(item => item.runId);
}

/** Read live async pi-subagents state and project it onto owning Pi sessions. */
export function getSubagentActivityForSessions(
  sessions: readonly SubagentSessionIdentity[],
): Map<string, SubagentSessionActivity> {
  const result = new Map<string, SubagentSessionActivity>();
  for (const { owner, activity } of sessionSubagentActivities(sessions)) {
    const previous = result.get(owner.id);
    let previousTerminalState = previous?.terminalState;
    let previousTerminalAt = previous?.terminalAt;
    if (activity.terminalState && (previousTerminalAt === undefined || (activity.terminalAt ?? -Infinity) >= previousTerminalAt)) {
      previousTerminalState = activity.terminalState;
      previousTerminalAt = activity.terminalAt;
    }
    result.set(owner.id, {
      active: Boolean(previous?.active || activity.active),
      ...(previousTerminalState ? { terminalState: previousTerminalState } : {}),
      ...(typeof previousTerminalAt === "number" ? { terminalAt: previousTerminalAt } : {}),
    });
  }
  return result;
}
