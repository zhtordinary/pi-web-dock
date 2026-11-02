// Image-generation settings API (Reader local patch):
//   GET  ?sessionFile=...&cwd=...  → { enabled, genProvider, genModelId, genBackend, outputDir, outputDirGlobal, outputDirProject, outputDirScope, providers }
//   POST { action: "toggle", enabled }                          → per-session genEnabled (session entry, same channel as the extension)
//   POST { action: "setModel", provider, modelId, backend }     → per-session generation model
//   POST { action: "setOutputDir", outputDir, scope?, cwd? }    → output dir; scope "project" (default) writes <cwd>/.pi/multimodal-proxy.json, "global" writes image-generation.json
//   POST { action: "clearProjectOutputDir", cwd? }              → remove the project-scoped output dir override (restore global)
//   POST { action: "setGenOptions", size?, resolution?, quality? }   → explicit options; without sessionFile updates the default for future sessions
//   POST { action: "clearGenOptions", fields: ["size"|"resolution"|"quality"] } → follow request/tool values for this session (or clear the global default)
//   GET also returns genSize/genResolution/genQuality (effective values) and capabilities
//   (the installed pi-image-generation package owns parameter rules and capabilities).
import { mkdirSync, readFileSync, rmSync } from "fs";
import { stat } from "fs/promises";
import { dirname, join, resolve } from "path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import { getRpcSessionByFile } from "@/lib/rpc-manager";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { loadImageGenerationPackage } from "@/lib/image-generation-package";
import { imageGenerationQuote } from "@/lib/image-generation-pricing";

export const dynamic = "force-dynamic";

const CUSTOM_TYPE_CONFIG = "vision-proxy-config";
const VISION_CONFIG_FILE = "multimodal-proxy.json";
const SHARED_VISION_CONFIG_FILE = "multimodal-proxy.shared.json";
const GEN_CONFIG_FILE = "image-generation.json";

/**
 * The extension's /multimodal-proxy gen-model usage example uses the literal
 * placeholders "provider" and "model-id". Copy-pasting that command (or a
 * stale error hint) writes the placeholders as real config, after which every
 * generation fails with "Generation provider \"provider\" not configured"
 * while the panel still shows a valid model selected. Reject the placeholders
 * (and empty values) on the panel write path so the reader never persists them.
 */
const GEN_PLACEHOLDER_PROVIDER = "provider";
const GEN_PLACEHOLDER_MODEL = "model-id";

function isGenPlaceholder(provider: string, modelId: string): boolean {
  return provider === GEN_PLACEHOLDER_PROVIDER || modelId === GEN_PLACEHOLDER_MODEL;
}

