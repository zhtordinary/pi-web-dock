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
  providers?: Record<string, { models?: { id: string; name?: string }[] }>;
}

export interface ModelOrderChange<T extends ModelsConfigDraft> {
  config: T;
  providerName: string;
  order: number[];
}

export interface ProviderOrderChange<T extends ModelsConfigDraft> {
  config: T;
  order: string[];
}

export interface ModelCopyChange<T extends ModelsConfigDraft> {
  config: T;
  sourceProviderName: string;
  sourceIndex: number;
  targetProviderName: string;
  targetIndex: number;
}

function reorderModelEntries<T extends ModelsConfigDraft>(
  config: T,
  providerName: string,
  order: number[],
): ModelOrderChange<T> | null {
  const providers = config.providers ?? {};
  const provider = providers[providerName];
  const models = provider?.models;
  if (!models || order.every((index, position) => index === position)) return null;
  return {
    config: {
      ...config,
      providers: { ...providers, [providerName]: { ...provider, models: order.map((index) => models[index]) } },
    },
    providerName,
    order,
  };
}

export function moveModelEntry<T extends ModelsConfigDraft>(
  config: T,
  providerName: string,
  from: number,
  to: number,
): ModelOrderChange<T> | null {
  const models = config.providers?.[providerName]?.models ?? [];
  if (from < 0 || from >= models.length || to < 0 || to >= models.length) return null;
  const order = [...models.keys()];
  order.splice(from, 1);
  order.splice(to, 0, from);
  return reorderModelEntries(config, providerName, order);
}

export function modelDropIndex(from: number, target: number, after: boolean): number {
  const slot = after ? target + 1 : target;
  return from < slot ? slot - 1 : slot;
}

export function sortModelEntries<T extends ModelsConfigDraft>(
  config: T,
  providerName: string,
): ModelOrderChange<T> | null {
  const models = config.providers?.[providerName]?.models ?? [];
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const order = [...models.keys()].sort((left, right) => {
    const leftLabel = models[left].name?.trim() || models[left].id;
    const rightLabel = models[right].name?.trim() || models[right].id;
    return collator.compare(leftLabel, rightLabel) || collator.compare(models[left].id, models[right].id);
  });
  return reorderModelEntries(config, providerName, order);
}

export function moveProviderEntry<T extends ModelsConfigDraft>(
  config: T,
  fromName: string,
  targetName: string,
  after: boolean,
): ProviderOrderChange<T> | null {
  const entries = Object.entries(config.providers ?? {});
  const fromIndex = entries.findIndex(([name]) => name === fromName);
  const targetIndex = entries.findIndex(([name]) => name === targetName);
  if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return null;

  const originalOrder = entries.map(([name]) => name);
  const [entry] = entries.splice(fromIndex, 1);
  const insertion = targetIndex + (after ? 1 : 0) - (fromIndex < targetIndex ? 1 : 0);
  entries.splice(insertion, 0, entry);
  const order = entries.map(([name]) => name);
  if (order.every((name, index) => name === originalOrder[index])) return null;
  return {
    config: { ...config, providers: Object.fromEntries(entries) },
    order,
  };
}

export function copyModelEntry<T extends ModelsConfigDraft>(
  config: T,
  sourceProviderName: string,
  sourceIndex: number,
  targetProviderName: string,
): ModelCopyChange<T> | null {
  const providers = config.providers ?? {};
  const source = providers[sourceProviderName]?.models?.[sourceIndex];
  if (!source) return null;

  const targetProvider = providers[targetProviderName] ?? {};
  const targetModels = [...(targetProvider.models ?? [])];
  const copied = structuredClone(source);
  const sourceId = source.id.trim();
  if (sourceId && targetModels.some((model) => model.id === sourceId)) {
    let copyId = `${sourceId}-copy`;
    let suffix = 2;
    while (targetModels.some((model) => model.id === copyId)) copyId = `${sourceId}-copy-${suffix++}`;
    copied.id = copyId;
  }
  targetModels.push(copied);

  return {
    config: {
      ...config,
      providers: { ...providers, [targetProviderName]: { ...targetProvider, models: targetModels } },
    },
    sourceProviderName,
    sourceIndex,
    targetProviderName,
    targetIndex: targetModels.length - 1,
  };
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
