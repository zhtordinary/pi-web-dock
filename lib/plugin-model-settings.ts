import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { mutateResourceDocument, readResourceDocument, ResourceSettingsError } from "./resource-config-file";

export type PluginModelSelection = { provider: string; modelId: string } | null;
export interface PluginModelSettingsRow {
  id: string;
  label: string;
  revision: string;
  model: PluginModelSelection | "mixed";
  thinking: string;
  thinkingOptions: string[];
  thinkingAutoBehavior?: "model" | "session";
}

type ReferenceModel = { kind: "reference"; paths: string[]; follow: string };
type SplitModel = { kind: "split"; provider: string; model: string; mode: string; follow: string; fixed: string };
type PluginDescriptor = {
  id: string;
  label: string;
  directory: string;
  model: ReferenceModel | SplitModel;
  thinking: { paths: string[]; fallback: string; options: string[]; autoBehavior?: "model" | "session" };
};

const LEVELS = new Set(["session-default", "auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CONCRETE_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
function allowsThinkingValue(descriptor: PluginDescriptor, value: string): boolean {
  return CONCRETE_LEVELS.has(value) || descriptor.thinking.options.includes(value);
}
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const validPath = (value: unknown): value is string => typeof value === "string" && value.length <= 200
  && value.split(".").every((part) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(part) && !FORBIDDEN_KEYS.has(part));
const validPaths = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= 4
  && value.every(validPath) && new Set(value).size === value.length;
const validValue = (value: unknown): value is string => typeof value === "string" && !!value.trim()
  && value.length <= 300 && !/[\0\r\n]/.test(value);

/** A package supplies a bounded data-only mapping, never an executable adapter or browser-selected path. */
export function parsePluginModelDescriptor(packageName: unknown, value: unknown): PluginDescriptor | null {
  if (!validValue(packageName) || !isRecord(value) || value.version !== 1 || !validValue(value.label)
    || typeof value.directory !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value.directory)
    || !isRecord(value.model) || !isRecord(value.thinking)) return null;
  const rawModel = value.model;
  let model: PluginDescriptor["model"];
  if (rawModel.kind === "reference" && validPaths(rawModel.paths) && validValue(rawModel.follow)) {
    model = { kind: "reference", paths: rawModel.paths, follow: rawModel.follow };
  } else if (rawModel.kind === "split" && validPath(rawModel.provider) && validPath(rawModel.model)
    && validPath(rawModel.mode) && validValue(rawModel.follow) && validValue(rawModel.fixed)
    && new Set([rawModel.provider, rawModel.model, rawModel.mode]).size === 3) {
    model = { kind: "split", provider: rawModel.provider, model: rawModel.model, mode: rawModel.mode,
      follow: rawModel.follow, fixed: rawModel.fixed };
  } else return null;
  const thinking = value.thinking;
  if (!validPaths(thinking.paths) || !Array.isArray(thinking.options) || thinking.options.length === 0
    || !thinking.options.every((level) => typeof level === "string" && LEVELS.has(level))
    || new Set(thinking.options).size !== thinking.options.length || typeof thinking.fallback !== "string"
    || !thinking.options.includes(thinking.fallback)
    || (thinking.autoBehavior !== undefined && thinking.autoBehavior !== "model" && thinking.autoBehavior !== "session")
    || (thinking.autoBehavior !== undefined && !thinking.options.includes("auto"))) return null;
  const modelPaths = model.kind === "reference" ? model.paths : [model.provider, model.model, model.mode];
  const paths = [...modelPaths, ...thinking.paths];
  if (paths.some((path, index) => paths.some((other, otherIndex) => index !== otherIndex && (path === other || path.startsWith(`${other}.`))))) return null;
  return { id: packageName.trim(), label: value.label.trim(), directory: value.directory, model,
    thinking: { paths: thinking.paths, fallback: thinking.fallback, options: thinking.options as string[],
      ...(thinking.autoBehavior ? { autoBehavior: thinking.autoBehavior as "model" | "session" } : {}) } };
}

function getPath(document: Record<string, unknown>, path: string): unknown {
  let current: unknown = document;
  for (const part of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function setPath(document: Record<string, unknown>, path: string, value: string): void {
  const parts = path.split(".");
  let current = document;
  for (const part of parts.slice(0, -1)) {
    if (current[part] === undefined) current[part] = {};
    if (!isRecord(current[part])) throw new ResourceSettingsError("invalid_configuration", `Invalid settings object: ${part}`, 409);
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function parseReference(value: unknown, follow: string): PluginModelSelection {
  if (value === undefined || value === follow) return null;
  if (!validValue(value)) throw new ResourceSettingsError("invalid_configuration", "Invalid plugin model setting", 409);
  const slash = value.indexOf("/");
  if (slash < 0) return { provider: "", modelId: value.trim() };
  if (slash < 1 || slash === value.length - 1) throw new ResourceSettingsError("invalid_configuration", "Plugin model requires provider/model", 409);
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export function projectPluginModelSettings(descriptor: PluginDescriptor, document: Record<string, unknown>, revision: string): PluginModelSettingsRow {
  const selection = descriptor.model;
  let model: PluginModelSettingsRow["model"];
  if (selection.kind === "reference") {
    const values = selection.paths.map((path) => parseReference(getPath(document, path), selection.follow));
    model = values.every((value) => JSON.stringify(value) === JSON.stringify(values[0])) ? values[0] : "mixed";
  } else {
    const mode = getPath(document, selection.mode);
    if (mode === undefined || mode === selection.follow) model = null;
    else if (mode === selection.fixed) {
      const provider = getPath(document, selection.provider), modelId = getPath(document, selection.model);
      if (!validValue(provider) || !validValue(modelId)) throw new ResourceSettingsError("invalid_configuration", "Plugin model requires provider and model ID", 409);
      model = { provider: provider.trim(), modelId: modelId.trim() };
    } else throw new ResourceSettingsError("invalid_configuration", "Invalid plugin model mode", 409);
  }
  const levels = descriptor.thinking.paths.map((path) => getPath(document, path) ?? descriptor.thinking.fallback);
  if (levels.some((level) => typeof level !== "string" || !allowsThinkingValue(descriptor, level))) {
    throw new ResourceSettingsError("invalid_configuration", "Invalid plugin thinking setting", 409);
  }
  return { id: descriptor.id, label: descriptor.label, revision, model,
    thinking: levels.every((level) => level === levels[0]) ? levels[0] as string : "mixed",
    thinkingOptions: descriptor.thinking.options,
    ...(descriptor.thinking.autoBehavior ? { thinkingAutoBehavior: descriptor.thinking.autoBehavior } : {}) };
}

export function applyPluginModelSettings(descriptor: PluginDescriptor, document: Record<string, unknown>, patch: { model?: PluginModelSelection; thinking?: string }): void {
  if (patch.model !== undefined) {
    const model = patch.model;
    if (model !== null && (!isRecord(model) || !validValue(model.provider) || !validValue(model.modelId))) {
      throw new ResourceSettingsError("invalid_model", "Model requires provider and model ID");
    }
    const selection = descriptor.model;
    if (selection.kind === "reference") {
      for (const path of selection.paths) setPath(document, path, model ? `${model.provider}/${model.modelId}` : selection.follow);
    } else {
      setPath(document, selection.mode, model ? selection.fixed : selection.follow);
      if (model) {
        setPath(document, selection.provider, model.provider);
        setPath(document, selection.model, model.modelId);
      }
    }
  }
  if (patch.thinking !== undefined) {
    if (!LEVELS.has(patch.thinking) || !allowsThinkingValue(descriptor, patch.thinking)) throw new ResourceSettingsError("invalid_thinking", "Unsupported plugin thinking level");
    for (const path of descriptor.thinking.paths) setPath(document, path, patch.thinking);
  }
}

function configPath(agentDir: string, directory: string, create: boolean): string {
  const root = realpathSync(agentDir);
  const dir = join(root, directory);
  try {
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(dir) !== dir) throw new ResourceSettingsError("unsupported_path", "Plugin settings directory must be a physical directory", 422);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (create) mkdirSync(dir, { mode: 0o700 });
  }
  const path = join(dir, "config.json");
  try {
    if (lstatSync(path).isSymbolicLink()) throw new ResourceSettingsError("unsupported_path", "Plugin settings file must not be a symlink", 422);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return path;
}

export function readPluginModelSettings(descriptor: PluginDescriptor, agentDir: string): PluginModelSettingsRow {
  const document = readResourceDocument(configPath(agentDir, descriptor.directory, false));
  return projectPluginModelSettings(descriptor, document.document, document.revision);
}

export function writePluginModelSettings(descriptor: PluginDescriptor, agentDir: string, revision: string, patch: { model?: PluginModelSelection; thinking?: string }): PluginModelSettingsRow {
  if (!validValue(revision) || (patch.model === undefined && patch.thinking === undefined)) {
    throw new ResourceSettingsError("invalid_request", "A revision and at least one setting are required");
  }
  const path = configPath(agentDir, descriptor.directory, true);
  mutateResourceDocument(path, revision, (document) => {
    projectPluginModelSettings(descriptor, document, revision);
    applyPluginModelSettings(descriptor, document, patch);
  });
  return readPluginModelSettings(descriptor, agentDir);
}

export function discoverPluginModelSettings(agentDir: string = getAgentDir()): PluginDescriptor[] {
  const cwd = process.cwd();
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  const found = new Map<string, PluginDescriptor>();
  for (const item of manager.listConfiguredPackages()) {
    if (item.scope !== "user" || !item.installedPath) continue;
    try {
      const manifest: unknown = JSON.parse(readFileSync(join(item.installedPath, "package.json"), "utf8"));
      if (!isRecord(manifest) || !isRecord(manifest.piWeb)) continue;
      const descriptor = parsePluginModelDescriptor(manifest.name, manifest.piWeb.modelSettings);
      if (!descriptor) continue;
      if (found.has(descriptor.id)) throw new ResourceSettingsError("duplicate_plugin", `Duplicate plugin model settings: ${descriptor.id}`, 409);
      found.set(descriptor.id, descriptor);
    } catch (error) {
      if (error instanceof ResourceSettingsError) throw error;
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return [...found.values()].sort((a, b) => a.label.localeCompare(b.label));
}
