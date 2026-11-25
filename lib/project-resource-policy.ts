import { createRequire, findPackageJSON } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DefaultPackageManager, type PackageSource, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { isWindowsAbsolutePath } from "./paths";
import { isDisabledPackage } from "./plugin-package-state";
import {
  clearProjectPluginExplicitState,
  getPluginPackageIdentity,
  getProjectPluginExplicitState,
  setProjectPluginExplicitState,
} from "./plugin-project-status";
import type { PluginOverrideState } from "./api-types";

export type ProjectResourcePolicy = "inherit" | PluginOverrideState;
export type ResourceSettingKey = "extensions" | "skills" | "prompts" | "themes";

type SettingsWithUnknown = {
  packages?: PackageSource[];
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
  [key: string]: unknown;
};

const LEGACY_PACKAGE_OVERRIDES = "piWebPluginOverrides";
const LEGACY_SKILL_OVERRIDES = "piWebPluginSkillOverrides";
const RESOURCE_KEYS: ResourceSettingKey[] = ["extensions", "skills", "prompts", "themes"];

function packageSource(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

function packageIdentityOptions(settingsManager: SettingsManager): { cwd?: string; agentDir?: string } {
  // SAFETY: FileSettingsStorage exposes these optional paths; in-memory storage does not.
  const storage = (settingsManager as unknown as {
    storage?: { projectSettingsPath?: string; globalSettingsPath?: string };
  }).storage;
  return {
    cwd: storage?.projectSettingsPath
      ? dirname(dirname(storage.projectSettingsPath))
      : undefined,
    agentDir: storage?.globalSettingsPath
      ? dirname(storage.globalSettingsPath)
      : undefined,
  };
}

function packageIdentity(settingsManager: SettingsManager, source: string): string {
  try {
    return getPluginPackageIdentity(source, { ...packageIdentityOptions(settingsManager), scope: "project" });
  } catch {
    return source;
  }
}

function samePackageSource(settingsManager: SettingsManager, left: string, right: string): boolean {
  return left === right || packageIdentity(settingsManager, left) === packageIdentity(settingsManager, right);
}

function stripPattern(entry: string): string {
  return entry.startsWith("+") || entry.startsWith("-") || entry.startsWith("!")
    ? entry.slice(1)
    : entry;
}

function resolveConfiguredPath(entry: string, baseDir: string): string {
  const expanded = entry === "~"
    ? homedir()
    : entry.startsWith("~/") || (process.platform === "win32" && entry.startsWith("~\\"))
      ? join(homedir(), entry.slice(2))
      : entry.startsWith("file://")
        ? fileURLToPath(entry)
        : entry;
  return resolvePath(baseDir, expanded);
}

function hasSdkGlobWildcard(path: string): boolean {
  return path.includes("*") || path.includes("?");
}

function hasLegacyGlobSyntax(path: string): boolean {
  if (/[*?()[\]{}]/.test(path)) return true;
  if (!path.startsWith("file://")) return false;
  try {
    // SDK normalizePath decodes file URLs before glob matching.
    return /[*?()[\]{}]/.test(fileURLToPath(path));
  } catch {
    return false;
  }
}

function assertTopLevelOverridePathSupported(path: string): void {
  if (path.includes("\0")) throw new Error("Pi cannot safely override a resource path containing NUL");
  let target = path;
  if (path.startsWith("file:")) {
    try {
      if (!path.startsWith("file://")) throw new Error("invalid file URL");
      target = fileURLToPath(path);
      if (target.includes("\0")) throw new Error("invalid file URL");
    } catch {
      throw new Error("Pi cannot safely override an invalid resource file URL");
    }
  }
  if ((process.platform === "win32" || target.startsWith("\\\\")) && /^[\\/]{2}[?.][\\/]/.test(target)) {
    throw new Error("Pi cannot safely override a Windows device namespace resource path");
  }
  if (!path.startsWith("file:") && hasSdkGlobWildcard(path) && !isAbsolute(path)) {
    throw new Error("Pi cannot safely override a relative resource path containing * or ?");
  }
}

function exactExcludeRequired(path: string): boolean {
  return /[*?()[\]{}]/.test(path) || (sep === "/" && path.includes("\\"));
}

function isSkillFilePath(path: string): boolean {
  return path === "SKILL.md" || path.endsWith("/SKILL.md") || path.endsWith("\\SKILL.md");
}

function homeRelativePath(path: string): string | undefined {
  if (!isAbsolute(path)) return undefined;
  const fromHome = relative(homedir(), path);
  if (!fromHome || fromHome === ".." || fromHome.startsWith(`..${sep}`) || isAbsolute(fromHome)) return undefined;
  return toPosixPath(fromHome);
}

/**
 * Match a portable exclude rule against a skill path.
 *
 * `**\/<tail>` is evaluated the way the pi core evaluates globs: it matches
 * the absolute path or the home-relative path that ends with the tail. A
 * single-segment tail is the legacy `**\/<dirname>` shape, kept readable so
 * existing project rules keep working and can still be cleared.
 */
function matchesPortableSkillPattern(pattern: string, path: string): boolean {
  const tail = pattern.replace(/^\*\*\//, "");
  if (!tail || tail === pattern || /[*?()[\]{}\\]/.test(tail)) return false;
  const candidates = [toPosixPath(path), homeRelativePath(path) ?? ""];
  return candidates.some((candidate) => candidate === tail || candidate.endsWith(`/${tail}`));
}

let sdkGlobTools: { minimatch: (path: string, pattern: string) => boolean; normalizePath: (path: string) => string } | undefined;

function assertNoAmbiguousLegacyGlob(entries: readonly string[], path: string, targetBaseDir: string, ruleBaseDir: string | null = targetBaseDir): void {
  const exclusions = entries.filter((entry) => entry.startsWith("!"));
  if (!exclusions.length) return;
  const candidatePatterns = exclusions.map((entry) => toPosixPath(entry.slice(1)));
  if (!candidatePatterns.some(hasLegacyGlobSyntax)) return;
  if (!sdkGlobTools) {
    try {
      // Bind to the SDK instance already in use, not a separately resolved version.
      const manifest = findPackageJSON("@earendil-works/pi-coding-agent", join(process.cwd(), "package.json"));
      if (!manifest) throw new Error("missing SDK package");
      const sdkRequire = createRequire(join(dirname(manifest), "dist", "core", "package-manager.js"));
      const manager = sdkRequire("./package-manager.js") as { DefaultPackageManager: typeof DefaultPackageManager };
      if (manager.DefaultPackageManager !== DefaultPackageManager) throw new Error("SDK identity mismatch");
      const { minimatch } = sdkRequire("minimatch") as Pick<NonNullable<typeof sdkGlobTools>, "minimatch">;
      const { normalizePath } = sdkRequire("../utils/paths.js") as Pick<NonNullable<typeof sdkGlobTools>, "normalizePath">;
      if (typeof minimatch !== "function" || typeof normalizePath !== "function") throw new Error("missing matcher");
      sdkGlobTools = { minimatch, normalizePath };
    } catch {
      throw new Error("Pi cannot safely check an ambiguous legacy resource glob; SDK matcher unavailable");
    }
  }
  let globs: string[];
  try {
    globs = candidatePatterns.map((pattern) => toPosixPath(sdkGlobTools!.normalizePath(pattern)))
      .filter((pattern) => /[*?()[\]{}]/.test(pattern));
  } catch {
    throw new Error("Pi cannot safely check an invalid legacy resource exclusion");
  }
  if (!globs.length) return;
  if (ruleBaseDir === null && (globs.some((pattern) => pattern.includes(".."))
    || (!isAbsolute(path) && path !== "~" && !path.startsWith("~/") && !path.startsWith("file://")))) {
    throw new Error("Pi cannot safely check an ambiguous legacy resource glob without a rule root");
  }
  let target: string;
  try {
    target = resolveConfiguredPath(path, targetBaseDir);
  } catch {
    return;
  }
  const name = basename(target);
  const baseDir = ruleBaseDir ?? targetBaseDir;
  const candidates = [toPosixPath(relative(baseDir, target)), name, toPosixPath(target)];
  if (name === "SKILL.md") {
    const parent = dirname(target);
    candidates.push(toPosixPath(relative(baseDir, parent)), basename(parent), toPosixPath(parent));
  }
  if (globs.some((pattern) => candidates.some((candidate) => sdkGlobTools!.minimatch(candidate, pattern)))) {
    throw new Error("Pi cannot safely change an ambiguous legacy resource glob; review the existing rule first");
  }
}

function sameResourcePath(
  entry: string,
  path: string,
  baseDir: string,
  resourceType: ResourceSettingKey,
): boolean {
  const stripped = stripPattern(entry);
  // Preserve user glob rules; only recognize Reader's legacy suffix form.
  if (entry.startsWith("!") && /[*?()[\]{}\\]/.test(toPosixPath(stripped))) {
    return stripped.startsWith("**/") && matchesPortableSkillPattern(stripped, path);
  }
  if (!entry.startsWith("+") && !entry.startsWith("-") && hasSdkGlobWildcard(entry)) return false;
  try {
    const targetPath = resolveConfiguredPath(path, baseDir);
    const configuredPath = stripped.startsWith("file://") ? fileURLToPath(stripped) : stripped;
    if (entry.startsWith("!") && /[*?()[\]{}\\]/.test(toPosixPath(configuredPath))) return false;
    const isSkillTarget = resourceType === "skills" && isSkillFilePath(targetPath);
    if (!isSkillTarget || isSkillFilePath(configuredPath)) {
      if (resolveConfiguredPath(stripped, baseDir) === targetPath) return true;
    }
    if (isSkillTarget && !isSkillFilePath(configuredPath)) {
      const normalizedPattern = normalizeSdkParentPattern(entry);
      if (!normalizedPattern) return false;
      const parentDir = dirname(targetPath);
      const parentRel = toPosixPath(relative(baseDir, parentDir));
      const parentDirPosix = toPosixPath(parentDir);
      return normalizedPattern === parentRel || normalizedPattern === parentDirPosix;
    }
  } catch {
    // Invalid existing entries are not ours to remove.
  }
  return false;
}

function updateProjectObject(
  settingsManager: SettingsManager,
  field: string,
  update: (value: Record<string, unknown>) => void,
): void {
  // SAFETY: Managers without the project update method are rejected below.
  const manager = settingsManager as unknown as {
    updateProjectSettings?: (field: string, callback: (settings: SettingsWithUnknown) => void) => void;
  };
  if (!manager.updateProjectSettings) {
    throw new Error("Project settings updates are not supported by this Pi settings manager");
  }
  manager.updateProjectSettings(field, (settings) => {
    const raw = settings[field];
    const value = raw && typeof raw === "object" && !Array.isArray(raw)
      ? structuredClone(raw) as Record<string, unknown>
      : {};
    update(value);
    if (Object.keys(value).length > 0) settings[field] = value;
    else delete settings[field];
  });
}

function readLegacyPackageOverrides(settings: SettingsWithUnknown): Record<string, PluginOverrideState> {
  const raw = settings[LEGACY_PACKAGE_OVERRIDES];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, PluginOverrideState> = {};
  for (const [source, state] of Object.entries(raw)) {
    if ((state === "enabled" || state === "disabled") && source.trim()) result[source] = state;
  }
  return result;
}
function readLegacySkillOverrides(
  settings: SettingsWithUnknown,
): Record<string, Record<string, PluginOverrideState>> {
  const raw = settings[LEGACY_SKILL_OVERRIDES];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, Record<string, PluginOverrideState>> = {};
  for (const [source, rawEntries] of Object.entries(raw)) {
    if (!rawEntries || typeof rawEntries !== "object" || Array.isArray(rawEntries)) continue;
    const entries: Record<string, PluginOverrideState> = {};
    for (const [key, state] of Object.entries(rawEntries)) {
      if ((state === "enabled" || state === "disabled") && key.trim()) entries[key] = state;
    }
    if (Object.keys(entries).length > 0 && source.trim()) result[source] = entries;
  }
  return result;
}

function findProjectPackage(
  settingsManager: SettingsManager,
  source: string,
): { index: number; entry: PackageSource } | undefined {
  const projectPackages = settingsManager.getProjectSettings().packages ?? [];
  const index = projectPackages.findIndex((entry) => samePackageSource(
    settingsManager,
    packageSource(entry),
    source,
  ));
  return index < 0 ? undefined : { index, entry: projectPackages[index] };
}

function isBroadPackagePattern(pattern: string): boolean {
  return pattern === "**" || pattern === "+**" || pattern === "!**" || pattern === "-**";
}

export function getProjectPackageOverride(
  settingsManager: SettingsManager,
  source: string,
): ProjectResourcePolicy {
  return getProjectPluginExplicitState(
    settingsManager.getProjectSettings() as SettingsWithUnknown,
    source,
    { ...packageIdentityOptions(settingsManager), scope: "user" },
  ) ?? "inherit";
}

function resourcePolicyFromPatterns(patterns: string[] | undefined, resourceKey?: string): ProjectResourcePolicy {
  if (!patterns) return "inherit";
  let state: ProjectResourcePolicy = "inherit";
  for (const entry of patterns) {
    // Broad parent patterns (`**` / `!**`) are the package-level baseline; the
    // explicit parent state owns them. Only resource filters are child rules.
    if (isBroadPackagePattern(entry)) continue;
    const target = stripPattern(entry);
    if (resourceKey && target !== resourceKey) continue;
    state = entry.startsWith("-") || entry.startsWith("!") ? "disabled" : "enabled";
  }
  return state;
}

/** Explicit child filter, without the parent package cap. */
export function getProjectPackageResourceFilter(settingsManager: SettingsManager, source: string, resourceType: ResourceSettingKey, resourceKey: string): ProjectResourcePolicy {
  const entry = findProjectPackage(settingsManager, source)?.entry;
  return !entry || typeof entry === "string" ? "inherit" : resourcePolicyFromPatterns(entry[resourceType], resourceKey);
}

export function getGlobalTopLevelSkillOverride(settingsManager: SettingsManager, path: string): ProjectResourcePolicy {
  const agentDir = packageIdentityOptions(settingsManager).agentDir ?? homedir();
  let state: ProjectResourcePolicy = "inherit";
  for (const entry of settingsManager.getGlobalSettings().skills ?? []) {
    if (sameResourcePath(entry, path, agentDir, "skills")) state = entry.startsWith("-") || entry.startsWith("!") ? "disabled" : "enabled";
  }
  return state;
}

export function getProjectPackageResourceOverride(
  settingsManager: SettingsManager,
  source: string,
  resourceType: ResourceSettingKey,
  resourceKey: string,
): ProjectResourcePolicy {
  const parent = getProjectPackageOverride(settingsManager, source);
  if (parent === "disabled") return "disabled";
  const child = getProjectPackageResourceFilter(settingsManager, source, resourceType, resourceKey);
  return child === "inherit" ? parent : child;
}

export function getProjectTopLevelOverride(
  settingsManager: SettingsManager,
  cwd: string,
  resourceType: ResourceSettingKey,
  path: string,
): ProjectResourcePolicy {
  const projectBaseDir = resolvePath(cwd, ".pi");
  const entries = settingsManager.getProjectSettings()[resourceType] ?? [];
  let state: ProjectResourcePolicy = "inherit";
  for (const entry of entries) {
    if (!sameResourcePath(entry, path, projectBaseDir, resourceType)) continue;
    state = entry.startsWith("-") || entry.startsWith("!") ? "disabled" : "enabled";
  }
  return state;
}

function updatePackageEntry(
  settingsManager: SettingsManager,
  source: string,
  update: (entry: { source: string; autoload: false; extensions?: string[]; skills?: string[]; prompts?: string[]; themes?: string[] }) => void,
  removeWhenEmpty = false,
): void {
  const packages = [...(settingsManager.getProjectSettings().packages ?? [])];
  const found = packages.findIndex((entry) => samePackageSource(
    settingsManager,
    packageSource(entry),
    source,
  ));
  const existingSource = found >= 0 ? packageSource(packages[found]) : source;
  const current = found >= 0 && typeof packages[found] === "object"
    ? packages[found] as Exclude<PackageSource, string>
    : { source: existingSource, autoload: false };
  const next = {
    source: existingSource,
    autoload: false as const,
    ...(current.extensions ? { extensions: [...current.extensions] } : {}),
    ...(current.skills ? { skills: [...current.skills] } : {}),
    ...(current.prompts ? { prompts: [...current.prompts] } : {}),
    ...(current.themes ? { themes: [...current.themes] } : {}),
  };
  update(next);
  const hasResourceFilters = RESOURCE_KEYS.some((key) => (next[key]?.length ?? 0) > 0);
  if (found >= 0) {
    if (removeWhenEmpty && !hasResourceFilters) packages.splice(found, 1);
    else packages[found] = next;
  } else if (!removeWhenEmpty || hasResourceFilters) {
    packages.push(next);
  }
  settingsManager.setProjectPackages(packages);
}

export function setProjectPackageOverride(
  settingsManager: SettingsManager,
  source: string,
  state: Exclude<ProjectResourcePolicy, "inherit">,
): void {
  updatePackageEntry(settingsManager, source, (entry) => {
    const base = state === "enabled" ? "**" : "!**";
    for (const key of RESOURCE_KEYS) {
      const existing = entry[key] ?? [];
      entry[key] = [base, ...existing.filter((pattern) => !isBroadPackagePattern(pattern))];
    }
  });
  setProjectPluginExplicitState(settingsManager, source, state, { ...packageIdentityOptions(settingsManager), scope: "user" });
}

export function clearProjectPackageOverride(settingsManager: SettingsManager, source: string): void {
  const packages = [...(settingsManager.getProjectSettings().packages ?? [])];
  const found = packages.findIndex((entry) => samePackageSource(
    settingsManager,
    packageSource(entry),
    source,
  ));
  if (found >= 0) {
    const current = packages[found];
    if (typeof current === "string") {
      packages.splice(found, 1);
    } else {
      const next = { ...current };
      for (const key of RESOURCE_KEYS) {
        const patterns = (next[key] ?? []).filter((pattern) => !isBroadPackagePattern(pattern));
        if (patterns.length > 0) next[key] = patterns;
        else delete next[key];
      }
      const hasResourceFilters = RESOURCE_KEYS.some((key) => (next[key]?.length ?? 0) > 0);
      if (hasResourceFilters) packages[found] = next;
      else packages.splice(found, 1);
    }
  }
  settingsManager.setProjectPackages(packages);
  clearProjectPluginExplicitState(settingsManager, source, { ...packageIdentityOptions(settingsManager), scope: "user" });
}

export async function persistProjectPluginOverride(
  settingsManager: SettingsManager,
  source: string,
  state: PluginOverrideState | null,
): Promise<void> {
  if (state) setProjectPackageOverride(settingsManager, source, state);
  else clearProjectPackageOverride(settingsManager, source);
  await settingsManager.flush();
}

export function setProjectPackageResourceOverride(
  settingsManager: SettingsManager,
  source: string,
  resourceType: ResourceSettingKey,
  resourceKey: string,
  state: Exclude<ProjectResourcePolicy, "inherit">,
): void {
  updatePackageEntry(settingsManager, source, (entry) => {
    const existing = entry[resourceType] ?? [];
    entry[resourceType] = [
      ...existing.filter((pattern) => stripPattern(pattern) !== resourceKey),
      `${state === "enabled" ? "+" : "-"}${resourceKey}`,
    ];
  });
}

export function clearProjectPackageResourceOverride(
  settingsManager: SettingsManager,
  source: string,
  resourceType: ResourceSettingKey,
  resourceKey: string,
): void {
  const existingEntry = findProjectPackage(settingsManager, source)?.entry;
  if (!existingEntry || typeof existingEntry === "string") return;
  // A project-only package carries its install declaration in the same entry.
  // Removing it would uninstall the package, so only a delta over a global
  // package may disappear once its last resource filter is cleared.
  const isDeltaOverGlobal = (settingsManager.getGlobalSettings().packages ?? []).some(
    (entry) => samePackageSource(settingsManager, packageSource(entry), source),
  );
  updatePackageEntry(settingsManager, source, (entry) => {
    const existing = entry[resourceType] ?? [];
    const next = existing.filter((pattern) => stripPattern(pattern) !== resourceKey);
    if (next.length > 0) entry[resourceType] = next;
    else delete entry[resourceType];
  }, isDeltaOverGlobal);

  if (isDeltaOverGlobal) return;
  // Without a global parent the entry *is* the project declaration, so an entry
  // left with no filters would be inert (`autoload: false` is a delta marker).
  // Restore the plain source form so the package autoloads again.
  const remaining = findProjectPackage(settingsManager, source)?.entry;
  if (!remaining || typeof remaining === "string") return;
  const hasFilters = RESOURCE_KEYS.some((key) => (remaining[key]?.length ?? 0) > 0);
  if (hasFilters || isDisabledPackage(remaining)) return;
  const packages = [...(settingsManager.getProjectSettings().packages ?? [])];
  const index = packages.findIndex((entry) => samePackageSource(
    settingsManager,
    packageSource(entry),
    source,
  ));
  if (index < 0) return;
  packages[index] = remaining.source;
  settingsManager.setProjectPackages(packages);
}

/** Convert an absolute path under the home directory to portable `~/...` form. */
function portablePath(input: string): string {
  const home = homedir();
  if (input === home) return "~";
  const homeRelative = homeRelativePath(input);
  return homeRelative ? `~/${homeRelative}` : input;
}

function topLevelOverrideEntries(path: string, state: Exclude<ProjectResourcePolicy, "inherit">): string[] {
  assertTopLevelOverridePathSupported(path);
  const localPath = path.startsWith("file://") ? fileURLToPath(path) : path;
  // Pi otherwise interprets an unsigned * or ? as an include glob.
  if (hasSdkGlobWildcard(localPath)) {
    const literal = pathToFileURL(localPath).href.replaceAll("*", "%2A");
    return state === "enabled" ? [literal] : [literal, `-${literal}`];
  }
  const portable = portablePath(localPath);
  if (state === "enabled") return [portable];
  // A home-relative exact exclusion stays portable without matching other roots.
  return [portable, exactExcludeRequired(localPath) ? `-${portable}` : `!${portable}`];
}

export function setProjectTopLevelOverride(
  settingsManager: SettingsManager,
  cwd: string,
  resourceType: ResourceSettingKey,
  path: string,
  state: Exclude<ProjectResourcePolicy, "inherit">,
): void {
  const projectBaseDir = resolvePath(cwd, ".pi");
  const current = settingsManager.getProjectSettings()[resourceType] ?? [];
  assertNoAmbiguousLegacyGlob(settingsManager.getGlobalSettings()[resourceType] ?? [], path, projectBaseDir, packageIdentityOptions(settingsManager).agentDir ?? null);
  assertNoAmbiguousLegacyGlob(current, path, projectBaseDir);
  const updated = current.filter((entry) => !sameResourcePath(entry, path, projectBaseDir, resourceType));
  updated.push(...topLevelOverrideEntries(path, state));
  if (resourceType === "skills") settingsManager.setProjectSkillPaths(updated);
  else if (resourceType === "extensions") settingsManager.setProjectExtensionPaths(updated);
  else if (resourceType === "prompts") settingsManager.setProjectPromptTemplatePaths(updated);
  else settingsManager.setProjectThemePaths(updated);
}

export function clearProjectTopLevelOverride(
  settingsManager: SettingsManager,
  cwd: string,
  resourceType: ResourceSettingKey,
  path: string,
): void {
  const projectBaseDir = resolvePath(cwd, ".pi");
  const current = settingsManager.getProjectSettings()[resourceType] ?? [];
  assertNoAmbiguousLegacyGlob(settingsManager.getGlobalSettings()[resourceType] ?? [], path, projectBaseDir, packageIdentityOptions(settingsManager).agentDir ?? null);
  assertNoAmbiguousLegacyGlob(current, path, projectBaseDir);
  const updated = current.filter((entry) => !sameResourcePath(entry, path, projectBaseDir, resourceType));
  if (resourceType === "skills") settingsManager.setProjectSkillPaths(updated);
  else if (resourceType === "extensions") settingsManager.setProjectExtensionPaths(updated);
  else if (resourceType === "prompts") settingsManager.setProjectPromptTemplatePaths(updated);
  else settingsManager.setProjectThemePaths(updated);
}

/**
 * Apply a global top-level Skill resource state using Pi's native global
 * `skills` path list. Invocation mode is persisted independently by
 * `skill-policy.ts`; this helper only controls whether the resource loads.
 */
export function setGlobalTopLevelSkillOverride(
  settingsManager: SettingsManager,
  path: string,
  state: Exclude<ProjectResourcePolicy, "inherit">,
): void {
  const agentDir = packageIdentityOptions(settingsManager).agentDir;
  const current = settingsManager.getGlobalSettings().skills ?? [];
  assertNoAmbiguousLegacyGlob(current, path, agentDir ?? homedir(), agentDir ?? null);
  const updated = current.filter((entry) => !sameResourcePath(entry, path, agentDir ?? homedir(), "skills"));
  updated.push(...topLevelOverrideEntries(path, state));
  settingsManager.setSkillPaths(updated);
}

export function clearGlobalTopLevelSkillOverride(
  settingsManager: SettingsManager,
  path: string,
): void {
  const agentDir = packageIdentityOptions(settingsManager).agentDir;
  const current = settingsManager.getGlobalSettings().skills ?? [];
  assertNoAmbiguousLegacyGlob(current, path, agentDir ?? homedir(), agentDir ?? null);
  const updated = current.filter((entry) => !sameResourcePath(entry, path, agentDir ?? homedir(), "skills"));
  settingsManager.setSkillPaths(updated);
}

export function migrateLegacyProjectOverrides(settingsManager: SettingsManager, cwd?: string): boolean {
  const project = settingsManager.getProjectSettings() as SettingsWithUnknown;
  // Validate the later migration before this one schedules any SDK writes.
  const options = packageIdentityOptions(settingsManager);
  validateProjectWebStatePaths(project, cwd ?? options.cwd, settingsManager.getGlobalSettings().skills, options.agentDir ?? null);
  const legacySkills = readLegacySkillOverrides(project);
  let changed = false;
  for (const [source, entries] of Object.entries(legacySkills)) {
    for (const [resourceKey, state] of Object.entries(entries)) {
      if (getProjectPackageResourceOverride(settingsManager, source, "skills", resourceKey) === "inherit") {
        setProjectPackageResourceOverride(settingsManager, source, "skills", resourceKey, state);
        changed = true;
      }
    }
  }
  return changed;
}

const PROJECT_PLUGIN_STATES = "piWebProjectPluginStates";
const PROJECT_SKILL_STATES = "piWebProjectSkillStates";

function assertLegacyPathPlatformCompatible(path: string): void {
  let target = path;
  if (path.startsWith("file:")) {
    try {
      if (!path.startsWith("file://")) throw new Error("invalid file URL");
      target = fileURLToPath(path);
    } catch {
      throw new Error("Pi cannot safely migrate an invalid resource file URL");
    }
  }
  const foreignWindows = process.platform !== "win32" && !isAbsolute(target) && isWindowsAbsolutePath(target);
  const foreignWindowsUrl = process.platform !== "win32" && path.startsWith("file:") && /^\/[a-z]:\//i.test(target);
  const foreignPosix = process.platform === "win32" && target.startsWith("/") && !target.startsWith("//");
  if (foreignWindows || foreignWindowsUrl || foreignPosix) {
    throw new Error("Pi cannot safely migrate a resource path from another platform; review the existing rule first");
  }
}

function validateProjectWebStatePaths(project: SettingsWithUnknown, cwd?: string, globalSkills?: string[], agentDir: string | null = null): void {
  for (const source of Object.keys(readLegacySkillOverrides(project))) {
    assertLegacyPathPlatformCompatible(source.startsWith("local:") ? source.slice("local:".length) : source);
  }
  const skillStates = project[PROJECT_SKILL_STATES];
  if (!skillStates || typeof skillStates !== "object" || Array.isArray(skillStates)) return;
  const projectExclusions = (Array.isArray(project.skills) ? project.skills : []).filter((entry) => typeof entry === "string" && entry.startsWith("!"));
  const globalExclusions = (Array.isArray(globalSkills) ? globalSkills : []).filter((entry) => typeof entry === "string" && entry.startsWith("!"));
  for (const [key, state] of Object.entries(skillStates as Record<string, unknown>)) {
    if (state !== "enabled" && state !== "disabled") continue;
    if (key.startsWith("package:local:")) {
      const rest = key.slice("package:local:".length);
      const delimiter = rest.lastIndexOf(":");
      if (delimiter > 0) assertLegacyPathPlatformCompatible(rest.slice(0, delimiter));
      continue;
    }
    if (!key.startsWith("top-level:")) continue;
    const path = key.slice("top-level:".length);
    if (!path.trim()) continue;
    assertTopLevelOverridePathSupported(path);
    assertLegacyPathPlatformCompatible(path);
    const projectBaseDir = cwd ? resolvePath(cwd, ".pi") : ".";
    assertNoAmbiguousLegacyGlob(projectExclusions, path, projectBaseDir, cwd ? projectBaseDir : null);
    assertNoAmbiguousLegacyGlob(globalExclusions, path, projectBaseDir, agentDir);
  }
}

function sourceFromIdentity(identity: string): string {
  if (!identity.startsWith("local:")) return identity;
  return portablePath(identity.slice("local:".length));
}

/**
 * Migrate Reader-private resource state keys (piWebProjectSkillStates /
 * legacy piWebPluginOverrides keys) into pi-core native resource channels,
 * then drop old keys. Parent package snapshots stay unmarked and inherit global state.
 * Idempotent: runs once, no-op afterwards. Caller flushes when true.
 */
export function migrateProjectWebStateKeys(settingsManager: SettingsManager, cwd: string): boolean {
  const project = settingsManager.getProjectSettings() as SettingsWithUnknown;
  validateProjectWebStatePaths(project, cwd, settingsManager.getGlobalSettings().skills, packageIdentityOptions(settingsManager).agentDir ?? null);
  let changed = false;

  // Old parent snapshots cannot distinguish automatic state from user intent.

  const skillStates = project[PROJECT_SKILL_STATES];
  if (skillStates && typeof skillStates === "object" && !Array.isArray(skillStates)) {
    for (const [key, state] of Object.entries(skillStates as Record<string, unknown>)) {
      if (state !== "enabled" && state !== "disabled") continue;
      if (key.startsWith("top-level:")) {
        const path = key.slice("top-level:".length);
        if (!path.trim()) continue;
        if (getProjectTopLevelOverride(settingsManager, cwd, "skills", path) === "inherit") {
          setProjectTopLevelOverride(settingsManager, cwd, "skills", path, state);
          changed = true;
        }
      } else if (key.startsWith("package:")) {
        const rest = key.slice("package:".length);
        const sep = rest.lastIndexOf(":");
        if (sep <= 0) continue;
        const source = sourceFromIdentity(rest.slice(0, sep));
        const resourceKey = rest.slice(sep + 1);
        if (!source.trim() || !resourceKey.trim()) continue;
        if (getProjectPackageResourceOverride(settingsManager, source, "skills", resourceKey) === "inherit") {
          setProjectPackageResourceOverride(settingsManager, source, "skills", resourceKey, state);
          changed = true;
        }
      }
    }
  }

  for (const field of [PROJECT_PLUGIN_STATES, PROJECT_SKILL_STATES, LEGACY_PACKAGE_OVERRIDES, LEGACY_SKILL_OVERRIDES]) {
    if (Object.prototype.hasOwnProperty.call(project, field)) {
      updateProjectObject(settingsManager, field, (value) => {
        for (const key of Object.keys(value)) delete value[key];
      });
      changed = true;
    }
  }
  return changed;
}

export function getLegacyPackageOverrides(settingsManager: SettingsManager): Record<string, PluginOverrideState> {
  return readLegacyPackageOverrides(settingsManager.getProjectSettings() as SettingsWithUnknown);
}

export function getLegacySkillOverrides(
  settingsManager: SettingsManager,
): Record<string, Record<string, PluginOverrideState>> {
  return readLegacySkillOverrides(settingsManager.getProjectSettings() as SettingsWithUnknown);
}

export function packageSourceString(entry: PackageSource): string {
  return packageSource(entry);
}

function toPosixPath(input: string): string {
  return input.split(sep).join("/");
}

function normalizeSdkExactPattern(pattern: string): string {
  const normalized = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
  return toPosixPath(normalized);
}

function normalizeSdkParentPattern(entry: string): string | undefined {
  if (entry.startsWith("!")) return undefined;
  const pattern = entry.startsWith("+") || entry.startsWith("-") ? entry.slice(1) : entry;
  const normalized = normalizeSdkExactPattern(pattern.startsWith("file://") ? fileURLToPath(pattern) : pattern);
  // The SDK exact override matcher expands "~" through normalizePath;
  // mirror its join() semantics so a home-relative trailing slash remains
  // literal, while ordinary absolute/relative literals stay exact as well.
  if (normalized === "~") return toPosixPath(homedir());
  if (normalized.startsWith("~/")) {
    return toPosixPath(join(homedir(), normalized.slice(2)));
  }
  return normalized;
}
