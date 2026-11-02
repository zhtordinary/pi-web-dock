/**
 * Shared session-keyed caches with bounded growth.
 *
 * Both caches below are keyed by session id and were previously unbounded:
 * entries for archived/deleted sessions lingered forever, so on an 8GB Mac a
 * long-lived server process slowly accumulated memory as the session archive
 * grew. All inserts are capped and evict the least-recently-touched entry when
 * full; the delete/archive routes call clearSessionCaches(id) so a removed
 * session never lingers.
 */

import type { SessionRecapSummary } from "./session-recap";

export interface SessionMetadataEntry {
  modified: string;
  fileMtimeMs: number;
  modelName?: string;
  lastUserMessage?: string;
  lastAskedAt?: string;
  lastRecap?: SessionRecapSummary;
  hasErrorTail?: boolean;
  fetchedAt: number;
}
const SESSION_METADATA_CACHE_MAX = 500;
const sessionMetadataCache = new Map<string, SessionMetadataEntry>();

export function cacheSessionMetadata(id: string, metadata: SessionMetadataEntry): void {
  if (sessionMetadataCache.size >= SESSION_METADATA_CACHE_MAX) {
    evictOldest(sessionMetadataCache);
  }
  sessionMetadataCache.set(id, metadata);
}
export function readSessionMetadata(id: string): SessionMetadataEntry | undefined {
  return sessionMetadataCache.get(id);
}

export interface CostCacheEntry {
  sessionMtimeMs: number;
  /** Revision of the parent file plus its persisted child-session tree. */
  sessionRevision?: string;
  scriptMtimeMs: number | null;
  priceTableSignature: string;
  result: unknown;
}
const COST_CACHE_MAX = 500;
const costCache = new Map<string, CostCacheEntry>();

export function cacheCost(id: string, entry: CostCacheEntry): void {
  if (costCache.size >= COST_CACHE_MAX) {
    evictOldest(costCache);
  }
  costCache.set(id, entry);
}
export function readCost(id: string): CostCacheEntry | undefined {
  return costCache.get(id);
}

/** Drop one session from all caches (used on delete/archive). */
export function clearSessionCaches(id: string): void {
  sessionMetadataCache.delete(id);
  costCache.delete(id);
}

function evictOldest(map: Map<string, { fetchedAt?: number; sessionMtimeMs?: number }>): void {
  let oldestKey: string | null = null;
  let oldestAt = Infinity;
  for (const [key, value] of map) {
    const at = value.fetchedAt ?? value.sessionMtimeMs ?? Infinity;
    if (at < oldestAt) { oldestAt = at; oldestKey = key; }
  }
  if (oldestKey !== null) map.delete(oldestKey);
}
