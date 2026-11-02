#!/usr/bin/env node

/**
 * A bounded MCP adapter for Pi Web Reader.
 *
 * PI_WEB_READER_URL is the live mode: it reads Reader's existing activity and
 * runtime routes, and exposes explicitly confirmed control through the same
 * host/runtime entry. PI_WEB_READER_DATA_ROOT remains a storage-only fallback
 * for offline inventory. This file never imports Reader code, starts a runtime,
 * or silently retries a control request.
 */

import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

const PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([PROTOCOL_VERSION]);
const SERVER_NAME = "reader-inventory-control";
const SERVER_VERSION = "0.10.1";
const ACTIVE_DIR = "sessions";
const ARCHIVED_DIR = "archived_sessions";
const MAX_FILES = 10_000;
const MAX_DIRECTORIES = 2_000;
const HEADER_BYTES = 64 * 1024;
const SAMPLE_BYTES = 256 * 1024;
const DEFAULT_TAIL_BYTES = 64 * 1024;
// The standalone adapter preserves the storage budget, but live requests must
// fit Reader's safe-history route. Cross-route tests guard this wire contract.
const MAX_STORAGE_TAIL_BYTES = 256 * 1024;
const MAX_LIVE_TAIL_BYTES = 128 * 1024;
const MAX_TAIL_ENTRIES = 50;
const MAX_LIST_LIMIT = 500;
const MAX_LIST_OFFSET = 1_000_000;
const MAX_ID_LENGTH = 256;
const MAX_PROJECT_LENGTH = 160;
const MAX_DISPLAY_TEXT = 600;
const MAX_REMOTE_BODY_BYTES = 16 * 1024 * 1024;
const MAX_TOOL_RESULT_BYTES = 512 * 1024;
const MAX_INSPECT_STATE_BYTES = 64 * 1024;
const MAX_INSPECT_COLLECTION_ITEMS = 50;
const REMOTE_TIMEOUT_MS = 5_000;
const DEFAULT_LIVE_EVENT_LIMIT = 50;
const MAX_LIVE_EVENT_LIMIT = 100;
const DEFAULT_LIVE_EVENT_BYTES = 64 * 1024;
const MAX_LIVE_EVENT_BYTES = 128 * 1024;
const DEFAULT_LIVE_EVENT_TIMEOUT_MS = 3_000;
const MAX_LIVE_EVENT_TIMEOUT_MS = 10_000;
const MAX_UI_SNAPSHOT_BYTES = 192 * 1024;
const MAX_UI_WAIT_TIMEOUT_MS = 60_000;
const MAX_UI_SUBSCRIPTIONS = 32;
const UI_RESOURCE_TEMPLATE = "reader://ui-requests/{deviceId}/{sessionId}";
const DEFAULT_CONTROL_POST_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_RECEIPT_TIMEOUT_MS = 5_000;
const STOP_RECEIPT_POLL_MS = 100;
const CONTROL_POST_TIMEOUT_MS = configuredTimeoutMs(
  process.env.PI_WEB_READER_CONTROL_POST_TIMEOUT_MS,
  DEFAULT_CONTROL_POST_TIMEOUT_MS,
);
const STOP_RECEIPT_TIMEOUT_MS = configuredTimeoutMs(
  process.env.PI_WEB_READER_STOP_RECEIPT_TIMEOUT_MS,
  DEFAULT_STOP_RECEIPT_TIMEOUT_MS,
);
const SAFE_CREATE_TOOL_NAMES = ["read", "grep", "find", "ls"];
const SAFE_CREATE_TOOL_NAME_SET = new Set(SAFE_CREATE_TOOL_NAMES);
const CONTROL_PLANE_AREAS = Object.freeze({
  models: {
    route: "/api/models",
    cwd: "required",
    sideEffectSemantics: "Reader GET may load project model discovery/extensions; adapter sends no write",
  },
  models_enabled: {
    route: "/api/models/enabled",
    cwd: "required",
    sideEffectSemantics: "Reader GET read of enabled-model settings; adapter sends no write",
  },
  models_config: {
    route: "/api/models-config",
    cwd: "none",
    sideEffectSemantics: "Reader GET read of model configuration; adapter sends no write",
  },
  models_catalog: {
    route: "/api/models-config/catalog",
    cwd: "none",
    sideEffectSemantics: "Reader GET may use the Reader-side models.dev catalog cache/network; adapter sends no write",
  },
  tools_settings: {
    route: "/api/tools/settings",
    cwd: "none",
    sideEffectSemantics: "Reader GET read of tool settings; adapter sends no write",
  },
  skills: {
    route: "/api/skills",
    cwd: "required",
    scope: true,
    sideEffectSemantics: "Reader GET read of skill resources and state; adapter sends no write",
  },
  plugins: {
    route: "/api/plugins",
    cwd: "required",
    scope: true,
    sideEffectSemantics: "Reader GET read of plugin resources and state; adapter sends no write",
  },
  mcp: {
    route: "/api/mcp",
    cwd: "optional",
    sideEffectSemantics: "Reader GET read of global/project MCP overview; adapter sends no write",
  },
  subagents: {
    route: "/api/agent/running",
    cwd: "none",
    sideEffectSemantics: "Reader GET snapshot of currently running subagent runtimes; adapter sends no write",
  },
});
const CONTROL_PLANE_AREA_NAMES = Object.freeze(Object.keys(CONTROL_PLANE_AREAS));
const CONTROL_PLANE_MAX_QUERY_TEXT = 160;
const CONTROL_PLANE_MAX_LIMIT = 100;
const WRITE_CONTROL_PLANE_DEFINITIONS = Object.freeze({
  models_default: {
    route: "/api/models/default",
    method: "PUT",
    cwd: "required",
    scopes: ["global"],
    operations: ["set_default"],
  },
  models_enabled: {
    route: "/api/models/enabled",
    method: "PUT",
    cwd: "required",
    scopes: ["global"],
    operations: ["set_models", "set_provider", "clear", "prune", "resync"],
  },
  tools_settings: {
    route: "/api/tools/settings",
    method: "PUT",
    cwd: "optional",
    scopes: ["global", "project"],
    operations: ["set_codemode", "set_codemode_mode", "set_codemode_inline_budget"],
  },
  skills_policy: {
    route: "/api/skills",
    method: "PATCH",
    cwd: "required",
    scopes: ["global", "project"],
    operations: ["set_skill_invocation_mode", "clear_skill_invocation_mode", "set_global_skill_resource", "clear_global_skill_resource", "set_project_resource", "clear_project_resource", "set_plugin_skill", "clear_plugin_skill"],
  },
  plugins: {
    route: "/api/plugins",
    method: "POST",
    cwd: "required",
    scopes: ["global", "project"],
    operations: ["enable", "disable", "set_project_override", "clear_project_override", "set_top_level_extension", "clear_top_level_extension"],
  },
  mcp: {
    route: "/api/mcp",
    method: "POST",
    cwd: "optional",
    scopes: ["global", "project"],
    operations: ["enable", "disable", "remove", "set_enabled", "set_exposure", "add", "undo"],
  },
  compaction: {
    cwd: "none", scopes: ["global"], operations: ["set_enabled"],
  },
  subagent_profiles: {
    cwd: "required", scopes: ["global", "project"], operations: ["upsert", "delete", "set_enabled"],
  },
  subagents_settings: {
    cwd: "none", scopes: ["global"], operations: ["patch", "set_profile_enabled", "set_profile_override"],
  },
  custom_prompts: {
    cwd: "none", scopes: ["global"], operations: ["upsert", "delete", "reorder"],
  },
  model_routing: {
    cwd: "none", scopes: ["global"], operations: ["replace"],
  },
  models_config: {
    route: "/api/models-config",
    method: "PUT",
    cwd: "none",
    scopes: ["global"],
    operations: ["set_model_metadata"],
  },
});
const WRITE_CONTROL_PLANE_AREA_NAMES = Object.freeze(Object.keys(WRITE_CONTROL_PLANE_DEFINITIONS));
const WRITE_CONTROL_PLANE_OPERATION_NAMES = Object.freeze(
  [...new Set(Object.values(WRITE_CONTROL_PLANE_DEFINITIONS).flatMap((definition) => definition.operations))],
);
const MANAGED_CONTROL_PLANE_ROUTE = "/api/reader/control-plane";
const MANAGED_CONTROL_PLANE_AREA_NAMES = Object.freeze([...new Set([...CONTROL_PLANE_AREA_NAMES, ...WRITE_CONTROL_PLANE_AREA_NAMES])]);
const CONTROL_PLANE_CHANGE_FIELDS = Object.freeze([
  "provider", "modelId", "thinkingLevel", "enabled", "refs", "codemode", "codemodeMode", "inlineBudget",
  "resourceId", "policyKey", "mode", "filePath", "source", "resourceKey", "name", "exposure", "names",
  "renames", "modelRenames", "fullyEnabled", "builtInEnabled", "maxConcurrent", "model", "thinking",
  "id", "title", "content", "description", "order", "orderedIds", "routes", "server", "undoId",
  "displayName", "systemPrompt", "tools", "systemPromptMode", "defaultContext", "defaultAsync", "inheritProjectContext", "inheritGlobalContext", "inheritSkills", "acceptanceRole",
]);
const MAX_CONTROL_PLANE_REFS = 500;
const MAX_CONTROL_PLANE_POLICY_KEY = 1_024;

const SERVER_CAPABILITIES = {
  tools: { listChanged: false },
  resources: { subscribe: true, listChanged: false },
  experimental: {
    "reader.uiRequests": {
      readOnly: true,
      transport: "Reader SSE to MCP resource subscriptions; no polling",
      resourceTemplate: UI_RESOURCE_TEMPLATE,
      requiredAnswerBinding: ["runtimeGeneration", "questionId"],
      maxSnapshotBytes: MAX_UI_SNAPSHOT_BYTES,
      oversizedSnapshot: "error; never partial actionable requests",
    },
    "reader.snapshot": {
      readOnly: true,
      bounded: true,
      pagination: "observed-after-snapshot",
    },
    "reader.liveEvents": {
      readOnly: true,
      bootCursor: true,
      durableLedger: "reader-required",
      gapRecovery: "reader-required",
    },
    "reader.control": {
      dryRunDefault: true,
      idempotency: "reader-persistent-contract-required",
      unknownNeverAutoRetry: true,
      lifecycle: "reader-receipt-required",
    },
    "reader.controlPlane": {
      readOnly: true,
      transport: "GET-only",
      areas: CONTROL_PLANE_AREA_NAMES,
      managedRoute: MANAGED_CONTROL_PLANE_ROUTE,
      writes: "reader_write_control_plane",
      deviceBinding: "exact device id from Reader session-runs snapshot",
      cwdBinding: "required for project-scoped routes; never implicit",
      sessionBinding: "explicitly null because these Reader routes are not session-scoped",
      remote: "unsupported until Reader exposes a registered remote control-plane route",
    },
    "reader.writeControlPlane": {
      dryRunDefault: true,
      transport: "Reader unified GET/POST; no direct settings write",
      areas: WRITE_CONTROL_PLANE_AREA_NAMES,
      requiredContract: ["scope", "expectedRevision", "expectedBootId", "CAS", "persistentIdempotency", "fingerprint", "confirmation", "audit", "receipt"],
      receiptTool: "reader_get_control_plane_receipt",
      idempotency: "Reader persistent ledger; adapter does not cache configuration receipts",
      writes: "confirmed scope/revision/boot-bound Reader POST",
    },
  },
};

const rootSetting = process.env.PI_WEB_READER_DATA_ROOT;
const readerUrlSetting = process.env.PI_WEB_READER_URL;
const MAX_TAIL_BYTES = readerUrlSetting ? MAX_LIVE_TAIL_BYTES : MAX_STORAGE_TAIL_BYTES;
const deviceName = safeDeviceName(process.env.PI_WEB_READER_DEVICE_NAME || "local");

const TOOLS = [
  {
    name: "reader_list_sessions",
    description:
      "List Reader sessions with active/archive, visible/hidden, project, device, status, time-range, cross-device, and bounded pagination controls. With PI_WEB_READER_URL this uses Reader's existing read-only activity snapshot; with PI_WEB_READER_DATA_ROOT it uses the legacy local storage inventory and runtime status remains unknown.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope: { type: "string", enum: ["active", "archived", "both"], default: "both" },
        visibility: { type: "string", enum: ["visible", "hidden", "all"], default: "visible" },
        device: { type: "string", description: "Optional exact Reader device id or display name filter." },
        project: { type: "string", description: "Optional exact project label or Reader project key filter." },
        status: { type: "string", enum: ["running", "retrying", "waiting_user", "just_completed", "idle", "failed", "aborted", "unknown"] },
        timeRange: { type: "string", enum: ["all", "1", "3", "7", "14", "30", "90"], default: "all" },
        offset: { type: "integer", minimum: 0, maximum: MAX_LIST_OFFSET, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIST_LIMIT, default: MAX_LIST_LIMIT },
      },
    },
  },
  {
    name: "reader_get_session_metadata",
    description:
      "Return bounded metadata for one Reader session. In live URL mode this uses Reader's activity snapshot and verified runtime projection; in storage mode it is file-level only and runtimeStatus is unknown.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string", minLength: 1, maxLength: MAX_ID_LENGTH },
        scope: { type: "string", enum: ["active", "archived"] },
        visibility: { type: "string", enum: ["visible", "hidden", "all"], default: "visible" },
        device: { type: "string", description: "Optional exact Reader device id or display name filter." },
      },
    },
  },
  {
    name: "reader_read_tail",
    description:
      "Read a bounded, redacted summary of recent user/assistant/tool-result entries (up to 50 entries). " +
      `If you need earlier history beyond this bounded tail and Reader returns a non-empty sessionFilePath, use that path with local file-reading tools. If Reader omits the path, call reader_read_tail again with maxEntries: 50 and maxBytes: ${MAX_TAIL_BYTES}; never infer or read a null path. ` +
      `In live URL mode this uses Reader's safe-history route after snapshot ownership verification and rejects responses without runtimeStartAttempted=false/writeSideEffects=false; it never falls back to the ordinary session-detail route. Live maxBytes is limited to ${MAX_LIVE_TAIL_BYTES}; storage mode reads local JSONL only and supports up to ${MAX_STORAGE_TAIL_BYTES}. It redacts recognized secret fields and credential patterns, not arbitrary sensitive prose, and bounds tool output.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string", minLength: 1, maxLength: MAX_ID_LENGTH },
        scope: { type: "string", enum: ["active", "archived", "both"] },
        visibility: { type: "string", enum: ["visible", "hidden", "all"], default: "visible" },
        device: { type: "string", description: "Optional exact Reader device id or display name filter in live URL mode." },
        maxEntries: { type: "integer", minimum: 1, maximum: MAX_TAIL_ENTRIES, default: 20 },
        maxBytes: { type: "integer", minimum: 4096, maximum: MAX_TAIL_BYTES, default: DEFAULT_TAIL_BYTES },
      },
    },
  },
  {
    name: "reader_read_live_events",
    description:
      "Read existing live events (mode=events, default), or full authoritative pending UI requests (mode=ui_requests). mode=wait_ui_requests waits on genuine Reader SSE for a change from runtimeGeneration/revision, with a bounded timeout; without that pair it returns the initial snapshot. UI request content is exact and never silently truncated. For continuous notifications clients must explicitly resources/subscribe to the returned resourceUri and handle notifications/resources/updated, then resources/read. No mode starts or rehydrates a runtime. Event mode supports bootId/cursor polling with retained-window gap reporting.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string", minLength: 1, maxLength: MAX_ID_LENGTH },
        device: { type: "string", description: "Optional exact Reader device id or display name." },
        mode: { type: "string", enum: ["events", "ui_requests", "wait_ui_requests"], default: "events" },
        runtimeGeneration: { type: ["string", "null"], maxLength: 256, description: "For wait_ui_requests, the previous snapshot generation; null is valid for not_live snapshots. Pass together with revision." },
        revision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "For wait_ui_requests, the previous snapshot revision, paired with runtimeGeneration." },
        bootId: { type: "string", maxLength: 128, description: "Boot id returned by the previous live read; a changed id requires cursor reset." },
        cursor: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 },
        maxEvents: { type: "integer", minimum: 1, maximum: MAX_LIVE_EVENT_LIMIT, default: DEFAULT_LIVE_EVENT_LIMIT },
        maxBytes: { type: "integer", minimum: 4096, maximum: MAX_LIVE_EVENT_BYTES, default: DEFAULT_LIVE_EVENT_BYTES },
        timeoutMs: { type: "integer", minimum: 1, maximum: MAX_UI_WAIT_TIMEOUT_MS, description: "Event mode maximum 10000 ms; UI wait maximum 60000 ms (default 30000)." },
      },
    },
  },
  {
    name: "reader_session_control",
    description:
      "Inspect a live Reader runtime or execute control actions (prompt, continue, steer, follow_up, abort, stop, clear_queue, create_session, set_model, set_tools, get_tools).\n\n" +
      "[AI WORKFLOW GUIDE]\n" +
      "1. Discover: Call reader_list_sessions to inspect active sessions, statuses, lastUserMessage, and deviceId.\n" +
      `2. Check context: Call reader_read_tail(sessionId) for recent turns. If older history is needed and the result contains a non-empty sessionFilePath, inspect that path with local file-reading tools; if it is omitted, retry with maxEntries: 50 and maxBytes: ${MAX_TAIL_BYTES} and never read null.\n` +
      "3. Execute real commands: By default calls are dry-run validated only. To actually execute, you MUST pass dryRun: false, confirm: true, confirmationReason: '<reason>', and idempotencyKey: '<unique-id>'.\n" +
      "After create_session, use createdSessionBootId as expectedBootId for follow-up controls. readerReceipt.bootId is Reader-process-scoped and is not interchangeable with the session boot id.\n" +
      "4. Monitor: Read reader_read_live_events for output; mode=ui_requests gives authoritative full pending questions. Resource-capable clients may subscribe to its resourceUri for push notifications; otherwise wait_ui_requests uses SSE, not polling.\n" +
      "5. Answer: Read the exact request, then answer_question with its runtimeGeneration and questionId. Use answer for select/input/editor, confirmed for confirm, or cancelled:true. Selecting a manual-input option may create a NEW input/editor request: read it and answer its own ID. Never select authorization or tool-permission options automatically.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action", "deviceId"],
      properties: {
        action: { type: "string", enum: ["inspect", "get_tools", "set_model", "set_tools", "prompt", "continue", "steer", "follow_up", "abort", "stop", "clear_queue", "create_session", "answer_question"] },
        deviceId: { type: "string", minLength: 1, maxLength: 160 },
        sessionId: { type: "string", minLength: 1, maxLength: MAX_ID_LENGTH },
        message: { type: "string", maxLength: 32_000 },
        images: {
          type: "array",
          maxItems: 5,
          items: {
            type: "object",
            required: ["data", "mimeType"],
            properties: {
              data: { type: "string", description: "Base64 encoded image data (up to 8MB)" },
              mimeType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp", "image/gif"] },
            },
          },
          description: "Optional multimodal image attachments (up to 5 images) for prompt/continue/steer/follow_up.",
        },
        questionId: { type: "string", maxLength: 256, description: "Required for answer_question: the ID of the pending extension_ui_request / question card." },
        runtimeGeneration: { type: "string", minLength: 1, maxLength: 256, description: "Required for answer_question: exact runtimeGeneration from the authoritative pending UI request; stale generations are rejected." },
        answer: { type: "string", maxLength: 128 * 1024, description: "Exact selected option or input/editor text for answer_question. Empty text is preserved. Manual-input options may lead to a new request with a new questionId." },
        confirmed: { type: "boolean", description: "Confirmation flag for answer_question." },
        cancelled: { type: "boolean", description: "Set to true to cancel or dismiss the interactive question." },
        cwd: { type: "string", maxLength: 2_000, description: "Required by create_session; Reader validates that the directory exists." },
        provider: { type: "string", minLength: 1, maxLength: 256 },
        modelId: { type: "string", minLength: 1, maxLength: 256 },
        thinkingLevel: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
        toolNames: { type: "array", maxItems: 7, items: { type: "string", enum: ["bash", "read", "edit", "write", "grep", "find", "ls"] }, description: "create_session accepts only read/grep/find/ls or []; set_tools requires an explicit registered built-in selection in an idle live target. Reader preserves its existing strict policy and reports effective carried tools." },
        strictToolAllowlist: { type: "boolean", description: "For create_session toolNames, require an exact per-session allow-list and disable discovered/project extensions. Supplying toolNames enables strict mode by default; omit both to preserve Reader's normal tool-selection semantics." },
        dryRun: { type: "boolean", default: true },
        confirm: { type: "boolean", default: false, description: "Must be the JSON boolean true for any real prompt/steer/follow_up/abort/stop/clear_queue/create_session request; strings and query parameters are not accepted." },
        idempotencyKey: { type: "string", minLength: 8, maxLength: 200, description: "Required for a real control request; repeated keys replay the original adapter-process receipt, while durable replay must be enforced by Reader." },
        expectedRevision: { type: "string", maxLength: 256, description: "Optional caller-observed Reader revision; the Reader endpoint must enforce it before a write." },
        expectedBootId: { type: "string", maxLength: 128, description: "create_session accepts a Reader-process boot id. Follow-up controls require the session-scoped createdSessionBootId; readerReceipt.bootId is process-scoped." },
        expectedQueueRevision: { type: "string", minLength: 64, maxLength: 64, description: "Caller-observed queue revision for clear_queue CAS; Reader rejects stale queue state." },
        confirmationReason: { type: "string", maxLength: 500, description: "Required and non-empty when dryRun=false; optional for dry-run. It is retained in the control contract and never treated as permission by itself." },
      },
    },
  },
  {
    name: "reader_read_control_plane",
    description:
      "Read an allowlisted Reader models/tools/Skills/plugins/MCP/subagent/config route through GET only. The adapter binds the request to an exact Reader device and an explicit cwd where the route is project-scoped; it never exposes a configuration write and reports remote-device coverage as unsupported until Reader provides a registered remote route.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["area", "deviceId"],
      properties: {
        area: { type: "string", enum: MANAGED_CONTROL_PLANE_AREA_NAMES },
        managed: { type: "boolean", default: false, description: "Read the unified scope-bound snapshot with revision, bootId, authorization, and supportedOperations. Write-only area aliases imply managed=true." },
        deviceId: { type: "string", minLength: 1, maxLength: 160 },
        cwd: { type: "string", maxLength: 2_000, description: "Required for models, models_enabled, skills, and plugins; optional for the MCP overview; never falls back implicitly." },
        scope: { type: "string", enum: ["global", "project"], description: "Required for managed snapshots; otherwise Reader view scope for skills/plugins." },
        q: { type: "string", maxLength: CONTROL_PLANE_MAX_QUERY_TEXT, description: "Optional models catalog search text." },
        provider: { type: "string", maxLength: CONTROL_PLANE_MAX_QUERY_TEXT, description: "Optional models catalog provider filter." },
        limit: { type: "integer", minimum: 1, maximum: CONTROL_PLANE_MAX_LIMIT, default: 50, description: "Optional models catalog result bound." },
      },
    },
  },
  {
    name: "reader_write_control_plane",
    description:
      "Perform allowlisted configuration operations through Reader's unified managed control plane. Default dry-run reads the scope-bound snapshot then sends dryRun=true to Reader for business validation without configuration writes or receipts. A real POST requires explicit confirmation, reason, idempotencyKey, expectedRevision, and expectedBootId; Reader owns authorization, CAS, persistent fingerprint/replay, audit, and lifecycle receipt. Unknown outcomes are never retried automatically. No arbitrary route, credentials, or plugin installation is accepted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["area", "operation", "deviceId", "scope"],
      properties: {
        area: { type: "string", enum: WRITE_CONTROL_PLANE_AREA_NAMES },
        operation: { type: "string", enum: WRITE_CONTROL_PLANE_OPERATION_NAMES },
        deviceId: { type: "string", minLength: 1, maxLength: 160 },
        cwd: { type: "string", maxLength: 2_000, description: "Required for project-scoped handoffs; never falls back implicitly." },
        scope: { type: "string", enum: ["global", "project"] },
        provider: { type: "string", maxLength: CONTROL_PLANE_MAX_QUERY_TEXT },
        modelId: { type: "string", maxLength: CONTROL_PLANE_MAX_QUERY_TEXT },
        thinkingLevel: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
        enabled: { type: "boolean" },
        refs: { type: "array", maxItems: MAX_CONTROL_PLANE_REFS, items: { type: "string", minLength: 1, maxLength: 256 } },
        codemode: { type: "string", enum: ["automatic", "always"] },
        codemodeMode: { type: "string", enum: ["on", "only"] },
        inlineBudget: { type: ["integer", "null"], minimum: 0, maximum: 1_000_000 },
        policyKey: { type: "string", minLength: 1, maxLength: MAX_CONTROL_PLANE_POLICY_KEY },
        mode: { type: "string", enum: ["automatic", "explicit-only"] },
        resourceId: { type: "string", pattern: "^resource_[a-f0-9]{64}$", description: "Opaque resource identity from a managed skills_policy or plugins snapshot. Use without filePath, policyKey or source." },
        filePath: { type: "string", minLength: 1, maxLength: 4_000, description: "A discovered Skill resource path for a future Reader-owned policy contract; never read or written by this adapter." },
        source: { type: "string", minLength: 1, maxLength: 2_000 },
        resourceKey: { type: "string", minLength: 1, maxLength: 2_000 },
        name: { type: "string", minLength: 1, maxLength: 1_024 },
        displayName: { type: "string", minLength: 1, maxLength: 256 },
        systemPrompt: { type: "string", maxLength: 32000 },
        tools: { type: "array", maxItems: 7, uniqueItems: true, items: { type: "string", enum: ["read", "bash", "edit", "write", "grep", "find", "ls"] } },
        systemPromptMode: { type: "string", enum: ["append", "replace"] },
        defaultContext: { type: "string", enum: ["fresh", "fork"] },
        defaultAsync: { type: "boolean" },
        inheritProjectContext: { type: "boolean" },
        inheritGlobalContext: { type: "boolean" },
        inheritSkills: { type: "boolean" },
        acceptanceRole: { type: "string", enum: ["read-only", "writer"] },
        exposure: { type: "string", enum: ["codemode", "direct"] },
        undoId: { type: "string", minLength: 1, maxLength: 100 },
        server: { type: "object", additionalProperties: false, properties: {
          url: { type: "string", minLength: 1, maxLength: 2000 }, command: { type: "string", minLength: 1, maxLength: 2000 },
          args: { type: "array", maxItems: 100, items: { type: "string", maxLength: 2000 } }, enabled: { type: "boolean" }, exposure: { type: "string", enum: ["codemode", "direct"] },
        }, description: "Config-only MCP transport definition. Credentials, environment values and headers are not accepted. Adding a definition never connects or installs its server." },
        names: { type: "array", maxItems: 500, items: { type: "string", minLength: 1, maxLength: 256 } },
        renames: { type: "array", maxItems: 500, items: { type: "object", additionalProperties: false, required: ["from", "to"], properties: { from: { type: "string", minLength: 1, maxLength: 256 }, to: { type: "string", minLength: 1, maxLength: 256 } } } },
        modelRenames: { type: "array", maxItems: 500, items: { type: "object", additionalProperties: false, required: ["from", "to"], properties: { from: { type: "string", minLength: 1, maxLength: 256 }, to: { type: "string", minLength: 1, maxLength: 256 } } } },
        fullyEnabled: { type: "array", maxItems: 500, items: { type: "string", minLength: 1, maxLength: 256 } },
        builtInEnabled: { type: "boolean" },
        maxConcurrent: { type: "integer", minimum: 1, maximum: 64 },
        model: { type: ["string", "null"], minLength: 1, maxLength: 256 },
        thinking: { type: ["string", "null"], minLength: 1, maxLength: 64 },
        id: { type: "string", minLength: 1, maxLength: 256 },
        title: { type: "string", minLength: 1, maxLength: 256 },
        content: { type: "string", minLength: 1, maxLength: 32_000 },
        description: { type: "string", maxLength: 2_000 },
        order: { type: "integer", minimum: 0, maximum: 1_000_000 },
        orderedIds: { type: "array", maxItems: 500, items: { type: "string", minLength: 1, maxLength: 256 } },
        routes: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false, required: ["id", "provider", "model", "thinkingLevel"], properties: {
          id: { type: "string", minLength: 1, maxLength: 256 }, provider: { type: "string", minLength: 1, maxLength: 160 }, model: { type: "string", minLength: 1, maxLength: 256 }, thinkingLevel: { type: "string", maxLength: 64 }, maxAttempts: { type: "integer", minimum: 1, maximum: 100 },
        } } },
        dryRun: { type: "boolean", default: true },
        confirm: { type: "boolean", default: false, description: "Must be JSON true for a real configuration write; Reader independently verifies authorization." },
        idempotencyKey: { type: "string", minLength: 8, maxLength: 200 },
        expectedRevision: { type: "string", minLength: 1, maxLength: 256, description: "Required for a real write; use the managed snapshot revision. Never auto-refreshed by the adapter." },
        expectedBootId: { type: "string", minLength: 1, maxLength: 128 },
        confirmationReason: { type: "string", maxLength: 500 },
      },
    },
  },
  {
    name: "reader_get_control_plane_receipt",
    description: "Read a durable Reader configuration receipt without retrying its write. Supply receiptId or operation plus idempotencyKey and the original exact device/cwd/scope/area binding. Works across adapter restarts; unsupported for remote devices without a registered proxy.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["area", "deviceId", "scope"],
      properties: {
        area: { type: "string", enum: WRITE_CONTROL_PLANE_AREA_NAMES },
        deviceId: { type: "string", minLength: 1, maxLength: 160 },
        cwd: { type: "string", maxLength: 2_000 },
        scope: { type: "string", enum: ["global", "project"] },
        receiptId: { type: "string", minLength: 1, maxLength: 256 },
        operation: { type: "string", enum: WRITE_CONTROL_PLANE_OPERATION_NAMES },
        idempotencyKey: { type: "string", minLength: 8, maxLength: 200 },
      },
    },
  },
  {
    name: "reader_get_session_control_receipt",
    description: "Read an existing Reader session-control receipt without retrying the action. Defaults sessionId to new for create_session receipts. Supply receiptId or operation plus idempotencyKey. Local Reader only; raw keys are never returned.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["deviceId"],
      properties: {
        deviceId: { type: "string", minLength: 1, maxLength: 160 },
        sessionId: { type: "string", minLength: 1, maxLength: 256, description: "Exact Reader session binding; defaults to new for create_session receipts." },
        receiptId: { type: "string", minLength: 1, maxLength: 200 },
        operation: { type: "string", minLength: 1, maxLength: 100, description: "Required with idempotencyKey; for creation use create_session." },
        idempotencyKey: { type: "string", minLength: 8, maxLength: 200 },
      },
    },
  },
];

if (!rootSetting && !readerUrlSetting) {
  console.error("PI_WEB_READER_DATA_ROOT or PI_WEB_READER_URL is required; refusing implicit Reader access");
  process.exitCode = 64;
} else {
  start().catch((error) => {
    console.error(`reader-mcp startup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

async function start() {
  const readerUrl = readerUrlSetting ? prepareReaderUrl(readerUrlSetting) : null;
  const root = readerUrl ? null : await prepareRoot(rootSetting);
  const state = {
    root,
    readerUrl,
    controlReceipts: new Map(),
    // Deliberately process-local: a restart must not turn an arbitrary
    // transient session id into a writable target without a fresh create
    // receipt from this adapter process.
    createdSessionBindings: new Map(),
    uiSubscriptions: new Map(),
    uiWaits: new Map(),
    initialized: false,
    closed: false,
  };
  await consumeStdio(state);
}

function prepareReaderUrl(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("PI_WEB_READER_URL must be a non-empty http(s) URL");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("PI_WEB_READER_URL must be a valid http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("PI_WEB_READER_URL must use http or https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("PI_WEB_READER_URL must not contain credentials, query parameters, or a fragment");
  }
  return parsed.origin;
}

async function prepareRoot(configuredRoot) {
  if (typeof configuredRoot !== "string" || configuredRoot.length === 0 || !path.isAbsolute(configuredRoot)) {
    throw new Error("PI_WEB_READER_DATA_ROOT must be an absolute path");
  }

  const root = await fs.realpath(configuredRoot);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory()) {
    throw new Error("PI_WEB_READER_DATA_ROOT must resolve to a directory");
  }

  return root;
}

