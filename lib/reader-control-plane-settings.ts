import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DefaultPackageManager, getAgentDir, SettingsManager, type PackageSource } from "@earendil-works/pi-coding-agent";
import { PROJECT_SETTINGS_MAX_BYTES, readRegularFileText } from "./regular-file";
import { samePath } from "./paths";
import { getGlobalSettingsPath, updateGlobalSettings, defaultToolEntries } from "./global-settings-file";
import { codemodePreferenceOf, codemodeModeOf, codemodeInlineBudgetOf, isCodemodePreference, isCodemodeMode, isCodemodeInlineBudget, withCodemodePreference, projectCodemodePreference, projectCodemodeMode, projectCodemodeInlineBudget } from "./codemode-settings";
import { isThinkingLevel, shadowingProjectKeys, writeDefaultPreferences, type DefaultPreferencesEdit } from "./default-preferences";
import { buildEnabledModelsInput, modelRef, resyncEnabledModels } from "./enabled-models-runtime";
import { clearEnabledModels, pruneStaleEnabledModels, setModelsEnabled, type ProviderRename } from "./enabled-models";
import { getReadOnlyModelRuntime } from "./session-context-usage";
import { resolveVisibleModels } from "./model-scope";
import { invalidateModelsCache } from "./models-cache";
import { getProjectTrustStatus } from "./project-trust";
import { loadSkillsWithInstallInfo } from "./skills-service";
import { GLOBAL_SKILL_INVOCATION_MODES_SETTING, PROJECT_SKILL_INVOCATION_MODES_SETTING, updateModeMap } from "./skill-policy";
import { clearGlobalPluginSkillFilter, setGlobalPluginSkillFilter } from "./plugin-overrides";
import { clearGlobalTopLevelSkillOverride, clearProjectPackageOverride, clearProjectPackageResourceOverride, clearProjectTopLevelOverride, setGlobalTopLevelSkillOverride, setProjectPackageOverride, setProjectPackageResourceOverride, setProjectTopLevelOverride } from "./project-resource-policy";
import { getPluginPackageIdentity } from "./plugin-project-status";
import { isDisabledPackage, packageSource, setPackageEntryDisabled } from "./plugin-package-state";
import { isDisabledPluginPackage } from "./skill-state-settings";
import { topLevelExtensionPattern, updateTopLevelExtensionPaths } from "./top-level-extension-resources";
import { editMcpConfigFile, ownServerEntry, parseMcpConfigDocument, patchMcpServerEntry, insertMcpServerEntry, type McpConfigFileTarget } from "./mcp-config-file";
import { isMcpExposure } from "./mcp-import";
import { prepareMcpAdd } from "./mcp-add";
import { mcpInternalsOrRefusal, isMcpEntryRefusal } from "./mcp-entry-request";
import { isMcpDisabledByOperator } from "./builtin-extensions";
import { findWebPasswordField } from "./mcp-transport";
import { holdRemovedEntry, peekRemovedEntry, takeRemovedEntry, returnRemovedEntry, type McpRemovedEntry, type McpHeldRemoval } from "./mcp-undo";
import type { PiSdkInternals } from "./pi-sdk-internals";
import { readModelsConfig, updateModelsConfig, getModelsConfigPath } from "./models-config-store";
import type { SkillInfo } from "./api-types";
import { PROFILE_OPERATIONS, inspectManagedProfiles, validateManagedProfileChange, mutateManagedProfiles } from "./reader-control-plane-profiles";
import { RESOURCE_SETTINGS_OPERATIONS, inspectResourceSettings, mutateResourceSettings, validateResourceSettingsChange } from "./reader-control-plane-resources";

type JsonObject = Record<string, unknown>;
export type ReaderSettingsScope = "global" | "project";
export interface ReaderSettingsTarget { area: string; scope: ReaderSettingsScope; cwd?: string }
export interface ReaderSettingsSnapshot {
  revision: string;
  value: unknown;
  impact: { scope: ReaderSettingsScope; runtime: "new_sessions" | "next_turn" | "none"; restartRequired: false; undo?: { id: string; expiresAt: number } };
  supportedOperations: string[];
  changed?: boolean;
}
export class ReaderSettingsError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly revision?: string) { super(message); this.name = "ReaderSettingsError"; }
}

export const READER_SETTINGS_OPERATIONS: Record<string, readonly string[]> = {
  ...RESOURCE_SETTINGS_OPERATIONS,
  subagent_profiles: PROFILE_OPERATIONS,
  models_default: ["set_default"],
  models_enabled: ["set_models", "set_provider", "clear", "prune", "resync"],
  models_config: ["set_model_metadata"],
  tools_settings: ["set_codemode", "set_codemode_mode", "set_codemode_inline_budget"],
  skills_policy: ["set_skill_invocation_mode", "clear_skill_invocation_mode", "set_global_skill_resource", "clear_global_skill_resource", "set_project_resource", "clear_project_resource", "set_plugin_skill", "clear_plugin_skill"],
  plugins: ["enable", "disable", "set_project_override", "clear_project_override", "set_top_level_extension", "clear_top_level_extension"],
  mcp: ["enable", "disable", "remove", "set_enabled", "set_exposure", "add", "undo"],
  compaction: ["set_enabled"],
};
const PROJECT_AREAS = new Set(["skills_policy", "plugins", "mcp", "tools_settings", "subagent_profiles"]);
const CONTEXT_AREAS = new Set(["models_default", "models_enabled", "skills_policy", "plugins", "subagent_profiles"]);
const MAX_ITEMS = 500;

