import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
  type PackageSource,
} from "@earendil-works/pi-coding-agent";
import { resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import type {
  PluginDiagnostic,
  PluginOverrideState,
  PluginProjectStatus,
} from "./api-types";
import { applyPackageParentCaps, isDisabledPackage, setPackageEntryDisabled } from "./plugin-package-state";

export const PROJECT_PLUGIN_STATES_SETTING = "piWebProjectPluginStates";
export const PROJECT_PLUGIN_EXPLICIT_STATES_SETTING = "piWebProjectPluginExplicitStates";
const LEGACY_PLUGIN_OVERRIDES_SETTING = "piWebPluginOverrides";

type SettingsWithPackages = {
  packages?: PackageSource[];
  [key: string]: unknown;
};

const RESOURCE_KEYS = ["extensions", "skills", "prompts", "themes"] as const;
type ResourceKey = (typeof RESOURCE_KEYS)[number];

type ProjectPackageState = PluginOverrideState | "inherit";

export type PluginPackageScope = "user" | "project";

export interface PluginPackageIdentityOptions {
  cwd?: string;
  agentDir?: string;
  scope?: PluginPackageScope;
}

export interface ProjectPluginReconciliation {
  states: Record<string, PluginOverrideState>;
  changed: boolean;
  removedIdentities: string[];
  projectOnlyPackages: PackageSource[];
  diagnostics: PluginDiagnostic[];
}

type ProjectPluginSettingsManager = {
  getGlobalSettings: () => SettingsWithPackages;
  getProjectSettings: () => SettingsWithPackages;
  updateProjectSettings?: (
    field: string,
    update: (settings: SettingsWithPackages) => void,
  ) => void;
  flush?: () => Promise<void>;
};

const IDENTITY_MANAGER_CACHE_MAX_ENTRIES = 128;
const identityManagers = new Map<string, DefaultPackageManager>();
const projectPluginManagerTargets = new WeakMap<object, SettingsManager>();
const projectPluginStateLocks = new Map<string, Promise<void>>();

function getIdentityManager(options: PluginPackageIdentityOptions): DefaultPackageManager {
  const cwd = resolvePath(options.cwd ?? process.cwd());
  const agentDir = resolvePath(options.agentDir ?? getAgentDir());
  const key = cwd + "\0" + agentDir;
  const existing = identityManagers.get(key);
  if (existing) {
    identityManagers.delete(key);
    identityManagers.set(key, existing);
    return existing;
  }
  const manager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
  });
  identityManagers.set(key, manager);
  while (identityManagers.size > IDENTITY_MANAGER_CACHE_MAX_ENTRIES) {
    const oldest = identityManagers.keys().next().value;
    if (oldest === undefined) break;
    identityManagers.delete(oldest);
  }
  return manager;
}

/** Keep project state keys aligned with Pi's package identity implementation. */
export function getPluginPackageIdentity(
  source: string,
  options: PluginPackageIdentityOptions = {},
): string {
  const manager = getIdentityManager(options);
  return (manager as unknown as {
    getPackageIdentity: (value: string, scope?: PluginPackageScope) => string;
  }).getPackageIdentity(source.trim(), options.scope);
}

function canonicalStateKey(key: string, options: PluginPackageIdentityOptions): string {
  const trimmed = key.trim();
  if (trimmed.startsWith("local:")) return trimmed;
  return getPluginPackageIdentity(trimmed, { ...options, scope: "user" });
}

/**
 * Serialize a `local:<abs>` state key to a portable form (`local:~<rel>`) so
 * project plugin overrides survive cross-device sync. Non-home paths stay as-is.
 */
function portableLocalKey(key: string): string {
  const match = /^local:(.+)$/.exec(key);
  if (!match) return key;
  const home = homedir();
  const pathPart = match[1];
  if (pathPart === home) return "local:~";
  if (pathPart.startsWith(home + "/")) return `local:~${pathPart.slice(home.length)}`;
  return key;
}

/** Expand a portable `local:~<rel>` key to this machine's absolute path form. */
function expandLocalKey(key: string): string {
  const match = /^local:~(?:\/(.*))?$/.exec(key);
  if (!match) return key;
  const home = homedir();
  return `local:${home}${match[1] ? "/" + match[1] : ""}`;
}

function projectStateIdentity(key: string, options: PluginPackageIdentityOptions): string {
  return expandLocalKey(canonicalStateKey(key, options));
}

