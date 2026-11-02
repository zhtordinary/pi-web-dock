import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";
import type {
  GitCommitDetail,
  GitCommitFile,
  GitCommitSummary,
  GitRemoteInfo,
  GitFileDiffResponse,
  GitFileStatus,
  GitStatusResponse,
} from "./git-types";
import {
  classifyGitStatus,
  parseGitPorcelainV1,
  type GitPorcelainEntry,
} from "./git-status";
import { hasParentDirectorySegment } from "./path-security";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_STATUS_MAX_BUFFER = 8 * 1024 * 1024;

async function git(cwd: string, args: string[], maxBuffer = GIT_STATUS_MAX_BUFFER): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

async function findRepositoryRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Git reports physical paths on macOS (for example /private/var), while a
 * caller may retain the /var alias returned by os.tmpdir(). Use the physical
 * cwd for containment and diff pathspec checks so aliases do not hide valid
 * changes or make a real repository look outside the selected directory.
 */
function physicalPath(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

async function readGitInfo(repositoryRoot: string): Promise<Pick<GitStatusResponse, "branch" | "upstream" | "ahead" | "behind">> {
  const [branchResult, upstreamResult] = await Promise.all([
    git(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then((value) => value.trim() || null).catch(() => null),
    git(repositoryRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).then((value) => value.trim() || null).catch(() => null),
  ]);
  let ahead = 0;
  let behind = 0;
  if (upstreamResult) {
    try {
      const [aheadText, behindText] = (await git(repositoryRoot, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])).trim().split(/\s+/);
      ahead = Number.parseInt(aheadText || "0", 10) || 0;
      behind = Number.parseInt(behindText || "0", 10) || 0;
    } catch {
      // Keep the branch status usable when the upstream is stale or unavailable.
    }
  }
  return { branch: branchResult, upstream: upstreamResult, ahead, behind };
}

const GIT_HISTORY_MAX_LIMIT = 30;
const GIT_COMMIT_HASH_RE = /^[0-9a-f]{7,64}$/i;

function parseGitCommitRecord(record: string): GitCommitSummary | null {
  const fields = record.trim().split("\0");
  if (fields.length < 6) return null;
  const [hash, shortHash, author, authoredAt, subject, refs] = fields;
  if (!GIT_COMMIT_HASH_RE.test(hash) || !shortHash || !subject) return null;
  return {
    hash,
    shortHash,
    author,
    authoredAt,
    subject,
    refs: refs ? refs.split(",").map((ref) => ref.trim()).filter(Boolean) : [],
  };
}

export function parseGitLog(output: string): GitCommitSummary[] {
  return output
    .split("\x1e")
    .map(parseGitCommitRecord)
    .filter((commit): commit is GitCommitSummary => commit !== null);
}

function parseCommitFiles(output: string): GitCommitFile[] {
  return output.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const fields = line.split("\t");
    const rawStatus = fields.shift()?.trim() ?? "";
    const filePath = fields.pop()?.trim() ?? "";
    if (!rawStatus || !filePath) return [];
    const isRename = rawStatus.startsWith("R") && fields.length > 0;
    return [{
      path: filePath,
      status: rawStatus,
      ...(isRename ? { originalPath: fields[0].trim() } : {}),
    }];
  });
}

export async function getGitRemoteUrls(cwd: string): Promise<GitRemoteInfo[] | null> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot) return null;
  try {
    const output = await git(repositoryRoot, ["remote", "-v"]);
    const seen = new Set<string>();
    return output.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
      if (!match || seen.has(match[1])) return [];
      seen.add(match[1]);
      return [{ name: match[1], url: match[2] }];
    });
  } catch {
    return [];
  }
}

export async function getGitHead(cwd: string): Promise<string | null> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot) return null;
  try {
    const head = (await git(repositoryRoot, ["rev-parse", "HEAD"])).trim();
    return /^[0-9a-f]{40}$/i.test(head) ? head : null;
  } catch {
    return null;
  }
}

export async function getGitHistory(cwd: string, limit = 20): Promise<GitCommitSummary[] | null> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot) return null;
  const safeLimit = Math.max(1, Math.min(GIT_HISTORY_MAX_LIMIT, Math.floor(limit) || 20));
  try {
    const output = await git(repositoryRoot, [
      "log",
      `--max-count=${safeLimit}`,
      "--date=iso-strict",
      "--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%D%x1e",
    ]);
    return parseGitLog(output);
  } catch {
    return [];
  }
}

