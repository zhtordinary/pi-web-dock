import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

/** Reader-owned session header field. It is not a runtime or transport identity. */
export const PROMPT_CACHE_LINEAGE_HEADER = "promptCacheLineage";
export const PROMPT_CACHE_LINEAGE_EXTENSION_NAME = "pi-web-prompt-cache-lineage";
export const PROMPT_CACHE_LINEAGE_PROVIDER = "openai-codex";
export const PROMPT_CACHE_LINEAGE_MODEL = "gpt-5.6-luna";
export const PROMPT_CACHE_KEY_MAX_LENGTH = 64;
export const PROMPT_CACHE_AFFINITY = Symbol.for("pi-web:prompt-cache-affinity");

export interface PromptCacheLineageHeader {
  [PROMPT_CACHE_LINEAGE_HEADER]?: unknown;
}

/**
 * Keep the same bounded, string-key shape as Pi's Codex adapter. Invalid
 * persisted metadata is ignored instead of looking up another session.
 */
export function normalizePromptCacheKey(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const key = Array.from(value);
  if (key.length > PROMPT_CACHE_KEY_MAX_LENGTH) return undefined;
  return value;
}

export function readPromptCacheLineage(header: unknown): string | undefined {
  if (!header || typeof header !== "object" || Array.isArray(header)) return undefined;
  return normalizePromptCacheKey((header as PromptCacheLineageHeader)[PROMPT_CACHE_LINEAGE_HEADER]);
}

/** The key Pi's locked Codex adapter uses when a session has no lineage field. */
export function effectivePromptCacheKey(sessionId: string, header?: unknown): string | undefined {
  return readPromptCacheLineage(header) ?? normalizePromptCacheKey(sessionId);
}

/** The durable key copied into a new session header. */
export function promptCacheLineageForCopy(sourceSessionId: string, sourceHeader?: unknown): string | undefined {
  return effectivePromptCacheKey(sourceSessionId, sourceHeader);
}

function isTargetModel(model: unknown): boolean {
  if (!model || typeof model !== "object" || Array.isArray(model)) return false;
  const candidate = model as { provider?: unknown; id?: unknown };
  return candidate.provider === PROMPT_CACHE_LINEAGE_PROVIDER && candidate.id === PROMPT_CACHE_LINEAGE_MODEL;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Route the inherited cache prefix without changing session or request identity.
 * Pi remains authoritative for cache enablement, input ordering and tools.
 */
export function applyPromptCacheLineage<T>(
  payload: T,
  lineageKey: string | undefined,
  model: unknown,
): T {
  if (!lineageKey || !isTargetModel(model) || !isRecord(payload)) return payload;
  // Pi omits prompt_cache_key when cacheRetention is "none". Do not turn a
  // disabled-cache request back on, and do not infer cache state elsewhere.
  if (typeof payload.prompt_cache_key !== "string") return payload;
  return { ...payload, prompt_cache_key: lineageKey, [PROMPT_CACHE_AFFINITY]: lineageKey } as T;
}

export function createPromptCacheLineageExtension(lineageKey: string | undefined): InlineExtension {
  return {
    name: PROMPT_CACHE_LINEAGE_EXTENSION_NAME,
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.on("before_provider_request", (event, context) =>
        applyPromptCacheLineage(event.payload, lineageKey, context.model)
      );
    },
  };
}
