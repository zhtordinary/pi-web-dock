import { NextResponse } from "next/server";
import { localDeviceId } from "@/lib/activity-peers";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const dynamic = "force-dynamic";

const CONFIG_FILE = process.env.PI_WEB_SESSION_ACTIVITY_CONFIG_FILE
  ?? join(process.env.HOME ?? ".", ".config", "pi-web-reader", "session-activity-peers.json");

interface ActivityPeerConfig { id: string; name: string; url: string; order?: number }
interface ActivityConfig {
  device?: { id?: string; name?: string; url?: string; order?: number };
  peers?: ActivityPeerConfig[];
}

function readConfig(): ActivityConfig {
  try {
    if (!existsSync(CONFIG_FILE)) return {};
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as ActivityConfig;
  } catch (error) {
    console.warn("[pi-web] session activity config unavailable:", error instanceof Error ? error.message : String(error));
    return {};
  }
}

/**
 * POST /api/peers  { url: "http://host:30141" }
 * 添加一台远端设备：探测对方的 /api/session-runs（自报 device 字段）识别
 * id/name，写入本机 session-activity-peers.json。纯配置操作，代码零硬编码，
 * 分享出去后每台机器各填自己的设备。
 */
export async function POST(req: Request) {
  try {
    if (process.env.PI_WEB_SESSION_ACTIVITY_CONFIG) {
      return NextResponse.json({ error: "Device configuration comes from environment variables; change the deployment configuration", code: "peer_config_from_env" }, { status: 400 });
    }
    const body = await req.json().catch(() => null) as { url?: unknown } | null;
    const rawUrl = typeof body?.url === "string" ? body.url.trim() : "";
    if (!rawUrl) return NextResponse.json({ error: "Enter the device address", code: "peer_url_required" }, { status: 400 });
    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      return NextResponse.json({ error: "Invalid address, for example http://192.168.1.10:30141", code: "peer_url_invalid" }, { status: 400 });
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return NextResponse.json({ error: "Only http/https addresses are supported", code: "peer_url_protocol" }, { status: 400 });
    }
    let remoteDevice: { id?: unknown; name?: unknown } | null = null;
    try {
      const probe = await fetch(`${target.origin}/api/session-runs?scope=local`, {
        cache: "no-store",
        signal: AbortSignal.timeout(3000),
      });
      const probeBody = await probe.json().catch(() => null) as { device?: { id?: unknown; name?: unknown } } | null;
      remoteDevice = probeBody?.device ?? null;
    } catch {
      // fall through
    }
    if (!remoteDevice || typeof remoteDevice.id !== "string" || !remoteDevice.id) {
      return NextResponse.json({ error: "Could not reach the device, or it is not a Pi Web Reader", code: "peer_unreachable" }, { status: 400 });
    }
    const peerId = remoteDevice.id;
    const peerName = typeof remoteDevice.name === "string" && remoteDevice.name.trim() ? remoteDevice.name.trim() : peerId;
    const peerUrl = target.origin;
    const config = readConfig();
    if (localDeviceId(config) === peerId) {
      return NextResponse.json({ error: "This is the local device address", code: "peer_is_local" }, { status: 400 });
    }
    const peers = Array.isArray(config.peers) ? config.peers : [];
    if (peers.some((peer) => peer.id === peerId)) {
      return NextResponse.json({ error: "The device is already in the list", code: "peer_exists" }, { status: 400 });
    }
    const nextPeers = [...peers, { id: peerId, name: peerName, url: peerUrl }];
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify({ ...config, peers: nextPeers }, null, 2) + "\n");
    return NextResponse.json({ added: true, peer: { id: peerId, name: peerName, url: peerUrl } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
