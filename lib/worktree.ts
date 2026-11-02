import { execFile } from "child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "fs";
import { stat as statAsync } from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import { promisify } from "util";
import { allowFileRoot } from "./allowed-roots";
import { samePath, toNativePath } from "./paths";
import { getGitRemoteUrls } from "./git-changes";
import { selectGitHubRepository } from "./git-github";
import {
  attachDirtySummaryProjection,
  computeWorktreeGraphFromDag,
  type CommitMetaEntry,
  type RawWorktreeRecord,
  type WorktreeDirtySummary,
  type WorktreeGraph,
  type WorktreeInspection,
  type WorktreeInspectionCommitMode,
} from "./worktree-graph-types";

const execFileAsync = promisify(execFile);

// ============================================================================
// Project resolution: cwd → { projectRoot, branch }
//
// A worktree's `git rev-parse --git-common-dir` points at the *main* repo's
// .git directory, so its parent is the project root shared by all worktrees.
// Non-git directories resolve to themselves. Results are cached on globalThis
// (hot-reload safe) with a short TTL; add/remove worktree invalidates eagerly.
// ============================================================================

export interface ProjectInfo {
  projectRoot: string;
  /** True when cwd resolves inside a Git repository, including detached HEAD. */
  isGit: boolean;
  /** Current branch of the cwd, null for non-git dirs or detached HEAD */
  branch: string | null;
  /** True when cwd is a linked worktree (not the main checkout) */
  isWorktree: boolean;
  /** True when cwd is the top-level directory of a checkout (main or linked).
   *  False for repo subdirectories and non-git dirs — the worktree switcher
   *  is only meaningful at the top level. */
  isTopLevel: boolean;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  isMain: boolean;
}

declare global {
  var __piProjectCache: Map<string, { info: ProjectInfo; expiresAt: number }> | undefined;
  var __piProjectRefresh: Map<string, Promise<ProjectInfo>> | undefined;
  var __piProjectRetryAt: Map<string, number> | undefined;
  var __piProjectCacheGeneration: number | undefined;
  var __piWorktreeGraphCache: Map<string, { graph: WorktreeGraph; expiresAt: number }> | undefined;
}

const PROJECT_CACHE_TTL_MS = 60_000;
const PROJECT_RETRY_MS = 1_000;
const PROJECT_CACHE_MAX_ENTRIES = 256;
const WORKTREE_GRAPH_CACHE_TTL_MS = 60_000;

function cacheProject(cache: Map<string, { info: ProjectInfo; expiresAt: number }>, cwd: string, info: ProjectInfo): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  cache.delete(cwd);
  cache.set(cwd, { info, expiresAt: now + PROJECT_CACHE_TTL_MS });
  while (cache.size > PROJECT_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function getProjectCache(): Map<string, { info: ProjectInfo; expiresAt: number }> {
  if (!globalThis.__piProjectCache) globalThis.__piProjectCache = new Map();
  return globalThis.__piProjectCache;
}

function getGraphCache(): Map<string, { graph: WorktreeGraph; expiresAt: number }> {
  if (!globalThis.__piWorktreeGraphCache) globalThis.__piWorktreeGraphCache = new Map();
  return globalThis.__piWorktreeGraphCache;
}

export function invalidateProjectCache(): void {
  globalThis.__piProjectCache?.clear();
  globalThis.__piProjectCacheGeneration = (globalThis.__piProjectCacheGeneration ?? 0) + 1;
  globalThis.__piProjectRefresh?.clear();
  globalThis.__piProjectRetryAt?.clear();
  globalThis.__piWorktreeGraphCache?.clear();
}

async function git(cwd: string, args: string[], timeoutMs = 10_000): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    // Pin the message locale so error-text matching (e.g. the dirty-worktree
    // detection in the DELETE route) works regardless of system language.
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.trim();
}

/** Run Git without trimming stdout. Porcelain status uses leading spaces. */
async function gitRaw(cwd: string, args: string[], timeoutMs = 10_000): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

export interface PorcelainStatusEntry {
  status: string;
  paths: string[];
}

