import { inspectCustomPrompts, mutateCustomPrompts, type CustomPromptInput } from "./custom-prompts-state.ts";
import { inspectModelRoutingConfig, mutateModelRoutingConfig, type ModelRoutingConfig } from "./model-routing.ts";
import { MAX_ROUTE_MAX_ATTEMPTS, MIN_ROUTE_MAX_ATTEMPTS } from "./model-routing-shared.ts";
import { inspectSubagentSettings, mutateSubagentSettings, MAX_SUBAGENT_MAX_CONCURRENT, VALID_THINKING_LEVELS } from "./subagent-settings.ts";
import { ResourceSettingsError } from "./resource-config-file.ts";
import { BUILTIN_PROFILES } from "./subagent-profiles.ts";

export { ResourceSettingsError } from "./resource-config-file.ts";

export type ResourceSettingsArea = "subagents_settings" | "custom_prompts" | "model_routing";
export interface ResourceSettingsTarget { area: string; scope: string; cwd?: string }
export interface ResourceSettingsMutation extends ResourceSettingsTarget {
  operation: string;
  changes: unknown;
  expectedRevision: string;
}

export const RESOURCE_SETTINGS_OPERATIONS = {
  subagents_settings: ["patch", "set_profile_enabled", "set_profile_override"],
  custom_prompts: ["upsert", "delete", "reorder"],
  model_routing: ["replace"],
} as const;

function areaOf(input: ResourceSettingsTarget): ResourceSettingsArea {
  if (input.scope !== "global") throw new ResourceSettingsError("unsupported_scope", "This configuration resource supports only global scope", 422);
  if (!Object.hasOwn(RESOURCE_SETTINGS_OPERATIONS, input.area)) throw new ResourceSettingsError("unsupported_area", "Unsupported configuration resource", 422);
  return input.area as ResourceSettingsArea;
}

function record(value: unknown, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ResourceSettingsError("invalid_changes", "changes must be an object");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(result, key))) {
    throw new ResourceSettingsError("invalid_changes", "changes contains unsupported fields or is missing required fields");
  }
  return result;
}

function text(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim()) || value.includes("\0")) {
    throw new ResourceSettingsError("invalid_changes", `${field} must be a ${allowEmpty ? "" : "nonempty "}string of at most ${max} characters`);
  }
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new ResourceSettingsError("invalid_changes", `${field} must be boolean`);
  return value;
}

