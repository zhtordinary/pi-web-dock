import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { listReaderRuntimeSafetySnapshot } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** Observe every in-process runtime; this snapshot is not a restart authorization. */
export function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: NO_STORE });
  }

  try {
    const snapshot = listReaderRuntimeSafetySnapshot();
    // Keep this wire projection explicit: future internal snapshot fields must
    // not expose cwd, prompts, user-interaction details, or credentials.
    return NextResponse.json({
      schemaVersion: snapshot.schemaVersion,
      source: snapshot.source,
      bootId: snapshot.bootId,
      capturedAt: snapshot.capturedAt,
      coverage: {
        complete: snapshot.coverage.complete,
        scope: snapshot.coverage.scope,
        runtimeCount: snapshot.coverage.runtimeCount,
        startingRuntimeCount: snapshot.coverage.startingRuntimeCount,
        pendingRuntimeMutationCount: snapshot.coverage.pendingRuntimeMutationCount,
        readOnly: snapshot.coverage.readOnly,
      },
      runtimeStartAttempted: snapshot.runtimeStartAttempted,
      writeSideEffects: snapshot.writeSideEffects,
      runtimes: snapshot.runtimes.map((runtime) => ({
        sessionId: runtime.sessionId,
        bootId: runtime.bootId,
        isAlive: runtime.isAlive,
        isShuttingDown: runtime.isShuttingDown,
        isRunning: runtime.isRunning,
        settingsMutationPending: runtime.settingsMutationPending,
        isStreaming: runtime.isStreaming,
        isPromptRunning: runtime.isPromptRunning,
        isBashRunning: runtime.isBashRunning,
        isCompacting: runtime.isCompacting,
        waiting: runtime.waiting,
        queueRevision: runtime.queueRevision,
        queueCounts: {
          steering: runtime.queueCounts.steering,
          followUp: runtime.queueCounts.followUp,
          total: runtime.queueCounts.total,
        },
      })),
    }, { headers: NO_STORE });
  } catch {
    // A failed read cannot be interpreted as an empty, restart-safe registry.
    return NextResponse.json({
      error: "Reader runtime catalog is unavailable",
      code: "runtime_catalog_unavailable",
      coverage: { complete: false, scope: "all-in-process-runtimes" },
      runtimeStartAttempted: false,
      writeSideEffects: false,
    }, { status: 503, headers: NO_STORE });
  }
}