/** Parse porcelain v1 -z records without losing leading status columns. */
export function parsePorcelainStatusZ(output: string): PorcelainStatusEntry[] {
  const tokens = output.split("\0");
  const entries: PorcelainStatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.length < 2) continue;
    const status = token.slice(0, 2);
    // A status record has a space separator at offset 2. Keep the path
    // opaque; it is only used by the inspect endpoint after redaction.
    const path = token.length > 3 ? token.slice(3) : "";
    const paths = path ? [path] : [];
    // In -z mode rename/copy records carry the old path in the following NUL
    // record. Count and redact the whole entry as one status row.
    if ((status[0] === "R" || status[0] === "C") && index + 1 < tokens.length) {
      const previousPath = tokens[index + 1];
      if (previousPath) paths.push(previousPath);
      index += 1;
    }
    entries.push({ status, paths });
  }
  return entries;
}

function unavailableDirtySummary(): WorktreeDirtySummary {
  return {
    state: "unavailable",
    hasUncommitted: false,
    dirtyCount: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    ignoredCount: 0,
  };
}

/** Summarize status columns only; never return file names from this projector. */
export function summarizePorcelainStatus(output: string): WorktreeDirtySummary {
  const entries = parsePorcelainStatusZ(output);
  let dirtyCount = 0;
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;
  let ignoredCount = 0;
  for (const entry of entries) {
    if (entry.status === "!!") {
      ignoredCount += 1;
      continue;
    }
    dirtyCount += 1;
    if (entry.status === "??") {
      untrackedCount += 1;
      continue;
    }
    if (entry.status[0] !== " " && entry.status[0] !== "!") stagedCount += 1;
    if (entry.status[1] !== " " && entry.status[1] !== "!") unstagedCount += 1;
  }
  return {
    state: dirtyCount > 0 ? "dirty" : "clean",
    hasUncommitted: dirtyCount > 0,
    dirtyCount,
    stagedCount,
    unstagedCount,
    untrackedCount,
    ignoredCount,
  };
}

/** Collect status summaries for all registered worktrees in one graph request. */
export async function collectWorktreeDirtySummaries(
  worktrees: readonly Pick<WorktreeInfo, "path">[],
): Promise<Map<string, WorktreeDirtySummary>> {
  const rows: Array<readonly [string, WorktreeDirtySummary]> = new Array(worktrees.length);
  let nextIndex = 0;
  const workerCount = Math.min(8, worktrees.length);
  const workers = Array.from({ length: workerCount }, () => (async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= worktrees.length) return;
      const path = worktrees[index]!.path;
      try {
        const output = await gitRaw(
          path,
          ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignored=matching"],
          8_000,
        );
        rows[index] = [path, summarizePorcelainStatus(output)];
      } catch {
        rows[index] = [path, unavailableDirtySummary()];
      }
    }
  })());
  await Promise.all(workers);
  return new Map(rows);
}

function realPathOrSelf(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

/**
 * Group removed project-local worktrees back under their repository.
 * Historical sibling worktree paths remain readable for existing sessions;
 * inference never relocates their execution cwd.
 */
function inferRemovedWorktree(cwd: string): ProjectInfo | null {
  const parent = dirname(cwd);
  const repoRoot = basename(parent) === ".worktrees"
    ? dirname(parent)
    : parent.endsWith("-worktrees") ? parent.slice(0, -"-worktrees".length) : null;
  if (!repoRoot || !existsSync(join(repoRoot, ".git"))) return null;
  return { projectRoot: realPathOrSelf(repoRoot), isGit: true, branch: basename(cwd), isWorktree: true, isTopLevel: true };
}

/**
 * Resolve a cwd's project identity with stale-while-revalidate caching.
 *
 * Within PROJECT_CACHE_TTL_MS the cached value is returned directly. After
 * that the stale value is still returned immediately while a background
 * refresh re-runs git; callers (chiefly the session list, which fans out over
 * every project cwd) therefore never wait on git subprocesses once a cwd has
 * been resolved once. Concurrent lookups for the same cwd share one promise.
 * add/removeWorktree invalidate eagerly via invalidateProjectCache().
 */
export async function resolveProject(cwd: string): Promise<ProjectInfo> {
  const cache = getProjectCache();
  const cached = cache.get(cwd);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.info;

  // Serve the stale entry now; refresh out of band.
  if (cached) {
    void refreshProjectInBackground(cwd).catch(() => {});
    return cached.info;
  }

  const generation = globalThis.__piProjectCacheGeneration ?? 0;
  const info = await refreshProjectInBackground(cwd);
  return (globalThis.__piProjectCacheGeneration ?? 0) === generation ? info : resolveProject(cwd);
}

/**
 * The cached project identity without waiting on git, for display-only callers.
 * A cwd not resolved yet in this process reads as unknown while a background
 * probe fills the cache: git in some folders (iCloud Drive) blocks ~10 s and
 * must not stall a whole response after every restart.
 */
export function peekProject(cwd: string): ProjectInfo | undefined {
  const cached = getProjectCache().get(cwd);
  if (!cached || cached.expiresAt <= Date.now()) void refreshProjectInBackground(cwd).catch(() => {});
  return cached?.info;
}

function isTransientGitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
  return failure.killed === true || typeof failure.signal === "string"
    || ["EAGAIN", "EMFILE", "ENFILE", "ENOMEM"].includes(failure.code ?? "");
}

