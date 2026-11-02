import { NextResponse } from "next/server";
import { markSessionViewed, readViewedState } from "@/lib/viewed-state";
import { emitActivityEvent } from "@/lib/activity-events";

export const dynamic = "force-dynamic";

// 会话已读标记（未读语义服务端化）：GET 返回本设备全部已读时间戳，
// POST { sessionId } 标记为已读。聚合视图（含远程会话）统一按本机
// 服务端已读状态裁决 → 同一设备跨浏览器一致；跨设备各自独立视角。

export async function GET() {
  return NextResponse.json({ viewedAt: readViewedState() });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null) as { sessionId?: unknown } | null;
    if (typeof body?.sessionId !== "string" || !body.sessionId.trim()) {
      return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    }
    const viewedAt = markSessionViewed(body.sessionId);
    emitActivityEvent({ kind: "session", sessionId: body.sessionId });
    return NextResponse.json({ ok: true, sessionId: body.sessionId, viewedAt });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
