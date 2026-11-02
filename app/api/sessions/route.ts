import { NextResponse } from "next/server";
import { isAbsolute } from "path";
import { jsonResponse } from "@/lib/json-response";
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  listAllSessions,
  listArchivedSessions,
  listProjectSessions,
  listSessionSummaries,
  mergeSessionLists,
} from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { selectHiddenSessions } from "@/lib/hidden-filter";
import { readFavoriteState } from "@/lib/favorite-state";
import { readSessionCategoryState, sessionCategoryFromState } from "@/lib/session-category-state";
import { matchesSessionStorageScope } from "@/lib/session-storage-scope";
import type { SessionInfo } from "@/lib/types";
import { applySubprojectAssignments } from "@/lib/subproject-state";
import { startServerPerf } from "@/lib/perf";

export const dynamic = "force-dynamic";

function filterDefaultSessions(sessions: SessionInfo[]): SessionInfo[] {
  const categoryState = readSessionCategoryState();
  const favoriteIds = new Set(readFavoriteState().sessions);
  const hiddenIds = new Set(selectHiddenSessions(sessions).map((session) => session.id));
  return sessions.filter((session) => matchesSessionStorageScope("normal", {
    category: sessionCategoryFromState(categoryState, session.id),
    favorite: favoriteIds.has(session.id),
    hidden: hiddenIds.has(session.id),
  }));
}

export async function GET(req: Request) {
  const perf = startServerPerf("GET /api/sessions");
  try {
    const searchParams = new URL(req.url).searchParams;
    const projectRoot = searchParams.get("projectRoot");
    const archivedOnly = searchParams.get("archived") === "1";
    const force = searchParams.get("force") === "1";
    const summary = searchParams.get("summary") === "1";

    if (archivedOnly) {
      const sessions = await listArchivedSessions({ force });
      return NextResponse.json(
        {
          sessions: applySubprojectAssignments(filterDefaultSessions(sessions)),
          runningSessionIds: getRunningRpcSessionIds(),
          sessionListVersion: getSessionListVersion(),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (projectRoot !== null) {
      const root = projectRoot.trim();
      if (!root || !isAbsolute(root)) {
        return NextResponse.json(
          { error: "projectRoot must be an absolute path" },
          { status: 400, headers: { "Cache-Control": "no-store" } },
        );
      }
      const sessions = await listProjectSessions(root, getRpcSessionInfos());
      return NextResponse.json(
        { sessions: applySubprojectAssignments(filterDefaultSessions(sessions)), runningSessionIds: getRunningRpcSessionIds() },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    perf?.span("start");
    const persistedSessionsPromise = summary
      ? listSessionSummaries()
      : listAllSessions({ force });
    const sessionListVersion = getSessionListVersion();
    const [persistedSessions, runtimeSessions] = await Promise.all([
      persistedSessionsPromise,
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    perf?.span("scan+projects");
    const sessions = applySubprojectAssignments(
      filterDefaultSessions(mergeSessionLists(persistedSessions, runtimeSessions)),
    );

    const payload = {
      sessions,
      sessionListVersion,
      runningSessionIds: getRunningRpcSessionIds(),
      suppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
    };

    return perf?.attach(jsonResponse(req, payload, { headers: { "Cache-Control": "no-store" } })) ??
      jsonResponse(req, payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[pi-web] failed to list sessions:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