function refreshProjectInBackground(cwd: string): Promise<ProjectInfo> {
  const inflight = (globalThis.__piProjectRefresh ??= new Map<string, Promise<ProjectInfo>>());
  const pending = inflight.get(cwd);
  if (pending) return pending;
  const retryAt = (globalThis.__piProjectRetryAt ??= new Map<string, number>());
  const fallback = () => getProjectCache().get(cwd)?.info
    ?? { projectRoot: cwd, isGit: false, branch: null, isWorktree: false, isTopLevel: false };
  if ((retryAt.get(cwd) ?? 0) > Date.now()) return Promise.resolve(fallback());
  const generation = globalThis.__piProjectCacheGeneration ?? 0;
  const task = resolveProjectUncached(cwd)
    .then((info) => {
      if ((globalThis.__piProjectCacheGeneration ?? 0) === generation) {
        retryAt.delete(cwd);
        cacheProject(getProjectCache(), cwd, info);
      }
      return info;
    })
    .catch((error: unknown) => {
      if (!isTransientGitError(error)) throw error;
      if ((globalThis.__piProjectCacheGeneration ?? 0) === generation) {
        retryAt.delete(cwd);
        retryAt.set(cwd, Date.now() + PROJECT_RETRY_MS);
        if (retryAt.size > PROJECT_CACHE_MAX_ENTRIES) retryAt.delete(retryAt.keys().next().value!);
      }
      return fallback();
    })
    .finally(() => {
      if (inflight.get(cwd) === task) inflight.delete(cwd);
    });
  inflight.set(cwd, task);
  return task;
}

/** Only skip Git when repository discovery is certainly impossible. */
function hasGitAncestor(cwd: string): boolean {
  if (process.env.GIT_DIR !== undefined || process.env.GIT_WORK_TREE !== undefined
      || process.env.GIT_COMMON_DIR !== undefined || cwd.split(/[\\/]+/).includes("..")) return true;
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    try {
      if (lstatSync(dir).isSymbolicLink()) return true;
    } catch {
      return true;
    }
    for (const marker of [".git", "HEAD"]) {
      try {
        lstatSync(join(dir, marker));
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") return true;
      }
    }
    if (dirname(dir) === dir) return false;
  }
}

