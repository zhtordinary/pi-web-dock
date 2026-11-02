import { NextResponse } from "next/server";
import {
  resolveSessionPath,
  buildFullSessionContext,
  buildHistoryStepContext,
  buildSessionContext,
  buildSessionHistoryInfo,
  getQuestionAnalysisJobsForBranch,
  getQuestionDraftViewsForBranch,
} from "@/lib/session-reader";
import { getSessionReadSnapshot } from "@/lib/session-read-cache";
import { ensureQuestionAnalysisJobsForSession, getRpcSession } from "@/lib/rpc-manager";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const hasLeafIdParam = url.searchParams.has("leafId");
  const rawLeafIdParam = url.searchParams.get("leafId");
  const leafIdParam = hasLeafIdParam && rawLeafIdParam?.trim() === "" ? null : rawLeafIdParam;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");
  const deferToolResultText = url.searchParams.has("deferToolResultText");
  const fullHistoryRequested = url.searchParams.has("fullHistory");
  const historyBefore = url.searchParams.get("historyBefore")?.trim() || null;
  const before = url.searchParams.get("before") ?? undefined;
  const rawTail = Number(url.searchParams.get("tail"));
  const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;

  try {
    const rpc = getRpcSession(id);
    let liveRpc = rpc?.isAlive() ? rpc : undefined;
    const filePath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    await ensureQuestionAnalysisJobsForSession(id, filePath ?? undefined);
    const refreshedRpc = getRpcSession(id);
    liveRpc = refreshedRpc?.isAlive() ? refreshedRpc : undefined;

    const readSnapshot = liveRpc ? null : getSessionReadSnapshot(filePath!);
    const sm = liveRpc?.inner.sessionManager ?? readSnapshot!.manager;
    const entries = readSnapshot?.entries ?? sm.getEntries();
    const leafId = hasLeafIdParam ? leafIdParam : (readSnapshot?.leafId ?? sm.getLeafId());
    const options = {
      deferThinking,
      deferToolResultImages,
      deferToolResultText,
      sessionId: id,
      tail,
      excludeLeaf: Boolean(before),
    };
    if (historyBefore) {
      const stepped = buildHistoryStepContext(entries as never, leafId, historyBefore, options);
      return NextResponse.json({
        context: stepped.context,
        questionAnalysisJobs: getQuestionAnalysisJobsForBranch(entries as never, leafId),
        questionDraftViews: getQuestionDraftViewsForBranch(entries as never, leafId),
        history: stepped.history,
        tail: null,
        before: null,
      });
    }
    if (fullHistoryRequested) {
      const fullHistory = buildFullSessionContext(entries as never, leafId, options);
      return NextResponse.json({
        context: fullHistory,
        questionAnalysisJobs: getQuestionAnalysisJobsForBranch(entries as never, leafId),
        questionDraftViews: getQuestionDraftViewsForBranch(entries as never, leafId),
        history: {
          hasEarlierHistory: false,
          hasCompaction: fullHistory.messages.some((message) => message.role === "custom" && message.customType === "compaction"),
          totalMessages: fullHistory.messages.length,
        },
        tail: null,
        before: null,
      });
    }

    const context = buildSessionContext(entries as never, before ?? leafId, options);
    return NextResponse.json({
      context,
      questionAnalysisJobs: getQuestionAnalysisJobsForBranch(entries as never, leafId),
      questionDraftViews: getQuestionDraftViewsForBranch(entries as never, leafId),
      history: buildSessionHistoryInfo(entries as never, leafId, context),
      tail: tail ?? null,
      before: before ?? null,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
