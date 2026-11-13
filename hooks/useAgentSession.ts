"use client";
import { latestRetryErrorEntry } from "@/lib/retry-display-state";

import { useQueueRecovery, type QueueRecoveryView } from "@/hooks/useQueueRecovery";

import { useI18n } from "./useI18n";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo, useReducer, useSyncExternalStore } from "react";
import {
  isSessionOpenScroll,
  loadSessionOpenScroll,
  SESSION_OPEN_SCROLL_CHANGED_EVENT,
  type SessionOpenScroll,
} from "@/lib/session-open-scroll-preference";
import { removeMessage, withOccurrence, type TranscriptMessages, type TranscriptDelivery } from "@/lib/transcript-store";
import type { HistoryOrderKey } from "@/lib/session-history-types";
import { TranscriptReader } from "@/lib/transcript-reader";
import { TranscriptViewport } from "@/lib/transcript-viewport";
import { flushSync } from "react-dom";

import type {
  AgentMessage,
  BlockingExtensionUiRequest,
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionUsageItem,
  ExtensionWidgetItem,
  SessionInfo,
  SessionTreeNode,
  UserMessage,
  ToolResultMessage,
} from "@/lib/types";
import { isBlockingExtensionUiRequest } from "@/lib/browser-notifications";
import { normalizeToolCalls } from "@/lib/normalize";
import { useContinueController, CONTINUE_TEXT } from "@/hooks/useContinueController";
import type { SchedulerState } from "@/lib/continue-logic";
import { AgentCommandError, isPromptRejectedError, isSessionMissingError, sendAgentCommand, SESSION_RESOURCES_RELOADED_EVENT } from "@/lib/agent-client";
import { BranchNavigation, canWriteBranch, isBranchPositionError } from "@/lib/branch-navigation";
import type { QuestionAnalysisPromptMetadata } from "@/lib/question-analysis";
import { markSessionDialogInteracted } from "@/hooks/useAudio";
import { draftKeyIdentity, getDraft, setDraft, rekeyDraft, restoreDraftSubmission, historyDraftKey, sessionDraftKey, type DraftKey, type ChatDraftImage, type HistoryEditDraft } from "@/lib/draft-store";
import { getPreferredToolPreset, setPreferredToolPreset } from "@/lib/tool-preset-preference";
import { CONFIGURED_TOOL_PRESET, getPresetFromToolNames, getToolNamesForPreset, type ToolEntry, type ToolPreset } from "@/lib/tool-presets";
import type { ModelErrorInfo } from "@/lib/models-cache";
import { resolveDefaultThinkingLevel } from "@/lib/thinking-level";
import { fastModeStatus, type FastModeSelection, type FastModeStatus } from "@/lib/fast-mode";
import type { CompactionContextInfo, SessionStatsInfo } from "@/lib/pi-types";
import type { SessionTimingInfo } from "@/lib/session-timing";
import type { RuntimeInspection } from "@/lib/runtime-inspection";
import { summarizeCompactionCosts, type SessionCompactionCost } from "@/lib/session-cost";
import { ensureSessionCost, invalidateSessionDetails } from "@/lib/session-details-client";
import { sendTransientSessionCommand } from "@/lib/session-runtime";
import { useSessionDetails } from "@/hooks/useSessionDetails";

import type { ImageGenerationCost } from "@/lib/image-generation-cost";
import type { WorktreeBindingDraft } from "@/lib/worktree-bindings";
const EMPTY_IMAGE_GENERATION_COSTS: ImageGenerationCost[] = [];
const EMPTY_MESSAGE_COSTS: Record<string, number> = {};
const EMPTY_COMPACTION_COSTS: Record<string, SessionCompactionCost> = {};
const EMPTY_COMPACTION_CONTEXTS: Record<string, CompactionContextInfo> = {};
import { AgentEventConnection } from "@/lib/agent-event-connection";
import { agentEndErrorMessage, agentEndWasAborted, isNestedToolExecutionEvent } from "@/lib/agent-event-wire";
import { isSessionPeerAgentMessage } from "@/lib/session-peer-message";
import { getToolExecutionProgress } from "@/lib/tool-execution-progress";
import { CODEMODE_TOOL_NAME, getCodemodeProgress } from "@/lib/codemode-view";
import { bareMcpOpensSettings } from "@/lib/mcp-command";
import type { SettingsSection } from "@/lib/settings-navigation";
import {
  enqueueExtensionUiRequest,
  removeExtensionUiRequest,
  retainExtensionUiRequests,
  upsertExtensionUiRequest,
} from "@/lib/extension-ui-queue";
import { shouldShowScrollToLatest } from "@/lib/chat-lazy-load";
import {
  createStreamingStore,
  type ClientAssistantMessageEvent,
} from "@/lib/streaming-message";
import type { QuestionAnalysisJobView, QuestionDraftView } from "@/lib/question-analysis-jobs";
import {
  QueuedDraftProjection,
  getPendingQueueRecall,
  getQueueRecallOperation,
  beginQueueRecallOperation,
  markQueueRecallRestored,
  assertUserQueueRecall,
  clearQueueRecallOperation,
  savePendingQueueRecall,
  clearPendingQueueRecall,
  queuedImageCount,
  readQueuedDraftState,
  recalledQueuedDrafts,
  type QueuedDraftState,
  type QueuedDraftSummary,
} from "@/lib/queued-draft";

type SessionLoadRunGuard = {
  stateRunRevision: number;
  serverRunId?: string;
};

export interface SessionData {
  /** Metadata bootstrap intentionally carries no durable transcript messages. */
  metadataOnly?: boolean;
  toolNames?: string[];
  sessionId: string;
  filePath: string;
  timing?: SessionTimingInfo;
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  tree: SessionTreeNode[];
  leafId: string | null;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
    oldestEntryId?: string | null;
    hasMore?: boolean;
  };
  questionAnalysisJobs?: QuestionAnalysisJobView[];
  questionDraftViews?: Record<string, QuestionDraftView>;
  fastMode?: FastModeSelection;
  /** Opaque freshness token for the client view cache; null when unstable. */
  snapshotRevision?: string | null;
  stats?: SessionStatsInfo;
}

export type SessionForkResult =
  | { newSessionId: string; newSessionPath?: string; subprojectAssignmentFailed?: boolean }
  | { restoreMessage: UserMessage };

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}


type SessionLoadRegistration = {
  generation: number;
  sessionId: string;
  peer: string | null;
  scope: string;
  showLoading: boolean;
  targetLeafId?: string | null;
};

interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

interface LastAssistantTextResponse {
  text?: string;
}

type NewSessionResponse = {
  sessionId?: string;
  branchPosition?: { leafId: string | null; pending: boolean };
  autoCompactionEnabled?: boolean;
  model?: SelectedModel | null;
  thinkingLevel?: ThinkingLevelOption;
  fastMode?: FastModeStatus;
  error?: string;
  code?: string;
  accepted?: boolean;
};

type AgentStateResponse = {
  branchPosition?: { leafId: string | null; pending: boolean };
  model?: { id: string; provider: string };
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt?: string;
  runtimeInspection?: RuntimeInspection;
  thinkingLevel?: string;
  fastMode?: FastModeStatus;
  isStreaming?: boolean;
  isPromptRunning?: boolean;
  isBashRunning?: boolean;
  isCompacting?: boolean;
  autoCompactionEnabled?: boolean;
  extensionStatuses?: ExtensionStatusItem[];
  extensionUsages?: ExtensionUsageItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  editorSuggestion?: string | null;
  queuedMessages?: { steering?: string[]; followUp?: string[] } | null;
  queueSnapshot?: QueuedDraftState | null;
};

type PromptDelivery = {
  clientMessageId: string;
  sessionId: string;
  peer: string | null;
  runId: number;
  confirmed: boolean;
  historyEditEntryId?: string;
};

export interface QueuedMessages {
  recallPending?: boolean;
  recallState?: "idle" | "recalling" | "confirming" | "confirm_retry" | "server_copy";
  recallBlocked?: "too_many_images" | "non_user";
  recovery?: QueueRecoveryView;
  steering: QueuedDraftSummary[];
  followUp: QueuedDraftSummary[];
}

function normalizeQueuedMessages(snapshot: QueuedDraftState | null, legacy?: { steering?: string[]; followUp?: string[] } | null): QueuedMessages {
  if (snapshot) return {
    steering: snapshot.steering.map(({ itemId, text, hasImages }) => ({ itemId, text, hasImages })),
    followUp: snapshot.followUp.map(({ itemId, text, hasImages }) => ({ itemId, text, hasImages })),
  };
  // Older peers remain readable, but their text-only queues cannot be recalled
  // safely: handleRecallQueue refuses to mutate without an identity snapshot.
  return {
    steering: (legacy?.steering ?? []).map(text => ({ text, hasImages: false })),
    followUp: (legacy?.followUp ?? []).map(text => ({ text, hasImages: false })),
  };
}

type ExtensionUiDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
export type NoticeType = "info" | "success" | "warning" | "error";

export type NoticeItem = {
  id: string;
  message: string;
  type: NoticeType;
  exiting?: boolean;
};

type NoticeState = {
  visible: NoticeItem[];
  pending: NoticeItem[];
};

type NoticeAction =
  | { type: "add"; notice: NoticeItem }
  | { type: "mark_oldest_exiting" }
  | { type: "mark_all_exiting" }
  | { type: "remove"; id: string };

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "running_tools"; tools: { id: string; name: string; progress?: string }[] }
  | null;

export interface CompactResultInfo {
  reason: "manual" | "threshold" | "overflow" | "auto" | string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

export type BuiltinSlashCommandResult =
  | { handled: false }
  | { handled: true; message?: string; error?: string; action?: "openSessionStats" | "openSettings" };

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  sessionRunning?: boolean;
  background?: boolean;
  newSessionCwd: string | null;
  newSessionSubprojectId?: string | null;
  newSessionContextSourceId?: string | null;
  newSessionWorktreeBinding?: WorktreeBindingDraft | null;
  newSessionDraftKey: string | null;
  onAgentEnd?: (serverRunId?: string) => void;
  onAgentError?: (serverUnattended?: boolean, serverRunId?: string) => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest) => void;
  onSessionCreated?: (session: SessionInfo, sourceDraftKey: string) => void;
  onSessionReady?: (busy: boolean) => void;
  onSessionForked?: (result: SessionForkResult) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void, locked: boolean) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSystemToolsChange?: (tools: ToolEntry[] | null) => void;
  onRuntimeInspectionChange?: (inspection: RuntimeInspection | null) => void;
  /** Registers an action that lazily starts the session and returns its system prompt. */
  onSystemPromptLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  onSessionStatsPanelOpen?: () => void;
  sessionStatsRefreshRef?: { current: (() => Promise<void>) | null };
  /** Opens Settings on a section; a bare `/mcp` the built-in MCP extension owns opens Settings › MCP. */
  onOpenSettings?: (section: SettingsSection) => void;
  setToolPreset?: (preset: ToolPreset) => void;
  /** Reader local patch: route all session/agent/model API calls through the
   *  /api/remote proxy to operate a session living on another device. */
  remotePeer?: string;
  onRetryContinueStarted?: (scope: { sessionId: string; peer: string | null; entryId: string | null }) => void;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ConcreteThinkingLevel = Exclude<ThinkingLevelOption, "auto">;

const SUBPROJECT_ASSIGNMENT_ERROR_NAME = "SubprojectAssignmentError";

function isSubprojectAssignmentError(error: unknown): error is Error {
  return error instanceof Error && error.name === SUBPROJECT_ASSIGNMENT_ERROR_NAME;
}

function asConcreteThinkingLevel(value?: string | null): ConcreteThinkingLevel | null {
  if (!value || value === "auto") return null;
  return value as ConcreteThinkingLevel;
}

// Session id -> user entry being edited. ChatWindow remounts per session, so a
// pending edit lives here as long as that session's in-memory draft does.
const pendingHistoryEdits = new Map<string, HistoryEditDraft & { targetLeafId: string | null }>();

const EVENT_STREAM_IDLE_GRACE_MS = 30_000;
const EVENT_STREAM_READY_TIMEOUT_MS = 60_000;
const EVENT_STREAM_RECONNECT_DELAY_MS = 1_000;
/** The server sends a heartbeat data event every 30 s; three missed beats means the path is dead. */
const EVENT_STREAM_SILENCE_TIMEOUT_MS = 90_000;
const SESSION_LEASE_RENEW_INTERVAL_MS = 30_000;
// Retry temporary model-list failures without requiring a page refresh.
const MODELS_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
// 发送 prompt 后的快速结算恢复：当 per-session SSE 丢失/中断（Monitor 全部设备
// 内嵌 iframe 等多连接下更易发生）时，agent_end/agent_settled 不到达，会话卡
// “处理中”且回复不显示；此处轮询服务端状态，一旦空闲即走 finishPromptWithoutStream
// 落库并刷新消息，避免“跳出会话重进才看到回复”。轮询有界（最多 20s）且只在
// agentRunning 为真时进行；SSE 正常时 agent_settled 会置 false，循环立即退出，
// 不会持续轮询。ponytail: 该恢复在 SSE 正常时也会发起少数几次状态请求，若后台
// 负载需进一步优化可改为“SSE 断线/重连时触发单次结算检查”。
const PROMPT_SETTLE_INITIAL_DELAY_MS = 800;
const PROMPT_SETTLE_POLL_MS = 1_200;
const PROMPT_SETTLE_MAX_MS = 20_000;
const MAX_NOTICES = 5;
const NOTICE_VISIBLE_MS = 5000;
const NOTICE_EXIT_ANIMATION_MS = 180;
const NOTICE_HOVER_POLL_MS = 150;
function createNoticeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markOldestNoticeExiting(notices: NoticeItem[]): NoticeItem[] {
  const index = notices.findIndex((notice) => !notice.exiting);
  if (index === -1) return notices;
  return notices.map((notice, i) => (
    i === index ? { ...notice, exiting: true } : notice
  ));
}

function fillPendingNotices(visible: NoticeItem[], pending: NoticeItem[]): NoticeState {
  let nextVisible = visible;
  let nextPending = pending;
  while (nextPending.length > 0 && nextVisible.length < MAX_NOTICES) {
    const [next, ...rest] = nextPending;
    nextVisible = [...nextVisible, next];
    nextPending = rest;
  }
  if (nextPending.length > 0 && !nextVisible.some((notice) => notice.exiting)) {
    nextVisible = markOldestNoticeExiting(nextVisible);
  }
  return { visible: nextVisible, pending: nextPending };
}

function noticeReducer(state: NoticeState, action: NoticeAction): NoticeState {
  switch (action.type) {
    case "add": {
      if (state.visible.some((notice) => notice.exiting) || state.visible.length >= MAX_NOTICES) {
        return {
          visible: state.visible.some((notice) => notice.exiting)
            ? state.visible
            : markOldestNoticeExiting(state.visible),
          pending: [...state.pending, action.notice],
        };
      }
      return { ...state, visible: [...state.visible, action.notice] };
    }
    case "mark_oldest_exiting":
      return { ...state, visible: markOldestNoticeExiting(state.visible) };
    case "mark_all_exiting":
      return {
        ...state,
        visible: state.visible.some((notice) => !notice.exiting)
          ? state.visible.map((notice) => (notice.exiting ? notice : { ...notice, exiting: true }))
          : state.visible,
      };
    case "remove": {
      const visible = state.visible.filter((notice) => notice.id !== action.id);
      return fillPendingNotices(visible, state.pending);
    }
    default:
      return state;
  }
}

function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as CompactCommandResult;
  if (typeof r.tokensBefore !== "number" || typeof r.estimatedTokensAfter !== "number") return null;
  return { reason, tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter };
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  replaceMessage: (message: UserMessage) => boolean;
  prependText: (text: string, images?: ChatDraftImage[]) => void;
  availableImageSlots: () => number;
  hasQueuedDraft: (operationId: string) => boolean;
  isQueuedDraftDurable: (operationId: string) => boolean;
  prependQueuedDraft: (text: string, images: ChatDraftImage[], operationId?: string) => boolean;
  addImages: (files: File[]) => void;
  rekeyDraft: (previousKey: DraftKey, nextKey: DraftKey) => void;
  restoreSubmission: (text: string, images?: Array<{ data: string; mimeType: string }>, targetDraftKey?: DraftKey) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

type SelectedModel = { provider: string; modelId: string };
type ModelEntry = {
  id: string;
  name: string;
  provider: string;
  fastModeSupported?: boolean;
  fastModeDefault?: boolean;
};
type ModelsResponse = {
  models?: Record<string, string>;
  modelList?: ModelEntry[];
  defaultModel?: SelectedModel | null;
  defaultThinkingLevel?: string | null;
  savedDefaultThinkingLevel?: string | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
  thinkingLevelPins?: Record<string, string>;
  thinkingLevelDefaults?: Record<string, string>;
  fastMode?: FastModeStatus;
  modelError?: ModelErrorInfo;
  modelScopeWarnings?: string[];
  error?: string;
};

type SlashCommandsResponse = {
  commands?: SlashCommandInfo[];
};

export function createPromptCompletionDeduper() {
  let sessionId: string | null = null;
  const notifiedServerRunIds = new Set<string>();
  const notifiedLocalRunIds = new Set<number>();
  return {
    claim(nextSessionId: string | null, localRunId: number, serverRunId?: string): boolean {
      if (sessionId !== nextSessionId) {
        sessionId = nextSessionId;
        notifiedServerRunIds.clear();
        notifiedLocalRunIds.clear();
      }
      const serverId = typeof serverRunId === "string" ? serverRunId.trim() : "";
      if (serverId) {
        if (notifiedServerRunIds.has(serverId)) return false;
        notifiedServerRunIds.add(serverId);
        return true;
      }
      if (notifiedLocalRunIds.has(localRunId)) return false;
      notifiedLocalRunIds.add(localRunId);
      return true;
    },
  };
}