export async function getGitCommitDetail(cwd: string, hash: string): Promise<GitCommitDetail | null> {
  if (!GIT_COMMIT_HASH_RE.test(hash)) return null;
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot) return null;
  try {
    const [header, files] = await Promise.all([
      git(repositoryRoot, [
        "show",
        "--quiet",
        `--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%D`,
        hash,
      ]),
      git(repositoryRoot, [
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--name-status",
        "--find-renames",
        "-r",
        hash,
        "--",
      ]),
    ]);
    const summary = parseGitCommitRecord(header);
    if (!summary) return null;
    return { ...summary, files: parseCommitFiles(files) };
  } catch {
    return null;
  }
}

function isWithinPath(parent: string, target: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Resolve a requested target using physical parents. A deleted Git file has no
 * final inode, so walk to its nearest existing ancestor and append only the
 * missing non-link segments. This binds both live and deleted targets to the
 * same physical repository root without trusting string prefixes.
 */
function physicalGitTarget(repositoryRoot: string, filePath: string): string | null {
  if (hasParentDirectorySegment(filePath)) return null;

  let cursor = path.resolve(filePath);
  const missingSegments: string[] = [];
  while (true) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      const parent = path.dirname(cursor);
      if (parent === cursor) return null;
      missingSegments.unshift(path.basename(cursor));
      cursor = parent;
      continue;
    }

    // A symlink component is never an authorized Git target, even when it
    // happens to point back inside the repository. This also catches a link
    // whose target was replaced between lexical validation and Git access.
    if (stat.isSymbolicLink()) return null;
    const physicalCursor = physicalPath(cursor);
    if (!physicalCursor || !isWithinPath(repositoryRoot, physicalCursor)) return null;
    if (missingSegments.length > 0 && !stat.isDirectory()) return null;

    const physicalTarget = path.join(physicalCursor, ...missingSegments);
    return isWithinPath(repositoryRoot, physicalTarget) ? physicalTarget : null;
  }
}

function toGitPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

async function readStatusEntries(
  repositoryRoot: string,
  gitConfig: readonly string[] = [],
): Promise<GitPorcelainEntry[]> {
  const output = await git(repositoryRoot, [
    ...gitConfig,
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  return parseGitPorcelainV1(output);
}

async function readTrackedLineStats(
  repositoryRoot: string,
  cwd: string,
): Promise<{ additions: number; deletions: number }> {
  const relativeCwd = toGitPath(path.relative(repositoryRoot, cwd));
  const pathspec = relativeCwd || ".";
  try {
    const output = await git(repositoryRoot, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--numstat",
      "HEAD",
      "--",
      pathspec,
    ]);
    let additions = 0;
    let deletions = 0;
    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      const [added, deleted] = line.split("\t", 2);
      const addedCount = Number(added);
      const deletedCount = Number(deleted);
      if (Number.isInteger(addedCount)) additions += addedCount;
      if (Number.isInteger(deletedCount)) deletions += deletedCount;
    }
    return { additions, deletions };
  } catch {
    return { additions: 0, deletions: 0 };
  }
}

function countUntrackedTextLines(filePath: string): number {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size > TEXT_PREVIEW_MAX_BYTES) return 0;
    const content = fs.readFileSync(filePath);
    if (hasNullByte(content) || content.length === 0) return 0;
    const text = content.toString("utf8");
    return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
  } catch {
    return 0;
  }
}

export async function getGitStatus(cwd: string): Promise<GitStatusResponse> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot) {
    return {
      isGitRepository: false,
      repositoryRoot: null,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [],
      additions: 0,
      deletions: 0,
    };
  }

  const physicalCwd = physicalPath(cwd);

  const [entries, trackedLineStats, gitInfo] = await Promise.all([
    readStatusEntries(repositoryRoot),
    physicalCwd
      ? readTrackedLineStats(repositoryRoot, physicalCwd)
      : Promise.resolve({ additions: 0, deletions: 0 }),
    readGitInfo(repositoryRoot),
  ]);
  const files = entries.flatMap((entry): GitFileStatus[] => {
    if (!physicalCwd) return [];
    const filePath = path.resolve(repositoryRoot, entry.path);
    if (!isWithinPath(physicalCwd, filePath)) return [];
    const classified = classifyGitStatus(entry);
    return [{
      filePath,
      ...classified,
      indexStatus: entry.indexStatus,
      worktreeStatus: entry.worktreeStatus,
    }];
  });
  const untrackedAdditions = files.reduce(
    (total, file) => total + (file.status === "untracked" ? countUntrackedTextLines(file.filePath) : 0),
    0,
  );

  return {
    isGitRepository: true,
    repositoryRoot,
    ...gitInfo,
    files,
    additions: trackedLineStats.additions + untrackedAdditions,
    deletions: trackedLineStats.deletions,
  };
}

