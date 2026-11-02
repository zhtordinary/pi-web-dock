import { createSessionControlEnvelope } from "./session-control-auth";
import { claimPersistentOutbox, getSessionWaitChannel } from "./session-waits";
import { resolvePeerUrl } from "./activity-peers";

export type PeerDeliveryResult = {
  transport: "accepted" | "unknown" | "blocked";
  httpStatus?: number;
  recipientStatus?: string;
  messageId: string;
  reason?: string;
};

function assertConfiguredPeerUrl(raw: string, allowedPeerUrls: readonly string[] | undefined, peerId: string): URL {
  const url = new URL(raw); if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("peer URL must use http or https");
  if (!allowedPeerUrls?.length || !allowedPeerUrls.some((candidate) => new URL(candidate).origin === url.origin)) throw new Error("peer URL is not a configured peer");
  const configured = resolvePeerUrl(peerId); if (!configured || new URL(configured).origin !== url.origin) throw new Error("peer URL is not the configured activity peer");
  return url;
}

export async function deliverSessionControlPeer(input: {
  url: string;
  allowedPeerUrls?: readonly string[];
  privateKey: string;
  sender: Record<string, unknown>;
  recipient: string;
  messageId?: string;
  generation?: number;
  round?: number;
  scope?: string[];
  operation?: "wake" | "pull_messages" | "observe_wait" | "report_result";
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<PeerDeliveryResult> {
  const base = assertConfiguredPeerUrl(input.url, input.allowedPeerUrls, input.recipient);
  const operation = input.operation || "wake";
  const scope = input.scope || (operation === "pull_messages" ? ["pull_messages"] : operation === "observe_wait" ? ["observe_wait"] : operation === "report_result" ? ["report_result"] : ["resume_prior_work"]);
  const envelope = createSessionControlEnvelope({ channel: getSessionWaitChannel(), sender: input.sender, recipient: input.recipient, messageId: input.messageId, generation: input.generation, round: input.round, scope, body: input.body, operation }, input.privateKey) as { messageId: string } & Record<string, unknown>;
  try {
    const response = await fetch(new URL("/api/session-control/peer", base), { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(envelope), signal: input.signal });
    let payload: Record<string, unknown> = {}; try { payload = await response.json() as Record<string, unknown>; } catch { /* status still matters */ }
    if (!response.ok) return { transport: "blocked", httpStatus: response.status, messageId: envelope.messageId, reason: typeof payload.reason === "string" ? payload.reason : `HTTP ${response.status}` };
    return { transport: payload.accepted === true ? "accepted" : "blocked", httpStatus: response.status, recipientStatus: typeof payload.status === "string" ? payload.status : undefined, messageId: envelope.messageId, reason: typeof payload.reason === "string" ? payload.reason : undefined };
  } catch (error) { return { transport: "unknown", messageId: envelope.messageId, reason: error instanceof Error ? error.message : String(error) }; }
}

export async function pullSessionControlPeer(input: { url: string; allowedPeerUrls?: readonly string[]; privateKey: string; sender: Record<string, unknown>; recipient: string; signal?: AbortSignal }): Promise<PeerDeliveryResult> {
  return deliverSessionControlPeer({ ...input, operation: "pull_messages", scope: ["pull_messages"], body: { request: "pull" } });
}
export function markOutboxTransport(id: string, status: "in_flight" | "accepted" | "unknown" | "processed" | "blocked" | "queued" | "retrying" | "cancelled") { return claimPersistentOutbox(id, status); }
