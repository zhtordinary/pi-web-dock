import {
  DefaultPackageManager,
  loadSkills,
  SettingsManager,
  type ResolvedResource,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import { getPluginPackageIdentity } from "./plugin-project-status";
import { applyPackageParentCaps } from "./plugin-package-state";
import { getGlobalPluginSkillFilterState } from "./plugin-overrides";
import { getGlobalSkillInvocationOverride } from "./skill-invocation-overrides";
import {
  getProjectPackageResourceOverride,
  getProjectTopLevelOverride,
} from "./project-resource-policy";
import type { SkillOverrideState } from "./api-types";

export const PROJECT_SKILL_STATES_SETTING = "piWebProjectSkillStates";

type SettingsWithProjectSkills = {
  skills?: string[];
  packages?: Array<string | { source: string; skills?: string[]; [key: string]: unknown }>;
  [key: string]: unknown;
};

export interface GlobalSkillStateEntry {
  key: string;
  path: string;
  source?: string;
  resourceKey?: string;
  packageIdentity?: string;
  scope: "user";
  globalEnabled: boolean;
  globalInvocationOverride?: SkillOverrideState;
  projectEnabled: boolean;
  projectInvocationOverride?: SkillOverrideState;
}

export interface ProjectSkillRuntime {
  entries: GlobalSkillStateEntry[];
  states: Record<string, SkillOverrideState>;
}

export interface ProjectSkillReconciliation {
  states: Record<string, SkillOverrideState>;
  changed: boolean;
  removedKeys: string[];
}

const stateLocks = new Map<string, Promise<void>>();
const projectSkillManagerTargets = new WeakMap<object, SettingsManager>();

function resourceKey(resource: ResolvedResource): string | undefined {
  if (resource.metadata.origin !== "package" || !resource.metadata.baseDir) return undefined;
  const key = relative(resource.metadata.baseDir, resource.path).split("\\").join("/");
  return key && key !== "." && !key.startsWith("..") ? key : undefined;
}

export function getProjectSkillStateKey(
  resource: ResolvedResource,
  options: { cwd: string; agentDir: string },
): { key: string; source?: string; resourceKey?: string; packageIdentity?: string } {
  const key = resourceKey(resource);
  if (key && resource.metadata.source) {
    const packageIdentity = getPluginPackageIdentity(resource.metadata.source, {
      cwd: options.cwd,
      agentDir: options.agentDir,
      scope: "user",
    });
    return {
      key: `package:${packageIdentity}:${key}`,
      source: resource.metadata.source,
      resourceKey: key,
      packageIdentity,
    };
  }
  return { key: `top-level:${resolve(resource.path)}` };
}

async function resolveSkills(
  cwd: string,
  agentDir: string,
  settingsManager: SettingsManager,
): Promise<ResolvedResource[]> {
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const resolved = await packageManager.resolve(async () => "skip");
  return resolved.skills;
}

export async function resolveGlobalSkillStateEntries(
  cwd: string,
  agentDir: string,
  settingsManager: SettingsManager,
  effectiveSettingsManager: SettingsManager = settingsManager,
) : Promise<GlobalSkillStateEntry[]> {
  return (await resolveGlobalSkillState(cwd, agentDir, settingsManager, effectiveSettingsManager)).entries;
}

export interface GlobalSkillState {
  entries: GlobalSkillStateEntry[];
  rawResources: ResolvedResource[];
  effectiveResources: ResolvedResource[];
}

/**
 * Resolve global skill state plus the raw/effective resource lists that feed
 * it. loadSkillsWithInstallInfo reuses the resolved resources instead of
 * re-running the same package resolution (each resolve is a full package
 * scan), so one request pays for raw + effective resolution only once.
 */
export async function resolveGlobalSkillState(
  cwd: string,
  agentDir: string,
  settingsManager: SettingsManager,
  effectiveSettingsManager: SettingsManager = settingsManager,
): Promise<GlobalSkillState> {
  const globalSettings = settingsManager.getGlobalSettings() as SettingsWithProjectSkills;
  const globalSettingsManager = SettingsManager.inMemory(
    { ...globalSettings, packages: applyPackageParentCaps(globalSettings.packages ?? []) },
    { projectTrusted: true },
  );
  const rawResources = await resolveSkills(cwd, agentDir, globalSettingsManager);
  const effectiveResources = await resolveSkills(cwd, agentDir, effectiveSettingsManager);
  const effectiveByPath = new Map(effectiveResources.map((resource) => [resolve(resource.path), resource]));
  const userRawResources = rawResources.filter((resource) => resource.metadata.scope === "user");
  const loaded = loadSkills({
    cwd,
    agentDir,
    skillPaths: userRawResources.map((resource) => resource.path),
    includeDefaults: false,
  });
  const loadedByPath = new Map(loaded.skills.map((skill) => [resolve(skill.filePath), skill]));

  const entries: GlobalSkillStateEntry[] = userRawResources.map((resource) => {
    const identity = getProjectSkillStateKey(resource, { cwd, agentDir });
    const skill = loadedByPath.get(resolve(resource.path));
    const effectiveResource = effectiveByPath.get(resolve(resource.path));
    const disabledByFile = Boolean(skill?.disableModelInvocation);
    // `disable-model-invocation` is the default invocation policy. An explicit
    // global top-level setting, package filter, or project resource rule may
    // override it; inherited state keeps respecting the file policy.
    const packageSkill = Boolean(identity.packageIdentity);
    const packageSource = packageSkill ? identity.source : undefined;
    const packageResourceKey = packageSkill ? identity.resourceKey : undefined;
    const globalInvocationOverride = packageSkill
      ? undefined
      : getGlobalSkillInvocationOverride(globalSettings, resource.path);
    const globalExplicit = packageSource && packageResourceKey
      ? getGlobalPluginSkillFilterState(settingsManager, packageSource, packageResourceKey)
      : globalInvocationOverride ?? "inherit";
    const globalInvocationAllowed = globalExplicit === "enabled"
      ? true
      : globalExplicit === "disabled"
        ? false
        : !disabledByFile;
    const projectExplicit = packageSource && packageResourceKey
      ? getProjectPackageResourceOverride(settingsManager, packageSource, "skills", packageResourceKey)
      : getProjectTopLevelOverride(settingsManager, cwd, "skills", resource.path);
    const projectInvocationAllowed = projectExplicit === "enabled"
      ? true
      : projectExplicit === "disabled"
        ? false
        : globalInvocationAllowed;
    return {
      ...identity,
      path: resolve(resource.path),
      scope: "user",
      globalEnabled: Boolean(resource.enabled) && globalInvocationAllowed,
      ...(globalInvocationOverride ? { globalInvocationOverride } : {}),
      projectEnabled: Boolean(effectiveResource?.enabled ?? resource.enabled) && projectInvocationAllowed,
      ...(projectExplicit === "inherit" ? {} : { projectInvocationOverride: projectExplicit }),
    };
  });
  return { entries, rawResources, effectiveResources };
}

export type SkillInvocationScope = "global" | "project";

export function applySkillInvocationOverrides(
  skills: Skill[],
  entries: GlobalSkillStateEntry[],
  states: Record<string, SkillOverrideState>,
  scope: SkillInvocationScope,
  effectiveResourceEnabledByPath?: ReadonlyMap<string, boolean>,
): Skill[] {
  const entriesByPath = new Map(entries.map((entry) => [resolve(entry.path), entry]));
  return skills.map((skill) => {
    const path = resolve(skill.filePath);
    const entry = entriesByPath.get(path);
    if (scope === "global" && entry?.globalInvocationOverride) {
      const disabled = entry.globalInvocationOverride === "disabled";
      return skill.disableModelInvocation === disabled ? skill : { ...skill, disableModelInvocation: disabled };
    }
    const projectOverride = entry
      ? lookupState(states, entry.key) ?? entry.projectInvocationOverride
      : undefined;
    if (
      scope === "project"
      && entry?.globalInvocationOverride === "disabled"
      && projectOverride === undefined
      && !skill.disableModelInvocation
    ) {
      return { ...skill, disableModelInvocation: true };
    }
    if (!skill.disableModelInvocation) return skill;
    const enabled = scope === "project"
      ? entry
        ? getEffectiveProjectSkillEnabled(
            getEffectiveProjectSkillState(entry, states),
            entry.projectEnabled,
          )
        : effectiveResourceEnabledByPath?.get(path) ?? false
      : entry?.globalEnabled ?? false;
    return enabled ? { ...skill, disableModelInvocation: false } : skill;
  });
}

function readStates(projectSettings: SettingsWithProjectSkills): Record<string, SkillOverrideState> {
  const raw = projectSettings[PROJECT_SKILL_STATES_SETTING];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const states: Record<string, SkillOverrideState> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.trim() && (value === "enabled" || value === "disabled")) states[key] = value;
  }
  return states;
}

