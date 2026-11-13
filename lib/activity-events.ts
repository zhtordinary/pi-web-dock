import { randomUUID } from "node:crypto";
import type { SessionRunStatus } from "./session-activity-types";

/**
 * 会话活动事件总线（本机进程内）：run 生命周期事件（开始/完成/失败/中止/未知）
 * 的广播 + 环形缓冲。消费方：
 * - `/api/activity/events`：本地 SSE 流；跨机 peer 通过 `/api/reader/events` 聚合
 *
 * seq 在单个进程内单调递增；bootId 区分进程重启。环形缓冲供晚到订阅者
 * 回放。跨进程不共享（每台设备的 pi-web 进程各自一套）；服务重启后事件丢失，
 * 客户端通过 bootId 发现游标失效，再用快照刷新补齐。
 * 消费方通过 SSE 推送和可见页低频快照共同保持状态收敛。
 */

export type ActivityEventKind = "run" | "session" | "wait";

export interface ActivityEvent {
  seq: number;
  bootId: string;
  at: number; // epoch ms
  kind: ActivityEventKind;
  /** run 事件：带会话/run/状态；session 事件（消息落盘及删除/归档/改名/隐藏）只作变更通知。 */
  sessionId?: string;
  runId?: string;
  status?: SessionRunStatus;
  /** Run start time lets clients reject delayed events from older runs. */
  startedAt?: string;
  /** Server-side unattended mode for terminal failure/abort events. */
  unattended?: boolean;
  /** Transport-only marker set by an SSE buffer replay. */
  replay?: boolean;
}

const MAX_BUFFER = 200;

interface ActivityEventRuntime {
  bootId: string;
  seq: number;
  buffer: ActivityEvent[];
  listeners: Set<(event: ActivityEvent) => void>;
}

declare global {
  var __piActivityEventRuntime: ActivityEventRuntime | undefined;
}

function runtime(): ActivityEventRuntime {
  if (!globalThis.__piActivityEventRuntime) {
    globalThis.__piActivityEventRuntime = {
      bootId: randomUUID(),
      seq: 0,
      buffer: [],
      listeners: new Set(),
    };
  }
  return globalThis.__piActivityEventRuntime;
}

/** 广播一条事件（run 事件由 lib/session-activity.ts 写入点调用；session 变更
 *  事件由消息落盘及 sessions/hidden 路由在操作成功后调用）。 */
export function emitActivityEvent(
  event: Omit<ActivityEvent, "seq" | "at" | "kind" | "bootId"> & { kind?: ActivityEventKind },
): ActivityEvent {
  const state = runtime();
  const full: ActivityEvent = { kind: "run", bootId: state.bootId, ...event, seq: ++state.seq, at: Date.now() };
  state.buffer.push(full);
  if (state.buffer.length > MAX_BUFFER) {
    state.buffer.splice(0, state.buffer.length - MAX_BUFFER);
  }
  for (const listener of [...state.listeners]) {
    try {
      listener(full);
    } catch {
      // 单个监听器异常不阻断其他监听器与写入路径。
    }
  }
  return full;
}

/** 订阅事件；返回退订函数。 */
export function subscribeActivityEvents(listener: (event: ActivityEvent) => void): () => void {
  const state = runtime();
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

/** 返回当前进程 seq 之后的事件（含缓冲回放，供晚到订阅者/断线重连补齐）。 */
export function activityEventsSince(sinceSeq: number): ActivityEvent[] {
  return runtime().buffer.filter((event) => event.seq > sinceSeq);
}

/** 当前进程的事件游标；bootId 变化意味着旧 seq 不再可用。 */
export function activityCursor(): { bootId: string; seq: number } {
  const state = runtime();
  return { bootId: state.bootId, seq: state.seq };
}

/** 当前最新 seq（兼容旧调用方）。 */
export function latestActivitySeq(): number {
  return runtime().seq;
}