function object(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function fail(code: string, message: string, status = 400): never { throw new ReaderSettingsError(code, message, status); }
function text(value: unknown, key: string, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) fail("invalid_changes", `${key} must be a non-empty bounded string`);
  return value;
}
function bool(value: unknown, key: string): boolean { if (typeof value !== "boolean") fail("invalid_changes", `${key} must be boolean`); return value; }
function strings(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) fail("invalid_changes", `${key} must be a bounded string array`);
  return value.map((item) => text(item, key, 1024));
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  return object(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
}
function revision(target: ReaderSettingsTarget, value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable({ area: target.area, scope: target.scope, cwd: target.cwd, value }))).digest("hex");
}
function requireRevision(target: ReaderSettingsTarget, current: unknown, expected: string): void {
  const actual = revision(target, current);
  if (expected !== actual) throw new ReaderSettingsError("revision_conflict", "Reader configuration changed; inspect before retrying", 409, actual);
}
function readDocument(path: string): JsonObject {
  const raw = readRegularFileText(path, PROJECT_SETTINGS_MAX_BYTES);
  if (raw === undefined) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return fail("configuration_unreadable", "Configuration JSON is invalid", 409); }
  if (!object(parsed)) fail("configuration_unreadable", "Configuration must contain an object", 409);
  return parsed;
}
/** Pin a managed write before any asynchronous business discovery or lock wait. */
function pinProjectWrite(target: Required<ReaderSettingsTarget>, file: string): { path: string; validate: () => string } {
  const resolvePath = () => {
    if (!existsSync(dirname(file))) fail("scope_uninitialized", "Configuration scope must already exist before a managed write", 409);
    return existsSync(file) ? realpathSync(file) : join(realpathSync(dirname(file)), basename(file));
  };
  const pinned = resolvePath();
  const validate = () => {
    if (realpathSync(target.cwd) !== target.cwd || resolvePath() !== pinned) fail("scope_path_changed", "Project configuration target changed before write", 409);
    requireProjectTrust(target);
    return pinned;
  };
  return { path: pinned, validate };
}
async function normalizeTarget(input: ReaderSettingsTarget): Promise<Required<ReaderSettingsTarget>> {
  if (!Object.hasOwn(READER_SETTINGS_OPERATIONS, input.area)) fail("unsupported_area", "Unsupported Reader settings area", 400);
  if (input.scope !== "global" && input.scope !== "project") fail("unsupported_scope", "scope must be global or project");
  if (input.scope === "project" && !PROJECT_AREAS.has(input.area)) fail("unsupported_scope", "This Reader setting is device-wide", 400);
  if ((input.scope === "project" || CONTEXT_AREAS.has(input.area)) && !input.cwd) fail("cwd_required", "An exact cwd is required");
  const cwd = realpathSync(input.cwd ?? getAgentDir());
  if (!statSync(cwd).isDirectory()) fail("cwd_invalid", "cwd must be an existing directory");
  return { area: input.area, scope: input.scope, cwd };
}
function settingsPath(target: Required<ReaderSettingsTarget>): string {
  return target.scope === "global" ? getGlobalSettingsPath() : join(target.cwd, ".pi", "settings.json");
}
function requireProjectTrust(target: Required<ReaderSettingsTarget>): void {
  if (target.scope !== "project") return;
  const trust = getProjectTrustStatus(target.cwd, getAgentDir());
  if (trust.decisionError !== undefined) fail("project_trust_unreadable", "The existing project trust decision cannot be read", 409);
  // A fresh folder may report trusted=true until settings.json exists. A
  // managed write must never manufacture a new trust-requiring scope there.
  if (trust.decision !== true) fail("project_untrusted", "An existing explicit or inherited project trust decision is required", 403);
}
function snapshot(target: ReaderSettingsTarget, document: JsonObject, value: unknown): ReaderSettingsSnapshot {
  return { revision: revision(target, document), value, supportedOperations: [...READER_SETTINGS_OPERATIONS[target.area]], impact: { scope: target.scope, runtime: ["models_config", "models_default", "models_enabled", "tools_settings"].includes(target.area) ? "new_sessions" : "next_turn", restartRequired: false } };
}
function safePackage(entry: PackageSource): unknown {
  return typeof entry === "string" ? { source: entry, disabled: false } : {
    source: entry.source, disabled: isDisabledPackage(entry),
    ...Object.fromEntries(["extensions", "skills", "prompts", "themes"].filter((key) => Array.isArray((entry as unknown as JsonObject)[key])).map((key) => [key, (entry as unknown as JsonObject)[key]])),
  };
}
function projection(target: ReaderSettingsTarget, document: JsonObject): unknown {
  switch (target.area) {
    case "models_default": return { provider: document.defaultProvider ?? null, modelId: document.defaultModel ?? null, thinkingLevel: document.defaultThinkingLevel ?? null };
    case "models_enabled": return { patterns: document.enabledModels ?? null };
    case "tools_settings": {
      const raw = { codemode: codemodePreferenceOf(defaultToolEntries(document)), codemodeMode: codemodeModeOf(document), codemodeInlineBudget: codemodeInlineBudgetOf(document) };
      if (target.scope === "global") return raw;
      const globalDocument = readDocument(getGlobalSettingsPath());
      const projectText = JSON.stringify(document);
      const trusted = getProjectTrustStatus(target.cwd!, getAgentDir()).decision === true;
      const manager = SettingsManager.fromStorage({ withLock(scope, read) { read(JSON.stringify(scope === "global" ? globalDocument : document)); } }, { projectTrusted: trusted });
      const errors = manager.drainErrors();
      if (errors.length) fail("configuration_unreadable", "Settings cannot be merged by the SDK", 409);
      const effective = { codemode: manager.getSettings().codemode };
      return { codemode: codemodePreferenceOf(manager.getDefaultTools()), codemodeMode: codemodeModeOf(effective), codemodeInlineBudget: codemodeInlineBudgetOf(effective), raw,
        inherited: { codemode: projectCodemodePreference(projectText) === undefined, codemodeMode: projectCodemodeMode(projectText) === undefined, codemodeInlineBudget: projectCodemodeInlineBudget(projectText) === undefined }, projectResourcesLoaded: trusted };
    }
    case "compaction": return { enabled: object(document.compaction) ? document.compaction.enabled !== false : true };
    case "plugins": return { packages: Array.isArray(document.packages) ? (document.packages as PackageSource[]).map(safePackage) : [], extensions: document.extensions ?? [], explicit: document.piWebProjectPluginExplicitStates ?? {} };
    case "skills_policy": return { invocationModes: document[target.scope === "global" ? GLOBAL_SKILL_INVOCATION_MODES_SETTING : PROJECT_SKILL_INVOCATION_MODES_SETTING] ?? {}, resources: document.skills ?? [] };
    case "mcp": return { servers: object(document.mcpServers) ? Object.entries(document.mcpServers).map(([name, entry]) => ({ name, valid: object(entry), enabled: object(entry) && entry.enabled !== false, exposure: object(entry) && isMcpExposure(entry.exposure) ? entry.exposure : "codemode", transport: object(entry) && typeof entry.url === "string" ? "http" : "stdio" })) : [] };
    case "models_config": return { providers: object(document.providers) ? Object.entries(document.providers).map(([provider, entry]) => ({ provider, models: object(entry) && Array.isArray(entry.models) ? entry.models.filter(object).map((model) => ({ id: typeof model.id === "string" ? model.id : null, name: typeof model.name === "string" ? model.name : null, defaultThinkingLevel: typeof model.defaultThinkingLevel === "string" ? model.defaultThinkingLevel : null })) : [] })) : [] };
    default: return {};
  }
}
function mcpPath(target: Required<ReaderSettingsTarget>): string { return target.scope === "global" ? join(getAgentDir(), "mcp.json") : join(target.cwd, ".pi", "mcp.json"); }
function readMcpDocument(target: Required<ReaderSettingsTarget>): JsonObject { const path = mcpPath(target); return parseMcpConfigDocument(readRegularFileText(path, PROJECT_SETTINGS_MAX_BYTES), path); }

