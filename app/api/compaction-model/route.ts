import { stat } from "fs/promises";
import { resolve } from "path";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createModelRuntimeWithExtensions, disposeModelRuntime } from "@/lib/model-runtime";
import { parseCompactionModel, parseCompactionThinking } from "@/lib/compaction-model";
import { CompactionSettingsConflictError, readCompactionSettings, writeCompactionSettings } from "@/lib/compaction-model-settings";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { filterHiddenModels, normalizeHiddenModelReferences } from "@/lib/model-visibility";
import { resolveVisibleModels } from "@/lib/model-scope";
import { readModelsConfig } from "@/lib/models-config-store";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

export const dynamic = "force-dynamic";

async function requestCwd(raw: unknown): Promise<string> {
  if (raw === undefined || raw === null || raw === "") return process.cwd();
  if (typeof raw !== "string") throw new Error("Invalid cwd");
  const cwd = resolve(raw);
  const cwdStat = await stat(cwd).catch(() => null);
  if (!cwdStat) throw new Error(`Directory does not exist: ${cwd}`);
  if (!cwdStat.isDirectory()) throw new Error(`Not a directory: ${cwd}`);
  return cwd;
}

async function selectableModels(runtime: Awaited<ReturnType<typeof createModelRuntimeWithExtensions>>, cwd: string) {
  const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false });
  const scope = await resolveVisibleModels(runtime, settings.getEnabledModels());
  const hidden = normalizeHiddenModelReferences(readModelsConfig().hiddenModels);
  return filterHiddenModels(scope.visible, hidden).filter((item) => item.api !== "pi-virtual");
}

export async function GET(req: Request) {
  try {
    const { model, thinkingLevel } = await readCompactionSettings();
    const cwd = await requestCwd(req ? new URL(req.url).searchParams.get("cwd") : undefined);
    const runtime = await createModelRuntimeWithExtensions();
    try {
      const models = await selectableModels(runtime, cwd);
      return Response.json({ model, thinkingLevel, models: models.map((item) => ({
        provider: item.provider, modelId: item.id, name: item.name, contextWindow: item.contextWindow,
        thinkingLevels: getSupportedThinkingLevels(item), thinkingLevelMap: item.thinkingLevelMap,
      })) });
    } finally { disposeModelRuntime(runtime); }
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  let body: Record<string, unknown>;
  let expected: Awaited<ReturnType<typeof readCompactionSettings>> | undefined;
  try {
    const value: unknown = await req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid compression settings");
    body = value as Record<string, unknown>;
    if (Object.keys(body).some((key) => !["model", "thinkingLevel", "expected", "cwd"].includes(key)) || !("model" in body || "thinkingLevel" in body)) {
      throw new Error("model or thinkingLevel is required");
    }
    if ("cwd" in body && body.cwd !== undefined && typeof body.cwd !== "string") throw new Error("Invalid cwd");
    if ("model" in body) parseCompactionModel(body.model);
    if ("thinkingLevel" in body) parseCompactionThinking(body.thinkingLevel);
    if ("expected" in body) {
      const value = body.expected;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid expected compression settings");
      const snapshot = value as Record<string, unknown>;
      if (!("model" in snapshot) || !("thinkingLevel" in snapshot) || Object.keys(snapshot).some((key) => !["model", "thinkingLevel"].includes(key))) throw new Error("Invalid expected compression settings");
      expected = { model: parseCompactionModel(snapshot.model), thinkingLevel: parseCompactionThinking(snapshot.thinkingLevel) };
    }
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
  try {
    const previous = await readCompactionSettings();
    if (expected && JSON.stringify(previous) !== JSON.stringify(expected)) throw new CompactionSettingsConflictError("Compression settings changed; reload and retry");
    const model = "model" in body ? parseCompactionModel(body.model) : previous.model;
    const thinkingLevel = "thinkingLevel" in body ? parseCompactionThinking(body.thinkingLevel) : previous.thinkingLevel;
    const modelChanged = "model" in body && JSON.stringify(model) !== JSON.stringify(previous.model);
    if (model) {
      const cwd = await requestCwd(body.cwd);
      const runtime = await createModelRuntimeWithExtensions();
      try {
        const candidates = modelChanged || !previous.model
          ? await selectableModels(runtime, cwd)
          : (await runtime.getAvailable()).filter((item) => item.api !== "pi-virtual");
        const found = candidates.find((item) => item.provider === model.provider && item.id === model.modelId);
        if (!found) {
          const reason = modelChanged || !previous.model ? " in the enabled scope" : "";
          return Response.json({ error: `Model not available${reason}: ${model.provider}/${model.modelId}` }, { status: 400 });
        }
        if (thinkingLevel && thinkingLevel !== "auto" && !getSupportedThinkingLevels(found).includes(thinkingLevel)) {
          return Response.json({ error: "Thinking level is not supported by the selected model" }, { status: 400 });
        }
      } finally { disposeModelRuntime(runtime); }
    }
    await writeCompactionSettings(model, thinkingLevel, previous);
    return Response.json({ model, ...("thinkingLevel" in body ? { thinkingLevel } : {}) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof CompactionSettingsConflictError ? 409 : 500 });
  }
}
