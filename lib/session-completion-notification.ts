export interface SessionCompletionIdentity {
  deviceId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
}

function text(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

/** Only a complete device/session/run identity may participate in deduplication. */
export function sessionCompletionTag(identity: SessionCompletionIdentity | null | undefined): string | undefined {
  const deviceId = text(identity?.deviceId);
  const sessionId = text(identity?.sessionId);
  const runId = text(identity?.runId);
  if (!deviceId || !sessionId || !runId) return undefined;
  return ["pi-session-complete", deviceId, sessionId, runId].map(encodeURIComponent).join(":");
}

export function hasSessionCompletionIdentity(
  identity: SessionCompletionIdentity | null | undefined,
): identity is { deviceId: string; sessionId: string; runId: string } {
  return Boolean(text(identity?.deviceId) && text(identity?.sessionId) && text(identity?.runId));
}
