import { createHash, type Hash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize } from "node:path";
import { createWorktreeBindingCollector, type WorktreeBindingRecord } from "./worktree-bindings";
import { createWorktreeCreationCollector, type WorktreeCreationRecord } from "./worktree-creation-history";
import type { SessionEntry, SessionInfo } from "./types";

const BATCH_BYTES = 4 * 1024 * 1024;
const READ_BYTES = 64 * 1024;
const SLICE_BYTES = 512 * 1024;
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const MAX_PROJECTS = 4;
const MAX_RESTARTS = 3;

class SessionChanged extends Error {}
class EntryTooLarge extends Error {}

type Session = Pick<SessionInfo, "id" | "path" | "cwd" | "created" | "name">;
type Phase = "read" | "verify" | "done" | "error";

interface FileScan {
  identity: string;
  target: Stats;
  offset: number;
  hash: Hash;
  phase: Phase;
  verifyOffset: number;
  verifyHash?: Hash;
  verifyStart?: Stats;
  parts: Buffer[];
  lineBytes: number;
  headerSeen: boolean;
  nameSeen: boolean;
  name?: string;
  unterminated: boolean;
  restarts: number;
  failure?: "entry_too_large" | "unavailable";
  creation: ReturnType<typeof createWorktreeCreationCollector>;
  bindings: ReturnType<typeof createWorktreeBindingCollector>;
}

interface ProjectScan {
  files: Map<string, FileScan>;
  activePath?: string;
}

export interface WorktreeAssociationHistory {
  records: Array<WorktreeCreationRecord & { sessionName?: string }>;
  bindings: WorktreeBindingRecord[];
  partial: boolean;
  failure?: "entry_too_large" | "unavailable";
  priorityPending?: boolean;
  progress: { running: boolean; processedBytes: number; totalBytes: number };
}

declare global {
  var __piWorktreeAssociationScans: Map<string, ProjectScan> | undefined;
}

function sameIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function sameVersion(a: Stats, b: Stats): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function sessionIdentity(session: Session): string {
  return JSON.stringify([session.id, session.cwd, session.created]);
}

function createFileScan(session: Session, stat: Stats, projectRoot: string): FileScan {
  return {
    identity: sessionIdentity(session), target: stat, offset: 0, hash: createHash("sha256"), phase: "read", verifyOffset: 0,
    parts: [], lineBytes: 0, headerSeen: false, nameSeen: false, unterminated: false, restarts: 0,
    creation: createWorktreeCreationCollector(session, null, homedir()),
    bindings: createWorktreeBindingCollector(session, projectRoot, null),
  };
}

function markError(file: FileScan, error: unknown): void {
  file.phase = "error";
  file.failure = error instanceof EntryTooLarge ? "entry_too_large" : "unavailable";
  file.parts = [];
  file.lineBytes = 0;
  file.verifyHash = undefined;
}

function beginVerification(file: FileScan, stat: Stats): void {
  file.phase = "verify";
  file.verifyOffset = 0;
  file.verifyHash = createHash("sha256");
  file.verifyStart = stat;
}

function foldLine(file: FileScan, session: Session, bytes: Buffer): void {
  if (!bytes.length || !bytes.toString("utf8").trim()) return;
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Invalid session entry"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid session entry");
  const record = value as Record<string, unknown>;
  if (!file.headerSeen) {
    if (record.type !== "session" || record.id !== session.id) throw new Error("Invalid session header");
    file.headerSeen = true;
    return;
  }
  if (record.type === "session_info") {
    file.nameSeen = true;
    file.name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : undefined;
  }
  const entry = value as SessionEntry;
  file.creation.add(entry);
  file.bindings.add(entry);
}

function addPart(file: FileScan, bytes: Buffer): void {
  file.lineBytes += bytes.length;
  if (file.lineBytes > MAX_LINE_BYTES) throw new EntryTooLarge("Session entry exceeds the scan limit");
  if (bytes.length) file.parts.push(bytes);
}

function consume(file: FileScan, session: Session, bytes: Buffer): void {
  let start = 0;
  for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
    addPart(file, bytes.subarray(start, end));
    foldLine(file, session, Buffer.concat(file.parts, file.lineBytes));
    file.parts = [];
    file.lineBytes = 0;
    start = end + 1;
  }
  addPart(file, bytes.subarray(start));
}

