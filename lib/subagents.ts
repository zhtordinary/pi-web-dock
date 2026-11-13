import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Extension, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { dump as stringifyYaml } from "js-yaml";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { parseFrontmatter } from "./frontmatter";
import { parseReaderNativeProfile } from "./subagent-profile-reader";
import { parseNpmSource } from "./npm-source";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isExistingPathWithinRoots } from "./path-security";
import { disabledBuiltInSubagents, getSubagentSettingsPath, readBuiltInSubagentOverride } from "./subagent-settings";
import { PRESET_READ_ONLY } from "./tool-presets";
import type { SessionEntry, SubagentSessionStatus } from "./types";

export const SUBAGENT_META_TYPE = "pi-web:subagent";
export const SUBAGENT_STATUS_TYPE = "pi-web:subagent-status";
export const SUBAGENT_RESULT_TYPE = "pi-web:subagent-result";
export const SUBAGENT_CONTROL_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent"] as const;

export type SubagentStatus = SubagentSessionStatus;
export type SubagentCodemode = "inherit" | "on" | "off";
export type SubagentMcp = "on" | "off";
export type SubagentScope = "builtin" | "global" | "workspace" | "project";
export type SubagentWritableScope = Extract<SubagentScope, "global" | "project">;

export interface SubagentProfile {
  name: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  extensionTools?: string[];
  /** Optional discovered skill names; absent means the full discovered skill catalog. */
  skills?: string[];
  /** Optional extension names; absent means every loaded extension. */
  extensions?: string[];
  /** Raw `ext:` deny selectors, resolved against the loaded extensions at spawn time. */
  disallowedExtensionTools?: string[];
  loadSkills: boolean;
  loadExtensions: boolean;
  /** Native code mode capability. Usable profiles default to on; chat-only profiles stay off. */
  codemode?: SubagentCodemode;
  /** Child MCP host capability. Omitted profiles are disabled. */
  mcp?: SubagentMcp;
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
  promptMode: "replace" | "append";
  color?: string;
  isolation?: "worktree" | "off";
  persistSession?: boolean;
  enabled: boolean;
  scope: SubagentScope;
  filePath?: string;
}

export interface SubagentMetadata {
  version: 1;
  parentSessionId: string;
  parentSessionPath: string;
  parentToolCallId: string;
  profile: string;
  description: string;
  /** Effective provider/model selected for this child when known. */
  model?: string;
  task: string;
  runInBackground: boolean;
  createdAt: string;
  resourceSnapshot: SubagentResourceSnapshot;
  worktreePath?: string;
  worktreeBranch?: string;
}

export interface SubagentResourceSnapshot {
  version: 1;
  appendSystemPrompt: string[];
  tools: string[];
  loadSkills: boolean;
  loadExtensions: boolean;
  codemode?: true;
  mcp?: true;
  /** True when no ext: selector was supplied and every loaded extension tool is admitted. */
  allExtensionTools?: true;
  skills?: string[];
  extensions?: string[];
  maxTurns?: number;
  exactSystemPrompt?: string;
}

export interface SubagentSessionResources {
  appendSystemPrompt: string[];
  tools: string[];
  loadSkills: boolean;
  loadExtensions: boolean;
  codemode?: true;
  mcp?: true;
  allExtensionTools?: true;
  skills?: string[];
  extensions?: string[];
  maxTurns?: number;
  exactSystemPrompt?: string;
}

export interface SubagentResultMetadata {
  version: 1;
  status: Exclude<SubagentStatus, "starting" | "running" | "queued" | "interrupted">;
  completedAt: string;
  result?: string;
  error?: string;
  worktreeCleanupError?: string;
  /** Whether an isolated run's worktree path still existed when this entry was written (#1202). */
  worktreeExists?: boolean;
}

export interface SubagentStatusMetadata {
  version: 1;
  status: Extract<SubagentStatus, "queued" | "running">;
}

export interface SubagentRunInfo {
  sessionId: string;
  sessionPath: string;
  parentSessionId: string;
  parentToolCallId: string;
  profile: string;
  description: string;
  /** Effective provider/model selected for this child when known. */
  model?: string;
  task: string;
  runInBackground: boolean;
  status: SubagentStatus;
  createdAt: string;
  completedAt?: string;
  result?: string;
  error?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeCleanupError?: string;
  /** Set once the run's result is recorded, as `SubagentResultMetadata.worktreeExists`. */
  worktreeExists?: boolean;
  /** Set on a run started by `resume`, which reuses the session ID of an earlier run. Not persisted. */
  resumed?: boolean;
}

const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const BUILTIN_TOOLS = new Set(DEFAULT_TOOLS);
// `powershell` is added by resolveShellTools on platforms that provide it. It is
// still a valid historical snapshot tool and must not turn a valid child into a
// legacy/ordinary session during reopen.
const SNAPSHOT_BUILTIN_TOOLS = new Set([...DEFAULT_TOOLS, "powershell"]);
const SUBAGENT_CONTROL_TOOLS = new Set<string>(SUBAGENT_CONTROL_TOOL_NAMES);
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Frontmatter keys the web UI owns. Everything else in a profile file belongs to
 * whichever runtime reads it (pi-subagents and friends), so a save from this app must
 * carry those keys through untouched. Dropping them silently changed behaviour:
 * `allowed_subagents` was lost and an orchestrator could no longer spawn anything,
 * `exclude_extensions` was lost and an opt-out became an opt-in.
 */
