import { execFile } from "child_process";

// ============================================================================
// Which directory entries the file tree lists.
//
// Inside a Git work tree the repository can optionally decide: when the
// project filter asks to hide ignored entries, an entry is hidden only when
// Git ignores it, so a tracked `build/` or `dist/` stays browsable (#677).
// The default is to show Git-ignored entries. Where Git has no view of a
// directory, a fixed list of conventionally generated names stands in for a
// .gitignore. It includes the local Reader output paths from the repository's
// .gitignore without hiding the whole `.pi` tree or every directory named
// `messenger`. `.git` and Finder's `.DS_Store` are hidden either way, as in
// VS Code's default excludes.
//
// This is visibility only. Hidden entries stay readable through /api/files,
// which authorizes by allowed root and never consults this module.
// ============================================================================

const HIDDEN_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".archify", ".build", ".ruff_cache", ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store",
]);

const HIDDEN_SUFFIXES = [".pyc", ".pyo", ".pyd"];
const PI_GENERATED_CHILDREN = new Set(["messenger", "task-plans-by-plan-execute"]);

// Never worth listing, whatever a repository says about them.
const ALWAYS_HIDDEN_NAMES = new Set([".git", ".DS_Store"]);

/** Fixed safety exclusions that no project filter can reveal. */
export function isAlwaysHiddenName(name: string): boolean {
  return ALWAYS_HIDDEN_NAMES.has(name);
}

/** Fixed safety exclusions for a relative file-index path. */
export function isAlwaysHiddenPath(relativePath: string): boolean {
  const normalizedPath = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalizedPath.split("/").some((part) => isAlwaysHiddenName(part));
}

// The listing waits on git, so a slow one degrades to the name list rather
// than stalling the tree.
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
// Stays well inside Windows' 32K command line when names go to ls-files.
const MAX_PATHSPEC_CHARS = 16_000;

/**
 * The fallback rule for paths no Git work tree covers.
 *
 * `relativePath` is optional because the file tree normally has only one
 * directory-entry name. The `.pi` paths are deliberately checked as a pair:
 * `.pi` and an unrelated `messenger` directory remain browsable.
 */
export function isHiddenOutsideGit(name: string, relativePath = name): boolean {
  if (HIDDEN_NAMES.has(name) || HIDDEN_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  const normalizedPath = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  const pathParts = normalizedPath.split("/");
  return pathParts.length >= 2
    && pathParts.at(-2) === ".pi"
    && PI_GENERATED_CHILDREN.has(pathParts.at(-1) ?? "");
}

// Reading the index runs a repository-configured fsmonitor hook, and expanding
// a folder (a nested checkout, say) must not execute commands.
const GIT_SAFE_CONFIG = ["-c", "core.fsmonitor=false"];

/** Run git in `directory`; null when it is missing, fails or times out. */
function runGit(
  directory: string,
  args: readonly string[],
  input?: string,
  okExitCodes: readonly number[] = [0],
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      ["-C", directory, ...GIT_SAFE_CONFIG, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: { ...process.env, LC_ALL: "C" } },
      (error, stdout) => {
        const exitCode = error && typeof error.code === "number" ? error.code : error ? null : 0;
        resolve(exitCode !== null && okExitCodes.includes(exitCode) ? stdout : null);
      },
    );
    // Outside a repository git exits without reading its input; the resulting
    // EPIPE must not surface as an unhandled stream error.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
}

