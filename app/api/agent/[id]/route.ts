import { NextResponse } from "next/server";
import { readQueueRecallResult, replayQueueRecall, acknowledgeQueueRecall, type QueueRecallIdentity } from "@/lib/queue-recall-store";
import { resolveSessionPath } from "@/lib/session-reader";
import { forkPersistedSessionFromFile, startRpcSession, getRpcSession, setRpcSessionTools, assertRpcSessionRuntimeBinding } from "@/lib/rpc-manager";
import { validateSessionToolSelection } from "@/lib/session-tool-selection";
import { matchesExpectedLeaf } from "@/lib/branch-navigation";
import { localDeviceIdentity, readActivityConfig } from "@/lib/activity-peers";
import { samePath } from "@/lib/paths";
import { redactLiveValue } from "@/lib/live-agent-events";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import {
  controlRequestFingerprint,
  publicControlReceipt,
  reserveControlReceipt,
  readControlReceipt,
  updateControlReceipt,
  validateControlFingerprint,
  validateControlIdempotencyKey,
} from "@/lib/reader-control-receipts";

// Only explicit writes (or deliberate System-panel initialization) may create a runtime.
const RUNTIME_START_COMMANDS = new Set([
  "initialize_runtime", "prompt", "steer", "follow_up", "peer_message",
  "set_tools", "set_model", "set_thinking_level", "set_fast_mode", "set_unattended", "set_session_name", "set_auto_retry",
  "retry_continue", "retry_continue_only", "compact", "navigate_tree", "fork", "clone", "reload", "bash",
  "analyze_question", "analyze_question_draft", "rewrite_question", "rewrite_ste100",
]);

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let commandType: string | undefined;
  let promptAccepted = false;
  let expectedRetryRun = false;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;
    expectedRetryRun = body.type === "retry_continue" && Object.hasOwn(body, "expectedRunId");
    const managedControl = typeof body.idempotencyKey === "string"
      || typeof body.requestFingerprint === "string"
      || body.readerMcpControl === true;
    const requestedToolNames = body.toolNames;
    if (
      requestedToolNames !== undefined
      && (!Array.isArray(requestedToolNames) || requestedToolNames.some((name) => typeof name !== "string"))
    ) {
      throw new Error("toolNames must be an array of strings");
    }
    const toolNames = requestedToolNames as string[] | undefined;
    const requestedStrictToolAllowlist = body.strictToolAllowlist;
    if (requestedStrictToolAllowlist !== undefined && typeof requestedStrictToolAllowlist !== "boolean") {
      throw new Error("strictToolAllowlist must be boolean");
    }
    if (requestedStrictToolAllowlist === true) {
      if (toolNames === undefined) throw new Error("strictToolAllowlist requires an explicit toolNames allow-list");
      validateSessionToolSelection(toolNames);
    }

    // MCP/managed writes are deliberately live-only. The ordinary Reader UI
    // keeps its historical reopen behavior, but a control request carrying an
    // idempotency contract must never turn a read/control race into a wake.
    const existing = getRpcSession(id);
    if (managedControl) {
      if (!isApiRequestAllowed(req)) return NextResponse.json({ code: "request_denied", accepted: false, runtimeStartAttempted: false, writeSideEffects: false }, { status: 403 });
      if (!hasJsonContentType(req)) return NextResponse.json({ code: "content_type", accepted: false, runtimeStartAttempted: false, writeSideEffects: false }, { status: 415 });
      return await handleManagedControl(id, body, existing);
    }

    if ((commandType?.startsWith("get_") || body.type === "set_auto_compaction") && !existing?.isAlive()) {
      return NextResponse.json({
        error: "Reader runtime is not live", code: "runtime_not_live", accepted: false,
        runtimeStartAttempted: false, writeSideEffects: false,
      }, { status: 409 });
    }
    if (body.type === "extension_ui_response" && (!isApiRequestAllowed(req) || !hasJsonContentType(req))) {
      return NextResponse.json({ code: "request_denied", accepted: false }, { status: 403 });
    }
    if (body.type === "extension_ui_response" && !existing?.isAlive()) {
      return NextResponse.json({ error: "Request runtime is no longer live", code: "ui_request_expired", accepted: false, runtimeStartAttempted: false }, { status: 409 });
    }

    if (body.type === "ack_queue_recall") {
      if (typeof body.queueRecallOperationId !== "string") return NextResponse.json({ error: "A recall operation ID is required", code: "invalid_queue_recall_operation", accepted: false }, { status: 400 });
      const ids = await acknowledgeQueueRecall(id, body.queueRecallOperationId, body.expectedQueueIdentity as QueueRecallIdentity);
      for (const receiptId of ids) existing?.releaseControlReceiptBinding(receiptId);
      return NextResponse.json({ success: true, data: { acknowledged: true } });
    }

    // Recall retries read their committed result even after runtime eviction.
    // They must never rehydrate a session or clear a newly created queue.
    if (body.type === "clear_queue" && typeof body.queueRecallOperationId === "string") {
      const replay = readQueueRecallResult(id, body.queueRecallOperationId, body.expectedQueueIdentity as QueueRecallIdentity);
      if (replay) return NextResponse.json({ success: true, data: existing?.isAlive()
        ? await existing.send(body)
        : await replayQueueRecall(id, body.queueRecallOperationId, body.expectedQueueIdentity as QueueRecallIdentity) });
      if (!existing?.isAlive()) return NextResponse.json({ error: "The original queue runtime is no longer live", code: "queue_runtime_not_live", accepted: false }, { status: 409 });
    }

    if (!existing?.isAlive() && !RUNTIME_START_COMMANDS.has(body.type)) {
      return NextResponse.json({ error: "This operation cannot initialize a runtime", code: "unsupported_operation", accepted: false, runtimeStartAttempted: false }, { status: 400 });
    }
    if ((!existing?.isAlive() || body.type === "initialize_runtime")
      && (!isApiRequestAllowed(req) || !hasJsonContentType(req))) {
      return NextResponse.json({ code: "request_denied", accepted: false, runtimeStartAttempted: false }, { status: 403 });
    }
    const command = body.type === "initialize_runtime" ? { ...body, type: "get_state" } : body;

    // Fast path: already-running session
    if (body.type === "set_tools") {
      const filePath = existing?.sessionFile || await resolveSessionPath(id) || undefined;
      if (!existing?.isAlive() && !filePath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      const changed = await setRpcSessionTools(id, filePath, toolNames, requestedStrictToolAllowlist);
      return NextResponse.json({
        success: true,
        data: { sessionId: changed.sessionId, recreated: changed.recreated },
      });
    }
    // Forking a cold session is a file operation. Do not wake the full Reader
    // runtime just to copy a persisted branch; the live path above still uses
    // the in-memory session manager so an active session forks from its latest
    // state.
    if (body.type === "fork" && !existing?.isAlive() && !existing?.isShuttingDown()) {
      const filePath = await resolveSessionPath(id);
      if (!filePath) {
        return NextResponse.json({
          error: "Session not found",
          code: "session_missing",
          reason: "session_missing",
          accepted: false,
        }, { status: 404 });
      }
      const result = await forkPersistedSessionFromFile(
        id,
        filePath,
        typeof body.entryId === "string" ? body.entryId : "",
      );
      return NextResponse.json({ success: true, data: result });
    }

    if (existing?.isAlive()) {
      await assertRpcSessionRuntimeBinding(existing);
      if (body.type === "initialize_runtime") await existing.waitUntilReady?.();
      const result = await existing.send(command);
      promptAccepted = body.type === "prompt";
      return NextResponse.json({ success: true, data: result });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({
        error: "Session not found",
        code: "session_missing",
        reason: "session_missing",
        accepted: false,
      }, { status: 404 });
    }

    const { session } = await startRpcSession(id, filePath, undefined, {
      ...(toolNames !== undefined ? { toolNames } : {}),
      ...(requestedStrictToolAllowlist !== undefined ? { strictToolAllowlist: requestedStrictToolAllowlist } : {}),
    });
    if (body.type === "initialize_runtime") await session.waitUntilReady?.();
    const result = await session.send(command);
    promptAccepted = body.type === "prompt";

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["session_runtime_owned", "session_archived"].includes(String(error.code))) {
      return NextResponse.json({
        error: redactLiveValue(error instanceof Error ? error.message : String(error)),
        code: String(error.code), accepted: false,
        ...("owner" in error ? { owner: error.owner } : {}),
      }, { status: 409 });
    }
    return NextResponse.json({
      error: redactLiveValue(error instanceof Error ? error.message : String(error)),
      ...(commandType === "extension_ui_response" && error && typeof error === "object" && "code" in error ? { code: String(error.code), accepted: false } : {}),
      ...(commandType === "clear_queue" && error && typeof error === "object" && "code" in error ? {
        code: String(error.code),
        ...(["queue_revision_conflict", "queue_admission_pending", "queue_identity_unavailable", "invalid_queue_recall_operation", "queue_contains_non_user_messages", "queue_recall_store_full"].includes(String(error.code)) ? { accepted: false } : {}),
      } : {}),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
      ...(commandType === "retry_continue_only"
        ? { code: error && typeof error === "object" && "code" in error ? String(error.code) : "retry_rejected", accepted: false }
        : {}),
      ...(commandType === "retry_continue" && expectedRetryRun
        ? { code: error && typeof error === "object" && "code" in error ? String(error.code) : "retry_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}

const MANAGED_CONTROL_TYPES = new Set(["prompt", "continue", "steer", "follow_up", "abort", "stop", "clear_queue", "set_model", "set_tools", "answer_question"]);

function optionalBoundedControlText(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\0\r\n]/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

async function handleManagedControl(
  sessionId: string,
  body: Record<string, unknown>,
  existing: ReturnType<typeof getRpcSession>,
): Promise<Response> {
  const requestedType = typeof body.type === "string" ? body.type : "";
  if (!MANAGED_CONTROL_TYPES.has(requestedType)) {
    return NextResponse.json({ error: "Unsupported managed control operation", code: "unsupported_operation" }, { status: 400 });
  }
  if (["prompt", "continue", "steer", "follow_up"].includes(requestedType)
    && (typeof body.message !== "string" || !body.message.trim())) {
    return NextResponse.json({ error: `${requestedType} requires a non-empty message`, code: "message_required" }, { status: 400 });
  }
  if (requestedType === "answer_question") {
    if (typeof body.questionId !== "string" || !body.questionId.trim()) {
      return NextResponse.json({ error: "answer_question requires a non-empty questionId", code: "question_id_required" }, { status: 400 });
    }
  }

  // Validate optional multimodal images for prompt/continue/steer/follow_up
  let validatedImages: Array<{ type: "image"; data: string; mimeType: string }> | undefined;
  if (body.images !== undefined) {
    if (!["prompt", "continue", "steer", "follow_up"].includes(requestedType)) {
      return NextResponse.json({ error: "images is only supported for prompt, continue, steer, or follow_up", code: "images_not_supported" }, { status: 400 });
    }
    if (!Array.isArray(body.images) || body.images.length > 5) {
      return NextResponse.json({ error: "images must be an array of at most 5 items", code: "invalid_images" }, { status: 400 });
    }
    const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
    for (const img of body.images) {
      if (!img || typeof img !== "object" || typeof (img as Record<string, unknown>).data !== "string" || !(img as Record<string, unknown>).data) {
        return NextResponse.json({ error: "each image must have non-empty data", code: "invalid_images" }, { status: 400 });
      }
      const mime = (img as Record<string, unknown>).mimeType;
      if (typeof mime !== "string" || !ALLOWED_MIME_TYPES.has(mime)) {
        return NextResponse.json({ error: "each image must have a valid mimeType (png, jpeg, webp, gif)", code: "invalid_images" }, { status: 400 });
      }
      if (((img as Record<string, unknown>).data as string).length > 8 * 1024 * 1024) {
        return NextResponse.json({ error: "single image size must not exceed 8MB", code: "image_too_large" }, { status: 400 });
      }
    }
    validatedImages = (body.images as Array<Record<string, unknown>>).map((img) => ({
      type: "image" as const,
      data: img.data as string,
      mimeType: img.mimeType as string,
    }));
  }
  if (!existing?.isAlive()) {
    return NextResponse.json({
      error: "Reader runtime is not live; managed control will not wake or rehydrate it",
      code: "runtime_not_live",
      accepted: false,
      runtimeStartAttempted: false,
      writeSideEffects: false,
    }, { status: 409 });
  }

  const localDeviceId = localDeviceIdentity(readActivityConfig(), new Date().toISOString()).id;
  if (body.deviceId !== undefined && body.deviceId !== localDeviceId) {
    return NextResponse.json({ error: "deviceId does not match this Reader host", code: "device_mismatch", accepted: false }, { status: 409 });
  }
  if (body.cwd !== undefined && (typeof body.cwd !== "string" || !samePath(body.cwd, existing.cwd))) {
    return NextResponse.json({ error: "cwd does not match the live Reader runtime", code: "cwd_mismatch", accepted: false }, { status: 409 });
  }

  try {
    await assertRpcSessionRuntimeBinding(existing);
    const identity = existing.getLiveRuntimeIdentity();
    const expectedBootId = optionalBoundedControlText(body.expectedBootId, "expectedBootId", 128);
    const expectedRevision = optionalBoundedControlText(body.expectedRevision, "expectedRevision", 256);
    const expectedLeafId = optionalBoundedControlText(body.expectedLeafId, "expectedLeafId", 256);
    const expectedQueueRevision = optionalBoundedControlText(body.expectedQueueRevision, "expectedQueueRevision", 256);
    const setting = requestedType === "set_model" || requestedType === "set_tools";
    if (setting && (body.deviceId !== localDeviceId || typeof body.cwd !== "string")) return NextResponse.json({ code: "setting_binding_required", accepted: false }, { status: 400 });
    if (setting && (!expectedBootId || !expectedRevision)) return NextResponse.json({ code: "setting_revision_required", accepted: false }, { status: 400 });
    if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
      return NextResponse.json({ code: "invalid_dry_run", accepted: false, writeSideEffects: false }, { status: 400 });
    }
    const dryRun = body.dryRun !== false;
    const checkPreconditions = (): Response | null => {
      if (["abort", "stop"].includes(requestedType) && !existing.getActiveControlRunId()) {
        return NextResponse.json({ code: "no_active_run", accepted: false, runtimeStartAttempted: false, writeSideEffects: false }, { status: 409 });
      }
      if (expectedLeafId !== undefined && !matchesExpectedLeaf(existing.inner.sessionManager, expectedLeafId)) {
        return NextResponse.json({
          error: "Reader branch position changed",
          code: "branch_position_changed",
          accepted: false,
          runtimeStartAttempted: false,
          writeSideEffects: false,
        }, { status: 409 });
      }
      if (expectedBootId !== undefined && expectedBootId !== identity.bootId) {
        return NextResponse.json({ error: "Reader runtime boot changed", code: "boot_changed", bootId: identity.bootId, accepted: false }, { status: 409 });
      }
      if (expectedRevision !== undefined && expectedRevision !== identity.revision) {
        return NextResponse.json({ error: "Reader runtime revision changed", code: "revision_conflict", revision: identity.revision, accepted: false }, { status: 409 });
      }
      if (setting) existing.validateManagedSetting(body);
      const queueIdentity = existing.getQueueIdentity();
      if (requestedType === "clear_queue" && !dryRun && expectedQueueRevision === undefined) {
        return NextResponse.json({ error: "expectedQueueRevision is required for clear_queue", code: "queue_revision_required", accepted: false }, { status: 400 });
      }
      if (expectedQueueRevision !== undefined && expectedQueueRevision !== queueIdentity.revision) {
        return NextResponse.json({ error: "Reader queue revision changed", code: "queue_revision_conflict", queueRevision: queueIdentity.revision, accepted: false }, { status: 409 });
      }
      return null;
    };
    if (dryRun) {
      const conflict = checkPreconditions();
      if (conflict) return conflict;
      const queueIdentity = existing.getQueueIdentity();
      return NextResponse.json({
        success: true,
        accepted: false,
        outcome: "dry_run",
        sideEffect: "none",
        target: { deviceId: localDeviceId, sessionId },
        bootId: identity.bootId,
        revision: identity.revision,
        queueRevision: queueIdentity.revision,
        queueCounts: queueIdentity.counts,
        runtimeStartAttempted: false,
        writeSideEffects: false,
      });
    }
    if (body.confirm !== true) {
      return NextResponse.json({ error: "confirm=true is required for a managed write", code: "confirmation_required", accepted: false }, { status: 403 });
    }
    const confirmationReason = optionalBoundedControlText(body.confirmationReason, "confirmationReason", 500);
    if (!confirmationReason || !confirmationReason.trim()) {
      return NextResponse.json({ error: "confirmationReason is required for a managed write", code: "confirmation_reason_required", accepted: false }, { status: 400 });
    }
    const idempotencyKey = validateControlIdempotencyKey(body.idempotencyKey);
    const clientRequestFingerprint = validateControlFingerprint(body.requestFingerprint);
    const operation = requestedType === "continue" ? "prompt" : requestedType === "stop" ? "abort" : requestedType;
    const commandFingerprint: Record<string, unknown> = { ...body, type: operation };
    for (const key of [
      "idempotencyKey",
      "requestFingerprint",
      "expectedBootId",
      "expectedRevision",
      "confirm",
      "dryRun",
      "confirmationReason",
      "deviceId",
      "readerMcpControl",
    ]) delete commandFingerprint[key];
    const requestFingerprint = controlRequestFingerprint({
      operation,
      sessionId,
      cwd: existing.cwd,
      command: commandFingerprint,
      expectedBootId: expectedBootId ?? null,
      expectedRevision: expectedRevision ?? null,
      confirmationReason,
    });
    const reservation = {
      deviceId: localDeviceId,
      sessionId,
      operation,
      idempotencyKey,
      requestFingerprint,
      ...(clientRequestFingerprint ? { clientRequestFingerprint } : {}),
      cwd: existing.cwd,
      bootId: identity.bootId,
      revision: identity.revision,
    };
    // A repeat must recover the original receipt even after its successful
    // mutation changed the queue/runtime revision. Fingerprints still bind the
    // original preconditions; changing them with the same key is a conflict.
    const previous = await readControlReceipt({ deviceId: localDeviceId, sessionId, operation, idempotencyKey });
    if (previous) return managedReservationResponse(await reserveControlReceipt(reservation));
    const preconditionConflict = checkPreconditions();
    if (preconditionConflict) return preconditionConflict;
    const reserved = await reserveControlReceipt(reservation);
    if (reserved.conflict || reserved.replayed) {
      return managedReservationResponse(reserved);
    }

    const receipt = reserved.receipt;
    // Popup answers resolve an existing UI request; they do not enter the model
    // admission queue. Their result and terminal receipt are owned below.
    if (operation !== "clear_queue" && operation !== "answer_question" && !setting) existing.bindControlReceipt(receipt.receiptId, operation, { bootId: expectedBootId, revision: expectedRevision });
    let commandAcknowledged = false;
    try {
      let command: Record<string, unknown>;
      if (operation === "answer_question") {
        command = {
          type: "extension_ui_response",
          id: body.questionId,
          runtimeGeneration: body.runtimeGeneration,
          ...(typeof body.answer === "string" ? { value: body.answer } : typeof body.value === "string" ? { value: body.value } : {}),
          ...(typeof body.confirmed === "boolean" ? { confirmed: body.confirmed } : {}),
          ...(typeof body.cancelled === "boolean" ? { cancelled: body.cancelled } : {}),
        };
      } else {
        command = { ...body, type: operation };
        if (validatedImages?.length) {
          command.images = validatedImages;
        }
      }
      delete command.idempotencyKey;
      delete command.requestFingerprint;
      delete command.expectedBootId;
      delete command.expectedRevision;
      delete command.confirm;
      delete command.dryRun;
      delete command.confirmationReason;
      delete command.deviceId;
      delete command.readerMcpControl;
      command.readerControlReceiptId = receipt.receiptId;
      command.readerControlExpectedBootId = expectedBootId;
      command.readerControlExpectedRevision = expectedRevision;
      const result = setting
        ? await existing.sendManagedSetting(command, { bootId: expectedBootId!, revision: expectedRevision! })
        : await existing.send(command);
      commandAcknowledged = true;
      const safeResult = redactLiveValue(result);
      let updatedReceipt: Awaited<ReturnType<typeof updateControlReceipt>> = null;
      if (operation === "clear_queue" || operation === "answer_question" || setting) {
        updatedReceipt = await updateControlReceipt(receipt.receiptId, {
          outcome: "completed",
          completedAt: new Date().toISOString(),
          response: safeResult,
          ...(setting && result && typeof result === "object" && "revision" in result && typeof result.revision === "string" ? { revision: result.revision } : {}),
          nextAction: "none",
        });
      } else {
        updatedReceipt = await updateControlReceipt(receipt.receiptId, {
          outcome: "running",
          startedAt: new Date().toISOString(),
          response: safeResult,
          nextAction: "observe_receipt_or_live_events",
        });
      }
      // Abort acceptance is not a settled target. Only the actual runtime's
      // agent_end/prompt lifecycle can record aborted + targetStopped=true;
      // updateControlReceipt preserves that terminal fact if it raced us.
      if (!updatedReceipt) throw new Error("Reserved control receipt disappeared after acknowledgement");
      return NextResponse.json({ success: true, accepted: true, outcome: operation === "clear_queue" || setting ? updatedReceipt.outcome : "accepted", data: safeResult, receipt: publicControlReceipt(updatedReceipt), runtimeStartAttempted: false, writeSideEffects: true });
    } catch (error) {
      // A failed admission must not block later queue mutations indefinitely.
      const message = String(redactLiveValue(error instanceof Error ? error.message : String(error)));
      const queueErrorCode = error instanceof Error && "code" in error
        && (["queue_revision_conflict", "queue_admission_pending", "runtime_busy", "boot_changed", "revision_conflict", "no_active_run"].includes(String(error.code)) || String(error.code).startsWith("ui_")) ? String(error.code) : undefined;
      const queueConflict = queueErrorCode !== undefined;
      // A successful send may already have admitted asynchronous work before
      // the acknowledgement's receipt write fails. Preserve its lifecycle
      // binding and report unknown, never a fictitious failed admission.
      if (!commandAcknowledged) existing.releaseRejectedControlReceiptBinding(receipt.receiptId, queueConflict);
      // The original binding can still establish a real terminal fact. Do not
      // freeze its durable receipt as unknown before that lifecycle settles.
      if (existing.hasControlReceiptLifecycleBinding(receipt.receiptId)) {
        return NextResponse.json({ success: false, accepted: true, outcome: "unknown", code: "control_outcome_unknown", receiptId: receipt.receiptId,
          receipt: publicControlReceipt({ ...receipt, outcome: "unknown", nextAction: "observe_receipt_or_live_events" }),
          receiptPersistence: "unknown", runtimeStartAttempted: false, writeSideEffects: "unknown", nextAction: "inspect_receipt_and_runtime_before_retry" }, { status: 503 });
      }
      const uncertain = !queueConflict;
      let failed: Awaited<ReturnType<typeof updateControlReceipt>>;
      try {
        failed = await updateControlReceipt(receipt.receiptId, {
        outcome: queueConflict ? "conflict" : uncertain ? "unknown" : "failed",
        completedAt: new Date().toISOString(),
        error: { code: queueErrorCode ?? "reader_control_failed", message },
        nextAction: queueConflict ? "inspect_queue_before_retry" : "inspect_runtime_before_retry",
        });
      } catch {
        return NextResponse.json({ success: false, accepted: true, outcome: "unknown", code: "receipt_persistence_unknown", receiptId: receipt.receiptId, receiptPersistence: "unknown", runtimeStartAttempted: false, writeSideEffects: "unknown", nextAction: "inspect_receipt_and_runtime_before_retry" }, { status: 503 });
      }
      return NextResponse.json({
        error: message,
        code: queueErrorCode ?? (uncertain ? "control_outcome_unknown" : "control_failed"),
        outcome: uncertain ? "unknown" : queueConflict ? "conflict" : "failed",
        accepted: uncertain,
        receipt: failed ? publicControlReceipt(failed) : null,
        runtimeStartAttempted: false,
        writeSideEffects: uncertain ? "unknown" : false,
        ...(queueConflict ? { queueRevision: existing.getQueueIdentity().revision } : {}),
      }, { status: queueConflict ? 409 : uncertain ? 503 : 500 });
    }
  } catch (error) {
    return NextResponse.json({ error: redactLiveValue(error instanceof Error ? error.message : String(error)), code: "managed_control_rejected", accepted: false }, { status: 400 });
  }
}

function managedReservationResponse(reserved: Awaited<ReturnType<typeof reserveControlReceipt>>): Response {
  const idempotencyConflict = reserved.conflict || reserved.receipt.error?.code === "idempotency_conflict";
  const conflict = idempotencyConflict || reserved.receipt.outcome === "conflict";
  const unknown = reserved.receipt.outcome === "unknown";
  const failed = reserved.receipt.outcome === "failed"
    || (reserved.receipt.outcome === "aborted" && (reserved.receipt.operation !== "abort" || reserved.receipt.targetStopped !== true));
  return NextResponse.json({
    success: !conflict && !failed && !unknown,
    accepted: !conflict && !failed,
    outcome: reserved.receipt.outcome,
    receipt: publicControlReceipt(reserved.receipt),
    replayed: reserved.replayed,
    ...(unknown && !conflict ? { code: "control_outcome_unknown", nextAction: reserved.receipt.nextAction ?? "inspect_receipt_and_runtime_before_retry" } : {}),
    ...(conflict ? {
      error: redactLiveValue(reserved.receipt.error?.message),
      code: idempotencyConflict ? "idempotency_conflict" : reserved.receipt.error?.code ?? "control_conflict",
    } : {}),
  }, { status: conflict || failed ? 409 : unknown ? 202 : 200 });
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const includeSystemPrompt = new URL(req.url).searchParams.get("systemPrompt") !== "0";

  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    await assertRpcSessionRuntimeBinding(session);
    const state = await session.send({ type: "get_state", ...(includeSystemPrompt ? {} : { systemPrompt: false }) });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: redactLiveValue(String(error)) }, { status: 500 });
  }
}
