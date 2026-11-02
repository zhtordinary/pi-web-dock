export const THINKING_LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type SupportedThinkingLevel = (typeof THINKING_LEVEL_ORDER)[number];
export type ThinkingSelection = "auto" | SupportedThinkingLevel;
export const MODEL_THINKING_DEFAULT_EVENT = "pi-web:model-thinking-default:v1";

export interface ModelThinkingDefaultRequest {
  provider: string;
  modelId: string;
  levels: string[];
  pin?: string;
  level?: SupportedThinkingLevel;
  error?: string;
}

export function getThinkingChoices(levels: readonly string[] | null | undefined): ThinkingSelection[] {
  return ["auto", ...THINKING_LEVEL_ORDER.filter((level) => !levels || levels.includes(level))];
}

export function maxSupportedThinkingLevel(
  levels: readonly string[] | null | undefined,
): SupportedThinkingLevel | null {
  if (!levels || levels.length === 0) return null;
  for (let i = THINKING_LEVEL_ORDER.length - 1; i >= 0; i--) {
    const level = THINKING_LEVEL_ORDER[i];
    if (levels.includes(level)) return level;
  }
  return null;
}

export function resolveDefaultThinkingLevel(
  levels: readonly string[] | null | undefined,
  defaultLevel?: string | null,
  fallbackPin?: string | null,
): SupportedThinkingLevel | null {
  if (defaultLevel && levels?.includes(defaultLevel)) return defaultLevel as SupportedThinkingLevel;
  if (fallbackPin) return fallbackPin as SupportedThinkingLevel;
  return maxSupportedThinkingLevel(levels);
}
