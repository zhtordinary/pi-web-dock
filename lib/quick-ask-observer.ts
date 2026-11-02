import type { QuickAskForkResult, QuickAskRunSnapshot } from "./quick-ask-log";
import type { QuickAskLiveEvent } from "./quick-ask-runtime";
import { zhCNLocale } from "./i18n/messages/zh-CN.ts";

type EventSourceLike = Pick<EventSource, "onmessage" | "onerror" | "close">;
/** Translates the user-facing errors these helpers raise. */
type Translate = (key: string, params?: Record<string, string | number>) => string;

const hostErrorKeys = [
  "sidekick.stopped", "sidekick.runDeleted", "sidekick.hostDeletedRequest", "sidekick.hostTransferInProgress",
  "sidekick.hostTopicBusy", "sidekick.hostStopSaveUnconfirmed", "sidekick.hostMoveBusy", "sidekick.hostDifferentAnchors",
  "sidekick.hostMovePending", "sidekick.hostSessionClosed", "sidekick.hostContextWindow",
];

/** Preserve arbitrary provider errors while translating Reader's stable host messages, including older records. */
export function localizeQuickAskError(message: string, t: Translate): string {
  const separator = zhCNLocale.messages["sidekick.hostSaveFailurePrefix"];
  const split = message.indexOf(separator);
  const base = split < 0 ? message : message.slice(0, split);
  const key = hostErrorKeys.find((candidate) => zhCNLocale.messages[candidate] === base);
  return (key ? t(key) : base) + (split < 0 ? "" : t("sidekick.hostSaveFailurePrefix") + message.slice(split + separator.length));
}

interface QuickAskObserverOptions {
  url: string;
  run: QuickAskRunSnapshot;
  signal: AbortSignal;
  t: Translate;
  onRun(run: QuickAskRunSnapshot): void;
  onError(error: Error): void;
  onDeleted?(): void;
  fetcher?: typeof fetch;
  eventSource?: (url: string) => EventSourceLike;
}

/** Null means a positively identified deletion; missing, foreign or unavailable state stays an error. */
export async function readQuickAskRun(options: {
  url: string;
  run: Pick<QuickAskRunSnapshot, "id" | "threadId" | "branchId">;
  signal: AbortSignal;
  t: Translate;
  fetcher?: typeof fetch;
}): Promise<QuickAskRunSnapshot | null> {
  const url = new URL(options.url, typeof location === "undefined" ? "http://reader.invalid" : location.href);
  url.searchParams.set("runId", options.run.id);
  url.searchParams.delete("stream");
  const endpoint = options.url.startsWith("/") ? `${url.pathname}${url.search}` : url.href;
  const response = await (options.fetcher ?? fetch)(endpoint, { signal: options.signal, cache: "no-store" });
  const value = await response.json() as { run?: QuickAskRunSnapshot; error?: string; code?: string; runId?: string; threadId?: string; branchId?: string };
  if (response.status === 410 && value.code === "quick_ask_deleted" && value.runId === options.run.id
    && value.threadId === options.run.threadId && value.branchId === options.run.branchId) return null;
  if (!response.ok || !value.run) throw new Error(value.error ? localizeQuickAskError(value.error, options.t) : options.t("sidekick.runStatusUnconfirmed", { status: response.status }));
  if (value.run.id !== options.run.id || value.run.threadId !== options.run.threadId || value.run.branchId !== options.run.branchId) {
    throw new Error(options.t("sidekick.queryOwnershipMismatch"));
  }
  return value.run;
}

