"use client";

function apiFor(peer: string | undefined, path: string): string {
  if (!peer) return `/api/${path}`;
  const [route, query] = path.split("?", 2);
  return `/api/remote/${route}?${query ? query + "&" : ""}peer=${peer}`;
}

import { useState, useEffect, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { reloadAllAgentSessions } from "@/lib/agent-client";
import { Settings2, ExternalLink, Sparkles, Copy, ChevronDown, Star } from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/hooks/useI18n";
import { notifyEmbeddedModalState } from "@/lib/embedded-modal";
import type { ResourceDiagnostic } from "@earendil-works/pi-coding-agent";
import type {
  PluginPackageInfo,
  PluginsResponse,
  SkillAnalysisJob,
  SkillInfo as Skill,
  SkillInstallScope,
  SkillUseState,
  SkillStateSnapshot,
  StaleSkillPolicy,
  SkillProjectStatus,
  SkillSearchResult,
  SkillsResponse,
  SkillUpdateResult,
  SkillViewScope,
  ProjectTrustStatus,
} from "@/lib/api-types";
import { parseSkillContent } from "@/lib/skill-content";
import { projectTrustReloadKey } from "./settings-ui-helpers";
import { ConfigPanelRefreshButton, useConfigSidebarResize } from "./ConfigPanelShared";
import { FrontmatterCard } from "./FrontmatterCard";
import { MarkdownBody } from "./MarkdownBody";
import { ReaderFloatingSelect } from "./ReaderFloatingSelect";
import { ConfigButton, ConfigFooter, ConfigScopeTag } from "./SettingsUi";
import type { SlashFavoriteCategory } from "@/lib/slash-favorite-state";
import { DEFAULT_SLASH_FAVORITE_CATEGORY_ID, DEFAULT_SLASH_FAVORITE_CATEGORY_NAME, slashFavoriteCategoryLabel } from "@/lib/slash-display";

export interface SkillsPanelIdentity {
  cwd: string;
  viewScope: SkillViewScope;
  remotePeer: string | null;
  sourceSessionId?: string | null;
  revision: number;
  trustKey?: string;
}

export interface SkillsPanelRequest {
  identity: SkillsPanelIdentity;
  generation: number;
}

export function sameSkillsPanelIdentity(
  left: SkillsPanelIdentity,
  right: SkillsPanelIdentity,
): boolean {
  return left.cwd === right.cwd
    && left.viewScope === right.viewScope
    && left.remotePeer === right.remotePeer
    && (left.sourceSessionId ?? null) === (right.sourceSessionId ?? null)
    && left.revision === right.revision
    && left.trustKey === right.trustKey;
}

export function isSkillsPanelRequestCurrent(
  request: SkillsPanelRequest,
  currentIdentity: SkillsPanelIdentity,
  currentGeneration: number,
): boolean {
  return request.generation === currentGeneration
    && sameSkillsPanelIdentity(request.identity, currentIdentity);
}


export function orderSkillsByDormancy<
  T extends Pick<Skill, "disableModelInvocation">,
>(skills: T[]): T[] {
  return [
    ...skills.filter((skill) => !skill.disableModelInvocation),
    ...skills.filter((skill) => skill.disableModelInvocation),
  ];
}

export type SkillRuntimeStateCode =
  | "fully-enabled"
  | "explicit-only"
  | "plugin-disabled"
  | "project-excluded"
  | "global-excluded"
  | "collision"
  | "error";

export interface SkillRuntimeDiagnosis {
  code: SkillRuntimeStateCode;
  runtimeLoaded: boolean;
  promptIncluded: boolean;
  commandUsable: boolean;
  badgeTone: "good" | "warn" | "muted" | "error";
  stateTitle: string;
  executionSummary: string;
  reasonDetail: string;
  diagnosticRule?: string;
}

export function resolveSkillLink(href: string, fromDocument: string): { document: string; anchor: string } {
  const hash = href.indexOf("#");
  const [linkPath, anchor] = [hash < 0 ? href : href.slice(0, hash), hash < 0 ? "" : href.slice(hash + 1)]
    .map((part) => { try { return decodeURIComponent(part); } catch { return part; } });
  if (!linkPath) return { document: fromDocument, anchor };
  if (linkPath.startsWith("/")) return { document: linkPath, anchor };
  const parts = fromDocument.split("/").slice(0, -1);
  for (const part of linkPath.split("/")) {
    if (part === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return { document: parts.join("/"), anchor };
}

export function getSkillRuntimeDiagnosis(
  skill: Skill,
  options: {
    viewScope?: SkillViewScope;
    pluginPackages?: Record<string, PluginPackageState>;
    diagnostics?: ResourceDiagnostic[];
    t?: (key: string, params?: Record<string, string | number>) => string;
  } = {},
): SkillRuntimeDiagnosis {
  const { viewScope = "global", pluginPackages, diagnostics, t = (k) => k } = options;

  const collision = diagnostics?.find(
    (d) => d.type === "collision" && d.collision?.loserPath === skill.filePath,
  );
  if (collision) {
    return {
      code: "collision",
      runtimeLoaded: false,
      promptIncluded: false,
      commandUsable: false,
      badgeTone: "warn",
      stateTitle: t("i18n.skillDiagTitleCollision"),
      executionSummary: t("skills.summaryNotLoaded"),
      reasonDetail: t("i18n.skillDiagReasonCollision"),
      diagnosticRule: collision.collision?.winnerPath
        ? `winnerPath: ${shortenPath(collision.collision.winnerPath)}`
        : collision.message,
    };
  }

  const errorDiag = diagnostics?.find(
    (d) => (d.type === "error" || d.type === "warning") && d.path === skill.filePath,
  );
  if (errorDiag && !skill.resourceEnabled) {
    return {
      code: "error",
      runtimeLoaded: false,
      promptIncluded: false,
      commandUsable: false,
      badgeTone: "error",
      stateTitle: t("i18n.skillDiagTitleError"),
      executionSummary: t("skills.summaryNotLoaded"),
      reasonDetail: errorDiag.message || t("i18n.skillDiagReasonError"),
      diagnosticRule: errorDiag.message,
    };
  }

  if (pluginPackages && isPluginDisabledForSkill(skill, pluginPackages)) {
    const source = skill.sourceInfo?.source ?? "plugin";
    return {
      code: "plugin-disabled",
      runtimeLoaded: false,
      promptIncluded: false,
      commandUsable: false,
      badgeTone: "muted",
      stateTitle: t("i18n.skillDiagTitlePluginDisabled"),
      executionSummary: t("skills.summaryNotLoaded"),
      reasonDetail: t("i18n.skillDiagReasonPluginDisabled"),
      diagnosticRule: `packages["${source}"].disabled = true`,
    };
  }

  if (skill.policy && skill.policy.availability !== "available") {
    return {
      code: "error",
      runtimeLoaded: false,
      promptIncluded: false,
      commandUsable: false,
      badgeTone: "error",
      stateTitle: t("i18n.skillDiagTitleError") || "Runtime unavailable",
      executionSummary: "Prompt excluded · Runtime unavailable · / command unavailable",
      reasonDetail: skill.policy.staleReason ?? "The exact Skill policy key is stale or unavailable.",
      diagnosticRule: `availability: ${skill.policy.availability}`,
    };
  }

  if (
    viewScope === "project" &&
    (skill.projectOverride === "disabled" ||
      skill.projectState === "disabled" ||
      (!skill.resourceEnabled && skill.sourceInfo?.scope === "project"))
  ) {
    const rule = skill.pluginResourceKey
      ? `-${skill.pluginResourceKey}`
      : `-${shortenPath(skill.filePath)}`;
    return {
      code: "project-excluded",
      runtimeLoaded: false,
      promptIncluded: false,
      commandUsable: false,
      badgeTone: "muted",
      stateTitle: t("i18n.skillDiagTitleProjectExcluded"),
      executionSummary: t("skills.summaryNotLoaded"),
      reasonDetail: t("i18n.skillDiagReasonProjectExcluded"),
      diagnosticRule: `rule: ${rule}`,
    };
  }

  if (!skill.resourceEnabled) {
    const rule = skill.pluginResourceKey
      ? `-${skill.pluginResourceKey}`
      : `-${shortenPath(skill.filePath)}`;
    return {
      code: "global-excluded",
      runtimeLoaded: false,
      promptIncluded: false,
      commandUsable: false,
      badgeTone: "muted",
      stateTitle: t("i18n.skillDiagTitleGlobalExcluded"),
      executionSummary: t("skills.summaryNotLoaded"),
      reasonDetail: t("i18n.skillDiagReasonGlobalExcluded"),
      diagnosticRule: `rule: ${rule}`,
    };
  }

  const explicitOnly = skill.invocationMode
    ? skill.invocationMode === "explicit-only"
    : Boolean(skill.disableModelInvocation)
      || (viewScope === "project" && skill.effectiveSkillEnabled === false);
  const runtimeInvocationOverride =
    skill.declaresManualInvocation === true
    && (skill.invocationMode === "automatic" || !skill.disableModelInvocation);
  if (explicitOnly) {
    return {
      code: "explicit-only",
      runtimeLoaded: true,
      promptIncluded: false,
      commandUsable: true,
      badgeTone: "warn",
      stateTitle: t("i18n.skillCurrentStateManual"),
      executionSummary: t("skills.summaryManualOnly"),
      reasonDetail: t("i18n.skillDiagReasonExplicitOnly"),
      diagnosticRule: skill.globalInvocationOverride === "disabled"
        ? "global setting: piWebGlobalSkillInvocationOverrides = disabled"
        : skill.invocationModeSource === "explicit"
          ? "Reader invocation mode: explicit-only"
        : skill.disableModelInvocation
          ? "frontmatter: disable-model-invocation: true"
          : "project override: effectiveSkillEnabled = false",
    };
  }

  return {
    code: "fully-enabled",
    runtimeLoaded: true,
    promptIncluded: true,
    commandUsable: true,
    badgeTone: "good",
    stateTitle: t("i18n.skillCurrentStateAutomatic"),
    executionSummary: t("skills.summaryAutomatic"),
    reasonDetail: runtimeInvocationOverride
      ? t("i18n.skillDiagReasonFrontmatterOverride")
      : t("i18n.skillDiagReasonFullyEnabled"),
    ...(runtimeInvocationOverride
      ? { diagnosticRule: "frontmatter: disable-model-invocation: true; effective setting: enabled" }
      : {}),
  };
}

function shortenPath(p: string): string {
  // Match common home dir patterns: /Users/xxx, /home/xxx
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function skillIsPlugin(skill: Skill): boolean {
  return skill.sourceInfo?.origin === "package";
}

type PluginPackageState = Pick<PluginPackageInfo, "source" | "scope" | "disabled">;

export function isPluginDisabledForSkill(
  skill: Skill,
  packages: Record<string, PluginPackageState>,
): boolean {
  const source = skill.sourceInfo?.source;
  return skillIsPlugin(skill) && Boolean(source && packages[source]?.disabled);
}

export type PluginSkillGroupStatus = "enabled" | "disabled" | "unknown";

export function getPluginSkillGroupStatus(
  source: string | undefined,
  packages: Record<string, PluginPackageState>,
): PluginSkillGroupStatus {
  if (!source) return "unknown";
  const pkg = packages[source];
  if (!pkg) return "unknown";
  return pkg.disabled ? "disabled" : "enabled";
}

export function pluginEnableAction(
  pkg: Pick<PluginPackageInfo, "scope">,
  viewScope: SkillViewScope,
): { action: "enable" | "set_project_override"; scope: SkillViewScope } {
  if (viewScope === "project" && pkg.scope === "global") {
    return { action: "set_project_override", scope: "project" };
  }
  return { action: "enable", scope: pkg.scope };
}

function skillIsEnabled(
  skill: Skill,
  viewScope: SkillViewScope = "global",
  pluginPackages?: Record<string, PluginPackageState>,
): boolean {
  if (pluginPackages && isPluginDisabledForSkill(skill, pluginPackages)) return false;
  if (skill.policy) return skill.policy.resourceState === "enabled";
  if (viewScope === "project" && skill.effectiveSkillEnabled !== undefined) {
    return skill.effectiveSkillEnabled;
  }
  return skill.resourceEnabled && !skill.disableModelInvocation;
}

export function skillEffectiveUseState(
  skill: Skill,
  viewScope: SkillViewScope = "global",
  pluginPackages?: Record<string, PluginPackageState>,
): SkillUseState {
  if (pluginPackages && isPluginDisabledForSkill(skill, pluginPackages)) return "disabled";
  if (skill.policy && skill.policy.availability !== "available") return "disabled";
  if (
    viewScope === "project" &&
    (skill.projectOverride === "disabled" ||
      skill.projectState === "disabled" ||
      (!skill.resourceEnabled && skill.sourceInfo?.scope === "project"))
  ) {
    return "disabled";
  }
  if (!skill.resourceEnabled) return "disabled";
  const explicitOnly = skill.invocationMode
    ? skill.invocationMode === "explicit-only"
    : Boolean(skill.disableModelInvocation)
      || (viewScope === "project" && skill.effectiveSkillEnabled === false);
  return explicitOnly ? "explicit-only" : "automatic";
}

export function isSkillVisible(
  skill: Skill,
  showAutomatic: boolean,
  showExplicitOnly: boolean,
  showDisabled?: boolean | SkillViewScope,
  viewScope: SkillViewScope = "global",
  pluginPackages?: Record<string, PluginPackageState>,
): boolean {
  if (typeof showDisabled !== "boolean") {
    const legacyScope = (typeof showDisabled === "string" ? showDisabled : viewScope) as SkillViewScope;
    const legacyPluginPackages = pluginPackages ?? (typeof showDisabled === "object" ? showDisabled as Record<string, PluginPackageState> : undefined);
    return skillIsEnabled(skill, legacyScope, legacyPluginPackages) ? showAutomatic : showExplicitOnly;
  }
  const state = skillEffectiveUseState(skill, viewScope, pluginPackages);
  if (state === "automatic") return showAutomatic;
  if (state === "explicit-only") return showExplicitOnly;
  return showDisabled;
}

const FRIENDLY_PLUGIN_GROUP_NAMES: Record<string, string> = {
  "paperspine-pi": "PaperSpine Pi",
};

function friendlyPluginGroupName(name: string): string {
  return FRIENDLY_PLUGIN_GROUP_NAMES[name] ?? name;
}

export function pluginSkillGroupLabel(source: string): string {
  const normalized = source.trim().replace(/[?#].*$/, "").replace(/[\\/]+$/, "");
  if (normalized.toLowerCase().startsWith("npm:")) {
    const spec = normalized.slice(4);
    const packageNameEnd = spec.startsWith("@") ? spec.indexOf("/", 1) : 0;
    const lastAt = spec.lastIndexOf("@");
    const name = lastAt > packageNameEnd ? spec.slice(0, lastAt) : spec;
    return friendlyPluginGroupName(name.startsWith("@") ? name.slice(name.lastIndexOf("/") + 1) : name);
  }
  if (/^(git:|git\+|github:|https?:\/\/|ssh:\/\/)/i.test(normalized)) {
    const repositoryName = normalized
      .split(/[\\/]/)
      .pop()
      ?.replace(/^git:/i, "")
      .replace(/\.git$/i, "") || normalized;
    const refSeparator = repositoryName.lastIndexOf("@");
    return friendlyPluginGroupName(refSeparator > 0 ? repositoryName.slice(0, refSeparator) : repositoryName);
  }
  return friendlyPluginGroupName(normalized.split(/[\\/]/).pop() || normalized);
}

export function skillProjectStatus(skill: Skill): SkillProjectStatus {
  if (skill.sourceInfo.scope === "project") return "project";
  if (skill.projectStatus) return skill.projectStatus;
  const projectEnabled = skill.effectiveSkillEnabled
    ?? (skill.resourceEnabled && !skill.disableModelInvocation);
  const globalEnabled = skill.globalSkillEnabled
    ?? ((skill.globalResourceEnabled ?? skill.resourceEnabled) && !skill.disableModelInvocation);
  return projectEnabled === globalEnabled ? "matching" : "different";
}

function projectSkillStatusLabel(
  status: SkillProjectStatus,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (status === "project") return t("i18n.projectFilterProject");
  return status === "matching"
    ? t("i18n.projectPluginStateMatching")
    : t("i18n.projectPluginStateDifferent");
}

export type ProjectSkillFilter = "different" | "all" | "matching" | "project";

export function isProjectSkillVisible(
  skill: Skill,
  filter: ProjectSkillFilter,
): boolean {
  return filter === "all" || skillProjectStatus(skill) === filter;
}

export function projectSkillFilterCounts(
  skills: Skill[],
): Record<ProjectSkillFilter, number> {
  const counts: Record<ProjectSkillFilter, number> = {
    different: 0,
    all: skills.length,
    matching: 0,
    project: 0,
  };
  for (const skill of skills) counts[skillProjectStatus(skill)] += 1;
  return counts;
}

export function selectVisibleSkillPath(
  skills: Skill[],
  selected: string | null,
): string | null {
  return skills.find((skill) => skill.filePath === selected)?.filePath
    ?? skills[0]?.filePath
    ?? null;
}

export function isSkillSearchMatch(skill: Skill, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [skill.name, skill.description, skill.filePath, skill.sourceInfo.source ?? ""]
    .some((value) => value.toLowerCase().includes(normalized));
}

export function filterSkillsForProjectStatusCounts(
  skills: Skill[],
  options: {
    searchQuery: string;
    showEnabled?: boolean;
    showNotEnabled?: boolean;
    showAutomatic?: boolean;
    showExplicitOnly?: boolean;
    showDisabled?: boolean;
    viewScope: SkillViewScope;
    pluginPackages?: Record<string, PluginPackageState>;
  },
): Skill[] {
  const showAutomatic = options.showAutomatic ?? options.showEnabled ?? true;
  const showExplicitOnly = options.showExplicitOnly ?? options.showNotEnabled ?? true;
  const showDisabled = options.showDisabled ?? options.showNotEnabled ?? true;
  return skills
    .filter((skill) => isSkillSearchMatch(skill, options.searchQuery))
    .filter((skill) => isSkillVisible(
      skill,
      showAutomatic,
      showExplicitOnly,
      showDisabled,
      options.viewScope,
      options.pluginPackages,
    ));
}

export function sortSkillsByName(skills: Skill[]): Skill[] {
  return [...skills].sort((left, right) =>
    left.name.localeCompare(right.name) || left.filePath.localeCompare(right.filePath),
  );
}

export function getSkillCurrentStateLabel(
  diagnosis: Pick<SkillRuntimeDiagnosis, "code">,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (diagnosis.code === "fully-enabled") return t("i18n.skillCurrentStateAutomatic");
  if (diagnosis.code === "explicit-only") return t("i18n.skillCurrentStateManual");
  return t("i18n.skillCurrentStateUnavailable");
}

export function getSkillPolicyLabel(
  skill: Skill,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (skill.invocationMode === "automatic") return t("i18n.skillCurrentStateAutomatic");
  if (skill.invocationMode === "explicit-only") return t("i18n.skillCurrentStateManual");
  if (!skill.declaresManualInvocation) return t("i18n.skillConfigNoManualDeclaration");
  return skill.disableModelInvocation
    ? t("i18n.skillConfigDeclaredManual")
    : t("i18n.skillConfigManualOverridden");
}

export function getSkillInvocationAdviceLabel(
  skill: Skill,
  _diagnosis: Pick<SkillRuntimeDiagnosis, "code">,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  // A manual declaration is decided by configuration: the analysis pipeline
  // records frontmatter/manual for it and never produces AI advice, so the
  // honest label is "not applicable", not "not analyzed".
  if (skill.declaresManualInvocation) return t("i18n.skillAdviceConfiguredManual");
  if (skill.triggerModeSource === "ai" && skill.triggerMode === "automatic") {
    return t("i18n.skillAdviceAiAutomatic");
  }
  if (skill.triggerModeSource === "ai" && skill.triggerMode === "manual") {
    return t("i18n.skillAdviceAiManual");
  }
  if (skill.triggerModeSource === "fallback") {
    return t("i18n.skillAdviceFallback");
  }
  return t("i18n.skillAdviceNotAnalyzed");
}

export function getSkillStateDotTone(
  diagnosis: Pick<SkillRuntimeDiagnosis, "code">,
): "automatic" | "manual" | "unavailable" {
  if (diagnosis.code === "fully-enabled") return "automatic";
  if (diagnosis.code === "explicit-only") return "manual";
  return "unavailable";
}

export function getSkillAdviceConflict(
  skill: Skill,
  diagnosis: Pick<SkillRuntimeDiagnosis, "code">,
): boolean {
  if (skill.declaresManualInvocation) return false;
  if (skill.triggerModeSource !== "ai" || !skill.triggerMode) return false;
  if (diagnosis.code !== "fully-enabled" && diagnosis.code !== "explicit-only") return false;
  const currentAutomatic = diagnosis.code === "fully-enabled";
  return currentAutomatic !== (skill.triggerMode === "automatic");
}

export function getSkillListBadge(
  skill: Skill,
  diagnosis: Pick<SkillRuntimeDiagnosis, "code">,
  t: (key: string, params?: Record<string, string | number>) => string,
): { label: string; tone: "advice" | ReturnType<typeof getSkillStateDotTone> } {
  if (getSkillAdviceConflict(skill, diagnosis)) {
    return {
      label: t(skill.triggerMode === "manual" ? "i18n.skillListAdviceManual" : "i18n.skillListAdviceAutomatic"),
      tone: "advice",
    };
  }
  return { label: getSkillCurrentStateLabel(diagnosis, t), tone: getSkillStateDotTone(diagnosis) };
}

export interface SkillChecklistItem {
  key: "runtime" | "prompt" | "manual";
  icon: string;
  iconColor: string;
  title: string;
  detail: string;
  state: "good" | "warn" | "error" | "muted";
}

export function getSkillChecklistItems(
  diagnosis: Pick<SkillRuntimeDiagnosis, "runtimeLoaded" | "promptIncluded" | "commandUsable">,
  skill: Pick<Skill, "name">,
  t: (key: string, params?: Record<string, string | number>) => string,
): SkillChecklistItem[] {
  const runtimeItem: SkillChecklistItem = {
    key: "runtime",
    icon: diagnosis.runtimeLoaded ? "✓" : "✗",
    iconColor: diagnosis.runtimeLoaded ? "#15803d" : "#b91c1c",
    title: t("i18n.skillChecklistRuntimeTitle"),
    detail: diagnosis.runtimeLoaded
      ? t("i18n.skillChecklistRuntimeLoaded")
      : t("i18n.skillChecklistRuntimeNotLoaded"),
    state: diagnosis.runtimeLoaded ? "good" : "error",
  };

  const promptWarn = !diagnosis.promptIncluded && diagnosis.runtimeLoaded;
  const promptItem: SkillChecklistItem = {
    key: "prompt",
    icon: diagnosis.promptIncluded ? "✓" : (diagnosis.runtimeLoaded ? "⊘" : "✗"),
    iconColor: diagnosis.promptIncluded
      ? "var(--accent)"
      : (promptWarn ? "#f59e0b" : "var(--text-dim)"),
    title: t("i18n.skillChecklistPromptTitle"),
    detail: diagnosis.promptIncluded
      ? t("i18n.skillChecklistPromptIncluded")
      : t("i18n.skillChecklistPromptExcluded"),
    state: diagnosis.promptIncluded ? "good" : (promptWarn ? "warn" : "muted"),
  };

  const manualItem: SkillChecklistItem = {
    key: "manual",
    icon: diagnosis.commandUsable ? "✓" : "✗",
    iconColor: diagnosis.commandUsable ? "#15803d" : "var(--text-dim)",
    title: t("i18n.skillChecklistManualTitle"),
    detail: diagnosis.commandUsable
      ? t("i18n.skillChecklistManualAvailable", { name: skill.name })
      : t("i18n.skillChecklistManualUnavailable"),
    state: diagnosis.commandUsable ? "good" : "muted",
  };

  return [runtimeItem, promptItem, manualItem];
}

function FilterButton({
  active,
  label,
  title,
  onToggle,
}: {
  active: boolean;
  label: string;
  title?: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onToggle}
      title={title}
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

function ScopeTabs({
  value,
  projectResourcesLoaded,
  onChange,
}: {
  value: SkillViewScope;
  projectResourcesLoaded: boolean;
  onChange: (scope: SkillViewScope) => void;
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
      {(["global", "project"] as const).map((scope) => {
        const active = value === scope;
        const unavailable = scope === "project" && !projectResourcesLoaded;
        return (
          <button
            key={scope}
            type="button"
            onClick={() => {
              if (!unavailable) onChange(scope);
            }}
            disabled={unavailable}
            title={unavailable ? t("trust.projectScopeUnavailable") : undefined}
            style={{
              width: 120,
              border: "none",
              borderRight: scope === "global" ? "1px solid var(--border)" : "none",
              background: active ? "rgba(37,99,235,0.13)" : "none",
              color: active ? "var(--accent)" : "var(--text-muted)",
              cursor: unavailable ? "not-allowed" : "pointer",
              opacity: unavailable ? 0.45 : 1,
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

function sourceLabel(skill: Skill): string {
  const src = skill.sourceInfo?.source;
  const scope = skill.sourceInfo?.scope;
  if (scope === "user" || src === "user") return "global";
  if (scope === "project" || src === "project") return "project";
  return "path";
}

function updateKey(skill: Skill): string | null {
  return skill.install
    ? `${skill.install.scope}\0${skill.install.package}`
    : null;
}

const iconButtonStyle: React.CSSProperties = {
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
};

function shortVersion(version?: string): string {
  return version ? version.slice(0, 8) : "unknown";
}

interface SkillContentState {
  filePath: string;
  content: string | null;
  loading: boolean;
  error: string | null;
}

function SkillDetail({
  skill,
  cwd,
  onSetState,
  invocationBusy,
  saveError,
  onOpenFile,
  onUseSkill,
  updateStatus,
  checkingUpdate,
  updating,
  updateError,
  onCheckUpdate,
  onUpdate,
  viewScope,
  pluginPackages,
  onReloadAllSessions,
  reloadBusy,
  reloadMessage,
  sessionId,
  remotePeer,
  skillContent,
  diagnostics,
  slashFavoriteKeys,
  slashFavoriteCategories,
  onToggleFavorite,
  onChangeFavoriteCategory,
}: {
  skill: Skill;
  cwd: string;
  onSetState: (skill: Skill, state: SkillUseState | "inherit") => void;
  invocationBusy: boolean;
  saveError: string | null;
  updateStatus?: SkillUpdateResult;
  checkingUpdate: boolean;
  updating: boolean;
  updateError: string | null;
  onCheckUpdate: () => void;
  onUpdate: () => void;
  viewScope: SkillViewScope;
  pluginPackages: Record<string, PluginPackageState>;
  onReloadAllSessions: () => void;
  reloadBusy: boolean;
  reloadMessage: string | null;
  sessionId: string | null;
  remotePeer?: string;
  skillContent: SkillContentState | null;
  diagnostics?: ResourceDiagnostic[];
  onOpenFile?: (filePath: string) => void;
  onUseSkill?: (skillName: string) => void;
  slashFavoriteKeys?: string[];
  slashFavoriteCategories?: SlashFavoriteCategory[];
  onToggleFavorite?: (skillName: string) => void;
  onChangeFavoriteCategory?: (skillName: string, targetCatId: string) => void;
}) {
  const { t } = useI18n();
  const label = sourceLabel(skill);
  const displayLabel = label === "global"
    ? t("skills.scope.global")
    : label === "project"
      ? t("skills.scope.project")
      : t("skills.scope.path");
  const enabled = skillIsEnabled(skill, viewScope, pluginPackages);
  const projectStatus = viewScope === "project" ? skillProjectStatus(skill) : undefined;
  const currentSkillKey = `skill:skill:${skill.name}`;
  const legacySkillKey = `skill:${skill.name}`;
  const isFavorite = Boolean(
    slashFavoriteKeys && (
      slashFavoriteKeys.includes(currentSkillKey) ||
      slashFavoriteKeys.includes(legacySkillKey)
    ),
  );
  const currentFavoriteCategory = isFavorite && slashFavoriteCategories && slashFavoriteCategories.length > 0
    ? slashFavoriteCategories.find((cat) =>
        cat.keys.includes(currentSkillKey) || cat.keys.includes(legacySkillKey)
      ) ?? slashFavoriteCategories[0]
    : null;
  const diagnosis = getSkillRuntimeDiagnosis(skill, {
    viewScope,
    pluginPackages,
    diagnostics,
    t,
  });
  const policyLabel = getSkillPolicyLabel(skill, t);
  const invocationAdviceLabel = getSkillInvocationAdviceLabel(skill, diagnosis, t);
  const invocationAdviceReason = skill.triggerModeSource === "ai"
    ? skill.triggerModeReason
    : undefined;
  const analysisFailureReason = skill.triggerModeSource === "fallback" ? skill.triggerModeReason : undefined;
  const adviceConflict = getSkillAdviceConflict(skill, diagnosis);
  const stateDotTone = getSkillStateDotTone(diagnosis);
  const dotColor = stateDotTone === "automatic"
    ? "var(--accent)"
    : stateDotTone === "manual"
      ? "#f59e0b"
      : "var(--border)";
  const dotShadow = stateDotTone === "unavailable" ? "none" : `0 0 4px ${dotColor}`;
  const checklistItems = getSkillChecklistItems(diagnosis, skill, t);
  const useSkillLabel = `/skill:${skill.name}`;

  const [copiedInstallPath, setCopiedInstallPath] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const contentState = skillContent?.filePath === skill.filePath ? skillContent : null;
  const contentParts = contentState?.content === null || !contentState
    ? null
    : parseSkillContent(contentState.content);

  const rootDocument = skill.filePath.split(/[\\/]/).pop() || "SKILL.md";
  const [documents, setDocuments] = useState<string[]>([]);
  const documentPath = documents[documents.length - 1] ?? rootDocument;
  const [docContent, setDocContent] = useState<string | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const instructionsRef = useRef<HTMLDivElement>(null);
  const pendingAnchor = useRef<string | null>(null);
  const [anchorRequest, setAnchorRequest] = useState(0);

  useEffect(() => {
    setDocuments([]);
    setDocContent(null);
    setDocError(null);
  }, [skill.filePath]);

  useEffect(() => {
    if (documentPath === rootDocument) {
      setDocContent(null);
      setDocError(null);
      setDocLoading(false);
      return;
    }
    const controller = new AbortController();
    setDocLoading(true);
    setDocError(null);
    const params = new URLSearchParams({
      cwd,
      filePath: skill.filePath,
      document: documentPath,
      scope: viewScope,
    });
    void fetch(`${apiFor(remotePeer, `skills/content?${params.toString()}`)}`, { signal: controller.signal })
      .then(async (res) => {
        const data = await res.json() as { content?: string; error?: string };
        if (!res.ok || data.error || typeof data.content !== "string") {
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        if (!controller.signal.aborted) {
          setDocContent(data.content);
          setDocLoading(false);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setDocError(err instanceof Error ? err.message : String(err));
          setDocLoading(false);
        }
      });
    return () => controller.abort();
  }, [cwd, documentPath, remotePeer, rootDocument, skill.filePath, viewScope]);

  useLayoutEffect(() => {
    const anchor = pendingAnchor.current;
    const root = instructionsRef.current;
    if (anchor === null || !root) return;
    pendingAnchor.current = null;
    const heading = anchor ? root.querySelector(`[data-heading-anchor="${CSS.escape(anchor)}"]`) : null;
    (heading ?? root).scrollIntoView({ block: "start" });
  }, [docContent, contentState?.content, anchorRequest]);

  const openLink = useCallback((href: string) => {
    const link = resolveSkillLink(href, documentPath);
    pendingAnchor.current = link.anchor;
    if (link.document === documentPath) {
      setAnchorRequest((r) => r + 1);
    } else {
      setDocuments((open) => [...open, link.document]);
    }
  }, [documentPath]);

  function displayPath(p: string): string {
    if (label === "project" && p.startsWith(cwd)) {
      const rel = p.slice(cwd.length).replace(/^[\/\\]/, "");
      return `./${rel}`;
    }
    return shortenPath(p);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 680 }}>
      {/* Header: Scope + Status + Name on left, Actions on right */}
      <div className="config-detail-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, minWidth: 0, minHeight: "var(--config-control-height)", flexWrap: "wrap" }}>
        <div className="config-detail-header-info" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 180, flex: 1, flexWrap: "wrap" }}>
          <ConfigScopeTag scope={label}>{displayLabel}</ConfigScopeTag>
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
              {projectSkillStatusLabel(projectStatus, t)}
            </span>
          )}
          {!enabled && (
            <span
              style={{
                fontSize: 10,
                padding: "1px 5px",
                borderRadius: 3,
                background: "rgba(120,120,120,0.12)",
                color: "var(--text-dim)",
                flexShrink: 0,
              }}
            >
              {t("i18n.disabled")}
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
            title={skill.name}
          >
            {skill.name}
          </span>
          {onToggleFavorite && (
            <button
              type="button"
              onClick={() => onToggleFavorite(skill.name)}
              title={isFavorite ? t("chat.unfavoriteSlashCommand") : t("chat.favoriteSlashCommand")}
              aria-label={isFavorite ? t("chat.unfavoriteSlashCommand") : t("chat.favoriteSlashCommand")}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 22,
                height: 22,
                padding: 0,
                background: isFavorite ? "rgba(234, 179, 8, 0.12)" : "transparent",
                border: `1px solid ${isFavorite ? "rgba(234, 179, 8, 0.35)" : "transparent"}`,
                borderRadius: 4,
                cursor: "pointer",
                color: isFavorite ? "#eab308" : "var(--text-muted)",
                flexShrink: 0,
                transition: "all 0.15s ease",
              }}
              onMouseEnter={(e) => {
                if (!isFavorite) {
                  e.currentTarget.style.color = "#eab308";
                  e.currentTarget.style.background = "rgba(234, 179, 8, 0.08)";
                }
              }}
              onMouseLeave={(e) => {
                if (!isFavorite) {
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.background = "transparent";
                }
              }}
            >
              <Star size={13} fill={isFavorite ? "#eab308" : "none"} strokeWidth={isFavorite ? 1.5 : 1.8} aria-hidden="true" />
            </button>
          )}
          {isFavorite && slashFavoriteCategories && slashFavoriteCategories.length > 0 && onChangeFavoriteCategory && (
            <ReaderFloatingSelect
              value={currentFavoriteCategory?.id ?? slashFavoriteCategories[0].id}
              onChange={(newCatId) => onChangeFavoriteCategory(skill.name, newCatId)}
              options={slashFavoriteCategories.map((c) => ({ value: c.id, label: slashFavoriteCategoryLabel(c, t("favorites.defaultCategory")) }))}
              ariaLabel={t("skills.selectFavoriteCategory")}
              title={t("skills.selectFavoriteCategory")}
              placement="below"
              align="start"
              triggerStyle={{
                fontSize: 11,
                height: 22,
                padding: "0 6px",
                borderRadius: 4,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text)",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                maxWidth: 120,
              }}
            />
          )}
        </div>

        <div className="config-detail-actions">
          {onUseSkill && (
            <ConfigButton
              size="small"
              className="config-button-icon"
              title={useSkillLabel}
              aria-label={useSkillLabel}
              aria-disabled={!diagnosis.commandUsable}
              disabled={!diagnosis.commandUsable}
              onClick={() => onUseSkill(skill.name)}
              style={{
                width: 28,
                height: 28,
                padding: 0,
                color: diagnosis.commandUsable ? "var(--accent)" : "var(--text-dim)",
              }}
            >
              <span
                aria-hidden="true"
                style={{ fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 700, lineHeight: 1 }}
              >
                /
              </span>
            </ConfigButton>
          )}
          {updateStatus?.state === "update-available" && (
            <ConfigButton variant="primary"
              type="button"
              onClick={onUpdate}
              disabled={updating || checkingUpdate}
            >
              {updating ? t("i18n.updating") : t("i18n.update")}
            </ConfigButton>
          )}
          <ConfigButton
            type="button"
            onClick={onReloadAllSessions}
            disabled={reloadBusy}
            title={t("i18n.reloadAllSessionsTitle")}
          >
            {reloadBusy ? t("i18n.reloadingAllSessions") : t("i18n.reloadAllSessions")}
          </ConfigButton>
        </div>
      </div>

      <SkillUseStateControl skill={skill} viewScope={viewScope} busy={invocationBusy} parentDisabled={isPluginDisabledForSkill(skill, pluginPackages)} onChange={(state) => onSetState(skill, state)} t={t} />
      <div data-testid="skill-advice-summary" style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12, lineHeight: 1.6, overflowWrap: "anywhere" }}>
        <div><span style={{ color: "var(--text-dim)" }}>{t("i18n.skillAdviceLabel")}: </span><strong>{invocationAdviceLabel}</strong></div>
        {invocationAdviceReason && <div>{invocationAdviceReason}</div>}
        {analysisFailureReason && <div role="alert" style={{ color: "#b45309" }}>{t("i18n.skillAnalysisFailed", { error: analysisFailureReason })}</div>}
        <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("i18n.skillAdviceIsRecommendation")}</div>
        <div style={{ marginTop: 5, color: "var(--text-muted)" }}>{t("i18n.skillConfigLabel")}: {diagnosis.stateTitle}</div>
        {adviceConflict && <div style={{ marginTop: 5, color: "#b45309" }}>{t("i18n.skillAdviceConflict")}</div>}
      </div>

      {reloadMessage && (
        <span style={{ fontSize: 12, color: "#16a34a" }}>
          {reloadMessage}
        </span>
      )}
      {saveError && (
        <span style={{ fontSize: 12, color: "#f87171" }}>
          {saveError}
        </span>
      )}
      {updateError && (
        <span style={{ fontSize: 12, color: "#ef4444" }}>
          {updateError}
        </span>
      )}

      {/* Metadata Grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(96px, 130px) minmax(0, 1fr)",
          gap: "9px 14px",
          fontSize: 12,
          lineHeight: 1.45,
        }}
      >
        {skill.install && (
          <>
            <div style={{ color: "var(--text-dim)" }}>{t("i18n.version")}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                {shortVersion(updateStatus?.currentVersion ?? skill.install.versionHash)}
              </span>
              {skill.install.canCheckForUpdates && (
                <ConfigButton size="small"
                  type="button"
                  onClick={onCheckUpdate}
                  disabled={checkingUpdate || updating}
                >
                  {t("i18n.check")}
                </ConfigButton>
              )}
              {updateStatus?.state === "update-available" && (
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "#d97706" }}>
                  → {shortVersion(updateStatus.latestVersion)}
                </span>
              )}
              {(checkingUpdate || (updateStatus && updateStatus.state !== "update-available")) && (
                <span
                  style={{
                    fontSize: 11,
                    color: checkingUpdate
                      ? "var(--accent)"
                      : updateStatus?.state === "up-to-date"
                        ? "#16a34a"
                        : updateStatus?.state === "error"
                          ? "#ef4444"
                          : "var(--text-dim)",
                  }}
                >
                  {checkingUpdate
                    ? t("i18n.checking")
                    : updateStatus?.state === "up-to-date"
                      ? t("i18n.upToDate")
                      : updateStatus?.state === "unsupported"
                        ? t("i18n.automaticChecksUnavailable")
                        : updateStatus?.message || t("i18n.checkFailed")}
                </span>
              )}
            </div>
          </>
        )}

        {skill.install?.skillsShUrl && (
          <>
            <div style={{ color: "var(--text-dim)" }}>Source</div>
            <div style={{ minWidth: 0 }}>
              <a
                href={skill.install.skillsShUrl}
                target="_blank"
                rel="noreferrer"
                title={skill.install.skillsShUrl}
                style={{
                  color: "var(--accent)",
                  textDecoration: "none",
                  fontFamily: "var(--font-mono)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  maxWidth: "100%",
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {skill.install.skillsShUrl.replace(/^https?:\/\//, "")} ↗
                </span>
              </a>
            </div>
          </>
        )}

        <div style={{ color: "var(--text-dim)" }}>{t("i18n.installedPath")}</div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          <span
            style={{
              flex: "0 1 auto",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={skill.filePath}
          >
            {displayPath(skill.filePath)}
          </span>
          {onOpenFile && (
            <button
              type="button"
              onClick={() => onOpenFile(skill.filePath)}
              title={t("settings.openInReaderTitle")}
              aria-label={t("settings.openInReaderTitle")}
              style={iconButtonStyle}
            >
              <ExternalLink size={13} strokeWidth={2} />
            </button>
          )}
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(skill.filePath);
                setCopiedInstallPath(true);
                setCopyFailed(false);
                setTimeout(() => setCopiedInstallPath(false), 2000);
              } catch {
                setCopyFailed(true);
                setTimeout(() => setCopyFailed(false), 2000);
              }
            }}
            title={copiedInstallPath
              ? t("i18n.copied")
              : copyFailed
                ? t("files.copyPathFailed")
                : t("session.copyFile")}
            aria-label={copiedInstallPath
              ? t("i18n.copied")
              : copyFailed
                ? t("files.copyPathFailed")
                : t("session.copyFile")}
            style={{
              ...iconButtonStyle,
              color: copiedInstallPath ? "#16a34a" : copyFailed ? "#ef4444" : "var(--accent, #3b82f6)",
            }}
          >
            <Copy size={13} strokeWidth={2} />
          </button>
        </div>

      </div>

      {/* Authorized skill content. MarkdownBody retains Reader's existing
          URL, raw-HTML and file-link sanitization semantics. */}
      <div
        ref={instructionsRef}
        style={{
          padding: "10px 12px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "var(--bg-panel)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ color: "var(--text-dim)", fontSize: 12, fontWeight: 600 }}>
            {documents.length > 0 ? documentPath : "Skill instructions"}
          </div>
          {documents.length > 0 && (
            <ConfigButton size="small"
              type="button"
              onClick={() => {
                pendingAnchor.current = "";
                setDocuments((open) => open.slice(0, -1));
              }}
            >
              ← {t("skills.documentBack")}
            </ConfigButton>
          )}
        </div>
        {documents.length > 0 ? (
          docLoading ? (
            <span role="status" style={{ color: "var(--text-dim)", fontSize: 12 }}>
              {t("i18n.loading")}
            </span>
          ) : docError ? (
            <span role="alert" style={{ color: "#ef4444", fontSize: 12, overflowWrap: "anywhere" }}>
              {docError}
            </span>
          ) : docContent ? (
            <MarkdownBody
              className="skill-instructions"
              cwd={[skill.baseDir, ...documentPath.split("/").slice(0, -1)].join("/")}
              sessionId={sessionId ?? undefined}
              remotePeer={remotePeer}
              onOpenFile={onOpenFile}
              onNavigateLink={openLink}
            >
              {docContent}
            </MarkdownBody>
          ) : (
            <span style={{ color: "var(--text-dim)", fontSize: 12 }}>No instructions</span>
          )
        ) : !contentState || contentState.loading ? (
          <span role="status" style={{ color: "var(--text-dim)", fontSize: 12 }}>
            {t("i18n.loading")}
          </span>
        ) : contentState.error ? (
          <span role="alert" style={{ color: "#ef4444", fontSize: 12, overflowWrap: "anywhere" }}>
            {contentState.error}
          </span>
        ) : contentParts?.frontmatter ? (
          <>
            <FrontmatterCard data={contentParts.frontmatter} />
            {contentParts.body.trim() ? (
              <MarkdownBody
                className="skill-instructions"
                cwd={skill.baseDir}
                sessionId={sessionId ?? undefined}
                remotePeer={remotePeer}
                onOpenFile={onOpenFile}
                onNavigateLink={openLink}
              >
                {contentParts.body}
              </MarkdownBody>
            ) : (
              <span style={{ color: "var(--text-dim)", fontSize: 12 }}>No instructions</span>
            )}
          </>
        ) : contentParts?.body.trim() ? (
          <MarkdownBody
            className="skill-instructions"
            cwd={skill.baseDir}
            sessionId={sessionId ?? undefined}
            remotePeer={remotePeer}
            onOpenFile={onOpenFile}
            onNavigateLink={openLink}
          >
            {contentParts.body}
          </MarkdownBody>
        ) : (
          <span style={{ color: "var(--text-dim)", fontSize: 12 }}>No instructions</span>
        )}
      </div>

      {/* Technical runtime diagnosis card */}
      <div
        style={{
          padding: "10px 12px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "var(--bg-panel)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: dotColor,
                boxShadow: dotShadow,
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
              {diagnosis.stateTitle}
            </span>
          </div>
          <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            {diagnosis.executionSummary}
          </span>
        </div>

        <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {diagnosis.reasonDetail}
        </div>

        {/* Execution Checklist */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "8px 10px",
            borderRadius: 5,
            background: "var(--bg)",
            border: "1px solid var(--border)",
          }}
        >
          {checklistItems.map((item) => (
            <div
              key={item.key}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                fontSize: 11,
                lineHeight: 1.45,
              }}
            >
              <span
                style={{
                  color: item.iconColor,
                  fontWeight: 700,
                  width: 14,
                  textAlign: "center",
                  flexShrink: 0,
                  fontSize: 12,
                }}
              >
                {item.icon}
              </span>
              <span style={{ color: "var(--text-dim)", flex: "0 0 88px", fontWeight: 500 }}>
                {item.title}
              </span>
              <span style={{ color: item.state === "warn" ? "#b45309" : "var(--text-muted)", flex: 1 }}>
                {item.detail}
              </span>
            </div>
          ))}
        </div>

        {/* Rules & Advice */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 5,
            paddingTop: 2,
            fontSize: 11,
            lineHeight: 1.45,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ color: "var(--text-dim)", flex: "0 0 88px" }}>{t("i18n.skillConfigLabel")}</span>
            <span style={{ color: "var(--text-muted)" }}>{policyLabel}</span>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ color: "var(--text-dim)", flex: "0 0 88px" }}>{t("i18n.skillAdviceLabel")}</span>
            <span style={{ color: "var(--text-muted)" }}>{invocationAdviceLabel}</span>
          </div>
          {invocationAdviceReason && (
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ color: "var(--text-dim)", flex: "0 0 88px" }}>{t("i18n.skillAdviceReasonPrefix")}</span>
              <span style={{ color: "var(--text-muted)" }}>{invocationAdviceReason}</span>
            </div>
          )}
          {analysisFailureReason && (
            <div role="alert" style={{ color: "#b45309", overflowWrap: "anywhere" }}>
              {t("i18n.skillAnalysisFailed", { error: analysisFailureReason })}
            </div>
          )}
        </div>

        {/* Conflict Warning */}
        {adviceConflict && (
          <div
            style={{
              padding: "6px 10px",
              borderRadius: 4,
              background: "rgba(245, 158, 11, 0.10)",
              border: "1px solid rgba(245, 158, 11, 0.25)",
              color: "#b45309",
              fontSize: 11,
              lineHeight: 1.45,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span style={{ flexShrink: 0 }}>⚠️</span>
            <span>{t("i18n.skillAdviceConflict")}</span>
          </div>
        )}
        {diagnosis.diagnosticRule && (
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
            {diagnosis.diagnosticRule}
          </div>
        )}
      </div>
    </div>
  );
}

function AddSkillPanel({
  peer,
  cwd,
  installedPackages,
  scope,
  onInstalled,
}: {
  cwd: string;
  peer?: string;
  installedPackages: Record<SkillInstallScope, ReadonlySet<string>>;
  scope: SkillInstallScope;
  onInstalled: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkillSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [newlyInstalledPkgs, setNewlyInstalledPkgs] = useState<Set<string>>(
    new Set(),
  );
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) return;
    setSearching(true);
    setSearchError(null);
    setResults([]);
    try {
      const res = await fetch(apiFor(peer, "skills/search"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q.trim() }),
      });
      const d = (await res.json()) as {
        results?: SkillSearchResult[];
        error?: string;
      };
      if (d.error) {
        setSearchError(d.error);
        return;
      }
      setResults(d.results ?? []);
      if ((d.results ?? []).length === 0) setSearchError("No skills found");
    } catch (e) {
      setSearchError(String(e));
    } finally {
      setSearching(false);
    }
  }, [peer]);

  const install = useCallback(
    async (pkg: string) => {
      setInstalling(pkg);
      setInstallError(null);
      try {
        const res = await fetch(apiFor(peer, "skills/install"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ package: pkg, scope, cwd }),
        });
        const d = (await res.json()) as { success?: boolean; error?: string };
        if (!res.ok || d.error) {
          setInstallError(d.error ?? `HTTP ${res.status}`);
          return;
        }
        setNewlyInstalledPkgs((prev) =>
          new Set(prev).add(`${scope}:${pkg}`),
        );
        onInstalled();
      } catch (e) {
        setInstallError(String(e));
      } finally {
        setInstalling(null);
      }
    },
    [onInstalled, peer, scope, cwd],
  );

  const installPath =
    scope === "global"
      ? "~/.pi/agent/skills/"
      : `${shortenPath(cwd)}/.agents/skills/`;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* ── Header area ── */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          marginBottom: 20,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
           {t("i18n.addSkill")}
        </div>

        {/* Search row */}
        <div style={{ display: "flex", gap: 8 }}>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") search(query);
            }}
             placeholder={t("i18n.skillSearchPlaceholder")}
            style={{
              flex: 1,
              padding: "7px 10px",
              fontSize: 13,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text)",
              outline: "none",
            }}
          />
          <ConfigButton size="small"
            onClick={() => search(query)}
            disabled={searching || !query.trim()}
          >
             {searching ? t("i18n.searching") : t("i18n.search")}
          </ConfigButton>
        </div>

        {/* Install path */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {scope === "global" ? t("i18n.pluginConfigGlobal") : t("i18n.pluginConfigProject")}
          </span>
          <span
            style={{
              fontSize: 12,
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            → {installPath}
          </span>
        </div>

        {/* Errors */}
        {searchError && (
          <div style={{ fontSize: 12, color: "#f87171" }}>{searchError}</div>
        )}
        {installError && (
          <div
            style={{ fontSize: 12, color: "#f87171", wordBreak: "break-word" }}
          >
            {installError}
          </div>
        )}
      </div>

      {/* ── Results list ── */}
      {results.length > 0 ? (
        <div style={{ flex: 1, overflowY: "auto" }}>
          {results.map((r) => {
            const isInstalled =
              installedPackages[scope].has(r.package) ||
              newlyInstalledPkgs.has(`${scope}:${r.package}`);
            const isInstalling = installing === r.package;
            // split "owner/repo@skill" for cleaner display
            const atIdx = r.package.indexOf("@");
            const repopart = atIdx > -1 ? r.package.slice(0, atIdx) : r.package;
            const skillpart = atIdx > -1 ? r.package.slice(atIdx + 1) : null;
            return (
              <div
                key={r.package}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "12px 0",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* skill name prominent */}
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--text)",
                      marginBottom: 3,
                    }}
                  >
                    {skillpart ?? repopart}
                  </div>
                  {/* repo + installs + link row */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        color: "var(--text-dim)",
                      }}
                    >
                      {repopart}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        color: "var(--text-muted)",
                        fontWeight: 500,
                      }}
                    >
                      {r.installs}
                    </span>
                    {r.url && (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          fontSize: 12,
                          color: "var(--accent)",
                          textDecoration: "none",
                        }}
                      >
                        skills.sh ↗
                      </a>
                    )}
                  </div>
                </div>
                <ConfigButton variant="primary" size="small"
                  onClick={() =>
                    !isInstalled && !isInstalling && install(r.package)
                  }
                  disabled={isInstalled || isInstalling || installing !== null}
                >
                  {isInstalled
                     ? `✓ ${t("i18n.installed")}`
                    : isInstalling
                       ? t("i18n.installing")
                       : t("i18n.install")}
                </ConfigButton>
              </div>
            );
          })}
        </div>
      ) : (
        !searchError &&
        !searching && (
          <div
            style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.8 }}
          >
            Search{" "}
            <a
              href="https://skills.sh"
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)", textDecoration: "none" }}
            >
              skills.sh
            </a>{" "}
            to discover and install skills for your agent.
          </div>
        )
      )}
    </div>
  );
}

