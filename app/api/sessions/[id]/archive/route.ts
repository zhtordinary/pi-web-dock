import { NextResponse } from "next/server";
import { resolveSessionIdByPath, resolveSessionPath, SessionPathConflictError, updateSessionListCachesForMove } from "@/lib/session-reader";
import { getPiSessionRoots, isSessionFileRecentlyChanged, movePiSessionFile, sessionArchiveFiles, SessionArchiveConflictError, setTokenMonitorArchivedFlag, verifySessionMove } from "@/lib/session-archive";
import { resolvePiSubagentBundleRoot } from "@/lib/session-child-tree";
import { getRpcSession } from "@/lib/rpc-manager";
import { closeIdleSession } from "@/lib/session-close";
import { controlSiblingSession } from "@/lib/session-channel-control";
import { acquireStateWriteLock } from "@/lib/state-file-transaction";
import { emitActivityEvent } from "@/lib/activity-events";
import { clearSessionCaches } from "@/lib/session-caches";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "path";

function isPathInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Archive is an idle, exclusive file transition; it never starts or aborts work.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isApiRequestAllowed(req) || !hasJsonContentType(req)) return NextResponse.json({ error: "Request denied" }, { status: 403 });
  try {
    const body = await req.json() as { archived?: boolean };
    const archived = body.archived !== false;
    const sourceArchived = !archived;
    const requestedSource = await resolveSessionPath(id, { archived: sourceArchived });
    const requestedTarget = requestedSource ? null : await resolveSessionPath(id, { archived });
    const requestedPath = requestedSource ?? requestedTarget;
    if (!requestedPath) return NextResponse.json({ error: "Session not found" }, { status: 404 });

    const roots = getPiSessionRoots();
    const bundleRoot = resolvePiSubagentBundleRoot(requestedPath, roots);
    if (resolve(bundleRoot) !== resolve(requestedPath)) {
      return NextResponse.json({
        error: "Subagent sessions belong to the parent session bundle; archive or restore the parent session instead",
        code: "session_child_lifecycle_requires_parent",
      }, { status: 409 });
    }
    const sourceRoot = archived ? roots.sessionsDir : roots.archivedSessionsDir;
    const targetRoot = archived ? roots.archivedSessionsDir : roots.sessionsDir;
    const alreadyAt = isPathInside(bundleRoot, targetRoot);
    const source = bundleRoot;
    if (!alreadyAt && !isPathInside(source, sourceRoot)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const bundleId = await resolveSessionIdByPath(source) ?? id;
    const hadRuntime = getRpcSession(bundleId)?.isAlive() === true;
    await closeIdleSession(bundleId, source);
    const sibling = await controlSiblingSession(bundleId, "shutdown");
    if (!alreadyAt && !hadRuntime && sibling?.hadRuntime !== true && isSessionFileRecentlyChanged(source)) {
      return NextResponse.json({ error: "Session was modified recently; close the other Pi instance before archiving", code: "session_recently_modified" }, { status: 409 });
    }
    // Runtime creation holds this same crash-released mutex until SDK disposal.
    const releases: Array<() => void> = [];
    try {
      const targetBundlePath = join(targetRoot, relative(sourceRoot, source));
      const lockFiles = sessionArchiveFiles(source);
      if (!alreadyAt && existsSync(targetBundlePath)) lockFiles.push(...sessionArchiveFiles(targetBundlePath));
      for (const file of new Set(lockFiles)) releases.push(acquireStateWriteLock(file));
      if (alreadyAt) {
        setTokenMonitorArchivedFlag(source, archived);
        updateSessionListCachesForMove(bundleId, source, source, archived);
        return NextResponse.json({ ok: true, archived, path: source, already: true, executionClosed: true });
      }
      const newPath = movePiSessionFile(source, archived);
      verifySessionMove(source, newPath);
      setTokenMonitorArchivedFlag(newPath, archived);
      updateSessionListCachesForMove(bundleId, source, newPath, archived);
      clearSessionCaches(bundleId);
      emitActivityEvent({ kind: "session", sessionId: bundleId });
      return NextResponse.json({ ok: true, archived, path: newPath, executionClosed: true });
    } finally { for (const release of releases.reverse()) release(); }
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (error instanceof SessionArchiveConflictError || error instanceof SessionPathConflictError
      || code === "session_busy" || code === "ELOCKED" || code === "session_runtime_owned") {
      return NextResponse.json({ error: String(error), code }, { status: 409 });
    }
    return NextResponse.json({ error: String(error) }, { status: 503 });
  }
}
