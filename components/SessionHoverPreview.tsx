"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import type { SessionInfo } from "@/lib/types";
import type { SessionActivityItem } from "@/lib/session-activity-types";
import type { SessionActivitySort } from "@/lib/session-activity-filters";
import { formatUserQuestion, stripHiddenUserQuestion, type SessionHoverTask } from "@/lib/session-hover-preview";
import { sessionRecapDisplay, type SessionRecapSummary } from "@/lib/session-recap";
import { seedSessionDetails } from "@/lib/session-details-client";
import { useSessionDetails } from "@/hooks/useSessionDetails";
import { SessionActivityMeta, type CostRootRef } from "./SessionActivityMeta";
import { SessionListMeta } from "./SessionListMeta";

const PREVIEW_MAX_WIDTH = 390;
const PREVIEW_VIEWPORT_GAP = 12;
const PREVIEW_PANEL_GAP = 10;

const HOVER_INTERACTION_GRACE_MS = 1000;
type SessionPreviewTab = "questions" | "recap" | "todos";

export function useSessionHover() {
  const [hovered, setHovered] = useState(false);
  const hideTimerRef = useRef<number | null>(null);
  const keepOpenUntilRef = useRef(0);

  const cancelHide = useCallback(() => {
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const dismiss = useCallback(() => {
    cancelHide();
    keepOpenUntilRef.current = 0;
    setHovered(false);
  }, [cancelHide]);

  const scheduleHide = useCallback(() => {
    cancelHide();
    const delay = Math.max(140, keepOpenUntilRef.current - Date.now());
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      if (Date.now() < keepOpenUntilRef.current) {
        scheduleHide();
        return;
      }
      dismiss();
    }, delay);
  }, [cancelHide, dismiss]);

  const enter = useCallback(() => {
    cancelHide();
    keepOpenUntilRef.current = 0;
    setHovered(true);
  }, [cancelHide]);

  const leave = useCallback(() => {
    scheduleHide();
  }, [scheduleHide]);

  const keepOpenBriefly = useCallback(() => {
    keepOpenUntilRef.current = Date.now() + HOVER_INTERACTION_GRACE_MS;
    cancelHide();
    setHovered(true);
  }, [cancelHide]);

  useEffect(() => cancelHide, [cancelHide]);

  return { hovered, enter, leave, keepOpenBriefly, dismiss };
}

interface SessionHoverPreviewProps {
  sessionId: string;
  version?: string;
  deviceId?: string;
  peer?: string;
  initialRecap?: SessionRecapSummary;
  session?: SessionInfo;
  isRunning?: boolean;
  isUnread?: boolean;
  activityItem?: SessionActivityItem;
  activitySort?: SessionActivitySort;
  activityFormatTime?: (value: string) => string;
  activityStatusLabel?: (status: SessionActivityItem["status"]) => string;
  activityContextLabel?: string;
  activityCostPeer?: string;
  activityCostRootRef?: CostRootRef;
  footerActions?: ReactNode;
  headerActions?: ReactNode;
  anchorRef: { current: HTMLElement | null };
  visible: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onInteraction?: () => void;
  onDismiss: () => void;
}

function taskGlyph(task: SessionHoverTask): { glyph: string; color: string } {
  if (task.status === "completed") return { glyph: "✓", color: "#4ade80" };
  if (task.status === "in_progress") return { glyph: "◐", color: "#60a5fa" };
  return { glyph: "○", color: "rgba(255,255,255,0.58)" };
}

