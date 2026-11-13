"use client";

import { memo, useEffect, useRef, useState, useCallback, useMemo, type RefObject } from "react";
import ReactMarkdown, { type Options as ReactMarkdownOptions } from "react-markdown";
import rehypeKatex from "rehype-katex";
import {
  markdownPreviewRemarkPlugins,
  normalizeDisplayMath,
} from "@/lib/markdown";
import { splitFinalAssistantBlocks } from "@/lib/message-display";
import { isSubagentWakeMessage, stripHiddenUserQuestion } from "@/lib/session-hover-preview";
import type { AgentMessage, AssistantMessage, CustomMessage, TextContent, UserMessage } from "@/lib/types";
import type { HistoryNode } from "@/lib/session-history-types";
import type { StreamingStore } from "@/lib/streaming-message";
import styles from "./ChatMinimap.module.css";
import { ArrowDown } from "lucide-react";
import { useI18n } from "@/hooks/useI18n";

export function countToolCalls(message: AgentMessage | Partial<AgentMessage>): number {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return 0;
  return message.content.reduce((total, block) => total + (block.type === "toolCall" ? 1 : 0), 0);
}

function getUserPreview(message: UserMessage): string {
  const text = typeof message.content === "string"
    ? message.content.trim()
    : message.content.filter((block): block is TextContent => block.type === "text").map((block) => block.text).join("\n").trim();
  return stripHiddenUserQuestion(text);
}

function getAssistantAnswerMarkdown(message: AgentMessage | Partial<AgentMessage>): string {
  if (message.role !== "assistant") return "";
  const { answerBlocks } = splitFinalAssistantBlocks(message as AssistantMessage);
  return answerBlocks.filter((block): block is TextContent => block.type === "text").map((block) => block.text).join("\n\n").trim();
}

function isCompactionMessage(message: AgentMessage | Partial<AgentMessage>): message is CustomMessage {
  return message.role === "custom" && (message as CustomMessage).customType === "compaction";
}

function PreviewHeading({ level, children, headingIndex, onClick }: { level: 1 | 2 | 3; children: React.ReactNode; headingIndex: number | null; onClick?: (headingIndex: number) => void }) {
  return <button type="button" className={styles.heading} data-level={level} data-preview-heading-index={headingIndex ?? undefined} disabled={headingIndex === null || !onClick} onClick={(event) => { event.stopPropagation(); if (headingIndex !== null) onClick?.(headingIndex); }}>{children}</button>;
}

