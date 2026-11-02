import { NextResponse } from "next/server";
import { resolveSessionPath, SessionPathConflictError, updateSessionListCachesForMove } from "@/lib/session-reader";
import { isSessionFileRecentlyChanged, movePiSessionFile, sessionArchiveFiles, SessionArchiveConflictError, setTokenMonitorArchivedFlag, verifySessionMove } from "@/lib/session-archive";
import { getRpcSession } from "@/lib/rpc-manager";
import { closeIdleSession } from "@/lib/session-close";
import { controlSiblingSession } from "@/lib/session-channel-control";
import { acquireStateWriteLock } from "@/lib/state-file-transaction";
import { emitActivityEvent } from "@/lib/activity-events";
import { clearSessionCaches } from "@/lib/session-caches";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

// Archive is an idle, exclusive file transition; it never starts or aborts work.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isApiRequestAllowed(req) || !hasJsonContentType(req)) return NextResponse.json({ error: "Request denied" }, { status: 403 });
  try {
    const body = await req.json() as { archived?: boolean };
    const archived = body.archived !== false;
    const sourceArchived = !archived;
    const filePath = await resolveSessionPath(id, { archived: sourceArchived });
    const alreadyAt = filePath ? null : await resolveSessionPath(id, { archived });
    const source = filePath ?? alreadyAt;
    if (!source) return NextResponse.json({ error: "Session not found" }, { status: 404 });

    const hadRuntime = getRpcSession(id)?.isAlive() === true;
    await closeIdleSession(id, source);
    const sibling = await controlSiblingSession(id, "shutdown");
    if (filePath && !hadRuntime && sibling?.hadRuntime !== true && isSessionFileRecentlyChanged(filePath)) {
      return NextResponse.json({ error: "Session was modified recently; close the other Pi instance before archiving", code: "session_recently_modified" }, { status: 409 });
    }
    // Runtime creation holds this same crash-released mutex until SDK disposal.
    const releases: Array<() => void> = [];
    try {
      for (const file of sessionArchiveFiles(source)) releases.push(acquireStateWriteLock(file));
      if (alreadyAt) {
        setTokenMonitorArchivedFlag(alreadyAt, archived);
        updateSessionListCachesForMove(id, alreadyAt, alreadyAt, archived);
        return NextResponse.json({ ok: true, archived, path: alreadyAt, already: true, executionClosed: true });
      }
      const newPath = movePiSessionFile(source, archived);
      verifySessionMove(source, newPath);
      setTokenMonitorArchivedFlag(newPath, archived);
      updateSessionListCachesForMove(id, source, newPath, archived);
      clearSessionCaches(id);
      emitActivityEvent({ kind: "session", sessionId: id });
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
