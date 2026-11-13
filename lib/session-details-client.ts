"use client";

import { apiPathForPeer } from "./file-api.ts";
import type { SessionHoverPreview } from "./session-hover-preview.ts";
import type { CompactionContextInfo, ContextUsage, ExtensionCostSummary, SessionCostSummary, SessionUsageTotals } from "./pi-types.ts";
import type { SessionCompactionCost } from "./session-cost.ts";
import { sessionCacheHitRate } from "./session-cost.ts";
import { readImageGenerationCosts, type ImageGenerationCost } from "./image-generation-cost.ts";

export type SessionCostStatus = SessionCostSummary["status"];

export interface SessionCostDetails {
  amount: number | null;
  currency: string;
  status: SessionCostStatus;
  parentCost: SessionCostSummary;
  childCost: SessionCostSummary;
  mainCost: SessionCostSummary;
  compactionCost?: SessionCostSummary;
  recapCost: SessionCostSummary;
  extensionCosts?: ExtensionCostSummary[];
  totalCost: SessionCostSummary;
  messageCosts: Record<string, number>;
  imageGenerationCosts: ImageGenerationCost[];
  missingPriceModels: string[];
  pendingUsageCount: number;
  pendingUsageModels: string[];
  usage: SessionUsageTotals | null;
  compactionCosts: Record<string, SessionCompactionCost>;
  compactionContexts: Record<string, CompactionContextInfo>;
  cacheHitRate: number | null;
  recapCacheHitRate: number | null;
  contextUsage?: ContextUsage | null;
}

export interface SessionDetailsSnapshot {
  cost?: SessionCostDetails | null;
  /** Distinguishes a cost still in flight from an unavailable result. */
  costState?: "loading" | "ready" | "error";
  preview?: SessionHoverPreview | null;
  userQuestions?: string[];
}

export interface SessionDetailsRequest {
  sessionId: string;
  version?: string;
  /** Summary skips transcript context; it must never satisfy a full detail read. */
  costView?: "full" | "summary";
  /** Revision of models.json metadata used by context usage responses. */
  modelConfigRevision?: number;
  peer?: string;
  /** Data-owner device id used by the local hover-preview route. */
  deviceId?: string;
}

type SessionDetailsEntry = {
  snapshot: SessionDetailsSnapshot;
  costPromise?: Promise<SessionCostDetails | null>;
  cancelCost?: () => void;
  costConsumers: number;
  previewPromise?: Promise<SessionHoverPreview | null>;
  userQuestionsPromise?: Promise<string[]>;
  previewFetchedAt: number;
  generation: number;
  listeners: Set<() => void>;
};

const PREVIEW_CACHE_TTL_MS = 15_000;
const SUMMARY_REQUEST_LIMIT = 4;
const MAX_ENTRIES = 500;
const EMPTY_SNAPSHOT: SessionDetailsSnapshot = Object.freeze({});
const entries = new Map<string, SessionDetailsEntry>();

type SummaryQueueItem = {
  run: () => Promise<SessionCostDetails>;
  resolve: (value: SessionCostDetails | null) => void;
  reject: (reason: unknown) => void;
  cancelled: boolean;
  onCancel: () => void;
};
const summaryQueue: SummaryQueueItem[] = [];
let activeSummaryRequests = 0;

function drainSummaryQueue(): void {
  while (activeSummaryRequests < SUMMARY_REQUEST_LIMIT && summaryQueue.length > 0) {
    const item = summaryQueue.shift()!;
    if (item.cancelled) continue;
    activeSummaryRequests += 1;
    void item.run().then(item.resolve, item.reject).finally(() => {
      activeSummaryRequests -= 1;
      drainSummaryQueue();
    });
  }
}

function enqueueSummary(run: () => Promise<SessionCostDetails>, onCancel: () => void): { promise: Promise<SessionCostDetails | null>; cancel: () => void } {
  let item: SummaryQueueItem | null = null;
  const promise = new Promise<SessionCostDetails | null>((resolve, reject) => {
    item = { run, resolve, reject, cancelled: false, onCancel };
    summaryQueue.push(item);
  });
  drainSummaryQueue();
  return {
    promise,
    cancel: () => {
      if (!item || item.cancelled) return;
      const queued = summaryQueue.indexOf(item);
      if (queued < 0) return;
      item.cancelled = true;
      summaryQueue.splice(queued, 1);
      item.onCancel();
      item.resolve(null);
    },
  };
}