async function consumeStdio(state) {
  let buffer = "";
  let closed = false;

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim().length > 0) {
        void handleLine(line, state).catch((error) => {
          console.error(`request handling failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
  });
  process.stdin.on("end", () => {
    if (!closed && buffer.trim().length > 0) {
      void handleLine(buffer, state).catch((error) => {
        console.error(`request handling failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    closed = true;
    closeUiTransports(state);
  });
}

async function handleLine(line, state) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    sendError(null, -32700, "Parse error");
    return;
  }

  const validId = typeof request?.id === "string" || (typeof request?.id === "number" && Number.isInteger(request.id));
  if (!isRecord(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string"
    || (Object.hasOwn(request, "id") && !validId) || Object.hasOwn(request, "result") || Object.hasOwn(request, "error")) {
    sendError(validId ? request.id : null, -32600, "Invalid Request");
    return;
  }

  const hasId = Object.prototype.hasOwnProperty.call(request, "id");
  const id = hasId ? request.id : null;
  const params = request.params === undefined
    ? {}
    : isRecord(request.params)
      ? request.params
      : null;

  if (!hasId) {
    if (request.method === "notifications/cancelled") {
      state.uiWaits.get(params?.requestId)?.abort();
    }
    if (request.method === "notifications/initialized" || request.method === "notifications/cancelled" || request.method === "notifications/progress" || request.method === "$/cancelRequest") {
      return;
    }
    return;
  }

  if (!params) {
    sendError(id, -32602, `${request.method} params must be an object`);
    return;
  }

  try {
    switch (request.method) {
      case "initialize":
        if (typeof params.protocolVersion !== "string" || !isRecord(params.capabilities)
          || !isRecord(params.clientInfo) || typeof params.clientInfo.name !== "string"
          || typeof params.clientInfo.version !== "string") {
          sendError(id, -32602, "initialize requires protocolVersion, capabilities, and clientInfo.name/version");
          return;
        }
        // Negotiate, do not reject a different client preference. A client
        // that cannot speak our returned version must disconnect.
        sendResult(id, {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: SERVER_CAPABILITIES,
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            "With PI_WEB_READER_URL this server reads Reader's existing bounded activity/runtime APIs; coverage, freshness, pagination, retained live-window gaps, and offline devices are explicit. Every tool result has schemaVersion=1, observedAt, and a canonical result field. Control is dry-run by default, sends idempotencyKey/requestFingerprint to Reader, and never auto-retries an unknown write. Durable receipts, safe-history side-effect isolation, and live event persistence remain Reader-side contracts. With PI_WEB_READER_DATA_ROOT it is storage-only and runtime states are unknown.",
        });
        state.initialized = true;
        return;
      case "ping":
        sendResult(id, {});
        return;
      case "tools/list":
        sendResult(id, { tools: TOOLS });
        return;
      case "resources/list":
        sendResult(id, { resources: [] });
        return;
      case "resources/templates/list":
        sendResult(id, { resourceTemplates: state.readerUrl ? [{
          uriTemplate: UI_RESOURCE_TEMPLATE,
          name: "reader-pending-ui-requests",
          description: "Full authoritative pending select/confirm/input/editor requests. Discover exact deviceId/sessionId with reader_list_sessions. Explicit subscribe enables push notifications; read again after each update.",
          mimeType: "application/json",
        }] : [] });
        return;
      case "resources/read":
      case "resources/subscribe":
      case "resources/unsubscribe":
        await handleUiResourceRequest(id, request.method, params, state);
        return;
      case "tools/call":
        await handleToolCall(id, params, state);
        return;
      case "shutdown":
        closeUiTransports(state);
        sendResult(id, null);
        return;
      default:
        sendError(id, -32601, `Method not found: ${request.method}`);
    }
  } catch (error) {
    sendError(id, -32603, error instanceof Error ? error.message : String(error));
  }
}

async function handleToolCall(id, params, state) {
  if (!params || typeof params.name !== "string") {
    sendError(id, -32602, "tools/call requires a tool name");
    return;
  }

  const tool = TOOLS.find((candidate) => candidate.name === params.name);
  if (!tool) {
    sendError(id, -32602, `Unknown tool: ${params.name}`);
    return;
  }
  if (params.arguments !== undefined && !isRecord(params.arguments)) {
    sendError(id, -32602, "tools/call arguments must be an object");
    return;
  }
  const args = params.arguments === undefined ? {} : params.arguments;

  try {
    validateToolArguments(tool, args);
    let payload;
    switch (params.name) {
      case "reader_list_sessions":
        payload = await listSessions(state, args);
        break;
      case "reader_get_session_metadata":
        payload = await getSessionMetadata(state, args);
        break;
      case "reader_read_tail":
        payload = await readSessionTail(state, args);
        break;
      case "reader_read_live_events":
        payload = args.mode === "ui_requests" || args.mode === "wait_ui_requests"
          ? await readReaderUiRequests(state, args, id)
          : await readReaderLiveEvents(state, args);
        break;
      case "reader_session_control":
        payload = await readerSessionControl(state, args);
        break;
      case "reader_read_control_plane":
        payload = await readerReadControlPlane(state, args);
        break;
      case "reader_get_control_plane_receipt":
        payload = await readerGetControlPlaneReceipt(state, args);
        break;
      case "reader_get_session_control_receipt":
        payload = await readerGetSessionControlReceipt(state, args);
        break;
      case "reader_write_control_plane":
        payload = await readerWriteControlPlane(state, args);
        break;
    }
    sendToolResult(id, payload);
  } catch (error) {
    sendToolError(id, error instanceof Error ? error.message : String(error), "tool_error");
  }
}

async function listSessions(state, args) {
  if (state.readerUrl) return listReaderApiSessions(state.readerUrl, args);
  if (!state.root) throw new ToolInputError("Reader data root is unavailable");
  return listStorageSessions(state.root, args);
}

async function listStorageSessions(root, args) {
  const scope = validateScope(args.scope || "both", true);
  const visibility = validateVisibility(args.visibility || "visible");
  if (visibility !== "visible") {
    throw new ToolInputError("hidden/all visibility requires PI_WEB_READER_URL; the storage fallback cannot reproduce Reader hidden-state filtering");
  }
  if (args.device !== undefined || args.status !== undefined || (args.timeRange !== undefined && args.timeRange !== "all")) {
    throw new ToolInputError("device/status/timeRange filters require PI_WEB_READER_URL; the storage fallback cannot reproduce live Reader filtering");
  }
  const project = args.project === undefined ? undefined : validateProject(args.project);
  const offset = validateInteger(args.offset === undefined ? 0 : args.offset, 0, MAX_LIST_OFFSET, "offset");
  const limit = validateInteger(args.limit === undefined ? MAX_LIST_LIMIT : args.limit, 1, MAX_LIST_LIMIT, "limit");
  const scopes = scope === "both" ? ["active", "archived"] : [scope];
  const scan = await scanScopes(root, scopes);
  const matching = scan.sessions
    .filter((row) => project === undefined || row.project.toLocaleLowerCase() === project.toLocaleLowerCase())
    .sort(compareNewest);
  const rows = matching
    .slice(offset, offset + limit)
    .map(publicSessionRow);

  return {
    device: deviceName,
    storageScopeRequested: scope,
    visibilityRequested: visibility,
    sessions: rows,
    returnedCount: rows.length,
    matchingCountObserved: matching.length,
    countExact: !scan.coverage.some((item) => item.scanTruncated),
    pagination: paginationFor(offset, limit, matching.length),
    coverage: coverageFor(scan, scopes),
    runtimeStatusSemantics: runtimeStatusSemantics(),
  };
}

async function getSessionMetadata(state, args) {
  if (state.readerUrl) return getReaderApiSessionMetadata(state.readerUrl, args);
  if (!state.root) throw new ToolInputError("Reader data root is unavailable");
  return getStorageSessionMetadata(state.root, args);
}

async function getStorageSessionMetadata(root, args) {
  const visibility = validateVisibility(args.visibility || "visible");
  if (visibility !== "visible") {
    throw new ToolInputError("hidden/all visibility requires PI_WEB_READER_URL; the storage fallback cannot reproduce Reader hidden-state filtering");
  }
  if (args.device !== undefined) {
    throw new ToolInputError("device filtering requires PI_WEB_READER_URL; the storage fallback cannot reproduce cross-device Reader identity");
  }
  const sessionId = validateSessionId(args.sessionId);
  const requestedScope = args.scope === undefined ? undefined : validateScope(args.scope, false);
  const scopes = requestedScope ? [requestedScope] : ["active", "archived"];
  const scan = await scanScopes(root, scopes);
  const matches = scan.sessions.filter((row) => row.id === sessionId);
  if (matches.length === 0) {
    throw new ToolInputError("Session not found in the configured local data root");
  }
  if (matches.length > 1) {
    throw new ToolInputError("Session id exists in more than one storage scope; pass scope explicitly");
  }

  const row = matches[0];
  return {
    device: deviceName,
    session: publicSessionRow(row),
    fileObservation: {
      exists: true,
      storageScope: row.storageScope,
      lastActivityAt: row.lastActivityAt,
      lastActivitySource: "filesystem mtime only",
      sizeBytes: row.sizeBytes,
      observedMessageCount: row.observedMessageCount,
      observationTruncated: row.observationTruncated,
    },
    coverage: coverageFor(scan, scopes),
    runtimeStatusSemantics: runtimeStatusSemantics(),
  };
}

async function readSessionTail(state, args) {
  if (state.readerUrl) {
    return readReaderSessionTail(state, args);
  }
  if (!state.root) throw new ToolInputError("Reader data root is unavailable");
  return readStorageSessionTail(state.root, args);
}

async function readReaderLiveEvents(state, args) {
  if (args.runtimeGeneration !== undefined || args.revision !== undefined) {
    throw new ToolInputError("runtimeGeneration/revision are supported only for wait_ui_requests");
  }
  if (!state.readerUrl) {
    throw new ToolInputError("reader_read_live_events requires PI_WEB_READER_URL; the storage fallback has no live runtime");
  }
  const sessionId = validateSessionId(args.sessionId);
  const maxEvents = validateInteger(args.maxEvents === undefined ? DEFAULT_LIVE_EVENT_LIMIT : args.maxEvents, 1, MAX_LIVE_EVENT_LIMIT, "maxEvents");
  const maxBytes = validateInteger(args.maxBytes === undefined ? DEFAULT_LIVE_EVENT_BYTES : args.maxBytes, 4096, MAX_LIVE_EVENT_BYTES, "maxBytes");
  const timeoutMs = validateInteger(args.timeoutMs === undefined ? DEFAULT_LIVE_EVENT_TIMEOUT_MS : args.timeoutMs, 1, MAX_LIVE_EVENT_TIMEOUT_MS, "timeoutMs");
  const cursor = args.cursor === undefined ? 0 : validateInteger(args.cursor, 0, Number.MAX_SAFE_INTEGER, "cursor");
  const bootId = args.bootId === undefined ? undefined : validateBootId(args.bootId);
  const target = await locateLiveSessionTarget(state, sessionId, args.device);
  if (!target.ok) return target.value;

  const isLocal = target.localDeviceId === target.device.id;
  const route = readerLiveEventsRoute(state.readerUrl, isLocal, target.device.id, sessionId);
  route.url.searchParams.set("cursor", String(cursor));
  route.url.searchParams.set("limit", String(maxEvents));
  route.url.searchParams.set("maxBytes", String(maxBytes));
  if (bootId !== undefined) route.url.searchParams.set("bootId", bootId);

  let detail;
  try {
    detail = await fetchLiveProjection(route.url, maxBytes + 16 * 1024, timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = error && typeof error === "object" && typeof error.code === "string" ? error.code : "";
    if (errorCode === "boot_changed" || errorCode === "cursor_ahead") {
      const currentBootId = error && typeof error === "object" && error.body && typeof error.body === "object"
        ? safeIdentity(error.body.bootId)
        : null;
      return {
        source: "reader-live-runtime",
        found: false,
        sessionId,
        outcome: "reset_required",
        code: errorCode,
        ...(safeCount(error?.body?.recoverFromCursor) === undefined ? {} : { recoverFromCursor: safeCount(error.body.recoverFromCursor) }),
        ...(safeIdentity(error?.body?.readerBootId) ? { readerBootId: safeIdentity(error.body.readerBootId) } : {}),
        ...(error?.body?.bootScope === "reader-process" ? { bootScope: "reader-process", runtimeStatus: "not_live" } : {}),
        ...(currentBootId ? { bootId: currentBootId } : {}),
        reason: errorCode === "cursor_ahead"
          ? "The requested cursor is ahead of Reader's verified range; reset to the explicit recovery cursor"
          : "Reader runtime restarted; discard the old cursor and poll again from cursor 0 without the old bootId",
        target: { device: target.device, sessionId },
        coverage: target.coverage,
        runtimeStatusSemantics: liveProjectionRuntimeStatusSemantics(),
      };
    }
    if (errorCode === "coverage_incomplete") {
      return {
        source: "reader-live-runtime", found: false, sessionId,
        outcome: "unknown", code: "coverage_incomplete",
        reason: "Reader cannot verify durable event continuity; no runtime was started",
        target: { device: target.device, sessionId }, coverage: { ...target.coverage, eventContinuity: "unavailable" },
        runtimeStatusSemantics: liveProjectionRuntimeStatusSemantics(),
      };
    }
    if (errorCode === "gap" && error && typeof error === "object" && error.body && typeof error.body === "object") {
      const body = error.body;
      const oldestCursor = safeCount(body.oldestCursor);
      const nextCursor = safeCount(body.nextCursor);
      return {
        source: "reader-live-runtime",
        found: true,
        sessionId,
        outcome: "gap",
        code: "gap",
        ...(safeIdentity(body.bootId) ? { bootId: safeIdentity(body.bootId) } : {}),
        cursor,
        ...(oldestCursor === undefined ? {} : { oldestCursor }),
        ...(nextCursor === undefined ? {} : { nextCursor }),
        truncated: body.truncated === true,
        ...(safeCount(body.recoverFromCursor) === undefined ? {} : { recoverFromCursor: safeCount(body.recoverFromCursor) }),
        reason: typeof body.reason === "string" && body.reason.trim()
          ? sanitizeText(body.reason)
          : "Reader detected an unavailable event range; poll from the explicit recovery cursor.",
        target: { device: target.device, sessionId },
        coverage: target.coverage,
        runtimeStatusSemantics: liveProjectionRuntimeStatusSemantics(),
      };
    }
    const notLive = /runtime_not_live|HTTP 404/i.test(message);
    return {
      source: "reader-live-runtime",
      found: false,
      sessionId,
      outcome: notLive ? "not_live" : "unknown",
      reason: notLive
        ? "Reader has no already-live runtime for this session; no runtime was started"
        : "Reader live projection could not be read; no runtime was started",
      error: publicRemoteError(error),
      target: { device: target.device, sessionId },
      coverage: target.coverage,
      runtimeStatusSemantics: liveProjectionRuntimeStatusSemantics(),
    };
  }

  if (detail?.runtimeStartAttempted !== false || detail?.writeSideEffects !== false) {
    return { source: "reader-live-runtime", found: false, sessionId, outcome: "unknown",
      code: "live_read_contract_unavailable", reason: "Reader did not prove a no-wake live read",
      target: { device: target.device, sessionId }, coverage: target.coverage,
      runtimeStatusSemantics: liveProjectionRuntimeStatusSemantics() };
  }
  const stoppedReplay = detail?.source === "reader-durable-live-ledger";
  if (stoppedReplay && (detail?.runtimeStatus !== "not_live" || detail?.bootScope !== "reader-process"
    || !safeIdentity(detail?.readerBootId) || detail.bootId !== detail.readerBootId)) {
    return { source: "reader-durable-live-ledger", found: false, sessionId, outcome: "unknown",
      code: "replay_boot_contract_unavailable", reason: "Stopped replay must bind the current Reader process boot",
      target: { device: target.device, sessionId }, coverage: target.coverage,
      runtimeStatusSemantics: liveProjectionRuntimeStatusSemantics() };
  }
  const observedOldestCursor = safeCount(detail?.oldestCursor);
  const observedNextCursor = safeCount(detail?.nextCursor);
  const cursorGap = cursor > 0
    && observedOldestCursor !== undefined
    && cursor < observedOldestCursor - 1;
  if (cursorGap) {
    return {
      source: "reader-live-runtime",
      found: true,
      sessionId,
      outcome: "gap",
      code: "gap",
      bootId: safeIdentity(detail?.bootId),
      cursor,
      oldestCursor: observedOldestCursor,
      nextCursor: observedNextCursor,
      truncated: true,
      recoverFromCursor: Math.max(0, observedOldestCursor - 1),
      reason: "The requested cursor is older than Reader's retained live window; discard the stale range and poll from recoverFromCursor.",
      target: { device: target.device, sessionId },
      coverage: target.coverage,
      runtimeStatusSemantics: liveProjectionRuntimeStatusSemantics(),
    };
  }

  return {
    source: detail?.source === "reader-durable-live-ledger" ? "reader-durable-live-ledger" : "reader-live-runtime",
    found: true,
    outcome: detail?.outcome === "replayed" ? "replayed" : "observed",
    runtimeStatus: detail?.runtimeStatus === "not_live" ? "not_live" : "live",
    coverageIncomplete: detail?.coverageIncomplete === true || detail?.durableLedger?.coverageComplete === false,
    target: { device: target.device, sessionId },
    bootId: safeIdentity(detail?.bootId),
    bootScope: stoppedReplay ? "reader-process" : "runtime",
    ...(safeIdentity(detail?.readerBootId) ? { readerBootId: safeIdentity(detail.readerBootId) } : {}),
    ...(safeIdentity(detail?.replayedRuntimeBootId) ? { replayedRuntimeBootId: safeIdentity(detail.replayedRuntimeBootId) } : {}),
    cursor: safeCount(detail?.cursor),
    nextCursor: observedNextCursor,
    oldestCursor: observedOldestCursor,
    truncated: detail?.truncated === true,
    bytesRead: safeCount(detail?.bytesRead),
    events: Array.isArray(detail?.events) ? sanitizePublicValue(detail.events.slice(0, maxEvents)) : [],
    activeToolEvents: Array.isArray(detail?.activeToolEvents) ? sanitizePublicValue(detail.activeToolEvents.slice(0, maxEvents)) : [],
    ...(detail && Object.prototype.hasOwnProperty.call(detail, "streamingMessage")
      ? { streamingMessage: sanitizePublicValue(detail.streamingMessage) }
      : {}),
    isStreaming: detail?.isStreaming === true,
    isPromptRunning: detail?.isPromptRunning === true,
    strictToolAllowlist: detail?.strictToolAllowlist === true,
    ...(detail?.durableLedger && typeof detail.durableLedger === "object" ? {
      durableLedger: { available: detail.durableLedger.available === true,
        coverageComplete: detail.durableLedger.coverageComplete === true,
        writeFailureObserved: detail.durableLedger.writeFailureObserved === true,
        ...(detail.durableLedger.unpersistedTail === "unknown-without-live-runtime"
          ? { unpersistedTail: "unknown-without-live-runtime" } : {}),
        replay: detail.durableLedger.replay === true, retention: "bounded-per-session" },
    } : {}),
    transientBinding: target.transientBinding === true,
    coverage: target.coverage,
    runtimeStatusSemantics: liveProjectionRuntimeStatusSemantics(),
  };
}

function uiResourceUri(deviceId, sessionId) {
  return `reader://ui-requests/${encodeURIComponent(deviceId)}/${encodeURIComponent(sessionId)}`;
}

function parseUiResourceUri(value) {
  if (typeof value !== "string") throw new ToolInputError("A Reader UI resource uri is required");
  let parsed;
  try { parsed = new URL(value); } catch { throw new ToolInputError("Invalid Reader UI resource uri"); }
  const parts = parsed.pathname.split("/");
  if (parsed.protocol !== "reader:" || parsed.host !== "ui-requests" || parsed.username || parsed.password
    || parsed.search || parsed.hash || parts.length !== 3) throw new ToolInputError("Invalid Reader UI resource uri");
  let deviceId, sessionId;
  try {
    deviceId = validateRequiredIdentity(decodeURIComponent(parts[1]), "deviceId");
    sessionId = validateSessionId(decodeURIComponent(parts[2]));
  } catch { throw new ToolInputError("Invalid Reader UI resource identity"); }
  const uri = uiResourceUri(deviceId, sessionId);
  if (value !== uri) throw new ToolInputError("Reader UI resource uri must use canonical encoded identities");
  return { uri, deviceId, sessionId };
}

function validateUiSnapshot(body, sessionId) {
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_UI_SNAPSHOT_BYTES) {
    throw new ToolInputError(`Reader UI snapshot exceeds ${MAX_UI_SNAPSHOT_BYTES} bytes; no partial requests are actionable`);
  }
  if (!isRecord(body) || body.schemaVersion !== 1 || body.sessionId !== sessionId
    || body.runtimeStartAttempted !== false || body.writeSideEffects !== false
    || !Number.isSafeInteger(body.revision) || body.revision < 0
    || !["live", "not_live", "closed"].includes(body.runtimeStatus)
    || !Array.isArray(body.requests)
    || !(body.runtimeGeneration === null || safeIdentity(body.runtimeGeneration))
    || (body.runtimeStatus === "live" && !body.runtimeGeneration)
    || (body.runtimeStatus !== "live" && body.requests.length > 0)) {
    throw new ToolInputError("Reader UI snapshot contract mismatch; no requests are actionable");
  }
  const ids = new Set();
  for (const request of body.requests) {
    if (!isRecord(request) || !safeIdentity(request.id) || ids.has(request.id)
      || request.runtimeGeneration !== body.runtimeGeneration
      || !["select", "confirm", "input", "editor", "custom"].includes(request.method)
      || !isRecord(request.responseSchema)
      || request.responseSchema.kind !== (request.method === "custom" ? "custom" : request.method === "select" ? "select" : request.method === "confirm" ? "confirm" : "text")
      || (request.method === "custom" && request.responseSchema.supported !== false)
      || typeof request.responseSchema.allowFreeText !== "boolean"
      || (request.method === "select" && (!Array.isArray(request.responseSchema.options)
        || request.responseSchema.options.some((option) => typeof option !== "string")))) {
      throw new ToolInputError("Reader pending UI request contract mismatch; no partial snapshot is actionable");
    }
    ids.add(request.id);
  }
  // UI options, prompts and editor text are response values, not display summaries.
  // Preserve their exact bytes and reject oversized snapshots rather than sanitize/truncate.
  return body;
}