export async function inspectSettings(input: ReaderSettingsTarget): Promise<ReaderSettingsSnapshot> {
  const target = await normalizeTarget(input);
  if (target.area === "subagent_profiles") return inspectManagedProfiles(target);
  if (Object.hasOwn(RESOURCE_SETTINGS_OPERATIONS, target.area)) return inspectResourceSettings(target);
  const document = target.area === "mcp" ? readMcpDocument(target) : target.area === "models_config" ? readModelsConfig() : readDocument(settingsPath(target));
  let value = projection(target, document);
  if (target.area === "skills_policy") {
    const catalog = await loadSkillsWithInstallInfo(target.cwd, target.scope, { readOnly: true });
    if (revision(target, readDocument(settingsPath(target))) !== revision(target, document)) fail("snapshot_changed", "Configuration changed during Skill discovery", 409);
    value = { ...(value as JsonObject), truncated: catalog.skills.length > MAX_ITEMS, skills: catalog.skills.slice(0, MAX_ITEMS).map((skill) => ({ name: skill.name, resourceId: resourceId(target, "skill", skill.filePath), policyKey: skill.policyKey, filePath: skill.filePath, source: skill.sourceInfo.source, resourceKey: skill.pluginResourceKey, resourceEnabled: skill.resourceEnabled, invocationMode: skill.invocationMode, policy: skill.policy })), projectResourcesLoaded: catalog.projectResourcesLoaded };
  }
  if (target.area === "plugins") {
    const resources = await pluginResources(target);
    if (revision(target, readDocument(settingsPath(target))) !== revision(target, document)) fail("snapshot_changed", "Configuration changed during plugin discovery", 409);
    value = { ...(value as JsonObject), resources: resources.map(({ resourceId, kind, sourceScope, name }) => ({ resourceId, kind, sourceScope, name })) };
  }
  return snapshot(target, document, value);
}

