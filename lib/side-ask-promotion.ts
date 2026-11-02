import { apiPathForPeer } from "./file-api.ts";

/**
 * An in-page branch tab disappears when its leaf becomes the newest one, so its Side Ask topics must move to the
 * main line. The tab list lives in this browser only; the pending moves live next to it until the host confirms them.
 */
export interface PromotionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

const storageKey = (sessionId: string) => `pi-web:side-ask-promotions:${sessionId}`;
const inFlight = new Map<string, Promise<number>>();

export function pendingSideAskPromotions(storage: PromotionStorage, sessionId: string): string[] {
  try {
    const value = JSON.parse(storage.getItem(storageKey(sessionId)) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id !== "" && id !== "main") : [];
  } catch { return []; }
}

function writePending(storage: PromotionStorage, sessionId: string, ids: string[]): void {
  try {
    if (ids.length) storage.setItem(storageKey(sessionId), JSON.stringify(ids));
    else if (storage.removeItem) storage.removeItem(storageKey(sessionId));
    else storage.setItem(storageKey(sessionId), "[]");
  } catch { /* Blocked storage only costs the retry; the tab itself is already gone. */ }
}

export function queueSideAskPromotion(storage: PromotionStorage, sessionId: string, branchId: string): void {
  if (!branchId || branchId === "main") return;
  const pending = pendingSideAskPromotions(storage, sessionId);
  if (!pending.includes(branchId)) writePending(storage, sessionId, [...pending, branchId]);
}

/**
 * Ask the host to move each pending branch to main. The host operation is idempotent, so a move whose answer was
 * lost is simply asked again. Returns how many topics' worth of questions moved, so the caller knows to refresh.
 */
export function flushSideAskPromotions(options: {
  storage: PromotionStorage;
  sessionId: string;
  remotePeer?: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}): Promise<number> {
  const { storage, sessionId, remotePeer, fetcher = fetch, signal } = options;
  const flightKey = JSON.stringify([remotePeer ?? null, sessionId]);
  const running = inFlight.get(flightKey);
  if (running) return running;
  const url = apiPathForPeer(remotePeer, `sessions/${encodeURIComponent(sessionId)}/quick-ask`);
  const flight = (async () => {
    let moved = 0;
    for (const branchId of pendingSideAskPromotions(storage, sessionId)) {
      if (signal?.aborted) break;
      let response: Response;
      try {
        response = await fetcher(url, { method: "POST", headers: { "Content-Type": "application/json" }, signal,
          body: JSON.stringify({ action: "promote_branch", fromBranchId: branchId }) });
      } catch { break; }
      // 400 can never succeed; every other refusal (a running topic, a restarting host) may after a later attempt.
      if (!response.ok && response.status !== 400) continue;
      if (response.ok) {
        const value = await response.json().catch(() => ({})) as { promotedCount?: number };
        moved += typeof value.promotedCount === "number" ? value.promotedCount : 0;
      }
      writePending(storage, sessionId, pendingSideAskPromotions(storage, sessionId).filter((id) => id !== branchId));
    }
    return moved;
  })().finally(() => { inFlight.delete(flightKey); });
  inFlight.set(flightKey, flight);
  return flight;
}
