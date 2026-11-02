import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPathReadOnly } from "@/lib/session-reader";
import { getSessionBackgroundRunIds } from "@/lib/subagent-activity";
import { controlSiblingSession } from "@/lib/session-channel-control";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isApiRequestAllowed(req) || !hasJsonContentType(req)) return NextResponse.json({ error: "Request denied" }, { status: 403 });
  const errors: string[] = [];
  let stopped = false;
  let queuedCount = 0;
  try {
    const rpc = getRpcSession(id);
    if (rpc?.isAlive()) {
      const result = await rpc.stopAllExecution();
      stopped = result.stopped;
      queuedCount = result.state.queuedCount;
      errors.push(...result.errors);
    } else {
      stopped = true;
    }
    if (new URL(req.url).searchParams.get("local") !== "1") {
      const sibling = await controlSiblingSession(id, "stop");
      if (sibling) { stopped = stopped && sibling.stopped === true; queuedCount += sibling.queuedCount ?? 0; errors.push(...(sibling.errors ?? [])); }
    }
    const path = await resolveSessionPathReadOnly(id);
    const runs = path ? getSessionBackgroundRunIds({ id, path }) : [];
    if (runs.length) { stopped = false; errors.push(`Background tasks have not exited: ${runs.join(", ")}`); }
  } catch (error) { stopped = false; errors.push(error instanceof Error ? error.message : String(error)); }
  return NextResponse.json({ protocol: 1, sessionId: id, stopped: stopped && errors.length === 0, queuedCount, errors });
}
