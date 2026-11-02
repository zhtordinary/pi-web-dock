import { withStateFileTransaction } from "./state-file-transaction.ts";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { emitActivityEvent } from "./activity-events.ts";
import { projectIdentityKeys } from "./project-identity.ts";

/**
 * 隐藏收纳状态（数据所属设备模型）：每台设备在自己的 hidden.json 里记录
 * 「本设备拥有的会话/项目」以及「本设备自身」是否被隐藏；聚合端合并各 peer
 * 的清单。隐藏会话 = 从所有列表消失；隐藏项目 = 该项目会话默认联动隐藏，
 * 允许单个 session 显式恢复；隐藏设备 = 该设备全部会话+项目联动隐藏。
 *
 * 文件路径与 session-activity.json 同目录（~/.config/pi-web-reader/），
 * 不在 Syncthing 同步范围——隐藏状态经聚合 API 跨设备生效，无需文件级同步。
 */

export type HiddenKind = "session" | "project" | "device";

export interface HiddenState {
  /** Explicitly hidden sessions. */
  sessions: string[];
  projects: string[];
  devices: string[];
  /** Explicitly visible exceptions to inherited project hiding. */
  visibleSessions: string[];
}

export const HIDDEN_KINDS: readonly HiddenKind[] = ["session", "project", "device"];

const STATE_KEYS: Record<HiddenKind, keyof HiddenState> = {
  session: "sessions",
  project: "projects",
  device: "devices",
};

export const HIDDEN_FILE = process.env.PI_WEB_HIDDEN_FILE
  ?? join(process.env.HOME ?? ".", ".config", "pi-web-reader", "hidden.json");

const EMPTY: HiddenState = { sessions: [], projects: [], devices: [], visibleSessions: [] };

// 缓存挂在 globalThis（同 session-activity 的 runtime 模式），测试可重置。
declare global {
  var __piHiddenStateCache: HiddenState | undefined;
}


function normalizeList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.trim().length > 0))]
    : [];
}

function normalize(value: unknown): HiddenState {
  const state: HiddenState = { sessions: [], projects: [], devices: [], visibleSessions: [] };
  if (!value || typeof value !== "object") return state;
  const source = value as Record<string, unknown>;
  for (const kind of HIDDEN_KINDS) state[STATE_KEYS[kind]] = normalizeList(source[STATE_KEYS[kind]]);
  // Missing field keeps old hidden.json files valid.
  state.visibleSessions = normalizeList(source.visibleSessions);
  return state;
}