async function uiTarget(state, sessionId, device, signal) {
  if (!state.readerUrl) throw new ToolInputError("UI requests require PI_WEB_READER_URL; storage mode has no authoritative runtime");
  const target = await locateLiveSessionTarget(state, sessionId, device, signal);
  if (!target.ok) return target;
  const route = controlRoute(state.readerUrl, target.localDeviceId === target.device.id, target.device.id, sessionId);
  route.url.pathname += "/ui-requests";
  return { ...target, url: route.url, resourceUri: uiResourceUri(target.device.id, sessionId) };
}

function uiReadResult(snapshot, target, extra = {}) {
  return { ...snapshot, source: "reader-ui-requests", outcome: "observed",
    resourceUri: target.resourceUri, deviceId: target.device.id, ...extra };
}

function exactUiAnswerResult(body) {
  if (!isRecord(body) || Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_UI_SNAPSHOT_BYTES) {
    return { outcome: "unknown", code: "ui_answer_result_unavailable", reason: "Reader answer result exceeded the exact-result transport limit or was malformed; do not automatically retry" };
  }
  return body;
}

async function readReaderUiRequests(state, args, requestId) {
  const sessionId = validateSessionId(args.sessionId);
  if (["cursor", "bootId", "maxBytes", "maxEvents"].some((key) => args[key] !== undefined)) {
    throw new ToolInputError("UI request modes do not accept event cursors or truncation limits");
  }
  const waiting = args.mode === "wait_ui_requests";
  if (!waiting && (args.runtimeGeneration !== undefined || args.revision !== undefined)) {
    throw new ToolInputError("runtimeGeneration/revision are supported only for wait_ui_requests");
  }
  if ((args.runtimeGeneration !== undefined) !== (args.revision !== undefined)) {
    throw new ToolInputError("wait_ui_requests requires runtimeGeneration and revision together");
  }
  const timeoutMs = validateInteger(args.timeoutMs ?? (waiting ? 30_000 : REMOTE_TIMEOUT_MS), 1,
    waiting ? MAX_UI_WAIT_TIMEOUT_MS : MAX_LIVE_EVENT_TIMEOUT_MS, "timeoutMs");
  if (!waiting) {
    const target = await uiTarget(state, sessionId, args.device);
    if (!target.ok) return target.value;
    const snapshot = validateUiSnapshot(await fetchLiveProjection(target.url, MAX_UI_SNAPSHOT_BYTES, timeoutMs), sessionId);
    return uiReadResult(snapshot, target);
  }
  const controller = new AbortController();
  if (state.closed) throw new ToolInputError("MCP transport is closed");
  state.uiWaits.set(requestId, controller);
  let latest;
  let timedOut = false;
  let matched = false;
  let target;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    target = await uiTarget(state, sessionId, args.device, controller.signal);
    if (controller.signal.aborted) throw new Error("UI request wait aborted during target discovery");
    if (!target.ok) return target.value;
    await streamUiSnapshots(target.url, sessionId, controller, (snapshot) => {
      latest = snapshot;
      if (args.revision === undefined || snapshot.revision !== args.revision || snapshot.runtimeGeneration !== args.runtimeGeneration) {
        matched = true;
        return false;
      }
    });
    if (!matched) throw new Error("Reader UI event stream closed before a change; read a fresh snapshot and reconnect");
    return uiReadResult(latest, target, { outcome: args.revision === undefined ? "observed" : "changed", transport: "sse" });
  } catch (error) {
    if (timedOut && latest) return uiReadResult(latest, target, { outcome: "timeout", transport: "sse", changed: false });
    if (timedOut) throw new ToolInputError("UI request wait timed out before an authoritative snapshot arrived");
    if (controller.signal.aborted && !timedOut) throw new ToolInputError("UI request wait cancelled");
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    state.uiWaits.delete(requestId);
  }
}

async function handleUiResourceRequest(id, method, params, state) {
  try {
    if (!state.initialized || state.closed) throw new ToolInputError("Initialize an open MCP connection before using resources");
    const binding = parseUiResourceUri(params?.uri);
    if (method === "resources/unsubscribe") {
      state.uiSubscriptions.get(binding.uri)?.controller.abort();
      state.uiSubscriptions.delete(binding.uri);
      sendResult(id, {});
      return;
    }
    if (method === "resources/read") {
      const result = await readReaderUiRequests(state, { sessionId: binding.sessionId, device: binding.deviceId, mode: "ui_requests" }, id);
      if (result.source !== "reader-ui-requests" || result.resourceUri !== binding.uri) {
        sendError(id, -32002, "Authoritative Reader UI resource is unavailable", result);
        return;
      }
      const subscription = state.uiSubscriptions.get(binding.uri);
      if (subscription) result.subscription = { status: subscription.status, ...(subscription.error ? { error: subscription.error, recovery: "resources/subscribe again for a fresh authoritative stream" } : {}) };
      sendResult(id, { contents: [{ uri: binding.uri, mimeType: "application/json", text: JSON.stringify(result) }] });
      return;
    }
    const current = state.uiSubscriptions.get(binding.uri);
    if (current?.status === "connected") { current.acknowledged = true; sendResult(id, {}); return; }
    if (current?.ready) { await awaitUiSubscriptionReady(state, id, current); sendResult(id, {}); return; }
    if (!current && state.uiSubscriptions.size >= MAX_UI_SUBSCRIPTIONS) throw new ToolInputError(`At most ${MAX_UI_SUBSCRIPTIONS} UI subscriptions are supported; unsubscribe unused resources`);
    current?.controller.abort();
    const subscription = { controller: new AbortController(), status: "connecting", waiters: new Set(), acknowledged: false };
    // Reserve before I/O so overlapping subscribe requests cannot leak duplicate streams.
    state.uiSubscriptions.set(binding.uri, subscription);
    let resolveReady, rejectReady;
    subscription.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const timeout = setTimeout(() => subscription.controller.abort(), REMOTE_TIMEOUT_MS);
    let seenInitial = false;
    const notify = () => {
      if (!state.closed && state.uiSubscriptions.get(binding.uri) === subscription && !subscription.controller.signal.aborted) {
        send({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri: binding.uri } });
      }
    };
    void (async () => {
      try {
        const target = await uiTarget(state, binding.sessionId, binding.deviceId, subscription.controller.signal);
        if (!target.ok || target.resourceUri !== binding.uri) throw new ToolInputError("Authoritative Reader UI resource is unavailable");
        await streamUiSnapshots(target.url, binding.sessionId, subscription.controller, (snapshot) => {
          const changed = !subscription.snapshot || snapshot.runtimeGeneration !== subscription.snapshot.runtimeGeneration || snapshot.revision !== subscription.snapshot.revision;
          subscription.snapshot = snapshot;
          subscription.status = snapshot.runtimeStatus === "live" ? "connected" : "closed";
          if (!seenInitial) {
            seenInitial = true;
            clearTimeout(timeout);
            resolveReady();
          } else if (changed) notify();
        });
        if (subscription.status !== "closed") throw new Error("Reader UI event stream disconnected; resubscribe for a fresh snapshot");
      } catch (error) {
        if (!seenInitial) rejectReady(error);
        else if (!subscription.controller.signal.aborted) {
          subscription.status = "disconnected";
          subscription.error = publicRemoteError(error);
          delete subscription.snapshot;
          notify();
        }
      } finally {
        clearTimeout(timeout);
        if (!seenInitial && state.uiSubscriptions.get(binding.uri) === subscription) state.uiSubscriptions.delete(binding.uri);
        delete subscription.ready;
      }
    })();
    await awaitUiSubscriptionReady(state, id, subscription);
    sendResult(id, {});
  } catch (error) {
    sendError(id, error instanceof ToolInputError ? -32602 : -32603, error instanceof Error ? error.message : String(error));
  }
}

async function awaitUiSubscriptionReady(state, id, subscription) {
  const controller = new AbortController();
  state.uiWaits.set(id, controller);
  subscription.waiters.add(controller);
  let onAbort;
  try {
    await new Promise((resolve, reject) => {
      onAbort = () => reject(new ToolInputError("UI resource subscription cancelled"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      subscription.ready.then(resolve, reject);
    });
    controller.signal.throwIfAborted();
    subscription.acknowledged = true;
  } finally {
    controller.signal.removeEventListener("abort", onAbort);
    state.uiWaits.delete(id);
    subscription.waiters.delete(controller);
    // A cancelled duplicate request must not close another caller's active
    // subscription; an entirely cancelled handshake must never leave an SSE.
    if (!subscription.acknowledged && subscription.waiters.size === 0) subscription.controller.abort();
  }
}

async function streamUiSnapshots(url, sessionId, controller, onSnapshot) {
  const streamUrl = new URL(url);
  streamUrl.searchParams.set("stream", "1");
  const response = await fetch(streamUrl, { cache: "no-store", signal: controller.signal, headers: { Accept: "text/event-stream" }, redirect: "error" });
  if (!response.ok || !/^text\/event-stream(?:;|$)/i.test(response.headers.get("content-type") ?? "") || !response.body) {
    await response.body?.cancel();
    throw new Error(`Reader UI SSE unavailable (HTTP ${response.status}); no polling fallback`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let frame = [];
  let frameBytes = 0;
  let previous;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      pending += decoder.decode(chunk.value, { stream: true });
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        frameBytes += Buffer.byteLength(line, "utf8") + 1;
        if (frameBytes > MAX_UI_SNAPSHOT_BYTES + 4096) throw new Error("Reader UI SSE frame exceeds the safety size limit; no partial requests are actionable");
        if (line !== "") { frame.push(line); continue; }
        const lines = frame;
        frame = [];
        frameBytes = 0;
        const event = lines.filter((item) => item.startsWith("event:")).at(-1)?.slice(6).replace(/^ /, "");
        if (event !== "ui_requests") continue;
        const data = lines.filter((item) => item.startsWith("data:")).map((item) => item.slice(5).replace(/^ /, "")).join("\n");
        const snapshot = validateUiSnapshot(JSON.parse(data), sessionId);
        if (previous && snapshot.runtimeGeneration === previous.runtimeGeneration && snapshot.revision < previous.revision) {
          throw new Error("Reader UI SSE revision regressed; read a fresh authoritative snapshot");
        }
        previous = snapshot;
        if (onSnapshot(snapshot) === false) return;
      }
      if (Buffer.byteLength(pending, "utf8") + frameBytes > MAX_UI_SNAPSHOT_BYTES + 4096) throw new Error("Reader UI SSE frame exceeds the safety size limit; no partial requests are actionable");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function closeUiTransports(state) {
  state.closed = true;
  for (const subscription of state.uiSubscriptions.values()) subscription.controller.abort();
  state.uiSubscriptions.clear();
  for (const controller of state.uiWaits.values()) controller.abort();
  state.uiWaits.clear();
}

function liveProjectionRuntimeStatusSemantics() {
  return {
    runtimeStatusValues: ["live", "not_live", "unknown"],
    runtimeChecked: true,
    statusSource: "Reader live registry or verified retained event ledger",
    idleDoesNotMeanComplete: true,
    runtimeStartAttempted: false,
    writeSideEffects: false,
    cursorSource: "Reader runtime bootId and locked per-session ledger cursor",
    durableLedger: "reader-required",
    gapRecovery: "reader-provided oldestCursor; adapter reports gap",
  };
}

async function locateLiveSessionTarget(state, sessionId, deviceFilterValue, signal) {
  const deviceFilter = deviceFilterValue === undefined
    ? undefined
    : validateDeviceFilter(deviceFilterValue).toLocaleLowerCase();
  const collected = await collectReaderApiRows(state.readerUrl, {
    scope: "active",
    visibility: "all",
    limit: MAX_LIST_LIMIT,
    offset: 0,
  }, signal);
  const matches = collected.rows.filter((row) => {
    if (row.id !== sessionId) return false;
    if (deviceFilter === undefined) return true;
    return row.device.id.toLocaleLowerCase() === deviceFilter || row.device.name.toLocaleLowerCase() === deviceFilter;
  });
  if (matches.length === 1) {
    const row = matches[0];
    if (row.device.online === false) {
      return {
        ok: false,
        value: {
          source: "reader-live-runtime",
          found: false,
          sessionId,
          outcome: "unavailable",
          reason: "target device is offline; no live runtime request was sent",
          target: { device: row.device, sessionId },
          coverage: collected.coverage,
          runtimeStatusSemantics: liveProjectionRuntimeStatusSemantics(),
        },
      };
    }
    return {
      ok: true,
      row,
      device: row.device,
      localDeviceId: collected.localDevice.id,
      coverage: collected.coverage,
    };
  }
  if (matches.length > 1) throw new ToolInputError("Session id exists on more than one device; pass device explicitly");

  const device = deviceFilter === undefined
    ? undefined
    : collected.devices.find((candidate) => candidate.id.toLocaleLowerCase() === deviceFilter || candidate.name.toLocaleLowerCase() === deviceFilter);
  const deviceId = device?.id;
  const binding = deviceId ? state.createdSessionBindings.get(controlBindingKey(deviceId, sessionId)) : undefined;
  if (device && device.online !== false && binding && binding.deviceId === deviceId && binding.sessionId === sessionId && binding.localDeviceId === collected.localDevice.id) {
    const runtimeRoute = controlRoute(state.readerUrl, collected.localDevice.id === deviceId, deviceId, sessionId);
    const verification = await verifyCreatedSessionBinding(runtimeRoute, binding, signal);
    if (verification.ok) {
      return {
        ok: true,
        row: null,
        device,
        localDeviceId: collected.localDevice.id,
        coverage: collected.coverage,
        transientBinding: true,
      };
    }
  }
  return {
    ok: false,
    value: {
      source: "reader-live-runtime",
      found: false,
      sessionId,
      outcome: collected.coverage.complete ? "not_found" : "unknown",
      reason: collected.coverage.complete
        ? "session is not present in the active Reader snapshot and has no verified live binding; no runtime was started"
        : "Reader coverage is incomplete; live ownership could not be verified and no runtime was started",
      coverage: collected.coverage,
      runtimeStatusSemantics: liveProjectionRuntimeStatusSemantics(),
    },
  };
}

async function readReaderSessionTail(state, args) {
  const sessionId = validateSessionId(args.sessionId);
  const requestedScope = args.scope === undefined ? "both" : validateScope(args.scope, true);
  const visibility = validateVisibility(args.visibility || "visible");
  const maxEntries = validateInteger(args.maxEntries === undefined ? 20 : args.maxEntries, 1, MAX_TAIL_ENTRIES, "maxEntries");
  const maxBytes = validateInteger(args.maxBytes === undefined ? DEFAULT_TAIL_BYTES : args.maxBytes, 4096, MAX_LIVE_TAIL_BYTES, "maxBytes");
  const deviceFilter = args.device === undefined ? undefined : validateDeviceFilter(args.device).toLocaleLowerCase();
  const collected = await collectReaderApiRows(state.readerUrl, {
    ...args,
    scope: requestedScope,
    visibility,
    offset: 0,
    limit: MAX_LIST_LIMIT,
  });
  const matches = filterReaderRows(collected.rows, {
    ...args,
    scope: requestedScope,
    visibility,
    timeRange: "all",
  }).filter((row) => {
    if (row.id !== sessionId) return false;
    if (deviceFilter === undefined) return true;
    return row.device.id.toLocaleLowerCase() === deviceFilter || row.device.name.toLocaleLowerCase() === deviceFilter;
  });

  let target;
  let transientBinding = false;
  if (matches.length === 0 && args.device !== undefined) {
    const requestedDevice = validateDeviceFilter(args.device).toLocaleLowerCase();
    const device = collected.devices.find((candidate) => candidate.id.toLocaleLowerCase() === requestedDevice || candidate.name.toLocaleLowerCase() === requestedDevice);
    const deviceId = device?.id;
    const binding = deviceId ? state.createdSessionBindings.get(controlBindingKey(deviceId, sessionId)) : undefined;
    if (device && device.online !== false && binding && binding.deviceId === deviceId && binding.sessionId === sessionId && binding.localDeviceId === collected.localDevice.id) {
      const runtimeRoute = controlRoute(state.readerUrl, collected.localDevice.id === deviceId, deviceId, sessionId);
      const verification = await verifyCreatedSessionBinding(runtimeRoute, binding);
      if (verification.ok) {
        target = { row: null, device, localDeviceId: collected.localDevice.id, coverage: collected.coverage };
        transientBinding = true;
      }
    }
  }

  if (!target) {
    if (matches.length === 0) {
      return {
        source: "reader-api-session-detail",
        found: false,
        sessionId,
        countExact: collected.countExact,
        note: collected.countExact
          ? "Session was not present in the Reader activity snapshot; no detail request was sent."
          : "Session was not present in the available Reader snapshots; incomplete coverage prevents a definitive not-found result.",
        coverage: collected.coverage,
        runtimeStatusSemantics: liveDetailRuntimeStatusSemantics(),
      };
    }
    if (matches.length > 1) {
      throw new ToolInputError("Session id exists on more than one device or storage scope; pass scope, visibility, or device explicitly");
    }
    const row = matches[0];
    target = {
      row,
      device: row.device,
      localDeviceId: collected.localDevice.id,
      coverage: collected.coverage,
    };
  }

  const isLocal = target.localDeviceId === target.device.id;
  // The ordinary session-detail route may restore question-analysis jobs.
  // Reader's safe-history route is the only allowed live-mode history source:
  // it uses the existing live registry or a read-only JSONL snapshot and
  // declares runtimeStartAttempted/writeSideEffects explicitly.
  const route = readerSafeHistoryRoute(state.readerUrl, isLocal, target.device.id, sessionId);
  route.url.searchParams.set("tail", String(maxEntries));
  route.url.searchParams.set("maxEntries", String(maxEntries));
  route.url.searchParams.set("maxBytes", String(maxBytes));
  let detail;
  try {
    detail = await fetchWithBoundedJson(route.url);
  } catch (error) {
    return {
      source: "reader-safe-history",
      found: false,
      sessionId,
      outcome: /http_404/i.test(error instanceof Error ? error.message : String(error)) ? "not_found" : "unknown",
      reason: "Reader safe history could not be read; no runtime was started",
      error: publicRemoteError(error),
      runtimeStartAttempted: false,
      writeSideEffects: false,
      coverage: target.coverage,
      runtimeStatusSemantics: liveDetailRuntimeStatusSemantics(),
    };
  }
  if (!detail || typeof detail !== "object" || Array.isArray(detail) || detail.runtimeStartAttempted !== false || detail.writeSideEffects !== false || !Array.isArray(detail.entries)) {
    return {
      source: "reader-safe-history",
      found: false,
      sessionId,
      outcome: "unknown",
      reason: "Reader safe-history response did not satisfy the no-wake contract",
      code: "safe_history_contract_mismatch",
      runtimeStartAttempted: false,
      writeSideEffects: false,
      coverage: target.coverage,
      runtimeStatusSemantics: liveDetailRuntimeStatusSemantics(),
    };
  }
  const entries = sanitizePublicValue(detail.entries.slice(0, maxEntries));
  const entryList = Array.isArray(entries) ? entries : [];
  const bytesRead = safeCount(detail.bytesRead) ?? Buffer.byteLength(JSON.stringify(entryList), "utf8");
  const sessionFilePath = typeof detail.sessionFilePath === "string" && detail.sessionFilePath.trim()
    ? detail.sessionFilePath
    : null;
  return {
    source: "reader-safe-history",
    found: true,
    outcome: "observed",
    session: {
      id: sessionId,
      ...(target.row ? {
        storageScope: target.row.storageScope,
        title: target.row.title,
        project: target.row.project,
      } : {
        storageScope: "transient",
        title: "transient session",
        project: "unknown",
      }),
      device: target.device,
    },
    runtimeStatus: typeof detail.runtimeStatus === "string" ? safeEnum(detail.runtimeStatus, ["live", "not_live"]) : "unknown",
    durableOnly: detail.durableOnly === true,
    snapshotRevision: safeIdentity(detail.snapshotRevision),
    entries: entryList,
    returnedCount: entryList.length,
    sessionFilePath,
    guidance: sessionFilePath
      ? ((detail.truncated === true || entryList.length >= maxEntries)
        ? "Older conversation entries exist beyond this bounded tail. If historical context is needed, inspect the physical JSONL file at the returned sessionFilePath using local file reading tools."
        : undefined)
      : `Reader did not provide a physical JSONL path. If more history is needed, call reader_read_tail again with maxEntries: 50 and maxBytes: ${MAX_LIVE_TAIL_BYTES}; do not infer or read a null path.`,
    truncatedByBytes: detail.truncated === true,
    truncated: detail.truncated === true,
    bytesRead,
    runtimeStartAttempted: false,
    writeSideEffects: false,
    transientBinding,
    coverage: detail.coverage && typeof detail.coverage === "object" ? sanitizePublicValue(detail.coverage) : target.coverage,
    runtimeStatusSemantics: liveDetailRuntimeStatusSemantics(),
  };
}

function liveDetailRuntimeStatusSemantics() {
  return {
    runtimeStatusValues: [...READER_STATUSES],
    runtimeChecked: false,
    statusSource: "Reader /api/reader/session-catalog observe-only snapshot; history is a bounded transcript read",
    idleDoesNotMeanComplete: true,
    writeSideEffects: false,
    runtimeStartAttempted: false,
    detailRouteUsed: false,
    safeHistoryRouteUsed: true,
  };
}

async function publicReaderDetailMessage(baseUrl, isLocal, deviceId, sessionId, rawMessage) {
  if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) return null;
  const role = typeof rawMessage.role === "string" ? rawMessage.role : "";
  if (!["user", "assistant", "toolResult", "bashExecution"].includes(role)) return null;
  const entryId = typeof rawMessage.entryId === "string" ? safeIdentity(rawMessage.entryId) : null;
  let text = liveMessageText(rawMessage.content ?? rawMessage.text ?? rawMessage.message ?? rawMessage.output);
  if (role === "toolResult" && rawMessage.deferredText === true && entryId) {
    const deferredRoute = readerToolResultRoute(baseUrl, isLocal, deviceId, sessionId, entryId);
    try {
      const deferred = await fetchWithBoundedJson(deferredRoute.url, MAX_TAIL_BYTES);
      if (typeof deferred?.text === "string") text = sanitizeText(deferred.text);
    } catch {
      text = "[tool result unavailable or too large]";
    }
  }
  const toolCallCount = role === "assistant" && Array.isArray(rawMessage.content)
    ? rawMessage.content.filter((part) => part && typeof part === "object" && part.type === "toolCall").length
    : 0;
  return {
    role,
    timestamp: safeTimestamp(rawMessage.entryTimestamp ?? rawMessage.timestamp),
    text: truncate(text || (role === "toolResult" ? "[tool result has no text]" : "[non-text output omitted]"), MAX_DISPLAY_TEXT),
    ...(toolCallCount > 0 ? { toolCallCount } : {}),
    ...(typeof rawMessage.isError === "boolean" ? { isError: rawMessage.isError } : {}),
  };
}

function liveMessageText(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return "";
  if (typeof value === "string") return sanitizeText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((part) => liveMessageText(part, depth + 1)).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";
  if (value.type === "image" || value.type === "image_url") return "[image omitted]";
  if (value.type === "toolCall") return "";
  const parts = [];
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key)) continue;
    if (["text", "content", "summary", "message", "output"].includes(key)) {
      const text = liveMessageText(child, depth + 1);
      if (text) parts.push(text);
    }
  }
  return parts.join("\n");
}

