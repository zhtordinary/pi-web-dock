"use client";

import { QueueRecoveryPanel } from "./QueueRecoveryPanel";
import React, { useRef, useState, useCallback, useEffect, useLayoutEffect, useImperativeHandle, forwardRef, KeyboardEvent } from "react";
import { ChevronDown, Info, Paperclip, Search, Star, X, Zap } from "lucide-react";
import { sendAgentCommand } from "@/lib/agent-client";
import type { BuiltinSlashCommandResult, CompactResultInfo, QueuedMessages, SlashCommandInfo } from "@/hooks/useAgentSession";
import type { ContinueUiState } from "@/hooks/useContinueController";
import type { SkillsResponse } from "@/lib/api-types";
import { CUSTOM_PROMPTS_CHANGED_EVENT } from "@/lib/custom-prompt-types";
import type { CustomPrompt, CustomPromptEditValue } from "@/lib/custom-prompt-types";
import type { TextContent, UserMessage } from "@/lib/types";
import type { QuestionAnalysisMode, QuestionAnalysisPromptMetadata, QuestionAnalysisResult, QuestionRewriteResult } from "@/lib/question-analysis";
import {
  clearDraft,
  getDraft,
  mergeRestoredSubmissionDraft,
  mergeRestoredSubmissionText,
  rekeyDraft as rekeyStoredDraft,
  setDraft,
  setRecalledDraft,
  isRecalledDraftDurable,
  type ChatDraftImage,
} from "@/lib/draft-store";
import {
  MAX_ATTACHED_IMAGE_BYTES,
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
  compressImageFile,
} from "@/lib/image-attachments";
import {
  buildEntriesFromFiles, buildAtInsertText, extractAtQuery, filterFileEntries,
  type AtQueryMatch, type FileIndexEntry,
} from "@/lib/file-fuzzy";
import { EXPLORER_FILTER_CHANGED_EVENT, loadStoredExplorerFilter } from "@/lib/explorer-filter";
import type { SlashFavoriteCategory } from "@/lib/slash-favorite-state";
import { slashFavoriteCategoryLabel } from "@/lib/slash-display";
import { ImagePreview } from "./ImagePreview";
import { MarkdownBody } from "./MarkdownBody";
import { ReaderFloatingSelect, announceReaderMenuOpen, useReaderMenuDismiss } from "./ReaderFloatingSelect";
import { GEN_CONFIG_CHANGED_EVENT } from "./ImageGenConfig";
import { FolderIcon, getFileIcon } from "./FileIcons";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useEnterSendMode } from "@/hooks/useEnterSendMode";
import { QuoteCardGroup } from "./QuoteCardGroup";
import { type QuoteContextItem, formatQuoteItemsToMarkdown } from "@/lib/quote-context";
import { getMarkdownListContinuation as getMarkdownListEdit } from "@/lib/markdown-list-continuation";
import { isBareMcpCommand, isBuiltinMcpCommand } from "@/lib/mcp-command";
import { SelectorRow } from "./SelectorRow";
import { useI18n } from "@/hooks/useI18n";
import { useChatAppearance } from "@/hooks/useChatAppearance";
import { apiPathForPeer, fileApiPath } from "@/lib/file-api";
import { EMBEDDED_SLASH_DETAILS_CLOSE_EVENT, EMBEDDED_SLASH_DETAILS_EVENT, prepareEmbeddedModal } from "@/lib/embedded-modal";
import { SlashCommandDetailsSurface } from "./SlashCommandDetailsSurface";
import {
  COLLAPSED_PROVIDERS_CHANGED_EVENT,
  COLLAPSED_PROVIDERS_REQUEST_EVENT,
  COLLAPSED_PROVIDERS_SYNC_EVENT,
  readCollapsedProviderNames,
  writeCollapsedProviderNames,
} from "@/lib/model-visibility-preference";
import type { ModelErrorInfo } from "@/lib/models-cache";
import type { FastModeSelection, FastModeStatus } from "@/lib/fast-mode";
import { getThinkingChoices, type ThinkingSelection } from "@/lib/thinking-level";
import type { ToolPreset } from "@/lib/tool-presets";

export interface AttachedImage {
  data: string;   // base64, no prefix
  mimeType: string;
  previewUrl: string; // object URL for display
}


interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

type DraftAnalysisState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: QuestionAnalysisResult }
  | { status: "error"; message: string };

type DraftRewriteState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: QuestionRewriteResult }
  | { status: "error"; message: string };

interface DraftPromptRequestControllerOptions {
  requestIdRef: { current: number };
  resolveSessionId: () => Promise<string>;
  send: (sessionId: string, payload: Record<string, unknown>) => Promise<unknown>;
  setAnalysis: React.Dispatch<React.SetStateAction<DraftAnalysisState>>;
  setRewrite: React.Dispatch<React.SetStateAction<DraftRewriteState>>;
  setSte100: React.Dispatch<React.SetStateAction<DraftRewriteState>>;
  noResultMessage: string;
  failedMessage: string;
}

export function resetDraftPromptRequest(
  requestIdRef: { current: number },
  setAnalysis: React.Dispatch<React.SetStateAction<DraftAnalysisState>>,
  setRewrite: React.Dispatch<React.SetStateAction<DraftRewriteState>>,
  setSte100: React.Dispatch<React.SetStateAction<DraftRewriteState>>,
): void {
  requestIdRef.current += 1;
  setAnalysis({ status: "idle" });
  setRewrite({ status: "idle" });
  setSte100({ status: "idle" });
}

export function createDraftPromptRequestController({
  requestIdRef,
  resolveSessionId,
  send,
  setAnalysis,
  setRewrite,
  setSte100,
  noResultMessage,
  failedMessage,
}: DraftPromptRequestControllerOptions) {
  const isCurrent = (requestId: number) => requestId === requestIdRef.current;
  const errorMessage = (error: unknown) => error instanceof Error ? error.message : failedMessage;

  const begin = (kind: "analysis" | "rewrite" | "ste100"): number => {
    const requestId = ++requestIdRef.current;
    if (kind === "analysis") {
      setAnalysis({ status: "loading" });
      setRewrite({ status: "idle" });
      setSte100({ status: "idle" });
    } else if (kind === "rewrite") {
      setAnalysis((current) => current.status === "loading" ? { status: "idle" } : current);
      setRewrite({ status: "loading" });
      setSte100((current) => current.status === "loading" ? { status: "idle" } : current);
    } else {
      setAnalysis((current) => current.status === "loading" ? { status: "idle" } : current);
      setSte100({ status: "loading" });
      setRewrite((current) => current.status === "loading" ? { status: "idle" } : current);
    }
    return requestId;
  };

  const completeRewrite = async (requestId: number, question: string, terms: string): Promise<void> => {
    if (!isCurrent(requestId)) return;
    setRewrite({ status: "loading" });
    try {
      const sessionId = await resolveSessionId();
      if (!isCurrent(requestId)) return;
      const result = await send(sessionId, { type: "rewrite_question", question, terms }) as QuestionRewriteResult;
      if (!isCurrent(requestId)) return;
      if (!result?.text?.trim()) throw new Error(noResultMessage);
      if (!isCurrent(requestId)) return;
      setRewrite({ status: "ready", result });
    } catch (error) {
      if (!isCurrent(requestId)) return;
      setRewrite({ status: "error", message: errorMessage(error) });
    }
  };

  const runAnalysis = async (mode: QuestionAnalysisMode, question: string): Promise<void> => {
    const requestId = begin("analysis");
    try {
      const sessionId = await resolveSessionId();
      if (!isCurrent(requestId)) return;
      const result = await send(sessionId, {
        type: "analyze_question_draft",
        question,
        contextMode: mode,
      }) as QuestionAnalysisResult;
      if (!isCurrent(requestId)) return;
      if (!result?.text?.trim()) throw new Error(noResultMessage);
      if (!isCurrent(requestId)) return;
      setAnalysis({ status: "ready", result });
      if (!isCurrent(requestId)) return;
      await completeRewrite(requestId, stripTrailingTerms(question, result.text).trim(), result.text);
    } catch (error) {
      if (!isCurrent(requestId)) return;
      setAnalysis({ status: "error", message: errorMessage(error) });
    }
  };

  const runRewrite = async (question: string, terms: string): Promise<void> => {
    const requestId = begin("rewrite");
    await completeRewrite(requestId, question, terms);
  };

  const runSte100 = async (question: string): Promise<void> => {
    const requestId = begin("ste100");
    try {
      const sessionId = await resolveSessionId();
      if (!isCurrent(requestId)) return;
      const result = await send(sessionId, { type: "rewrite_ste100", question }) as QuestionRewriteResult;
      if (!isCurrent(requestId)) return;
      if (!result?.text?.trim()) throw new Error(noResultMessage);
      if (!isCurrent(requestId)) return;
      setSte100({ status: "ready", result });
    } catch (error) {
      if (!isCurrent(requestId)) return;
      setSte100({ status: "error", message: errorMessage(error) });
    }
  };

  return {
    reset: () => resetDraftPromptRequest(requestIdRef, setAnalysis, setRewrite, setSte100),
    runAnalysis,
    runRewrite,
    runSte100,
  };
}

interface Props {
  onSend: (message: string, images?: AttachedImage[], questionAnalysis?: QuestionAnalysisPromptMetadata) => void;
  onAbort: () => void;
  onSteer?: (message: string, images?: AttachedImage[]) => void;
  onFollowUp?: (message: string, images?: AttachedImage[]) => void;
  onPromptWithStreamingBehavior?: (message: string, behavior: "steer" | "followUp", images?: AttachedImage[]) => void;
  editorSuggestion?: string | null;
  isStreaming: boolean;
  canStop?: boolean;
  stopping?: boolean;
  readOnlyReason?: string;
  statePending?: boolean;
  model?: { provider: string; modelId: string } | null;
  isAutoModelSelection?: boolean;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string }[];
  modelError?: ModelErrorInfo | null;
  /** Diagnostics from resolving `enabledModels`, e.g. a pattern that matched nothing. */
  modelScopeWarnings?: string[];
  onModelChange?: (provider: string, modelId: string) => void;
  modelSwitching?: boolean;
  runtimeSettingsUpdating?: boolean;
  defaultModel?: { provider: string; modelId: string } | null;
  onSetDefaultModel?: (provider: string, modelId: string) => void;
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  autoCompactionEnabled?: boolean | null;
  runtimeSettingsRead?: { status: "loading" | "ready" | "error"; error?: string };
  onRetryRuntimeSettings?: () => void | Promise<void>;
  onAutoCompactionChange?: (enabled: boolean) => void | Promise<void>;
  isCompacting?: boolean;
  compactError?: string | null;
  compactResult?: CompactResultInfo | null;
  toolPreset?: ToolPreset;
  onToolPresetChange?: (preset: ToolPreset) => void;
  thinkingLevel?: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  isAutoThinkingSelection?: boolean;
  onThinkingLevelChange?: (level: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  savedDefaultThinkingLevel?: string | null;
  onSetDefaultThinkingLevel?: (level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => void;
  fastMode?: FastModeStatus | null;
  onFastModeChange?: (mode: FastModeSelection) => void;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  continueUi?: ContinueUiState | null;
  unattended?: boolean;
  onContinue?: () => void;
  onUnattendedChange?: () => void;
  onStopContinue?: () => void;
  queuedMessages?: QueuedMessages | null;
  inputHistory?: string[];
  onRecallQueue?: () => void;
  slashCommands?: SlashCommandInfo[];
  slashCommandsLoading?: boolean;
  onLoadSlashCommands?: () => Promise<SlashCommandInfo[]> | SlashCommandInfo[];
  onBuiltinCommand?: (message: string) => Promise<BuiltinSlashCommandResult>;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  onAudioUnlock?: () => void;
  draftKey?: string;
  /** Session working directory — enables the @ file autocomplete menu */
  cwd?: string | null;
  /** Current session file path — enables the per-session image-generation switch */
  sessionFile?: string;
  /** Target device for remote aggregate sessions. */
  remotePeer?: string;
  /** Existing session id; new sessions use onEnsureSession before analysis. */
  sessionId?: string | null;
  onOpenFile?: (filePath: string, page?: number) => void;
  /** Lazily creates a new session without sending its draft. */
  onEnsureSession?: () => Promise<string | null>;
  onReady?: () => void;
  /**
   * Reports whether an upward menu owns the space above the composer, so a
   * centered new-session composer can drop to the bottom and give it room.
   */
  onUpwardMenuOpenChange?: (open: boolean) => void;
  constrainWidth?: boolean;
  onQuotesChange?: (quotes: QuoteContextItem[]) => void;
  onEditQuote?: (quote: QuoteContextItem) => void;
  onJumpToQuote?: (id: string) => void;
}

export interface ChatInputHandle {
  addQuote?: (text: string, sourceTurnId?: string, reply?: string) => void;
  addQuoteItem?: (quote: QuoteContextItem) => void;
  updateQuoteReply?: (id: string, reply: string) => void;
  updateQuote?: (id: string, text: string) => void;
  removeQuote?: (id: string) => void;
  getQuotes?: () => QuoteContextItem[];
  hasRefreshRisk: () => boolean;
  insertText: (text: string) => void;
  insertIfEmpty: (text: string, images?: ChatDraftImage[]) => void;
  replaceMessage: (message: UserMessage) => boolean;
  prependText: (text: string, images?: ChatDraftImage[]) => void;
  availableImageSlots: () => number;
  hasQueuedDraft: (operationId: string) => boolean;
  isQueuedDraftDurable: (operationId: string) => boolean;
  prependQueuedDraft: (text: string, images: ChatDraftImage[], operationId?: string) => boolean;
  addImages: (files: File[]) => void;
  rekeyDraft: (previousKey: string, nextKey: string) => void;
  restoreSubmission: (text: string, images?: ChatDraftImage[], targetDraftKey?: string) => void;
}

interface ImageGenState {
  enabled: boolean;
  genProvider: string | null;
  genModelId: string | null;
  genBackend: string;
  /** True when generation is enabled but the effective model can't work. */
  genInvalid?: boolean;
  outputDir: string;
  providers: Record<string, { models: string[] }>;
  /** Generation options explicitly selected in this session. */
  genSize?: string | null;
  genResolution?: string | null;
  genQuality?: string | null;
  /** Fields explicitly cleared to let tool/request values win. */
  genOptionsUnset?: Array<"size" | "resolution" | "quality">;
  /** Per-model supported ratios/pixel sizes/resolutions/qualities. */
  capabilities?: Record<string, {
    ratios?: string[];
    pixelSizes?: string[];
    resolutions: string[];
    qualities?: string[];
    note?: string;
  }>;
}

type GenOptionField = "size" | "resolution" | "quality";
type PendingGenOptions = { size?: string; resolution?: string; quality?: string };
const GEN_OPTION_REQUEST = "__request__";

/** Image generation is an optional package; a 204 answer means it is not installed. */
async function readImageGenState(url: string): Promise<ImageGenState | null> {
  const response = await fetch(url);
  return response.status === 204 ? null : response.json() as Promise<ImageGenState>;
}

interface GenOption {
  value: string;
  label: string;
  menuLabel?: string;
}

interface ChatInputSelectTriggerProps {
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
  label: React.ReactNode;
  icon?: React.ReactNode;
  open: boolean;
  disabled?: boolean;
  title?: string;
  ariaLabel: string;
  onToggle: () => void;
  isMobile?: boolean;
  showLabel?: boolean;
  accent?: boolean;
  busy?: boolean;
  style?: React.CSSProperties;
}

function ChatInputSelectTrigger({
  triggerRef, label, icon, open, disabled = false, title, ariaLabel, onToggle,
  isMobile = false, showLabel = true, accent = false, busy = false, style,
}: ChatInputSelectTriggerProps) {
  const color = accent ? "var(--accent)" : "var(--text-muted)";
  return (
    <button
      ref={triggerRef}
      type="button"
      title={title}
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={onToggle}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
        padding: isMobile ? "0 6px" : "8px 12px",
        width: isMobile ? "auto" : undefined,
        height: 32,
        background: open ? "var(--bg-hover)" : "none",
        border: "none",
        borderRadius: 9,
        color,
        cursor: disabled ? "not-allowed" : "pointer",
        font: "inherit",
        fontSize: 12,
        opacity: disabled ? 0.5 : 1,
        transition: "background 0.12s, color 0.12s",
        ...style,
      }}
      onMouseEnter={(event) => {
        if (disabled) return;
        event.currentTarget.style.background = "var(--bg-hover)";
        event.currentTarget.style.color = "var(--text)";
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = open ? "var(--bg-hover)" : "none";
        event.currentTarget.style.color = color;
      }}
    >
      {icon}
      {(!isMobile || showLabel) && (
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {label}
        </span>
      )}
      <ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" />
    </button>
  );
}

interface GenOptionSelectProps {
  value: string;
  options: readonly GenOption[];
  onChange: (value: string) => void;
  title: string;
  ariaLabel: string;
}

function GenOptionSelect({ value, options, onChange, title, ariaLabel }: GenOptionSelectProps) {
  const selected = options.find((option) => option.value === value);
  return (
    <ReaderFloatingSelect
      value={value}
      options={options}
      onChange={onChange}
      title={title}
      ariaLabel={ariaLabel}
      placement="above"
      menuMinWidth="max-content"
      menuMaxWidth="min(240px, calc(100vw - 16px))"
      optionFontSize={12}
      containerStyle={{ flexShrink: 0 }}
      renderTrigger={({ triggerRef, open, disabled, onToggle }) => (
        <ChatInputSelectTrigger
          triggerRef={triggerRef}
          label={selected?.menuLabel ?? selected?.label ?? value}
          open={open}
          disabled={disabled}
          title={title}
          ariaLabel={ariaLabel}
          onToggle={onToggle}
          style={{ height: 32, padding: "0 2px", gap: 4 }}
        />
      )}
      renderOption={(option) => (
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {option.menuLabel ?? option.label}
        </span>
      )}
    />
  );
}

export function getDefaultGenOptions(state: Pick<ImageGenState, "enabled" | "genInvalid" | "genModelId" | "genSize" | "genResolution" | "genQuality" | "capabilities">): PendingGenOptions {
  if (!state.enabled || state.genInvalid || !state.genModelId) return {};
  const cap = state.capabilities?.[state.genModelId];
  if (!cap) return {};
  const sizes = cap.ratios ?? cap.pixelSizes ?? [];
  return {
    ...(sizes.length > 0 && !sizes.includes(state.genSize ?? "") ? { size: sizes[0] } : {}),
    ...(cap.resolutions.length > 0 && !cap.resolutions.includes(state.genResolution ?? "") ? { resolution: cap.resolutions[0] } : {}),
    ...(cap.qualities && cap.qualities.length > 0 && !cap.qualities.includes(state.genQuality ?? "") ? { quality: cap.qualities[0] } : {}),
  };
}

export function getSessionGenOptions(state: Pick<ImageGenState, "genSize" | "genResolution" | "genQuality" | "genOptionsUnset">): PendingGenOptions {
  const unset = new Set(state.genOptionsUnset ?? []);
  return {
    ...(state.genSize && !unset.has("size") ? { size: state.genSize } : {}),
    ...(state.genResolution && !unset.has("resolution") ? { resolution: state.genResolution } : {}),
    ...(state.genQuality && !unset.has("quality") ? { quality: state.genQuality } : {}),
  };
}


const TOOL_PRESETS = ["configured", "off", "read-only", "default", "full"] as const;
type ToolPresetLabel = typeof TOOL_PRESETS[number];
const TOOL_PRESET_MAP: Record<ToolPresetLabel, ToolPreset> = {
  configured: "configured",
  off: "none",
  "read-only": "read-only",
  default: "default",
  full: "full",
};
const COMPOSITION_END_ENTER_GRACE_MS = 100;
const CHAT_INPUT_MAX_HEIGHT = 200;
const MODEL_FILTER_THRESHOLD = 8;
const MODEL_OPTION_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const ANCHORED_MENU_GAP = 8;

function resizeChatInput(textarea: HTMLTextAreaElement, keepCaretVisible = false): void {
  const composer = textarea.closest<HTMLElement>(".chat-input-shell");
  const minHeight = composer?.style.minHeight ?? "";
  // Keep the transcript's scroll range stable while measuring a shorter field.
  if (composer) composer.style.minHeight = `${composer.offsetHeight}px`;
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, CHAT_INPUT_MAX_HEIGHT)}px`;
  if (composer) composer.style.minHeight = minHeight;
  // When the caret is at the end, keep the newly inserted final line visible
  // after the controlled value rerender. Browsers do not all preserve this
  // scroll position when a max-height textarea is resized in the same frame.
  if (keepCaretVisible && textarea.selectionStart === textarea.value.length) {
    textarea.scrollTop = textarea.scrollHeight;
  }
}

export function insertAtSelection(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  insertedText: string,
): { value: string; cursor: number } {
  const start = Math.max(0, Math.min(text.length, selectionStart));
  const end = Math.max(start, Math.min(text.length, selectionEnd));
  return {
    value: text.slice(0, start) + insertedText + text.slice(end),
    cursor: start + insertedText.length,
  };
}

export function getEditorSuggestionSuffix(value: string, suggestion?: string | null): string {
  const normalizedSuggestion = suggestion?.trim() ?? "";
  if (!normalizedSuggestion || value.includes("\n") || !normalizedSuggestion.startsWith(value)) return "";
  return normalizedSuggestion.slice(value.length);
}

export function getMarkdownListContinuation(text: string, selectionStart: number, selectionEnd: number): string {
  const start = Math.max(0, Math.min(text.length, selectionStart));
  const end = Math.max(start, Math.min(text.length, selectionEnd));
  if (start !== end) return "\n";

  const lineStart = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const lineEnd = text.indexOf("\n", start);
  const currentLine = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  if (currentLine.slice(start - lineStart).trim()) return "\n";

  const match = currentLine.match(/^([ \t]*)(\d+)([.)])([ \t]+)(\S.*)$/);
  if (!match) return "\n";
  return `\n${match[1]}${Number(match[2]) + 1}${match[3]}${match[4]}`;
}

// Terms are appended after the whole draft so the same text stays useful
// whether the user applies the rewrite or keeps the original question.
export function appendTermsToDraft(draft: string, terms: string): string {
  const base = draft.trimEnd();
  const block = terms.trim();
  if (!base) return block;
  if (!block) return base;
  return `${base}\n${block}`;
}

export function stripTrailingTerms(draft: string, terms: string): string {
  const base = draft.trimEnd();
  const block = terms.trim();
  if (!block || !base.endsWith(block)) return base;
  const head = base.slice(0, base.length - block.length);
  return head ? head.trimEnd() : base;
}

export function getUpwardMenuMaxHeight(menuBottom: number, visibleTop: number, gap = ANCHORED_MENU_GAP): number {
  return Math.max(0, Math.floor(menuBottom - visibleTop - gap));
}

function getVisibleTopBoundary(element: HTMLElement): number {
  let visibleTop = window.visualViewport?.offsetTop ?? 0;

  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "hidden" || overflowY === "clip") {
      visibleTop = Math.max(visibleTop, parent.getBoundingClientRect().top + parent.clientTop);
    }
  }

  return visibleTop;
}

function compareModelOptions(a: ModelOption, b: ModelOption): number {
  return MODEL_OPTION_COLLATOR.compare(a.name || a.modelId, b.name || b.modelId)
    || MODEL_OPTION_COLLATOR.compare(a.provider, b.provider)
    || MODEL_OPTION_COLLATOR.compare(a.modelId, b.modelId);
}

export function filterModelOptionsByProvider(options: ModelOption[], hiddenProviders: ReadonlySet<string>): ModelOption[] {
  return options.filter((option) => !hiddenProviders.has(option.provider));
}

export function filterModelOptions(options: ModelOption[], query: string): ModelOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return options;

  return options.filter((option) => (
    `${option.provider}/${option.modelId} ${option.provider}/${option.name} ${option.provider} ${option.name} ${option.modelId}`
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  ));
}

const THINKING_LEVEL_DESC_KEYS: Record<ThinkingSelection, string> = {
  auto: "chat.thinkingUseDefault", off: "chat.thinkingOff", minimal: "chat.thinkingMinimal", low: "chat.thinkingLow",
  medium: "chat.thinkingMedium", high: "chat.thinkingHigh", xhigh: "chat.thinkingXhigh", max: "chat.thinkingMax",
};

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return tokens.toLocaleString();
}

type SlashCommandPaletteItem = SlashCommandInfo | {
  name: string;
  description: string;
  source: "builtin";
  availableWhileStreaming?: boolean;
} | {
  name: string;
  description: string;
  source: "customPrompt";
  promptId: string;
  promptDescription?: string;
  content: string;
  order: number;
};

const SLASH_FAVORITES_STORAGE_KEY = "pi-web:slash-command-favorites:v1";
const SLASH_FAVORITE_CATEGORIES_STORAGE_KEY = "pi-web:slash-command-favorite-categories:v1";

function normalizeSlashFavoriteCategories(value: unknown): SlashFavoriteCategory[] {
  if (!Array.isArray(value)) return [];
  const result: SlashFavoriteCategory[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Partial<SlashFavoriteCategory>;
    if (typeof raw.id !== "string" || !raw.id.trim()) continue;
    const name = typeof raw.name === "string" ? raw.name.trim() : raw.id;
    const keys = Array.isArray(raw.keys) ? raw.keys.filter((k): k is string => typeof k === "string" && Boolean(k.trim())) : [];
    result.push({ id: raw.id.trim(), name, keys });
  }
  return result;
}

function readLocalSlashFavoriteCategories(): SlashFavoriteCategory[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SLASH_FAVORITE_CATEGORIES_STORAGE_KEY);
    if (!raw) return [];
    return normalizeSlashFavoriteCategories(JSON.parse(raw));
  } catch {
    return [];
  }
}

function readLocalSlashFavoriteKeys(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return normalizeSlashFavoriteKeys(JSON.parse(window.localStorage.getItem(SLASH_FAVORITES_STORAGE_KEY) ?? "null"));
  } catch {
    return [];
  }
}

function isCustomPrompt(value: unknown): value is CustomPrompt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prompt = value as Partial<CustomPrompt>;
  return typeof prompt.id === "string"
    && typeof prompt.title === "string"
    && typeof prompt.content === "string"
    && (prompt.description === undefined || typeof prompt.description === "string")
    && typeof prompt.order === "number"
    && Number.isFinite(prompt.order)
    && typeof prompt.updatedAt === "number"
    && Number.isFinite(prompt.updatedAt);
}

export function getCustomPromptsFromResponse(value: unknown): CustomPrompt[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const prompts = (value as { prompts?: unknown }).prompts;
  return Array.isArray(prompts) && prompts.every(isCustomPrompt) ? [...prompts] : [];
}

const CUSTOM_PROMPTS_STORAGE_KEY = "pi-web:custom-prompts:v1";

function readLocalCustomPrompts(): CustomPrompt[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CUSTOM_PROMPTS_STORAGE_KEY);
    if (!raw) return [];
    return getCustomPromptsFromResponse({ prompts: JSON.parse(raw) });
  } catch {
    return [];
  }
}

export function getSlashCommandFavoriteKey(command: SlashCommandPaletteItem): string {
  return `${command.source}:${command.source === "customPrompt" ? command.promptId : command.name}`;
}

export function normalizeSlashFavoriteKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const key = typeof item === "string" ? item.trim() : "";
    if (!key || result.includes(key)) continue;
    result.push(key);
  }
  return result;
}

export function resolveSlashFavoriteLoad(
  data: unknown,
  status: number,
  localKeys: readonly string[],
): { keys: string[]; fallback: boolean; available: boolean } {
  if (status >= 200 && status < 300) {
    const favorites = data && typeof data === "object" && !Array.isArray(data)
      ? (data as { favorites?: { keys?: unknown } }).favorites
      : undefined;
    if (favorites && Array.isArray(favorites.keys)) {
      return { keys: normalizeSlashFavoriteKeys(favorites.keys), fallback: false, available: true };
    }
    return { keys: [], fallback: false, available: false };
  }
  const code = data && typeof data === "object" && !Array.isArray(data)
    ? (data as { code?: unknown }).code
    : undefined;
  if (status === 404 || status === 501 || code === "slash_favorites_unsupported") {
    return { keys: normalizeSlashFavoriteKeys(localKeys), fallback: true, available: false };
  }
  return { keys: [], fallback: false, available: false };
}

export function reorderSlashFavoritesByDrop(keys: readonly string[], draggedKey: string, targetKey: string): string[] {
  const from = keys.indexOf(draggedKey);
  const to = keys.indexOf(targetKey);
  if (from < 0 || to < 0 || from === to) return [...keys];
  const next = [...keys];
  const [dragged] = next.splice(from, 1);
  next.splice(from < to ? to - 1 : to, 0, dragged);
  return next;
}

export interface SlashCommandTrigger {
  placement: "start" | "end";
  query: string;
  draft: string;
}

export function getSlashCommandTrigger(
  value: string,
  cursor?: number | null,
  commandNames: readonly string[] = [],
): SlashCommandTrigger | null {
  const caret = Math.max(0, Math.min(cursor ?? value.length, value.length));
  if (value.startsWith("/") && caret === 1) {
    return { placement: "start", query: "", draft: value.slice(1) };
  }
  const trailingSlash = value.lastIndexOf("/");
  if (trailingSlash > 0 && caret === value.length && !value.startsWith("/")) {
    const query = value.slice(trailingSlash + 1);
    const normalizedQuery = query.toLowerCase();
    const matchesCommand = normalizedQuery.length === 0
      || commandNames.some((name) => name.toLowerCase().includes(normalizedQuery));
    if (!/\s/.test(query) && matchesCommand) {
      return { placement: "end", query: normalizedQuery, draft: value.slice(0, trailingSlash) };
    }
  }
  if (!value.startsWith("/") || caret < 1) return null;
  const query = value.slice(1, caret);
  if (/\s/.test(query)) return null;
  return { placement: "start", query: query.toLowerCase(), draft: value.slice(caret) };
}

export function isAsciiSlashKey(
  event: Pick<KeyboardEvent<HTMLTextAreaElement>, "key" | "code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  return event.key === "/" || event.code === "Slash";
}

export function isSlashCommandInsertionPoint(value: string, start: number, end: number): boolean {
  return (start === 0 && end === value.length) || (end === value.length && !value.startsWith("/"));
}

export function buildSlashCommandValue(commandName: string, trigger: SlashCommandTrigger | null): string {
  const draft = trigger?.draft.trim() ?? "";
  return `/${commandName}${draft ? ` ${draft}` : " "}`;
}

type SlashCommandSource = SlashCommandPaletteItem["source"];

type BuiltinSlashCommand = Extract<SlashCommandPaletteItem, { source: "builtin" }>;

const BUILTIN_SLASH_COMMANDS: BuiltinSlashCommand[] = [
  { name: "compact", description: "chat.commandCompact", source: "builtin" },
  { name: "auto-compact", description: "chat.commandAutoCompact", source: "builtin" },
  { name: "reload", description: "chat.commandReload", source: "builtin" },
  { name: "name", description: "chat.commandName", source: "builtin" },
  { name: "session", description: "chat.commandSession", source: "builtin", availableWhileStreaming: true },
  { name: "copy", description: "chat.commandCopy", source: "builtin", availableWhileStreaming: true },
  { name: "clone", description: "chat.commandClone", source: "builtin" },
];

function getBuiltinSlashCommand(message: string): BuiltinSlashCommand | undefined {
  const match = message.trim().match(/^\/([^\s]+)(?:\s|$)/);
  if (!match) return undefined;
  return BUILTIN_SLASH_COMMANDS.find((command) => command.name === match[1]);
}

export function canRunBuiltinSlashCommandWhileStreaming(message: string): boolean {
  return getBuiltinSlashCommand(message)?.availableWhileStreaming === true;
}

/**
 * Whether a message sent while a run streams goes to the built-in handler
 * first: a built-in that may run then, or a bare `/mcp`, which opens
 * Settings › MCP when pi's built-in MCP extension owns it (useAgentSession)
 * and is otherwise sent as before.
 */
export function offersBuiltinSlashCommandWhileStreaming(message: string): boolean {
  return canRunBuiltinSlashCommandWhileStreaming(message) || isBareMcpCommand(message);
}

export function isExactSlashCommand(message: string, command: SlashCommandPaletteItem): boolean {
  return command.source === "builtin" && message.trim() === `/${command.name}`;
}

/**
 * Whether Enter on the highlighted palette entry submits the message rather
 * than completing it to "/name ": a built-in typed in full (while a run
 * streams, only one that may run then), or a bare `/mcp` on pi's built-in
 * `/mcp`, which opens Settings › MCP at once, as it does before the command
 * list has loaded. Every other extension command still takes a second Enter.
 */
export function submitsSlashCommandOnEnter(message: string, command: SlashCommandPaletteItem, isStreaming: boolean): boolean {
  if (command.source === "builtin") {
    return isExactSlashCommand(message, command) && (!isStreaming || command.availableWhileStreaming === true);
  }
  return isBuiltinMcpCommand(command) && isBareMcpCommand(message);
}

export function canClearBuiltinCommandInput(message: string, imageCount: number, submittedMessage: string): boolean {
  return imageCount === 0 && message.trim() === submittedMessage;
}

export function hasStreamingMessagePayload(value: string, imageCount: number, quoteCount: number): boolean {
  return Boolean(value.trim()) || imageCount > 0 || quoteCount > 0;
}

const SLASH_SOURCES: SlashCommandSource[] = ["customPrompt", "builtin", "skill", "prompt", "extension"];

const SLASH_SOURCE_GROUP_LABEL_KEYS: Record<SlashCommandSource, string> = {
  customPrompt: "chat.customPrompts",
  skill: "chat.skills",
  prompt: "chat.prompts",
  extension: "chat.extensions",
  builtin: "chat.builtIn",
};

const SLASH_SOURCE_ORDER: Record<SlashCommandSource, number> = {
  customPrompt: 0,
  builtin: 1,
  skill: 2,
  prompt: 3,
  extension: 4,
};

export type SlashTab = "favorites" | "all" | SlashCommandSource;

export const SLASH_TABS: SlashTab[] = [
  "customPrompt",
  "favorites",
  "skill",
  "prompt",
  "extension",
  "builtin",
  "all",
];
const SLASH_TAB_LABEL_KEYS: Record<SlashTab, string> = {
  favorites: "chat.favorites",
  all: "chat.all",
  ...SLASH_SOURCE_GROUP_LABEL_KEYS,
};

export function getSlashTabCounts(
  commands: SlashCommandPaletteItem[],
  favoriteKeys: readonly string[] = [],
): Record<SlashTab, number> {
  const favoriteSet = new Set(favoriteKeys);
  const counts: Record<SlashTab, number> = {
    favorites: commands.filter((command) => favoriteSet.has(getSlashCommandFavoriteKey(command))).length,
    all: commands.length,
    customPrompt: 0,
    builtin: 0,
    extension: 0,
    prompt: 0,
    skill: 0,
  };
  for (const command of commands) counts[command.source] += 1;
  return counts;
}

export function filterSlashCommandsByTab(
  commands: SlashCommandPaletteItem[],
  tab: SlashTab,
  favoriteKeys: readonly string[] = [],
): SlashCommandPaletteItem[] {
  if (tab === "all") return commands;
  if (tab === "favorites") {
    const favoriteSet = new Set(favoriteKeys);
    return commands.filter((command) => favoriteSet.has(getSlashCommandFavoriteKey(command)));
  }
  return commands.filter((command) => command.source === tab);
}

function customPromptToSlashCommand(prompt: CustomPrompt): SlashCommandPaletteItem {
  const description = prompt.description?.trim()
    || prompt.content.replace(/\s+/g, " ").trim().slice(0, 160);
  return {
    name: prompt.title,
    description,
    source: "customPrompt",
    promptId: prompt.id,
    promptDescription: prompt.description ?? "",
    content: prompt.content,
    order: prompt.order,
  };
}

export function buildCustomPromptValue(content: string, trigger: SlashCommandTrigger | null): string {
  const draft = trigger?.draft ?? "";
  if (!draft) return content;
  if (!content) return draft;
  const separator = content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${separator}${draft}`;
}