async function resolveProjectUncached(cwd: string): Promise<ProjectInfo> {
  let info: ProjectInfo;
  try {
    if (!existsSync(cwd)) {
      return inferRemovedWorktree(cwd)
        ?? { projectRoot: cwd, isGit: false, branch: null, isWorktree: false, isTopLevel: false };
    }
    if (!hasGitAncestor(cwd)) return { projectRoot: cwd, isGit: false, branch: null, isWorktree: false, isTopLevel: false };
    const out = await git(cwd, [
      "rev-parse", "--path-format=absolute",
      "--git-common-dir", "--git-dir", "--show-toplevel",
      "--abbrev-ref", "HEAD",
    ]);
    const [commonDirRaw, gitDirRaw, toplevelRaw, ref] = out.split("\n").map((l) => l.trim());
    // Only the first three lines are paths — `ref` is a branch name and must
    // keep its forward slashes (`feature/foo`).
    const [commonDir, gitDir, toplevel] = [commonDirRaw, gitDirRaw, toplevelRaw].map(toNativePath);
    // git prints resolved (symlink-free) paths; normalize cwd the same way
    const realCwd = realPathOrSelf(cwd);
    // For a linked worktree, --git-dir differs from --git-common-dir.
    // Only collapse *worktree toplevels* into the main repo. A session whose
    // cwd is a subdirectory of a repo keeps its own project identity —
    // grouping subdirs under the repo root would change where new sessions
    // are created for existing users. samePath, never `===`: git prints POSIX
    // paths on Windows, where raw equality is always false and hides the
    // worktree switcher.
    const isTopLevel = samePath(toplevel, realCwd);
    const isWorktreeTopLevel = !samePath(gitDir, commonDir) && isTopLevel;
    const topLevelProjectRoot = isWorktreeTopLevel ? dirname(commonDir) : toplevel;
    info = {
      projectRoot: isTopLevel ? realPathOrSelf(topLevelProjectRoot) : cwd,
      isGit: true,
      branch: ref && ref !== "HEAD" ? ref : null,
      isWorktree: isWorktreeTopLevel,
      isTopLevel,
    };
  } catch (error) {
    if (isTransientGitError(error)) throw error;
    info = { projectRoot: cwd, isGit: false, branch: null, isWorktree: false, isTopLevel: false };
  }

  return info;
}

// ============================================================================
// Worktree operations
//
// These take any directory inside the repo (a worktree, the main checkout, or
// a subdirectory) and resolve the main repo root themselves via the git
// common dir, so callers can pass session cwds directly.
// ============================================================================

/** Main repo root (parent of the shared .git dir), or throws for non-git dirs */
async function getRepoRoot(cwd: string): Promise<string> {
  const commonDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return realPathOrSelf(dirname(toNativePath(commonDir)));
}

async function listRawWorktrees(cwd: string): Promise<RawWorktreeRecord[]> {
  const out = await git(cwd, ["worktree", "list", "--porcelain"]);
  const worktrees: RawWorktreeRecord[] = [];
  let current: { path?: string; branch?: string | null; head?: string; prunable?: boolean } | null = null;

  const flush = () => {
    if (current?.path) {
      if (!current.prunable && existsSync(current.path)) {
        worktrees.push({
          path: current.path,
          branch: current.branch ?? null,
          head: current.head ?? "",
          isMain: worktrees.length === 0,
        });
      }
    }
    current = null;
  };

  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: toNativePath(line.slice("worktree ".length).trim()) };
    } else if (line.startsWith("HEAD ") && current) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (line.startsWith("prunable") && current) {
      current.prunable = true;
    } else if (line.trim() === "") {
      flush();
    }
  }
  flush();
  return worktrees;
}

export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  const raw = await listRawWorktrees(cwd);
  return raw.map(({ path, branch, isMain }) => ({ path, branch, isMain }));
}

