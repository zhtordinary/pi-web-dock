import { hasTerminal, subscribeTerminal, type TerminalEvent } from "@/lib/terminal-manager";
import {
  createReaderStreamWriter,
  registerReaderStreamCloser,
  READER_STREAM_HIGH_WATER_MARK_BYTES,
  type ReaderStreamDiagnostic,
} from "@/lib/reader-event-stream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!hasTerminal(id)) return new Response("Terminal not found", { status: 404 });
  const cursor = req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("after");
  const after = cursor !== null && /^\d+$/.test(cursor) && Number.isSafeInteger(Number(cursor))
    ? Number(cursor) : undefined;

  let closeStream: (closeController: boolean) => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const diagnostic: ReaderStreamDiagnostic = {
        kind: "terminal",
        sessionId: id,
        holder: null,
        openedAt: Date.now(),
        connectedAt: null,
        lastWriteAt: null,
        droppedEvents: 0,
        queuedBytes: 0,
      };
      let unregister = () => {};
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: (() => void) | null = null;
      const writer = createReaderStreamWriter(
        controller,
        diagnostic,
        () => cleanup("error"),
        () => cleanup(true),
      );
      const cleanup = (closeController: boolean | "error" = true) => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        req.signal.removeEventListener("abort", abort);
        try {
          if (closeController === "error") controller.error(new Error("Reader terminal stream shutting down"));
          else if (closeController) controller.close();
        } catch { /* already closed */ }
        finally { unregister(); }
      };
      const abort = () => cleanup(true);
      const write = (text: string) => {
        writer.write(text);
      };
      const send = (event: TerminalEvent) => {
        if (closed) return;
        try {
          const eventId = event.type === "output" ? `id: ${event.offset}\n` : "";
          write(`${eventId}data: ${JSON.stringify(event)}\n\n`);
          if (event.type === "exit" || event.type === "closed") {
            writer.flush();
            cleanup(true);
          }
        } catch {
          cleanup(false);
        }
      };
      closeStream = cleanup;
      unregister = registerReaderStreamCloser(cleanup, diagnostic);
      const subscription = subscribeTerminal(id, send, after);
      if (!subscription) {
        cleanup(true);
        return;
      }
      unsubscribe = subscription.unsubscribe;
      write(":\n\n");
      send(subscription.output);
      if (subscription.exited) send({ type: "exit", exitCode: subscription.exitCode ?? 0 });
      if (closed) return;
      if (!writer.flush() || closed) return;
      req.signal.addEventListener("abort", abort, { once: true });
      if (req.signal.aborted) {
        abort();
        return;
      }
      heartbeat = setInterval(() => {
        try {
          if (!closed) write(":\n\n");
        } catch { cleanup(false); }
      }, 30_000);
    },
    cancel() {
      closeStream(false);
    },
  }, { highWaterMark: READER_STREAM_HIGH_WATER_MARK_BYTES, size: (chunk) => chunk.byteLength });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
