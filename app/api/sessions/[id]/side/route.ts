import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
  getSessionEntries,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import { getRpcSessionInfos } from "@/lib/rpc-manager";
import {
  sideFirstMessageEntryId,
  sideUserMessageCount,
} from "@/lib/side-session";
import type { SessionInfo } from "@/lib/types";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

type SideSessionInfo = SessionInfo & {
  sideFirstEntryId: string | null;
  sideMessageCount: number;
};

function decorateSideSession(session: SessionInfo): SideSessionInfo {
  let firstEntryId: string | null = null;
  let messageCount = 0;
  try {
    const entries = getSessionEntries(session.path);
    firstEntryId = sideFirstMessageEntryId(entries);
    messageCount = sideUserMessageCount(entries);
  } catch {
    // A session can disappear between the list scan and this decoration pass.
  }
  return { ...session, sideFirstEntryId: firstEntryId, sideMessageCount: messageCount };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const [persisted, runtime] = await Promise.all([
      listAllSessions({ force: true }),
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    const sessions = mergeSessionLists(persisted, runtime)
      .filter((session) => session.relation?.kind === "side" && session.relation.parentSessionId === id)
      .sort((left, right) => left.created.localeCompare(right.created))
      .map(decorateSideSession);
    return NextResponse.json({ sessions }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500, headers: NO_STORE });
  }
}