export async function buildWorktreeGraph(
  cwd: string,
  options?: { forceRefresh?: boolean },
): Promise<WorktreeGraph> {
  const effectiveCwd = existsSync(cwd) ? cwd : (await resolveProject(cwd)).projectRoot;
  const commonDirRaw = await git(effectiveCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const commonDir = toNativePath(commonDirRaw);
  const projectRoot = realPathOrSelf(dirname(commonDir));

  const cache = getGraphCache();
  const cached = cache.get(projectRoot);
  if (
    !options?.forceRefresh
    && cached
    && cached.expiresAt > Date.now()
    // Hot reload can leave a pre-projection graph in the process cache.
    && cached.graph.worktrees.every((worktree) => worktree.dirtySummary !== undefined)
  ) {
    return cached.graph;
  }

  const rawWorktrees = await listRawWorktrees(projectRoot);
  const mainHead = rawWorktrees.find((w) => w.isMain)?.head ?? rawWorktrees[0]?.head ?? "";

  const headSet = new Set<string>();
  if (mainHead) headSet.add(mainHead);
  for (const w of rawWorktrees) {
    if (w.head) headSet.add(w.head);
  }

  let dagLines: string[] = [];
  if (headSet.size > 0) {
    try {
      const dagOut = await git(
        projectRoot,
        ["rev-list", "--parents", "--topo-order", "--max-count=5000", ...headSet],
        15_000,
      );
      dagLines = dagOut.split("\n");
    } catch {
      dagLines = [];
    }
  }

  // Collect main spine commits (up to 300) + all worktree heads/bases for commit metadata lookup
  const parentFirst = new Map<string, string>();
  for (const line of dagLines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] && parts[1]) parentFirst.set(parts[0], parts[1]);
  }
  const lookupShas = new Set<string>(headSet);
  let cur = mainHead;
  let steps = 0;
  while (cur && steps < 400) {
    lookupShas.add(cur);
    const next = parentFirst.get(cur);
    if (!next || lookupShas.size > 1000) break;
    cur = next;
    steps += 1;
  }

  const commitMeta = new Map<string, CommitMetaEntry>();
  const shaList = [...lookupShas].filter(Boolean);
  const CHUNK_SIZE = 200;
  for (let i = 0; i < shaList.length; i += CHUNK_SIZE) {
    const chunk = shaList.slice(i, i + CHUNK_SIZE);
    try {
      const logOut = await git(
        projectRoot,
        ["log", "--no-walk", "--format=%H%x09%ct%x09%cI%x09%an%x09%s", ...chunk],
        10_000,
      );
      for (const row of logOut.split("\n")) {
        if (!row.trim()) continue;
        const [sha, ctStr, isoDate, author, ...subjectParts] = row.split("\t");
        if (!sha) continue;
        commitMeta.set(sha, {
          timestamp: Number.parseInt(ctStr ?? "0", 10) || 0,
          isoDate: isoDate ?? "",
          author: author ?? "",
          subject: subjectParts.join("\t"),
        });
      }
    } catch {
      // Best-effort metadata lookup
    }
  }

  const graph = computeWorktreeGraphFromDag(
    projectRoot,
    rawWorktrees,
    dagLines,
    commitMeta,
  );
  // Status is a separate, read-only projection. Collect it for every
  // registered checkout while building the graph so the list can render WIP
  // counts without issuing one inspect request per row.
  const dirtySummaries = await collectWorktreeDirtySummaries(rawWorktrees);
  const projectedGraph = attachDirtySummaryProjection(graph, dirtySummaries);
  // Resolve GitHub repository when remote exists
  let githubRepository: { owner: string; repo: string } | null = null;
  let githubUrl: string | null = null;
  try {
    const remotes = await getGitRemoteUrls(projectRoot);
    if (remotes && remotes.length > 0) {
      const parsed = selectGitHubRepository(remotes);
      if (parsed) {
        githubRepository = { owner: parsed.owner, repo: parsed.repo };
        githubUrl = `https://github.com/${parsed.owner}/${parsed.repo}`;
      }
    }
  } catch {
    // Best-effort remote lookup
  }
  projectedGraph.githubRepository = githubRepository;
  projectedGraph.githubUrl = githubUrl;

  cache.set(projectRoot, { graph: projectedGraph, expiresAt: Date.now() + WORKTREE_GRAPH_CACHE_TTL_MS });
  return projectedGraph;
}

const SENSITIVE_STATUS_PATH_RE = /(?:^|[\\/])(?:(?:\.env|[^\\/]+\.env)(?:[.][^\\/]*)?|credentials?(?:[-_.][^\\/]*)?|secrets?(?:[-_.][^\\/]*)?|\.npmrc|\.netrc|\.docker(?:config(?:json)?)?|authorized_keys|known_hosts|id_(?:rsa|dsa|ecdsa|ed25519)(?:[.][^\\/]*)?|[^\\/]+\.(?:pem|key|p12|pfx|crt|cer|der|jks|keystore))(?:[\\/]|$)|(?:^|[\\/])[^\\/]*(?:token|secret|password|private[-_]?key|access[-_]?key|api[-_]?key)[^\\/]*$/i;

