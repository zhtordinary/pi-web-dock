// Share the process-wide SSE shutdown registry across Next module graphs.
const registryKey = Symbol.for("pi-web.agentEventStreamClosers");
const diagnosticKey = Symbol.for("pi-web.agentEventStreamDiagnostics");

export type ReaderStreamCloseMode = boolean | "error";
export type ReaderStreamKind =
  | "agent"
  | "reader-events"
  | "activity"
  | "terminal"
  | "file-watch"
  | "ui-requests"
  | "quick-ask"
  | "provider-login";

export const READER_STREAM_KINDS: readonly ReaderStreamKind[] = [
  "agent",
  "reader-events",
  "activity",
  "terminal",
  "file-watch",
  "ui-requests",
  "quick-ask",
  "provider-login",
];

export interface ReaderStreamDiagnostic {
  kind: ReaderStreamKind;
  sessionId: string | null;
  holder: string | null;
  openedAt: number;
  connectedAt: number | null;
  lastWriteAt: number | null;
  droppedEvents: number;
  queuedBytes: number;
}

export const READER_STREAM_HIGH_WATER_MARK_BYTES = 256 * 1024;

export type ReaderStreamCloser = (mode?: ReaderStreamCloseMode) => void;

type ReaderStreamController = ReadableStreamDefaultController<Uint8Array>;

/**
 * Buffer startup frames as one transport chunk. A single large snapshot is
 * valid; later writes hard-fail once that chunk fills the stream queue.
 */
export function createReaderStreamWriter(
  controller: ReaderStreamController,
  diagnostic: ReaderStreamDiagnostic,
  onOverflow: () => void,
  onEnqueueError: () => void,
) {
  const encoder = new TextEncoder();
  let bufferingStartup = true;
  const startupFrames: string[] = [];
  const enqueue = (text: string): boolean => {
    const desiredSize = controller.desiredSize;
    if (desiredSize === null) {
      onEnqueueError();
      return false;
    }
    if (desiredSize <= 0) {
      diagnostic.droppedEvents += 1;
      onOverflow();
      return false;
    }
    try {
      controller.enqueue(encoder.encode(text));
      const now = Date.now();
      diagnostic.connectedAt ??= now;
      diagnostic.lastWriteAt = now;
      diagnostic.queuedBytes = Math.max(0, READER_STREAM_HIGH_WATER_MARK_BYTES - (controller.desiredSize ?? READER_STREAM_HIGH_WATER_MARK_BYTES));
      return true;
    } catch {
      onEnqueueError();
      return false;
    }
  };
  return {
    write(text: string): boolean {
      if (bufferingStartup) {
        startupFrames.push(text);
        return true;
      }
      return enqueue(text);
    },
    flush(): boolean {
      if (!bufferingStartup) return true;
      bufferingStartup = false;
      const frames = startupFrames.splice(0);
      if (frames.length === 0) return true;
      const totalBytes = frames.reduce((total, frame) => total + encoder.encode(frame).byteLength, 0);
      if (totalBytes > READER_STREAM_HIGH_WATER_MARK_BYTES) return enqueue(frames.join(""));
      for (const frame of frames) {
        if (!enqueue(frame)) return false;
      }
      return true;
    },
  };
}

const closers = ((globalThis as Record<symbol, unknown>)[registryKey] ??= new Set<ReaderStreamCloser>()) as Set<ReaderStreamCloser>;
const diagnostics = ((globalThis as Record<symbol, unknown>)[diagnosticKey] ??= new Map<ReaderStreamCloser, ReaderStreamDiagnostic>()) as Map<ReaderStreamCloser, ReaderStreamDiagnostic>;

export function registerReaderStreamCloser(
  closer: ReaderStreamCloser,
  diagnostic?: ReaderStreamDiagnostic,
): () => void {
  closers.add(closer);
  if (diagnostic) diagnostics.set(closer, diagnostic);
  return () => {
    closers.delete(closer);
    diagnostics.delete(closer);
  };
}

/** Close every live SSE stream (called on process shutdown signals). */
export function closeAllReaderEventStreams(): void {
  for (const close of [...closers]) {
    try { close("error"); } catch { /* stream already closed */ }
  }
}

/** Return transport counters only; never includes request metadata or event data. */
export function listReaderStreamDiagnostics(): ReaderStreamDiagnostic[] {
  return [...diagnostics.values()]
    .map((diagnostic) => ({ ...diagnostic }))
    .sort((left, right) => left.openedAt - right.openedAt);
}

export interface ReaderEventStreamSources {
  subscribe: (emit: (event: Record<string, unknown>) => void, register: (stop: () => void) => void) => void;
  snapshot: () => Array<Record<string, unknown>>;
}

/** Install subscriptions before snapshots; abort/cancel/error release every source. */
export function createReaderEventStream(
  request: Request,
  sources: ReaderEventStreamSources,
  options: { kind?: ReaderStreamKind; sessionId?: string | null; holder?: string | null } = {},
) {
  let cleanup: ReaderStreamCloser = () => {};
  let unregister = () => {};
  const diagnostic: ReaderStreamDiagnostic = {
    kind: options.kind ?? "reader-events",
    sessionId: options.sessionId ?? null,
    holder: options.holder ?? null,
    openedAt: Date.now(),
    connectedAt: null,
    lastWriteAt: null,
    droppedEvents: 0,
    queuedBytes: 0,
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const stops: Array<() => void> = [];
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let writer: ReturnType<typeof createReaderStreamWriter>;
      const onAbort = () => cleanup();
      cleanup = (mode) => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        request.signal.removeEventListener("abort", onAbort);
        for (const stop of stops.splice(0)) { try { stop(); } catch { /* release other sources */ } }
        try {
          if (mode === "error") controller.error(new Error("Reader notifications shutting down"));
          else controller.close();
        } catch { /* cancelled reader */ }
        finally { unregister(); }
      };
      writer = createReaderStreamWriter(
        controller,
        diagnostic,
        () => cleanup("error"),
        () => cleanup(true),
      );
      const emit = (event: Record<string, unknown>) => {
        if (closed) return;
        // A slow client reconnects and receives authoritative snapshots/replay.
        try { writer.write(`data: ${JSON.stringify(event)}\n\n`); } catch { cleanup(); }
      };
      unregister = registerReaderStreamCloser(cleanup, diagnostic);
      if (request.signal.aborted) { cleanup(); return; }
      request.signal.addEventListener("abort", onAbort, { once: true });
      try {
        sources.subscribe(emit, stop => { if (closed) stop(); else stops.push(stop); });
        if (closed) return;
        for (const event of sources.snapshot()) emit(event);
        if (closed) return;
        if (!writer.flush() || closed) return;
        heartbeat = setInterval(() => {
          if (closed) return;
          try { writer.write(`event: ping\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`); } catch { cleanup(); }
        }, 30000);
      } catch (error) {
        emit({ type: "transport_error", message: error instanceof Error ? error.message : "Notification source unavailable" });
        if (!closed) writer.flush();
        if (!closed) cleanup();
      }
    },
    cancel() { cleanup(); },
  }, {
    highWaterMark: READER_STREAM_HIGH_WATER_MARK_BYTES,
    size: (chunk) => chunk.byteLength,
  });
}
