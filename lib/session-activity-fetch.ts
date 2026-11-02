"use client";

import type { SessionActivityResponse } from "./session-activity-types";

type ActivityCacheEntry<T> = {
  data?: T;
  fetchedAt: number;
  promise?: Promise<T>;
};

const ACTIVITY_CACHE_TTL_MS = 5_000;
const MAX_ACTIVITY_CACHE_ENTRIES = 16;
const activityCache = new Map<string, ActivityCacheEntry<unknown>>();

function pruneActivityCache(): void {
  const now = Date.now();
  for (const [url, entry] of activityCache) {
    if (!entry.promise && (entry.data === undefined || now - entry.fetchedAt >= ACTIVITY_CACHE_TTL_MS * 2)) {
      activityCache.delete(url);
    }
  }
  while (activityCache.size > MAX_ACTIVITY_CACHE_ENTRIES) {
    let oldestUrl: string | undefined;
    let oldestAt = Infinity;
    for (const [url, entry] of activityCache) {
      if (entry.promise) continue;
      if (entry.fetchedAt < oldestAt) {
        oldestUrl = url;
        oldestAt = entry.fetchedAt;
      }
    }
    if (oldestUrl === undefined) break;
    activityCache.delete(oldestUrl);
  }
}

/**
 * Share one read-only session-activity request between the activity panel,
 * restore logic, and the chat's status checks. `force` bypasses the short
 * browser cache but still joins an already-running request.
 */
export function fetchSessionActivity<T = SessionActivityResponse>(
  url: string,
  options: { force?: boolean } = {},
): Promise<T> {
  pruneActivityCache();
  const existing = activityCache.get(url) as ActivityCacheEntry<T> | undefined;
  if (existing?.promise) return existing.promise;
  if (!options.force && existing?.data !== undefined && Date.now() - existing.fetchedAt < ACTIVITY_CACHE_TTL_MS) {
    return Promise.resolve(existing.data);
  }

  const entry = existing ?? { fetchedAt: 0 };
  const request = fetch(url, { cache: "no-store" })
    .then(async (response) => {
      const body = await response.json().catch(() => null) as T | null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return body as T;
    })
    .then((data) => {
      entry.data = data;
      entry.fetchedAt = Date.now();
      pruneActivityCache();
      return data;
    })
    .finally(() => {
      if (entry.promise === request) entry.promise = undefined;
    });

  entry.promise = request;
  activityCache.set(url, entry);
  return request;
}

export function clearSessionActivityCache(url?: string): void {
  if (url) {
    activityCache.delete(url);
    return;
  }
  activityCache.clear();
}