export function sessionDetailsKey({ sessionId, version = "", peer, deviceId, modelConfigRevision, costView }: SessionDetailsRequest): string {
  const parts = [peer ?? deviceId ?? "local", sessionId, version];
  if (modelConfigRevision !== undefined && modelConfigRevision > 0) parts.push(String(modelConfigRevision));
  if (costView === "summary") parts.push("summary");
  return parts.map((value) => encodeURIComponent(value)).join(":");
}

function entryForKey(key: string): SessionDetailsEntry {
  const existing = entries.get(key);
  if (existing) return existing;
  if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
  const created: SessionDetailsEntry = {
    snapshot: {},
    previewFetchedAt: 0,
    generation: 0,
    costConsumers: 0,
    listeners: new Set(),
  };
  entries.set(key, created);
  return created;
}

function notify(entry: SessionDetailsEntry): void {
  for (const listener of entry.listeners) listener();
}

export function readSessionDetails(key: string): SessionDetailsSnapshot {
  return entries.get(key)?.snapshot ?? EMPTY_SNAPSHOT;
}

export function subscribeSessionDetails(key: string, listener: () => void): () => void {
  const entry = entryForKey(key);
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
}

export function seedSessionDetails(request: SessionDetailsRequest, seed: SessionDetailsSnapshot): void {
  const entry = entryForKey(sessionDetailsKey(request));
  const currentPreview = entry.snapshot.preview;
  const nextPreview = seed.preview
    ? {
        ...(currentPreview ?? {}),
        ...seed.preview,
        ...(currentPreview?.todos ? { todos: currentPreview.todos } : {}),
      }
    : currentPreview;
  entry.snapshot = {
    ...entry.snapshot,
    ...(seed.cost !== undefined ? { cost: seed.cost } : {}),
    ...(nextPreview !== undefined ? { preview: nextPreview } : {}),
  };
  notify(entry);
}

function costUrl(request: SessionDetailsRequest): string {
  const params = new URLSearchParams();
  if (request.costView === "summary") params.set("view", "summary");
  if (!request.peer && request.deviceId) params.set("deviceId", request.deviceId);
  const query = params.toString() ? `?${params.toString()}` : "";
  return apiPathForPeer(request.peer, `sessions/${encodeURIComponent(request.sessionId)}/cost${query}`);
}

function previewUrl(request: SessionDetailsRequest): string {
  const path = `sessions/${encodeURIComponent(request.sessionId)}/hover-preview`;
  if (request.peer) return apiPathForPeer(request.peer, path);
  const base = apiPathForPeer(undefined, path);
  return request.deviceId ? `${base}?deviceId=${encodeURIComponent(request.deviceId)}` : base;
}

function userQuestionUrl(request: SessionDetailsRequest): string {
  const params = new URLSearchParams({ section: "user-question" });
  if (!request.peer && request.deviceId) params.set("deviceId", request.deviceId);
  const path = `sessions/${encodeURIComponent(request.sessionId)}/hover-preview?${params.toString()}`;
  return apiPathForPeer(request.peer, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readModelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((model): model is string => typeof model === "string" && model.trim() !== "")
    .map((model) => model.trim()))].sort();
}

function readCompactionCosts(value: unknown): Record<string, SessionCompactionCost> {
  const result: Record<string, SessionCompactionCost> = {};
  if (!isRecord(value)) return result;
  const tokenFields = ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "totalTokens"] as const;
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw) || !isRecord(raw.usage)) continue;
    const usage = raw.usage;
    if (!tokenFields.every((field) => typeof usage[field] === "number" && Number.isFinite(usage[field]))) continue;
    const amount = raw.amount === null
      ? null
      : typeof raw.amount === "number" && Number.isFinite(raw.amount) ? raw.amount : null;
    result[key] = {
      usage: {
        inputTokens: usage.inputTokens as number,
        cachedInputTokens: usage.cachedInputTokens as number,
        cacheWriteTokens: usage.cacheWriteTokens as number,
        ...(typeof usage.cacheWrite1hTokens === "number" && Number.isFinite(usage.cacheWrite1hTokens)
          ? { cacheWrite1hTokens: usage.cacheWrite1hTokens }
          : {}),
        outputTokens: usage.outputTokens as number,
        reasoningTokens: usage.reasoningTokens as number,
        totalTokens: usage.totalTokens as number,
      },
      amount,
      currency: typeof raw.currency === "string" ? raw.currency : "USD",
      status: raw.status === "calculated" && amount !== null
        ? "calculated"
        : raw.status === "partial" && amount !== null ? "partial" : "unavailable",
      ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    };
  }
  return result;
}

