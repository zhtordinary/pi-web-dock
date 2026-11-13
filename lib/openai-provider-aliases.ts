import type { Credential, Provider } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Provider ids used to keep ChatGPT subscription credentials separate from legacy OpenAI API credentials. */
export const OPENAI_SUBSCRIPTION_PROVIDER_ID = "openai-subscription";
/** Reserved for the API key issued with the ChatGPT subscription quota. */
export const OPENAI_API_PROVIDER_ID = "openai-api";
export const OPENAI_API_USAGE_SOURCE = "chatgpt_subscription";
export const LEGACY_OPENAI_PROVIDER_ID = "openai";

const UNSUPPORTED_SUBSCRIPTION_SAMPLING_PARAMS = new Set([
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "service_tier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
]);

type OpenAIRequestOptions = {
  sessionId?: string;
  headers?: Record<string, string | null>;
  temperature?: number;
  maxTokens?: number;
  serviceTier?: unknown;
  samplingParams?: Record<string, unknown>;
};

function normalizeSubscriptionSamplingParams(samplingParams: Record<string, unknown> | undefined) {
  if (!samplingParams) return samplingParams;
  return Object.fromEntries(
    Object.entries(samplingParams).filter(([key]) => !UNSUPPORTED_SUBSCRIPTION_SAMPLING_PARAMS.has(key)),
  );
}

function normalizeSubscriptionSamplingParamsByThinkingLevel(
  samplingParamsByThinkingLevel: Record<string, Record<string, unknown>> | undefined,
) {
  if (!samplingParamsByThinkingLevel) return samplingParamsByThinkingLevel;
  return Object.fromEntries(
    Object.entries(samplingParamsByThinkingLevel).map(([level, samplingParams]) => [
      level,
      normalizeSubscriptionSamplingParams(samplingParams),
    ]),
  );
}

function normalizeSubscriptionRequestOptions<T extends OpenAIRequestOptions | undefined>(options: T): T {
  if (!options) return options;
  const headers = { ...(options.headers ?? {}) };
  const sessionId = options.sessionId?.trim();
  if (sessionId) {
    if (!Object.prototype.hasOwnProperty.call(headers, "session-id")) headers["session-id"] = sessionId;
    if (!Object.prototype.hasOwnProperty.call(headers, "thread-id")) headers["thread-id"] = sessionId;
    if (!Object.prototype.hasOwnProperty.call(headers, "x-client-request-id")) headers["x-client-request-id"] = sessionId;
  }
  return {
    ...options,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    temperature: undefined,
    maxTokens: undefined,
    serviceTier: undefined,
    samplingParams: normalizeSubscriptionSamplingParams(options.samplingParams),
  } as T;
}

function normalizeProviderRequestOptions<T extends OpenAIRequestOptions | undefined>(providerId: string, options: T): T {
  return providerId === OPENAI_SUBSCRIPTION_PROVIDER_ID ? normalizeSubscriptionRequestOptions(options) : options;
}

export function annotateOpenAIProviderCredential(providerId: string, credential: Credential): Credential {
  if (providerId !== OPENAI_API_PROVIDER_ID || credential.type !== "api_key") return credential;
  return { ...credential, usageSource: OPENAI_API_USAGE_SOURCE } as Credential;
}

export function canonicalOpenAIProviderId(providerId: string | undefined): string | undefined {
  if (providerId === OPENAI_SUBSCRIPTION_PROVIDER_ID || providerId === OPENAI_API_PROVIDER_ID) {
    return LEGACY_OPENAI_PROVIDER_ID;
  }
  return providerId;
}

