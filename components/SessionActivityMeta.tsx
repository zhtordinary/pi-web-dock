"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useSessionDetails } from "@/hooks/useSessionDetails";
import { sessionCostColor, sessionCostPresentation } from "@/lib/session-cost";
import { isSubagentCompletionConfirmed } from "@/lib/session-activity-status";
import type { SessionActivityItem, SessionActivityStatus } from "@/lib/session-activity-types";
import { sessionActivityDisplayTime, type SessionActivitySort } from "@/lib/session-activity-filters";

export type CostRootRef = { current: Element | null };

type FormatTime = (value: string) => string;
type StatusLabel = (status: SessionActivityStatus) => string;
type ModelPlacement = "replace-time" | "after-time";

interface Props {
  item: SessionActivityItem;
  sort?: SessionActivitySort;
  statusLabel?: StatusLabel;
  formatTime?: FormatTime;
  contextLabel?: string;
  costPeer?: string;
  costRootRef?: CostRootRef;
  showStatus?: boolean;
  showSubagent?: boolean;
  modelPlacement?: ModelPlacement;
  className?: string;
  style?: CSSProperties;
}

function formatActivityTime(value: string, locale: string, nowMs: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "-";
  const deltaSeconds = Math.round((nowMs - timestamp) / 1000);
  const language = locale === "zh-CN" ? "zh-CN" : "en";
  if (deltaSeconds < 0) return new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(0, "second");
  const amount = Math.max(1, deltaSeconds);
  const relative = new Intl.RelativeTimeFormat(language, { numeric: "always" });
  if (amount < 60) return relative.format(-amount, "second");
  const minutes = Math.round(amount / 60);
  if (minutes < 60) return relative.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return relative.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 7) return relative.format(-days, "day");
  return new Intl.DateTimeFormat(language, { year: "numeric", month: "2-digit", day: "2-digit" }).format(timestamp);
}

function useLazySessionCost(sessionId: string, version: string, peer: string | undefined, rootRef: CostRootRef | undefined) {
  const rowRef = useRef<HTMLSpanElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const { cost, costState } = useSessionDetails({ sessionId, version, peer, costView: "summary", loadCost: nearViewport });

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    let cancelled = false;
    if (typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return () => { cancelled = true; };
    }
    const observer = new IntersectionObserver((entries) => {
      if (cancelled) return;
      setNearViewport(entries[0]?.isIntersecting ?? false);
    }, { root: rootRef?.current ?? null, rootMargin: "240px 0px" });
    observer.observe(row);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [rootRef]);

  const presentation = sessionCostPresentation(cost?.totalCost, cost?.extensionCosts);
  return {
    cost: cost?.amount ?? null,
    costState,
    costStatus: presentation.onlySuggesterPending && cost?.status === "partial" ? "calculated" : cost?.status ?? null,
    cacheHitRate: cost?.cacheHitRate ?? null,
    missingPriceModels: cost?.missingPriceModels ?? [],
    pendingUsageCount: presentation.pendingUsageCount,
    recordedOnly: presentation.recordedOnly,
    rowRef,
  };
}

function MetaSeparator() {
  return <span aria-hidden="true" style={{ margin: "0 5px", color: "var(--text-dim)", flexShrink: 0 }}>·</span>;
}

