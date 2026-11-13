import { isAbsolute, resolve } from "node:path";
import {
  controlRequestFingerprint, readControlReceipt, reserveControlReceipt, publicControlReceipt,
  updateControlReceipt, validateControlFingerprint, validateControlIdempotencyKey,
} from "./reader-control-receipts";
import { redactLiveValue } from "./live-agent-events";

export type SettingsTarget = { area: string; scope: "global" | "project"; cwd: string };
export type SettingsSnapshot = {
  revision: string; value: unknown; impact: unknown; supportedOperations: string[];
  changed?: boolean;
};
export type ControlPlaneDependencies = {
  deviceId: () => string;
  bootId: () => string;
  globalCwd: () => string;
  authorizeCwd: (cwd: string) => Promise<boolean>;
  inspectSettings: (target: SettingsTarget) => Promise<SettingsSnapshot>;
  validateSettingsChange: (input: SettingsTarget & { operation: string; changes: Record<string, unknown> }) => void | Promise<void>;
  mutateSettings: (input: SettingsTarget & { operation: string; changes: Record<string, unknown>; expectedRevision: string }) => Promise<SettingsSnapshot>;
};
export class ControlPlaneError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, name: string, max = 160): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ControlPlaneError("invalid_request", `${name} is invalid`);
  }
  return value;
}
function idempotencyKeyOf(value: unknown): string {
  try { return validateControlIdempotencyKey(value); }
  catch { throw new ControlPlaneError("invalid_request", "idempotencyKey is invalid"); }
}
function fingerprintOf(value: unknown): string | undefined {
  try { return validateControlFingerprint(value); }
  catch { throw new ControlPlaneError("invalid_request", "requestFingerprint is invalid"); }
}
function assertKeys(body: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new ControlPlaneError("invalid_request", "Unknown control-plane field");
  }
}
const TARGET_KEYS = ["area", "scope", "cwd", "deviceId", "sessionId"];
const POST_KEYS = [...TARGET_KEYS, "operation", "changes", "expectedRevision", "expectedBootId", "dryRun", "confirm", "confirmationReason", "idempotencyKey", "requestFingerprint"];
const GET_KEYS = [...TARGET_KEYS, "receiptId", "idempotencyKey", "operation"];

// Reuse the session receipt store, with a disjoint deterministic target identity.
// The binding is independent of revision/boot so old receipts remain queryable.
function receiptTarget(deviceId: string, target: SettingsTarget): string {
  return `config:${controlRequestFingerprint({ deviceId, ...target })}`;
}
function publicReceipt(receipt: Awaited<ReturnType<typeof readControlReceipt>>) {
  if (!receipt) return null;
  return publicControlReceipt(receipt);
}
function replayResponse(replay: Awaited<ReturnType<typeof reserveControlReceipt>>) {
  const outcome = replay.receipt.outcome;
  const conflict = replay.conflict || outcome === "conflict";
  const failed = outcome === "failed" || outcome === "aborted";
  return { success: !conflict && !failed && outcome !== "unknown", accepted: !conflict && !failed,
    outcome, receipt: publicReceipt(replay.receipt), replayed: replay.replayed,
    ...(conflict ? { code: "idempotency_conflict" } : {}),
    status: conflict || failed ? 409 : outcome === "unknown" || outcome === "accepted" || outcome === "running" ? 202 : 200 };
}
function knownError(error: unknown): { code: string; message: string; status: number } {
  const e = error as { code?: unknown; status?: unknown };
  if (error instanceof Error && typeof e.code === "string" && typeof e.status === "number") {
    return { code: e.code, message: String(redactLiveValue(error.message)), status: e.status };
  }
  return { code: "control_plane_unknown", message: "Reader could not establish the configuration write outcome; inspect the receipt before retrying", status: 500 };
}

