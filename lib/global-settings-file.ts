import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";

// Locked read-modify-write of the global `settings.json` for the keys pi's
// SettingsManager has no setter for (`defaultTools`). The lock is the one
// SettingsManager takes on the same path, so neither overwrites the other.

export function getGlobalSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "settings.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, "utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch { throw new SyntaxError(`Invalid settings.json at ${path}: invalid JSON`); }
  if (!isRecord(parsed)) throw new Error(`Invalid settings.json at ${path}: expected an object`);
  return parsed;
}

/** The raw `defaultTools` entries, `+name` / `-name` modifiers included; undefined when unset. */
export function defaultToolEntries(settings: Record<string, unknown>): string[] | undefined {
  if (settings.defaultTools === undefined) return undefined;
  if (
    !Array.isArray(settings.defaultTools)
    || settings.defaultTools.some((name) => typeof name !== "string")
  ) {
    throw new Error("Invalid settings.json: defaultTools must be an array of strings");
  }
  return [...settings.defaultTools as string[]];
}

/** Read the settings under the lock; a missing file reads as `{}` without being created. */
export async function readGlobalSettings<T>(
  settingsPath: string,
  read: (settings: Record<string, unknown>) => T,
): Promise<T> {
  if (!existsSync(settingsPath)) return read({});
  const release = await lockfile.lock(settingsPath, { realpath: false, retries: 10 });
  try {
    return read(parseSettings(settingsPath));
  } finally {
    await release();
  }
}

/**
 * Change the settings under the lock and write them back with mode 0600. `update`
 * mutates the object it is given; a file that does not parse is left untouched.
 */
export async function updateGlobalSettings<T>(
  settingsPath: string,
  update: (settings: Record<string, unknown>) => T | Promise<T>,
  validateTarget?: () => string | void,
  preserveMode = false,
): Promise<T> {
  mkdirSync(dirname(settingsPath), { recursive: true });
  const release = await lockfile.lock(settingsPath, { realpath: false, retries: 10 });
  try {
    const writePath = validateTarget?.() ?? settingsPath;
    const settings = parseSettings(writePath);
    const before = JSON.stringify(settings);
    const result = await update(settings);
    // No await between this final authorization/path check and the atomic write.
    validateTarget?.();
    if (JSON.stringify(settings) === before) return result;
    const mode = preserveMode && existsSync(writePath) ? statSync(writePath).mode & 0o777 : 0o600;
    writePrivateFileAtomicSync(writePath, `${JSON.stringify(settings, null, 2)}\n`, mode);
    chmodSync(writePath, mode);
    return result;
  } finally {
    await release();
  }
}
