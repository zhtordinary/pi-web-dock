import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
  listAllSessions,
  listArchivedSessions,
  mergeSessionLists,
  invalidateSessionListCache,
} from "@/lib/session-reader";
import { getRpcSession, getRpcSessionInfos } from "@/lib/rpc-manager";
import { emitActivityEvent } from "@/lib/activity-events";
import { relatedSessionIds as findRelatedSessionIds } from "@/lib/session-lineage";
import {
  applySubprojectAssignments,
  assignmentForSession,
  subprojectForSession,
  unassignSession,
  SubprojectDomainError,
  projectKeysEqual,
  setSubprojectForSessions,
} from "@/lib/subproject-state";

export const dynamic = "force-dynamic";

async function listAssignmentSessions() {
  const [active, archived, runtime] = await Promise.all([
    listAllSessions({ force: true }),
    listArchivedSessions(),
    attachSessionProjectInfo(getRpcSessionInfos()),
  ]);
  return mergeSessionLists([...active, ...archived], runtime, { includeArchived: true });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await req.json().catch(() => null) as { subprojectId?: unknown; projectKey?: unknown } | null;
    const nextSubprojectId = body?.subprojectId === null || body?.subprojectId === ""
      ? null
      : typeof body?.subprojectId === "string" && body.subprojectId.trim() ? body.subprojectId : undefined;
    if (nextSubprojectId === undefined) {
      return NextResponse.json({ error: "subprojectId is required", code: "subproject_required" }, { status: 400 });
    }
    // Valid input must be durable before the transient/lineage/project lookup;
    // malformed requests must not materialize an otherwise transient session.
    const liveSession = getRpcSession(id);
    liveSession?.persistSessionFileNow();
    const sessions = await listAssignmentSessions();
    const session = sessions.find((candidate) => candidate.id === id);
    if (!session) {
      const orphanAssignment = assignmentForSession(id);
      if (orphanAssignment && (body?.subprojectId === null || body?.subprojectId === "")) {
        if (body.projectKey !== undefined && (typeof body.projectKey !== "string" || !projectKeysEqual(body.projectKey, orphanAssignment.projectKey))) {
          return NextResponse.json({ error: "Session belongs to another project", code: "session_project_mismatch" }, { status: 409 });
        }
        unassignSession(id, orphanAssignment.projectKey);
        invalidateSessionListCache();
        emitActivityEvent({ kind: "session", sessionId: id });
        return NextResponse.json({ session: null, subproject: null, orphaned: true });
      }
      return NextResponse.json({ error: "Session not found", code: "session_not_found" }, { status: 404 });
    }
    if (session.transient) {
      return NextResponse.json({ error: "Transient sessions cannot be assigned to subprojects", code: "transient_session_assignment_forbidden" }, { status: 409 });
    }
    const projectKey = session.projectKey;
    if (!projectKey) return NextResponse.json({ error: "Session project is unknown", code: "session_project_unknown" }, { status: 409 });
    if (body?.projectKey !== undefined && (typeof body.projectKey !== "string" || !projectKeysEqual(body.projectKey, projectKey))) {
      return NextResponse.json({ error: "Session belongs to another project", code: "session_project_mismatch" }, { status: 409 });
    }
    const persistentSessions = sessions.filter((candidate) => !candidate.transient);
    const lineageIds = findRelatedSessionIds(persistentSessions, id);
    const lineageProjectMismatch = persistentSessions.find((candidate) => lineageIds.includes(candidate.id)
      && (!candidate.projectKey || !projectKeysEqual(candidate.projectKey, projectKey)));
    if (lineageProjectMismatch) {
      return NextResponse.json({ error: "Related sessions belong to another project", code: "session_lineage_project_mismatch" }, { status: 409 });
    }
    setSubprojectForSessions(projectKey, lineageIds, nextSubprojectId);
    invalidateSessionListCache();
    for (const relatedId of lineageIds) emitActivityEvent({ kind: "session", sessionId: relatedId });
    const next = applySubprojectAssignments([session])[0];
    return NextResponse.json({ session: next, subproject: next.subprojectId ? subprojectForSession(id, projectKey) : null, relatedSessionIds: lineageIds });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SubprojectDomainError) {
      return NextResponse.json({ error: message, code: error.code }, { status: error.code === "subproject_not_found" ? 404 : error.code === "subproject_required" ? 400 : 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
