/** One drain at a time, one coalesced request, and at most one retry timer. */
export function createWaitDrainScheduler(drain: () => Promise<boolean>, retryMs = 1000) {
  let requested = false;
  let scheduled = false;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  function clearRetry() { if (timer) clearTimeout(timer); timer = null; }
  function request(): void {
    requested = true;
    clearRetry();
    if (running || scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; void flush(); });
  }
  function flush(): Promise<void> {
    requested = true;
    clearRetry();
    if (running) return running;
    running = (async () => {
      let retry = false;
      do {
        requested = false;
        try { retry = await drain(); }
        catch (error) { console.error("[session-wait] owner drain failed:", error); retry = true; }
      } while (requested);
      if (retry) {
        timer = setTimeout(() => { timer = null; request(); }, retryMs);
        timer.unref?.();
      }
    })().finally(() => { running = null; if (requested) request(); });
    return running;
  }
  return { request, flush, cancelRetry: clearRetry };
}
