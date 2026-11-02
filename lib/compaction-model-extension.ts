import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { compact, estimateTokens, type InlineExtension, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { BUILTIN_RUNTIME_EXTENSION_NAMES } from "./builtin-runtime-extensions";
import { readCompactionModel } from "./compaction-model";
import { readCompactionSettings } from "./compaction-model-settings";
import { getModelThinkingDefaults, readModelsConfig } from "./models-config-store";
import { MODEL_THINKING_DEFAULT_EVENT, resolveDefaultThinkingLevel, type ModelThinkingDefaultRequest } from "./thinking-level";

function modelDefaultLevel(model: Model<Api>, pin?: string) {
  const levels = getSupportedThinkingLevels(model);
  const defaults = getModelThinkingDefaults(readModelsConfig());
  const selected = resolveDefaultThinkingLevel(levels, defaults[`${model.provider}/${model.id}`], pin) ?? "off";
  return clampThinkingLevel(model, selected);
}

export function createCompactionModelExtension(settings: Pick<SettingsManager, "getRetrySettings">): InlineExtension {
  return {
    name: BUILTIN_RUNTIME_EXTENSION_NAMES.compactionModel,
    hidden: true,
    factory: (pi) => {
      const unsubscribe = pi.events?.on(MODEL_THINKING_DEFAULT_EVENT, (value) => {
        if (!value || typeof value !== "object") return;
        const request = value as ModelThinkingDefaultRequest;
        if (typeof request.provider !== "string" || typeof request.modelId !== "string" || !Array.isArray(request.levels)) return;
        try {
          const defaults = getModelThinkingDefaults(readModelsConfig());
          request.level = resolveDefaultThinkingLevel(request.levels, defaults[`${request.provider}/${request.modelId}`], request.pin) ?? "off";
        } catch {
          request.error = "Model thinking default is unavailable";
        }
      });
      pi.on("session_shutdown", () => { unsubscribe?.(); });
      pi.on("session_before_compact", async (event, ctx) => {
        try {
          const previous = [...event.branchEntries].reverse().find((entry) => entry.type === "compaction");
          // SDK skips extension-owned file lists; ours keep the SDK's format across model changes.
          if (previous?.type === "compaction" && readCompactionModel(previous.details)) {
            const details = previous.details as { readFiles?: unknown; modifiedFiles?: unknown };
            for (const [values, target] of [[details.readFiles, event.preparation.fileOps.read], [details.modifiedFiles, event.preparation.fileOps.edited]] as const) {
              if (Array.isArray(values)) for (const path of values) if (typeof path === "string") target.add(path);
            }
          }
          const { model: selected, thinkingLevel } = await readCompactionSettings();
          event.signal.throwIfAborted();
          if (!selected && !thinkingLevel) return;
          const model = selected ? ctx.modelRegistry.find(selected.provider, selected.modelId) : ctx.model;
          if (!model || model.api === "pi-virtual") throw new Error(`Compression model not available: ${selected ? `${selected.provider}/${selected.modelId}` : "session model"}`);
          const levels = getSupportedThinkingLevels(model);
          if (thinkingLevel && thinkingLevel !== "auto" && !levels.includes(thinkingLevel)) {
            throw new Error(`Compression model does not support thinking level ${thinkingLevel}`);
          }
          const pin = ctx.scopedModels?.find((item) => item.model.provider === model.provider && item.model.id === model.id)?.thinkingLevel;
          const effectiveThinking = thinkingLevel === "auto" ? modelDefaultLevel(model, pin) : clampThinkingLevel(model, thinkingLevel ?? "off");
          let attribution = { provider: model.provider, modelId: model.id };
          const result = await compact(
            event.preparation, model, undefined, undefined, event.customInstructions, event.signal,
            effectiveThinking,
            async (requestModel, context, options) => {
              const inputTokens = context.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
              if (inputTokens + (options?.maxTokens ?? 0) + 1024 > requestModel.contextWindow) {
                throw new Error(`Compression model context is too small: ${requestModel.provider}/${requestModel.id} (${requestModel.contextWindow} tokens)`);
              }
              const stream = ctx.modelRegistry.streamSimple(requestModel, context, { ...options, cacheRetention: "none" });
              const response = await stream.result();
              if (response.stopReason === "aborted") throw new Error("Compression cancelled");
              if (response.stopReason !== "error" && response.stopReason !== "length"
                && !response.content.some((block) => block.type === "text" && block.text.trim())) {
                throw new Error("Compression model returned an empty summary");
              }
              attribution = { provider: response.provider, modelId: response.model };
              return stream;
            },
            undefined, settings.getRetrySettings(),
          );
          event.signal.throwIfAborted();
          return { compaction: {
            ...result,
            details: { ...(result.details as object), piWebCompaction: { version: 1, ...attribution } },
          } };
        } catch (error) {
          // Throwing from this hook falls through to the SDK default, potentially billing another model.
          if (!event.signal.aborted) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          return { cancel: true };
        }
      });
    },
  };
}
