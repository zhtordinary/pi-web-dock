export interface ModelCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
}

export interface DiscoveredModel {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  /** Whether the upstream advertises native reasoning/thinking support. */
  reasoning?: boolean;
  /** Input modalities understood by pi (`text`, `image`, and future known values). */
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelCost;
  samplingParams?: Record<string, string | number | boolean | null>;
  thinkingLevelMap?: Record<string, string | null>;
  defaultThinkingLevel?: string;
}

const SUPPORTED_INPUT_MODALITIES = new Set(["text", "image"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasHeader(headers: Headers, name: string): boolean {
  return headers.has(name);
}

export function buildModelDiscoveryHeaders(
  api: string,
  apiKey: string | undefined,
  configured: Record<string, string | null> | undefined,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(configured ?? {})) {
    if (value !== null) headers.set(key, value);
  }
  if (!hasHeader(headers, "accept")) headers.set("Accept", "application/json");
  if (!apiKey) return headers;

  if (api === "anthropic-messages") {
    if (!hasHeader(headers, "x-api-key")) headers.set("x-api-key", apiKey);
    if (!hasHeader(headers, "anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  } else if (api === "google-generative-ai") {
    if (!hasHeader(headers, "x-goog-api-key")) headers.set("x-goog-api-key", apiKey);
  } else if (!hasHeader(headers, "authorization")) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const numeric = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof numeric === "number" && Number.isSafeInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function capabilityContainers(value: Record<string, unknown>): Record<string, unknown>[] {
  const containers = [value];
  for (const key of ["capabilities", "limits", "metadata"]) {
    if (isRecord(value[key])) containers.push(value[key]);
  }
  return containers;
}

function firstOwn(containers: readonly Record<string, unknown>[], keys: readonly string[]): unknown {
  for (const container of containers) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(container, key)) return container[key];
    }
  }
  return undefined;
}

function firstBoolean(containers: readonly Record<string, unknown>[], keys: readonly string[]): boolean | undefined {
  const value = firstOwn(containers, keys);
  return typeof value === "boolean" ? value : undefined;
}

function firstPositiveInteger(containers: readonly Record<string, unknown>[], keys: readonly string[]): number | undefined {
  return positiveInteger(firstOwn(containers, keys));
}

function readInputModalities(containers: readonly Record<string, unknown>[]): string[] | undefined {
  const raw = firstOwn(containers, [
    "input",
    "inputModalities",
    "input_modalities",
    "modalities",
    "supportedInputModalities",
    "supported_input_modalities",
  ]);
  const values = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  const input = [...new Set(values
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLocaleLowerCase())
    .filter((entry) => SUPPORTED_INPUT_MODALITIES.has(entry)))];
  if (input.length > 0) return input;

  // Several OpenAI-compatible gateways only expose a boolean vision flag.
  const vision = firstBoolean(containers, ["vision", "imageInput", "image_input", "supportsVision", "supports_vision"]);
  return vision === true ? ["text", "image"] : undefined;
}

function readCost(containers: readonly Record<string, unknown>[]): ModelCost | undefined {
  const raw = firstOwn(containers, ["cost", "pricing", "price"]);
  if (!isRecord(raw)) return undefined;

  const read = (keys: readonly string[]) => nonNegativeNumber(firstOwn([raw], keys));
  const cost: ModelCost = {};
  const input = read(["input", "prompt", "inputPerMillion", "promptPerMillion", "input_per_million"]);
  const output = read(["output", "completion", "outputPerMillion", "completionPerMillion", "output_per_million"]);
  const cacheRead = read(["cacheRead", "cache_read", "cachedInput", "cache_read_per_million"]);
  const cacheWrite = read(["cacheWrite", "cache_write", "cache_write_per_million"]);
  const cacheWrite1h = read(["cacheWrite1h", "cache_write_1h"]);
  if (input !== undefined) cost.input = input;
  if (output !== undefined) cost.output = output;
  if (cacheRead !== undefined) cost.cacheRead = cacheRead;
  if (cacheWrite !== undefined) cost.cacheWrite = cacheWrite;
  if (cacheWrite1h !== undefined) cost.cacheWrite1h = cacheWrite1h;
  return Object.keys(cost).length > 0 ? cost : undefined;
}

function readSamplingParams(containers: readonly Record<string, unknown>[]): DiscoveredModel["samplingParams"] {
  const raw = firstOwn(containers, ["samplingParams", "sampling_params"]);
  if (!isRecord(raw)) return undefined;
  const allowed: Array<[string, string | number | boolean | null]> = [];
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      allowed.push([key, value]);
    }
  }
  return allowed.length > 0 ? Object.fromEntries(allowed) : undefined;
}

