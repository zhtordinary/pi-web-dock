import type { Model, Provider } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadCodexAffinityAdapter } from "../bin/codex-cache-affinity.cjs";
import { PROMPT_CACHE_LINEAGE_MODEL, PROMPT_CACHE_LINEAGE_PROVIDER } from "./prompt-cache-lineage";

export { loadCodexAffinityAdapter, patchCodexAffinitySource } from "../bin/codex-cache-affinity.cjs";

/** Install only for lineage sessions and leave explicitly registered providers untouched. */
export async function installCodexCacheAffinityTransport(runtime: ModelRuntime): Promise<void> {
  if (runtime.getRegisteredNativeProvider(PROMPT_CACHE_LINEAGE_PROVIDER) || runtime.getRegisteredProviderConfig(PROMPT_CACHE_LINEAGE_PROVIDER)) return;
  const base = runtime.getProvider(PROMPT_CACHE_LINEAGE_PROVIDER);
  if (!base || !runtime.getModel(PROMPT_CACHE_LINEAGE_PROVIDER, PROMPT_CACHE_LINEAGE_MODEL)) return;
  const adapter = await loadCodexAffinityAdapter();
  if (runtime.getRegisteredNativeProvider(PROMPT_CACHE_LINEAGE_PROVIDER) || runtime.getRegisteredProviderConfig(PROMPT_CACHE_LINEAGE_PROVIDER)) return;
  const provider: Provider = {
    ...base,
    stream(model, context, options) {
      return model.api === "openai-codex-responses" && model.id === PROMPT_CACHE_LINEAGE_MODEL
        ? adapter.stream(model as Model<"openai-codex-responses">, context, options)
        : base.stream(model, context, options);
    },
    streamSimple(model, context, options) {
      return model.api === "openai-codex-responses" && model.id === PROMPT_CACHE_LINEAGE_MODEL
        ? adapter.streamSimple(model as Model<"openai-codex-responses">, context, options)
        : base.streamSimple(model, context, options);
    },
  };
  runtime.registerNativeProvider(provider);
}
