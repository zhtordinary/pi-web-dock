import { getRpcSession, assertRpcSessionRuntimeBinding } from "@/lib/rpc-manager";
import { isApiRequestAllowed } from "@/lib/request-security";
import {
  createReaderStreamWriter,
  registerReaderStreamCloser,
  READER_STREAM_HIGH_WATER_MARK_BYTES,
  type ReaderStreamDiagnostic,
} from "@/lib/reader-event-stream";

export const dynamic = "force-dynamic";

/** A reconnect always starts with a complete authoritative snapshot. Ledger
 * events are discovery hints only: a restarted process has no old promises. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  const { id } = await params;
  const session = getRpcSession(id);
  const absent = { schemaVersion: 1, sessionId: id, runtimeGeneration: null, revision: 0,
    runtimeStatus: "not_live", requests: [], runtimeStartAttempted: false, writeSideEffects: false,
    previousRequests: "invalidated", reason: "No live runtime owns a request resolver" };
  if (session?.isAlive() && !session.isShuttingDown()) await assertRpcSessionRuntimeBinding(session);
  const live = session?.isAlive() && !session.isShuttingDown() ? session : undefined;
  if (new URL(req.url).searchParams.get("stream") !== "1") {
    return Response.json(live?.getPendingUiRequestsSnapshot() ?? absent, { headers: { "Cache-Control": "no-store" } });
  }
  let dispose = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const diagnostic: ReaderStreamDiagnostic = {
        kind: "ui-requests",
        sessionId: id,
        holder: null,
        openedAt: Date.now(),
        connectedAt: null,
        lastWriteAt: null,
        droppedEvents: 0,
        queuedBytes: 0,
      };
      let closed = false;
      let unsubscribe = () => {};
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unregister = () => {};
      let writer: ReturnType<typeof createReaderStreamWriter>;
      const close = (closeController: boolean | "error" = true) => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (heartbeat !== null) clearInterval(heartbeat);
        req.signal.removeEventListener("abort", abort);
        try {
          if (closeController === "error") controller.error(new Error("Reader UI request stream shutting down"));
          else if (closeController) controller.close();
        } catch { /* already closed */ }
        finally { unregister(); }
      };
      writer = createReaderStreamWriter(
        controller,
        diagnostic,
        () => close("error"),
        () => close(true),
      );
      const abort = () => close();
      dispose = () => close(false);
      unregister = registerReaderStreamCloser(close, diagnostic);
      req.signal.addEventListener("abort", abort, { once: true });
      if (req.signal.aborted) { close(); return; }
      if (!live) {
        writer.write(`event: ui_requests\ndata: ${JSON.stringify(absent)}\n\n`);
        writer.flush();
        close();
        return;
      }
      unsubscribe = live.subscribeUiRequests(snapshot => {
        writer.write(`event: ui_requests\ndata: ${JSON.stringify(snapshot)}\n\n`);
        if (snapshot.runtimeStatus === "closed") {
          writer.flush();
          close();
        }
      });
      if (closed) { unsubscribe(); return; }
      if (!writer.flush() || closed) return;
      // Transport keepalive only: never reads a ledger, polls a runtime, or wakes it.
      heartbeat = setInterval(() => writer.write("event: ping\ndata: {}\n\n"), 15_000);
    },
    cancel() { dispose(); },
  }, {
    highWaterMark: READER_STREAM_HIGH_WATER_MARK_BYTES,
    size: (chunk) => chunk.byteLength,
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
