import { lstatSync, realpathSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ModelsConfigReadError, readModelsConfig, writeModelsConfig } from "@/lib/models-config-store";

export interface ModelsJsonDocument {
  providers?: Record<string, unknown>;
  [key: string]: unknown;
}

export function getModelsPath(): string {
  return join(getAgentDir(), "models.json");
}

export function readModelsJson(): ModelsJsonDocument {
  const path = getModelsPath();
  // Keep the managed discovery writer on the same fail-closed path as the
  // ordinary models-config editor. In particular, a parse/read/schema failure
  // must never become an empty object that can replace the user's file.
  let document: Record<string, unknown>;
  try {
    // `readModelsConfig` intentionally treats a missing path as an empty
    // configuration. Probe metadata first so permission/parent-path failures
    // are not mistaken for that allowed missing case.
    let metadata: ReturnType<typeof lstatSync> | undefined;
    try {
      metadata = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // ENOENT is allowed only for lstat itself. A symlink that exists but whose
    // target cannot be resolved is an unreadable existing configuration path.
    if (metadata?.isSymbolicLink()) realpathSync(path);
    document = readModelsConfig(path);
  } catch (error) {
    if (error instanceof ModelsConfigReadError) throw error;
    throw new ModelsConfigReadError(
      `Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (document.providers !== undefined && !isRecord(document.providers)) {
    throw new ModelsConfigReadError(`Failed to read ${path}: expected providers to be an object`);
  }
  for (const [providerName, provider] of Object.entries(document.providers ?? {})) {
    if (!isRecord(provider)) {
      throw new ModelsConfigReadError(`Failed to read ${path}: provider "${providerName}" must be an object`);
    }
    if (provider.models !== undefined && !Array.isArray(provider.models)) {
      throw new ModelsConfigReadError(`Failed to read ${path}: provider "${providerName}" models must be an array`);
    }
  }
  return document as ModelsJsonDocument;
}

export function writeModelsJson(data: ModelsJsonDocument): void {
  const path = getModelsPath();
  // Re-read immediately before writing. writeModelsConfig performs the same
  // atomic save and cache/runtime invalidation as the regular editor; this
  // guard keeps a damaged or unreadable existing file byte-for-byte intact.
  readModelsJson();
  writeModelsConfig(data, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
