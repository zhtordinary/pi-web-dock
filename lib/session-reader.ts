(globalThis as Record<string, unknown>).__piOriginalSessionManagerListAll ??= SessionManager.listAll;
import {
  SessionManager,
  buildContextEntries as piBuildContextEntries,
  buildSessionContext as piBuildSessionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "fs";
import { readdir } from "fs/promises";
import { isAbsolute, join, normalize as normalizePath, relative, resolve as resolvePath, sep } from "path";
import { getPiSessionRoots } from "./session-archive";
import { pruneOrphanedSubprojectAssignments } from "./subproject-state";
import type { AgentMessage, ImageContent, SessionEntry, SessionHeader, SessionInfo, SessionContext, SessionHistoryInfo, TextContent } from "./types";
import type { SessionEntry as PiSessionEntry, SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";
import { normalizeToolCalls } from "./normalize";
import { getThinkingPreview } from "./message-display";
import { projectIdentityKey } from "./project-identity";
import { sessionPathKey } from "./session-path";
import { readSubagentRun, SUBAGENT_META_TYPE } from "./subagents";
import { listSessionsIncremental, type ScannedSessionInfo } from "./session-list-scanner";
import { listWorktrees, resolveProject, type ProjectInfo } from "./worktree";
import { draftViewByTarget, latestQuestionAnalysisJobs, toQuestionAnalysisJobView, type QuestionAnalysisJobView, type QuestionDraftView } from "./question-analysis-jobs";
import { MAX_TOOL_RESULT_IMAGE_BYTES, TOOL_RESULT_IMAGE_MIMES } from "./tool-result-images";
import { getSessionReadSnapshot, invalidateSessionReadCache } from "./session-read-cache";
import { sessionDisplayInputs, SESSION_DISPLAY_INPUT_CUSTOM_TYPE } from "./session-hover-preview";
import { sessionControlDisplayText } from "./session-control-display";

export { getAgentDir };

const SESSION_HEADER_MAX_BYTES = 64 * 1024;
const SESSION_RELATION_MAX_BYTES = 256 * 1024;
const SESSION_RELATION_MAX_LINES = 2;
const SESSION_RESULT_MAX_BYTES = 256 * 1024;
const SESSION_TAIL_PROBE_MAX_BYTES = 64 * 1024;

function readBoundedLines(filePath: string, maxBytes: number, maxLines: number): string[] {
  const fd = openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let position = 0;
    let newlineCount = 0;
    let reachedEof = false;
    while (position < maxBytes && newlineCount < maxLines) {
      const buffer = Buffer.allocUnsafe(Math.min(4096, maxBytes - position));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) { reachedEof = true; break; }
      position += bytesRead;
      const data = buffer.subarray(0, bytesRead);
      let end = data.length;
      for (let index = 0; index < data.length; index += 1) {
        if (data[index] !== 0x0a) continue;
        newlineCount += 1;
        if (newlineCount === maxLines) { end = index + 1; break; }
      }
      chunks.push(data.subarray(0, end));
    }
    const source = Buffer.concat(chunks).toString("utf8");
    const lines = source.split("\n");
    if (!reachedEof && !source.endsWith("\n")) lines.pop();
    if (lines.at(-1) === "") lines.pop();
    return lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  } finally { closeSync(fd); }
}

function readBoundedTailLines(filePath: string, maxBytes: number): string[] {
  const fd = openSync(filePath, "r");
  try {
    const fileSize = fstatSync(fd).size;
    const start = Math.max(0, fileSize - maxBytes);
    const buffer = Buffer.allocUnsafe(fileSize - start);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    if (bytesRead === 0) return [];
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (start > 0) {
      const previousByte = Buffer.allocUnsafe(1);
      readSync(fd, previousByte, 0, 1, start - 1);
      if (previousByte[0] !== 0x0a) lines.shift();
    }
    if (lines.at(-1) === "") lines.pop();
    return lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  } finally { closeSync(fd); }
}

function safeIsoDate(value: unknown): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  return typeof value === "string" ? value : String(value ?? "");
}

function parseSessionEntries(lines: readonly string[]): SessionEntry[] {
  return lines.flatMap((line) => {
    try { return [JSON.parse(line) as SessionEntry]; } catch { return []; }
  });
}

function readSessionRelationEntries(filePath: string): SessionEntry[] {
  const prefix = parseSessionEntries(readBoundedLines(filePath, SESSION_RELATION_MAX_BYTES, SESSION_RELATION_MAX_LINES).slice(1));
  if (!prefix.some((entry) => entry.type === "custom" && entry.customType === SUBAGENT_META_TYPE)) return prefix;
  return [...prefix, ...parseSessionEntries(readBoundedTailLines(filePath, SESSION_RESULT_MAX_BYTES))];
}

export function readLatestSessionEntryId(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  let lines: string[];
  try { lines = readBoundedTailLines(filePath, SESSION_TAIL_PROBE_MAX_BYTES); } catch { return undefined; }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]) as { type?: unknown; id?: unknown };
      if (entry.type !== "session" && typeof entry.id === "string" && entry.id) return entry.id;
    } catch { /* Ignore torn trailing lines and continue backward. */ }
  }
  return undefined;
}

export async function attachSessionProjectInfo(sessions: SessionInfo[], projectSessionIds?: ReadonlySet<string>): Promise<SessionInfo[]> {
  const uniqueCwds = [...new Set(sessions.filter((s) => !projectSessionIds || projectSessionIds.has(s.id)).map((s) => s.cwd).filter(Boolean))];
  const projectEntries = await Promise.all(uniqueCwds.map(async (cwd) => {
    return [cwd, await resolveProject(cwd)] as const;
  }));
  const projectByCwd = new Map<string, ProjectInfo>(projectEntries);

  return sessions.map((session) => {
    const project = session.cwd ? projectByCwd.get(session.cwd) : undefined;
    const projectRoot = project?.projectRoot ?? session.cwd;
    return {
      ...session,
      projectRoot,
      projectKey: projectIdentityKey(projectRoot),
      ...(project ? { isGit: project.isGit } : {}),
      ...(project?.branch ? { branch: project.branch } : {}),
      ...(project?.isWorktree
        ? {
            isWorktree: true,
            ...(project.branch ? { worktreeBranch: project.branch } : {}),
          }
        : {}),
    };
  });
}

interface FirstMessageDisplayCacheEntry {
  mtimeMs: number;
  size: number;
  message: string;
  contextSourceSessionId?: string;
}

interface SessionListDisplayInfo {
  message: string;
  contextSourceSessionId?: string;
}

const FIRST_MESSAGE_CACHE_MAX_ENTRIES = 4_000;

function getFirstMessageCache(): Map<string, FirstMessageDisplayCacheEntry> {
  if (!globalThis.__piFirstMessageCache) globalThis.__piFirstMessageCache = new Map();
  return globalThis.__piFirstMessageCache;
}

function extractFirstMessageDisplayFast(filePath: string, fallback: string): SessionListDisplayInfo {
  let fd: number | undefined;
  let contextSourceSessionId: string | undefined;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.alloc(65536);
    const bytesRead = readSync(fd, buf, 0, 65536, 0);
    closeSync(fd);
    fd = undefined;

    const text = buf.toString("utf8", 0, bytesRead);
    const lines = text.split("\n");
    let firstUserMsgId: string | undefined;
    let firstSessionControlMessage: string | undefined;
    const displayInputs = new Map<string, string>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (entry.type === "session") {
        const sourceId = typeof entry.contextSourceSessionId === "string" ? entry.contextSourceSessionId.trim() : "";
        if (sourceId) contextSourceSessionId = sourceId;
      } else if (!firstSessionControlMessage) {
        firstSessionControlMessage = sessionControlDisplayText(entry);
        if (firstSessionControlMessage) {
          // Keep scanning: a real user message remains the canonical title.
          continue;
        }
      }
      if (entry.type === "message") {
        const msg = entry.message as Record<string, unknown> | undefined;
        if (msg?.role === "user" && !firstUserMsgId) {
          firstUserMsgId = typeof entry.id === "string" ? entry.id : undefined;
          if (firstUserMsgId && displayInputs.has(firstUserMsgId)) {
            return {
              message: displayInputs.get(firstUserMsgId)!,
              ...(contextSourceSessionId ? { contextSourceSessionId } : {}),
            };
          }
        } else if (firstUserMsgId && (msg?.role === "assistant" || msg?.role === "toolResult")) {
          break;
        }
      } else if (entry.type === "custom" && entry.customType === SESSION_DISPLAY_INPUT_CUSTOM_TYPE) {
        const data = entry.data as Record<string, unknown> | undefined;
        const targetEntryId = typeof data?.targetEntryId === "string" ? data.targetEntryId.trim() : undefined;
        const input = typeof data?.input === "string" ? data.input.trim() : undefined;
        if (targetEntryId && input) {
          displayInputs.set(targetEntryId, input);
          if (firstUserMsgId && targetEntryId === firstUserMsgId) {
            return {
              message: input,
              ...(contextSourceSessionId ? { contextSourceSessionId } : {}),
            };
          }
        }
      }

      if (i > 100) break;
    }

    if (firstUserMsgId && displayInputs.has(firstUserMsgId)) {
      return {
        message: displayInputs.get(firstUserMsgId)!,
        ...(contextSourceSessionId ? { contextSourceSessionId } : {}),
      };
    }
    if (!firstUserMsgId && firstSessionControlMessage) {
      return {
        message: firstSessionControlMessage,
        ...(contextSourceSessionId ? { contextSourceSessionId } : {}),
      };
    }
  } catch {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
  return { message: fallback, ...(contextSourceSessionId ? { contextSourceSessionId } : {}) };
}