export function buildSlashCommandSelectionValue(command: SlashCommandPaletteItem, trigger: SlashCommandTrigger | null): string {
  return command.source === "customPrompt"
    ? buildCustomPromptValue(command.content, trigger)
    : buildSlashCommandValue(command.name, trigger);
}

function slashMatchRank(command: SlashCommandPaletteItem, query: string, t: (key: string) => string): number {
  const name = command.name.toLowerCase();
  const bareName = command.source === "skill" && name.startsWith("skill:") ? name.slice("skill:".length) : name;
  const description = getSlashDescription(command, t).toLowerCase();
  if (name === query || bareName === query) return 0;
  if (name.startsWith(query) || bareName.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (description.includes(query)) return 3;
  return 4;
}

function getSlashDescription(command: SlashCommandPaletteItem, t: (key: string) => string): string {
  return command.source === "builtin" ? t(command.description) : command.description ?? "";
}

export function getSlashCommandDetails(command: SlashCommandPaletteItem, t: (key: string) => string): string {
  if (command.source === "customPrompt") return command.content.trim() || getSlashDescription(command, t);
  return getSlashDescription(command, t);
}

export function sortSlashCommandItems(commands: SlashCommandPaletteItem[], query: string, t: (key: string) => string): SlashCommandPaletteItem[] {
  return [...commands].sort((a, b) => {
    // Use a lexicographic source/category key first so configured custom order
    // cannot create a non-transitive comparison against another source.
    const sourceDelta = SLASH_SOURCE_ORDER[a.source] - SLASH_SOURCE_ORDER[b.source];
    if (sourceDelta !== 0) return sourceDelta;
    if (a.source === "customPrompt" && b.source === "customPrompt" && a.order !== b.order) {
      return a.order - b.order;
    }
    const rankDelta = slashMatchRank(a, query, t) - slashMatchRank(b, query, t);
    if (rankDelta !== 0) return rankDelta;
    return MODEL_OPTION_COLLATOR.compare(a.name, b.name);
  });
}

// Skill slash commands are named "skill:<skillName>"; look the skill up in the
// dormancy map fetched from /api/skills. Unknown skills are treated as active.
function isDormantSkillCommand(command: SlashCommandPaletteItem, dormancy: Record<string, boolean>): boolean {
  if (command.source !== "skill" || !command.name.startsWith("skill:")) return false;
  return dormancy[command.name.slice("skill:".length)] === true;
}

export function buildSlashCommandLayout(
  commands: SlashCommandPaletteItem[],
  dormancy: Record<string, boolean>,
) {
  let index = 0;
  const groups = SLASH_SOURCES
    .map((source) => {
      const sourceCommands = commands.filter((command) => command.source === source);
      const orderedCommands = source === "skill"
        ? [
            ...sourceCommands.filter((command) => !isDormantSkillCommand(command, dormancy)),
            ...sourceCommands.filter((command) => isDormantSkillCommand(command, dormancy)),
          ]
        : sourceCommands;
      return {
        source,
        items: orderedCommands.map((command) => ({ command, index: index++ })),
      };
    })
    .filter((group) => group.items.length > 0);

  return {
    commands: groups.flatMap((group) => group.items.map(({ command }) => command)),
    groups,
  };
}

function imageToDraftImage(image: AttachedImage): ChatDraftImage {
  return { data: image.data, mimeType: image.mimeType };
}

function draftImageToAttachedImage(image: ChatDraftImage): AttachedImage {
  return {
    ...image,
    previewUrl: `data:${image.mimeType};base64,${image.data}`,
  };
}

function draftImagesToAttachedImages(images: ChatDraftImage[] | undefined): AttachedImage[] {
  return (images ?? [])
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
    .map(draftImageToAttachedImage);
}

export function canRestoreUserMessage(
  value: string,
  attachedImageCount: number,
  pendingImageCount: number,
): boolean {
  return !value.trim() && attachedImageCount === 0 && pendingImageCount === 0;
}

export function getUserMessageText(message: UserMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function getUserMessageDraftImages(message: UserMessage): ChatDraftImage[] {
  if (typeof message.content === "string") return [];
  return message.content.flatMap((block) => {
    if (block.type !== "image") return [];

    // SAFETY: persisted flat image fields are read as unknown and checked below.
    const flat = block as unknown as { data?: unknown; mimeType?: unknown };
    const data = block.source?.type === "base64" ? block.source.data : flat.data;
    const mimeType = block.source?.type === "base64" ? block.source.media_type : flat.mimeType;
    if (typeof data !== "string" || typeof mimeType !== "string") return [];

    const image = { data, mimeType };
    return isBase64ImageWithinLimits(image) ? [image] : [];
  });
}

function revokeImagePreview(image: AttachedImage): void {
  if (image.previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(image.previewUrl);
  }
}

function QueuedMessageRow({ kind, text, hasImages }: { kind: "steer" | "follow-up"; text: string; hasImages?: boolean }) {
  const { t } = useI18n();
  useChatAppearance();
  return (
    <div
      title={text}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "3px 10px",
        fontSize: 12,
        color: "var(--text-muted)",
        minWidth: 0,
      }}
    >
      <span
        style={{
          flexShrink: 0,
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          padding: "1px 7px",
          borderRadius: 999,
          border: `1px solid ${kind === "steer" ? "color-mix(in srgb, var(--accent) 45%, transparent)" : "var(--border)"}`,
          color: kind === "steer" ? "var(--accent)" : "var(--text-dim)",
        }}
      >
        {kind}
      </span>
      {hasImages && (
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0, opacity: 0.9 }}
          aria-label={t("chat.queuedWithImages")}
        >
          <title>{t("chat.queuedWithImages")}</title>
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      )}
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
    </div>
  );
}

function ModelNoticeBanner({ tone, title, body, details }: {
  tone: "error" | "warning";
  title: string;
  body: string;
  details?: React.ReactNode;
}) {
  const color = tone === "error" ? "239,68,68" : "234,179,8";
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        maxHeight: 120,
        marginBottom: 8,
        padding: "7px 10px",
        overflowY: "auto",
        border: `1px solid rgba(${color},0.3)`,
        borderRadius: 6,
        background: `rgba(${color},0.07)`,
        color: `rgb(${color})`,
        fontSize: 11,
        lineHeight: 1.45,
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0, marginTop: 1 }}
        aria-hidden="true"
      >
        <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{body}</div>
        {details}
      </div>
    </div>
  );
}

export function ModelErrorBanner({ error }: { error?: ModelErrorInfo | null }) {
  if (!error) return null;
  const title = error.code === "MODEL_DISCOVERY_FAILED"
    ? "Model discovery failed"
    : error.code === "MODEL_RUNTIME_ERROR"
      ? "Model configuration warning"
      : "Model request failed";
  return (
    <ModelNoticeBanner
      tone="error"
      title={title}
      body={error.message}
      details={(
        <>
          <div style={{ marginTop: 3, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
            code: {error.code}
          </div>
          {error.logPath && (
            <div style={{ marginTop: 3, color: "var(--text-dim)", overflowWrap: "anywhere" }}>
              diagnostics: <code>{error.logPath}</code>
            </div>
          )}
        </>
      )}
    />
  );
}

/** Surfaces `enabledModels` patterns that matched nothing, so a typo is visible (#307). */
export function ModelScopeWarningBanner({ warnings }: { warnings?: string[] }) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <ModelNoticeBanner
      tone="warning"
      title={warnings.length > 1 ? "Model scope warnings" : "Model scope warning"}
      body={warnings.join("\n")}
    />
  );
}

