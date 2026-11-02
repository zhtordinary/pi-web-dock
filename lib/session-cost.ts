import type { ExtensionCostSummary, SessionCostSummary } from "./pi-types";

export function sessionCostColor(cost: number): string {
  if (cost > 10) return "#dc2626";
  return "var(--text-muted)";
}

export function sessionCacheHitRate(inputTokens: number, cachedInputTokens: number, cacheWriteTokens: number): number | null {
  const promptTokens = inputTokens + cachedInputTokens + cacheWriteTokens;
  if (!(cachedInputTokens > 0 || cacheWriteTokens > 0) || promptTokens <= 0) return null;
  return (cachedInputTokens / promptTokens) * 100;
}

export function mergeSessionCostSummaries(
  summaries: readonly (SessionCostSummary | null | undefined)[],
): SessionCostSummary | null {
  const present = summaries.filter((summary): summary is SessionCostSummary => summary !== null && summary !== undefined);
  if (present.length === 0) return null;

  const amounts = present.map((summary) => summary.amount).filter((amount): amount is number => typeof amount === "number" && Number.isFinite(amount));
  const allCalculated = amounts.length === present.length && present.every((summary) => summary.status === "calculated");
  let status: SessionCostSummary["status"];
  if (allCalculated) status = "calculated";
  else if (amounts.length > 0) status = "partial";
  else status = "unavailable";
  return {
    amount: amounts.length > 0 ? amounts.reduce((total, amount) => total + amount, 0) : null,
    currency: present[0]?.currency ?? "USD",
    usage: null,
    status,
    sessionCount: present.reduce((total, summary) => total + summary.sessionCount, 0),
    models: [...new Set(present.flatMap((summary) => summary.models))],
    missingPriceModels: [...new Set(present.flatMap((summary) => summary.missingPriceModels))],
    pendingUsageCount: present.reduce((total, summary) => total + summary.pendingUsageCount, 0),
    pendingUsageModels: [...new Set(present.flatMap((summary) => summary.pendingUsageModels))],
    unavailableSessions: present.reduce((total, summary) => total + summary.unavailableSessions, 0),
  };
}

export interface SessionCompactionUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens?: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export type SessionCompactionCostStatus = "calculated" | "partial" | "unavailable";

export interface SessionCompactionCost {
  usage: SessionCompactionUsage;
  amount: number | null;
  currency: string;
  status: SessionCompactionCostStatus;
  model?: string;
}


export function sessionCostPresentation(
  summary: Pick<SessionCostSummary, "status" | "pendingUsageCount" | "missingPriceModels"> | null | undefined,
  extensions: readonly Pick<ExtensionCostSummary, "id" | "pendingUsageCount">[] = [],
) {
  const total = summary?.pendingUsageCount ?? 0;
  const reported = extensions.reduce((count, item) =>
    count + (item.id === "pi-prompt-suggester" ? item.pendingUsageCount : 0), 0);
  const quiet = reported <= total ? reported : 0;
  const pendingUsageCount = total - quiet;
  return {
    pendingUsageCount,
    recordedOnly: quiet > 0,
    onlySuggesterPending: quiet > 0 && pendingUsageCount === 0 && (summary?.missingPriceModels.length ?? 0) === 0,
  };
}

export function summarizeCompactionCosts(costs: Record<string, SessionCompactionCost>): SessionCostSummary {
  const entries = Object.values(costs);
  const usage = entries.reduce((total, item) => ({
    inputTokens: total.inputTokens + item.usage.inputTokens,
    cachedInputTokens: total.cachedInputTokens + item.usage.cachedInputTokens,
    cacheWriteTokens: total.cacheWriteTokens + item.usage.cacheWriteTokens,
    outputTokens: total.outputTokens + item.usage.outputTokens,
    reasoningTokens: total.reasoningTokens + item.usage.reasoningTokens,
    totalTokens: total.totalTokens + item.usage.totalTokens,
  }), { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 });
  const unavailableSessions = entries.filter((item) =>
    item.status === "unavailable" || typeof item.amount !== "number" || !Number.isFinite(item.amount),
  ).length;
  const available = unavailableSessions === 0;
  const complete = available && entries.every((item) => item.status === "calculated");
  return {
    amount: available ? entries.reduce((sum, item) => sum + (item.amount ?? 0), 0) : null,
    currency: entries[0]?.currency ?? "USD",
    status: !available ? "unavailable" : complete ? "calculated" : "partial",
    usage,
    sessionCount: entries.length,
    models: [...new Set(entries.map((item) => item.model?.trim()).filter((model): model is string => Boolean(model)))].sort(),
    missingPriceModels: complete ? [] : [...new Set(entries.filter((item) => item.status !== "calculated").map((item) => item.model).filter((model): model is string => Boolean(model)))],
    pendingUsageCount: 0,
    pendingUsageModels: [],
    unavailableSessions,
  };
}
