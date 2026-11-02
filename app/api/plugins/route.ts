import { isPluginSourceCheckable } from "@/lib/plugin-updates";
import { NextResponse } from "next/server";
import { existsSync, readFileSync, statSync } from "fs";
import { basename, dirname, extname, join, relative, resolve as resolvePath } from "path";
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
  type PackageSource,
  type ResolvedPaths,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { refreshUpdatedSkillTriggerMetadata } from "@/lib/skill-trigger-analysis";
import {
  clearProjectTopLevelOverride,
  getProjectPackageOverride,
  migrateLegacyProjectOverrides,
  migrateProjectWebStateKeys,
  persistProjectPluginOverride,
  setProjectTopLevelOverride,
} from "@/lib/project-resource-policy";
import {
  createProjectPluginSettingsManager,
  getGlobalPluginState,
  getPluginComparison,
  getPluginPackageIdentity,
  reconcileProjectPluginSettings,
} from "@/lib/plugin-project-status";
import { applyPackageParentCaps, isDisabledPackage, setPackageEntryDisabled } from "@/lib/plugin-package-state";
import {
  collectTopLevelExtensions,
  topLevelExtensionPattern,
  updateTopLevelExtensionPaths,
} from "@/lib/top-level-extension-resources";
import type {
  PluginDiagnostic,
  PluginOverrideState,
  PluginPackageInfo,
  PluginResourceCounts,
  PluginResourceInfo,
  PluginResourceKind,
  PluginScope,
  PluginTopLevelExtensionInfo,
  PluginsResponse,
  StaleSkillPolicy,
} from "@/lib/api-types";
import type { SkillInfo } from "@/lib/api-types";

export const dynamic = "force-dynamic";

type PluginAction = "set_packages_enabled" | "install" | "remove" | "update" | "disable" | "enable" | "set_project_override" | "clear_project_override";
type TopLevelExtensionAction = "set_top_level_extension" | "clear_top_level_extension";

function emptyCounts(): PluginResourceCounts {
  return { extensions: 0, skills: 0, prompts: 0, themes: 0 };
}

function toPluginScope(scope: string): PluginScope {
  return scope === "project" ? "project" : "global";
}

