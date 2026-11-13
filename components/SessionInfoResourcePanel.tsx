"use client";

import { Fragment, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { mergeSessionCostSummaries, sessionCostColor, sessionCostPresentation } from "@/lib/session-cost";
import { formatMetricNumber as formatMetricNumberValue } from "@/lib/format-metric-number";
import { formatResponseDuration } from "@/lib/response-duration";
import type { ContextUsage, SessionStatsInfo } from "@/lib/pi-types";

export const DEFAULT_READER_STATS_SCOPE = "Reader persisted session file; excludes child sessions and Reader-priced total";

type SessionCostDetailRow = {
  key: string;
  label: string;
  value: string;
  title?: string;
  models: string[];
  details?: SessionCostDetailRow[];
};

interface SessionInfoResourcePanelProps {
  sessionStats: SessionStatsInfo;
  contextUsage?: ContextUsage | null;
  expandedCostModels: Record<string, boolean>;
  toggleCostModels: (key: string) => void;
}

export function SessionInfoResourcePanel({ sessionStats, contextUsage, expandedCostModels, toggleCostModels }: SessionInfoResourcePanelProps) {
  const { locale, t: translate } = useI18n();
  const ctx = contextUsage ?? sessionStats.contextUsage;
  const statsScope = sessionStats.statsScope?.trim() || DEFAULT_READER_STATS_SCOPE;
  const formatMetricNumber = (n: number) => formatMetricNumberValue(n, locale);
  const promptTokens = (sessionStats.tokens.input ?? 0) + (sessionStats.tokens.cacheRead ?? 0) + (sessionStats.tokens.cacheWrite ?? 0);
  const cacheHitRate = promptTokens > 0 && sessionStats.tokens.cacheRead > 0
    ? ((sessionStats.tokens.cacheRead / promptTokens) * 100)
    : null;
  const tokenDetailRows = [
    { label: translate("session.input"), labelNode: null, value: formatMetricNumber(sessionStats.tokens.input), raw: sessionStats.tokens.input },
    { label: translate("session.output"), labelNode: null, value: formatMetricNumber(sessionStats.tokens.output), raw: sessionStats.tokens.output },
    ...(sessionStats.tokens.cacheRead > 0 ? [{
      label: translate("session.cacheRead"),
      labelNode: cacheHitRate !== null ? (
        <span>
          {translate("session.cacheRead")} {" "}
          <span style={{ color: "var(--accent, #3b82f6)" }}>({cacheHitRate.toFixed(1)}%)</span>
        </span>
      ) : null,
      value: formatMetricNumber(sessionStats.tokens.cacheRead),
      raw: sessionStats.tokens.cacheRead,
    }] : []),
    ...(sessionStats.tokens.cacheWrite > 0 ? [{ label: translate("session.cacheWrite"), labelNode: null, value: formatMetricNumber(sessionStats.tokens.cacheWrite), raw: sessionStats.tokens.cacheWrite }] : []),
  ];
  const formatCompact = (n: number) => formatMetricNumber(n);
  const missingPriceModels = sessionStats.missingPriceModels ?? [];
  const timing = sessionStats.timing;
  const timingAvailable = timing !== undefined && typeof timing.effectiveMs === "number" && timing.quality !== "unavailable";
  const timingTitle = (() => {
    const base = translate("session.timingTitle");
    if (!timing || !timingAvailable) return base;
    const lines = [base, ""];
    if (timing.scope === "fork-execution") lines.push(`• ${translate("session.forkExecutionScope")}`);
    lines.push(`• ${translate("session.timingParent", {
      total: formatResponseDuration(timing.parent.agentTotalMs),
      model: formatResponseDuration(timing.parent.modelResponseMs),
    })}`);
    if (timing.children.count > 0) {
      lines.push(`• ${translate("session.timingChildren", {
        count: String(timing.children.count),
        total: formatResponseDuration(timing.children.agentTotalMs),
        model: formatResponseDuration(timing.children.modelResponseMs),
      })}`);
    }
    lines.push(`• ${translate("session.timingTools", { duration: formatResponseDuration(timing.toolMs) })}`);
    lines.push(`• ${timing.retryWaitMs > 0
      ? translate("session.timingOtherWithRetry", { duration: formatResponseDuration(timing.otherMs), retry: formatResponseDuration(timing.retryWaitMs) })
      : translate("session.timingOther", { duration: formatResponseDuration(timing.otherMs) })}`);
    if (timing.userWaitMs > 0) lines.push(`• ${translate("session.timingUserWait", { duration: formatResponseDuration(timing.userWaitMs) })}`);
    if (timing.children.missingRecords > 0) {
      lines.push(`• ${translate("session.timingMissingChildren", { count: String(timing.children.missingRecords) })}`);
    }
    return lines.join("\n");
  })();
  const timingValue = (durationMs: number | undefined) => timingAvailable && durationMs !== undefined
    ? formatResponseDuration(durationMs)
    : translate("session.timingUnavailable");
  const effectiveDurationValue = timingValue(timing?.effectiveMs);
  const agentTotalValue = timingValue(timing?.agentTotalMs);
  const modelResponseValue = timingValue(timing?.modelResponseMs);
  const timingChildCount = timingAvailable ? timing?.children.count ?? 0 : 0;
  const timingPartial = timingAvailable && timing?.quality === "partial";
  const modelResponseShareValue = timingAvailable && timing?.modelResponsePercent !== undefined
    ? `${timing.modelResponsePercent.toFixed(1)}%`
    : translate("session.timingUnavailable");
  const presentation = sessionCostPresentation(sessionStats.totalCost ?? {
    status: sessionStats.costStatus ?? "unavailable",
    pendingUsageCount: sessionStats.pendingUsageCount ?? 0,
    missingPriceModels,
  }, sessionStats.extensionCosts);
  const costCalculated = sessionStats.costStatus === "calculated";
  const costPartial = sessionStats.costStatus === "partial";
  const formatCostModels = (summary: SessionStatsInfo["totalCost"]) => {
    const rawModels = summary?.models ?? [];
    const models = [...new Set(rawModels.map((item) => item?.trim()).filter((model) => Boolean(model) && model !== "unknown/unknown"))] as string[];
    if (models.length === 0) return { label: "", title: undefined, models: [] };
    if (models.length === 1) return { label: ` (${models[0]})`, title: models[0], models };
    return {
      label: ` (${translate("session.costModelCount", { count: models.length })})`,
      title: models.join(", "),
      models,
    };
  };
  const formatCostSummary = (summary: SessionStatsInfo["totalCost"], onlySuggesterPending = false) => {
    if (sessionStats.costState === "loading") return translate("i18n.loading");
    const amount = summary?.amount ?? (!summary && (costCalculated || costPartial) ? sessionStats.cost : null);
    const status = summary?.status ?? sessionStats.costStatus;
    if ((status === "calculated" || status === "partial") && typeof amount === "number") {
      return status === "partial" && !onlySuggesterPending
        ? `≥$${(Math.floor(amount * 10_000) / 10_000).toFixed(4)}`
        : `$${amount.toFixed(4)}`;
    }
    return onlySuggesterPending ? "—" : translate("session.unpriced");
  };
   const childSessionCount = sessionStats.childCost?.sessionCount ?? 0;
   const childCostLabel = childSessionCount > 0
    ? translate("session.childCostCount", { count: childSessionCount })
    : translate("session.childCost");
   const parentCostModels = formatCostModels(sessionStats.parentCost);
   const childCostModels = formatCostModels(sessionStats.childCost);
   const totalCostModels = formatCostModels(sessionStats.totalCost);
   const extensionCosts = sessionStats.extensionCosts ?? [];
   const parentOnlySuggesterPending = presentation.onlySuggesterPending && (sessionStats.parentCost?.pendingUsageCount ?? 0) > 0;
   const childOnlySuggesterPending = presentation.onlySuggesterPending && (sessionStats.childCost?.pendingUsageCount ?? 0) > 0;
   const compactionCostModels = formatCostModels(sessionStats.compactionCost);
   const compactionCostRow: SessionCostDetailRow = {
     key: "plugin:compaction",
     label: `${translate("session.compactionCost")}${compactionCostModels.label}`,
     value: formatCostSummary(sessionStats.compactionCost),
     title: compactionCostModels.title,
     models: compactionCostModels.models,
   };
   const recapCostModels = formatCostModels(sessionStats.recapCost);
   const recapCostRow: SessionCostDetailRow = {
     key: "plugin:recap",
     label: `${translate("session.recapCost")}${recapCostModels.label}`,
     value: formatCostSummary(sessionStats.recapCost),
     title: recapCostModels.title,
     models: recapCostModels.models,
   };
   const extensionCostRows: SessionCostDetailRow[] = extensionCosts.map((summary) => {
     const name = (sessionStats.extensionUsages?.find((usage) => usage.key === summary.id)?.label ?? summary.id).replace(/\s+usage$/i, "");
     const models = formatCostModels({ ...summary, models: summary.models.filter((model) => model !== "unknown/unknown") });
     const historical = summary.historicalEstimated
       ? translate(summary.missingPriceModels.length > 0 ? "session.extensionHistoricalEstimatedPartial" : "session.extensionHistoricalEstimated")
       : summary.historicalIncomplete ? translate("session.extensionHistoricalUnpriced") : "";
     const extensionPresentation = sessionCostPresentation(summary, [summary]);
     const pending = extensionPresentation.pendingUsageCount > 0
       ? translate("session.pendingUsageCount", { count: extensionPresentation.pendingUsageCount })
       : "";
     return {
       key: `plugin:extension:${summary.id}`,
       label: `${translate("session.extensionCost", { name })}${models.label}${historical ? ` · ${historical}` : ""}${pending ? ` · ${pending}` : ""}`,
       value: formatCostSummary(summary, extensionPresentation.onlySuggesterPending),
       title: [models.title, historical, extensionPresentation.recordedOnly ? translate("session.costPartialHint") : ""].filter(Boolean).join("\n") || undefined,
       models: models.models,
     };
   });
   const pluginCostDetails = [
     ...(sessionStats.compactionCost ? [compactionCostRow] : []),
     ...(sessionStats.recapCost ? [recapCostRow] : []),
     ...extensionCostRows,
   ];
   const pluginCostSummary = mergeSessionCostSummaries([
     sessionStats.compactionCost,
     sessionStats.recapCost,
     ...extensionCosts,
   ]);
   const pluginCostModels = formatCostModels(pluginCostSummary ?? undefined);
   const pluginPresentation = sessionCostPresentation(pluginCostSummary, extensionCosts);
   const pluginOnlySuggesterPending = pluginPresentation.onlySuggesterPending
     && [sessionStats.compactionCost, sessionStats.recapCost].every((summary) => !summary || summary.status === "calculated");
   const pluginUnknownOnly = pluginOnlySuggesterPending && pluginCostSummary?.amount === 0
     && extensionCosts.some((summary) => summary.id === "pi-prompt-suggester" && summary.amount === null);
   const pluginCostRow: SessionCostDetailRow | null = pluginCostSummary ? {
     key: "plugin",
     label: translate("session.pluginCost"),
     value: pluginUnknownOnly ? "—" : formatCostSummary(pluginCostSummary, pluginOnlySuggesterPending),
     title: [pluginCostModels.title, pluginPresentation.recordedOnly ? translate("session.costPartialHint") : ""].filter(Boolean).join("\n") || undefined,
     models: pluginCostModels.models,
     details: pluginCostDetails,
   } : null;
   const costDetailRows: SessionCostDetailRow[] = [
     { key: "parent", label: `${translate("session.parentCost")}${parentCostModels.label}`, value: formatCostSummary(sessionStats.parentCost, parentOnlySuggesterPending), title: parentCostModels.title, models: parentCostModels.models },
     ...(childSessionCount > 0 ? [{ key: "child", label: `${childCostLabel}${childCostModels.label}`, value: formatCostSummary(sessionStats.childCost, childOnlySuggesterPending), title: childCostModels.title, models: childCostModels.models }] : []),
     ...(pluginCostRow ? [pluginCostRow] : []),
   ];
  const costTotalRow = {
    label: translate("session.totalCost"),
    value: formatCostSummary(sessionStats.totalCost, presentation.onlySuggesterPending),
    title: [totalCostModels.title, presentation.recordedOnly ? translate("session.costPartialHint") : ""].filter(Boolean).join("\n") || undefined,
  };
  const renderCostDetailRow = (row: SessionCostDetailRow): ReactNode => {
    const hasMultipleModels = row.models.length > 1;
    const hasDetails = (row.details?.length ?? 0) > 0;
    const isExpandable = hasDetails || hasMultipleModels;
    const isExpanded = Boolean(expandedCostModels[row.key]);
    return (
      <Fragment key={`cost:${row.key}`}>
        <div style={{ display: "contents" }}>
          {isExpandable ? (
            <button
              type="button"
              onClick={() => toggleCostModels(row.key)}
              aria-expanded={isExpanded}
              title={row.title}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                margin: 0,
                font: "inherit",
                color: isExpanded ? "var(--text)" : "var(--text-dim)",
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                cursor: "pointer",
                textAlign: "left",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                minWidth: 0,
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{row.label}</span>
              <span aria-hidden="true" style={{
                fontSize: 10,
                color: isExpanded ? "var(--accent)" : "var(--text-muted)",
                flexShrink: 0,
              }}>
                {isExpanded ? "▾" : "▸"}
              </span>
            </button>
          ) : (
            <div
              title={row.title}
              style={{
                color: "var(--text-dim)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                minWidth: 0,
              }}
            >{row.label}</div>
          )}
          <div style={{
            color: "var(--text-muted)",
            textAlign: "right",
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}>{row.value}</div>
        </div>
        {isExpanded && hasDetails && (
          <div style={{
            gridColumn: "1 / -1",
            margin: "2px 0 4px",
            padding: "5px 8px",
            borderRadius: 4,
            background: "var(--bg-hover)",
            border: "1px solid var(--border)",
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto",
            columnGap: 10,
            rowGap: 3,
          }}>
            {row.details?.map(renderCostDetailRow)}
          </div>
        )}
        {isExpanded && !hasDetails && hasMultipleModels && (
          <div style={{
            gridColumn: "1 / -1",
            margin: "2px 0 4px",
            padding: "5px 8px",
            borderRadius: 4,
            background: "var(--bg-hover)",
            border: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}>
            {row.models.map((model) => (
              <div
                key={model}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10.5,
                  color: "var(--text)",
                  lineHeight: 1.4,
                  overflowWrap: "anywhere",
                }}
              >
                • {model}
              </div>
            ))}
          </div>
        )}
      </Fragment>
    );
  };


  return (
    <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text)" }}>{translate("session.tokens")}</div>
          {ctx?.contextWindow ? (
            <span style={{ fontSize: 11, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
              <span style={{ color: "var(--text-dim)", marginRight: 4 }}>{translate("session.context")}</span>
              <span style={{ color: (ctx.percent ?? 0) > 85 ? "var(--error, #ef4444)" : (ctx.percent ?? 0) > 65 ? "var(--warning, #f59e0b)" : "var(--accent, #3b82f6)", fontWeight: 500 }}>
                {ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?"}
              </span>
              {" / "}
              {formatCompact(ctx.contextWindow)}
            </span>
          ) : null}
        </div>
        {sessionStats.statsSource === "reader-file" && (
          <div data-session-stats-source="reader-file" data-session-stats-scope={statsScope} style={{ color: "var(--text-dim)", fontSize: 10, marginBottom: 6 }}>
            {statsScope}
          </div>
        )}
        {ctx?.contextWindow ? (
          <div style={{
            height: 4,
            background: "var(--border)",
            borderRadius: 2,
            overflow: "hidden",
            marginBottom: 8,
          }}>
            <div style={{
              width: `${Math.min(100, Math.max(0, ctx.percent ?? 0))}%`,
              height: "100%",
              background: (ctx.percent ?? 0) > 85
                ? "var(--error, #ef4444)"
                : (ctx.percent ?? 0) > 65
                  ? "var(--warning, #f59e0b)"
                  : "var(--accent, #3b82f6)",
              borderRadius: 2,
              transition: "width 0.2s ease",
            }} />
          </div>
        ) : null}
        <div style={{
          display: "grid",
          gridTemplateColumns: "auto minmax(0, 1fr)",
          columnGap: 14,
          rowGap: 4,
          alignItems: "center",
        }}>
          {tokenDetailRows.map((row) => (
            <div key={`token:${row.label}`} style={{ display: "contents" }}>
              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.labelNode ?? row.label}</div>
              <div
                title={`${row.raw.toLocaleString(locale)} tokens`}
                style={{
                  color: "var(--text-muted)",
                  textAlign: "right",
                  fontVariantNumeric: "tabular-nums",
                  whiteSpace: "nowrap",
                }}
              >{row.value}</div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>{translate("session.cost")}</div>
        <div style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) auto",
          columnGap: 14,
          rowGap: 4,
          alignItems: "center",
        }}>
          {costDetailRows.map(renderCostDetailRow)}
          <div style={{ display: "contents" }}>
            <div
              title={costTotalRow.title}
              style={{
                color: "var(--text-muted)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                minWidth: 0,
              }}
            >{costTotalRow.label}</div>
            <div style={{
              color: costCalculated ? sessionCostColor(sessionStats.cost) : "var(--text-muted)",
              fontWeight: costCalculated ? 600 : 400,
              textAlign: "right",
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}>{costTotalRow.value}</div>
          </div>
          {missingPriceModels.length > 0 && (
            <div style={{
              gridColumn: "1 / -1",
              marginTop: 4,
              padding: "3px 6px",
              borderRadius: 4,
              background: "var(--bg-hover)",
              fontSize: 10,
              color: "var(--text-dim)",
              lineHeight: 1.4,
              overflowWrap: "anywhere",
            }}>
              <span style={{ color: "var(--warning, #f59e0b)", marginRight: 4 }}>⚠</span>
              {sessionStats.costStatus === "partial"
                ? missingPriceModels.join(", ")
                : `${translate("session.unpricedModels")}: ${missingPriceModels.join(", ")}`}
            </div>
          )}
        </div>
      </div>

      <div title={timingTitle}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>
          {translate("session.timing")}
        </div>
        <div style={{
          display: "grid",
          gridTemplateColumns: "auto minmax(0, 1fr)",
          columnGap: 14,
          rowGap: 4,
          alignItems: "center",
        }}>
          <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{translate("session.effectiveDuration")}</div>
          <div title={timingTitle} style={{ color: "var(--text-muted)", textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{effectiveDurationValue}</div>
          <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>
            {translate("session.agentTotalDuration")}
            {timingChildCount > 0 ? (
              <span style={{ color: "var(--text-muted)", marginLeft: 4, fontSize: 10 }}>({timingChildCount})</span>
            ) : null}
          </div>
          <div title={timingTitle} style={{ color: "var(--text-muted)", textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{agentTotalValue}</div>
          <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{translate("session.modelResponseTotal")}</div>
          <div title={timingTitle} style={{ color: "var(--text-muted)", textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
            {modelResponseValue}
            {timingPartial ? (
              <span style={{ color: "var(--text-dim)", marginLeft: 4, fontSize: 10 }}>{translate("session.timingPartial")}</span>
            ) : null}
          </div>
          <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{translate("session.modelResponseShare")}</div>
          <div title={timingTitle} style={{ color: "var(--accent)", textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{modelResponseShareValue}</div>
        </div>
      </div>
    </div>
  );
}