export function getProjectSkillStates(
  projectSettings: SettingsWithProjectSkills,
): Record<string, SkillOverrideState> {
  return readStates(projectSettings);
}

/**
 * Serialize a `top-level:<abs>` state key to portable `top-level:~<rel>` so
 * user-skill overrides survive cross-device sync. Non-home paths stay as-is.
 */
function portableTopLevelKey(key: string): string {
  const match = /^top-level:(.+)$/.exec(key);
  if (!match) return key;
  const home = homedir();
  const pathPart = match[1];
  if (pathPart === home) return "top-level:~";
  if (pathPart.startsWith(home + "/")) return `top-level:~${pathPart.slice(home.length)}`;
  return key;
}

/** Expand a portable `top-level:~<rel>` key to this machine's absolute form. */
function expandTopLevelKey(key: string): string {
  const match = /^top-level:~(?:\/(.*))?$/.exec(key);
  if (!match) return key;
  const home = homedir();
  return `top-level:${home}${match[1] ? "/" + match[1] : ""}`;
}

/** Look up a state by canonical key, tolerating portable `~` keys from sync. */
function lookupState(
  states: Record<string, SkillOverrideState>,
  key: string,
): SkillOverrideState | undefined {
  if (states[key] !== undefined) return states[key];
  for (const [stateKey, state] of Object.entries(states)) {
    if (expandTopLevelKey(stateKey) === key) return state;
  }
  return undefined;
}

