"use client";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import { ChevronDown, ChevronUp, CornerDownLeft, X, GitFork, Trash2 } from "lucide-react";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, BashExecutionMessage, BlockingExtensionUiRequest, ExtensionUiRequest, SessionInfo, SessionTreeNode, ToolResultMessage, UserMessage } from "@/lib/types";
import { normalizeCustomPanelLines, parseAnsiLine, stripAnsi, TUI_CURSOR_MARKER } from "@/lib/ansi";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { copyText } from "@/lib/clipboard";
import { countToolCallBlocks, getAssistantErrorMessage, getDisplayableAssistantBlocks, hasAssistantAnswer, splitFinalAssistantBlocks, splitLiveTailItems } from "@/lib/message-display";
import { summarizeTurnUsage, type TurnUsage } from "@/lib/turn-usage";
import { findFinalAssistantIndex, isCompactionMessage, isResponseTurnAnchor } from "@/lib/response-duration";
import { analyzeTurns, summarizeTurns, timingPercent, type TurnActivity } from "@/lib/session-timing";
import { extractTurnWrittenFiles, type WrittenFile } from "@/lib/turn-written-files";
import { getFinalAnswerViews, keepWrittenFiles, withAssistantBlocks, type FinalAnswerViews } from "@/lib/turn-views";
import { MarkdownBody } from "./MarkdownBody";
import { MessageView } from "./MessageView";
import { ProcessDetailsGroup } from "./ProcessDetailsGroup";
import { isSubagentWakeMessage } from "@/lib/session-hover-preview";
import { summarizeTurnResources, type TurnResources } from "@/lib/turn-resources";
import { buildActivePath, findLatestLeafId, formatSideBranchTitle } from "./BranchNavigator";
import { SIDEKICK_RIGHT_PANEL_TARGET_ID, SidekickDrawer } from "./SidekickDrawer";
import { flushSideAskPromotions, queueSideAskPromotion } from "@/lib/side-ask-promotion";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { sessionDraftKey } from "@/lib/draft-store";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { ExtensionStatusBar } from "./ExtensionStatusBar";
import { NoticeShelf } from "./NoticeShelf";
import { useI18n } from "@/hooks/useI18n";
import { phaseLabel } from "@/lib/chat-phase-label";
import type { SettingsSection } from "@/lib/settings-navigation";
import { clampSelectionToolbarTop, isQuoteShortcut, loadStoredQuoteShortcut, QUOTE_SHORTCUT_CHANGED_EVENT, type QuoteContextItem } from "@/lib/quote-context";
import { QuoteAnnotationModal } from "./QuoteAnnotationModal";
import { TranscriptHighlights, type QuoteHighlight } from "./TranscriptHighlights";
import { EMBEDDED_QUOTE_ANNOTATION_EVENT, EMBEDDED_QUOTE_ANNOTATION_RESULT_EVENT, EMBEDDED_QUOTE_ANNOTATION_CLOSE_EVENT, EMBEDDED_QUOTE_ANNOTATION_DELETE_EVENT } from "@/lib/embedded-modal";
import { useAgentSession, type SessionForkResult } from "@/hooks/useAgentSession";
import { selectHasStreamingContent, selectIsStreaming, selectStreamingMessage, useStreamingSelector } from "@/hooks/useStreamingSelector";
import type { StreamingStore } from "@/lib/streaming-message";
import { fetchSessionHistory } from "@/lib/session-history-controller";
import { readHistoryEditMessage, type HistoryEditIntent } from "@/lib/history-edit-message";
import { historySearchSegment, type LocatedHistoryMatch } from "@/lib/history-search-segment";
import { hideRetriedErrors, readHiddenRetryErrors, rememberHiddenRetryError, retryDisplayScope } from "@/lib/retry-display-state";
import { occurrenceId, transcriptView, isTranscriptPlaceholder } from "@/lib/transcript-store";
import { compareOrderKeys } from "@/lib/transcript-order";
import type { TranscriptReader } from "@/lib/transcript-reader";
import { scrollSessionSearchTarget } from "@/lib/session-search-dom";
import type { HistoryContentPage, HistoryNode, HistoryProcessRange } from "@/lib/session-history-types";
import { shouldShowContinueForActivityStatus } from "@/lib/session-activity-status";
import type { SessionExecutionState } from "@/lib/session-execution";
import { statusSoundRequestId, tryPlaySoundRequest, useAudio, type SoundKey, waitSoundRequestId, wasSessionDialogRecentlyInteracted } from "@/hooks/useAudio";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useChatAppearance } from "@/hooks/useChatAppearance";
import { useScrollbarVisibility } from "@/hooks/useScrollbarVisibility";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { ImageGenerationCost } from "@/lib/image-generation-cost";
import type { RuntimeInspection } from "@/lib/runtime-inspection";
import type { ToolEntry } from "@/lib/tool-presets";
import { getFileName } from "@/lib/file-paths";
import { clearSessionActivityCache, fetchSessionActivity } from "@/lib/session-activity-fetch";
import { apiPathForPeer } from "@/lib/file-api";
import { isSessionControlDisplayMessage, splitProcessRenderSegments } from "@/lib/process-render-segments";
import { visibleMarkdownText } from "@/lib/session-search-text";
import {
  getExtensionDialogInputCompositionEndAtOnBlur,
  handleExtensionDialogEscape,
  handleExtensionDialogInputKeyDown,
  isForeignNativeModalOwner,
} from "@/lib/extension-dialog-keyboard";
import type { AppUpdateResponse } from "@/lib/api-types";
import type { WorktreeBindingDraft } from "@/lib/worktree-bindings";
import type { QuestionAnalysisJobView, QuestionDraftView } from "@/lib/question-analysis-jobs";
import {
  getMessageRowKey,
  getPromptAnchorSpacerHeight,
} from "@/lib/chat-lazy-load";

const CHAT_HISTORY_PRELOAD_DISTANCE = 320;

interface Props {
  session: SessionInfo | null;
  sessionRunning?: boolean;
  newSessionCwd: string | null;
  newSessionSubprojectId?: string | null;
  newSessionContextSourceId?: string | null;
  newSessionWorktreeBinding?: WorktreeBindingDraft | null;
  newSessionPrefill?: string | null;
  newSessionDraftKey: string | null;
  onAgentEnd?: (serverRunId?: string) => void;
  onAgentError?: (serverUnattended?: boolean, serverRunId?: string) => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest) => void;
  onSessionCreated?: (session: SessionInfo, sourceDraftKey: string) => void;
  background?: boolean;
  onSessionReady?: (busy: boolean) => void;
  onSessionForked?: (result: SessionForkResult) => void;
  restoreMessage?: UserMessage | null;
  onRestoreMessageApplied?: () => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onChatInputReady?: () => void;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void, locked: boolean) => void;
  onOpenSettings?: (section: SettingsSection) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  /** The live tool declarations owned by this session. */
  onSystemToolsChange?: (tools: ToolEntry[] | null) => void;
  onRuntimeInspectionChange?: (inspection: RuntimeInspection | null) => void;
  onSystemPromptLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  sessionStatsRefreshRef?: { current: (() => Promise<void>) | null };
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onOpenFile?: (filePath: string) => void;
  /** Optional QA probe for counting production component renders. */
  renderProbe?: (component: "ChatWindow" | "MessageView" | "StreamingReply", entryId?: string, streaming?: boolean) => void;
  /** Search term to locate inside the loaded conversation (from session search). */
  highlightTerm?: string | null;
  /** Completion sound state + controls, owned by AppShell so tasks finishing in
   *  a non-active workspace can still ring. */
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  playDoneSound?: () => void | Promise<boolean>;
  canPlaySound?: (key: SoundKey) => boolean;
  unlockAudio?: () => void;
  /** Reader local patch: operate a session living on another device via the
   *  /api/remote proxy (aggregate full-device view). */
  remotePeer?: string;
  /** Reader: device name shown next to the project in the brand row (top bar
   * owns the device name in the status bar; this is the in-chat label). */
  deviceName?: string;
  onOpenRelatedSession?: (device: { id: string; name: string; url?: string }, sessionId: string) => void;
  /** Full Monitor iframe delegates status sounds to its outer activity panel. */
  statusSoundOwner?: "chat" | "activity";
  /** Forked/subagent sessions never own user-facing sound or attention cues. */
  suppressStatusSounds?: boolean;
  /** Shell-owned sidekick state for the active workspace. */
  sidekickOpen?: boolean;
  /** Show the same sidekick state inside the shell's resizable right panel. */
  sidekickRightPanelOpen?: boolean;
  onToggleSidekick?: () => void;
  onCloseSidekickRightPanel?: () => void;
  onSidekickCountChange?: (count: number) => void;
  quoteSelectionEnabled?: boolean;
  onSelectionToolbarChange?: (actions: SelectionToolbarActions | null) => void;
}

export interface SelectionToolbarActions {
  askCurrent: () => void;
  askSidekick: () => void;
  dismiss: () => void;
}

export interface SelectionToolbarLabels {
  askInCurrent: string;
  askInSidekick: string;
  close: string;
}

export function SelectionToolbarButtons({
  actions,
  labels,
  compact = false,
}: {
  actions: SelectionToolbarActions;
  labels: SelectionToolbarLabels;
  compact?: boolean;
}) {
  const actionPadding = compact ? "4px 6px" : "4px 10px";
  return (
    <>
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={actions.askCurrent}
        aria-label={labels.askInCurrent}
        title={labels.askInCurrent}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: compact ? 0 : 5,
          padding: actionPadding,
          borderRadius: 5,
          border: "none",
          background: "var(--bg-selected, rgba(59, 130, 246, 0.1))",
          color: "var(--accent, #3b82f6)",
          cursor: "pointer",
          fontWeight: 600,
          fontSize: 12,
        }}
      >
        <span style={{ fontSize: 14 }} aria-hidden="true">@</span>
        {!compact && <span>{labels.askInCurrent}</span>}
      </button>
      <button
        type="button"
        data-sidekick-interaction="true"
        onMouseDown={(event) => event.preventDefault()}
        onClick={actions.askSidekick}
        aria-label={labels.askInSidekick}
        title={labels.askInSidekick}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: compact ? 0 : 5,
          padding: actionPadding,
          borderRadius: 5,
          border: "none",
          background: "var(--bg-panel, #f3f4f6)",
          color: "var(--text, #374151)",
          cursor: "pointer",
          fontWeight: 600,
          fontSize: 12,
        }}
      >
        <GitFork size={13} strokeWidth={2} aria-hidden="true" />
        {!compact && <span>{labels.askInSidekick}</span>}
      </button>
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={actions.dismiss}
        aria-label={labels.close}
        title={labels.close}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 24,
          height: 24,
          borderRadius: 4,
          border: "none",
          background: "transparent",
          color: "var(--text-muted, #9ca3af)",
          cursor: "pointer",
        }}
      >
        <X size={13} aria-hidden="true" />
      </button>
    </>
  );
}

interface SideBranchTab {
  tabId: string;
  title: string;
  anchorLeafId: string;
  currentLeafId?: string;
  beforeEntryId?: string;
  createdAt: number;
  anchorSnippet?: string;
}


const CHAT_MINIMAP_WIDTH = 36;
const CHAT_COLUMN_PADDING = 16;

function NewSessionUpdateLink({
  label,
  text,
}: {
  label: (version: string) => string;
  text: (version: string) => string;
}) {
  const [update, setUpdate] = useState<AppUpdateResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/app-update", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<AppUpdateResponse>;
      })
      .then((result) => {
        if (result?.updateAvailable && result.latestVersion && result.releaseUrl) {
          setUpdate(result);
        }
      })
      .catch(() => {
        // Update checks are best-effort and must not interrupt a new session.
      });
    return () => controller.abort();
  }, []);

  if (!update) return null;
  const accessibleLabel = label(update.latestVersion);

  return (
    <a
      href={update.releaseUrl}
      target="_blank"
      rel="noopener noreferrer"
      title={accessibleLabel}
      aria-label={accessibleLabel}
      onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        minWidth: 0,
        padding: "0 4px",
        background: "transparent",
        borderRadius: 5,
        color: "var(--accent)",
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1.4,
        textDecoration: "none",
        transition: "background 0.12s",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{text(update.latestVersion)}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
        <path d="M7 17 17 7" />
        <path d="M7 7h10v10" />
      </svg>
    </a>
  );
}

function getUserInputText(message: AgentMessage): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text.length > 0 ? text : null;
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

function getLatestUserMessageKey(messages: AgentMessage[], entryIds: string[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = getUserInputText(message) ?? "";
    return `user:${message.timestamp ?? entryIds[index] ?? index}:${text}`;
  }
  return null;
}

function hasAssistantOutputAfterLatestUser(messages: AgentMessage[]): boolean {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) return false;
  return messages.slice(latestUserIndex + 1).some((message) => (
    message?.role === "assistant"
    && message.stopReason !== "error"
    && message.stopReason !== "aborted"
    && !message.errorMessage
    && message.content.some((block) => (
      (block.type === "text" && block.text.trim() !== "") || block.type === "toolCall"
    ))
  ));
}

function countToolCalls(messages: AgentMessage[], indices: number[]): number {
  let count = 0;
  for (const idx of indices) {
    const msg = messages[idx];
    if (msg?.role !== "assistant") continue;
    count += countToolCallBlocks(getDisplayableAssistantBlocks(msg as AssistantMessage));
  }
  return count;
}

function hasDisplayableProcessMessage(message: AgentMessage, process = false): boolean {
  if (process || isTranscriptPlaceholder(message)) return true;
  if (message.role === "assistant") {
    return getDisplayableAssistantBlocks(message as AssistantMessage).length > 0;
  }
  return message.role === "custom" || message.role === "toolResult" || message.role === "bashExecution";
}

const QUOTE_BLOCK_TAGS = new Set([
  "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE", "FOOTER", "FORM",
  "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION",
  "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

function quoteBlockAncestor(element: Element, root: Element): Element {
  let current: Element | null = element;
  while (current && current !== root) {
    if (QUOTE_BLOCK_TAGS.has(current.tagName)) return current;
    current = current.parentElement;
  }
  return root;
}

function quoteNodeRanges(affectedNodes: { node: Text; startInNode: number; endInNode: number }[]): Range[] {
  return affectedNodes.map(({ node, startInNode, endInNode }) => {
    const range = node.ownerDocument.createRange();
    range.setStart(node, startInNode);
    range.setEnd(node, endInNode);
    return range;
  });
}

function findQuoteHighlights(container: HTMLElement, quotes: QuoteContextItem[]): QuoteHighlight[] {
  const highlights: QuoteHighlight[] = [];
  if (quotes.length === 0) return highlights;

  const allMessageRows = Array.from(container.querySelectorAll<HTMLElement>("[data-chat-message-row]"));
  const fallbackRoots = allMessageRows.length > 0 ? allMessageRows : [container];

  quotes.forEach((quote, quoteIndex) => {
    const rawTargetText = quote.text.trim();
    if (!rawTargetText) return;

    let rootsToSearch = fallbackRoots;
    if (quote.sourceEntryId) {
      const specific = allMessageRows.filter((row) => row.getAttribute("data-entry-id") === quote.sourceEntryId);
      if (specific.length > 0) rootsToSearch = specific;
    }

    const cleanText = rawTargetText;
    const lines = cleanText.split("\n").map((l) => l.trim()).filter(Boolean);
    const firstLine = lines[0] || cleanText;
    const lastLine = lines[lines.length - 1] || cleanText;
    const startSnippet = (quote.startSnippet || (firstLine.length > 25 ? firstLine.slice(0, 25).trim() : firstLine)).trim();
    const endSnippet = (quote.endSnippet || (lastLine.length > 25 ? lastLine.slice(-25).trim() : lastLine)).trim();

    for (const root of rootsToSearch) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes: { node: Text; start: number; end: number }[] = [];
      let combined = "";
      let lastBlockParent: Element | null = null;

      while (walker.nextNode()) {
        const t = walker.currentNode as Text;
        const parent = t.parentElement;
        const text = t.textContent ?? "";
        if (!text) continue;
        const blockParent = quoteBlockAncestor(parent ?? root, root);
        // Markdown 内联元素（strong/code/em）不能制造伪换行；只有跨渲染块容器才分隔文本。
        if (lastBlockParent && lastBlockParent !== blockParent) {
          if (!/\s$/.test(combined) && !/^\s/.test(text)) {
            combined += "\n";
          }
        }
        lastBlockParent = blockParent;
        const start = combined.length;
        combined += text;
        nodes.push({ node: t, start, end: combined.length });
      }

      if (nodes.length === 0) continue;

      let matched = false;

      // Strategy 1: Exact substring in combined
      let matchStart = combined.indexOf(rawTargetText);
      let matchEnd = matchStart !== -1 ? matchStart + rawTargetText.length : -1;

      // Strategy 2: Whitespace-normalized match in combined
      if (matchStart === -1) {
        const normTarget = rawTargetText.replace(/\s+/g, " ");
        const normCombined = combined.replace(/\s+/g, " ");
        const normIdx = normCombined.indexOf(normTarget);
        if (normIdx !== -1) {
          let cIdx = 0;
          let nIdx = 0;
          let foundStart = -1;
          let foundEnd = -1;
          while (cIdx < combined.length) {
            if (nIdx === normIdx && foundStart === -1) {
              foundStart = cIdx;
            }
            if (nIdx === normIdx + normTarget.length) {
              foundEnd = cIdx;
              break;
            }
            if (/\s/.test(combined[cIdx])) {
              while (cIdx < combined.length && /\s/.test(combined[cIdx])) cIdx++;
              nIdx++;
            } else {
              cIdx++;
              nIdx++;
            }
          }
          if (foundStart !== -1) {
            matchStart = foundStart;
            matchEnd = foundEnd !== -1 ? foundEnd : combined.length;
          }
        }
      }

      if (matchStart !== -1 && matchEnd > matchStart) {
        const affectedNodes: { node: Text; startInNode: number; endInNode: number }[] = [];
        for (const item of nodes) {
          const s = Math.max(matchStart, item.start);
          const e = Math.min(matchEnd, item.end);
          if (s < e) {
            affectedNodes.push({
              node: item.node,
              startInNode: s - item.start,
              endInNode: e - item.start,
            });
          }
        }

        if (affectedNodes.length > 0) {
          highlights.push({ quote, quoteIndex, ranges: quoteNodeRanges(affectedNodes) });
          matched = true;
        }
      }

      // Strategy 3: Prefix & Suffix Boundary Matching (Cross-block, code blocks, lists, headers)
      if (!matched && startSnippet && endSnippet) {
        let startNodeIdx = -1;
        let startNodeOffset = -1;
        let endNodeIdx = -1;
        let endNodeOffset = -1;

        for (let i = 0; i < nodes.length; i++) {
          const text = nodes[i].node.textContent ?? "";
          const idx = text.indexOf(startSnippet);
          if (idx !== -1) {
            startNodeIdx = i;
            startNodeOffset = idx;
            break;
          }
          const subSnippet = startSnippet.slice(0, 10);
          const subIdx = text.indexOf(subSnippet);
          if (subIdx !== -1) {
            startNodeIdx = i;
            startNodeOffset = subIdx;
            break;
          }
        }

        const searchFrom = startNodeIdx !== -1 ? startNodeIdx : 0;
        for (let i = nodes.length - 1; i >= searchFrom; i--) {
          const text = nodes[i].node.textContent ?? "";
          const idx = text.indexOf(endSnippet);
          if (idx !== -1) {
            endNodeIdx = i;
            endNodeOffset = idx + endSnippet.length;
            break;
          }
          const subSnippet = endSnippet.slice(-10);
          const subIdx = text.indexOf(subSnippet);
          if (subIdx !== -1) {
            endNodeIdx = i;
            endNodeOffset = subIdx + subSnippet.length;
            break;
          }
        }

        if (startNodeIdx !== -1 && endNodeIdx !== -1 && startNodeIdx <= endNodeIdx) {
          const affectedNodes: { node: Text; startInNode: number; endInNode: number }[] = [];
          for (let i = startNodeIdx; i <= endNodeIdx; i++) {
            const text = nodes[i].node.textContent ?? "";
            const s = (i === startNodeIdx) ? startNodeOffset : 0;
            const e = (i === endNodeIdx) ? Math.min(text.length, endNodeOffset) : text.length;
            if (s < e) {
              affectedNodes.push({
                node: nodes[i].node,
                startInNode: s,
                endInNode: e,
              });
            }
          }

          if (affectedNodes.length > 0) {
            highlights.push({ quote, quoteIndex, ranges: quoteNodeRanges(affectedNodes) });
            matched = true;
          }
        }
      }

      if (matched) break;
    }
  });
  return highlights;
}

function HistorySearchContent({ content, match, label }: { content: HistoryContentPage | null; match: LocatedHistoryMatch | null; label: string }) {
  const segment = historySearchSegment(content, match);
  if (!segment || !content) return null;
  return (
    <section data-history-search-segment="true" data-session-search-exclude="true" data-history-entry-id={match?.entryId}
      aria-label={label} style={{ margin: "8px 0", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 6 }}>
      <div style={{ color: "var(--text-muted)", fontSize: 11 }}>{label}: {content.offset}–{content.offset + content.text.length} / {content.totalChars}</div>
      <pre style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "inherit" }}>
        {segment.before}<mark data-history-search-target={segment.key}>{segment.hit}</mark>{segment.after}
      </pre>
    </section>
  );
}

