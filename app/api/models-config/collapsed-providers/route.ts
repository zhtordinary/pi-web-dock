import { NextResponse } from "next/server";
import { readModelsConfig, writeModelsConfig } from "@/lib/models-config-store";
import { normalizeCollapsedProviderNames } from "@/lib/model-visibility-preference";

export const dynamic = "force-dynamic";

// 折叠状态并入三机同步的 models.json 顶层 `collapsedProviders` 字段。
// 本路由读写该字段；`/api/remote/[...path]` 通用代理可透传到目标设备，
// 但折叠是全局模型偏好，经三机 Syncthing 收敛即可，本机读写即全局一致。

export async function GET() {
  const cfg = readModelsConfig();
  return NextResponse.json({ collapsedProviders: normalizeCollapsedProviderNames(cfg.collapsedProviders) });
}

export async function PUT(req: Request) {
  try {
    const body = await req.json() as { collapsedProviders?: unknown };
    const cfg = readModelsConfig();
    cfg.collapsedProviders = normalizeCollapsedProviderNames(body.collapsedProviders);
    writeModelsConfig(cfg);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
