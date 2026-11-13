// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

import { apiPathForPeer } from "./file-api.ts";

export const SESSION_RESOURCES_RELOADED_EVENT = "reader:session-resources-reloaded";

export class AgentCommandError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly accepted?: boolean;

  constructor(
    message: string,
    status: number,
    code?: string,
    accepted?: boolean,
  ) {
    super(message);
    this.name = "AgentCommandError";
    this.status = status;
    this.code = code;
    this.accepted = accepted;
  }
}

export function isPromptRejectedError(error: unknown): error is AgentCommandError {
  // Only known pre-admission refusals authorize rolling back a local prompt.
  return error instanceof AgentCommandError
    && error.accepted === false
    && (["prompt_rejected", "session_runtime_owned", "session_archived", "request_denied"].includes(error.code ?? "")
      || (error.code?.startsWith("history_edit_") && error.code !== "history_edit_unknown")
      || isSessionMissingError(error));
}

/** A transient runtime was reclaimed before this prompt was admitted. */
export function isSessionMissingError(error: unknown): error is AgentCommandError {
  return error instanceof AgentCommandError
    && error.status === 404
    && error.code === "session_missing"
    && error.accepted === false;
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
  remotePeer?: string,
): Promise<T> {
  const url = apiPathForPeer(remotePeer, `agent/${encodeURIComponent(sessionId)}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
    ...(command.type === "get_state" ? { signal: AbortSignal.timeout(15_000) } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
    code?: string;
    accepted?: boolean;
  };
  if (!res.ok || body.error) {
    throw new AgentCommandError(
      body.error ?? `HTTP ${res.status}`,
      res.status,
      body.code,
      body.accepted,
    );
  }
  return body.data as T;
}

export interface ReloadAllAgentSessionsResult {
  liveSessions: number;
  reloadedSessions: number;
  busySessionIds: string[];
  failedSessionIds: string[];
}

export async function reloadAllAgentSessions(remotePeer?: string): Promise<ReloadAllAgentSessionsResult> {
  const url = apiPathForPeer(remotePeer, "agent/reload-all");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: ReloadAllAgentSessionsResult;
    error?: string;
    code?: string;
    accepted?: boolean;
  };
  if (!res.ok || body.error) {
    throw new AgentCommandError(
      body.error ?? `HTTP ${res.status}`,
      res.status,
      body.code,
      body.accepted,
    );
  }
  return body.data as ReloadAllAgentSessionsResult;
}
