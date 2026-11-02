import { recalledQueuedDrafts, queuedImageCount } from "./queued-draft";
import type { QueueRecoveryCopy, QueueRecoveryEntry } from "./queue-recall-store";
import type { ChatDraftImage } from "./draft-store";
import { MAX_ATTACHED_IMAGES } from "./image-attachments";

export type QueueRecoveryInput = {
  availableImageSlots(): number;
  hasQueuedDraft(operationId: string): boolean;
  isQueuedDraftDurable(operationId: string): boolean;
  prependQueuedDraft(text: string, images: ChatDraftImage[], operationId?: string): boolean;
};
export type QueueRecoveryState = {
  entries: QueueRecoveryEntry[];
  loading: boolean;
  busy: { operationId: string; action: "inspect" | "restore" | "export" | "confirm" } | null;
  copy: QueueRecoveryCopy | null;
  error: string | null;
  warnings: string[];
  notice: "memoryOnly" | "restored" | "exported" | "confirmed" | null;
};
export type QueueRecoveryClient = ReturnType<typeof createQueueRecoveryClient>;

export function queueRecoveryUrl(sessionId: string, peer: string | null, operationId?: string, format?: string): string {
  const query = new URLSearchParams();
  if (peer) query.set("peer", peer);
  if (operationId) query.set("operationId", operationId);
  if (format) query.set("format", format);
  return `${peer ? "/api/remote" : "/api"}/sessions/${encodeURIComponent(sessionId)}/queue-recovery${query.size ? `?${query}` : ""}`;
}

/** This controller never sends a model command or clears a queue. It operates
 * only on an already captured server copy under an immutable session/peer. */