function getPackageSource(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

function packageScope(scope: PluginScope): "user" | "project" {
  return scope === "project" ? "project" : "user";
}

function samePackage(
  left: string,
  right: string,
  cwd: string,
  leftScope: PluginScope,
  rightScope = leftScope,
): boolean {
  return left === right || getPluginPackageIdentity(left, { cwd, scope: packageScope(leftScope) })
    === getPluginPackageIdentity(right, { cwd, scope: packageScope(rightScope) });
}

function setPackageDisabled(
  settingsManager: SettingsManager,
  cwd: string,
  source: string,
  scope: PluginScope,
  disabled: boolean,
): boolean {
  const current = scope === "project"
    ? settingsManager.getProjectSettings().packages ?? []
    : settingsManager.getGlobalSettings().packages ?? [];
  let changed = false;
  let found = false;
  const next = current.map((entry): PackageSource => {
    if (!samePackage(getPackageSource(entry), source, cwd, scope)) return entry;
    found = true;
    if (isDisabledPackage(entry) === disabled) return entry;
    changed = true;
    return setPackageEntryDisabled(entry, disabled);
  });
  if (!changed) return found;
  if (scope === "project") settingsManager.setProjectPackages(next);
  else settingsManager.setPackages(next);
  return true;
}

interface PackageToggleRequest { source: string; scope: PluginScope }

function readPackageList(value: unknown): PackageToggleRequest[] | null {
  if (!Array.isArray(value) || value.length > 300) return null;
  const packages = new Map<string, PackageToggleRequest>();
  for (const item of value) {
    if (!item || typeof item !== "object" || typeof item.source !== "string" || !item.source.trim()
      || (item.scope !== "global" && item.scope !== "project")) return null;
    const pkg = { source: item.source.trim(), scope: item.scope as PluginScope };
    packages.set(`${pkg.scope}\0${pkg.source}`, pkg);
  }
  return [...packages.values()];
}

async function setPackageListEnabled(settingsManager: SettingsManager, cwd: string,
  packages: PackageToggleRequest[], enabled: boolean, viewScope: PluginScope, projectTrusted: boolean) {
  const results: (PackageToggleRequest & { error?: string })[] = [];
  for (const pkg of packages) {
    try {
      if ((pkg.scope === "project" || viewScope === "project") && !projectTrusted) {
        throw new Error("Project resources must be trusted before modifying project plugins");
      }
      if (viewScope === "global" && pkg.scope !== "global") throw new Error("Global view cannot modify project packages");
      if (viewScope === "project" && pkg.scope === "global") {
        const current = settingsManager.getGlobalSettings().packages ?? [];
        const entry = current.find((item) => samePackage(getPackageSource(item), pkg.source, cwd, "global"));
        if (!entry) throw new Error("Package is not configured");
        await persistProjectPluginOverride(settingsManager, getPackageSource(entry), enabled ? "enabled" : "disabled");
      } else if (!setPackageDisabled(settingsManager, cwd, pkg.source, pkg.scope, !enabled)) {
        throw new Error("Package is not configured");
      }
      results.push(pkg);
    } catch (error) {
      results.push({ ...pkg, error: error instanceof Error ? error.message : String(error) });
    }
  }
  await settingsManager.flush();
  const errors = new Map(settingsManager.drainErrors().map((item) => [item.scope, item.error.message]));
  return results.map((result) => {
    const error = errors.get(viewScope === "project" ? "project" : result.scope) ?? result.error;
    return error ? { ...result, error } : result;
  });
}

function addCount(counts: PluginResourceCounts, kind: keyof PluginResourceCounts): void {
  counts[kind] += 1;
}

function getResourceName(path: string, kind: PluginResourceKind): string {
  const file = basename(path);
  const ext = extname(file);
  if (kind === "skill" && file.toLowerCase() === "skill.md") return basename(dirname(path));
  if ((kind === "extension" || kind === "theme" || kind === "prompt") && ext) {
    if (kind === "extension" && /^index\.(ts|js)$/.test(file)) return basename(dirname(path));
    return file.slice(0, -ext.length);
  }
  return file;
}

function getRelativePath(resource: ResolvedResource): string {
  const baseDir = resource.metadata.baseDir;
  if (!baseDir) return resource.path;
  const rel = relative(baseDir, resource.path);
  return rel && !rel.startsWith("..") ? rel : resource.path;
}

function setGlobalTopLevelExtension(
  settingsManager: SettingsManager,
  resource: ResolvedResource,
  agentDir: string,
  enabled: boolean,
): void {
  const current = settingsManager.getGlobalSettings().extensions ?? [];
  settingsManager.setExtensionPaths(
    updateTopLevelExtensionPaths(current, topLevelExtensionPattern(resource, agentDir), enabled),
  );
}

async function findTopLevelExtension(
  cwd: string,
  agentDir: string,
  settingsManager: SettingsManager,
  targetPath: string,
  scope: PluginScope,
): Promise<ResolvedResource | undefined> {
  const target = resolvePath(targetPath);
  const managers = scope === "global"
    ? [SettingsManager.inMemory(settingsManager.getGlobalSettings(), { projectTrusted: true })]
    : [
        settingsManager,
        SettingsManager.inMemory(settingsManager.getGlobalSettings(), { projectTrusted: true }),
      ];
  for (const manager of managers) {
    const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager: manager });
    const resolved = await packageManager.resolve(async () => "skip");
    const resource = resolved.extensions.find((candidate) =>
      candidate.metadata.origin === "top-level"
      && resolvePath(candidate.path) === target
      && (scope === "project" || candidate.metadata.scope === "user"),
    );
    if (resource) return resource;
  }
  return undefined;
}

function getConfiguredVersion(source: string): string | undefined {
  const npmSpec = source.startsWith("npm:") ? source.slice(4) : undefined;
  if (npmSpec) {
    const lastAt = npmSpec.lastIndexOf("@");
    const packageNameEnd = npmSpec.startsWith("@") ? npmSpec.indexOf("/", 1) : 0;
    if (lastAt > packageNameEnd) return npmSpec.slice(lastAt + 1) || undefined;
    return undefined;
  }

  if (source.startsWith("git:") || /^[a-z]+:\/\//.test(source)) {
    const lastAt = source.lastIndexOf("@");
    const lastSlash = source.lastIndexOf("/");
    const lastColon = source.lastIndexOf(":");
    if (lastAt > Math.max(lastSlash, lastColon)) return source.slice(lastAt + 1) || undefined;
  }
  return undefined;
}