export function ChatWindow({ session, sessionRunning, newSessionCwd, newSessionSubprojectId, newSessionContextSourceId, newSessionWorktreeBinding, newSessionPrefill, newSessionDraftKey, onAgentEnd, onAgentError, onAttentionNeeded, onSessionCreated, onSessionForked, restoreMessage, onRestoreMessageApplied, modelsRefreshKey, chatInputRef, onChatInputReady, onBranchDataChange, onSystemPromptChange, onSystemToolsChange, onRuntimeInspectionChange, onSystemPromptLoaderChange, onSessionStatsChange, onSessionStatsPanelOpen, sessionStatsRefreshRef, onOpenSettings, onContextUsageChange, onOpenFile, renderProbe, background = false, onSessionReady, highlightTerm = null, soundEnabled = true, onSoundToggle, playDoneSound = () => {}, canPlaySound: canPlaySoundProp = () => false, unlockAudio, remotePeer, deviceName, statusSoundOwner = "chat", suppressStatusSounds = false, sidekickOpen, sidekickRightPanelOpen = false, onToggleSidekick, onCloseSidekickRightPanel, onSidekickCountChange, quoteSelectionEnabled: quoteSelectionEnabledProp, onSelectionToolbarChange }: Props) {
  renderProbe?.("ChatWindow");
  const { t } = useI18n();
  useChatAppearance();
  // Reader: wait/error sounds stay local to the ChatWindow instance (deduped
  // by request id); completion sound ownership moved up to AppShell (upstream #417).
  const { playErrorSound, playWaitSound, canPlaySound: canPlayLocalSound } = useAudio();
  const isMobile = useIsMobile();
  const ownsStatusSounds = statusSoundOwner === "chat" && !suppressStatusSounds;
  const ownsCompletionSound = ownsStatusSounds && !background;

  // Wrap onAgentEnd to play the completion sound. This is more reliable than
  // wrapping handleAgentEventRef because useAgentSession overwrites that ref
  // on every render (it syncs the latest callback), which would blow away an
  // externally-installed wrapper after the first re-render.
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const playErrorSoundRef = useRef(playErrorSound);
  playErrorSoundRef.current = playErrorSound;
  const playWaitSoundRef = useRef(playWaitSound);
  playWaitSoundRef.current = playWaitSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  // 最后消息快照：完成音触发前判定是否失败轮次（agent_settled/prompt_done 在
  // 失败与自动重试路径同样会发，若最后 assistant 消息是 error 则改由错误音负责，
  // 不再播完成音）。
  const tailMessagesRef = useRef<AgentMessage[] | null>(null);
  const liveTailSessionRef = useRef<string | null>(null);
  const [waitSoundRetry, setWaitSoundRetry] = useState(0);
  // 无人值守开启期间失败一律静音（错误仍正常显示在界面），不再播报失败音；
  // 仅手动模式（未开无人值守）的失败照常播报。
  const unattendedRef = useRef(false);
  const wrappedOnAgentEnd = useCallback((serverRunId?: string) => {
    if (soundEnabledRef.current && ownsCompletionSound) {
      const tail = tailMessagesRef.current;
      let last = tail?.[tail.length - 1];
      // Display-only custom messages (for example Honcho memory) may trail
      // the failed assistant in the rendered transcript.
      for (let index = (tail?.length ?? 0) - 1; index >= 0 && last?.role === "custom"; index -= 1) {
        last = tail?.[index - 1];
      }
      const lastFailed = last?.role === "assistant"
        && (last.stopReason === "error" || Boolean(last.errorMessage));
      const lastAborted = last?.role === "assistant" && last.stopReason === "aborted";
      if (!lastFailed) {
        // SDK 1.1 reports a stopped turn on agent_settled; do not let a
        // terminal callback from that turn claim the success sound.
        if (!lastAborted) {
          const soundKey = statusSoundRequestId(session?.id, "done", serverRunId);
          if (soundKey) {
            tryPlaySoundRequest(
              soundKey,
              () => {
                const result = playDoneSoundRef.current();
                return result instanceof Promise ? result.then((played) => played !== false) : Promise.resolve(true);
              },
              () => canPlaySoundProp("done"),
            );
          }
        }
      }
    }
    onAgentEnd?.(serverRunId);
  }, [canPlaySoundProp, onAgentEnd, ownsCompletionSound, session?.id]);

  // 失败轮次可能同时经 agent_end(error) 与 prompt_error 触发两次错误音，
  // 同一 server run claim key 内去重；无人值守开启期间失败一律静音。
  const wrappedOnAgentError = useCallback((serverUnattended?: boolean, serverRunId?: string) => {
    onAgentError?.(serverUnattended, serverRunId);
    if (!ownsStatusSounds || !soundEnabledRef.current || (serverUnattended ?? unattendedRef.current)) return;
    const soundKey = statusSoundRequestId(session?.id, "error", serverRunId);
    if (soundKey) tryPlaySoundRequest(soundKey, playErrorSoundRef.current, () => canPlayLocalSound("error"));
  }, [canPlayLocalSound, onAgentError, ownsStatusSounds, session?.id]);

  const historyControllerRef = useRef<TranscriptReader | null>(null);
  const historyEditAbortRef = useRef<AbortController | null>(null);
  const retryDisplayScopeRef = useRef("");
  retryDisplayScopeRef.current = retryDisplayScope(session?.id ?? "", remotePeer ?? null);
  const [retryHidden, setRetryHidden] = useState<{ scope: string; ids: Set<string> } | null>(null);
  const {
    data, activeLeafId, loading, error, history, reader, retrySessionRead, questionAnalysisJobs, questionDraftViews, streamingStore,
    systemTools,
    agentRunning, sessionStatePending, bashRunning, pendingBash, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, toolPreset, thinkingLevel, fastMode,
    handleFastModeChange,
    retryInfo, contextUsage, forkingEntryId,
    continueUi, unattended, toggleUnattended, triggerContinue, stopAutoRetry,
    isCompacting, compactError, compactResult, autoCompactionEnabled, runtimeSettingsRead, retryRuntimeSettings, displayModel: displayModelValue, modelSwitching, runtimeSettingsUpdating, sessionStats,
    messageCosts,
    imageGenerationCosts,
    compactionCosts, compactionContexts,
    slashCommands, slashCommandsLoading, slashCommandsReloadKey, queuedMessages,
    notices, addNotice, setNoticesHovered, dismissNotices, hasUnconfirmedPrompt, extensionDialog, waitingExtensionDialogCount, extensionCustomUi, waitingExtensionCustomUiCount, extensionStatuses, extensionWidgets, editorSuggestion, respondToExtensionUi, sendExtensionCustomInput, closeExtensionCustomUi,
    isAutoModelSelection,
    defaultModel, savedDefaultThinkingLevel, editEntryId, cancelEdit,
    activeToolResults,
    agentPhase,
    isNew,
    sessionIdRef, scrollContainerRef,
    lastUserMsgRef, promptAnchorActive,
    handleSend: handleSessionSend, handleFork, handleNavigate, handleLeafChange: handleSessionLeafChange, handleModelChange, ensureSession,
    handleEditContent: handleSessionEditContent, restoreLegacyHistoryEdit, handleSetDefaultModel, handleSetDefaultThinkingLevel,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction, handleAutoCompactionChange,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleToolPresetChange, handleThinkingLevelChange, loadSlashCommands, scrollUserMsgToTop,
    showScrollToBottom, scrollToBottom, scrollToMessage,
    follow, setFollow, viewport,
  } = useAgentSession({
    session, sessionRunning, background, newSessionCwd, newSessionSubprojectId, newSessionContextSourceId, newSessionWorktreeBinding, newSessionDraftKey, onAgentEnd: wrappedOnAgentEnd, onAgentError: wrappedOnAgentError, onAttentionNeeded, onSessionCreated, onSessionReady: background ? onSessionReady : undefined, onSessionForked,
    modelsRefreshKey, chatInputRef, onSystemPromptChange, onSystemToolsChange, onRuntimeInspectionChange, onSystemPromptLoaderChange, onSessionStatsPanelOpen, sessionStatsRefreshRef,
    remotePeer, onOpenSettings,
    onRetryContinueStarted: ({ sessionId, peer, entryId }) => {
      const scope = retryDisplayScope(sessionId, peer);
      if (retryDisplayScopeRef.current !== scope || !entryId) return;
      rememberHiddenRetryError(scope, entryId);
      setRetryHidden((previous) => ({ scope, ids: new Set([...(previous?.scope === scope ? previous.ids : readHiddenRetryErrors(scope)), entryId]) }));
    },

  });

  const composerDraftKey = useMemo(
    () => session?.id ? sessionDraftKey(session.id, remotePeer) : newSessionDraftKey ?? undefined,
    [session?.id, remotePeer, newSessionDraftKey],
  );
  historyControllerRef.current = reader;
  const historyScopeReady = Boolean(history.requestedScope?.sessionId);
  const transcript = history.transcript;
  const atLiveTail = transcript.after === null;
  const view = useMemo(() => transcriptView(transcript), [transcript]);
  const retryScope = retryDisplayScope(session?.id ?? "", remotePeer ?? null);
  const visibleHistory = useMemo(() => hideRetriedErrors(view,
    retryHidden?.scope === retryScope ? retryHidden.ids : readHiddenRetryErrors(retryScope)), [view, retryHidden, retryScope]);
  const messages = visibleHistory.messages;
  const entryIds = visibleHistory.entryIds;
  const hasEarlierMessages = transcript.before !== null;
  const historyLoading = history.phase === "loading";
  const historyNodes = useMemo(() => {
    const nodes = new Map<number, HistoryNode>();
    for (const page of history.index.pages) for (const node of page.nodes) nodes.set(node.nodeIndex, node);
    return [...nodes.values()].sort((left, right) => left.nodeIndex - right.nodeIndex);
  }, [history.index.pages]);
  const historyNodeCount = Math.max(transcript.nodeCount, history.index.current?.total ?? 0);
  useEffect(() => {
    if (!transcript.loaded) return;
    const last = historyNodes.at(-1);
    const hasNewQuestion = messages.some((message, index) => {
      const key = transcript.items.get(entryIds[index])?.orderKey;
      return message.role === "user" && key && (!last || compareOrderKeys(key, last.orderKey) > 0);
    });
    if (historyNodes.length < transcript.nodeCount || hasNewQuestion) void reader.loadFullIndex();
  }, [reader, transcript.loaded, transcript.nodeCount, transcript.items, historyNodes, messages, entryIds]);
  useEffect(() => () => { historyEditAbortRef.current?.abort(); }, [reader, remotePeer, session?.id, history.requestedScope?.leafId]);
  const beginHistoryReading = useCallback(() => { setFollow(false); }, [setFollow]);
  const revealLatestHistory = useCallback(async () => {
    if (reader.getState().transcript.after !== null) await reader.reset();
    else await reader.reconcileTail();
    scrollToBottom("auto");
  }, [reader, scrollToBottom]);
  const handleLeafChange = useCallback(async (leafId: string | null, beforeEntryId?: string): Promise<boolean> => {
    const owner = retryDisplayScopeRef.current;
    const changed = await handleSessionLeafChange(leafId, beforeEntryId);
    if (retryDisplayScopeRef.current !== owner || !changed) return false;
    scrollToBottom("auto");
    return true;
  }, [handleSessionLeafChange, scrollToBottom]);
  const handleSend = useCallback(async (...args: Parameters<typeof handleSessionSend>) => {
    if (reader.getState().transcript.after !== null && !await reader.reset()) return;
    setFollow(true);
    await handleSessionSend(...args);
  }, [handleSessionSend, reader, setFollow]);

  unattendedRef.current = unattended;

  // 供 wrappedOnAgentEnd 判定最后消息是否失败轮次（render 期间写 ref 不触发重渲染）。
  tailMessagesRef.current = transcript.messages;
  const questionAnalysisJobsByEntry = useMemo(
    () => new Map(questionAnalysisJobs.map((job: QuestionAnalysisJobView) => [job.targetEntryId, job])),
    [questionAnalysisJobs],
  );
  const questionDraftViewByEntry = useMemo(
    () => new Map<string, QuestionDraftView>(Object.entries(questionDraftViews ?? {})),
    [questionDraftViews],
  );

  useEffect(() => {
    if (!restoreMessage || !chatInputRef) return;
    const frame = requestAnimationFrame(() => {
      chatInputRef.current?.replaceMessage(restoreMessage);
      onRestoreMessageApplied?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [chatInputRef, onRestoreMessageApplied, restoreMessage]);

  useEffect(() => {
    if (!isNew || !newSessionPrefill || !chatInputRef) return;
    const frame = requestAnimationFrame(() => chatInputRef.current?.insertIfEmpty(newSessionPrefill));
    return () => cancelAnimationFrame(frame);
  }, [chatInputRef, isNew, newSessionPrefill]);


  // Aggregate activity keeps the transcript tail live, while composer and
  // stop controls belong to the parent RPC. Bash supports stopping, while
  // steer/follow_up handlers only apply to prompts and compaction.
  const parentPromptBusy = agentRunning || isCompacting;
  const parentAgentBusy = parentPromptBusy || bashRunning;
  const isStreaming = useStreamingSelector(streamingStore, selectIsStreaming);
  const hasStoreStreamingContent = useStreamingSelector(streamingStore, selectHasStreamingContent);
  const sessionBusy = Boolean(
    sessionRunning
      || agentRunning
      || bashRunning
      || isStreaming
      || isCompacting
  );
  const isTailAborted = useMemo(() => {
    if (sessionBusy || !messages.length) return false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === "custom") continue;
      if (m?.role === "assistant") {
        return m.stopReason === "aborted";
      }
      return false;
    }
    return false;
  }, [messages, sessionBusy]);

  // 异常运行检测：会话最近一次 run 状态为异常（unknown 服务中断 / failed
  // 失败 / aborted 中止）时，发送按钮默认合并为“继续”，让用户可续上上次
  // 任务；一旦输入新内容，按钮自动回到“发送”。状态由首屏加载和 SSE 驱动的运行
  // 状态变化触发一次查询，不保留后台周期请求。
  const [abnormalRun, setAbnormalRun] = useState(false);
  const [activeSideTabId, setActiveSideTabId] = useState<string>("main");
  const [sideTabs, setSideTabs] = useState<SideBranchTab[]>([]);
  const [sideBranchPending, setSideBranchPending] = useState(false);
  const sideBranchPendingRef = useRef(false);
  const latestLeafId = useMemo(
    () => findLatestLeafId(data?.tree ?? []) ?? activeLeafId,
    [activeLeafId, data?.tree],
  );
  // activeLeafId starts at null; expose it only after hydration so null stays an explicit root.
  const sidekickParentId = loading || sessionStatePending ? undefined : activeLeafId;
  const [localSidekickOpen, setLocalSidekickOpen] = useState(false);
  const sidekickIsOpen = sidekickOpen ?? localSidekickOpen;
  const sidekickRightPanelIsOpen = sidekickRightPanelOpen && Boolean(session);
  // Side Ask topics asked on a branch tab that has since become the main line are moved by the host; the drawer reloads once they are.
  const [sidekickHistoryRevision, setSidekickHistoryRevision] = useState(0);
  const settleSideAskPromotions = useCallback(async () => {
    if (!session?.id) return;
    let storage: Storage;
    try { storage = localStorage; } catch { return; }
    const moved = await flushSideAskPromotions({ storage, sessionId: session.id, remotePeer });
    if (moved > 0) setSidekickHistoryRevision((revision) => revision + 1);
  }, [remotePeer, session?.id]);
  useEffect(() => { void settleSideAskPromotions(); }, [settleSideAskPromotions, sidekickIsOpen, sidekickRightPanelIsOpen]);
  const closeSidekick = useCallback(() => {
    if (sidekickRightPanelIsOpen && onCloseSidekickRightPanel) onCloseSidekickRightPanel();
    else if (sidekickOpen && onToggleSidekick) onToggleSidekick();
    else setLocalSidekickOpen(false);
  }, [onCloseSidekickRightPanel, onToggleSidekick, sidekickOpen, sidekickRightPanelIsOpen]);

  useEffect(() => {
    if (sidekickOpen !== undefined || background) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setLocalSidekickOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [background, sidekickOpen]);

  // Initialize branch presentation state once per session.
  useEffect(() => {
    if (!session?.id) return;
    setActiveSideTabId("main");

    try {
      const storedTabs = localStorage.getItem(`pi-web:side-tabs:${session.id}`);
      if (storedTabs) {
        const parsed = JSON.parse(storedTabs) as SideBranchTab[];
        if (Array.isArray(parsed)) setSideTabs(parsed);
      } else {
        setSideTabs([]);
      }
    } catch (error) {
      void error;
      setSideTabs([]);
    }
  }, [session?.id]);

  // Keep side-tab pointers aligned with their selected branch. The main line is
  // derived from the newest timeline leaf and has no separate UI state.
  useEffect(() => {
    const currentTail = activeLeafId ?? ((entryIds && entryIds.length > 0) ? entryIds[entryIds.length - 1] : null);
    if (!currentTail || !session?.id || activeSideTabId === "main") return;

    setSideTabs((prev) => {
      const idx = prev.findIndex((t) => t.tabId === activeSideTabId);
      if (idx >= 0 && prev[idx].currentLeafId !== currentTail) {
        const updated = [...prev];
        let updatedTitle = updated[idx].title;
        if (messages && messages.length > 0) {
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            const text = getUserInputText(messages[i]);
            if (text) {
              updatedTitle = t("chat.sideTabTitleFromText", { text: text.slice(0, 14) });
              break;
            }
          }
        }
        updated[idx] = {
          ...updated[idx],
          currentLeafId: currentTail,
          beforeEntryId: undefined,
          title: updatedTitle,
        };
        try {
          localStorage.setItem(`pi-web:side-tabs:${session.id}`, JSON.stringify(updated));
        } catch (error) { void error; }
        return updated;
      }
      return prev;
    });
  }, [entryIds, activeLeafId, activeSideTabId, session?.id, messages, t]);


  const handleCreateSideBranch = useCallback(async (anchorEntryId?: string, previewText?: string, beforeEntryId?: string): Promise<boolean> => {
    if (sessionBusy || !session?.id || sideBranchPendingRef.current) return false;
    const currentTail = (entryIds && entryIds.length > 0) ? entryIds[entryIds.length - 1] : activeLeafId;
    const targetAnchor = anchorEntryId || currentTail;
    if (!targetAnchor) return false;

    sideBranchPendingRef.current = true;
    setSideBranchPending(true);
    try {
      if (!await handleLeafChange(targetAnchor, beforeEntryId)) {
        addNotice({ type: "error", message: "The in-page fork could not be created; the conversation was not changed." });
        return false;
      }

      const title = t("chat.sideTabTitleNumbered", { index: sideTabs.length + 1 });
      const anchorSnippet = previewText ? (previewText.trim().length > 25 ? previewText.trim().slice(0, 25) + "..." : previewText.trim()) : undefined;
      const newTab: SideBranchTab = {
        tabId: `side-${Date.now()}`,
        title,
        anchorLeafId: targetAnchor,
        currentLeafId: reader.getState().physicalScope?.leafId ?? targetAnchor,
        ...(beforeEntryId ? { beforeEntryId } : {}),
        createdAt: Date.now(),
        anchorSnippet,
      };
      const nextTabs = [...sideTabs, newTab];
      setSideTabs(nextTabs);
      try {
        localStorage.setItem(`pi-web:side-tabs:${session.id}`, JSON.stringify(nextTabs));
      } catch (error) { void error; }
      setActiveSideTabId(newTab.tabId);
      return true;
    } finally {
      sideBranchPendingRef.current = false;
      setSideBranchPending(false);
    }
  }, [activeLeafId, addNotice, entryIds, handleLeafChange, reader, session?.id, sessionBusy, sideTabs, t]);


  const historyEditBusyRef = useRef(sessionBusy);
  historyEditBusyRef.current = sessionBusy;
  const handleEditContent = useCallback(async (message: UserMessage, entryId: string, resetToRoot = false, intent?: HistoryEditIntent) => {
    const controller = historyControllerRef.current;
    const snapshot = controller?.getState();
    const physical = snapshot?.physicalScope;
    const scope = snapshot?.requestedScope;
    if (historyEditBusyRef.current || message.role !== "user" || !entryId || !controller || !snapshot || !physical || !scope) {
      addNotice({ type: "error", message: "The history message is not ready to edit" });
      return;
    }
    historyEditAbortRef.current?.abort();
    const abort = new AbortController();
    historyEditAbortRef.current = abort;
    const isCurrent = () => !abort.signal.aborted && !historyEditBusyRef.current && historyControllerRef.current === controller
      && controller.getState().requestedScope?.sessionId === scope.sessionId
      && controller.getState().requestedScope?.peer === scope.peer
      && controller.getState().requestedScope?.leafId === scope.leafId
      && controller.getState().requestedScope === scope;
    try {
      const original = await readHistoryEditMessage({ ...physical, entryId }, async (options) => {
        const page = await fetchSessionHistory(scope, { mode: "content", ...options }, abort.signal);
        return page.kind === "content" ? page : null;
      }, isCurrent, intent);
      if (!isCurrent()) return;
      if (!handleSessionEditContent(original, entryId, resetToRoot)) {
        addNotice({ type: "error", message: "The complete message could not be restored; the draft and branch were kept unchanged" });
      }
    } catch (error) {
      if (isCurrent()) addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [addNotice, handleSessionEditContent]);

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    if (sessionBusy || !session?.id || !leafId) return;

    const existing = sideTabs.find((tab) => tab.tabId === leafId || tab.currentLeafId === leafId || tab.anchorLeafId === leafId);
    const beforeEntryId = existing?.currentLeafId === leafId ? existing.beforeEntryId : undefined;
    const latestPath = latestLeafId ? buildActivePath(data?.tree ?? [], latestLeafId) : new Set<string>();
    if (leafId === latestLeafId || latestPath.has(leafId)) {
      setActiveSideTabId("main");
    } else {
      if (existing) {
        setActiveSideTabId(existing.tabId);
      } else {
        const newTab: SideBranchTab = {
          tabId: leafId,
          title: t("chat.sideTabTitleNumbered", { index: sideTabs.length + 1 }),
          anchorLeafId: leafId,
          currentLeafId: leafId,
          createdAt: Date.now(),
        };
        const next = [...sideTabs, newTab];
        setSideTabs(next);
        try {
          localStorage.setItem(`pi-web:side-tabs:${session.id}`, JSON.stringify(next));
        } catch (error) { void error; }
        setActiveSideTabId(newTab.tabId);
      }
    }
    void handleLeafChange(leafId, beforeEntryId);
  }, [data?.tree, handleLeafChange, latestLeafId, session?.id, sessionBusy, sideTabs, t]);

  useEffect(() => {
    if (
      !session?.id
      || activeSideTabId === "main"
      || !activeLeafId
      || !latestLeafId
      || activeLeafId !== latestLeafId
    ) return;

    const activeTab = sideTabs.find((tab) => tab.tabId === activeSideTabId);
    if (!activeTab || activeTab.anchorLeafId === activeLeafId) return;

    setActiveSideTabId("main");
    // The tab is leaving, so its Side Ask topics follow it onto the main line.
    try { queueSideAskPromotion(localStorage, session.id, activeSideTabId); } catch (error) { void error; }
    void settleSideAskPromotions();
    setSideTabs((prev) => {
      const next = prev.filter((tab) => tab.tabId !== activeSideTabId);
      if (next.length === prev.length) return prev;
      try {
        localStorage.setItem(`pi-web:side-tabs:${session.id}`, JSON.stringify(next));
      } catch (error) { void error; }
      return next;
    });
  }, [activeLeafId, activeSideTabId, latestLeafId, session?.id, settleSideAskPromotions, sideTabs]);

  useEffect(() => {
    onBranchDataChange?.(data?.tree ?? [], activeLeafId, handleBranchLeafChange, sessionBusy);
  }, [activeLeafId, data?.tree, handleBranchLeafChange, onBranchDataChange, sessionBusy]);

  useEffect(() => {
    return () => onBranchDataChange?.([], null, () => {}, false);
  }, [onBranchDataChange]);
  // 仅当最新用户消息真正变化时清除异常标志；custom/历史 hydration 不会伪装成新提问。
  const abnormalUserMessageKeyRef = useRef<string | null>(null);
  const sessionIdForAbnormal = session?.id ?? null;
  const latestUserMessageKey = useMemo(
    () => getLatestUserMessageKey(messages, entryIds),
    [entryIds, messages],
  );
  const hasCurrentTurnAssistantOutput = useMemo(
    () => hasAssistantOutputAfterLatestUser(messages),
    [messages],
  );

  const activityUrl = remotePeer
    ? `/api/remote/session-runs?scope=local&peer=${encodeURIComponent(remotePeer)}${session?.archived ? "&archived=1" : ""}`
    : `/api/session-runs?scope=local${session?.archived ? "&archived=1" : ""}`;
  const activityStatusRequestRef = useRef(0);
  const [execution, setExecution] = useState<SessionExecutionState | null>(null);
  const [activityActive, setActivityActive] = useState(false);
  const [stoppingExecution, setStoppingExecution] = useState(false);
  const executionScope = `${remotePeer ?? "local"}:${sessionIdForAbnormal ?? ""}`;
  const executionScopeRef = useRef(executionScope);
  executionScopeRef.current = executionScope;
  useEffect(() => { setExecution(null); setActivityActive(false); setStoppingExecution(false); }, [executionScope]);
  const canStopExecution = Boolean(sessionBusy || activityActive || execution?.active || continueUi.kind === "running");

  const abnormalSessionIdRef = useRef(sessionIdForAbnormal);
  useEffect(() => {
    if (abnormalSessionIdRef.current === sessionIdForAbnormal) return;
    abnormalSessionIdRef.current = sessionIdForAbnormal;
    abnormalUserMessageKeyRef.current = null;
    setAbnormalRun(false);
  }, [sessionIdForAbnormal]);

  const applyActivityStatus = useCallback((status: unknown, observed?: SessionExecutionState) => {
    setExecution(observed ?? null);
    setActivityActive(["running", "retrying", "waiting_user"].includes(String(status)));
    if (shouldShowContinueForActivityStatus(status)) {
      abnormalUserMessageKeyRef.current = latestUserMessageKey;
      setAbnormalRun(true);
      return;
    }
    // A normal/failed refresh is not enough to clear a latched recovery state:
    // an older response can race the terminal event. Clear only after a new
    // user turn or effective assistant output proves that the turn settled.
    if (abnormalUserMessageKeyRef.current !== latestUserMessageKey || hasCurrentTurnAssistantOutput) {
      abnormalUserMessageKeyRef.current = null;
      setAbnormalRun(false);
    }
  }, [hasCurrentTurnAssistantOutput, latestUserMessageKey]);

  const handleAbortSession = useCallback(async () => {
    if (!sessionIdForAbnormal || stoppingExecution) return;
    const scope = executionScopeRef.current;
    stopAutoRetry();
    setStoppingExecution(true);
    try {
      const response = await fetch(apiPathForPeer(remotePeer, `sessions/${encodeURIComponent(sessionIdForAbnormal)}/stop`), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const result = await response.json() as { stopped?: boolean; queuedCount?: number; errors?: string[]; error?: string };
      if (executionScopeRef.current !== scope) return;
      if (!response.ok || !result.stopped) throw new Error(result.error ?? (result.errors?.join(t("chat.errorSeparator")) || t("chat.stopAllPending")));
      abnormalUserMessageKeyRef.current = latestUserMessageKey;
      setAbnormalRun(true);
      setExecution(null);
      setActivityActive(false);
      if (result.queuedCount) addNotice({ type: "warning", message: t("chat.stoppedQueueRetained") });
    } catch (error) {
      if (executionScopeRef.current === scope) addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      clearSessionActivityCache(activityUrl);
      if (executionScopeRef.current === scope) setStoppingExecution(false);
    }
  }, [activityUrl, addNotice, latestUserMessageKey, remotePeer, sessionIdForAbnormal, stopAutoRetry, stoppingExecution, t]);

  const prevSessionBusyRef = useRef(sessionBusy);
  useEffect(() => {
    if (prevSessionBusyRef.current && !sessionBusy && !background && sessionIdForAbnormal) {
      const requestId = ++activityStatusRequestRef.current;
      clearSessionActivityCache(activityUrl);
      void fetchSessionActivity<{ sessions?: Array<{ session: { id: string }; status: string; execution?: SessionExecutionState }> }>(activityUrl, { force: true })
        .then((data) => {
          if (requestId !== activityStatusRequestRef.current || !data?.sessions) return;
          const item = data.sessions.find((entry) => entry.session?.id === sessionIdForAbnormal);
          if (item) applyActivityStatus(item.status, item.execution);
        })
        .catch(() => {
          // A failed refresh is not evidence that an abnormal session recovered.
        });
    }
    prevSessionBusyRef.current = sessionBusy;
  }, [activityUrl, applyActivityStatus, background, sessionIdForAbnormal, sessionBusy]);

  useEffect(() => {
    ++activityStatusRequestRef.current;
    if (background || !sessionIdForAbnormal) return;
    let cancelled = false;
    const check = () => {
      const requestId = ++activityStatusRequestRef.current;
      void fetchSessionActivity<{ sessions?: Array<{ session: { id: string }; status: string; execution?: SessionExecutionState }> }>(activityUrl, { force: true })
        .then((data) => {
          if (cancelled || requestId !== activityStatusRequestRef.current || !data?.sessions) return;
          const item = data.sessions.find((entry) => entry.session?.id === sessionIdForAbnormal);
          if (item) applyActivityStatus(item.status, item.execution);
        })
        .catch(() => {
          // A failed refresh is not evidence that an abnormal session recovered.
        });
    };
    check();
    const timer = window.setInterval(check, 15_000);
    return () => {
      cancelled = true;
      activityStatusRequestRef.current += 1;
      window.clearInterval(timer);
    };
  }, [activityUrl, applyActivityStatus, background, remotePeer, sessionIdForAbnormal, sessionRunning]);

  useEffect(() => {
    if (!abnormalRun) return;
    // History/custom hydration changes message count but not the user's latest turn.
    if (loading) return;
    if (sessionBusy) return;
    if (abnormalUserMessageKeyRef.current === null) {
      abnormalUserMessageKeyRef.current = latestUserMessageKey;
      return;
    }
    if (latestUserMessageKey !== abnormalUserMessageKeyRef.current) {
      abnormalUserMessageKeyRef.current = latestUserMessageKey;
      setAbnormalRun(false);
    }
  }, [abnormalRun, latestUserMessageKey, loading, sessionBusy]);


  // 等待音按稳定 requestId claim，跨 ChatWindow/标签页/父级 iframe 只消费一次。
  // 初始快照里已经存在的弹窗视为回放；挂载后新出现的请求延迟 3 秒再播，
  // 覆盖重入竞态而不永久丢掉刚出现的等待。
  const dialogMountAtRef = useRef<number | null>(null);
  const initialDialogIdsRef = useRef<Set<string> | null>(null);
  if (initialDialogIdsRef.current === null) {
    initialDialogIdsRef.current = new Set([
      extensionDialog?.id,
      extensionCustomUi?.id,
    ].filter((id): id is string => typeof id === "string"));
  }
  useEffect(() => {
    if (!ownsStatusSounds) return;
    if (dialogMountAtRef.current === null) dialogMountAtRef.current = Date.now();
    if (
      !extensionDialog
      || (extensionDialog as ExtensionDialogRequest & { replay?: unknown }).replay === true
      || initialDialogIdsRef.current?.has(extensionDialog.id)
    ) return;
    const remaining = 3000 - (Date.now() - dialogMountAtRef.current);
    if (remaining > 0) {
      const timer = window.setTimeout(() => setWaitSoundRetry((value) => value + 1), remaining);
      return () => window.clearTimeout(timer);
    }
    // 刚交互过弹窗（弹窗流程的确认/下一步）不播：用户正在操作，弹窗可见。
    if (session && wasSessionDialogRecentlyInteracted(session.id)) return;
    tryPlaySoundRequest(waitSoundRequestId(extensionDialog.id), playWaitSoundRef.current, () => canPlayLocalSound("wait"));
  }, [canPlayLocalSound, extensionDialog, ownsStatusSounds, session, waitSoundRetry]);

  useEffect(() => {
    if (!ownsStatusSounds) return;
    if (dialogMountAtRef.current === null) dialogMountAtRef.current = Date.now();
    if (
      !extensionCustomUi
      || (extensionCustomUi as ExtensionCustomRequest & { replay?: unknown }).replay === true
      || initialDialogIdsRef.current?.has(extensionCustomUi.id)
    ) return;
    const remaining = 3000 - (Date.now() - dialogMountAtRef.current);
    if (remaining > 0) {
      const timer = window.setTimeout(() => setWaitSoundRetry((value) => value + 1), remaining);
      return () => window.clearTimeout(timer);
    }
    if (session && wasSessionDialogRecentlyInteracted(session.id)) return;
    tryPlaySoundRequest(waitSoundRequestId(extensionCustomUi.id), playWaitSoundRef.current, () => canPlayLocalSound("wait"));
  }, [canPlayLocalSound, extensionCustomUi, ownsStatusSounds, session, waitSoundRetry]);

  // Register the abort handler for the global Esc shortcut
  useEffect(() => {
    if (background) return;
    registerAbortHandler(canStopExecution ? handleAbortSession : null);
  }, [background, canStopExecution, handleAbortSession]);

  const [openedProcessEntryId, setOpenedProcessEntryId] = useState<string | null>(null);
  const [processReadStates, setProcessReadStates] = useState<Record<string, { loading: boolean; error: string | null }>>({});
  useEffect(() => {
    setOpenedProcessEntryId(null);
    setProcessReadStates({});
  }, [remotePeer, session?.id, history.requestedScope?.leafId]);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !transcript.loaded || historyLoading) return;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        if (entry.target === topSentinelRef.current) void reader.previousPage();
        else void reader.nextPage();
      }
    }, { root: container, rootMargin: `${CHAT_HISTORY_PRELOAD_DISTANCE}px 0px` });
    if (hasEarlierMessages && topSentinelRef.current) observer.observe(topSentinelRef.current);
    if (!atLiveTail && bottomSentinelRef.current) observer.observe(bottomSentinelRef.current);
    return () => observer.disconnect();
  }, [reader, transcript.loaded, transcript.before, transcript.after, hasEarlierMessages, atLiveTail, historyLoading, scrollContainerRef]);
  const readHistoryProcess = async (summary: HistoryProcessRange, open = true) => {
    const scope = reader.getState().requestedScope;
    const key = summary.firstEntryId;
    if (open) setOpenedProcessEntryId(key);
    setProcessReadStates(current => ({ ...current, [key]: { loading: true, error: null } }));
    let error: string | null = null;
    try {
      if (await reader.expandProcess(summary) === null) {
        error = reader.getState().error?.message || t("chat.failedToReadProcess");
      }
    } catch (cause) {
      error = (cause instanceof Error ? cause.message : String(cause)) || t("chat.failedToReadProcess");
    }
    if (scope !== reader.getState().requestedScope) return;
    setProcessReadStates(current => ({ ...current, [key]: { loading: false, error } }));
  };

  const [sessionSearchQuery, setSessionSearchQuery] = useState("");
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [sessionSearchMountedMatchCount, setSessionSearchMountedMatchCount] = useState(0);
  const [sessionSearchRanges, setSessionSearchRanges] = useState<Range[]>([]);
  const messageContentRef = useRef<HTMLDivElement | null>(null);
  const highlightHostRef = useRef<HTMLDivElement | null>(null);
  const [sessionSearchMatchIndex, setSessionSearchMatchIndex] = useState(-1);
  const [locatedSearchMatch, setLocatedSearchMatch] = useState<LocatedHistoryMatch | null>(null);
  const sessionSearchQueryRef = useRef(sessionSearchQuery);
  sessionSearchQueryRef.current = sessionSearchQuery;
  useEffect(() => { setLocatedSearchMatch(null); }, [activeLeafId, remotePeer, session?.id, sessionSearchQuery]);
  // Occurrences across the whole session file. The highlighted count only
  // covers mounted messages now that the panel loads a bounded page, so the
  // find bar must state the session-wide total instead of implying the loaded
  // page is everything.
  const [sessionSearchSessionTotal, setSessionSearchSessionTotal] = useState<number | null>(null);
  const sessionSearchMatchCount = sessionSearchSessionTotal ?? sessionSearchMountedMatchCount;
  const sessionSearchResultOffset = history.search.current?.query === sessionSearchQuery.trim()
    ? history.search.current?.offset ?? 0 : 0;
  const sessionSearchInputRef = useRef<HTMLInputElement>(null);

  // The mounted-window highlights are separate from the session-wide search cursor.
  const searchEffectRunRef = useRef(0);
  const focusSessionSearchInput = useCallback(() => {
    requestAnimationFrame(() => sessionSearchInputRef.current?.focus());
  }, []);
  useEffect(() => {
    const term = highlightTerm?.trim() ?? "";
    if (!term || term.length < 2) return;
    setSessionSearchQuery(term);
    setSessionSearchMountedMatchCount(0);
    setSessionSearchMatchIndex(-1);
    setSessionSearchOpen(true);
    focusSessionSearchInput();
  }, [focusSessionSearchInput, highlightTerm, session?.id]);
  useEffect(() => {
    if (background) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSessionSearchOpen(true);
        focusSessionSearchInput();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [background, focusSessionSearchInput]);

  const scrollSessionSearchMatch = useCallback((mark: HTMLElement) => {
    const container = scrollContainerRef.current;
    if (container) scrollSessionSearchTarget(mark, container, scrollToMessage);
  }, [scrollToMessage, scrollContainerRef]);

  // Search is produced by the same branch projection as navigation. DOM marks
  // are only a highlight surface for the bounded window currently mounted.
  useEffect(() => {
    const query = sessionSearchQuery.trim();
    if (!sessionSearchOpen || query.length < 2 || !historyScopeReady) {
      setSessionSearchSessionTotal(null);
      return;
    }
    const timer = setTimeout(() => {
      void reader.searchHistory({ q: query }).then((page) => {
        if (!page || page.query !== query) return;
        setSessionSearchSessionTotal(page.total);
        setSessionSearchMatchIndex(-1);
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [reader.searchHistory, historyScopeReady, sessionSearchOpen, sessionSearchQuery]);

  useEffect(() => {
    const runId = searchEffectRunRef.current + 1;
    searchEffectRunRef.current = runId;
    let disposed = false;
    let observer: MutationObserver | null = null;
    const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
    const isCurrent = () => !disposed && searchEffectRunRef.current === runId;
    const schedule = (callback: () => void) => {
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        callback();
      }, 250);
      pendingTimers.add(timer);
    };
    const cleanup = () => {
      disposed = true;
      observer?.disconnect();
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
    };
    const term = sessionSearchQuery.trim();
    const container = scrollContainerRef.current;
    if (!container || background) return cleanup;
    const clearHighlights = () => setSessionSearchRanges((current) => current.length ? [] : current);
    if (!term || term.length < 2) {
      clearHighlights();
      setSessionSearchMountedMatchCount(0);
      return cleanup;
    }
    clearHighlights();
    setSessionSearchMountedMatchCount(0);
    const lowerTerm = term.toLowerCase();
    let attempts = 0;
    const applyHighlight = () => {
      if (!isCurrent()) return;
      attempts += 1;
      // Data layer: lazy rendering only mounts the last N messages; make sure
      // the first match is rendered before touching the DOM.
      const textOf = (m: AgentMessage): string[] => {
        if (m.role !== "user" && m.role !== "assistant") return [];
        let content = (m as { content?: unknown }).content;
        if (m.role === "assistant" && Array.isArray(content)) {
          content = splitFinalAssistantBlocks(m as AssistantMessage).answerBlocks;
        }
        const rawTexts = typeof content === "string"
          ? [content]
          : Array.isArray(content)
            ? content
              .filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && part.type === "text" && typeof part.text === "string"))
              .map((part) => part.text)
            : [];
        if (m.role === "user") {
          const visible = visibleMarkdownText(rawTexts.join("\n"), { collapseSkill: true });
          return visible ? [visible] : [];
        }
        return rawTexts.map((text) => visibleMarkdownText(text)).filter(Boolean);
      };
      const matchIdx = messages.findIndex((m) => textOf(m).some((text) => text.toLowerCase().includes(lowerTerm)));
      if (matchIdx === -1 && attempts < 15) {
        schedule(applyHighlight);
      }
      type SearchNode = { node: Text; start: number; end: number };
      type SearchRange = { start: number; end: number; id: number };
      const rangesByNode = new Map<Text, SearchRange[]>();
      const matches: number[] = [];
      let nextMatchId = 0;
      const blockOf = (element: HTMLElement | null) => element?.closest("p,li,td,th,h1,h2,h3,h4,h5,h6,blockquote") ?? null;
      for (const root of container.querySelectorAll<HTMLElement>("[data-session-searchable='true']")) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes: SearchNode[] = [];
        let combined = "";
        let previousBlock: Element | null = null;
        while (walker.nextNode()) {
          const t = walker.currentNode as Text;
          const parent = t.parentElement;
          if (parent?.closest("[data-session-search-exclude='true'], .markdown-code-header, .katex, [data-footnote-ref], [data-footnote-backref], [data-footnotes]")) continue;
          const text = t.textContent ?? "";
          if (!text) continue;
          const block = blockOf(parent);
          if (combined && block !== previousBlock && (block || previousBlock)) combined += "\u0000";
          const start = combined.length;
          combined += text;
          nodes.push({ node: t, start, end: combined.length });
          previousBlock = block;
        }
        const lowerCombined = combined.toLowerCase();
        let idx = lowerCombined.indexOf(lowerTerm);
        let count = 0;
        while (idx !== -1 && count < 200) {
          const id = nextMatchId++;
          matches.push(id);
          const end = idx + term.length;
          for (const item of nodes) {
            const start = Math.max(idx, item.start);
            const finish = Math.min(end, item.end);
            if (start >= finish) continue;
            const ranges = rangesByNode.get(item.node) ?? [];
            ranges.push({ start: start - item.start, end: finish - item.start, id });
            rangesByNode.set(item.node, ranges);
          }
          idx = lowerCombined.indexOf(lowerTerm, end);
          count += 1;
        }
      }
      if (matches.length === 0) {
        clearHighlights();
        setSessionSearchMountedMatchCount(0);
        if (attempts < 15) schedule(applyHighlight);
        return;
      }
      const matchedIds = new Set<number>();
      const nextRanges: Range[] = [];
      for (const [node, ranges] of rangesByNode) {
        const parent = node.parentElement;
        if (!parent || parent.tagName === "MARK" || parent.closest("mark")) continue;
        for (const item of ranges) {
          const range = node.ownerDocument.createRange();
          range.setStart(node, item.start);
          range.setEnd(node, item.end);
          nextRanges.push(range);
          matchedIds.add(item.id);
        }
      }
      const orderedIds = matches.filter((id) => matchedIds.has(id));
      if (orderedIds.length === 0) {
        clearHighlights();
        if (attempts < 15) schedule(applyHighlight);
        return;
      }
      setSessionSearchRanges(nextRanges);
      setSessionSearchMountedMatchCount(orderedIds.length);
    };
    if (messageContentRef.current) {
      observer = new MutationObserver(() => {
        if (isCurrent() && pendingTimers.size === 0) schedule(applyHighlight);
      });
      observer.observe(messageContentRef.current, { childList: true, characterData: true, subtree: true });
    }
    applyHighlight();
    return cleanup;
  }, [sessionSearchQuery, session?.id, background, messages, scrollContainerRef, scrollSessionSearchMatch, hasEarlierMessages, historyLoading, highlightTerm, locatedSearchMatch]);

  const navigateSessionSearch = useCallback(async (direction: -1 | 1) => {
    const query = sessionSearchQuery.trim();
    if (query.length < 2 || !historyScopeReady || historyLoading) return;
    let page = history.search.current;
    if (!page || page.query !== query) page = await reader.searchHistory({ q: query });
    if (!page || page.matches.length === 0) return;
    let next = sessionSearchMatchIndex < 0 ? (direction === 1 ? 0 : page.matches.length - 1) : sessionSearchMatchIndex + direction;
    if (next < 0) {
      page = page.before ? await reader.previousSearchPage() : page;
      next = page?.matches.length ? page.matches.length - 1 : 0;
    } else if (next >= page.matches.length) {
      page = page.after ? await reader.nextSearchPage() : page;
      next = page?.matches.length ? 0 : 0;
    }
    const match = page?.matches[next];
    if (!match) return;
    setSessionSearchMatchIndex(next);
    setFollow(false);
    const scope = JSON.stringify(reader.getState().requestedScope);
    const content = await reader.locateSearchMatch(match);
    if (!content || sessionSearchQueryRef.current.trim() !== query
      || JSON.stringify(reader.getState().requestedScope) !== scope) return;
    setLocatedSearchMatch({ ...match, revision: content.revision });
  }, [reader, history.search, reader.searchHistory, reader.locateSearchMatch, reader.nextSearchPage, reader.previousSearchPage, historyLoading, historyScopeReady, sessionSearchMatchIndex, sessionSearchQuery, setFollow]);

  useLayoutEffect(() => {
    const segment = historySearchSegment(history.content.page, locatedSearchMatch);
    if (!segment) return;
    const mark = Array.from(scrollContainerRef.current?.querySelectorAll<HTMLElement>("mark[data-history-search-target]") ?? [])
      .find((element) => element.dataset.historySearchTarget === segment.key);
    if (mark) scrollSessionSearchMatch(mark);
  }, [history.content.page, locatedSearchMatch, scrollContainerRef, scrollSessionSearchMatch]);

  // Publish every visible metric whenever any part of the stats snapshot changes.
  const statsKey = sessionStats ? JSON.stringify(sessionStats) : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);

  const onDrop = useCallback((files: File[]) => {
    chatInputRef?.current?.addImages(files);
  }, [chatInputRef]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const visibleMessages = messages.filter((m) => m.role === "user" || m.role === "assistant");


  // Stable Map identity: `messages` doesn't change during streaming updates
  // (the streaming message lives in streamingStore), so memoized MessageViews
  // skip re-rendering on every message_update event. An inline `new Map()`
  // here used to defeat MessageView's memo() on each streamed chunk.
  const toolResultsMap = useMemo(() => {
    // Partial CodeMode/shell progress is ephemeral; persisted final results
    // win whenever the transcript already contains the same call.
    const map = new Map<string, ToolResultMessage>(activeToolResults);
    for (const msg of messages) {
      if (msg.role === "toolResult") {
        map.set((msg as ToolResultMessage).toolCallId, msg as ToolResultMessage);
      }
    }
    return map;
  }, [activeToolResults, messages]);
  const finalAnswerViewCache = useMemo(() => new WeakMap<AssistantMessage, FinalAnswerViews>(), []);
  const inputHistory = useMemo(() => {
    const seen = new Set<string>();
    const history: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = getUserInputText(messages[i]);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      history.push(text);
      if (history.length >= 50) break;
    }
    return history.reverse();
  }, [messages]);
  const messageRefs = useMessageRefs(visibleMessages.length);

  // Timing turns are user-anchored, so an answer written after a compaction still gets its whole turn.
  const timingTurnByFinalIndex = useMemo(() => {
    const result = new Map<number, TurnActivity>();
    for (const turn of analyzeTurns(messages)) {
      if (turn.finalAssistantIndex >= 0 && turn.response) result.set(turn.finalAssistantIndex, turn);
    }
    return result;
  }, [messages]);
  const sessionTurnTimingByEntryId = useMemo(
    () => new Map((sessionStats?.timing?.turns ?? []).map((turn) => [turn.entryId, turn])),
    [sessionStats?.timing],
  );
  const { turnUsageByAssistantIndex, turnResourcesByAssistantIndex } = useMemo(() => {
    const result = new Map<number, TurnUsage>();
    const resources = new Map<number, TurnResources>();
    for (let anchorIndex = 0; anchorIndex < messages.length;) {
      if (!isResponseTurnAnchor(messages[anchorIndex])) {
        anchorIndex += 1;
        continue;
      }
      let endIndex = anchorIndex + 1;
      while (endIndex < messages.length && !isResponseTurnAnchor(messages[endIndex])) endIndex += 1;
      const finalAssistantIndex = findFinalAssistantIndex(messages, anchorIndex, endIndex);
      if (finalAssistantIndex >= 0) {
        const usage = summarizeTurnUsage(messages, entryIds, messageCosts, anchorIndex, endIndex);
        if (usage) result.set(finalAssistantIndex, usage);
        const activeTail = endIndex === messages.length && sessionBusy;
        if (!activeTail) resources.set(finalAssistantIndex, summarizeTurnResources(messages, anchorIndex, endIndex, systemTools ?? []));
      }
      anchorIndex = endIndex;
    }
    return { turnUsageByAssistantIndex: result, turnResourcesByAssistantIndex: resources };
  }, [messages, entryIds, messageCosts, sessionBusy, systemTools]);

  const isEmptyNew = isNew && messages.length === 0 && !isStreaming && !sessionBusy;
  useScrollbarVisibility(scrollContainerRef, Boolean(session?.id) || !isEmptyNew);
  const projectPath = session?.projectRoot ?? session?.cwd ?? newSessionCwd;
  const projectName = projectPath ? getFileName(projectPath) || projectPath : null;
  const hasStreamingContent = Boolean(atLiveTail && hasStoreStreamingContent);
  const messageCwd = session?.cwd ?? newSessionCwd ?? undefined;
  const streamingMessageRef = useRef<HTMLDivElement | null>(null);
  const promptAnchorSpacerRef = useRef<HTMLDivElement | null>(null);
  const promptAnchorSpacerHeightRef = useRef(0);
  const promptAnchorMeasureFrameRef = useRef<number | null>(null);
  const promptAnchorAdjustmentDoneRef = useRef(false);
  const promptAnchorUpdateRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const spacer = promptAnchorSpacerRef.current;
    if (!agentRunning || !promptAnchorActive) {
      promptAnchorUpdateRef.current = null;
      promptAnchorSpacerHeightRef.current = 0;
      promptAnchorAdjustmentDoneRef.current = false;
      if (spacer) spacer.style.height = "";
      return;
    }

    const container = scrollContainerRef.current;
    const messageContent = messageContentRef.current;
    const userMessage = lastUserMsgRef.current;
    if (!container || !messageContent || !userMessage || !spacer) return;

    let disposed = false;
    const updatePromptAnchorSpacer = () => {
      if (
        disposed
        || scrollContainerRef.current !== container
        || messageContentRef.current !== messageContent
        || lastUserMsgRef.current !== userMessage
        || promptAnchorSpacerRef.current !== spacer
      ) return;

      const containerTop = container.getBoundingClientRect().top;
      const userMessageTop = userMessage.getBoundingClientRect().top
        - containerTop
        + container.scrollTop;
      const targetTop = Math.max(0, userMessageTop - 16);
      const contentEnd = spacer.getBoundingClientRect().top
        - containerTop
        + container.scrollTop;
      const nextPromptAnchorSpacerHeight = getPromptAnchorSpacerHeight(
        targetTop,
        contentEnd,
        container.clientHeight,
      );

      const isInitialMeasurement = !promptAnchorAdjustmentDoneRef.current;
      const needsInitialAdjustment = isInitialMeasurement
        && nextPromptAnchorSpacerHeight > 0;
      if (isInitialMeasurement) promptAnchorAdjustmentDoneRef.current = true;
      if (nextPromptAnchorSpacerHeight === promptAnchorSpacerHeightRef.current) return;

      promptAnchorSpacerHeightRef.current = nextPromptAnchorSpacerHeight;
      spacer.style.height = nextPromptAnchorSpacerHeight > 0
        ? `${nextPromptAnchorSpacerHeight}px`
        : "";
      if (needsInitialAdjustment && viewport.follow) scrollUserMsgToTop();
    };

    promptAnchorUpdateRef.current = updatePromptAnchorSpacer;
    const schedulePromptAnchorMeasure = () => {
      if (disposed || promptAnchorMeasureFrameRef.current !== null) return;
      promptAnchorMeasureFrameRef.current = requestAnimationFrame(() => {
        promptAnchorMeasureFrameRef.current = null;
        updatePromptAnchorSpacer();
      });
    };

    updatePromptAnchorSpacer();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(schedulePromptAnchorMeasure);
    observer?.observe(container);
    observer?.observe(messageContent);
    observer?.observe(userMessage);
    return () => {
      disposed = true;
      if (promptAnchorUpdateRef.current === updatePromptAnchorSpacer) {
        promptAnchorUpdateRef.current = null;
      }
      observer?.disconnect();
      if (promptAnchorMeasureFrameRef.current !== null) {
        cancelAnimationFrame(promptAnchorMeasureFrameRef.current);
        promptAnchorMeasureFrameRef.current = null;
      }
    };
  }, [
    agentRunning,
    lastUserMsgRef,
    messages.length,
    promptAnchorActive,
    scrollContainerRef,
    scrollUserMsgToTop,
  ]);

  const updatePromptAnchor = useCallback(() => {
    promptAnchorUpdateRef.current?.();
  }, []);
  useLayoutEffect(updatePromptAnchor, [isStreaming, hasStreamingContent, updatePromptAnchor]);

  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const [localQuoteSelectionEnabled, setLocalQuoteSelectionEnabled] = useState(() => {
    if (typeof window === "undefined") return true;
    try {
      const stored = localStorage.getItem("pi-quote-selection-enabled");
      return stored !== null ? stored === "true" : true;
    } catch {
      return true;
    }
  });

  useEffect(() => {
    const handleQuotePrefChanged = (e: Event) => {
      const customEvent = e as CustomEvent<boolean>;
      if (typeof customEvent.detail === "boolean") {
        setLocalQuoteSelectionEnabled(customEvent.detail);
      } else {
        try {
          const stored = localStorage.getItem("pi-quote-selection-enabled");
          setLocalQuoteSelectionEnabled(stored !== null ? stored === "true" : true);
        } catch (error) { void error; }
      }
    };
    window.addEventListener("pi-quote-selection-changed", handleQuotePrefChanged);
    return () => window.removeEventListener("pi-quote-selection-changed", handleQuotePrefChanged);
  }, []);

  const effectiveQuoteSelection = quoteSelectionEnabledProp ?? localQuoteSelectionEnabled;
  const [quoteShortcut, setQuoteShortcut] = useState(() => loadStoredQuoteShortcut());

  useEffect(() => {
    const handleShortcutChanged = (event: Event) => {
      const custom = event as CustomEvent<{ shortcut?: string }>;
      if (custom.detail?.shortcut) {
        setQuoteShortcut(custom.detail.shortcut);
      } else {
        setQuoteShortcut(loadStoredQuoteShortcut());
      }
    };
    window.addEventListener(QUOTE_SHORTCUT_CHANGED_EVENT, handleShortcutChanged);
    return () => window.removeEventListener(QUOTE_SHORTCUT_CHANGED_EVENT, handleShortcutChanged);
  }, []);

  const [selectionTooltip, setSelectionTooltip] = useState<{
    text: string;
    top: number;
    left: number;
    sourceEntryId?: string;
    targetName?: string;
    startSnippet?: string;
    endSnippet?: string;
  } | null>(null);
  const selectionTooltipRef = useRef<HTMLDivElement>(null);
  const clearSelectionTooltip = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setSelectionTooltip(null);
  }, []);

  const [activeQuotes, setActiveQuotes] = useState<QuoteContextItem[]>([]);
  const [quoteHighlights, setQuoteHighlights] = useState<QuoteHighlight[]>([]);
  const [flashingQuoteId, setFlashingQuoteId] = useState<string | null>(null);
  const quoteFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (quoteFlashTimerRef.current) clearTimeout(quoteFlashTimerRef.current); }, []);
  const [annotationModal, setAnnotationModal] = useState<{
    isOpen: boolean;
    mode: "create" | "edit";
    quoteId?: string;
    quoteText: string;
    initialReply?: string;
    sourceEntryId?: string;
    targetName?: string;
    startSnippet?: string;
    endSnippet?: string;
  } | null>(null);

  const [hoveredBadgeInfo, setHoveredBadgeInfo] = useState<{
    quote: QuoteContextItem;
    top: number;
    left: number;
  } | null>(null);

  const badgeHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepBadgePreviewOpen = useCallback(() => {
    if (badgeHoverTimerRef.current !== null) clearTimeout(badgeHoverTimerRef.current);
  }, []);
  const scheduleBadgePreviewClose = useCallback(() => {
    keepBadgePreviewOpen();
    badgeHoverTimerRef.current = setTimeout(() => setHoveredBadgeInfo(null), 400);
  }, [keepBadgePreviewOpen]);
  useEffect(() => keepBadgePreviewOpen, [keepBadgePreviewOpen]);

  const handleRemoveQuote = useCallback((quoteId: string) => {
    chatInputRef?.current?.removeQuote?.(quoteId);
    keepBadgePreviewOpen();
    setHoveredBadgeInfo(null);
    setAnnotationModal((current) => current?.quoteId === quoteId ? null : current);
  }, [chatInputRef, keepBadgePreviewOpen]);

  const checkSelection = useCallback(() => {
    if (!effectiveQuoteSelection) {
      setSelectionTooltip(null);
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setSelectionTooltip(null);
      return;
    }
    const range = sel.getRangeAt(0);
    const container = messageContentRef.current;
    if (!container || !container.contains(range.commonAncestorContainer)) {
      setSelectionTooltip(null);
      return;
    }
    const text = sel.toString().trim();
    if (!text) {
      setSelectionTooltip(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    const rowEl = (range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest<HTMLElement>("[data-chat-message-row]");
    const sourceEntryId = rowEl?.getAttribute("data-entry-id") || undefined;
    const modelAttr = rowEl?.getAttribute("data-message-model");
    const roleAttr = rowEl?.getAttribute("data-message-role");
    const targetName = modelAttr || (roleAttr === "assistant" ? (displayModelValue ? (typeof displayModelValue === "object" ? displayModelValue.modelId : String(displayModelValue)) : "Claude") : "Claude");

    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const firstLine = lines[0] || text;
    const lastLine = lines[lines.length - 1] || text;
    const startSnippet = (firstLine.length > 25 ? firstLine.slice(0, 25).trim() : firstLine).trim();
    const endSnippet = (lastLine.length > 25 ? lastLine.slice(-25).trim() : lastLine).trim();
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const scrollContainerTop = scrollContainerRef.current?.getBoundingClientRect().top ?? 0;
    const visibleTop = Math.max(window.visualViewport?.offsetTop ?? 0, scrollContainerTop);

    setSelectionTooltip({
      text,
      top: clampSelectionToolbarTop(rect.bottom, visibleTop, viewportHeight),
      left: Math.max(64, Math.min(window.innerWidth - 120, rect.left + rect.width / 2)),
      sourceEntryId,
      targetName,
      startSnippet,
      endSnippet,
    });
  }, [displayModelValue, effectiveQuoteSelection]);

  useEffect(() => {
    if (!effectiveQuoteSelection) {
      setSelectionTooltip(null);
      return;
    }
    let activePointerId: number | null = null;
    let selectionCheckFrame: number | null = null;
    const scheduleSelectionCheck = () => {
      if (selectionCheckFrame !== null) return;
      selectionCheckFrame = window.requestAnimationFrame(() => {
        selectionCheckFrame = null;
        if (activePointerId === null) checkSelection();
      });
    };
    const onSelectionChange = () => {
      if (activePointerId !== null) return;
      scheduleSelectionCheck();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0 || activePointerId !== null) return;
      if (selectionTooltipRef.current?.contains(event.target as Node)) return;
      activePointerId = event.pointerId;
    };
    const finishPointerSelection = (event: PointerEvent) => {
      if (activePointerId !== event.pointerId) return;
      activePointerId = null;
      scheduleSelectionCheck();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectionTooltip(null);
      }
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", finishPointerSelection);
    window.addEventListener("pointercancel", finishPointerSelection);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", finishPointerSelection);
      window.removeEventListener("pointercancel", finishPointerSelection);
      document.removeEventListener("keydown", onKeyDown);
      if (selectionCheckFrame !== null) window.cancelAnimationFrame(selectionCheckFrame);
    };
  }, [effectiveQuoteSelection, checkSelection]);

  const handleQuoteToSidekick = useCallback(() => {
    if (!selectionTooltip) return;
    const intro = t("chat.quoteIntro");
    const quoted = selectionTooltip.text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    const quoteText = `${intro}\n\n${quoted}\n\n`;
    clearSelectionTooltip();
    onSelectionToolbarChange?.(null);
    if (!sidekickIsOpen && onToggleSidekick) {
      onToggleSidekick();
    }
    window.dispatchEvent(new CustomEvent("pi-sidekick-quote", { detail: { text: quoteText } }));
  }, [clearSelectionTooltip, onSelectionToolbarChange, onToggleSidekick, selectionTooltip, sidekickIsOpen, t]);

  const handleEditQuote = useCallback((quote: QuoteContextItem) => {
    setHoveredBadgeInfo(null);
    setAnnotationModal({
      isOpen: true,
      mode: "edit",
      quoteId: quote.id,
      quoteText: quote.text,
      initialReply: quote.reply || "",
      targetName: displayModelValue ? (typeof displayModelValue === "object" ? displayModelValue.modelId : String(displayModelValue)) : "Claude",
    });
  }, [displayModelValue]);

  const handleConfirmAnnotation = useCallback((reply: string) => {
    if (!annotationModal) return;
    if (annotationModal.mode === "create") {
      const newQuote: QuoteContextItem = {
        id: `quote-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        text: annotationModal.quoteText,
        reply,
        sourceEntryId: annotationModal.sourceEntryId,
        startSnippet: annotationModal.startSnippet,
        endSnippet: annotationModal.endSnippet,
      };
      if (chatInputRef?.current?.addQuoteItem) {
        chatInputRef.current.addQuoteItem(newQuote);
      } else if (chatInputRef?.current?.addQuote) {
        chatInputRef.current.addQuote(newQuote.text, undefined, newQuote.reply);
      }
    } else if (annotationModal.mode === "edit" && annotationModal.quoteId) {
      if (chatInputRef?.current?.updateQuoteReply) {
        chatInputRef.current.updateQuoteReply(annotationModal.quoteId, reply);
      } else if (chatInputRef?.current?.updateQuote) {
        chatInputRef.current.updateQuote(annotationModal.quoteId, reply);
      }
    }
    setAnnotationModal(null);
  }, [annotationModal, chatInputRef]);

  const embeddedInParent = typeof window !== "undefined" && window.parent !== window;
  const quoteModalRequestIdRef = useRef(0);

  useEffect(() => {
    if (!embeddedInParent) return;
    const requestId = ++quoteModalRequestIdRef.current;
    if (annotationModal?.isOpen) {
      window.parent.postMessage({
        type: EMBEDDED_QUOTE_ANNOTATION_EVENT,
        open: true,
        requestId,
        quoteText: annotationModal.quoteText,
        initialReply: annotationModal.initialReply,
        targetName: annotationModal.targetName,
        canDelete: annotationModal.mode === "edit",
      }, "*");
    } else {
      window.parent.postMessage({
        type: EMBEDDED_QUOTE_ANNOTATION_EVENT,
        open: false,
        requestId,
      }, "*");
    }
  }, [annotationModal, embeddedInParent]);

  useEffect(() => {
    if (!embeddedInParent) return;
    const handleParentQuoteResult = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data as { type?: unknown; reply?: unknown; requestId?: unknown } | null;
      if (!annotationModal?.isOpen || data?.requestId !== quoteModalRequestIdRef.current) return;
      if (data?.type === EMBEDDED_QUOTE_ANNOTATION_RESULT_EVENT) {
        if (typeof data.reply === "string") {
          handleConfirmAnnotation(data.reply);
        }
      } else if (data?.type === EMBEDDED_QUOTE_ANNOTATION_DELETE_EVENT) {
        if (annotationModal.mode === "edit" && annotationModal.quoteId) handleRemoveQuote(annotationModal.quoteId);
      } else if (data?.type === EMBEDDED_QUOTE_ANNOTATION_CLOSE_EVENT) {
        setAnnotationModal(null);
      }
    };
    window.addEventListener("message", handleParentQuoteResult);
    return () => window.removeEventListener("message", handleParentQuoteResult);
  }, [annotationModal, embeddedInParent, handleConfirmAnnotation, handleRemoveQuote]);

  const handleJumpToQuote = useCallback((quoteId: string) => {
    const range = quoteHighlights.find((highlight) => highlight.quote.id === quoteId)?.ranges[0];
    const target = range?.startContainer.parentElement;
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    if (quoteFlashTimerRef.current) clearTimeout(quoteFlashTimerRef.current);
    setFlashingQuoteId(quoteId);
    quoteFlashTimerRef.current = setTimeout(() => setFlashingQuoteId(null), 1200);
  }, [quoteHighlights]);

  const handleQuoteSelection = useCallback(() => {
    if (!selectionTooltip) return;
    const text = selectionTooltip.text;
    const sourceEntryId = selectionTooltip.sourceEntryId;
    const targetName = selectionTooltip.targetName || (displayModelValue ? (typeof displayModelValue === "object" ? displayModelValue.modelId : String(displayModelValue)) : "Claude");
    setAnnotationModal({
      isOpen: true,
      mode: "create",
      quoteText: text,
      sourceEntryId,
      targetName,
      startSnippet: selectionTooltip.startSnippet,
      endSnippet: selectionTooltip.endSnippet,
    });
    clearSelectionTooltip();
  }, [clearSelectionTooltip, displayModelValue, selectionTooltip]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isQuoteShortcut(e, quoteShortcut)) return;
      const sel = window.getSelection();
      const selText = sel?.toString().trim();
      const rangeNode = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0).commonAncestorContainer : null;
      const textToQuote = selectionTooltip?.text || (selText && rangeNode && messageContentRef.current?.contains(rangeNode) ? selText : null);
      if (textToQuote) {
        e.preventDefault();
        e.stopPropagation();
        const rowEl = (rangeNode instanceof Element ? rangeNode : rangeNode?.parentElement)?.closest<HTMLElement>("[data-chat-message-row]");
        const sourceEntryId = rowEl?.getAttribute("data-entry-id") || undefined;
        const modelAttr = rowEl?.getAttribute("data-message-model");
        const roleAttr = rowEl?.getAttribute("data-message-role");
        const targetName = modelAttr || (roleAttr === "assistant" ? (displayModelValue ? (typeof displayModelValue === "object" ? displayModelValue.modelId : String(displayModelValue)) : "Claude") : "Claude");
        const lines = textToQuote.split("\n").map((l) => l.trim()).filter(Boolean);
        const firstLine = lines[0] || textToQuote;
        const lastLine = lines[lines.length - 1] || textToQuote;
        const startSnippet = (firstLine.length > 25 ? firstLine.slice(0, 25).trim() : firstLine).trim();
        const endSnippet = (lastLine.length > 25 ? lastLine.slice(-25).trim() : lastLine).trim();
        setAnnotationModal({
          isOpen: true,
          mode: "create",
          quoteText: textToQuote,
          sourceEntryId,
          targetName,
          startSnippet,
          endSnippet,
        });
        clearSelectionTooltip();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [clearSelectionTooltip, displayModelValue, quoteShortcut, selectionTooltip]);

  const handleQuoteBadgeHover = useCallback((quote: QuoteContextItem, badgeEl: HTMLElement) => {
    keepBadgePreviewOpen();
    const rect = badgeEl.getBoundingClientRect();
    setHoveredBadgeInfo({ quote, top: rect.top, left: rect.left + rect.width / 2 });
  }, [keepBadgePreviewOpen]);

  useEffect(() => {
    const container = messageContentRef.current;
    if (!container) return;
    if (activeQuotes.length === 0) {
      setQuoteHighlights((current) => current.length ? [] : current);
      return;
    }
    let frame = 0;
    const update = () => { frame = 0; setQuoteHighlights(findQuoteHighlights(container, activeQuotes)); };
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(update); });
    observer.observe(container, { childList: true, characterData: true, subtree: true });
    update();
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [activeQuotes, messages, transcript.items]);

  useEffect(() => {
    const onScroll = () => setHoveredBadgeInfo(null);
    const scrollEl = scrollContainerRef.current;
    scrollEl?.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollEl?.removeEventListener("scroll", onScroll);
  }, [scrollContainerRef]);

  useEffect(() => {
    if (!onSelectionToolbarChange) return;
    onSelectionToolbarChange(selectionTooltip ? {
      askCurrent: handleQuoteSelection,
      askSidekick: handleQuoteToSidekick,
      dismiss: clearSelectionTooltip,
    } : null);
  }, [clearSelectionTooltip, handleQuoteSelection, handleQuoteToSidekick, onSelectionToolbarChange, selectionTooltip]);

  useEffect(() => {
    if (!onSelectionToolbarChange) return;
    return () => onSelectionToolbarChange(null);
  }, [onSelectionToolbarChange]);

  const chatInputElement = (
    <ChatInput
      ref={chatInputRef}
      constrainWidth={!isEmptyNew}
      onReady={onChatInputReady}
      onUpwardMenuOpenChange={setComposerMenuOpen}
      onSend={handleSend}
      onAbort={handleAbortSession}
      onQuotesChange={setActiveQuotes}
      onEditQuote={handleEditQuote}
      onJumpToQuote={handleJumpToQuote}
      onSteer={parentPromptBusy ? handleSteer : undefined}
      onFollowUp={parentPromptBusy ? handleFollowUp : undefined}
      onPromptWithStreamingBehavior={parentPromptBusy ? handlePromptWithStreamingBehavior : undefined}
      editorSuggestion={editorSuggestion}
      isStreaming={parentAgentBusy}
      canStop={canStopExecution}
      stopping={stoppingExecution}
      readOnlyReason={session?.archived ? t("chat.archivedReadOnly") : undefined}
      statePending={sessionStatePending || sideBranchPending}
      model={displayModelValue}
      isAutoModelSelection={isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      modelError={modelError}
      modelScopeWarnings={modelScopeWarnings}
      onModelChange={handleModelChange}
      sessionId={session?.id ?? null}
      onEnsureSession={ensureSession}
      sessionFile={session?.path ?? undefined}
      onOpenFile={onOpenFile}
      modelSwitching={modelSwitching}
      defaultModel={defaultModel}
      onSetDefaultModel={handleSetDefaultModel}
      runtimeSettingsUpdating={runtimeSettingsUpdating}
      onCompact={messages.length > 0 ? handleCompact : undefined}
      onAbortCompaction={handleAbortCompaction}
      autoCompactionEnabled={autoCompactionEnabled}
      runtimeSettingsRead={runtimeSettingsRead}
      onRetryRuntimeSettings={retryRuntimeSettings}
      onAutoCompactionChange={session || isNew ? handleAutoCompactionChange : undefined}
      isCompacting={isCompacting}
      compactError={compactError}
      compactResult={compactResult}
      toolPreset={toolPreset}
      onToolPresetChange={session || isNew ? handleToolPresetChange : undefined}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={session || isNew ? handleThinkingLevelChange : undefined}
      fastMode={fastMode}
      onFastModeChange={session || isNew ? handleFastModeChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      savedDefaultThinkingLevel={savedDefaultThinkingLevel}
      onSetDefaultThinkingLevel={session || isNew ? handleSetDefaultThinkingLevel : undefined}
      retryInfo={retryInfo}
      continueUi={(abnormalRun || isTailAborted) && continueUi.kind === "idle" ? { kind: "awaiting" as const, errorText: null } : continueUi}
      unattended={unattended}
      onContinue={triggerContinue}
      onUnattendedChange={toggleUnattended}
      onStopContinue={stopAutoRetry}
      queuedMessages={queuedMessages}
      inputHistory={inputHistory}
      onRecallQueue={handleRecallQueue}
      slashCommands={slashCommands}
      slashCommandsLoading={slashCommandsLoading}
      slashCommandsReloadKey={slashCommandsReloadKey}
      onLoadSlashCommands={loadSlashCommands}
      onBuiltinCommand={handleBuiltinSlashCommand}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      onAudioUnlock={unlockAudio}
      draftKey={composerDraftKey}
      onLegacyDraftRecovered={restoreLegacyHistoryEdit}
      cwd={session?.cwd ?? newSessionCwd}
      remotePeer={remotePeer}
    />
  );


  return (
    <div
      className="chat-content relative flex h-full min-w-0 flex-col overflow-hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[rgba(37,99,235,0.06)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[rgba(37,99,235,0.5)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <svg
            width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
            className="drop-shadow-[0_6px_18px_rgba(37,99,235,0.18)]"
          >
            <rect x="28" y="44" width="84" height="60" rx="8" fill="rgba(37,99,235,0.08)" stroke="rgba(37,99,235,0.50)" strokeWidth="1.8"/>
            <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="rgba(37,99,235,0.16)" stroke="rgba(37,99,235,0.40)" strokeWidth="1.4" strokeLinejoin="round"/>
            <circle cx="96" cy="58" r="8" fill="rgba(37,99,235,0.22)" stroke="rgba(37,99,235,0.55)" strokeWidth="1.6"/>
            <g stroke="rgba(37,99,235,0.45)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43"/>
              <line x1="96" y1="70" x2="96" y2="73"/>
              <line x1="84" y1="58" x2="81" y2="58"/>
              <line x1="108" y1="58" x2="111" y2="58"/>
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
            </g>
          </svg>
        </div>
      )}

      {extensionDialog && (
        <ExtensionDialog
          key={extensionDialog.id}
          request={extensionDialog}
          waitingCount={waitingExtensionDialogCount}
          onRespond={respondToExtensionUi}
        />
      )}

      {extensionCustomUi && (
        <ExtensionCustomPanel
          key={extensionCustomUi.id}
          request={extensionCustomUi}
          waitingCount={waitingExtensionCustomUiCount}
          onInput={sendExtensionCustomInput}
          onClose={closeExtensionCustomUi}
        />
      )}

      {sessionSearchOpen && !isEmptyNew && (
        <div role="search" aria-label={t("chat.findInSession")} style={{ position: "absolute", top: 10, right: isMobile ? 10 : 52, zIndex: 70, display: "flex", alignItems: "center", gap: 6, maxWidth: "calc(100% - 20px)", padding: 6, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", boxShadow: "0 8px 22px rgba(0,0,0,0.18)" }}>
          <input
            ref={sessionSearchInputRef}
            value={sessionSearchQuery}
            onChange={(event) => {
              setSessionSearchQuery(event.currentTarget.value);
              setSessionSearchMatchIndex(-1);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); navigateSessionSearch(event.shiftKey ? -1 : 1); }
              if (event.key === "Escape") {
                setSessionSearchOpen(false);
                setSessionSearchQuery("");
              }
            }}
            placeholder={t("chat.findInSession")}
            aria-label={t("chat.findInSession")}
            style={{ width: isMobile ? 128 : 190, minWidth: 0, border: 0, outline: "none", background: "transparent", color: "var(--text)", fontSize: 13 }}
          />
          <span aria-live="polite" style={{ flexShrink: 0, color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, whiteSpace: "nowrap" }}>
            {sessionSearchMatchCount > 0
              ? t("chat.findMatchCount", { current: sessionSearchResultOffset + sessionSearchMatchIndex + 1, total: sessionSearchMatchCount })
              : historyLoading
                ? t("chat.expandingHistory")
                : t("chat.findNoMatches")}
          </span>
          <button type="button" onClick={() => navigateSessionSearch(-1)} disabled={sessionSearchMatchCount === 0 && (!sessionSearchSessionTotal || sessionSearchSessionTotal <= 0) && !historyLoading} title={t("chat.findPrevious")} aria-label={t("chat.findPrevious")} style={{ display: "grid", placeItems: "center", width: 26, height: 26, border: 0, borderRadius: 4, background: "transparent", color: "var(--text)", cursor: "pointer" }}><ChevronUp size={16} aria-hidden="true" /></button>
          <button type="button" onClick={() => navigateSessionSearch(1)} disabled={sessionSearchMatchCount === 0 && (!sessionSearchSessionTotal || sessionSearchSessionTotal <= 0) && !historyLoading} title={t("chat.findNext")} aria-label={t("chat.findNext")} style={{ display: "grid", placeItems: "center", width: 26, height: 26, border: 0, borderRadius: 4, background: "transparent", color: "var(--text)", cursor: "pointer" }}><ChevronDown size={16} aria-hidden="true" /></button>
          <button type="button" onClick={() => {
            setSessionSearchOpen(false);
            setSessionSearchQuery("");
          }} title={t("chat.findClose")} aria-label={t("chat.findClose")} style={{ display: "grid", placeItems: "center", width: 26, height: 26, border: 0, borderRadius: 4, background: "transparent", color: "var(--text)", cursor: "pointer" }}><X size={16} aria-hidden="true" /></button>
        </div>
      )}

      {isEmptyNew ? (
        <div
          className={`new-session-container flex flex-1 flex-col items-center overflow-y-auto px-4 ${composerMenuOpen ? "justify-end pb-4 pt-2" : "justify-center py-8"}`}
        >
          <div style={{ width: "100%", maxWidth: "var(--chat-content-max-width, 90%)" }}>
            <div
              className="new-session-brand mb-3"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                marginLeft: 16,
                marginRight: isMobile ? 16 : 52,
                fontFamily: "var(--font-mono)",
              }}
            >
              {/* Reader keeps the brand row from shrinking (flexShrink 0) and
                  compensates the 28px pi glyph baseline; upstream gap shrinks on mobile. */}
              <div style={{ display: "flex", alignItems: "baseline", gap: isMobile ? 7 : 10, minWidth: 0, flexShrink: 0, maxWidth: "35%", lineHeight: 1.4, paddingBottom: 7, overflow: "hidden" }}>
                <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: 0, color: "var(--text)", flexShrink: 0, whiteSpace: "nowrap" }}>π</span>
                <span style={{ fontSize: 22, color: "var(--text)", fontWeight: 700, letterSpacing: 0, flexShrink: 0, whiteSpace: "nowrap" }}>Pi Web</span>
              </div>
              <div
                aria-live="polite"
                aria-label={[projectName, deviceName].filter(Boolean).join(" · ") || undefined}
                style={{ display: "flex", alignItems: "center", justifyContent: "flex-start", gap: 8, minWidth: 0, flex: 1, overflow: "hidden", fontSize: 12, lineHeight: 1.4, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}
              >
                <NewSessionUpdateLink
                  label={(version) => t("appUpdate.releaseNotes", { version })}
                  text={(version) => t("appUpdate.upstreamVersion", { version })}
                />
                {(projectName || deviceName) && (
                  <>
                    <span style={{ flexShrink: 0, color: "var(--text-dim)" }}>·</span>
                    <span title={projectPath ?? undefined} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {[projectName, deviceName].filter(Boolean).join(" · ")}
                    </span>
                  </>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  web <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}</span>
                </span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  pi <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}</span>
                </span>
              </div>
            </div>

            {chatInputElement}
            <ExtensionStatusBar statuses={extensionStatuses} widgets={extensionWidgets} sessionId={session?.id} remotePeer={remotePeer} />
          </div>
        </div>
      ) : (
      <>
      {activeSideTabId !== "main" && (() => {
        const currentSideTab = sideTabs.find((t) => t.tabId === activeSideTabId);
        return (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-start",
              padding: "5px 16px",
              background: "rgba(234, 179, 8, 0.08)",
              borderBottom: "1px solid rgba(234, 179, 8, 0.2)",
              fontSize: 12,
              color: "var(--text)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}>
              <span>🌿</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t("chat.sideBranchBanner")}
                {currentSideTab?.anchorSnippet
                  ? ` · 🌱 ${t("chat.forkOriginSnippet", { snippet: currentSideTab.anchorSnippet })}`
                  : (currentSideTab?.title ? t("chat.sideBranchTitleSuffix", { title: formatSideBranchTitle(currentSideTab.title, t) }) : "")}
              </span>
            </div>
          </div>
        );
      })()}
      {(error || history.error) ? (
        <div role="alert" style={{ padding: "8px 16px", borderBottom: "1px solid var(--border)", color: "var(--error)", fontSize: 12, flexShrink: 0 }}>
          <span>{[error, history.error?.message].filter(Boolean).join(" · ")}</span>
          <button type="button" onClick={() => void retrySessionRead()} style={{ marginLeft: 8, border: 0, background: "transparent", color: "inherit", textDecoration: "underline", cursor: "pointer" }}>{t("chat.sessionLoadRetry")}</button>
        </div>
      ) : (loading || (!history.physicalScope && historyLoading)) && (
        <div role="status" style={{ padding: "4px 16px", color: "var(--text-muted)", fontSize: 12, flexShrink: 0 }}>{t("chat.sessionLoading")}</div>
      )}
      {hasUnconfirmedPrompt && (
        <div role="alert" style={{ padding: "8px 16px", borderBottom: "1px solid var(--border)", color: "var(--error)", fontSize: 12, flexShrink: 0 }}>
          {t("chat.promptDeliveryUnconfirmed")}
        </div>
      )}
      <div className="relative flex min-w-0 flex-1 overflow-hidden">
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 0,
            right: isMobile ? 0 : CHAT_MINIMAP_WIDTH,
            zIndex: 40,
            display: "flex",
            justifyContent: "center",
            padding: `0 ${CHAT_COLUMN_PADDING}px`,
            pointerEvents: "none",
          }}
        >
          <NoticeShelf notices={notices} floating onHoverChange={setNoticesHovered} onDismissOutside={dismissNotices} />
        </div>
        <div ref={scrollContainerRef} tabIndex={0} aria-busy={historyLoading} style={{ overflowAnchor: "none" }} className="chat-transcript min-w-0 flex-1 scrollbar-subtle overflow-x-hidden overflow-y-auto pt-4 [scrollbar-gutter:stable]">
          <div ref={highlightHostRef} style={{ position: "relative", minWidth: 0, padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
            <div ref={messageContentRef} style={{ width: "100%", minWidth: 0, maxWidth: "var(--chat-content-max-width, 90%)", margin: "0 auto" }}>
            <HistorySearchContent content={history.content.page} match={locatedSearchMatch} label={t("chat.findInSession")} />
            {(() => {
              const firstUserEntryId = session?.id
                ? transcript.firstUserEntryId
                : null;
              const firstUserIdx = session?.id
                ? (firstUserEntryId ? entryIds.indexOf(firstUserEntryId) : -1)
                : messages.findIndex((message) => message.role === "user" && !isSubagentWakeMessage(message));
              let lastUserIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === "user" && !isSubagentWakeMessage(messages[i])) { lastUserIdx = i; break; }
              }
              // Anchor for live-tail detection: the last user message, or a
              // compaction summary when compaction has replaced it mid-turn.
              // Computed independently from lastUserIdx (which is kept for the
              // scroll-to-user ref) because a compaction summary can sit after
              // the last user message and anchor the still-streaming segment.
              let lastAnchorIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (isResponseTurnAnchor(messages[i])
                  || (transcript.firstUserEntryId === null && i === 0 && isSessionControlDisplayMessage(messages[i]))) {
                  lastAnchorIdx = i;
                  break;
                }
              }

              const visibleRefIndexByMessage = new Map<number, number>();
              let refIdx = 0;
              messages.forEach((msg, idx) => {
                if (msg.role === "assistant" || (msg.role === "user" && !isSubagentWakeMessage(msg))) {
                  visibleRefIndexByMessage.set(idx, refIdx++);
                }
              });

              const attachVisibleRef = (idx: number, refIndex: number) => (el: HTMLDivElement | null) => {
                messageRefs.current[refIndex] = el;
                if (idx === lastUserIdx) { (lastUserMsgRef as { current: HTMLDivElement | null }).current = el; }
              };

              const renderMessage = (idx: number, options: { attachRef?: boolean; keyPrefix?: string; messageOverride?: AgentMessage; showTimestamp?: boolean; omitTurnUsage?: boolean; responseDurationMs?: number; modelWaitPercent?: number | null; writtenFiles?: WrittenFile[]; recoverTruncation?: boolean } = {}): ReactNode => {
                const msg = options.messageOverride ?? messages[idx];
                if (isTranscriptPlaceholder(msg)) return <div key={`placeholder-${entryIds[idx]}`} data-chat-message-row="true" data-entry-id={entryIds[idx]} data-message-role={msg.role} aria-hidden="true" />;
                if (msg.role === "user" && isSubagentWakeMessage(msg)) {
                  return null;
                }
                const prevAssistantEntryId =
                  msg.role === "user" && idx > 0 && messages[idx - 1].role === "assistant"
                    ? entryIds[idx - 1]
                    : undefined;
                const isVisible = msg.role === "user" || msg.role === "assistant";
                const currentRefIdx = visibleRefIndexByMessage.get(idx);
                const keyPrefix = options.keyPrefix ?? "message";
                let showTimestamp = false;
                if (msg.role === "assistant") {
                  showTimestamp = true;
                  for (let j = idx + 1; j < messages.length; j++) {
                    const r = messages[j].role;
                    if (r === "user" && !isSubagentWakeMessage(messages[j])) break;
                    if (r === "assistant") { showTimestamp = false; break; }
                  }
                  // A live assistant owns the current turn's timestamp. During
                  // gaps before its first snapshot, keep the last persisted time.
                  if (showTimestamp && isStreaming && hasStreamingContent) {
                    showTimestamp = false;
                  }
                }
                if (options.showTimestamp !== undefined) showTimestamp = options.showTimestamp;
                const turnUsage = options.omitTurnUsage ? undefined : turnUsageByAssistantIndex.get(idx);
                const calculatedCost = msg.role === "assistant"
                  ? turnUsage?.costAvailable === false
                    ? undefined
                    : turnUsage?.cost.total ?? (entryIds[idx] ? messageCosts[entryIds[idx]] : undefined)
                  : undefined;
                const view = (
                  <MessageView
                    key={getMessageRowKey(`${keyPrefix}-view`, occurrenceId(msg) ?? entryIds[idx], idx)}
                    message={msg}
                    renderProbe={renderProbe}
                    toolResults={toolResultsMap}
                    modelNames={modelNames}
                    cwd={messageCwd}
                    onOpenFile={onOpenFile}
                    entryId={entryIds[idx]}
                    onFork={bashRunning || isNew ? undefined : handleFork}
                    forking={forkingEntryId === entryIds[idx]}
                    onNavigate={sessionBusy || sideBranchPending ? undefined : handleNavigate}
                    prevAssistantEntryId={sessionBusy || sideBranchPending ? undefined : prevAssistantEntryId}
                    previousEntryId={sessionBusy || sideBranchPending || idx === 0 ? undefined : entryIds[idx - 1]}
                    isFirstUserMessage={idx === firstUserIdx}
                    onEditContent={sessionBusy || sideBranchPending ? undefined : handleEditContent}
                    onCancelEdit={cancelEdit}
                    isEditing={editEntryId === entryIds[idx]}
                    onCompact={options.recoverTruncation ? handleCompact : undefined}
                    isCompacting={options.recoverTruncation ? isCompacting : undefined}
                    compactError={options.recoverTruncation ? compactError : undefined}
                    showTimestamp={showTimestamp}
                    sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                    remotePeer={remotePeer}
                    calculatedCost={calculatedCost}
                    imageGenerationCosts={imageGenerationCosts}
                    compactionCost={msg.role === "custom" && entryIds[idx] ? compactionCosts[entryIds[idx]] : undefined}
                    compactionContext={msg.role === "custom" && entryIds[idx] ? compactionContexts[entryIds[idx]] : undefined}
                    questionAnalysisJob={entryIds[idx] ? questionAnalysisJobsByEntry.get(entryIds[idx]) : undefined}
                    questionDraftView={entryIds[idx] ? questionDraftViewByEntry.get(entryIds[idx]) : undefined}
                    turnUsage={turnUsage}
                    turnResources={options.omitTurnUsage ? undefined : turnResourcesByAssistantIndex.get(idx)}
                    responseDurationMs={options.responseDurationMs}
                    modelWaitPercent={options.modelWaitPercent}
                    writtenFiles={options.writtenFiles}
                    onStartSideBranch={sessionBusy || sideBranchPending ? undefined : handleCreateSideBranch}
                    isSideBranch={activeSideTabId !== "main"}
                  />
                );
                if (!isVisible || options.attachRef === false || currentRefIdx === undefined) {
                  return (
                    <div
                      key={getMessageRowKey(`${keyPrefix}-row`, occurrenceId(msg) ?? entryIds[idx], idx)}
                      data-chat-message-row="true"
                      data-entry-id={entryIds[idx] || occurrenceId(msg)}
                      data-message-role={msg.role}
                      data-message-model={msg.role === "assistant" ? ((msg as AssistantMessage).model || (typeof displayModelValue === "object" ? displayModelValue?.modelId : String(displayModelValue || ""))) : undefined}
                    >
                      {view}
                    </div>
                  );
                }
                return (
                  <div
                    key={getMessageRowKey(keyPrefix, occurrenceId(msg) ?? entryIds[idx], idx)}
                    ref={attachVisibleRef(idx, currentRefIdx)}
                    data-chat-message-row="true"
                    data-entry-id={entryIds[idx] || occurrenceId(msg)}
                    data-message-role={msg.role}
                    data-message-model={msg.role === "assistant" ? ((msg as AssistantMessage).model || (typeof displayModelValue === "object" ? displayModelValue?.modelId : String(displayModelValue || ""))) : undefined}
                  >
                    {view}
                  </div>
                );
              };

              const renderVisibleAssistantMessage = (idx: number): ReactNode => {
                const message = messages[idx];
                if (message.role !== "assistant") return renderMessage(idx);
                const views = getFinalAnswerViews(finalAnswerViewCache, message as AssistantMessage);
                const split = views.split;
                if (split.processBlocks.length === 0) return renderMessage(idx);
                if (split.answerBlocks.length === 0) {
                  return (
                    <div key={`hidden-process-${idx}`} data-session-search-exclude="true">
                      {renderMessage(idx, { attachRef: false, keyPrefix: "hidden-process" })}
                    </div>
                  );
                }
                return renderMessage(idx, { messageOverride: views.answer! });
              };

              const rendered: ReactNode[] = [];
              const currentActiveSideTab = activeSideTabId !== "main" ? sideTabs.find((t) => t.tabId === activeSideTabId) : null;
              const branchAnchorEntryId = currentActiveSideTab?.anchorLeafId;
              const branchAnchorIndex = branchAnchorEntryId ? entryIds.indexOf(branchAnchorEntryId) : -1;
              let hasRenderedBranchDivider = false;
              for (let idx = 0; idx < messages.length;) {
                const msg = messages[idx];
                if (branchAnchorIndex >= 0 && idx === branchAnchorIndex + 1 && !hasRenderedBranchDivider) {
                  hasRenderedBranchDivider = true;
                  rendered.push(
                    <div
                      key={`branch-divider-${idx}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        margin: "20px 16px 14px",
                        color: "var(--text-muted)",
                        fontSize: 11,
                        userSelect: "none",
                      }}
                    >
                      <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                      <span style={{ display: "flex", alignItems: "center", gap: 6, color: "#10b981", fontWeight: 500 }}>
                        🌿 {t("chat.branchDivider")}
                      </span>
                      <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                    </div>
                  );
                }
                const hasAnchor = isResponseTurnAnchor(msg)
                  || (transcript.firstUserEntryId === null && idx === 0 && isSessionControlDisplayMessage(msg));
                if (!hasAnchor && idx !== 0) {
                  rendered.push(renderVisibleAssistantMessage(idx));
                  idx += 1;
                  continue;
                }

                // A bounded history page may start inside a turn. Group its
                // leading segment while preserving Reader live-tail and branch routing.
                const userIdx = hasAnchor ? idx : -1;
                const groupStartIdx = hasAnchor ? idx : 0;
                let endIdx = idx + 1;
                while (endIdx < messages.length && !isResponseTurnAnchor(messages[endIdx])) endIdx += 1;

                const finalAssistantIdx = findFinalAssistantIndex(messages, userIdx, endIdx);
                const isCurrentTail = atLiveTail && endIdx === messages.length && userIdx === lastAnchorIdx;
                if (isCurrentTail && session?.id && sessionBusy) liveTailSessionRef.current = session.id;
                const finalAssistantMessage = messages[finalAssistantIdx];
                const unfinishedAssistantTail = isCurrentTail
                  && finalAssistantMessage?.role === "assistant"
                  && liveTailSessionRef.current === session?.id
                  && (finalAssistantMessage.stopReason === "toolUse" || !finalAssistantMessage.stopReason);
                if (
                  isCurrentTail
                  && finalAssistantMessage?.role === "assistant"
                  && finalAssistantMessage.stopReason
                  && finalAssistantMessage.stopReason !== "toolUse"
                  && liveTailSessionRef.current === session?.id
                ) liveTailSessionRef.current = null;
                const isLiveTail = (sessionBusy || unfinishedAssistantTail) && isCurrentTail;
                if (isLiveTail && !messages.slice(groupStartIdx, endIdx).some(isTranscriptPlaceholder)) {
                  // 流式或未结束的尾部回合不折叠；纯错误仍折叠，
                  // 但必须在原消息位置渲染，不能收集后统一追加到尾部。
                  for (const item of splitLiveTailItems(messages, groupStartIdx, endIdx)) {
                    if (item.kind === "errors") {
                      rendered.push(
                        <ProcessDetailsGroup
                          key={`live-process-group-${item.indices[0]}`}
                          messageCount={item.indices.length}
                          t={t}
                          toolCallCount={0}
                        >
                          {item.indices.map((errorIdx) => renderMessage(errorIdx, { attachRef: false, keyPrefix: "process" }))}
                        </ProcessDetailsGroup>,
                      );
                    } else {
                      for (const renderIdx of item.indices) rendered.push(renderVisibleAssistantMessage(renderIdx));
                    }
                  }
                  idx = endIdx;
                  continue;
                }

                if (hasAnchor) rendered.push(renderMessage(userIdx));

                const finalAssistant = messages[finalAssistantIdx] as AssistantMessage | undefined;
                const finalViews = finalAssistant ? getFinalAnswerViews(finalAnswerViewCache, finalAssistant) : null;
                // 纯错误与无正文过程行仍只进入默认收起的过程组。
                const finalProcessMessage = finalViews?.process ?? (finalAssistant && (isTranscriptPlaceholder(finalAssistant) || transcript.items.get(entryIds[finalAssistantIdx])?.process)
                  ? withAssistantBlocks(finalAssistant, [])
                  : null);
                const finalAnswerMessage = finalViews?.answer ?? null;
                const processIndices: number[] = [];
                for (let processIdx = userIdx + 1; processIdx < endIdx; processIdx++) {
                  if (processIdx !== finalAssistantIdx) processIndices.push(processIdx);
                }
                const visibleProcessIndices = processIndices.filter((processIdx) => {
                  const processMsg = messages[processIdx];
                  return hasDisplayableProcessMessage(processMsg, transcript.items.get(entryIds[processIdx])?.process)
                    || (processMsg?.role === "assistant"
                      && getAssistantErrorMessage(processMsg as AssistantMessage) !== null);
                });
                const processSegments = splitProcessRenderSegments(
                  messages,
                  visibleProcessIndices,
                  finalAssistantIdx,
                  finalProcessMessage,
                  finalAnswerMessage,
                );
                if (processSegments.length > 0) {
                  let processRefAssigned = false;
                  for (const [segmentIndex, segment] of processSegments.entries()) {
                    if (segment.kind === "answer") {
                      const turnContent: AssistantContentBlock[] = [];
                      for (let i = userIdx + 1; i <= finalAssistantIdx; i++) {
                        const message = messages[i];
                        if (message?.role === "assistant") for (const block of message.content ?? []) turnContent.push(block);
                      }
                      const writtenFiles = keepWrittenFiles(finalViews!, extractTurnWrittenFiles(turnContent, toolResultsMap, messageCwd));
                      const timingTurn = timingTurnByFinalIndex.get(finalAssistantIdx);
                      // The server adds subagents this turn started; until it answers, the main agent's own share is shown.
                      const sessionTurnTiming = timingTurn ? sessionTurnTimingByEntryId.get(entryIds[timingTurn.userIndex] ?? "") : undefined;
                      const localTurnTiming = timingTurn && !sessionTurnTiming ? summarizeTurns([timingTurn]) : undefined;
                      const responseDurationMs = sessionTurnTiming?.responseMs
                        ?? (timingTurn?.response ? timingTurn.response.end - timingTurn.response.start : undefined);
                      const modelWaitPercent = sessionTurnTiming
                        ? timingPercent(sessionTurnTiming.modelResponseMs, sessionTurnTiming.agentTotalMs)
                        : localTurnTiming ? timingPercent(localTurnTiming.modelMs, localTurnTiming.agentMs) : undefined;
                      rendered.push(renderMessage(segment.index, {
                        messageOverride: segment.message,
                        writtenFiles,
                        recoverTruncation: endIdx === messages.length && !sessionBusy && !isStreaming && !hasAssistantAnswer(segment.message),
                        responseDurationMs,
                        modelWaitPercent: responseDurationMs === undefined ? undefined : (modelWaitPercent ?? null),
                      }));
                      continue;
                    }
                    if (segment.kind === "session-control") {
                      rendered.push(renderMessage(segment.index, { attachRef: false, keyPrefix: "session-control" }));
                      continue;
                    }

                    const processRefIdx = !processRefAssigned
                      ? segment.items
                        .map((item) => item.kind === "message" ? visibleRefIndexByMessage.get(item.index) : undefined)
                        .find((value): value is number => typeof value === "number")
                        ?? (!finalAnswerMessage && segment.items.some((item) => item.kind === "final")
                          ? visibleRefIndexByMessage.get(finalAssistantIdx)
                          : undefined)
                      : undefined;
                    if (processRefIdx !== undefined) processRefAssigned = true;

                    const opened = openedProcessEntryId !== null && segment.items.some(item => entryIds[item.index] === openedProcessEntryId);
                    const processRange = { firstEntryId: entryIds[segment.items[0].index], lastEntryId: entryIds[segment.items.at(-1)!.index] };
                    const processReadState = processReadStates[processRange.firstEntryId];
                    const turnEntryId = userIdx >= 0 ? entryIds[userIdx]
                      : transcript.items.get(entryIds[groupStartIdx])?.turnAnchor?.entryId ?? entryIds[groupStartIdx];
                    rendered.push(
                      <div
                        key={`process-group-${finalAnswerMessage ? "answered" : "unanswered"}-${turnEntryId}-${segmentIndex}-${opened ? openedProcessEntryId : "folded"}`}
                        data-history-process-entry={opened ? openedProcessEntryId : undefined}
                        ref={processRefIdx === undefined ? undefined : (el) => { messageRefs.current[processRefIdx] = el; }}
                      >
                        <ProcessDetailsGroup
                          initiallyExpanded={opened}
                          active={isLiveTail}
                          loading={processReadState?.loading}
                          loadError={processReadState?.error}
                          onExpand={() => {
                            if (!processReadState?.loading && (processReadState?.error || segment.items.some(item => transcript.items.get(entryIds[item.index])?.contentState !== "full"))) void readHistoryProcess(processRange, !isLiveTail);
                          }}
                          messageCount={segment.items.length}
                          t={t}
                          toolCallCount={segment.items.reduce((total, item) => total + (transcript.items.get(entryIds[item.index])?.toolCallCount ?? countToolCalls(messages, [item.index])), 0)}
                        >
                          {segment.items.map((item) => item.kind === "message"
                            ? renderMessage(item.index, { attachRef: false, keyPrefix: "process" })
                            : renderMessage(item.index, { attachRef: false, keyPrefix: "process-final", messageOverride: item.message, showTimestamp: false, omitTurnUsage: true }))}
                        </ProcessDetailsGroup>
                      </div>,
                    );
                  }
                }

                idx = endIdx;
              }
              if (currentActiveSideTab && !hasRenderedBranchDivider && !isStreaming) {
                rendered.push(
                  <div
                    key="branch-divider-pending"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      margin: "20px 16px 14px",
                      color: "var(--text-muted)",
                      fontSize: 11,
                      userSelect: "none",
                    }}
                  >
                    <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                    <span style={{ display: "flex", alignItems: "center", gap: 6, color: "#10b981", fontWeight: 500 }}>
                      🌿 {t("chat.branchDividerPending")}
                    </span>
                    <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                  </div>
                );
              }
              return (
                <>
                  {hasEarlierMessages && (
                    <div ref={topSentinelRef} data-history-sentinel="earlier"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        height: 28,
                        padding: "4px 0 8px",
                        fontSize: 12,
                        color: "var(--text-muted)",
                        userSelect: "none",
                        overflow: "hidden",
                      }}
                    >
                      {historyLoading && (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-solid border-current border-r-transparent" />
                          {t("chat.expandingHistory")}
                        </span>
                      )}
                    </div>
                  )}
                  {rendered}
                  {!atLiveTail && <div ref={bottomSentinelRef} style={{ height: 28 }} role="status">{historyLoading ? t("chat.expandingHistory") : ""}</div>}
                </>
              );
            })()}
            {isStreaming && hasStreamingContent && (
              <StreamingReply
                store={streamingStore}
                onCommit={updatePromptAnchor}
                toolResults={toolResultsMap}
                modelNames={modelNames}
                cwd={messageCwd}
                onOpenFile={onOpenFile}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                remotePeer={remotePeer}
                imageGenerationCosts={imageGenerationCosts}
                messageRef={streamingMessageRef}
                renderProbe={renderProbe}
              />
            )}

            {agentRunning && !hasStreamingContent && (agentPhase || isCompacting) && (
              <div className="py-2 text-[13px] text-text-muted">
                <span className="animate-[pulse_1.5s_infinite]">{phaseLabel(agentPhase, t, isCompacting)}</span>
              </div>
            )}

            {bashRunning && !pendingBash && (
              <div className="py-2 text-[13px] text-text-muted">
                 <span className="animate-[pulse_1.5s_infinite]">{t("chat.runningCommand")}</span>
              </div>
            )}

            {pendingBash && (
              <MessageView
                renderProbe={renderProbe}
                message={{
                  role: "bashExecution",
                  command: pendingBash.command,
                  output: "",
                  excludeFromContext: pendingBash.excludeFromContext,
                } as BashExecutionMessage}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
              />
            )}

            <div ref={promptAnchorSpacerRef} aria-hidden="true" />
            </div>
            {(quoteHighlights.length > 0 || sessionSearchRanges.length > 0) && (
              <TranscriptHighlights hostRef={highlightHostRef} contentRef={messageContentRef} quotes={quoteHighlights}
                searchRanges={sessionSearchRanges} flashingQuoteId={flashingQuoteId} onBadgeClick={handleEditQuote}
                onBadgeHover={handleQuoteBadgeHover} onBadgeLeave={scheduleBadgePreviewClose} />
            )}
          </div>
        </div>
        {isMobile ? null : (
          <ChatMinimap
            messages={messages}
            entryIds={entryIds}
            scopeKey={`${remotePeer ?? "local"}:${session?.id ?? sessionIdRef.current ?? "draft"}:${activeLeafId ?? "root"}`}
            streamingStore={streamingStore}
            atLiveTail={atLiveTail}
            scrollContainer={scrollContainerRef}
            messageRefs={messageRefs}
            streamingMessageRef={streamingMessageRef}
            onReadHistory={beginHistoryReading}
            onScrollToEntry={scrollToMessage}
            onScrollToBottom={() => void revealLatestHistory()}
            historyNodes={historyNodes}
            historyNodeCount={historyNodeCount}
            onNavigateEntry={reader.goToEntry}
            onLoadNodePage={reader.goToNodeIndex}
          />
        )}
      </div>

      <div className="relative">
        {!isEmptyNew && (
          <div
            style={{
              position: "absolute",
              bottom: "100%",
              left: 0,
              right: isMobile ? 0 : CHAT_MINIMAP_WIDTH,
              display: "flex",
              justifyContent: "center",
              paddingBottom: 10,
              pointerEvents: "none",
              zIndex: 20,
            }}
          >
            <button
              type="button"
              className={`chat-scroll-to-bottom${(showScrollToBottom || !atLiveTail || !follow) ? " is-visible" : ""}`}
              title={t("chat.scrollToLatest")}
              style={history.unseenEntryIds.size ? { width: "auto", minWidth: 32, padding: "0 8px", gap: 4 } : undefined}
              aria-label={`${t("chat.scrollToLatest")}${history.unseenEntryIds.size ? ` · ${history.unseenEntryIds.size}` : ""}`}
              onClick={() => {
                void revealLatestHistory();
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14M5 12l7 7 7-7" />
              </svg>
              {history.unseenEntryIds.size > 0 && <span aria-hidden="true">{history.unseenEntryIds.size}</span>}
            </button>
          </div>
        )}
        {chatInputElement}
        <ExtensionStatusBar statuses={extensionStatuses} widgets={extensionWidgets} sessionId={session?.id} remotePeer={remotePeer} />
      </div>
      </>
      )}
      {session && (
        <SidekickDrawer
          sessionId={session.id}
          open={sidekickIsOpen || sidekickRightPanelIsOpen}
          historyRevision={sidekickHistoryRevision}
          onClose={closeSidekick}
          onQuoteToComposer={(text) => chatInputRef?.current?.insertIfEmpty(text)}
          mainBusy={sessionBusy}
          activeBranchId={activeSideTabId}
          activeParentId={sidekickParentId}
          remotePeer={remotePeer}
          onSessionForked={onSessionForked}
          onCountChange={onSidekickCountChange}
          placement={sidekickRightPanelIsOpen ? "right-panel" : "sidebar"}
          rightPanelTargetId={SIDEKICK_RIGHT_PANEL_TARGET_ID}
          modelList={modelList}
          modelNames={modelNames}
          defaultModel={displayModelValue}
          modelThinkingLevels={modelThinkingLevels}
          modelThinkingLevelMaps={modelThinkingLevelMaps}
          defaultThinkingLevel={thinkingLevel}
        />
      )}
      {!onSelectionToolbarChange && selectionTooltip && typeof document !== "undefined" && createPortal(
        <div
          ref={selectionTooltipRef}
          role="toolbar"
          aria-label={t("chat.askSelection")}
          style={{
            position: "fixed",
            top: selectionTooltip.top,
            left: selectionTooltip.left,
            transform: "translateX(-50%)",
            zIndex: 1300,
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "4px 8px",
            borderRadius: 8,
            background: "var(--bg, #ffffff)",
            border: "1px solid var(--border, #e5e7eb)",
            boxShadow: "0 6px 20px rgba(0, 0, 0, 0.16)",
            fontSize: 12,
          }}
        >
          <SelectionToolbarButtons
            actions={{
              askCurrent: handleQuoteSelection,
              askSidekick: handleQuoteToSidekick,
              dismiss: clearSelectionTooltip,
            }}
            labels={{
              askInCurrent: t("chat.askInCurrent"),
              askInSidekick: t("chat.askInSidekick"),
              close: t("i18n.close"),
            }}
          />
        </div>,
        document.body
      )}
      {hoveredBadgeInfo && typeof document !== "undefined" && createPortal(
        <div
          onMouseEnter={keepBadgePreviewOpen}
          onMouseLeave={scheduleBadgePreviewClose}
          style={{
            position: "fixed",
            top: hoveredBadgeInfo.top > 60 ? hoveredBadgeInfo.top : hoveredBadgeInfo.top + 18,
            left: hoveredBadgeInfo.left,
            transform: hoveredBadgeInfo.top > 60 ? "translate(-50%, -100%)" : "translate(-50%, 0)",
            zIndex: 1400,
            background: "var(--bg, #ffffff)",
            border: "1px solid var(--border, #e5e7eb)",
            borderRadius: 8,
            boxShadow: "0 6px 20px rgba(0, 0, 0, 0.15)",
            fontSize: 12,
            lineHeight: 1.5,
            color: "var(--text, #111827)",
            maxWidth: 380,
            minWidth: 100,
            wordBreak: "break-word",
            whiteSpace: "pre-wrap",
            maxHeight: "calc(100dvh - 24px)",
            overflowY: "auto",
            overflowX: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div className="quote-preview-actions">
            <button
              type="button"
              onClick={() => handleRemoveQuote(hoveredBadgeInfo.quote.id)}
              className="quote-delete-button"
              aria-label={t("quote.delete")}
              title={t("quote.delete")}
            >
              <Trash2 size={13} />
              {t("i18n.delete")}
            </button>
          </div>
          <div className="quote-preview-content">
            <section className="quote-preview-source" aria-label={t("quote.selectedText")} style={{ cursor: "default" }}>
              {hoveredBadgeInfo.quote.text}
            </section>
            <section className="quote-preview-comment" aria-label={t("quote.userComment")}>
              <span className="quote-preview-comment-label">Reply:</span>{" "}
              <span className="quote-preview-comment-text">
                {hoveredBadgeInfo.quote.reply || t("quote.noComment")}
              </span>
            </section>
          </div>
        </div>,
        document.body
      )}
      {!embeddedInParent && annotationModal?.isOpen && (
        <QuoteAnnotationModal
          isOpen={annotationModal.isOpen}
          quoteText={annotationModal.quoteText}
          initialReply={annotationModal.initialReply}
          onConfirm={handleConfirmAnnotation}
          onDelete={annotationModal.mode === "edit" ? () => {
            if (annotationModal.quoteId) handleRemoveQuote(annotationModal.quoteId);
          } : undefined}
          onClose={() => setAnnotationModal(null)}
        />
      )}
    </div>
  );
}

