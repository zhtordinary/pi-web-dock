import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPathReadOnly } from "@/lib/session-reader";
import { readPersistedSessionState } from "@/lib/session-persisted-state";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const includeSystemPrompt = new URL(req.url).searchParams.get("systemPrompt") !== "0";
  const liveState = async () => {
    const rpc = getRpcSession(id);
    if (!rpc?.isAlive()) return null;
    const state = await rpc.send({ type: "get_state", ...(includeSystemPrompt ? {} : { systemPrompt: false }) });
    return NextResponse.json({ running: true, source: "live", state });
  };
  try {
    const live = await liveState();
    if (live) return live;
    const filePath = await resolveSessionPathReadOnly(id);
    if (!filePath) return await liveState() ?? NextResponse.json({ error: "Session not found" }, { status: 404 });
    try {
      const state = await readPersistedSessionState(filePath, id);
      const current = await liveState();
      if (current) return current;
      if (typeof state.autoCompactionEnabled !== "boolean") throw new Error("Automatic compaction preference is unavailable");
      return NextResponse.json({ running: false, source: state.autoCompactionSource ?? "persisted", state });
    } catch {
      const current = await liveState();
      if (current) return current;
      return NextResponse.json({
        running: false, source: "persisted", code: "session_state_unavailable",
        error: "Automatic compaction preference is unavailable",
      }, { status: 409 });
    }
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
