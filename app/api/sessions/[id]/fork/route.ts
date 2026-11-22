import { NextResponse } from "next/server";
import { isAbsolute } from "path";
import { cacheSessionPath, invalidateSessionListCache, readLatestSessionEntryId, resolveSessionPath } from "@/lib/session-reader";
import { scanSessionFileInfo } from "@/lib/session-list-scanner";
import { createSideSession, forkSessionBranch, forkSessionIntoCwd, promoteSideSession, readForkSourceTitle, SessionForkError } from "@/lib/session-fork";
import { getRpcSession } from "@/lib/rpc-manager";
import { SIDE_SESSION_NAME, sideChatNameFromText } from "@/lib/session-family";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function refusal(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

/** Create a hidden Side session, promote one to a visible fork, or fork into a selected cwd. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) return refusal(403, "request-denied", "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "request-denied", "Content-Type must be application/json");

  const { id } = await params;
  try {
    const body = await req.json().catch(() => ({})) as { side?: unknown; promote?: unknown; name?: unknown; cwd?: unknown } | null;
    const side = body?.side === true;
    if (body?.side !== undefined && typeof body.side !== "boolean") {
      return refusal(400, "invalid-request", "side must be a boolean");
    }
    if (body?.promote !== undefined && body.promote !== true) {
      return refusal(400, "invalid-request", "promote must be true");
    }
    const hasTargetCwd = body !== null && Object.hasOwn(body, "cwd");
    const targetCwd = typeof body?.cwd === "string" ? body.cwd.trim() : undefined;
    if (hasTargetCwd && (side || body?.promote === true || !targetCwd || !isAbsolute(targetCwd))) {
      return refusal(400, "cwd-invalid", "cwd must be an absolute path");
    }
    const source = getRpcSession(id);
    const sourcePath = (source?.isAlive() ? source.sessionFile : "") || await resolveSessionPath(id);
    if (!sourcePath) return refusal(404, "not_found", "Session not found");

    if (targetCwd !== undefined) {
      const created = forkSessionIntoCwd(sourcePath, targetCwd);
      cacheSessionPath(created.sessionId, created.path);
      invalidateSessionListCache();
      const info = await scanSessionFileInfo(created.path);
      if (!info) throw new Error("The forked session could not be read");
      return NextResponse.json({
        sessionId: created.sessionId,
        sessionPath: created.path,
        parentSessionId: id,
        session: { ...info, parentSessionId: id, relation: { kind: "fork", originSessionId: id } },
        relation: { kind: "fork", originSessionId: id },
      }, { headers: NO_STORE });
    }

    const sourceTitle = side ? null : await readForkSourceTitle(sourcePath);
    const wrapper = getRpcSession(id);
    let liveLeafId = wrapper?.isAlive() ? wrapper.inner.sessionManager.getLeafId() : undefined;
    if (wrapper && liveLeafId !== undefined && !wrapper.isRunning()) {
      const diskLatest = readLatestSessionEntryId(wrapper.sessionFile);
      if (diskLatest && !wrapper.inner.sessionManager.getEntry(diskLatest)) liveLeafId = undefined;
    }

    if (body?.promote === true) {
      const created = promoteSideSession(sourcePath, liveLeafId, await readForkSourceTitle(sourcePath));
      cacheSessionPath(created.sessionId, created.path);
      invalidateSessionListCache();
      return NextResponse.json({
        sessionId: created.sessionId,
        sessionPath: created.path,
        parentSessionId: id,
        promoted: true,
      }, { headers: NO_STORE });
    }

    const name = side
      ? (typeof body?.name === "string" ? sideChatNameFromText(body.name) ?? SIDE_SESSION_NAME : SIDE_SESSION_NAME)
      : sourceTitle;
    const created = side
      ? createSideSession(sourcePath, liveLeafId, name ?? SIDE_SESSION_NAME)
      : forkSessionBranch(sourcePath, liveLeafId, name);
    cacheSessionPath(created.sessionId, created.path);
    invalidateSessionListCache();
    return NextResponse.json({
      sessionId: created.sessionId,
      sessionPath: created.path,
      parentSessionId: id,
      relation: side ? { kind: "side", parentSessionId: id } : { kind: "fork", originSessionId: id },
    }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof SessionForkError) {
      const status = error.code === "not_found" ? 404 : error.code === "cwd-invalid" ? 400 : 409;
      return refusal(status, error.code, error.message);
    }
    return refusal(500, "failed", error instanceof Error ? error.message : String(error));
  }
}
