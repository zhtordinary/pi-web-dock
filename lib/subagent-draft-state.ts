export type DraftMap<T> = Record<string, T>;

const reloadPending = new Map<string, string | undefined>();
const reloadStorageFailed = new Set<string>();
let reloadSequence = 0;

function reloadStorage(): Storage | undefined {
  try { return typeof window === "undefined" ? undefined : window.sessionStorage; }
  catch { return undefined; }
}

function reloadKey(sessionId: string, peer?: string): string {
  return `reader:subagents:reload:${JSON.stringify([peer ?? null, sessionId])}`;
}

export function pendingSubagentReloadToken(sessionId: string, peer?: string): string | undefined {
  const key = reloadKey(sessionId, peer);
  if (!reloadStorageFailed.has(key)) {
    try {
      const storage = reloadStorage();
      if (storage) return storage.getItem(key) ?? undefined;
    } catch { /* Fall back to the current page's memory. */ }
  }
  return reloadPending.get(key);
}

export function hasPendingSubagentReload(sessionId: string, peer?: string): boolean {
  return pendingSubagentReloadToken(sessionId, peer) !== undefined;
}

export function setPendingSubagentReload(sessionId: string, peer: string | undefined, pending: boolean): void {
  const key = reloadKey(sessionId, peer);
  const token = pending ? `${Date.now()}:${++reloadSequence}:${Math.random()}` : undefined;
  reloadPending.set(key, token);
  try {
    const storage = reloadStorage();
    if (!storage) throw new Error("Session storage unavailable");
    if (token) storage.setItem(key, token);
    else storage.removeItem(key);
    reloadStorageFailed.delete(key);
  } catch { reloadStorageFailed.add(key); }
}

export function rememberDraft<T>(map: DraftMap<T>, key: string, draft: T, changed: boolean): DraftMap<T> {
  const next = { ...map };
  if (changed) next[key] = draft;
  else delete next[key];
  return next;
}

export function collectPendingDrafts<T>(
  map: DraftMap<T>,
  currentKey: string | null,
  currentDraft: T,
  currentChanged: boolean,
): Map<string, T> {
  const pending = new Map(Object.entries(map));
  if (currentKey && currentChanged) pending.set(currentKey, currentDraft);
  return pending;
}

export function removeDrafts<T>(map: DraftMap<T>, keys: Iterable<string>): DraftMap<T> {
  const next = { ...map };
  for (const key of keys) delete next[key];
  return next;
}
