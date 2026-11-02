import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mutateResourceDocument, readResourceDocument } from "./resource-config-file.ts";

import {
  DEFAULT_ROUTE_MAX_ATTEMPTS,
  MIN_ROUTE_MAX_ATTEMPTS,
  MAX_ROUTE_MAX_ATTEMPTS,
  getModelRoutingRetryDelayMs,
  normalizeRouteMaxAttempts,
} from "./model-routing-shared.ts";

export {
  DEFAULT_ROUTE_MAX_ATTEMPTS,
  MIN_ROUTE_MAX_ATTEMPTS,
  MAX_ROUTE_MAX_ATTEMPTS,
  getModelRoutingRetryDelayMs,
  normalizeRouteMaxAttempts,
} from "./model-routing-shared.ts";

export const MODEL_ROUTING_FILE = "model-routing.json";

export function getRouteMaxAttempts(route: Pick<ModelRouteItem, "maxAttempts">): number {
  return normalizeRouteMaxAttempts(route.maxAttempts);
}

export interface ModelRouteItem {
  id: string;
  provider: string;
  model: string;
  thinkingLevel: string;
  /** Number of consecutive failed retries before moving to the next route. */
  maxAttempts?: number;
}

export interface ModelRoutingConfig {
  enabled: boolean;
  routes: ModelRouteItem[];
}

export interface RouteResolution {
  provider: string;
  modelId: string;
  thinkingLevel: string;
  inherited: boolean;
}

export function getModelRoutingConfigPath(): string {
  return join(getAgentDir(), MODEL_ROUTING_FILE);
}

function projectRoutingConfig(data: Record<string, unknown>): ModelRoutingConfig {
  return {
    enabled: data.enabled === true,
    routes: Array.isArray(data.routes) ? data.routes.map((raw: unknown, i: number) => {
      const route = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      return {
        id: typeof route.id === "string" && route.id ? route.id : `route-${i + 1}`,
        provider: typeof route.provider === "string" ? route.provider : "",
        model: typeof route.model === "string" ? route.model : "",
        thinkingLevel: typeof route.thinkingLevel === "string" ? route.thinkingLevel : "max",
        maxAttempts: normalizeRouteMaxAttempts(route.maxAttempts),
      };
    }) : [],
  };
}

export function inspectModelRoutingConfig() {
  const snapshot = readResourceDocument(getModelRoutingConfigPath());
  return { revision: snapshot.revision, value: projectRoutingConfig(snapshot.document) };
}

export async function readModelRoutingConfig(): Promise<ModelRoutingConfig> {
  try {
    return inspectModelRoutingConfig().value;
  } catch {
    return { enabled: false, routes: [] };
  }
}

export function mutateModelRoutingConfig(config: ModelRoutingConfig, expectedRevision?: string) {
  const result = mutateResourceDocument(getModelRoutingConfigPath(), expectedRevision, (document) => {
    const normalized: ModelRoutingConfig = {
      enabled: Boolean(config.enabled),
      routes: Array.isArray(config.routes) ? config.routes.map((route, i) => ({
        id: typeof route.id === "string" && route.id ? route.id : `route-${i + 1}`,
        provider: typeof route.provider === "string" ? route.provider.trim() : "",
        model: typeof route.model === "string" ? route.model.trim() : "",
        thinkingLevel: typeof route.thinkingLevel === "string" ? route.thinkingLevel.trim() : "max",
        maxAttempts: normalizeRouteMaxAttempts(route.maxAttempts),
      })).filter((route) => route.provider && route.model) : [],
    };
    document.enabled = normalized.enabled;
    document.routes = normalized.routes;
    return normalized;
  });
  return { revision: result.revision, changed: result.changed, value: result.result };
}

export async function writeModelRoutingConfig(config: ModelRoutingConfig): Promise<void> {
  mutateModelRoutingConfig(config);
}

/**
 * Resolve the next fallback route according to priority.
 *
 * Rules:
 * 1. Only providers in the configured route list may be automatically switched.
 * 2. Find the next candidate provider from configured routes that has not been tried in this cycle.
 * 3. The candidate model must be the exact model configured for that route and must be available.
 * 4. An unavailable configured model invalidates that route; never substitute another model.
 * 5. If all candidate providers have been tried or validated routes are unavailable, return null.
 */
export function resolveNextRoute(
  config: ModelRoutingConfig,
  currentProvider: string,
  currentModelId: string,
  currentThinkingLevel: string,
  triedProviders: Set<string>,
  availableModelsByProvider: (provider: string) => string[] | undefined,
): RouteResolution | null {
  if (!config.enabled || !Array.isArray(config.routes) || config.routes.length === 0) {
    return null;
  }

  if (!config.routes.some((candidate) => candidate.provider === currentProvider)) {
    return null;
  }

  for (const candidate of config.routes) {
    if (!candidate.provider) continue;
    if (candidate.provider === currentProvider) continue;
    if (triedProviders.has(candidate.provider)) continue;

    const configuredModel = typeof candidate.model === "string" ? candidate.model.trim() : "";
    if (!configuredModel) continue;

    const availableModels = availableModelsByProvider(candidate.provider);
    if (!availableModels?.includes(configuredModel)) {
      continue;
    }

    const thinkingLevel = candidate.thinkingLevel || "max";
    return {
      provider: candidate.provider,
      modelId: configuredModel,
      thinkingLevel,
      inherited: configuredModel === currentModelId && thinkingLevel === currentThinkingLevel,
    };
  }

  return null;
}
