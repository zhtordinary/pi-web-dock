"use client";
import type { HistoryEditIntent } from "@/lib/history-edit-message";
import type { SubagentToolDetails } from "@/lib/subagent-extension";

import { Fragment, memo, useState, useRef, useEffect, useMemo, useCallback, type CSSProperties, type ComponentProps } from "react";
import { MarkdownBody } from "./MarkdownBody";
import { ImagePreview } from "./ImagePreview";
import { copyText } from "@/lib/clipboard";
import { sendAgentCommand } from "@/lib/agent-client";
import { apiPathForPeer, fileApiPath } from "@/lib/file-api";
import { resolveLocalFileHref } from "@/lib/file-links";
import type { QuestionAnalysisResult, QuestionRewriteResult } from "@/lib/question-analysis";
import type { QuestionAnalysisJobView, QuestionDraftView } from "@/lib/question-analysis-jobs";
import { useI18n } from "@/hooks/useI18n";
import { formatClockTime } from "@/lib/i18n/format";
import { parseCompactionSummary } from "@/lib/compaction-summary";
import type { TurnUsage } from "@/lib/turn-usage";
import { toolFieldsOfInput } from "@/lib/tool-fields";
import { turnCacheHitRate, type TurnResources } from "@/lib/turn-resources";
import type { CompactionContextInfo } from "@/lib/pi-types";
import type { SessionCompactionCost } from "@/lib/session-cost";
import { calculateResponseDurationMs, formatResponseDuration, normalizeMeasuredDurationMs } from "@/lib/response-duration";
import { formatMetricNumber } from "@/lib/format-metric-number";
import { computeAssistantTiming } from "@/lib/session-timing";
import { getAssistantErrorMessage, hasAssistantAnswer, isAssistantTruncated, isDisplayableAssistantBlock, splitThinkingPieces } from "@/lib/message-display";
import { formatTurnDuration } from "@/lib/turn-duration";
import { getTranscriptNotices } from "@/lib/transcript-notices";
import { TRANSCRIPT_NOTICE_WARNING_COLOR, transcriptNoticeText } from "@/components/TranscriptNotices";
import { parseUnifiedPatch, type SplitDiffCell, type SplitDiffFile } from "@/lib/patch";
import { applyPatchPreviewToFiles, applyPatchResultHasFailures, extractApplyPatchPaths, getApplyPatchInputText, parseApplyPatchInput } from "@/lib/apply-patch";
import { isApplyPatchToolName, isEditToolName } from "@/lib/tool-names";
import { TurnWrittenFiles } from "./TurnWrittenFiles";
import type { WrittenFile } from "@/lib/turn-written-files";
import { skillExpansionToCommand } from "@/lib/slash-display";
import { SESSION_PEER_CUSTOM_TYPE } from "@/lib/session-peer-message";
import { isSubagentWakeMessage, stripHiddenUserQuestionPreservingWhitespace } from "@/lib/session-hover-preview";
import { CODEMODE_TOOL_NAME, codemodeCalls, codemodeScript, codemodeScriptPreview, stripCodemodeHeader } from "@/lib/codemode-view";
import { CodemodeCallList } from "./CodemodeToolView";
import { ImageGenerationCost } from "./ImageGenerationCost";
import { imageGenerationCostsFromDetails, mergeImageGenerationCosts, type ImageGenerationCost as ImageCost } from "@/lib/image-generation-cost";
import { isToolCallExpanded, setToolCallExpanded } from "@/lib/tool-call-expansion";
import { mcpToolLabel, prettyMcpResultText } from "@/lib/mcp-tool-display";
import type {
  AgentMessage,
  UserMessage,
  AssistantMessage,
  CustomMessage,
  ToolResultMessage,
  BashExecutionMessage,
  AssistantContentBlock,
  TextContent,
  ImageContent,
  ToolCallContent,
  ThinkingContent,
} from "@/lib/types";

// CJK chars ~1 token each (GLM/DeepSeek/GPT-o200k); other chars ~4 chars/token.
const CJK_PATTERN = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}\uac00-\ud7af]/u;
function estimateTokens(text: string): number {
  let cjk = 0;
  let rest = 0;
  for (const ch of text) {
    if (CJK_PATTERN.test(ch)) cjk++;
    else rest++;
  }
  return cjk + rest / 4;
}

interface TokenEstimateCacheEntry {
  text: string;
  tokens: number;
}

