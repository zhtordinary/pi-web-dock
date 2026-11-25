import { execFile } from "child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { promisify } from "util";
import { isPathWithinRoots } from "./path-security";
import { samePath } from "./paths";
import { getRpcSessionInfos } from "./rpc-manager";
import { getPiSessionRoots } from "./session-archive";
import { readSiblingExecution } from "./session-channel-control";
import { getSessionEntries, listAllSessions, listArchivedSessions } from "./session-reader";
import { listSessionsIncremental } from "./session-list-scanner";
import { findWorktreeBindingRecords } from "./worktree-bindings";
import { findWorktreeCreationEvidence } from "./worktree-creation-history";
import { assertWorktreeDirectoryIdentity, collectWorktreeDirtySummaries, listWorktrees, type WorktreeDirectoryIdentity } from "./worktree";

type SafetySession = {
  id: string;
  path?: string;
  cwd: string;
  name?: string;
  created: string;
  projectRoot?: string;
};

type InventoryRoot = {
  directory: string;
  paths: ReadonlySet<string>;
};

function assertKnownSessionInventory(
  sessionPaths: ReadonlySet<string>,
  deletedSessionPaths: ReadonlySet<string>,
): void {
  const roots = getPiSessionRoots();
  const pending: InventoryRoot[] = [
    { directory: roots.sessionsDir, paths: sessionPaths },
    { directory: roots.archivedSessionsDir, paths: sessionPaths },
    { directory: roots.deletedSessionsDir, paths: deletedSessionPaths },
  ];
  let inspected = 0;
  try {
    while (pending.length) {
      const current = pending.pop()!;
      const info = lstatSync(current.directory, { throwIfNoEntry: false });
      if (!info) continue;
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unknown session directory");
      for (const entry of readdirSync(current.directory, { withFileTypes: true })) {
        // pi-subagents stores non-session JSONL artifacts here; the canonical
        // session scanner intentionally excludes this directory as well.
        if (entry.name === "subagent-artifacts" && (entry.isDirectory() || entry.isSymbolicLink())) continue;
        if (++inspected > 100_000 || entry.isSymbolicLink()) throw new Error("incomplete session inventory");
        const path = join(current.directory, entry.name);
        if (entry.isDirectory()) pending.push({ directory: path, paths: current.paths });
        else if (entry.name.endsWith(".jsonl") && (!entry.isFile() || !current.paths.has(resolve(path)))) {
          throw new Error("unindexed session file");
        }
      }
    }
  } catch {
    throw new Error("Worktree safety unknown: session inventory is incomplete");
  }
}

