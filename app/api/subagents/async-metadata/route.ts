import { NextResponse } from "next/server";
import { readAsyncModelMetadata } from "@/lib/subagent-async-metadata";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId")?.trim() ?? "";
  const ids = (url.searchParams.get("ids") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (!sessionId || ids.length === 0) {
    return NextResponse.json({ error: "sessionId and ids are required" }, { status: 400 });
  }
  return NextResponse.json({ models: readAsyncModelMetadata(sessionId, ids) });
}
