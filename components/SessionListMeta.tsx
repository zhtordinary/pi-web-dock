"use client";

import type { CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SessionInfo } from "@/lib/types";

export function formatSessionListRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

function RunningSessionIndicator() {
  const { t } = useI18n();
  return (
    <span title={t("sidebar.agentRunning")} aria-label={t("sidebar.agentRunning")} style={{ width: 14, height: 14, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: "var(--accent)" }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <g>
          <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
          <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
        </g>
      </svg>
    </span>
  );
}

function UnreadSessionIndicator() {
  const { t } = useI18n();
  return (
    <span title={t("sidebar.newActivity")} aria-label={t("sidebar.newSessionActivity")} style={{ width: 14, height: 14, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: "#0891b2" }}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <circle cx="7" cy="7" r="2.5" fill="currentColor" />
        <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.4" opacity="0.32">
          <animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.32;0;0.32" dur="1.6s" repeatCount="indefinite" />
        </circle>
      </svg>
    </span>
  );
}

interface SessionListMetaProps {
  session: SessionInfo;
  isRunning?: boolean;
  isUnread?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function SessionListMeta({ session, isRunning = false, isUnread = false, className, style }: SessionListMetaProps) {
  const { t } = useI18n();
  return (
    <div className={className ?? "session-list-meta"} data-session-list-meta style={{ marginTop: 2, display: "flex", alignItems: "center", gap: 8, color: "var(--text-dim)", fontSize: 11, minWidth: 0, ...style }}>
      {isRunning ? <RunningSessionIndicator /> : isUnread ? <UnreadSessionIndicator /> : <span title={session.modified}>{formatSessionListRelativeTime(session.modified)}</span>}
      <span>{t("sidebar.messagesCount", { count: session.messageCount })}</span>
      {session.worktreeBranch && (
        <span title={`Worktree: ${session.cwd}`} style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--accent)", minWidth: 0, overflow: "hidden" }}>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.worktreeBranch}</span>
        </span>
      )}
    </div>
  );
}