function readPackageMetadata(installedPath?: string): { packageName?: string; version?: string; description?: string } {
  if (!installedPath) return {};
  try {
    const stats = statSync(installedPath);
    const packageJsonPath = stats.isDirectory()
      ? join(installedPath, "package.json")
      : join(dirname(installedPath), "package.json");
    if (!existsSync(packageJsonPath)) return {};
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
      description?: unknown;
    };
    return {
      packageName: typeof parsed.name === "string" ? parsed.name : undefined,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
      description: typeof parsed.description === "string" ? parsed.description : undefined,
    };
  } catch {
    return {};
  }
}

function collectResource(
  resource: ResolvedResource,
  kind: keyof PluginResourceCounts,
  countsByPackage: Map<string, PluginResourceCounts>,
  resourcesByPackage: Map<string, PluginResourceInfo[]>,
  totals: PluginResourceCounts,
  resourceScope?: PluginScope,
  skillPoliciesByPath?: ReadonlyMap<string, Pick<SkillInfo, "policyKey" | "invocationMode">>,
): void {
  if (resource.metadata.origin !== "package") return;
  if (resourceScope && toPluginScope(resource.metadata.scope) !== resourceScope) return;
  const source = resource.metadata.source;
  const counts = countsByPackage.get(source) ?? emptyCounts();
  if (resource.enabled) {
    addCount(counts, kind);
    addCount(totals, kind);
  }
  countsByPackage.set(source, counts);
  const resources = resourcesByPackage.get(source) ?? [];
  const resourceKind = kind === "extensions"
    ? "extension"
    : kind === "skills"
      ? "skill"
      : kind === "prompts"
        ? "prompt"
        : "theme";
  resources.push({
    kind: resourceKind,
    name: getResourceName(resource.path, resourceKind),
    path: resource.path,
    relativePath: getRelativePath(resource),
    resourceState: resource.enabled ? "enabled" : "disabled",
    availability: "available",
    ...(kind === "skills" && skillPoliciesByPath?.get(resolvePath(resource.path))?.policyKey
      ? {
        policyKey: skillPoliciesByPath.get(resolvePath(resource.path))!.policyKey,
        invocationMode: skillPoliciesByPath.get(resolvePath(resource.path))!.invocationMode,
      }
      : {}),
  });
  resourcesByPackage.set(source, resources);
}

function collectResources(
  paths: ResolvedPaths,
  scope?: PluginScope,
  skillPoliciesByPath?: ReadonlyMap<string, Pick<SkillInfo, "policyKey" | "invocationMode">>,
): {
  countsByPackage: Map<string, PluginResourceCounts>;
  resourcesByPackage: Map<string, PluginResourceInfo[]>;
  totals: PluginResourceCounts;
} {
  const countsByPackage = new Map<string, PluginResourceCounts>();
  const resourcesByPackage = new Map<string, PluginResourceInfo[]>();
  const totals = emptyCounts();
  for (const resource of paths.extensions) collectResource(resource, "extensions", countsByPackage, resourcesByPackage, totals, scope);
  for (const resource of paths.skills) collectResource(resource, "skills", countsByPackage, resourcesByPackage, totals, scope, skillPoliciesByPath);
  for (const resource of paths.prompts) collectResource(resource, "prompts", countsByPackage, resourcesByPackage, totals, scope);
  for (const resource of paths.themes) collectResource(resource, "themes", countsByPackage, resourcesByPackage, totals, scope);
  return { countsByPackage, resourcesByPackage, totals };
}