function sessionListDisplayInfo(filePath: string, fallback: string): SessionListDisplayInfo {
  try {
    if (!existsSync(filePath)) return { message: fallback };
    const fileStat = statSync(filePath);
    const cache = getFirstMessageCache();
    const cached = cache.get(filePath);
    if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
      return {
        message: cached.message,
        ...(cached.contextSourceSessionId ? { contextSourceSessionId: cached.contextSourceSessionId } : {}),
      };
    }

    const info = extractFirstMessageDisplayFast(filePath, fallback);
    cache.delete(filePath);
    cache.set(filePath, {
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
      message: info.message,
      ...(info.contextSourceSessionId ? { contextSourceSessionId: info.contextSourceSessionId } : {}),
    });
    trimMap(cache, FIRST_MESSAGE_CACHE_MAX_ENTRIES);
    return info;
  } catch {
    return { message: fallback };
  }
}

function isCurrentPersistedSession(session: SessionInfo, includeArchived: boolean): boolean {
  const scope = session.path ? sessionPathScope(session.path) : undefined;
  // Keep this helper usable with synthetic paths in pure merge callers; real
  // Reader listings always live under one of the two session roots.
  if (!scope) return Boolean(session.path);
  if (!existsSync(session.path)) return false;
  return scope === "active" || (includeArchived && scope === "archived");
}

function filterCurrentPersistedSessions(sessions: SessionInfo[], includeArchived: boolean): SessionInfo[] {
  return sessions.filter((session) => isCurrentPersistedSession(session, includeArchived));
}

export function mergeSessionLists(
  persistedSessions: SessionInfo[],
  supplementalSessions: SessionInfo[],
  options: { includeArchived?: boolean } = {},
): SessionInfo[] {
  const includeArchived = options.includeArchived === true;
  const currentPersistedSessions = filterCurrentPersistedSessions(persistedSessions, includeArchived);
  const archivedSessionsDir = resolvePath(getPiSessionRoots().archivedSessionsDir);
  const currentRuntimeSessions = supplementalSessions.filter((session) => {
    const archivedPath = session.path
      ? resolvePathWithinDefaultSessions(session.path, archivedSessionsDir)
      : null;
    if (archivedPath) {
      return includeArchived && (session.transient === true || existsSync(session.path));
    }
    // A runtime snapshot may outlive its JSONL move/delete. Keep only real
    // files, except explicitly transient sessions that have not been flushed.
    return session.transient === true || Boolean(session.path && existsSync(session.path));
  });
  const byId = new Map(currentRuntimeSessions.map((session) => [session.id, session]));
  // A disk scan is authoritative once the JSONL exists. In particular, this
  // replaces a transient registry snapshot without briefly rendering two rows.
  for (const session of currentPersistedSessions) byId.set(session.id, session);
  return [...byId.values()].sort((a, b) => b.modified.localeCompare(a.modified));
}

async function loadAllSessionsFromSdk(projectSessionIds?: ReadonlySet<string>): Promise<SessionInfo[]> {
  const piSessions: PiSessionInfo[] = await SessionManager.listAll();
  const pathToId = new Map<string, string>();
  for (const s of piSessions) pathToId.set(sessionPathKey(s.path), s.id);

  const sessions = piSessions
    .map((s) => {
    cacheSessionPath(s.id, s.path);
    const displayInfo = sessionListDisplayInfo(s.path, s.firstMessage || "(no messages)");
    return {
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      created: safeIsoDate(s.created),
      modified: safeIsoDate(s.modified),
      messageCount: s.messageCount,
      firstMessage: displayInfo.message,
      parentSessionId: s.parentSessionPath ? pathToId.get(sessionPathKey(s.parentSessionPath)) : undefined,
      ...(displayInfo.contextSourceSessionId ? { contextSourceSessionId: displayInfo.contextSourceSessionId } : {}),
      transient: false,
    };
  });
  return filterCurrentPersistedSessions(await attachSessionProjectInfo(sessions, projectSessionIds), false);
}