function redactStatusPath(path: string): string {
  const candidates = path.split(/\s+->\s+/);
  return candidates.some((candidate) => SENSITIVE_STATUS_PATH_RE.test(candidate.replace(/^['"]|['"]$/g, "")))
    ? "[sensitive path omitted]"
    : path;
}

export async function inspectWorktreeNode(
  cwd: string,
  targetWorktreePath: string,
): Promise<WorktreeInspection> {
  const effectiveCwd = existsSync(cwd) ? cwd : (await resolveProject(cwd)).projectRoot;
  const worktrees = await listWorktrees(effectiveCwd);
  const target = findWorktreeByPath(worktrees, realPathOrSelf(targetWorktreePath));
  if (!target) {
    throw new Error(`Not a worktree of this repository: ${targetWorktreePath}`);
  }

  const graph = await buildWorktreeGraph(effectiveCwd);
  const graphItem = graph.worktrees.find((worktree) => samePath(worktree.path, target.path));
  const commitMode: WorktreeInspectionCommitMode = graphItem?.isMain ? "head-history" : "since-base";
  const logArgs = graphItem?.isMain
    ? ["log", "-n", "8", "--format=%H%x09%cI%x09%an%x09%s"]
    : graphItem && graphItem.baseCommit !== graphItem.head
      ? ["log", "-n", "8", "--format=%H%x09%cI%x09%an%x09%s", `${graphItem.baseCommit}..HEAD`]
      : null;
  const [statusOut, logOut] = await Promise.all([
    gitRaw(target.path, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignored=matching"], 8_000),
    logArgs ? git(target.path, logArgs, 8_000) : Promise.resolve(""),
  ]);

  const dirtyEntries = parsePorcelainStatusZ(statusOut).filter((entry) => entry.status !== "!!");
  const dirtyFiles = await Promise.all(
    dirtyEntries.slice(0, 40).map(async (entry) => {
      let mtimeMs: number | undefined;
      const targetRelPath = entry.paths[0];
      if (targetRelPath) {
        try {
          const st = await statAsync(join(target.path, targetRelPath));
          mtimeMs = Math.round(st.mtimeMs);
        } catch {
          // File may be deleted, renamed away, or inaccessible
        }
      }
      return {
        status: entry.status.trim() || "M",
        path: redactStatusPath(entry.paths.join(" -> ")),
        ...(mtimeMs !== undefined ? { mtimeMs } : {}),
      };
    })
  );

  const commits = logOut
    ? logOut
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((row) => {
          const [sha, isoDate, author, ...subjectParts] = row.split("\t");
          return {
            sha: sha ?? "",
            shortSha: (sha ?? "").slice(0, 8),
            isoDate: isoDate ?? "",
            author: author ?? "",
            subject: subjectParts.join("\t"),
          };
        })
    : [];

  return {
    path: target.path,
    dirtyCount: dirtyEntries.length,
    dirtyFiles,
    commitMode,
    commits,
  };
}

function findWorktreeByPath(worktrees: readonly WorktreeInfo[], candidate: string): WorktreeInfo | undefined {
  return worktrees.find((worktree) => samePath(worktree.path, candidate));
}

export function findCurrentWorktreePath(worktrees: readonly WorktreeInfo[], cwd: string): string | null {
  return findWorktreeByPath(worktrees, realPathOrSelf(cwd))?.path ?? null;
}

function sanitizeBranchForDir(branch: string): string {
  return branch.replace(/[\/\\:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function addWorktree(cwd: string, branch: string): Promise<{ path: string; branch: string }> {
  const trimmed = branch.trim();
  if (!trimmed) throw new Error("Branch name is required");

  const dirName = sanitizeBranchForDir(trimmed);
  if (!dirName || dirName === "." || dirName === "..") throw new Error(`Invalid branch name: ${branch}`);

  const repoRoot = await getRepoRoot(cwd);
  const baseDir = join(repoRoot, ".worktrees");
  if (lstatSync(baseDir, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(".worktrees must be a physical directory, not a symbolic link");
  }
  // The project owns its ignore policy; creating a checkout never edits it.
  try {
    await git(repoRoot, ["check-ignore", "--quiet", "--", ".worktrees/"]);
  } catch (error) {
    if ((error as { code?: unknown }).code !== 1) throw error;
    throw new Error("Add /.worktrees/ to the project root .gitignore before creating a worktree");
  }
  const worktreePath = join(baseDir, dirName);
  if (existsSync(worktreePath)) {
    throw new Error(`Directory already exists: ${worktreePath}`);
  }
  mkdirSync(baseDir, { recursive: true });

  // Reuse the branch if it already exists, otherwise create it (from the
  // already-fetched remote tip when available, else local HEAD). We do not
  // fetch here: worktree creation must stay a local, offline-safe operation.
  let branchExists = false;
  try {
    await git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${trimmed}`]);
    branchExists = true;
  } catch {
    branchExists = false;
  }

  try {
    // Large repos (30k+ files) can take minutes to checkout.
    const WORKTREE_TIMEOUT = 5 * 60_000;
    if (branchExists) {
      await git(repoRoot, ["worktree", "add", "--", worktreePath, trimmed], WORKTREE_TIMEOUT);
    } else {
      // New branch: prefer the remote-tracking tip (refs/remotes/origin/<branch>)
      // over local HEAD when the user already fetched it; fall back to HEAD.
      let startFrom: string | undefined;
      try {
        await git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${trimmed}`]);
        startFrom = `refs/remotes/origin/${trimmed}`;
      } catch {
        startFrom = undefined;
      }
      const addArgs = ["worktree", "add", "-b", trimmed, "--", worktreePath];
      if (startFrom) addArgs.push(startFrom);
      await git(repoRoot, addArgs, WORKTREE_TIMEOUT);
    }
  } catch (error) {
    throw new Error(extractGitError(error));
  }

  allowFileRoot(worktreePath);
  invalidateProjectCache();
  return { path: worktreePath, branch: trimmed };
}

export async function removeWorktree(cwd: string, worktreePath: string, force = false): Promise<void> {
  const worktrees = await listWorktrees(cwd);
  // Git reports worktrees by their real path; the caller's may run through a link
  // (macOS's /var and /tmp are links to /private/...).
  const target = findWorktreeByPath(worktrees, realPathOrSelf(worktreePath));
  if (!target) throw new Error(`Not a worktree of this repository: ${worktreePath}`);
  if (target.isMain) throw new Error("Cannot remove the main worktree");

  try {
    await git(cwd, ["worktree", "remove", ...(force ? ["--force"] : []), target.path]);
  } catch (error) {
    throw new Error(extractGitError(error));
  }
  invalidateProjectCache();
}

/** Rename the branch checked out in a linked worktree; its directory and sessions stay where they are. */
export async function renameWorktreeBranch(cwd: string, worktreePath: string, newBranch: string): Promise<{ path: string; branch: string }> {
  const trimmed = newBranch.trim();
  if (!trimmed) throw new Error("Branch name is required");
  const worktrees = await listWorktrees(cwd);
  const target = findWorktreeByPath(worktrees, realPathOrSelf(worktreePath));
  if (!target) throw new Error(`Not a worktree of this repository: ${worktreePath}`);
  if (target.isMain) throw new Error("Cannot rename the main worktree's branch");
  if (!target.branch) throw new Error("The worktree has a detached HEAD; there is no branch to rename");
  if (target.branch === trimmed) return { path: target.path, branch: trimmed };
  try {
    await git(target.path, ["branch", "-m", "--", target.branch, trimmed]);
  } catch (error) {
    throw new Error(extractGitError(error));
  }
  invalidateProjectCache();
  return { path: target.path, branch: trimmed };
}

/**
 * Git refuses to remove a dirty worktree, or one containing initialized
 * submodules, without --force. A locked worktree needs a double force and is
 * deliberately not matched: offering a single force there would just fail.
 */
export function worktreeRemovalRequiresForce(message: string): boolean {
  return worktreeHasUncommittedFiles(message) || /containing submodules/i.test(message);
}

/** The refusal is about modified or untracked files, not initialized submodules. */
export function worktreeHasUncommittedFiles(message: string): boolean {
  return /contains modified or untracked files|is dirty/i.test(message);
}

function extractGitError(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr;
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  return error instanceof Error ? error.message : String(error);
}