function updateProjectSettings(
  settingsManager: SettingsManager,
  update: (settings: SettingsWithProjectSkills) => void,
): void {
  const manager = settingsManager as unknown as {
    updateProjectSettings: (field: string, callback: (settings: SettingsWithProjectSkills) => void) => void;
  };
  manager.updateProjectSettings(PROJECT_SKILL_STATES_SETTING, update);
}

function mapsEqual(
  left: Record<string, SkillOverrideState>,
  right: Record<string, SkillOverrideState>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => left[key] === right[key]);
}

export function reconcileProjectSkillStates(
  entries: GlobalSkillStateEntry[],
  projectSettings: SettingsWithProjectSkills,
): ProjectSkillReconciliation {
  const current = readStates(projectSettings);
  const next: Record<string, SkillOverrideState> = {};
  const validKeys = new Set(entries.map((entry) => entry.key));
  for (const entry of entries) {
    const existing = lookupState(current, entry.key)
      ?? (entry.projectEnabled ? "enabled" : "disabled");
    next[portableTopLevelKey(entry.key)] = existing;
  }
  const removedKeys = Object.keys(current).filter((key) => !validKeys.has(expandTopLevelKey(key)));
  return {
    states: next,
    changed: !mapsEqual(current, next),
    removedKeys,
  };
}

export async function reconcileProjectSkillSettings(
  settingsManager: SettingsManager,
  entries: GlobalSkillStateEntry[],
): Promise<ProjectSkillReconciliation> {
  const storage = (settingsManager as unknown as { storage?: { projectSettingsPath?: string } }).storage;
  const lockKey = storage?.projectSettingsPath ?? "default";
  const previous = stateLocks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  stateLocks.set(lockKey, current);
  await previous.catch(() => undefined);
  try {
    const projectSettings = settingsManager.getProjectSettings() as SettingsWithProjectSkills;
    const result = reconcileProjectSkillStates(entries, projectSettings);
    if (result.changed) {
      updateProjectSettings(settingsManager, (settings) => {
        if (Object.keys(result.states).length > 0) settings[PROJECT_SKILL_STATES_SETTING] = result.states;
        else delete settings[PROJECT_SKILL_STATES_SETTING];
      });
      await settingsManager.flush();
    }
    return result;
  } finally {
    release();
    if (stateLocks.get(lockKey) === current) stateLocks.delete(lockKey);
  }
}

