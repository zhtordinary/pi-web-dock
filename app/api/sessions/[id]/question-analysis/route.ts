import { NextResponse } from "next/server";
import {
  latestQuestionAnalysisJobs,
  toQuestionAnalysisJobView,
} from "@/lib/question-analysis-jobs";
import { ensureQuestionAnalysisJobsForSession, getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { getSessionReadSnapshot } from "@/lib/session-read-cache";

export const dynamic = "force-dynamic";

/** Read durable terminology job state without adding it to LLM context. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const entryId = new URL(req.url).searchParams.get("entryId");
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
    const manager = liveRpc?.inner.sessionManager ?? readSnapshot!.manager;
    const entries = (readSnapshot?.entries ?? manager.getEntries()) as never;
    const targetIds = entryId ? new Set([entryId]) : undefined;
    const jobs = latestQuestionAnalysisJobs(entries, targetIds).map(toQuestionAnalysisJobView);
    return NextResponse.json({ jobs });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