const MANAGED_FRONTMATTER_KEYS = new Set([
  "description",
  "display_name",
  "tools",
  "load_skills",
  "load_extensions",
  "codemode",
  "mcp",
  "enabled",
  "inherit_context",
  "run_in_background",
  "model",
  "thinking",
  "max_turns",
  "prompt_mode",
  "color",
  "isolation",
  "persist_session",
]);

const FRONTMATTER_OPEN_RE = /^(?:\uFEFF)?---[ \t]*(?:\r\n|\n|\r)/;

/**
 * The UI exposes two booleans (`load_skills` / `load_extensions`); pi-subagents reads
 * the aliases `skills` / `extensions`, which also accept a whitelist. Aliases are
 * carried through by `unmanagedFrontmatter` and only rewritten once we own them.
 */
const OWNED_ALIAS_VALUES = new Set(["none", "all", "true", "false"]);

function parseCodemode(value: unknown, fallback: SubagentCodemode = "on"): SubagentCodemode {
  if (value === "on" || value === true) return "on";
  if (value === "inherit") return "inherit";
  if (value === undefined) return fallback;
  return "off";
}

function validateSavedCodemode(value: unknown, fallback: SubagentCodemode = "on"): SubagentCodemode {
  if (value === undefined || value === "inherit" || value === "on" || value === "off") {
    return value === undefined ? fallback : value;
  }
  throw new Error("codemode must be one of: inherit, on, off");
}

function parseMcp(value: unknown, fallback: SubagentMcp = "on"): SubagentMcp {
  return value === undefined ? fallback : value === "on" || value === true ? "on" : "off";
}

function validateSavedMcp(value: unknown): SubagentMcp | undefined {
  if (value === undefined || value === "on" || value === "off") return value;
  throw new Error("mcp must be one of: on, off");
}

const BUILTIN_PROFILES: SubagentProfile[] = [
  {
    name: "general-purpose",
    displayName: "General purpose",
    description: "Handle a focused implementation or investigation task",
    systemPrompt: "Work autonomously on the delegated task. Keep the final answer concise and include important files, decisions, and remaining risks.",
    tools: DEFAULT_TOOLS,
    loadSkills: true,
    loadExtensions: true,
    codemode: "inherit",
    mcp: "on",
    promptMode: "append",
    inheritContext: false,
    runInBackground: true,
    enabled: true,
    scope: "builtin",
  },
  {
    name: "explore",
    displayName: "Explore",
    description: "Quickly inspect a codebase without modifying it",
    systemPrompt: "Explore the codebase to answer the delegated question. Do not modify files. Report concrete findings with file paths and relevant symbols.",
    tools: [...PRESET_READ_ONLY],
    loadSkills: true,
    loadExtensions: true,
    codemode: "inherit",
    mcp: "on",
    promptMode: "append",
    inheritContext: false,
    runInBackground: true,
    enabled: true,
    scope: "builtin",
  },
  {
    name: "plan",
    displayName: "Plan",
    description: "Design an implementation plan without modifying files",
    systemPrompt: "Produce an implementation-ready plan for the delegated task. Inspect the repository as needed, do not modify files, and call out dependencies, risks, and verification steps.",
    tools: [...PRESET_READ_ONLY],
    loadSkills: true,
    loadExtensions: true,
    codemode: "inherit",
    mcp: "on",
    promptMode: "append",
    inheritContext: false,
    runInBackground: true,
    enabled: true,
    scope: "builtin",
  },
];

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function resourceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["none", "false"].includes(normalized)) return false;
    if (!normalized) return fallback;
    return true;
  }
  return Array.isArray(value) ? true : fallback;
}

/** Skill/extension names from a list or comma-separated string. */
export function subagentNameList(value: unknown): string[] {
  const items: unknown[] = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(items
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))];
}

function profileNameList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return subagentNameList(value);
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["none", "all", "true", "false"].includes(normalized)) return undefined;
  return subagentNameList(value);
}

function stringList(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return values.map((item) => String(item).trim()).filter(Boolean);
}

function parseTools(value: unknown, fallback: string[]): string[] {
  const tools = stringList(value);
  if (tools.includes("none")) return [];
  if (tools.includes("all") || tools.includes("*")) return [...DEFAULT_TOOLS];
  if (tools.length === 0) return [...fallback];
  return [...new Set(tools.filter((tool) => BUILTIN_TOOLS.has(tool)))];
}

function rawToolValues(value: unknown): string[] {
  return stringList(value);
}

function parseExtensionToolSelectors(value: unknown): string[] {
  return [...new Set(rawToolValues(value).filter((tool) => tool.toLowerCase().startsWith("ext:")))];
}

/** Read existing frontmatter without allowing malformed metadata to be overwritten. */
function readStoredFrontmatter(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  const source = readFileSync(filePath, "utf8");
  const { data } = parseFrontmatter(source);
  if (data) return data;
  if (FRONTMATTER_OPEN_RE.test(source)) {
    throw new Error("Cannot save agent profile: existing frontmatter is invalid");
  }
  return {};
}

/** Keys another runtime owns, in file order, so a save round-trips them. */
function unmanagedFrontmatter(stored: Record<string, unknown>): Record<string, unknown> {
  const preserved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (!MANAGED_FRONTMATTER_KEYS.has(key)) preserved[key] = value;
  }
  return preserved;
}

/**
 * pi-web filters `tools` down to the built-ins it can dispatch, which would drop
 * another runtime's `ext:<name>` selectors on every save — carry them through.
 */
