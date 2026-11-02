import { closeSync, fstatSync, openSync, readSync, statSync, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { resolve } from "node:path";
import { SessionManager, buildSessionContext as piBuildSessionContext } from "@earendil-works/pi-coding-agent";
import type { SessionEntry, SessionHeader } from "./types";

/** Entry types that represent real conversation content. */
const CONVERSATION_ENTRY_TYPES = new Set(["message", "compaction", "branch_summary"]);

/**
 * Entry types that are internal metadata and should not determine the
 * conversation's main line when they appear as the physical leaf.
 */
const METADATA_ONLY_ENTRY_TYPES = new Set(["custom", "custom_message", "usage", "label", "context_edit", "session_info"]);

type SessionTree = ReturnType<SessionManager["getTree"]>;
type SessionBranch = ReturnType<SessionManager["getBranch"]>;
type AgentContext = ReturnType<SessionManager["buildSessionContext"]>;

export interface SessionReadSnapshot {
  readonly path: string;
  readonly fileMtimeMs: number;
  readonly fileCtimeMs: number;
  readonly fileSize: number;
  readonly fileDev: number;
  readonly fileIno: number;
  readonly manager: SessionManager;
  readonly entries: SessionEntry[];
  readonly header: SessionHeader | null;
  readonly leafId: string | null;
  readonly name?: string;
  tree?: SessionTree;
  branch?: SessionBranch;
  agentContext?: AgentContext;
}

interface CachedSessionRead {
  snapshot: SessionReadSnapshot;
  parsed: ParsedSessionFile;
  estimatedBytes: number;
  lastUsedAt: number;
}

declare global {
  var __piSessionReadCache: Map<string, CachedSessionRead> | undefined;
}

const MAX_CACHE_ENTRIES = 4;
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_CACHED_FILE_BYTES = 64 * 1024 * 1024;

function cache(): Map<string, CachedSessionRead> {
  globalThis.__piSessionReadCache ??= new Map();
  return globalThis.__piSessionReadCache;
}

function sessionName(entries: readonly SessionEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "session_info") continue;
    return entry.name?.trim() || undefined;
  }
  return undefined;
}

function estimatedCacheBytes(map: Map<string, CachedSessionRead>): number {
  let total = 0;
  for (const entry of map.values()) total += entry.estimatedBytes;
  return total;
}

function evictOldest(map: Map<string, CachedSessionRead>): void {
  let oldestKey: string | undefined;
  let oldestAt = Infinity;
  for (const [key, entry] of map) {
    if (entry.lastUsedAt < oldestAt) {
      oldestKey = key;
      oldestAt = entry.lastUsedAt;
    }
  }
  if (oldestKey) map.delete(oldestKey);
}

function cacheSnapshot(key: string, snapshot: SessionReadSnapshot, parsed: ParsedSessionFile): void {
  const estimatedBytes = Math.max(1024, snapshot.fileSize * 3);
  if (snapshot.fileSize > MAX_CACHED_FILE_BYTES || estimatedBytes > MAX_CACHE_BYTES) return;

  const map = cache();
  map.set(key, { snapshot, parsed, estimatedBytes, lastUsedAt: Date.now() });
  while (map.size > MAX_CACHE_ENTRIES || estimatedCacheBytes(map) > MAX_CACHE_BYTES) {
    evictOldest(map);
  }
}

/**
 * When the SDK's physical leafId points to a pure metadata entry (e.g. a
 * `plan-mode-state` custom entry appended by an extension during idle
 * shutdown), the conversation's main line should instead follow the sibling
 * branch that contains real dialogue content.
 *
 * This corrects the stale-leaf fork caused by a zombie SDK instance writing
 * internal state after the actual conversation ended on a different runtime.
 *
 * Algorithm:
 *  1. If leafId is null or points to a conversation entry, return as-is.
 *  2. Walk up the metadata-only chain to find the fork point (the parent
 *     that has children with real conversation content).
 *  3. Among the fork point's children, keep the branch that carries the
 *     timeline-latest real conversation content, including the metadata entries
 *     appended after that conversation tip (recap results, session_info,
 *     plan-mode state), which belong to that branch.
 *  4. Return that leaf's id.
 *
 * Every branch-derived read (user questions, recap, todos, compaction, cost)
 * then answers from the same line the transcript already renders.
 */