type SkillGroup = {
  key: string;
  label: string;
  title?: string;
  skills: Skill[];
};

type SkillGroupAction = SkillUseState | "inherit" | "restore" | "enablePlugin";
type SkillGroupSnapshot = SkillStateSnapshot[];

function SkillGroupActionItem({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      style={{
        display: "block",
        width: "100%",
        padding: "8px 12px",
        border: "none",
        background: "transparent",
        color: disabled ? "var(--text-dim)" : "var(--text)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        fontSize: 12,
        textAlign: "left",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(event) => {
        if (!disabled) event.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = "transparent";
      }}
    >
      {label}
    </button>
  );
}

function SkillGroupList({
  groups,
  selected,
  addMode,
  updateStatuses,
  viewScope,
  pluginPackages,
  collapsed,
  busyGroups,
  settingsBusy,
  restoreAvailable,
  onToggleGroup,
  onRequestGroupAction,
  onSelect,
  onUseSkill,
  diagnostics,
  slashFavoriteKeys,
}: {
  groups: SkillGroup[];
  selected: string | null;
  addMode: boolean;
  updateStatuses: Record<string, SkillUpdateResult>;
  viewScope: SkillViewScope;
  pluginPackages: Record<string, PluginPackageState>;
  collapsed: Record<string, boolean>;
  busyGroups: Set<string>;
  settingsBusy: boolean;
  restoreAvailable: Set<string>;
  onToggleGroup: (groupKey: string) => void;
  onRequestGroupAction: (group: SkillGroup, action: SkillGroupAction) => void;
  onSelect: (skill: Skill) => void;
  onUseSkill?: (skillName: string) => void;
  diagnostics?: ResourceDiagnostic[];
  slashFavoriteKeys?: string[];
}) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [hoveredGroup, setHoveredGroup] = useState<string | null>(null);
  const [hoveredSkill, setHoveredSkill] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  return (
    <>
      {groups.map((group) => {
        const isCollapsed = collapsed[group.key] ?? groups.length >= 4;
        const groupBusy = settingsBusy || busyGroups.has(group.key);
        const disabledPluginSkill = group.skills.find((skill) => isPluginDisabledForSkill(skill, pluginPackages));
        const pluginDisabled = Boolean(disabledPluginSkill);
        const canInheritGlobal = canInheritGlobalSkillGroupState(group.skills, viewScope);
        const pluginGroupStatus = getPluginSkillGroupStatus(group.title, pluginPackages);
        const showActions = hoveredGroup === group.key || openMenu === group.key;
        const groupTitle = pluginDisabled ? `${group.title} · ${t("i18n.pluginDisabled")}` : group.title;
        const requestAction = (action: SkillGroupAction) => {
          setOpenMenu(null);
          onRequestGroupAction(group, action);
        };
        return (
          <div
            key={group.key}
            className="config-sidebar-group config-resource-group"
            style={{ marginBottom: 10, position: "relative" }}
            onMouseLeave={() => {
              setHoveredGroup((current) => current === group.key ? null : current);
              setOpenMenu((current) => current === group.key ? null : current);
            }}
          >
            <div
              className="config-resource-group-header"
              style={{
                display: "flex",
                alignItems: "center",
                width: "100%",
                position: "relative",
                borderTop: "1px solid var(--border)",
                borderBottom: "1px solid var(--border)",
                background: "var(--bg-panel)",
              }}
              onMouseEnter={() => setHoveredGroup(group.key)}
              onMouseLeave={() => setHoveredGroup((current) => current === group.key ? null : current)}
              onFocus={() => setHoveredGroup(group.key)}
            >
              <button
                type="button"
                onClick={() => onToggleGroup(group.key)}
                aria-expanded={!isCollapsed}
                aria-label={groupTitle}
                title={groupTitle}
                className="config-resource-group-toggle"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  flex: 1,
                  minWidth: 0,
                  border: "none",
                  background: "transparent",
                  color: "var(--text)",
                  cursor: "pointer",
                  fontWeight: 600,
                  textTransform: "none",
                  textAlign: "left",
                }}
              >
                <ChevronDown
                  size={13}
                  style={{
                    color: pluginGroupStatus === "enabled"
                      ? "var(--accent)"
                      : pluginGroupStatus === "disabled"
                        ? "var(--text-dim)"
                        : "var(--text)",
                    transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)",
                    transition: "transform 0.15s",
                  }}
                  aria-hidden="true"
                />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {group.label}
                </span>
                <span
                  style={{
                    flexShrink: 0,
                    marginLeft: 6,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: 11,
                    color: "var(--text-muted)",
                    fontWeight: 500,
                    opacity: showActions ? 0 : 1,
                    transition: "opacity 0.12s",
                  }}
                >
                  {group.skills.length}
                </span>
              </button>
              <button
                type="button"
                aria-label={t("i18n.manageSkillGroup")}
                title={t("i18n.manageSkillGroup")}
                aria-haspopup="menu"
                aria-expanded={openMenu === group.key}
                disabled={groupBusy}
                onFocus={() => setHoveredGroup(group.key)}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenMenu((current) => current === group.key ? null : group.key);
                }}
                style={{
                  position: "absolute",
                  top: "50%",
                  right: 6,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 28,
                  height: 28,
                  padding: 0,
                  transform: "translateY(-50%)",
                  border: "none",
                  borderRadius: 5,
                  background: showActions ? "var(--bg-hover)" : "transparent",
                  color: "var(--text-muted)",
                  cursor: groupBusy ? "not-allowed" : "pointer",
                  opacity: showActions ? (groupBusy ? 0.55 : 1) : 0,
                  pointerEvents: showActions ? "auto" : "none",
                  transition: "opacity 0.12s, background 0.12s",
                }}
              >
                <Settings2 size={16} strokeWidth={1.8} aria-hidden="true" />
              </button>
              {openMenu === group.key && (
                <div
                  role="menu"
                  aria-label={t("i18n.manageSkillGroup")}
                  style={{
                    position: "absolute",
                    top: "calc(100% - 2px)",
                    right: 6,
                    zIndex: 20,
                    minWidth: 188,
                    padding: "4px 0",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    background: "var(--bg-panel)",
                    boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
                  }}
                >
                  {(["automatic", "explicit-only", "disabled", ...(canInheritGlobal ? ["inherit"] : [])] as (SkillUseState | "inherit")[]).map((state) => (
                    <SkillGroupActionItem key={state} label={t("i18n.skillGroupSetState", { state: t(`i18n.skillUseState.${state}`) })} disabled={groupBusy || (pluginDisabled && (state === "automatic" || state === "explicit-only"))} onClick={() => requestAction(state)} />
                  ))}
                  <SkillGroupActionItem label={t("i18n.skillGroupRestore")} disabled={groupBusy || !restoreAvailable.has(group.key)} onClick={() => requestAction("restore")} />
                  {disabledPluginSkill && (
                    <SkillGroupActionItem
                      label={t("i18n.skillGroupEnablePlugin")}
                      disabled={groupBusy}
                      onClick={() => requestAction("enablePlugin")}
                    />
                  )}
                </div>
              )}
            </div>
            {(() => {
              const grpSkills = group.skills;
              const renderSkillRow = (skill: Skill, skillIndex: number) => {
              const isSelected = !addMode && selected === skill.filePath;
              const status = updateKey(skill) ? updateStatuses[updateKey(skill)!] : undefined;
              const diagnosis = getSkillRuntimeDiagnosis(skill, {
                viewScope,
                pluginPackages,
                diagnostics,
                t,
              });
              const currentStateLabel = getSkillCurrentStateLabel(diagnosis, t);
              const listBadge = getSkillListBadge(skill, diagnosis, t);
              const stateDotTone = getSkillStateDotTone(diagnosis);
              const dotColor = stateDotTone === "automatic"
                ? "var(--accent)"
                : stateDotTone === "manual"
                  ? "#f59e0b"
                  : "var(--border)";
              const dotShadow = stateDotTone === "unavailable" ? "none" : `0 0 4px ${dotColor}`;
              const rowTitle = `${currentStateLabel} · ${diagnosis.executionSummary}${listBadge.tone === "advice" ? ` · ${listBadge.label}` : ""}`;
              const showUseAction = isMobile || hoveredSkill === skill.filePath;
              const useSkillLabel = `/skill:${skill.name}`;
              return (
                <div
                  key={skill.filePath}
                  onClick={() => onSelect(skill)}
                  className="config-sidebar-item config-resource-item skills-sidebar-item"
                  style={{
                    position: "relative",
                    gap: 7,
                    borderBottom: skillIndex < group.skills.length - 1 ? "1px solid var(--border)" : "none",
                    background: isSelected ? "rgba(37,99,235,0.14)" : "none",
                    boxShadow: isSelected ? "inset 3px 0 0 #2563eb" : "none",
                    transition: "background 0.12s, box-shadow 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    setHoveredSkill(skill.filePath);
                    if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)";
                  }}
                  onMouseLeave={(e) => {
                    setHoveredSkill((current) => current === skill.filePath ? null : current);
                    if (!isSelected) e.currentTarget.style.background = "none";
                  }}
                  onFocus={() => setHoveredSkill(skill.filePath)}
                  title={rowTitle}
                >
                  <span
                    style={{
                      flexShrink: 0,
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: dotColor,
                      boxShadow: dotShadow,
                    }}
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 5,
                        minWidth: 0,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: isSelected ? 600 : 400,
                          color: isSelected ? "var(--accent)" : diagnosis.runtimeLoaded ? "var(--text)" : "var(--text-dim)",
                          fontFamily: "var(--font-mono)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {skill.name}
                      </span>
                      {slashFavoriteKeys && (slashFavoriteKeys.includes(`skill:skill:${skill.name}`) || slashFavoriteKeys.includes(`skill:${skill.name}`)) && (
                        <span title={t("chat.favorites")} style={{ color: "#eab308", display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
                          <Star size={11} fill="#eab308" strokeWidth={1} />
                        </span>
                      )}
                      {skill.triggerModeSource === "fallback" && (
                        <span role="img" aria-label={t("i18n.skillAnalysisItemFailed")} title={skill.triggerModeReason} style={{ flexShrink: 0, color: "#b45309", fontWeight: 700 }}>!</span>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", marginTop: 2 }}>
                      <span
                        style={{
                          fontSize: 9,
                          padding: "1px 4px",
                          borderRadius: 3,
                          background: listBadge.tone === "advice"
                            ? "rgba(239,68,68,0.12)"
                            : listBadge.tone === "automatic"
                              ? "rgba(37,99,235,0.10)"
                              : listBadge.tone === "manual"
                                ? "rgba(245,158,11,0.12)"
                                : "rgba(120,120,120,0.10)",
                          color: listBadge.tone === "advice"
                            ? "var(--danger, light-dark(#dc2626, #f87171))"
                            : listBadge.tone === "automatic"
                              ? "var(--accent)"
                              : listBadge.tone === "manual"
                                ? "#b45309"
                                : "var(--text-dim)",
                          maxWidth: "100%",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {listBadge.label}
                      </span>
                    </div>
                    {status?.state === "update-available" && (
                      <div style={{ fontSize: 10, color: "#d97706", marginTop: 2 }}>
                        {t("i18n.updateAvailable")}
                      </div>
                    )}
                  </div>
                  {onUseSkill && (
                    <button
                      type="button"
                      title={useSkillLabel}
                      aria-label={useSkillLabel}
                      aria-disabled={!diagnosis.commandUsable}
                      disabled={!diagnosis.commandUsable}
                      onClick={(event) => {
                        event.stopPropagation();
                        onUseSkill(skill.name);
                      }}
                      onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-selected)"; }}
                      onMouseLeave={(event) => { event.currentTarget.style.background = "var(--bg)"; }}
                      style={{
                        position: "absolute",
                        top: "50%",
                        right: 6,
                        transform: "translateY(-50%)",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 28,
                        height: 28,
                        padding: 0,
                        border: "1px solid var(--border)",
                        borderRadius: 5,
                        background: "var(--bg)",
                        color: diagnosis.commandUsable ? "var(--accent)" : "var(--text-dim)",
                        cursor: diagnosis.commandUsable ? "pointer" : "not-allowed",
                        opacity: showUseAction ? 1 : 0,
                        pointerEvents: showUseAction ? "auto" : "none",
                        transition: "opacity 0.12s, background 0.12s",
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{ fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 700, lineHeight: 1 }}
                      >
                        /
                      </span>
                    </button>
                  )}
                </div>
              );
              };
              return !isCollapsed && orderSkillsByDormancy(grpSkills).map(renderSkillRow);
            })()}
          </div>
        );
      })}
    </>
  );
}

