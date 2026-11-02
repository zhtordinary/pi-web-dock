import type { QuickAskRunSnapshot } from "./quick-ask-log";
import type { QuickAskLiveEvent, QuickAskRuntime } from "./quick-ask-runtime";

const HEARTBEAT_INTERVAL_MS = 30_000;
const HIGH_WATER_MARK_BYTES = 512 * 1024;

/** Immutable question/attachments are already hydrated by admission/history, not replayed per SSE snapshot. */
function progressView(run: QuickAskRunSnapshot): QuickAskRunSnapshot {
  const entry = run.entry ? { ...run.entry, data: { ...run.entry.data, question: "" } } : undefined;
  if (entry) { delete entry.data.nativeEntries; delete entry.data.images; }
  // Disk run records may carry nativeEntries beyond the public snapshot type.
  // Project the public progress fields explicitly, including cold replay.
  return { id: run.id, threadId: run.threadId, branchId: run.branchId,
    status: run.status, question: "", images: [], answer: run.answer,
    thinking: run.thinking, createdAt: run.createdAt, revision: run.revision,
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(run.errorStatus !== undefined ? { errorStatus: run.errorStatus } : {}),
    ...(entry ? { entry } : {}) };
}

/** An observer only: closing this response never stops the host-owned model task. */
export function createQuickAskEventStream(
  req: Request,
  initial: QuickAskRunSnapshot,
  runtime?: QuickAskRuntime,
  format: "snapshot" | "legacy" = "snapshot",
): ReadableStream<Uint8Array> {
  let detach = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      const timers: { heartbeat?: ReturnType<typeof setInterval> } = {};
      const encoder = new TextEncoder();
      const cleanup = (mode: "close" | "cancel" | "overflow") => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (timers.heartbeat) clearInterval(timers.heartbeat);
        req.signal.removeEventListener("abort", onDisconnect);
        if (mode === "overflow") controller.error(new Error("Side Ask observer backlog exceeded; reconnect for a snapshot"));
        else if (mode === "close") { try { controller.close(); } catch { /* The transport is already detached. */ } }
      };
      const onDisconnect = () => cleanup("close");
      detach = () => cleanup("cancel");
      const send = (value: unknown) => {
        if (closed) return;
        if (controller.desiredSize === null) { cleanup("cancel"); return; }
        if ((controller.desiredSize ?? 0) < 0) { cleanup("overflow"); return; }
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); }
        catch { cleanup("cancel"); }
      };
      const terminal = (run: QuickAskRunSnapshot) => {
        if (run.status === "running") return false;
        if (format === "snapshot") send({ type: "snapshot", run: progressView(run) });
        else if (run.status === "completed" && run.entry) send({ type: "done", run, entry: run.entry });
        else send({ type: "error", run, error: run.error ?? "Side Ask stopped" });
        cleanup("close");
        return true;
      };
      unsubscribe = runtime?.subscribe(initial.id, (event: QuickAskLiveEvent) => {
        if (event.type === "done" || event.type === "error") { terminal(event.run); return; }
        send(event.type === "snapshot" && format === "snapshot" ? { ...event, run: progressView(event.run) } : event);
      }) ?? (() => {});
      if (req.signal.aborted) { cleanup("close"); return; }
      req.signal.addEventListener("abort", onDisconnect, { once: true });
      const snapshot = runtime?.snapshot(initial.id) ?? initial;
      if (format === "snapshot") {
        send({ type: "snapshot", run: progressView(snapshot) });
        if (snapshot.status !== "running") { cleanup("close"); return; }
      }
      else {
        if (snapshot.answer) send({ type: "chunk", delta: snapshot.answer });
        if (snapshot.thinking) send({ type: "thinking", delta: snapshot.thinking });
      }
      if (closed || terminal(snapshot)) return;
      timers.heartbeat = setInterval(() => {
        if (closed) return;
        if ((controller.desiredSize ?? 0) < 0) { cleanup("overflow"); return; }
        try { controller.enqueue(encoder.encode(":\n\n")); } catch { cleanup("cancel"); }
      }, HEARTBEAT_INTERVAL_MS);
    },
    cancel() { detach(); },
  }, { highWaterMark: HIGH_WATER_MARK_BYTES, size: (chunk) => chunk.byteLength });
}