export function createQueueRecoveryClient(options: {
  sessionId: string; peer: string | null;
  request?: typeof fetch;
  isCurrent(): boolean;
  input(): QueueRecoveryInput | null;
  changed(state: QueueRecoveryState): void;
  download(html: string, filename: string): void;
  restored?(operationId: string): void;
  settled?(operationId: string): void;
  retainedOperation?(): string | null;
}) {
  let state: QueueRecoveryState = { entries: [], loading: false, busy: null, copy: null, error: null, warnings: [], notice: null };
  let refreshGeneration = 0;
  let interactiveAttempt = false;
  const request = options.request ?? fetch;
  const update = (change: Partial<QueueRecoveryState>) => {
    if (!options.isCurrent()) return;
    state = { ...state, ...change }; options.changed(state);
  };
  async function response(operationId?: string, init?: RequestInit, format?: string) {
    const res = await request(queueRecoveryUrl(options.sessionId, options.peer, operationId, format), { cache: "no-store", ...init });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      // Next's missing-route HTML (or a bare generic 404) identifies an old
      // endpoint. A domain 404 such as Unknown peer/missing copy stays a real
      // read failure; it must never be mistaken for an empty recovery inbox.
      const missingEndpoint = res.status === 404 && !body?.code
        && (!body?.error || /^not found[.!]?$/i.test(body.error));
      if (missingEndpoint) throw Object.assign(new Error("This device does not support queue recovery. Update Reader on that device before recalling or recovering queued messages. No queue action will be retried automatically."), { code: "queue_recovery_unsupported" });
      throw new Error(body?.error || `Queue recovery request failed (${res.status})`);
    }
    return res;
  }
  async function readEntries(): Promise<{ entries: QueueRecoveryEntry[]; warnings: string[]; observedOperationIds: string[] }> {
    // Snapshot only operations already known when the read starts. A delayed
    // empty response must not settle a new copy created while it was in flight.
    const observedOperationIds = new Set(state.entries.map(entry => entry.operationId));
    if (state.copy) observedOperationIds.add(state.copy.operationId);
    const retained = options.retainedOperation?.();
    if (retained) observedOperationIds.add(retained);
    const body = await (await response()).json();
    if (!Array.isArray(body?.recoveries)
      || body.recoveries.some((entry: QueueRecoveryEntry) => !entry || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.operationId ?? "") || !["prepared", "committed"].includes(entry.status))
      || (body.warnings !== undefined && (!Array.isArray(body.warnings) || body.warnings.some((warning: unknown) => typeof warning !== "string")))) throw new Error("This device returned an invalid queue recovery list");
    return { entries: body.recoveries, warnings: body.warnings ?? [], observedOperationIds: [...observedOperationIds] };
  }
  function publishEntries(listing: Awaited<ReturnType<typeof readEntries>>) {
    if (!options.isCurrent()) return;
    const { entries, warnings, observedOperationIds } = listing;
    // A clean, current, complete list can reconcile a lost confirmation reply
    // or another tab's confirmation. Corrupt/partial lists prove no absence.
    const absent = warnings.length ? [] : observedOperationIds.filter(id => !entries.some(entry => entry.operationId === id));
    for (const operationId of absent) options.settled?.(operationId);
    update({ entries, warnings, loading: false, error: null,
      ...(state.copy && absent.includes(state.copy.operationId) ? { copy: null } : {}),
      ...(!entries.length && !warnings.length ? { notice: null } : {}),
    });
  }
  async function ensureAvailable(): Promise<void> {
    interactiveAttempt = true;
    const generation = ++refreshGeneration;
    try {
      if (!options.isCurrent()) throw new Error("The conversation changed before queue recovery could be checked");
      const listing = await readEntries();
      if (!options.isCurrent()) throw new Error("The conversation changed before queue recovery could be checked");
      if (generation === refreshGeneration) publishEntries(listing);
    } catch (failure) {
      const error = failure instanceof Error ? failure : new Error(String(failure));
      if (generation === refreshGeneration) update({ loading: false, error: error.message });
      throw Object.assign(error, { notSent: true });
    }
  }
  async function refresh({ interactive = false }: { interactive?: boolean } = {}) {
    if (!options.isCurrent()) return;
    interactiveAttempt ||= interactive;
    const generation = ++refreshGeneration;
    update({ loading: true });
    try {
      const listing = await readEntries();
      if (generation === refreshGeneration) publishEntries(listing);
    } catch (error) {
      const unsupportedBackground = !interactiveAttempt && !state.entries.length && !state.copy && !state.notice && !state.busy
        && error && typeof error === "object" && "code" in error && error.code === "queue_recovery_unsupported";
      if (generation === refreshGeneration) update({ loading: false, error: unsupportedBackground ? null : error instanceof Error ? error.message : String(error) });
    }
  }
  async function run(operationId: string, action: NonNullable<QueueRecoveryState["busy"]>["action"], work: () => Promise<void>) {
    if (!options.isCurrent() || state.busy) return;
    interactiveAttempt = true;
    update({ busy: { operationId, action }, error: null, notice: null });
    try { await work(); }
    catch (error) { update({ error: error instanceof Error ? error.message : String(error) }); }
    finally { update({ busy: null }); }
  }
  async function load(operationId: string): Promise<QueueRecoveryCopy> {
    const { recovery } = await (await response(operationId)).json();
    if (!recovery || recovery.operationId !== operationId || recovery.sessionId !== options.sessionId
      || !["committed", "prepared"].includes(recovery.status)) throw new Error("Recovery copy identity does not match this session");
    recalledQueuedDrafts(recovery.queue);
    return recovery;
  }
  async function saved(entry: QueueRecoveryEntry) {
    update({ busy: { operationId: entry.operationId, action: "confirm" } });
    await response(undefined, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "confirm_saved", confirmStored: true, operationId: entry.operationId, expected: entry.expected }) });
    if (!options.isCurrent()) return;
    refreshGeneration++;
    options.restored?.(entry.operationId);
    options.settled?.(entry.operationId);
    update({ loading: false, entries: state.entries.filter(item => item.operationId !== entry.operationId), copy: state.copy?.operationId === entry.operationId ? null : state.copy });
  }
  return {
    refresh,
    ensureAvailable,
    get state() { return state; },
    hasDurableDraft(operationId: string) { return options.isCurrent() && options.input()?.isQueuedDraftDurable(operationId) === true; },
    inspect(operationId: string) { return run(operationId, "inspect", async () => { const copy = await load(operationId); update({ copy }); }); },
    restore(operationId: string) { return run(operationId, "restore", async () => {
      const copy = await load(operationId);
      // The hook owns an immutable composer ref for this controller. Its
      // imperative handle changes on ordinary busy-state renders, so resolve
      // the current value only after the read, under the original scope guard.
      if (!options.isCurrent()) return;
      const input = options.input();
      if (!input) return;
      if (copy.status !== "committed") throw new Error("The clear outcome is unknown. Inspect or download this copy; it will not be sent or cleared again.");
      const items = recalledQueuedDrafts(copy.queue);
      const count = queuedImageCount(copy.queue);
      if (!input.hasQueuedDraft(operationId) && count > MAX_ATTACHED_IMAGES) throw new Error(`This copy has ${count} images, exceeding the ${MAX_ATTACHED_IMAGES}-image input limit. Download the complete copy; no images will be discarded.`);
      if (!input.hasQueuedDraft(operationId) && count > input.availableImageSlots()) throw new Error("The current input has too many attachments. Make room or download the complete copy.");
      if (!input.prependQueuedDraft(items.map(item => item.text).filter(text => text.trim()).join("\n\n"), items.flatMap(item => item.images ?? []), operationId)) throw new Error("The input changed. The complete copy is still available here.");
      options.restored?.(operationId);
      if (input.isQueuedDraftDurable(operationId)) {
        await saved(copy);
        update({ notice: "restored" });
      } else update({ notice: "memoryOnly" });
    }); },
    exportCopy(operationId: string) { return run(operationId, "export", async () => {
      const html = await (await response(operationId, undefined, "html")).text();
      if (!options.isCurrent()) return;
      options.download(html, `reader-queue-recovery-${operationId}.html`);
      update({ notice: "exported" });
    }); },
    confirmSaved(entry: QueueRecoveryEntry, confirmed: boolean) { return run(entry.operationId, "confirm", async () => {
      if (!confirmed) throw new Error("Confirm that you saved and checked the complete copy first");
      await saved(entry); update({ notice: "confirmed" });
    }); },
    closeCopy() { update({ copy: null }); },
  };
}