const StreamingReply = memo(function StreamingReply({
  store,
  onCommit,
  toolResults,
  modelNames,
  cwd,
  onOpenFile,
  sessionId,
  remotePeer,
  imageGenerationCosts,
  messageRef,
  renderProbe,
}: {
  store: StreamingStore;
  onCommit: () => void;
  toolResults: Map<string, ToolResultMessage>;
  modelNames: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  sessionId?: string;
  remotePeer?: string;
  imageGenerationCosts: readonly ImageGenerationCost[];
  messageRef: React.RefObject<HTMLDivElement | null>;
  renderProbe?: (component: "ChatWindow" | "MessageView" | "StreamingReply", entryId?: string, streaming?: boolean) => void;
}) {
  renderProbe?.("StreamingReply");
  const message = useStreamingSelector(store, selectStreamingMessage);
  useLayoutEffect(onCommit, [message, onCommit]);
  if (!message) return null;
  const split = splitFinalAssistantBlocks(message);
  const searchableMessage = split.processBlocks.length > 0 && split.answerBlocks.length > 0
    ? withAssistantBlocks(message, split.answerBlocks)
    : message;
  const view = (
    <MessageView
      message={searchableMessage}
      renderProbe={renderProbe}
      isStreaming
      showTimestamp={true}
      toolResults={toolResults}
      modelNames={modelNames}
      cwd={cwd}
      onOpenFile={onOpenFile}
      sessionId={sessionId}
      remotePeer={remotePeer}
      imageGenerationCosts={imageGenerationCosts}
    />
  );
  return (
    <div ref={messageRef} data-chat-message-row="true">
      {split.processBlocks.length > 0 && split.answerBlocks.length === 0
        ? <div data-session-search-exclude="true">{view}</div>
        : view}
    </div>
  );
});

type ExtensionDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;

function getExtensionDialogSummary(request: ExtensionDialogRequest): string | undefined {
  if (request.method === "select" && request.options.length > 0) return request.options[0];
  if (request.method === "confirm") {
    const firstLine = request.message.split("\n").find((line) => line.trim());
    return firstLine?.trim();
  }
  return undefined;
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

type CustomEditorCursor = { line: number; column: number };
type CustomEditorSnapshot = {
  bounds: { start: number; end: number };
  text: string;
  cursor: CustomEditorCursor;
};

function renderAnsiSegments(line: string, keyPrefix: string, cursorTextOffset?: number): ReactNode[] {
  const nodes: ReactNode[] = [];
  let remainingCursorOffset = cursorTextOffset;
  const renderSegment = (text: string, style: React.CSSProperties, key: string) => {
    if (!text) return;
    nodes.push(Object.keys(style).length > 0
      ? <span key={key} style={style}>{text}</span>
      : text);
  };

  parseAnsiLine(line).forEach((segment, index) => {
    if (remainingCursorOffset === undefined) {
      renderSegment(segment.text, segment.style, `${keyPrefix}-${index}`);
      return;
    }

    if (remainingCursorOffset <= segment.text.length) {
      renderSegment(segment.text.slice(0, remainingCursorOffset), segment.style, `${keyPrefix}-${index}-before`);
      nodes.push(<span key={`${keyPrefix}-cursor`} className="extension-custom-caret" aria-hidden="true" />);
      renderSegment(segment.text.slice(remainingCursorOffset), segment.style, `${keyPrefix}-${index}-after`);
      remainingCursorOffset = undefined;
      return;
    }

    renderSegment(segment.text, segment.style, `${keyPrefix}-${index}`);
    remainingCursorOffset -= segment.text.length;
  });

  if (remainingCursorOffset !== undefined) {
    nodes.push(<span key={`${keyPrefix}-cursor`} className="extension-custom-caret" aria-hidden="true" />);
  }
  return nodes;
}

function renderAnsiLine(line: string, keyPrefix: string): ReactNode[] {
  const cursorIndex = line.indexOf(TUI_CURSOR_MARKER);
  if (cursorIndex < 0) return renderAnsiSegments(line, keyPrefix);
  const lineWithoutCursor = line.slice(0, cursorIndex) + line.slice(cursorIndex + TUI_CURSOR_MARKER.length);
  return renderAnsiSegments(lineWithoutCursor, keyPrefix, stripAnsi(line.slice(0, cursorIndex)).length);
}

function countGraphemes(text: string): number {
  if (typeof Intl.Segmenter === "function") {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)).length;
  }
  return Array.from(text).length;
}