function readUserQuestionsResponse(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.userQuestions)) return [];
  return value.userQuestions.filter((question): question is string => typeof question === "string" && question.trim() !== "").map((question) => question.trim());
}

function readUsageTotals(value: unknown): SessionUsageTotals | null {
  if (!isRecord(value)) return null;
  const tokenFields = ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "totalTokens"] as const;
  if (!tokenFields.every((field) => typeof value[field] === "number" && Number.isFinite(value[field]))) return null;
  return {
    inputTokens: value.inputTokens as number,
    cachedInputTokens: value.cachedInputTokens as number,
    cacheWriteTokens: value.cacheWriteTokens as number,
    outputTokens: value.outputTokens as number,
    reasoningTokens: value.reasoningTokens as number,
    totalTokens: value.totalTokens as number,
  };
}

function emptyCostSummary(): SessionCostSummary {
  return {
    amount: 0,
    currency: "USD",
    status: "calculated",
    usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
    sessionCount: 0,
    models: [],
    missingPriceModels: [],
    pendingUsageCount: 0,
    pendingUsageModels: [],
    unavailableSessions: 0,
  };
}

function readCostSummary(value: unknown): SessionCostSummary | null {
  if (!isRecord(value)) return null;
  const requestedStatus: SessionCostStatus = value.status === "calculated" || value.status === "partial" ? value.status : "unavailable";
  const amount = (requestedStatus === "calculated" || requestedStatus === "partial") && typeof value.amount === "number" && Number.isFinite(value.amount)
    ? value.amount
    : null;
  const status: SessionCostStatus = amount === null ? "unavailable" : requestedStatus;
  const missingPriceModels = Array.isArray(value.missingPriceModels)
    ? value.missingPriceModels.filter((model): model is string => typeof model === "string" && model.length > 0)
    : [];
  const models = readModelNames(value.models);
  const pendingUsageCount = typeof value.pendingUsageCount === "number" && Number.isFinite(value.pendingUsageCount)
    ? Math.max(0, Math.trunc(value.pendingUsageCount)) : 0;
  const pendingUsageModels = readModelNames(value.pendingUsageModels);
  const sessionCount = typeof value.sessionCount === "number" && Number.isFinite(value.sessionCount) ? Math.max(0, Math.trunc(value.sessionCount)) : 0;
  const unavailableSessions = typeof value.unavailableSessions === "number" && Number.isFinite(value.unavailableSessions)
    ? Math.max(0, Math.trunc(value.unavailableSessions))
    : 0;
  return {
    amount,
    currency: typeof value.currency === "string" ? value.currency : "USD",
    status,
    usage: readUsageTotals(value.usage),
    sessionCount,
    models,
    missingPriceModels,
    pendingUsageCount,
    pendingUsageModels,
    unavailableSessions,
  };
}

function legacyCostSummary(body: { amount?: unknown; currency?: unknown; status?: unknown; missingPriceModels?: unknown; pendingUsageCount?: unknown; pendingUsageModels?: unknown; models?: unknown; usage?: unknown }): SessionCostSummary {
  const requestedStatus: SessionCostStatus = body.status === "calculated" || body.status === "partial" ? body.status : "unavailable";
  const amount = (requestedStatus === "calculated" || requestedStatus === "partial") && typeof body.amount === "number" && Number.isFinite(body.amount)
    ? body.amount
    : null;
  const status: SessionCostStatus = amount === null ? "unavailable" : requestedStatus;
  const models = readModelNames(body.models);
  return {
    amount,
    currency: typeof body.currency === "string" ? body.currency : "USD",
    status,
    usage: readUsageTotals(body.usage),
    sessionCount: 1,
    models,
    missingPriceModels: Array.isArray(body.missingPriceModels)
      ? body.missingPriceModels.filter((model): model is string => typeof model === "string" && model.length > 0)
      : [],
    pendingUsageCount: typeof body.pendingUsageCount === "number" && Number.isFinite(body.pendingUsageCount)
      ? Math.max(0, Math.trunc(body.pendingUsageCount)) : 0,
    pendingUsageModels: readModelNames(body.pendingUsageModels),
    unavailableSessions: 0,
  };
}
function readContextUsage(value: unknown): ContextUsage | null {
  if (!isRecord(value) || typeof value.contextWindow !== "number" || !Number.isFinite(value.contextWindow) || value.contextWindow <= 0) {
    return null;
  }
  const percent = value.percent === null
    ? null
    : typeof value.percent === "number" && Number.isFinite(value.percent) ? value.percent : null;
  const tokens = value.tokens === null
    ? null
    : typeof value.tokens === "number" && Number.isFinite(value.tokens) ? value.tokens : null;
  return { percent, contextWindow: value.contextWindow, tokens };
}
function readCompactionContexts(value: unknown): Record<string, CompactionContextInfo> {
  const result: Record<string, CompactionContextInfo> = {};
  if (!isRecord(value)) return result;
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw) || typeof raw.tokensBefore !== "number" || !Number.isFinite(raw.tokensBefore) || raw.tokensBefore < 0) continue;
    const contextWindow = raw.contextWindow === null
      ? null
      : typeof raw.contextWindow === "number" && Number.isFinite(raw.contextWindow) && raw.contextWindow > 0
        ? raw.contextWindow
        : null;
    const provider = typeof raw.provider === "string" && raw.provider.trim() ? raw.provider : undefined;
    const model = typeof raw.model === "string" && raw.model.trim() ? raw.model : undefined;
    result[key] = {
      tokensBefore: raw.tokensBefore,
      contextWindow,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    };
  }
  return result;
}

