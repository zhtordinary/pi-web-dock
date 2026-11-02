import { withStateFileTransaction } from "./state-file-transaction.ts";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";

/**
 * 会话已读状态（「刚处理完」未读语义的已读侧）：每台设备在自己的
 * viewed.json 里记录「在这台设备的 pi-web 上被打开阅读过的会话」时间戳
 * （epoch ms）。同一服务端的所有浏览器/标签页共享 → 跨浏览器一致；
 * 跨设备各自独立（每台设备自己的阅读视角）。聚合视图（含远程会话）
 * 统一按本机服务端已读状态裁决，无需跨设备 RPC。
 *
 * 文件路径与 session-activity.json 同目录（~/.config/pi-web-reader/），
 * 不在 Syncthing 同步范围。
 */

export type ViewedState = Record<string, number>;

export const VIEWED_FILE = process.env.PI_WEB_VIEWED_FILE
  ?? join(process.env.HOME ?? ".", ".config", "pi-web-reader", "viewed.json");

// 30 天前的已读标记视为过期；上限 5000 条防无限膨胀。
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

// 缓存挂在 globalThis（同 hidden-state/session-activity 的 runtime 模式），测试可重置。
declare global {
  var __piViewedStateCache: ViewedState | undefined;
}


function normalize(value: unknown): ViewedState {
  const state: ViewedState = {};
  if (!value || typeof value !== "object") return state;
  const source = value as Record<string, unknown>;
  for (const [sessionId, timestamp] of Object.entries(source)) {
    if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0) {
      state[sessionId] = timestamp;
    }
  }
  return state;
}

function load(): ViewedState {
  let next: ViewedState = {};
  try {
    const parsed = JSON.parse(readFileSync(VIEWED_FILE, "utf8")) as unknown;
    next = normalize(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  globalThis.__piViewedStateCache = next;
  return next;
}

function persist(next: ViewedState): void {
    mkdirSync(dirname(VIEWED_FILE), { recursive: true });
    writePrivateFileAtomicSync(VIEWED_FILE, `${JSON.stringify(next, null, 2)}\n`);
  globalThis.__piViewedStateCache = next;
}

/** 全部已读标记（sessionId → 打开时间 epoch ms）。 */
export function readViewedState(): ViewedState {
  return load();
}

/** 标记会话已读，返回写入的时间戳（epoch ms）。 */
export function markSessionViewed(sessionId: string): number {
  return withStateFileTransaction(VIEWED_FILE, () => {
  const key = sessionId.trim();
  const viewedAt = Date.now();
  // 写入前清理过期条目并封顶（写时清理即可，读路径保持零副作用）。
  // 先排除该会话旧条目再追加，避免重复键覆盖最新时间戳。
  const cutoff = viewedAt - MAX_AGE_MS;
  const entries = Object.entries(load()).filter(([id, timestamp]) => id !== key && timestamp > cutoff);
  entries.push([key, viewedAt]);
  entries.sort((a, b) => b[1] - a[1]);
  const next = Object.fromEntries(entries.slice(0, MAX_ENTRIES)) as ViewedState;
  persist(next);
  return viewedAt;
  });
}
