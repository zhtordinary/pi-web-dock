import { join } from "node:path";
import { SettingsManager, type PackageSource } from "@earendil-works/pi-coding-agent";
import type { SkillInfo, SkillInvocationMode, SkillStateSnapshot, SkillUseState, SkillViewScope } from "./api-types";
import { getGlobalSettingsPath, updateGlobalSettings } from "./global-settings-file";
import { getProjectTrustStatus } from "./project-trust";
import { getGlobalPluginState, getPluginPackageIdentity } from "./plugin-project-status";
import { isDisabledPackage } from "./plugin-package-state";
import { getGlobalPluginSkillFilterState, setGlobalPluginSkillFilter, clearGlobalPluginSkillFilter } from "./plugin-overrides";
import {
  getProjectPackageOverride, getProjectPackageResourceFilter, getProjectTopLevelOverride, getGlobalTopLevelSkillOverride,
  setProjectPackageResourceOverride, clearProjectPackageResourceOverride,
  setProjectTopLevelOverride, clearProjectTopLevelOverride, setGlobalTopLevelSkillOverride, clearGlobalTopLevelSkillOverride,
} from "./project-resource-policy";
import { getConfiguredSkillInvocationMode, updateSkillInvocationModeSettings } from "./skill-policy";

function packageSource(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

function samePluginPackage(
  entry: PackageSource,
  source: string,
  cwd: string,
  scope: "user" | "project",
): boolean {
  const candidate = packageSource(entry);
  return candidate === source
    || getPluginPackageIdentity(candidate, { cwd, scope }) === getPluginPackageIdentity(source, { cwd, scope });
}

export function isDisabledPluginPackage(
  settingsManager: SettingsManager,
  cwd: string,
  agentDir: string,
  source: string,
  scope: SkillViewScope,
): boolean {
  const globalSettings = settingsManager.getGlobalSettings() as { packages?: PackageSource[] };
  const globalPackages = globalSettings.packages ?? [];
  if (scope === "global") {
    return globalPackages.some((entry) =>
      samePluginPackage(entry, source, cwd, "user") && getGlobalPluginState(entry) === "disabled",
    );
  }

  const projectSettings = settingsManager.getProjectSettings() as {
    packages?: PackageSource[];
    [key: string]: unknown;
  };
  const globalEntry = globalPackages.find((entry) => samePluginPackage(entry, source, cwd, "user"));
  if (globalEntry) {
    const override = getProjectPackageOverride(settingsManager, typeof globalEntry === "string" ? globalEntry : globalEntry.source);
    if (override === "enabled") return false;
    if (override === "disabled") return true;
    return isDisabledPackage(globalEntry);
  }
  return (projectSettings.packages ?? []).some((entry) =>
    samePluginPackage(entry, source, cwd, "project") && isDisabledPackage(entry),
  );
}

export function readSkillStateSettings(manager: SettingsManager, cwd: string, scope: SkillViewScope, skill: SkillInfo): SkillStateSnapshot {
  const source = skill.sourceInfo?.source;
  const key = skill.pluginResourceKey;
  const plugin = skill.sourceInfo?.origin === "package" && source && key;
  const resource = scope === "project"
    ? plugin ? getProjectPackageResourceFilter(manager, source, "skills", key) : getProjectTopLevelOverride(manager, cwd, "skills", skill.filePath)
    : plugin ? getGlobalPluginSkillFilterState(manager, source, key) : getGlobalTopLevelSkillOverride(manager, skill.filePath);
  const settings = scope === "project" ? manager.getProjectSettings() : manager.getGlobalSettings();
  return { filePath: skill.filePath, resource, mode: getConfiguredSkillInvocationMode(settings, scope, skill.policyKey ?? "", cwd) ?? null };
}

export interface SkillStateChange {
  skill: SkillInfo;
  state?: SkillUseState | "inherit";
  restore?: SkillStateSnapshot;
}

/** One existing settings file and lock cover resource filters and invocation mode together. */
export async function writeSkillStateSettings(cwd: string, agentDir: string, scope: SkillViewScope, changes: SkillStateChange[]): Promise<SkillStateSnapshot[]> {
  for (const change of changes) {
    if (!change.restore && !["automatic", "explicit-only", "disabled", "inherit"].includes(change.state ?? "")) throw new Error("Invalid Skill use state");
    if (change.state === "inherit" && scope !== "project") throw new Error("Inheritance is only available in project settings");
    if (change.restore && (change.restore.filePath !== change.skill.filePath
      || !["inherit", "enabled", "disabled"].includes(change.restore.resource)
      || (change.restore.mode !== null && !["automatic", "explicit-only"].includes(change.restore.mode)))) throw new Error("Invalid Skill settings snapshot");
  }
  const trusted = getProjectTrustStatus(cwd, agentDir).trusted;
  if (scope === "project" && !trusted) throw new Error("Project resources must be trusted before modifying project skills");
  const baseline = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
  const targetPath = scope === "project" ? join(cwd, ".pi", "settings.json") : getGlobalSettingsPath(agentDir);
  return updateGlobalSettings(targetPath, (settings) => {
    if (scope === "project" && !getProjectTrustStatus(cwd, agentDir).trusted) throw new Error("Project trust changed");
    const global: Record<string, unknown> = scope === "global" ? settings : baseline.getGlobalSettings() as Record<string, unknown>;
    const project: Record<string, unknown> = scope === "project" ? settings : {};
    // Existing filter helpers edit this transaction's draft; only the outer writer persists it.
    const manager = {
      storage: { projectSettingsPath: join(cwd, ".pi", "settings.json"), globalSettingsPath: getGlobalSettingsPath(agentDir) },
      getGlobalSettings: () => structuredClone(global), getProjectSettings: () => structuredClone(project),
      setPackages: (value: PackageSource[]) => { global.packages = value; },
      setProjectPackages: (value: PackageSource[]) => { project.packages = value; },
      setSkillPaths: (value: string[]) => { global.skills = value; },
      setProjectSkillPaths: (value: string[]) => { project.skills = value; },
      updateProjectSettings: (_field: string, update: (draft: Record<string, unknown>) => void) => update(project),
    } as unknown as SettingsManager;
    const snapshots: SkillStateSnapshot[] = [];
    for (const { skill, state, restore } of changes) {
      if (!skill.policyKey) throw new Error("A stable Skill policy key is required");
      if (scope === "global" && skill.sourceInfo.scope !== "user") throw new Error("Global changes require a global Skill");
      const before = readSkillStateSettings(manager, cwd, scope, skill);
      snapshots.push(before);
      const resource = restore?.resource ?? (state === "inherit" ? "inherit" : state === "disabled" ? "disabled" : "enabled");
      const mode: SkillInvocationMode | null = restore ? restore.mode : state === "automatic" || state === "explicit-only" ? state : state === "disabled" ? before.mode : null;
      const source = skill.sourceInfo.source;
      const key = skill.pluginResourceKey;
      const plugin = skill.sourceInfo.origin === "package" && source && key;
      if (resource === "enabled" && plugin && isDisabledPluginPackage(manager, cwd, agentDir, source, scope)) throw new Error("Enable the parent plugin before enabling its skills");
      if (scope === "project") {
        if (plugin) {
          if (resource === "inherit") clearProjectPackageResourceOverride(manager, source, "skills", key);
          else setProjectPackageResourceOverride(manager, source, "skills", key, resource);
        } else if (resource === "inherit") clearProjectTopLevelOverride(manager, cwd, "skills", skill.filePath);
        else setProjectTopLevelOverride(manager, cwd, "skills", skill.filePath, resource);
      } else if (plugin) {
        if (resource === "inherit") clearGlobalPluginSkillFilter(manager, source, key);
        else setGlobalPluginSkillFilter(manager, source, key, resource);
      } else if (resource === "inherit") clearGlobalTopLevelSkillOverride(manager, skill.filePath);
      else setGlobalTopLevelSkillOverride(manager, skill.filePath, resource);
      updateSkillInvocationModeSettings(settings, scope, skill.policyKey, mode ?? null, cwd);
    }
    return snapshots;
  });
}
