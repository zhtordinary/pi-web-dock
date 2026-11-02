import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { sessionMutationRequest, validateSessionMutationCommand } from "@/lib/session-mutation-command";
import { acknowledgeSessionMutation, executeSessionMutation, listSessionMutations, querySessionMutation } from "@/lib/session-mutation-service";

import { localDeviceId, readActivityConfig } from "@/lib/activity-peers";
import { SESSION_MUTATION_PROTOCOL } from "@/lib/session-mutation-recovery";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers });
  try {
    const query = new URL(request.url).searchParams;
    if (query.has("capabilities")) return NextResponse.json({ protocol: SESSION_MUTATION_PROTOCOL, deviceId: localDeviceId(), recovery: true }, { headers });
    if (query.has("peers")) return NextResponse.json({ peers: (readActivityConfig().peers ?? []).map(peer => ({ id: peer.id, name: peer.name, url: peer.url })) }, { headers });
    if (query.has("recovery")) return NextResponse.json(await listSessionMutations(query.get("after") ?? ""), { headers });
    const identity = validateSessionMutationCommand({ operationId: query.get("operationId"), deviceId: query.get("deviceId"),
      sessionId: query.get("sessionId"), op: "delete", force: false });
    return NextResponse.json(await querySessionMutation(identity), { headers });
  } catch {
    return NextResponse.json({ error: "Mutation receipt unavailable" }, { status: 503, headers });
  }
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers });
  let command;
  let acknowledgment: { operationId: string; deviceId: string; sessionId: string; reviewedUnknown: boolean } | undefined;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("missing command");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 16 * 1024) { await reader.cancel(); throw new Error("oversized command"); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body.action === "acknowledge") {
      command = validateSessionMutationCommand({ operationId: body.operationId, deviceId: body.deviceId, sessionId: body.sessionId, op: "delete", force: false });
      acknowledgment = { ...command, reviewedUnknown: body.reviewedUnknown === true };
    } else command = validateSessionMutationCommand(body);
  } catch { return NextResponse.json({ error: "Invalid mutation command" }, { status: 400, headers }); }
  try {
    if (acknowledgment) {
      const acknowledged = await acknowledgeSessionMutation(acknowledgment, acknowledgment.reviewedUnknown);
      return NextResponse.json({ acknowledged }, { status: acknowledged ? 200 : 409, headers });
    }
    const receipt = await executeSessionMutation(command, async () => {
      const forwarded = sessionMutationRequest(command, new URL(request.url).origin);
      const context = { params: Promise.resolve({ id: command.sessionId }) };
      if (command.op === "archive" || command.op === "unarchive") return (await import("../sessions/[id]/archive/route")).POST(forwarded, context);
      const route = await import("../sessions/[id]/route");
      return command.op === "rename" ? route.PATCH(forwarded, context) : route.DELETE(forwarded, context);
    });
    return NextResponse.json(receipt, { headers });
  } catch { return NextResponse.json({ error: "Mutation admission unavailable" }, { status: 503, headers }); }
}
