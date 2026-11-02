import { NextResponse } from "next/server";
import { getRpcSession, assertRpcSessionRuntimeBinding } from "@/lib/rpc-manager";
import { isApiRequestAllowed } from "@/lib/request-security";
import { localDeviceIdentity, readActivityConfig } from "@/lib/activity-peers";
import { samePath } from "@/lib/paths";
import { controlRequestFingerprint } from "@/lib/reader-control-receipts";
export const dynamic = "force-dynamic";
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const headers = { "Cache-Control": "no-store" };
  if (!isApiRequestAllowed(req)) return NextResponse.json({ code: "request_denied" }, { status: 403, headers });
  const { id } = await params;
  const session = getRpcSession(id);
  if (!session?.isAlive()) return NextResponse.json({ outcome: "not_live", runtimeStartAttempted: false }, { status: 409, headers });
  const query = new URL(req.url).searchParams;
  const deviceId = localDeviceIdentity(readActivityConfig(), new Date().toISOString()).id;
  if (query.get("deviceId") !== deviceId || !query.get("cwd") || !samePath(query.get("cwd")!, session.cwd)) return NextResponse.json({ code: "target_mismatch" }, { status: 403, headers });
  try {
    await assertRpcSessionRuntimeBinding(session);
    return NextResponse.json({ schemaVersion: 1, deviceId, sessionId: id, cwdRef: controlRequestFingerprint(session.cwd), outcome: "observed", ...session.getManagedSettingsSnapshot(), readOnly: true, runtimeStartAttempted: false, writeSideEffects: false }, { headers });
  } catch {
    return NextResponse.json({ outcome: "blocked", code: "runtime_binding_invalid", runtimeStartAttempted: false, writeSideEffects: false }, { status: 409, headers });
  }
}
