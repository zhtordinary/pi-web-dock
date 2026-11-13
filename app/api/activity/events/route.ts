import { activityCursor, activityEventsSince, subscribeActivityEvents, type ActivityEvent } from "@/lib/activity-events";
import { subscribeSessionWaitChanges } from "@/lib/session-wait-events";
import {
  createReaderStreamWriter,
  registerReaderStreamCloser,
  READER_STREAM_HIGH_WATER_MARK_BYTES,
  type ReaderStreamDiagnostic,
} from "@/lib/reader-event-stream";

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
  let cancelStream: (closeController: boolean | "error") => void = () => {};
  const diagnostic: ReaderStreamDiagnostic = {
    kind: "activity",
    sessionId: null,
    holder: null,
    openedAt: Date.now(),
    connectedAt: null,
    lastWriteAt: null,
    droppedEvents: 0,
    queuedBytes: 0,
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const cursor = activityCursor();
      const rawSince = Number(new URL(req.url).searchParams.get("since"));
      const requestedBoot = new URL(req.url).searchParams.get("boot");
      const since = requestedBoot === cursor.bootId && Number.isFinite(rawSince) && rawSince > 0 ? rawSince : 0;
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe = () => {};
      let stopWaitChanges = () => {};
      let unregister = () => {};
      const writer = createReaderStreamWriter(
        controller,
        diagnostic,
        () => cleanup("error"),
        () => cleanup(true),
      );
      const cleanup = (closeController: boolean | "error" = true) => {
        if (closed) return;
        closed = true;
        if (heartbeat !== null) clearInterval(heartbeat);
        req.signal.removeEventListener("abort", onAbort);
        unsubscribe();
        stopWaitChanges();
        try {
          if (closeController === "error") controller.error(new Error("Reader activity stream shutting down"));
          else if (closeController) controller.close();
        } catch { /* already closed */ }
        finally { unregister(); }
      };
      const onAbort = () => cleanup(true);
      cancelStream = cleanup;
      unregister = registerReaderStreamCloser(cleanup, diagnostic);
      if (req.signal.aborted) {
        cleanup(true);
        return;
      }

      unsubscribe = subscribeActivityEvents((event: ActivityEvent) => {
        writer.write(`data: ${JSON.stringify({ type: "activity", ...event })}\n\n`);
      });
      stopWaitChanges = subscribeSessionWaitChanges();
      req.signal.addEventListener("abort", onAbort, { once: true });

      // 先发送当前 boot 元数据，再回放同一 boot 的事件；客户端发现 boot
      // 变化时会丢弃旧 seq，随后由页面快照补齐状态。
      writer.write(`data: ${JSON.stringify({ type: "activity_meta", bootId: cursor.bootId, seq: cursor.seq })}\n\n`);
      for (const event of activityEventsSince(since)) {
        writer.write(`data: ${JSON.stringify({ type: "activity", ...event, replay: true })}\n\n`);
        if (closed) return;
      }
      if (!writer.flush() || closed) return;

      // Heartbeat to keep the connection alive through proxies/timeouts.
      heartbeat = setInterval(() => writer.write(":\n\n"), 30_000);
    },
    cancel() {
      cancelStream(false);
    },
  }, {
    highWaterMark: READER_STREAM_HIGH_WATER_MARK_BYTES,
    size: (chunk) => chunk.byteLength,
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