function genSizeValid(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function genResolutionValid(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function genQualityValid(value: unknown): value is "auto" | "low" | "medium" | "high" | "xhigh" | "max" {
  return value === "auto" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

type GenOptionField = "size" | "resolution" | "quality" | "version";
function readGenOptionUnsets(value: unknown): GenOptionField[] {
  return loadImageGenerationPackage().readGenOptionUnsets(value);
}

function mergeSessionGenOptions(existing: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  return loadImageGenerationPackage().mergeSessionGenOptions(existing, next);
}

function clearSessionGenOptions(existing: Record<string, unknown>, fields: GenOptionField[]): Record<string, unknown> {
  return loadImageGenerationPackage().clearSessionGenOptions(existing, fields);
}

type GenBackend = "sync" | "async-task" | "chat-completions";

interface GenProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  backend?: GenBackend;
  models?: (string | { id?: string; name?: string })[];
}

function readJsonFile(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readGenConfig(agentDir: string): { outputDir: string; providers: Record<string, GenProviderConfig> } {
  const j = readJsonFile(join(agentDir, GEN_CONFIG_FILE));
  const providersRaw = j.providers && typeof j.providers === "object" ? (j.providers as Record<string, GenProviderConfig>) : {};
  const outputDir = typeof j.outputDir === "string" && j.outputDir.trim() ? j.outputDir.trim() : loadImageGenerationPackage().DEFAULT_OUTPUT_DIR;
  return { ...j, outputDir, providers: providersRaw };
}

/** Project-scoped generation config: <projectDir>/.pi/multimodal-proxy.json. */
function projectGenConfigPath(projectDir: string): string {
  return loadImageGenerationPackage().projectGenerationConfigPath(projectDir);
}

/**
 * Validate a caller-supplied project path before it is used to read or write
 * <cwd>/.pi/multimodal-proxy.json. Same policy as app/api/models/route.ts:
 * resolve -> must exist -> must be a directory -> must stay inside the allowed
 * roots (project dirs with sessions, plus explicitly allowed roots). Rejects
 * traversal, non-existent paths and writes to unrelated directories.
 */
async function validateProjectCwd(cwd: string): Promise<string | { status: number; error: string }> {
  const requested = cwd.trim();
  if (!requested) return { status: 400, error: "cwd required" };
  const resolved = resolve(requested);
  let cwdStat;
  try {
    cwdStat = await stat(resolved);
  } catch {
    return { status: 400, error: `Directory does not exist: ${resolved}` };
  }
  if (!cwdStat.isDirectory()) {
    return { status: 400, error: `Not a directory: ${resolved}` };
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(resolved, allowedRoots)) {
    return { status: 403, error: "Access denied" };
  }
  return resolved;
}

function readProjectGenConfig(projectDir: string): Record<string, unknown> {
  return readJsonFile(projectGenConfigPath(projectDir));
}

function writeProjectGenConfig(projectDir: string, config: Record<string, unknown>): void {
  const path = projectGenConfigPath(projectDir);
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, JSON.stringify(config, null, 2) + "\n");
}

function lastSessionConfig(entries: unknown[]): Record<string, unknown> {
  return loadImageGenerationPackage().generationSessionConfig(entries);
}

function writeMultimodalConfig(agentDir: string, config: Record<string, unknown>): void {
  writeMultimodalConfigFile(agentDir, VISION_CONFIG_FILE, config);
}

function writeMultimodalConfigFile(agentDir: string, fileName: string, config: Record<string, unknown>): void {
  writePrivateFileAtomicSync(join(agentDir, fileName), JSON.stringify(config, null, 2) + "\n");
}

function writeSharedMultimodalConfig(agentDir: string, config: Record<string, unknown>): void {
  writeMultimodalConfigFile(agentDir, SHARED_VISION_CONFIG_FILE, config);
}

/** Mirrors the terminal extension: shared generation defaults govern when present. */
function readMultimodalConfigLayers(agentDir: string): {
  local: Record<string, unknown>;
  shared: Record<string, unknown>;
  effective: Record<string, unknown>;
} {
  const local = readJsonFile(join(agentDir, VISION_CONFIG_FILE));
  const shared = readJsonFile(join(agentDir, SHARED_VISION_CONFIG_FILE));
  const effective = { ...local };
  for (const key of ["allowedProviders", "groundingModels", "genEnabled"] as const) {
    if (shared[key] !== undefined) effective[key] = shared[key];
  }
  return { local, shared, effective };
}

/**
 * Append a per-session config entry. Prefers the live agent session's
 * SessionManager so the write is visible to extensions immediately (their
 * getEntries reads the in-memory instance); falls back to opening the file
 * when the session is not currently running.
 */
function appendSessionConfig(sessionFile: string, data: Record<string, unknown>): void {
  const live = getRpcSessionByFile(sessionFile);
  if (live) {
    // Archive shutdown closes RPC write admission before moving the file.
    live.assertSessionWriteAllowed();
    live.inner.sessionManager.appendCustomEntry(CUSTOM_TYPE_CONFIG, data);
    return;
  }
  const sm = SessionManager.open(sessionFile, undefined);
  sm.appendCustomEntry(CUSTOM_TYPE_CONFIG, data);
}

async function readSessionConfig(sessionFile: string): Promise<Record<string, unknown>> {
  const live = getRpcSessionByFile(sessionFile);
  if (live) {
    return lastSessionConfig(await live.inner.sessionManager.getEntries());
  }
  const sm = SessionManager.open(sessionFile, undefined);
  return lastSessionConfig(await sm.getEntries());
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionFile = url.searchParams.get("sessionFile") ?? "";
  const cwdParam = url.searchParams.get("cwd") ?? "";
  // Only the image settings editor opts in; composer and quote reads stay redacted.
  const includeProviderKeys = url.searchParams.get("includeProviderKeys") === "1";
  // Caller-supplied cwd is a project path boundary (same policy as /api/models):
  // resolve, require an existing directory inside the allowed roots, then read
  // <cwd>/.pi/multimodal-proxy.json from the validated path only.
  let projectCwd: string | null = null;
  if (cwdParam) {
    const validated = await validateProjectCwd(cwdParam);
    if (typeof validated !== "string") {
      return Response.json({ error: validated.error }, { status: validated.status });
    }
    projectCwd = validated;
  }
  const agentDir = getAgentDir();

  let generation;
  try { generation = loadImageGenerationPackage(agentDir); }
  catch (error) {
    // The package is optional: composer reads get no content, the settings editor learns why.
    if (!includeProviderKeys) return new Response(null, { status: 204 });
    return Response.json({ error: (error as Error).message }, { status: 503 });
  }
  const { genProviderModels } = generation;
  const genCfg = readGenConfig(agentDir);
  if (url.searchParams.get("quote") === "1") {
    const requestedProviderName = (url.searchParams.get("provider") ?? "").trim();
    const model = url.searchParams.get("model") ?? "";
    const providerMatches = Object.entries(genCfg.providers).filter(([name]) =>
      name === requestedProviderName || name.toLowerCase() === requestedProviderName.toLowerCase(),
    );
    if (providerMatches.length !== 1) return Response.json({ error: "Unknown generation provider/model" }, { status: 400 });
    const [providerName, provider] = providerMatches[0];
    if (!genProviderModels(provider).includes(model)) return Response.json({ error: "Unknown generation provider/model" }, { status: 400 });
    return Response.json(await imageGenerationQuote(provider.baseUrl ?? "", model, fetch, url.searchParams.get("refresh") === "1", providerName),
      { headers: { "Cache-Control": "no-store" } });
  }
  let sessionCfg: Record<string, unknown> = {};
  if (sessionFile) {
    try {
      sessionCfg = await readSessionConfig(sessionFile);
    } catch {
      sessionCfg = {};
    }
  }

  const eff = generation.resolveEffectiveConfig([{ type: "custom", customType: CUSTOM_TYPE_CONFIG, data: sessionCfg }], projectCwd ?? agentDir, agentDir);
  const genProvider = eff.genProvider ?? null;
  const genModelId = eff.genModelId ?? null;
  const genBackend = eff.genBackend === "async-task" ? "apimart" : eff.genBackend === "chat-completions" ? "chat-completions" : "registry";
  const genInvalid = eff.genEnabled === "on" && (!genProvider || !genModelId || isGenPlaceholder(genProvider, genModelId) || !eff.providers[genProvider]);
  const genSize = eff.genSize ?? null;
  const genResolution = eff.genResolution ?? null;
  const genQuality = eff.genQuality ?? null;
  const genVersion = eff.genVersion ?? null;
  const outputDirGlobal = eff.outputDirGlobal ?? genCfg.outputDir;
  const outputDirProject = eff.outputDirProject ?? null;
  const outputDir = outputDirProject ?? outputDirGlobal;
  const outputDirScope = outputDirProject !== null ? "project" : "global";
  return Response.json({
    enabled: eff.genEnabled === "on",
    genProvider,
    genModelId,
    genBackend,
    genInvalid,
    genSize,
    genResolution,
    genQuality,
    genVersion,
    genOptionsUnset: readGenOptionUnsets(sessionCfg.genOptionsUnset),
    capabilities: generation.generationPanelCapabilities(genProvider ?? undefined, agentDir, projectCwd ?? undefined, eff.genBackend),
    parameterSources: eff.parameterSources,
    outputDir,
    outputDirGlobal,
    outputDirProject,
    outputDirScope,
    providers: Object.fromEntries(
      Object.entries(eff.providers).map(([name, p]) => {
        const apiKey = genCfg.providers[name]?.apiKey;
        return [name, {
          models: genProviderModels(p),
          baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : "",
          apiKeyConfigured: Boolean(apiKey),
          ...(p.backend ? { backend: p.backend } : {}),
          ...(includeProviderKeys ? { apiKey: typeof apiKey === "string" ? apiKey : "" } : {}),
        }];
      }),
    ),
  }, { headers: includeProviderKeys ? { "Cache-Control": "no-store" } : undefined });
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const action = body.action;
  const sessionFile = typeof body.sessionFile === "string" ? body.sessionFile : "";
  const agentDir = getAgentDir();
  let generation;
  try { generation = loadImageGenerationPackage(agentDir); }
  catch (error) { return Response.json({ error: (error as Error).message }, { status: 503 }); }

  // Output dir lives in image-generation.json (global, shared via sync).
  // Provider CRUD in image-generation.json (gen panel custom providers).
  if (action === "saveGenProvider") {
    const name = typeof body.providerName === "string" ? body.providerName.trim() : "";
    const p = body.provider as { baseUrl?: unknown; apiKey?: unknown; backend?: unknown; models?: unknown } | null;
    if (!name || !p || typeof p !== "object") {
      return Response.json({ error: "providerName and provider object required" }, { status: 400 });
    }
    const genCfg = readGenConfig(agentDir);
    const providers = { ...genCfg.providers };
    const previous = providers[name];
    const backend = p.backend === "sync" || p.backend === "async-task" || p.backend === "chat-completions"
      ? p.backend : previous?.backend;
    providers[name] = {
      // Editing a provider never sends its secret back to the client. Keep the
      // stored values when the form leaves those fields blank.
      baseUrl: typeof p.baseUrl === "string" && p.baseUrl.trim() ? p.baseUrl.trim() : typeof previous?.baseUrl === "string" ? previous.baseUrl : "",
      apiKey: typeof p.apiKey === "string" && p.apiKey.trim() ? p.apiKey.trim() : typeof previous?.apiKey === "string" ? previous.apiKey : "",
      ...(backend ? { backend } : {}),
      models: Array.isArray(p.models)
        ? p.models.filter((m): m is string => typeof m === "string").map((m) => m.trim()).filter(Boolean)
        : previous?.models ?? [],
    };
    writePrivateFileAtomicSync(join(agentDir, GEN_CONFIG_FILE), JSON.stringify({ ...genCfg, providers }, null, 2) + "\n");
    return Response.json({ ok: true });
  }

  if (action === "deleteGenProvider") {
    const name = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!name) return Response.json({ error: "providerName required" }, { status: 400 });
    const genCfg = readGenConfig(agentDir);
    const providers = { ...genCfg.providers };
    delete providers[name];
    writePrivateFileAtomicSync(join(agentDir, GEN_CONFIG_FILE), JSON.stringify({ ...genCfg, providers }, null, 2) + "\n");
    return Response.json({ ok: true });
  }

  if (action === "setOutputDir") {
    const dir = typeof body.outputDir === "string" ? body.outputDir.trim() : "";
    if (!dir) return Response.json({ error: "outputDir required" }, { status: 400 });
    const scope = body.scope === "project" ? "project" : "global";
    if (scope === "project") {
      // Project-scoped: <cwd>/.pi/multimodal-proxy.json — same file the terminal
      // extension reads, so a relative path resolves against the project root
      // and travels with the project on every synced device.
      const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : "";
      if (!cwd) return Response.json({ error: "no active project (cwd) for project scope" }, { status: 400 });
      const validatedCwd = await validateProjectCwd(cwd);
      if (typeof validatedCwd !== "string") {
        return Response.json({ error: validatedCwd.error }, { status: validatedCwd.status });
      }
      const existing = readProjectGenConfig(validatedCwd);
      writeProjectGenConfig(validatedCwd, { ...existing, outputDir: dir });
      return Response.json({ ok: true, outputDir: dir, scope: "project" });
    }
    const genCfg = readGenConfig(agentDir);
    const next = { ...genCfg, outputDir: dir };
    writePrivateFileAtomicSync(join(agentDir, GEN_CONFIG_FILE), JSON.stringify(next, null, 2) + "\n");
    return Response.json({ ok: true, outputDir: dir, scope: "global" });
  }

  if (action === "clearProjectOutputDir") {
    const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : "";
    if (!cwd) return Response.json({ error: "cwd required" }, { status: 400 });
    const validatedCwd = await validateProjectCwd(cwd);
    if (typeof validatedCwd !== "string") {
      return Response.json({ error: validatedCwd.error }, { status: validatedCwd.status });
    }
    // Both supported project files can carry an output override.
    const clearedPaths = new Set<string>();
    for (let remaining = 2; remaining > 0; remaining--) {
      const path = projectGenConfigPath(validatedCwd);
      if (clearedPaths.has(path)) break;
      clearedPaths.add(path);
      const existing = readJsonFile(path);
      if (!("outputDir" in existing)) break;
      delete existing.outputDir;
      if (Object.keys(existing).length === 0) rmSync(path, { force: true });
      else writePrivateFileAtomicSync(path, JSON.stringify(existing, null, 2) + "\n");
    }
    return Response.json({ ok: true });
  }

  // Generation enable and model are persisted as GLOBAL DEFAULTS (so a
  // choice made once carries into every new session — otherwise new sessions
  // start with no generation model and fail with "No image-generation model
  // set") AND into the session entry when the session has a file (last entry
  // wins, so per-session overrides keep working and the running extension
  // sees the write immediately through the live SessionManager).
  const configLayers = readMultimodalConfigLayers(agentDir);
  const fileConfig = configLayers.local;
  const sharedFileConfig = configLayers.shared;

  if (action === "toggle") {
    const enabled = body.enabled === true;
    const genEnabled = enabled ? "on" : "off";
    const nextLocal = { ...fileConfig };
    delete nextLocal.genEnabled;
    if (sharedFileConfig.genEnabled !== undefined) {
      writeSharedMultimodalConfig(agentDir, { ...sharedFileConfig, genEnabled });
      writeMultimodalConfig(agentDir, nextLocal);
    } else {
      writeMultimodalConfig(agentDir, { ...nextLocal, genEnabled });
    }
    if (sessionFile) {
      const existing = await readSessionConfig(sessionFile);
      appendSessionConfig(sessionFile, { ...existing, genEnabled });
    }
    return Response.json({ ok: true, enabled });
  }

  if (action === "setModel") {
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
    if (!provider || !modelId) return Response.json({ error: "provider/modelId required" }, { status: 400 });
    if (isGenPlaceholder(provider, modelId)) {
      return Response.json(
        { error: `invalid generation model "${provider}/${modelId}": placeholders from the /multimodal-proxy usage example are not real models` },
        { status: 400 },
      );
    }
    const genConfig = readGenConfig(agentDir);
    const providers = genConfig.providers;
    if (!providers[provider]) {
      return Response.json(
        { error: `generation provider "${provider}" is not configured in ~/.pi/agent/image-generation.json` },
        { status: 400 },
      );
    }
    const backend = providers[provider]?.backend === "chat-completions" ? "chat-completions"
      : provider.toLowerCase() === "apimart" ? "apimart" : "registry";
    if ("defaultProvider" in genConfig || "defaultModelId" in genConfig || "defaultBackend" in genConfig) {
      writePrivateFileAtomicSync(join(agentDir, GEN_CONFIG_FILE), JSON.stringify({ ...genConfig, defaultProvider: provider, defaultModelId: modelId,
        defaultBackend: backend === "apimart" ? "async-task" : backend === "chat-completions" ? "chat-completions" : "sync" }, null, 2) + "\n");
    }
    writeMultimodalConfig(agentDir, { ...fileConfig, genProvider: provider, genModelId: modelId, genBackend: backend });
    if (sessionFile) {
      const existing = await readSessionConfig(sessionFile);
      appendSessionConfig(sessionFile, { ...existing, genProvider: provider, genModelId: modelId, genBackend: backend });
    }
    return Response.json({ ok: true, genProvider: provider, genModelId: modelId, genBackend: backend });
  }

  if (action === "setGenOptions") {
    const hasSize = genSizeValid(body.size);
    const hasResolution = genResolutionValid(body.resolution);
    const hasQuality = genQualityValid(body.quality);
    const hasVersion = body.version === "flare" || body.version === "sunburst";
    if (body.version !== undefined && !hasVersion) return Response.json({ error: "version must be flare or sunburst" }, { status: 400 });
    if (!hasSize && !hasResolution && !hasQuality && !hasVersion) {
      return Response.json({ error: "size, resolution, quality or version required" }, { status: 400 });
    }
    const next = {
      ...(hasSize ? { genSize: (body.size as string).trim() } : {}),
      ...(hasResolution ? { genResolution: (body.resolution as string).trim() } : {}),
      ...(hasQuality ? { genQuality: body.quality } : {}),
      ...(hasVersion ? { genVersion: body.version } : {}),
    };
    // A session choice belongs to that session. Only a new-session choice
    // (before sessionFile exists) updates the default inherited by future
    // sessions; otherwise an existing session would change other sessions
    // that have not written their own override yet.
    if (!sessionFile) {
      const nextFile: Record<string, unknown> = { ...fileConfig, ...next };
      delete nextFile.genOptionsUnset;
      writeMultimodalConfig(agentDir, nextFile);
    }
    if (sessionFile) {
      const existing = await readSessionConfig(sessionFile);
      appendSessionConfig(sessionFile, mergeSessionGenOptions(existing, next));
    }
    return Response.json({ ok: true, ...next });
  }

  if (action === "clearGenOptions") {
    const fields = readGenOptionUnsets(body.fields);
    if (fields.length === 0) {
      return Response.json({ error: "fields must include size, resolution, quality or version" }, { status: 400 });
    }
    if (!sessionFile) {
      const nextFile = { ...fileConfig };
      for (const field of fields) delete nextFile[generation.GEN_OPTION_KEYS[field]];
      delete nextFile.genOptionsUnset;
      writeMultimodalConfig(agentDir, nextFile);
    } else {
      const existing = await readSessionConfig(sessionFile);
      appendSessionConfig(sessionFile, clearSessionGenOptions(existing, fields));
    }
    return Response.json({ ok: true, cleared: fields });
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}
