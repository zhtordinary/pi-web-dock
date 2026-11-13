/* SharedWorker: notification state only; commands and private conversations stay in their session APIs. */
const clients = new Map();
const snapshots = new Map();
const recent = [];
const cursors = new Map();
function resumeUrl() {
  return cursors.size ? `/api/reader/events?cursors=${encodeURIComponent(JSON.stringify(Object.fromEntries(cursors)))}` : "/api/reader/events";
}
const GLOBAL_WATCHDOG_MS = 75_000;
const GLOBAL_WATCHDOG_CHECK_MS = 25_000;
let source = null;
let reconnectTimer = null;
let watchdogTimer = null;
let lastSeenAt = 0;
function clearWatchdog() { if (watchdogTimer !== null) clearInterval(watchdogTimer); watchdogTimer = null; lastSeenAt = 0; }
function watch(candidate) {
  if (source !== candidate) return;
  lastSeenAt = Date.now();
  if (watchdogTimer !== null) return;
  watchdogTimer = setInterval(() => {
    if (source !== candidate || !lastSeenAt || Date.now() - lastSeenAt < GLOBAL_WATCHDOG_MS) return;
    clearWatchdog();
    candidate.close(); source = null; connected = false;
    broadcast({ kind: "error", sharing: "worker" }); scheduleReconnect();
  }, GLOBAL_WATCHDOG_CHECK_MS);
}
function recheck() {
  if (!source || !lastSeenAt || Date.now() - lastSeenAt < GLOBAL_WATCHDOG_MS) return;
  const candidate = source;
  clearWatchdog();
  candidate.close(); source = null; connected = false;
  broadcast({ kind: "error", sharing: "worker" }); scheduleReconnect();
}
let connected = false;
const CLOSED = EventSource.CLOSED ?? 2;
function send(port, packet) { try { port.postMessage(packet); } catch { clients.delete(port); } }
function broadcast(packet) { for (const port of clients.keys()) send(port, packet); }
function stopIfUnused() {
  if (!clients.size) {
    clearWatchdog();
    source?.close();
    source = null;
    connected = false;
    if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    snapshots.clear();
    recent.length = 0;
  }
}
function scheduleReconnect() {
  if (reconnectTimer !== null || !clients.size) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (clients.size) connect();
  }, 1000);
}
function connect() {
  if (source || reconnectTimer !== null || !clients.size) return;
  const candidate = new EventSource(resumeUrl());
  source = candidate;
  watch(candidate);
  candidate.addEventListener?.("ping", () => { if (source === candidate) watch(candidate); });
  candidate.onopen = () => {
    if (source !== candidate) return;
    watch(candidate);
    connected = true;
    broadcast({ kind: "open", sharing: "worker" });
  };
  candidate.onerror = () => {
    if (source !== candidate) return;
    connected = false;
    broadcast({ kind: "error", sharing: "worker" });
    if (candidate.readyState !== CLOSED) return;
    clearWatchdog();
    candidate.close();
    source = null;
    scheduleReconnect();
  };
  candidate.onmessage = ({ data }) => {
    if (source !== candidate) return;
    watch(candidate);
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (!event || typeof event.type !== "string") return;
    if (typeof event.device === "string" && typeof event.bootId === "string" && Number.isSafeInteger(event.seq)) {
      const previous = cursors.get(event.device);
      if (event.type === "activity_meta" && event.reset) {
          cursors.delete(event.device);
          for (const [key, snapshot] of snapshots) if (snapshot.device === event.device && !(snapshot.type === "runtime_identity" && snapshot.bootId === event.bootId)) snapshots.delete(key);
          for (let i = recent.length - 1; i >= 0; i--) if (recent[i].device === event.device) recent.splice(i, 1);
        }
      if (event.type === "activity" || event.type === "waits_changed") {
        if (previous?.bootId === event.bootId && event.seq <= previous.seq) return;
        cursors.set(event.device, { bootId: event.bootId, seq: event.seq });
      }
    }
    if (["runtime_identity", "running", "waiting_user", "peer_state", "waits_changed"].includes(event.type)) snapshots.set(`${event.type}:${event.device ?? "local"}`, event);
    if (event.type === "activity") { recent.push(event); if (recent.length > 200) recent.shift(); }
    broadcast({ kind: "event", data: event });
    stopIfUnused();
  };
}
self.onconnect = ({ ports }) => {
  const port = ports[0];
  port.onmessage = ({ data }) => {
    if (data?.kind === "unsubscribe") { clients.delete(port); port.close(); stopIfUnused(); return; }
    if (data?.kind === "resume") { recheck(); return; }
    if (data?.kind !== "subscribe" && data?.kind !== "ping") return;
    const joined = !clients.has(port);
    clients.set(port, true);
    if (!joined) return;
    send(port, { kind: "ready" });
    if (connected) send(port, { kind: "open", sharing: "worker" });
    for (const event of snapshots.values()) send(port, { kind: "event", data: { ...event, snapshot: true } });
    for (const event of recent) send(port, { kind: "event", data: { ...event, replay: true } });
    connect();
  };
  port.start();
};