interface PreviewAstNode { type?: string; depth?: number; ordered?: boolean; start?: number | null; value?: string; children?: PreviewAstNode[]; data?: { hProperties?: Record<string, unknown> } }
function remarkPreviewOutline() {
  return (tree: { children?: PreviewAstNode[] }) => {
    if (!Array.isArray(tree.children)) return;
    const headings = tree.children.filter((node) => node.type === "heading" && typeof node.depth === "number" && node.depth <= 3);
    if (headings.length > 0) {
      headings.forEach((node, headingIndex) => { node.data = { ...node.data, hProperties: { ...node.data?.hProperties, "data-preview-heading-index": headingIndex } }; });
      tree.children = headings;
      return;
    }
    const firstParagraphIndex = tree.children.findIndex((node) => node.type === "paragraph");
    const firstListIndex = tree.children.findIndex((node) => node.type === "list");
    const firstParagraph = firstParagraphIndex >= 0 ? tree.children[firstParagraphIndex] : null;
    const firstList = firstListIndex >= 0 ? tree.children[firstListIndex] : null;
    const firstListItem = firstList?.children?.find((node) => node.type === "listItem")?.children?.find((node) => node.type === "paragraph") ?? null;
    if (firstList && firstListItem && (firstParagraphIndex < 0 || firstListIndex < firstParagraphIndex)) {
      firstListItem.children = [{ type: "text", value: firstList.ordered ? `${firstList.start ?? 1}. ` : "• " }, ...(firstListItem.children ?? [])];
      tree.children = [firstListItem];
      return;
    }
    if (firstParagraph) { tree.children = [firstParagraph]; return; }
    const quote = tree.children.find((node) => node.type === "blockquote")?.children?.find((node) => node.type === "paragraph");
    tree.children = quote ? [quote] : [];
  };
}
const previewRemarkPlugins = [...(markdownPreviewRemarkPlugins ?? []), remarkPreviewOutline];
const previewRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [[rehypeKatex, { throwOnError: false, strict: false }]];
function getPreviewHeadingIndex(node: unknown): number | null {
  const properties = (node as { properties?: Record<string, unknown> } | undefined)?.properties;
  const value = properties?.dataPreviewHeadingIndex ?? properties?.["data-preview-heading-index"];
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}
export const AssistantOutline = memo(function AssistantOutline({ markdown, onHeadingClick, onAnswerClick }: { markdown: string; onHeadingClick?: (headingIndex: number) => void; onAnswerClick?: () => void }) {
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(markdown), [markdown]);
  if (!markdown) return null;
  return <div className={styles.outline}><ReactMarkdown remarkPlugins={previewRemarkPlugins} rehypePlugins={previewRehypePlugins} components={{
    h1: ({ children, node }) => <PreviewHeading level={1} headingIndex={getPreviewHeadingIndex(node)} onClick={onHeadingClick}>{children}</PreviewHeading>,
    h2: ({ children, node }) => <PreviewHeading level={2} headingIndex={getPreviewHeadingIndex(node)} onClick={onHeadingClick}>{children}</PreviewHeading>,
    h3: ({ children, node }) => <PreviewHeading level={3} headingIndex={getPreviewHeadingIndex(node)} onClick={onHeadingClick}>{children}</PreviewHeading>,
    h4: () => null, h5: () => null, h6: () => null,
    p: ({ children }) => <button type="button" className={styles.paragraph} onClick={onAnswerClick}>{children}</button>,
    blockquote: () => null, ul: () => null, ol: () => null, pre: () => null, table: () => null, hr: () => null,
    a: ({ children }) => <>{children}</>, code: ({ children }) => <>{children}</>,
  }}>{normalizedMarkdown}</ReactMarkdown></div>;
});

interface Props {
  messages: AgentMessage[];
  entryIds: string[];
  scopeKey?: string;
  streamingStore: StreamingStore;
  atLiveTail: boolean;
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
  streamingMessageRef: RefObject<HTMLDivElement | null>;
  onReadHistory: () => void;
  onScrollToEntry: (element: HTMLElement, offset?: number) => void;
  onScrollToBottom: () => void;
  historyNodes?: readonly HistoryNode[];
  historyNodeCount?: number;
  onNavigateEntry?: (entryId: string) => Promise<unknown> | unknown;
  onLoadNodePage?: (nodeIndex: number) => Promise<unknown> | unknown;
}

const MINIMAP_WIDTH = 36;
const MINIMAP_ANCHOR_OFFSET = 12;
const MAX_NODE_GAP = 50;
const MINIMAP_PADDING = 12;
const MINIMAP_ACTION_SLOT = 32;
const PREVIEW_HIDE_DELAY = 250;
const NAVIGATION_ACTIVE_LOCK_MS = 1600;

interface AssistantPreview {
  markdown: string;
  element: HTMLElement | null;
}

interface TurnInfo {
  userMessage: UserMessage;
  assistantPreviews: AssistantPreview[];
  scrollTop: number | null;
  scrollBottom: number | null;
  toolCount: number;
}

interface NodeInfo {
  topRatio: number;
  targetTurn: TurnInfo;
  index: number;
  entryId: string;
  kind: "turn" | "compaction";
  nodeIndex: number;
}

interface NodeLayout {
  nodes: NodeInfo[];
  gap: number;
  fillsHeight: boolean;
}

