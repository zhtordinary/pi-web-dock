import { homedir } from "os";
import { join, sep } from "path";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getGlobalSettingsPath, readGlobalSettings, updateGlobalSettings } from "./global-settings-file";
import {
  resolveModelScopeWithDiagnostics,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  computeEnabledModelsState,
  validateProviderEntries,
  modelRefProvider,
  renameModelPatterns,
  renameProviderPatterns,
  setModelsEnabled,
  validateEnabledModelsRename,
  type EnabledModelsEdit,
  type EnabledModelsInput,
  type EnabledModelsModelView,
  type EnabledModelsProviderView,
  type EnabledModelsView,
  type PatternResolution,
  type ProviderRename,
} from "./enabled-models";

/**
 * SDK adapter for the pure `enabledModels` editor in `lib/enabled-models.ts`.
 *
 * Pattern matching lives in the SDK resolver, so each configured pattern is
 * resolved on its own here to learn which models it covers and which thinking
 * level it pins. Resolving them one by one — instead of all at once, like
 * `lib/model-scope.ts` does for the selector — is what lets an edit touch only
 * the pattern responsible for a given model.
 */

const modelNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function modelRef(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Resolve every configured pattern separately, keeping the input order.
 *
 * `resolveModelScopeWithDiagnostics()` wants a `ModelRuntime`; a snapshot shim
 * keeps the matching rules identical without touching the network or the
 * credential store between patterns.
 */
export async function resolvePatternMatches(
  patterns: readonly string[],
  models: readonly Model<Api>[],
): Promise<PatternResolution[]> {
  const snapshotRuntime = { getAvailable: async () => models } as ModelRuntime;
  const resolutions: PatternResolution[] = [];
  for (const pattern of patterns) {
    let scopedModels: { model: Model<Api>; thinkingLevel?: string }[] = [];
    let unverified = false;
    try {
      ({ scopedModels } = await resolveModelScopeWithDiagnostics([pattern], snapshotRuntime));
    } catch {
      unverified = true;
    }
    const pin = scopedModels.find((scoped) => scoped.thinkingLevel)?.thinkingLevel;
    resolutions.push({
      pattern,
      matched: scopedModels.map((scoped) => modelRef(scoped.model)),
      ...(pin ? { pin } : {}),
      ...(unverified ? { unverified: true } : {}),
    });
  }
  return resolutions;
}

export async function buildEnabledModelsInput(
  patterns: string[] | undefined,
  models: readonly Model<Api>[],
): Promise<EnabledModelsInput> {
  return {
    patterns,
    availableRefs: models.map(modelRef),
    resolutions: await resolvePatternMatches(patterns ?? [], models),
  };
}

/** Validate legacy explicit resync requests against the same scope rules as the UI. */
export async function resyncEnabledModels(
  input: EnabledModelsInput,
  models: readonly Model<Api>[],
  options: { renames: readonly ProviderRename[]; modelRenames: readonly ProviderRename[]; fullyEnabled: readonly string[] },
): Promise<EnabledModelsEdit> {
  const { renames, modelRenames, fullyEnabled } = options;
  const original = input.patterns;
  const renamed = renameProviderPatterns(renameModelPatterns(original, modelRenames), renames);
  const current = await buildEnabledModelsInput(renamed, models);
  const validated = validateEnabledModelsRename(input, current);
  if (!validated.ok) return validated;
  const providerValidation = validateProviderEntries(current);
  if (!providerValidation.ok) return providerValidation;
  const refs = fullyEnabled
    .map((id) => renames.find((rename) => rename.from === id)?.to ?? id)
    .flatMap((id) => models.filter((model) => model.provider === id).map(modelRef));
  const edit = setModelsEnabled(current, refs, true);
  if (!edit.ok) return edit;
  const patterns = edit.patterns;
  const changed = original === undefined || patterns === undefined
    ? original !== patterns
    : original.length !== patterns.length || original.some((pattern, index) => pattern !== patterns[index]);
  return { ok: true, patterns, changed };
}

/**
 * Provider ids whose models pi-web must not offer to edit one by one.
 *
 * A provider is built in when pi ships it or an extension registered it at
 * runtime; everything else is defined by models.json.
 */
export function customProviderIds(modelRuntime: ModelRuntime): Set<string> {
  const known = new Set<string>([...getBuiltinProviders(), ...modelRuntime.getRegisteredProviderIds()]);
  return new Set(
    modelRuntime.getProviders().map((provider) => provider.id).filter((id) => !known.has(id)),
  );
}

export interface EnabledModelsViewOptions {
  input: EnabledModelsInput;
  models: readonly Model<Api>[];
  providerNames: Map<string, string>;
  customProviders: ReadonlySet<string>;
  scope: "global" | "project";
  settingsPath: string;
  modelError?: string;
}

export function buildEnabledModelsView({
  input,
  models,
  providerNames,
  customProviders,
  scope,
  settingsPath,
  modelError,
}: EnabledModelsViewOptions): EnabledModelsView {
  const state = computeEnabledModelsState(input);
  const enabled = new Set(state.enabled);

  const byProvider = new Map<string, EnabledModelsModelView[]>();
  for (const model of models) {
    const ref = modelRef(model);
    const pin = state.pins[ref];
    const entry: EnabledModelsModelView = {
      id: model.id,
      name: model.name || model.id,
      ref,
      enabled: enabled.has(ref),
      ...(pin ? { thinkingPin: pin } : {}),
    };
    const list = byProvider.get(model.provider);
    if (list) list.push(entry);
    else byProvider.set(model.provider, [entry]);
  }

  const providers: EnabledModelsProviderView[] = [...byProvider.entries()].map(([id, entries]) => {
    entries.sort((a, b) => modelNameCollator.compare(a.name, b.name) || modelNameCollator.compare(a.id, b.id));
    return {
      id,
      name: providerNames.get(id) ?? id,
      kind: customProviders.has(id) ? "custom" : "builtin",
      enabledCount: entries.filter((entry) => entry.enabled).length,
      models: entries,
    };
  });
  providers.sort((a, b) => modelNameCollator.compare(a.name, b.name) || modelNameCollator.compare(a.id, b.id));

  return {
    allEnabled: state.allEnabled,
    patterns: input.patterns ?? null,
    stalePatterns: state.stalePatterns,
    enabledTotal: state.enabled.length,
    availableTotal: input.availableRefs.length,
    providers,
    scope,
    settingsPath,
    editable: scope === "global",
    ...(modelError ? { modelError } : {}),
  };
}

/** Read both settings layers asynchronously without blocking another writer's lock release. */
export async function loadEnabledModelsSettings(paths: { cwd: string; agentDir: string }): Promise<SettingsManager> {
  const [global, project] = await Promise.all([
    readGlobalSettings(getGlobalSettingsPath(paths.agentDir), (settings) => JSON.stringify(settings)),
    readGlobalSettings(join(paths.cwd, ".pi", "settings.json"), (settings) => JSON.stringify(settings)),
  ]);
  return SettingsManager.fromStorage({
    withLock(scope, read) {
      if (read(scope === "global" ? global : project) !== undefined) {
        throw new Error("Enabled model settings snapshot is read-only");
      }
    },
  });
}

export interface EnabledModelsSettings {
  /** Effective value, i.e. what the model selector actually applies. */
  patterns: string[] | undefined;
  scope: "global" | "project";
  /** The file that value came from, with the home directory shortened to `~`. */
  path: string;
}

/** `~/.pi/agent/settings.json` reads better in a banner than the full path. */
export function displaySettingsPath(path: string): string {
  const home = homedir();
  if (!home || !path.startsWith(home)) return path;
  const rest = path.slice(home.length);
  return rest === "" || rest.startsWith(sep) ? `~${rest}` : path;
}

/**
 * Read the effective `enabledModels` and say where it comes from.
 *
 * `SettingsManager.setEnabledModels()` only ever writes the global file, and a
 * project array replaces the global one instead of merging, so a project-level
 * value makes every toggle a no-op. The route reports that instead of writing
 * something the user would never see take effect.
 */
export function readEnabledModelsSettings(
  settingsManager: SettingsManager,
  { cwd, agentDir }: { cwd: string; agentDir: string },
): EnabledModelsSettings {
  const projectPatterns = settingsManager.getProjectSettings().enabledModels;
  const scope = projectPatterns === undefined ? "global" : "project";
  return {
    patterns: settingsManager.getEnabledModels(),
    scope,
    path: displaySettingsPath(scope === "project"
      ? join(cwd, ".pi", "settings.json")
      : join(agentDir, "settings.json")),
  };
}

export class EnabledModelsConflictError extends Error {
  constructor() {
    super("Model scope changed while editing; reload and try again");
    this.name = "EnabledModelsConflictError";
  }
}

/** Compare the scope under Pi's settings lock before replacing the field. */
export async function writeEnabledModels(
  settingsManager: SettingsManager,
  patterns: string[] | undefined,
  paths: { agentDir: string },
): Promise<void> {
  const loadError = settingsManager.drainErrors().find((entry) => entry.scope === "global");
  if (loadError) throw loadError.error;
  const expected = settingsManager.getGlobalSettings().enabledModels;
  await updateGlobalSettings(getGlobalSettingsPath(paths.agentDir), (settings) => {
    const current = settings.enabledModels;
    const matches = current === undefined || expected === undefined
      ? current === expected
      : Array.isArray(current) && Array.isArray(expected)
        && current.length === expected.length && current.every((value, index) => value === expected[index]);
    if (!matches) throw new EnabledModelsConflictError();
    if (patterns === undefined) delete settings.enabledModels;
    else settings.enabledModels = patterns;
  });
}

export { modelRefProvider };
export type { EnabledModelsModelView, EnabledModelsProviderView, EnabledModelsView };
