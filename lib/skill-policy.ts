import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type {
  PureResolvedSkillPolicy,
  SkillOverrideState,
  SkillPolicyAvailability,
  SkillPolicyScope,
  SkillPolicySource,
  SkillPolicyStaleReason,
  SkillResourceState,
  SkillInvocationMode,
} from "./api-types";
import { getPluginPackageIdentity } from "./plugin-project-status";
import {
  getGlobalSettingsPath,
  updateGlobalSettings,
} from "./global-settings-file";
import { getProjectTrustStatus } from "./project-trust";
import { skillInvocationOverrideKey } from "./skill-invocation-overrides";

export const GLOBAL_SKILL_INVOCATION_MODES_SETTING = "piWebGlobalSkillInvocationModes";
export const PROJECT_SKILL_INVOCATION_MODES_SETTING = "piWebProjectSkillInvocationModes";

type SettingsRecord = Record<string, unknown>;

export interface SkillPolicyInput {
  policyKey: string;
  scope: SkillPolicyScope;
  resourceState: SkillResourceState;
  globalResourceState?: SkillResourceState;
  projectResourceState?: SkillResourceState;
  globalInvocationMode?: SkillInvocationMode;
  projectInvocationMode?: SkillInvocationMode;
  legacyGlobalInvocationOverride?: SkillOverrideState;
  declaresManualInvocation?: boolean;
  triggerMode?: "automatic" | "manual";
  availability?: SkillPolicyAvailability;
  packageIdentity?: string;
  pluginResourceKey?: string;
  staleReason?: SkillPolicyStaleReason;
}

function isRecord(value: unknown): value is SettingsRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function projectRelativePath(cwd: string, path: string): string | undefined {
  const rel = relative(canonicalPath(cwd), canonicalPath(path));
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
    ? rel.split(sep).join("/")
    : undefined;
}

// Persist project-local and home-local identities portably; resolve them for the SDK in memory.
function portableModeKey(key: string, cwd?: string): string {
  const topLevel = "top-level:";
  if (cwd && key.startsWith(topLevel)) {
    const path = key.slice(topLevel.length);
    const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
    if (isAbsolute(expanded)) {
      const rel = projectRelativePath(cwd, expanded);
      if (rel) return `${topLevel}project:${rel}`;
    }
  }
  const prefix = `package:local:${homedir()}`;
  return key.startsWith(`${prefix}/`) || key.startsWith(`${prefix}:`)
    ? `package:local:~${key.slice(prefix.length)}`
    : key;
}

function localModeKey(key: string, cwd?: string): string {
  const projectPrefix = "top-level:project:";
  if (cwd && key.startsWith(projectPrefix)) {
    const path = key.slice(projectPrefix.length);
    const root = canonicalPath(cwd);
    const target = resolve(root, path);
    if (path && !isAbsolute(path) && !path.split(/[\\/]/).includes("..") && projectRelativePath(root, target)) {
      return skillInvocationOverrideKey(target);
    }
    return key;
  }
  const prefix = "package:local:~";
  return key.startsWith(`${prefix}/`) || key.startsWith(`${prefix}:`)
    ? `package:local:${homedir()}${key.slice(prefix.length)}`
    : key;
}

function readModeMap(settings: unknown, setting: string, cwd?: string): Record<string, SkillInvocationMode> {
  if (!isRecord(settings)) return {};
  const raw = settings[setting];
  if (!isRecord(raw)) return {};
  const result: Record<string, SkillInvocationMode> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.trim() && (value === "automatic" || value === "explicit-only")) {
      const localKey = localModeKey(key, cwd);
      const portableValue = raw[portableModeKey(localKey, cwd)];
      result[localKey] = portableValue === "automatic" || portableValue === "explicit-only"
        ? portableValue
        : value;
    }
  }
  return result;
}

export function getSkillInvocationModes(
  settings: unknown,
  scope: SkillPolicyScope,
  cwd?: string,
): Record<string, SkillInvocationMode> {
  return readModeMap(
    settings,
    scope === "global"
      ? GLOBAL_SKILL_INVOCATION_MODES_SETTING
      : PROJECT_SKILL_INVOCATION_MODES_SETTING,
    scope === "project" ? cwd : undefined,
  );
}

export function getConfiguredSkillInvocationMode(
  settings: unknown,
  scope: SkillPolicyScope,
  policyKey: string,
  cwd?: string,
): SkillInvocationMode | undefined {
  return getSkillInvocationModes(settings, scope, cwd)[policyKey];
}

/**
 * Produce the stable Reader key for a discovered skill. Package keys use the
 * Pi package identity and the resource-relative path, so an update or ref
 * change does not silently move an invocation policy. Top-level keys retain
 * the existing canonical home-relative path form.
 */
export function getSkillPolicyKey(input: {
  filePath: string;
  sourceInfo?: {
    source?: string;
    scope?: string;
    origin?: "package" | "top-level";
    baseDir?: string;
  };
  pluginResourceKey?: string;
  cwd?: string;
  agentDir?: string;
}): string {
  const source = input.sourceInfo?.source;
  const resourceKey = input.pluginResourceKey;
  if (input.sourceInfo?.origin === "package" && source && resourceKey) {
    const packageIdentity = getPluginPackageIdentity(source, {
      cwd: input.cwd,
      agentDir: input.agentDir,
      // Reader policy keys deliberately use one package identity namespace so
      // a project view can inherit a global package's mode without rewriting
      // the key when the package is updated or moved between views.
      scope: "user",
    });
    return `package:${packageIdentity}:${resourceKey.replaceAll("\\", "/")}`;
  }
  return skillInvocationOverrideKey(input.filePath);
}