function readThinkingLevelMap(containers: readonly Record<string, unknown>[]): Record<string, string | null> | undefined {
  const raw = firstOwn(containers, ["thinkingLevelMap", "thinking_level_map"]);
  if (!isRecord(raw)) return undefined;
  const entries: Array<[string, string | null]> = [];
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || typeof value === "string") entries.push([key, value]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function cloneMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) return [...value];
  if (isRecord(value)) return { ...value };
  return value;
}

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

function readSupportedEffortMap(containers: readonly Record<string, unknown>[]): Record<string, string | null> | undefined {
  const raw = firstOwn(containers, ["supported_efforts", "supportedEfforts"]);
  if (!Array.isArray(raw)) return undefined;
  const advertised = new Set(raw.filter((value): value is string => typeof value === "string"));
  if (!THINKING_LEVELS.some((level) => advertised.has(level))) return undefined;
  const map: Record<string, string | null> = {};
  for (const level of THINKING_LEVELS) {
    if (!advertised.has(level)) map[level] = null;
    else if (level === "xhigh" || level === "max") map[level] = level;
  }
  return map;
}

function modelFromValue(value: unknown): DiscoveredModel | null {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id } : null;
  }
  if (!isRecord(value)) return null;

  const rawId = cleanString(value.id) ?? cleanString(value.model) ?? cleanString(value.name);
  if (!rawId) return null;
  const id = rawId.startsWith("models/") ? rawId.slice("models/".length) : rawId;
  if (!id) return null;

  const containers = capabilityContainers(value);
  const baseUrl = cleanString(value.baseUrl) ?? cleanString(value.base_url);
  const name = cleanString(value.display_name)
    ?? cleanString(value.displayName)
    ?? (cleanString(value.id) || cleanString(value.model) ? cleanString(value.name) : undefined);
  const model: DiscoveredModel = {
    id,
    ...(name && name !== id ? { name } : {}),
    ...(cleanString(value.api) ? { api: cleanString(value.api) } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };

  const reasoning = firstBoolean(containers, ["reasoning", "supportsReasoning", "supports_reasoning", "thinking", "supportsThinking", "supports_thinking"]);
  if (reasoning !== undefined) model.reasoning = reasoning;
  const input = readInputModalities(containers);
  if (input) model.input = input;
  const contextWindow = firstPositiveInteger(containers, [
    "contextWindow", "context_window", "contextLength", "context_length", "maxContextTokens", "max_context_tokens",
    "max_model_len", "maxModelLen", "max_input_tokens", "maxInputTokens", "inputTokenLimit", "input_token_limit",
  ]);
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  const maxTokens = firstPositiveInteger(containers, [
    "maxTokens", "max_tokens", "maxOutputTokens", "max_output_tokens", "maxCompletionTokens", "max_completion_tokens",
    "outputTokenLimit", "output_token_limit",
  ]);
  if (maxTokens !== undefined) model.maxTokens = maxTokens;
  const cost = readCost(containers);
  if (cost) model.cost = cost;
  const samplingParams = readSamplingParams(containers);
  if (samplingParams) model.samplingParams = samplingParams;
  const supportedEffortMap = readSupportedEffortMap(containers);
  const thinkingLevelMap = readThinkingLevelMap(containers) ?? (reasoning !== false ? supportedEffortMap : undefined);
  if (thinkingLevelMap) model.thinkingLevelMap = thinkingLevelMap;
  if (reasoning === undefined && supportedEffortMap) model.reasoning = true;
  const defaultThinkingLevel = cleanString(firstOwn(containers, ["defaultThinkingLevel", "default_thinking_level"]));
  if (defaultThinkingLevel) model.defaultThinkingLevel = defaultThinkingLevel;
  return model;
}

function listFromResponse(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ["data", "models", "results", "items"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
    if (isRecord(candidate)) return Object.values(candidate);
  }
  return [];
}

function normalizeBaseUrl(value: string | undefined): string {
  return value?.trim().replace(/\/+$/, "") ?? "";
}

/** Stable within a provider; endpoint fields prevent bare IDs from colliding. */
export function modelDiscoveryKey(model: Pick<DiscoveredModel, "id" | "api" | "baseUrl">): string {
  return `${model.id}\u0000${model.api?.trim() ?? ""}\u0000${normalizeBaseUrl(model.baseUrl)}`;
}

export function modelIdentity(
  providerName: string,
  model: Record<string, unknown>,
  provider: Record<string, unknown>,
): string | undefined {
  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (!id) return undefined;
  const api = typeof model.api === "string" && model.api.trim()
    ? model.api.trim()
    : typeof provider.api === "string" ? provider.api.trim() : undefined;
  const baseUrl = typeof model.baseUrl === "string" && model.baseUrl.trim()
    ? model.baseUrl.trim()
    : typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : undefined;
  return `${providerName}\u0000${modelDiscoveryKey({ id, api, baseUrl })}`;
}