function composeToolsField(
  tools: string[],
  storedTools: unknown,
  preserveStoredExtensionSelectors = true,
): string {
  const selectors = preserveStoredExtensionSelectors
    ? stringList(storedTools).filter((tool) => tool.toLowerCase().startsWith("ext:"))
    : [];
  const combined = [...tools, ...selectors.filter((selector) => !tools.some((tool) => tool.toLowerCase() === selector.toLowerCase()))];
  return combined.length > 0 ? combined.join(", ") : "none";
}

/**
 * Keep the alias in step with the boolean the UI owns. A boolean (or a "none" /
 * "all" spelling) is ours to rewrite; a whitelist such as `extensions:
 * pi-advisor-flow` expresses scoping the UI cannot show, so it stays as authored.
 */
function syncFlagAlias(
  frontmatter: Record<string, unknown>,
  alias: string,
  storedValue: unknown,
  flag: boolean,
): void {
  const owned = storedValue === undefined
    || typeof storedValue === "boolean"
    || (typeof storedValue === "string" && OWNED_ALIAS_VALUES.has(storedValue.trim().toLowerCase()));
  if (owned) frontmatter[alias] = flag;
}
function parseProfileFile(filePath: string, scope: SubagentScope): SubagentProfile | null {
  try {
    const source = readFileSync(filePath, "utf8");
    const { data, rest } = parseFrontmatter(source);
    const name = stringValue(data?.name) ?? basename(filePath, ".md");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
    const thinkingValue = stringValue(data?.thinking) as ThinkingLevel | undefined;
    const reader = parseReaderNativeProfile(data);
    const tools = parseTools(data?.tools, DEFAULT_TOOLS);
    const extensionSelectors = parseExtensionToolSelectors(data?.tools);
    const skills = profileNameList(data?.skills);
    const extensions = profileNameList(data?.extensions);
    const disallowedTools = new Set(parseTools(data?.disallowed_tools, []));
    // The deny list is also handed to the runtime, which resolves both sides against the
    // loaded extensions. This parse-time filter is only the cheap literal fast path: it
    // cannot see extension aliases (`ext:codegraph` vs `ext:@scope/pi-codegraph`), so it
    // must never be the only gate.
    const disallowedExtensionTools = parseExtensionToolSelectors(data?.disallowed_tools);
    const deniedKeys = new Set(
      disallowedExtensionTools.map((tool) => normalizeExtensionSelector(tool).toLowerCase()),
    );
    const extensionTools = extensionSelectors
      .filter((tool) => {
        const allowed = normalizeExtensionSelector(tool).toLowerCase();
        return ![...deniedKeys].some((denied) => (
          denied === "*" || allowed === denied || allowed.startsWith(`${denied}/`)
        ));
      });
    return {
      name,
      displayName: stringValue(data?.display_name) ?? name,
      description: stringValue(data?.description) ?? name,
      systemPrompt: rest.trim(),
      tools: tools.filter((tool) => !disallowedTools.has(tool)),
      ...(extensionSelectors.length > 0 ? { extensionTools } : {}),
      ...(disallowedExtensionTools.length > 0 ? { disallowedExtensionTools } : {}),
      ...(skills !== undefined ? { skills } : {}),
      ...(extensions !== undefined ? { extensions } : {}),
      loadSkills: reader?.loadSkills ?? resourceBoolean(data?.load_skills ?? data?.skills, true),
      loadExtensions: reader?.loadExtensions ?? resourceBoolean(data?.load_extensions ?? data?.extensions, true),
      codemode: reader?.codemode ?? parseCodemode(
        data?.codemode,
        tools.length > 0 || resourceBoolean(data?.load_skills ?? data?.skills, false)
          || resourceBoolean(data?.load_extensions ?? data?.extensions, extensionSelectors.length > 0)
          ? "inherit"
          : "off",
      ),
      mcp: reader?.mcp ?? parseMcp(data?.mcp),
      ...(stringValue(data?.model) ? { model: stringValue(data?.model) } : {}),
      ...(thinkingValue && THINKING_LEVELS.has(thinkingValue) ? { thinking: thinkingValue } : {}),
      ...(reader?.maxTurns ? { maxTurns: reader.maxTurns } : {}),
      inheritContext: reader?.inheritContext ?? booleanValue(data?.inherit_context, false),
      runInBackground: reader?.runInBackground ?? booleanValue(data?.run_in_background, true),
      promptMode: reader?.promptMode
        ?? (data?.prompt_mode === "replace" ? "replace" : "append"),
      ...(stringValue(data?.color) ? { color: stringValue(data?.color) } : {}),
      ...(data?.isolation === "worktree" || data?.isolation === "off" ? { isolation: data.isolation } : {}),
      ...(typeof data?.persist_session === "boolean" ? { persistSession: data.persist_session } : {}),
      enabled: booleanValue(data?.enabled, true),
      scope,
      filePath,
    };
  } catch {
    return null;
  }
}

function isProjectProfilePathAllowed(cwd: string, target: string): boolean {
  return isExistingPathWithinRoots(target, new Set([cwd]));
}

