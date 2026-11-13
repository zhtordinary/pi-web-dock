import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { localDeviceId, readActivityConfig } from "@/lib/activity-peers";
import {
  listReaderStreamDiagnostics,
  READER_STREAM_KINDS,
  type ReaderStreamKind,
} from "@/lib/reader-event-stream";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** Observe transport counters only; never expose request metadata or event data. */
export function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: NO_STORE });
  }

  const deviceId = localDeviceId(readActivityConfig());
  try {
    const streams = listReaderStreamDiagnostics().map((stream) => ({
      kind: stream.kind,
      sessionId: stream.sessionId,
      holder: stream.holder,
      openedAt: stream.openedAt,
      connectedAt: stream.connectedAt,
      lastWriteAt: stream.lastWriteAt,
      droppedEvents: stream.droppedEvents,
      queuedBytes: stream.queuedBytes,
    }));
    const counts = {} as Record<ReaderStreamKind, number>;
    for (const stream of streams) counts[stream.kind] = (counts[stream.kind] ?? 0) + 1;
    const uncoveredStreamKinds: ReaderStreamKind[] = [];
    return NextResponse.json({
      schemaVersion: 1,
      deviceId,
      source: "reader-stream-registry",
      capturedAt: new Date().toISOString(),
      coverage: {
        complete: uncoveredStreamKinds.length === 0,
        scope: "in-process-registered-sse-streams",
        streamCount: streams.length,
        readOnly: true,
        streamKinds: { included: [...READER_STREAM_KINDS], excluded: uncoveredStreamKinds },
        includes: ["kind", "sessionId", "holder", "openedAt", "connectedAt", "lastWriteAt", "droppedEvents", "queuedBytes"],
        excludes: ["ip", "userAgent", "requestMetadata", "eventContent"],
        sampling: {
          queuedBytes: "write-time ReadableStream desiredSize estimate; not continuously updated while the consumer drains",
          timestamps: "wall-clock milliseconds captured in process",
        },
      },
      counts,
      streams,
      runtimeStartAttempted: false,
      writeSideEffects: false,
    }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({
      deviceId,
      error: "Reader stream diagnostics are unavailable",
      code: "stream_diagnostics_unavailable",
      coverage: { complete: false, scope: "in-process-long-connections", readOnly: true },
      runtimeStartAttempted: false,
      writeSideEffects: false,
    }, { status: 503, headers: NO_STORE });
  }
}
