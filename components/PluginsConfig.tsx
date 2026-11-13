"use client";

function apiFor(peer: string | undefined, path: string): string {
  if (!peer) return `/api/${path}`;
  const [route, query] = path.split("?", 2);
  return `/api/remote/${route}?${query ? query + "&" : ""}peer=${peer}`;
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, FolderOpen, Copy, Check, ChevronDown } from "lucide-react";
import { copyText } from "@/lib/clipboard";
import { reloadAllAgentSessions } from "@/lib/agent-client";
import { useIsMobile } from "@/hooks/useIsMobile";
import type {
  PluginOverrideState,
  PluginPackageInfo,
  PluginTopLevelExtensionInfo,
  PluginsResponse,
  ProjectTrustStatus,
} from "@/lib/api-types";
import { projectTrustReloadKey } from "./settings-ui-helpers";
import { activateConfigRowOnKeyDown, ConfigButton, ConfigFooter, ConfigScopeTag, ConfigSwitch, useSettingsDetailNavigation } from "./SettingsUi";
import { ConfigPanelRefreshButton, useConfigSidebarResize } from "./ConfigPanelShared";
import type { BuiltinRuntimeExtensionInfo } from "@/lib/builtin-runtime-extensions";
import { useI18n } from "@/hooks/useI18n";
import { getPluginProjectStatus } from "@/lib/plugin-project-status-client";
import { notifyEmbeddedModalState } from "@/lib/embedded-modal";
import { pluginNameFromSource, pluginSourceKind } from "@/lib/plugin-source";
import { BUILTIN_RUNTIME_EXTENSIONS } from "@/lib/builtin-runtime-extensions";
import type { PluginSourceKind } from "@/lib/plugin-source";

export { pluginSourceKind };

type PluginScope = PluginPackageInfo["scope"];
type PluginAction = "install" | "remove" | "update" | "disable" | "enable";
type TopLevelExtensionAction = "set_top_level_extension" | "clear_top_level_extension";
type ProjectOverrideAction = "set_project_override" | "clear_project_override";

const PLUGIN_SOURCE_KINDS: PluginSourceKind[] = ["local", "npm", "git"];

function pluginSourceRank(source: string): number {
  return { local: 0, npm: 1, git: 2 }[pluginSourceKind(source)];
}

export function pluginDisplayName(pkg: PluginPackageInfo): string {
  return pluginNameFromSource(pkg.source, pkg.packageName);
}

export function isPackageVisible(
  pkg: PluginPackageInfo,
  showEnabled: boolean,
  showNotEnabled = true,
): boolean {
  const notEnabled = pkg.disabled || pkg.status === "disabled" || pkg.status === "missing";
  return notEnabled ? showNotEnabled : showEnabled;
}

function packageEnabledForView(pkg: PluginPackageInfo, viewScope: PluginScope): boolean {
  return viewScope === "global" ? !(pkg.globalDisabled ?? pkg.disabled) : !pkg.disabled;
}

function projectStateLabel(
  projectStatus: PluginPackageInfo["projectStatus"] | undefined,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (projectStatus === "matching") return t("i18n.projectPluginStateMatching");
  if (projectStatus === "project") return t("i18n.projectFilterProject");
  return t("i18n.projectPluginStateDifferent");
}

export type ProjectPackageFilter = "different" | "all" | "matching" | "project";

function projectPackageStatus(pkg: PluginPackageInfo): PluginPackageInfo["projectStatus"] {
  // Keep a defensive fallback for responses from an older Reader build while
  // the API and client are being rolled out together.
  return pkg.projectStatus
    ?? getPluginProjectStatus(pkg.scope, pkg.globalDisabled, pkg.projectOverride);
}

export function isProjectPackageVisible(
  pkg: PluginPackageInfo,
  filter: ProjectPackageFilter,
): boolean {
  const status = projectPackageStatus(pkg);
  if (filter === "all") return true;
  if (filter === "matching") return status === "matching";
  if (filter === "different") return status === "different";
  if (filter === "project") return status === "project";
  return true;
}

export function projectPackageFilterCounts(
  packages: PluginPackageInfo[],
): Record<ProjectPackageFilter, number> {
  const counts: Record<ProjectPackageFilter, number> = {
    different: 0,
    all: packages.length,
    matching: 0,
    project: 0,
  };
  for (const pkg of packages) {
    const status = projectPackageStatus(pkg);
    if (status === "different") counts.different += 1;
    else if (status === "project") counts.project += 1;
    else counts.matching += 1;
  }
  return counts;
}

export function topLevelExtensionKey(extension: PluginTopLevelExtensionInfo): string {
  return `${extension.scope}\0${extension.path}`;
}

export function builtinRuntimeExtensionKey(extension: BuiltinRuntimeExtensionInfo): string {
  return `builtin:${extension.id}`;
}

export function isBuiltinRuntimeExtensionSearchMatch(
  extension: BuiltinRuntimeExtensionInfo,
  query: string,
  displayName = "",
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [extension.id, displayName, ...extension.capabilities.map((capability) => capability.name)]
    .some((value) => value.toLowerCase().includes(normalized));
}

export function filterBuiltinRuntimeExtensions(
  extensions: readonly BuiltinRuntimeExtensionInfo[],
  options: { searchQuery: string; showEnabled: boolean; viewScope: "global" | "project" },
  displayName?: (extension: BuiltinRuntimeExtensionInfo) => string,
): BuiltinRuntimeExtensionInfo[] {
  if (!options.showEnabled || options.viewScope !== "global") return [];
  return extensions.filter((extension) => isBuiltinRuntimeExtensionSearchMatch(extension, options.searchQuery, displayName?.(extension)));
}

export function isTopLevelExtensionVisible(
  extension: PluginTopLevelExtensionInfo,
  showEnabled: boolean,
  showNotEnabled = true,
): boolean {
  const notEnabled = !extension.enabled || extension.status === "disabled";
  return notEnabled ? showNotEnabled : showEnabled;
}

export function isTopLevelExtensionSearchMatch(
  extension: PluginTopLevelExtensionInfo,
  query: string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [extension.name, extension.path, extension.source]
    .some((value) => value.toLowerCase().includes(normalized));
}

export function filterTopLevelExtensions(
  extensions: PluginTopLevelExtensionInfo[],
  options: { searchQuery: string; showEnabled: boolean; showNotEnabled: boolean },
): PluginTopLevelExtensionInfo[] {
  return extensions
    .filter((extension) => isTopLevelExtensionSearchMatch(extension, options.searchQuery))
    .filter((extension) => isTopLevelExtensionVisible(extension, options.showEnabled, options.showNotEnabled));
}

function topLevelExtensionProjectStatus(
  extension: PluginTopLevelExtensionInfo,
): PluginTopLevelExtensionInfo["projectStatus"] {
  if (extension.projectStatus) return extension.projectStatus;
  if (extension.scope === "project") return "project";
  return extension.enabled === (extension.globalEnabled ?? extension.enabled) ? "matching" : "different";
}

export function isProjectTopLevelExtensionVisible(
  extension: PluginTopLevelExtensionInfo,
  filter: ProjectPackageFilter,
): boolean {
  const status = topLevelExtensionProjectStatus(extension);
  if (filter === "all") return true;
  if (filter === "matching") return status === "matching";
  if (filter === "different") return status === "different";
  if (filter === "project") return status === "project";
  return true;
}

export function projectTopLevelExtensionFilterCounts(
  extensions: PluginTopLevelExtensionInfo[],
): Record<ProjectPackageFilter, number> {
  const counts: Record<ProjectPackageFilter, number> = {
    different: 0,
    all: extensions.length,
    matching: 0,
    project: 0,
  };
  for (const extension of extensions) {
    const status = topLevelExtensionProjectStatus(extension);
    if (status === "different") counts.different += 1;
    else if (status === "project") counts.project += 1;
    else counts.matching += 1;
  }
  return counts;
}

export function isPluginSearchMatch(pkg: PluginPackageInfo, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [pluginDisplayName(pkg), pkg.source, pkg.packageName ?? "", pkg.description ?? ""]
    .some((value) => value.toLowerCase().includes(normalized));
}

export function filterPackagesForProjectStatusCounts(
  packages: PluginPackageInfo[],
  options: { searchQuery: string; showEnabled: boolean; showNotEnabled: boolean },
): PluginPackageInfo[] {
  return packages
    .filter((pkg) => isPluginSearchMatch(pkg, options.searchQuery))
    .filter((pkg) => isPackageVisible(pkg, options.showEnabled, options.showNotEnabled));
}

function pluginSourceLabel(
  sourceKind: PluginSourceKind,
  t: ReturnType<typeof useI18n>["t"],
): string {
  const key = sourceKind === "local"
    ? "i18n.pluginSourceLocal"
    : sourceKind === "npm"
      ? "i18n.pluginSourceNpm"
      : "i18n.pluginSourceGit";
  return t(key);
}

export function comparePluginPackages(a: PluginPackageInfo, b: PluginPackageInfo): number {
  const rankDifference = pluginSourceRank(a.source) - pluginSourceRank(b.source);
  return rankDifference || a.source.localeCompare(b.source);
}

