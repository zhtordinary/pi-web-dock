"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { Bot, Brain, Check, ChevronDown, GitBranch, GitFork, Maximize2, MessageSquare, Minimize2, Paperclip, Plus, Send, Sparkles, Trash2, X, Zap } from "lucide-react";
import { ImagePreview } from "./ImagePreview";
import { MarkdownBody } from "./MarkdownBody";
import { copyText } from "@/lib/clipboard";
import {
  getExtensionDialogInputCompositionEndAtOnBlur,
  handleExtensionDialogInputKeyDown,
} from "@/lib/extension-dialog-keyboard";
import {
  compressImageFile,
  isBase64ImageWithinLimits,
  MAX_ATTACHED_IMAGE_BYTES,
  MAX_ATTACHED_IMAGES,
  type Base64ImageAttachment,
} from "@/lib/image-attachments";
import type { SessionForkResult } from "@/hooks/useAgentSession";
import type { QuickAskEntry } from "@/lib/quick-ask-storage";
import type { QuickAskRunSnapshot, QuickAskScope } from "@/lib/quick-ask-log";
import { isQuickAskRunActive } from "@/lib/quick-ask-status";
import { localizeQuickAskError, observeQuickAskRun, readQuickAskRun, requestQuickAskFork } from "@/lib/quick-ask-observer";
import { EMBEDDED_SIDEKICK_DISMISS_EVENT, notifyEmbeddedModalState } from "@/lib/embedded-modal";
import { SelectorRow } from "./SelectorRow";
import { useI18n } from "@/hooks/useI18n";
import { useHiddenModelProviders } from "@/hooks/useHiddenModelProviders";

type Translate = ReturnType<typeof useI18n>["t"];

const MODEL_OPTION_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareSidekickModelOptions(
  a: { provider: string; modelId: string; name: string },
  b: { provider: string; modelId: string; name: string },
): number {
  return MODEL_OPTION_COLLATOR.compare(a.name || a.modelId, b.name || b.modelId)
    || MODEL_OPTION_COLLATOR.compare(a.provider, b.provider)
    || MODEL_OPTION_COLLATOR.compare(a.modelId, b.modelId);
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

  return options.filter((option) => (
    `${option.name} ${option.modelId}`
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  ));
}