function getCustomEditorSnapshot(lines: string[]): CustomEditorSnapshot | null {
  const cursorLine = lines.findIndex((line) => line.includes(TUI_CURSOR_MARKER));
  let bounds: { start: number; end: number };
  let editorCursorLine: number;
  if (cursorLine >= 0) {
    bounds = findCustomEditorLineBounds(lines, cursorLine);
    editorCursorLine = cursorLine;
  } else {
    const responseLabelLine = lines.findIndex((line) => stripAnsi(line).trim().toLowerCase() === "custom response");
    const editorTopRule = responseLabelLine >= 0
      ? lines.findIndex((line, index) => index > responseLabelLine && isCustomEditorRule(line))
      : -1;
    const editorBottomRule = editorTopRule >= 0
      ? lines.findIndex((line, index) => index > editorTopRule && isCustomEditorRule(line))
      : -1;
    if (editorTopRule < 0 || editorBottomRule <= editorTopRule + 1) return null;
    bounds = { start: editorTopRule + 1, end: editorBottomRule - 1 };
    editorCursorLine = bounds.end;
  }
  const editorLines = lines.slice(bounds.start, bounds.end + 1);
  const markerIndex = lines[editorCursorLine]?.indexOf(TUI_CURSOR_MARKER) ?? -1;
  const cursorPrefix = markerIndex >= 0
    ? stripAnsi(lines[editorCursorLine]?.slice(0, markerIndex) ?? "")
    : stripAnsi(editorLines[editorLines.length - 1] ?? "");
  return {
    bounds,
    text: editorLines.map(stripAnsi).join("\n"),
    cursor: {
      line: editorCursorLine - bounds.start,
      column: cursorPrefix.length,
    },
  };
}

