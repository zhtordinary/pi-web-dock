import type { ExtensionAPI, InlineExtension, SessionManager } from "@earendil-works/pi-coding-agent";
import { BUILTIN_RUNTIME_EXTENSION_NAMES } from "./builtin-runtime-extensions";

export type FastModeSelection = "default" | "fast" | "standard";

export interface FastModeStatus {
  mode: FastModeSelection;
  enabled: boolean;
  supported: boolean;
}

export interface FastModeModelLike {
  id?: string;
  api?: string;
  samplingParams?: Record<string, unknown>;
}

export const FAST_MODE_CUSTOM_TYPE = "pi-web:fast-mode";
export const FAST_MODE_SERVICE_TIER = "priority";
const FAST_MODE_SELECTIONS = new Set<FastModeSelection>(["default", "fast", "standard"]);

export function isFastModeSupported(model: FastModeModelLike | null | undefined): boolean {
  return (model?.api === "openai-responses" || model?.api === "openai-codex-responses")
    && (model?.id ?? "").toLowerCase().includes("gpt");
}

export function isFastModeDefault(model: FastModeModelLike | null | undefined): boolean {
  if (!isFastModeSupported(model)) return false;
  const serviceTier = model?.samplingParams?.service_tier;
  return serviceTier === FAST_MODE_SERVICE_TIER || serviceTier === "fast";
}

export function fastModeStatus(
  mode: FastModeSelection,
  model: FastModeModelLike | null | undefined,
): FastModeStatus {
  const supported = isFastModeSupported(model);
  return {
    mode,
    supported,
    enabled: supported && (mode === "fast" || (mode === "default" && isFastModeDefault(model))),
  };
}

export function parseFastModeSelection(value: unknown): FastModeSelection | undefined {
  return typeof value === "string" && FAST_MODE_SELECTIONS.has(value as FastModeSelection)
    ? value as FastModeSelection
    : undefined;
}

export function setFastModeDefault<T extends FastModeModelLike>(model: T, enabled: boolean): T {
  const samplingParams = { ...(model.samplingParams ?? {}) };
  if (enabled) samplingParams.service_tier = FAST_MODE_SERVICE_TIER;
  else delete samplingParams.service_tier;
  return {
    ...model,
    samplingParams: Object.keys(samplingParams).length > 0 ? samplingParams : undefined,
  };
}

export function applyFastModeToPayload(
  payload: unknown,
  mode: FastModeSelection,
  model: FastModeModelLike | null | undefined,
): unknown {
  if (mode === "default") {
    if (isFastModeSupported(model) && typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
      const currentTier = (payload as Record<string, unknown>).service_tier;
      if (currentTier === "fast") {
        return { ...(payload as Record<string, unknown>), service_tier: FAST_MODE_SERVICE_TIER };
      }
    }
    return payload;
  }
  if (!isFastModeSupported(model) || typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return payload;
  }
  const next = { ...(payload as Record<string, unknown>) };
  if (mode === "fast") next.service_tier = FAST_MODE_SERVICE_TIER;
  else delete next.service_tier;
  return next;
}

export function readSessionFastMode(entries: readonly unknown[]): FastModeSelection {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (candidate.type !== "custom" || candidate.customType !== FAST_MODE_CUSTOM_TYPE) continue;
    if (typeof candidate.data !== "object" || candidate.data === null || Array.isArray(candidate.data)) continue;
    const data = candidate.data as { version?: unknown; mode?: unknown };
    if (data.version !== 1) continue;
    const mode = parseFastModeSelection(data.mode);
    if (mode) return mode;
  }
  return "default";
}

export function appendSessionFastMode(sessionManager: SessionManager, mode: FastModeSelection): void {
  sessionManager.appendCustomEntry(FAST_MODE_CUSTOM_TYPE, { version: 1, mode });
}

export function createFastModeExtension(state: { mode: FastModeSelection }): InlineExtension {
  return {
    name: BUILTIN_RUNTIME_EXTENSION_NAMES.fastMode,
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      const responseTiers = new Map<string, string>();
      const responseKey = (provider: string, api: string, id: string) => JSON.stringify([provider, api, id]);
      pi.on("provider_stream_event", (event) => {
        if (event.api !== "openai-responses" && event.api !== "openai-codex-responses") return;
        const data = event.data as { type?: unknown; response?: { id?: unknown; service_tier?: unknown } } | null;
        if (!data || !["response.done", "response.completed", "response.incomplete", "response.failed"].includes(String(data.type))) return;
        const response = data.response;
        if (typeof response?.id !== "string" || typeof response.service_tier !== "string" || !response.service_tier.trim()) return;
        responseTiers.set(responseKey(event.provider, event.api, response.id), response.service_tier.trim().toLowerCase());
      });
      pi.on("message_end", (event) => {
        if (event.message.role !== "assistant" || !event.message.responseId) return;
        const key = responseKey(event.message.provider, event.message.api, event.message.responseId);
        const tier = responseTiers.get(key);
        responseTiers.delete(key);
        if (!tier) return;
        // Persist observed processing, not the UI selection: Fast requests can downgrade.
        const message = { ...event.message, service_tier: tier, response_service_tier: tier };
        return { message };
      });
      pi.on("agent_end", () => { responseTiers.clear(); });
      pi.on("session_shutdown", () => { responseTiers.clear(); });
      pi.on("before_provider_request", (event, context) =>
        applyFastModeToPayload(event.payload, state.mode, context.model)
      );
    },
  };
}