/** Run existing SettingsManager business editors in memory inside the real file's lock. */
async function editWithManager(target: Required<ReaderSettingsTarget>, document: JsonObject, edit: (manager: SettingsManager) => Promise<void> | void): Promise<void> {
  const globalPath = getGlobalSettingsPath();
  const projectPath = join(target.cwd, ".pi", "settings.json");
  const documents = { global: target.scope === "global" ? structuredClone(document) : readDocument(globalPath), project: target.scope === "project" ? structuredClone(document) : readDocument(projectPath) };
  const storage: Parameters<typeof SettingsManager.fromStorage>[0] & { globalSettingsPath: string; projectSettingsPath: string } = {
    globalSettingsPath: globalPath, projectSettingsPath: projectPath,
    withLock: (scope, fn) => {
      const next = fn(JSON.stringify(documents[scope]));
      if (typeof next === "string") {
        if (scope !== target.scope) fail("scope_mismatch", "Business editor attempted to modify another scope", 403);
        const parsed: unknown = JSON.parse(next);
        if (!object(parsed)) fail("configuration_unreadable", "Business editor produced invalid settings", 500);
        documents[scope] = parsed;
      }
    },
  };
  const manager = SettingsManager.fromStorage(storage, { projectTrusted: getProjectTrustStatus(target.cwd, getAgentDir()).trusted });
  const errors = manager.drainErrors();
  if (errors.length) throw errors[0].error;
  await edit(manager);
  await manager.flush();
  const writeErrors = manager.drainErrors();
  if (writeErrors.length) throw writeErrors[0].error;
  for (const key of Object.keys(document)) delete document[key];
  Object.assign(document, documents[target.scope]);
}
function requireKeys(changes: JsonObject, allowed: readonly string[]): void {
  if (Object.keys(changes).some((key) => !allowed.includes(key))) fail("invalid_changes", "Unexpected change field");
}
function pairs(raw: unknown, name: string): ProviderRename[] {
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS) fail("invalid_changes", `${name} must be a bounded list`);
  return raw.map((item) => { if (!object(item)) fail("invalid_changes", `${name} must contain rename objects`); return { from: text(item.from, "from"), to: text(item.to, "to") }; });
}
async function editModelSettings(target: Required<ReaderSettingsTarget>, document: JsonObject, operation: string, changes: JsonObject): Promise<void> {
  // This read-only model runtime does not load extensions or connect MCP.
  // Extension-only providers remain explicitly unavailable to this writer.
  const runtime = target.area === "models_enabled" || changes.provider !== undefined || changes.modelId !== undefined ? await getReadOnlyModelRuntime() : undefined;
  {
    const models = runtime ? await runtime.getAvailable() : [];
    await editWithManager(target, document, async (manager) => {
      if (target.area === "models_default") {
        requireKeys(changes, ["provider", "modelId", "thinkingLevel"]);
        const edit: DefaultPreferencesEdit = {};
        if (changes.provider !== undefined || changes.modelId !== undefined) edit.model = { provider: text(changes.provider, "provider", 160), modelId: text(changes.modelId, "modelId", 160) };
        if (changes.thinkingLevel !== undefined) { if (!isThinkingLevel(changes.thinkingLevel)) fail("invalid_changes", "Invalid thinkingLevel"); edit.thinkingLevel = changes.thinkingLevel; }
        if (!edit.model && !edit.thinkingLevel) fail("invalid_changes", "A model or thinkingLevel edit is required");
        if (shadowingProjectKeys(manager, edit).length) fail("project_override", "Project settings shadow the requested global preference", 409);
        if (edit.model) {
          const visible = await resolveVisibleModels(runtime!, manager.getEnabledModels());
          if (!visible.visible.some((model) => model.provider === edit.model!.provider && model.id === edit.model!.modelId)) fail("model_unavailable", "Requested model is not available in this project", 404);
        }
        await writeDefaultPreferences(manager, edit);
        return;
      }
      requireKeys(changes, ["refs", "enabled", "provider", "renames", "modelRenames", "fullyEnabled"]);
      if (manager.getProjectSettings().enabledModels !== undefined) fail("project_override", "Project settings override enabledModels", 409);
      const patterns = manager.getEnabledModels();
      const input = await buildEnabledModelsInput(patterns, models);
      let edit;
      if (operation === "clear") edit = clearEnabledModels(input);
      else if (operation === "prune") edit = pruneStaleEnabledModels(input);
      else if (operation === "resync") {
        const renames = pairs(changes.renames, "renames");
        const modelRenames = pairs(changes.modelRenames ?? [], "modelRenames");
        const fullyEnabled = strings(changes.fullyEnabled ?? [], "fullyEnabled");
        edit = await resyncEnabledModels(input, models, { renames, modelRenames, fullyEnabled });
      } else {
        const provider = operation === "set_provider" ? text(changes.provider, "provider", 160) : undefined;
        const refs = provider !== undefined ? models.filter((model) => model.provider === provider).map(modelRef) : strings(changes.refs, "refs");
        if (!refs.length) fail("model_unavailable", "No requested models are available", 404);
        if (refs.some((ref) => !models.some((model) => modelRef(model) === ref))) fail("model_unavailable", "A requested model is not available", 404);
        edit = setModelsEnabled(input, refs, bool(changes.enabled, "enabled"));
      }
      if (!edit.ok) {
        if (edit.reason === "unverified-models") fail("unverified_models", "Unmatched models may be temporarily unavailable; inspect the configuration before removing them", 409);
        if (edit.reason === "unrestricted-scope") fail("unrestricted_scope", "All models are enabled because enabledModels is not set; use model visibility controls instead of creating a partial scope", 409);
        if (edit.reason === "unsafe-scope") fail("unsafe_scope", "The model scope may include unavailable models; the requested change was not saved", 409);
        fail("last_model", "At least one model must stay enabled", 409);
      }
      if (edit.changed) manager.setEnabledModels(edit.patterns);
    });
  }
}

