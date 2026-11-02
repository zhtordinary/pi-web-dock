import { SESSION_PEER_CUSTOM_TYPE } from "./session-peer-message.ts";

export const SESSION_CONTROL_INITIAL_MESSAGE_CUSTOM_TYPE = "pi-web:session-control-initial-message";

const SESSION_CONTROL_DISPLAY_TYPES = new Set([
  SESSION_CONTROL_INITIAL_MESSAGE_CUSTOM_TYPE,
  SESSION_PEER_CUSTOM_TYPE,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Return the user-facing text for a persisted session-control custom message. */
export function sessionControlDisplayText(entry: unknown): string | undefined {
  if (!isRecord(entry) || entry.type !== "custom_message" || entry.display === false
    || typeof entry.customType !== "string" || !SESSION_CONTROL_DISPLAY_TYPES.has(entry.customType)
    || typeof entry.content !== "string") return undefined;
  const text = entry.content.trim();
  return text || undefined;
}

export function firstSessionControlDisplayText(entries: readonly unknown[]): string | undefined {
  for (const entry of entries) {
    const text = sessionControlDisplayText(entry);
    if (text) return text;
  }
  return undefined;
}