function boundLiveMessages(messages, maxBytes) {
  const selected = [];
  let bytesRead = 0;
  let truncatedByBytes = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (selected.length > 0 && bytesRead + bytes > maxBytes) {
      truncatedByBytes = true;
      continue;
    }
    selected.unshift(message);
    bytesRead += bytes;
    if (bytesRead >= maxBytes) {
      if (index > 0) truncatedByBytes = true;
      break;
    }
  }
  return { entries: selected, bytesRead, truncatedByBytes };
}

async function readStorageSessionTail(root, args) {
  const sessionId = validateSessionId(args.sessionId);
  const requestedScope = args.scope === undefined ? "both" : validateScope(args.scope, true);
  const maxEntries = validateInteger(args.maxEntries === undefined ? 20 : args.maxEntries, 1, MAX_TAIL_ENTRIES, "maxEntries");
  const maxBytes = validateInteger(args.maxBytes === undefined ? DEFAULT_TAIL_BYTES : args.maxBytes, 4096, MAX_STORAGE_TAIL_BYTES, "maxBytes");
  const scopes = requestedScope === "both" ? ["active", "archived"] : [requestedScope];
  const scan = await scanScopes(root, scopes, { includeSamples: false });
  const matches = scan.sessions.filter((row) => row.id === sessionId);
  if (matches.length === 0) {
    throw new ToolInputError("Session not found in the configured local data root");
  }
  if (matches.length > 1) {
    throw new ToolInputError("Session id exists in more than one storage scope; pass scope explicitly");
  }

  const row = matches[0];
  const tail = await readTail(row.filePath, maxBytes);
  const entries = parseJsonLines(tail.text)
    .filter((item) => item.message)
    .map((item) => item.message)
    .slice(-maxEntries)
    .map(publicMessage);
  const sessionFilePath = typeof row.filePath === "string" && row.filePath.trim() ? row.filePath : null;

  return {
    device: deviceName,
    session: {
      id: row.id,
      storageScope: row.storageScope,
      project: row.project,
      title: row.title,
    },
    entries,
    returnedCount: entries.length,
    sessionFilePath,
    guidance: sessionFilePath
      ? ((tail.truncated || entries.length >= maxEntries)
        ? "Older conversation entries exist beyond this bounded tail. If historical context is needed, inspect the physical JSONL file at the returned sessionFilePath using local file reading tools."
        : undefined)
      : `The configured storage scan did not provide a physical JSONL path. If more history is needed, call reader_read_tail again with maxEntries: 50 and maxBytes: ${MAX_STORAGE_TAIL_BYTES}; do not infer or read a null path.`,
    truncatedByBytes: tail.truncated,
    bytesRead: tail.bytesRead,
    runtimeStatusSemantics: runtimeStatusSemantics(),
  };
}

const READER_VISIBILITIES = new Set(["visible", "hidden", "all"]);
const READER_STATUSES = new Set(["running", "retrying", "waiting_user", "just_completed", "idle", "failed", "aborted", "unknown"]);
const READER_TIME_RANGES = new Set(["all", "1", "3", "7", "14", "30", "90"]);

async function listReaderApiSessions(baseUrl, args) {
  const collected = await collectReaderApiRows(baseUrl, args);
  const matching = filterReaderRows(collected.rows, args);
  const timeRange = validateTimeRange(args.timeRange || "all");
  const timeRangeUnknownCount = timeRange === "all"
    ? 0
    : filterReaderRows(collected.rows, { ...args, timeRange: "all" }).filter((row) => !row.lastActivityAt).length;
  const offset = validateInteger(args.offset === undefined ? 0 : args.offset, 0, MAX_LIST_OFFSET, "offset");
  const limit = validateInteger(args.limit === undefined ? MAX_LIST_LIMIT : args.limit, 1, MAX_LIST_LIMIT, "limit");
  const ordered = matching.sort(compareReaderRows);
  const page = ordered.slice(offset, offset + limit).map(publicReaderRow);
  const summary = summarizeReaderRows(ordered, collected.devices);
  summary.timeRangeUnknownCount = timeRangeUnknownCount;
  const countExact = collected.countExact && timeRangeUnknownCount === 0;

  return {
    source: "reader-api",
    storageScopeRequested: validateScope(args.scope || "both", true),
    visibilityRequested: validateVisibility(args.visibility || "visible"),
    timeRangeRequested: validateTimeRange(args.timeRange || "all"),
    deviceFilter: args.device === undefined ? null : validateDeviceFilter(args.device),
    projectFilter: args.project === undefined ? null : validateProject(args.project),
    statusFilter: args.status === undefined ? null : validateReaderStatus(args.status),
    generatedAt: collected.generatedAt,
    device: collected.localDevice,
    devices: collected.devices,
    sessions: page,
    returnedCount: page.length,
    matchingCountObserved: ordered.length,
    totalCount: ordered.length,
    countExact,
    pagination: paginationFor(offset, limit, ordered.length),
    summary: {
      ...summary,
      countExact,
    },
    coverage: collected.coverage,
    runtimeStatusSemantics: readerRuntimeStatusSemantics(),
  };
}

async function getReaderApiSessionMetadata(baseUrl, args) {
  const sessionId = validateSessionId(args.sessionId);
  const requestedScope = args.scope === undefined ? "both" : validateScope(args.scope, true);
  const collected = await collectReaderApiRows(baseUrl, {
    ...args,
    scope: requestedScope,
    offset: 0,
    limit: MAX_LIST_LIMIT,
  });
  const matches = filterReaderRows(collected.rows, args).filter((row) => row.id === sessionId);
  const timeRange = validateTimeRange(args.timeRange || "all");
  const timeRangeUnknownCount = timeRange === "all"
    ? 0
    : filterReaderRows(collected.rows, { ...args, timeRange: "all" }).filter((row) => !row.lastActivityAt).length;
  const countExact = collected.countExact && timeRangeUnknownCount === 0;
  if (matches.length === 0) {
    if (!countExact) {
      return {
        found: false,
        sessionId,
        countExact: false,
        note: "Session was not present in the available Reader snapshots; offline or invalid coverage prevents a definitive not-found result.",
        coverage: collected.coverage,
        runtimeStatusSemantics: readerRuntimeStatusSemantics(),
      };
    }
    throw new ToolInputError("Session not found in the Reader activity snapshot");
  }
  if (matches.length > 1) {
    throw new ToolInputError("Session id exists on more than one device or storage scope; pass scope, visibility, or device explicitly");
  }

  const row = matches[0];
  return {
    found: true,
    device: row.device,
    session: publicReaderRow(row),
    fileObservation: {
      source: "Reader /api/reader/session-catalog",
      exists: true,
      storageScope: row.storageScope,
      lastActivityAt: row.lastActivityAt,
      lastActivitySource: "Reader session activity snapshot",
      runtimeStatusSource: row.statusSource,
    },
    coverage: collected.coverage,
    countExact,
    runtimeStatusSemantics: readerRuntimeStatusSemantics(),
  };
}

async function collectReaderApiRows(baseUrl, args, signal) {
  signal?.throwIfAborted();
  const scope = validateScope(args.scope || "both", true);
  const visibility = validateVisibility(args.visibility || "visible");
  const requests = [];
  const storageScopes = scope === "both" ? ["active", "archived"] : [scope];
  const visibilityScopes = visibility === "all" ? ["visible", "hidden"] : [visibility];
  for (const storageScope of storageScopes) {
    for (const requestedVisibility of visibilityScopes) {
      requests.push({ storageScope, visibility: requestedVisibility });
    }
  }

  const results = await Promise.all(requests.map(async (request) => {
    try {
      const payload = await fetchReaderSnapshot(baseUrl, request.storageScope, request.visibility, signal);
      return { ...request, payload };
    } catch (error) {
      signal?.throwIfAborted();
      return { ...request, error: publicRemoteError(error) };
    }
  }));
  signal?.throwIfAborted();

  const rowsByKey = new Map();
  const devicesById = new Map();
  const coverage = [];
  let generatedAt;
  let localDevice;
  let invalidRows = 0;
  let successfulResponses = 0;

  for (const result of results) {
    if (result.error) {
      coverage.push({
        source: "reader-api",
        storageScope: result.storageScope,
        visibility: result.visibility,
        requestSucceeded: false,
        sessionsReceived: 0,
        devicesObserved: 0,
        error: result.error,
      });
      continue;
    }

    successfulResponses += 1;
    const payload = result.payload;
    generatedAt = newerTimestamp(generatedAt, safeTimestamp(payload.generatedAt));
    if (!localDevice) localDevice = publicReaderDevice(payload.device);
    for (const rawDevice of Array.isArray(payload.devices) ? payload.devices : []) {
      const device = publicReaderDevice(rawDevice);
      if (device) mergeReaderDevice(devicesById, device);
    }
    const rawSessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    let accepted = 0;
    for (const rawSession of rawSessions) {
      const row = normalizeReaderRow(rawSession, result.storageScope, result.visibility, payload.generatedAt);
      if (!row) {
        invalidRows += 1;
        continue;
      }
      accepted += 1;
      const key = `${row.device.id}\u0000${row.id}\u0000${row.storageScope}`;
      const existing = rowsByKey.get(key);
      if (!existing || (existing.visibility === "hidden" && row.visibility === "visible")) rowsByKey.set(key, row);
      mergeReaderDevice(devicesById, row.device);
    }
    coverage.push({
      source: "reader-api",
      storageScope: result.storageScope,
      visibility: result.visibility,
      requestSucceeded: true,
      generatedAt: safeTimestamp(payload.generatedAt),
      sessionsReceived: rawSessions.length,
      sessionRowsAccepted: accepted,
      invalidRows: rawSessions.length - accepted,
      devicesObserved: Array.isArray(payload.devices) ? payload.devices.length : 0,
    });
  }

  const devices = [...devicesById.values()].sort(compareReaderDevices);
  const offlineDevices = devices.filter((device) => device.online === false);
  const countExact = successfulResponses === results.length
    && results.length > 0
    && offlineDevices.length === 0
    && invalidRows === 0;
  return {
    rows: [...rowsByKey.values()],
    devices,
    localDevice: localDevice ?? { id: "unknown-local", name: "unknown", online: undefined },
    generatedAt: generatedAt ?? null,
    coverage: {
      source: "reader-api",
      localOnly: false,
      readerUiEquivalent: true,
      hiddenStateApplied: visibility !== "visible",
      runtimeSessionsIncluded: true,
      runtimeStatusSource: "/api/reader/session-catalog observe-only snapshot",
      subprojectAssignmentsApplied: true,
      storageScopesRequested: storageScopes,
      visibilityRequested: visibility,
      devicesObserved: devices.length,
      offlineDevices: offlineDevices.map((device) => ({ id: device.id, name: device.name, error: device.error ?? "offline" })),
      requests: coverage,
      complete: countExact,
      countExact,
      note: countExact
        ? "Reader aggregate snapshots covered every requested storage/visibility slice and reported all observed devices online."
        : "Count is a lower bound for the available snapshots; an unavailable device, failed slice, or invalid row prevents a definitive total.",
      pagination: "MCP applies offset/limit after reading the complete bounded Reader snapshots; it does not claim server-side page totals.",
    },
    countExact,
  };
}

async function fetchReaderSnapshot(baseUrl, storageScope, visibility, signal) {
  const url = new URL("/api/reader/session-catalog", `${baseUrl}/`);
  url.searchParams.set("scope", visibility === "hidden" ? "hidden" : "all");
  if (storageScope === "archived") url.searchParams.set("archived", "1");
  const response = await fetchWithBoundedJson(url, MAX_REMOTE_BODY_BYTES, REMOTE_TIMEOUT_MS, signal);
  if (!response || response.schemaVersion !== 1 || !Array.isArray(response.sessions) || !Array.isArray(response.devices)) {
    throw new Error("invalid Reader activity snapshot");
  }
  if (response.observation?.schemaVersion !== 1 || response.observation.readOnly !== true
    || response.observation.runtimeStartAttempted !== false || response.observation.writeSideEffects !== false) {
    throw new Error("Reader observe-only session catalog contract is unavailable");
  }
  return response;
}

