import type { PackageSource, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PluginOverrideState, PluginOverrides } from "./api-types";
import { getEffectivePluginOverride } from "./plugin-project-status";
import { isDisabledPackage, packageSource, setPackageEntryDisabled } from "./plugin-package-state";

export const PLUGIN_OVERRIDES_SETTING = "piWebPluginOverrides";
export const PLUGIN_SKILL_OVERRIDES_SETTING = "piWebPluginSkillOverrides";

type SkillOverrideMap = Record<string, Record<string, PluginOverrideState>>;
type SettingsWithPackages = {
  packages?: PackageSource[];
  [key: string]: unknown;
};


function readSettingsOverrides(settings: SettingsWithPackages): PluginOverrides {
  const raw = settings[PLUGIN_OVERRIDES_SETTING];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const overrides: PluginOverrides = {};
  for (const [source, state] of Object.entries(raw)) {
    if ((state === "enabled" || state === "disabled") && source.trim()) {
      overrides[source] = state;
    }
  }
  return overrides;
}

function readSkillOverrides(settings: SettingsWithPackages): SkillOverrideMap {
  const raw = settings[PLUGIN_SKILL_OVERRIDES_SETTING];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const overrides: SkillOverrideMap = {};
  for (const [source, entries] of Object.entries(raw)) {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    const sourceOverrides: Record<string, PluginOverrideState> = {};
    for (const [resourceKey, state] of Object.entries(entries)) {
      if ((state === "enabled" || state === "disabled") && resourceKey.trim()) {
        sourceOverrides[resourceKey] = state;
      }
    }
    if (Object.keys(sourceOverrides).length > 0 && source.trim()) {
      overrides[source] = sourceOverrides;
    }
  }
  return overrides;
}

export function getPluginOverrides(settingsManager: SettingsManager): PluginOverrides {
  return readSettingsOverrides(settingsManager.getProjectSettings() as SettingsWithPackages);
}

export function getPluginSkillOverrides(settingsManager: SettingsManager): SkillOverrideMap {
  return readSkillOverrides(settingsManager.getProjectSettings() as SettingsWithPackages);
}

function applySkillOverridesToPackage(
  entry: PackageSource,
  overrides: Record<string, PluginOverrideState> | undefined,
): PackageSource {
  if (!overrides || Object.keys(overrides).length === 0) return entry;
  const enabledKeys = Object.entries(overrides)
    .filter(([, state]) => state === "enabled")
    .map(([resourceKey]) => resourceKey);
  if (isDisabledPackage(entry) && enabledKeys.length === 0) return entry;
  const existing = typeof entry === "string"
    ? []
    : isDisabledPackage(entry)
      ? ["!**"]
      : (entry.skills ?? []);
  const overrideKeys = new Set(Object.keys(overrides));
  const retained = existing.filter((pattern) => {
    if (!pattern.startsWith("+") && !pattern.startsWith("-")) return true;
    return !overrideKeys.has(pattern.slice(1));
  });
  const overridePatterns = Object.entries(overrides).map(([resourceKey, state]) =>
    `${state === "enabled" ? "+" : "-"}${resourceKey}`,
  );
  const skills = [...retained, ...overridePatterns];
  if (typeof entry === "string") return { source: entry, skills };
  return { ...entry, skills };
}

function applySkillOverridesToPackages(
  packages: PackageSource[],
  overrides: SkillOverrideMap,
): PackageSource[] {
  return packages.map((entry) => applySkillOverridesToPackage(entry, overrides[packageSource(entry)]));
}

