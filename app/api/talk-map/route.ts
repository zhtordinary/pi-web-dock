import { NextResponse } from "next/server";
import {
  mutateTalkMap,
  normalizeTalkMapProjectRoot,
  readTalkMap,
} from "@/lib/talk-map";
import type { TalkMapMutation } from "@/lib/talk-map-types";

export const dynamic = "force-dynamic";

function projectRootFromRequest(req: Request): string {
  return normalizeTalkMapProjectRoot(new URL(req.url).searchParams.get("projectRoot"));
}

export async function GET(req: Request) {
  try {
    const projectRoot = projectRootFromRequest(req);
    return NextResponse.json({ board: readTalkMap(projectRoot) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json().catch(() => null) as { projectRoot?: unknown; mutation?: unknown } | null;
    const projectRoot = normalizeTalkMapProjectRoot(body?.projectRoot);
    if (!body?.mutation || typeof body.mutation !== "object") {
      return NextResponse.json({ error: "mutation is required" }, { status: 400 });
    }
    const board = await mutateTalkMap(projectRoot, body.mutation as TalkMapMutation);
    return NextResponse.json({ board }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
