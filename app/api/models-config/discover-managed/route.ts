import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { NextResponse } from "next/server";
import {
  buildModelDiscoveryHeaders,
  buildModelsListUrl,
  collectModelEndpointConflicts,
  discoveredModelToConfig,
  mergeDiscoveredModelMetadata,
  modelDiscoveryKey,
  modelIdentity,
  parseDiscoveredModels,
  type DiscoveredModel,
} from "@/lib/model-discovery";
import { readModelsJson, writeModelsJson } from "@/lib/models-json-store";
import { ModelsConfigReadError } from "@/lib/models-config-store";
import { MODEL_RUNTIME_REFRESH_TIMEOUT_MS, refreshRpcSessionModels } from "@/lib/rpc-manager";
import { installOpenAIProviderAliases } from "@/lib/openai-provider-aliases";

export const dynamic = "force-dynamic";

const DISCOVERY_TIMEOUT_MS = 20_000;
const API_PRIORITY: Record<string, number> = {
  "openai-completions": 0,
  "openai-responses": 1,
  "anthropic-messages": 2,
  "google-generative-ai": 3,
};

interface EndpointGroup {
  api: string;
  baseUrl: string;
  endpoint: string;
  priority: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function endpointGroups(runtime: ModelRuntime, providerName: string): EndpointGroup[] {
  const endpoints = new Map<string, EndpointGroup>();
  for (const model of runtime.getModels(providerName)) {
    if (!model.baseUrl) continue;
    try {
      const endpoint = buildModelsListUrl(model.baseUrl, model.api).toString();
      const candidate: EndpointGroup = {
        api: model.api,
        baseUrl: model.baseUrl,
        endpoint,
        priority: API_PRIORITY[model.api] ?? 99,
      };
      const current = endpoints.get(endpoint);
      if (!current || candidate.priority < current.priority) endpoints.set(endpoint, candidate);
    } catch {
      // A malformed catalog entry must not prevent other provider endpoints from refreshing.
    }
  }
  return [...endpoints.values()];
}

class ModelIdentityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelIdentityConflictError";
  }
}

function throwOnModelEndpointConflicts(
  providerName: string,
  models: Iterable<unknown>,
  provider: Record<string, unknown>,
): void {
  const conflicts = collectModelEndpointConflicts(providerName, models, provider);
  if (conflicts.length > 0) {
    throw new ModelIdentityConflictError(
      `Cannot import models: the same provider/model ID cannot use multiple endpoints (${conflicts.join("; ")})`,
    );
  }
}

interface MergeResult {
  importedCount: number;
  updatedCount: number;
  changed: boolean;
}

