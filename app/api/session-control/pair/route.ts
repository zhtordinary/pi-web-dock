import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getSessionWaitChannel, getSessionWaitStateRoot } from "@/lib/session-waits";
import { resolvePeerUrl } from "@/lib/activity-peers";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const core = require("../../../../bin/session-wait-core.cjs") as typeof import("../../../../bin/session-wait-core.cjs");
export const dynamic = "force-dynamic";
function reject(reason: string, status = 400) { return NextResponse.json({ ok: false, status: "blocked", reason }, { status }); }
export async function GET(request: Request) { if (!isApiRequestAllowed(request)) return reject("untrusted_api_request", 403); try { return NextResponse.json({ ok: true, peers: core.listPeerPins(getSessionWaitStateRoot(), getSessionWaitChannel()) }, { headers: { "Cache-Control": "no-store" } }); } catch (error) { return reject(error instanceof Error ? error.message : String(error), 500); } }
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return reject("untrusted_api_request", 403); if (!hasJsonContentType(request)) return reject("content_type_required", 415);
  try { const body = await request.json() as Record<string, unknown>; const action = body.action === "revoke" ? "revoke" : "pair"; if (action === "revoke") { if (typeof body.deviceId !== "string") throw new Error("deviceId is required"); return NextResponse.json({ ok: true, peer: core.revokePeer(getSessionWaitStateRoot(), getSessionWaitChannel(), body.deviceId) }); } if (typeof body.deviceId !== "string" || typeof body.publicKey !== "string" || typeof body.peerUrl !== "string") throw new Error("deviceId, peerUrl and publicKey are required"); const configuredUrl = resolvePeerUrl(body.deviceId); if (!configuredUrl || new URL(configuredUrl).origin !== new URL(body.peerUrl).origin) throw new Error("peerUrl is not the configured activity peer"); return NextResponse.json({ ok: true, peer: core.pairPeer(getSessionWaitStateRoot(), getSessionWaitChannel(), { deviceId: body.deviceId, peerUrl: body.peerUrl, publicKey: body.publicKey, sessions: body.sessions, operations: body.operations, scopes: body.scopes }) }); }
  catch (error) { return reject(error instanceof Error ? error.message : String(error)); }
}
