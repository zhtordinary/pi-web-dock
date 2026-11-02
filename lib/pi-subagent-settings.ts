import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

export interface PiSubagentOverride {
  model?: string;
  thinking?: string;
}

export interface PiSubagentStoredOverride {
  model?: string | false;
  thinking?: string | false;
}

type Settings = Record<string, unknown> & {
  subagents?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Invalid Pi settings: expected valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Pi settings: expected an object");
  }
  return value as Settings;
}

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stored(value: unknown): string | false | undefined {
  if (value === false) return false;
  return clean(value);
}

export function getPiSubagentSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "settings.json");
}

/** Read the native sentinel as well as editable string values without normalizing the file. */
export function readPiSubagentStoredOverride(name: string, agentDir = getAgentDir()): PiSubagentStoredOverride {
  try {
    const settings = readSettings(getPiSubagentSettingsPath(agentDir));
    const subagents = settings.subagents;
    const overrides = subagents?.agentOverrides;
    if (!isRecord(overrides)) return {};
    const entry = overrides[name];
    if (!isRecord(entry)) return {};
    const model = stored(entry.model);
    const thinking = stored(entry.thinking);
    return {
      ...(model !== undefined ? { model } : {}),
      ...(thinking !== undefined ? { thinking } : {}),
    };
  } catch {
    return {};
  }
}

export function readPiSubagentOverride(name: string, agentDir = getAgentDir()): PiSubagentOverride {
  const value = readPiSubagentStoredOverride(name, agentDir);
  return {
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.thinking === "string" ? { thinking: value.thinking } : {}),
  };
}

export function writePiSubagentOverride(
  name: string,
  patch: { model?: string | false | null; thinking?: string | false | null },
  agentDir = getAgentDir(),
): PiSubagentOverride {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Sub-agent name is required");
  const settingsPath = getPiSubagentSettingsPath(agentDir);
  const settings = readSettings(settingsPath);
  const subagents = isRecord(settings.subagents) ? { ...settings.subagents } : {};
  const overrides = isRecord(subagents.agentOverrides)
    ? { ...subagents.agentOverrides } as Record<string, unknown>
    : {};
  const current = isRecord(overrides[trimmed]) ? { ...(overrides[trimmed] as Record<string, unknown>) } : {};

  for (const key of ["model", "thinking"] as const) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value !== null && value !== undefined && value !== false && typeof value !== "string") {
      throw new Error(`${key} must be a string, false, or null`);
    }
    if (value === false) current[key] = false;
    else if (value === null || value === undefined || value === "") delete current[key];
    else current[key] = value;
  }

  if (Object.keys(current).length === 0) delete overrides[trimmed];
  else overrides[trimmed] = current;
  if (Object.keys(overrides).length === 0) delete subagents.agentOverrides;
  else subagents.agentOverrides = overrides;
  if (Object.keys(subagents).length === 0) delete settings.subagents;
  else settings.subagents = subagents;

  mkdirSync(dirname(settingsPath), { recursive: true });
  writePrivateFileAtomicSync(settingsPath, JSON.stringify(settings, null, 2));
  return readPiSubagentOverride(trimmed, agentDir);
}
