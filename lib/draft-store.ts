import {
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "./image-attachments";
import type { QuoteContextItem } from "./quote-context";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  quotes?: QuoteContextItem[];
  autoCompactionEnabled?: boolean;
  /** Deduplication for this draft content lifecycle, including unacknowledged recalls. */
  recalledQueueOperations?: string[];
}

const drafts = new Map<string, ChatDraft>();

export function hasMemoryDraftContent(): boolean {
  return Array.from(drafts.values()).some((draft) => Boolean(draft.value || draft.images.length || draft.quotes?.length));
}

// 草稿按会话持久化到 localStorage：聚合页切会话会重载 iframe（内存 Map 随之清空），
// 持久化后同源重载可读回；图片 data URL 可能超 5MB 配额，写失败时静默回退内存。
const STORAGE_PREFIX = "pi-web-draft:";

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
    ...(draft.recalledQueueOperations ? { recalledQueueOperations: [...draft.recalledQueueOperations] } : {}),
    ...(Array.isArray(draft.quotes) ? { quotes: draft.quotes.map((q) => ({ ...q })) } : {}),
    ...(typeof draft.autoCompactionEnabled === "boolean" ? { autoCompactionEnabled: draft.autoCompactionEnabled } : {}),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return (
    !draft.value &&
    draft.images.length === 0 &&
    (!draft.quotes || draft.quotes.length === 0) &&
    typeof draft.autoCompactionEnabled !== "boolean"
  );
}

function readStorage(key: string): ChatDraft | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ChatDraft;
    if (!Array.isArray(parsed.images) || typeof parsed.value !== "string") return null;
    if (parsed.quotes && !Array.isArray(parsed.quotes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStorage(key: string, draft: ChatDraft | null): void {
  try {
    if (draft) localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(draft));
    else localStorage.removeItem(STORAGE_PREFIX + key);
  } catch {
    // 配额超限等：仅保留内存副本。
  }
}

export function getDraft(key: string): ChatDraft | null {
  const mem = drafts.get(key);
  if (mem) return cloneDraft(mem);
  if (typeof localStorage !== "undefined") {
    const stored = readStorage(key);
    if (stored) {
      drafts.set(key, cloneDraft(stored));
      return cloneDraft(stored);
    }
  }
  return null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  const preference = draft.autoCompactionEnabled ?? getDraft(key)?.autoCompactionEnabled;
  const recalledQueueOperations = draft.recalledQueueOperations ?? getDraft(key)?.recalledQueueOperations;
  draft = { ...draft, ...(recalledQueueOperations ? { recalledQueueOperations } : {}), ...(typeof preference === "boolean" ? { autoCompactionEnabled: preference } : {}) };
  if (isEmptyDraft(draft)) {
    drafts.delete(key);
    if (typeof localStorage !== "undefined") writeStorage(key, null);
    return;
  }
  drafts.set(key, cloneDraft(draft));
  if (typeof localStorage !== "undefined") writeStorage(key, draft);
}

/** Always restore the visible input. Only a successful durable write permits automatic ACK. */
export function setRecalledDraft(key: string, draft: ChatDraft, operationId: string): { durable: boolean } {
  const previous = getDraft(key);
  // A count limit can evict an unresolved operation while its text is still
  // present. Keep the set for this draft's lifecycle; explicit clear/consume
  // retires it along with the draft, and rekey merges it with the content.
  const operations = [...new Set([...(previous?.recalledQueueOperations ?? []), operationId])];
  const saved = cloneDraft({ ...draft,
    ...(typeof previous?.autoCompactionEnabled === "boolean" ? { autoCompactionEnabled: previous.autoCompactionEnabled } : {}),
    recalledQueueOperations: operations,
  });
  let durable = false;
  try {
    if (typeof localStorage !== "undefined") { localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(saved)); durable = true; }
  } catch { /* The server recovery inbox remains the durable attachment owner. */ }
  drafts.set(key, saved);
  return { durable };
}

export function isRecalledDraftDurable(key: string, operationId: string): boolean {
  return readStorage(key)?.recalledQueueOperations?.includes(operationId) === true;
}

export function clearDraft(key: string): void {
  drafts.delete(key);
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
  const images = [...(submittedImages ?? []), ...currentImages]
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
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
  key: string,
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
  previousKey: string,
  nextKey: string,
  currentDraft?: ChatDraft,
): ChatDraft | null {
  if (previousKey === nextKey) return currentDraft ? cloneDraft(currentDraft) : getDraft(nextKey);

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