/** Public opaque handles identify existing resources, never grant filesystem authority. */
function resourceId(target: Required<ReaderSettingsTarget>, kind: string, identity: string): string {
  return "resource_" + revision(target, { kind, identity });
}
async function pluginResources(target: Required<ReaderSettingsTarget>) {
  const global = readDocument(getGlobalSettingsPath());
  const project = readDocument(join(target.cwd, ".pi", "settings.json"));
  const manager = SettingsManager.fromStorage({ withLock: (scope, fn) => {
    const next = fn(JSON.stringify(scope === "global" ? global : project));
    if (typeof next === "string") fail("read_only_discovery", "Resource discovery attempted a settings write", 409);
  } }, { projectTrusted: getProjectTrustStatus(target.cwd, getAgentDir()).trusted });
  const errors = manager.drainErrors(); if (errors.length) throw errors[0].error;
  // Explicit project settings are needed for discovery, without SDK migrations.
  const resources = await new DefaultPackageManager({ cwd: target.cwd, agentDir: getAgentDir(), settingsManager: manager }).resolve(async () => "skip");
  const packages = [
    ...(Array.isArray(global.packages) ? global.packages : []).map(entry => ({ entry: entry as PackageSource, sourceScope: "global" })),
    ...(target.scope === "project" && Array.isArray(project.packages) ? project.packages : []).map(entry => ({ entry: entry as PackageSource, sourceScope: "project" })),
  ];
  const found = packages.map(({ entry, sourceScope }) => { const source = packageSource(entry); return { resourceId: resourceId(target, "package:" + sourceScope, getPluginPackageIdentity(source, { cwd: target.cwd, agentDir: getAgentDir(), scope: sourceScope === "global" ? "user" : "project" })), kind: "package", sourceScope, name: basename(source), source }; });
  for (const entry of resources.extensions) if (entry.metadata.origin === "top-level" && (target.scope === "project" || entry.metadata.scope === "user")) {
    const path = resolve(entry.path); found.push({ resourceId: resourceId(target, "extension", path), kind: "extension", sourceScope: entry.metadata.scope === "user" ? "global" : "project", name: basename(path), source: path });
  }
  return [...new Map(found.map(entry => [entry.resourceId, entry])).values()];
}
async function resolveResourceChanges(target: Required<ReaderSettingsTarget>, changes: JsonObject, operation: string): Promise<JsonObject> {
  if (changes.resourceId === undefined) return changes;
  if (!["skills_policy", "plugins"].includes(target.area)) fail("invalid_changes", "resourceId is only valid for Skills and plugins");
  if (["policyKey", "filePath", "path", "source", "resourceKey"].some(key => changes[key] !== undefined)) fail("resource_identity_conflict", "Use resourceId without another resource identity", 409);
  const id = text(changes.resourceId, "resourceId", 100);
  const rest = { ...changes }; delete rest.resourceId;
  if (target.area === "skills_policy") {
    const catalog = await loadSkillsWithInstallInfo(target.cwd, target.scope, { readOnly: true });
    const matches = catalog.skills.filter(skill => resourceId(target, "skill", skill.filePath) === id);
    if (matches.length !== 1) fail("resource_unavailable", "Resource is unavailable in this scope; read a fresh managed snapshot", 409);
    const skill = matches[0];
    return { ...rest, filePath: skill.filePath };
  }
  const matches = (await pluginResources(target)).filter(entry => entry.resourceId === id);
  if (matches.length !== 1) fail("resource_unavailable", "Resource is unavailable in this scope; read a fresh managed snapshot", 409);
  const entry = matches[0];
  if (entry.kind === "package" && entry.sourceScope !== (operation.endsWith("project_override") ? "global" : target.scope)) fail("resource_scope_mismatch", "Resource belongs to another configuration scope; choose the matching resource", 409);
  return { ...rest, ...(entry.kind === "extension" ? { filePath: entry.source } : { source: entry.source }) };
}

