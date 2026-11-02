import { withStateFileTransaction } from "./state-file-transaction.ts";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { emitActivityEvent } from "./activity-events.ts";

/**
 * 收藏清单：每台设备只记录自己拥有的会话 id；聚合页通过 API 合并各设备。
 * 文件不进入 Syncthing，和 hidden.json 保持相同的数据归属模型。
 */
export interface FavoriteState {
  sessions: string[];
}

export const FAVORITES_FILE = process.env.PI_WEB_FAVORITES_FILE
  ?? join(process.env.HOME ?? ".", ".config", "pi-web-reader", "favorites.json");

const EMPTY: FavoriteState = { sessions: [] };

declare global {
  var __piFavoriteStateCache: FavoriteState | undefined;
}

function normalize(value: unknown): FavoriteState {
  if (!value || typeof value !== "object") return { ...EMPTY };
  const sessions = (value as { sessions?: unknown }).sessions;
  return {
    sessions: Array.isArray(sessions)
      ? [...new Set(sessions.filter((id): id is string => typeof id === "string" && id.trim().length > 0))]
      : [],
  };
}

function load(): FavoriteState {
  let next = { ...EMPTY };
  try {
    next = normalize(JSON.parse(readFileSync(FAVORITES_FILE, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  globalThis.__piFavoriteStateCache = next;
  return next;
}

function persist(next: FavoriteState): void {
    mkdirSync(dirname(FAVORITES_FILE), { recursive: true });
    writePrivateFileAtomicSync(FAVORITES_FILE, `${JSON.stringify({ schemaVersion: 1, ...next }, null, 2)}\n`);
  globalThis.__piFavoriteStateCache = next;
}

export function readFavoriteState(): FavoriteState {
  return load();
}

export function isFavorite(sessionId: string): boolean {
  return load().sessions.includes(sessionId);
}

export function setFavorite(sessionId: string, favorite: boolean): FavoriteState {
  return withStateFileTransaction(FAVORITES_FILE, () => {
  const id = sessionId.trim();
  if (!id) return load();
  const state = load();
  if (favorite ? state.sessions.includes(id) : !state.sessions.includes(id)) return state;
  const sessions = favorite
    ? [...state.sessions, id]
    : state.sessions.filter((value) => value !== id);
  persist({ sessions });
  emitActivityEvent({ kind: "session", sessionId: id });
  return load();
  });
}