/** Reconnect to one admitted task. Transport cancellation never sends a task-stop command. */
export function observeQuickAskRun(options: QuickAskObserverOptions): () => void {
  let current = options.run;
  let source: EventSourceLike | undefined;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryMs = 1_000;
  let recovery: AbortController | undefined;
  const detach = () => {
    if (closed) return;
    closed = true;
    source?.close();
    if (retry) clearTimeout(retry);
    recovery?.abort();
    options.signal.removeEventListener("abort", detach);
  };
  const apply = (next: QuickAskRunSnapshot) => {
    if (closed || options.signal.aborted) return;
    if (next.id !== current.id || next.threadId !== current.threadId || next.branchId !== current.branchId) {
      throw new Error(options.t("sidekick.streamOwnershipMismatch"));
    }
    if (next.entry && (next.entry.data.threadId !== current.threadId
      || next.entry.data.branchId !== current.branchId)) {
      throw new Error(options.t("sidekick.resultOwnershipMismatch"));
    }
    // A process restart may leave only the durable admission. Its interrupted
    // terminal state is authoritative even when live-only deltas had higher revisions.
    if (next.revision < current.revision && next.status === "running") return;
    const entry = next.entry ? { ...next.entry, data: { ...next.entry.data, question: current.question } } : undefined;
    if (entry) {
      if (current.images.length) entry.data.images = current.images;
      else delete entry.data.images;
    }
    current = { ...next, question: current.question, images: current.images, ...(entry ? { entry } : {}) };
    options.onRun(current);
    if (current.status !== "running") detach();
  };
  if (options.signal.aborted) return detach;
  options.signal.addEventListener("abort", detach, { once: true });
  apply(current);
  if (closed) return detach;
  const url = new URL(options.url, typeof location === "undefined" ? "http://reader.invalid" : location.href);
  url.searchParams.set("runId", current.id);
  url.searchParams.set("stream", "1");
  const endpoint = options.url.startsWith("/") ? `${url.pathname}${url.search}` : url.href;
  const reconcile = async () => {
    if (closed || options.signal.aborted || recovery) return;
    const controller = new AbortController();
    recovery = controller;
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const run = await readQuickAskRun({ url: options.url, run: current, signal: controller.signal, t: options.t, fetcher: options.fetcher });
      if (closed || controller.signal.aborted) return;
      if (run === null) {
        detach();
        if (options.onDeleted) options.onDeleted();
        else options.onError(new Error(options.t("sidekick.runDeleted")));
      } else {
        try { apply(run); }
        catch (error) { detach(); options.onError(error instanceof Error ? error : new Error(String(error))); }
      }
    } catch { /* An unavailable or older host cannot prove deletion; the stream keeps its normal backoff. */ }
    finally {
      clearTimeout(timeout);
      if (recovery === controller) recovery = undefined;
    }
  };
  const reconnect = () => {
    if (closed || options.signal.aborted || retry) return;
    const previous = source;
    source = undefined;
    previous?.close();
    retry = setTimeout(() => { retry = undefined; connect(); void reconcile(); }, retryMs);
    retryMs = Math.min(30_000, retryMs * 2);
  };
  const connect = () => {
    if (closed || options.signal.aborted) return;
    const connection = (options.eventSource ?? ((value) => new EventSource(value)))(endpoint);
    source = connection;
    connection.onmessage = (message) => {
      if (closed || options.signal.aborted || source !== connection) return;
      try {
        const event = JSON.parse(message.data) as QuickAskLiveEvent;
        if (event.type === "snapshot" || event.type === "error") apply(event.run);
        else if (event.type === "done") apply({ ...event.run, entry: event.entry });
        else if ((event.type === "chunk" || event.type === "thinking") && event.runId === current.id && event.revision > current.revision) {
          if (event.revision !== current.revision + 1) { reconnect(); return; }
          apply({ ...current, revision: event.revision,
            ...(event.type === "chunk" ? { answer: current.answer + event.delta } : { thinking: current.thinking + event.delta }) });
        }
        retryMs = 1_000;
      } catch (error) {
        detach();
        options.onError(error instanceof Error ? error : new Error(String(error)));
      }
    };
    // Retry the same observer after both network errors and terminal HTTP errors
    // such as a temporarily unavailable remote peer. Never resubmit the question.
    connection.onerror = () => { if (source === connection) reconnect(); };
  };
  connect();
  return detach;
}

/** Conversion keeps running on the host while this client only observes its commit boundary. */
export async function requestQuickAskFork(options: {
  url: string;
  body: { threadId?: string; targetId?: string; branchId: string };
  signal: AbortSignal;
  t: Translate;
  fetcher?: typeof fetch;
  eventSource?: QuickAskObserverOptions["eventSource"];
}): Promise<QuickAskForkResult> {
  while (true) {
    options.signal.throwIfAborted();
    const response = await (options.fetcher ?? fetch)(options.url, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: options.signal,
      body: JSON.stringify({ action: "fork", wait: false, ...options.body }),
    });
    const value = await response.json() as Partial<QuickAskForkResult> & { pending?: boolean; run?: QuickAskRunSnapshot; error?: string };
    if (!response.ok || !value.success) throw new Error(value.error ? localizeQuickAskError(value.error, options.t) : options.t("sidekick.forkSessionFailed"));
    if (response.status !== 202) {
      if (!value.newSessionId || !value.newSessionPath) throw new Error(options.t("sidekick.forkResultIncomplete"));
      return value as QuickAskForkResult;
    }
    if (!value.pending || !value.run) throw new Error(options.t("sidekick.forkStateIncomplete"));
    await new Promise<void>((resolve, reject) => {
      let detach = () => {};
      const abort = () => { detach(); reject(options.signal.reason); };
      options.signal.addEventListener("abort", abort, { once: true });
      const complete = () => { options.signal.removeEventListener("abort", abort); resolve(); };
      try {
        if (options.signal.aborted) { abort(); return; }
        detach = observeQuickAskRun({ url: options.url, run: value.run!, signal: options.signal, t: options.t, eventSource: options.eventSource, fetcher: options.fetcher,
          onRun: (run) => { if (run.status !== "running") complete(); },
          onDeleted: () => { options.signal.removeEventListener("abort", abort); reject(new Error(options.t("sidekick.forkDeleted"))); },
          onError: (error) => { options.signal.removeEventListener("abort", abort); reject(error); },
        });
      } catch (error) { options.signal.removeEventListener("abort", abort); reject(error); }
    });
  }
}
