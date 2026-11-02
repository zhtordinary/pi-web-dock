import { NextRequest, NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { listOpenApps, mutateOpenApps } from "@/lib/open-apps";

// 本机可用「打开文件的应用」清单 + 增删（「添加应用…」/「− 减去应用」写 open-apps.json）。
// darwin 自动枚举 /Applications + /System/Applications + ~/Applications；
// ?ext=md 只列显式声明该类型的应用（通配声明不算；映射/显式添加条目不受过滤）；
// linux 需 open-apps.json 映射（无枚举源，不支持添加）。

export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const ext = new URL(request.url).searchParams.get("ext") ?? undefined;
    const apps = listOpenApps(ext).map((app) => ({ id: app.id, label: app.label }));
    return NextResponse.json({ apps });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const body = await request.json().catch(() => null) as { action?: unknown; appId?: unknown } | null;
    if (body?.action !== "add" && body?.action !== "remove") {
      return NextResponse.json({ error: "action must be \"add\" or \"remove\"" }, { status: 400 });
    }
    if (typeof body.appId !== "string" || !body.appId.trim()) {
      return NextResponse.json({ error: "appId is required" }, { status: 400 });
    }
    mutateOpenApps(body.action, body.appId.trim());
    const apps = listOpenApps().map((app) => ({ id: app.id, label: app.label }));
    return NextResponse.json({ apps });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
