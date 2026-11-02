import type { ActivityEvent } from "./activity-events";

/**
 * 跨机活动事件的共享推动器（2026-08-17 v2，SSE 推送版）。
 *
 * v1（共享长轮询，long-poll）：每 peer 一条在途请求，事件靠轮询拉取，
 * 无事件时延迟上限 ~25s，且每次 poll 的 abort/重连构成连接抖动。
 *
 * v2（SSE 推送）：每 peer 维持一条 SSE 长连接，对端事件一经产生立即推送
 * （毫秒级），对端 30s 心跳保活；断线后按指数退避 + jitter 重连，重连时
 * 携带 bootId + lastSeq 做断点续传。bootId 变化说明对端进程已重启，旧 seq
 * 自动失效并从新进程的缓冲回放。连接状态变化也会通知聚合页刷新设备在线状态。
 *
 * 结构性保证（与 v1 一致）：
 * - 每 peer 至多 1 条在途长连接（不随 UI 面板/流数量增长）
 * - 指数退避（5s→30s）+ 随机 jitter（防多端重启惊群）
 * - 最后一个订阅者退订即断开连接并停止循环
 * - 首个订阅者从 seq 0 开始（对端回放缓冲），后续接续 lastSeq 游标
 */

const PEER_HANG_MS = 90_000; // 无活动超时：对端 30s 心跳，90s 余量充足
const PEER_RETRY_MS = 5_000;
const PEER_RETRY_MAX_MS = 30_000;
const PEER_JITTER_MS = 1_000;

export type PeerConnectionState = "online" | "offline";

export interface PeerPollerSubscription {
  /** 退订：本 peer 的引用数归零时断开共享连接并停止循环。 */
  unsubscribe: () => void;
}

type PeerEventListener = (event: ActivityEvent) => void;
type PeerStateListener = (state: PeerConnectionState) => void;

interface PeerPoller {
  url: string;
  bootId: string | null;
  lastSeq: number;
  listeners: Set<PeerEventListener>;
  stateListeners: Set<PeerStateListener>;
  state: PeerConnectionState | null;
  refs: number;
  stopped: boolean;
  controller: AbortController | null;
}

/** 进程内注册表：key = 规范化 peer baseUrl。 */
const pollers = new Map<string, PeerPoller>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function notifyState(poller: PeerPoller, state: PeerConnectionState): void {
  if (poller.stopped || poller.state === state) return;
  poller.state = state;
  for (const listener of [...poller.stateListeners]) {
    try {
      listener(state);
    } catch {
      // 状态监听器异常不阻断 peer 连接循环。
    }
  }
}

/** 解析单块 SSE 消息的 data: 载荷（心跳 ":" 返回 null）。 */
function parseSseData(block: string): string | null {
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    const prefix = "data:";
    if (line.startsWith(prefix)) dataLines.push(line.slice(prefix.length).trim());
  }
  if (dataLines.length === 0) return null;
  return dataLines.join("\n");
}

/**
 * 消费一条 SSE 流直到结束/出错/停止。返回已到达的最新 seq（无则保持）。
 */
async function consumeStream(
  poller: PeerPoller,
  controller: AbortController,
  onActivity?: () => void,
): Promise<void> {
  const base = poller.url.replace(/\/$/, "");
  const params = new URLSearchParams({ since: String(poller.lastSeq) });
  if (poller.bootId) params.set("boot", poller.bootId);
  const url = `${base}/api/activity/events?${params.toString()}`;
  const response = await fetch(url, {
    cache: "no-store",
    signal: controller.signal,
    headers: { Accept: "text/event-stream" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!response.body) throw new Error("missing response body");
  notifyState(poller, "online");
  onActivity?.();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!poller.stopped) {
      const { done, value } = await reader.read();
      if (done) throw new Error("stream closed by peer");
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = parseSseData(block);
        if (data === null) continue; // 心跳正文
        let event: { type?: unknown; bootId?: unknown; seq?: unknown } & Record<string, unknown>;
        try {
          event = JSON.parse(data);
        } catch {
          continue; // 非 JSON 块忽略
        }
        if (event.type === "activity_meta") {
          if (typeof event.bootId === "string" && event.bootId !== poller.bootId) {
            poller.bootId = event.bootId;
            poller.lastSeq = 0;
          }
          continue;
        }
        if (event.type !== undefined && event.type !== "activity") continue;
        if (typeof event.seq !== "number") continue;
        if (typeof event.bootId === "string" && event.bootId !== poller.bootId) {
          poller.bootId = event.bootId;
          poller.lastSeq = 0;
        }
        const seq = event.seq;
        if (seq > poller.lastSeq) poller.lastSeq = seq;
        for (const listener of [...poller.listeners]) {
          try {
            listener(event as unknown as ActivityEvent);
          } catch {
            // 单个监听器异常不阻断消费循环。
          }
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // reader 已关闭。
    }
  }
}

async function runLoop(poller: PeerPoller): Promise<void> {
  let retryMs = PEER_RETRY_MS;
  while (!poller.stopped) {
    const controller = new AbortController();
    poller.controller = controller;
    let hang: ReturnType<typeof setTimeout> | null = null;
    const resetHang = () => {
      if (hang) clearTimeout(hang);
      hang = setTimeout(() => controller.abort(), PEER_HANG_MS);
      retryMs = PEER_RETRY_MS;
    };
    resetHang();
    try {
      await consumeStream(poller, controller, resetHang);
      retryMs = PEER_RETRY_MS;
    } catch {
      if (!poller.stopped) {
        notifyState(poller, "offline");
        const jitter = Math.floor(Math.random() * PEER_JITTER_MS);
        await sleep(retryMs + jitter);
        retryMs = Math.min(retryMs * 2, PEER_RETRY_MAX_MS);
      }
    } finally {
      if (hang) clearTimeout(hang);
      poller.controller = null;
    }
  }
}

/**
 * 订阅指定 peer 的活动事件流。同一 peer URL 的所有订阅者共享一条 SSE
 * 长连接：首个订阅者创建并启动，最后一个退订时断开并停止。
 */
export function subscribePeerActivity(
  peer: { id: string; url: string },
  onEvent: PeerEventListener,
  onState?: PeerStateListener,
): PeerPollerSubscription {
  const key = peer.url.replace(/\/$/, "");
  let poller = pollers.get(key);
  if (!poller) {
    poller = {
      url: key,
      bootId: null,
      lastSeq: 0,
      listeners: new Set(),
      stateListeners: new Set(),
      state: null,
      refs: 0,
      stopped: false,
      controller: null,
    };
    pollers.set(key, poller);
    void runLoop(poller);
  }
  poller.refs += 1;
  poller.listeners.add(onEvent);
  if (onState) {
    poller.stateListeners.add(onState);
    if (poller.state) onState(poller.state);
  }
  return {
    unsubscribe: () => {
      poller.listeners.delete(onEvent);
      if (onState) poller.stateListeners.delete(onState);
      poller.refs -= 1;
      if (poller.refs <= 0 && !poller.stopped) {
        poller.stopped = true;
        poller.controller?.abort();
        pollers.delete(key);
      }
    },
  };
}
