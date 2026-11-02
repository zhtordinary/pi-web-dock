import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPathReadOnly } from "@/lib/session-reader";
import { closeIdleSession } from "@/lib/session-close";
import { controlSiblingSession } from "@/lib/session-channel-control";
import { isApiRequestAllowed } from "@/lib/request-security";

/** Close idle instances without moving history or starting a runtime. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Request denied" }, { status: 403 });
  try {
    const rpc = getRpcSession(id);
    const hadRuntime = rpc?.isAlive() === true;
    const file = rpc?.sessionFile || await resolveSessionPathReadOnly(id);
    if (!file && new URL(req.url).searchParams.get("local") !== "1") return NextResponse.json({ error: "Session not found" }, { status: 404 });
    if (file) await closeIdleSession(id, file);
    if (new URL(req.url).searchParams.get("local") !== "1") await controlSiblingSession(id, "shutdown");
    return NextResponse.json({ protocol: 1, sessionId: id, ok: true, running: false, hadRuntime });
  } catch (error) {
    return NextResponse.json({ protocol: 1, sessionId: id, error: String(error) }, {
      status: (error as { code?: string }).code === "session_busy" ? 409 : 503,
    });
  }
}