function readCostResponse(body: {
  amount?: unknown;
  currency?: unknown;
  status?: unknown;
  messageCosts?: unknown;
  imageGenerationCosts?: unknown;
  missingPriceModels?: unknown;
  pendingUsageCount?: unknown;
  pendingUsageModels?: unknown;
  usage?: unknown;
  compactionCosts?: unknown;
  compactionContexts?: unknown;
  contextUsage?: unknown;
  parentCost?: unknown;
  childCost?: unknown;
  mainCost?: unknown;
  compactionCost?: unknown;
  recapCost?: unknown;
  extensionCosts?: unknown;
  totalCost?: unknown;
}): SessionCostDetails {
  const legacy = legacyCostSummary(body);
  const parentCost = readCostSummary(body.parentCost) ?? legacy;
  const childCost = readCostSummary(body.childCost) ?? emptyCostSummary();
  const mainCost = readCostSummary(body.mainCost) ?? parentCost;
  const compactionCost = readCostSummary(body.compactionCost);
  const recapCost = readCostSummary(body.recapCost) ?? emptyCostSummary();
  const extensionCosts: ExtensionCostSummary[] = Array.isArray(body.extensionCosts) ? body.extensionCosts.flatMap((value) => {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) return [];
    const summary = readCostSummary(value);
    return summary ? [{ ...summary, id: value.id.trim(), historicalIncomplete: value.historicalIncomplete === true,
      historicalEstimated: value.historicalEstimated === true }] : [];
  }) : [];
  const totalCost = readCostSummary(body.totalCost) ?? legacy;
  return {
    amount: totalCost.amount,
    currency: totalCost.currency,
    status: totalCost.status,
    messageCosts: body.messageCosts && typeof body.messageCosts === "object" && !Array.isArray(body.messageCosts)
      ? body.messageCosts as Record<string, number>
      : {},
    imageGenerationCosts: readImageGenerationCosts(body.imageGenerationCosts),
    compactionCosts: readCompactionCosts(body.compactionCosts),
    compactionContexts: readCompactionContexts(body.compactionContexts),
    missingPriceModels: totalCost.missingPriceModels,
    pendingUsageCount: totalCost.pendingUsageCount,
    pendingUsageModels: totalCost.pendingUsageModels,
    usage: mainCost.usage,
    cacheHitRate: mainCost.usage
      ? sessionCacheHitRate(mainCost.usage.inputTokens, mainCost.usage.cachedInputTokens, mainCost.usage.cacheWriteTokens)
      : null,
    recapCacheHitRate: recapCost.usage
      ? sessionCacheHitRate(recapCost.usage.inputTokens, recapCost.usage.cachedInputTokens, recapCost.usage.cacheWriteTokens)
      : null,
    contextUsage: readContextUsage(body.contextUsage),
    parentCost,
    childCost,
    mainCost,
    ...(compactionCost ? { compactionCost } : {}),
    recapCost,
    extensionCosts,
    totalCost,
  };
}