function layoutNodes(allNodes: NodeInfo[], minimapHeight: number): NodeLayout {
  if (allNodes.length === 0) return { nodes: [], gap: MAX_NODE_GAP, fillsHeight: false };
  const height = Math.max(1, minimapHeight);
  const topPadding = MINIMAP_PADDING;
  const bottomPadding = MINIMAP_PADDING + MINIMAP_ACTION_SLOT;
  const usableHeight = Math.max(0, height - topPadding - bottomPadding);
  if (allNodes.length === 1) {
    return { nodes: [{ ...allNodes[0], topRatio: topPadding / height }], gap: MAX_NODE_GAP, fillsHeight: false };
  }
  const naturalGap = usableHeight / (allNodes.length - 1);
  const gap = Math.min(MAX_NODE_GAP, naturalGap);
  return {
    nodes: allNodes.map((node, index) => ({ ...node, topRatio: (topPadding + index * gap) / height })),
    gap,
    fillsHeight: naturalGap <= MAX_NODE_GAP,
  };
}

function elementForEntry(scrollEl: HTMLDivElement, entryId: string): HTMLElement | null {
  if (!entryId) return null;
  return Array.from(scrollEl.querySelectorAll<HTMLElement>("[data-chat-message-row][data-entry-id]"))
    .find((element) => element.dataset.entryId === entryId) ?? null;
}

