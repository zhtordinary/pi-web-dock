import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { localDeviceId, readActivityConfig } from "@/lib/activity-peers";
import path from "node:path";
import { spawn } from "node:child_process";
import { isApiRequestAllowed } from "@/lib/request-security";
import { openCommandFor } from "@/lib/open-apps";

function getOpenDeviceTarget(deviceId: string): { kind: "local" } | { kind: "peer"; url: string } | null {
  const config = readActivityConfig();
  const localId = localDeviceId(config);
  if (deviceId === localId) return { kind: "local" };
  const peer = config.peers?.find((candidate) => candidate.id === deviceId);
  if (!peer) return null;
  try {
    const target = new URL(peer.url);
    if (target.protocol !== "http:" && target.protocol !== "https:") return null;
    return { kind: "peer", url: target.origin };
  } catch {
    return null;
  }
}

/**
 * 用数据所属设备的应用打开文件本身（appId 省略 = 系统默认应用，见 lib/open-apps）。
 */
function openFileWithApp(target: string, appId?: string): void {
  const args = openCommandFor(target, appId);
  const command = args[0];
  const rest = args.slice(1);
  const child = spawn(command, rest, { detached: true, stdio: "ignore" });
  // 打开命令缺失等异步失败静默处理（headless 场景已前置拦截；不崩服务）。
  child.on("error", () => { /* ignore */ });
  child.unref();
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  try {
    const body = await request.json().catch(() => null) as { path?: unknown; deviceId?: unknown; app?: unknown } | null;
    if (typeof body?.path !== "string" || !body.path.trim()) {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }

    const requestedDeviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
    const requestedApp = typeof body.app === "string" && body.app.trim() ? body.app.trim() : undefined;
    if (requestedDeviceId) {
      const target = getOpenDeviceTarget(requestedDeviceId);
      if (!target) return NextResponse.json({ error: "Unknown device" }, { status: 404 });
      if (target.kind === "peer") {
        const response = await fetch(new URL("/api/files/open", target.url), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: body.path, app: requestedApp }),
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
        const peerBody = await response.json().catch(() => null) as { opened?: string; error?: string } | null;
        if (!response.ok) return NextResponse.json({ error: peerBody?.error || `Remote open failed (HTTP ${response.status})` }, { status: 502 });
        return NextResponse.json({ opened: peerBody?.opened ?? body.path, deviceId: requestedDeviceId });
      }
    }

    const filePath = path.resolve(body.path);
    const target = fs.realpathSync(filePath);
    openFileWithApp(target, requestedApp);
    return NextResponse.json({ opened: target });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (code === "EACCES" || code === "EPERM") return NextResponse.json({ error: "Permission denied" }, { status: 403 });
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
