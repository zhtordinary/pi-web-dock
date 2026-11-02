export type WaitUiStatus = "waiting" | "running" | "retrying" | "blocked" | "paused" | "completed" | "failed" | "cancelled";

export function waitStatusKey(status: string): string {
  return `sessionWait.status.${status}`;
}
export function waitConditionKey(condition: string): string {
  return `sessionWait.condition.${condition}`;
}
export function waitActionKey(action?: string): string {
  return action && action !== "none" ? `sessionWait.action.${action}` : "sessionWait.next.none";
}
export function canPause(status: string): boolean { return ["waiting", "running", "retrying"].includes(status); }
export function canResume(status: string): boolean { return ["paused", "blocked", "failed"].includes(status); }
export function canCancel(status: string): boolean { return !["completed", "failed", "cancelled"].includes(status); }
export function workerHealth(value: unknown): { status: "healthy" | "blocked" | "unknown"; reason?: string } {
  if (!value || typeof value !== "object") return { status: "unknown", reason: "health unavailable" };
  const health = value as { status?: unknown; updatedAt?: unknown; pid?: unknown; reason?: unknown };
  const reason = typeof health.reason === "string" ? health.reason : "health unavailable";
  if (health.status === "blocked") return { status: "blocked", reason: reason === "health unavailable" ? "worker blocked" : reason };
  if (health.status === "running" || health.status === "idle") {
    if (typeof health.updatedAt === "string") { const age = Date.now() - Date.parse(health.updatedAt); if (!Number.isFinite(age) || age > 120_000) return { status: "blocked", reason: "worker health is stale" }; }
    if (health.status === "running" && (!Number.isInteger(health.pid) || (health.pid as number) <= 0)) return { status: "unknown", reason: "worker identity unavailable" };
    return { status: "healthy" };
  }
  return { status: "unknown", reason };
}
export type WaitReadiness = { driver: "reader" | "worker"; status: "ready" | "pending" | "blocked" | "inactive"; reason: string; nextAction: string };
export function waitReadiness(wait: { status?: unknown; condition?: unknown; target?: { deviceId?: unknown }; lastResult?: unknown }, facts: { localDeviceId: string; workerHealthy: boolean; externalTask?: boolean; peerReason?: string; unknownDelivery?: boolean }): WaitReadiness {
  const driver = wait.condition === "ui_request" ? "reader" : facts.externalTask || wait.target?.deviceId !== facts.localDeviceId ? "worker" : "reader";
  if (["completed", "failed", "cancelled"].includes(String(wait.status))) return { driver, status: "inactive", reason: String(wait.status), nextAction: "none" };
  if (wait.status === "paused") return { driver, status: "blocked", reason: "wait_paused", nextAction: "resume_or_cancel" };
  if (facts.unknownDelivery) return { driver, status: "blocked", reason: "delivery_outcome_unknown", nextAction: "inspect_recipient_receipt" };
  if (wait.status === "blocked") return { driver, status: "blocked", reason: "wait_blocked", nextAction: "inspect_or_resume" };
  if (facts.peerReason) return { driver, status: "blocked", reason: facts.peerReason, nextAction: "check_peer_pairing_and_scope" };
  if (driver === "worker" && !facts.workerHealthy) return { driver, status: "pending", reason: "worker_unavailable", nextAction: "configure_worker_with_explicit_authorization" };
  return { driver, status: "ready", reason: driver === "reader" ? "reader_lifecycle_driven" : "worker_driven", nextAction: "wait_for_bound_condition" };
}
export function evidenceSourceKey(result: unknown): string {
  const source = result && typeof result === "object" ? (result as { evidenceSource?: unknown }).evidenceSource : undefined;
  return `sessionWait.evidence.${["self_report", "check_program", "independent_review", "user_confirmation"].includes(String(source)) ? source : "unspecified"}`;
}

export function readinessReasonKey(reason: string): string {
  if (reason.startsWith("observe_wait_") || reason.startsWith("handoff_peer_")) return "sessionWait.reason.peer_gate";
  if (["completed", "failed", "cancelled"].includes(reason)) return waitStatusKey(reason);
  return `sessionWait.reason.${reason}`;
}
