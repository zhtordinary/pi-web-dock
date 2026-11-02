import { NextResponse } from "next/server";
import { localDeviceIdentity, readActivityConfig } from "@/lib/activity-peers";
import { readControlReceipt, publicControlReceipt, validateControlIdempotencyKey } from "@/lib/reader-control-receipts";
import { getRpcSession } from "@/lib/rpc-manager";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ code: "request_denied", runtimeStartAttempted: false, writeSideEffects: false }, { status: 403 });
  const { id } = await params;
  const url = new URL(request.url);
  const receiptId = url.searchParams.get("receiptId")?.trim() || undefined;
  const rawKey = url.searchParams.get("idempotencyKey") || undefined;
  const operation = url.searchParams.get("operation")?.trim() || undefined;
  let idempotencyKey: string | undefined;
  try {
    if (!receiptId && !rawKey) throw new Error("receiptId or idempotencyKey is required");
    if ((receiptId && receiptId.length > 200) || (operation && !/^[a-z_]{1,100}$/.test(operation))) throw new Error("invalid query");
    idempotencyKey = rawKey ? validateControlIdempotencyKey(rawKey) : undefined;
  } catch {
    return NextResponse.json({ code: "receipt_query_invalid", runtimeStartAttempted: false, writeSideEffects: false },
      { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const deviceId = localDeviceIdentity(readActivityConfig(), new Date().toISOString()).id;
    const receipt = await readControlReceipt({ deviceId, sessionId: id, receiptId, idempotencyKey, operation });
    if (!receipt) {
      return NextResponse.json({
        error: "Control receipt not found on this Reader device",
        code: "receipt_not_found",
        target: { deviceId, sessionId: id },
        runtimeStartAttempted: false,
        writeSideEffects: false,
      }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    const owner = getRpcSession(id);
    const persistencePending = owner?.hasPendingControlReceiptPersistence(receipt.receiptId) === true;
    const ownerUnavailable = (receipt.outcome === "accepted" || receipt.outcome === "running")
      && (!owner?.isAlive() || !receipt.bootId || receipt.bootId !== owner.getLiveRuntimeIdentity().bootId);
    const unknown = persistencePending || ownerUnavailable;
    return NextResponse.json({
      source: "reader-control-receipt",
      outcome: unknown ? "unknown" : receipt.outcome,
      receipt: publicControlReceipt(unknown ? { ...receipt, outcome: "unknown", nextAction: "observe_receipt_persistence_before_retry" } : receipt),
      ...(persistencePending ? { storedOutcome: receipt.outcome, receiptPersistence: "pending" } : {}),
      ...(ownerUnavailable && !persistencePending ? { storedOutcome: receipt.outcome, runtimeOwner: "unavailable" } : {}),
      target: { deviceId, sessionId: id },
      runtimeStartAttempted: false,
      writeSideEffects: false,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ code: "receipt_store_unavailable", outcome: "unknown", runtimeStartAttempted: false,
      writeSideEffects: false, nextAction: "inspect_receipt_storage_before_retry" },
    { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
