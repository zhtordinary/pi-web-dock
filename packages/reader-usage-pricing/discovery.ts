import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Only an observed provider response tier is a billing tier. */
export function observedResponseServiceTier(...sources: readonly unknown[]): string {
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    const value = (source as Record<string, unknown>).response_service_tier;
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }
  return "";
}

/** Record provider response tiers before message-end consumers price the message. */
export function observeResponseServiceTier(pi: ExtensionAPI): void {
  const tiers = new Map<string, string>();
  const keyFor = (provider: string, api: string, id: string) => JSON.stringify([provider, api, id]);
  pi.on("provider_stream_event", (event) => {
    if (event.api !== "openai-responses" && event.api !== "openai-codex-responses") return;
    const data = event.data as { type?: unknown; response?: { id?: unknown; service_tier?: unknown } } | null;
    if (!data || !["response.done", "response.completed", "response.incomplete", "response.failed"].includes(String(data.type))) return;
    const response = data.response;
    if (typeof response?.id !== "string" || typeof response.service_tier !== "string" || !response.service_tier.trim()) return;
    tiers.set(keyFor(event.provider, event.api, response.id), response.service_tier.trim().toLowerCase());
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant" || !event.message.responseId) return;
    const key = keyFor(event.message.provider, event.message.api, event.message.responseId);
    const tier = tiers.get(key);
    tiers.delete(key);
    if (!tier) return;
    return { message: { ...event.message, service_tier: tier, response_service_tier: tier } };
  });
  pi.on("agent_end", () => { tiers.clear(); });
  pi.on("session_shutdown", () => { tiers.clear(); });
}
