export async function readApiJson<T>(response: Response): Promise<T> {
  const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  const body = await response.text();
  if (!body.trim()) throw new Error(`${status}: empty response`);

  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("response is not a JSON object");
    }
    return parsed as T;
  } catch {
    throw new Error(`${status}: invalid JSON response`);
  }
}

export interface CompatEntry {
  compat?: Record<string, unknown>;
}

export interface HeaderRow {
  id: number;
  name: string;
  value: string;
}

export interface PromptRoleEntry extends CompatEntry {
  api?: string;
  reasoning?: boolean;
}

export type SystemPromptRoleSelection = "" | "developer" | "system";
export interface SystemPromptRoleState {
  api: string;
  editable: boolean;
  selection: SystemPromptRoleSelection;
  effective: "developer" | "system" | "automatic";
  source: "api" | "model" | "provider" | "adapter";
  ignoredOverride: boolean;
}

export function hasOwnCompat(entry: CompatEntry, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(entry.compat ?? {}, key);
}

export function resolveSystemPromptRole(
  provider: PromptRoleEntry,
  model: PromptRoleEntry,
): SystemPromptRoleState {
  const api = model.api ?? provider.api ?? "openai-completions";
  const modelOverride = hasOwnCompat(model, "supportsDeveloperRole");
  const providerOverride = hasOwnCompat(provider, "supportsDeveloperRole");
  const editable = api === "openai-responses" || api === "openai-completions";

  if (!editable) {
    return {
      api,
      editable: false,
      selection: "",
      effective: "system",
      source: "api",
      ignoredOverride: modelOverride || providerOverride,
    };
  }

  const effective = { ...(provider.compat ?? {}), ...(model.compat ?? {}) }.supportsDeveloperRole;
  return {
    api,
    editable: true,
    selection: modelOverride ? (effective === false ? "system" : "developer") : "",
    effective: effective === false
      ? "system"
      : effective === true || api === "openai-responses"
        ? (model.reasoning ? "developer" : "system")
        : "automatic",
    source: modelOverride ? "model" : providerOverride ? "provider" : "adapter",
    ignoredOverride: false,
  };
}

export function setSystemPromptRole<T extends CompatEntry>(entry: T, value: SystemPromptRoleSelection): T {
  if (value) return setCompatBool(entry, "supportsDeveloperRole", value === "developer");
  if (!entry.compat) return entry;
  const compat = { ...entry.compat };
  delete compat.supportsDeveloperRole;
  return { ...entry, compat: Object.keys(compat).length ? compat : undefined };
}

export function setCompatOverride<T extends CompatEntry>(entry: T, key: string, value: boolean | undefined): T {
  if (value !== undefined) return setCompatBool(entry, key, value);
  if (!entry.compat) return entry;
  const compat = { ...entry.compat };
  delete compat[key];
  return { ...entry, compat: Object.keys(compat).length ? compat : undefined };
}

export function setCompatBool<T extends CompatEntry>(entry: T, key: string, value: boolean): T {
  return {
    ...entry,
    compat: { ...(entry.compat ?? {}), [key]: value },
  };
}

export function updateHeaderRow(
  rows: readonly HeaderRow[],
  id: number,
  changes: Partial<Pick<HeaderRow, "name" | "value">>,
): HeaderRow[] {
  return rows.map((row) => row.id === id ? { ...row, ...changes } : row);
}

export function serializeHeaderRows(rows: readonly HeaderRow[]): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name) headers[name] = row.value;
  }
  return Object.keys(headers).length ? headers : undefined;
}

/** The parts of models.json needed for provider rename edits. */
export interface ModelsConfigDraft {
  providers?: Record<string, { models?: { id: string }[] }>;
}

/**
 * Rename a provider in place, preserving provider order.
 *
 * Returns null when the provider is missing or the target name is already in
 * use, because models.json is keyed by provider id.
 */
export function renameProviderEntry<T extends ModelsConfigDraft>(
  config: T,
  oldName: string,
  newName: string,
): T | null {
  const providers = config.providers ?? {};
  if (!Object.hasOwn(providers, oldName)) return null;
  if (oldName === newName) return config;
  if (Object.hasOwn(providers, newName)) return null;

  const entries = Object.entries(providers);
  const index = entries.findIndex(([name]) => name === oldName);
  entries[index] = [newName, entries[index][1]];
  return { ...config, providers: Object.fromEntries(entries) };
}
