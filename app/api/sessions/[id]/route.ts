import type { SessionEntry } from "@/lib/types";
import { computeSessionStats } from "@/lib/session-stats";
import { NextResponse } from "next/server";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionHeader as ReaderSessionHeader } from "@/lib/types";
import {
  resolveSessionPath,
  resolveSessionPathReadOnly,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  buildSessionContext,
  getSessionBranchEntries,
  getSessionBranchSettings,
  buildSessionHistoryInfo,
  parseSessionTail,
  getQuestionAnalysisJobsForBranch,
  getQuestionDraftViewsForBranch,
  readSessionHeader,
  attachSessionProjectInfo,
} from "@/lib/session-reader";
import {
  getSessionReadSnapshot,
  getSessionReadTree,
  invalidateSessionReadCache,
} from "@/lib/session-read-cache";
import { sessionPathKey } from "@/lib/session-path";
import { getRpcSession } from "@/lib/rpc-manager";
import { projectTreeForResponse } from "@/lib/project-tree";
import { loadSessionTiming } from "@/lib/session-timing.server";
import { windowSessionTiming } from "@/lib/session-timing";
import { readSessionContextUsageFromFile } from "@/lib/session-context-usage";
import { computeSessionRevision } from "@/lib/session-revision";
import { emitActivityEvent } from "@/lib/activity-events";
import { clearSessionCaches } from "@/lib/session-caches";
import { clearSessionHidden } from "@/lib/hidden-state";
import { setFavorite } from "@/lib/favorite-state";
import { setSessionCategory } from "@/lib/session-category-state";
import { getPiSessionRoots, movePiSessionToDeleted, setTokenMonitorArchivedFlag, setTokenMonitorDeletedFlag } from "@/lib/session-archive";
import { resolvePiSubagentBundleRoot } from "@/lib/session-child-tree";
import { assignmentForSession, applySubprojectAssignments, assignSession, unassignSession } from "@/lib/subproject-state";
import { readSessionFastMode } from "@/lib/fast-mode";
import { readSafeSessionHistory, boundedSafeHistoryInteger } from "@/lib/reader-safe-history";
import { firstSessionControlDisplayText } from "@/lib/session-control-display";

