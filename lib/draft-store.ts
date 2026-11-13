import { isBase64ImageWithinLimits } from "./image-attachments";
import type { QuoteContextItem } from "./quote-context";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface HistoryEditDraft {
  entryId: string;
  clientMessageId?: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  quotes?: QuoteContextItem[];
  autoCompactionEnabled?: boolean;
  /** The historical user entry this draft must not be sent as an ordinary prompt. */
  historyEdit?: HistoryEditDraft | null;
  /** Deduplication for this draft content lifecycle, including unacknowledged recalls. */
  recalledQueueOperations?: string[];
}

export type DraftKey = string | { kind: "session" | "history"; sessionId: string; peer: string | null };

export function sessionDraftKey(sessionId: string, peer?: string | null): DraftKey {
  return { kind: "session", sessionId, peer: peer ?? null };
}

export function historyDraftKey(sessionId: string, peer?: string | null): DraftKey {
  return { kind: "history", sessionId, peer: peer ?? null };
}

export function legacyHistoryDraftKey(sessionId: string, peer?: string | null): string {
  return [peer ?? "local", sessionId].map(encodeURIComponent).join(":");
}

const drafts = new Map<string, ChatDraft>();

export function hasMemoryDraftContent(): boolean {
  return Array.from(drafts.values()).some((draft) => Boolean(draft.value || draft.images.length || draft.quotes?.length || draft.historyEdit));
}

// 草稿按会话持久化到 localStorage：聚合页切会话会重载 iframe（内存 Map 随之清空），
// 持久化后同源重载可读回；图片 data URL 可能超 5MB 配额，写失败时静默回退内存。
const STORAGE_PREFIX = "pi-web-draft:";
const SESSION_STORAGE_PREFIX = "pi-web-owned-draft:";

export function draftKeyIdentity(key: DraftKey): string {
  return typeof key === "string"
    ? STORAGE_PREFIX + key
    : SESSION_STORAGE_PREFIX + JSON.stringify([key.kind, key.peer, key.sessionId]);
}

export function sameDraftKey(a: DraftKey | undefined, b: DraftKey | undefined): boolean {
  return a === undefined || b === undefined ? a === b : draftKeyIdentity(a) === draftKeyIdentity(b);
}

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
    ...(draft.recalledQueueOperations ? { recalledQueueOperations: [...draft.recalledQueueOperations] } : {}),
    ...(Array.isArray(draft.quotes) ? { quotes: draft.quotes.map((q) => ({ ...q })) } : {}),
    ...(draft.historyEdit ? { historyEdit: { ...draft.historyEdit } } : {}),
    ...(typeof draft.autoCompactionEnabled === "boolean" ? { autoCompactionEnabled: draft.autoCompactionEnabled } : {}),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return (
    !draft.value &&
    draft.images.length === 0 &&
    (!draft.quotes || draft.quotes.length === 0) &&
    !draft.historyEdit &&
    typeof draft.autoCompactionEnabled !== "boolean"
  );
}