function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

export function pluginSettingsPath(scope: PluginScope, cwd: string): string {
  return scope === "project"
    ? `${shortenPath(cwd)}/.pi/settings.json`
    : "~/.pi/agent/settings.json";
}

function normalizePluginSourceInput(value: string): string {
  const match = value.trim().match(/^\$?\s*pi\s+install\s+(\S+)\s*$/);
  return match?.[1] ?? value;
}

function packageKey(pkg: Pick<PluginPackageInfo, "source" | "scope">): string {
  return `${pkg.scope}\0${pkg.source}`;
}

export interface PluginOwnerIdentity {
  generation: number;
  cwd: string;
  peer?: string;
  viewScope: PluginScope;
  revision?: number;
  trustKey?: string;
}

export function isPluginOwnerCurrent(
  owner: PluginOwnerIdentity,
  current: PluginOwnerIdentity,
): boolean {
  return owner.generation === current.generation
    && owner.cwd === current.cwd
    && owner.peer === current.peer
    && owner.viewScope === current.viewScope
    && owner.revision === current.revision
    && owner.trustKey === current.trustKey;
}

export function usePluginLoadEffect(
  loadPlugins: () => Promise<unknown>,
  remotePeer: string | undefined,
  revision: number,
  cwd: string,
  viewScope: PluginScope,
): void {
  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins, remotePeer, revision, cwd, viewScope]);
}

export function firstRenderedPluginKey(
  packages: readonly PluginPackageInfo[],
  builtinRuntimeExtensions: readonly BuiltinRuntimeExtensionInfo[],
  topLevelExtensions: readonly PluginTopLevelExtensionInfo[],
): string | null {
  const firstPackage = [...packages].sort(comparePluginPackages)[0];
  return firstPackage
    ? packageKey(firstPackage)
    : builtinRuntimeExtensions[0]
      ? builtinRuntimeExtensionKey(builtinRuntimeExtensions[0])
      : topLevelExtensions[0]
        ? topLevelExtensionKey(topLevelExtensions[0])
        : null;
}