function resolveEffectiveLeafId(
  rawLeafId: string | null,
  entries: readonly SessionEntry[],
): string | null {
  if (!rawLeafId || entries.length === 0) return rawLeafId;

  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) byId.set(entry.id, entry);

  const leafEntry = byId.get(rawLeafId);
  if (!leafEntry) return rawLeafId;

  // If the leaf is a real conversation entry, nothing to correct.
  if (!METADATA_ONLY_ENTRY_TYPES.has(leafEntry.type)) return rawLeafId;

  // Build a children index for the entries we'll need.
  const childrenOf = new Map<string | null, SessionEntry[]>();
  for (const entry of entries) {
    const siblings = childrenOf.get(entry.parentId);
    if (siblings) siblings.push(entry);
    else childrenOf.set(entry.parentId, [entry]);
  }

  // Walk up from the metadata leaf to find the fork point — the closest
  // ancestor whose children include at least one non-metadata branch.
  let current: SessionEntry | undefined = leafEntry;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const parentId: string | null = current.parentId;
    const siblings = childrenOf.get(parentId);
    if (!siblings || siblings.length <= 1) {
      // No fork here; keep walking up.
      current = parentId ? byId.get(parentId) : undefined;
      continue;
    }

    // The physical leaf may be a legitimate metadata entry appended after the
    // selected branch's latest message, not a stale offshoot. Compare the
    // current branch with its siblings by their latest real conversation time;
    // otherwise an older abandoned branch can resurrect simply because a
    // session_info or extension record was appended to it later.
    let best = findConversationBranchLeaf(current, childrenOf, false, Number.NEGATIVE_INFINITY);
    for (const sibling of siblings) {
      if (sibling.id === current.id) continue;
      const candidate = findConversationBranchLeaf(sibling, childrenOf, false, Number.NEGATIVE_INFINITY);
      if (!candidate) continue;
      if (!best || candidate.conversationAt > best.conversationAt) best = candidate;
    }
    if (best) return best.leafId;

    // No sibling has conversation content; keep walking up.
    current = parentId ? byId.get(parentId) : undefined;
  }

  // No better leaf found; return the original.
  return rawLeafId;
}

/**
 * Starting from `entry`, walk down to the deepest leaf of a subtree that
 * carries conversation content, preferring the timeline-latest path.
 *
 * The returned leaf may itself be a metadata entry: entries appended after a
 * conversation tip (recap result, session_info, plan-mode state) are part of
 * that branch, and dropping them would hide the branch's recap and todo
 * snapshot from every branch-derived read. A subtree with no conversation
 * entry anywhere on the path is rejected, so a metadata-only offshoot never
 * wins.
 *
 * `conversationAt` is the timestamp of the deepest conversation entry on the
 * chosen path, so callers can order candidate branches by real dialogue rather
 * than by how recently some side branch received metadata.
 */
interface ConversationBranchLeaf {
  leafId: string;
  conversationAt: number;
}

function findConversationBranchLeaf(
  entry: SessionEntry,
  childrenOf: Map<string | null, SessionEntry[]>,
  conversationSeen: boolean,
  conversationAt = Number.NEGATIVE_INFINITY,
): ConversationBranchLeaf | null {
  const pending = [{ entry, conversationSeen, conversationAt }];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current.entry.id)) continue;
    visited.add(current.entry.id);
    const isConversation = CONVERSATION_ENTRY_TYPES.has(current.entry.type);
    const carriesConversation = current.conversationSeen || isConversation;
    const timestamp = Date.parse(current.entry.timestamp);
    const nextConversationAt = isConversation && Number.isFinite(timestamp) ? timestamp : current.conversationAt;
    const children = childrenOf.get(current.entry.id);
    if (!children || children.length === 0) {
      if (carriesConversation) return { leafId: current.entry.id, conversationAt: nextConversationAt };
      continue;
    }
    // Explicit depth-first traversal preserves the latest-child-first ordering at any depth.
    const sorted = [...children].sort((a, b) => {
      const ta = Date.parse(a.timestamp);
      const tb = Date.parse(b.timestamp);
      return Number.isFinite(ta) && Number.isFinite(tb) ? tb - ta : 0;
    });
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      pending.push({ entry: sorted[index], conversationSeen: carriesConversation, conversationAt: nextConversationAt });
    }
  }
  return null;
}