function configuredMode(input: SkillPolicyInput): {
  mode: SkillInvocationMode;
  source: SkillPolicySource;
} {
  if (input.projectInvocationMode) {
    return { mode: input.projectInvocationMode, source: "explicit" };
  }
  if (input.globalInvocationMode) {
    return {
      mode: input.globalInvocationMode,
      source: input.scope === "project" ? "inherited" : "explicit",
    };
  }
  if (input.legacyGlobalInvocationOverride) {
    return {
      mode: input.legacyGlobalInvocationOverride === "enabled" ? "automatic" : "explicit-only",
      source: "legacy",
    };
  }
  if (input.declaresManualInvocation) {
    return { mode: "explicit-only", source: "frontmatter" };
  }
  if (input.triggerMode === "manual") {
    return { mode: "explicit-only", source: "trigger-analysis" };
  }
  return { mode: "automatic", source: "default" };
}

/**
 * Pure two-dimensional policy resolver. Resource state controls loading;
 * invocation mode controls prompt discovery. An unavailable or disabled
 * resource never becomes runtime loaded, prompt visible, or command usable.
 */
export function resolveSkillPolicy(input: SkillPolicyInput): PureResolvedSkillPolicy {
  const availability = input.availability ?? "available";
  const { mode, source } = configuredMode(input);
  const usable = availability === "available" && input.resourceState === "enabled";
  return {
    policyKey: input.policyKey,
    scope: input.scope,
    resourceState: input.resourceState,
    invocationMode: mode,
    invocationModeSource: source,
    availability,
    runtimeLoaded: usable,
    promptVisible: usable && mode === "automatic",
    commandUsable: usable,
    ...(input.scope === "project" && !input.projectInvocationMode && input.globalInvocationMode
      ? { projectInherited: true }
      : {}),
    ...(input.globalResourceState ? { globalResourceState: input.globalResourceState } : {}),
    ...(input.projectResourceState ? { projectResourceState: input.projectResourceState } : {}),
    ...(input.globalInvocationMode ? { globalInvocationMode: input.globalInvocationMode } : {}),
    ...(input.projectInvocationMode ? { projectInvocationMode: input.projectInvocationMode } : {}),
    ...(input.packageIdentity ? { packageIdentity: input.packageIdentity } : {}),
    ...(input.pluginResourceKey ? { pluginResourceKey: input.pluginResourceKey } : {}),
    ...(input.staleReason ? { staleReason: input.staleReason } : {}),
  };
}

export function updateModeMap(
  settings: SettingsRecord,
  setting: string,
  policyKey: string,
  mode: SkillInvocationMode | null,
  cwd?: string,
): boolean {
  const raw = settings[setting];
  const current = isRecord(raw) ? structuredClone(raw) as SettingsRecord : {};
  const projectCwd = setting === PROJECT_SKILL_INVOCATION_MODES_SETTING ? cwd : undefined;
  const localKey = localModeKey(policyKey, projectCwd);
  const portableKey = portableModeKey(localKey, projectCwd);
  const hasLegacyKey = localKey !== portableKey && Object.hasOwn(current, localKey);
  if (mode === null) {
    if (!Object.hasOwn(current, portableKey) && !hasLegacyKey) return false;
    delete current[portableKey];
  } else {
    if (current[portableKey] === mode && !hasLegacyKey) return false;
    current[portableKey] = mode;
  }
  if (hasLegacyKey) delete current[localKey];
  if (Object.keys(current).length > 0) settings[setting] = current;
  else delete settings[setting];
  return true;
}

export function updateSkillInvocationModeSettings(settings: SettingsRecord, scope: SkillPolicyScope, policyKey: string, mode: SkillInvocationMode | null, cwd?: string): void {
  if (!policyKey.trim()) throw new Error("A stable Skill policy key is required");
  updateModeMap(settings, scope === "global" ? GLOBAL_SKILL_INVOCATION_MODES_SETTING : PROJECT_SKILL_INVOCATION_MODES_SETTING, policyKey, mode, cwd);
}

export async function setGlobalSkillInvocationMode(
  agentDir: string,
  policyKey: string,
  mode: SkillInvocationMode | null,
): Promise<void> {
  if (!policyKey.trim()) throw new Error("A stable Skill policy key is required");
  await updateGlobalSettings(getGlobalSettingsPath(agentDir), (settings) => {
    updateSkillInvocationModeSettings(settings, "global", policyKey, mode);
  });
}

export async function setProjectSkillInvocationMode(
  cwd: string,
  agentDir: string,
  policyKey: string,
  mode: SkillInvocationMode | null,
): Promise<void> {
  if (!policyKey.trim()) throw new Error("A stable Skill policy key is required");
  if (!cwd.trim()) throw new Error("A project cwd is required");
  if (!agentDir.trim()) throw new Error("A project agent directory is required");
  if (!getProjectTrustStatus(cwd, agentDir).trusted) {
    throw new Error("Project settings updates are not supported for an untrusted project");
  }
  // Use Reader's existing locked read-modify-write path instead of the SDK's
  // snapshot-based updateProjectSettings. The path is deliberately fixed to
  // the project's .pi settings file so independent SDK managers cannot lose
  // each other's nested mode keys or unrelated fields.
  await updateGlobalSettings(join(cwd, ".pi", "settings.json"), (settings) => {
    updateSkillInvocationModeSettings(settings, "project", policyKey, mode, cwd);
  });
}
