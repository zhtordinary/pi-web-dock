export type SessionWaitFetch = typeof fetch;

export function sessionWaitApiPath(peerId?: string | null): string {
  return peerId ? `/api/remote/session-control?peer=${encodeURIComponent(peerId)}` : "/api/session-control";
}

export async function fetchSessionWaitStatus(peerId: string | null | undefined, fetcher: SessionWaitFetch = fetch): Promise<Response> {
  return fetcher(sessionWaitApiPath(peerId), { cache: "no-store" });
}

export async function fetchAllSessionWaitStatus(fetcher: SessionWaitFetch = fetch, options: RequestInit = {}): Promise<Response> {
  return fetcher("/api/session-control?scope=all", { ...options, cache: "no-store" });
}

export async function postSessionWaitControl(peerId: string | null | undefined, body: Record<string, unknown>, fetcher: SessionWaitFetch = fetch): Promise<Response> {
  return fetcher(sessionWaitApiPath(peerId), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** Coalesce invalidations and discard obsolete peer/state responses without losing a trailing update. */
export function createWaitStatusRefresher<T>(read: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void, failed: (error: unknown) => void) {
  let revision = 0, disposed = false, controller: AbortController | undefined;
  let inFlight: Promise<void> | undefined;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  function refresh(): Promise<void> {
    revision++;
    if (inFlight) return inFlight;
    if (trailing) return Promise.resolve();
    if (disposed) return Promise.resolve();
    inFlight = (async () => {
      let observed: number, reads = 0;
      do {
        observed = revision;
        controller = new AbortController();
        try {
          const value = await read(controller.signal);
          // Reads are serialized: a result cannot overwrite a newer applied read.
          // Keep progress visible even when worker events arrive continuously.
          if (!disposed) apply(value);
        } catch (error) {
          if (!disposed) failed(error);
        }
      } while (!disposed && observed !== revision && ++reads < 2);
      if (!disposed && observed !== revision) trailing = setTimeout(() => { trailing = undefined; void refresh(); }, 100);
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  }
  return { refresh, dispose() { disposed = true; controller?.abort(); if (trailing) clearTimeout(trailing); } };
}
