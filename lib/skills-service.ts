import { statSync } from "fs";
import { readSkillStateSettings } from "./skill-state-settings";
import {
  SettingsManager,
  getAgentDir,
  loadSkills,
  loadSkillsFromDir,
  type LoadSkillsResult,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedResource } from "@earendil-works/pi-coding-agent";
import { relative, resolve, sep } from "path";
import type {
  SkillInfo,
  SkillsResponse,
  SkillViewScope,
  PureResolvedSkillPolicy,
  StaleSkillPolicy,
  SkillPolicyCatalog,
} from "@/lib/api-types";
import { annotateSkillsWithInstallInfo } from "@/lib/skill-lock";
import { createProjectPluginSettingsManager } from "@/lib/plugin-project-status";
import {
  applySkillInvocationOverrides,
  getEffectiveProjectSkillEnabled,
  getProjectSkillStatus,
  resolveGlobalSkillState,
  type GlobalSkillState,
} from "@/lib/skill-project-status";
import {
  getProjectPackageResourceOverride,
  getProjectTopLevelOverride,
  migrateLegacyProjectOverrides,
  migrateProjectWebStateKeys,
} from "@/lib/project-resource-policy";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { annotateSkillsWithTriggerMetadata } from "@/lib/skill-trigger-analysis";
import { GLOBAL_SKILL_INVOCATION_OVERRIDES_SETTING } from "@/lib/skill-invocation-overrides";
import {
  getConfiguredSkillInvocationMode,
  getSkillInvocationModes,
  getSkillPolicyKey,
  resolveSkillPolicy,
  type SkillPolicyInput,
} from "@/lib/skill-policy";
import { getPluginPackageIdentity } from "@/lib/plugin-project-status";

function pathKey(filePath: string): string {
  return resolve(filePath);
}

export function loadSkillsPreservingDuplicates(options: {
  cwd: string;
  agentDir: string;
  skillPaths: readonly string[];
}): LoadSkillsResult {
  const result: LoadSkillsResult = { skills: [], diagnostics: [] };
  for (const skillPath of options.skillPaths) {
    let loaded: LoadSkillsResult;
    try {
      loaded = statSync(skillPath).isDirectory()
        ? loadSkillsFromDir({ dir: skillPath, source: "path" })
        : loadSkills({
            cwd: options.cwd,
            agentDir: options.agentDir,
            skillPaths: [skillPath],
            includeDefaults: false,
          });
    } catch {
      loaded = loadSkills({
        cwd: options.cwd,
        agentDir: options.agentDir,
        skillPaths: [skillPath],
        includeDefaults: false,
      });
    }
    result.skills.push(...loaded.skills);
    result.diagnostics.push(...loaded.diagnostics);
  }
  return result;
}
export function pluginResourceKey(resource: ResolvedResource): string | undefined {
  if (resource.metadata.origin !== "package" || !resource.metadata.baseDir) return undefined;
  const key = relative(resource.metadata.baseDir, resource.path).split(sep).join("/");
  return key && key !== "." && !key.startsWith("..") ? key : undefined;
}

function stalePoliciesFromSettings(
  settingsManager: SettingsManager,
  viewScope: SkillViewScope,
  knownKeys: ReadonlySet<string>,
  cwd: string,
): StaleSkillPolicy[] {
  // A policy record belongs to the view that owns its settings map. Do not
  // use a project-only key to diagnose the global catalog (or vice versa): a
  // resource absent from another view is not evidence that it was renamed or
  // deleted. When the owning view cannot resolve an exact configured key, use
  // `unavailable` without inventing a rename/delete reason; absence alone
  // cannot distinguish package removal, unreadable content, or a stale key.
  const settings = viewScope === "global"
    ? settingsManager.getGlobalSettings()
    : settingsManager.getProjectSettings();
  const modes = getSkillInvocationModes(settings, viewScope, cwd);
  const stale: StaleSkillPolicy[] = [];
  const seen = new Set<string>();
  for (const [policyKey, invocationMode] of Object.entries(modes)) {
    if (knownKeys.has(policyKey)) continue;
    seen.add(policyKey);
    stale.push({
      policyKey,
      scope: viewScope,
      invocationMode,
      availability: "unavailable",
    });
  }
  const legacy = viewScope === "global"
    ? (settingsManager.getGlobalSettings() as Record<string, unknown>)[GLOBAL_SKILL_INVOCATION_OVERRIDES_SETTING]
    : undefined;
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    for (const [policyKey, state] of Object.entries(legacy)) {
      if (seen.has(policyKey) || knownKeys.has(policyKey) || (state !== "enabled" && state !== "disabled")) continue;
      stale.push({
        policyKey,
        scope: "global",
        invocationMode: state === "enabled" ? "automatic" : "explicit-only",
        availability: "unavailable",
      });
    }
  }
  return stale;
}

