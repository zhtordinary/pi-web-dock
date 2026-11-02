import deviceIdentity from "../bin/device-identity.cjs";
import type { SessionActivityDevice } from "./session-activity-types";

export interface ActivityConfig {
  device?: { id?: string; name?: string; url?: string; order?: number };
  peers?: Array<{ id: string; name: string; url: string; order?: number }>;
}

export function readActivityConfig(): ActivityConfig {
  return deviceIdentity.readActivityConfig() as ActivityConfig;
}

export function localDeviceId(config?: ActivityConfig): string {
  return deviceIdentity.localDeviceId(config);
}

export function localDeviceIdentity(config: ActivityConfig, generatedAt: string): SessionActivityDevice {
  return {
    id: localDeviceId(config),
    name: deviceIdentity.localDeviceName(config),
    ...(config.device?.url ? { url: config.device.url } : {}),
    online: true,
    lastSeenAt: generatedAt,
  };
}

export function configuredPeerList(config: ActivityConfig, local: SessionActivityDevice): Array<{ id: string; name: string; url: string }> {
  const peers = Array.isArray(config.peers) ? config.peers : [];
  return peers.filter((peer) => peer.id && peer.name && peer.url && peer.id !== local.id);
}

/** 按设备 id 解析可达 baseUrl（含本机 device.url），找不到返回 null。 */
export function resolvePeerUrl(peerId: string): string | null {
  const config = readActivityConfig();
  const local = localDeviceIdentity(config, new Date().toISOString());
  if (local.id === peerId && config.device?.url) {
    return config.device.url;
  }
  const peer = configuredPeerList(config, local).find((candidate) => candidate.id === peerId);
  return peer?.url ?? null;
}

/**
 * Resolve a peer for the browser channel that issued the request.
 * Preview HTTPS :30144 must reach the peer's preview HTTPS :30144, not its production :30143.
 */
export function resolvePeerUrlForRequest(peerId: string, requestUrl: string, headers?: Headers): string | null {
  const baseUrl = resolvePeerUrl(peerId);
  if (!baseUrl) return null;
  try {
    const request = new URL(requestUrl);
    const forwardedPort = headers?.get("x-forwarded-port")?.split(",", 1)[0]?.trim();
    const forwardedHost = headers?.get("x-forwarded-host")?.split(",", 1)[0]?.trim() ?? headers?.get("host")?.split(",", 1)[0]?.trim();
    const headerPort = forwardedPort || (forwardedHost ? new URL(`http://${forwardedHost}`).port : "");
    const requestPort = headerPort || request.port;
    const previewChannel = requestPort === "30144" || process.env.PI_WEB_BOUND_PORT === "30142";
    const target = new URL(baseUrl);
    if (previewChannel && target.port === "30143") target.port = "30144";
    return target.toString().replace(/\/$/u, "");
  } catch {
    return baseUrl;
  }
}
