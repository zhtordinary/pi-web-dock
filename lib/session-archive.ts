import { cpSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from "path";
import { homedir } from "os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

function readFirstLine(filePath: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(2048);
    const bytes = readSync(fd, buf, 0, 2048, 0);
    if (bytes === 0) return undefined;
    return buf.toString("utf8", 0, bytes).split("\n", 1)[0];
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** 读 session 首行 header 的 cwd，失败返回空串。 */
export function getPiSessionRoots() {
  const agentDir = getAgentDir();
  return {
    agentDir,
    sessionsDir: join(agentDir, "sessions"),
    archivedSessionsDir: join(agentDir, "archived_sessions"),
    // Token Monitor keeps recoverable deleted Pi sessions here.
    deletedSessionsDir: join(agentDir, "deleted_sessions"),
  };
}

function getRelativePathIfInside(filePath: string, dirPath: string): string | null {
  const rel = relative(dirPath, filePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel;
}

function isRealDirectory(filePath: string): boolean {
  try {
    const stat = lstatSync(filePath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isPathInside(filePath: string, dirPath: string): boolean {
  const rel = relative(dirPath, filePath);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Archived history is readable but cannot own an executing AgentSession. */
export function assertSessionFileExecutable(filePath: string): void {
  if (!filePath) return;
  const { sessionsDir, archivedSessionsDir } = getPiSessionRoots();
  const file = resolvePath(filePath);
  const moved = isPathInside(file, sessionsDir) && !existsSync(file)
    && existsSync(join(archivedSessionsDir, relative(sessionsDir, file)));
  if (isPathInside(file, archivedSessionsDir) || moved) {
    throw Object.assign(new Error("Session is archived; restore it before executing"), { code: "session_archived" });
  }
}

function listSessionFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const filePath = join(dir, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(filePath);
    }
  };
  visit(root);
  return files;
}

export function sessionArchiveFiles(filePath: string): string[] {
  return [filePath, ...listSessionFiles(filePath.replace(/\.jsonl$/, ""))];
}

const RECENT_SESSION_WRITE_GUARD_MS = 60_000;

interface SessionArchiveMoveState {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
}

declare global {
  var __piSessionArchiveMoveStates: Map<string, SessionArchiveMoveState> | undefined;
}

const SESSION_ARCHIVE_MOVE_STATE_MAX_ENTRIES = 2_000;

function getSessionArchiveMoveStates(): Map<string, SessionArchiveMoveState> {
  if (!globalThis.__piSessionArchiveMoveStates) globalThis.__piSessionArchiveMoveStates = new Map();
  return globalThis.__piSessionArchiveMoveStates;
}

function rememberSessionArchiveMove(filePath: string): void {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return;
  }
  const states = getSessionArchiveMoveStates();
  states.set(resolvePath(filePath), {
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    size: stat.size,
    ino: stat.ino,
  });
  while (states.size > SESSION_ARCHIVE_MOVE_STATE_MAX_ENTRIES) {
    const oldest = states.keys().next().value;
    if (oldest === undefined) break;
    states.delete(oldest);
  }
}

function forgetSessionArchiveMove(filePath: string): void {
  getSessionArchiveMoveStates().delete(resolvePath(filePath));
}

export class SessionArchiveConflictError extends Error {
  readonly code = "session_archive_conflict";

  constructor(message: string) {
    super(message);
    this.name = "SessionArchiveConflictError";
  }
}

/**
 * External pi CLI instances do not expose a shared lease to Reader. Refuse a
 * recent write so an open session cannot be moved underneath its writer. A
 * successful Reader-owned move records the file signature so an unchanged
 * file does not impose another quiet window on an immediate round trip.
 * ponytail: fixed quiet window; replace with upstream cross-process lease when available.
 */
export function isSessionFileRecentlyChanged(filePath: string): boolean {
  try {
    const stat = statSync(filePath);
    const key = resolvePath(filePath);
    const knownMove = getSessionArchiveMoveStates().get(key);
    if (knownMove) {
      const unchanged = knownMove.mtimeMs === stat.mtimeMs
        && knownMove.ctimeMs === stat.ctimeMs
        && knownMove.size === stat.size
        && knownMove.ino === stat.ino;
      if (unchanged) return false;
      getSessionArchiveMoveStates().delete(key);
    }
    return Date.now() - stat.mtimeMs < RECENT_SESSION_WRITE_GUARD_MS;
  } catch {
    return false;
  }
}

interface SessionHeaderPatch {
  targetPath: string;
  content: string;
  previousContent: string;
}

function movedParentPath(
  parentPath: string,
  sourceParentPath: string,
  targetParentPath: string,
  sourceChildRoot: string,
  targetChildRoot: string,
): string | undefined {
  if (!isAbsolute(parentPath)) return undefined;
  const resolved = parentPath.replace(/\\/g, "/");
  const sourceParent = sourceParentPath.replace(/\\/g, "/");
  if (resolved === sourceParent) return targetParentPath;
  if (isPathInside(resolved, sourceChildRoot)) {
    return join(targetChildRoot, relative(sourceChildRoot, resolved));
  }
  return undefined;
}

function collectSessionHeaderPatches(
  sourceChildRoot: string,
  targetChildRoot: string,
  sourceParentPath: string,
  targetParentPath: string,
): SessionHeaderPatch[] {
  const patches: SessionHeaderPatch[] = [];
  for (const sourcePath of listSessionFiles(sourceChildRoot)) {
    let content: string;
    try {
      content = readFileSync(sourcePath, "utf8");
    } catch {
      continue;
    }
    const newline = content.indexOf("\n");
    const firstLine = (newline === -1 ? content : content.slice(0, newline)).replace(/\r$/, "");
    let header: { type?: string; parentSession?: string };
    try {
      header = JSON.parse(firstLine) as { type?: string; parentSession?: string };
    } catch {
      continue;
    }
    if (header.type !== "session" || typeof header.parentSession !== "string") continue;
    const nextParent = movedParentPath(
      header.parentSession,
      sourceParentPath,
      targetParentPath,
      sourceChildRoot,
      targetChildRoot,
    );
    if (!nextParent || nextParent === header.parentSession) continue;
    const nextHeader = { ...header, parentSession: nextParent };
    const rest = newline === -1 ? "\n" : content.slice(newline);
    patches.push({
      targetPath: join(targetChildRoot, relative(sourceChildRoot, sourcePath)),
      content: `${JSON.stringify(nextHeader)}${rest}`,
      previousContent: content,
    });
  }
  return patches;
}

/** Upper bound for a post-move residue; larger non-session files stay fail-closed. */
const MAX_HEADERLESS_FRAGMENT_BYTES = 1024 * 1024;

/**
 * True when the file is a headerless fragment of Pi session entries: it never
 * begins with a `session` header, yet every non-empty line is a JSON entry.
 *
 * A writer that still holds the pre-move path can append after the file has
 * been moved away, which recreates the old path holding only the entries
 * written since. That fragment is residue of a completed move, not a second
 * copy of the session, so it must not deadlock the session's own move. Content
 * that is not recognizable session entries stays fail-closed.
 */
function isHeaderlessEntryFragment(filePath: string): boolean {
  const firstLine = readFirstLine(filePath);
  if (firstLine === undefined) return false;
  try {
    if ((JSON.parse(firstLine) as { type?: unknown }).type === "session") return false;
  } catch {
    return false;
  }
  // A residue only holds entries written after the move, so it is small. A
  // larger non-session file is not a residue; keep it fail-closed rather than
  // reading an unbounded file on this path.
  let content: string;
  try {
    const { size } = statSync(filePath);
    if (size > MAX_HEADERLESS_FRAGMENT_BYTES) return false;
    content = readFileSync(filePath, "utf8");
  } catch {
    return false;
  }
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return false;
  return lines.every((line) => {
    try {
      const entry = JSON.parse(line) as { type?: unknown } | null;
      return typeof entry === "object" && entry !== null && typeof entry.type === "string";
    } catch {
      return false;
    }
  });
}

function readSessionId(filePath: string): string | undefined {
  try {
    const firstLine = readFirstLine(filePath);
    if (!firstLine) return undefined;
    const id = (JSON.parse(firstLine) as { id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

function findSessionFilesById(root: string, sessionId: string): string[] {
  return listSessionFiles(root).filter((candidate) => readSessionId(candidate) === sessionId);
}

function duplicateSessionRelation(
  sourceContent: string,
  targetContent: string,
): "source-newer" | "target-newer" | "equal" | null {
  if (sourceContent === targetContent) return "equal";
  if (sourceContent.startsWith(targetContent) && targetContent.endsWith("\n")) return "source-newer";
  if (targetContent.startsWith(sourceContent) && sourceContent.endsWith("\n")) return "target-newer";
  return null;
}

function quarantineArchiveCollision(filePath: string, label: string): string {
  const backupDir = join(getPiSessionRoots().agentDir, "session-repair-backups", "archive-collisions");
  mkdirSync(backupDir, { recursive: true });
  const stem = `${Date.now()}-${process.pid}-${label}-${basename(filePath)}`;
  let backupPath = join(backupDir, stem);
  let suffix = 0;
  while (existsSync(backupPath)) backupPath = join(backupDir, `${stem}-${++suffix}`);
  renameSync(filePath, backupPath);
  return backupPath;
}

function reconcileDuplicateSessionFile(sourcePath: string, targetPath: string): string {
  let sourceContent: string;
  let targetContent: string;
  try {
    sourceContent = readFileSync(sourcePath, "utf8");
    targetContent = readFileSync(targetPath, "utf8");
  } catch {
    throw new SessionArchiveConflictError(`Cannot safely compare duplicate session files: ${sourcePath} / ${targetPath}`);
  }

  const relation = duplicateSessionRelation(sourceContent, targetContent);
  if (relation === null) {
    throw new SessionArchiveConflictError(`Duplicate session files diverge: ${sourcePath} / ${targetPath}`);
  }
  if (relation === "source-newer") {
    const oldTarget = quarantineArchiveCollision(targetPath, "stale-target");
    try {
      renameSync(sourcePath, targetPath);
      forgetSessionArchiveMove(sourcePath);
      rememberSessionArchiveMove(targetPath);
    } catch (error) {
      try { renameSync(oldTarget, targetPath); } catch { /* preserve original error */ }
      throw error;
    }
    return targetPath;
  }

  // Target already contains same or newer complete JSONL. Preserve redundant
  // source in repair backup instead of deleting it, then keep one live copy.
  quarantineArchiveCollision(sourcePath, relation === "equal" ? "duplicate-source" : "stale-source");
  return targetPath;
}

/** Verify archive move completed without leaving an active-path residue. */
export function verifySessionMove(sourcePath: string, targetPath: string): void {
  if (existsSync(sourcePath)) {
    throw new SessionArchiveConflictError(`Session source reappeared during archive: ${sourcePath}`);
  }
  if (!existsSync(targetPath)) {
    throw new Error(`Session archive target missing after move: ${targetPath}`);
  }
}

/** Direct sibling rewrite captured by the parent delete transaction. */
export type SessionReparentChange = {
  path: string;
  originalContent: string;
  nextContent: string;
};

/** Permanently remove parent session and its filesystem-owned child tree as one guarded operation. */
export function deletePiSessionTree(
  filePath: string,
  siblingChanges: readonly SessionReparentChange[] = [],
): { deleted: true; cleanupPending?: string } {
  const childRoot = join(dirname(filePath), basename(filePath, ".jsonl"));
  const childExists = existsSync(childRoot);
  if (childExists && !isRealDirectory(childRoot)) {
    throw new Error(`Session child path exists but is not a directory: ${childRoot}`);
  }
  if (!lstatSync(filePath).isFile()) throw new Error("Session parent must be a regular file");
  // ponytail: O(tree + sibling bytes) private backup; use filesystem snapshots if large trees make copies costly.
  const recoveryRoot = join(getPiSessionRoots().agentDir, "session-repair-backups", "permanent-delete");
  mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
  const recovery = mkdtempSync(join(recoveryRoot, "delete-"));
  const backup = join(recovery, "backup");
  // Only backups cross filesystems. Original detachment and rollback replacement
  // must both remain on the source volume.
  let sourceStage: string | undefined;
  let detached: string;
  const siblingBackup = join(backup, "siblings");
  const copyOptions = { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false };
  mkdirSync(backup, { mode: 0o700 });

  const siblingManifest: Array<{ path: string; slot: string }> = [];
  const restoreSiblings = () => {
    for (const { path, slot } of siblingManifest) {
      if (existsSync(path) && !lstatSync(path).isFile()) {
        throw new Error(`Sibling path is not a regular file: ${path}`);
      }
      writeFileSync(path, readFileSync(join(siblingBackup, slot), "utf8"));
    }
  };

  try {
    cpSync(filePath, join(backup, "session.jsonl"), copyOptions);
    if (childExists) cpSync(childRoot, join(backup, "children"), copyOptions);
    for (const [index, change] of siblingChanges.entries()) {
      if (dirname(change.path) !== dirname(filePath)) {
        throw new Error(`Sibling path is outside the parent session directory: ${change.path}`);
      }
      if (!lstatSync(change.path).isFile()) {
        throw new Error(`Sibling path is not a regular file: ${change.path}`);
      }
      if (readFileSync(change.path, "utf8") !== change.originalContent) {
        throw new Error(`Sibling changed during delete preparation: ${change.path}`);
      }
      mkdirSync(siblingBackup, { recursive: true, mode: 0o700 });
      const slot = `${index}.jsonl`;
      writeFileSync(join(siblingBackup, slot), change.originalContent, { mode: 0o600 });
      siblingManifest.push({ path: change.path, slot });
    }
    if (siblingManifest.length > 0) {
      writeFileSync(join(siblingBackup, "manifest.json"), JSON.stringify(siblingManifest), { mode: 0o600 });
    }
  } catch (error) {
    throw new Error(`Delete backup failed; original unchanged; recovery=${recovery}: ${String(error)}`);
  }

  try {
    sourceStage = mkdtempSync(join(dirname(filePath), ".reader-delete-"));
    detached = join(sourceStage, "detached");
    mkdirSync(detached, { mode: 0o700 });
    writeFileSync(join(recovery, "manifest.json"), JSON.stringify({
      version: 1, sessionFile: filePath, childRoot, sourceStage, backup,
    }), { mode: 0o600 });
  } catch (error) {
    throw new Error(`Delete preparation failed; originals unchanged; complete backup=${backup}; staging=${sourceStage ?? "not-created"}: ${String(error)}`);
  }
  let parentMoved = false;
  let childrenMoved = false;
  try {
    for (const change of siblingChanges) writeFileSync(change.path, change.nextContent);
    renameSync(filePath, join(detached, "session.jsonl"));
    parentMoved = true;
    if (childExists) {
      renameSync(childRoot, join(detached, "children"));
      childrenMoved = true;
    }
    rmSync(detached, { recursive: true, force: false });
  } catch (error) {
    const restoreErrors: string[] = [];
    try {
      restoreSiblings();
    } catch (restoreError) {
      restoreErrors.push(`siblings: ${String(restoreError)}`);
    }
    try {
      // Never restore a possibly partially removed detached tree. Keep complete backup on every failure.
      const restore = join(sourceStage, "restore");
      cpSync(backup, restore, copyOptions);
      if (childrenMoved) {
        if (existsSync(childRoot)) throw new Error("Child path reappeared during delete");
        renameSync(join(restore, "children"), childRoot);
      }
      if (parentMoved) {
        if (existsSync(filePath)) throw new Error("Parent path reappeared during delete");
        renameSync(join(restore, "session.jsonl"), filePath);
      }
    } catch (restoreError) {
      restoreErrors.push(`tree: ${String(restoreError)}`);
    }
    if (restoreErrors.length > 0) {
      throw new Error(`Delete failed; restore failed; complete backup=${backup}; staging=${sourceStage}: ${String(error)}; ${restoreErrors.join("; ")}`);
    }
    throw new Error(`Delete failed; originals restored; complete backup=${backup}; staging=${sourceStage}: ${String(error)}`);
  }
  try {
    rmSync(sourceStage, { recursive: true, force: false });
  } catch {
    // Keep the manifest/complete backup while source-volume cleanup is pending.
    return { deleted: true, cleanupPending: sourceStage };
  }
  try {
    rmSync(recovery, { recursive: true, force: false });
    return { deleted: true };
  } catch {
    return { deleted: true, cleanupPending: recovery };
  }
}

/** Move a Pi session jsonl and its parent-owned persistent child session tree. */
export function movePiSessionFile(
  filePath: string,
  destination: boolean | "deleted",
  siblingChanges: readonly SessionReparentChange[] = [],
): string {
  const { sessionsDir, archivedSessionsDir, deletedSessionsDir } = getPiSessionRoots();
  let targetRoot = sessionsDir;
  if (destination === "deleted") targetRoot = deletedSessionsDir;
  else if (destination) targetRoot = archivedSessionsDir;
  const targetLabel = destination === "deleted" ? "deleted" : "archive";
  const roots = [
    { dirPath: sessionsDir, isTarget: destination === false },
    { dirPath: archivedSessionsDir, isTarget: destination === true },
  ];
  for (const root of roots) {
    const rel = getRelativePathIfInside(filePath, root.dirPath);
    if (rel == null) continue;
    if (root.isTarget) return filePath;
    const targetPath = join(targetRoot, rel);
    const sourceChildRoot = join(dirname(filePath), basename(filePath, ".jsonl"));
    const childExists = existsSync(sourceChildRoot);
    if (childExists && !isRealDirectory(sourceChildRoot)) {
      throw new Error(`Session child path exists but is not a directory: ${sourceChildRoot}`);
    }
    const targetChildRoot = join(dirname(targetPath), basename(targetPath, ".jsonl"));
    if (!existsSync(filePath)) {
      if (existsSync(targetPath)) return targetPath;
      throw new Error(`Session file not found: ${filePath}`);
    }
    const sessionId = readSessionId(filePath);
    if (sessionId) {
      const otherTargetPaths = findSessionFilesById(targetRoot, sessionId)
        .filter((candidate) => candidate !== targetPath);
      if (otherTargetPaths.length > 0) {
        throw new SessionArchiveConflictError(
          `Session ${targetLabel} target has duplicate ID ${sessionId}: ${otherTargetPaths.join(", ")}`,
        );
      }
    }
    if (existsSync(targetPath)) {
      // A retry may arrive after another process completed the move. For a
      // genuine duplicate, reconcile only unbranched files whose JSONL is
      // identical or a complete prefix; divergent data remains fail-closed.
      //
      // Exception: a completed move can leave a headerless entry fragment on
      // the path it moved away from. That residue is preserved in the repair
      // backup and must not block the session's own move in either direction.
      const sourceIsFragment = isHeaderlessEntryFragment(filePath);
      const targetIsFragment = isHeaderlessEntryFragment(targetPath);
      if (targetIsFragment !== sourceIsFragment) {
        if (targetIsFragment) {
          // The move has not happened yet, or its target was recreated by a
          // late writer. Preserve the residue and continue with the session.
          quarantineArchiveCollision(targetPath, "stale-fragment");
        } else if (!childExists || existsSync(targetChildRoot)) {
          // The move already completed; preserve the residue and settle on the
          // path that still holds the session. The child tree must be either
          // absent or already at the target, otherwise the earlier move was
          // interrupted and the stranded subtree keeps this fail-closed.
          quarantineArchiveCollision(filePath, "stale-fragment");
          return targetPath;
        } else {
          throw new SessionArchiveConflictError(`Session child ${targetLabel} target already exists: ${targetChildRoot}`);
        }
      } else if (sourceIsFragment && targetIsFragment) {
        // Neither side is a session: do not guess which residue is the real content.
        throw new SessionArchiveConflictError(`Session ${targetLabel} target already exists: ${targetPath}`);
      } else if (childExists || existsSync(targetChildRoot)) {
        throw new SessionArchiveConflictError(`Session child ${targetLabel} target already exists: ${targetChildRoot}`);
      } else {
        return reconcileDuplicateSessionFile(filePath, targetPath);
      }
    }
    if (childExists && existsSync(targetChildRoot)) {
      throw new SessionArchiveConflictError(`Session child ${targetLabel} target already exists: ${targetChildRoot}`);
    }

    for (const change of siblingChanges) {
      if (dirname(change.path) !== dirname(filePath)) {
        throw new Error(`Sibling path is outside the parent session directory: ${change.path}`);
      }
      if (!lstatSync(change.path).isFile()) {
        throw new Error(`Sibling path is not a regular file: ${change.path}`);
      }
      if (readFileSync(change.path, "utf8") !== change.originalContent) {
        throw new Error(`Sibling changed during session move preparation: ${change.path}`);
      }
    }
    const patches = childExists
      ? collectSessionHeaderPatches(sourceChildRoot, targetChildRoot, filePath, targetPath)
      : [];
    const appliedPatches: SessionHeaderPatch[] = [];
    let parentMoved = false;
    let childMoved = false;
    try {
      for (const change of siblingChanges) writeFileSync(change.path, change.nextContent);
      mkdirSync(dirname(targetPath), { recursive: true });
      renameSync(filePath, targetPath);
      parentMoved = true;
      if (childExists) {
        renameSync(sourceChildRoot, targetChildRoot);
        childMoved = true;
      }
      for (const patch of patches) {
        writeFileSync(patch.targetPath, patch.content);
        appliedPatches.push(patch);
      }
    } catch (error) {
      for (const change of siblingChanges) {
        try { writeFileSync(change.path, change.originalContent); } catch { /* best effort rollback */ }
      }
      for (const patch of appliedPatches) {
        try { writeFileSync(patch.targetPath, patch.previousContent); } catch { /* best effort rollback */ }
      }
      if (childMoved) {
        try { renameSync(targetChildRoot, sourceChildRoot); } catch { /* preserve original error */ }
      }
      if (parentMoved) {
        try { renameSync(targetPath, filePath); } catch { /* preserve original error */ }
      }
      throw error;
    }
    forgetSessionArchiveMove(filePath);
    rememberSessionArchiveMove(targetPath);
    return targetPath;
  }
  throw new Error(`Session file is not under sessions or archived_sessions: ${filePath}`);
}

/** Move a session bundle into TokenMonitor's recoverable deleted_sessions root. */
export function movePiSessionToDeleted(
  filePath: string,
  siblingChanges: readonly SessionReparentChange[] = [],
): string {
  return movePiSessionFile(filePath, "deleted", siblingChanges);
}

function tokenMonitorStorageDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "CodexTokenMonitor");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "CodexTokenMonitor");
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "CodexTokenMonitor");
}

function setTokenMonitorLifecycleFlag(
  filePath: string,
  filename: string,
  enabled: boolean,
  storageDir: string,
): void {
  const stem = basename(filePath, ".jsonl");
  const metaPath = join(storageDir, filename);
  try {
    // Reader must work without TokenMonitor. Missing metadata means the
    // optional integration is absent, so do not create its storage here.
    if (!existsSync(metaPath)) return;
    const map = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, boolean>;
    if (enabled) map[stem] = true;
    else delete map[stem];
    writeFileSync(metaPath, `${JSON.stringify(map, null, 2)}\n`);
  } catch {
    // ignore metadata failures
  }
}

/** Best-effort TokenMonitor metadata sync. Filesystem location is the source of truth. */
export function setTokenMonitorArchivedFlag(filePath: string, archived: boolean, storageDir = tokenMonitorStorageDir()): void {
  setTokenMonitorLifecycleFlag(filePath, "pi-token-window-monitor.archived.json", archived, storageDir);
}

/** Best-effort TokenMonitor deleted-state sync. Filesystem location is the source of truth. */
export function setTokenMonitorDeletedFlag(filePath: string, deleted: boolean, storageDir = tokenMonitorStorageDir()): void {
  setTokenMonitorLifecycleFlag(filePath, "pi-token-window-monitor.deleted.json", deleted, storageDir);
}

/** Clear stale optional lifecycle flags after a permanent session removal. */
export function clearTokenMonitorLifecycleFlags(filePath: string, storageDir = tokenMonitorStorageDir()): void {
  const stem = basename(filePath, ".jsonl");
  for (const filename of ["pi-token-window-monitor.archived.json", "pi-token-window-monitor.deleted.json"]) {
    const metaPath = join(storageDir, filename);
    try {
      if (!existsSync(metaPath)) continue;
      const map = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, boolean>;
      if (!map || Array.isArray(map) || typeof map !== "object" || !Object.prototype.hasOwnProperty.call(map, stem)) continue;
      delete map[stem];
      writeFileSync(metaPath, `${JSON.stringify(map, null, 2)}\n`);
    } catch {
      // Optional integration failure must never turn Reader deletion into an error.
    }
  }
}