/** Group names into ls-files argument lists that stay under the size limit. */
function pathspecBatches(names: readonly string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let size = 0;
  for (const name of names) {
    if (batch.length > 0 && size + name.length + 1 > MAX_PATHSPEC_CHARS) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(name);
    size += name.length + 1;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * Which of `names` hold something Git tracks: the name itself or any path
 * below it. Null when git fails.
 */
async function readTrackedNames(directory: string, names: readonly string[]): Promise<Set<string> | null> {
  const tracked = new Set<string>();
  for (const batch of pathspecBatches(names)) {
    // `--literal-pathspecs` keeps `*`, `[id]` and a leading `:(` literal.
    // ls-files starts from the index range under `directory`, so the cost
    // follows what is tracked below it, not the whole repository.
    const stdout = await runGit(directory, ["--literal-pathspecs", "ls-files", "-z", "--cached", "--", ...batch]);
    if (stdout === null) return null;
    for (const record of stdout.split("\0")) {
      if (record) tracked.add(record.split("/", 1)[0]);
    }
  }
  return tracked;
}

/**
 * Ask Git which of `names` (entries of `directory`) it ignores.
 *
 * `git check-ignore --no-index` matches every name against the ignore files
 * in one process without reading the index. Asking it with the index instead
 * scans the whole index once per name, which took seconds for a large folder
 * in a large repository. Ignoring never applies to what Git tracks, so a
 * matched name is shown after all when `git ls-files` finds a tracked path at
 * or below it: a tracked `build/`, or an ignored directory with a force-added
 * file. Only bare names cross the process boundary, so git's POSIX-style
 * paths never need converting back.
 *
 * Resolves null when Git has no view of `directory`: outside a work tree
 * (including inside `.git`), when git is missing, fails or times out, and when
 * `directory` is itself ignored with nothing tracked below it. That last case
 * is a scratch directory under a repository that ignores `*`, which would
 * otherwise list as empty.
 */
export async function readGitIgnoredNames(
  directory: string,
  names: readonly string[],
): Promise<Set<string> | null> {
  // `./` keeps a name such as `:(glob)x` from parsing as pathspec magic, which
  // check-ignore rejects for the whole batch. `.` asks about `directory`.
  const input = [".", ...names.map((name) => `./${name}`)]
    .map((entry) => `${entry}\0`)
    .join("");
  // Exit status 1 means nothing is ignored: an answer, not a failure.
  const stdout = await runGit(directory, ["check-ignore", "--no-index", "-z", "--stdin"], input, [0, 1]);
  if (stdout === null) return null;

  let directoryIgnored = false;
  const matched: string[] = [];
  for (const record of stdout.split("\0")) {
    if (record === ".") directoryIgnored = true;
    else if (record.startsWith("./")) matched.push(record.slice(2));
  }
  if (matched.length === 0) return directoryIgnored ? null : new Set();

  const tracked = await readTrackedNames(directory, matched);
  if (tracked === null || (directoryIgnored && tracked.size === 0)) return null;
  return new Set(matched.filter((name) => !tracked.has(name)));
}

function fallbackRelativePath(directory: string, name: string): string {
  const normalizedDirectory = directory.replace(/[\\/]+$/, "");
  const parent = normalizedDirectory.split(/[\\/]/).at(-1);
  return parent === ".pi" ? `.pi/${name}` : name;
}

/** Return Git visibility, or null when this directory is outside Git. */
export async function getGitFileTreeVisibility(
  directory: string,
  names: readonly string[],
  hideGitIgnored = false,
): Promise<((name: string) => boolean) | null> {
  if (!hideGitIgnored) {
    const isWorkTree = await runGit(directory, ["rev-parse", "--is-inside-work-tree"]);
    if (isWorkTree?.trim() !== "true") return null;
    return (name) => !isAlwaysHiddenName(name);
  }

  const ignored = await readGitIgnoredNames(directory, names.filter((name) => !isAlwaysHiddenName(name)));
  if (!ignored) return null;
  return (name) => !isAlwaysHiddenName(name) && !ignored.has(name);
}

/** Build the visibility test for one listing of `directory`. */
export async function getFileTreeVisibility(
  directory: string,
  names: readonly string[],
  hideGitIgnored = false,
  respectUserFilter = false,
): Promise<(name: string) => boolean> {
  if (respectUserFilter) {
    if (!hideGitIgnored) return () => true;
    const ignored = await readGitIgnoredNames(directory, names);
    return ignored ? (name) => !ignored.has(name) : () => true;
  }
  const gitVisibility = await getGitFileTreeVisibility(directory, names, hideGitIgnored);
  if (gitVisibility) return gitVisibility;
  return (name) => !isHiddenOutsideGit(name, fallbackRelativePath(directory, name));
}
