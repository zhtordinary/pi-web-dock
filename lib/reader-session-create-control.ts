import { isAbsolute, resolve } from "node:path";
import { redactLiveValue } from "./live-agent-events";
import {
  isReaderCreateFailureDiagnostic,
  readerCreateFailureDiagnostic,
  readerCreateFailureStageForCode,
  type ReaderCreateFailureDiagnostic,
} from "./reader-create-diagnostics";
import {
  controlRequestFingerprint, readControlReceipt, reserveControlReceipt, publicControlReceipt,
  updateControlReceipt, validateControlFingerprint, validateControlIdempotencyKey,
  type ReaderControlReceipt,
} from "./reader-control-receipts";

type Result = { status: number; body: Record<string, unknown> };
type CreatedBinding = NonNullable<ReaderControlReceipt["createdSessionBinding"]>;
type CreateDiagnosticContext = { correlationId: string };
type Dependencies = {
  deviceId: () => string;
  bootId: () => string;
  validate: (body: Record<string, unknown>) => Promise<Result>;
  create: (body: Record<string, unknown>, onCreated: (binding: CreatedBinding) => Promise<void>, context: CreateDiagnosticContext) => Promise<Result>;
};
const CONTROL_KEYS = ["deviceId", "readerMcpControl", "idempotencyKey", "requestFingerprint", "dryRun", "confirm", "confirmationReason", "expectedBootId", "expectedRevision", "expectedQueueRevision"];
const CREATE_KEYS = ["type", "cwd", "toolNames", "strictToolAllowlist", "provider", "modelId", "thinkingLevel", "fastMode", "autoCompactionEnabled", "contextSourceSessionId"];
const MANAGED_CREATE_FAILURE_CODES = new Set([
  "create_outcome_unknown",
  "create_runtime_failed",
  "create_runtime_response_unverified",
  "create_request_revalidation_failed",
  "create_runtime_start_failed",
  "create_binding_persistence_failed",
  "create_runtime_setup_failed",
  "create_runtime_state_failed",
  "create_initial_command_failed",
]);
class CreateControlError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
function text(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new CreateControlError(`invalid_${field}`);
  return value;
}
function response(receipt: ReaderControlReceipt, replayed: boolean, conflict = false): Result {
  const completed = receipt.outcome === "completed";
  const unknown = receipt.outcome === "unknown";
  // Only a completed durable receipt authorizes returning a successful create.
  // An in-flight/unknown reservation can expose its known binding for inspection,
  // but must never look like permission to reopen or create another runtime.
  return { status: conflict ? 409 : completed ? 200 : 202, body: {
    ...(completed ? redactLiveValue(receipt.response) as Record<string, unknown> : {}),
    success: completed && !conflict, accepted: !conflict, outcome: conflict ? "conflict" : receipt.outcome,
    ...(completed ? { sessionId: receipt.createdSessionId } : {}),
    receipt: publicControlReceipt(receipt), replayed, runtimeStartAttempted: !replayed && !conflict,
    ...(conflict ? { code: "idempotency_conflict" } : unknown ? {
      code: replayed ? "prior_attempt_unknown"
        : typeof receipt.error?.code === "string" && MANAGED_CREATE_FAILURE_CODES.has(receipt.error.code) ? receipt.error.code
          : "create_outcome_unknown",
    } : {}),
  } };
}

