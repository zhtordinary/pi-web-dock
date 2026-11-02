import { configuredPeerList, localDeviceIdentity, readActivityConfig } from "@/lib/activity-peers";
import { activityEventsSince, subscribeActivityEvents } from "@/lib/activity-events";
import { subscribePeerActivity } from "@/lib/peer-activity-poller";

export const dynamic = "force-dynamic";

// GET /api/activity/relay - 浏览器聚合事件流（SSE）：
// 本机 run 事件 + 各 peer SSE 转发（事件带 peer 设备 id）。聚合页/侧栏
// 打开时订阅 → 状态音与列表刷新即时；peer 离线/恢复通过连接状态事件触发快照。
//
// 聚合流共享每个 peer 的连接，避免面板数量增长时产生过多连接。
export async function GET(req: Request) {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const encode = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // controller already closed
        }
      };
      const config = readActivityConfig();
      const local = localDeviceIdentity(config, new Date().toISOString());
      const peers = configuredPeerList(config, local);
      const cleanupFns: Array<() => void> = [];

      // 本机事件先订阅再回放缓冲，避免首屏快照尚未返回时丢失终态事件。
      cleanupFns.push(
        subscribeActivityEvents((event) => {
          encode({ type: "activity", device: local.id, ...event });
        }),
      );
      for (const event of activityEventsSince(0)) {
        encode({ type: "activity", device: local.id, ...event, replay: true });
      }

      // 每个 peer 一条共享 SSE（引用计数；最后订阅者断开即停止）。
      for (const peer of peers) {
        const subscription = subscribePeerActivity(
          peer,
          (event) => encode({ type: "activity", device: peer.id, ...event }),
          (state) => encode({ type: "peer_state", device: peer.id, online: state === "online" }),
        );
        cleanupFns.push(() => subscription.unsubscribe());
      }

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);
      cleanupFns.push(() => clearInterval(heartbeat));

      const cleanup = () => {
        for (const fn of cleanupFns) fn();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      req.signal?.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
