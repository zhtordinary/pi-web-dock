import { createHash } from "crypto";

/**
 * The provider session for a Side Ask is synthetic. Keep it stable for the
 * same parent Reader session and Side Ask scope, while preventing a different
 * model or branch from resuming the previous provider conversation.
 */
export interface QuickAskProviderSessionIdentity {
  parentSessionId: string;
  threadId: string;
  branchId: string;
  provider: string;
  model: string;
}

export function createQuickAskProviderSessionId(
  identity: QuickAskProviderSessionIdentity,
): string {
  const key = [
    "pi-web-side-ask-v1",
    identity.parentSessionId,
    identity.threadId,
    identity.branchId,
    identity.provider,
    identity.model,
  ];
  return `pi-web-side-ask-${createHash("sha256").update(JSON.stringify(key)).digest("hex")}`;
}

const AFFINITY_SUPPORTED_APIS = new Set([
  "openai-responses",
  "openai-completions",
  "openai-codex-responses",
  "azure-openai-responses",
]);

export function isQuickAskAffinitySupported(model: { api?: string; provider?: string }): boolean {
  if (model.provider === "claude-remote") return false;
  return Boolean(model.api && AFFINITY_SUPPORTED_APIS.has(model.api));
}

/**
 * Share only the value of the SDK-generated HTTP cache key; Provider session identity stays isolated.
 * Strict gateways reject fields the SDK did not emit, so the payload never gains a key.
 */
export function withQuickAskCacheAffinity(
  payload: unknown,
  parentSessionId: string,
  providerSessionId: string,
  model: { api?: string; provider?: string },
): Record<string, unknown> | undefined {
  if (!isQuickAskAffinitySupported(model)
    || !payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const body = payload as Record<string, unknown>;
  const parentKey = Array.from(parentSessionId).slice(0, 64).join("");
  // Pi/OpenAI limits prompt_cache_key to 64 Unicode characters.
  const scopeKey = Array.from(providerSessionId).slice(0, 64).join("");
  if (body.prompt_cache_key !== scopeKey && body.prompt_cache_key !== parentKey) return undefined;
  return { ...body, prompt_cache_key: parentKey };
}

export interface QuickAskRequestGeneration {
  readonly key: string;
  readonly controller: AbortController;
}

const activeRequests = new Map<string, QuickAskRequestGeneration>();

/** Each request owns its cancellation signal, including after supersession. */
export function beginQuickAskRequest(key: string): QuickAskRequestGeneration {
  const previous = activeRequests.get(key);
  const request = { key, controller: new AbortController() };
  activeRequests.set(key, request);
  previous?.controller.abort();
  return request;
}

export function isCurrentQuickAskRequest(request: QuickAskRequestGeneration): boolean {
  return activeRequests.get(request.key) === request;
}

export function finishQuickAskRequest(request: QuickAskRequestGeneration): void {
  if (isCurrentQuickAskRequest(request)) activeRequests.delete(request.key);
}
