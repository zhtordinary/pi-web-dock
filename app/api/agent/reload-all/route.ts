import { NextResponse } from "next/server";
import { reloadRpcSessions } from "@/lib/rpc-manager";
import { redactLiveValue } from "@/lib/live-agent-events";

export const dynamic = "force-dynamic";

// POST /api/agent/reload-all - Reload every live session on this Reader host.
// Persisted sessions that have no live runtime are intentionally not started.
export async function POST() {
  try {
    const result = await reloadRpcSessions();
    return NextResponse.json(
      { success: true, data: result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: redactLiveValue(error instanceof Error ? error.message : String(error)) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
