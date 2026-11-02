import type { SessionExecutionState } from "./session-execution";

export interface SiblingExecutionObservation {
  execution: Record<string, SessionExecutionState>;
  complete: boolean;
}

function siblingOrigin(): string | null {
  const port = process.env.PI_WEB_BOUND_PORT;
  return port === "30141" ? "http://127.0.0.1:30142" : port === "30142" ? "http://127.0.0.1:30141" : null;
}

/** Only a refused listener is absent; timeout and incompatible versions remain unknown. */
async function siblingRequest(path: string, method: "GET" | "POST") {
  const origin = siblingOrigin();
  if (!origin) return null;
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      method, headers: { "Content-Type": "application/json", Origin: origin },
      ...(method === "POST" ? { body: "{}" } : {}),
      signal: AbortSignal.timeout(method === "POST" ? 20_000 : 5_000), redirect: "error",
    });
  } catch (error) {
    if ((error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED") return null;
    throw new Error(`Sibling Reader ${method} could not be confirmed: ${String(error)}`);
  }
  const result = await response.json();
  // GET /api/agent/running predates protocol=1. Read-only observation may
  // consume its runningSessionIds, but control endpoints remain strict below.
  if (method === "GET" && response.ok && result && result.protocol !== 1
    && Array.isArray(result.runningSessionIds) && result.runningSessionIds.every((id: unknown) => typeof id === "string")) return result;
  if (!response.ok || result?.protocol !== 1) throw new Error(result?.error ?? "Sibling Reader requires a compatible session-control version");
  return result;
}

export async function controlSiblingSession(sessionId: string, action: "stop" | "shutdown") {
  const result = await siblingRequest(`/api/sessions/${encodeURIComponent(sessionId)}/${action}?local=1`, "POST") as {
    protocol: number; sessionId: string; ok?: boolean; hadRuntime?: boolean; stopped?: boolean; queuedCount?: number; errors?: string[];
  } | null;
  if (result && result.sessionId !== sessionId) throw new Error("Sibling Reader returned an incompatible session identity");
  if (result && action === "shutdown" && result.ok !== true) throw new Error("Sibling Reader shutdown was not confirmed");
  return result;
}

/** A single process-local snapshot; this endpoint never queries its sibling recursively. */
export async function readSiblingExecution(): Promise<SiblingExecutionObservation> {
  try {
    const result = await siblingRequest("/api/agent/running", "GET");
    if (!result) return { execution: {}, complete: true };
    if (result.protocol !== 1) {
      const execution = Object.fromEntries(result.runningSessionIds.map((id: string) => [id, {
        parentActive: true, retrying: false, unattended: false, backgroundRunIds: [], queuedCount: 0, active: true,
      }]));
      return { execution, complete: false };
    }
    if (!result.execution || typeof result.execution !== "object" || Array.isArray(result.execution)) throw new Error("Sibling execution snapshot unavailable");
    for (const state of Object.values(result.execution) as SessionExecutionState[]) {
      if (!state || typeof state.active !== "boolean" || typeof state.parentActive !== "boolean" || typeof state.retrying !== "boolean"
        || !Array.isArray(state.backgroundRunIds) || !state.backgroundRunIds.every(id => typeof id === "string")
        || !Number.isSafeInteger(state.queuedCount) || state.queuedCount < 0) throw new Error("Invalid sibling execution snapshot");
    }
    return { execution: result.execution, complete: true };
  } catch {
    // Read-only activity must remain available while the paired port is old,
    // timing out, or otherwise unable to prove its execution snapshot.
    return { execution: {}, complete: false };
  }
}
