import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import lockfile from "proper-lockfile";
import { PROJECT_SETTINGS_MAX_BYTES, readRegularFileText } from "./regular-file";
import { stripJsonComments } from "./jsonc";
import { invalidateModelsCache } from "./models-cache";
import { invalidateReadOnlyModelRuntime } from "./session-context-usage";
import { THINKING_LEVEL_ORDER } from "./thinking-level";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ProviderRename {
  oldName: string;
  newName: string;
}

function providerMap(data: Record<string, unknown>): Record<string, unknown> {
  return isRecord(data.providers) ? data.providers : {};
}

/** Detect key-only provider renames; ambiguous replacements stay untouched. */
export function detectProviderRenames(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): ProviderRename[] {
  const previousProviders = providerMap(previous);
  const nextProviders = providerMap(next);
  const removed = Object.keys(previousProviders).filter((name) => !(name in nextProviders));
  const added = Object.keys(nextProviders).filter((name) => !(name in previousProviders));
  const claimed = new Set<string>();
  const renames: ProviderRename[] = [];

  for (const oldName of removed) {
    const candidates = added.filter((newName) => (
      !claimed.has(newName)
      && isDeepStrictEqual(previousProviders[oldName], nextProviders[newName])
    ));
    if (candidates.length !== 1) continue;
    claimed.add(candidates[0]);
    renames.push({ oldName, newName: candidates[0] });
  }

  return renames;
}

function sanitizeModelsConfig(data: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(data.providers)) return data;

  const providers = Object.fromEntries(Object.entries(data.providers).map(([providerId, provider]) => {
    if (!isRecord(provider) || !Array.isArray(provider.models)) return [providerId, provider];
    const models = provider.models.filter((model) => (
      !isRecord(model) || typeof model.id !== "string" || model.id.trim().length > 0
    ));
    return [providerId, { ...provider, models }];
  }));

  return { ...data, providers };
}

export function getModelsConfigPath(): string {
  return join(getAgentDir(), "models.json");
}

/** models.json exists but its contents cannot be used, so it must not be replaced. */
export class ModelsConfigReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelsConfigReadError";
  }
}

/**
 * Reads models.json with the same leniency as pi's loader (BOM, `//` comments,
 * trailing commas). `stripJsonComments` also drops block comments, which pi
 * rejects, and returns pi's own result for every file pi accepts. A file pi
 * accepts must never read as empty here: the panel saves its whole draft, so
 * an empty read would delete every provider on the next save. Unusable
 * contents throw instead.
 */
export function readModelsConfig(
  modelsPath = getModelsConfigPath(),
): Record<string, unknown> {
  // Probe the path itself rather than what it points at: `existsSync` follows
  // links, so a dangling link would read as "no file" and the panel's next save
  // would replace the user's link with a regular file.
  let metadata: ReturnType<typeof lstatSync> | undefined;
  try {
    metadata = lstatSync(modelsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ModelsConfigReadError(
        `Failed to read ${modelsPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!metadata) return { providers: {} };
  if (metadata.isSymbolicLink()) {
    // A link that exists but cannot be resolved is an unusable existing file,
    // not a missing one.
    try { realpathSync(modelsPath); }
    catch (error) {
      throw new ModelsConfigReadError(
        `Failed to read ${modelsPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  let parsed: unknown;
  try {
    const content = (readRegularFileText(modelsPath, PROJECT_SETTINGS_MAX_BYTES) ?? "").replace(/^\uFEFF/, "");
    if (!content.trim()) return { providers: {} };
    parsed = JSON.parse(stripJsonComments(content));
  } catch (error) {
    throw new ModelsConfigReadError(
      `Failed to read ${modelsPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new ModelsConfigReadError(`Failed to read ${modelsPath}: expected a JSON object`);
  }
  return parsed;
}

export function getModelThinkingDefaults(data: Record<string, unknown>): Record<string, string> {
  const defaults: Record<string, string> = {};
  for (const [providerName, provider] of Object.entries(providerMap(data))) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!isRecord(model) || typeof model.id !== "string" || typeof model.defaultThinkingLevel !== "string") continue;
      if (!(THINKING_LEVEL_ORDER as readonly string[]).includes(model.defaultThinkingLevel)) continue;
      defaults[`${providerName}/${model.id}`] = model.defaultThinkingLevel;
    }
  }
  return defaults;
}

/** The UI and managed editor share this exact file lock and atomic writer. */
export function updateModelsConfig<T>(edit: (document: Record<string, unknown>) => T, modelsPath = getModelsConfigPath()): T {
  const dir = dirname(modelsPath);
  mkdirSync(dir, { recursive: true });
  const release = lockfile.lockSync(modelsPath, { realpath: false });
  try {
    const current = readModelsConfig(modelsPath);
    const before = JSON.stringify(current);
    const result = edit(current);
    if (JSON.stringify(current) !== before) {
      writePrivateFileAtomicSync(modelsPath, JSON.stringify(current, null, 2));
      invalidateModelsCache();
      invalidateReadOnlyModelRuntime();
    }
    return result;
  } finally { release(); }
}

export function writeModelsConfig(data: Record<string, unknown>, modelsPath = getModelsConfigPath()): void {
  updateModelsConfig((current) => {
    for (const key of Object.keys(current)) delete current[key];
    for (const [key, value] of Object.entries(sanitizeModelsConfig(data))) Object.defineProperty(current, key, { value, enumerable: true, writable: true, configurable: true });
  }, modelsPath);
}
