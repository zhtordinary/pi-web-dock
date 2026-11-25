import { randomBytes, randomUUID } from "crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { forkSessionName, sessionDisplayTitle } from "./session-fork-name";
import { scanSessionFileInfo } from "./session-list-scanner";
import { readSubagentRun } from "./subagents";
import { SIDE_BOUNDARY_MESSAGE_TYPE, SIDE_SESSION_NAME } from "./session-family.ts";
import { appendClearedSessionToolSelection, appendSessionToolSelection, createSessionToolSelectionEntry, readSessionToolSelectionPolicy, TOOL_SELECTION_TYPE, type SessionToolSelectionPolicy } from "./session-tool-selection";
import { createSideBoundaryEntry, createSideMetadataEntry, readSideRelation, SIDE_META_TYPE } from "./side-session";
import { promptCacheLineageForCopy, PROMPT_CACHE_LINEAGE_HEADER, readPromptCacheLineage } from "./prompt-cache-lineage";
import type { SessionEntry } from "./types";

/**
 * The sidebar's Fork: pi's `/clone` (a copy of the current branch, positioned
 * at its leaf) done on disk, so it never needs, starts or touches an
 * AgentSession and works while the source runs. Unlike `/clone`, the copy is
 * named: the source's title plus a short random suffix (session-fork-name.ts).
 */

export type SessionForkRefusal = "not_found" | "unsaved" | "empty" | "subagent" | "side" | "cwd-invalid" | "cwd-exists";

export class SessionForkError extends Error {
  constructor(readonly code: SessionForkRefusal, message: string) {
    super(message);
    this.name = "SessionForkError";
  }
}

/** The session list's first message for a session with no user text (scanSessionFileInfo()). */
const NO_USER_TEXT = "(no messages)";

/**
 * The title the sidebar shows for the source, read as the session list reads
 * its row: the newest `session_info` name in the file, else its first user
 * message. Null when the source has neither (shell-only, or only images from
 * its user): the list's "(no messages)" placeholder is no title to keep, and
 * the copy is left unnamed, to take its first real message as pi's `/clone`
 * would. Undefined when the file cannot be read (not written yet) or the
 * title is blank.
 */
export async function readForkSourceTitle(sourcePath: string): Promise<string | null | undefined> {
  const scanned = await scanSessionFileInfo(sourcePath);
  if (!scanned) return undefined;
  if (!scanned.name && scanned.firstMessage === NO_USER_TEXT) return null;
  return sessionDisplayTitle(scanned).trim() || undefined;
}

/**
 * Copies the branch that ends at the leaf into a new session file beside the
 * source (same directory and cwd, header `parentSession` = the source) and
 * names the copy after `sourceTitle` (readForkSourceTitle(); without one, or
 * with a blank one, after the source's id, as a row with no title shows it)
 * plus 4 random hex digits; `sourceTitle` null leaves the copy unnamed.
 * `liveLeafId` is an open wrapper's leaf (null: its leaf was reset before the
 * first entry); undefined means the file's own leaf, its last entry.
 *
 * Only entries already on disk are copied: pi appends each finished entry
 * synchronously in this process, so a run in progress contributes what it has
 * finished. Opens its own SessionManager, because createBranchedSession()
 * repoints the instance it runs on: never the cached reader of
 * openSessionManager() nor a wrapper's. The name is a `session_info` entry
 * appended on that instance, as a rename appends one, so only the copy gets
 * it. pi's open-time migration may rewrite an old-version source, as viewing
 * it does; the source is otherwise unchanged.
 */
export function forkSessionBranch(
  sourcePath: string,
  liveLeafId?: string | null,
  sourceTitle?: string | null,
): { sessionId: string; path: string; name: string | undefined } {
  return copySessionBranch(sourcePath, liveLeafId, (manager) => (sourceTitle === null ? undefined : forkSessionName(
    sourceTitle?.trim() || manager.getSessionId().slice(0, 12),
    randomBytes(2).toString("hex"),
    typeof manager.getHeader()?.parentSession === "string",
  )));
}

/**
 * The same copy as a side chat (ADR 0007, `lib/side-session.ts`): the metadata
 * entry goes directly after the header, where the list's bounded head read
 * finds it, with the first copied entry chained under it, and the hidden
 * boundary message goes last, as the new leaf. A parent reads its tool pin from
 * the whole file, and the copy holds one branch, so the pin is written again
 * before the boundary: one set on another branch still binds the side chat. The
 * copy is brand new and has no wrapper yet, so this is the only rewrite it ever
 * gets.
 */