function getTextCursor(text: string, offset: number): CustomEditorCursor {
  const clampedOffset = Math.max(0, Math.min(text.length, Math.trunc(offset)));
  const before = text.slice(0, clampedOffset);
  const lastNewline = before.lastIndexOf("\n");
  return {
    line: (before.match(/\n/g)?.length ?? 0),
    column: lastNewline >= 0 ? before.length - lastNewline - 1 : before.length,
  };
}

function getTextEdit(previousText: string, nextText: string): { start: number; end: number; inserted: string } {
  let start = 0;
  while (start < previousText.length && start < nextText.length && previousText[start] === nextText[start]) start += 1;

  let suffix = 0;
  while (
    suffix < previousText.length - start
    && suffix < nextText.length - start
    && previousText[previousText.length - suffix - 1] === nextText[nextText.length - suffix - 1]
  ) suffix += 1;

  return {
    start,
    end: previousText.length - suffix,
    inserted: nextText.slice(start, nextText.length - suffix),
  };
}

function isCustomEditorRule(line: string): boolean {
  const plain = stripAnsi(line).trim();
  return plain.length >= 3 && /^[-─━═]+$/.test(plain);
}

function findCustomEditorLineBounds(lines: string[], cursorLine: number): { start: number; end: number } {
  let start = cursorLine;
  while (start > 0 && !isCustomEditorRule(lines[start - 1] ?? "")) start -= 1;
  let end = cursorLine;
  while (end + 1 < lines.length && !isCustomEditorRule(lines[end + 1] ?? "")) end += 1;
  return {
    start: start > 0 ? start : cursorLine,
    end: end + 1 < lines.length ? end : cursorLine,
  };
}

