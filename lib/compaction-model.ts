import { THINKING_LEVEL_ORDER, type ThinkingSelection } from "./thinking-level";

export interface CompactionModelSelection {
  provider: string;
  modelId: string;
}

export const COMPACTION_MODEL_SETTING = "piWebCompactionModel";
export const COMPACTION_THINKING_SETTING = "piWebCompactionThinkingLevel";

export function parseCompactionThinking(value: unknown): ThinkingSelection | null {
  if (value === undefined || value === null) return null;
  if (value === "auto" || (typeof value === "string" && (THINKING_LEVEL_ORDER as readonly string[]).includes(value))) {
    return value as ThinkingSelection;
  }
  throw new Error("Invalid compression thinking level");
}

export function parseCompactionModel(value: unknown): CompactionModelSelection | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid compression model");
  const selection = value as Record<string, unknown>;
  for (const key of ["provider", "modelId"] as const) {
    const field = selection[key];
    if (typeof field !== "string" || !field.trim() || field.length > 300 || /[\0\r\n]/.test(field)) {
      throw new Error("Compression model requires provider and modelId");
    }
  }
  return { provider: (selection.provider as string).trim(), modelId: (selection.modelId as string).trim() };
}

/** Reader-owned attribution, separate from the main model whose context was compacted. */
export function readCompactionModel(details: unknown): CompactionModelSelection | null {
  if (!details || typeof details !== "object") return null;
  const data = (details as { piWebCompaction?: unknown }).piWebCompaction;
  if (!data || typeof data !== "object" || (data as { version?: unknown }).version !== 1) return null;
  try { return parseCompactionModel(data); } catch { return null; }
}