async function fetchWithBoundedJson(url, maxBytes = MAX_REMOTE_BODY_BYTES, timeoutMs = REMOTE_TIMEOUT_MS, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Reader HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error("Reader response exceeded the safety size limit");
    }
    const body = await readResponseBody(response, maxBytes);
    try {
      return JSON.parse(body);
    } catch {
      throw new Error("Reader response was not valid JSON");
    }
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Reader request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLiveProjection(url, maxBytes, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    const bodyText = await readResponseBody(response, maxBytes);
    let body;
    try { body = JSON.parse(bodyText); } catch { body = null; }
    if (!response.ok) {
      const code = body && typeof body.code === "string" ? body.code : "";
      const error = new Error(`Reader HTTP ${response.status}${code ? ` ${code}` : ""}`);
      error.status = response.status;
      error.code = code;
      error.body = body;
      throw error;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Reader response was not valid JSON");
    return body;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Reader request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseBody(response, maxBytes) {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("Reader response exceeded the safety size limit");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Reader response exceeded the safety size limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function publicRemoteError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out/i.test(message)) return "timeout";
  if (/HTTP 404/i.test(message)) return "http_404";
  if (/HTTP 4\d\d/i.test(message)) return "http_4xx";
  if (/HTTP 5\d\d/i.test(message)) return "http_5xx";
  if (/safety size limit/i.test(message)) return "response_too_large";
  if (/invalid Reader activity snapshot|not valid JSON/i.test(message)) return "invalid_response";
  return "offline";
}

function configuredTimeoutMs(value, fallback) {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

function normalizeReaderRow(item, storageScope, visibility, generatedAt) {
  if (!item || typeof item !== "object") return null;
  const session = item.session && typeof item.session === "object" ? item.session : null;
  const rawDevice = item.device && typeof item.device === "object" ? item.device : null;
  const device = publicReaderDevice(rawDevice);
  const id = safeIdentity(session?.id);
  if (!session || !device || !id) return null;
  const status = READER_STATUSES.has(item.status) ? item.status : "unknown";
  const title = safeTitle(session.name || session.firstMessage || id) ?? id;
  const project = safeProjectLabel(item.projectLabel);
  const projectKey = safeFilterKey(item.projectKey);
  const lastActivityAt = safeTimestamp(item.lastActivityAt || session.modified);
  const lastAskedAt = safeTimestamp(item.lastAskedAt);
  const latestRun = publicReaderRun(item.latestRun);
  const runs = Array.isArray(item.runs) ? item.runs.map(publicReaderRun).filter(Boolean) : [];
  return {
    id,
    storageScope,
    visibility,
    title,
    project,
    projectKey,
    device,
    createdAt: safeTimestamp(session.created),
    lastActivityAt,
    lastActivitySource: "Reader session activity snapshot",
    lastAskedAt,
    lastUserMessage: safeText(item.lastUserMessage),
    observedMessageCount: safeCount(session.messageCount),
    status,
    statusSource: "Reader /api/reader/session-catalog observe-only snapshot",
    runtimeStatus: status,
    runtimeStatusReason: "Status is copied from Reader's verified activity projection; filesystem idle time is not used.",
    latestRun,
    runs,
    unattended: typeof item.unattended === "boolean" ? item.unattended : undefined,
    subagentTerminalState: safeEnum(item.subagentTerminalState, ["completed", "failed", "partial", "stopped", "rejected"]),
    subagentTerminalAt: safeNumber(item.subagentTerminalAt),
    waitingRequestCount: Array.isArray(item.waitingRequestIds) ? item.waitingRequestIds.length : undefined,
  };
}

function publicReaderRun(run) {
  if (!run || typeof run !== "object") return null;
  const runId = safeIdentity(run.runId);
  const sessionId = safeIdentity(run.sessionId);
  const status = READER_STATUSES.has(run.status) || run.status === "completed" ? run.status : "unknown";
  if (!runId || !sessionId) return null;
  return {
    runId,
    sessionId,
    startedAt: safeTimestamp(run.startedAt),
    updatedAt: safeTimestamp(run.updatedAt),
    completedAt: safeTimestamp(run.completedAt),
    status,
    error: safeText(run.error),
  };
}

function publicReaderDevice(device) {
  if (!device || typeof device !== "object") return null;
  const id = safeIdentity(device.id);
  const name = safeDeviceName(device.name || id || "unknown");
  if (!id || !name) return null;
  return {
    id,
    name,
    ...(typeof device.online === "boolean" ? { online: device.online } : {}),
    ...(safeTimestamp(device.lastSeenAt) ? { lastSeenAt: safeTimestamp(device.lastSeenAt) } : {}),
    ...(safeText(device.error) ? { error: truncate(safeText(device.error), 160) } : {}),
  };
}

function mergeReaderDevice(devicesById, incoming) {
  const current = devicesById.get(incoming.id);
  if (!current) {
    devicesById.set(incoming.id, incoming);
    return;
  }
  devicesById.set(incoming.id, {
    ...current,
    ...incoming,
    name: incoming.name || current.name,
    ...(current.online === true || incoming.online === true ? { online: true } : current.online === false || incoming.online === false ? { online: false } : {}),
    ...(incoming.lastSeenAt || current.lastSeenAt ? { lastSeenAt: newerTimestamp(current.lastSeenAt, incoming.lastSeenAt) } : {}),
    ...(incoming.online === false ? { error: incoming.error || current.error || "offline" } : {}),
  });
}

function filterReaderRows(rows, args) {
  const project = args.project === undefined ? undefined : validateProject(args.project).toLocaleLowerCase();
  const device = args.device === undefined ? undefined : validateDeviceFilter(args.device).toLocaleLowerCase();
  const status = args.status === undefined ? undefined : validateReaderStatus(args.status);
  const timeRange = validateTimeRange(args.timeRange || "all");
  const nowMs = Date.now();
  return rows.filter((row) => {
    if (project !== undefined && row.project.toLocaleLowerCase() !== project && row.projectKey.toLocaleLowerCase() !== project) return false;
    if (device !== undefined && row.device.id.toLocaleLowerCase() !== device && row.device.name.toLocaleLowerCase() !== device) return false;
    if (status !== undefined && row.status !== status) return false;
    if (timeRange !== "all") {
      const parsed = Date.parse(row.lastActivityAt ?? "");
      if (!Number.isFinite(parsed)) return false;
      if (parsed < nowMs - Number(timeRange) * 24 * 60 * 60 * 1000) return false;
    }
    return true;
  });
}

function publicReaderRow(row) {
  return {
    id: row.id,
    storageScope: row.storageScope,
    visibility: row.visibility,
    title: row.title,
    project: row.project,
    device: row.device,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    lastActivitySource: row.lastActivitySource,
    lastAskedAt: row.lastAskedAt,
    lastUserMessage: row.lastUserMessage,
    observedMessageCount: row.observedMessageCount,
    status: row.status,
    statusSource: row.statusSource,
    runtimeStatus: row.runtimeStatus,
    runtimeStatusReason: row.runtimeStatusReason,
    latestRun: row.latestRun,
    runs: row.runs,
    unattended: row.unattended,
    subagentTerminalState: row.subagentTerminalState,
    subagentTerminalAt: row.subagentTerminalAt,
    waitingRequestCount: row.waitingRequestCount,
  };
}

function compareReaderRows(a, b) {
  const byTime = (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "");
  if (byTime !== 0) return byTime;
  const byDevice = a.device.id.localeCompare(b.device.id);
  return byDevice !== 0 ? byDevice : a.id.localeCompare(b.id);
}

function compareReaderDevices(a, b) {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

function summarizeReaderRows(rows, devices) {
  const statusCounts = Object.fromEntries([...READER_STATUSES].map((status) => [status, 0]));
  const byDevice = new Map(devices.map((device) => [device.id, {
    device: { ...device },
    count: 0,
    statusCounts: Object.fromEntries([...READER_STATUSES].map((status) => [status, 0])),
  }]));
  let timeRangeUnknownCount = 0;
  for (const row of rows) {
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
    const bucket = byDevice.get(row.device.id) ?? {
      device: { ...row.device },
      count: 0,
      statusCounts: Object.fromEntries([...READER_STATUSES].map((status) => [status, 0])),
    };
    bucket.count += 1;
    bucket.statusCounts[row.status] = (bucket.statusCounts[row.status] ?? 0) + 1;
    byDevice.set(row.device.id, bucket);
    if (!row.lastActivityAt) timeRangeUnknownCount += 1;
  }
  return {
    totalCount: rows.length,
    statusCounts,
    byDevice: [...byDevice.values()].sort((a, b) => compareReaderDevices(a.device, b.device)),
    timeRangeUnknownCount,
  };
}

function paginationFor(offset, limit, total) {
  const nextOffset = offset + limit < total ? offset + limit : null;
  return { offset, limit, total, hasMore: nextOffset !== null, nextOffset };
}

function newerTimestamp(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a.localeCompare(b) >= 0 ? a : b;
}

function validateVisibility(value) {
  if (typeof value !== "string" || !READER_VISIBILITIES.has(value)) {
    throw new ToolInputError("visibility must be one of: visible, hidden, all");
  }
  return value;
}

function validateTimeRange(value) {
  if (typeof value !== "string" || !READER_TIME_RANGES.has(value)) {
    throw new ToolInputError("timeRange must be one of: all, 1, 3, 7, 14, 30, 90");
  }
  return value;
}

function validateDeviceFilter(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 160 || /[\0\r\n]/.test(value)) {
    throw new ToolInputError("device must be a bounded text filter");
  }
  return value;
}

function validateReaderStatus(value) {
  if (typeof value !== "string" || !READER_STATUSES.has(value)) {
    throw new ToolInputError(`status must be one of: ${[...READER_STATUSES].join(", ")}`);
  }
  return value;
}

function safeProjectLabel(value) {
  if (typeof value !== "string" || value.length === 0) return "unknown";
  return truncate(sanitizeText(value), MAX_PROJECT_LENGTH) || "unknown";
}

function safeFilterKey(value) {
  if (typeof value !== "string" || value.length > 1024 || /[\0\r\n]/.test(value)) return "";
  return value;
}

function safeText(value) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return truncate(sanitizeText(value), MAX_DISPLAY_TEXT);
}

function safeCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function safeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeEnum(value, allowed) {
  return typeof value === "string" && allowed.includes(value) ? value : undefined;
}

function readerRuntimeStatusSemantics() {
  return {
    runtimeStatusValues: [...READER_STATUSES],
    runtimeChecked: true,
    statusSource: "Reader /api/reader/session-catalog observe-only snapshot, including live RPC and persisted run records",
    idleDoesNotMeanComplete: true,
    writeSideEffects: false,
    detailRouteUsed: false,
  };
}

const CONTROL_ACTIONS = new Set(["inspect", "get_tools", "set_model", "set_tools", "prompt", "continue", "steer", "follow_up", "abort", "stop", "clear_queue", "create_session", "answer_question"]);

function validateCreateToolNames(value) {
  if (
    !Array.isArray(value)
    || value.length > SAFE_CREATE_TOOL_NAMES.length
    || value.some((name) => typeof name !== "string" || !SAFE_CREATE_TOOL_NAME_SET.has(name))
    || new Set(value).size !== value.length
  ) {
    throw new ToolInputError(`create_session toolNames must be [] or a unique subset of: ${SAFE_CREATE_TOOL_NAMES.join(", ")}`);
  }
  return [...value];
}

async function readerSessionControl(state, args) {
  if (!state.readerUrl) {
    throw new ToolInputError("reader_session_control requires PI_WEB_READER_URL; the local storage fallback has no live Reader host");
  }
  const action = validateControlAction(args.action);
  const deviceId = validateRequiredIdentity(args.deviceId, "deviceId");
  const sessionId = args.sessionId === undefined ? undefined : validateSessionId(args.sessionId);
  const dryRun = args.dryRun === undefined ? true : validateBoolean(args.dryRun, "dryRun");
  const confirm = args.confirm === true;
  if (args.toolNames !== undefined && action !== "create_session" && action !== "set_tools") {
    throw new ToolInputError("toolNames is supported only for create_session or set_tools");
  }
  const requestedStrictToolAllowlist = args.strictToolAllowlist === undefined
    ? undefined
    : validateBoolean(args.strictToolAllowlist, "strictToolAllowlist");
  if (requestedStrictToolAllowlist === true && action !== "create_session") {
    throw new ToolInputError("strictToolAllowlist=true is supported only for create_session");
  }
  const toolNames = action === "create_session" && args.toolNames !== undefined
    ? validateCreateToolNames(args.toolNames)
    : action === "set_tools" ? args.toolNames : undefined;
  if (action === "set_tools" && (!Array.isArray(toolNames) || new Set(toolNames).size !== toolNames.length)) throw new ToolInputError("set_tools requires an explicit unique toolNames array");
  const strictToolAllowlist = action === "create_session"
    ? requestedStrictToolAllowlist === undefined
      ? toolNames !== undefined
      : requestedStrictToolAllowlist
    : false;
  if (strictToolAllowlist && toolNames === undefined) {
    throw new ToolInputError("strictToolAllowlist requires toolNames");
  }
  if (action === "create_session" && toolNames !== undefined && !strictToolAllowlist) {
    throw new ToolInputError("create_session toolNames requires strictToolAllowlist=true");
  }
  if (action !== "create_session" && !sessionId) throw new ToolInputError(`${action} requires an exact sessionId`);
  if (action === "create_session" && (typeof args.cwd !== "string" || !args.cwd.trim())) {
    throw new ToolInputError("create_session requires cwd");
  }
  if (["prompt", "continue", "steer", "follow_up"].includes(action) && (typeof args.message !== "string" || !args.message.trim())) {
    throw new ToolInputError(`${action} requires a non-empty message`);
  }
  if (action === "answer_question" && (typeof args.questionId !== "string" || !args.questionId.trim())) {
    throw new ToolInputError("answer_question requires a non-empty questionId");
  }
  if (action === "answer_question") {
    if (!safeIdentity(args.runtimeGeneration)) throw new ToolInputError("answer_question requires an exact runtimeGeneration from the pending UI request");
    if (!safeIdentity(args.questionId) || args.questionId !== args.questionId.trim()) throw new ToolInputError("answer_question requires an exact questionId without surrounding whitespace");
    const fields = ["answer", "confirmed", "cancelled"].filter((key) => Object.hasOwn(args, key));
    if (fields.length !== 1 || (fields[0] === "cancelled" && args.cancelled !== true)) {
      throw new ToolInputError("answer_question requires exactly one of answer, confirmed, or cancelled:true");
    }
  } else if (["questionId", "runtimeGeneration", "answer", "confirmed", "cancelled"].some((key) => args[key] !== undefined)) {
    throw new ToolInputError("UI response fields are supported only for answer_question");
  }
  let validatedImages;
  if (args.images !== undefined) {
    if (!["prompt", "continue", "steer", "follow_up"].includes(action)) {
      throw new ToolInputError("images is supported only for prompt, continue, steer, or follow_up");
    }
    if (!Array.isArray(args.images) || args.images.length > 5) {
      throw new ToolInputError("images must be an array of at most 5 items");
    }
    const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
    for (const img of args.images) {
      if (!img || typeof img !== "object" || typeof img.data !== "string" || !img.data) {
        throw new ToolInputError("each image must have non-empty data string");
      }
      if (typeof img.mimeType !== "string" || !ALLOWED_MIME.has(img.mimeType)) {
        throw new ToolInputError("each image must have a valid mimeType (image/png, image/jpeg, image/webp, image/gif)");
      }
      if (!isValidBase64ImageData(img.data)) {
        throw new ToolInputError("each image data must be valid Base64");
      }
      if (img.data.length > 8 * 1024 * 1024) {
        throw new ToolInputError("single image data must not exceed 8MB");
      }
    }
    validatedImages = args.images.map((img) => ({
      type: "image",
      data: img.data,
      mimeType: img.mimeType,
    }));
  }
  const idempotencyKey = args.idempotencyKey === undefined ? undefined : validateIdempotencyKey(args.idempotencyKey);
  const expectedRevision = args.expectedRevision === undefined ? undefined : validateOptionalText(args.expectedRevision, "expectedRevision", 256);
  const expectedBootId = args.expectedBootId === undefined ? undefined : validateOptionalText(args.expectedBootId, "expectedBootId", 128);
  const expectedQueueRevision = args.expectedQueueRevision;
  if (expectedQueueRevision !== undefined && !/^[0-9a-f]{64}$/.test(expectedQueueRevision)) throw new ToolInputError("expectedQueueRevision must be a lowercase SHA-256 queue revision");
  if (expectedQueueRevision !== undefined && action !== "clear_queue") throw new ToolInputError("expectedQueueRevision is supported only for clear_queue");
  const setting = action === "set_model" || action === "set_tools";
  if ((setting || action === "get_tools") && (typeof args.cwd !== "string" || !args.cwd.trim())) throw new ToolInputError("Live settings require an exact cwd");
  if (setting && (!expectedRevision || !expectedBootId)) throw new ToolInputError("Live settings require caller-observed expectedRevision and expectedBootId");
  if (action === "set_model" && (typeof args.provider !== "string" || typeof args.modelId !== "string")) throw new ToolInputError("set_model requires provider and modelId");
  const confirmationReason = args.confirmationReason === undefined ? undefined : validateOptionalText(args.confirmationReason, "confirmationReason", 500);
  if (!dryRun && action !== "inspect" && action !== "get_tools" && confirmationReason === undefined) {
    throw new ToolInputError("confirmationReason is required and must be non-empty when dryRun=false");
  }
  const requestFingerprint = controlRequestFingerprint({
    action,
    deviceId,
    ...(setting ? { provider: args.provider ?? null, modelId: args.modelId ?? null, thinkingLevel: args.thinkingLevel ?? null } : {}),
    sessionId: sessionId ?? null,
    message: typeof args.message === "string" ? args.message : null,
    ...(validatedImages ? { images: validatedImages } : {}),
    ...(action === "answer_question" ? {
      questionId: args.questionId,
      runtimeGeneration: args.runtimeGeneration,
      answer: args.answer ?? null,
      confirmed: args.confirmed ?? null,
      cancelled: args.cancelled ?? null,
    } : {}),
    cwd: typeof args.cwd === "string" ? args.cwd.trim() : null,
    toolNames: toolNames ?? null,
    strictToolAllowlist,
    expectedRevision: expectedRevision ?? null,
    expectedBootId: expectedBootId ?? null,
    ...(expectedQueueRevision === undefined ? {} : { expectedQueueRevision }),
    confirmationReason: confirmationReason ?? null,
  });

  const target = await locateControlDevice(state, deviceId, sessionId);
  if (!target.ok) return target.value;
  const route = controlRoute(state.readerUrl, target.localDeviceId === deviceId, deviceId, sessionId);

  if (action === "get_tools") {
    const url = new URL(route.url);
    url.pathname += "/tools";
    url.searchParams.set("deviceId", deviceId);
    url.searchParams.set("cwd", args.cwd.trim());
    let body;
    try { body = await fetchLiveProjection(url, MAX_REMOTE_BODY_BYTES, REMOTE_TIMEOUT_MS); }
    catch (error) { return managedReadFailure({ source: "reader-runtime-settings", action, target: { deviceId, sessionId } }, error); }
    if (body?.schemaVersion !== 1 || body.deviceId !== deviceId || body.sessionId !== sessionId || body.cwd !== undefined || body.cwdRef !== cwdReference(args.cwd.trim()) || !Array.isArray(body.tools) || typeof body.revision !== "string" || typeof body.bootId !== "string") return { outcome: "unknown", code: "reader_contract_mismatch", sideEffect: "none" };
    return { source: "reader-runtime-settings", action, target: { deviceId, sessionId, cwd: args.cwd.trim() }, outcome: "observed", bootId: body.bootId, revision: body.revision, model: sanitizePublicValue(body.model), thinkingLevel: body.thinkingLevel, strictToolAllowlist: body.strictToolAllowlist === true, selectionSemantics: sanitizeText(body.selectionSemantics), tools: body.tools.slice(0, 500).map(tool => ({ name: sanitizeText(tool.name), active: tool.active === true })), truncated: body.toolsTruncated === true || body.tools.length > 500, readOnlyTransport: true, runtimeStartAttempted: false, sideEffect: "reader-get-only", coverage: target.coverage };
  }

  if (action === "inspect") {
    const runtime = target.transientRuntime
      ? { ok: true, body: target.transientRuntime }
      : await fetchControlState(route);
    if (!runtime.ok) return controlUnavailable(action, deviceId, sessionId, runtime);
    return {
      source: "reader-runtime-api",
      action,
      target: { device: target.device, sessionId },
      outcome: "observed",
      capturedAt: new Date().toISOString(),
      running: runtime.body.running === true,
      state: projectInspectState(runtime.body.state ?? null),
      coverage: target.coverage,
      runtimeStatusSemantics: readerRuntimeStatusSemantics(),
    };
  }

  if (!dryRun && !confirm) {
    return {
      source: "reader-runtime-api",
      action,
      target: { device: target.device, sessionId },
      outcome: "blocked",
      reason: "confirm=true is required for a real control request",
      dryRun: true,
      sideEffect: "none",
      requestFingerprint,
      wouldCall: route.description,
      coverage: target.coverage,
      hint: "To execute this request, call reader_session_control with confirm: true, confirmationReason: '<non-empty reason>', and idempotencyKey: '<unique-id>'.",
    };
  }

  if (dryRun) {
    return {
      source: "reader-runtime-api",
      action,
      target: { device: target.device, ...(sessionId ? { sessionId } : {}) },
      outcome: "dry_run",
      dryRun: true,
      sideEffect: "none",
      requestFingerprint,
      wouldCall: route.description,
      payloadSummary: action === "create_session"
        ? { type: "ensure_session", cwdProvided: true, toolsDisabled: toolNames !== undefined, strictToolAllowlist }
        : action === "answer_question"
        ? { type: action, questionId: args.questionId, runtimeGeneration: args.runtimeGeneration, pendingRequestValidation: "Reader validates the current resolver when the real command is submitted" }
        : { type: action === "continue" ? "prompt" : action === "stop" ? "abort" : action, messageProvided: typeof args.message === "string" && args.message.trim().length > 0 },
      coverage: target.coverage,
      hint: "Dry-run validation succeeded. To actually execute this command, call reader_session_control with dryRun: false, confirm: true, confirmationReason: '<non-empty reason>', and idempotencyKey: '<unique-id>'.",
    };
  }

  if (!idempotencyKey) throw new ToolInputError("idempotencyKey is required when dryRun=false");
  const receiptRoute = action === "stop"
    ? readerControlReceiptRoute(state.readerUrl, target.localDeviceId === deviceId, deviceId, sessionId, idempotencyKey, "abort")
    : null;
  const receiptKey = `${deviceId}\u0000${sessionId ?? "new"}\u0000${idempotencyKey}`;
  const existingReceipt = state.controlReceipts.get(receiptKey);
  if (existingReceipt) {
    if (existingReceipt.requestFingerprint !== requestFingerprint) {
      return {
        source: "reader-runtime-api",
        action,
        target: { device: target.device, ...(sessionId ? { sessionId } : {}) },
        outcome: "conflict",
        code: "idempotency_conflict",
        reason: "The idempotency key was already used with a different request fingerprint; no POST was sent.",
        idempotencyKey,
        requestFingerprint,
        existingReceiptId: existingReceipt.receiptId,
        sideEffect: "none",
        coverage: target.coverage,
      };
    }
    if (action === "stop") {
      const replayedReceipt = await observeStopReceiptResult(existingReceipt, route, receiptRoute, true);
      state.controlReceipts.set(receiptKey, replayedReceipt);
      return replayedReceipt;
    }
    return { ...existingReceipt, replayed: true };
  }

  if (action !== "create_session") {
    const runtime = await fetchControlState(route);
    if (!runtime.ok) return controlUnavailable(action, deviceId, sessionId, runtime);
    if (runtime.body.running !== true) {
      return {
        source: "reader-runtime-api",
        action,
        target: { device: target.device, sessionId },
        outcome: "blocked",
        reason: "target is not alive in the selected Reader process; no POST was sent and a persisted session was not auto-started",
        sideEffect: "none",
        requestFingerprint,
        runtime: sanitizePublicValue(runtime.body),
        coverage: target.coverage,
      };
    }
  }

  const payload = action === "create_session"
    ? { cwd: args.cwd.trim(), type: "ensure_session", ...(toolNames !== undefined ? { toolNames, strictToolAllowlist: true } : {}), ...controlContractFields({ idempotencyKey, requestFingerprint, expectedRevision, expectedBootId, expectedQueueRevision, confirmationReason, confirm }) }
    : action === "answer_question"
    ? { type: "answer_question", questionId: args.questionId, runtimeGeneration: args.runtimeGeneration, ...(typeof args.answer === "string" ? { answer: args.answer } : {}), ...(typeof args.confirmed === "boolean" ? { confirmed: args.confirmed } : {}), ...(typeof args.cancelled === "boolean" ? { cancelled: args.cancelled } : {}), ...controlContractFields({ idempotencyKey, requestFingerprint, expectedRevision, expectedBootId, expectedQueueRevision, confirmationReason, confirm }) }
    : { type: action === "continue" ? "prompt" : action === "stop" ? "abort" : action,
        ...(setting ? { deviceId, cwd: args.cwd.trim(), ...(action === "set_tools" ? { toolNames } : { provider: args.provider, modelId: args.modelId, ...(args.thinkingLevel === undefined ? {} : { thinkingLevel: args.thinkingLevel }) }) } : ["abort", "stop", "clear_queue"].includes(action) ? {} : { message: args.message.trim(), ...(validatedImages ? { images: validatedImages } : {}) }),
        ...controlContractFields({ idempotencyKey, requestFingerprint, expectedRevision, expectedBootId, expectedQueueRevision, confirmationReason, confirm }) };
  const receiptId = randomUUID();
  const baseReceipt = {
    source: "reader-runtime-api",
    receiptId,
    idempotencyKey,
    requestFingerprint,
    action,
    target: { device: target.device, ...(sessionId ? { sessionId } : {}) },
    submittedAt: new Date().toISOString(),
    retryPolicy: "never-auto-retry-unknown",
    sideEffect: "reader-command-submitted",
    coverage: target.coverage,
  };
  let result;
  try {
    result = await postControlCommand(route, payload);
  } catch (error) {
    const receipt = {
      ...baseReceipt,
      outcome: "unknown",
      transportAccepted: false,
      targetStopped: false,
      sideEffect: "unknown",
      error: publicRemoteError(error),
      note: "The transport outcome is unknown; do not resend with the same or a new key without an explicit decision.",
    };
    state.controlReceipts.set(receiptKey, receipt);
    return receipt;
  }
  const exactAnswer = action === "answer_question" ? exactUiAnswerResult(result.body) : undefined;
  const receipt = {
    ...baseReceipt,
    outcome: exactAnswer?.code === "ui_answer_result_unavailable" || result.body?.outcome === "unknown" || result.body?.receipt?.outcome === "unknown" ? "unknown" : result.accepted ? "accepted" : "rejected",
    transportAccepted: result.accepted,
    targetStopped: false,
    completion: "unobserved",
    httpStatus: result.status,
    ...(result.body?.outcome !== undefined ? { readerOutcome: safeEnum(result.body.outcome, ["accepted", "replayed", "queued", "running", "completed", "failed", "aborted", "unknown", "conflict"]) } : {}),
    ...(typeof result.body?.code === "string" ? { code: sanitizeText(result.body.code) } : {}),
    ...(result.body?.replayed === true ? { readerReplayed: true } : {}),
    ...(isRecord(result.body?.receipt) ? { readerReceipt: sanitizePublicValue(result.body.receipt) } : {}),
    ...(action === "answer_question" ? { readerResponse: exactAnswer }
      : result.accepted ? { data: sanitizePublicValue(result.body.data ?? null) } : {}),
    ...(!result.accepted ? { error: sanitizeText(result.body.error ?? `Reader HTTP ${result.status}`) } : {}),
    ...(action === "create_session" && result.accepted && typeof result.body.sessionId === "string" && safeIdentity(result.body.sessionId)
      ? { createdSessionId: safeIdentity(result.body.sessionId) }
      : {}),
    ...(action === "create_session" && result.accepted && typeof result.body.sessionBootId === "string" && safeIdentity(result.body.sessionBootId)
      ? { createdSessionBootId: safeIdentity(result.body.sessionBootId) }
      : {}),
    note: result.accepted
      ? "Reader accepted the host/runtime command; this receipt is not task completion and abort acceptance does not prove targetStopped=true."
      : "Reader rejected the host/runtime command; no completion is inferred.",
  };
  if (!result.accepted && result.body?.code === "idempotency_conflict") {
    return {
      ...baseReceipt,
      outcome: "conflict",
      code: "idempotency_conflict",
      transportAccepted: false,
      targetStopped: false,
      httpStatus: result.status,
      reason: sanitizeText(result.body.error ?? "Reader rejected the idempotency key because its request fingerprint differs."),
      ...(action === "answer_question" ? { readerResponse: exactAnswer } : {}),
      ...(isRecord(result.body.receipt) && safeIdentity(result.body.receipt.receiptId) ? { existingReceiptId: safeIdentity(result.body.receipt.receiptId), readerReceipt: sanitizePublicValue(result.body.receipt) } : {}),
      sideEffect: "none",
      note: "Reader rejected the request as an idempotency conflict; no new command was accepted.",
      coverage: target.coverage,
    };
  }
  const finalReceipt = action === "stop" && result.accepted
    ? await observeStopReceiptResult(receipt, route, receiptRoute, false)
    : receipt;
  state.controlReceipts.set(receiptKey, finalReceipt);
  if (action === "create_session" && result.accepted && receipt.createdSessionId) {
    state.createdSessionBindings.set(
      controlBindingKey(deviceId, receipt.createdSessionId),
      {
        deviceId,
        sessionId: receipt.createdSessionId,
        cwd: args.cwd.trim(),
        localDeviceId: target.localDeviceId,
        toolNames: toolNames === undefined ? undefined : [...toolNames],
        strictToolAllowlist,
      },
    );
  }
  return finalReceipt;
}

async function readerReadControlPlane(state, args) {
  if (args.managed === true || !Object.hasOwn(CONTROL_PLANE_AREAS, args.area)) return readerManagedControlPlaneRead(state, args);
  const area = validateControlPlaneArea(args.area);
  const definition = CONTROL_PLANE_AREAS[area];
  const deviceId = validateRequiredIdentity(args.deviceId, "deviceId");
  const cwd = args.cwd === undefined ? undefined : validateControlPlaneCwd(args.cwd);
  const scope = args.scope === undefined ? undefined : validateControlPlaneScope(args.scope);
  const q = args.q === undefined ? undefined : validateControlPlaneQuery(args.q, "q");
  const provider = args.provider === undefined ? undefined : validateControlPlaneQuery(args.provider, "provider");
  const limit = args.limit === undefined ? undefined : validateInteger(args.limit, 1, CONTROL_PLANE_MAX_LIMIT, "limit");

  if (definition.cwd === "required" && cwd === undefined) {
    throw new ToolInputError(`${area} requires an explicit cwd; implicit Reader process cwd is not allowed`);
  }
  if (definition.cwd === "none" && cwd !== undefined) {
    throw new ToolInputError(`${area} does not accept cwd because its Reader route is not project-scoped`);
  }
  if (definition.scope !== true && scope !== undefined) {
    throw new ToolInputError(`${area} does not accept scope`);
  }
  if (area !== "models_catalog" && (q !== undefined || provider !== undefined || limit !== undefined)) {
    throw new ToolInputError(`${area} does not accept models catalog query parameters`);
  }

  const binding = {
    deviceId,
    cwd: cwd ?? null,
    sessionId: null,
    runtime: "Reader HTTP GET control-plane route",
    route: definition.route,
    method: "GET",
    ...(scope === undefined ? {} : { scope }),
  };
  const baseResult = {
    source: "reader-control-plane",
    area,
    target: { deviceId },
    binding,
    readOnlyTransport: true,
    sideEffectSemantics: definition.sideEffectSemantics,
  };

  if (!state.readerUrl) {
    return {
      ...baseResult,
      outcome: "unsupported",
      code: "live_reader_required",
      reason: "Reader control-plane routes require PI_WEB_READER_URL; the storage fallback does not guess configuration or runtime state",
      sideEffect: "none",
    };
  }

  const target = await locateControlDevice(state, deviceId);
  if (!target.ok) {
    return {
      ...baseResult,
      outcome: target.value.outcome ?? "unknown",
      code: "device_unresolved",
      reason: target.value.reason,
      target: { ...baseResult.target, ...(target.value.target ?? {}) },
      coverage: target.value.coverage,
      sideEffect: "none",
    };
  }

  const resolvedTarget = { device: target.device, deviceId, sessionId: null };
  const resolvedBinding = { ...binding, deviceName: target.device.name };
  if (target.localDeviceId !== deviceId) {
    return {
      ...baseResult,
      target: resolvedTarget,
      binding: resolvedBinding,
      outcome: "unsupported",
      code: "remote_control_plane_route_unavailable",
      reason: "Reader has no registered remote control-plane route for this area; no request was sent",
      coverage: target.coverage,
      sideEffect: "none",
    };
  }

  const route = new URL(definition.route, `${state.readerUrl}/`);
  if (cwd !== undefined) route.searchParams.set("cwd", cwd);
  if (scope !== undefined) route.searchParams.set("scope", scope);
  if (area === "models_catalog") {
    if (q !== undefined) route.searchParams.set("q", q);
    if (provider !== undefined) route.searchParams.set("provider", provider);
    if (limit !== undefined) route.searchParams.set("limit", String(limit));
  }
  const query = Object.fromEntries(route.searchParams.entries());
  const request = { method: "GET", route: definition.route, query };

  let body;
  try {
    body = await fetchLiveProjection(route, MAX_REMOTE_BODY_BYTES, REMOTE_TIMEOUT_MS);
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : undefined;
    const errorCode = status === 404
      ? "reader_route_unavailable"
      : status === 403
        ? "reader_access_denied"
        : status !== undefined && status >= 400 && status < 500
          ? "reader_request_rejected"
          : "reader_read_failed";
    const outcome = status === 404 ? "unsupported" : status !== undefined && status >= 400 && status < 500 ? "blocked" : "unknown";
    return {
      ...baseResult,
      target: resolvedTarget,
      binding: resolvedBinding,
      request,
      outcome,
      code: errorCode,
      error: publicRemoteError(error),
      reason: outcome === "unsupported"
        ? "The registered Reader route is unavailable; no alternate or write route was attempted"
        : "Reader did not return a usable read-only control-plane response",
      coverage: target.coverage,
      sideEffect: "reader-get-only",
    };
  }

  return {
    ...baseResult,
    target: resolvedTarget,
    binding: resolvedBinding,
    request,
    outcome: "observed",
    data: sanitizePublicValue(body),
    coverage: target.coverage,
    sideEffect: "reader-get-only",
  };
}

function managedControlPlaneBinding(args) {
  const area = ({ models: "models_default", skills: "skills_policy" })[args.area] ?? args.area;
  validateWriteControlPlaneArea(area);
  const definition = WRITE_CONTROL_PLANE_DEFINITIONS[area];
  const deviceId = validateRequiredIdentity(args.deviceId, "deviceId");
  const scope = validateControlPlaneScope(args.scope);
  const cwd = args.cwd === undefined ? undefined : validateControlPlaneCwd(args.cwd);
  if (!definition.scopes.includes(scope)) throw new ToolInputError(`${area} scope must be one of: ${definition.scopes.join(", ")}`);
  if ((definition.cwd === "required" || scope === "project") && cwd === undefined) throw new ToolInputError(`${area} requires an explicit cwd`);
  return { area, deviceId, scope, cwd: cwd ?? null, sessionId: null, route: MANAGED_CONTROL_PLANE_ROUTE };
}

function managedControlPlaneUrl(state, binding) {
  const url = new URL(MANAGED_CONTROL_PLANE_ROUTE, `${state.readerUrl}/`);
  for (const key of ["area", "deviceId", "scope", "cwd"]) {
    if (binding[key] !== null) url.searchParams.set(key, binding[key]);
  }
  return url;
}

async function resolveManagedControlPlane(state, binding) {
  const base = { source: "reader-control-plane", area: binding.area, target: { deviceId: binding.deviceId }, binding, sideEffect: "none" };
  if (!state.readerUrl) return { ok: false, value: { ...base, outcome: "unsupported", code: "live_reader_required" } };
  const target = await locateControlDevice(state, binding.deviceId);
  if (!target.ok) return { ok: false, value: { ...base, ...target.value, code: "device_unresolved" } };
  if (target.localDeviceId !== binding.deviceId) return {
    ok: false,
    value: { ...base, outcome: "unsupported", code: "remote_control_plane_route_unavailable", reason: "Reader has no registered remote managed control-plane route; no configuration request was sent", coverage: target.coverage },
  };
  return { ok: true, url: managedControlPlaneUrl(state, binding), base: { ...base, target: { device: target.device, deviceId: binding.deviceId }, coverage: target.coverage } };
}

function managedReadFailure(base, error) {
  const status = Number.isInteger(error?.status) ? error.status : undefined;
  return {
    ...base,
    outcome: status === 404 && error?.code === "receipt_not_found" ? "unknown" : status === 404 ? "unsupported" : status !== undefined && status >= 400 && status < 500 ? "blocked" : "unknown",
    ...(error?.code === "receipt_not_found" ? { nextAction: "verify_original_target_and_key_before_retry" } : {}),
    code: typeof error?.code === "string" && error.code ? sanitizeText(error.code) : status === 404 ? "reader_route_unavailable" : "reader_read_failed",
    error: publicRemoteError(error), readOnlyTransport: true, sideEffect: "reader-get-only",
  };
}

function validManagedBinding(body, binding) {
  return body?.schemaVersion === 1 && body.deviceId === binding.deviceId && body.area === binding.area
    && body.scope === binding.scope && body.cwd === undefined && body.cwdRef === (binding.cwd === null ? null : cwdReference(binding.cwd));
}

function cwdReference(cwd) {
  return createHash("sha256").update(JSON.stringify(cwd)).digest("hex");
}

async function readerManagedControlPlaneRead(state, args) {
  if (args.q !== undefined || args.provider !== undefined || args.limit !== undefined) throw new ToolInputError("Managed snapshots do not accept catalog filters");
  const binding = managedControlPlaneBinding(args);
  const resolved = await resolveManagedControlPlane(state, binding);
  if (!resolved.ok) return resolved.value;
  let body;
  try { body = await fetchLiveProjection(resolved.url, MAX_REMOTE_BODY_BYTES, REMOTE_TIMEOUT_MS); }
  catch (error) { return managedReadFailure(resolved.base, error); }
  if (!validManagedBinding(body, binding) || typeof body.revision !== "string" || !body.revision || typeof body.bootId !== "string" || !body.bootId || !Array.isArray(body.supportedOperations)) {
    return { ...resolved.base, outcome: "blocked", code: "reader_contract_mismatch", reason: "Reader snapshot does not match the exact scope/device/cwd/area or revision/boot contract", sideEffect: "reader-get-only" };
  }
  return {
    ...resolved.base, outcome: "observed", managed: true, revision: body.revision, bootId: body.bootId,
    supportedOperations: sanitizePublicValue(body.supportedOperations), impact: sanitizePublicValue(body.impact),
    authorization: sanitizePublicValue(body.authorization), data: sanitizePublicValue(body.value),
    request: { method: "GET", route: MANAGED_CONTROL_PLANE_ROUTE }, readOnlyTransport: true, sideEffect: "reader-get-only",
  };
}

async function readerGetControlPlaneReceipt(state, args) {
  const binding = managedControlPlaneBinding(args);
  if (args.receiptId !== undefined && (args.idempotencyKey !== undefined || args.operation !== undefined)) throw new ToolInputError("Use receiptId or operation plus idempotencyKey, not both");
  if (args.receiptId === undefined && (args.idempotencyKey === undefined || args.operation === undefined)) throw new ToolInputError("receiptId or operation plus idempotencyKey is required");
  if (args.receiptId !== undefined) validateOptionalText(args.receiptId, "receiptId", 256);
  if (args.idempotencyKey !== undefined) validateIdempotencyKey(args.idempotencyKey);
  if (args.operation !== undefined) validateWriteControlPlaneOperation(binding.area, args.operation);
  const resolved = await resolveManagedControlPlane(state, binding);
  if (!resolved.ok) return resolved.value;
  for (const key of ["receiptId", "idempotencyKey", "operation"]) if (args[key] !== undefined) resolved.url.searchParams.set(key, args[key]);
  let body;
  try { body = await fetchLiveProjection(resolved.url, MAX_REMOTE_BODY_BYTES, REMOTE_TIMEOUT_MS); }
  catch (error) { return managedReadFailure(resolved.base, error); }
  if (validManagedBinding(body, binding) && body.receipt === null && ["unknown", "not_found"].includes(body.outcome)) return {
    ...resolved.base, outcome: "unknown", code: "receipt_not_found", bootId: body.bootId, nextAction: "verify_original_target_and_key_before_retry",
    readOnlyTransport: true, sideEffect: "reader-get-only", request: { method: "GET", route: MANAGED_CONTROL_PLANE_ROUTE },
  };
  if (!validManagedBinding(body, binding) || !isRecord(body.receipt)) return {
    ...resolved.base, outcome: "unknown", code: "reader_receipt_mismatch", reason: "Reader did not return a scope-bound durable receipt", sideEffect: "reader-get-only",
  };
  return {
    ...resolved.base, outcome: body.receipt.outcome ?? body.outcome ?? "unknown", bootId: body.bootId,
    readerReceipt: sanitizePublicValue(body.receipt), readOnlyTransport: true, sideEffect: "reader-get-only",
    request: { method: "GET", route: MANAGED_CONTROL_PLANE_ROUTE },
  };
}

async function readerGetSessionControlReceipt(state, args) {
  if (!state.readerUrl) throw new ToolInputError("reader_get_session_control_receipt requires PI_WEB_READER_URL; the local storage fallback has no live Reader host");
  const deviceId = validateRequiredIdentity(args.deviceId, "deviceId");
  const sessionId = args.sessionId === undefined ? "new" : validateSessionId(args.sessionId);
  const receiptId = args.receiptId === undefined ? undefined : validateOptionalText(args.receiptId, "receiptId", 200);
  const idempotencyKey = args.idempotencyKey === undefined ? undefined : validateIdempotencyKey(args.idempotencyKey);
  const operation = args.operation === undefined ? undefined : validateOptionalText(args.operation, "operation", 100);
  if (operation !== undefined && !/^[a-z_]{1,100}$/.test(operation)) throw new ToolInputError("operation must contain lowercase letters and underscores");
  if (receiptId ? idempotencyKey !== undefined || operation !== undefined : idempotencyKey === undefined || operation === undefined) {
    throw new ToolInputError("Supply receiptId or operation plus idempotencyKey");
  }
  if (sessionId === "new" && operation !== undefined && operation !== "create_session") {
    throw new ToolInputError("sessionId=new receipts support create_session only");
  }

  const target = await locateControlDevice(state, deviceId);
  if (!target.ok) return {
    source: "reader-control-receipt", outcome: target.value.outcome, code: "device_unavailable",
    reason: target.value.reason, target: { deviceId, sessionId }, coverage: target.value.coverage,
    readOnlyTransport: true, sideEffect: "none", runtimeStartAttempted: false, writeSideEffects: false,
  };
  if (target.localDeviceId !== deviceId) return {
    source: "reader-control-receipt", outcome: "blocked", code: "remote_receipt_unsupported",
    reason: "Session-control receipts are available only from the local Reader device; no request was sent",
    target: { deviceId, sessionId }, readOnlyTransport: true, sideEffect: "none",
    runtimeStartAttempted: false, writeSideEffects: false,
  };

  const route = new URL(`/api/agent/${encodeURIComponent(sessionId)}/receipt`, `${state.readerUrl}/`);
  if (receiptId !== undefined) route.searchParams.set("receiptId", receiptId);
  if (idempotencyKey !== undefined) route.searchParams.set("idempotencyKey", idempotencyKey);
  if (operation !== undefined) route.searchParams.set("operation", operation);
  const request = { method: "GET", route: route.pathname, lookup: receiptId !== undefined ? "receiptId" : "operation+idempotencyKey" };
  try {
    const body = await fetchLiveProjection(route, MAX_REMOTE_BODY_BYTES, REMOTE_TIMEOUT_MS);
    if (body.source !== "reader-control-receipt" || !isRecord(body.target)
      || body.target.deviceId !== deviceId || body.target.sessionId !== sessionId || !isRecord(body.receipt)) {
      return { source: "reader-control-receipt", outcome: "unknown", code: "reader_receipt_mismatch",
        reason: "Reader did not return a receipt bound to the requested device and session",
        target: { deviceId, sessionId }, request, readOnlyTransport: true, sideEffect: "reader-get-only",
        runtimeStartAttempted: false, writeSideEffects: false };
    }
    const receipt = body.receipt;
    if ((receiptId !== undefined && receipt.receiptId !== receiptId)
      || (operation !== undefined && receipt.operation !== operation)) {
      return { source: "reader-control-receipt", outcome: "unknown", code: "reader_receipt_mismatch",
        reason: "Reader returned a receipt that does not match the requested receipt identity",
        target: { deviceId, sessionId }, request, readOnlyTransport: true, sideEffect: "reader-get-only",
        runtimeStartAttempted: false, writeSideEffects: false };
    }
    return { source: "reader-control-receipt", outcome: body.outcome ?? receipt.outcome ?? "unknown",
      target: { deviceId, sessionId }, receipt: sanitizePublicValue(receipt), request,
      readOnlyTransport: true, sideEffect: "reader-get-only", runtimeStartAttempted: false, writeSideEffects: false };
  } catch (error) {
    const status = error?.status;
    const code = typeof error?.code === "string" ? error.code : "";
    const notFound = status === 404 && code === "receipt_not_found";
    return { source: "reader-control-receipt", outcome: notFound ? "not_found" : "unknown",
      code: code || (notFound ? "receipt_not_found" : "receipt_read_failed"),
      reason: notFound ? "No matching receipt exists on the selected Reader device" : "Reader receipt lookup failed; no control action was sent",
      target: { deviceId, sessionId }, request, readOnlyTransport: true,
      sideEffect: "reader-get-only", runtimeStartAttempted: false, writeSideEffects: false };
  }
}

async function readerWriteControlPlane(state, args) {
  const binding = managedControlPlaneBinding(args);
  const { area, deviceId, scope, cwd } = binding;
  const operation = validateWriteControlPlaneOperation(area, args.operation);
  validateWriteControlPlaneOperationFields(area, operation, args);
  const dryRun = args.dryRun !== false;
  const confirm = args.confirm === true;
  const idempotencyKey = args.idempotencyKey === undefined ? undefined : validateIdempotencyKey(args.idempotencyKey);
  const expectedRevision = args.expectedRevision === undefined ? undefined : validateOptionalText(args.expectedRevision, "expectedRevision", 256);
  const expectedBootId = args.expectedBootId === undefined ? undefined : validateOptionalText(args.expectedBootId, "expectedBootId", 128);
  const confirmationReason = args.confirmationReason === undefined ? undefined : validateOptionalText(args.confirmationReason, "confirmationReason", 500);
  if (!dryRun && !confirm) throw new ToolInputError("confirm=true is required for a real control-plane write");
  if (!dryRun && (!confirmationReason || !confirmationReason.trim())) throw new ToolInputError("confirmationReason is required and must be non-empty when dryRun=false");
  if (!dryRun && idempotencyKey === undefined) throw new ToolInputError("idempotencyKey is required when dryRun=false");
  if (!dryRun && expectedRevision === undefined) throw new ToolInputError("expectedRevision is required when dryRun=false");
  if (!dryRun && expectedBootId === undefined) throw new ToolInputError("expectedBootId is required when dryRun=false");
  const changes = Object.fromEntries(CONTROL_PLANE_CHANGE_FIELDS.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
  const requestFingerprint = controlRequestFingerprint({ area, operation, deviceId, cwd, scope, changes, expectedRevision: expectedRevision ?? null, expectedBootId: expectedBootId ?? null, confirmationReason: confirmationReason ?? null });
  const base = { action: "reader_write_control_plane", operation, dryRun, requestFingerprint, retryPolicy: "never-auto-retry-unknown" };
  if (dryRun) {
    const snapshot = await readerManagedControlPlaneRead(state, { area, deviceId, scope, ...(cwd === null ? {} : { cwd }) });
    if (snapshot.outcome !== "observed") return { ...snapshot, ...base };
    if (!snapshot.supportedOperations.includes(operation)) return { ...snapshot, ...base, outcome: "unsupported", code: "unsupported_operation" };
    let validation;
    try {
      validation = await postControlCommand({ url: new URL(MANAGED_CONTROL_PLANE_ROUTE, `${state.readerUrl}/`), auditCaller: true }, {
        area, operation, changes, scope, deviceId, ...(cwd === null ? {} : { cwd }),
        expectedRevision: expectedRevision ?? snapshot.revision, expectedBootId: expectedBootId ?? snapshot.bootId,
        dryRun: true, confirm: false, requestFingerprint,
        ...(confirmationReason === undefined ? {} : { confirmationReason }),
      });
    } catch (error) {
      return { ...snapshot, ...base, outcome: "unknown", code: "reader_dry_run_unknown", error: publicRemoteError(error), sideEffect: "unknown", readOnlyTransport: false };
    }
    const body = validation.body;
    if (validation.status >= 400) return {
      ...snapshot, ...base, outcome: validation.status === 404 ? "unsupported" : validation.status < 500 ? "blocked" : "unknown",
      code: typeof body?.code === "string" ? sanitizeText(body.code) : "reader_dry_run_rejected",
      request: { method: "POST", route: MANAGED_CONTROL_PLANE_ROUTE }, readOnlyTransport: false, sideEffect: "none",
    };
    if (body?.success !== true || body.accepted !== false || body.outcome !== "dry_run" || body.sideEffect !== "none" || body.receipt !== undefined || !validManagedBinding(body.snapshot, binding) || typeof body.snapshot.revision !== "string" || !body.snapshot.revision || typeof body.snapshot.bootId !== "string" || !body.snapshot.bootId) return {
      ...snapshot, ...base, outcome: "unknown", code: "reader_dry_run_contract_mismatch", sideEffect: "unknown", readOnlyTransport: false,
    };
    return {
      ...snapshot, ...base, outcome: "dry_run", validated: true, sideEffect: "none", readOnlyTransport: false,
      revision: body.snapshot.revision, bootId: body.snapshot.bootId, data: sanitizePublicValue(body.snapshot.value),
      request: { method: "POST", route: MANAGED_CONTROL_PLANE_ROUTE },
      note: "Reader validated this operation without writing configuration or creating a receipt. A confirmed write requires caller-supplied CAS and boot values.",
    };
  }
  const resolved = await resolveManagedControlPlane(state, binding);
  if (!resolved.ok) return { ...resolved.value, ...base };
  const payload = { area, operation, changes, scope, deviceId, ...(cwd === null ? {} : { cwd }), expectedRevision, expectedBootId, dryRun: false, confirm, confirmationReason, idempotencyKey, requestFingerprint };
  let result;
  try { result = await postControlCommand({ url: new URL(MANAGED_CONTROL_PLANE_ROUTE, `${state.readerUrl}/`), auditCaller: true }, payload); }
  catch (error) {
    return { ...resolved.base, ...base, outcome: "unknown", code: "reader_write_unknown", error: publicRemoteError(error), sideEffect: "unknown", receiptLookup: { tool: "reader_get_control_plane_receipt", arguments: { area, deviceId, scope, ...(cwd === null ? {} : { cwd }), operation, idempotencyKey } } };
  }
  const body = result.body;
  const receipt = isRecord(body?.receipt) ? body.receipt : undefined;
  const rejected = result.status >= 400 && result.status < 500;
  const outcome = result.status === 404 ? "unsupported"
    : rejected ? (typeof body?.outcome === "string" ? body.outcome : "blocked")
      : typeof receipt?.outcome === "string" ? receipt.outcome : "unknown";
  return {
    ...resolved.base, ...base, outcome, accepted: body?.accepted === true,
    ...(typeof body?.code === "string" ? { code: sanitizeText(body.code) } : result.status === 404 ? { code: "reader_route_unavailable" } : {}),
    ...(receipt ? { readerReceipt: sanitizePublicValue(receipt) } : {}),
    ...(body?.replayed === true ? { replayed: true } : {}),
    ...(body?.snapshot ? { snapshot: sanitizePublicValue(body.snapshot) } : {}),
    request: { method: "POST", route: MANAGED_CONTROL_PLANE_ROUTE },
    sideEffect: rejected ? "none" : receipt ? "reader-managed-write" : "unknown",
    readOnlyTransport: false,
    receiptLookup: { tool: "reader_get_control_plane_receipt", arguments: { area, deviceId, scope, ...(cwd === null ? {} : { cwd }), operation, idempotencyKey } },
  };
}

function validateWriteControlPlaneArea(value) {
  if (typeof value !== "string" || !Object.prototype.hasOwnProperty.call(WRITE_CONTROL_PLANE_DEFINITIONS, value)) {
    throw new ToolInputError(`area must be one of: ${WRITE_CONTROL_PLANE_AREA_NAMES.join(", ")}`);
  }
  return value;
}

function validateWriteControlPlaneOperation(area, value) {
  const operations = WRITE_CONTROL_PLANE_DEFINITIONS[area].operations;
  if (typeof value !== "string" || !operations.includes(value)) {
    throw new ToolInputError(`${area} operation must be one of: ${operations.join(", ")}`);
  }
  return value;
}

function validateWriteControlPlaneOperationFields(area, operation, args) {
  const text = (value, name, max = CONTROL_PLANE_MAX_QUERY_TEXT) => {
    if (value === undefined) return undefined;
    return validateOptionalText(value, name, max);
  };
  if (area === "models_default" && operation === "set_default"
    && args.provider === undefined && args.modelId === undefined && args.thinkingLevel === undefined) {
    throw new ToolInputError("models_default.set_default requires provider/modelId or thinkingLevel");
  }
  if (area === "models_default" && ((args.provider === undefined) !== (args.modelId === undefined))) {
    throw new ToolInputError("provider and modelId must be supplied together");
  }
  if (args.provider !== undefined) text(args.provider, "provider");
  if (args.modelId !== undefined) text(args.modelId, "modelId");
  if (args.policyKey !== undefined) text(args.policyKey, "policyKey", MAX_CONTROL_PLANE_POLICY_KEY);
  if (args.source !== undefined) text(args.source, "source", 2_000);
  if (args.resourceKey !== undefined) text(args.resourceKey, "resourceKey", 2_000);
  if (args.name !== undefined) text(args.name, "name", 1_024);
  if (args.filePath !== undefined && (!path.isAbsolute(args.filePath) || /(^|[\\/])(?:\.{1,2})(?:[\\/]|$)/.test(args.filePath))) {
    throw new ToolInputError("filePath must be an absolute path without dot segments");
  }
  if (args.refs !== undefined) {
    if (!Array.isArray(args.refs) || args.refs.length > MAX_CONTROL_PLANE_REFS || args.refs.some((ref) => typeof ref !== "string" || ref.length < 1 || ref.length > 256)) {
      throw new ToolInputError("refs must be a bounded array of model references");
    }
  }
  if (area === "models_enabled" && operation === "set_models" && (args.enabled === undefined || args.refs === undefined)) {
    throw new ToolInputError("models_enabled.set_models requires enabled and refs");
  }
  if (area === "models_enabled" && operation === "set_provider" && (args.enabled === undefined || args.provider === undefined)) {
    throw new ToolInputError("models_enabled.set_provider requires enabled and provider");
  }
  if (area === "tools_settings") {
    if (operation === "set_codemode" && args.codemode === undefined) throw new ToolInputError("set_codemode requires codemode");
    if (operation === "set_codemode_mode" && args.codemodeMode === undefined) throw new ToolInputError("set_codemode_mode requires codemodeMode");
    if (operation === "set_codemode_inline_budget" && args.inlineBudget === undefined) throw new ToolInputError("set_codemode_inline_budget requires inlineBudget");
  }
  if (args.resourceId !== undefined && (!/^resource_[a-f0-9]{64}$/.test(args.resourceId) || !["skills_policy", "plugins"].includes(area))) throw new ToolInputError("Invalid scoped resourceId");
  if (args.resourceId !== undefined && ["policyKey", "filePath", "source", "resourceKey"].some(key => args[key] !== undefined)) throw new ToolInputError("Use resourceId without another identity");
  if (args.resourceId === undefined && (operation === "set_skill_invocation_mode" || operation === "clear_skill_invocation_mode") && args.policyKey === undefined && args.filePath === undefined && (args.source === undefined || args.resourceKey === undefined)) {
    throw new ToolInputError(`${operation} requires policyKey, filePath, or source plus resourceKey`);
  }
  if (operation === "set_skill_invocation_mode" && args.mode === undefined) {
    throw new ToolInputError("set_skill_invocation_mode requires mode");
  }
  if (args.resourceId === undefined && (operation === "set_global_skill_resource" || operation === "clear_global_skill_resource" || operation === "set_project_resource" || operation === "clear_project_resource") && args.filePath === undefined) {
    throw new ToolInputError(`${operation} requires filePath`);
  }
  const requireFields = (...keys) => { for (const key of keys) if (args[key] === undefined) throw new ToolInputError(`${area}.${operation} requires ${key}`); };
  if (area === "models_enabled" && operation === "resync") requireFields("renames");
  if (area === "models_config") {
    requireFields("provider", "modelId");
    if (args.name === undefined && args.thinkingLevel === undefined) throw new ToolInputError("set_model_metadata requires name or thinkingLevel");
  }
  if (args.resourceId === undefined && ["set_plugin_skill", "clear_plugin_skill"].includes(operation)) requireFields("source", "resourceKey");
  if (["set_global_skill_resource", "set_project_resource", "set_plugin_skill"].includes(operation)) requireFields("enabled");
  if (area === "plugins") {
    if (args.resourceId === undefined && ["enable", "disable", "set_project_override", "clear_project_override"].includes(operation)) requireFields("source");
    if (args.resourceId === undefined && ["set_top_level_extension", "clear_top_level_extension"].includes(operation)) requireFields("filePath");
    if (["set_project_override", "set_top_level_extension"].includes(operation)) requireFields("enabled");
  }
  if (area === "mcp") {
    if (operation === "add") {
      requireFields("name", "server");
      if (typeof args.server.url === "string") {
        let url; try { url = new URL(args.server.url); } catch { throw new ToolInputError("Invalid MCP URL"); }
        if (url.username || url.password) throw new ToolInputError("MCP URL credentials are not accepted");
      }
    }
    if (operation === "undo") requireFields("undoId");
    if (["enable", "disable", "remove", "set_exposure"].includes(operation)) requireFields("name");
    if (operation === "set_exposure") requireFields("exposure");
    if (operation === "set_enabled") requireFields("names", "enabled");
  }
  if (area === "subagent_profiles") {
    requireFields("name");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(args.name)) throw new ToolInputError("Invalid profile name");
    if (operation === "upsert") requireFields("systemPrompt", "tools", "enabled");
    if (operation === "set_enabled") requireFields("enabled");
    if (args.tools !== undefined && new Set(args.tools).size !== args.tools.length) throw new ToolInputError("Profile tools must be unique");
  }
  if (area === "subagents_settings") {
    if (operation === "patch" && args.builtInEnabled === undefined && args.maxConcurrent === undefined) throw new ToolInputError("subagents_settings.patch requires builtInEnabled or maxConcurrent");
    if (operation === "set_profile_enabled") requireFields("name", "enabled");
    if (operation === "set_profile_override") {
      requireFields("name");
      if (args.model === undefined && args.thinking === undefined) throw new ToolInputError("set_profile_override requires model or thinking");
    }
  }
  if (area === "custom_prompts") {
    if (operation === "upsert") requireFields("title", "content");
    if (operation === "delete") requireFields("id");
    if (operation === "reorder") requireFields("orderedIds");
  }
  if (area === "model_routing") requireFields("enabled", "routes");
  if (area === "compaction") requireFields("enabled");
}

async function locateControlDevice(state, deviceId, sessionId) {
  const baseUrl = state.readerUrl;
  const collected = await collectReaderApiRows(baseUrl, { scope: "active", visibility: "all", limit: MAX_LIST_LIMIT, offset: 0 });
  const device = collected.devices.find((candidate) => candidate.id === deviceId);
  if (!device) {
    return {
      ok: false,
      value: {
        source: "reader-runtime-api",
        outcome: collected.coverage.complete ? "blocked" : "unknown",
        reason: collected.coverage.complete ? "deviceId is not present in the Reader aggregate snapshot" : "deviceId could not be resolved because Reader coverage is incomplete",
        target: { deviceId },
        coverage: collected.coverage,
      },
    };
  }
  if (device.online === false) {
    return {
      ok: false,
      value: {
        source: "reader-runtime-api",
        outcome: "unavailable",
        reason: "target device is offline in the Reader aggregate snapshot",
        target: { device },
        coverage: collected.coverage,
      },
    };
  }
  if (sessionId) {
    const belongsToDevice = collected.rows.some((row) => row.id === sessionId && row.device.id === deviceId);
    if (!belongsToDevice) {
      const binding = state.createdSessionBindings.get(controlBindingKey(deviceId, sessionId));
      if (binding && binding.deviceId === deviceId && binding.sessionId === sessionId && binding.localDeviceId === collected.localDevice.id) {
        const route = controlRoute(baseUrl, collected.localDevice.id === deviceId, deviceId, sessionId);
        const verification = await verifyCreatedSessionBinding(route, binding);
        if (verification.ok) {
          return {
            ok: true,
            device,
            localDeviceId: collected.localDevice.id,
            coverage: collected.coverage,
            transientBinding: true,
            transientRuntime: verification.runtime,
          };
        }
        return {
          ok: false,
          value: {
            source: "reader-runtime-api",
            outcome: "blocked",
            reason: verification.reason,
            target: { device, sessionId },
            coverage: collected.coverage,
          },
        };
      }
      return {
        ok: false,
        value: {
          source: "reader-runtime-api",
          outcome: collected.coverage.complete ? "blocked" : "unknown",
          reason: collected.coverage.complete
            ? "sessionId is not present on the selected device's active Reader snapshot; no control request was sent"
            : "sessionId-to-device ownership could not be verified because Reader coverage is incomplete",
          target: { device, sessionId },
          coverage: collected.coverage,
        },
      };
    }
  }
  return { ok: true, device, localDeviceId: collected.localDevice.id, coverage: collected.coverage };
}

function controlBindingKey(deviceId, sessionId) {
  return `${deviceId}\u0000${sessionId}`;
}

async function verifyCreatedSessionBinding(route, binding, signal) {
  const runtime = await fetchControlState(route, signal);
  signal?.throwIfAborted();
  if (!runtime.ok) {
    return { ok: false, reason: "created session runtime could not be inspected; no control request was sent" };
  }
  if (runtime.body.running !== true) {
    return { ok: false, reason: "created session is not alive in the selected Reader process; no control request was sent" };
  }
  if (runtime.body?.state?.runtimeInspection?.cwd !== binding.cwd) {
    return { ok: false, reason: "created session cwd does not match the create receipt; no control request was sent" };
  }
  if (!Array.isArray(binding.toolNames)) {
    return { ok: false, reason: "created session has no explicit safe tool allow-list; no control request was sent" };
  }
  if (binding.toolNames.length === 0 && !isChatOnlyRuntime(runtime.body)) {
    return { ok: false, reason: "created session runtime is not the same chat-only runtime; no control request was sent" };
  }
  if (binding.toolNames.length > 0 && !isRestrictedToolRuntime(runtime.body, binding.toolNames)) {
    return { ok: false, reason: "created session runtime does not match the safe read-only tool allow-list; no control request was sent" };
  }
  if (binding.strictToolAllowlist === true && runtime.body?.state?.strictToolAllowlist !== true) {
    return { ok: false, reason: "created session runtime did not confirm strict tool allow-list mode; no control request was sent" };
  }
  return { ok: true, runtime: runtime.body };
}

function isChatOnlyRuntime(body) {
  const inspection = body?.state?.runtimeInspection;
  const tools = inspection?.tools;
  return body?.running === true
    && inspection?.systemPrompt?.characters === 0
    && Array.isArray(tools)
    && tools.every((tool) => isRecord(tool) && tool.active !== true);
}

function isRestrictedToolRuntime(body, expectedToolNames) {
  const inspection = body?.state?.runtimeInspection;
  const tools = inspection?.tools;
  if (!Array.isArray(tools)) return false;
  const activeToolNames = tools
    .filter((tool) => tool && tool.active === true && typeof tool.name === "string")
    .map((tool) => tool.name);
  if (activeToolNames.some((name) => !SAFE_CREATE_TOOL_NAME_SET.has(name))) return false;
  return sameStringSet(activeToolNames, expectedToolNames);
}

function sameStringSet(left, right) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function controlRoute(baseUrl, isLocal, deviceId, sessionId) {
  const pathPart = sessionId ? `agent/${encodeURIComponent(sessionId)}` : "agent/new";
  const route = new URL(`/api/${isLocal ? "" : "remote/"}${pathPart}`, `${baseUrl}/`);
  if (!isLocal) route.searchParams.set("peer", deviceId);
  return {
    url: route,
    description: isLocal ? `/api/${pathPart}` : `/api/remote/${pathPart}?peer=<deviceId>`,
  };
}

function readerSessionDetailRoute(baseUrl, isLocal, deviceId, sessionId) {
  const route = new URL(`/api/${isLocal ? "" : "remote/"}sessions/${encodeURIComponent(sessionId)}`, `${baseUrl}/`);
  if (!isLocal) route.searchParams.set("peer", deviceId);
  return { url: route };
}

function readerSafeHistoryRoute(baseUrl, isLocal, deviceId, sessionId) {
  const route = new URL(`/api/${isLocal ? "" : "remote/"}sessions/${encodeURIComponent(sessionId)}/safe-history`, `${baseUrl}/`);
  if (!isLocal) route.searchParams.set("peer", deviceId);
  return { url: route };
}

function readerToolResultRoute(baseUrl, isLocal, deviceId, sessionId, entryId) {
  const route = new URL(`/api/${isLocal ? "" : "remote/"}sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/tool-result`, `${baseUrl}/`);
  if (!isLocal) route.searchParams.set("peer", deviceId);
  return { url: route };
}

function readerLiveEventsRoute(baseUrl, isLocal, deviceId, sessionId) {
  const route = new URL(`/api/${isLocal ? "" : "remote/"}agent/${encodeURIComponent(sessionId)}/live`, `${baseUrl}/`);
  if (!isLocal) route.searchParams.set("peer", deviceId);
  return { url: route };
}

function readerControlReceiptRoute(baseUrl, isLocal, deviceId, sessionId, idempotencyKey, operation) {
  const route = new URL(`/api/${isLocal ? "" : "remote/"}agent/${encodeURIComponent(sessionId)}/receipt`, `${baseUrl}/`);
  route.searchParams.set("idempotencyKey", idempotencyKey);
  route.searchParams.set("operation", operation);
  if (!isLocal) route.searchParams.set("peer", deviceId);
  return { url: route, description: `${route.pathname}?idempotencyKey=<redacted>&operation=${operation}` };
}

async function fetchControlState(route, signal) {
  try {
    const body = await fetchWithBoundedJson(route.url, MAX_REMOTE_BODY_BYTES, REMOTE_TIMEOUT_MS, signal);
    return { ok: true, body: body && typeof body === "object" ? body : {} };
  } catch (error) {
    return { ok: false, status: undefined, error: publicRemoteError(error) };
  }
}

async function fetchControlReceipt(route, timeoutMs) {
  try {
    const body = await fetchWithBoundedJson(route.url, MAX_REMOTE_BODY_BYTES, timeoutMs);
    if (!body || typeof body !== "object" || Array.isArray(body) || !isRecord(body.receipt)) {
      return { ok: false, error: "invalid_receipt" };
    }
    return { ok: true, body };
  } catch (error) {
    return { ok: false, error: publicRemoteError(error) };
  }
}

async function observeStopReceipt(route) {
  const deadline = Date.now() + STOP_RECEIPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await fetchControlReceipt(route, Math.min(REMOTE_TIMEOUT_MS, remaining));
    if (result.ok) {
      const receipt = result.body.receipt;
      const readerOutcome = typeof receipt.outcome === "string" ? receipt.outcome : result.body.outcome;
      if (receipt.targetStopped === true) {
        return {
          status: "observed",
          receipt: sanitizePublicValue(receipt),
          readerOutcome,
        };
      }
      if (["failed", "unknown", "conflict"].includes(readerOutcome)) {
        return {
          status: "unobserved",
          receipt: sanitizePublicValue(receipt),
          readerOutcome,
        };
      }
    } else if (result.error !== "http_404") {
      // The observation deadline is an expected unobserved result, even when
      // the last bounded GET uses the remaining budget and is aborted.
      if (result.error === "timeout" && Date.now() >= deadline) break;
      return { status: "unknown", error: result.error };
    }

    const delay = Math.min(STOP_RECEIPT_POLL_MS, deadline - Date.now());
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return { status: "unobserved", error: "stop receipt was not observed before the bounded timeout" };
}

function runtimeObservation(runtime) {
  if (!runtime.ok) return { outcome: "unknown", error: runtime.error ?? "unavailable" };
  return sanitizePublicValue(runtime.body);
}

async function observeStopReceiptResult(receipt, route, receiptRoute, replayed) {
  const observation = await observeStopReceipt(receiptRoute);
  const runtime = await fetchControlState(route);
  const common = {
    ...receipt,
    ...(replayed ? { replayed: true } : {}),
    targetStopped: observation.status === "observed",
    completion: observation.status === "observed" ? "observed" : "unobserved",
    stopObservation: observation.status,
    runtimeObservation: runtimeObservation(runtime),
    ...(observation.receipt ? { readerReceipt: observation.receipt } : {}),
    ...(observation.readerOutcome ? { readerOutcome: safeEnum(observation.readerOutcome, ["accepted", "queued", "running", "completed", "failed", "aborted", "unknown", "conflict"]) } : {}),
  };
  if (observation.status === "observed") {
    return {
      ...common,
      outcome: "stopped",
      note: "Reader receipt observed targetStopped=true; runtime state is included separately.",
    };
  }
  if (observation.status === "unknown") {
    return {
      ...common,
      outcome: "unknown",
      error: observation.error,
      note: "Reader accepted the stop command, but the durable stop receipt could not be observed; do not retry automatically.",
    };
  }
  return {
    ...common,
    outcome: "accepted",
    note: "Reader accepted the stop command, but targetStopped=true was not observed before the bounded receipt check completed.",
  };
}

async function postControlCommand(route, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONTROL_POST_TIMEOUT_MS);
  try {
    const response = await fetch(route.url, {
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json", "Content-Type": "application/json", ...(route.auditCaller ? { "x-pi-reader-control-caller": "reader-mcp" } : {}) },
      body: JSON.stringify(payload),
    });
    const bodyText = await readResponseBody(response, MAX_REMOTE_BODY_BYTES);
    let body;
    try { body = JSON.parse(bodyText); } catch { body = { error: "Reader returned invalid JSON" }; }
    return {
      accepted: response.ok && (body?.accepted === true || (body?.accepted === undefined && body?.success === true)),
      status: response.status,
      body,
    };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Reader request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function controlUnavailable(action, deviceId, sessionId, runtime) {
  return {
    source: "reader-runtime-api",
    action,
    target: { deviceId, ...(sessionId ? { sessionId } : {}) },
    outcome: "unknown",
    reason: "Reader runtime state could not be read; no control POST was sent",
    sideEffect: "none",
    error: runtime.error ?? "unavailable",
    retryPolicy: "never-auto-retry-unknown",
  };
}

function validateControlAction(value) {
  if (typeof value !== "string" || !CONTROL_ACTIONS.has(value)) {
    throw new ToolInputError(`action must be one of: ${[...CONTROL_ACTIONS].join(", ")}`);
  }
  return value;
}

function validateControlPlaneArea(value) {
  if (typeof value !== "string" || !Object.prototype.hasOwnProperty.call(CONTROL_PLANE_AREAS, value)) {
    throw new ToolInputError(`area must be one of: ${CONTROL_PLANE_AREA_NAMES.join(", ")}`);
  }
  return value;
}

function validateControlPlaneCwd(value) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 2_000
    || value.trim() !== value
    || /[\0\r\n]/.test(value)
    || !path.isAbsolute(value)
    || /(^|[\\/])(?:\.{1,2})(?:[\\/]|$)/.test(value)
  ) {
    throw new ToolInputError("cwd must be an absolute bounded path without control characters or dot segments");
  }
  return value;
}