function readProfileDirectory(dir: string, scope: SubagentScope, cwd: string): SubagentProfile[] {
  if (!existsSync(dir)) return [];
  if (scope !== "global" && !isProjectProfilePathAllowed(cwd, dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => parseProfileFile(join(dir, entry.name), scope))
    .filter((profile): profile is SubagentProfile => profile !== null);
}

function profileDirectories(cwd: string, agentDir = getAgentDir()): Array<[string, Exclude<SubagentScope, "builtin">]> {
  return [
    [join(agentDir, "agents"), "global"],
    [join(resolve(cwd), ".agents", "agents"), "workspace"],
    [join(resolve(cwd), ".pi", "agents"), "project"],
  ];
}

/**
 * A built-in has no file, so `enabled: false` cannot be written next to it the way
 * it is for a profile on disk. Its off state is a name in `agents/settings.json`
 * instead of a copied-out override file, which would otherwise freeze the built-in
 * prompt at the version it was copied from.
 */
function builtInProfiles(agentDir = getAgentDir()): SubagentProfile[] {
  const settingsPath = getSubagentSettingsPath(agentDir);
  const disabled = disabledBuiltInSubagents(settingsPath);
  return BUILTIN_PROFILES.map((profile) => {
    const override = readBuiltInSubagentOverride(profile.name, settingsPath);
    return {
      ...profile,
      tools: [...profile.tools],
      ...(override.model ? { model: override.model } : {}),
      ...(override.thinking ? { thinking: override.thinking as ThinkingLevel } : {}),
      enabled: !disabled.has(profile.name.toLowerCase()),
    };
  });
}

/** Every configured source, including profiles shadowed by a higher-precedence scope. */
export function listSubagentProfileSources(cwd: string, agentDir = getAgentDir()): SubagentProfile[] {
  const profiles = builtInProfiles(agentDir);
  for (const [dir, scope] of profileDirectories(cwd, agentDir)) {
    profiles.push(...readProfileDirectory(dir, scope, cwd));
  }
  return profiles.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function listSubagentProfiles(cwd: string, agentDir = getAgentDir()): SubagentProfile[] {
  // A same-name file replaces the built-in outright, its own `enabled` included.
  const byName = new Map(builtInProfiles(agentDir).map((profile) => [profile.name.toLowerCase(), profile]));
  for (const [dir, scope] of profileDirectories(cwd, agentDir)) {
    for (const profile of readProfileDirectory(dir, scope, cwd)) byName.set(profile.name.toLowerCase(), profile);
  }
  return [...byName.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function resolveSubagentProfile(cwd: string, name: string, agentDir = getAgentDir()): SubagentProfile | undefined {
  return listSubagentProfiles(cwd, agentDir).find((profile) => profile.name.toLowerCase() === name.trim().toLowerCase() && profile.enabled);
}

function assertProfileName(name: string): string {
  const normalized = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)) {
    throw new Error("Agent name may contain only letters, numbers, dots, underscores, and hyphens");
  }
  return normalized;
}

function writableProfileDirectory(cwd: string, scope: SubagentWritableScope): string {
  if (scope === "global") return join(getAgentDir(), "agents");
  if (scope === "project") return join(resolve(cwd), ".pi", "agents");
  throw new Error("Agent scope must be global or project");
}

function assertWritableProfileDirectory(cwd: string, scope: SubagentWritableScope): string {
  const dir = writableProfileDirectory(cwd, scope);
  if (scope === "global") return dir;

  let existingAncestor = dir;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) throw new Error("Agent profile directory is outside the project root");
    existingAncestor = parent;
  }
  if (!isProjectProfilePathAllowed(cwd, existingAncestor)) {
    throw new Error("Agent profile directory is outside the project root");
  }
  return dir;
}