function thinking(value: unknown): string {
  if (typeof value !== "string" || !(VALID_THINKING_LEVELS as readonly string[]).includes(value)) {
    throw new ResourceSettingsError("invalid_changes", "Unsupported thinking level");
  }
  return value;
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ResourceSettingsError("invalid_changes", `${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function profileName(value: unknown): string {
  const name = text(value, "name", 160).trim();
  if (!BUILTIN_PROFILES.some((profile) => profile.name.toLowerCase() === name.toLowerCase())) {
    throw new ResourceSettingsError("profile_not_found", "Reader built-in profile not found", 404);
  }
  return name;
}

function envelope<T extends { revision: string; value: unknown; changed?: boolean }>(area: ResourceSettingsArea, snapshot: T) {
  return {
    revision: snapshot.revision,
    value: snapshot.value,
    ...(snapshot.changed === undefined ? {} : { changed: snapshot.changed }),
    impact: { scope: "global" as const, runtime: area === "subagents_settings" ? "new_sessions" as const : area === "model_routing" ? "next_turn" as const : "none" as const, restartRequired: false as const },
    supportedOperations: [...RESOURCE_SETTINGS_OPERATIONS[area]],
  };
}

/** Targets come solely from existing business path resolvers, never request paths. */
export function inspectResourceSettings(input: ResourceSettingsTarget) {
  const area = areaOf(input);
  if (area === "subagents_settings") return envelope(area, inspectSubagentSettings());
  if (area === "custom_prompts") return envelope(area, inspectCustomPrompts());
  return envelope(area, inspectModelRoutingConfig());
}

function prepareResourceSettingsChange(input: Omit<ResourceSettingsMutation, "expectedRevision">) {
  const area = areaOf(input);
  if (!(RESOURCE_SETTINGS_OPERATIONS[area] as readonly string[]).includes(input.operation)) throw new ResourceSettingsError("unsupported_operation", "Unsupported resource operation", 422);
  if (area === "subagents_settings") {
    if (input.operation === "patch") {
      const raw = record(input.changes, ["builtInEnabled", "maxConcurrent"]);
      if (!Object.keys(raw).length) throw new ResourceSettingsError("invalid_changes", "At least one setting is required");
      const changes = {
        ...(raw.builtInEnabled === undefined ? {} : { builtInEnabled: boolean(raw.builtInEnabled, "builtInEnabled") }),
        ...(raw.maxConcurrent === undefined ? {} : { maxConcurrent: integer(raw.maxConcurrent, "maxConcurrent", 1, MAX_SUBAGENT_MAX_CONCURRENT) }),
      };
      return (revision: string) => envelope(area, mutateSubagentSettings({ operation: "patch", changes }, revision));
    }
    if (input.operation === "set_profile_enabled") {
      const raw = record(input.changes, ["name", "enabled"], ["name", "enabled"]);
      const changes = { name: profileName(raw.name), enabled: boolean(raw.enabled, "enabled") };
      return (revision: string) => envelope(area, mutateSubagentSettings({ operation: "set_profile_enabled", changes }, revision));
    }
    const raw = record(input.changes, ["name", "model", "thinking"], ["name"]);
    if (!Object.hasOwn(raw, "model") && !Object.hasOwn(raw, "thinking")) throw new ResourceSettingsError("invalid_changes", "model or thinking is required");
    const changes = {
      name: profileName(raw.name),
      ...(Object.hasOwn(raw, "model") ? { model: raw.model === null ? null : text(raw.model, "model", 300) } : {}),
      ...(Object.hasOwn(raw, "thinking") ? { thinking: raw.thinking === null ? null : thinking(raw.thinking) } : {}),
    };
    return (revision: string) => envelope(area, mutateSubagentSettings({ operation: "set_profile_override", changes }, revision));
  }
  if (area === "custom_prompts") {
    if (input.operation === "upsert") {
      const raw = record(input.changes, ["id", "title", "content", "description", "order"], ["title", "content"]);
      const changes: CustomPromptInput = {
        title: text(raw.title, "title", 512, true), content: text(raw.content, "content", 131072, true),
        ...(raw.id === undefined ? {} : { id: text(raw.id, "id", 200).trim() }),
        ...(raw.description === undefined ? {} : { description: text(raw.description, "description", 4096, true) }),
        ...(raw.order === undefined ? {} : { order: integer(raw.order, "order", 0, 1000000) }),
      };
      if (!changes.title.trim() && !changes.content.trim()) throw new ResourceSettingsError("invalid_changes", "title or content is required");
      return (revision: string) => envelope(area, mutateCustomPrompts({ operation: "upsert", changes }, revision));
    }
    if (input.operation === "delete") {
      const raw = record(input.changes, ["id"], ["id"]);
      const changes = { id: text(raw.id, "id", 200) };
      return (revision: string) => envelope(area, mutateCustomPrompts({ operation: "delete", changes }, revision));
    }
    const raw = record(input.changes, ["orderedIds"], ["orderedIds"]);
    if (!Array.isArray(raw.orderedIds) || raw.orderedIds.length > 10000) throw new ResourceSettingsError("invalid_changes", "orderedIds must be an array with at most 10000 ids");
    const orderedIds = raw.orderedIds.map((id) => text(id, "id", 200));
    if (new Set(orderedIds).size !== orderedIds.length) throw new ResourceSettingsError("invalid_changes", "orderedIds must be unique");
    return (revision: string) => envelope(area, mutateCustomPrompts({ operation: "reorder", changes: { orderedIds } }, revision));
  }
  const raw = record(input.changes, ["enabled", "routes"], ["enabled", "routes"]);
  if (!Array.isArray(raw.routes) || raw.routes.length > 64) throw new ResourceSettingsError("invalid_changes", "routes must be an array with at most 64 entries");
  const config: ModelRoutingConfig = {
    enabled: boolean(raw.enabled, "enabled"),
    routes: raw.routes.map((value) => {
      const route = record(value, ["id", "provider", "model", "thinkingLevel", "maxAttempts"], ["id", "provider", "model", "thinkingLevel"]);
      return {
        id: text(route.id, "id", 200), provider: text(route.provider, "provider", 300).trim(), model: text(route.model, "model", 300).trim(), thinkingLevel: thinking(route.thinkingLevel),
        ...(route.maxAttempts === undefined ? {} : { maxAttempts: integer(route.maxAttempts, "maxAttempts", MIN_ROUTE_MAX_ATTEMPTS, MAX_ROUTE_MAX_ATTEMPTS) }),
      };
    }),
  };
  if (new Set(config.routes.map((route) => route.id)).size !== config.routes.length) throw new ResourceSettingsError("invalid_changes", "Route ids must be unique");
  return (revision: string) => envelope(area, mutateModelRoutingConfig(config, revision));
}

/** Pure validation shared by dry-run and the lifecycle's pre-reservation check. */
export function validateResourceSettingsChange(input: Omit<ResourceSettingsMutation, "expectedRevision">): void {
  prepareResourceSettingsChange(input);
}

export function mutateResourceSettings(input: ResourceSettingsMutation) {
  if (typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) {
    throw new ResourceSettingsError("revision_required", "expectedRevision must be the revision returned by inspect", 428);
  }
  return prepareResourceSettingsChange(input)(input.expectedRevision);
}
