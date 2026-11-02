import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { PRESET_FULL } from "./tool-presets";
import type { SessionEntry } from "./types";

export const TOOL_SELECTION_TYPE = "pi-web:tool-selection";

export interface SessionToolSelectionData {
  version: 1;
  tools: string[];
  /**
   * When true, the session owns an exact tool allow-list and must not carry
   * extension/package tools across runtime creation or reload. Omitted on
   * legacy entries to preserve the original selection semantics.
   */
  strict?: true;
}

export interface SessionToolSelectionPolicy {
  tools: string[];
  strict: boolean;
}

/**
 * Written when the user returns a session to pi's configured defaults. The session
 * log is append-only, so an earlier pin can only be retracted by a later entry that
 * says so; without it the newest pin would win forever (#700).
 */
export interface ClearedSessionToolSelectionData {
  version: 1;
  cleared: true;
}

const BUILTIN_TOOL_NAMES = new Set(PRESET_FULL);
const CLEARED = Symbol("cleared-tool-selection");

function parseToolSelectionData(data: unknown): SessionToolSelectionPolicy | typeof CLEARED | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const candidate = data as { version?: unknown; tools?: unknown; cleared?: unknown; strict?: unknown };
  if (candidate.version !== 1) return undefined;
  if (candidate.cleared === true) return CLEARED;
  if (
    !Array.isArray(candidate.tools)
    || candidate.tools.some((tool) => typeof tool !== "string" || !BUILTIN_TOOL_NAMES.has(tool))
  ) return undefined;
  return {
    tools: [...new Set(candidate.tools as string[])],
    strict: candidate.strict === true,
  };
}

/**
 * Return the newest valid persisted selection. Undefined means the session carries no
 * selection of its own - legacy sessions, sessions created without an override, and
 * sessions explicitly returned to the configured defaults all resolve that way.
 */
export function readSessionToolSelection(entries: readonly SessionEntry[]): string[] | undefined {
  const policy = readSessionToolSelectionPolicy(entries);
  return policy?.tools;
}

/** Return the newest valid selection together with its per-session policy. */
export function readSessionToolSelectionPolicy(entries: readonly SessionEntry[]): SessionToolSelectionPolicy | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== TOOL_SELECTION_TYPE) continue;
    const policy = parseToolSelectionData(entry.data);
    if (policy === undefined) continue;
    return policy === CLEARED ? undefined : policy;
  }
  return undefined;
}

export function validateSessionToolSelection(tools: unknown): string[] {
  const parsed = parseToolSelectionData({ version: 1, tools });
  if (parsed === undefined || parsed === CLEARED) {
    throw new Error("toolNames must contain only built-in tool names");
  }
  return parsed.tools;
}

export function appendSessionToolSelection(
  sessionManager: SessionManager,
  tools: readonly string[],
  options: { strict?: boolean } = {},
): void {
  const data: SessionToolSelectionData = {
    version: 1,
    tools: [...tools],
    ...(options.strict === true ? { strict: true as const } : {}),
  };
  sessionManager.appendCustomEntry(TOOL_SELECTION_TYPE, {
    ...data,
  });
}

/** Retract any earlier pin so the session follows settings.json defaultTools again. */
export function appendClearedSessionToolSelection(sessionManager: SessionManager): void {
  sessionManager.appendCustomEntry(TOOL_SELECTION_TYPE, {
    version: 1,
    cleared: true,
  } satisfies ClearedSessionToolSelectionData);
}
