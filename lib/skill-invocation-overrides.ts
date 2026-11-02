import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import lockfile from "proper-lockfile";
import type { SkillOverrideState } from "./api-types";
import { writePrivateFileAtomicSync } from "./atomic-file";

export const GLOBAL_SKILL_INVOCATION_OVERRIDES_SETTING = "piWebGlobalSkillInvocationOverrides";

type SettingsRecord = Record<string, unknown>;

function isRecord(value: unknown): value is SettingsRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function skillInvocationOverrideKey(filePath: string, homeDir = homedir()): string {
  const home = resolve(homeDir);
  const apparentPath = resolve(filePath);
  let canonicalPath = apparentPath;
  try {
    canonicalPath = realpathSync(filePath);
  } catch {
    // A not-yet-mounted global skills path still gets a deterministic fallback key.
  }
  const withinHome = (candidate: string): string | undefined => {
    const relativeHomePath = relative(home, candidate);
    return relativeHomePath && relativeHomePath !== ".."
      && !relativeHomePath.startsWith(`..${sep}`) && !isAbsolute(relativeHomePath)
      ? `top-level:~/${relativeHomePath.split(sep).join("/")}`
      : undefined;
  };
  // Prefer the real home-relative identity, but keep discovered home paths
  // portable when a global Skill symlink resolves outside the home directory.
  return withinHome(canonicalPath) ?? withinHome(apparentPath)
    ?? `top-level:${canonicalPath.replaceAll("\\", "/")}`;
}

export function getGlobalSkillInvocationOverride(
  globalSettings: unknown,
  filePath: string,
  homeDir = homedir(),
): SkillOverrideState | undefined {
  if (!isRecord(globalSettings)) return undefined;
  const overrides = globalSettings[GLOBAL_SKILL_INVOCATION_OVERRIDES_SETTING];
  if (!isRecord(overrides)) return undefined;
  const state = overrides[skillInvocationOverrideKey(filePath, homeDir)];
  return state === "enabled" || state === "disabled" ? state : undefined;
}

function readGlobalSettings(settingsPath: string): SettingsRecord {
  let content: string;
  try {
    content = readFileSync(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Global settings.json is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("Global settings.json must contain an object");
  const overrides = parsed[GLOBAL_SKILL_INVOCATION_OVERRIDES_SETTING];
  if (overrides !== undefined && (!isRecord(overrides)
    || Object.values(overrides).some((state) => state !== "enabled" && state !== "disabled"))) {
    throw new Error("Global Skill invocation settings are invalid");
  }
  return parsed;
}

export async function setGlobalSkillInvocationOverride(
  agentDir: string,
  filePath: string,
  state: SkillOverrideState,
): Promise<void> {
  if (!isAbsolute(filePath) || basename(filePath) !== "SKILL.md") {
    throw new Error("A discovered absolute SKILL.md path is required");
  }
  if (state !== "enabled" && state !== "disabled") throw new Error("Invalid Skill invocation state");

  const settingsPath = join(agentDir, "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
  if (!existsSync(settingsPath)) {
    try {
      writeFileSync(settingsPath, "{}\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const release = await lockfile.lock(settingsPath, {
    retries: { retries: 10, factor: 1, minTimeout: 20, maxTimeout: 20 },
  });
  try {
    const settings = readGlobalSettings(settingsPath);
    const overrides = settings[GLOBAL_SKILL_INVOCATION_OVERRIDES_SETTING] as SettingsRecord | undefined ?? {};
    overrides[skillInvocationOverrideKey(filePath)] = state;
    settings[GLOBAL_SKILL_INVOCATION_OVERRIDES_SETTING] = overrides;
    writePrivateFileAtomicSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  } finally {
    await release();
  }
}