export function createSideSession(
  sourcePath: string,
  liveLeafId?: string | null,
  name: string = SIDE_SESSION_NAME,
): { sessionId: string; path: string } {
  const copy = copySessionBranch(sourcePath, liveLeafId, () => name);
  const [header, first, ...rest] = readFileSync(copy.path, "utf8").trimEnd().split("\n");
  const firstEntry = JSON.parse(first) as { parentId?: string | null };
  const metadata = createSideMetadataEntry(copy.sourceSessionId, `side-${randomUUID()}`, firstEntry.parentId ?? null);
  firstEntry.parentId = metadata.id;
  const leaf = JSON.parse(rest.at(-1) ?? first) as { id: string };
  const pin = copy.toolSelection && createSessionToolSelectionEntry(copy.toolSelection, `side-tools-${randomUUID()}`, leaf.id);
  const boundary = createSideBoundaryEntry(`side-boundary-${randomUUID()}`, pin?.id ?? leaf.id);
  const added = [...(pin ? [pin] : []), boundary].map((entry) => JSON.stringify(entry));
  writeFileSync(copy.path, [header, JSON.stringify(metadata), JSON.stringify(firstEntry), ...rest, ...added].join("\n") + "\n", { encoding: "utf8" });
  return { sessionId: copy.sessionId, path: copy.path };
}

/** Create a visible normal fork from a hidden side session without changing the source. */
export function promoteSideSession(
  sourcePath: string,
  liveLeafId?: string | null,
  sourceTitle?: string | null,
): { sessionId: string; path: string; name: string | undefined } {
  const copy = copySessionBranch(sourcePath, liveLeafId, (manager) => (sourceTitle === null ? undefined : forkSessionName(
    sourceTitle?.trim() || manager.getSessionId().slice(0, 12),
    randomBytes(2).toString("hex"),
    typeof manager.getHeader()?.parentSession === "string",
  )), true);
  const lines = readFileSync(copy.path, "utf8").trimEnd().split("\n");
  const header = JSON.parse(lines.shift() ?? "null") as Record<string, unknown>;
  const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const removedIds = new Set(entries.filter((entry) => isSideOnlyEntry(entry)).map((entry) => String(entry.id)));
  const byId = new Map(entries.map((entry) => [String(entry.id), entry]));
  const retained = entries.filter((entry) => !isSideOnlyEntry(entry));
  for (const entry of retained) {
    let parentId = typeof entry.parentId === "string" ? entry.parentId : null;
    while (parentId && removedIds.has(parentId)) {
      parentId = typeof byId.get(parentId)?.parentId === "string" ? String(byId.get(parentId)?.parentId) : null;
    }
    entry.parentId = parentId;
  }
  writeFileSync(copy.path, [JSON.stringify(header), ...retained.map((entry) => JSON.stringify(entry))].join("\n") + "\n", { encoding: "utf8" });
  return { sessionId: copy.sessionId, path: copy.path, name: copy.name };
}

function isSideOnlyEntry(entry: Record<string, unknown>): boolean {
  if (entry.type === "custom" && entry.customType === SIDE_META_TYPE) return true;
  if ((entry.type === "custom" || entry.type === "custom_message") && entry.customType === SIDE_BOUNDARY_MESSAGE_TYPE) return true;
  return entry.type === "custom"
    && entry.customType === TOOL_SELECTION_TYPE
    && typeof entry.id === "string"
    && entry.id.startsWith("side-tools-");
}

/**
 * Fork a whole ordinary session into a selected directory when its recorded
 * cwd is gone. The source stays untouched and side/subagent sessions remain
 * refused so their hidden family boundaries cannot leak into a normal fork.
 */
export function forkSessionIntoCwd(sourcePath: string, targetCwd: string): { sessionId: string; path: string } {
  if (!existsSync(sourcePath)) throw new SessionForkError("not_found", "Session not found");
  let targetIsDirectory = false;
  try { targetIsDirectory = statSync(targetCwd).isDirectory(); } catch { /* report below */ }
  if (!targetIsDirectory) throw new SessionForkError("cwd-invalid", `Directory does not exist: ${targetCwd}`);

  const source = SessionManager.open(sourcePath);
  const sourceCwd = source.getCwd();
  if (sourceCwd && existsSync(sourceCwd)) {
    throw new SessionForkError("cwd-exists", `The session's folder still exists: ${sourceCwd}`);
  }
  // SAFETY: SessionManager entries use the same persisted SessionEntry wire shape as Reader.
  const entries = source.getEntries() as unknown as SessionEntry[];
  if (readSubagentRun(entries, "", sourcePath)) {
    throw new SessionForkError("subagent", "A subagent session cannot be forked");
  }
  if (readSideRelation(entries)) throw new SessionForkError("side", "A side chat cannot be forked");
  if (!entries.some((entry) => entry.type === "message")) {
    throw new SessionForkError("empty", "Nothing to fork: the session has no messages");
  }

  const fork = SessionManager.forkFrom(sourcePath, targetCwd);
  const path = fork.getSessionFile();
  if (!path || !existsSync(path)) throw new Error("Failed to fork the session");
  return { sessionId: fork.getSessionId(), path };
}