export function skillStateEdit(skills: Skill[], state: SkillUseState | "inherit", viewScope: SkillViewScope, cwd: string) {
  return { action: "set_skill_group", cwd, viewScope, state, items: skills.map((skill) => ({ filePath: skill.filePath })) };
}

export function canInheritGlobalSkillState(
  skill: Pick<Skill, "sourceInfo">,
  viewScope: SkillViewScope,
): boolean {
  return viewScope === "project" && skill.sourceInfo?.scope !== "project";
}

export function canInheritGlobalSkillGroupState(
  skills: Array<Pick<Skill, "sourceInfo">>,
  viewScope: SkillViewScope,
): boolean {
  return skills.length > 0 && skills.every((skill) => canInheritGlobalSkillState(skill, viewScope));
}

export function getSkillUseState(skill: Skill, viewScope: SkillViewScope): SkillUseState | "inherit" {
  if (canInheritGlobalSkillState(skill, viewScope) && skill.resourceOverride === "inherit" && !skill.policy?.projectInvocationMode) return "inherit";
  if (skill.resourceState === "disabled" || skill.resourceEnabled === false) return "disabled";
  return skill.invocationMode ?? (skill.disableModelInvocation ? "explicit-only" : "automatic");
}

export function SkillUseStateControl({ skill, viewScope, busy, parentDisabled, onChange, t }: {
  skill: Skill; viewScope: SkillViewScope; busy: boolean; parentDisabled: boolean;
  onChange: (state: SkillUseState | "inherit") => void; t: ReturnType<typeof useI18n>["t"];
}) {
  const selected = getSkillUseState(skill, viewScope);
  const choices = ["automatic", "explicit-only", "disabled", ...(canInheritGlobalSkillState(skill, viewScope) ? ["inherit"] : [])] as (SkillUseState | "inherit")[];
  return <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
    <legend style={{ marginBottom: 6, fontSize: 12, color: "var(--text-muted)" }}>{t("i18n.skillUseState")}</legend>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {choices.map((state) => {
        const disabled = busy || skill.policy?.availability !== "available" || (parentDisabled && (state === "automatic" || state === "explicit-only"));
        return <label key={state} title={t(`i18n.skillUseState.${state}Hint`)} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 9px", borderRadius: 6, border: `1px solid ${selected === state ? "var(--accent)" : "var(--border)"}`, background: selected === state ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "var(--bg-panel)", opacity: disabled ? 0.5 : 1, cursor: disabled ? "not-allowed" : "pointer", fontSize: 12 }}>
          <input type="radio" name={`skill-state-${skill.policyKey}`} value={state} checked={selected === state} disabled={disabled} onChange={() => onChange(state)} />
          {t(`i18n.skillUseState.${state}`)}
        </label>;
      })}
    </div>
    <div style={{ marginTop: 6, color: "var(--text-dim)", fontSize: 11 }}>{t("i18n.skillUseStateHint")}</div>
  </fieldset>;
}

