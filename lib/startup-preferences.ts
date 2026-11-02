import type { SettingsManager } from "@earendil-works/pi-coding-agent";

export interface ExplicitStartupPreferences {
  model?: { provider: string; modelId: string };
}

export interface EffectiveStartupPreferences {
  model?: { provider: string; modelId: string };
}

/**
 * Persist an explicit browser model selection as the default for future new sessions.
 * Session-level thinking selections remain in each session's JSONL transcript.
 */
export async function persistExplicitStartupPreferences(
  settingsManager: SettingsManager,
  explicit: ExplicitStartupPreferences,
  effective: EffectiveStartupPreferences,
): Promise<{ modelDefaultChanged: boolean }> {
  if (
    !explicit.model
    || !effective.model
    || explicit.model.provider !== effective.model.provider
    || explicit.model.modelId !== effective.model.modelId
  ) {
    return { modelDefaultChanged: false };
  }

  settingsManager.setDefaultModelAndProvider(
    effective.model.provider,
    effective.model.modelId,
  );
  await settingsManager.flush();
  return { modelDefaultChanged: true };
}
