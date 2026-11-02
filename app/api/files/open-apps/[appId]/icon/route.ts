import { NextRequest, NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getAppIconPng } from "@/lib/open-apps";

// 应用图标（darwin icns/png → sips 转 32px PNG，磁盘缓存；非 darwin/无图标 404）。

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> },
) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { appId } = await params;
  if (!appId) return NextResponse.json({ error: "Missing app id" }, { status: 400 });
  const png = getAppIconPng(decodeURIComponent(appId));
  if (!png) return NextResponse.json({ error: "No icon for app" }, { status: 404 });
  return new NextResponse(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
