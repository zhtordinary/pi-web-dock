import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { isWindowsAbsolutePath } from "@/lib/paths";
import { hasParentDirectorySegment } from "@/lib/path-security";
import { buildEntriesFromFiles, filterFileEntries, type FileIndexEntry } from "@/lib/file-fuzzy";
import { isAlwaysHiddenPath, isHiddenOutsideGit } from "@/lib/file-tree-visibility";

const execFileAsync = promisify(execFile);

/** Cap on the plain (no-query) response used as the client-side index */
const MAX_FILES = 5000;
/** Hard caps on the full in-memory listing that ?q= searches against */
const GIT_HARD_CAP = 200_000;
const WALK_HARD_CAP = 50_000;
const MAX_WALK_DIRECTORIES = 2_000;
const MAX_WALK_MS = 1_500;
const MAX_WALK_DEPTH = 8;
const MAX_QUERY_LENGTH = 500;
const CACHE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 20;

interface FileListing {
  /** Full listing up to the hard cap (not the client cap) */
  files: string[];
  /** True when even the hard cap was exceeded */
  hardTruncated: boolean;
}

interface CacheEntry {
  listing: FileListing;
  /** Derived lazily on the first ?q= search against this listing */
  entries?: FileIndexEntry[];
  expiresAt: number;
}

// Per-cwd cache on globalThis so it survives Next.js hot-reload; the @ menu
// re-requests on every open and searches on every keystroke, so listings must
// not be recomputed within a short window.
declare global {
  var __piFileIndexCache: Map<string, CacheEntry> | undefined;
}

function getIndexCache(): Map<string, CacheEntry> {
  if (!globalThis.__piFileIndexCache) globalThis.__piFileIndexCache = new Map();
  return globalThis.__piFileIndexCache;
}

async function listWithGit(cwd: string, hideGitIgnored: boolean): Promise<FileListing | null> {
  try {
    const ignoreArgs = hideGitIgnored ? ["--exclude-standard"] : [];
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", ...ignoreArgs, "-z"],
      { timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
    );
    const all = stdout.split("\0").filter((file) => file && !isAlwaysHiddenPath(file));
    if (all.length > GIT_HARD_CAP) {
      return { files: all.slice(0, GIT_HARD_CAP), hardTruncated: true };
    }
    return { files: all, hardTruncated: false };
  } catch {
    // Not a git repo (or git unavailable) — caller falls back to readdir walk.
    return null;
  }
}

async function listWithWalk(cwd: string): Promise<FileListing> {
  const files: string[] = [];
  const started = Date.now();
  let truncated = false;
  // BFS so shallow files win when the cap truncates the listing.
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: cwd, rel: "", depth: 0 }];
  for (let index = 0; index < queue.length; index++) {
    if (Date.now() - started > MAX_WALK_MS) return { files, hardTruncated: true };
    if (index > 0 && index % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    const { abs, rel, depth } = queue[index];
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      // The file tree's name list, only for this non-git fallback. Git repos
      // rely on .gitignore instead (matches the TUI's fd behavior).
      if (isHiddenOutsideGit(d.name, childRel)) continue;
      if (d.isDirectory()) {
        if (depth + 1 <= MAX_WALK_DEPTH) {
          if (queue.length >= MAX_WALK_DIRECTORIES) truncated = true;
          else queue.push({ abs: path.join(abs, d.name), rel: childRel, depth: depth + 1 });
        }
      } else if (d.isFile()) {
        if (files.length >= WALK_HARD_CAP) {
          return { files, hardTruncated: true };
        }
        files.push(childRel);
      }
    }
  }
  return { files, hardTruncated: truncated };
}

// GET /api/file-index?cwd=/abs/path[&q=query][&hideGitIgnored=1]
// Without q: { files: string[] (relative to cwd, capped at MAX_FILES),
// truncated: boolean } — the client-side index for local filtering.
// With q: { matches: { path, isDir }[] } — ranked against the FULL listing so
// repos larger than MAX_FILES still find deep files (cap applied after
// matching, like the TUI passing the query to fd).
export async function GET(req: NextRequest) {
  try {
    const cwd = req.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd)) || hasParentDirectorySegment(cwd)) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }
    const query = req.nextUrl.searchParams.get("q")?.slice(0, MAX_QUERY_LENGTH) ?? "";
    const limitParam = Number.parseInt(req.nextUrl.searchParams.get("limit") ?? "", 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : undefined;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return NextResponse.json({ error: "Directory not found" }, { status: 404 });
    }
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Not a directory" }, { status: 400 });
    }
    const hideGitIgnored = req.nextUrl.searchParams.get("hideGitIgnored") === "1";
    const cacheKey = `${cwd}\0${hideGitIgnored ? "hide-ignored" : "show-ignored"}`;
    const cache = getIndexCache();
    const now = Date.now();
    let cached = cache.get(cacheKey);
    if (!cached || cached.expiresAt <= now) {
      const listing = (await listWithGit(cwd, hideGitIgnored)) ?? await listWithWalk(cwd);
      for (const [key, entry] of cache) {
        if (entry.expiresAt <= now) cache.delete(key);
      }
      if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
      cached = { listing, expiresAt: now + CACHE_TTL_MS };
      cache.set(cacheKey, cached);
    }

    if (query) {
      cached.entries ??= buildEntriesFromFiles(cached.listing.files);
      const matches = limit === undefined
        ? filterFileEntries(cached.entries, query)
        : filterFileEntries(cached.entries, query, limit);
      return NextResponse.json({ matches });
    }

    const { files, hardTruncated } = cached.listing;
    return NextResponse.json({
      files: files.slice(0, MAX_FILES),
      truncated: hardTruncated || files.length > MAX_FILES,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