function resourceSummary(pkg: PluginPackageInfo, t: ReturnType<typeof useI18n>["t"]): string {
  if (pkg.disabled) return t("i18n.disabled");
  const parts = [
    pkg.counts.extensions ? t("i18n.resourceCount", { count: pkg.counts.extensions, label: t("i18n.extensionShort") }) : "",
    pkg.counts.skills ? t("i18n.resourceCount", { count: pkg.counts.skills, label: t("i18n.skillShort") }) : "",
    pkg.counts.prompts ? t("i18n.resourceCount", { count: pkg.counts.prompts, label: t("i18n.promptShort") }) : "",
    pkg.counts.themes ? t("i18n.resourceCount", { count: pkg.counts.themes, label: t("i18n.themeShort") }) : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : t("i18n.noResources");
}

function versionSummary(pkg: PluginPackageInfo, t: ReturnType<typeof useI18n>["t"]): string {
  const parts = [];
  if (pkg.version) parts.push(t("i18n.installedVersion", { version: pkg.version }));
  if (pkg.configuredVersion) parts.push(t("i18n.configuredVersion", { version: pkg.configuredVersion }));
  return parts.length ? parts.join(" · ") : t("i18n.unknown");
}

function installLocation(scope: PluginScope, cwd: string): string {
  return scope === "project"
    ? `${shortenPath(cwd)}/.pi/agent/{npm,git}`
    : "~/.pi/agent/{npm,git}";
}

function findInstalledPackage(
  packages: PluginPackageInfo[],
  source: string,
  scope: PluginScope,
): PluginPackageInfo | undefined {
  const trimmed = source.trim();
  const withoutNpmPrefix = trimmed.startsWith("npm:") ? trimmed.slice(4) : trimmed;
  return packages.find((pkg) => pkg.scope === scope && pkg.source === trimmed)
    ?? packages.find((pkg) => pkg.scope === scope && pkg.source === `npm:${withoutNpmPrefix}`)
    ?? packages.find((pkg) => pkg.scope === scope && pkg.source.endsWith(trimmed));
}

function statusColor(status: PluginPackageInfo["status"]): string {
  if (status === "loaded") return "var(--accent)";
  if (status === "installed") return "#f59e0b";
  if (status === "disabled") return "var(--text-dim)";
  return "#ef4444";
}

function ResourceList({ pkg }: { pkg: PluginPackageInfo }) {
  const { t } = useI18n();
  const groups = ([
    ["extension", t("i18n.extensions")],
    ["skill", t("i18n.skills")],
    ["prompt", t("i18n.prompts")],
    ["theme", t("i18n.themes")],
  ] as const)
    .map(([kind, label]) => ({
      kind,
      label,
      resources: pkg.resources.filter((resource) => resource.kind === kind),
    }))
    .filter((group) => group.resources.length > 0);

  if (groups.length === 0) {
    return (
      <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
        {pkg.disabled ? t("i18n.packageDisabled") : t("i18n.noResolvedResources")}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {pkg.disabled && (
        <div
          style={{
            fontSize: 11,
            color: "var(--text-dim)",
            background: "var(--bg)",
            padding: "5px 8px",
            borderRadius: 4,
            border: "1px solid var(--border)",
          }}
        >
          {t("i18n.pluginResourcesUnloadedNotice")}
        </div>
      )}
      {groups.map((group, groupIndex) => (
        <div
          key={group.kind}
          style={{
            borderTop: groupIndex === 0 ? "none" : "1px solid var(--border)",
            paddingTop: groupIndex === 0 ? 0 : 12,
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "var(--text-dim)",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            {group.label}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {group.resources.map((resource) => (
              <div key={`${resource.kind}:${resource.path}`} style={{ minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 12,
                    color: "var(--text)",
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={resource.path}
                >
                  {resource.name}
                  {resource.resourceState && (
                    <span
                      style={{
                        fontSize: 9,
                        padding: "1px 4px",
                        borderRadius: 3,
                        color: resource.resourceState === "enabled" ? "var(--accent)" : "var(--text-dim)",
                        background: resource.resourceState === "enabled"
                          ? "rgba(37,99,235,0.10)"
                          : "rgba(120,120,120,0.10)",
                      }}
                    >
                      {resource.resourceState}
                    </span>
                  )}
                  {resource.kind === "skill" && resource.invocationMode && (
                    <span
                      style={{
                        fontSize: 9,
                        padding: "1px 4px",
                        borderRadius: 3,
                        color: resource.invocationMode === "automatic" ? "var(--accent)" : "#b45309",
                        background: resource.invocationMode === "automatic"
                          ? "rgba(37,99,235,0.10)"
                          : "rgba(245,158,11,0.12)",
                      }}
                    >
                      {resource.invocationMode}
                    </span>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--text-dim)",
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    marginTop: 1,
                  }}
                  title={resource.path}
                >
                  {resource.relativePath}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function FilterButton({
  active,
  label,
  onToggle,
}: {
  active: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onToggle}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        minHeight: 28,
        padding: "4px 9px",
        border: `1px solid ${active ? "rgba(37,99,235,0.55)" : "var(--border)"}`,
        borderRadius: 5,
        background: active ? "rgba(37,99,235,0.13)" : "none",
        color: active ? "var(--accent)" : "var(--text-dim)",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: active ? 600 : 400,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: active ? "#2563eb" : "var(--border)",
          boxShadow: active ? "0 0 0 2px rgba(37,99,235,0.16)" : "none",
        }}
      />
      {label}
    </button>
  );
}

function SegmentedScope({
  value,
  projectResourcesLoaded,
  onChange,
}: {
  value: PluginScope;
  projectResourcesLoaded: boolean;
  onChange: (scope: PluginScope) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        display: "inline-flex",
        border: "1px solid var(--border)",
        borderRadius: 7,
        overflow: "hidden",
        height: 30,
      }}
    >
      {(["global", "project"] as PluginScope[]).map((scope) => {
        const active = value === scope;
        const disabled = scope === "project" && !projectResourcesLoaded;
        return (
          <button
            key={scope}
            onClick={() => {
              if (!disabled) onChange(scope);
            }}
            disabled={disabled}
            title={disabled ? t("trust.projectScopeUnavailable") : undefined}
            style={{
              width: 120,
              border: "none",
              borderRight: scope === "global" ? "1px solid var(--border)" : "none",
              background: active ? "rgba(37,99,235,0.13)" : "none",
              color: active ? "var(--accent)" : "var(--text-muted)",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.45 : 1,
              fontSize: 12,
              fontWeight: active ? 600 : 400,
            }}
          >
            {scope === "global" ? t("i18n.pluginConfigGlobal") : t("i18n.pluginConfigProject")}
          </button>
        );
      })}
    </div>
  );
}

function AddPluginPanel({
  cwd,
  source,
  scope,
  busy,
  actionError,
  onSourceChange,
  onInstall,
}: {
  cwd: string;
  source: string;
  scope: PluginScope;
  busy: boolean;
  actionError: string | null;
  onSourceChange: (value: string) => void;
  onInstall: () => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const examples = ["npm:@scope/pi-plugin", "git:https://github.com/user/repo", "/absolute/path/to/plugin"];

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 660, minHeight: "100%" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
            {t("i18n.addPlugin")}
          </div>
          <a
            href="https://pi.dev/packages"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              color: "var(--accent)",
              fontSize: 12,
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            <svg width="28" height="28" viewBox="0 0 800 800" aria-hidden="true" focusable="false" style={{ flexShrink: 0 }}>
              <path
                fill="#000"
                fillRule="evenodd"
                d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
              />
              <path fill="#000" d="M517.36 400H634.72V634.72H517.36Z" />
            </svg>
            pi.dev/packages
          </a>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
          {installLocation(scope, cwd)}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <label htmlFor="plugin-source" style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
          Source
        </label>
        <input
          id="plugin-source"
          ref={inputRef}
          value={source}
          onChange={(e) => onSourceChange(e.target.value)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text");
            const normalized = normalizePluginSourceInput(pasted);
            if (normalized === pasted) return;
            e.preventDefault();
            onSourceChange(normalized);
          }}
          onBlur={(e) => onSourceChange(normalizePluginSourceInput(e.currentTarget.value))}
          placeholder="npm:@scope/package"
          style={{
            width: "100%",
            height: 36,
            padding: "0 11px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            outline: "none",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && source.trim() && !busy) onInstall();
          }}
        />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <ConfigButton variant="primary"
          type="button"
          onClick={onInstall}
          disabled={busy || !source.trim()}
        >
          {busy ? t("i18n.installing") : t("i18n.install")}
        </ConfigButton>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
          Examples
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => onSourceChange(example)}
              style={{
                width: "100%",
                minHeight: 30,
                textAlign: "left",
                padding: "6px 9px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg-panel)",
                color: "var(--text-dim)",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text-muted)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--bg-panel)";
                e.currentTarget.style.color = "var(--text-dim)";
              }}
            >
              {example}
            </button>
          ))}
        </div>
      </div>

      {actionError && (
        <div style={{ fontSize: 12, color: "#ef4444", whiteSpace: "pre-wrap" }}>
          {actionError}
        </div>
      )}
    </div>
  );
}

function PackageDetail({
  pkg,
  cwd,
  busyKey,
  actionError,
  actionMessage,
  viewScope,
  onAction,
  onProjectOverride,
  onReloadAllSessions,
  revealUrl,
  onOpenFile,
}: {
  revealUrl: string;
  onOpenFile?: (filePath: string) => void;
  pkg: PluginPackageInfo;
  cwd: string;
  busyKey: string | null;
  actionError: string | null;
  actionMessage: string | null;
  viewScope: PluginScope;
  onAction: (action: PluginAction, pkg: PluginPackageInfo) => void;
  onProjectOverride: (pkg: PluginPackageInfo, state: PluginOverrideState | null) => void;
  onReloadAllSessions: () => void;
}) {
  const { t } = useI18n();
  const key = packageKey(pkg);
  const busy = busyKey?.endsWith(key) ?? false;
  const reloadBusy = busyKey === "reload";
  const isGlobalProjectPackage = viewScope === "project" && pkg.scope === "global";
  const projectStatus = projectPackageStatus(pkg);
  const enabled = packageEnabledForView(pkg, viewScope);
  const [copiedInstallPath, setCopiedInstallPath] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 680 }}>
      <div className="config-detail-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, minWidth: 0, minHeight: "var(--config-control-height)", flexWrap: "wrap" }}>
        <div className="config-detail-header-info" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 180, flex: 1, flexWrap: "wrap" }}>
          <ConfigScopeTag scope={pkg.scope}>{pkg.scope === "project" ? t("skills.scope.project") : t("skills.scope.global")}</ConfigScopeTag>
          {viewScope === "project" && (
            <span
              style={{
                fontSize: 10,
                padding: "1px 5px",
                borderRadius: 3,
                background: projectStatus === "different"
                  ? "rgba(99,102,241,0.12)"
                  : projectStatus === "project"
                    ? "rgba(245,158,11,0.12)"
                    : "rgba(120,120,120,0.12)",
                color: projectStatus === "different"
                  ? "rgba(99,102,241,0.9)"
                  : projectStatus === "project"
                    ? "#d97706"
                    : "var(--text-dim)",
                flexShrink: 0,
              }}
            >
              {projectStateLabel(projectStatus, t)}
            </span>
          )}
          {!enabled ? (
            <span
              style={{
                fontSize: 10,
                padding: "1px 5px",
                borderRadius: 3,
                background: "rgba(120,120,120,0.12)",
                color: "var(--text-dim)",
              }}
            >
              {t("i18n.disabled")}
            </span>
          ) : pkg.filtered && (
            <span
              style={{
                fontSize: 10,
                padding: "1px 5px",
                borderRadius: 3,
                background: "rgba(245,158,11,0.12)",
                color: "#d97706",
              }}
            >
              {t("i18n.filtered")}
            </span>
          )}
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={pkg.source}
          >
            {pluginDisplayName(pkg)}
          </span>
        </div>

        <div className="config-detail-actions">
          {isGlobalProjectPackage && pkg.projectExplicit !== undefined && (
            <ConfigButton
              onClick={() => onProjectOverride(pkg, null)}
              disabled={busy || reloadBusy}
            >
              {busyKey === `clear_project_override:${key}` ? t("i18n.updating") : t("i18n.syncProjectPlugin")}
            </ConfigButton>
          )}
          {viewScope === "global" && (
            <>
              <ConfigButton
                onClick={() => onAction("update", pkg)}
                disabled={busy || reloadBusy}
              >
                 {busyKey === `update:${key}` ? t("i18n.updating") : t("i18n.update")}
              </ConfigButton>
              <ConfigButton variant="danger"
                onClick={() => onAction("remove", pkg)}
                disabled={busy || reloadBusy}
              >
                 {busyKey === `remove:${key}` ? t("i18n.removing") : t("i18n.remove")}
              </ConfigButton>
            </>
          )}
          <ConfigButton
            onClick={onReloadAllSessions}
            disabled={reloadBusy || busy}
            title={t("i18n.reloadAllSessionsTitle")}
          >
            {reloadBusy ? t("i18n.reloadingAllSessions") : t("i18n.reloadAllSessions")}
          </ConfigButton>
          <ConfigSwitch
            checked={enabled}
            loading={busy || reloadBusy}
            onChange={() => {
              if (isGlobalProjectPackage) {
                onProjectOverride(pkg, enabled ? "disabled" : "enabled");
              } else {
                onAction(enabled ? "disable" : "enable", pkg);
              }
            }}
            label={enabled ? t("i18n.disablePackage") : t("i18n.enablePackage")}
          />
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(96px, 130px) minmax(0, 1fr)",
          gap: "9px 14px",
          fontSize: 12,
          lineHeight: 1.45,
        }}
      >
        {pkg.description && <div style={{ gridColumn: "1 / -1", color: "var(--text-muted)" }}>{pkg.description}</div>}
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.status")}</div>
        <div style={{ color: statusColor(pkg.status), textTransform: "capitalize" }}>{pkg.status}</div>
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.version")}</div>
         <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{versionSummary(pkg, t)}</div>
        {(pkg.packageName || pluginSourceKind(pkg.source) !== "git") && (
          <>
            <div style={{ color: "var(--text-dim)" }}>{t("i18n.package")}</div>
            <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
              {pkg.packageName ? pluginDisplayName(pkg) : t("i18n.unknown")}
            </div>
          </>
        )}
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.resources")}</div>
         <div style={{ color: "var(--text-muted)" }}>{resourceSummary(pkg, t)}</div>
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.installedPath")}</div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: pkg.installedPath ? "var(--text-muted)" : "#ef4444",
            fontFamily: "var(--font-mono)",
            overflowWrap: "anywhere",
          }}
        >
          <span>{pkg.installedPath ? shortenPath(pkg.installedPath) : t("i18n.notFound")}</span>
          {pkg.installedPath && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <button
                type="button"
                onClick={() => {
                  fetch(revealUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: pkg.installedPath }),
                  }).catch(() => {});
                }}
                title={t("files.revealInFinder")}
                aria-label={t("files.revealInFinder")}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 22,
                  height: 22,
                  borderRadius: 4,
                  border: "1px solid var(--border)",
                  background: "var(--bg-panel)",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                }}
              >
                <FolderOpen size={13} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                onClick={() => {
                  void copyText(pkg.installedPath ?? "").then(() => {
                    setCopiedInstallPath(true);
                    window.setTimeout(() => setCopiedInstallPath(false), 1500);
                  }).catch(() => {
                    setCopyFailed(true);
                    window.setTimeout(() => setCopyFailed(false), 1800);
                  });
                }}
                title={copyFailed
                  ? t("files.copyPathFailed")
                  : copiedInstallPath ? t("session.copied") : t("session.copyFile")}
                aria-label={copyFailed
                  ? t("files.copyPathFailed")
                  : copiedInstallPath ? t("session.copied") : t("session.copyFile")}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 22,
                  height: 22,
                  borderRadius: 4,
                  border: "1px solid var(--border)",
                  background: "var(--bg-panel)",
                  color: copyFailed ? "#dc2626" : copiedInstallPath ? "var(--accent, #3b82f6)" : "var(--text-muted)",
                  cursor: "pointer",
                }}
              >
                {copiedInstallPath ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.8} />}
              </button>
            </div>
          )}
        </div>
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.cwd")}</div>
        <div style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          {shortenPath(cwd)}
        </div>
      </div>

      {/* Plugin runtime technical diagnosis */}
      <div
        style={{
          padding: "10px 12px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "var(--bg-panel)",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
              {t("i18n.pluginRuntimeStatusTitle")}
            </span>
            <span
              style={{
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 4,
                background: enabled ? "rgba(34,197,94,0.12)" : "rgba(120,120,120,0.12)",
                color: enabled ? "#15803d" : "var(--text-dim)",
                fontWeight: 600,
              }}
            >
              {enabled ? t("i18n.pluginRuntimeLoaded") : t("i18n.pluginRuntimeDisabled")}
            </span>
          </div>
          <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            {enabled
              ? `Package: loaded · ${pkg.resources.length} resources`
              : "Package: disabled · all resources unloaded"}
          </span>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {enabled
            ? t("i18n.pluginRuntimeLoadedReason")
            : t("i18n.pluginRuntimeDisabledReason")}
        </div>
        <div
          style={{
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            color: "var(--text-dim)",
            background: "var(--bg)",
            padding: "4px 8px",
            borderRadius: 4,
            overflowWrap: "anywhere",
            border: "1px solid var(--border)",
          }}
        >
          {enabled ? `packages["${pkg.source}"].disabled = false` : `packages["${pkg.source}"].disabled = true`}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>
          {t("i18n.resolvedResources")}
        </div>
        <ResourceList pkg={pkg} />
      </div>

      {actionMessage && (
        <div style={{ fontSize: 12, color: "#16a34a" }}>
          {actionMessage}
        </div>
      )}
      {actionError && (
        <div style={{ fontSize: 12, color: "#ef4444", whiteSpace: "pre-wrap" }}>
          {actionError}
        </div>
      )}
    </div>
  );
}

