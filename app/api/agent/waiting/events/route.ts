import { getWaitingForUserRequests, subscribeWaitingUserRequests } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// GET /api/agent/waiting/events - SSE stream of sessions currently waiting for
// user input (pending extension UI requests such as ask_user dialogs). Pushes
// an update whenever any session gains or loses a pending request, so the
// reader can play the "wait" sound even for sessions without a mounted
// ChatWindow instance (never opened in this page session, or background
// instance removed after going idle).
export async function GET(req: Request) {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const encode = (data: unknown) => {
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(text));
      };

      // Subscribe BEFORE taking the initial snapshot so no state change can slip
      // through the gap between snapshot and subscription.
      const unsubscribe = subscribeWaitingUserRequests((sessions) => {
        try {
          encode({ type: "waiting_user", sessions });
        } catch {
          // controller already closed
        }
      });

      // Initial snapshot so the client renders the correct state immediately.
      // (A duplicate frame here is harmless: the client dedupes by request id.)
      encode({ type: "waiting_user", sessions: getWaitingForUserRequests() });

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
        try { controller.close(); } catch { /* already closed */ }
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
