/** Native peer message protocol shared by Node and the browser. */
export const SESSION_PEER_CUSTOM_TYPE = "pi-web:session-peer" as const;

export type SessionPeerSource = "session-control" | "session-control-wake";

export type SessionPeerDetails = {
  source: SessionPeerSource;
  messageId: string;
  [key: string]: unknown;
};

export type SessionPeerMessage = {
  customType: typeof SESSION_PEER_CUSTOM_TYPE;
  content: string;
  display: boolean;
  details: SessionPeerDetails;
};

export type SessionPeerAgentMessage = SessionPeerMessage & {
  role: "custom";
  timestamp?: number;
};

export function isSessionPeerMessage(value: unknown): value is SessionPeerMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.customType !== SESSION_PEER_CUSTOM_TYPE || typeof message.content !== "string" || typeof message.display !== "boolean") return false;
  const details = message.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const detailRecord = details as Record<string, unknown>;
  return (detailRecord.source === "session-control" || detailRecord.source === "session-control-wake")
    && typeof detailRecord.messageId === "string"
    && detailRecord.messageId.trim() !== "";
}

export function isSessionPeerAgentMessage(value: unknown): value is SessionPeerAgentMessage {
  return Boolean(value && typeof value === "object"
    && (value as Record<string, unknown>).role === "custom"
    && isSessionPeerMessage(value));
}