export async function loadSkillsWithInstallInfo(
  cwd: string,
  viewScope: SkillViewScope = "project",
  options: { readOnly?: boolean } = {},
): Promise<SkillsResponse> {
  const agentDir = getAgentDir();
  const projectTrust = getProjectTrustStatus(cwd, agentDir);
  const baseSettingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted: projectTrust.trusted,
  });
  if (projectTrust.trusted && !options.readOnly) {
    // Both migrations must run in one pass: the first one returning true must
    // not skip the second, and a single flush keeps the result idempotent.
    const legacyMigrated = migrateLegacyProjectOverrides(baseSettingsManager);
    const webStateMigrated = migrateProjectWebStateKeys(baseSettingsManager, cwd);
    if (legacyMigrated || webStateMigrated) {
      await baseSettingsManager.flush();
    }
  }

  // The SDK already hides untrusted project settings; the Reader parent cap
  // still applies to global packages, regardless of project trust.
  const projectPluginSettingsManager = createProjectPluginSettingsManager(baseSettingsManager, { cwd, agentDir });
  // Resolve raw/effective resources once and reuse them here: the skill
  // runtime proxy (createProjectSkillSettingsManager) is a no-op overlay for
  // this panel path, so these are exactly the inputs resolveGlobalSkillState
  // just resolved — re-resolving would duplicate a full package scan.
  const globalState = await resolveGlobalSkillState(
    cwd,
    agentDir,
    baseSettingsManager,
    projectPluginSettingsManager,
  );
  const globalEntries = globalState.entries;
  const rawResources = globalState.rawResources;
  const effectiveResources = globalState.effectiveResources;

  const resourcePairs = new Map<string, { raw?: ResolvedResource; effective?: ResolvedResource }>();
  for (const resource of rawResources) resourcePairs.set(pathKey(resource.path), { raw: resource });
  for (const resource of effectiveResources) {
    const key = pathKey(resource.path);
    const pair = resourcePairs.get(key) ?? {};
    pair.effective = resource;
    resourcePairs.set(key, pair);
  }

  // Project-only resources can exist only in the effective resolution. Keep
  // that SDK order first for the project view, then retain raw-only resources
  // for exact stale/disabled reporting without letting them reorder winners.
  const orderedResourcePairs = new Map<string, { raw?: ResolvedResource; effective?: ResolvedResource }>();
  const addOrderedResources = (resources: readonly ResolvedResource[]) => {
    for (const resource of resources) {
      const key = pathKey(resource.path);
      const pair = resourcePairs.get(key);
      if (pair && !orderedResourcePairs.has(key)) orderedResourcePairs.set(key, pair);
    }
  };
  addOrderedResources(viewScope === "global" ? rawResources : effectiveResources);
  addOrderedResources(rawResources);
  addOrderedResources(effectiveResources);

  const selectedResources = [...orderedResourcePairs.values()]
    .filter((pair) => {
      const resource = pair.raw ?? pair.effective;
      if (!resource || resource.metadata.scope === "temporary") return false;
      return viewScope === "global"
        ? resource.metadata.scope === "user"
        : resource.metadata.scope === "user" || resource.metadata.scope === "project";
    })
    .map((pair) => viewScope === "global" ? pair.raw ?? pair.effective : pair.effective ?? pair.raw)
    .filter((resource): resource is ResolvedResource => Boolean(resource));

  // DefaultPackageManager returns resources in the SDK's collision-precedence
  // order. Load that complete ordered list once so the SDK's name map keeps
  // the first resource and emits diagnostics for lower-priority collisions.
  // Loading each path separately would reset that map and expose a duplicate
  // lower-priority Skill with an unrelated source policy.
  const loaded = loadSkills({
    cwd,
    agentDir,
    skillPaths: selectedResources.map((resource) => resource.path),
    includeDefaults: false,
  });
  const effectiveResourceEnabledByPath = new Map(
    selectedResources.map((resource) => [pathKey(resource.path), Boolean(resource.enabled)]),
  );
  const loadedSkills = applySkillInvocationOverrides(
    loaded.skills,
    globalEntries,
    {},
    viewScope,
    effectiveResourceEnabledByPath,
  );
  const loadedByPath = new Map(loadedSkills.map((skill) => [pathKey(skill.filePath), skill]));
  const globalEntriesByPath = new Map(globalEntries.map((entry) => [entry.path, entry]));

  const skills = selectedResources
    .map((effectiveResource): SkillInfo | undefined => {
      const pair = resourcePairs.get(pathKey(effectiveResource.path));
      const skill = loadedByPath.get(pathKey(effectiveResource.path));
      if (!skill || !pair) return undefined;
      const metadataResource = pair.raw ?? effectiveResource;
      const key = pluginResourceKey(metadataResource);
      const override = viewScope === "project"
        ? metadataResource.metadata.origin === "package" && key
          ? getProjectPackageResourceOverride(baseSettingsManager, metadataResource.metadata.source, "skills", key)
          : getProjectTopLevelOverride(baseSettingsManager, cwd, "skills", metadataResource.path)
        : "inherit";
      const globalEntry = metadataResource.metadata.scope === "user"
        ? globalEntriesByPath.get(pathKey(metadataResource.path))
        : undefined;
      const projectState = viewScope === "project"
        ? override === "inherit" ? undefined : override
        : undefined;
      const globalSkillEnabled = globalEntry?.globalEnabled;
      const effectiveSkillEnabled = viewScope === "project"
        ? globalEntry
          ? getEffectiveProjectSkillEnabled(
              projectState,
              Boolean(effectiveResource.enabled) && !skill.disableModelInvocation,
            )
          : Boolean(effectiveResource.enabled) && !skill.disableModelInvocation
        : undefined;
      return {
        ...skill,
        sourceInfo: {
          path: metadataResource.path,
          source: metadataResource.metadata.source,
          scope: metadataResource.metadata.scope,
          origin: metadataResource.metadata.origin,
          baseDir: metadataResource.metadata.baseDir,
        },
        resourceEnabled: effectiveResource.enabled,
        globalResourceEnabled: metadataResource.metadata.scope === "user" ? pair.raw?.enabled : undefined,
        globalSkillEnabled,
        globalInvocationOverride: globalEntry?.globalInvocationOverride,
        effectiveSkillEnabled,
        projectOverride: override === "inherit" ? undefined : override,
        projectState,
        projectStateKey: globalEntry?.key,
        pluginResourceKey: key,
      } satisfies SkillInfo;
    })
    .filter((skill): skill is SkillInfo => Boolean(skill));

  const annotatedSkills = annotateSkillsWithTriggerMetadata(
    annotateSkillsWithInstallInfo(skills, { cwd, agentDir }),
    agentDir,
    cwd,
  );
  const globalSettings = baseSettingsManager.getGlobalSettings();
  const projectSettings = baseSettingsManager.getProjectSettings();
  const globalModes = getSkillInvocationModes(globalSettings, "global");
  const projectModes = getSkillInvocationModes(projectSettings, "project", cwd);
  const policySkills = annotatedSkills.map((skill): SkillInfo => {
    const metadataResource = resourcePairs.get(pathKey(skill.filePath))?.raw
      ?? resourcePairs.get(pathKey(skill.filePath))?.effective;
    const resourceKey = skill.pluginResourceKey;
    const policyKey = getSkillPolicyKey({
      filePath: skill.filePath,
      sourceInfo: skill.sourceInfo,
      pluginResourceKey: resourceKey,
      cwd,
      agentDir,
    });
    const packageIdentity = metadataResource?.metadata.origin === "package"
      && metadataResource.metadata.source
      ? getPluginPackageIdentity(metadataResource.metadata.source, {
        cwd,
        agentDir,
        scope: "user",
      })
      : undefined;
    const resourceState = skill.resourceEnabled ? "enabled" : "disabled";
    const globalResourceState = skill.globalResourceEnabled === undefined
      ? undefined
      : skill.globalResourceEnabled ? "enabled" : "disabled";
    const projectResourceState = viewScope === "project" ? resourceState : undefined;
    const globalInvocationMode = skill.sourceInfo.scope === "user"
      ? globalModes[policyKey]
        ?? getConfiguredSkillInvocationMode(globalSettings, "global", policyKey)
      : undefined;
    const projectInvocationMode = viewScope === "project"
      ? projectModes[policyKey]
        ?? getConfiguredSkillInvocationMode(projectSettings, "project", policyKey, cwd)
      : undefined;
    const policyInput = {
      policyKey,
      scope: viewScope,
      resourceState,
      globalResourceState,
      projectResourceState,
      globalInvocationMode,
      projectInvocationMode,
      legacyGlobalInvocationOverride: skill.globalInvocationOverride,
      declaresManualInvocation: skill.declaresManualInvocation,
      triggerMode: skill.triggerMode,
      availability: "available",
      packageIdentity,
      pluginResourceKey: resourceKey,
    } satisfies SkillPolicyInput;
    const policy = resolveSkillPolicy(policyInput);
    const globalPolicy = resolveSkillPolicy({
      ...policyInput,
      scope: "global",
      resourceState: globalResourceState ?? resourceState,
      projectInvocationMode: undefined,
    });
    const matchesGlobal = policy.resourceState === globalPolicy.resourceState
      && (policy.resourceState === "disabled" || policy.invocationMode === globalPolicy.invocationMode);
    return {
      ...skill,
      projectStatus: viewScope !== "project"
        ? undefined
        : skill.sourceInfo.scope === "project"
          ? "project"
          : matchesGlobal ? "matching" : "different",
      policyKey,
      policy,
      resourceOverride: readSkillStateSettings(baseSettingsManager, cwd, viewScope, { ...skill, policyKey }).resource,
      resourceState: policy.resourceState,
      invocationMode: policy.invocationMode,
      invocationModeSource: policy.invocationModeSource,
      availability: policy.availability,
      runtimeLoaded: policy.runtimeLoaded,
      promptVisible: policy.promptVisible,
      commandUsable: policy.commandUsable,
    };
  });
  const policies = policySkills
    .map((skill) => skill.policy)
    .filter((policy): policy is PureResolvedSkillPolicy => Boolean(policy));
  const knownPolicyKeys = new Set(policies.map((policy) => policy.policyKey));
  const stalePolicies = stalePoliciesFromSettings(baseSettingsManager, viewScope, knownPolicyKeys, cwd);
  return {
    skills: policySkills,
    diagnostics: loaded.diagnostics,
    projectResourcesLoaded: projectTrust.trusted,
    viewScope,
    stalePolicies,
  };
}

/** Query the complete current policy catalog without exposing settings internals. */
export async function loadSkillPolicyCatalog(
  cwd: string,
  viewScope: SkillViewScope = "project",
): Promise<SkillPolicyCatalog> {
  const response = await loadSkillsWithInstallInfo(cwd, viewScope);
  return {
    skills: response.skills.filter((skill): skill is SkillInfo & { policy: PureResolvedSkillPolicy } => Boolean(skill.policy)),
    stale: response.stalePolicies ?? [],
    viewScope,
    projectResourcesLoaded: response.projectResourcesLoaded,
  };
}

export function getSkillProjectStatus(
  scope: string | undefined,
  resourceEnabled: boolean,
  globalResourceEnabled: boolean | undefined,
): "matching" | "different" | "project" {
  if (scope === "project") return "project";
  return resourceEnabled === (globalResourceEnabled ?? resourceEnabled) ? "matching" : "different";
}

export {
  getProjectSkillStatus,
  resolveGlobalSkillState,
};
export type { GlobalSkillState };
