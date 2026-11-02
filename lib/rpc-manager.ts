import { uiControlError, uiResponseSchema, validateUiResponse } from "./extension-ui-control";
import { renderSessionMessage } from "./session-messages";
import type { SessionMessage } from "./session-messages";
import type { AgentMessage as PiAgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  getSupportedThinkingLevels,
  type Api,
  type AssistantMessage as PiAssistantMessage,
  type Context as PiContext,
  type Model as PiModel,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, getAgentDir, initTheme, SessionManager, SettingsManager, Theme, type SessionEntry as PiSessionEntry, type SessionMessageEntry as NativeSessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { createInitialSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { QuickAskRuntime } from "./quick-ask-runtime";
import { QuickAskError } from "./quick-ask-context";
import { projectSessionQuickAsks as projectSessionQuickAsksForFork } from "./quick-ask-storage";
import { createQuickAskBranch, findQuickAskBranch, materializeQuickAskBranch, materializeQuickAskTransfer, quickAskItems, quickAskTransferState,
  QUICK_ASK_TRANSFER_PENDING, QUICK_ASK_TRANSFER, type QuickAskForkResult, type QuickAskScope } from "./quick-ask-log";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { createHash, randomUUID } from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import { historyEntryOrderKey, historyClientMessageIds, CLIENT_MESSAGE_CUSTOM_TYPE } from "./transcript-order";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "fs";
import { resolve, relative, isAbsolute } from "path";
import lockfile from "proper-lockfile";
import { acquireSessionRuntimeOwnership, type SessionRuntimeOwnership } from "./session-runtime-ownership";
import { recordSessionMessageOutcome } from "./session-messages";
import type { ContextUsage } from "./pi-types";
import { validateAgentImages } from "./image-attachments";
import { ReaderQueueIdentity } from "./reader-queue-identity";
import { assertUserQueueRecall } from "./queued-draft";
import { readQueueRecallResult, prepareQueueRecall, commitQueueRecall, settleQueueRecallReceipts, type QueueRecallSettlement, type QueueRecallIdentity, type QueueRecallResult } from "./queue-recall-store";
import {
  MAX_AUTO_ATTEMPTS,
  continueRetryIndex,
  continueRetryMode,
  hasRealOutput,
  lastAssistantClassification,
  nextBackoffDelayMs,
  nextSchedulerState,
  type SchedulerState,
} from "./continue-logic";
import { invalidateModelsCache } from "./models-cache";
import {
  buildQuestionAnalysisContext,
  buildQuestionAnalysisPrompt,
  buildQuestionRewritePrompt,
  buildSte100RewritePrompt,
  extractAssistantText,
  QUESTION_ANALYSIS_MAX_CHARS,
  QUESTION_ANALYSIS_MAX_TOKENS,
  QUESTION_ANALYSIS_SYSTEM_PROMPT,
  QUESTION_REWRITE_MAX_TOKENS,
  QUESTION_REWRITE_TERMS_MAX_CHARS,
  QUESTION_REWRITE_SYSTEM_PROMPT,
  STE100_REWRITE_MAX_TOKENS,
  STE100_REWRITE_SYSTEM_PROMPT,
  type QuestionAnalysisMode,
  type QuestionAnalysisPromptMetadata,
  type QuestionAnalysisResult,
  type QuestionRewriteResult,
} from "./question-analysis";
import { priceQuestionAnalysis } from "./question-analysis-cost";
import { priceTokenUsage } from "./billing";
import {
  acquireQuestionAnalysisJobLock,
  completedQuestionAnalysisData,
  draftAnalysisJobId,
  draftQuestionAnalysisData,
  failedQuestionAnalysisData,
  isResumableQuestionAnalysisJob,
  latestQuestionAnalysisJobs,
  pendingQuestionAnalysisData,
  runningQuestionAnalysisData,
  toQuestionAnalysisJobView,
  QUESTION_ANALYSIS_CUSTOM_TYPE,
  QUESTION_DRAFT_CUSTOM_TYPE,
  QUESTION_DRAFT_VERSION,
  type QuestionAnalysisJob,
  type QuestionAnalysisJobEntryData,
  type QuestionAnalysisJobView,
  type QuestionDraftEntryData,
} from "./question-analysis-jobs";
import { resolveVisibleModels, selectInitialModelScope } from "./model-scope";
import { resolveDefaultThinkingLevel } from "./thinking-level";
import {
  createProjectCommandBashExtension,
  createProjectCommandBashOperations,
  preferUserBashExtension,
} from "./project-command-env";
import { resolveShellTools } from "./powershell-settings";
import { createSessionControlExtension } from "./session-control";
import { drainLocalOwnerOutboxes, persistSessionWaitEvent, persistSessionUiRequestEvent, invalidateSessionUiRequestWaits } from "./session-waits";
import { drainPendingSessionWakes } from "./session-control-wake-queue";
import { createSubagentExtension, preferPiWebSubagentExtension } from "./subagent-extension";
import { createSubagentSkillsBinding } from "./subagent-skills";
import {
  hasSubagentResourceSnapshot,
  listSubagentProfiles,
  readSubagentSessionResources,
  subagentExtensionLoaderOptions,
  subagentToolOptions,
  SUBAGENT_CONTROL_TOOL_NAMES,
} from "./subagents";
import {
  createSubagentController,
  activeSubagentIdsForParent,
  createSubagentSkillRuntimeContext,
  permittedSubagentSkillNames,
} from "./subagent-runtime";
import {
  createRemoteClaudeHostGuardExtension,
  associateRemoteClaudeProviderSession as associateRemoteClaudeProviderHostSession,
  installRemoteClaudeHost,
  REMOTE_CLAUDE_PROVIDER_ID,
  refreshRemoteClaudeHost,
  resolveRemoteClaudeHost,
  revokeRemoteClaudeHost,
  type RemoteClaudeHostBinding,
} from "./remote-claude-host";
import { isBuiltInSubagentsEnabled } from "./subagent-settings";
import { getSessionBackgroundRunIds } from "./subagent-activity";
import { assertSessionFileExecutable } from "./session-archive";
import { createSubagentStopBridge } from "./subagent-stop-bridge";
import { sessionExecutionState, stopSessionExecution } from "./session-execution";
import { cacheSessionPath, invalidateSessionListCache, readLatestSessionEntryId, resolveSessionPath } from "./session-reader";
import { hasActiveSessionLivenessProvider, registerSessionLivenessProvider } from "./session-liveness";
import { getSessionReadSnapshot, invalidateSessionReadCache } from "./session-read-cache";
import { SESSION_DISPLAY_INPUT_CUSTOM_TYPE, sessionDisplayInputs } from "./session-hover-preview";
import { firstSessionControlDisplayText } from "./session-control-display";
import { clearSessionCaches } from "./session-caches";
import { BRANCH_NAVIGATION_PENDING, BRANCH_POSITION_CHANGED, matchesExpectedLeaf } from "./branch-navigation";
import { RecentNoticeBuffer } from "./recent-notice";
import { emitActivityEvent } from "./activity-events";
import { projectIdentityKey } from "./project-identity";
import { samePath } from "./paths";
import { localDeviceId } from "./activity-peers";
import { isSessionPeerAgentMessage, isSessionPeerMessage, type SessionPeerMessage } from "./session-peer-message.ts";
import { assignSession, subprojectForSession } from "./subproject-state";
import { resolveProject } from "./worktree";
import { assertReaderExecutionCwd, readerRuntimeProjectRoot } from "./reader-execution-cwd";
import { createCompactionModelExtension } from "./compaction-model-extension";
import { createImageGenerationOutputExtension } from "./image-generation-output-extension";
import { appendSessionFastMode, createFastModeExtension, fastModeStatus, isFastModeSupported, parseFastModeSelection, readSessionFastMode } from "./fast-mode";
import { applyRuntimeCompactionOverride, buildTransientSessionRecreationOptions } from "./session-runtime";
import { appendSessionAutoCompaction, readSessionAutoCompaction } from "./session-auto-compaction";
import {
  getModelRoutingRetryDelayMs,
  getRouteMaxAttempts,
  readModelRoutingConfig,
  resolveNextRoute,
} from "./model-routing";
import type { FastModeModelLike, FastModeSelection, FastModeStatus } from "./fast-mode";
import { appendClearedSessionToolSelection, appendSessionToolSelection, readSessionToolSelection, readSessionToolSelectionPolicy, validateSessionToolSelection } from "./session-tool-selection";
import { appendLiveEvent, LIVE_EVENT_BOOT_ID, LIVE_EVENT_MAX_BYTES, LIVE_EVENT_ROUTE_ENVELOPE_BYTES, LIVE_EVENT_SNAPSHOT_MIN_BYTES, publicLiveAgentEvent, redactLiveValue, sliceLiveEvents, type LiveAgentEventRecord } from "./live-agent-events";
import { appendDurableLiveEvent, readDurableLiveEventRecords } from "./live-event-ledger";
import { updateControlReceipt } from "./reader-control-receipts";
import { getProjectTrustStatus, projectTrustReloadOptions } from "./project-trust";
import { persistExplicitStartupPreferences } from "./startup-preferences";
import { createPiWebBuiltinExtensions } from "./builtin-extensions";
import type { McpHost } from "./mcp-host";
import { mcpPromptPreparation, type McpCommandCandidate } from "./mcp-command";
import { createReadOnlyMcpPolicyExtension, createSubagentMcpPolicyExtension } from "./mcp-read-only-policy";
import { getModelThinkingDefaults, readModelsConfig } from "./models-config-store";
import {
  agentEndErrorMessage,
  getPersistedUnattendedState,
  getSessionRunRecords,
  recordSessionRunAbort,
  recordSessionRunError,
  recordSessionRunSettled,
  recordSessionRunStart,
  recordSessionRunUnknown,
  setPersistedUnattendedState,
  touchSessionRun,
  type PersistedUnattendedState,
} from "./session-activity";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike, ExtensionUiContextLike, ToolInfo } from "./pi-types";
import type {
  ExtensionUiRequest,
  ExtensionUiResponse,
  ExtensionUsageItem,
  ExtensionWidgetItem,
  SessionHeader as ReaderSessionHeader,
  SessionInfo,
  SessionMessageEntry,
  SessionEntry,
} from "./types";
import { createHeadlessCustomUiTui, DEFAULT_CUSTOM_UI_COLUMNS, type HeadlessCustomUiTui } from "./custom-ui-terminal";
import { ExtensionWidgetAdapter } from "./extension-widget-adapter";
import { buildRuntimeInspection, type RuntimePromptCost } from "./runtime-inspection";
import {
  filterRuntimeSkills,
  loadSkillPolicyCatalog,
  routeSkillCommand,
  runtimeSkillCommandEntries,
  SkillRuntimeRouteError,
  SkillRuntimeTracker,
  type RuntimeSkillLike,
  type RuntimeSkillPolicyContext,
} from "./skill-runtime-policy";
import { getSkillInvocationModes } from "./skill-policy";
import { migrateLegacyProjectOverrides, migrateProjectWebStateKeys } from "./project-resource-policy";
import {
  createProjectPluginSettingsManager,
  reloadProjectPluginSettings,
  unwrapProjectPluginSettingsManager,
} from "./plugin-project-status";
import {
  applySkillInvocationOverrides,
  createProjectSkillSettingsManager,
  resolveGlobalSkillStateEntries,
  type ProjectSkillRuntime,
  updateProjectSkillRuntime,
  unwrapProjectSkillSettingsManager,
} from "./skill-project-status";
import {
  appendDurableSessionCreate,
  createDurableSessionResult,
  createOrReuseDurableSession,
  DurableSessionAdmissionError,
  durableAdmissionLockKey,
  findDurableSessionCreateRecord,
  hasDurableSessionCreation,
  findLegacyDurableSessionCreateRecord,
  messageKindForSource,
  validateDurableSessionRecord,
  type DurableSessionCreateRecord,
  type DurableSessionCreateRequest,
  type DurableSessionFacts,
  type DurableSessionAdmissionLease,
  type DurableSessionObservation,
  type DurableSessionResult,
} from "../packages/pi-web-session-control/index.ts";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

function liveJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function fitLiveRecords(records: readonly LiveAgentEventRecord[], maxBytes: number): LiveAgentEventRecord[] {
  const selected: LiveAgentEventRecord[] = [];
  for (const record of records) {
    const candidate = [...selected, record];
    if (liveJsonBytes(candidate) > maxBytes) break;
    selected.push(record);
  }
  return selected;
}

function fitLiveAgentEvents(events: readonly AgentEvent[], maxBytes: number): AgentEvent[] {
  const selected: AgentEvent[] = [];
  for (const event of events) {
    const candidate = [...selected, event];
    if (liveJsonBytes(candidate) > maxBytes) break;
    selected.push(event);
  }
  return selected;
}

type EventListener = (event: AgentEvent) => void;

const TOOL_EXECUTION_EVENT_TYPES = new Set([
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
]);

function isNestedToolEvent(event: AgentEvent, toolCallId: string): boolean {
  return (typeof event.parentToolCallId === "string" && event.parentToolCallId.length > 0)
    || toolCallId.includes("/");
}

function readValidSubagentResources(entries: readonly SessionEntry[]) {
  const resources = readSubagentSessionResources(entries);
  if (hasSubagentResourceSnapshot(entries) && !resources) {
    throw new Error("Invalid subagent resource snapshot");
  }
  return resources;
}

type PendingUiResponse = {
  resolve: (response: ExtensionUiResponse) => void;
  cancel: () => void;
};

type PendingPromptDisplayInput = {
  input: string | null;
};

/**
 * One SDK submission may cross several public methods. AsyncLocalStorage
 * keeps the Skill admission token attached to that submission when an
 * extension calls sendUserMessage(), whose public API intentionally returns
 * void and reports failures through the extension runner.
 */
type SkillRuntimeInvocation = {
  tokens: string[];
  disposition?: "handled" | "queued" | "started";
};

type SkillRuntimePatchedSession = AgentSessionLike & {
  _expandSkillCommand?: (text: string) => string;
  prompt: AgentSessionLike["prompt"];
  steer: AgentSessionLike["steer"];
  followUp: AgentSessionLike["followUp"];
  sendUserMessage?: SkillRuntimeSendUserMessageMethod;
};

type SkillRuntimeQueueOptions = { source?: "interactive" | "rpc" | "extension" };
type SkillRuntimeSendUserMessageMethod = (content: unknown, options?: unknown) => Promise<void>;
type SkillRuntimeQueueMethod = (
  text: string,
  images?: Parameters<AgentSessionLike["steer"]>[1],
  options?: SkillRuntimeQueueOptions,
) => Promise<"handled" | "queued">;

type NativePeerSubmission = {
  message: SessionPeerMessage;
  delivery?: "steer" | "follow_up";
  triggerTurn: boolean;
  readerControlReceiptId?: string;
  sessionMessageRoot?: string;
  stopVersion: number;
  beforeSubmit?: () => boolean;
  admissionTimer?: ReturnType<typeof setTimeout>;
  receiverOutcome?: { status: "cleared" | "failed"; note: string; retryMs: number; timer?: ReturnType<typeof setTimeout> };
  phase: "admitting" | "queued" | "running" | "accepted";
  sdkMessage?: unknown;
  runId?: string | null;
  accepted: boolean;
  resolveAccepted: () => void;
  rejectAccepted: (error: unknown) => void;
  acceptedPromise: Promise<void>;
};

type DeferredCompactionPrompt = {
  kind: "prompt";
  message: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  streamingBehavior: "steer" | "followUp";
  clientMessageId?: string;
  readerControlReceiptId?: string;
} | {
  kind: "peer";
  submissionId: string;
  message: SessionPeerMessage;
  delivery?: "steer" | "follow_up";
};
type DeferredPeerPrompt = Extract<DeferredCompactionPrompt, { kind: "peer" }>;
type DeferredUserPrompt = Extract<DeferredCompactionPrompt, { kind: "prompt" }>;

type CustomUiComponent = {
  render: (width: number) => string[];
  handleInput?: (data: string) => void;
  dispose?: () => void;
  invalidate?: () => void;
};

type ExtensionWidgetComponent = {
  render: (width: number) => unknown;
  dispose?: () => void;
};

type ExtensionWidgetFactory = (tui: HeadlessCustomUiTui, theme: Theme) => unknown;

type ActiveExtensionWidget = {
  key: string;
  component: ExtensionWidgetComponent;
  placement: "aboveEditor" | "belowEditor";
  generation: number;
  clearEmitted: boolean;
  rendered: boolean;
};

type ActiveCustomUi = {
  component: CustomUiComponent;
  width: number;
  resolve: (value: unknown) => void;
  settled: boolean;
};

type ExtensionUiRequestBody = Record<string, unknown> & {
  method: ExtensionUiRequest["method"];
  timeout?: number;
  expiresAt?: number;
};

type ExtensionCommandContextActionsLike = {
  waitForIdle: () => Promise<void>;
  newSession: () => Promise<{ cancelled: boolean }>;
  fork: () => Promise<{ cancelled: boolean }>;
  navigateTree: (targetId: string, options?: { summarize?: boolean }) => Promise<{ cancelled: boolean }>;
  switchSession: () => Promise<{ cancelled: boolean }>;
  reload: () => Promise<void>;
};

type ExtensionBindingOptions = {
  forceEmptySystemPrompt?: boolean;
};

// Pi 0.84 exposes Agent.continue() but AgentSession does not yet expose a
// public retry-turn method. Keep this adapter isolated so the dependency
// upgrade point is explicit: replace with the public API when upstream adds it.
type RetryAgentMessageLike = {
  role: string;
  stopReason?: string;
  content?: unknown;
};

type RetryAgentLike = {
  state: {
    messages: RetryAgentMessageLike[];
  };
  continue: () => Promise<void>;
};

type RetrySessionInternals = AgentSessionLike & {
  agent: RetryAgentLike;
  _isAgentRunActive: boolean;
  _lastAssistantMessage?: unknown;
  _systemPromptOverride?: string;
  _handlePostAgentRun: () => Promise<boolean>;
  _flushPendingBashMessages: () => void;
  _emitAgentSettled: () => Promise<void>;
};

const RUNNING_STATE_EVENT_TYPES = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "auto_compaction_start",
  "auto_compaction_end",
  "compaction_start",
  "compaction_end",
]);

const IDLE_RESET_EVENT_TYPES = new Set([
  "agent_end",
  "agent_settled",
  "auto_compaction_end",
  "compaction_end",
]);

const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

const DEFAULT_SESSION_SHUTDOWN_DEADLINE_MS = 5_000;

/**
 * Bound graceful session teardown so a misbehaving extension cannot keep the
 * RPC runtime registered forever. Unlike the idle timeout, zero is not a
 * useful shutdown value: teardown must always have a finite fallback.
 */
export function resolveSessionShutdownDeadlineMs(
  rawValue: string | undefined = process.env.PI_WEB_SHUTDOWN_DEADLINE_MS,
): number {
  if (rawValue !== undefined && rawValue.trim() !== "") {
    const parsed = Number(rawValue);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 2_147_483_647) return parsed;
    console.warn(`[pi-web] invalid PI_WEB_SHUTDOWN_DEADLINE_MS "${rawValue}", falling back to 5 seconds`);
  }
  return DEFAULT_SESSION_SHUTDOWN_DEADLINE_MS;
}

const SESSION_SHUTDOWN_DEADLINE_MS = resolveSessionShutdownDeadlineMs();

/**
 * Resolve the session idle timeout from the environment while keeping Node's
 * timer range bounded. Zero disables automatic idle shutdown.
 */
export function resolveSessionIdleTimeoutMs(
  rawValue: string | undefined = process.env.PI_WEB_IDLE_TIMEOUT_MS,
): number {
  if (rawValue !== undefined && rawValue.trim() !== "") {
    const parsed = Number(rawValue);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 2_147_483_647) return parsed;
    console.warn(`[pi-web] invalid PI_WEB_IDLE_TIMEOUT_MS "${rawValue}", falling back to 10 minutes`);
  }
  return DEFAULT_SESSION_IDLE_TIMEOUT_MS;
}

const SESSION_IDLE_TIMEOUT_MS = resolveSessionIdleTimeoutMs();

export interface RpcSessionStartOptions {
  /** Optional isolated native session directory used by controlled fixtures and hosts. */
  sessionDir?: string;
  toolNames?: string[];
  /** Opt into an exact per-session allow-list without changing default tool semantics. */
  strictToolAllowlist?: boolean;
  initialModel?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  fastMode?: FastModeSelection;
  /** Reader-owned lineage metadata for Talk Map context-injected sessions. */
  contextSourceSessionId?: string;
  /** Parent remote binding for a reopened/resumed Reader child session. */
  parentRemoteHost?: RemoteClaudeHostBinding;
}

const CODING_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
const THINKING_LEVEL_NAMES = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const SESSION_TOOL_NAMES = new Set<string>(SUBAGENT_CONTROL_TOOL_NAMES);
// ponytail: bounded fallback; a stuck tool cannot be awaited indefinitely.
const ABORT_TIMEOUT_MS = 2_000;
export const MCP_WAIT_STOPPED_MESSAGE = "Stopped while MCP servers were connecting; the message was not sent.";

// Extensions require a complete Theme, while the web UI applies its own styling.
class PlainTextTheme extends Theme {
  constructor() {
    super(
      { muted: "", text: "", thinkingXhigh: "", searchMatchText: "" } as ConstructorParameters<typeof Theme>[0],
      { selectedBg: "" } as ConstructorParameters<typeof Theme>[1],
      "truecolor",
    );
  }

  override fg(...[, text]: Parameters<Theme["fg"]>): string { return text; }
  override bg(...[, text]: Parameters<Theme["bg"]>): string { return text; }
  override bold(text: string): string { return text; }
  override italic(text: string): string { return text; }
  override underline(text: string): string { return text; }
  override inverse(text: string): string { return text; }
  override strikethrough(text: string): string { return text; }
  override getFgAnsi(): string { return ""; }
  override getBgAnsi(): string { return ""; }
  override getThinkingBorderColor(): (text: string) => string {
    return (text) => text;
  }
  override getBashModeBorderColor(): (text: string) => string { return (text) => text; }
}

const PLAIN_TEXT_THEME = new PlainTextTheme();
const CUSTOM_UI_KEYBINDINGS = new TuiKeybindingsManager(TUI_KEYBINDINGS);

/**
 * Resolve a Reader coding selection against the SDK's real active tool set.
 * The SDK decides which registered tools are active; Reader only replaces its
 * coding selection and carries currently active, visible non-coding tools.
 */
export function resolveActiveToolNames(
  session: AgentSessionLike,
  requested: readonly string[],
  carry: readonly string[],
): string[] {
  if (requested.length === 0) return [];

  const codingToolNames = new Set(CODING_TOOL_NAMES);
  const registered = new Map(session.getAllTools().map((tool) => [tool.name, tool]));
  const selectedToolNames = resolveShellTools(
    requested.filter((name) => codingToolNames.has(name)),
    session.settingsManager.getDefaultTools(),
  );
  const carriedToolNames = carry.filter((name) => {
    const tool = registered.get(name);
    const exposure = (tool as (ToolInfo & { exposure?: unknown }) | undefined)?.exposure;
    return tool !== undefined && !codingToolNames.has(name) && exposure !== "hidden";
  });

  return [...new Set([...selectedToolNames, ...carriedToolNames])];
}

function readSessionThinkingLevel(sessionManager: SessionManager): ThinkingLevel | undefined {
  let level: ThinkingLevel | undefined;
  for (const entry of sessionManager.getBranch()) {
    if (entry.type === "thinking_level_change") {
      level = entry.thinkingLevel as unknown as ThinkingLevel;
    }
  }
  return level;
}

export interface SessionForkResult {
  cancelled: boolean;
  newSessionId?: string;
  newSessionPath?: string;
  // Fork restores the native SDK payload unchanged (including flat image blocks).
  restoreMessage?: NativeSessionMessageEntry["message"];
  subprojectAssignmentFailed?: boolean;
}

interface ForkPersistedSessionOptions {
  sourceSessionId: string;
  sessionManager: SessionManager;
  currentSessionFile: string;
  sessionDir: string;
  entryId: string;
  cwd: string;
}

/**
 * Fork a persisted session without creating an AgentSession runtime.
 *
 * The ordinary RPC path still uses the live session manager so a running
 * session forks from its current in-memory state. Cold sessions use the file
 * path below instead; starting the full Reader runtime for a file-only copy
 * needlessly loads tools, extensions, skills, and project settings.
 */
async function forkPersistedSessionWithManager({
  sourceSessionId,
  sessionManager,
  currentSessionFile,
  sessionDir,
  entryId,
  cwd,
}: ForkPersistedSessionOptions): Promise<SessionForkResult> {
  if (!sessionManager.isPersisted()) return { cancelled: true };

  const entry = sessionManager.getEntry(entryId);
  if (!entry) throw new Error("Invalid entry ID for forking");
  if (entry.type !== "message") {
    throw new Error("Only messages can be forked");
  }

  let newSessionFile: string;
  if (entry.message.role === "assistant") {
    // Fork from assistant message: include the assistant response.
    const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
    const forkedPath = sourceManager.createBranchedSession(entry.id);
    if (!forkedPath) throw new Error("Failed to create forked session");
    newSessionFile = forkedPath;
  } else {
    // Fork from user message. The first user message is handled as an edit
    // draft by the shell rather than creating an empty persisted session.
    let isFirstMessage = true;
    for (const candidate of sessionManager.getEntries()) {
      if (candidate.type === "message") {
        isFirstMessage = candidate.id === entry.id;
        break;
      }
    }

    if (isFirstMessage) {
      invalidateSessionListCache();
      return { cancelled: false, restoreMessage: entry.message };
    }

    const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
    const forkedPath = sourceManager.createBranchedSession(entry.parentId!);
    if (!forkedPath) throw new Error("Failed to create forked session");
    newSessionFile = forkedPath;
  }

  const newSessionId = SessionManager.open(newSessionFile, sessionDir).getSessionId();
  cacheSessionPath(newSessionId, newSessionFile);
  const subprojectAssignmentFailed = !(await inheritSubprojectAssignment(sourceSessionId, newSessionId, cwd));
  invalidateSessionListCache();
  return {
    cancelled: false,
    newSessionId,
    newSessionPath: newSessionFile,
    ...(subprojectAssignmentFailed ? { subprojectAssignmentFailed: true } : {}),
  };
}

/** Fork a cold persisted session without waking its Agent runtime. */
export async function forkPersistedSessionFromFile(
  sourceSessionId: string,
  sessionFile: string,
  entryId: string,
): Promise<SessionForkResult> {
  const sessionManager = SessionManager.open(sessionFile, undefined);
  return forkPersistedSessionWithManager({
    sourceSessionId,
    sessionManager,
    currentSessionFile: sessionFile,
    sessionDir: sessionManager.getSessionDir(),
    entryId,
    cwd: sessionManager.getCwd(),
  });
}

/** Each cold write phase joins runtime admission and uses the current source owner. */
export async function forkQuickAskSession(
  sourceSessionId: string, sessionFile: string, requestedScope: QuickAskScope, targetId?: string, inferThread = false,
): Promise<QuickAskForkResult> {
  for (let starting = getLocks().get(sourceSessionId); starting; starting = getLocks().get(sourceSessionId)) {
    await starting;
  }
  const owner = getRpcSession(sourceSessionId);
  if (owner?.isShuttingDown()) throw new QuickAskError("Session is shutting down", 409);
  const sourceOwnership = owner?.isAlive() ? undefined : acquireSessionRuntimeOwnership(sessionFile);
  let created: QuickAskForkResult;
  let sourceCwd: string;
  const scope = { ...requestedScope };
  try {
    const source = owner?.isAlive() ? owner.inner.sessionManager : SessionManager.open(sessionFile);
    if (source.getSessionId() !== sourceSessionId || source.getSessionFile() !== sessionFile) {
      throw new QuickAskError("Side Ask source identity changed", 409);
    }
    const entries = source.getEntries();
    if (targetId && inferThread) {
      const target = projectSessionQuickAsksForFork(entries).find((item) => item.id === targetId
        && (item.data.branchId ?? item.branchId ?? "main") === scope.branchId);
      if (!target) throw new QuickAskError("Quick Ask fork point not found", 404);
      scope.threadId = target.data.threadId ?? target.threadId ?? "default";
    }
    if (owner?.isAlive()) return owner.getQuickAskRuntime().fork(scope, targetId);
    const transferred = !targetId ? quickAskTransferState(entries, scope) : undefined;
    if (transferred?.status === "completed") return transferred.result;
    if (!targetId) created = materializeQuickAskTransfer(source, scope, (type, data) => {
      source.appendCustomEntry(type, data);
      invalidateSessionReadCache(sessionFile);
    });
    else {
      const items = quickAskItems(entries, scope);
      const index = items.findIndex((item) => item.id === targetId);
      if (index < 0) throw new QuickAskError("Quick Ask fork point not found", 404);
      const branch = findQuickAskBranch(entries, scope) ?? createQuickAskBranch(entries, scope, source.getLeafId());
      created = materializeQuickAskBranch(source, branch, items.slice(0, index + 1), targetId);
    }
    invalidateSessionReadCache(sessionFile);
    cacheSessionPath(created.newSessionId, created.newSessionPath);
    sourceCwd = source.getCwd();
  } finally { sourceOwnership?.release(); }
  const inherited = await inheritSubprojectAssignment(sourceSessionId, created.newSessionId, sourceCwd);
  const result = { ...created, ...(!inherited ? { subprojectAssignmentFailed: true } : {}) };
  if (!targetId) {
    // Inheritance yields: a main runtime may now own a newer manager/leaf. Join
    // its admission before choosing a writer; never append through `source`.
    for (let starting = getLocks().get(sourceSessionId); starting; starting = getLocks().get(sourceSessionId)) {
      await starting;
    }
    const currentOwner = getRpcSession(sourceSessionId);
    if (currentOwner?.isShuttingDown()) throw new QuickAskError("Session is shutting down", 409);
    const completionOwnership = currentOwner?.isAlive() ? undefined : acquireSessionRuntimeOwnership(sessionFile);
    try {
      const currentSource = currentOwner?.isAlive() ? currentOwner.inner.sessionManager : SessionManager.open(sessionFile);
      if (currentSource.getSessionId() !== sourceSessionId || currentSource.getSessionFile() !== sessionFile) {
        throw new QuickAskError("Side Ask source identity changed", 409);
      }
      // No await between owner selection and these appends: a later startup must
      // open after both records, while an admitted runtime retains its own leaf.
      if (currentOwner?.isAlive()) currentOwner.recordQuickAskTransfer(scope, result);
      else {
        currentSource.appendCustomEntry(QUICK_ASK_TRANSFER_PENDING, { ...scope, result });
        currentSource.appendCustomEntry(QUICK_ASK_TRANSFER, { ...scope, result });
        invalidateSessionReadCache(sessionFile);
      }
    } finally { completionOwnership?.release(); }
  }
  invalidateSessionListCache();
  return result;
}

export async function inheritSubprojectAssignment(sourceSessionId: string, targetSessionId: string, cwd: string): Promise<boolean> {
  try {
    const project = await resolveProject(cwd);
    const projectKey = projectIdentityKey(project.projectRoot);
    const sourceSubproject = subprojectForSession(sourceSessionId, projectKey);
    if (!sourceSubproject) return true;
    assignSession(projectKey, targetSessionId, sourceSubproject.id);
    emitActivityEvent({ kind: "session", sessionId: targetSessionId });
    return true;
  } catch (error) {
    // Fork/clone remains usable when optional sidecar classification cannot be copied.
    console.warn("Failed to inherit fork subproject assignment:", error);
    return false;
  }
}

/**
 * Publish a newly promoted runtime session exactly once.
 *
 * SessionManager keeps setup-only entries transient, then persists the first
 * user or assistant conversation message itself. Reader uses this helper for
 * explicit names and completed bash-only commands that have no conversation
 * message yet. Configuration-only entries therefore remain in the transient
 * runtime and never create a formal header-only JSONL file.
 */
export function persistSessionFile(manager: SessionManager): boolean {
  const sessionFile = manager.getSessionFile();
  if (!sessionFile || existsSync(sessionFile)) return false;

  const header = manager.getHeader();
  if (!header) return false;

  const content = [header, ...manager.getEntries()]
    .map((entry) => JSON.stringify(entry))
    .join("\n") + "\n";
  const leafId = manager.getLeafId();
  writeFileSync(sessionFile, content, { encoding: "utf8", flag: "wx", mode: 0o600 });

  manager.setSessionFile(sessionFile);
  if (leafId === null) manager.resetLeaf();
  else if (manager.getLeafId() !== leafId) manager.branch(leafId);
  cacheSessionPath(manager.getSessionId(), sessionFile);
  return true;
}

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

export class AgentSessionWrapper {
  private listeners = new Set<EventListener>();
  /** Latest top-level tool event, replayed to clients that reconnect mid-run. */
  private activeToolEvents = new Map<string, AgentEvent>();
  // ponytail: retain only four warning/error notices for two minutes; persist recap failure state if cross-restart recovery is required.
  private readonly recentNoticeBuffer = new RecentNoticeBuffer<AgentEvent>(2 * 60 * 1000);
  private pendingUiResponses = new Map<string, PendingUiResponse>();
  private pendingUiRequests = new Map<string, AgentEvent>();
  private uiRequestRevision = 0;
  private uiRequestListeners = new Set<() => void>();
  private settledUiRequests = new Map<string, { request: Record<string, unknown>; fingerprint?: string; resolution: string }>();

  getPendingUiRequestsSnapshot() {
    return {
      schemaVersion: 1, sessionId: this.sessionId, runtimeGeneration: this.liveEventBootId,
      revision: this.uiRequestRevision, runtimeStatus: this.disposed || this.shuttingDown ? "closed" : "live",
      runtimeStartAttempted: false, writeSideEffects: false,
      requests: this.disposed || this.shuttingDown ? [] : Array.from(this.pendingUiRequests.values(), request => structuredClone({
        ...request, id: String(request.id), method: String(request.method),
        title: typeof request.title === "string" ? request.title : undefined,
        expiresAt: typeof request.expiresAt === "number" ? request.expiresAt : undefined,
        runtimeGeneration: this.liveEventBootId, responseSchema: uiResponseSchema(request),
      })),
    };
  }

  subscribeUiRequests(listener: (snapshot: ReturnType<AgentSessionWrapper["getPendingUiRequestsSnapshot"]>) => void) {
    const notify = () => listener(this.getPendingUiRequestsSnapshot());
    this.uiRequestListeners.add(notify);
    notify();
    return () => { this.uiRequestListeners.delete(notify); };
  }

  private notifyUiRequests() {
    this.uiRequestRevision += 1;
    for (const listener of this.uiRequestListeners) {
      try { listener(); } catch (error) { console.error("UI request subscriber failed", error); }
    }
  }

  private rememberUiResolution(id: string, record: { request: Record<string, unknown>; fingerprint?: string; resolution: string }) {
    this.settledUiRequests.set(id, { ...record, request: { method: record.request.method === "select" ? "input" : record.request.method } });
    // Eviction can only turn an old replay into an explicit unknown error;
    // it never re-admits a consumed request or claims it completed.
    if (this.settledUiRequests.size > 1024) this.settledUiRequests.delete(this.settledUiRequests.keys().next().value!);
  }

  private activeCustomUis = new Map<string, ActiveCustomUi>();
  private extensionUiAbortController = new AbortController();
  private extensionStatuses = new Map<string, string>();
  private extensionUsages = new Map<string, ExtensionUsageItem>();
  private extensionWidgets = new Map<string, ExtensionWidgetItem>();
  private editorSuggestion: string | null = null;
  private readonly extensionWidgetAdapter: ExtensionWidgetAdapter;
  private readonly projectSkillRuntime?: ProjectSkillRuntime;
  private readonly skillRuntimeContext?: RuntimeSkillPolicyContext;
  private readonly skillRuntimeTracker = new SkillRuntimeTracker();
  private readonly skillRuntimeInvocationStorage = new AsyncLocalStorage<SkillRuntimeInvocation>();
  private skillRuntimeAdmissionRestore: (() => void) | null = null;
  private skillRuntimeAdmissionInstalled = false;
  private readonly fastModeState: { mode: FastModeSelection };
  private remoteClaudeHost?: RemoteClaudeHostBinding;
  private remoteHostRefreshPromise: Promise<void> | null = null;
  private readonly mcpHost?: Pick<McpHost, "prepareForPrompt" | "dispose">;
  private mcpHostDisposed = false;
  /** The MCP wait of the prompt being admitted; Stop ends it. */
  private mcpPromptWait: { controller: AbortController; done: Promise<void> } | null = null;
  private systemPromptCostCache: { key: string; value: RuntimePromptCost } | null = null;
  private unattendedEnabled = false;
  private unattendedConfigured = false;
  private schedulerState: SchedulerState | null = null;
  private unattendedResumeRequired = false;
  private abortRequested = false;
  private preserveSchedulerOnDestroy = false;
  private routingTriedProviders = new Set<string>();
  private routingCurrentProviderRetries = 0;
  /** One-shot delay override for the next automatic retry on this route. */
  private routingRetryBackoffAttempt = 0;
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null;
  private promptRunning = false;
  private treeNavigationPending = false;
  private activeExtensionWidgets = new Map<string, ActiveExtensionWidget>();
  private extensionWidgetGenerations = new Map<string, number>();
  private extensionWidgetsResetting = false;
  private pendingPromptCount = 0;
  private promptAdmissionCount = 0;
  private questionAnalysisJobs = new Set<string>();
  private questionTaskControllers = new Set<AbortController>();
  /** Draft question-analysis metadata awaiting the user message it was sent with. */
  private pendingPromptQuestionAnalysis: QuestionAnalysisPromptMetadata[] = [];
  private pendingPromptDisplayInputs: PendingPromptDisplayInput[] = [];
  private deferredCompactionPrompts: DeferredCompactionPrompt[] = [];
  /**
   * Items the flusher has taken for admission but has not sent yet. They stay
   * in `deferredCompactionPrompts` so Recall and queue identity still see them;
   * removing one before the awaited admission is what let a recall during that
   * window send anyway.
   */
  private admittingDeferredPrompts = new WeakSet<DeferredCompactionPrompt>();
  private submittingDeferredPrompts = new WeakSet<DeferredCompactionPrompt>();
  private compactionPromptFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private promptAdmissionTail: Promise<void> = Promise.resolve();
  private inputStopGeneration = 0;
  private extensionsBound = false;
  private extensionBindingPromise: Promise<void> | null = null;
  private extensionBindingError: unknown = null;
  private forceEmptySystemPrompt = false;
  private suppressCompletionNotifications = false;
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private sideAskRuntime: QuickAskRuntime | undefined;
  private sideAskWriteFailed = false;
  private disposed = false;
  private destroyCallbackInvoked = false;
  private shutdownEventEmitted = false;
  // Reader defers post-run auto-compaction until the next continuation.
  // The override is in-memory only and is restored at the next run boundary.
  private deferredAutoCompactionEnabled: boolean | null = null;
  // Current-session toggles must not dirty global or project settings.
  private runtimeAutoCompactionEnabled: boolean | null = null;
  private modelConfigRefreshPromise: Promise<void> | null = null;
  private lastObservedModelsMtime = 0;
  private _alive = true;
  private shuttingDown = false;
  // Server-generated activity run identity shared with every SSE client. It means
  // "a run is live": control receipts (steer/abort) bind to it, so it is cleared
  // as soon as agent_settled has been delivered.
  private currentRunId: string | null = null;
  // The run that just settled while its prompt is still unwinding. Only the
  // trailing prompt_done / prompt_error are stamped with it, so every client sees
  // one run key across agent_settled and the prompt lifecycle (clients drop a
  // terminal event that lacks the run id they are tracking). Control receipts
  // never read it. Cleared by the next agent_start or by prompt_done.
  private settledRunId: string | null = null;
  /** Reader-owned control receipts waiting for a run or its terminal event. */
  private controlReceiptBindings = new Map<string, {
    operation: string;
    runId: string | null;
    phase: "admitting" | "starting" | "queued" | "running";
    queueKind?: "steering" | "followUp";
    queueMessage?: string;
    sdkMessage?: unknown;
    peerMessageId?: string;
    expectedIdentity?: { bootId?: string; revision?: string };
    identityConsumed?: boolean;
    terminalReceipt?: {
      update: Parameters<typeof updateControlReceipt>[1];
      writing: boolean;
      attempt?: Promise<boolean>;
      retryMs: number;
      retryTimer?: ReturnType<typeof setTimeout>;
    };
  }>();
  private readonly controlReceiptAdmissionStorage = new AsyncLocalStorage<string>();
  private readonly clientMessageAdmission = new AsyncLocalStorage<{ id: string; claimed: boolean }>();
  private readonly clientMessageObjects = new WeakMap<object, string>();
  private readonly submittedClientMessageIds = new Set<string>();
  /** Native peer submissions awaiting the SDK's exact enqueue/start boundary. */
  private readonly nativePeerSubmissions = new Map<string, NativePeerSubmission>();
  private controlQueueCaptureRestore: (() => void) | null = null;
  /** Bounded in-process projection for read-only live inspection. */
  private readonly liveEventBootId = `${LIVE_EVENT_BOOT_ID}:${randomUUID()}`;
  private liveEventCursor = 0;
  /** Queue mutation identity is independent of assistant/tool event traffic. */
  private queueMutationVersion = 0;
  private queueIdentityTracker: ReaderQueueIdentity | null = null;
  private managedSettingPending = false;
  private readonly liveEventRecords: LiveAgentEventRecord[] = [];
  private readonly strictToolAllowlist: boolean;
  private preserveUnattendedStateOnShutdown = false;
  private readonly runtimeOwnership?: SessionRuntimeOwnership;
  private bashExecution?: Promise<unknown>;
  private subagentExecution?: { completion: Promise<unknown>; cancel: () => void };
  private stopAllPromise: ReturnType<typeof stopSessionExecution> | null = null;
  private stopAllRequested = false;
  private readonly stopBackgroundRun?: (runId: string) => Promise<void>;
  private restoreStoppedCustomMessageAdmission: (() => void) | null = null;

  constructor(public readonly inner: AgentSessionLike, projectSkillRuntime?: ProjectSkillRuntime, fastModeState: { mode: FastModeSelection } = { mode: "default" }, mcpOptions: {
    mcpHost?: Pick<McpHost, "prepareForPrompt" | "dispose">;
    remoteClaudeHost?: RemoteClaudeHostBinding;
    strictToolAllowlist?: boolean;
    skillRuntimeContext?: RuntimeSkillPolicyContext;
    stopBackgroundRun?: (runId: string) => Promise<void>;
    runtimeOwnership?: SessionRuntimeOwnership;
  } = {}) {
    this.runtimeOwnership = mcpOptions.runtimeOwnership;
    const persistedCompaction = readSessionAutoCompaction(inner.sessionManager?.getEntries?.() ?? []);
    if (persistedCompaction !== undefined) this.setAutoCompactionEnabledRuntimeOnly(persistedCompaction);
    this.projectSkillRuntime = projectSkillRuntime;
    const sendCustom = inner.sendCustomMessage;
    if (typeof sendCustom === "function") {
      inner.sendCustomMessage = (message, options) => sendCustom.call(inner, message, this.stopAllRequested
        ? { ...options, deliverAs: "nextTurn", triggerTurn: false } : options);
      this.restoreStoppedCustomMessageAdmission = () => { inner.sendCustomMessage = sendCustom; };
    }
    this.stopBackgroundRun = mcpOptions.stopBackgroundRun;
    this.skillRuntimeContext = mcpOptions.skillRuntimeContext;
    this.skillRuntimeAdmissionRestore = this.installSkillRuntimeAdmission();
    this.controlQueueCaptureRestore = this.installControlQueueCapture();
    try {
      this.queueIdentityTracker = new ReaderQueueIdentity(this.inner.agent, this.liveEventBootId, () => this.emitQueueUpdate());
    } catch {
      // Older/unsupported SDKs can still serve ordinary sessions. Identity-aware
      // queue commands fail before mutation; never infer attachments from text.
      this.queueIdentityTracker = null;
    }
    this.fastModeState = fastModeState;
    this.remoteClaudeHost = mcpOptions.remoteClaudeHost;
    this.mcpHost = mcpOptions.mcpHost;
    this.strictToolAllowlist = mcpOptions.strictToolAllowlist === true;
    this.extensionWidgetAdapter = new ExtensionWidgetAdapter(
      PLAIN_TEXT_THEME,
      (key, widget) => {
        if (widget) this.extensionWidgets.set(key, widget);
        else this.extensionWidgets.delete(key);
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: widget?.lines,
          widgetPlacement: widget?.placement,
        } as AgentEvent);
      },
      (key, error) => this.emit({
        type: "extension_error",
        extensionPath: `widget:${key}`,
        event: "setWidget",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  get cwd(): string {
    return this.inner.sessionManager.getCwd();
  }

  peekQuickAskRuntime(): QuickAskRuntime | undefined {
    return this.sideAskRuntime;
  }

  /** Side Asks are not main-session execution: Stop All leaves them running and only closing the session ends them. */
  hasActiveSideAsk(): boolean {
    return this.sideAskRuntime?.hasActiveRun() === true;
  }

  getQuickAskRuntime(): QuickAskRuntime {
    this.assertSessionWriteAllowed();
    if (!this.sideAskRuntime) {
      if (!this.sessionFile) throw new QuickAskError("Side Ask source session file is unavailable", 409);
      this.sideAskRuntime = new QuickAskRuntime({
        sessionId: this.sessionId, sessionFile: this.sessionFile, manager: this.inner.sessionManager,
        assertWritable: () => this.assertSessionWriteAllowed(),
        isMainRunning: () => this.isRunning(),
        currentModel: () => this.inner.model,
        sourceSystem: () => {
          const active = new Set(this.inner.getActiveToolNames());
          const tools = this.inner.getAllTools().filter((tool) => active.has(tool.name)).map((tool) => ({
            name: tool.name, description: tool.description,
            parameters: tool.parameters as import("@earendil-works/pi-ai").Tool["parameters"],
          }));
          return createInitialSystemMessage(this.currentSystemPrompt(), tools);
        },
        transformContext: async (messages) => {
          const runner = this.inner.extensionRunner as typeof this.inner.extensionRunner & {
            emitContext?: (messages: import("@earendil-works/pi-agent-core").AgentMessage[]) => Promise<import("@earendil-works/pi-agent-core").AgentMessage[]>;
          };
          if (!runner?.emitContext) throw new QuickAskError("Live Pi context extension runner is unavailable");
          return runner.emitContext(messages);
        },
        append: (customType, data) => this.appendSideAskRecord(customType, data),
        associateProvider: (providerSessionId, model) => {
          if (model.provider !== REMOTE_CLAUDE_PROVIDER_ID) return undefined;
          const liveModel = this.inner.model;
          if (!liveModel || liveModel.provider !== model.provider || liveModel.id !== model.id) {
            throw new QuickAskError("Remote Claude host model changed; choose its current model for this Side Ask", 503);
          }
          return associateRemoteClaudeProviderHostSession({ providerSessionId, hostIdentity: this.inner,
            sessionManager: this.inner.sessionManager, model: liveModel });
        },
        materialized: async (result) => {
          cacheSessionPath(result.newSessionId, result.newSessionPath);
          const inherited = await inheritSubprojectAssignment(this.sessionId, result.newSessionId, this.cwd);
          invalidateSessionListCache();
          return inherited ? {} : { subprojectAssignmentFailed: true };
        },
      });
    }
    return this.sideAskRuntime;
  }

  private appendSideAskRecord(customType: string, data: unknown): PiSessionEntry {
    this.assertSessionWriteAllowed();
    // Serialization and cache failures are not evidence of an uncertain SDK append.
    JSON.stringify(data);
    let id: string;
    try {
      this.persistSessionFileNow(true);
      id = this.inner.sessionManager.appendCustomEntry(customType, data);
    } catch (error) {
      // SDK append mutates its index before writing. Quarantine only this uncertain
      // persistence state; ordinary Side Ask preparation/provider failures stay isolated.
      this.sideAskWriteFailed = true;
      this.sideAskRuntime?.close();
      try { void this.inner.abort().catch(() => undefined); } catch { /* Teardown remains fail closed. */ }
      this.emitShutdownEvent();
      void this.shutdown().catch(() => undefined);
      throw error;
    }
    const entry = this.inner.sessionManager.getEntry(id);
    if (!entry) throw new Error("SDK did not retain the appended Side Ask record");
    invalidateSessionReadCache(this.sessionFile);
    invalidateSessionListCache();
    return entry;
  }

  recordQuickAskTransfer(scope: QuickAskScope, result: QuickAskForkResult): void {
    this.appendSideAskRecord(QUICK_ASK_TRANSFER_PENDING, { ...scope, result });
    this.appendSideAskRecord(QUICK_ASK_TRANSFER, { ...scope, result });
  }

  private currentSystemPrompt(): string {
    return this.forceEmptySystemPrompt
      ? ""
      : this.inner.agent.state?.systemPrompt || this.inner.systemPrompt || "";
  }

  get remoteClaudeHostBinding(): RemoteClaudeHostBinding | undefined {
    return this.remoteClaudeHost;
  }

  setRemoteClaudeHostBinding(binding: RemoteClaudeHostBinding | undefined): void {
    this.remoteClaudeHost = binding;
  }

  /** Refresh the live host scope only when the SDK's active tool set changed. */
  async refreshRemoteClaudeHostBinding(): Promise<void> {
    if (!this.remoteClaudeHost) return;
    const previous = this.remoteHostRefreshPromise;
    const refresh: Promise<void> = (previous ?? Promise.resolve()).then(async () => {
      const current = this.remoteClaudeHost;
      if (!current || !this._alive || this.shuttingDown) return;
      const next = await refreshRemoteClaudeHost(current, {
        activeTools: this.inner.getActiveToolNames(),
        modelRuntime: this.inner.modelRuntime,
      });
      if (!next) throw new Error("capability-unavailable: Reader host binding is no longer current");
      this.remoteClaudeHost = next;
    });
    const marker = refresh.then(() => undefined, () => undefined);
    this.remoteHostRefreshPromise = marker;
    try {
      await refresh;
    } finally {
      if (this.remoteHostRefreshPromise === marker) this.remoteHostRefreshPromise = null;
    }
  }

  private getFastModeStatus(): FastModeStatus {
    return fastModeStatus(this.fastModeState.mode, this.inner.model as unknown as FastModeModelLike);
  }

  private async estimateSystemPromptCost(
    promptHash: string,
    estimatedTokens: number,
    model: AgentSessionLike["model"],
  ): Promise<RuntimePromptCost | undefined> {
    if (!model) return undefined;
    const key = `${promptHash}:${model.provider}/${model.id}:${estimatedTokens}`;
    if (this.systemPromptCostCache?.key === key) return this.systemPromptCostCache.value;

    const priced = await priceTokenUsage({
      model: model.id,
      provider: model.provider,
      input: estimatedTokens,
      timestamp: new Date().toISOString(),
    });
    const amount = priced.pricing.configured && priced.cost ? priced.cost.total : null;
    const value: RuntimePromptCost = {
      provider: model.provider,
      model: model.id,
      amount,
      currency: priced.pricing.currency ?? "USD",
      status: amount === null ? "unavailable" : "calculated",
    };
    this.systemPromptCostCache = { key, value };
    return value;
  }

  get streamingMessage() {
    return this.inner.agent.state?.streamingMessage;
  }

  isStrictToolAllowlist(): boolean {
    return this.strictToolAllowlist;
  }

  /**
   * Read the in-process live projection without sending an AgentSession
   * command. This method never starts or rehydrates a session. It may replay
   * the bounded, redacted live-event ledger across prior runtime boots; it
   * never reads the durable transcript.
   */
  readLiveEvents(options: {
    cursor?: number;
    limit?: number;
    maxBytes?: number;
  } = {}) {
    const requestedMaxBytes = Number.isFinite(options.maxBytes)
      ? Math.max(LIVE_EVENT_SNAPSHOT_MIN_BYTES, Math.min(LIVE_EVENT_MAX_BYTES, Math.floor(options.maxBytes as number)))
      : 64 * 1024;
    const snapshotBudget = Math.max(
      LIVE_EVENT_SNAPSHOT_MIN_BYTES,
      requestedMaxBytes - LIVE_EVENT_ROUTE_ENVELOPE_BYTES,
    );
    const projectionBudget = Math.max(
      LIVE_EVENT_SNAPSHOT_MIN_BYTES,
      Math.floor(snapshotBudget / 3),
    );
    const deviceId = localDeviceId();
    const durable = readDurableLiveEventRecords(this.sessionId, { deviceId, cursor: options.cursor });
    const recordsByCursor = new Map<number, LiveAgentEventRecord>();
    for (const record of durable.records) recordsByCursor.set(record.cursor, record);
    for (const record of this.liveEventRecords) recordsByCursor.set(record.cursor, record);
    const projectedRecords = [...recordsByCursor.values()].sort((a, b) => a.cursor - b.cursor);
    const effectiveCursor = Math.max(this.liveEventCursor, projectedRecords.at(-1)?.cursor ?? 0);
    const slice = sliceLiveEvents(
      projectedRecords,
      effectiveCursor,
      options.cursor ?? 0,
      options.limit ?? 50,
      projectionBudget,
    );
    const rawActiveToolEvents = [...this.activeToolEvents.values()]
      .map((event) => publicLiveAgentEvent(event))
      .filter((event): event is AgentEvent => event !== null)
      .slice(0, 100);
    const rawStreamingMessage = this.streamingMessage === undefined
      ? undefined
      : redactLiveValue(this.streamingMessage);
    let events = fitLiveRecords(slice.events, projectionBudget);
    let activeToolEvents = fitLiveAgentEvents(rawActiveToolEvents, projectionBudget);
    let streamingMessage = rawStreamingMessage;
    if (streamingMessage !== undefined && liveJsonBytes(streamingMessage) > projectionBudget) {
      streamingMessage = undefined;
    }
    let truncated = slice.truncated
      || events.length < slice.events.length
      || activeToolEvents.length < rawActiveToolEvents.length
      || (rawStreamingMessage !== undefined && streamingMessage === undefined);
    const requestedCursor = Number.isSafeInteger(options.cursor)
      ? Math.max(0, Math.min(this.liveEventCursor, options.cursor as number))
      : 0;
    const queueIdentity = this.getQueueIdentity();
    const createSnapshot = () => ({
      bootId: this.liveEventBootId,
      sessionId: this.sessionId,
      capturedAt: new Date().toISOString(),
      cursor: effectiveCursor,
      nextCursor: events.at(-1)?.cursor ?? requestedCursor,
      oldestCursor: slice.oldestCursor,
      truncated,
      bytesRead: events.reduce((total, event) => total + liveJsonBytes(event), 0),
      events,
      activeToolEvents,
      ...(streamingMessage === undefined ? {} : { streamingMessage }),
      isStreaming: this.isStreaming,
      isPromptRunning: this.isPromptRunning,
      strictToolAllowlist: this.strictToolAllowlist,
      queueRevision: queueIdentity.revision,
      queueCounts: queueIdentity.counts,
      durableLedger: {
        available: durable.durableAvailable,
        coverageComplete: durable.coverageComplete,
        writeFailureObserved: durable.writeFailureObserved,
        lastPersistedCursor: durable.lastPersistedCursor,
        ...(durable.gap ? { gap: durable.gap } : {}),
        replay: true,
        retention: "bounded-per-session",
      },
    });
    let snapshot = createSnapshot();
    while (liveJsonBytes(snapshot) > snapshotBudget) {
      // Active tools and streaming text are the volatile projections; trim them
      // before reducing the cursor/event page so cursor continuity survives.
      if (activeToolEvents.length > 0) {
        activeToolEvents = activeToolEvents.slice(0, Math.floor(activeToolEvents.length / 2));
        truncated = true;
      } else if (streamingMessage !== undefined) {
        streamingMessage = undefined;
        truncated = true;
      } else if (events.length > 0) {
        events = events.slice(0, Math.floor(events.length / 2));
        truncated = true;
      } else {
        break;
      }
      snapshot = createSnapshot();
    }
    return snapshot;
  }

  /** Stable runtime identity used by the MCP control contract. */
  getLiveRuntimeIdentity(): { bootId: string; cursor: number; revision: string } {
    const revision = createHash("sha256").update(JSON.stringify({
      sessionId: this.sessionId,
      bootId: this.liveEventBootId,
      cursor: this.liveEventCursor,
      model: this.inner.model ? { provider: this.inner.model.provider, id: this.inner.model.id } : null,
      thinkingLevel: this.inner.agent?.state?.thinkingLevel ?? null,
      tools: typeof this.inner.getActiveToolNames === "function" ? [...this.inner.getActiveToolNames()].sort() : [],
      cwd: this.cwd,
      leafId: typeof this.inner.sessionManager.getLeafId === "function"
        ? this.inner.sessionManager.getLeafId()
        : null,
    })).digest("hex");
    return { bootId: this.liveEventBootId, cursor: this.liveEventCursor, revision };
  }

  /** Bounded settings inventory, read directly from this already-live wrapper. */
  getManagedSettingsSnapshot() {
    const tools = this.inner.getAllTools();
    const active = new Set(this.inner.getActiveToolNames());
    return {
      ...this.getLiveRuntimeIdentity(),
      model: this.inner.model ? { provider: this.inner.model.provider, id: this.inner.model.id } : null,
      thinkingLevel: this.inner.agent?.state?.thinkingLevel ?? "off",
      strictToolAllowlist: this.strictToolAllowlist,
      selectionSemantics: this.strictToolAllowlist ? "exact-registered-built-in-subset" : "built-in-selection-preserves-active-extension-tools",
      tools: tools.slice(0, 500).map((tool) => ({ name: tool.name, active: active.has(tool.name) })),
      toolsTruncated: tools.length > 500,
    };
  }

  validateManagedSetting(command: Record<string, unknown>): void {
    const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
    if (readValidSubagentResources(this.inner.sessionManager.getEntries() as unknown as SessionEntry[])) {
      fail("subagent_settings_fixed", "Managed settings cannot override a subagent's profile-owned resources");
    }
    if (this.managedSettingPending || this.treeNavigationPending || this.isRunning() || this.getQueueIdentity().counts.total > 0) {
      fail("runtime_busy", "Wait for the live runtime and its queue to become idle before changing settings");
    }
    if (command.type === "set_model") {
      for (const key of ["provider", "modelId"]) {
        if (typeof command[key] !== "string" || !(command[key] as string).trim() || (command[key] as string).length > 256 || /[\x00-\x1f\x7f]/.test(command[key] as string)) fail("invalid_setting", `${key} is invalid`);
      }
      if (command.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(command.thinkingLevel))) fail("invalid_setting", "Invalid thinkingLevel");
      if (!this.inner.modelRuntime.getModel(command.provider as string, command.modelId as string)) fail("model_unavailable", "The model is not registered in this live runtime");
    } else if (command.type === "set_tools") {
      const names = validateSessionToolSelection(command.toolNames);
      if (names.length !== (command.toolNames as unknown[]).length) fail("invalid_setting", "toolNames must be unique");
      const registered = new Set(this.inner.getAllTools().map((tool) => tool.name));
      if (names.some((name) => !registered.has(name))) fail("tool_unavailable", "A requested tool is not registered in this live runtime");
      if (command.strictToolAllowlist !== undefined && command.strictToolAllowlist !== this.strictToolAllowlist) fail("strict_policy_mismatch", "A live setting cannot change the runtime's strict tool registration policy");
    } else fail("unsupported_operation", "Unsupported live setting");
  }

  /** Serialize settings with every wrapper mutation; no alternate runtime or receipt store. */
  async sendManagedSetting(command: Record<string, unknown>, expected: { bootId: string; revision: string }) {
    this.validateManagedSetting(command);
    // UI tool selection can await remote-host refresh or replace the wrapper.
    // Share its session lock, rejecting an already admitted UI mutation before
    // CAS rather than reporting completion on a superseded runtime.
    if (getToolMutationLocks().has(this.sessionId)) {
      throw Object.assign(new Error("A tool settings mutation is pending"), { code: "runtime_busy" });
    }
    const identity = this.getLiveRuntimeIdentity();
    if (expected.bootId !== identity.bootId || expected.revision !== identity.revision) {
      throw Object.assign(new Error("Live settings changed before mutation"), { code: expected.bootId !== identity.bootId ? "boot_changed" : "revision_conflict" });
    }
    this.managedSettingPending = true;
    return withToolMutationLock(this.sessionId, async () => {
      try {
        this.assertWriteOpen();
        await this.sendCommand(command);
        this.assertWriteOpen();
        return this.getManagedSettingsSnapshot();
      } finally {
        // Release the busy flag before waking the next UI lock holder.
        this.managedSettingPending = false;
      }
    });
  }

  /** Exact queue CAS identity; reads neither start a runtime nor persist state. */
  getQueueIdentity(): { revision: string; counts: { steering: number; followUp: number; total: number } } {
    const sdk = this.readSdkQueuedMessages();
    const queued = sdk ? {
      steering: [
        ...sdk.steering,
        ...this.deferredCompactionPrompts.filter((item) => item.kind === "prompt" && item.streamingBehavior === "steer"),
        ...this.deferredCompactionPrompts.filter((item): item is DeferredPeerPrompt => item.kind === "peer" && item.delivery === "steer").map((item) => ({ messageId: item.message.details.messageId, content: item.message.content })),
      ],
      followUp: [
        ...sdk.followUp,
        ...this.deferredCompactionPrompts.filter((item) => item.kind === "prompt" && item.streamingBehavior === "followUp"),
        ...this.deferredCompactionPrompts.filter((item): item is DeferredPeerPrompt => item.kind === "peer" && item.delivery !== "steer").map((item) => ({ messageId: item.message.details.messageId, content: item.message.content })),
      ],
    } : this.queuedMessages();
    const revision = createHash("sha256").update(JSON.stringify({
      sessionId: this.sessionId,
      bootId: this.liveEventBootId,
      version: this.queueMutationVersion,
      queued,
    })).digest("hex");
    return {
      revision,
      counts: {
        steering: queued.steering.length,
        followUp: queued.followUp.length,
        total: queued.steering.length + queued.followUp.length,
      },
    };
  }

  /** Associate an explicit MCP control with the Reader-owned run lifecycle. */
  bindControlReceipt(receiptId: string, operation: string, expectedIdentity?: { bootId?: string; revision?: string }): void {
    // clear_queue is a synchronous queue mutation, not a queued model run.
    // Its own completed receipt is recorded by the managed control route.
    if (operation === "clear_queue") return;
    // Prompt/follow-up controls are queued behind the current run. Binding
    // either to a stale or preceding run would settle the receipt before the
    // queued message starts. Let the next agent_start claim them. Steer and
    // abort target the active run when one is actually live.
    const runId = operation === "steer" || operation === "abort" ? this.currentRunId : null;
    this.controlReceiptBindings.set(receiptId, { operation, runId, phase: operation === "abort" ? "running" : "admitting", expectedIdentity });
    if (runId) {
      void updateControlReceipt(receiptId, {
        outcome: "running",
        startedAt: new Date().toISOString(),
        runId,
        bootId: this.liveEventBootId,
        nextAction: "observe_receipt_or_live_events",
      }).catch(() => undefined);
    }
  }

  /** Read the existing core queue, not the SDK text mirror that can lag a drain. */
  getActiveControlRunId(): string | null { return this.currentRunId; }

  private assertManagedControlIdentity(expected?: { bootId?: unknown; revision?: unknown }): void {
    if (!expected || (expected.bootId === undefined && expected.revision === undefined)) return;
    const actual = this.getLiveRuntimeIdentity();
    if (expected.bootId !== undefined && expected.bootId !== actual.bootId) throw Object.assign(new Error("Reader runtime boot changed before admission"), { code: "boot_changed" });
    if (expected.revision !== undefined && expected.revision !== actual.revision) throw Object.assign(new Error("Reader runtime revision changed before admission"), { code: "revision_conflict" });
  }

  /** Consume CAS once, at the first actual start or queue mutation. */
  private consumeManagedControlIdentity(receiptId: string | undefined): void {
    const binding = receiptId ? this.controlReceiptBindings.get(receiptId) : undefined;
    if (!binding || binding.identityConsumed) return;
    this.assertManagedControlIdentity(binding.expectedIdentity);
    binding.identityConsumed = true;
  }

  private readSdkQueuedMessages(): { steering: unknown[]; followUp: unknown[] } | null {
    const agent = this.inner.agent as unknown as { steeringQueue?: { messages?: unknown }; followUpQueue?: { messages?: unknown } };
    if (!Array.isArray(agent?.steeringQueue?.messages) || !Array.isArray(agent?.followUpQueue?.messages)) return null;
    return { steering: [...agent.steeringQueue.messages], followUp: [...agent.followUpQueue.messages] };
  }

  /** Capture the SDK's actual transformed message at its synchronous enqueue boundary. */
  private installControlQueueCapture(): (() => void) | null {
    const agent = this.inner.agent as unknown as Record<string, unknown>;
    if (!agent || typeof agent.steer !== "function" || typeof agent.followUp !== "function") return null;
    const methods = ["steer", "followUp", "prompt", "continue"] as const;
    const originals = Object.fromEntries(methods.map(method => [method, agent[method]]));
    const wrappers: Partial<Record<typeof methods[number], (...args: unknown[]) => unknown>> = {};
    const restore = () => {
      for (const method of methods) {
        if (agent[method] === wrappers[method]) agent[method] = originals[method];
      }
    };
    try {
      for (const method of methods) {
        if (typeof originals[method] !== "function") continue;
        const original = originals[method] as (...args: unknown[]) => unknown;
        const wrapper = (...args: unknown[]) => {
          const receiptId = this.controlReceiptAdmissionStorage.getStore();
          const binding = receiptId ? this.controlReceiptBindings.get(receiptId) : undefined;
          this.consumeManagedControlIdentity(receiptId);
          const client = this.clientMessageAdmission.getStore();
          const candidates = Array.isArray(args[0]) ? args[0] : [args[0]];
          const user = candidates.find(value => value && typeof value === "object" && value.role === "user");
          if (user) this.initializeUnattendedDefault();
          if (client && !client.claimed && user) { this.clientMessageObjects.set(user, client.id); client.claimed = true; }
          const result = original.apply(agent, args);
          const message = args[0] as { role?: unknown; content?: unknown } | undefined;
          const peerMessage = isSessionPeerAgentMessage(message) ? message : undefined;
          if (["steer", "followUp"].includes(method) && binding?.phase === "admitting"
            && (message?.role === "user" || (peerMessage && binding.peerMessageId === peerMessage.details.messageId))) {
            // Async context outlives initial admission; extension messages
            // during the running turn must never overwrite this association.
            binding.phase = "queued";
            binding.queueKind = method === "steer" ? "steering" : "followUp";
            binding.queueMessage = peerMessage ? peerMessage.details.messageId : messageTextFor(message?.content);
            binding.sdkMessage = args[0];
          }
          if (peerMessage && (method === "steer" || method === "followUp")) {
            // Associate the managed receipt before marking the native message
            // accepted; that mark may advance the receipt to queued.
            this.markNativePeerQueued(peerMessage, method === "steer" ? "steer" : "follow_up");
          }
          return result;
        };
        wrappers[method] = wrapper;
        agent[method] = wrapper;
        if (agent[method] !== wrapper) throw new Error("SDK queue capture is unavailable");
      }
      return restore;
    } catch {
      restore();
      return null;
    }
  }

  releaseControlReceiptBinding(receiptId: string): void {
    const pending = this.controlReceiptBindings.get(receiptId)?.terminalReceipt;
    if (pending?.retryTimer) clearTimeout(pending.retryTimer);
    this.controlReceiptBindings.delete(receiptId);
    this.notifyDestroyedAfterReceiptPersistence();
  }

  /** A rejected send cannot leave a non-admitted request blocking the queue. */
  releaseRejectedControlReceiptBinding(receiptId: string, admissionKnownAbsent = false): boolean {
    const binding = this.controlReceiptBindings.get(receiptId);
    if (!binding || binding.terminalReceipt || binding.phase === "queued") return false;
    if (!admissionKnownAbsent && (binding.runId || binding.sdkMessage
      || (binding.phase !== "admitting" && binding.phase !== "starting"))) return false;
    this.releaseControlReceiptBinding(receiptId);
    return true;
  }

  hasControlReceiptLifecycleBinding(receiptId: string): boolean {
    return this.controlReceiptBindings.has(receiptId);
  }

  /** Retain the existing lifecycle binding until its known terminal fact is durable. */
  private persistTerminalControlReceipt(receiptId: string, update: Parameters<typeof updateControlReceipt>[1]): Promise<boolean> {
    const binding = this.controlReceiptBindings.get(receiptId);
    if (!binding) return Promise.resolve(false);
    // A later destroy/next run cannot replace a terminal fact whose disk write
    // is still pending. Retries write this same fact, never another command.
    const pending = binding.terminalReceipt ??= { update, writing: false, retryMs: 250 };
    if (pending.writing || pending.retryTimer) return pending.attempt ?? Promise.resolve(false);
    pending.writing = true;
    pending.attempt = updateControlReceipt(receiptId, pending.update).then((receipt) => {
      if (!receipt) throw new Error("Control receipt disappeared before terminal persistence");
      if (this.controlReceiptBindings.get(receiptId) === binding) this.controlReceiptBindings.delete(receiptId);
      this.notifyDestroyedAfterReceiptPersistence();
      return true;
    }).catch(() => {
      if (this.controlReceiptBindings.get(receiptId) !== binding) return false;
      pending.retryTimer = setTimeout(() => {
        pending.retryTimer = undefined;
        this.persistTerminalControlReceipt(receiptId, pending.update);
      }, pending.retryMs);
      pending.retryTimer.unref();
      pending.retryMs = Math.min(30_000, pending.retryMs * 2);
      return false;
    }).finally(() => { pending.writing = false; pending.attempt = undefined; });
    return pending.attempt;
  }

  hasPendingControlReceiptPersistence(receiptId?: string): boolean {
    return receiptId === undefined
      ? [...this.controlReceiptBindings.values()].some((binding) => binding.terminalReceipt !== undefined)
        || [...this.nativePeerSubmissions.values()].some((submission) => submission.receiverOutcome !== undefined)
      : this.controlReceiptBindings.get(receiptId)?.terminalReceipt !== undefined;
  }

  private notifyDestroyedAfterReceiptPersistence(): void {
    if (!this.disposed || this.destroyCallbackInvoked || this.controlReceiptBindings.size > 0 || this.nativePeerSubmissions.size > 0) return;
    this.destroyCallbackInvoked = true;
    this.onDestroyCallback?.();
    notifyRunningChange();
  }

  private markControlReceiptAdmission(command: Record<string, unknown>, disposition: "handled" | "queued" | "started"): void {
    const receiptId = typeof command.readerControlReceiptId === "string" ? command.readerControlReceiptId : "";
    const binding = this.controlReceiptBindings.get(receiptId);
    if (!binding) return;
    if (disposition === "handled") {
      this.persistTerminalControlReceipt(receiptId, { outcome: "completed", completedAt: new Date().toISOString(), nextAction: "none" });
    } else if (disposition === "queued") {
      // The synchronous SDK enqueue boundary already captured this exact
      // message. A delayed callback must not revert a consumed receipt.
      if (binding.phase === "admitting") binding.phase = "queued";
    } else {
      binding.phase = this.currentRunId ? "running" : "starting";
      binding.runId = this.currentRunId;
    }
  }

  private markQueuedControlConsumed(message: unknown): void {
    for (const binding of this.controlReceiptBindings.values()) {
      if (binding.phase !== "queued" || binding.sdkMessage !== message) continue;
      binding.phase = "running";
      binding.runId = this.currentRunId;
      delete binding.queueMessage;
      delete binding.queueKind;
      delete binding.sdkMessage;
      break;
    }
  }

  private resolveNativePeerSubmission(submission: NativePeerSubmission): void {
    if (submission.accepted) return;
    const wasQueued = submission.phase === "queued";
    submission.accepted = true;
    if (submission.admissionTimer) clearTimeout(submission.admissionTimer);
    if (submission.phase === "admitting" || wasQueued) submission.phase = "accepted";
    submission.resolveAccepted();
    if (submission.readerControlReceiptId) {
      this.markControlReceiptAdmission(
        { readerControlReceiptId: submission.readerControlReceiptId },
        wasQueued ? "queued" : submission.triggerTurn ? "started" : "handled",
      );
    }
  }

  private rejectNativePeerSubmission(submission: NativePeerSubmission, error: unknown): void {
    if (submission.accepted) return;
    if (submission.admissionTimer) clearTimeout(submission.admissionTimer);
    submission.rejectAccepted(error);
    this.nativePeerSubmissions.delete(submission.message.details.messageId);
    if (submission.readerControlReceiptId) {
      this.releaseRejectedControlReceiptBinding(submission.readerControlReceiptId, true);
    }
  }

  /** Match only the exact custom object emitted by this native peer submission. */
  private markNativePeerQueued(message: SessionPeerMessage, delivery: "steer" | "follow_up"): void {
    const submission = this.nativePeerSubmissions.get(message.details.messageId);
    if (!submission || submission.phase !== "admitting" || !this.sameNativePeerMessage(submission.message, message)) return;
    submission.phase = "queued";
    submission.delivery = delivery;
    submission.sdkMessage = message;
    this.resolveNativePeerSubmission(submission);
  }

  private markNativePeerStarted(message: SessionPeerMessage): void {
    const submission = this.nativePeerSubmissions.get(message.details.messageId);
    if (!submission || !this.sameNativePeerMessage(submission.message, message)) return;
    submission.phase = "running";
    submission.runId = this.currentRunId;
    if (submission.readerControlReceiptId) {
      const binding = this.controlReceiptBindings.get(submission.readerControlReceiptId);
      if (binding?.peerMessageId === message.details.messageId) {
        binding.phase = "running";
        binding.runId = this.currentRunId;
        delete binding.queueMessage;
        delete binding.queueKind;
        delete binding.sdkMessage;
      }
    }
    this.resolveNativePeerSubmission(submission);
  }

  private markNativePeerEnded(message: SessionPeerMessage): void {
    const submission = this.nativePeerSubmissions.get(message.details.messageId);
    if (!submission || !this.sameNativePeerMessage(submission.message, message)) return;
    this.resolveNativePeerSubmission(submission);
    if (!submission.receiverOutcome) this.nativePeerSubmissions.delete(message.details.messageId);
  }

  private settleNativePeerRun(runId: string | null): void {
    if (!runId) return;
    for (const submission of this.nativePeerSubmissions.values()) {
      if (submission.runId !== runId) continue;
      if (!submission.accepted) {
        this.rejectNativePeerSubmission(submission, new Error("Native peer message run settled before the custom message was accepted"));
      } else if (!submission.receiverOutcome) {
        this.nativePeerSubmissions.delete(submission.message.details.messageId);
      }
    }
  }

  private persistNativePeerOutcome(submission: NativePeerSubmission, status: "cleared" | "failed", note: string): boolean {
    const outcome = submission.receiverOutcome ??= { status, note, retryMs: 250 };
    if (outcome.timer) clearTimeout(outcome.timer);
    try {
      if (submission.sessionMessageRoot) {
        recordSessionMessageOutcome(submission.sessionMessageRoot, submission.message.details.messageId, outcome.status, outcome.note);
      }
      this.nativePeerSubmissions.delete(submission.message.details.messageId);
      this.notifyDestroyedAfterReceiptPersistence();
      return true;
    } catch {
      // Retry this observed receipt only; never repeat the message/model effect.
      outcome.timer = setTimeout(() => { this.persistNativePeerOutcome(submission, outcome.status, outcome.note); }, outcome.retryMs);
      outcome.timer.unref();
      outcome.retryMs = Math.min(30_000, outcome.retryMs * 2);
      return false;
    }
  }

  private settleClearedNativePeerSubmissions(
    deferred: DeferredCompactionPrompt[],
    clearedSdkMessages?: Set<unknown>,
  ): void {
    const deferredIds = new Set(deferred.filter((item): item is DeferredPeerPrompt => item.kind === "peer").map((item) => item.submissionId));
    let pendingPersistence = false;
    for (const submission of this.nativePeerSubmissions.values()) {
      if (!["admitting", "queued", "accepted"].includes(submission.phase)) continue;
      if (!deferredIds.has(submission.message.details.messageId)
        && !(submission.sdkMessage && clearedSdkMessages?.has(submission.sdkMessage))) continue;
      if (submission.accepted) {
        pendingPersistence = !this.persistNativePeerOutcome(submission, "cleared", "receiver queue was cleared before the peer message was consumed") || pendingPersistence;
      } else {
        this.rejectNativePeerSubmission(submission, new Error("Queued native peer message was removed by clear_queue"));
      }
    }
    if (pendingPersistence) throw new Error("Native peer queue was cleared but its receipt persistence is pending; inspect the original message");
  }

  private sameNativePeerMessage(expected: SessionPeerMessage, actual: SessionPeerMessage): boolean {
    return isSessionPeerMessage(expected)
      && isSessionPeerMessage(actual)
      && expected.customType === actual.customType
      && expected.content === actual.content
      && expected.display === actual.display
      && JSON.stringify(expected.details) === JSON.stringify(actual.details);
  }

  private async dispatchNativePeerSubmission(submission: NativePeerSubmission, deferredPrompt?: DeferredCompactionPrompt): Promise<void> {
    const send = () => this.inner.sendCustomMessage!(submission.message, {
      triggerTurn: submission.triggerTurn,
      ...(submission.delivery ? { deliverAs: submission.delivery === "follow_up" ? "followUp" : "steer" } : {}),
    });
    try {
      const inputSignal = await this.prepareInputRuntime(submission.stopVersion);
      await this.prepareMcpForInput("", inputSignal);
      this.assertInputPreparationActive(inputSignal);
      this.assertNativePeerRuntimeAdmission(submission, submission.stopVersion);
      if (submission.beforeSubmit && !submission.beforeSubmit()) throw new Error("notification_no_longer_pending");
      if (deferredPrompt) {
        if (!this.deferredCompactionPrompts.includes(deferredPrompt)) return;
        this.submittingDeferredPrompts.add(deferredPrompt);
      }
      this.consumeManagedControlIdentity(submission.readerControlReceiptId);
      const result = submission.readerControlReceiptId
        ? this.controlReceiptAdmissionStorage.run(submission.readerControlReceiptId, send)
        : send();
      const completion = Promise.resolve(result);
      void completion.then(() => {
        if (typeof this.inner.subscribe !== "function") {
          this.resolveNativePeerSubmission(submission);
        }
        // The SDK resolves a settled-turn call after placing it in its
        // private deferred list. That is not admission. Acceptance is granted
        // only by the exact queue capture or exact custom message_start path.
      }, (error) => {
        if (submission.accepted) {
          this.persistNativePeerOutcome(submission, "failed", error instanceof Error ? error.message : String(error));
        } else {
          this.rejectNativePeerSubmission(submission, error);
        }
      });
    } catch (error) {
      this.rejectNativePeerSubmission(submission, error);
    }
  }

  /**
   * Admit and submit one peer message through the SDK custom-message API.
   * Human prompts continue through send()/promptWithDisplayTracking(); this
   * method is the sole native peer transport for session-control and wake.
   */
  async sendNativePeerMessage(
    message: SessionPeerMessage,
    options: {
      delivery?: "steer" | "follow_up";
      triggerTurn?: boolean;
      readerControlReceiptId?: string;
      sessionMessageRoot?: string;
      deferCompactionQueue?: boolean;
      beforeSubmit?: () => boolean;
      inputGeneration?: number;
    } = {},
  ): Promise<void> {
    const stopVersion = options.inputGeneration ?? this.inputStopGeneration;
    if (this.stopAllPromise) throw new Error("Session execution is stopping");
    if (!isSessionPeerMessage(message)) {
      throw new Error("invalid native peer message");
    }
    if (typeof this.inner.sendCustomMessage !== "function") {
      throw new Error("Native custom peer delivery is unavailable in the loaded SDK");
    }
    if (this.managedSettingPending) throw Object.assign(new Error("A managed live setting is pending"), { code: "runtime_busy" });
    if (this.treeNavigationPending) throw new Error(BRANCH_NAVIGATION_PENDING);
    this.assertWriteOpen();
    this.resetIdleTimer();
    if (this.shouldWaitForExtensions("prompt")) await this.waitForExtensionsBound();
    this.assertInputGeneration(stopVersion);

    const existing = this.nativePeerSubmissions.get(message.details.messageId);
    if (existing) {
      if (!this.sameNativePeerMessage(existing.message, message)) {
        throw new Error("native peer messageId was already admitted with different content");
      }
      await existing.acceptedPromise;
      return;
    }

    const releaseAdmission = await this.acquirePromptAdmission();
    let submission: NativePeerSubmission | undefined;
    try {
      // Stop All blocks the old work, not a later explicit input. Clear the
      // latch only after admission so a message racing with Stop cannot revive
      // the previous generation or change the stopped custom-message mode.
      this.assertInputGeneration(stopVersion);
      this.stopAllRequested = false;
      this.assertWriteOpen();
      if (this.treeNavigationPending) throw new Error(BRANCH_NAVIGATION_PENDING);
      if (this.hasPendingUserInteraction()) throw new Error("Cannot send a peer message while user interaction is pending");
      if (this.inner.isBashRunning) throw new Error("Cannot send a peer message while a shell command is running");
      this.assertNativePeerRuntimeAdmission(options, stopVersion);
      if (options.readerControlReceiptId) {
        const binding = this.controlReceiptBindings.get(options.readerControlReceiptId);
        if (!binding) throw new Error("Reader control receipt binding is unavailable");
        binding.peerMessageId = message.details.messageId;
        this.assertManagedControlIdentity(binding.expectedIdentity);
      }

      let resolveAccepted!: () => void;
      let rejectAccepted!: (error: unknown) => void;
      const acceptedPromise = new Promise<void>((resolve, reject) => {
        resolveAccepted = resolve;
        rejectAccepted = reject;
      });
      void acceptedPromise.catch(() => {});
      submission = {
        message,
        stopVersion,
        beforeSubmit: options.beforeSubmit,
        delivery: options.delivery,
        triggerTurn: options.triggerTurn !== false,
        readerControlReceiptId: options.readerControlReceiptId,
        sessionMessageRoot: options.sessionMessageRoot,
        phase: "admitting",
        accepted: false,
        resolveAccepted,
        rejectAccepted,
        acceptedPromise,
      };
      this.nativePeerSubmissions.set(message.details.messageId, submission);
      const pendingSubmission = submission;
      submission.admissionTimer = setTimeout(() => {
        this.rejectNativePeerSubmission(pendingSubmission, new Error("Native peer admission outcome is unknown; inspect the original receipt and session before retrying"));
      }, 30_000);
      submission.admissionTimer.unref();

      if (!this.inner.isCompacting && this.schedulerState) this.clearScheduler("manual");
      if (!this.inner.isStreaming && !this.promptRunning && !this.currentRunId && !this.inner.isCompacting) {
        this.abortRequested = false;
      }
      if (this.inner.isCompacting && options.deferCompactionQueue !== true) {
        this.deferredCompactionPrompts.push({
          kind: "peer",
          submissionId: message.details.messageId,
          message,
          ...(options.delivery ? { delivery: options.delivery } : {}),
        });
        if (options.readerControlReceiptId) {
          const binding = this.controlReceiptBindings.get(options.readerControlReceiptId);
          if (binding) {
            binding.phase = "queued";
            binding.queueKind = options.delivery === "steer" ? "steering" : "followUp";
            binding.queueMessage = message.details.messageId;
          }
        }
        this.emitQueueUpdate();
      } else {
        this.assertNativePeerRuntimeAdmission(options, stopVersion);
        await this.dispatchNativePeerSubmission(submission);
      }
    } catch (error) {
      if (submission) this.rejectNativePeerSubmission(submission, error);
      throw error;
    } finally {
      releaseAdmission();
    }
    await submission!.acceptedPromise;
  }

  /**
   * Remove one accepted follow-up before the SDK consumes it.
   *
   * This is deliberately narrower than clear_queue: it only accepts an exact
   * message identity captured at the SDK enqueue boundary, performs an
   * optional queue-revision CAS, and never aborts the active run.
   */
  async retractFollowUp(
    messageId: string,
    options: { sessionMessageRoot?: string; expectedQueueRevision?: string } = {},
  ): Promise<{ retracted: true; receiverStatus: "cleared"; previousQueueRevision: string; queueRevision: string }> {
    this.assertWriteOpen();
    if (!messageId || messageId.trim() !== messageId) throw new Error("invalid follow_up messageId");

    const previousQueue = this.getQueueIdentity();
    if (options.expectedQueueRevision !== undefined && options.expectedQueueRevision !== previousQueue.revision) {
      throw Object.assign(new Error("Reader queue revision changed"), {
        code: "queue_revision_conflict",
        queueRevision: previousQueue.revision,
      });
    }

    const submission = this.nativePeerSubmissions.get(messageId);
    if (!submission || submission.delivery !== "follow_up") {
      throw Object.assign(new Error("follow_up is no longer retractable in this live runtime"), { code: "follow_up_not_found" });
    }
    if (!submission.accepted || !["queued", "accepted"].includes(submission.phase)) {
      throw Object.assign(new Error("follow_up has already started or has no accepted queue boundary"), { code: "follow_up_started" });
    }

    const agent = this.inner.agent as unknown as { followUpQueue?: { messages?: unknown[] } };
    const queue = agent.followUpQueue?.messages;
    const index = Array.isArray(queue) && submission.sdkMessage !== undefined
      ? queue.indexOf(submission.sdkMessage)
      : -1;
    if (!queue || index < 0) {
      throw Object.assign(new Error("follow_up has already started or was already cleared"), { code: "follow_up_started" });
    }

    if (options.sessionMessageRoot && !submission.sessionMessageRoot) submission.sessionMessageRoot = options.sessionMessageRoot;
    // No await between the CAS check and this exact-object removal: the agent
    // loop cannot observe a half-mutated queue through an interleaved turn.
    if (this.queueIdentityTracker) {
      if (!this.queueIdentityTracker.removeExact("followUp", submission.sdkMessage)) throw new Error("Queued peer message was already consumed");
    } else queue.splice(index, 1);
    this.emitQueueUpdate();
    const queueRevision = this.getQueueIdentity().revision;
    const persisted = this.persistNativePeerOutcome(
      submission,
      "cleared",
      "follow_up was retracted before the peer message was consumed",
    );
    if (!persisted) {
      throw Object.assign(new Error("follow_up was removed but its cleared receipt is still being persisted; inspect message_status"), {
        code: "message_outcome_persistence_pending",
      });
    }
    if (submission.readerControlReceiptId) {
      const controlPersisted = await this.persistTerminalControlReceipt(submission.readerControlReceiptId, {
        outcome: "aborted",
        completedAt: new Date().toISOString(),
        bootId: this.liveEventBootId,
        nextAction: "none",
        error: { code: "follow_up_retracted", message: "follow_up was retracted before execution" },
        targetStopped: false,
      });
      if (!controlPersisted) throw new Error("follow_up was removed but its control receipt is still being persisted");
    }
    return { retracted: true, receiverStatus: "cleared", previousQueueRevision: previousQueue.revision, queueRevision };
  }

  private assertNativePeerRuntimeAdmission(options: { delivery?: "steer" | "follow_up"; triggerTurn?: boolean }, stopVersion: number): void {
    this.assertWriteOpen();
    if (stopVersion !== this.inputStopGeneration) throw new Error("Native peer submission was superseded by Stop");
    if (this.hasPendingUserInteraction() || this.inner.isBashRunning) throw Object.assign(new Error("User interaction or shell command is pending"), { code: "runtime_busy" });
    if (this.hasPendingSettingsMutation()) throw Object.assign(new Error("A managed live setting is pending"), { code: "runtime_busy" });
    if (this.treeNavigationPending) throw new Error(BRANCH_NAVIGATION_PENDING);
    if (this.abortRequested && (this.inner.isStreaming || this.promptRunning || this.currentRunId || this.inner.isCompacting)) {
      throw Object.assign(new Error("Agent abort is still in progress"), { code: "runtime_busy" });
    }
    // An old peer prompt must never fall through to the SDK's default steer
    // behavior. Queueing is explicit through follow_up/steer; human prompts
    // retain their existing priority path.
    if (options.triggerTurn !== false && this.inner.isStreaming && !options.delivery) {
      throw Object.assign(new Error("Cannot send a peer prompt while the agent is running; use follow_up or steer"), { code: "runtime_busy" });
    }
  }

  private settleBoundControlReceipts(
    outcome: "completed" | "failed" | "aborted" | "unknown",
    error?: string,
  ): void {
    const runId = this.currentRunId;
    for (const [receiptId, binding] of this.controlReceiptBindings) {
      if (outcome !== "unknown" && (binding.runId !== runId || binding.phase !== "running")) continue;
      const now = new Date().toISOString();
      this.persistTerminalControlReceipt(receiptId, {
        outcome,
        completedAt: now,
        runId: runId ?? undefined,
        bootId: this.liveEventBootId,
        nextAction: outcome === "completed" ? "none" : "inspect_runtime_and_retry_by_policy",
        ...(error ? { error: { code: outcome === "aborted" ? "aborted" : "runtime_failed", message: error } } : {}),
        targetStopped: outcome === "aborted" ? true : false,
      });
    }
  }

  private captureQueueRecallSettlements(sdkMessages: Set<unknown>): QueueRecallSettlement[] {
    const deferredIds = new Set(this.deferredCompactionPrompts.map(prompt => prompt.kind === "prompt" ? prompt.readerControlReceiptId : undefined).filter(Boolean));
    return [...this.controlReceiptBindings].filter(([receiptId, binding]) => binding.phase === "queued"
      && (binding.sdkMessage ? sdkMessages.has(binding.sdkMessage) : deferredIds.has(receiptId)))
      .map(([receiptId]) => ({ receiptId, update: {
        outcome: "aborted", completedAt: new Date().toISOString(), bootId: this.liveEventBootId,
        nextAction: "inspect_runtime_before_retry", targetStopped: false,
        error: { code: "queued_control_cleared", message: "Queued control was removed by clear_queue" },
      } }));
  }

  private async settleQueueRecall(operationId: string, identity: QueueRecallIdentity): Promise<void> {
    const ids = await settleQueueRecallReceipts(this.sessionId, operationId, identity, settlements => {
      // A later destroy must retain this already-committed terminal fact even
      // if the receipt store is temporarily unavailable.
      for (const { receiptId, update } of settlements) {
        const binding = this.controlReceiptBindings.get(receiptId);
        if (binding) binding.terminalReceipt ??= { update, writing: false, retryMs: 250 };
      }
    });
    for (const id of ids) this.releaseControlReceiptBinding(id);
  }

  private async settleQueuedControlReceipts(
    error: string,
    cleared?: { steering: string[]; followUp: string[] },
    clearedSdkMessages?: Set<unknown>,
    clearedPeerMessageIds?: Set<string>,
  ): Promise<void> {
    const remaining = cleared ? { steering: [...cleared.steering], followUp: [...cleared.followUp] } : null;
    const removed: Array<[string, { operation: string; runId: string | null }]> = [];
    for (const [receiptId, binding] of this.controlReceiptBindings) {
      if (binding.phase !== "queued") continue;
      const peerCleared = Boolean(binding.peerMessageId && clearedPeerMessageIds?.has(binding.peerMessageId));
      // Core may already have drained a message while the SDK text mirror
      // still contains it. clearAllQueues cannot revoke that in-flight item.
      if (!peerCleared && clearedSdkMessages && binding.sdkMessage && !clearedSdkMessages.has(binding.sdkMessage)) continue;
      if (remaining && !peerCleared) {
        if (!binding.queueKind || binding.queueMessage === undefined) continue;
        const index = remaining[binding.queueKind].findIndex((message) => messageTextFor(message) === binding.queueMessage);
        if (index < 0) continue;
        remaining[binding.queueKind].splice(index, 1);
      }
      removed.push([receiptId, binding]);
    }
    // Freeze the removed set before the first disk await. Later admissions
    // cannot be included just because they reuse a cleared message's text.
    const persisted = await Promise.all(removed.map(([receiptId]) =>
      this.persistTerminalControlReceipt(receiptId, {
        outcome: "aborted",
        completedAt: new Date().toISOString(),
        bootId: this.liveEventBootId,
        nextAction: "inspect_runtime_before_retry",
        error: { code: "queued_control_cleared", message: error },
        targetStopped: false,
      })));
    if (persisted.some((value) => !value)) throw new Error("Cleared queue receipt persistence is pending; inspect the original receipts before retrying");
  }

  get isStreaming(): boolean {
    return this.inner.isStreaming;
  }

  get isPromptRunning(): boolean {
    return this._alive && (this.promptRunning || this.pendingPromptCount > 0);
  }

  isRetryInFlight(): boolean {
    return this._alive && this.promptRunning;
  }

  isUserPromptActive(): boolean {
    return this._alive && (this.promptAdmissionCount > 0 || this.pendingPromptCount > 0 || (this.inner.isStreaming && !this.promptRunning));
  }

  isAlive(): boolean {
    return this._alive;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Wait until teardown has released the SDK runtime, when a caller needs a replacement. */
  async waitUntilDisposed(): Promise<boolean> {
    if (this.disposed) return true;
    if (!this.shutdownPromise) return false;
    await this.shutdownPromise;
    return this.disposed;
  }

  getContextUsage(): ContextUsage | null {
    if (!this._alive || this.shuttingDown) return null;
    const usage = this.inner.getContextUsage();
    return usage
      ? { percent: usage.percent, contextWindow: usage.contextWindow, tokens: usage.tokens }
      : null;
  }

  async refreshModelConfig(): Promise<boolean> {
    const previous = this.modelConfigRefreshPromise;
    const refresh: Promise<boolean> = (previous ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (!this._alive || this.shuttingDown) return false;
      await this.inner.modelRuntime.refresh({ allowNetwork: false });
      if (!this._alive || this.shuttingDown) return false;

      const current = this.inner.model;
      const refreshed = current
        ? this.inner.modelRuntime.getModel(current.provider, current.id)
        : undefined;
      if (!refreshed || !this.inner.agent.state) return false;
      const latest = this.inner.model;
      if (!latest || latest.provider !== current?.provider || latest.id !== current?.id) return false;
      const changed = current !== refreshed;
      this.inner.agent.state.model = refreshed;
      return changed;
    });
    const queued = refresh.then(() => undefined, () => undefined);
    this.modelConfigRefreshPromise = queued;
    try {
      return await refresh;
    } finally {
      if (this.modelConfigRefreshPromise === queued) this.modelConfigRefreshPromise = null;
    }
  }

  getModelsConfigMtime(): number {
    try {
      const configPath = resolve(getAgentDir(), "models.json");
      return statSync(configPath).mtimeMs;
    } catch {
      return 0;
    }
  }

  async syncModelConfigIfStale(): Promise<boolean> {
    const currentMtime = this.getModelsConfigMtime();
    if (currentMtime <= 0) return false;
    if (this.lastObservedModelsMtime === 0) {
      this.lastObservedModelsMtime = currentMtime;
      return false;
    }
    if (currentMtime > this.lastObservedModelsMtime) {
      const refreshed = await this.refreshModelConfig();
      this.lastObservedModelsMtime = currentMtime;
      return refreshed;
    }
    return false;
  }

  assertSessionWriteAllowed(): void {
    assertSessionFileExecutable(this.sessionFile);
    if (this.sideAskWriteFailed) throw new Error("Session persistence failed; reopen the session before writing again");
    if (!this._alive) throw new Error("Session is no longer available");
    if (this.shuttingDown) throw new Error("Session is shutting down");
  }

  private assertWriteOpen(): void {
    this.assertSessionWriteAllowed();
  }

  hasPendingSettingsMutation(): boolean {
    // Observe only; never initialize a lock map from a read-only snapshot.
    return this.managedSettingPending || globalThis.__piToolMutationLocks?.has(this.sessionId) === true;
  }

  /** Reader's queue owns writes before and after the SDK prompt, including queued cancellation. */
  admitSubagentExecution(completion: Promise<unknown>, cancel: () => void): void {
    this.assertWriteOpen();
    if (this.subagentExecution) throw new Error("Subagent is already running");
    const releaseLiveness = registerSessionLivenessProvider({
      name: "pi-web-subagent-execution", sessionId: this.sessionId, sessionFile: this.sessionFile,
      isActive: () => true,
    });
    const execution = { completion, cancel };
    this.subagentExecution = execution;
    const settled = () => {
      releaseLiveness();
      if (this.subagentExecution !== execution) return;
      this.subagentExecution = undefined;
      this.resetIdleTimer();
    };
    void completion.then(settled, settled);
  }

  isRunning(): boolean {
    // Runtime ownership comes from the SDK and Reader's already-durable work
    // queues. UI attachment or lifecycle observation must not affect it.
    return this._alive && (this.bashExecution !== undefined || this.managedSettingPending || (this.schedulerState?.active === true && !this.unattendedResumeRequired) || this.promptAdmissionCount > 0 || this.pendingPromptCount > 0 || this.questionAnalysisJobs.size > 0 || this.promptRunning || this.deferredCompactionPrompts.length > 0 || this.mcpPromptWait !== null || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning);
  }

  isStopRequested(): boolean { return this.abortRequested || this.stopAllRequested; }

  getExecutionState() {
    return sessionExecutionState({
      parentActive: this.isPromptRunning || this.inner.isStreaming || this.inner.isBashRunning || this.inner.isCompacting
        || this.questionAnalysisJobs.size > 0 || this.questionTaskControllers.size > 0 || this.promptAdmissionCount > 0 || this.mcpPromptWait !== null,
      retrying: !this.inner.isStreaming && (this.isRetryInFlight() || this.getSchedulerState()?.active === true),
      unattended: this.unattendedEnabled,
      backgroundRunIds: [...new Set([
        ...getSessionBackgroundRunIds({ id: this.sessionId, path: this.sessionFile }),
        ...activeSubagentIdsForParent(this.sessionId),
      ])],
      queuedCount: this.getQueueIdentity().counts.total,
    });
  }

  stopAllExecution(): ReturnType<typeof stopSessionExecution> {
    if (this.stopAllPromise) return this.stopAllPromise;
    this.stopAllRequested = true;
    this.stopAllPromise = stopSessionExecution({
      snapshot: () => this.getExecutionState(),
      stopParent: async () => {
        this.setUnattendedEnabled(false);
        for (const controller of this.questionTaskControllers) controller.abort();
        this.inner.abortBash?.();
        this.inner.abortCompaction?.();
        await this.send({ type: "abort" });
      },
      stopBackground: async (runId) => {
        if (activeSubagentIdsForParent(this.sessionId).includes(runId)) {
          await SUBAGENT_CONTROLLER.abort(runId, this.inner as never);
          const child = getRpcSession(runId);
          if (child?.isAlive()) {
            const result = await child.stopAllExecution();
            if (!result.stopped) throw new Error(`Child execution did not stop: ${runId}`);
          }
        } else {
          await this.waitForExtensionsBound();
          if (!this.stopBackgroundRun) throw new Error("Background stop protocol unavailable");
          await this.stopBackgroundRun(runId);
        }
      },
    }).finally(() => { this.stopAllPromise = null; notifyRunningChange(); });
    return this.stopAllPromise;
  }

  /** Evict an idle runtime when another pi process appended unseen session data. */
  evictIfDiskAhead(): boolean {
    if (!this.isAlive() || this.isRunning()) return false;
    const diskLatestId = readLatestSessionEntryId(this.sessionFile);
    if (!diskLatestId || this.inner.sessionManager.getEntry(diskLatestId)) return false;
    if (this.isRunning()) return false;
    this.destroy();
    invalidateSessionListCache();
    return true;
  }

  /** Initialize an explicit new conversation or input without resuming its old error tail. */
  initializeUnattendedDefault(enabled = true): void {
    if (this.unattendedConfigured) return;
    this.unattendedEnabled = enabled;
    this.unattendedConfigured = true;
    this.persistUnattendedState();
    this.emit({ type: "unattended_state", state: this.getSchedulerState(), enabled });
  }

  setUnattendedEnabled(enabled: boolean): void {
    this.unattendedEnabled = enabled;
    this.unattendedConfigured = true;
    if (enabled) { this.abortRequested = false; this.stopAllRequested = false; }
    this.persistUnattendedState();
    if (!enabled) {
      this.clearScheduler("manual");
      return;
    }
    // A session can error while the user is away; re-evaluate now so the
    // scheduler picks it up immediately and emits the current state.
    this.evaluateUnattended();
  }

  private getPersistedSchedulerState(): SchedulerState | null {
    const state = this.schedulerState;
    if (!state) return null;
    if (!state.active || typeof state.nextRetryAt !== "number") return { ...state };
    return {
      ...state,
      nextDelayMs: Math.max(0, state.nextRetryAt - Date.now()),
    };
  }

  getSchedulerState(): SchedulerState | null {
    const state = this.getPersistedSchedulerState();
    if (!state) return null;
    if (this.unattendedResumeRequired && state.active) {
      return {
        ...state,
        active: false,
        reason: "restart",
        nextDelayMs: null,
        nextRetryAt: null,
      };
    }
    return state;
  }

  /** Load persisted preference; a pending retry from another process waits for confirmation. */
  restoreUnattendedState(snapshot: PersistedUnattendedState | null): void {
    if (!snapshot) return;
    this.unattendedConfigured = true;
    this.unattendedEnabled = snapshot.enabled;
    const savedSchedulerState = snapshot.schedulerState;
    this.schedulerState = snapshot.enabled && savedSchedulerState
      && (savedSchedulerState.active || savedSchedulerState.reason === "limit")
      ? { ...savedSchedulerState }
      : null;
    this.unattendedResumeRequired = Boolean(this.schedulerState?.active);
    // A persisted retry is deliberately paused after process restart. A
    // persisted limit remains terminal until the user clears it or manually
    // retries. A session without either keeps the old behavior: inspect its
    // current tail and arm a new retry when unattended mode is enabled.
    if (!this.unattendedEnabled) return;
    if (this.unattendedResumeRequired) return;
    this.evaluateUnattended();
    if (this.schedulerState?.active && !this.schedulerTimer) this.armSchedulerTimer(this.schedulerState);
  }

  getUnattendedConfigured(): boolean {
    return this.unattendedConfigured;
  }

  getUnattendedEnabled(): boolean {
    return this.unattendedEnabled;
  }

  private persistUnattendedState(): void {
    if (!this.unattendedConfigured) return;
    setPersistedUnattendedState(this.inner.sessionId, this.unattendedEnabled, this.getPersistedSchedulerState());
  }

  private clearScheduler(reason: SchedulerState["reason"] = "canceled"): void {
    void reason;
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    this.unattendedResumeRequired = false;
    this.schedulerState = null;
    this.persistUnattendedState();
    // Always notify so the client drops its running/countdown UI, including
    // the idle case (a real retry just succeeded).
    this.emit({ type: "unattended_state", state: null, enabled: this.unattendedEnabled });
  }

  private async retryWithLifecycle(): Promise<void> {
    if (!this._alive || this.shuttingDown || this.abortRequested) return;
    this.promptRunning = true;
    notifyRunningChange();
    try {
      await this.retryLastFailedTurn();
    } catch (error) {
      if (!this.abortRequested) {
        this.emit({
          type: "prompt_error",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        // Auto-retry failed: keep the unattended loop alive with the next backoff.
        this.scheduleNextBackoff(error instanceof Error ? error.message : String(error));
      }
    } finally {
      this.promptRunning = false;
      this.resetIdleTimer();
      notifyRunningChange();
      // A failed retry emits its terminal error before this point. Re-evaluate
      // after promptRunning drops so the next backoff is scheduled.
      if (!this.abortRequested) {
        this.notifyAgentStateChanged();
      } else {
        this.clearScheduler("manual");
      }
    }
  }

  /**
   * Evaluate the current transcript for unattended auto-continue and schedule
   * the next retry server-side so retries survive navigating away.
   */
  private evaluateUnattended(): void {
    if (!this._alive) return;
    if (!this.unattendedEnabled || this.unattendedResumeRequired || this.promptRunning || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning) {
      return;
    }
    const agentState = this.inner.agent?.state as { messages?: unknown } | undefined;
    const messages = agentState?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;
    const liveAssistant = lastAssistantClassification(messages as Parameters<typeof lastAssistantClassification>[0]);
    if (liveAssistant?.msg.stopReason === "aborted") {
      if (this.schedulerState || this.schedulerTimer) {
        this.clearScheduler("manual");
      }
      return;
    }
    const next = nextSchedulerState(messages, this.schedulerState);
    if (next === null || !next.active) {
      // pi's built-in transient retry strips the failed chain from the live
      // transcript when it exhausts; the failure then survives only in the
      // persisted session file. Fall back to the file tail so a stranded
      // session can still re-arm (e.g. the user re-enables unattended after
      // the storm, or the wrapper restarts) — provided the file ends in a
      // failed assistant error and no newer schedule is pending.
      if (next?.reason !== "limit" && !this.schedulerState?.active) {
        const lastLiveMessage = messages[messages.length - 1] as { role?: string } | undefined;
        const liveTailIsAssistant = lastLiveMessage?.role === "assistant";
        const liveLast = liveTailIsAssistant
          ? lastAssistantClassification(messages as Parameters<typeof lastAssistantClassification>[0])
          : null;
        // Completed real output needs no file fallback; only a missing or
        // non-successful live tail (pi stripped the chain) warrants the read.
        if (!(liveLast && liveLast.kind === "none" && hasRealOutput(liveLast.msg as Parameters<typeof hasRealOutput>[0]))) {
          const fileNext = this.fileTailSchedulerState();
          if (fileNext) {
            const attempt = (this.schedulerState?.key === fileNext.key && typeof this.schedulerState?.attempt === "number")
              ? this.schedulerState.attempt
              : fileNext.attempt;
            const delay = this.consumeModelRoutingRetryDelay(
              nextBackoffDelayMs(attempt - 1, fileNext.key, fileNext.errorMessage),
            );
            const deadline = Date.now() + delay;
            this.schedulerState = {
              ...fileNext,
              attempt,
              nextRetryAt: deadline,
              nextDelayMs: delay,
            };
            this.persistUnattendedState();
            this.emit({ type: "unattended_state", state: this.getSchedulerState(), enabled: this.unattendedEnabled });
            this.armSchedulerTimer(this.schedulerState);
            return;
          }
        }
      }
    }
    const lastLiveMsg = messages[messages.length - 1] as { role?: string } | undefined;
    const liveEndedWithAssistant = lastLiveMsg?.role === "assistant";
    const liveClassification = liveEndedWithAssistant
      ? lastAssistantClassification(messages as Parameters<typeof lastAssistantClassification>[0])
      : null;
    const turnCompletedWithRealOutput = liveClassification?.kind === "none" && hasRealOutput(liveClassification.msg as Parameters<typeof hasRealOutput>[0]);
    if (turnCompletedWithRealOutput) {
      if (this.schedulerState || this.schedulerTimer) {
        this.clearScheduler("idle");
      }
      return;
    }
    if (next === null) {
      return;
    }
    if (!next.active) {
      // 续排（fire 失败后）期间尾部是被剥链的 user 消息（同 key），
      // isManualUserTail 会误判为手动消息；key 未变 = 不是新消息，
      // 保持当前排程，等定时器继续。
      if (next.reason === "manual" && this.schedulerState?.active && next.key === this.schedulerState.key) {
        return;
      }
      this.clearScheduler(next.reason === "idle" ? "idle" : next.reason);
      return;
    }
    // nextSchedulerState already short-circuits on the same error key, so any
    // non-null active result here is a genuinely new error to schedule.
    const delay = this.consumeModelRoutingRetryDelay(next.nextDelayMs ?? 0);
    const deadline = Date.now() + delay;
    this.schedulerState = {
      ...next,
      nextRetryAt: deadline,
      nextDelayMs: delay,
    };
    this.persistUnattendedState();
    this.emit({
      type: "unattended_state",
      state: this.getSchedulerState(),
      enabled: this.unattendedEnabled,
    });
    this.armSchedulerTimer(this.schedulerState);
  }

  /**
   * Classify the persisted session file tail for re-arming. pi's built-in
   * transient retry can strip the failed chain from live agent state when it
   * exhausts, leaving the failure visible only in the file. Returns an armed
   * scheduler state only when the file's LAST message is a failed
   * assistant error — a newer manual user message would end the file instead
   * and must never be auto-retried.
   */
  private fileTailSchedulerState(): SchedulerState | null {
    const sessionFile = this.sessionFile;
    if (!sessionFile) return null;
    try {
      const lines = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
      const messages: Parameters<typeof nextSchedulerState>[0] = [];
      let lastMessage: Parameters<typeof nextSchedulerState>[0][number] | undefined;
      for (let index = lines.length - 1; index >= 0 && messages.length < 100; index -= 1) {
        const entry = JSON.parse(lines[index]) as { type?: string; message?: Parameters<typeof nextSchedulerState>[0][number] } | undefined;
        if (entry?.type !== "message" || !entry.message) continue;
        if (!lastMessage) lastMessage = entry.message;
        messages.unshift(entry.message);
      }
      if (!lastMessage || lastMessage.role !== "assistant" || lastMessage.stopReason !== "error") return null;
      const next = nextSchedulerState(messages, null);
      return next?.active ? next : null;
    } catch {
      return null;
    }
  }


  /** True when the last retry turn actually failed even though the SDK
   * `continue()` did not throw (pi's prepareRetry strips the failed assistant
   * chain from the live transcript, so the run would otherwise settle as
   * "completed" and the client would play the completion sound for a failed
   * unattended retry). The persisted session file is never stripped, so the
   * authoritative signal is the file tail: last real assistant message is an
   * error (stopReason=error or errorMessage). Falls back to the live tail
   * classification for a not-yet-stripped fatal/transient failure. */
  private retryRunFailure(): string | null {
    if (this.abortRequested) return null;
    const agentState = this.inner.agent?.state as { messages?: unknown } | undefined;
    const liveLast = lastAssistantClassification(
      (agentState?.messages ?? []) as Parameters<typeof lastAssistantClassification>[0],
    );
    if (liveLast?.msg.stopReason === "aborted") return null;
    if (liveLast && (liveLast.kind === "transient" || liveLast.kind === "fatal")) {
      return liveLast.msg.errorMessage?.trim() ? liveLast.msg.errorMessage.slice(0, 280) : "auto retry failed";
    }
    const sessionFile = this.sessionFile;
    if (!sessionFile) return null;
    try {
      const lines = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const entry = JSON.parse(lines[index]) as {
          type?: string;
          message?: { role?: string; stopReason?: string; errorMessage?: unknown };
        } | undefined;
        if (entry?.type !== "message" || !entry.message) continue;
        if (entry.message.role === "assistant") {
          if (entry.message.stopReason === "aborted") return null;
          const err = typeof entry.message.errorMessage === "string" ? entry.message.errorMessage.trim() : "";
          if (entry.message.stopReason === "error" || err) {
            return err ? err.slice(0, 280) : "auto retry failed";
          }
          return null;
        }
      }
    } catch {
      // File may be mid-write; rely on the live tail above only.
    }
    return null;
  }

  /** Arm the backoff timer for an active scheduler state. */

  private armSchedulerTimer(state: SchedulerState): void {
    if (this.schedulerTimer) clearTimeout(this.schedulerTimer);
    const delay = state.nextRetryAt != null
      ? Math.max(0, state.nextRetryAt - Date.now())
      : Math.max(0, (state.nextDelayMs ?? 0));
    this.schedulerTimer = setTimeout(() => this.fireScheduler(), delay);
  }

  /** Timer fired: mark in-flight, then retry (or stop). */
  private fireScheduler(): void {
    this.schedulerTimer = null;
    const scheduled = this.schedulerState;
    if (scheduled?.active) {
      // Keep attempt/key while the retry is executing; the next error gets
      // the next backoff instead of restarting at 30 seconds.
      this.schedulerState = {
        ...scheduled,
        active: false,
        nextDelayMs: null,
        nextRetryAt: null,
      };
      this.persistUnattendedState();
    }
    if (this.shuttingDown || !this.unattendedEnabled) {
      this.clearScheduler();
      return;
    }
    if (this.pendingPromptCount > 0) {
      // A new user prompt superseded the pending retry. Never re-arm the
      // stale scheduler while that prompt is entering the agent.
      this.clearScheduler("manual");
      return;
    }
    if (this.promptRunning || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning) {
      // Another run is in flight — typically pi's own built-in transient
      // retry, which loops far faster than this 30s+ backoff. Clearing here
      // would strand the session in failed once that retry exhausts; re-arm
      // the next backoff so this scheduler takes over when the session idles.
      this.scheduleNextBackoff(this.schedulerState?.errorMessage ?? "busy");
      return;
    }
    const agentStateNow = this.inner.agent?.state as { messages?: unknown } | undefined;
    const messagesNow = agentStateNow?.messages;
    if (!Array.isArray(messagesNow)) {
      this.clearScheduler();
      return;
    }
    // 剥链后的续排尾部是没有错误消息的 user/assistant（Agent.continue 失败
    // 不追加消息），shouldAutoRetry 会误判；只在尾部已有真实输出时停止，
    // 其余情况（含剥链续排）继续重试。普通新用户消息在 prompt admission
    // 阶段已清理 scheduler；pending prompt 也在上面的 busy guard 中收口。
    const last = lastAssistantClassification(messagesNow as Parameters<typeof lastAssistantClassification>[0]);
    if (last && (last.msg.stopReason === "aborted" || (last.kind === "none" && hasRealOutput(last.msg as Parameters<typeof hasRealOutput>[0])))) {
      this.clearScheduler(last.msg.stopReason === "aborted" ? "manual" : "idle");
      return;
    }
    void this.retryWithLifecycle();
  }

  /**
   * Continue the backoff after a failed auto-retry. Agent.continue() failures
   * surface as prompt_error without appending an assistant error message, and
   * prepareRetry strips the failed chain — so the transcript tail no longer
   * classifies as transient and evaluateUnattended would drop the scheduler.
   * Schedule the next backoff explicitly from the in-flight state instead.
   */
  private scheduleNextBackoff(errorMessage: string): void {
    if (!this.unattendedEnabled || this.abortRequested) return;
    const agentState = this.inner.agent?.state as { messages?: unknown } | undefined;
    const liveLast = lastAssistantClassification(
      (agentState?.messages ?? []) as Parameters<typeof lastAssistantClassification>[0],
    );
    if (liveLast?.msg.stopReason === "aborted") {
      this.clearScheduler("manual");
      return;
    }
    // The retry chain was fully stripped by previous prepareRetry passes, so
    // there is no anchor turn left to continue from. Degrade to sending a
    // plain "继续" user message (same fallback as manual retry_continue) —
    // its failure appends a fresh error and re-arms the scheduler
    // instead of spinning on an unretryable tail.
    if (/No continue turn is available to retry/.test(errorMessage)) {
      this.promptWithDisplayTracking("继续", { source: "rpc" } as never).catch(() => {});
      return;
    }
    const current = this.schedulerState;
    const attempt = current?.key ? current.attempt : 0;
    if (attempt >= MAX_AUTO_ATTEMPTS) {
      this.schedulerState = {
        active: false,
        reason: "limit",
        attempt,
        nextDelayMs: null,
        nextRetryAt: null,
        errorMessage,
        key: current?.key ?? null,
      };
      this.persistUnattendedState();
      this.emit({ type: "unattended_state", state: this.getSchedulerState(), enabled: this.unattendedEnabled });
      return;
    }
    const defaultDelay = nextBackoffDelayMs(attempt, current?.key ?? errorMessage, errorMessage);
    const delay = this.consumeModelRoutingRetryDelay(defaultDelay);
    this.schedulerState = {
      active: true,
      reason: "error",
      attempt: attempt + 1,
      nextDelayMs: delay,
      nextRetryAt: Date.now() + delay,
      errorMessage,
      key: current?.key ?? null,
    };
    this.persistUnattendedState();
    this.emit({ type: "unattended_state", state: this.getSchedulerState(), enabled: this.unattendedEnabled });
    this.armSchedulerTimer(this.schedulerState);
  }

  /**
   * Recompute the unattended scheduler after any agent state change (end,
   * settled, message) using the current transcript snapshot.
   */
  private notifyAgentStateChanged(): void {
    this.evaluateUnattended();
  }

  private resetModelRoutingCycle(): void {
    this.routingTriedProviders.clear();
    this.routingCurrentProviderRetries = 0;
    this.routingRetryBackoffAttempt = 0;
  }

  private consumeModelRoutingRetryDelay(defaultDelay: number): number {
    const failedAttempt = this.routingRetryBackoffAttempt;
    this.routingRetryBackoffAttempt = 0;
    // A provider may return Retry-After (or another server deadline) in
    // defaultDelay. Route switching adds its own bounded backoff, but must
    // never shorten that provider-requested lower bound.
    return failedAttempt > 0
      ? Math.max(getModelRoutingRetryDelayMs(failedAttempt), defaultDelay)
      : defaultDelay;
  }

  private async tryModelRoutingSwitch(): Promise<boolean> {
    const config = await readModelRoutingConfig();
    if (!config.enabled || !Array.isArray(config.routes) || config.routes.length === 0) {
      return false;
    }
    const currentModel = this.inner.model;
    const currentProvider = currentModel?.provider;
    if (!currentProvider) return false;

    this.routingTriedProviders.add(currentProvider);

    const resolution = resolveNextRoute(
      config,
      currentProvider,
      currentModel.id,
      (this.inner.agent.state?.thinkingLevel as string | undefined) ?? "max",
      this.routingTriedProviders,
      (provider) => {
        const mr = this.inner.modelRuntime as unknown as { getModels?: (p: string) => Array<{ id: string }> };
        const models = typeof mr.getModels === "function" ? mr.getModels(provider) : [];
        return models.map((m: { id: string }) => m.id);
      },
    );

    if (!resolution) {
      return false;
    }

    let nextModel = this.inner.modelRuntime.getModel(resolution.provider, resolution.modelId);
    if (!nextModel) {
      await this.inner.modelRuntime.refresh({ allowNetwork: false });
      nextModel = this.inner.modelRuntime.getModel(resolution.provider, resolution.modelId);
    }
    if (!nextModel) {
      this.routingTriedProviders.add(resolution.provider);
      return false;
    }

    this.assertWriteOpen();
    await this.inner.setModel(nextModel);
    await this.refreshRemoteClaudeHostBinding();
    this.inner.setThinkingLevel(resolution.thinkingLevel);
    this.routingTriedProviders.add(resolution.provider);
    this.routingCurrentProviderRetries = 0;

    invalidateModelsCache();
    invalidateSessionListCache();

    this.emit({
      type: "model_changed",
      model: { id: nextModel.id, provider: nextModel.provider },
      thinkingLevel: resolution.thinkingLevel,
      routedFrom: { provider: currentProvider, modelId: currentModel.id },
      inherited: resolution.inherited,
    } as unknown as AgentEvent);

    if (this.schedulerState) {
      this.schedulerState.attempt = 0;
    }

    return true;
  }

  hasPendingUserInteraction(): boolean {
    return [...this.pendingUiRequests.values()].some((request) => ["select", "confirm", "input", "editor", "custom"].includes(String(request.method)));
  }

  pendingUserRequestIds(): string[] {
    return [...this.pendingUiRequests.keys()];
  }

  private setAutoCompactionEnabledRuntimeOnly(enabled: boolean): void {
    applyRuntimeCompactionOverride(this.inner.settingsManager, enabled);
    this.runtimeAutoCompactionEnabled = enabled;
  }

  getRuntimeAutoCompactionEnabled(): boolean | null {
    return this.runtimeAutoCompactionEnabled;
  }

  setRuntimeAutoCompactionEnabled(enabled: boolean): void {
    this.setAutoCompactionEnabledRuntimeOnly(enabled);
  }

  private applyRuntimeAutoCompactionOverride(): void {
    if (this.runtimeAutoCompactionEnabled !== null) {
      applyRuntimeCompactionOverride(this.inner.settingsManager, this.runtimeAutoCompactionEnabled);
    }
  }

  private reportedAutoCompactionEnabled(): boolean {
    return this.deferredAutoCompactionEnabled
      ?? this.runtimeAutoCompactionEnabled
      ?? this.inner.autoCompactionEnabled;
  }

  private deferPostRunCompaction(message: unknown): void {
    if (this.deferredAutoCompactionEnabled !== null || !message || typeof message !== "object") return;
    const assistant = message as { role?: unknown; stopReason?: unknown };
    if (assistant.role !== "assistant" || assistant.stopReason !== "stop") return;
    // A queued continuation is already evidence that this run must keep going;
    // leave SDK auto-compaction enabled for that next turn.
    if (this.pendingQueueCount() > 0) return;

    const settings = this.inner.settingsManager.getCompactionSettings();
    if (!settings.enabled) return;

    this.deferredAutoCompactionEnabled = settings.enabled;
    this.inner.settingsManager.applyOverrides({ compaction: { enabled: false } });
  }

  private restoreDeferredCompaction(): void {
    if (this.deferredAutoCompactionEnabled === null) return;
    const enabled = this.deferredAutoCompactionEnabled;
    this.deferredAutoCompactionEnabled = null;
    this.inner.settingsManager.applyOverrides({ compaction: { enabled } });
  }

  start(): void {
    const deviceId = localDeviceId();
    const durable = readDurableLiveEventRecords(this.sessionId, { deviceId });
    this.liveEventCursor = durable.records.reduce((maximum, record) => Math.max(maximum, record.cursor), this.liveEventCursor);
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      let clearRunIdAfterEmit = false;
      this.updateActiveToolEvents(event);
      if (event.type === "queue_update") this.queueMutationVersion += 1;
      if (event.type === "message_start" && event.message && typeof event.message === "object") {
        const message = event.message as { role?: unknown; content?: unknown };
        if (message.role === "user") this.markQueuedControlConsumed(event.message);
        else if (isSessionPeerAgentMessage(message)) this.markNativePeerStarted(message);
      }
      if (event.type === "message_end") {
        this.deferPostRunCompaction(event.message);
        const messageRole = event.message && typeof event.message === "object"
          ? (event.message as { role?: unknown }).role
          : undefined;
        if (messageRole === "user" || messageRole === "assistant" || messageRole === "custom") {
          // AgentSession appends message_end immediately after notifying
          // listeners. The microtask runs after that append, so the first
          // accepted user message is the atomic transient→durable boundary.
          const sessionId = this.inner.sessionId;
          queueMicrotask(() => {
            if (messageRole === "user") this.persistSessionFileNow();
            invalidateSessionListCache();
            emitActivityEvent({ kind: "session", sessionId });
          });
        }
        if (messageRole === "custom" && isSessionPeerAgentMessage(event.message)) {
          this.markNativePeerEnded(event.message);
        }
        if (messageRole === "assistant") {
          const assistant = event.message as unknown as Parameters<typeof hasRealOutput>[0];
          if (hasRealOutput(assistant)) {
            this.resetModelRoutingCycle();
          }
        }
        if (messageRole === "user") {
          const content = (event.message as { content?: unknown }).content;
          const text = typeof content === "string" ? content : "";
          if (text.trim() !== "继续") {
            this.resetModelRoutingCycle();
          }
          const timestamp = (event.message as { timestamp?: unknown }).timestamp;
          queueMicrotask(() => {
            this.flushPendingPromptDisplayInputForMessage();
            this.flushPendingQuestionAnalysisForMessage(content, timestamp);
          });
        }
      } else if (event.type === "agent_start") {
        this.currentRunId = recordSessionRunStart(this.inner.sessionId, this.cwd).runId;
        this.settledRunId = null;
        for (const binding of this.controlReceiptBindings.values()) {
          if (binding.phase === "starting" || (binding.phase === "admitting"
            && binding === this.controlReceiptBindings.get(this.controlReceiptAdmissionStorage.getStore() ?? ""))) {
            binding.runId = this.currentRunId;
            binding.phase = "running";
          }
        }
        // Native requests bind to a run only when that exact custom message
        // starts. A queued follow-up must not inherit an earlier run's end.
        for (const [receiptId, binding] of this.controlReceiptBindings) {
          if (binding.runId !== this.currentRunId || binding.phase !== "running") continue;
          void updateControlReceipt(receiptId, {
            outcome: "running",
            startedAt: new Date().toISOString(),
            runId: this.currentRunId,
            bootId: this.liveEventBootId,
            nextAction: "observe_receipt_or_live_events",
          }).catch(() => undefined);
        }
      } else if (event.type === "agent_end") {
        if (this.deferredAutoCompactionEnabled !== null && this.pendingQueueCount() > 0) {
          this.restoreDeferredCompaction();
        }
        const errorMessage = agentEndErrorMessage(event);
        if (errorMessage) {
          recordSessionRunError(this.inner.sessionId, errorMessage, this.unattendedEnabled, this.currentRunId);
          // A failed auto-retry emits agent_end without appending an error
          // message (prepareRetry stripped the chain), so evaluateUnattended
          // cannot see the failed tail and would drop the scheduler.
          // Re-arm on any run error while unattended is enabled,
          // even if the scheduler was previously cleared: pi's built-in
          // transient retry can exhaust and leave the live transcript without
          // a transient tail — only the run error remains as reliable signal.
          if (
            this.unattendedEnabled &&
            !this.abortRequested &&
            !this.schedulerState?.active
          ) {
            this.scheduleNextBackoff(errorMessage);
          }
        } else {
          touchSessionRun(this.inner.sessionId, this.currentRunId);
        }
      } else if (event.type === "agent_settled") {
        this.skillRuntimeTracker.settleAll(this.currentSystemPrompt());
        this.restoreDeferredCompaction();
        if (this.shuttingDown) {
          recordSessionRunUnknown(this.inner.sessionId, this.currentRunId);
          this.settleBoundControlReceipts("unknown", "Reader runtime stopped before a terminal control receipt was recorded");
        } else {
          recordSessionRunSettled(this.inner.sessionId, this.currentRunId);
          this.settleNativePeerRun(this.currentRunId);
          this.settleBoundControlReceipts(this.abortRequested ? "aborted" : "completed");
        }
        this.settledRunId = this.currentRunId;
        clearRunIdAfterEmit = true;
      } else if (event.type === "prompt_error") {
        if (!this.abortRequested) {
          recordSessionRunError(
            this.inner.sessionId,
            typeof event.errorMessage === "string" ? event.errorMessage : undefined,
            this.unattendedEnabled,
            this.currentRunId,
          );
          this.settleBoundControlReceipts("failed", typeof event.errorMessage === "string" ? event.errorMessage : undefined);
        }
      }
      if (event.type === "agent_end") {
        invalidateSessionListCache();
      }
      if (event.type === "session_info_changed") {
        invalidateSessionListCache();
        emitActivityEvent({ kind: "session", sessionId: this.inner.sessionId });
      }
      if (IDLE_RESET_EVENT_TYPES.has(event.type)) this.resetIdleTimer();
      if (event.type === "message_end") {
        // Defer completion until SDK persistence has finished so live and
        // historical rows share the persisted entry identity.
        const runId = this.currentRunId;
        const message = event.message as PiAgentMessage | undefined;
        const customMessage = message?.role === "custom" ? message : null;
        const customMessageIndex = customMessage ? this.inner.agent.state?.messages?.indexOf(customMessage) ?? -1 : -1;
        // Idle custom messages are persisted before their events, so bind before later appends.
        const persistedCustomEntryId = customMessage && customMessageIndex < 0
          ? this.inner.sessionManager.getBranch().findLast(entry => entry.type === "custom_message"
            && entry.customType === customMessage.customType && entry.content === customMessage.content
            && entry.display === customMessage.display && entry.details === customMessage.details)?.id
          : undefined;
        queueMicrotask(() => {
          const entries = this.inner.sessionManager.getEntries() as unknown as SessionEntry[];
          let customEntryId = persistedCustomEntryId;
          if (customMessageIndex >= 0) {
            let messageOffset = 0;
            const projected = this.inner.sessionManager.buildSessionProjection().entries.find(entry => {
              const start = messageOffset;
              messageOffset += entry.messages.length;
              return customMessageIndex >= start && customMessageIndex < messageOffset;
            });
            if (projected?.sourceEntry.type === "custom_message") customEntryId = projected.sourceEntry.id;
          }
          const entryIndex = entries.findLastIndex(value => (value.type === "message" && value.message === event.message)
            || (value.type === "custom_message" && value.id === customEntryId));
          const entry = entries[entryIndex];
          const entryId = entry?.id;
          const orderKey = entry ? historyEntryOrderKey(entry, entryIndex) : undefined;
          const clientMessageId = event.message && typeof event.message === "object" ? this.clientMessageObjects.get(event.message) : undefined;
          if (entryId && clientMessageId) {
            try {
              this.persistSessionFileNow();
              this.inner.sessionManager.appendCustomEntry(CLIENT_MESSAGE_CUSTOM_TYPE, { entryId, clientMessageId });
              invalidateSessionReadCache(this.sessionFile);
            } catch (error) {
              console.error("[pi-web] failed to persist client message identity:", error instanceof Error ? error.message : error);
              this.emit({ type: "extension_error", error: "Message was accepted, but its display identity could not be persisted. Do not resend it." });
            }
          }
          this.emit({ ...event, ...(runId ? { runId } : {}), ...(entryId ? { entryId, orderKey } : {}), ...(clientMessageId ? { clientMessageId } : {}) });
        });
      } else {
        this.emit(event);
      }
      if (clearRunIdAfterEmit) this.currentRunId = null;
      if (event.type === "compaction_end") this.scheduleDeferredCompactionPromptFlush();
      if (RUNNING_STATE_EVENT_TYPES.has(event.type)) {
        notifyRunningChange();
        if (IDLE_RESET_EVENT_TYPES.has(event.type)) this.notifyAgentStateChanged();
      }
    });
    this.resetIdleTimer();
    notifyRunningChange();
  }

  private updateActiveToolEvents(event: AgentEvent): void {
    if (event.type === "agent_end" || event.type === "agent_settled" || event.type === "prompt_done") {
      this.activeToolEvents.clear();
      return;
    }
    if (!TOOL_EXECUTION_EVENT_TYPES.has(event.type)) return;
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
    if (!toolCallId || isNestedToolEvent(event, toolCallId)) return;
    if (event.type === "tool_execution_end") {
      for (const key of this.activeToolEvents.keys()) {
        if (key === toolCallId || key.startsWith(`${toolCallId}/`)) this.activeToolEvents.delete(key);
      }
      return;
    }
    this.activeToolEvents.set(toolCallId, event);
  }

  setForceEmptySystemPrompt(force: boolean): void {
    this.forceEmptySystemPrompt = force;
    this.applyForcedEmptySystemPrompt();
  }

  isChatOnly(): boolean {
    return this.forceEmptySystemPrompt;
  }

  setActiveToolSelection(
    toolNames: string[],
    carry: readonly string[] = this.inner.getActiveToolNames(),
    preferredOrder?: readonly string[],
  ): void {
    this.setForceEmptySystemPrompt(toolNames.length === 0);
    const resolved = resolveActiveToolNames(this.inner, toolNames, this.strictToolAllowlist ? [] : carry);
    const allowed = new Set(resolved);
    const sameSet = preferredOrder !== undefined && preferredOrder.length === resolved.length
      && new Set(preferredOrder).size === resolved.length
      && preferredOrder.every((name) => allowed.has(name));
    this.inner.setActiveToolsByName(sameSet && preferredOrder ? [...preferredOrder] : resolved);
  }

  private restoreToolSelectionAfterNavigation(activeBefore: readonly string[]): void {
    if (this.isChatOnly()) return;

    const entries = this.inner.sessionManager.getEntries() as unknown as SessionEntry[];
    if (readValidSubagentResources(entries)) return;

    const activeAfter = this.inner.getActiveToolNames();
    this.setActiveToolSelection(
      readSessionToolSelection(entries) ?? activeAfter,
      [...activeAfter, ...activeBefore.filter((name) => SESSION_TOOL_NAMES.has(name))],
      activeBefore,
    );
  }

  private async navigateTreeKeepingToolSelection(
    targetId: string,
    options: { summarize?: boolean },
  ): Promise<{ cancelled: boolean; editorText?: string }> {
    const activeBefore = this.inner.getActiveToolNames();
    const result = await this.inner.navigateTree(targetId, options);
    if (!result.cancelled) this.restoreToolSelectionAfterNavigation(activeBefore);
    return { cancelled: result.cancelled, editorText: result.editorText };
  }

  setSuppressCompletionNotifications(suppress: boolean): void {
    this.suppressCompletionNotifications = suppress;
  }

  hasSuppressedCompletionNotifications(): boolean {
    return this.suppressCompletionNotifications;
  }

  beginExtensionBinding(options: ExtensionBindingOptions = {}): void {
    void this.ensureExtensionsBound(options).catch((err) => {
      console.error("[pi-web] failed to dispatch session_start to extensions:", err instanceof Error ? err.message : err);
      if (this.runtimeOwnership) void this.shutdown().catch((error) => console.error("[pi-web] failed startup cleanup:", error));
    });
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForExtensionsBound();
  }

  /** Prepare MCP for a subagent prompt that bypasses this wrapper's send() method. */
  async prepareMcpForRun(signal: AbortSignal): Promise<boolean> {
    const mcpHost = this.mcpHost;
    if (!mcpHost || this.inner.isStreaming) return !signal.aborted;
    const controller = new AbortController();
    const stop = () => controller.abort();
    if (signal.aborted) stop();
    signal.addEventListener("abort", stop, { once: true });
    const waited = (async () => {
      await this.waitForExtensionsBound();
      if (!controller.signal.aborted) await mcpHost.prepareForPrompt(controller.signal);
    })().catch((error: unknown) => {
      console.error("[pi-web] MCP servers could not be prepared:", error instanceof Error ? error.message : error);
    });
    const wait = { controller, done: waited };
    this.mcpPromptWait = wait;
    try {
      await waited;
    } finally {
      signal.removeEventListener("abort", stop);
      if (this.mcpPromptWait === wait) this.mcpPromptWait = null;
    }
    return !controller.signal.aborted;
  }

  private ensureExtensionsBound(options: ExtensionBindingOptions = {}): Promise<void> {
    if (options.forceEmptySystemPrompt) this.forceEmptySystemPrompt = true;
    if (this.extensionsBound) {
      this.applyForcedEmptySystemPrompt();
      return Promise.resolve();
    }
    if (this.extensionBindingPromise) return this.extensionBindingPromise;

    this.extensionBindingError = null;
    this.extensionBindingPromise = (async () => {
      if (!this._alive) return;
      const uiContext = this.createExtensionUiContext();
      if (typeof this.inner.bindExtensions === "function") {
        const bindExtensions = this.inner.bindExtensions as (bindings: {
          uiContext?: ExtensionUiContextLike;
          mode?: "rpc";
          commandContextActions?: ExtensionCommandContextActionsLike;
          shutdownHandler?: () => void;
          onError?: (error: { extensionPath: string; event: string; error: string }) => void;
        }) => Promise<void>;
        await bindExtensions.call(this.inner, {
          uiContext,
          mode: "rpc",
          commandContextActions: this.createExtensionCommandContextActions(),
          shutdownHandler: () => this.emit({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "notify",
            notifyType: "warning",
            message: "Extension requested shutdown, but shutdown is not supported in Pi Web.",
          } as AgentEvent),
          onError: (error) => this.emit({
            type: "extension_error",
            extensionPath: error.extensionPath,
            event: error.event,
            error: error.error,
          }),
        });
      } else {
        this.inner.extensionRunner.setUIContext?.(uiContext, "rpc");
      }
      this.extensionsBound = true;
      this.applyForcedEmptySystemPrompt();
      console.log(`[pi-web] session_start dispatched to extensions for session ${this.inner.sessionId}`);
    })().catch((err) => {
      this.extensionBindingError = err;
      throw err;
    });

    return this.extensionBindingPromise;
  }

  private async waitForExtensionsBound(): Promise<void> {
    try {
      if (this.extensionBindingPromise) await this.extensionBindingPromise;
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (this.extensionBindingError) {
      throw this.extensionBindingError instanceof Error
        ? this.extensionBindingError
        : new Error(String(this.extensionBindingError));
    }
  }

  private shouldWaitForExtensions(type: string): boolean {
    // get_state observes the current snapshot; execution and command enumeration
    // remain gated until extension binding (and any pending UI) completes.
    return type === "prompt"
      || type === "peer_message"
      || type === "steer"
      || type === "follow_up"
      || type === "retry_continue"
      || type === "retry_continue_only"
      || type === "get_commands"
      || type === "set_fast_mode";
  }

  private async withFinalRunningNotification<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      this.resetIdleTimer();
      notifyRunningChange();
    }
  }

  private async abortWithFallback(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = Promise.resolve()
      .then(() => this.inner.abort())
      .then(
        () => ({ status: "completed" as const }),
        (error) => ({ status: "failed" as const, error }),
      );
    const outcome = await Promise.race([
      abort,
      new Promise<{ status: "timed_out" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timed_out" }), ABORT_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);

    if (outcome.status === "timed_out") {
      console.warn("[pi-web] abort timed out for session " + this.inner.sessionId + "; disposing session");
      await this.shutdown();
    } else if (outcome.status === "failed") {
      await this.shutdown();
      throw outcome.error;
    }
  }

  private applyForcedEmptySystemPrompt(): void {
    if (this.forceEmptySystemPrompt && this.inner.agent.state) {
      try {
        Object.defineProperty(this.inner.agent.state, "systemPrompt", {
          value: "",
          configurable: true,
          writable: true,
        });
      } catch {
        // Ignore if state is non-extensible.
      }
    }
  }

  private emit(event: AgentEvent): void {
    if (this.shuttingDown && ["agent_start", "agent_end", "agent_settled", "prompt_error", "prompt_done"].includes(event.type)) return;
    if (event.type === "unattended_state") event = { ...event, configured: this.unattendedConfigured };
    if (event.type === "queue_update") {
      const queueSnapshot = this.queueIdentityTracker?.snapshot(this.deferredCompactionPrompts) ?? null;
      event = { ...event, ...this.queuedMessages(), queueSnapshot, queueRevision: this.getQueueIdentity().revision };
    }
    // prompt_done / prompt_error normally arrive after agent_settled has already
    // cleared the live run, so they carry the run that just settled instead.
    const trailingRunId = event.type === "prompt_done" || event.type === "prompt_error" ? this.settledRunId : null;
    if (trailingRunId && !this.currentRunId) event = { ...event, runId: trailingRunId };
    const withRunId = this.currentRunId && ["agent_start", "agent_end", "agent_settled", "prompt_error", "prompt_done"].includes(event.type)
      ? { ...event, runId: this.currentRunId }
      : event;
    const deliveredEvent = withRunId.type === "agent_end" || withRunId.type === "prompt_error"
      ? { ...withRunId, unattended: this.unattendedEnabled }
      : withRunId;
    const projected = publicLiveAgentEvent(deliveredEvent);
    if (projected) {
      const deviceId = localDeviceId();
      const persisted = appendDurableLiveEvent({
        sessionId: this.sessionId,
        deviceId,
        bootId: this.liveEventBootId,
        cursor: this.liveEventCursor + 1,
        runId: this.currentRunId ?? trailingRunId,
        event: projected,
      });
      // The ledger allocates cursors under its existing per-session lock.
      // A failed append remains a local cursor hole and an explicit health
      // failure; it must not be presented as a completely durable stream.
      const nextCursor = persisted.cursor ?? this.liveEventCursor + 1;
      this.liveEventCursor = appendLiveEvent(this.liveEventRecords, nextCursor - 1, projected);
    }
    const replayableNotice = deliveredEvent.type === "extension_ui_request"
      && deliveredEvent.method === "notify"
      && (deliveredEvent.notifyType === "warning" || deliveredEvent.notifyType === "error");
    if (replayableNotice && this.listeners.size === 0) this.recentNoticeBuffer.remember(deliveredEvent);
    const waitEvent = deliveredEvent as AgentEvent & { runId?: string; errorMessage?: string; toolCallId?: string; toolName?: string };
    persistSessionWaitEvent({
      type: waitEvent.type,
      sessionId: this.inner.sessionId,
      runId: waitEvent.runId,
      sessionFile: this.sessionFile,
      errorMessage: waitEvent.errorMessage,
      toolCallId: waitEvent.toolCallId,
      toolName: waitEvent.toolName,
    });
    if (["agent_settled", "compaction_end", "agent_end"].includes(waitEvent.type)) {
      void drainPendingSessionWakes(this.inner.sessionId, this).catch((error) => {
        console.error("[session-wait] pending wake drain failed:", error instanceof Error ? error.message : String(error));
      });
    }
    for (const listener of this.listeners) {
      try {
        listener(deliveredEvent);
      } catch (error) {
        console.error(
          `[pi-web] failed to deliver ${event.type} event:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  private emitPromptDone(clientMessageId?: string): void {
    this.emit({ type: "prompt_done", ...(clientMessageId ? { clientMessageId } : {}) });
    this.currentRunId = null;
    this.settledRunId = null;
  }

  private async acquirePromptAdmission(): Promise<() => void> {
    this.promptAdmissionCount += 1;
    this.resetIdleTimer();
    notifyRunningChange();
    const previous = this.promptAdmissionTail;
    let release!: () => void;
    this.promptAdmissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return () => {
      this.promptAdmissionCount = Math.max(0, this.promptAdmissionCount - 1);
      this.resetIdleTimer();
      release();
      notifyRunningChange();
    };
  }

  private resetIdleTimer(): void {
    if (!this._alive) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (SESSION_IDLE_TIMEOUT_MS === 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.isRunning() || this.unattendedResumeRequired || hasActiveSessionLivenessProvider({
        sessionId: this.sessionId,
        sessionFile: this.sessionFile || undefined,
      })) {
        this.resetIdleTimer();
        return;
      }
      void this.shutdown().catch((error) => {
        console.error("[pi-web] failed to shut down idle session:", error instanceof Error ? error.message : error);
      });
    }, SESSION_IDLE_TIMEOUT_MS);
  }

  /**

   * Persist a session once it has durable conversation entries.
   * Draft-only runtimes remain in memory until a message is sent; bash-only
   * sessions may opt in because the command itself is durable user work.
   * Idempotent: no-op when the file already exists.
   */
  persistSessionFileNow(allowEmpty = false): void {
    const manager = this.inner.sessionManager;
    const sessionFile = manager.getSessionFile();
    if (!sessionFile || existsSync(sessionFile)) return;

    const entries = manager.getEntries();
    const hasMessage = entries.some((entry) => entry.type === "message");
    if (!allowEmpty && !hasMessage) return;

    const header = manager.getHeader();
    if (!header) return;

    const content = [header, ...entries]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
    const leafId = manager.getLeafId();
    writeFileSync(sessionFile, content, { encoding: "utf8", flag: "wx", mode: 0o600 });

    manager.setSessionFile(sessionFile);
    if (leafId === null) manager.resetLeaf();
    else if (manager.getLeafId() !== leafId) manager.branch(leafId);
    cacheSessionPath(this.inner.sessionId, sessionFile);

  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    for (const event of this.recentNoticeBuffer.take()) listener(event);
    for (const event of this.pendingUiRequests.values()) listener({ ...structuredClone(event), replay: true });
    for (const event of this.activeToolEvents.values()) listener(event);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  /**
   * Retry the latest continue turn without appending another user message.
   * Pi's Agent.continue() is the same path used by its built-in transient
   * retry; this wrapper supplies the missing AgentSession lifecycle.
   */
  private async retryLastFailedTurn(): Promise<void> {
    const session = this.inner as unknown as RetrySessionInternals;
    const messages = session.agent?.state?.messages;
    const retryIndex = messages
      ? continueRetryIndex(messages as Parameters<typeof continueRetryIndex>[0])
      : -1;
    const last = retryIndex >= 0 ? messages?.[retryIndex] : undefined;
    const retryMode = messages && continueRetryMode(
      messages as Parameters<typeof continueRetryMode>[0],
    );
    if (!messages || !last || retryMode === "none") {
      throw new Error("No continue turn is available to retry");
    }
    if (session._isAgentRunActive) {
      throw new Error("Agent is already running");
    }
    if (typeof session._handlePostAgentRun !== "function" || typeof session._emitAgentSettled !== "function") {
      throw new Error("Installed Pi Agent does not expose retry lifecycle hooks");
    }

    // Re-evaluate the live tail before every Agent.continue(). A retry can
    // append another empty assistant error; passing that assistant straight
    // back to the SDK produces "Cannot continue from message role: assistant".
    const prepareRetry = (required: boolean): boolean => {
      const currentMessages = session.agent?.state?.messages;
      const currentRetryIndex = currentMessages
        ? continueRetryIndex(currentMessages as Parameters<typeof continueRetryIndex>[0])
        : -1;
      const currentRetryMode = currentMessages && continueRetryMode(
        currentMessages as Parameters<typeof continueRetryMode>[0],
      );
      if (!currentMessages || currentRetryIndex < 0 || currentRetryMode === "none") {
        if (required) throw new Error("No continue turn is available to retry");
        return false;
      }
      if (currentRetryMode === "remove-assistant") {
        session.agent.state.messages = currentMessages.slice(0, currentRetryIndex);
      } else {
        // Keep native system/loadout updates while removing the failed chain.
        session.agent.state.messages = currentMessages.filter((message, index) => index <= currentRetryIndex || message.role === "system");
      }
      session._lastAssistantMessage = undefined;
      return true;
    };

    prepareRetry(true);
    session._isAgentRunActive = true;
    let retryFailed = false;
    try {
      await session.agent.continue();
      while (await session._handlePostAgentRun()) {
        if (!prepareRetry(false)) break;
        await session.agent.continue();
      }
    } catch (err) {
      retryFailed = true;
      throw err;
    } finally {
      session._systemPromptOverride = undefined;
      session._flushPendingBashMessages();
      // A continue() that does not throw can still be a failed retry: pi's
      // prepareRetry strips the failed assistant chain from the live
      // transcript, so the run would settle as "completed" and the aggregate
      // panel / ChatWindow would play the completion sound for a failed
      // unattended retry. Record the failure before agent_settled fires so
      // recordSessionRunSettled becomes a no-op and the run stays "failed".
      const retryError = this.retryRunFailure();
      if (retryError !== null) {
        recordSessionRunError(this.inner.sessionId, retryError, this.unattendedEnabled, this.currentRunId);
        retryFailed = true;
      }
      if (retryFailed) {
        const routingConfig = await readModelRoutingConfig().catch(() => null);
        const currentProvider = this.inner.model?.provider;
        const currentRoute = currentProvider
          ? routingConfig?.routes.find((route) => route.provider === currentProvider)
          : undefined;
        const maxAttempts = getRouteMaxAttempts(currentRoute ?? { maxAttempts: undefined });
        this.routingCurrentProviderRetries += 1;
        if (this.routingCurrentProviderRetries >= maxAttempts) {
          this.routingRetryBackoffAttempt = 0;
          await this.tryModelRoutingSwitch().catch((err) => {
            console.error("[model-routing] switch failed:", err);
          });
        } else if (routingConfig?.enabled && currentRoute) {
          // The scheduler consumes this one-shot delay before the next retry:
          // 1s, 2s, 4s, ... (bounded by the routing helper).
          this.routingRetryBackoffAttempt = this.routingCurrentProviderRetries;
        }
      } else {
        this.resetModelRoutingCycle();
      }
      await session._emitAgentSettled();
    }
  }

  private normalizeQuestion(question: string): string {
    const normalized = question.trim();
    if (!normalized) throw new Error("Question is required");
    if (normalized.length > QUESTION_ANALYSIS_MAX_CHARS) {
      throw new Error(`Question is too long (maximum ${QUESTION_ANALYSIS_MAX_CHARS} characters)`);
    }
    return normalized;
  }

  private parsePromptQuestionAnalysis(value: unknown): QuestionAnalysisPromptMetadata[] {
    if (!Array.isArray(value)) return [];
    const parsed: QuestionAnalysisPromptMetadata[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      if (typeof record.question !== "string") continue;
      const result = record.result;
      if (!result || typeof result !== "object" || Array.isArray(result)) continue;
      const resultRecord = result as Record<string, unknown>;
      if (typeof resultRecord.text !== "string" || !resultRecord.text.trim()) continue;
      const rewriteValue = record.rewrite;
      if (rewriteValue !== undefined) {
        if (!rewriteValue || typeof rewriteValue !== "object" || Array.isArray(rewriteValue)) continue;
        const rewriteRecord = rewriteValue as Record<string, unknown>;
        if (typeof rewriteRecord.text !== "string" || !rewriteRecord.text.trim()) continue;
      }
      parsed.push(item as unknown as QuestionAnalysisPromptMetadata);
    }
    return parsed;
  }

  private prepareQuestionAnalysisJob(
    question: string,
    options: { mode?: QuestionAnalysisMode; entryId?: string } = {},
  ): QuestionAnalysisJob {
    const normalized = this.normalizeQuestion(question);

    const targetEntryId = options.entryId?.trim();
    if (!targetEntryId) throw new Error("A saved question entry is required");
    const targetEntry = this.inner.sessionManager.getEntry(targetEntryId) as unknown as SessionEntry | undefined;
    if (!targetEntry || targetEntry.type !== "message" || targetEntry.message.role !== "user") {
      throw new Error("Question entry not found");
    }

    const currentModel = this.inner.model;
    if (!currentModel) throw new Error("No model is configured for this session");

    const mode: QuestionAnalysisMode = options.mode === "context" ? "context" : "question";
    let priorContext = "";
    let contextInfo: QuestionAnalysisJob["context"] = {
      source: mode === "context" ? "unavailable" : "none",
      summaryChars: 0,
      recentChars: 0,
      recentMessages: 0,
    };
    if (mode === "context") {
      const branchEntries = this.inner.sessionManager.getBranch(targetEntryId) as unknown as SessionEntry[];
      const targetIndex = branchEntries.findIndex((entry) => entry.id === targetEntryId);
      if (targetIndex >= 0) {
        const builtContext = buildQuestionAnalysisContext(branchEntries.slice(0, targetIndex));
        priorContext = builtContext.text;
        contextInfo = {
          source: builtContext.source,
          summaryChars: builtContext.summaryChars,
          recentChars: builtContext.recentChars,
          recentMessages: builtContext.recentMessages,
        };
      }
    }

    return {
      jobId: randomUUID(),
      targetEntryId,
      status: "pending",
      question: normalized,
      mode,
      model: { provider: currentModel.provider, modelId: currentModel.id },
      priorContext,
      context: contextInfo,
      requestedAt: Date.now(),
    };
  }

  private async completeQuestionTask(
    systemPrompt: string,
    userPrompt: string,
    modelRef: { provider: string; modelId: string },
    maxTokens: number,
  ): Promise<QuestionAnalysisResult> {
    const controller = new AbortController();
    this.questionTaskControllers.add(controller);
    try {
    // Auxiliary work uses the same session cancellation scope without adding a turn.
    type AnalysisModelRuntime = {
      getModel: (provider: string, modelId: string) => PiModel<Api> | undefined;
      refresh: (options?: { allowNetwork?: boolean }) => Promise<unknown>;
      completeSimple: (
        model: PiModel<Api>,
        context: PiContext,
        options?: ModelsSimpleStreamOptions,
      ) => Promise<PiAssistantMessage>;
    };
    const runtime = this.inner.modelRuntime as unknown as AnalysisModelRuntime;
    let model = runtime.getModel(modelRef.provider, modelRef.modelId);
    if (!model) {
      await runtime.refresh({ allowNetwork: false });
      model = runtime.getModel(modelRef.provider, modelRef.modelId);
    }
    if (!model) throw new Error(`Model not found: ${modelRef.provider}/${modelRef.modelId}`);

    const context: PiContext = {
      systemPrompt,
      messages: [{
        role: "user",
        content: userPrompt,
        timestamp: Date.now(),
      }],
    };
    const response = await runtime.completeSimple(model, context, {
      maxTokens,
      signal: controller.signal,
      maxRetries: 1,
      timeoutMs: 90_000,
    });
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || "Question task failed");
    }
    const text = extractAssistantText(response.content);
    if (!text) throw new Error("Question task returned no text");
    const responseUsage = response.usage ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const priced = await priceQuestionAnalysis({
      model: modelRef.modelId,
      provider: modelRef.provider,
      input: responseUsage.input,
      output: responseUsage.output,
      cacheRead: responseUsage.cacheRead,
      cacheWrite: responseUsage.cacheWrite,
      timestamp: new Date().toISOString(),
    });
    const usage = { ...responseUsage };
    Reflect.deleteProperty(usage, "cost");
    return {
      text,
      usage,
      ...(priced.cost ? { cost: priced.cost } : {}),
      pricingConfigured: priced.pricing.configured,
      pricing: priced.pricing,
    };
    } finally { this.questionTaskControllers.delete(controller); }
  }

  private async completeQuestionAnalysis(job: QuestionAnalysisJob): Promise<QuestionAnalysisResult> {
    const result = await this.completeQuestionTask(
      QUESTION_ANALYSIS_SYSTEM_PROMPT,
      buildQuestionAnalysisPrompt(job.question, job.priorContext || undefined),
      job.model,
      QUESTION_ANALYSIS_MAX_TOKENS,
    );
    return {
      ...result,
      context: { mode: job.mode, ...job.context },
    };
  }

  private async completeQuestionDraft(question: string, mode: QuestionAnalysisMode = "question"): Promise<QuestionAnalysisResult> {
    const normalizedQuestion = this.normalizeQuestion(question);
    const currentModel = this.inner.model;
    if (!currentModel) throw new Error("No model is configured for this session");
    const contextInfo = mode === "context"
      ? buildQuestionAnalysisContext(this.inner.sessionManager.getBranch() as unknown as SessionEntry[])
      : { text: "", source: "none" as const, summaryChars: 0, recentChars: 0, recentMessages: 0 };
    const result = await this.completeQuestionTask(
      QUESTION_ANALYSIS_SYSTEM_PROMPT,
      buildQuestionAnalysisPrompt(normalizedQuestion, contextInfo.text || undefined),
      { provider: currentModel.provider, modelId: currentModel.id },
      QUESTION_ANALYSIS_MAX_TOKENS,
    );
    return {
      ...result,
      context: {
        mode,
        source: contextInfo.source,
        summaryChars: contextInfo.summaryChars,
        recentChars: contextInfo.recentChars,
        recentMessages: contextInfo.recentMessages,
      },
    };
  }

  private async completeQuestionRewrite(question: string, terms: string): Promise<QuestionRewriteResult> {
    const normalizedQuestion = this.normalizeQuestion(question);
    const normalizedTerms = terms.trim();
    if (!normalizedTerms) throw new Error("Terminology is required");
    if (normalizedTerms.length > QUESTION_REWRITE_TERMS_MAX_CHARS) {
      throw new Error(`Terminology is too long (maximum ${QUESTION_REWRITE_TERMS_MAX_CHARS} characters)`);
    }

    const currentModel = this.inner.model;
    if (!currentModel) throw new Error("No model is configured for this session");
    return this.completeQuestionTask(
      QUESTION_REWRITE_SYSTEM_PROMPT,
      buildQuestionRewritePrompt(normalizedQuestion, normalizedTerms),
      { provider: currentModel.provider, modelId: currentModel.id },
      QUESTION_REWRITE_MAX_TOKENS,
    );
  }

  private async completeSte100Rewrite(text: string): Promise<QuestionRewriteResult> {
    const normalizedText = this.normalizeQuestion(text);
    const currentModel = this.inner.model;
    if (!currentModel) throw new Error("No model is configured for this session");
    return this.completeQuestionTask(
      STE100_REWRITE_SYSTEM_PROMPT,
      buildSte100RewritePrompt(normalizedText),
      { provider: currentModel.provider, modelId: currentModel.id },
      STE100_REWRITE_MAX_TOKENS,
    );
  }

  /** The SDK text mirror can outlive consumed image-only/transformed inputs. */
  private pendingQueueCount(): number {
    const queued = this.queuedMessages();
    return queued.steering.length + queued.followUp.length;
  }

  private queuedMessages(): { steering: string[]; followUp: string[] } {
    if (this.queueIdentityTracker) {
      const snapshot = this.queueIdentityTracker.snapshot(this.deferredCompactionPrompts);
      return { steering: snapshot.steering.map(item => item.text), followUp: snapshot.followUp.map(item => item.text) };
    }
    return {
      steering: [
        ...this.inner.getSteeringMessages(),
        ...this.deferredCompactionPrompts
          .filter((prompt): prompt is DeferredUserPrompt => prompt.kind === "prompt" && prompt.streamingBehavior === "steer")
          .map((prompt) => prompt.message),
        ...this.deferredCompactionPrompts
          .filter((prompt): prompt is DeferredPeerPrompt => prompt.kind === "peer" && prompt.delivery === "steer")
          .map((prompt) => prompt.message.content),
      ],
      followUp: [
        ...this.inner.getFollowUpMessages(),
        ...this.deferredCompactionPrompts
          .filter((prompt): prompt is DeferredUserPrompt => prompt.kind === "prompt" && prompt.streamingBehavior === "followUp")
          .map((prompt) => prompt.message),
        ...this.deferredCompactionPrompts
          .filter((prompt): prompt is DeferredPeerPrompt => prompt.kind === "peer" && prompt.delivery !== "steer")
          .map((prompt) => prompt.message.content),
      ],
    };
  }

  private emitQueueUpdate(): void {
    this.queueMutationVersion += 1;
    const queued = this.queuedMessages();
    this.emit({ type: "queue_update", ...queued });
    notifyRunningChange();
  }

  private deferPromptDuringCompaction(prompt: DeferredCompactionPrompt): void {
    this.deferredCompactionPrompts.push(prompt);
    this.resetIdleTimer();
    this.emitQueueUpdate();
  }

  private scheduleDeferredCompactionPromptFlush(delayMs = 0): void {
    if (this.stopAllRequested || this.compactionPromptFlushTimer || this.deferredCompactionPrompts.length === 0) return;
    this.compactionPromptFlushTimer = setTimeout(() => {
      this.compactionPromptFlushTimer = null;
      void this.flushDeferredCompactionPrompts();
    }, this.inner.isCompacting ? 25 : delayMs);
  }

  private async flushDeferredCompactionPrompts(): Promise<void> {
    if (this.stopAllRequested || !this._alive || this.shuttingDown || this.inner.isCompacting || this.deferredCompactionPrompts.length === 0) return;

    while (!this.stopAllRequested && this._alive && !this.shuttingDown && !this.inner.isCompacting && this.deferredCompactionPrompts.length > 0) {
      // Take the head without removing it: the awaits below (prompt admission,
      // remote binding refresh) are where a Recall arrives, and an item that has
      // already left the queue cannot be recalled even though it was never sent.
      const prompt = this.deferredCompactionPrompts[0];
      if (!prompt || this.admittingDeferredPrompts.has(prompt)) break;
      this.admittingDeferredPrompts.add(prompt);
      const removeTaken = () => {
        const index = this.deferredCompactionPrompts.indexOf(prompt);
        if (index >= 0) this.deferredCompactionPrompts.splice(index, 1);
        this.admittingDeferredPrompts.delete(prompt);
        this.submittingDeferredPrompts.delete(prompt);
      };
      if (prompt.kind === "peer") {
        const submission = this.nativePeerSubmissions.get(prompt.submissionId);
        if (!submission) {
          removeTaken();
          this.emitQueueUpdate();
          continue;
        }
        try {
          const releaseAdmission = await this.acquirePromptAdmission();
          try {
            await this.refreshRemoteClaudeHostBinding();
            // A Recall during admission already removed this item; dispatching
            // now would deliver a peer message the user withdrew.
            if (!this.deferredCompactionPrompts.includes(prompt)) { removeTaken(); continue; }
            this.assertNativePeerRuntimeAdmission(submission, submission.stopVersion);
            await this.dispatchNativePeerSubmission(submission, prompt);
            removeTaken();
          } finally { releaseAdmission(); }
        } catch (error) {
          if (this.inner.isCompacting) {
            this.admittingDeferredPrompts.delete(prompt);
            this.submittingDeferredPrompts.delete(prompt);
            this.emitQueueUpdate();
            this.scheduleDeferredCompactionPromptFlush();
            return;
          }
          removeTaken();
          this.rejectNativePeerSubmission(submission, error);
        }
        this.emitQueueUpdate();
        continue;
      }
      const receiptId = prompt.readerControlReceiptId;
      const binding = receiptId ? this.controlReceiptBindings.get(receiptId) : undefined;
      if (binding) binding.phase = "admitting";
      try {
        // Admission is awaited, so a Recall may have cleared the item while it
        // was waiting. Sending now would deliver a control the user withdrew.
        if (!this.deferredCompactionPrompts.includes(prompt)) { removeTaken(); continue; }
        await this.send({
          type: "prompt",
          message: prompt.message,
          ...(prompt.clientMessageId ? { clientMessageId: prompt.clientMessageId } : {}),
          ...(receiptId ? { readerControlReceiptId: receiptId } : {}),
          ...(prompt.images?.length ? { images: prompt.images } : {}),
          streamingBehavior: prompt.streamingBehavior,
          deferCompactionQueue: true,
          deferredQueueToken: {
            stillQueued: () => this.deferredCompactionPrompts.includes(prompt),
            beginSubmit: () => {
              if (!this.deferredCompactionPrompts.includes(prompt)) return false;
              this.submittingDeferredPrompts.add(prompt);
              return true;
            },
          },
        });
        removeTaken();
      } catch (error) {
        // A compaction race is retryable; a normal preflight/runtime rejection
        // is terminal for this deferred item and must not spin forever.
        if (this.inner.isCompacting) {
          this.admittingDeferredPrompts.delete(prompt);
          this.submittingDeferredPrompts.delete(prompt);
          if (binding) binding.phase = "queued";
          this.emitQueueUpdate();
          this.scheduleDeferredCompactionPromptFlush();
          return;
        }
        removeTaken();
        if (receiptId) {
          this.persistTerminalControlReceipt(receiptId, {
            outcome: "failed", completedAt: new Date().toISOString(),
            error: { code: "queue_admission_failed", message: error instanceof Error ? error.message : String(error) },
            nextAction: "inspect_runtime_before_retry",
          });
        }
        this.emitQueueUpdate();
        this.emit({
          type: "prompt_error",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
  }

  private enqueuePromptDisplayInput(text: unknown): PendingPromptDisplayInput {
    const pending = {
      input: typeof text === "string" && Array.isArray(this.inner.promptTemplates)
        ? promptTemplateInvocation(text, this.inner.promptTemplates)
        : null,
    };
    this.pendingPromptDisplayInputs.push(pending);
    return pending;
  }

  private discardPendingPromptDisplayInput(pending: PendingPromptDisplayInput | undefined): void {
    if (!pending) return;
    const index = this.pendingPromptDisplayInputs.indexOf(pending);
    if (index >= 0) this.pendingPromptDisplayInputs.splice(index, 1);
  }

  private isRegisteredExtensionCommand(text: string): boolean {
    const commandName = text.match(/^\/([^\s]+)/)?.[1];
    const commands = this.inner.extensionRunner?.getRegisteredCommands?.();
    return Boolean(commandName && Array.isArray(commands) && commands.some((command) => command.invocationName === commandName));
  }

  /** The command ownership used by MCP preflight; external /mcp wins. */
  private extensionCommandCandidates(): McpCommandCandidate[] {
    try {
      const commands = this.inner.extensionRunner?.getRegisteredCommands?.();
      return Array.isArray(commands)
        ? commands.map((command) => ({ name: command.invocationName, sourceInfo: command.sourceInfo }))
        : [];
    } catch {
      // An unreadable command list must not block a normal prompt.
      return [];
    }
  }

  private skillRuntimeAdmissionUnavailable(reason: string): Error {
    return new Error(`Reader Skill runtime admission unavailable: ${reason}`);
  }

  /**
   * Put the Reader admission at the SDK expansion boundary rather than only
   * around RPC prompt(). Pi 1.2 routes steer(), followUp(), and extension
   * sendUserMessage() through the same private expansion method after input
   * transforms have run. Patching the live session instance keeps that native
   * expansion implementation intact while making every public entry point use
   * one policy gate.
   */
  private installSkillRuntimeAdmission(): (() => void) | null {
    if (!this.skillRuntimeContext) return null;
    const target = this.inner as unknown as SkillRuntimePatchedSession;
    const originalExpand = target._expandSkillCommand;
    if (typeof originalExpand !== "function") {
      throw this.skillRuntimeAdmissionUnavailable(
        "Pi SDK _expandSkillCommand boundary is missing; Reader cannot admit Skill runtime calls",
      );
    }
    const originalPrompt = target.prompt;
    const originalSteer = target.steer as unknown as SkillRuntimeQueueMethod;
    const originalFollowUp = target.followUp as unknown as SkillRuntimeQueueMethod;
    const originalSendUserMessage = target.sendUserMessage;
    const invocationStorage = this.skillRuntimeInvocationStorage;
    const admitSkillRuntimeText = this.admitSkillRuntimeText.bind(this);
    const settleSkillRuntimeInvocation = this.settleSkillRuntimeInvocation.bind(this);
    const runPatchedPrompt = this.runPatchedPrompt.bind(this);
    const runPatchedQueue = this.runPatchedQueue.bind(this);
    const runSkillRuntimeInvocation = this.runSkillRuntimeInvocation.bind(this);

    const restore = () => {
      // A failed assignment can mean that the property is non-writable. Each
      // restore is best effort so the boundary error below remains the useful
      // failure even when the first patch never landed.
      try { target._expandSkillCommand = originalExpand; } catch (error) { void error; }
      try { target.prompt = originalPrompt; } catch (error) { void error; }
      try { target.steer = originalSteer; } catch (error) { void error; }
      try { target.followUp = originalFollowUp; } catch (error) { void error; }
      if (originalSendUserMessage) {
        try { target.sendUserMessage = originalSendUserMessage; } catch (error) { void error; }
      }
    };

    try {
      target._expandSkillCommand = function(this: SkillRuntimePatchedSession, text: string): string {
        const invocation = invocationStorage.getStore();
        if (!invocation) {
          // This method is private in Pi. A direct private call has no public
          // submission lifecycle to settle, so reject Skill commands instead
          // of silently bypassing Reader policy.
          if (text.startsWith("/skill:")) {
            const name = text.slice(7).split(" ", 1)[0] || "unknown";
            throw new SkillRuntimeRouteError(
              "unavailable",
              name,
              `Skill /skill:${name} has no Reader invocation context`,
            );
          }
          return originalExpand.call(this, text);
        }

        const route = admitSkillRuntimeText(text, invocation);
        if (!route) return originalExpand.call(this, text);
        let expanded: string;
        try {
          expanded = originalExpand.call(this, text);
        } catch (error) {
          settleSkillRuntimeInvocation(invocation, "prompt-error");
          throw error;
        }
        // Pi 1.2 returns the original text when its native file read fails.
        // Reader already admitted and read the body, so an unchanged result
        // means the native expansion failed after the admission read; reject
        // instead of allowing a literal /skill command into the provider.
        if (expanded === text) {
          settleSkillRuntimeInvocation(invocation, "read-failed");
          throw new SkillRuntimeRouteError(
            "read-failed",
            route.name,
            `Skill /skill:${route.name} was not expanded by the SDK`,
            route.policy,
          );
        }
        return expanded;
      };

      target.prompt = function(
        this: SkillRuntimePatchedSession,
        text: string,
        options?: Parameters<AgentSessionLike["prompt"]>[1],
      ): Promise<void> {
        return runPatchedPrompt(this, originalPrompt, text, options);
      };
      target.steer = function(
        this: SkillRuntimePatchedSession,
        text: string,
        images?: Parameters<AgentSessionLike["steer"]>[1],
        options?: SkillRuntimeQueueOptions,
      ): Promise<"handled" | "queued"> {
        return runPatchedQueue(this, originalSteer, "steer", text, images, options);
      };
      target.followUp = function(
        this: SkillRuntimePatchedSession,
        text: string,
        images?: Parameters<AgentSessionLike["followUp"]>[1],
        options?: SkillRuntimeQueueOptions,
      ): Promise<"handled" | "queued"> {
        return runPatchedQueue(this, originalFollowUp, "followUp", text, images, options);
      };
      if (typeof originalSendUserMessage === "function") {
        target.sendUserMessage = function(
          this: SkillRuntimePatchedSession,
          content: Parameters<SkillRuntimeSendUserMessageMethod>[0],
          options?: Parameters<SkillRuntimeSendUserMessageMethod>[1],
        ): Promise<void> {
          return runSkillRuntimeInvocation(() => originalSendUserMessage.call(this, content, options));
        };
      }
      if (
        target._expandSkillCommand === originalExpand
        || target.prompt === originalPrompt
        || target.steer === originalSteer
        || target.followUp === originalFollowUp
        || (typeof originalSendUserMessage === "function" && target.sendUserMessage === originalSendUserMessage)
      ) {
        throw new Error("Pi SDK Skill admission boundary did not accept the Reader patch");
      }
    } catch (error) {
      restore();
      const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
      throw this.skillRuntimeAdmissionUnavailable(
        `Pi SDK Skill admission boundary is not writable${detail}`,
      );
    }

    this.skillRuntimeAdmissionInstalled = true;
    return () => {
      if (target._expandSkillCommand) target._expandSkillCommand = originalExpand;
      target.prompt = originalPrompt;
      target.steer = originalSteer;
      target.followUp = originalFollowUp;
      if (originalSendUserMessage) target.sendUserMessage = originalSendUserMessage;
      this.skillRuntimeAdmissionInstalled = false;
    };
  }

  private admitSkillRuntimeText(text: string, invocation: SkillRuntimeInvocation): ReturnType<typeof routeSkillCommand> {
    if (!text.startsWith("/skill:")) return null;
    let skills: RuntimeSkillLike[];
    try {
      skills = this.inner.resourceLoader.getSkills().skills as RuntimeSkillLike[];
    } catch (error) {
      const name = text.slice(7).split(" ", 1)[0] || "unknown";
      throw new SkillRuntimeRouteError(
        "unavailable",
        name,
        `Skill /skill:${name} could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      const route = routeSkillCommand(text, {
        skills,
        context: this.skillRuntimeContext,
      });
      if (!route) return null;
      invocation.tokens.push(this.skillRuntimeTracker.begin(route, this.currentSystemPrompt()));
      return route;
    } catch (error) {
      if (error instanceof SkillRuntimeRouteError) {
        this.skillRuntimeTracker.reject(error.skillName, error.policy, this.currentSystemPrompt(), error.code);
      }
      throw error;
    }
  }

  private settleSkillRuntimeInvocation(invocation: SkillRuntimeInvocation, errorCode?: string): void {
    const baselinePrompt = this.currentSystemPrompt();
    for (const token of invocation.tokens.splice(0)) {
      this.skillRuntimeTracker.settle(token, baselinePrompt, "settled", errorCode);
    }
  }

  private runSkillRuntimeInvocation<T>(callback: () => Promise<T>): Promise<T> {
    const existing = this.skillRuntimeInvocationStorage.getStore();
    const invocation = existing ?? { tokens: [] };
    const execute = async (): Promise<T> => {
      try {
        return await callback();
      } catch (error) {
        this.settleSkillRuntimeInvocation(invocation, "prompt-error");
        throw error;
      }
    };
    return existing ? execute() : this.skillRuntimeInvocationStorage.run(invocation, execute);
  }

  private runPatchedPrompt(
    target: SkillRuntimePatchedSession,
    original: AgentSessionLike["prompt"],
    text: string,
    options?: Parameters<AgentSessionLike["prompt"]>[1],
  ): Promise<void> {
    if (this.stopAllRequested) return Promise.reject(new Error("Session execution was stopped; a new user input is required"));
    return this.runSkillRuntimeInvocation(async () => {
      const invocation = this.skillRuntimeInvocationStorage.getStore();
      const promptOptions = {
        ...(options ?? {}),
        preflightResult: (disposition: "handled" | "queued" | "started") => {
          if (invocation) invocation.disposition = disposition;
          options?.preflightResult?.(disposition);
          if (disposition === "handled" && invocation) {
            this.settleSkillRuntimeInvocation(invocation);
          }
        },
      } as Parameters<AgentSessionLike["prompt"]>[1];
      return original.call(target, text, promptOptions);
    });
  }

  private runPatchedQueue(
    target: SkillRuntimePatchedSession,
    original: SkillRuntimeQueueMethod,
    _kind: "steer" | "followUp",
    text: string,
    images?: Parameters<AgentSessionLike["steer"]>[1],
    options?: SkillRuntimeQueueOptions,
  ): Promise<"handled" | "queued"> {
    if (this.stopAllRequested) return Promise.reject(new Error("Session execution was stopped; a new user input is required"));
    return this.runSkillRuntimeInvocation(async () => {
      const result = await original.call(target, text, images, options);
      if (result === "handled") {
        const invocation = this.skillRuntimeInvocationStorage.getStore();
        if (invocation) this.settleSkillRuntimeInvocation(invocation);
      }
      return result;
    });
  }

  private promptWithDisplayTracking(
    text: string,
    options?: Parameters<AgentSessionLike["prompt"]>[1],
    clientMessageId?: string,
  ): Promise<void> {
    if (clientMessageId !== undefined) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(clientMessageId)) throw new Error("Invalid clientMessageId");
      if (!this.controlQueueCaptureRestore) throw new Error("Client message identity capture is unavailable");
      const entries = this.inner.sessionManager.getEntries() as unknown as SessionEntry[];
      if (this.submittedClientMessageIds.has(clientMessageId) || [...historyClientMessageIds(entries).values()].includes(clientMessageId)) throw new Error("clientMessageId was already submitted; inspect history before retrying");
      this.submittedClientMessageIds.add(clientMessageId);
    }
    if (this.skillRuntimeContext && !this.skillRuntimeAdmissionInstalled) {
      throw this.skillRuntimeAdmissionUnavailable(
        "Pi SDK Skill admission boundary is unavailable; refusing an unadmitted prompt",
      );
    }
    const extensionOwnsCommand = this.isRegisteredExtensionCommand(text);
    let route: ReturnType<typeof routeSkillCommand> = null;
    // A real SDK session is admitted at _expandSkillCommand so native prompt,
    // steer, followUp, extension sendUserMessage, and post-input transforms
    // share one lifecycle. Keep this route only for reduced test doubles or
    // older SDKs that do not expose that private boundary.
    if (!this.skillRuntimeAdmissionInstalled && !extensionOwnsCommand && text.startsWith("/skill:")) {
      try {
        route = routeSkillCommand(text, {
          skills: this.inner.resourceLoader.getSkills().skills as RuntimeSkillLike[],
          ...(this.skillRuntimeContext ? { context: this.skillRuntimeContext } : {}),
        });
      } catch (error) {
        if (error instanceof SkillRuntimeRouteError) {
          this.skillRuntimeTracker.reject(error.skillName, error.policy, this.currentSystemPrompt(), error.code);
        }
        throw error;
      }
    }
    const runtimeToken = route ? this.skillRuntimeTracker.begin(route, this.currentSystemPrompt()) : undefined;
    const pending = extensionOwnsCommand ? undefined : this.enqueuePromptDisplayInput(text);
    const wasStreaming = this.inner.isStreaming;
    let promptDisposition: "handled" | "queued" | "started" | undefined;
    const promptOptions = route
      ? {
          ...(options ?? {}),
          preflightResult: (disposition: "handled" | "queued" | "started") => {
            promptDisposition = disposition;
            options?.preflightResult?.(disposition);
          },
        } as Parameters<AgentSessionLike["prompt"]>[1]
      : options;
    try {
      // Reader only admits the exact skill against its policy here. The SDK
      // still owns the actual /skill:name expansion, input handlers, queue
      // ordering, and before_agent_start timing; keep that native path intact.
      const invoke = () => this.inner.prompt(text, promptOptions);
      const prompt = clientMessageId ? this.clientMessageAdmission.run({ id: clientMessageId, claimed: false }, invoke) : invoke();
      const discardOnSuccess = (result: void) => {
        if (runtimeToken && promptDisposition !== "queued") {
          this.skillRuntimeTracker.settle(runtimeToken, this.currentSystemPrompt());
        }
        if (pending && !wasStreaming) this.discardPendingPromptDisplayInput(pending);
        return result;
      };
      return prompt.then(discardOnSuccess, (error) => {
        if (runtimeToken) this.skillRuntimeTracker.settle(runtimeToken, this.currentSystemPrompt(), "settled", "prompt-error");
        if (pending) this.discardPendingPromptDisplayInput(pending);
        throw error;
      });
    } catch (error) {
      if (runtimeToken) this.skillRuntimeTracker.settle(runtimeToken, this.currentSystemPrompt(), "settled", "prompt-error");
      if (pending) this.discardPendingPromptDisplayInput(pending);
      throw error;
    }
  }

  /** Persist prompt-template input separately so previews can show what the user typed. */
  private flushPendingPromptDisplayInputForMessage(): void {
    const pending = this.pendingPromptDisplayInputs.shift();
    if (!pending?.input) return;

    const entries = this.inner.sessionManager.getEntries() as unknown as SessionEntry[];
    const targetEntry = [...entries].reverse().find((entry) => entry.type === "message" && entry.message.role === "user");
    if (!targetEntry || targetEntry.type !== "message") {
      this.pendingPromptDisplayInputs.unshift(pending);
      return;
    }

    try {
      this.persistSessionFileNow();
      this.inner.sessionManager.appendCustomEntry(SESSION_DISPLAY_INPUT_CUSTOM_TYPE, {
        targetEntryId: targetEntry.id,
        input: pending.input,
      });
      invalidateSessionReadCache(this.sessionFile);
      invalidateSessionListCache();
    } catch (error) {
      console.error("[pi-web] failed to persist original prompt-template input:", error instanceof Error ? error.message : error);
    }
  }

  /**
   * Bind composer question-analysis results to the user message that carried
   * them. The SDK persists message_end entries right after notifying listeners,
   * so by the time this runs the user entry exists in the SessionManager and we
   * can resolve its entry id. A snapshot is stored per target user entry as a
   * display-only custom record; it never enters buildSessionContext().
   */
  private flushPendingQuestionAnalysisForMessage(
    content: unknown,
    timestamp: unknown,
  ): void {
    if (this.pendingPromptQuestionAnalysis.length === 0) return;
    const targetText = messageTextFor(content);
    if (!targetText) return;
    const requestedAt = typeof timestamp === "number" ? timestamp : Date.now();

    const entries = this.inner.sessionManager.getEntries() as unknown as SessionEntry[];
    let targetEntryId: string | null = null;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.type !== "message" || entry.message.role !== "user") continue;
      if (messageTextFor(entry.message.content) !== targetText) continue;
      targetEntryId = entry.id;
      break;
    }
    if (!targetEntryId) return;

    // Superseded metadata (a rejected prompt) is dropped; consumed entries are
    // kept out of the pending list because they are already durable.
    const unconsumed: QuestionAnalysisPromptMetadata[] = [];
    for (const metadata of this.pendingPromptQuestionAnalysis) {
      const rewrittenText = metadata.rewrite?.text?.trim();
      const matches = metadata.question === targetText
        || (Boolean(rewrittenText) && rewrittenText === targetText);
      if (!matches) {
        unconsumed.push(metadata);
        continue;
      }
      const snapshot: QuestionDraftEntryData = {
        version: QUESTION_DRAFT_VERSION,
        jobId: draftAnalysisJobId(this.cwd, targetText),
        targetEntryId,
        requestedAt,
        result: metadata.result,
        ...(metadata.rewrite ? { rewrite: metadata.rewrite } : {}),
      };
      try {
        this.persistSessionFileNow();
        this.inner.sessionManager.appendCustomEntry(QUESTION_DRAFT_CUSTOM_TYPE, draftQuestionAnalysisData(snapshot));
        invalidateSessionListCache();
      } catch (error) {
        console.error("[pi-web] failed to persist draft question analysis:", error instanceof Error ? error.message : error);
      }
    }
    this.pendingPromptQuestionAnalysis = unconsumed;
  }

  private appendQuestionAnalysisEntry(data: QuestionAnalysisJobEntryData): void {
    if (this.shuttingDown) throw new Error("Session is shutting down");
    this.persistSessionFileNow();
    this.inner.sessionManager.appendCustomEntry(QUESTION_ANALYSIS_CUSTOM_TYPE, data);
    invalidateSessionListCache();
  }

  private scheduleQuestionAnalysisJob(job: QuestionAnalysisJob): void {
    if (!this._alive || this.shuttingDown || this.questionAnalysisJobs.has(job.jobId)) return;
    const sessionFile = this.sessionFile;
    if (!sessionFile) return;
    let releaseLock: (() => void) | null = null;
    try {
      releaseLock = acquireQuestionAnalysisJobLock(sessionFile, job.jobId);
    } catch (error) {
      console.error("[pi-web] failed to claim terminology job:", error instanceof Error ? error.message : error);
      return;
    }
    if (!releaseLock) return;

    this.questionAnalysisJobs.add(job.jobId);
    this.resetIdleTimer();
    notifyRunningChange();
    void this.runQuestionAnalysisJob(job, releaseLock);
  }

  private async runQuestionAnalysisJob(job: QuestionAnalysisJob, releaseLock: () => void): Promise<void> {
    try {
      if (!this._alive || this.shuttingDown) return;
      const startedAt = Date.now();
      this.appendQuestionAnalysisEntry(runningQuestionAnalysisData(job, startedAt));
      const result = await this.completeQuestionAnalysis(job);
      if (!this._alive || this.shuttingDown) return;
      this.appendQuestionAnalysisEntry(completedQuestionAnalysisData(job, Date.now(), result));
    } catch (error) {
      if (this._alive && !this.shuttingDown) {
        try {
          this.appendQuestionAnalysisEntry(failedQuestionAnalysisData(
            job,
            Date.now(),
            error instanceof Error ? error.message : String(error),
          ));
        } catch (appendError) {
          console.error("[pi-web] failed to persist terminology job failure:", appendError instanceof Error ? appendError.message : appendError);
        }
      }
    } finally {
      releaseLock();
      this.questionAnalysisJobs.delete(job.jobId);
      this.resetIdleTimer();
      notifyRunningChange();
    }
  }

  private async startQuestionAnalysisJob(
    question: string,
    options: { mode?: QuestionAnalysisMode; entryId?: string } = {},
  ): Promise<QuestionAnalysisJobView> {
    const prepared = this.prepareQuestionAnalysisJob(question, options);
    const admissionLock = acquireQuestionAnalysisJobLock(this.sessionFile, `admission:${prepared.targetEntryId}`);
    if (!admissionLock) throw new Error("Another terminology job is being created for this question");
    try {
      const existing = latestQuestionAnalysisJobs(
        this.inner.sessionManager.getEntries() as unknown as SessionEntry[],
        new Set([prepared.targetEntryId]),
      )[0];
      if (existing && (existing.status === "pending" || existing.status === "running")) {
        this.scheduleQuestionAnalysisJob(existing);
        return toQuestionAnalysisJobView(existing);
      }

      const job: QuestionAnalysisJob = { ...prepared, status: "pending" };
      this.appendQuestionAnalysisEntry(pendingQuestionAnalysisData(job));
      this.scheduleQuestionAnalysisJob(job);
      return toQuestionAnalysisJobView(job);
    } finally {
      admissionLock();
    }
  }

  /** Resume pending terminology work found in durable custom entries. */
  restoreQuestionAnalysisJobs(jobs: QuestionAnalysisJob[]): void {
    for (const job of jobs) {
      if (isResumableQuestionAnalysisJob(job)) this.scheduleQuestionAnalysisJob(job);
    }
  }

  private assertInputGeneration(generation: number): void {
    if (generation !== (this.inputStopGeneration ?? 0)) throw new Error(MCP_WAIT_STOPPED_MESSAGE);
  }

  private async prepareInputRuntime(generation: number): Promise<AbortSignal> {
    this.assertInputGeneration(generation);
    if (this.extensionUiAbortController.signal.aborted) this.extensionUiAbortController = new AbortController();
    const signal = this.extensionUiAbortController.signal;
    if (!this.inner.isCompacting) this.restoreDeferredCompaction();
    if (this.schedulerState) this.clearScheduler("manual");
    this.abortRequested = false;
    await this.syncModelConfigIfStale().catch(() => {});
    this.assertInputPreparationActive(signal);
    await this.refreshRemoteClaudeHostBinding();
    this.assertInputPreparationActive(signal);
    return signal;
  }

  private assertInputPreparationActive(signal: AbortSignal): void {
    if (signal.aborted || signal !== this.extensionUiAbortController.signal) throw new Error(MCP_WAIT_STOPPED_MESSAGE);
  }

  private async prepareMcpForInput(message: string, signal: AbortSignal): Promise<void> {
    this.assertInputPreparationActive(signal);
    const preparation = this.mcpHost && !this.inner.isStreaming
      ? mcpPromptPreparation(message, this.extensionCommandCandidates()) : "none";
    if (!this.mcpHost || preparation === "none") return;
    const controller = new AbortController();
    const waited = this.mcpHost.prepareForPrompt(controller.signal, { wait: preparation === "wait" })
      .catch((error: unknown) => {
        console.error("[pi-web] MCP servers could not be prepared:", error instanceof Error ? error.message : error);
      }).then(() => { if (controller.signal.aborted) throw new Error(MCP_WAIT_STOPPED_MESSAGE); });
    const wait = { controller, done: waited.then(() => undefined, () => undefined) };
    this.mcpPromptWait = wait;
    try { await waited; } finally { if (this.mcpPromptWait === wait) this.mcpPromptWait = null; }
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    // A committed recall is storage recovery, independent of a replacement
    // runtime's SDK capabilities or mutation/admission gates.
    if (command.type === "clear_queue" && typeof command.queueRecallOperationId === "string") {
      const identity = command.expectedQueueIdentity as QueueRecallIdentity;
      const replay = readQueueRecallResult(this.sessionId, command.queueRecallOperationId, identity);
      if (replay) { await this.settleQueueRecall(command.queueRecallOperationId, identity); return replay; }
    }
    if (command.requireQueueIdentity === true && !this.queueIdentityTracker) {
      throw Object.assign(new Error("This SDK cannot safely identify or recall queued attachments"), { code: "queue_identity_unavailable" });
    }
    if (this.managedSettingPending && !String(command.type).startsWith("get_") && command.type !== "abort") {
      throw Object.assign(new Error("A managed live setting is pending"), { code: "runtime_busy" });
    }
    const receiptId = typeof command.readerControlReceiptId === "string" ? command.readerControlReceiptId : undefined;
    if (receiptId && command.type === "clear_queue" && !this.readSdkQueuedMessages()) {
      throw new Error("Reader managed clear_queue requires observable SDK core queues");
    }
    if (receiptId && this.controlReceiptBindings.has(receiptId) && this.controlReceiptAdmissionStorage.getStore() !== receiptId) {
      if (["prompt", "steer", "follow_up"].includes(String(command.type)) && !this.controlQueueCaptureRestore) {
        throw new Error("Reader managed queue identity requires the SDK synchronous enqueue boundary");
      }
      return this.controlReceiptAdmissionStorage.run(receiptId, () => this.send(command));
    }
    if (command.type === "navigate_tree") {
      if (this.treeNavigationPending || this.isRunning()) throw new Error("Wait for the current operation before navigating");
      this.treeNavigationPending = true;
      try {
        return await this.sendCommand(command);
      } finally {
        this.treeNavigationPending = false;
      }
    }
    if (this.treeNavigationPending && !String(command.type).startsWith("get_") && command.type !== "abort") {
      throw new Error(BRANCH_NAVIGATION_PENDING);
    }
    if (command.type === "set_model" || command.type === "set_tools") {
      return withToolMutationLock(this.sessionId, async () => {
        this.assertWriteOpen();
        this.managedSettingPending = true;
        try { return await this.sendCommand(command); }
        finally { this.managedSettingPending = false; }
      });
    }
    return this.sendCommand(command);
  }

  private async sendCommand(command: Record<string, unknown>): Promise<unknown> {
    const type = command.type as string;
    // Capture before extension binding or admission can yield. A later input
    // may reset the UI signal, but cannot revive work submitted before Stop.
    const inputGeneration = this.inputStopGeneration ?? 0;
    const isInput = ["prompt", "steer", "follow_up", "peer_message"].includes(type);
    if (this.stopAllPromise && !type.startsWith("get_") && !["abort", "abort_bash", "abort_compaction", "stop_all"].includes(type)) {
      throw new Error("Session execution is stopping");
    }
    if (!this._alive) {
      if (this.shuttingDown && !this.disposed && type !== "get_state") throw new Error("Session is shutting down");
      throw new Error("Session is no longer available");
    }
    if (this.shuttingDown && type !== "get_state") throw new Error("Session is shutting down");
    if (type !== "get_state") this.resetIdleTimer();
    if (this.shouldWaitForExtensions(type)) await this.waitForExtensionsBound();
    if (isInput || type === "retry_continue" || type === "retry_continue_only") this.assertInputGeneration(inputGeneration);
    if (isInput && type !== "peer_message") this.stopAllRequested = false;
    if (type === "peer_message" && this.stopAllRequested) throw new Error("Session execution was stopped; a new user input is required");
    if (!["get_state", "abort", "abort_bash", "abort_compaction", "stop_all"].includes(type)) this.assertWriteOpen();
    if (this.treeNavigationPending && type !== "navigate_tree" && !type.startsWith("get_") && type !== "abort") {
      throw new Error(BRANCH_NAVIGATION_PENDING);
    }
    if (Object.hasOwn(command, "expectedLeafId") && !matchesExpectedLeaf(this.inner.sessionManager, command.expectedLeafId)) {
      throw new Error(BRANCH_POSITION_CHANGED);
    }
    if (command.readerControlReceiptId) this.assertManagedControlIdentity({ bootId: command.readerControlExpectedBootId, revision: command.readerControlExpectedRevision });

    if (type === "prompt" || type === "steer" || type === "follow_up") {
      const imageError = validateAgentImages(command.images);
      if (imageError) throw new Error(imageError);
    }

    switch (type) {
      case "peer_message": {
        const envelope = command.envelope as SessionMessage | undefined;
        const delivery = command.delivery;
        if (!envelope || envelope.version !== 1 || !/^[a-f0-9]{64}$/.test(envelope.id)
          || envelope.recipient !== this.sessionId || !["prompt", "steer", "follow_up"].includes(String(delivery))) {
          throw new Error("Invalid peer message identity or delivery");
        }
        await this.sendNativePeerMessage(renderSessionMessage(envelope), {
          ...(delivery === "prompt" ? {} : { delivery: delivery as "steer" | "follow_up" }),
          triggerTurn: true, inputGeneration,
          ...(typeof command.beforeSubmit === "function" ? { beforeSubmit: command.beforeSubmit as () => boolean } : {}),
        });
        return { messageId: envelope.id, accepted: true };
      }
      case "analyze_question": {
        return this.startQuestionAnalysisJob(
          typeof command.message === "string" ? command.message : "",
          {
            mode: command.contextMode === "context" ? "context" : "question",
            entryId: typeof command.entryId === "string" ? command.entryId : undefined,
          },
        );
      }

      case "analyze_question_draft": {
        return this.completeQuestionDraft(
          typeof command.question === "string" ? command.question : "",
          command.contextMode === "context" ? "context" : "question",
        );
      }

      case "rewrite_question": {
        return this.completeQuestionRewrite(
          typeof command.question === "string" ? command.question : "",
          typeof command.terms === "string" ? command.terms : "",
        );
      }

      case "rewrite_ste100": {
        return this.completeSte100Rewrite(
          typeof command.question === "string" ? command.question : "",
        );
      }

      case "prompt": {
        const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
        const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        if (streamingBehavior && this.inner.isCompacting && command.deferCompactionQueue !== true) {
          // This Reader-owned enqueue is the admission effect. A later flush
          // must not recheck the revision advanced by its own queue_update.
          this.consumeManagedControlIdentity(typeof command.readerControlReceiptId === "string" ? command.readerControlReceiptId : undefined);
          this.initializeUnattendedDefault();
          this.deferPromptDuringCompaction({
            kind: "prompt",
            message: command.message as string,
            ...(typeof command.clientMessageId === "string" ? { clientMessageId: command.clientMessageId } : {}),
            ...(promptImages?.length ? { images: promptImages } : {}),
            streamingBehavior,
            ...(typeof command.readerControlReceiptId === "string" ? { readerControlReceiptId: command.readerControlReceiptId } : {}),
          });
          const binding = this.controlReceiptBindings.get(String(command.readerControlReceiptId ?? ""));
          if (binding) {
            binding.phase = "queued";
            binding.queueKind = streamingBehavior === "steer" ? "steering" : "followUp";
            binding.queueMessage = messageTextFor(command.message);
          }
          return null;
        }
        // Serialize only admission. Once the preceding prompt has either
        // passed or failed preflight, the SDK can atomically decide whether
        // this submission starts a run or joins its streaming queue.
        const releaseAdmission = await this.acquirePromptAdmission();
        // Recall may remove this item while admission is waiting; do not prepare it.
        const deferredToken = command.deferredQueueToken as { stillQueued?: () => boolean; beginSubmit?: () => boolean } | undefined;
        if (typeof deferredToken?.stillQueued === "function" && !deferredToken.stillQueued()) {
          releaseAdmission();
          return null;
        }
        // Draft question-analysis belongs to exactly one prompt: supersede any
        // earlier unconsumed metadata (e.g. after a rejected prompt) so a stale
        // draft can never bind to a later, unrelated message. Steer/follow-up
        // prompts never carry draft metadata and must not clear a queued draft.
        if (!streamingBehavior) {
          this.pendingPromptQuestionAnalysis = this.parsePromptQuestionAnalysis(command.questionAnalysis);
        }
        try {
          if (command.readerControlReceiptId) this.assertManagedControlIdentity({ bootId: command.readerControlExpectedBootId, revision: command.readerControlExpectedRevision });
          if (this.inner.isBashRunning) {
            throw new Error("Cannot send a prompt while a shell command is running");
          }
          let preflightAccepted = false;
          let preflightSettled = false;
          let promptSettled = false;
          let acceptPreflight!: () => void;
          let rejectPreflight!: (error: unknown) => void;
          const preflight = new Promise<void>((resolve, reject) => {
            acceptPreflight = () => {
              preflightAccepted = true;
              if (preflightSettled) return;
              if (!command.readerControlReceiptId) this.initializeUnattendedDefault();
              preflightSettled = true;
              resolve();
            };
            rejectPreflight = (error) => {
              if (preflightSettled) return;
              preflightSettled = true;
              reject(error);
            };
          });
          const finishPrompt = () => {
            if (promptSettled) return;
            promptSettled = true;
            this.pendingPromptCount = Math.max(0, this.pendingPromptCount - 1);
            this.resetIdleTimer();
            notifyRunningChange();
          };

          const inputSignal = await this.prepareInputRuntime(inputGeneration);
          this.pendingPromptCount += 1;
          notifyRunningChange();
          try { await this.prepareMcpForInput(typeof command.message === "string" ? command.message : "", inputSignal); this.assertInputPreparationActive(inputSignal); }
          catch (error) { finishPrompt(); throw error; }
          let prompt: Promise<void>;
          try {
            this.assertWriteOpen();
            if (command.readerControlReceiptId) this.assertManagedControlIdentity({ bootId: command.readerControlExpectedBootId, revision: command.readerControlExpectedRevision });
            // Keep Recall atomic with the SDK handoff after all preparation awaits.
            if (deferredToken?.beginSubmit && !deferredToken.beginSubmit()) {
              finishPrompt();
              return null;
            }
            prompt = this.promptWithDisplayTracking(command.message as string, {
              ...(promptImages?.length ? { images: promptImages } : {}),
              ...(streamingBehavior ? { streamingBehavior } : {}),
              source: "rpc",
              // Match pi's RPC contract: acknowledge only after synchronous prompt
              // validation and extension preflight have accepted the submission.
              preflightResult: (success) => {
                this.markControlReceiptAdmission(command, success);
                if (success) acceptPreflight();
              },
            }, typeof command.clientMessageId === "string" ? command.clientMessageId : undefined);
          } catch (error) {
            finishPrompt();
            throw error;
          }

          void prompt.then(() => {
            // Compatibility fallback if a future SDK resolves without invoking
            // the internal callback. This waits for the run, but never acks early.
            acceptPreflight();
            finishPrompt();
            if (!streamingBehavior) this.emitPromptDone(typeof command.clientMessageId === "string" ? command.clientMessageId : undefined);
          }, (error) => {
            rejectPreflight(error);
            finishPrompt();
            invalidateSessionListCache();
            // A preflight rejection is returned by the POST itself. Only an
            // unexpected failure after acceptance needs the asynchronous event.
            if (preflightAccepted) {
              this.emit({
                type: "prompt_error",
                errorMessage: error instanceof Error ? error.message : String(error),
              });
              if (!streamingBehavior) this.emitPromptDone(typeof command.clientMessageId === "string" ? command.clientMessageId : undefined);
            }
          }).catch((error) => {
            console.error(
              "[pi-web] prompt completion handler failed:",
              error instanceof Error ? error.message : error,
            );
          });

          await preflight;
          return null;
        } finally {
          releaseAdmission();
        }
      }

      case "stop_all":
        return this.stopAllExecution();

      case "set_unattended": {
        this.setUnattendedEnabled(Boolean(command.enabled));
        return { enabled: this.unattendedEnabled, configured: this.unattendedConfigured, state: this.getSchedulerState() };
      }

      case "get_unattended": {
        return { enabled: this.unattendedEnabled, configured: this.unattendedConfigured, state: this.getSchedulerState() };
      }

      case "retry_continue":
      case "retry_continue_only": {
        const retryOnly = type === "retry_continue_only";
        if (this.inner.isBashRunning) {
          throw new Error("Cannot retry while a shell command is running");
        }
        if (this.promptRunning || this.inner.isStreaming) {
          throw new Error("Agent is already running");
        }
        if (Object.hasOwn(command, "expectedRunId")) {
          const latestRun = getSessionRunRecords().find((run) => run.sessionId === this.sessionId);
          if (typeof command.expectedRunId !== "string" || !command.expectedRunId
            || !latestRun || latestRun.runId !== command.expectedRunId
            || !["unknown", "failed"].includes(latestRun.status)) {
            throw Object.assign(new Error("The session run changed; refresh activity before continuing"), { code: "retry_target_changed" });
          }
          const execution = this.getExecutionState();
          if (execution.active || execution.queuedCount > 0 || this.hasPendingUserInteraction()) {
            throw Object.assign(new Error("The session has active work, queued input or a pending question"), { code: "runtime_busy" });
          }
        }
        if (retryOnly) {
          const retryMessages = this.inner.agent?.state?.messages;
          const retryIndex = retryMessages
            ? continueRetryIndex(retryMessages as Parameters<typeof continueRetryIndex>[0])
            : -1;
          const retryMode = retryMessages && continueRetryMode(
            retryMessages as Parameters<typeof continueRetryMode>[0],
          );
          if (!retryMessages || retryIndex < 0 || retryMode === "none") {
            throw Object.assign(new Error("No continue turn is available to retry"), {
              code: "retry_unavailable",
            });
          }
        }
        this.initializeUnattendedDefault();
        if (this.schedulerState) this.clearScheduler("manual");
        this.stopAllRequested = false;
        this.abortRequested = false;
        this.restoreDeferredCompaction();
        this.promptRunning = true;
        notifyRunningChange();
        void this.retryLastFailedTurn().then(() => {
          this.promptRunning = false;
          this.resetIdleTimer();
          this.emitPromptDone();
          notifyRunningChange();
        }).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          if (!retryOnly && /No continue turn is available to retry/.test(message)) {
            // 客户端按已加载消息判定可重试，但 live 消息可能已被上次重试剥离
            // 或已产出真实输出：重试轮次不存在时降级为发送「继续」消息，任务
            // 仍能推进，不再向用户抛 "No continue turn is available to retry"。
            this.promptWithDisplayTracking("继续", { source: "rpc" }).then(() => {
              this.promptRunning = false;
              this.resetIdleTimer();
              this.emitPromptDone();
              notifyRunningChange();
            }).catch((promptError) => {
              this.promptRunning = false;
              this.resetIdleTimer();
              invalidateSessionListCache();
              this.emit({
                type: "prompt_error",
                errorMessage: promptError instanceof Error ? promptError.message : String(promptError),
              });
              this.emitPromptDone();
              notifyRunningChange();
            });
            return;
          }
          this.promptRunning = false;
          this.resetIdleTimer();
          invalidateSessionListCache();
          this.emit({
            type: "prompt_error",
            errorMessage: message,
          });
          this.emitPromptDone();
          notifyRunningChange();
          if (this.unattendedEnabled) this.scheduleNextBackoff(message);
          this.notifyAgentStateChanged();
        });
        return null;
      }

      case "abort":
        if (command.readerControlReceiptId && !this.currentRunId) throw Object.assign(new Error("There is no active Reader run to abort"), { code: "no_active_run" });
        this.inputStopGeneration = (this.inputStopGeneration ?? 0) + 1;
        this.abortRequested = true;
        this.extensionUiAbortController.abort(new DOMException("Extension UI cancelled by Stop", "AbortError"));
        this.clearScheduler("manual");
        recordSessionRunAbort(this.sessionId, this.unattendedEnabled, this.currentRunId);
        // Stop must withdraw a prompt still waiting for MCP servers before it
        // starts a model run; the message is returned unsent to the composer.
        if (this.mcpPromptWait) {
          const wait = this.mcpPromptWait;
          wait.controller.abort();
          await wait.done;
        }
        try {
          await this.withFinalRunningNotification(() => this.abortWithFallback());
        } finally {
          this.clearScheduler("manual");
        }
        // SDK abort stops the current run; it does not clear the core or
        // deferred queues. Keep their receipt bindings until they really run
        // or an explicit clear_queue removes their exact message objects.
        return null;

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        let promptState: { systemPrompt: string; runtimeInspection: ReturnType<typeof buildRuntimeInspection> } | undefined;
        if (command.systemPrompt !== false) {
          const systemPrompt = this.inner.agent.state?.systemPrompt ?? "";
          // Before the first run, the rendered prompt is exposed through inner.systemPrompt.
          const liveSystemPrompt = this.forceEmptySystemPrompt ? "" : systemPrompt || this.inner.systemPrompt || "";
          const skillRuntimeEvidence = this.skillRuntimeTracker.snapshot(liveSystemPrompt);
          const runtimeInspection = buildRuntimeInspection(this.inner, undefined, liveSystemPrompt, skillRuntimeEvidence);
          const estimatedInputCost = await this.estimateSystemPromptCost(
            runtimeInspection.systemPrompt.sha256,
            runtimeInspection.systemPrompt.estimatedTokens ?? 0,
            model,
          );
          if (estimatedInputCost) {
            runtimeInspection.systemPrompt = { ...runtimeInspection.systemPrompt, estimatedInputCost };
          }
          promptState = { systemPrompt: liveSystemPrompt, runtimeInspection };
        }
        const queueIdentity = this.getQueueIdentity();
        const state = {
          cwd: this.cwd,
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
          branchPosition: {
            leafId: typeof this.inner.sessionManager.getLeafId === "function"
              ? this.inner.sessionManager.getLeafId()
              : null,
            pending: this.treeNavigationPending,
          },
          execution: this.getExecutionState(),
          isStreaming: this.inner.isStreaming,
          isPromptRunning: this.promptRunning || this.pendingPromptCount > 0,
          isBashRunning: this.inner.isBashRunning,
          isCompacting: this.inner.isCompacting,
          strictToolAllowlist: this.strictToolAllowlist,
          autoCompactionEnabled: this.reportedAutoCompactionEnabled(),
          autoRetryEnabled: this.inner.autoRetryEnabled,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: queueIdentity.counts.total,
          queuedMessages: this.queuedMessages(),
          queueSnapshot: this.queueIdentityTracker?.snapshot(this.deferredCompactionPrompts) ?? null,
          queueRevision: queueIdentity.revision,
          queueCounts: queueIdentity.counts,
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          ...promptState,
          // Reader local patch: when the agent has no explicit level, report
          // the effective settings default (e.g. max) instead of a bare "off".
          thinkingLevel: this.inner.agent.state?.thinkingLevel
            ?? this.inner.settingsManager.getDefaultThinkingLevel()
            ?? "off",
          fastMode: this.getFastModeStatus(),
          extensionStatuses: this.getExtensionStatuses(),
          extensionUsages: this.getExtensionUsages(),
          extensionWidgets: this.getExtensionWidgets(),
          editorSuggestion: this.editorSuggestion,
        };
        return state;
      }

      case "set_model": {
        this.resetModelRoutingCycle();
        const { provider, modelId, thinkingLevel: requestedThinkingLevel } = command as {
          provider: string;
          modelId: string;
          thinkingLevel?: string;
        };
        let model = this.inner.modelRuntime.getModel(provider, modelId);
        if (!model) {
          await this.inner.modelRuntime.refresh({ allowNetwork: false });
          model = this.inner.modelRuntime.getModel(provider, modelId);
        }
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        this.assertWriteOpen();
        await this.inner.setModel(model);
        await this.refreshRemoteClaudeHostBinding();
        const reference = `${model.provider}/${model.id}`;
        const thinkingDefaults = getModelThinkingDefaults(readModelsConfig());
        let thinkingPin: string | undefined;
        try {
          const scope = await resolveVisibleModels(
            this.inner.modelRuntime as unknown as import("@earendil-works/pi-coding-agent").ModelRuntime,
            this.inner.settingsManager.getEnabledModels(),
          );
          thinkingPin = scope.thinkingLevelPins[reference];
        } catch {
          // A malformed legacy scope must not block a model switch.
        }
        const level = resolveDefaultThinkingLevel(
          getSupportedThinkingLevels(model as unknown as PiModel<Api>),
          thinkingDefaults[reference],
          thinkingPin,
        );
        const targetThinkingLevel = requestedThinkingLevel || level;
        const currentThinkingLevel = this.inner.agent?.state?.thinkingLevel as string | undefined;
        if (targetThinkingLevel && currentThinkingLevel !== targetThinkingLevel) {
          this.inner.setThinkingLevel(targetThinkingLevel);
        }
        invalidateSessionReadCache(this.sessionFile);
        invalidateModelsCache();
        invalidateSessionListCache();
        clearSessionCaches(this.sessionId);
        emitActivityEvent({ kind: "session", sessionId: this.sessionId });
        return { id: model.id, provider: model.provider, thinkingLevel: this.inner.agent?.state?.thinkingLevel, fastMode: this.getFastModeStatus() };
      }

      case "fork": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot fork while a shell command is running");
        }
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;

        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");

        const result = await forkPersistedSessionWithManager({
          sourceSessionId: this.sessionId,
          sessionManager,
          currentSessionFile,
          sessionDir: sessionManager.getSessionDir(),
          entryId: command.entryId as string,
          cwd: this.cwd,
        });
        if (!this.isRunning()) await this.shutdown();
        return result;
      }

      case "clone": {
        if (this.inner.isBashRunning || this.inner.isStreaming || this.inner.isCompacting || this.pendingPromptCount > 0) {
          throw new Error("Cannot clone while the session is running");
        }
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;
        const leafId = typeof command.leafId === "string" ? command.leafId : sessionManager.getLeafId();
        const branchHasAssistant = Boolean(
          leafId && sessionManager.getBranch(leafId).some(
            (entry) => entry.type === "message" && entry.message.role === "assistant",
          ),
        );
        if (!sessionManager.isPersisted() || !currentSessionFile || !leafId || !branchHasAssistant) {
          return { cancelled: true };
        }

        const sessionDir = sessionManager.getSessionDir();
        const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
        const clonedPath = sourceManager.createBranchedSession(leafId);
        if (!clonedPath) throw new Error("Failed to clone current session branch");
        const newSessionId = SessionManager.open(clonedPath, sessionDir).getSessionId();
        cacheSessionPath(newSessionId, clonedPath);
        const subprojectAssignmentFailed = !(await inheritSubprojectAssignment(this.sessionId, newSessionId, this.cwd));
        invalidateSessionListCache();
        if (!this.isRunning()) await this.shutdown();
        return { cancelled: false, newSessionId, newSessionPath: clonedPath, ...(subprojectAssignmentFailed ? { subprojectAssignmentFailed: true } : {}) };
      }

      case "navigate_tree": {
        if (this.inner.isBashRunning) throw new Error("Cannot navigate while a shell command is running");
        if (command.before !== undefined && typeof command.before !== "boolean") throw new Error("Navigation before must be boolean");
        const manager = this.inner.sessionManager;
        const activeBefore = this.inner.getActiveToolNames();
        const oldLeafId = manager.getLeafId();
        const metadataAcknowledgement = (targetId: unknown, leafId: string | null) => (
          typeof targetId === "string"
          && leafId !== targetId
          && typeof manager.getEntry === "function"
          && matchesExpectedLeaf(manager, targetId)
            ? { expectedLeafId: targetId, metadataLeaf: true }
            : {}
        );
        let expectedLeafId: string | null | undefined;
        if (command.before === true) {
          const target = typeof command.targetId === "string" ? manager.getEntry(command.targetId) : undefined;
          if (!target || target.type !== "message" || target.message.role !== "user") throw new Error("Navigation before requires a user message");
          expectedLeafId = target.parentId;
          if (expectedLeafId !== null && !manager.getEntry(expectedLeafId)) throw new Error("Navigation parent is unavailable");
          if (oldLeafId === expectedLeafId) return { cancelled: false, leafId: oldLeafId, expectedLeafId };
        }
        if (command.targetId === null || (command.before === true && oldLeafId === command.targetId && expectedLeafId === null)) {
          manager.resetLeaf();
          const sessionContext = manager.buildSessionContext();
          const agent = (this.inner as unknown as { agent?: RetryAgentLike }).agent;
          if (agent?.state) agent.state.messages = sessionContext.messages as RetryAgentMessageLike[];
          this.restoreToolSelectionAfterNavigation(activeBefore);
          this.emit({ type: "session_tree", newLeafId: null, oldLeafId });
          return { cancelled: false, leafId: null, ...(command.before === true ? { expectedLeafId } : {}) };
        }
        if (typeof command.targetId !== "string") throw new Error("Navigation target is required");
        if (command.before === true && oldLeafId === command.targetId && expectedLeafId) {
          const intermediate = await this.navigateTreeKeepingToolSelection(expectedLeafId, {});
          const leafId = manager.getLeafId();
          if (intermediate.cancelled || leafId === expectedLeafId) {
            return { cancelled: intermediate.cancelled, leafId, expectedLeafId };
          }
        }
        const result = await this.navigateTreeKeepingToolSelection(command.targetId, {});
        const leafId = manager.getLeafId();
        const metadata = command.before === true
          ? metadataAcknowledgement(expectedLeafId, leafId)
          : metadataAcknowledgement(command.targetId, leafId);
        return { cancelled: result.cancelled, leafId, editorText: result.editorText,
          ...(command.before === true ? { expectedLeafId, ...metadata } : metadata) };
      }

      case "set_fast_mode": {
        const mode = parseFastModeSelection(command.mode);
        if (!mode) throw new Error(`Invalid Fast mode: ${String(command.mode)}`);
        if (mode === "fast" && !isFastModeSupported(this.inner.model as unknown as FastModeModelLike)) {
          throw new Error("Fast mode is not available for this model");
        }
        this.fastModeState.mode = mode;
        appendSessionFastMode(this.inner.sessionManager, mode);
        const status = this.getFastModeStatus();
        this.emit({ type: "fast_mode_changed", fastMode: status });
        return status;
      }

      case "set_thinking_level": {
        let level = command.level as string;
        if (level === "auto") {
          const model = this.inner.model;
          if (!model) throw new Error("No current model");
          const reference = `${model.provider}/${model.id}`;
          const defaults = getModelThinkingDefaults(readModelsConfig());
          const scope = await resolveVisibleModels(this.inner.modelRuntime as unknown as import("@earendil-works/pi-coding-agent").ModelRuntime, this.inner.settingsManager.getEnabledModels());
          level = resolveDefaultThinkingLevel(getSupportedThinkingLevels(model as unknown as PiModel<Api>), defaults[reference], scope.thinkingLevelPins[reference]) ?? "off";
        }
        if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) throw new Error("Invalid thinking level");
        const sessionManager = this.inner.sessionManager;
        const hadSessionThinkingLevel = readSessionThinkingLevel(sessionManager) !== undefined;
        this.inner.setThinkingLevel(level);
        // setThinkingLevel clamps xhigh→high for models where supportsXhigh()===false.
        // If the model has DeepSeek thinking compat (reasoningEffortMap maps xhigh→max),
        // force the state back so the compat layer can use it correctly.
        if (level === "xhigh" && (this.inner.model as { compat?: { thinkingFormat?: string } } | null)?.compat?.thinkingFormat === "deepseek" && this.inner.agent?.state) {
          this.inner.agent.state.thinkingLevel = "xhigh";
        }
        // An explicit user choice must leave a session marker even when the
        // effective level already matches, so reopening cannot consult a shared default.
        if (!hadSessionThinkingLevel && readSessionThinkingLevel(sessionManager) === undefined) {
          const effectiveLevel = this.inner.agent.state?.thinkingLevel as ThinkingLevel | undefined;
          if (effectiveLevel !== undefined) sessionManager.appendThinkingLevelChange(effectiveLevel);
        }
        invalidateSessionListCache();
        return { thinkingLevel: this.inner.agent.state?.thinkingLevel };
      }

      case "compact": {
        try {
          return await this.withFinalRunningNotification(() => {
            this.restoreDeferredCompaction();
            this.assertWriteOpen();
            return this.inner.compact(command.customInstructions as string | undefined);
          });
        } finally {
          invalidateSessionListCache();
        }
      }

      case "set_session_name": {
        const name = (command.name as string | undefined)?.trim();
        if (!name) throw new Error("Session name cannot be empty");
        this.inner.setSessionName(name);
        // An explicit non-empty name is an intentional durable action even
        // without a user message.
        this.persistSessionFileNow(true);
        invalidateSessionListCache();
        return null;
      }

      case "get_session_stats": {
        // Timing for the viewed branch comes from the read-only session API, live or not.
        return {
          ...this.inner.getSessionStats(),
          // Native SDK usage.cost is producer-side metadata. Reader pricing
          // must come only from /api/sessions/[id]/cost -> genai-prices.
          cost: 0,
          costStatus: "unavailable",
          missingPriceModels: [],
          sessionName: this.inner.sessionManager.getSessionName(),
        };
      }

      case "get_last_assistant_text": {
        return { text: this.inner.getLastAssistantText() ?? "" };
      }

      case "set_auto_compaction": {
        if (typeof command.enabled !== "boolean") throw new Error("Invalid autoCompactionEnabled");
        this.restoreDeferredCompaction();
        const previous = this.reportedAutoCompactionEnabled();
        const previousOverride = this.runtimeAutoCompactionEnabled;
        this.setAutoCompactionEnabledRuntimeOnly(command.enabled);
        try {
          appendSessionAutoCompaction(this.inner.sessionManager, command.enabled);
        } catch (error) {
          applyRuntimeCompactionOverride(this.inner.settingsManager, previous);
          this.runtimeAutoCompactionEnabled = previousOverride;
          throw error;
        }
        invalidateSessionReadCache(this.sessionFile);
        invalidateSessionListCache();
        return null;
      }

      case "clear_queue": {
        const recallOperationId = typeof command.queueRecallOperationId === "string" ? command.queueRecallOperationId : undefined;
        const recallIdentity = command.expectedQueueIdentity as QueueRecallIdentity;
        if (recallOperationId) {
          const replay = readQueueRecallResult(this.sessionId, recallOperationId, recallIdentity);
          if (replay) { await this.settleQueueRecall(recallOperationId, recallIdentity); return replay; }
        }
        if (this.deferredCompactionPrompts.some((prompt) => this.submittingDeferredPrompts.has(prompt))
          || [...this.controlReceiptBindings.values()].some((binding) => binding.phase === "admitting"
            || binding.phase === "starting"
            || (binding.phase === "queued" && (!binding.queueKind || binding.queueMessage === undefined)))) {
          throw Object.assign(new Error("A queued message is entering the runtime; inspect again after admission settles"), { code: "queue_admission_pending" });
        }
        const clearedQueue = this.queueIdentityTracker?.snapshot(this.deferredCompactionPrompts, true) ?? null;
        const expectedQueue = command.expectedQueueIdentity as { bootId?: unknown; queueRevision?: unknown } | undefined;
        if (expectedQueue && (!clearedQueue || expectedQueue.bootId !== clearedQueue.bootId
          || expectedQueue.queueRevision !== clearedQueue.queueRevision)) {
          throw Object.assign(new Error("Reader queue changed before recall; inspect it and try again"), { code: "queue_revision_conflict" });
        }
        if ((expectedQueue || recallOperationId) && clearedQueue) assertUserQueueRecall(clearedQueue);
        const previousQueue = this.getQueueIdentity();
        if (command.expectedQueueRevision !== undefined && command.expectedQueueRevision !== previousQueue.revision) {
          throw Object.assign(new Error("Reader queue revision changed"), {
            code: "queue_revision_conflict",
            queueRevision: previousQueue.revision,
          });
        }
        // The CAS comparison and clear have no await between them. A command
        // admitted before this call cannot clear a subsequently changed queue.
        // Full clear only: pi has no single-item dequeue, and clear+requeue
        // races against the agent loop pulling messages mid-flight.
        const sdkQueued = this.readSdkQueuedMessages();
        const sdkMessageSet = sdkQueued ? new Set([...sdkQueued.steering, ...sdkQueued.followUp]) : new Set<unknown>();
        if (recallOperationId) {
          if (!clearedQueue) throw new Error("Queue recall requires authoritative item identities");
          const replay = prepareQueueRecall(this.sessionId, recallOperationId, recallIdentity, clearedQueue, this.captureQueueRecallSettlements(sdkMessageSet));
          if (replay) { await this.settleQueueRecall(recallOperationId, recallIdentity); return replay; }
        }
        const mirrored = this.inner.clearQueue();
        const cleared = sdkQueued ? {
          steering: sdkQueued.steering.map((message) => messageTextFor((message as { content?: unknown }).content, false)),
          followUp: sdkQueued.followUp.map((message) => messageTextFor((message as { content?: unknown }).content, false)),
        } : mirrored;
        const deferred = this.deferredCompactionPrompts.splice(0);
        const clearedPeerMessageIds = new Set(
          deferred
            .filter((prompt): prompt is DeferredPeerPrompt => prompt.kind === "peer")
            .map((prompt) => prompt.submissionId),
        );
        if (sdkQueued) {
          for (const submission of this.nativePeerSubmissions.values()) {
            if (submission.sdkMessage && sdkQueued.steering.includes(submission.sdkMessage)) {
              clearedPeerMessageIds.add(submission.message.details.messageId);
            }
            if (submission.sdkMessage && sdkQueued.followUp.includes(submission.sdkMessage)) {
              clearedPeerMessageIds.add(submission.message.details.messageId);
            }
          }
        }
        const result = {
          steering: [
            ...cleared.steering,
            ...deferred.filter((prompt): prompt is DeferredUserPrompt => prompt.kind === "prompt" && prompt.streamingBehavior === "steer").map((prompt) => prompt.message),
            ...deferred.filter((prompt): prompt is DeferredPeerPrompt => prompt.kind === "peer" && prompt.delivery === "steer").map((prompt) => prompt.message.content),
          ],
          followUp: [
            ...cleared.followUp,
            ...deferred.filter((prompt): prompt is DeferredUserPrompt => prompt.kind === "prompt" && prompt.streamingBehavior === "followUp").map((prompt) => prompt.message),
            ...deferred.filter((prompt): prompt is DeferredPeerPrompt => prompt.kind === "peer" && prompt.delivery !== "steer").map((prompt) => prompt.message.content),
          ],
        };
        this.emitQueueUpdate();
        const resultingQueueRevision = this.getQueueIdentity().revision;
        const queueSnapshot = this.queueIdentityTracker?.snapshot(this.deferredCompactionPrompts) ?? null;
        const response = {
          ...result,
          clearedQueue,
          queueSnapshot,
          previousQueueRevision: previousQueue.revision,
          queueRevision: resultingQueueRevision,
          clearedCounts: {
            steering: result.steering.length,
            followUp: result.followUp.length,
            total: result.steering.length + result.followUp.length,
          },
        };
        if (recallOperationId) {
          commitQueueRecall(this.sessionId, recallOperationId, recallIdentity, response as QueueRecallResult);
          await this.settleQueueRecall(recallOperationId, recallIdentity);
          return response;
        }
        let nativeSettlementError: unknown;
        try { this.settleClearedNativePeerSubmissions(deferred, sdkMessageSet); }
        catch (error) { nativeSettlementError = error; }
        await this.settleQueuedControlReceipts("Queued control was removed by clear_queue", result, sdkMessageSet, clearedPeerMessageIds);
        if (nativeSettlementError) throw nativeSettlementError;
        return response;
      }

      case "steer":
      case "follow_up": {
        const releaseAdmission = await this.acquirePromptAdmission();
        let completion: Promise<void>;
        try {
          const signal = await this.prepareInputRuntime(inputGeneration);
          await this.prepareMcpForInput(String(command.message ?? ""), signal);
          this.assertInputPreparationActive(signal);
          this.assertWriteOpen();
          if (typeof command.beforeSubmit === "function" && !command.beforeSubmit()) throw new Error("notification_no_longer_pending");
          const images = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
          // Retain SDK input hooks before enqueue (including image transforms).
          completion = this.promptWithDisplayTracking(command.message as string, {
            ...(images?.length ? { images } : {}),
            streamingBehavior: type === "steer" ? "steer" : "followUp",
            source: "rpc",
            preflightResult: (disposition: "handled" | "queued" | "started") => {
              this.markControlReceiptAdmission(command, disposition);
              if (!command.readerControlReceiptId) this.initializeUnattendedDefault();
              if (typeof command.preflightResult === "function") command.preflightResult(disposition);
            },
          } as Parameters<AgentSessionLike["prompt"]>[1], typeof command.clientMessageId === "string" ? command.clientMessageId : undefined);
        } finally { releaseAdmission(); }
        await completion!;
        return null;
      }

      case "get_tools": {
        const all: ToolInfo[] = this.inner.getAllTools();
        const active = new Set<string>(this.inner.getActiveToolNames());
        return all
          .filter((tool) => (tool as ToolInfo & { exposure?: unknown }).exposure !== "hidden")
          .map((t) => ({
            name: t.name,
            description: t.description,
            active: active.has(t.name),
            sourceInfo: t.sourceInfo,
          }));
      }

      case "get_commands": {
        const commands: SlashCommandInfo[] = [];
        for (const registered of this.inner.extensionRunner.getRegisteredCommands()) {
          commands.push({
            name: registered.invocationName,
            description: registered.description,
            source: "extension",
            sourceInfo: registered.sourceInfo,
          });
        }
        for (const template of this.inner.promptTemplates) {
          commands.push({
            name: template.name,
            description: template.description,
            source: "prompt",
            sourceInfo: template.sourceInfo,
          });
        }
        const runtimeSkills = runtimeSkillCommandEntries(
          this.inner.resourceLoader.getSkills().skills,
          this.skillRuntimeContext,
        );
        for (const skill of runtimeSkills) {
          commands.push({
            name: `skill:${skill.name}`,
            description: skill.description,
            source: "skill",
            sourceInfo: skill.sourceInfo,
          });
        }
        return { commands };
      }

      case "set_tools": {
        const toolNames = validateSessionToolSelection(command.toolNames);
        this.setActiveToolSelection(toolNames);
        await this.refreshRemoteClaudeHostBinding();
        appendSessionToolSelection(this.inner.sessionManager, toolNames, {
          strict: this.strictToolAllowlist,
        });
        this.applyForcedEmptySystemPrompt();
        return null;
      }

      case "reload": {
        await this.reloadResources();
        return { success: true };
      }

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      case "extension_ui_response": {
        return this.resolveExtensionUiResponse(command as ExtensionUiResponse);
      }

      case "extension_ui_close": {
        if (typeof command.id === "string") this.closeCustomUi(command.id, undefined);
        return null;
      }

      case "extension_ui_input": {
        this.handleExtensionUiInput(command.id as string, command.data as string);
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      case "bash": {
        if (this.bashExecution || this.pendingPromptCount > 0 || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning) {
          throw new Error("Cannot run a shell command while the session is busy");
        }
        const execution = this.inner.executeBash(
          command.command as string,
          undefined,
          {
            excludeFromContext: command.excludeFromContext as boolean | undefined,
            operations: createProjectCommandBashOperations({
              shellPath: this.inner.settingsManager.getShellPath(),
            }),
          },
        ).then((result) => {
          this.persistSessionFileNow(true);
          return result;
        }).finally(() => {
          this.bashExecution = undefined;
          this.resetIdleTimer();
          invalidateSessionListCache();
          notifyRunningChange();
        });
        this.bashExecution = execution;
        notifyRunningChange();
        return execution;
      }

      case "abort_bash": {
        this.inner.abortBash();
        return null;
      }

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  private preserveSchedulerForRestart(): void {
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    if (this.unattendedEnabled && this.schedulerState?.active) {
      this.persistUnattendedState();
    }
    this.schedulerState = null;
    this.unattendedResumeRequired = false;
  }

  destroyForProcessExit(): void {
    this.preserveSchedulerOnDestroy = true;
    this.destroy();
  }

  /** Dispose the per-session MCP host once, before SDK extension shutdown. */
  private disposeMcpHost(): void {
    if (this.mcpHostDisposed) return;
    this.mcpHostDisposed = true;
    try {
      this.mcpHost?.dispose();
    } catch (error) {
      console.error("[pi-web] MCP host dispose failed:", error instanceof Error ? error.message : error);
    }
  }

  private emitShutdownEvent(): void {
    if (this.shutdownEventEmitted) return;
    this.shutdownEventEmitted = true;
    try {
      invalidateSessionUiRequestWaits({ sessionId: this.sessionId, sessionFile: this.sessionFile,
        runtimeGeneration: this.liveEventBootId, reason: "runtime_closed" });
    } catch (error) {
      console.error("[session-wait] UI subscription shutdown invalidation failed:", error);
    }
    this.notifyUiRequests();
    this.emit({ type: "session_shutdown", reason: "quit" });
  }

  /** Dispose all wrapper-owned state exactly once, after extension shutdown has been attempted. */
  private disposeNow(): void {
    if (this.disposed) return;
    for (const controller of this.questionTaskControllers) controller.abort();
    this.sideAskRuntime?.close();
    this.disposed = true;
    this.shuttingDown = true;
    this._alive = false;
    this.restoreDeferredCompaction();
    if (this.preserveSchedulerOnDestroy) {
      this.preserveSchedulerForRestart();
      this.preserveSchedulerOnDestroy = false;
      this.preserveUnattendedStateOnShutdown = false;
    } else if (this.preserveUnattendedStateOnShutdown
      || (this.unattendedResumeRequired && this.unattendedEnabled && this.schedulerState?.active === true)) {
      this.preserveUnattendedStateOnShutdown = false;
      this.preserveSchedulerForRestart();
    } else {
      this.clearScheduler();
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.compactionPromptFlushTimer) clearTimeout(this.compactionPromptFlushTimer);
    this.compactionPromptFlushTimer = null;
    for (const submission of this.nativePeerSubmissions.values()) {
      if (submission.accepted) {
        this.persistNativePeerOutcome(submission, "failed", "receiver session was destroyed before consuming the peer message");
      } else this.rejectNativePeerSubmission(submission, new Error("Session is no longer available"));
    }
    this.deferredCompactionPrompts = [];
    if (this.inner.isBashRunning) this.inner.abortBash();
    this.unsubscribe?.();
    this.extensionWidgetAdapter.clear(false);
    this.extensionWidgets.clear();
    for (const pending of this.pendingUiResponses.values()) pending.cancel();
    for (const id of Array.from(this.activeCustomUis.keys())) this.closeCustomUi(id, undefined);
    this.pendingUiResponses.clear();
    this.pendingUiRequests.clear();
    this.notifyUiRequests();
    this.uiRequestListeners.clear();
    this.activeToolEvents.clear();
    this.skillRuntimeTracker.settleAll(this.currentSystemPrompt());
    this.skillRuntimeAdmissionRestore?.();
    this.skillRuntimeAdmissionRestore = null;
    this.restoreStoppedCustomMessageAdmission?.();
    this.restoreStoppedCustomMessageAdmission = null;
    this.queueIdentityTracker?.dispose();
    this.controlQueueCaptureRestore?.();
    this.controlQueueCaptureRestore = null;
    this.pendingPromptDisplayInputs = [];
    notifyWaitingUserChange();
    this.clearExtensionWidgets(false);
    try {
      this.inner.dispose();
    } finally {
      this.settleBoundControlReceipts("unknown", "Reader runtime stopped before a terminal control receipt was recorded");
      try {
        recordSessionRunUnknown(this.sessionId, this.currentRunId);
      } finally {
        try {
          this.notifyDestroyedAfterReceiptPersistence();
        } finally {
          notifyRunningChange();
        }
      }
    }
  }

  private async runShutdown(): Promise<void> {
    // Release MCP status and transport ownership before waiting for arbitrary
    // extension handlers. A handler may never return, but the session must
    // still become disposable and stop advertising those connections.
    this.disposeMcpHost();
    const extensionShutdown = (async () => {
      try {
        await this.waitForExtensionsBound();
      } catch (error) {
        console.error(
          "[pi-web] extension binding failed before session shutdown:",
          error instanceof Error ? error.message : error,
        );
      }
      await this.inner.extensionRunner?.emit?.({ type: "session_shutdown", reason: "quit" });
    })();
    const subagentExecution = this.subagentExecution;
    const cancelReaderWrites = Promise.resolve().then(() => {
      subagentExecution?.cancel();
      if (this.inner.isBashRunning) this.inner.abortBash();
    });
    // SDK abort excludes independent bash and Reader's queue/result persistence.
    let writersSettled = false;
    const writerShutdown = Promise.allSettled([extensionShutdown,
      Promise.resolve().then(() => this.runtimeOwnership ? this.inner.abort?.() : undefined),
      cancelReaderWrites, this.bashExecution, subagentExecution?.completion,
    ]).then((results) => {
      writersSettled = results[1].status === "fulfilled" && results[2].status === "fulfilled";
      if (!writersSettled) console.error("[pi-web] SDK abort or Reader cancellation failed; retaining runtime ownership until process exit");
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      await Promise.race([
        extensionShutdown,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, SESSION_SHUTDOWN_DEADLINE_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        console.warn(
          `[pi-web] did not finish session_shutdown for session ${this.inner.sessionId} within ${SESSION_SHUTDOWN_DEADLINE_MS} ms`,
        );
        // The late hook still owns its own promise. Consume a later rejection
        // after the wrapper has been disposed so it cannot become unhandled.
        void writerShutdown.catch(() => undefined);
      }
      try { this.disposeNow(); }
      finally {
        // UI disposal is bounded; admitted writers keep ownership until their real completion.
        if (writersSettled) this.runtimeOwnership?.release();
        else void writerShutdown.then(() => { if (writersSettled) this.runtimeOwnership?.release(); })
          .catch((error) => console.error("[pi-web] runtime ownership release failed:", error));
      }
    }
  }

  destroy(): void {
    if (this.disposed || this.shutdownPromise) return;
    this.sideAskRuntime?.close();
    // Direct destruction is used by process/route cleanup. It still closes the
    // event stream and gives extensions their shutdown hook, but never lets a
    // rejected hook escape into a synchronous caller.
    this.shuttingDown = true;
    this._alive = false;
    this.emitShutdownEvent();
    this.shutdownPromise = this.runShutdown().catch((error) => {
      console.error(
        "[pi-web] extension shutdown failed while destroying session:",
        error instanceof Error ? error.message : error,
      );
    });
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.disposed) return;
    this.sideAskRuntime?.close();

    // Close the write admission gate before awaiting extension shutdown. This
    // prevents a simultaneous recap/prompt/config write from landing after
    // the archive route has decided the session is idle.
    this.shuttingDown = true;
    this._alive = false;
    this.emitShutdownEvent();
    // Teardown is runtime cleanup, not a user preference change. Explicit
    // disable goes through setUnattendedEnabled(false). A restart-paused retry
    // remains durable for the next wrapper, but no longer keeps this wrapper live.
    this.preserveUnattendedStateOnShutdown = this.unattendedResumeRequired
      && this.unattendedEnabled
      && this.schedulerState?.active === true;
    if (!this.preserveUnattendedStateOnShutdown) this.clearScheduler("manual");
    this.shutdownPromise = this.runShutdown();
    return this.shutdownPromise;
  }

  private resolveExtensionUiResponse(response: ExtensionUiResponse & { runtimeGeneration?: string }) {
    if (response.runtimeGeneration !== this.liveEventBootId) throw uiControlError("ui_generation_mismatch", "The request belongs to another runtime generation; read current pending requests");
    const request = this.pendingUiRequests.get(response.id);
    const previous = this.settledUiRequests.get(response.id);
    if (!request) {
      if (previous?.fingerprint) {
        const fingerprint = validateUiResponse(previous.request, response);
        if (fingerprint !== previous.fingerprint) throw uiControlError("ui_request_conflict", "This request was already answered differently");
        return { status: "replayed", id: response.id, runtimeGeneration: this.liveEventBootId, resolution: previous.resolution };
      }
      throw uiControlError(previous ? "ui_request_expired" : "ui_request_unknown", "The request is no longer pending; historical events cannot restore it");
    }
    if (typeof request.expiresAt === "number" && Date.now() >= request.expiresAt) {
      this.pendingUiResponses.get(response.id)?.cancel();
      throw uiControlError("ui_request_expired", "The request has expired");
    }
    const fingerprint = validateUiResponse(request, response);
    const pending = this.pendingUiResponses.get(response.id);
    if (!pending) throw uiControlError("ui_response_invalid", "This custom UI requires its explicit custom interaction channel");
    const resolution = "cancelled" in response ? "cancelled" : "answered";
    // No await between validation and consuming the resolver: concurrent
    // controllers cannot both win this live request.
    this.rememberUiResolution(response.id, { request, fingerprint, resolution });
    pending.resolve(response);
    return { status: "accepted", id: response.id, runtimeGeneration: this.liveEventBootId, resolution };
  }

  private getExtensionStatuses(): Array<{ key: string; text: string }> {
    return Array.from(this.extensionStatuses, ([key, text]) => ({ key, text }));
  }

  private getExtensionUsages(): ExtensionUsageItem[] {
    return Array.from(this.extensionUsages.values());
  }

  private getExtensionWidgets(): ExtensionWidgetItem[] {
    return Array.from(this.extensionWidgets.values());
  }

  private nextExtensionWidgetGeneration(key: string): number {
    const generation = (this.extensionWidgetGenerations.get(key) ?? 0) + 1;
    this.extensionWidgetGenerations.set(key, generation);
    return generation;
  }

  private disposeExtensionWidgetComponent(component: unknown): void {
    if (!component || (typeof component !== "object" && typeof component !== "function")) return;
    const dispose = (component as { dispose?: unknown }).dispose;
    if (typeof dispose !== "function") return;
    try {
      dispose.call(component);
    } catch {
      // Ignore dispose errors from extension widgets.
    }
  }

  private emitExtensionWidgetClear(key: string): void {
    this.emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "setWidget",
      widgetKey: key,
      widgetLines: undefined,
      widgetPlacement: undefined,
    } as AgentEvent);
  }

  private clearExtensionWidget(key: string, emitClear = true): number {
    const generation = this.nextExtensionWidgetGeneration(key);

    const active = this.activeExtensionWidgets.get(key);
    this.activeExtensionWidgets.delete(key);
    this.extensionWidgets.delete(key);
    if (active) this.disposeExtensionWidgetComponent(active.component);
    if (this.extensionWidgetGenerations.get(key) !== generation) return generation;
    if (emitClear) this.emitExtensionWidgetClear(key);
    return generation;
  }

  private clearExtensionWidgets(emitClear: boolean): void {
    const keys = new Set([
      ...this.extensionWidgets.keys(),
      ...this.activeExtensionWidgets.keys(),
    ]);
    for (const key of keys) this.clearExtensionWidget(key, emitClear);
  }

  private resetExtensionWidgetsForReload(): void {
    this.extensionWidgetsResetting = true;
    try {
      const factoryKeys = [...this.activeExtensionWidgets.keys()];
      for (const key of factoryKeys) this.clearExtensionWidget(key);
      // Keep the existing array-widget reload behavior: snapshots are reset and
      // the next extension session_start repopulates them.
      this.extensionWidgets.clear();
    } finally {
      this.extensionWidgetsResetting = false;
    }
  }

  private emitExtensionWidgetError(key: string, error: unknown): void {
    this.emit({
      type: "extension_error",
      extensionPath: `extension-widget:${key}`,
      event: "setWidget",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private failExtensionWidget(
    key: string,
    generation: number,
    error: unknown,
    clearEmitted: boolean,
    component?: unknown,
  ): void {
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.disposeExtensionWidgetComponent(component);
      return;
    }

    const active = this.activeExtensionWidgets.get(key);
    let shouldEmitClear = !clearEmitted;
    if (active?.generation === generation) {
      shouldEmitClear = active.rendered || !active.clearEmitted;
      this.activeExtensionWidgets.delete(key);
      this.disposeExtensionWidgetComponent(active.component);
    } else {
      this.disposeExtensionWidgetComponent(component);
    }
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.emitExtensionWidgetError(key, error);
      return;
    }
    this.extensionWidgets.delete(key);
    if (shouldEmitClear) this.emitExtensionWidgetClear(key);
    this.emitExtensionWidgetError(key, error);
  }

  private renderExtensionWidget(active: ActiveExtensionWidget): void {
    if (
      this.activeExtensionWidgets.get(active.key) !== active
      || this.extensionWidgetGenerations.get(active.key) !== active.generation
    ) return;

    let lines: unknown;
    try {
      lines = active.component.render(DEFAULT_CUSTOM_UI_COLUMNS);
    } catch (error) {
      this.failExtensionWidget(active.key, active.generation, error, active.clearEmitted);
      return;
    }
    if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) {
      this.failExtensionWidget(
        active.key,
        active.generation,
        new Error("Extension widget render must return string[]"),
        active.clearEmitted,
      );
      return;
    }
    if (
      this.activeExtensionWidgets.get(active.key) !== active
      || this.extensionWidgetGenerations.get(active.key) !== active.generation
    ) return;

    const widgetLines = lines as string[];
    this.extensionWidgets.set(active.key, {
      key: active.key,
      lines: widgetLines,
      placement: active.placement,
    });
    active.rendered = true;
    this.emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "setWidget",
      widgetKey: active.key,
      widgetLines,
      widgetPlacement: active.placement,
    } as AgentEvent);
  }

  private setExtensionWidgetFactory(
    key: string,
    factory: ExtensionWidgetFactory,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void {
    const hadPrevious = this.extensionWidgets.has(key) || this.activeExtensionWidgets.has(key);
    const generation = this.clearExtensionWidget(key, hadPrevious);
    if (this.extensionWidgetGenerations.get(key) !== generation) return;
    const tui = createHeadlessCustomUiTui(() => {
      const active = this.activeExtensionWidgets.get(key);
      if (active?.generation === generation) this.renderExtensionWidget(active);
    }, DEFAULT_CUSTOM_UI_COLUMNS);

    let component: unknown;
    try {
      component = factory(tui, PLAIN_TEXT_THEME);
    } catch (error) {
      this.failExtensionWidget(key, generation, error, hadPrevious);
      return;
    }
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.disposeExtensionWidgetComponent(component);
      return;
    }
    if (
      !component
      || (typeof component !== "object" && typeof component !== "function")
      || typeof (component as { render?: unknown }).render !== "function"
    ) {
      this.failExtensionWidget(
        key,
        generation,
        new Error("Extension widget factory must return a component with render(width)"),
        hadPrevious,
        component,
      );
      return;
    }

    const active: ActiveExtensionWidget = {
      key,
      component: component as ExtensionWidgetComponent,
      placement: options?.placement ?? "aboveEditor",
      generation,
      clearEmitted: hadPrevious,
      rendered: false,
    };
    this.activeExtensionWidgets.set(key, active);
    this.renderExtensionWidget(active);
  }

  private getCustomUiWidth(options: unknown): number {
    if (!options || typeof options !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const overlayOptions = (options as { overlayOptions?: unknown }).overlayOptions;
    const resolved = typeof overlayOptions === "function" ? overlayOptions() : overlayOptions;
    if (!resolved || typeof resolved !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const width = (resolved as { width?: unknown }).width;
    return typeof width === "number" && Number.isFinite(width)
      ? Math.max(40, Math.min(140, Math.round(width)))
      : 92;
  }

  private emitCustomUiRender(id: string, custom: ActiveCustomUi): void {
    let lines: string[];
    try {
      lines = custom.component.render(custom.width);
    } catch (error) {
      lines = [`Extension custom UI render failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    const event = {
      type: "extension_ui_request",
      id,
      method: "custom",
      lines,
    } as AgentEvent;
    this.pendingUiRequests.set(id, event);
    this.notifyUiRequests();
    this.emit(event);
    notifyWaitingUserChange();
  }

  private closeCustomUi(id: string, value: unknown): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || custom.settled) return;
    custom.settled = true;
    this.activeCustomUis.delete(id);
    this.pendingUiRequests.delete(id);
    this.notifyUiRequests();
    notifyWaitingUserChange();
    try {
      custom.component.dispose?.();
    } catch {
      // Ignore dispose errors from extension UI components.
    }
    this.emit({
      type: "extension_ui_request",
      id,
      method: "custom",
      lines: [],
      closed: true,
    } as AgentEvent);
    custom.resolve(value);
  }

  private handleExtensionUiInput(id: string, data: string): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || typeof data !== "string") return;
    try {
      custom.component.handleInput?.(data);
      if (this.activeCustomUis.has(id)) this.emitCustomUiRender(id, custom);
    } catch (error) {
      this.closeCustomUi(id, undefined);
      this.emit({
        type: "extension_error",
        extensionPath: `custom-ui:${id}`,
        event: "custom_ui_input",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requestExtensionCustomUi<T>(
    factory: unknown,
    options?: unknown,
  ): Promise<T> {
    if (typeof factory !== "function") return Promise.resolve(undefined as T);

    const stopSignal = this.extensionUiAbortController.signal;
    if (stopSignal.aborted) return Promise.reject(stopSignal.reason);

    const id = randomUUID();
    const width = this.getCustomUiWidth(options);

    return new Promise<T>((resolve, reject) => {
      let completed = false;
      const tui = createHeadlessCustomUiTui(
        () => {
          const custom = this.activeCustomUis.get(id);
          if (custom) this.emitCustomUiRender(id, custom);
        },
        width,
      );
      const finish = (value: T) => {
        if (completed) return;
        completed = true;
        stopSignal.removeEventListener("abort", onStop);
        if (stopSignal.aborted) reject(stopSignal.reason);
        else resolve(value);
      };
      const done = (value: T) => {
        if (this.activeCustomUis.has(id)) {
          this.closeCustomUi(id, value);
        } else {
          finish(value);
        }
      };
      const onStop = () => done(undefined as T);
      stopSignal.addEventListener("abort", onStop, { once: true });

      Promise.resolve()
        .then(() => completed ? undefined : factory(tui, PLAIN_TEXT_THEME, CUSTOM_UI_KEYBINDINGS, done))
        .then((component) => {
          if (completed) {
            try {
              (component as CustomUiComponent | undefined)?.dispose?.();
            } catch {
              // Ignore dispose errors from a component completed before mounting.
            }
            return;
          }
          if (!component || typeof component !== "object" || typeof (component as CustomUiComponent).render !== "function") {
            finish(undefined as T);
            return;
          }
          const custom: ActiveCustomUi = {
            component: component as CustomUiComponent,
            width,
            resolve: (value) => finish(value as T),
            settled: false,
          };
          this.activeCustomUis.set(id, custom);
          this.emitCustomUiRender(id, custom);
        })
        .catch((error) => {
          if (completed) return;
          this.emit({
            type: "extension_error",
            extensionPath: `custom-ui:${id}`,
            event: "custom_ui",
            error: error instanceof Error ? error.message : String(error),
          });
          finish(undefined as T);
        });
    });
  }

  private requestExtensionUi<T>(
    request: ExtensionUiRequestBody,
    defaultValue: T,
    parseResponse: (response: ExtensionUiResponse) => T,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.resolve(defaultValue);
    const stopSignal = this.extensionUiAbortController.signal;
    if (stopSignal.aborted) return Promise.reject(stopSignal.reason);
    const abortSignal = signal ? AbortSignal.any([signal, stopSignal]) : stopSignal;

    const id = randomUUID();
    const fullRequest = {
      type: "extension_ui_request",
      id,
      ...request,
      runtimeGeneration: this.liveEventBootId,
      responseSchema: uiResponseSchema(request),
      createdAt: Date.now(),
      ...(timeout ? { timeout, expiresAt: Date.now() + timeout } : {}),
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        abortSignal.removeEventListener("abort", onAbort);
        if (this.pendingUiRequests.delete(id)) notifyWaitingUserChange();
        this.pendingUiResponses.delete(id);
        if (!this.settledUiRequests.has(id)) this.rememberUiResolution(id, { request: fullRequest, resolution: this.shuttingDown ? "runtime_closed" : stopSignal.aborted ? "stopped" : abortSignal.aborted ? "cancelled" : "expired" });
        this.notifyUiRequests();
        this.emit({ type: "extension_ui_closed", id, runtimeGeneration: this.liveEventBootId, resolution: this.settledUiRequests.get(id)?.resolution });
      };
      const settle = (value: T) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (stopSignal.aborted) reject(stopSignal.reason);
        else resolve(value);
      };
      const onAbort = () => settle(defaultValue);

      if (timeout) timeoutId = setTimeout(() => settle(defaultValue), timeout);
      abortSignal.addEventListener("abort", onAbort, { once: true });

      this.pendingUiRequests.set(id, structuredClone(fullRequest) as AgentEvent);
      this.pendingUiResponses.set(id, {
        resolve: (response) => settle(parseResponse(response)),
        cancel: () => settle(defaultValue),
      });
      notifyWaitingUserChange();
      try {
        persistSessionUiRequestEvent({ sessionId: this.sessionId, sessionFile: this.sessionFile,
          runtimeGeneration: this.liveEventBootId, requestId: id, method: request.method,
          summary: typeof request.title === "string" ? request.title : "Extension question" });
      } catch (error) {
        Object.assign(fullRequest, { supervisionError: "ui_notification_persistence_failed" });
        this.pendingUiRequests.set(id, structuredClone(fullRequest) as AgentEvent);
        console.error("[session-wait] UI notification persistence failed:", error);
        this.emit({ type: "extension_error", extensionPath: "session-control", event: "ui_notification", error: "UI supervision notification could not be persisted; read current pending requests before retrying" });
      }
      this.notifyUiRequests();
      this.emit(fullRequest as AgentEvent);
    });
  }

  private createExtensionUiContext(): ExtensionUiContextLike {
    return {
      select: (title, options, opts) => this.requestExtensionUi(
        { method: "select", title, options, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      confirm: (title, message, opts) => this.requestExtensionUi(
        { method: "confirm", title, message, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        false,
        (response) => "confirmed" in response ? response.confirmed : false,
        opts?.timeout,
        opts?.signal,
      ),
      input: (title, placeholder, opts) => this.requestExtensionUi(
        { method: "input", title, ...(placeholder !== undefined ? { placeholder } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      editor: (title, prefill, opts) => this.requestExtensionUi(
        { method: "editor", title, ...(prefill !== undefined ? { prefill } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      notify: (message, type) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "notify",
          message,
          notifyType: type,
        } as AgentEvent);
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => {
        if (text === undefined) this.extensionStatuses.delete(key);
        else this.extensionStatuses.set(key, text);
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setStatus",
          statusKey: key,
          statusText: text,
        } as AgentEvent);
      },
      setExtensionUsage: (key, usage) => {
        if (usage === undefined) this.extensionUsages.delete(key);
        else this.extensionUsages.set(key, { key, ...usage });
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setExtensionUsage",
          usageKey: key,
          usage,
        } as AgentEvent);
      },
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: (key, content, options) => {
        if (!this._alive || this.extensionWidgetsResetting) return;
        if (typeof content === "function") {
          this.setExtensionWidgetFactory(
            key,
            content as unknown as ExtensionWidgetFactory,
            options,
          );
          return;
        }
        if (content !== undefined && !Array.isArray(content)) return;
        if (content === undefined) {
          this.clearExtensionWidget(key);
          return;
        }
        const generation = this.activeExtensionWidgets.has(key)
          ? this.clearExtensionWidget(key)
          : this.nextExtensionWidgetGeneration(key);
        if (this.extensionWidgetGenerations.get(key) !== generation) return;
        this.extensionWidgets.set(key, {
          key,
          lines: content,
          placement: options?.placement ?? "aboveEditor",
        });
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        } as AgentEvent);
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setTitle",
          title,
        } as AgentEvent);
      },
      custom: <T = unknown>(factory: unknown, options?: unknown) => this.requestExtensionCustomUi<T>(factory, options),
      pasteToEditor: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as AgentEvent);
      },
      setEditorText: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as AgentEvent);
      },
      setEditorSuggestion: (text) => {
        this.editorSuggestion = text?.trim() ? text : null;
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_suggestion",
          suggestion: this.editorSuggestion,
        } as AgentEvent);
      },
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() { return PLAIN_TEXT_THEME; },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is not supported in Pi Web extension UI yet" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  private assertReloadAllowed(): void {
    if (this.isRunning()) throw new Error("Cannot reload resources while the session is busy");
  }

  private async reloadResources(): Promise<void> {
    this.assertReloadAllowed();
    if (this.extensionUiAbortController.signal.aborted) {
      this.extensionUiAbortController = new AbortController();
    }
    const activeToolNames = this.inner.getActiveToolNames();
    await this.waitForExtensionsBound();
    this.extensionStatuses.clear();
    this.extensionUsages.clear();
    this.extensionWidgetAdapter.clear();
    this.extensionWidgets.clear();
    await this.reconcileProjectPluginsBeforeReload();
    this.resetExtensionWidgetsForReload();
    this.createExtensionUiContext().setEditorSuggestion(undefined);
    this.syncProjectTrust();
    await this.inner.reload({
      beforeSessionStart: async () => {
        this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
      },
    });
    this.setActiveToolSelection(activeToolNames);
    await this.refreshRemoteClaudeHostBinding();
    this.applyForcedEmptySystemPrompt();
    this.applyRuntimeAutoCompactionOverride();
    invalidateModelsCache();
  }

  private createExtensionCommandContextActions(): ExtensionCommandContextActionsLike {
    return {
      waitForIdle: async () => {
        const agent = this.inner.agent as { waitForIdle?: () => Promise<void> };
        await agent.waitForIdle?.();
      },
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async (targetId, options) =>
        this.navigateTreeKeepingToolSelection(targetId, { summarize: options?.summarize }),
      switchSession: async () => ({ cancelled: true }),
      reload: async () => {
        await this.reloadResources();
      },
    };
  }

  private async reconcileProjectPluginsBeforeReload(): Promise<void> {
    this.syncProjectTrust();
    const skillSettingsManager = unwrapProjectSkillSettingsManager(this.inner.settingsManager);
    const settingsManager = unwrapProjectPluginSettingsManager(skillSettingsManager);
    await reloadProjectPluginSettings(settingsManager);
    if (settingsManager.isProjectTrusted()) {
      const legacyMigrated = migrateLegacyProjectOverrides(settingsManager);
      const webStateMigrated = migrateProjectWebStateKeys(settingsManager, this.cwd);
      if (legacyMigrated || webStateMigrated) {
        await settingsManager.flush();
      }
    }
    const effectiveSettingsManager = createProjectPluginSettingsManager(settingsManager, {
      cwd: this.cwd,
      agentDir: getAgentDir(),
    });
    const entries = await resolveGlobalSkillStateEntries(
      this.cwd,
      getAgentDir(),
      settingsManager,
      effectiveSettingsManager,
    );
    if (this.projectSkillRuntime) {
      updateProjectSkillRuntime(this.projectSkillRuntime, entries, {});
    } else if (this.skillRuntimeContext?.entries) {
      this.skillRuntimeContext.entries.splice(0, this.skillRuntimeContext.entries.length, ...entries);
    }
    await this.refreshSkillRuntimePolicyCatalog(settingsManager.isProjectTrusted());
  }

  private async refreshSkillRuntimePolicyCatalog(projectTrusted: boolean): Promise<void> {
    const context = this.skillRuntimeContext;
    if (!context) return;
    if (context.runtimeSkillsEnabled === false) {
      // noSkills/chatOnly is a capability decision made at child creation;
      // a settings refresh must not repopulate it from the parent catalog.
      if (context.entries) context.entries.splice(0, context.entries.length);
      context.runtimeCatalogAvailable = false;
      context.policies = [];
      context.stale = [];
      context.catalogSkills = [];
      context.globalInvocationModes = {};
      context.projectInvocationModes = {};
      return;
    }
    const settingsManager = unwrapProjectPluginSettingsManager(
      unwrapProjectSkillSettingsManager(this.inner.settingsManager),
    );
    context.globalInvocationModes = getSkillInvocationModes(settingsManager.getGlobalSettings(), "global");
    context.projectInvocationModes = projectTrusted
      ? getSkillInvocationModes(settingsManager.getProjectSettings(), "project", this.cwd)
      : {};
    try {
      const catalog = await loadSkillPolicyCatalog(this.cwd, projectTrusted ? "project" : "global");
      context.runtimeCatalogAvailable = true;
      context.policies = catalog.skills.map((skill) => skill.policy);
      context.stale = catalog.stale;
      context.catalogSkills = catalog.skills.length > 0
        ? catalog.skills as RuntimeSkillLike[]
        : undefined;
    } catch {
      if (context.requireRuntimeCatalog) {
        context.runtimeCatalogAvailable = false;
        context.policies = [];
        context.stale = [];
        context.catalogSkills = [];
        context.globalInvocationModes = {};
        context.projectInvocationModes = {};
        return;
      }
      // Keep runtime usable if a reload-time catalog read fails; the exact
      // resource entries and mode maps above remain available as a fallback.
      context.policies = undefined;
      context.stale = undefined;
      context.catalogSkills = undefined;
    }
  }

  private syncProjectTrust(): void {
    const status = getProjectTrustStatus(this.cwd, getAgentDir());
    this.inner.settingsManager.setProjectTrusted(status.trusted);
  }
}

// ============================================================================
// Session registry
// ============================================================================

declare global {
  var __piSessions: Map<string, AgentSessionWrapper> | undefined;
  var __piStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
  var __piToolMutationLocks: Map<string, Promise<void>> | undefined;
  var __piStartingSessionCwds: Map<string, number> | undefined;
  var __piRunningListeners: Set<(ids: string[]) => void> | undefined;
  var __piWaitingListeners: Set<(entries: WaitingUserEntry[]) => void> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
    const cleanup = () => globalThis.__piSessions?.forEach((s) => s.destroyForProcessExit());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__piSessions;
}

/** Includes idle native children whose files move with their parent's transcript. */
export function getRpcSessionTree(sessionFile: string): AgentSessionWrapper[] {
  const root = resolve(sessionFile.replace(/\.jsonl$/, ""));
  return [...(globalThis.__piSessions?.values() ?? [])].filter(session => {
    if (!session.isAlive() || !session.sessionFile) return false;
    const child = relative(root, resolve(session.sessionFile));
    return samePath(session.sessionFile, sessionFile) || Boolean(child && !child.startsWith("..") && !isAbsolute(child));
  });
}

export function getSessionExecutionSnapshots() {
  return Object.fromEntries([...(globalThis.__piSessions?.values() ?? [])]
    .filter(session => session.isAlive()).map(session => [session.sessionId, session.getExecutionState()]));
}

/** Replay the existing bounded ledger without resolving a session or creating a runtime. */
export function readStoppedSessionLiveEvents(sessionId: string, options: { cursor: number; limit: number; maxBytes: number }) {
  const deviceId = localDeviceId();
  const durable = readDurableLiveEventRecords(sessionId, { deviceId, cursor: options.cursor });
  const cursor = durable.records.at(-1)?.cursor ?? 0;
  const slice = sliceLiveEvents(durable.records, cursor, options.cursor, options.limit,
    Math.max(LIVE_EVENT_SNAPSHOT_MIN_BYTES, options.maxBytes - LIVE_EVENT_ROUTE_ENVELOPE_BYTES));
  return {
    ...slice, cursor, bootId: LIVE_EVENT_BOOT_ID, readerBootId: LIVE_EVENT_BOOT_ID, bootScope: "reader-process",
    replayedRuntimeBootId: durable.latestBootId ?? null,
    sessionId, capturedAt: new Date().toISOString(),
    durableLedger: { available: durable.durableAvailable, coverageComplete: false,
      writeFailureObserved: durable.writeFailureObserved,
        lastPersistedCursor: durable.lastPersistedCursor, ...(durable.gap ? { gap: durable.gap } : {}),
      replay: true, retention: "bounded-per-session", coverage: "verified-retained-events-only",
      unpersistedTail: "unknown-without-live-runtime" },
  };
}

/** Pure in-memory inventory, including idle/transient/hidden runtimes omitted by UI lists. */
export function listReaderRuntimeSafetySnapshot() {
  const runtimes = [...(globalThis.__piSessions?.values() ?? [])].map((session) => {
    const queue = session.getQueueIdentity();
    return {
      sessionId: session.sessionId,
      bootId: session.getLiveRuntimeIdentity().bootId,
      isAlive: session.isAlive(),
      isShuttingDown: session.isShuttingDown(),
      isRunning: session.isRunning(),
      settingsMutationPending: session.hasPendingSettingsMutation(),
      isStreaming: session.isStreaming,
      isPromptRunning: session.isPromptRunning || session.isUserPromptActive(),
      isBashRunning: session.inner.isBashRunning,
      isCompacting: session.inner.isCompacting,
      waiting: session.hasPendingUserInteraction(),
      queueRevision: queue.revision,
      queueCounts: queue.counts,
    };
  });
  return {
    schemaVersion: 1,
    source: "reader-runtime-registry",
    bootId: LIVE_EVENT_BOOT_ID,
    capturedAt: new Date().toISOString(),
    coverage: {
      complete: true,
      scope: "all-in-process-runtimes",
      runtimeCount: runtimes.length,
      startingRuntimeCount: globalThis.__piStartLocks?.size ?? 0,
      pendingRuntimeMutationCount: globalThis.__piToolMutationLocks?.size ?? 0,
      readOnly: true,
    },
    runtimeStartAttempted: false,
    writeSideEffects: false,
    runtimes,
  };
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__piStartLocks) globalThis.__piStartLocks = new Map();
  return globalThis.__piStartLocks;
}

function getToolMutationLocks(): Map<string, Promise<void>> {
  if (!globalThis.__piToolMutationLocks) globalThis.__piToolMutationLocks = new Map();
  return globalThis.__piToolMutationLocks;
}

async function withToolMutationLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const locks = getToolMutationLocks();
  const previous = locks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  locks.set(sessionId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(sessionId) === current) locks.delete(sessionId);
  }
}

function normalizeRpcCwd(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  try {
    return realpathSync(resolvedCwd);
  } catch {
    return resolvedCwd;
  }
}

function getStartingSessionCwds(): Map<string, number> {
  if (!globalThis.__piStartingSessionCwds) globalThis.__piStartingSessionCwds = new Map();
  return globalThis.__piStartingSessionCwds;
}

function trackStartingSession(cwd: string): () => void {
  const startingCwds = getStartingSessionCwds();
  const key = normalizeRpcCwd(cwd);
  startingCwds.set(key, (startingCwds.get(key) ?? 0) + 1);
  return () => {
    const remaining = (startingCwds.get(key) ?? 1) - 1;
    if (remaining > 0) startingCwds.set(key, remaining);
    else startingCwds.delete(key);
  };
}

function registerRpcSession(wrapper: AgentSessionWrapper): void {
  const registry = getRegistry();
  const existing = registry.get(wrapper.sessionId);
  if (existing !== wrapper && existing?.hasPendingControlReceiptPersistence()) {
    if (existing.inner !== wrapper.inner) wrapper.inner.dispose();
    throw new Error("Terminal control receipt persistence is pending for this session");
  }
  if (existing?.isAlive() && existing !== wrapper) {
    if (existing.inner !== wrapper.inner) wrapper.inner.dispose();
    throw new Error("Session runtime is already registered");
  }
  if (wrapper.sessionFile) cacheSessionPath(wrapper.sessionId, wrapper.sessionFile);
  wrapper.onDestroy(() => {
    // Release only the exact binding owned by this wrapper. A replacement
    // generation must remain live until its own wrapper is destroyed.
    revokeRemoteClaudeHost(wrapper.remoteClaudeHostBinding);
    if (registry.get(wrapper.sessionId) !== wrapper) return;
    registry.delete(wrapper.sessionId);
    invalidateSessionListCache();
  });
  registry.set(wrapper.sessionId, wrapper);
  try {
    wrapper.start();
  } catch (error) {
    wrapper.destroy();
    throw error;
  }
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return globalThis.__piSessions?.get(sessionId);
}

/** Same-process Reader bridge entrypoint for a provider alias turn. */
export function associateRemoteClaudeProviderSession(
  input: Parameters<typeof associateRemoteClaudeProviderHostSession>[0],
) {
  return associateRemoteClaudeProviderHostSession(input);
}

const SUBAGENT_CONTROLLER = createSubagentController({
  getSession: (sessionId) => getRpcSession(sessionId),
  registerSession: (inner, options) => {
    let wrapper: AgentSessionWrapper | undefined;
    try {
      wrapper = new AgentSessionWrapper(inner, undefined, { mode: "default" }, {
        ...(options?.mcpHost ? { mcpHost: options.mcpHost } : {}),
        ...(options?.remoteHost ? { remoteClaudeHost: options.remoteHost } : {}),
        ...(options?.skillRuntimeContext ? { skillRuntimeContext: options.skillRuntimeContext } : {}),
        ...(options?.runtimeOwnership ? { runtimeOwnership: options.runtimeOwnership } : {}),
      });
      const subagentPolicy = { suppressCompletionNotifications: true };
      if (subagentPolicy.suppressCompletionNotifications) wrapper.setSuppressCompletionNotifications(true);
      if (options?.chatOnly) wrapper.setForceEmptySystemPrompt(true);
      registerRpcSession(wrapper);
      wrapper.beginExtensionBinding();
      return wrapper;
    } catch (error) {
      if (wrapper) wrapper.destroy();
      else {
        try { inner.dispose(); }
        finally { options?.runtimeOwnership?.release(); }
      }
      throw error;
    }
  },
  reopenSession: async (sessionId, sessionFile, parentSessionId) =>
    (await startRpcSession(sessionId, sessionFile, undefined, {
      ...(parentSessionId && getRpcSession(parentSessionId)?.inner.model?.provider === REMOTE_CLAUDE_PROVIDER_ID
        ? { parentRemoteHost: resolveRemoteClaudeHost(parentSessionId) }
        : {}),
    })).session,
  resolveSessionPath,
  invalidateSessionList: invalidateSessionListCache,
  isBuiltInSubagentsEnabled,
});

export function getSubagentRun(sessionId: string, parentSessionId?: string) {
  const parent = parentSessionId ? getRpcSession(parentSessionId) : undefined;
  return SUBAGENT_CONTROLLER.get(sessionId, parent?.inner as never);
}

export function steerSubagent(sessionId: string, message: string, parentSessionId?: string) {
  const parent = parentSessionId ? getRpcSession(parentSessionId) : undefined;
  return SUBAGENT_CONTROLLER.steer(sessionId, message, parent?.inner as never);
}

export function abortSubagent(sessionId: string, parentSessionId?: string) {
  const parent = parentSessionId ? getRpcSession(parentSessionId) : undefined;
  return SUBAGENT_CONTROLLER.abort(sessionId, parent?.inner as never);
}

/**
 * Find the live agent session for a session file path. Writes through its
 * SessionManager stay visible to extensions immediately (same in-memory
 * instance), unlike opening a fresh SessionManager snapshot.
 */
export function getRpcSessionByFile(sessionFile: string): AgentSessionWrapper | undefined {
  const target = resolve(sessionFile);
  for (const session of globalThis.__piSessions?.values() ?? []) {
    if (session.sessionFile && resolve(session.sessionFile) === target) return session;
  }
  return undefined;
}

export interface ReloadRpcSessionsResult {
  liveSessions: number;
  reloadedSessions: number;
  busySessionIds: string[];
  failedSessionIds: string[];
}

function isReloadBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /busy|pending|shutting down/i.test(message);
}

/** Reload every live runtime without waking persisted sessions. */
export async function reloadRpcSessions(): Promise<ReloadRpcSessionsResult> {
  const sessions = [...(globalThis.__piSessions?.values() ?? [])].filter((session) => session.isAlive());
  const results = await Promise.all(sessions.map(async (session) => {
    try {
      await session.send({ type: "reload" });
      return { id: session.sessionId, status: "reloaded" as const };
    } catch (error) {
      const busy = isReloadBusyError(error);
      if (!busy) console.error(`[pi-web] Failed to reload session ${session.sessionId}:`, error);
      return {
        id: session.sessionId,
        status: busy ? "busy" as const : "failed" as const,
      };
    }
  }));
  return {
    liveSessions: results.length,
    reloadedSessions: results.filter((result) => result.status === "reloaded").length,
    busySessionIds: results.filter((result) => result.status === "busy").map((result) => result.id),
    failedSessionIds: results.filter((result) => result.status === "failed").map((result) => result.id),
  };
}

export const MODEL_RUNTIME_REFRESH_TIMEOUT_MS = 5_000;

export interface RefreshRpcSessionModelsResult {
  liveSessions: number;
  refreshedSessions: number;
  failedSessionIds: string[];
  timedOutSessionIds: string[];
}

export async function refreshRpcSessionModels(
  options: { timeoutMs?: number } = {},
): Promise<RefreshRpcSessionModelsResult> {
  const sessions = [...(globalThis.__piSessions?.values() ?? [])].filter((session) => session.isAlive());
  const results = await Promise.all(sessions.map(async (session) => {
    try {
      const refreshPromise = session.refreshModelConfig();
      if (options.timeoutMs === undefined) {
        return {
          id: session.sessionId,
          refreshed: await refreshPromise,
          failed: false,
          timedOut: false,
        };
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([
          refreshPromise.then((refreshed) => ({ kind: "completed" as const, refreshed })),
          new Promise<{ kind: "timed-out" }>((resolve) => {
            timer = setTimeout(() => resolve({ kind: "timed-out" }), options.timeoutMs);
          }),
        ]);
        if (outcome.kind === "timed-out") {
          return { id: session.sessionId, refreshed: false, failed: false, timedOut: true };
        }
        return {
          id: session.sessionId,
          refreshed: outcome.refreshed,
          failed: false,
          timedOut: false,
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (error) {
      console.error(`[pi-web] Failed to refresh model config for session ${session.sessionId}:`, error);
      return { id: session.sessionId, refreshed: false, failed: true, timedOut: false };
    }
  }));
  return {
    liveSessions: results.length,
    refreshedSessions: results.filter((result) => result.refreshed).length,
    failedSessionIds: results.filter((result) => result.failed).map((result) => result.id),
    timedOutSessionIds: results.filter((result) => result.timedOut).map((result) => result.id),
  };
}

/**
 * Rehydrate latest pending terminology jobs for one session. The durable
 * custom entry is the source of truth; no job state is placed in AgentSession
 * messages or sent through buildSessionContext().
 */
export async function ensureQuestionAnalysisJobsForSession(sessionId: string, _sessionFile?: string): Promise<void> {
  const live = getRpcSession(sessionId);
  if (live?.isAlive()) {
    const jobs = latestQuestionAnalysisJobs(live.inner.sessionManager.getEntries() as unknown as SessionEntry[])
      .filter(isResumableQuestionAnalysisJob);
    if (typeof live.restoreQuestionAnalysisJobs === "function") live.restoreQuestionAnalysisJobs(jobs);
    return;
  }
}

let questionAnalysisRestorePromise: Promise<void> | null = null;
let questionAnalysisRestored = false;

/** Legacy GET callers may only resume jobs belonging to an already-owned runtime. */
export async function restorePersistedQuestionAnalysisJobs(
  sessions: ReadonlyArray<{ id: string; path: string }>,
): Promise<void> {
  for (const session of sessions) await ensureQuestionAnalysisJobsForSession(session.id);
}

/** Process startup, not HTTP observation, restores only previously admitted pending work. */
export async function initializeQuestionAnalysisRuntime(): Promise<void> {
  if (questionAnalysisRestored) return Promise.resolve();
  if (questionAnalysisRestorePromise) return questionAnalysisRestorePromise;
  questionAnalysisRestorePromise = (async () => {
    const { listSessionSummaries } = await import("./session-reader");
    for (const session of await listSessionSummaries()) {
      try {
        if (!session.path || !existsSync(session.path)) continue;
        const jobs = latestQuestionAnalysisJobs(getSessionReadSnapshot(session.path).entries).filter(isResumableQuestionAnalysisJob);
        if (jobs.length > 0) await startRpcSession(session.id, session.path, undefined);
      } catch (error) {
        console.warn(`[pi-web] terminology job restore failed for ${session.id}:`, error instanceof Error ? error.message : String(error));
      }
    }
    questionAnalysisRestored = true;
  })().finally(() => {
    questionAnalysisRestorePromise = null;
  });
  return questionAnalysisRestorePromise;
}

function promptTemplateInvocation(text: string, templates: readonly { name: string }[]): string | null {
  const match = text.match(/^\/([^\s]+)(?:\s+[\s\S]*)?$/);
  if (!match || !templates.some((template) => template.name === match[1])) return null;
  return text;
}

function messageTextFor(content: unknown, trim = true): string {
  if (typeof content === "string") return trim ? content.trim() : content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  const text = parts.join("\n");
  return trim ? text.trim() : text;
}

function runtimeMessageText(entry: SessionMessageEntry): string {
  if (entry.message.role === "bashExecution") return "";
  const content = entry.message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join(" ");
}

function runtimeMessageActivityMs(entry: SessionMessageEntry): number | undefined {
  if (entry.message.role !== "user" && entry.message.role !== "assistant") return undefined;
  if (typeof entry.message.timestamp === "number") return entry.message.timestamp;
  const timestamp = new Date(entry.timestamp).getTime();
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

/**
 * Return live sessions that should be visible in the session list. Pi delays
 * the first JSONL flush until an assistant message exists, so an accepted new
 * prompt must temporarily be described from its in-memory SessionManager.
 */
export function getRpcSessionInfos(): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  for (const session of globalThis.__piSessions?.values() ?? []) {
    if (!session.isAlive()) continue;

    const manager = session.inner.sessionManager;
    const header = manager.getHeader();
    const entries = manager.getEntries() as unknown as Array<
      { type: string; timestamp: string } | SessionMessageEntry
    >;
    const messages = entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
    const firstUserMessage = messages.find((entry) => entry.message.role === "user");
    const displayInputs = sessionDisplayInputs(entries);
    const sessionFile = manager.getSessionFile() ?? session.sessionFile;
    const persisted = Boolean(sessionFile && existsSync(sessionFile));

    // A live runtime without a file is a visible transient draft. It must be
    // listed while alive so the composer/sidebar can retain its configuration,
    // but it is never treated as a durable historical session.
    if (persisted && !session.isRunning() && messages.length === 0 && !manager.getSessionName()?.trim()
      && !hasDurableSessionCreation(entries, manager.getSessionId())) continue;

    const created = header?.timestamp
      ?? entries[0]?.timestamp
      ?? new Date().toISOString();
    const headerTimestamp = new Date(created).getTime();
    let lastActivityMs = Number.isNaN(headerTimestamp) ? Date.now() : headerTimestamp;
    for (const message of messages) {
      const activityMs = runtimeMessageActivityMs(message);
      if (activityMs !== undefined) lastActivityMs = Math.max(lastActivityMs, activityMs);
    }

    sessions.push({
      path: sessionFile ?? "",
      id: header?.id ?? session.sessionId,
      // The persisted header is history. A validated runtime override is the
      // current execution cwd; never project a stale header over it.
      cwd: session.cwd,
      contextSourceSessionId: (header as unknown as ReaderSessionHeader | null)?.contextSourceSessionId,
      name: manager.getSessionName(),
      created,
      modified: new Date(lastActivityMs).toISOString(),
      messageCount: messages.length,
      firstMessage: firstUserMessage
        ? displayInputs.get(firstUserMessage.id) ?? (runtimeMessageText(firstUserMessage) || "(no messages)")
        : firstSessionControlDisplayText(entries) ?? "(no messages)",
      transient: !persisted,
    });
  }
  return sessions;
}

async function nativeListVisible(cwd: string, sessionDir: string | undefined, sessionId: string, sessionFile: string | undefined): Promise<boolean> {
  if (!sessionId || !sessionFile) return false;
  try {
    const listed = await SessionManager.list(cwd, sessionDir);
    return listed.some((info) => info.id === sessionId);
  } catch {
    return false;
  }
}

function runtimeSessionVisible(sessionId: string): boolean {
  try {
    return getRpcSessionInfos().some((info) => info.id === sessionId);
  } catch {
    return false;
  }
}

async function durableSessionFacts(
  cwd: string,
  sessionDir: string | undefined,
  sessionId: string,
  sessionFile: string | undefined,
  runtimeCreated: boolean,
  source: DurableSessionFacts["source"],
  messageKind: DurableSessionFacts["messageKind"] = messageKindForSource(source),
  messageDigest?: string,
  initialUserMessageSent?: boolean,
): Promise<DurableSessionFacts> {
  const persisted = Boolean(sessionFile && existsSync(sessionFile));
  const nativeVisible = await nativeListVisible(cwd, sessionDir, sessionId, sessionFile);
  const runtimeVisible = runtimeSessionVisible(sessionId);
  return {
    sessionId,
    sessionDir,
    ...(sessionFile ? { sessionFile } : {}),
    persisted,
    nativeListVisible: nativeVisible,
    runtimeVisibleInReader: runtimeVisible,
    visibleInSessionList: nativeVisible || runtimeVisible,
    runtimeCreated,
    source,
    messageKind,
    ...(messageDigest ? { messageDigest } : {}),
    ...(initialUserMessageSent !== undefined ? { initialUserMessageSent } : {}),
  };
}

function hasInitialUserMessage(sessionManager: { getEntries(): readonly unknown[] }, initialMessage: string | undefined): boolean | undefined {
  if (initialMessage === undefined) return undefined;
  return sessionManager.getEntries().some((entry) => {
    if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "message") return false;
    const message = (entry as { message?: unknown }).message;
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "user") return false;
    const content = (message as { content?: unknown }).content;
    if (content === initialMessage) return true;
    if (!Array.isArray(content)) return false;
    return content
      .filter((block): block is { type: "text"; text: string } => Boolean(block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string"))
      .map((block) => block.text)
      .join("") === initialMessage;
  });
}

export async function ensureInitialUserPrompt(session: AgentSessionWrapper, initialMessage: string | undefined): Promise<boolean> {
  if (initialMessage === undefined || hasInitialUserMessage(session.inner.sessionManager, initialMessage)) return false;
  await session.send({ type: "prompt", message: initialMessage });
  return true;
}

function durableRecordForManager(
  manager: SessionManager,
  request: DurableSessionCreateRequest,
): { record: DurableSessionCreateRecord; nativeRecordValid: boolean } | undefined {
  const entries = manager.getEntries();
  const record = findDurableSessionCreateRecord(entries, request.scope, request.idempotencyKey)
    ?? findLegacyDurableSessionCreateRecord(entries, request.scope, request.idempotencyKey);
  if (!record || record.sessionId !== manager.getSessionId()) return undefined;
  return {
    record,
    nativeRecordValid: validateDurableSessionRecord(entries, record),
  };
}

const DURABLE_SESSION_ADMISSION_LOCK_DIR = ".pi-web-session-control-admission";
const DURABLE_SESSION_ADMISSION_LOCK_OPTIONS = {
  realpath: false,
  stale: 30_000,
  update: 10_000,
  retries: { retries: 20, factor: 1, minTimeout: 25, maxTimeout: 500 },
};

/**
 * Resolve the SDK's actual session directory before taking the lock. Creating
 * this setup-only manager does not allocate a transcript file; the native
 * append path remains the only persistence path.
 */
function durableSessionAdmissionDir(cwd: string, isolatedSessionDir?: string): string {
  const manager = SessionManager.create(cwd, isolatedSessionDir);
  return realpathSync(manager.getSessionDir());
}

/**
 * The SDK only creates a new transcript file after a role=user/assistant
 * message. Initialize an SDK-owned header through the public
 * SessionManager.open() empty-file path before writing the durable creation
 * record or dispatching an optional first user prompt. Reader never writes
 * JSONL or touches the SDK's private flushed flag here.
 */
function createNativeCustomSessionManager(cwd: string, isolatedSessionDir?: string): { manager: SessionManager; ownership: SessionRuntimeOwnership } {
  const allocation = SessionManager.create(cwd, isolatedSessionDir);
  const sessionFile = allocation.getSessionFile();
  if (!sessionFile) throw new Error("native SessionManager did not allocate a session file path");
  const ownership = acquireSessionRuntimeOwnership(sessionFile);
  try {
    const fd = openSync(sessionFile, "wx");
    closeSync(fd);
    return { manager: SessionManager.open(sessionFile, allocation.getSessionDir(), cwd), ownership };
  } catch (error) {
    try {
      if (statSync(sessionFile).size === 0) unlinkSync(sessionFile);
    } catch {
      // Preserve the original SDK error and never remove a non-empty file.
    }
    ownership.release();
    throw error;
  }
}

/**
 * The lock covers native find plus create/recover. proper-lockfile still owns
 * stale reclamation, finite retries, and the heartbeat, but its default
 * onCompromised throw is unsafe for a long-lived Reader process. Capture that
 * callback, let the protocol lease guard fail closed, and carry any result
 * observed before the failure back to the caller.
 */
async function withDurableSessionAdmissionLock(
  request: DurableSessionCreateRequest,
  isolatedSessionDir: string | undefined,
  operation: (lease: DurableSessionAdmissionLease) => Promise<DurableSessionResult>,
): Promise<DurableSessionResult> {
  const sessionDir = durableSessionAdmissionDir(request.scope.cwd, isolatedSessionDir);
  const lockDir = resolve(sessionDir, DURABLE_SESSION_ADMISSION_LOCK_DIR);
  mkdirSync(lockDir, { recursive: true });
  const lockPath = resolve(lockDir, durableAdmissionLockKey(request));
  let compromisedError: Error | undefined;
  const lease: DurableSessionAdmissionLease = {
    assert() {
      if (compromisedError) {
        throw new DurableSessionAdmissionError(
          `durable session admission lease was compromised: ${compromisedError.message}`,
        );
      }
    },
  };
  const release = await lockfile.lock(lockPath, {
    ...DURABLE_SESSION_ADMISSION_LOCK_OPTIONS,
    onCompromised: (error: Error) => {
      compromisedError ??= error;
    },
  });
  let result: DurableSessionResult | undefined;
  let operationError: unknown;
  let releaseError: unknown;
  try {
    lease.assert();
    result = await operation(lease);
    lease.assert();
  } catch (error) {
    operationError = error;
  }
  try {
    await release();
  } catch (error) {
    releaseError = error;
  }

  const carriedResult = operationError instanceof DurableSessionAdmissionError
    ? operationError.result ?? result
    : result;
  const leaseErrors = [
    compromisedError ? `durable session admission lease was compromised: ${compromisedError.message}` : "",
    releaseError ? `durable session admission lock release failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}` : "",
  ].filter(Boolean);
  if (leaseErrors.length > 0) {
    let prior = "";
    if (operationError instanceof Error) prior = operationError.message;
    else if (operationError) prior = String(operationError);
    throw new DurableSessionAdmissionError(
      [prior, ...leaseErrors].filter(Boolean).join("; "),
      carriedResult,
    );
  }
  if (operationError) {
    throw operationError;
  }
  if (!result) throw new DurableSessionAdmissionError("durable session admission operation returned no result");
  return result;
}

async function findExistingDurableRpcSession(
  request: DurableSessionCreateRequest,
  isolatedSessionDir?: string,
): Promise<DurableSessionObservation | undefined> {
  const targetCwd = normalizeRpcCwd(request.scope.cwd);
  for (const session of globalThis.__piSessions?.values() ?? []) {
    if (normalizeRpcCwd(session.cwd) !== targetCwd) continue;
    if (isolatedSessionDir && resolve(session.inner.sessionManager.getSessionDir()) !== resolve(isolatedSessionDir)) continue;
    const selected = durableRecordForManager(session.inner.sessionManager, request);
    if (!selected?.record) continue;
    const facts = await durableSessionFacts(
      request.scope.cwd,
      session.inner.sessionManager.getSessionDir(),
      session.sessionId,
      session.sessionFile || session.inner.sessionManager.getSessionFile(),
      session.isAlive(),
      selected.record.source,
      selected.record.messageKind,
      selected.record.messageDigest,
      hasInitialUserMessage(session.inner.sessionManager, request.initialMessage),
    );
    return {
      ...facts,
      initialMessageDigest: selected.record.initialMessageDigest,
      messageDigest: selected.record.messageDigest,
      nativeRecordValid: selected.nativeRecordValid,
    };
  }

  // The native list is the source of truth for persisted history. Reader's
  // live registry is deliberately not used as the only visibility signal.
  const listed = await SessionManager.list(request.scope.cwd, isolatedSessionDir);
  for (const info of listed) {
    if (!info.path) continue;
    try {
      const manager = SessionManager.open(info.path, isolatedSessionDir);
      const selected = durableRecordForManager(manager, request);
      if (!selected?.record) continue;
      const sessionFile = manager.getSessionFile() || info.path;
      const facts = await durableSessionFacts(
        request.scope.cwd,
        manager.getSessionDir(),
        selected.record.sessionId,
        sessionFile,
        false,
        selected.record.source,
        selected.record.messageKind,
        selected.record.messageDigest,
        hasInitialUserMessage(manager, request.initialMessage),
      );
      return {
        ...facts,
        initialMessageDigest: selected.record.initialMessageDigest,
        messageDigest: selected.record.messageDigest,
        nativeRecordValid: selected.nativeRecordValid,
      };
    } catch {
      // An unrelated malformed transcript must not prevent a keyed create.
    }
  }
  return undefined;
}

async function createNativeDurableRpcSession(
  request: DurableSessionCreateRequest,
  isolatedSessionDir: string | undefined,
  lease: DurableSessionAdmissionLease,
): Promise<DurableSessionResult> {
  const cwd = normalizeRpcCwd(request.scope.cwd);
  const source = request.initialMessage === undefined ? "initialization" : "agent-message";
  let manager: SessionManager | undefined;
  let sessionFile: string | undefined;
  let sessionId = "";
  let nativeMessageCommitted = false;
  let initialUserPromptSent = false;
  let creationOwnership: SessionRuntimeOwnership | undefined;
  try {
    const created = createNativeCustomSessionManager(cwd, isolatedSessionDir);
    manager = created.manager;
    creationOwnership = created.ownership;
    sessionFile = manager.getSessionFile();
    sessionId = manager.getSessionId();
    if (!sessionFile || !sessionId) throw new Error("native SessionManager did not allocate a durable session identity");

    // The manager has already crossed the public SDK header boundary. These
    // native marker/custom-message appends are now persisted by the SDK.
    lease.assert();
    appendDurableSessionCreate(manager, request);
    // A compromised lease may be reported by the heartbeat immediately after
    // the native append. The surrounding catch records the actual facts.
    lease.assert();
    nativeMessageCommitted = Boolean(existsSync(sessionFile));
    if (!nativeMessageCommitted) {
      const facts = await durableSessionFacts(cwd, manager.getSessionDir(), sessionId, sessionFile, false, source);
      return createDurableSessionResult(request, facts, "failed", false, "native SessionManager did not persist the create message");
    }

    creationOwnership.release();
    creationOwnership = undefined;
    invalidateSessionListCache();
    try {
      lease.assert();
      const started = await startRpcSession(sessionId, sessionFile, cwd, { sessionDir: manager.getSessionDir() });
      lease.assert();
      initialUserPromptSent = await ensureInitialUserPrompt(started.session, request.initialMessage);
      lease.assert();
      invalidateSessionListCache();
      const readback = durableRecordForManager(started.session.inner.sessionManager, request);
      const facts = await durableSessionFacts(
        cwd,
        manager.getSessionDir(),
        started.realSessionId,
        sessionFile,
        started.session.isAlive(),
        source,
        readback?.record.messageKind,
        readback?.record.messageDigest,
        request.initialMessage === undefined
          ? undefined
          : initialUserPromptSent || hasInitialUserMessage(started.session.inner.sessionManager, request.initialMessage) === true,
      );
      if (!readback?.record || !readback.nativeRecordValid) {
        return createDurableSessionResult(request, facts, "persisted-runtime-failed", false, "native session reopened but marker or durable creation record digest readback failed");
      }
      return createDurableSessionResult(
        request,
        facts,
        facts.nativeListVisible && facts.runtimeVisibleInReader ? "created" : "persisted-runtime-failed",
        false,
        facts.nativeListVisible && facts.runtimeVisibleInReader ? undefined : "native session persisted but runtime or native session list readback is incomplete",
      );
    } catch (error) {
      invalidateSessionListCache();
      const live = getRpcSession(sessionId);
      const selected = durableRecordForManager(manager, request);
      const facts = await durableSessionFacts(
        cwd,
        manager.getSessionDir(),
        sessionId,
        sessionFile,
        Boolean(live?.isAlive()),
        source,
        selected?.record.messageKind,
        selected?.record.messageDigest,
        request.initialMessage === undefined
          ? undefined
          : initialUserPromptSent || hasInitialUserMessage(manager, request.initialMessage) === true,
      );
      return createDurableSessionResult(request, facts, "persisted-runtime-failed", false, error instanceof Error ? error.message : String(error));
    }
  } catch (error) {
    const persisted = Boolean(sessionFile && existsSync(sessionFile));
    const live = sessionId ? getRpcSession(sessionId) : undefined;
    let facts: DurableSessionFacts;
    if (manager) {
      facts = await durableSessionFacts(
        cwd,
        manager.getSessionDir(),
        sessionId,
        sessionFile,
        Boolean(live?.isAlive()),
        source,
      );
    } else {
      const runtimeVisible = sessionId ? runtimeSessionVisible(sessionId) : false;
      facts = {
        sessionId,
        ...(sessionFile ? { sessionFile } : {}),
        persisted,
        nativeListVisible: false,
        runtimeVisibleInReader: runtimeVisible,
        visibleInSessionList: runtimeVisible,
        runtimeCreated: Boolean(live?.isAlive()),
        source,
        messageKind: messageKindForSource(source),
      };
    }
    const status = facts.persisted || facts.nativeListVisible || nativeMessageCommitted ? "persisted-runtime-failed" : "failed";
    return createDurableSessionResult(request, facts, status, false, error instanceof Error ? error.message : String(error));
  } finally { creationOwnership?.release(); }
}

async function recoverDurableRpcSession(
  facts: DurableSessionObservation,
  request: DurableSessionCreateRequest,
  lease: DurableSessionAdmissionLease,
): Promise<DurableSessionResult> {
  const cwd = normalizeRpcCwd(request.scope.cwd);
  if (!facts.sessionFile || !facts.persisted || !facts.nativeListVisible) {
    return createDurableSessionResult(request, facts, "recovery-failed", true, "persisted session has no verified native session file/list entry");
  }

  try {
    lease.assert();
    const started = await startRpcSession(facts.sessionId, facts.sessionFile, cwd, { sessionDir: facts.sessionDir });
    lease.assert();
    invalidateSessionListCache();
    const manager = started.session.inner.sessionManager;
    let selected = durableRecordForManager(manager, request);
    if (selected?.record && !selected.nativeRecordValid && selected.record.version === 4) {
      // The v4 marker is the durable idempotency fact. If the host died after
      // that marker but before its exact native custom message, retry that
      // same append under the admission lock; a present inconsistent message
      // remains a hard recovery failure in appendDurableSessionCreate().
      lease.assert();
      appendDurableSessionCreate(manager, request);
      lease.assert();
      selected = durableRecordForManager(manager, request);
    }
    if (!selected?.record || !selected.nativeRecordValid) {
      const recovered = await durableSessionFacts(
        cwd,
        manager.getSessionDir(),
        started.realSessionId,
        facts.sessionFile,
        started.session.isAlive(),
        facts.source,
        selected?.record.messageKind ?? facts.messageKind,
        selected?.record.messageDigest ?? facts.messageDigest,
        hasInitialUserMessage(manager, request.initialMessage),
      );
      return createDurableSessionResult(request, recovered, "recovery-failed", true, "reopened native session failed marker/message readback validation");
    }
    const initialUserPromptSent = await ensureInitialUserPrompt(started.session, request.initialMessage);
    lease.assert();
    const recovered = await durableSessionFacts(
      cwd,
      manager.getSessionDir(),
      started.realSessionId,
      facts.sessionFile,
      started.session.isAlive(),
      selected.record.source,
      selected.record.messageKind,
      selected.record.messageDigest,
      request.initialMessage === undefined
        ? undefined
        : initialUserPromptSent || hasInitialUserMessage(manager, request.initialMessage) === true,
    );
    return createDurableSessionResult(
      request,
      recovered,
      recovered.nativeListVisible && recovered.runtimeVisibleInReader ? "reused" : "recovery-failed",
      true,
      recovered.nativeListVisible && recovered.runtimeVisibleInReader ? undefined : "persisted session was reopened but native list or Reader runtime readback is incomplete",
    );
  } catch (error) {
    invalidateSessionListCache();
    const live = getRpcSession(facts.sessionId);
    const recovered = { ...facts, runtimeCreated: Boolean(live?.isAlive()), runtimeVisibleInReader: runtimeSessionVisible(facts.sessionId), visibleInSessionList: facts.nativeListVisible || runtimeSessionVisible(facts.sessionId) };
    return createDurableSessionResult(request, recovered, "recovery-failed", true, error instanceof Error ? error.message : String(error));
  }
}

/** Host adapter for the first-party durable session-control protocol. */
export function createDurableRpcSession(
  request: DurableSessionCreateRequest,
  options: { sessionDir?: string } = {},
): Promise<DurableSessionResult> {
  const scopedRequest: DurableSessionCreateRequest = {
    ...request,
    scope: { ...request.scope, cwd: normalizeRpcCwd(request.scope.cwd) },
  };
  return createOrReuseDurableSession(scopedRequest, {
    withAdmissionLock: (candidate, operation) => withDurableSessionAdmissionLock(candidate, options.sessionDir, operation),
    findExisting: (candidate) => findExistingDurableRpcSession(candidate, options.sessionDir),
    create: (candidate, lease) => createNativeDurableRpcSession(candidate, options.sessionDir, lease),
    recover: (facts, candidate, lease) => recoverDurableRpcSession(facts, candidate, lease),
  });
}

export function hasBusyRpcSessionForCwd(cwd: string): boolean {
  const targetCwd = normalizeRpcCwd(cwd);
  if (globalThis.__piStartingSessionCwds?.has(targetCwd)) return true;
  return Array.from(globalThis.__piSessions?.values() ?? []).some(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd && session.isRunning(),
  );
}

export async function destroyRpcSessionsForCwd(cwd: string): Promise<number> {
  const targetCwd = normalizeRpcCwd(cwd);
  const sessions = Array.from(globalThis.__piSessions?.values() ?? []).filter(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd,
  );
  await Promise.all(sessions.map((session) => session.shutdown()));
  return sessions.length;
}

export function getWaitingForUserRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of globalThis.__piSessions ?? []) {
    if (session.hasPendingUserInteraction()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

export function getRunningRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of globalThis.__piSessions ?? []) {
    if (session.isRunning()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

export function getCompletionNotificationSuppressedRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of globalThis.__piSessions ?? []) {
    if (session.isRunning() && session.hasSuppressedCompletionNotifications()) {
      ids.add(session.sessionId || sessionId);
    }
  }
  return [...ids];
}

export interface SetRpcSessionToolsResult {
  session: AgentSessionWrapper;
  sessionId: string;
  recreated: boolean;
}

export async function setRpcSessionTools(
  sessionId: string,
  sessionFile: string | undefined,
  requestedToolNames: unknown,
  requestedStrictToolAllowlist?: unknown,
): Promise<SetRpcSessionToolsResult> {
  return withToolMutationLock(sessionId, async () => {
  const toolNames = requestedToolNames === undefined
    ? undefined
    : validateSessionToolSelection(requestedToolNames);
  const strictToolAllowlist = requestedStrictToolAllowlist === undefined
    ? undefined
    : (() => {
        if (typeof requestedStrictToolAllowlist !== "boolean") {
          throw new Error("strictToolAllowlist must be boolean");
        }
        return requestedStrictToolAllowlist;
      })();
  if (strictToolAllowlist === true && toolNames === undefined) {
    throw new Error("strictToolAllowlist requires an explicit toolNames allow-list");
  }
  const starting = getLocks().get(sessionId);
  if (starting) await starting;
  const closing = getRpcSession(sessionId);
  if (closing?.isShuttingDown()) await closing.shutdown();
  const existing = getRpcSession(sessionId);

  if (!existing?.isAlive()) {
    if (!sessionFile) throw new Error("Session not found");
    const ownership = acquireSessionRuntimeOwnership(sessionFile);
    try {
      const manager = SessionManager.open(sessionFile, undefined);
      // SAFETY: these readers validate native custom-entry payloads before using them.
      const entries = manager.getEntries() as unknown as SessionEntry[];
      if (readValidSubagentResources(entries)) {
        throw new Error("Subagent tool selection is fixed by its profile");
      }
      const persistedToolPolicy = readSessionToolSelectionPolicy(entries);
      const effectiveStrictToolAllowlist = strictToolAllowlist ?? persistedToolPolicy?.strict ?? false;
      if (toolNames === undefined) appendClearedSessionToolSelection(manager);
      else appendSessionToolSelection(manager, toolNames, {
        strict: effectiveStrictToolAllowlist,
      });
    } finally { ownership.release(); }
    invalidateSessionListCache();
    const started = await startRpcSession(sessionId, sessionFile, undefined);
    return { session: started.session, sessionId: started.realSessionId, recreated: false };
  }

  if (existing.isRunning() || existing.isPromptRunning || existing.inner.isBashRunning) {
    throw new Error("Cannot change tools while the session is running");
  }
  if (readValidSubagentResources(existing.inner.sessionManager.getEntries() as unknown as SessionEntry[])) {
    throw new Error("Subagent tool selection is fixed by its profile");
  }

  const hasCurrentResourcePolicy = typeof existing.isChatOnly === "function"
    && typeof existing.setActiveToolSelection === "function";
  const currentStrictToolAllowlist = typeof existing.isStrictToolAllowlist === "function"
    && existing.isStrictToolAllowlist();
  const nextStrictToolAllowlist = strictToolAllowlist ?? currentStrictToolAllowlist;
  const crossesChatOnlyBoundary = toolNames === undefined
    || !hasCurrentResourcePolicy
    || existing.isChatOnly() !== (toolNames.length === 0);
  const crossesStrictToolBoundary = currentStrictToolAllowlist !== nextStrictToolAllowlist;
  if (toolNames === undefined) appendClearedSessionToolSelection(existing.inner.sessionManager);
  else appendSessionToolSelection(existing.inner.sessionManager, toolNames, {
    strict: nextStrictToolAllowlist,
  });
  invalidateSessionListCache();

  if (toolNames !== undefined && !crossesChatOnlyBoundary && !crossesStrictToolBoundary) {
    existing.setActiveToolSelection(toolNames);
    await existing.refreshRemoteClaudeHostBinding();
    return { session: existing, sessionId, recreated: false };
  }

  const persistedFile = existing.sessionFile && existsSync(existing.sessionFile)
    ? existing.sessionFile
    : undefined;
  const sessionCwd = existing.cwd;
  const model = existing.inner.model;
  const currentThinkingLevel = existing.inner.agent.state?.thinkingLevel;
  const runtimeAutoCompactionEnabled = existing.getRuntimeAutoCompactionEnabled();
  await existing.shutdown();

  if (persistedFile) {
    const started = await startRpcSession(sessionId, persistedFile, undefined);
    if (runtimeAutoCompactionEnabled !== null) started.session.setRuntimeAutoCompactionEnabled(runtimeAutoCompactionEnabled);
    return { session: started.session, sessionId: started.realSessionId, recreated: true };
  }

  const recreationOptions = buildTransientSessionRecreationOptions(existing.inner.sessionManager, {
    ...(toolNames !== undefined ? { toolNames } : {}),
    ...(toolNames !== undefined ? { strictToolAllowlist: nextStrictToolAllowlist } : {}),
    ...(model ? { initialModel: { provider: model.provider, modelId: model.id } } : {}),
    ...(currentThinkingLevel && THINKING_LEVEL_NAMES.has(currentThinkingLevel as ThinkingLevel)
      ? { thinkingLevel: currentThinkingLevel as ThinkingLevel }
      : {}),
  });
  const started = await startRpcSession(
    `__recreate__${randomUUID()}`,
    "",
    sessionCwd,
    recreationOptions,
  );
  if (runtimeAutoCompactionEnabled !== null) started.session.setRuntimeAutoCompactionEnabled(runtimeAutoCompactionEnabled);
  if (existing.getUnattendedConfigured()) started.session.initializeUnattendedDefault(existing.getUnattendedEnabled());
  return { session: started.session, sessionId: started.realSessionId, recreated: true };
  });
}

// ----------------------------------------------------------------------------
// Running-status broadcaster
//
// Pushes the current set of running session ids to subscribers whenever any
// session's running state may have changed. This lets the sidebar receive live
// updates over SSE instead of polling. Listeners live on globalThis so they
// survive Next.js hot-reload.
// ----------------------------------------------------------------------------

function getRunningListeners(): Set<(ids: string[]) => void> {
  if (!globalThis.__piRunningListeners) globalThis.__piRunningListeners = new Set();
  return globalThis.__piRunningListeners;
}

/** Subscribe to running-session-id changes. Returns an unsubscribe function. */
export function subscribeRunningSessions(listener: (ids: string[]) => void): () => void {
  const listeners = getRunningListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let lastRunningSnapshot = "";

/**
 * Recompute the running-session-id set and, if it changed since the last
 * notification, broadcast it to subscribers.
 */
export function notifyRunningChange(): void {
  const listeners = getRunningListeners();
  if (listeners.size === 0) {
    // A future subscriber receives its own initial snapshot. Clear this one so
    // its first state transition cannot match stale state from an old listener.
    lastRunningSnapshot = "";
    return;
  }
  const ids = getRunningRpcSessionIds();
  const snapshot = JSON.stringify([...ids].sort());
  if (snapshot === lastRunningSnapshot) return;
  lastRunningSnapshot = snapshot;
  for (const listener of listeners) {
    try { listener(ids); } catch { /* ignore listener errors */ }
  }
}

// ----------------------------------------------------------------------------
// Waiting-for-user session broadcast: sessions with pending extension UI
// requests (ask_user dialogs etc.). The reader plays the "wait" sound from a
// single global place so the beep fires even when no ChatWindow instance is
// mounted for the session (e.g. the session was never opened in this page
// session, or its background instance was removed after going idle). Listeners
// live on globalThis so they survive Next.js hot-reload.
// ----------------------------------------------------------------------------

export interface WaitingUserEntry {
  sessionId: string;
  requestIds: string[];
}

function getWaitingListeners(): Set<(entries: WaitingUserEntry[]) => void> {
  if (!globalThis.__piWaitingListeners) globalThis.__piWaitingListeners = new Set();
  return globalThis.__piWaitingListeners;
}

/** Subscribe to waiting-for-user session changes. Returns an unsubscribe function. */
export function subscribeWaitingUserRequests(listener: (entries: WaitingUserEntry[]) => void): () => void {
  const listeners = getWaitingListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let lastWaitingSnapshot = "";

/**
 * Recompute the waiting-for-user session/request snapshot and, if it changed,
 * broadcast it to subscribers.
 */
export function notifyWaitingUserChange(): void {
  const listeners = getWaitingListeners();
  if (listeners.size === 0) {
    // A future subscriber receives its own initial snapshot. Clear this one so
    // its first state transition cannot match stale state from an old listener.
    lastWaitingSnapshot = "";
    return;
  }
  const entries = getWaitingForUserRequests();
  const snapshot = JSON.stringify(entries);
  if (snapshot === lastWaitingSnapshot) return;
  lastWaitingSnapshot = snapshot;
  for (const listener of listeners) {
    try { listener(entries); } catch { /* ignore listener errors */ }
  }
}

export function getWaitingForUserRequests(): WaitingUserEntry[] {
  const entries: WaitingUserEntry[] = [];
  for (const [sessionId, session] of globalThis.__piSessions ?? []) {
    if (!session.hasPendingUserInteraction()) continue;
    const requestIds = session.pendingUserRequestIds();
    if (requestIds.length === 0) continue;
    entries.push({ sessionId: session.sessionId || sessionId, requestIds });
  }
  return entries;
}

/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), pi generates its own id.
 * New sessions resolve enabledModels before construction so the initial model,
 * thinking pin, and SDK scopedModels share one settings snapshot.
 * Pass options.toolNames to pre-configure active tools (empty = all disabled).
 */
export async function assertRpcSessionRuntimeBinding(session: AgentSessionWrapper, sessionFile = session.sessionFile): Promise<void> {
  assertSessionFileExecutable(sessionFile);
  assertReaderExecutionCwd(session.cwd);
  if (session.inner.sessionManager.getSessionId() !== session.sessionId) throw new Error('Reader runtime session identity changed');
  if (sessionFile && session.sessionFile && !samePath(resolve(sessionFile), resolve(session.sessionFile))) {
    throw new Error('Reader runtime session file differs from the opened session');
  }
}

export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string | undefined,
  options: RpcSessionStartOptions = {},
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const { sessionDir, toolNames, strictToolAllowlist, initialModel, fastMode } = options;
  let thinkingLevel: ThinkingLevel | undefined = options.thinkingLevel;
  const registry = getRegistry();
  const locks = getLocks();

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  let finishStartingSession: (() => void) | undefined;
  let runtimeOwnership: SessionRuntimeOwnership | undefined;
  let unregisteredInner: AgentSessionLike | undefined;
  let startingWrapper: AgentSessionWrapper | undefined;
  // Register admission before runtime lookup, binding validation, or SDK creation.
  const starting = Promise.resolve().then(async () => {
    const existing = registry.get(sessionId);
    if (existing?.hasPendingControlReceiptPersistence()) {
      throw Object.assign(new Error("Wait for terminal control receipt persistence before starting this session"),
        { code: "receipt_persistence_pending" });
    }
    if (existing && (existing.isAlive() || existing.isShuttingDown())) {
      if (existing.isAlive() && !existing.isShuttingDown()) {
        await assertRpcSessionRuntimeBinding(existing, sessionFile || existing.sessionFile);
        if (existing.isAlive() && !existing.isShuttingDown() && registry.get(sessionId) === existing) {
          return { session: existing, realSessionId: sessionId };
        }
      }
      void existing.shutdown().catch(() => undefined);
      if (typeof existing.waitUntilDisposed === "function") await existing.waitUntilDisposed();
      else await existing.shutdown();
    }

    let sessionManager: SessionManager;
    if (sessionFile) {
      assertSessionFileExecutable(sessionFile);
      runtimeOwnership = acquireSessionRuntimeOwnership(sessionFile);
      assertSessionFileExecutable(sessionFile);
      if (!existsSync(sessionFile)) throw new Error("Session file is no longer available");
      sessionManager = SessionManager.open(sessionFile, sessionDir);
      if (sessionManager.getSessionId() !== sessionId) throw new Error("Reader session identity changed while opening the runtime");
    } else {
      if (!cwd) throw new Error("cwd is required for a new session");
      sessionManager = SessionManager.create(cwd, sessionDir);
      runtimeOwnership = acquireSessionRuntimeOwnership(sessionManager.getSessionFile()!);
    }
    if (options.contextSourceSessionId && !sessionFile) {
      const header = sessionManager.getHeader();
      if (header) (header as unknown as ReaderSessionHeader).contextSourceSessionId = options.contextSourceSessionId;
    }
    const sessionCwd = assertReaderExecutionCwd(sessionManager.getCwd());
    readSessionAutoCompaction(sessionManager.getEntries());
    const runtimeProjectRoot = await readerRuntimeProjectRoot(sessionCwd);
    const startupEntries = sessionManager.getEntries() as unknown as SessionEntry[];
    const subagentResources = sessionFile
      ? readValidSubagentResources(startupEntries)
      : null;
    finishStartingSession = trackStartingSession(sessionCwd);
    // Some extensions access the SDK's global theme even outside the terminal UI.
    initTheme();
    const agentDir = getAgentDir();

    // Determine which tools to pass based on an explicit request or the newest
    // persisted Reader selection. Legacy sessions keep SDK defaults.
    const persistedToolPolicy = subagentResources
      ? undefined
      : readSessionToolSelectionPolicy(sessionManager.getEntries() as unknown as SessionEntry[]);
    const persistedToolNames = persistedToolPolicy?.tools;
    const effectiveToolNames = subagentResources?.tools ?? toolNames ?? persistedToolNames;
    if (!subagentResources && strictToolAllowlist === true) {
      if (toolNames === undefined) {
        throw new Error("strictToolAllowlist requires an explicit toolNames allow-list");
      }
      validateSessionToolSelection(toolNames);
    }
    const strictToolAllowlistEnabled = !subagentResources
      && (strictToolAllowlist ?? persistedToolPolicy?.strict ?? false)
      && effectiveToolNames !== undefined;
    const explicitStrictPolicyNeedsPersist = strictToolAllowlist !== undefined
      && effectiveToolNames !== undefined
      && (
        persistedToolPolicy !== undefined
          ? persistedToolPolicy.strict !== (strictToolAllowlist === true)
          : strictToolAllowlist === true
      );
    if (explicitStrictPolicyNeedsPersist) {
      // An explicit strict=false must retract an older strict=true policy so a
      // later reopen does not silently flip the runtime back to strict mode.
      // A new transient strict=true policy remains in memory until durable use.
      appendSessionToolSelection(sessionManager, effectiveToolNames, {
        strict: strictToolAllowlist === true,
      });
    }
    const chatOnly = effectiveToolNames?.length === 0
      && !subagentResources?.loadExtensions
      && !subagentResources?.loadSkills
      && !subagentResources?.codemode
      && !subagentResources?.mcp;
    const fastModeState = { mode: fastMode ?? readSessionFastMode(sessionManager.getEntries() as unknown[]) };
    // Since v0.68.0, session creation expects string[] tool names instead of Tool[] instances.
    let toolsOption: string[] | undefined;
    if (!subagentResources && effectiveToolNames !== undefined) {
      // toolNames === [] -> "all off" (an empty allow-list disables every tool).
      // Otherwise DO NOT pass a builtin-only allow-list: passing CODING_TOOL_NAMES
      // set allowedToolNames to coding builtins only, which filtered every
      // extension/package-provided tool (e.g. subagents, web access) out of the
      // tool registry — so they were unavailable in Pi Web sessions even though the
      // `pi` CLI keeps them. Leaving the allow-list unset lets the SDK register all
      // tools (and activate extension tools); we narrow the ACTIVE set below.
      toolsOption = effectiveToolNames.length === 0 || strictToolAllowlistEnabled
        ? effectiveToolNames
        : undefined;
    }

    // Built-in MCP/codemode/tool-search extensions are normal-session
    // facilities. Chat-only and profile-owned subagent sessions deliberately
    // stay dormant and must not connect external servers on inspection.
    const builtinResources = subagentResources && (subagentResources.codemode || subagentResources.mcp)
      ? await createPiWebBuiltinExtensions({ agentDir })
      : undefined;
    const builtins = subagentResources || chatOnly || strictToolAllowlistEnabled
      ? undefined
      : await createPiWebBuiltinExtensions({ agentDir });

    // Build services first so extension-registered providers are available
    // before the SDK restores the saved model from the session file.
    // Gate untrusted project extensions so opening a repository does not run
    // its .pi/extensions code automatically (see lib/project-trust.ts, #236).
    const trustReloadOptions = projectTrustReloadOptions(sessionCwd, agentDir);
    const projectTrust = getProjectTrustStatus(sessionCwd, agentDir);
    const baseSettingsManager = SettingsManager.create(sessionCwd, agentDir, {
      projectTrusted: projectTrust.trusted,
    });
    if (projectTrust.trusted) {
      const legacyMigrated = migrateLegacyProjectOverrides(baseSettingsManager);
      const webStateMigrated = migrateProjectWebStateKeys(baseSettingsManager, sessionCwd);
      if (legacyMigrated || webStateMigrated) {
        await baseSettingsManager.flush();
      }
    }
    const projectPluginSettingsManager = createProjectPluginSettingsManager(baseSettingsManager, {
      cwd: sessionCwd,
      agentDir,
    });
    const globalSkillEntries = await resolveGlobalSkillStateEntries(
      sessionCwd,
      agentDir,
      baseSettingsManager,
      projectPluginSettingsManager,
    );
    const projectSkillRuntime = projectTrust.trusted
      ? {
          entries: globalSkillEntries,
          states: {},
        } satisfies ProjectSkillRuntime
      : undefined;
    // Resolve the canonical Reader catalog once for this runtime. Subagent
    // sessions use the same catalog gate as their parent, including the
    // explicit noSkills capability boundary. A child catalog failure is a
    // runtime admission failure; it must not silently fall back to an
    // unfiltered SDK resource list.
    let skillPolicyCatalog: Awaited<ReturnType<typeof loadSkillPolicyCatalog>> | undefined;
    if (!subagentResources && !strictToolAllowlistEnabled) {
      try {
        skillPolicyCatalog = await loadSkillPolicyCatalog(
          sessionCwd,
          projectSkillRuntime ? "project" : "global",
        );
      } catch {
        skillPolicyCatalog = undefined;
      }
    }
    const skillRuntimeContext: RuntimeSkillPolicyContext = subagentResources
      ? await createSubagentSkillRuntimeContext({
          cwd: sessionCwd,
          agentDir,
          settingsManager: baseSettingsManager,
          loadSkills: subagentResources.loadSkills,
          projectTrusted: projectTrust.trusted,
        })
      : {
          scope: projectSkillRuntime ? "project" : "global",
          runtimeSkillsEnabled: !strictToolAllowlistEnabled,
          entries: globalSkillEntries,
          ...(skillPolicyCatalog && skillPolicyCatalog.skills.length > 0 ? {
            policies: skillPolicyCatalog.skills.map((skill) => skill.policy),
            stale: skillPolicyCatalog.stale,
            catalogSkills: skillPolicyCatalog.skills as RuntimeSkillLike[],
          } : {}),
          states: projectSkillRuntime?.states ?? {},
          globalInvocationModes: getSkillInvocationModes(baseSettingsManager.getGlobalSettings(), "global"),
          projectInvocationModes: projectSkillRuntime
            ? getSkillInvocationModes(baseSettingsManager.getProjectSettings(), "project", sessionCwd)
            : {},
          cwd: sessionCwd,
          agentDir,
        };

    const settingsManager = projectSkillRuntime
      ? createProjectSkillSettingsManager(projectPluginSettingsManager, projectSkillRuntime, {
          cwd: sessionCwd,
          agentDir,
        })
      : projectPluginSettingsManager;
    const subagentSkillNames = subagentResources
      ? permittedSubagentSkillNames(subagentResources.skills, skillRuntimeContext)
      : undefined;
    const subagentSkillsBinding = subagentResources
      ? createSubagentSkillsBinding({
          loadSkills: subagentResources.loadSkills,
          skills: subagentSkillNames,
          exactSystemPrompt: subagentResources.exactSystemPrompt,
        })
      : undefined;
    const subagentOriginalSkillsOverride = subagentSkillsBinding?.loaderOptions.skillsOverride;
    const subagentRuntimeSkillsOverride = subagentResources?.loadSkills && subagentSkillsBinding
      ? ((base: Parameters<NonNullable<typeof subagentOriginalSkillsOverride>>[0]) => {
          const projected = subagentOriginalSkillsOverride ? subagentOriginalSkillsOverride(base) : base;
          return {
            ...projected,
            skills: filterRuntimeSkills(projected.skills as RuntimeSkillLike[], skillRuntimeContext) as typeof projected.skills,
          };
        })
      : undefined;
    const subagentLoaderOptions = subagentResources
      ? subagentExtensionLoaderOptions(subagentResources)
      : undefined;
    const subagentMcpScope = subagentResources
      ? {
          tools: subagentResources.tools,
          ...(subagentResources.allExtensionTools ? { allExtensionTools: true } : {}),
        }
      : undefined;
    const subagentInnerRef: { current?: AgentSessionLike } = {};
    const subagentBuiltinNames = new Set<string>([
      ...(subagentResources?.codemode ? ["codemode"] : []),
      ...(subagentResources?.mcp ? ["tool-search", "mcp", "pi-web-mcp-host"] : []),
    ]);
    const subagentBuiltinFactories = builtinResources?.extensions.filter((extension) => subagentBuiltinNames.has(extension.name)) ?? [];
    const subagentStopBridge = createSubagentStopBridge();
    const services = await createAgentSessionServices({
      cwd: sessionCwd,
      agentDir,
      settingsManager,
      resourceLoaderOptions: subagentResources
        ? {
            ...subagentLoaderOptions,
            ...(subagentSkillsBinding?.loaderOptions ?? {}),
            ...(subagentRuntimeSkillsOverride ? { skillsOverride: subagentRuntimeSkillsOverride } : {}),
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            appendSystemPrompt: subagentResources.appendSystemPrompt,
            extensionFactories: [
              createCompactionModelExtension(settingsManager),
              createImageGenerationOutputExtension(),
              ...subagentBuiltinFactories,
              ...(subagentSkillsBinding?.loaderOptions.extensionFactories ?? []),
              createRemoteClaudeHostGuardExtension(),
              ...(subagentResources.mcp && subagentMcpScope
                ? [createSubagentMcpPolicyExtension(() => ({
                    tools: subagentInnerRef.current?.getActiveToolNames() ?? subagentMcpScope.tools,
                    ...(subagentMcpScope.allExtensionTools ? { allExtensionTools: true } : {}),
                  }))]
                : []),
            ],
          }
        : strictToolAllowlistEnabled
          ? {
              noExtensions: true,
              noSkills: true,
              noPromptTemplates: true,
              noThemes: true,
              noContextFiles: true,
              extensionFactories: [createCompactionModelExtension(settingsManager)],
            }
          : {
            // Keep SKILL.md immutable: panel state is applied to the SDK resource
            // objects immediately before prompt construction.
            skillsOverride: (base) => {
              const baseSkills = base.skills as RuntimeSkillLike[];
              if (!skillRuntimeContext.catalogSkills) skillRuntimeContext.catalogSkills = baseSkills;
              const applied = applySkillInvocationOverrides(
                base.skills,
                globalSkillEntries,
                projectSkillRuntime?.states ?? {},
                projectSkillRuntime ? "project" : "global",
                new Map(base.skills.map((skill) => [resolve(skill.filePath), true])),
              );
              return {
                ...base,
                skills: filterRuntimeSkills(applied as RuntimeSkillLike[], skillRuntimeContext) as typeof base.skills,
              };
            },
            extensionFactories: [
              createCompactionModelExtension(settingsManager),
              createImageGenerationOutputExtension(),
              ...(builtins?.extensions ?? []),
              createReadOnlyMcpPolicyExtension(),
              createFastModeExtension(fastModeState),
              createProjectCommandBashExtension({
                cwd: sessionCwd,
                settings: settingsManager,
              }),
              createSessionControlExtension(),
              subagentStopBridge.extension,
              createSubagentExtension(
                SUBAGENT_CONTROLLER.extensionRuntime,
                () => listSubagentProfiles(sessionCwd),
                isBuiltInSubagentsEnabled,
              ),
            ],
            extensionsOverride: (base) => preferUserBashExtension(preferPiWebSubagentExtension(base)),
          },
      ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
    });
    if (subagentResources?.codemode
      && !services.resourceLoader.getExtensions().extensions.some((extension) => extension.tools.has("codemode"))) {
      throw new Error("Code mode is unavailable: builtin:codemode was not registered");
    }
    const scope = await resolveVisibleModels(
      services.modelRuntime,
      services.settingsManager.getEnabledModels(),
    );
    const thinkingLevelDefaults = getModelThinkingDefaults(readModelsConfig());
    const defaultProvider = services.settingsManager.getDefaultProvider();
    const defaultModelId = services.settingsManager.getDefaultModel();
    const hasExistingMessages = sessionManager.getBranch().some((entry) => entry.type === "message");
    const persistedThinkingLevel = readSessionThinkingLevel(sessionManager);
    if (thinkingLevel === undefined && persistedThinkingLevel !== undefined) {
      thinkingLevel = persistedThinkingLevel;
    }
    const initial = hasExistingMessages
      ? {
          scopedModels: [...scope.scopedModels],
          ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
        }
      : selectInitialModelScope(scope, {
        ...(initialModel ? { requestedModel: initialModel } : {}),
        ...(defaultProvider && defaultModelId
          ? { defaultModel: { provider: defaultProvider, modelId: defaultModelId } }
          : {}),
        thinkingLevelDefaults,
        ...(thinkingLevel ? { thinkingLevel } : {}),
      });
    const { session: inner } = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(initial.model ? { model: initial.model } : {}),
      ...(initial.thinkingLevel ? { thinkingLevel: initial.thinkingLevel } : {}),
      ...(initial.scopedModels.length > 0 ? { scopedModels: initial.scopedModels } : {}),
      ...(subagentResources
        ? subagentToolOptions(subagentResources)
        : toolsOption !== undefined ? { tools: toolsOption } : {}),
    });
    unregisteredInner = inner;
    subagentInnerRef.current = inner;
    if (subagentSkillsBinding) {
      subagentSkillsBinding.setActiveToolsGetter(() => inner.getActiveToolNames());
    }
    if (!hasExistingMessages && !initial.thinkingLevel && inner.model) {
      // If SDK selected the model because no saved model existed, apply the
      // same strongest-level default used by explicit model selection.
      const level = resolveDefaultThinkingLevel(
        getSupportedThinkingLevels(inner.model),
        thinkingLevelDefaults[`${inner.model.provider}/${inner.model.id}`],
        scope.thinkingLevelPins[`${inner.model.provider}/${inner.model.id}`],
      );
      if (level && inner.thinkingLevel !== level) inner.setThinkingLevel(level);
    }
    if (fastMode === "fast" && !isFastModeSupported(inner.model as unknown as FastModeModelLike)) {
      throw new Error("Fast mode is not available for this model");
    }

    if (initialModel) {
      const persistedPreferences = await persistExplicitStartupPreferences(
        services.settingsManager,
        { model: initialModel },
        {
          ...(inner.model
            ? { model: { provider: inner.model.provider, modelId: inner.model.id } }
            : {}),
        },
      );
      if (persistedPreferences.modelDefaultChanged) invalidateModelsCache();
    }

    // Replace only Reader's coding selection; the SDK's initial active set is
    // the source of truth for extension/package tools and dynamic defaults.
    if (!subagentResources) {
      const initialToolNames = inner.getActiveToolNames();
      inner.setActiveToolsByName(resolveActiveToolNames(
        inner,
        effectiveToolNames ?? initialToolNames,
        strictToolAllowlistEnabled ? [] : initialToolNames,
      ));
    }

    let remoteClaudeHost: RemoteClaudeHostBinding | undefined;
    try {
      // Strict mode may omit the general host surface, but a reopened child
      // with a parent binding must still pass through the host capability
      // check and preserve the existing parent-scope rejection boundary.
      if (!strictToolAllowlistEnabled || options.parentRemoteHost) {
        remoteClaudeHost = (await installRemoteClaudeHost({
          hostIdentity: inner as unknown as object,
          sessionManager: inner.sessionManager,
          sessionId: inner.sessionId,
          cwd: sessionCwd,
          agentDir,
          activeTools: inner.getActiveToolNames(),
          modelRuntime: services.modelRuntime,
          builtInEnabled: isBuiltInSubagentsEnabled(),
          allowWorktree: true,
          allowInheritedContext: true,
          allowCancellation: true,
          ...(options.parentRemoteHost ? { parent: options.parentRemoteHost } : {}),
          readOnlyRoots: [runtimeProjectRoot],
        })) ?? undefined;
        if (options.parentRemoteHost && !remoteClaudeHost) {
          throw new Error("capability-unavailable: Reader host scope could not be installed for reopened child session");
        }
      }
      const wrapper = new AgentSessionWrapper(inner, projectSkillRuntime, fastModeState, {
        ...((builtinResources?.mcpHost ?? builtins?.mcpHost) ? { mcpHost: builtinResources?.mcpHost ?? builtins?.mcpHost } : {}),
        ...(remoteClaudeHost ? { remoteClaudeHost } : {}),
        ...(strictToolAllowlistEnabled ? { strictToolAllowlist: true } : {}),
        skillRuntimeContext,
        runtimeOwnership,
        stopBackgroundRun: subagentStopBridge.stop,
      });
      startingWrapper = wrapper;
      runtimeOwnership = undefined;
      unregisteredInner = undefined;
      const subagentPolicy = { suppressCompletionNotifications: Boolean(subagentResources) };
      if (subagentPolicy.suppressCompletionNotifications) wrapper.setSuppressCompletionNotifications(true);
      if (fastMode !== undefined) {
        // Fast mode is draft configuration for a new runtime. If this is an
        // existing persisted session, SessionManager appends it immediately;
        // otherwise the first user message/name/bash event promotes the draft.
        appendSessionFastMode(inner.sessionManager, fastMode);
      }
      // When all tools are disabled, clear the system prompt entirely.
      // pi's buildSystemPrompt always produces a non-empty prompt even with no tools;
      // keep this forced after extension resource discovery and reloads as well.
      if (effectiveToolNames?.length === 0) {
        wrapper.setForceEmptySystemPrompt(true);
      }
      // New runtimes remain transient until a user message, explicit name, or
      // completed bash-only command gives them durable user intent. This keeps
      // ensure/system/slash/model/thinking/Fast/tools preflight out of JSONL.


      const realSessionId = inner.sessionId as string;
      registerRpcSession(wrapper);
      void drainLocalOwnerOutboxes().catch((error) => {
        console.error("[session-wait] startup owner continuation drain failed:", error instanceof Error ? error.message : String(error));
      });
      wrapper.restoreUnattendedState(getPersistedUnattendedState(realSessionId));
      wrapper.beginExtensionBinding({ forceEmptySystemPrompt: effectiveToolNames?.length === 0 });
      wrapper.restoreQuestionAnalysisJobs(latestQuestionAnalysisJobs(startupEntries).filter(isResumableQuestionAnalysisJob));

      startingWrapper = undefined;
      return { session: wrapper, realSessionId };
    } catch (error) {
      // A scope may be installed before wrapper registration or extension
      // binding. Revoke only that exact generation on setup failure.
      revokeRemoteClaudeHost(remoteClaudeHost);
      throw error;
    }
  }).catch(async (error) => {
    try {
      if (startingWrapper) await startingWrapper.shutdown();
      else unregisteredInner?.dispose();
    } finally { runtimeOwnership?.release(); }
    throw error;
  }).finally(() => {
    if (locks.get(sessionId) === starting) locks.delete(sessionId);
    finishStartingSession?.();
  });

  locks.set(sessionId, starting);
  return starting;
}