function getTextOffset(text: string, cursor: CustomEditorCursor): number {
  const lines = text.split("\n");
  const beforeLines = lines.slice(0, Math.max(0, cursor.line));
  const line = lines[cursor.line] ?? "";
  return beforeLines.reduce((offset, value) => offset + value.length + 1, 0)
    + Math.min(Math.max(0, cursor.column), line.length);
}

function renderAnsiLineRange(lines: string[], start: number, end: number, keyPrefix: string): ReactNode[] {
  if (start > end) return [];
  const nodes: ReactNode[] = [];
  for (let index = start; index <= end; index += 1) {
    nodes.push(<Fragment key={`${keyPrefix}-${index}`}>{renderAnsiLine(lines[index] ?? "", `${keyPrefix}-line-${index}`)}</Fragment>);
    if (index < end) nodes.push("\n");
  }
  return nodes;
}

interface ExtensionDialogPreviewSection {
  label: string;
  optionIndex: number | null;
  text: string;
}

function normalizeExtensionDialogText(text: string): string {
  return text.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
}

function addSlashBreakOpportunities(text: string): string {
  return text.replace(/([A-Za-z0-9_.-]+\/)(?=[A-Za-z0-9_.-])/g, "$1\u200b");
}

function parseExtensionDialogTitle(rawTitle: string): {
  badge: string | null;
  title: string;
  formattedTitle: string;
  previews: ExtensionDialogPreviewSection[];
} {
  const normalized = normalizeExtensionDialogText(rawTitle);
  const previewHeaderRegex = /\n*\s*---\s*(.+?)\s*preview\s*---\s*\n?/gi;
  const matches = Array.from(normalized.matchAll(previewHeaderRegex));
  const rawMainTitle = (matches.length > 0 ? normalized.slice(0, matches[0].index) : normalized).trim();
  const badgeMatch = rawMainTitle.match(/^\[([^\][\r\n]{1,24})\]\s*([\s\S]*)$/);
  const badge = badgeMatch ? badgeMatch[1].trim() : null;
  const title = (badgeMatch && badgeMatch[2].trim() ? badgeMatch[2].trim() : rawMainTitle).trim();

  const previews: ExtensionDialogPreviewSection[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    const sectionStart = (current.index ?? 0) + current[0].length;
    const sectionEnd = i + 1 < matches.length ? (matches[i + 1].index ?? normalized.length) : normalized.length;
    const rawLabel = current[1].trim();
    const rawBody = normalized
      .slice(sectionStart, sectionEnd)
      .trim()
      .replace(/^\|\s?/gm, "")
      .trim();
    if (!rawBody || rawBody === "|") continue;
    const indexMatch = rawLabel.match(/^(\d+)\.\s*(.+)$/);
    const parsedIndex = indexMatch ? Number.parseInt(indexMatch[1], 10) - 1 : null;
    previews.push({
      label: rawLabel,
      optionIndex: parsedIndex !== null && parsedIndex >= 0 ? parsedIndex : null,
      text: rawBody,
    });
  }

  return {
    badge,
    title,
    formattedTitle: addSlashBreakOpportunities(title),
    previews,
  };
}

/** "+N more": requests of the same kind queued behind the one on screen, each shown once that one closes. */
function ExtensionWaitingCount({ count }: { count: number }) {
  const { t } = useI18n();
  if (count <= 0) return null;
  return (
    <span style={{ fontSize: 11, fontWeight: 650, color: "var(--accent)", whiteSpace: "nowrap", flexShrink: 0 }}>
      {t("chat.extensionMoreWaiting", { count })}
    </span>
  );
}

