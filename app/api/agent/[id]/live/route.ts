import { NextResponse } from "next/server";
import { LIVE_EVENT_BOOT_ID, LIVE_EVENT_MAX_BYTES, LIVE_EVENT_MAX_EVENTS } from "@/lib/live-agent-events";
import { assertRpcSessionRuntimeBinding, getRpcSession, readStoppedSessionLiveEvents } from "@/lib/rpc-manager";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_BYTES = 64 * 1024;

function boundedInteger(value: string | null, fallback: number, min: number, max: number, name: string): number {
  if (value === null || value === "") return fallback;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(name + " must be a non-negative integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(name + " is outside the supported bound");
  }
  return parsed;
}

function boundedBootId(value: string | null): string | undefined {
  if (value === null || value === "") return undefined;
  if (value.length > 128 || /[\0\r\n]/.test(value)) throw new Error("bootId is invalid");
  return value;
}

/**
 * Read a bounded projection of an already-live runtime.
 *
 * This route intentionally does not resolve a durable session or start a
 * runtime as part of a read:
 * a missing or stopped runtime is reported instead of being rehydrated by a
 * read. The wrapper owns the in-memory cursor and redacted event projection.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const url = new URL(req.url);
    const cursor = boundedInteger(url.searchParams.get("cursor"), 0, 0, Number.MAX_SAFE_INTEGER, "cursor");
    const limit = boundedInteger(url.searchParams.get("limit"), DEFAULT_LIMIT, 1, LIVE_EVENT_MAX_EVENTS, "limit");
    const maxBytes = boundedInteger(url.searchParams.get("maxBytes"), DEFAULT_MAX_BYTES, 4096, LIVE_EVENT_MAX_BYTES, "maxBytes");
    const requestedBootId = boundedBootId(url.searchParams.get("bootId"));
    const session = getRpcSession(id);
    if (!session || !session.isAlive() || session.isShuttingDown()) {
      const snapshot = readStoppedSessionLiveEvents(id, { cursor, limit, maxBytes });
      const common = { ...snapshot, source: "reader-durable-live-ledger", runtimeStatus: "not_live",
        runtimeStartAttempted: false, writeSideEffects: false };
      // Runtime boot IDs contain the Reader process ID as their first part.
      // Report a real process restart even when no runtime has been resumed.
      if (requestedBootId && requestedBootId.split(":")[0] !== LIVE_EVENT_BOOT_ID) {
        return NextResponse.json({ ...common, code: "boot_changed", outcome: "reset_required",
          bootId: null, bootScope: "reader-process", events: [],
        }, { status: 409, headers: { "Cache-Control": "no-store" } });
      }
      if (!snapshot.durableLedger.available || snapshot.durableLedger.writeFailureObserved) {
        return NextResponse.json({ ...common, code: "coverage_incomplete", outcome: "unknown" },
          { status: 503, headers: { "Cache-Control": "no-store" } });
      }
      if (cursor > snapshot.cursor) {
        return NextResponse.json({ ...common, events: [], code: "cursor_ahead", outcome: "reset_required",
          recoverFromCursor: snapshot.cursor,
        }, { status: 409, headers: { "Cache-Control": "no-store" } });
      }
      if (snapshot.durableLedger.gap && cursor < snapshot.durableLedger.gap.recoverFromCursor) {
        return NextResponse.json({ ...common, events: [], code: "gap", outcome: "gap", truncated: true,
          recoverFromCursor: snapshot.durableLedger.gap.recoverFromCursor,
        }, { status: 409, headers: { "Cache-Control": "no-store" } });
      }
      if (cursor < snapshot.oldestCursor - 1) {
        return NextResponse.json({ ...common, events: [], code: "gap", outcome: "gap", truncated: true,
          recoverFromCursor: Math.max(0, snapshot.oldestCursor - 1),
        }, { status: 409, headers: { "Cache-Control": "no-store" } });
      }
      if (snapshot.replayedRuntimeBootId === null) {
        return NextResponse.json({ ...common, code: "runtime_not_live", outcome: "not_live" },
          { status: 404, headers: { "Cache-Control": "no-store" } });
      }
      return NextResponse.json({ ...common, outcome: "replayed", coverageIncomplete: true }, { headers: { "Cache-Control": "no-store" } });
    }
    await assertRpcSessionRuntimeBinding(session);
    const snapshot = session.readLiveEvents({ cursor, limit, maxBytes });
    if (requestedBootId !== undefined && requestedBootId !== snapshot.bootId) {
      return NextResponse.json({
        error: "Live cursor belongs to another Reader runtime",
        code: "boot_changed",
        outcome: "reset_required",
        runtimeStatus: "live",
        bootId: snapshot.bootId,
        sessionId: id,
        runtimeStartAttempted: false,
        writeSideEffects: false,
      }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }

    if (!snapshot.durableLedger.available || snapshot.durableLedger.writeFailureObserved) {
      return NextResponse.json({ ...snapshot, code: "coverage_incomplete", outcome: "unknown",
        runtimeStatus: "live", runtimeStartAttempted: false, writeSideEffects: false,
      }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    if (cursor > snapshot.cursor) {
      return NextResponse.json({ bootId: snapshot.bootId, sessionId: id, code: "cursor_ahead", outcome: "reset_required",
        recoverFromCursor: snapshot.cursor, runtimeStatus: "live", runtimeStartAttempted: false, writeSideEffects: false,
      }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }

    if (snapshot.durableLedger.gap && cursor < snapshot.durableLedger.gap.recoverFromCursor) {
      return NextResponse.json({ bootId: snapshot.bootId, sessionId: id, code: "gap", outcome: "gap", truncated: true,
        recoverFromCursor: snapshot.durableLedger.gap.recoverFromCursor, runtimeStatus: "live",
        runtimeStartAttempted: false, writeSideEffects: false,
      }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }

    const gap = cursor < snapshot.oldestCursor - 1;
    if (gap) {
      return NextResponse.json({
        source: "reader-live-runtime",
        runtimeStatus: "live",
        outcome: "gap",
        code: "gap",
        bootId: snapshot.bootId,
        sessionId: id,
        cursor,
        oldestCursor: snapshot.oldestCursor,
        nextCursor: snapshot.nextCursor,
        truncated: true,
        recoverFromCursor: Math.max(0, snapshot.oldestCursor - 1),
        reason: "The requested range is outside the verified retained ledger; it may follow eviction or unavailable persistence. Read durable history and resume from recoverFromCursor.",
        runtimeStartAttempted: false,
        writeSideEffects: false,
        durableLedger: snapshot.durableLedger,
      }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }

    return NextResponse.json({
      source: "reader-live-runtime",
      runtimeStatus: "live",
      outcome: "observed",
      ...snapshot,
      runtimeStartAttempted: false,
      writeSideEffects: false,
      runtimeStatusSemantics: {
        runtimeStatusValues: ["live", "not_live", "unknown"],
        runtimeChecked: true,
        statusSource: "in-process AgentSession live projection",
        idleDoesNotMeanComplete: true,
        runtimeStartAttempted: false,
        writeSideEffects: false,
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({
      error: "Live event projection unavailable",
      code: "live_projection_failed",
      outcome: "unknown",
      sessionId: id,
      runtimeStartAttempted: false,
      writeSideEffects: false,
    }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