function validateControlPlaneScope(value) {
  if (value !== "global" && value !== "project") {
    throw new ToolInputError("scope must be one of: global, project");
  }
  return value;
}

function validateControlPlaneQuery(value, name) {
  if (
    typeof value !== "string"
    || value.length > CONTROL_PLANE_MAX_QUERY_TEXT
    || /[\0\r\n]/.test(value)
  ) {
    throw new ToolInputError(`${name} must be bounded text without control characters`);
  }
  return value;
}

function validateToolArguments(tool, args) {
  if (!isRecord(args)) throw new ToolInputError(`${tool.name} arguments must be an object`);
  const schema = tool.inputSchema;
  const properties = schema.properties ?? {};
  for (const required of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(args, required)) {
      throw new ToolInputError(`${tool.name} requires ${required}`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key];
    if (!property) {
      if (schema.additionalProperties === false) throw new ToolInputError(`${tool.name} does not accept argument: ${key}`);
      continue;
    }
    validateSchemaValue(value, property, `${tool.name}.${key}`);
  }
}

function validateSchemaValue(value, schema, label) {
  if (Array.isArray(schema.type)) {
    if (value === null && schema.type.includes("null")) return;
    schema = { ...schema, type: schema.type.find((type) => type !== "null") };
  }
  if (schema.type === "string") {
    if (typeof value !== "string") throw new ToolInputError(`${label} must be a string`);
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new ToolInputError(`${label} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new ToolInputError(`${label} is too long`);
  } else if (schema.type === "integer") {
    if (!Number.isSafeInteger(value)) throw new ToolInputError(`${label} must be an integer`);
    if (schema.minimum !== undefined && value < schema.minimum) throw new ToolInputError(`${label} is below the minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new ToolInputError(`${label} is above the maximum`);
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") throw new ToolInputError(`${label} must be boolean`);
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) throw new ToolInputError(`${label} must be an array`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new ToolInputError(`${label} has too many items`);
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        try {
          validateSchemaValue(value[index], schema.items, `${label}[${index}]`);
        } catch (error) {
          if (label.endsWith(".toolNames") && error instanceof ToolInputError) {
            throw new ToolInputError(`create_session toolNames must be [] or a unique subset of: ${SAFE_CREATE_TOOL_NAMES.join(", ")}`);
          }
          throw error;
        }
      }
    }
  } else if (schema.type === "object") {
    if (!isRecord(value)) throw new ToolInputError(`${label} must be an object`);
    for (const required of schema.required ?? []) if (!Object.hasOwn(value, required)) throw new ToolInputError(`${label} requires ${required}`);
    for (const [key, child] of Object.entries(value)) {
      const property = schema.properties?.[key];
      if (!property && schema.additionalProperties === false) throw new ToolInputError(`${label} does not accept ${key}`);
      if (property) validateSchemaValue(child, property, `${label}.${key}`);
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw new ToolInputError(`${label} must be one of: ${schema.enum.join(", ")}`);
  }
}