/** Polls may overlap; accept progress only for the job this poll observed. */
export function mergeSkillAnalysisPoll(
  current: SkillAnalysisJob | null,
  next: SkillAnalysisJob,
  expectedJobId: string,
): SkillAnalysisJob | null {
  if (!current || current.id !== expectedJobId) return current;
  if (next.id === current.id && (next.completed < current.completed
    || (current.status !== "running" && next.status === "running"))) return current;
  return next;
}

export function SkillAnalysisStatus({ job, requestError, canRetry, onRetry, t }: {
  job: SkillAnalysisJob | null;
  requestError?: string | null;
  canRetry: boolean;
  onRetry: () => void;
  t: ReturnType<typeof useI18n>["t"];
}) {
  if (!job) return requestError ? <div role="alert" style={{ fontSize: 12, overflowWrap: "anywhere", color: "#b45309" }}>{t("i18n.skillAnalysisStartFailed", { error: requestError })}</div> : null;
  const failures = job.failures ?? [];
  const failureNote = [
    job.error ? t("i18n.skillAnalysisFailed", { error: job.error }) : null,
    job.failed > 0 && failures.length === 0 ? t("i18n.skillAnalysisLegacyFailures") : null,
  ].filter(Boolean).join(" ");
  return (
    <div style={{ minWidth: 0, maxWidth: "100%", flex: "1 1 260px", fontSize: 12, overflowWrap: "anywhere" }}>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span
          role="status"
          title={failureNote || undefined}
          style={{
            color: job.failed ? "#b45309" : "#15803d",
            fontWeight: 500,
            cursor: failureNote ? "help" : undefined,
          }}
        >
          {t("i18n.skillAnalysisResult", { completed: job.completed, total: job.total, succeeded: Math.max(0, job.completed - job.failed), failed: job.failed })}
        </span>
        {failureNote && (
          <span
            tabIndex={0}
            role="note"
            aria-label={failureNote}
            title={failureNote}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 18,
              height: 18,
              borderRadius: 4,
              background: "rgba(245, 158, 11, 0.12)",
              color: "#b45309",
              fontSize: 11,
              cursor: "help",
              border: "1px solid rgba(245, 158, 11, 0.25)",
              userSelect: "none",
              flexShrink: 0,
            }}
          >
            <span aria-hidden="true">⚠️</span>
          </span>
        )}
      </div>
      {requestError && <div role="alert" style={{ marginTop: 4, color: "#b45309" }}>{t("i18n.skillAnalysisStartFailed", { error: requestError })}</div>}
      {failures.length > 0 && (
        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: "pointer", color: "#b45309" }}>{t("i18n.skillAnalysisFailureDetails", { count: failures.length })}</summary>
          <ul style={{ margin: "5px 0", paddingLeft: 18 }}>
            {failures.map((failure) => <li key={failure.filePath} title={failure.filePath}><strong>{failure.name}</strong>: {failure.reason}</li>)}
          </ul>
        </details>
      )}
      {failures.length > 0 && (
        <ConfigButton style={{ marginTop: 4 }} type="button" disabled={!canRetry || job.status === "running"} onClick={onRetry}>
          {t("i18n.skillAnalysisRetryFailed")}
        </ConfigButton>
      )}
    </div>
  );
}

