import { getRpcSession, assertRpcSessionRuntimeBinding } from "@/lib/rpc-manager";
import { isApiRequestAllowed } from "@/lib/request-security";

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
  const encoder = new TextEncoder();
  let dispose = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      const heartbeat: { timer?: ReturnType<typeof setInterval> } = {};
      const close = (cancelled = false) => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (heartbeat.timer) clearInterval(heartbeat.timer);
        req.signal.removeEventListener("abort", abort);
        if (!cancelled) controller.close();
      };
      const abort = () => close();
      dispose = () => close(true);
      const send = (snapshot: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`event: ui_requests\ndata: ${JSON.stringify(snapshot)}\n\n`));
      };
      req.signal.addEventListener("abort", abort, { once: true });
      if (req.signal.aborted) { close(); return; }
      if (!live) { send(absent); close(); return; }
      unsubscribe = live.subscribeUiRequests(snapshot => {
        send(snapshot);
        if (snapshot.runtimeStatus === "closed") close();
      });
      if (closed) { unsubscribe(); return; }
      // Transport keepalive only: never reads a ledger, polls a runtime, or wakes it.
      heartbeat.timer = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode("event: ping\ndata: {}\n\n"));
      }, 15_000);
    },
    cancel() { dispose(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
