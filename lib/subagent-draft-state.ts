export type DraftMap<T> = Record<string, T>;

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
