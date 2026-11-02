import { createModelRuntimeWithExtensions, disposeModelRuntime } from "@/lib/model-runtime";
import { discoverPluginModelSettings, readPluginModelSettings, writePluginModelSettings, type PluginModelSelection } from "@/lib/plugin-model-settings";
import { ResourceSettingsError } from "@/lib/resource-config-file";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown): Response {
  const status = error instanceof ResourceSettingsError ? error.status : 500;
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}

export function GET() {
  try {
    const agentDir = getAgentDir();
    const rows = discoverPluginModelSettings(agentDir).map((descriptor) => {
      try { return readPluginModelSettings(descriptor, agentDir); }
      catch (error) { return { id: descriptor.id, label: descriptor.label, error: error instanceof Error ? error.message : String(error) }; }
    });
    return Response.json({ rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body: unknown = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ResourceSettingsError("invalid_request", "Invalid settings request");
    const input = body as Record<string, unknown>;
    if (typeof input.id !== "string" || typeof input.revision !== "string"
      || Object.keys(input).some((key) => !["id", "revision", "model", "thinking"].includes(key))
      || (input.model === undefined && input.thinking === undefined)
      || (input.thinking !== undefined && typeof input.thinking !== "string")) {
      throw new ResourceSettingsError("invalid_request", "Invalid settings request");
    }
    const agentDir = getAgentDir();
    const descriptor = discoverPluginModelSettings(agentDir).find((item) => item.id === input.id);
    if (!descriptor) throw new ResourceSettingsError("plugin_not_found", "Plugin model settings are unavailable", 404);
    const previous = readPluginModelSettings(descriptor, agentDir);
    const selected = input.model === undefined ? previous.model : input.model;
    if (selected !== null && selected !== "mixed") {
      if (!selected || typeof selected !== "object" || Array.isArray(selected)
        || typeof (selected as { provider?: unknown }).provider !== "string"
        || typeof (selected as { modelId?: unknown }).modelId !== "string") {
        throw new ResourceSettingsError("invalid_model", "Model requires provider and model ID");
      }
      const { provider, modelId } = selected as PluginModelSelection & { provider: string; modelId: string };
      const runtime = await createModelRuntimeWithExtensions();
      try {
        const model = (await runtime.getAvailable()).find((item) => item.api !== "pi-virtual" && item.provider === provider && item.id === modelId);
        if (!model) throw new ResourceSettingsError("model_unavailable", `Model not available: ${provider}/${modelId}`);
        const thinking = input.thinking === undefined ? previous.thinking : input.thinking;
        if (typeof thinking === "string" && !["mixed", "auto", "session-default"].includes(thinking)
          && !getSupportedThinkingLevels(model).some((level) => level === thinking)) {
          throw new ResourceSettingsError("invalid_thinking", "Thinking level is not supported by the selected model");
        }
      } finally { disposeModelRuntime(runtime); }
    } else if (selected === "mixed") {
      throw new ResourceSettingsError("invalid_model", "Choose one model before saving");
    }
    const row = writePluginModelSettings(descriptor, agentDir, input.revision, {
      ...(input.model !== undefined ? { model: input.model as PluginModelSelection } : {}),
      ...(input.thinking !== undefined ? { thinking: input.thinking as string } : {}),
    });
    return Response.json({ row }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "Invalid JSON request" }, { status: 400 });
    return errorResponse(error);
  }
}