type SdkFileEntry = NonNullable<Parameters<typeof SessionManager.inMemory>[2]>[number];

interface ParsedSessionFile {
  records: SdkFileEntry[];
  // Only newline-terminated records belong to the reusable prefix. A valid
  // unterminated last record is visible but must be reparsed on the next change.
  completeRecords: number;
  offset: number;
  prefixSha256: string;
  consumedSha256: string;
  incremental: boolean;
}

function parseSessionFile(fd: number, size: number, previous?: ParsedSessionFile): ParsedSessionFile {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let hash = createHash("sha256");
  let offset = 0;
  let records: SdkFileEntry[] = [];
  if (previous?.incremental && previous.offset <= size) {
    // inode identity does not prove append-only: an external editor can rewrite
    // the prefix and grow the same file. Verify bytes, not just size/mtime.
    while (offset < previous.offset) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, previous.offset - offset), offset);
      if (!count) throw new Error("Session file truncated while reading");
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    if (hash.copy().digest("hex") === previous.prefixSha256) {
      records = previous.records.slice(0, previous.completeRecords);
    } else {
      offset = 0;
      hash = createHash("sha256");
    }
  }
  let completeOffset = offset;
  let completeRecords = records.length;
  let prefixSha256 = hash.copy().digest("hex");
  const appendLine = (line: string): void => {
    if (!line.length) return;
    try {
      const value: unknown = JSON.parse(line);
      if (value === null || typeof value !== "object" || Array.isArray(value) || !("type" in value)) return;
      // SAFETY: the SDK normalizes persisted records in memory below.
      records.push(value as SdkFileEntry);
    } catch {
      // Match SDK recovery without repairing malformed or unfinished rows.
    }
  };
  const decoder = new StringDecoder("utf8");
  let pending: string[] = [];
  while (offset < size) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!count) throw new Error("Session file truncated while reading");
    const chunk = buffer.subarray(0, count);
    const text = decoder.write(chunk);
    let start = 0;
    for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", start)) {
      pending.push(text.slice(start, newline));
      appendLine(pending.join(""));
      pending = [];
      start = newline + 1;
    }
    if (start < text.length) pending.push(text.slice(start));
    const completeBytes = chunk.lastIndexOf(10) + 1;
    if (completeBytes > 0) {
      hash.update(chunk.subarray(0, completeBytes));
      completeOffset = offset + completeBytes;
      completeRecords = records.length;
      prefixSha256 = hash.copy().digest("hex");
    }
    hash.update(chunk.subarray(completeBytes));
    offset += count;
  }
  pending.push(decoder.end());
  appendLine(pending.join(""));
  const header = records[0];
  if (!header || header.type !== "session" || typeof header.id !== "string") throw new Error("Invalid session header");
  return {
    records, completeRecords, offset: completeOffset, prefixSha256, consumedSha256: hash.digest("hex"),
    // SDK migration mutates legacy records (v1 also assigns ids); never mix
    // already-normalized entries with newly appended legacy rows.
    incremental: header.version === 3,
  };
}

function matchesConsumedPrefix(fd: number, size: number, expectedSha256: string): boolean {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (let offset = 0; offset < size;) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!count) return false;
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
  return hash.digest("hex") === expectedSha256;
}

function containsConsumedRange(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && after.size >= before.size;
}

/**
 * Share durable read models across detail, history, context and cost. On a
 * change, verify the old prefix and parse only the appended complete rows.
 * Reads never repair or migrate the source, nor mutate an earlier snapshot.
 */
