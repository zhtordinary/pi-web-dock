import { open, readdir } from "node:fs/promises";
import { existsSync, openSync, closeSync, readSync } from "node:fs";
import type { Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** True for pi-subagents' persisted child shape, not ordinary session forks. */
export function isPiSubagentSessionPath(parentPath: string, childPath: string): boolean {
  const root = parentPath.endsWith(".jsonl") ? parentPath.slice(0, -".jsonl".length) : "";
  if (!root) return false;
  const parts = relative(root, childPath).split(sep);
  if (parts.length < 3 || parts.at(-1) !== "session.jsonl") return false;
  let index = 0;
  while (index + 1 < parts.length - 1) {
    if (!parts[index] || !/^run-\d+$/.test(parts[index + 1])) return false;
    index += 2;
    if (index === parts.length - 1) return true;
    if (parts[index] !== "session") return false;
    index += 1;
  }
  return false;
}

export interface PiSessionRoots {
  sessionsDir: string;
  archivedSessionsDir: string;
}

type SessionRootScope = "active" | "archived";

function pathInside(path: string, root: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child !== "" && !child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child);
}

function scopeOf(path: string, roots: PiSessionRoots): SessionRootScope | undefined {
  if (pathInside(path, roots.sessionsDir)) return "active";
  if (pathInside(path, roots.archivedSessionsDir)) return "archived";
  return undefined;
}

function pathInScope(path: string, scope: SessionRootScope, roots: PiSessionRoots): string | undefined {
  const sourceScope = scopeOf(path, roots);
  if (!sourceScope) return undefined;
  const sourceRoot = sourceScope === "active" ? roots.sessionsDir : roots.archivedSessionsDir;
  const targetRoot = scope === "active" ? roots.sessionsDir : roots.archivedSessionsDir;
  return join(targetRoot, relative(sourceRoot, path));
}

function readParentSessionPath(filePath: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.toString("utf8", 0, bytes);
    const newline = text.indexOf("\n");
    if (newline < 0 && bytes === buffer.length) return undefined;
    const header = JSON.parse((newline < 0 ? text : text.slice(0, newline)).replace(/\r$/, "")) as {
      type?: unknown;
      parentSession?: unknown;
    };
    return header.type === "session" && typeof header.parentSession === "string" && isAbsolute(header.parentSession)
      ? header.parentSession
      : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Resolve the top-level Pi session that owns a persisted pi-subagents child.
 *
 * Children are inspectable sessions, but their on-disk lifecycle belongs to
 * the parent bundle. The parentSession header may still point at the other
 * storage root after an interrupted or legacy child-only move, so compare the
 * relationship in the child's root while returning the actually existing
 * parent path for the mutation caller.
 */
export function resolvePiSubagentBundleRoot(filePath: string, roots: PiSessionRoots): string {
  let current = resolve(filePath);
  const visited = new Set<string>();
  while (!visited.has(current)) {
    visited.add(current);
    const parentHeaderPath = readParentSessionPath(current);
    if (!parentHeaderPath) break;

    const currentScope = scopeOf(current, roots);
    const candidates = [resolve(parentHeaderPath)];
    if (currentScope) {
      const counterpart = pathInScope(parentHeaderPath, currentScope, roots);
      if (counterpart && counterpart !== candidates[0]) candidates.push(counterpart);
    }
    const parentPath = candidates.find((candidate) => existsSync(candidate));
    if (!parentPath) break;

    const comparableParent = currentScope ? pathInScope(parentPath, currentScope, roots) ?? parentPath : parentPath;
    if (!isPiSubagentSessionPath(comparableParent, current)) break;
    current = parentPath;
  }
  return current;
}

async function isCanonicalSessionFile(filePath: string): Promise<boolean> {
  const file = await open(filePath, "r").catch(() => null);
  if (!file) return false;
  try {
    const buffer = Buffer.alloc(16 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const text = buffer.toString("utf8", 0, bytesRead);
    const newline = text.indexOf("\n");
    if (newline < 0 && bytesRead === buffer.length) return false;
    const header: unknown = JSON.parse(newline < 0 ? text : text.slice(0, newline));
    return Boolean(header && typeof header === "object" && !Array.isArray(header)
      && (header as { type?: unknown }).type === "session"
      && typeof (header as { id?: unknown }).id === "string"
      && Boolean((header as { id: string }).id.trim()));
  } catch {
    return false;
  } finally {
    await file.close().catch(() => undefined);
  }
}

/** Discover only pi-subagents child transcripts owned by one parent transcript. */
export async function findPiSubagentSessionPaths(parentPath: string): Promise<string[]> {
  if (!parentPath.endsWith(".jsonl")) return [];
  const root = parentPath.slice(0, -".jsonl".length);
  const result: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name === "subagent-artifacts") continue;
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name === "session.jsonl"
        && isPiSubagentSessionPath(parentPath, entryPath)
        && await isCanonicalSessionFile(entryPath)) {
        result.push(entryPath);
      }
    }
  };
  await walk(root);
  return result.sort();
}
