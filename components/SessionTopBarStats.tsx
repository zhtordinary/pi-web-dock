"use client";

import { useI18n } from "@/hooks/useI18n";
import { sessionCacheHitRate, sessionCostColor, sessionCostPresentation } from "@/lib/session-cost";
import type { ContextUsage, SessionStatsInfo } from "@/lib/pi-types";
import { DEFAULT_READER_STATS_SCOPE } from "./SessionInfoResourcePanel";

interface SessionTopBarStatsProps {
  sessionActive: boolean;
  sessionStats: SessionStatsInfo | null;
  contextUsage: ContextUsage | null;
  active: boolean;
  onOpen: () => void;
}

export function SessionTopBarStats({ sessionActive, sessionStats, contextUsage, active, onOpen }: SessionTopBarStatsProps) {
  const { t: translate } = useI18n();
  if (!sessionActive || (!sessionStats && !contextUsage)) return null;
  const tokens = sessionStats?.tokens;
  const lightweightStats = sessionStats?.statsSource === "reader-file";
  const lightweightStatsScope = sessionStats?.statsScope?.trim() || DEFAULT_READER_STATS_SCOPE;
  const cost = sessionStats?.cost ?? 0;
  const costStatus = sessionStats?.costStatus;
  const costState = sessionStats?.costState ?? "ready";
  const costLoading = costState === "loading";
  const costError = costState === "error";
  const missingPriceModels = sessionStats?.missingPriceModels ?? [];
  const missingPriceText = missingPriceModels.join(", ");
  const presentation = sessionCostPresentation(sessionStats?.totalCost ?? {
    status: costStatus ?? "unavailable",
    pendingUsageCount: sessionStats?.pendingUsageCount ?? 0,
    missingPriceModels,
  }, sessionStats?.extensionCosts);
  const costCalculated = costStatus === "calculated" || (costStatus === "partial" && presentation.onlySuggesterPending);
  const costPartial = costStatus === "partial" && !presentation.onlySuggesterPending;
  const costAvailable = costCalculated || costPartial;
  const pendingUsageCount = presentation.pendingUsageCount;
  const sessionStatsTitle = [
    translate("session.title"),
    presentation.recordedOnly ? translate("session.costPartialHint") : "",
    missingPriceText ? `${translate("session.unpricedModels")}: ${missingPriceText}` : "",
    pendingUsageCount > 0 ? translate("session.pendingUsageCount", { count: pendingUsageCount }) : "",
    lightweightStats ? lightweightStatsScope : "",
  ].filter(Boolean).join(" · ");
  const missingPriceTitle = missingPriceText
    ? costPartial ? missingPriceText : `${translate("session.unpricedModels")}: ${missingPriceText}`
    : undefined;
  const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
  const formattedCost = costPartial
    ? `≥$${(Math.floor(cost * 100) / 100).toFixed(2)}`
    : costCalculated ? (cost >= 0.01 ? `$${cost.toFixed(2)}` : "<$0.01") : null;
  const costStr = formattedCost;
  const cacheHitRate = tokens && !lightweightStats
    ? sessionCacheHitRate(tokens.input, tokens.cacheRead, tokens.cacheWrite)
    : null;
  const cacheHitStr = cacheHitRate !== null ? `CH ${cacheHitRate.toFixed(1)}%` : null;
  let ctxColor = "var(--text-muted)";
  let ctxStr: string | null = null;
  if (contextUsage?.contextWindow) {
    const pct = contextUsage.percent;
    if (pct !== null && pct > 90) ctxColor = "#ef4444";
    else if (pct !== null && pct > 70) ctxColor = "rgba(234,179,8,0.95)";
    ctxStr = pct !== null ? `${pct.toFixed(0)}% / ${fmt(contextUsage.contextWindow)}` : `? / ${fmt(contextUsage.contextWindow)}`;
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      title={sessionStatsTitle}
      aria-label={translate("session.title")}
      aria-haspopup="dialog"
      aria-expanded={active}
      style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "0 10px", height: "100%",
        background: active ? "var(--bg-selected)" : "none",
        border: "none",
        fontSize: 11, color: "var(--text-muted)",
        whiteSpace: "nowrap", cursor: "pointer",
        fontVariantNumeric: "tabular-nums",
        transition: "color 0.1s, background 0.1s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = active ? "var(--text)" : "var(--text-muted)"; }}
    >
      {cacheHitStr && (
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" /><polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
          </svg>
          {cacheHitStr}
        </span>
      )}
      {ctxStr && (
        <span style={{ display: "flex", alignItems: "center", gap: 4, color: ctxColor }}>
          <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
          </svg>
          {ctxStr}
        </span>
      )}
      {costAvailable && costStr && <span title={[presentation.recordedOnly ? translate("session.costPartialHint") : "", costPartial ? missingPriceTitle : ""].filter(Boolean).join(" · ") || undefined} style={{ color: sessionCostColor(cost), fontWeight: 500 }}>{costStr}</span>}
      {costLoading && <span title={translate("i18n.loading")} style={{ color: "var(--text-muted)", fontWeight: 600 }}>…</span>}
      {!costLoading && !costAvailable && <span title={costError ? translate("session.unpriced") : presentation.onlySuggesterPending ? translate("session.costPartialHint") : translate("session.unpriced")} style={{ color: presentation.onlySuggesterPending ? "var(--text-muted)" : "#d97706", fontWeight: 600 }}>{presentation.onlySuggesterPending ? "—" : "?"}</span>}
      {missingPriceText && !costPartial && (
        <span title={missingPriceTitle} style={{ color: "#d97706", fontWeight: 600 }}>+?</span>
      )}
      {!costStr && costCalculated && !cacheHitStr && !ctxStr && !missingPriceText && (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><line x1="12" y1="11" x2="12" y2="16" /><circle cx="12" cy="7.5" r="0.7" fill="currentColor" stroke="none" />
        </svg>
      )}
    </button>
  );
}