function mergeDiscoveredModels(
  providerName: string,
  discovered: DiscoveredModel[],
  runtime: ModelRuntime,
): MergeResult {
  const document = readModelsJson();
  const providers = isRecord(document.providers) ? { ...document.providers } : {};
  const rawProvider = providers[providerName];
  const provider = isRecord(rawProvider) ? { ...rawProvider } : {};
  const currentModels = Array.isArray(provider.models)
    ? provider.models.map((model) => isRecord(model) ? { ...model } : model)
    : [];
  const runtimeModels = runtime.getModels(providerName);
  const runtimeProvider = runtime.getProvider(providerName) as unknown as Record<string, unknown> | undefined;
  const identityProvider = { ...provider };
  if (!(typeof identityProvider.api === "string" && identityProvider.api.trim())) {
    const runtimeApi = runtimeModels
      .map((model) => (model as unknown as Record<string, unknown>).api)
      .find((api): api is string => typeof api === "string" && api.trim().length > 0);
    if (runtimeApi) identityProvider.api = runtimeApi;
  }
  if (!(typeof identityProvider.baseUrl === "string" && identityProvider.baseUrl.trim())) {
    const runtimeBaseUrl = typeof runtimeProvider?.baseUrl === "string" && runtimeProvider.baseUrl.trim()
      ? runtimeProvider.baseUrl
      : runtimeModels
        .map((model) => (model as unknown as Record<string, unknown>).baseUrl)
        .find((baseUrl): baseUrl is string => typeof baseUrl === "string" && baseUrl.trim().length > 0);
    if (runtimeBaseUrl) identityProvider.baseUrl = runtimeBaseUrl;
  }
  throwOnModelEndpointConflicts(providerName, [
    ...currentModels,
    ...runtimeModels,
    ...discovered,
  ], identityProvider);
  const configured = new Map<string, number>();
  currentModels.forEach((model, index) => {
    if (!isRecord(model)) return;
    const key = modelIdentity(providerName, model, identityProvider);
    if (key && !configured.has(key)) configured.set(key, index);
  });
  const known = new Set<string>();
  for (const model of runtimeModels) {
    const key = modelIdentity(providerName, model as unknown as Record<string, unknown>, identityProvider);
    if (key) known.add(key);
  }
  const additions: Record<string, unknown>[] = [];
  let updatedCount = 0;

  for (const model of discovered) {
    const key = modelIdentity(providerName, model as unknown as Record<string, unknown>, identityProvider);
    if (!key) continue;
    const currentIndex = configured.get(key);
    if (currentIndex !== undefined) {
      const current = currentModels[currentIndex];
      if (!isRecord(current)) continue;
      const merged = mergeDiscoveredModelMetadata(current as unknown as DiscoveredModel, model);
      if (JSON.stringify(merged) !== JSON.stringify(current)) {
        currentModels[currentIndex] = merged;
        updatedCount += 1;
      }
      continue;
    }
    if (known.has(key)) continue;
    configured.set(key, currentModels.length + additions.length);
    additions.push(discoveredModelToConfig(model));
  }

  if (additions.length === 0 && updatedCount === 0) {
    return { importedCount: 0, updatedCount: 0, changed: false };
  }
  providers[providerName] = { ...provider, models: [...currentModels, ...additions] };
  writeModelsJson({ ...document, providers });
  return { importedCount: additions.length, updatedCount, changed: true };
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { providerName?: unknown };
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName) return NextResponse.json({ error: "providerName is required" }, { status: 400 });

    // Validate the existing file before model runtime discovery. A damaged or
    // unreadable file is never treated as an empty provider map.
    readModelsJson();

    const runtime = await ModelRuntime.create();
    installOpenAIProviderAliases(runtime);
    const provider = runtime.getProvider(providerName);
    if (!provider) return NextResponse.json({ error: `Unknown provider: ${providerName}` }, { status: 404 });
    if (!provider.auth.apiKey) {
      return NextResponse.json({ error: `${providerName} does not support API key discovery` }, { status: 400 });
    }

    const auth = await runtime.getAuth(providerName);
    if (!auth?.auth.apiKey) return NextResponse.json({ error: `No API key found for "${providerName}"` }, { status: 400 });

    const groups = endpointGroups(runtime, providerName);
    if (groups.length === 0) return NextResponse.json({ error: "No model-list endpoint is known for this provider" }, { status: 400 });

    const results = await Promise.all(groups.map(async (group) => {
      try {
        const response = await fetch(group.endpoint, {
          cache: "no-store",
          headers: buildModelDiscoveryHeaders(group.api, auth.auth.apiKey, auth.auth.headers),
          signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        });
        if (!response.ok) return { group, models: [], error: `HTTP ${response.status}` };
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          return { group, models: [], error: "invalid JSON" };
        }
        return {
          group,
          models: parseDiscoveredModels(payload).map((model) => ({
            ...model,
            api: group.api,
            baseUrl: group.baseUrl,
          })),
        };
      } catch (error) {
        return { group, models: [], error: error instanceof Error ? error.message : String(error) };
      }
    }));

    const discovered = new Map<string, DiscoveredModel>();
    for (const result of results) {
      for (const model of result.models) {
        const key = modelDiscoveryKey(model);
        const existing = discovered.get(key);
        discovered.set(key, existing ? mergeDiscoveredModelMetadata(existing, model) : model);
      }
    }
    const failures = results.filter((result) => result.error).map((result) => `${result.group.endpoint}: ${result.error}`);
    if (discovered.size === 0) {
      return NextResponse.json({ error: failures.join("; ") || "No models found in the upstream response" }, { status: 502 });
    }

    const models = [...discovered.values()];
    const mergeResult = mergeDiscoveredModels(providerName, models, runtime);
    const runtimeRefresh = mergeResult.changed
      ? await refreshRpcSessionModels({ timeoutMs: MODEL_RUNTIME_REFRESH_TIMEOUT_MS })
      : undefined;
    return NextResponse.json({
      providerName,
      displayName: provider.name,
      models,
      importedCount: mergeResult.importedCount,
      updatedCount: mergeResult.updatedCount,
      endpoints: groups.map((group) => group.endpoint),
      ...(runtimeRefresh ? { runtimeRefresh } : {}),
      ...(failures.length > 0 ? { warnings: failures } : {}),
    });
  } catch (error) {
    if (error instanceof ModelIdentityConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof DOMException && error.name === "TimeoutError" ? 504 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
