import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getSessionWaitChannel, getSessionWaitStateRoot } from "@/lib/session-waits";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const core = require("../../../../bin/session-wait-core.cjs") as typeof import("../../../../bin/session-wait-core.cjs");
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return new Response("Untrusted API request", { status: 403 });
  const url = new URL(request.url); const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 100)));
  try { const state = core.withRead(getSessionWaitStateRoot(), getSessionWaitChannel()) as { eventOrder: string[]; events: Record<string, Record<string, unknown>> }; const after = url.searchParams.get("after"); const start = after ? Math.max(-1, state.eventOrder.indexOf(after)) + 1 : Math.max(0, state.eventOrder.length - limit); const ids = state.eventOrder.slice(start, start + limit); return NextResponse.json({ channel: getSessionWaitChannel(), events: ids.map((id) => state.events[id]).filter(Boolean), nextCursor: ids.at(-1) || null }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 }); }
}