export function SessionActivityMeta({ item, sort = "recent", statusLabel, formatTime, contextLabel, costPeer, costRootRef, showStatus = true, showSubagent = true, modelPlacement, className, style }: Props) {
  const { locale, t } = useI18n();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const { cost, costState, costStatus, cacheHitRate, missingPriceModels, pendingUsageCount, recordedOnly, rowRef } = useLazySessionCost(item.session.id, item.session.modified, costPeer, costRootRef);
  const status = item.status;
  const subagentCompleted = isSubagentCompletionConfirmed({
    parentRunStatus: item.latestRun?.status,
    parentRunStartedAt: item.latestRun?.startedAt,
    subagentTerminalState: item.subagentTerminalState,
    subagentTerminalAt: item.subagentTerminalAt,
  });
  const costValue = typeof cost === "number" ? cost : 0;
  const partialCost = costStatus === "partial";
  const formattedCost = partialCost
    ? `≥$${(Math.floor(costValue * 100) / 100).toFixed(2)}`
    : typeof cost === "number" && (costValue > 0 || recordedOnly) ? `$${costValue.toFixed(2)}` : null;
  const costText = costState === "loading" ? "…" : costState === "error" ? "?" : formattedCost;
  const unpricedText = missingPriceModels.length > 0 && !partialCost ? t("sessionActivity.unpriced") : null;
  const unpricedTitle = missingPriceModels.length > 0
    ? partialCost ? missingPriceModels.join(", ") : `${t("session.unpricedModels")}: ${missingPriceModels.join(", ")}`
    : undefined;
  const pendingUsageText = pendingUsageCount > 0 ? t("session.pendingUsageCount", { count: pendingUsageCount }) : null;
  const cacheHitText = cacheHitRate != null ? `CH ${cacheHitRate.toFixed(1)}%` : null;
  const timeValue = sessionActivityDisplayTime(item, sort);
  const timeText = formatTime ? formatTime(timeValue) : formatActivityTime(timeValue, locale, nowMs);
  const modelName = modelPlacement ? item.modelName?.trim() : undefined;
  const replaceTimeWithModel = modelPlacement === "replace-time" && Boolean(modelName);
  const modelTextStyle: CSSProperties = { color: "var(--text-dim)", minWidth: 0, flexShrink: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", textAlign: "left" };
  const nonModelFlexStyle: CSSProperties = modelPlacement ? { flexShrink: 0 } : {};
  const statusText = statusLabel ? statusLabel(status) : t(`sessionActivity.status.${status}`);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <span ref={rowRef} className={className ?? "activity-session-meta"} data-session-activity-meta style={{ display: "flex", alignItems: "center", gap: 0, minWidth: 0, width: "100%", overflow: "hidden", fontSize: 10, lineHeight: 1.35, whiteSpace: "nowrap", ...style }}>
      {replaceTimeWithModel ? (
        <span data-session-activity-model="replace-time" title={modelName} style={modelTextStyle}>{modelName}</span>
      ) : (
        <span title={timeValue} style={{ color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", ...nonModelFlexStyle }}>{timeText}</span>
      )}
      {modelPlacement === "after-time" && modelName && (
        <><MetaSeparator /><span data-session-activity-model="after-time" title={modelName} style={modelTextStyle}>{modelName}</span></>
      )}
      {costText && <><MetaSeparator /><span title={[recordedOnly ? t("session.costPartialHint") : "", partialCost ? unpricedTitle : ""].filter(Boolean).join(" · ") || undefined} style={{ color: sessionCostColor(costValue), flexShrink: 0 }}>{costText}</span></>}
      {unpricedText && <><MetaSeparator /><span title={unpricedTitle} style={{ color: "#d97706", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", ...nonModelFlexStyle }}>{unpricedText}</span></>}
      {pendingUsageText && <><MetaSeparator /><span title={pendingUsageText} style={{ color: "#d97706", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", ...nonModelFlexStyle }}>{pendingUsageText}</span></>}
      {cacheHitText && <><MetaSeparator /><span style={{ color: "var(--text-dim)", flexShrink: 0 }}>{cacheHitText}</span></>}
      {contextLabel && <><MetaSeparator /><span style={{ color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", ...nonModelFlexStyle }}>{contextLabel}</span></>}
      {showSubagent && subagentCompleted && <><MetaSeparator /><span title={t("sessionActivity.subagentCompletedHint")} style={{ color: "#2563eb", overflow: "hidden", textOverflow: "ellipsis", ...nonModelFlexStyle }}>{t("sessionActivity.subagentCompleted")}</span></>}
      {showStatus && <><MetaSeparator /><span data-session-activity-status style={{ color: sessionActivityStatusColor(status), flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{statusText}</span></>}
    </span>
  );
}

export function sessionActivityStatusColor(status: SessionActivityStatus): string {
  if (status === "running") return "#16a34a";
  if (status === "retrying") return "#ea580c";
  if (status === "waiting_user") return "#9333ea";
  if (status === "failed") return "#dc2626";
  if (status === "aborted") return "#d97706";
  if (status === "unknown") return "#7c3aed";
  if (status === "just_completed") return "#2563eb";
  return "var(--text-dim)";
}
