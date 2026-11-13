import { useCallback, useMemo, useSyncExternalStore } from "react";

export const SUBAGENT_VISIBILITY_STORAGE_KEY = "pi-web:visible-subagent-parents";
const SUBAGENT_VISIBILITY_EVENT = "pi-web:subagent-visibility-changed";
const EMPTY_SNAPSHOT = "[]";

let snapshot: string | undefined;
const listeners = new Set<() => void>();

function parseIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0))].sort()
      : [];
  } catch {
    return [];
  }
}

function readSnapshot(): string {
  if (snapshot !== undefined) return snapshot;
  if (typeof window === "undefined") return EMPTY_SNAPSHOT;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SUBAGENT_VISIBILITY_STORAGE_KEY) ?? "[]");
    const ids = Array.isArray(parsed)
      ? [...new Set(parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0))].sort()
      : [];
    snapshot = JSON.stringify(ids);
  } catch {
    snapshot = EMPTY_SNAPSHOT;
  }
  return snapshot;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", handleStorageChange);
    window.addEventListener(SUBAGENT_VISIBILITY_EVENT, handleStorageChange);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener(SUBAGENT_VISIBILITY_EVENT, handleStorageChange);
    }
  };
}

function handleStorageChange(): void {
  snapshot = undefined;
  notify();
}

function getServerSnapshot(): string {
  return EMPTY_SNAPSHOT;
}

export function setSubagentVisibility(parentSessionId: string, visible: boolean): void {
  if (!parentSessionId.trim() || typeof window === "undefined") return;
  const current = new Set(parseIds(readSnapshot()));
  if (visible) current.add(parentSessionId);
  else current.delete(parentSessionId);
  snapshot = JSON.stringify([...current].sort());
  try {
    window.localStorage.setItem(SUBAGENT_VISIBILITY_STORAGE_KEY, snapshot);
  } catch {
    // The in-memory snapshot still updates this tab when storage is unavailable.
  }
  window.dispatchEvent(new Event(SUBAGENT_VISIBILITY_EVENT));
}

export function useSubagentVisibility(): ReadonlySet<string> {
  const raw = useSyncExternalStore(subscribe, readSnapshot, getServerSnapshot);
  return useMemo(() => new Set(parseIds(raw)), [raw]);
}

export function useSubagentVisibilitySetter(): (parentSessionId: string, visible: boolean) => void {
  return useCallback(setSubagentVisibility, []);
}