function topLevelExtensionStatusColor(status: PluginTopLevelExtensionInfo["status"]): string {
  return status === "loaded" ? "var(--accent)" : "var(--text-dim)";
}

function BuiltinRuntimeExtensionDetail({
  extension,
}: {
  extension: BuiltinRuntimeExtensionInfo;
}) {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 680 }}>
      <div className="config-detail-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, minWidth: 0, minHeight: "var(--config-control-height)", flexWrap: "wrap" }}>
        <div className="config-detail-header-info" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 180, flex: 1, flexWrap: "wrap" }}>
          <span
            style={{
              minWidth: 0,
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={extension.id}
          >
            {extension.id}
          </span>
          <span
            style={{
              minWidth: 0,
              fontSize: 11,
              color: "var(--text-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={t(extension.labelKey)}
          >
            {t(extension.labelKey)}
          </span>
        </div>
        <div className="config-detail-actions">
          <span
            style={{
              fontSize: 10,
              padding: "2px 6px",
              borderRadius: 3,
              background: "rgba(37,99,235,0.12)",
              color: "var(--accent)",
              flexShrink: 0,
            }}
          >
            {t("i18n.builtinRuntimeExtensionReadOnly")}
          </span>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(96px, 130px) minmax(0, 1fr)",
          gap: "9px 14px",
          fontSize: 12,
          lineHeight: 1.45,
        }}
      >
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.status")}</div>
        <div style={{ color: "var(--accent)" }}>{t("i18n.builtinRuntimeExtensionProvided")}</div>
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.builtinRuntimeExtensionSource")}</div>
        <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{t("i18n.builtinRuntimeExtensionReader")}</div>
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.builtinRuntimeExtensionOrigin")}</div>
        <div style={{ color: "var(--text-muted)" }}>{t(extension.origin === "builtin" ? "i18n.builtinRuntimeExtensionBuiltin" : "i18n.builtinRuntimeExtensionInline")}</div>
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.builtinRuntimeExtensionScope")}</div>
        <div style={{ color: "var(--text-muted)" }}>{t("i18n.builtinRuntimeExtensionSession")}</div>
      </div>

      <div
        style={{
          padding: "10px 12px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "var(--bg-panel)",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
              {t("i18n.pluginRuntimeStatusTitle")}
            </span>
            <span
              style={{
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 4,
                background: "rgba(37,99,235,0.12)",
                color: "var(--accent)",
                fontWeight: 600,
              }}
            >
              {t("i18n.builtinRuntimeExtensionProvided")}
            </span>
          </div>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {t(extension.descriptionKey)}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
          {t("i18n.builtinRuntimeExtensionHint")}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>
          {t("i18n.builtinRuntimeExtensionCapabilities")}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {extension.capabilities.map((capability) => (
            <span
              key={`${capability.kind}:${capability.name}`}
              style={{
                padding: "2px 6px",
                borderRadius: 3,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
              }}
            >
              {t(capability.kind === "tool"
                ? "i18n.builtinRuntimeExtensionTool"
                : capability.kind === "command"
                  ? "i18n.builtinRuntimeExtensionCommand"
                  : "i18n.builtinRuntimeExtensionHook")}: {capability.name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function BuiltinRuntimeExtensionGroup({
  extensions,
  selected,
  collapsed,
  onToggleGroup,
  onSelect,
}: {
  extensions: BuiltinRuntimeExtensionInfo[];
  selected: string | null;
  collapsed: boolean;
  onToggleGroup: () => void;
  onSelect: (extension: BuiltinRuntimeExtensionInfo) => void;
}) {
  const { t } = useI18n();
  return (
    <div style={{ marginBottom: 10 }}>
      <button
        type="button"
        onClick={onToggleGroup}
        aria-expanded={!collapsed}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "9px 10px 8px",
          border: "none",
          borderTop: "1px solid var(--border)",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-panel)",
          color: "var(--text)",
          cursor: "pointer",
          fontSize: 13,
          fontWeight: 600,
          textAlign: "left",
        }}
      >
        <ChevronDown
          size={13}
          style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
          aria-hidden="true"
        />
        <span>{t("i18n.builtinRuntimeExtensions")}</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)", fontWeight: 500 }}>{extensions.length}</span>
      </button>
      {!collapsed && extensions.map((extension, index) => {
        const key = builtinRuntimeExtensionKey(extension);
        const isSelected = selected === key;
        return (
          <div
            key={key}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(extension)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(extension);
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "9px 10px",
              borderRadius: 4,
              borderBottom: index < extensions.length - 1 ? "1px solid var(--border)" : "none",
              cursor: "pointer",
              background: isSelected ? "rgba(37,99,235,0.14)" : "none",
              boxShadow: isSelected ? "inset 3px 0 0 #2563eb" : "none",
              transition: "background 0.12s, box-shadow 0.12s",
            }}
            onMouseEnter={(event) => {
              if (!isSelected) event.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(event) => {
              if (!isSelected) event.currentTarget.style.background = "none";
            }}
          >
            <span
              aria-hidden="true"
              style={{
                flexShrink: 0,
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "var(--accent)",
              }}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: isSelected ? 600 : 400,
                  color: isSelected ? "var(--accent)" : "var(--text)",
                  fontFamily: "var(--font-mono)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={extension.id}
              >
                {extension.id}
              </div>
              <div style={{ fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>
                {t(extension.labelKey)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TopLevelExtensionDetail({
  extension,
  cwd,
  busyKey,
  actionError,
  actionMessage,
  viewScope,
  onToggle,
  onClearProjectOverride,
  onReloadAllSessions,
  onOpenFile,
}: {
  extension: PluginTopLevelExtensionInfo;
  cwd: string;
  busyKey: string | null;
  actionError: string | null;
  actionMessage: string | null;
  viewScope: PluginScope;
  onToggle: (extension: PluginTopLevelExtensionInfo, enabled: boolean) => void;
  onClearProjectOverride: (extension: PluginTopLevelExtensionInfo) => void;
  onReloadAllSessions: () => void;
  onOpenFile?: (filePath: string) => void;
}) {
  const { t } = useI18n();
  const key = topLevelExtensionKey(extension);
  const busy = busyKey?.endsWith(key) ?? false;
  const reloadBusy = busyKey === "reload";
  const isGlobalProjectExtension = viewScope === "project" && extension.scope === "global";
  const projectStatus = topLevelExtensionProjectStatus(extension);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 680 }}>
      <div className="config-detail-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, minWidth: 0, minHeight: "var(--config-control-height)", flexWrap: "wrap" }}>
        <div className="config-detail-header-info" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 180, flex: 1, flexWrap: "wrap" }}>
          <ConfigScopeTag scope={extension.scope}>{extension.scope === "project" ? t("skills.scope.project") : t("skills.scope.global")}</ConfigScopeTag>
          {viewScope === "project" && projectStatus && (
            <span
              style={{
                fontSize: 10,
                padding: "1px 5px",
                borderRadius: 3,
                background: projectStatus === "different"
                  ? "rgba(99,102,241,0.12)"
                  : projectStatus === "project"
                    ? "rgba(245,158,11,0.12)"
                    : "rgba(120,120,120,0.12)",
                color: projectStatus === "different"
                  ? "rgba(99,102,241,0.9)"
                  : projectStatus === "project"
                    ? "#d97706"
                    : "var(--text-dim)",
                flexShrink: 0,
              }}
            >
              {projectStatus === "project"
                ? t("i18n.projectFilterProject")
                : projectStatus === "matching"
                  ? t("i18n.projectPluginStateMatching")
                  : t("i18n.projectPluginStateDifferent")}
            </span>
          )}
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={extension.path}
          >
            {extension.name}
          </span>
        </div>

        <div className="config-detail-actions">
          {isGlobalProjectExtension && extension.projectOverride !== undefined && (
            <ConfigButton
              onClick={() => onClearProjectOverride(extension)}
              disabled={busy || reloadBusy}
            >
              {busyKey === `clear_top_level_extension:${key}` ? t("i18n.updating") : t("i18n.restoreGlobal")}
            </ConfigButton>
          )}
          <ConfigButton
            onClick={onReloadAllSessions}
            disabled={reloadBusy || busy}
            title={t("i18n.reloadAllSessionsTitle")}
          >
            {reloadBusy ? t("i18n.reloadingAllSessions") : t("i18n.reloadAllSessions")}
          </ConfigButton>
          <ConfigSwitch
            checked={extension.enabled}
            loading={busy || reloadBusy}
            onChange={() => onToggle(extension, !extension.enabled)}
            label={extension.enabled ? t("i18n.disableExtension") : t("i18n.enableExtension")}
          />
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(96px, 130px) minmax(0, 1fr)",
          gap: "9px 14px",
          fontSize: 12,
          lineHeight: 1.45,
        }}
      >
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.status")}</div>
        <div style={{ color: topLevelExtensionStatusColor(extension.status), textTransform: "capitalize" }}>
          {extension.enabled ? t("i18n.topLevelExtensionLoaded") : t("i18n.topLevelExtensionDisabled")}
        </div>
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.topLevelExtensionSource")}</div>
        <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{extension.source}</div>
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.installedPath")}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          <span>{shortenPath(extension.path)}</span>
          {onOpenFile && (
            <button
              type="button"
              onClick={() => onOpenFile(extension.path)}
              title={t("settings.openInReaderTitle") || "Open in Reader"}
              aria-label={t("settings.openInReaderTitle") || "Open in Reader"}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 22,
                height: 22,
                borderRadius: 4,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--accent, #3b82f6)",
                cursor: "pointer",
              }}
            >
              <ExternalLink size={13} strokeWidth={2} />
            </button>
          )}
        </div>
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.resources")}</div>
        <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{extension.relativePath}</div>
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.cwd")}</div>
        <div style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          {shortenPath(cwd)}
        </div>
      </div>

      <div
        style={{
          padding: "10px 12px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "var(--bg-panel)",
          fontSize: 11,
          color: "var(--text-muted)",
          lineHeight: 1.5,
        }}
      >
        {t("i18n.topLevelExtensionHint")}
      </div>

      {actionMessage && <div style={{ fontSize: 12, color: "#16a34a" }}>{actionMessage}</div>}
      {actionError && <div style={{ fontSize: 12, color: "#ef4444", whiteSpace: "pre-wrap" }}>{actionError}</div>}
    </div>
  );
}

function TopLevelExtensionGroup({
  extensions,
  selected,
  collapsed,
  onToggleGroup,
  onSelect,
}: {
  extensions: PluginTopLevelExtensionInfo[];
  selected: string | null;
  collapsed: boolean;
  onToggleGroup: () => void;
  onSelect: (extension: PluginTopLevelExtensionInfo) => void;
}) {
  const { t } = useI18n();
  return (
    <div style={{ marginBottom: 10 }}>
      <button
        type="button"
        onClick={onToggleGroup}
        aria-expanded={!collapsed}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "9px 10px 8px",
          border: "none",
          borderTop: "1px solid var(--border)",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-panel)",
          color: "var(--text)",
          cursor: "pointer",
          fontSize: 13,
          fontWeight: 600,
          textAlign: "left",
        }}
      >
        <ChevronDown
          size={13}
          style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
          aria-hidden="true"
        />
        <span>{t("i18n.topLevelExtensions")}</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)", fontWeight: 500 }}>{extensions.length}</span>
      </button>
      {!collapsed && extensions.map((extension, index) => {
        const key = topLevelExtensionKey(extension);
        const isSelected = selected === key;
        return (
          <div
            key={key}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(extension)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(extension);
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "9px 10px",
              borderRadius: 4,
              borderBottom: index < extensions.length - 1 ? "1px solid var(--border)" : "none",
              cursor: "pointer",
              background: isSelected ? "rgba(37,99,235,0.14)" : "none",
              boxShadow: isSelected ? "inset 3px 0 0 #2563eb" : "none",
              transition: "background 0.12s, box-shadow 0.12s",
            }}
            onMouseEnter={(event) => {
              if (!isSelected) event.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(event) => {
              if (!isSelected) event.currentTarget.style.background = "none";
            }}
          >
            <span
              style={{
                flexShrink: 0,
                width: 7,
                height: 7,
                borderRadius: 7,
                background: topLevelExtensionStatusColor(extension.status),
              }}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: isSelected ? 600 : 400,
                  color: isSelected ? "var(--accent)" : extension.enabled ? "var(--text)" : "var(--text-dim)",
                  fontFamily: "var(--font-mono)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={extension.path}
              >
                {extension.name}
              </div>
              <div style={{ fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>
                {extension.relativePath}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function PluginsConfig({
  cwd,
  remotePeer,
  revision = 0,
  onChanged,
  onClose,
  onReloaded,
  embedded = false,
  onOpenFile,
  trust,
}: {
  cwd: string;
  trust?: ProjectTrustStatus | null;
  remotePeer?: string;
  revision?: number;
  onChanged?: () => void;
  onClose: () => void;
  onReloaded?: () => void;
  embedded?: boolean;
  onOpenFile?: (filePath: string) => void;
}) {
  const remotePeerRef = useRef(remotePeer);
  remotePeerRef.current = remotePeer;
  const api = (path: string) => apiFor(remotePeerRef.current, path);
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const navigation = useSettingsDetailNavigation();
  const sidebarResizer = useConfigSidebarResize();
  useEffect(() => {
    notifyEmbeddedModalState(true);
    return () => notifyEmbeddedModalState(false);
  }, []);
  const [data, setData] = useState<PluginsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [installSource, setInstallSource] = useState("");
  const [viewScope, setViewScope] = useState<PluginScope>("global");
  const trustKey = projectTrustReloadKey(trust);
  const ownerRef = useRef<PluginOwnerIdentity>({ cwd, peer: remotePeer, viewScope, generation: 0, revision, trustKey });
  const loadSeqRef = useRef(0);
  const mutationSeqRef = useRef(0);
  if (ownerRef.current.cwd !== cwd || ownerRef.current.peer !== remotePeer || ownerRef.current.viewScope !== viewScope || ownerRef.current.revision !== revision || ownerRef.current.trustKey !== trustKey) {
    ownerRef.current = {
      cwd,
      peer: remotePeer,
      viewScope,
      revision,
      trustKey,
      generation: ownerRef.current.generation + 1,
    };
    loadSeqRef.current += 1;
    mutationSeqRef.current += 1;
  }
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [showEnabled, setShowEnabled] = useState(true);
  const [showNotEnabled, setShowNotEnabled] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState<ProjectPackageFilter>("different");
  const [collapsedSources, setCollapsedSources] = useState<Record<PluginSourceKind, boolean>>({
    local: false,
    npm: false,
    git: false,
  });
  const [topLevelExtensionsCollapsed, setTopLevelExtensionsCollapsed] = useState(false);
  const [builtinRuntimeExtensionsCollapsed, setBuiltinRuntimeExtensionsCollapsed] = useState(false);

  const packages = useMemo(
    () => [...(data?.packages ?? [])]
      .filter((pkg) => viewScope === "project" || pkg.scope === "global")
      .sort(comparePluginPackages),
    [data?.packages, viewScope],
  );
  const topLevelExtensions = useMemo(
    () => [...(data?.topLevelExtensions ?? [])]
      .filter((extension) => viewScope === "project" || extension.scope === "global")
      .sort((left, right) => left.path.localeCompare(right.path)),
    [data?.topLevelExtensions, viewScope],
  );
  const builtinRuntimeExtensions = useMemo(() => [...BUILTIN_RUNTIME_EXTENSIONS], []);
  const visibleBuiltinRuntimeExtensions = useMemo(
    () => filterBuiltinRuntimeExtensions(builtinRuntimeExtensions, { searchQuery, showEnabled, viewScope }, (extension) => t(extension.labelKey)),
    [builtinRuntimeExtensions, searchQuery, showEnabled, viewScope, t],
  );
  const filterablePackages = useMemo(
    () => filterPackagesForProjectStatusCounts(packages, {
      searchQuery,
      showEnabled,
      showNotEnabled,
    }),
    [packages, searchQuery, showEnabled, showNotEnabled],
  );
  const filterableTopLevelExtensions = useMemo(
    () => filterTopLevelExtensions(topLevelExtensions, {
      searchQuery,
      showEnabled,
      showNotEnabled,
    }),
    [searchQuery, showEnabled, showNotEnabled, topLevelExtensions],
  );
  const visiblePackages = useMemo(
    () => viewScope !== "project"
      ? filterablePackages
      : filterablePackages.filter((pkg) => isProjectPackageVisible(pkg, projectFilter)),
    [filterablePackages, projectFilter, viewScope],
  );
  const visibleTopLevelExtensions = useMemo(
    () => viewScope !== "project"
      ? filterableTopLevelExtensions
      : filterableTopLevelExtensions.filter((extension) => isProjectTopLevelExtensionVisible(extension, projectFilter)),
    [filterableTopLevelExtensions, projectFilter, viewScope],
  );
  const selectedBuiltinRuntimeExtension = visibleBuiltinRuntimeExtensions.find((extension) => builtinRuntimeExtensionKey(extension) === selected) ?? null;
  const selectedPackage = visiblePackages.find((pkg) => packageKey(pkg) === selected) ?? null;
  const selectedTopLevelExtension = visibleTopLevelExtensions.find((extension) => topLevelExtensionKey(extension) === selected) ?? null;
  const projectResourcesLoaded = data?.projectResourcesLoaded ?? true;
  const projectFilterCounts = useMemo(() => {
    const packageCounts = projectPackageFilterCounts(filterablePackages);
    const extensionCounts = projectTopLevelExtensionFilterCounts(filterableTopLevelExtensions);
    return {
      different: packageCounts.different + extensionCounts.different,
      all: packageCounts.all + extensionCounts.all,
      matching: packageCounts.matching + extensionCounts.matching,
      project: packageCounts.project + extensionCounts.project,
    };
  }, [filterablePackages, filterableTopLevelExtensions]);

  const groupedPackages = useMemo(() => {
    return PLUGIN_SOURCE_KINDS
      .map((sourceKind) => ({
        sourceKind,
        packages: visiblePackages.filter((pkg) => pluginSourceKind(pkg.source) === sourceKind),
      }))
      .filter((group) => group.packages.length > 0);
  }, [visiblePackages]);

  useEffect(() => {
    setSelected((current) => {
      if (current && (
        visibleBuiltinRuntimeExtensions.some((extension) => builtinRuntimeExtensionKey(extension) === current)
        || visiblePackages.some((pkg) => packageKey(pkg) === current)
        || visibleTopLevelExtensions.some((extension) => topLevelExtensionKey(extension) === current)
      )) return current;
      return firstRenderedPluginKey(visiblePackages, visibleBuiltinRuntimeExtensions, visibleTopLevelExtensions);
    });
  }, [visibleBuiltinRuntimeExtensions, visiblePackages, visibleTopLevelExtensions]);

  const loadPlugins = useCallback(async () => {
    const owner = ownerRef.current;
    const loadSeq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        apiFor(owner.peer, `plugins?cwd=${encodeURIComponent(owner.cwd)}&scope=${owner.viewScope}`),
      );
      const next = (await res.json()) as PluginsResponse & { error?: string };
      if (!isPluginOwnerCurrent(owner, ownerRef.current) || loadSeq !== loadSeqRef.current) return;
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      setAddMode((current) => owner.viewScope === "global"
        && ((next.packages.length === 0
          && (next.topLevelExtensions ?? []).length === 0
          && builtinRuntimeExtensions.length === 0) || current));
    } catch (err) {
      if (isPluginOwnerCurrent(owner, ownerRef.current) && loadSeq === loadSeqRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (isPluginOwnerCurrent(owner, ownerRef.current) && loadSeq === loadSeqRef.current) setLoading(false);
    }
  }, [builtinRuntimeExtensions]);

  useEffect(() => {
    setSelected(null);
    setActionError(null);
    setActionMessage(null);
    setProjectFilter(viewScope === "project" ? "different" : "all");
    setBusyKey(null);
  }, [cwd, remotePeer, revision, trustKey, viewScope]);

  usePluginLoadEffect(loadPlugins, remotePeer, revision, cwd, viewScope);

  const loadedTrustKeyRef = useRef(trustKey);
  useEffect(() => {
    if (loadedTrustKeyRef.current === trustKey) return;
    loadedTrustKeyRef.current = trustKey;
    void loadPlugins();
  }, [loadPlugins, trustKey]);

  const runAction = useCallback(async (
    action: PluginAction | ProjectOverrideAction,
    pkg: PluginPackageInfo,
    overrideState?: PluginOverrideState,
  ) => {
    const owner = ownerRef.current;
    const mutationSeq = ++mutationSeqRef.current;
    const key = packageKey(pkg);
    const isOverrideAction = action === "set_project_override" || action === "clear_project_override";
    setBusyKey(`${action}:${key}`);
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await fetch(apiFor(owner.peer, "plugins"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          source: pkg.source,
          scope: isOverrideAction ? "project" : pkg.scope,
          enabled: action === "set_project_override" ? overrideState === "enabled" : undefined,
          viewScope: owner.viewScope,
          cwd: owner.cwd,
        }),
      });
      const next = (await res.json()) as PluginsResponse & { error?: string };
      if (!isPluginOwnerCurrent(owner, ownerRef.current) || mutationSeq !== mutationSeqRef.current) return;
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      onChanged?.();
      if (action === "remove") {
        setSelected(firstRenderedPluginKey(next.packages, owner.viewScope === "global" ? builtinRuntimeExtensions : [], next.topLevelExtensions ?? []));
        if (next.packages.length === 0) setAddMode(true);
        setActionMessage("Package removed.");
      } else if (action === "set_project_override" || action === "clear_project_override") {
        setActionMessage(action === "set_project_override" ? t("i18n.projectPluginStateSaved") : t("i18n.syncProjectPluginDone"));
      } else {
        const messages: Record<Exclude<PluginAction, "remove">, string> = {
          install: "Package installed.",
          update: "Package updated.",
          disable: "Package disabled.",
          enable: "Package enabled.",
        };
        setActionMessage(messages[action]);
      }
    } catch (err) {
      if (isPluginOwnerCurrent(owner, ownerRef.current) && mutationSeq === mutationSeqRef.current) {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (isPluginOwnerCurrent(owner, ownerRef.current) && mutationSeq === mutationSeqRef.current) setBusyKey(null);
    }
  }, [builtinRuntimeExtensions, onChanged, t]);

  const runProjectOverride = useCallback((pkg: PluginPackageInfo, state: PluginOverrideState | null) => {
    void runAction(state ? "set_project_override" : "clear_project_override", pkg, state ?? undefined);
  }, [runAction]);

  const runTopLevelExtensionAction = useCallback(async (
    action: TopLevelExtensionAction,
    extension: PluginTopLevelExtensionInfo,
    enabled?: boolean,
  ) => {
    const owner = ownerRef.current;
    const mutationSeq = ++mutationSeqRef.current;
    const key = topLevelExtensionKey(extension);
    setBusyKey(`${action}:${key}`);
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await fetch(apiFor(owner.peer, "plugins"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          path: extension.path,
          scope: action === "clear_top_level_extension" ? "project" : owner.viewScope,
          enabled,
          viewScope: owner.viewScope,
          cwd: owner.cwd,
        }),
      });
      const next = (await res.json()) as PluginsResponse & { error?: string };
      if (!isPluginOwnerCurrent(owner, ownerRef.current) || mutationSeq !== mutationSeqRef.current) return;
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      onChanged?.();
      setActionMessage(action === "clear_top_level_extension"
        ? t("i18n.topLevelExtensionRestored")
        : t("i18n.topLevelExtensionSaved"));
    } catch (err) {
      if (isPluginOwnerCurrent(owner, ownerRef.current) && mutationSeq === mutationSeqRef.current) {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (isPluginOwnerCurrent(owner, ownerRef.current) && mutationSeq === mutationSeqRef.current) setBusyKey(null);
    }
  }, [onChanged, t]);

  const installPlugin = useCallback(async () => {
    const owner = ownerRef.current;
    const mutationSeq = ++mutationSeqRef.current;
    const source = normalizePluginSourceInput(installSource).trim();
    if (!source) return;
    setInstallSource(source);
    const key = `${owner.viewScope}\0${source}`;
    setBusyKey(`install:${key}`);
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await fetch(apiFor(owner.peer, "plugins"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "install", source, scope: owner.viewScope, viewScope: owner.viewScope, cwd: owner.cwd }),
      });
      const next = (await res.json()) as PluginsResponse & { error?: string };
      if (!isPluginOwnerCurrent(owner, ownerRef.current) || mutationSeq !== mutationSeqRef.current) return;
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      onChanged?.();
      setShowEnabled(true);
      const installed = findInstalledPackage(next.packages, source, owner.viewScope);
      setSelected(installed ? packageKey(installed) : key);
      setAddMode(false);
      setInstallSource("");
      setActionMessage("Package installed.");
    } catch (err) {
      if (isPluginOwnerCurrent(owner, ownerRef.current) && mutationSeq === mutationSeqRef.current) {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (isPluginOwnerCurrent(owner, ownerRef.current) && mutationSeq === mutationSeqRef.current) setBusyKey(null);
    }
  }, [installSource, onChanged]);

  const reloadAllSessions = useCallback(async () => {
    const owner = ownerRef.current;
    const mutationSeq = ++mutationSeqRef.current;
    setBusyKey("reload");
    setActionError(null);
    setActionMessage(null);
    try {
      const result = await reloadAllAgentSessions(owner.peer);
      if (!isPluginOwnerCurrent(owner, ownerRef.current) || mutationSeq !== mutationSeqRef.current) return;
      onReloaded?.();
      await loadPlugins();
      if (!isPluginOwnerCurrent(owner, ownerRef.current) || mutationSeq !== mutationSeqRef.current) return;
      setActionMessage(result.liveSessions === 0
        ? t("i18n.noLiveSessions")
        : t("i18n.reloadAllSessionsResult", {
          reloaded: result.reloadedSessions,
          total: result.liveSessions,
        }));
      if (result.busySessionIds.length || result.failedSessionIds.length) {
        setActionError(t("i18n.reloadAllSessionsPartial", {
          busy: result.busySessionIds.length,
          failed: result.failedSessionIds.length,
        }));
      }
    } catch (err) {
      if (isPluginOwnerCurrent(owner, ownerRef.current) && mutationSeq === mutationSeqRef.current) {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (isPluginOwnerCurrent(owner, ownerRef.current) && mutationSeq === mutationSeqRef.current) setBusyKey(null);
    }
  }, [loadPlugins, onReloaded, t]);

  const addBusy = busyKey?.startsWith("install:") ?? false;

  const plugContent = (
      <div
        style={{
          width: isMobile ? "calc(100vw - 16px)" : (embedded ? "100%" : 860),
          maxWidth: embedded ? "100%" : "calc(100vw - 16px)",
          height: isMobile ? "calc(100dvh - 16px)" : (embedded ? "100%" : "76vh"),
          maxHeight: embedded ? "100%" : "calc(100dvh - 16px)",
          background: "var(--bg)",
          border: embedded ? "none" : "1px solid var(--border)",
          borderRadius: embedded ? 0 : 8,
          display: "flex",
          flexDirection: "column",
          boxShadow: embedded ? "none" : "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
          flex: embedded ? 1 : undefined,
        }}
      >
        {!embedded && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 18px",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
                {t("common.plugins")}
              </span>
              <code
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {pluginSettingsPath(viewScope, cwd)}
              </code>
            </div>
            <button
              onClick={onClose}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 20,
                lineHeight: 1,
                padding: "2px 6px",
              }}
            >
              ×
            </button>
          </div>
        )}

        <div className="config-resource-toolbar">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <SegmentedScope
              value={viewScope}
              projectResourcesLoaded={projectResourcesLoaded}
              onChange={(scope) => {
                setViewScope(scope);
                setAddMode(false);
                navigation?.closeDetail();
              }}
            />
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {viewScope === "global"
                ? t("i18n.pluginConfigGlobalHint")
                : t("i18n.pluginConfigProjectHint")}
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: "1 1 auto", justifyContent: "flex-end" }}>
            {!isMobile && (
              <code
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                  flex: "0 1 auto",
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={pluginSettingsPath(viewScope, cwd)}
              >
                {pluginSettingsPath(viewScope, cwd)}
              </code>
            )}
            {onOpenFile && (
              <button
                type="button"
                onClick={() => onOpenFile(pluginSettingsPath(viewScope, cwd))}
                title={t("settings.openInReaderTitle")}
                aria-label={t("settings.openInReaderTitle")}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 22,
                  height: 22,
                  padding: 0,
                  boxSizing: "border-box",
                  flex: "0 0 22px",
                  borderRadius: 4,
                  border: "1px solid var(--border)",
                  background: "var(--bg-panel)",
                  color: "var(--accent, #3b82f6)",
                  cursor: "pointer",
                }}
              >
                <ExternalLink size={13} strokeWidth={2} />
              </button>
            )}
          </div>
        </div>

        {viewScope === "project" && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "7px 18px",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontSize: 11, color: "var(--text-muted)", marginRight: 2 }}>
              {t("i18n.projectConfigSummary")}
            </span>
            <FilterButton
              active={projectFilter === "different"}
              label={`${t("i18n.projectPluginFilterDifferent")} ${projectFilterCounts.different}`}
              onToggle={() => setProjectFilter("different")}
            />
            <FilterButton
              active={projectFilter === "matching"}
              label={`${t("i18n.projectPluginFilterMatching")} ${projectFilterCounts.matching}`}
              onToggle={() => setProjectFilter("matching")}
            />
            <FilterButton
              active={projectFilter === "project"}
              label={`${t("i18n.projectFilterProject")} ${projectFilterCounts.project}`}
              onToggle={() => setProjectFilter("project")}
            />
          </div>
        )}

        {!projectResourcesLoaded && (
          <div
            role="status"
            style={{
              padding: "8px 18px",
              borderBottom: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              fontSize: 12,
            }}
          >
            {t("trust.pluginsNotLoaded")}
          </div>
        )}

        {(data?.stalePolicies?.length ?? 0) > 0 && (
          <div
            role="status"
            style={{
              padding: "8px 18px",
              borderBottom: "1px solid var(--border)",
              background: "rgba(245,158,11,0.08)",
              color: "var(--text-muted)",
              fontSize: 11,
              lineHeight: 1.45,
            }}
          >
            <div style={{ color: "#b45309", fontWeight: 600 }}>
              {t("i18n.pluginStalePoliciesTitle", { count: data?.stalePolicies?.length ?? 0 })}
            </div>
            <div>{t("i18n.pluginStalePoliciesHint")}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 4 }}>
              {data?.stalePolicies?.map((policy) => (
                <div key={`${policy.scope}:${policy.policyKey}`} style={{ fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
                  [{policy.scope}/{policy.availability}] {policy.policyKey}
                  {policy.staleReason ? ` · ${policy.staleReason}` : ""}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="settings-phone-split" style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", overflow: "hidden" }}>
          <div
            ref={sidebarResizer.panelRef}
            className="config-sidebar config-resource-sidebar settings-phone-list"
            style={{
              width: isMobile ? "100%" : "var(--config-sidebar-width, 240px)",
              maxHeight: isMobile ? "40vh" : undefined,
              borderRight: isMobile ? "none" : "1px solid var(--border)",
              borderBottom: isMobile ? "1px solid var(--border)" : "none",
              display: "flex",
              flexDirection: "column",
              flexShrink: 0,
              background: "var(--bg-panel)",
            }}
          >
            <div
              className="config-sidebar-filter"
              style={{
                padding: "8px 8px",
                borderBottom: "1px solid var(--border)",
                flexShrink: 0,
              }}
            >
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => {
                  const value = event.target.value;
                  setSearchQuery(value);
                  if (viewScope === "project" && value.trim()) setProjectFilter("all");
                }}
                placeholder={t("i18n.filterResources")}
                aria-label={t("i18n.filterResources")}
                style={{
                  boxSizing: "border-box",
                  width: "100%",
                  minHeight: 30,
                  marginBottom: 7,
                  padding: "5px 8px",
                  border: "1px solid var(--border)",
                  borderRadius: 5,
                  background: "var(--bg)",
                  color: "var(--text)",
                  fontSize: 12,
                  outline: "none",
                }}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <FilterButton
                  active={showEnabled}
                  label={t("i18n.filterEnabled")}
                  onToggle={() => setShowEnabled((current) => !current)}
                />
                <FilterButton
                  active={showNotEnabled}
                  label={t("i18n.filterNotEnabled")}
                  onToggle={() => setShowNotEnabled((current) => !current)}
                />
              </div>
            </div>
            <div className="config-sidebar-list config-resource-list" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {loading ? (
                <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>
                  Loading...
                </div>
              ) : error ? (
                <div style={{ padding: "10px 8px", fontSize: 11, color: "#ef4444" }}>
                  {error}
                </div>
              ) : visiblePackages.length === 0 && visibleTopLevelExtensions.length === 0 && visibleBuiltinRuntimeExtensions.length === 0 ? (
                <div style={{ padding: "10px 8px", fontSize: 11, color: "var(--text-dim)" }}>
                  {packages.length === 0 && topLevelExtensions.length === 0 && builtinRuntimeExtensions.length === 0
                    ? t("i18n.noPlugins")
                    : viewScope === "project" && projectFilter === "different" && projectFilterCounts.different === 0 && showEnabled ? (
                    <>
                      <div>{t("i18n.noProjectChanges")}</div>
                      <div style={{ marginTop: 8 }}>
                        <FilterButton
                          active={false}
                          label={t("i18n.showMatchingGlobal")}
                          onToggle={() => setProjectFilter("all")}
                        />
                      </div>
                    </>
                  ) : t("i18n.noVisiblePlugins")}
                </div>
              ) : (
                <>
                  {groupedPackages.map((group) => {
                  const collapsed = collapsedSources[group.sourceKind];
                  return (
                    <div key={group.sourceKind} className="config-sidebar-group config-resource-group" style={{ marginBottom: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button
                        type="button"
                        onClick={() => setCollapsedSources((current) => ({
                          ...current,
                          [group.sourceKind]: !current[group.sourceKind],
                        }))}
                        aria-expanded={!collapsed}
                        className="config-resource-group-toggle"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          flex: 1,
                          minWidth: 0,
                          border: "none",
                          borderTop: "1px solid var(--border)",
                          borderBottom: "1px solid var(--border)",
                          background: "var(--bg-panel)",
                          color: "var(--text)",
                          cursor: "pointer",
                          fontWeight: 600,
                          textTransform: "none",
                          textAlign: "left",
                        }}
                      >
                        <ChevronDown
                          size={13}
                          style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
                          aria-hidden="true"
                        />
                        <span>{pluginSourceLabel(group.sourceKind, t)}</span>
                        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)", fontWeight: 500 }}>{group.packages.length}</span>
                      </button>
                      </div>
                      {!collapsed && group.packages.map((pkg, packageIndex) => {
                        const key = packageKey(pkg);
                        const isSelected = !addMode && selected === key;
                        return (
                          <div
                            key={key}
                            role="button"
                            tabIndex={0}
                            onKeyDown={activateConfigRowOnKeyDown}
                            onClick={() => {
                              setSelected(key);
                              setAddMode(false);
                              setActionError(null);
                              setActionMessage(null);
                              navigation?.openDetail(pluginDisplayName(pkg));
                            }}
                            className="config-sidebar-item config-resource-item"
                            style={{
                              gap: 7,
                              borderBottom: packageIndex < group.packages.length - 1 ? "1px solid var(--border)" : "none",
                              background: isSelected ? "rgba(37,99,235,0.14)" : "none",
                              boxShadow: isSelected ? "inset 3px 0 0 #2563eb" : "none",
                              transition: "background 0.12s, box-shadow 0.12s",
                            }}
                            onMouseEnter={(e) => {
                              if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)";
                            }}
                            onMouseLeave={(e) => {
                              if (!isSelected) e.currentTarget.style.background = "none";
                            }}
                          >
                            <span
                              style={{
                                flexShrink: 0,
                                width: 7,
                                height: 7,
                                borderRadius: "50%",
                                background: statusColor(pkg.status),
                              }}
                            />
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div
                                style={{
                                  fontSize: 12,
                                  fontWeight: isSelected ? 600 : 400,
                                  color: isSelected ? "var(--accent)" : "var(--text)",
                                  fontFamily: "var(--font-mono)",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                                title={pkg.source}
                              >
                                {pluginDisplayName(pkg)}
                              </div>
                              <div
                                style={{
                                  fontSize: 10,
                                  color: "var(--text-dim)",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                  marginTop: 2,
                                }}
                              >
                                {resourceSummary(pkg, t)}
                              </div>
                              {(pkg.version || pkg.configuredVersion) && (
                                <div
                                  style={{
                                    fontSize: 10,
                                    color: "var(--text-dim)",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                    marginTop: 2,
                                  }}
                                >
                                   {versionSummary(pkg, t)}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                  })}
                  {visibleBuiltinRuntimeExtensions.length > 0 && (
                    <BuiltinRuntimeExtensionGroup
                      extensions={visibleBuiltinRuntimeExtensions}
                      selected={selected}
                      collapsed={builtinRuntimeExtensionsCollapsed}
                      onToggleGroup={() => setBuiltinRuntimeExtensionsCollapsed((current) => !current)}
                      onSelect={(extension) => {
                        setSelected(builtinRuntimeExtensionKey(extension));
                        setAddMode(false);
                        setActionError(null);
                        setActionMessage(null);
                        navigation?.openDetail(extension.id);
                      }}
                    />
                  )}
                  {visibleTopLevelExtensions.length > 0 && (
                    <TopLevelExtensionGroup
                      extensions={visibleTopLevelExtensions}
                      selected={selected}
                      collapsed={topLevelExtensionsCollapsed}
                      onToggleGroup={() => setTopLevelExtensionsCollapsed((current) => !current)}
                      onSelect={(extension) => {
                        setSelected(topLevelExtensionKey(extension));
                        setAddMode(false);
                        setActionError(null);
                        setActionMessage(null);
                        navigation?.openDetail(extension.name);
                      }}
                    />
                  )}
                </>
              )}
            </div>
            <div style={{ padding: "8px 6px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
              {viewScope === "global" && (
                <button
                  type="button"
                  onClick={() => {
                    setAddMode(true);
                    setActionError(null);
                    setActionMessage(null);
                    navigation?.openDetail(t("i18n.addPlugin"));
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "7px 8px",
                    borderRadius: 5,
                    border: "none",
                    width: "100%",
                    cursor: "pointer",
                    background: addMode ? "var(--bg-selected)" : "none",
                    color: addMode ? "var(--accent)" : "var(--text-dim)",
                    fontSize: 12,
                  }}
                  onMouseEnter={(e) => {
                    if (!addMode) e.currentTarget.style.background = "var(--bg-hover)";
                  }}
                  onMouseLeave={(e) => {
                    if (!addMode) e.currentTarget.style.background = "none";
                  }}
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                   {t("i18n.addPlugin")}
                </button>
              )}
            </div>
          </div>

          {!isMobile && (
            <div
              {...sidebarResizer.separatorProps}
              className={`panel-resize-handle config-sidebar-resize-handle${sidebarResizer.isResizing ? " is-resizing" : ""}`}
              title={`${t("layout.resizeSidebar")}: ${t("layout.resizeHint")}`}
            />
          )}

          <div className="settings-phone-detail" style={{ flex: 1, overflowY: "auto", padding: "var(--config-detail-padding-top) 20px 20px" }}>
            {addMode && viewScope === "global" ? (
              <AddPluginPanel
                cwd={cwd}
                source={installSource}
                scope={viewScope}
                busy={addBusy}
                actionError={actionError}
                onSourceChange={setInstallSource}
                onInstall={installPlugin}
              />
            ) : loading ? null : selectedBuiltinRuntimeExtension ? (
              <BuiltinRuntimeExtensionDetail
                key={builtinRuntimeExtensionKey(selectedBuiltinRuntimeExtension)}
                extension={selectedBuiltinRuntimeExtension}
              />
            ) : selectedPackage ? (
              <PackageDetail
                key={packageKey(selectedPackage)}
                pkg={selectedPackage}
                cwd={cwd}
                busyKey={busyKey}
                actionError={actionError}
                actionMessage={actionMessage}
                viewScope={viewScope}
                onAction={runAction}
                onProjectOverride={runProjectOverride}
                onReloadAllSessions={reloadAllSessions}
                revealUrl={api(`files/reveal`)}
                onOpenFile={onOpenFile}
              />
            ) : selectedTopLevelExtension ? (
              <TopLevelExtensionDetail
                key={topLevelExtensionKey(selectedTopLevelExtension)}
                extension={selectedTopLevelExtension}
                cwd={cwd}
                busyKey={busyKey}
                actionError={actionError}
                actionMessage={actionMessage}
                viewScope={viewScope}
                onToggle={(extension, enabled) => {
                  void runTopLevelExtensionAction("set_top_level_extension", extension, enabled);
                }}
                onClearProjectOverride={(extension) => {
                  void runTopLevelExtensionAction("clear_top_level_extension", extension);
                }}
                onReloadAllSessions={reloadAllSessions}
                onOpenFile={onOpenFile}
              />
            ) : (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-dim)",
                  fontSize: 13,
                }}
              >
                {t("i18n.selectPackage")}
              </div>
            )}
          </div>
        </div>

        <ConfigFooter
          status={<>
            {data?.diagnostics.length ? (
              <span
                title={data.diagnostics.map((d) => `${d.type}: ${d.source ? `${d.source}: ` : ""}${d.message}`).join("\n")}
                style={{ color: data.diagnostics.some((d) => d.type === "error") ? "#ef4444" : "#d97706" }}
              >
                {data.diagnostics.length} diagnostic{data.diagnostics.length === 1 ? "" : "s"}
              </span>
            ) : (
              <span>
                {data ? `${data.totals.extensions} ext · ${data.totals.skills} skills · ${data.totals.prompts} prompts · ${data.totals.themes} themes${data.topLevelExtensions?.length ? ` · ${t("i18n.resourceCount", { count: data.topLevelExtensions.length, label: t("i18n.topLevelExtensionShort") })}` : ""}` : ""}
              </span>
            )}
          </>}
        >
          <ConfigPanelRefreshButton
            disabled={loading || busyKey !== null}
            onRefresh={() => void loadPlugins()}
          />
          <ConfigButton onClick={onClose}>{t("i18n.close")}</ConfigButton>
        </ConfigFooter>
      </div>
  );

  if (embedded) return plugContent;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {plugContent}
    </div>
  );
}
