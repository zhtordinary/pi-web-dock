import { NextResponse } from "next/server";
import { normalizeTalkMapProjectRoot, queryTalkMapRelations, readTalkMap } from "@/lib/talk-map";
import type { TalkMapEdgeType } from "@/lib/talk-map-types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const projectRoot = normalizeTalkMapProjectRoot(params.get("projectRoot"));
    const type = params.get("type");
    if (type && type !== "related" && type !== "lineage") {
      return NextResponse.json({ error: "invalid relation type" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const board = readTalkMap(projectRoot);
    return NextResponse.json({
      projectRoot: board.projectRoot,
      boardKey: board.boardKey,
      deviceId: board.deviceId,
      relations: queryTalkMapRelations(board, {
        sessionId: params.get("sessionId") ?? undefined,
        type: type as TalkMapEdgeType | undefined,
      }),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