export function modelEndpointLabel(model: Record<string, unknown>, provider: Record<string, unknown>): string {
  const api = typeof model.api === "string" && model.api.trim()
    ? model.api.trim()
    : typeof provider.api === "string" ? provider.api.trim() : undefined;
  const baseUrl = typeof model.baseUrl === "string" && model.baseUrl.trim()
    ? model.baseUrl.trim()
    : typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : undefined;
  return [api, baseUrl].filter(Boolean).join(" · ") || "provider default";
}

/** The SDK indexes by provider/id, so endpoint variants must fail before save. */
export function collectModelEndpointConflicts(
  providerName: string,
  models: Iterable<unknown>,
  provider: Record<string, unknown>,
): string[] {
  const conflicts = new Set<string>();
  const byId = new Map<string, { key: string; endpoint: string }>();
  for (const value of models) {
    if (!isRecord(value)) continue;
    const id = typeof value.id === "string" ? value.id.trim() : "";
    if (!id) continue;
    const key = modelIdentity(providerName, value, provider);
    if (!key) continue;
    const endpoint = modelEndpointLabel(value, provider);
    const previous = byId.get(id);
    if (!previous) {
      byId.set(id, { key, endpoint });
    } else if (previous.key !== key) {
      conflicts.add(`${providerName}/${id}: ${previous.endpoint} vs ${endpoint}`);
    }
  }
  return [...conflicts];
}

const MERGEABLE_FIELDS = [
  "name",
  "api",
  "baseUrl",
  "reasoning",
  "input",
  "contextWindow",
  "maxTokens",
  "cost",
  "samplingParams",
  "thinkingLevelMap",
  "defaultThinkingLevel",
] as const;

/** Fill only absent fields; user-entered values, including false, win. */
export function mergeDiscoveredModelMetadata(base: DiscoveredModel, incoming: DiscoveredModel): DiscoveredModel {
  const next = { ...base };
  const mutable = next as unknown as Record<string, unknown>;
  for (const field of MERGEABLE_FIELDS) {
    const value = incoming[field];
    if (value === undefined || value === null) continue;
    if (next[field] !== undefined) {
      const current = next[field];
      if (!isRecord(current) || !isRecord(value)) continue;
      const merged: Record<string, unknown> = { ...current };
      let changed = false;
      for (const [key, nestedValue] of Object.entries(value)) {
        if (Object.prototype.hasOwnProperty.call(merged, key)) continue;
        if (nestedValue === null && field !== "thinkingLevelMap") continue;
        merged[key] = cloneMetadataValue(nestedValue);
        changed = true;
      }
      if (changed) mutable[field] = merged;
      continue;
    }
    mutable[field] = cloneMetadataValue(value);
  }
  return next;
}

/** Copy only model fields understood by the existing models.json/runtime path. */
export function discoveredModelToConfig(model: DiscoveredModel): Record<string, unknown> {
  const config: Record<string, unknown> = { id: model.id };
  for (const field of MERGEABLE_FIELDS) {
    const value = model[field];
    if (value === undefined || value === null) continue;
    config[field] = Array.isArray(value) ? [...value] : isRecord(value) ? { ...value } : value;
  }
  return config;
}

export function parseDiscoveredModels(value: unknown): DiscoveredModel[] {
  const models = new Map<string, DiscoveredModel>();
  for (const item of listFromResponse(value)) {
    const model = modelFromValue(item);
    if (!model) continue;
    const key = modelDiscoveryKey(model);
    const existing = models.get(key);
    models.set(key, existing ? mergeDiscoveredModelMetadata(existing, model) : model);
  }
  return [...models.values()].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, {
    numeric: true,
    sensitivity: "base",
  }));
}

export function buildModelsListUrl(baseUrl: string, api: string): URL {
  const url = new URL(baseUrl.trim());
  const trimmedPath = url.pathname.replace(/\/+$/, "");

  if (!/\/models$/i.test(trimmedPath)) {
    let path = trimmedPath;
    if (api === "anthropic-messages" && !/\/v\d+(?:beta)?$/i.test(path)) path += "/v1";
    if (api === "google-generative-ai" && !/\/v\d+(?:beta)?$/i.test(path)) path += "/v1beta";
    url.pathname = `${path}/models`.replace(/\/+/g, "/");
  }

  if (api === "anthropic-messages" && !url.searchParams.has("limit")) {
    url.searchParams.set("limit", "1000");
  }
  if (api === "google-generative-ai" && !url.searchParams.has("pageSize")) {
    url.searchParams.set("pageSize", "1000");
  }
  return url;
}