export function useAgentSession(opts: UseAgentSessionOptions) {
  const { t } = useI18n();
  const {
    session, sessionRunning, newSessionCwd, newSessionSubprojectId, newSessionContextSourceId, newSessionWorktreeBinding, newSessionDraftKey, onAgentEnd, onAgentError, onAttentionNeeded, onSessionCreated, onSessionReady, onSessionForked,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange, onSystemToolsChange, onRuntimeInspectionChange, onSystemPromptLoaderChange, onSessionStatsPanelOpen, sessionStatsRefreshRef,
    remotePeer,
    onOpenSettings,
  } = opts;

  const isNew = session === null && newSessionCwd !== null;
  const isNewSession = session === null;
  const [, renderBranch] = useReducer((value: number) => value + 1, 0);
  const onRetryContinueStartedRef = useRef(opts.onRetryContinueStarted);
  onRetryContinueStartedRef.current = opts.onRetryContinueStarted;
  const branchRef = useRef<BranchNavigation | null>(null);
  if (!branchRef.current) branchRef.current = new BranchNavigation(renderBranch);
  const branchScope = `${remotePeer ?? "local"}:${session?.id ?? newSessionDraftKey ?? "new"}`;
  const branchScopeRef = useRef(branchScope);
  branchScopeRef.current = branchScope;
  // Reset after commit so changing sessions cannot publish a render-phase update.
  useEffect(() => {
    branchRef.current?.reset(branchScope, isNewSession);
  }, [branchScope, isNewSession]);

  // Reader local patch: remote sessions route every /api/* call through the
  // /api/remote proxy with ?peer=<device>. Stable helpers (ref-backed) so
  // existing useCallback dependency arrays stay correct.
  const remotePeerRef = useRef(remotePeer);
  remotePeerRef.current = remotePeer;
  const apiPath = useCallback((path: string) => {
    const peer = remotePeerRef.current;
    if (!peer) return `/api/${path}`;
    const [route, query] = path.split("?", 2);
    return `/api/remote/${route}?${query ? query + "&" : ""}peer=${peer}`;
  }, []);
  const sendAgentCommandR = useCallback(
    <T>(sid: string, cmd: Record<string, unknown>): Promise<T> => {
      const isInitialPromptSubmission = isNewSession && (cmd.type === "prompt" || cmd.type === "set_model");
      if ((!isInitialPromptSubmission && (!sessionHookMountedRef.current || branchScope !== branchScopeRef.current)) || sid !== sessionIdRef.current) {
        return Promise.reject(new AgentCommandError("The conversation or device changed", 409, "prompt_rejected", false));
      }
      const position = branchRef.current!.state;
      const writesContext = ["prompt", "edit_history", "retry_continue", "retry_continue_only", "bash", "compact", "steer", "follow_up", "reload"].includes(String(cmd.type));
      const activeStreamingPrompt = cmd.type === "prompt"
        && (cmd.streamingBehavior === "steer" || cmd.streamingBehavior === "followUp")
        && agentRunningRef.current;
      if (writesContext && !isNewSession && (sessionViewValidationPendingRef.current || !canWriteBranch(position)) && !activeStreamingPrompt) {
        return Promise.reject(new AgentCommandError("Return to the current conversation or confirm where to continue", 409, "prompt_rejected", false));
      }
      const guarded = ["prompt", "edit_history", "retry_continue", "retry_continue_only", "bash", "compact"].includes(String(cmd.type)) && !cmd.streamingBehavior;
      if (cmd.type === "initialize_runtime") eventConnectionRef.current?.maintain(sid);
      return sendAgentCommand<T>(sid, guarded ? { ...cmd, expectedLeafId: position.runtimeLeafId } : cmd, remotePeerRef.current).catch((error) => {
        if (branchScope === branchScopeRef.current && sessionHookMountedRef.current && isBranchPositionError(error)) {
          branchRef.current!.markUnconfirmed(error);
        }
        throw error;
      });
    },
    [branchScope, isNewSession],
  );

  const sessionDetailsVersion = session?.modified ?? "";
  const sessionDetails = useSessionDetails({
    sessionId: session?.id ?? null,
    version: sessionDetailsVersion,
    modelConfigRevision: modelsRefreshKey,
    peer: remotePeer,
    loadCost: Boolean(session?.id),
    loadPreview: Boolean(session?.id),
  });
  const costDetails = sessionDetails.cost;
  const costState = sessionDetails.costState ?? (costDetails === undefined ? "loading" : costDetails === null ? "error" : "ready");
  const compactionCosts = costDetails?.compactionCosts ?? EMPTY_COMPACTION_COSTS;
  const compactionContexts = costDetails?.compactionContexts ?? EMPTY_COMPACTION_CONTEXTS;
  const sessionCost = costDetails?.amount ?? null;
  const messageCosts = costDetails?.messageCosts ?? EMPTY_MESSAGE_COSTS;
  const imageGenerationCosts = costDetails?.imageGenerationCosts ?? EMPTY_IMAGE_GENERATION_COSTS;
  const sessionUsageTotals = costDetails?.mainCost?.usage ?? costDetails?.usage ?? null;
  const sessionCostMetadata = useMemo(() => {
    const compactionCost = costDetails?.compactionCost ?? (costState === "ready" ? summarizeCompactionCosts(compactionCosts) : undefined);
    return {
      costStatus: costDetails?.status ?? "unavailable",
      costState,
      missingPriceModels: costDetails?.missingPriceModels ?? [],
      pendingUsageCount: costDetails?.pendingUsageCount ?? 0,
      pendingUsageModels: costDetails?.pendingUsageModels ?? [],
      ...(costDetails?.parentCost ? { parentCost: costDetails.parentCost } : {}),
      ...(costDetails?.childCost ? { childCost: costDetails.childCost } : {}),
      ...(costDetails?.mainCost ? { mainCost: costDetails.mainCost } : {}),
      compactionCost,
      ...(costDetails?.recapCost ? { recapCost: costDetails.recapCost } : {}),
      ...(costDetails?.extensionCosts ? { extensionCosts: costDetails.extensionCosts } : {}),
      ...(costDetails?.totalCost ? { totalCost: costDetails.totalCost } : {}),
    };
  }, [compactionCosts, costDetails, costState]);

  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [questionAnalysisJobs, setQuestionAnalysisJobs] = useState<QuestionAnalysisJobView[]>([]);
  const [questionDraftViews, setQuestionDraftViews] = useState<Record<string, QuestionDraftView>>({});
  const readerRef = useRef<TranscriptReader | null>(null);
  if (!readerRef.current) readerRef.current = new TranscriptReader(session ? { sessionId: session.id, peer: remotePeer ?? null } : null);
  const reader = readerRef.current;
  const history = useSyncExternalStore(reader.subscribe, reader.getState, reader.getState);
  const messages = history.transcript.messages;
  const entryIds = history.transcript.entryIds;
  const messagesRef = useRef(messages);
  const entryIdsRef = useRef(entryIds);
  messagesRef.current = messages;
  entryIdsRef.current = entryIds;
  const appendMessage = useCallback((message: AgentMessage, entryId = "", delivery: TranscriptDelivery = {}) => {
    reader.append(message, entryId, delivery);
    messagesRef.current = reader.getState().transcript.messages;
    entryIdsRef.current = reader.getState().transcript.entryIds;
  }, [reader]);
  const updateMessages = useCallback((update: (current: TranscriptMessages) => TranscriptMessages) => {
    reader.updateMessages(update);
    messagesRef.current = reader.getState().transcript.messages;
    entryIdsRef.current = reader.getState().transcript.entryIds;
  }, [reader]);
  const cacheKeyForSession = useCallback((sid: string, peer = remotePeerRef.current) => draftKeyIdentity(sessionDraftKey(sid, peer)), []);
  // AppShell keys ChatWindow by conversation; leaf acknowledgements and draft
  // promotion must not replace the store while a reply is in flight.
  const [streamingStore] = useState(createStreamingStore);
  const dispatch = streamingStore.dispatch;
  const [runtimeAvailable, setRuntimeAvailable] = useState(false);
  const runtimeAvailableRef = useRef(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [bashRunning, setBashRunning] = useState(false);
  const [pendingBash, setPendingBash] = useState<{ command: string; excludeFromContext: boolean } | null>(null);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelEntry[]>([]);
  const [modelScopeWarnings, setModelScopeWarnings] = useState<string[]>([]);
  const [modelError, setModelError] = useState<ModelErrorInfo | null>(null);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [modelThinkingLevelPins, setModelThinkingLevelPins] = useState<Record<string, string>>({});
  const [modelThinkingLevelDefaults, setModelThinkingLevelDefaults] = useState<Record<string, string>>({});
  const [newSessionModel, setNewSessionModel] = useState<SelectedModel | null>(null);
  const [newSessionDefaultModel, setNewSessionDefaultModel] = useState<SelectedModel | null>(null);
  const [toolPreset, setToolPreset] = useState<ToolPreset>(CONFIGURED_TOOL_PRESET);
  const [systemTools, setSystemTools] = useState<ToolEntry[] | null>(null);
  const sessionToolsPinnedRef = useRef(false);
  const modelListRequestRevisionRef = useRef(0);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [liveThinkingLevel, setLiveThinkingLevel] = useState<ConcreteThinkingLevel | null>(null);
  const [newSessionThinkingLevel, setNewSessionThinkingLevel] = useState<ConcreteThinkingLevel | null>(null);
  const [newSessionDefaultThinkingLevel, setNewSessionDefaultThinkingLevel] = useState<ConcreteThinkingLevel | null>(null);
  const [activeToolResults, setActiveToolResults] = useState<Map<string, ToolResultMessage>>(new Map());
  const activeToolIdsRef = useRef(new Set<string>());
  const toolEventRevisionRef = useRef(0);
  const [savedDefaultThinkingLevel, setSavedDefaultThinkingLevel] = useState<ConcreteThinkingLevel | null>(null);
  const [currentThinkingOverride, setCurrentThinkingOverride] = useState<ConcreteThinkingLevel | null>(null);
  const [fastModeSelection, setFastModeSelection] = useState<FastModeSelection>("default");
  const [fastModeRuntimeStatus, setFastModeRuntimeStatus] = useState<FastModeStatus | null>(null);
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const [autoCompactionEnabled, setAutoCompactionValue] = useState<boolean | null>(null);
  const [runtimeSettingsRead, setRuntimeSettingsRead] = useState<{ status: "loading" | "ready" | "error"; error?: string }>({ status: "loading" });
  const [settingsRetryRevision, setSettingsRetryRevision] = useState(0);
  const runtimeSettingsReadGenerationRef = useRef(0);
  const setAutoCompactionEnabled = useCallback((value: boolean | null) => {
    runtimeSettingsReadGenerationRef.current += 1;
    setAutoCompactionValue(value);
    setRuntimeSettingsRead({ status: value === null ? "loading" : "ready" });
  }, []);
  useEffect(() => {
    if (!isNew || sessionIdRef.current) return;
    const saved = newSessionDraftKey ? getDraft(newSessionDraftKey)?.autoCompactionEnabled : undefined;
    autoCompactionOverrideRef.current = typeof saved === "boolean" ? saved : null;
    setAutoCompactionEnabled(typeof saved === "boolean" ? saved : null);
    const controller = new AbortController();
    void fetch(apiPath("settings/compaction"), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json() as { enabled?: boolean };
        if (!controller.signal.aborted && !sessionIdRef.current && autoCompactionOverrideRef.current === null) {
          if (typeof body.enabled !== "boolean") throw new Error("Automatic compaction preference is unavailable");
          setAutoCompactionEnabled(body.enabled);
        }
      }).catch((error: unknown) => {
        if (!controller.signal.aborted && !sessionIdRef.current && autoCompactionOverrideRef.current === null) {
          setRuntimeSettingsRead({ status: "error", error: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => controller.abort();
  }, [apiPath, isNew, newSessionDraftKey, remotePeer, settingsRetryRevision, setAutoCompactionEnabled]);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [runtimeInspection, setRuntimeInspection] = useState<RuntimeInspection | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [liveModel, setLiveModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [runtimeSettingsUpdating, setRuntimeSettingsUpdating] = useState(false);
  const autoCompactionOverrideRef = useRef<boolean | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const localCompactionPendingRef = useRef(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const [promptAnchorActive, setPromptAnchorActive] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [follow, setFollowState] = useState(true);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [slashCommandsReloadKey, setSlashCommandsReloadKey] = useState(0);
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const noticeHoverRef = useRef(false);
  const [sessionStatsOverride, setSessionStatsOverride] = useState<{ peer: string | null; stats: SessionStatsInfo } | null>(null);
  const sessionStatsRequestGenerationRef = useRef(0);
  const sessionTimingRequestGenerationRef = useRef(0);
  const [extensionDialogs, setExtensionDialogs] = useState<ExtensionUiDialogRequest[]>([]);
  const [extensionCustomUis, setExtensionCustomUis] = useState<ExtensionUiCustomRequest[]>([]);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionUsages, setExtensionUsages] = useState<ExtensionUsageItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [editorSuggestion, setEditorSuggestion] = useState<string | null>(null);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessages>({ steering: [], followUp: [] });
  const queuedDraftProjectionRef = useRef(new QueuedDraftProjection());
  const queueRecallInFlightRef = useRef(false);
  const [queueRecallState, setQueueRecallState] = useState<NonNullable<QueuedMessages["recallState"]>>("idle");
  const serverCopyOperationRef = useRef<string | null>(null);

  const syncQueuedDrafts = useCallback((sid: string | null, value: unknown, legacy?: AgentStateResponse["queuedMessages"], requestGeneration?: number) => {
    if (!sid) return;
    const projection = queuedDraftProjectionRef.current;
    const key = cacheKeyForSession(sid);
    const snapshot = readQueuedDraftState(value);
    const applied = snapshot ? projection.apply(key, snapshot, requestGeneration) : null;
    const pending = getPendingQueueRecall(key) ?? getQueueRecallOperation(key)?.expected;
    if (pending) setQueuedMessages({ ...normalizeQueuedMessages(pending), recallPending: true });
    else if (applied) setQueuedMessages(normalizeQueuedMessages(applied));
    else if (!projection.snapshot && (requestGeneration === undefined || requestGeneration === projection.generation)) {
      setQueuedMessages(normalizeQueuedMessages(null, legacy));
    }
  }, [cacheKeyForSession]);

  const syncQueuedDraftResponse = useCallback((sid: string, response: {
    ok: boolean;
    running?: boolean;
    state?: AgentStateResponse;
  }, requestGeneration: number, sameRun: boolean) => {
    if (!response.ok) return;
    if (response.running === false) {
      // Missing state and transport errors are not proof that a queue is gone.
      // An absent producer has no revision, so require both request and run ownership.
      if (sameRun && queuedDraftProjectionRef.current.clearAbsent(cacheKeyForSession(sid), requestGeneration)) {
        syncQueuedDrafts(sid, null);
      }
    } else if (response.running === true && response.state
      && (response.state.queueSnapshot !== undefined || response.state.queuedMessages !== undefined)) {
      syncQueuedDrafts(sid, response.state.queueSnapshot, response.state.queuedMessages, requestGeneration);
    }
  }, [cacheKeyForSession, syncQueuedDrafts]);

  const eventConnectionRef = useRef<AgentEventConnection | null>(null);
  const eventStreamGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventStreamGraceGenerationRef = useRef(0);
  const eventStreamGraceActiveRef = useRef(false);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const sessionPropIdRef = useRef<string | null>(session?.id ?? null);
  const foregroundSessionRef = useRef(!opts.background);
  const sessionRunningRef = useRef(Boolean(sessionRunning));
  const sessionRunningSignalRef = useRef(Boolean(sessionRunning));
  const agentRunningRef = useRef(false);
  const sdkAgentActiveRef = useRef(false);
  // Local submission owns settlement until its POST is accepted or fails.
  const rpcPromptPendingRef = useRef<boolean | { runId: number; requestStarted: boolean; stopping: boolean; cancel?: () => void }>(false);
  const promptDeliveriesRef = useRef(new Map<string, PromptDelivery>());
  const [unconfirmedPrompts, setUnconfirmedPrompts] = useState<PromptDelivery[]>([]);
  const promptCompletionDeduperRef = useRef(createPromptCompletionDeduper());
  const currentAgentRunIdRef = useRef<string | null>(null);
  const bashRunningRef = useRef(false);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const syncUnattendedStateRef = useRef<((state: SchedulerState | null) => void) | null>(null);
  const syncUnattendedEnabledRef = useRef<((enabled: boolean) => void) | null>(null);
  const pendingUnattendedRef = useRef<boolean | null>(null);
  const unattendedOverrideRef = useRef<boolean | null>(null);
  const unattendedWriteRef = useRef<Promise<void> | null>(null);
  const lastAgentErrorRef = useRef(false);
  const lastAgentAbortedRef = useRef(false);
  const sessionOpenScrollRef = useRef<SessionOpenScroll>(loadSessionOpenScroll());
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollToUserRef = useRef(false);
  const executeBashRef = useRef<(command: string, excludeFromContext: boolean) => Promise<void> | undefined>(undefined);
  const handleNavigateRef = useRef<((entryId: string | null) => Promise<boolean>) | undefined>(undefined);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<TranscriptViewport | null>(null);
  if (!viewportRef.current) viewportRef.current = new TranscriptViewport(() => scrollContainerRef.current, setFollowState);
  const viewport = viewportRef.current;
  const setFollow = useCallback((value: boolean) => viewport.setFollow(value), [viewport]);
  const ensuringNewSessionRef = useRef<Promise<string | null> | null>(null);
  // The command list as last loaded, and the get_commands request under way, if
  // any. A bare /mcp reads them to tell whose /mcp it is (handleBuiltinSlashCommand).
  // The generation moves on with every request and every clear, and only a request
  // still current writes its answer: one that set_tools outdated (or a newer request)
  // would otherwise put back the list of a session that is no longer there.
  const slashCommandsRef = useRef<SlashCommandInfo[]>([]);
  const slashCommandsLoadRef = useRef<Promise<SlashCommandInfo[] | null> | null>(null);
  const slashCommandsGenerationRef = useRef(0);
  const newSessionPromotedRef = useRef(false);
  // Invalidates late promotion callbacks when this draft hook is unmounted or
  // replaced by another new-session draft.
  const newSessionLifecycleGenerationRef = useRef(0);
  const newSessionModelOverrideRef = useRef<SelectedModel | null>(null);
  const thinkingLevelOverrideRef = useRef<Exclude<ThinkingLevelOption, "auto"> | null>(null);
  const fastModeOverrideRef = useRef<FastModeSelection | null>(null);
  const fastModeAppliedRef = useRef<FastModeSelection | null>(null);
  const promptRunIdRef = useRef(0);
  /** Exact native peer message ids seen in this live event stream. */
  const pendingPeerMessageIdsRef = useRef(new Set<string>());
  const modelSwitchPendingRef = useRef(false);
  const runtimeSettingsRevisionRef = useRef(0);
  useEffect(() => {
    runtimeSettingsRevisionRef.current += 1;
    modelSwitchPendingRef.current = false;
    pendingPeerMessageIdsRef.current.clear();
    setRuntimeSettingsUpdating(false);
    setModelSwitching(false);
  }, [session?.id, remotePeer, newSessionDraftKey]);
  const draftKeyAliasesRef = useRef(new Map<string, DraftKey>());
  const sessionHookMountedRef = useRef(true);
  useLayoutEffect(() => {
    sessionHookMountedRef.current = true;
    return () => { sessionHookMountedRef.current = false; };
  }, []);
  // Multiple agent_end/agent_settled/prompt_done events can reload one session
  // concurrently. Only newest response may write transcript state.
  const sessionLoadGenerationRef = useRef(0);
  const blockingLoadOwnerRef = useRef<{
    generation: number;
    sessionId: string;
    peer: string | null;
    scope: string;
  } | null>(null);
  // Keep the current primary history read registered until its own finally so
  // connected can replace either a cold blocking load or cache validation.
  const pendingSessionLoadRef = useRef<SessionLoadRegistration | null>(null);
  // A cache-first mount is readable but not yet write-authorized. Runtime state
  // can confirm the agent independently; an accepted context/session GET clears it.
  const sessionViewValidationPendingRef = useRef(Boolean(session));
  useEffect(() => {
    sessionViewValidationPendingRef.current = Boolean(session);
  }, [remotePeer, session?.id]);
  // Reject a stale positive get_state response that races an agent_end
  // observed while the initial history/state load was in flight.
  const sessionSettlementGenerationRef = useRef(0);
  const stateLoadGenerationRef = useRef(0);
  const stateLoadInFlightRef = useRef<{
    sessionId: string; peer: string | undefined; scope: string; runRevision: number; generation: number;
    promise: Promise<{ running: boolean; state?: AgentStateResponse } | null> | null;
  } | null>(null);
  const stateRunRevisionRef = useRef(0);
  // History reads must also expire when an accepted SSE event mutates the
  // transcript without starting or settling a run.
  const transcriptMutationRevisionRef = useRef(0);
  const sessionStatePendingRef = useRef(Boolean(session));
  const [sessionStatePending, setSessionStatePending] = useState(Boolean(session));
  const currentSessionId = session?.id ?? null;
  if (sessionPropIdRef.current !== currentSessionId) {
    sessionPropIdRef.current = currentSessionId;
    sessionRunningRef.current = Boolean(sessionRunning);
  } else if (sessionRunning && !sessionRunningSignalRef.current) {
    sessionRunningRef.current = true;
  } else if (!sessionRunning && sessionRunningSignalRef.current) {
    // The sidebar's complete snapshot is also the terminal edge for a selected
    // session; do not leave a stale activity hint keeping ChatWindow busy.
    sessionRunningRef.current = false;
  }
  sessionRunningSignalRef.current = Boolean(sessionRunning);
  foregroundSessionRef.current = !opts.background;

  if (!eventConnectionRef.current) {
    eventConnectionRef.current = new AgentEventConnection({
      createSource: (sid) => {
        const path = apiPath(`agent/${encodeURIComponent(sid)}/events`);
        const holder = opts.background ? "background" : "foreground";
        return new EventSource(`${path}${path.includes("?") ? "&" : "?"}holder=${holder}`);
      },
      onEvent: (event) => handleAgentEventRef.current?.(event as AgentEvent),
      shouldMaintain: (sid) => (
        sessionHookMountedRef.current
        && sessionIdRef.current === sid
        && (
          agentRunningRef.current
          || bashRunningRef.current
          || eventStreamGraceActiveRef.current
          || (sessionPropIdRef.current === sid && foregroundSessionRef.current)
        )
      ),
      readinessTimeoutMs: EVENT_STREAM_READY_TIMEOUT_MS,
      reconnectDelayMs: EVENT_STREAM_RECONNECT_DELAY_MS,
      silenceTimeoutMs: EVENT_STREAM_SILENCE_TIMEOUT_MS,
      onUnexpectedError: (error) => {
        console.error("Failed to maintain the agent event stream:", error);
      },
    });
  }

  const setToolPresetState = opts.setToolPreset ?? setToolPreset;

  useLayoutEffect(() => {
    if (!isNew || sessionIdRef.current) return;
    setToolPresetState(getPreferredToolPreset());
  }, [isNew, setToolPresetState]);

  const scrollToMessage = useCallback((element: HTMLElement, viewportOffset = 16) => {
    pendingScrollToUserRef.current = false;
    setPromptAnchorActive(false);
    viewport.scrollToEntry(element, viewportOffset);
  }, [viewport]);
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto", options?: { follow?: boolean }) => {
    viewport.scrollToBottom(behavior, options?.follow ?? true);
  }, [viewport]);
  const currentModel = currentModelOverride ?? liveModel ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew
    ? (newSessionModel ?? newSessionDefaultModel)
    : currentModel ?? (data?.context.messages.length === 0 ? newSessionDefaultModel : null);
  const selectedModelInfo = displayModel
    ? modelList.find((entry) => entry.provider === displayModel.provider && entry.id === displayModel.modelId)
    : undefined;
  const fallbackFastMode = fastModeStatus(fastModeSelection, selectedModelInfo
    ? {
        id: selectedModelInfo.id,
        api: selectedModelInfo.fastModeSupported ? "openai-responses" : undefined,
        samplingParams: selectedModelInfo.fastModeDefault ? { service_tier: "priority" } : undefined,
      }
    : undefined);
  const fastMode = fastModeRuntimeStatus ?? fallbackFastMode;
  const contextThinkingLevel = asConcreteThinkingLevel(
    data?.context.thinkingLevel && data.context.thinkingLevel !== "off"
      ? data.context.thinkingLevel
      : null,
  );
  const currentThinkingLevel = currentThinkingOverride ?? liveThinkingLevel ?? contextThinkingLevel;
  const displayThinkingLevel = isNew
    ? (newSessionThinkingLevel ?? newSessionDefaultThinkingLevel)
    : currentThinkingLevel ?? (data?.context.messages.length === 0 ? newSessionDefaultThinkingLevel : null);
  const syncLiveModel = useCallback((state?: AgentStateResponse) => {
    setLiveModel(state?.model
      ? { provider: state.model.provider, modelId: state.model.id }
      : null);
    if (state?.thinkingLevel !== undefined) {
      setLiveThinkingLevel(asConcreteThinkingLevel(state.thinkingLevel));
    }
  }, []);

  const composerDraftKey = useMemo(
    () => session?.id ? sessionDraftKey(session.id, remotePeer) : newSessionDraftKey ?? undefined,
    [session?.id, remotePeer, newSessionDraftKey],
  );

  const resolveComposerDraftKey = useCallback((key: DraftKey | undefined) => {
    if (!key) return undefined;
    let resolved: DraftKey = key;
    const visited = new Set<string>();
    while (typeof resolved === "string" && !visited.has(resolved)) {
      visited.add(resolved);
      const next = draftKeyAliasesRef.current.get(resolved);
      if (!next) break;
      resolved = next;
    }
    return resolved;
  }, []);

  const restoreSubmission = useCallback((
    text: string,
    images: AttachedImage[] | undefined,
    targetDraftKey: DraftKey | undefined,
  ) => {
    const draftImages = images?.map(({ data, mimeType }) => ({ data, mimeType }));
    const destinationDraftKey = resolveComposerDraftKey(targetDraftKey);
    const input = opts.chatInputRef?.current;
    if (input && sessionHookMountedRef.current) {
      input.restoreSubmission(text, draftImages, destinationDraftKey);
    } else if (destinationDraftKey) {
      restoreDraftSubmission(destinationDraftKey, text, draftImages);
    }
  }, [opts.chatInputRef, resolveComposerDraftKey]);

  // Timing is scoped to the viewed leaf, including when runtime navigation differs from disk.
  const refreshSessionTiming = useCallback(async (sid: string | null) => {
    const requestGeneration = ++sessionTimingRequestGenerationRef.current;
    if (!sid) return;
    const peer = remotePeerRef.current;
    const scope = branchScopeRef.current;
    const loadGeneration = sessionLoadGenerationRef.current;
    const branch = branchRef.current?.state;
    if (!branch?.ready || (branch.phase !== "current" && branch.phase !== "preview")) return;
    const params = new URLSearchParams({ metadataOnly: "1", leafId: branch.viewedLeafId ?? "" });
    try {
      const res = await fetch(apiPath(`sessions/${encodeURIComponent(sid)}?${params}`), { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return;
      const refreshed = await res.json() as SessionData;
      const isCurrent = () => {
        const current = branchRef.current?.state;
        return sessionHookMountedRef.current && sessionIdRef.current === sid && remotePeerRef.current === peer
          && branchScopeRef.current === scope && sessionLoadGenerationRef.current === loadGeneration
          && sessionTimingRequestGenerationRef.current === requestGeneration && current?.ready
          && current.phase === branch.phase && current.viewedLeafId === branch.viewedLeafId;
      };
      if (!refreshed.timing || refreshed.sessionId !== sid || refreshed.leafId !== branch.viewedLeafId || !isCurrent()) return;
      setData((previous) => {
        if (!isCurrent()) return previous;
        if (previous) return previous.sessionId === sid ? { ...previous, timing: refreshed.timing } : previous;
        return typeof refreshed.filePath === "string" && Array.isArray(refreshed.tree)
          && Array.isArray(refreshed.context?.messages) && Array.isArray(refreshed.context?.entryIds)
          ? refreshed : previous;
      });
    } catch {
      // Keep the rendered timing when the refresh is unavailable.
    }
  }, [apiPath]);

  const refreshSessionStats = useCallback(async (sid: string | null = sessionIdRef.current) => {
    if (!sid) return;
    const peer = remotePeerRef.current;
    const requestGeneration = ++sessionStatsRequestGenerationRef.current;
    try {
      const stats = await sendAgentCommandR<SessionStatsInfo>(sid, { type: "get_session_stats" });
      if (
        stats?.sessionId === sid
        && sessionIdRef.current === sid
        && remotePeerRef.current === peer
        && requestGeneration === sessionStatsRequestGenerationRef.current
      ) {
        setSessionStatsOverride({ peer: peer ?? null, stats });
      }
    } catch {
      // Preserve the latest rendered stats if the optional full-session refresh is unavailable.
    }
  }, [sendAgentCommandR]);

  // A transcript page carries only its own turns' timing; once the view is ready, the
  // metadata refresh replaces it with the viewed branch's full list.
  const timingBranch = branchRef.current?.state;
  const windowedTimingSessionId = data?.timing?.turnsScope === "window" ? data.sessionId : null;
  useEffect(() => {
    if (!windowedTimingSessionId || !timingBranch?.ready || (timingBranch.phase !== "current" && timingBranch.phase !== "preview")) return;
    void refreshSessionTiming(windowedTimingSessionId);
  }, [windowedTimingSessionId, timingBranch?.ready, timingBranch?.phase, timingBranch?.viewedLeafId, refreshSessionTiming]);

  const invalidateSessionDetailsForSession = useCallback((sid: string) => {
    const request = {
      sessionId: sid,
      version: sid === session?.id ? sessionDetailsVersion : "",
      modelConfigRevision: modelsRefreshKey,
      peer: remotePeerRef.current,
    };
    invalidateSessionDetails(request);
    if ((modelsRefreshKey ?? 0) > 0) {
      invalidateSessionDetails({ ...request, modelConfigRevision: undefined });
    }
  }, [modelsRefreshKey, session?.id, sessionDetailsVersion]);

  const refreshSessionCost = useCallback(async (sid: string | null) => {
    if (!sid) return;
    invalidateSessionDetailsForSession(sid);
    const request = {
      sessionId: sid,
      version: sid === session?.id ? sessionDetailsVersion : "",
      modelConfigRevision: modelsRefreshKey,
      peer: remotePeerRef.current,
    };
    await ensureSessionCost(request);
    await refreshSessionStats(sid);
  }, [ensureSessionCost, invalidateSessionDetailsForSession, modelsRefreshKey, refreshSessionStats, session?.id, sessionDetailsVersion]);

  useEffect(() => {
    if (!sessionStatsRefreshRef) return;
    const refresh = () => {
      void refreshSessionTiming(sessionIdRef.current);
      return refreshSessionCost(sessionIdRef.current);
    };
    sessionStatsRefreshRef.current = refresh;
    return () => {
      if (sessionStatsRefreshRef.current === refresh) sessionStatsRefreshRef.current = null;
      sessionStatsRequestGenerationRef.current += 1;
    };
  }, [refreshSessionCost, refreshSessionTiming, sessionStatsRefreshRef]);

  useEffect(() => {
    const sid = session?.id;
    const pending = imageGenerationCosts.filter((row) => row.billing.status === "pending");
    if (!sid || pending.length === 0) return;
    const deadline = Math.max(...pending.map((row) => row.billing.startedAt)) + 15 * 60_000;
    if (Date.now() >= deadline) return;
    let inFlight = false;
    const timer = window.setInterval(() => {
      if (Date.now() >= deadline) { window.clearInterval(timer); return; }
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      void refreshSessionCost(sid).catch(() => undefined).finally(() => { inFlight = false; });
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [imageGenerationCosts, refreshSessionCost, session?.id]);

  const clearLoadedSessionView = useCallback((sid: string) => {
    setData(null);
    setActiveLeafId(null);
    setQuestionAnalysisJobs([]);
    setQuestionDraftViews({});
    setFastModeSelection("default");
    setFastModeRuntimeStatus(null);
    setError(null);
    reader.setScope(null);
  }, [reader]);

  // History editing is a draft operation until the server admits its prompt.
  // Persist the target identity so a reload cannot turn an unconfirmed edit into
  // an ordinary prompt on the current branch.
  const [editEntryId, setEditEntryId] = useState(() => {
    const sid = session?.id;
    const key = sid ? cacheKeyForSession(sid) : null;
    const draft = sid ? getDraft(historyDraftKey(sid, remotePeer)) : null;
    if (!key || !draft) {
      if (key) pendingHistoryEdits.delete(key);
      return null;
    }
    const stored = pendingHistoryEdits.get(key) ?? (draft.historyEdit
      ? { ...draft.historyEdit, targetLeafId: draft.historyEdit.entryId }
      : null);
    if (stored) pendingHistoryEdits.set(key, stored);
    return stored?.entryId ?? null;
  });
  const setEdit = useCallback((entryId: string | null, targetLeafId: string | null = entryId, clientMessageId?: string) => {
    if (!session?.id) return;
    const key = cacheKeyForSession(session.id);
    const draftKey = historyDraftKey(session.id, remotePeer);
    const existing = getDraft(draftKey) ?? { value: "", images: [] };
    if (entryId) {
      const historyEdit = { entryId, ...(clientMessageId ? { clientMessageId } : {}) };
      pendingHistoryEdits.set(key, { ...historyEdit, targetLeafId });
      setDraft(draftKey, { ...existing, historyEdit });
    } else {
      pendingHistoryEdits.delete(key);
      setDraft(draftKey, { ...existing, historyEdit: null });
    }
    setEditEntryId(entryId);
  }, [cacheKeyForSession, remotePeer, session?.id]);
  const restoreLegacyHistoryEdit = useCallback((historyEdit: HistoryEditDraft | null) => {
    setEdit(historyEdit?.entryId ?? null, historyEdit?.entryId ?? null, historyEdit?.clientMessageId);
  }, [setEdit]);
  const handleEditContent = useCallback((message: UserMessage, entryId: string, _resetToRoot = false) => {
    if (!session?.id || !sessionHookMountedRef.current || sessionIdRef.current !== session.id
      || branchScope !== branchScopeRef.current) return false;
    if (!opts.chatInputRef?.current?.replaceMessage(message)) return false;
    setEdit(entryId, entryId);
    return true;
  }, [branchScope, opts.chatInputRef, session?.id, setEdit]);
  const cancelEdit = useCallback(() => {
    if (!session?.id) return;
    const key = cacheKeyForSession(session.id);
    if (!pendingHistoryEdits.has(key) && !getDraft(historyDraftKey(session.id, remotePeer))?.historyEdit) {
      setEdit(null);
      return;
    }
    // Cancel the active banner, but keep the target identity with the draft so
    // the preserved submission can only retry the same historical edit.
    setEditEntryId(null);
  }, [cacheKeyForSession, remotePeer, session?.id, setEdit]);
  const setEditRef = useRef(setEdit);
  setEditRef.current = setEdit;

  const sessionStats = useMemo(() => {
    const currentSessionId = sessionIdRef.current ?? session?.id ?? "";
    const scopedOverride = sessionStatsOverride?.stats.sessionId === currentSessionId
      && sessionStatsOverride.peer === (remotePeerRef.current ?? null)
      ? sessionStatsOverride.stats
      : null;
    const persistedStats = data?.stats?.sessionId === currentSessionId ? data.stats : null;
    const effectiveContextUsage = contextUsage ?? data?.contextUsage ?? null;
    const baseStats = persistedStats || scopedOverride
      ? { ...(persistedStats ?? {}), ...(scopedOverride ?? {}) } as SessionStatsInfo
      : null;
    if (baseStats) {
      const tokens = sessionUsageTotals
        ? {
            input: sessionUsageTotals.inputTokens,
            output: sessionUsageTotals.outputTokens,
            cacheRead: sessionUsageTotals.cachedInputTokens,
            cacheWrite: sessionUsageTotals.cacheWriteTokens,
            total: sessionUsageTotals.totalTokens,
          }
        : baseStats.tokens;
      return {
        ...baseStats,
        sessionId: currentSessionId,
        extensionUsages,
        tokens,
        sessionFile: data?.filePath ?? baseStats.sessionFile,
        sessionName: session?.name ?? baseStats.sessionName,
        timing: data?.timing,
        cost: sessionCost ?? 0,
        ...sessionCostMetadata,
        statsSource: sessionUsageTotals ? "reader-cost" : baseStats.statsSource,
        contextUsage: effectiveContextUsage ?? undefined,
      } satisfies SessionStatsInfo;
    }
    // Whole-session cumulative tokens come from the genai-prices calculator.
    // When it is unavailable, keep cost at zero and expose costState instead
    // of reading producer-side usage.cost values.
    const tokens = sessionUsageTotals
      ? {
          input: sessionUsageTotals.inputTokens,
          output: sessionUsageTotals.outputTokens,
          cacheRead: sessionUsageTotals.cachedInputTokens,
          cacheWrite: sessionUsageTotals.cacheWriteTokens,
          total: sessionUsageTotals.totalTokens,
        }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let userMessages = 0;
    let assistantMessages = 0;
    let toolResults = 0;
    let toolCalls = 0;
    for (const msg of messages) {
      if (msg.role === "user") userMessages += 1;
      if (msg.role === "toolResult") toolResults += 1;
      if (msg.role !== "assistant") continue;
      assistantMessages += 1;
      const u = (msg as import("@/lib/types").AssistantMessage).usage;
      toolCalls += (msg as import("@/lib/types").AssistantMessage).content.filter((c) => c.type === "toolCall").length;
      if (!u || sessionUsageTotals) continue;
      tokens.input += u.input ?? 0;
      tokens.output += u.output ?? 0;
      tokens.cacheRead += u.cacheRead ?? 0;
      tokens.cacheWrite += u.cacheWrite ?? 0;
    }
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    if (tokens.total === 0 && messages.length === 0) return null;
    return {
      sessionFile: data?.filePath || undefined,
      sessionId: currentSessionId,
      sessionName: session?.name,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: messages.length,
      tokens,
      cost: sessionCost ?? 0,
      ...sessionCostMetadata,
      extensionUsages,
      timing: data?.timing,
      ...(effectiveContextUsage ? { contextUsage: effectiveContextUsage } : {}),
    } satisfies SessionStatsInfo;
  }, [messages, sessionStatsOverride, sessionCost, sessionUsageTotals, sessionCostMetadata, extensionUsages, contextUsage, data?.contextUsage, data?.filePath, data?.stats, data?.timing, session?.id, session?.name]);

  const loadAgentState = useCallback((sid: string): Promise<{ running: boolean; state?: AgentStateResponse } | null> => {
    const queueGeneration = queuedDraftProjectionRef.current.generation;
    const queueRunId = currentAgentRunIdRef.current;
    const queuePromptId = promptRunIdRef.current;
    const runRevision = stateRunRevisionRef.current;
    const ownerScope = branchScopeRef.current;
    const ownerPeer = remotePeerRef.current;
    const pending = stateLoadInFlightRef.current;
    if (pending?.promise && pending.sessionId === sid && pending.peer === ownerPeer
      && pending.scope === ownerScope && pending.runRevision === runRevision
      && pending.generation === stateLoadGenerationRef.current) return pending.promise;
    const generation = ++stateLoadGenerationRef.current;
    const settingsGeneration = ++runtimeSettingsReadGenerationRef.current;
    const flight: NonNullable<typeof stateLoadInFlightRef.current> = {
      sessionId: sid, peer: ownerPeer, scope: ownerScope, runRevision, generation, promise: null,
    };
    stateLoadInFlightRef.current = flight;
    const ownsQueue = () => sessionHookMountedRef.current && sessionIdRef.current === sid
      && branchScopeRef.current === ownerScope && remotePeerRef.current === ownerPeer;
    const isCurrent = () => ownsQueue() && generation === stateLoadGenerationRef.current;
    const request = (async () => {
      setRuntimeSettingsRead({ status: "loading" });
      try {
        const readState = async () => {
          const response = await fetch(apiPath(`sessions/${encodeURIComponent(sid)}/state`), { cache: "no-store", signal: AbortSignal.timeout(15_000) });
          return { response, value: await response.json() as { running: boolean; state?: AgentStateResponse; code?: string } };
        };
        let toolRevision = toolEventRevisionRef.current;
        let { response: stateRes, value: agentState } = await readState();
        if (!ownsQueue()) return null;
        if (toolRevision !== toolEventRevisionRef.current && isCurrent() && stateRunRevisionRef.current === runRevision) {
          toolRevision = toolEventRevisionRef.current;
          ({ response: stateRes, value: agentState } = await readState());
          if (!ownsQueue()) return null;
        }
        // Queue revisions outlive a run's terminal UI transition. Reconcile them
        // before the stricter guard for model, settings, and running state.
        syncQueuedDraftResponse(sid, { ...agentState, ok: stateRes.ok }, queueGeneration,
          currentAgentRunIdRef.current === queueRunId && promptRunIdRef.current === queuePromptId);
        if (!isCurrent() || stateRunRevisionRef.current !== runRevision) return null;
        const unavailablePreference = agentState.running === false && agentState.code === "session_state_unavailable";
        if (!stateRes.ok && !unavailablePreference) throw new Error(`HTTP ${stateRes.status}`);
        if (typeof agentState.running !== "boolean" || (agentState.running && !agentState.state)) throw new Error("Session runtime state is unavailable");
        if (toolRevision !== toolEventRevisionRef.current) throw new Error("Session state changed while reading tool activity");
        const promptRunning = agentState.running && (agentState.state?.isStreaming || agentState.state?.isPromptRunning);
        if (!promptRunning && activeToolIdsRef.current.size > 0) {
          activeToolIdsRef.current.clear();
          setActiveToolResults(new Map());
        }
        runtimeAvailableRef.current = agentState.running;
        setRuntimeAvailable(agentState.running);
        const liveState = agentState.state;
        if (settingsGeneration === runtimeSettingsReadGenerationRef.current) {
          if (typeof liveState?.autoCompactionEnabled === "boolean") setAutoCompactionEnabled(liveState.autoCompactionEnabled);
          else setRuntimeSettingsRead({ status: "error", error: "Automatic compaction preference is unavailable" });
        }
        if (agentState.running && liveState?.branchPosition) {
          if (liveState.branchPosition.pending) branchRef.current?.markUnconfirmed(new Error("Branch navigation is pending"));
          else {
            branchRef.current?.observeRuntime(liveState.branchPosition.leafId);
            if (branchRef.current && canWriteBranch(branchRef.current.state)) sessionViewValidationPendingRef.current = false;
          }
        }
        if (agentState.running && liveState) {
          syncLiveModel(liveState);
          if (liveState.contextUsage !== undefined) setContextUsage(liveState.contextUsage ?? null);
          if (liveState.systemPrompt !== undefined) setSystemPrompt(liveState.systemPrompt ?? null);
          if (liveState.runtimeInspection !== undefined) setRuntimeInspection(liveState.runtimeInspection ?? null);
          if (liveState.thinkingLevel !== undefined) setThinkingLevel((liveState.thinkingLevel as ThinkingLevelOption) ?? "auto");
          if (liveState.fastMode !== undefined) {
            setFastModeSelection(liveState.fastMode.mode);
            setFastModeRuntimeStatus(liveState.fastMode);
          }
          if (liveState.extensionStatuses !== undefined) setExtensionStatuses(liveState.extensionStatuses ?? []);
          if (liveState.extensionUsages !== undefined) setExtensionUsages(liveState.extensionUsages ?? []);
          if (liveState.extensionWidgets !== undefined) setExtensionWidgets(liveState.extensionWidgets ?? []);
          if (liveState.editorSuggestion !== undefined) setEditorSuggestion(liveState.editorSuggestion ?? null);
        }
        sessionStatePendingRef.current = false;
        setSessionStatePending(false);
        return agentState;
      } catch (e) {
        if (isCurrent() && stateRunRevisionRef.current === runRevision) {
          if (settingsGeneration === runtimeSettingsReadGenerationRef.current) {
            setRuntimeSettingsRead({ status: "error", error: e instanceof Error ? e.message : String(e) });
          }
          console.error("Failed to load agent state:", e);
        }
        return null;
      } finally {
        if (stateLoadInFlightRef.current === flight) stateLoadInFlightRef.current = null;
      }
    })();
    flight.promise = request;
    return request;
  }, [apiPath, setAutoCompactionEnabled, syncLiveModel, syncQueuedDraftResponse]);

  const loadSession = useCallback(async (
    sid: string,
    showLoading = false,
    targetLeafId?: string | null,
    runGuard?: SessionLoadRunGuard,
  ) => {
    const loadGeneration = ++sessionLoadGenerationRef.current;
    const loadScope = branchScopeRef.current;
    const loadPeer = remotePeerRef.current;
    const loadRunRevision = stateRunRevisionRef.current;
    const loadRunId = currentAgentRunIdRef.current;
    const loadTranscriptMutationRevision = transcriptMutationRevisionRef.current;
    const loadRegistration: SessionLoadRegistration = {
      generation: loadGeneration,
      sessionId: sid,
      peer: loadPeer ?? null,
      scope: loadScope,
      showLoading,
      ...(targetLeafId !== undefined ? { targetLeafId } : {}),
    };
    pendingSessionLoadRef.current = loadRegistration;
    const loadingOwner = showLoading
      ? { generation: loadGeneration, sessionId: sid, peer: loadPeer ?? null, scope: loadScope }
      : null;
    if (loadingOwner) blockingLoadOwnerRef.current = loadingOwner;
    setSessionStatsOverride((current) => current?.stats.sessionId === sid && current.peer === (loadPeer ?? null) ? current : null);
    const isCurrentLoad = () => (
      sessionHookMountedRef.current
      && sessionIdRef.current === sid
      && remotePeerRef.current === loadPeer
      && branchScopeRef.current === loadScope
      && loadGeneration === sessionLoadGenerationRef.current
      && stateRunRevisionRef.current === loadRunRevision
      && currentAgentRunIdRef.current === loadRunId
      && transcriptMutationRevisionRef.current === loadTranscriptMutationRevision
      && (!runGuard
        || (
          stateRunRevisionRef.current === runGuard.stateRunRevision
          && (runGuard.serverRunId === undefined || currentAgentRunIdRef.current === runGuard.serverRunId)
        ))
    );
    const isCurrentLoadingOwner = () => (
      loadingOwner !== null
      && blockingLoadOwnerRef.current === loadingOwner
      && sessionHookMountedRef.current
      && sessionIdRef.current === sid
      && remotePeerRef.current === loadPeer
      && branchScopeRef.current === loadScope
    );
    const finishLoading = () => {
      if (!isCurrentLoadingOwner()) return;
      blockingLoadOwnerRef.current = null;
      setLoading(false);
    };
    let metadataLoaded = false;
    try {
      if (showLoading) setLoading(true);
      const params = new URLSearchParams({ metadataOnly: "1" });
      if (targetLeafId !== undefined && targetLeafId !== null) params.set("leafId", targetLeafId);
      const res = await fetch(apiPath(`sessions/${encodeURIComponent(sid)}?${params}`), { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (res.status === 404) {
        if (!isCurrentLoad()) return null;
        clearLoadedSessionView(sid);
        setSystemPrompt(null);
        setRuntimeInspection(null);
        branchRef.current?.markUnconfirmed(new Error("Session is unavailable"));
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as SessionData;
      if (!isCurrentLoad()) return null;
      branchRef.current?.observeRuntime(d.leafId);
      const branchPhase = branchRef.current?.state.phase;
      if (branchPhase === "loading" || branchPhase === "switching") return null;
      // Metadata follows the runtime; the visible branch remains the user's
      // preview, including null when previewing the root.
      const selectedLeafId = branchPhase === "preview"
        ? branchRef.current!.state.viewedLeafId
        : d.leafId;
      if (branchPhase === "current") sessionViewValidationPendingRef.current = false;
      setData((previous) => ({
        ...d,
        context: {
          ...d.context,
          messages: [],
          entryIds: [],
        },
      }));
      setFastModeSelection(d.fastMode ?? "default");
      setFastModeRuntimeStatus(null);
      setQuestionAnalysisJobs(d.questionAnalysisJobs ?? []);
      setQuestionDraftViews(d.questionDraftViews ?? {});
      sessionToolsPinnedRef.current = d.toolNames !== undefined;
      setToolPresetState(d.toolNames !== undefined ? getPresetFromToolNames(d.toolNames) : CONFIGURED_TOOL_PRESET);
      setActiveLeafId(selectedLeafId);
      setError(null);
      if (d.context.thinkingLevel && d.context.thinkingLevel !== "off") setThinkingLevel(d.context.thinkingLevel as ThinkingLevelOption);
      metadataLoaded = true;
      finishLoading();

      return d;
    } catch (e) {
      if (isCurrentLoad()) setError(String(e));
      return null;
    } finally {
      if (pendingSessionLoadRef.current === loadRegistration) pendingSessionLoadRef.current = null;
      if (!metadataLoaded) finishLoading();
    }
  }, [apiPath, clearLoadedSessionView, reader, setToolPresetState]);

  const loadContext = useCallback(async (sid: string, leafId: string | null, isCurrent: () => boolean = () => true): Promise<boolean> => {
    const loadGeneration = ++sessionLoadGenerationRef.current;
    const scope = branchScopeRef.current;
    const params = new URLSearchParams({ metadataOnly: "1", leafId: leafId ?? "" });
    const url = apiPath(`sessions/${encodeURIComponent(sid)}?${params}`);
    try {
      const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (res.status === 404) {
        if (isCurrent() && sessionHookMountedRef.current && scope === branchScopeRef.current && sessionIdRef.current === sid && loadGeneration === sessionLoadGenerationRef.current) {
          clearLoadedSessionView(sid);
          branchRef.current?.markUnconfirmed(new Error("Session is unavailable"));
        }
        return false;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as SessionData;
      if (!isCurrent() || !sessionHookMountedRef.current || scope !== branchScopeRef.current || sessionIdRef.current !== sid || loadGeneration !== sessionLoadGenerationRef.current) return false;
      reader.setScope({ sessionId: sid, peer: remotePeerRef.current ?? null, leafId });
      const history = await reader.reset();
      if (!history || history.leafId !== leafId || !isCurrent() || !sessionHookMountedRef.current
        || scope !== branchScopeRef.current || sessionIdRef.current !== sid || loadGeneration !== sessionLoadGenerationRef.current) return false;
      sessionViewValidationPendingRef.current = false;
      setQuestionAnalysisJobs(d.questionAnalysisJobs ?? []);
      setQuestionDraftViews(d.questionDraftViews ?? {});
      setData((previous) => previous && previous.sessionId === sid
        ? { ...previous, ...d, leafId, context: { ...d.context, messages: [], entryIds: [] } }
        : d);
      setActiveLeafId(leafId);
      setError(null);
      dispatch({ type: "end" });
      return true;
    } catch (e) {
      if (sessionIdRef.current === sid && loadGeneration === sessionLoadGenerationRef.current) console.error("Failed to load session metadata:", e);
      return false;
    }
  }, [apiPath, clearLoadedSessionView, dispatch, reader]);

  const recoverBranchPosition = useCallback(async (sid: string): Promise<boolean> => {
    return branchRef.current!.recover(
      async () => {
        const state = await sendAgentCommandR<AgentStateResponse>(sid, { type: "get_state" });
        const position = state?.branchPosition;
        if (!position) throw new Error("Branch position is unavailable");
        return position;
      },
      (leafId, isCurrent) => loadContext(sid, leafId, isCurrent),
    );
  }, [loadContext, sendAgentCommandR]);

  const loadTools = useCallback(async (sid: string) => {
    const scope = branchScopeRef.current;
    const peer = remotePeerRef.current;
    const isCurrent = () => sessionHookMountedRef.current && sessionIdRef.current === sid
      && branchScopeRef.current === scope && remotePeerRef.current === peer;
    setSystemTools(null);
    try {
      const tools = await sendAgentCommandR<ToolEntry[]>(sid, { type: "get_tools" });
      if (!tools || !isCurrent()) return null;
      const { getPresetFromTools } = await import("@/lib/tool-presets");
      if (!isCurrent()) return null;
      setToolPresetState(sessionToolsPinnedRef.current ? getPresetFromTools(tools) : CONFIGURED_TOOL_PRESET);
      setSystemTools(tools);
      onSystemToolsChange?.(tools);
      return tools;
    } catch (e) {
      if (isCurrent()) {
        setSystemTools(null);
        console.error("Failed to load tools:", e);
      }
      return null;
    }
  }, [onSystemToolsChange, sendAgentCommandR, setToolPresetState]);

  const promoteNewSession = useCallback(async (messageCount = 0, firstMessage = "(no messages)") => {
    const promotionGeneration = newSessionLifecycleGenerationRef.current;
    const sid = sessionIdRef.current;
    if (!sessionHookMountedRef.current || !isNew || !newSessionCwd || !sid || newSessionPromotedRef.current) return;
    newSessionPromotedRef.current = true;
    const provisionalDraftKey = newSessionDraftKey;
    if (!provisionalDraftKey) return;
    const ownedDraftKey = sessionDraftKey(sid, remotePeer);
    draftKeyAliasesRef.current.set(provisionalDraftKey, ownedDraftKey);
    const input = opts.chatInputRef?.current;
    if (input) input.rekeyDraft(provisionalDraftKey, ownedDraftKey);
    else rekeyDraft(provisionalDraftKey, ownedDraftKey);
    let assignmentError: Error | null = null;
    if (newSessionSubprojectId) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetch(apiPath(`sessions/${encodeURIComponent(sid)}/subproject`), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ subprojectId: newSessionSubprojectId }),
            cache: "no-store",
          });
          if (response.ok) {
            assignmentError = null;
            break;
          }
          const detail = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
          assignmentError = new Error(
            typeof detail?.error === "string"
              ? detail.error
              : typeof detail?.code === "string"
                ? detail.code
                : `HTTP ${response.status}`,
          );
          const retryable = response.status >= 500 || detail?.code === "transient_session_assignment_forbidden";
          if (!retryable) break;
        } catch (error) {
          assignmentError = error instanceof Error ? error : new Error(String(error));
        }
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
      if (assignmentError) {
        assignmentError.name = SUBPROJECT_ASSIGNMENT_ERROR_NAME;
        console.error("Failed to assign new session to subproject:", assignmentError);
      }
    }
    // The session may have been replaced while the optional promotion write was
    // in flight. Never publish a late result into a different draft.
    if (
      !sessionHookMountedRef.current
      || promotionGeneration !== newSessionLifecycleGenerationRef.current
      || sessionIdRef.current !== sid
      || newSessionDraftKey !== provisionalDraftKey
    ) return;
    onSessionCreated?.({
      id: sid,
      path: "",
      cwd: newSessionCwd,
      name: undefined,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount,
      firstMessage,
      // A failed assignment must not make the session look correctly filed.
      subprojectId: assignmentError ? undefined : newSessionSubprojectId ?? undefined,
      contextSourceSessionId: newSessionContextSourceId ?? undefined,
      transient: true,
    }, provisionalDraftKey);
    if (assignmentError) throw assignmentError;
  }, [apiPath, isNew, newSessionCwd, newSessionDraftKey, newSessionSubprojectId, newSessionContextSourceId, onSessionCreated, opts.chatInputRef, remotePeer]);

  const applyNewSessionResponse = useCallback((
    result: NewSessionResponse,
    selectedModel: SelectedModel | null,
    selectedThinkingLevel: ConcreteThinkingLevel | null,
    selectedFastMode: FastModeSelection | null,
  ): string => {
    const realId = result.sessionId;
    if (!realId) throw new Error("New session response did not include a session id");
    sessionIdRef.current = realId;
    pendingUnattendedRef.current = unattendedOverrideRef.current;
    if (result.branchPosition && !result.branchPosition.pending) branchRef.current?.observeRuntime(result.branchPosition.leafId);
    if (result.autoCompactionEnabled !== undefined) setAutoCompactionEnabled(result.autoCompactionEnabled);
    if (result.model && newSessionModelOverrideRef.current === selectedModel) {
      setPendingModel(result.model);
      if (!selectedModel) setNewSessionDefaultModel(result.model);
    }
    if (
      result.thinkingLevel
      && thinkingLevelOverrideRef.current === selectedThinkingLevel
    ) {
      setThinkingLevel(result.thinkingLevel);
      setLiveThinkingLevel(asConcreteThinkingLevel(result.thinkingLevel));
      if (!selectedThinkingLevel) {
        setNewSessionDefaultThinkingLevel(asConcreteThinkingLevel(result.thinkingLevel));
      }
    }
    if (result.fastMode) {
      fastModeAppliedRef.current = result.fastMode.mode;
      if (fastModeOverrideRef.current === selectedFastMode) {
        setFastModeSelection(result.fastMode.mode);
        setFastModeRuntimeStatus(result.fastMode);
      }
    }
    return realId;
  }, []);

  const requestNewSession = useCallback(async (command: Record<string, unknown>): Promise<string | null> => {
    if (!isNew || !newSessionCwd) return sessionIdRef.current;
    const ownerScope = branchScopeRef.current;
    const ownerPeer = remotePeerRef.current;
    const lifecycle = newSessionLifecycleGenerationRef.current;
    const isCurrent = () => sessionHookMountedRef.current && ownerScope === branchScopeRef.current
      && ownerPeer === remotePeerRef.current && lifecycle === newSessionLifecycleGenerationRef.current;

    const selectedModel = newSessionModelOverrideRef.current;
    const selectedThinkingLevel = thinkingLevelOverrideRef.current;
    const selectedFastMode = fastModeOverrideRef.current;
    if (selectedModel) setPendingModel(selectedModel);
    const toolNames = getToolNamesForPreset(toolPreset);
    sessionToolsPinnedRef.current = toolNames !== undefined;
    const res = await fetch(apiPath("agent/new"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: newSessionCwd,
        ...command,
        ...(toolNames !== undefined ? { toolNames } : {}),
        ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
        ...(selectedThinkingLevel ? { thinkingLevel: selectedThinkingLevel } : {}),
        ...(selectedFastMode ? { fastMode: selectedFastMode } : {}),
        ...(newSessionWorktreeBinding ? { worktreeBinding: newSessionWorktreeBinding } : {}),
        ...(autoCompactionOverrideRef.current !== null ? { autoCompactionEnabled: autoCompactionOverrideRef.current } : {}),
      }),
    });
    const result = await res.json().catch(() => ({})) as NewSessionResponse;
    if (!res.ok || result.error) {
      throw new AgentCommandError(
        result.error ?? `HTTP ${res.status}`,
        res.status,
        result.code,
        result.accepted,
      );
    }
    if (!isCurrent()) return null;
    const realId = applyNewSessionResponse(result, selectedModel, selectedThinkingLevel, selectedFastMode);
    const generation = ++runtimeSettingsReadGenerationRef.current;
    try {
      const state = await sendAgentCommandR<AgentStateResponse>(realId, { type: "get_state" });
      if (!isCurrent() || sessionIdRef.current !== realId) return null;
      if (state.branchPosition && !state.branchPosition.pending) branchRef.current?.observeRuntime(state.branchPosition.leafId);
      if (generation === runtimeSettingsReadGenerationRef.current) {
        if (typeof state.autoCompactionEnabled === "boolean") setAutoCompactionEnabled(state.autoCompactionEnabled);
        else setRuntimeSettingsRead({ status: "error", error: "Automatic compaction preference is unavailable" });
      }
    } catch (error) {
      if (isCurrent() && sessionIdRef.current === realId && generation === runtimeSettingsReadGenerationRef.current) {
        setRuntimeSettingsRead({ status: "error", error: error instanceof Error ? error.message : String(error) });
      }
    }
    return realId;
  }, [apiPath, applyNewSessionResponse, isNew, newSessionCwd, newSessionWorktreeBinding, sendAgentCommandR, toolPreset]);

  const ensureNewSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (!isNew || !newSessionCwd) return sessionIdRef.current;
    if (ensuringNewSessionRef.current) return ensuringNewSessionRef.current;

    const promise = requestNewSession({
      type: "ensure_session",
      ...(newSessionContextSourceId ? { contextSourceSessionId: newSessionContextSourceId } : {}),
    });
    ensuringNewSessionRef.current = promise;
    try {
      return await promise;
    } finally {
      ensuringNewSessionRef.current = null;
    }
  }, [isNew, newSessionCwd, newSessionContextSourceId, requestNewSession]);

  // Opening the System panel is also allowed to initialize an otherwise dormant
  // session. This is deliberately a non-prompt command: it creates no message
  // or model run, but lets users inspect the exact prompt before sending one.
  const loadSystemPrompt = useCallback(async () => {
    const scope = branchScopeRef.current;
    const peer = remotePeerRef.current;
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid || !sessionHookMountedRef.current || scope !== branchScopeRef.current || peer !== remotePeerRef.current) return;
    const generation = ++runtimeSettingsReadGenerationRef.current;
    setRuntimeSettingsRead({ status: "loading" });
    const [state] = await sendAgentCommandR(sid, { type: "initialize_runtime" }).then(() => Promise.all([
      sendAgentCommandR<AgentStateResponse>(sid, { type: "get_state" }),
      loadTools(sid),
    ])).catch((error: unknown) => {
      if (sessionHookMountedRef.current && sessionIdRef.current === sid && generation === runtimeSettingsReadGenerationRef.current
        && scope === branchScopeRef.current && peer === remotePeerRef.current) {
        setRuntimeSettingsRead({ status: "error", error: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    });
    if (!sessionHookMountedRef.current || sessionIdRef.current !== sid
      || scope !== branchScopeRef.current || peer !== remotePeerRef.current) return;
    setSystemPrompt(state.systemPrompt ?? "");
    if (generation === runtimeSettingsReadGenerationRef.current) {
      if (typeof state.autoCompactionEnabled === "boolean") setAutoCompactionEnabled(state.autoCompactionEnabled);
      else setRuntimeSettingsRead({ status: "error", error: "Automatic compaction preference is unavailable" });
    }
    setRuntimeInspection(state.runtimeInspection ?? null);
  }, [ensureNewSession, loadTools, sendAgentCommandR]);

  const replaceSlashCommands = useCallback((commands: SlashCommandInfo[]) => {
    slashCommandsRef.current = commands;
    setSlashCommands(commands);
  }, []);

  // The session's tools changed (set_tools may have rebuilt it as Chat only): forget the
  // list and the request under way, so the next reader asks the session as it is now.
  const clearSlashCommands = useCallback(() => {
    slashCommandsGenerationRef.current += 1;
    slashCommandsLoadRef.current = null;
    setSlashCommandsReloadKey((value) => value + 1);
    replaceSlashCommands([]);
  }, [replaceSlashCommands]);

  // Null when get_commands failed, which an empty list (a Chat-only session's) must not be mistaken for.
  const requestSlashCommands = useCallback((): Promise<SlashCommandInfo[] | null> => {
    const generation = ++slashCommandsGenerationRef.current;
    const ownerScope = branchScopeRef.current;
    const ownerPeer = remotePeerRef.current;
    let ownerSessionId: string | null = null;
    const current = () => sessionHookMountedRef.current
      && branchScopeRef.current === ownerScope
      && remotePeerRef.current === ownerPeer
      && (!ownerSessionId || sessionIdRef.current === ownerSessionId)
      && slashCommandsGenerationRef.current === generation;
    const load = (async () => {
      const sid = sessionIdRef.current ?? await ensureNewSession();
      ownerSessionId = sid;
      if (!current()) return null;
      if (!sid) {
        if (current()) replaceSlashCommands([]);
        return [] as SlashCommandInfo[];
      }
      setSlashCommandsLoading(true);
      try {
        // The command palette is an explicit request to use session resources.
        // Cold sessions must opt into runtime initialization before get_commands.
        if (!runtimeAvailableRef.current) {
          await sendAgentCommandR(sid, { type: "initialize_runtime" });
          if (!current()) return null;
          runtimeAvailableRef.current = true;
          setRuntimeAvailable(true);
        }
        const data = await sendAgentCommandR<SlashCommandsResponse>(sid, { type: "get_commands" });
        const commands = data?.commands ?? [];
        if (current()) replaceSlashCommands(commands);
        return current() ? commands : null;
      } catch (e) {
        console.error("Failed to load slash commands:", e);
        if (current()) replaceSlashCommands([]);
        return null;
      } finally {
        // A newer request under way keeps the palette's "Loading" until it answers.
        if (current() || !slashCommandsLoadRef.current) setSlashCommandsLoading(false);
      }
    })();
    slashCommandsLoadRef.current = load;
    const settle = () => {
      if (slashCommandsLoadRef.current === load) slashCommandsLoadRef.current = null;
    };
    load.then(settle, settle);
    return load;
  }, [ensureNewSession, replaceSlashCommands, sendAgentCommandR]);

  const loadSlashCommands = useCallback(async () => (await requestSlashCommands()) ?? [], [requestSlashCommands]);

  // The list a bare /mcp is decided by: the request under way (the palette starts
  // one as "/mcp" is typed, often still unanswered at Enter), else the list already
  // loaded, else a new request. Null when it cannot be read: guessing would either
  // swallow another extension's /mcp or send one Settings should have taken.
  const slashCommandsForMcp = useCallback(async (): Promise<SlashCommandInfo[] | null> => {
    const ownerScope = branchScopeRef.current;
    const ownerPeer = remotePeerRef.current;
    const pending = slashCommandsLoadRef.current;
    const known = slashCommandsRef.current;
    if (!pending && known.length > 0) return known;
    const load = pending ?? requestSlashCommands();
    const generation = slashCommandsGenerationRef.current;
    const loaded = await load.catch(() => null);
    if (!sessionHookMountedRef.current || branchScopeRef.current !== ownerScope
      || remotePeerRef.current !== ownerPeer || slashCommandsGenerationRef.current !== generation) return null;
    return loaded ?? (known.length > 0 ? known : null);
  }, [requestSlashCommands]);

  const runtimeUiOwnerRef = useRef({ peer: remotePeer ?? null, sessionId: session?.id ?? null });
  useEffect(() => {
    const previous = runtimeUiOwnerRef.current;
    const sessionId = session?.id ?? null;
    const peer = remotePeer ?? null;
    const isPromotion = previous.sessionId === null && sessionId !== null
      && previous.peer === peer && sessionIdRef.current === sessionId && newSessionPromotedRef.current;
    runtimeUiOwnerRef.current = { peer, sessionId };
    if (!isPromotion) {
      clearSlashCommands();
      setExtensionDialogs([]);
      setExtensionCustomUis([]);
      activeToolIdsRef.current.clear();
      toolEventRevisionRef.current += 1;
      setActiveToolResults(new Map());
    }
    const key = session?.id ? cacheKeyForSession(session.id) : null;
    const draft = session?.id ? getDraft(historyDraftKey(session.id, remotePeer)) : null;
    const stored = key && draft?.historyEdit
      ? { ...draft.historyEdit, targetLeafId: draft.historyEdit.entryId }
      : null;
    if (key && stored) pendingHistoryEdits.set(key, stored);
    else if (key) pendingHistoryEdits.delete(key);
    setEditEntryId(stored?.entryId ?? null);
  }, [cacheKeyForSession, clearSlashCommands, remotePeer, session?.id]);

  const cancelEventStreamGrace = useCallback(() => {
    eventStreamGraceGenerationRef.current += 1;
    eventStreamGraceActiveRef.current = false;
    if (eventStreamGraceTimerRef.current) {
      clearTimeout(eventStreamGraceTimerRef.current);
      eventStreamGraceTimerRef.current = null;
    }
  }, []);

  const closeEvents = useCallback(() => {
    eventConnectionRef.current?.close();
  }, []);

  const flushPendingUnattended = useCallback(async (sid: string) => {
    if (unattendedWriteRef.current) return unattendedWriteRef.current;
    const scope = branchScopeRef.current, peer = remotePeerRef.current;
    const isCurrent = () => sessionHookMountedRef.current && sessionIdRef.current === sid
      && branchScopeRef.current === scope && remotePeerRef.current === peer;
    const write = (async () => {
      while (pendingUnattendedRef.current !== null) {
        if (!isCurrent()) throw new Error("The conversation changed");
        const enabled = pendingUnattendedRef.current;
        await sendAgentCommandR(sid, { type: "set_unattended", enabled });
        if (!isCurrent()) throw new Error("The conversation changed");
        if (pendingUnattendedRef.current === enabled) pendingUnattendedRef.current = null;
      }
    })();
    unattendedWriteRef.current = write;
    try { await write; }
    finally { if (unattendedWriteRef.current === write) unattendedWriteRef.current = null; }
  }, [sendAgentCommandR]);

  const ensureEventsConnected = useCallback(async (sid: string) => {
    const scope = branchScopeRef.current, peer = remotePeerRef.current;
    const isCurrent = () => sessionHookMountedRef.current && sessionIdRef.current === sid
      && branchScopeRef.current === scope && remotePeerRef.current === peer;
    const state = await sendAgentCommandR<AgentStateResponse>(sid, { type: "initialize_runtime" });
    if (!isCurrent()) throw new Error("The conversation changed");
    if (state?.branchPosition) {
      if (state.branchPosition.pending) branchRef.current?.markUnconfirmed(new Error("Branch navigation is pending"));
      else {
        branchRef.current?.observeRuntime(state.branchPosition.leafId);
        if (branchRef.current && canWriteBranch(branchRef.current.state)) sessionViewValidationPendingRef.current = false;
      }
    }
    await flushPendingUnattended(sid);
    if (!isCurrent()) throw new Error("The conversation changed");
    runtimeAvailableRef.current = true;
    setRuntimeAvailable(true);
    await eventConnectionRef.current!.ensureRuntimeConnected(sid);
  }, [flushPendingUnattended, sendAgentCommandR]);

  const maintainEventsConnected = useCallback((sid: string) => {
    eventConnectionRef.current!.maintain(sid);
  }, []);

  // A sleeping tab can resume with an OPEN EventSource whose timer did not run.
  // Recheck wall-clock silence after the browser has had a moment to deliver any
  // buffered heartbeat, and let the connection decide whether to reconnect.
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    let timer: number | null = null;
    const scheduleRecheck = () => {
      if (timer !== null) window.clearTimeout(timer);
      const delay = document.visibilityState === "visible" ? 1_500 : 0;
      timer = window.setTimeout(() => {
        timer = null;
        eventConnectionRef.current?.recheck();
      }, delay);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") scheduleRecheck();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", scheduleRecheck);
    window.addEventListener("pageshow", scheduleRecheck);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", scheduleRecheck);
      window.removeEventListener("pageshow", scheduleRecheck);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  // Selected sessions receive run snapshots and pending extension UI immediately.
  useEffect(() => {
    if (!session?.id || opts.background) return;
    // React Strict Mode must restore this before shouldMaintain reads the ref.
    sessionHookMountedRef.current = true;
    maintainEventsConnected(session.id);
    return () => {
      if (
        opts.background
        || (
          sessionIdRef.current === session.id
          && !agentRunningRef.current
          && !bashRunningRef.current
          && !eventStreamGraceActiveRef.current
          && (sessionPropIdRef.current !== session.id || !sessionRunningRef.current)
        )
      ) {
        eventConnectionRef.current?.close();
      }
    };
  }, [agentRunning, bashRunning, maintainEventsConnected, opts.background, session?.id, sessionRunning]);

  // Only the foreground Reader owns the selected idle wrapper's browser lease.
  useEffect(() => {
    const sid = session?.id;
    if (!sid || opts.background || !runtimeAvailable) return;
    const peer = remotePeer;
    const scope = branchScopeRef.current;
    let disposed = false;
    let renewing = false;
    const isCurrent = () => !disposed && sessionHookMountedRef.current
      && sessionIdRef.current === sid && sessionPropIdRef.current === sid
      && remotePeerRef.current === peer && branchScopeRef.current === scope;
    const renewLease = async () => {
      if (!isCurrent() || renewing) return;
      renewing = true;
      try {
        const response = await fetch(apiPath(`agent/${encodeURIComponent(sid)}/lease`), { method: "POST", cache: "no-store" });
        if (!response.ok || !isCurrent()) return;
        const result = await response.json() as { renewed?: number };
        if (isCurrent() && result.renewed === 0) {
          closeEvents();
          runtimeAvailableRef.current = false;
          setRuntimeAvailable(false);
        }
      } catch {
        // SSE remains the primary path; the next interval retries the browser lease.
      } finally {
        renewing = false;
      }
    };
    const interval = setInterval(() => void renewLease(), SESSION_LEASE_RENEW_INTERVAL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void renewLease(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [apiPath, closeEvents, opts.background, remotePeer, session?.id, runtimeAvailable]);

  const respondToExtensionUi = useCallback(async (
    request: ExtensionUiDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    markSessionDialogInteracted(sid);
    try {
      await sendAgentCommandR(sid, {
        type: "extension_ui_response",
        id: request.id,
        runtimeGeneration: request.runtimeGeneration,
        ...response,
      });
      setExtensionDialogs((queue) => removeExtensionUiRequest(queue, request.id));
    } catch (e) {
      console.error("Failed to send extension UI response:", e);
    }
  }, [sendAgentCommandR]);

  const closeExtensionCustomUi = useCallback(async (request: ExtensionUiCustomRequest) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    markSessionDialogInteracted(sid);
    try {
      await sendAgentCommandR(sid, {
        type: "extension_ui_close",
        id: request.id,
      });
    } catch (e) {
      console.error("Failed to close extension custom UI:", e);
    }
  }, [sendAgentCommandR]);

  const sendExtensionCustomInput = useCallback(async (request: ExtensionUiCustomRequest, data: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    markSessionDialogInteracted(sid);
    try {
      await sendAgentCommandR(sid, {
        type: "extension_ui_input",
        id: request.id,
        data,
      });
    } catch (e) {
      console.error("Failed to send extension custom UI input:", e);
    }
  }, [sendAgentCommandR]);

  const addNotice = useCallback((notice: { id?: string; message: string; type?: NoticeType }) => {
    const message = notice.message.trim();
    if (!message) return;
    dispatchNotice({
      type: "add",
      notice: {
        id: notice.id ?? createNoticeId(),
        message,
        type: notice.type ?? "info",
      },
    });
  }, []);

  const setNoticesHovered = useCallback((hovered: boolean) => {
    noticeHoverRef.current = hovered;
  }, []);

  const dismissNotices = useCallback(() => {
    dispatchNotice({ type: "mark_all_exiting" });
  }, []);

  const handleExtensionUiRequest = useCallback((request: ExtensionUiRequest) => {
    if (isBlockingExtensionUiRequest(request)) onAttentionNeeded?.(request);

    switch (request.method) {
      case "select":
      case "confirm":
      case "input":
      case "editor":
        setExtensionDialogs((queue) => enqueueExtensionUiRequest(queue, request));
        break;
      case "notify": {
        addNotice({
          id: request.id,
          message: request.message,
          type: request.notifyType ?? "info",
        });
        break;
      }
      case "setStatus":
        setExtensionStatuses((prev) => {
          const rest = prev.filter((item) => item.key !== request.statusKey);
          return request.statusText !== undefined
            ? [...rest, { key: request.statusKey, text: request.statusText }]
            : rest;
        });
        break;
      case "setWidget":
        setExtensionWidgets((prev) => {
          const rest = prev.filter((item) => item.key !== request.widgetKey);
          return request.widgetLines
            ? [...rest, {
                key: request.widgetKey,
                lines: request.widgetLines,
                placement: request.widgetPlacement ?? "aboveEditor",
              }]
            : rest;
        });
        break;
      case "setExtensionUsage":
        setExtensionUsages((prev) => {
          const rest = prev.filter((item) => item.key !== request.usageKey);
          return request.usage
            ? [...rest, { key: request.usageKey, ...request.usage }]
            : rest;
        });
        if (sessionIdRef.current) invalidateSessionDetailsForSession(sessionIdRef.current);
        break;
      case "setTitle":
        if (request.title) document.title = request.title;
        break;
      case "set_editor_text":
        opts.chatInputRef?.current?.insertText(request.text);
        break;
      case "set_editor_suggestion":
        setEditorSuggestion(request.suggestion ?? null);
        break;
      case "custom":
        setExtensionCustomUis((queue) => request.closed
          ? removeExtensionUiRequest(queue, request.id)
          : upsertExtensionUiRequest(queue, request));
        break;
    }
  }, [addNotice, invalidateSessionDetailsForSession, onAttentionNeeded, opts.chatInputRef]);

  const settleUiStage = useCallback(() => {
    const wasRunning = agentRunningRef.current;
    sessionSettlementGenerationRef.current += 1;
    agentRunningRef.current = false;
    sessionRunningRef.current = false;
    sdkAgentActiveRef.current = false;
    rpcPromptPendingRef.current = false;
    setAgentRunning(false);
    setAgentPhase(null);
    activeToolIdsRef.current.clear();
    toolEventRevisionRef.current += 1;
    setActiveToolResults(new Map());
    setRetryInfo(null);
    dispatch({ type: "end" });
    void reader.reconcileTail();
    return wasRunning;
  }, [dispatch, reader]);

  const confirmPromptDelivery = useCallback((clientMessageId: string) => {
    const delivery = promptDeliveriesRef.current.get(clientMessageId);
    if (!delivery || delivery.sessionId !== sessionIdRef.current || delivery.peer !== (remotePeerRef.current ?? null)) return null;
    delivery.confirmed = true;
    promptDeliveriesRef.current.delete(clientMessageId);
    setUnconfirmedPrompts((previous) => previous.some((item) => item === delivery) ? previous.filter((item) => item !== delivery) : previous);
    if (delivery.historyEditEntryId) {
      const key = cacheKeyForSession(delivery.sessionId, delivery.peer ?? undefined);
      if (pendingHistoryEdits.get(key)?.clientMessageId === clientMessageId) setEditRef.current(null);
    }
    return delivery;
  }, [cacheKeyForSession]);

  const notifyPromptStage = useCallback((runId: number, serverRunId?: string) => {
    if ([...promptDeliveriesRef.current.values()].some((delivery) => delivery.runId === runId
      && delivery.sessionId === sessionIdRef.current && delivery.peer === (remotePeerRef.current ?? null))) return false;
    if (!promptCompletionDeduperRef.current.claim(sessionIdRef.current, runId, serverRunId)) return false;
    if (!lastAgentErrorRef.current && !lastAgentAbortedRef.current) onAgentEnd?.(serverRunId);
    lastAgentErrorRef.current = false;
    lastAgentAbortedRef.current = false;
    return true;
  }, [onAgentEnd]);

  const scheduleEventStreamClose = useCallback((sid: string) => {
    if (sessionPropIdRef.current === sid && foregroundSessionRef.current) return;
    cancelEventStreamGrace();
    eventStreamGraceActiveRef.current = true;
    const generation = eventStreamGraceGenerationRef.current;
    eventStreamGraceTimerRef.current = setTimeout(() => {
      if (
        generation !== eventStreamGraceGenerationRef.current
        || sessionIdRef.current !== sid
        || !eventStreamGraceActiveRef.current
      ) return;
      eventStreamGraceActiveRef.current = false;
      eventStreamGraceTimerRef.current = null;
      closeEvents();
    }, EVENT_STREAM_IDLE_GRACE_MS);
  }, [cancelEventStreamGrace, closeEvents]);

  const finishPromptWithoutStream = useCallback(async (sid: string | null = sessionIdRef.current, runId = promptRunIdRef.current) => {
    const revision = stateRunRevisionRef.current;
    const toolRevision = toolEventRevisionRef.current;
    const serverRunId = currentAgentRunIdRef.current;
    const scope = branchScopeRef.current;
    const peer = remotePeerRef.current;
    const isCurrent = () => sessionHookMountedRef.current && sessionIdRef.current === sid
      && promptRunIdRef.current === runId && stateRunRevisionRef.current === revision
      && toolEventRevisionRef.current === toolRevision
      && currentAgentRunIdRef.current === serverRunId && branchScopeRef.current === scope
      && remotePeerRef.current === peer;
    // Bail out before loadSession too: a stale finish for a previous run
    // must not overwrite the messages of the run currently streaming.
    if (!isCurrent() || typeof rpcPromptPendingRef.current === "object") return;
    try {
      if (sid) {
        await loadSession(sid);
        await refreshSessionCost(sid);
      }
    } finally {
      if (!isCurrent()) return;
      const promptWasPending = rpcPromptPendingRef.current;
      const agentWasActive = sdkAgentActiveRef.current;
      rpcPromptPendingRef.current = false;
      sdkAgentActiveRef.current = false;
      const wasRunning = settleUiStage();
      if (promptWasPending) {
        notifyPromptStage(runId, currentAgentRunIdRef.current ?? undefined);
      } else if (agentWasActive && wasRunning) {
        notifyPromptStage(runId, currentAgentRunIdRef.current ?? undefined);
      }
      if (sid) scheduleEventStreamClose(sid);
    }
  }, [loadSession, notifyPromptStage, refreshSessionCost, scheduleEventStreamClose, settleUiStage]);

  // 非流式命令（斜杠命令 / 重入未流式 prompt）的快速结算：这类命令不产生流式
  // assistant 增量消息，轮询服务端状态确认空闲后走 finishPromptWithoutStream 落库刷新。
  // 普通 prompt 发送一律走 SSE 事件通道（message_start/update/end/agent_settled），
  // 严禁对普通 prompt 执行本轮询（否则在模型思考/首 token 到达前会误判完成，触发
  // 假完成音并回滚乐观 user 消息）。
  const waitForPromptSettlement = useCallback(async (sid: string, runId?: number) => {
    await delay(PROMPT_SETTLE_INITIAL_DELAY_MS);
    const startedAt = Date.now();

    while (agentRunningRef.current && Date.now() - startedAt < PROMPT_SETTLE_MAX_MS) {
      if (runId !== undefined && promptRunIdRef.current !== runId) return;
      try {
        const res = await fetch(apiPath(`agent/${encodeURIComponent(sid)}?systemPrompt=0`));
        if (res.ok) {
          const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
          const state = data.state;
          if (!data.running || !state || (!state.isStreaming && !state.isPromptRunning && !state.isBashRunning && !state.isCompacting)) {
            await finishPromptWithoutStream(sid, runId);
            return;
          }
        }
      } catch {
        // SSE remains the primary completion path.
      }
      await delay(PROMPT_SETTLE_POLL_MS);
    }
  }, [apiPath, finishPromptWithoutStream]);

  const restoreLoadedRunState = useCallback((sid: string, agentState: { running: boolean; state?: AgentStateResponse } | null, expectedSettlementGeneration?: number, expectedRunRevision?: number) => {
    if (!agentState || sessionIdRef.current !== sid || !sessionHookMountedRef.current) return;
    if (expectedRunRevision !== undefined && stateRunRevisionRef.current !== expectedRunRevision) return;
    const staleBusySnapshot = expectedSettlementGeneration !== undefined
      && sessionSettlementGenerationRef.current !== expectedSettlementGeneration
      && Boolean(agentState.running && (agentState.state?.isStreaming || agentState.state?.isPromptRunning || agentState.state?.isBashRunning || agentState.state?.isCompacting));
    if (staleBusySnapshot) return;
    if (typeof rpcPromptPendingRef.current === "object") return;
    const promptRunning = Boolean(agentState.running && (agentState.state?.isStreaming || agentState.state?.isPromptRunning));
    if (!promptRunning && activeToolIdsRef.current.size > 0) return;
    const serverBusy = Boolean(agentState.running && (promptRunning || agentState.state?.isBashRunning || agentState.state?.isCompacting));
    sessionRunningRef.current = serverBusy;
    agentRunningRef.current = promptRunning;
    setAgentRunning(promptRunning);
    setIsCompacting(Boolean(agentState.running && agentState.state?.isCompacting) || localCompactionPendingRef.current);
    if (!promptRunning) {
      sdkAgentActiveRef.current = false;
      rpcPromptPendingRef.current = false;
      setAgentPhase(null);
      dispatch({ type: "end" });
    }
    if (agentState.running) {
      loadTools(sid);
      if (promptRunning) {
        sdkAgentActiveRef.current = Boolean(agentState.state?.isStreaming);
        rpcPromptPendingRef.current = Boolean(agentState.state?.isPromptRunning);
        setAgentPhase((previous) => previous?.kind === "running_tools" && activeToolIdsRef.current.size > 0
          ? previous : agentState.state?.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
        dispatch({ type: "resume" });
        // 已运行会话重入时若处于 prompt-running（无 streaming 事件），补一个
        // 快速结算检查：SSE 可能因上次断开而未送达 agent_settled，否则会话会
        // 卡“处理中”直到用户再次刷新/重进。
        if (!agentState.state?.isStreaming && agentState.state?.isPromptRunning) {
          void waitForPromptSettlement(sid);
        }
      }
      if (agentState.state?.isBashRunning) {
        bashRunningRef.current = true;
        setBashRunning(true);
      }
    }
    onSessionReady?.(serverBusy);
  }, [dispatch, loadTools, onSessionReady, waitForPromptSettlement]);

  // Reconcile client streaming state with the server. When SSE events are
  // missed (network drop, mobile tab backgrounded, half-open connection),
  // agent_end never arrives and the UI stays in streaming state forever.
  // If the server reports idle while we still think it's running, finish
  // through the same settlement path used by non-streaming prompts.
  const reconcileAgentState = useCallback(async (sid: string) => {
    const queueGeneration = queuedDraftProjectionRef.current.generation;
    const clientStreamActive = streamingStore.getState().isStreaming;
    if (typeof rpcPromptPendingRef.current === "object"
      || (!agentRunningRef.current && !bashRunningRef.current && !isCompacting && !clientStreamActive) || sessionIdRef.current !== sid) return;
    const runId = promptRunIdRef.current;
    const revision = stateRunRevisionRef.current;
    const toolRevision = toolEventRevisionRef.current;
    const serverRunId = currentAgentRunIdRef.current;
    const scope = branchScopeRef.current;
    const peer = remotePeerRef.current;
    const ownsQueue = () => sessionHookMountedRef.current && sessionIdRef.current === sid
      && branchScopeRef.current === scope && remotePeerRef.current === peer;
    const isCurrent = () => ownsQueue() && promptRunIdRef.current === runId
      && stateRunRevisionRef.current === revision && toolEventRevisionRef.current === toolRevision
      && currentAgentRunIdRef.current === serverRunId;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(apiPath(`agent/${encodeURIComponent(sid)}?systemPrompt=0`), { signal: controller.signal });
      if (!res.ok) return;
      const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
      if (!ownsQueue()) return;
      syncQueuedDraftResponse(sid, { ...data, ok: res.ok }, queueGeneration,
        promptRunIdRef.current === runId && currentAgentRunIdRef.current === serverRunId);
      // A slow response can straddle a run boundary (previous run finished
      // and the user already started the next one while in flight) — drop it.
      if (!isCurrent() || typeof rpcPromptPendingRef.current === "object"
        || typeof data.running !== "boolean" || (data.running && !data.state)) return;
      const state = data.state;
      if (state?.fastMode && sessionIdRef.current === sid) {
        setFastModeSelection(state.fastMode.mode);
        setFastModeRuntimeStatus(state.fastMode);
      }
      const bashBusy = Boolean(data.running && state?.isBashRunning);
      if (bashBusy) {
        bashRunningRef.current = true;
        setBashRunning(true);
        return;
      }
      if (bashRunningRef.current) {
        await loadSession(sid);
        if (!isCurrent()) return;
        bashRunningRef.current = false;
        setBashRunning(false);
        setPendingBash(null);
      }
      // Mirror compaction state unconditionally: a missed compaction_end would
      // otherwise leave the "Stop compaction" UI stuck.
      setIsCompacting(Boolean(data.running && state?.isCompacting) || localCompactionPendingRef.current);
      const busy = data.running && state
        && (state.isStreaming || state.isPromptRunning || state.isCompacting);
      if (busy || localCompactionPendingRef.current) {
        if (state) {
          sdkAgentActiveRef.current = Boolean(state.isStreaming);
          rpcPromptPendingRef.current = Boolean(state.isPromptRunning);
        }
        return;
      }
      if (!agentRunningRef.current && !clientStreamActive) return;
      if (state) {
        if (state.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
        if (state.autoCompactionEnabled !== undefined) setAutoCompactionEnabled(state.autoCompactionEnabled);
        if (state.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt ?? null);
        if (state.runtimeInspection !== undefined) setRuntimeInspection(state.runtimeInspection ?? null);
        if (state.extensionStatuses !== undefined) setExtensionStatuses(state.extensionStatuses ?? []);
        if (state.extensionUsages !== undefined) setExtensionUsages(state.extensionUsages ?? []);
        if (state.extensionWidgets !== undefined) setExtensionWidgets(state.extensionWidgets ?? []);
        if (state.editorSuggestion !== undefined) setEditorSuggestion(state.editorSuggestion ?? null);
      }
      await finishPromptWithoutStream(sid, runId);
    } catch {
      // One-shot foreground/network recovery failed; the next tick retries.
    } finally {
      window.clearTimeout(timeout);
    }
  }, [apiPath, finishPromptWithoutStream, isCompacting, loadSession, streamingStore, syncQueuedDraftResponse]);

  // Keep a bounded foreground fallback for missed or half-open SSE connections.
  // SSE remains primary; this only repairs state that would otherwise stay
  // stuck until a full page refresh.
  useEffect(() => {
    if (!agentRunning && !bashRunning && !isCompacting && !streamingStore.getState().isStreaming) return;
    const reconcile = () => {
      const sid = sessionIdRef.current;
      if (sid) void reconcileAgentState(sid);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    const interval = window.setInterval(reconcile, 15_000);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconcile);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconcile);
    };
  }, [agentRunning, bashRunning, isCompacting, reconcileAgentState, streamingStore]);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case "history_changed": {
        void reader.reconcileTail();
        break;
      }
      case "connected": {
        const sid = sessionIdRef.current;
        const revision = ++stateRunRevisionRef.current;
        activeToolIdsRef.current.clear();
        toolEventRevisionRef.current += 1;
        setActiveToolResults(new Map());
        setAgentPhase((previous) => previous?.kind === "running_tools" ? null : previous);
        if (sid) {
          void loadAgentState(sid).then((state) => restoreLoadedRunState(sid, state, undefined, revision));
        }
        // A reconnect snapshot has no agent_start event. Clear the previous
        // server run identity so the first terminal event can seed this stream;
        // a later agent_start will replace it and reject stale buffered events.
        currentAgentRunIdRef.current = null;
        if (sid) void reader.reconcileTail();
        if (typeof rpcPromptPendingRef.current !== "object") dispatch({ type: "end" });
        if (Array.isArray(event.pendingExtensionUiIds)) {
          // The server replays what it still holds right after this event.
          const pending = new Set(event.pendingExtensionUiIds as string[]);
          setExtensionDialogs((queue) => retainExtensionUiRequests(queue, pending));
          setExtensionCustomUis((queue) => retainExtensionUiRequests(queue, pending));
        }
        if (event.isStreaming === true || event.isPromptRunning === true) {
          cancelEventStreamGrace();
          runtimeAvailableRef.current = true;
          setRuntimeAvailable(true);
          sdkAgentActiveRef.current = true;
          agentRunningRef.current = true;
          setAgentRunning(true);
          sessionStatePendingRef.current = false;
          setSessionStatePending(false);
          setAgentPhase({ kind: "waiting_model" });
        }
        // connected advances the default run identity, so a pending primary
        // history GET must be replaced under the new identity. The registration
        // is generation- and scope-bound; its own finally cannot clear a newer
        // successor or create another reload.
        const pendingLoad = pendingSessionLoadRef.current;
        if (
          sid
          && pendingLoad
          && pendingLoad.generation === sessionLoadGenerationRef.current
          && pendingLoad.sessionId === sid
          && pendingLoad.peer === (remotePeerRef.current ?? null)
          && pendingLoad.scope === branchScopeRef.current
          && sessionHookMountedRef.current
        ) {
          void loadSession(sid, pendingLoad.showLoading, pendingLoad.targetLeafId);
        }
        break;
      }
      case "agent_start": {
        stateRunRevisionRef.current += 1;
        activeToolIdsRef.current.clear();
        toolEventRevisionRef.current += 1;
        setActiveToolResults(new Map());
        sessionStatePendingRef.current = false;
        setSessionStatePending(false);
        const serverRunId = typeof event.runId === "string" ? event.runId : undefined;
        if (serverRunId) currentAgentRunIdRef.current = serverRunId;
        if (typeof rpcPromptPendingRef.current === "object" && rpcPromptPendingRef.current.stopping) rpcPromptPendingRef.current = true;
        cancelEventStreamGrace();
        lastAgentErrorRef.current = false;
        lastAgentAbortedRef.current = false;
        sdkAgentActiveRef.current = true;
        agentRunningRef.current = true;
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        dispatch({ type: "start" });
        break;
      }
      case "agent_end": {
        const eventRunRevision = stateRunRevisionRef.current;
        const serverRunId = typeof event.runId === "string" ? event.runId : undefined;
        if ((currentAgentRunIdRef.current && !serverRunId) || (serverRunId && currentAgentRunIdRef.current && serverRunId !== currentAgentRunIdRef.current)) break;
        if (serverRunId) currentAgentRunIdRef.current = serverRunId;
        const errorMessage = typeof event.errorMessage === "string" ? event.errorMessage : agentEndErrorMessage(event);
        if (agentEndWasAborted(event)) lastAgentAbortedRef.current = true;
        if (errorMessage) {
          if (!lastAgentErrorRef.current) {
            onAgentError?.(typeof event.unattended === "boolean" ? event.unattended : undefined, serverRunId);
          }
          lastAgentErrorRef.current = true;
        }
        // One logical prompt can emit multiple agent_end events before retrying,
        // compacting, or continuing messages queued by extension handlers.
        // Keep the stream open until prompt_done/agent_settled and the idle grace.
        activeToolIdsRef.current.clear();
        toolEventRevisionRef.current += 1;
        if (!agentRunningRef.current) break;
        setAgentPhase(null);
        setRetryInfo(null);
        dispatch({ type: "end" });
        if (sessionIdRef.current) {
          const sid = sessionIdRef.current;
          const runGuard: SessionLoadRunGuard = {
            stateRunRevision: eventRunRevision,
            ...(serverRunId ? { serverRunId } : {}),
          };
          void loadSession(sid, false, undefined, runGuard).then(() => {
            if (
              sessionHookMountedRef.current
              && sessionIdRef.current === sid
              && stateRunRevisionRef.current === eventRunRevision
              && (!serverRunId || currentAgentRunIdRef.current === serverRunId)
            ) void refreshSessionCost(sid);
          });
          const queueGeneration = queuedDraftProjectionRef.current.generation;
          const queuePeer = remotePeerRef.current;
          const queueScope = branchScopeRef.current;
          const queueRunId = currentAgentRunIdRef.current;
          const queuePromptId = promptRunIdRef.current;
          fetch(apiPath(`agent/${encodeURIComponent(sid)}`))
            .then(async (r) => {
              if (!r.ok) return;
              const d = await r.json() as { running?: boolean; state?: AgentStateResponse };
              if (
                !sessionHookMountedRef.current
                || sessionIdRef.current !== sid
                || remotePeerRef.current !== queuePeer
                || branchScopeRef.current !== queueScope
              ) return;
              syncQueuedDraftResponse(sid, { ...d, ok: r.ok }, queueGeneration,
                currentAgentRunIdRef.current === queueRunId && promptRunIdRef.current === queuePromptId);
              if (stateRunRevisionRef.current !== eventRunRevision
                || (serverRunId && currentAgentRunIdRef.current !== serverRunId)) return;
              if (d.state?.contextUsage !== undefined) setContextUsage(d.state.contextUsage ?? null);
              if (d.state?.autoCompactionEnabled !== undefined) setAutoCompactionEnabled(d.state.autoCompactionEnabled);
              if (d.state?.systemPrompt !== undefined) setSystemPrompt(d.state.systemPrompt ?? null);
              if (d.state?.runtimeInspection !== undefined) setRuntimeInspection(d.state.runtimeInspection ?? null);
              if (d.state?.fastMode !== undefined) {
                setFastModeSelection(d.state.fastMode.mode);
                setFastModeRuntimeStatus(d.state.fastMode);
              }
              if (d.state?.extensionStatuses !== undefined) setExtensionStatuses(d.state.extensionStatuses ?? []);
              if (d.state?.extensionUsages !== undefined) setExtensionUsages(d.state.extensionUsages ?? []);
              if (d.state?.extensionWidgets !== undefined) setExtensionWidgets(d.state.extensionWidgets ?? []);
              if (d.state?.editorSuggestion !== undefined) setEditorSuggestion(d.state.editorSuggestion ?? null);
            })
            .catch(() => {});
        }
        break;
      }
      case "agent_settled": {
        const serverRunId = typeof event.runId === "string" ? event.runId : undefined;
        if ((currentAgentRunIdRef.current && !serverRunId) || (serverRunId && currentAgentRunIdRef.current && serverRunId !== currentAgentRunIdRef.current)) break;
        const agentWasActive = sdkAgentActiveRef.current;
        if (event.aborted === true) lastAgentAbortedRef.current = true;
        sdkAgentActiveRef.current = false;
        // An inactive/repeated settled event, or a settled SDK stage whose
        // local prompt is still pending, only updates bookkeeping. It must not
        // invalidate a terminal history load that is already in flight.
        if (!agentWasActive || rpcPromptPendingRef.current) break;
        stateRunRevisionRef.current += 1;
        if (serverRunId) currentAgentRunIdRef.current = serverRunId;

        const sid = sessionIdRef.current;
        const wasRunning = settleUiStage();
        setIsCompacting(false);
        if (sid) {
          void loadSession(sid);
          scheduleEventStreamClose(sid);
        }
        if (wasRunning && !lastAgentErrorRef.current && !lastAgentAbortedRef.current) notifyPromptStage(promptRunIdRef.current, serverRunId);
        if (wasRunning && (lastAgentErrorRef.current || lastAgentAbortedRef.current)) {
          // A stopped/aborted turn settles without a completion sound or success notification.
          lastAgentErrorRef.current = false;
          lastAgentAbortedRef.current = false;
        }
        break;
      }
      case "prompt_done":
        {
          if (typeof rpcPromptPendingRef.current === "object" && !rpcPromptPendingRef.current.requestStarted) break;
          if (typeof event.clientMessageId === "string") {
            const delivery = confirmPromptDelivery(event.clientMessageId);
            if (delivery && delivery.runId !== promptRunIdRef.current) break;
            if ([...promptDeliveriesRef.current.values()].some((pending) => pending.runId === promptRunIdRef.current
              && pending.sessionId === sessionIdRef.current && pending.peer === (remotePeerRef.current ?? null))) break;
          }
          const serverRunId = typeof event.runId === "string" ? event.runId : undefined;
          if ((currentAgentRunIdRef.current && !serverRunId) || (serverRunId && currentAgentRunIdRef.current && serverRunId !== currentAgentRunIdRef.current)) break;
          const runId = promptRunIdRef.current;
          const promptWasPending = rpcPromptPendingRef.current;
          // No-op prompt_done still clears local prompt bookkeeping, but it
          // must not advance the default identity before deciding whether it
          // owns a real refresh/settle action. The 612 completion deduper is
          // the admission source for the first notification.
          rpcPromptPendingRef.current = false;
          const firstNotification = notifyPromptStage(runId, serverRunId);
          if (!promptWasPending && !firstNotification) break;
          stateRunRevisionRef.current += 1;
          if (serverRunId) currentAgentRunIdRef.current = serverRunId;

          const sid = sessionIdRef.current;
          if (sid) void loadSession(sid);
          // An extension-injected agent may already have started before the
          // command's prompt_done. Keep that active stage visible and let its
          // agent_settled event perform the next completion transition.
          if (!sdkAgentActiveRef.current) {
            settleUiStage();
            if (sid) scheduleEventStreamClose(sid);
          }
        }
        break;
      case "prompt_error": {
        if (typeof rpcPromptPendingRef.current === "object" && !rpcPromptPendingRef.current.requestStarted) break;
        const serverRunId = typeof event.runId === "string" ? event.runId : undefined;
        if ((currentAgentRunIdRef.current && !serverRunId) || (serverRunId && currentAgentRunIdRef.current && serverRunId !== currentAgentRunIdRef.current)) break;
        if (serverRunId) currentAgentRunIdRef.current = serverRunId;
        if (!lastAgentErrorRef.current && !lastAgentAbortedRef.current) {
          onAgentError?.(typeof event.unattended === "boolean" ? event.unattended : undefined, serverRunId);
        }
        lastAgentErrorRef.current = true;
        addNotice({ type: "error", message: (event.errorMessage as string | undefined) ?? "Command failed" });
        break;
      }
      case "extension_error":
        addNotice({
          type: "error",
          message: (event.error as string | undefined) ?? "Extension command failed",
        });
        break;
      case "message_start":
      case "message_update": {
        // User message_start is also the live projection path for prompts
        // written by another Pi/runtime. Only late assistant/delta events are
        // ignored after a run has already been reconciled.
        const msg = event.type === "message_start" ? event.message as AgentMessage | undefined : undefined;
        const peerMessage = event.type === "message_start" && isSessionPeerAgentMessage(msg) ? msg : undefined;
        if (!agentRunningRef.current && msg?.role !== "user" && !peerMessage) break;
        transcriptMutationRevisionRef.current += 1;
        if (event.type === "message_start") {
          if (msg?.role === "user") {
            // The composer owns the pending row; message_end supplies its durable identity.
          } else if (peerMessage) {
            pendingPeerMessageIdsRef.current.add(peerMessage.details.messageId);
            if (activeToolIdsRef.current.size === 0) setAgentPhase(null);
          } else if (msg?.role === "assistant") {
            dispatch({ type: "snapshot", message: msg });
            if (msg.content.length > 0 && activeToolIdsRef.current.size === 0) setAgentPhase(null);
          } else if (msg && activeToolIdsRef.current.size === 0) {
            setAgentPhase(null);
          }
        } else {
          const delta = event.assistantMessageEvent as ClientAssistantMessageEvent | undefined;
          if (delta) {
            dispatch({ type: "delta", event: delta });
            if (delta.type !== "toolcall_start" && delta.type !== "toolcall_delta" && activeToolIdsRef.current.size === 0) {
              setAgentPhase(null);
            }
          }
        }
        break;
      }
      case "message_end": {
        // Same late-event guard: after reconcile finished this run,
        // loadSession already loaded this message from the session file —
        // appending it again would duplicate it.
        const completed = event.message as AgentMessage | undefined;
        if (completed?.role === "user" && typeof event.clientMessageId === "string") confirmPromptDelivery(event.clientMessageId);
        const completedPeer = isSessionPeerAgentMessage(completed) ? completed : undefined;
        if (!agentRunningRef.current && completed?.role !== "user" && !completedPeer) break;
        if (completedPeer) {
          const messageId = completedPeer.details.messageId;
          if (!pendingPeerMessageIdsRef.current.has(messageId) && !agentRunningRef.current) break;
          pendingPeerMessageIdsRef.current.delete(messageId);
        }
        transcriptMutationRevisionRef.current += 1;
        const followed = completed && typeof event.entryId === "string" && branchRef.current
          && canWriteBranch(branchRef.current.state) && reader.followPersistedTail();
        if (completed && typeof event.entryId === "string") reader.recordUnseenEntry(event.entryId);
        if (completed) appendMessage(normalizeToolCalls(completed), typeof event.entryId === "string" ? event.entryId : "", {
          orderKey: event.orderKey as HistoryOrderKey | undefined,
          clientMessageId: typeof event.clientMessageId === "string" ? event.clientMessageId : undefined,
        });
        if (followed) void reader.reconcileTail();
        if (completed?.role === "user") {
          const sid = sessionIdRef.current;
          if (sid) invalidateSessionDetailsForSession(sid);
        }

        dispatch({ type: "end" });
        if (activeToolIdsRef.current.size === 0) setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        // A call a tool made itself (a codemode script's) belongs to its
        // parent's card; listed here it would show as a top-level running tool,
        // and a call cut off by its script can end after the parent did.
        if (isNestedToolExecutionEvent(event)) break;
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        if (!activeToolIdsRef.current.has(id)) toolEventRevisionRef.current += 1;
        activeToolIdsRef.current.add(id);
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name });
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_update": {
        if (isNestedToolExecutionEvent(event)) break;
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        if (!activeToolIdsRef.current.has(id)) toolEventRevisionRef.current += 1;
        activeToolIdsRef.current.add(id);
        const partialResult = event.partialResult as Partial<ToolResultMessage> | undefined;
        const content = partialResult?.content;
        // Live output for shells; for codemode, the calls its script has made so far.
        if ((name === "bash" || name === "powershell" || name === CODEMODE_TOOL_NAME) && Array.isArray(content)) {
          setActiveToolResults((prev) => {
            const next = new Map(prev);
            next.set(id, {
              role: "toolResult",
              toolCallId: id,
              toolName: name,
              content,
              isError: partialResult?.isError,
              details: partialResult?.details,
            });
            return next;
          });
        }
        const progress = name === CODEMODE_TOOL_NAME
          ? getCodemodeProgress(event.partialResult)
          : getToolExecutionProgress(event.partialResult);
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          const existing = tools.find((tool) => tool.id === id);
          const updated = {
            id,
            name: name || existing?.name || "tool",
            progress: progress ?? existing?.progress,
          };
          return {
            kind: "running_tools",
            tools: [...tools.filter((tool) => tool.id !== id), updated],
          };
        });
        break;
      }
      case "tool_execution_end": {
        if (isNestedToolExecutionEvent(event)) break;
        const id = event.toolCallId as string;
        if (activeToolIdsRef.current.delete(id)) toolEventRevisionRef.current += 1;
        setActiveToolResults((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "fast_mode_changed": {
        const status = event.fastMode as FastModeStatus | undefined;
        if (status) {
          setFastModeSelection(status.mode);
          setFastModeRuntimeStatus(status);
        }
        break;
      }
      case "model_changed": {
        const m = event.model as { id: string; provider: string } | undefined;
        if (m) {
          setCurrentModelOverride({ provider: m.provider, modelId: m.id });
          const from = event.routedFrom as { provider: string; modelId: string } | undefined;
          const fromText = from ? `${from.provider}/${from.modelId}` : "";
          const toText = `${m.provider}/${m.id}`;
          const inheritText = event.inherited ? t("chat.modelRoutedInherited") : "";
          addNotice({
            type: "info",
            message: fromText
              ? t("chat.modelRoutedAfterErrors", { from: fromText, to: toText, inherited: inheritText })
              : t("chat.modelRouted", { to: toText, inherited: inheritText }),
          });
        }
        if (typeof event.thinkingLevel === "string") {
          setThinkingLevel(event.thinkingLevel as ThinkingLevelOption);
          thinkingLevelOverrideRef.current = event.thinkingLevel === "auto" ? null : (event.thinkingLevel as Exclude<ThinkingLevelOption, "auto">);
        }
        break;
      }
      case "queue_update": {
        syncQueuedDrafts(sessionIdRef.current, event.queueSnapshot, {
          steering: event.steering as string[] | undefined,
          followUp: event.followUp as string[] | undefined,
        });
        break;
      }
      case "unattended_state": {
        // The server scheduler decided something; keep local UI in sync so
        // the countdown reflects server-side timing even when this tab was
        // closed during the wait.
        if (event.configured !== false && pendingUnattendedRef.current === null && typeof event.enabled === "boolean") syncUnattendedEnabledRef.current?.(event.enabled);
        const state = event.state as SchedulerState | null;
        syncUnattendedStateRef.current?.(state);
        break;
      }
      case "auto_retry_start":
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_retry_end":
        setRetryInfo(null);
        break;
      case "auto_compaction_start":
      case "compaction_start":
        stateRunRevisionRef.current += 1;
        setIsCompacting(true);
        setCompactError(null);
        setCompactResult(null);
        break;
      case "auto_compaction_end":
      case "compaction_end":
        stateRunRevisionRef.current += 1;
        setIsCompacting(false);
        if (event.errorMessage) {
          setCompactError(event.errorMessage as string);
          setCompactResult(null);
        } else if (!event.aborted) {
          setCompactResult(readCompactResult(event.result, (event.reason as string | undefined) ?? "auto"));
          void reader.reconcileTail({ reconcileLoaded: true });
          if (sessionIdRef.current) {
            const sid = sessionIdRef.current;
            void loadSession(sid).then(() => refreshSessionCost(sid));
          }
        }
        break;
      case "extension_ui_request":
        handleExtensionUiRequest(event as ExtensionUiRequest);
        break;
      case "extension_ui_closed":
        setExtensionDialogs((queue) => removeExtensionUiRequest(queue, event.id as string));
        break;
    }
  }, [addNotice, appendMessage, apiPath, cancelEventStreamGrace, confirmPromptDelivery, dispatch, handleExtensionUiRequest, invalidateSessionDetailsForSession, reader, loadAgentState, loadSession, notifyPromptStage, onAgentError, refreshSessionCost, restoreLoadedRunState, scrollToBottom, settleUiStage, syncQueuedDrafts, syncQueuedDraftResponse, t, updateMessages]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (message: string, images?: AttachedImage[], questionAnalysis?: QuestionAnalysisPromptMetadata) => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length) return;
    if (sessionStatePendingRef.current || agentRunningRef.current || bashRunningRef.current) {
      restoreSubmission(message, images, composerDraftKey);
      return;
    }
    const historyEditKey = session?.id ? cacheKeyForSession(session.id) : null;
    const storedHistoryEdit = session?.id ? getDraft(historyDraftKey(session.id, remotePeerRef.current))?.historyEdit : undefined;
    const pendingHistoryEdit = historyEditKey
      ? pendingHistoryEdits.get(historyEditKey) ?? (storedHistoryEdit
        ? { ...storedHistoryEdit, targetLeafId: storedHistoryEdit.entryId }
        : undefined)
      : undefined;
    const historyEditEntryId = editEntryId ?? pendingHistoryEdit?.entryId ?? null;
    if (historyEditEntryId && !pendingHistoryEdit) {
      restoreSubmission(message, images, composerDraftKey);
      addNotice({ type: "error", message: "The historical edit draft is unavailable; restore it before retrying." });
      return;
    }
    const isHistoricalEdit = Boolean(historyEditEntryId && pendingHistoryEdit);
    const isSlashCommandPrompt = !isHistoricalEdit && !images?.length && trimmedMessage.startsWith("/");

    const isBashCommand = !isHistoricalEdit && !images?.length && trimmedMessage.startsWith("!");
    if (isBashCommand) {
      const isExcluded = trimmedMessage.startsWith("!!");
      const bashCmd = (isExcluded ? trimmedMessage.slice(2) : trimmedMessage.slice(1)).trim();
      if (!bashCmd) {
        restoreSubmission(message, images, composerDraftKey);
        return;
      }
      await executeBashRef.current?.(bashCmd, isExcluded);
      return;
    }

    const promptRunId = promptRunIdRef.current + 1;
    stateRunRevisionRef.current += 1;
    cancelEventStreamGrace();

    const clientId = pendingHistoryEdit?.clientMessageId ?? crypto.randomUUID();
    if (isHistoricalEdit && historyEditEntryId && historyEditKey && pendingHistoryEdit && pendingHistoryEdit.clientMessageId !== clientId) {
      setEdit(historyEditEntryId, pendingHistoryEdit.targetLeafId, clientId);
    }
    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = withOccurrence({
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    }, clientId, clientId);
    const scope = branchScopeRef.current, peer = remotePeerRef.current;
    const submission = { runId: promptRunId, requestStarted: false, stopping: false, cancel: () => {
      if (!isHistoricalEdit) updateMessages((current) => removeMessage(current, userMsg));
      restoreSubmission(message, images, composerDraftKey);
    } };
    const isCurrentSubmission = () => sessionHookMountedRef.current && branchScopeRef.current === scope
      && remotePeerRef.current === peer && promptRunIdRef.current === promptRunId;
    const ownsSubmission = () => isCurrentSubmission() && rpcPromptPendingRef.current === submission && !submission.stopping;
    rpcPromptPendingRef.current = submission;
    if (!isHistoricalEdit) appendMessage(userMsg, "", { clientMessageId: clientId });
    promptRunIdRef.current = promptRunId;
    agentRunningRef.current = true;
    setAgentRunning(true);
    setAgentPhase(isSlashCommandPrompt ? { kind: "running_command" } : { kind: "waiting_model" });
    dispatch({ type: "start" });
    pendingScrollToUserRef.current = true;
    setPromptAnchorActive(true);

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    let sentSessionId: string | null = null;
    let delivery: PromptDelivery | null = null;
    const beginDelivery = (sid: string): PromptDelivery => {
      submission.requestStarted = true;
      const current = {
        clientMessageId: clientId,
        sessionId: sid,
        peer: peer ?? null,
        runId: promptRunId,
        confirmed: false,
        ...(isHistoricalEdit && historyEditEntryId ? { historyEditEntryId } : {}),
      };
      promptDeliveriesRef.current.set(clientId, current);
      return current;
    };
    const acceptDelivery = (current: PromptDelivery | null) => {
      if (!current) return;
      current.confirmed = true;
      if (promptDeliveriesRef.current.get(clientId) === current) promptDeliveriesRef.current.delete(clientId);
    };

    try {
      if (isNew && newSessionCwd) {
        const selectedModel = newSessionModel;
        const existingSid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
        const sid = existingSid ?? await ensureNewSession();

        if (!ownsSubmission()) return;
        if (!sid) throw new Error("Unable to create a session for the prompt");
        sentSessionId = sid;
        if (selectedModel) {
          setPendingModel(selectedModel);
          if (existingSid) {
            await sendAgentCommandR(sid, { type: "set_model", provider: selectedModel.provider, modelId: selectedModel.modelId });
          }
        }
        if (!ownsSubmission()) return;
        try {
          await ensureEventsConnected(sid);
        } catch (streamError) {
          if (!isSessionMissingError(streamError)) throw streamError;
          console.error("Failed to connect new session events before prompt:", streamError);
        }
        const promptCommand = {
          type: "prompt",
          message,
          clientMessageId: clientId,
          ...(piImages?.length ? { images: piImages } : {}),
          ...(questionAnalysis ? { questionAnalysis: [questionAnalysis] } : {}),
        };
        try {
          // The draft may have been reclaimed between the last preflight call
          // and this send. Post first so the server can distinguish a
          // definitive session-missing rejection from an SSE/transport fault.
          if (!ownsSubmission() || sessionIdRef.current !== sid) return;
          delivery = beginDelivery(sid);
          await sendAgentCommandR(sid, promptCommand);
          acceptDelivery(delivery);
          if (rpcPromptPendingRef.current === submission) {
            rpcPromptPendingRef.current = true;
            stateRunRevisionRef.current += 1;
          }
        } catch (error) {
          if (!ownsSubmission()) {
            if (!delivery?.confirmed) throw error;
            return;
          }
          if (!isSessionMissingError(error) || newSessionPromotedRef.current) throw error;

          // The old id was never accepted. Create exactly one replacement
          // draft, atomically move the client ref, then submit once to the new
          // runtime. Generic 4xx/5xx and transport failures never enter this
          // branch and therefore are not replayed.
          sessionIdRef.current = null;
          sentSessionId = null;
          promptDeliveriesRef.current.delete(clientId);
          delivery = null;
          submission.requestStarted = false;
          const recoveredSid = await ensureNewSession();
          if (!ownsSubmission()) return;
          if (!recoveredSid) throw error;
          sentSessionId = recoveredSid;
          try {
            await ensureEventsConnected(recoveredSid);
          } catch (streamError) {
            throw streamError;
          }
          if (!ownsSubmission() || sessionIdRef.current !== recoveredSid) return;
          delivery = beginDelivery(recoveredSid);
          await sendAgentCommandR(recoveredSid, promptCommand);
          acceptDelivery(delivery);
          if (rpcPromptPendingRef.current === submission) {
            rpcPromptPendingRef.current = true;
            stateRunRevisionRef.current += 1;
          }
        }
        if (!isCurrentSubmission()) return;
        if (sentSessionId) {
          try {
            await ensureEventsConnected(sentSessionId);
          } catch (streamError) {
            // SSE is the primary completion path, but a missing/late stream
            // must not strand the accepted prompt; reconcile from server state.
            console.error("Failed to connect new session events:", streamError);
            void reconcileAgentState(sentSessionId);
          }
        }
        if (!isCurrentSubmission()) return;
        await promoteNewSession(1, message);
      } else if (session) {
        sentSessionId = session.id;
        await ensureEventsConnected(session.id);
        if (!ownsSubmission() || sessionIdRef.current !== session.id) return;
        delivery = beginDelivery(session.id);
        const result = await sendAgentCommandR<{ accepted?: boolean; duplicate?: boolean; parentId?: string | null; leafId?: string | null }>(session.id,
          isHistoricalEdit
            ? {
                type: "edit_history",
                targetEntryId: historyEditEntryId,
                expectedLeafId: branchRef.current?.state.runtimeLeafId ?? null,
                message,
                clientMessageId: clientId,
                ...(piImages?.length ? { images: piImages } : {}),
              }
            : {
                type: "prompt",
                message,
                clientMessageId: clientId,
                ...(piImages?.length ? { images: piImages } : {}),
                ...(questionAnalysis ? { questionAnalysis: [questionAnalysis] } : {}),
              });
        const submissionStillCurrent = isCurrentSubmission();
        acceptDelivery(delivery);
        if (isHistoricalEdit && submissionStillCurrent) {
          const acknowledgedLeafId = result?.leafId !== undefined ? result.leafId : result?.parentId;
          if (acknowledgedLeafId !== undefined) {
            branchRef.current?.observeRuntime(acknowledgedLeafId);
            setActiveLeafId(acknowledgedLeafId);
            reader.followPersistedTail();
          }
          if (historyEditKey && pendingHistoryEdits.get(historyEditKey)?.clientMessageId === clientId) setEdit(null);
        }
        if (submissionStillCurrent && rpcPromptPendingRef.current === submission) {
          rpcPromptPendingRef.current = true;
          stateRunRevisionRef.current += 1;
        }
      } else {
        throw new Error("No active session for the prompt");
      }
      if (isSlashCommandPrompt && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
      }
    } catch (e) {
      const definitivelyRejected = !submission.requestStarted || isPromptRejectedError(e) || isSubprojectAssignmentError(e);
      if (delivery && definitivelyRejected) {
        if (promptDeliveriesRef.current.get(clientId) === delivery) promptDeliveriesRef.current.delete(clientId);
      } else if (delivery && !delivery.confirmed && sessionHookMountedRef.current) {
        const uncertain = delivery;
        setUnconfirmedPrompts((previous) => previous.includes(uncertain) ? previous : [...previous, uncertain]);
      }
      if (!isCurrentSubmission() || (!submission.requestStarted && !ownsSubmission())) return;
      console.error("Failed to send message:", e);
      if (isSubprojectAssignmentError(e)) {
        rpcPromptPendingRef.current = false;
        addNotice({ type: "error", message: e.message });
        if (sentSessionId) {
          void reconcileAgentState(sentSessionId);
          return;
        }
      }
      // A transport/proxy failure after dispatch is ambiguous: the server may
      // have accepted the prompt before the response was lost. Keep SSE alive
      // as the sole completion path.
      if (!definitivelyRejected && sentSessionId) {
        if (isHistoricalEdit) {
          restoreSubmission(message, images, composerDraftKey);
          addNotice({ type: "error", message: "Historical edit outcome is unconfirmed; the draft was kept and the request was not retried." });
        }
        if (rpcPromptPendingRef.current === submission) {
          rpcPromptPendingRef.current = true;
          stateRunRevisionRef.current += 1;
        }
        return;
      }
      rpcPromptPendingRef.current = false;
      if (!isHistoricalEdit) updateMessages((current) => removeMessage(current, userMsg));
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      restoreSubmission(message, images, composerDraftKey);
      // A rejected prompt is never replayed. Recover the confirmed cursor and
      // reconcile idle/busy truth so an optimistic waiting indicator can settle.
      if (sentSessionId) {
        if (isBranchPositionError(e)) await recoverBranchPosition(sentSessionId);
        await reconcileAgentState(sentSessionId);
        return;
      }
      agentRunningRef.current = false;
      sessionRunningRef.current = false;
      closeEvents();
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
    }
  }, [appendMessage, dispatch, isNew, newSessionCwd, newSessionModel, session, remotePeer, ensureNewSession, ensureEventsConnected, promoteNewSession, sendAgentCommandR, waitForPromptSettlement, addNotice, cancelEventStreamGrace, closeEvents, composerDraftKey, reconcileAgentState, recoverBranchPosition, restoreSubmission, cacheKeyForSession, editEntryId, reader, setEdit, updateMessages]);

  const handleRetryContinue = useCallback(async () => {
    const sid = sessionIdRef.current ?? session?.id ?? null;
    if (!sid || agentRunningRef.current || bashRunningRef.current) return;
    const retryPeer = remotePeerRef.current ?? null;
    const retryEntryId = latestRetryErrorEntry(messagesRef.current, entryIdsRef.current);

    const promptRunId = promptRunIdRef.current + 1;
    stateRunRevisionRef.current += 1;
    cancelEventStreamGrace();
    const scope = branchScopeRef.current;
    const submission = { runId: promptRunId, requestStarted: false, stopping: false };
    rpcPromptPendingRef.current = submission;
    promptRunIdRef.current = promptRunId;
    const ownsSubmission = () => sessionHookMountedRef.current && branchScopeRef.current === scope
      && remotePeerRef.current === retryPeer && sessionIdRef.current === sid
      && promptRunIdRef.current === promptRunId && rpcPromptPendingRef.current === submission && !submission.stopping;
    agentRunningRef.current = true;
    setAgentRunning(true);
    setAgentPhase({ kind: "waiting_model" });
    dispatch({ type: "start" });

    try {
      await ensureEventsConnected(sid);
      if (!ownsSubmission()) return;
      submission.requestStarted = true;
      await sendAgentCommandR(sid, { type: "retry_continue" });
      if (rpcPromptPendingRef.current === submission) {
        rpcPromptPendingRef.current = true;
        stateRunRevisionRef.current += 1;
      }
      onRetryContinueStartedRef.current?.({ sessionId: sid, peer: retryPeer, entryId: retryEntryId });
    } catch (e) {
      if (!sessionHookMountedRef.current || branchScopeRef.current !== scope || remotePeerRef.current !== retryPeer
        || sessionIdRef.current !== sid || promptRunIdRef.current !== promptRunId
        || (!submission.requestStarted && !ownsSubmission())) return;
      console.error("Failed to retry continue:", e);
      // A local branch/preflight rejection never reached the server, so it must
      // restore the idle UI instead of taking the ambiguous SSE-only path.
      if (isPromptRejectedError(e)) {
        submission.requestStarted = false;
      }
      // The POST may have reached the server before its response failed.
      if (submission.requestStarted) {
        if (rpcPromptPendingRef.current === submission) {
          rpcPromptPendingRef.current = true;
          stateRunRevisionRef.current += 1;
        }
        return;
      }
      rpcPromptPendingRef.current = false;
      agentRunningRef.current = false;
      sessionRunningRef.current = false;
      closeEvents();
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
    }
  }, [cancelEventStreamGrace, closeEvents, dispatch, ensureEventsConnected, sendAgentCommandR, session]);

  const executeBash = useCallback(async (command: string, excludeFromContext: boolean) => {
    if (agentRunningRef.current || bashRunningRef.current) return;
    const generation = newSessionLifecycleGenerationRef.current;
    const peer = remotePeerRef.current;
    const owns = () => sessionHookMountedRef.current && newSessionLifecycleGenerationRef.current === generation
      && remotePeerRef.current === peer;
    const inputText = `${excludeFromContext ? "!!" : "!"}${command}`;
    bashRunningRef.current = true;
    setPendingBash({ command, excludeFromContext });
    setBashRunning(true);
    try {
      const sid = sessionIdRef.current ?? session?.id ?? await ensureNewSession();
      if (!owns()) return;
      if (!sid) throw new Error("Unable to create a session for the shell command");
      await sendAgentCommandR(sid, {
        type: "bash",
        command,
        excludeFromContext,
      });
      if (!owns() || sessionIdRef.current !== sid) return;
      await loadSession(sid);
      if (!owns() || sessionIdRef.current !== sid) return;
      await promoteNewSession(1, inputText);
    } catch (e) {
      if (!owns()) return;
      console.error("Failed to execute shell command:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      if (!isSubprojectAssignmentError(e)) restoreSubmission(inputText, undefined, composerDraftKey);
    } finally {
      if (owns()) {
        bashRunningRef.current = false;
        setPendingBash(null);
        setBashRunning(false);
      }
    }
  }, [addNotice, composerDraftKey, ensureNewSession, loadSession, promoteNewSession, restoreSubmission, sendAgentCommandR, session]);
  executeBashRef.current = executeBash;

  const handleAbort = useCallback(async () => {
    const runId = promptRunIdRef.current, scope = branchScopeRef.current, peer = remotePeerRef.current;
    const pending = rpcPromptPendingRef.current;
    if (typeof pending === "object" && pending.stopping) return;
    const preparing = typeof pending === "object" && !pending.requestStarted;
    if (preparing) {
      pending.stopping = true;
      pending.cancel?.();
    }
    const sid = sessionIdRef.current;
    if (!sid) { if (preparing) settleUiStage(); return; }
    const serverRunId = currentAgentRunIdRef.current;
    const ownsStop = () => sessionHookMountedRef.current && sessionIdRef.current === sid && branchScopeRef.current === scope
      && remotePeerRef.current === peer && promptRunIdRef.current === runId && currentAgentRunIdRef.current === serverRunId;
    const abortingBash = bashRunningRef.current;
    try {
      await sendAgentCommandR(sid, { type: abortingBash ? "abort_bash" : "abort" });
      if (!ownsStop()) return;
      if (abortingBash) {
        bashRunningRef.current = false;
        setPendingBash(null);
        setBashRunning(false);
      }
      setIsCompacting(false);
      settleUiStage();
    } catch (e) {
      if (preparing && ownsStop()) settleUiStage();
      console.error(abortingBash ? "Failed to abort bash:" : "Failed to abort:", e);
    }
  }, [sendAgentCommandR, settleUiStage]);

  const handleFork = useCallback(async (entryId: string) => {
    if (bashRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    const scope = branchScopeRef.current;
    const peer = remotePeerRef.current;
    const generation = newSessionLifecycleGenerationRef.current;
    const owns = () => sessionHookMountedRef.current && sessionIdRef.current === sid
      && branchScopeRef.current === scope && remotePeerRef.current === peer
      && newSessionLifecycleGenerationRef.current === generation;
    setForkingEntryId(entryId);
    try {
      const result = await sendAgentCommandR<{
        cancelled?: boolean;
        newSessionId?: string;
        newSessionPath?: string;
        restoreMessage?: UserMessage;
        subprojectAssignmentFailed?: boolean;
      }>(sid, {
        type: "fork",
        entryId,
      });
      if (!owns()) return;
      const { cancelled, newSessionId, newSessionPath, restoreMessage, subprojectAssignmentFailed } = result ?? {};
      if (!cancelled) {
        if (subprojectAssignmentFailed) addNotice({ type: "error", message: "Fork created, but its subproject assignment could not be copied." });
        if (restoreMessage?.role === "user") {
          onSessionForked?.({ restoreMessage });
        } else if (newSessionId) {
          onSessionForked?.({ newSessionId, newSessionPath, subprojectAssignmentFailed });
        }
      }
    } catch (e) {
      if (owns()) {
        console.error("Fork failed:", e);
        addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      if (owns()) setForkingEntryId(null);
    }
  }, [addNotice, onSessionForked, sendAgentCommandR]);

  const navigateBranch = useCallback(async (sid: string, leafId: string | null, beforeEntryId?: string): Promise<boolean> => {
    if (branchRef.current!.state.phase === "unknown" && !await recoverBranchPosition(sid)) return false;
    const result = await branchRef.current!.navigate(
      beforeEntryId === undefined ? leafId : undefined,
      () => sendAgentCommandR<{ cancelled?: boolean; leafId?: string | null; expectedLeafId?: string | null }>(sid, {
        type: "navigate_tree",
        targetId: beforeEntryId ?? leafId,
        ...(beforeEntryId === undefined ? {} : { before: true }),
      }),
      (acknowledgedLeafId, isCurrent) => loadContext(sid, acknowledgedLeafId, isCurrent),
    );
    if (!result || result.cancelled) {
      if (branchRef.current!.state.phase === "unknown") void recoverBranchPosition(sid);
      return false;
    }
    setActiveLeafId(result.leafId);
    return true;
  }, [loadContext, recoverBranchPosition, sendAgentCommandR]);

  const handleNavigate = useCallback(async (entryId: string | null): Promise<boolean> => {
    if (bashRunningRef.current) return false;
    const sid = sessionIdRef.current;
    if (!sid) return false;
    try {
      return await navigateBranch(sid, entryId);
    } catch {
      return false;
    }
  }, [navigateBranch]);

  handleNavigateRef.current = handleNavigate;

  const handleLeafChange = useCallback(async (leafId: string | null, beforeEntryId?: string): Promise<boolean> => {
    if (bashRunningRef.current || agentRunningRef.current || isCompacting) return false;
    const sid = sessionIdRef.current;
    if (!sid) return false;
    try {
      return await navigateBranch(sid, leafId, beforeEntryId);
    } catch {
      // BranchNavigation keeps the last confirmed position and fails closed.
      return false;
    }
  }, [isCompacting, navigateBranch]);

  const updateRuntimeSettings = useCallback(async (
    command: Record<string, unknown>,
    apply: (result: unknown) => void,
  ) => {
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid || modelSwitchPendingRef.current) return;
    const peer = remotePeerRef.current;
    const revision = ++runtimeSettingsRevisionRef.current;
    const isCurrent = () => sessionHookMountedRef.current && sessionIdRef.current === sid && remotePeerRef.current === peer && revision === runtimeSettingsRevisionRef.current;
    modelSwitchPendingRef.current = true;
    setRuntimeSettingsUpdating(true);
    if (command.type === "set_model") setModelSwitching(true);
    try {
      const result = await sendAgentCommandR(sid, command);
      if (!isCurrent()) return;
      apply(result);
      if (agentRunningRef.current) addNotice({ type: "info", message: t("chat.runtimeSettingsUpdated") });
    } catch (error) {
      if (!isCurrent()) return;
      addNotice({ type: "error", message: `Failed to update runtime settings: ${error instanceof Error ? error.message : String(error)}` });
      try {
        const state = await sendAgentCommandR<AgentStateResponse>(sid, { type: "get_state" });
        if (!isCurrent()) return;
        if (state.model) {
          const actual = { provider: state.model.provider, modelId: state.model.id };
          setCurrentModelOverride(actual);
          if (isNew) setNewSessionModel(actual);
        }
        if (state.thinkingLevel) {
          const actualLevel = asConcreteThinkingLevel(state.thinkingLevel);
          if (actualLevel) setThinkingLevel(actualLevel);
          setCurrentThinkingOverride(actualLevel);
        }
        if (state.fastMode) {
          setFastModeSelection(state.fastMode.mode);
          setFastModeRuntimeStatus(state.fastMode);
        }
      } catch { /* Keep the last confirmed configuration, not a speculative success. */ }
    } finally {
      if (revision === runtimeSettingsRevisionRef.current) {
        modelSwitchPendingRef.current = false;
        setRuntimeSettingsUpdating(false);
        setModelSwitching(false);
      }
    }
  }, [addNotice, isNew, sendAgentCommandR, t]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    const target = { provider, modelId };
    const level = resolveDefaultThinkingLevel(modelThinkingLevels[`${provider}:${modelId}`], modelThinkingLevelDefaults[`${provider}/${modelId}`], modelThinkingLevelPins[`${provider}/${modelId}`]);
    if (isNew && !sessionIdRef.current && !ensuringNewSessionRef.current) {
      newSessionModelOverrideRef.current = target;
      setNewSessionModel(target);
      setPendingModel(target);
      thinkingLevelOverrideRef.current = asConcreteThinkingLevel(level);
      setThinkingLevel(level ?? "auto");
      setNewSessionThinkingLevel(asConcreteThinkingLevel(level));
      setFastModeRuntimeStatus(null);
      return;
    }
    await updateRuntimeSettings({ type: "set_model", provider, modelId }, (value) => {
      const result = value as { thinkingLevel?: ThinkingLevelOption; fastMode?: FastModeStatus };
      setCurrentModelOverride(target);
      setPendingModel(target);
      if (isNew) { newSessionModelOverrideRef.current = target; setNewSessionModel(target); }
      if (result.thinkingLevel) {
        setThinkingLevel(result.thinkingLevel);
        setLiveThinkingLevel(asConcreteThinkingLevel(result.thinkingLevel));
        setCurrentThinkingOverride(null);
        if (isNew) setNewSessionDefaultThinkingLevel(asConcreteThinkingLevel(result.thinkingLevel));
      }
      setFastModeRuntimeStatus(result.fastMode ?? null);
    });
  }, [isNew, modelThinkingLevelDefaults, modelThinkingLevelPins, modelThinkingLevels, updateRuntimeSettings]);

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompacting || localCompactionPendingRef.current) return;
    localCompactionPendingRef.current = true;
    stateRunRevisionRef.current += 1;
    setIsCompacting(true);
    setCompactError(null);
    setCompactResult(null);
    try {
      const result = await sendAgentCommandR<CompactCommandResult>(sid, { type: "compact" });
      setCompactResult(readCompactResult(result, "manual"));
      await loadSession(sid, true);
      await refreshSessionCost(sid);
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : String(e));
      setCompactResult(null);
    } finally {
      localCompactionPendingRef.current = false;
      stateRunRevisionRef.current += 1;
      setIsCompacting(false);
    }
  }, [isCompacting, loadSession, refreshSessionCost, sendAgentCommandR]);

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    const revision = ++modelListRequestRevisionRef.current;
    const ownerScope = branchScopeRef.current;
    const ownerPeer = remotePeerRef.current;
    const isCurrentResponse = () => sessionHookMountedRef.current
      && branchScopeRef.current === ownerScope && remotePeerRef.current === ownerPeer
      && modelListRequestRevisionRef.current === revision && !signal?.aborted;
    const modelCwd = newSessionCwd ?? session?.cwd ?? "";
    const modelsUrl = modelCwd ? apiPath(`models?cwd=${encodeURIComponent(modelCwd)}`) : apiPath("models");
    try {
      const res = await fetch(modelsUrl, signal ? { signal } : undefined);
      if (!isCurrentResponse()) return;
      if (!res.ok) {
        let body: ModelsResponse | undefined;
        try {
          body = await res.json() as ModelsResponse;
        } catch (error) {
          if (signal?.aborted) throw error;
        }
        if (!isCurrentResponse()) return;
        const message = body?.modelError?.message
          ?? body?.error
          ?? `Failed to load models (HTTP ${res.status})`;
        setModelNames(body?.models ?? {});
        setModelError(body?.modelError ?? {
          code: "MODEL_REQUEST_FAILED",
          message,
        });
        setModelScopeWarnings(body?.modelScopeWarnings ?? []);
        setModelThinkingLevels(body?.thinkingLevels ?? {});
        setModelThinkingLevelMaps(body?.thinkingLevelMaps ?? {});
        setModelThinkingLevelPins(body?.thinkingLevelPins ?? {});
        setModelThinkingLevelDefaults(body?.thinkingLevelDefaults ?? {});
        setModelList(body?.modelList ?? []);
        if (isNew) setNewSessionDefaultModel(null);
        throw new Error(message);
      }
      const d = await res.json() as ModelsResponse;
      signal?.throwIfAborted();
      if (!isCurrentResponse()) return;
      setModelNames(d.models ?? {});
      setModelError(d.modelError ?? null);
      setModelScopeWarnings(d.modelScopeWarnings ?? []);
      setModelThinkingLevels(d.thinkingLevels ?? {});
      setModelThinkingLevelMaps(d.thinkingLevelMaps ?? {});
      setModelThinkingLevelPins(d.thinkingLevelPins ?? {});
      setModelThinkingLevelDefaults(d.thinkingLevelDefaults ?? {});
      const nextModelList = d.modelList ?? [];
      setModelList(nextModelList);
      setSavedDefaultThinkingLevel(asConcreteThinkingLevel(d.savedDefaultThinkingLevel));
      const displayDefaultModel = d.defaultModel
        ? nextModelList.find((m) => m.id === d.defaultModel?.modelId && m.provider === d.defaultModel?.provider)
        : undefined;
      setNewSessionDefaultModel(displayDefaultModel ? { provider: displayDefaultModel.provider, modelId: displayDefaultModel.id } : null);
      const defaultReference = displayDefaultModel && `${displayDefaultModel.provider}/${displayDefaultModel.id}`;
      const effectiveDefaultThinking = displayDefaultModel
        ? resolveDefaultThinkingLevel(d.thinkingLevels?.[`${displayDefaultModel.provider}:${displayDefaultModel.id}`],
            defaultReference ? d.thinkingLevelDefaults?.[defaultReference] : undefined,
            defaultReference ? d.thinkingLevelPins?.[defaultReference] : undefined)
        : asConcreteThinkingLevel(d.defaultThinkingLevel);
      setNewSessionDefaultThinkingLevel(asConcreteThinkingLevel(effectiveDefaultThinking));
      if (isNew && !sessionIdRef.current) {
        const displayModel = d.defaultModel
          ? nextModelList.find((m) => m.id === d.defaultModel?.modelId && m.provider === d.defaultModel?.provider)
          : undefined;
        // An `enabledModels` pattern may pin a thinking level (`anthropic/*:high`).
        // Without a pin, use the selected model's strongest supported level.
        const reference = displayModel && `${displayModel.provider}/${displayModel.id}`;
        const pinned = reference ? d.thinkingLevelPins?.[reference] : undefined;
        const modelDefault = displayModel
          ? resolveDefaultThinkingLevel(
              d.thinkingLevels?.[`${displayModel.provider}:${displayModel.id}`],
              reference ? d.thinkingLevelDefaults?.[reference] : undefined,
              pinned,
            )
          : null;
        if (thinkingLevelOverrideRef.current === null) {
          // Reader local patch: show the effective level for new sessions — the
          // model default/max instead of a bare "auto".
          setThinkingLevel(
            modelDefault
              ?? (d.defaultThinkingLevel as ThinkingLevelOption | undefined)
              ?? "auto",
          );
        }
      }
    } catch (error) {
      if (!isCurrentResponse()) return;
      if (!signal?.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
        setModelError({
          code: "MODEL_REQUEST_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }, [apiPath, isNew, newSessionCwd, session?.cwd]);

  // Picking a model or reasoning level is session-scoped, as in the TUI. The
  // selectors' star is the explicit Ctrl+S equivalent: it saves the global
  // default new sessions start with and also selects it for this chat.
  const saveDefaultPreferences = useCallback(async (
    edit: { provider: string; modelId: string } | { thinkingLevel: ConcreteThinkingLevel },
  ) => {
    const cwd = newSessionCwd ?? session?.cwd;
    const res = await fetch(apiPath("models/default"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(cwd ? { cwd } : {}), ...edit }),
    });
    if (res.ok) return;
    let detail = "";
    try {
      const body: unknown = await res.json();
      if (body && typeof body === "object" && "error" in body && typeof body.error === "string") detail = body.error;
    } catch {
      // Non-JSON error responses fall back to the HTTP status.
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }, [apiPath, newSessionCwd, session?.cwd]);

  const reloadModelsQuietly = useCallback(() => {
    // The star already updated the marker; a failed refresh keeps the old list.
    loadModels().catch(() => {});
  }, [loadModels]);

  const handleSetDefaultModel = useCallback(async (provider: string, modelId: string) => {
    const ownerScope = branchScopeRef.current;
    const ownerPeer = remotePeerRef.current;
    const isCurrent = () => sessionHookMountedRef.current
      && branchScopeRef.current === ownerScope && remotePeerRef.current === ownerPeer;
    try {
      await saveDefaultPreferences({ provider, modelId });
    } catch (e) {
      if (!isCurrent()) return;
      addNotice({ type: "error", message: `Failed to save default model: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    if (!isCurrent()) return;
    addNotice({ type: "success", message: `Default model: ${provider}/${modelId}` });
    setNewSessionDefaultModel({ provider, modelId });
    if (displayModel?.provider !== provider || displayModel?.modelId !== modelId) {
      await handleModelChange(provider, modelId);
    }
    if (isCurrent()) reloadModelsQuietly();
  }, [addNotice, displayModel, handleModelChange, reloadModelsQuietly, saveDefaultPreferences]);

  const handleBuiltinSlashCommand = useCallback(async (text: string): Promise<BuiltinSlashCommandResult> => {
    const ownerScope = branchScopeRef.current;
    const ownerPeer = remotePeerRef.current;
    if (!text.startsWith("/")) return { handled: false };
    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return { handled: false };

    const [, commandName, rawArgs = ""] = match;
    const args = rawArgs.trim();
    const sid = sessionIdRef.current ?? await ensureNewSession();
    const complete = (result: BuiltinSlashCommandResult): BuiltinSlashCommandResult => {
      if (!result.handled) return result;
      if (result.error) {
        addNotice({ type: "error", message: result.error });
      } else if (!result.action) {
        // A command that opens a panel says nothing: the panel is the answer.
        addNotice({ type: "success", message: result.message ?? "Command completed" });
      }
      return result;
    };

    let ownsCompaction = false;
    try {
      switch (commandName) {
        case "compact": {
          if (!sid || isCompacting || localCompactionPendingRef.current) return complete({ handled: true, error: "No active session to compact" });
          localCompactionPendingRef.current = true;
          ownsCompaction = true;
          stateRunRevisionRef.current += 1;
          setIsCompacting(true);
          setCompactError(null);
          setCompactResult(null);
          const result = await sendAgentCommandR<CompactCommandResult>(sid, {
            type: "compact",
            ...(args ? { customInstructions: args } : {}),
          });
          setCompactResult(readCompactResult(result, "manual"));
          if (await loadSession(sid, true)) await promoteNewSession();
          await refreshSessionCost(sid);
          return complete({ handled: true, message: "Compacted context" });
        }

        case "auto-compact": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const isCurrent = () => sessionHookMountedRef.current && sessionIdRef.current === sid
            && branchScopeRef.current === ownerScope && remotePeerRef.current === ownerPeer;
          const liveState = await sendAgentCommandR<AgentStateResponse>(sid, { type: "get_state" });
          if (!isCurrent()) return { handled: false };
          if (typeof liveState?.autoCompactionEnabled !== "boolean") throw new Error("Automatic compaction preference is unavailable");
          const nextEnabled = !liveState.autoCompactionEnabled;
          await sendAgentCommandR(sid, { type: "set_auto_compaction", enabled: nextEnabled });
          if (!isCurrent()) return { handled: false };
          setAutoCompactionEnabled(nextEnabled);
          return complete({ handled: true, message: nextEnabled ? "Auto-compaction enabled" : "Auto-compaction disabled" });
        }

        case "reload": {
          if (!sid) return complete({ handled: true, error: "No active session to reload" });
          await sendAgentCommandR(sid, { type: "reload" });
          await Promise.all([
            loadSession(sid),
            loadAgentState(sid),
            loadTools(sid),
            loadSlashCommands(),
            loadModels(),
          ]);
          return complete({ handled: true, message: "Reloaded session resources" });
        }

        case "name": {
          if (!sid) return complete({ handled: true, error: "No active session to name" });
          if (!args) return complete({ handled: true, error: "Usage: /name <name>" });
          await sendAgentCommandR(sid, { type: "set_session_name", name: args });
          if (await loadSession(sid)) await promoteNewSession();
          return complete({ handled: true, message: `Session renamed to ${args}` });
        }

        case "session": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          void refreshSessionTiming(sid);
          await refreshSessionStats(sid);
          onSessionStatsPanelOpen?.();
          return complete({ handled: true, action: "openSessionStats" });
        }

        case "mcp": {
          // Only a bare /mcp, and only when pi's built-in MCP extension owns it or
          // nothing does (lib/mcp-command.ts): another extension's /mcp is sent as
          // before, and so is every subcommand, since `/mcp login`, `logout` and
          // `reconnect` act on this session's own connections. Returning before
          // onSend leaves no "/mcp" bubble and no sidebar row for a new chat; a
          // streaming run is not touched.
          if (args || !onOpenSettings) return { handled: false };
          const commands = await slashCommandsForMcp();
          if (!sessionHookMountedRef.current || branchScopeRef.current !== ownerScope || remotePeerRef.current !== ownerPeer
            || !commands || !bareMcpOpensSettings(commands)) return { handled: false };
          onOpenSettings("mcp");
          return complete({ handled: true, action: "openSettings" });
        }

        case "copy": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const data = await sendAgentCommandR<LastAssistantTextResponse>(sid, { type: "get_last_assistant_text" });
          const textToCopy = data?.text ?? "";
          if (!textToCopy) return complete({ handled: true, error: "No assistant message to copy" });
          await navigator.clipboard.writeText(textToCopy);
          return complete({ handled: true, message: "Copied last assistant message" });
        }

        case "clone": {
          if (!sessionIdRef.current) return complete({ handled: true, error: "No active session to clone" });
          if (agentRunningRef.current || bashRunningRef.current || isCompacting) {
            return complete({ handled: true, error: "Cannot clone while the session is running" });
          }
          const result = await sendAgentCommandR<{ cancelled?: boolean; newSessionId?: string; newSessionPath?: string; subprojectAssignmentFailed?: boolean }>(sid!, {
            type: "clone",
            leafId: activeLeafId,
          });
          if (result?.cancelled || !result?.newSessionId) {
            return complete({ handled: true, error: "Cannot clone an empty or unsaved session" });
          }
          if (result.subprojectAssignmentFailed) addNotice({ type: "error", message: "Clone created, but its subproject assignment could not be copied." });
          const completed = complete({ handled: true, message: "Cloned current session branch" });
          onSessionForked?.({ newSessionId: result.newSessionId, newSessionPath: result.newSessionPath, subprojectAssignmentFailed: result.subprojectAssignmentFailed });
          return completed;
        }

        default:
          return { handled: false };
      }
    } catch (e) {
      return complete({ handled: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (ownsCompaction) {
        localCompactionPendingRef.current = false;
        stateRunRevisionRef.current += 1;
        setIsCompacting(false);
      }
    }
  }, [activeLeafId, addNotice, ensureNewSession, isCompacting, loadModels, loadSession, loadSlashCommands, loadTools, onSessionForked, promoteNewSession, onSessionStatsPanelOpen, refreshSessionCost, refreshSessionStats, refreshSessionTiming, sendAgentCommandR, onOpenSettings, slashCommandsForMcp]);

  // Let AgentSession.prompt decide atomically whether to queue against the
  // current run or start a new turn if it settled while the request was in
  // flight. Direct steer/followUp calls can strand a message in an idle queue.
  const sendStreamingPrompt = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
  ) => {
    const sid = sessionIdRef.current;
    const restore = () => restoreSubmission(message, images, composerDraftKey);
    if (sessionStatePendingRef.current || editEntryId) {
      restore();
      return;
    }
    if (!sid) {
      restore();
      addNotice({ type: "error", message: "No active session for the queued message" });
      return;
    }
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommandR(sid, {
        type: "prompt",
        message,
        clientMessageId: crypto.randomUUID(),
        streamingBehavior: behavior,
        requireQueueIdentity: true,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to submit streaming prompt:", e);
      // A transport failure after dispatch is ambiguous: the server may have
      // accepted the queued prompt before the response was lost. Restoring in
      // that case would invite a duplicate turn.
      if (isPromptRejectedError(e)) restore();
      addNotice({
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [addNotice, composerDraftKey, restoreSubmission, sendAgentCommandR, editEntryId]);

  const handleSteer = useCallback(async (message: string, images?: AttachedImage[]) => {
    await sendStreamingPrompt(message, "steer", images);
  }, [sendStreamingPrompt]);

  const handlePromptWithStreamingBehavior = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
  ) => {
    await sendStreamingPrompt(message, behavior, images);
  }, [sendStreamingPrompt]);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]) => {
    await sendStreamingPrompt(message, "followUp", images);
  }, [sendStreamingPrompt]);

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommandR(sid, { type: "abort_compaction" });
    } catch (e) {
      console.error("Failed to abort compaction:", e);
    }
  }, [sendAgentCommandR]);

  const handleAutoCompactionChange = useCallback(async (enabled: boolean) => {
    const ownerScope = branchScopeRef.current;
    const ownerPeer = remotePeerRef.current;
    let ownerSession = sessionIdRef.current;
    const generation = ++runtimeSettingsReadGenerationRef.current;
    const isCurrent = () => sessionHookMountedRef.current && branchScopeRef.current === ownerScope
      && generation === runtimeSettingsReadGenerationRef.current
      && remotePeerRef.current === ownerPeer && sessionIdRef.current === ownerSession;
    if (isNew && !sessionIdRef.current && !ensuringNewSessionRef.current) {
      autoCompactionOverrideRef.current = enabled;
      if (newSessionDraftKey) setDraft(newSessionDraftKey, { ...(getDraft(newSessionDraftKey) ?? { value: "", images: [] }), autoCompactionEnabled: enabled });
      setAutoCompactionEnabled(enabled);
      return;
    }
    setRuntimeSettingsRead({ status: "loading" });
    try {
      await sendTransientSessionCommand({
        sessionId: sessionIdRef.current,
        isNew,
        promoted: newSessionPromotedRef.current,
        ensureSession: ensureNewSession,
        resetSession: () => { sessionIdRef.current = null; },
        send: async (sid) => {
          ownerSession = sid;
          await sendAgentCommandR(sid, { type: "initialize_runtime" });
          if (!sessionHookMountedRef.current || branchScopeRef.current !== ownerScope
            || remotePeerRef.current !== ownerPeer || sessionIdRef.current !== sid) return;
          return sendAgentCommandR(sid, { type: "set_auto_compaction", enabled });
        },
      });
      if (isCurrent()) setAutoCompactionEnabled(enabled);
    } catch (error) {
      if (!isCurrent()) return;
      setRuntimeSettingsRead({ status: "error", error: error instanceof Error ? error.message : String(error) });
      addNotice({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [addNotice, ensureNewSession, isNew, newSessionDraftKey, sendAgentCommandR, setAutoCompactionEnabled]);

  const retryRuntimeSettings = useCallback(async () => {
    setRuntimeSettingsRead({ status: "loading" });
    const sid = sessionIdRef.current;
    if (!sid) {
      setSettingsRetryRevision((value) => value + 1);
      return;
    }
    const settlement = sessionSettlementGenerationRef.current;
    maintainEventsConnected(sid);
    const state = await loadAgentState(sid);
    restoreLoadedRunState(sid, state, settlement);
  }, [loadAgentState, maintainEventsConnected, restoreLoadedRunState]);

  const { view: queueRecoveryView, refresh: refreshQueueRecovery, ensureAvailable: ensureQueueRecoveryAvailable } = useQueueRecovery(session?.id ?? null, remotePeer ?? null, opts.chatInputRef, (operationId) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const key = cacheKeyForSession(sid);
    if (getQueueRecallOperation(key)?.operationId === operationId) {
      clearQueueRecallOperation(key);
      clearPendingQueueRecall(key);
      syncQueuedDrafts(sid, queuedDraftProjectionRef.current.snapshot);
    }
  }, (operationId) => {
    if (serverCopyOperationRef.current === operationId) {
      serverCopyOperationRef.current = null;
      setQueueRecallState(previous => previous === "server_copy" ? "idle" : previous);
    }
  }, serverCopyOperationRef);

  const handleRecallQueue = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || queueRecallInFlightRef.current) return;
    queueRecallInFlightRef.current = true;
    setQueueRecallState("recalling");
    const peer = remotePeerRef.current;
    const scope = branchScopeRef.current;
    const key = cacheKeyForSession(sid, peer);
    const queueGeneration = queuedDraftProjectionRef.current.generation;
    const savedOperation = getQueueRecallOperation(key);
    const expected = savedOperation?.expected ?? queuedDraftProjectionRef.current.snapshot;
    const pending = getPendingQueueRecall(key);
    // The ref is the composer owner. useImperativeHandle recreates its value
    // after ordinary renders, including our own recalling/busy state updates.
    const composerRef = opts.chatInputRef;
    let input = composerRef?.current;
    try {
      // The input was already durably saved. Retrying an ACK never clears or
      // prepends a second copy, even after reload or a lost ACK response.
      if (savedOperation?.restored) {
        setQueueRecallState("confirming");
        await sendAgentCommandR(sid, { type: "ack_queue_recall", queueRecallOperationId: savedOperation.operationId,
          expectedQueueIdentity: { bootId: savedOperation.expected.bootId, queueRevision: savedOperation.expected.queueRevision } });
        clearQueueRecallOperation(key);
        clearPendingQueueRecall(key);
        if (sessionHookMountedRef.current && sessionIdRef.current === sid && remotePeerRef.current === peer && branchScopeRef.current === scope) syncQueuedDrafts(sid, queuedDraftProjectionRef.current.snapshot);
        return;
      }
      if (!pending && !expected) throw new Error("This server does not provide queue item identities; update it before recalling queued attachments");
      const toRecall = pending ?? expected!;
      assertUserQueueRecall(toRecall);
      const count = queuedImageCount(toRecall);
      const alreadyRestored = savedOperation && input?.hasQueuedDraft(savedOperation.operationId);
      if (!alreadyRestored && count > 10) {
        throw new Error(`This batch contains ${count} images, exceeding the 10-image input limit even with an empty input. Let queued messages run before recalling. The queue is unchanged; no attachments are discarded.`);
      }
      if (!input || (!alreadyRestored && count > input.availableImageSlots())) {
        throw new Error(`The queued messages contain ${count} images and do not fit in the input. Remove attached images or let queued messages run before recalling them. The queue and input are unchanged.`);
      }
      let cleared = pending;
      if (!cleared) {
        // Recovery is required only when the user requests a destructive clear,
        // never as a reading prerequisite on an older peer.
        await ensureQueueRecoveryAvailable(sid, peer ?? null);
        if (!sessionHookMountedRef.current || sessionIdRef.current !== sid || remotePeerRef.current !== peer
          || branchScopeRef.current !== scope || opts.chatInputRef !== composerRef || !composerRef?.current) {
          throw Object.assign(new Error("The conversation changed; the queued messages were not cleared"), { notSent: true });
        }
        input = composerRef.current;
        const nowRestored = savedOperation && input.hasQueuedDraft(savedOperation.operationId);
        if (!nowRestored && count > input.availableImageSlots()) {
          throw Object.assign(new Error("The input changed and no longer has room for the queued attachments. The queue was not cleared."), { notSent: true });
        }
      }
      const operation = savedOperation ?? beginQueueRecallOperation(key, expected!);
      if (!cleared) {
        const result = await sendAgentCommandR<{ clearedQueue?: QueuedDraftState; queueSnapshot?: QueuedDraftState }>(sid, {
          type: "clear_queue",
          requireQueueIdentity: true,
          queueRecallOperationId: operation.operationId,
          expectedQueueIdentity: { bootId: expected!.bootId, queueRevision: expected!.queueRevision },
        });
        cleared = readQueuedDraftState(result?.clearedQueue);
        if (!cleared || cleared.bootId !== expected!.bootId || cleared.queueRevision !== expected!.queueRevision) {
          throw new Error("The server returned a different queue identity; the recalled messages could not be verified");
        }
        savePendingQueueRecall(key, cleared);
        if (sessionHookMountedRef.current && sessionIdRef.current === sid && remotePeerRef.current === peer && branchScopeRef.current === scope) {
          // An older clear response cannot erase an item enqueued during receipt persistence.
          const currentQueue = queuedDraftProjectionRef.current.snapshot;
          // A replay can belong to a previous runtime boot. Recover its items,
          // but never replace the new runtime's queue with the old empty view.
          syncQueuedDrafts(sid, currentQueue && result?.queueSnapshot?.bootId !== currentQueue.bootId
            ? currentQueue : result?.queueSnapshot, undefined, queueGeneration);
        }
      }
      const recalled = recalledQueuedDrafts(cleared);
      const text = recalled.map(message => message.text).filter(value => value.trim()).join("\n\n");
      const images = recalled.flatMap(message => message.images ?? []);
      const sameScope = sessionHookMountedRef.current && sessionIdRef.current === sid
        && remotePeerRef.current === peer && branchScopeRef.current === scope && opts.chatInputRef === composerRef;
      input = composerRef?.current;
      if (!sameScope || !input || !input.prependQueuedDraft(text, images, operation.operationId)) {
        if (sameScope) syncQueuedDrafts(sid, queuedDraftProjectionRef.current.snapshot);
        throw new Error("Recalled messages are saved for this session. Make room in the input, then use Queue recovery to restore or download the complete copy.");
      }
      if (!input.isQueuedDraftDurable(operation.operationId)) {
        // Large valid attachments can exceed localStorage's total quota. The
        // visible input is usable; the discoverable server copy stays durable.
        clearQueueRecallOperation(key);
        clearPendingQueueRecall(key);
        serverCopyOperationRef.current = operation.operationId;
        setQueueRecallState("server_copy");
        syncQueuedDrafts(sid, queuedDraftProjectionRef.current.snapshot);
        return;
      }
      markQueueRecallRestored(key);
      setQueueRecallState("confirming");
      await sendAgentCommandR(sid, { type: "ack_queue_recall", queueRecallOperationId: operation.operationId,
        expectedQueueIdentity: { bootId: expected!.bootId, queueRevision: expected!.queueRevision } });
      clearQueueRecallOperation(key);
      clearPendingQueueRecall(key);
      if (sessionHookMountedRef.current && sessionIdRef.current === sid && remotePeerRef.current === peer && branchScopeRef.current === scope) syncQueuedDrafts(sid, queuedDraftProjectionRef.current.snapshot);
    } catch (e) {
      console.error("Failed to recall queued messages:", e);
      // An ACK rejected after restoration cannot discard the original recovery
      // identity, or a later recall could append the same attachments again.
      if (e && typeof e === "object" && "accepted" in e && e.accepted === false
        && !getPendingQueueRecall(key) && !getQueueRecallOperation(key)?.restored) clearQueueRecallOperation(key);
      if (sessionHookMountedRef.current && sessionIdRef.current === sid && remotePeerRef.current === peer && branchScopeRef.current === scope
        && (queuedDraftProjectionRef.current.snapshot || getPendingQueueRecall(key) || getQueueRecallOperation(key))) {
        syncQueuedDrafts(sid, queuedDraftProjectionRef.current.snapshot);
      }
      if (sessionHookMountedRef.current && sessionIdRef.current === sid && remotePeerRef.current === peer && branchScopeRef.current === scope) {
        setQueueRecallState(getQueueRecallOperation(key)?.restored ? "confirm_retry" : "idle");
        addNotice({ type: "error", message: e instanceof Error ? e.message : "Failed to recall queued messages" });
      }
    } finally {
      queueRecallInFlightRef.current = false;
      if (sessionHookMountedRef.current && sessionIdRef.current === sid && remotePeerRef.current === peer && branchScopeRef.current === scope) setQueueRecallState(previous => previous === "recalling" || previous === "confirming" ? "idle" : previous);
      refreshQueueRecovery();
    }
  }, [addNotice, cacheKeyForSession, opts.chatInputRef, sendAgentCommandR, syncQueuedDrafts, refreshQueueRecovery, ensureQueueRecoveryAvailable]);

  // Continue button / unattended auto-continue controller.
  const handleSendContinue = useCallback(() => {
    void handleSend(CONTINUE_TEXT);
  }, [handleSend]);
  const {
    continueUi,
    unattended,
    toggleUnattended: toggleUnattendedLocal,
    triggerContinue,
    stopAutoRetry,
    syncUnattendedState,
    syncUnattendedEnabled,
  } = useContinueController({
    scopeKey: `${remotePeer ?? "local"}:${session?.id ?? "draft"}`,
    messages,
    agentRunning,
    isCompacting,
    onSendContinue: handleSendContinue,
    onRetryContinue: handleRetryContinue,
    onCompact: () => {
      void handleCompact();
    },
  });
  syncUnattendedStateRef.current = syncUnattendedState;
  syncUnattendedEnabledRef.current = syncUnattendedEnabled;

  const syncServerUnattendedState = useCallback(async (sid: string) => {
    const owner = branchScopeRef.current;
    try {
      const result = await sendAgentCommandR<{ enabled?: boolean; configured?: boolean; state?: SchedulerState | null }>(sid, { type: "get_unattended" });
      if (!sessionHookMountedRef.current || sessionIdRef.current !== sid || branchScopeRef.current !== owner) return;
      if (result?.configured && pendingUnattendedRef.current === null && typeof result.enabled === "boolean") syncUnattendedEnabledRef.current?.(result.enabled);
      syncUnattendedStateRef.current?.(result?.state ?? null);
    } catch (error) { console.error("Failed to load unattended state:", error); }
  }, [sendAgentCommandR]);
  const toggleUnattended = useCallback(() => {
    toggleUnattendedLocal();
    const enabled = !unattended;
    if (isNew && !newSessionPromotedRef.current) unattendedOverrideRef.current = enabled;
    pendingUnattendedRef.current = enabled;
    const sid = sessionIdRef.current;
    if (!sid) return;
    void flushPendingUnattended(sid)
      .catch((error: unknown) => addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) }));
  }, [toggleUnattendedLocal, unattended, isNew, flushPendingUnattended, addNotice]);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    if (isNew && !sessionIdRef.current && !ensuringNewSessionRef.current) {
      const selected = level === "auto" ? null : asConcreteThinkingLevel(level);
      thinkingLevelOverrideRef.current = selected;
      setNewSessionThinkingLevel(selected);
      setThinkingLevel(level);
      return;
    }
    await updateRuntimeSettings({ type: "set_thinking_level", level }, (value) => {
      const actual = (value as { thinkingLevel: ConcreteThinkingLevel }).thinkingLevel;
      setThinkingLevel(actual);
      setLiveThinkingLevel(actual);
      setCurrentThinkingOverride(level === "auto" ? null : actual);
      if (isNew) {
        thinkingLevelOverrideRef.current = level === "auto" ? null : actual;
        setNewSessionThinkingLevel(level === "auto" ? null : actual);
      }
    });
  }, [isNew, updateRuntimeSettings]);

  const handleFastModeChange = useCallback(async (mode: FastModeSelection) => {
    if (isNew && !sessionIdRef.current && !ensuringNewSessionRef.current) {
      fastModeOverrideRef.current = mode === "default" ? null : mode;
      setFastModeSelection(mode);
      setFastModeRuntimeStatus(null);
      return;
    }
    await updateRuntimeSettings({ type: "set_fast_mode", mode }, (value) => {
      const status = value as FastModeStatus;
      setFastModeSelection(status.mode);
      setFastModeRuntimeStatus(status);
      if (isNew) fastModeOverrideRef.current = status.mode === "default" ? null : status.mode;
    });
  }, [isNew, updateRuntimeSettings]);

  const handleSetDefaultThinkingLevel = useCallback(async (level: ConcreteThinkingLevel) => {
    const ownerScope = branchScopeRef.current;
    const ownerPeer = remotePeerRef.current;
    const isCurrent = () => sessionHookMountedRef.current
      && branchScopeRef.current === ownerScope && remotePeerRef.current === ownerPeer;
    try {
      await saveDefaultPreferences({ thinkingLevel: level });
    } catch (e) {
      if (!isCurrent()) return;
      addNotice({ type: "error", message: `Failed to save default reasoning level: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    if (!isCurrent()) return;
    addNotice({ type: "success", message: `Default reasoning level: ${level}` });
    setSavedDefaultThinkingLevel(level);
    if (displayThinkingLevel !== level) await handleThinkingLevelChange(level);
    if (isCurrent()) reloadModelsQuietly();
  }, [addNotice, displayThinkingLevel, handleThinkingLevelChange, reloadModelsQuietly, saveDefaultPreferences]);

  const handleToolPresetChange = useCallback(async (preset: ToolPreset) => {
    const toolNames = getToolNamesForPreset(preset);
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) {
      setPreferredToolPreset(preset);
      setToolPresetState(preset);
      sessionToolsPinnedRef.current = toolNames !== undefined;
      return;
    }
    const peer = remotePeerRef.current;
    let applied = false;
    try {
      // Omitting toolNames retracts the session's pin so it follows the configured
      // defaults again; the server rebuilds the session to resolve them.
      const result = await sendAgentCommandR<{ sessionId?: string; recreated?: boolean }>(sid, {
        type: "set_tools",
        ...(toolNames !== undefined ? { toolNames } : {}),
      });
      if (!sessionHookMountedRef.current || sessionIdRef.current !== sid || remotePeerRef.current !== peer) return;
      applied = true;
      setPreferredToolPreset(preset);
      setToolPresetState(preset);
      sessionToolsPinnedRef.current = toolNames !== undefined;
      const activeSessionId = result?.sessionId ?? sid;
      if (activeSessionId !== sid || result?.recreated) {
        cancelEventStreamGrace();
        closeEvents();
        // The old wrapper cancels its pending extension UI only after its stream has
        // closed, so those close events never arrive; drop the requests here instead
        // of leaving them queued in front of the new wrapper's.
        setExtensionDialogs([]);
        setExtensionCustomUis([]);
        sessionIdRef.current = activeSessionId;
        if (result?.recreated && sessionPropIdRef.current === activeSessionId) {
          maintainEventsConnected(activeSessionId);
        }
      }
      clearSlashCommands();
      setExtensionStatuses([]);
      setExtensionUsages([]);
      setExtensionWidgets([]);
      setEditorSuggestion(null);
      const [state] = await Promise.all([
        sendAgentCommandR<AgentStateResponse>(activeSessionId, { type: "get_state" }),
        loadTools(activeSessionId),
      ]);
      if (sessionHookMountedRef.current && sessionIdRef.current === activeSessionId) {
        setSystemPrompt(state.systemPrompt ?? "");
        syncLiveModel(state);
      }
    } catch (e) {
      console.error("Failed to set tools:", e);
      if (!applied && sessionHookMountedRef.current && sessionIdRef.current === sid && remotePeerRef.current === peer) {
        addNotice({ type: "error", message: t("chat.toolPresetUnconfirmed") });
        void loadSession(sid);
      }
    }
  }, [addNotice, cancelEventStreamGrace, clearSlashCommands, closeEvents, loadSession, loadTools, maintainEventsConnected, sendAgentCommandR, setToolPresetState, syncLiveModel, t]);


  const scrollUserMsgToTop = useCallback((options?: { follow?: boolean }) => {
    const element = lastUserMsgRef.current;
    if (!element?.isConnected) return false;
    viewport.scrollToEntry(element, 16, options?.follow ?? true);
    return true;
  }, [viewport]);

  // Unknown run state stays fail-closed; a failed settings read waits for explicit retry.
  useEffect(() => {
    if (!session?.id || !sessionStatePending || runtimeSettingsRead.status === "error") return;
    const sid = session.id;
    const retry = () => {
      maintainEventsConnected(sid);
      void loadAgentState(sid).then((state) => restoreLoadedRunState(sid, state));
    };
    const timer = window.setInterval(retry, 15_000);
    window.addEventListener("online", retry);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", retry);
    };
  }, [session?.id, sessionStatePending, runtimeSettingsRead.status, loadAgentState, maintainEventsConnected, restoreLoadedRunState]);

  const retrySessionRead = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    await Promise.all([
      loadSession(sid),
      reader.retry(),
      loadAgentState(sid).then(state => restoreLoadedRunState(sid, state)),
    ]);
  }, [loadSession, reader, loadAgentState, restoreLoadedRunState]);

  useEffect(() => {
    if (!error && !history.error) return;
    const recover = () => { if (document.visibilityState === "visible") void retrySessionRead(); };
    window.addEventListener("online", recover);
    window.addEventListener("focus", recover);
    document.addEventListener("visibilitychange", recover);
    return () => {
      window.removeEventListener("online", recover);
      window.removeEventListener("focus", recover);
      document.removeEventListener("visibilitychange", recover);
    };
  }, [error, history.error, retrySessionRead]);

  // Load session on mount
  useEffect(() => {
    const lifecycleGeneration = ++newSessionLifecycleGenerationRef.current;
    sessionHookMountedRef.current = true;
    if (session) {
      sessionIdRef.current = session.id;
      // The sidebar activity stream already knows whether this session is live.
      // Preserve that fact while get_state reloads the exact run details.
      const knownRunning = Boolean(sessionRunning);
      agentRunningRef.current = knownRunning;
      bashRunningRef.current = false;
      sdkAgentActiveRef.current = false;
      rpcPromptPendingRef.current = false;
      setAgentRunning(knownRunning);
      setBashRunning(false);
      setIsCompacting(false);
      dispatch({ type: "end" });
        setAutoCompactionEnabled(null);
// History remains owned by the history controller; queue identity is producer-owned.
      queuedDraftProjectionRef.current.reset(cacheKeyForSession(session.id));
      setQueueRecallState("idle");
      serverCopyOperationRef.current = null;
      sessionStatePendingRef.current = true;
      setSessionStatePending(true);
      const loadSettlementGeneration = sessionSettlementGenerationRef.current;
      const loadRunRevision = stateRunRevisionRef.current;
      void Promise.all([loadSession(session.id, true), loadAgentState(session.id)])
        .then(([, agentState]) => {
          // Unattended scheduling lives in the runtime; a cold session has none to read.
          if (agentState?.running) void syncServerUnattendedState(session.id);
          return restoreLoadedRunState(session.id, agentState, loadSettlementGeneration, loadRunRevision);
        });
    }
    return () => {
      if (newSessionLifecycleGenerationRef.current === lifecycleGeneration) {
        newSessionLifecycleGenerationRef.current += 1;
      }
      sessionHookMountedRef.current = false;
      pendingUnattendedRef.current = null;
      blockingLoadOwnerRef.current = null;
      pendingSessionLoadRef.current = null;
      cancelEventStreamGrace();
      closeEvents();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    onRuntimeInspectionChange?.(runtimeInspection);
  }, [onRuntimeInspectionChange, runtimeInspection]);

  useEffect(() => {
    onSystemPromptLoaderChange?.(loadSystemPrompt);
    return () => onSystemPromptLoaderChange?.(null);
  }, [loadSystemPrompt, onSystemPromptLoaderChange]);

  const branchSwitchLocked = agentRunning || bashRunning || isCompacting;
  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChange, branchSwitchLocked);
  }, [data?.tree, activeLeafId, handleLeafChange, branchSwitchLocked, onBranchDataChange]);

  useLayoutEffect(() => {
    reader.setCommit(publish => viewport.commit(() => flushSync(publish)));
    const container = scrollContainerRef.current;
    if (!container) return;
    const onScroll = () => {
      viewport.onScroll();
      setShowScrollToBottom(shouldShowScrollToLatest(container.scrollTop, container.clientHeight, container.scrollHeight));
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(viewport.resize);
    observer?.observe(container);
    if (container.firstElementChild) observer?.observe(container.firstElementChild);
    return () => { reader.setCommit(publish => publish()); container.removeEventListener("scroll", onScroll); observer?.disconnect(); };
  }, [reader, viewport]);

  useEffect(() => {
    const sid = session?.id;
    if (sid) {
      reader.setScope({ sessionId: sid, peer: remotePeer ?? null }, true);
      const owner = reader.getState().requestedScope;
      // A cached first frame opens at its latest row; the same follow flag owns
      // the background catch-up and yields immediately to native scrolling.
      if (reader.getState().transcript.loaded) viewport.setFollow(true);
      void reader.reconcileTail().then(result => {
        if (!result || reader.getState().requestedScope !== owner || !viewport.follow) return;
        if (sessionOpenScrollRef.current !== "last-question" || !scrollUserMsgToTop({ follow: false })) scrollToBottom("auto");
      });
    }
    const refresh = () => { if (document.visibilityState === "visible") void reader.reconcileTail(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); reader.dispose(); };
  }, [reader, session?.id, remotePeer, viewport, scrollUserMsgToTop, scrollToBottom]);

  // Read the open-position preference once mounted and follow live changes from
  // the settings panel. A ref keeps it out of the landing effect's dependencies,
  // so switching the preference cannot itself trigger a scroll.
  useEffect(() => {
    sessionOpenScrollRef.current = loadSessionOpenScroll();
    const onPreferenceChange = () => {
      const next = loadSessionOpenScroll();
      if (isSessionOpenScroll(next)) sessionOpenScrollRef.current = next;
    };
    window.addEventListener(SESSION_OPEN_SCROLL_CHANGED_EVENT, onPreferenceChange);
    return () => window.removeEventListener(SESSION_OPEN_SCROLL_CHANGED_EVENT, onPreferenceChange);
  }, []);

  useEffect(() => {
    if (!agentRunning) setPromptAnchorActive(false);
  }, [agentRunning]);

  useLayoutEffect(() => {
    if (!messages.length && !streamingStore.getState().streamingMessage) return;
    if (pendingScrollToUserRef.current) {
      pendingScrollToUserRef.current = false;
      scrollUserMsgToTop();
    } else if (!viewport.initialized) {
      if (sessionOpenScrollRef.current !== "last-question" || !scrollUserMsgToTop({ follow: false })) scrollToBottom("auto");
    } else {
      viewport.resize();
    }
  }, [messages, streamingStore, viewport, scrollToBottom, scrollUserMsgToTop]);

  useEffect(() => {
    const refreshReloadedSession = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; remotePeer?: string | null }>).detail;
      const sid = sessionIdRef.current;
      if (!sid || detail?.sessionId !== sid || (detail.remotePeer ?? null) !== (remotePeerRef.current ?? null)) return;
      stateLoadGenerationRef.current += 1;
      void Promise.allSettled([loadAgentState(sid), loadTools(sid), loadSlashCommands()]);
    };
    window.addEventListener(SESSION_RESOURCES_RELOADED_EVENT, refreshReloadedSession);
    return () => window.removeEventListener(SESSION_RESOURCES_RELOADED_EVENT, refreshReloadedSession);
  }, [loadAgentState, loadTools, loadSlashCommands]);

  // Load the model list with bounded retries; loadModels exposes each failure.
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await loadModels(controller.signal);
          return;
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (attempt >= MODELS_RETRY_DELAYS_MS.length) return;
          await delay(MODELS_RETRY_DELAYS_MS[attempt]);
          if (controller.signal.aborted) return;
        }
      }
    })();
    return () => controller.abort();
  }, [loadModels, modelsRefreshKey]);

  // A models.json save refreshes the live runtime before this key changes.
  // Re-read state so the status bar uses the refreshed context window without
  // reloading the transcript or interrupting an active prompt.
  useEffect(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const controller = new AbortController();
    fetch(apiPath(`agent/${encodeURIComponent(sid)}?systemPrompt=0`), { cache: "no-store", signal: controller.signal })
      .then((res) => res.ok ? res.json() as Promise<{ state?: AgentStateResponse }> : null)
      .then((data) => {
        if (controller.signal.aborted || sessionIdRef.current !== sid) return;
        const state = data?.state;
        if (state?.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
      });
    return () => controller.abort();
  }, [apiPath, modelsRefreshKey]);

  useEffect(() => {
    if (!compactResult) return;
    const t = setTimeout(() => setCompactResult(null), 6000);
    return () => clearTimeout(t);
  }, [compactResult]);

  useEffect(() => {
    if (noticeState.visible.length === 0) return;
    const exiting = noticeState.visible.find((notice) => notice.exiting);
    if (exiting) {
      const t = setTimeout(() => {
        dispatchNotice({ type: "remove", id: exiting.id });
      }, NOTICE_EXIT_ANIMATION_MS);
      return () => clearTimeout(t);
    }
    const oldest = noticeState.visible[0];
    if (!oldest) return;
    // Reader local patch: hover pauses the expiry timer so the notice content
    // can be read and copied; once the cursor leaves, the notice is dismissed
    // (or resumes its countdown if it had not yet reached NOTICE_VISIBLE_MS).
    let poll: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();
    const tick = () => {
      if (noticeHoverRef.current) {
        poll = setTimeout(tick, NOTICE_HOVER_POLL_MS);
        return;
      }
      if (Date.now() - startedAt >= NOTICE_VISIBLE_MS) {
        dispatchNotice({ type: "mark_oldest_exiting" });
        poll = null;
        return;
      }
      poll = setTimeout(tick, NOTICE_HOVER_POLL_MS);
    };
    poll = setTimeout(tick, NOTICE_HOVER_POLL_MS);
    return () => { if (poll) clearTimeout(poll); };
  }, [noticeState.visible]);

  const extensionDialog = extensionDialogs[0] ?? null;
  const waitingExtensionDialogCount = Math.max(0, extensionDialogs.length - 1);
  const extensionCustomUi = extensionCustomUis[0] ?? null;
  const waitingExtensionCustomUiCount = Math.max(0, extensionCustomUis.length - 1);

  return {
    // State
    data, loading, error, activeLeafId, history, reader, retrySessionRead, messages, entryIds, activeToolResults, questionAnalysisJobs, questionDraftViews, streamingStore,
    systemTools,
    agentRunning, sessionStatePending, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, toolPreset, thinkingLevel, fastMode,
    retryInfo, contextUsage, systemPrompt, runtimeInspection, forkingEntryId,
    continueUi, unattended, toggleUnattended, triggerContinue, stopAutoRetry,
    compactionCosts,
    compactionContexts,
    isCompacting, compactError, compactResult, autoCompactionEnabled, runtimeSettingsRead, retryRuntimeSettings, currentModel, displayModel, modelSwitching, runtimeSettingsUpdating, sessionStats,
    messageCosts,
    imageGenerationCosts,
    slashCommands, slashCommandsLoading, slashCommandsReloadKey, queuedMessages: { ...queuedMessages, recallState: queueRecallState,
      recallBlocked: !queuedMessages.recallPending && queuedDraftProjectionRef.current.snapshot && [...queuedDraftProjectionRef.current.snapshot.steering, ...queuedDraftProjectionRef.current.snapshot.followUp].some(item => item.role !== "user" || item.customType !== undefined) ? "non_user" as const
        : !queuedMessages.recallPending && queuedDraftProjectionRef.current.snapshot && queuedImageCount(queuedDraftProjectionRef.current.snapshot) > 10 ? "too_many_images" as const : undefined,
      recovery: queueRecoveryView },
    notices: noticeState.visible, addNotice, setNoticesHovered, dismissNotices,
    hasUnconfirmedPrompt: unconfirmedPrompts.some((delivery) => delivery.sessionId === sessionIdRef.current && delivery.peer === (remotePeerRef.current ?? null)),
    extensionDialog, waitingExtensionDialogCount, extensionCustomUi, waitingExtensionCustomUiCount, extensionStatuses, extensionUsages, extensionWidgets, editorSuggestion, respondToExtensionUi, sendExtensionCustomInput, closeExtensionCustomUi,
    isAutoModelSelection: isNew && newSessionModel === null,
    isAutoThinkingSelection: isNew && newSessionThinkingLevel === null,
    defaultModel: newSessionDefaultModel,
    savedDefaultThinkingLevel,
    agentPhase,
    isNew,
    editEntryId,
    promptAnchorActive,
    showScrollToBottom, follow, setFollow, viewport,
    sessionIdRef, scrollContainerRef, lastUserMsgRef, pendingScrollToUserRef,
    // Actions
    ensureSession: ensureNewSession,
    handleSend, handleAbort, handleFork, handleNavigate, handleLeafChange, handleModelChange, handleFastModeChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction, handleAutoCompactionChange,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleEditContent,
    restoreLegacyHistoryEdit,
    cancelEdit: editEntryId ? cancelEdit : undefined,
    handleSetDefaultModel, handleSetDefaultThinkingLevel,
    handleToolPresetChange, handleThinkingLevelChange, loadTools, loadSlashCommands,
    scrollToBottom, scrollToMessage, scrollUserMsgToTop,
    dispatch, setAgentRunning, setForkingEntryId,
    bashRunning, pendingBash,
    // Subscriptions
    handleAgentEventRef,
  };
}