function DraftQuestionAnalysisDialog({ mode, onModeChange, onCancel, onConfirm }: {
  mode: QuestionAnalysisMode;
  onModeChange: (mode: QuestionAnalysisMode) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  useChatAppearance();
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
        aria-labelledby="draft-question-analysis-dialog-title"
        style={{ width: 460, maxWidth: "100%", border: "1px solid var(--border)", borderRadius: 9, background: "var(--bg-panel)", boxShadow: "0 12px 36px rgba(0,0,0,0.24)", overflow: "hidden" }}
      >
        <div style={{ padding: "16px 18px 10px" }}>
          <div id="draft-question-analysis-dialog-title" style={{ color: "var(--text)", fontSize: 15, fontWeight: 700 }}>{t("chat.promptToolsChooseTitle")}</div>
          <div style={{ marginTop: 7, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.55 }}>{t("chat.promptToolsChooseDescription")}</div>
        </div>
        <fieldset style={{ display: "grid", gap: 8, margin: 0, padding: "4px 18px 14px", border: 0 }}>
          <label style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "9px 10px", border: `1px solid ${mode === "question" ? "var(--accent)" : "var(--border)"}`, borderRadius: 7, cursor: "pointer" }}>
            <input type="radio" name="draft-question-analysis-mode" checked={mode === "question"} onChange={() => onModeChange("question")} style={{ marginTop: 2 }} />
            <span>
              <span style={{ display: "block", color: "var(--text)", fontSize: 12, fontWeight: 650 }}>{t("chat.promptToolsModeQuestion")}</span>
              <span style={{ display: "block", marginTop: 3, color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>{t("chat.promptToolsModeQuestionDescription")}</span>
            </span>
          </label>
          <label style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "9px 10px", border: `1px solid ${mode === "context" ? "var(--accent)" : "var(--border)"}`, borderRadius: 7, cursor: "pointer" }}>
            <input type="radio" name="draft-question-analysis-mode" checked={mode === "context"} onChange={() => onModeChange("context")} style={{ marginTop: 2 }} />
            <span>
              <span style={{ display: "block", color: "var(--text)", fontSize: 12, fontWeight: 650 }}>{t("chat.promptToolsModeContext")}</span>
              <span style={{ display: "block", marginTop: 3, color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>{t("chat.promptToolsModeContextDescription")}</span>
            </span>
          </label>
        </fieldset>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 18px 14px", borderTop: "1px solid var(--border)" }}>
          <button type="button" onClick={onCancel} style={{ height: 30, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}>{t("chat.promptToolsCancel")}</button>
          <button type="button" onClick={onConfirm} style={{ height: 30, padding: "0 12px", border: "1px solid var(--accent)", borderRadius: 6, background: "var(--accent)", color: "var(--bg)", cursor: "pointer", fontSize: 12, fontWeight: 650 }}>{t("chat.promptToolsRun")}</button>
        </div>
      </div>
    </div>
  );
}

export function SlashCommandDetailsDialog({
  command,
  content,
  loading,
  error,
  onClose,
  dialogRef,
  cwd, sessionId, remotePeer, onOpenFile, onCustomPromptSaved,
}: {
  command: SlashCommandPaletteItem;
  content: string;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  dialogRef: React.RefObject<HTMLDivElement | null>;
  cwd?: string;
  sessionId?: string;
  remotePeer?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  onCustomPromptSaved?: (prompt: CustomPromptEditValue) => void;
}) {
  const sourcePath = "sourceInfo" in command ? command.sourceInfo?.path : undefined;
  const editablePrompt = command.source === "customPrompt"
    ? {
      id: command.promptId,
      title: command.name,
      description: command.promptDescription ?? "",
      content: command.content,
    }
    : undefined;
  return (
    <SlashCommandDetailsSurface
      label={command.source === "customPrompt" ? command.name : `/${command.name}`}
      content={content}
      loading={loading}
      error={error}
      sourcePath={sourcePath}
      cwd={cwd}
      sessionId={sessionId}
      remotePeer={remotePeer}
      onClose={onClose}
      dialogRef={dialogRef}
      onOpenFile={onOpenFile}
      editablePrompt={editablePrompt}
      onCustomPromptSaved={onCustomPromptSaved}
    />
  );
}

function fileIndexRequestPath(cwd: string, query: string | undefined, hideGitIgnored: boolean): string {
  const params = new URLSearchParams({ cwd });
  if (query) params.set("q", query);
  if (hideGitIgnored) params.set("hideGitIgnored", "1");
  return `file-index?${params.toString()}`;
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSend, onAbort, onSteer, onFollowUp, isStreaming, canStop = isStreaming, stopping = false, readOnlyReason, statePending, model, isAutoModelSelection, modelNames, modelList, modelError, modelScopeWarnings, onModelChange, modelSwitching, runtimeSettingsUpdating,
  defaultModel, onSetDefaultModel,
  onCompact, onAbortCompaction, autoCompactionEnabled, runtimeSettingsRead, onRetryRuntimeSettings, onAutoCompactionChange, isCompacting, compactError, compactResult, toolPreset, onToolPresetChange,

  thinkingLevel, isAutoThinkingSelection = false, onThinkingLevelChange, availableThinkingLevels, thinkingLevelMap,
  savedDefaultThinkingLevel, onSetDefaultThinkingLevel,
  fastMode, onFastModeChange,
  retryInfo, queuedMessages, inputHistory = [], onRecallQueue,
  continueUi, unattended, onContinue, onUnattendedChange, onStopContinue,
  slashCommands, slashCommandsLoading, onLoadSlashCommands,
  onBuiltinCommand,
  soundEnabled, onSoundToggle, onAudioUnlock,
  onPromptWithStreamingBehavior,
  editorSuggestion,
  draftKey,
  cwd,
  sessionFile,
  onOpenFile,
  sessionId,
  onEnsureSession,
  remotePeer,
  onReady,
  onUpwardMenuOpenChange,
  constrainWidth = true,
  onQuotesChange,
  onEditQuote,
  onJumpToQuote,
}: Props, ref) {
  const { t } = useI18n();
  useChatAppearance();
  const embeddedInParent = typeof window !== "undefined" && window.parent !== window;
  const isMobile = useIsMobile();
  const enterSendMode = useEnterSendMode();
  const apiPath = useCallback((path: string) => apiPathForPeer(remotePeer, path), [remotePeer]);
  const [value, setValue] = useState(() => (draftKey ? getDraft(draftKey)?.value ?? "" : ""));
  const [draftAnalysis, setDraftAnalysis] = useState<DraftAnalysisState>({ status: "idle" });
  const [draftRewrite, setDraftRewrite] = useState<DraftRewriteState>({ status: "idle" });
  const [draftSte100Rewrite, setDraftSte100Rewrite] = useState<DraftRewriteState>({ status: "idle" });
  const [draftAnalysisDialogOpen, setDraftAnalysisDialogOpen] = useState(false);
  const [draftAnalysisMode, setDraftAnalysisMode] = useState<QuestionAnalysisMode>("question");
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelDropdownRect, setModelDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [modelFilter, setModelFilter] = useState("");
  const [hiddenModelProviders, setHiddenModelProviders] = useState<Set<string>>(() => new Set(readCollapsedProviderNames()));
  const [toolDropdownOpen, setToolDropdownOpen] = useState(false);
  const refreshHiddenModelProviders = useCallback(() => {
    setHiddenModelProviders(new Set(readCollapsedProviderNames()));
  }, []);

  useEffect(() => {
    const refresh = () => refreshHiddenModelProviders();
    const onMessage = (event: MessageEvent) => {
      if (window.parent === window || event.source !== window.parent) return;
      const data = event.data as { type?: unknown; providers?: unknown } | null;
      if (data?.type !== COLLAPSED_PROVIDERS_SYNC_EVENT || !Array.isArray(data.providers)) return;
      const names = data.providers.filter((name): name is string => typeof name === "string" && name.trim().length > 0);
      writeCollapsedProviderNames(names);
      setHiddenModelProviders(new Set(names));
      window.dispatchEvent(new Event(COLLAPSED_PROVIDERS_CHANGED_EVENT));
    };
    window.addEventListener("storage", refresh);
    window.addEventListener(COLLAPSED_PROVIDERS_CHANGED_EVENT, refresh);
    window.addEventListener("message", onMessage);
    if (window.parent !== window) {
      window.parent.postMessage({ type: COLLAPSED_PROVIDERS_REQUEST_EVENT }, "*");
    }
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(COLLAPSED_PROVIDERS_CHANGED_EVENT, refresh);
      window.removeEventListener("message", onMessage);
    };
  }, [refreshHiddenModelProviders]);
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const [builtinCommandPending, setBuiltinCommandPending] = useState(false);
  const builtinCommandPendingRef = useRef(false);
  const [fastModeDropdownOpen, setFastModeDropdownOpen] = useState(false);
  const [controlsMenuOpen, setControlsMenuOpen] = useState(false);
  const mobileControlsVisible = isMobile && (controlsMenuOpen || isStreaming || canStop);
  useReaderMenuDismiss((id) => {
    if (id !== "chat-model") {
      setModelDropdownOpen(false);
      setModelDropdownRect(null);
    }
    if (id !== "chat-thinking") setThinkingDropdownOpen(false);
    if (id !== "chat-fast-mode") setFastModeDropdownOpen(false);
    if (id !== "chat-tools") setToolDropdownOpen(false);
  });
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>(() => (
    draftKey ? draftImagesToAttachedImages(getDraft(draftKey)?.images) : []
  ));
  const [quotes, setQuotes] = useState<QuoteContextItem[]>(() => (
    draftKey ? getDraft(draftKey)?.quotes ?? [] : []
  ));
  const quotesRef = useRef<QuoteContextItem[]>(quotes);
  quotesRef.current = quotes;

  useEffect(() => {
    onQuotesChange?.(quotes);
  }, [quotes, onQuotesChange]);

  const handleRemoveQuote = useCallback((id: string) => {
    setQuotes((prev) => prev.filter((q) => q.id !== id));
  }, []);

  const handleUpdateQuote = useCallback((id: string, text: string) => {
    setQuotes((prev) => prev.map((q) => (q.id === id ? { ...q, text } : q)));
  }, []);

  const [dragImageIdx, setDragImageIdx] = useState<number | null>(null);
  const [dragOverImageIdx, setDragOverImageIdx] = useState<number | null>(null);

  const reorderImages = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    setAttachedImages((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      attachedImagesRef.current = next;
      return next;
    });
  }, []);

  const handleReorderQuotes = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    setQuotes((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);
  const [genState, setGenState] = useState<ImageGenState | null>(null);
  const [pendingGenOptions, setPendingGenOptions] = useState<PendingGenOptions>({});
  const pendingGenOptionsRef = useRef<PendingGenOptions>({});
  const genWriteQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const [pendingGenEnabled, setPendingGenEnabled] = useState<boolean | null>(null);
  const trimmedValue = value.trimStart();
  const bashMode = attachedImages.length === 0 && trimmedValue.startsWith("!");
  const bashExcluded = bashMode && trimmedValue.startsWith("!!");
  const draftQuestion = value.trim();
  // Terminology analysis uses a bounded direct completion that never enters the
  // active prompt stream, so it stays available while the assistant is running.
  const draftTermsInserted = draftAnalysis.status === "ready"
    && Boolean(draftAnalysis.result.text.trim())
    && value.trimEnd().endsWith(draftAnalysis.result.text.trim());
  const canUseDraftPromptTools = Boolean(draftQuestion)
    && !bashMode
    && !draftQuestion.startsWith("/")
    && Boolean(sessionId || onEnsureSession);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [activeSlashTab, setActiveSlashTab] = useState<SlashTab>("customPrompt");
  const [slashFavoriteCategories, setSlashFavoriteCategories] = useState<SlashFavoriteCategory[]>(readLocalSlashFavoriteCategories);
  const [activeSlashSubcategory, setActiveSlashSubcategory] = useState<string>("all");
  const [customPrompts, setCustomPrompts] = useState<CustomPrompt[]>(readLocalCustomPrompts);
  const [slashMenuSearch, setSlashMenuSearch] = useState("");
  const [slashFavoriteKeys, setSlashFavoriteKeys] = useState<string[]>(readLocalSlashFavoriteKeys);
  const [slashFavoriteError, setSlashFavoriteError] = useState<string | null>(null);
  const [slashDetailCommand, setSlashDetailCommand] = useState<SlashCommandPaletteItem | null>(null);
  const slashDetailCommandRef = useRef<SlashCommandPaletteItem | null>(null);
  slashDetailCommandRef.current = slashDetailCommand;
  const [slashDetailContent, setSlashDetailContent] = useState("");
  const [slashDetailLoading, setSlashDetailLoading] = useState(false);
  const [slashDetailError, setSlashDetailError] = useState<string | null>(null);
  const [slashHoveredKey, setSlashHoveredKey] = useState<string | null>(null);
  const [slashDraggedFavoriteKey, setSlashDraggedFavoriteKey] = useState<string | null>(null);
  const [slashDragOverFavoriteKey, setSlashDragOverFavoriteKey] = useState<string | null>(null);
  const [slashDraggedPromptId, setSlashDraggedPromptId] = useState<string | null>(null);
  const [slashDragOverPromptId, setSlashDragOverPromptId] = useState<string | null>(null);
  const [slashMenuOpenedByButton, setSlashMenuOpenedByButton] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [slashCaret, setSlashCaret] = useState<number | null>(null);
  const [slashMenuMaxHeight, setSlashMenuMaxHeight] = useState<number | null>(null);
  const [atQuery, setAtQuery] = useState<AtQueryMatch | null>(null);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const [historyActiveIndex, setHistoryActiveIndex] = useState(0);
  const [hideGitIgnored, setHideGitIgnored] = useState(false);
  const [fileVisibilityReady, setFileVisibilityReady] = useState(false);
  const [fileIndex, setFileIndex] = useState<{ cwd: string; hideGitIgnored: boolean; entries: FileIndexEntry[]; truncated: boolean } | null>(null);
  const [fileIndexLoading, setFileIndexLoading] = useState(false);
  const [atServerResult, setAtServerResult] = useState<{ cwd: string; hideGitIgnored: boolean; query: string; matches: FileIndexEntry[] } | null>(null);
  const [skillDormancyState, setSkillDormancyState] = useState<{
    cwd: string;
    values: Record<string, boolean>;
  } | null>(null);
  const skillDormancy = cwd && skillDormancyState?.cwd === cwd
    ? skillDormancyState.values
    : {};

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editorSuggestionOverlayRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const modelDropdownPanelRef = useRef<HTMLDivElement>(null);
  const toolDropdownRef = useRef<HTMLDivElement>(null);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);
  const fastModeDropdownRef = useRef<HTMLDivElement>(null);
  const controlsMenuRef = useRef<HTMLDivElement>(null);
  const historyMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const slashCommandsRequestedRef = useRef(false);
  const customPromptRequestIdRef = useRef(0);

  const upwardMenuOpen = slashMenuOpen || atMenuOpen || historyMenuOpen;
  useEffect(() => {
    onUpwardMenuOpenChange?.(upwardMenuOpen);
  }, [onUpwardMenuOpenChange, upwardMenuOpen]);
  useEffect(() => () => onUpwardMenuOpenChange?.(false), [onUpwardMenuOpenChange]);

  const slashMenuRef = useRef<HTMLDivElement>(null);
  const slashToggleButtonRef = useRef<HTMLButtonElement>(null);
  const slashSearchRef = useRef<HTMLInputElement>(null);
  const slashDetailDialogRef = useRef<HTMLDivElement>(null);
  const slashDetailOpenerRef = useRef<HTMLElement | null>(null);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const slashFavoriteWriteRef = useRef<Promise<void>>(Promise.resolve());
  const slashFavoriteMutationRef = useRef(0);
  const slashDetailRequestRef = useRef(0);
  const atItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const historyItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fileIndexMetaRef = useRef<{ cwd: string; hideGitIgnored: boolean; fetchedAt: number } | null>(null);
  const fileIndexFetchingRef = useRef<string | null>(null);
  const fileIndexRequestIdRef = useRef(0);
  const fileIndexAbortRef = useRef<AbortController | null>(null);
  const serverSearchRequestIdRef = useRef(0);
  const serverSearchAbortRef = useRef<AbortController | null>(null);
  const explorerFilterRequestIdRef = useRef(0);
  const explorerFilterAbortRef = useRef<AbortController | null>(null);
  const draftKeyRef = useRef(draftKey);
  const valueRef = useRef(value);
  const pendingDraftFocusRef = useRef<{ key: string | undefined; value: string } | null>(null);
  const attachedImagesRef = useRef(attachedImages);
  const draftPromptSourceRef = useRef<string | null>(null);
  const draftAnalysisQuestionRef = useRef<string | null>(null);
  const draftPromptRequestRef = useRef(0);
  const pendingImageCountRef = useRef(0);
  valueRef.current = value;
  attachedImagesRef.current = attachedImages;

  const editorSuggestionSuffix = getEditorSuggestionSuffix(value, editorSuggestion);
  const editorSuggestionAtEnd = (slashCaret ?? value.length) === value.length
    && (textareaRef.current?.selectionEnd ?? value.length) === value.length;
  const showEditorSuggestion = Boolean(editorSuggestionSuffix)
    && editorSuggestionAtEnd
    && attachedImages.length === 0
    && !readOnlyReason
    && !slashMenuOpen
    && !atMenuOpen
    && !historyMenuOpen;

  const invalidateFileIndexRequests = useCallback(() => {
    fileIndexRequestIdRef.current += 1;
    fileIndexAbortRef.current?.abort();
    fileIndexAbortRef.current = null;
    fileIndexFetchingRef.current = null;
    serverSearchRequestIdRef.current += 1;
    serverSearchAbortRef.current?.abort();
    serverSearchAbortRef.current = null;
  }, []);

  // File search and @ completion use the same per-project visibility setting
  // as the Explorer. Missing settings keep Git-ignored entries visible.
  useEffect(() => {
    let cancelled = false;
    explorerFilterAbortRef.current?.abort();
    const requestId = explorerFilterRequestIdRef.current + 1;
    explorerFilterRequestIdRef.current = requestId;
    const controller = new AbortController();
    explorerFilterAbortRef.current = controller;
    invalidateFileIndexRequests();
    const fetchCwd = cwd;
    setFileVisibilityReady(!fetchCwd);
    setHideGitIgnored(false);
    setFileIndex(null);
    setAtServerResult(null);
    fileIndexMetaRef.current = null;
    if (!fetchCwd) {
      return () => {
        cancelled = true;
        if (explorerFilterRequestIdRef.current !== requestId) return;
        explorerFilterRequestIdRef.current += 1;
        controller.abort();
        if (explorerFilterAbortRef.current === controller) explorerFilterAbortRef.current = null;
      };
    }

    fetch(apiPath(`explorer-filter?cwd=${encodeURIComponent(fetchCwd)}`), { signal: controller.signal })
      .then((res) => res.json() as Promise<{ filter?: { hideGitIgnored?: unknown } | null }>)
      .then((data) => {
        if (cancelled || explorerFilterRequestIdRef.current !== requestId) return;
        const stored = data.filter ?? (remotePeer ? null : loadStoredExplorerFilter(fetchCwd));
        setHideGitIgnored(stored?.hideGitIgnored === true);
        setFileVisibilityReady(true);
      })
      .catch(() => {
        if (!cancelled && explorerFilterRequestIdRef.current === requestId) setFileVisibilityReady(true);
      });

    return () => {
      cancelled = true;
      if (explorerFilterRequestIdRef.current !== requestId) return;
      explorerFilterRequestIdRef.current += 1;
      controller.abort();
      if (explorerFilterAbortRef.current === controller) explorerFilterAbortRef.current = null;
    };
  }, [apiPath, cwd, invalidateFileIndexRequests, remotePeer]);

  useEffect(() => {
    const handleFilterChange = (event: Event) => {
      const detail = (event as CustomEvent<{ cwd?: unknown; peer?: unknown; settings?: { hideGitIgnored?: unknown } }>).detail;
      if (detail?.cwd !== cwd || detail.peer !== (remotePeer ?? null) || !detail.settings) return;
      explorerFilterRequestIdRef.current += 1;
      explorerFilterAbortRef.current?.abort();
      explorerFilterAbortRef.current = null;
      invalidateFileIndexRequests();
      setHideGitIgnored(detail.settings.hideGitIgnored === true);
      setFileVisibilityReady(true);
      setFileIndex(null);
      setAtServerResult(null);
      fileIndexMetaRef.current = null;
      setFileIndexLoading(false);
    };
    window.addEventListener(EXPLORER_FILTER_CHANGED_EVENT, handleFilterChange);
    return () => window.removeEventListener(EXPLORER_FILTER_CHANGED_EVENT, handleFilterChange);
  }, [cwd, invalidateFileIndexRequests, remotePeer]);

  useEffect(() => {
    if (!embeddedInParent) return;
    const handleEmbeddedSlashDetailsClose = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data as { type?: unknown; requestId?: unknown } | null;
      if (data?.type !== EMBEDDED_SLASH_DETAILS_CLOSE_EVENT) return;
      if (typeof data.requestId === "number" && data.requestId !== slashDetailRequestRef.current) return;
      slashDetailRequestRef.current += 1;
      setSlashDetailCommand(null);
      setSlashDetailContent("");
      setSlashDetailLoading(false);
      setSlashDetailError(null);
      slashDetailOpenerRef.current?.focus({ preventScroll: true });
      slashDetailOpenerRef.current = null;
    };
    window.addEventListener("message", handleEmbeddedSlashDetailsClose);
    return () => window.removeEventListener("message", handleEmbeddedSlashDetailsClose);
  }, [embeddedInParent]);

  useEffect(() => {
    if (!embeddedInParent) return;
    const sourcePath = slashDetailCommand && "sourceInfo" in slashDetailCommand
      ? slashDetailCommand.sourceInfo?.path
      : undefined;
    const editablePrompt = slashDetailCommand?.source === "customPrompt"
      ? {
        id: slashDetailCommand.promptId,
        title: slashDetailCommand.name,
        description: slashDetailCommand.promptDescription ?? "",
        content: slashDetailCommand.content,
      }
      : undefined;
    const state = slashDetailCommand
      ? {
        type: EMBEDDED_SLASH_DETAILS_EVENT,
        open: true,
        requestId: slashDetailRequestRef.current,
        label: slashDetailCommand.source === "customPrompt" ? slashDetailCommand.name : `/${slashDetailCommand.name}`,
        content: slashDetailContent,
        loading: slashDetailLoading,
        error: slashDetailError,
        ...(sourcePath ? { sourcePath } : {}),
        ...(editablePrompt ? { editablePrompt } : {}),
        ...(cwd ? { cwd } : {}),
        ...(sessionId ? { sessionId } : {}),
      }
      : {
        type: EMBEDDED_SLASH_DETAILS_EVENT,
        open: false,
        requestId: slashDetailRequestRef.current,
      };
    window.parent.postMessage(state, "*");
  }, [cwd, embeddedInParent, sessionId, slashDetailCommand, slashDetailContent, slashDetailError, slashDetailLoading]);

  useEffect(() => {
    if (!embeddedInParent) return;
    return () => {
      if (!slashDetailCommandRef.current) return;
      window.parent.postMessage({
        type: EMBEDDED_SLASH_DETAILS_EVENT,
        open: false,
        requestId: slashDetailRequestRef.current,
      }, "*");
    };
  }, [embeddedInParent]);

  const loadCustomPrompts = useCallback(async () => {
    const requestId = ++customPromptRequestIdRef.current;
    try {
      const response = await fetch(apiPath("custom-prompts"), { cache: "no-store" });
      if (!response.ok) throw new Error(`custom prompts fetch failed: ${response.status}`);
      const data = await response.json() as unknown;
      const rawPrompts = data && typeof data === "object" && !Array.isArray(data)
        ? (data as { prompts?: unknown }).prompts
        : undefined;
      const prompts = getCustomPromptsFromResponse(data);
      if (!Array.isArray(rawPrompts) || prompts.length !== rawPrompts.length) {
        throw new Error("custom prompts response invalid");
      }
      if (requestId === customPromptRequestIdRef.current) {
        setCustomPrompts(prompts);
        try {
          window.localStorage.setItem(CUSTOM_PROMPTS_STORAGE_KEY, JSON.stringify(prompts));
        } catch {
          // LocalStorage quota or access denied.
        }
      }
    } catch (error) {
      console.warn("[ChatInput] failed to load custom prompts:", error);
      setCustomPrompts([]);
    }
  }, [apiPath]);

  const persistSlashFavorites = useCallback((next: string[]) => {
    const normalized = normalizeSlashFavoriteKeys(next);
    const mutationId = slashFavoriteMutationRef.current + 1;
    slashFavoriteMutationRef.current = mutationId;
    setSlashFavoriteError(null);
    setSlashFavoriteKeys(normalized);
    try {
      window.localStorage.setItem(SLASH_FAVORITES_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // The server-side config remains the durable source when browser storage is unavailable.
    }
    const eventDetail = { keys: normalized, categories: slashFavoriteCategories };
    window.dispatchEvent(new CustomEvent("pi-web:slash-command-favorites-changed", { detail: eventDetail }));
    if (typeof window !== "undefined") {
      if (window.parent !== window) {
        window.parent.postMessage({ type: "pi-web:slash-command-favorites-changed", detail: eventDetail }, "*");
      }
      document.querySelectorAll("iframe").forEach((frame) => {
        try { frame.contentWindow?.postMessage({ type: "pi-web:slash-command-favorites-changed", detail: eventDetail }, "*"); } catch { /* Ignore cross-origin frame postMessage errors */ }
      });
    }
    slashFavoriteWriteRef.current = slashFavoriteWriteRef.current
      .catch(() => undefined)
      .then(async () => {
        const response = await fetch(apiPath("slash-command-favorites"), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ keys: normalized }),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => null) as { error?: unknown } | null;
          throw new Error(typeof data?.error === "string" ? data.error : `slash favorites save failed: ${response.status}`);
        }
      })
      .catch((error) => {
        if (mutationId === slashFavoriteMutationRef.current) setSlashFavoriteError(t("chat.slashFavoritesSaveFailed"));
        console.warn("[ChatInput] failed to persist slash favorites:", error);
      });
  }, [apiPath, t]);

  const loadSlashFavorites = useCallback(async () => {
    const mutationAtStart = slashFavoriteMutationRef.current;
    const localKeys = readLocalSlashFavoriteKeys();
    setSlashFavoriteError(null);
    let allowLocalFallback = false;
    try {
      const response = await fetch(apiPath("slash-command-favorites"), { cache: "no-store" });
      const data = await response.json().catch(() => null) as {
        code?: unknown;
        error?: unknown;
        favorites?: { keys?: unknown; categories?: unknown };
      } | null;
      const resolved = resolveSlashFavoriteLoad(data, response.status, localKeys);
      if (!resolved.available && !resolved.fallback) {
        throw new Error(typeof data?.error === "string" ? data.error : `slash favorites load failed: ${response.status}`);
      }
      if (resolved.fallback) {
        allowLocalFallback = true;
        throw new Error("slash favorites endpoint unavailable");
      }
      const remoteKeys = resolved.keys;
      if (slashFavoriteMutationRef.current !== mutationAtStart) return;
      setSlashFavoriteKeys(remoteKeys);
      try { window.localStorage.setItem(SLASH_FAVORITES_STORAGE_KEY, JSON.stringify(remoteKeys)); } catch { /* Ignore storage quota errors */ }
      if (data?.favorites && Array.isArray((data.favorites as { categories?: unknown }).categories)) {
        const cats = normalizeSlashFavoriteCategories((data.favorites as { categories: unknown }).categories);
        setSlashFavoriteCategories(cats);
        try { window.localStorage.setItem(SLASH_FAVORITE_CATEGORIES_STORAGE_KEY, JSON.stringify(cats)); } catch { /* Ignore storage quota errors */ }
      }
      setSlashFavoriteError(null);
    } catch (error) {
      if (slashFavoriteMutationRef.current !== mutationAtStart) return;
      if (allowLocalFallback || error instanceof TypeError) {
        setSlashFavoriteKeys(localKeys);
        return;
      }
      setSlashFavoriteKeys([]);
      try { window.localStorage.setItem(SLASH_FAVORITES_STORAGE_KEY, "[]"); } catch { /* Ignore storage quota errors */ }
      setSlashFavoriteError(t("chat.slashFavoritesLoadFailed"));
      console.warn("[ChatInput] failed to load slash favorites:", error);
    }
  }, [apiPath, t]);

  useEffect(() => {
    void loadSlashFavorites();
    const onFavoritesChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ keys?: unknown; categories?: unknown }>).detail;
      if (Array.isArray(detail?.keys)) {
        const nextKeys = normalizeSlashFavoriteKeys(detail.keys);
        setSlashFavoriteKeys(nextKeys);
        try { window.localStorage.setItem(SLASH_FAVORITES_STORAGE_KEY, JSON.stringify(nextKeys)); } catch { /* Ignore storage quota errors */ }
      }
      if (Array.isArray(detail?.categories)) {
        const nextCats = normalizeSlashFavoriteCategories(detail.categories);
        setSlashFavoriteCategories(nextCats);
        try { window.localStorage.setItem(SLASH_FAVORITE_CATEGORIES_STORAGE_KEY, JSON.stringify(nextCats)); } catch { /* Ignore storage quota errors */ }
      }
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; detail?: unknown } | null;
      if (data?.type === "pi-web:slash-command-favorites-changed") {
        const detail = data.detail as { keys?: unknown; categories?: unknown } | null;
        if (Array.isArray(detail?.keys)) {
          const nextKeys = normalizeSlashFavoriteKeys(detail.keys);
          setSlashFavoriteKeys(nextKeys);
          try { window.localStorage.setItem(SLASH_FAVORITES_STORAGE_KEY, JSON.stringify(nextKeys)); } catch { /* Ignore storage quota errors */ }
        }
        if (Array.isArray(detail?.categories)) {
          const nextCats = normalizeSlashFavoriteCategories(detail.categories);
          setSlashFavoriteCategories(nextCats);
          try { window.localStorage.setItem(SLASH_FAVORITE_CATEGORIES_STORAGE_KEY, JSON.stringify(nextCats)); } catch { /* Ignore storage quota errors */ }
        }
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === SLASH_FAVORITES_STORAGE_KEY && event.newValue) {
        try { setSlashFavoriteKeys(normalizeSlashFavoriteKeys(JSON.parse(event.newValue))); } catch { /* Ignore JSON parse errors */ }
      } else if (event.key === SLASH_FAVORITE_CATEGORIES_STORAGE_KEY && event.newValue) {
        try { setSlashFavoriteCategories(normalizeSlashFavoriteCategories(JSON.parse(event.newValue))); } catch { /* Ignore JSON parse errors */ }
      }
    };
    window.addEventListener("pi-web:slash-command-favorites-changed", onFavoritesChanged);
    window.addEventListener("message", onMessage);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("pi-web:slash-command-favorites-changed", onFavoritesChanged);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("storage", onStorage);
    };
  }, [loadSlashFavorites]);

  const toggleSlashFavorite = useCallback((command: SlashCommandPaletteItem) => {
    const key = getSlashCommandFavoriteKey(command);
    persistSlashFavorites(slashFavoriteKeys.includes(key)
      ? slashFavoriteKeys.filter((item) => item !== key)
      : [...slashFavoriteKeys, key]);
  }, [persistSlashFavorites, slashFavoriteKeys]);

  const handleSlashFavoriteDrop = useCallback((targetKey: string, fallbackDraggedKey = "") => {
    const draggedKey = slashDraggedFavoriteKey ?? fallbackDraggedKey;
    if (draggedKey && draggedKey !== targetKey) {
      persistSlashFavorites(reorderSlashFavoritesByDrop(slashFavoriteKeys, draggedKey, targetKey));
    }
    setSlashDraggedFavoriteKey(null);
    setSlashDragOverFavoriteKey(null);
  }, [persistSlashFavorites, slashDraggedFavoriteKey, slashFavoriteKeys]);

  const handleCustomPromptDrop = useCallback((targetPromptId: string, fallbackDraggedId = "") => {
    const draggedId = slashDraggedPromptId ?? fallbackDraggedId;
    if (!draggedId || draggedId === targetPromptId) {
      setSlashDraggedPromptId(null);
      setSlashDragOverPromptId(null);
      return;
    }
    const currentPrompts = [...customPrompts];
    const fromIndex = currentPrompts.findIndex((p) => p.id === draggedId);
    const toIndex = currentPrompts.findIndex((p) => p.id === targetPromptId);
    if (fromIndex === -1 || toIndex === -1) {
      setSlashDraggedPromptId(null);
      setSlashDragOverPromptId(null);
      return;
    }
    const [moved] = currentPrompts.splice(fromIndex, 1);
    currentPrompts.splice(toIndex, 0, moved);
    const nextIds = currentPrompts.map((p) => p.id);
    setCustomPrompts(currentPrompts);
    try {
      window.localStorage.setItem(CUSTOM_PROMPTS_STORAGE_KEY, JSON.stringify(currentPrompts));
    } catch (storageError) {
      void storageError;
    }
    window.dispatchEvent(new CustomEvent(CUSTOM_PROMPTS_CHANGED_EVENT, { detail: { prompts: currentPrompts } }));

    fetch(apiPath("custom-prompts"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reorder", orderedIds: nextIds }),
    }).catch((err) => {
      console.warn("[ChatInput] failed to persist reordered custom prompts:", err);
    });

    setSlashDraggedPromptId(null);
    setSlashDragOverPromptId(null);
  }, [apiPath, customPrompts, slashDraggedPromptId]);

  const handleMoveFavoriteToSubcategory = useCallback((key: string, targetCatId: string) => {
    setSlashFavoriteCategories((prev) => {
      const next = prev.map((cat) => {
        if (cat.id === targetCatId) {
          return { ...cat, keys: cat.keys.includes(key) ? cat.keys : [...cat.keys, key] };
        }
        return { ...cat, keys: cat.keys.filter((k) => k !== key) };
      });
      fetch(apiPath("slash-command-favorites"), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ categories: next }),
      }).then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { favorites?: unknown };
        if (data.favorites) {
          window.dispatchEvent(new CustomEvent("pi-web:slash-command-favorites-changed", { detail: data.favorites }));
        }
      }).catch((err) => console.warn("[ChatInput] failed to move favorite category:", err));
      return next;
    });
  }, [apiPath]);

  const openSlashCommandDetails = useCallback(async (command: SlashCommandPaletteItem) => {
    const requestId = ++slashDetailRequestRef.current;
    if (embeddedInParent) prepareEmbeddedModal("slash-detail");
    setSlashDetailCommand(command);
    setSlashDetailContent(getSlashCommandDetails(command, t));
    setSlashDetailError(null);
    const isExtension = command.source === "extension";
    const sourcePath = !isExtension && "sourceInfo" in command ? command.sourceInfo?.path : undefined;
    if (!sourcePath || isExtension) { setSlashDetailLoading(false); return; }
    setSlashDetailLoading(true);
    try {
      let offset = 0;
      let content = "";
      let truncated = false;
      do {
        const fileUrl = fileApiPath(sourcePath, "read", sessionId, remotePeer, { offset });
        if (!fileUrl.startsWith("/api/files/") && !fileUrl.startsWith("/api/remote/files/")) {
          throw new Error("Unsupported file details endpoint");
        }
        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error(`details read failed: ${response.status}`);
        const data = await response.json() as { content?: unknown; nextOffset?: unknown; truncated?: unknown };
        const chunk = typeof data.content === "string" ? data.content : "";
        const nextOffset = typeof data.nextOffset === "number" ? data.nextOffset : offset;
        content += chunk;
        truncated = data.truncated === true;
        if (!truncated || nextOffset <= offset) break;
        offset = nextOffset;
      } while (content.length < 4 * 1024 * 1024);
      if (requestId !== slashDetailRequestRef.current) return;
      setSlashDetailContent(content || getSlashCommandDetails(command, t));
      setSlashDetailError(truncated ? t("chat.slashCommandDetailsTooLarge") : null);
    } catch (error) {
      if (requestId !== slashDetailRequestRef.current) return;
      setSlashDetailError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === slashDetailRequestRef.current) setSlashDetailLoading(false);
    }
  }, [embeddedInParent, remotePeer, sessionId, t]);

  const resetDraftPromptTools = useCallback(() => {
    resetDraftPromptRequest(
      draftPromptRequestRef,
      setDraftAnalysis,
      setDraftRewrite,
      setDraftSte100Rewrite,
    );
    draftPromptSourceRef.current = null;
    draftAnalysisQuestionRef.current = null;
    setDraftAnalysisDialogOpen(false);
    setDraftAnalysisMode("question");
  }, []);

  useEffect(() => {
    if (draftPromptSourceRef.current !== null && draftPromptSourceRef.current !== value) {
      resetDraftPromptTools();
    }
  }, [resetDraftPromptTools, value]);

  useEffect(() => {
    resetDraftPromptTools();
  }, [draftKey, remotePeer, resetDraftPromptTools]);

  // IME composition can be canceled by a window blur or visibility change
  // without delivering compositionend. Reset the guard and restore menu focus
  // so arrow navigation cannot remain disabled until a full page refresh.
  useEffect(() => {
    const resetComposition = () => {
      isComposingRef.current = false;
      lastCompositionEndAtRef.current = 0;
    };
    const restoreMenuFocus = () => {
      if (document.visibilityState !== "visible" || (!slashMenuOpen && !atMenuOpen && !historyMenuOpen)) return;
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") resetComposition();
      else restoreMenuFocus();
    };
    window.addEventListener("blur", resetComposition);
    window.addEventListener("focus", restoreMenuFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", resetComposition);
      window.removeEventListener("focus", restoreMenuFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [atMenuOpen, historyMenuOpen, slashMenuOpen]);

  useLayoutEffect(() => {
    const pending = pendingDraftFocusRef.current;
    const ta = textareaRef.current;
    if (!pending || !ta) return;
    pendingDraftFocusRef.current = null;
    if (pending.key !== draftKey || pending.value !== value) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    resizeChatInput(ta, true);
  }, [draftKey, value]);

  useImperativeHandle(ref, () => ({
    hasRefreshRisk() {
      return Boolean(valueRef.current || textareaRef.current?.value || attachedImagesRef.current.length
        || pendingImageCountRef.current || quotesRef.current.length || statePending || isStreaming || builtinCommandPendingRef.current);
    },
    insertIfEmpty(text: string, images?: ChatDraftImage[]) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      if (current.trim() || attachedImagesRef.current.length) return;
      pendingDraftFocusRef.current = { key: draftKey, value: text };
      valueRef.current = text;
      setValue(text);
      setAttachedImages((prev) => {
        prev.forEach(revokeImagePreview);
        return draftImagesToAttachedImages(images);
      });
      setAtQuery(null);
    },
    replaceMessage(message: UserMessage) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      if (!canRestoreUserMessage(current, attachedImagesRef.current.length, pendingImageCountRef.current)) return false;

      const restoredText = getUserMessageText(message);
      const imageCount = typeof message.content === "string" ? 0 : message.content.filter((block) => block.type === "image").length;
      const draftImages = getUserMessageDraftImages(message);
      // Restoring an edit is atomic: a display URL or invalid image must not
      // silently turn a complete user message into a partial draft.
      if (draftImages.length !== imageCount || imageCount > MAX_ATTACHED_IMAGES) return false;
      const restoredImages = draftImagesToAttachedImages(draftImages);
      if (restoredImages.length !== imageCount) return false;
      pendingDraftFocusRef.current = { key: draftKey, value: restoredText };
      valueRef.current = restoredText;
      attachedImagesRef.current = restoredImages;
      setValue(restoredText);
      setAtQuery(null);
      setHistoryMenuOpen(false);
      setAttachedImages((prev) => {
        prev.forEach(revokeImagePreview);
        return restoredImages;
      });
      return true;
    },
    availableImageSlots() {
      return Math.max(0, MAX_ATTACHED_IMAGES - attachedImagesRef.current.length - pendingImageCountRef.current);
    },
    hasQueuedDraft(operationId: string) {
      return Boolean(draftKey && getDraft(draftKey)?.recalledQueueOperations?.includes(operationId));
    },
    isQueuedDraftDurable(operationId: string) {
      return Boolean(draftKey && isRecalledDraftDurable(draftKey, operationId));
    },
    prependQueuedDraft(text: string, images: ChatDraftImage[], operationId?: string) {
      if (operationId && draftKey && getDraft(draftKey)?.recalledQueueOperations?.includes(operationId)) return true;
      // Atomic all-or-nothing recall: inputs may change while clear_queue is
      // in flight. The caller keeps a rejected recall; never slice its images.
      if (images.length + attachedImagesRef.current.length + pendingImageCountRef.current > MAX_ATTACHED_IMAGES
        || !images.every(isBase64ImageWithinLimits)) return false;
      const current = textareaRef.current?.value ?? valueRef.current;
      const combined = [text, current].filter(value => value.trim()).join("\n\n");
      if (operationId) {
        if (!draftKey) throw new Error("A session draft is required to save recalled messages");
        setRecalledDraft(draftKey, { value: combined,
          images: [...images, ...attachedImagesRef.current].map(({ data, mimeType }) => ({ data, mimeType })),
          quotes: quotesRef.current,
        }, operationId);
      }
      const nextImages = [...images.map(draftImageToAttachedImage), ...attachedImagesRef.current];
      pendingDraftFocusRef.current = { key: draftKey, value: combined };
      valueRef.current = combined;
      attachedImagesRef.current = nextImages;
      setValue(combined);
      setAttachedImages(nextImages);
      setAtQuery(null);
      return true;
    },
    prependText(text: string, images?: ChatDraftImage[]) {
      if (!text.trim() && !images?.length) return;
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      // Mirrors the TUI's queue restore: queued text first, then whatever
      // the user already typed, separated by a blank line.
      const combined = [text, current].filter((t) => t.trim()).join("\n\n");
      pendingDraftFocusRef.current = { key: draftKey, value: combined };
      valueRef.current = combined;
      setValue(combined);
      if (images?.length) {
        setAttachedImages((prev) => {
          const restored = draftImagesToAttachedImages(images);
          const accepted = restored.slice(0, Math.max(0, MAX_ATTACHED_IMAGES - prev.length));
          restored.slice(accepted.length).forEach(revokeImagePreview);
          return [...prev, ...accepted];
        });
      }
      setAtQuery(null);
    },
    rekeyDraft(previousKey: string, nextKey: string) {
      if (previousKey === nextKey) return;
      if (draftKeyRef.current !== previousKey) {
        rekeyStoredDraft(previousKey, nextKey);
        return;
      }

      const currentDraft = {
        value: valueRef.current,
        images: attachedImagesRef.current.map(imageToDraftImage),
      };
      const moved = rekeyStoredDraft(previousKey, nextKey, currentDraft) ?? { value: "", images: [] };
      const unchanged = moved.value === currentDraft.value
        && moved.images.length === currentDraft.images.length
        && moved.images.every((image, index) => (
          image.data === currentDraft.images[index]?.data
          && image.mimeType === currentDraft.images[index]?.mimeType
        ));
      draftKeyRef.current = nextKey;
      if (unchanged) return;

      const movedImages = draftImagesToAttachedImages(moved.images);
      valueRef.current = moved.value;
      attachedImagesRef.current = movedImages;
      setValue(moved.value);
      setAttachedImages((current) => {
        current.forEach(revokeImagePreview);
        return movedImages;
      });
      setAtQuery(null);
      setHistoryMenuOpen(false);
    },
    restoreSubmission(text: string, images?: ChatDraftImage[], targetDraftKey?: string) {
      if (!text.trim() && !images?.length) return;

      // clearInput is queued before the submission handler runs. Compose with
      // that queued state so a fast rejection cannot observe stale DOM text and
      // then get overwritten by the clear.
      const currentDraftKey = draftKeyRef.current;
      const destinationDraftKey = targetDraftKey ?? currentDraftKey;
      const targetsCurrentComposer = destinationDraftKey === currentDraftKey;
      const storedDraft = !targetsCurrentComposer && destinationDraftKey
        ? getDraft(destinationDraftKey)
        : null;
      const restoredDraft = mergeRestoredSubmissionDraft(
        text,
        images,
        targetsCurrentComposer ? valueRef.current : (storedDraft?.value ?? ""),
        targetsCurrentComposer
          ? attachedImagesRef.current.map(imageToDraftImage)
          : (storedDraft?.images ?? []),
      );
      // The first optimistic message switches ChatWindow out of its empty-state
      // layout and remounts this component. Persist synchronously so recovery is
      // not lost if this instance is the one being unmounted.
      if (destinationDraftKey) setDraft(destinationDraftKey, restoredDraft);
      if (!targetsCurrentComposer) return;
      const restoredImages = images?.length
        ? [
            ...draftImagesToAttachedImages(images).slice(
              0,
              Math.max(0, MAX_ATTACHED_IMAGES - attachedImagesRef.current.length),
            ),
            ...attachedImagesRef.current,
          ].slice(0, MAX_ATTACHED_IMAGES)
        : attachedImagesRef.current;
      // Session promotion can rekey this composer before React flushes the
      // functional updates below, so update the imperative snapshot first.
      valueRef.current = restoredDraft.value;
      attachedImagesRef.current = restoredImages;
      setValue((current) => {
        const restored = mergeRestoredSubmissionText(text, current);
        valueRef.current = restored;
        return restored;
      });
      setAtQuery(null);
      setHistoryMenuOpen(false);
      if (images?.length) {
        setAttachedImages((current) => {
          const available = Math.max(0, MAX_ATTACHED_IMAGES - current.length);
          const restored = draftImagesToAttachedImages(images)
            .slice(0, available);
          const next = restored.length > 0 ? [...restored, ...current] : current;
          attachedImagesRef.current = next;
          return next;
        });
      }
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        resizeChatInput(ta);
      });
    },
    addQuote(text: string, sourceTurnId?: string, reply?: string) {
      if (!text.trim()) return;
      const newQuote: QuoteContextItem = {
        id: `quote-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        text: text.trim(),
        reply: reply?.trim() || undefined,
        sourceTurnId,
      };
      setQuotes((prev) => [...prev, newQuote]);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) ta.focus();
      });
    },
    addQuoteItem(quote: QuoteContextItem) {
      setQuotes((prev) => [...prev, quote]);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) ta.focus();
      });
    },
    updateQuoteReply(id: string, reply: string) {
      setQuotes((prev) => prev.map((q) => (q.id === id ? { ...q, reply: reply.trim() } : q)));
    },
    updateQuote(id: string, text: string) {
      setQuotes((prev) => prev.map((q) => (q.id === id ? { ...q, text } : q)));
    },
    removeQuote(id: string) {
      setQuotes((prev) => prev.filter((q) => q.id !== id));
    },
    getQuotes() {
      return quotesRef.current;
    },
    insertText(text: string) {
      const ta = textareaRef.current;
      if (!ta) {
        setValue((v) => v + (v ? " " : "") + text);
        return;
      }
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const sep = before.length > 0 && !before.endsWith(" ") ? " " : "";
      const newVal = before + sep + text + after;
      valueRef.current = newVal;
      setValue(newVal);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        const pos = start + sep.length + text.length;
        ta.setSelectionRange(pos, pos);
        ta.focus();
        resizeChatInput(ta);
      });
    },
    addImages(files: File[]) {
      processImageFiles(files);
    },
  }));

  useLayoutEffect(() => {
    onReady?.();
  }, [onReady]);

  const processImageFiles = useCallback(async (files: File[]) => {
    if (isStreaming && !onSteer && !onFollowUp && !onPromptWithStreamingBehavior) return;
    const remaining = Math.max(
      0,
      MAX_ATTACHED_IMAGES - attachedImagesRef.current.length - pendingImageCountRef.current,
    );
    const imageFiles = files
      .filter((f) => f.type.startsWith("image/") && f.size <= MAX_ATTACHED_IMAGE_BYTES)
      .slice(0, remaining);
    if (!imageFiles.length) return;
    pendingImageCountRef.current += imageFiles.length;
    try {
      const newImages = await Promise.all(
        imageFiles.map(async (file) => ({
          ...await compressImageFile(file),
          previewUrl: URL.createObjectURL(file),
        }))
      );
      setAttachedImages((prev) => {
        const accepted = newImages.slice(0, Math.max(0, MAX_ATTACHED_IMAGES - prev.length));
        newImages.slice(accepted.length).forEach(revokeImagePreview);
        const next = [...prev, ...accepted];
        attachedImagesRef.current = next;
        return next;
      });
    } finally {
      pendingImageCountRef.current -= imageFiles.length;
    }
  }, [isStreaming, onSteer, onFollowUp, onPromptWithStreamingBehavior]);

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed) revokeImagePreview(removed);
      attachedImagesRef.current = next;
      return next;
    });
  }, []);

  const clearImages = useCallback(() => {
    attachedImagesRef.current = [];
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return [];
    });
  }, []);

  const clearInput = useCallback(() => {
    valueRef.current = "";
    setValue("");
    setSlashMenuOpenedByButton(false);
    setSlashCaret(null);
    resetDraftPromptTools();
    setAtQuery(null);
    setHistoryMenuOpen(false);
    if (draftKey) clearDraft(draftKey);
    if (draftKeyRef.current && draftKeyRef.current !== draftKey) clearDraft(draftKeyRef.current);
    clearImages();
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [clearImages, draftKey, resetDraftPromptTools]);

  const resolveDraftSessionId = useCallback(async () => {
    const sid = sessionId ?? await onEnsureSession?.();
    if (!sid) throw new Error(t("chat.promptToolsSessionUnavailable"));
    return sid;
  }, [onEnsureSession, sessionId, t]);

  const openDraftAnalysisDialog = useCallback(() => {
    if (!canUseDraftPromptTools || draftAnalysis.status === "loading") return;
    setDraftAnalysisMode(draftAnalysis.status === "ready" && draftAnalysis.result.context?.mode === "context" ? "context" : "question");
    setDraftAnalysisDialogOpen(true);
  }, [canUseDraftPromptTools, draftAnalysis]);

  const createDraftPromptController = useCallback(() => createDraftPromptRequestController({
    requestIdRef: draftPromptRequestRef,
    resolveSessionId: resolveDraftSessionId,
    send: (sid, payload) => sendAgentCommand(sid, payload, remotePeer),
    setAnalysis: setDraftAnalysis,
    setRewrite: setDraftRewrite,
    setSte100: setDraftSte100Rewrite,
    noResultMessage: t("chat.promptToolsNoResult"),
    failedMessage: t("chat.promptToolsFailed"),
  }), [remotePeer, resolveDraftSessionId, t]);

  const runDraftAnalysis = useCallback((mode: QuestionAnalysisMode) => {
    const question = value.trim();
    if (!canUseDraftPromptTools || !question || draftAnalysis.status === "loading") return;
    draftPromptSourceRef.current = value;
    draftAnalysisQuestionRef.current = value.trim();
    setDraftAnalysisDialogOpen(false);
    void createDraftPromptController().runAnalysis(mode, question);
  }, [canUseDraftPromptTools, createDraftPromptController, draftAnalysis.status, value]);

  const runDraftRewrite = useCallback(() => {
    const question = (draftAnalysis.status === "ready"
      ? stripTrailingTerms(value, draftAnalysis.result.text)
      : value).trim();
    if (!canUseDraftPromptTools || !question || draftAnalysis.status !== "ready" || draftRewrite.status === "loading") return;
    draftPromptSourceRef.current = value;
    void createDraftPromptController().runRewrite(question, draftAnalysis.result.text);
  }, [canUseDraftPromptTools, createDraftPromptController, draftAnalysis, draftRewrite.status, value]);

  const runDraftSte100Rewrite = useCallback(() => {
    const question = (draftAnalysis.status === "ready"
      ? stripTrailingTerms(value, draftAnalysis.result.text)
      : value).trim();
    if (!canUseDraftPromptTools || !question || draftSte100Rewrite.status === "loading") return;
    draftPromptSourceRef.current = value;
    void createDraftPromptController().runSte100(question);
  }, [canUseDraftPromptTools, createDraftPromptController, draftAnalysis, draftSte100Rewrite.status, value]);

  const insertDraftTerms = useCallback(() => {
    if (draftAnalysis.status !== "ready") return;
    const terms = draftAnalysis.result.text.trim();
    if (!terms || draftTermsInserted) return;
    const nextValue = appendTermsToDraft(valueRef.current, terms);
    if (!nextValue.trim()) return;
    draftPromptSourceRef.current = nextValue;
    valueRef.current = nextValue;
    setValue(nextValue);
    setAtQuery(null);
    setHistoryMenuOpen(false);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(nextValue.length, nextValue.length);
      resizeChatInput(ta);
    });
  }, [draftAnalysis, draftTermsInserted]);

  const applyDraftText = useCallback((result: QuestionRewriteResult, preserveTerms: boolean) => {
    const rewritten = result.text.trim();
    if (!rewritten) return;
    const nextValue = preserveTerms && draftTermsInserted && draftAnalysis.status === "ready"
      ? appendTermsToDraft(rewritten, draftAnalysis.result.text)
      : rewritten;
    draftPromptSourceRef.current = nextValue;
    valueRef.current = nextValue;
    setValue(nextValue);
    setAtQuery(null);
    setHistoryMenuOpen(false);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(nextValue.length, nextValue.length);
      resizeChatInput(ta);
    });
  }, [draftAnalysis, draftTermsInserted]);

  const applyDraftRewrite = useCallback(() => {
    if (draftRewrite.status !== "ready") return;
    applyDraftText(draftRewrite.result, true);
  }, [applyDraftText, draftRewrite]);

  const applyDraftSte100Rewrite = useCallback(() => {
    if (draftSte100Rewrite.status !== "ready") return;
    applyDraftText(draftSte100Rewrite.result, true);
  }, [applyDraftText, draftSte100Rewrite]);

  // ── Reader local patch: image-generation panel state ───────────
  // New sessions have no session file yet (created on first message), so fetch
  // the config-file defaults without a sessionFile. Option writes still update
  // the global default immediately and remain pending for the eventual session.
  const mergePendingGenState = useCallback((data: ImageGenState): ImageGenState => {
    const pending = pendingGenOptionsRef.current;
    const genOptionsUnset = (data.genOptionsUnset ?? []).filter((field) => pending[field] === undefined);
    return {
      ...data,
      ...(pending.size !== undefined ? { genSize: pending.size } : {}),
      ...(pending.resolution !== undefined ? { genResolution: pending.resolution } : {}),
      ...(pending.quality !== undefined ? { genQuality: pending.quality } : {}),
      genOptionsUnset: genOptionsUnset.length > 0 ? genOptionsUnset : undefined,
    };
  }, []);

  const clearPendingGenOptions = useCallback((body: Record<string, unknown>) => {
    const next = { ...pendingGenOptionsRef.current };
    const fields: GenOptionField[] = body.action === "clearGenOptions" && Array.isArray(body.fields)
      ? body.fields.filter((field): field is GenOptionField => field === "size" || field === "resolution" || field === "quality")
      : (["size", "resolution", "quality"] as const).filter((field) => typeof body[field] === "string" && next[field] === body[field]);
    for (const field of fields) delete next[field];
    pendingGenOptionsRef.current = next;
    setPendingGenOptions(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const url = apiPath(sessionFile
      ? `image-gen?sessionFile=${encodeURIComponent(sessionFile)}`
      : "image-gen");
    readImageGenState(url)
      .then((data) => {
        if (!cancelled && data) setGenState(mergePendingGenState(data));
      })
      .catch(() => { /* keep null */ });
    return () => { cancelled = true; };
  }, [sessionFile, mergePendingGenState, apiPath]);

  // Re-pull genState when the gen model/provider changes in the models panel
  // (ModelsConfig → ImageGenConfig dispatches GEN_CONFIG_CHANGED_EVENT), so the
  // composer size/resolution/quality selectors follow the current model
  // without a page refresh. New sessions have no file yet: listen anyway and
  // fall back to the config-file defaults (same URL as the initial fetch).
  useEffect(() => {
    const url = apiPath(sessionFile
      ? `image-gen?sessionFile=${encodeURIComponent(sessionFile)}`
      : "image-gen");
    const onGenChanged = () => {
      readImageGenState(url)
        .then((data) => { if (data) setGenState(mergePendingGenState(data)); })
        .catch(() => { /* keep */ });
    };
    window.addEventListener(GEN_CONFIG_CHANGED_EVENT, onGenChanged);
    return () => window.removeEventListener(GEN_CONFIG_CHANGED_EVENT, onGenChanged);
  }, [sessionFile, mergePendingGenState, apiPath]);

  // Once a new session gets its file, flush the pending switch value into it.
  // POST unconditionally: the optimistic genState.enabled already equals
  // pendingGenEnabled, so comparing them would skip the write and drop a
  // switch choice made before the first message created the session file.
  // The toggle is idempotent (re-POSTing the same value is harmless), and
  // clearing the pending value prevents a second flush on later renders.
  useEffect(() => {
    if (pendingGenEnabled === null || !sessionFile || genState === null) return;
    void postImageGen({ action: "toggle", enabled: pendingGenEnabled });
    setPendingGenEnabled(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the session/gen state dependencies define the flush points.
  }, [sessionFile, genState, pendingGenEnabled]);

  const postImageGen = (body: Record<string, unknown>): Promise<ImageGenState | null> => {
    // Serialize writes so a refresh cannot observe an older Composer choice
    // after a newer one has already been selected.
    const requestSessionFile = sessionFile;
    const operation = genWriteQueueRef.current.then(async () => {
      try {
        const requestBody = requestSessionFile ? { ...body, sessionFile: requestSessionFile } : body;
        const r = await fetch(apiPath("image-gen"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        });
        const data = await r.json();
        if (!r.ok || !data.ok) return null;
        const url = apiPath(requestSessionFile
          ? `image-gen?sessionFile=${encodeURIComponent(requestSessionFile)}`
          : "image-gen");
        const fresh = await readImageGenState(url);
        if (!fresh) return null;
        if (requestSessionFile && (body.action === "setGenOptions" || body.action === "clearGenOptions")) clearPendingGenOptions(body);
        setGenState(mergePendingGenState(fresh));
        return fresh;
      } catch {
        return null;
      }
    });
    genWriteQueueRef.current = operation.catch(() => null);
    return operation;
  };

  // Only explicit composer selections are copied into a session. Capability
  // fallbacks stay display-only, so they cannot turn a tool request into a
  // session override on session open.
  const genOptionsSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionFile || genOptionsSessionRef.current === sessionFile) return;
    genOptionsSessionRef.current = sessionFile;
    if (Object.keys(pendingGenOptions).length > 0) void postImageGen({ action: "setGenOptions", ...pendingGenOptions });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- postImageGen is recreated with sessionFile; these are the flush points.
  }, [sessionFile, pendingGenOptions]);

  const handleGenOption = (field: GenOptionField, value: string) => {
    if (!genState) return;
    if (value === GEN_OPTION_REQUEST) {
      const nextUnset = [...new Set([...(genState.genOptionsUnset ?? []), field])];
      const localNext = field === "size" ? { genSize: undefined } : field === "resolution" ? { genResolution: undefined } : { genQuality: undefined };
      setGenState((st) => (st ? { ...st, ...localNext, genOptionsUnset: nextUnset } : st));
      const nextPending = { ...pendingGenOptionsRef.current };
      delete nextPending[field];
      pendingGenOptionsRef.current = nextPending;
      setPendingGenOptions((pending) => {
        const next = { ...pending };
        delete next[field];
        return next;
      });
      void postImageGen({ action: "clearGenOptions", fields: [field] });
      return;
    }
    const localNext =
      field === "size" ? { genSize: value }
      : field === "resolution" ? { genResolution: value }
      : { genQuality: value };
    const request =
      field === "size" ? { size: value }
      : field === "resolution" ? { resolution: value }
      : { quality: value };
    setGenState((st) => (st ? {
      ...st,
      ...localNext,
      genOptionsUnset: st.genOptionsUnset?.filter((unsetField) => unsetField !== field),
    } : st));
    pendingGenOptionsRef.current = { ...pendingGenOptionsRef.current, ...request };
    setPendingGenOptions((pending) => ({ ...pending, ...request }));
    void postImageGen({ action: "setGenOptions", ...request });
  };

  const handleGenToggle = () => {
    if (!genState) return;
    const next = !genState.enabled;
    setPendingGenEnabled(next);
    setGenState((s) => (s ? { ...s, enabled: next } : s));
    if (sessionFile) void postImageGen({ action: "toggle", enabled: next });
  };

  // ── end image-generation panel state ──────────────────────────

  useEffect(() => {
    if (!draftKey || draftKeyRef.current !== draftKey) return;
    setDraft(draftKey, {
      value,
      images: attachedImages.map(imageToDraftImage),
      quotes,
    });
  }, [attachedImages, draftKey, quotes, value]);

  useEffect(() => {
    const previousDraftKey = draftKeyRef.current;
    if (previousDraftKey === draftKey) return;

    if (previousDraftKey) {
      setDraft(previousDraftKey, {
        value: valueRef.current,
        images: attachedImagesRef.current.map(imageToDraftImage),
        quotes: quotesRef.current,
      });
    }

    const draft = draftKey ? getDraft(draftKey) : null;
    draftKeyRef.current = draftKey;
    const nextValue = draft?.value ?? "";
    const nextImages = draftImagesToAttachedImages(draft?.images);
    const nextQuotes = draft?.quotes ?? [];
    valueRef.current = nextValue;
    attachedImagesRef.current = nextImages;
    quotesRef.current = nextQuotes;
    setValue(nextValue);
    setQuotes(nextQuotes);
    setAtQuery(null);
    setHistoryMenuOpen(false);
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return nextImages;
    });
  }, [draftKey]);

  const inputPlaceholder = readOnlyReason ?? (
    isStreaming && (onSteer || onFollowUp)
      ? t("chat.steerPlaceholder")
      : isStreaming ? t("chat.agentPlaceholder")
      : t("chat.messagePlaceholder")
  );

  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const resize = () => resizeChatInput(ta, ta.selectionStart === ta.value.length);
    resize();
    if (typeof ResizeObserver === "undefined") return;
    let width = ta.getBoundingClientRect().width;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      resize();
    });
    observer.observe(ta);
    return () => observer.disconnect();
  }, [value, draftKey, isMobile, inputPlaceholder, showEditorSuggestion]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    // Shift+Enter on desktop, Enter on mobile keyboards: every newline the
    // textarea inserts arrives here, while IME confirmations and sends do not.
    const continueList = (event: InputEvent) => {
      if (event.inputType !== "insertLineBreak" || event.isComposing) return;
      const edit = getMarkdownListEdit(ta.value, ta.selectionStart, ta.selectionEnd);
      if (!edit) return;
      event.preventDefault();
      ta.setSelectionRange(edit.start, edit.end);
      // insertText keeps the edit on the native undo stack and fires the input
      // event that updates the controlled value.
      document.execCommand(edit.text ? "insertText" : "delete", false, edit.text);
    };
    ta.addEventListener("beforeinput", continueList);
    return () => ta.removeEventListener("beforeinput", continueList);
  }, []);

  useEffect(() => {
    return () => {
      attachedImagesRef.current.forEach(revokeImagePreview);
    };
  }, []);

  const runBuiltinCommand = useCallback(async (message: string): Promise<boolean> => {
    if (!onBuiltinCommand || attachedImagesRef.current.length || !message.startsWith("/")) return false;
    if (builtinCommandPendingRef.current) return true;
    builtinCommandPendingRef.current = true;
    setBuiltinCommandPending(true);
    try {
      const result = await onBuiltinCommand(message);
      if (result.handled && !result.error && canClearBuiltinCommandInput(valueRef.current, attachedImagesRef.current.length, message)) clearInput();
      return result.handled;
    } finally {
      builtinCommandPendingRef.current = false;
      setBuiltinCommandPending(false);
    }
  }, [clearInput, onBuiltinCommand]);

  const handleSend = useCallback(async () => {
    const msg = value.trim();
    if (!msg && !attachedImages.length && !quotes.length) return;
    if (statePending || builtinCommandPendingRef.current) return;
    onAudioUnlock?.();
    // Image-generation config persistence must not gate ordinary prompt admission.
    const builtinAllowed = !isStreaming || offersBuiltinSlashCommandWhileStreaming(msg);
    if (builtinAllowed && await runBuiltinCommand(msg)) return;
    if (isStreaming) return;

    const isCommand = msg.startsWith("/") || msg.startsWith("!");
    let effectiveMsg = msg;
    if (!isCommand && quotes.length > 0) {
      const formattedQuotes = formatQuoteItemsToMarkdown(quotes, t);
      effectiveMsg = msg ? `${formattedQuotes}\n\n${msg}` : formattedQuotes;
      setQuotes([]);
    }

    let questionAnalysis: QuestionAnalysisPromptMetadata | undefined;
    if (draftAnalysis.status === "ready" && draftAnalysisQuestionRef.current) {
      const original = draftAnalysisQuestionRef.current.trim();
      const rewriteReady = draftRewrite.status === "ready" ? draftRewrite.result : null;
      const rewriteText = rewriteReady ? rewriteReady.text.trim() : "";
      if (original && (original === msg || (rewriteText && rewriteText === msg))) {
        questionAnalysis = {
          question: original,
          result: draftAnalysis.result,
          ...(rewriteReady && rewriteText === msg ? { rewrite: rewriteReady } : {}),
        };
      }
    }
    clearInput();
    onSend(effectiveMsg, attachedImages.length ? attachedImages : undefined, questionAnalysis);
  }, [value, attachedImages, quotes, statePending, onAudioUnlock, isStreaming, runBuiltinCommand, draftAnalysis, draftRewrite, clearInput, onSend, t]);

  const slashCommandCandidates = [
    ...BUILTIN_SLASH_COMMANDS.filter((command) => !isStreaming || (command.source === "builtin" && command.availableWhileStreaming === true)),
    ...customPrompts.map(customPromptToSlashCommand),
    ...(slashCommands ?? []),
  ];
  const slashTrigger = getSlashCommandTrigger(
    value,
    slashCaret,
    slashCommandCandidates.map((command) => command.name),
  );
  const slashQuery = slashTrigger?.query ?? null;

  const slashMenuQuery = slashMenuOpenedByButton ? slashMenuSearch.trim().toLowerCase() : slashQuery;
  const filteredSlashCommands = (() => {
    if (slashMenuQuery === null) return [];
    const matchingCommands = slashCommandCandidates.filter((command) => {
      const name = command.name.toLowerCase();
      const description = getSlashDescription(command, t).toLowerCase();
      const content = command.source === "customPrompt" ? command.content.toLowerCase() : "";
      return name.includes(slashMenuQuery) || description.includes(slashMenuQuery) || content.includes(slashMenuQuery);
    });
    return sortSlashCommandItems(matchingCommands, slashMenuQuery, t);
  })();

  const slashTabCounts = getSlashTabCounts(filteredSlashCommands, slashFavoriteKeys);
  const tabFilteredSlashCommands = filterSlashCommandsByTab(filteredSlashCommands, activeSlashTab, slashFavoriteKeys);
  const favoriteOrder = new Map(slashFavoriteKeys.map((key, index) => [key, index]));
  const orderedTabFilteredSlashCommands = activeSlashTab === "favorites"
    ? [...tabFilteredSlashCommands].sort((a, b) => (favoriteOrder.get(getSlashCommandFavoriteKey(a)) ?? 0) - (favoriteOrder.get(getSlashCommandFavoriteKey(b)) ?? 0))
    : tabFilteredSlashCommands;
  const favoriteCommands = slashFavoriteKeys
    .map((key) => filteredSlashCommands.find((command) => getSlashCommandFavoriteKey(command) === key))
    .filter((command): command is SlashCommandPaletteItem => Boolean(command));
  const remainingCommands = activeSlashTab === "all"
    ? filteredSlashCommands.filter((command) => !slashFavoriteKeys.includes(getSlashCommandFavoriteKey(command)))
    : orderedTabFilteredSlashCommands;
  const categoryLayout = buildSlashCommandLayout(remainingCommands, skillDormancy);

  const isSearchingSlash = Boolean(slashMenuQuery && slashMenuQuery.trim());

  const slashLayout = (() => {
    // 1. Searching on a specific tab (not "all"): show current tab matches first, then other categories matches below
    if (isSearchingSlash && activeSlashTab !== "all") {
      const currentTabCommands = activeSlashTab === "favorites"
        ? favoriteCommands
        : filteredSlashCommands.filter((c) => c.source === activeSlashTab);

      let currentGroups: Array<{
        source: SlashCommandSource | "favorites";
        label?: string;
        items: Array<{ command: SlashCommandPaletteItem; index: number }>;
      }> = [];

      let globalIndex = 0;

      if (activeSlashTab === "favorites") {
        if (slashFavoriteCategories.length <= 1 || activeSlashSubcategory !== "all") {
          currentGroups = currentTabCommands.length > 0 ? [{
            source: "favorites",
            label: activeSlashSubcategory !== "all"
              ? (slashFavoriteCategories.find((c) => c.id === activeSlashSubcategory)?.name ?? t("chat.favorites"))
              : t("chat.favorites"),
            items: currentTabCommands.map((command) => ({ command, index: globalIndex++ })),
          }] : [];
        } else {
          for (const cat of slashFavoriteCategories) {
            const catKeySet = new Set(cat.keys);
            const catCmds = currentTabCommands.filter((cmd) => catKeySet.has(getSlashCommandFavoriteKey(cmd)));
            if (catCmds.length === 0) continue;
            currentGroups.push({
              source: "favorites",
              label: slashFavoriteCategoryLabel(cat, t("favorites.defaultCategory")),
              items: catCmds.map((command) => ({ command, index: globalIndex++ })),
            });
          }
        }
      } else if (currentTabCommands.length > 0) {
        currentGroups = [{
          source: activeSlashTab as SlashCommandSource,
          label: t(SLASH_SOURCE_GROUP_LABEL_KEYS[activeSlashTab as SlashCommandSource]),
          items: currentTabCommands.map((command) => ({ command, index: globalIndex++ })),
        }];
      }

      // Other categories matching items (all matching commands not in current tab)
      const currentKeySet = new Set(currentTabCommands.map(getSlashCommandFavoriteKey));
      const otherCommands = filteredSlashCommands.filter((c) => !currentKeySet.has(getSlashCommandFavoriteKey(c)));

      let otherGroups: Array<{
        source: SlashCommandSource | "favorites";
        label?: string;
        items: Array<{ command: SlashCommandPaletteItem; index: number }>;
      }> = [];

      if (otherCommands.length > 0) {
        const otherCategoryLayout = buildSlashCommandLayout(otherCommands, skillDormancy);
        otherGroups = otherCategoryLayout.groups.map((group) => ({
          ...group,
          label: `${t(SLASH_SOURCE_GROUP_LABEL_KEYS[group.source])} (${t("chat.otherResults")})`,
          items: group.items.map((item) => ({ ...item, index: globalIndex++ })),
        }));
      }

      const allCommands = [
        ...currentGroups.flatMap((g) => g.items.map((i) => i.command)),
        ...otherGroups.flatMap((g) => g.items.map((i) => i.command)),
      ];

      return {
        commands: allCommands,
        groups: [...currentGroups, ...otherGroups],
      };
    }

    // 2. Favorites tab (without search)
    if (activeSlashTab === "favorites") {
      if (slashFavoriteCategories.length <= 1 || activeSlashSubcategory !== "all") {
        const displayed = activeSlashSubcategory === "all"
          ? favoriteCommands
          : (() => {
              const cat = slashFavoriteCategories.find((c) => c.id === activeSlashSubcategory);
              const catKeys = new Set(cat?.keys ?? []);
              return favoriteCommands.filter((c) => catKeys.has(getSlashCommandFavoriteKey(c)));
            })();
        return {
          commands: displayed,
          groups: [{
            source: "favorites" as const,
            label: activeSlashSubcategory !== "all"
              ? (slashFavoriteCategories.find((c) => c.id === activeSlashSubcategory)?.name ?? t("chat.favorites"))
              : undefined,
            items: displayed.map((command, index) => ({ command, index })),
          }],
        };
      }
      const allCatCommands: SlashCommandPaletteItem[] = [];
      const groups: Array<{ source: "favorites"; label?: string; items: Array<{ command: SlashCommandPaletteItem; index: number }> }> = [];
      for (const cat of slashFavoriteCategories) {
        const catKeySet = new Set(cat.keys);
        const catCmds = favoriteCommands.filter((cmd) => catKeySet.has(getSlashCommandFavoriteKey(cmd)));
        if (catCmds.length === 0) continue;
        const startIndex = allCatCommands.length;
        allCatCommands.push(...catCmds);
        groups.push({
          source: "favorites" as const,
          label: slashFavoriteCategoryLabel(cat, t("favorites.defaultCategory")),
          items: catCmds.map((command, idx) => ({ command, index: startIndex + idx })),
        });
      }
      return {
        commands: allCatCommands.length > 0 ? allCatCommands : favoriteCommands,
        groups: groups.length > 0 ? groups : [{
          source: "favorites" as const,
          items: favoriteCommands.map((command, index) => ({ command, index })),
        }],
      };
    }

    // 3. "all" tab
    if (activeSlashTab === "all" && favoriteCommands.length > 0) {
      return {
        commands: [...favoriteCommands, ...categoryLayout.commands],
        groups: [
          { source: "favorites" as const, items: favoriteCommands.map((command, index) => ({ command, index })) },
          ...categoryLayout.groups.map((group) => ({
            ...group,
            items: group.items.map((item) => ({ ...item, index: item.index + favoriteCommands.length })),
          })),
        ],
      };
    }
    if (activeSlashTab === "all") {
      return categoryLayout;
    }

    // 4. Default: single specific category tab without search ("customPrompt", "skill", "prompt", "extension", "builtin")
    return categoryLayout;
  })();
  const displayedSlashCommands = slashLayout.commands;
  const groupedSlashCommands = slashLayout.groups;

  const slashCommandCountLabel = displayedSlashCommands.length === 1
    ? t(slashMenuQuery ? "chat.match" : "chat.command")
    : t(slashMenuQuery ? "chat.matches" : "chat.commands", { count: displayedSlashCommands.length });
  const canAttachImages = !isStreaming || Boolean(onSteer || onFollowUp || onPromptWithStreamingBehavior);
  const canQueueStreamingMessage = hasStreamingMessagePayload(value, attachedImages.length, quotes.length);

  // ── @ file autocomplete ──────────────────────────────────────────────────
  // Recomputed from the text before the caret on every change/caret move.
  // Disabled entirely when there is no cwd (new session without a directory).
  const updateAtQuery = useCallback((text: string, cursor: number | null) => {
    if (!cwd) {
      setAtQuery(null);
      return;
    }
    const pos = cursor ?? text.length;
    setAtQuery(extractAtQuery(text.slice(0, pos)));
  }, [cwd]);

  const closeSlashCommandMenu = useCallback(() => {
    setSlashMenuOpen(false);
    setSlashMenuOpenedByButton(false);
    setSlashMenuSearch("");
    setSlashActiveIndex(0);
    slashDetailRequestRef.current += 1;
    setSlashDetailCommand(null);
    setSlashDetailContent("");
    setSlashDetailLoading(false);
    setSlashDetailError(null);
    setSlashDraggedFavoriteKey(null);
    setSlashDragOverFavoriteKey(null);
  }, []);

  const openSlashCommandMenu = useCallback(() => {
    const ta = textareaRef.current;
    const start = ta?.selectionStart ?? null;
    const end = ta?.selectionEnd ?? null;
    setSlashMenuOpenedByButton(true);
    setSlashMenuSearch("");
    slashDetailRequestRef.current += 1;
    setSlashDetailCommand(null);
    setSlashDetailContent("");
    setSlashDetailLoading(false);
    setSlashDetailError(null);
    setActiveSlashTab("customPrompt");
    setSlashMenuOpen(true);
    setSlashActiveIndex(0);
    setHistoryMenuOpen(false);
    setAtMenuOpen(false);
    if (ta && start !== null && end !== null) ta.setSelectionRange(start, end);
  }, []);

  const toggleSlashCommandMenu = useCallback(() => {
    if (slashMenuOpen) closeSlashCommandMenu();
    else openSlashCommandMenu();
  }, [closeSlashCommandMenu, openSlashCommandMenu, slashMenuOpen]);

  const insertNewline = useCallback(() => {
    const ta = textareaRef.current;
    const current = ta?.value ?? valueRef.current;
    const start = ta?.selectionStart ?? current.length;
    const end = ta?.selectionEnd ?? current.length;
    const edit = getMarkdownListEdit(current, start, end);
    const { value: nextValue, cursor } = edit
      ? insertAtSelection(current, edit.start, edit.end, edit.text)
      : insertAtSelection(current, start, end, "\n");
    valueRef.current = nextValue;
    setValue(nextValue);
    setSlashCaret(cursor);
    setHistoryMenuOpen(false);
    updateAtQuery(nextValue, cursor);
    requestAnimationFrame(() => {
      const currentTextarea = textareaRef.current;
      if (!currentTextarea) return;
      currentTextarea.focus();
      currentTextarea.setSelectionRange(cursor, cursor);
      resizeChatInput(currentTextarea, cursor >= currentTextarea.value.length);
    });
  }, [updateAtQuery]);

  const insertAsciiSlash = useCallback(() => {
    const ta = textareaRef.current;
    const current = ta?.value ?? valueRef.current;
    const start = ta?.selectionStart ?? current.length;
    const end = ta?.selectionEnd ?? current.length;
    const { value: nextValue, cursor } = insertAtSelection(current, start, end, "/");
    valueRef.current = nextValue;
    setValue(nextValue);
    setSlashMenuOpenedByButton(false);
    setSlashMenuSearch("");
    setActiveSlashTab("customPrompt");
    setSlashCaret(cursor);
    setHistoryMenuOpen(false);
    setAtMenuOpen(false);
    updateAtQuery(nextValue, cursor);
    requestAnimationFrame(() => {
      const currentTextarea = textareaRef.current;
      if (!currentTextarea) return;
      currentTextarea.focus();
      currentTextarea.setSelectionRange(cursor, cursor);
      resizeChatInput(currentTextarea);
    });
  }, [updateAtQuery]);

  const atQueryText = atQuery?.query ?? null;
  const atLocalMatches: FileIndexEntry[] = React.useMemo(() => (
    atQueryText !== null && fileIndex && fileIndex.cwd === cwd && fileIndex.hideGitIgnored === hideGitIgnored
      ? filterFileEntries(fileIndex.entries, atQueryText)
      : []
  ), [atQueryText, fileIndex, cwd, hideGitIgnored]);

  // When the client index is truncated (repo larger than the index cap),
  // local filtering cannot see deep files, so queries are also ranked
  // server-side against the full listing. Local matches render immediately
  // and are replaced when the (debounced) server result for the current
  // query arrives; stale responses are ignored via the query/cwd tag.
  const needsServerSearch = Boolean(
    atQueryText
    && fileIndex?.truncated
    && fileIndex.cwd === cwd
    && fileIndex.hideGitIgnored === hideGitIgnored,
  );
  useEffect(() => {
    serverSearchAbortRef.current?.abort();
    serverSearchAbortRef.current = null;
    const requestId = serverSearchRequestIdRef.current + 1;
    serverSearchRequestIdRef.current = requestId;
    if (!needsServerSearch || !cwd || !atQueryText) return;
    const fetchCwd = cwd;
    const query = atQueryText;
    const controller = new AbortController();
    serverSearchAbortRef.current = controller;
    const timer = setTimeout(() => {
      fetch(apiPath(fileIndexRequestPath(fetchCwd, query, hideGitIgnored)), { signal: controller.signal })
        .then((res) => {
          if (!res.ok) throw new Error(`file search failed: ${res.status}`);
          return res.json() as Promise<{ matches?: FileIndexEntry[] }>;
        })
        .then((data) => {
          if (controller.signal.aborted || serverSearchRequestIdRef.current !== requestId) return;
          setAtServerResult({ cwd: fetchCwd, hideGitIgnored, query, matches: data.matches ?? [] });
        })
        .catch(() => {
          // Keep showing local matches; the next keystroke retries.
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      if (serverSearchRequestIdRef.current !== requestId) return;
      serverSearchRequestIdRef.current += 1;
      controller.abort();
      if (serverSearchAbortRef.current === controller) serverSearchAbortRef.current = null;
    };
  }, [needsServerSearch, atQueryText, cwd, hideGitIgnored, apiPath]);

  const serverResultInUse = needsServerSearch
    && atServerResult !== null
    && atServerResult.cwd === cwd
    && atServerResult.hideGitIgnored === hideGitIgnored
    && atServerResult.query === atQueryText;
  const atMatches: FileIndexEntry[] = serverResultInUse ? atServerResult.matches : atLocalMatches;

  // Open/reset the menu whenever the @token appears or changes (mirrors the
  // slash menu: Escape closes it, the next keystroke re-opens it).
  const atTokenKey = atQuery === null ? null : `${atQuery.start}:${atQuery.quoted ? 1 : 0}:${atQuery.query}`;
  useEffect(() => {
    if (atTokenKey === null) {
      setAtMenuOpen(false);
      setAtActiveIndex(0);
      return;
    }
    setAtMenuOpen(true);
    setAtActiveIndex(0);
  }, [atTokenKey]);

  // Fetch the file index when the menu opens. The server caches per cwd for
  // ~10s, so re-opening refreshes cheaply; while typing nothing refetches.
  const atTokenActive = atQuery !== null;
  useEffect(() => {
    if (!atTokenActive || !cwd || !fileVisibilityReady) return;
    const meta = fileIndexMetaRef.current;
    if (meta && meta.cwd === cwd && meta.hideGitIgnored === hideGitIgnored && Date.now() - meta.fetchedAt < 10_000) return;
    fileIndexAbortRef.current?.abort();
    const requestId = fileIndexRequestIdRef.current + 1;
    fileIndexRequestIdRef.current = requestId;
    const controller = new AbortController();
    fileIndexAbortRef.current = controller;
    const fetchCwd = cwd;
    const fetchKey = `${fetchCwd}\0${hideGitIgnored ? "hide-ignored" : "show-ignored"}`;
    if (fileIndexFetchingRef.current === fetchKey) return;
    fileIndexFetchingRef.current = fetchKey;
    setFileIndexLoading(true);
    fetch(apiPath(fileIndexRequestPath(fetchCwd, undefined, hideGitIgnored)), { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`file index failed: ${res.status}`);
        return res.json() as Promise<{ files?: string[]; truncated?: boolean }>;
      })
      .then((data) => {
        if (controller.signal.aborted || fileIndexRequestIdRef.current !== requestId) return;
        setFileIndex({ cwd: fetchCwd, hideGitIgnored, entries: buildEntriesFromFiles(data.files ?? []), truncated: !!data.truncated });
        fileIndexMetaRef.current = { cwd: fetchCwd, hideGitIgnored, fetchedAt: Date.now() };
      })
      .catch(() => {
        if (controller.signal.aborted || fileIndexRequestIdRef.current !== requestId) return;
        // Leave any previous index in place; next open retries.
        fileIndexMetaRef.current = null;
      })
      .finally(() => {
        if (fileIndexRequestIdRef.current !== requestId) return;
        fileIndexFetchingRef.current = null;
        fileIndexAbortRef.current = null;
        setFileIndexLoading(false);
      });
    return () => {
      if (fileIndexRequestIdRef.current !== requestId) return;
      fileIndexRequestIdRef.current += 1;
      controller.abort();
      if (fileIndexAbortRef.current === controller) fileIndexAbortRef.current = null;
      fileIndexFetchingRef.current = null;
      setFileIndexLoading(false);
    };
  }, [atTokenActive, cwd, fileVisibilityReady, hideGitIgnored, apiPath]);

  const applyAtCompletion = useCallback((entry: FileIndexEntry) => {
    if (!atQuery) return;
    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? value.length;
    const before = value.slice(0, atQuery.start);
    let after = value.slice(cursor);
    // Completing inside a quoted token (@"my dir/… with the caret before the
    // closing quote): the replacement carries its own closing quote, so drop
    // the old one right after the caret (mirrors the TUI's applyCompletion).
    if (atQuery.quoted && after.startsWith('"')) {
      after = after.slice(1);
    }
    const insert = buildAtInsertText(entry.path, entry.isDir, atQuery.quoted);
    const newValue = before + insert.text + after;
    const newPos = before.length + insert.cursorOffset;
    setValue(newValue);
    // setValue alone does not fire onChange — re-derive the token here. Files
    // end with a space (token closes, menu hides); directories end with "/"
    // before the caret (token stays open for drill-down into the directory).
    setAtQuery(extractAtQuery(newValue.slice(0, newPos)));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(newPos, newPos);
      resizeChatInput(el);
    });
  }, [atQuery, value]);

  useEffect(() => {
    if (atActiveIndex >= atMatches.length) {
      setAtActiveIndex(Math.max(0, atMatches.length - 1));
    }
  }, [atMatches.length, atActiveIndex]);

  useEffect(() => {
    atItemRefs.current.length = atMatches.length;
  }, [atMatches.length]);

  useEffect(() => {
    if (!atMenuOpen) return;
    atItemRefs.current[atActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [atActiveIndex, atMenuOpen]);

  useEffect(() => {
    if (historyActiveIndex >= inputHistory.length) {
      setHistoryActiveIndex(Math.max(0, inputHistory.length - 1));
    }
  }, [inputHistory.length, historyActiveIndex]);

  useEffect(() => {
    historyItemRefs.current.length = inputHistory.length;
  }, [inputHistory.length]);

  useEffect(() => {
    if (!historyMenuOpen) return;
    historyItemRefs.current[historyActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [historyActiveIndex, historyMenuOpen]);

  const applyHistoryInput = useCallback((text: string) => {
    setValue(text);
    setHistoryMenuOpen(false);
    setHistoryActiveIndex(0);
    setAtQuery(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(text.length, text.length);
      resizeChatInput(ta);
    });
  }, []);

  const applySlashCommand = useCallback((command: SlashCommandPaletteItem) => {
    const trigger: SlashCommandTrigger | null = slashMenuOpenedByButton
      ? { placement: "start", query: "", draft: value }
      : slashTrigger;
    const nextValue = buildSlashCommandSelectionValue(command, trigger);
    setValue(nextValue);
    setSlashCaret(nextValue.length);
    closeSlashCommandMenu();
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(nextValue.length, nextValue.length);
      resizeChatInput(ta);
    });
  }, [closeSlashCommandMenu, slashTrigger, slashMenuOpenedByButton, value]);

  const updateSlashSearch = useCallback((nextSearch: string) => {
    if (slashMenuOpenedByButton) {
      setSlashMenuSearch(nextSearch);
      setSlashActiveIndex(0);
      return;
    }
    const trigger = slashTrigger;
    if (!trigger) return;
    const query = nextSearch.replace(/\s+/g, "").toLowerCase();
    const nextValue = trigger.placement === "end"
      ? `${trigger.draft}/${query}`
      : `/${query}${trigger.draft ? ` ${trigger.draft.trimStart()}` : ""}`;
    valueRef.current = nextValue;
    setValue(nextValue);
    setSlashCaret(trigger.placement === "end" ? nextValue.length : query.length + 1);
    setSlashActiveIndex(0);
  }, [slashMenuOpenedByButton, slashTrigger]);

  const sendQueued = useCallback((mode: "steer" | "followup") => {
    const msg = value.trim();
    if (!hasStreamingMessagePayload(msg, attachedImages.length, quotes.length)) return;
    onAudioUnlock?.();
    const images = attachedImages.length ? attachedImages : undefined;
    const clearQueuedInput = () => {
      if (
        valueRef.current.trim() === msg
        && attachedImagesRef.current === attachedImages
        && quotesRef.current === quotes
      ) clearInput();
    };
    const queue = () => {
      const streamingBehavior = mode === "steer" ? "steer" : "followUp";
      let effectiveMsg = msg;
      if (!msg.startsWith("/") && quotes.length > 0) {
        const formattedQuotes = formatQuoteItemsToMarkdown(quotes, t);
        effectiveMsg = msg ? `${formattedQuotes}\n\n${msg}` : formattedQuotes;
        setQuotes([]);
      }
      if (msg.startsWith("/") && onPromptWithStreamingBehavior) {
        clearQueuedInput();
        onPromptWithStreamingBehavior(effectiveMsg, streamingBehavior, images);
        return;
      }
      clearQueuedInput();
      if (mode === "steer" && onSteer) {
        onSteer(effectiveMsg, images);
      } else if (mode === "followup" && onFollowUp) {
        onFollowUp(effectiveMsg, images);
      }
    };
    if (!attachedImages.length && onBuiltinCommand && canRunBuiltinSlashCommandWhileStreaming(msg)) {
      void runBuiltinCommand(msg);
      return;
    }
    if (!attachedImages.length && onBuiltinCommand && isBareMcpCommand(msg)) {
      // Settings › MCP opens when pi's built-in MCP extension owns /mcp; another
      // extension's /mcp is queued as before. The composer is disabled meanwhile.
      void runBuiltinCommand(msg).then((handled) => {
        if (!handled) queue();
      }, () => queue());
      return;
    }
    queue();
  }, [value, attachedImages, quotes, onBuiltinCommand, onPromptWithStreamingBehavior, onSteer, onFollowUp, clearInput, onAudioUnlock, runBuiltinCommand, t]);

  const getNextSlashIndex = useCallback((direction: "up" | "down" | "left" | "right") => {
    const lastIndex = displayedSlashCommands.length - 1;
    if (lastIndex < 0) return 0;

    if (direction === "left") return Math.max(0, slashActiveIndex - 1);
    if (direction === "right") return Math.min(lastIndex, slashActiveIndex + 1);

    const currentNode = slashItemRefs.current[slashActiveIndex];
    if (!currentNode) {
      return direction === "down"
        ? Math.min(lastIndex, slashActiveIndex + 1)
        : Math.max(0, slashActiveIndex - 1);
    }

    const currentRect = currentNode.getBoundingClientRect();
    const currentX = currentRect.left + currentRect.width / 2;
    const currentY = currentRect.top + currentRect.height / 2;
    let bestIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let index = 0; index <= lastIndex; index += 1) {
      if (index === slashActiveIndex) continue;
      const node = slashItemRefs.current[index];
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      const candidateY = rect.top + rect.height / 2;
      const verticalDelta = candidateY - currentY;
      if (direction === "down" ? verticalDelta <= 4 : verticalDelta >= -4) continue;

      const candidateX = rect.left + rect.width / 2;
      const score = Math.abs(verticalDelta) * 1000 + Math.abs(candidateX - currentX);
      if (score < bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }

    if (bestIndex >= 0) return bestIndex;
    return direction === "down"
      ? Math.min(lastIndex, slashActiveIndex + 1)
      : Math.max(0, slashActiveIndex - 1);
  }, [displayedSlashCommands.length, slashActiveIndex]);

  const handleSlashSearchKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setSlashMenuOpen(false);
      setSlashMenuOpenedByButton(false);
      textareaRef.current?.focus();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSlashActiveIndex(getNextSlashIndex("down"));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSlashActiveIndex(getNextSlashIndex("up"));
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && displayedSlashCommands[slashActiveIndex]) {
      event.preventDefault();
      applySlashCommand(displayedSlashCommands[slashActiveIndex]);
    }
  }, [applySlashCommand, displayedSlashCommands, getNextSlashIndex, slashActiveIndex]);

  const acceptEditorSuggestion = useCallback(() => {
    const suggestion = editorSuggestion?.trim();
    if (!suggestion) return false;
    valueRef.current = suggestion;
    setValue(suggestion);
    setSlashCaret(suggestion.length);
    setSlashMenuOpen(false);
    setAtMenuOpen(false);
    setAtQuery(null);
    setHistoryMenuOpen(false);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(suggestion.length, suggestion.length);
      resizeChatInput(textarea, true);
    });
    return true;
  }, [editorSuggestion]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent;
      const enterKey = e.key === "Enter" && !e.shiftKey;
      const sendShortcut = isMobile || enterSendMode === "ctrlEnter"
        ? enterKey && (e.ctrlKey || e.metaKey)
        : enterKey;
      // Popup menus and the IME guard take plain Enter in either send mode on a
      // desktop keyboard. Mobile keyboards insert a line break on Enter, so they
      // keep using the send shortcut there.
      const acceptShortcut = isMobile ? sendShortcut : enterKey;
      const recentlyComposed = Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS;
      const isComposing =
        isComposingRef.current ||
        nativeEvent.isComposing ||
        nativeEvent.keyCode === 229;

      if (!isComposing && showEditorSuggestion && (e.key === "Tab" || e.key === "ArrowRight" || e.key === " ")
        && acceptEditorSuggestion()) {
        e.preventDefault();
        return;
      }

      // Use the physical Slash key so a CJK IME cannot turn the command
      // trigger into a locale-specific punctuation character. Do not do this
      // during composition: candidate navigation must remain native.
      const textarea = textareaRef.current;
      const currentValue = textarea?.value ?? valueRef.current;
      const selectionStart = textarea?.selectionStart ?? currentValue.length;
      const selectionEnd = textarea?.selectionEnd ?? currentValue.length;
      if (
        !isComposing
        && isAsciiSlashKey(e)
        && isSlashCommandInsertionPoint(currentValue, selectionStart, selectionEnd)
      ) {
        e.preventDefault();
        insertAsciiSlash();
        return;
      }

      if (acceptShortcut && (isComposing || recentlyComposed)) {
        if (recentlyComposed) e.preventDefault();
        return;
      }

      if (historyMenuOpen && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.min(Math.max(0, inputHistory.length - 1), i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setHistoryMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || acceptShortcut) && inputHistory[historyActiveIndex]) {
          e.preventDefault();
          applyHistoryInput(inputHistory[historyActiveIndex]);
          return;
        }
      }

      if (slashMenuOpen && slashMenuQuery !== null) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("down"));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("up"));
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("right"));
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("left"));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          closeSlashCommandMenu();
          return;
        }
        if ((e.key === "Tab" || acceptShortcut) && displayedSlashCommands[slashActiveIndex]) {
          e.preventDefault();
          const selectedCommand = displayedSlashCommands[slashActiveIndex];
          if (sendShortcut && !slashMenuOpenedByButton && submitsSlashCommandOnEnter(value, selectedCommand, isStreaming)) {
            closeSlashCommandMenu();
            void handleSend();
          } else {
            applySlashCommand(selectedCommand);
          }
          return;
        }
      }

      // @ file menu — skip while composing so IME candidate navigation
      // (arrows/Enter/Tab) is never intercepted.
      if (atMenuOpen && atQuery !== null && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setAtActiveIndex((i) => Math.min(Math.max(0, atMatches.length - 1), i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAtActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setAtMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || acceptShortcut) && atMatches[atActiveIndex]) {
          e.preventDefault();
          applyAtCompletion(atMatches[atActiveIndex]);
          return;
        }
      }

      if (e.key === "Enter" && e.shiftKey && !isComposing) {
        e.preventDefault();
        insertNewline();
        return;
      }

      if (e.key === "ArrowUp" && !isComposing && !isStreaming && inputHistory.length > 0 && value.trim().length === 0) {
        e.preventDefault();
        setSlashMenuOpen(false);
        setAtMenuOpen(false);
        setHistoryActiveIndex(inputHistory.length - 1);
        setHistoryMenuOpen(true);
        return;
      }

      // Esc stops the agent when no slash/@/history menu or IME composition is active.
      if (e.key === "Escape" && !isComposing && canStop && !stopping && onAbort) {
        e.preventDefault();
        onAbort();
        return;
      }

      if (sendShortcut) {
        e.preventDefault();
        if (isStreaming && (onSteer || onFollowUp)) {
          // Default Enter sends as steer if available, else followup
          sendQueued(onSteer ? "steer" : "followup");
        } else {
          handleSend();
        }
      }
    },
    [isMobile, enterSendMode, isStreaming, canStop, stopping, onSteer, onFollowUp, onAbort, closeSlashCommandMenu, slashMenuOpen, slashMenuQuery, slashMenuOpenedByButton, displayedSlashCommands, slashActiveIndex, applySlashCommand, sendQueued, handleSend, getNextSlashIndex, atMenuOpen, atQuery, atMatches, atActiveIndex, applyAtCompletion, historyMenuOpen, inputHistory, historyActiveIndex, applyHistoryInput, value, insertAsciiSlash, insertNewline, acceptEditorSuggestion, showEditorSuggestion]
  );

  const handleInput = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    resizeChatInput(ta, ta.selectionStart === ta.value.length);
  }, []);

  const handleBeforeInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
    const nativeEvent = e.nativeEvent as InputEvent;
    if (
      nativeEvent.isComposing
      || nativeEvent.inputType !== "insertText"
      || (nativeEvent.data !== "／" && nativeEvent.data !== "、")
    ) return;

    const ta = e.currentTarget;
    if (!isSlashCommandInsertionPoint(ta.value, ta.selectionStart, ta.selectionEnd)) return;

    e.preventDefault();
    insertAsciiSlash();
  }, [insertAsciiSlash]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (!imageItems.length) return;
    e.preventDefault();
    const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
    processImageFiles(files);
  }, [processImageFiles]);

  useEffect(() => {
    if (slashQuery === null && !slashMenuOpenedByButton) {
      setSlashMenuOpen(false);
      setSlashActiveIndex(0);
      slashCommandsRequestedRef.current = false;
      return;
    }
    setSlashMenuOpen(true);
    setSlashActiveIndex(0);
    void loadCustomPrompts();
    void loadSlashFavorites();
    if (!slashCommandsRequestedRef.current && onLoadSlashCommands) {
      slashCommandsRequestedRef.current = true;
      Promise.resolve(onLoadSlashCommands()).catch(() => {
        slashCommandsRequestedRef.current = false;
      });
    }
  }, [slashQuery, slashMenuOpenedByButton, onLoadSlashCommands]);

  useEffect(() => {
    if (!slashMenuOpen) setActiveSlashTab("customPrompt");
  }, [slashMenuOpen]);

  useEffect(() => {
    if (!slashMenuOpen || !slashMenuOpenedByButton) return;
    requestAnimationFrame(() => slashSearchRef.current?.focus());
  }, [slashMenuOpen, slashMenuOpenedByButton]);

  useEffect(() => {
    void loadCustomPrompts();
    const handlePromptsChanged = () => { void loadCustomPrompts(); };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === CUSTOM_PROMPTS_CHANGED_EVENT) {
        void loadCustomPrompts();
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === CUSTOM_PROMPTS_STORAGE_KEY && event.newValue) {
        try {
          setCustomPrompts(getCustomPromptsFromResponse({ prompts: JSON.parse(event.newValue) }));
        } catch {
          // Parse failure
        }
      }
    };
    window.addEventListener(CUSTOM_PROMPTS_CHANGED_EVENT, handlePromptsChanged);
    window.addEventListener("message", onMessage);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CUSTOM_PROMPTS_CHANGED_EVENT, handlePromptsChanged);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("storage", onStorage);
    };
  }, [loadCustomPrompts]);

  // Lazy-load skill dormancy (disable-model-invocation) each time the slash
  // palette opens, so toggles made in the skills panel are reflected on the
  // next open. Failures degrade silently to the unannotated palette.
  useEffect(() => {
    if (!slashMenuOpen || !cwd) return;
    const requestCwd = cwd;
    let cancelled = false;
    setSkillDormancyState({ cwd: requestCwd, values: {} });
    fetch(apiPath(`skills?cwd=${encodeURIComponent(requestCwd)}`))
      .then((res) => {
        if (!res.ok) throw new Error(`skills fetch failed: ${res.status}`);
        return res.json() as Promise<Partial<SkillsResponse>>;
      })
      .then((data) => {
        if (cancelled) return;
        const dormancy: Record<string, boolean> = {};
        for (const skill of data.skills ?? []) dormancy[skill.name] = skill.disableModelInvocation;
        setSkillDormancyState({ cwd: requestCwd, values: dormancy });
      })
      .catch(() => {
        if (!cancelled) setSkillDormancyState({ cwd: requestCwd, values: {} });
      });
    return () => {
      cancelled = true;
    };
  }, [slashMenuOpen, cwd, apiPath]);

  useEffect(() => {
    if (slashActiveIndex >= displayedSlashCommands.length) {
      setSlashActiveIndex(Math.max(0, displayedSlashCommands.length - 1));
    }
  }, [displayedSlashCommands.length, slashActiveIndex]);

  useEffect(() => {
    slashItemRefs.current.length = displayedSlashCommands.length;
  }, [displayedSlashCommands.length]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    slashItemRefs.current[slashActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [slashActiveIndex, slashMenuOpen]);

  useLayoutEffect(() => {
    if (!slashMenuOpen || slashMenuQuery === null) {
      setSlashMenuMaxHeight(null);
      return;
    }

    const menu = slashMenuRef.current;
    if (!menu) return;

    let frameId: number | null = null;
    const update = () => {
      frameId = null;
      const nextHeight = getUpwardMenuMaxHeight(
        menu.getBoundingClientRect().bottom,
        getVisibleTopBoundary(menu),
      );
      setSlashMenuMaxHeight((current) => current === nextHeight ? current : nextHeight);
    };
    const scheduleUpdate = () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(update);
    };

    update();
    const anchorObserver = typeof ResizeObserver === "undefined" || !menu.parentElement
      ? null
      : new ResizeObserver(scheduleUpdate);
    if (menu.parentElement) anchorObserver?.observe(menu.parentElement);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", scheduleUpdate);
    viewport?.addEventListener("scroll", scheduleUpdate);
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);

    return () => {
      anchorObserver?.disconnect();
      viewport?.removeEventListener("resize", scheduleUpdate);
      viewport?.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [slashMenuOpen, slashMenuQuery]);

  // Build model options: prefer modelList (has provider info), fallback to modelNames
  const modelOptions: ModelOption[] = (() => {
    if (modelList && modelList.length > 0) {
      return modelList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name })).sort(compareModelOptions);
    }
    return Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
      provider: model?.provider ?? "unknown",
      modelId,
      name,
    })).sort(compareModelOptions);
  })();
  const visibleModelOptions = filterModelOptionsByProvider(modelOptions, hiddenModelProviders);
  const filteredModelOptions = filterModelOptions(visibleModelOptions, modelFilter);
  const showModelFilter = visibleModelOptions.length > MODEL_FILTER_THRESHOLD;

  // Group options by provider, preserving insertion order
  const modelsByProvider: { provider: string; options: ModelOption[] }[] = [];
  for (const opt of filteredModelOptions) {
    const group = modelsByProvider.find((g) => g.provider === opt.provider);
    if (group) group.options.push(opt);
    else modelsByProvider.push({ provider: opt.provider, options: [opt] });
  }

  const displayModelName = model
    ? (modelOptions.find((o) => o.modelId === model.modelId && o.provider === model.provider)?.name ?? model.modelId)
    : null;
  const currentName = displayModelName;

  const compactSavedTokens = compactResult
    ? Math.max(0, compactResult.tokensBefore - compactResult.estimatedTokensAfter)
    : 0;
  const compactResultText = compactResult
    ? `${compactResult.reason && compactResult.reason !== "manual" ? `${compactResult.reason[0].toUpperCase()}${compactResult.reason.slice(1)} ` : t("chat.compacted")} ${formatTokenCount(compactResult.tokensBefore)} -> ${formatTokenCount(compactResult.estimatedTokensAfter)} tokens (${t("chat.tokensSaved", { saved: formatTokenCount(compactSavedTokens) })})`
    : null;
  const resolvedThinkingLevel = thinkingLevel && thinkingLevel !== "auto" ? thinkingLevel : undefined;
  const thinkingDisplayLabel = (() => {
    const lvl = thinkingLevel ?? "auto";
    if (lvl === "auto" || !thinkingLevelMap) return lvl;
    return thinkingLevelMap[lvl] ?? lvl;
  })();
  const fastModeDisplayLabel = fastMode?.enabled ? t("chat.fastMode") : t("chat.standardMode");
  const toolPresetKey = Object.entries(TOOL_PRESET_MAP).find(([, v]) => v === (toolPreset ?? "default"))?.[0] ?? "default";
  const toolPresetLabel = toolPresetKey === "configured" ? t("chat.configuredTools") : toolPresetKey;

  // Close dropdowns on outside click
  useEffect(() => {
    if (!isStreaming) return;
    setFastModeDropdownOpen(false);
    setThinkingDropdownOpen(false);
  }, [isStreaming]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        modelDropdownPanelRef.current && !modelDropdownPanelRef.current.contains(e.target as Node)
      ) {
        setModelDropdownOpen(false);
        setModelFilter("");
      }
      if (toolDropdownRef.current && !toolDropdownRef.current.contains(e.target as Node)) {
        setToolDropdownOpen(false);
      }
      if (thinkingDropdownRef.current && !thinkingDropdownRef.current.contains(e.target as Node)) {
        setThinkingDropdownOpen(false);
      }
      if (fastModeDropdownRef.current && !fastModeDropdownRef.current.contains(e.target as Node)) {
        setFastModeDropdownOpen(false);
      }
      if (controlsMenuRef.current && !controlsMenuRef.current.contains(e.target as Node)) {
        setControlsMenuOpen(false);
      }
      if (slashMenuOpen && slashMenuRef.current && !slashMenuRef.current.contains(e.target as Node) && !slashToggleButtonRef.current?.contains(e.target as Node)
        && !slashDetailDialogRef.current?.contains(e.target as Node)) {
        closeSlashCommandMenu();
      }
      if (historyMenuRef.current && !historyMenuRef.current.contains(e.target as Node) && !textareaRef.current?.contains(e.target as Node)) {
        setHistoryMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [closeSlashCommandMenu, slashMenuOpen]);

  useEffect(() => {
    if (!isMobile) setControlsMenuOpen(false);
  }, [isMobile]);



  return (
    <fieldset
      disabled={builtinCommandPending}
      aria-busy={builtinCommandPending}
      className="chat-input-shell"
      style={{
        boxSizing: "border-box",
        width: "100%",
        minWidth: 0,
        margin: 0,
        border: 0,
        flexShrink: 0,
        background: "transparent",
        padding: "0 16px 8px",
        paddingRight: isMobile ? 16 : 52, // desktop: 16px base + 36px for ChatMinimap alignment
      }}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        disabled={isStreaming && !canAttachImages}
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          processImageFiles(files);
          e.target.value = "";
        }}
      />
      <div style={{ maxWidth: constrainWidth ? "var(--chat-content-max-width, 90%)" : "100%", width: "100%", minWidth: 0, margin: "0 auto" }}>
        {slashDetailCommand && !embeddedInParent && (
          <SlashCommandDetailsDialog
            command={slashDetailCommand}
            content={slashDetailContent}
            loading={slashDetailLoading}
            error={slashDetailError}
            onClose={() => setSlashDetailCommand(null)}
            dialogRef={slashDetailDialogRef}
            cwd={cwd ?? undefined}
            sessionId={sessionId ?? undefined}
            remotePeer={remotePeer}
            onOpenFile={onOpenFile}
            onCustomPromptSaved={(prompt) => {
              setSlashDetailCommand((current) => (
                current?.source === "customPrompt" && current.promptId === prompt.id
                  ? {
                    ...current,
                    name: prompt.title,
                    description: prompt.description || prompt.content.replace(/\s+/g, " ").trim().slice(0, 160),
                    promptDescription: prompt.description,
                    content: prompt.content,
                  }
                  : current
              ));
              setSlashDetailContent(prompt.content);
            }}
          />
        )}
        {draftAnalysisDialogOpen && (
          <DraftQuestionAnalysisDialog
            mode={draftAnalysisMode}
            onModeChange={setDraftAnalysisMode}
            onCancel={() => setDraftAnalysisDialogOpen(false)}
            onConfirm={() => runDraftAnalysis(draftAnalysisMode)}
          />
        )}
        <ModelErrorBanner error={modelError} />
        <ModelScopeWarningBanner warnings={modelScopeWarnings} />
        {/* Queued steering / follow-up messages (delivered by pi on upcoming turns) */}
        {queuedMessages?.recallState === "server_copy" && <p role="status" style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("chat.queueRecoveryNotice_memoryOnly")}</p>}
        {queuedMessages?.recovery && <QueueRecoveryPanel key={draftKey ?? "new"} recovery={queuedMessages.recovery} />}
        {((queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0)) > 0 && (
          <div style={{
            marginBottom: 8,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-panel)",
            padding: "5px 0",
          }}>
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "2px 8px 4px 10px",
            }}>
              <span style={{
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                color: "var(--text-dim)",
                textTransform: "uppercase",
                letterSpacing: 0.4,
              }}>
                {queuedMessages?.recallPending ? t("chat.recallPending") : t("chat.queued", { count: (queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0) })}
              </span>
              {onRecallQueue && (
                <button
                  onClick={onRecallQueue}
                  disabled={queuedMessages?.recallState === "recalling" || queuedMessages?.recallState === "confirming" || Boolean(queuedMessages?.recallBlocked)}
                   title={t("chat.recallTitle")}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 12px",
                    fontSize: 12,
                    color: "var(--text)",
                    background: "transparent",
                    border: "1px solid var(--border)",
                    borderRadius: 7,
                    cursor: "pointer",
                    transition: "background 0.12s, border-color 0.12s",
                    whiteSpace: "nowrap",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 45%, var(--border))";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.borderColor = "var(--border)";
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 14 4 9 9 4" />
                    <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
                  </svg>
                   {t(queuedMessages?.recallState === "recalling" ? "chat.queueRecalling" : queuedMessages?.recallState === "confirming" ? "chat.queueConfirming" : queuedMessages?.recallState === "confirm_retry" ? "chat.queueConfirmRetry" : "chat.recall")}
                </button>
              )}
            </div>
            {queuedMessages?.recallBlocked && <p style={{ fontSize: 12, padding: "0 10px", color: "var(--text-dim)" }}>{t(queuedMessages.recallBlocked === "non_user" ? "chat.queueMixedRoles" : "chat.queueTooManyImages")}</p>}
            <div
              role="region"
              aria-label={t("chat.queued", { count: (queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0) })}
              tabIndex={0}
              style={{ maxHeight: "min(180px, calc(var(--app-viewport-height, 100dvh) * 0.25))", overflowY: "auto", overscrollBehavior: "contain" }}
            >
              {queuedMessages?.steering.map((message, i) => (
                <QueuedMessageRow key={message.itemId ?? `steer-${i}`} kind="steer" text={message.text} hasImages={message.hasImages} />
              ))}
              {queuedMessages?.followUp.map((message, i) => (
                <QueuedMessageRow key={message.itemId ?? `followup-${i}`} kind="follow-up" text={message.text} hasImages={message.hasImages} />
              ))}
            </div>
          </div>
        )}
        {/* Retry banner */}
        {retryInfo && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "rgba(234,179,8,0.08)", border: "1px solid rgba(234,179,8,0.25)",
            borderRadius: 6, fontSize: 12, color: "rgba(180,130,0,0.9)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
             {t("chat.retrying", { attempt: retryInfo.attempt, max: retryInfo.maxAttempts })}{retryInfo.errorMessage && <span style={{ opacity: 0.7, marginLeft: 4 }}>— {retryInfo.errorMessage}</span>}
          </div>
        )}
        {compactResultText && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.24)",
            borderRadius: 6, fontSize: 12, color: "rgba(5,150,105,0.95)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {compactResultText}
          </div>
        )}
        {compactError && (
          <div
            role="alert"
            style={{
              marginBottom: 8,
              padding: "7px 10px",
              background: "rgba(239,68,68,0.07)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 6,
              color: "#ef4444",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {compactError}
          </div>
        )}
        {/* Attached Items Row: 图片一组聚合，注释一组聚合，并列横向排列，各自支持内部拖拽排序 */}
        {(attachedImages.length > 0 || quotes.length > 0) && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 6,
              flexWrap: "wrap",
            }}
          >
            {/* Image previews (图片的归图片，内部可拖动调先后顺序) */}
            {attachedImages.length > 0 && (
              <div
                data-image-group="true"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  flexWrap: "wrap",
                }}
              >
                {attachedImages.map((img, i) => (
                  <div
                    key={img.previewUrl}
                    draggable={true}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("type", "attached-image");
                      e.dataTransfer.effectAllowed = "move";
                      setDragImageIdx(i);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (dragImageIdx !== null && dragImageIdx !== i) {
                        setDragOverImageIdx(i);
                      }
                    }}
                    onDragLeave={() => {
                      setDragOverImageIdx(null);
                    }}
                    onDragEnd={() => {
                      setDragImageIdx(null);
                      setDragOverImageIdx(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragImageIdx !== null && dragImageIdx !== i) {
                        reorderImages(dragImageIdx, i);
                      }
                      setDragImageIdx(null);
                      setDragOverImageIdx(null);
                    }}
                    style={{
                      position: "relative",
                      flexShrink: 0,
                      cursor: "grab",
                      opacity: dragImageIdx === i ? 0.4 : 1,
                      outline: dragOverImageIdx === i ? "2px dashed var(--accent)" : "none",
                      borderRadius: 6,
                      transition: "opacity 0.15s",
                    }}
                    title={t("chat.dragImageOrder")}
                  >
                    <ImagePreview
                      src={img.previewUrl}
                      images={attachedImages.map((image) => image.previewUrl)}
                      initialIndex={i}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={img.previewUrl}
                        alt=""
                        style={{
                          width: 56,
                          height: 56,
                          objectFit: "cover",
                          borderRadius: 6,
                          border: "1px solid var(--border)",
                          display: "block",
                          pointerEvents: "none",
                        }}
                      />
                    </ImagePreview>
                    <button
                      type="button"
                      onClick={() => removeImage(i)}
                      aria-label="Remove attached image"
                      title="Remove image"
                      style={{
                        position: "absolute",
                        top: -4,
                        right: -4,
                        width: 16,
                        height: 16,
                        borderRadius: "50%",
                        background: "var(--bg-panel)",
                        border: "1px solid var(--border)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        cursor: "pointer",
                        padding: 0,
                        color: "var(--text-muted)",
                      }}
                    >
                      <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* 图片与注释组之间的视觉分隔线 */}
            {attachedImages.length > 0 && quotes.length > 0 && (
              <div
                style={{
                  width: 1,
                  height: 24,
                  background: "var(--border)",
                  margin: "0 2px",
                  flexShrink: 0,
                }}
              />
            )}

            {/* Quote Context Cards (注释的归注释，内部可拖动调先后顺序，横向单条独立排列) */}
            <QuoteCardGroup
              quotes={quotes}
              onRemoveQuote={handleRemoveQuote}
              onUpdateQuote={handleUpdateQuote}
              onEditQuote={onEditQuote}
              onJumpToQuote={onJumpToQuote}
              onReorderQuotes={handleReorderQuotes}
              compact={isMobile}
            />
          </div>
        )}

        {/* Prompt diagnosis and rewrite stay in the composer so the draft can be improved before sending. */}
        {(Boolean(draftQuestion) || draftAnalysis.status !== "idle" || draftRewrite.status !== "idle" || draftSte100Rewrite.status !== "idle") && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={openDraftAnalysisDialog}
                disabled={!canUseDraftPromptTools || draftAnalysis.status === "loading"}
                title={canUseDraftPromptTools ? t("chat.promptToolsAnalyze") : t("chat.promptToolsUnavailable")}
                style={{ padding: "4px 9px", border: "1px solid var(--border)", borderRadius: 6, background: draftAnalysis.status === "loading" ? "var(--bg-selected)" : "var(--bg-panel)", color: canUseDraftPromptTools ? "var(--text-muted)" : "var(--text-dim)", cursor: !canUseDraftPromptTools || draftAnalysis.status === "loading" ? "not-allowed" : "pointer", fontSize: 11, opacity: canUseDraftPromptTools ? 1 : 0.55 }}
              >
                {draftAnalysis.status === "loading" ? t("chat.promptToolsAnalyzing") : t("chat.promptToolsAnalyze")}
              </button>
              <button
                type="button"
                onClick={runDraftSte100Rewrite}
                disabled={!canUseDraftPromptTools || draftSte100Rewrite.status === "loading"}
                title={canUseDraftPromptTools ? t("chat.promptToolsSte100") : t("chat.promptToolsUnavailable")}
                style={{ padding: "4px 9px", border: "1px solid var(--border)", borderRadius: 6, background: draftSte100Rewrite.status === "loading" ? "var(--bg-selected)" : "var(--bg-panel)", color: canUseDraftPromptTools ? "var(--text-muted)" : "var(--text-dim)", cursor: !canUseDraftPromptTools || draftSte100Rewrite.status === "loading" ? "not-allowed" : "pointer", fontSize: 11, opacity: canUseDraftPromptTools ? 1 : 0.55 }}
              >
                {draftSte100Rewrite.status === "loading" ? t("chat.promptToolsSte100Rewriting") : t("chat.promptToolsSte100")}
              </button>
              {draftAnalysis.status === "ready" && (
                <button
                  type="button"
                  onClick={runDraftRewrite}
                  disabled={!canUseDraftPromptTools || draftRewrite.status === "loading"}
                  title={canUseDraftPromptTools ? t("chat.promptToolsRewrite") : t("chat.promptToolsUnavailable")}
                  style={{ padding: "4px 9px", border: "1px solid var(--accent)", borderRadius: 6, background: draftRewrite.status === "loading" ? "var(--bg-selected)" : "transparent", color: canUseDraftPromptTools ? "var(--accent)" : "var(--text-dim)", cursor: !canUseDraftPromptTools || draftRewrite.status === "loading" ? "not-allowed" : "pointer", fontSize: 11, opacity: canUseDraftPromptTools ? 1 : 0.55 }}
                >
                  {draftRewrite.status === "loading" ? t("chat.promptToolsRewriting") : t("chat.promptToolsRewrite")}
                </button>
              )}
            </div>
            {(draftAnalysis.status !== "idle" || draftRewrite.status !== "idle" || draftSte100Rewrite.status !== "idle") && (
              <div
                role={draftAnalysis.status === "error" || draftRewrite.status === "error" || draftSte100Rewrite.status === "error" ? "alert" : "region"}
                aria-live={draftAnalysis.status === "loading" || draftRewrite.status === "loading" || draftSte100Rewrite.status === "loading" ? "polite" : undefined}
                aria-busy={draftAnalysis.status === "loading" || draftRewrite.status === "loading" || draftSte100Rewrite.status === "loading"}
                style={{ marginBottom: 8, maxHeight: 260, overflowY: "auto", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", color: "var(--text)", fontSize: 12, lineHeight: 1.5 }}
              >
                <div style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 650 }}>{t("chat.promptToolsTitle")}</div>
                {draftAnalysis.status === "loading" && <div style={{ marginTop: 5, color: "var(--text-muted)" }}>{t("chat.promptToolsAnalyzing")}</div>}
                {draftAnalysis.status === "error" && <div style={{ marginTop: 5, color: "#ef4444", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{draftAnalysis.message}</div>}
                {draftAnalysis.status === "ready" && (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3, color: "var(--text-muted)", fontSize: 11 }}>
                      <span>{t("chat.promptToolsTermsTitle")}</span>
                      <button
                        type="button"
                        onClick={insertDraftTerms}
                        disabled={draftTermsInserted}
                        title={t("chat.promptToolsInsertTerms")}
                        style={{ marginLeft: "auto", padding: 0, border: 0, background: "none", color: "var(--accent)", cursor: draftTermsInserted ? "not-allowed" : "pointer", fontSize: 11, opacity: draftTermsInserted ? 0.55 : 1 }}
                      >
                        {t("chat.promptToolsInsertTerms")}
                      </button>
                    </div>
                    <MarkdownBody className="markdown-user-message" cwd={cwd ?? undefined} sessionId={sessionId ?? undefined} remotePeer={remotePeer}>{draftAnalysis.result.text}</MarkdownBody>
                  </div>
                )}
                {draftRewrite.status !== "idle" && (
                  <div style={{ marginTop: 8, paddingTop: 7, borderTop: "1px solid var(--border)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted)", fontSize: 11, fontWeight: 650 }}>
                      <span>{t("chat.promptToolsRewriteTitle")}</span>
                      {draftRewrite.status === "ready" && (
                        <button type="button" onClick={applyDraftRewrite} style={{ marginLeft: "auto", padding: 0, border: 0, background: "none", color: "var(--accent)", cursor: "pointer", fontSize: 11 }}>
                          {t("chat.promptToolsApply")}
                        </button>
                      )}
                    </div>
                    {draftRewrite.status === "loading" && <div style={{ marginTop: 5, color: "var(--text-muted)" }}>{t("chat.promptToolsRewriting")}</div>}
                    {draftRewrite.status === "error" && <div style={{ marginTop: 5, color: "#ef4444", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{draftRewrite.message}</div>}
                    {draftRewrite.status === "ready" && <div style={{ marginTop: 5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{draftRewrite.result.text}</div>}
                  </div>
                )}
                {draftSte100Rewrite.status !== "idle" && (
                  <div style={{ marginTop: 8, paddingTop: 7, borderTop: "1px solid var(--border)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted)", fontSize: 11, fontWeight: 650 }}>
                      <span>{t("chat.promptToolsSte100Title")}</span>
                      {draftSte100Rewrite.status === "ready" && (
                        <button type="button" onClick={applyDraftSte100Rewrite} style={{ marginLeft: "auto", padding: 0, border: 0, background: "none", color: "var(--accent)", cursor: "pointer", fontSize: 11 }}>
                          {t("chat.promptToolsApply")}
                        </button>
                      )}
                    </div>
                    {draftSte100Rewrite.status === "loading" && <div style={{ marginTop: 5, color: "var(--text-muted)" }}>{t("chat.promptToolsSte100Rewriting")}</div>}
                    {draftSte100Rewrite.status === "error" && <div style={{ marginTop: 5, color: "#ef4444", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{draftSte100Rewrite.message}</div>}
                    {draftSte100Rewrite.status === "ready" && <div style={{ marginTop: 5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{draftSte100Rewrite.result.text}</div>}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Main input */}
        <div style={{ position: "relative", minWidth: 0 }}>
          {historyMenuOpen && inputHistory.length > 0 && (
            <div
              ref={historyMenuRef}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "calc(100% + 8px)",
                zIndex: 120,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
                overflow: "hidden",
                maxHeight: "min(44vh, 360px)",
              }}
            >
              <div
                title="Input history"
                style={{
                  height: 30,
                  padding: "0 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  color: "var(--text-dim)",
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 12a9 9 0 1 0 3-6.7" />
                  <path d="M3 4v5h5" />
                  <path d="M12 7v5l3 2" />
                </svg>
              </div>
              <div style={{ maxHeight: "calc(min(44vh, 360px) - 31px)", overflowY: "auto", padding: 4 }}>
                {inputHistory.map((item, index) => {
                  const active = index === historyActiveIndex;
                  return (
                    <button
                      key={`${index}:${item}`}
                      ref={(node) => {
                        historyItemRefs.current[index] = node;
                      }}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyHistoryInput(item);
                      }}
                      onMouseEnter={() => setHistoryActiveIndex(index)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        padding: "7px 8px",
                        border: "none",
                        borderRadius: 6,
                        background: active ? "var(--bg-selected)" : "none",
                        color: "var(--text)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 12.5,
                        lineHeight: 1.45,
                      }}
                    >
                      <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", paddingTop: 1 }}>
                        {index + 1}
                      </span>
                      <span style={{ minWidth: 0, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden", overflowWrap: "anywhere" }}>
                        {item}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {slashMenuOpen && slashMenuQuery !== null && (
            <div
              ref={slashMenuRef}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "calc(100% + 8px)",
                zIndex: 120,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
                overflow: "hidden",
                boxSizing: "border-box",
                display: "flex",
                flexDirection: "column",
                maxHeight: slashMenuMaxHeight === null
                  ? "min(72.8vh, 598px)"
                  : `min(72.8vh, 598px, ${slashMenuMaxHeight}px)`,
              }}
            >
              <div
                style={{
                  padding: "8px 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 7,
                  fontSize: 11,
                  color: "var(--text-dim)",
                  flexShrink: 0,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span>{slashCommandsLoading ? t("chat.loadingCommands") : t("chat.slashCommands", { label: slashCommandCountLabel })}</span>
                  <span style={{ fontFamily: "var(--font-mono)" }}>{t("chat.tabEnter")}</span>
                </div>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    minHeight: 30,
                    padding: "0 8px",
                    border: "1px solid var(--border)",
                    borderRadius: 7,
                    background: "var(--bg-panel)",
                    color: "var(--text-muted)",
                  }}
                >
                  <Search size={14} aria-hidden="true" />
                  <input
                    ref={slashSearchRef}
                    type="search"
                    value={slashMenuOpenedByButton ? slashMenuSearch : slashQuery ?? ""}
                    onChange={(event) => updateSlashSearch(event.currentTarget.value)}
                    onKeyDown={handleSlashSearchKeyDown}
                    placeholder={t("chat.searchSlashCommands")}
                    aria-label={t("chat.searchSlashCommands")}
                    autoComplete="off"
                    spellCheck={false}
                    style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: "transparent", color: "var(--text)", fontSize: 12 }}
                  />
                </label>
                {slashFavoriteError && (
                  <div role="alert" style={{ color: "var(--text-muted)", fontSize: 11 }}>
                    {slashFavoriteError}
                  </div>
                )}
              </div>
              <div
                role="group"
                aria-label={t("chat.slashCommandCategories")}
                style={{ display: "flex", gap: 6, overflowX: "auto", padding: "7px 10px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}
              >
                {SLASH_TABS.map((tab) => {
                  const active = activeSlashTab === tab;
                  return (
                    <button
                      key={tab}
                      type="button"
                      aria-pressed={active}
                      title={`${t(SLASH_TAB_LABEL_KEYS[tab])} · ${slashTabCounts[tab]}`}
                      aria-label={`${t(SLASH_TAB_LABEL_KEYS[tab])} · ${slashTabCounts[tab]}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setActiveSlashTab(tab);
                        setSlashActiveIndex(0);
                      }}
                      style={{
                        flex: "0 0 auto", display: "flex", alignItems: "center", gap: 6, minHeight: 28, padding: "4px 8px",
                        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`, borderRadius: 999,
                        background: active ? "var(--bg-selected)" : "var(--bg-panel)", color: active ? "var(--accent)" : "var(--text-muted)",
                        cursor: "pointer", fontSize: 11, fontWeight: active ? 650 : 500, whiteSpace: "nowrap",
                      }}
                    >
                      <span>{t(SLASH_TAB_LABEL_KEYS[tab])}</span>
                      <span aria-hidden="true" style={{ minWidth: 16, padding: "1px 4px", borderRadius: 999, background: "var(--bg-hover)", color: "var(--text-dim)", textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 10 }}>{slashTabCounts[tab]}</span>
                    </button>
                  );
                })}
              </div>
              {activeSlashTab === "favorites" && slashFavoriteCategories.length > 1 && (
                <div
                  role="group"
                  aria-label={t("favorites.subcategories")}
                  style={{
                    display: "flex",
                    gap: 6,
                    overflowX: "auto",
                    padding: "5px 10px",
                    borderBottom: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    flexShrink: 0,
                    scrollbarWidth: "none",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setActiveSlashSubcategory("all");
                      setSlashActiveIndex(0);
                    }}
                    style={{
                      flex: "0 0 auto",
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      minHeight: 22,
                      padding: "2px 8px",
                      borderRadius: 11,
                      border: `1px solid ${activeSlashSubcategory === "all" ? "var(--accent)" : "var(--border)"}`,
                      background: activeSlashSubcategory === "all" ? "var(--bg-selected)" : "var(--bg)",
                      color: activeSlashSubcategory === "all" ? "var(--accent)" : "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: 10,
                      fontWeight: activeSlashSubcategory === "all" ? 600 : 500,
                    }}
                  >
                    <span>{t("favorites.all")}</span>
                    <span style={{ fontSize: 9, opacity: 0.8 }}>({favoriteCommands.length})</span>
                  </button>
                  {slashFavoriteCategories.map((cat) => {
                    const isSubActive = activeSlashSubcategory === cat.id;
                    const catCount = cat.keys.filter((k) => filteredSlashCommands.some((c) => getSlashCommandFavoriteKey(c) === k)).length;
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => {
                          setActiveSlashSubcategory(cat.id);
                          setSlashActiveIndex(0);
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          const draggedKey = slashDraggedFavoriteKey || e.dataTransfer.getData("text/plain");
                          if (draggedKey) {
                            handleMoveFavoriteToSubcategory(draggedKey, cat.id);
                          }
                        }}
                        style={{
                          flex: "0 0 auto",
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          minHeight: 22,
                          padding: "2px 8px",
                          borderRadius: 11,
                          border: `1px solid ${isSubActive ? "var(--accent)" : "var(--border)"}`,
                          background: isSubActive ? "var(--bg-selected)" : "var(--bg)",
                          color: isSubActive ? "var(--accent)" : "var(--text-muted)",
                          cursor: "pointer",
                          fontSize: 10,
                          fontWeight: isSubActive ? 600 : 500,
                        }}
                      >
                        <span>{slashFavoriteCategoryLabel(cat, t("favorites.defaultCategory"))}</span>
                        <span style={{ fontSize: 9, opacity: 0.8 }}>({catCount})</span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 10 }}>
                {!slashCommandsLoading && displayedSlashCommands.length === 0 ? (
                  <div style={{ padding: "2px 2px 4px", fontSize: 12, color: "var(--text-dim)" }}>
                     {activeSlashTab === "favorites" ? t("chat.noFavoriteCommands") : t("chat.noCommands")}
                  </div>
                ) : (
                  groupedSlashCommands.map((group, groupIndex) => (
                    <section key={`${group.source}:${(group as { label?: string }).label ?? ""}:${groupIndex}`} style={{ marginBottom: 12 }}>
                      {(activeSlashTab === "all" || activeSlashTab === "favorites" || (isSearchingSlash && Boolean((group as { label?: string }).label))) && <div
                        style={{
                          position: "sticky",
                          top: -10,
                          zIndex: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          padding: "4px 0 6px",
                          background: "var(--bg)",
                          color: "var(--text-dim)",
                          fontSize: 10,
                          fontWeight: 600,
                          textTransform: "uppercase",
                        }}
                      >
                           <span>{(group as { label?: string }).label ?? t(group.source === "favorites" ? "chat.favorites" : SLASH_SOURCE_GROUP_LABEL_KEYS[group.source])}</span>
                        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500 }}>{group.items.length}</span>
                      </div>}
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                          alignItems: "stretch",
                          gap: 8,
                        }}
                      >
                        {group.items.map(({ command, index }) => {
                          const active = index === slashActiveIndex;
                          const dormant = isDormantSkillCommand(command, skillDormancy);
                          const favoriteKey = getSlashCommandFavoriteKey(command);
                          const favorite = slashFavoriteKeys.includes(favoriteKey);
                          const canDragFavorite = favorite;
                          const isCustomPromptItem = command.source === "customPrompt" && Boolean(command.promptId);
                          const canDragCustomPrompt = activeSlashTab === "customPrompt" && isCustomPromptItem && !slashMenuSearch;
                          const canDrag = canDragFavorite || canDragCustomPrompt;
                          const isDragging = (canDragFavorite && slashDraggedFavoriteKey === favoriteKey)
                            || (canDragCustomPrompt && slashDraggedPromptId === command.promptId);
                          const isDragOver = (canDragFavorite && slashDragOverFavoriteKey === favoriteKey)
                            || (canDragCustomPrompt && slashDragOverPromptId === command.promptId);
                          const actionsVisible = isMobile
                            || slashHoveredKey === favoriteKey
                            || (slashDetailCommand ? getSlashCommandFavoriteKey(slashDetailCommand) === favoriteKey : false);
                          return (
                            <div
                              key={favoriteKey}
                              draggable={canDrag}
                              title={canDrag ? t("chat.dragFavorite") : undefined}
                              aria-grabbed={isDragging}
                              onDragStart={(event) => {
                                if (!canDrag) return;
                                event.dataTransfer.effectAllowed = "move";
                                if (canDragCustomPrompt && command.promptId) {
                                  event.dataTransfer.setData("application/x-custom-prompt-id", command.promptId);
                                  event.dataTransfer.setData("text/plain", command.promptId);
                                  setSlashDraggedPromptId(command.promptId);
                                } else if (canDragFavorite) {
                                  event.dataTransfer.setData("text/plain", favoriteKey);
                                  setSlashDraggedFavoriteKey(favoriteKey);
                                }
                              }}
                              onDragOver={(event) => {
                                if (!canDrag) return;
                                if (canDragCustomPrompt && slashDraggedPromptId && slashDraggedPromptId !== command.promptId) {
                                  event.preventDefault();
                                  event.dataTransfer.dropEffect = "move";
                                  setSlashDragOverPromptId(command.promptId ?? null);
                                } else if (canDragFavorite && slashDraggedFavoriteKey && slashDraggedFavoriteKey !== favoriteKey) {
                                  event.preventDefault();
                                  event.dataTransfer.dropEffect = "move";
                                  setSlashDragOverFavoriteKey(favoriteKey);
                                }
                              }}
                              onDrop={(event) => {
                                if (!canDrag) return;
                                event.preventDefault();
                                if (canDragCustomPrompt && command.promptId) {
                                  const draggedId = event.dataTransfer.getData("application/x-custom-prompt-id") || event.dataTransfer.getData("text/plain");
                                  handleCustomPromptDrop(command.promptId, draggedId);
                                } else if (canDragFavorite) {
                                  handleSlashFavoriteDrop(favoriteKey, event.dataTransfer.getData("text/plain"));
                                }
                              }}
                              onDragEnd={() => {
                                setSlashDraggedFavoriteKey(null);
                                setSlashDragOverFavoriteKey(null);
                                setSlashDraggedPromptId(null);
                                setSlashDragOverPromptId(null);
                              }}
                              onMouseEnter={() => setSlashHoveredKey(favoriteKey)}
                              onMouseLeave={() => setSlashHoveredKey((current) => current === favoriteKey ? null : current)}
                              onFocusCapture={() => setSlashHoveredKey(favoriteKey)}
                              onBlurCapture={(event) => {
                                const nextTarget = event.relatedTarget;
                                if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
                                  setSlashHoveredKey((current) => current === favoriteKey ? null : current);
                                }
                              }}
                              style={{
                                position: "relative",
                                minWidth: 0,
                                opacity: isDragging ? 0.55 : 1,
                                outline: isDragOver ? "2px dashed var(--accent)" : "none",
                                outlineOffset: 2,
                              }}
                            >
                              <button
                                ref={(node) => {
                                  slashItemRefs.current[index] = node;
                                }}
                                type="button"
                                onClick={() => applySlashCommand(command)}
                                onMouseEnter={() => setSlashActiveIndex(index)}
                                style={{
                                  width: "100%",
                                  height: "100%",
                                  minWidth: 0,
                                  minHeight: 58,
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: 4,
                                  justifyContent: "center",
                                  padding: "9px 10px",
                                  border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                                  borderRadius: 7,
                                  background: active ? "var(--bg-selected)" : "var(--bg-panel)",
                                  color: "var(--text)",
                                  cursor: canDragFavorite ? "grab" : "pointer",
                                  textAlign: "left",
                                  boxShadow: active ? "0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent)" : "none",
                                }}
                              >
                                <span style={{ fontSize: 13, fontFamily: "var(--font-mono)", overflowWrap: "anywhere", wordBreak: "break-word", color: dormant ? "var(--text-dim)" : undefined }}>
                                  {command.source === "customPrompt" ? command.name : `/${command.name}`}
                                  {dormant && <span style={{ marginLeft: 6, padding: "0 4px", border: "1px solid var(--border)", borderRadius: 3, fontSize: 9, color: "var(--text-dim)", whiteSpace: "nowrap" }}>{t("chat.dormant")}</span>}
                                </span>
                                {command.description && <span style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden", fontSize: 11, lineHeight: 1.35, color: "var(--text-dim)" }}>{getSlashDescription(command, t)}</span>}
                              </button>
                              <div style={{ position: "absolute", top: 7, right: 7, display: "flex", alignItems: "center", gap: 4, opacity: actionsVisible ? 1 : 0, transition: "opacity 0.12s", pointerEvents: actionsVisible ? "auto" : "none" }}>
                                <button
                                  type="button"
                                  aria-label={t(favorite ? "chat.unfavoriteSlashCommand" : "chat.favoriteSlashCommand")}
                                  aria-pressed={favorite}
                                  title={t(favorite ? "chat.unfavoriteSlashCommand" : "chat.favoriteSlashCommand")}
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    toggleSlashFavorite(command);
                                  }}
                                  draggable={false}
                                  style={{ width: 28, height: 28, padding: 0, display: "grid", placeItems: "center", border: "1px solid var(--border)", borderRadius: 6, background: "color-mix(in srgb, var(--bg-panel) 90%, transparent)", color: favorite ? "var(--accent)" : "var(--text-dim)", cursor: "pointer" }}
                                >
                                  <Star size={14} fill={favorite ? "currentColor" : "none"} aria-hidden="true" />
                                </button>
                                <button
                                  type="button"
                                  aria-label={t("chat.viewSlashCommandDetails")}
                                  title={t("chat.viewSlashCommandDetails")}
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    slashDetailOpenerRef.current = event.currentTarget;
                                    void openSlashCommandDetails(command);
                                  }}
                                  draggable={false}
                                  style={{ width: 28, height: 28, padding: 0, display: "grid", placeItems: "center", border: "1px solid var(--border)", borderRadius: 6, background: "color-mix(in srgb, var(--bg-panel) 90%, transparent)", color: "var(--text-dim)", cursor: "pointer" }}
                                >
                                  <Info size={14} aria-hidden="true" />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  ))
                )}
              </div>
            </div>
          )}
          {atMenuOpen && atQuery !== null && (() => {
            const indexLoading = fileIndexLoading && (!fileIndex || fileIndex.cwd !== cwd);
             const matchCountLabel = atMatches.length === 1 ? t("chat.match") : t("chat.matches", { count: atMatches.length });
            // With a truncated index, local results are provisional — the
            // debounced server search over the full listing replaces them.
            const truncatedHint = fileIndex?.truncated && !serverResultInUse
               ? (atQuery.query ? t("chat.searchingAll") : t("chat.indexTruncated"))
              : "";
            return (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: "calc(100% + 8px)",
                  zIndex: 120,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
                  overflow: "hidden",
                  maxHeight: "min(48vh, 400px)",
                }}
              >
                <div
                  style={{
                    padding: "8px 10px",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    fontSize: 11,
                    color: "var(--text-dim)",
                  }}
                >
                  <span>
                    {indexLoading
                       ? t("chat.loadingFiles")
                       : t("chat.files", { label: matchCountLabel, hint: truncatedHint })}
                  </span>
                   <span style={{ fontFamily: "var(--font-mono)" }}>{t("chat.tabEnter")}</span>
                </div>
                <div style={{ maxHeight: "calc(min(48vh, 400px) - 34px)", overflowY: "auto", padding: 4 }}>
                  {!indexLoading && atMatches.length === 0 ? (
                    <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--text-dim)" }}>
                       {needsServerSearch && !serverResultInUse ? t("chat.searching") : t("chat.noMatchingFiles")}
                    </div>
                  ) : (
                    atMatches.map((entry, index) => {
                      const active = index === atActiveIndex;
                      const name = entry.path.split("/").pop() ?? entry.path;
                      const dirPrefix = entry.path.slice(0, entry.path.length - name.length);
                      return (
                        <button
                          key={`${entry.isDir ? "d" : "f"}:${entry.path}`}
                          ref={(node) => {
                            atItemRefs.current[index] = node;
                          }}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            applyAtCompletion(entry);
                          }}
                          onMouseEnter={() => setAtActiveIndex(index)}
                          style={{
                            width: "100%",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 8px",
                            border: "none",
                            borderRadius: 6,
                            background: active ? "var(--bg-selected)" : "none",
                            color: "var(--text)",
                            cursor: "pointer",
                            textAlign: "left",
                            fontSize: 12.5,
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
                            {entry.isDir ? <FolderIcon size={14} /> : getFileIcon(name, 14)}
                          </span>
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {dirPrefix && <span style={{ color: "var(--text-dim)" }}>{dirPrefix}</span>}
                            {name}
                            {entry.isDir && <span style={{ color: "var(--text-dim)" }}>/</span>}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })()}
          <div
            style={{
              minWidth: 0,
              display: "flex",
              gap: 8,
              alignItems: "center",
              background: "var(--bg)",
              border: `1px solid ${bashMode ? "var(--tool-bg)" : isStreaming && (onSteer || onFollowUp)
                ? "rgba(234,179,8,0.4)"
                : "color-mix(in srgb, var(--border) 70%, transparent)"}`,
              borderRadius: 14,
              padding: isMobile ? "6px 6px 6px 12px" : "10px 10px 10px 10px",
              flexWrap: isMobile && isStreaming && (onSteer || onFollowUp) ? "wrap" : "nowrap",
              rowGap: isMobile && isStreaming && (onSteer || onFollowUp) ? 4 : undefined,
              boxShadow: "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              transition: "border-color 0.15s, background 0.15s, box-shadow 0.15s",
            } as React.CSSProperties}
          >
          <button
            ref={slashToggleButtonRef}
            type="button"
            aria-label={t("chat.openSlashCommandMenu")}
            title={t("chat.openSlashCommandMenu")}
            onPointerDown={(event) => event.preventDefault()}
            onClick={toggleSlashCommandMenu}
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 32,
              height: 32,
              padding: 0,
              boxSizing: "border-box",
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 8,
              color: "var(--text-muted)",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              fontWeight: 600,
              lineHeight: 1,
              transition: "background 0.12s, color 0.12s, border-color 0.12s",
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = "var(--bg-hover)";
              event.currentTarget.style.color = "var(--text)";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = "transparent";
              event.currentTarget.style.color = "var(--text-muted)";
            }}
          >
            <span aria-hidden="true">/</span>
          </button>
          <div
            style={{
              position: "relative",
              display: "flex",
              flex: 1,
              minWidth: 0,
            }}
          >
            {showEditorSuggestion && (
              <div
                ref={editorSuggestionOverlayRef}
                aria-hidden="true"
                style={{
                  position: "absolute",
                  inset: 0,
                  zIndex: 0,
                  overflow: "hidden",
                  pointerEvents: "none",
                  whiteSpace: "pre-wrap",
                  overflowWrap: "break-word",
                  color: "var(--text-dim)",
                  opacity: 0.7,
                  fontSize: isMobile ? 16 : 14,
                  lineHeight: isMobile ? "26px" : "22px",
                  fontFamily: "inherit",
                  padding: "2px 0",
                  boxSizing: "border-box",
                }}
              >
                <span style={{ color: "transparent" }}>{value}</span>{editorSuggestionSuffix}
              </div>
            )}
            <textarea
            ref={textareaRef}
            className="chat-input-textarea"
            value={value}
            onChange={(e) => {
              const input = e.nativeEvent as InputEvent;
              if (isMobile && showEditorSuggestion && !isComposingRef.current && !input.isComposing
                && Date.now() - lastCompositionEndAtRef.current >= COMPOSITION_END_ENTER_GRACE_MS
                && input.inputType === "insertText" && (input.data === " " || input.data == null)
                && e.target.value === `${valueRef.current} ` && acceptEditorSuggestion()) return;
              valueRef.current = e.target.value;
              setSlashMenuOpenedByButton(false);
              setActiveSlashTab("customPrompt");
              setSlashCaret(e.target.selectionStart);
              setValue(e.target.value);
              setHistoryMenuOpen(false);
              updateAtQuery(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => {
              const el = e.currentTarget;
              setSlashCaret(el.selectionStart);
              updateAtQuery(el.value, el.selectionStart);
            }}
            onScroll={(e) => {
              const overlay = editorSuggestionOverlayRef.current;
              if (!overlay) return;
              overlay.scrollTop = e.currentTarget.scrollTop;
              overlay.scrollLeft = e.currentTarget.scrollLeft;
            }}
            onKeyDown={handleKeyDown}
            onFocus={() => {
              if (isMobile && typeof window !== "undefined") {
                window.scrollTo(0, 0);
                if (document.body) document.body.scrollTop = 0;
                if (document.documentElement) document.documentElement.scrollTop = 0;
              }
            }}
            onBeforeInput={handleBeforeInput}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onBlur={() => {
              isComposingRef.current = false;
              lastCompositionEndAtRef.current = 0;
            }}
            onCompositionEnd={(e) => {
              isComposingRef.current = false;
              lastCompositionEndAtRef.current = Date.now();
              const el = e.currentTarget;
              setSlashCaret(el.selectionStart);
              updateAtQuery(el.value, el.selectionStart);
            }}
            onInput={handleInput}
            onPaste={handlePaste}
            readOnly={Boolean(readOnlyReason)}
            aria-label={inputPlaceholder}
            placeholder={showEditorSuggestion ? "" : inputPlaceholder}
            rows={1}
            style={{
              flex: 1,
              minWidth: 0,
              width: "100%",
              background: "none",
              border: "none",
              outline: "none",
              resize: "none",
              color: "var(--text)",
              fontSize: isMobile ? 16 : 14,
              // Keep each native caret line on an integer pixel grid.
              lineHeight: isMobile ? "26px" : "22px",
              fontFamily: "inherit",
              padding: "2px 0",
              minHeight: 24,
              maxHeight: 200,
              overflowX: "hidden",
              overflowY: "auto",
              position: "relative",
              zIndex: 1,
            }}
          />
            </div>

          <button
            type="button"
            aria-label={t("chat.insertNewline")}
            aria-keyshortcuts="Shift+Enter"
            title={`${t("chat.insertNewline")} · Shift+Enter`}
            onPointerDown={(event) => event.preventDefault()}
            onClick={insertNewline}
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "7px 9px",
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 8,
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            <span aria-hidden="true" style={{ fontFamily: "var(--font-mono)" }}>⇧↵</span>
            {t("chat.insertNewline")}
          </button>

          {isStreaming ? (
            <div
              data-testid="chat-input-stream-actions"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                flexShrink: 0,
                flexBasis: isMobile && (onSteer || onFollowUp) ? "100%" : undefined,
                width: isMobile && (onSteer || onFollowUp) ? "100%" : undefined,
                justifyContent: isMobile && (onSteer || onFollowUp) ? "flex-end" : undefined,
                boxSizing: "border-box",
              }}
            >
              {onSteer && (
                <button
                  onClick={() => sendQueued("steer")}
                  disabled={!canQueueStreamingMessage}
                  title="Interrupt the current run and inject this message now"
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "7px 12px",
                    background: canQueueStreamingMessage ? "rgba(234,179,8,0.12)" : "none",
                    border: "1px solid rgba(234,179,8,0.35)",
                    borderRadius: 8,
                    color: canQueueStreamingMessage ? "rgba(180,130,0,1)" : "var(--text-dim)",
                    cursor: canQueueStreamingMessage ? "pointer" : "not-allowed",
                    fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em",
                    transition: "background 0.12s",
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 1 L9 5 L5 9" /><line x1="1" y1="5" x2="9" y2="5" />
                  </svg>
                  {t("chat.steer")}
                </button>
              )}
              {onFollowUp && (
                <button
                  onClick={() => sendQueued("followup")}
                  disabled={!canQueueStreamingMessage}
                  title="Queue this message after the agent finishes"
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "7px 12px",
                    background: canQueueStreamingMessage ? "rgba(129,140,248,0.12)" : "none",
                    border: "1px solid rgba(129,140,248,0.35)",
                    borderRadius: 8,
                    color: canQueueStreamingMessage ? "rgba(99,102,241,1)" : "var(--text-dim)",
                    cursor: canQueueStreamingMessage ? "pointer" : "not-allowed",
                    fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em",
                    transition: "background 0.12s",
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="5" y1="1" x2="5" y2="6" /><polyline points="2.5 3.5 5 1 7.5 3.5" />
                    <line x1="2" y1="9" x2="8" y2="9" />
                  </svg>
                  {t("chat.followUp")}
                </button>
              )}
            </div>
          ) : (
            <>
            <button
              onClick={continueUi && continueUi.kind !== "idle" && !value.trim() ? onContinue : handleSend}
              disabled={statePending || Boolean(readOnlyReason) || (!(continueUi && continueUi.kind !== "idle" && !value.trim()) && !value.trim() && !attachedImages.length && !quotes.length)}
              title={
                continueUi && continueUi.kind !== "idle" && !value.trim()
                  ? (continueUi.errorText ? t("chat.continueAiError", { error: continueUi.errorText }) : t("chat.continueLastTask"))
                  : t("chat.send")
              }
              aria-label={continueUi && continueUi.kind !== "idle" && !value.trim() ? t("chat.continueLastTask") : t("chat.send")}
              style={{
                flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                ...(isMobile && !(continueUi && continueUi.kind !== "idle" && !value.trim()) ? { width: 36, height: 36, padding: 0 } : { padding: "7px 14px" }),
                ...(continueUi && continueUi.kind !== "idle" && !value.trim()
                  ? {
                      background: "rgba(234,88,12,0.9)",
                      border: "none",
                      borderRadius: 8,
                      color: "#fff",
                      cursor: "pointer",
                      fontSize: 13,
                      fontWeight: 600,
                      fontVariantNumeric: "tabular-nums",
                      letterSpacing: "-0.01em",
                      boxShadow: "0 1px 3px rgba(234,88,12,0.35)",
                    }
                  : {
                      background: (value.trim() || attachedImages.length || quotes.length) ? "var(--accent)" : "var(--bg-panel)",
                      border: "none",
                      borderRadius: 8,
                      color: (value.trim() || attachedImages.length || quotes.length) ? "#fff" : "var(--text-dim)",
                      cursor: (value.trim() || attachedImages.length || quotes.length) ? "pointer" : "not-allowed",
                      fontSize: 13,
                      fontWeight: 600,
                      letterSpacing: "-0.01em",
                      boxShadow: (value.trim() || attachedImages.length) ? "0 1px 3px rgba(37,99,235,0.25)" : "none",
                    }),
                transition: "background 0.15s, box-shadow 0.15s",
              }}
            >
              {continueUi && continueUi.kind !== "idle" && !value.trim() ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="5 2 11 7 5 12" />
                    <line x1="2" y1="7" x2="10" y2="7" />
                  </svg>
                  {continueUi.kind === "running"
                    ? (continueUi.nextDelayMs !== null
                      ? t("chat.continueCountdown", { seconds: Math.ceil(continueUi.nextDelayMs / 1000) })
                      : t("chat.continueAction"))
                    : continueUi.kind === "stopped"
                      ? (continueUi.reason === "limit" ? t("chat.continueLimitManual") : t("chat.continueManual"))
                      : t("chat.continueAction")}
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="2" y1="7" x2="11" y2="7" />
                    <polyline points="7.5 3 12 7 7.5 11" />
                  </svg>
                  {!isMobile && t("chat.send")}
                </>
              )}
            </button>
            {continueUi && continueUi.kind === "running" && unattended && onStopContinue && (
              <button
                onClick={onStopContinue}
                title={t("chat.stopAutoContinueTitle")}
                style={{
                  flexShrink: 0,
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "7px 14px",
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.3)",
                  borderRadius: 8,
                  color: "#ef4444",
                  cursor: "pointer",
                  fontSize: 13, fontWeight: 600,
                  letterSpacing: "-0.01em",
                  transition: "background 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.16)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
                </svg>
                {t("chat.stopAutoContinue")}
              </button>
            )}
            </>
          )}
          </div>
        </div>

        {/* Bash mode status label */}
        {bashMode && (
          <div className="text-xs px-2 py-1" style={{ color: bashExcluded ? "var(--text-muted)" : "var(--accent)", marginTop: 4 }}>
             {t("chat.shell")} · {bashExcluded ? t("chat.outputLocal") : t("chat.outputModel")}
          </div>
        )}

        {continueUi?.kind === "stopped" && !value.trim() && (
          <div
            role="status"
            aria-live="polite"
            style={{
              marginTop: 6,
              padding: "0 4px",
              color: "var(--text-muted)",
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            {t("chat.autoRetryStopped")}
          </div>
        )}

        {/* Bottom bar: left | center (context) | right */}
        <div className="chat-input-controls" style={{
          marginTop: isMobile ? 4 : 8,
          display: isMobile ? "grid" : "flex",
          gridTemplateColumns: isMobile
            ? (mobileControlsVisible ? "minmax(0, 1fr)" : "minmax(0, 1fr) auto")
            : undefined,
          alignItems: "center",
          gap: 6,
        }}>

          {/* LEFT: attach + model selector (idle) or steer/followup toggle (streaming) */}
          <div style={{ flex: isMobile ? "1 1 auto" : "0 0 auto", minWidth: 0, display: "flex", alignItems: "center", gap: 4 }}>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={!canAttachImages}
             title={t("chat.attachImage")}
              style={{
                flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                width: 28, height: 32, padding: 0,
                background: "none", border: "none",
                borderRadius: 9,
                color: attachedImages.length ? "var(--accent)" : "var(--text-muted)",
                cursor: canAttachImages ? "pointer" : "not-allowed",
                opacity: canAttachImages ? 1 : 0.5,
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={(e) => {
                if (!canAttachImages) return;
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = attachedImages.length ? "var(--accent)" : "var(--text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "none";
                e.currentTarget.style.color = attachedImages.length ? "var(--accent)" : "var(--text-muted)";
              }}
            >
              <Paperclip size={15} strokeWidth={1.8} aria-hidden="true" />
            </button>
            {/* Model selector — available during streaming; serialize configuration writes */}
            {(visibleModelOptions.length > 0 || currentName || modelError) && onModelChange && (
                <div ref={dropdownRef} style={{ position: "relative", order: 3, flex: isMobile ? "1 1 auto" : undefined, minWidth: 0 }}>
                  <ChatInputSelectTrigger
                    triggerRef={modelTriggerRef}
                    label={currentName ?? (visibleModelOptions.length > 0 ? "Select model" : modelError ? "Model error" : "No models")}
                    icon={modelSwitching ? (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" style={{ animation: "spin 0.8s linear infinite", flexShrink: 0 }} aria-hidden="true">
                        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                      </svg>
                    ) : (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="4" y="4" width="16" height="16" rx="2" />
                        <rect x="9" y="9" width="6" height="6" />
                        <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                        <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                        <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                        <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
                      </svg>
                    )}
                    open={modelDropdownOpen}
                    disabled={modelSwitching || runtimeSettingsUpdating}
                    busy={modelSwitching || runtimeSettingsUpdating}
                    title={modelSwitching ? "Switching model" : visibleModelOptions.length > 0 ? "Change model" : modelError ? "Model discovery failed" : "No available models"}
                    ariaLabel={modelSwitching ? "Switching model" : visibleModelOptions.length > 0 ? "Change model" : modelError ? "Model discovery failed" : "No available models"}
                    onToggle={() => {
                      refreshHiddenModelProviders();
                      const rect = modelTriggerRef.current?.getBoundingClientRect();
                      if (rect) setModelDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
                      setModelDropdownOpen((open) => {
                        if (open) {
                          setModelFilter("");
                          return false;
                        }
                        announceReaderMenuOpen("chat-model");
                        return true;
                      });
                    }}
                    isMobile={isMobile}
                    style={{
                      justifyContent: isMobile ? "flex-start" : undefined,
                      padding: isMobile ? "8px 10px" : "8px 12px",
                      width: isMobile ? "100%" : undefined,
                      maxWidth: isMobile ? "100%" : 220,
                      overflow: "hidden",
                      opacity: runtimeSettingsUpdating ? 0.5 : 1,
                    }}
                  />
                  {modelDropdownOpen && modelDropdownRect && (() => {
                    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
                    const bottom = viewportHeight - modelDropdownRect.top + 6;
                    const maxH = Math.max(120, Math.min(modelDropdownRect.top - 8, viewportHeight * 0.6));
                    // On mobile, pin to a small left margin and cap width to the
                    // viewport so long model names never push the panel off-screen.
                    const panelPos: React.CSSProperties = isMobile
                      ? { left: 8, right: 8, maxWidth: "calc(100vw - 16px)" }
                      : { left: modelDropdownRect.left, width: "max-content", minWidth: modelDropdownRect.width };
                    return (
                      <div ref={modelDropdownPanelRef} style={{
                      position: "fixed",
                      bottom,
                      ...panelPos,
                      zIndex: 500, background: "var(--bg)", border: "1px solid var(--border)",
                      borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                      overflow: "hidden", maxHeight: maxH, display: "flex", flexDirection: "column",
                      }}>
                      {showModelFilter && (
                        <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
                          <input
                            value={modelFilter}
                            onChange={(e) => setModelFilter(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") {
                                setModelFilter("");
                                setModelDropdownOpen(false);
                              }
                            }}
                            placeholder={t("chat.filterModels")}
                            aria-label={t("chat.filterModels")}
                            autoFocus
                            autoComplete="off"
                            spellCheck={false}
                            style={{
                              width: "100%",
                              minWidth: isMobile ? 0 : 220,
                              fontSize: isMobile ? 16 : 11,
                              fontFamily: "var(--font-mono)",
                              padding: "5px 8px",
                              border: "1px solid var(--border)",
                              borderRadius: 5,
                              outline: "none",
                              background: "var(--bg)",
                              color: "var(--text)",
                              boxSizing: "border-box",
                            }}
                          />
                        </div>
                      )}
                      <div
                        role="listbox"
                        aria-label="Change model"
                        style={{ minHeight: 0, overflowY: "auto" }}
                      >
                        {/* ── Chat models ── */}
                        {modelsByProvider.length === 0 ? (
                          <div role="presentation" style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: 12, whiteSpace: "nowrap" }}>
                            {modelFilter.trim()
                              ? t("chat.noMatchingModels")
                              : modelError
                                ? "Model discovery failed"
                                : "No available models"}
                          </div>
                        ) : modelsByProvider.map((group, gi) => (
                          <div key={group.provider} role="group" aria-label={group.provider}>
                            {(modelsByProvider.length > 1) && (
                              <div role="presentation" style={{
                                padding: "6px 12px 4px",
                                fontSize: 10, fontWeight: 600, color: "var(--text-dim)",
                                textTransform: "uppercase", letterSpacing: "0.07em",
                                borderTop: gi > 0 ? "1px solid var(--border)" : "none",
                              }}>
                                {group.provider}
                              </div>
                            )}
                            {group.options.map((opt) => {
                              const isActive = opt.modelId === model?.modelId && opt.provider === model?.provider;
                              return (
                                <SelectorRow
                                  key={`${opt.provider}:${opt.modelId}`}
                                  active={isActive}
                                  gutter={Boolean(onSetDefaultModel)}
                                  star={onSetDefaultModel ? {
                                    isDefault: defaultModel?.provider === opt.provider && defaultModel?.modelId === opt.modelId,
                                    saveLabel: t("chat.saveDefaultModel"),
                                    defaultLabel: t("chat.defaultModel"),
                                    onSave: () => {
                                      setModelDropdownOpen(false);
                                      resetDraftPromptTools();
                                      onSetDefaultModel(opt.provider, opt.modelId);
                                    },
                                  } : undefined}
                                  onSelect={() => {
                                    setModelDropdownOpen(false);
                                    setModelFilter("");
                                    if (!isActive || isAutoModelSelection) {
                                      resetDraftPromptTools();
                                      onModelChange(opt.provider, opt.modelId);
                                    }
                                  }}
                                >
                                  {opt.name}
                                </SelectorRow>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    </div>
                    );
                  })()}
                </div>
            )}
            {/* Image-generation switch (Reader local patch): on = generation allowed for this session */}
            <button
              onClick={handleGenToggle}
              disabled={!genState}
              title={
                genState?.enabled && genState.genInvalid
                  ? t("chat.genNoValidModelTitle")
                  : genState?.enabled ? t("chat.genOffTitle") : t("chat.genOnTitle")
              }
              style={{
                flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                width: 28, height: 32, padding: 0,
                background: "none", border: "none",
                borderRadius: 9,
                color: genState?.enabled ? "var(--accent)" : "var(--text-muted)",
                cursor: genState ? "pointer" : "not-allowed",
                opacity: genState ? 1 : 0.5,
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = genState?.enabled ? "var(--accent)" : "var(--text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "none";
                e.currentTarget.style.color = genState?.enabled ? "var(--accent)" : "var(--text-muted)";
              }}
            >
              {/* Image icon = the generation switch; filled when ON */}
              <svg width="15" height="15" viewBox="0 0 24 24" fill={genState?.enabled ? "currentColor" : "none"} fillOpacity={genState?.enabled ? 0.28 : 0} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </button>
            {/* Gen size/resolution selectors (Reader local patch): shown when
                generation is on with a valid model; options follow the model. */}
            {genState?.enabled && !genState.genInvalid && genState.genModelId && (() => {
              const cap = genState.capabilities?.[genState.genModelId];
              if (!cap) return null;
              const sizes = cap.ratios ?? cap.pixelSizes ?? [];
              const sizeUnset = genState.genOptionsUnset?.includes("size") ?? false;
              const resolutionUnset = genState.genOptionsUnset?.includes("resolution") ?? false;
              const qualityUnset = genState.genOptionsUnset?.includes("quality") ?? false;
              const sizeValue = sizeUnset
                ? GEN_OPTION_REQUEST
                : sizes.includes(genState.genSize ?? "")
                  ? genState.genSize!
                  : sizes[0] ?? "";
              const resValue = resolutionUnset
                ? GEN_OPTION_REQUEST
                : cap.resolutions.includes(genState.genResolution ?? "")
                  ? genState.genResolution!
                  : cap.resolutions[0] ?? "";
              const qualityValue = qualityUnset
                ? GEN_OPTION_REQUEST
                : cap.qualities?.includes(genState.genQuality ?? "")
                  ? genState.genQuality!
                  : cap.qualities?.[0] ?? "";
              const requestOption = { value: GEN_OPTION_REQUEST, label: t("chat.genRequest"), menuLabel: t("chat.genRequest") };
              return (
                <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0, cursor: "pointer" }}>
                  {sizes.length > 0 && (
                    <GenOptionSelect
                      value={sizeValue}
                      onChange={(value) => handleGenOption("size", value)}
                      title={t("chat.genSize")}
                      ariaLabel={t("chat.genSize")}
                      options={[requestOption, ...sizes.map((r) => ({ value: r, label: r === "auto" ? t("chat.genAuto") : r }))]}
                    />
                  )}
                  {cap.resolutions.length > 0 && (
                    <GenOptionSelect
                      value={resValue}
                      onChange={(value) => handleGenOption("resolution", value)}
                      title={t("chat.genResolution")}
                      ariaLabel={t("chat.genResolution")}
                      options={[requestOption, ...cap.resolutions.map((r) => ({ value: r, label: r }))]}
                    />
                  )}
                  {cap.qualities && cap.qualities.length > 0 && (
                    <GenOptionSelect
                      value={qualityValue}
                      onChange={(value) => handleGenOption("quality", value)}
                      title={t("chat.genQuality")}
                      ariaLabel={t("chat.genQuality")}
                      options={[requestOption, ...(cap.qualities ?? []).map((q) => ({ value: q, label: q }))]}
                    />
                  )}
                </div>
              );
            })()}
          </div>

          {/* spacer */}
          {!isMobile && <div style={{ flex: 1 }} />}

          {/* RIGHT: thinking + tools preset + compact (idle) | Stop (streaming) */}
          <div ref={controlsMenuRef} style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            position: "relative",
            marginLeft: isMobile ? 0 : "auto",
            ...(mobileControlsVisible ? { gridColumn: "1 / -1", gridRow: 2, width: "100%", minWidth: 0 } : null),
          }}>
            {isMobile && (
              <button
                type="button"
                 title={controlsMenuOpen ? undefined : t("chat.moreControls")}
                 aria-label={t("chat.moreControls")}
                aria-expanded={controlsMenuOpen}
                aria-hidden={mobileControlsVisible || undefined}
                tabIndex={mobileControlsVisible ? -1 : undefined}
                onClick={() => {
                  announceReaderMenuOpen("chat-controls");
                  setModelDropdownOpen(false);
                  setModelFilter("");
                  setControlsMenuOpen(true);
                }}
                style={{
                  display: mobileControlsVisible ? "none" : "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "100%",
                  height: 32,
                  padding: "8px 10px",
                  background: "none",
                  border: "none",
                  borderRadius: 9,
                  color: "var(--text-muted)",
                  cursor: mobileControlsVisible ? "default" : "pointer",
                  fontSize: 12,
                  fontWeight: 500,
                  pointerEvents: mobileControlsVisible ? "none" : "auto",
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => {
                  if (controlsMenuOpen) return;
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text)";
                }}
                onMouseLeave={(e) => {
                  if (controlsMenuOpen) return;
                  e.currentTarget.style.background = "none";
                  e.currentTarget.style.color = "var(--text-muted)";
                }}
              >
                {t("chat.moreControls")}
              </button>
            )}
            <div style={{
              display: isMobile ? (mobileControlsVisible ? "flex" : "none") : "flex",
              alignItems: "center",
              gap: isMobile ? 4 : 2,
              ...(isMobile ? {
                position: "static",
                zIndex: 60,
                padding: "2px 0",
                width: "100%",
                minWidth: 0,
                maxWidth: "100%",
                flexWrap: "wrap",
                justifyContent: "flex-end",
              } : null),
            }}>
            {fastMode && (fastMode.supported || fastMode.mode !== "default") && onFastModeChange && (
              <div ref={fastModeDropdownRef} style={{ position: "relative" }}>
                <ChatInputSelectTrigger
                  label={fastModeDisplayLabel}
                  icon={<Zap size={13} strokeWidth={2} aria-hidden="true" />}
                  open={fastModeDropdownOpen}
                  disabled={runtimeSettingsUpdating}
                  busy={runtimeSettingsUpdating}
                  accent={fastMode.enabled}
                  title={`${t("chat.changeFastMode")}: ${fastModeDisplayLabel}`}
                  ariaLabel={t("chat.changeFastMode")}
                  onToggle={() => {
                    if (runtimeSettingsUpdating) return;
                    setFastModeDropdownOpen((open) => {
                      if (!open) announceReaderMenuOpen("chat-fast-mode");
                      return !open;
                    });
                  }}
                  isMobile={isMobile}
                  showLabel={!isMobile || controlsMenuOpen || isStreaming}
                />
                {fastModeDropdownOpen && (
                  <div
                    role="listbox"
                    aria-label={t("chat.changeFastMode")}
                    style={{
                      position: "absolute", bottom: "calc(100% + 6px)",
                      ...(isMobile ? { left: 0 } : { right: 0 }),
                      zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)",
                      borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                      overflow: "hidden", width: "max-content",
                    }}>
                    {(["default", "fast", "standard"] as const).map((mode) => {
                      const isActive = fastMode.mode === mode;
                      return (
                        <SelectorRow
                          key={mode}
                          active={isActive}
                          disabled={mode === "fast" && !fastMode.supported}
                          onSelect={() => {
                            setFastModeDropdownOpen(false);
                            if (!isActive && !(mode === "fast" && !fastMode.supported)) onFastModeChange(mode);
                          }}
                        >
                          <span style={{ flex: 1 }}>{mode}</span>
                          <span aria-hidden="true" style={{ width: 10, flexShrink: 0 }} />
                        </SelectorRow>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {onThinkingLevelChange && (
              <div ref={thinkingDropdownRef} style={{ position: "relative" }}>
                <ChatInputSelectTrigger
                  label={thinkingDisplayLabel}
                  icon={
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9.5 2A5.5 5.5 0 0 0 4 7.5c0 1.7.78 3.21 2 4.21V14a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-2.29c1.22-1 2-2.51 2-4.21A5.5 5.5 0 0 0 9.5 2z" />
                      <line x1="7" y1="18" x2="12" y2="18" />
                      <line x1="8" y1="21" x2="11" y2="21" />
                    </svg>
                  }
                  open={thinkingDropdownOpen}
                  disabled={runtimeSettingsUpdating}
                  busy={runtimeSettingsUpdating}
                  title={isStreaming
                    ? t("chat.currentReasoning", { level: thinkingDisplayLabel })
                    : t("chat.changeReasoning", { level: thinkingDisplayLabel })}
                  ariaLabel={t("chat.changeReasoningLabel")}
                  onToggle={() => {
                    if (runtimeSettingsUpdating) return;
                    setThinkingDropdownOpen((open) => {
                      if (!open) announceReaderMenuOpen("chat-thinking");
                      return !open;
                    });
                  }}
                  isMobile={isMobile}
                  showLabel={!isMobile || controlsMenuOpen || isStreaming}
                />
                {thinkingDropdownOpen && (
                  <div
                    role="listbox"
                    aria-label={t("chat.changeReasoningLabel")}
                    style={{
                      position: "absolute", bottom: "calc(100% + 6px)",
                      ...(isMobile ? { left: 0 } : { right: 0 }),
                      zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)",
                      borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                      overflow: "hidden", minWidth: 110,
                    }}>
                    {getThinkingChoices(availableThinkingLevels).map((lvl) => {
                      const isActive = lvl === "auto"
                        ? isAutoThinkingSelection
                        : !isAutoThinkingSelection && resolvedThinkingLevel === lvl;
                      const mappedVal = (lvl !== "auto" && thinkingLevelMap) ? thinkingLevelMap[lvl] : undefined;
                      const displayLabel = (mappedVal != null && mappedVal !== lvl) ? mappedVal : lvl;
                      const showOriginal = mappedVal != null && mappedVal !== lvl;
                      return (
                        <SelectorRow
                          key={lvl}
                          active={isActive}
                          onSelect={() => {
                            setThinkingDropdownOpen(false);
                            if (lvl === "auto") {
                              if (!isAutoThinkingSelection) onThinkingLevelChange("auto");
                              return;
                            }
                            if (!isActive || isAutoThinkingSelection) onThinkingLevelChange(lvl);
                          }}
                          gutter={Boolean(onSetDefaultThinkingLevel)}
                          star={onSetDefaultThinkingLevel && lvl !== "auto"
                            ? {
                                isDefault: savedDefaultThinkingLevel === lvl,
                                saveLabel: t("chat.saveDefaultThinking"),
                                defaultLabel: t("chat.defaultThinking"),
                                onSave: () => {
                                  setThinkingDropdownOpen(false);
                                  onSetDefaultThinkingLevel(lvl);
                                },
                              }
                            : undefined}
                        >
                          <span style={{ flex: 1 }}>
                            {displayLabel}
                            {showOriginal && <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginLeft: 5 }}>({lvl})</span>}
                          </span>
                        </SelectorRow>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {!isStreaming && onToolPresetChange && (
              <div ref={toolDropdownRef} style={{ position: isMobile ? "static" : "relative" }}>
                <ChatInputSelectTrigger
                  label={toolPresetLabel}
                  icon={
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                    </svg>
                  }
                  open={toolDropdownOpen}
                  disabled={isStreaming}
                  title={t("chat.changeToolPreset") + `: ${toolPresetLabel}`}
                  ariaLabel={t("chat.changeToolPreset")}
                  onToggle={() => {
                    if (isStreaming) return;
                    setToolDropdownOpen((open) => {
                      if (!open) announceReaderMenuOpen("chat-tools");
                      return !open;
                    });
                  }}
                  isMobile={isMobile}
                  showLabel={!isMobile || controlsMenuOpen}
                />
                {toolDropdownOpen && (
                  <div
                    role="listbox"
                    aria-label={t("chat.changeToolPreset")}
                    style={{
                      position: "absolute",
                      bottom: "calc(100% + 6px)",
                      right: 0,
                      maxWidth: isMobile ? "calc(100vw - 16px)" : undefined,
                      zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)",
                      borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                      overflow: "hidden", minWidth: 120,
                    }}>
                    {TOOL_PRESETS.map((lvl) => {
                      const preset = TOOL_PRESET_MAP[lvl];
                      const isActive = (toolPreset ?? "default") === preset;
                      let desc: string;
                      if (lvl === "configured") desc = t("chat.configuredToolsDescription");
                      else if (lvl === "off") desc = t("chat.noTools");
                      else if (lvl === "read-only") desc = t("chat.readOnlyTools", { count: 4 });
                      else if (lvl === "default") desc = t("chat.builtInTools", { count: 4 });
                      else desc = t("chat.allBuiltInTools");
                      return (
                        <SelectorRow
                          key={lvl}
                          active={isActive}
                          onSelect={() => {
                            setToolDropdownOpen(false);
                            if (!isActive) onToolPresetChange(preset);
                          }}
                        >
                          <span style={{ flex: 1 }}>{lvl === "configured" ? t("chat.configuredTools") : lvl}</span>
                          <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{desc}</span>
                        </SelectorRow>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {(onCompact || onAutoCompactionChange) && (!isMobile || controlsMenuOpen || isCompacting) && (
              <div style={{
                display: "flex",
                alignItems: "stretch",
                height: 32,
                marginRight: (isStreaming || (continueUi && continueUi.kind === "running")) ? (isMobile ? 5 : 4) : 0,
              }}>
                {onCompact && <button
                  onClick={isCompacting ? onAbortCompaction : onCompact}
                  disabled={isStreaming && !isCompacting}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                    padding: isMobile ? "0 6px" : "8px 12px",
                    width: isMobile ? "auto" : undefined,
                    height: 32,
                    background: isCompacting ? "rgba(239,68,68,0.08)" : "none",
                    border: isCompacting ? "1px solid rgba(239,68,68,0.3)" : "1px solid var(--border)",
                    borderRight: onAutoCompactionChange ? "none" : undefined,
                    borderRadius: onAutoCompactionChange ? "9px 0 0 9px" : 9,
                    color: isCompacting ? "#ef4444" : "var(--text-muted)",
                    cursor: (isStreaming && !isCompacting) ? "not-allowed" : "pointer",
                    fontSize: 12,
                    fontWeight: isCompacting ? 600 : 500,
                    letterSpacing: isCompacting ? "-0.01em" : undefined,
                    opacity: (isStreaming && !isCompacting) ? 0.5 : 1,
                    transition: "background 0.12s, color 0.12s, border-color 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    if (isStreaming && !isCompacting) return;
                    e.currentTarget.style.background = isCompacting ? "rgba(239,68,68,0.16)" : "var(--bg-hover)";
                    e.currentTarget.style.color = isCompacting ? "#ef4444" : "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = isCompacting ? "rgba(239,68,68,0.08)" : "none";
                    e.currentTarget.style.color = isCompacting ? "#ef4444" : "var(--text-muted)";
                  }}
                  title={isCompacting ? t("chat.stopCompaction") : t("chat.compactContext")}
                  aria-label={isCompacting ? t("chat.stopCompaction") : t("chat.compactContext")}
                >
                  {isCompacting ? (
                    <><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="2" y="2" width="6" height="6" rx="1" fill="currentColor" /></svg>{(!isMobile || controlsMenuOpen) && <span style={{ whiteSpace: "nowrap" }}>{t("chat.compacting")}</span>}</>
                  ) : (
                    <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" />
                      <line x1="10" y1="14" x2="3" y2="21" /><line x1="21" y1="3" x2="14" y2="10" />
                    </svg>{(!isMobile || controlsMenuOpen) && <span style={{ whiteSpace: "nowrap" }}>{t("chat.compact")}</span>}</>
                  )}
                </button>}
                {onAutoCompactionChange && (
                  <button
                    type="button"
                    onClick={() => runtimeSettingsRead?.status === "error"
                      ? void onRetryRuntimeSettings?.()
                      : void onAutoCompactionChange(!autoCompactionEnabled)}
                    disabled={isCompacting || runtimeSettingsRead?.status === "loading" || (runtimeSettingsRead?.status === "error" ? !onRetryRuntimeSettings : autoCompactionEnabled == null)}
                    data-state={runtimeSettingsRead?.status ?? (autoCompactionEnabled == null ? "loading" : "ready")}
                    aria-busy={(runtimeSettingsRead?.status === "loading" || (!runtimeSettingsRead && autoCompactionEnabled == null)) || undefined}
                    aria-pressed={runtimeSettingsRead?.status === "error" ? undefined : autoCompactionEnabled ?? undefined}
                    aria-label={runtimeSettingsRead?.status === "error" ? t("chat.runtimeSettingsRetry") : autoCompactionEnabled == null ? t("chat.autoCompactionLoading") : autoCompactionEnabled ? t("chat.autoCompactionEnabled") : t("chat.autoCompactionDisabled")}
                    title={runtimeSettingsRead?.status === "error" ? `${t("chat.runtimeSettingsRetry")}: ${runtimeSettingsRead.error ?? ""}` : autoCompactionEnabled == null ? t("chat.autoCompactionLoading") : autoCompactionEnabled ? t("chat.autoCompactionEnabled") : t("chat.autoCompactionDisabled")}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                      padding: isMobile ? "0 6px" : "8px 10px",
                      width: isMobile && !controlsMenuOpen ? 30 : "auto",
                      height: 32,
                      background: autoCompactionEnabled ? "var(--bg-selected, rgba(59, 130, 246, 0.10))" : "rgba(128,128,128,0.06)",
                      border: autoCompactionEnabled ? "1px solid rgba(59, 130, 246, 0.32)" : "1px solid rgba(128,128,128,0.25)",
                      borderLeft: isCompacting
                        ? "1px solid rgba(239, 68, 68, 0.3)"
                        : autoCompactionEnabled
                          ? "1px solid rgba(59, 130, 246, 0.32)"
                          : "1px solid var(--border)",
                      borderRadius: onCompact ? "0 9px 9px 0" : 9,
                      color: autoCompactionEnabled ? "var(--accent, #3b82f6)" : "var(--text-muted)",
                      cursor: isCompacting ? "not-allowed" : "pointer",
                      fontSize: 12,
                      fontWeight: 600,
                      letterSpacing: "-0.01em",
                      transition: "background 0.12s, color 0.12s, border-color 0.15s",
                    }}
                    onMouseEnter={(e) => {
                      if (isCompacting) return;
                      e.currentTarget.style.background = "var(--bg-hover)";
                      e.currentTarget.style.color = "var(--text)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = autoCompactionEnabled ? "var(--bg-selected, rgba(59, 130, 246, 0.10))" : "none";
                      e.currentTarget.style.color = autoCompactionEnabled ? "var(--accent, #3b82f6)" : "var(--text-muted)";
                    }}
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, opacity: isCompacting || autoCompactionEnabled == null ? 0.6 : 1 }}>
                      {(!isMobile || controlsMenuOpen) && <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{runtimeSettingsRead?.status === "error" ? t("chat.runtimeSettingsRetry") : t("chat.autoCompaction")}</span>}
                      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      {autoCompactionEnabled
                        ? <polyline points="2.2 6.2 4.8 8.5 9.8 3.5" />
                        : <circle cx="6" cy="6" r="3.4" />}
                      </svg>
                    </span>
                  </button>
                )}
              </div>
            )}

            {(canStop || (continueUi && continueUi.kind === "running")) && onUnattendedChange && (
              <button
                onClick={onUnattendedChange}
                title={unattended ? t("chat.unattendedOnTitle") : t("chat.unattendedOffTitle")}
                aria-pressed={!!unattended}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: isMobile ? "8px 10px" : "8px 14px",
                  height: 32,
                  marginRight: isMobile ? 2 : 4,
                  background: unattended ? "rgba(16,185,129,0.12)" : "rgba(128,128,128,0.06)",
                  border: unattended ? "1px solid rgba(16,185,129,0.4)" : "1px solid rgba(128,128,128,0.25)",
                  borderRadius: 9,
                  color: unattended ? "#10b981" : "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 12, fontWeight: 600,
                  whiteSpace: "nowrap", letterSpacing: "-0.01em",
                  transition: "background 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = unattended ? "rgba(16,185,129,0.2)" : "rgba(128,128,128,0.12)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = unattended ? "rgba(16,185,129,0.12)" : "rgba(128,128,128,0.06)"; }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  {unattended
                    ? <><circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1.4" /><circle cx="5" cy="5" r="1.6" fill="currentColor" /></>
                    : <><circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1.4" /><circle cx="5" cy="5" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.1" /></>}
                </svg>
                {unattended ? t("chat.unattendedOn") : t("chat.unattended")}
              </button>
            )}

            {canStop && (
              <button
                onClick={onAbort}
                disabled={stopping}
                aria-label={t(stopping ? "chat.stoppingAllLabel" : "chat.stopAllLabel")}
                title={t("chat.stopAllDescription")}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: isMobile ? "8px 10px" : "8px 14px",
                  height: 32,
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.3)",
                  borderRadius: 9,
                  color: "#ef4444",
                  cursor: "pointer",
                  fontSize: 12, fontWeight: 600,
                  whiteSpace: "nowrap", letterSpacing: "-0.01em",
                  transition: "background 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.16)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
                </svg>
                 {t(stopping ? "chat.stoppingAll" : "chat.stopAll")}
              </button>
            )}


            {isMobile && controlsMenuOpen && (
              <button
                type="button"
                 title={t("chat.collapseControls")}
                 aria-label={t("chat.collapseControls")}
                aria-expanded={true}
                onClick={() => {
                  setToolDropdownOpen(false);
                  setThinkingDropdownOpen(false);
                  setControlsMenuOpen(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 36,
                  height: 32,
                  padding: 0,
                  marginLeft: 2,
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border)",
                  borderRadius: 9,
                  color: "var(--text)",
                  cursor: "pointer",
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-selected)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
            </div>
          </div>

        </div>
      </div>
    </fieldset>
  );
});