function hasNullByte(content: Buffer): boolean {
  return content.includes(0);
}

function createAddedFilePatch(gitPath: string, content: string): string {
  const hasTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hasTrailingNewline) lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  const noNewlineMarker = !hasTrailingNewline && lines.length > 0
    ? "\n\\ No newline at end of file"
    : "";
  return [
    `diff --git a/${gitPath} b/${gitPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${gitPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    `${body}${noNewlineMarker}`,
  ].join("\n");
}

async function createTrackedFilePatch(
  repositoryRoot: string,
  relativePath: string,
  originalPath?: string,
  gitConfig: readonly string[] = [],
): Promise<string | null> {
  const paths = originalPath && originalPath !== relativePath
    ? [originalPath, relativePath]
    : [relativePath];
  try {
    return await git(repositoryRoot, [
      ...gitConfig,
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--unified=3",
      "HEAD",
      "--",
      ...paths,
    ], TEXT_PREVIEW_MAX_BYTES * 4);
  } catch {
    return null;
  }
}

// The file's own repository, not the cwd's: a session may start in a plain folder
// holding several repositories. A deleted file's folder may be gone too, so start
// from its nearest existing ancestor; fall back to the cwd.
async function findFileRepositoryRoot(cwd: string, filePath: string): Promise<string | null> {
  let directory = path.dirname(path.resolve(filePath));
  while (!fs.existsSync(directory)) {
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return (await findRepositoryRoot(directory)) ?? (await findRepositoryRoot(cwd));
}

export async function getGitFileDiff(cwd: string, filePath: string): Promise<GitFileDiffResponse> {
  const repositoryRoot = await findFileRepositoryRoot(cwd, filePath);
  if (!repositoryRoot) return { supported: false };

  const physicalRepositoryRoot = physicalPath(repositoryRoot);
  const physicalCwd = physicalPath(cwd);
  if (!physicalRepositoryRoot) return { supported: false };

  // Reading the index runs a repository-configured fsmonitor hook. Opening a
  // file in another checkout (one nested in the cwd, say) must not run its hook,
  // as expanding that folder in the file tree does not (lib/file-tree-visibility.ts);
  // the cwd's own repository keeps its fsmonitor.
  const gitConfig = (physicalCwd && isWithinPath(physicalRepositoryRoot, physicalCwd))
    ? []
    : ["-c", "core.fsmonitor=false"];

  const resolvedFilePath = physicalGitTarget(physicalRepositoryRoot, filePath);
  if (!resolvedFilePath) return { supported: false };
  const relativePath = toGitPath(path.relative(physicalRepositoryRoot, resolvedFilePath));
  const entries = await readStatusEntries(physicalRepositoryRoot, gitConfig);
  const entry = entries.find((candidate) => candidate.path === relativePath);
  if (!entry) return { supported: false };

  const { status } = classifyGitStatus(entry);
  if (status === "deleted") {
    const patch = await createTrackedFilePatch(physicalRepositoryRoot, relativePath, entry.originalPath, gitConfig);
    if (!patch?.includes("\n@@ ")) return { supported: false };
    return { supported: true, status, patch };
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolvedFilePath);
  } catch {
    return { supported: false };
  }
  if (!stat.isFile() || stat.size > TEXT_PREVIEW_MAX_BYTES) return { supported: false };

  const currentBuffer = fs.readFileSync(resolvedFilePath);
  if (hasNullByte(currentBuffer)) return { supported: false };
  const newContent = currentBuffer.toString("utf8");

  let patch: string;
  if (status === "untracked") {
    patch = createAddedFilePatch(relativePath, newContent);
  } else {
    const trackedPatch = await createTrackedFilePatch(physicalRepositoryRoot, relativePath, entry.originalPath, gitConfig);
    if (trackedPatch === null) {
      if (status !== "added") return { supported: false };
      patch = createAddedFilePatch(relativePath, newContent);
    } else {
      patch = trackedPatch;
    }
  }

  if (!patch.includes("\n@@ ")) return { supported: false };
  return { supported: true, status, patch };
}