function load(): HiddenState {
  let next: HiddenState = EMPTY;
  try {
    const parsed = JSON.parse(readFileSync(HIDDEN_FILE, "utf8")) as unknown;
    next = normalize(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  globalThis.__piHiddenStateCache = next;
  return next;
}

function persist(next: HiddenState): void {
    mkdirSync(dirname(HIDDEN_FILE), { recursive: true });
    writePrivateFileAtomicSync(HIDDEN_FILE, `${JSON.stringify({ schemaVersion: 1, ...next }, null, 2)}\n`);
  globalThis.__piHiddenStateCache = next;
}

export function readHiddenState(): HiddenState {
  return load();
}

/**
 * 添加/移除一条隐藏记录；取消 session 隐藏时记录显式可见例外，
 * 这样项目级继承隐藏不会锁死子会话操作。
 */
export function setHidden(kind: HiddenKind, id: string, hidden: boolean): HiddenState {
  return withStateFileTransaction(HIDDEN_FILE, () => {
  const key = id.trim();
  if (!key) return load();
  const state = load();
  const list = state[STATE_KEYS[kind]];
  const keys = kind === "project" ? projectIdentityKeys(key) : [key];
  const nextList = hidden
    ? [...list, ...keys.filter((value) => !list.includes(value))]
    : list.filter((value) => !keys.includes(value));
  const nextVisibleSessions = kind === "session"
    ? hidden
      ? state.visibleSessions.filter((value) => value !== key)
      : state.visibleSessions.includes(key) ? state.visibleSessions : [...state.visibleSessions, key]
    : state.visibleSessions;
  const listChanged = nextList.length !== list.length || nextList.some((value, index) => value !== list[index]);
  const visibleChanged = nextVisibleSessions.length !== state.visibleSessions.length
    || nextVisibleSessions.some((value, index) => value !== state.visibleSessions[index]);
  if (!listChanged && !visibleChanged) return state;
  persist({ ...state, [STATE_KEYS[kind]]: nextList, visibleSessions: nextVisibleSessions });
  // 隐藏/取消隐藏属聚合列表变更：发 session 事件通知（本机 SSE + 各 peer
  // 长轮询都能收到 → 聚合端即时刷新，不等 2s 轮询 + 4s TTL）。
  emitActivityEvent({ kind: "session", sessionId: key });
  return load();
  });
}

/** Restore a session for another storage scope, including a project-hide exception. */
export function restoreSessionForStorage(sessionId: string, projectKey?: string): HiddenState {
  return withStateFileTransaction(HIDDEN_FILE, () => {
    const key = sessionId.trim();
    if (!key) return load();
    const state = load();
    const sessions = state.sessions.filter((value) => value !== key);
    const projectKeys = projectKey ? new Set(projectIdentityKeys(projectKey)) : undefined;
    const inheritsProjectHidden = Boolean(
      projectKeys && state.projects.some((value) => projectKeys.has(value)),
    );
    const visibleSessions = inheritsProjectHidden
      ? state.visibleSessions.includes(key)
        ? state.visibleSessions
        : [...state.visibleSessions, key]
      : state.visibleSessions.filter((value) => value !== key);
    if (
      sessions.length === state.sessions.length
      && visibleSessions.length === state.visibleSessions.length
      && visibleSessions.every((value, index) => value === state.visibleSessions[index])
    ) return state;
    persist({ ...state, sessions, visibleSessions });
    emitActivityEvent({ kind: "session", sessionId: key });
    return load();
  });
}

/** Clear all persisted visibility records for a deleted session. */
export function clearSessionHidden(sessionId: string): HiddenState {
  return withStateFileTransaction(HIDDEN_FILE, () => {
  const key = sessionId.trim();
  if (!key) return load();
  const state = load();
  const sessions = state.sessions.filter((value) => value !== key);
  const visibleSessions = state.visibleSessions.filter((value) => value !== key);
  if (sessions.length === state.sessions.length && visibleSessions.length === state.visibleSessions.length) return state;
  persist({ ...state, sessions, visibleSessions });
  emitActivityEvent({ kind: "session", sessionId: key });
  return load();
  });
}

/** Restore the project and all its sessions without changing other storage metadata. */
export function clearProjectHidden(projectKey: string, sessions: Iterable<{ id: string; projectKey?: string }>): HiddenState {
  return withStateFileTransaction(HIDDEN_FILE, () => {
    const key = projectKey.trim();
    if (!key) return load();
    const projectKeys = new Set(projectIdentityKeys(key));
    const sessionIds = new Set<string>();
    for (const session of sessions) {
      if (session.projectKey && projectIdentityKeys(session.projectKey).some((candidate) => projectKeys.has(candidate))) {
        sessionIds.add(session.id);
      }
    }
    const state = load();
    const projects = state.projects.filter((value) => !projectKeys.has(value));
    const hiddenSessions = state.sessions.filter((sessionId) => !sessionIds.has(sessionId));
    const visibleSessions = state.visibleSessions.filter((sessionId) => !sessionIds.has(sessionId));
    if (projects.length === state.projects.length && hiddenSessions.length === state.sessions.length && visibleSessions.length === state.visibleSessions.length) return state;
    persist({ ...state, projects, sessions: hiddenSessions, visibleSessions });
    emitActivityEvent({ kind: "session", sessionId: key });
    return load();
  });
}

/**
 * 会话/项目是否被隐藏（联动语义）：
 * - 会话显式隐藏 → 该会话隐藏；
 * - 会话显式可见 → 覆盖继承自项目的隐藏；
 * - 设备被隐藏 → 其全部会话/项目视为隐藏；
 * - 项目 key 被隐藏 → 该项目全部会话视为隐藏。
 * 判定使用数据所属设备的清单；同一路径在其他设备上的可见性独立。
 * 新会话没有显式可见例外，默认继承项目隐藏。
 */
export function isHidden(deviceId: string, sessionId: string | undefined, projectKey: string | undefined): boolean {
  return isHiddenInState(load(), deviceId, sessionId, projectKey);
}

export function isHiddenInState(state: HiddenState, deviceId: string, sessionId: string | undefined, projectKey: string | undefined): boolean {
  if (state.devices.includes(deviceId)) return true;
  if (sessionId && state.sessions.includes(sessionId)) return true;
  if (projectKey && projectIdentityKeys(projectKey).some((key) => state.projects.includes(key))) {
    return !(sessionId && state.visibleSessions.includes(sessionId));
  }
  return false;
}