/** Return only project package states explicitly written by the Reader UI. */
export function getProjectPluginExplicitState(
  projectSettings: SettingsWithPackages,
  source: string,
  options: PluginPackageIdentityOptions = {},
): PluginOverrideState | undefined {
  const raw = projectSettings[PROJECT_PLUGIN_EXPLICIT_STATES_SETTING];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const identity = getPluginPackageIdentity(source, { ...options, scope: "user" });
  for (const [key, state] of Object.entries(raw)) {
    if ((state === "enabled" || state === "disabled")
      && projectStateIdentity(key, options) === identity) {
      return state;
    }
  }
  return undefined;
}

function readExplicitStateMap(
  projectSettings: SettingsWithPackages,
  options: PluginPackageIdentityOptions,
): Record<string, PluginOverrideState> {
  const raw = projectSettings[PROJECT_PLUGIN_EXPLICIT_STATES_SETTING];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const states: Record<string, PluginOverrideState> = {};
  for (const [key, value] of Object.entries(raw)) {
    if ((value === "enabled" || value === "disabled") && key.trim()) {
      states[portableLocalKey(projectStateIdentity(key, options))] = value;
    }
  }
  return states;
}
function readStateMap(
  projectSettings: SettingsWithPackages,
  options: PluginPackageIdentityOptions,
): Record<string, PluginOverrideState> {
  const raw = projectSettings[PROJECT_PLUGIN_STATES_SETTING];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const states: Record<string, PluginOverrideState> = {};
  for (const [key, value] of Object.entries(raw)) {
    if ((value !== "enabled" && value !== "disabled") || !key.trim()) continue;
    states[canonicalStateKey(key, options)] = value;
  }
  return states;
}

export function getProjectPluginStates(
  projectSettings: SettingsWithPackages,
  options: PluginPackageIdentityOptions = {},
): Record<string, PluginOverrideState> {
  return readStateMap(projectSettings, options);
}

function findStateForSource(
  states: Record<string, PluginOverrideState>,
  source: string,
  options: PluginPackageIdentityOptions,
): PluginOverrideState | undefined {
  const identity = getPluginPackageIdentity(source, { ...options, scope: "user" });
  if (states[identity]) return states[identity];
  for (const [key, state] of Object.entries(states)) {
    if (expandLocalKey(canonicalStateKey(key, options)) === identity) return state;
  }
  return undefined;
}

function findMatchingPackage(
  entries: PackageSource[],
  source: string,
  options: PluginPackageIdentityOptions,
  scope: PluginPackageScope,
  sourceScope: PluginPackageScope = scope,
): PackageSource | undefined {
  const identity = getPluginPackageIdentity(source, { ...options, scope: sourceScope });
  return entries.find((entry) => getPluginPackageIdentity(
    typeof entry === "string" ? entry : entry.source,
    { ...options, scope },
  ) === identity);
}

function isBroadResourcePattern(pattern: string): boolean {
  return pattern === "**" || pattern === "+**" || pattern === "!**" || pattern === "-**";
}

function stripResourcePattern(pattern: string): string {
  return pattern.startsWith("+") || pattern.startsWith("-") || pattern.startsWith("!")
    ? pattern.slice(1)
    : pattern;
}

/**
 * Read the project package parent state from native package patterns. Extra
 * resource-specific +/- patterns do not change the parent state.
 */
export function getProjectPackageState(entry: PackageSource | undefined): ProjectPackageState {
  if (!entry || typeof entry === "string") return "inherit";
  const states = RESOURCE_KEYS.map((key) => {
    const patterns = entry[key];
    if (!Array.isArray(patterns)) return undefined;
    const broad = patterns.filter(isBroadResourcePattern);
    const last = broad[broad.length - 1];
    if (!last) return undefined;
    return last === "**" || last === "+**" ? "enabled" : "disabled";
  });
  if (states.every((state) => state === "enabled")) return "enabled";
  if (states.every((state) => state === "disabled")) return "disabled";
  return "inherit";
}

function getProjectResourcePatterns(
  entry: PackageSource | undefined,
  key: ResourceKey,
): string[] {
  if (!entry || typeof entry === "string") return [];
  return (entry[key] ?? []).filter((pattern) => !isBroadResourcePattern(pattern));
}