async function skillTarget(target: Required<ReaderSettingsTarget>, changes: JsonObject): Promise<SkillInfo> {
  const current = await loadSkillsWithInstallInfo(target.cwd, target.scope, { readOnly: true });
  let candidates = current.skills;
  if (changes.policyKey !== undefined) candidates = candidates.filter((skill) => skill.policyKey === text(changes.policyKey, "policyKey"));
  if (changes.filePath !== undefined) candidates = candidates.filter((skill) => resolve(skill.filePath) === resolve(text(changes.filePath, "filePath")));
  if (changes.source !== undefined && changes.resourceKey !== undefined) {
    const source = text(changes.source, "source"); const resourceKey = text(changes.resourceKey, "resourceKey");
    const identity = getPluginPackageIdentity(source, { cwd: target.cwd, agentDir: getAgentDir(), scope: "user" });
    candidates = candidates.filter((skill) => skill.pluginResourceKey === resourceKey && skill.sourceInfo.origin === "package" && getPluginPackageIdentity(skill.sourceInfo.source ?? "", { cwd: target.cwd, agentDir: getAgentDir(), scope: "user" }) === identity);
  } else if (changes.source !== undefined || changes.resourceKey !== undefined) fail("invalid_changes", "Package identity requires both source and resourceKey");
  if (changes.policyKey === undefined && changes.filePath === undefined && changes.source === undefined) fail("invalid_changes", "Exact Skill identity is required");
  if (candidates.length !== 1) fail("skill_identity_conflict", "Skill identity is missing or ambiguous", 409);
  const skill = candidates[0];
  if (target.scope === "global" && skill.sourceInfo.scope !== "user") fail("scope_mismatch", "Global policy requires a global Skill", 403);
  return skill;
}
async function editSkill(target: Required<ReaderSettingsTarget>, document: JsonObject, operation: string, changes: JsonObject, skill: SkillInfo): Promise<void> {
  requireKeys(changes, ["policyKey", "filePath", "source", "resourceKey", "mode", "enabled"]);
  if (operation.endsWith("skill_invocation_mode")) {
    const mode = operation.startsWith("clear_") ? null : changes.mode;
    if (mode !== null && mode !== "automatic" && mode !== "explicit-only") fail("invalid_changes", "mode must be automatic or explicit-only");
    if (!skill.policyKey) fail("skill_identity_conflict", "Skill has no stable policyKey", 409);
    updateModeMap(document, target.scope === "global" ? GLOBAL_SKILL_INVOCATION_MODES_SETTING : PROJECT_SKILL_INVOCATION_MODES_SETTING, skill.policyKey, mode, target.cwd);
    return;
  }
  const clearing = operation.startsWith("clear_");
  const enabled = clearing ? false : bool(changes.enabled, "enabled");
  await editWithManager(target, document, (manager) => {
    if (operation.endsWith("global_skill_resource")) {
      if (target.scope !== "global" || skill.sourceInfo.origin !== "top-level") fail("scope_mismatch", "This operation requires a global top-level Skill", 403);
      if (clearing) clearGlobalTopLevelSkillOverride(manager, skill.filePath); else setGlobalTopLevelSkillOverride(manager, skill.filePath, enabled ? "enabled" : "disabled");
    } else if (operation.endsWith("project_resource")) {
      if (target.scope !== "project" || skill.sourceInfo.origin !== "top-level") fail("scope_mismatch", "This operation requires a project top-level resource policy", 403);
      if (clearing) clearProjectTopLevelOverride(manager, target.cwd, "skills", skill.filePath); else setProjectTopLevelOverride(manager, target.cwd, "skills", skill.filePath, enabled ? "enabled" : "disabled");
    } else {
      const source = skill.sourceInfo.source; const key = skill.pluginResourceKey;
      if (!source || !key || skill.sourceInfo.origin !== "package") fail("skill_identity_conflict", "Plugin policy requires a discovered package Skill", 409);
      if (enabled && isDisabledPluginPackage(manager, target.cwd, getAgentDir(), source, target.scope)) fail("plugin_disabled", "Enable the parent plugin before enabling its Skill", 409);
      if (target.scope === "global") { if (clearing) clearGlobalPluginSkillFilter(manager, source, key); else setGlobalPluginSkillFilter(manager, source, key, enabled ? "enabled" : "disabled"); }
      else if (clearing) clearProjectPackageResourceOverride(manager, source, "skills", key);
      else setProjectPackageResourceOverride(manager, source, "skills", key, enabled ? "enabled" : "disabled");
    }
  });
}
async function editPlugin(target: Required<ReaderSettingsTarget>, document: JsonObject, operation: string, changes: JsonObject): Promise<void> {
  requireKeys(changes, ["source", "enabled", "path", "filePath"]);
  await editWithManager(target, document, async (manager) => {
    if (operation.endsWith("top_level_extension")) {
      const extensionPath = resolve(text(changes.path ?? changes.filePath, "path"));
      if (operation.startsWith("clear_") && target.scope !== "project") fail("scope_mismatch", "Only project extension overrides can be cleared");
      const packageManager = new DefaultPackageManager({ cwd: target.cwd, agentDir: getAgentDir(), settingsManager: target.scope === "global" ? SettingsManager.inMemory(manager.getGlobalSettings(), { projectTrusted: true }) : manager });
      const resources = await packageManager.resolve(async () => "skip");
      const resource = resources.extensions.find((entry) => entry.metadata.origin === "top-level" && resolve(entry.path) === extensionPath && (target.scope === "project" || entry.metadata.scope === "user"));
      if (!resource) fail("extension_not_found", "Exact top-level extension is not configured", 404);
      if (operation.startsWith("clear_")) clearProjectTopLevelOverride(manager, target.cwd, "extensions", resource.path);
      else if (target.scope === "project") setProjectTopLevelOverride(manager, target.cwd, "extensions", resource.path, bool(changes.enabled, "enabled") ? "enabled" : "disabled");
      else manager.setExtensionPaths(updateTopLevelExtensionPaths(manager.getGlobalSettings().extensions ?? [], topLevelExtensionPattern(resource, getAgentDir()), bool(changes.enabled, "enabled")));
      return;
    }
    const source = text(changes.source, "source");
    const identity = (value: string, scope: ReaderSettingsScope) => getPluginPackageIdentity(value, { cwd: target.cwd, agentDir: getAgentDir(), scope: scope === "global" ? "user" : "project" });
    if (operation.endsWith("project_override")) {
      if (target.scope !== "project") fail("scope_mismatch", "Project override requires project scope");
      const entry = (manager.getGlobalSettings().packages ?? []).find((item) => identity(packageSource(item), "global") === identity(source, "global"));
      if (!entry) fail("plugin_not_found", "Global package is not configured", 404);
      if (operation.startsWith("clear_")) clearProjectPackageOverride(manager, packageSource(entry)); else setProjectPackageOverride(manager, packageSource(entry), bool(changes.enabled, "enabled") ? "enabled" : "disabled");
      return;
    }
    const packages = (target.scope === "global" ? manager.getGlobalSettings() : manager.getProjectSettings()).packages ?? [];
    let found = false;
    const next = packages.map((entry) => {
      if (identity(packageSource(entry), target.scope) !== identity(source, target.scope)) return entry;
      found = true; return setPackageEntryDisabled(entry, operation === "disable");
    });
    if (!found) fail("plugin_not_found", "Package is not configured in this scope", 404);
    if (target.scope === "global") manager.setPackages(next); else manager.setProjectPackages(next);
  });
}
function editTool(document: JsonObject, operation: string, changes: JsonObject, scope: ReaderSettingsScope): void {
  requireKeys(changes, operation === "set_codemode" ? ["codemode"] : operation === "set_codemode_mode" ? ["codemodeMode"] : ["inlineBudget"]);
  if (operation === "set_codemode") {
    if (!isCodemodePreference(changes.codemode)) fail("invalid_changes", "Invalid codemode preference");
    const edited = withCodemodePreference(defaultToolEntries(document), changes.codemode);
    const next = scope === "project" && changes.codemode === "automatic" ? [...(edited ?? []), "-codemode"] : edited;
    if (next === undefined) delete document.defaultTools; else document.defaultTools = next;
    return;
  }
  if (document.codemode !== undefined && !object(document.codemode)) fail("configuration_unreadable", "codemode must be an object", 409);
  const codemode: JsonObject = object(document.codemode) ? document.codemode : {};
  if (operation === "set_codemode_mode") {
    if (!isCodemodeMode(changes.codemodeMode)) fail("invalid_changes", "Invalid codemode mode");
    if (changes.codemodeMode === "on" && scope === "global") delete codemode.mode; else codemode.mode = changes.codemodeMode;
  } else {
    if (changes.inlineBudget !== null && !isCodemodeInlineBudget(changes.inlineBudget)) fail("invalid_changes", "Invalid codemode inline budget");
    if (changes.inlineBudget === null) delete codemode.inlineBudget; else codemode.inlineBudget = changes.inlineBudget;
  }
  if (Object.keys(codemode).length) document.codemode = codemode; else delete document.codemode;
}
async function writableMcpInternals(): Promise<PiSdkInternals> {
  const result = await mcpInternalsOrRefusal("does not change MCP configuration");
  if (isMcpEntryRefusal(result)) fail(result.body.reason, "MCP configuration is disabled or unavailable", result.status);
  return result;
}
function editMcpDocument(target: Required<ReaderSettingsTarget>, document: JsonObject, operation: string, changes: JsonObject, internals: PiSdkInternals, consumeUndo = false): { removed?: McpRemovedEntry; restored?: McpHeldRemoval } {
  if (isMcpDisabledByOperator()) fail("mcp-off", "MCP is disabled by the Reader operator", 409);
  requireProjectTrust(target);
  requireKeys(changes, ["name", "names", "enabled", "exposure", "server", "undoId"]);
  const servers = object(document.mcpServers) ? document.mcpServers : undefined;
  if (operation === "add") {
    const name = text(changes.name, "name", 200);
    if (!object(changes.server)) fail("invalid_changes", "An MCP server configuration object is required");
    const prepared = prepareMcpAdd({ text: JSON.stringify({ mcpServers: { [name]: changes.server } }), server: 0, name, scope: target.scope, rawPi: true, values: {}, confirmHostEnv: [] }, { takenNames: Object.keys(servers ?? {}), internals });
    if (!prepared.ok) fail(prepared.reason, "MCP server configuration was refused by the Reader business validator", prepared.status);
    insertMcpServerEntry(document, prepared.name, prepared.entry);
    return {};
  }
  if (operation === "undo") {
    const id = text(changes.undoId, "undoId", 100);
    const held = peekRemovedEntry(id);
    if (!held) fail("undo_expired", "MCP undo is unavailable after its bounded hold or a Reader restart", 409);
    if (held.scope !== target.scope || held.path !== mcpPath(target) || (target.scope === "project" && held.cwd !== target.cwd)) fail("undo_scope_mismatch", "The removal belongs to another configuration scope", 403);
    if (ownServerEntry(servers, held.name) !== undefined) fail("mcp_name_taken", "The removed server name is occupied", 409);
    if (!object(held.entry) || (held.entry.enabled !== false && findWebPasswordField(held.entry, internals))) fail("mcp_web_password", "The removed entry cannot safely be restored", 403);
    const removed = consumeUndo ? takeRemovedEntry(id) : held;
    if (!removed) fail("undo_expired", "The MCP undo was already consumed", 409);
    insertMcpServerEntry(document, removed.name, removed.entry, removed.index);
    return consumeUndo ? { restored: removed } : {};
  }
  const names = operation === "set_enabled" ? strings(changes.names, "names") : [text(changes.name, "name", 200)];
  if (!names.length || names.length > 100 || new Set(names).size !== names.length) fail("invalid_changes", "MCP server names must be unique and non-empty");
  const entries = names.map((name) => {
    const entry = ownServerEntry(servers, name);
    if (!object(entry)) fail("mcp_server_missing", "MCP server is missing or invalid", 409);
    return { name, entry };
  });
  const enabled = operation === "enable" ? true : operation === "disable" ? false : operation === "set_enabled" ? bool(changes.enabled, "enabled") : undefined;
  if (enabled === true && entries.some(({ entry }) => findWebPasswordField(entry, internals))) fail("mcp_web_password", "MCP entry references the Reader host password", 403);
  if (operation === "set_exposure" && !isMcpExposure(changes.exposure)) fail("invalid_changes", "Invalid MCP exposure");
  let removed: McpRemovedEntry | undefined;
  for (const { name, entry } of entries) {
    if (operation === "remove") {
      removed = { scope: target.scope, name, path: mcpPath(target), ...(target.scope === "project" ? { cwd: target.cwd } : {}), entry, index: Object.keys(servers!).indexOf(name) };
      delete servers![name];
    } else patchMcpServerEntry(entry, operation === "set_exposure" ? { exposure: changes.exposure as "direct" | "codemode" } : { enabled });
  }
  return { removed };
}
async function mutateMcp(target: Required<ReaderSettingsTarget>, operation: string, changes: JsonObject, expected: string, validateTarget?: () => void): Promise<ReaderSettingsSnapshot> {
  const internals = await writableMcpInternals();
  const fileTarget: McpConfigFileTarget = target.scope === "global" ? { scope: "global", agentDir: getAgentDir() } : { scope: "project", cwd: target.cwd };
  let result: ReaderSettingsSnapshot | undefined;
  let restored: McpHeldRemoval | undefined;
  try {
    const outcome = await editMcpConfigFile(fileTarget, (file) => {
      requireRevision(target, file.document, expected);
      const before = revision(target, file.document);
      const changed = editMcpDocument(target, file.document, operation, changes, internals, true);
      restored = changed.restored;
      result = snapshot(target, file.document, projection(target, file.document));
      result.changed = before !== result.revision;
      return { changed: result.changed, value: changed.removed };
    }, validateTarget);
    if (outcome.value) {
      const hold = holdRemovedEntry(outcome.value);
      result!.impact.undo = { id: hold.token, expiresAt: hold.expiresAt };
    }
    return result!;
  } catch (error) {
    if (restored) returnRemovedEntry(restored);
    throw error;
  }
}
async function editSettingsDocument(target: Required<ReaderSettingsTarget>, document: JsonObject, operation: string, changes: JsonObject, skill?: SkillInfo): Promise<void> {
  if (target.area === "tools_settings") editTool(document, operation, changes, target.scope);
  else if (target.area === "models_default" || target.area === "models_enabled") await editModelSettings(target, document, operation, changes);
  else if (target.area === "skills_policy") await editSkill(target, document, operation, changes, skill!);
  else if (target.area === "plugins") await editPlugin(target, document, operation, changes);
  else if (target.area === "compaction") {
    requireKeys(changes, ["enabled"]);
    const enabled = bool(changes.enabled, "enabled");
    if (document.compaction !== undefined && !object(document.compaction)) fail("configuration_unreadable", "compaction must be an object", 409);
    document.compaction = { ...(document.compaction as JsonObject | undefined), enabled };
  } else fail("unsupported_operation", "Unsupported settings operation");
}
function validateOperation(target: ReaderSettingsTarget, operation: string, changes: JsonObject): void {
  if (!READER_SETTINGS_OPERATIONS[target.area].includes(operation)) fail("unsupported_operation", "This settings operation is not implemented by Reader's managed contract", 400);
  if (!object(changes) || JSON.stringify(changes).length > 128 * 1024) fail("invalid_changes", "changes must be a bounded object");
}
function editModelMetadata(document: JsonObject, changes: JsonObject): void {
  requireKeys(changes, ["provider", "modelId", "name", "thinkingLevel"]);
  const provider = text(changes.provider, "provider", 160);
  const modelId = text(changes.modelId, "modelId", 160);
  const entry = object(document.providers) && Object.hasOwn(document.providers, provider) ? document.providers[provider] : undefined;
  const models = object(entry) && Array.isArray(entry.models) ? entry.models.filter(object).filter((model) => model.id === modelId) : [];
  if (models.length !== 1) fail("model_identity_conflict", "The configured model is missing or ambiguous", 409);
  if (changes.name === undefined && changes.thinkingLevel === undefined) fail("invalid_changes", "A name or thinkingLevel edit is required");
  if (changes.name !== undefined) models[0].name = text(changes.name, "name", 256);
  if (changes.thinkingLevel !== undefined) {
    if (!isThinkingLevel(changes.thinkingLevel)) fail("invalid_changes", "Invalid model thinkingLevel");
    models[0].defaultThinkingLevel = changes.thinkingLevel;
  }
}

