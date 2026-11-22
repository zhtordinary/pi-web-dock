"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Brain, Check, ChevronDown, GitBranch, GitFork, Maximize2, MessageSquare, Minimize2, Paperclip, Plus, Send, Sparkles, Trash2, X, Zap } from "lucide-react";
import { ImagePreview } from "./ImagePreview";
import { MarkdownBody } from "./MarkdownBody";
import { SelectorRow } from "./SelectorRow";
import { SessionChatPanel } from "./SessionChatPanel";
import { copyText } from "@/lib/clipboard";
import {
  compressImageFile,
  isBase64ImageWithinLimits,
  MAX_ATTACHED_IMAGE_BYTES,
  MAX_ATTACHED_IMAGES,
  type Base64ImageAttachment,
} from "@/lib/image-attachments";
import { EMBEDDED_SIDEKICK_DISMISS_EVENT, notifyEmbeddedModalState } from "@/lib/embedded-modal";
import {
  getExtensionDialogInputCompositionEndAtOnBlur,
  handleExtensionDialogInputKeyDown,
} from "@/lib/extension-dialog-keyboard";
import { useHiddenModelProviders } from "@/hooks/useHiddenModelProviders";
import { useI18n } from "@/hooks/useI18n";
import {
  useAgentSession,
  type AttachedImage,
  type SessionForkResult,
  type ThinkingLevelOption,
} from "@/hooks/useAgentSession";
import type { ChatInputHandle } from "./ChatInput";
import { useStreamingSelector, selectIsStreaming, selectStreamingMessage } from "@/hooks/useStreamingSelector";
import { turnCacheHitRate } from "@/lib/turn-resources";
import type { AgentMessage, AssistantMessage, SessionInfo, UserMessage } from "@/lib/types";

export const SIDEKICK_RIGHT_PANEL_TARGET_ID = "reader-right-panel-sidekick";
export const SIDEKICK_TOPBAR_PORTAL_ID = "reader-session-topbar-sidekick";

const SIDEKICK_WIDTH = 410;

type Translate = ReturnType<typeof useI18n>["t"];
type ModelOption = { id: string; name: string; provider: string };
type SidekickImage = Base64ImageAttachment & { previewUrl: string };
type SideSessionInfo = SessionInfo & {
  sideFirstEntryId?: string | null;
  sideMessageCount?: number;
};

type SideThread = {
  id: string;
  label: string;
  sessionId: string | null;
  info: SideSessionInfo | null;
  initialPrompt: string | null;
  initialImages: SidekickImage[];
  draft: string;
  images: SidekickImage[];
  count: number;
};

type Props = {
  sessionId: string;
  open: boolean;
  /** Kept for the branch-aware caller; ordinary Side sessions are keyed by session id. */
  historyRevision?: number;
  onClose: () => void;
  onQuoteToComposer?: (text: string) => void;
  mainBusy?: boolean;
  activeBranchId?: string;
  activeParentId?: string | null;
  remotePeer?: string | null;
  onSessionForked?: (result: SessionForkResult) => void;
  onCountChange?: (count: number) => void;
  placement?: "sidebar" | "right-panel";
  rightPanelTargetId?: string;
  modelList?: ModelOption[];
  modelNames?: Record<string, string>;
  defaultModel?: { provider: string; modelId: string } | null;
  modelThinkingLevels?: Record<string, string[]>;
  modelThinkingLevelMaps?: Record<string, Record<string, string | null>>;
  defaultThinkingLevel?: string | null;
};

const sidekickActionButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 11,
  lineHeight: "14px",
  padding: "2px 5px",
  borderRadius: 3,
  display: "inline-flex",
  alignItems: "center",
  transition: "color 0.12s, background-color 0.12s",
};

function sideSessionListUrl(sessionId: string, remotePeer?: string | null): string {
  const encoded = encodeURIComponent(sessionId);
  return remotePeer
    ? `/api/remote/sessions/${encoded}/side?peer=${encodeURIComponent(remotePeer)}`
    : `/api/sessions/${encoded}/side`;
}

function sideSessionUrl(sessionId: string, remotePeer?: string | null): string {
  const encoded = encodeURIComponent(sessionId);
  return remotePeer
    ? `/api/remote/sessions/${encoded}?peer=${encodeURIComponent(remotePeer)}`
    : `/api/sessions/${encoded}`;
}

function sideSessionDeleteUrl(sessionId: string, remotePeer?: string | null): string {
  return sideSessionUrl(sessionId, remotePeer);
}

function sideSessionForkUrl(sessionId: string, remotePeer?: string | null): string {
  const encoded = encodeURIComponent(sessionId);
  return remotePeer
    ? `/api/remote/sessions/${encoded}/fork?peer=${encodeURIComponent(remotePeer)}`
    : `/api/sessions/${encoded}/fork`;
}

function sidekickPortalDocument(): Document | null {
  if (typeof document === "undefined") return null;
  if (typeof window === "undefined" || window.parent === window) return document;
  try {
    return window.parent.document.body ? window.parent.document : document;
  } catch {
    return document;
  }
}

function imageDataUrl(image: Base64ImageAttachment): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

function messageText(message: UserMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function messageImages(message: UserMessage): SidekickImage[] {
  if (typeof message.content === "string") return [];
  return message.content.flatMap((block) => {
    if (block.type !== "image" || block.source.type !== "base64" || !block.source.data || !block.source.media_type) return [];
    const image = { data: block.source.data, mimeType: block.source.media_type };
    return isBase64ImageWithinLimits(image)
      ? [{ ...image, previewUrl: imageDataUrl(image) }]
      : [];
  });
}

function assistantText(messages: readonly AssistantMessage[]): string {
  return messages.flatMap((message) => message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)).join("\n\n");
}

function assistantThinking(messages: readonly AssistantMessage[]): string {
  return messages.flatMap((message) => message.content
    .filter((block) => block.type === "thinking")
    .map((block) => block.thinking)).filter(Boolean).join("\n\n");
}

function assistantToolNames(messages: readonly AssistantMessage[]): string[] {
  return messages.flatMap((message) => message.content
    .filter((block) => block.type === "toolCall")
    .map((block) => block.toolName));
}

function filterSidekickModelOptionsByProvider(
  options: { provider: string; modelId: string; name: string }[],
  hiddenProviders: ReadonlySet<string>,
  selectedModel?: { provider: string; modelId: string } | null,
): { provider: string; modelId: string; name: string }[] {
  return options.filter((option) => !hiddenProviders.has(option.provider)
    || (selectedModel?.provider === option.provider && selectedModel.modelId === option.modelId));
}

function filterSidekickModelOptions(
  options: { provider: string; modelId: string; name: string }[],
  query: string,
): { provider: string; modelId: string; name: string }[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return options;
  return options.filter((option) => `${option.name} ${option.modelId}`.toLocaleLowerCase().includes(normalizedQuery));
}

export function getSidekickThinkingLevels(
  activeModel: { provider: string; modelId: string } | null | undefined,
  modelThinkingLevels?: Record<string, string[]>,
): string[] {
  const levels = activeModel ? modelThinkingLevels?.[`${activeModel.provider}:${activeModel.modelId}`] : undefined;
  return levels ? ["auto", ...levels] : ["auto", "off", "low", "medium", "high"];
}

export function resolveSidekickThinkingLevel(
  current: string | null,
  available: readonly string[],
  preferred?: string | null,
): string {
  if (current && available.includes(current)) return current;
  if (preferred && available.includes(preferred)) return preferred;
  return [...available].reverse().find((level) => level !== "auto") ?? "auto";
}

