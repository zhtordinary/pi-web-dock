import { getGlobalSettingsPath, readGlobalSettings, updateGlobalSettings } from "./global-settings-file";
import { COMPACTION_MODEL_SETTING, COMPACTION_THINKING_SETTING, parseCompactionModel, parseCompactionThinking, type CompactionModelSelection } from "./compaction-model";
import type { ThinkingSelection } from "./thinking-level";

export function readCompactionSettings() {
  return readGlobalSettings(getGlobalSettingsPath(), (settings) => ({
    model: parseCompactionModel(settings[COMPACTION_MODEL_SETTING]),
    thinkingLevel: parseCompactionThinking(settings[COMPACTION_THINKING_SETTING]),
  }));
}

export function readCompactionModelSetting() {
  return readCompactionSettings().then((settings) => settings.model);
}

export function readCompactionThinkingSetting() {
  return readGlobalSettings(getGlobalSettingsPath(), (settings) => parseCompactionThinking(settings[COMPACTION_THINKING_SETTING]));
}

export class CompactionSettingsConflictError extends Error {}

export function writeCompactionSettings(
  model: CompactionModelSelection | null,
  thinking: ThinkingSelection | null,
  expected: { model: CompactionModelSelection | null; thinkingLevel: ThinkingSelection | null },
) {
  return updateGlobalSettings(getGlobalSettingsPath(), (settings) => {
    const current = { model: parseCompactionModel(settings[COMPACTION_MODEL_SETTING]), thinkingLevel: parseCompactionThinking(settings[COMPACTION_THINKING_SETTING]) };
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new CompactionSettingsConflictError("Compression settings changed; reload and retry");
    if (model) settings[COMPACTION_MODEL_SETTING] = model;
    else delete settings[COMPACTION_MODEL_SETTING];
    if (thinking) settings[COMPACTION_THINKING_SETTING] = thinking;
    else delete settings[COMPACTION_THINKING_SETTING];
  });
}

export function writeCompactionThinkingSetting(thinking: ThinkingSelection | null) {
  return updateGlobalSettings(getGlobalSettingsPath(), (settings) => {
    if (thinking) settings[COMPACTION_THINKING_SETTING] = thinking;
    else delete settings[COMPACTION_THINKING_SETTING];
  });
}

export function writeCompactionModelSetting(model: CompactionModelSelection | null) {
  return updateGlobalSettings(getGlobalSettingsPath(), (settings) => {
    if (model) settings[COMPACTION_MODEL_SETTING] = model;
    else delete settings[COMPACTION_MODEL_SETTING];
  });
}
