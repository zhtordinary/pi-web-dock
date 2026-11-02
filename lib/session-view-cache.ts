import type { Transcript } from "./transcript-store";

export const HISTORY_CACHE_MAX_SESSIONS = 8;
export const HISTORY_CACHE_MAX_BYTES = 32 * 1024 * 1024;
export const HISTORY_CACHE_INACTIVE_TTL_MS = 10 * 60_000;
export interface TranscriptScope { sessionId: string; peer: string | null; leafId?: string | null }
const records = new Map<string, { transcript: Transcript; bytes: number; expires: number }>();
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
const key = (scope: TranscriptScope) => JSON.stringify([scope.peer, scope.sessionId, scope.leafId === undefined ? { active: true } : scope.leafId]);
export function estimateHistoryCacheBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value, (_, item) => item instanceof Map ? [...item] : item)).byteLength * 2 + 512;
}
function scheduleExpiry(): void {
  clearTimeout(expiryTimer);
  const expires = Math.min(...[...records.values()].map(record => record.expires));
  if (!Number.isFinite(expires)) return;
  expiryTimer = setTimeout(() => { cleanupHistoryViewCache(); }, Math.max(0, expires - Date.now()));
  (expiryTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
}
export function cleanupHistoryViewCache(now = Date.now()): number {
  let removed = 0;
  for (const [id, record] of records) if (record.expires <= now) { records.delete(id); removed++; }
  scheduleExpiry();
  return removed;
}
export function getSessionViewSnapshot(scope: TranscriptScope): Transcript | null {
  cleanupHistoryViewCache();
  const id = key(scope), record = records.get(id);
  if (!record) return null;
  records.delete(id); records.set(id, record);
  return record.transcript;
}
export function setSessionViewSnapshot(scope: TranscriptScope, transcript: Transcript): void {
  const id = key(scope);
  records.delete(id);
  // A distant navigation interval is not the latest view on the next mount.
  if (!transcript.loaded || transcript.after !== null) return;
  const bytes = estimateHistoryCacheBytes(transcript);
  if (bytes > HISTORY_CACHE_MAX_BYTES) return;
  records.set(id, { transcript, bytes, expires: Date.now() + HISTORY_CACHE_INACTIVE_TTL_MS });
  while (records.size > HISTORY_CACHE_MAX_SESSIONS || historyViewCacheStats().bytes > HISTORY_CACHE_MAX_BYTES) records.delete(records.keys().next().value!);
  scheduleExpiry();
}
export function historyViewCacheStats(): { sessions: number; bytes: number } {
  return { sessions: records.size, bytes: [...records.values()].reduce((sum, record) => sum + record.bytes, 0) };
}
export function clearHistoryViewCache(): void { records.clear(); clearTimeout(expiryTimer); expiryTimer = undefined; }
export const resetHistoryViewCacheForTests = clearHistoryViewCache;