export function getSidekickThinkingLevels(
  activeModel: { provider: string; modelId: string } | null | undefined,
  modelThinkingLevels?: Record<string, string[]>,
): string[] {
  const levels = activeModel
    ? modelThinkingLevels?.[`${activeModel.provider}:${activeModel.modelId}`]
    : undefined;
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

/** The active topic is always a listed tab; a deleted "default" falls back to the first listed topic. */
export function resolveSidekickActiveThread(stored: string | undefined, threads: readonly string[]): string {
  if (stored !== undefined && threads.includes(stored)) return stored;
  return threads.includes("default") ? "default" : threads[0] ?? "default";
}

type SidekickImage = Base64ImageAttachment & { previewUrl: string };
type DisplayImage = Base64ImageAttachment & { previewUrl?: string };

type HistoryRequestState = {
  requestId: number;
  sessionId: string;
  quickAskUrl: string;
  promise: Promise<void> | null;
  loaded: boolean;
};

type SidekickHistoryControllerOptions = {
  historyRequestRef: { current: HistoryRequestState };
  fetcher?: typeof fetch;
  onItems: (items: QuickAskEntry[]) => void;
  onRuns?: (runs: QuickAskRunSnapshot[]) => void;
  onPromotedBranches?: (branches: string[]) => void;
  onLoading: (loading: boolean) => void;
};

type SidekickHistoryDeleteBody = {
  branchId?: string;
  threadId?: string;
  targetId?: string;
  requestId?: string;
};

export function createSidekickHistoryController({
  historyRequestRef,
  fetcher = fetch,
  onItems,
  onRuns,
  onPromotedBranches,
  onLoading,
}: SidekickHistoryControllerOptions) {
  const isCurrentIdentity = (sessionId: string, quickAskUrl: string) => {
    const current = historyRequestRef.current;
    return current.sessionId === sessionId && current.quickAskUrl === quickAskUrl;
  };

  const isCurrentRequest = (
    requestId: number,
    sessionId: string,
    quickAskUrl: string,
  ) => {
    const current = historyRequestRef.current;
    return current.requestId === requestId
      && current.sessionId === sessionId
      && current.quickAskUrl === quickAskUrl;
  };

  const syncIdentity = (sessionId: string, quickAskUrl: string) => {
    const current = historyRequestRef.current;
    if (current.sessionId === sessionId && current.quickAskUrl === quickAskUrl) return false;
    historyRequestRef.current = {
      requestId: current.requestId + 1,
      sessionId,
      quickAskUrl,
      promise: null,
      loaded: false,
    };
    return true;
  };

  const invalidate = (sessionId: string, quickAskUrl: string) => {
    if (!isCurrentIdentity(sessionId, quickAskUrl)) return false;
    const current = historyRequestRef.current;
    historyRequestRef.current = {
      ...current,
      requestId: current.requestId + 1,
      promise: null,
      loaded: false,
    };
    onLoading(false);
    return true;
  };

  const load = (sessionId: string, quickAskUrl: string): Promise<void> => {
    if (!sessionId) return Promise.resolve();
    syncIdentity(sessionId, quickAskUrl);
    if (!isCurrentIdentity(sessionId, quickAskUrl)) return Promise.resolve();

    const current = historyRequestRef.current;
    if (current.promise) return current.promise;
    if (current.loaded) return Promise.resolve();

    const requestId = current.requestId;
    const requestSessionId = sessionId;
    const requestUrl = quickAskUrl;
    onLoading(true);

    let requestPromise: Promise<void> | null = null;
    requestPromise = (async () => {
      try {
        const res = await fetcher(requestUrl);
        if (!res.ok) return;
        const json = (await res.json()) as { success?: boolean; items?: QuickAskEntry[]; runs?: QuickAskRunSnapshot[]; promotedBranches?: string[] };
        if (!isCurrentRequest(requestId, requestSessionId, requestUrl)) return;
        historyRequestRef.current = { ...historyRequestRef.current, loaded: true };
        if (Array.isArray(json.items)) onItems(json.items);
        if (Array.isArray(json.promotedBranches)) onPromotedBranches?.(json.promotedBranches.filter((branch) => typeof branch === "string" && branch !== "main"));
        if (Array.isArray(json.runs)) onRuns?.(json.runs);
      } catch {
        // Ignore network errors.
      } finally {
        if (!isCurrentRequest(requestId, requestSessionId, requestUrl)) return;
        const latest = historyRequestRef.current;
        if (requestPromise === null || latest.promise !== requestPromise) return;
        onLoading(false);
        historyRequestRef.current = { ...latest, promise: null };
      }
    })();

    historyRequestRef.current = { ...current, promise: requestPromise };
    return requestPromise;
  };

  const deleteWithRecovery = async (
    sessionId: string,
    quickAskUrl: string,
    body: SidekickHistoryDeleteBody,
    onOptimistic: () => void,
  ) => {
    if (!sessionId || !invalidate(sessionId, quickAskUrl)) return false;
    onOptimistic();

    let succeeded = false;
    try {
      const res = await fetcher(quickAskUrl, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      succeeded = res.ok;
    } catch {
      // Recover from the durable store below.
    }

    if (succeeded) return true;
    if (isCurrentIdentity(sessionId, quickAskUrl)) await load(sessionId, quickAskUrl);
    return false;
  };

  return { syncIdentity, isCurrentIdentity, invalidate, load, deleteWithRecovery };
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

function ImageAttachments({
  images,
  onRemove,
}: {
  images?: DisplayImage[];
  onRemove?: (index: number) => void;
}) {
  const { t } = useI18n();
  if (!images?.length) return null;

  const imageSources = images.map((image) => image.previewUrl || imageDataUrl(image));
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6 }}>
      {images.map((image, index) => (
        <div
          key={`${image.mimeType}-${index}`}
          style={{ position: "relative", width: 52, height: 52, flexShrink: 0 }}
        >
          <ImagePreview
            src={imageSources[index]}
            alt={t("sidekick.imageAttachment", { index: index + 1 })}
            images={imageSources}
            initialIndex={index}
            style={{ width: "100%", height: "100%" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageSources[index]}
              alt={t("sidekick.imageAttachment", { index: index + 1 })}
              draggable={false}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                borderRadius: 5,
                border: "1px solid var(--border)",
                display: "block",
              }}
            />
          </ImagePreview>
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(index)}
              aria-label={t("sidekick.removeImageAttachment", { index: index + 1 })}
              title={t("sidekick.removeImage")}
              style={{
                position: "absolute",
                top: -5,
                right: -5,
                width: 17,
                height: 17,
                padding: 0,
                display: "grid",
                placeItems: "center",
                border: "1px solid var(--border)",
                borderRadius: "50%",
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function sidekickViewKey(url: string, branchId: string, threadId: string): string {
  return JSON.stringify([url, branchId, threadId]);
}

export function mergeSidekickThreadLists(
  previous: Record<string, string[]>,
  url: string,
  items: readonly QuickAskEntry[],
): Record<string, string[]> {
  const next = { ...previous };
  for (const item of items) {
    const branchId = item.data.branchId || item.branchId || "main";
    const threadId = item.data.threadId || item.threadId || "default";
    const key = sidekickViewKey(url, branchId, "");
    next[key] = Array.from(new Set([...(next[key] ?? []), threadId]));
  }
  return next;
}

interface SidekickLiveReply { question: string; images: SidekickImage[]; answer: string; thinking: string; running: boolean; settling?: boolean; activeTools?: string[]; deleting?: boolean; runId?: string; unconfirmed?: boolean; }
interface SidekickStreamRequest {
  controller: AbortController; running: boolean; deleting?: boolean; runId?: string;
  observing?: boolean; accepted?: boolean; stopRequested?: boolean; retained?: boolean;
  /** Sends this exact request again; the host answers with the turn it already admitted or admits it now, never a second one. */
  resend?: () => Promise<void>;
}
type SidekickDraft = { question: string; images: SidekickImage[]; error: string | null };
interface SidekickViewState {
  drafts: Record<string, SidekickDraft>;
  replies: Record<string, SidekickLiveReply>;
}

/** Restore the whole draft and release its matching source in the same state transition. */
export function restoreSidekickDraft(
  previous: SidekickViewState, key: string,
  source: Pick<SidekickLiveReply, "runId" | "question" | "images">, processing: boolean, t: Translate, reason?: string,
): SidekickViewState {
  const reply = previous.replies[key];
  if (!reply || reply.runId !== source.runId) return previous;
  const draft = previous.drafts[key] ?? { question: "", images: [], error: null };
  if (draft.question.trim() || draft.images.length || processing) {
    if (reason === undefined) return { ...previous, drafts: { ...previous.drafts, [key]: {
      ...draft, error: t("sidekick.restoreDraftBusy"),
    } } };
    return { ...previous, replies: { ...previous.replies, [key]: {
      ...reply, running: false, unconfirmed: false, answer: `[${t("sidekick.notSent", { reason })}]`,
    } } };
  }
  const replies = { ...previous.replies }; delete replies[key];
  return { drafts: { ...previous.drafts, [key]: { question: source.question, images: source.images,
    error: reason === undefined ? null : t("sidekick.notSent", { reason }) } }, replies };
}

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

export function SidekickQuestion({ question, images, copied, onCopy, onQuote }: {
  question: string; images?: DisplayImage[]; copied: boolean; onCopy: () => void; onQuote?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div style={{ alignSelf: "flex-end", display: "flex", flexDirection: "column", alignItems: "flex-end", maxWidth: "100%", minWidth: 0 }}>
      <div className="sidekick-question" style={{ maxWidth: "100%", minWidth: 0, background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.25)", borderRadius: "8px 8px 2px 8px", padding: "8px 10px", fontSize: "var(--chat-content-font-size, 14px)", lineHeight: 1.7, color: "var(--text)" }}>
        <MarkdownBody className="markdown-user-message" keepLineBreaks literalHtml>{question}</MarkdownBody>
        <ImageAttachments images={images} />
      </div>
      <div className="sidekick-question-actions" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4, marginTop: 4 }}>
        <button type="button" onClick={onCopy} aria-label={t("sidekick.copyQuestion")} style={sidekickActionButtonStyle}>{copied ? t("i18n.copied") : t("i18n.copy")}</button>
        {onQuote && <button type="button" onClick={onQuote} aria-label={t("sidekick.quoteQuestion")} style={{ ...sidekickActionButtonStyle, color: "var(--accent)" }}>{t("sidekick.quote")}</button>}
      </div>
    </div>
  );
}

export function SidekickAnswer({ entry }: { entry: QuickAskEntry }) {
  const { t } = useI18n();
  const hasAnswer = Boolean(entry.data.answer?.trim());
  return <>
    {entry.data.toolCalls?.length ? <details style={{ marginBottom: 8, color: "var(--text-muted)", fontSize: 11 }}>
      <summary>{t("sidekick.toolCalls", { count: entry.data.toolCalls.length })}</summary>
      <ul>{entry.data.toolCalls.map((tool, index) => <li key={`${index}:${tool.name}`}>
        {tool.name} · {t(tool.isError ? "sidekick.toolFailed" : "sidekick.toolFinished")}
      </li>)}</ul>
    </details> : null}
    {entry.stopReason === "length" && (
      <p role="status" style={{ color: "var(--text-muted)" }}>{t("sidekick.outputLimitReached")}</p>
    )}
    {hasAnswer ? <MarkdownBody>{entry.data.answer}</MarkdownBody> : <>
      <p role="status" style={{ color: "var(--text-dim)", fontStyle: "italic" }}>{t("sidekick.noAnswerBody")}</p>
      {entry.data.thinking?.trim() && <MarkdownBody>{t("sidekick.thinkingBlock", { thinking: entry.data.thinking ?? "" })}</MarkdownBody>}
    </>}
  </>;
}

export const SIDEKICK_RIGHT_PANEL_TARGET_ID = "reader-right-panel-sidekick";
export const SIDEKICK_TOPBAR_PORTAL_ID = "reader-session-topbar-sidekick";

const sidekickIconStyle: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, width: 24, height: 24, boxSizing: "border-box", border: "1px solid var(--border)", borderRadius: 4, padding: 0, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer" };

const sidekickHeaderButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  width: 24,
  height: 24,
  boxSizing: "border-box",
  border: "none",
  borderRadius: 5,
  padding: 0,
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  transition: "color 0.12s, background-color 0.12s",
};

const sidekickCloseButtonStyle: React.CSSProperties = {
  ...sidekickHeaderButtonStyle,
  width: 36,
};

export function SidekickHeader({ threads, activeThreadId, busyThreads, mainBusy, expanded, rightPanel, canFork, isForking, isPortal = false, onSelect, onCloseThread, onDelete, onCreate, onFork, onExpand, onClose }: {
  threads: { id: string; label: string; count: number }[]; activeThreadId: string; busyThreads: Set<string>; mainBusy: boolean; expanded: boolean; rightPanel: boolean; canFork: boolean; isForking: boolean; isPortal?: boolean;
  onSelect: (id: string) => void; onCloseThread: (event: React.MouseEvent, id: string) => void; onDelete: (event: React.MouseEvent, id: string) => void; onCreate: () => void; onFork: () => void; onExpand: () => void; onClose: () => void;
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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setContextMenu(null);
      }
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("contextmenu", close, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("contextmenu", close, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  const openContextMenu = (event: React.MouseEvent, id: string) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ id, x: event.clientX, y: event.clientY });
  };

  const openContextMenuFromKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    setContextMenu({ id, x: rect.left, y: rect.bottom });
  };

  const contextMenuElement = contextMenu && contextThread && (
    <div
      role="menu"
      aria-label={t("sidekick.threadActions", { label: contextThread.label })}
      data-sidekick-context-menu="true"
      data-sidekick-interaction="true"
      onContextMenu={(event) => event.preventDefault()}
      style={{
        position: "fixed",
        left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 180)),
        top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 48)),
        minWidth: 172,
        padding: 4,
        border: "1px solid var(--border)",
        borderRadius: 5,
        background: "var(--bg-panel)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
        zIndex: 10001,
      }}
    >
      <button
        type="button"
        role="menuitem"
        data-sidekick-context-menu="true"
        data-sidekick-interaction="true"
        onClick={(event) => {
          const id = contextThread.id;
          setContextMenu(null);
          onDelete(event, id);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "7px 8px",
          border: 0,
          borderRadius: 4,
          background: "transparent",
          color: "#dc2626",
          font: "inherit",
          fontSize: 12,
          textAlign: "left",
          cursor: "pointer",
        }}
        onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
      >
        <Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
        <span>{t("sidekick.deleteThreadForever")}</span>
      </button>
    </div>
  );

  return (
    <div
      data-sidekick-header="true"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        width: "100%",
        height: isPortal ? "100%" : 36,
        minHeight: 36,
        boxSizing: "border-box",
        padding: "0 10px",
        borderBottom: isPortal ? "none" : "1px solid var(--border)",
        background: isPortal ? "transparent" : "var(--bg)",
        flexShrink: 0,
      }}
    >
      <div
        role="tablist"
        aria-label={t("sidekick.threadTabs")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          flex: 1,
          minWidth: 0,
          height: "100%",
          overflowX: "auto",
        }}
      >
        {threads.map((thread, index) => (
          <div
            key={thread.id}
            onContextMenu={(event) => openContextMenu(event, thread.id)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              flexShrink: 0,
              height: 24,
              borderRadius: 4,
              background: thread.id === activeThreadId ? "var(--bg-selected)" : "transparent",
              transition: "background-color 0.12s",
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={thread.id === activeThreadId}
              aria-haspopup="menu"
              aria-busy={busyThreads.has(thread.id) || undefined}
              tabIndex={thread.id === activeThreadId ? 0 : -1}
              onClick={() => {
                setContextMenu(null);
                onSelect(thread.id);
              }}
              onKeyDown={(event) => {
                openContextMenuFromKeyboard(event, thread.id);
                if (event.defaultPrevented) return;
                let next: number;
                if (event.key === "ArrowRight") next = (index + 1) % threads.length;
                else if (event.key === "ArrowLeft") next = (index + threads.length - 1) % threads.length;
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = threads.length - 1;
                else return;
                event.preventDefault();
                setContextMenu(null);
                onSelect(threads[next].id);
                (event.currentTarget.parentElement?.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next])?.focus();
              }}
              title={`${t("sidekick.threadTabTitle", { label: thread.label, count: thread.count })}${busyThreads.has(thread.id) ? t("sidekick.threadGeneratingSuffix") : ""}`}
              style={{
                border: 0,
                background: "none",
                color: thread.id === activeThreadId ? "var(--accent)" : "var(--text-muted)",
                font: "inherit",
                fontSize: 12,
                padding: "0 6px",
                height: "100%",
                cursor: "pointer",
                whiteSpace: "nowrap",
                display: "inline-flex",
                alignItems: "center",
                transition: "color 0.12s",
              }}
              onMouseEnter={(e) => { if (thread.id !== activeThreadId) e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = thread.id === activeThreadId ? "var(--accent)" : "var(--text-muted)"; }}
            >
              {busyThreads.has(thread.id)
                ? <span className="sidekick-stream-label">{thread.label}</span>
                : thread.label}
            </button>
            {threads.length > 1 && (
              <button
                type="button"
                aria-label={t("sidekick.closeThread", { label: thread.label })}
                title={t("sidekick.closeThreadTitle")}
                onClick={(event) => {
                  setContextMenu(null);
                  onCloseThread(event, thread.id);
                }}
                style={{
                  border: 0,
                  background: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 16,
                  height: 20,
                  padding: 0,
                  marginRight: 2,
                  borderRadius: 2,
                  transition: "color 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <X size={10} aria-hidden="true" />
              </button>
            )}
          </div>
        ))}
      </div>
      {contextMenuElement}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <button
          type="button"
          onClick={onCreate}
          aria-label={t("sidekick.newThread")}
          title={t("sidekick.newThread")}
          data-sidekick-interaction="true"
          style={{
            ...sidekickHeaderButtonStyle,
            border: "1px solid var(--border)",
            borderRadius: 5,
            background: "var(--bg)",
            transition: "color 0.12s, border-color 0.12s, background-color 0.12s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--text)";
            e.currentTarget.style.borderColor = "var(--accent)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--text-muted)";
            e.currentTarget.style.borderColor = "var(--border)";
          }}
        >
          <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
        {canFork && (
          <button
            type="button"
            onClick={onFork}
            disabled={isForking}
            aria-label={t("sidekick.fork")}
            title={t("sidekick.forkThreadTitle")}
            data-sidekick-interaction="true"
            style={{
              ...sidekickHeaderButtonStyle,
              cursor: isForking ? "not-allowed" : "pointer",
              opacity: isForking ? 0.5 : 1,
            }}
            onMouseEnter={(e) => { if (!isForking) e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            <GitBranch size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
        {!rightPanel && (
          <button
            type="button"
            onClick={onExpand}
            aria-expanded={expanded}
            aria-label={expanded ? t("sidekick.restoreSidebar") : t("sidekick.openCentered")}
            title={expanded ? t("sidekick.restoreSidebar") : t("sidekick.openCentered")}
            data-sidekick-interaction="true"
            style={sidekickHeaderButtonStyle}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {expanded ? <Minimize2 size={14} strokeWidth={1.8} aria-hidden="true" /> : <Maximize2 size={14} strokeWidth={1.8} aria-hidden="true" />}
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t("sidekick.close")}
            title={t("sidekick.close")}
            data-sidekick-interaction="true"
            style={sidekickHeaderButtonStyle}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            <X size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

interface Props {
  sessionId: string;
  open: boolean;
  /** Changes when the host rearranged stored questions (a branch moved to the main line); the history is read again. */
  historyRevision?: number;
  onClose: () => void;
  onQuoteToComposer?: (text: string) => void;
  mainBusy?: boolean;
  activeBranchId?: string;
  activeParentId?: string | null;
  remotePeer?: string | null;
  onSessionForked?: (result: SessionForkResult) => void;
  onCountChange?: (count: number) => void;
  /** Render the same side-question state inside the shell's resizable right panel. */
  placement?: "sidebar" | "right-panel";
  rightPanelTargetId?: string;
  modelList?: { id: string; name: string; provider: string }[];
  modelNames?: Record<string, string>;
  defaultModel?: { provider: string; modelId: string } | null;
  modelThinkingLevels?: Record<string, string[]>;
  modelThinkingLevelMaps?: Record<string, Record<string, string | null>>;
  defaultThinkingLevel?: string | null;
}

export function SidekickDrawer({
  sessionId,
  open,
  historyRevision = 0,
  onClose,
  onQuoteToComposer,
  mainBusy = false,
  activeBranchId = "main",
  activeParentId,
  remotePeer,
  onSessionForked,
  onCountChange,
  placement = "sidebar",
  rightPanelTargetId = SIDEKICK_RIGHT_PANEL_TARGET_ID,
  modelList,
  modelNames,
  defaultModel,
  modelThinkingLevels,
  modelThinkingLevelMaps,
  defaultThinkingLevel,
}: Props) {
  const router = useRouter();
  const quickAskUrl = remotePeer
    ? `/api/remote/sessions/${encodeURIComponent(sessionId)}/quick-ask?peer=${encodeURIComponent(remotePeer)}`
    : `/api/sessions/${encodeURIComponent(sessionId)}/quick-ask`;
  const [items, setItems] = useState<QuickAskEntry[]>([]);
  const [loading, setLoading] = useState(false);

  // Drafts and in-flight replies belong to an exact peer/session/branch/thread.
  const [threadLists, setThreadLists] = useState<Record<string, string[]>>({});
  const [promotedBranches, setPromotedBranches] = useState<string[]>([]);
  const [recoveryBranch, setRecoveryBranch] = useState<string | null>(null);
  const sideAskBranchId = activeBranchId === "main" && recoveryBranch ? recoveryBranch : activeBranchId;
  const listKey = sidekickViewKey(quickAskUrl, sideAskBranchId || "main", "");
  const threadList = threadLists[listKey] ?? ["default"];
  const setThreadList = useCallback((value: React.SetStateAction<string[]>) => {
    setThreadLists((previous) => ({ ...previous, [listKey]: typeof value === "function" ? value(previous[listKey] ?? ["default"]) : value }));
  }, [listKey]);
  const [activeThreads, setActiveThreads] = useState<Record<string, string>>({});
  const activeThreadId = resolveSidekickActiveThread(activeThreads[listKey], threadList);
  const setActiveThreadId = useCallback((value: string) => setActiveThreads((previous) => ({ ...previous, [listKey]: value })), [listKey]);
  const viewKey = sidekickViewKey(quickAskUrl, sideAskBranchId || "main", activeThreadId);
  const [viewState, setViewState] = useState<SidekickViewState>({ drafts: {}, replies: {} });
  const { drafts, replies } = viewState;
  const setDrafts = useCallback((update: React.SetStateAction<SidekickViewState["drafts"]>) => {
    setViewState((previous) => ({ ...previous, drafts: typeof update === "function" ? update(previous.drafts) : update }));
  }, []);
  const setReplies = useCallback((update: React.SetStateAction<SidekickViewState["replies"]>) => {
    setViewState((previous) => ({ ...previous, replies: typeof update === "function" ? update(previous.replies) : update }));
  }, []);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const question = drafts[viewKey]?.question ?? "";
  const attachedImages = drafts[viewKey]?.images ?? [];
  const setQuestion = useCallback((value: React.SetStateAction<string>) => {
    setDrafts((previous) => {
      const draft = previous[viewKey] ?? { question: "", images: [], error: null };
      return { ...previous, [viewKey]: { ...draft, question: typeof value === "function" ? value(draft.question) : value } };
    });
  }, [setDrafts, viewKey]);
  const setAttachedImages = useCallback((value: React.SetStateAction<SidekickImage[]>) => {
    setDrafts((previous) => {
      const draft = previous[viewKey] ?? { question: "", images: [], error: null };
      return { ...previous, [viewKey]: { ...draft, images: typeof value === "function" ? value(draft.images) : value } };
    });
  }, [setDrafts, viewKey]);
  const attachmentError = drafts[viewKey]?.error ?? null;
  const setAttachmentError = useCallback((error: string | null) => {
    setDrafts((previous) => ({ ...previous, [viewKey]: { ...(previous[viewKey] ?? { question: "", images: [], error: null }), error } }));
  }, [setDrafts, viewKey]);
  const [processingImages, setProcessingImages] = useState<Record<string, number>>({});
  const isProcessingImages = (processingImages[viewKey] ?? 0) > 0;
  const reply = replies[viewKey];
  const isStreaming = reply?.running ?? false;
  const isDeletingThread = reply?.deleting ?? false;
  const streamingQuestion = reply?.question ?? "";
  const streamingImages = reply?.images ?? [];
  const streamingAnswer = reply?.answer ?? "";
  const streamingThinking = reply?.thinking ?? "";
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [isForking, setIsForking] = useState(false);
  const forkRequestRef = useRef<AbortController | null>(null);
  const [expanded, setExpanded] = useState(false);
  const isRightPanelPlacement = placement === "right-panel";
  const isSidebarPlacement = placement === "sidebar";
  const shouldPortalToTopbar = isSidebarPlacement && !expanded;
  const [topbarTarget, setTopbarTarget] = useState<HTMLElement | null>(null);

  const { t } = useI18n();
  const [selectedModel, setSelectedModel] = useState<{ provider: string; modelId: string } | null>(null);
  const storedModel = [...items].reverse().find((item) => (item.data.threadId ?? item.threadId ?? "default") === activeThreadId
    && (item.data.branchId ?? item.branchId ?? "main") === (sideAskBranchId || "main"));
  const threadModel = storedModel?.requestedModel ?? (storedModel?.data.provider && storedModel.data.model
    ? { provider: storedModel.data.provider, modelId: storedModel.data.model } : null);
  const requestedModel = selectedModel ?? threadModel ?? defaultModel;
  const activeModel = requestedModel ?? (modelList?.[0] ? { provider: modelList[0].provider, modelId: modelList[0].id } : null);
  const [thinkingLevelOverride, setThinkingLevelOverride] = useState<string | null>(null);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const [modelFilter, setModelFilter] = useState("");
  const hiddenModelProviders = useHiddenModelProviders();

  const [modelMenuPos, setModelMenuPos] = useState<{ bottom: number; left: number } | null>(null);
  const [thinkingMenuPos, setThinkingMenuPos] = useState<{ bottom: number; left: number } | null>(null);
  const modelSelectorRef = useRef<HTMLDivElement>(null);
  const thinkingSelectorRef = useRef<HTMLDivElement>(null);
  const modelDropdownPanelRef = useRef<HTMLDivElement>(null);
  const thinkingDropdownPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!modelDropdownOpen && !thinkingDropdownOpen) return;
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        modelSelectorRef.current && !modelSelectorRef.current.contains(target) &&
        (!modelDropdownPanelRef.current || !modelDropdownPanelRef.current.contains(target))
      ) {
        setModelDropdownOpen(false);
        setModelFilter("");
      }
      if (
        thinkingSelectorRef.current && !thinkingSelectorRef.current.contains(target) &&
        (!thinkingDropdownPanelRef.current || !thinkingDropdownPanelRef.current.contains(target))
      ) {
        setThinkingDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [modelDropdownOpen, thinkingDropdownOpen]);

  const modelOptions = useMemo(() => {
    if (modelList && modelList.length > 0) {
      return modelList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name })).sort(compareSidekickModelOptions);
    }
    return Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
      provider: activeModel?.provider ?? "unknown",
      modelId,
      name,
    })).sort(compareSidekickModelOptions);
  }, [modelList, modelNames, activeModel?.provider]);

  const visibleModelOptions = useMemo(() => {
    return filterSidekickModelOptionsByProvider(modelOptions, hiddenModelProviders, activeModel);
  }, [activeModel, hiddenModelProviders, modelOptions]);

  const filteredModelOptions = useMemo(() => {
    return filterSidekickModelOptions(visibleModelOptions, modelFilter);
  }, [visibleModelOptions, modelFilter]);

  const showModelFilter = visibleModelOptions.length > 8;

  const modelsByProvider = useMemo(() => {
    const list: { provider: string; options: typeof filteredModelOptions }[] = [];
    for (const opt of filteredModelOptions) {
      const group = list.find((g) => g.provider === opt.provider);
      if (group) group.options.push(opt);
      else list.push({ provider: opt.provider, options: [opt] });
    }
    return list;
  }, [filteredModelOptions]);

  const displayModelName = activeModel
    ? (modelOptions.find((o) => o.modelId === activeModel.modelId && o.provider === activeModel.provider)?.name ?? modelNames?.[activeModel.modelId] ?? activeModel.modelId)
    : t("sidekick.selectModel");

  const availableThinkingLevelsList = useMemo(
    () => getSidekickThinkingLevels(activeModel, modelThinkingLevels),
    [activeModel, modelThinkingLevels],
  );

  const selectedThinkingLevel = useMemo(
    () => resolveSidekickThinkingLevel(thinkingLevelOverride, availableThinkingLevelsList, defaultThinkingLevel ?? "auto"),
    [availableThinkingLevelsList, defaultThinkingLevel, thinkingLevelOverride],
  );

  useEffect(() => {
    if (!open || !shouldPortalToTopbar || typeof document === "undefined") {
      setTopbarTarget(null);
      return;
    }
    const target = document.getElementById(SIDEKICK_TOPBAR_PORTAL_ID);
    if (target) {
      setTopbarTarget(target);
      return;
    }
    const frame = requestAnimationFrame(() => {
      const delayed = document.getElementById(SIDEKICK_TOPBAR_PORTAL_ID);
      if (delayed) setTopbarTarget(delayed);
    });
    return () => cancelAnimationFrame(frame);
  }, [open, shouldPortalToTopbar]);

  const streamRequestsRef = useRef(new Map<string, SidekickStreamRequest>());
  const observeRunRef = useRef<(run: QuickAskRunSnapshot) => void>(() => {});
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const questionCompositionActiveRef = useRef(false);
  const questionCompositionEndAtRef = useRef(0);
  const drawerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingImageCountRef = useRef(new Map<string, { count: number }>());
  const sessionIdentityRef = useRef({ sessionId, quickAskUrl });
  if (sessionIdentityRef.current.sessionId !== sessionId || sessionIdentityRef.current.quickAskUrl !== quickAskUrl) sessionIdentityRef.current = { sessionId, quickAskUrl };
  const historyRequestRef = useRef<HistoryRequestState>({
    requestId: 0,
    sessionId: "",
    quickAskUrl: "",
    promise: null,
    loaded: false,
  });
  const historyControllerRef = useRef<ReturnType<typeof createSidekickHistoryController> | null>(null);
  if (!historyControllerRef.current) {
    historyControllerRef.current = createSidekickHistoryController({
      historyRequestRef,
      onItems: (nextItems) => {
        const identity = sessionIdentityRef.current;
        const url = historyRequestRef.current.quickAskUrl;
        setItems((previous) => sessionIdentityRef.current === identity ? nextItems : previous);
        setThreadLists((previous) => {
          if (sessionIdentityRef.current !== identity) return previous;
          return mergeSidekickThreadLists(previous, url, nextItems);
        });
      },
      onRuns: (runs) => { for (const run of runs) observeRunRef.current(run); },
      onPromotedBranches: setPromotedBranches,
      onLoading: setLoading,
    });
  }
  const historyController = historyControllerRef.current;
  historyController.syncIdentity(sessionId, quickAskUrl);

  const recoveryBranches = useMemo(() => {
    const branches = new Set(promotedBranches.filter((branch) => items.some((item) => (item.data.branchId ?? item.branchId) === branch)));
    if (recoveryBranch) branches.add(recoveryBranch);
    for (const key of [...Object.keys(drafts), ...Object.keys(replies), ...Object.keys(processingImages)]) {
      try {
        const [url, branch] = JSON.parse(key) as [string, string, string];
        const draft = drafts[key];
        if (url === quickAskUrl && branch && branch !== "main"
          && (replies[key] || draft?.question.trim() || draft?.images.length || draft?.error || (processingImages[key] ?? 0) > 0)) branches.add(branch);
      } catch { /* Ignore state from an unknown key format. */ }
    }
    return [...branches];
  }, [drafts, items, processingImages, promotedBranches, quickAskUrl, recoveryBranch, replies]);

  useLayoutEffect(() => {
    for (const [key, request] of streamRequestsRef.current) {
      if (request.retained && !request.running && !replies[key]) {
        request.retained = false;
        if (!request.observing) streamRequestsRef.current.delete(key);
      }
    }
  }, [replies]);

  // An unknown admission offers the same request again; a run the host already admitted is only looked up.
  const unconfirmedRequest = reply?.unconfirmed ? streamRequestsRef.current.get(viewKey) : undefined;
  const restoreActionLabel = !reply?.unconfirmed ? t("sidekick.restoreQuestion")
    : unconfirmedRequest?.resend && !unconfirmedRequest.accepted ? t("sidekick.retrySend") : t("sidekick.recheckStatus");

  const processImageFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    const identity = sessionIdentityRef.current;
    const key = viewKey;
    const remaining = Math.max(
      0,
      MAX_ATTACHED_IMAGES - attachedImages.length - (pendingImageCountRef.current.get(key)?.count ?? 0),
    );
    const invalidFile = files.some((file) => (
      !file.type.startsWith("image/") || file.size > MAX_ATTACHED_IMAGE_BYTES
    ));
    const imageFiles = files
      .filter((file) => file.type.startsWith("image/") && file.size <= MAX_ATTACHED_IMAGE_BYTES)
      .slice(0, remaining);

    if (!imageFiles.length) {
      setAttachmentError(
        invalidFile
          ? t("sidekick.imageTooLarge", { size: MAX_ATTACHED_IMAGE_BYTES / (1024 * 1024) })
          : t("sidekick.tooManyImages", { count: MAX_ATTACHED_IMAGES }),
      );
      return;
    }

    if (invalidFile || files.length > imageFiles.length) {
      setAttachmentError(
        invalidFile
          ? t("sidekick.imageTooLarge", { size: MAX_ATTACHED_IMAGE_BYTES / (1024 * 1024) })
          : t("sidekick.tooManyImages", { count: MAX_ATTACHED_IMAGES }),
      );
    } else {
      setAttachmentError(null);
    }

    const imageWindow = pendingImageCountRef.current.get(key) ?? { count: 0 };
    pendingImageCountRef.current.set(key, imageWindow);
    imageWindow.count += imageFiles.length;
    const current = () => sessionIdentityRef.current === identity && pendingImageCountRef.current.get(key) === imageWindow;
    const pendingCount = imageWindow.count;
    setProcessingImages((previous) => current() ? { ...previous, [key]: pendingCount } : previous);
    try {
      const newImages = await Promise.all(
        imageFiles.map(async (file) => {
          const image = await compressImageFile(file);
          if (!isBase64ImageWithinLimits(image)) throw new Error("image exceeds limit");
          return { ...image, previewUrl: imageDataUrl(image) };
        }),
      );
      if (!current()) return;
      setAttachedImages((previous) => {
        const accepted = newImages.slice(0, Math.max(0, MAX_ATTACHED_IMAGES - previous.length));
        const next = [...previous, ...accepted];
        return next;
      });
    } catch {
      if (current()) setAttachmentError(t("sidekick.imageReadFailed"));
    } finally {
      if (current()) {
        imageWindow.count = Math.max(0, imageWindow.count - imageFiles.length);
        const pending = imageWindow.count;
        setProcessingImages((previous) => current() ? { ...previous, [key]: pending } : previous);
      }
    }
  }, [attachedImages.length, setAttachedImages, setAttachmentError, t, viewKey]);

  const removeImage = useCallback((index: number) => {
    setAttachedImages((previous) => {
      const next = previous.filter((_, imageIndex) => imageIndex !== index);
      return next;
    });
  }, [setAttachedImages]);

  const handlePaste = useCallback((event: React.ClipboardEvent) => {
    const imageItems = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.type.startsWith("image/"));
    if (!imageItems.length) return;
    event.preventDefault();
    const files = imageItems
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    processImageFiles(files);
  }, [processImageFiles]);

  const resizeQuestion = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const drawerHeight = drawerRef.current?.clientHeight ?? window.innerHeight;
    const maxHeight = Math.max(
      88,
      Math.min(
        Math.floor(window.innerHeight * 0.5),
        Math.floor(drawerHeight * 0.4),
      ),
    );
    textarea.style.height = "auto";
    const nextHeight = Math.max(56, Math.min(textarea.scrollHeight, maxHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, []);

  useLayoutEffect(() => {
    resizeQuestion();
  }, [expanded, question, resizeQuestion]);

  const restoreQuestionView = useCallback(() => {
    requestAnimationFrame(() => {
      resizeQuestion();
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      const len = textarea.value.length;
      textarea.setSelectionRange(len, len);
      textarea.scrollTop = textarea.scrollHeight;
    });
  }, [resizeQuestion]);

  useEffect(() => {
    const handleResize = () => resizeQuestion();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [resizeQuestion]);

  useEffect(() => {
    if (!open) setExpanded(false);
  }, [open]);

  useEffect(() => {
    if (isRightPanelPlacement) setExpanded(false);
  }, [isRightPanelPlacement]);

  useEffect(() => {
    // The session overlay is dismissible by clicking outside. The right-panel
    // view is a docked tool and must stay mounted until its own tab is toggled.
    if (!open || isRightPanelPlacement) return;
    const ownerDocument = expanded ? sidekickPortalDocument() ?? document : document;
    const handleOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target && typeof (target as Element).closest === "function" && (target as Element).closest("[data-sidekick-interaction]")) return;
      if (target && typeof (target as Node).nodeType === "number" && drawerRef.current?.contains(target as Node)) return;
      onClose();
    };
    ownerDocument.addEventListener("pointerdown", handleOutsidePointerDown);
    return () => ownerDocument.removeEventListener("pointerdown", handleOutsidePointerDown);
  }, [expanded, isRightPanelPlacement, onClose, open]);

  useEffect(() => {
    if (!open || isRightPanelPlacement || typeof window === "undefined" || window.parent === window) return;
    const handleEmbeddedParentDismiss = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data as { type?: unknown } | null;
      if (data?.type !== EMBEDDED_SIDEKICK_DISMISS_EVENT) return;
      onClose();
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
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setExpanded(false);
    };
    ownerWindow.addEventListener("keydown", handleKeyDown);
    return () => ownerWindow.removeEventListener("keydown", handleKeyDown);
  }, [expanded, open]);

  useEffect(() => {
    const handleSidekickQuote = (e: Event) => {
      const custom = e as CustomEvent<{ text: string }>;
      if (custom.detail?.text) {
        const quoteText = custom.detail.text;
        setQuestion((prev) => (prev ? `${prev}\n\n${quoteText}` : quoteText));
        restoreQuestionView();
      }
    };
    window.addEventListener("pi-sidekick-quote", handleSidekickQuote);
    return () => window.removeEventListener("pi-sidekick-quote", handleSidekickQuote);
  }, [restoreQuestionView, setQuestion]);

  // Load durable history as soon as the session/URL identity is known. Opening reuses an in-flight request.
  const loadHistory = useCallback(
    () => historyController.load(sessionId, quickAskUrl),
    [historyController, quickAskUrl, sessionId],
  );
  const deleteHistory = useCallback(
    (
      body: SidekickHistoryDeleteBody,
      onOptimistic: () => void,
    ) => historyController.deleteWithRecovery(sessionId, quickAskUrl, body, onOptimistic),
    [historyController, quickAskUrl, sessionId],
  );

  useEffect(() => {
    forkRequestRef.current?.abort();
    forkRequestRef.current = null;
    setIsForking(false);
    for (const request of streamRequestsRef.current.values()) request.controller.abort();
    streamRequestsRef.current.clear();
    setReplies({});
    setDrafts({});
    setProcessingImages({});
    pendingImageCountRef.current.clear();
    setItems([]);
    setThreadLists({});
    setPromotedBranches([]);
    setRecoveryBranch(null);
    setActiveThreads({});
    if (!sessionId) {
      setLoading(false);
      return;
    }
    void loadHistory();
  }, [loadHistory, quickAskUrl, sessionId]);

  useEffect(() => {
    if (!open) return;
    void loadHistory();
    restoreQuestionView();
  }, [loadHistory, open, restoreQuestionView]);

  const seenHistoryRevisionRef = useRef(historyRevision);
  useEffect(() => {
    if (seenHistoryRevisionRef.current === historyRevision) return;
    seenHistoryRevisionRef.current = historyRevision;
    historyController.invalidate(sessionId, quickAskUrl);
    void historyController.load(sessionId, quickAskUrl);
  }, [historyController, historyRevision, quickAskUrl, sessionId]);

  const scrollToBottom = useCallback(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, []);

  
  // Filter items strictly belonging to current branch (or main)
  const branchItems = useMemo(() => {
    const target = sideAskBranchId || "main";
    return items.filter((i) => (i.data.branchId || i.branchId || "main") === target);
  }, [items, sideAskBranchId]);

  // Compute thread objects: labelled purely as 1, 2, 3...
  const threads = useMemo(() => {
    return threadList.map((tid, index) => {
      const threadItems = branchItems.filter((i) => (i.data.threadId || i.threadId || "default") === tid);
      return {
        id: tid,
        label: `${index + 1}`,
        count: threadItems.length,
      };
    });
  }, [threadList, branchItems]);

  const activeThreadIndex = useMemo(() => {
    const idx = threadList.indexOf(activeThreadId);
    return idx >= 0 ? idx : 0;
  }, [threadList, activeThreadId]);

  const currentThreadItems = useMemo(() => {
    return branchItems.filter((i) => (i.data.threadId || i.threadId || "default") === activeThreadId);
  }, [branchItems, activeThreadId]);

  // Show the number of topic tabs only after this branch has real side-question content.
  const hasSidekickContent = branchItems.length > 0 || threadList.some((tid) => {
    const liveReply = replies[sidekickViewKey(quickAskUrl, sideAskBranchId || "main", tid)];
    return Boolean(liveReply?.question.trim() || liveReply?.images.length);
  });
  const sidekickTagCount = hasSidekickContent ? threadList.length : 0;

  useEffect(() => {
    onCountChange?.(sidekickTagCount);
  }, [listKey, onCountChange, sidekickTagCount]);

  useEffect(() => {
    scrollToBottom();
  }, [currentThreadItems, reply?.runId, streamingAnswer, scrollToBottom]);

  // Create new thread tab
  const handleCreateNewThread = () => {
    const newId = `th-${crypto.randomUUID()}`;
    setThreadList((prev) => [...prev, newId]);
    setActiveThreadId(newId);
    setTimeout(() => textareaRef.current?.focus(), 100);
  };

  // Close a tab without changing the durable Side Ask history.
  const handleCloseThread = (e: React.MouseEvent, tid: string) => {
    e.stopPropagation();
    setThreadList((previous) => {
      const remaining = previous.filter((id) => id !== tid);
      return remaining.length > 0 ? remaining : ["default"];
    });
    if (activeThreadId === tid) {
      const remaining = threadList.filter((id) => id !== tid);
      setActiveThreadId(remaining.length > 0 ? remaining[0] : "default");
    }
  };

  // Permanently delete a thread and its durable Side Ask history.
  const handleDeleteThread = (e: React.MouseEvent, tid: string) => {
    e.stopPropagation();
    const deletionKey = sidekickViewKey(quickAskUrl, sideAskBranchId || "main", tid);
    if (streamRequestsRef.current.get(deletionKey)?.deleting) return;
    const thread = threads.find((t) => t.id === tid);
    if (thread && thread.count > 0) {
      const confirmed = window.confirm(t("sidekick.deleteThreadConfirm", { label: thread.label }));
      if (!confirmed) return;
    }

    const branchId = sideAskBranchId || "main";
    const key = sidekickViewKey(quickAskUrl, branchId, tid);
    const identity = sessionIdentityRef.current;
    const draft = draftsRef.current[key];
    const requestId = streamRequestsRef.current.get(key)?.runId;
    const owner = streamRequestsRef.current.get(key) ?? { controller: new AbortController(), running: false, deleting: false };
    owner.deleting = true;
    streamRequestsRef.current.set(key, owner);
    setReplies((previous) => ({ ...previous, [key]: { ...(previous[key] ?? { question: "", images: [], answer: "", thinking: "", running: false }), deleting: true } }));
    // The host deletion owns cancellation, including an admission still in flight.
    void deleteHistory({ threadId: tid, branchId, ...(requestId ? { requestId } : {}) }, () => owner?.controller.abort()).then((success) => {
      if (sessionIdentityRef.current !== identity) return;
      if (!success) {
        if (streamRequestsRef.current.get(key) === owner) owner.deleting = false;
        setReplies((previous) => previous[key] ? { ...previous, [key]: { ...previous[key], deleting: false } } : previous);
        setAttachmentError(t("sidekick.deleteIncomplete")); return;
      }
      const sameOwner = () => streamRequestsRef.current.get(key) === owner;
      const sameDraft = () => draftsRef.current[key] === draft;
      const removeTab = sameOwner() && sameDraft();
      if (sameOwner()) {
        streamRequestsRef.current.delete(key);
        setReplies((previous) => {
          if (streamRequestsRef.current.has(key)) return previous;
          const next = { ...previous }; delete next[key]; return next;
        });
      }
      if (sameDraft()) {
        pendingImageCountRef.current.delete(key);
        setProcessingImages((previous) => { const next = { ...previous }; delete next[key]; return next; });
        setDrafts((previous) => { if (previous[key] !== draft) return previous; const next = { ...previous }; delete next[key]; return next; });
      }
      setItems((previous) => previous.filter((item) => (item.data.branchId || item.branchId || "main") !== branchId || (item.data.threadId || item.threadId || "default") !== tid));
      if (removeTab) {
        setThreadList((previous) => { const remaining = previous.filter((id) => id !== tid); return remaining.length > 0 ? remaining : ["default"]; });
        if (activeThreadId === tid) {
          const remaining = threadList.filter((id) => id !== tid);
          setActiveThreadId(remaining.length > 0 ? remaining[0] : "default");
        }
      } else setAttachmentError(t("sidekick.deletedKeptNew"));
    });
  };

  useEffect(() => () => {
    forkRequestRef.current?.abort();
    for (const request of streamRequestsRef.current.values()) request.controller.abort();
    streamRequestsRef.current.clear();
  }, []);

  const restoreDraft = (key: string, source: Pick<SidekickLiveReply, "runId" | "question" | "images">, reason?: string) => {
    const identity = sessionIdentityRef.current;
    const processing = (pendingImageCountRef.current.get(key)?.count ?? 0) > 0;
    setViewState((previous) => sessionIdentityRef.current !== identity ? previous
      : restoreSidekickDraft(previous, key, source, processing || (pendingImageCountRef.current.get(key)?.count ?? 0) > 0, t, reason));
  };

  const forgetDeletedRun = (key: string, runId: string, identity: typeof sessionIdentityRef.current, controller: AbortController) => {
    if (sessionIdentityRef.current !== identity || streamRequestsRef.current.get(key)?.controller !== controller
      || streamRequestsRef.current.get(key)?.runId !== runId) return;
    streamRequestsRef.current.delete(key);
    controller.abort();
    setReplies((previous) => {
      if (sessionIdentityRef.current !== identity || previous[key]?.runId !== runId) return previous;
      const next = { ...previous }; delete next[key]; return next;
    });
    historyController.invalidate(identity.sessionId, identity.quickAskUrl);
    void historyController.load(identity.sessionId, identity.quickAskUrl);
  };

  const recoverRun = async (key: string, runId: string, url: string, scope: QuickAskScope, identity: typeof sessionIdentityRef.current) => {
    const request = streamRequestsRef.current.get(key);
    if (!request || request.runId !== runId) return;
    const current = () => sessionIdentityRef.current === identity && streamRequestsRef.current.get(key) === request;
    let run = await readQuickAskRun({ url, run: { id: runId, ...scope }, signal: request.controller.signal, t, fetcher: fetch });
    if (!current()) return;
    if (run === null) { forgetDeletedRun(key, runId, identity, request.controller); return; }
    if (request.stopRequested) {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", runId }) });
      const data = await response.json() as { run?: QuickAskRunSnapshot; error?: string };
      if (!response.ok || !data.run || data.run.id !== runId || data.run.threadId !== scope.threadId || data.run.branchId !== scope.branchId) {
        throw new Error(data.error === undefined ? t("sidekick.stopUnconfirmed") : localizeQuickAskError(data.error, t));
      }
      run = data.run;
    }
    if (current()) observeRunRef.current(run);
  };

  observeRunRef.current = (initial) => {
    const identity = sessionIdentityRef.current;
    const url = identity.quickAskUrl;
    const key = sidekickViewKey(url, initial.branchId, initial.threadId);
    const existing = streamRequestsRef.current.get(key);
    if (existing?.deleting || ((existing?.running || existing?.retained) && existing.runId && existing.runId !== initial.id)) return;
    if (existing?.observing && existing.runId === initial.id && isQuickAskRunActive(initial)) return;
    const controller = existing?.runId === initial.id && !existing.controller.signal.aborted ? existing.controller : new AbortController();
    if (existing && existing.controller !== controller) existing.controller.abort();
    const request = { controller, running: isQuickAskRunActive(initial), runId: initial.id, observing: true, accepted: true, retained: initial.status !== "completed" };
    streamRequestsRef.current.set(key, request);
    const current = () => sessionIdentityRef.current === identity && streamRequestsRef.current.get(key)?.controller === controller;
    setThreadLists((previous) => {
      if (!current()) return previous;
      const list = sidekickViewKey(url, initial.branchId, "");
      return { ...previous, [list]: Array.from(new Set([...(previous[list] ?? ["default"]), initial.threadId])) };
    });
    observeQuickAskRun({ url, run: initial, signal: controller.signal, t,
      onRun: (run) => {
        if (!current()) return;
        request.running = isQuickAskRunActive(run);
        request.retained = run.status !== "completed";
        if (run.status === "completed" && run.entry) {
          const entry = run.entry;
          historyController.invalidate(identity.sessionId, url);
          setItems((previous) => current() && !previous.some((item) => item.id === entry.id) ? [...previous, entry] : previous);
          setReplies((previous) => {
            if (!current()) return previous;
            const next = { ...previous }; delete next[key]; return next;
          });
        } else {
          setReplies((previous) => {
            if (!current()) return previous;
            const images = previous[key]?.runId === run.id ? previous[key].images
              : run.images.map((image) => ({ ...image, previewUrl: imageDataUrl(image) }));
            return { ...previous, [key]: { runId: run.id, question: run.question, images,
              answer: run.answer + (isQuickAskRunActive(run) ? "" : `\n\n[${run.error === undefined ? t("sidekick.stopped") : localizeQuickAskError(run.error, t)}]`),
              thinking: run.thinking, running: isQuickAskRunActive(run), settling: run.settling, activeTools: run.activeTools } };
          });
        }
        if (!isQuickAskRunActive(run)) { request.observing = false; controller.abort(); }
      },
      onDeleted: () => forgetDeletedRun(key, initial.id, identity, controller),
      onError: (error) => {
        if (!current()) return;
        request.running = false;
        request.observing = false;
        request.retained = true;
        setReplies((previous) => current() && previous[key] ? { ...previous, [key]: { ...previous[key], running: false, unconfirmed: true } } : previous);
        historyController.invalidate(identity.sessionId, url);
        setDrafts((previous) => ({ ...previous, [key]: { ...(previous[key] ?? { question: "", images: [] }), error: error.message } }));
      },
    });
  };

  const handleSend = async () => {
    const q = question.trim();
    const submittedImages = attachedImages;
    const key = viewKey;
    if ((!q && !submittedImages.length) || isForking || streamRequestsRef.current.get(key)?.running
      || streamRequestsRef.current.get(key)?.deleting || isProcessingImages || !sessionId) return;
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    const request: SidekickStreamRequest = { controller, running: true, runId: requestId, accepted: false, stopRequested: false, retained: true };
    streamRequestsRef.current.set(key, request);
    const identity = sessionIdentityRef.current;
    const requestUrl = quickAskUrl;
    const current = () => sessionIdentityRef.current === identity && streamRequestsRef.current.get(key)?.controller === controller;
    // One admission attempt. The host treats the same request ID as the same turn, so a repeat can never create a second one.
    const admit = async () => {
      try {
        const response = await fetch(requestUrl, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start", requestId, question: q,
            images: submittedImages.map(({ data, mimeType }) => ({ data, mimeType })),
            threadId: activeThreadId, threadTitle: t("sidekick.threadTitle", { index: activeThreadIndex + 1 }), branchId: sideAskBranchId || "main",
            ...(activeParentId === undefined ? {} : { expectedParentId: activeParentId }),
            ...(requestedModel ? { model: requestedModel } : {}),
            ...(selectedThinkingLevel !== "auto" ? { thinkingLevel: selectedThinkingLevel } : {}),
          }),
        });
        const data = await response.json().catch(() => ({})) as { run?: QuickAskRunSnapshot; error?: string };
        if (!response.ok || !data.run) {
          const reason = data.error === undefined ? `HTTP ${response.status}` : localizeQuickAskError(data.error, t);
          // A 4xx is the host refusing before admission: give the input back instead of reporting an unknown state.
          if (response.status < 400 || response.status >= 500) throw new Error(reason);
          if (!current()) return;
          request.running = false;
          restoreDraft(key, { runId: requestId, question: q, images: submittedImages }, reason);
          return;
        }
        request.accepted = true;
        let run = data.run;
        if (request.stopRequested) {
          const stopped = await fetch(requestUrl, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "stop", runId: run.id }) });
          const result = await stopped.json() as { run?: QuickAskRunSnapshot; error?: string };
          if (!stopped.ok || !result.run) throw new Error(result.error === undefined ? t("sidekick.stopFailed") : localizeQuickAskError(result.error, t));
          run = result.run;
        }
        if (current()) observeRunRef.current(run);
      } catch (error) {
        if (!current()) return;
        // A lost admission response does not prove that the host rejected the turn.
        // Look the request ID up first; if it is still unknown the reply offers to send the same request again.
        try {
          await recoverRun(key, requestId, requestUrl, { threadId: activeThreadId, branchId: sideAskBranchId || "main" }, identity);
          return;
        } catch { /* The original identity stays recoverable while the host is unavailable. */ }
        if (!current()) return;
        request.running = false;
        setReplies((previous) => current() && previous[key] ? { ...previous, [key]: {
          ...previous[key], running: false, unconfirmed: true,
          answer: previous[key].answer + `\n\n[${t("sidekick.statusUnconfirmed", { error: String(error) })}]`,
        } } : previous);
        historyController.invalidate(identity.sessionId, requestUrl);
      }
    };
    request.resend = admit;
    setQuestion(""); setAttachedImages([]); setAttachmentError(null);
    setReplies((previous) => ({ ...previous, [key]: { runId: requestId, question: q, images: submittedImages,
      answer: "", thinking: "", running: true } }));
    await admit();
  };

  const handleAbort = async () => {
    const request = streamRequestsRef.current.get(viewKey);
    if (!request?.runId) return;
    if (!request.accepted) { request.stopRequested = true; return; }
    const identity = sessionIdentityRef.current;
    try {
      const response = await fetch(quickAskUrl, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", runId: request.runId }) });
      const data = await response.json() as { run?: QuickAskRunSnapshot; error?: string };
      if (!response.ok || !data.run) throw new Error(data.error === undefined ? t("sidekick.stopFailed") : localizeQuickAskError(data.error, t));
      if (sessionIdentityRef.current === identity) observeRunRef.current(data.run);
    } catch (error) { if (sessionIdentityRef.current === identity) setAttachmentError(String(error)); }
  };

  const handleRestoreQuestion = async () => {
    if (!reply || reply.running) return;
    if (reply.unconfirmed) {
      if (!reply.runId) { setAttachmentError(t("sidekick.missingRequestIdentity")); return; }
      const request = streamRequestsRef.current.get(viewKey);
      if (request?.runId === reply.runId && request.resend && !request.accepted) {
        // Same request ID again: the host returns the turn it already admitted or admits this one, so no second turn can exist.
        request.running = true;
        setReplies((previous) => previous[viewKey]?.runId === reply.runId
          ? { ...previous, [viewKey]: { ...previous[viewKey], running: true, unconfirmed: false, answer: "" } } : previous);
        setAttachmentError(null);
        await request.resend();
        return;
      }
      const identity = sessionIdentityRef.current;
      setAttachmentError(t("sidekick.checkingAcceptance"));
      try {
        await recoverRun(viewKey, reply.runId, identity.quickAskUrl, { threadId: activeThreadId, branchId: sideAskBranchId || "main" }, identity);
      } catch (error) {
        if (sessionIdentityRef.current === identity && streamRequestsRef.current.get(viewKey)?.runId === reply.runId) {
          setAttachmentError(t("sidekick.acceptanceUnconfirmed", { error: String(error) }));
        }
      }
      return;
    }
    const draft = draftsRef.current[viewKey];
    if (draft?.question.trim() || draft?.images.length || isProcessingImages || pendingImageCountRef.current.get(viewKey)?.count) {
      setAttachmentError(t("sidekick.restoreDraftBusy"));
      return;
    }
    restoreDraft(viewKey, reply);
    restoreQuestionView();
  };

  const handleCopy = async (id: string, text: string) => {
    try { await copyText(text); } catch { setAttachmentError(t("sidekick.copyFailed")); return; }
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleDelete = (targetId: string) => {
    void deleteHistory({ targetId, branchId: sideAskBranchId || "main" }, () => {
      setItems((prev) => prev.filter((i) => i.id !== targetId));
    });
  };

  // Fork current thread or single item into a true independent top-level session
  const handleForkToSession = async (targetId?: string) => {
    if (isForking || !sessionId) return;
    setIsForking(true);
    const controller = new AbortController();
    forkRequestRef.current = controller;
    const identity = sessionIdentityRef.current;
    const current = () => !controller.signal.aborted && sessionIdentityRef.current === identity && forkRequestRef.current === controller;

    try {
      const data = await requestQuickAskFork({ url: quickAskUrl, signal: controller.signal, t,
        body: { threadId: targetId ? undefined : activeThreadId, targetId, branchId: sideAskBranchId || "main" },
      });
      if (!current()) return;

      // Let the shell own session selection, refresh, URL state, and embedded/remote routing.
      // This also closes the drawer through the shell before the new ChatWindow mounts.
      setIsForking(false);
      onClose();
      if (onSessionForked) {
        onSessionForked({ newSessionId: data.newSessionId, newSessionPath: data.newSessionPath, subprojectAssignmentFailed: data.subprojectAssignmentFailed });
        return;
      }

      // Compatibility fallback for standalone consumers that do not provide the shell callback.
      if (typeof window === "undefined") return;
      if (window.parent !== window) {
        window.parent.postMessage({
          type: "pi-web:session-opened",
          sessionId: data.newSessionId,
          cwd: null,
          path: null,
        }, "*");
      }
      const params = new URLSearchParams(window.location.search);
      params.set("session", data.newSessionId);
      router.replace(`${window.location.pathname}?${params.toString()}`, { scroll: false });
    } catch (err) {
      if (current()) alert(t("sidekick.forkFailed", { error: String(err) }));
    } finally {
      if (current()) { forkRequestRef.current = null; setIsForking(false); }
    }
  };

  if (!open) return null;

  const resolvedTopbarTarget = topbarTarget ?? (typeof document !== "undefined" && shouldPortalToTopbar ? document.getElementById(SIDEKICK_TOPBAR_PORTAL_ID) : null);
  const isPortaled = Boolean(shouldPortalToTopbar && resolvedTopbarTarget);

  const headerElement = (
    <SidekickHeader
      threads={threads}
      activeThreadId={activeThreadId}
      busyThreads={new Set(threads.filter((thread) => replies[sidekickViewKey(quickAskUrl, sideAskBranchId || "main", thread.id)]?.running).map((thread) => thread.id))}
      mainBusy={mainBusy}
      expanded={expanded}
      rightPanel={isRightPanelPlacement}
      canFork={currentThreadItems.length > 0 || isStreaming}
      isForking={isForking}
      isPortal={isPortaled}
      onSelect={setActiveThreadId}
      onCloseThread={handleCloseThread}
      onDelete={handleDeleteThread}
      onCreate={handleCreateNewThread}
      onFork={() => void handleForkToSession()}
      onExpand={() => setExpanded((value) => !value)}
      onClose={onClose}
    />
  );

  const drawer = (
    <div
      ref={drawerRef}
      data-sidekick-drawer="true"
      className="chat-content"
      role={expanded ? "dialog" : "complementary"}
      aria-modal={expanded ? true : undefined}
      aria-label={t("sidekick.title")}
      style={{
        ...(isRightPanelPlacement
          ? {
              position: "relative",
              width: "100%",
              height: "100%",
              minWidth: 0,
              maxWidth: "none",
              maxHeight: "none",
              border: 0,
              borderRadius: 0,
              boxShadow: "none",
              zIndex: 1,
            }
          : expanded
          ? {
              position: "relative",
              width: "min(1120px, calc(100vw - 28px))",
              height: "min(88vh, calc(100dvh - 36px))",
              maxWidth: "calc(100vw - 28px)",
              maxHeight: "calc(100dvh - 36px)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              boxShadow: "0 24px 64px rgba(0, 0, 0, 0.36)",
              zIndex: 1,
            }
          : {
              position: "absolute",
              top: 0,
              right: 0,
              bottom: 0,
              width: 410,
              maxWidth: "94vw",
              borderLeft: "1px solid var(--border)",
              boxShadow: "-4px 0 24px rgba(0,0,0,0.18)",
              zIndex: 55,
            }),
        background: "var(--bg-panel)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
        fontSize: 12,
        color: "var(--text)",
      }}
    >
      {!isPortaled && headerElement}

      {/* Messages Stream Container */}
      <div
        ref={scrollContainerRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "14px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {loading && items.length === 0 && (
          <div style={{ textAlign: "center", color: "var(--text-dim)", padding: 20 }}>
            {t("i18n.loading")}
          </div>
        )}

        {activeBranchId === "main" && recoveryBranches.length > 0 && (
          <div role="group" aria-label={t("sidekick.branchAsks")} style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <button type="button" aria-pressed={!recoveryBranch} onClick={() => setRecoveryBranch(null)}>{t("sidekick.mainAsks")}</button>
            {recoveryBranches.map((branch) => (
              <button type="button" key={branch} aria-pressed={recoveryBranch === branch}
                onClick={() => setRecoveryBranch(branch)}>{t("sidekick.branchAsk", { branch })}</button>
            ))}
          </div>
        )}

        {!loading && currentThreadItems.length === 0 && !isStreaming && (
          <div
            style={{
              padding: "16px 14px",
              background: "var(--bg-hover)",
              borderRadius: 8,
              border: "1px solid var(--border)",
              marginTop: 12,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text)", fontWeight: 600, fontSize: 13, borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
              <Sparkles size={15} style={{ color: "var(--accent)" }} aria-hidden="true" />
              <span>{t("sidekick.howItWorks")}</span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 12, lineHeight: 1.55 }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: 4, background: "rgba(59, 130, 246, 0.12)", color: "#3b82f6", flexShrink: 0, marginTop: 1 }}>
                  <GitFork size={13} strokeWidth={2} aria-hidden="true" />
                </span>
                <div>
                  <strong style={{ color: "var(--text)", display: "block", marginBottom: 2 }}>{t("sidekick.howFirstTitle")}</strong>
                  <span style={{ color: "var(--text-muted)" }}>{t("sidekick.howFirstBody")}</span>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: 4, background: "rgba(245, 158, 11, 0.12)", color: "#f59e0b", flexShrink: 0, marginTop: 1 }}>
                  <Zap size={13} strokeWidth={2} aria-hidden="true" />
                </span>
                <div>
                  <strong style={{ color: "var(--text)", display: "block", marginBottom: 2 }}>{t("sidekick.howParallelTitle")}</strong>
                  <span style={{ color: "var(--text-muted)" }}>{t("sidekick.howParallelBody")}</span>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: 4, background: "rgba(16, 185, 129, 0.12)", color: "#10b981", flexShrink: 0, marginTop: 1 }}>
                  <MessageSquare size={13} strokeWidth={2} aria-hidden="true" />
                </span>
                <div>
                  <strong style={{ color: "var(--text)", display: "block", marginBottom: 2 }}>{t("sidekick.howFollowUpTitle")}</strong>
                  <span style={{ color: "var(--text-muted)" }}>{t("sidekick.howFollowUpBody")}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Render persistent quick-ask entries for active thread */}
        {currentThreadItems.map((item) => {
          const usage = item.usage || item.data?.usage;
          const cachedTokens = Number(usage?.cacheRead ?? (usage as Record<string, unknown> | undefined)?.cachedInputTokens ?? (usage as Record<string, unknown> | undefined)?.cached_tokens ?? (usage as Record<string, unknown> | undefined)?.cached_input_tokens ?? 0);
          const inputTokens = Number(usage?.input ?? (usage as Record<string, unknown> | undefined)?.inputTokens ?? (usage as Record<string, unknown> | undefined)?.prompt_tokens ?? 0);
          const writeTokens = Number(usage?.cacheWrite ?? (usage as Record<string, unknown> | undefined)?.cacheWriteTokens ?? (usage as Record<string, unknown> | undefined)?.cache_creation_input_tokens ?? 0);
          const totalPrompt = inputTokens + cachedTokens + writeTokens;
          const cacheRate =
            cachedTokens > 0 && totalPrompt > 0
              ? (cachedTokens / totalPrompt) * 100
              : null;
          const itemImages = Array.isArray(item.data.images)
            ? item.data.images.filter(isBase64ImageWithinLimits)
            : [];

          return (
            <div key={item.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {/* Question Bubble */}
              <SidekickQuestion question={item.data.question} images={itemImages} copied={copiedId === `question:${item.id}`} onCopy={() => void handleCopy(`question:${item.id}`, item.data.question)} onQuote={onQuoteToComposer ? () => onQuoteToComposer(item.data.question) : undefined} />

              {/* Answer Card */}
              <div
                style={{
                  alignSelf: "flex-start",
                  width: "100%",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "10px 12px",
                }}
              >
                <div style={{ fontSize: "var(--chat-content-font-size, 14px)", lineHeight: 1.7 }} className="prose prose-sm dark:prose-invert max-w-none">
                  <SidekickAnswer entry={item} />
                </div>

                {/* Footer details & actions */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    borderTop: "1px solid var(--border)",
                    marginTop: 8,
                    paddingTop: 6,
                    fontSize: 11,
                    color: "var(--text-dim)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.data.model || item.model || "LLM"}</span>
                    {cacheRate !== null && (
                      <>
                        <span aria-hidden="true" style={{ color: "var(--text-dim)" }}>·</span>
                        <span style={{ color: "#10b981", fontWeight: 600, whiteSpace: "nowrap" }}>
                          CH {cacheRate.toFixed(1)}%
                        </span>
                      </>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                    <button
                      onClick={() => handleCopy(item.id, item.data.answer || item.data.thinking || t("sidekick.noAnswerBodyParenthetical"))}
                      style={{
                        ...sidekickActionButtonStyle,
                        color: copiedId === item.id ? "#10b981" : "var(--text-muted)",
                      }}
                      title={t("sidekick.copyAnswer")}
                    >
                      {copiedId === item.id ? t("i18n.copied") : t("i18n.copy")}
                    </button>
                    {onQuoteToComposer && (
                      <button
                        onClick={() =>
                          onQuoteToComposer(t("sidekick.quoteToComposerText", { question: item.data.question, answer: item.data.answer || item.data.thinking || t("sidekick.noAnswerBodyParenthetical") }))
                        }
                        style={{
                          ...sidekickActionButtonStyle,
                          color: "var(--accent)",
                        }}
                        title={t("sidekick.quoteAnswerTitle")}
                      >
                        {t("sidekick.quote")}
                      </button>
                    )}
                    <button
                      onClick={() => handleForkToSession(item.id)}
                      disabled={isForking}
                      style={{
                        ...sidekickActionButtonStyle,
                        color: "var(--accent)",
                        cursor: isForking ? "wait" : "pointer",
                      }}
                      title={t("sidekick.forkFromAnswerTitle")}
                    >
                      {t("sidekick.forkFromAnswer")}
                    </button>
                    <button
                      onClick={() => handleDelete(item.id)}
                      style={{
                        ...sidekickActionButtonStyle,
                        color: "var(--text-dim)",
                      }}
                      title={t("sidekick.deleteQuestion")}
                    >
                      {t("i18n.delete")}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {/* Live streaming bubble */}
        {(isStreaming || streamingAnswer || reply?.unconfirmed) && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {/* Optimistic Question Bubble */}
            {(streamingQuestion || streamingImages.length > 0) && <SidekickQuestion question={streamingQuestion} images={streamingImages} copied={copiedId === `question:${viewKey}`} onCopy={() => void handleCopy(`question:${viewKey}`, streamingQuestion)} onQuote={onQuoteToComposer ? () => onQuoteToComposer(streamingQuestion) : undefined} />}
            <div
              style={{
                alignSelf: "flex-start",
                width: "100%",
                background: "var(--bg)",
                border: isStreaming ? "1px solid rgba(16, 185, 129, 0.4)" : "1px solid rgba(239, 68, 68, 0.4)",
                borderRadius: 8,
                padding: "10px 12px",
              }}
            >
              {streamingThinking && (
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--text-dim)",
                    marginBottom: 6,
                    fontStyle: "italic",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  💭 {streamingThinking}
                </div>
              )}
              <div style={{ fontSize: "var(--chat-content-font-size, 14px)", lineHeight: 1.7 }}>
                <MarkdownBody>{streamingAnswer || "..."}</MarkdownBody>
              </div>
              {!isStreaming && (streamingQuestion || streamingImages.length > 0) && <button type="button" onClick={handleRestoreQuestion} style={{ border: 0, background: "none", color: "var(--accent)", padding: "4px 0", cursor: "pointer" }}>{restoreActionLabel}</button>}
              {isStreaming && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginTop: 6,
                    paddingTop: 4,
                    borderTop: "1px solid var(--border)",
                    fontSize: 10,
                    color: "#10b981",
                  }}
                >
                  <span>{reply?.settling ? t("sidekick.stopping") : reply?.activeTools?.length
                    ? t("sidekick.executingTools", { tools: reply.activeTools.join(", ") }) : t("sidekick.generating")}</span>
                  <button
                    disabled={reply?.settling}
                    onClick={handleAbort}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#ef4444",
                      cursor: reply?.settling ? "default" : "pointer",
                      opacity: reply?.settling ? 0.5 : 1,
                      fontSize: 10,
                    }}
                  >
                    {t("chat.stop")}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Drawer Input Composer */}
      <div
        style={{
          padding: "6px 8px 8px",
          background: "var(--bg)",
          display: "flex",
          flexDirection: "column",
          flex: "0 1 auto",
          minHeight: 0,
          maxHeight: isRightPanelPlacement ? "min(55%, 70dvh)" : "min(40%, 50dvh)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            flex: "1 1 auto",
            minHeight: 64,
            overflow: "hidden",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "8px 8px 6px 8px",
            position: "relative",
          }}
        >
          <textarea
            ref={textareaRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onInput={resizeQuestion}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey) return;
              handleExtensionDialogInputKeyDown(
                e.nativeEvent,
                questionCompositionActiveRef.current,
                questionCompositionEndAtRef.current,
                () => { void handleSend(); },
              );
            }}
            onCompositionStart={() => {
              questionCompositionActiveRef.current = true;
            }}
            onBlur={() => {
              questionCompositionEndAtRef.current = getExtensionDialogInputCompositionEndAtOnBlur(
                questionCompositionActiveRef.current,
                questionCompositionEndAtRef.current,
              );
              questionCompositionActiveRef.current = false;
            }}
            onCompositionEnd={() => {
              questionCompositionActiveRef.current = false;
              questionCompositionEndAtRef.current = Date.now();
            }}
            placeholder=""
            wrap="soft"
            rows={2}
            style={{
              display: "block",
              flex: "1 1 auto",
              width: "100%",
              minWidth: 0,
              maxWidth: "100%",
              background: "transparent",
              border: "none",
              outline: "none",
              resize: "none",
              boxSizing: "border-box",
              minHeight: 56,
              maxHeight: "100%",
              overflowX: "hidden",
              overflowY: "auto",
              overflowWrap: "anywhere",
              whiteSpace: "pre-wrap",
              fontSize: "var(--chat-content-font-size, 14px)",
              color: "var(--text)",
              lineHeight: 1.7,
            }}
          />
          <ImageAttachments images={attachedImages} onRemove={removeImage} />
          {attachmentError && (
            <div style={{ color: "#ef4444", fontSize: 10 }}>{attachmentError}</div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            tabIndex={-1}
            aria-hidden="true"
            style={{ display: "none" }}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              processImageFiles(files);
            }}
          />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginTop: 4, position: "relative" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
              {/* 模型选择器 */}
              <div style={{ position: "relative" }} ref={modelSelectorRef}>
                <button
                  type="button"
                  onClick={() => {
                    setThinkingDropdownOpen(false);
                    if (!modelDropdownOpen && modelSelectorRef.current) {
                      const rect = modelSelectorRef.current.getBoundingClientRect();
                      setModelMenuPos({ bottom: window.innerHeight - rect.top + 6, left: Math.max(8, rect.left) });
                    }
                    setModelDropdownOpen((prev) => !prev);
                  }}
                  aria-label={t("sidekick.selectModel")}
                  title={t("sidekick.currentModel", { model: displayModelName })}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 3,
                    height: 22,
                    padding: "0 6px",
                    fontSize: 11,
                    color: modelDropdownOpen ? "var(--text)" : "var(--text-muted)",
                    background: modelDropdownOpen ? "var(--bg-hover)" : "transparent",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    cursor: "pointer",
                    maxWidth: 130,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    transition: "color 0.12s, border-color 0.12s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                  onMouseLeave={(e) => { if (!modelDropdownOpen) e.currentTarget.style.color = "var(--text-muted)"; }}
                >
                  <Bot size={11} strokeWidth={1.8} style={{ flexShrink: 0 }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {displayModelName}
                  </span>
                  <ChevronDown size={10} strokeWidth={2} style={{ flexShrink: 0, opacity: 0.6 }} />
                </button>
              </div>

              {/* 思考强度选择器 */}
              <div style={{ position: "relative" }} ref={thinkingSelectorRef}>
                <button
                  type="button"
                  onClick={() => {
                    setModelDropdownOpen(false);
                    if (!thinkingDropdownOpen && thinkingSelectorRef.current) {
                      const rect = thinkingSelectorRef.current.getBoundingClientRect();
                      setThinkingMenuPos({ bottom: window.innerHeight - rect.top + 6, left: Math.max(8, rect.left) });
                    }
                    setThinkingDropdownOpen((prev) => !prev);
                  }}
                  aria-label={t("sidekick.thinkingLevel")}
                  title={t("sidekick.thinkingLevelTitle", { level: selectedThinkingLevel })}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 3,
                    height: 22,
                    padding: "0 6px",
                    fontSize: 11,
                    color: thinkingDropdownOpen ? "var(--text)" : "var(--text-muted)",
                    background: thinkingDropdownOpen ? "var(--bg-hover)" : "transparent",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    transition: "color 0.12s, border-color 0.12s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                  onMouseLeave={(e) => { if (!thinkingDropdownOpen) e.currentTarget.style.color = "var(--text-muted)"; }}
                >
                  <Brain size={11} strokeWidth={1.8} style={{ flexShrink: 0 }} />
                  <span>{selectedThinkingLevel}</span>
                  <ChevronDown size={10} strokeWidth={2} style={{ flexShrink: 0, opacity: 0.6 }} />
                </button>
              </div>
            </div>

            {/* 右侧：图片附件 + 发送按钮 */}
            <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isStreaming || isDeletingThread || isProcessingImages || attachedImages.length >= MAX_ATTACHED_IMAGES}
                aria-label={t("sidekick.addImage")}
                title={t("sidekick.addImage")}
                style={{
                  display: "grid",
                  placeItems: "center",
                  width: 25,
                  height: 23,
                  padding: 0,
                  background: "transparent",
                  color: "var(--text-muted)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  cursor: isStreaming || isDeletingThread || isProcessingImages || attachedImages.length >= MAX_ATTACHED_IMAGES
                    ? "not-allowed"
                    : "pointer",
                  opacity: isStreaming || isDeletingThread || isProcessingImages || attachedImages.length >= MAX_ATTACHED_IMAGES ? 0.45 : 1,
                }}
              >
                <Paperclip size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={handleSend}
                aria-label={t("chat.send")}
                title={t("chat.send")}
                disabled={isStreaming || isDeletingThread || isProcessingImages || (!question.trim() && attachedImages.length === 0)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: 0,
                  width: 25,
                  height: 23,
                  justifyContent: "center",
                  background: "var(--accent)",
                  color: "#fff",
                  border: "none",
                  borderRadius: 4,
                  fontSize: 11,
                  fontWeight: 500,
                  cursor: isStreaming || isDeletingThread || isProcessingImages || (!question.trim() && attachedImages.length === 0)
                    ? "not-allowed"
                    : "pointer",
                  opacity: isStreaming || isDeletingThread || isProcessingImages || (!question.trim() && attachedImages.length === 0) ? 0.45 : 1,
                  transition: "opacity 0.12s",
                }}
              >
                <Send size={13} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  const topbarPortal = isPortaled && topbarTarget
    ? createPortal(headerElement, topbarTarget)
    : isPortaled && resolvedTopbarTarget
      ? createPortal(headerElement, resolvedTopbarTarget)
      : null;

  const modelMenuPortal = modelDropdownOpen && modelMenuPos && typeof document !== "undefined" && document.body
    ? createPortal(
        <div
          ref={modelDropdownPanelRef}
          data-sidekick-interaction="true"
          style={{
            position: "fixed",
            bottom: modelMenuPos.bottom,
            left: Math.max(8, Math.min(modelMenuPos.left, (window.visualViewport?.width ?? window.innerWidth) - 270)),
            width: "max-content",
            minWidth: 240,
            maxWidth: 320,
            maxHeight: Math.min(360, (window.visualViewport?.height ?? window.innerHeight) * 0.6),
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 -4px 16px rgba(0,0,0,0.15)",
            zIndex: 10000,
          }}
        >
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
                  fontSize: 11,
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
            aria-label={t("sidekick.selectModel")}
            style={{ minHeight: 0, overflowY: "auto", flex: 1 }}
          >
            {modelsByProvider.length === 0 ? (
              <div role="presentation" style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: 12, whiteSpace: "nowrap" }}>
                {modelFilter.trim() ? t("chat.noMatchingModels") : "No available models"}
              </div>
            ) : (
              modelsByProvider.map((group, gi) => (
                <div key={group.provider} role="group" aria-label={group.provider}>
                  {modelsByProvider.length > 1 && (
                    <div
                      role="presentation"
                      style={{
                        padding: "6px 12px 4px",
                        fontSize: 10,
                        fontWeight: 600,
                        color: "var(--text-dim)",
                        textTransform: "uppercase",
                        letterSpacing: "0.07em",
                        borderTop: gi > 0 ? "1px solid var(--border)" : "none",
                        position: "sticky",
                        top: 0,
                        background: "var(--bg)",
                        zIndex: 1,
                      }}
                    >
                      {group.provider}
                    </div>
                  )}
                  {group.options.map((opt) => {
                    const isActive = opt.modelId === activeModel?.modelId && opt.provider === activeModel?.provider;
                    return (
                      <SelectorRow
                        key={`${opt.provider}:${opt.modelId}`}
                        active={isActive}
                        onSelect={() => {
                          setSelectedModel({ provider: opt.provider, modelId: opt.modelId });
                          setModelDropdownOpen(false);
                          setModelFilter("");
                        }}
                      >
                        {opt.name}
                      </SelectorRow>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>,
        document.body,
      )
    : null;

  const thinkingMenuPortal = thinkingDropdownOpen && thinkingMenuPos && typeof document !== "undefined" && document.body
    ? createPortal(
        <div
          ref={thinkingDropdownPanelRef}
          role="listbox"
          aria-label={t("sidekick.selectThinkingLevel")}
          data-sidekick-interaction="true"
          style={{
            position: "fixed",
            bottom: thinkingMenuPos.bottom,
            left: Math.max(8, Math.min(thinkingMenuPos.left, (window.visualViewport?.width ?? window.innerWidth) - 130)),
            minWidth: 100,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            boxShadow: "0 -4px 16px rgba(0,0,0,0.15)",
            zIndex: 10000,
            padding: 4,
          }}
        >
          {availableThinkingLevelsList.map((lvl) => {
            const isSelected = selectedThinkingLevel === lvl;
            return (
              <button
                key={lvl}
                type="button"
                role="option"
                aria-selected={isSelected}
                data-sidekick-interaction="true"
                onClick={() => {
                  setThinkingLevelOverride(lvl);
                  setThinkingDropdownOpen(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  width: "100%",
                  padding: "5px 8px",
                  fontSize: 11,
                  textAlign: "left",
                  border: "none",
                  borderRadius: 4,
                  background: isSelected ? "var(--bg-selected)" : "transparent",
                  color: isSelected ? "var(--accent)" : "var(--text)",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
              >
                <span>{lvl}</span>
                {isSelected && <Check size={11} strokeWidth={2} style={{ color: "var(--accent)" }} />}
              </button>
            );
          })}
        </div>,
        document.body,
      )
    : null;

  const portalDocument = sidekickPortalDocument();
  if (isRightPanelPlacement) {
    const target = typeof document !== "undefined" ? document.getElementById(rightPanelTargetId) : null;
    if (!target) return null;
    return (
      <>
        {topbarPortal}
        {modelMenuPortal}
        {thinkingMenuPortal}
        {createPortal(drawer, target)}
      </>
    );
  }
  if (!expanded || !portalDocument?.body) {
    return (
      <>
        {topbarPortal}
        {modelMenuPortal}
        {thinkingMenuPortal}
        {drawer}
      </>
    );
  }

  return (
    <>
      {topbarPortal}
      {modelMenuPortal}
      {thinkingMenuPortal}
      {createPortal(
        <div
          role="presentation"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "rgba(0, 0, 0, 0.5)",
            backdropFilter: "blur(2px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)",
          }}
        >
          {drawer}
        </div>,
        portalDocument.body,
      )}
    </>
  );
}