async function mutateSessionAssignment(
  req: Request,
  sessionId: string,
  projectKey: string,
  subprojectId: string | null,
): Promise<Response | null> {
  if (subprojectId === null) unassignSession(sessionId, projectKey);
  else assignSession(projectKey, sessionId, subprojectId);
  return null;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const requestedUrl = new URL(req.url);
    if (requestedUrl.searchParams.get("safeRead") === "1") {
      return NextResponse.json(await readSafeSessionHistory({
        sessionId: id,
        tail: boundedSafeHistoryInteger(requestedUrl.searchParams.get("tail"), 20, 1, 100, "tail"),
        maxEntries: boundedSafeHistoryInteger(requestedUrl.searchParams.get("maxEntries"), 20, 1, 100, "maxEntries"),
        maxBytes: boundedSafeHistoryInteger(requestedUrl.searchParams.get("maxBytes"), 128 * 1024, 4096, 128 * 1024, "maxBytes"),
      }), { headers: { "Cache-Control": "no-store" } });
    }
    const resolvedPath = await resolveSessionPathReadOnly(id);
    if (!resolvedPath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const readSnapshot = getSessionReadSnapshot(resolvedPath);
    const filePath = readSnapshot.path;
    const searchParams = new URL(req.url).searchParams;
    const hasLeafIdParam = searchParams.has("leafId");
    const rawLeafIdParam = searchParams.get("leafId");
    const leafIdParam = hasLeafIdParam && rawLeafIdParam?.trim() === "" ? null : rawLeafIdParam?.trim() || null;
    const metadataOnly = searchParams.get("metadataOnly") === "1";
    const entries = readSnapshot.entries;
    const leafId = hasLeafIdParam ? leafIdParam : readSnapshot.leafId;
    const tree = projectTreeForResponse(getSessionReadTree(readSnapshot));
    if (metadataOnly) {
      // SAFETY: SDK and Reader use the same persisted SessionEntry wire shape; this endpoint only computes read-only stats.
      const stats = computeSessionStats(entries as unknown as SessionEntry[]);
      const settings = getSessionBranchSettings(entries as never, leafId);
      return NextResponse.json({
        sessionId: id,
        filePath,
        info: null,
        leafId,
        tree,
        context: { messages: [], entryIds: [], thinkingLevel: settings.thinkingLevel, model: settings.model },
        stats: {
          ...stats,
          sessionId: id,
          sessionFile: filePath,
          sessionName: readSnapshot.name,
          // Metadata is intentionally not Reader's priced mainCost. Keep the
          // producer-side file cost out of this first paint snapshot.
          cost: 0,
          costStatus: "unavailable",
          costState: "loading",
          statsSource: "reader-file",
          statsScope: "Reader persisted session file; excludes child sessions and Reader-priced total",
        },
        contextUsage: await readSessionContextUsageFromFile(filePath, leafId),
        questionAnalysisJobs: getQuestionAnalysisJobsForBranch(entries as never, leafId),
        questionDraftViews: getQuestionDraftViewsForBranch(entries as never, leafId),
        metadataOnly: true,
        snapshotRevision: computeSessionRevision({
          filePath,
          sourceId: "disk",
          entryCount: entries.length,
          latestEntryId: (entries[entries.length - 1] as { id?: string } | undefined)?.id ?? null,
          leafId: leafId ?? null,
        }),
        fastMode: readSessionFastMode(entries as never),
        // Timing reads the persisted session, so it is available whether or not a runtime is live.
        timing: await loadSessionTiming({
          filePath,
          header: readSnapshot.header,
          branch: getSessionBranchEntries(entries as never, leafId) as never,
          entries: entries as never,
        }),
      });
    }
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const deferToolResultText = searchParams.has("deferToolResultText");
    const before = searchParams.get("before")?.trim() || null;
    const rawTail = Number(searchParams.get("tail"));
    const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
    const context = buildSessionContext(entries as never, leafId, {
      deferThinking,
      deferToolResultImages,
      deferToolResultText,
      tail,
      sessionId: id,
    });
    // SAFETY: session entries match SessionEntry schema
    const stats = computeSessionStats(entries as unknown as SessionEntry[]);
    const history = buildSessionHistoryInfo(entries as never, leafId, context);
    const questionAnalysisJobs = getQuestionAnalysisJobsForBranch(entries as never, leafId);
    const questionDraftViews = getQuestionDraftViewsForBranch(entries as never, leafId);
    const header = readSnapshot.header;
    const timing = await loadSessionTiming({
      filePath,
      header,
      branch: getSessionBranchEntries(entries as never, leafId) as never,
      entries: entries as never,
    });
    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const info = header ? {
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: readSnapshot.name,
      created: header.timestamp,
      modified,
      messageCount: stats.totalMessages,
      firstMessage: context.messages.find((m) => m.role === "user")
        ? (() => {
            const msg = context.messages.find((m) => m.role === "user")!;
            const c = (msg as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : firstSessionControlDisplayText(getSessionBranchEntries(entries as never, leafId)) ?? "(no messages)",
      parentSessionId,
      // SAFETY: header may include Reader-specific extension fields
      contextSourceSessionId: (header as unknown as ReaderSessionHeader | null)?.contextSourceSessionId,
      transient: !filePath || !existsSync(filePath),
    } : null;

    const hydratedInfo = info
      ? applySubprojectAssignments(await attachSessionProjectInfo([info]))[0]
      : null;
    return NextResponse.json({
      sessionId: id,
      filePath,
      info: hydratedInfo,
      leafId,
      tree,
      context,
      stats,
      questionAnalysisJobs,
      questionDraftViews,
      history,
      // Opaque freshness token for the client view cache. A switch back to an
      // unchanged session can then reuse what is already loaded instead of
      // flashing an empty transcript and re-rendering the bounded page.
      snapshotRevision: computeSessionRevision({
        filePath,
        sourceId: "disk",
        entryCount: entries.length,
        latestEntryId: (entries[entries.length - 1] as { id?: string } | undefined)?.id ?? null,
        leafId: leafId ?? null,
      }),
      fastMode: readSessionFastMode(entries as never),
      // Per-turn timing grows with the whole branch; a transcript page carries only its own turns.
      timing: windowSessionTiming(timing, context.entryIds),
      tail: tail ?? null,
      before: before ?? null,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    // The live path and the cold path must agree on what a name is; an empty
    // rename is rejected here so it cannot clear a title on one path only.
    const trimmedName = name.trim();
    if (!trimmedName) {
      return NextResponse.json({ error: "Session name cannot be empty" }, { status: 400 });
    }
    const live = getRpcSession(id);
    if (live?.isAlive()) {
      // Resolve the RPC-owned runtime first: transient sessions intentionally
      // have no disk path until their first durable lifecycle event. A runtime
      // that is already shutting down must finish first, otherwise this write
      // races the teardown of the SessionManager that owns the transcript.
      if (live.isShuttingDown?.()) await live.waitUntilDisposed?.();
      else {
        await live.send({ type: "set_session_name", name: trimmedName });
        invalidateSessionListCache();
        emitActivityEvent({ kind: "session", sessionId: id });
        return NextResponse.json({ ok: true });
      }
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    // A cold rename writes the transcript file, so it needs the same physical
    // ownership a runtime takes. Without it, another Reader that is starting
    // this session can append a different leaf and one of the two names wins
    // silently. Imported here so a metadata-only GET never loads runtime
    // ownership machinery.
    const { acquireSessionRuntimeOwnership } = await import("@/lib/session-runtime-ownership");
    let ownership: ReturnType<typeof acquireSessionRuntimeOwnership>;
    try {
      ownership = acquireSessionRuntimeOwnership(filePath);
    } catch (error) {
      if ((error as { code?: unknown }).code === "session_runtime_owned") {
        return NextResponse.json({ error: (error as Error).message }, { status: 409 });
      }
      throw error;
    }
    try {
      const sm = SessionManager.open(filePath);
      sm.appendSessionInfo(trimmedName);
    } finally {
      ownership.release();
    }
    invalidateSessionListCache();
    emitActivityEvent({ kind: "session", sessionId: id });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const rpc = getRpcSession(id);
    const live = rpc?.isAlive() ? rpc : undefined;
    const resolvedPath = live ? null : await resolveSessionPath(id);
    const filePath = live?.sessionFile
      || live?.inner.sessionManager?.getSessionFile?.()
      || resolvedPath
      || "";
    if (filePath) {
      const bundleRoot = resolvePiSubagentBundleRoot(filePath, getPiSessionRoots());
      if (resolve(bundleRoot) !== resolve(filePath)) {
        return NextResponse.json({
          error: "Subagent sessions belong to the parent session bundle; delete the parent session instead",
          code: "session_child_lifecycle_requires_parent",
          parentPath: bundleRoot,
        }, { status: 409 });
      }
    }
    const hasPersistedFile = Boolean(filePath && existsSync(filePath));
    if (!live && !hasPersistedFile) {
      // A failed/partial delete can leave only the sidecar assignment. Clean
      // that orphan idempotently so a later retry does not retain stale UI state.
      const orphanAssignment = assignmentForSession(id);
      if (orphanAssignment) {
        const assignmentError = await mutateSessionAssignment(req, id, orphanAssignment.projectKey, null);
        if (assignmentError) return assignmentError;
      }
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (!hasPersistedFile) {
      await live?.shutdown();
      if (!existsSync(filePath)) {
        const previousAssignment = assignmentForSession(id);
        if (previousAssignment) {
          const assignmentError = await mutateSessionAssignment(req, id, previousAssignment.projectKey, null);
          if (assignmentError) return assignmentError;
        }
        clearSessionHidden(id);
        setFavorite(id, false);
        setSessionCategory(id, null);
        invalidateSessionReadCache(filePath);
        invalidateSessionPathCache(id);
        invalidateSessionListCache();
        clearSessionCaches(id);
        emitActivityEvent({ kind: "session", sessionId: id });
        return NextResponse.json({ ok: true, deleted: true });
      }
      // Shutdown may persist the session. Fall through to move its bundle.
    }

    // Read only the bounded header before moving. Runtime sessions can have
    // a cached path before their first disk write.
    let parentSessionPath: string | undefined;
    try {
      parentSessionPath = readSessionHeader(filePath)?.parentSession;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    // Re-attach all direct children to this session's parent (cascade re-parent).
    // Keep exact originals so delete failure cannot strand a half-reparented tree.
    const targetPathKey = sessionPathKey(filePath);
    const dir = dirname(filePath);
    const reparentedChildren: Array<{ path: string; originalContent: string; nextContent: string }> = [];
    try {
      const files = readdirSync(dir).filter(
        (file) => file.endsWith(".jsonl") && sessionPathKey(join(dir, file)) !== targetPathKey,
      );
      for (const file of files) {
        const childPath = join(dir, file);
        let content: string;
        try {
          content = readFileSync(childPath, "utf8");
        } catch {
          continue;
        }
        const lines = content.split("\n");
        let header: { type?: string; parentSession?: string };
        try {
          header = JSON.parse(lines[0]) as typeof header;
        } catch {
          continue; // Malformed siblings are not cascade targets.
        }
        {
          if (
            header.type === "session" &&
            header.parentSession &&
            sessionPathKey(header.parentSession) === targetPathKey
          ) {
            header.parentSession = parentSessionPath;
            lines[0] = JSON.stringify(header);
            reparentedChildren.push({ path: childPath, originalContent: content, nextContent: lines.join("\n") });
          }
        }
      }
    } catch (error) {
      throw error;
    }

    // Persisted sessions stay recoverable: move the complete bundle into
    // TokenMonitor's deleted_sessions root. Runtime-only sessions still need
    // their sidecar assignment removed because there is no file to restore.
    const previousAssignment = assignmentForSession(id);
    let assignmentCleared = false;
    let deletion: { deleted: true; path?: string };
    try {
      if (live) {
        await live.shutdown();
      } else {
        await getRpcSession(id)?.shutdown();
      }
      const persistedPath = existsSync(filePath) ? filePath : null;
      if (persistedPath) {
        const deletedPath = movePiSessionToDeleted(persistedPath, reparentedChildren);
        setTokenMonitorArchivedFlag(deletedPath, true);
        setTokenMonitorDeletedFlag(deletedPath, true);
        deletion = { deleted: true, path: deletedPath };
      } else {
        if (previousAssignment) {
          const assignmentError = await mutateSessionAssignment(req, id, previousAssignment.projectKey, null);
          if (assignmentError) return assignmentError;
          assignmentCleared = true;
        }
        deletion = { deleted: true };
      }
    } catch (error) {
      // Move did not complete: restore an assignment only when this request
      // had already cleared one for a runtime-only session.
      if (assignmentCleared && previousAssignment) {
        try {
          const restoreError = await mutateSessionAssignment(req, id, previousAssignment.projectKey, previousAssignment.subprojectId);
          if (restoreError) console.error("Failed to restore subproject assignment after delete failure:", restoreError.status);
        } catch (restoreError) {
          console.error("Failed to restore subproject assignment after delete failure:", restoreError);
        }
      }
      throw error;
    }
    // 删除 = 移入可恢复目录：清理 Reader 视图残留（幂等），保留子项目归属供恢复使用。
    clearSessionHidden(id);
    setFavorite(id, false);
    setSessionCategory(id, null);
    invalidateSessionReadCache(filePath);
    for (const child of reparentedChildren) invalidateSessionReadCache(child.path);
    invalidateSessionPathCache(id);
    invalidateSessionListCache();
    // Deleted session: drop cached metadata/cost so the id does not linger in
    // the unbounded maps after it leaves the visible session roots.
    clearSessionCaches(id);
    emitActivityEvent({ kind: "session", sessionId: id });
    return NextResponse.json({ ok: true, ...deletion });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