/** Owner-authenticated Reader API boundary; it never grants authority from caller headers. */
export function createControlPlane(deps: ControlPlaneDependencies) {
  let active = 0;
  async function targetOf(body: Record<string, unknown>): Promise<SettingsTarget> {
    if (text(body.deviceId, "deviceId") !== deps.deviceId()) throw new ControlPlaneError("device_mismatch", "This Reader does not own the requested device", 403);
    if (body.sessionId !== undefined && body.sessionId !== null) throw new ControlPlaneError("unsupported_scope", "Configuration operations are not session operations");
    const area = text(body.area, "area", 80);
    if (!/^[a-z][a-z0-9_]*$/.test(area)) throw new ControlPlaneError("invalid_request", "Invalid area");
    if (body.scope !== "global" && body.scope !== "project") throw new ControlPlaneError("invalid_request", "An explicit global or project scope is required");
    if (body.cwd === undefined && ["models_default", "models_enabled", "skills_policy", "plugins", "subagent_profiles"].includes(area)) {
      throw new ControlPlaneError("cwd_required", "This settings area requires an explicit cwd");
    }
    const cwd = body.cwd === undefined && body.scope === "global" ? deps.globalCwd() : text(body.cwd, "cwd", 2000);
    if (!isAbsolute(cwd) || resolve(cwd) !== cwd) throw new ControlPlaneError("invalid_request", "cwd must be an absolute normalized directory");
    if (!(await deps.authorizeCwd(cwd))) throw new ControlPlaneError("cwd_denied", "The directory is not available", 403);
    return { area, scope: body.scope, cwd };
  }
  function snapshot(target: SettingsTarget, value: SettingsSnapshot) {
    return {
      schemaVersion: 1, deviceId: deps.deviceId(), sessionId: null, area: target.area, scope: target.scope, cwdRef: controlRequestFingerprint(target.cwd),
      bootId: deps.bootId(), ...value, value: redactLiveValue(value.value), impact: redactLiveValue(value.impact),
      authorization: { source: "reader-owner-policy", scope: "config:write", callerScopedGrants: false },
      runtimeStartAttempted: false,
    };
  }
  async function get(body: Record<string, unknown>) {
    assertKeys(body, GET_KEYS);
    const target = await targetOf(body);
    if (body.receiptId !== undefined || body.idempotencyKey !== undefined) {
      const receiptId = body.receiptId === undefined ? undefined : text(body.receiptId, "receiptId", 200);
      const idempotencyKey = body.idempotencyKey === undefined ? undefined : idempotencyKeyOf(body.idempotencyKey);
      const operation = body.operation === undefined ? undefined : text(body.operation, "operation", 80);
      if (!receiptId && !operation) throw new ControlPlaneError("invalid_request", "operation is required for a key lookup");
      const receipt = await readControlReceipt({ deviceId: deps.deviceId(), sessionId: receiptTarget(deps.deviceId(), target), receiptId, idempotencyKey, operation });
      return { schemaVersion: 1, deviceId: deps.deviceId(), area: target.area, scope: target.scope, bootId: deps.bootId(), cwdRef: body.cwd === undefined ? null : controlRequestFingerprint(target.cwd), receipt: publicReceipt(receipt), outcome: receipt?.outcome ?? "unknown", ...(receipt ? {} : { code: "receipt_not_found", nextAction: "verify_original_target_and_key_before_retry" }), readOnly: true, runtimeStartAttempted: false };
    }
    return { ...snapshot(target, await deps.inspectSettings(target)), cwdRef: body.cwd === undefined ? null : controlRequestFingerprint(target.cwd), readOnly: true };
  }
  async function post(body: Record<string, unknown>, caller: string | null = null) {
    assertKeys(body, POST_KEYS);
    const target = await targetOf(body);
    const operation = text(body.operation, "operation", 80);
    if (!record(body.changes)) throw new ControlPlaneError("invalid_request", "changes must be an object");
    for (const name of ["dryRun", "confirm"]) {
      if (body[name] !== undefined && typeof body[name] !== "boolean") throw new ControlPlaneError("invalid_request", `${name} must be boolean`);
    }
    const dryRun = body.dryRun !== false;
    if (dryRun) {
      await deps.validateSettingsChange({ ...target, operation, changes: body.changes });
      const observed = await deps.inspectSettings(target);
      if (!observed.supportedOperations.includes(operation)) throw new ControlPlaneError("unsupported_operation", "The settings owner does not support this operation", 422);
      return { success: true, accepted: false, outcome: "dry_run", sideEffect: "none", snapshot: { ...snapshot(target, observed), cwdRef: body.cwd === undefined ? null : controlRequestFingerprint(target.cwd) } };
    }
    if (body.confirm !== true) throw new ControlPlaneError("confirmation_required", "confirm=true is required", 403);
    const confirmationReason = text(body.confirmationReason, "confirmationReason", 500);
    const idempotencyKey = idempotencyKeyOf(body.idempotencyKey);
    const clientRequestFingerprint = fingerprintOf(body.requestFingerprint);
    const expectedRevision = text(body.expectedRevision, "expectedRevision", 256);
    const expectedBootId = text(body.expectedBootId, "expectedBootId", 160);
    const binding = { deviceId: deps.deviceId(), sessionId: receiptTarget(deps.deviceId(), target), operation, idempotencyKey };
    const fingerprint = controlRequestFingerprint({ ...target, operation, changes: body.changes, expectedRevision, expectedBootId, confirmationReason });
    // Replays are checked before current boot/revision: a completed write changed
    // the revision by definition. Replaying never performs the business mutation.
    const prior = await readControlReceipt(binding);
    if (prior) {
      const replay = await reserveControlReceipt({ ...binding, requestFingerprint: fingerprint, cwd: target.cwd, bootId: deps.bootId() });
      return replayResponse(replay);
    }
    if (expectedBootId !== deps.bootId()) throw new ControlPlaneError("boot_changed", "Reader restarted; inspect the target before a new write", 409);
    await deps.validateSettingsChange({ ...target, operation, changes: body.changes });
    const observed = await deps.inspectSettings(target);
    if (!observed.supportedOperations.includes(operation)) throw new ControlPlaneError("unsupported_operation", "The settings owner does not support this operation", 422);
    const reserved = await reserveControlReceipt({ ...binding, requestFingerprint: fingerprint, clientRequestFingerprint, cwd: target.cwd, bootId: deps.bootId(), revision: expectedRevision,
      audit: { kind: "configuration", area: target.area, scope: target.scope, callerRef: controlRequestFingerprint(caller ?? "reader-owner"), authority: "reader-owner-policy", targetRef: controlRequestFingerprint(target), confirmationReasonRef: controlRequestFingerprint(confirmationReason) },
    });
    if (reserved.conflict || reserved.replayed) return replayResponse(reserved);
    const receiptId = reserved.receipt.receiptId;
    try {
      await updateControlReceipt(receiptId, { outcome: "running", startedAt: new Date().toISOString(), nextAction: "inspect_configuration_receipt" });
      const result = await deps.mutateSettings({ ...target, operation, changes: body.changes, expectedRevision });
      // No configuration values, prompts, paths, or caller-provided reason enter
      // the audit. The existing durable receipt is the sole lifecycle authority.
      const receipt = await updateControlReceipt(receiptId, { outcome: "completed", completedAt: new Date().toISOString(), revision: result.revision, response: { changed: result.changed, impact: redactLiveValue(result.impact), revision: result.revision }, nextAction: "none" });
      if (!receipt) throw new Error("Configuration receipt disappeared");
      return { success: true, accepted: true, outcome: receipt.outcome, receipt: publicReceipt(receipt), snapshot: { ...snapshot(target, result), cwdRef: body.cwd === undefined ? null : controlRequestFingerprint(target.cwd) } };
    } catch (error) {
      const failure = knownError(error);
      const outcome = failure.status < 500 ? "failed" : "unknown";
      try {
        const receipt = await updateControlReceipt(receiptId, { outcome, completedAt: new Date().toISOString(), error: { code: failure.code, message: failure.message }, nextAction: outcome === "unknown" ? "inspect_configuration_before_retry" : "inspect_configuration" });
        if (!receipt) throw new Error("Configuration receipt disappeared");
        return { success: false, accepted: outcome === "unknown", outcome, code: failure.code, error: failure.message, receipt: publicReceipt(receipt), status: failure.status };
      } catch {
        // Do not fabricate a durable terminal receipt when the audit disk failed.
        // The accepted identity still lets the caller query after recovery.
        return { success: false, accepted: true, outcome: "unknown", code: "receipt_persistence_unknown", receiptId,
          receipt: publicReceipt(reserved.receipt), receiptPersistence: "unknown", nextAction: "inspect_configuration_receipt_before_retry", status: 503 };
      }
    }
  }
  async function dispatch(method: "GET" | "POST", body: Record<string, unknown>, caller?: string | null) {
    // No waiting queue or unbounded per-caller map. Transport callers all share
    // the existing authenticated owner; caller labels are never ACL claims.
    if (active >= 8) return { status: 429, body: { code: "rate_limited", retryAfterMs: 1000 } };
    active++;
    try {
      const result = method === "GET" ? await get(body) : await post(body, caller);
      const status = "status" in result ? result.status as number : "code" in result && result.code === "idempotency_conflict" ? 409 : 200;
      return { status, body: result };
    } catch (error) {
      const failure = knownError(error);
      return { status: failure.status, body: { success: false, accepted: false, outcome: failure.status >= 500 ? "unknown" : failure.status === 409 ? "conflict" : "blocked", ...failure } };
    } finally { active--; }
  }
  return { dispatch };
}

/** Bound body readers before parsing; a disconnected/slow caller cannot hold a slot indefinitely. */
export async function readControlPlaneJson(req: Request, timeoutMs = 10_000, maxBytes = 32 * 1024): Promise<Record<string, unknown>> {
  if (!req.body) throw new ControlPlaneError("invalid_request", "Missing body");
  const reader = req.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (error: Error) => void = () => {};
  const abort = () => rejectAbort(new ControlPlaneError("request_cancelled", "Request cancelled", 408));
  const stopped = new Promise<never>((_, reject) => {
    rejectAbort = reject;
    timer = setTimeout(() => reject(new ControlPlaneError("request_timeout", "Request body deadline exceeded", 408)), timeoutMs);
  });
  req.signal.addEventListener("abort", abort, { once: true });
  if (req.signal.aborted) abort();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), stopped]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new ControlPlaneError("request_too_large", "Request exceeds configuration budget", 413);
      chunks.push(part.value);
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new ControlPlaneError("invalid_request", "Invalid JSON body"); }
    if (!record(value)) throw new ControlPlaneError("invalid_request", "Expected a JSON object");
    return value;
  } finally {
    if (timer) clearTimeout(timer);
    req.signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
