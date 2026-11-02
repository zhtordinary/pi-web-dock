import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { executeLiveSessionControl } from "@/lib/session-control";
import { trustedSessionPeer } from "@/lib/session-control-remote";
import { getSessionWaitChannel } from "@/lib/session-waits";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await request.json();
    if (body?.channel !== getSessionWaitChannel()) return NextResponse.json({ error: "Reader channel mismatch" }, { status: 403 });
    if (typeof body.caller?.deviceId !== "string" || typeof body.caller.sessionId !== "string" || !body.caller.sessionId.trim()) throw new Error("Caller device and session identity are required");
    trustedSessionPeer(body.caller.deviceId);
    if (!body.params || typeof body.params !== "object" || Array.isArray(body.params)) throw new Error("Session operation is required");
    const result = await executeLiveSessionControl(body.params, `${body.caller.deviceId}:${body.caller.sessionId}`, request.signal);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
