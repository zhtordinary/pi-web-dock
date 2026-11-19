import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path, { basename, relative, resolve } from "node:path";

const MAX_PROJECT_IDENTITY_CACHE_ENTRIES = 512;
const cache = new Map<string, { key: string; label: string }>();

function cacheIdentity(root: string, identity: { key: string; label: string }): void {
  cache.delete(root);
  cache.set(root, identity);
  while (cache.size > MAX_PROJECT_IDENTITY_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function getProjectIdentity(root: string): { key: string; label: string } {
  const normalizedRoot = root || ".";
  const cached = cache.get(normalizedRoot);
  if (cached) return cached;

  const remote = readGitRemote(normalizedRoot);
  if (remote) {
    const key = `git:${createHash("sha256").update(remote).digest("hex").slice(0, 16)}`;
    const label = remote
      .replace(/\.git(?:$|[?#])/i, "")
      .split(/[/:]/)
      .filter(Boolean)
      .pop() ?? basename(normalizedRoot);
    const identity = { key, label };
    cacheIdentity(normalizedRoot, identity);
    return identity;
  }

  const workspaceRoot = process.env.PI_WEB_WORKSPACE_ROOT || process.env.HOME || ".";
  const workspacePath = relative(workspaceRoot, normalizedRoot) || ".";
  const identity = { key: `path:${workspacePath}`, label: basename(normalizedRoot) || workspacePath };
  cacheIdentity(normalizedRoot, identity);
  return identity;
}

/**
 * Project keys written by different Reader generations. Keep path identity as
 * the current key, while accepting tagged paths and the legacy Git identity
 * when the project is available for resolution.
 */
export function projectIdentityKeys(input: string, platform: NodeJS.Platform = process.platform): string[] {
  const value = input.trim();
  if (!value) return [];
  const rootInput = value.startsWith("path:") ? value.slice("path:".length) : value;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const root = value.startsWith("path:") && !pathApi.isAbsolute(rootInput)
    ? resolve(process.env.PI_WEB_WORKSPACE_ROOT ?? process.env.HOME ?? ".", rootInput)
    : resolve(rootInput);
  const keys = new Set([value]);
  if (platform === "win32" && pathApi.isAbsolute(rootInput)) {
    // Root-relative paths must resolve to the current drive before comparison.
    const normalized = projectIdentityKey(pathApi.resolve(rootInput), platform);
    keys.add(value.startsWith("path:") ? `path:${normalized}` : normalized);
  }
  if (!existsSync(root)) return [...keys];
  keys.add(root);
  const pathKey = projectIdentityKey(root, platform);
  keys.add(pathKey);
  keys.add(`path:${pathKey}`);
  keys.add(getProjectIdentity(root).key);
  return [...keys];
}

function readGitRemote(root: string): string | null {
  try {
    const remote = execFileSync("git", ["-C", root, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1200,
    }).trim();
    if (!remote) return null;
    return remote
      .replace(/(https?:\/\/)([^/@]+):([^/@]+)@/i, "$1")
      .replace(/(ssh:\/\/)([^/@]+)@/i, "$1");
  } catch {
    return null;
  }
}

/**
 * Stable, internal identity for a project path.
 *
 * Keep the original cwd/projectRoot for display and filesystem operations.
 * This key is only for grouping and equality: Windows paths are normalized
 * with win32 rules and case-folded because the default Windows filesystem is
 * case-insensitive. The explicit platform argument keeps those semantics
 * testable on non-Windows CI.
 */
export function projectIdentityKey(
  projectRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!projectRoot) return projectRoot;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const filesystemRoot = platform === "darwin"
    ? (() => {
        try { return realpathSync.native(projectRoot); } catch { return projectRoot; }
      })()
    : projectRoot;
  const normalized = pathApi.normalize(filesystemRoot);
  const rootLength = pathApi.parse(normalized).root.length;
  let end = normalized.length;
  while (end > rootLength && normalized[end - 1] === pathApi.sep) end--;
  const withoutTrailingSeparators = normalized.slice(0, end);
  return platform === "win32"
    ? withoutTrailingSeparators.toLowerCase()
    : withoutTrailingSeparators;
}