/** A façade over Reader's existing creation API and existing durable receipts. */
export function createManagedSessionControl(deps: Dependencies) {
  return async (input: Record<string, unknown>): Promise<Result> => {
    let receipt: ReaderControlReceipt | undefined;
    let attempted = false;
    let failureDiagnostic: ReaderCreateFailureDiagnostic | undefined;
    try {
      if (Object.keys(input).some((key) => ![...CONTROL_KEYS, ...CREATE_KEYS].includes(key))) throw new CreateControlError("invalid_create_field");
      if (input.type !== "ensure_session") throw new CreateControlError("unsupported_managed_create_operation");
      const deviceId = deps.deviceId();
      if (input.deviceId !== undefined && input.deviceId !== deviceId) throw new CreateControlError("device_mismatch", 409);
      if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") throw new CreateControlError("invalid_dry_run");
      const cwd = text(input.cwd, "cwd", 2000);
      if (!isAbsolute(cwd) || resolve(cwd) !== cwd) throw new CreateControlError("invalid_cwd");
      if (input.toolNames !== undefined && (!Array.isArray(input.toolNames) || input.toolNames.some((name) => !["read", "grep", "find", "ls"].includes(String(name))) || new Set(input.toolNames).size !== input.toolNames.length || input.strictToolAllowlist !== true)) throw new CreateControlError("invalid_managed_tool_allowlist");
      const body = Object.fromEntries(Object.entries(input).filter(([key]) => CREATE_KEYS.includes(key)));
      const fingerprint = controlRequestFingerprint({ deviceId, operation: "create_session", body,
        confirmationReason: input.confirmationReason ?? null,
        expectedBootId: input.expectedBootId ?? null,
        expectedRevision: input.expectedRevision ?? null,
        expectedQueueRevision: input.expectedQueueRevision ?? null,
      });
      const dryRun = input.dryRun !== false;
      if (!dryRun && input.confirm !== true) throw new CreateControlError("confirmation_required", 403);
      if (!dryRun) text(input.confirmationReason, "confirmation_reason", 500);
      let idempotencyKey = "";
      let clientRequestFingerprint: string | undefined;
      try {
        if (!dryRun) idempotencyKey = validateControlIdempotencyKey(input.idempotencyKey);
        clientRequestFingerprint = validateControlFingerprint(input.requestFingerprint);
      } catch { throw new CreateControlError("invalid_control_identity", 400); }
      const binding = { deviceId, sessionId: "new", operation: "create_session", idempotencyKey };
      // Mutable cwd/workspace/boot preconditions are checked only for the first
      // attempt. Replays after restart still return the original creation.
      if (!dryRun && await readControlReceipt(binding)) {
        const prior = await reserveControlReceipt({ ...binding, requestFingerprint: fingerprint, cwd, bootId: deps.bootId() });
        return response(prior.receipt, true, prior.conflict);
      }
      if (input.expectedBootId !== undefined && text(input.expectedBootId, "expected_boot", 128) !== deps.bootId()) throw new CreateControlError("boot_changed", 409);
      // There is no runtime revision/queue before a new session exists. Never
      // silently discard a CAS condition supplied for an existing runtime.
      if (input.expectedRevision !== undefined || input.expectedQueueRevision !== undefined) throw new CreateControlError("unsupported_create_revision");
      const validated = await deps.validate(body);
      if (validated.status !== 200) return { ...validated, body: { ...(redactLiveValue(validated.body) as Record<string, unknown>), accepted: false, runtimeStartAttempted: false, writeSideEffects: false } };
      if (dryRun) return { status: 200, body: { success: true, accepted: false, outcome: "dry_run", target: { deviceId, sessionId: "new", cwdRef: controlRequestFingerprint(cwd) }, bootId: deps.bootId(), runtimeStartAttempted: false, writeSideEffects: false } };
      const reservation = await reserveControlReceipt({ ...binding, requestFingerprint: fingerprint, clientRequestFingerprint, cwd, bootId: deps.bootId(), audit: { kind: "creation", callerRef: controlRequestFingerprint("reader-owner"), authority: "reader-owner-policy", targetRef: fingerprint, confirmationReasonRef: controlRequestFingerprint(input.confirmationReason) } });
      receipt = reservation.receipt;
      if (reservation.replayed || reservation.conflict) return response(receipt, reservation.replayed, reservation.conflict);
      const running = await updateControlReceipt(receipt.receiptId, { outcome: "running", startedAt: new Date().toISOString() });
      if (!running) throw new Error("Missing reserved creation receipt");
      receipt = running;
      attempted = true;
      const result = await deps.create(body, async (created) => {
        if (!created.sessionId || created.sessionId === "new" || created.deviceId !== deviceId || !isAbsolute(created.cwd)) throw new Error("Invalid created runtime binding");
        const updated = await updateControlReceipt(receipt!.receiptId, { createdSessionId: created.sessionId, createdSessionBinding: created });
        if (!updated) throw new Error("Missing creation receipt while binding runtime");
        receipt = updated;
      }, { correlationId: receipt.receiptId });
      if (result.status !== 200 || result.body.success !== true || result.body.sessionId !== receipt.createdSessionId) {
        failureDiagnostic = isReaderCreateFailureDiagnostic(result.body.failureDiagnostic, receipt.receiptId)
          ? result.body.failureDiagnostic
          : undefined;
        const reportedCode = typeof result.body.code === "string" && MANAGED_CREATE_FAILURE_CODES.has(result.body.code)
          ? result.body.code
          : undefined;
        const code = result.status === 200 && result.body.success === true
          ? "create_runtime_response_unverified"
          : reportedCode ?? "create_runtime_failed";
        throw new CreateControlError(code, 503);
      }
      // Managed create is ensure_session only: do not persist arbitrary command
      // outputs, prompts, or get_state/systemPrompt in its durable response.
      const savedResponse = Object.fromEntries(["success", "sessionId", "sessionBootId", "model", "thinkingLevel", "fastMode", "branchPosition", "autoCompactionEnabled"].filter((key) => key in result.body).map((key) => [key, result.body[key]]));
      if (Buffer.byteLength(JSON.stringify(savedResponse)) > 16 * 1024) throw new Error("Creation response exceeded its receipt budget");
      const completed = await updateControlReceipt(receipt.receiptId, { outcome: "completed", completedAt: new Date().toISOString(), response: savedResponse, nextAction: "inspect_created_session" });
      if (!completed) throw new Error("Creation completion receipt was not persisted");
      return response(completed, false);
    } catch (error) {
      if (receipt) {
        try {
          const failureCode = error instanceof CreateControlError && MANAGED_CREATE_FAILURE_CODES.has(error.code)
            ? error.code
            : "create_outcome_unknown";
          const diagnostic = failureDiagnostic ?? readerCreateFailureDiagnostic(
            receipt.receiptId,
            readerCreateFailureStageForCode(failureCode) ?? "control",
            error,
          );
          const uncertain = await updateControlReceipt(receipt.receiptId, { outcome: "unknown", error: {
            code: failureCode,
            message: "Reader could not confirm the creation result; inspect the original receipt and binding before any further creation",
            diagnostic,
          }, nextAction: "inspect_original_creation_before_retry" });
          if (uncertain) return response(uncertain, false);
        } catch { /* Keep the original durable reservation; never invent a terminal receipt. */ }
        return { status: 503, body: { success: false, accepted: attempted, outcome: "unknown", code: "creation_receipt_persistence_unknown", receipt: publicControlReceipt(receipt), receiptId: receipt.receiptId, receiptPersistence: "unknown", runtimeStartAttempted: attempted } };
      }
      const known = error instanceof CreateControlError;
      return { status: known ? error.status : 503, body: { success: false, accepted: false, outcome: "blocked", code: known ? error.code : "creation_receipt_unavailable", runtimeStartAttempted: false, writeSideEffects: false } };
    }
  };
}
