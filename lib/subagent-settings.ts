import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mutateResourceDocument, readResourceDocument } from "./resource-config-file.ts";

export interface SubagentModelOverride {
  model?: string;
  thinking?: string;
}

export interface SubagentSettings {
  builtInEnabled: boolean;
  /** Built-in profiles switched off, in the spelling the file uses. */
  disabledBuiltIns: string[];
  modelOverrides: Record<string, SubagentModelOverride>;
  maxConcurrent: number;
}

type StoredSubagentSettings = Record<string, unknown> & {
  version?: unknown;
  builtInEnabled?: unknown;
  disabledBuiltIns?: unknown;
  modelOverrides?: unknown;
  maxConcurrent?: unknown;
};

export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 10;
export const MAX_SUBAGENT_MAX_CONCURRENT = 32;
export const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function readMaxConcurrent(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_SUBAGENT_MAX_CONCURRENT
    ? value
    : DEFAULT_SUBAGENT_MAX_CONCURRENT;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Built-in profiles have no file to carry `enabled: false`, so their off state is
 * stored here by name. Entries are kept as authored and matched case-insensitively;
 * a name no built-in claims is preserved rather than dropped, because it usually
 * means the file was written by a newer build.
 */
function readDisabledBuiltIns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function readModelOverrideEntry(value: unknown): SubagentModelOverride {
  if (!isRecord(value)) return {};
  const model = typeof value.model === "string" && value.model.trim() ? value.model.trim() : undefined;
  const thinking = typeof value.thinking === "string" && value.thinking.trim() ? value.thinking.trim() : undefined;
  return {
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

/** The catalog projection is normalized, but this function never becomes a writer input. */
function readModelOverrides(value: unknown): Record<string, SubagentModelOverride> {
  if (!isRecord(value)) return {};
  const result: Record<string, SubagentModelOverride> = {};
  for (const [name, raw] of Object.entries(value)) {
    const entry = readModelOverrideEntry(raw);
    if (Object.keys(entry).length > 0) Object.defineProperty(result, name, { value: entry, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function findCaseInsensitiveKey(value: Record<string, unknown>, name: string): string | undefined {
  const normalized = name.trim().toLowerCase();
  return Object.keys(value).find((key) => key.toLowerCase() === normalized);
}

function settingsValue(
  builtInEnabled: boolean,
  maxConcurrent: number,
  disabledBuiltIns: string[],
  modelOverrides: Record<string, SubagentModelOverride>,
): SubagentSettings {
  return Object.defineProperty({ builtInEnabled, disabledBuiltIns, modelOverrides }, "maxConcurrent", {
    value: maxConcurrent,
    enumerable: false,
    configurable: true,
  }) as SubagentSettings;
}

export function getSubagentSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "agents", "settings.json");
}

function readStoredSettings(settingsPath: string): StoredSubagentSettings {
  return readResourceDocument(settingsPath).document as StoredSubagentSettings;
}

function projectSettings(stored: StoredSubagentSettings): SubagentSettings {
  return settingsValue(
    stored.builtInEnabled === true,
    readMaxConcurrent(stored.maxConcurrent),
    readDisabledBuiltIns(stored.disabledBuiltIns),
    readModelOverrides(stored.modelOverrides),
  );
}

export function inspectSubagentSettings(settingsPath = getSubagentSettingsPath()) {
  const snapshot = readResourceDocument(settingsPath);
  const value = projectSettings(snapshot.document);
  return { revision: snapshot.revision, value: { ...value, maxConcurrent: value.maxConcurrent } };
}

export type SubagentSettingsMutation =
  | { operation: "patch"; changes: { builtInEnabled?: boolean; maxConcurrent?: number } }
  | { operation: "set_profile_enabled"; changes: { name: string; enabled: boolean } }
  | { operation: "set_profile_override"; changes: { name: string; model?: string | null; thinking?: string | null } };

export function mutateSubagentSettings(
  mutation: SubagentSettingsMutation,
  expectedRevision?: string,
  settingsPath = getSubagentSettingsPath(),
) {
  const result = mutateResourceDocument(settingsPath, expectedRevision, (stored) => {
    if (mutation.operation === "patch") {
      const { builtInEnabled, maxConcurrent } = mutation.changes;
      if (builtInEnabled !== undefined) stored.builtInEnabled = builtInEnabled;
      if (maxConcurrent !== undefined) {
        if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > MAX_SUBAGENT_MAX_CONCURRENT) {
          throw new Error(`maxConcurrent must be an integer between 1 and ${MAX_SUBAGENT_MAX_CONCURRENT}`);
        }
        stored.maxConcurrent = maxConcurrent;
      }
      stored.version = 1;
    } else {
      const trimmed = mutation.changes.name.trim();
      if (!trimmed) throw new Error("Sub-agent name is required");
      if (mutation.operation === "set_profile_enabled") {
        const current = readDisabledBuiltIns(stored.disabledBuiltIns);
        const key = trimmed.toLowerCase();
        const disabled = !mutation.changes.enabled;
        const alreadyDisabled = current.some((entry) => entry.toLowerCase() === key);
        if (disabled !== alreadyDisabled) {
          stored.disabledBuiltIns = disabled ? [...current, trimmed] : current.filter((entry) => entry.toLowerCase() !== key);
          stored.version = 1;
        }
      } else {
        // Preserve sibling/unknown fields; the projection is never writer input.
        const overrides = isRecord(stored.modelOverrides) ? { ...stored.modelOverrides } : {};
        const key = findCaseInsensitiveKey(overrides, trimmed) ?? trimmed.toLowerCase();
        const current = isRecord(overrides[key]) ? { ...overrides[key] } : {};
        for (const field of ["model", "thinking"] as const) {
          if (!(field in mutation.changes)) continue;
          const value = mutation.changes[field];
          if (value !== null && value !== undefined && typeof value !== "string") throw new Error(`${field} must be a string or null`);
          if (value === null || value === undefined || value === "") delete current[field];
          else current[field] = value;
        }
        if (Object.keys(current).length === 0) delete overrides[key];
        else overrides[key] = current;
        if (Object.keys(overrides).length === 0) delete stored.modelOverrides;
        else stored.modelOverrides = overrides;
        stored.version = 1;
      }
    }
    const value = projectSettings(stored);
    return { ...value, maxConcurrent: value.maxConcurrent };
  });
  return { revision: result.revision, changed: result.changed, value: result.result };
}

export function readSubagentSettings(
  settingsPath = getSubagentSettingsPath(),
): SubagentSettings {
  return projectSettings(readStoredSettings(settingsPath));
}

/**
 * Lowercased names of the built-in profiles switched off.
 *
 * Damaged settings fail *open* here, unlike `isBuiltInSubagentsEnabled`: an
 * unreadable file must not make built-in profiles vanish from the Agents panel,
 * and the feature switch it also holds has already failed closed by then.
 */
export function readBuiltInSubagentOverride(
  name: string,
  settingsPath = getSubagentSettingsPath(),
): SubagentModelOverride {
  try {
    const stored = readStoredSettings(settingsPath);
    if (!isRecord(stored.modelOverrides)) return {};
    const key = findCaseInsensitiveKey(stored.modelOverrides, name);
    return key === undefined ? {} : readModelOverrideEntry(stored.modelOverrides[key]);
  } catch {
    return {};
  }
}

export function writeBuiltInSubagentOverride(
  name: string,
  patch: { model?: string | null; thinking?: string | null },
  settingsPath = getSubagentSettingsPath(),
): SubagentModelOverride {
  const result = mutateSubagentSettings({ operation: "set_profile_override", changes: { name, ...patch } }, undefined, settingsPath);
  const key = findCaseInsensitiveKey(result.value.modelOverrides, name);
  return key === undefined ? {} : result.value.modelOverrides[key];
}

export function disabledBuiltInSubagents(
  settingsPath = getSubagentSettingsPath(),
): ReadonlySet<string> {
  try {
    return new Set(readSubagentSettings(settingsPath).disabledBuiltIns.map((name) => name.toLowerCase()));
  } catch {
    return new Set();
  }
}

export function isBuiltInSubagentsEnabled(
  settingsPath = getSubagentSettingsPath(),
): boolean {
  try {
    return readSubagentSettings(settingsPath).builtInEnabled;
  } catch {
    return false;
  }
}

export function writeBuiltInSubagentsEnabled(
  enabled: boolean,
  settingsPath = getSubagentSettingsPath(),
): SubagentSettings {
  const result = mutateSubagentSettings({ operation: "patch", changes: { builtInEnabled: enabled } }, undefined, settingsPath);
  return settingsValue(result.value.builtInEnabled, result.value.maxConcurrent, result.value.disabledBuiltIns, result.value.modelOverrides);
}

/** Minimal edit of the stored list: names this call did not touch are left as authored. */
export function writeDisabledBuiltInSubagent(
  name: string,
  disabled: boolean,
  settingsPath = getSubagentSettingsPath(),
): SubagentSettings {
  const result = mutateSubagentSettings({ operation: "set_profile_enabled", changes: { name, enabled: !disabled } }, undefined, settingsPath);
  return settingsValue(result.value.builtInEnabled, result.value.maxConcurrent, result.value.disabledBuiltIns, result.value.modelOverrides);
}

export function writeSubagentMaxConcurrent(
  maxConcurrent: number,
  settingsPath = getSubagentSettingsPath(),
): SubagentSettings {
  const result = mutateSubagentSettings({ operation: "patch", changes: { maxConcurrent } }, undefined, settingsPath);
  return settingsValue(result.value.builtInEnabled, result.value.maxConcurrent, result.value.disabledBuiltIns, result.value.modelOverrides);
}

// Keep Reader's existing settings API while exposing upstream concurrency and per-built-in settings.
export function subagentSettingsPath(agentDir = getAgentDir()): string {
  return getSubagentSettingsPath(agentDir);
}

export function getSubagentSettings(settingsPath = getSubagentSettingsPath()): SubagentSettings {
  return readSubagentSettings(settingsPath);
}

export function setSubagentSettings(
  enabled: boolean,
  settingsPath = getSubagentSettingsPath(),
): SubagentSettings {
  return writeBuiltInSubagentsEnabled(enabled, settingsPath);
}