export function getSessionReadSnapshot(filePath: string): SessionReadSnapshot {
  const path = resolve(filePath);
  const map = cache();
  let file: Stats;
  try {
    file = statSync(path);
  } catch (error) {
    map.delete(path);
    throw error;
  }
  const cached = map.get(path);
  if (cached && sameSnapshotVersion(cached.snapshot, file)) {
    cached.lastUsedAt = Date.now();
    return cached.snapshot;
  }

  map.delete(path);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fd = openSync(path, "r");
    try {
      // Bind both metadata and bytes to the same open physical file, then
      // verify the consumed prefix without waiting for the writer to stop.
      const before = fstatSync(fd);
      const previous = cached && cached.snapshot.fileDev === before.dev
        && cached.snapshot.fileIno === before.ino && before.size >= cached.snapshot.fileSize
        ? cached.parsed : undefined;
      let parsed: ParsedSessionFile;
      try {
        parsed = parseSessionFile(fd, before.size, previous);
      } catch (error) {
        if (!sameFileVersion(before, fstatSync(fd))) continue;
        throw error;
      }
      const after = fstatSync(fd);
      const named = statSync(path);
      if (!sameFileVersion(before, after) || !sameFileVersion(before, named)) {
        if (!containsConsumedRange(before, after) || !containsConsumedRange(before, named)
          || !matchesConsumedPrefix(fd, before.size, parsed.consumedSha256)) continue;
        // Validation may itself overlap more appends. Only replacement or
        // truncation invalidates this verified, fixed-size prefix snapshot.
        if (!containsConsumedRange(before, fstatSync(fd)) || !containsConsumedRange(before, statSync(path))) continue;
      }
      const header = parsed.records[0] as SessionHeader;
      const manager = SessionManager.inMemory(header.cwd, undefined, parsed.records);
      // SAFETY: SDK and Reader mirror the persisted entry shape; their message unions differ.
      const entries = manager.getEntries() as unknown as SessionEntry[];
      const snapshot: SessionReadSnapshot = {
        path,
        fileMtimeMs: before.mtimeMs,
        fileCtimeMs: before.ctimeMs,
        fileSize: before.size,
        fileDev: before.dev,
        fileIno: before.ino,
        manager,
        entries,
        header: manager.getHeader() as SessionHeader | null,
        leafId: resolveEffectiveLeafId(manager.getLeafId(), entries),
        name: sessionName(entries),
      };
      cacheSnapshot(path, snapshot, parsed);
      return snapshot;
    } finally {
      closeSync(fd);
    }
  }
  throw new Error("Session file changed repeatedly while reading");
}

function sameSnapshotVersion(snapshot: SessionReadSnapshot, file: Stats): boolean {
  return snapshot.fileSize === file.size
    && snapshot.fileMtimeMs === file.mtimeMs
    && snapshot.fileCtimeMs === file.ctimeMs
    && snapshot.fileDev === file.dev
    && snapshot.fileIno === file.ino;
}

function sameFileVersion(before: Stats, after: Stats): boolean {
  return before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs
    && before.dev === after.dev
    && before.ino === after.ino;
}

export function getSessionReadTree(snapshot: SessionReadSnapshot): SessionTree {
  snapshot.tree ??= snapshot.manager.getTree();
  return snapshot.tree;
}

export function getSessionReadBranch(snapshot: SessionReadSnapshot): SessionBranch {
  // Every branch-derived read (user questions, recap, todos, compaction, cost)
  // must share one definition of "current branch": the snapshot's resolved
  // leaf. Falling back to the manager's physical leaf would answer from a
  // metadata-only side branch (plan-mode state, quick-ask thread, zombie SDK
  // state) while the transcript already renders the resolved main line.
  snapshot.branch ??= snapshot.leafId === null
    ? []
    : snapshot.manager.getBranch(snapshot.leafId);
  return snapshot.branch;
}

export function getSessionReadAgentContext(snapshot: SessionReadSnapshot): AgentContext {
  // Same single source as getSessionReadBranch: build from the resolved leaf
  // instead of the manager's internal pointer.
  snapshot.agentContext ??= piBuildSessionContext(snapshot.entries as never, snapshot.leafId);
  return snapshot.agentContext;
}

/** Explicit content/path invalidation. Omit the path only for a full reset. */
export function invalidateSessionReadCache(filePath?: string): void {
  if (filePath === undefined) globalThis.__piSessionReadCache?.clear();
  else if (filePath) globalThis.__piSessionReadCache?.delete(resolve(filePath));
}
