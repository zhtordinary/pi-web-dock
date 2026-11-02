import { useEffect, useState, type ReactNode } from "react";

export function ProcessDetailsGroup({ messageCount, toolCallCount, children, t, initiallyExpanded = false, active = false, loading = false, loadError = null, onExpand }: {
  messageCount: number;
  toolCallCount: number;
  children: ReactNode;
  initiallyExpanded?: boolean;
  active?: boolean;
  loading?: boolean;
  loadError?: string | null;
  onExpand?: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const [manuallyExpanded, setExpanded] = useState(initiallyExpanded);
  const expanded = active || manuallyExpanded;
  useEffect(() => {
    if (active && !loading && !loadError) onExpand?.();
  }, [active, loading, loadError, onExpand]);
  const parts = [t("chat.processDetails"), `${messageCount} ${t(messageCount === 1 ? "chat.message" : "chat.messages")}`];
  if (toolCallCount > 0) parts.push(`${toolCallCount} ${t(toolCallCount === 1 ? "chat.toolCall" : "chat.toolCalls")}`);

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        type="button"
        aria-expanded={expanded}
        disabled={active}
        onClick={() => { if (!expanded) onExpand?.(); setExpanded(!expanded); }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "auto",
          minHeight: 24,
          padding: "2px 0",
          border: "none",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
        title={expanded ? t("chat.collapseProcess") : t("chat.expandProcess")}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {parts.join(" · ")}
        </span>
      </button>
      {expanded && (
        <div data-session-search-exclude="true" style={{ marginTop: 8 }}>
          {loading && <div role="status" style={{ marginBottom: 8, color: "var(--text-muted)", fontSize: 12 }}>{t("chat.loadingProcessContent")}</div>}
          {!loading && loadError && (
            <div role="alert" style={{ marginBottom: 8, color: "var(--error)", fontSize: 12 }}>
              {loadError}{" "}
              <button type="button" onClick={onExpand} disabled={!onExpand} style={{ border: 0, background: "none", color: "inherit", textDecoration: "underline", cursor: "pointer" }}>
                {t("chat.retryProcessContent")}
              </button>
            </div>
          )}
          {children}
        </div>
      )}
    </div>
  );
}
