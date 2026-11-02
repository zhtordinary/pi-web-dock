import { createAgentEventStream } from "@/lib/agent-event-stream";
import { getRpcSession, assertRpcSessionRuntimeBinding, subscribeWaitingUserRequests } from "@/lib/rpc-manager";
import { resolveSessionPathReadOnly } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (req.signal.aborted) return new Response(null, { status: 204 });

  const existing = getRpcSession(id);
  const session = existing?.isAlive() ? existing : null;
  if (session) await assertRpcSessionRuntimeBinding(session);
  const sessionFile = session?.sessionFile || await resolveSessionPathReadOnly(id);
  const stream = createAgentEventStream(req, id, Promise.resolve(session), sessionFile || undefined, (publish) => {
    const inspect = () => {
      const live = getRpcSession(id);
      if (live?.isAlive() && !live.isShuttingDown()) publish(assertRpcSessionRuntimeBinding(live).then(() => live));
    };
    // Startup UI must be observable before initialize_runtime can finish.
    const unsubscribe = subscribeWaitingUserRequests((entries) => {
      if (entries.some((entry) => entry.sessionId === id)) inspect();
    });
    inspect();
    return unsubscribe;
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
