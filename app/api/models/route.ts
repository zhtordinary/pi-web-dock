import { appendFile, chmod, mkdir, stat } from "fs/promises";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { createAgentSessionServices, getAgentDir, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { isFastModeDefault, isFastModeSupported } from "@/lib/fast-mode";
import { loadModelsWithCache, withModelRuntimeError, type ModelErrorInfo, type ModelListEntry, type ModelsData } from "@/lib/models-cache";
import { resolveVisibleModels, selectInitialModelScope } from "@/lib/model-scope";
import { filterHiddenModels, normalizeHiddenModelReferences } from "@/lib/model-visibility";
import { getModelThinkingDefaults, readModelsConfig } from "@/lib/models-config-store";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { projectTrustReloadOptions } from "@/lib/project-trust";

export const dynamic = "force-dynamic";

const modelNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareModelEntries(
  a: ModelListEntry,
  b: ModelListEntry
): number {
  return modelNameCollator.compare(a.name || a.id, b.name || b.id)
    || modelNameCollator.compare(a.provider, b.provider)
    || modelNameCollator.compare(a.id, b.id);
}

const MODEL_ERROR_LOG_ENV = "PI_WEB_MODEL_ERROR_LOG";
const MAX_MODEL_ERROR_LENGTH = 2400;

function redactModelErrorText(value: string): string {
  return value
    .replace(/([?&](?:api[_-]?key|token|password|secret)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/\b(?:sk|xai|AIza)[A-Za-z0-9_-]{16,}\b/g, "<redacted>")
    .slice(0, MAX_MODEL_ERROR_LENGTH);
}

function describeModelError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactModelErrorText(message.trim()) || "Unknown model discovery error";
}

function getModelErrorLogPath(): string {
  const configured = process.env[MODEL_ERROR_LOG_ENV]?.trim();
  if (configured) return resolve(configured);

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Logs", "pi-web-model-errors.log");
  }

  const stateRoot = process.env.XDG_STATE_HOME?.trim()
    ? resolve(process.env.XDG_STATE_HOME)
    : join(homedir(), ".local", "state");
  return join(stateRoot, "pi-web-reader", "model-errors.log");
}

async function recordModelError(cwd: string, error: unknown): Promise<string | undefined> {
  const logPath = getModelErrorLogPath();
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "model_discovery_error",
    cwd,
    error: describeModelError(error),
  });

  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${entry}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(logPath, 0o600);
    return logPath;
  } catch (logError) {
    console.error(`[pi-web] Failed to write model diagnostics to ${logPath}: ${describeModelError(logError)}`);
    return undefined;
  }
}
async function loadModels(cwd: string): Promise<ModelsData> {
  const nameMap = new Map<string, string>();
  let modelList: ModelListEntry[] = [];
  let defaultModel: { provider: string; modelId: string } | null = null;
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};

  const agentDir = getAgentDir();
  // Gate untrusted project extensions: enumerating models still imports and
  // runs a repository's .pi/extensions factories, so honor project trust here
  // too (see lib/project-trust.ts, #236).
  const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
  });
  const modelError = services.modelRuntime.getError();
  const settings: SettingsManager = services.settingsManager;
  // `enabledModels` supports globs and fuzzy patterns, so resolve it the same
  // way the CLI does instead of comparing pattern strings literally (#307).
  const scope = await resolveVisibleModels(
    services.modelRuntime,
    settings.getEnabledModels(),
  );
  const { visible, thinkingLevelPins, warnings } = scope;
  const modelsConfig = readModelsConfig();
  const thinkingLevelDefaults = getModelThinkingDefaults(modelsConfig);
  // Per-model hiding lives in models.json (three-way synced), so chat and
  // vision selectors agree without touching provider or model configuration.
  const shown = filterHiddenModels(visible, normalizeHiddenModelReferences(modelsConfig.hiddenModels));
  modelList = shown.map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    reasoning: m.reasoning,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    fastModeSupported: isFastModeSupported(m),
    fastModeDefault: isFastModeDefault(m),
    input: m.input,
  })).sort(compareModelEntries);
  for (const m of shown) {
    const key = `${m.provider}:${m.id}`;
    nameMap.set(key, m.name);
    thinkingLevels[key] = getSupportedThinkingLevels(m);
    if (m.thinkingLevelMap) thinkingLevelMaps[key] = m.thinkingLevelMap;
  }

  const defaultProvider = settings.getDefaultProvider();
  const defaultModelId = settings.getDefaultModel();
  const initial = selectInitialModelScope(
    { ...scope, visible: shown },
    {
      ...(defaultProvider && defaultModelId
        ? { defaultModel: { provider: defaultProvider, modelId: defaultModelId } }
        : {}),
      thinkingLevelDefaults,
    },
  );
  if (initial.model) {
    defaultModel = { provider: initial.model.provider, modelId: initial.model.id };
  }
  const defaultThinkingLevel = initial.thinkingLevel
    ?? (initial.model
      ? settings.getModelThinkingLevel(initial.model.provider, initial.model.id)
      : undefined)
    ?? settings.getDefaultThinkingLevel()
    ?? null;

  const modelErrorLogPath = modelError ? await recordModelError(cwd, modelError) : undefined;
  return withModelRuntimeError(
    {
      models: Object.fromEntries(nameMap),
      modelList,
      defaultModel,
      defaultThinkingLevel,
      savedDefaultThinkingLevel: settings.getDefaultThinkingLevel() ?? null,
      thinkingLevels,
      thinkingLevelMaps,
      thinkingLevelPins,
      thinkingLevelDefaults,
      ...(warnings.length > 0 ? { modelScopeWarnings: warnings } : {}),
    },
    modelError,
    modelErrorLogPath,
  );
}

const EMPTY_MODELS: ModelsData = {
  models: {},
  modelList: [],
  defaultModel: null,
  defaultThinkingLevel: null,
  savedDefaultThinkingLevel: null,
  thinkingLevels: {},
  thinkingLevelMaps: {},
  thinkingLevelPins: {},
  thinkingLevelDefaults: {},
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwdParam = url.searchParams.get("cwd");
  // No cwd requested: fall back to the server process cwd. Nothing was
  // caller-specified, so there is no access boundary to enforce.
  const requestedCwd = cwdParam || process.cwd();
  const cwd = resolve(requestedCwd);

  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
  }
  if (!cwdStat.isDirectory()) {
    return Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 });
  }
  if (cwdParam) {
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }
  }

  try {
    return Response.json(await loadModelsWithCache(cwd, () => loadModels(cwd)));
  } catch (error) {
    const message = `Model discovery failed: ${describeModelError(error)}`;
    const logPath = await recordModelError(cwd, error);
    const modelError: ModelErrorInfo = {
      code: "MODEL_DISCOVERY_FAILED",
      message,
      ...(logPath ? { logPath } : {}),
    };
    console.error(`[pi-web] ${message}${logPath ? ` (diagnostics: ${logPath})` : ""}`);
    return Response.json(
      { ...EMPTY_MODELS, modelError },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