function mergeProjectPackageResources(
  globalEntry: PackageSource,
  projectEntry: PackageSource | undefined,
  parentState: ProjectPackageState,
): PackageSource {
  if (parentState === "disabled") return setPackageEntryDisabled(globalEntry, true);
  let next: PackageSource = parentState === "enabled"
    ? setPackageEntryDisabled(globalEntry, false)
    : globalEntry;

  // A child project override cannot bypass a disabled parent. Keep its native
  // pattern in settings for restoration, but do not expose it to resolution.
  if (isDisabledPackage(next)) return setPackageEntryDisabled(next, true);

  for (const key of RESOURCE_KEYS) {
    const projectPatterns = getProjectResourcePatterns(projectEntry, key);
    if (projectPatterns.length === 0) continue;
    const targets = new Set(projectPatterns.map(stripResourcePattern));
    const existing = typeof next === "string" ? [] : (next[key] ?? []);
    const retained = existing.filter((pattern) => {
      if (!pattern.startsWith("+") && !pattern.startsWith("-")) return true;
      return !targets.has(stripResourcePattern(pattern));
    });
    const patterns = [...retained, ...projectPatterns];
    if (typeof next === "string") next = { source: next };
    next = { ...next, [key]: patterns } as PackageSource;
  }
  return next;
}

export function getGlobalPluginState(globalPackage: PackageSource): PluginOverrideState {
  return isDisabledPackage(globalPackage) ? "disabled" : "enabled";
}

export function getEffectiveProjectPluginState(
  globalPackage: PackageSource,
  states: Record<string, PluginOverrideState>,
  options: PluginPackageIdentityOptions = {},
): PluginOverrideState {
  return findStateForSource(states, typeof globalPackage === "string" ? globalPackage : globalPackage.source, options)
    ?? getGlobalPluginState(globalPackage);
}

export function getPluginComparison(
  projectState: PluginOverrideState,
  globalState: PluginOverrideState,
): PluginProjectStatus {
  return projectState === globalState ? "matching" : "different";
}

/**
 * Keep the old helper for older API clients while deriving status from the
 * final project state. New code uses getPluginComparison directly.
 */
export function getEffectivePluginOverride(
  globalDisabled: boolean | undefined,
  projectOverride: PluginOverrideState | undefined,
): PluginOverrideState | undefined {
  if (!projectOverride) return undefined;
  if (globalDisabled === undefined) return projectOverride;
  const overrideDisabled = projectOverride === "disabled";
  return overrideDisabled === globalDisabled ? undefined : projectOverride;
}

export function getPluginProjectStatus(
  scope: "global" | "project",
  globalDisabled: boolean | undefined,
  projectState: PluginOverrideState | undefined,
): PluginProjectStatus {
  if (scope === "project") return "project";
  const globalState: PluginOverrideState = globalDisabled ? "disabled" : "enabled";
  return getPluginComparison(projectState ?? globalState, globalState);
}

function mapsEqual(
  left: Record<string, PluginOverrideState>,
  right: Record<string, PluginOverrideState>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => left[key] === right[key]);
}

