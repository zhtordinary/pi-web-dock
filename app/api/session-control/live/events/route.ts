import { isApiRequestAllowed } from "@/lib/request-security";
import { getRpcSession } from "@/lib/rpc-manager";
import { getSessionWaitChannel } from "@/lib/session-waits";
import { createReaderEventStream } from "@/lib/reader-event-stream";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return new Response("Untrusted API request", { status: 403 });
  let url: URL;
  try { url = new URL(request.url); } catch { return new Response("Invalid request URL", { status: 400 }); }
  if (url.searchParams.get("channel") !== getSessionWaitChannel()) return new Response("Reader channel mismatch", { status: 403 });
  const session = getRpcSession(url.searchParams.get("target") || "");
  if (!session?.isAlive()) return new Response("Target runtime is not live", { status: 404 });
  const project = (snapshot: ReturnType<typeof session.getPendingUiRequestsSnapshot>) => ({
    type: "ui_snapshot", snapshot: {
      sessionId: session.sessionId, sessionFile: session.sessionFile, runtimeGeneration: snapshot.runtimeGeneration, runtimeStatus: snapshot.runtimeStatus, revision: snapshot.revision,
      requests: snapshot.requests.map(({ id, method, expiresAt }) => ({ id, method, ...(expiresAt === undefined ? {} : { expiresAt }) })),
    },
  });
  const stream = createReaderEventStream(request, {
    subscribe(emit, register) { register(session.subscribeUiRequests(snapshot => emit(project(snapshot)))); },
    snapshot() { return [project(session.getPendingUiRequestsSnapshot())]; },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