export function setProjectSkillState(
  settingsManager: SettingsManager,
  key: string,
  state: SkillOverrideState,
): void {
  updateProjectSettings(settingsManager, (settings) => {
    const current = readStates(settings as SettingsWithProjectSkills);
    current[portableTopLevelKey(key)] = state;
    settings[PROJECT_SKILL_STATES_SETTING] = current;
  });
}

export function getEffectiveProjectSkillState(
  entry: GlobalSkillStateEntry,
  states: Record<string, SkillOverrideState>,
): SkillOverrideState {
  return lookupState(states, entry.key) ?? (entry.projectEnabled ? "enabled" : "disabled");
}

export function getEffectiveProjectSkillEnabled(
  projectState: SkillOverrideState | undefined,
  projectResourceEnabled: boolean,
): boolean {
  return projectResourceEnabled && (projectState === undefined || projectState === "enabled");
}

export function getProjectSkillStatus(
  projectState: SkillOverrideState | undefined,
  globalEnabled: boolean,
  effectiveProjectEnabled?: boolean,
): "matching" | "different" {
  if (effectiveProjectEnabled !== undefined) {
    return effectiveProjectEnabled === globalEnabled ? "matching" : "different";
  }
  if (projectState === undefined) return "matching";
  return (projectState === "enabled") === globalEnabled ? "matching" : "different";
}

function applyPackageStates(
  packages: Array<string | { source: string; skills?: string[]; [key: string]: unknown }>,
): Array<string | { source: string; skills?: string[]; [key: string]: unknown }> {
  // Project skill overrides are persisted directly to project `packages[].skills`
  // by setProjectPackageResourceOverride (pi core reads it natively); no overlay.
  return packages;
}

function applyTopLevelStates(settings: SettingsWithProjectSkills): SettingsWithProjectSkills {
  // Project skill state is persisted directly to the project `skills` array by
  // setProjectTopLevelOverride (pi core reads it natively); no overlay needed.
  return settings;
}

function applyGlobalPackageStates(settings: SettingsWithProjectSkills): SettingsWithProjectSkills {
  if (!settings.packages) return settings;
  return { ...settings, packages: applyPackageStates(settings.packages) };
}

export function createProjectSkillSettingsManager(
  settingsManager: SettingsManager,
  runtime: ProjectSkillRuntime,
  options: { cwd: string; agentDir: string },
): SettingsManager {
  // Keep legacy arguments for callers; Pi core now owns project overrides.
  void runtime;
  void options;
  const proxy = new Proxy(settingsManager, {
    get(target, property) {
      if (property === "getGlobalSettings") {
        return () => applyGlobalPackageStates(target.getGlobalSettings() as SettingsWithProjectSkills);
      }
      if (property === "getProjectSettings") {
        return () => applyTopLevelStates(
          target.getProjectSettings() as SettingsWithProjectSkills,
        );
      }
      if (property === "getSkillPaths") {
        return () => applyTopLevelStates(
          { skills: target.getSkillPaths() },
        ).skills ?? [];
      }
      if (property === "getPackages") {
        return () => applyPackageStates(
          target.getPackages() as Array<string | { source: string; skills?: string[]; [key: string]: unknown }>,
        );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SettingsManager;
  projectSkillManagerTargets.set(proxy, settingsManager);
  return proxy;
}

export function unwrapProjectSkillSettingsManager(
  settingsManager: SettingsManager,
): SettingsManager {
  return projectSkillManagerTargets.get(settingsManager) ?? settingsManager;
}

export function updateProjectSkillRuntime(
  runtime: ProjectSkillRuntime,
  entries: GlobalSkillStateEntry[],
  states: Record<string, SkillOverrideState>,
): void {
  runtime.entries.splice(0, runtime.entries.length, ...entries);
  for (const key of Object.keys(runtime.states)) delete runtime.states[key];
  Object.assign(runtime.states, states);
}
