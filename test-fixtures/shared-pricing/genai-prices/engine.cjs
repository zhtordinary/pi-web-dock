"use strict";

// Single pricing boundary for local estimates. This file contains integration
// plumbing only; rate lookup and arithmetic stay inside Pydantic's maintained
// @pydantic/genai-prices package.

const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { calcPrice, findProvider, updatePrices } = require("@pydantic/genai-prices");

const REMOTE_DATA_URL = "https://raw.githubusercontent.com/pydantic/genai-prices/main/prices/new_data/v2/data.json";
const REMOTE_API_DATA_URL = "https://api.github.com/repos/pydantic/genai-prices/contents/prices/new_data/v2/data.json?ref=main";
const CACHE_TTL_MS = 60 * 60 * 1000;
const REMOTE_FETCH_TIMEOUT_MS = 5_000;
const USER_AGENT = "pi-sync-maintenance/genai-prices-engine";
const ACTIVE_PRICE_DATA_STATUSES = new Set(["bundled", "cache", "remote", "stale_cache"]);
const OFFICIAL_PROVIDER_IDS = new Set([
  "anthropic", "avian", "aws", "azure", "cerebras", "cohere", "deepseek",
  "doubleword", "fireworks", "google", "groq", "minimax", "mistral", "modal",
  "moonshotai", "novita", "openai", "openrouter", "perplexity", "together",
  "voyageai", "x-ai", "zai", "zhipuai",
]);
const PROVIDER_ALIASES = new Map([
  ["xai", "x-ai"],
  ["x-ai", "x-ai"],
  ["minimax-cn", "minimax"],
  ["moonshot", "moonshotai"],
  ["kimi", "moonshotai"],
  ["google", "google"],
  ["gemini", "google"],
  ["openai-compatible", "openai"],
  ["codex", "openai"],
  ["zai-coding-cn", "zai"],
]);

let initialized = false;
let setProviderData = null;
let catalogCache = null;
let dataState = {
  source: "bundled",
  status: "bundled",
  updatedAt: null,
  revision: null,
  failureReason: null,
  failureAt: null,
};

function packageVersion() {
  const resolved = require.resolve("@pydantic/genai-prices");
  let directory = path.dirname(resolved);
  while (directory !== path.dirname(directory)) {
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
      if (metadata.name === "@pydantic/genai-prices") return String(metadata.version || "unknown");
    } catch {
      // Continue walking toward package root.
    }
    directory = path.dirname(directory);
  }
  return "unknown";
}

function assertSupportedPackageVersion() {
  const version = packageVersion();
  if (!version || version === "unknown") {
    throw new Error(`unsupported @pydantic/genai-prices version: ${version}`);
  }
  const pydanticModule = require("@pydantic/genai-prices");
  for (const fn of ["calcPrice", "updatePrices", "findProvider"]) {
    if (typeof pydanticModule[fn] !== "function") {
      throw new Error(`@pydantic/genai-prices ${version} missing required API export: ${fn}`);
    }
  }
}

assertSupportedPackageVersion();

function cachePath() {
  const configured = String(process.env.XDG_CACHE_HOME || "").trim();
  const root = configured || path.join(os.homedir(), ".cache");
  return path.join(root, "pi-sync-maintenance", "genai-prices-v2.json");
}

function failurePath() {
  return `${cachePath()}.fetch-failed`;
}

function failureReason(error) {
  const message = String(error instanceof Error ? error.message : error || "")
    .replace(/\s+/g, " ")
    .trim();
  return (message || "price data refresh failed").slice(0, 240);
}

function readFetchFailure() {
  try {
    const payload = JSON.parse(fs.readFileSync(failurePath(), "utf8"));
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return {
        reason: String(payload.reason || "price data refresh failed"),
        at: String(payload.at || new Date(fs.statSync(failurePath()).mtimeMs).toISOString()),
      };
    }
  } catch {
    // Also support the old empty failure marker.
  }
  try {
    return {
      reason: "price data refresh failed",
      at: new Date(fs.statSync(failurePath()).mtimeMs).toISOString(),
    };
  } catch {
    return null;
  }
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data), "utf8");
  fs.renameSync(temp, file);
}