function copySessionBranch(
  sourcePath: string,
  liveLeafId: string | null | undefined,
  nameFor: (source: SessionManager) => string | undefined,
  allowSide = false,
): { sessionId: string; path: string; name: string | undefined; sourceSessionId: string; toolSelection: SessionToolSelectionPolicy | undefined } {
  const live = liveLeafId !== undefined;
  // SessionManager.open() of a missing path silently starts an empty session.
  if (!existsSync(sourcePath)) {
    throw live
      ? new SessionForkError("unsaved", "This session has not been saved yet. Send a message before forking it.")
      : new SessionForkError("not_found", "Session not found");
  }
  const manager = SessionManager.open(sourcePath);
  const leafId = live ? liveLeafId : manager.getLeafId();
  if (!leafId) throw new SessionForkError("empty", "Nothing to fork: the session has no messages");
  // The wrapper's leaf is an entry not written yet.
  if (!manager.getEntry(leafId)) {
    throw new SessionForkError("unsaved", "This session has not been saved yet. Send a message before forking it.");
  }

  const branch = manager.getBranch(leafId);
  // A copy carrying a subagent's metadata would be read as that subagent and
  // folded, out of sight, into its parent's family.
  // SAFETY: SessionManager branch entries use the same persisted SessionEntry wire shape as Reader.
  if (readSubagentRun(branch as unknown as SessionEntry[], "", sourcePath)) {
    throw new SessionForkError("subagent", "A subagent session cannot be forked");
  }
  // SAFETY: SessionManager branch entries use the same persisted SessionEntry wire shape as Reader.
  const sideRelation = readSideRelation(branch as unknown as SessionEntry[]);
  if (sideRelation && !allowSide) {
    throw new SessionForkError("side", "A side chat can only be promoted to a visible session");
  }
  if (allowSide && !sideRelation) {
    throw new SessionForkError("side", "Only a side chat can be promoted");
  }
  if (!branch.some((entry) => entry.type === "message")) {
    throw new SessionForkError("empty", "Nothing to fork: the session has no messages");
  }

  // Read before createBranchedSession() repoints the instance to the copy.
  const name = nameFor(manager);
  const sourceSessionId = manager.getSessionId();
  // SAFETY: SessionManager entries use the same persisted SessionEntry wire shape as Reader.
  const sourceHeader = manager.getHeader();
  const promptCacheLineage = promptCacheLineageForCopy(sourceSessionId, sourceHeader);
  const toolSelection = readSessionToolSelectionPolicy(manager.getEntries() as unknown as SessionEntry[]);
  const path = manager.createBranchedSession(leafId);
  // SessionManager intentionally creates a fresh header for a branch. Keep
  // the cache lineage while leaving the new runtime/session identity intact.
  const childHeader = manager.getHeader() as (Record<string, unknown> & { type?: string }) | null;
  if (childHeader && promptCacheLineage) childHeader[PROMPT_CACHE_LINEAGE_HEADER] = promptCacheLineage;
  if (path && existsSync(path) && childHeader && promptCacheLineage && readPromptCacheLineage(childHeader) === promptCacheLineage) {
    const content = [childHeader, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    writeFileSync(path, content, { encoding: "utf8" });
  }
  // Tool selections are session-wide even when the copied branch predates the latest selection.
  const branchToolSelection = readSessionToolSelectionPolicy(manager.getEntries() as unknown as SessionEntry[]);
  if (JSON.stringify(branchToolSelection) !== JSON.stringify(toolSelection)) {
    if (toolSelection) appendSessionToolSelection(manager, toolSelection.tools, { strict: toolSelection.strict });
    else appendClearedSessionToolSelection(manager);
  }
  // Appended to the copy's file; a shell-only copy keeps it in memory until
  // it is written below.
  if (name) manager.appendSessionInfo(name);
  if (path && !existsSync(path)) {
    // pi writes the copy only once it has a user or assistant message; a
    // shell-only branch (pi-web keeps those sessions) is written here.
    const header = manager.getHeader();
    if (header) {
      const content = [header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
      writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
    }
  }
  if (!path || !existsSync(path)) throw new Error("Failed to fork the session");
  return { sessionId: manager.getSessionId(), path, name, sourceSessionId, toolSelection };
}