function currentStat(path: string, fd: number): Stats {
  const descriptor = fstatSync(fd);
  const named = statSync(path);
  if (!sameIdentity(descriptor, named)) throw new SessionChanged("Session file was replaced");
  return named;
}

function finishRead(file: FileScan, session: Session, stat: Stats): void {
  if (!sameVersion(file.target, stat)) {
    if (!sameIdentity(file.target, stat) || stat.size < file.offset) throw new SessionChanged("Session file changed while reading");
    beginVerification(file, stat);
    return;
  }
  if (file.lineBytes) {
    foldLine(file, session, Buffer.concat(file.parts, file.lineBytes));
    file.parts = [];
    file.lineBytes = 0;
    file.unterminated = true;
  }
  if (!file.headerSeen) throw new Error("Invalid session header");
  file.phase = "done";
  file.restarts = 0;
}

function advance(file: FileScan, session: Session, budget: number): number {
  const fd = openSync(session.path, "r");
  try {
    let stat = currentStat(session.path, fd);
    if (!sameIdentity(file.target, stat) || stat.size < file.offset) throw new SessionChanged("Session file changed while reading");
    if (file.phase === "verify" && file.verifyStart && !sameVersion(file.verifyStart, stat)) beginVerification(file, stat);
    const buffer = Buffer.allocUnsafe(Math.min(READ_BYTES, budget));
    let consumed = 0;
    while (consumed < budget && file.phase !== "done" && file.phase !== "error") {
      const verifying = file.phase === "verify";
      const position = verifying ? file.verifyOffset : file.offset;
      const limit = verifying ? file.offset : file.target.size;
      if (position >= limit) {
        stat = currentStat(session.path, fd);
        if (!sameIdentity(file.target, stat) || stat.size < file.offset) throw new SessionChanged("Session file changed while reading");
        if (verifying) {
          if (file.verifyStart && !sameVersion(file.verifyStart, stat)) {
            beginVerification(file, stat);
            continue;
          }
          if (file.verifyHash!.digest("hex") !== file.hash.copy().digest("hex")) throw new SessionChanged("Session prefix was modified");
          file.verifyHash = undefined;
          file.verifyStart = undefined;
          file.target = stat;
          file.phase = "read";
        } else {
          finishRead(file, session, stat);
        }
        continue;
      }
      const length = Math.min(buffer.length, budget - consumed, limit - position);
      const count = readSync(fd, buffer, 0, length, position);
      if (!count) throw new SessionChanged("Session file was truncated");
      const bytes = buffer.subarray(0, count);
      if (verifying) {
        file.verifyHash!.update(bytes);
        file.verifyOffset += count;
      } else {
        file.hash.update(bytes);
        // A copy is needed because the read buffer is reused while a line spans blocks.
        consume(file, session, Buffer.from(bytes));
        file.offset += count;
      }
      consumed += count;
    }
    // Complete a file exactly at a batch boundary without requiring an extra read.
    if (file.phase === "read" && file.offset === file.target.size) finishRead(file, session, currentStat(session.path, fd));
    if (file.phase === "done") {
      const after = currentStat(session.path, fd);
      if (!sameVersion(file.target, after)) {
        if (file.unterminated) throw new SessionChanged("Unterminated session entry changed");
        finishRead(file, session, after);
      }
    }
    return consumed;
  } finally {
    closeSync(fd);
  }
}

