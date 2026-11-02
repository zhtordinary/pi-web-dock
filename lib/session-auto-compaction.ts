import type { SessionManager } from "@earendil-works/pi-coding-agent";

export const SESSION_AUTO_COMPACTION_TYPE = "pi-web:auto-compaction";

/** Latest session-wide explicit choice; absence is not a configured default. */
export function readSessionAutoCompaction(entries: readonly unknown[]): boolean | undefined {
  let latest: { id?: unknown; data?: unknown } | undefined;
  const identities = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const candidate = entry as { type?: unknown; customType?: unknown; id?: unknown; data?: unknown };
    if (candidate.type !== "custom" || candidate.customType !== SESSION_AUTO_COMPACTION_TYPE) continue;
    if (typeof candidate.id === "string") {
      if (identities.has(candidate.id)) throw new Error("Conflicting persisted automatic compaction state");
      identities.add(candidate.id);
    }
    latest = candidate;
  }
  if (!latest) return undefined;
  const data = latest.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid persisted automatic compaction state");
  const state = data as { version?: unknown; autoCompactionEnabled?: unknown };
  if (state.version !== 1 || typeof state.autoCompactionEnabled !== "boolean"
    || typeof latest.id !== "string" || !latest.id) {
    throw new Error("Invalid persisted automatic compaction state");
  }
  return state.autoCompactionEnabled;
}

export function appendSessionAutoCompaction(sessionManager: SessionManager, enabled: boolean): void {
  sessionManager.appendCustomEntry(SESSION_AUTO_COMPACTION_TYPE, { version: 1, autoCompactionEnabled: enabled });
}
