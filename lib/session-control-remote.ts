import { configuredPeerList, localDeviceIdentity, readActivityConfig } from "./activity-peers";

export function trustedSessionPeer(deviceId: string) {
  const config = readActivityConfig();
  const local = localDeviceIdentity(config, new Date().toISOString());
  const peer = configuredPeerList(config, local).find(peer => peer.id === deviceId);
  if (!peer) throw new Error(`Unknown trusted Reader device: ${deviceId}`);
  let url: URL;
  try { url = new URL(peer.url); } catch { throw new Error("Invalid trusted Reader URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid trusted Reader URL");
  return peer;
}

export async function requestRemoteSessionControl(
  deviceId: string,
  params: Record<string, unknown>,
  caller: { deviceId: string; sessionId: string },
  signal?: AbortSignal,
) {
  const peer = trustedSessionPeer(deviceId);
  const { getSessionWaitChannel } = await import("./session-waits");
  const timeoutMs = params.action === "wait_for" ? Math.min(30_000, Math.max(100, Number(params.timeoutMs) || 10_000)) + 5_000 : 15_000;
  const deadline = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${peer.url.replace(/\/$/, "")}/api/session-control/live`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, cache: "no-store",
    body: JSON.stringify({ channel: getSessionWaitChannel(), caller, params }),
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (!response.ok) throw new Error(`Remote session operation failed: HTTP ${response.status}`);
  const result = await response.json();
  if (!result || !Array.isArray(result.content) || result.content[0]?.type !== "text" || typeof result.content[0]?.text !== "string") throw new Error("Invalid remote session operation receipt");
  return result as { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };
}

export type RemoteUiSnapshot = {
  sessionId: string;
  sessionFile: string;
  runtimeGeneration: string;
  runtimeStatus: "live" | "closed";
  requests: Array<{ id: string; method: string; expiresAt?: number }>;
};

/** Read one event stream per observed remote session; reconnect is owned by the caller. */
export async function watchRemoteSessionUi(deviceId: string, sessionId: string, channel: string, signal: AbortSignal, onSnapshot: (snapshot: RemoteUiSnapshot) => void) {
  const peer = trustedSessionPeer(deviceId);
  let url: URL;
  try { url = new URL(`${peer.url.replace(/\/$/, "")}/api/session-control/live/events`); } catch { throw new Error("Invalid remote UI stream URL"); }
  url.searchParams.set("target", sessionId);
  url.searchParams.set("channel", channel);
  const watchdog = new AbortController();
  let timer = setTimeout(() => watchdog.abort(), 15_000); timer.unref?.();
  const streamSignal = AbortSignal.any([signal, watchdog.signal]);
  let response: Response;
  try { response = await fetch(url, { headers: { Accept: "text/event-stream" }, cache: "no-store", signal: streamSignal }); }
  catch (error) { clearTimeout(timer); throw error; }
  if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) { clearTimeout(timer); await response.body?.cancel(); throw new Error(`Remote UI stream unavailable: HTTP ${response.status}`); }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      clearTimeout(timer); timer = setTimeout(() => watchdog.abort(), 75_000); timer.unref?.();
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      if (buffer.length > 2 * 1024 * 1024) throw new Error("Remote UI event exceeds size limit");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data || frame.includes("event: ping")) continue;
        const event = JSON.parse(data);
        if (event.type === "transport_error") throw new Error("Remote UI runtime unavailable");
        if (event.type !== "ui_snapshot") continue;
        const snapshot = event.snapshot;
        if (snapshot?.sessionId !== sessionId || typeof snapshot.sessionFile !== "string" || !snapshot.sessionFile || typeof snapshot.runtimeGeneration !== "string" || !["live", "closed"].includes(snapshot.runtimeStatus) || !Array.isArray(snapshot.requests)
          || snapshot.requests.some((request: Record<string, unknown>) => typeof request?.id !== "string" || typeof request.method !== "string")) throw new Error("Invalid remote UI snapshot");
        onSnapshot(snapshot);
      }
    }
    if (!signal.aborted) throw new Error("Remote UI stream disconnected");
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