/** Read a bounded slice; later calls resume the same project without storing transcripts. */
export function scanWorktreeAssociations(
  sessions: readonly Session[],
  projectRoot: string,
  paths: readonly string[],
  options: { retry?: boolean; maxBytes?: number; prioritySessionId?: string } = {},
): WorktreeAssociationHistory {
  const cache: Map<string, ProjectScan> = globalThis.__piWorktreeAssociationScans ??= new Map();
  const selectedPaths = new Map(paths.filter(isAbsolute).map((path) => [normalize(path), path]));
  let project = cache.get(projectRoot);
  if (!project) project = { files: new Map() };
  cache.delete(projectRoot);
  cache.set(projectRoot, project);
  while (cache.size > MAX_PROJECTS) cache.delete(cache.keys().next().value!);

  const visible = new Set(sessions.map((session) => session.path));
  for (const path of project.files.keys()) if (!visible.has(path)) project.files.delete(path);
  let errors = 0;
  let totalBytes = 0;
  for (const session of sessions) {
    try {
      const stat = statSync(session.path);
      totalBytes += stat.size;
      let file = project.files.get(session.path);
      if (!file || file.identity !== sessionIdentity(session) || !sameIdentity(file.target, stat)
        || stat.size < file.offset || (file.phase === "error" && (options.retry || !sameVersion(file.target, stat)))) {
        file = createFileScan(session, stat, projectRoot);
        project.files.set(session.path, file);
      } else if (file.phase === "done" && !sameVersion(file.target, stat)) {
        if (stat.size > file.offset && !file.unterminated) beginVerification(file, stat);
        else project.files.set(session.path, createFileScan(session, stat, projectRoot));
      } else if (file.phase === "read" && stat.size === file.target.size && !sameVersion(file.target, stat)) {
        project.files.set(session.path, createFileScan(session, stat, projectRoot));
      }
    } catch {
      project.files.delete(session.path);
      errors++;
    }
  }

  let remaining = Math.max(1, Math.min(options.maxBytes ?? BATCH_BYTES, BATCH_BYTES));
  const ordered = [...sessions].sort((a, b) => a.path.localeCompare(b.path));
  const active = ordered.findIndex((session) => session.path === project.activePath);
  const activeFile = active >= 0 ? project.files.get(ordered[active].path) : undefined;
  const priority = ordered.findIndex((session) => session.id === options.prioritySessionId);
  let cursor = Math.max(0, activeFile && activeFile.phase !== "done" && activeFile.phase !== "error" ? active : priority);
  let idle = 0;
  while (ordered.length && remaining > 0 && idle < ordered.length) {
    const session = ordered[cursor];
    const file = project.files.get(session.path);
    if (!file || file.phase === "done" || file.phase === "error") {
      cursor = (cursor + 1) % ordered.length;
      idle++;
      continue;
    }
    idle = 0;
    try {
      const used = advance(file, session, Math.min(remaining, SLICE_BYTES));
      remaining -= used;
      if (!used && !["done", "error"].includes(file.phase)) throw new Error("Session scan made no progress");
    } catch (error) {
      // Mixed old/new bytes may fail parsing before the prefix check can run.
      try {
        const stat = statSync(session.path);
        if ((error instanceof SessionChanged || !sameVersion(file.target, stat)) && file.restarts < MAX_RESTARTS) {
          const replacement = createFileScan(session, stat, projectRoot);
          replacement.restarts = file.restarts + 1;
          project.files.set(session.path, replacement);
          remaining -= Math.min(remaining, SLICE_BYTES);
        } else markError(file, error);
      } catch (statError) { markError(file, statError); }
    }
  }
  // Finish one file before starting another so incomplete JSON lines stay bounded.
  project.activePath = ordered[cursor]?.path;

  const records: WorktreeAssociationHistory["records"] = [];
  const bindings: WorktreeBindingRecord[] = [];
  let processedBytes = 0;
  let failure: WorktreeAssociationHistory["failure"] = errors ? "unavailable" : undefined;
  let running = false;
  for (const session of sessions) {
    const file = project.files.get(session.path);
    if (!file) continue;
    processedBytes += file.phase === "verify" ? file.verifyOffset : file.offset;
    if (file.phase === "error") {
      errors++;
      if (!failure || file.failure === "entry_too_large") failure = file.failure;
    } else if (file.phase !== "done") running = true;
    else {
      const name = file.nameSeen ? file.name : session.name;
      records.push(...file.creation.records().filter((record) => selectedPaths.has(normalize(record.worktreePath))).map((record: WorktreeCreationRecord) => ({ ...record, worktreePath: selectedPaths.get(normalize(record.worktreePath))!, ...(name ? { sessionName: name } : {}) })));
      bindings.push(...file.bindings.records().filter((record) => selectedPaths.has(normalize(record.worktreePath))).map((record: WorktreeBindingRecord) => ({ ...record, ...(name ? { sessionName: name } : {}) })));
    }
  }
  const prioritySession = sessions.find((session) => session.id === options.prioritySessionId);
  const priorityFile = prioritySession && project.files.get(prioritySession.path);
  const priorityPending = Boolean(priorityFile && priorityFile.phase !== "done" && priorityFile.phase !== "error");
  return { records, bindings, partial: running || errors > 0, ...(failure ? { failure } : {}),
    ...(options.prioritySessionId ? { priorityPending } : {}), progress: { running, processedBytes, totalBytes } };
}