async function readPlugins(cwd: string, viewScope: PluginScope): Promise<PluginsResponse> {
  const agentDir = getAgentDir();
  const projectTrust = getProjectTrustStatus(cwd, agentDir);
  const baseSettingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted: projectTrust.trusted,
  });
  let reconciliation;
  if (projectTrust.trusted) {
    const legacyMigrated = migrateLegacyProjectOverrides(baseSettingsManager);
    const webStateMigrated = migrateProjectWebStateKeys(baseSettingsManager, cwd);
    if (legacyMigrated || webStateMigrated) {
      await baseSettingsManager.flush();
    }
    reconciliation = await reconcileProjectPluginSettings(baseSettingsManager, { cwd, agentDir });
  }
  const resolutionSettingsManager = viewScope === "global"
    ? SettingsManager.inMemory({ ...baseSettingsManager.getGlobalSettings(),
      packages: applyPackageParentCaps(baseSettingsManager.getGlobalSettings().packages ?? []) }, { projectTrusted: true })
    : createProjectPluginSettingsManager(baseSettingsManager, { cwd, agentDir });
  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: resolutionSettingsManager,
  });
  const diagnostics: PluginDiagnostic[] = [...(reconciliation?.diagnostics ?? [])];
  let countsByPackage = new Map<string, PluginResourceCounts>();
  let resourcesByPackage = new Map<string, PluginResourceInfo[]>();
  let totals = emptyCounts();
  let skillPoliciesByPath = new Map<string, Pick<SkillInfo, "policyKey" | "invocationMode">>();
  let stalePolicies: StaleSkillPolicy[] = [];
  let topLevelExtensions: PluginTopLevelExtensionInfo[] = [];

  try {
    const resolved = await packageManager.resolve(async (source) => {
      diagnostics.push({
        type: "warning",
        source,
        message: "Package is configured but not installed yet.",
      });
      return "skip";
    });
    const skillResponse = await loadSkillsWithInstallInfo(cwd, viewScope === "global" ? "global" : "project");
    stalePolicies = skillResponse.stalePolicies ?? [];
    skillPoliciesByPath = new Map(
      skillResponse.skills
        .filter((skill) => skill.policyKey)
        .map((skill) => [resolvePath(skill.filePath), {
          policyKey: skill.policyKey,
          invocationMode: skill.invocationMode,
        }]),
    );
    ({ countsByPackage, resourcesByPackage, totals } = collectResources(
      resolved,
      viewScope === "global" ? "global" : undefined,
      skillPoliciesByPath,
    ));
    let globalResources = new Map<string, ResolvedResource>();
    if (viewScope === "project") {
      const globalSettingsManager = SettingsManager.inMemory(
        baseSettingsManager.getGlobalSettings(),
        { projectTrusted: true },
      );
      const globalPackageManager = new DefaultPackageManager({
        cwd,
        agentDir,
        settingsManager: globalSettingsManager,
      });
      const globalResolved = await globalPackageManager.resolve(async () => "skip");
      globalResources = new Map(
        globalResolved.extensions
          .filter((resource) => resource.metadata.origin === "top-level" && resource.metadata.scope === "user")
          .map((resource) => [resolvePath(resource.path), resource]),
      );
    }
    topLevelExtensions = collectTopLevelExtensions(
      resolved,
      viewScope,
      globalResources,
      baseSettingsManager,
      cwd,
    );
  } catch (error) {
    diagnostics.push({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const globalEntries = (baseSettingsManager.getGlobalSettings().packages ?? []) as PackageSource[];
  const listed = packageManager.listConfiguredPackages();
  const projectOverrides: Record<string, PluginOverrideState> = {};
  const packages = globalEntries.map((entry) => {
    const source = getPackageSource(entry);
    const globalState = getGlobalPluginState(entry);
    const projectOverride = projectTrust.trusted ? getProjectPackageOverride(baseSettingsManager, source) : "inherit";
    const projectState = projectOverride === "inherit" ? globalState : projectOverride;
    const disabled = (viewScope === "global" ? globalState : projectState) === "disabled";
    if (viewScope === "project") projectOverrides[source] = projectState;
    const installedPath = listed.find((item) =>
      toPluginScope(item.scope) === "global" && samePackage(item.source, source, cwd, "global", "global"),
    )?.installedPath;
    const counts = countsByPackage.get(source) ?? emptyCounts();
    const resources = resourcesByPackage.get(source) ?? [];
    const resourceCount = counts.extensions + counts.skills + counts.prompts + counts.themes;
    const packageMetadata = readPackageMetadata(installedPath);
    if (!installedPath) {
      diagnostics.push({
        type: "warning",
        source,
        message: "Configured package path was not found.",
      });
    }
    return {
      source,
      scope: "global" as const,
      canCheckForUpdates: isPluginSourceCheckable(source),
      filtered: typeof entry === "object",
      disabled,
      globalDisabled: globalState === "disabled",
      projectOverride: viewScope === "project" ? projectState : undefined,
      projectExplicit: viewScope === "project" && projectOverride !== "inherit" ? projectOverride : undefined,
      projectStatus: getPluginComparison(projectState, globalState),
      installedPath,
      packageName: packageMetadata.packageName,
      version: packageMetadata.version,
      description: packageMetadata.description,
      configuredVersion: getConfiguredVersion(source),
      counts,
      resources,
      status: disabled ? "disabled" : resourceCount > 0 ? "loaded" : installedPath ? "installed" : "missing",
    } satisfies PluginPackageInfo;
  });

  // Project-only packages (declared in project settings, no global entry) are
  // surfaced in the project view as 项目专属. They keep their own enable/disable
  // state in the project `packages` entry and are never part of the global list.
  const projectOnlyPackages = viewScope === "project" ? reconciliation?.projectOnlyPackages ?? [] : [];
  const projectPackages = projectOnlyPackages.map((entry) => {
    const source = getPackageSource(entry);
    const disabled = isDisabledPackage(entry);
    const installedPath = listed.find((item) =>
      toPluginScope(item.scope) === "project" && samePackage(item.source, source, cwd, "project", "project"),
    )?.installedPath;
    const counts = countsByPackage.get(source) ?? emptyCounts();
    const resources = resourcesByPackage.get(source) ?? [];
    const resourceCount = counts.extensions + counts.skills + counts.prompts + counts.themes;
    const packageMetadata = readPackageMetadata(installedPath);
    if (!installedPath) {
      diagnostics.push({
        type: "warning",
        source,
        message: "Configured package path was not found.",
      });
    }
    return {
      source,
      scope: "project" as const,
      canCheckForUpdates: isPluginSourceCheckable(source),
      filtered: typeof entry === "object",
      disabled,
      projectStatus: "project" as const,
      installedPath,
      packageName: packageMetadata.packageName,
      version: packageMetadata.version,
      description: packageMetadata.description,
      configuredVersion: getConfiguredVersion(source),
      counts,
      resources,
      status: disabled ? "disabled" : resourceCount > 0 ? "loaded" : installedPath ? "installed" : "missing",
    } satisfies PluginPackageInfo;
  });

  return {
    packages: [...packages, ...projectPackages],
    topLevelExtensions,
    projectOverrides,
    stalePolicies,
    totals,
    diagnostics,
    projectResourcesLoaded: projectTrust.trusted,
  };
}

function readScope(scope: unknown): PluginScope {
  return scope === "project" ? "project" : "global";
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });

  try {
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    const viewScope = searchParams.has("scope") ? readScope(searchParams.get("scope")) : "project";
    return NextResponse.json(await readPlugins(cwd, viewScope));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/plugins body: { action, source?, scope?, cwd }
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as {
      action?: PluginAction | TopLevelExtensionAction;
      source?: string;
      path?: string;
      scope?: PluginScope;
      cwd?: string;
      enabled?: boolean;
      viewScope?: PluginScope;
      packages?: unknown;
    };
    if (!body.cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    if (!body.action) return NextResponse.json({ error: "action required" }, { status: 400 });
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(body.cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const agentDir = getAgentDir();
    const projectTrust = getProjectTrustStatus(body.cwd, agentDir);
    const settingsManager = SettingsManager.create(body.cwd, agentDir, {
      projectTrusted: projectTrust.trusted,
    });
    const loadErrors = settingsManager.drainErrors();
    if (loadErrors.length) throw loadErrors[0].error;
    const scope = readScope(body.scope);
    const viewScope = body.viewScope ? readScope(body.viewScope) : scope;
    if (body.action === "set_packages_enabled" || body.packages !== undefined) {
      if (body.action !== "set_packages_enabled" && body.action !== "enable" && body.action !== "disable") {
        return NextResponse.json({ error: "packages require a toggle action" }, { status: 400 });
      }
      const packages = readPackageList(body.packages);
      const enabled = body.action === "enable" ? true : body.action === "disable" ? false : body.enabled;
      if (!packages || typeof enabled !== "boolean") return NextResponse.json({ error: "packages and enabled required" }, { status: 400 });
      const results = await setPackageListEnabled(settingsManager, body.cwd, packages, enabled, viewScope, projectTrust.trusted);
      return NextResponse.json({ ...(await readPlugins(body.cwd, viewScope)), results });
    }
    if (scope === "project" && !projectTrust.trusted) {
      return NextResponse.json(
        { error: "Project resources must be trusted before modifying project resources" },
        { status: 403 },
      );
    }
    if (projectTrust.trusted) {
      const legacyMigrated = migrateLegacyProjectOverrides(settingsManager);
      const webStateMigrated = migrateProjectWebStateKeys(settingsManager, body.cwd);
      if (legacyMigrated || webStateMigrated) {
        await settingsManager.flush();
      }
    }
    const source = body.source?.trim();
    const extensionPath = body.path?.trim();
    if (body.action === "set_top_level_extension" || body.action === "clear_top_level_extension") {
      if (!extensionPath) return NextResponse.json({ error: "path required" }, { status: 400 });
      if (body.action === "clear_top_level_extension" && scope !== "project") {
        return NextResponse.json({ error: "Top-level extension reset requires project scope" }, { status: 400 });
      }
      if (body.action === "set_top_level_extension" && typeof body.enabled !== "boolean") {
        return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
      }
      const resource = await findTopLevelExtension(body.cwd, agentDir, settingsManager, extensionPath, scope);
      if (!resource) {
        return NextResponse.json({ error: "Top-level extension not found" }, { status: 404 });
      }
      if (scope === "global") {
        setGlobalTopLevelExtension(settingsManager, resource, agentDir, body.enabled === true);
      } else if (body.action === "clear_top_level_extension") {
        clearProjectTopLevelOverride(settingsManager, body.cwd, "extensions", resource.path);
      } else {
        setProjectTopLevelOverride(
          settingsManager,
          body.cwd,
          "extensions",
          resource.path,
          body.enabled ? "enabled" : "disabled",
        );
      }
      await settingsManager.flush();
      const writeErrors = settingsManager.drainErrors();
      if (writeErrors.length) throw writeErrors[0].error;
      return NextResponse.json(await readPlugins(body.cwd, viewScope));
    }
    if (body.action === "set_project_override" || body.action === "clear_project_override") {
      if (scope !== "project") {
        return NextResponse.json({ error: "Project plugin state requires project scope" }, { status: 400 });
      }
      if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
      const globalPackages = settingsManager.getGlobalSettings().packages ?? [];
      const globalEntry = globalPackages.find((entry) => samePackage(
        getPackageSource(entry),
        source,
        body.cwd!,
        "global",
        "global",
      ));
      if (!globalEntry) {
        return NextResponse.json({ error: "Global package not found" }, { status: 404 });
      }
      if (body.action === "set_project_override"
        && body.enabled !== true
        && body.enabled !== false) {
        return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
      }
      await persistProjectPluginOverride(
        settingsManager,
        getPackageSource(globalEntry),
        body.action === "set_project_override"
          ? body.enabled ? "enabled" : "disabled"
          : null,
      );
      return NextResponse.json(await readPlugins(body.cwd, viewScope));
    }
    if (body.action === "disable" || body.action === "enable") {
      if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
      if (!setPackageDisabled(settingsManager, body.cwd, source, scope, body.action === "disable")) {
        return NextResponse.json(
          { error: `Package ${source} is not configured at ${scope} scope` },
          { status: 404 },
        );
      }
      await settingsManager.flush();
      const writeErrors = settingsManager.drainErrors();
      if (writeErrors.length) throw writeErrors[0].error;
      return NextResponse.json(await readPlugins(body.cwd, viewScope));
    }
    if (scope === "project") {
      return NextResponse.json(
        { error: "Project plugin package install, update, and removal require global scope" },
        { status: 400 },
      );
    }
    const packageManager = new DefaultPackageManager({
      cwd: body.cwd,
      agentDir,
      settingsManager,
    });
    const local = false;

    if (body.action === "install") {
      if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
      await packageManager.installAndPersist(source, { local });
    } else if (body.action === "remove") {
      if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
      await packageManager.removeAndPersist(source, { local });
    } else if (body.action === "update") {
      await packageManager.update(source);
    } else {
      return NextResponse.json({ error: `Unsupported action: ${body.action}` }, { status: 400 });
    }

    let triggerModes;
    if (body.action === "install" || body.action === "update") {
      try {
        const refreshedSkills = await loadSkillsWithInstallInfo(body.cwd, "global");
        const pluginSkills = refreshedSkills.skills.filter((skill) =>
          skill.sourceInfo.origin === "package"
          && skill.sourceInfo.scope === "user"
          && (!source || samePackage(skill.sourceInfo.source ?? "", source, body.cwd!, "global")),
        );
        triggerModes = await refreshUpdatedSkillTriggerMetadata(pluginSkills, { cwd: body.cwd });
      } catch (error) {
        console.warn(`[plugins/${body.action}] trigger-mode analysis skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const response = await readPlugins(body.cwd, viewScope);
    return NextResponse.json({ ...response, ...(triggerModes ? { triggerModes } : {}) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
