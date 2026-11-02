import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { getSessionReadBranch, getSessionReadSnapshot } from "@/lib/session-read-cache";
import { buildSessionHoverPreview, effectiveUserQuestions } from "@/lib/session-hover-preview";
import { localDeviceIdentity, readActivityConfig, resolvePeerUrlForRequest } from "@/lib/activity-peers";

export const dynamic = "force-dynamic";

const HOVER_PREVIEW_PEER_TIMEOUT_MS = 3_000;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const searchParams = new URL(_req.url).searchParams;
    const requestedDeviceId = searchParams.get("deviceId")?.trim();
    const questionOnly = searchParams.get("section") === "user-question";
    if (requestedDeviceId) {
      const local = localDeviceIdentity(readActivityConfig(), new Date().toISOString());
      if (requestedDeviceId !== local.id) {
        const peerUrl = resolvePeerUrlForRequest(requestedDeviceId, _req.url, _req.headers);
        if (!peerUrl) return NextResponse.json({ error: "Device not found" }, { status: 404 });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), HOVER_PREVIEW_PEER_TIMEOUT_MS);
        try {
          const peerPath = `${peerUrl.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(id)}/hover-preview`;
          const peerQuery = questionOnly ? "?section=user-question" : "";
          const response = await fetch(`${peerPath}${peerQuery}`, {
            cache: "no-store",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          });
          const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
          return NextResponse.json(payload, { status: response.status, headers: { "Cache-Control": "no-store" } });
        } finally {
          clearTimeout(timeout);
        }
      }
    }

    const rpc = getRpcSession(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const resolvedPath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !resolvedPath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const readSnapshot = liveRpc ? null : getSessionReadSnapshot(resolvedPath!);
    const sessionManager = liveRpc?.inner.sessionManager ?? readSnapshot!.manager;
    const branch = readSnapshot ? getSessionReadBranch(readSnapshot) : sessionManager.getBranch();
    return NextResponse.json(
      questionOnly
        ? { sessionId: id, userQuestions: effectiveUserQuestions(branch) }
        : { sessionId: id, ...buildSessionHoverPreview(branch) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
