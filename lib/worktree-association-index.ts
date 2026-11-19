import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { localDeviceId } from "./activity-peers";
import type { SessionInfo } from "./types";
import type { WorktreeCreationRecord } from "./worktree-creation-history";

type Session = Pick<SessionInfo, "id" | "path" | "cwd" | "created">;
type Hint = WorktreeCreationRecord & {
  deviceId: string;
  projectRoot: string;
  sessionPath: string;
  sessionIdentity: string;
  sessionDev: number;
  sessionIno: number;
  sessionSize: number;
  worktreeDev: number;
  worktreeIno: number;
};

const MAX_INDEX_BYTES = 512 * 1024;
const MAX_HINTS = 1024;

function stableFileIdentity(stat: { ino: number; birthtimeMs: number }): number {
  if (stat.ino > 0) return stat.ino;
  return Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? Math.trunc(stat.birthtimeMs * 1000) : 0;
}

function indexPath(deviceId: string): string {
  const configured = process.env.XDG_CACHE_HOME?.trim();
  const root = configured && isAbsolute(configured) ? configured : join(homedir(), ".cache");
  const device = createHash("sha256").update(deviceId).digest("hex").slice(0, 16);
  return join(root, "pi-web-reader", `worktree-association-index-${device}.json`);
}

function sessionIdentity(session: Session): string {
  return JSON.stringify([session.id, session.cwd, session.created]);
}

function validHint(value: unknown): value is Hint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const hint = value as Record<string, unknown>;
  return [hint.projectRoot, hint.sessionPath, hint.worktreePath].every((part) => typeof part === "string" && isAbsolute(part))
    && typeof hint.deviceId === "string" && hint.deviceId.length > 0
    && typeof hint.sessionId === "string" && typeof hint.sessionIdentity === "string"
    && typeof hint.createdAt === "string" && Number.isFinite(Date.parse(hint.createdAt))
    && [hint.sessionDev, hint.sessionIno, hint.sessionSize, hint.worktreeDev, hint.worktreeIno]
      .every((part) => typeof part === "number" && Number.isSafeInteger(part) && part >= 0)
    && (hint.sessionIno as number) > 0 && (hint.worktreeIno as number) > 0;
}

function readIndex(path: string): Hint[] {
  let fd: number | undefined;
  try {
    if (lstatSync(path).isSymbolicLink()) return [];
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_INDEX_BYTES) return [];
    const data: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return [];
    const index = data as Record<string, unknown>;
    return index.version === 1 && Array.isArray(index.hints) && index.hints.length <= MAX_HINTS
      ? index.hints.filter(validHint) : [];
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Untrusted, display-only suggestions; completeness still comes from the scanner. */
export function readWorktreeAssociationHints(projectRoot: string, sessions: readonly Session[], paths: readonly string[]): WorktreeCreationRecord[] {
  const byPath = new Map(sessions.map((session) => [session.path, session]));
  const counts = new Map<string, number>();
  for (const session of sessions) counts.set(session.id, (counts.get(session.id) ?? 0) + 1);
  const registered = new Map(paths.filter(isAbsolute).map((path) => [normalize(path), path]));
  const deviceId = localDeviceId();
  const results: WorktreeCreationRecord[] = [];
  for (const hint of readIndex(indexPath(deviceId))) {
    const session = byPath.get(hint.sessionPath);
    const worktreePath = registered.get(normalize(hint.worktreePath));
    if (hint.deviceId !== deviceId || hint.projectRoot !== projectRoot || !session || session.id !== hint.sessionId || counts.get(session.id) !== 1
      || sessionIdentity(session) !== hint.sessionIdentity || !worktreePath) continue;
    try {
      const source = statSync(session.path), worktree = statSync(worktreePath);
      if (!source.isFile() || source.dev !== hint.sessionDev || stableFileIdentity(source) !== hint.sessionIno || source.size < hint.sessionSize
        || !worktree.isDirectory() || worktree.dev !== hint.worktreeDev || stableFileIdentity(worktree) !== hint.worktreeIno) continue;
      results.push({ sessionId: hint.sessionId, worktreePath, createdAt: hint.createdAt });
    } catch { /* A missing or replaced file cannot supply a hint. */ }
  }
  return results;
}

/** Persist only verified positive creation records; a lost cache is always rebuilt. */
export function saveWorktreeAssociationHints(projectRoot: string, sessions: readonly Session[], paths: readonly string[], records: readonly WorktreeCreationRecord[], complete = true): void {
  const deviceId = localDeviceId();
  const path = indexPath(deviceId);
  const registered = new Map(paths.filter(isAbsolute).map((item) => [normalize(item), item]));
  const byId = new Map<string, Session | null>();
  for (const session of sessions) byId.set(session.id, byId.has(session.id) ? null : session);
  const fresh: Hint[] = [];
  for (const record of records) {
    const session = byId.get(record.sessionId);
    const worktreePath = registered.get(normalize(record.worktreePath));
    if (!session || !worktreePath) continue;
    try {
      const source = statSync(session.path), worktree = statSync(worktreePath);
      const hint: Hint = { sessionId: record.sessionId, createdAt: record.createdAt, deviceId, projectRoot, sessionPath: session.path, sessionIdentity: sessionIdentity(session),
        sessionDev: source.dev, sessionIno: stableFileIdentity(source), sessionSize: source.size, worktreePath,
        worktreeDev: worktree.dev, worktreeIno: stableFileIdentity(worktree) };
      if (source.isFile() && worktree.isDirectory() && validHint(hint)) fresh.push(hint);
    } catch { /* The cache is optional; do not turn a stale record into a hint. */ }
  }
  try {
    const confirmed = new Set(fresh.map((hint) => hint.sessionId));
    const existing = readIndex(path).filter((hint) => hint.deviceId !== deviceId || hint.projectRoot !== projectRoot || (!complete && !confirmed.has(hint.sessionId)));
    const hints = [...existing, ...fresh].slice(-MAX_HINTS);
    const data = JSON.stringify({ version: 1, hints });
    if (Buffer.byteLength(data) > MAX_INDEX_BYTES) return;
    if (JSON.stringify({ version: 1, hints: readIndex(path) }) === data) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { if (lstatSync(path).isSymbolicLink()) return; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    writePrivateFileAtomicSync(path, data);
  } catch { /* Cache failures never change scan completeness. */ }
}