export function saveSubagentProfile(
  cwd: string,
  scope: SubagentWritableScope,
  profile: Omit<SubagentProfile, "scope" | "filePath">,
): SubagentProfile {
  const name = assertProfileName(profile.name);
  const tools = [...new Set(profile.tools.filter((tool) => BUILTIN_TOOLS.has(tool)))];
  const extensionTools = [...new Set(profile.extensionTools ?? [])];
  if (profile.thinking && !THINKING_LEVELS.has(profile.thinking)) {
    throw new Error(`Invalid thinking level: ${profile.thinking}`);
  }
  if (profile.maxTurns !== undefined && (!Number.isFinite(profile.maxTurns) || profile.maxTurns < 0)) {
    throw new Error("Max turns must be a non-negative number");
  }
  const maxTurns = profile.maxTurns && profile.maxTurns > 0
    ? Math.floor(profile.maxTurns)
    : undefined;
  const displayName = profile.displayName.trim() || name;
  const description = profile.description.trim() || name;
  const systemPrompt = profile.systemPrompt.trim();
  const model = profile.model?.trim() || undefined;
  const loadSkills = profile.loadSkills === true;
  const loadExtensions = profile.loadExtensions === true;
  const codemode = validateSavedCodemode(
    profile.codemode,
    tools.length > 0 || extensionTools.length > 0 || profile.loadSkills || profile.loadExtensions ? "on" : "off",
  );
  const requestedMcp = validateSavedMcp(profile.mcp);
  const promptMode = profile.promptMode === "replace" ? "replace" : "append";
  const dir = assertWritableProfileDirectory(cwd, scope);
  mkdirSync(dir, { recursive: true });
  if (scope === "project" && !isProjectProfilePathAllowed(cwd, dir)) {
    throw new Error("Agent profile directory is outside the project root");
  }
  const filePath = join(dir, `${name}.md`);
  const stored = readStoredFrontmatter(filePath);
  const mcp = requestedMcp ?? parseMcp(stored.mcp);
  const preserveStoredExtensionSelectors = profile.extensionTools === undefined;
  const managed: Record<string, unknown> = {
    description,
    display_name: displayName,
    tools: composeToolsField(
      [...tools, ...extensionTools],
      stored.tools,
      preserveStoredExtensionSelectors,
    ),
    load_skills: loadSkills,
    load_extensions: loadExtensions,
    codemode,
    ...(mcp === "on" || stored.mcp !== undefined ? { mcp } : {}),
    enabled: profile.enabled,
    inherit_context: profile.inheritContext,
    run_in_background: profile.runInBackground,
    prompt_mode: promptMode,
  };
  if (profile.skills !== undefined) managed.skills = [...new Set(profile.skills.map((name) => name.trim()).filter(Boolean))];
  else syncFlagAlias(managed, "skills", stored.skills, loadSkills);
  if (profile.extensions !== undefined) managed.extensions = [...new Set(profile.extensions.map((name) => name.trim()).filter(Boolean))];
  else syncFlagAlias(managed, "extensions", stored.extensions, loadExtensions);
  if (model) managed.model = model;
  if (profile.thinking) managed.thinking = profile.thinking;
  if (maxTurns) managed.max_turns = maxTurns;
  if (profile.color?.trim()) managed.color = profile.color.trim();
  if (profile.isolation) managed.isolation = profile.isolation;
  if (profile.persistSession !== undefined) managed.persist_session = profile.persistSession;
  // Managed keys win; keys this app does not own follow in their original order.
  const frontmatter: Record<string, unknown> = { ...managed };
  for (const [key, value] of Object.entries(unmanagedFrontmatter(stored))) {
    if (!(key in frontmatter)) frontmatter[key] = value;
  }
  const yaml = stringifyYaml(frontmatter, { noRefs: true, lineWidth: 1000 }).trimEnd();
  writePrivateFileAtomicSync(filePath, `---\n${yaml}\n---\n\n${systemPrompt}\n`);
  return {
    ...profile,
    name,
    displayName,
    description,
    systemPrompt,
    tools,
    ...(profile.extensionTools !== undefined ? { extensionTools } : {}),
    ...(profile.skills !== undefined ? { skills: [...new Set(profile.skills.map((name) => name.trim()).filter(Boolean))] } : {}),
    ...(profile.extensions !== undefined ? { extensions: [...new Set(profile.extensions.map((name) => name.trim()).filter(Boolean))] } : {}),
    loadSkills,
    loadExtensions,
    codemode,
    mcp,
    ...(model ? { model } : { model: undefined }),
    ...(maxTurns ? { maxTurns } : { maxTurns: undefined }),
    promptMode,
    ...(profile.color ? { color: profile.color } : {}),
    ...(profile.isolation ? { isolation: profile.isolation } : {}),
    ...(profile.persistSession !== undefined ? { persistSession: profile.persistSession } : {}),
    scope,
    filePath,
  };
}

export function deleteSubagentProfile(cwd: string, scope: SubagentWritableScope, name: string): void {
  const safeName = assertProfileName(name);
  const filePath = join(assertWritableProfileDirectory(cwd, scope), `${safeName}.md`);
  if (existsSync(filePath)) unlinkSync(filePath);
}

export function saveProjectSubagentProfile(cwd: string, profile: Omit<SubagentProfile, "scope" | "filePath">): SubagentProfile {
  return saveSubagentProfile(cwd, "project", profile);
}

