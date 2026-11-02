// Share the existing process-wide SSE shutdown registry across Next module graphs.
const registryKey = Symbol.for("pi-web.agentEventStreamClosers");
const closers = ((globalThis as Record<symbol, unknown>)[registryKey] ??= new Set()) as Set<(mode?: boolean | "error") => void>;

export interface ReaderEventStreamSources {
  subscribe: (emit: (event: Record<string, unknown>) => void, register: (stop: () => void) => void) => void;
  snapshot: () => Array<Record<string, unknown>>;
}

/** Install subscriptions before snapshots; abort/cancel/error release every source. */
export function createReaderEventStream(request: Request, sources: ReaderEventStreamSources) {
  let cleanup: (mode?: boolean | "error") => void = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const stops: Array<() => void> = [];
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const onAbort = () => cleanup();
      cleanup = (mode) => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        request.signal.removeEventListener("abort", onAbort);
        closers.delete(cleanup);
        for (const stop of stops.splice(0)) { try { stop(); } catch { /* release other sources */ } }
        try {
          if (mode === "error") controller.error(new Error("Reader notifications shutting down"));
          else controller.close();
        } catch { /* cancelled reader */ }
      };
      const emit = (event: Record<string, unknown>) => {
        if (closed) return;
        // A slow client reconnects and receives authoritative snapshots/replay.
        if ((controller.desiredSize ?? 1) < -256) { cleanup(); return; }
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch { cleanup(); }
      };
      closers.add(cleanup);
      if (request.signal.aborted) { cleanup(); return; }
      request.signal.addEventListener("abort", onAbort, { once: true });
      try {
        sources.subscribe(emit, stop => { if (closed) stop(); else stops.push(stop); });
        if (closed) return;
        for (const event of sources.snapshot()) emit(event);
        if (closed) return;
        heartbeat = setInterval(() => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(`event: ping\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`)); } catch { cleanup(); }
        }, 30000);
      } catch (error) {
        emit({ type: "transport_error", message: error instanceof Error ? error.message : "Notification source unavailable" });
        cleanup();
      }
    },
    cancel() { cleanup(); },
  });
}