export function SessionHoverPreview({ sessionId, version = "", deviceId, peer, initialRecap, session, isRunning = false, isUnread = false, activityItem, activitySort, activityFormatTime, activityStatusLabel, activityContextLabel, activityCostPeer, activityCostRootRef, footerActions, headerActions, anchorRef, visible, onMouseEnter, onMouseLeave, onInteraction, onDismiss }: SessionHoverPreviewProps) {
  const effectiveFooterActions = footerActions ?? headerActions;
  const { t } = useI18n();
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [activeTab, setActiveTab] = useState<SessionPreviewTab>("questions");
  const [anchorMetaText, setAnchorMetaText] = useState<string | null>(null);
  const tabsId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const updatePositionRef = useRef<(() => void) | null>(null);

  const setPanelRef = useCallback((node: HTMLDivElement | null) => {
    if (panelRef.current && panelRef.current !== node) {
      resizeObserverRef.current?.unobserve(panelRef.current);
    }
    panelRef.current = node;
    if (node) {
      resizeObserverRef.current?.observe(node);
      updatePositionRef.current?.();
    }
  }, []);
  const details = useSessionDetails({ sessionId, version, peer, deviceId, loadPreview: visible, loadUserQuestions: visible });
  const preview = details.preview;
  const userQuestions = details.userQuestions;
  // Activity refreshes recreate this object; reseed only when the recap itself changes.
  const initialRecapSignature = initialRecap ? JSON.stringify(initialRecap) : "";
  const seedRecap = useMemo(() => initialRecapSignature ? JSON.parse(initialRecapSignature) as SessionRecapSummary : undefined, [initialRecapSignature]);
  const data = useMemo(() => preview ?? (seedRecap ? { recap: seedRecap } : null), [seedRecap, preview]);
  const loading = visible && preview === undefined;
  const questionLoading = visible && userQuestions === undefined;

  const sessionTitleText = useMemo(() => {
    if (activityItem) {
      const name = stripHiddenUserQuestion(activityItem.session.name ?? "");
      const firstMessage = stripHiddenUserQuestion(activityItem.session.firstMessage);
      return name || firstMessage.split("\n")[0]?.slice(0, 100) || activityItem.session.id;
    }
    if (session) {
      const name = stripHiddenUserQuestion(session.name ?? "");
      const firstMessage = stripHiddenUserQuestion(session.firstMessage);
      return name || firstMessage.split("\n")[0]?.slice(0, 100) || session.id;
    }
    const anchorTitle = anchorRef.current?.querySelector<HTMLElement>(".activity-session-title")?.textContent?.trim();
    const visibleAnchorTitle = anchorTitle ? stripHiddenUserQuestion(anchorTitle) : "";
    if (visibleAnchorTitle) return visibleAnchorTitle;
    return sessionId;
  }, [activityItem, anchorRef, session, sessionId]);

  const displayQuestions = useMemo(() => {
    if (!userQuestions) return [];
    return [...userQuestions].reverse().map((q) => formatUserQuestion(q, 10)).filter(Boolean);
  }, [userQuestions]);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const contains = (target: EventTarget | null, includeAnchor: boolean) => {
      if (!(target instanceof Node)) return false;
      return Boolean(panelRef.current?.contains(target) || (includeAnchor && anchorRef.current?.contains(target)));
    };
    if (!visible) {
      onDismiss();
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!contains(event.target, true)) onDismiss();
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (!contains(event.target, true)) onMouseLeave();
    };
    const handleWindowBlur = () => onDismiss();
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") onDismiss();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [anchorRef, onDismiss, onMouseLeave, visible]);
  useEffect(() => {
    if (!seedRecap) return;
    seedSessionDetails({ sessionId, version, peer, deviceId }, { preview: { recap: seedRecap } });
  }, [deviceId, seedRecap, peer, sessionId, version]);
  useEffect(() => {
    if (!visible || activityItem || session) {
      setAnchorMetaText(null);
      return;
    }
    const meta = anchorRef.current?.querySelector<HTMLElement>(".activity-session-meta");
    setAnchorMetaText(meta?.textContent?.trim() || null);
  }, [activityItem, anchorRef, session, visible]);
  useEffect(() => setActiveTab("questions"), [deviceId, peer, sessionId]);
  useEffect(() => {
    if (!visible) setActiveTab("questions");
  }, [visible]);

  useLayoutEffect(() => {
    if (!visible || !mounted) return;
    let frame = 0;
    let retryFrame = 0;
    const updatePosition = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const sidebar = anchor.closest<HTMLElement>("#session-sidebar") ?? anchor;
      const sidebarRect = sidebar.getBoundingClientRect();
      const left = Math.max(PREVIEW_VIEWPORT_GAP, sidebarRect.right + PREVIEW_PANEL_GAP);
      const width = Math.max(1, Math.min(PREVIEW_MAX_WIDTH, window.innerWidth - left - PREVIEW_VIEWPORT_GAP));

      let container: HTMLElement | null = anchor.parentElement;
      while (container && container !== sidebar && container !== document.body) {
        const style = window.getComputedStyle(container);
        if (style.overflowY === "auto" || style.overflowY === "scroll") {
          break;
        }
        container = container.parentElement;
      }

      let top = PREVIEW_VIEWPORT_GAP;
      let height = Math.max(200, window.innerHeight - PREVIEW_VIEWPORT_GAP * 2);
      if (container && container !== sidebar) {
        const containerRect = container.getBoundingClientRect();
        top = Math.max(PREVIEW_VIEWPORT_GAP, containerRect.top);
        const bottom = Math.min(window.innerHeight - PREVIEW_VIEWPORT_GAP, containerRect.bottom);
        height = Math.max(200, bottom - top);
      }

      setPosition({ top, left, width, height });
    };
    updatePositionRef.current = updatePosition;
    const schedulePosition = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updatePosition);
    };
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedulePosition);
    resizeObserverRef.current = resizeObserver;
    const observeLayout = () => {
      const anchor = anchorRef.current;
      if (!anchor) return false;
      const sidebar = anchor.closest<HTMLElement>("#session-sidebar");
      resizeObserver?.observe(anchor);
      if (sidebar && sidebar !== anchor) resizeObserver?.observe(sidebar);
      if (panelRef.current) resizeObserver?.observe(panelRef.current);
      updatePosition();
      return true;
    };

    window.addEventListener("resize", schedulePosition);
    window.addEventListener("scroll", schedulePosition, true);
    if (!observeLayout()) retryFrame = window.requestAnimationFrame(observeLayout);
    return () => {
      resizeObserverRef.current = null;
      updatePositionRef.current = null;
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(retryFrame);
      window.removeEventListener("resize", schedulePosition);
      window.removeEventListener("scroll", schedulePosition, true);
      resizeObserver?.disconnect();
    };
  }, [anchorRef, data, loading, mounted, visible]);

  if (!mounted || !visible || !position) return null;

  const recapDisplay = sessionRecapDisplay(data?.recap);
  const recapHeading = recapDisplay.title ? `○ ${recapDisplay.title}` : undefined;
  const recapBody = recapDisplay.body;
  const tasks = data?.todos?.tasks ?? [];
  const tabs: { id: SessionPreviewTab; label: string }[] = [
    { id: "questions", label: t("sessionActivity.userQuestion") },
    { id: "recap", label: t("sessionActivity.recap") },
    { id: "todos", label: t("sessionActivity.todos") },
  ];
  const metaStyle: CSSProperties = {
    marginTop: 0,
    marginBottom: 0,
    paddingBottom: 0,
    borderBottom: "none",
    color: "rgba(255,255,255,0.58)",
    width: "auto",
    textAlign: "right",
    justifyContent: "flex-end",
  };
  const metaContent = activityItem ? (
    <SessionActivityMeta item={activityItem}
      sort={activitySort}
      formatTime={activityFormatTime}
      statusLabel={activityStatusLabel}
      contextLabel={activityContextLabel}
      costPeer={activityCostPeer ?? peer}
      costRootRef={activityCostRootRef}
      modelPlacement="replace-time"
      style={metaStyle}
    />
  ) : session ? (
    <SessionListMeta session={session} isRunning={isRunning} isUnread={isUnread} style={metaStyle} />
  ) : !activityItem && !session && anchorMetaText ? (
    <div className="activity-session-meta" style={{ ...metaStyle, fontSize: 10, lineHeight: 1.35, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textAlign: "right" }}>{anchorMetaText}</div>
  ) : null;
  const panelStyle: CSSProperties = {
    position: "fixed",
    top: position.top,
    left: position.left,
    width: position.width,
    height: position.height,
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    zIndex: 1200,
    padding: "15px 17px",
    border: "1px solid rgba(255,255,255,0.13)",
    borderRadius: 15,
    background: "rgba(24,24,27,0.94)",
    boxShadow: "0 18px 50px rgba(0,0,0,0.32), 0 2px 8px rgba(0,0,0,0.22)",
    backdropFilter: "blur(14px)",
    WebkitBackdropFilter: "blur(14px)",
    color: "rgba(255,255,255,0.92)",
    fontSize: 12,
    lineHeight: 1.55,
  };

  return createPortal(
    <div ref={setPanelRef} role="dialog" aria-label={t("sessionActivity.previewSections")} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={panelStyle}>
      <div data-session-hover-header style={{ flexShrink: 0, marginBottom: 2 }}>
        <div
          data-session-hover-title
          title={sessionTitleText}
          style={{
            fontWeight: 700,
            fontSize: 12,
            lineHeight: 1.4,
            color: "rgba(255,255,255,0.96)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            paddingBottom: 8,
          }}
        >
          {sessionTitleText}
        </div>
        <div role="tablist" aria-label={t("sessionActivity.previewSections")} style={{ display: "flex", borderTop: "1px solid rgba(255,255,255,0.12)", borderBottom: "1px solid rgba(255,255,255,0.12)" }}>
          {tabs.map((tab, index) => {
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                ref={(node) => { tabRefs.current[index] = node; }}
                id={`${tabsId}-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`${tabsId}-panel`}
                tabIndex={selected ? 0 : -1}
                onClick={(event) => { event.stopPropagation(); onInteraction?.(); setActiveTab(tab.id); }}
                onKeyDown={(event) => {
                  let nextIndex = -1;
                  if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
                  else if (event.key === "ArrowLeft") nextIndex = (index + tabs.length - 1) % tabs.length;
                  else if (event.key === "Home") nextIndex = 0;
                  else if (event.key === "End") nextIndex = tabs.length - 1;
                  if (nextIndex < 0) return;
                  event.preventDefault();
                  onInteraction?.();
                  setActiveTab(tabs[nextIndex].id);
                  tabRefs.current[nextIndex]?.focus();
                }}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: "1 1 0", minWidth: 0, minHeight: 28, padding: "4px 7px 5px", boxSizing: "border-box", border: 0, borderBottom: selected ? "2px solid #60a5fa" : "2px solid transparent", background: selected ? "rgba(255,255,255,0.06)" : "transparent", color: selected ? "rgba(255,255,255,0.96)" : "rgba(255,255,255,0.62)", cursor: "pointer", textAlign: "center", font: "inherit", fontSize: 11, lineHeight: 1.2, fontWeight: selected ? 700 : 600 }}
              >
                <span style={{ minWidth: 0 }}>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-tab-${activeTab}`} tabIndex={0} data-session-hover-body style={{ flex: "1 1 auto", overflowY: "auto", minHeight: 0, paddingTop: 10 }}>
        {activeTab === "questions" && (
          questionLoading ? (
            <div style={{ color: "rgba(255,255,255,0.58)", fontSize: 11 }}>{t("sessionActivity.loading")}</div>
          ) : displayQuestions.length ? (
            <div style={{ display: "grid", gap: 6 }}>
              {displayQuestions.map((question, index) => (
                <div key={index} style={{ display: "flex", alignItems: "flex-start", gap: 6, minWidth: 0, fontSize: 12, lineHeight: 1.45 }}>
                  <svg
                    data-session-hover-question-icon="heroicons-chat-bubble-oval-left-ellipsis"
                    aria-hidden="true"
                    width={11}
                    height={11}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ width: 11, flexShrink: 0, color: "#60a5fa", marginTop: 2 }}
                  >
                    <path d="M8.625 12a.375.375 0 1 1-.75 0a.375.375 0 0 1 .75 0m0 0H8.25m4.125 0a.375.375 0 1 1-.75 0a.375.375 0 0 1 .75 0m0 0H12m4.125 0a.375.375 0 1 1-.75 0a.375.375 0 0 1 .75 0m0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.8 9.8 0 0 1-2.555-.337A5.97 5.97 0 0 1 5.41 20.97a6 6 0 0 1-.474-.065a4.5 4.5 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25" />
                  </svg>
                  <span style={{ minWidth: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "rgba(255,255,255,0.92)", display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 10, overflow: "hidden" }}>{question}</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color: "rgba(255,255,255,0.58)", fontSize: 11 }}>{t("sessionActivity.noQuestion")}</div>
          )
        )}
        {activeTab === "recap" && (
          <>
            {recapHeading && (
              <div style={{ fontWeight: 700, lineHeight: 1.65, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "rgba(255,255,255,0.94)" }}>
                {recapHeading}
              </div>
            )}
            {loading ? (
              <div style={{ color: "rgba(255,255,255,0.58)", fontSize: 11 }}>{t("sessionActivity.loading")}</div>
            ) : recapBody ? (
              <div style={{ marginTop: 7, fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.45, color: "rgba(255,255,255,0.85)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {recapBody}
              </div>
            ) : (
              <div style={{ color: "rgba(255,255,255,0.58)", fontSize: 11 }}>{t("sessionActivity.noRecap")}</div>
            )}
          </>
        )}
        {activeTab === "todos" && (
          loading ? (
            <div style={{ color: "rgba(255,255,255,0.58)", fontSize: 11 }}>{t("sessionActivity.loading")}</div>
          ) : tasks.length ? (
            <div style={{ display: "grid", gap: 4, marginTop: 7 }}>
              {tasks.map((task) => {
                const status = taskGlyph(task);
                return (
                  <div key={task.id} style={{ display: "flex", alignItems: "flex-start", gap: 7, minWidth: 0, color: task.status === "completed" ? "rgba(255,255,255,0.48)" : "rgba(255,255,255,0.82)" }}>
                    <span aria-hidden="true" style={{ width: 14, flexShrink: 0, color: status.color, textAlign: "center", fontSize: 12 }}>{status.glyph}</span>
                    <span style={{ minWidth: 0, overflowWrap: "anywhere", textDecoration: task.status === "completed" ? "line-through" : "none" }}>
                      {task.subject}
                      {task.status === "in_progress" && task.activeForm && <span style={{ color: "rgba(255,255,255,0.46)" }}> · {task.activeForm}</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ color: "rgba(255,255,255,0.58)", fontSize: 11 }}>{t("sessionActivity.noTodos")}</div>
          )
        )}
      </div>
      {(effectiveFooterActions || metaContent) && (
        <div data-session-hover-footer style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 10, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.12)", flexShrink: 0, minWidth: 0 }}>
          <div data-session-hover-footer-actions style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
            {effectiveFooterActions}
          </div>
          <div data-session-hover-footer-meta style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", minWidth: 0, flex: "1 1 auto", overflow: "hidden" }}>
            {metaContent}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
