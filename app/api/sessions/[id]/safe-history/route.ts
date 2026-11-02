import { NextResponse } from "next/server";
import { readSafeSessionHistory, boundedSafeHistoryInteger } from "@/lib/reader-safe-history";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);
  try {
    const result = await readSafeSessionHistory({
      sessionId: id,
      tail: boundedSafeHistoryInteger(url.searchParams.get("tail"), 20, 1, 100, "tail"),
      maxEntries: boundedSafeHistoryInteger(url.searchParams.get("maxEntries"), 20, 1, 100, "maxEntries"),
      maxBytes: boundedSafeHistoryInteger(url.searchParams.get("maxBytes"), 128 * 1024, 4096, 128 * 1024, "maxBytes"),
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({
      error: message,
      code: /not found/i.test(message) ? "session_missing" : "safe_history_failed",
      runtimeStartAttempted: false,
      writeSideEffects: false,
    }, { status: /not found/i.test(message) ? 404 : 500 });
  }
}