export const ChatMinimap = memo(function ChatMinimap({
  messages,
  entryIds,
  scopeKey = "",
  streamingStore,
  atLiveTail,
  scrollContainer,
  messageRefs: _messageRefs,
  streamingMessageRef,
  onReadHistory,
  onScrollToEntry,
  onScrollToBottom,
  historyNodes = [],
  historyNodeCount,
  onNavigateEntry,
  onLoadNodePage,
}: Props) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  const [allNodes, setAllNodes] = useState<NodeInfo[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [minimapHeight, setMinimapHeight] = useState(600);
  const [minimapHovered, setMinimapHovered] = useState(false);
  const [mouseYRatio, setMouseYRatio] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const allNodesRef = useRef<NodeInfo[]>([]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const nodeLayoutRef = useRef<NodeLayout>({ nodes: [], gap: MAX_NODE_GAP, fillsHeight: false });
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const previewItemRefs = useRef(new Map<number, HTMLDivElement>());
  const previewHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeNodeLockRef = useRef<{ index: number; until: number } | null>(null);
  const pendingNavigationRef = useRef<{ scopeKey: string; nodeIndex: number; target: "user" | "assistant" | "heading" | "compaction"; assistantIndex?: number; headingIndex?: number } | null>(null);

  const nodeLayout = useMemo(
    () => layoutNodes(allNodes, minimapHeight),
    [allNodes, minimapHeight],
  );
  nodeLayoutRef.current = nodeLayout;
  const { nodes: positionedNodes, gap: nodeGap } = nodeLayout;

  const lockActiveNode = useCallback((index: number) => {
    activeNodeLockRef.current = { index, until: Date.now() + NAVIGATION_ACTIVE_LOCK_MS };
    setActiveIndex(index);
  }, []);

  const syncActiveNode = useCallback((scrollEl: HTMLDivElement, nextNodes: NodeInfo[]) => {
    const activeLock = activeNodeLockRef.current;
    if (activeLock && Date.now() < activeLock.until) {
      setActiveIndex(activeLock.index);
      return;
    }
    activeNodeLockRef.current = null;
    const measured = nextNodes.filter((node) => node.targetTurn.scrollTop !== null);
    if (measured.length === 0) {
      setActiveIndex(null);
      return;
    }
    const focusTop = scrollEl.scrollTop + MINIMAP_ANCHOR_OFFSET;
    const active = measured.reduce((best, node) => (
      Math.abs((node.targetTurn.scrollTop ?? 0) - focusTop) < Math.abs((best.targetTurn.scrollTop ?? 0) - focusTop) ? node : best
    ), measured[0]);
    setActiveIndex(active.index);
  }, []);

  const updateVisibility = useCallback(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    setVisible(scrollEl.scrollHeight - scrollEl.clientHeight > 20 || (historyNodeCount ?? historyNodes.length) > 0);
  }, [historyNodeCount, historyNodes.length, scrollContainer]);

  const measureNodes = useCallback(() => {
    const scrollEl = scrollContainer.current;
    const minimapEl = containerRef.current;
    if (!scrollEl || !minimapEl) return;
    const messageIndexByEntryId = new Map<string, number>();
    entryIds.forEach((entryId, index) => { if (entryId) messageIndexByEntryId.set(entryId, index); });
    const nextNodes: NodeInfo[] = [];
    const streamingMessage = atLiveTail ? streamingStore.getState().streamingMessage : null;
    for (const node of historyNodes) {
      const nodeIndex = node.nodeIndex;
      const entryId = node?.entryId ?? "";
      const messageIndex = entryId ? messageIndexByEntryId.get(entryId) : undefined;
      const message = messageIndex === undefined ? null : messagesRef.current[messageIndex];
      if (message && isSubagentWakeMessage(message)) continue;
      const element = elementForEntry(scrollEl, entryId);
      const elementRect = element?.getBoundingClientRect();
      const scrollTop = elementRect ? elementRect.top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop : null;
      const scrollBottom = elementRect ? elementRect.bottom - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop : null;
      const kind = node?.kind === "compaction" || message && isCompactionMessage(message) ? "compaction" : "turn";
      const userMessage: UserMessage = message?.role === "user"
        ? message as UserMessage
        : { role: "user", content: node?.preview ?? "" };
      const assistantPreviews: AssistantPreview[] = [];
      let toolCount = 0;
      if (messageIndex !== undefined) {
        let lastTurn = true;
        for (let index = messageIndex + 1; index < messagesRef.current.length; index += 1) {
          const next = messagesRef.current[index];
          if (next.role === "user" || isCompactionMessage(next)) { lastTurn = false; break; }
          if (next.role !== "assistant") continue;
          toolCount += countToolCalls(next);
          const markdown = getAssistantAnswerMarkdown(next);
          if (markdown) assistantPreviews.push({ markdown, element: elementForEntry(scrollEl, entryIds[index] ?? "") });
        }
        if (kind === "turn" && lastTurn && streamingMessage?.role === "assistant") {
          const markdown = getAssistantAnswerMarkdown(streamingMessage);
          if (markdown) assistantPreviews.push({ markdown, element: streamingMessageRef.current });
        }
      }
      nextNodes.push({ index: nextNodes.length, nodeIndex, entryId, kind, topRatio: 0, targetTurn: { userMessage, assistantPreviews, scrollTop, scrollBottom, toolCount } });
    }

    setMinimapHeight(minimapEl.clientHeight);
    allNodesRef.current = nextNodes;
    setAllNodes(nextNodes);
    syncActiveNode(scrollEl, nextNodes);

    const pending = pendingNavigationRef.current;
    if (pending && pending.scopeKey !== scopeKey) {
      pendingNavigationRef.current = null;
      return;
    }
    const pendingNode = pending ? nextNodes.find((node) => node.nodeIndex === pending.nodeIndex) : null;
    if (!pending || !pendingNode) return;
    const assistant = pending.assistantIndex === undefined ? null : pendingNode.targetTurn.assistantPreviews[pending.assistantIndex];
    const target = pending.target === "heading"
      ? assistant?.element?.querySelectorAll<HTMLElement>("h1, h2, h3").item(pending.headingIndex ?? 0)
      : pending.target === "assistant" ? assistant?.element : elementForEntry(scrollEl, pendingNode.entryId);
    if (!target) return;
    pendingNavigationRef.current = null;
    lockActiveNode(pendingNode.index);
    onScrollToEntry(target, pending.target === "compaction" ? 0 : MINIMAP_ANCHOR_OFFSET);
  }, [atLiveTail, entryIds, historyNodeCount, historyNodes, onScrollToEntry, scrollContainer, streamingMessageRef, streamingStore, syncActiveNode, lockActiveNode, scopeKey]);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    const onScroll = () => {
      updateVisibility();
      syncActiveNode(el, allNodesRef.current);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollContainer, syncActiveNode, updateVisibility]);

  useEffect(() => {
    const el = scrollContainer.current;
    // The hidden rail has no containerRef yet, so visibility must bootstrap
    // independently before node measurement can run.
    const syncLayout = () => {
      updateVisibility();
      measureNodes();
    };
    const timeout = setTimeout(syncLayout, 50);
    if (!el) return () => clearTimeout(timeout);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncLayout);
    ro?.observe(el);
    const content = el.firstElementChild;
    if (content) ro?.observe(content);
    syncLayout();
    return () => { clearTimeout(timeout); ro?.disconnect(); };
  }, [measureNodes, scrollContainer, updateVisibility, visible]);

  useEffect(() => {
    if (!visible || !atLiveTail) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = streamingStore.subscribe(() => {
      if (timer !== null) return;
      timer = setTimeout(() => { timer = null; measureNodes(); }, 100);
    });
    return () => { unsubscribe(); if (timer !== null) clearTimeout(timer); };
  }, [atLiveTail, measureNodes, streamingStore, visible]);

  const scrollToNode = useCallback((node: NodeInfo) => {
    onReadHistory();
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    lockActiveNode(node.index);
    if (node.targetTurn.scrollTop === null) {
      pendingNavigationRef.current = { scopeKey, nodeIndex: node.nodeIndex, target: node.kind === "compaction" ? "compaction" : "user" };
      if (node.entryId) void onNavigateEntry?.(node.entryId);
      else if (onLoadNodePage) void onLoadNodePage(node.nodeIndex);
      return;
    }
    const element = elementForEntry(scrollEl, node.entryId);
    if (element) onScrollToEntry(element, node.kind === "compaction" ? 0 : MINIMAP_ANCHOR_OFFSET);
  }, [lockActiveNode, onReadHistory, onLoadNodePage, onNavigateEntry, onScrollToEntry, scrollContainer, scopeKey]);

  const scrollToBottom = useCallback(() => {
    pendingNavigationRef.current = null;
    activeNodeLockRef.current = null;
    onScrollToBottom();
  }, [onScrollToBottom]);

  const scrollToAssistant = useCallback((node: NodeInfo, assistantIndex: number) => {
    onReadHistory();
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const assistantElement = node.targetTurn.assistantPreviews[assistantIndex]?.element;
    if (!assistantElement) {
      pendingNavigationRef.current = { scopeKey, nodeIndex: node.nodeIndex, target: "assistant", assistantIndex };
      if (node.entryId) void onNavigateEntry?.(node.entryId);
      else if (onLoadNodePage) void onLoadNodePage(node.nodeIndex);
      return;
    }
    lockActiveNode(node.index);
    onScrollToEntry(assistantElement, MINIMAP_ANCHOR_OFFSET);
  }, [lockActiveNode, onReadHistory, onLoadNodePage, onNavigateEntry, onScrollToEntry, scrollContainer, scopeKey]);

  const scrollToHeading = useCallback((node: NodeInfo, assistantIndex: number, headingIndex: number) => {
    onReadHistory();
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const answerElement = node.targetTurn.assistantPreviews[assistantIndex]?.element;
    if (!answerElement) {
      pendingNavigationRef.current = { scopeKey, nodeIndex: node.nodeIndex, target: "heading", assistantIndex, headingIndex };
      if (node.entryId) void onNavigateEntry?.(node.entryId);
      else if (onLoadNodePage) void onLoadNodePage(node.nodeIndex);
      return;
    }
    const heading = answerElement.querySelectorAll<HTMLElement>("h1, h2, h3").item(headingIndex);
    if (!heading) return;
    lockActiveNode(node.index);
    onScrollToEntry(heading, MINIMAP_ANCHOR_OFFSET);
  }, [lockActiveNode, onReadHistory, onLoadNodePage, onNavigateEntry, onScrollToEntry, scrollContainer, scopeKey]);

  const findNearestNode = useCallback((ratio: number): NodeInfo | null => {
    const { nodes, gap, fillsHeight } = nodeLayoutRef.current;
    const height = containerRef.current?.clientHeight ?? 0;
    if (nodes.length === 0 || height <= 0) return null;
    const pointerY = Math.max(0, Math.min(height, ratio * height));
    const firstNodeY = nodes[0].topRatio * height;
    const rawIndex = gap > 0 ? Math.round((pointerY - firstNodeY) / gap) : 0;
    const index = Math.max(0, Math.min(nodes.length - 1, rawIndex));
    const node = nodes[index];
    if (!fillsHeight) {
      const nodeY = node.topRatio * height;
      if (Math.abs(pointerY - nodeY) > Math.max(10, gap / 2)) return null;
    }
    return node;
  }, []);

  const cancelPreviewHide = useCallback(() => {
    if (previewHideTimerRef.current) clearTimeout(previewHideTimerRef.current);
    previewHideTimerRef.current = null;
  }, []);
  const showPreview = useCallback(() => { cancelPreviewHide(); setMinimapHovered(true); }, [cancelPreviewHide]);
  const schedulePreviewHide = useCallback(() => {
    cancelPreviewHide();
    previewHideTimerRef.current = setTimeout(() => { setMinimapHovered(false); setMouseYRatio(null); }, PREVIEW_HIDE_DELAY);
  }, [cancelPreviewHide]);
  useEffect(() => () => cancelPreviewHide(), [cancelPreviewHide]);

  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!visible) return;
    draggingRef.current = true;
    showPreview();
    const rect = event.currentTarget.getBoundingClientRect();
    const jump = (clientY: number) => {
      const node = findNearestNode(Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)));
      if (node) scrollToNode(node);
    };
    setMouseYRatio(Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)));
    jump(event.clientY);
    const onMove = (move: MouseEvent) => { if (draggingRef.current) jump(move.clientY); };
    const onUp = () => { draggingRef.current = false; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [findNearestNode, scrollToNode, showPreview, visible]);

  const nearestNode = mouseYRatio === null ? null : findNearestNode(mouseYRatio);
  const nearestNodeIndex = nearestNode?.index ?? null;
  useEffect(() => {
    if (!minimapHovered || nearestNodeIndex === null) return;
    const box = previewBoxRef.current;
    const item = previewItemRefs.current.get(nearestNodeIndex);
    if (box && item) box.scrollTop = Math.max(0, item.offsetTop - (box.clientHeight - item.offsetHeight) / 2);
  }, [allNodes, minimapHovered, nearestNodeIndex]);

  if (!visible) return null;
  const lastNodeTop = positionedNodes.length ? positionedNodes[positionedNodes.length - 1].topRatio * minimapHeight : MINIMAP_PADDING;
  const railHeight = Math.max(1, lastNodeTop - MINIMAP_PADDING);
  const previewNodes = positionedNodes;

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseEnter={showPreview}
      onMouseLeave={schedulePreviewHide}
      onMouseMove={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMouseYRatio((event.clientY - rect.top) / rect.height); }}
      style={{ width: MINIMAP_WIDTH, flexShrink: 0, position: "relative", cursor: "pointer", userSelect: "none", borderLeft: "1px solid var(--border)", background: "var(--bg-panel)", overflow: "visible" }}
    >
      <div className={styles.bottomActions} data-minimap-bottom-actions>
        <button type="button" className={styles.historyButton} data-minimap-bottom aria-label={t("chat.scrollToBottom")} title={t("chat.scrollToBottom")} onMouseDown={(event) => { event.stopPropagation(); }} onClick={(event) => { event.stopPropagation(); scrollToBottom(); }}>
          <ArrowDown size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
      <div style={{ position: "absolute", left: "50%", top: MINIMAP_PADDING, height: railHeight, width: 1, background: "var(--border)", transform: "translateX(-50%)", zIndex: 0 }} />
      {positionedNodes.map((node) => {
        const isNearest = minimapHovered && nearestNode?.index === node.index;
        const isActive = activeIndex === node.index;
        return (
          <div key={`${node.nodeIndex}:${node.entryId}`} data-minimap-node-index={node.nodeIndex} data-minimap-node-active={isActive ? "" : undefined} style={{ position: "absolute", top: `${node.topRatio * 100}%`, transform: "translateY(-50%)", left: 0, right: 0, height: Math.max(1, nodeGap), display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none", zIndex: 2 }}>
            <div style={{ width: node.kind === "compaction" ? 10 : 8, height: node.kind === "compaction" ? 10 : 8, borderRadius: node.kind === "compaction" ? "50%" : 2, background: isActive ? "var(--warning, #f59e0b)" : node.kind === "compaction" ? "color-mix(in srgb, var(--accent) 55%, transparent)" : "rgba(128,128,128,0.16)", border: isActive ? "1.5px solid var(--warning, #f59e0b)" : node.kind === "compaction" ? "1.5px solid color-mix(in srgb, var(--accent) 65%, var(--border))" : "1.5px solid rgba(128,128,128,0.58)", boxShadow: isActive ? "0 0 0 2px var(--bg-panel)" : "none", transition: "transform 0.1s, background 0.1s", transform: isNearest ? "scale(1.25)" : "scale(1)" }} />
          </div>
        );
      })}
      {minimapHovered && previewNodes.length > 0 && (
        <div ref={previewBoxRef} className={styles.preview} data-minimap-preview-box="" onMouseEnter={showPreview} onMouseDown={(event) => event.stopPropagation()} onMouseMove={(event) => event.stopPropagation()}>
          {previewNodes.map((node) => {
            const isLocated = nearestNodeIndex === node.index;
            return (
              <div key={`${node.nodeIndex}:${node.entryId}`} ref={(element) => { if (element) previewItemRefs.current.set(node.index, element); else previewItemRefs.current.delete(node.index); }} className={styles.turn} data-minimap-preview-index={node.nodeIndex} data-minimap-node-kind={node.kind} data-located={isLocated ? "true" : undefined}>
                <span className={styles.number}><span aria-hidden="true">{node.kind === "compaction" ? "C" : String(node.nodeIndex + 1).padStart(2, "0")}</span>{node.targetTurn.toolCount > 0 && <span className={styles.toolBadge} role="img" title={t("chatMinimap.toolCalls", { count: node.targetTurn.toolCount })} aria-label={t("chatMinimap.toolCalls", { count: node.targetTurn.toolCount })}>{node.targetTurn.toolCount > 99 ? "99+" : node.targetTurn.toolCount}</span>}</span>
                <div className={styles.content}>
                  {node.kind === "compaction" ? (
                    <button type="button" className={styles.compaction} data-minimap-preview-compaction={node.nodeIndex} aria-label={t("chat.compactionSummary")} title={t("chat.compactionSummary")} onClick={() => scrollToNode(node)}>{t("chat.compactionSummary")}</button>
                  ) : (
                    <>
                      <button type="button" className={styles.user} data-minimap-preview-user={node.nodeIndex} onClick={() => scrollToNode(node)}><span className={styles.userText}>{getUserPreview(node.targetTurn.userMessage)}</span></button>
                      {node.targetTurn.assistantPreviews.map((assistant, assistantIndex) => (
                        <div key={assistantIndex} className={styles.assistant}>
                          <button type="button" className={styles.assistantJump} data-minimap-preview-assistant={`${node.nodeIndex}-${assistantIndex}`} onClick={() => scrollToAssistant(node, assistantIndex)} aria-label={t("chatMinimap.locateAssistant")} title={t("chatMinimap.locateAssistant")}>A</button>
                          <AssistantOutline markdown={assistant.markdown} onAnswerClick={() => scrollToAssistant(node, assistantIndex)} onHeadingClick={(headingIndex) => scrollToHeading(node, assistantIndex, headingIndex)} />
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

// Hook to create a stable array of refs for messages
export function useMessageRefs(count: number): RefObject<(HTMLDivElement | null)[]> {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  refs.current = Array(count).fill(null).map((_, i) => refs.current[i] ?? null);
  return refs;
}
