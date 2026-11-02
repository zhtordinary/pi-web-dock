import { statSync } from "node:fs";
import { readCompactionModel } from "./compaction-model";
import { calculateContextTokens, estimateTokens, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionContextInfo, ContextUsage } from "./pi-types";
import type { SessionEntry } from "./types";
import { getModelsConfigPath } from "./models-config-store";

let readOnlyModelRuntime: Promise<ModelRuntime> | undefined;
let readOnlyModelRuntimeLoadedAt = 0;

export function invalidateReadOnlyModelRuntime(): void {
  readOnlyModelRuntime = undefined;
  readOnlyModelRuntimeLoadedAt = 0;
}

export function getReadOnlyModelRuntime(): Promise<ModelRuntime> {
  const modelsPath = getModelsConfigPath();
  let modelsMtime: number | null = null;
  try {
    modelsMtime = statSync(modelsPath).mtimeMs;
  } catch {
    modelsMtime = null;
  }
  if (readOnlyModelRuntime && modelsMtime !== null && modelsMtime > readOnlyModelRuntimeLoadedAt) {
    readOnlyModelRuntime = undefined;
  }
  if (!readOnlyModelRuntime) {
    readOnlyModelRuntimeLoadedAt = Date.now();
    readOnlyModelRuntime = ModelRuntime.create({ refreshOnCreate: false }).catch((error) => {
      readOnlyModelRuntime = undefined;
      readOnlyModelRuntimeLoadedAt = 0;
      throw error;
    });
  }
  return readOnlyModelRuntime;
}


function hasUsableAssistantUsage(entry: SessionEntry): boolean {
  if (entry.type !== "message" || entry.message.role !== "assistant") return false;
  const message = entry.message;
  if (message.stopReason === "aborted" || message.stopReason === "error" || !message.usage) return false;
  return calculateContextTokens(message.usage as Parameters<typeof calculateContextTokens>[0]) > 0;
}

function estimateContextTokens(messages: readonly AgentMessage[]): number {
  let lastUsageIndex = -1;
  let usageTokens = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error" || !message.usage) continue;
    const tokens = calculateContextTokens(message.usage as Parameters<typeof calculateContextTokens>[0]);
    if (tokens <= 0) continue;
    lastUsageIndex = i;
    usageTokens = tokens;
    break;
  }

  if (lastUsageIndex < 0) {
    return messages.reduce((total, message) => total + estimateTokens(message), 0);
  }
  return usageTokens + messages.slice(lastUsageIndex + 1).reduce((total, message) => total + estimateTokens(message), 0);
}

/** Resolve each compaction marker to its historical model context window. */
export function getCompactionContextInfo(
  branchEntries: readonly SessionEntry[],
  modelRuntime: Pick<ModelRuntime, "getModel">,
): Record<string, CompactionContextInfo> {
  const result: Record<string, CompactionContextInfo> = {};
  let currentModel: { provider: string; modelId: string } | undefined;

  for (const entry of branchEntries) {
    if (entry.type === "model_change") {
      currentModel = { provider: entry.provider, modelId: entry.modelId };
      continue;
    }
    if (entry.type === "message" && entry.message.role === "assistant") {
      currentModel = { provider: entry.message.provider, modelId: entry.message.model };
      continue;
    }
    if (entry.type !== "compaction" || !Number.isFinite(entry.tokensBefore) || entry.tokensBefore < 0) continue;

    const contextProvider = entry.provider ?? currentModel?.provider;
    const contextModel = entry.model ?? currentModel?.modelId;
    const summarizer = readCompactionModel(entry.details);
    const provider = summarizer?.provider ?? contextProvider;
    const modelId = summarizer?.modelId ?? contextModel;
    const contextWindow = contextProvider && contextModel
      ? modelRuntime.getModel(contextProvider, contextModel)?.contextWindow
      : undefined;
    result[entry.id] = {
      tokensBefore: entry.tokensBefore,
      contextWindow: typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
        ? contextWindow
        : null,
      ...(provider ? { provider } : {}),
      ...(modelId ? { model: modelId } : {}),
    };
  }

  return result;
}

/** Estimate current active-branch context usage without creating an AgentSession. */
export function estimateSessionContextUsage(
  messages: readonly AgentMessage[],
  branchEntries: readonly SessionEntry[],
  contextWindow: number,
): ContextUsage | null {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;

  for (let i = branchEntries.length - 1; i >= 0; i -= 1) {
    if (branchEntries[i].type !== "compaction") continue;
    // SDK cannot know post-compaction size until a valid assistant response;
    // keep that same unknown state instead of showing a misleading estimate.
    if (!branchEntries.slice(i + 1).some(hasUsableAssistantUsage)) {
      return { tokens: null, contextWindow, percent: null };
    }
    break;
  }

  const tokens = estimateContextTokens(messages);
  return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
}
