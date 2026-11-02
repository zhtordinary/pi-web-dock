import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { ResourceSettingsError } from "./resource-config-file";
import { PROJECT_SETTINGS_MAX_BYTES, readRegularFileText } from "./regular-file";
import { createHash } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "./frontmatter";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isExistingPathWithinRoots } from "./path-security";
import { readBuiltInSubagentOverride } from "./subagent-settings";
import { readPiSubagentStoredOverride } from "./pi-subagent-settings";

import {
  BUILTIN_TOOLS,
  READ_ONLY_TOOLS,
  VALID_THINKING_LEVELS,
  type AgentScope,
  type SubagentModelSource,
  type SubagentModelSourceScope,
  type SubagentProfile,
} from "./subagent-profile-types";

export {
  BUILTIN_TOOLS,
  READ_ONLY_TOOLS,
  type AgentScope,
  type SubagentProfile,
};

export interface SubagentProfileContext {
  /** Provider from a verified parent-session runtime snapshot. */
  parentProvider?: string;
}

type NativeOverride = {
  model?: string | false;
  thinking?: string | false;
  defaultProvider?: string | false;
};
type NativeOverrideSource = Partial<Record<keyof NativeOverride, SubagentModelSourceScope>>;
type NativeSettings = {
  defaultModel?: string;
  defaultProvider?: string;
  defaultThinking?: string;
  overrides: Record<string, NativeOverride>;
  overrideSources: Record<string, NativeOverrideSource>;
};

export const BUILTIN_PROFILES: SubagentProfile[] = [
  {
    name: "general-purpose",
    displayName: "General purpose",
    description: "Handle a focused implementation or investigation task",
    systemPrompt: "Work autonomously on the delegated task. Keep the final answer concise and include important files, decisions, and remaining risks.",
    tools: [...BUILTIN_TOOLS],
    enabled: true,
    defaultContext: "fresh",
    defaultAsync: false,
    inheritProjectContext: false,
    inheritGlobalContext: false,
    inheritSkills: false,
    scope: "builtin",
    builtinKind: "reader",
  },
  {
    name: "explore",
    displayName: "Explore",
    description: "Quickly inspect a codebase without modifying it",
    systemPrompt: "Explore the codebase to answer the delegated question. Do not modify files. Report concrete findings with file paths and relevant symbols.",
    tools: [...READ_ONLY_TOOLS],
    enabled: true,
    defaultContext: "fresh",
    defaultAsync: false,
    inheritProjectContext: false,
    inheritGlobalContext: false,
    inheritSkills: false,
    scope: "builtin",
    builtinKind: "reader",
  },
  {
    name: "plan",
    displayName: "Plan",
    description: "Design an implementation plan without modifying files",
    systemPrompt: "Produce an implementation-ready plan for the delegated task. Inspect the repository as needed, do not modify files, and call out dependencies, risks, and verification steps.",
    tools: [...READ_ONLY_TOOLS],
    enabled: true,
    defaultContext: "fresh",
    defaultAsync: false,
    inheritProjectContext: false,
    inheritGlobalContext: false,
    inheritSkills: false,
    scope: "builtin",
    builtinKind: "reader",
  },
];

function cleanString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function cleanBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTools(raw: unknown, defaultTools: readonly string[]): string[] {
  if (raw === undefined || raw === null) return [...defaultTools];
  const list: string[] = (
    Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : []
  )
    .map((value) => String(value).trim())
    .filter(Boolean);

  if (list.includes("none")) return [];
  if (list.includes("all") || list.includes("*")) return [...BUILTIN_TOOLS];
  return [...new Set(list)];
}