function effectiveSettings(
  settingsManager: SettingsManager,
  includeProjectOverrides = true,
): {
  global: SettingsWithPackages;
  project: SettingsWithPackages;
} {
  const global = settingsManager.getGlobalSettings() as SettingsWithPackages;
  const project = settingsManager.getProjectSettings() as SettingsWithPackages;
  const packageOverrides = includeProjectOverrides ? readSettingsOverrides(project) : {};
  const skillOverrides = includeProjectOverrides ? readSkillOverrides(project) : {};
  const globalPackages = [...(global.packages ?? [])];
  for (const [source, state] of Object.entries(packageOverrides)) {
    const index = globalPackages.findIndex((entry) => packageSource(entry) === source);
    if (index < 0) continue;
    const skillOverridesForSource = skillOverrides[source];
    if (state === "disabled") {
      const enabledSkills = skillOverridesForSource
        ? Object.entries(skillOverridesForSource)
            .filter(([, skillState]) => skillState === "enabled")
            .map(([resourceKey]) => `+${resourceKey}`)
        : [];
      if (enabledSkills.length > 0) {
        globalPackages[index] = {
          source,
          extensions: [],
          prompts: [],
          themes: [],
          skills: ["!**", ...enabledSkills],
        };
      } else {
        globalPackages.splice(index, 1);
      }
    } else if (isDisabledPackage(globalPackages[index])) {
      globalPackages[index] = setPackageEntryDisabled(globalPackages[index], false);
    }
  }
  return {
    global: {
      ...global,
      packages: includeProjectOverrides
        ? applySkillOverridesToPackages(globalPackages, skillOverrides)
        : globalPackages,
    },
    project: {
      ...project,
      packages: includeProjectOverrides
        ? applySkillOverridesToPackages(project.packages ?? [], skillOverrides)
        : project.packages,
    },
  };
}

