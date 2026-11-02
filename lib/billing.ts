import { createReadStream, existsSync, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { readCompactionModel } from "./compaction-model";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionCostSummary, SessionCostSummary, SessionUsageTotals } from "./pi-types";
import { discoverLegacyExtensionUsage, extensionAccountingRevision, EXTENSION_USAGE_ENTRY, readExtensionAccounting } from "./extension-usage-accounting";
import type { SessionCompactionCost } from "./session-cost";
import { isSessionRecapUsageEntry } from "./session-recap";
import { imageGenerationOutputFromTask, imageGenerationOutputFromTool, readImageGenerationBilling, readImageGenerationOutput, readProviderCharge, providerCharge, type ImageGenerationBilling, type ImageGenerationCost, type ImageGenerationOutput, type ProviderCharge } from "./image-generation-cost";
import { officialImageOutputTokenEstimate, officialImageProviderForModel } from "./official-image-pricing";

const execFileAsync = promisify(execFile);
const PRICE_DATA_CACHE_TTL_MS = 60 * 60 * 1000;
const PRICE_BATCH_SIZE = 128;
const GATEWAY_PROVIDER_MARKERS = ["cpa", "sub2api", "cli-proxy-api", "cliproxy", "proxy-api"];
const UNVERIFIED_GATEWAY_TIERS = new Set(["priority", "fast", "flex", "ultrafast"]);

export interface BillingUsageInput {
  model: string;
  serviceTier?: string;
  provider?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens?: number;
  /** Image counts are subsets of input/output, not extra tokens. */
  inputImage?: number;
  outputImage?: number;
  usageAvailable?: boolean;
  providerCharge?: ProviderCharge;
  timestamp?: string;
}

export interface ReaderUsageRecord {
  entryType: string;
  entryId: string;
  sessionId: string;
  timestamp: string;
  provider: string;
  model: string;
  usage: BillingUsageInput;
  serviceTier?: string;
  usageEventId?: string;
  sourceSessionId?: string;
  sourceEntryId?: string;
  usageKind?: "main" | "recap" | "compaction" | "extension";
  extensionId?: string;
  extensionCallKind?: string;
  historicalIncomplete?: boolean;
  historicalEstimated?: boolean;
  imageBilling?: ImageGenerationBilling;
  imageOutputs?: ImageGenerationOutput[];
}

function officialImageEstimateInput(record: ReaderUsageRecord): BillingUsageInput | undefined {
  const billing = record.imageBilling;
  if (!billing || record.usage.providerCharge) return undefined;
  if (!officialImageProviderForModel(record.provider, record.model)) return undefined;
  const outputImage = officialImageOutputTokenEstimate(record.model, billing.resolution, billing.returnedImages ?? billing.requestedImages ?? 1);
  if (outputImage === undefined) return undefined;
  return {
    model: record.model,
    provider: record.provider,
    input: 0,
    output: outputImage,
    inputImage: 0,
    outputImage,
    totalTokens: outputImage,
    usageAvailable: true,
    timestamp: record.usage.timestamp ?? new Date(billing.startedAt).toISOString(),
  };
}

function normalizeBillingTimestamp(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : "";
  }
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const date = new Date(Number(trimmed));
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return trimmed;
}

function parsedUsageEvent(value: unknown): Pick<ReaderUsageRecord, "usageEventId" | "sourceSessionId" | "sourceEntryId"> {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== "string" || !value.id.trim()
      || !["origin", "copy", "replace"].includes(String(value.relation))) return {};
  return {
    usageEventId: value.id.trim(),
    ...(typeof value.sourceSessionId === "string" && value.sourceSessionId.trim() ? { sourceSessionId: value.sourceSessionId.trim() } : {}),
    ...(typeof value.sourceEntryId === "string" && value.sourceEntryId.trim() ? { sourceEntryId: value.sourceEntryId.trim() } : {}),
  };
}

function usageVector(record: ReaderUsageRecord): string {
  const usage = record.usage;
  return [
    nonNegativeInteger(usage.input),
    nonNegativeInteger(usage.output),
    nonNegativeInteger(usage.cacheRead),
    nonNegativeInteger(usage.cacheWrite),
    nonNegativeInteger(usage.cacheWrite1h),
    nonNegativeInteger(usage.reasoning),
    nonNegativeInteger(usage.inputImage),
    nonNegativeInteger(usage.outputImage),
    usage.usageAvailable === false ? "unknown" : "known",
    typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)
      ? nonNegativeInteger(usage.totalTokens)
      : usageFromInput(usage).totalTokens,
  ].join(",");
}

/** Strong local identity for Reader's persisted provider-request usage rows. */
export function readerUsageRecordIdentityKeys(record: ReaderUsageRecord): string[] {
  if (record.usageEventId) return [`usage-event\u0000${record.usageEventId}`];
  if (!record.entryId || !record.timestamp || !Number.isFinite(Date.parse(record.timestamp))) return [];
  return [JSON.stringify([record.entryType, record.entryId, record.timestamp, record.provider,
    record.model, record.serviceTier ?? "", usageVector(record)])];
}

/** Resolve only explicit source addresses, then share identities across every nested child. */
export function uniqueReaderUsageRecordGroups(groups: readonly ReaderUsageRecord[][]): ReaderUsageRecord[][] {
  const settled = new Map<string, ReaderUsageRecord>();
  const extensionSettled = new Map<string, ReaderUsageRecord>();
  for (const record of groups.flat()) {
    if (record.imageBilling && record.usageEventId && record.usage.providerCharge) settled.set(record.usageEventId, record);
    if (record.usageKind !== "extension" || !record.usageEventId || record.usage.usageAvailable === false) continue;
    const previous = extensionSettled.get(record.usageEventId);
    if (previous && (previous.provider !== record.provider || previous.model !== record.model || previous.serviceTier !== record.serviceTier
        || previous.timestamp !== record.timestamp || usageVector(previous) !== usageVector(record))) {
      extensionSettled.set(record.usageEventId, { ...previous, usage: { ...previous.usage, usageAvailable: false } });
    } else if (!previous) extensionSettled.set(record.usageEventId, record);
  }
  const updatedGroups = groups.map((group) => group.map((record) => {
    const extension = record.usageEventId && record.usageKind === "extension" ? extensionSettled.get(record.usageEventId) : undefined;
    if (extension) return { ...record, provider: extension.provider, model: extension.model, serviceTier: extension.serviceTier, timestamp: extension.timestamp, usage: extension.usage };
    const charged = record.usageEventId ? settled.get(record.usageEventId) : undefined;
    if (!charged || !record.imageBilling || record.provider !== charged.provider || record.model !== charged.model
        || record.imageBilling.taskId !== charged.imageBilling?.taskId || record.imageBilling.requestId !== charged.imageBilling?.requestId) return record;
    return { ...record, usage: charged.usage, imageBilling: {
      ...charged.imageBilling!, toolCallId: record.imageBilling.toolCallId ?? charged.imageBilling?.toolCallId,
    } };
  }));
  const records = updatedGroups.flat();
  const address = (record: ReaderUsageRecord) => JSON.stringify([record.sessionId, record.entryId]);
  const aliases = new Map<string, Set<string>>();
  const sources = new Map<string, ReaderUsageRecord[]>();
  for (const record of records) {
    if (record.entryId) sources.set(address(record), [...(sources.get(address(record)) ?? []), record]);
  }
  for (const record of records) {
    if (!record.usageEventId || !record.sourceSessionId || !record.sourceEntryId) continue;
    const sourceRecords = sources.get(JSON.stringify([record.sourceSessionId, record.sourceEntryId])) ?? [];
    const sourceKeys = new Set(sourceRecords.flatMap(readerUsageRecordIdentityKeys));
    if (sourceKeys.size !== 1) continue; // Ambiguous address is not permission to merge requests.
    const key = [...sourceKeys][0];
    const ids = aliases.get(key) ?? new Set<string>();
    ids.add(`usage-event\u0000${record.usageEventId}`);
    aliases.set(key, ids);
  }
  const seen = new Set<string>();
  return updatedGroups.map((group) => group.filter((record) => {
    const keys = readerUsageRecordIdentityKeys(record).map((key) => {
      const ids = aliases.get(key);
      return !record.usageEventId && ids?.size === 1 ? [...ids][0] : key;
    });
    const duplicate = keys.some((key) => seen.has(key));
    for (const key of keys) seen.add(key);
    return !duplicate;
  }));
}