function readStorage(key: DraftKey): ChatDraft | null {
  try {
    const raw = localStorage.getItem(draftKeyIdentity(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ChatDraft;
    if (!Array.isArray(parsed.images) || typeof parsed.value !== "string") return null;
    if (parsed.quotes && !Array.isArray(parsed.quotes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStorage(key: DraftKey, draft: ChatDraft | null): void {
  try {
    if (draft) localStorage.setItem(draftKeyIdentity(key), JSON.stringify(draft));
    else localStorage.removeItem(draftKeyIdentity(key));
  } catch {
    // 配额超限等：仅保留内存副本。
  }
}

export function getDraft(key: DraftKey): ChatDraft | null {
  const identity = draftKeyIdentity(key);
  const mem = drafts.get(identity);
  if (mem) return cloneDraft(mem);
  if (typeof localStorage !== "undefined") {
    const stored = readStorage(key);
    if (stored) {
      drafts.set(identity, cloneDraft(stored));
      return cloneDraft(stored);
    }
  }
  return null;
}

export function setDraft(key: DraftKey, draft: ChatDraft): void {
  const previous = getDraft(key);
  const preference = draft.autoCompactionEnabled ?? previous?.autoCompactionEnabled;
  const recalledQueueOperations = draft.recalledQueueOperations ?? previous?.recalledQueueOperations;
  const historyEdit = draft.historyEdit === undefined ? previous?.historyEdit : draft.historyEdit;
  if (historyEdit === null) {
    const { historyEdit: _historyEdit, ...withoutHistoryEdit } = draft;
    draft = withoutHistoryEdit;
  } else if (historyEdit) {
    draft = { ...draft, historyEdit: { ...historyEdit } };
  }
  draft = { ...draft, ...(recalledQueueOperations ? { recalledQueueOperations } : {}), ...(typeof preference === "boolean" ? { autoCompactionEnabled: preference } : {}) };
  if (isEmptyDraft(draft)) {
    drafts.delete(draftKeyIdentity(key));
    if (typeof localStorage !== "undefined") writeStorage(key, null);
    return;
  }
  drafts.set(draftKeyIdentity(key), cloneDraft(draft));
  if (typeof localStorage !== "undefined") writeStorage(key, draft);
}

/** Always restore the visible input. Only a successful durable write permits automatic ACK. */
export function setRecalledDraft(key: DraftKey, draft: ChatDraft, operationId: string): { durable: boolean } {
  const previous = getDraft(key);
  // A count limit can evict an unresolved operation while its text is still
  // present. Keep the set for this draft's lifecycle; explicit clear/consume
  // retires it along with the draft, and rekey merges it with the content.
  const operations = [...new Set([...(previous?.recalledQueueOperations ?? []), operationId])];
  const saved = cloneDraft({ ...draft,
    ...(draft.historyEdit === undefined && previous?.historyEdit ? { historyEdit: previous.historyEdit } : {}),
    ...(typeof previous?.autoCompactionEnabled === "boolean" ? { autoCompactionEnabled: previous.autoCompactionEnabled } : {}),
    recalledQueueOperations: operations,
  });
  let durable = false;
  try {
    if (typeof localStorage !== "undefined") { localStorage.setItem(draftKeyIdentity(key), JSON.stringify(saved)); durable = true; }
  } catch { /* The server recovery inbox remains the durable attachment owner. */ }
  drafts.set(draftKeyIdentity(key), saved);
  return { durable };
}

export function isRecalledDraftDurable(key: DraftKey, operationId: string): boolean {
  return readStorage(key)?.recalledQueueOperations?.includes(operationId) === true;
}

export function clearDraft(key: DraftKey): void {
  drafts.delete(draftKeyIdentity(key));
  if (typeof localStorage !== "undefined") writeStorage(key, null);
}

export function mergeRestoredSubmissionText(submitted: string, current: string): string {
  if (!submitted.trim()) return current;
  if (!current.trim()) return submitted;
  return `${submitted}\n\n${current}`;
}

export function mergeRestoredSubmissionDraft(
  submittedText: string,
  submittedImages: ChatDraftImage[] | undefined,
  currentText: string,
  currentImages: ChatDraftImage[],
  submittedQuotes?: QuoteContextItem[],
  currentQuotes?: QuoteContextItem[],
): ChatDraft {
  // Keep every valid image in the recovery draft. The composer may only display
  // its configured attachment limit, but recovery must not silently discard a
  // submitted image while composing an unconfirmed or rejected operation.
  const images = [...(submittedImages ?? []), ...currentImages]
    .filter(isBase64ImageWithinLimits)
    .map(({ data, mimeType }) => ({ data, mimeType }));

  const existingQuotes = currentQuotes ?? [];
  const restoredQuotes = submittedQuotes ?? [];
  const mergedQuotesMap = new Map<string, QuoteContextItem>();
  for (const q of existingQuotes) {
    if (q && typeof q.text === "string" && q.text.trim()) {
      mergedQuotesMap.set(q.id || q.text, q);
    }
  }
  for (const q of restoredQuotes) {
    if (q && typeof q.text === "string" && q.text.trim()) {
      mergedQuotesMap.set(q.id || q.text, q);
    }
  }
  const quotes = Array.from(mergedQuotesMap.values());

  return {
    value: mergeRestoredSubmissionText(submittedText, currentText),
    images,
    ...(quotes.length > 0 ? { quotes } : {}),
  };
}

export function restoreDraftSubmission(
  key: DraftKey,
  text: string,
  images?: ChatDraftImage[],
  quotes?: QuoteContextItem[],
): ChatDraft {
  const current = getDraft(key) ?? { value: "", images: [] };
  const restored = mergeRestoredSubmissionDraft(
    text,
    images,
    current.value,
    current.images,
    quotes,
    current.quotes,
  );
  setDraft(key, restored);
  return restored;
}

export function rekeyDraft(
  previousKey: DraftKey,
  nextKey: DraftKey,
  currentDraft?: ChatDraft,
): ChatDraft | null {
  if (sameDraftKey(previousKey, nextKey)) return currentDraft ? cloneDraft(currentDraft) : getDraft(nextKey);

  const storedPrevious = getDraft(previousKey);
  const previous = currentDraft && !isEmptyDraft(currentDraft)
    ? cloneDraft(currentDraft)
    : (storedPrevious ?? (currentDraft ? cloneDraft(currentDraft) : null));
  const next = getDraft(nextKey);
  clearDraft(previousKey);
  if (!previous) return next;

  const merged = next
    ? mergeRestoredSubmissionDraft(next.value, next.images, previous.value, previous.images, next.quotes, previous.quotes)
    : previous;
  const operations = [...new Set([...(next?.recalledQueueOperations ?? []), ...(storedPrevious?.recalledQueueOperations ?? []), ...(previous.recalledQueueOperations ?? [])])];
  if (operations.length) merged.recalledQueueOperations = operations;
  const preference = previous.autoCompactionEnabled ?? next?.autoCompactionEnabled;
  if (typeof preference === "boolean") merged.autoCompactionEnabled = preference;
  setDraft(nextKey, merged);
  return cloneDraft(merged);
}