function packageSource(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

function projectOnlyPackages(
  globalPackages: PackageSource[],
  projectPackages: PackageSource[],
  options: PluginPackageIdentityOptions,
): PackageSource[] {
  const globalIdentities = new Set(globalPackages.map((entry) => getPluginPackageIdentity(
    packageSource(entry),
    { ...options, scope: "user" },
  )));
  return projectPackages.filter((entry) => !globalIdentities.has(getPluginPackageIdentity(
    packageSource(entry),
    { ...options, scope: "project" },
  )));
}

export function reconcileProjectPluginStates(
  globalPackages: PackageSource[],
  projectSettings: SettingsWithPackages,
  options: PluginPackageIdentityOptions = {},
): ProjectPluginReconciliation {
  const identityOptions = { ...options, agentDir: options.agentDir ?? getAgentDir() };
  const current = readExplicitStateMap(projectSettings, identityOptions);
  const projectPackages = projectSettings.packages ?? [];
  const next: Record<string, PluginOverrideState> = {};
  const globalEntries = new Map<string, PackageSource>();

  for (const entry of globalPackages) {
    const identity = getPluginPackageIdentity(packageSource(entry), { ...identityOptions, scope: "user" });
    if (globalEntries.has(identity)) continue;
    globalEntries.set(identity, entry);
    const existing = findStateForSource(current, packageSource(entry), identityOptions)
      ?? getGlobalPluginState(entry);
    if (existing) {
      next[portableLocalKey(identity)] = existing;
      continue;
    }
    next[portableLocalKey(identity)] = getGlobalPluginState(entry);
  }

  const removedIdentities = Object.keys(current).filter((key) => !globalEntries.has(expandLocalKey(key)));
  const projectOnly = projectOnlyPackages(globalPackages, projectPackages, identityOptions);
  const legacyPresent = Object.prototype.hasOwnProperty.call(projectSettings, LEGACY_PLUGIN_OVERRIDES_SETTING)
    || Object.prototype.hasOwnProperty.call(projectSettings, PROJECT_PLUGIN_STATES_SETTING);

  return {
    states: next,
    changed: !mapsEqual(current, next) || legacyPresent,
    removedIdentities,
    projectOnlyPackages: projectOnly,
    diagnostics: [],
  };
}

function updateProjectField(
  settingsManager: ProjectPluginSettingsManager,
  field: string,
  update: (settings: SettingsWithPackages) => void,
): void {
  if (!settingsManager.updateProjectSettings) {
    throw new Error("Reader project plugin states are not supported by this Pi settings manager");
  }
  settingsManager.updateProjectSettings(field, update);
}

export function setProjectPluginExplicitState(
  settingsManager: SettingsManager,
  source: string,
  state: PluginOverrideState,
  options: PluginPackageIdentityOptions = {},
): void {
  const rawManager = unwrapProjectPluginSettingsManager(settingsManager);
  const key = portableLocalKey(getPluginPackageIdentity(source, { ...options, scope: "user" }));
  updateProjectField(rawManager as unknown as ProjectPluginSettingsManager, PROJECT_PLUGIN_EXPLICIT_STATES_SETTING, (settings) => {
    const raw = settings[PROJECT_PLUGIN_EXPLICIT_STATES_SETTING];
    const states = raw && typeof raw === "object" && !Array.isArray(raw)
      ? structuredClone(raw) as Record<string, unknown>
      : {};
    states[key] = state;
    settings[PROJECT_PLUGIN_EXPLICIT_STATES_SETTING] = states;
  });
}

export function clearProjectPluginExplicitState(
  settingsManager: SettingsManager,
  source: string,
  options: PluginPackageIdentityOptions = {},
): void {
  const rawManager = unwrapProjectPluginSettingsManager(settingsManager);
  const projectSettings = rawManager.getProjectSettings() as SettingsWithPackages;
  if (!Object.prototype.hasOwnProperty.call(projectSettings, PROJECT_PLUGIN_EXPLICIT_STATES_SETTING)) return;
  const identity = getPluginPackageIdentity(source, { ...options, scope: "user" });
  updateProjectField(rawManager as unknown as ProjectPluginSettingsManager, PROJECT_PLUGIN_EXPLICIT_STATES_SETTING, (settings) => {
    const raw = settings[PROJECT_PLUGIN_EXPLICIT_STATES_SETTING];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const states = structuredClone(raw) as Record<string, unknown>;
    for (const key of Object.keys(states)) {
      if (projectStateIdentity(key, options) === identity) delete states[key];
    }
    if (Object.keys(states).length > 0) settings[PROJECT_PLUGIN_EXPLICIT_STATES_SETTING] = states;
    else delete settings[PROJECT_PLUGIN_EXPLICIT_STATES_SETTING];
  });
}

function removeLegacyOverrides(
  settingsManager: ProjectPluginSettingsManager,
  projectSettings: SettingsWithPackages,
): void {
  for (const field of [LEGACY_PLUGIN_OVERRIDES_SETTING, PROJECT_PLUGIN_STATES_SETTING]) {
    if (!Object.prototype.hasOwnProperty.call(projectSettings, field)) continue;
    updateProjectField(settingsManager, field, (settings) => {
      delete settings[field];
    });
  }
}

function lockKey(options: PluginPackageIdentityOptions): string {
  return resolvePath(options.cwd ?? process.cwd());
}

async function withProjectPluginStateLock<T>(
  options: PluginPackageIdentityOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const key = lockKey(options);
  const previous = projectPluginStateLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  projectPluginStateLocks.set(key, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (projectPluginStateLocks.get(key) === current) projectPluginStateLocks.delete(key);
  }
}

/** Reload must report SDK storage errors instead of presenting an old snapshot as fresh. */
export async function reloadProjectPluginSettings(settingsManager: SettingsManager): Promise<void> {
  const rawManager = unwrapProjectPluginSettingsManager(settingsManager);
  await rawManager.reload?.();
  const errors = rawManager.drainErrors?.() ?? [];
  if (errors.length > 0) throw new Error("Plugin settings reload failed", { cause: errors[0].error });
}

export async function reconcileProjectPluginSettings(
  settingsManager: SettingsManager,
  options: PluginPackageIdentityOptions = {},
): Promise<ProjectPluginReconciliation> {
  const rawManager = unwrapProjectPluginSettingsManager(settingsManager);
  return withProjectPluginStateLock(options, async () => {
    // SDK getters are snapshots. Explicit reconciliation is the reload
    // boundary for CLI/external edits; the projection itself stays read-only.
    await reloadProjectPluginSettings(rawManager);
    const projectSettings = rawManager.getProjectSettings() as SettingsWithPackages;
    const result = reconcileProjectPluginStates(
      (rawManager.getGlobalSettings() as SettingsWithPackages).packages ?? [],
      projectSettings,
      options,
    );
    return result;
  });
}

export async function setProjectPluginState(
  settingsManager: SettingsManager,
  source: string,
  state: PluginOverrideState,
  options: PluginPackageIdentityOptions = {},
): Promise<void> {
  const rawManager = unwrapProjectPluginSettingsManager(settingsManager);
  await withProjectPluginStateLock(options, async () => {
    await reloadProjectPluginSettings(rawManager);
    const globalPackages = (rawManager.getGlobalSettings() as SettingsWithPackages).packages ?? [];
    const sourceIdentity = getPluginPackageIdentity(source, { ...options, scope: "user" });
    const entry = globalPackages.find((candidate) => getPluginPackageIdentity(
      packageSource(candidate),
      { ...options, scope: "user" },
    ) === sourceIdentity);
    if (!entry) throw new Error("Global plugin package not found");
    const projectSettings = rawManager.getProjectSettings() as SettingsWithPackages;
    setProjectPluginExplicitState(rawManager, packageSource(entry), state, options);
    removeLegacyOverrides(rawManager as unknown as ProjectPluginSettingsManager, projectSettings);
    await rawManager.flush();
  });
}

function getProjectOnlyPackages(
  settingsManager: SettingsManager,
  options: PluginPackageIdentityOptions,
): PackageSource[] {
  const rawManager = unwrapProjectPluginSettingsManager(settingsManager);
  const globalPackages = (rawManager.getGlobalSettings() as SettingsWithPackages).packages ?? [];
  const projectPackages = (rawManager.getProjectSettings() as SettingsWithPackages).packages ?? [];
  return applyPackageParentCaps(projectOnlyPackages(globalPackages, projectPackages, options));
}

function getEffectiveGlobalPackages(
  settingsManager: SettingsManager,
  options: PluginPackageIdentityOptions,
): PackageSource[] {
  const rawManager = unwrapProjectPluginSettingsManager(settingsManager);
  const globalSettings = rawManager.getGlobalSettings() as SettingsWithPackages;
  const projectSettings = rawManager.getProjectSettings() as SettingsWithPackages;
  const projectPackages = projectSettings.packages ?? [];
  const explicitStates = readExplicitStateMap(projectSettings, options);
  return (globalSettings.packages ?? []).map((entry) => {
    const projectEntry = findMatchingPackage(
      projectPackages,
      typeof entry === "string" ? entry : entry.source,
      options,
      "project",
      "user",
    );
    const parentState = findStateForSource(explicitStates, packageSource(entry), options) ?? "inherit";
    return mergeProjectPackageResources(entry, projectEntry, parentState);
  });
}

export function createProjectPluginSettingsManager(
  settingsManager: SettingsManager,
  options: PluginPackageIdentityOptions = {},
): SettingsManager {
  const rawManager = unwrapProjectPluginSettingsManager(settingsManager);
  const proxy = new Proxy(rawManager, {
    get(target, property) {
      if (property === "getGlobalSettings") {
        return () => {
          const settings = target.getGlobalSettings() as SettingsWithPackages;
          return { ...settings, packages: getEffectiveGlobalPackages(target, options) };
        };
      }
      if (property === "getProjectSettings") {
        return () => {
          const settings = target.getProjectSettings() as SettingsWithPackages;
          return { ...settings, packages: getProjectOnlyPackages(target, options) };
        };
      }
      if (property === "getPackages") {
        return () => [
          ...getProjectOnlyPackages(target, options),
          ...getEffectiveGlobalPackages(target, options),
        ];
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SettingsManager;
  projectPluginManagerTargets.set(proxy, rawManager);
  return proxy;
}

export function unwrapProjectPluginSettingsManager(settingsManager: SettingsManager): SettingsManager {
  return projectPluginManagerTargets.get(settingsManager) ?? settingsManager;
}