export function ensureSessionCost(request: SessionDetailsRequest): Promise<SessionCostDetails | null> {
  const key = sessionDetailsKey(request);
  const entry = entryForKey(key);
  if (entry.snapshot.cost !== undefined && entry.snapshot.costState !== "error") return Promise.resolve(entry.snapshot.cost);
  if (entry.costPromise) return entry.costPromise;

  const generation = entry.generation;
  let cancelled = false;
  const fetchCost = async (): Promise<SessionCostDetails> => {
    const response = await fetch(costUrl(request), { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return readCostResponse(body);
  };
  entry.snapshot = { ...entry.snapshot, costState: "loading" };
  notify(entry);
  const scheduled = request.costView === "summary"
    ? enqueueSummary(fetchCost, () => { cancelled = true; })
    : { promise: fetchCost(), cancel: () => { cancelled = true; } };
  entry.cancelCost = scheduled.cancel;
  let failed = false;
  const pending = scheduled.promise
    .catch(() => {
      failed = true;
      return null;
    })
    .then((cost) => {
      if (!cancelled && entries.get(key) === entry && entry.generation === generation) {
        entry.snapshot = { ...entry.snapshot, cost, costState: failed ? "error" : "ready" };
        notify(entry);
      }
      return cost;
    })
    .finally(() => {
      if (entry.costPromise === pending) {
        entry.costPromise = undefined;
        entry.cancelCost = undefined;
      }
    });
  entry.costPromise = pending;
  return pending;
}

export function retainSessionCost(request: SessionDetailsRequest): void {
  const entry = entryForKey(sessionDetailsKey(request));
  entry.costConsumers += 1;
}

export function releaseSessionCost(request: SessionDetailsRequest): void {
  const entry = entries.get(sessionDetailsKey(request));
  if (!entry) return;
  entry.costConsumers = Math.max(0, entry.costConsumers - 1);
  if (entry.costConsumers === 0) entry.cancelCost?.();
}

/** Cancel a queued summary only when no mounted consumer still needs it. */
export function cancelSessionCost(request: SessionDetailsRequest): void {
  const entry = entries.get(sessionDetailsKey(request));
  if (entry?.costConsumers === 0) entry.cancelCost?.();
}

export function ensureSessionPreview(request: SessionDetailsRequest): Promise<SessionHoverPreview | null> {
  const key = sessionDetailsKey(request);
  const entry = entryForKey(key);
  if (entry.previewPromise) return entry.previewPromise;
  if (entry.snapshot.preview !== undefined && entry.previewFetchedAt > 0 && Date.now() - entry.previewFetchedAt < PREVIEW_CACHE_TTL_MS) {
    return Promise.resolve(entry.snapshot.preview);
  }

  const generation = entry.generation;
  const pending = fetch(previewUrl(request), { cache: "no-store" })
    .then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return body as SessionHoverPreview;
    })
    .catch(() => null)
    .then((preview) => {
      if (entries.get(key) === entry && entry.generation === generation) {
        entry.snapshot = { ...entry.snapshot, preview };
        entry.previewFetchedAt = Date.now();
        notify(entry);
      }
      return preview;
    })
    .finally(() => {
      if (entry.previewPromise === pending) entry.previewPromise = undefined;
    });
  entry.previewPromise = pending;
  return pending;
}

export function ensureSessionUserQuestions(request: SessionDetailsRequest): Promise<string[]> {
  const key = sessionDetailsKey(request);
  const entry = entryForKey(key);
  if (entry.snapshot.userQuestions !== undefined) return Promise.resolve(entry.snapshot.userQuestions);
  if (entry.userQuestionsPromise) return entry.userQuestionsPromise;

  const generation = entry.generation;
  const pending = fetch(userQuestionUrl(request), { cache: "no-store" })
    .then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return readUserQuestionsResponse(body);
    })
    .catch(() => [])
    .then((questions) => {
      if (entries.get(key) === entry && entry.generation === generation) {
        entry.snapshot = { ...entry.snapshot, userQuestions: questions };
        notify(entry);
      }
      return questions;
    })
    .finally(() => {
      if (entry.userQuestionsPromise === pending) entry.userQuestionsPromise = undefined;
    });
  entry.userQuestionsPromise = pending;
  return pending;
}

export function invalidateSessionDetails(request: SessionDetailsRequest): void {
  for (const costView of ["full", "summary"] as const) {
    const key = sessionDetailsKey({ ...request, costView });
    const entry = entries.get(key);
    if (!entry) continue;
    const consumers = entry.costConsumers;
    entry.cancelCost?.();
    entry.generation += 1;
    entry.snapshot = {};
    entry.previewFetchedAt = 0;
    entry.costPromise = undefined;
    entry.cancelCost = undefined;
    entry.previewPromise = undefined;
    entry.userQuestionsPromise = undefined;
    if (consumers > 0) {
      void ensureSessionCost({ ...request, costView });
    } else {
      notify(entry);
    }
  }
}

export function clearSessionDetailsCache(): void {
  for (const entry of entries.values()) {
    entry.cancelCost?.();
    entry.costConsumers = 0;
  }
  entries.clear();
}

export { EMPTY_SNAPSHOT as emptySessionDetailsSnapshot };
