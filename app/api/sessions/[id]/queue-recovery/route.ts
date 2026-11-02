import { NextResponse } from "next/server";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { listQueueRecoveries, readQueueRecoveryCopy, confirmQueueRecoveryCopySaved, queueRecoveryHtml, type QueueRecallIdentity } from "@/lib/queue-recall-store";

export const dynamic = "force-dynamic";
function failure(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "queue_recovery_failed";
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error), code }, { status: code === "queue_recovery_missing" ? 404 : 409, headers: { "Cache-Control": "no-store" } });
}
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Request denied" }, { status: 403 });
  const { id } = await params;
  const url = new URL(req.url);
  try {
    const operationId = url.searchParams.get("operationId");
    if (!operationId) return NextResponse.json(listQueueRecoveries(id), { headers: { "Cache-Control": "no-store" } });
    const copy = readQueueRecoveryCopy(id, operationId);
    if (url.searchParams.get("format") === "html") return new Response(queueRecoveryHtml(copy), { headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="reader-queue-recovery-${operationId}.html"`,
      "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
    } });
    return NextResponse.json({ recovery: copy }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Request denied" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "JSON required" }, { status: 415 });
  const { id } = await params;
  try {
    const body = await req.json();
    if (body.action !== "confirm_saved" || body.confirmStored !== true || typeof body.operationId !== "string") {
      return NextResponse.json({ error: "Confirm that you saved and checked the complete copy", code: "queue_recovery_confirmation_required" }, { status: 400 });
    }
    await confirmQueueRecoveryCopySaved(id, body.operationId, body.expected as QueueRecallIdentity);
    return NextResponse.json({ saved: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
