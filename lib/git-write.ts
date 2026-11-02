import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getGitHead, getGitStatus } from "./git-changes";
import type { GitFileStatus, GitStatusResponse } from "./git-types";

const execFileAsync = promisify(execFile);
const GIT_WRITE_TIMEOUT_MS = 60_000;
const GIT_WRITE_MAX_PATHS = 100;
const GIT_WRITE_MAX_MESSAGE_CHARS = 4_000;
const GIT_BRANCH_NAME_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\/@)(?!.*@\{)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

export type GitWriteAction = "stage" | "commit" | "push" | "create-branch";

export class GitWriteError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
  }
}

export interface GitWriteResult {
  action: GitWriteAction;
  repositoryRoot: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  head: string | null;
  affectedPaths: string[];
}

interface GitWriteTarget {
  status: GitStatusResponse;
  allStatus: GitStatusResponse;
  repositoryRoot: string;
}

let writeTail: Promise<void> = Promise.resolve();

/** Serialize write actions in this server process so stage/commit cannot overlap. */
export function withGitWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const result = writeTail.then(task, task);
  writeTail = result.then(() => undefined, () => undefined);
  return result;
}

async function runGit(repositoryRoot: string, args: string[]): Promise<void> {
  try {
    await execFileAsync("git", ["-C", repositoryRoot, ...args], {
      timeout: GIT_WRITE_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        LC_ALL: "C",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
      },
    });
  } catch {
    throw new GitWriteError("git_failed", 502, "Git operation failed");
  }
}

function isWithin(parent: string, target: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function physicalPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function relativePath(repositoryRoot: string, filePath: string): string {
  return path.relative(repositoryRoot, filePath).split(path.sep).join("/");
}

function assertRepository(status: GitStatusResponse): asserts status is GitStatusResponse & { repositoryRoot: string } {
  if (!status.isGitRepository || !status.repositoryRoot) {
    throw new GitWriteError("not_git_repository", 409, "This folder is not a Git repository");
  }
}

async function resolveTarget(cwd: string): Promise<GitWriteTarget> {
  const status = await getGitStatus(cwd);
  assertRepository(status);
  const allStatus = path.resolve(status.repositoryRoot) === path.resolve(cwd)
    ? status
    : await getGitStatus(status.repositoryRoot);
  assertRepository(allStatus);
  return { status, allStatus, repositoryRoot: status.repositoryRoot };
}

function resolveChangedPaths(target: GitWriteTarget, cwd: string, rawPaths: string[]): { files: GitFileStatus[]; gitPaths: string[] } {
  if (!Array.isArray(rawPaths) || rawPaths.length === 0 || rawPaths.length > GIT_WRITE_MAX_PATHS) {
    throw new GitWriteError("paths_required", 400, "At least one changed path is required");
  }
  const files: GitFileStatus[] = [];
  const gitPaths: string[] = [];
  const physicalCwd = physicalPath(cwd);
  const seen = new Set<string>();
  for (const rawPath of rawPaths) {
    if (typeof rawPath !== "string" || !rawPath || rawPath !== rawPath.trim() || rawPath.includes("\0") || path.isAbsolute(rawPath)) {
      throw new GitWriteError("invalid_path", 400, "Invalid Git path");
    }
    const normalized = rawPath.split("\\").join("/");
    if (normalized.split("/").some((part) => part === "..")) {
      throw new GitWriteError("invalid_path", 400, "Invalid Git path");
    }
    const cwdCandidate = path.resolve(physicalCwd, normalized);
    const rootCandidate = path.resolve(target.repositoryRoot, normalized);
    const file = target.status.files.find((candidate) => candidate.filePath === cwdCandidate || candidate.filePath === rootCandidate);
    if (!file || !isWithin(physicalCwd, file.filePath)) {
      throw new GitWriteError("path_not_changed", 409, "A requested path is no longer changed");
    }
    const gitPath = relativePath(target.repositoryRoot, file.filePath);
    if (seen.has(gitPath)) continue;
    seen.add(gitPath);
    files.push(file);
    gitPaths.push(gitPath);
  }
  return { files, gitPaths };
}

function validateMessage(message: unknown): string {
  if (typeof message !== "string") throw new GitWriteError("message_required", 400, "Commit message is required");
  const normalized = message.trim();
  if (!normalized || normalized.length > GIT_WRITE_MAX_MESSAGE_CHARS || normalized.includes("\0")) {
    throw new GitWriteError("message_invalid", 400, "Commit message is empty or too long");
  }
  return normalized;
}

function validateBranchName(value: unknown): string {
  if (typeof value !== "string" || !GIT_BRANCH_NAME_RE.test(value)) {
    throw new GitWriteError("branch_invalid", 400, "Invalid branch name");
  }
  return value;
}

function resultFor(action: GitWriteAction, status: GitStatusResponse, repositoryRoot: string, affectedPaths: string[], head: string | null): GitWriteResult {
  return {
    action,
    repositoryRoot,
    branch: status.branch,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    head,
    affectedPaths,
  };
}

export async function runGitWrite(
  cwd: string,
  action: GitWriteAction,
  options: { paths?: string[]; message?: unknown; branchName?: unknown } = {},
): Promise<GitWriteResult> {
  const target = await resolveTarget(cwd);
  const { status, allStatus, repositoryRoot } = target;

  if (action === "stage") {
    const selected = resolveChangedPaths(target, cwd, options.paths ?? []);
    await runGit(repositoryRoot, ["add", "--", ...selected.gitPaths]);
    const after = await getGitStatus(cwd);
    assertRepository(after);
    return resultFor(action, after, repositoryRoot, selected.gitPaths, await getGitHead(cwd));
  }

  if (action === "commit") {
    const selected = resolveChangedPaths(target, cwd, options.paths ?? []);
    if (selected.files.some((file) => file.indexStatus === " " || file.indexStatus === "?")) {
      throw new GitWriteError("paths_not_staged", 409, "All selected paths must be staged first");
    }
    const message = validateMessage(options.message);
    await runGit(repositoryRoot, ["commit", "-m", message, "--", ...selected.gitPaths]);
    const after = await getGitStatus(cwd);
    assertRepository(after);
    return resultFor(action, after, repositoryRoot, selected.gitPaths, await getGitHead(cwd));
  }

  if (action === "push") {
    if (!status.branch || !status.upstream) throw new GitWriteError("no_upstream", 409, "Current branch has no upstream");
    await runGit(repositoryRoot, ["push"]);
    const after = await getGitStatus(cwd);
    assertRepository(after);
    return resultFor(action, after, repositoryRoot, [], await getGitHead(cwd));
  }

  if (action === "create-branch") {
    if (allStatus.files.length > 0) throw new GitWriteError("dirty_worktree", 409, "Working tree must be clean before creating a branch");
    const branchName = validateBranchName(options.branchName);
    await runGit(repositoryRoot, ["check-ref-format", "--branch", branchName]);
    await runGit(repositoryRoot, ["switch", "-c", branchName]);
    const after = await getGitStatus(cwd);
    assertRepository(after);
    return resultFor(action, after, repositoryRoot, [], await getGitHead(cwd));
  }

  throw new GitWriteError("action_invalid", 400, "Unsupported Git write action");
}
