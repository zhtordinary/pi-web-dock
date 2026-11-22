import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  resolveModelScopeWithDiagnostics,
  type ModelRuntime,
  type ScopedModel,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { resolveDefaultThinkingLevel } from "./thinking-level";
import { isLegacyOpenAIProvider } from "./openai-provider-aliases";

const THINKING_LEVEL_SUFFIXES = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * Model scoping shared by the UI selector and AgentSession startup.
 *
 * The `enabledModels` setting uses the same syntax as pi's `--models` flag:
 * globs matched with minimatch against `provider/modelId` or a bare `modelId`,
 * fuzzy matching for non-glob patterns, plus an optional `:thinkingLevel` suffix
 * (`anthropic/*:high`). Exact string comparison silently drops every model
 * behind a pattern like `my-gateway/*` (#307), so delegate to pi's own resolver
 * instead of reimplementing the matching rules here.
 */

export interface ModelScopeResult {
  /** Models the UI should offer, in resolver order (all available when unscoped). */
  visible: readonly Model<Api>[];
  /** SDK-native scope retained for AgentSession model cycling and extensions. */
  scopedModels: readonly ScopedModel[];
  /** `provider/modelId` → thinking level pinned with a `:level` pattern suffix. */
  thinkingLevelPins: Record<string, string>;
  /** Resolver diagnostics, e.g. a pattern that matched no model. */
  warnings: string[];
}

/** The provider/model order saved by the Models settings editor. */
export interface ModelOrderConfig {
  providers?: Record<string, unknown>;
}

export interface InitialModelScopeOptions {
  requestedModel?: { provider: string; modelId: string };
  defaultModel?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  thinkingLevelDefaults?: Record<string, string>;
}

export interface InitialModelScopeResult {
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  scopedModels: ScopedModel[];
  /** A retired default must be replaced by an explicit user selection. */
  requiresModelSelection?: boolean;
}

function matchesModel(
  model: { provider: string; id: string },
  ref: { provider: string; modelId: string },
): boolean {
  return model.provider === ref.provider && model.id === ref.modelId;
}

function hasGlob(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

function isSuppressibleUnmatchedGlob(pattern: string): boolean {
  if (!hasGlob(pattern)) return false;
  const colonIndex = pattern.lastIndexOf(":");
  return colonIndex < 0
    || THINKING_LEVEL_SUFFIXES.has(pattern.slice(colonIndex + 1) as ThinkingLevel);
}

/**
 * Resolve the visible model list for `patterns`.
 *
 * Falls back to every available model when no patterns are configured or when
 * the patterns resolve to nothing, so a stale or typo'd setting can never leave
 * the UI without any selectable model.
 */
export async function resolveVisibleModels(
  modelRuntime: ModelRuntime,
  patterns: string[] | undefined,
): Promise<ModelScopeResult> {
  const cleaned = (patterns ?? []).map((pattern) => pattern.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return {
      visible: await modelRuntime.getAvailable(),
      scopedModels: [],
      thinkingLevelPins: {},
      warnings: [],
    };
  }

  const available = await modelRuntime.getAvailable();
  const snapshotRuntime = {
    getAvailable: async () => available,
  } as ModelRuntime;
  const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(cleaned, snapshotRuntime);
  // A leftover valid glob after a model was removed is not a chat-level problem
  // when other enabledModels entries still matched. Keep exact and malformed
  // pattern warnings, and keep all no-match warnings for a total miss, where
  // the UI falls back to every available model and the user needs to know the
  // scope did not apply.
  const warnings = diagnostics
    .filter((diagnostic) => (
      diagnostic.code !== "no-match"
      || scopedModels.length === 0
      || isLegacyOpenAIProvider(diagnostic.pattern.replace(/^!/, "").split("/", 1)[0])
      || !isSuppressibleUnmatchedGlob(diagnostic.pattern)
    ))
    .map((diagnostic) => diagnostic.message);
  if (scopedModels.length === 0) {
    return {
      visible: available,
      scopedModels: [],
      thinkingLevelPins: {},
      warnings,
    };
  }

  // `anthropic/*:high` pins a thinking level on every model the glob matched.
  // pi applies the pin of the model a new session starts with; report them all
  // so the client can look up whichever model it pre-selects.
  const thinkingLevelPins: Record<string, string> = {};
  for (const scoped of scopedModels) {
    if (scoped.thinkingLevel) {
      thinkingLevelPins[`${scoped.model.provider}/${scoped.model.id}`] = scoped.thinkingLevel;
    }
  }
  return {
    visible: scopedModels.map((scoped) => scoped.model),
    scopedModels,
    thinkingLevelPins,
    warnings,
  };
}

/**
 * Return model choices in the order saved by the Models settings editor.
 * Models absent from that file keep their existing runtime order after the
 * configured providers/models; filtering by enabledModels never changes it.
 */
export function orderSelectorModels(
  scope: ModelScopeResult,
  config: ModelOrderConfig = {},
): Model<Api>[] {
  const providerOrder = new Map<string, number>();
  const modelOrder = new Map<string, Map<string, number>>();
  for (const [provider, entry] of Object.entries(config.providers ?? {})) {
    providerOrder.set(provider, providerOrder.size);
    const models = entry && typeof entry === "object" && !Array.isArray(entry)
      && Array.isArray((entry as { models?: unknown }).models)
      ? (entry as { models: unknown[] }).models
        .filter((model): model is { id: string } => (
          model !== null && typeof model === "object" && !Array.isArray(model)
          && typeof (model as { id?: unknown }).id === "string"
        ))
      : [];
    modelOrder.set(provider, new Map(models.map((model, index) => [model.id, index])));
  }

  const originalProviderOrder = new Map<string, number>();
  const originalModelOrder = new Map<string, number>();
  scope.visible.forEach((model, index) => {
    if (!originalProviderOrder.has(model.provider)) originalProviderOrder.set(model.provider, originalProviderOrder.size);
    originalModelOrder.set(`${model.provider}\0${model.id}`, index);
  });
  const configuredProviderCount = providerOrder.size;
  return [...scope.visible].sort((left, right) => {
    const leftProviderOrder = providerOrder.get(left.provider);
    const rightProviderOrder = providerOrder.get(right.provider);
    const leftProviderRank = leftProviderOrder ?? configuredProviderCount + (originalProviderOrder.get(left.provider) ?? 0);
    const rightProviderRank = rightProviderOrder ?? configuredProviderCount + (originalProviderOrder.get(right.provider) ?? 0);
    if (leftProviderRank !== rightProviderRank) return leftProviderRank - rightProviderRank;

    const ranks = modelOrder.get(left.provider);
    if (ranks) {
      const leftModelRank = ranks.get(left.id);
      const rightModelRank = ranks.get(right.id);
      const leftRank = leftModelRank ?? ranks.size + (originalModelOrder.get(`${left.provider}\0${left.id}`) ?? 0);
      const rightRank = rightModelRank ?? ranks.size + (originalModelOrder.get(`${right.provider}\0${right.id}`) ?? 0);
      if (leftRank !== rightRank) return leftRank - rightRank;
    }
    return (originalModelOrder.get(`${left.provider}\0${left.id}`) ?? 0)
      - (originalModelOrder.get(`${right.provider}\0${right.id}`) ?? 0);
  });
}

/** Apply the settings order to both selector data and SDK startup scope. */
export function orderModelScope(
  scope: ModelScopeResult,
  config: ModelOrderConfig = {},
): ModelScopeResult {
  const visible = orderSelectorModels(scope, config);
  if (scope.scopedModels.length === 0) return { ...scope, visible };
  const scopedByKey = new Map(scope.scopedModels.map((scoped) => [`${scoped.model.provider}\0${scoped.model.id}`, scoped]));
  const scopedModels = visible
    .map((model) => scopedByKey.get(`${model.provider}\0${model.id}`))
    .filter((scoped): scoped is ScopedModel => Boolean(scoped));
  return { ...scope, visible, scopedModels };
}

/**
 * Select the model and thinking level used to create a new AgentSession.
 *
 * This mirrors pi's startup rule: prefer an explicit selection, otherwise use
 * the saved default when it is in scope, then the first resolver-ordered model.
 * An unavailable retired OpenAI default requires an explicit selection instead
 * of silently choosing another provider. A scoped-model thinking pin is applied
 * unless the caller supplied an explicit thinking level.
 */
export function selectInitialModelScope(
  scope: ModelScopeResult,
  options: InitialModelScopeOptions = {},
): InitialModelScopeResult {
  const requestedRef = options.requestedModel;
  const defaultRef = options.defaultModel;
  if (!requestedRef && defaultRef && isLegacyOpenAIProvider(defaultRef.provider)
    && !scope.visible.some((model) => matchesModel(model, defaultRef))) {
    return { scopedModels: [...scope.scopedModels], requiresModelSelection: true };
  }
  const requested = requestedRef
    ? scope.visible.find((model) => matchesModel(model, requestedRef))
    : undefined;
  if (requestedRef && !requested) {
    throw new Error(
      `Model is not available in the enabled scope: ${requestedRef.provider}/${requestedRef.modelId}`,
    );
  }

  const requestedScoped = requested
    ? scope.scopedModels.find((scoped) => scoped.model === requested
      || matchesModel(scoped.model, { provider: requested.provider, modelId: requested.id }))
    : undefined;
  const defaultScoped = !requested && defaultRef
    ? scope.scopedModels.find((scoped) => matchesModel(scoped.model, defaultRef))
    : undefined;
  const fallbackScoped = !requested ? (defaultScoped ?? scope.scopedModels[0]) : undefined;
  const defaultVisible = !requested && !fallbackScoped && defaultRef
    ? scope.visible.find((model) => matchesModel(model, defaultRef))
    : undefined;
  const selectedModel = requested ?? fallbackScoped?.model ?? defaultVisible;
  const scopedSelection = requestedScoped ?? fallbackScoped;
  const thinkingLevel = options.thinkingLevel
    ?? (selectedModel
      ? resolveDefaultThinkingLevel(
          getSupportedThinkingLevels(selectedModel),
          options.thinkingLevelDefaults?.[`${selectedModel.provider}/${selectedModel.id}`],
          scopedSelection?.thinkingLevel,
        ) ?? undefined
      : undefined);

  return {
    ...(selectedModel ? { model: selectedModel } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    scopedModels: [...scope.scopedModels],
  };
}