function isValidThinking(value: unknown): value is string {
  return typeof value === "string" && (VALID_THINKING_LEVELS as readonly string[]).includes(value);
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseNativeOverride(value: unknown): NativeOverride {
  if (!isRecord(value)) return {};
  const result: NativeOverride = {};
  if (value.model === false || typeof value.model === "string") result.model = value.model === false ? false : value.model.trim() || undefined;
  if (value.thinking === false || typeof value.thinking === "string") {
    result.thinking = value.thinking === false ? false : isValidThinking(value.thinking) ? value.thinking : undefined;
  }
  if (value.defaultProvider === false || typeof value.defaultProvider === "string") {
    result.defaultProvider = value.defaultProvider === false ? false : value.defaultProvider.trim() || undefined;
  }
  return result;
}

function parseNativeSettings(path: string, preferredProvider: string | undefined, scope: SubagentModelSourceScope): NativeSettings {
  const root = readJsonObject(path);
  const subagents = isRecord(root.subagents) ? root.subagents : {};
  const overrides = isRecord(subagents.agentOverrides) ? subagents.agentOverrides : {};
  const result: NativeSettings = {
    ...(typeof subagents.defaultModel === "string" && subagents.defaultModel.trim() ? { defaultModel: subagents.defaultModel.trim() } : {}),
    ...(typeof subagents.defaultProvider === "string" && subagents.defaultProvider.trim() ? { defaultProvider: subagents.defaultProvider.trim() } : {}),
    ...(isValidThinking(subagents.defaultThinking) ? { defaultThinking: subagents.defaultThinking } : {}),
    overrides: {},
    overrideSources: {},
  };

  for (const [name, value] of Object.entries(overrides)) {
    const parsed = parseNativeOverride(value);
    if (Object.keys(parsed).length > 0) {
      result.overrides[name] = parsed;
      result.overrideSources[name] = Object.fromEntries(Object.keys(parsed).map((field) => [field, scope])) as NativeOverrideSource;
    }
  }

  if (preferredProvider && isRecord(subagents.agentOverridesByProvider)) {
    const providerEntries = subagents.agentOverridesByProvider[preferredProvider];
    if (isRecord(providerEntries)) {
      for (const [name, value] of Object.entries(providerEntries)) {
        const parsed = parseNativeOverride(value);
        if (Object.keys(parsed).length === 0) continue;
        result.overrides[name] = { ...result.overrides[name], ...parsed };
        result.overrideSources[name] = {
          ...result.overrideSources[name],
          ...Object.fromEntries(Object.keys(parsed).map((field) => [field, "provider"])) as NativeOverrideSource,
        };
      }
    }
  }
  return result;
}

function findProjectRoot(cwd: string): string | undefined {
  let current = resolve(cwd);
  const candidates: string[] = [];
  let gitRoot: string | undefined;
  while (true) {
    if (existsSync(join(current, ".pi")) || existsSync(join(current, ".agents"))) candidates.push(current);
    if (existsSync(join(current, ".git"))) gitRoot = current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const nearest = candidates[0];
  if (!nearest) return undefined;
  const policy = readJsonObject(join(nearest, ".pi", "settings.json"));
  const resolution = isRecord(policy.subagents) ? policy.subagents.projectRootResolution : undefined;
  return resolution === "git-root" && gitRoot && candidates.some((candidate) => resolve(candidate) === resolve(gitRoot!))
    ? gitRoot
    : nearest;
}

function nativeSettingsFor(cwd: string, context: SubagentProfileContext): NativeSettings {
  const userPath = join(getAgentDir(), "settings.json");
  const projectRoot = findProjectRoot(cwd);
  const projectPath = projectRoot ? join(projectRoot, ".pi", "settings.json") : undefined;
  const user = parseNativeSettings(userPath, context.parentProvider, "user");
  const project = projectPath ? parseNativeSettings(projectPath, context.parentProvider, "project") : {
    overrides: {},
    overrideSources: {},
  } satisfies NativeSettings;
  const mergedOverrides: Record<string, NativeOverride> = { ...user.overrides };
  const mergedSources: Record<string, NativeOverrideSource> = { ...user.overrideSources };
  for (const [name, value] of Object.entries(project.overrides)) {
    mergedOverrides[name] = { ...mergedOverrides[name], ...value };
    mergedSources[name] = { ...mergedSources[name], ...project.overrideSources[name] };
  }
  return {
    defaultModel: project.defaultModel ?? user.defaultModel,
    defaultProvider: project.defaultProvider ?? user.defaultProvider,
    defaultThinking: project.defaultThinking ?? user.defaultThinking,
    overrides: mergedOverrides,
    overrideSources: mergedSources,
  };
}

function splitModel(value: string | undefined): { provider?: string; id?: string } {
  if (!value) return {};
  const slash = value.indexOf("/");
  if (slash > 0 && slash < value.length - 1) return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
  return { id: value };
}

function nativeProjection(
  name: string,
  rawModel: string | undefined,
  rawThinking: string | undefined,
  settings: NativeSettings,
): Pick<SubagentProfile, "model" | "modelId" | "modelProvider" | "modelSource" | "modelSourceScope" | "modelOverride" | "thinking" | "thinkingOverride"> {
  const directOverride = settings.overrides[name] ?? {};
  const sourceFields = settings.overrideSources[name] ?? {};
  let model = rawModel;
  let modelSource: SubagentModelSource = rawModel ? "profile" : "parent";
  let modelSourceScope: SubagentModelSourceScope | undefined;
  let provider = splitModel(rawModel).provider;
  let thinking = rawThinking;

  if (model === undefined && settings.defaultModel !== undefined) {
    model = settings.defaultModel;
    modelSource = "default";
  }
  if (settings.defaultProvider) provider ??= settings.defaultProvider;
  if (settings.defaultThinking && thinking === undefined) thinking = settings.defaultThinking;

  if (Object.prototype.hasOwnProperty.call(directOverride, "model")) {
    model = directOverride.model === false ? undefined : directOverride.model;
    modelSource = "override";
    modelSourceScope = sourceFields.model;
    provider = settings.defaultProvider;
  }
  if (Object.prototype.hasOwnProperty.call(directOverride, "defaultProvider")) {
    provider = directOverride.defaultProvider === false ? undefined : directOverride.defaultProvider;
    if (modelSource === "override") modelSourceScope = sourceFields.defaultProvider ?? modelSourceScope;
  }
  if (Object.prototype.hasOwnProperty.call(directOverride, "thinking")) {
    thinking = directOverride.thinking === false ? undefined : directOverride.thinking;
  }

  const split = splitModel(model);
  provider = split.provider ?? provider;
  const modelId = split.id;
  // A bare model ID is not a provider/model reference. Keep its ID and the
  // resolver's provider separately instead of inventing a display identity.
  const effectiveModel = split.provider ? model : undefined;
  const editableOverride = readPiSubagentStoredOverride(name);
  const directUserModel = editableOverride.model;
  const directUserThinking = editableOverride.thinking;
  return {
    ...(effectiveModel ? { model: effectiveModel } : {}),
    ...(modelId ? { modelId } : {}),
    ...(provider ? { modelProvider: provider } : {}),
    modelSource,
    ...(modelSourceScope ? { modelSourceScope } : {}),
    ...(typeof directUserModel === "string" ? { modelOverride: directUserModel } : {}),
    ...(directUserThinking !== undefined ? { thinkingOverride: directUserThinking } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

function scanProfileDir(dir: string, scope: AgentScope, cwd: string, nativeSettings?: NativeSettings, contents?: Map<string, string>): SubagentProfile[] {
  if (!existsSync(dir)) return [];
  if ((scope === "project" || scope === "workspace") && !isExistingPathWithinRoots(dir, new Set([cwd]))) return [];
  try {
    const entries = contents ? [...contents.keys()].map((name) => ({ name, isFile: () => true })) : readdirSync(dir, { withFileTypes: true });
    const profiles: SubagentProfile[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const fullPath = join(dir, entry.name);
      try {
        const rawContent = contents?.get(entry.name) ?? readFileSync(fullPath, "utf8");
        const { data, rest } = parseFrontmatter(rawContent);
        const name = basename(entry.name, ".md");
        const toolsExplicit = data !== null && Object.prototype.hasOwnProperty.call(data, "tools");
        const tools = parseTools(data?.tools, BUILTIN_TOOLS);
        const disallowed = new Set(parseTools(data?.disallowed_tools, []));
        const activeTools = tools.filter((tool) => !disallowed.has(tool));
        const thinking = cleanString(data?.thinking);
        const systemPromptMode = data?.systemPromptMode === "append" || data?.systemPromptMode === "replace"
          ? data.systemPromptMode
          : undefined;
        const legacyInheritContext = optionalBoolean(data?.inherit_context);
        const defaultContext = data?.defaultContext === "fork" || data?.defaultContext === "fresh"
          ? data.defaultContext
          : legacyInheritContext === true ? "fork" : "fresh";
        const defaultAsync = optionalBoolean(data?.async) ?? cleanBoolean(data?.run_in_background, false);
        const inheritProjectContext = optionalBoolean(data?.inheritProjectContext ?? data?.inherit_project_context) ?? false;
        const inheritGlobalContext = optionalBoolean(data?.inheritGlobalContext ?? data?.inherit_global_context) ?? false;
        const inheritSkills = optionalBoolean(data?.inheritSkills ?? data?.inherit_skills)
          ?? cleanBoolean(data?.load_skills, false);
        const acceptanceRole = data?.acceptanceRole === "read-only" || data?.acceptanceRole === "writer"
          ? data.acceptanceRole
          : undefined;
        const runnerType = data?.runner && typeof data.runner === "object" && !Array.isArray(data.runner)
          ? (data.runner as Record<string, unknown>).type
          : undefined;
        const runtimeKind = scope === "runtime"
          ? runnerType === "external-cli" ? "external-cli" : runnerType === "external-job" ? "external-job" : "native"
          : undefined;
        const rawModel = cleanString(data?.model);
        const rawThinking = isValidThinking(thinking) ? thinking : undefined;
        const native = scope === "runtime" && runtimeKind === "native" && nativeSettings
          ? nativeProjection(name, rawModel, rawThinking, nativeSettings)
          : {};
        const external = scope === "runtime" && runtimeKind !== "native";

        profiles.push({
          name,
          displayName: cleanString(data?.display_name) ?? name,
          description: cleanString(data?.description) ?? name,
          systemPrompt: rest.trim(),
          tools: activeTools,
          toolsExplicit,
          enabled: cleanBoolean(data?.enabled, true),
          defaultContext,
          defaultAsync,
          scope,
          filePath: fullPath,
          ...(runtimeKind ? { runtimeKind } : {}),
          ...(external ? {} : native),
          ...(!external && scope !== "runtime" && rawModel ? { model: rawModel, modelId: splitModel(rawModel).id, modelProvider: splitModel(rawModel).provider, modelSource: "profile" as const } : {}),
          ...(!external && scope !== "runtime" && rawThinking ? { thinking: rawThinking } : {}),
          ...(systemPromptMode ? { systemPromptMode } : {}),
          inheritProjectContext,
          inheritGlobalContext,
          inheritSkills,
          ...(acceptanceRole ? { acceptanceRole } : {}),
        });
      } catch {
        // Ignore unreadable individual files
      }
    }
    return profiles;
  } catch {
    return [];
  }
}

function withReaderBuiltinOverride(profile: SubagentProfile): SubagentProfile {
  if (profile.scope !== "builtin") return profile;
  const override = readBuiltInSubagentOverride(profile.name);
  return {
    ...profile,
    ...(override.model ? { model: override.model, modelId: splitModel(override.model).id, modelProvider: splitModel(override.model).provider, modelSource: "override" as const, modelOverride: override.model } : { modelSource: "parent" as const }),
    ...(override.thinking ? { thinking: override.thinking, thinkingOverride: override.thinking } : {}),
  };
}

function getPackageBuiltinDir(): string {
  return join(getAgentDir(), "npm", "node_modules", "pi-subagents", "agents");
}

function listSources(cwd: string, context: SubagentProfileContext): SubagentProfile[] {
  const nativeSettings = nativeSettingsFor(cwd, context);
  const result: SubagentProfile[] = BUILTIN_PROFILES.map((profile) => withReaderBuiltinOverride({ ...profile, tools: [...profile.tools] }));
  result.push(...scanProfileDir(getPackageBuiltinDir(), "runtime", cwd, nativeSettings));

  const globalDir = join(getAgentDir(), "agents");
  result.push(...scanProfileDir(globalDir, "global", cwd));

  const workspaceDir = join(resolve(cwd), ".agents", "agents");
  result.push(...scanProfileDir(workspaceDir, "workspace", cwd));

  const projectDir = join(resolve(cwd), ".pi", "agents");
  result.push(...scanProfileDir(projectDir, "project", cwd));
  return result;
}

export function listSubagentProfiles(cwd: string, context: SubagentProfileContext = {}): SubagentProfile[] {
  return listSources(cwd, context).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function getResolvedSubagentProfiles(cwd: string, context: SubagentProfileContext = {}): SubagentProfile[] {
  const map = new Map<string, SubagentProfile>();
  for (const profile of listSources(cwd, context)) map.set(profile.name.toLowerCase(), profile);
  return [...map.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function validateAgentName(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
    throw new Error("Agent name may contain only letters, numbers, dots, underscores, and hyphens");
  }
  return trimmed;
}

export function getProfileDirectory(cwd: string, scope: "global" | "project"): string {
  if (scope === "global") return join(getAgentDir(), "agents");
  if (scope === "project") return join(resolve(cwd), ".pi", "agents");
  throw new Error("Agent scope must be global or project");
}

function assertProjectPathWithinCwd(cwd: string, target: string): void {
  const roots = new Set([resolve(cwd)]);
  let existing = resolve(target);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error("Agent profile path is outside the project root");
    existing = parent;
  }
  if (!isExistingPathWithinRoots(existing, roots)) {
    throw new Error("Agent profile path is outside the project root");
  }
  if (existsSync(target) && !isExistingPathWithinRoots(target, roots)) {
    throw new Error("Agent profile path is outside the project root");
  }
}

function saveSubagentProfileUnlocked(
  cwd: string,
  scope: "global" | "project",
  profile: SubagentProfile,
  validateWrite?: (filePath: string, contents: string) => void,
): SubagentProfile {
  const name = validateAgentName(profile.name);
  const tools = [...new Set(profile.tools.map((tool) => String(tool).trim()).filter(Boolean))];
  if (profile.thinking && !isValidThinking(profile.thinking)) {
    throw new Error(`Invalid thinking level: ${profile.thinking}`);
  }
  const dir = getProfileDirectory(cwd, scope);
  if (scope === "project") assertProjectPathWithinCwd(cwd, dir);
  mkdirSync(dir, { recursive: true });
  if (scope === "project") assertProjectPathWithinCwd(cwd, dir);

  const filePath = join(dir, `${name}.md`);
  if (scope === "project") assertProjectPathWithinCwd(cwd, filePath);
  const displayName = profile.displayName.trim() || name;
  const description = profile.description.trim() || name;
  const systemPrompt = profile.systemPrompt.trim();
  const model = profile.model?.trim() || undefined;
  let existingFrontmatter: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      existingFrontmatter = parseFrontmatter(readFileSync(filePath, "utf8")).data ?? {};
    } catch {
      // A malformed existing block is replaced by the validated profile below.
    }
  }
  const toolsExplicit = profile.toolsExplicit ?? (existsSync(filePath)
    ? Object.prototype.hasOwnProperty.call(existingFrontmatter, "tools")
    : true);
  const existingSystemPromptMode = existingFrontmatter.systemPromptMode;
  const existingDefaultContext = existingFrontmatter.defaultContext === "fork" || existingFrontmatter.defaultContext === "fresh"
    ? existingFrontmatter.defaultContext
    : undefined;
  const existingDefaultAsync = optionalBoolean(existingFrontmatter.async);
  const existingProjectContext = optionalBoolean(existingFrontmatter.inheritProjectContext ?? existingFrontmatter.inherit_project_context);
  const existingGlobalContext = optionalBoolean(existingFrontmatter.inheritGlobalContext ?? existingFrontmatter.inherit_global_context);
  const existingSkills = optionalBoolean(existingFrontmatter.inheritSkills ?? existingFrontmatter.inherit_skills);
  const legacyProfile = profile as SubagentProfile & {
    inheritContext?: boolean;
    runInBackground?: boolean;
    loadSkills?: boolean;
  };
  const legacyContext = legacyProfile.inheritContext ?? optionalBoolean(existingFrontmatter.inherit_context);
  const legacyAsync = legacyProfile.runInBackground ?? optionalBoolean(existingFrontmatter.run_in_background);
  const legacySkills = legacyProfile.loadSkills ?? optionalBoolean(existingFrontmatter.load_skills);
  const frontmatter: Record<string, unknown> = {
    ...existingFrontmatter,
    name,
    description,
    display_name: displayName,
    enabled: profile.enabled,
    systemPromptMode: profile.systemPromptMode ?? (existingSystemPromptMode === "append" || existingSystemPromptMode === "replace" ? existingSystemPromptMode : "replace"),
    defaultContext: profile.defaultContext ?? existingDefaultContext ?? (legacyContext ? "fork" : "fresh"),
    async: profile.defaultAsync ?? existingDefaultAsync ?? legacyAsync ?? false,
    inheritProjectContext: profile.inheritProjectContext ?? existingProjectContext ?? false,
    inheritGlobalContext: profile.inheritGlobalContext ?? existingGlobalContext ?? false,
    inheritSkills: profile.inheritSkills ?? existingSkills ?? legacySkills ?? false,
  };

  if (toolsExplicit) frontmatter.tools = tools.length > 0 ? tools.join(", ") : "none";
  else delete frontmatter.tools;
  if (model) frontmatter.model = model;
  else delete frontmatter.model;
  if (profile.thinking) frontmatter.thinking = profile.thinking;
  else delete frontmatter.thinking;
  if (profile.acceptanceRole) frontmatter.acceptanceRole = profile.acceptanceRole;
  // pi-subagents 0.68.0 removed fallbackModels and rejects agents that declare it.
  delete frontmatter.fallbackModels;
  delete frontmatter.fallback_models;
  delete frontmatter.load_skills;
  delete frontmatter.load_extensions;
  delete frontmatter.inherit_context;
  delete frontmatter.run_in_background;
  delete frontmatter.max_turns;

  const yaml = stringifyYaml(frontmatter, { lineWidth: 1000 }).trimEnd();
  const fileContent = `---\n${yaml}\n---\n\n${systemPrompt}\n`;
  validateWrite?.(filePath, fileContent);
  writePrivateFileAtomicSync(filePath, fileContent);

  const removed = { ...profile } as SubagentProfile & Record<string, unknown>;
  delete removed.fallbackModels;
  delete removed.fallback_models;
  delete removed.modelOverride;
  delete removed.thinkingOverride;

  return {
    ...removed,
    name,
    displayName,
    description,
    systemPrompt,
    tools,
    toolsExplicit,
    scope,
    filePath,
  };
}

function deleteSubagentProfileUnlocked(
  cwd: string,
  scope: "global" | "project",
  name: string,
): void {
  const safeName = validateAgentName(name);
  const dir = getProfileDirectory(cwd, scope);
  if (scope === "project") assertProjectPathWithinCwd(cwd, dir);
  const filePath = join(dir, `${safeName}.md`);
  if (scope === "project") assertProjectPathWithinCwd(cwd, filePath);
  if (existsSync(filePath)) unlinkSync(filePath);
}


/** Bounded exact source snapshot; no native discovery, runtime or config migration. */
export function readSubagentProfileScope(cwd: string, scope: "global" | "project") {
  const dir = getProfileDirectory(cwd, scope);
  if (scope === "project") assertProjectPathWithinCwd(cwd, dir);
  const contents = new Map<string, string>();
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new ResourceSettingsError("unsupported_path", "Managed profile directory must be a real directory", 422);
    const names = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
    if (names.length > 200) throw new ResourceSettingsError("configuration_too_large", "Profile scope exceeds 200 entries", 413);
    let bytes = 0;
    for (const name of names) {
      const path = join(dir, name);
      if (!lstatSync(path).isFile()) throw new ResourceSettingsError("unsupported_path", "Managed profile entries must be regular files, not links", 422);
      if (scope === "project") assertProjectPathWithinCwd(cwd, path);
      const raw = readRegularFileText(path, PROJECT_SETTINGS_MAX_BYTES);
      if (raw === undefined) throw new ResourceSettingsError("snapshot_changed", "Profile scope changed while being read", 409);
      bytes += Buffer.byteLength(raw);
      if (bytes > 2 * PROJECT_SETTINGS_MAX_BYTES) throw new ResourceSettingsError("configuration_too_large", "Profile scope exceeds 2 MiB", 413);
      contents.set(name, raw);
    }
  }
  const revision = createHash("sha256").update(JSON.stringify({ scope, cwd: realpathSync(cwd), files: [...contents].map(([name, raw]) => [name, createHash("sha256").update(raw).digest("hex")]) })).digest("hex");
  return { revision, profiles: scanProfileDir(dir, scope, cwd, undefined, contents), sourceBytes: new Map([...contents].map(([name, raw]) => [name, Buffer.byteLength(raw)])) };
}

/** Existing UI and managed writers share one short synchronous scope transaction. */
export function withSubagentProfileWrite<T>(
  cwd: string,
  scope: "global" | "project",
  change: (writers: { save: (profile: SubagentProfile) => SubagentProfile; remove: (name: string) => void }) => T,
  validateWrite?: (filePath: string, contents: string) => void,
): T {
  const dir = getProfileDirectory(cwd, scope);
  if (scope === "project") assertProjectPathWithinCwd(cwd, dir);
  // A stable existing anchor also serializes the first write before .pi/agents
  // exists. The ephemeral proper-lockfile lock is removed on every exit.
  const anchor = scope === "global" ? getAgentDir() : resolve(cwd);
  mkdirSync(anchor, { recursive: true });
  const parent = realpathSync(anchor);
  const lockTarget = scope === "global" ? join(anchor, "agents") : join(anchor, ".pi-subagent-profiles");
  let release: () => void;
  try { release = lockfile.lockSync(lockTarget, { realpath: false, retries: 0, stale: 30_000 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new ResourceSettingsError("configuration_busy", "Profile scope is being edited", 409);
    throw error;
  }
  try {
    if (realpathSync(anchor) !== parent) throw new ResourceSettingsError("scope_path_changed", "Profile scope parent changed", 409);
    if (scope === "project") assertProjectPathWithinCwd(cwd, dir);
    return change({ save: (profile) => saveSubagentProfileUnlocked(cwd, scope, profile, validateWrite), remove: (name) => deleteSubagentProfileUnlocked(cwd, scope, name) });
  } finally { release(); }
}

export function saveSubagentProfile(cwd: string, scope: "global" | "project", profile: SubagentProfile): SubagentProfile {
  return withSubagentProfileWrite(cwd, scope, (writers) => writers.save(profile));
}

export function deleteSubagentProfile(cwd: string, scope: "global" | "project", name: string): void {
  return withSubagentProfileWrite(cwd, scope, (writers) => writers.remove(name));
}