function validateRequiredIdentity(value, name) {
  if (typeof value !== "string" || value.length < 1 || value.length > 160 || /[\\/\0\r\n]/.test(value)) {
    throw new ToolInputError(`${name} must be an exact bounded identifier without path separators`);
  }
  return value;
}

function validateIdempotencyKey(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 200 || /[\0\r\n]/.test(value)) {
    throw new ToolInputError("idempotencyKey must be 8-200 characters without control characters");
  }
  return value;
}

function validateOptionalText(value, name, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\0\r\n]/.test(value)) {
    throw new ToolInputError(`${name} must be a non-empty bounded string without control characters`);
  }
  return value;
}

function isValidBase64ImageData(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 === 1) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  if (value.includes("=") && value.length % 4 !== 0) return false;
  const unpadded = value.replace(/=+$/, "");
  if (unpadded.length === 0) return false;
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 0) return false;
    return decoded.toString("base64").replace(/=+$/, "") === unpadded;
  } catch {
    return false;
  }
}

function controlContractFields({ idempotencyKey, requestFingerprint, expectedRevision, expectedBootId, expectedQueueRevision, confirmationReason, confirm }) {
  return {
    // This helper is reached only after the caller explicitly authorized a
    // real write. Reader defaults omitted dryRun to true.
    dryRun: false,
    idempotencyKey,
    requestFingerprint,
    ...(confirm === true ? { confirm: true } : {}),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(expectedBootId === undefined ? {} : { expectedBootId }),
    ...(expectedQueueRevision === undefined ? {} : { expectedQueueRevision }),
    ...(confirmationReason === undefined ? {} : { confirmationReason }),
  };
}