/** Same business validation as a write, using only an in-memory document. */
export async function validateSettingsChange(input: ReaderSettingsTarget & { operation: string; changes: JsonObject }): Promise<void> {
  const target = await normalizeTarget(input);
  input = { ...input, changes: await resolveResourceChanges(target, input.changes, input.operation) };
  validateOperation(target, input.operation, input.changes);
  if (target.area === "subagent_profiles") { validateManagedProfileChange({ ...input, ...target }); return; }
  if (Object.hasOwn(RESOURCE_SETTINGS_OPERATIONS, target.area)) { validateResourceSettingsChange(input); return; }
  requireProjectTrust(target);
  if (target.area === "models_config") { editModelMetadata(readModelsConfig(), input.changes); return; }
  if (target.area === "mcp") { editMcpDocument(target, readMcpDocument(target), input.operation, input.changes, await writableMcpInternals()); return; }
  const skill = target.area === "skills_policy" ? await skillTarget(target, input.changes) : undefined;
  await editSettingsDocument(target, readDocument(settingsPath(target)), input.operation, input.changes, skill);
}

export async function mutateSettings(input: ReaderSettingsTarget & { operation: string; changes: JsonObject; expectedRevision: string }): Promise<ReaderSettingsSnapshot> {
  const target = await normalizeTarget(input);
  const projectWrite = target.scope === "project" && target.area !== "subagent_profiles" ? pinProjectWrite(target, target.area === "mcp" ? mcpPath(target) : settingsPath(target)) : undefined;
  await validateSettingsChange(input);
  input = { ...input, changes: await resolveResourceChanges(target, input.changes, input.operation) };
  if (typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) fail("revision_required", "A current SHA-256 expectedRevision is required");
  if (target.area === "subagent_profiles") return mutateManagedProfiles({ ...input, ...target });
  if (Object.hasOwn(RESOURCE_SETTINGS_OPERATIONS, target.area)) return mutateResourceSettings(input);
  requireProjectTrust(target);
  if (target.area === "models_config") {
    if (!existsSync(dirname(getModelsConfigPath()))) fail("scope_uninitialized", "The model configuration scope must already exist", 409);
    return updateModelsConfig((document) => {
      requireRevision(target, document, input.expectedRevision);
      const before = revision(target, document);
      editModelMetadata(document, input.changes);
      const result = snapshot(target, document, projection(target, document));
      result.changed = result.revision !== before;
      return result;
    });
  }
  const targetFile = target.area === "mcp" ? mcpPath(target) : settingsPath(target);
  if (!existsSync(dirname(targetFile))) fail("scope_uninitialized", "Configuration scope must already exist before a managed write", 409);
  if (target.area === "mcp") return mutateMcp(target, input.operation, input.changes, input.expectedRevision, projectWrite?.validate);
  // Discovery happens without mutation; never call the legacy GET migration
  // from inside settings.json's lock (the SDK would try to take it again).
  const skill = target.area === "skills_policy" ? await skillTarget(target, input.changes) : undefined;
  let result: ReaderSettingsSnapshot | undefined;
  await updateGlobalSettings(settingsPath(target), async (document) => {
    requireProjectTrust(target);
    requireRevision(target, document, input.expectedRevision);
    const before = revision(target, document);
    await editSettingsDocument(target, document, input.operation, input.changes, skill);
    result = snapshot(target, document, projection(target, document)); result.changed = before !== result.revision;
  }, projectWrite?.validate, Boolean(projectWrite && !samePath(projectWrite.path, settingsPath(target))));
  if (target.area.startsWith("models_")) invalidateModelsCache();
  return result!;
}
