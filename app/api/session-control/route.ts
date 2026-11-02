import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readAggregatedSessionWaitStatus, readSessionWaitSnapshot } from "@/lib/session-wait-aggregate";
import { applyPersistentEvent, createHandoffPlan, createPersistentWait, enqueueStructuredExternalTask, recoverPersistentWaitState, transitionPersistentWait } from "@/lib/session-waits";
export const dynamic = "force-dynamic";
function deny(json = false) { return json ? NextResponse.json({ error: "Untrusted API request" }, { status: 403 }) : new Response("Untrusted API request", { status: 403 }); }
function errorResponse(error: unknown, status = 400) { return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status }); }
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return deny();
  try {
    const url = new URL(request.url);
    const snapshot = url.searchParams.get("scope") === "all"
      ? await readAggregatedSessionWaitStatus()
      : await readSessionWaitSnapshot({ ...(url.searchParams.get("waitId") ? { waitId: url.searchParams.get("waitId") } : {}), ...(url.searchParams.get("planId") ? { planId: url.searchParams.get("planId") } : {}) });
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  }
  catch (error) { return errorResponse(error, 500); }
}
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return deny(true);
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch (error) { return errorResponse(error); }
  const operation = typeof body.operation === "string" ? body.operation : "status";
  try {
    if (operation === "wait") return NextResponse.json({ ok: true, wait: createPersistentWait(body) });
    if (operation === "plan") return NextResponse.json({ ok: true, ...createHandoffPlan(body) });
    if (operation === "event" || operation === "report") return NextResponse.json({ ok: true, result: applyPersistentEvent(body.event && typeof body.event === "object" ? body.event as Record<string, unknown> : body) });
    if (operation === "pause" || operation === "cancel" || operation === "resume") { if (typeof body.waitId !== "string") throw new Error(`${operation} requires waitId`); return NextResponse.json({ ok: true, wait: transitionPersistentWait(body.waitId, operation, typeof body.reason === "string" ? body.reason : undefined) }); }
    if (operation === "external_task") return NextResponse.json({ ok: true, task: enqueueStructuredExternalTask(body.task && typeof body.task === "object" ? body.task as Record<string, unknown> : body) });
    if (operation === "recover") return NextResponse.json({ ok: true, state: recoverPersistentWaitState() });
    throw new Error(`unsupported session-control operation: ${operation}`);
  } catch (error) { return errorResponse(error); }
}
