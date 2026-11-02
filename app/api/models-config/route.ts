import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { NextResponse } from "next/server";
import { refreshRpcSessionModels, MODEL_RUNTIME_REFRESH_TIMEOUT_MS } from "@/lib/rpc-manager";
import { ContextWindowError, normalizeContextWindowOverrides } from "@/lib/model-context";
import { ProviderEntryError, checkProviderEntries } from "@/lib/model-provider-check";
import { ModelImageLimitError, checkModelImageLimits } from "@/lib/model-image-limits";
import {
  ModelsConfigReadError,
  detectProviderRenames,
  readModelsConfig,
  writeModelsConfig,
} from "@/lib/models-config-store";

export const dynamic = "force-dynamic";

async function migrateDefaultProvider(
  renames: ReturnType<typeof detectProviderRenames>,
): Promise<boolean> {
  if (renames.length === 0) return false;

  const settings = SettingsManager.create(process.cwd(), getAgentDir(), { projectTrusted: true });
  const defaultProvider = settings.getDefaultProvider();
  const defaultRename = renames.find((rename) => rename.oldName === defaultProvider);
  if (!defaultRename) return false;

  settings.setDefaultProvider(defaultRename.newName);
  await settings.flush();
  return true;
}

export async function GET() {
  try {
    return NextResponse.json(readModelsConfig());
  } catch (error) {
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const previous = readModelsConfig();
    const rawBody = await req.json() as Record<string, unknown>;
    const body = normalizeContextWindowOverrides(rawBody);
    // Refuse an entry pi itself would drop on load: saving it would leave a
    // provider that never appears, with no hint which entry caused it.
    checkProviderEntries(body);
    checkModelImageLimits(body);
    const providerRenames = detectProviderRenames(previous, body);
    writeModelsConfig(body);
    const defaultProviderMigrated = await migrateDefaultProvider(providerRenames);
    const runtimeRefresh = await refreshRpcSessionModels({ timeoutMs: MODEL_RUNTIME_REFRESH_TIMEOUT_MS });
    return NextResponse.json({ success: true, providerRenames, defaultProviderMigrated, runtimeRefresh });
  } catch (error) {
    if (error instanceof ContextWindowError || error instanceof ProviderEntryError || error instanceof ModelImageLimitError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