function ExtensionDialog({
  request,
  waitingCount,
  onRespond,
}: {
  request: ExtensionDialogRequest;
  /** Further dialogs queued behind this one; each opens after this one is answered. */
  waitingCount: number;
  onRespond: (request: ExtensionDialogRequest, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");
  const [collapsed, setCollapsed] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const dialogSurfaceRef = useRef<HTMLDivElement | null>(null);
  const inputCompositionActiveRef = useRef(false);
  const inputCompositionEndAtRef = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  const summary = getExtensionDialogSummary(request);
  const isSelect = request.method === "select";
  const remainingSeconds = request.expiresAt === undefined
    ? null
    : Math.max(0, Math.ceil((request.expiresAt - now) / 1000));

  const parsedTitle = useMemo(() => parseExtensionDialogTitle(request.title), [request.title]);

  const activePreview = useMemo(() => {
    if (parsedTitle.previews.length === 0) return null;
    return (
      parsedTitle.previews.find((item) => item.optionIndex === selectedIndex)
      ?? parsedTitle.previews[Math.min(selectedIndex, parsedTitle.previews.length - 1)]
      ?? parsedTitle.previews[0]
    );
  }, [parsedTitle.previews, selectedIndex]);

  const moveSelection = useCallback((delta: -1 | 1) => {
    if (request.method !== "select" || request.options.length === 0) return;
    const next = (selectedIndex + delta + request.options.length) % request.options.length;
    setSelectedIndex(next);
    requestAnimationFrame(() => optionRefs.current[next]?.focus());
  }, [request, selectedIndex]);

  const confirmSelection = useCallback(() => {
    if (request.method !== "select") return;
    const option = request.options[selectedIndex];
    if (option) onRespond(request, { value: option });
  }, [onRespond, request, selectedIndex]);

  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
    if (request.method !== "select") return;
    setSelectedIndex(0);
    requestAnimationFrame(() => optionRefs.current[0]?.focus());
  }, [request]);

  useEffect(() => {
    if (request.expiresAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request.expiresAt]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const activeElement = typeof document === "undefined" ? null : document.activeElement;
      const nativeModalOwned = isForeignNativeModalOwner(event.target, activeElement, dialogSurfaceRef.current);
      handleExtensionDialogEscape(
        event,
        () => onRespond(request, { cancelled: true }),
        { nativeModalOwned },
      );
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onRespond, request]);

  useEffect(() => {
    if (request.method !== "select") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (request.options.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        moveSelection(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (/^[1-9]$/.test(event.key)) {
        const optionIndex = parseInt(event.key, 10) - 1;
        if (optionIndex < request.options.length) {
          event.preventDefault();
          event.stopPropagation();
          setSelectedIndex(optionIndex);
          requestAnimationFrame(() => optionRefs.current[optionIndex]?.focus());
          return;
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [moveSelection, request]);

  const countdown = remainingSeconds !== null && (
    <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap", flexShrink: 0 }}>
      {t("chat.extensionExpiresIn", { seconds: remainingSeconds })}
    </span>
  );

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true });
    } else {
      onRespond(request, { value });
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: collapsed ? "flex-start" : "center",
        justifyContent: "center",
        padding: 20,
        pointerEvents: "none",
      }}
    >
      {!collapsed && (
        <div
          onClick={() => onRespond(request, { cancelled: true })}
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0, 0, 0, 0.4)",
            pointerEvents: "auto",
          }}
        />
      )}
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          style={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            maxWidth: "min(560px, 100%)",
            width: "100%",
            padding: "9px 12px",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-panel)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
            color: "var(--text)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 650, color: "var(--accent)", flexShrink: 0 }}>
            {t("chat.extensionPending")}{request.sideAskRunId ? ` · ${t("sidekick.title")}${request.sideAskLabel ? ` · ${request.sideAskLabel}` : ""}` : ""}
          </span>
          <span style={{ fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {parsedTitle.title}
          </span>
          {summary && (
            <span style={{ fontSize: 11.5, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "34%", flexShrink: 1 }}>
              {summary}
            </span>
          )}
          <ExtensionWaitingCount count={waitingCount} />
          {countdown}
          <span style={{ fontSize: 11.5, color: "var(--text-muted)", flexShrink: 0 }}>
            {t("chat.extensionExpand")}
          </span>
        </button>
      ) : (
      <div
        ref={dialogSurfaceRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${request.sideAskRunId ? `${t("sidekick.title")}${request.sideAskLabel ? ` · ${request.sideAskLabel}` : ""}: ` : ""}${parsedTitle.title || request.title}`}
        className="extension-dialog-surface"
        style={{
          position: "relative",
          zIndex: 1,
          pointerEvents: "auto",
          width: "min(560px, 100%)",
          maxHeight: "min(680px, 100%)",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg-panel)",
          boxShadow: "0 12px 36px rgba(0, 0, 0, 0.24)",
          overflow: "hidden",
        }}
      >
        <div
          className="extension-custom-header"
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            minHeight: 38,
            padding: "6px 10px 6px 14px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
          }}
        >
          <div
            className="extension-custom-header-title"
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 8,
              flex: 1,
              minWidth: 0,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 650, color: "var(--text-muted)" }}>
              {t("chat.extensionRequest")}{request.sideAskRunId ? ` · ${t("sidekick.title")}${request.sideAskLabel ? ` · ${request.sideAskLabel}` : ""}` : ""}
            </span>
            {parsedTitle.badge && (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: "1px 6px",
                  borderRadius: 4,
                  background: "var(--bg-selected)",
                  color: "var(--accent)",
                  border: "1px solid color-mix(in srgb, var(--accent) 28%, var(--border))",
                  lineHeight: 1.35,
                }}
              >
                {parsedTitle.badge}
              </span>
            )}
            <ExtensionWaitingCount count={waitingCount} />
            {countdown}
          </div>
          <div className="extension-custom-header-actions" style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
            <button
              type="button"
              className="config-close-button"
              onClick={() => setCollapsed(true)}
              aria-expanded={true}
              title={t("chat.extensionCollapse")}
              aria-label={t("chat.extensionCollapse")}
              style={{ marginLeft: 0, width: 26, height: 26 }}
            >
              <ChevronDown size={15} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="config-close-button"
              onClick={() => onRespond(request, { cancelled: true })}
              title={`${t("chat.cancel")} · Esc`}
              aria-label={`${t("chat.cancel")} · Esc`}
              style={{ marginLeft: 0, width: 26, height: 26 }}
            >
              <X size={15} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div
          className="extension-dialog-body"
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            overflowY: "auto",
            padding: "14px 16px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div
            className="extension-dialog-question"
            style={{
              color: "var(--text)",
              fontSize: 13,
              fontWeight: 600,
              lineHeight: 1.6,
              textAlign: "justify",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              overflowWrap: "anywhere",
            }}
          >
            {parsedTitle.formattedTitle}
          </div>

          {activePreview && (
            <div
              className="extension-dialog-preview"
              style={{
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 4,
                  padding: "6px 10px",
                  borderBottom: "1px solid var(--border)",
                  background: "var(--bg-panel)",
                }}
              >
                {parsedTitle.previews.length > 1 ? (
                  parsedTitle.previews.map((item, idx) => {
                    const isCurrent = item === activePreview;
                    return (
                      <button
                        key={`${item.label}-${idx}`}
                        type="button"
                        onClick={() => {
                          if (item.optionIndex !== null && request.method === "select" && item.optionIndex < request.options.length) {
                            setSelectedIndex(item.optionIndex);
                          }
                        }}
                        style={{
                          padding: "2px 8px",
                          borderRadius: 4,
                          border: `1px solid ${isCurrent ? "var(--accent)" : "transparent"}`,
                          background: isCurrent ? "var(--bg-selected)" : "transparent",
                          color: isCurrent ? "var(--accent)" : "var(--text-muted)",
                          fontSize: 11.5,
                          fontWeight: isCurrent ? 600 : 500,
                          cursor: "pointer",
                          lineHeight: 1.4,
                        }}
                      >
                        {item.label}
                      </button>
                    );
                  })
                ) : (
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--accent)" }}>
                    {activePreview.label}
                  </span>
                )}
              </div>
              <div style={{ padding: "10px 12px" }}>
                <MarkdownBody>{activePreview.text}</MarkdownBody>
              </div>
            </div>
          )}

          {request.method === "confirm" && (
            <MarkdownBody>{request.message}</MarkdownBody>
          )}
          {request.method === "select" && (
            <div style={{ display: "grid", gap: 6 }}>
              {request.options.map((option, index) => {
                const isSelected = selectedIndex === index;
                return (
                  <div
                    key={option}
                    role="button"
                    tabIndex={0}
                    data-extension-option
                    aria-label={option}
                    aria-pressed={isSelected}
                    ref={(element) => { optionRefs.current[index] = element; }}
                    onClick={() => onRespond(request, { value: option })}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      onRespond(request, { value: option });
                    }}
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 9,
                      padding: "8px 11px",
                      borderRadius: 6,
                      border: `1px solid ${isSelected ? "var(--accent)" : "var(--border)"}`,
                      background: isSelected ? "var(--bg-selected)" : "var(--bg)",
                      color: "var(--text)",
                      cursor: "pointer",
                      textAlign: "left",
                      fontSize: 12.5,
                      lineHeight: 1.5,
                      overflowWrap: "anywhere",
                      transition: "background-color 0.12s ease, border-color 0.12s ease",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className="extension-dialog-kbd"
                      style={{
                        flexShrink: 0,
                        minWidth: 18,
                        boxSizing: "border-box",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        marginTop: 2,
                        color: isSelected ? "var(--accent)" : "var(--text-dim)",
                        borderColor: isSelected ? "color-mix(in srgb, var(--accent) 45%, var(--border))" : "var(--border)",
                        background: isSelected ? "color-mix(in srgb, var(--accent) 12%, var(--bg-panel))" : "var(--bg-panel)",
                        fontWeight: isSelected ? 650 : 500,
                        transition: "color 0.12s ease, border-color 0.12s ease, background-color 0.12s ease",
                      }}
                    >
                      {index + 1}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div inert>
                        <MarkdownBody>{option}</MarkdownBody>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {request.method === "input" && (
            <input
              autoFocus
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                handleExtensionDialogInputKeyDown(
                  e.nativeEvent,
                  inputCompositionActiveRef.current,
                  inputCompositionEndAtRef.current,
                  submitValue,
                );
              }}
              onCompositionStart={() => {
                inputCompositionActiveRef.current = true;
              }}
              onBlur={() => {
                inputCompositionEndAtRef.current = getExtensionDialogInputCompositionEndAtOnBlur(
                  inputCompositionActiveRef.current,
                  inputCompositionEndAtRef.current,
                );
                inputCompositionActiveRef.current = false;
              }}
              onCompositionEnd={() => {
                inputCompositionActiveRef.current = false;
                inputCompositionEndAtRef.current = Date.now();
              }}
              style={{
                width: "100%",
                padding: "7px 10px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 5,
                color: "var(--text)",
                fontSize: 12.5,
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              rows={8}
              style={{
                width: "100%",
                padding: "8px 10px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 5,
                color: "var(--text)",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                outline: "none",
                resize: "vertical",
                boxSizing: "border-box",
              }}
            />
          )}
        </div>

        <div
          className="extension-dialog-footer"
          style={{
            flex: "0 0 auto",
            padding: "8px 14px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-panel)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          {isSelect ? (
            <div
              role="group"
              aria-label={t("chat.extensionNavigation")}
              className="extension-dialog-stepper"
            >
              <button
                type="button"
                className="extension-dialog-step-btn"
                onClick={() => moveSelection(-1)}
                title={t("chat.extensionMoveUp")}
                aria-label={t("chat.extensionMoveUp")}
              >
                <ChevronUp size={14} strokeWidth={1.8} aria-hidden="true" />
              </button>
              <span className="extension-dialog-step-count">
                {selectedIndex + 1}/{request.options.length}
              </span>
              <button
                type="button"
                className="extension-dialog-step-btn"
                onClick={() => moveSelection(1)}
                title={t("chat.extensionMoveDown")}
                aria-label={t("chat.extensionMoveDown")}
              >
                <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </div>
          ) : <span />}

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              className="config-button config-button-small config-button-secondary"
              // A modal request takes focus; with nothing to choose or type, the safe Cancel holds it.
              autoFocus={request.method === "confirm" || (request.method === "select" && request.options.length === 0)}
              onClick={() => onRespond(request, { cancelled: true })}
              title={`${t("chat.cancel")} · Esc`}
              aria-label={`${t("chat.cancel")} · Esc`}
              style={{ background: "var(--bg)", gap: 5 }}
            >
              <span>{t("chat.cancel")}</span>
              <span className="extension-dialog-kbd">Esc</span>
            </button>
            <button
              type="button"
              className="config-button config-button-small config-button-primary"
              onClick={isSelect ? confirmSelection : submitValue}
              title={isSelect ? t("chat.extensionConfirm") : undefined}
              aria-label={isSelect ? t("chat.extensionConfirm") : undefined}
              style={{ gap: 5 }}
            >
              {isSelect && <CornerDownLeft size={13} strokeWidth={2} aria-hidden="true" />}
              <span>
                {isSelect
                  ? t("chat.extensionConfirm")
                  : request.method === "confirm"
                    ? t("chat.confirm")
                    : t("chat.submit")}
              </span>
            </button>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

function ExtensionCustomPanel({
  request,
  waitingCount,
  onInput,
  onClose,
}: {
  request: ExtensionCustomRequest;
  waitingCount: number;
  onInput: (request: ExtensionCustomRequest, data: string) => void | Promise<void>;
  onClose: (request: ExtensionCustomRequest) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const terminalInputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const compositionBaseTextRef = useRef<string | null>(null);
  const selectedTextRef = useRef("");
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const bodyLines = normalizeCustomPanelLines(request.lines);
  const editorSnapshot = getCustomEditorSnapshot(bodyLines);
  const hasEditorSnapshot = editorSnapshot !== null;
  const editorSnapshotRef = useRef<CustomEditorSnapshot | null>(editorSnapshot);
  const bodyLinesRef = useRef(bodyLines);
  editorSnapshotRef.current = editorSnapshot;
  bodyLinesRef.current = bodyLines;
  const [editorText, setEditorText] = useState(() => editorSnapshot?.text ?? "");
  const editorTextRef = useRef(editorSnapshot?.text ?? "");
  const queuedCursorRef = useRef<CustomEditorCursor>(editorSnapshot?.cursor ?? { line: 0, column: 0 });
  const restoreSelectionRef = useRef<{ start: number; end: number } | null>(null);
  const inputQueueRef = useRef<Promise<void>>(Promise.resolve());

  const enqueueInput = useCallback((operation: () => void | Promise<void>) => {
    const task = inputQueueRef.current.then(operation);
    inputQueueRef.current = task.then(() => undefined, () => undefined);
    void task.catch(() => undefined);
  }, []);

  const sendInput = useCallback((data: string) => {
    enqueueInput(() => onInput(request, data));
  }, [enqueueInput, onInput, request]);

  const sendTerminalKey = useCallback(async (key: string) => {
    const data = toTerminalKeyData({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false });
    if (data) await onInput(request, data);
  }, [onInput, request]);

  const pressTerminalKey = useCallback((key: "ArrowUp" | "ArrowDown" | "Enter" | "Escape") => {
    const data = toTerminalKeyData({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false });
    if (data) sendInput(data);
  }, [sendInput]);

  const moveTerminalCursor = useCallback(async (
    from: CustomEditorCursor,
    target: CustomEditorCursor,
    text: string,
  ) => {
    await sendTerminalKey("Home");
    const verticalKey = target.line < from.line ? "ArrowUp" : "ArrowDown";
    for (let index = 0; index < Math.min(200, Math.abs(target.line - from.line)); index += 1) {
      await sendTerminalKey(verticalKey);
    }
    await sendTerminalKey("Home");
    const targetLine = text.split("\n")[target.line] ?? "";
    const targetColumn = Math.min(Math.max(0, target.column), targetLine.length);
    for (let index = 0; index < Math.min(2000, countGraphemes(targetLine.slice(0, targetColumn))); index += 1) {
      await sendTerminalKey("ArrowRight");
    }
  }, [sendTerminalKey]);

  const commitEditorChange = useCallback((previousText: string, nextText: string, nextSelectionStart: number) => {
    const edit = getTextEdit(previousText, nextText);
    if (edit.start === edit.end && !edit.inserted) return;

    const fromCursor = queuedCursorRef.current;
    const editCursor = getTextCursor(previousText, edit.start);
    const nextCursor = getTextCursor(nextText, nextSelectionStart);
    queuedCursorRef.current = nextCursor;
    enqueueInput(async () => {
      await moveTerminalCursor(fromCursor, editCursor, previousText);
      for (let index = 0; index < countGraphemes(previousText.slice(edit.start, edit.end)); index += 1) {
        await sendTerminalKey("Delete");
      }
      if (edit.inserted) await onInput(request, asBracketedPaste(edit.inserted));
    });
  }, [enqueueInput, moveTerminalCursor, onInput, request, sendTerminalKey]);

  const submitEditor = useCallback(() => {
    const text = editorTextRef.current;
    const selectionStart = editorRef.current?.selectionStart ?? text.length;
    const targetCursor = getTextCursor(text, selectionStart);
    const fromCursor = queuedCursorRef.current;
    queuedCursorRef.current = targetCursor;
    enqueueInput(async () => {
      await moveTerminalCursor(fromCursor, targetCursor, text);
      await onInput(request, "\r");
    });
  }, [enqueueInput, moveTerminalCursor, onInput, request]);

  const insertNativeText = useCallback((text: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    const previousText = editorTextRef.current;
    const start = editor.selectionStart ?? previousText.length;
    const end = editor.selectionEnd ?? start;
    const nextText = previousText.slice(0, start) + text + previousText.slice(end);
    const nextSelectionStart = start + text.length;
    editorTextRef.current = nextText;
    setEditorText(nextText);
    restoreSelectionRef.current = { start: nextSelectionStart, end: nextSelectionStart };
    commitEditorChange(previousText, nextText, nextSelectionStart);
  }, [commitEditorChange]);

  const handleEditorChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextText = event.currentTarget.value;
    const previousText = editorTextRef.current;
    const nextSelectionStart = event.currentTarget.selectionStart ?? nextText.length;
    const nextSelectionEnd = event.currentTarget.selectionEnd ?? nextSelectionStart;
    editorTextRef.current = nextText;
    setEditorText(nextText);
    restoreSelectionRef.current = { start: nextSelectionStart, end: nextSelectionEnd };
    if (composingRef.current || compositionBaseTextRef.current !== null) return;
    commitEditorChange(previousText, nextText, nextSelectionStart);
  }, [commitEditorChange]);


  const flushComposition = useCallback(() => {
    const previousText = compositionBaseTextRef.current;
    const editor = editorRef.current;
    if (previousText === null || !editor) return;
    compositionBaseTextRef.current = null;
    const nextText = editor.value;
    const nextSelectionStart = editor.selectionStart ?? nextText.length;
    commitEditorChange(previousText, nextText, nextSelectionStart);
  }, [commitEditorChange]);

  const restoreInputFocus = useCallback(() => {
    window.setTimeout(() => {
      if (editorSnapshotRef.current) {
        editorRef.current?.focus();
      } else {
        terminalInputRef.current?.focus();
      }
    }, 0);
  }, []);

  const getSelectedPanelText = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.anchorNode || !preRef.current?.contains(selection.anchorNode)) {
      return "";
    }
    return selection.toString();
  }, []);

  const getPanelText = useCallback(() => {
    const snapshot = editorSnapshotRef.current;
    const lines = bodyLinesRef.current;
    if (!snapshot) return lines.map(stripAnsi).join("\n");
    const { start, end } = snapshot.bounds;
    return [
      ...lines.slice(0, start).map(stripAnsi),
      editorTextRef.current,
      ...lines.slice(end + 1).map(stripAnsi),
    ].join("\n");
  }, []);

  const copyContent = useCallback((text?: string) => {
    copyText(text ?? getPanelText()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).finally(restoreInputFocus);
  }, [getPanelText, restoreInputFocus]);

  const handleEditorKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (composingRef.current || event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      submitEditor();
      return;
    }
    if (event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "j") {
      event.preventDefault();
      event.stopPropagation();
      insertNativeText("\n");
      return;
    }
    if (event.key === "Tab" || event.key === "Escape") {
      const data = toTerminalKeyData(event);
      if (!data) return;
      event.preventDefault();
      event.stopPropagation();
      sendInput(data);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "c") {
      const editor = editorRef.current;
      const hasNativeSelection = Boolean(editor && editor.selectionStart !== editor.selectionEnd);
      if (hasNativeSelection) return;
      const selectedText = selectedTextRef.current || getSelectedPanelText();
      if (selectedText) {
        event.preventDefault();
        event.stopPropagation();
        copyContent(selectedText);
        selectedTextRef.current = "";
      } else if (event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        sendInput("\x03");
      }
    }
  }, [copyContent, getSelectedPanelText, insertNativeText, sendInput, submitEditor]);

  useEffect(() => {
    const nextEditorSnapshot = editorSnapshotRef.current;
    const nextEditorText = nextEditorSnapshot?.text ?? "";
    editorTextRef.current = nextEditorText;
    setEditorText(nextEditorText);
    queuedCursorRef.current = nextEditorSnapshot?.cursor ?? { line: 0, column: 0 };
    restoreSelectionRef.current = null;
    const editor = editorRef.current;
    if (editor) {
      editor.focus();
      const cursorOffset = nextEditorSnapshot ? getTextOffset(nextEditorSnapshot.text, nextEditorSnapshot.cursor) : editorTextRef.current.length;
      editor.setSelectionRange(cursorOffset, cursorOffset);
    } else {
      terminalInputRef.current?.focus();
    }
    const resetComposition = () => {
      composingRef.current = false;
      compositionBaseTextRef.current = null;
    };
    const restoreActiveFocus = () => {
      if (document.visibilityState !== "visible") return;
      requestAnimationFrame(() => {
        if (editorSnapshotRef.current) {
          editorRef.current?.focus();
        } else {
          terminalInputRef.current?.focus();
        }
      });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") resetComposition();
      else restoreActiveFocus();
    };
    window.addEventListener("blur", resetComposition);
    window.addEventListener("focus", restoreActiveFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", resetComposition);
      window.removeEventListener("focus", restoreActiveFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [request.id, hasEditorSnapshot]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.style.height = "auto";
    editor.style.height = `${Math.min(Math.max(editor.scrollHeight, 42), 320)}px`;
    const selection = restoreSelectionRef.current;
    if (selection && document.activeElement === editor) {
      editor.setSelectionRange(selection.start, selection.end);
      restoreSelectionRef.current = null;
    }
  }, [editorText]);

  // The native editor or hidden terminal input remains the normal input target. If a long-lived
  // page lets focus move to the document or a button, keep navigation and confirmation keys
  // working without requiring a full refresh to restore that focus.
  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      const activeInput = editorSnapshotRef.current ? editorRef.current : terminalInputRef.current;
      if (event.defaultPrevented || event.isComposing || event.target === activeInput) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      const allowedKeys = editorSnapshotRef.current
        ? new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Escape", "Tab"])
        : new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Escape", "Tab", "Enter"]);
      if (!allowedKeys.has(event.key)) return;
      let data = toTerminalKeyData(event);
      if (!data && !editorSnapshotRef.current && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (event.key === " " || /^[0-9a-zA-Z]$/.test(event.key)) {
          data = event.key;
        }
      }
      if (!data) return;
      event.preventDefault();
      event.stopPropagation();
      activeInput?.focus();
      sendInput(data);
    };
    window.addEventListener("keydown", handleGlobalKeyDown, true);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown, true);
  }, [sendInput]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(event) => {
          const target = event.target;
          if (target instanceof Element && target.closest("button")) return;
          if (target instanceof Node && (preRef.current?.contains(target) || editorRef.current?.contains(target) || terminalInputRef.current?.contains(target))) return;
          // Keep read-only panel selection intact while returning keyboard focus to the editor.
          const selection = window.getSelection();
          const range =
            selection && selection.rangeCount > 0 && !selection.isCollapsed
              ? selection.getRangeAt(0).cloneRange()
              : null;
          if (range && preRef.current?.contains(range.commonAncestorContainer)) return;
          restoreInputFocus();
        }}
        style={{
          position: "relative",
          width: "min(920px, 100%)",
          maxHeight: "min(760px, calc(100vh - 40px))",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        {!editorSnapshot && (
          <textarea
            ref={terminalInputRef}
            className="extension-custom-terminal-input"
            aria-label={t("chat.extensionInput")}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onKeyDown={(event) => {
              if (composingRef.current || event.nativeEvent.isComposing) return;
              if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "c") {
                const selectedText = selectedTextRef.current || getSelectedPanelText();
                if (selectedText) {
                  event.preventDefault();
                  event.stopPropagation();
                  copyContent(selectedText);
                  selectedTextRef.current = "";
                  return;
                }
              }
              const data = toTerminalKeyData(event);
              if (!data) return;
              event.preventDefault();
              event.stopPropagation();
              sendInput(data);
            }}
            onInput={(event) => {
              if (composingRef.current || event.nativeEvent.isComposing) return;
              const text = event.currentTarget.value;
              event.currentTarget.value = "";
              if (text) sendInput(text);
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onBlur={() => {
              composingRef.current = false;
            }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              const input = event.currentTarget;
              queueMicrotask(() => {
                const text = input.value;
                input.value = "";
                if (text) sendInput(text);
              });
            }}
            onPaste={(event) => {
              event.preventDefault();
              const text = event.clipboardData.getData("text");
              if (text) sendInput(asBracketedPaste(text));
            }}
            style={{
              position: "absolute",
              width: 1,
              height: 1,
              padding: 0,
              border: 0,
              opacity: 0,
              clipPath: "inset(50%)",
            }}
          />
        )}
        <div className="extension-custom-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
          <div className="extension-custom-header-title" style={{ minWidth: 0, color: "var(--text)", fontSize: 13, fontWeight: 650 }}>{t("chat.extensionPanel")}{request.sideAskRunId ? ` · ${t("sidekick.title")}${request.sideAskLabel ? ` · ${request.sideAskLabel}` : ""}` : ""}</div>
          <div className="extension-custom-header-actions" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <ExtensionWaitingCount count={waitingCount} />
            <div role="group" aria-label={t("chat.extensionNavigation")} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              {!editorSnapshot && (
                <>
                  <button
                    type="button"
                    className="extension-custom-control"
                    onClick={() => pressTerminalKey("ArrowUp")}
                    title={t("chat.extensionMoveUp")}
                    aria-label={t("chat.extensionMoveUp")}
                  >
                    <ChevronUp size={16} strokeWidth={1.9} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="extension-custom-control"
                    onClick={() => pressTerminalKey("ArrowDown")}
                    title={t("chat.extensionMoveDown")}
                    aria-label={t("chat.extensionMoveDown")}
                  >
                    <ChevronDown size={16} strokeWidth={1.9} aria-hidden="true" />
                  </button>
                </>
              )}
              <button
                type="button"
                className="extension-custom-control"
                onClick={editorSnapshot ? submitEditor : () => pressTerminalKey("Enter")}
                title={editorSnapshot ? t("chat.submit") : t("chat.extensionConfirm")}
                aria-label={editorSnapshot ? t("chat.submit") : t("chat.extensionConfirm")}
                style={{ borderColor: "var(--accent)", background: "var(--accent)", color: "#fff" }}
              >
                <CornerDownLeft size={16} strokeWidth={1.9} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="extension-custom-control"
                onClick={() => pressTerminalKey("Escape")}
                title={t("chat.extensionEscape")}
                aria-label={t("chat.extensionEscape")}
              >
                Esc
              </button>
            </div>
            <button
              type="button"
              onClick={() => copyContent()}
              title={copied ? t("i18n.copied") : t("i18n.copy")}
              aria-label={copied ? t("i18n.copied") : t("i18n.copy")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "5px 8px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: copied ? "var(--accent)" : "var(--text-muted)",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              {copied ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
              {copied ? t("i18n.copied") : t("i18n.copy")}
            </button>
            <button
              onClick={() => onClose(request)}
              style={{
                padding: "5px 9px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
               {t("chat.close")}
            </button>
          </div>
        </div>
        <pre
          ref={preRef}
          onClick={(event) => {
            const target = event.target;
            if (target instanceof Node && (editorRef.current?.contains(target) || terminalInputRef.current?.contains(target))) return;
            if (target instanceof Element && target.closest("button")) return;
            const selection = window.getSelection();
            if (selection && !selection.isCollapsed && preRef.current?.contains(selection.anchorNode)) return;
            restoreInputFocus();
          }}
          onMouseUp={(event) => {
            if (event.button !== 0 || (event.target instanceof Node && (editorRef.current?.contains(event.target) || terminalInputRef.current?.contains(event.target)))) return;
            window.setTimeout(() => {
              selectedTextRef.current = getSelectedPanelText();
              const selection = window.getSelection();
              const range =
                selection && selection.rangeCount > 0 && !selection.isCollapsed
                  ? selection.getRangeAt(0).cloneRange()
                  : null;
              // Focusing native editor clears a document selection. Leave selected
              // panel text untouched; only restore focus after an ordinary click.
              if (!range || !preRef.current?.contains(range.commonAncestorContainer)) restoreInputFocus();
            }, 0);
          }}
          style={{
            margin: 0,
            padding: 14,
            maxHeight: "calc(min(760px, 100vh - 40px) - 48px)",
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: "pre",
            userSelect: "text",
            WebkitUserSelect: "text",
            cursor: "text",
          }}
        >
          {editorSnapshot ? (
            <>
              {renderAnsiLineRange(bodyLines, 0, editorSnapshot.bounds.start - 1, "custom-before")}
              {editorSnapshot.bounds.start > 0 ? "\n" : null}
              <textarea
                ref={editorRef}
                className="extension-custom-editor"
                aria-label={t("chat.extensionInput")}
                aria-multiline="true"
                value={editorText}
                rows={Math.max(1, Math.min(12, editorText.split("\n").length))}
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                onKeyDown={handleEditorKeyDown}
                onChange={handleEditorChange}
                onCompositionStart={() => {
                  composingRef.current = true;
                  compositionBaseTextRef.current = editorTextRef.current;
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                  window.setTimeout(flushComposition, 0);
                }}
                onBlur={() => {
                  if (!composingRef.current) return;
                  composingRef.current = false;
                  flushComposition();
                }}
                style={{
                  display: "block",
                  width: "100%",
                  minHeight: 42,
                  maxHeight: 320,
                  margin: 0,
                  padding: "8px 10px",
                  boxSizing: "border-box",
                  resize: "vertical",
                  overflow: "auto",
                  border: "1px solid color-mix(in srgb, var(--accent) 55%, var(--border))",
                  borderRadius: 5,
                  outline: "none",
                  background: "var(--bg)",
                  color: "var(--text)",
                  font: "inherit",
                  lineHeight: "inherit",
                  whiteSpace: "pre-wrap",
                  caretColor: "var(--accent)",
                  userSelect: "text",
                  WebkitUserSelect: "text",
                }}
              />
              {editorSnapshot.bounds.end < bodyLines.length - 1 ? "\n" : null}
              {renderAnsiLineRange(bodyLines, editorSnapshot.bounds.end + 1, bodyLines.length - 1, "custom-after")}
            </>
          ) : (
            (bodyLines.length ? bodyLines : [""]).map((line, index, allLines) => (
              <Fragment key={index}>
                {renderAnsiLine(line, `line-${index}`)}
                {index < allLines.length - 1 ? "\n" : null}
              </Fragment>
            ))
          )}
        </pre>
      </div>
    </div>
  );
}