function rememberFetchFailure(error) {
  const failure = { reason: failureReason(error), at: new Date().toISOString() };
  try {
    writeAtomic(failurePath(), failure);
  } catch {
    // Expose process-local failure even when the marker cannot be written.
  }
  return failure;
}

function clearFetchFailure() {
  try {
    fs.unlinkSync(failurePath());
  } catch {
    // No marker is normal.
  }
}

function readCachedData(allowStale = false, preserveFailure = false) {
  try {
    const file = cachePath();
    const stats = fs.statSync(file);
    const stale = Date.now() - stats.mtimeMs > CACHE_TTL_MS;
    if (stale && !allowStale) return null;
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return null;
    const failure = stale || preserveFailure ? readFetchFailure() : null;
    if (!stale && !preserveFailure) clearFetchFailure();
    dataState = {
      source: stale ? "stale_cache" : "cache",
      status: stale ? "stale_cache" : "cache",
      updatedAt: new Date(stats.mtimeMs).toISOString(),
      revision: crypto.createHash("sha256").update(raw).digest("hex"),
      failureReason: failure?.reason || null,
      failureAt: failure?.at || null,
    };
    return data;
  } catch {
    return null;
  }
}

async function fetchProviderData(url, accept) {
  const response = await fetch(url, {
    headers: { accept, "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error("genai-prices payload is not a provider array");
  return data;
}

async function fetchData() {
  try {
    return await fetchProviderData(REMOTE_DATA_URL, "application/json");
  } catch (rawError) {
    try {
      return await fetchProviderData(REMOTE_API_DATA_URL, "application/vnd.github.raw+json");
    } catch (apiError) {
      throw new Error(`upstream feed unavailable; raw: ${failureReason(rawError)}; GitHub API: ${failureReason(apiError)}`);
    }
  }
}

function initialize() {
  if (initialized) return;
  initialized = true;
  updatePrices(({ setProviderData: setter }) => {
    setProviderData = setter;
    const cached = readCachedData();
    if (cached) {
      setter(cached);
      return;
    }
    const stale = readCachedData(true);
    if (stale) {
      // Keep the last known-good table active while the refresh runs.
      setter(stale);
    }
    setter(fetchData().then((data) => {
      writeAtomic(cachePath(), data);
      clearFetchFailure();
      catalogCache = null;
      dataState = {
        source: "remote",
        status: "remote",
        updatedAt: new Date().toISOString(),
        revision: crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex"),
        failureReason: null,
        failureAt: null,
      };
      return data;
    }).catch((error) => {
      const failure = rememberFetchFailure(error);
      if (stale) {
        dataState = {
          ...dataState,
          source: "stale_cache",
          status: "stale_cache",
          failureReason: failure.reason,
          failureAt: failure.at,
        };
        return stale;
      }
      dataState = {
        ...dataState,
        source: "bundled",
        status: "fetch_failed",
        failureReason: failure.reason,
        failureAt: failure.at,
      };
      return null;
    }));
  });
}

async function refreshPriceData() {
  initialize();
  try {
    const data = await fetchData();
    writeAtomic(cachePath(), data);
    clearFetchFailure();
    dataState = {
      source: "remote",
      status: "remote",
      updatedAt: new Date().toISOString(),
      revision: crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex"),
      failureReason: null,
      failureAt: null,
    };
    if (setProviderData) setProviderData(data);
    catalogCache = null;
    return { ...dataState, cachePath: cachePath() };
  } catch (error) {
    const failure = rememberFetchFailure(error);
    const cached = readCachedData(true, true);
    if (cached) {
      const stale = dataState.source === "stale_cache";
      if (stale && setProviderData) setProviderData(cached);
      dataState = {
        ...dataState,
        status: stale ? "stale_cache" : "fetch_failed",
        failureReason: failure.reason,
        failureAt: failure.at,
      };
    } else {
      dataState = {
        ...dataState,
        source: "bundled",
        status: "fetch_failed",
        failureReason: failure.reason,
        failureAt: failure.at,
      };
    }
    catalogCache = null;
    throw error;
  }
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function timestampDate(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/_/g, "-");
}

const GATEWAY_PROVIDER_MARKERS = ["cpa", "sub2api", "cli-proxy-api", "cliproxy", "proxy-api"];
function isGatewayProvider(provider) {
  const value = normalize(provider);
  return GATEWAY_PROVIDER_MARKERS.some((marker) => value.includes(marker));
}

function modelName(model) {
  let value = normalize(model);
  if (value.includes("/")) {
    const [prefix, ...rest] = value.split("/");
    if (OFFICIAL_PROVIDER_IDS.has(prefix) || PROVIDER_ALIASES.has(prefix)
      || ["workbuddy", "sub2api", "cpa", "opencode", "antigravity"].some((marker) => prefix.includes(marker))) {
      value = rest.join("/");
    }
  }
  return value;
}

function canonicalModelId(model, providerId) {
  const name = modelName(model);
  if (providerId === "deepseek") {
    if (
      name === "deepseek-flash" ||
      name.startsWith("deepseek-flash-") ||
      name === "deepseek-v4.1-flash" ||
      name.startsWith("deepseek-v4.1-flash-") ||
      name.startsWith("deepseek-v4.1-flash/")
    ) {
      return "deepseek-flash";
    }
    if (
      name === "deepseek-v4.1-pro" ||
      name.startsWith("deepseek-v4.1-pro-") ||
      name.startsWith("deepseek-v4.1-pro/")
    ) {
      return "deepseek-v4-pro";
    }
    if (name === "deepseek-reasoner" || name.startsWith("deepseek-reasoner-")) {
      return "deepseek-reasoner";
    }
  }
  return name;
}

function providerFromModel(model) {
  const name = modelName(model);
  if (name.includes("deepseek")) return "deepseek";
  if (name.includes("claude") || name.includes("anthropic")) return "anthropic";
  if (name.includes("grok") || name.startsWith("xai-")) return "x-ai";
  if (name.includes("gemini") || name.includes("google")) return "google";
  if (name.includes("kimi") || name.includes("moonshot")) return "moonshotai";
  if (name.includes("minimax")) return "minimax";
  if (name.startsWith("glm") || name.startsWith("chatglm")) return "zhipuai";
  if (/^(gpt-|o1|o3|o4|o5|codex-)/.test(name)) return "openai";
  return null;
}

function providerIdFor(model, provider) {
  const providerName = normalize(provider);
  if (!providerName) return providerFromModel(model);
  if (isGatewayProvider(providerName)) return providerFromModel(model);
  if (OFFICIAL_PROVIDER_IDS.has(providerName)) return providerName;
  if (PROVIDER_ALIASES.has(providerName)) return PROVIDER_ALIASES.get(providerName);
  const identity = `${providerName} ${modelName(model)}`;
  if (identity.includes("deepseek")) return "deepseek";
  if (identity.includes("claude") || identity.includes("anthropic")) return "anthropic";
  if (identity.includes("grok") || identity.includes("xai")) return "x-ai";
  if (identity.includes("gemini") || identity.includes("antigravity") || identity.includes("google")) return "google";
  if (identity.includes("kimi") || identity.includes("moonshot")) return "moonshotai";
  if (identity.includes("minimax")) return "minimax";
  if (identity.includes("glm") || identity.includes("zhipu")) return "zhipuai";
  if (identity.includes("zai")) return "zai";
  if (identity.includes("gpt") || identity.includes("openai") || identity.includes("codex")) return "openai";
  return providerFromModel(model);
}

function hasActivePriceData() {
  return ACTIVE_PRICE_DATA_STATUSES.has(dataState.status);
}

function calcPartition(modelId, providerId, totalInput, kind, count, oneHour, timestamp) {
  if (!count || !totalInput) return 0;
  const usage = { input_tokens: totalInput };
  if (kind === "read") usage.cache_read_tokens = totalInput;
  if (kind === "write") {
    usage.cache_write_tokens = totalInput;
    if (oneHour) usage.cache_write_1h_tokens = totalInput;
  }
  const result = calcPrice(usage, modelId, { providerId, timestamp });
  if (!result) return null;
  return (result.input_price * count) / totalInput;
}

function serviceTierFor(...sources) {
  // An observed response tier wins over a requested tier, including downgrades.
  for (const keys of [["response_service_tier"], ["serviceTier", "service_tier"], ["request_service_tier"]]) {
    for (const source of sources) {
      for (const key of keys) {
        const value = source?.[key];
        if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
      }
    }
  }
  return "";
}

function supportsServiceTier(tier) {
  // The upstream price API has no service-tier dimension; do not invent a multiplier.
  return ["", "auto", "default", "standard", "normal"].includes(String(tier ?? "").trim().toLowerCase());
}

function priceUsage(model, provider, usage = {}, options = {}) {
  const serviceTier = serviceTierFor(options, usage);
  if (!supportsServiceTier(serviceTier) || usage.usageAvailable === false) return null;
  initialize();
  if (!hasActivePriceData()) return null;
  const providerId = providerIdFor(model, provider);
  const timestamp = timestampDate(options.timestamp);
  if (!providerId || !timestamp) return null;

  const input = nonNegative(usage.input);
  const cacheRead = nonNegative(usage.cacheRead);
  const cacheWrite = nonNegative(usage.cacheWrite);
  const cacheWrite1h = Math.min(nonNegative(usage.cacheWrite1h), cacheWrite);
  const output = nonNegative(usage.output);
  const reasoning = nonNegative(usage.reasoning);
  const totalTokens = nonNegative(usage.totalTokens ?? usage.total_tokens);
  const inputIncludesCache = options.inputIncludesCache !== false;
  const totalInput = inputIncludesCache ? input : input + cacheRead + cacheWrite;
  const inputImage = usage.inputImage ?? 0;
  const outputImage = usage.outputImage ?? 0;
  if (![inputImage, outputImage].every((value) => Number.isSafeInteger(value) && value >= 0)
      || inputImage > totalInput || outputImage > output
      || (inputImage > 0 && (cacheRead > 0 || cacheWrite > 0))) return null;
  let modelId = canonicalModelId(model, providerId);

  // Reasoning / Thinking token accounting:
  // 1. If explicit totalTokens confirms reasoning is separate from output:
  //    (input + cacheRead + cacheWrite + output + reasoning <= totalTokens) -> billableOutput = output + reasoning
  // 2. Or if provider/model is Gemini / Google (where reasoning tokens are distinct from text output and billed at output rate)
  // 3. Otherwise, if output already subsumes reasoning (e.g. OpenAI completion_tokens includes reasoning_tokens), billableOutput = output.
  let billableOutput = output;
  if (reasoning > 0) {
    const rawAdditiveTotal = (options.inputIncludesCache ? totalInput : input) + cacheRead + cacheWrite + output + reasoning;
    if (totalTokens > 0 && Math.abs(totalTokens - rawAdditiveTotal) <= 10) {
      billableOutput = output + reasoning;
    } else if (providerId === "google" || modelId.includes("gemini") || modelId.includes("antigravity")) {
      billableOutput = output + reasoning;
    }
  }

  const billedUsage = {
    input_tokens: totalInput,
    output_tokens: billableOutput,
    ...(inputImage ? { input_image_tokens: inputImage } : {}),
    ...(outputImage ? { output_image_tokens: outputImage } : {}),
  };
  if (cacheRead) billedUsage.cache_read_tokens = cacheRead;
  if (cacheWrite) {
    billedUsage.cache_write_tokens = cacheWrite;
    if (cacheWrite1h) billedUsage.cache_write_1h_tokens = cacheWrite1h;
  }
  let result = calcPrice(billedUsage, modelId, { providerId, timestamp });
  if (!result && normalize(model) !== modelId) {
    result = calcPrice(billedUsage, normalize(model), { providerId, timestamp });
    if (result) modelId = normalize(model);
  }
  if (!result) return null;

  const modelPrice = result.model_price || {};
  const hasPrice = (key) => modelPrice[key] !== undefined && modelPrice[key] !== null;
  if (inputImage && !hasPrice("input_image_mtok")) return null;
  // GPT Image 1/2 families publish their image-only output as output_mtok.
  if (outputImage && !hasPrice("output_image_mtok") && !(modelId.startsWith("gpt-image-") && hasPrice("output_mtok"))) return null;
  const hasCacheReadPrice = hasPrice("cache_read_mtok");
  const hasCacheWritePrice = hasPrice("cache_write_mtok") || hasPrice("cache_write_5m_mtok");
  const hasCacheWrite1hPrice = hasPrice("cache_write_1h_mtok");
  if (cacheRead && !hasCacheReadPrice) return null;
  if (cacheWrite - cacheWrite1h && !hasCacheWritePrice) return null;
  if (cacheWrite1h && !hasCacheWrite1hPrice) return null;

  const fresh = inputIncludesCache ? Math.max(0, totalInput - cacheRead - cacheWrite) : input;
  const freshCost = inputImage ? result.input_price : calcPartition(modelId, providerId, totalInput, "fresh", fresh, 0, timestamp);
  const readCost = calcPartition(modelId, providerId, totalInput, "read", cacheRead, 0, timestamp);
  const baselineReadCost = calcPartition(modelId, providerId, totalInput, "fresh", cacheRead, 0, timestamp);
  const write5mCost = calcPartition(modelId, providerId, totalInput, "write", cacheWrite - cacheWrite1h, 0, timestamp);
  const write1hCost = calcPartition(modelId, providerId, totalInput, "write", cacheWrite1h, 1, timestamp);
  if ([freshCost, readCost, baselineReadCost, write5mCost, write1hCost].some((value) => value === null)) return null;

  const components = {
    input: freshCost,
    cacheRead: readCost,
    cacheWrite: write5mCost + write1hCost,
    output: result.output_price,
    total: result.total_price,
  };
  const componentTotal = components.input + components.cacheRead + components.cacheWrite + components.output;
  if (Math.abs(componentTotal - components.total) > 1e-10 * Math.max(1, Math.abs(components.total))) return null;

  const source = Array.isArray(result.provider?.pricing_urls)
    ? result.provider.pricing_urls.filter(Boolean).join(";")
    : "";
  return {
    cost: components,
    cacheSavings: Math.max(0, baselineReadCost - readCost),
    rates: {
      serviceTier,
      ...((usage.inputImage !== undefined || usage.outputImage !== undefined) ? { imageTokenPricing: true } : {}),
      currency: "USD",
      source,
      priceTableId: `genai-prices/${result.provider.id}/${result.model.id}`,
      priceTableVersion: 0,
      priceTableUpdatedAt: dataState.updatedAt,
      priceTableStatus: dataState.status,
      priceTableFailureReason: dataState.failureReason,
      priceTableFailureAt: dataState.failureAt,
      priceEngine: "genai-prices",
      priceEngineVersion: packageVersion(),
      cacheReadPricingAvailable: hasCacheReadPrice,
      cacheWritePricingAvailable: hasCacheWritePrice || hasCacheWrite1hPrice,
      billingBasis: "genai_prices_v2",
    },
    engine: "pydantic",
    provider: result.provider.id,
    model: result.model.id,
  };
}

function modelPriceCatalog() {
  initialize();
  if (!hasActivePriceData()) return {};
  if (catalogCache) return catalogCache;
  const result = {};
  for (const providerId of OFFICIAL_PROVIDER_IDS) {
    const provider = findProvider({ providerId });
    if (!provider) continue;
    for (const model of provider.models || []) {
      const activeEntry = Array.isArray(model.prices) ? model.prices.at(-1) : null;
      const prices = Array.isArray(model.prices) ? activeEntry?.prices : model.prices;
      if (!prices || typeof prices !== "object") continue;
      const number = (value) => {
        if (typeof value === "number") return value;
        if (value && typeof value.base === "number") return value.base;
        return undefined;
      };
      const input = number(prices.input_mtok);
      const cachedInput = number(prices.cache_read_mtok);
      const output = number(prices.output_mtok);
      if (input === undefined || output === undefined) continue;
      // The upstream feed carries a release/effective date only on some models.
      // Expose it when present so consumers can rank by real recency instead of
      // falling back to the feed's alphabetical order.
      const startDate = activeEntry?.constraint?.start_date || null;
      const key = `${provider.id}/${model.id}`;
      if (!result[key]) {
        result[key] = {
          input,
          cachedInput: cachedInput ?? 0,
          output,
          cachePricingAvailable: cachedInput !== undefined,
          provider: provider.id,
          startDate,
        };
      }
    }
  }
  if (result["deepseek/deepseek-flash"] && !result["deepseek/deepseek-v4.1-flash"]) {
    result["deepseek/deepseek-v4.1-flash"] = { ...result["deepseek/deepseek-flash"] };
  }
  catalogCache = result;
  return result;
}

function state() {
  initialize();
  return {
    ...dataState,
    cachePath: cachePath(),
    engine: "genai-prices",
    packageVersion: packageVersion(),
  };
}

function priceJsonRecord(item) {
  const usage = item?.usage || {};
  const serviceTier = serviceTierFor(item, usage);
  const input = nonNegative(usage.input ?? usage.inputTokens ?? usage.input_tokens);
  const cacheRead = nonNegative(usage.cacheRead ?? usage.cachedInputTokens ?? usage.cache_read_tokens);
  const cacheWrite = nonNegative(usage.cacheWrite ?? usage.cacheWriteTokens ?? usage.cache_write_tokens);
  const cacheWrite1h = Math.min(nonNegative(usage.cacheWrite1h ?? usage.cacheWrite1hTokens ?? usage.cache_write_1h_tokens), cacheWrite);
  const output = nonNegative(usage.output ?? usage.outputTokens ?? usage.output_tokens);
  const reasoning = nonNegative(usage.reasoning ?? usage.reasoningTokens ?? usage.reasoning_tokens);
  const totalTokens = nonNegative(usage.totalTokens ?? usage.total_tokens);
  // JSON callers send fresh input separately from cache partitions. The
  // in-process priceUsage API keeps its historical opt-in inclusive-input
  // behavior, but the stable CLI contract is always partitioned input.
  const inputIncludesCache = item?.inputIncludesCache === true;
  const priced = priceUsage(item?.model, item?.provider, {
    input,
    cacheRead,
    cacheWrite,
    cacheWrite1h,
    output,
    reasoning,
    totalTokens,
    ...(usage.inputImage !== undefined ? { inputImage: usage.inputImage } : {}),
    ...(usage.outputImage !== undefined ? { outputImage: usage.outputImage } : {}),
    ...(usage.usageAvailable !== undefined ? { usageAvailable: usage.usageAvailable } : {}),
  }, {
    timestamp: item?.timestamp,
    serviceTier,
    inputIncludesCache,
  });
  const record = {
    configured: priced !== null,
    model: String(item?.model || ""),
    provider: String(item?.provider || ""),
    serviceTier,
    usage: { input, cacheRead, cacheWrite, cacheWrite1h, output, reasoning },
  };
  if (priced) {
    record.cost = priced.cost;
    record.rates = priced.rates;
    record.engine = priced.engine;
    record.status = "calculated";
  } else {
    record.cost = null;
    record.status = "unavailable";
    record.reasonCode = supportsServiceTier(serviceTier) ? "pricing_unavailable" : "unpriced_service_tier";
    record.reason = !supportsServiceTier(serviceTier)
      ? `genai-prices 不支持服务等级计价：${serviceTier}`
      : isGatewayProvider(item?.provider)
      ? "网关会话金额由 CPA/Sub2API 账本提供"
      : dataState.failureReason
        ? `genai-prices 数据不可用：${dataState.failureReason}`
        : "genai-prices 未匹配 provider/model/time 或计价数据不可用";
  }
  return record;
}

module.exports = {
  cachePath,
  canonicalModelId,
  modelPriceCatalog,
  packageVersion,
  priceJsonRecord,
  priceUsage,
  serviceTierFor,
  supportsServiceTier,
  providerIdFor,
  isGatewayProvider,
  refreshPriceData,
  state,
};
