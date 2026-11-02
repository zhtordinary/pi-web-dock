import { NextResponse } from "next/server";
import { invalidateModelsCache } from "@/lib/models-cache";
import { readModelsConfig, writeModelsConfig } from "@/lib/models-config-store";
import { normalizeHiddenModelReferences } from "@/lib/model-visibility";

export const dynamic = "force-dynamic";

// 单模型隐藏写入三机同步的 models.json 顶层 `hiddenModels` 字段
// （`provider/modelId` 引用）。它是纯显示偏好，不改 provider、模型配置或
// `enabledModels`；经 Syncthing 与 models.json 一起收敛。

export async function GET() {
  const cfg = readModelsConfig();
  return NextResponse.json({ hiddenModels: normalizeHiddenModelReferences(cfg.hiddenModels) });
}

export async function PUT(req: Request) {
  try {
    const body = await req.json() as { hiddenModels?: unknown };
    const cfg = readModelsConfig();
    cfg.hiddenModels = normalizeHiddenModelReferences(body.hiddenModels);
    writeModelsConfig(cfg);
    invalidateModelsCache();
    return NextResponse.json({ success: true, hiddenModels: cfg.hiddenModels });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
