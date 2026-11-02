import { activityCursor, activityEventsSince, subscribeActivityEvents, type ActivityEvent } from "@/lib/activity-events";
import { subscribeSessionWaitChanges } from "@/lib/session-wait-events";

export const dynamic = "force-dynamic";

// GET /api/activity/events — 本机会话活动事件 SSE 流（跨机 peer 与本机
// 浏览器面板共用）：
// - ?since=<seq>&boot=<bootId>：断点续传；bootId 变化时忽略旧 seq，避免进程
//   重启后新事件被旧游标过滤
// - 无 since：回放全部缓冲（晚到订阅者先拿最近事件）
// 事件一经产生即推送（本机事件总线直接转发），30s 心跳保活。
// （2026-08-17: 移除 long-poll 分支——peer 端改为 SSE 推送长连接，
//   无其他调用方，不留死代码。）
export async function GET(req: Request) {
  return handleSse(req);
}

function handleSse(req: Request): Response {
  const url = new URL(req.url);
  const rawSince = Number(url.searchParams.get("since"));
  const requestedBoot = url.searchParams.get("boot");

  const stream = new ReadableStream({
    start(controller) {
      const cursor = activityCursor();
      const since = requestedBoot === cursor.bootId && Number.isFinite(rawSince) && rawSince > 0 ? rawSince : 0;
      const encoder = new TextEncoder();
      const encode = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // controller already closed
        }
      };

      const unsubscribe = subscribeActivityEvents((event: ActivityEvent) => {
        encode({ type: "activity", ...event });
      });

      const stopWaitChanges = subscribeSessionWaitChanges();

      // 先发送当前 boot 元数据，再回放同一 boot 的事件；客户端发现 boot
      // 变化时会丢弃旧 seq，随后由页面快照补齐状态。
      encode({ type: "activity_meta", bootId: cursor.bootId, seq: cursor.seq });
      for (const event of activityEventsSince(since)) {
        encode({ type: "activity", ...event, replay: true });
      }

      // Heartbeat to keep the connection alive through proxies/timeouts.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        stopWaitChanges();
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
