import { NextResponse } from "next/server";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { parseFastModeSelection, type FastModeSelection, type FastModeStatus } from "@/lib/fast-mode";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { createManagedSessionControl } from "@/lib/reader-session-create-control";
import { readControlPlaneJson } from "@/lib/reader-control-plane";
import { localDeviceIdentity, readActivityConfig } from "@/lib/activity-peers";
import { LIVE_EVENT_BOOT_ID } from "@/lib/live-agent-events";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import type { ReaderControlReceipt } from "@/lib/reader-control-receipts";
import { validateSessionToolSelection } from "@/lib/session-tool-selection";
import { readerCreateFailureDiagnostic } from "@/lib/reader-create-diagnostics";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel)) {
    return value as ThinkingLevel;
  }
  throw new Error(`Invalid thinking level: ${String(value)}`);
}

function parseFastMode(value: unknown): FastModeSelection | undefined {
  if (value === undefined) return undefined;
  const parsed = parseFastModeSelection(value);
  if (parsed) return parsed;
  throw new Error(`Invalid Fast mode: ${String(value)}`);
}
// POST /api/agent/new  body: { cwd: string; type: string; message?: string; ... }
// Spawns a brand-new pi session. Most calls immediately send the first command;
// type:"ensure_session" only creates the runtime so clients can query commands.
// Returns pi's real session id plus the model/thinking state selected at startup.
const managedCreate = createManagedSessionControl({
  deviceId: () => localDeviceIdentity(readActivityConfig(), new Date().toISOString()).id,
  bootId: () => LIVE_EVENT_BOOT_ID,
  validate: async (body) => {
    const result = await createSession(body, undefined, true);
    return { status: result.status, body: await result.json() as Record<string, unknown> };
  },
  create: async (body, onCreated, { correlationId }) => {
    const result = await createSession(body, onCreated, false, correlationId);
    return { status: result.status, body: await result.json() as Record<string, unknown> };
  },
});

export async function POST(req: Request) {
  try {
    const body = await readControlPlaneJson(req);
    const managed = typeof body.idempotencyKey === "string" || typeof body.requestFingerprint === "string" || body.readerMcpControl === true;
    if (!managed) return createSession(body);
    if (!isApiRequestAllowed(req)) return NextResponse.json({ code: "request_denied", runtimeStartAttempted: false }, { status: 403 });
    if (!hasJsonContentType(req)) return NextResponse.json({ code: "content_type", runtimeStartAttempted: false }, { status: 415 });
    const result = await managedCreate(body);
    return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ code: "invalid_create_request", accepted: false, runtimeStartAttempted: false }, { status: 400 });
  }
}