function controlRequestFingerprint(value) {
  const canonical = canonicalize(value);
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function validateBoolean(value, name) {
  if (typeof value !== "boolean") throw new ToolInputError(`${name} must be boolean`);
  return value;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedInspectText(value, max = 256) {
  return typeof value === "string" ? truncate(sanitizeText(value), max) : undefined;
}

function boundedInspectScalar(value, maxText = 256) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return boundedInspectText(value, maxText);
}

function boundedInspectFields(source, keys, maxText = 256) {
  const result = {};
  if (!isRecord(source)) return result;
  for (const key of keys) {
    const value = boundedInspectScalar(source[key], maxText);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function boundedInspectCollection(value, project) {
  if (!Array.isArray(value)) return undefined;
  const items = value.slice(0, MAX_INSPECT_COLLECTION_ITEMS).map(project).filter((item) => item !== undefined);
  return {
    items,
    ...(value.length > MAX_INSPECT_COLLECTION_ITEMS ? { truncated: true, totalCount: value.length } : {}),
  };
}

function projectInspectState(rawState) {
  const state = isRecord(rawState) ? rawState : {};
  const result = {
    stateProjection: "bounded",
    stateTruncated: false,
  };
  const scalarKeys = [
    "sessionId", "isStreaming", "isPromptRunning", "isBashRunning", "isCompacting",
    "strictToolAllowlist", "autoCompactionEnabled", "autoRetryEnabled", "messageCount",
    "pendingMessageCount", "thinkingLevel", "queueRevision",
  ];
  for (const key of scalarKeys) {
    const value = boundedInspectScalar(state[key]);
    if (value !== undefined) result[key] = value;
  }
  if (isRecord(state.model)) {
    const model = boundedInspectFields(state.model, ["id", "provider"]);
    if (Object.keys(model).length > 0) result.model = model;
  }
  if (isRecord(state.contextUsage)) {
    const contextUsage = boundedInspectFields(state.contextUsage, ["percent", "contextWindow", "tokens"]);
    if (Object.keys(contextUsage).length > 0) result.contextUsage = contextUsage;
  }
  if (isRecord(state.fastMode)) {
    const fastMode = boundedInspectFields(state.fastMode, ["mode", "supported", "enabled"]);
    if (Object.keys(fastMode).length > 0) result.fastMode = fastMode;
  }
  if (isRecord(state.queuedMessages)) {
    result.queuedMessageCounts = {
      steering: Array.isArray(state.queuedMessages.steering) ? state.queuedMessages.steering.length : 0,
      followUp: Array.isArray(state.queuedMessages.followUp) ? state.queuedMessages.followUp.length : 0,
    };
  }
  if (isRecord(state.queueCounts)) result.queueCounts = boundedInspectFields(state.queueCounts, ["steering", "followUp", "total"]);

  const runtime = state.runtimeInspection;
  if (isRecord(runtime)) {
    const projection = {};
    const runtimeFields = boundedInspectFields(runtime, ["sessionId", "capturedAt", "snapshotId"]);
    if (Object.keys(runtimeFields).length > 0) Object.assign(projection, runtimeFields);
    if (isRecord(runtime.systemPrompt)) {
      const systemPrompt = boundedInspectFields(runtime.systemPrompt, ["characters", "lines", "estimatedTokens", "sha256"]);
      if (Object.keys(systemPrompt).length > 0) projection.systemPrompt = systemPrompt;
    }
    if (isRecord(runtime.evidence)) {
      const evidence = boundedInspectFields(runtime.evidence, ["basis", "providerRequestCaptured", "systemPromptSource", "note"]);
      if (Object.keys(evidence).length > 0) projection.evidence = evidence;
    }
    const tools = boundedInspectCollection(runtime.tools, (item) => {
      if (!isRecord(item)) return undefined;
      return boundedInspectFields(item, ["name", "active", "mentionedInSystemPrompt"], 160);
    });
    if (tools) {
      projection.tools = tools.items;
      if (tools.truncated) {
        result.stateTruncated = true;
        projection.toolsTruncated = true;
        projection.toolsTotalCount = tools.totalCount;
      }
    }
    const skills = boundedInspectCollection(runtime.skills, (item) => {
      if (!isRecord(item)) return undefined;
      return boundedInspectFields(item, ["name", "promptVisible", "disableModelInvocation"], 160);
    });
    if (skills) {
      projection.skills = skills.items;
      if (skills.truncated) {
        result.stateTruncated = true;
        projection.skillsTruncated = true;
        projection.skillsTotalCount = skills.totalCount;
      }
    }
    const extensions = boundedInspectCollection(runtime.extensions, (item) => {
      if (!isRecord(item)) return undefined;
      const value = boundedInspectFields(item, ["status"], 160);
      if (Array.isArray(item.registeredTools)) value.registeredToolCount = item.registeredTools.length;
      if (Array.isArray(item.registeredCommands)) value.registeredCommandCount = item.registeredCommands.length;
      if (typeof item.error === "string") value.error = boundedInspectText(item.error, 256);
      return value;
    });
    if (extensions) {
      projection.extensions = extensions.items;
      if (extensions.truncated) {
        result.stateTruncated = true;
        projection.extensionsTruncated = true;
        projection.extensionsTotalCount = extensions.totalCount;
      }
    }
    const contextSources = boundedInspectCollection(runtime.contextSources, (item) => {
      if (!isRecord(item)) return undefined;
      return boundedInspectFields(item, ["scope", "origin", "inSystemPrompt"], 160);
    });
    if (contextSources) {
      projection.contextSourceCount = runtime.contextSources.length;
      if (contextSources.truncated) {
        result.stateTruncated = true;
        projection.contextSourcesTruncated = true;
      }
    }
    if (isRecord(runtime.skillRuntime)) {
      const skillRuntime = boundedInspectFields(runtime.skillRuntime, ["activeCount"], 160);
      if (isRecord(runtime.skillRuntime.last)) {
        Object.assign(skillRuntime, boundedInspectFields(runtime.skillRuntime.last, ["status", "errorCode", "baselineUnchanged"], 160));
      }
      if (Object.keys(skillRuntime).length > 0) projection.skillRuntime = skillRuntime;
    }
    if (Object.keys(projection).length > 0) result.runtimeInspection = projection;
  }

  const omittedTopLevel = Object.keys(state).filter((key) => ![
    ...scalarKeys, "model", "contextUsage", "fastMode", "queuedMessages", "queueCounts", "runtimeInspection",
  ].includes(key));
  if (omittedTopLevel.length > 0) {
    result.stateTruncated = true;
    result.omittedFields = omittedTopLevel.slice(0, 20);
    if (omittedTopLevel.length > 20) result.omittedFieldCount = omittedTopLevel.length;
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_INSPECT_STATE_BYTES) {
    result.stateTruncated = true;
    if (isRecord(result.runtimeInspection)) {
      const { sessionId, capturedAt, snapshotId, systemPrompt, evidence, skillRuntime } = result.runtimeInspection;
      result.runtimeInspection = { sessionId, capturedAt, snapshotId, systemPrompt, evidence, skillRuntime };
    }
  }
  return result;
}

function sanitizePublicValue(value, key = "", depth = 0) {
  // Filtering applies at every visited depth, including scalar leaves just
  // beyond the collection budget (for example model-level auth headers).
  if (key === "cwdRef" && typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) return value;
  if (isSecretKey(key) || /(?:path|file|cwd|url|token|secret|credential)/i.test(key)) return undefined;
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return truncate(sanitizeText(value), MAX_DISPLAY_TEXT);
  if (typeof value === "number" || typeof value === "boolean") return value;
  // Never return an uninspected object or array when traversal is exhausted.
  if (depth > 5) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizePublicValue(item, key, depth + 1)).filter((item) => item !== undefined);
  if (typeof value === "object") {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 100)) {
      const safe = sanitizePublicValue(childValue, childKey, depth + 1);
      if (safe !== undefined) result[childKey] = safe;
    }
    return result;
  }
  return undefined;
}

async function scanScopes(root, scopes, options = {}) {
  const sessions = [];
  const coverage = [];
  const includeSamples = options.includeSamples !== false;

  for (const scope of scopes) {
    const directoryName = scope === "active" ? ACTIVE_DIR : ARCHIVED_DIR;
    const directoryPath = await childDirectory(root, directoryName);
    if (!directoryPath) {
      coverage.push({
        scope,
        directoryPresent: false,
        filesScanned: 0,
        sessionRowsProduced: 0,
        filesRejected: 0,
        projectDirectoriesScanned: 0,
        nestedDirectoriesIgnored: 0,
        symlinksSkipped: 0,
        scanTruncated: false,
        scanRule: "Reader-compatible one-level scope/project-directory/*.jsonl; nested files are ignored",
      });
      continue;
    }

    const walked = await enumerateReaderSessionFiles(directoryPath, root);
    let sessionRowsProduced = 0;
    for (const file of walked.files) {
      const row = await makeSessionRow(file.path, scope, file.relativePath, includeSamples);
      if (row) {
        sessions.push(row);
        sessionRowsProduced += 1;
      }
    }
    coverage.push({
      scope,
      directoryPresent: true,
      filesScanned: walked.files.length,
      sessionRowsProduced,
      filesRejected: walked.files.length - sessionRowsProduced,
      projectDirectoriesScanned: walked.projectDirectoriesScanned,
      nestedDirectoriesIgnored: walked.nestedDirectoriesIgnored,
      symlinksSkipped: walked.symlinksSkipped,
      scanTruncated: walked.scanTruncated,
      truncationReason: walked.truncationReason,
      scanRule: "Reader-compatible one-level scope/project-directory/*.jsonl; nested files are ignored",
    });
  }

  return { sessions, coverage };
}

async function childDirectory(root, name) {
  const candidate = path.join(root, name);
  try {
    const entry = await fs.lstat(candidate);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
    const resolved = await fs.realpath(candidate);
    if (!isWithin(root, resolved)) return null;
    return resolved;
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Mirror Reader's session-list scanner: only
 * `<scope>/<project-directory>/*.jsonl` is a session candidate. Nested files
 * are deliberately ignored because they include other artifacts/transcripts
 * that are not part of the Reader sidebar catalogue.
 */
async function enumerateReaderSessionFiles(startDirectory, root) {
  const files = [];
  let projectDirectoriesScanned = 0;
  let nestedDirectoriesIgnored = 0;
  let symlinksSkipped = 0;
  let scanTruncated = false;
  let truncationReason;

  let projectEntries;
  try {
    projectEntries = await fs.readdir(startDirectory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { files, projectDirectoriesScanned, nestedDirectoriesIgnored, symlinksSkipped, scanTruncated, truncationReason };
    }
    if (error && error.code === "EACCES") {
      return { files, projectDirectoriesScanned, nestedDirectoriesIgnored, symlinksSkipped, scanTruncated: true, truncationReason: "scope directory could not be read due to permissions" };
    }
    throw error;
  }

  projectEntries.sort((a, b) => a.name.localeCompare(b.name));
  for (const projectEntry of projectEntries) {
    if (projectEntry.isSymbolicLink()) {
      symlinksSkipped += 1;
      continue;
    }
    if (!projectEntry.isDirectory()) continue;
    if (projectDirectoriesScanned >= MAX_DIRECTORIES) {
      scanTruncated = true;
      truncationReason = `project-directory safety limit ${MAX_DIRECTORIES} reached`;
      break;
    }
    projectDirectoriesScanned += 1;
    const projectPath = path.join(startDirectory, projectEntry.name);
    let entries;
    try {
      entries = await fs.readdir(projectPath, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      if (error && error.code === "EACCES") {
        scanTruncated = true;
        truncationReason = "a project directory could not be read due to permissions";
        continue;
      }
      throw error;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        symlinksSkipped += 1;
        continue;
      }
      if (entry.isDirectory()) {
        nestedDirectoriesIgnored += 1;
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      if (files.length >= MAX_FILES) {
        scanTruncated = true;
        truncationReason = `file safety limit ${MAX_FILES} reached`;
        break;
      }
      const candidate = path.join(projectPath, entry.name);
      const resolved = await fs.realpath(candidate);
      if (!isWithin(root, resolved)) continue;
      files.push({ path: resolved, relativePath: path.relative(root, resolved) });
    }
    if (scanTruncated) break;
  }

  return { files, projectDirectoriesScanned, nestedDirectoriesIgnored, symlinksSkipped, scanTruncated, truncationReason };
}

async function makeSessionRow(filePath, storageScope, relativePath, includeSamples) {
  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "EACCES")) return null;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) return null;

  const header = await readPrefix(filePath, HEADER_BYTES);
  const parsedHeader = parseJsonLines(header.text);
  const info = findSessionInfo(parsedHeader);
  if (!info.id) return null;

  let observedMessageCount = 0;
  let lastProgress = null;
  let observationTruncated = stats.size > SAMPLE_BYTES;
  if (includeSamples) {
    const sample = await readSample(filePath, stats.size);
    const parsed = parseJsonLines(sample.text);
    const seen = new Set();
    for (const item of parsed) {
      if (item.message) {
        const key = item.raw;
        if (!seen.has(key)) {
          seen.add(key);
          observedMessageCount += 1;
        }
        lastProgress = item.message;
      }
    }
    observationTruncated = sample.truncated;
  }

  return {
    id: info.id,
    title: info.title,
    project: projectLabel(info.cwd, info.project, relativePath),
    createdAt: info.createdAt,
    lastActivityAt: stats.mtime.toISOString(),
    sizeBytes: stats.size,
    observedMessageCount,
    observationTruncated,
    lastProgress,
    storageScope,
    filePath,
  };
}

async function readSample(filePath, size) {
  if (size <= SAMPLE_BYTES) return readAtMost(filePath, SAMPLE_BYTES, 0);
  const prefix = await readAtMost(filePath, HEADER_BYTES, 0);
  const tail = await readAtMost(filePath, SAMPLE_BYTES - HEADER_BYTES, Math.max(0, size - (SAMPLE_BYTES - HEADER_BYTES)));
  return {
    text: `${prefix.text}\n${tail.text}`,
    bytesRead: prefix.bytesRead + tail.bytesRead,
    truncated: true,
  };
}

async function readPrefix(filePath, maxBytes) {
  return readAtMost(filePath, maxBytes, 0);
}

async function readTail(filePath, maxBytes) {
  const stats = await fs.lstat(filePath);
  const start = Math.max(0, stats.size - maxBytes);
  const result = await readAtMost(filePath, maxBytes, start);
  return { ...result, truncated: start > 0 };
}

async function readAtMost(filePath, maxBytes, position) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const result = await handle.read(buffer, 0, maxBytes, position);
    return {
      text: buffer.subarray(0, result.bytesRead).toString("utf8"),
      bytesRead: result.bytesRead,
      truncated: result.bytesRead === maxBytes,
    };
  } finally {
    await handle.close();
  }
}

function parseJsonLines(text) {
  const items = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const raw = rawLine.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      items.push({ raw, parsed, message: extractMessage(parsed) });
    } catch {
      // A bounded tail can start in the middle of a line; malformed lines are ignored.
    }
  }
  return items;
}

function findSessionInfo(items) {
  const header = items[0]?.parsed;
  if (!header || typeof header !== "object" || Array.isArray(header) || header.type !== "session") {
    return { id: null, title: undefined, cwd: undefined, project: undefined, createdAt: undefined };
  }

  let id = safeIdentity(header.id || header.sessionId || header.session_id);
  let title = safeTitle(header.title || header.name);
  let cwd = safeMetadataString(header.cwd || header.currentWorkingDirectory || header.workingDirectory);
  let project = safeMetadataString(header.project || header.projectName);
  let createdAt = safeTimestamp(header.timestamp || header.createdAt);

  for (const item of items.slice(1)) {
    const value = item.parsed;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const type = String(value.type || value.event || "").toLocaleLowerCase();
    const nested = value.session && typeof value.session === "object" ? value.session : value.info && typeof value.info === "object" ? value.info : null;
    const source = nested || value;
    if (type === "session_info" && !title) title = safeTitle(source.title || source.name || value.title);
    if (!cwd) cwd = safeMetadataString(source.cwd || source.currentWorkingDirectory || source.workingDirectory);
    if (!project) project = safeMetadataString(source.project || source.projectName);
    if (!createdAt) createdAt = safeTimestamp(source.timestamp || source.createdAt || value.timestamp);
    if (id && (cwd || project) && createdAt) break;
  }

  return { id, title, cwd, project, createdAt };
}

function extractMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const type = String(value.type || value.event || "").toLocaleLowerCase();
  const nested = value.message && typeof value.message === "object" ? value.message : null;
  const source = nested || value;
  let role = source.role;
  if (!role && (type === "user" || type === "assistant" || type === "system")) role = type;
  if (typeof role !== "string") return null;
  const normalizedRole = role.toLocaleLowerCase();
  if (!["user", "assistant", "system"].includes(normalizedRole)) return null;
  const text = displayText(source.content ?? source.text ?? source.summary ?? value.content ?? value.text);
  if (!text) return null;
  return {
    role: normalizedRole,
    text,
    timestamp: safeTimestamp(source.timestamp || source.createdAt || value.timestamp),
  };
}

function displayText(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return "";
  if (typeof value === "string") return sanitizeText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((part) => displayText(part, depth + 1)).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";

  const parts = [];
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key)) continue;
    if (["text", "content", "summary", "message", "output"].includes(key)) {
      const text = displayText(child, depth + 1);
      if (text) parts.push(text);
    }
  }
  return parts.join("\n");
}

function publicMessage(message) {
  return {
    role: message.role,
    timestamp: message.timestamp,
    text: truncate(sanitizeText(message.text), MAX_DISPLAY_TEXT),
  };
}

function publicSessionRow(row) {
  return {
    id: row.id,
    storageScope: row.storageScope,
    title: row.title,
    project: row.project,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    lastActivitySource: "filesystem mtime only",
    observedMessageCount: row.observedMessageCount,
    observationTruncated: row.observationTruncated,
    lastProgress: row.lastProgress ? publicMessage(row.lastProgress) : null,
    runtimeStatus: "unknown",
    runtimeStatusReason: "The adapter does not access Reader runtime state; an idle or old file is not treated as complete.",
  };
}

function coverageFor(scan, scopes) {
  const all = scan.coverage.filter((item) => scopes.includes(item.scope));
  return {
    device: deviceName,
    localOnly: true,
    scopesRead: scopes,
    readerUiEquivalent: false,
    hiddenStateApplied: false,
    runtimeSessionsIncluded: false,
    subprojectAssignmentsApplied: false,
    directories: all,
    scanTruncated: all.some((item) => item.scanTruncated),
    note: "This is storage metadata coverage, not a Reader UI task count; hidden/runtime/subproject filtering is not applied.",
  };
}

function runtimeStatusSemantics() {
  return {
    runtimeStatusValues: ["unknown"],
    runtimeChecked: false,
    idleDoesNotMeanComplete: true,
    writeSideEffects: false,
  };
}

function compareNewest(a, b) {
  const byTime = b.lastActivityAt.localeCompare(a.lastActivityAt);
  if (byTime !== 0) return byTime;
  return a.id.localeCompare(b.id);
}

function projectLabel(cwd, project, relativePath) {
  const candidate = project || (cwd ? path.basename(cwd.replace(/[\\/]+$/, "")) : "");
  if (candidate) return truncate(sanitizeText(candidate), MAX_PROJECT_LENGTH);
  const parent = path.basename(path.dirname(relativePath));
  return parent && parent !== ACTIVE_DIR && parent !== ARCHIVED_DIR ? truncate(sanitizeText(parent), MAX_PROJECT_LENGTH) : "unknown";
}

function validateScope(value, allowBoth) {
  const allowed = allowBoth ? ["active", "archived", "both"] : ["active", "archived"];
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new ToolInputError(`scope must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function validateSessionId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_ID_LENGTH || /[\\/\0\r\n]/.test(value) || value === "." || value === "..") {
    throw new ToolInputError("sessionId must be a bounded identifier without path separators");
  }
  return value;
}

function validateProject(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_PROJECT_LENGTH || /[\0\r\n]/.test(value)) {
    throw new ToolInputError("project must be a bounded text filter");
  }
  return value;
}

function validateInteger(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ToolInputError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function validateBootId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\0\r\n]/.test(value)) {
    throw new ToolInputError("bootId must be a bounded identifier");
  }
  return value;
}

function safeIdentity(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_ID_LENGTH || /[\0\r\n\\/]/.test(value)) return null;
  return value;
}

function safeTitle(value) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return truncate(sanitizeText(value), MAX_DISPLAY_TEXT);
}

function safeMetadataString(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || /[\0\r\n]/.test(value)) return undefined;
  return value;
}

function safeTimestamp(value) {
  if (typeof value !== "string" || value.length > 128 || /[\0\r\n]/.test(value)) return undefined;
  return value;
}

function safeDeviceName(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 80 || /[\0\r\n]/.test(value)) return "local";
  return sanitizeText(value);
}

function sanitizeText(value) {
  let text = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  text = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]");
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi, "$1 [REDACTED]");
  text = text.replace(/\b(https?:\/\/[^\s/?#]+\/)[^\s]*/gi, "$1[REDACTED_PATH]");
  text = redactTextSecretFields(text);
  return text.trim();
}

// Scan field/value boundaries instead of stopping at whitespace or an escaped
// quote. The same key policy applies to object fields and JSON embedded in text.
function redactTextSecretFields(text, depth = 0) {
  // Logs sometimes retain JSON-string escapes but omit the outer quotes.
  // Decode only a valid whole string, and preserve its original spelling when
  // there is no redaction so ordinary escaped prose is not rewritten.
  if (text.includes('\\"')) {
    try {
      const decoded = JSON.parse(`"${text}"`);
      const nested = depth < 8 ? redactTextSecretFields(decoded, depth + 1) : "[REDACTED_NESTED_TEXT]";
      if (nested !== decoded) return JSON.stringify(nested).slice(1, -1);
    } catch {
      // Mixed JSON/plain text is handled by the field scanner below.
    }
  }
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[A-Za-z_$][\w$.-]*/g;
  let result = "";
  let copiedUntil = 0;
  for (let match; (match = tokens.exec(text));) {
    const raw = match[0];
    const quote = raw[0] === '"' || raw[0] === "'" ? raw[0] : null;
    let decoded = raw;
    if (quote) {
      try {
        decoded = quote === '"' ? JSON.parse(raw) : raw.slice(1, -1).replace(/\\(['\\])/g, "$1");
      } catch {
        decoded = raw.slice(1, -1);
      }
    }
    const separator = /^\s*[:=]\s*/.exec(text.slice(tokens.lastIndex));
    if (separator && isSecretKey(decoded)) {
      const valueStart = tokens.lastIndex + separator[0].length;
      const valueEnd = textFieldValueEnd(text, valueStart);
      const valueIsQuoted = text[valueStart] === '"' || text[valueStart] === "'";
      const valueQuote = valueIsQuoted ? text[valueStart] : (quote && separator[0].trimStart().startsWith(":") ? quote : "");
      result += text.slice(copiedUntil, valueStart) + `${valueQuote}[REDACTED]${valueQuote}`;
      copiedUntil = valueEnd;
      tokens.lastIndex = valueEnd;
    } else if (quote && !separator) {
      // A JSON string may itself contain serialized JSON or key=value text.
      // Bound nested decoding; do not expose an undecoded deeper string.
      const nested = depth < 8 ? redactTextSecretFields(decoded, depth + 1) : "[REDACTED_NESTED_TEXT]";
      if (nested !== decoded) {
        const encoded = quote === '"' ? JSON.stringify(nested) : `'${nested.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
        result += text.slice(copiedUntil, match.index) + encoded;
        copiedUntil = tokens.lastIndex;
      }
    }
  }
  return result + text.slice(copiedUntil);
}

function textFieldValueEnd(text, start) {
  const quoteEnd = (offset) => {
    const quote = text[offset];
    for (let index = offset + 1; index < text.length; index += 1) {
      if (text[index] === "\\") index += 1;
      else if (text[index] === quote) return index + 1;
    }
    return text.length;
  };
  if (text[start] === '"' || text[start] === "'") return quoteEnd(start);
  if (text[start] === "{" || text[start] === "[") {
    const closing = [];
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (char === '"' || char === "'") index = quoteEnd(index) - 1;
      else if (char === "{" || char === "[") closing.push(char === "{" ? "}" : "]");
      else if (char === "}" || char === "]") {
        if (closing.pop() !== char) return text.length;
        if (closing.length === 0) return index + 1;
      }
    }
    return text.length;
  }
  const end = /[\s,;'"}\]]/.exec(text.slice(start));
  return end ? start + end.index : text.length;
}

function isSecretKey(key) {
  return /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|credential|authorization|cookie|private[-_]?key)/i.test(key);
}

function truncate(value, max) {
  if (typeof value !== "string" || value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

class ToolInputError extends Error {}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  send({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

function sendToolResult(id, payload) {
  const envelope = boundedToolResult(payload);
  send({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(envelope) }],
      isError: false,
    },
  });
}

function sendToolError(id, message, code = "tool_error") {
  const safeMessage = sanitizeText(message);
  const payload = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    outcome: "error",
    error: safeMessage,
    errorCode: code,
    result: { outcome: "error", error: safeMessage, errorCode: code },
  };
  send({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      isError: true,
    },
  });
}

function opaqueCwdBindings(value) {
  if (Array.isArray(value)) return value.map(opaqueCwdBindings);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => key === "cwd" && typeof child === "string"
    ? ["cwdRef", cwdReference(child)] : [key, opaqueCwdBindings(child)]));
}

function boundedToolResult(payload) {
  const raw = isRecord(payload) ? { ...payload } : { value: payload };
  const body = raw.source === "reader-ui-requests" || raw.action === "answer_question" ? raw : opaqueCwdBindings(raw);
  const observedAt = new Date().toISOString();
  const envelope = {
    ...body,
    schemaVersion: 1,
    observedAt,
    result: body,
  };
  if (Buffer.byteLength(JSON.stringify(envelope), "utf8") <= MAX_TOOL_RESULT_BYTES) return envelope;
  if (body.source === "reader-ui-requests" || body.action === "answer_question") {
    throw new ToolInputError("Reader UI result exceeds the transport limit; no partial question or answer receipt is actionable");
  }

  const compact = {};
  for (const key of [
    "source", "outcome", "code", "action", "target", "sessionId", "device", "coverage", "pagination",
    "returnedCount", "matchingCountObserved", "totalCount", "countExact", "found", "reason", "error", "retryPolicy",
    "requestFingerprint", "idempotencyKey",
  ]) {
    if (body[key] !== undefined) compact[key] = sanitizePublicValue(body[key]);
  }
  const compactResult = {
    ...compact,
    outcome: "truncated",
    truncated: true,
    responseBudgetBytes: MAX_TOOL_RESULT_BYTES,
  };
  return {
    ...compact,
    schemaVersion: 1,
    observedAt,
    outcome: "truncated",
    truncated: true,
    responseBudgetBytes: MAX_TOOL_RESULT_BYTES,
    result: compactResult,
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
