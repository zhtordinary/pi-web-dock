import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { localDeviceId, readActivityConfig } from "@/lib/activity-peers";
import path from "node:path";
import { spawn } from "node:child_process";
import { isApiRequestAllowed } from "@/lib/request-security";
import { fileViewerCommandFor, getDefaultFileViewerBundleId } from "@/lib/open-apps";

function getRevealDeviceTarget(deviceId: string): { kind: "local" } | { kind: "peer"; url: string } | null {
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

function openPath(target: string): void {
  const args = fileViewerCommandFor(target, getDefaultFileViewerBundleId());
  const command = args[0];
  const child = spawn(command, args.slice(1), { detached: true, stdio: "ignore" });
  child.on("error", () => { /* ignore: desktop opener is best-effort */ });
  child.unref();
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  try {
    const body = await request.json().catch(() => null) as { path?: unknown; deviceId?: unknown } | null;
    if (typeof body?.path !== "string" || !body.path.trim()) {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }

    const requestedDeviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
    if (requestedDeviceId) {
      const target = getRevealDeviceTarget(requestedDeviceId);
      if (!target) return NextResponse.json({ error: "Unknown device" }, { status: 404 });
      if (target.kind === "peer") {
        const response = await fetch(new URL("/api/files/reveal", target.url), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: body.path }),
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
        const peerBody = await response.json().catch(() => null) as { opened?: string; error?: string } | null;
        if (!response.ok) return NextResponse.json({ error: peerBody?.error || `Remote reveal failed (HTTP ${response.status})` }, { status: 502 });
        return NextResponse.json({ opened: peerBody?.opened ?? body.path, deviceId: requestedDeviceId });
      }
    }

    const filePath = path.resolve(body.path);
    const stat = fs.statSync(filePath);
    const target = stat.isDirectory() ? filePath : path.dirname(filePath);
    openPath(fs.realpathSync(target));
    return NextResponse.json({ opened: target });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (code === "EACCES" || code === "EPERM") return NextResponse.json({ error: "Permission denied" }, { status: 403 });
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
