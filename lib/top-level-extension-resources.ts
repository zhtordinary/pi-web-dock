import { basename, dirname, extname, relative, resolve } from "path";
import type {
  ResolvedPaths,
  ResolvedResource,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getProjectTopLevelOverride } from "./project-resource-policy";
import type {
  PluginScope,
  PluginTopLevelExtensionInfo,
} from "./api-types";

function toPluginScope(scope: string): PluginScope {
  return scope === "project" ? "project" : "global";
}

function getResourceName(path: string): string {
  const file = basename(path);
  const ext = extname(file);
  if (/^index\.(ts|js)$/.test(file)) return basename(dirname(path));
  return ext ? file.slice(0, -ext.length) : file;
}

function getRelativePath(resource: ResolvedResource): string {
  const baseDir = resource.metadata.baseDir;
  if (!baseDir) return resource.path;
  const rel = relative(baseDir, resource.path).replaceAll("\\", "/");
  return rel && !rel.startsWith("..") ? rel : resource.path;
}

export function topLevelExtensionPattern(
  resource: ResolvedResource,
  agentDir: string,
): string {
  const baseDir = resource.metadata.baseDir ?? agentDir;
  const rel = relative(baseDir, resource.path).replaceAll("\\", "/");
  return rel && !rel.startsWith("..") ? rel : resource.path;
}

function stripResourcePattern(entry: string): string {
  return /^[!+-]/.test(entry) ? entry.slice(1) : entry;
}

export function updateTopLevelExtensionPaths(
  current: string[],
  pattern: string,
  enabled: boolean,
): string[] {
  return [
    ...current.filter((entry) => stripResourcePattern(entry) !== pattern),
    `${enabled ? "+" : "-"}${pattern}`,
  ];
}

export function collectTopLevelExtensions(
  paths: ResolvedPaths,
  viewScope: PluginScope,
  globalResources: ReadonlyMap<string, ResolvedResource> = new Map(),
  settingsManager?: SettingsManager,
  cwd?: string,
): PluginTopLevelExtensionInfo[] {
  return paths.extensions
    .filter((resource) => resource.metadata.origin === "top-level")
    .filter((resource) => viewScope === "project" || resource.metadata.scope === "user")
    .map((resource) => {
      const key = resolve(resource.path);
      const globalResource = globalResources.get(key);
      const projectOverride = viewScope === "project" && settingsManager && cwd && resource.metadata.scope === "user"
        ? getProjectTopLevelOverride(settingsManager, cwd, "extensions", resource.path)
        : "inherit";
      const projectStatus = viewScope !== "project"
        ? undefined
        : resource.metadata.scope === "project"
          ? "project" as const
          : resource.enabled === (globalResource?.enabled ?? resource.enabled)
            ? "matching" as const
            : "different" as const;
      return {
        name: getResourceName(resource.path),
        path: resource.path,
        relativePath: getRelativePath(resource),
        source: resource.metadata.source ?? "unknown",
        scope: toPluginScope(resource.metadata.scope),
        enabled: resource.enabled,
        globalEnabled: viewScope === "project" && resource.metadata.scope === "user"
          ? globalResource?.enabled
          : undefined,
        projectOverride: projectOverride === "inherit" ? undefined : projectOverride,
        projectStatus,
        status: resource.enabled ? "loaded" : "disabled",
      } satisfies PluginTopLevelExtensionInfo;
    })
    .sort((left, right) =>
      left.scope.localeCompare(right.scope) || left.path.localeCompare(right.path),
    );
}
