import type { ChatDraftImage } from "./draft-store";

/** Reader identity, never text, owns a queued occurrence and its attachments. */
export type QueuedDraftMessage = {
  itemId: string;
  role: string;
  customType?: string;
  text: string;
  hasImages: boolean;
  imageCount: number;
  /** Included only when recalling, not in the frequently broadcast summary. */
  images?: ChatDraftImage[];
};

export type QueuedDraftState = {
  bootId: string;
  queueRevision: number;
  steering: QueuedDraftMessage[];
  followUp: QueuedDraftMessage[];
};

export type QueuedDraftSummary = {
  itemId?: string;
  text: string;
  hasImages: boolean;
};

export function readQueuedDraftState(value: unknown): QueuedDraftState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<QueuedDraftState>;
  if (typeof state.bootId !== "string" || !state.bootId
    || !Number.isSafeInteger(state.queueRevision) || state.queueRevision! < 0
    || !Array.isArray(state.steering) || !Array.isArray(state.followUp)) return null;
  const seen = new Set<string>();
  for (const item of [...state.steering, ...state.followUp]) {
    if (!item || typeof item.itemId !== "string" || !item.itemId || seen.has(item.itemId)
      || typeof item.role !== "string" || !item.role
      || (item.customType !== undefined && typeof item.customType !== "string")
      || typeof item.text !== "string" || typeof item.hasImages !== "boolean"
      || !Number.isSafeInteger(item.imageCount) || item.imageCount < 0
      || item.hasImages !== (item.imageCount > 0)) return null;
    seen.add(item.itemId);
    if (item.images !== undefined && (!Array.isArray(item.images)
      || item.images.some(image => !image || typeof image.data !== "string" || typeof image.mimeType !== "string"))) return null;
  }
  return state as QueuedDraftState;
}

/** A custom/peer message must never be forged into a user prompt. */
export function assertUserQueueRecall(state: QueuedDraftState): void {
  if ([...state.steering, ...state.followUp].some(item => item.role !== "user" || item.customType !== undefined)) {
    throw Object.assign(new Error("This queue contains non-user messages. Recall to a user draft is unavailable; the queue is unchanged."), { code: "queue_contains_non_user_messages" });
  }
}

/** Reject incomplete recall responses rather than silently losing attachments. */
export function recalledQueuedDrafts(value: unknown): QueuedDraftMessage[] {
  const state = readQueuedDraftState(value);
  if (!state) throw new Error("The server did not return queue item identities; queued attachments cannot be safely recalled");
  assertUserQueueRecall(state);
  const items = [...state.steering, ...state.followUp];
  if (items.some(item => (item.images?.length ?? 0) !== item.imageCount)) {
    throw new Error("The server did not return the queued attachments");
  }
  return items.map(item => ({ ...item, ...(item.images ? { images: item.images.map(image => ({ ...image })) } : {}) }));
}

/**
 * A session/peer-scoped projection of the producer's queue, with no image mirror.
 * Request generations fence responses from a previous boot that arrive after a
 * newer event. Within one boot, queueRevision orders snapshots independently of
 * unrelated model events. Retired boots cannot reappear through SSE replay.
 */
export class QueuedDraftProjection {
  private scope: string | null = null;
  private retiredBoots = new Set<string>();
  private current: QueuedDraftState | null = null;
  private version = 0;

  get generation(): number { return this.version; }
  get snapshot(): QueuedDraftState | null { return this.current; }

  reset(scope: string | null): void {
    this.scope = scope;
    this.current = null;
    this.retiredBoots.clear();
    this.version += 1;
  }

  /** Only a successful, current read proving the producer absent may clear it. */
  clearAbsent(scope: string, requestGeneration: number): boolean {
    if (this.scope !== scope || requestGeneration !== this.version) return false;
    if (this.current) this.retiredBoots.add(this.current.bootId);
    this.current = null;
    this.version += 1;
    return true;
  }