export function getTokenEstimateText(block: AssistantContentBlock): string | null {
  if (block.type === "text") return block.text;
  if (block.type === "thinking") return block.thinking;
  if (block.type === "toolCall") return block.rawInput ?? JSON.stringify(block.input ?? {}) ?? "";
  return null;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function estimateUpdatedTokens(previous: TokenEstimateCacheEntry | undefined, text: string): number {
  if (!previous || !text.startsWith(previous.text)) return estimateTokens(text);

  let baseTokens = previous.tokens;
  let suffixStart = previous.text.length;
  // A streamed delta can complete a surrogate pair that was counted as two
  // non-CJK code points in the previous update.
  if (
    suffixStart > 0
    && suffixStart < text.length
    && isHighSurrogate(previous.text.charCodeAt(suffixStart - 1))
    && isLowSurrogate(text.charCodeAt(suffixStart))
  ) {
    baseTokens -= 1 / 4;
    suffixStart--;
  }
  return baseTokens + estimateTokens(text.slice(suffixStart));
}

export function getEditNavigationEntryId(
  entryId?: string,
  prevAssistantEntryId?: string,
  previousEntryId?: string,
): string | undefined {
  return prevAssistantEntryId ?? previousEntryId ?? entryId;
}

// Messages larger than this skip markdown rendering entirely. react-markdown +
// KaTeX + syntax highlighting on multi-hundred-KB payloads (e.g. pasted HAR or
// log dumps) freezes the browser main thread.
const MAX_MARKDOWN_CHARS = 100_000;

function formatMessageBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} KB`;
  return `${n} B`;
}

/**
 * MarkdownBody with an oversized-content guard: huge messages render as a
 * click-to-reveal plain-text <pre> instead of running the markdown pipeline.
 */
function SafeMarkdownBody({ children, className, ...props }: ComponentProps<typeof MarkdownBody>) {
  const { t } = useI18n();
  const [showRaw, setShowRaw] = useState(false);

  if (children.length <= MAX_MARKDOWN_CHARS) {
    return <MarkdownBody className={className} {...props}>{children}</MarkdownBody>;
  }
  if (!showRaw) {
    return (
      <button
        data-session-search-exclude="true"
        onClick={() => setShowRaw(true)}
        style={{
          display: "block",
          width: "100%",
          margin: "4px 0",
          padding: "7px 10px",
          border: "1px solid var(--border)",
          borderRadius: 6,
          background: "var(--bg-panel)",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
      >
        ⚠ {t("i18n.largeMessageReveal", { size: formatMessageBytes(children.length) })}
      </button>
    );
  }
  return (
    <div data-session-search-exclude="true" className={className} style={{ maxHeight: 420, overflow: "auto", fontSize: 12, lineHeight: 1.5 }}>
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontFamily: "var(--font-mono)",
          color: "var(--text-muted)",
        }}
      >
        {children}
      </pre>
    </div>
  );
}

// Cap the user "sent" bubble's height so an abnormally long message does not
// push the conversation off screen; overflow scrolls inside the bubble.
const USER_BUBBLE_MAX_HEIGHT = 300;

interface Props {
  message: AgentMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => Promise<boolean> | boolean;
  prevAssistantEntryId?: string;
  /** The persisted parent entry, including when it is not an assistant message. */
  previousEntryId?: string;
  isFirstUserMessage?: boolean;
  onEditContent?: (message: UserMessage, entryId: string, resetToRoot?: boolean, intent?: HistoryEditIntent) => void;
  onCancelEdit?: () => void;
  isEditing?: boolean;
  showTimestamp?: boolean;
  sessionId?: string;
  questionAnalysisJob?: QuestionAnalysisJobView;
  questionDraftView?: QuestionDraftView;
  remotePeer?: string;
  calculatedCost?: number;
  imageGenerationCosts?: readonly ImageCost[];
  compactionCost?: SessionCompactionCost;
  compactionContext?: CompactionContextInfo;
  turnUsage?: TurnUsage;
  turnResources?: TurnResources;
  responseDurationMs?: number;
  /** Turn-level model response share; null suppresses per-message duration when unavailable. */
  modelWaitPercent?: number | null;
  /** The whole turn's time, for a final answer with no process details to show it. */
  turnDurationMs?: number;
  /**
   * Files this turn wrote, derived by the caller from the whole turn's
   * successful write/edit tool calls. ChatWindow computes this because the
   * saved-message path splits tool calls into their own entries, leaving the
   * final answer text-only.
   */
  writtenFiles?: WrittenFile[];
  onCompact?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
  onStartSideBranch?: (entryId: string, previewText: string, beforeEntryId?: string) => void;
  isSideBranch?: boolean;
}

function formatTime(ts?: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = formatClockTime(d);
  if (isToday) return time;
  const date = d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
  return `${date} ${time}`;
}

export function replaceUserMessageText(message: UserMessage, text: string): UserMessage {
  if (typeof message.content === "string") return { ...message, content: text };

  const content: Array<TextContent | ImageContent> = [];
  let replaced = false;
  for (const block of message.content) {
    if (block.type !== "text") {
      content.push(block);
      continue;
    }
    if (!replaced) {
      content.push({ ...block, text });
      replaced = true;
    }
  }
  if (!replaced) content.unshift({ type: "text", text });
  return { ...message, content };
}

function haveSameRelevantToolResults(
  message: AgentMessage,
  previous: Map<string, ToolResultMessage> | undefined,
  next: Map<string, ToolResultMessage> | undefined,
): boolean {
  if (previous === next || message.role !== "assistant") return true;
  for (const block of (message as AssistantMessage).content ?? []) {
    if (block.type === "toolCall" && previous?.get(block.toolCallId) !== next?.get(block.toolCallId)) {
      return false;
    }
  }
  return true;
}

export const MessageView = memo(function MessageView({ message, isStreaming, toolResults, modelNames, cwd, onOpenFile, entryId, onFork, forking, onNavigate, prevAssistantEntryId, previousEntryId, isFirstUserMessage = false, onEditContent, onCancelEdit, isEditing, showTimestamp, sessionId, questionAnalysisJob, questionDraftView, remotePeer, imageGenerationCosts, calculatedCost, compactionCost, compactionContext, turnUsage, turnResources, responseDurationMs, modelWaitPercent, writtenFiles, turnDurationMs, onCompact, isCompacting, compactError, onStartSideBranch, isSideBranch }: Props) {
  if (message.role === "user") {
    if (isSubagentWakeMessage(message)) return null;
    return <UserMessageView message={message as UserMessage} cwd={cwd} sessionId={sessionId} questionAnalysisJob={questionAnalysisJob} questionDraftView={questionDraftView} remotePeer={remotePeer} onOpenFile={onOpenFile} entryId={entryId} onFork={onFork} forking={forking} onNavigate={onNavigate} prevAssistantEntryId={prevAssistantEntryId} previousEntryId={previousEntryId} isFirstUserMessage={isFirstUserMessage} onEditContent={onEditContent} onCancelEdit={onCancelEdit} isEditing={isEditing} onStartSideBranch={onStartSideBranch} />;
  }
  if (message.role === "assistant") {
    return <AssistantMessageView message={message as AssistantMessage} isStreaming={isStreaming} toolResults={toolResults} modelNames={modelNames} cwd={cwd} remotePeer={remotePeer} onOpenFile={onOpenFile} showTimestamp={showTimestamp} sessionId={sessionId} entryId={entryId} onFork={onFork} forking={forking} imageGenerationCosts={imageGenerationCosts} calculatedCost={calculatedCost} turnUsage={turnUsage} turnResources={turnResources} responseDurationMs={responseDurationMs} modelWaitPercent={modelWaitPercent} writtenFiles={writtenFiles} turnDurationMs={turnDurationMs} onCompact={onCompact} isCompacting={isCompacting} compactError={compactError} onStartSideBranch={onStartSideBranch} isSideBranch={isSideBranch} />;
  }
  if (message.role === "toolResult") {
    // Rendered inline under its toolCall — skip standalone rendering if paired
    return null;
  }
  if (message.role === "custom") {
    if ((message as CustomMessage).customType === "compaction") {
      return (
        <div data-compaction-message data-compaction-entry-id={entryId ?? undefined}>
          <CompactionMessageView message={message as CustomMessage} onOpenFile={onOpenFile} compactionCost={compactionCost} compactionContext={compactionContext} />
        </div>
      );
    }
    return <CustomMessageView message={message as CustomMessage} cwd={cwd} sessionId={sessionId} remotePeer={remotePeer} onOpenFile={onOpenFile} />;
  }
  if (message.role === "bashExecution") {
    return <BashExecutionView message={message as BashExecutionMessage} sessionId={sessionId} />;
  }
  return null;
}, (prev, next) => {
  return prev.message === next.message
    && prev.isStreaming === next.isStreaming
    && haveSameRelevantToolResults(prev.message, prev.toolResults, next.toolResults)
    && prev.modelNames === next.modelNames
    && prev.cwd === next.cwd
    && prev.onOpenFile === next.onOpenFile
    && prev.entryId === next.entryId
    && prev.onFork === next.onFork
    && prev.forking === next.forking
    && prev.onNavigate === next.onNavigate
    && prev.prevAssistantEntryId === next.prevAssistantEntryId
    && prev.previousEntryId === next.previousEntryId
    && prev.isFirstUserMessage === next.isFirstUserMessage
    && prev.onEditContent === next.onEditContent
    && prev.onCancelEdit === next.onCancelEdit
    && prev.isEditing === next.isEditing
    && prev.showTimestamp === next.showTimestamp
    && prev.sessionId === next.sessionId
    && prev.questionAnalysisJob === next.questionAnalysisJob
    && prev.questionDraftView === next.questionDraftView
    && prev.onStartSideBranch === next.onStartSideBranch
    && prev.isSideBranch === next.isSideBranch
    && prev.writtenFiles === next.writtenFiles
    && prev.turnDurationMs === next.turnDurationMs
    && prev.onCompact === next.onCompact
    && prev.isCompacting === next.isCompacting
    && prev.compactError === next.compactError
    && prev.remotePeer === next.remotePeer
    && prev.calculatedCost === next.calculatedCost
    && prev.imageGenerationCosts === next.imageGenerationCosts
    && prev.compactionCost === next.compactionCost
    && prev.compactionContext === next.compactionContext
    && prev.turnUsage === next.turnUsage
    && prev.turnResources === next.turnResources
    && prev.responseDurationMs === next.responseDurationMs
    && prev.modelWaitPercent === next.modelWaitPercent;
});

const QUESTION_ANALYSIS_LABEL_KEYS = {
  analyze: "questionAnalysis.analyze",
  analyzing: "questionAnalysis.analyzing",
  show: "questionAnalysis.show",
  hide: "questionAnalysis.hide",
  retry: "questionAnalysis.retry",
  title: "questionAnalysis.title",
  unavailable: "questionAnalysis.unavailable",
  failed: "questionAnalysis.failed",
  noResult: "questionAnalysis.noResult",
  chooseTitle: "questionAnalysis.chooseTitle",
  chooseDescription: "questionAnalysis.chooseDescription",
  modeQuestion: "questionAnalysis.modeQuestion",
  modeQuestionDescription: "questionAnalysis.modeQuestionDescription",
  modeContext: "questionAnalysis.modeContext",
  modeContextDescription: "questionAnalysis.modeContextDescription",
  contextUnavailable: "questionAnalysis.contextUnavailable",
  cancel: "i18n.cancel",
  run: "questionAnalysis.run",
  changeScope: "questionAnalysis.changeScope",
  scope: "questionAnalysis.scope",
  scopeQuestion: "questionAnalysis.scopeQuestion",
  scopeContext: "questionAnalysis.scopeContext",
  scopeNoContext: "questionAnalysis.scopeNoContext",
  scopeRecent: "questionAnalysis.scopeRecent",
  pricingUnavailable: "questionAnalysis.pricingUnavailable",
  rewrite: "questionAnalysis.rewrite",
  rewriting: "questionAnalysis.rewriting",
  rewriteTitle: "questionAnalysis.rewriteTitle",
  applyRewrite: "questionAnalysis.applyRewrite",
  rewriteFailed: "questionAnalysis.rewriteFailed",
  noRewriteResult: "questionAnalysis.noRewriteResult",
} as const;

type QuestionAnalysisLabels = { [K in keyof typeof QUESTION_ANALYSIS_LABEL_KEYS]: string };

function questionAnalysisLabels(t: (key: string) => string): QuestionAnalysisLabels {
  return Object.fromEntries(Object.entries(QUESTION_ANALYSIS_LABEL_KEYS).map(([name, key]) => [name, t(key)])) as QuestionAnalysisLabels;
}

type QuestionAnalysisMode = "question" | "context";
type QuestionAnalysisState =
  | { status: "idle" }
  | { status: "loading"; mode: QuestionAnalysisMode }
  | { status: "ready"; result: QuestionAnalysisResult }
  | { status: "error"; message: string; mode: QuestionAnalysisMode };

type QuestionRewriteState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: QuestionRewriteResult }
  | { status: "error"; message: string };

function questionAnalysisStateFromJob(job?: QuestionAnalysisJobView): QuestionAnalysisState {
  if (!job) return { status: "idle" };
  if (job.status === "completed" && job.result) return { status: "ready", result: job.result };
  if (job.status === "failed") {
    return { status: "error", mode: job.mode, message: job.error || "Analysis failed" };
  }
  return { status: "loading", mode: job.mode };
}

function questionAnalysisStateFromDraft(draft?: QuestionDraftView): QuestionAnalysisState {
  if (!draft) return { status: "idle" };
  return { status: "ready", result: draft.result };
}

function waitForQuestionAnalysisPoll(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function UserMessageView({ message, cwd, sessionId, questionAnalysisJob, questionDraftView, remotePeer, onOpenFile, entryId, onFork, forking, onNavigate, prevAssistantEntryId, previousEntryId, isFirstUserMessage = false, onEditContent, onCancelEdit, isEditing, onStartSideBranch }: {
  message: UserMessage;
  cwd?: string;
  sessionId?: string;
  questionAnalysisJob?: QuestionAnalysisJobView;
  questionDraftView?: QuestionDraftView;
  remotePeer?: string;
  onOpenFile?: (filePath: string) => void;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => Promise<boolean> | boolean;
  prevAssistantEntryId?: string;
  previousEntryId?: string;
  isFirstUserMessage?: boolean;
  onEditContent?: (message: UserMessage, entryId: string, resetToRoot?: boolean, intent?: HistoryEditIntent) => void;
  onCancelEdit?: () => void;
  isEditing?: boolean;
  onStartSideBranch?: (entryId: string, previewText: string, beforeEntryId?: string) => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [questionAnalysis, setQuestionAnalysis] = useState<QuestionAnalysisState>(() => {
    const fromJob = questionAnalysisStateFromJob(questionAnalysisJob);
    if (fromJob.status !== "idle") return fromJob;
    return questionAnalysisStateFromDraft(questionDraftView);
  });
  const [questionAnalysisOpen, setQuestionAnalysisOpen] = useState(Boolean(questionAnalysisJob) || Boolean(questionDraftView));
  const [questionAnalysisDialogOpen, setQuestionAnalysisDialogOpen] = useState(false);
  const [questionRewrite, setQuestionRewrite] = useState<QuestionRewriteState>(
    questionDraftView?.rewrite ? { status: "ready", result: questionDraftView.rewrite } : { status: "idle" },
  );
  const [questionAnalysisMode, setQuestionAnalysisMode] = useState<QuestionAnalysisMode>(
    questionAnalysisJob?.mode ?? questionDraftView?.result.context?.mode ?? "question",
  );
  const questionAnalysisJobIdRef = useRef<string | null>(questionAnalysisJob?.jobId ?? null);
  const questionAnalysisPollRef = useRef<AbortController | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Session files can hold `\r\n` or lone `\r` line endings (#680). Chrome renders
  // a lone `\r` as a space even in the pre-wrap command-args and raw-text views.
  // Copy uses this text too; the session file keeps the original endings.
  const rawContent = (
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("\n")
  ).replace(/\r\n?/g, "\n");
  const content = stripHiddenUserQuestionPreservingWhitespace(rawContent);

  const imageBlocks: ImageContent[] =
    typeof message.content === "string"
      ? []
      : message.content.filter((b): b is ImageContent => b.type === "image");

  const previewSources = imageBlocks.map((image) => imageSource(image, remotePeer, sessionId)).filter((s): s is string => Boolean(s));

  const commandText = skillExpansionToCommand(content);
  const commandSeparator = commandText?.search(/\s/) ?? -1;
  const commandName = commandText
    ? commandSeparator === -1 ? commandText : commandText.slice(0, commandSeparator)
    : "";
  const commandArgs = commandText && commandSeparator !== -1
    ? commandText.slice(commandSeparator + 1)
    : "";

  const time = formatTime(message.displayTimestamp ?? message.timestamp);
  const canFork = !!entryId && !!onFork;
  const editNavigationEntryId = getEditNavigationEntryId(entryId, prevAssistantEntryId, previousEntryId);
  const canSideBranch = !isFirstUserMessage && !!editNavigationEntryId && !!onStartSideBranch;
  const canNavigate = !!editNavigationEntryId && !!onNavigate;
  const copyTarget = commandText ?? content;
  const editTarget = commandText ? replaceUserMessageText(message, commandText) : message;
  const canEdit = !!entryId && !!onEditContent && (content.trim().length > 0 || imageBlocks.length > 0);
  const canCancelEdit = !!isEditing && !!onCancelEdit;
  const analysisTarget = (commandText ?? content).trim();
  const canAnalyzeQuestion = Boolean(sessionId && entryId && analysisTarget);
  const canRewriteQuestion = canAnalyzeQuestion
    && questionAnalysis.status === "ready"
    && Boolean(questionAnalysis.result.text.trim());
  const labels = useMemo(() => questionAnalysisLabels(t), [t]);
  const canUseQuestionContext = Boolean(entryId);
  const analysisButtonLabel = questionAnalysis.status === "loading"
    ? labels.analyzing
    : questionAnalysis.status === "ready"
      ? (questionAnalysisOpen ? labels.hide : labels.show)
      : questionAnalysis.status === "error"
        ? labels.retry
        : labels.analyze;

  const applyQuestionAnalysisJob = useCallback((job: QuestionAnalysisJobView) => {
    questionAnalysisJobIdRef.current = job.jobId;
    setQuestionAnalysis(questionAnalysisStateFromJob(job));
    setQuestionRewrite({ status: "idle" });
    setQuestionAnalysisOpen(true);
  }, []);

  const pollQuestionAnalysisJob = useCallback(async (jobId: string, mode: QuestionAnalysisMode) => {
    if (!sessionId || !entryId) return;
    questionAnalysisPollRef.current?.abort();
    const controller = new AbortController();
    questionAnalysisPollRef.current = controller;
    for (let attempt = 0; attempt < 180 && !controller.signal.aborted; attempt += 1) {
      if (attempt > 0) await waitForQuestionAnalysisPoll(1000, controller.signal);
      if (controller.signal.aborted) return;
      try {
        const params = new URLSearchParams({ entryId, jobId });
        const res = await fetch(apiPathForPeer(remotePeer, `sessions/${encodeURIComponent(sessionId)}/question-analysis?${params}`), {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) continue;
        const body = await res.json() as { jobs?: QuestionAnalysisJobView[] };
        const job = body.jobs?.find((candidate) => candidate.jobId === jobId);
        if (!job) continue;
        if (job.status === "completed" || job.status === "failed") {
          applyQuestionAnalysisJob(job);
          return;
        }
        setQuestionAnalysis({ status: "loading", mode: job.mode || mode });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
      }
    }
  }, [applyQuestionAnalysisJob, entryId, remotePeer, sessionId]);

  useEffect(() => {
    // A saved retry/analysis job supersedes draft-only state; otherwise keep
    // the composer-attached result that arrived with this user message.
    if (questionAnalysisJob) setQuestionRewrite({ status: "idle" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- jobId is the identity of the job record.
  }, [questionAnalysisJob?.jobId]);

  useEffect(() => {
    if (questionAnalysisJob) {
      questionAnalysisJobIdRef.current = questionAnalysisJob.jobId;
      setQuestionAnalysis(questionAnalysisStateFromJob(questionAnalysisJob));
      setQuestionAnalysisOpen(true);
      if (questionAnalysisJob.status === "pending" || questionAnalysisJob.status === "running") {
        void pollQuestionAnalysisJob(questionAnalysisJob.jobId, questionAnalysisJob.mode);
      } else {
        questionAnalysisPollRef.current?.abort();
      }
      return;
    }
    if (questionDraftView) {
      setQuestionAnalysis(questionAnalysisStateFromDraft(questionDraftView));
      setQuestionAnalysisOpen(true);
      setQuestionRewrite(
        questionDraftView.rewrite ? { status: "ready", result: questionDraftView.rewrite } : { status: "idle" },
      );
      return;
    }
    if (!questionAnalysisJobIdRef.current) {
      setQuestionAnalysis({ status: "idle" });
      setQuestionAnalysisOpen(false);
    }
  }, [pollQuestionAnalysisJob, questionAnalysisJob, questionDraftView]);

  useEffect(() => () => questionAnalysisPollRef.current?.abort(), []);

  const openQuestionAnalysisDialog = () => {
    if (!canAnalyzeQuestion || questionAnalysis.status === "loading") return;
    if (questionAnalysis.status === "ready" && questionAnalysis.result.context?.mode) {
      setQuestionAnalysisMode(questionAnalysis.result.context.mode);
    } else if (questionAnalysis.status === "error") {
      setQuestionAnalysisMode(questionAnalysis.mode);
    } else {
      setQuestionAnalysisMode("question");
    }
    setQuestionAnalysisDialogOpen(true);
  };

  const runQuestionAnalysis = (mode: QuestionAnalysisMode) => {
    if (!canAnalyzeQuestion || !sessionId || !entryId || questionAnalysis.status === "loading") return;
    if (mode === "context" && !canUseQuestionContext) return;
    questionAnalysisPollRef.current?.abort();
    setQuestionAnalysisDialogOpen(false);
    setQuestionAnalysis({ status: "loading", mode });
    setQuestionRewrite({ status: "idle" });
    setQuestionAnalysisOpen(true);
    void sendAgentCommand<QuestionAnalysisJobView>(sessionId, {
      type: "analyze_question",
      message: analysisTarget,
      contextMode: mode,
      entryId,
    }, remotePeer).then((job) => {
      if (!job?.jobId) throw new Error(labels.noResult);
      questionAnalysisJobIdRef.current = job.jobId;
      if (job.status === "completed" || job.status === "failed") {
        applyQuestionAnalysisJob(job);
      } else {
        setQuestionAnalysis({ status: "loading", mode: job.mode || mode });
        void pollQuestionAnalysisJob(job.jobId, job.mode || mode);
      }
    }).catch((error) => {
      setQuestionAnalysis({
        status: "error",
        mode,
        message: error instanceof Error ? error.message : labels.failed,
      });
    });
  };

  const runQuestionRewrite = useCallback(() => {
    if (!canRewriteQuestion || !sessionId || questionAnalysis.status !== "ready" || questionRewrite.status === "loading") return;
    setQuestionRewrite({ status: "loading" });
    void sendAgentCommand<QuestionRewriteResult>(sessionId, {
      type: "rewrite_question",
      question: analysisTarget,
      terms: questionAnalysis.result.text,
    }, remotePeer).then((result) => {
      if (!result?.text?.trim()) throw new Error(labels.noRewriteResult);
      setQuestionRewrite({ status: "ready", result });
    }).catch((error) => {
      setQuestionRewrite({
        status: "error",
        message: error instanceof Error ? error.message : labels.rewriteFailed,
      });
    });
  }, [analysisTarget, canRewriteQuestion, labels.noRewriteResult, labels.rewriteFailed, questionAnalysis, questionRewrite.status, remotePeer, sessionId]);

  const handleQuestionAnalysisButton = () => {
    if (questionAnalysis.status === "ready") {
      setQuestionAnalysisOpen((open) => !open);
      return;
    }
    openQuestionAnalysisDialog();
  };

  const imageBlocksNode = previewSources.length > 0 && (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: content ? 8 : 0, cursor: "zoom-in" }}>
      {previewSources.map((src, index) => (
        <ImagePreview
          key={`${src}-${index}`}
          src={src}
          images={previewSources}
          initialIndex={index}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt=""
            style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid rgba(59,130,246,0.15)" }}
          />
        </ImagePreview>
      ))}
    </div>
  );

  const copyContent = () => {
    copyText(copyTarget).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      className={forking ? "chat-message chat-message-user is-forking" : "chat-message chat-message-user"}
      style={{ marginBottom: 16, display: "flex", flexDirection: "column", alignItems: "flex-end" }}
    >
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, maxWidth: "85%" }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            background: isEditing ? "color-mix(in srgb, var(--accent) 14%, var(--user-bg))" : "var(--user-bg)",
            border: isEditing ? "1px solid color-mix(in srgb, var(--accent) 62%, var(--user-bg))" : "1px solid rgba(59,130,246,0.2)",
            boxShadow: isEditing ? "0 0 0 2px color-mix(in srgb, var(--accent) 16%, transparent)" : undefined,
            borderRadius: 12,
            padding: "8px 12px",
            fontSize: 14,
            lineHeight: 1.6,
            color: "var(--text)",
            wordBreak: "break-word",
            maxHeight: USER_BUBBLE_MAX_HEIGHT,
            overflowY: "auto",
          }}
        >
          {commandText ? (
            <div data-session-searchable="true" style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
              {imageBlocksNode}
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() => setExpanded((prev) => !prev)}
                  title={expanded ? t("i18n.collapse") : t("i18n.expand")}
                  aria-expanded={expanded}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    flexShrink: 0,
                    padding: 0,
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--accent)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 13,
                    textAlign: "left",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {commandName}
                  </span>
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: 0, opacity: 0.75, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
                    aria-hidden="true"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {commandArgs && (
                  <span style={{
                    color: "var(--text)",
                    fontSize: 14,
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    minWidth: 0,
                    flex: 1,
                  }}>
                    {commandArgs}
                  </span>
                )}
              </div>
              {expanded && (
                <div data-session-search-exclude="true">
                  <MarkdownBody className="markdown-user-message" keepLineBreaks cwd={cwd} sessionId={sessionId} remotePeer={remotePeer} onOpenFile={onOpenFile}>{content}</MarkdownBody>
                </div>
              )}
            </div>
          ) : (
            <>
              {imageBlocksNode}
              {content && (
                <div data-session-searchable="true" style={{ display: "contents" }}>
                  <SafeMarkdownBody className="markdown-user-message" keepLineBreaks literalHtml cwd={cwd} sessionId={sessionId} remotePeer={remotePeer} onOpenFile={onOpenFile}>{content}</SafeMarkdownBody>
                </div>
              )}
            </>
          )}
        </div>

      </div>

      {/* Bottom row: action buttons + timestamp */}
      {(time || canFork || canEdit || true) && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          gap: 6, marginTop: 3,
        }}>
          <div className="chat-message-actions" style={{
            display: "flex", gap: 3,
          }}>
            <button
              onClick={copyContent}
               title={t("i18n.copyMessage")}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "3px 8px", height: 22,
                background: "none", border: "none",
                borderRadius: 5,
                color: copied ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11, fontWeight: 400,
                whiteSpace: "nowrap",
                transition: "color 0.12s",
              }}
              onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--accent)"; }}
              onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              {copied ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
               {copied ? t("i18n.copied") : t("i18n.copy")}
            </button>
            <button
              type="button"
              className="chat-message-action"
              onClick={handleQuestionAnalysisButton}
              disabled={!canAnalyzeQuestion || questionAnalysis.status === "loading"}
              aria-haspopup="dialog"
              aria-expanded={questionAnalysis.status === "ready" ? questionAnalysisOpen : undefined}
              aria-label={analysisButtonLabel}
              title={canAnalyzeQuestion ? analysisButtonLabel : labels.unavailable}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "3px 8px", height: 22,
                background: "none", border: "none",
                borderRadius: 5,
                color: !canAnalyzeQuestion ? "var(--text-dim)" : questionAnalysis.status === "loading" ? "var(--accent)" : "var(--text-dim)",
                cursor: !canAnalyzeQuestion || questionAnalysis.status === "loading" ? "not-allowed" : "pointer",
                fontSize: 11, fontWeight: 400,
                whiteSpace: "nowrap",
                transition: "opacity 0.12s ease, color 0.12s",
              }}
              onMouseEnter={(e) => { if (canAnalyzeQuestion && questionAnalysis.status !== "loading") e.currentTarget.style.color = "var(--accent)"; }}
              onMouseLeave={(e) => { if (canAnalyzeQuestion && questionAnalysis.status !== "loading") e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z" />
                <path d="m19 16 .7 2.3L22 19l-.7-2.3L16 19l2.3-.7L19 16Z" />
              </svg>
              {analysisButtonLabel}
            </button>
          </div>
          {(canFork || canNavigate || canEdit || canCancelEdit) && (
            <div className="chat-message-actions" style={{
              display: "flex", gap: 3, alignItems: "center",
            }}>
              {canEdit && !canCancelEdit && (
                <button
                  onClick={() => {
                    onEditContent?.(editTarget, entryId!, isFirstUserMessage, {
                      transformInput: (input) => skillExpansionToCommand(input) ?? input,
                      ...(!isFirstUserMessage && onStartSideBranch && editNavigationEntryId
                        ? { sideBranchAnchor: editNavigationEntryId } : {}),
                    });
                  }}
                  title={canSideBranch ? t("chat.startSideBranchTitle") : t("message.pullBackEditTitle")}
                  style={{
                    display: "flex", alignItems: "center", gap: 4,
                    padding: "3px 8px", height: 22,
                    background: "none", border: "none",
                    borderRadius: 5,
                    color: "var(--text-dim)",
                    cursor: "pointer",
                    fontSize: 11, fontWeight: 400,
                    whiteSpace: "nowrap",
                    transition: "color 0.12s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                  {isFirstUserMessage ? t("message.pullBackEdit") : t("message.inPageFork")}
                </button>
              )}
              {canCancelEdit && (
                <button
                  type="button"
                  onClick={onCancelEdit}
                  title={t("i18n.cancel")}
                  aria-label={t("i18n.cancel")}
                  style={{
                    display: "flex", alignItems: "center", gap: 4,
                    padding: "3px 8px", height: 22,
                    background: "none", border: "none",
                    borderRadius: 5,
                    color: "var(--accent)",
                    cursor: "pointer",
                    fontSize: 11, fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                  {t("i18n.cancel")}
                </button>
              )}
              {canFork && (
                <button
                  onClick={() => { onFork!(entryId!); }}
                  disabled={forking}
                  title={forking ? t("message.creatingIndependentSession") : t("message.newSessionForkTitle")}
                  style={{
                    display: "flex", alignItems: "center", gap: 4,
                    padding: "3px 8px", height: 22,
                    background: "none", border: "none",
                    borderRadius: 5,
                    color: forking ? "var(--accent)" : "var(--text-dim)",
                    cursor: forking ? "not-allowed" : "pointer",
                    fontSize: 11, fontWeight: 400,
                    whiteSpace: "nowrap",
                    transition: "color 0.12s",
                  }}
                  onMouseEnter={(e) => { if (!forking) e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={(e) => { if (!forking) e.currentTarget.style.color = "var(--text-dim)"; }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="18" r="3" />
                    <circle cx="6" cy="6" r="3" />
                    <circle cx="18" cy="6" r="3" />
                    <path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9" />
                    <path d="M12 12v3" />
                  </svg>
                  {t("message.newSessionFork")}
                </button>
              )}
            </div>
          )}
          {time && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{time}</span>}
        </div>
      )}
      {questionAnalysisOpen && questionAnalysis.status !== "idle" && (
        <div
          role={questionAnalysis.status === "error" ? "alert" : "region"}
          aria-live={questionAnalysis.status === "loading" ? "polite" : undefined}
          aria-busy={questionAnalysis.status === "loading"}
          style={{
            alignSelf: "flex-end",
            width: "85%",
            maxHeight: 480,
            overflowY: "auto",
            marginTop: 6,
            padding: "9px 11px",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontSize: 12,
            lineHeight: 1.55,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, color: "var(--text-muted)", fontSize: 11, fontWeight: 600 }}>
            <span>{labels.title}</span>
            {questionAnalysis.status === "ready" && (
              <>
                <button
                  type="button"
                  onClick={openQuestionAnalysisDialog}
                  style={{ padding: 0, border: 0, background: "none", color: "var(--accent)", cursor: "pointer", fontSize: 11 }}
                >
                  {labels.changeScope}
                </button>
                <button
                  type="button"
                  onClick={runQuestionRewrite}
                  disabled={!canRewriteQuestion || questionRewrite.status === "loading"}
                  aria-label={questionRewrite.status === "loading" ? labels.rewriting : labels.rewrite}
                  title={canRewriteQuestion ? labels.rewrite : labels.unavailable}
                  style={{ marginLeft: "auto", padding: 0, border: 0, background: "none", color: "var(--accent)", cursor: !canRewriteQuestion || questionRewrite.status === "loading" ? "not-allowed" : "pointer", fontSize: 11, opacity: !canRewriteQuestion || questionRewrite.status === "loading" ? 0.55 : 1 }}
                >
                  {questionRewrite.status === "loading" ? labels.rewriting : labels.rewrite}
                </button>
              </>
            )}
          </div>
          {questionAnalysis.status === "loading" && (
            <div style={{ color: "var(--text-muted)" }}>{labels.analyzing}</div>
          )}
          {questionAnalysis.status === "error" && (
            <div style={{ color: "#ef4444", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {questionAnalysis.message}
            </div>
          )}
          {questionAnalysis.status === "ready" && (
            <>
              <MarkdownBody className="markdown-user-message" cwd={cwd} sessionId={sessionId} remotePeer={remotePeer} onOpenFile={onOpenFile}>
                {questionAnalysis.result.text}
              </MarkdownBody>
              <QuestionAnalysisUsageView result={questionAnalysis.result} labels={labels} />
              {questionRewrite.status !== "idle" && (
                <div style={{ marginTop: 9, paddingTop: 7, borderTop: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted)", fontSize: 11, fontWeight: 600 }}>
                    <span>{labels.rewriteTitle}</span>
                    {questionRewrite.status === "ready" && onEditContent && entryId && (
                      <button
                        type="button"
                        onClick={() => onEditContent(message, entryId, false, { text: questionRewrite.result.text })}
                        style={{ marginLeft: "auto", padding: 0, border: 0, background: "none", color: "var(--accent)", cursor: "pointer", fontSize: 11 }}
                      >
                        {labels.applyRewrite}
                      </button>
                    )}
                  </div>
                  {questionRewrite.status === "loading" && (
                    <div style={{ marginTop: 5, color: "var(--text-muted)" }}>{labels.rewriting}</div>
                  )}
                  {questionRewrite.status === "error" && (
                    <div style={{ marginTop: 5, color: "#ef4444", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                      {questionRewrite.message}
                    </div>
                  )}
                  {questionRewrite.status === "ready" && (
                    <>
                      <div style={{ marginTop: 5, color: "var(--text)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                        {questionRewrite.result.text}
                      </div>
                      <QuestionAnalysisUsageView result={questionRewrite.result} labels={labels} includeScope={false} />
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
      {questionAnalysisDialogOpen && (
        <QuestionAnalysisDialog
          labels={labels}
          mode={questionAnalysisMode}
          canUseContext={canUseQuestionContext}
          onModeChange={setQuestionAnalysisMode}
          onCancel={() => setQuestionAnalysisDialogOpen(false)}
          onConfirm={() => runQuestionAnalysis(questionAnalysisMode)}
        />
      )}
    </div>
  );
}

function QuestionAnalysisUsageView({ result, labels, includeScope = true }: { result: QuestionAnalysisResult; labels: QuestionAnalysisLabels; includeScope?: boolean }) {
  const { t } = useI18n();
  const usage = result.usage;
  if (!usage) return null;
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const total = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
  const cost = result.cost?.total;
  const pricingConfigured = result.pricing?.configured ?? result.pricingConfigured ?? false;
  const currency = result.pricing?.currency ?? "USD";
  const currencyPrefix = currency === "USD" ? "$" : `${currency} `;
  const costText = pricingConfigured && typeof cost === "number" && Number.isFinite(cost)
    ? `${currencyPrefix}${cost.toFixed(6)}`
    : labels.pricingUnavailable;
  const contextSource = result.context?.source;
  const scopeText = result.context?.mode === "context"
    ? contextSource === "existing-summary" || contextSource === "existing-summary+recent-context"
      ? labels.scopeContext
      : contextSource === "recent-context"
        ? labels.scopeRecent
        : labels.scopeNoContext
    : labels.scopeQuestion;

  return (
    <div style={{ marginTop: includeScope ? 9 : 7, paddingTop: includeScope ? 7 : 0, borderTop: includeScope ? "1px solid var(--border)" : "none", color: "var(--text-dim)", fontSize: 10, lineHeight: 1.5 }}>
      {includeScope && <div>{labels.scope}: {scopeText}</div>}
      <div>
        {t("questionAnalysis.usageLine", {
          total: total.toLocaleString(),
          input: input.toLocaleString(),
          output: output.toLocaleString(),
          cacheRead: cacheRead.toLocaleString(),
          cacheWrite: cacheWrite.toLocaleString(),
          cost: costText,
        })}
      </div>
    </div>
  );
}

function QuestionAnalysisDialog({ labels, mode, canUseContext, onModeChange, onCancel, onConfirm }: {
  labels: QuestionAnalysisLabels;
  mode: QuestionAnalysisMode;
  canUseContext: boolean;
  onModeChange: (mode: QuestionAnalysisMode) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,0.4)" }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="question-analysis-dialog-title"
        style={{ width: 460, maxWidth: "100%", border: "1px solid var(--border)", borderRadius: 9, background: "var(--bg-panel)", boxShadow: "0 12px 36px rgba(0,0,0,0.24)", overflow: "hidden" }}
      >
        <div style={{ padding: "16px 18px 10px" }}>
          <div id="question-analysis-dialog-title" style={{ color: "var(--text)", fontSize: 15, fontWeight: 700 }}>{labels.chooseTitle}</div>
          <div style={{ marginTop: 7, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.55 }}>{labels.chooseDescription}</div>
        </div>
        <fieldset style={{ display: "grid", gap: 8, margin: 0, padding: "4px 18px 14px", border: 0 }}>
          <label style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "9px 10px", border: `1px solid ${mode === "question" ? "var(--accent)" : "var(--border)"}`, borderRadius: 7, cursor: "pointer" }}>
            <input type="radio" name="question-analysis-mode" checked={mode === "question"} onChange={() => onModeChange("question")} style={{ marginTop: 2 }} />
            <span>
              <span style={{ display: "block", color: "var(--text)", fontSize: 12, fontWeight: 650 }}>{labels.modeQuestion}</span>
              <span style={{ display: "block", marginTop: 3, color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>{labels.modeQuestionDescription}</span>
            </span>
          </label>
          <label style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "9px 10px", border: `1px solid ${mode === "context" ? "var(--accent)" : "var(--border)"}`, borderRadius: 7, cursor: canUseContext ? "pointer" : "not-allowed", opacity: canUseContext ? 1 : 0.55 }}>
            <input type="radio" name="question-analysis-mode" checked={mode === "context"} disabled={!canUseContext} onChange={() => onModeChange("context")} style={{ marginTop: 2 }} />
            <span>
              <span style={{ display: "block", color: "var(--text)", fontSize: 12, fontWeight: 650 }}>{labels.modeContext}</span>
              <span style={{ display: "block", marginTop: 3, color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>{canUseContext ? labels.modeContextDescription : labels.contextUnavailable}</span>
            </span>
          </label>
        </fieldset>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 18px 14px", borderTop: "1px solid var(--border)" }}>
          <button type="button" onClick={onCancel} style={{ height: 30, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}>{labels.cancel}</button>
          <button type="button" onClick={onConfirm} disabled={mode === "context" && !canUseContext} style={{ height: 30, padding: "0 12px", border: "1px solid var(--accent)", borderRadius: 6, background: "var(--accent)", color: "var(--bg)", cursor: mode === "context" && !canUseContext ? "not-allowed" : "pointer", opacity: mode === "context" && !canUseContext ? 0.5 : 1, fontSize: 12, fontWeight: 650 }}>{labels.run}</button>
        </div>
      </div>
    </div>
  );
}

function AssistantMessageView({
  message,
  isStreaming,
  toolResults,
  modelNames,
  cwd,
  remotePeer,
  onOpenFile,
  showTimestamp,
  sessionId,
  entryId,
  onFork,
  forking,
  calculatedCost,
  imageGenerationCosts,
  turnUsage,
  turnResources,
  responseDurationMs,
  modelWaitPercent,
  writtenFiles,
  turnDurationMs,
  onCompact, isCompacting, compactError,
  onStartSideBranch,
  isSideBranch,
}: {
  message: AssistantMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  showTimestamp?: boolean;
  sessionId?: string;
  remotePeer?: string;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  calculatedCost?: number;
  imageGenerationCosts?: readonly ImageCost[];
  turnUsage?: TurnUsage;
  turnResources?: TurnResources;
  responseDurationMs?: number;
  modelWaitPercent?: number | null;
  writtenFiles?: WrittenFile[];
  turnDurationMs?: number;
  onCompact?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
  onStartSideBranch?: (entryId: string, previewText: string, beforeEntryId?: string) => void;
  isSideBranch?: boolean;
}) {
  const { t } = useI18n();
  const time = showTimestamp ? formatTime(message.timestamp) : null;
  const responseDuration = !isStreaming && responseDurationMs !== undefined
    ? formatResponseDuration(responseDurationMs)
    : null;
  const modelWaitShare = !isStreaming && modelWaitPercent !== undefined && modelWaitPercent !== null
    ? `${modelWaitPercent.toFixed(1)}%`
    : null;
  // Keep raw stream blocks for timing; only the render list collapses stale empty thinking placeholders.
  const rawBlockItems = useMemo(() => (message.content ?? [])
    .map((block, originalIndex) => ({ block, originalIndex })), [message.content]);
  const blockItems = useMemo(() => rawBlockItems.filter(({ block, originalIndex }) => (
    isDisplayableAssistantBlock(block, originalIndex, rawBlockItems.length, { isStreaming })
  )), [isStreaming, rawBlockItems]);
  const blocks = useMemo(() => blockItems.map(({ block }) => block), [blockItems]);
  // Image-generation providers can time out after returning a usable image.
  // Keep the delivered image as the answer instead of appending a misleading
  // error banner that makes an otherwise valid result overflow the transcript.
  const hasDeliveredMarkdownImage = blocks.some((block) => (
    block.type === "text" && /!\[[^\]]*\]\([^)]+\)/.test(block.text)
  ));
  const providerError = hasDeliveredMarkdownImage
    ? null
    : getAssistantErrorMessage(message, { isStreaming });
  const truncated = isAssistantTruncated(message, { isStreaming });
  const unansweredTruncation = truncated && !hasAssistantAnswer(message);
  const [copied, setCopied] = useState(false);
  const [resourcesExpanded, setResourcesExpanded] = useState(false);
  const streamStartRef = useRef<number | null>(null);
  const [tps, setTps] = useState<number | null>(null);
  const rawBlockItemsRef = useRef(rawBlockItems);
  rawBlockItemsRef.current = rawBlockItems;
  const tokenEstimateCacheRef = useRef<Map<number, TokenEstimateCacheEntry>>(new Map());
  const estimatedTokens = useMemo(() => {
    if (!isStreaming) {
      tokenEstimateCacheRef.current = new Map();
      return 0;
    }
    const nextCache = new Map<number, TokenEstimateCacheEntry>();
    let total = 0;
    for (const { block, originalIndex } of rawBlockItems) {
      const text = getTokenEstimateText(block);
      if (text === null) continue;
      const tokens = estimateUpdatedTokens(tokenEstimateCacheRef.current.get(originalIndex), text);
      nextCache.set(originalIndex, { text, tokens });
      total += tokens;
    }
    tokenEstimateCacheRef.current = nextCache;
    return total;
  }, [isStreaming, rawBlockItems]);
  const estimatedTokensRef = useRef(estimatedTokens);
  estimatedTokensRef.current = estimatedTokens;

  const displayedUsage = turnUsage ?? message.usage;

  // Streaming-based timing for thinking blocks
  const blockStartTimesRef = useRef<Map<number, number>>(new Map());
  const [streamingDurations, setStreamingDurations] = useState<Map<number, number>>(new Map());

  // Historical assistant timing is one model-round estimate: producer request
  // start -> outer JSONL append. JSONL has no per-thinking-block boundaries, so
  // never present this value as the duration of an individual thinking block.
  const modelWaitDurationMs = useMemo<number | undefined>(() => {
    const measured = normalizeMeasuredDurationMs(message.durationMs);
    if (measured !== undefined) return measured;
    const durationMs = calculateResponseDurationMs(message.timestamp, message.entryTimestamp);
    return durationMs !== undefined && durationMs >= 0 ? durationMs : undefined;
  }, [message.durationMs, message.timestamp, message.entryTimestamp]);

  // Persisted tool boundaries identify a single wall-clock batch, not reliable
  // per-tool start times. Show it once, on the first tool call, and never make
  // a later serial tool look like it includes all earlier tools.
  const toolBatchTiming = useMemo<{ durationMs: number; firstToolCallId: string } | undefined>(() => {
    const toolCalls = (message.content ?? []).filter((block): block is ToolCallContent => block.type === "toolCall");
    if (!toolResults || toolCalls.length === 0) return undefined;
    const toolCallIds = new Set(toolCalls.map((call) => call.toolCallId));
    const results = Array.from(toolResults.values())
      .filter((result) => toolCallIds.has(result.toolCallId));
    if (results.length !== toolCalls.length) return undefined;
    const timing = computeAssistantTiming(message, results);
    if (timing.toolBatchQuality !== "complete" || timing.toolBatchMs === undefined || timing.toolBatchMs <= 0) return undefined;
    return { durationMs: timing.toolBatchMs, firstToolCallId: toolCalls[0].toolCallId };
  }, [message, toolResults]);

  const textContent = blocks
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const copyContent = () => {
    copyText(textContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  useEffect(() => {
    if (!isStreaming) {
      // Finalise any un-finished thinking block durations on stream end
      const now = new Date().getTime();
      setStreamingDurations((prev: Map<number, number>) => {
        const next = new Map(prev);
        for (const [idx, start] of blockStartTimesRef.current) {
          if (!next.has(idx)) next.set(idx, Math.round((now - start) / 1000));
        }
        return next;
      });
      streamStartRef.current = null;
      setTps(null);
      return;
    }
    const tick = () => {
      const items = rawBlockItemsRef.current;
      const now = Date.now();

      // Record start time for each block the first time we see it
      items.forEach(({ originalIndex }) => {
        if (!blockStartTimesRef.current.has(originalIndex)) blockStartTimesRef.current.set(originalIndex, now);
      });

      // When a non-last block has a successor already started, finalise its duration
      setStreamingDurations((prev: Map<number, number>) => {
        let changed = false;
        const next = new Map(prev);
        for (let i = 0; i < items.length - 1; i++) {
          const originalIndex = items[i].originalIndex;
          const nextOriginalIndex = items[i + 1].originalIndex;
          if (!next.has(originalIndex) && blockStartTimesRef.current.has(originalIndex)) {
            const start = blockStartTimesRef.current.get(originalIndex)!;
            const nextStart = blockStartTimesRef.current.get(nextOriginalIndex) ?? now;
            next.set(originalIndex, Math.round((nextStart - start) / 1000));
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      const tokens = estimatedTokensRef.current;
      if (tokens === 0) return;
      if (streamStartRef.current === null) streamStartRef.current = now;
      const elapsed = (now - streamStartRef.current) / 1000;
      if (elapsed > 0.5) setTps(tokens / elapsed);
    };
    const id = setInterval(tick, 300);
    return () => clearInterval(id);
  }, [isStreaming]);

  if (blocks.length === 0 && !isStreaming && !providerError && !truncated) return null;

  return (
    <div className="chat-message chat-message-assistant" style={{ marginBottom: 16 }}>
      {/* Model label */}
      <div
        style={{
          fontSize: 11,
          color: "var(--text-dim)",
          marginBottom: 4,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {message.provider && (
          <span>{modelNames?.[`${message.provider}:${message.model}`] ?? modelNames?.[message.model] ?? message.model}</span>
        )}
        {isStreaming && (() => {
          const est = Math.round(estimatedTokens);
          return (
            <>

              {est > 0 && (
                <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text)" }} title={t("i18n.estimatedTokens")}>
                  <span style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 11, fontWeight: 400 }}>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                    {est}
                  </span>
                  {tps !== null && (() => {
                    const bg = tps >= 50 ? "#53b3cb" : tps >= 30 ? "#9bc53d" : tps >= 15 ? "#f9c22e" : "#e01a4f";
                    return (
                      <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 4, background: bg, color: "#fff", fontSize: 11, fontWeight: 400 }}>
                        {tps.toFixed(1)} t/s
                      </span>
                    );
                  })()}
                </span>
              )}
            </>
          );
        })()}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {isStreaming && blockItems.length === 0 && (
          <div style={{ color: "var(--text-muted)", fontSize: 12, fontStyle: "italic" }}>
            {t("chat.thinking")}
          </div>
        )}
        {/* Not keyed by the entry id: a message of this run gets one when the file is
            read again, and its blocks keep their state across that read (#1184). */}
        {blockItems.map(({ block, originalIndex }) => (
          <BlockView key={originalIndex} block={block} toolResults={toolResults} isStreaming={isStreaming} streamingDuration={block.type === "thinking" ? streamingDurations.get(originalIndex) : undefined} toolBatchDurationMs={toolBatchTiming?.durationMs} toolBatchCallId={toolBatchTiming?.firstToolCallId} cwd={cwd} remotePeer={remotePeer} onOpenFile={onOpenFile} sessionId={sessionId} entryId={entryId} blockIndex={originalIndex} imageGenerationCosts={imageGenerationCosts} />
        ))}
      </div>

      {providerError && (
        <div
          role="alert"
          style={{
            marginTop: blocks.length > 0 ? 8 : 0,
            padding: "7px 10px",
            border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 6,
            background: "rgba(239,68,68,0.07)",
            color: "#ef4444",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          Error: {providerError}
        </div>
      )}

      {truncated && (
        <div
          role="alert"
          style={{
            marginTop: blocks.length > 0 || providerError ? 8 : 0,
            padding: "7px 10px",
            border: "1px solid rgba(234,179,8,0.3)",
            borderRadius: 6,
            background: "rgba(234,179,8,0.07)",
            color: "#ca8a04",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {t(unansweredTruncation ? "chat.truncatedWithoutAnswer" : "chat.truncatedByOutputLimit")}
          {unansweredTruncation && onCompact && (
            <button
              type="button"
              onClick={onCompact}
              disabled={isCompacting}
              style={{
                display: "block",
                marginTop: 8,
                padding: "3px 8px",
                border: "1px solid currentColor",
                borderRadius: 5,
                background: "transparent",
                color: "inherit",
                cursor: isCompacting ? "default" : "pointer",
                font: "inherit",
              }}
            >
              {t(isCompacting ? "chat.compacting" : "chat.compactContext")}
            </button>
          )}
          {unansweredTruncation && compactError && (
            <div style={{ marginTop: 8, color: "#ef4444", whiteSpace: "pre-wrap" }}>{compactError}</div>
          )}
        </div>
      )}

      {writtenFiles && writtenFiles.length > 0 && (
        <TurnWrittenFiles files={writtenFiles} onOpenFile={onOpenFile} />
      )}

      <div style={{
        display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 4,
      }}>
        {(displayedUsage || turnDurationMs !== undefined) && !isStreaming && (
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {[
              displayedUsage ? formatUsage(displayedUsage, t("chat.turnCacheHitRate"), t("chat.turnCacheUnavailable"), calculatedCost) : null,
              turnDurationMs !== undefined ? t("chat.turnDuration", { time: formatTurnDuration(turnDurationMs) }) : null,
            ].filter(Boolean).join(" \u00b7 ")}
          </div>
        )}
        {turnResources && !isStreaming && (
          <button
            type="button"
            data-turn-resources-toggle
            aria-expanded={resourcesExpanded}
            onClick={() => setResourcesExpanded((expanded) => !expanded)}
            style={{ padding: "3px 7px", border: "1px solid var(--border)", borderRadius: 5, background: "none", color: "var(--text-muted)", fontSize: 11, cursor: "pointer" }}
          >
            {t("chat.turnResources")}
          </button>
        )}

        <div className="chat-message-actions" style={{ display: "flex", alignItems: "center", gap: 3 }}>
          {onStartSideBranch && entryId && !isStreaming && (
            <button
              className="chat-message-action"
              onClick={() => onStartSideBranch(entryId, textContent || "")}
              title={t("chat.startSideBranchTitle")}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "3px 8px", height: 22,
                background: "none", border: "none",
                borderRadius: 5,
                color: "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11, fontWeight: 400,
                whiteSpace: "nowrap",
                transition: "opacity 0.12s ease, color 0.12s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <line x1="6" y1="3" x2="6" y2="15" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
              {t("message.inPageFork")}
            </button>
          )}
          {onFork && entryId && !isStreaming && (
            <button
              className="chat-message-action"
              onClick={() => { onFork(entryId); }}
              disabled={forking}
              title={forking ? t("message.creatingIndependentSession") : t("message.newSessionForkTitle")}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "3px 8px", height: 22,
                background: "none", border: "none",
                borderRadius: 5,
                color: forking ? "var(--accent)" : "var(--text-dim)",
                cursor: forking ? "not-allowed" : "pointer",
                fontSize: 11, fontWeight: 400,
                whiteSpace: "nowrap",
                transition: "opacity 0.12s ease, color 0.12s",
              }}
              onMouseEnter={(e) => { if (!forking) e.currentTarget.style.color = "var(--accent)"; }}
              onMouseLeave={(e) => { if (!forking) e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="18" r="3" />
                <circle cx="6" cy="6" r="3" />
                <circle cx="18" cy="6" r="3" />
                <path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9" />
                <path d="M12 12v3" />
              </svg>
              {t("message.newSessionFork")}
            </button>
          )}
          {textContent && !isStreaming && (
            <button
              className="chat-message-action"
              onClick={copyContent}
              title={t("i18n.copyMessage")}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "3px 8px", height: 22,
                background: "none", border: "none",
                borderRadius: 5,
                color: copied ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11, fontWeight: 400,
                whiteSpace: "nowrap",
                transition: "opacity 0.12s ease, color 0.12s",
              }}
              onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--accent)"; }}
              onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              {copied ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
              {copied ? t("i18n.copied") : t("i18n.copy")}
            </button>
          )}
        </div>
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginLeft: "auto",
          flexShrink: 0,
          fontSize: 11,
          color: "var(--text-dim)",
          fontVariantNumeric: "tabular-nums",
        }}>
          {time && <span>{time}</span>}
          {responseDuration && !isStreaming && (
            <span>{t("chat.responseDuration", { duration: responseDuration })}</span>
          )}
          {modelWaitShare && (
            <span title={t("chat.modelWaitShareTitle")}>
              {t("chat.modelWaitShare", { percent: modelWaitShare })}
            </span>
          )}
          {modelWaitPercent === undefined && modelWaitDurationMs !== undefined && !isStreaming && (
            <span title={t("chat.modelWaitDurationTitle")}>
              {t("chat.modelWaitDuration", { duration: formatResponseDuration(modelWaitDurationMs) })}
            </span>
          )}
        </div>
      </div>
      {turnResources && resourcesExpanded && !isStreaming && <TurnResourcesPanel resources={turnResources} />}
    </div>
  );
}

export function TurnResourcesPanel({ resources }: { resources: TurnResources }) {
  const { t } = useI18n();
  const toolCount = resources.tools.reduce((sum, item) => sum + item.count, 0);
  const nestedCount = resources.nestedTools.reduce((sum, item) => sum + item.count, 0);
  const skillCount = resources.skills.reduce((sum, item) => sum + item.count, 0);
  const plugins = resources.plugins ?? [];
  const pluginCount = plugins.reduce((sum, item) => sum + item.count, 0);
  const inlineListStyle: CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    gap: "3px 16px",
    margin: "4px 0 8px",
    padding: 0,
    listStyle: "none",
  };
  const inlineListItemStyle: CSSProperties = {
    minWidth: 0,
    overflowWrap: "anywhere",
  };
  return (
    <div data-turn-resources-panel data-session-search-exclude="true" style={{ marginTop: 6, padding: "9px 12px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", fontSize: 11, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
      <div style={{ marginBottom: 8, color: "var(--text-dim)" }}>{t("chat.turnResourceEvidence")}</div>
      <strong>{t("chat.turnToolCount", { count: toolCount })}</strong>
      {resources.tools.length > 0 ? <ul style={inlineListStyle}>{resources.tools.map((item) => <li key={item.name} style={inlineListItemStyle}>{item.name} × {item.count}</li>)}</ul> : <div>{t("chat.turnNoTools")}</div>}
      {(nestedCount > 0 || resources.omittedNestedCalls > 0) && (
        <>
          <strong>{t("chat.turnNestedToolCount", { count: nestedCount })}</strong>
          <ul style={inlineListStyle}>{resources.nestedTools.map((item) => <li key={item.name} style={inlineListItemStyle}>{item.name} × {item.count}</li>)}</ul>
          {resources.omittedNestedCalls > 0 && <div>{t("chat.turnOmittedCalls", { count: resources.omittedNestedCalls })}</div>}
        </>
      )}
      {skillCount > 0 && (
        <>
          <strong>{t("chat.turnSkillCount", { count: skillCount })}</strong>
          <ul style={inlineListStyle}>{resources.skills.map((item) => <li key={item.path} title={item.path} style={inlineListItemStyle}>{item.name} × {item.count}<span style={{ color: "var(--text-dim)" }}> · {item.path}</span></li>)}</ul>
        </>
      )}
      {pluginCount > 0 && (
        <>
          <strong>{t("chat.turnPluginCount", { count: pluginCount })}</strong>
          <ul style={inlineListStyle}>{plugins.map((item) => <li key={`${item.source}:${item.path}`} title={item.path} style={inlineListItemStyle}>{item.name} × {item.count}<span style={{ color: "var(--text-dim)" }}> · {item.tools.map((tool) => `${tool.name} × ${tool.count}`).join(", ")}</span></li>)}</ul>
        </>
      )}
    </div>
  );
}

function BlockView({ block, toolResults, isStreaming, streamingDuration, toolBatchDurationMs, toolBatchCallId, cwd, remotePeer, onOpenFile, sessionId, entryId, blockIndex, imageGenerationCosts }: { block: AssistantContentBlock; toolResults?: Map<string, ToolResultMessage>; isStreaming?: boolean; streamingDuration?: number; toolBatchDurationMs?: number; toolBatchCallId?: string; cwd?: string; remotePeer?: string; onOpenFile?: (filePath: string) => void; sessionId?: string; entryId?: string; blockIndex: number; imageGenerationCosts?: readonly ImageCost[] }) {
  if (block.type === "text") {
    return <TextBlock block={block as TextContent} isStreaming={isStreaming} cwd={cwd} remotePeer={remotePeer} sessionId={sessionId} onOpenFile={onOpenFile} imageGenerationCosts={imageGenerationCosts} />;
  }
  if (block.type === "thinking") {
    return <ThinkingBlock block={block as ThinkingContent} duration={streamingDuration} />;
  }
  if (block.type === "toolCall") {
    const tc = block as ToolCallContent;
    const result = toolResults?.get(tc.toolCallId);
    const durationMs = result?.durationMs !== undefined
      ? normalizeMeasuredDurationMs(result.durationMs)
      : tc.toolCallId === toolBatchCallId ? toolBatchDurationMs : undefined;
    return <ToolCallBlock block={tc} result={result} durationMs={durationMs} sessionId={sessionId} remotePeer={remotePeer} imageGenerationCosts={imageGenerationCosts} />;
  }
  return null;
}

function TextBlock({ block, isStreaming, cwd, remotePeer, sessionId, onOpenFile, imageGenerationCosts }: { block: TextContent; isStreaming?: boolean; cwd?: string; remotePeer?: string; sessionId?: string; onOpenFile?: (filePath: string) => void; imageGenerationCosts?: readonly ImageCost[] }) {
  return (
    <div data-session-searchable="true" style={{ display: "contents" }}>
      <SafeMarkdownBody dedupeImages isStreaming={isStreaming} cwd={cwd} remotePeer={remotePeer} sessionId={sessionId} onOpenFile={onOpenFile} imageGenerationCosts={imageGenerationCosts}>{block.text}</SafeMarkdownBody>
    </div>
  );
}

// A model looping in its thinking can write megabytes. As one text node, every
// streamed chunk laid all of it out again (the prompt anchor reads layout after
// each commit). As pieces, only the last one changes. Thinking that fits one
// piece stays one text node.
function ThinkingText({ text }: { text: string }) {
  const pieces = useMemo(() => splitThinkingPieces(text), [text]);
  if (pieces.length === 1) return text;
  return pieces.map((piece, index) => <div key={index}>{piece.text}</div>);
}

function ThinkingBlock({ block, duration }: { block: ThinkingContent; duration?: number }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const toggle = () => setExpanded((value) => !value);

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 6,
        overflow: "hidden",
        fontSize: 13,
      }}
    >
      <button
        onClick={toggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "6px 10px",
          background: "var(--bg-panel)",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
      >
         <span>{t("i18n.thinking")}</span>
        {duration !== undefined && (
          <span title={t("chat.streamingBlockDurationTitle")} style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
            {t("chat.streamingBlockDuration", { duration: `${duration}s` })}
          </span>
        )}
      </button>
      {expanded && (
        <div
          style={{
            padding: "8px 10px",
            color: "var(--text-muted)",
            fontSize: 12,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            background: "var(--bg-panel)",
            borderTop: "1px solid var(--border)",
          }}
        >
           <ThinkingText text={block.thinking ?? ""} />
        </div>
      )}
    </div>
  );
}


function isSubagentToolDetails(value: unknown): value is SubagentToolDetails {
  if (!value || typeof value !== "object") return false;
  const details = value as Partial<SubagentToolDetails>;
  return details.kind === "pi-web-subagent" && typeof details.sessionId === "string";
}

function ToolCallBlock({ block, result, durationMs, sessionId, remotePeer, onOpenSession, imageGenerationCosts }: { block: ToolCallContent; result?: ToolResultMessage; durationMs?: number; sessionId?: string; remotePeer?: string; onOpenSession?: (sessionId: string) => void; imageGenerationCosts?: readonly ImageCost[] }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(() => isToolCallExpanded(block.toolCallId));
  const [fullResultText, setFullResultText] = useState<string | null>(null);
  const [fullResultLoading, setFullResultLoading] = useState(false);
  const [fullResultError, setFullResultError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded || !result?.deferredText || fullResultText !== null || !sessionId || !result.entryId) return;
    let cancelled = false;
    setFullResultError(null);
    setFullResultLoading(true);
    const url = apiPathForPeer(
      remotePeer,
      `sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(result.entryId)}/tool-result`,
    );
    void fetch(url, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as { text?: unknown; error?: string };
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (typeof body.text !== "string") throw new Error("Invalid tool result response");
        return body.text;
      })
      .then((text) => {
        if (!cancelled) setFullResultText(text);
      })
      .catch((error) => {
        if (!cancelled) setFullResultError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setFullResultLoading(false);
      });
    return () => { cancelled = true; };
  }, [expanded, fullResultText, remotePeer, result?.deferredText, result?.entryId, sessionId]);
  const inputStr = getToolCallInputText(block);
  const isStreamingInput = block.rawInput !== undefined;  const isEditTool = isEditToolName(block.toolName);
  const resultDiff = result && !result.isError ? getResultDiff(result) : null;
  const resultPatchPath = useMemo(() => {
    if (!resultDiff?.text) return null;
    const files = parseUnifiedPatch(resultDiff.text);
    if (files?.length !== 1) return null;
    const file = files[0];
    const path = file.newPath && file.newPath !== "/dev/null" ? file.newPath : file.oldPath && file.oldPath !== "/dev/null" ? file.oldPath : null;
    return path && file.oldPath?.startsWith("a/") && file.newPath?.startsWith("b/") ? path.slice(2) : path;
  }, [resultDiff?.text]);
  const patchFiles = getApplyPatchFiles(block, result);
  const patchLabel = isApplyPatchToolName(block.toolName)
    ? summarizeApplyPatchInput(block)
    : null;
  // A script and the calls it made, instead of the input JSON. Streamed input is
  // still incomplete JSON and keeps the generic view.
  const codemodeCode = block.toolName === CODEMODE_TOOL_NAME && !isStreamingInput ? codemodeScript(block.input) : null;
  const codemode = codemodeCode === null ? null : { code: codemodeCode, ...codemodeCalls(result?.details) };
  // A running script's progress snapshot has calls but no content yet.
  const codemodeRunning = codemode !== null && result !== undefined && result.content.length === 0;

  // `server/tool` instead of the registered `mcp__server__tool`, as pi's TUI shows it.
  const mcpLabel = mcpToolLabel(block.toolName, result?.details);

  // Result display
  const resultContent = result ? (codemode ? stripCodemodeHeader(result.content) : result.content) : [];
  const joinedResultText = result
    ? resultContent.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n")
    : null;
  const resultText = mcpLabel && joinedResultText !== null ? prettyMcpResultText(joinedResultText) : joinedResultText;
  const resultIsEmpty = resultText === null ? false : (resultText.trim() === "(no output)" || resultText.trim() === "");
  const displayedResultIsEmpty = fullResultText === null
    ? resultIsEmpty
    : fullResultText.trim() === "(no output)" || fullResultText.trim() === "";
  const isError = (result?.isError ?? false)
    || (isApplyPatchToolName(block.toolName) && applyPatchResultHasFailures(result?.details));
  const resultImages = resultContent.filter((block): block is ImageContent => block.type === "image");
  const reconciledImageCosts = imageGenerationCosts?.filter((cost) => cost.billing.toolCallId === block.toolCallId || cost.billing.toolCallId?.startsWith(`${block.toolCallId}/`)) ?? [];
  const imageCosts = mergeImageGenerationCosts(block.toolName === "generate_image" ? imageGenerationCostsFromDetails(result?.details) : [], reconciledImageCosts);
  // Flat scalar arguments read better as one row each. Nested input keeps the
  // JSON view, where a subtree cannot be silently dropped. Streamed input is
  // still incomplete and never rendered as fields.
  const toolFields = isStreamingInput || isEditTool || block.toolName === CODEMODE_TOOL_NAME
    ? null
    : toolFieldsOfInput(block.input);
  const codemodeCallCount = codemode ? codemode.calls.length + codemode.omitted : 0;
  const displayedResultText = fullResultText === null
    ? resultText ?? ""
    : mcpLabel ? prettyMcpResultText(fullResultText) : fullResultText;

  return (
    <div
      style={{
        borderRadius: 7,
        overflow: "hidden",
        fontSize: 12,
        border: isError ? "1px solid rgba(248,113,113,0.45)" : "1px solid rgba(34,197,94,0.25)",
        background: isError ? "rgba(248,113,113,0.05)" : "rgba(34,197,94,0.04)",
      }}
    >
      {/* ── Tool call header ── */}
      <button
        onClick={() => setExpanded((value) => {
          setToolCallExpanded(block.toolCallId, !value);
          return !value;
        })}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: "100%",
          padding: "6px 10px",
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
          minWidth: 0,
        }}
      >
        <span title={mcpLabel ? block.toolName : undefined} style={{ color: isError ? "#f87171" : "#16a34a", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 11, flexShrink: 0 }}>
          {mcpLabel ? <><span style={{ fontWeight: 500, opacity: 0.75 }}>{mcpLabel.server}/</span>{mcpLabel.tool}</> : block.toolName}
        </span>
        <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
          {isStreamingInput ? t("chat.generatingToolInput") : (patchLabel ?? (codemode ? codemodeScriptPreview(codemode.code) : getToolPreview(block, resultPatchPath)))}
        </span>
        {codemodeCallCount > 0 && (
          <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
            {codemodeCallCount === 1 ? t("codemode.callCountOne") : t("codemode.callCount", { count: codemodeCallCount })}
          </span>
        )}
        {durationMs !== undefined && (
          <span title={t("chat.toolBatchDurationTitle")} style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
            {t("chat.toolBatchDuration", { duration: formatResponseDuration(durationMs) })}
          </span>
        )}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>

      <ImageGenerationCost costs={imageCosts} />

      {/* ── Expanded: input args (only when no richer view exists); a codemode script in place of its JSON ── */}
      {expanded && (isStreamingInput || !isEditTool) && !patchFiles && (
        toolFields ? (
          <dl
            className="tool-call-fields"
            style={{
              margin: 0,
              padding: "8px 10px",
              display: "grid",
              gridTemplateColumns: "max-content minmax(0, 1fr)",
              gap: "2px 10px",
              alignItems: "baseline",
              color: "var(--text-muted)",
              fontSize: 12,
              lineHeight: 1.5,
              background: "var(--bg-subtle)",
              borderTop: isError ? "1px solid rgba(248,113,113,0.25)" : "1px solid rgba(34,197,94,0.2)",
            }}
          >
            {toolFields.map((field) => (
              <Fragment key={field.key}>
                <dt style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{field.key}</dt>
                <dd
                  style={{
                    margin: 0,
                    fontFamily: "var(--font-mono)",
                    overflowWrap: "anywhere",
                    whiteSpace: field.multiline ? "pre-wrap" : "normal",
                  }}
                >
                  {field.value}
                </dd>
              </Fragment>
            ))}
          </dl>
        ) : (
        <pre
          style={{
            margin: 0,
            padding: "8px 10px",
            color: "var(--text-muted)",
            fontSize: 12,
            lineHeight: 1.5,
            overflow: "auto",
            background: "var(--bg-subtle)",
            borderTop: isError ? "1px solid rgba(248,113,113,0.25)" : "1px solid rgba(34,197,94,0.2)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {codemode ? codemode.code.replace(/\r/g, "").trimEnd() : inputStr}
        </pre>
        )
      )}

      {expanded && codemode && (
        <CodemodeCallList calls={codemode.calls} omitted={codemode.omitted} isError={isError} />
      )}

      {/* ── Expanded: applied-patch split diff ── */}
      {expanded && patchFiles && (
        <div style={{ borderTop: "1px solid rgba(34,197,94,0.15)", background: "var(--bg)" }}>
          <SplitFilesView files={patchFiles} />
        </div>
      )}

      {/* ── Paired result — only shown when expanded ── */}
      {expanded && result && patchFiles && isError && (
        <PairedResult
          text={resultText ?? ""}
          isEmpty={resultIsEmpty}
          isError={isError}
          images={resultImages}
          sessionId={sessionId}
          remotePeer={remotePeer}
        />
      )}
      {expanded && result && !patchFiles && !codemodeRunning && (
        resultDiff ? (
          <PairedDiffResult
            diff={resultDiff}
          />
        ) : (
          <PairedResult
            text={displayedResultText}
            isEmpty={displayedResultIsEmpty}
            isError={isError}
            images={resultImages}
            sessionId={sessionId}
            remotePeer={remotePeer}
            loadingFullResult={fullResultLoading}
            fullResultError={fullResultError}
          />
        )
      )}
    </div>
  );
}

interface ResultDiff {
  text: string;
}

function PairedDiffResult({ diff }: {
  diff: ResultDiff;
}) {
  return (
    <div
      style={{
        borderTop: "1px solid rgba(34,197,94,0.15)",
        background: "var(--bg)",
      }}
    >
      <SplitPatchView text={diff.text} />
    </div>
  );
}

function SplitFilesView({ files }: { files: SplitDiffFile[] }) {
  const { t } = useI18n();
  const showFileHeaders = files.length > 1;

  return (
    <div style={{ maxHeight: 560, overflowY: "auto", overflowX: "hidden", background: "var(--bg)" }}>
      {files.map((file, fileIndex) => (
        <div
          key={fileIndex}
          style={{
            minWidth: 0,
            borderTop: fileIndex === 0 ? "none" : "1px solid var(--border)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.55,
          }}
        >
          {showFileHeaders && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                position: "sticky",
                top: 0,
                zIndex: 1,
                background: "var(--bg-panel)",
                borderBottom: "1px solid var(--border)",
              }}
            >
               <SplitDiffHeader title={file.oldPath || t("i18n.before")} side="left" />
               <SplitDiffHeader title={file.newPath || t("i18n.after")} side="right" />
            </div>
          )}

          <div className="chat-split-diff-grid">
            {file.rows.map((row, rowIndex) => {
              if (row.type === "hunk") {
                return <div key={rowIndex} style={{ gridColumn: "1 / -1", padding: "3px 10px", color: "var(--text-dim)", background: "var(--bg-panel)", overflowWrap: "anywhere" }}>{row.text}</div>;
              }

              return (
                <div key={rowIndex} style={{ display: "contents" }}>
                  <SplitDiffCellView cell={row.left} side="left" />
                  <SplitDiffCellView cell={row.right} side="right" />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function SplitPatchView({ text }: { text: string }) {
  const files = useMemo(() => parseUnifiedPatch(text), [text]);
  if (!files) return <PatchTextView text={text} />;
  return <SplitFilesView files={files} />;
}

function getApplyPatchFiles(block: ToolCallContent, result?: ToolResultMessage): SplitDiffFile[] | null {
  if (!isApplyPatchToolName(block.toolName)) return null;

  const details = result && !result.isError ? (result as ToolResultMessage & { details?: unknown }).details : undefined;
  if (isRecord(details)) {
    const fromPreview = applyPatchPreviewToFiles(details.preview);
    if (fromPreview) return fromPreview;
  }

  const fromInput = parseApplyPatchInput(getApplyPatchInputText(block.input, block.rawInput));
  if (fromInput) return fromInput;

  return null;
}

function summarizeApplyPatchInput(block: ToolCallContent): string | null {
  const paths = extractApplyPatchPaths(getApplyPatchInputText(block.input, block.rawInput));
  if (paths.length === 0) return null;
  return paths.join(", ").slice(0, 120);
}

function SplitDiffHeader({ title, side }: { title: string; side: "left" | "right" }) {
  return (
    <div
      title={title}
      style={{
        padding: "5px 10px",
        color: "var(--text-dim)",
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {title}
    </div>
  );
}

function SplitDiffCellView({ cell, side }: { cell: SplitDiffCell; side: "left" | "right" }) {
  const bg =
    cell.type === "added"
      ? "rgba(34,197,94,0.12)"
      : cell.type === "removed"
      ? "rgba(248,113,113,0.13)"
      : cell.type === "empty"
      ? "var(--bg-subtle)"
      : "transparent";
  const marker =
    cell.type === "added" ? "+" : cell.type === "removed" ? "-" : " ";
  const markerColor =
    cell.type === "added" ? "#22c55e" : cell.type === "removed" ? "#f87171" : "var(--text-dim)";

  return (
    <div
      className={`chat-split-diff-cell is-${side} is-${cell.type}`}
      style={{
        display: "flex",
        minWidth: 0,
        background: bg,
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
      }}
    >
      <span
        style={{
          width: 42,
          padding: "0 6px",
          textAlign: "right",
          color: "var(--text-dim)",
          userSelect: "none",
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        {cell.lineNo ?? ""}
      </span>
      <span
        style={{
          width: 18,
          padding: "0 5px",
          color: markerColor,
          userSelect: "none",
          fontWeight: cell.type === "context" || cell.type === "empty" ? 400 : 700,
          flexShrink: 0,
        }}
      >
        {marker}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          padding: "0 10px 0 0",
          color: cell.type === "empty" ? "var(--text-dim)" : "var(--text)",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {cell.text || "\u00a0"}
      </span>
    </div>
  );
}

function PatchTextView({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);

  return (
    <div style={{ maxHeight: 520, overflowY: "auto", overflowX: "hidden", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.55, minWidth: 0 }}>
      {lines.map((line, i) => {
        const kind =
          line.startsWith("@@") ? "hunk" :
          line.startsWith("+") && !line.startsWith("+++") ? "added" :
          line.startsWith("-") && !line.startsWith("---") ? "removed" :
          "context";
        const bg =
          kind === "added" ? "rgba(34,197,94,0.12)" :
          kind === "removed" ? "rgba(248,113,113,0.13)" :
          kind === "hunk" ? "rgba(96,165,250,0.12)" :
          "transparent";
        const color =
          kind === "added" ? "#22c55e" :
          kind === "removed" ? "#f87171" :
          kind === "hunk" ? "var(--accent)" :
          "var(--text)";

        return (
          <div
            key={i}
            style={{
              display: "flex",
              background: bg,
              borderLeft: kind === "added"
                ? "3px solid #22c55e"
                : kind === "removed"
                ? "3px solid #f87171"
                : kind === "hunk"
                ? "3px solid var(--accent)"
                : "3px solid transparent",
            }}
          >
            <span
              style={{
                width: 48,
                padding: "0 8px",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                borderRight: "1px solid var(--border)",
                textAlign: "right",
                userSelect: "none",
                flexShrink: 0,
              }}
            >
              {i + 1}
            </span>
            <span style={{ padding: "0 10px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color }}>
              {line || "\u00a0"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function getResultDiff(result: ToolResultMessage): ResultDiff | null {
  const details = (result as ToolResultMessage & { details?: unknown }).details;
  if (!isRecord(details)) return null;

  const patch = typeof details.patch === "string" ? details.patch : null;
  if (patch) return { text: patch };

  const diff = typeof details.diff === "string" ? details.diff : null;
  if (diff) return { text: diff };

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function PairedResult({ text, isEmpty, isError, images, sessionId, remotePeer, loadingFullResult, fullResultError }: {
  text: string;
  isEmpty: boolean;
  isError: boolean;
  images: ImageContent[];
  sessionId?: string;
  remotePeer?: string;
  loadingFullResult?: boolean;
  fullResultError?: string | null;
}) {
  const { t } = useI18n();
  const imageSources = images.map((image) => imageSource(image, remotePeer, sessionId)).filter((source): source is string => Boolean(source));
  return (
    <div
      aria-busy={loadingFullResult || undefined}
      title={fullResultError ?? undefined}
      style={{
        borderTop: `1px solid ${isError ? "rgba(248,113,113,0.3)" : "rgba(34,197,94,0.15)"}`,
        background: isError ? "rgba(248,113,113,0.04)" : "var(--bg-subtle)",
      }}
    >
      {imageSources.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "8px 10px 0", cursor: "zoom-in" }}>
          {imageSources.map((src, index) => (
            <ImagePreview key={`${src}-${index}`} src={src} images={imageSources} initialIndex={index}>
              {/* Embedded WKWebView may not start lazy tool-result images inside remote iframes. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt="" loading="eager" style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid var(--border)" }} />
            </ImagePreview>
          ))}
        </div>
      )}
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          color: isError ? "#f87171" : (isEmpty ? "var(--text-dim)" : "var(--text-muted)"),
          fontSize: 12,
          lineHeight: 1.5,
          overflow: "auto",
          maxHeight: 400,
          background: "var(--bg)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          fontStyle: isEmpty ? "italic" : "normal",
          opacity: isEmpty ? 0.6 : 1,
        }}
      >
         {isEmpty ? t("i18n.noOutput") : text}
      </pre>
    </div>
  );
}

function CompactionMessageView({ message, onOpenFile, compactionCost, compactionContext }: { message: CustomMessage; onOpenFile?: (filePath: string) => void; compactionCost?: SessionCompactionCost; compactionContext?: CompactionContextInfo }) {
  const { t } = useI18n();
  const summary = getMessageText(message.content);
  const parsedSummary = useMemo(() => parseCompactionSummary(summary), [summary]);
  const time = formatTime(message.timestamp);
  const details = isRecord(message.details) ? message.details : undefined;
  const fallbackTokensBefore = typeof details?.tokensBefore === "number" && Number.isFinite(details.tokensBefore) && details.tokensBefore >= 0
    ? details.tokensBefore
    : null;
  const tokensBefore = compactionContext?.tokensBefore ?? fallbackTokensBefore;
  const compactionModelText = compactionContext?.model
    ? `${compactionContext.provider ? `${compactionContext.provider}/` : ""}${compactionContext.model}`
    : null;
  const contextText = tokensBefore === null
    ? null
    : compactionContext?.contextWindow
      ? `${t("session.compactionContextBefore")} ${formatMetricNumber(tokensBefore)} / ${formatMetricNumber(compactionContext.contextWindow)} (${((tokensBefore / compactionContext.contextWindow) * 100).toFixed(1)}%)`
      : `${t("session.compactionContextBefore")} ${formatMetricNumber(tokensBefore)} ${t("session.tokens")}`;
  const compactionAmount = compactionCost?.amount;
  const displayCompactionAmount = typeof compactionAmount === "number" && compactionCost?.status === "partial"
    ? Math.floor(compactionAmount * 10_000) / 10_000
    : compactionAmount;
  const amountText = compactionCost
    ? typeof displayCompactionAmount === "number"
      ? `${compactionCost.status === "partial" ? "≥" : ""}${compactionCost.currency === "USD" ? "$" : `${compactionCost.currency} `}${displayCompactionAmount.toFixed(4)}`
      : t("session.unpriced")
    : null;
  const compactionUsageText = compactionCost
    ? `${formatMetricNumber(compactionCost.usage.totalTokens)} ${t("session.tokens")} · ${t("session.cost")} ${amountText}`
    : null;
  const compactionUsageTitle = compactionCost
    ? [
        `${t("session.input")}: ${compactionCost.usage.inputTokens.toLocaleString()}`,
        `${t("session.cacheRead")}: ${compactionCost.usage.cachedInputTokens.toLocaleString()}`,
        `${t("session.cacheWrite")}: ${compactionCost.usage.cacheWriteTokens.toLocaleString()}`,
        `${t("session.output")}: ${compactionCost.usage.outputTokens.toLocaleString()}`,
        `${t("session.cost")}: ${amountText}`,
      ].join(" · ")
    : undefined;
  // pi's showCacheMissNotices (#1265): what the compaction billed, in its card.
  const costNotice = getTranscriptNotices(message).find((notice) => notice.kind === "summary_cost" && notice.source === "compaction");

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
          }}
        >
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650 }}>
            compaction
          </span>
          {compactionModelText && <span data-compaction-model title={compactionModelText} aria-label={compactionModelText} style={{ color: "var(--text-muted)", fontSize: 10, whiteSpace: "nowrap" }}>{compactionModelText}</span>}
          {contextText && <span title={contextText} aria-label={contextText} style={{ color: "var(--text-muted)", fontSize: 10, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{contextText}</span>}
          {compactionUsageText && <span title={compactionUsageTitle} aria-label={compactionUsageTitle} style={{ color: compactionCost?.amount === null ? "var(--text-dim)" : "var(--text-muted)", fontSize: 10, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{compactionUsageText}</span>}
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>{time}</span>}
        </div>

        <div style={{ padding: "11px 13px 12px" }}>
          <div style={{ color: "var(--text)", fontSize: 15, fontWeight: 700, lineHeight: 1.35 }}>
             {t("i18n.conversationCompacted")}
          </div>
          <div style={{ marginTop: 3, marginBottom: 10, color: "var(--text)", fontSize: 14, lineHeight: 1.5 }}>
             {t("i18n.compactionDescription")}
          </div>
          {parsedSummary.body ? (
            <MarkdownBody className="markdown-compaction-message">{parsedSummary.body}</MarkdownBody>
          ) : (
             <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("i18n.noSummary")}</span>
          )}
          {costNotice && (
            <div style={{ marginTop: 6, color: TRANSCRIPT_NOTICE_WARNING_COLOR, fontSize: 11, lineHeight: 1.5 }}>
              {transcriptNoticeText(t, costNotice)}
            </div>
          )}
          <CompactionFileMetadata readFiles={parsedSummary.readFiles} modifiedFiles={parsedSummary.modifiedFiles} onOpenFile={onOpenFile} />
        </div>
      </div>
    </div>
  );
}

function CompactionFileMetadata({ readFiles, modifiedFiles, onOpenFile }: { readFiles: string[]; modifiedFiles: string[]; onOpenFile?: (filePath: string) => void }) {
  const { t } = useI18n();
  const total = readFiles.length + modifiedFiles.length;
  if (total === 0) return null;

  const parts = [];
  if (readFiles.length > 0) parts.push(`${readFiles.length} read`);
  if (modifiedFiles.length > 0) parts.push(`${modifiedFiles.length} modified`);

  return (
    <details className="compaction-file-details">
       <summary>{t("i18n.fileContext", { details: parts.join(", ") })}</summary>
       {modifiedFiles.length > 0 && <CompactionFileList title={t("i18n.modifiedFiles")} files={modifiedFiles} onOpenFile={onOpenFile} />}
       {readFiles.length > 0 && <CompactionFileList title={t("i18n.readFiles")} files={readFiles} onOpenFile={onOpenFile} />}
    </details>
  );
}

function CompactionFileList({ title, files, onOpenFile }: { title: string; files: string[]; onOpenFile?: (filePath: string) => void }) {
  return (
    <div className="compaction-file-section">
      <div className="compaction-file-title">{title}</div>
      <ul className="compaction-file-list">
        {files.map((file) => (
          <li key={file}>
            {onOpenFile ? (
              <button type="button" className="compaction-file-clickable" onClick={() => onOpenFile(file)}>{file}</button>
            ) : file}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CustomMessageView({ message, cwd, sessionId, remotePeer, onOpenFile }: { message: CustomMessage; cwd?: string; sessionId?: string; remotePeer?: string; onOpenFile?: (filePath: string) => void }) {
  const { t } = useI18n();
  const isHiddenDisplay = message.display === false;
  const isAgentCollaboration = message.customType === SESSION_PEER_CUSTOM_TYPE;
  const [contentExpanded, setContentExpanded] = useState(!isHiddenDisplay && !isAgentCollaboration);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const hasDetails = message.details !== undefined;
  const detailsText = hasDetails ? safeJson(message.details) : "";
  const peerDetails = message.details && typeof message.details === "object" && !Array.isArray(message.details)
    ? message.details as Record<string, unknown>
    : undefined;
  const peerUiContent = isAgentCollaboration && typeof peerDetails?.uiContent === "string"
    ? peerDetails.uiContent
    : undefined;
  const displayContent = peerUiContent ?? message.content;
  const text = getMessageText(displayContent);
  const images = getMessageImages(displayContent);
  const imageSources = images.map((image) => imageSource(image, remotePeer, sessionId)).filter((source): source is string => Boolean(source));
  const peerSender = peerDetails?.sender && typeof peerDetails.sender === "object" && !Array.isArray(peerDetails.sender)
    ? peerDetails.sender as Record<string, unknown>
    : undefined;
  const peerSenderLabel = typeof peerSender?.title === "string" && peerSender.title.trim()
    ? peerSender.title
    : typeof peerSender?.sessionId === "string" ? peerSender.sessionId : undefined;
  const peerKind = typeof peerDetails?.kind === "string" ? peerDetails.kind : undefined;
  const title = isAgentCollaboration ? "Agent collaboration" : formatCustomType(message.customType);
  const time = formatTime(message.timestamp);

  const copyContent = () => {
    copyText(text || detailsText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          border: `1px solid ${isAgentCollaboration ? "var(--accent)" : "var(--border)"}`,
          borderRadius: 8,
          overflow: "hidden",
          background: isHiddenDisplay ? "var(--bg-subtle)" : "var(--bg)",
          opacity: isHiddenDisplay && !contentExpanded ? 0.82 : 1,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650 }}>
            {title}
          </span>
           {isAgentCollaboration && <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{[peerKind, peerSenderLabel ? `from ${peerSenderLabel}` : ""].filter(Boolean).join(" · ")}</span>}
           {!isAgentCollaboration && isHiddenDisplay && <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("i18n.hiddenExtensionMessage")}</span>}
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>{time}</span>}
        </div>

        {contentExpanded ? (
          <div style={{ padding: "8px 12px" }}>
            {imageSources.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: text ? 8 : 0, cursor: "zoom-in" }}>
                {imageSources.map((src, index) => (
                  <ImagePreview key={`${src}-${index}`} src={src} images={imageSources} initialIndex={index}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={src}
                      alt=""
                      style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid var(--border)" }}
                    />
                  </ImagePreview>
                ))}
              </div>
            )}
             {text ? <MarkdownBody className="markdown-custom-message" cwd={cwd} remotePeer={remotePeer} sessionId={sessionId} onOpenFile={onOpenFile}>{text}</MarkdownBody> : <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("i18n.noMessage")}</span>}
          </div>
        ) : (
          <button
            onClick={() => setContentExpanded(true)}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 10px",
              border: "none",
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: 12,
              textAlign: "left",
            }}
          >
             {text ? previewText(text) : t("i18n.showExtensionMessage")}
          </button>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "4px 9px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-subtle)",
          }}
        >
          {text || detailsText ? (
            <button
              onClick={copyContent}
              style={{
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: copied ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
               {copied ? t("i18n.copied") : t("i18n.copy")}
            </button>
          ) : null}
          {(hasDetails || isHiddenDisplay || isAgentCollaboration) && (
            <button
              onClick={() => {
                if (isHiddenDisplay || isAgentCollaboration) setContentExpanded((v) => !v);
                else setDetailsExpanded((v) => !v);
              }}
              style={{
                marginLeft: "auto",
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              {isHiddenDisplay || isAgentCollaboration
                 ? (contentExpanded ? t("i18n.collapse") : t("i18n.expand"))
                 : (detailsExpanded ? t("i18n.hideDetails") : t("i18n.showDetails"))}
            </button>
          )}
          {isAgentCollaboration && hasDetails && (
            <button
              onClick={() => setDetailsExpanded((v) => !v)}
              style={{
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              {detailsExpanded ? t("i18n.hideDetails") : t("i18n.showDetails")}
            </button>
          )}
        </div>

        {hasDetails && ((isHiddenDisplay && contentExpanded) || (isAgentCollaboration && detailsExpanded) || (!isHiddenDisplay && !isAgentCollaboration && detailsExpanded)) && (
          <pre
            style={{
              margin: 0,
              padding: "9px 10px",
              borderTop: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 360,
              overflow: "auto",
              fontFamily: "var(--font-mono)",
            }}
          >
            {detailsText}
          </pre>
        )}
      </div>
    </div>
  );
}

function getMessageText(content: CustomMessage["content"] | UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function getMessageImages(content: CustomMessage["content"] | UserMessage["content"]): ImageContent[] {
  if (typeof content === "string") return [];
  return content.filter((b): b is ImageContent => b.type === "image");
}

export function imageSource(img: ImageContent, remotePeer?: string, sessionId?: string): string {
  // SAFETY: ImageContent shape compatibility fallback between SDK and custom image representations
  const flat = img as unknown as { data?: string; mimeType?: string };
  if (img.source) {
    if (img.source.type === "base64") return `data:${img.source.media_type};base64,${img.source.data}`;
    const url = img.source.url ?? "";
    if (url.startsWith("/api/")) return remotePeer ? apiPathForPeer(remotePeer, url.slice("/api/".length)) : url;
    const localPath = resolveLocalFileHref(url);
    return localPath ? fileApiPath(localPath, "read", sessionId, remotePeer) : url;
  }
  return flat.data ? `data:${flat.mimeType};base64,${flat.data}` : "";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function getToolCallInputText(block: ToolCallContent): string {
  return block.rawInput ?? JSON.stringify(block.input, null, 2);
}

function formatCustomType(type: string): string {
  return type || "extension";
}

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "Show extension message";
  return normalized.length > 140 ? `${normalized.slice(0, 140)}...` : normalized;
}


function getToolPreview(block: ToolCallContent, resultPatchPath: string | null): string {
  const input = block.input;
  if (!input || typeof input !== "object") return resultPatchPath?.slice(0, 120) ?? "";
  const keys = Object.keys(input);
  if (keys.length === 0) return resultPatchPath?.slice(0, 120) ?? "";

  // Common tool input patterns
  if ("command" in input) return String(input.command).slice(0, 120);
  if ("path" in input) return String(input.path).slice(0, 120);
  if ("file_path" in input) return String(input.file_path).slice(0, 120);
  if (resultPatchPath) return resultPatchPath.slice(0, 120);
  if ("pattern" in input) return String(input.pattern).slice(0, 120);
  if ("query" in input) return String(input.query).slice(0, 120);

  const first = input[keys[0]];
  return String(first).slice(0, 120);
}

function formatUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}, cacheLabel: string, unavailableLabel: string, calculatedCost?: number): string {
  const parts = [];
  const rate = turnCacheHitRate(usage);
  parts.push(rate === null ? unavailableLabel : `${cacheLabel} ${rate.toFixed(1)}%`);
  const cost = calculatedCost !== undefined && Number.isFinite(calculatedCost) ? calculatedCost : undefined;
  if (cost !== undefined && Number.isFinite(cost)) parts.push(`$${cost.toFixed(4)}`);
  return parts.join(" · ");
}

function BashExecutionView({ message, sessionId }: { message: BashExecutionMessage; sessionId?: string }) {
  const [fullOutput, setFullOutput] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fullError, setFullError] = useState<string | null>(null);

  const isPending = !message.output && message.exitCode === undefined && !message.cancelled;
  const isError = message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);
  const fullOutputUrl = sessionId && message.fullOutputPath
    ? `/api/agent/${encodeURIComponent(sessionId)}/bash-output?path=${encodeURIComponent(message.fullOutputPath)}`
    : null;
  const showFullButton = message.truncated && fullOutputUrl && fullOutput === null;
  const displayOutput = fullOutput ?? message.output;

  async function loadFullOutput() {
    if (!fullOutputUrl) return;
    setLoadingFull(true);
    setFullError(null);
    try {
      const res = await fetch(fullOutputUrl);
      const d = await res.json() as { success?: boolean; data?: { output?: string }; error?: string };
      if (d.success) {
        setFullOutput(d.data?.output ?? "");
      } else {
        setFullError(d.error ?? "failed");
      }
    } catch (e) {
      setFullError(String(e));
    } finally {
      setLoadingFull(false);
    }
  }

  // Reuse the existing ToolCallBlock so user-run bash looks identical to an
  // agent-run bash tool call: same header, collapse behavior, result pane.
  // Synthesize an equivalent ToolCallContent + ToolResultMessage pair.
  const toolName = message.excludeFromContext ? "bash (local)" : "bash";
  const block: ToolCallContent = {
    type: "toolCall",
    toolCallId: `bash-${message.timestamp ?? ""}`,
    toolName,
    input: { command: message.command },
  };
  const result: ToolResultMessage | undefined = isPending
    ? undefined
    : {
        role: "toolResult",
        toolCallId: block.toolCallId,
        toolName,
        content: displayOutput ? [{ type: "text", text: displayOutput }] : [],
        isError,
        timestamp: message.timestamp,
      };

  return (
    <div style={{ margin: "6px 0" }}>
      <ToolCallBlock block={block} result={result} />
      {message.truncated && fullOutputUrl && (
        <div style={{ padding: "4px 10px", fontSize: 11, marginTop: -1 }}>
          {showFullButton && (
            <button
              onClick={loadFullOutput}
              disabled={loadingFull}
              style={{ background: "none", border: "none", color: "var(--accent)", cursor: loadingFull ? "default" : "pointer", fontSize: 11, padding: 0, textDecoration: "underline" }}
            >
              {loadingFull ? "loading…" : "view full output"}
            </button>
          )}
          <a
            href={`${fullOutputUrl}&download=1`}
            style={{ marginLeft: showFullButton ? 10 : 0, color: "var(--accent)", fontSize: 11, textDecoration: "underline" }}
          >
            download full output
          </a>
          {fullError && <span style={{ marginLeft: 6, color: "var(--text-dim)", fontSize: 11 }}>({fullError})</span>}
        </div>
      )}
    </div>
  );
}