export function deleteProjectSubagentProfile(cwd: string, name: string): void {
  deleteSubagentProfile(cwd, "project", name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ValidSubagentMetadataData = Record<string, unknown> & {
  version: 1;
  parentSessionId: string;
  parentSessionPath: string;
};

function subagentMetadataData(entries: readonly SessionEntry[]): ValidSubagentMetadataData | null {
  const metaEntry = entries.find((entry) => entry.type === "custom" && entry.customType === SUBAGENT_META_TYPE);
  if (!metaEntry || metaEntry.type !== "custom" || !isRecord(metaEntry.data)) return null;
  const data = metaEntry.data;
  if (data.version !== 1 || typeof data.parentSessionId !== "string" || typeof data.parentSessionPath !== "string") return null;
  return data as ValidSubagentMetadataData;
}

/** True when the transcript claims to carry a v1 resource snapshot. */
export function hasSubagentResourceSnapshot(entries: readonly SessionEntry[]): boolean {
  return entries.some((entry) =>
    entry.type === "custom"
    && entry.customType === SUBAGENT_META_TYPE
    && isRecord(entry.data)
    && "resourceSnapshot" in entry.data
  );
}

function assistantTextFromSessionEntries(entries: readonly SessionEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const content = entry.message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
          .filter((block) => block.type === "text")
          .map((block) => block.type === "text" ? block.text : "")
          .join("")
        : "";
    if (text.trim()) return text.trim();
  }
  return undefined;
}

/** Restore the isolated prompt and tool scope used by a persisted subagent session. */
export function readSubagentSessionResources(
  entries: readonly SessionEntry[],
): SubagentSessionResources | null {
  const data = subagentMetadataData(entries);
  if (!data) return null;
  const snapshot = data.resourceSnapshot;
  // A missing snapshot is the pre-v0.12 legacy shape and stays compatible. Once the
  // field exists, every known field is checked before the session can be reopened.
  if (!isRecord(snapshot) || snapshot.version !== 1) return null;

  const strictList = (key: "skills" | "extensions"): string[] | undefined | null => {
    if (!(key in snapshot)) return undefined;
    const value = snapshot[key];
    if (!Array.isArray(value)) return null;
    if (!value.every((item) => typeof item === "string" && item.length > 0 && item.trim() === item)) return null;
    return [...new Set(value)];
  };
  const strictBoolean = (
    key: "loadSkills" | "loadExtensions" | "codemode" | "mcp" | "allExtensionTools",
  ): boolean | null => {
    if (!(key in snapshot)) return false;
    return typeof snapshot[key] === "boolean" ? snapshot[key] : null;
  };
  const skills = strictList("skills");
  const extensions = strictList("extensions");
  const loadSkills = strictBoolean("loadSkills");
  const loadExtensions = strictBoolean("loadExtensions");
  const codemode = strictBoolean("codemode");
  const mcp = strictBoolean("mcp");
  const allExtensionTools = strictBoolean("allExtensionTools");
  if (
    skills === null
    || extensions === null
    || loadSkills === null
    || loadExtensions === null
    || codemode === null
    || mcp === null
    || allExtensionTools === null
    || !Array.isArray(snapshot.appendSystemPrompt)
    || !snapshot.appendSystemPrompt.every((item) => typeof item === "string")
    || !Array.isArray(snapshot.tools)
    || !snapshot.tools.every((item) => typeof item === "string" && item.length > 0 && item.trim() === item)
    || (allExtensionTools && !loadExtensions)
    || ("exactSystemPrompt" in snapshot && typeof snapshot.exactSystemPrompt !== "string")
    || ("maxTurns" in snapshot && (
      typeof snapshot.maxTurns !== "number"
      || !Number.isSafeInteger(snapshot.maxTurns)
      || snapshot.maxTurns <= 0
    ))
  ) return null;

  const isMcpTool = (name: string) => (
    name.startsWith("mcp__")
    || name === "list_mcp_resources"
    || name === "list_mcp_resource_templates"
    || name === "read_mcp_resource"
  );
  const tools = [...new Set(snapshot.tools)];
  if (!tools.every((name) => {
    if (SUBAGENT_CONTROL_TOOLS.has(name)) return false;
    if (SNAPSHOT_BUILTIN_TOOLS.has(name)) return true;
    if (name === "codemode") return codemode;
    if (name === "tool_search") return codemode || mcp;
    if (isMcpTool(name)) return mcp;
    return loadExtensions;
  })) return null;

  return {
    appendSystemPrompt: [...snapshot.appendSystemPrompt],
    tools,
    loadSkills,
    loadExtensions,
    ...(codemode ? { codemode: true as const } : {}),
    ...(mcp ? { mcp: true as const } : {}),
    ...(allExtensionTools ? { allExtensionTools: true as const } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(extensions !== undefined ? { extensions } : {}),
    ...(typeof snapshot.maxTurns === "number" ? { maxTurns: snapshot.maxTurns } : {}),
    ...(typeof snapshot.exactSystemPrompt === "string" ? { exactSystemPrompt: snapshot.exactSystemPrompt } : {}),
  };
}

export function withSubagentExtensionTools(
  profileTools: readonly string[],
  extensionToolNames: Iterable<string>,
): string[] {
  return [...new Set([
    ...profileTools,
    ...[...extensionToolNames].filter((name) => !SUBAGENT_CONTROL_TOOLS.has(name)),
  ])];
}

/** SDK built-ins are stable across the pinned Reader SDK and are shared by spawn/reopen. */
export const SDK_BUILTIN_TOOLS: readonly string[] = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
];
const MCP_TOOL_PATTERNS = ["mcp__*", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

/**
 * Build the SDK tool options from the persisted child scope. This is intentionally shared
 * by fresh spawn and RPC reopen: an empty extension selection must stay empty and must not
 * fall back to the SDK's full default catalog.
 */
export function subagentToolOptions(resources: {
  tools: readonly string[];
  allExtensionTools?: boolean;
  mcp?: boolean;
}) {
  const excludeTools: string[] = [...SUBAGENT_CONTROL_TOOL_NAMES];
  if (!resources.allExtensionTools && resources.mcp) {
    const discovery = resources.tools.includes("codemode") ? [] : ["tool_search"];
    return {
      tools: [...new Set([...resources.tools, ...discovery, ...MCP_TOOL_PATTERNS])],
      excludeTools,
    };
  }
  if (!resources.allExtensionTools) {
    const namesMcp = resources.tools.some((name) => name.startsWith("mcp__"));
    return {
      tools: [...resources.tools],
      excludeTools: namesMcp
        ? excludeTools
        : [...excludeTools, ...MCP_TOOL_PATTERNS.filter((name) => !resources.tools.includes(name))],
    };
  }
  const builtins = resources.tools.filter((name) => SDK_BUILTIN_TOOLS.includes(name));
  const added = resources.tools.includes("codemode") ? [...builtins, "codemode"] : builtins;
  return {
    noTools: "builtin" as const,
    ...(added.length > 0 ? { tools: added.map((name) => `+${name}`) } : {}),
    excludeTools: [...excludeTools, ...SDK_BUILTIN_TOOLS.filter((name) => !builtins.includes(name))],
  };
}

type SubagentExtensionLike = Pick<Extension, "path" | "sourceInfo" | "tools">;

/**
 * Normalize one `ext:` selector to its body: a trailing slash and a trailing star-segment
 * are dropped, so `ext:name`, `ext:name/` and `ext:name/*` are one selector. Shared by the
 * allow list and the deny list so the two cannot disagree on what a selector means.
 */
function normalizeExtensionSelector(selector: string): string {
  const body = selector.slice(4).trim().replace(/\/+$/, "");
  return body.endsWith("/*") ? body.slice(0, -2) : body;
}

function extensionPathParts(extension: SubagentExtensionLike): { parentDir: string; baseName: string } {
  const segments = extension.path.replaceAll("\\", "/").split("/");
  return {
    parentDir: segments.at(-2) ?? extension.path,
    baseName: (segments.at(-1) ?? "").replace(/\.[^.]+$/, ""),
  };
}

/**
 * The source a file belongs to. Only package resources have a real identity in
 * `sourceInfo.source`; top-level ones all carry the shared constant `"local"` (settings
 * entry) or `"auto"` (auto-discovered), so they fall back to their own path — otherwise
 * every unrelated local extension would look like one unit to the name gate below.
 */
function extensionSourceKey(extension: SubagentExtensionLike): string {
  const info = extension.sourceInfo;
  const source = info?.source?.trim();
  return source && info?.origin === "package" ? source : extension.path;
}

/**
 * Every spelling an `ext:<name>` selector could use for one extension: the file's parent
 * directory, its basename, and — for package resources only — the npm source name and that
 * name without its scope (a pinned `npm:@scope/pkg@1.2.3` contributes `@scope/pkg`, not the
 * pin). `"local"` / `"auto"` are deliberately never candidates: they are shared constants,
 * so accepting them would turn `ext:local` into "every local extension".
 */
function extensionCandidateNames(extension: SubagentExtensionLike): string[] {
  const { parentDir, baseName } = extensionPathParts(extension);
  const names = [parentDir, baseName];
  const info = extension.sourceInfo;
  if (info?.origin === "package") {
    const source = (info.source ?? "").trim();
    const packageName = parseNpmSource(source)?.name ?? source;
    names.push(packageName, packageName.replace(/^@[^/]+\//, ""));
  }
  return [...new Set(names.map((name) => name.toLowerCase()).filter(Boolean))];
}

/**
 * Map each candidate name to the set of sources that can offer it. A name claimed by more
 * than one source is not addressable: `index.ts`, a shared `extensions/` directory and two
 * packages collapsing to the same unscoped name (`@a/tool`, `@b/tool`) are all common, and
 * a selector for one of them would otherwise grant tools from unrelated extensions. Several
 * files of the `same` source may share a name — they are one unit, not a collision.
 */
function extensionNameOwners(extensions: readonly SubagentExtensionLike[]): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const extension of extensions) {
    const owner = extensionSourceKey(extension);
    for (const name of extensionCandidateNames(extension)) {
      const claimed = owners.get(name) ?? new Set<string>();
      claimed.add(owner);
      owners.set(name, claimed);
    }
  }
  return owners;
}

interface ExtensionSelectorMatch {
  name: string;
  toolName?: string;
}

/**
 * Resolve one selector against the addressable names found across `every` loaded extension,
 * keeping the longest match, and return the tool name it asked for (if any). Resolving names
 * per extension instead would let `ext:@scope/pkg` bind to the shorter, unrelated name
 * `@scope` offered by a different extension. Extension names are case-insensitive; tool
 * names are matched exactly as authored.
 */
function resolveExtensionSelector(
  selector: string,
  addressableNames: Iterable<string>,
): ExtensionSelectorMatch | null {
  const lower = selector.toLowerCase();
  let best: string | undefined;
  for (const name of addressableNames) {
    if (lower !== name && !lower.startsWith(`${name}/`)) continue;
    if (best === undefined || name.length > best.length) best = name;
  }
  if (best === undefined) return null;
  const toolName = lower === best ? undefined : selector.slice(best.length + 1) || undefined;
  return { name: best, ...(toolName === undefined ? {} : { toolName }) };
}

export function selectSubagentExtensionTools(
  extensions: Iterable<SubagentExtensionLike>,
  selectors: readonly string[],
  deniedSelectors: readonly string[] = [],
): string[] {
  const normalizeAll = (values: readonly string[]) => values
    .filter((selector) => selector.toLowerCase().startsWith("ext:"))
    .map((selector) => normalizeExtensionSelector(selector))
    .filter(Boolean);
  const wanted = normalizeAll(selectors);
  const denied = normalizeAll(deniedSelectors);
  if (wanted.length === 0) return [];
  const loaded = [...extensions];
  const owners = extensionNameOwners(loaded);
  const addressable = new Set([...owners].filter(([, claimed]) => claimed.size === 1).map(([name]) => name));
  const everyExtension = wanted.includes("*");
  const denyEveryExtension = denied.includes("*");
  // Allow and deny are resolved with the *same* candidate names, so a deny written with one
  // alias (`ext:codegraph`) also covers a grant written with another (`ext:@scope/pkg/tool`).
  const resolveAll = (values: readonly string[]) => values.flatMap((selector) => {
    if (selector === "*") return [];
    const match = resolveExtensionSelector(selector, addressable);
    return match === null ? [] : [match];
  });
  const matches = resolveAll(wanted);
  const denials = resolveAll(denied);

  const selected: string[] = [];
  for (const extension of loaded) {
    const toolNames = [...extension.tools.keys()];
    const owned = new Set(extensionCandidateNames(extension).filter((name) => addressable.has(name)));
    const ownedMatches = matches.filter((match) => owned.has(match.name));
    if (!everyExtension && ownedMatches.length === 0) continue;
    const ownedDenials = denials.filter((match) => owned.has(match.name));
    const covers = (match: ExtensionSelectorMatch, toolName: string) => (
      match.toolName === undefined || match.toolName === toolName
    );
    selected.push(...toolNames.filter((toolName) => {
      const granted = everyExtension || ownedMatches.some((match) => covers(match, toolName));
      if (!granted || denyEveryExtension) return false;
      return !ownedDenials.some((match) => covers(match, toolName));
    }));
  }
  return [...new Set(selected)];
}

/** Scope the SDK's final extension set and remove pending provider registrations
 * belonging to dropped extensions. SDK discovery/import remains intact; only the
 * session's final binding is narrowed, matching Reader's allow-list contract. */
export function scopeSubagentExtensions(names: readonly string[], mcp = false, codemode = false) {
  const wanted = new Set(names.map((name) => name.trim().replace(/^ext:/i, "").toLowerCase()).filter(Boolean));
  return (base: LoadExtensionsResult): LoadExtensionsResult => {
    const selected = base.extensions.filter((extension) => (
      extension.path.startsWith("<inline:")
      || (codemode && extension.path === "builtin:codemode")
      || (mcp && (extension.path === "builtin:tool-search" || extension.path === "builtin:mcp"))
      || wanted.has("*")
      || extensionCandidateNames(extension).some((name) => wanted.has(name))
    ));
    const kept = new Set(selected.map((extension) => extension.path));
    const runtime = base.runtime;
    if (runtime) {
      if (runtime.pendingProviderRegistrations) runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((item) => kept.has(item.extensionPath));
      if (runtime.pendingNativeProviderRegistrations) runtime.pendingNativeProviderRegistrations = runtime.pendingNativeProviderRegistrations.filter((item) => kept.has(item.extensionPath));
      if (runtime.pendingVirtualModelRegistrations) runtime.pendingVirtualModelRegistrations = runtime.pendingVirtualModelRegistrations.filter((item) => kept.has(item.extensionPath));
    }
    return { ...base, extensions: selected };
  };
}

/** Extension loader options shared by child creation and reopen/reload. */
export function subagentExtensionLoaderOptions(resources: {
  loadExtensions: boolean;
  extensions?: readonly string[];
  mcp?: boolean;
  codemode?: boolean;
}) {
  const additionalExtensionPaths = [
    ...(resources.codemode ? ["builtin:codemode"] : []),
    ...(resources.mcp ? ["builtin:tool-search", "builtin:mcp"] : []),
  ];
  return {
    noExtensions: !resources.loadExtensions,
    ...(additionalExtensionPaths.length > 0 ? { additionalExtensionPaths } : {}),
    ...(resources.loadExtensions && resources.extensions !== undefined
      ? { extensionsOverride: scopeSubagentExtensions(resources.extensions, resources.mcp === true, resources.codemode === true) }
      : {}),
  };
}

export function readSubagentRun(entries: readonly SessionEntry[], sessionId: string, sessionPath: string): SubagentRunInfo | null {
  const data = subagentMetadataData(entries);
  if (!data) return null;
  const lifecycleIndex = [...entries].findLastIndex((entry) =>
    entry.type === "custom" && (entry.customType === SUBAGENT_RESULT_TYPE || entry.customType === SUBAGENT_STATUS_TYPE)
  );
  const lifecycleEntry = lifecycleIndex >= 0 ? entries[lifecycleIndex] : undefined;
  const resultEntry = lifecycleEntry?.type === "custom" && lifecycleEntry.customType === SUBAGENT_RESULT_TYPE
    ? lifecycleEntry
    : undefined;
  const result = resultEntry?.type === "custom" && isRecord(resultEntry.data) ? resultEntry.data : undefined;
  const statusIndex = [...entries].findLastIndex((entry) =>
    entry.type === "custom" && entry.customType === SUBAGENT_STATUS_TYPE
  );
  const statusEntry = statusIndex >= 0 ? entries[statusIndex] : undefined;
  const statusData = statusEntry?.type === "custom" && isRecord(statusEntry.data) ? statusEntry.data : undefined;
  const persistedStatus = result && (result.status === "completed" || result.status === "failed" || result.status === "aborted")
    ? result.status
    : statusData?.version === 1 && (statusData.status === "queued" || statusData.status === "running")
      ? statusData.status
      : "interrupted";
  const metadataIndex = entries.findIndex((entry) => entry.type === "custom" && entry.customType === SUBAGENT_META_TYPE);
  const partialResult = resultEntry === undefined
    ? assistantTextFromSessionEntries(entries.slice(statusIndex >= 0 ? statusIndex + 1 : metadataIndex + 1))
    : undefined;
  return {
    sessionId,
    sessionPath,
    parentSessionId: data.parentSessionId,
    parentToolCallId: typeof data.parentToolCallId === "string" ? data.parentToolCallId : "",
    profile: typeof data.profile === "string" ? data.profile : "general-purpose",
    description: typeof data.description === "string" ? data.description : "Subagent",
    ...(typeof data.model === "string" && data.model.trim() ? { model: data.model.trim() } : {}),
    task: typeof data.task === "string" ? data.task : "",
    runInBackground: data.runInBackground === true,
    status: persistedStatus,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
    ...(result && typeof result.completedAt === "string" ? { completedAt: result.completedAt } : {}),
    ...(result && typeof result.result === "string" ? { result: result.result } : partialResult ? { result: partialResult } : {}),
    ...(result && typeof result.error === "string" ? { error: result.error } : {}),
    ...(typeof data.worktreePath === "string" ? { worktreePath: data.worktreePath } : {}),
    ...(typeof data.worktreeBranch === "string" ? { worktreeBranch: data.worktreeBranch } : {}),
    ...(result && typeof result.worktreeCleanupError === "string" ? { worktreeCleanupError: result.worktreeCleanupError } : {}),
    ...(result && typeof result.worktreeExists === "boolean" ? { worktreeExists: result.worktreeExists } : {}),
  };
}