  apply(scope: string, value: unknown, requestGeneration?: number): QueuedDraftState | null {
    const next = readQueuedDraftState(value);
    if (!next) return null;
    if (this.scope !== scope) {
      // A response captured for a previous scope must not replace this one.
      if (requestGeneration !== undefined && requestGeneration !== this.version) return null;
      this.reset(scope);
    } else if (!this.current && requestGeneration !== undefined && requestGeneration !== this.version) {
      // A reset/absent result must also fence an old response before a new
      // producer snapshot exists. Same-boot revisions remain independently ordered.
      return null;
    }
    if (this.retiredBoots.has(next.bootId)) return null;
    if (this.current) {
      if (next.bootId === this.current.bootId) {
        if (next.queueRevision < this.current.queueRevision) return null;
      } else {
        if (requestGeneration !== undefined && requestGeneration !== this.version) return null;
        this.retiredBoots.add(this.current.bootId);
      }
    }
    this.current = next;
    this.version += 1;
    return next;
  }
}

// Completed clear responses waiting for composer capacity. Unlike the removed
// queue mirror, these are authoritative, already-cleared items with exact IDs.
// They survive component remounts, remain peer/session scoped, and are never
// sent back to the agent or matched against a later queue by text.
const pendingRecalls = new Map<string, QueuedDraftState>();
export function getPendingQueueRecall(scope: string): QueuedDraftState | null {
  return pendingRecalls.get(scope) ?? null;
}
export function savePendingQueueRecall(scope: string, state: QueuedDraftState): void {
  recalledQueuedDrafts(state); // Require the full attachment payload before saving.
  pendingRecalls.set(scope, state);
}
export function clearPendingQueueRecall(scope: string): void { pendingRecalls.delete(scope); }
export function queuedImageCount(state: QueuedDraftState): number {
  return [...state.steering, ...state.followUp].reduce((sum, item) => sum + item.imageCount, 0);
}

export type QueueRecallOperation = { operationId: string; expected: QueuedDraftState; restored?: boolean };
const recallOperations = new Map<string, QueueRecallOperation>();
const RECALL_OPERATION_PREFIX = "reader-queue-recall:";
function recallStorage(): Storage | null {
  // A fast retry hint only. The server inbox discovers recovery after tab loss.
  if (typeof window === "undefined") return null;
  return window.sessionStorage;
}
export function getQueueRecallOperation(scope: string): QueueRecallOperation | null {
  const cached = recallOperations.get(scope);
  if (cached) return cached;
  try {
    const raw = recallStorage()?.getItem(RECALL_OPERATION_PREFIX + scope);
    if (!raw) return null;
    const saved = JSON.parse(raw) as QueueRecallOperation;
    if (typeof saved.operationId !== "string" || !readQueuedDraftState(saved.expected)) return null;
    recallOperations.set(scope, saved);
    return saved;
  } catch { return null; }
}
export function beginQueueRecallOperation(scope: string, expected: QueuedDraftState): QueueRecallOperation {
  const existing = getQueueRecallOperation(scope);
  if (existing) return existing;
  const summary = (items: QueuedDraftMessage[]) => items.map(({ itemId, role, customType, text, hasImages, imageCount }) => ({ itemId, role, ...(customType !== undefined ? { customType } : {}), text, hasImages, imageCount }));
  const operation = { operationId: globalThis.crypto.randomUUID(), expected: { ...expected, steering: summary(expected.steering), followUp: summary(expected.followUp) } };
  try { recallStorage()?.setItem(RECALL_OPERATION_PREFIX + scope, JSON.stringify(operation)); }
  catch { /* Server discovery remains authoritative when browser storage is unavailable. */ }
  recallOperations.set(scope, operation);
  return operation;
}
export function markQueueRecallRestored(scope: string): void {
  const operation = getQueueRecallOperation(scope);
  if (!operation) throw new Error("The recall recovery operation is missing");
  const restored = { ...operation, restored: true };
  try { recallStorage()?.setItem(RECALL_OPERATION_PREFIX + scope, JSON.stringify(restored)); } catch { /* Recover through the server inbox. */ }
  recallOperations.set(scope, restored);
}
export function clearQueueRecallOperation(scope: string): void {
  try { recallStorage()?.removeItem(RECALL_OPERATION_PREFIX + scope); } catch { /* Best-effort browser hint only. */ }
  recallOperations.delete(scope);
}
