import { basename } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readSubagentProfileScope, withSubagentProfileWrite, BUILTIN_TOOLS, type SubagentProfile } from "./subagent-profiles";
import { VALID_THINKING_LEVELS } from "./subagent-profile-types";
import { getProjectTrustStatus } from "./project-trust";
import { ResourceSettingsError } from "./resource-config-file";

export const PROFILE_OPERATIONS = ["upsert", "delete", "set_enabled"] as const;
export type ProfileTarget = { area: string; scope: string; cwd?: string };
function fail(code: string, message: string, status = 400): never { throw new ResourceSettingsError(code, message, status); }
function targetOf(input: ProfileTarget): { scope: "global" | "project"; cwd: string } {
  if (input.scope !== "global" && input.scope !== "project") fail("unsupported_scope", "Profiles require global or project scope");
  if (typeof input.cwd !== "string" || !input.cwd || !existsSync(input.cwd)) fail("cwd_required", "Profiles require an existing exact cwd");
  return { scope: input.scope, cwd: realpathSync(input.cwd) };
}
function trusted(target: { scope: "global" | "project"; cwd: string }) {
  if (target.scope === "project" && getProjectTrustStatus(target.cwd, getAgentDir()).decision !== true) fail("project_untrusted", "An existing explicit or inherited project trust decision is required", 403);
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_changes", "changes must be an object");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) fail("invalid_changes", "Unknown profile field");
  return result;
}
function text(value: unknown, field: string, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0") || (!empty && !value.trim())) fail("invalid_changes", `Invalid ${field}`);
  return value;
}
function name(value: unknown): string {
  const result = text(value, "name", 128).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result)) fail("invalid_changes", "Invalid profile name");
  return result;
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail("invalid_changes", `${field} must be boolean`);
  return value;
}
function prepare(input: ProfileTarget & { operation: string; changes: unknown }) {
  const target = targetOf(input);
  trusted(target);
  if (!(PROFILE_OPERATIONS as readonly string[]).includes(input.operation)) fail("unsupported_operation", "Unsupported profile operation", 422);
  if (input.operation !== "upsert") {
    const changes = record(input.changes, input.operation === "delete" ? ["name"] : ["name", "enabled"]);
    return { target, name: name(changes.name), ...(input.operation === "set_enabled" ? { enabled: boolean(changes.enabled, "enabled") } : {}) };
  }
  const value = record(input.changes, ["name", "displayName", "description", "systemPrompt", "tools", "enabled", "model", "thinking", "systemPromptMode", "defaultContext", "defaultAsync", "inheritProjectContext", "inheritGlobalContext", "inheritSkills", "acceptanceRole"]);
  const profileName = name(value.name);
  if (!Array.isArray(value.tools) || value.tools.length > BUILTIN_TOOLS.length || value.tools.some((tool) => !(BUILTIN_TOOLS as readonly unknown[]).includes(tool)) || new Set(value.tools).size !== value.tools.length) fail("invalid_changes", "tools must be an explicit unique built-in subset");
  if (value.thinking !== undefined && !(VALID_THINKING_LEVELS as readonly unknown[]).includes(value.thinking)) fail("invalid_changes", "Invalid thinking level");
  for (const [field, choices] of [["defaultContext", ["fresh", "fork"]], ["systemPromptMode", ["replace", "append"]], ["acceptanceRole", ["read-only", "writer"]]] as const) {
    if (value[field] !== undefined && !(choices as readonly unknown[]).includes(value[field])) fail("invalid_changes", `Invalid ${field}`);
  }
  const tools = value.tools as string[];
  const profile: SubagentProfile = {
    name: profileName, scope: target.scope,
    displayName: text(value.displayName ?? profileName, "displayName", 256),
    description: text(value.description ?? profileName, "description", 4096),
    systemPrompt: text(value.systemPrompt, "systemPrompt", 65536, true), tools, toolsExplicit: true,
    enabled: boolean(value.enabled, "enabled"),
    defaultContext: (value.defaultContext ?? "fresh") as "fresh" | "fork",
    defaultAsync: value.defaultAsync === undefined ? true : boolean(value.defaultAsync, "defaultAsync"),
    inheritProjectContext: value.inheritProjectContext === undefined ? true : boolean(value.inheritProjectContext, "inheritProjectContext"),
    inheritGlobalContext: value.inheritGlobalContext === undefined ? true : boolean(value.inheritGlobalContext, "inheritGlobalContext"),
    inheritSkills: value.inheritSkills === undefined ? true : boolean(value.inheritSkills, "inheritSkills"),
    ...(value.model === undefined ? {} : { model: text(value.model, "model", 300) }),
    ...(value.thinking === undefined ? {} : { thinking: value.thinking as string }),
    ...(value.systemPromptMode === undefined ? {} : { systemPromptMode: value.systemPromptMode as "append" | "replace" }),
    ...(value.acceptanceRole === undefined ? {} : { acceptanceRole: value.acceptanceRole as "read-only" | "writer" }),
  };
  return { target, name: profileName, profile };
}
function envelope(target: { scope: "global" | "project"; cwd: string }, snapshot: ReturnType<typeof readSubagentProfileScope>) {
  return { revision: snapshot.revision, value: { profiles: snapshot.profiles.map(({ filePath: _path, systemPrompt, ...profile }) => ({ ...profile, systemPromptPreview: systemPrompt.slice(0, 2048), systemPromptBytes: Buffer.byteLength(systemPrompt), systemPromptTruncated: systemPrompt.length > 2048 })), projectResourcesLoaded: target.scope !== "project" || getProjectTrustStatus(target.cwd, getAgentDir()).decision === true }, supportedOperations: [...PROFILE_OPERATIONS], impact: { scope: target.scope, runtime: "new_sessions" as const, restartRequired: false as const } };
}
export function inspectManagedProfiles(input: ProfileTarget) {
  const target = targetOf(input);
  return envelope(target, readSubagentProfileScope(target.cwd, target.scope));
}
export function validateManagedProfileChange(input: ProfileTarget & { operation: string; changes: unknown }): void {
  const prepared = prepare(input);
  const snapshot = readSubagentProfileScope(prepared.target.cwd, prepared.target.scope);
  if (input.operation === "set_enabled" && !snapshot.profiles.some((profile) => profile.name === prepared.name)) fail("profile_not_found", "Profile not found in exact scope", 404);
}
export function mutateManagedProfiles(input: ProfileTarget & { operation: string; changes: unknown; expectedRevision: string }) {
  const prepared = prepare(input);
  if (!/^[a-f0-9]{64}$/.test(input.expectedRevision)) fail("revision_required", "A current profile scope revision is required", 428);
  if (!existsSync(getAgentDir())) fail("scope_uninitialized", "The agent configuration scope must already exist", 409);
  let sourceBytes = new Map<string, number>();
  return withSubagentProfileWrite(prepared.target.cwd, prepared.target.scope, (writers) => {
    trusted(prepared.target);
    const before = readSubagentProfileScope(prepared.target.cwd, prepared.target.scope);
    sourceBytes = before.sourceBytes;
    if (before.revision !== input.expectedRevision) throw new ResourceSettingsError("revision_conflict", "Profile scope changed", 409, before.revision);
    if (prepared.profile) writers.save(prepared.profile);
    else if (input.operation === "delete") writers.remove(prepared.name);
    else {
      const profile = before.profiles.find((entry) => entry.name === prepared.name);
      if (!profile) fail("profile_not_found", "Profile not found in exact scope", 404);
      if (profile.enabled !== prepared.enabled) writers.save({ ...profile, enabled: prepared.enabled! });
    }
    const after = readSubagentProfileScope(prepared.target.cwd, prepared.target.scope);
    return { ...envelope(prepared.target, after), changed: before.revision !== after.revision };
  }, (filePath, contents) => {
    // Validate the exact business editor bytes before committing, so a budget
    // error never follows a successful write and cannot create a false receipt.
    trusted(prepared.target);
    const size = Buffer.byteLength(contents);
    const next = new Map(sourceBytes); next.set(basename(filePath), size);
    if (size > 1024 * 1024 || next.size > 200 || [...next.values()].reduce((sum, bytes) => sum + bytes, 0) > 2 * 1024 * 1024) fail("configuration_too_large", "Edited profile scope exceeds its bounded read contract", 413);
  });
}