async function createSession(
  body: Record<string, unknown>,
  onCreated?: (binding: NonNullable<ReaderControlReceipt["createdSessionBinding"]>) => Promise<void>,
  validateOnly = false,
  correlationId?: string,
) {
  let commandType: string | undefined;
  let promptAccepted = false;
  let failureStage: "request_revalidation" | "runtime_start" | "binding_persistence" | "runtime_setup" | "runtime_state_read" | "initial_command" = "request_revalidation";
  try {
    const { cwd, contextSourceSessionId: rawContextSourceSessionId, ...command } = body;
    commandType = typeof command.type === "string" ? command.type : undefined;

    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({
        error: "cwd is required",
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      return NextResponse.json({
        error: `Directory does not exist: ${cwd}`,
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 400 });
    }

    const contextSourceSessionId = typeof rawContextSourceSessionId === "string"
      ? rawContextSourceSessionId.trim()
      : undefined;
    if (rawContextSourceSessionId !== undefined && !contextSourceSessionId) {
      return NextResponse.json({ error: "Invalid contextSourceSessionId" }, { status: 400 });
    }
    if (contextSourceSessionId) {
      const liveSourceSession = getRpcSession(contextSourceSessionId);
      if (!liveSourceSession?.isAlive()) {
        const sourcePath = await resolveSessionPath(contextSourceSessionId);
        if (!sourcePath || !existsSync(sourcePath)) {
          return NextResponse.json({ error: "Context source session not found" }, { status: 400 });
        }
      }
    }

    // Use a one-time key so startRpcSession's lock doesn't conflict with real session ids
    const { provider, modelId, toolNames, strictToolAllowlist, thinkingLevel, fastMode, autoCompactionEnabled, ...promptCommand } = command as { provider?: string; modelId?: string; toolNames?: string[]; strictToolAllowlist?: unknown; thinkingLevel?: unknown; fastMode?: unknown; autoCompactionEnabled?: unknown; [key: string]: unknown };
    if ((provider && !modelId) || (!provider && modelId)) {
      throw new Error("provider and modelId must be provided together");
    }
    const explicitThinkingLevel = parseThinkingLevel(thinkingLevel);
    const explicitFastMode = parseFastMode(fastMode);
    if (autoCompactionEnabled !== undefined && typeof autoCompactionEnabled !== "boolean") throw new Error("Invalid autoCompactionEnabled");
    if (strictToolAllowlist !== undefined && typeof strictToolAllowlist !== "boolean") throw new Error("Invalid strictToolAllowlist");
    if (strictToolAllowlist === true && !Array.isArray(toolNames)) {
      throw new Error("strictToolAllowlist requires an explicit toolNames allow-list");
    }
    if (strictToolAllowlist === true) validateSessionToolSelection(toolNames);

    const runtimeOptions = {
      ...(toolNames ? { toolNames } : {}),
      ...(strictToolAllowlist !== undefined ? { strictToolAllowlist } : {}),
      ...(provider && modelId ? { initialModel: { provider, modelId } } : {}),
      ...(explicitThinkingLevel ? { thinkingLevel: explicitThinkingLevel } : {}),
      ...(explicitFastMode ? { fastMode: explicitFastMode } : {}),
      ...(contextSourceSessionId ? { contextSourceSessionId } : {}),
    };
    if (validateOnly) return NextResponse.json({ success: true, validated: true });
    // Must be unique per request: startRpcSession coalesces concurrent callers
    // that share a key onto one session. UUID prevents same-millisecond collisions.
    failureStage = "runtime_start";
    const tempKey = `__new__${randomUUID()}`;
    const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, runtimeOptions);

    // Persist the real identity before any later get_state/configuration RPC.
    // Failure after this point remains unknown and cannot create a replacement.
    failureStage = "binding_persistence";
    if (onCreated) await onCreated({ deviceId: localDeviceIdentity(readActivityConfig(), new Date().toISOString()).id,
      sessionId: realSessionId, cwd: session.cwd, ...(toolNames ? { toolNames } : {}), strictToolAllowlist: strictToolAllowlist === true });

    failureStage = "runtime_setup";
    invalidateSessionListCache();

    if (typeof autoCompactionEnabled === "boolean") await session.send({ type: "set_auto_compaction", enabled: autoCompactionEnabled });
    session.initializeUnattendedDefault();

    failureStage = "runtime_state_read";
    const state = await session.send({ type: "get_state" }) as {
      model?: { id: string; provider: string };
      thinkingLevel?: string;
      fastMode?: FastModeStatus;
      branchPosition?: { leafId: string | null; pending: boolean };
      autoCompactionEnabled?: boolean;
    };

    if (promptCommand.type === "ensure_session") {
      return NextResponse.json({
        success: true,
        sessionId: realSessionId,
        sessionBootId: session.getLiveRuntimeIdentity().bootId,
        data: null,
        model: state.model
          ? { provider: state.model.provider, modelId: state.model.id }
          : null,
        thinkingLevel: state.thinkingLevel,
        fastMode: state.fastMode,
        branchPosition: state.branchPosition,
        autoCompactionEnabled: state.autoCompactionEnabled,
      });
    }

    failureStage = "initial_command";
    const result = await session.send(promptCommand);
    invalidateSessionListCache();
    promptAccepted = promptCommand.type === "prompt";

    return NextResponse.json({
      success: true,
      sessionId: realSessionId,
      data: result,
      model: state.model
        ? { provider: state.model.provider, modelId: state.model.id }
        : null,
      thinkingLevel: state.thinkingLevel,
      fastMode: state.fastMode,
      branchPosition: state.branchPosition,
      autoCompactionEnabled: state.autoCompactionEnabled,
    });
  } catch (error) {
    const failureCode = commandType === "prompt" && !promptAccepted
      ? "prompt_rejected"
      : ({
          request_revalidation: "create_request_revalidation_failed",
          runtime_start: "create_runtime_start_failed",
          binding_persistence: "create_binding_persistence_failed",
          runtime_setup: "create_runtime_setup_failed",
          runtime_state_read: "create_runtime_state_failed",
          initial_command: "create_initial_command_failed",
        } as const)[failureStage];
    const failureDiagnostic = correlationId
      ? readerCreateFailureDiagnostic(correlationId, failureStage, error)
      : undefined;
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      code: failureCode,
      ...(failureDiagnostic ? { failureDiagnostic } : {}),
      ...(commandType === "prompt" && !promptAccepted ? { accepted: false } : {}),
    }, { status: 500 });
  }
}
