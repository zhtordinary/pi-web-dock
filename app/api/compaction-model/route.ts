import { createModelRuntimeWithExtensions, disposeModelRuntime } from "@/lib/model-runtime";
import { parseCompactionModel, parseCompactionThinking } from "@/lib/compaction-model";
import { CompactionSettingsConflictError, readCompactionSettings, writeCompactionSettings } from "@/lib/compaction-model-settings";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { model, thinkingLevel } = await readCompactionSettings();
    const runtime = await createModelRuntimeWithExtensions();
    try {
      const models = (await runtime.getAvailable()).filter((item) => item.api !== "pi-virtual");
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
    if (Object.keys(body).some((key) => !["model", "thinkingLevel", "expected"].includes(key)) || !("model" in body || "thinkingLevel" in body)) {
      throw new Error("model or thinkingLevel is required");
    }
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
    if (model) {
      const runtime = await createModelRuntimeWithExtensions();
      try {
        const found = (await runtime.getAvailable()).find((item) => item.api !== "pi-virtual" && item.provider === model.provider && item.id === model.modelId);
        if (!found) return Response.json({ error: `Model not available: ${model.provider}/${model.modelId}` }, { status: 400 });
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