export interface BillingUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning: number;
  totalTokens: number;
  inputImage?: number;
  outputImage?: number;
  usageAvailable?: boolean;
}

export interface BillingCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface BillingPricing {
  configured: boolean;
  imageTokenPricing?: boolean;
  lowerBound?: boolean;
  currency?: string;
  priceTableId?: string;
  priceTableVersion?: number;
  priceTableUpdatedAt?: string;
  contextTier?: string;
  source?: string;
  priceTableStatus?: string;
  priceEngine?: string;
  priceEngineVersion?: string;
  priceDataRevision?: string;
  cacheReadPricingAvailable?: boolean;
  cacheWritePricingAvailable?: boolean;
  cacheWrite5mPerMillion?: number;
  cacheWrite1hPerMillion?: number;
}

export interface PricedBillingUsage {
  usage: BillingUsage;
  cost?: BillingCost;
  pricing: BillingPricing;
}

export interface SessionCostResult {
  scope?: string;
  cost?: {
    amount?: number | null;
    currency?: string;
    status?: string;
  };
  missingPriceModels?: string[];
  pendingUsageCount?: number;
  pendingUsageModels?: string[];
  costByModel?: Record<string, { cost?: number | null }>;
  messageCosts?: Record<string, number>;
  imageGenerationCosts?: ImageGenerationCost[];
  usage?: SessionUsageTotals | null;
  compactionCosts?: Record<string, SessionCompactionCost>;
  compactionCost?: SessionCostSummary;
  parentCost?: SessionCostSummary;
  childCost?: SessionCostSummary;
  mainCost?: SessionCostSummary;
  recapCost?: SessionCostSummary;
  extensionCosts?: ExtensionCostSummary[];
  totalCost?: SessionCostSummary;
}