function sessionDirectoryForCwd(cwd: string): string {
  const safePath = `--${resolvePath(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(getPiSessionRoots().sessionsDir, safePath);
}

export async function listProjectSessions(
  projectRoot: string,
  supplementalSessions: SessionInfo[] = [],
): Promise<SessionInfo[]> {
  const requestedRoot = projectRoot.trim();
  if (!requestedRoot || !isAbsolute(requestedRoot)) throw new Error("projectRoot must be an absolute path");

  const project = await resolveProject(requestedRoot);
  const projectCwds = new Set([requestedRoot, project.projectRoot]);
  if (project.isTopLevel) {
    try {
      for (const worktree of await listWorktrees(project.projectRoot)) {
        projectCwds.add(worktree.path);
      }
    } catch {
      // Non-Git workspaces (or unavailable Git) still use the primary session directory.
    }
  }

  const piSessions = (await Promise.all(
    [...projectCwds].map((cwd) => SessionManager.list(cwd, sessionDirectoryForCwd(cwd))),
  )).flat();
  const pathToId = new Map(piSessions.map((session) => [sessionPathKey(session.path), session.id]));
  const sessions = piSessions
    .map((session) => {
      cacheSessionPath(session.id, session.path);
      const displayInfo = sessionListDisplayInfo(session.path, session.firstMessage || "(no messages)");
      return {
        path: session.path,
        id: session.id,
        cwd: session.cwd,
        name: session.name,
        created: safeIsoDate(session.created),
        modified: safeIsoDate(session.modified),
        messageCount: session.messageCount,
        firstMessage: displayInfo.message,
        parentSessionId: session.parentSessionPath ? pathToId.get(sessionPathKey(session.parentSessionPath)) : undefined,
        ...(displayInfo.contextSourceSessionId ? { contextSourceSessionId: displayInfo.contextSourceSessionId } : {}),
        transient: false,
      };
    });
  const attachedSessions = await attachSessionProjectInfo(sessions);
  const persistedSessions = filterCurrentPersistedSessions(attachedSessions, false)
    .filter((session) => session.projectRoot === project.projectRoot);
  const runtimeSessions = await attachSessionProjectInfo(
    supplementalSessions.filter((session) => session.cwd && projectCwds.has(session.cwd)),
  );
  return mergeSessionLists(persistedSessions, runtimeSessions);
}

type ScannedSubagent = NonNullable<ReturnType<typeof readSubagentRun>>;

function buildScannedSessionList(scanned: ScannedSessionInfo[], archived = false, projectSessionIds?: ReadonlySet<string>): Promise<SessionInfo[]> {
  const pathToId = new Map<string, string>();
  for (const session of scanned) pathToId.set(sessionPathKey(session.path), session.id);
  const sessions = scanned
    .map((item) => {
    cacheSessionPath(item.id, item.path);
    const parentSessionId = item.parentSessionPath ? pathToId.get(sessionPathKey(item.parentSessionPath)) : undefined;
    let subagent: ScannedSubagent | null = null;
    if (item.parentSessionPath) {
      try { subagent = readSubagentRun(readSessionRelationEntries(item.path), item.id, item.path); } catch { /* Concurrent removal or malformed session. */ }
    }
    return {
      path: item.path,
      id: item.id,
      cwd: item.cwd,
      name: item.name,
      created: item.created.toISOString(),
      modified: item.modified.toISOString(),
      messageCount: item.messageCount,
      firstMessage: item.detailsPending && !item.firstMessage ? "" : item.firstMessage || "(no messages)",
      parentSessionId,
      ...(item.contextSourceSessionId ? { contextSourceSessionId: item.contextSourceSessionId } : {}),
      ...(subagent
        ? { relation: { kind: "subagent" as const, parentSessionId: subagent.parentSessionId, profile: subagent.profile, description: subagent.description, status: subagent.status } }
        : item.parentSessionPath
          ? { relation: { kind: "fork" as const, ...(parentSessionId ? { originSessionId: parentSessionId } : {}) } }
          : {}),
      transient: false,
      ...(archived ? { archived: true as const } : {}),
      ...(item.detailsPending ? { detailsPending: true } : {}),
    };
  });
  return attachSessionProjectInfo(sessions, projectSessionIds);
}

async function loadAllSessions(projectSessionIds?: ReadonlySet<string>): Promise<SessionInfo[]> {
  // When tests monkey-patch SessionManager.listAll, respect the test harness.
  if (SessionManager.listAll !== (globalThis as Record<string, unknown>).__piOriginalSessionManagerListAll && typeof SessionManager.listAll === "function") {
    return loadAllSessionsFromSdk(projectSessionIds);
  }
  try {
    return filterCurrentPersistedSessions(await buildScannedSessionList(await listSessionsIncremental(), false, projectSessionIds), false);
  } catch (error) {
    return loadAllSessionsFromSdk(projectSessionIds);
  }
}

export async function listSessionSummaries(): Promise<SessionInfo[]> {
  return filterCurrentPersistedSessions(await buildScannedSessionList(await listSessionsIncremental({ deferDetails: true })), false);
}

interface ArchivedDirCacheEntry {
  mtimeMs: number;
  sessions: PiSessionInfo[];
}

const ARCHIVED_DIR_CACHE_MAX_ENTRIES = 64;
const ARCHIVED_DIR_CACHE_MAX_SESSIONS = 2_000;

function getArchivedDirCache(): Map<string, ArchivedDirCacheEntry> {
  if (!globalThis.__piArchivedDirCache) globalThis.__piArchivedDirCache = new Map();
  return globalThis.__piArchivedDirCache;
}

async function loadArchivedSessions(projectSessionIds?: ReadonlySet<string>): Promise<SessionInfo[]> {
  const { archivedSessionsDir } = getPiSessionRoots();
  if (!existsSync(archivedSessionsDir)) return [];

  // Keep the SDK path for isolated tests that monkey-patch listAll, and as a
  // compatibility fallback if the incremental archive scan encounters a
  // malformed/racing tree. The normal path shares the canonical scanner with
  // active sessions instead of importing the retired summary-index design.
  if (SessionManager.listAll !== (globalThis as Record<string, unknown>).__piOriginalSessionManagerListAll) {
    return loadArchivedSessionsFromSdk(projectSessionIds);
  }
  try {
    const sessions = await buildScannedSessionList(
      await listSessionsIncremental({ sessionsDir: archivedSessionsDir }),
      true,
      projectSessionIds,
    );
    return filterCurrentPersistedSessions(sessions, true);
  } catch {
    return loadArchivedSessionsFromSdk(projectSessionIds);
  }
}

async function loadArchivedSessionsFromSdk(projectSessionIds?: ReadonlySet<string>): Promise<SessionInfo[]> {
  const generation = globalThis.__piSessionListGeneration ?? 0;
  const { archivedSessionsDir } = getPiSessionRoots();
  if (!existsSync(archivedSessionsDir)) return [];

  let projectDirs: string[] = [];
  try {
    projectDirs = readdirSync(archivedSessionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(archivedSessionsDir, e.name));
  } catch {
    return [];
  }

  const dirCache = getArchivedDirCache();
  const dirResults = await Promise.all(projectDirs.map(async (dir) => {
    try {
      const dirMtimeMs = statSync(dir).mtimeMs;
      const cached = dirCache.get(dir);
      if (
        cached
        && cached.mtimeMs === dirMtimeMs
        && cached.sessions.length <= ARCHIVED_DIR_CACHE_MAX_SESSIONS
      ) {
        dirCache.delete(dir);
        dirCache.set(dir, cached);
        return cached.sessions;
      }
      const listed = await SessionManager.listAll(dir);
      if (
        listed.length <= ARCHIVED_DIR_CACHE_MAX_SESSIONS
        && (globalThis.__piSessionListGeneration ?? 0) === generation
      ) {
        dirCache.delete(dir);
        dirCache.set(dir, { mtimeMs: dirMtimeMs, sessions: listed });
        while (dirCache.size > ARCHIVED_DIR_CACHE_MAX_ENTRIES) {
          const oldest = dirCache.keys().next().value;
          if (oldest === undefined) break;
          dirCache.delete(oldest);
        }
      } else {
        dirCache.delete(dir);
      }
      return listed;
    } catch {
      return [];
    }
  }));
  const piSessions: PiSessionInfo[] = dirResults.flat();

  const pathToId = new Map<string, string>();
  for (const s of piSessions) pathToId.set(sessionPathKey(s.path), s.id);

  const sessions = piSessions
    .map((s) => {
    // Mirror loadAllSessions: populate the id→path cache so resolveSessionPath
    // can find archived sessions (view/rename/delete/unarchive all rely on it).
    cacheSessionPath(s.id, s.path);
    const displayInfo = sessionListDisplayInfo(s.path, s.firstMessage || "(no messages)");
    return {
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      created: safeIsoDate(s.created),
      modified: safeIsoDate(s.modified),
      messageCount: s.messageCount,
      firstMessage: displayInfo.message,
      parentSessionId: s.parentSessionPath ? pathToId.get(sessionPathKey(s.parentSessionPath)) : undefined,
      ...(displayInfo.contextSourceSessionId ? { contextSourceSessionId: displayInfo.contextSourceSessionId } : {}),
      transient: false,
      archived: true as const,
    };
  });
  return filterCurrentPersistedSessions(await attachSessionProjectInfo(sessions, projectSessionIds), true);
}

export async function listAllSessions(options: { force?: boolean; readOnly?: boolean; projectSessionIds?: ReadonlySet<string> } = {}): Promise<SessionInfo[]> {
  if (options.readOnly) {
    return filterCurrentPersistedSessions(await buildScannedSessionList(await listSessionsIncremental({ readOnly: true }), false, options.projectSessionIds), false);
  }
  pruneOrphanedSubprojectAssignments();
  if (options.force) invalidateSessionListCache();
  const generation = globalThis.__piSessionListGeneration ?? 0;

  // Return cached result if still fresh (avoids re-scanning session files
  // and re-spawning git processes on every page load).
  if (globalThis.__piSessionListCache && Date.now() - globalThis.__piSessionListCache.ts < SESSION_LIST_CACHE_TTL_MS) {
    return filterCurrentPersistedSessions(globalThis.__piSessionListCache.data, false);
  }

  if (options.projectSessionIds) {
    const data = await loadAllSessions(options.projectSessionIds);
    return (globalThis.__piSessionListGeneration ?? 0) === generation
      ? data : listAllSessions({ projectSessionIds: options.projectSessionIds });
  }

  // Coalescing dedup: concurrent callers share the same in-flight promise
  // only while it belongs to the current cache generation.
  if (globalThis.__piSessionListPromise && globalThis.__piSessionListPromiseGeneration === generation) {
    return globalThis.__piSessionListPromise;
  }

  const loadPromise = loadAllSessions().then((data) => {
    // If a mutation invalidated this scan, make this caller join (or start) a
    // scan for the current generation. Returning the stale result here made a
    // refresh race indistinguishable from a successful refresh.
    if ((globalThis.__piSessionListGeneration ?? 0) !== generation) {
      return listAllSessions();
    }
    globalThis.__piSessionListCache = { data, ts: Date.now() };
    return data;
  });
  const trackedPromise = loadPromise.finally(() => {
    if (globalThis.__piSessionListPromise === trackedPromise) {
      globalThis.__piSessionListPromise = undefined;
      globalThis.__piSessionListPromiseGeneration = undefined;
    }
  });

  globalThis.__piSessionListPromise = trackedPromise;
  globalThis.__piSessionListPromiseGeneration = generation;
  return trackedPromise;
}

export async function listArchivedSessions(options: { force?: boolean; readOnly?: boolean; projectSessionIds?: ReadonlySet<string> } = {}): Promise<SessionInfo[]> {
  if (options.readOnly) {
    const { archivedSessionsDir } = getPiSessionRoots();
    return filterCurrentPersistedSessions(await buildScannedSessionList(await listSessionsIncremental({
      sessionsDir: archivedSessionsDir, readOnly: true,
    }), true, options.projectSessionIds), true);
  }
  pruneOrphanedSubprojectAssignments();
  if (options.force) invalidateSessionListCache();
  const generation = globalThis.__piSessionListGeneration ?? 0;

  if (globalThis.__piArchivedListCache && Date.now() - globalThis.__piArchivedListCache.ts < SESSION_LIST_CACHE_TTL_MS) {
    return filterCurrentPersistedSessions(globalThis.__piArchivedListCache.data, true).filter((session) => session.archived === true);
  }

  if (options.projectSessionIds) {
    const data = await loadArchivedSessions(options.projectSessionIds);
    return (globalThis.__piSessionListGeneration ?? 0) === generation
      ? data : listArchivedSessions({ projectSessionIds: options.projectSessionIds });
  }

  if (globalThis.__piArchivedListPromise && globalThis.__piArchivedListPromiseGeneration === generation) {
    return globalThis.__piArchivedListPromise;
  }

  const loadPromise = loadArchivedSessions().then((data) => {
    // An archive/unarchive can move a file while this scan is in flight. Do
    // not return that old snapshot to the caller; retry against new generation.
    if ((globalThis.__piSessionListGeneration ?? 0) !== generation) {
      return listArchivedSessions({ force: true });
    }
    globalThis.__piArchivedListCache = { data, ts: Date.now() };
    return data;
  });
  const trackedPromise = loadPromise.finally(() => {
    if (globalThis.__piArchivedListPromise === trackedPromise) {
      globalThis.__piArchivedListPromise = undefined;
      globalThis.__piArchivedListPromiseGeneration = undefined;
    }
  });

  globalThis.__piArchivedListPromise = trackedPromise;
  globalThis.__piArchivedListPromiseGeneration = generation;
  return trackedPromise;
}

// ============================================================================
// Session path caches, stored in globalThis for hot-reload safety.
// ============================================================================
declare global {
  var __piSessionPathStateCache: Map<string, Partial<Record<"active" | "archived", string>>> | undefined;
  var __piSessionPathCache: Map<string, string> | undefined;
  var __piPathToSessionIdCache: Map<string, string> | undefined;
  var __piSessionListPromise: Promise<SessionInfo[]> | undefined;
  var __piSessionListPromiseGeneration: number | undefined;
  var __piSessionListGeneration: number | undefined;
  var __piSessionListCache: { data: SessionInfo[]; ts: number } | undefined;
  var __piArchivedListCache: { data: SessionInfo[]; ts: number } | undefined;
  var __piArchivedListPromise: Promise<SessionInfo[]> | undefined;
  var __piArchivedListPromiseGeneration: number | undefined;
  var __piArchivedDirCache: Map<string, ArchivedDirCacheEntry> | undefined;
  var __piFirstMessageCache: Map<string, FirstMessageDisplayCacheEntry> | undefined;
}

const SESSION_LIST_CACHE_TTL_MS = 30_000;
const SESSION_PATH_CACHE_MAX_ENTRIES = 2_000;
const PATH_STATE_CACHE_MAX_ENTRIES = 2_000;
const PATH_TO_ID_CACHE_MAX_ENTRIES = 4_000;

function trimMap<K, V>(map: Map<K, V>, maxEntries: number): void {
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

export function invalidateSessionListCache(): void {
  // List freshness is not file-content freshness: another runtime's events or
  // a classification refresh must not evict unchanged parsed sessions. Reads
  // validate size/mtime/ctime/inode; path lifecycle changes invalidate below.
  globalThis.__piSessionListGeneration = (globalThis.__piSessionListGeneration ?? 0) + 1;
  globalThis.__piSessionListCache = undefined;
  globalThis.__piArchivedListCache = undefined;
  globalThis.__piArchivedDirCache?.clear();
  globalThis.__piFirstMessageCache?.clear();
}

export function getSessionListVersion(): number {
  return globalThis.__piSessionListGeneration ?? 0;
}

/**
 * Granularly update in-memory active and archived session list caches on move,
 * eliminating the expensive full disk scan (1.2 GB JSONL parse) on archive/unarchive.
 */
export function updateSessionListCachesForMove(
  sessionId: string,
  oldPath: string,
  newPath: string,
  archived: boolean,
): void {
  invalidateSessionReadCache(oldPath);
  invalidateSessionReadCache(newPath);
  invalidateSessionPathCache(sessionId);
  cacheSessionPath(sessionId, newPath);

  globalThis.__piArchivedDirCache?.clear();

  const sessionCache = globalThis.__piSessionListCache;
  const archivedCache = globalThis.__piArchivedListCache;

  if (archived) {
    let movedSession: SessionInfo | undefined;
    if (sessionCache) {
      const idx = sessionCache.data.findIndex((s) => s.id === sessionId || s.path === oldPath);
      if (idx !== -1) {
        const [old] = sessionCache.data.splice(idx, 1);
        movedSession = { ...old, path: newPath, archived: true };
      }
    }
    if (archivedCache && movedSession) {
      const existingIdx = archivedCache.data.findIndex((s) => s.id === sessionId);
      if (existingIdx !== -1) archivedCache.data[existingIdx] = movedSession;
      else archivedCache.data.unshift(movedSession);
      archivedCache.data.sort((a, b) => b.modified.localeCompare(a.modified));
    } else if (archivedCache && !movedSession) {
      globalThis.__piArchivedListCache = undefined;
    }
  } else {
    let movedSession: SessionInfo | undefined;
    if (archivedCache) {
      const idx = archivedCache.data.findIndex((s) => s.id === sessionId || s.path === oldPath);
      if (idx !== -1) {
        const [old] = archivedCache.data.splice(idx, 1);
        movedSession = { ...old, path: newPath, archived: undefined };
      }
    }
    if (sessionCache && movedSession) {
      const existingIdx = sessionCache.data.findIndex((s) => s.id === sessionId);
      if (existingIdx !== -1) sessionCache.data[existingIdx] = movedSession;
      else sessionCache.data.unshift(movedSession);
      sessionCache.data.sort((a, b) => b.modified.localeCompare(a.modified));
    } else if (sessionCache && !movedSession) {
      globalThis.__piSessionListCache = undefined;
    }
  }

  globalThis.__piSessionListGeneration = (globalThis.__piSessionListGeneration ?? 0) + 1;
  globalThis.__piSessionListPromise = undefined;
  globalThis.__piArchivedListPromise = undefined;
}

function getPathCache(): Map<string, string> {
  if (!globalThis.__piSessionPathCache) globalThis.__piSessionPathCache = new Map();
  trimMap(globalThis.__piSessionPathCache, SESSION_PATH_CACHE_MAX_ENTRIES);
  return globalThis.__piSessionPathCache;
}

function getPathToIdCache(): Map<string, string> {
  if (!globalThis.__piPathToSessionIdCache) globalThis.__piPathToSessionIdCache = new Map();
  trimMap(globalThis.__piPathToSessionIdCache, PATH_TO_ID_CACHE_MAX_ENTRIES);
  return globalThis.__piPathToSessionIdCache;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
type SessionPathScope = "active" | "archived";

export interface ResolveSessionPathOptions {
  /** Resolve only from this storage root; required by stateful mutations. */
  archived?: boolean;
}

export class SessionPathConflictError extends Error {
  readonly code = "session_path_conflict";

  constructor(sessionId: string) {
    super(`Session ${sessionId} exists in both active and archived storage`);
    this.name = "SessionPathConflictError";
  }
}

function defaultSessionsDir(): string {
  return join(getAgentDir(), "sessions");
}

function resolvePathWithinDefaultSessions(
  filePath: string,
  sessionsDir = resolvePath(defaultSessionsDir()),
): string | null {
  const candidatePath = resolvePath(filePath);
  const relativePath = relative(sessionsDir, candidatePath);
  return relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
    ? candidatePath
    : null;
}

function sessionPathScope(filePath: string): SessionPathScope | undefined {
  const { sessionsDir, archivedSessionsDir } = getPiSessionRoots();
  if (resolvePathWithinDefaultSessions(filePath, resolvePath(archivedSessionsDir))) return "archived";
  if (resolvePathWithinDefaultSessions(filePath, resolvePath(sessionsDir))) return "active";
  return undefined;
}

function getPathStateCache(): Map<string, Partial<Record<SessionPathScope, string>>> {
  if (!globalThis.__piSessionPathStateCache) globalThis.__piSessionPathStateCache = new Map();
  trimMap(globalThis.__piSessionPathStateCache, PATH_STATE_CACHE_MAX_ENTRIES);
  return globalThis.__piSessionPathStateCache;
}

function currentCachedPath(path: string | undefined, expectedScope?: SessionPathScope): string | undefined {
  if (!path) return undefined;
  const scope = sessionPathScope(path);
  if (expectedScope && scope !== expectedScope) return undefined;
  // A late list scan must not resurrect a path after archive/delete moved it.
  return scope && !existsSync(path) ? undefined : path;
}

function getCachedSessionPath(sessionId: string, archived?: boolean): string | undefined {
  const scoped = getPathStateCache().get(sessionId);
  const activePath = currentCachedPath(scoped?.active, "active");
  const archivedPath = currentCachedPath(scoped?.archived, "archived");
  if (archived === undefined && activePath && archivedPath) {
    throw new SessionPathConflictError(sessionId);
  }
  const scope: SessionPathScope | undefined = archived === undefined ? undefined : archived ? "archived" : "active";
  if (scope === "active" && activePath) return activePath;
  if (scope === "archived" && archivedPath) return archivedPath;
  if (archived === undefined && activePath) return activePath;
  if (archived === undefined && archivedPath) return archivedPath;

  return currentCachedPath(getPathCache().get(sessionId), scope);
}

async function findSessionPathById(sessionId: string, archived: boolean): Promise<string | null> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;

  let projectDirs: import("fs").Dirent[];
  const { sessionsDir: activeSessionsDir, archivedSessionsDir } = getPiSessionRoots();
  const sessionsDir = resolvePath(archived ? archivedSessionsDir : activeSessionsDir);
  try {
    projectDirs = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const suffix = `_${sessionId}.jsonl`;
  const projects: Array<{ path: string; files: string[] }> = [];
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory() && !projectDir.isSymbolicLink()) continue;
    const projectPath = resolvePathWithinDefaultSessions(join(sessionsDir, projectDir.name), sessionsDir);
    if (!projectPath) continue;
    try {
      projects.push({ path: projectPath, files: await readdir(projectPath) });
    } catch {
      // A project directory can disappear while the session list is changing.
    }
  }

  const inspect = (onlyFilenameMatch: boolean): string | undefined => {
    let match: string | undefined;
    for (const project of projects) {
      const files = onlyFilenameMatch
        ? project.files.filter(file => file.endsWith(suffix))
        : project.files.filter(file => file.endsWith(".jsonl"));
      for (const file of files) {
        const candidate = resolvePathWithinDefaultSessions(join(project.path, file), sessionsDir);
        if (!candidate) continue;
        try {
          if (readSessionHeader(candidate)?.id !== sessionId) continue;
        } catch {
          continue;
        }
        // Duplicate IDs are unsafe for mutations; do not guess a path.
        if (match && match !== candidate) throw new SessionPathConflictError(sessionId);
        match = candidate;
      }
    }
    return match;
  };

  // SessionManager may allocate a filename ID before the SDK writes the
  // header ID. Keep the normal fast path, then fall back to header identity
  // when the filename and header IDs differ for a newly created session.
  return inspect(true) ?? inspect(false) ?? null;
}

function findSessionIdByPath(filePath: string): string | undefined {
  if (!filePath.endsWith(".jsonl")) return undefined;
  const scope = sessionPathScope(filePath);
  if (!scope) return undefined;
  const { sessionsDir, archivedSessionsDir } = getPiSessionRoots();
  const candidate = resolvePathWithinDefaultSessions(
    filePath,
    scope === "archived" ? resolvePath(archivedSessionsDir) : resolvePath(sessionsDir),
  );
  if (!candidate) return undefined;
  try {
    const sessionId = readSessionHeader(candidate)?.id;
    if (!sessionId) return undefined;
    cacheSessionPath(sessionId, candidate);
    return sessionId;
  } catch {
    return undefined;
  }
}

export async function resolveSessionPath(
  sessionId: string,
  options: ResolveSessionPathOptions = {},
): Promise<string | null> {
  const requestedArchived = options.archived;
  const cached = getCachedSessionPath(sessionId, requestedArchived);
  if (cached) return cached;

  if (requestedArchived !== undefined) {
    const targetedPath = await findSessionPathById(sessionId, requestedArchived);
    if (targetedPath) {
      cacheSessionPath(sessionId, targetedPath);
      return getCachedSessionPath(sessionId, requestedArchived) ?? null;
    }

    // Cache miss or non-standard layout: scan only requested storage root.
    if (requestedArchived) await listArchivedSessions();
    else await listAllSessions();
    return getCachedSessionPath(sessionId, requestedArchived) ?? null;
  }

  // No state supplied: resolve both roots on a cache miss, then refuse to
  // guess if the same id exists in both. Stateful mutations pass `archived`.
  const active = await findSessionPathById(sessionId, false);
  const archived = await findSessionPathById(sessionId, true);
  if (active && archived) throw new SessionPathConflictError(sessionId);
  if (active) {
    cacheSessionPath(sessionId, active);
    return active;
  }
  if (archived) {
    cacheSessionPath(sessionId, archived);
    return archived;
  }

  await listAllSessions();
  const listedActive = getCachedSessionPath(sessionId, false);
  await listArchivedSessions();
  const listedArchived = getCachedSessionPath(sessionId, true);
  if (listedActive && listedArchived) throw new SessionPathConflictError(sessionId);
  return listedActive ?? listedArchived ?? null;
}

/**
 * Resolve a persisted session for strict read-only integrations.
 *
 * Unlike resolveSessionPath(), this helper never refreshes the session list or
 * mutates path/list caches. It is intended for MCP safe-history reads where a
 * missing runtime must remain a pure filesystem observation.
 */
export async function resolveSessionPathReadOnly(sessionId: string): Promise<string | null> {
  const active = await findSessionPathById(sessionId, false);
  const archived = await findSessionPathById(sessionId, true);
  if (active && archived) throw new SessionPathConflictError(sessionId);
  return active ?? archived;
}

export async function resolveSessionIdByPath(filePath: string): Promise<string | undefined> {
  const pathKey = sessionPathKey(filePath);
  const cached = getPathToIdCache().get(pathKey);
  if (cached) {
    const scope = sessionPathScope(filePath);
    if (!scope || existsSync(filePath)) return cached;
    getPathToIdCache().delete(pathKey);
  }

  const targetedId = findSessionIdByPath(filePath);
  if (targetedId) return targetedId;

  await listAllSessions();
  return getPathToIdCache().get(pathKey);
}

export function cacheSessionPath(sessionId: string, filePath: string): void {
  const normalizedPath = normalizePath(filePath);
  const pathKey = sessionPathKey(normalizedPath);
  const pathCache = getPathCache();
  const stateCache = getPathStateCache();
  const reverseCache = getPathToIdCache();
  const previousState = stateCache.get(sessionId);
  const scope = sessionPathScope(normalizedPath);
  if (scope && !existsSync(normalizedPath)) return;
  const nextState = previousState ? { ...previousState } : {};
  if (scope) nextState[scope] = normalizedPath;
  if (Object.keys(nextState).length > 0) {
    stateCache.set(sessionId, nextState);
    trimMap(stateCache, PATH_STATE_CACHE_MAX_ENTRIES);
  }

  const previousPaths = new Set<string>([
    pathCache.get(sessionId),
    previousState?.active,
    previousState?.archived,
  ].filter((path): path is string => Boolean(path)));
  for (const previousPath of previousPaths) {
    const previousPathKey = sessionPathKey(previousPath);
    const previousScope = sessionPathScope(previousPath);
    const stillIndexed = previousScope ? nextState[previousScope] === previousPath : false;
    if (previousPathKey !== pathKey && !stillIndexed && reverseCache.get(previousPathKey) === sessionId) {
      reverseCache.delete(previousPathKey);
    }
  }

  const previousSessionId = reverseCache.get(pathKey);
  if (previousSessionId && previousSessionId !== sessionId) {
    const previousOwnerPath = pathCache.get(previousSessionId);
    if (previousOwnerPath && sessionPathKey(previousOwnerPath) === pathKey) {
      pathCache.delete(previousSessionId);
    }
  }
  pathCache.set(sessionId, normalizedPath);
  trimMap(pathCache, SESSION_PATH_CACHE_MAX_ENTRIES);
  reverseCache.set(pathKey, sessionId);
  for (const indexedPath of Object.values(nextState)) {
    reverseCache.set(sessionPathKey(indexedPath), sessionId);
  }
  trimMap(reverseCache, PATH_TO_ID_CACHE_MAX_ENTRIES);
}

export function invalidateSessionPathCache(sessionId: string): void {
  const pathCache = getPathCache();
  const stateCache = getPathStateCache();
  const reverseCache = getPathToIdCache();
  const state = stateCache.get(sessionId);
  const paths = new Set<string>([
    pathCache.get(sessionId),
    state?.active,
    state?.archived,
  ].filter((path): path is string => Boolean(path)));
  pathCache.delete(sessionId);
  stateCache.delete(sessionId);
  for (const path of paths) {
    invalidateSessionReadCache(path);
    const pathKey = sessionPathKey(path);
    if (reverseCache.get(pathKey) === sessionId) reverseCache.delete(pathKey);
  }
}

export function readSessionHeader(filePath: string): SessionHeader | null {
  const fd = openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    const maxHeaderBytes = 64 * 1024;
    let position = 0;
    let foundNewline = false;

    while (position < maxHeaderBytes && !foundNewline) {
      const buffer = Buffer.allocUnsafe(Math.min(4096, maxHeaderBytes - position));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const data = buffer.subarray(0, bytesRead);
      const newlineIndex = data.indexOf(0x0a);
      chunks.push(newlineIndex === -1 ? data : data.subarray(0, newlineIndex));
      position += bytesRead;
      foundNewline = newlineIndex !== -1;
    }

    if (!foundNewline && position >= maxHeaderBytes) return null;
    const firstLine = Buffer.concat(chunks).toString("utf8").trimEnd();
    if (!firstLine) return null;
    try {
      const header = JSON.parse(firstLine) as SessionHeader;
      return header.type === "session" ? header : null;
    } catch {
      return null;
    }
  } finally {
    closeSync(fd);
  }
}

interface SmCacheEntry { sm: SessionManager; fingerprint: string; bytes: number }

declare global { var __piSmCache: Map<string, SmCacheEntry> | undefined }

export const SM_CACHE_LIMITS = { maxEntries: 12, maxTotalBytes: 256 * 1024 * 1024, maxFileBytes: 64 * 1024 * 1024 };

function getSmCache(): Map<string, SmCacheEntry> {
  if (!globalThis.__piSmCache) globalThis.__piSmCache = new Map();
  return globalThis.__piSmCache;
}

function evictSmCache(cache: Map<string, SmCacheEntry>): void {
  let total = 0;
  for (const entry of cache.values()) total += entry.bytes;
  while (cache.size > SM_CACHE_LIMITS.maxEntries || total > SM_CACHE_LIMITS.maxTotalBytes) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    total -= cache.get(oldest)?.bytes ?? 0;
    cache.delete(oldest);
  }
}

export function invalidateSessionManagerCache(filePath?: string): void {
  const cache = getSmCache();
  if (filePath === undefined) cache.clear();
  else cache.delete(sessionPathKey(filePath));
}

export function openSessionManager(filePath: string, options: { mutable?: boolean } = {}): SessionManager {
  if (options.mutable) return SessionManager.open(filePath, undefined);
  const cache = getSmCache();
  const key = sessionPathKey(filePath);
  let stats: ReturnType<typeof statSync>;
  try { stats = statSync(filePath); } catch { cache.delete(key); return SessionManager.open(filePath, undefined); }
  const fingerprint = `${stats.size}:${stats.mtimeMs}`;
  const cached = cache.get(key);
  if (cached?.fingerprint === fingerprint) {
    cache.delete(key); cache.set(key, cached); return cached.sm;
  }
  const sm = SessionManager.open(filePath, undefined);
  if (stats.size > SM_CACHE_LIMITS.maxFileBytes) { cache.delete(key); return sm; }
  cache.set(key, { sm, fingerprint, bytes: stats.size });
  evictSmCache(cache);
  return sm;
}

export function getSessionEntries(filePath: string): SessionEntry[] {
  return [...getSessionReadSnapshot(filePath).entries];
}

export interface BuildSessionContextOptions {
  deferThinking?: boolean;
  deferToolResultImages?: boolean;
  /** Replace large historical tool-result text with an on-demand preview. */
  deferToolResultText?: boolean;
  /** Return only the most recent active-branch entries when supplied. */
  tail?: number;
  /** When paginating backward, exclude the cursor entry from the next page. */
  excludeLeaf?: boolean;
  /** Session id used to build lazy URLs for historical tool-result images. */
  sessionId?: string;
}

export function parseSessionTail(rawTail: string | null, hasBefore: boolean): number | undefined {
  if (rawTail === null && !hasBefore) return undefined;
  const parsed = Number.parseInt(rawTail ?? "50", 10);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(1000, Math.max(1, parsed));
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: BuildSessionContextOptions = {},
): SessionContext {
  const { tail, excludeLeaf } = options;
  const sliced = tail && tail > 0
    ? sliceActiveBranch(entries, leafId ?? null, tail, excludeLeaf)
    : entries;
  const branch = getSessionBranchEntries(entries, leafId);
  const displaySelection = selectInitialDisplaySlice(entries, leafId, sliced, tail, excludeLeaf);
  const displaySlice = displaySelection.entries;
  // "Earlier history" means history older than the returned page, measured from
  // the page's own first entry — the page can begin with a compaction card, and
  // an empty page (paginating past the root) has nothing older by definition.
  // A raw tail that only truncates tool traffic inside the current turn is not
  // earlier conversation and must not create a history button for one Q&A.
  const pageHead = displaySlice[0];
  const pageHeadIndex = pageHead ? branch.findIndex((entry) => entry.id === pageHead.id) : -1;
  const hasMore = Boolean(
    tail
      && tail > 0
      && pageHeadIndex > 0
      && branch.slice(0, pageHeadIndex).some((entry) => isUiHistoryEntry(entry)),
  );
  const fullById = new Map<string, SessionEntry>();
  const slicedById = new Map<string, SessionEntry>();
  for (const e of entries) fullById.set(e.id, e);
  for (const e of displaySlice) slicedById.set(e.id, e);

  const piCtx = piBuildSessionContext(
    // SAFETY: SDK selection uses the shared JSONL entry fields; UI message normalization happens below.
    entries as unknown as PiSessionEntry[],
    leafId,
    // SAFETY: this index contains those same SDK-compatible entry objects, keyed by their unchanged ids.
    fullById as unknown as Map<string, PiSessionEntry>,
  );

  // For the bounded display path, keep the complete UI page rather than asking
  // the SDK to rebuild a model context and then filtering it. The SDK is
  // allowed to remove entries before a compaction's firstKeptEntryId; that is
  // correct for the next model request but wrong for the reader's transcript.
  // Order the active branch using the display-only compaction rules, then keep
  // only this page's entries. The page cursor still follows the raw slice.
  const resolvedLeafId = leafId === undefined ? entries.at(-1)?.id ?? null : leafId;
  const contextLeafId = excludeLeaf
    ? (resolvedLeafId ? fullById.get(resolvedLeafId)?.parentId ?? null : null)
    : resolvedLeafId;
  const boundedDisplayEntries = tail && tail > 0
    ? getSessionDisplayEntries(entries, leafId).filter((entry) => slicedById.has(entry.id))
    : null;
  const contextEntries = sliced.length === 0
    ? []
    : boundedDisplayEntries
      ? boundedDisplayEntries
      : piBuildContextEntries(
          // SAFETY: SDK display selection reads the same persisted id/parent/type fields, not a different message representation.
          entries as unknown as PiSessionEntry[],
          contextLeafId,
          // SAFETY: map values are exactly the entries supplied to SDK selection above.
          fullById as unknown as Map<string, PiSessionEntry>,
        ).filter((entry) => slicedById.has(entry.id));

  // Convert the SDK-selected context entries and their IDs together. This keeps
  // fork/navigation targets aligned while preserving pi's compaction ordering.
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  for (const entry of contextEntries) {
    // SAFETY: SDK-selected entries retain the original JSONL wire shape; entryToUiMessage normalizes their messages.
    const localEntry = entry as unknown as SessionEntry;
    const m = entryToUiMessage(localEntry, options);
    if (m) {
      messages.push(m);
      entryIds.push(localEntry.id);
    }
  }

  return {
    messages,
    entryIds,
    thinkingLevel: piCtx.thinkingLevel,
    model: piCtx.model,
    oldestEntryId: sliced[0]?.id ?? null,
    hasMore,
  };
}

function isTurnAnchorEntry(entry: SessionEntry, byId?: Map<string, SessionEntry>): boolean {
  if (entry.type === "compaction") {
    // A compaction directly following a user message or root is its own turn anchor.
    // However, a mid-turn compaction occurring after tool results/assistant process
    // belongs to the ongoing turn and must anchor back to the initiating user prompt.
    if (byId && entry.parentId) {
      const parent = byId.get(entry.parentId);
      if (parent && parent.type === "message" && parent.message.role !== "user") {
        return false;
      }
    }
    return true;
  }
  if (entry.type === "branch_summary") return Boolean(entry.summary);
  return entry.type === "message" && entry.message.role === "user";
}

/**
 * Extract the active parent chain iteratively, avoiding recursion on long linear sessions.
 */
export function sliceActiveBranch(
  entries: SessionEntry[],
  leafId: string | null,
  tail: number,
  excludeLeaf = false,
): SessionEntry[] {
  if (tail <= 0) return entries;
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) byId.set(entry.id, entry);

  let leaf = leafId ? byId.get(leafId) : entries[entries.length - 1];
  if (excludeLeaf) leaf = leaf?.parentId ? byId.get(leaf.parentId) : undefined;
  if (!leaf) return [];

  const chain: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current && chain.length < tail) {
    chain.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  chain.reverse();

  // Keep the newest logical turn intact. A raw entry tail can start at an
  // assistant/tool result and otherwise prevents ChatWindow from grouping its
  // process messages under the preceding user prompt.
  if (chain.length > 0 && !isTurnAnchorEntry(chain[0], byId)) {
    let parentId = chain[0].parentId;
    while (parentId) {
      const parent = byId.get(parentId);
      if (!parent) break;
      chain.unshift(parent);
      if (isTurnAnchorEntry(parent, byId)) break;
      parentId = parent.parentId;
    }
  }

  return chain;
}

/**
 * Select the initial display range without changing backward pagination. With
 * two or more compactions, start at the second newest one; with one, show the
 * complete active branch so its pre-compaction history remains reachable.
 */
/**
 * Keep the newest compaction card beside the bounded page.
 *
 * The page itself stays a plain tail of `tail` entries; only the compaction
 * card that summarizes the hidden prefix is added in front of it, so the reader
 * still sees "what came before this page" without the whole transcript. Earlier
 * history loads page by page, and the minimap control loads the entire branch
 * on request.
 */
function selectInitialDisplaySlice(
  entries: SessionEntry[],
  leafId: string | null | undefined,
  sliced: SessionEntry[],
  tail: number | undefined,
  excludeLeaf: boolean | undefined,
): { entries: SessionEntry[]; carriesCard: boolean } {
  if (!tail || tail <= 0 || excludeLeaf || sliced.length === 0) {
    return { entries: sliced, carriesCard: false };
  }

  const orderedBranch = getSessionDisplayEntries(entries, leafId);
  let newestCompaction = -1;
  for (let index = orderedBranch.length - 1; index >= 0; index -= 1) {
    if (orderedBranch[index].type === "compaction") { newestCompaction = index; break; }
  }
  if (newestCompaction < 0) return { entries: sliced, carriesCard: false };

  const compaction = orderedBranch[newestCompaction];
  if (sliced.some((entry) => entry.id === compaction.id)) {
    return { entries: sliced, carriesCard: false };
  }
  // The card only annotates a hidden prefix when the bounded page lies strictly
  // after the compaction. If the page already starts at or before the compaction
  // (e.g. mid-turn compaction where sliceActiveBranch anchored to the turn's
  // initiating user prompt), prepending the compaction would invert causality
  // and display the summary above the very question it compacted.
  const sliceHeadIndex = orderedBranch.findIndex((entry) => entry.id === sliced[0].id);
  if (sliceHeadIndex < 0 || sliceHeadIndex <= newestCompaction) {
    return { entries: sliced, carriesCard: false };
  }
  // The page keeps its own tail; the card only annotates the hidden prefix. The
  // order comes from this assembled page, so the SDK page filter must not run
  // over it: that filter drops page entries whose kept boundary lies outside
  // the page, which would silently remove a user message from the transcript.
  return { entries: [compaction, ...sliced], carriesCard: true };
}

/**
 * Return the raw parent chain for a selected leaf, in transcript order.
 *
 * The SDK context intentionally removes entries before compaction. The reader
 * uses this separate chain only for an explicit display action, so expanding
 * history never changes what the agent will send to a model.
 */
export function getSessionBranchEntries(entries: SessionEntry[], leafId?: string | null): SessionEntry[] {
  if (leafId === null) return [];

  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) byId.set(entry.id, entry);

  let currentId: string | null | undefined = leafId ?? entries[entries.length - 1]?.id;
  const reversed: SessionEntry[] = [];
  const seen = new Set<string>();
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const entry = byId.get(currentId);
    if (!entry) break;
    reversed.push(entry);
    currentId = entry.parentId;
  }
  reversed.reverse();
  return reversed;
}

export interface SessionBranchSettings {
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}

/** Read branch settings without building or returning the transcript message projection. */
export function getSessionBranchSettings(entries: SessionEntry[], leafId?: string | null): SessionBranchSettings {
  let thinkingLevel = "auto";
  let model: SessionBranchSettings["model"] = null;
  for (const entry of getSessionBranchEntries(entries, leafId)) {
    if (entry.type === "thinking_level_change") thinkingLevel = entry.thinkingLevel;
    else if (entry.type === "model_change") model = { provider: entry.provider, modelId: entry.modelId };
  }
  return { thinkingLevel, model };
}

/**
 * Return durable terminology results attached to user entries on selected
 * branch. Custom job entries themselves stay out of SessionContext.messages.
 */
export function getQuestionAnalysisJobsForBranch(
  entries: SessionEntry[],
  leafId?: string | null,
): QuestionAnalysisJobView[] {
  const targetEntryIds = new Set(getSessionBranchEntries(entries, leafId).map((entry) => entry.id));
  return latestQuestionAnalysisJobs(entries, targetEntryIds).map(toQuestionAnalysisJobView);
}

/**
 * Return composer-attached terminology snapshots for user entries on the
 * selected branch (display-only; same storage rules as question jobs).
 */
export function getQuestionDraftViewsForBranch(
  entries: SessionEntry[],
  leafId?: string | null,
): Map<string, QuestionDraftView> {
  const targetEntryIds = new Set(getSessionBranchEntries(entries, leafId).map((entry) => entry.id));
  return draftViewByTarget(entries, targetEntryIds);
}

/**
 * Compaction entries are stored after pre-compaction work; display them before
 * the entry identified by firstKeptEntryId so full history matches SDK order.
 */
function orderFullDisplayEntries(entries: SessionEntry[]): SessionEntry[] {
  const entryIds = new Set(entries.map((entry) => entry.id));
  const compactionsBefore = new Map<string, SessionEntry[]>();
  const movedCompactionIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "compaction" || !entryIds.has(entry.firstKeptEntryId)) continue;
    const list = compactionsBefore.get(entry.firstKeptEntryId);
    if (list) list.push(entry);
    else compactionsBefore.set(entry.firstKeptEntryId, [entry]);
    movedCompactionIds.add(entry.id);
  }

  const ordered: SessionEntry[] = [];
  for (const entry of entries) {
    ordered.push(...(compactionsBefore.get(entry.id) ?? []));
    if (entry.type !== "compaction" || !movedCompactionIds.has(entry.id)) ordered.push(entry);
  }
  return ordered;
}

/** The reader's display timeline, independent of the SDK's compacted model context. */
export function getSessionDisplayEntries(entries: SessionEntry[], leafId?: string | null): SessionEntry[] {
  return orderFullDisplayEntries(getSessionBranchEntries(entries, leafId)).filter(isUiHistoryEntry);
}

/** Build a display-only context containing every UI message on the selected branch. */
export function buildFullSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: BuildSessionContextOptions = {},
): SessionContext {
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) byId.set(entry.id, entry);

  // SAFETY: these persisted records share the SDK entry wire fields and are normalized only for UI output.
  const piEntries = entries as unknown as PiSessionEntry[];
  // SAFETY: byId indexes those same records; it does not synthesize a second entry representation.
  const piCtx = piBuildSessionContext(piEntries, leafId, byId as unknown as Map<string, PiSessionEntry>);
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  for (const entry of getSessionDisplayEntries(entries, leafId)) {
    const message = entryToUiMessage(entry, options);
    if (!message) continue;
    messages.push(message);
    entryIds.push(entry.id);
  }

  return {
    messages,
    entryIds,
    thinkingLevel: piCtx.thinkingLevel,
    model: piCtx.model,
  };
}

/**
 * Build one progressive display-history page. `beforeEntryId` is the first
 * currently visible entry; reveal the previous compaction and everything after
 * it, or the whole branch when no earlier compaction remains.
 */
export function buildHistoryStepContext(
  entries: SessionEntry[],
  leafId: string | null | undefined,
  beforeEntryId: string,
  options: BuildSessionContextOptions = {},
): { context: SessionContext; history: SessionHistoryInfo } {
  const full = buildFullSessionContext(entries, leafId, options);
  const beforeIndex = full.entryIds.indexOf(beforeEntryId);
  if (beforeIndex < 0) throw new Error("historyBefore entry is not on the selected branch");

  let startIndex = 0;
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const message = full.messages[index];
    if (message?.role === "custom" && message.customType === "compaction") {
      startIndex = index;
      break;
    }
  }

  const hasCompaction = full.messages
    .some((message) => message.role === "custom" && message.customType === "compaction");

  return {
    context: {
      ...full,
      messages: full.messages.slice(startIndex),
      entryIds: full.entryIds.slice(startIndex),
    },
    history: {
      hasEarlierHistory: startIndex > 0,
      hasCompaction,
      totalMessages: full.messages.length,
    },
  };
}

function isUiHistoryEntry(entry: SessionEntry): boolean {
  return (entry.type === "message" && entry.message.role !== "system")
    || entry.type === "compaction"
    || (entry.type === "custom_message" && entry.display !== false)
    || (entry.type === "branch_summary" && Boolean(entry.summary));
}

export function buildSessionHistoryInfo(
  entries: SessionEntry[],
  leafId: string | null | undefined,
  context: SessionContext,
): SessionHistoryInfo {
  const visibleContextIds = new Set(context.entryIds);
  let hasEarlierHistory = false;
  let hasCompaction = false;
  let totalMessages = 0;
  for (const entry of getSessionBranchEntries(entries, leafId)) {
    if (!isUiHistoryEntry(entry)) continue;
    totalMessages += 1;
    if (entry.type === "compaction") hasCompaction = true;
    if (!visibleContextIds.has(entry.id)) hasEarlierHistory = true;
  }
  return {
    hasEarlierHistory,
    hasCompaction,
    totalMessages,
  };
}

function parseEntryTimestamp(timestamp: string): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64ImageInfo(block: unknown): { bytes: number; mime?: string } | null {
  if (!isRecord(block) || block.type !== "image") return null;

  let data: string | undefined;
  let mime: string | undefined;
  if (typeof block.data === "string") {
    data = block.data;
    mime = typeof block.mimeType === "string" ? block.mimeType : undefined;
  } else if (isRecord(block.source) && block.source.type === "base64" && typeof block.source.data === "string") {
    data = block.source.data;
    mime = typeof block.source.media_type === "string" ? block.source.media_type : undefined;
  }
  if (!data) return null;

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return { bytes: Math.max(0, Math.floor(data.length * 3 / 4) - padding), mime };
}

function deferToolResultBase64Images(message: AgentMessage, sessionId: string | undefined, entryId: string): AgentMessage {
  if (message.role !== "toolResult") return message;

  let omitted = 0;
  let bytes = 0;
  const mimes = new Set<string>();
  const content = message.content.flatMap((block, blockIndex) => {
    const image = base64ImageInfo(block);
    if (!image) return [block];

    if (
      sessionId
      && image.mime
      && TOOL_RESULT_IMAGE_MIMES.has(image.mime)
      && image.bytes > 0
      && image.bytes <= MAX_TOOL_RESULT_IMAGE_BYTES
    ) {
      const source: ImageContent["source"] = {
        type: "url",
        media_type: image.mime,
        url: `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/tool-result-image?blockIndex=${blockIndex}`,
      };
      return [{ type: "image", source } satisfies ImageContent];
    }

    omitted += 1;
    bytes += image.bytes;
    if (image.mime) mimes.add(image.mime);
    return [];
  });
  if (omitted === 0) return { ...message, content };

  const mimeText = mimes.size > 0 ? `: ${[...mimes].join(", ")}` : "";
  content.push({
    type: "text",
    text: `[${omitted} tool result image${omitted === 1 ? "" : "s"} omitted from initial history payload${mimeText}, ~${bytes} bytes]`,
  });
  return { ...message, content };
}

const MAX_INLINE_TOOL_RESULT_CHARS = 24_000;

function deferLargeToolResultText(message: AgentMessage, sessionId: string | undefined, entryId: string): AgentMessage {
  if (message.role !== "toolResult" || !sessionId) return message;

  const textChars = message.content.reduce((total, block) => (
    block.type === "text" ? total + block.text.length : total
  ), 0);
  if (textChars <= MAX_INLINE_TOOL_RESULT_CHARS) return message;

  let remaining = MAX_INLINE_TOOL_RESULT_CHARS;
  let keptChars = 0;
  const content: (TextContent | ImageContent)[] = [];
  for (const block of message.content) {
    if (block.type !== "text") {
      content.push(block);
      continue;
    }
    if (remaining <= 0) continue;
    const text = block.text.slice(0, remaining);
    remaining -= text.length;
    keptChars += text.length;
    if (text) content.push({ type: "text", text });
  }
  content.push({
    type: "text",
    text: `\n\n[Tool result truncated for initial load: ${textChars - keptChars} characters omitted]`,
  } satisfies TextContent);
  return { ...message, content, deferredText: true, entryId };
}

function deferLargeCustomMessageContent(
  content: string | (TextContent | ImageContent)[],
): string | (TextContent | ImageContent)[] {
  if (typeof content === "string") {
    if (content.length <= MAX_INLINE_TOOL_RESULT_CHARS) return content;
    const kept = content.slice(0, MAX_INLINE_TOOL_RESULT_CHARS);
    const omitted = content.length - MAX_INLINE_TOOL_RESULT_CHARS;
    return `${kept}\n\n[Custom message content truncated for initial load: ${omitted} characters omitted]`;
  }
  if (Array.isArray(content)) {
    let totalChars = 0;
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        totalChars += block.text.length;
      }
    }
    if (totalChars <= MAX_INLINE_TOOL_RESULT_CHARS) return content;
    let remaining = MAX_INLINE_TOOL_RESULT_CHARS;
    let keptChars = 0;
    const truncated: (TextContent | ImageContent)[] = [];
    for (const block of content) {
      if (block.type !== "text") {
        truncated.push(block);
        continue;
      }
      if (remaining <= 0) continue;
      const text = block.text.slice(0, remaining);
      remaining -= text.length;
      keptChars += text.length;
      if (text) truncated.push({ ...block, text });
    }
    truncated.push({
      type: "text",
      text: `\n\n[Custom message content truncated for initial load: ${totalChars - keptChars} characters omitted]`,
    });
    return truncated;
  }
  return content;
}

// Convert a session entry on the active branch into a UI message.
// Returns null for entries that do not map to chat history (metadata, non-message types).
export function entryToUiMessage(
  entry: SessionEntry,
  options: BuildSessionContextOptions,
): AgentMessage | null {
  // Supported message roles: user, assistant, toolResult, bashExecution.
  // bashExecution messages enter the case "message" branch (entry.type === "message").
  // The early return at line below ("!options.deferThinking || message.role !== "assistant"")
  // passes non-assistant messages — including bashExecution — through unchanged.
  // normalizeToolCalls is a secondary guard (returns non-assistant messages as-is).
  switch (entry.type) {
    case "message": {
      if (entry.message.role === "system") return null;
      let message = options.deferToolResultImages
        ? deferToolResultBase64Images(normalizeToolCalls(entry.message), options.sessionId, entry.id)
        : normalizeToolCalls(entry.message);
      const legacyContent = message.role === "assistant" ? (message as { content: unknown }).content : undefined;
      if (typeof legacyContent === "string") {
        message = { ...message, content: [{ type: "text", text: legacyContent }] } as AgentMessage;
      }
      if (options.deferToolResultText) {
        message = deferLargeToolResultText(message, options.sessionId, entry.id);
      }
      const entryTimestamp = parseEntryTimestamp(entry.timestamp);
      if (entryTimestamp !== undefined) {
        message = {
          ...message,
          entryTimestamp,
          ...(message.role === "user" ? { displayTimestamp: entryTimestamp } : {}),
        };
      }
      if (message.role !== "assistant") return message;
      if (!options.deferThinking) return message;
      return {
        ...message,
        content: message.content.map((block) => (
          block.type === "thinking"
            && typeof block.thinking === "string"
            && block.thinking.trim() !== ""
            ? { type: "thinking", thinking: "", deferred: true }
            : block
        )),
      };
    }
    case "compaction":
      return {
        role: "custom",
        customType: "compaction",
        content: entry.summary,
        display: true,
        details: {
          tokensBefore: entry.tokensBefore,
          firstKeptEntryId: entry.firstKeptEntryId,
        },
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "branch_summary":
      if (!entry.summary) return null;
      return {
        role: "user",
        content: `*The conversation briefly explored another branch and returned with this summary:*\n\n${entry.summary}`,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "custom_message":
      return {
        role: "custom",
        customType: entry.customType,
        content: options.deferToolResultText ? deferLargeCustomMessageContent(entry.content) : entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    default:
      return null;
  }
}