export function SkillsConfig({
  cwd,
  sessionId,
  remotePeer,
  revision = 0,
  onChanged,
  onClose,
  onReloaded,
  embedded = false,
  onOpenFile,
  onUseSkill,
  trust,
}: {
  cwd: string;
  trust?: ProjectTrustStatus | null;
  sessionId?: string | null;
  remotePeer?: string;
  revision?: number;
  onChanged?: () => void;
  onClose: () => void;
  onReloaded?: () => void;
  embedded?: boolean;
  onOpenFile?: (filePath: string) => void;
  onUseSkill?: (skillName: string) => void;
}) {
  const remotePeerRef = useRef(remotePeer);
  remotePeerRef.current = remotePeer;
  const api = (path: string) => apiFor(remotePeerRef.current, path);
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const sidebarResizer = useConfigSidebarResize();
  useEffect(() => {
    notifyEmbeddedModalState(true);
    return () => notifyEmbeddedModalState(false);
  }, []);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [invocationBusy, setInvocationBusy] = useState<Set<string>>(new Set());
  const [stalePolicies, setStalePolicies] = useState<StaleSkillPolicy[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [updateStatuses, setUpdateStatuses] = useState<Record<string, SkillUpdateResult>>({});
  const [checkingUpdates, setCheckingUpdates] = useState<Set<string>>(new Set());
  const [checkingAll, setCheckingAll] = useState(false);
  const [updatingSkill, setUpdatingSkill] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [analysisJob, setAnalysisJob] = useState<SkillAnalysisJob | null>(null);
  const [analysisStartError, setAnalysisStartError] = useState<string | null>(null);
  const analysisRequestRevisionRef = useRef(0);
  const analysisSubmitRef = useRef<SkillsPanelRequest | null>(null);
  const [projectResourcesLoaded, setProjectResourcesLoaded] = useState(true);
  const [pluginPackages, setPluginPackages] = useState<Record<string, PluginPackageState>>({});
  const [viewScope, setViewScope] = useState<SkillViewScope>("global");
  const trustKey = projectTrustReloadKey(trust);
  const panelIdentity = useMemo<SkillsPanelIdentity>(
    () => ({
      cwd,
      viewScope,
      remotePeer: remotePeer ?? null,
      sourceSessionId: sessionId ?? null,
      revision,
      trustKey,
    }),
    [cwd, remotePeer, revision, sessionId, trustKey, viewScope],
  );
  const panelIdentityRef = useRef(panelIdentity);
  panelIdentityRef.current = panelIdentity;
  const requestGenerationRef = useRef(0);
  const requestIdentityRef = useRef<SkillsPanelIdentity | null>(null);
  const capturePanelRequest = useCallback((): SkillsPanelRequest => ({
    identity: panelIdentityRef.current,
    generation: requestGenerationRef.current,
  }), []);
  const isCurrentPanelRequest = useCallback((request: SkillsPanelRequest) => {
    const activeIdentity = requestIdentityRef.current;
    return activeIdentity !== null
      && sameSkillsPanelIdentity(activeIdentity, panelIdentityRef.current)
      && isSkillsPanelRequestCurrent(request, activeIdentity, requestGenerationRef.current);
  }, []);
  const [showAutomatic, setShowAutomatic] = useState(true);
  const [showExplicitOnly, setShowExplicitOnly] = useState(true);
  const [showDisabled, setShowDisabled] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState<ProjectSkillFilter>("different");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [busyGroups, setBusyGroups] = useState<Set<string>>(new Set());
  const [groupSnapshots, setGroupSnapshots] = useState<Record<string, SkillGroupSnapshot>>({});
  const settingsMutationRef = useRef<SkillsPanelRequest | null>(null);
  const [reloadBusy, setReloadBusy] = useState(false);
  const [reloadMessage, setReloadMessage] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<ResourceDiagnostic[]>([]);
  const [skillContentState, setSkillContentState] = useState<SkillContentState | null>(null);

  const SLASH_FAVORITES_STORAGE_KEY = "pi-web:slash-command-favorites:v1";
  const [slashFavoriteCategories, setSlashFavoriteCategories] = useState<SlashFavoriteCategory[]>([]);
  const [slashFavoriteKeys, setSlashFavoriteKeys] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(SLASH_FAVORITES_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (storageError) {
      void storageError;
      return [];
    }
  });

  const loadFavoritesState = useCallback(() => {
    fetch(
      remotePeer
        ? `/api/remote/slash-command-favorites?peer=${encodeURIComponent(remotePeer)}`
        : `/api/slash-command-favorites`,
      { cache: "no-store" },
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { favorites?: { keys?: unknown; categories?: unknown } } | null) => {
        if (!data?.favorites) return;
        if (Array.isArray(data.favorites.categories)) {
          setSlashFavoriteCategories(data.favorites.categories as SlashFavoriteCategory[]);
        }
        if (Array.isArray(data.favorites.keys)) {
          const keys = data.favorites.keys.filter((k): k is string => typeof k === "string");
          setSlashFavoriteKeys(keys);
          try { window.localStorage.setItem(SLASH_FAVORITES_STORAGE_KEY, JSON.stringify(keys)); } catch (storageError) { void storageError; }
        }
      })
      .catch(() => {});
  }, [remotePeer]);

  useEffect(() => {
    loadFavoritesState();
    const onFavoritesChanged = () => {
      loadFavoritesState();
    };
    window.addEventListener("pi-web:slash-command-favorites-changed", onFavoritesChanged);
    return () => {
      window.removeEventListener("pi-web:slash-command-favorites-changed", onFavoritesChanged);
    };
  }, [loadFavoritesState]);

  const changeFavoriteCategory = useCallback((skillName: string, targetCatId: string) => {
    const key = `skill:skill:${skillName}`;
    const legacyKey = `skill:${skillName}`;
    const isMatching = (k: string) => k === key || k === legacyKey;

    setSlashFavoriteCategories((prev) => {
      let currentCategories = prev;
      if (!currentCategories.length) {
        currentCategories = [{ id: DEFAULT_SLASH_FAVORITE_CATEGORY_ID, name: DEFAULT_SLASH_FAVORITE_CATEGORY_NAME, keys: [] }];
      }
      const nextCategories = currentCategories.map((cat) => {
        if (cat.id === targetCatId) {
          const hasKey = cat.keys.some(isMatching);
          return { ...cat, keys: hasKey ? cat.keys : [...cat.keys, key] };
        }
        return { ...cat, keys: cat.keys.filter((k) => !isMatching(k)) };
      });

      const nextKeys = Array.from(new Set(nextCategories.flatMap((c) => c.keys)));
      setSlashFavoriteKeys(nextKeys);
      try { window.localStorage.setItem(SLASH_FAVORITES_STORAGE_KEY, JSON.stringify(nextKeys)); } catch (storageError) { void storageError; }

      window.dispatchEvent(new CustomEvent("pi-web:slash-command-favorites-changed", { detail: { categories: nextCategories, keys: nextKeys } }));
      if (typeof window !== "undefined") {
        if (window.parent !== window) {
          window.parent.postMessage({ type: "pi-web:slash-command-favorites-changed", detail: { categories: nextCategories, keys: nextKeys } }, "*");
        }
        document.querySelectorAll("iframe").forEach((frame) => {
          try { frame.contentWindow?.postMessage({ type: "pi-web:slash-command-favorites-changed", detail: { categories: nextCategories, keys: nextKeys } }, "*"); } catch (dispatchError) { void dispatchError; }
        });
      }

      fetch(
        remotePeer
          ? `/api/remote/slash-command-favorites?peer=${encodeURIComponent(remotePeer)}`
          : `/api/slash-command-favorites`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ categories: nextCategories }),
        },
      ).catch(() => {});

      return nextCategories;
    });
  }, [remotePeer]);

  const toggleSkillFavorite = useCallback((skillName: string) => {
    const key = `skill:skill:${skillName}`;
    const legacyKey = `skill:${skillName}`;
    const isMatching = (k: string) => k === key || k === legacyKey;
    const isFav = slashFavoriteKeys.some(isMatching);

    setSlashFavoriteCategories((prev) => {
      let currentCategories = prev;
      if (!currentCategories.length) {
        currentCategories = [{ id: DEFAULT_SLASH_FAVORITE_CATEGORY_ID, name: DEFAULT_SLASH_FAVORITE_CATEGORY_NAME, keys: [] }];
      }

      let nextCategories: SlashFavoriteCategory[];
      if (isFav) {
        nextCategories = currentCategories.map((cat) => ({
          ...cat,
          keys: cat.keys.filter((k) => !isMatching(k)),
        }));
      } else {
        nextCategories = currentCategories.map((cat, idx) => {
          if (idx === 0) {
            return { ...cat, keys: cat.keys.some(isMatching) ? cat.keys : [...cat.keys, key] };
          }
          return cat;
        });
      }

      const nextKeys = Array.from(new Set(nextCategories.flatMap((c) => c.keys)));
      setSlashFavoriteKeys(nextKeys);
      try { window.localStorage.setItem(SLASH_FAVORITES_STORAGE_KEY, JSON.stringify(nextKeys)); } catch (storageError) { void storageError; }

      window.dispatchEvent(new CustomEvent("pi-web:slash-command-favorites-changed", { detail: { categories: nextCategories, keys: nextKeys } }));
      if (typeof window !== "undefined") {
        if (window.parent !== window) {
          window.parent.postMessage({ type: "pi-web:slash-command-favorites-changed", detail: { categories: nextCategories, keys: nextKeys } }, "*");
        }
        document.querySelectorAll("iframe").forEach((frame) => {
          try { frame.contentWindow?.postMessage({ type: "pi-web:slash-command-favorites-changed", detail: { categories: nextCategories, keys: nextKeys } }, "*"); } catch (dispatchError) { void dispatchError; }
        });
      }

      fetch(
        remotePeer
          ? `/api/remote/slash-command-favorites?peer=${encodeURIComponent(remotePeer)}`
          : `/api/slash-command-favorites`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ categories: nextCategories }),
        },
      ).catch(() => {});

      return nextCategories;
    });
  }, [remotePeer, slashFavoriteKeys]);

  const applySkillsResponse = useCallback((response: SkillsResponse) => {
    const list = response.skills ?? [];
    setSkills(list);
    setStalePolicies(response.stalePolicies ?? []);
    setProjectResourcesLoaded(response.projectResourcesLoaded ?? true);
    setDiagnostics(response.diagnostics ?? []);
    setSelected((current) => {
      if (current && list.some((skill) => skill.filePath === current)) return current;
      return list[0]?.filePath ?? null;
    });
  }, []);

  const loadSkills = useCallback(async (
    showLoading = true,
    requestOverride?: SkillsPanelRequest,
  ) => {
    const request = requestOverride ?? capturePanelRequest();
    const canWrite = () => isCurrentPanelRequest(request);
    if (showLoading && canWrite()) setLoading(true);
    if (canWrite()) setError(null);
    try {
      const { identity } = request;
      const requestApi = (path: string) => apiFor(identity.remotePeer ?? undefined, path);
      const [res, pluginRes] = await Promise.all([
        fetch(requestApi(`skills?cwd=${encodeURIComponent(identity.cwd)}&scope=${identity.viewScope}`)),
        fetch(requestApi(`plugins?cwd=${encodeURIComponent(identity.cwd)}&scope=${identity.viewScope}`)),
      ]);
      if (!canWrite()) return [];
      const d = (await res.json()) as Partial<SkillsResponse> & { error?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      if (!canWrite()) return [];
      const pluginData = (await pluginRes.json()) as Partial<PluginsResponse> & { error?: string };
      if (!pluginRes.ok || pluginData.error) throw new Error(pluginData.error ?? `HTTP ${pluginRes.status}`);
      if (!canWrite()) return [];
      const list = d.skills ?? [];
      setPluginPackages(Object.fromEntries(
        (pluginData.packages ?? []).map((pkg) => [pkg.source, {
          source: pkg.source,
          scope: pkg.scope,
          disabled: pkg.disabled,
        }]),
      ));
      applySkillsResponse({
        skills: list,
        projectResourcesLoaded: d.projectResourcesLoaded ?? true,
        diagnostics: d.diagnostics ?? [],
        stalePolicies: d.stalePolicies ?? [],
      });
      return list;
    } catch (e) {
      if (canWrite()) setError(String(e));
      return [];
    } finally {
      if (showLoading && canWrite()) setLoading(false);
    }
  }, [applySkillsResponse, capturePanelRequest, isCurrentPanelRequest]);

  const fetchAnalysisJob = useCallback(async (
    requestOverride?: SkillsPanelRequest,
  ): Promise<SkillAnalysisJob | null> => {
    const request = requestOverride ?? capturePanelRequest();
    const requestRevision = analysisRequestRevisionRef.current;
    try {
      const { identity } = request;
      const res = await fetch(apiFor(
        identity.remotePeer ?? undefined,
        `skills/analyze?cwd=${encodeURIComponent(identity.cwd)}&scope=${identity.viewScope}`,
      ), {
        cache: "no-store",
      });
      if (!isCurrentPanelRequest(request) || requestRevision !== analysisRequestRevisionRef.current) return null;
      const data = (await res.json()) as { job?: SkillAnalysisJob | null; error?: string };
      if (!isCurrentPanelRequest(request) || requestRevision !== analysisRequestRevisionRef.current) return null;
      if (!res.ok || data.error) return null;
      return data.job ?? null;
    } catch {
      return null;
    }
  }, [capturePanelRequest, isCurrentPanelRequest]);

  const analysisJobId = analysisJob?.id;
  const analysisJobStatus = analysisJob?.status;
  const analysisJobCompleted = analysisJob?.completed ?? 0;
  const analyzingSkills = analysisJobStatus === "running";
  const analysisProgress = analysisJob
    ? { completed: analysisJob.completed, total: analysisJob.total, failed: analysisJob.failed }
    : null;

  useEffect(() => {
    setSelected(null);
    setAddMode(false);
    setUpdateStatuses({});
    setUpdateError(null);
    setAnalysisJob(null);
    setAnalysisStartError(null);
    setInvocationBusy(new Set());
    setStalePolicies([]);
    setProjectFilter(viewScope === "project" ? "different" : "all");
    setCollapsedGroups({});
    setGroupSnapshots({});
  }, [viewScope]);

  useEffect(() => {
    const requestIdentity = panelIdentity;
    const requestGeneration = ++requestGenerationRef.current;
    requestIdentityRef.current = requestIdentity;
    setAnalysisJob(null);
    setAnalysisStartError(null);
    setBusyGroups(new Set());
    setGroupSnapshots({});
    const request: SkillsPanelRequest = {
      identity: requestIdentity,
      generation: requestGeneration,
    };
    let cancelled = false;
    void loadSkills(true, request);
    void fetchAnalysisJob(request).then((job) => {
      if (cancelled || !isCurrentPanelRequest(request)) return;
      setAnalysisJob((current) => current ?? job);
      if (job?.completed) void loadSkills(false, request);
    });
    return () => {
      cancelled = true;
      if (requestGenerationRef.current === requestGeneration) {
        requestGenerationRef.current += 1;
      }
    };
  }, [fetchAnalysisJob, isCurrentPanelRequest, loadSkills, panelIdentity]);

  useEffect(() => {
    if (!analysisJobId || analysisJobStatus !== "running") return;
    let cancelled = false;
    let lastCompleted = analysisJobCompleted;
    const poll = async () => {
      const request = capturePanelRequest();
      const next = await fetchAnalysisJob(request);
      if (cancelled || !isCurrentPanelRequest(request) || !next) return;
      setAnalysisJob((current) => mergeSkillAnalysisPoll(current, next, analysisJobId));
      if (next.completed !== lastCompleted || next.status !== "running") {
        lastCompleted = next.completed;
        void loadSkills(false, request).then(() => {
          if (next.status !== "running") onChanged?.();
        });
      }
    };
    const timer = window.setInterval(() => void poll(), 1200);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    analysisJobCompleted,
    analysisJobId,
    analysisJobStatus,
    capturePanelRequest,
    fetchAnalysisJob,
    isCurrentPanelRequest,
    loadSkills,
  ]);

  const checkForUpdates = useCallback(async (skill?: Skill) => {
    const targets = skill
      ? [skill]
      : skills.filter((item) => Boolean(item.install));
    const keys = targets
      .map(updateKey)
      .filter((key): key is string => Boolean(key));
    if (keys.length === 0) return;

    setUpdateError(null);
    setCheckingUpdates((current) => new Set([...current, ...keys]));
    if (!skill) setCheckingAll(true);
    try {
      const res = await fetch(api("skills/check"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          package: skill?.install?.package,
          scope: skill?.install?.scope,
        }),
      });
      const data = (await res.json()) as {
        updates?: SkillUpdateResult[];
        error?: string;
      };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setUpdateStatuses((current) => {
        const next = { ...current };
        for (const update of data.updates ?? []) {
          next[`${update.scope}\0${update.package}`] = update;
        }
        return next;
      });
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCheckingUpdates((current) => {
        const next = new Set(current);
        for (const key of keys) next.delete(key);
        return next;
      });
      if (!skill) setCheckingAll(false);
    }
  }, [cwd, skills]);

  const updateInstalledSkill = useCallback(async (skill: Skill) => {
    if (!skill.install) return;
    const key = updateKey(skill)!;
    setUpdatingSkill(key);
    setUpdateError(null);
    try {
      const res = await fetch(api("skills/update"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          package: skill.install.package,
          scope: skill.install.scope,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        skill?: Skill;
        error?: string;
      };
      if (!res.ok || data.error || !data.success) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      await loadSkills();
      onChanged?.();
      const versionHash = data.skill?.install?.versionHash;
      setUpdateStatuses((current) => ({
        ...current,
        [key]: {
          package: skill.install!.package,
          scope: skill.install!.scope,
          state: "up-to-date",
          currentVersion: versionHash,
          latestVersion: versionHash,
        },
      }));
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
    } finally {
      setUpdatingSkill(null);
    }
  }, [cwd, loadSkills, onChanged]);

  const pendingAnalysisSkills = useMemo(
    () => skills.filter((skill) =>
      skillIsEnabled(skill, viewScope, pluginPackages)
      && skill.triggerModeSource !== "ai"
      && skill.triggerModeSource !== "frontmatter"
      && !skill.declaresManualInvocation,
    ),
    [pluginPackages, skills, viewScope],
  );

  const failedAnalysisSkills = useMemo(() => {
    const failedPaths = new Set((analysisJob?.failures ?? []).map((failure) => failure.filePath));
    return skills.filter((skill) => failedPaths.has(skill.filePath));
  }, [analysisJob?.failures, skills]);

  const analyzeSkills = useCallback(async (targets: Skill[]) => {
    if (loading || analyzingSkills || targets.length === 0 || !sameSkillsPanelIdentity(panelIdentity, panelIdentityRef.current)) return;
    if (analysisSubmitRef.current && isCurrentPanelRequest(analysisSubmitRef.current)) return;
    const request = capturePanelRequest();
    if (!isCurrentPanelRequest(request)) return;
    analysisSubmitRef.current = request;
    const requestRevision = ++analysisRequestRevisionRef.current;
    setAnalysisStartError(null);
    try {
      const res = await fetch(apiFor(request.identity.remotePeer ?? undefined, "skills/analyze"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: request.identity.cwd,
          scope: request.identity.viewScope,
          filePaths: targets.map((skill) => skill.filePath),
        }),
      });
      const data = (await res.json()) as { job?: SkillAnalysisJob; error?: string };
      if (!isCurrentPanelRequest(request) || requestRevision !== analysisRequestRevisionRef.current) return;
      if (!res.ok || data.error || !data.job) throw new Error(data.error ?? `HTTP ${res.status}`);
      const next = data.job;
      setAnalysisJob((current) => {
        if (!isCurrentPanelRequest(request) || requestRevision !== analysisRequestRevisionRef.current) return current;
        return current?.id === next.id ? mergeSkillAnalysisPoll(current, next, current.id) : next;
      });
    } catch (error) {
      if (!isCurrentPanelRequest(request) || requestRevision !== analysisRequestRevisionRef.current) return;
      setAnalysisStartError(error instanceof Error ? error.message : String(error));
    } finally {
      if (analysisSubmitRef.current === request) analysisSubmitRef.current = null;
    }
  }, [ analyzingSkills, capturePanelRequest, isCurrentPanelRequest, loading, panelIdentity, t]);
  const analyzePendingSkills = useCallback(() => analyzeSkills(pendingAnalysisSkills), [analyzeSkills, pendingAnalysisSkills]);

  const enableParentPlugin = useCallback(async (skill: Skill, confirm = true): Promise<boolean> => {
    const source = skill.sourceInfo.source;
    const pkg = source ? pluginPackages[source] : undefined;
    if (!pkg?.disabled) return false;
    if (confirm && !window.confirm(t("i18n.pluginSkillRequiresPackage"))) return false;

    const request = pluginEnableAction(pkg, viewScope);
    const res = await fetch(api("plugins"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: request.action,
        source: pkg.source,
        scope: request.scope,
        enabled: request.action === "set_project_override" ? true : undefined,
        viewScope,
        cwd,
      }),
    });
    const d = (await res.json()) as { error?: string };
    if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
    return true;
  }, [cwd, pluginPackages, t, viewScope]);

  const changeSkillState = useCallback(async (targets: Skill[], state: SkillUseState | "inherit" | "restore", groupKey?: string) => {
    const request = capturePanelRequest();
    if (!isCurrentPanelRequest(request) || targets.length === 0 || (settingsMutationRef.current && isCurrentPanelRequest(settingsMutationRef.current))) return;
    const restore = state === "restore" && groupKey ? groupSnapshots[groupKey] : undefined;
    if (state === "restore" && !restore) return;
    settingsMutationRef.current = request;
    if (groupKey) setBusyGroups((current) => new Set(current).add(groupKey));
    else setInvocationBusy(new Set(targets.map((skill) => skill.filePath)));
    setSaveError(null);
    const { identity } = request;
    try {
      const body = restore
        ? { action: "set_skill_group", cwd: identity.cwd, viewScope: identity.viewScope, items: restore.map((snapshot) => ({ filePath: snapshot.filePath })), restore }
        : skillStateEdit(targets, state as SkillUseState | "inherit", identity.viewScope, identity.cwd);
      const response = await fetch(apiFor(identity.remotePeer ?? undefined, "skills"), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json() as SkillsResponse & { snapshots?: SkillStateSnapshot[]; error?: string };
      if (!isCurrentPanelRequest(request)) return;
      if (!response.ok || result.error || !Array.isArray(result.snapshots)) throw new Error(result.error ?? `HTTP ${response.status}`);
      applySkillsResponse(result);
      if (groupKey) setGroupSnapshots((current) => {
        const next = { ...current };
        if (restore) delete next[groupKey];
        else next[groupKey] = result.snapshots!;
        return next;
      });
      onChanged?.();
    } catch (error) {
      if (isCurrentPanelRequest(request)) setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      if (settingsMutationRef.current === request) settingsMutationRef.current = null;
      if (isCurrentPanelRequest(request)) {
        setInvocationBusy(new Set());
        if (groupKey) setBusyGroups((current) => { const next = new Set(current); next.delete(groupKey); return next; });
      }
    }
  }, [applySkillsResponse, capturePanelRequest, groupSnapshots, isCurrentPanelRequest, onChanged]);

  const requestGroupAction = useCallback(async (group: SkillGroup, action: SkillGroupAction) => {
    const request = capturePanelRequest();
    if (!isCurrentPanelRequest(request) || (settingsMutationRef.current && isCurrentPanelRequest(settingsMutationRef.current))) return;
    if (action !== "enablePlugin") return changeSkillState(group.skills, action, group.key);
    settingsMutationRef.current = request;
    setBusyGroups((current) => new Set(current).add(group.key));
    try {
      const target = group.skills.find((skill) => isPluginDisabledForSkill(skill, pluginPackages));
      if (target && await enableParentPlugin(target, false) && isCurrentPanelRequest(request)) {
        await loadSkills(false, request);
        if (isCurrentPanelRequest(request)) onChanged?.();
      }
    } catch (error) {
      if (isCurrentPanelRequest(request)) setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      if (settingsMutationRef.current === request) settingsMutationRef.current = null;
      if (isCurrentPanelRequest(request)) setBusyGroups((current) => { const next = new Set(current); next.delete(group.key); return next; });
    }
  }, [capturePanelRequest, changeSkillState, enableParentPlugin, isCurrentPanelRequest, loadSkills, onChanged, pluginPackages]);

  const reloadAllSessions = useCallback(async () => {
    setReloadBusy(true);
    setSaveError(null);
    setReloadMessage(null);
    try {
      const result = await reloadAllAgentSessions(remotePeerRef.current);
      onReloaded?.();
      await loadSkills();
      if (result.liveSessions === 0) {
        setReloadMessage(t("i18n.noLiveSessions"));
      } else {
        setReloadMessage(t("i18n.reloadAllSessionsResult", {
          reloaded: result.reloadedSessions,
          total: result.liveSessions,
        }));
      }
      if (result.busySessionIds.length || result.failedSessionIds.length) {
        setSaveError(t("i18n.reloadAllSessionsPartial", {
          busy: result.busySessionIds.length,
          failed: result.failedSessionIds.length,
        }));
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setReloadBusy(false);
    }
  }, [loadSkills, onReloaded, t]);

  const filterableSkills = useMemo(
    () => filterSkillsForProjectStatusCounts(skills, {
      searchQuery,
      showAutomatic,
      showExplicitOnly,
      showDisabled,
      viewScope,
      pluginPackages,
    }),
    [pluginPackages, searchQuery, showAutomatic, showDisabled, showExplicitOnly, skills, viewScope],
  );
  const pendingAnalysisCount = pendingAnalysisSkills.length;
  const displayedAnalysisJob = useMemo(() => {
    if (!analysisJob) return null;
    if (analysisJob.status === "running") return analysisJob;
    if (analysisJob.status === "completed" && pendingAnalysisCount > 0) {
      return null;
    }
    return analysisJob;
  }, [analysisJob, pendingAnalysisCount]);
  const projectFilterCounts = useMemo(
    () => projectSkillFilterCounts(filterableSkills),
    [filterableSkills],
  );

  const visibleSkills = useMemo(
    () => viewScope !== "project"
      ? filterableSkills
      : filterableSkills.filter((skill) => isProjectSkillVisible(skill, projectFilter)),
    [filterableSkills, projectFilter, viewScope],
  );

  const groupedSkills = useMemo<SkillGroup[]>(() => {
    const local = sortSkillsByName(visibleSkills.filter((skill) => !skillIsPlugin(skill) && !skill.install?.skillsShUrl));
    const skillsSh = sortSkillsByName(visibleSkills.filter((skill) => !skillIsPlugin(skill) && Boolean(skill.install?.skillsShUrl)));
    const pluginGroups = new Map<string, Skill[]>();
    for (const skill of visibleSkills) {
      if (!skillIsPlugin(skill)) continue;
      const source = skill.sourceInfo.source ?? "unknown plugin";
      const group = pluginGroups.get(source) ?? [];
      group.push(skill);
      pluginGroups.set(source, group);
    }
    const groups: SkillGroup[] = [];
    if (local.length > 0) groups.push({ key: "local", label: t("i18n.localSkills"), skills: local });
    if (skillsSh.length > 0) groups.push({ key: "skills-sh", label: t("i18n.skillsShSkills"), skills: skillsSh });
    for (const [source, groupSkills] of [...pluginGroups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      groups.push({
        key: `plugin:${source}`,
        label: pluginSkillGroupLabel(source),
        title: source,
        skills: sortSkillsByName(groupSkills),
      });
    }
    return groups;
  }, [visibleSkills, t]);

  useEffect(() => {
    if (addMode) return;
    const next = selectVisibleSkillPath(visibleSkills, selected);
    setSelected((current) => current === next ? current : next);
  }, [addMode, selected, visibleSkills]);

  const selectedSkillPath = selectVisibleSkillPath(visibleSkills, selected);
  const selectedSkill = visibleSkills.find((skill) => skill.filePath === selectedSkillPath) ?? null;

  useEffect(() => {
    if (!selectedSkillPath) {
      setSkillContentState(null);
      return;
    }

    // This effect is declared after the panel identity effect above, so the
    // request captures the generation that was assigned to this panel view.
    const request = capturePanelRequest();
    const controller = new AbortController();
    setSkillContentState({ filePath: selectedSkillPath, content: null, loading: true, error: null });

    const params = new URLSearchParams({
      cwd: request.identity.cwd,
      filePath: selectedSkillPath,
      scope: request.identity.viewScope,
      revision: String(request.identity.revision),
      generation: String(request.generation),
    });
    if (request.identity.sourceSessionId) params.set("sessionId", request.identity.sourceSessionId);
    if (request.identity.trustKey) params.set("trustKey", request.identity.trustKey);

    void fetch(
      apiFor(request.identity.remotePeer ?? undefined, `skills/content?${params.toString()}`),
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => {
        const data = await response.json() as { content?: unknown; error?: string };
        if (!response.ok || data.error || typeof data.content !== "string") {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
        if (controller.signal.aborted || !isCurrentPanelRequest(request)) return;
        setSkillContentState({ filePath: selectedSkillPath, content: data.content, loading: false, error: null });
      })
      .catch((error) => {
        if (controller.signal.aborted || !isCurrentPanelRequest(request)) return;
        setSkillContentState({
          filePath: selectedSkillPath,
          content: null,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return () => controller.abort();
  }, [capturePanelRequest, isCurrentPanelRequest, panelIdentity, selectedSkillPath]);

  const skillContent = (
      <div
        style={{
          width: isMobile ? "calc(100vw - 16px)" : (embedded ? "100%" : 860),
          maxWidth: embedded ? "100%" : "calc(100vw - 16px)",
          height: isMobile ? "calc(100dvh - 16px)" : (embedded ? "100%" : "78vh"),
          maxHeight: embedded ? "100%" : "calc(100dvh - 16px)",
          background: "var(--bg)",
          border: embedded ? "none" : "1px solid var(--border)",
          borderRadius: embedded ? 0 : 10,
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
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span
              style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}
            >
               {t("common.skills")}
            </span>
            <code
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                maxWidth: 320,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {shortenPath(cwd)}
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
            <ScopeTabs
              value={viewScope}
              projectResourcesLoaded={projectResourcesLoaded}
              onChange={(scope) => {
                setViewScope(scope);
                setAddMode(false);
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
                title={viewScope === "global" ? "~/.pi/agent/settings.json" : (cwd ? `${cwd}/.pi/settings.json` : ".pi/settings.json")}
              >
                {viewScope === "global" ? "~/.pi/agent/settings.json" : (cwd ? `${cwd}/.pi/settings.json` : ".pi/settings.json")}
              </code>
            )}
            {onOpenFile && (
              <button
                type="button"
                onClick={() => onOpenFile(viewScope === "global" ? "~/.pi/agent/settings.json" : (cwd ? `${cwd}/.pi/settings.json` : ".pi/settings.json"))}
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
            {t("trust.skillsNotLoaded")}
          </div>
        )}

        {stalePolicies.length > 0 && (
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
              {t("i18n.skillStalePoliciesTitle", { count: stalePolicies.length })}
            </div>
            <div>{t("i18n.skillStalePoliciesHint")}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 4 }}>
              {stalePolicies.map((policy) => (
                <div key={`${policy.scope}:${policy.policyKey}`} style={{ fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
                  [{policy.scope}/{policy.availability}] {policy.policyKey}
                  {policy.staleReason ? ` · ${policy.staleReason}` : ""}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", overflow: "hidden" }}>
          {/* Left: skill list */}
          <div
            ref={sidebarResizer.panelRef}
            className="config-sidebar config-resource-sidebar"
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
                  active={showAutomatic}
                  label={t("i18n.skillUseState.automatic")}
                  title={t("i18n.skillUseState.automaticHint")}
                  onToggle={() => setShowAutomatic((current) => !current)}
                />
                <FilterButton
                  active={showExplicitOnly}
                  label={t("i18n.skillUseState.explicit-only")}
                  title={t("i18n.skillUseState.explicit-onlyHint")}
                  onToggle={() => setShowExplicitOnly((current) => !current)}
                />
                <FilterButton
                  active={showDisabled}
                  label={t("i18n.skillUseState.disabled")}
                  title={t("i18n.skillUseState.disabledHint")}
                  onToggle={() => setShowDisabled((current) => !current)}
                />
              </div>
            </div>
            <div className="config-sidebar-list config-resource-list" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {loading ? (
                <div
                  style={{
                    padding: "10px 8px",
                    fontSize: 12,
                    color: "var(--text-muted)",
                  }}
                >
                   {t("i18n.loading")}
                </div>
              ) : error ? (
                <div
                  style={{
                    padding: "10px 8px",
                    fontSize: 11,
                    color: "#f87171",
                  }}
                >
                  {error}
                </div>
              ) : groupedSkills.length === 0 ? (
                <div
                  style={{
                    padding: "10px 8px",
                    fontSize: 11,
                    color: "var(--text-dim)",
                  }}
                >
                  {skills.length === 0 ? t("i18n.noSkills") : viewScope === "project" && projectFilter === "different" && projectFilterCounts.different === 0 ? (
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
                  ) : t("i18n.noVisibleSkills")}
                </div>
              ) : (
                <SkillGroupList
                  diagnostics={diagnostics}
                  groups={groupedSkills}
                  slashFavoriteKeys={slashFavoriteKeys}
                  selected={selected}
                  addMode={addMode}
                  updateStatuses={updateStatuses}
                  viewScope={viewScope}
                  pluginPackages={pluginPackages}
                  collapsed={collapsedGroups}
                  busyGroups={busyGroups}
                  settingsBusy={invocationBusy.size > 0 || busyGroups.size > 0}
                  restoreAvailable={new Set(Object.keys(groupSnapshots))}
                  onToggleGroup={(groupKey) => setCollapsedGroups((current) => ({
                    ...current,
                    [groupKey]: !(current[groupKey] ?? true),
                  }))}
                  onRequestGroupAction={requestGroupAction}
                  onSelect={(skill) => {
                    setSelected(skill.filePath);
                    setAddMode(false);
                    setSaveError(null);
                  }}
                  onUseSkill={onUseSkill}
                />
              )}
            </div>
            {/* Add skill button */}
            <div
              className="config-list-action"
              style={{
                flexShrink: 0,
              }}
            >
              <div
                onClick={() => setAddMode(true)}
                className="config-list-action-button"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  background: addMode ? "var(--bg-selected)" : "none",
                  color: addMode ? "var(--accent)" : "var(--text-dim)",
                }}
                onMouseEnter={(e) => {
                  if (!addMode)
                    e.currentTarget.style.background = "var(--bg-hover)";
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
                 {t("i18n.addSkill")}
              </div>
            </div>
          </div>

          {!isMobile && (
            <div
              {...sidebarResizer.separatorProps}
              className={`panel-resize-handle config-sidebar-resize-handle${sidebarResizer.isResizing ? " is-resizing" : ""}`}
              title={`${t("layout.resizeSidebar")}: ${t("layout.resizeHint")}`}
            />
          )}

          {/* Right: detail or add panel */}
          <div style={{ flex: 1, overflowY: "auto", padding: "var(--config-detail-padding-top) 20px 20px" }}>
            {addMode ? (
              <AddSkillPanel
                cwd={cwd}
                peer={remotePeer}
                scope={viewScope}
                installedPackages={{
                  global: new Set(
                    skills
                      .filter((skill) => skill.install?.scope === "global")
                      .map((skill) => skill.install!.package),
                  ),
                  project: new Set(
                    skills
                      .filter((skill) => skill.install?.scope === "project")
                      .map((skill) => skill.install!.package),
                  ),
                }}
                onInstalled={() => {
                  void loadSkills();
                }}
              />
            ) : loading ? null : selectedSkill ? (
              <SkillDetail
                key={selectedSkill.filePath}
                skill={selectedSkill}
                cwd={cwd}
                slashFavoriteKeys={slashFavoriteKeys}
                slashFavoriteCategories={slashFavoriteCategories}
                onToggleFavorite={toggleSkillFavorite}
                onChangeFavoriteCategory={changeFavoriteCategory}
                onSetState={(skill, state) => void changeSkillState([skill], state)}
                invocationBusy={invocationBusy.size > 0 || busyGroups.size > 0}
                saveError={saveError}
                updateStatus={
                  updateKey(selectedSkill)
                    ? updateStatuses[updateKey(selectedSkill)!]
                    : undefined
                }
                checkingUpdate={
                  updateKey(selectedSkill)
                    ? checkingUpdates.has(updateKey(selectedSkill)!)
                    : false
                }
                updating={updatingSkill === updateKey(selectedSkill)}
                updateError={updateError}
                onCheckUpdate={() => void checkForUpdates(selectedSkill)}
                onUpdate={() => void updateInstalledSkill(selectedSkill)}
                viewScope={viewScope}
                pluginPackages={pluginPackages}
                onReloadAllSessions={() => void reloadAllSessions()}
                reloadBusy={reloadBusy}
                reloadMessage={reloadMessage}
                sessionId={sessionId ?? null}
                remotePeer={remotePeer}
                skillContent={skillContentState}
                diagnostics={diagnostics}
                onOpenFile={onOpenFile}
                onUseSkill={onUseSkill}
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
                 {t("i18n.selectSkill")}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <ConfigFooter
          status={<div className="config-footer-status-actions">
            {skills.some((skill) => Boolean(skill.install)) && (
              <ConfigButton
                onClick={() => void checkForUpdates()}
                disabled={checkingAll || updatingSkill !== null}
              >
                 {checkingAll ? t("i18n.checking") : t("i18n.checkUpdates")}
              </ConfigButton>
            )}
            {(analyzingSkills || pendingAnalysisCount > 0) && (
              <ConfigButton style={{ minWidth: 148 }}
                type="button"
                onClick={() => void analyzePendingSkills()}
                disabled={loading || analyzingSkills || checkingAll || updatingSkill !== null}
                title={t("i18n.analyzePendingSkillsTitle")}
              >
                <Sparkles size={14} strokeWidth={2} />
                {analyzingSkills && analysisProgress
                  ? t("i18n.skillAnalysisProgress", analysisProgress)
                  : t("i18n.analyzePendingSkills", { count: pendingAnalysisCount })}
              </ConfigButton>
            )}
            <SkillAnalysisStatus
              job={displayedAnalysisJob}
              requestError={analysisStartError}
              canRetry={!loading && !analyzingSkills && !checkingAll && updatingSkill === null && failedAnalysisSkills.length > 0}
              onRetry={() => void analyzeSkills(failedAnalysisSkills)}
              t={t}
            />
            {Object.values(updateStatuses).filter(
              (status) => status.state === "update-available",
            ).length > 0 && (
              <span style={{ fontSize: 12, color: "#d97706" }}>
                {
                  Object.values(updateStatuses).filter(
                    (status) => status.state === "update-available",
                  ).length
                }{" "}
                {Object.values(updateStatuses).filter(
                  (status) => status.state === "update-available",
                ).length === 1
                   ? t("i18n.update")
                   : t("i18n.updates")}
              </span>
            )}
          </div>}
        >
          <ConfigPanelRefreshButton
            disabled={loading}
            onRefresh={() => void loadSkills()}
          />
          <ConfigButton onClick={onClose}>{t("i18n.close")}</ConfigButton>
        </ConfigFooter>
      </div>
  );

  return (
    <>
      {embedded ? (
        skillContent
      ) : (
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
          {skillContent}
        </div>
      )}

    </>
  );
}