// Pricing stays in shared pi-sync-maintenance: genai-prices owns provider/model
// matching, rates, time rules, cache rules, and arithmetic. This module is the
// single Reader adapter for every token-priced feature; it has no local formula.
const PRICE_ADAPTER = String.raw`
import importlib.util
import json
import sys

script_path = sys.argv[1]
payload = json.loads(sys.argv[2])
spec = importlib.util.spec_from_file_location("pi_session_cost", script_path)
if spec is None or spec.loader is None:
    raise RuntimeError("cannot load session cost script")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def normalize(item):
    cache_write = max(0, int(item.get("cacheWrite", 0) or 0))
    return {
        "input": max(0, int(item.get("input", 0) or 0)),
        "output": max(0, int(item.get("output", 0) or 0)),
        "cacheRead": max(0, int(item.get("cacheRead", 0) or 0)),
        "cacheWrite": cache_write,
        "cacheWrite1h": min(max(0, int(item.get("cacheWrite1h", 0) or 0)), cache_write),
        "reasoning": max(0, int(item.get("reasoning", 0) or 0)),
        **({key: item[key] for key in ("inputImage", "outputImage", "usageAvailable", "totalTokens") if key in item}),
    }

def price(item, priced):
    usage = normalize(item)
    tier = item.get("serviceTier", "")
    if priced is None or (tier and (priced.get("rates") or {}).get("serviceTier") != tier):
        return {
            "usage": usage,
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
            "pricing": {"configured": False, "lowerBound": True},
        }
    return {
        "usage": usage,
        "cost": priced.get("cost"),
        "pricing": {"configured": True, **(priced.get("rates") or {})},
    }

price_fn = getattr(module, "price_usages", None)
if price_fn is None:
    raise RuntimeError("session_cost.py has no batched genai-prices entry point")
priced_rows = price_fn([{**item, "usage": normalize(item)} for item in payload])
if not isinstance(priced_rows, list) or len(priced_rows) != len(payload):
    raise RuntimeError("session_cost.py returned an invalid batched pricing result")
print(json.dumps([price(item, priced) for item, priced in zip(payload, priced_rows)]))
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function imageUsageFields(value: { input?: unknown; output?: unknown; inputImage?: unknown; outputImage?: unknown; usageAvailable?: unknown }, imageRequired = false): Pick<BillingUsageInput, "inputImage" | "outputImage" | "usageAvailable"> {
  if (!imageRequired && value.inputImage === undefined && value.outputImage === undefined) {
    return value.usageAvailable === undefined ? {} : { usageAvailable: value.usageAvailable === true };
  }
  const valid = [value.inputImage, value.outputImage].every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
    && (value.inputImage as number) <= nonNegativeInteger(value.input)
    && (value.outputImage as number) <= nonNegativeInteger(value.output);
  return { inputImage: nonNegativeInteger(value.inputImage), outputImage: nonNegativeInteger(value.outputImage),
    usageAvailable: valid && (value.usageAvailable === undefined || value.usageAvailable === true) };
}

function normalizeInput(input: BillingUsageInput): BillingUsageInput {
  return {
    model: input.model.trim() || "unknown",
    ...(input.provider?.trim() ? { provider: input.provider.trim() } : {}),
    ...(input.serviceTier?.trim() ? { serviceTier: input.serviceTier.trim().toLowerCase() } : {}),
    input: nonNegativeInteger(input.input),
    output: nonNegativeInteger(input.output),
    cacheRead: nonNegativeInteger(input.cacheRead),
    cacheWrite: nonNegativeInteger(input.cacheWrite),
    cacheWrite1h: Math.min(nonNegativeInteger(input.cacheWrite1h), nonNegativeInteger(input.cacheWrite)),
    reasoning: nonNegativeInteger(input.reasoning),
    ...(typeof input.totalTokens === "number" && Number.isFinite(input.totalTokens)
      ? { totalTokens: nonNegativeInteger(input.totalTokens) }
      : {}),
    ...imageUsageFields(input),
    ...(readProviderCharge(input.providerCharge) ? { providerCharge: readProviderCharge(input.providerCharge) } : {}),
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
  };
}

function usageFromInput(input: BillingUsageInput): BillingUsage {
  const usage = {
    ...imageUsageFields(input),
    input: nonNegativeInteger(input.input),
    output: nonNegativeInteger(input.output),
    cacheRead: nonNegativeInteger(input.cacheRead),
    cacheWrite: nonNegativeInteger(input.cacheWrite),
    cacheWrite1h: Math.min(nonNegativeInteger(input.cacheWrite1h), nonNegativeInteger(input.cacheWrite)),
    reasoning: nonNegativeInteger(input.reasoning),
    totalTokens: typeof input.totalTokens === "number" && Number.isFinite(input.totalTokens)
      ? nonNegativeInteger(input.totalTokens)
      : 0,
  };
  if (typeof input.totalTokens !== "number" || !Number.isFinite(input.totalTokens)) {
    usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  }
  return usage;
}

function unavailablePricing(input: BillingUsageInput): PricedBillingUsage {
  if (input.inputImage !== undefined || input.outputImage !== undefined || input.usageAvailable === false) {
    return { usage: usageFromInput(input), pricing: { configured: false } };
  }
  return {
    usage: usageFromInput(input),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    pricing: { configured: false, lowerBound: true },
  };
}

function parsedPricing(value: unknown): BillingPricing {
  if (!isRecord(value)) return { configured: false };
  return {
    configured: value.configured === true,
    ...(typeof value.imageTokenPricing === "boolean" ? { imageTokenPricing: value.imageTokenPricing } : {}),
    currency: typeof value.currency === "string" ? value.currency : "USD",
    ...(typeof value.priceTableId === "string" ? { priceTableId: value.priceTableId } : {}),
    ...(typeof value.priceTableVersion === "number" ? { priceTableVersion: value.priceTableVersion } : {}),
    ...(typeof value.priceTableUpdatedAt === "string" ? { priceTableUpdatedAt: value.priceTableUpdatedAt } : {}),
    ...(typeof value.contextTier === "string" ? { contextTier: value.contextTier } : {}),
    ...(typeof value.source === "string" ? { source: value.source } : {}),
    ...(typeof value.priceTableStatus === "string" ? { priceTableStatus: value.priceTableStatus } : {}),
    ...(typeof value.priceEngine === "string" ? { priceEngine: value.priceEngine } : {}),
    ...(typeof value.priceEngineVersion === "string" ? { priceEngineVersion: value.priceEngineVersion } : {}),
    ...(typeof value.priceDataRevision === "string" ? { priceDataRevision: value.priceDataRevision } : {}),
    ...(value.lowerBound === true ? { lowerBound: true } : {}),
    ...(typeof value.cacheReadPricingAvailable === "boolean" ? { cacheReadPricingAvailable: value.cacheReadPricingAvailable } : {}),
    ...(typeof value.cacheWritePricingAvailable === "boolean" ? { cacheWritePricingAvailable: value.cacheWritePricingAvailable } : {}),
    ...(typeof value.cacheWrite5mPerMillion === "number" ? { cacheWrite5mPerMillion: value.cacheWrite5mPerMillion } : {}),
    ...(typeof value.cacheWrite1hPerMillion === "number" ? { cacheWrite1hPerMillion: value.cacheWrite1hPerMillion } : {}),
  };
}

function parsedCost(value: unknown): BillingCost | undefined {
  if (!isRecord(value)) return undefined;
  const keys = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
  if (!keys.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]))) return undefined;
  return {
    input: value.input as number,
    output: value.output as number,
    cacheRead: value.cacheRead as number,
    cacheWrite: value.cacheWrite as number,
    total: value.total as number,
  };
}

function parsePricedUsage(value: unknown, input: BillingUsageInput): PricedBillingUsage {
  if (!isRecord(value)) return unavailablePricing(input);
  const pricing = parsedPricing(value.pricing);
  if (input.usageAvailable === false) return unavailablePricing(input);
  if ((input.inputImage !== undefined || input.outputImage !== undefined)
      && (!pricing.configured || pricing.imageTokenPricing !== true)) return unavailablePricing(input);
  const cost = parsedCost(value.cost);
  if (!pricing.configured) {
    return { usage: usageFromInput(input), ...(cost ? { cost } : {}), pricing };
  }
  if (!cost) return { usage: usageFromInput(input), pricing: { ...pricing, configured: false } };
  return { usage: usageFromInput(input), cost, pricing };
}

/** Token estimates remain owned by genai-prices. */
function isGatewayProvider(provider: string | undefined): boolean {
  const normalized = String(provider ?? "").trim().toLowerCase().replace(/_/g, "-");
  return GATEWAY_PROVIDER_MARKERS.some((marker) => normalized.includes(marker));
}

function pricingInput(input: BillingUsageInput): BillingUsageInput {
  const gateway = isGatewayProvider(input.provider);
  const officialProvider = officialImageProviderForModel(input.provider, input.model);
  const pricedInput = officialProvider ? { ...input, provider: officialProvider } : input;
  if (!gateway || !input.serviceTier || !UNVERIFIED_GATEWAY_TIERS.has(input.serviceTier)) return pricedInput;
  // Gateway priority billing has no verified Reader tariff; keep the known API-equivalent base estimate.
  return { ...pricedInput, serviceTier: undefined };
}

async function priceEstimatedTokenUsages(
  inputs: readonly BillingUsageInput[],
  scriptPath = findBillingScript(),
): Promise<PricedBillingUsage[]> {
  const normalized = inputs.map(normalizeInput);
  if (normalized.length === 0) return [];
  if (!scriptPath) return normalized.map(unavailablePricing);

  const result: PricedBillingUsage[] = [];
  for (let offset = 0; offset < normalized.length; offset += PRICE_BATCH_SIZE) {
    const batch = normalized.slice(offset, offset + PRICE_BATCH_SIZE);
    const pricingBatch = batch.map(pricingInput);
    try {
      const { stdout } = await execFileAsync("python3", [
        "-c",
        PRICE_ADAPTER,
        scriptPath,
        JSON.stringify(pricingBatch),
      ], {
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        timeout: 30_000,
        maxBuffer: 256 * 1024,
      });
      const parsed: unknown = JSON.parse(String(stdout).trim());
      if (!Array.isArray(parsed) || parsed.length !== batch.length) {
        result.push(...batch.map(unavailablePricing));
        continue;
      }
      result.push(...batch.map((input, index) => parsePricedUsage(parsed[index], input)));
    } catch (error) {
      console.warn("[pi-web] genai-prices unavailable:", error instanceof Error ? error.message : String(error));
      result.push(...batch.map(unavailablePricing));
    }
  }
  return result;
}

/** Confirmed supplier amounts bypass estimates, even when tokens or the price engine are unavailable. */
export async function priceTokenUsages(inputs: readonly BillingUsageInput[], scriptPath = findBillingScript()): Promise<PricedBillingUsage[]> {
  const normalized = inputs.map(normalizeInput);
  const estimated = await priceEstimatedTokenUsages(normalized.filter((input) => !input.providerCharge && input.usageAvailable !== false), scriptPath);
  let estimateIndex = 0;
  return normalized.map((input) => input.providerCharge ? {
    usage: usageFromInput(input),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: input.providerCharge.amount },
    pricing: { configured: true, currency: "USD", source: input.providerCharge.source, priceEngine: "provider-ledger" },
  } : input.usageAvailable === false ? unavailablePricing(input) : estimated[estimateIndex++]);
}

export async function priceTokenUsage(
  input: BillingUsageInput,
  scriptPath = findBillingScript(),
): Promise<PricedBillingUsage> {
  return (await priceTokenUsages([input], scriptPath))[0];
}

export function findBillingScript(): string | null {
  const home = homedir();
  const candidates = [
    process.env.PI_CONVERSATION_COST_SCRIPT,
    join(home, ".agents", "skills", "pi-sync-maintenance", "scripts", "session_cost.py"),
    join(home, ".pi", "agent", "skills", "pi-sync-maintenance", "scripts", "session_cost.py"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function billingPriceDataCachePath(): string {
  const root = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(root, "pi-sync-maintenance", "genai-prices-v2.json");
}

/**
 * Cache invalidation signal for the shared pricing engine. Include the
 * failure marker and freshness boundary so a calculated result cannot outlive
 * an expired or failed price-data refresh.
 */
export async function billingPriceDataSignature(cacheFile = billingPriceDataCachePath()): Promise<string> {
  const [cache, failure] = await Promise.all([
    stat(cacheFile).catch(() => null),
    stat(`${cacheFile}.fetch-failed`).catch(() => null),
  ]);
  const stale = cache !== null && Date.now() - cache.mtimeMs > PRICE_DATA_CACHE_TTL_MS;
  const cacheSignature = cache ? `${cache.mtimeMs}:${cache.size}` : "missing";
  const failureSignature = failure ? `${failure.mtimeMs}:${failure.size}` : "missing";
  const freshness = cache ? (stale ? "stale" : "fresh") : "missing";
  return `cache=${cacheSignature}|failure=${failureSignature}|freshness=${freshness}`;
}

function childSessionRoot(filePath: string): string | null {
  return filePath.endsWith(".jsonl") ? filePath.slice(0, -".jsonl".length) : null;
}

/**
 * Discover only the persisted child-session tree owned by this parent file.
 * Shared subagent artifacts and sessions elsewhere on disk are intentionally
 * outside this cost relationship.
 */
async function isCanonicalSessionFile(filePath: string): Promise<boolean> {
  const file = await open(filePath, "r").catch(() => null);
  if (!file) return false;
  try {
    const buffer = Buffer.alloc(16 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const text = buffer.toString("utf8", 0, bytesRead);
    const newline = text.indexOf("\n");
    if (newline < 0 && bytesRead === buffer.length) return false;
    const first: unknown = JSON.parse(newline < 0 ? text : text.slice(0, newline));
    return isRecord(first) && first.type === "session" && typeof first.id === "string" && !!first.id.trim();
  } catch {
    return false;
  } finally {
    await file.close();
  }
}

export async function findChildSessionPaths(filePath: string): Promise<string[]> {
  const root = childSessionRoot(filePath);
  if (!root) return [];
  const result: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "subagent-artifacts") continue;
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) await walk(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && await isCanonicalSessionFile(entryPath)) {
        result.push(entryPath);
      }
    }
  };
  await walk(root);
  return result.sort();
}

const SESSION_HEADER_CACHE_LIMIT = 500;
const sessionHeaderCache = new Map<string, { signature: string; id: string; cwd: string }>();

async function sessionHeader(filePath: string, info: Stats): Promise<{ id: string; cwd: string } | undefined> {
  const signature = `${info.dev}\0${info.ino}\0${info.ctimeMs}\0${info.mtimeMs}\0${info.size}`;
  const cached = sessionHeaderCache.get(filePath);
  if (cached?.signature === signature) {
    sessionHeaderCache.delete(filePath);
    sessionHeaderCache.set(filePath, cached);
    return cached;
  }
  const file = await open(filePath, "r").catch(() => null);
  if (!file) return undefined;
  try {
    const buffer = Buffer.alloc(16 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const text = buffer.toString("utf8", 0, bytesRead);
    const newline = text.indexOf("\n");
    if (newline < 0 && bytesRead === buffer.length) return undefined;
    const header: unknown = JSON.parse(newline < 0 ? text : text.slice(0, newline));
    if (!isRecord(header) || header.type !== "session" || typeof header.id !== "string" || !header.id.trim()) return undefined;
    const value = { signature, id: header.id.trim(), cwd: typeof header.cwd === "string" ? header.cwd : "" };
    sessionHeaderCache.delete(filePath);
    sessionHeaderCache.set(filePath, value);
    if (sessionHeaderCache.size > SESSION_HEADER_CACHE_LIMIT) sessionHeaderCache.delete(sessionHeaderCache.keys().next().value!);
    return value;
  } catch { return undefined; }
  finally { await file.close(); }
}

/** Cache revision covering parent content and additions/removals/changes below its child root. */
export async function sessionCostRevision(filePath: string): Promise<string> {
  const root = childSessionRoot(filePath);
  const childPaths = await findChildSessionPaths(filePath);
  const paths = [filePath, ...(root ? [root] : []), ...childPaths];
  const sessions = new Set([filePath, ...childPaths]);
  const signatures: string[] = [];
  const descriptors = discoverLegacyExtensionUsage();
  for (const candidate of paths) {
    try {
      const info = await stat(candidate);
      signatures.push(`${candidate}\u0000${info.dev}\u0000${info.ino}\u0000${info.ctimeMs}\u0000${info.mtimeMs}\u0000${info.size}`);
      if (sessions.has(candidate)) {
        const header = await sessionHeader(candidate, info);
        if (header) signatures.push(await extensionAccountingRevision(header.id, header.cwd, descriptors));
        else signatures.push(`${candidate}\u0000header-unavailable:${randomUUID()}`);
      }
    } catch {
      signatures.push(`${candidate}\u0000missing`);
    }
  }
  return signatures.join("\n");
}

function emptyUsage(): SessionUsageTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function addUsage(left: SessionUsageTotals, right: SessionUsageTotals): SessionUsageTotals {
  const usage = {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    totalTokens: 0,
  };
  usage.totalTokens = usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens + usage.outputTokens;
  return usage;
}

function roundCost(amount: number): number {
  return Math.round(amount * 1e10) / 1e10;
}

function normalizeModelNames(models: readonly string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter((model) => Boolean(model) && model !== "unknown/unknown"))].sort();
}

function summaryForResult(result: SessionCostResult | null, sessionCount: number): SessionCostSummary {
  if (!result) {
    return {
      amount: null,
      currency: "USD",
      status: "unavailable",
      usage: null,
      sessionCount,
      models: [],
      missingPriceModels: [],
      pendingUsageCount: 0,
      pendingUsageModels: [],
      unavailableSessions: 1,
    };
  }
  const rawAmount = result.cost?.amount;
  const amount = typeof rawAmount === "number" && Number.isFinite(rawAmount) ? rawAmount : null;
  const status = result.cost?.status === "calculated" && amount !== null
    ? "calculated"
    : result.cost?.status === "partial" && amount !== null ? "partial" : "unavailable";
  return {
    amount: status === "unavailable" ? null : amount,
    currency: result.cost?.currency ?? "USD",
    status,
    usage: result.usage ?? null,
    sessionCount,
    models: normalizeModelNames(Object.keys(result.costByModel ?? {})),
    missingPriceModels: result.missingPriceModels ?? [],
    pendingUsageCount: result.pendingUsageCount ?? 0,
    pendingUsageModels: result.pendingUsageModels ?? [],
    unavailableSessions: status === "unavailable" ? 1 : 0,
  };
}

function combineCostSummaries(summaries: readonly SessionCostSummary[]): SessionCostSummary {
  if (summaries.length === 0) {
    return {
      amount: 0,
      currency: "USD",
      status: "calculated",
      usage: emptyUsage(),
      sessionCount: 0,
      models: [],
      missingPriceModels: [],
      pendingUsageCount: 0,
      pendingUsageModels: [],
      unavailableSessions: 0,
    };
  }
  const available = summaries.every((summary) =>
    (summary.status === "calculated" || summary.status === "partial")
    && summary.amount !== null
    && summary.unavailableSessions === 0,
  );
  const complete = available && summaries.every((summary) => summary.status === "calculated");
  const amount = available ? roundCost(summaries.reduce((total, summary) => total + (summary.amount ?? 0), 0)) : null;
  const usage = summaries.every((summary) => summary.usage !== null)
    ? summaries.reduce((total, summary) => addUsage(total, summary.usage ?? emptyUsage()), emptyUsage())
    : null;
  return {
    amount,
    currency: summaries[0].currency,
    status: !available ? "unavailable" : complete ? "calculated" : "partial",
    usage,
    sessionCount: summaries.reduce((total, summary) => total + summary.sessionCount, 0),
    models: normalizeModelNames(summaries.flatMap((summary) => summary.models)),
    missingPriceModels: [...new Set(summaries.flatMap((summary) => summary.missingPriceModels))].sort(),
    pendingUsageCount: summaries.reduce((total, summary) => total + summary.pendingUsageCount, 0),
    pendingUsageModels: normalizeModelNames(summaries.flatMap((summary) => summary.pendingUsageModels)),
    unavailableSessions: summaries.reduce((total, summary) => total + summary.unavailableSessions, 0),
  };
}

type CompactionBillingInput = BillingUsageInput & { entryId: string };

// Node readline treats U+2028/U+2029 as line separators; JSONL only uses LF.
async function* readJsonlLines(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  let pending = "";
  try {
    for await (const chunk of stream) {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        yield pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    }
    if (pending) yield pending.endsWith("\r") ? pending.slice(0, -1) : pending;
  } finally {
    stream.destroy();
  }
}

function billingServiceTier(...sources: unknown[]): string {
  for (const source of sources) {
    if (!isRecord(source)) continue;
    const value = source.response_service_tier;
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }
  return "";
}

/** Extract billable canonical Pi records without pricing or text heuristics. */
export async function extractReaderUsageRecords(filePath: string): Promise<ReaderUsageRecord[]> {
  const result: ReaderUsageRecord[] = [];
  const imageEvents = new Map<string, number>();
  const imageOutputs = new Map<string, ImageGenerationOutput>();
  const recoveredTasks: unknown[] = [];
  const extensionEvents: unknown[] = [];
  const legacyTypes = new Set<string>();
  const descriptors = discoverLegacyExtensionUsage();
  let sessionId = "";
  let sessionCwd = "";
  let sessionTimestamp = "";
  let currentProvider = "";
  let currentModel = "";
  let firstRecord = true;

  for await (const line of readJsonlLines(filePath)) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;
    if (firstRecord) {
      firstRecord = false;
      if (entry.type !== "session" || typeof entry.id !== "string" || !entry.id.trim()) {
        throw new Error("invalid session header");
      }
      sessionId = entry.id.trim();
      sessionCwd = typeof entry.cwd === "string" ? entry.cwd : "";
      sessionTimestamp = normalizeBillingTimestamp(entry.timestamp);
      if (!Number.isFinite(Date.parse(sessionTimestamp))) sessionTimestamp = "";
      continue;
    }

    const entryType = typeof entry.type === "string" ? entry.type : "";
    if (entryType === "custom" && entry.customType === EXTENSION_USAGE_ENTRY) {
      extensionEvents.push(isRecord(entry.data) && "event" in entry.data ? entry.data.event : entry.data);
      continue;
    }
    const customData = entryType === "custom" && isRecord(entry.data) ? entry.data : undefined;
    const customUsage = isRecord(customData?.usage) ? customData.usage : undefined;
    if (entryType === "custom" && typeof entry.customType === "string" && (descriptors.some((descriptor) => descriptor.customType === entry.customType)
        || (!!customUsage && customUsage.input === undefined && customUsage.output === undefined
          && (typeof customUsage.inputTokens === "number" || typeof customUsage.outputTokens === "number")))) {
      legacyTypes.add(entry.customType);
      continue;
    }
    if (entryType === "model_change") {
      if (typeof entry.provider === "string" && entry.provider.trim()) currentProvider = entry.provider.trim();
      if (typeof entry.modelId === "string" && entry.modelId.trim()) currentModel = entry.modelId.trim();
      continue;
    }

    const message = isRecord(entry.message) ? entry.message : undefined;
    const output = entryType === "custom" && entry.customType === "image-generation-output"
      ? readImageGenerationOutput(entry.data)
      : entryType === "message" && message?.role === "toolResult" && message.isError !== true
        && typeof message.toolCallId === "string" && typeof message.toolName === "string"
        ? imageGenerationOutputFromTool(message.toolCallId, message.toolName, message.details) : undefined;
    if (output) imageOutputs.set(JSON.stringify(output), output);
    if (entryType === "custom" && entry.customType === "image-generation-task") recoveredTasks.push(entry.data);
    if (entryType === "message" && message?.role === "toolResult" && message.toolName === "generation_task"
        && message.isError !== true && isRecord(message.details) && isRecord(message.details.task)
        && JSON.stringify(message.details.files) === JSON.stringify(message.details.task.files)) recoveredTasks.push(message.details.task);
    let usageValue: unknown;
    let provider = currentProvider || "unknown";
    let model = currentModel || "unknown";
    let usageEventValue: unknown;
    if (entryType === "message") {
      if (message?.role === "assistant") {
        if (typeof message.provider === "string" && message.provider.trim()) currentProvider = message.provider.trim();
        if (typeof message.model === "string" && message.model.trim()) currentModel = message.model.trim();
        provider = currentProvider || "unknown";
        model = currentModel || "unknown";
        usageValue = message.usage;
        usageEventValue = message.usageEvent;
      } else {
        continue;
      }
      if (typeof message.provider === "string" && message.provider.trim()) provider = message.provider.trim();
      if (typeof message.model === "string" && message.model.trim()) model = message.model.trim();
    } else if (entryType === "compaction" || entryType === "branch_summary") {
      usageValue = entry.usage;
      if (typeof entry.provider === "string" && entry.provider.trim()) provider = entry.provider.trim();
      if (typeof entry.model === "string" && entry.model.trim()) model = entry.model.trim();
      const summarizer = entryType === "compaction" ? readCompactionModel(entry.details) : null;
      if (summarizer) { provider = summarizer.provider; model = summarizer.modelId; }
    } else if (entryType === "custom") {
      const data = isRecord(entry.data) ? entry.data : undefined;
      usageValue = entry.usage ?? data?.usage;
      if (typeof data?.provider === "string" && data.provider.trim()) provider = data.provider.trim();
      if (typeof entry.provider === "string" && entry.provider.trim()) provider = entry.provider.trim();
      if (typeof data?.model === "string" && data.model.trim()) model = data.model.trim();
      if (typeof entry.model === "string" && entry.model.trim()) model = entry.model.trim();
      usageEventValue = entry.usageEvent ?? data?.usageEvent;
    } else {
      continue;
    }

    if (!isRecord(usageValue) || Object.keys(usageValue).length === 0) continue;
    const entryId = typeof entry.id === "string" ? entry.id.trim() : "";
    const timestampValue = normalizeBillingTimestamp(
      typeof entry.timestamp === "string" || typeof entry.timestamp === "number"
        ? entry.timestamp
        : message?.timestamp,
    );

    const serviceTier = billingServiceTier(message, entry, entry.data, usageValue);
    const imageBilling = entryType === "custom" && entry.customType === "image-generation-usage" && isRecord(entry.data)
      ? readImageGenerationBilling(entry.data.billing) : undefined;
    const charge = providerCharge(imageBilling);
    const usage: BillingUsageInput = {
      model,
      provider,
      ...(serviceTier ? { serviceTier } : {}),
      input: nonNegativeInteger(usageValue.input),
      output: nonNegativeInteger(usageValue.output),
      cacheRead: nonNegativeInteger(usageValue.cacheRead),
      cacheWrite: nonNegativeInteger(usageValue.cacheWrite),
      ...(typeof usageValue.cacheWrite1h === "number" ? { cacheWrite1h: nonNegativeInteger(usageValue.cacheWrite1h) } : {}),
      reasoning: nonNegativeInteger(usageValue.reasoning),
      ...imageUsageFields(entryType === "custom" && entry.customType === "image-generation-usage"
        ? { ...usageValue, usageAvailable: usageValue.usageAvailable === true } : usageValue,
        entryType === "custom" && entry.customType === "image-generation-usage"),
      ...(typeof usageValue.totalTokens === "number" ? { totalTokens: nonNegativeInteger(usageValue.totalTokens) } : {}),
      timestamp: imageBilling ? new Date(imageBilling.startedAt).toISOString() : timestampValue,
      ...(charge ? { providerCharge: charge } : {}),
    };
    const record: ReaderUsageRecord = {
      entryType,
      entryId,
      sessionId,
      timestamp: timestampValue,
      provider,
      model,
      usage,
      serviceTier,
      usageKind: entryType === "compaction" ? "compaction" : isSessionRecapUsageEntry(entry) ? "recap" : "main",
      ...parsedUsageEvent(usageEventValue),
      ...(imageBilling ? { imageBilling } : {}),
    };
    if (imageBilling && record.usageEventId) {
      const previousIndex = imageEvents.get(record.usageEventId);
      if (previousIndex !== undefined) {
        const previous = result[previousIndex];
        if (previous.provider !== provider || previous.model !== model
            || previous.imageBilling?.taskId !== imageBilling.taskId || previous.imageBilling?.requestId !== imageBilling.requestId
            || (previous.usage.providerCharge && !charge)) continue;
        result[previousIndex] = { ...record, entryId: previous.entryId, timestamp: previous.timestamp,
          imageBilling: { ...imageBilling, toolCallId: imageBilling.toolCallId ?? previous.imageBilling?.toolCallId } };
        continue;
      }
      imageEvents.set(record.usageEventId, result.length);
    }
    result.push(record);
  }
  if (firstRecord) throw new Error("session file has no valid session header");
  const receipts = result.flatMap((record) => record.usageEventId && record.imageBilling
    ? [{ id: record.usageEventId, provider: record.provider, model: record.model, billing: record.imageBilling }] : []);
  for (const task of recoveredTasks) {
    const output = imageGenerationOutputFromTask(task, sessionId, receipts);
    if (output) imageOutputs.set(JSON.stringify(output), output);
  }
  for (const record of result) {
    if (!record.usageEventId || !record.imageBilling?.toolCallId) continue;
    const outputs = [...imageOutputs.values()].filter((output) => output.toolCallId === record.imageBilling!.toolCallId
      && output.usageIds.includes(record.usageEventId!));
    if (outputs.length) record.imageOutputs = outputs;
  }
  result.push(...await readExtensionAccounting(sessionId, sessionCwd, extensionEvents, legacyTypes, descriptors, sessionTimestamp));
  return result;
}

async function readCompactionBillingInputs(filePath: string): Promise<CompactionBillingInput[]> {
  const result: CompactionBillingInput[] = [];
  let currentProvider = "";
  let currentModel = "";
  for await (const line of readJsonlLines(filePath)) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as unknown;
    if (!isRecord(entry)) continue;
    const entryType = entry.type;
    if (entryType === "model_change") {
      if (typeof entry.provider === "string" && entry.provider.trim()) currentProvider = entry.provider.trim();
      if (typeof entry.modelId === "string" && entry.modelId.trim()) currentModel = entry.modelId.trim();
      continue;
    }
    if (entryType === "message") {
      const message = isRecord(entry.message) ? entry.message : undefined;
      if (message?.role === "assistant") {
        if (typeof message.provider === "string" && message.provider.trim()) currentProvider = message.provider.trim();
        if (typeof message.model === "string" && message.model.trim()) currentModel = message.model.trim();
      }
      continue;
    }
    if (entryType !== "compaction" || typeof entry.id !== "string" || !entry.id.trim()) continue;
    if (!isRecord(entry.usage) || Object.keys(entry.usage).length === 0) continue;
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    const summarizer = readCompactionModel(entry.details);
    result.push({
      entryId: entry.id,
      serviceTier: billingServiceTier(entry, entry.usage),
      model: summarizer?.modelId ?? (typeof entry.model === "string" && entry.model.trim() ? entry.model.trim() : currentModel || "unknown"),
      provider: summarizer?.provider ?? (typeof entry.provider === "string" && entry.provider.trim() ? entry.provider.trim() : currentProvider || "unknown"),
      input: nonNegativeInteger(entry.usage.input),
      output: nonNegativeInteger(entry.usage.output),
      cacheRead: nonNegativeInteger(entry.usage.cacheRead),
      cacheWrite: nonNegativeInteger(entry.usage.cacheWrite),
      cacheWrite1h: Math.min(nonNegativeInteger(entry.usage.cacheWrite1h), nonNegativeInteger(entry.usage.cacheWrite)),
      reasoning: nonNegativeInteger(entry.usage.reasoning),
      ...(timestamp ? { timestamp } : {}),
    });
  }
  return result;
}

function compactionCostsFromPriced(
  inputs: readonly CompactionBillingInput[],
  priced: readonly PricedBillingUsage[],
): Record<string, SessionCompactionCost> {
  const result: Record<string, SessionCompactionCost> = {};
  inputs.forEach((input, index) => {
    const item = priced[index];
    const amount = item.pricing.configured && item.cost ? item.cost.total : item.pricing.lowerBound ? 0 : null;
    result[input.entryId] = {
      usage: {
        inputTokens: item.usage.input,
        cachedInputTokens: item.usage.cacheRead,
        cacheWriteTokens: item.usage.cacheWrite,
        ...(item.usage.cacheWrite1h !== undefined ? { cacheWrite1hTokens: item.usage.cacheWrite1h } : {}),
        outputTokens: item.usage.output,
        reasoningTokens: item.usage.reasoning,
        totalTokens: item.usage.totalTokens,
      },
      amount,
      currency: item.pricing.currency ?? "USD",
      status: amount === null ? "unavailable" : item.pricing.lowerBound ? "partial" : "calculated",
      model: input.model,
    };
  });
  return result;
}

export async function calculateCompactionCosts(
  filePath: string,
  scriptPath = findBillingScript(),
): Promise<Record<string, SessionCompactionCost>> {
  const inputs = await readCompactionBillingInputs(filePath);
  return compactionCostsFromPriced(inputs, await priceTokenUsages(inputs, scriptPath));
}

function summaryForPricedRecords(
  priced: readonly PricedBillingUsage[],
  sessionCount: number,
  models: readonly string[] = [],
  records?: readonly ReaderUsageRecord[],
): SessionCostSummary {
  const usage = priced.reduce((total, item) => ({
    inputTokens: total.inputTokens + item.usage.input,
    cachedInputTokens: total.cachedInputTokens + item.usage.cacheRead,
    cacheWriteTokens: total.cacheWriteTokens + item.usage.cacheWrite,
    outputTokens: total.outputTokens + item.usage.output,
    reasoningTokens: total.reasoningTokens + item.usage.reasoning,
    totalTokens: total.totalTokens + item.usage.totalTokens,
  }), emptyUsage());
  const configured = priced.length === 0 || priced.every((item) => item.pricing.configured && item.cost);
  const unpriced = priced.filter((item) => !item.pricing.configured);
  const lowerBound = unpriced.length > 0 && unpriced.every((item) => item.pricing.lowerBound === true);
  const extensionLowerBound = !!records && priced.some((item) => item.pricing.configured && item.cost)
    && priced.every((item, index) => item.pricing.configured || item.pricing.lowerBound === true || records[index]?.usageKind === "extension");
  const hasAmount = configured || lowerBound || extensionLowerBound;
  const amount = hasAmount
    ? roundCost(priced.reduce((total, item) => total + (item.cost?.total ?? 0), 0))
    : null;
  const pending = priced
    .map((item, index) => ({ item, model: models[index] ?? item.pricing.priceTableId ?? "unknown" }))
    .filter(({ item }) => !item.pricing.configured && item.usage.usageAvailable === false);
  const pendingUsageModels = normalizeModelNames(pending.map(({ model }) => model));
  const missingPriceModels = normalizeModelNames(priced
    .flatMap((item, index) => item.pricing.configured || item.usage.usageAvailable === false
      ? []
      : [models[index] ?? item.pricing.priceTableId ?? "unknown"]));
  return {
    amount,
    currency: priced.find((item) => item.pricing.currency)?.pricing.currency ?? "USD",
    status: configured ? "calculated" : hasAmount ? "partial" : "unavailable",
    usage,
    sessionCount,
    models: normalizeModelNames(models),
    missingPriceModels,
    pendingUsageCount: pending.length,
    pendingUsageModels,
    unavailableSessions: hasAmount ? 0 : 1,
  };
}

export async function calculateSessionCost(filePath: string, scriptPath: string | null): Promise<SessionCostResult> {
  const childPaths = await findChildSessionPaths(filePath);
  const parentRecords = await extractReaderUsageRecords(filePath);
  const [uniqueParent, ...uniqueChildren] = uniqueReaderUsageRecordGroups([
    parentRecords,
    ...await Promise.all(childPaths.map(extractReaderUsageRecords)),
  ]);
  const uniqueRecords = [uniqueParent, ...uniqueChildren].flat();
  const pricedRecords = await priceTokenUsages(uniqueRecords.map((record) => record.usage), scriptPath);
  const officialEstimateIndexes: number[] = [];
  const officialEstimateInputs: BillingUsageInput[] = [];
  uniqueRecords.forEach((record, index) => {
    if (pricedRecords[index]?.pricing.configured && pricedRecords[index]?.cost) return;
    const input = officialImageEstimateInput(record);
    if (!input) return;
    officialEstimateIndexes.push(index);
    officialEstimateInputs.push(input);
  });
  if (officialEstimateInputs.length > 0) {
    const officialEstimates = await priceTokenUsages(officialEstimateInputs, scriptPath);
    officialEstimateIndexes.forEach((index, estimateIndex) => {
      const estimate = officialEstimates[estimateIndex];
      if (!estimate?.pricing.configured || !estimate.cost) return;
      pricedRecords[index] = { ...estimate, usage: pricedRecords[index].usage };
    });
  }
  const officialEstimatedIndexes = new Set(officialEstimateIndexes.filter((index) => pricedRecords[index]?.pricing.configured && pricedRecords[index]?.cost));
  const parentPriced = pricedRecords.slice(0, uniqueParent.length);
  const childPriced = pricedRecords.slice(uniqueParent.length);
  const parentCost = summaryForPricedRecords(
    parentPriced,
    1,
    uniqueParent.map((record) => `${record.provider}/${record.model}`),
    uniqueParent,
  );
  const selectKind = (
    records: readonly ReaderUsageRecord[],
    priced: readonly PricedBillingUsage[],
    kind: "main" | "recap" | "compaction",
  ): { priced: PricedBillingUsage[]; models: string[] } => {
    const selected: PricedBillingUsage[] = [];
    const models: string[] = [];
    records.forEach((record, index) => {
      const recordKind = record.usageKind === "recap" ? "recap" : record.usageKind === "compaction" ? "compaction" : record.usageKind === "extension" ? "extension" : "main";
      if (recordKind !== kind) return;
      selected.push(priced[index]);
      models.push(`${record.provider}/${record.model}`);
    });
    return { priced: selected, models };
  };
  const childCost = summaryForPricedRecords(childPriced, childPaths.length, uniqueChildren.flat().map((record) => `${record.provider}/${record.model}`), uniqueChildren.flat());
  let childOffset = 0;
  const childGroups = uniqueChildren.map((records) => {
    const priced = childPriced.slice(childOffset, childOffset + records.length);
    childOffset += records.length;
    return { records, priced };
  });
  const childByKind = (kind: "main" | "recap") => childGroups.reduce(
    (result, group) => {
      const selected = selectKind(group.records, group.priced, kind);
      result.priced.push(...selected.priced);
      result.models.push(...selected.models);
      return result;
    },
    { priced: [] as PricedBillingUsage[], models: [] as string[] },
  );
  const parentMain = selectKind(uniqueParent, parentPriced, "main");
  const parentRecap = selectKind(uniqueParent, parentPriced, "recap");
  const childMain = childByKind("main");
  const childRecap = childByKind("recap");
  const parentMainCost = summaryForPricedRecords(parentMain.priced, 1, parentMain.models);
  const parentRecapCost = summaryForPricedRecords(parentRecap.priced, 1, parentRecap.models);
  const childMainCost = summaryForPricedRecords(childMain.priced, childPaths.length, childMain.models);
  const childRecapCost = summaryForPricedRecords(childRecap.priced, childPaths.length, childRecap.models);
  const recapCost = combineCostSummaries([parentRecapCost, childRecapCost]);
  const compactionInputs: CompactionBillingInput[] = [];
  const compactionPriced: PricedBillingUsage[] = [];
  uniqueRecords.forEach((record, index) => {
    if (record.usageKind !== "compaction") return;
    compactionInputs.push({ entryId: record.entryId, ...record.usage });
    compactionPriced.push(pricedRecords[index]);
  });
  const compactionCosts = compactionCostsFromPriced(compactionInputs, compactionPriced);
  const compactionCost = summaryForPricedRecords(compactionPriced, childPaths.length + 1, compactionInputs.map((input) => `${input.provider ?? "unknown"}/${input.model}`));
  const mainCost = combineCostSummaries([parentMainCost, childMainCost, compactionCost]);
  const extensionCosts: ExtensionCostSummary[] = [...new Set(uniqueRecords.flatMap((record) => record.usageKind === "extension" && record.extensionId ? [record.extensionId] : []))].sort().map((id) => {
    const rows = uniqueRecords.flatMap((record, index) => record.usageKind === "extension" && record.extensionId === id ? [{ record, priced: pricedRecords[index] }] : []);
    const historicalIncomplete = rows.some(({ record }) => record.historicalIncomplete);
    const historicalEstimated = rows.some(({ record }) => record.historicalEstimated);
    const summary = summaryForPricedRecords(rows.map(({ priced }) => priced), new Set(rows.map(({ record }) => record.sessionId)).size,
      rows.map(({ record }) => `${record.provider}/${record.model}`), rows.map(({ record }) => record));
    return { ...summary, ...(historicalIncomplete ? { usage: null } : {}), id, historicalIncomplete, historicalEstimated };
  });
  const totalCost = summaryForPricedRecords(pricedRecords, childPaths.length + 1, uniqueRecords.map((record) => `${record.provider}/${record.model}`), uniqueRecords);
  const messageCosts: Record<string, number> = {};
  uniqueParent.forEach((record, index) => {
    const item = parentPriced[index];
    const amount = item?.cost?.total;
    if (record.entryType === "message" && record.entryId && item?.pricing.configured === true && typeof amount === "number" && Number.isFinite(amount)) {
      messageCosts[record.entryId] = amount;
    }
  });
  return {
    scope: "current Pi session and persisted subagent sessions cumulative",
    cost: { currency: totalCost.currency, amount: totalCost.amount, status: totalCost.status },
    usage: mainCost.usage,
    missingPriceModels: totalCost.missingPriceModels,
    pendingUsageCount: totalCost.pendingUsageCount,
    pendingUsageModels: totalCost.pendingUsageModels,
    messageCosts,
    imageGenerationCosts: uniqueParent.flatMap((record, index): ImageGenerationCost[] => {
      if (!record.imageBilling) return [];
      const priced = parentPriced[index];
      const confirmed = !!record.usage.providerCharge;
      const amount = priced.pricing.configured && priced.cost ? priced.cost.total : null;
      const estimated = !confirmed && officialEstimatedIndexes.has(index);
      return [{ id: record.usageEventId ?? record.entryId, provider: record.provider, model: record.model,
        billing: estimated ? { ...record.imageBilling, reason: "official-rate-estimate" } : record.imageBilling,
        amount, ...(record.imageOutputs ? { outputs: record.imageOutputs } : {}),
        status: confirmed ? "confirmed" : amount !== null ? "estimated" : record.imageBilling.status === "pending" ? "pending" : "unavailable" }];
    }),
    compactionCosts,
    parentCost,
    childCost,
    mainCost,
    compactionCost,
    recapCost,
    extensionCosts,
    totalCost,
  };
}
