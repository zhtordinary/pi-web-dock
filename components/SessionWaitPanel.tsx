"use client";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Network, X } from "lucide-react";
import { useI18n } from "@/hooks/useI18n";
import { formatRelativeTime } from "@/lib/i18n/format";
import { canCancel, canPause, canResume, readinessReasonKey, waitConditionKey, waitStatusKey } from "@/lib/session-wait-ui";
import { createWaitStatusRefresher, fetchAllSessionWaitStatus, postSessionWaitControl } from "@/lib/session-wait-client";
import { openReaderEventSource } from "@/lib/reader-events-client";
import { isActiveRelation, mergeSessionRelationSnapshots, sessionRelationGroups, type RelationIdentity, type SessionRelationSnapshot, type SessionRelationWait } from "@/lib/session-relations";

type Props = {
  sessionId?: string;
  peerId?: string;
  history?: boolean;
  onOpenSession?: (device: { id: string; name: string; url?: string }, sessionId: string) => void;
};
type PanelPosition = { top: number; left: number };
const controlStyle = { border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--text)", padding: "4px 8px", cursor: "pointer", fontSize: 12 };

export function SessionWaitPanel({ sessionId, peerId, history = false, onOpenSession }: Props) {
  const { t, locale } = useI18n();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const suppressFocus = useRef(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshRef = useRef<ReturnType<typeof createWaitStatusRefresher<SessionRelationSnapshot>> | null>(null);
  const [snapshot, setSnapshot] = useState<SessionRelationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [panelPosition, setPanelPosition] = useState<PanelPosition | null>(null);
  const open = history || hovered || pinned;
  const updatePanelPosition = useCallback(() => {
    const triggerElement = trigger.current;
    if (!triggerElement) return;
    const triggerRect = triggerElement.getBoundingClientRect();
    const panelRect = panelRef.current?.getBoundingClientRect();
    const width = panelRect?.width ?? 360;
    const height = panelRect?.height ?? 420;
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const margin = 8;
    const left = Math.min(Math.max(margin, triggerRect.right - width), Math.max(margin, viewportWidth - width - margin));
    const below = triggerRect.bottom + 6;
    const top = below + height <= viewportHeight - margin || triggerRect.top - height - 6 < margin
      ? below
      : triggerRect.top - height - 6;
    setPanelPosition({ left, top: Math.min(Math.max(margin, top), Math.max(margin, viewportHeight - height - margin)) });
  }, []);

  useEffect(() => {
    const refresher = createWaitStatusRefresher(async signal => {
      const response = await fetchAllSessionWaitStatus(fetch, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json() as SessionRelationSnapshot;
    }, value => { setSnapshot(previous => mergeSessionRelationSnapshots(previous, value)); setError(null); }, reason => setError(reason instanceof Error ? reason.message : String(reason)));
    refreshRef.current = refresher;
    const source = openReaderEventSource(["waits_changed", "running", "peer_state"]);
    source.onopen = () => { void refresher.refresh(); };
    source.onmessage = ({ data }) => {
      try { if (JSON.parse(data).type !== "running") void refresher.refresh(); }
      catch (reason) { console.warn("[SessionWaitPanel] invalid notification:", reason); }
    };
    void refresher.refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresher.refresh(); }, 5000);
    return () => { source.close(); window.clearInterval(timer); refresher.dispose(); if (refreshRef.current === refresher) refreshRef.current = null; };
  }, []);

  const clearHoverTimer = () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); hoverTimer.current = null; };
  const close = () => { clearHoverTimer(); setPinned(false); setHovered(false); };
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);
  useEffect(() => { setPinned(false); setHovered(false); setOperationError(null); }, [sessionId, peerId]);
  useEffect(() => {
    if (!open || history) return;
    const outside = (event: PointerEvent) => { const target = event.target as Node; if (!root.current?.contains(target) && !panelRef.current?.contains(target)) { setPinned(false); setHovered(false); } };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setPinned(false); setHovered(false); suppressFocus.current = document.activeElement !== trigger.current; trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open, history]);
  useLayoutEffect(() => {
    if (!open || history) { setPanelPosition(null); return; }
    const frame = window.requestAnimationFrame(updatePanelPosition);
    const reposition = () => updatePanelPosition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => { window.cancelAnimationFrame(frame); window.removeEventListener("resize", reposition); window.removeEventListener("scroll", reposition, true); };
  }, [history, open, updatePanelPosition]);

  const deviceId = peerId ?? snapshot?.sources?.find(source => source.local)?.deviceId;
  const groups = sessionId && deviceId ? sessionRelationGroups(snapshot?.waits ?? [], { deviceId, sessionId }) : [];
  const count = new Set(groups.map(group => JSON.stringify([group.peer.deviceId, group.peer.sessionId]))).size;
  const historical = (snapshot?.waits ?? []).filter(wait => !isActiveRelation(wait));
  const name = (identity?: RelationIdentity) => identity?.title || `${t("sessionRelation.unnamed")} #${identity?.sessionId.slice(0, 8) ?? "?"}`;
  const sourceFor = (identity: RelationIdentity) => snapshot?.sources?.find(source => source.deviceId === identity.deviceId);
  const openSession = (identity: RelationIdentity) => {
    const source = sourceFor(identity);
    if (!source || (!source.local && !source.url) || !onOpenSession) return;
    close(); onOpenSession({ id: source.deviceId, name: source.deviceName, url: source.url }, identity.sessionId);
  };
  const control = async (wait: SessionRelationWait, operation: "pause" | "resume" | "cancel") => {
    const refresher = refreshRef.current;
    setBusy(`${wait.source?.deviceId}:${wait.id}`); setOperationError(null);
    try {
      const response = await postSessionWaitControl(wait.source?.local ? null : wait.source?.deviceId, { operation, waitId: wait.id });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (refreshRef.current === refresher) await refresher?.refresh();
    } catch (reason) { if (refreshRef.current === refresher) setOperationError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (refreshRef.current === refresher) setBusy(null); }
  };
  const peerButton = (identity: RelationIdentity) => <button type="button" onClick={() => openSession(identity)} disabled={!onOpenSession || !sourceFor(identity)} title={`${identity.deviceId}:${identity.sessionId}`} className="text-left hover:underline focus-visible:outline active:translate-y-px" style={{ background: "none", border: 0, padding: 0, color: "var(--text)", font: "inherit", fontWeight: 600, overflowWrap: "anywhere", cursor: "pointer" }}>{name(identity)}</button>;
  const renderWait = (wait: SessionRelationWait, incoming = false) => <div key={`${wait.source?.deviceId}:${wait.id}`} data-session-wait={wait.id} style={{ marginTop: 8, fontSize: 12, lineHeight: 1.5 }}>
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", color: "var(--text-muted)" }}>
      <span>{t(wait.condition === "ui_request" ? incoming ? "sessionRelation.monitorsMe" : "sessionRelation.monitorPopup" : incoming ? `sessionRelation.incoming.${wait.condition}` : waitConditionKey(wait.condition))}</span>
      <span>·</span>
      <span>{wait.stale || error ? t("sessionRelation.unknown") : wait.status === "completed" && wait.continuationStatus ? t(`sessionRelation.delivery.${["unknown", "blocked"].includes(wait.continuationStatus) ? wait.continuationStatus : "pending"}`) : t(wait.condition === "ui_request" && wait.status === "waiting" ? "sessionRelation.listening" : waitStatusKey(wait.status))}</span>
      {wait.createdAt && <span>· {formatRelativeTime(wait.createdAt, locale)}</span>}
    </div>
    {wait.readiness?.status === "blocked" && !wait.stale && <div style={{ color: "var(--warning, #b45309)", marginTop: 3 }}>{t(readinessReasonKey(wait.readiness.reason)) === readinessReasonKey(wait.readiness.reason) ? t("sessionRelation.blocked") : t(readinessReasonKey(wait.readiness.reason))}</div>}
    <details style={{ marginTop: 4, color: "var(--text-dim)" }}>
      <summary style={{ cursor: "pointer", fontSize: 11 }}>{t("sessionRelation.details")}</summary>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingTop: 6 }}>
        {[...(canPause(wait.status) ? ["pause" as const] : []), ...(canResume(wait.status) ? ["resume" as const] : []), ...((canCancel(wait.status) || (wait.status === "completed" && wait.continuationStatus)) ? ["cancel" as const] : [])].map(operation => <button key={operation} type="button" style={controlStyle} disabled={Boolean(busy || error || wait.stale || !wait.source?.online)} onClick={() => void control(wait, operation)}>{t(`sessionWait.${operation}`)}</button>)}
      </div>
      <div style={{ fontSize: 11, marginTop: 6 }}>{t("sessionWait.cancelScope")}</div>
      {wait.reason && <div style={{ marginTop: 4, overflowWrap: "anywhere" }}>{wait.reason}</div>}
      <div style={{ marginTop: 4, overflowWrap: "anywhere", fontFamily: "var(--font-mono)" }}>{wait.id}</div>
    </details>
  </div>;

  if (!history && count === 0) return null;
  const content = <>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <strong style={{ fontSize: 13 }}>{t(history ? "sessionRelation.history" : "sessionRelation.title")}</strong>
      {!history && <button type="button" aria-label={t("i18n.close")} onClick={close} style={{ background: "none", border: 0, color: "var(--text-muted)", cursor: "pointer", padding: 4 }}><X size={14} /></button>}
    </div>
    {(error || operationError) && <div role="status" style={{ marginTop: 8, fontSize: 12, color: "var(--warning, #b45309)" }}>{t("sessionRelation.refreshFailed")}: {operationError ?? error}</div>}
    {history ? historical.length === 0 ? <p style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("sessionRelation.noHistory")}</p> : historical.map(wait => <div key={`${wait.source?.deviceId}:${wait.id}`} style={{ padding: "10px 0", borderTop: "1px solid var(--border)", marginTop: 8 }}>
      <div style={{ fontSize: 12, overflowWrap: "anywhere" }}>{wait.owner ? peerButton(wait.owner) : t("sessionRelation.unnamed")} → {wait.target ? peerButton(wait.target) : t("sessionRelation.unnamed")}</div>
      <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{wait.owner?.deviceName ?? wait.owner?.deviceId} → {wait.target?.deviceName ?? wait.target?.deviceId}</div>
      {renderWait(wait)}
    </div>) : (["outgoing", "incoming"] as const).map(direction => {
      const rows = groups.filter(group => group.direction === direction);
      if (!rows.length) return null;
      return <section key={direction} aria-label={t(`sessionRelation.${direction}`)} style={{ marginTop: 14 }}>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>{t(`sessionRelation.${direction}`)} · {rows.length}</div>
        {rows.map(group => <div key={`${group.peer.deviceId}:${group.peer.sessionId}`} style={{ padding: "10px 0", borderTop: "1px solid var(--border)" }}>
          {peerButton(group.peer)}
          <div style={{ marginTop: 2, fontSize: 11, color: "var(--text-dim)" }}>{group.peer.deviceName ?? sourceFor(group.peer)?.deviceName ?? group.peer.deviceId} · #{group.peer.sessionId.slice(0, 8)}</div>
          {group.waits.map(wait => renderWait(wait, direction === "incoming"))}
        </div>)}
      </section>;
    })}
  </>;
  if (history) return <div data-session-wait-history style={{ padding: 12 }}>{content}</div>;
  const relationPanel = open && typeof document !== "undefined" ? createPortal(
    <div
      ref={panelRef}
      id={id}
      role="dialog"
      aria-label={t("sessionRelation.title")}
      onMouseEnter={() => { clearHoverTimer(); setHovered(true); }}
      onMouseLeave={() => { clearHoverTimer(); hoverTimer.current = setTimeout(() => setHovered(false), 180); }}
      style={{
        position: "fixed",
        top: panelPosition?.top ?? 8,
        left: panelPosition?.left ?? 8,
        zIndex: 1200,
        width: 360,
        maxWidth: "min(360px, calc(100vw - 24px))",
        maxHeight: "min(420px, 65dvh)",
        overflowY: "auto",
        overscrollBehavior: "contain",
        background: "var(--bg-panel)",
        color: "var(--text)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        boxShadow: "0 8px 24px color-mix(in srgb, var(--text) 10%, transparent)",
        padding: "12px 14px",
        pointerEvents: "auto",
        visibility: panelPosition ? "visible" : "hidden",
      }}
    >{content}</div>,
    document.body,
  ) : null;
  return <>
    <div ref={root} data-session-relations style={{ position: "relative", zIndex: 45, display: "flex", alignItems: "center", height: "100%", flexShrink: 0 }}
      onMouseEnter={() => { clearHoverTimer(); hoverTimer.current = setTimeout(() => setHovered(true), 250); }}
      onMouseLeave={() => { clearHoverTimer(); hoverTimer.current = setTimeout(() => setHovered(false), 180); }}
      onBlur={event => { const target = event.relatedTarget as Node | null; if (!root.current?.contains(target) && !panelRef.current?.contains(target)) setHovered(false); }}>
      <button ref={trigger} type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls={id} onFocus={() => { if (suppressFocus.current) suppressFocus.current = false; else setHovered(true); }} onClick={() => { clearHoverTimer(); if (pinned) close(); else { setPinned(true); setHovered(true); } }} className="active:translate-y-px focus-visible:outline" style={{ ...controlStyle, pointerEvents: "auto", display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-muted)", minHeight: 32, padding: "5px 9px" }}>
        <Network size={14} aria-hidden="true" />{t("sessionRelation.title")} · {count}
      </button>
    </div>
    {relationPanel}
  </>;
}

export function SessionWaitHistory({ onOpenSession }: Pick<Props, "onOpenSession">) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)} style={{ borderTop: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 12, flexShrink: 0, maxHeight: "45%", overflowY: "auto" }}>
    <summary style={{ padding: "8px 12px", cursor: "pointer" }}>{t("sessionRelation.history")}</summary>
    {open && <SessionWaitPanel history onOpenSession={onOpenSession} />}
  </details>;
}
