/**
 * Side chats (ADR 0007): a focused detour beside the main chat. A side chat is
 * a normal session forked from a parent's active tip (`createSideSession()` in
 * `lib/session-fork.ts`) with two differences, all decided here: a
 * `pi-web:side` entry hides it in its parent's family, and a hidden metadata
 * entry marks where the inherited history ends. The runtime keeps the source
 * session's loadout and does not send that metadata entry to the provider.
 */

import { SIDE_BOUNDARY_MESSAGE_TYPE } from "./session-family.ts";
import type { SessionEntry } from "./types";

export const SIDE_META_TYPE = "pi-web:side";

/** Retained in Side metadata for Reader-side history and usage boundaries. */
export const SIDE_BOUNDARY_TEXT = "[Side chat] This is a note from the app, not from the user. Everything above is inherited from a parent session as background, frozen when this side chat started. It is not your current task, and work left unfinished in it is not yours to continue. Only messages after this note are active.";

type SideMetadata = { version: 1; parentSessionId: string; createdAt: string };

function readSideMetadata(entries: readonly SessionEntry[]): SideMetadata | null {
  const entry = entries.find((item) => item.type === "custom" && item.customType === SIDE_META_TYPE);
  if (entry?.type !== "custom" || typeof entry.data !== "object" || entry.data === null) return null;
  const data = entry.data as Partial<SideMetadata>;
  if (data.version !== 1 || typeof data.parentSessionId !== "string" || typeof data.createdAt !== "string") return null;
  return data as SideMetadata;
}

/** A side chat's parent, from its metadata entry; null when the entries hold none. */
export function readSideRelation(entries: readonly SessionEntry[]): { parentSessionId: string } | null {
  const data = readSideMetadata(entries);
  return data ? { parentSessionId: data.parentSessionId } : null;
}

/** Whether any entry is a side metadata entry, valid or not: a broken one must never reopen with full tools. */
export function hasSideMetadata(entries: readonly SessionEntry[]): boolean {
  return entries.some((entry) => entry.type === "custom" && entry.customType === SIDE_META_TYPE);
}

/** The metadata entry a new side chat carries, to be written directly after its header. */
export function createSideMetadataEntry(parentSessionId: string, id: string, parentId: string | null) {
  const timestamp = new Date().toISOString();
  return {
    type: "custom",
    customType: SIDE_META_TYPE,
    data: { version: 1, parentSessionId, createdAt: timestamp } satisfies SideMetadata,
    id,
    parentId,
    timestamp,
  };
}

/** The hidden metadata entry that marks the end of inherited Side history. */
export function createSideBoundaryEntry(id: string, parentId: string) {
  return {
    type: "custom",
    customType: SIDE_BOUNDARY_MESSAGE_TYPE,
    data: { content: SIDE_BOUNDARY_TEXT },
    id,
    parentId,
    timestamp: new Date().toISOString(),
  };
}

/**
 * The entries a side chat added itself: everything after its durable boundary.
 * Usage is counted on these, or the parent's would count twice.
 */
export function sideOwnEntries<T extends { timestamp?: string }>(entries: readonly T[]): readonly T[] {
  const boundaryIndex = entries.findLastIndex((entry) => {
    const value = entry as T & { type?: unknown; customType?: unknown };
    return (value.type === "custom" || value.type === "custom_message") && value.customType === SIDE_BOUNDARY_MESSAGE_TYPE;
  });
  if (boundaryIndex >= 0) return entries.slice(boundaryIndex + 1);

  // Older or damaged transcripts may retain metadata without the boundary.
  // SAFETY: callers pass SessionEntry-shaped records; the metadata reader only inspects their timestamps and custom fields.
  const createdAt = readSideMetadata(entries as unknown as SessionEntry[])?.createdAt;
  return createdAt ? entries.filter((entry) => (entry.timestamp ?? "") > createdAt) : entries;
}

/** The first durable conversation entry written after the inherited boundary. */
export function sideFirstMessageEntryId(entries: readonly SessionEntry[]): string | null {
  // SAFETY: sideOwnEntries preserves the original SessionEntry objects and only narrows the readonly view.
  const own = sideOwnEntries(entries);
  return own.find((entry) => entry.type === "message" && entry.message.role === "user")?.id ?? null;
}

/** Number of user turns that belong to the side chat, excluding inherited history. */
export function sideUserMessageCount(entries: readonly SessionEntry[]): number {
  return sideOwnEntries(entries).filter((entry) => entry.type === "message" && entry.message.role === "user").length;
}