/** Refuse rather than infer that a linked checkout and its references are disposable. */
export async function assertWorktreeRemovalSafe(cwd: string, path: string): Promise<WorktreeDirectoryIdentity> {
  const worktrees = await listWorktrees(cwd);
  const physicalPath = realpathSync(path);
  const stat = lstatSync(physicalPath);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino) || stat.ino <= 0) {
    throw new Error("Worktree safety unknown: directory identity is invalid");
  }
  const identity = { path: physicalPath, dev: stat.dev, ino: stat.ino };
  const target = worktrees.find((worktree) => samePath(realpathSync(worktree.path), physicalPath));
  const projectRoot = worktrees.find((worktree) => worktree.isMain)?.path;
  if (!target || target.isMain || !projectRoot) throw new Error("Worktree removal refused: not a linked worktree of this repository");
  const roots = new Set([physicalPath]);
  if (worktrees.some((worktree) => !samePath(worktree.path, target.path) && isPathWithinRoots(realpathSync(worktree.path), roots))) {
    throw new Error("Worktree removal refused: another registered worktree is nested inside it");
  }
  const summary = (await collectWorktreeDirtySummaries([target])).get(target.path);
  if (!summary || summary.state === "unavailable") throw new Error("Worktree safety unknown: working tree status is unavailable");
  if (summary.hasUncommitted) throw new Error("Worktree contains modified or untracked files");
  if (summary.ignoredCount) throw new Error("Worktree removal refused: ignored files are present");

  const [persisted, archived, sibling] = await Promise.all([
    listAllSessions({ readOnly: true }), listArchivedSessions({ readOnly: true }), readSiblingExecution(),
  ]);
  if (!sibling.complete) throw new Error("Worktree safety unknown: another Reader channel is unavailable");
  let deletedSessionInfos: Awaited<ReturnType<typeof listSessionsIncremental>>;
  try {
    deletedSessionInfos = await listSessionsIncremental({
      sessionsDir: getPiSessionRoots().deletedSessionsDir,
      readOnly: true,
      requireComplete: true,
    });
  } catch {
    throw new Error("Worktree safety unknown: session inventory is incomplete");
  }
  const sessions: SafetySession[] = [...persisted, ...archived, ...getRpcSessionInfos()];
  const deletedSessions: SafetySession[] = deletedSessionInfos.map((session) => ({
    id: session.id,
    path: session.path,
    cwd: session.cwd,
    name: session.name,
    created: session.created.toISOString(),
  }));
  assertKnownSessionInventory(
    new Set(sessions.flatMap((session) => session.path ? [resolve(session.path)] : [])),
    new Set(deletedSessions.flatMap((session) => session.path ? [resolve(session.path)] : [])),
  );
  const ids = new Set(sessions.map((session) => session.id));
  if (Object.keys(sibling.execution).some((id) => !ids.has(id))) {
    throw new Error("Worktree safety unknown: another Reader session could not be located");
  }
  const inspectedPaths = new Set<string>();
  let remainingBytes = 256 * 1024 * 1024;
  const inspectSessionHistory = (session: SafetySession): void => {
    if (!session.path) return;
    const sessionPath = resolve(session.path);
    if (inspectedPaths.has(sessionPath)) return;
    inspectedPaths.add(sessionPath);
    try {
      const size = statSync(sessionPath).size;
      if (size > 64 * 1024 * 1024 || size > remainingBytes) throw new Error("Worktree safety unknown: session history is too large to inspect");
      remainingBytes -= size;
      const entries = getSessionEntries(sessionPath);
      const creationEvidence = findWorktreeCreationEvidence(entries, session, [target.path], homedir(), projectRoot);
      if (creationEvidence.uncertain) {
        throw new Error("Worktree safety unknown: worktree creation history is incomplete");
      }
      if (creationEvidence.records.length || findWorktreeBindingRecords(entries, session, projectRoot, [target.path]).length) {
        throw new Error("Worktree removal refused: a session is associated with this worktree");
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Worktree ")) throw error;
      throw new Error("Worktree safety unknown: session history is unavailable");
    }
  };
  for (const session of sessions) {
    if (session.cwd && isPathWithinRoots(existsSync(session.cwd) ? realpathSync(session.cwd) : session.cwd, roots)) {
      throw new Error("Worktree removal refused: a session uses this directory");
    }
    if (!session.path || !session.projectRoot || !samePath(session.projectRoot, projectRoot)) continue;
    inspectSessionHistory(session);
  }
  for (const session of deletedSessions) {
    if (session.cwd && isPathWithinRoots(existsSync(session.cwd) ? realpathSync(session.cwd) : session.cwd, roots)) {
      throw new Error("Worktree removal refused: a session uses this directory");
    }
    // Deleted sessions are not active, but their immutable history can still
    // prove a worktree association and must remain part of the safety check.
    inspectSessionHistory(session);
  }
  if (process.platform === "win32") throw new Error("Worktree safety unknown: process inspection is unavailable");
  try {
    const executable = process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof";
    const result = await promisify(execFile)(executable, ["-nP", "-t", "+D", physicalPath], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    if (result.stderr.trim()) throw new Error("Worktree safety unknown: process inspection was incomplete");
    if (result.stdout.trim()) throw new Error("Worktree removal refused: a process is using this directory");
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    if (!(failure.code === 1 && !String(failure.stdout ?? "").trim() && !String(failure.stderr ?? "").trim())) {
      if (error instanceof Error && error.message.startsWith("Worktree ")) throw error;
      throw new Error("Worktree safety unknown: process inspection was incomplete");
    }
  }
  assertWorktreeDirectoryIdentity(target.path, identity);
  return identity;
}