function aliasProvider(source: Provider, id: string, name: string, auth: Provider["auth"]): Provider {
  // Every model-facing hook carries the alias id, so emitted messages, usage
  // records and enabledModels references stay distinguishable from `openai`.
  const rebrand = <T extends { provider: string }>(model: T): T => {
    const rebranded = { ...model, provider: id };
    if (id !== OPENAI_SUBSCRIPTION_PROVIDER_ID || !("api" in model) || model.api !== "openai-responses") return rebranded;

    // Pi's ChatGPT-login guard keys off provider="openai". The subscription alias
    // must carry the same wire-level capability boundary without losing its identity.
    const compat = (model as { compat?: {
      supportsExplicitPromptCacheMode?: boolean;
      supportsLongCacheRetention?: boolean;
      supportsMidConvoEffort?: boolean;
      supportsMaxOutputTokens?: boolean;
      supportsToolSearch?: boolean;
    } }).compat;
    const modelWithSampling = model as {
      samplingParams?: Record<string, unknown>;
      samplingParamsByThinkingLevel?: Record<string, Record<string, unknown>>;
    };
    const samplingParams = modelWithSampling.samplingParams;
    return {
      ...rebranded,
      ...(samplingParams ? { samplingParams: normalizeSubscriptionSamplingParams(samplingParams) } : {}),
      ...(modelWithSampling.samplingParamsByThinkingLevel
        ? { samplingParamsByThinkingLevel: normalizeSubscriptionSamplingParamsByThinkingLevel(modelWithSampling.samplingParamsByThinkingLevel) }
        : {}),
      compat: {
        ...compat,
        supportsExplicitPromptCacheMode: false,
        supportsLongCacheRetention: false,
        supportsMidConvoEffort: false,
        supportsMaxOutputTokens: false,
        supportsToolSearch: false,
      },
    } as T;
  };
  const alias: Provider = {
    ...source,
    id,
    name,
    auth,
    getModels: () => source.getModels().map(rebrand),
    stream: (model, context, options) => source.stream(model, context, normalizeProviderRequestOptions(id, options)),
    streamSimple: (model, context, options) => source.streamSimple(model, context, normalizeProviderRequestOptions(id, options)),
  };
  return {
    ...alias,
    ...(source.getAllModels ? { getAllModels: () => source.getAllModels!().map(rebrand) } : {}),
    ...(source.filterModels
      ? { filterModels: (models: Parameters<NonNullable<Provider["filterModels"]>>[0], credential: Parameters<NonNullable<Provider["filterModels"]>>[1]) => source.filterModels!(models, credential).map(rebrand) }
      : {}),
    ...(source.filterAllModels
      ? { filterAllModels: (models: Parameters<NonNullable<Provider["filterAllModels"]>>[0], credential: Parameters<NonNullable<Provider["filterAllModels"]>>[1]) => source.filterAllModels!(models, credential).map(rebrand) }
      : {}),
  };
}

/** Register alias providers while leaving the built-in `openai` provider untouched. */
export function installOpenAIProviderAliases(
  runtime: Pick<ModelRuntime, "getProvider" | "registerNativeProvider"> & {
    getRegisteredNativeProvider?: (id: string) => Provider | undefined;
  },
): boolean {
  if (typeof runtime.getProvider !== "function" || typeof runtime.registerNativeProvider !== "function") return false;
  const source = runtime.getProvider(LEGACY_OPENAI_PROVIDER_ID);
  if (!source) return false;

  let installed = false;
  const isNativeRegistered = (id: string, expectedAuth: "oauth" | "apiKey") => {
    if (typeof runtime.getRegisteredNativeProvider === "function") {
      return Boolean(runtime.getRegisteredNativeProvider(id));
    }
    const current = runtime.getProvider(id);
    return Boolean(current && current.auth[expectedAuth]);
  };

  if (source.auth.oauth && !isNativeRegistered(OPENAI_SUBSCRIPTION_PROVIDER_ID, "oauth")) {
    runtime.registerNativeProvider(aliasProvider(
      source,
      OPENAI_SUBSCRIPTION_PROVIDER_ID,
      "OpenAI (ChatGPT subscription)",
      { oauth: source.auth.oauth },
    ));
    installed = true;
  }

  if (source.auth.apiKey && !isNativeRegistered(OPENAI_API_PROVIDER_ID, "apiKey")) {
    runtime.registerNativeProvider(aliasProvider(
      source,
      OPENAI_API_PROVIDER_ID,
      "OpenAI API",
      { apiKey: source.auth.apiKey },
    ));
    installed = true;
  }

  return installed;
}