export function createPluginOverrideSettingsManager(
  settingsManager: SettingsManager,
  options?: { includeProjectOverrides?: boolean },
): SettingsManager {
  const includeProjectOverrides = options?.includeProjectOverrides ?? true;
  return new Proxy(settingsManager, {
    get(target, property) {
      if (property === "getGlobalSettings") {
        return () => effectiveSettings(target, includeProjectOverrides).global;
      }
      if (property === "getProjectSettings") {
        return () => effectiveSettings(target, includeProjectOverrides).project;
      }
      if (property === "getPackages") {
        return () => {
          const settings = effectiveSettings(target, includeProjectOverrides);
          return [...(settings.project.packages ?? []), ...(settings.global.packages ?? [])];
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SettingsManager;
}

function updateProjectSettingMap(
  settingsManager: SettingsManager,
  setting: string,
  update: (values: Record<string, unknown>) => void,
): void {
  const manager = settingsManager as unknown as {
    updateProjectSettings?: (field: string, callback: (settings: SettingsWithPackages) => void) => void;
  };
  if (!manager.updateProjectSettings) {
    throw new Error("Reader project settings overrides are not supported by this Pi settings manager");
  }
  manager.updateProjectSettings(setting, (settings) => {
    const raw = settings[setting];
    const values = raw && typeof raw === "object" && !Array.isArray(raw)
      ? structuredClone(raw) as Record<string, unknown>
      : {};
    update(values);
    if (Object.keys(values).length > 0) settings[setting] = values;
    else delete settings[setting];
  });
}

function updateProjectOverrides(
  settingsManager: SettingsManager,
  update: (overrides: PluginOverrides) => void,
): void {
  updateProjectSettingMap(settingsManager, PLUGIN_OVERRIDES_SETTING, (values) => {
    const overrides: PluginOverrides = {};
    for (const [source, state] of Object.entries(values)) {
      if (state === "enabled" || state === "disabled") overrides[source] = state;
    }
    update(overrides);
    for (const key of Object.keys(values)) delete values[key];
    Object.assign(values, overrides);
  });
}

export function setPluginOverride(
  settingsManager: SettingsManager,
  source: string,
  state: PluginOverrideState,
): void {
  const normalized = source.trim();
  if (!normalized) throw new Error("Plugin source is required");
  const globalEntry = (settingsManager.getGlobalSettings() as SettingsWithPackages).packages
    ?.find((entry) => packageSource(entry) === normalized);
  const globalDisabled = globalEntry ? isDisabledPackage(globalEntry) : undefined;
  const effectiveOverride = getEffectivePluginOverride(globalDisabled, state);
  updateProjectOverrides(settingsManager, (overrides) => {
    if (effectiveOverride) overrides[normalized] = effectiveOverride;
    else delete overrides[normalized];
  });
}

export function clearPluginOverride(settingsManager: SettingsManager, source: string): void {
  const normalized = source.trim();
  if (!normalized) return;
  updateProjectOverrides(settingsManager, (overrides) => {
    delete overrides[normalized];
  });
}

export function setPluginSkillOverride(
  settingsManager: SettingsManager,
  source: string,
  resourceKey: string,
  state: PluginOverrideState,
): void {
  const normalizedSource = source.trim();
  const normalizedKey = resourceKey.trim().replaceAll("\\", "/");
  if (!normalizedSource || !normalizedKey || normalizedKey.startsWith("/") || normalizedKey.includes("../")) {
    throw new Error("Plugin skill source and resource key are required");
  }
  updateProjectSettingMap(settingsManager, PLUGIN_SKILL_OVERRIDES_SETTING, (values) => {
    const sourceValues = values[normalizedSource];
    const overrides = sourceValues && typeof sourceValues === "object" && !Array.isArray(sourceValues)
      ? sourceValues as Record<string, unknown>
      : {};
    overrides[normalizedKey] = state;
    values[normalizedSource] = overrides;
  });
}

export function clearPluginSkillOverride(
  settingsManager: SettingsManager,
  source: string,
  resourceKey: string,
): void {
  const normalizedSource = source.trim();
  const normalizedKey = resourceKey.trim().replaceAll("\\", "/");
  if (!normalizedSource || !normalizedKey) return;
  updateProjectSettingMap(settingsManager, PLUGIN_SKILL_OVERRIDES_SETTING, (values) => {
    const sourceValues = values[normalizedSource];
    if (!sourceValues || typeof sourceValues !== "object" || Array.isArray(sourceValues)) return;
    delete (sourceValues as Record<string, unknown>)[normalizedKey];
    if (Object.keys(sourceValues).length === 0) delete values[normalizedSource];
  });
}

function updateGlobalPackageSkillFilter(
  settingsManager: SettingsManager,
  source: string,
  resourceKey: string,
  state: PluginOverrideState | null,
): void {
  const settings = settingsManager.getGlobalSettings() as SettingsWithPackages;
  const packages = settings.packages ?? [];
  let found = false;
  const next = packages.map((entry): PackageSource => {
    if (packageSource(entry) !== source) return entry;
    found = true;
    const isDisabled = isDisabledPackage(entry);
    if (isDisabled && (!state || state === "disabled")) return entry;
    const existing = typeof entry === "string" ? [] : (entry.skills ?? []);
    const retained = existing.filter((pattern) => pattern !== `+${resourceKey}` && pattern !== `-${resourceKey}`);
    if (isDisabled && state === "enabled") retained.unshift("!**");
    if (state) retained.push(`${state === "enabled" ? "+" : "-"}${resourceKey}`);
    if (typeof entry === "string") return state ? { source: entry, skills: retained } : entry;
    if (retained.length === 0 && entry.autoload === undefined && entry.extensions === undefined
      && entry.prompts === undefined && entry.themes === undefined) {
      return entry.source;
    }
    return { ...entry, skills: retained };
  });
  if (!found) throw new Error("Global plugin package not found");
  settingsManager.setPackages(next);
}

/**
 * Read the explicit global skill filter for one package resource. `inherit`
 * means no Reader switch was written, so the skill file policy stays in force.
 */
export function getGlobalPluginSkillFilterState(
  settingsManager: SettingsManager,
  source: string,
  resourceKey: string,
): PluginOverrideState | "inherit" {
  const normalizedSource = source.trim();
  const normalizedKey = resourceKey.trim().replaceAll("\\", "/");
  if (!normalizedSource || !normalizedKey) return "inherit";
  const packages = (settingsManager.getGlobalSettings() as SettingsWithPackages).packages ?? [];
  const entry = packages.find((candidate) => packageSource(candidate) === normalizedSource);
  if (!entry || typeof entry === "string") return "inherit";
  let state: PluginOverrideState | "inherit" = "inherit";
  for (const pattern of entry.skills ?? []) {
    if (pattern === `+${normalizedKey}`) state = "enabled";
    else if (pattern === `-${normalizedKey}`) state = "disabled";
  }
  return state;
}

export function setGlobalPluginSkillFilter(
  settingsManager: SettingsManager,
  source: string,
  resourceKey: string,
  state: PluginOverrideState,
): void {
  updateGlobalPackageSkillFilter(settingsManager, source.trim(), resourceKey.trim().replaceAll("\\", "/"), state);
}

export function clearGlobalPluginSkillFilter(
  settingsManager: SettingsManager,
  source: string,
  resourceKey: string,
): void {
  updateGlobalPackageSkillFilter(settingsManager, source.trim(), resourceKey.trim().replaceAll("\\", "/"), null);
}