function makeDraftThread(label: string): SideThread {
  return {
    id: `draft-${crypto.randomUUID()}`,
    label,
    sessionId: null,
    info: null,
    initialPrompt: null,
    initialImages: [],
    draft: "",
    images: [],
    count: 0,
  };
}

function ImageAttachments({
  images,
  onRemove,
}: {
  images?: SidekickImage[];
  onRemove?: (index: number) => void;
}) {
  const { t } = useI18n();
  if (!images?.length) return null;
  const sources = images.map((image) => image.previewUrl || imageDataUrl(image));
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6 }}>
      {images.map((image, index) => (
        <div key={`${image.mimeType}-${index}`} style={{ position: "relative", width: 52, height: 52, flexShrink: 0 }}>
          <ImagePreview src={sources[index]} alt={t("sidekick.imageAttachment", { index: index + 1 })} images={sources} initialIndex={index} style={{ width: "100%", height: "100%" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={sources[index]} alt={t("sidekick.imageAttachment", { index: index + 1 })} draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 5, border: "1px solid var(--border)", display: "block" }} />
          </ImagePreview>
          {onRemove && (
            <button type="button" onClick={() => onRemove(index)} aria-label={t("sidekick.removeImageAttachment", { index: index + 1 })} title={t("sidekick.removeImage")} style={{ position: "absolute", top: -5, right: -5, width: 17, height: 17, padding: 0, display: "grid", placeItems: "center", border: "1px solid var(--border)", borderRadius: "50%", background: "var(--bg-panel)", color: "var(--text-muted)", cursor: "pointer" }}>
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function SidekickQuestion({ question, images, copied, onCopy, onQuote }: { question: string; images?: SidekickImage[]; copied: boolean; onCopy: () => void; onQuote?: () => void }) {
  const { t } = useI18n();
  return (
    <div style={{ alignSelf: "flex-end", display: "flex", flexDirection: "column", alignItems: "flex-end", maxWidth: "100%", minWidth: 0 }}>
      <div className="sidekick-question" style={{ maxWidth: "100%", minWidth: 0, background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.25)", borderRadius: "8px 8px 2px 8px", padding: "8px 10px", fontSize: "var(--chat-content-font-size, 14px)", lineHeight: 1.7, color: "var(--text)" }}>
        <MarkdownBody className="markdown-user-message" keepLineBreaks literalHtml>{question}</MarkdownBody>
        <ImageAttachments images={images} />
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4, marginTop: 4 }}>
        <button type="button" onClick={onCopy} aria-label={t("sidekick.copyQuestion")} style={sidekickActionButtonStyle}>{copied ? t("i18n.copied") : t("i18n.copy")}</button>
        {onQuote && <button type="button" onClick={onQuote} aria-label={t("sidekick.quoteQuestion")} style={{ ...sidekickActionButtonStyle, color: "var(--accent)" }}>{t("sidekick.quote")}</button>}
      </div>
    </div>
  );
}

function SidekickAnswer({ messages }: { messages: readonly AssistantMessage[] }) {
  const { t } = useI18n();
  const text = assistantText(messages);
  const thinking = assistantThinking(messages);
  const tools = assistantToolNames(messages);
  return (
    <>
      {tools.length > 0 && <details style={{ marginBottom: 8, color: "var(--text-muted)", fontSize: 11 }}><summary>{t("sidekick.toolCalls", { count: tools.length })}</summary><ul>{tools.map((tool, index) => <li key={`${tool}-${index}`}>{tool}</li>)}</ul></details>}
      {text ? <MarkdownBody>{text}</MarkdownBody> : <p role="status" style={{ color: "var(--text-dim)", fontStyle: "italic" }}>{t("sidekick.noAnswerBody")}</p>}
      {thinking.trim() && <MarkdownBody>{t("sidekick.thinkingBlock", { thinking })}</MarkdownBody>}
    </>
  );
}

export function SidekickHeader({ threads, activeThreadId, busyThreads, mainBusy, expanded, rightPanel, canFork, isForking, isPortal = false, onSelect, onCloseThread, onDelete, onCreate, onFork, onExpand, onClose }: {
  threads: { id: string; label: string; count: number }[];
  activeThreadId: string;
  busyThreads: Set<string>;
  mainBusy: boolean;
  expanded: boolean;
  rightPanel: boolean;
  canFork: boolean;
  isForking: boolean;
  isPortal?: boolean;
  onSelect: (id: string) => void;
  onCloseThread: (event: React.MouseEvent, id: string) => void;
  onDelete: (event: React.MouseEvent, id: string) => void;
  onCreate: () => void;
  onFork: () => void;
  onExpand: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const contextThread = contextMenu ? threads.find((thread) => thread.id === contextMenu.id) : null;

  useEffect(() => {
    if (!contextMenu) return;
    const close = (event?: Event) => {
      if (event?.target instanceof Element && event.target.closest("[data-sidekick-context-menu]")) return;
      setContextMenu(null);
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setContextMenu(null); } };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("contextmenu", close, true);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", close);
    return () => { document.removeEventListener("pointerdown", close, true); document.removeEventListener("contextmenu", close, true); document.removeEventListener("keydown", key); window.removeEventListener("blur", close); };
  }, [contextMenu]);

  const openContextMenu = (event: React.MouseEvent, id: string) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ id, x: event.clientX, y: event.clientY });
  };

  const contextMenuElement = contextMenu && contextThread && (
    <div role="menu" aria-label={t("sidekick.threadActions", { label: contextThread.label })} data-sidekick-context-menu="true" data-sidekick-interaction="true" onContextMenu={(event) => event.preventDefault()} style={{ position: "fixed", left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 180)), top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 48)), minWidth: 172, padding: 4, border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg-panel)", boxShadow: "0 8px 24px rgba(0,0,0,0.18)", zIndex: 10001 }}>
      <button type="button" role="menuitem" data-sidekick-context-menu="true" data-sidekick-interaction="true" onClick={(event) => { const id = contextThread.id; setContextMenu(null); onDelete(event, id); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 8px", border: 0, borderRadius: 4, background: "transparent", color: "#dc2626", font: "inherit", fontSize: 12, textAlign: "left", cursor: "pointer" }}>
        <Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
        <span>{t("sidekick.deleteThreadForever")}</span>
      </button>
    </div>
  );

  return (
    <div data-sidekick-header="true" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", height: isPortal ? "100%" : 36, minHeight: 36, boxSizing: "border-box", padding: "0 10px", borderBottom: isPortal ? "none" : "1px solid var(--border)", background: isPortal ? "transparent" : "var(--bg)", flexShrink: 0 }}>
      <div role="tablist" aria-label={t("sidekick.threadTabs")} style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, minWidth: 0, height: "100%", overflowX: "auto" }}>
        {threads.map((thread, index) => (
          <div key={thread.id} onContextMenu={(event) => openContextMenu(event, thread.id)} style={{ display: "inline-flex", alignItems: "center", flexShrink: 0, height: 24, borderRadius: 4, background: thread.id === activeThreadId ? "var(--bg-selected)" : "transparent" }}>
            <button type="button" role="tab" aria-selected={thread.id === activeThreadId} aria-busy={busyThreads.has(thread.id) || undefined} tabIndex={thread.id === activeThreadId ? 0 : -1} onClick={() => { setContextMenu(null); onSelect(thread.id); }} onKeyDown={(event) => { let next: number; if (event.key === "ArrowRight") next = (index + 1) % threads.length; else if (event.key === "ArrowLeft") next = (index + threads.length - 1) % threads.length; else if (event.key === "Home") next = 0; else if (event.key === "End") next = threads.length - 1; else return; event.preventDefault(); onSelect(threads[next].id); }} title={`${t("sidekick.threadTabTitle", { label: thread.label, count: thread.count })}${busyThreads.has(thread.id) ? t("sidekick.threadGeneratingSuffix") : ""}`} style={{ border: 0, background: "none", color: thread.id === activeThreadId ? "var(--accent)" : "var(--text-muted)", font: "inherit", fontSize: 12, padding: "0 6px", height: "100%", cursor: "pointer", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center" }}>
              {busyThreads.has(thread.id) ? <span className="sidekick-stream-label">{thread.label}</span> : thread.label}
            </button>
            {threads.length > 1 && <button type="button" aria-label={t("sidekick.closeThread", { label: thread.label })} title={t("sidekick.closeThreadTitle")} onClick={(event) => onCloseThread(event, thread.id)} style={{ border: 0, background: "none", color: "var(--text-muted)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, height: 20, padding: 0, marginRight: 2, borderRadius: 2 }}><X size={10} aria-hidden="true" /></button>}
          </div>
        ))}
      </div>
      {contextMenuElement}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <button type="button" onClick={onCreate} aria-label={t("sidekick.newThread")} title={t("sidekick.newThread")} data-sidekick-interaction="true" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, width: 24, height: 24, boxSizing: "border-box", border: "1px solid var(--border)", borderRadius: 5, padding: 0, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer" }}><Plus size={14} strokeWidth={1.8} aria-hidden="true" /></button>
        {canFork && <button type="button" onClick={onFork} disabled={isForking} aria-label={t("sidekick.fork")} title={t("sidekick.forkThreadTitle")} data-sidekick-interaction="true" style={{ border: 0, background: "transparent", color: "var(--text-muted)", cursor: isForking ? "wait" : "pointer", width: 24, height: 24, padding: 0 }}>{isForking ? "…" : <GitBranch size={14} strokeWidth={1.8} aria-hidden="true" />}</button>}
        {!rightPanel && <button type="button" onClick={onExpand} aria-expanded={expanded} aria-label={expanded ? t("sidekick.restoreSidebar") : t("sidekick.openCentered")} title={expanded ? t("sidekick.restoreSidebar") : t("sidekick.openCentered")} data-sidekick-interaction="true" style={{ border: 0, background: "transparent", color: "var(--text-muted)", cursor: "pointer", width: 24, height: 24, padding: 0 }}>{expanded ? <Minimize2 size={14} strokeWidth={1.8} /> : <Maximize2 size={14} strokeWidth={1.8} />}</button>}
        <button type="button" onClick={onClose} aria-label={t("sidekick.close")} title={t("sidekick.close")} data-sidekick-interaction="true" style={{ border: 0, background: "transparent", color: "var(--text-muted)", cursor: "pointer", width: 24, height: 24, padding: 0 }}><X size={14} strokeWidth={1.8} /></button>
      </div>
    </div>
  );
}

function SidekickComposer({
  draft,
  setDraft,
  images,
  setImages,
  error,
  onError,
  onSend,
  disabled = false,
  modelList,
  modelNames,
  currentModel,
  thinkingLevels,
  thinkingLevel,
  onModelChange,
  onThinkingChange,
  onStop,
}: {
  draft: string;
  setDraft: (value: string) => void;
  images: SidekickImage[];
  setImages: (images: SidekickImage[]) => void;
  error: string | null;
  onError: (error: string | null) => void;
  onSend: () => void;
  disabled?: boolean;
  modelList?: ModelOption[];
  modelNames?: Record<string, string>;
  currentModel?: { provider: string; modelId: string } | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevel?: string | null;
  onModelChange?: (provider: string, modelId: string) => void;
  onThinkingChange?: (level: ThinkingLevelOption) => void;
  onStop?: () => void;
}) {
  const { t } = useI18n();
  const hiddenProviders = useHiddenModelProviders();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelSelectorRef = useRef<HTMLDivElement>(null);
  const thinkingSelectorRef = useRef<HTMLDivElement>(null);
  const modelPanelRef = useRef<HTMLDivElement>(null);
  const thinkingPanelRef = useRef<HTMLDivElement>(null);
  const compositionActiveRef = useRef(false);
  const compositionEndAtRef = useRef(0);
  const [processingImages, setProcessingImages] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [modelFilter, setModelFilter] = useState("");
  const [modelMenuPos, setModelMenuPos] = useState<{ bottom: number; left: number } | null>(null);
  const [thinkingMenuPos, setThinkingMenuPos] = useState<{ bottom: number; left: number } | null>(null);

  const modelOptions = useMemo(() => {
    const source = modelList?.length ? modelList : Object.entries(modelNames ?? {}).map(([id, name]) => ({ id, name, provider: currentModel?.provider ?? "unknown" }));
    return source.map((model) => ({ provider: model.provider, modelId: model.id, name: model.name }));
  }, [currentModel?.provider, modelList, modelNames]);
  const visibleModels = useMemo(() => filterSidekickModelOptionsByProvider(modelOptions, hiddenProviders, currentModel), [currentModel, hiddenProviders, modelOptions]);
  const filteredModels = useMemo(() => filterSidekickModelOptions(visibleModels, modelFilter), [modelFilter, visibleModels]);
  const modelGroups = useMemo(() => {
    const groups: { provider: string; options: typeof filteredModels }[] = [];
    for (const option of filteredModels) {
      const group = groups.find((item) => item.provider === option.provider);
      if (group) group.options.push(option);
      else groups.push({ provider: option.provider, options: [option] });
    }
    return groups;
  }, [filteredModels]);
  const availableThinkingLevels = useMemo(() => getSidekickThinkingLevels(currentModel, thinkingLevels), [currentModel, thinkingLevels]);
  const selectedThinkingLevel = resolveSidekickThinkingLevel(thinkingLevel ?? null, availableThinkingLevels, thinkingLevel ?? "auto");
  const displayModelName = currentModel
    ? modelOptions.find((option) => option.provider === currentModel.provider && option.modelId === currentModel.modelId)?.name ?? currentModel.modelId
    : t("sidekick.selectModel");

  const resize = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.max(56, Math.min(textarea.scrollHeight, 220))}px`;
  }, []);
  useLayoutEffect(() => { resize(); }, [draft, resize]);
  useEffect(() => { const handler = () => resize(); window.addEventListener("resize", handler); return () => window.removeEventListener("resize", handler); }, [resize]);
  useEffect(() => {
    if (!modelOpen && !thinkingOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (modelOpen && !modelSelectorRef.current?.contains(target) && !modelPanelRef.current?.contains(target)) { setModelOpen(false); setModelFilter(""); }
      if (thinkingOpen && !thinkingSelectorRef.current?.contains(target) && !thinkingPanelRef.current?.contains(target)) setThinkingOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [modelOpen, thinkingOpen]);

  const addFiles = async (files: File[]) => {
    if (!files.length || processingImages || disabled) return;
    const room = Math.max(0, MAX_ATTACHED_IMAGES - images.length);
    const accepted = files.filter((file) => file.type.startsWith("image/") && file.size <= MAX_ATTACHED_IMAGE_BYTES).slice(0, room);
    if (!accepted.length) { onError(t("sidekick.imageTooLarge", { size: MAX_ATTACHED_IMAGE_BYTES / (1024 * 1024) })); return; }
    setProcessingImages(true);
    try {
      const next = [...images];
      for (const file of accepted) {
        const image = await compressImageFile(file);
        if (!isBase64ImageWithinLimits(image)) throw new Error("image exceeds limit");
        next.push({ ...image, previewUrl: imageDataUrl(image) });
      }
      setImages(next);
      onError(null);
    } catch {
      onError(t("sidekick.imageReadFailed"));
    } finally {
      setProcessingImages(false);
    }
  };

  const openModelMenu = () => {
    setThinkingOpen(false);
    if (!modelOpen && modelSelectorRef.current) {
      const rect = modelSelectorRef.current.getBoundingClientRect();
      setModelMenuPos({ bottom: window.innerHeight - rect.top + 6, left: Math.max(8, rect.left) });
    }
    setModelOpen((value) => !value);
  };
  const openThinkingMenu = () => {
    setModelOpen(false);
    if (!thinkingOpen && thinkingSelectorRef.current) {
      const rect = thinkingSelectorRef.current.getBoundingClientRect();
      setThinkingMenuPos({ bottom: window.innerHeight - rect.top + 6, left: Math.max(8, rect.left) });
    }
    setThinkingOpen((value) => !value);
  };

  const modelPortal = modelOpen && modelMenuPos && typeof document !== "undefined" ? createPortal(
    <div ref={modelPanelRef} data-sidekick-interaction="true" style={{ position: "fixed", bottom: modelMenuPos.bottom, left: Math.min(modelMenuPos.left, window.innerWidth - 270), width: "max-content", minWidth: 240, maxWidth: 320, maxHeight: Math.min(360, window.innerHeight * 0.6), overflow: "hidden", display: "flex", flexDirection: "column", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.15)", zIndex: 10000 }}>
      {visibleModels.length > 8 && <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}><input value={modelFilter} onChange={(event) => setModelFilter(event.target.value)} placeholder={t("chat.filterModels")} aria-label={t("chat.filterModels")} autoFocus style={{ width: "100%", boxSizing: "border-box", padding: "5px 8px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 11 }} /></div>}
      <div role="listbox" aria-label={t("sidekick.selectModel")} style={{ minHeight: 0, overflowY: "auto" }}>
        {modelGroups.map((group, index) => <div key={group.provider} role="group" aria-label={group.provider}>
          {modelGroups.length > 1 && <div style={{ padding: "6px 12px 4px", fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", borderTop: index ? "1px solid var(--border)" : "none" }}>{group.provider}</div>}
          {group.options.map((option) => <SelectorRow key={`${option.provider}:${option.modelId}`} active={option.provider === currentModel?.provider && option.modelId === currentModel.modelId} onSelect={() => { onModelChange?.(option.provider, option.modelId); setModelOpen(false); setModelFilter(""); }}>{option.name}</SelectorRow>)}
        </div>)}
      </div>
    </div>, document.body,
  ) : null;
  const thinkingPortal = thinkingOpen && thinkingMenuPos && typeof document !== "undefined" ? createPortal(
    <div ref={thinkingPanelRef} role="listbox" aria-label={t("sidekick.selectThinkingLevel")} data-sidekick-interaction="true" style={{ position: "fixed", bottom: thinkingMenuPos.bottom, left: Math.min(thinkingMenuPos.left, window.innerWidth - 140), minWidth: 110, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, boxShadow: "0 -4px 16px rgba(0,0,0,0.15)", zIndex: 10000, padding: 4 }}>
      {availableThinkingLevels.map((level) => <button key={level} type="button" role="option" aria-selected={selectedThinkingLevel === level} data-sidekick-interaction="true" onClick={() => { onThinkingChange?.(level as ThinkingLevelOption); setThinkingOpen(false); }} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "5px 8px", fontSize: 11, textAlign: "left", border: 0, borderRadius: 4, background: selectedThinkingLevel === level ? "var(--bg-selected)" : "transparent", color: selectedThinkingLevel === level ? "var(--accent)" : "var(--text)", cursor: "pointer" }}>{level}{selectedThinkingLevel === level && <Check size={11} />}</button>)}
    </div>, document.body,
  ) : null;

  return (
    <>
      {modelPortal}{thinkingPortal}
      <div data-sidekick-composer="true" style={{ padding: "6px 8px 8px", background: "var(--bg)", display: "flex", flexDirection: "column", flex: "0 1 auto", minHeight: 0, maxHeight: "min(44%, 50dvh)", overflow: "hidden" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 auto", minHeight: 64, overflow: "hidden", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 8px 6px", position: "relative" }}>
          <textarea ref={textareaRef} value={draft} onChange={(event) => { setDraft(event.target.value); onError(null); }} onInput={resize} onPaste={(event) => { const files = Array.from(event.clipboardData?.items ?? []).filter((item) => item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file)); if (!files.length) return; event.preventDefault(); void addFiles(files); }} onKeyDown={(event) => { if (event.key !== "Enter" || event.shiftKey) return; handleExtensionDialogInputKeyDown(event.nativeEvent, compositionActiveRef.current, compositionEndAtRef.current, onSend); }} onCompositionStart={() => { compositionActiveRef.current = true; }} onCompositionEnd={() => { compositionActiveRef.current = false; compositionEndAtRef.current = Date.now(); }} onBlur={() => { compositionEndAtRef.current = getExtensionDialogInputCompositionEndAtOnBlur(compositionActiveRef.current, compositionEndAtRef.current); compositionActiveRef.current = false; }} placeholder="" rows={2} disabled={disabled} style={{ display: "block", flex: "1 1 auto", width: "100%", minWidth: 0, background: "transparent", border: 0, outline: 0, resize: "none", boxSizing: "border-box", minHeight: 56, maxHeight: 220, overflowY: "auto", overflowWrap: "anywhere", whiteSpace: "pre-wrap", fontSize: "var(--chat-content-font-size, 14px)", color: "var(--text)", lineHeight: 1.7 }} />
          <ImageAttachments images={images} onRemove={(index) => setImages(images.filter((_, imageIndex) => imageIndex !== index))} />
          {error && <div role="alert" style={{ color: "#ef4444", fontSize: 10 }}>{error}</div>}
          <input ref={fileInputRef} type="file" accept="image/*" multiple tabIndex={-1} aria-hidden="true" style={{ display: "none" }} onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void addFiles(files); }} />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginTop: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
              <div ref={modelSelectorRef} style={{ position: "relative" }}><button type="button" onClick={openModelMenu} aria-label={t("sidekick.selectModel")} title={t("sidekick.currentModel", { model: displayModelName })} style={{ display: "inline-flex", alignItems: "center", gap: 3, height: 22, padding: "0 6px", fontSize: 11, color: modelOpen ? "var(--text)" : "var(--text-muted)", background: modelOpen ? "var(--bg-hover)" : "transparent", border: "1px solid var(--border)", borderRadius: 4, cursor: "pointer", maxWidth: 150, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}><Bot size={11} strokeWidth={1.8} /><span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{displayModelName}</span><ChevronDown size={10} /></button></div>
              <div ref={thinkingSelectorRef} style={{ position: "relative" }}><button type="button" onClick={openThinkingMenu} aria-label={t("sidekick.thinkingLevel")} title={t("sidekick.thinkingLevelTitle", { level: selectedThinkingLevel })} style={{ display: "inline-flex", alignItems: "center", gap: 3, height: 22, padding: "0 6px", fontSize: 11, color: thinkingOpen ? "var(--text)" : "var(--text-muted)", background: thinkingOpen ? "var(--bg-hover)" : "transparent", border: "1px solid var(--border)", borderRadius: 4, cursor: "pointer" }}><Brain size={11} strokeWidth={1.8} /><span>{selectedThinkingLevel}</span><ChevronDown size={10} /></button></div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={disabled || processingImages || images.length >= MAX_ATTACHED_IMAGES} aria-label={t("sidekick.addImage")} title={t("sidekick.addImage")} style={{ display: "grid", placeItems: "center", width: 25, height: 23, padding: 0, background: "transparent", color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 4, cursor: "pointer", opacity: disabled || processingImages || images.length >= MAX_ATTACHED_IMAGES ? 0.45 : 1 }}><Paperclip size={13} /></button>
              {disabled && onStop && <button type="button" onClick={onStop} style={{ ...sidekickActionButtonStyle, color: "#ef4444" }}>{t("chat.stop")}</button>}
              <button type="button" onClick={onSend} aria-label={t("chat.send")} title={t("chat.send")} disabled={disabled || processingImages || (!draft.trim() && images.length === 0)} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 25, height: 23, padding: 0, background: "var(--accent)", color: "#fff", border: 0, borderRadius: 4, cursor: "pointer", opacity: disabled || processingImages || (!draft.trim() && images.length === 0) ? 0.45 : 1 }}><Send size={13} /></button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

type SideTurn = { user: UserMessage; answers: AssistantMessage[] };

function sideMessagesAfterBoundary(info: SideSessionInfo, messages: AgentMessage[], entryIds: string[]): AgentMessage[] {
  const first = info.sideFirstEntryId ? entryIds.indexOf(info.sideFirstEntryId) : -1;
  if (first >= 0) return messages.slice(first);
  const expectedUsers = info.sideMessageCount ?? 0;
  if (!expectedUsers) return [];
  const userIndices = messages.flatMap((message, index) => message.role === "user" ? [index] : []);
  const start = userIndices[Math.max(0, userIndices.length - expectedUsers)];
  return start === undefined ? [] : messages.slice(start);
}

function sideTurns(messages: readonly AgentMessage[]): SideTurn[] {
  const turns: SideTurn[] = [];
  let current: SideTurn | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      current = { user: message, answers: [] };
      turns.push(current);
    } else if (message.role === "assistant" && current) {
      current.answers.push(message);
    }
  }
  return turns;
}

function SideSessionThread({
  info,
  initialPrompt,
  initialImages,
  onInitialPromptConsumed,
  onInfoChange,
  draft,
  setDraft,
  images,
  setImages,
  composerError,
  setComposerError,
  remotePeer,
  onQuoteToComposer,
  onBusyChange,
  initialModel,
  initialThinkingLevel,
}: {
  info: SideSessionInfo;
  initialPrompt: string | null;
  initialImages: SidekickImage[];
  onInitialPromptConsumed: () => void;
  onInfoChange: (info: SideSessionInfo) => void;
  draft: string;
  setDraft: (value: string) => void;
  images: SidekickImage[];
  setImages: (images: SidekickImage[]) => void;
  composerError: string | null;
  setComposerError: (value: string | null) => void;
  remotePeer?: string | null;
  onQuoteToComposer?: (text: string) => void;
  onBusyChange: (busy: boolean) => void;
  initialModel: { provider: string; modelId: string } | null;
  initialThinkingLevel: string;
}) {
  const { t } = useI18n();
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialPromptKeyRef = useRef<string | null>(null);
  const [localOwnStartIndex, setLocalOwnStartIndex] = useState<number | null>(null);
  const agent = useAgentSession({ session: info, sessionRunning: true, newSessionCwd: null, newSessionDraftKey: null, remotePeer: remotePeer ?? undefined, chatInputRef });
  const streamingMessage = useStreamingSelector(agent.streamingStore, selectStreamingMessage);
  const isStreaming = useStreamingSelector(agent.streamingStore, selectIsStreaming);
  const busy = Boolean(agent.agentRunning || agent.sessionStatePending || agent.bashRunning || isStreaming);
  const ownMessages = useMemo(() => {
    const first = info.sideFirstEntryId ? agent.entryIds.indexOf(info.sideFirstEntryId) : -1;
    if (first >= 0) return agent.messages.slice(first);
    if (localOwnStartIndex !== null) return agent.messages.slice(localOwnStartIndex);
    return sideMessagesAfterBoundary(info, agent.messages, agent.entryIds);
  }, [agent.entryIds, agent.messages, info, localOwnStartIndex]);
  const turns = useMemo(() => sideTurns(ownMessages), [ownMessages]);

  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  useEffect(() => { initialPromptKeyRef.current = null; }, [info.id]);
  useEffect(() => {
    if (!initialPrompt || initialPromptKeyRef.current === initialPrompt || agent.loading || agent.error || agent.sessionStatePending || agent.agentRunning || agent.bashRunning) return;
    initialPromptKeyRef.current = initialPrompt;
    void (async () => {
      try {
        if (initialModel && (!agent.currentModel || agent.currentModel.provider !== initialModel.provider || agent.currentModel.modelId !== initialModel.modelId)) {
          await agent.handleModelChange(initialModel.provider, initialModel.modelId);
        }
        if (initialThinkingLevel && initialThinkingLevel !== "auto") {
          await agent.handleThinkingLevelChange(initialThinkingLevel as ThinkingLevelOption);
        }
        setLocalOwnStartIndex(agent.messages.length);
        await agent.handleSend(initialPrompt, initialImages);
        try {
          const response = await fetch(sideSessionUrl(info.id, remotePeer), { cache: "no-store" });
          const data = await response.json().catch(() => ({})) as { info?: SideSessionInfo };
          if (response.ok && data.info) onInfoChange(data.info);
        } catch {
          // The durable transcript remains available; the next session refresh retries metadata.
        }
        onInitialPromptConsumed();
      } catch {
        initialPromptKeyRef.current = null;
      }
    })();
  }, [agent.agentRunning, agent.bashRunning, agent.currentModel, agent.error, agent.handleModelChange, agent.handleSend, agent.handleThinkingLevelChange, agent.loading, agent.messages.length, agent.sessionStatePending, info.id, initialImages, initialModel, initialPrompt, initialThinkingLevel, onInfoChange, onInitialPromptConsumed, remotePeer]);

  useEffect(() => {
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [turns, streamingMessage, isStreaming]);

  const send = async () => {
    const text = draft.trim();
    const submittedImages = images;
    if ((!text && !submittedImages.length) || busy) return;
    setDraft("");
    setImages([]);
    setComposerError(null);
    if (!info.sideFirstEntryId && localOwnStartIndex === null) setLocalOwnStartIndex(agent.messages.length);
    try {
      await agent.handleSend(text, submittedImages);
      if (!info.sideFirstEntryId) {
        try {
          const response = await fetch(sideSessionUrl(info.id, remotePeer), { cache: "no-store" });
          const data = await response.json().catch(() => ({})) as { info?: SideSessionInfo };
          if (response.ok && data.info) onInfoChange(data.info);
        } catch {
          // The transcript is durable; the next list refresh retries the metadata read.
        }
      }
    } catch (error) {
      setDraft(text);
      setImages(submittedImages);
      setComposerError(String(error));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg-panel)" }}>
      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 14px", display: "flex", flexDirection: "column", gap: 16 }}>
        {agent.loading && turns.length === 0 && <div style={{ textAlign: "center", color: "var(--text-dim)", padding: 20 }}>{t("i18n.loading")}</div>}
        {!agent.loading && turns.length === 0 && !isStreaming && (
          <HowItWorks />
        )}
        {turns.map((turn, index) => {
          const question = messageText(turn.user);
          const answerText = assistantText(turn.answers);
          const answer = turn.answers.at(-1);
          const answerModel = answer?.model;
          const cacheHitRate = answer?.usage ? turnCacheHitRate(answer.usage) : null;
          return (
            <div key={`${turn.user.id ?? turn.user.timestamp ?? index}:${index}`} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <SidekickQuestion question={question} images={messageImages(turn.user)} copied={false} onCopy={() => void copyText(question)} onQuote={onQuoteToComposer ? () => onQuoteToComposer(question) : undefined} />
              {turn.answers.length > 0 && <div style={{ alignSelf: "flex-start", width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: "var(--chat-content-font-size, 14px)", lineHeight: 1.7 }} className="prose prose-sm dark:prose-invert max-w-none"><SidekickAnswer messages={turn.answers} /></div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 6, fontSize: 11, color: "var(--text-dim)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{answerModel || "LLM"}</span>
                    {cacheHitRate !== null && <><span aria-hidden="true" style={{ color: "var(--text-dim)" }}>·</span><span style={{ color: "var(--accent)", fontWeight: 600, whiteSpace: "nowrap" }}>{t("chat.turnCacheHitRate")} {cacheHitRate.toFixed(1)}%</span></>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <button type="button" onClick={() => void copyText(answerText || t("sidekick.noAnswerBodyParenthetical"))} style={sidekickActionButtonStyle} title={t("sidekick.copyAnswer")}>{t("i18n.copy")}</button>
                    {onQuoteToComposer && <button type="button" onClick={() => onQuoteToComposer(t("sidekick.quoteToComposerText", { question, answer: answerText || t("sidekick.noAnswerBodyParenthetical") }))} style={{ ...sidekickActionButtonStyle, color: "var(--accent)" }} title={t("sidekick.quoteAnswerTitle")}>{t("sidekick.quote")}</button>}
                  </div>
                </div>
              </div>}
            </div>
          );
        })}
        {isStreaming && streamingMessage?.role === "assistant" && <div style={{ display: "flex", flexDirection: "column", gap: 8 }}><div style={{ alignSelf: "flex-start", width: "100%", background: "var(--bg)", border: "1px solid rgba(16,185,129,0.4)", borderRadius: 8, padding: "10px 12px" }}><SidekickAnswer messages={[streamingMessage]} /><div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", marginTop: 6, paddingTop: 4, borderTop: "1px solid var(--border)", fontSize: 10, color: "#10b981" }}><span>{t("sidekick.generating")}</span></div></div></div>}
        {agent.error && <div role="alert" style={{ color: "#dc2626", fontSize: 12, whiteSpace: "pre-wrap" }}>{String(agent.error)}</div>}
      </div>
      <SidekickComposer draft={draft} setDraft={setDraft} images={images} setImages={setImages} error={composerError} onError={setComposerError} onSend={() => void send()} disabled={busy} modelList={agent.modelList as ModelOption[]} modelNames={agent.modelNames} currentModel={agent.currentModel} thinkingLevels={agent.modelThinkingLevels} thinkingLevel={agent.thinkingLevel} onModelChange={(provider, modelId) => void agent.handleModelChange(provider, modelId)} onThinkingChange={(level) => void agent.handleThinkingLevelChange(level)} onStop={() => void agent.handleAbort()} />
    </div>
  );
}

function HowItWorks() {
  const { t } = useI18n();
  return (
    <div style={{ padding: "16px 14px", background: "var(--bg-hover)", borderRadius: 8, border: "1px solid var(--border)", marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text)", fontWeight: 600, fontSize: 13, borderBottom: "1px solid var(--border)", paddingBottom: 8 }}><Sparkles size={15} style={{ color: "var(--accent)" }} aria-hidden="true" /><span>{t("sidekick.howItWorks")}</span></div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 12, lineHeight: 1.55 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}><span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: 4, background: "rgba(59,130,246,0.12)", color: "#3b82f6", flexShrink: 0 }}><GitFork size={13} /></span><div><strong style={{ color: "var(--text)", display: "block", marginBottom: 2 }}>{t("sidekick.howFirstTitle")}</strong><span style={{ color: "var(--text-muted)" }}>{t("sidekick.howFirstBody")}</span></div></div>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}><span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: 4, background: "rgba(245,158,11,0.12)", color: "#f59e0b", flexShrink: 0 }}><Zap size={13} /></span><div><strong style={{ color: "var(--text)", display: "block", marginBottom: 2 }}>{t("sidekick.howParallelTitle")}</strong><span style={{ color: "var(--text-muted)" }}>{t("sidekick.howParallelBody")}</span></div></div>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}><span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: 4, background: "rgba(16,185,129,0.12)", color: "#10b981", flexShrink: 0 }}><MessageSquare size={13} /></span><div><strong style={{ color: "var(--text)", display: "block", marginBottom: 2 }}>{t("sidekick.howFollowUpTitle")}</strong><span style={{ color: "var(--text-muted)" }}>{t("sidekick.howFollowUpBody")}</span></div></div>
      </div>
    </div>
  );
}

function SideSessionFallback({ sessionId, remotePeer, initialPrompt, onInitialPromptConsumed, onSessionForked }: { sessionId: string; remotePeer?: string | null; initialPrompt?: string | null; onInitialPromptConsumed: () => void; onSessionForked?: (result: SessionForkResult) => void }) {
  return <SessionChatPanel sessionId={sessionId} running remotePeer={remotePeer} initialPrompt={initialPrompt || undefined} onInitialPromptConsumed={onInitialPromptConsumed} onSessionForked={onSessionForked} />;
}

export function SidekickDrawer({
  sessionId,
  open,
  historyRevision: _historyRevision,
  onClose,
  onQuoteToComposer,
  mainBusy = false,
  activeBranchId: _activeBranchId = "main",
  activeParentId: _activeParentId,
  remotePeer,
  onSessionForked,
  onCountChange,
  placement = "sidebar",
  rightPanelTargetId = SIDEKICK_RIGHT_PANEL_TARGET_ID,
  modelList,
  modelNames,
  defaultModel,
  modelThinkingLevels,
  defaultThinkingLevel,
}: Props) {
  const { t } = useI18n();
  const [threads, setThreads] = useState<SideThread[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [sideSessionCount, setSideSessionCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<SidekickImage[]>([]);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [busyThreads, setBusyThreads] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [selectedModel, setSelectedModel] = useState<{ provider: string; modelId: string } | null>(defaultModel ?? null);
  const [selectedThinkingLevel, setSelectedThinkingLevel] = useState(defaultThinkingLevel ?? "auto");
  const loadSerialRef = useRef(0);
  const isRightPanelPlacement = placement === "right-panel";
  const shouldPortalToTopbar = placement === "sidebar" && !expanded;
  const [topbarTarget, setTopbarTarget] = useState<HTMLElement | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  const newThread = useCallback((index: number) => makeDraftThread(t("sidekick.threadTitle", { index })), [t]);

  const loadSideSessions = useCallback(async () => {
    if (!sessionId) return;
    const serial = ++loadSerialRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(sideSessionListUrl(sessionId, remotePeer), { cache: "no-store" });
      const data = await response.json().catch(() => ({})) as { sessions?: SideSessionInfo[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      if (serial !== loadSerialRef.current) return;
      const persisted = (data.sessions ?? []).map((info, index) => ({ id: info.id, label: t("sidekick.threadTitle", { index: index + 1 }), sessionId: info.id, info, initialPrompt: null, initialImages: [], draft: "", images: [], count: info.sideMessageCount ?? 0 }));
      setSideSessionCount(persisted.length);
      const emptyThread = newThread(1);
      setThreads((previous) => {
        const previousById = new Map(previous.map((thread) => [thread.id, thread]));
        const drafts = previous.filter((thread) => !thread.info);
        const merged = persisted.map((thread) => ({ ...thread, draft: previousById.get(thread.id)?.draft ?? "", images: previousById.get(thread.id)?.images ?? [], initialPrompt: previousById.get(thread.id)?.initialPrompt ?? null, initialImages: previousById.get(thread.id)?.initialImages ?? [] }));
        const next = [...merged, ...drafts];
        return next.length ? next : [emptyThread];
      });
      setActiveId((current) => {
        if (current && persisted.some((thread) => thread.id === current)) return current;
        return persisted[0]?.id ?? `draft-${loadSerialRef.current}`;
      });
    } catch (error) {
      if (serial !== loadSerialRef.current) return;
      setLoadError(String(error));
      setThreads((previous) => previous.length ? previous : [newThread(1)]);
    } finally {
      if (serial === loadSerialRef.current) setLoading(false);
    }
  }, [newThread, remotePeer, sessionId, t]);

  useEffect(() => {
    loadSerialRef.current += 1;
    setThreads([]);
    setActiveId("");
    setSideSessionCount(0);
    setDraft("");
    setImages([]);
    setComposerError(null);
    setBusyThreads(new Set());
    void loadSideSessions();
  }, [loadSideSessions, sessionId, remotePeer]);
  useEffect(() => { if (open) void loadSideSessions(); }, [loadSideSessions, open]);
  useEffect(() => { onCountChange?.(sideSessionCount); }, [onCountChange, sideSessionCount]);
  useEffect(() => { if (defaultModel) setSelectedModel(defaultModel); }, [defaultModel]);
  useEffect(() => { if (defaultThinkingLevel) setSelectedThinkingLevel(defaultThinkingLevel); }, [defaultThinkingLevel]);

  const activeThread = threads.find((thread) => thread.id === activeId) ?? threads[0] ?? null;
  useEffect(() => {
    if (!activeThread) return;
    setDraft(activeThread.draft);
    setImages(activeThread.images);
    setComposerError(null);
  }, [activeId]); // The active tab owns the draft; updates within it must not reset typing.
  useEffect(() => {
    if (!activeId) return;
    setThreads((previous) => previous.map((thread) => thread.id === activeId ? { ...thread, draft, images } : thread));
  }, [activeId, draft, images]);

  useEffect(() => {
    const handleQuote = (event: Event) => {
      const text = (event as CustomEvent<{ text?: unknown }>).detail?.text;
      if (typeof text === "string" && text.trim()) setDraft((current) => current ? `${current}\n\n${text}` : text);
    };
    window.addEventListener("pi-sidekick-quote", handleQuote);
    return () => window.removeEventListener("pi-sidekick-quote", handleQuote);
  }, []);

  useEffect(() => {
    if (!open || isRightPanelPlacement || typeof window === "undefined" || window.parent === window) return;
    const handleEmbeddedParentDismiss = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data as { type?: unknown } | null;
      if (data?.type === EMBEDDED_SIDEKICK_DISMISS_EVENT) onClose();
    };
    window.addEventListener("message", handleEmbeddedParentDismiss);
    return () => window.removeEventListener("message", handleEmbeddedParentDismiss);
  }, [isRightPanelPlacement, onClose, open]);
  useEffect(() => {
    if (!open || !expanded || typeof window === "undefined" || window.parent === window) return;
    if (sidekickPortalDocument() !== document) return;
    notifyEmbeddedModalState(true, "sidekick");
    return () => notifyEmbeddedModalState(false, "sidekick");
  }, [expanded, open]);
  useEffect(() => {
    if (!open || !expanded) return;
    const ownerWindow = sidekickPortalDocument()?.defaultView ?? window;
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setExpanded(false); } };
    ownerWindow.addEventListener("keydown", handleKeyDown);
    return () => ownerWindow.removeEventListener("keydown", handleKeyDown);
  }, [expanded, open]);
  useEffect(() => {
    if (!open || isRightPanelPlacement) return;
    const ownerDocument = expanded ? sidekickPortalDocument() ?? document : document;
    const handleOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target && typeof (target as Element).closest === "function" && (target as Element).closest("[data-sidekick-interaction]")) return;
      if (target && drawerRef.current?.contains(target as Node)) return;
      onClose();
    };
    ownerDocument.addEventListener("pointerdown", handleOutside);
    return () => ownerDocument.removeEventListener("pointerdown", handleOutside);
  }, [expanded, isRightPanelPlacement, onClose, open]);
  useEffect(() => {
    if (!open || !shouldPortalToTopbar || typeof document === "undefined") { setTopbarTarget(null); return; }
    const target = document.getElementById(SIDEKICK_TOPBAR_PORTAL_ID);
    if (target) { setTopbarTarget(target); return; }
    const frame = requestAnimationFrame(() => setTopbarTarget(document.getElementById(SIDEKICK_TOPBAR_PORTAL_ID)));
    return () => cancelAnimationFrame(frame);
  }, [open, shouldPortalToTopbar]);

  const selectThread = (id: string) => {
    if (id === activeId) return;
    setThreads((previous) => previous.map((thread) => thread.id === activeId ? { ...thread, draft, images } : thread));
    const next = threads.find((thread) => thread.id === id);
    setActiveId(id);
    setDraft(next?.draft ?? "");
    setImages(next?.images ?? []);
    setComposerError(null);
  };
  const createThread = () => {
    const thread = newThread(threads.length + 1);
    setThreads((previous) => [...previous, thread]);
    setActiveId(thread.id);
    setDraft("");
    setImages([]);
    setTimeout(() => document.querySelector<HTMLTextAreaElement>("[data-sidekick-composer] textarea")?.focus(), 0);
  };
  const closeThread = (event: React.MouseEvent, id: string) => {
    event.stopPropagation();
    const remaining = threads.filter((thread) => thread.id !== id);
    if (!remaining.length) {
      const thread = newThread(1);
      setThreads([thread]);
      setActiveId(thread.id);
      setDraft("");
      setImages([]);
      return;
    }
    setThreads(remaining);
    if (id === activeId) {
      const next = remaining[0];
      setActiveId(next.id);
      setDraft(next.draft);
      setImages(next.images);
      setComposerError(null);
    }
  };
  const deleteThread = async (event: React.MouseEvent, id: string) => {
    event.stopPropagation();
    const thread = threads.find((item) => item.id === id);
    if (!thread) return;
    if (!thread.info) { closeThread(event, id); return; }
    if (!window.confirm(t("sidekick.deleteThreadConfirm", { label: thread.label }))) return;
    try {
      const response = await fetch(sideSessionDeleteUrl(thread.info.id, remotePeer), { method: "DELETE" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setSideSessionCount((count) => Math.max(0, count - 1));
      closeThread(event, id);
    } catch (error) {
      setComposerError(String(error));
    }
  };
  const setBusy = useCallback((id: string, busy: boolean) => {
    setBusyThreads((previous) => { const next = new Set(previous); if (busy) next.add(id); else next.delete(id); return next; });
  }, []);

  const createSideSession = async () => {
    const prompt = draft.trim();
    const submittedImages = images;
    if ((!prompt && !submittedImages.length) || !activeThread || activeThread.info || creating) return;
    setCreating(true);
    setComposerError(null);
    try {
      const response = await fetch(sideSessionForkUrl(sessionId, remotePeer), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ side: true, name: prompt }) });
      const data = await response.json().catch(() => ({})) as { sessionId?: string; error?: string };
      if (!response.ok || !data.sessionId) throw new Error(data.error ?? `HTTP ${response.status}`);
      const infoResponse = await fetch(sideSessionUrl(data.sessionId, remotePeer), { cache: "no-store" });
      const infoData = await infoResponse.json().catch(() => ({})) as { info?: SideSessionInfo; error?: string };
      if (!infoResponse.ok || !infoData.info) throw new Error(infoData.error ?? `HTTP ${infoResponse.status}`);
      const info = infoData.info;
      setThreads((previous) => previous.map((thread) => thread.id === activeThread.id ? { ...thread, sessionId: info.id, info, initialPrompt: prompt, initialImages: submittedImages, draft: "", images: [], count: 0 } : thread));
      setSideSessionCount((count) => count + 1);
      setDraft("");
      setImages([]);
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  };

  const promoteActiveSideSession = async () => {
    const thread = activeThread;
    if (!thread?.info || promoting || busyThreads.has(thread.id)) return;
    setPromoting(true);
    setComposerError(null);
    try {
      const response = await fetch(sideSessionForkUrl(thread.info.id, remotePeer), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promote: true }),
      });
      const data = await response.json().catch(() => ({})) as { sessionId?: string; sessionPath?: string; error?: string };
      if (!response.ok || !data.sessionId) throw new Error(data.error ?? `HTTP ${response.status}`);
      onClose();
      onSessionForked?.({ newSessionId: data.sessionId, newSessionPath: data.sessionPath });
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : String(error));
    } finally {
      setPromoting(false);
    }
  };

  const activeSideBusy = activeThread ? busyThreads.has(activeThread.id) : false;
  const canPromote = Boolean(activeThread?.info && (activeThread.info.sideMessageCount ?? 0) > 0 && !activeSideBusy);
  const activeModel = activeThread?.info ? null : selectedModel;
  const headerThreads = threads.map((thread, index) => ({ id: thread.id, label: thread.label || `${index + 1}`, count: thread.count }));
  const headerElement = <SidekickHeader threads={headerThreads} activeThreadId={activeThread?.id ?? ""} busyThreads={busyThreads} mainBusy={mainBusy} expanded={expanded} rightPanel={isRightPanelPlacement} canFork={canPromote} isForking={promoting} isPortal={Boolean(shouldPortalToTopbar && topbarTarget)} onSelect={selectThread} onCloseThread={closeThread} onDelete={(event, id) => void deleteThread(event, id)} onCreate={createThread} onFork={() => void promoteActiveSideSession()} onExpand={() => setExpanded((value) => !value)} onClose={onClose} />;
  const activeContent = activeThread?.info ? (
    <SideSessionThread
      key={activeThread.info.id}
      info={activeThread.info}
      initialPrompt={activeThread.initialPrompt}
      initialImages={activeThread.initialImages}
      onInitialPromptConsumed={() => setThreads((previous) => previous.map((thread) => thread.id === activeThread.id ? { ...thread, initialPrompt: null, initialImages: [] } : thread))}
      onInfoChange={(info) => setThreads((previous) => previous.map((thread) => thread.id === activeThread.id ? { ...thread, info, count: info.sideMessageCount ?? thread.count } : thread))}
      draft={draft}
      setDraft={setDraft}
      images={images}
      setImages={setImages}
      composerError={composerError}
      setComposerError={setComposerError}
      remotePeer={remotePeer}
      onQuoteToComposer={onQuoteToComposer}
      onBusyChange={(busy) => setBusy(activeThread.id, busy)}
      initialModel={activeThread.initialPrompt ? selectedModel : null}
      initialThinkingLevel={activeThread.initialPrompt ? selectedThinkingLevel : "auto"}
    />
  ) : activeThread?.sessionId ? (
    <SideSessionFallback sessionId={activeThread.sessionId} remotePeer={remotePeer} initialPrompt={activeThread.initialPrompt} onInitialPromptConsumed={() => setThreads((previous) => previous.map((thread) => thread.id === activeThread.id ? { ...thread, initialPrompt: null } : thread))} onSessionForked={onSessionForked} />
  ) : (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg-panel)" }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 14px" }}><HowItWorks /></div>
      <SidekickComposer draft={draft} setDraft={setDraft} images={images} setImages={setImages} error={composerError} onError={setComposerError} onSend={() => void createSideSession()} disabled={creating} modelList={modelList} modelNames={modelNames} currentModel={activeModel} thinkingLevels={modelThinkingLevels} thinkingLevel={selectedThinkingLevel} onModelChange={(provider, modelId) => setSelectedModel({ provider, modelId })} onThinkingChange={(level) => setSelectedThinkingLevel(level)} />
    </div>
  );

  const resolvedTopbarTarget = topbarTarget ?? (typeof document !== "undefined" && shouldPortalToTopbar ? document.getElementById(SIDEKICK_TOPBAR_PORTAL_ID) : null);
  const isPortaled = Boolean(shouldPortalToTopbar && resolvedTopbarTarget);
  const drawer = <div ref={drawerRef} data-sidekick-drawer="true" className="chat-content" role={expanded ? "dialog" : "complementary"} aria-modal={expanded ? true : undefined} aria-label={t("sidekick.title")} style={{ ...(isRightPanelPlacement ? { position: "relative", width: "100%", height: "100%", minWidth: 0, border: 0, boxShadow: "none", zIndex: 1 } : expanded ? { position: "relative", width: "min(1120px, calc(100vw - 28px))", height: "min(88vh, calc(100dvh - 36px))", maxWidth: "calc(100vw - 28px)", maxHeight: "calc(100dvh - 36px)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 24px 64px rgba(0,0,0,0.36)", zIndex: 1 } : { position: "absolute", top: 0, right: 0, bottom: 0, width: SIDEKICK_WIDTH, maxWidth: "94vw", borderLeft: "1px solid var(--border)", boxShadow: "-4px 0 24px rgba(0,0,0,0.18)", zIndex: 55 }), background: "var(--bg-panel)", display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden", fontSize: 12, color: "var(--text)" }}>
    {!isPortaled && headerElement}
    {loading && !activeThread ? <div style={{ padding: 20, color: "var(--text-dim)", textAlign: "center" }}>{t("i18n.loading")}</div> : loadError && !activeThread?.info && !activeThread?.sessionId ? <div role="alert" style={{ padding: 16, color: "#dc2626", fontSize: 12 }}>{loadError}</div> : <div style={{ flex: 1, minHeight: 0 }}>{activeContent}</div>}
  </div>;

  if (!open) return null;
  const topbarPortal = isPortaled && resolvedTopbarTarget ? createPortal(headerElement, resolvedTopbarTarget) : null;
  const portalDocument = sidekickPortalDocument();
  if (isRightPanelPlacement) {
    const target = typeof document !== "undefined" ? document.getElementById(rightPanelTargetId) : null;
    return target ? <>{topbarPortal}{createPortal(drawer, target)}</> : null;
  }
  if (!expanded || !portalDocument?.body) return <>{topbarPortal}{drawer}</>;
  return <>{topbarPortal}{createPortal(<div role="presentation" style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.5)", backdropFilter: "blur(2px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)" }}>{drawer}</div>, portalDocument.body)}</>;
}
