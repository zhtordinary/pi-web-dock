/** One notification transport per origin. SharedWorker owns the background stream;
 * the BroadcastChannel lease provides sharing in WebViews without SharedWorker. */
export function createReaderEventsClient(env) {
  const url = "/api/reader/events";
  const cursors = new Map();
  const resumeUrl = () => cursors.size ? `${url}?cursors=${encodeURIComponent(JSON.stringify(Object.fromEntries(cursors)))}` : url;
  const listeners = new Set(), snapshots = new Map(), activity = [];
  let stopTransport = null, started = false, connected = false, sharing = null;
  const snapshotKey = (e) => ["runtime_identity", "running", "waiting_user", "peer_state", "waits_changed"].includes(e?.type)
    ? `${e.type}:${e.device ?? "local"}` : null;
  function deliver(packet) {
    if (!packet || typeof packet !== "object" || !["open", "error", "event"].includes(packet.kind)) return;
    if (packet.kind === "open") { connected = true; sharing = packet.sharing ?? sharing; }
    if (packet.kind === "error") connected = false;
    if (packet.kind === "event") {
      const event = packet.data;
      if (!event || typeof event !== "object" || typeof event.type !== "string") return;
      if (typeof event.device === "string" && typeof event.bootId === "string" && Number.isSafeInteger(event.seq)) {
        if (event.type === "activity_meta" && event.reset) {
          cursors.delete(event.device);
          for (const [key, snapshot] of snapshots) if (snapshot.device === event.device && !(snapshot.type === "runtime_identity" && snapshot.bootId === event.bootId)) snapshots.delete(key);
          for (let i = activity.length - 1; i >= 0; i--) if (activity[i].device === event.device) activity.splice(i, 1);
        }
        if (event.type === "activity" || event.type === "waits_changed") {
          const previous = cursors.get(event.device);
          if (previous?.bootId === event.bootId && event.seq <= previous.seq) return;
          cursors.set(event.device, { bootId: event.bootId, seq: event.seq });
        }
      }
      const key = snapshotKey(event);
      if (key) snapshots.set(key, event);
      if (event.type === "activity") {
        if (activity.some(e => e.device === event.device && e.bootId === event.bootId && e.seq === event.seq)) return;
        activity.push(event);
        if (activity.length > 200) activity.shift();
      }
    }
    for (const listener of [...listeners]) { try { listener(packet); } catch { /* isolate consumers */ } }
  }
  function replay(listener) {
    if (!listeners.has(listener)) return;
    const safe = packet => { try { listener(packet); } catch { /* isolate consumers */ } };
    if (connected) safe({ kind: "open", sharing });
    for (const data of snapshots.values()) safe({ kind: "event", data: { ...data, snapshot: true } });
    for (const data of activity) safe({ kind: "event", data: { ...data, replay: true } });
  }
  function fallback() {
    const id = env.crypto.randomUUID?.() ?? Array.from(env.crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, "0")).join("");
    const key = `pi-reader-owner:${url}`;
    let channel = null, source = null, timer = null, claimTimer = null, reconnectTimer = null, watchdogTimer = null, stopped = false;
    function clearWatchdog() { if (watchdogTimer !== null) env.clearTimeout(watchdogTimer); watchdogTimer = null; }
    function watch(candidate, connect, requiresOwnership) {
      clearWatchdog();
      watchdogTimer = env.setTimeout(() => {
        watchdogTimer = null;
        if (source !== candidate || stopped) return;
        candidate.close(); source = null; deliver({ kind: "error" });
        if (requiresOwnership) channel?.postMessage({ kind: "packet", sender: id, packet: { kind: "error" } });
        scheduleReconnect(connect, requiresOwnership);
      }, 75000);
    }
    const ttl = 12000, reconnectDelay = 1000;
    try { channel = new env.BroadcastChannel(key); } catch { /* capability reported below */ }
    function readOwner() {
      try {
        const owner = JSON.parse(env.localStorage.getItem(key) || "null");
        return owner && typeof owner.id === "string" && Number.isFinite(owner.expires) ? owner : null;
      } catch { return null; }
    }
    function own() { return readOwner()?.id === id; }
    function isClosed(candidate) { return candidate.readyState === (env.EventSource.CLOSED ?? 2); }
    function cancelReconnect() {
      if (reconnectTimer !== null) { env.clearTimeout(reconnectTimer); reconnectTimer = null; }
    }
    function closeSource() {
      clearWatchdog();
      source?.close();
      source = null;
      cancelReconnect();
    }
    function scheduleReconnect(connect, requiresOwnership) {
      if (stopped || reconnectTimer !== null) return;
      reconnectTimer = env.setTimeout(() => {
        reconnectTimer = null;
        if (stopped || source || (requiresOwnership && !own())) return;
        connect();
      }, reconnectDelay);
    }
    function recover(candidate, connect, requiresOwnership) {
      if (source !== candidate || !isClosed(candidate)) return;
      clearWatchdog();
      candidate.close();
      source = null;
      scheduleReconnect(connect, requiresOwnership);
    }
    function release() {
      closeSource();
      if (own()) { try { env.localStorage.removeItem(key); } catch { /* storage unavailable */ } }
      channel?.postMessage({ kind: "vacant", sender: id });
    }
    function forward(packet) {
      if (!own()) { closeSource(); return; }
      deliver(packet);
      channel?.postMessage({ kind: "packet", sender: id, packet });
    }
    function connect() {
      if (stopped || source || !own()) return;
      const candidate = new env.EventSource(resumeUrl());
      source = candidate;
      watch(candidate, connect, true);
      candidate.addEventListener?.("ping", () => { if (source === candidate) watch(candidate, connect, true); });
      candidate.onopen = () => { if (source === candidate) forward({ kind: "open", sharing: "broadcast" }); };
      candidate.onerror = () => {
        if (source !== candidate) return;
        forward({ kind: "error" });
        recover(candidate, connect, true);
      };
      candidate.onmessage = (message) => {
        if (source !== candidate) return;
        try { watch(candidate, connect, true); forward({ kind: "event", data: JSON.parse(message.data) }); } catch { /* malformed frame */ }
      };
    }
    function connectPage() {
      if (stopped || source) return;
      const candidate = new env.EventSource(resumeUrl());
      source = candidate;
      watch(candidate, connectPage, false);
      candidate.addEventListener?.("ping", () => { if (source === candidate) watch(candidate, connectPage, false); });
      candidate.onopen = () => { if (source === candidate) deliver({ kind: "open", sharing: "page" }); };
      candidate.onerror = () => {
        if (source !== candidate) return;
        deliver({ kind: "error", sharing: "page" });
        recover(candidate, connectPage, false);
      };
      candidate.onmessage = (message) => {
        if (source !== candidate) return;
        try { watch(candidate, connectPage, false); deliver({ kind: "event", data: JSON.parse(message.data) }); } catch { /* malformed frame */ }
      };
    }
    function tick() {
      if (stopped) return;
      const now = env.Date.now(), owner = readOwner();
      if (owner?.id === id || !owner || owner.expires <= now || owner.expires > now + ttl * 2) {
        try { env.localStorage.setItem(key, JSON.stringify({ id, expires: now + ttl })); }
        catch {
          // ponytail: storage/BC-disabled containers share only within a page;
          // HTTP/2 is the supported multi-page transport for that capability ceiling.
          if (!source && reconnectTimer === null) connectPage();
          return;
        }
        if (!source && !claimTimer && reconnectTimer === null) claimTimer = env.setTimeout(() => { claimTimer = null; connect(); }, 100);
      } else closeSource();
    }
    if (!channel) {
      // No cross-page IPC: keep notification ability, expose the capability limit.
      connectPage();
    } else {
      channel.onmessage = ({ data }) => {
        if (!data || data.sender === id || (data.to && data.to !== id)) return;
        if (data.kind === "vacant") tick();
        if (data.kind === "packet" && readOwner()?.id === data.sender) deliver(data.packet);
        if (data.kind === "hello" && source && own()) {
          channel.postMessage({ kind: "packet", sender: id, to: data.sender, packet: { kind: connected ? "open" : "error", sharing: "broadcast" } });
          for (const event of snapshots.values()) channel.postMessage({ kind: "packet", sender: id, to: data.sender, packet: { kind: "event", data: { ...event, snapshot: true } } });
        }
      };
      tick();
      channel.postMessage({ kind: "hello", sender: id });
      timer = env.setInterval(tick, 2000);
    }
    return () => {
      stopped = true;
      if (timer) env.clearInterval(timer);
      if (claimTimer) env.clearTimeout(claimTimer);
      release(); channel?.close();
    };
  }
  function start() {
    started = true;
    let worker = null, ready = false, disposed = false, timeout = null, fallbackStop = null;
    function downgrade() {
      if (disposed || fallbackStop) return;
      if (timeout) env.clearTimeout(timeout);
      try { worker?.port.postMessage({ kind: "unsubscribe" }); worker?.port.close(); } catch { /* unavailable worker */ }
      fallbackStop = fallback();
    }
    try {
      worker = new env.SharedWorker("/reader-events-worker.js", { name: "pi-reader-events-v1" });
      worker.port.onmessage = ({ data }) => {
        if (disposed || fallbackStop) return;
        if (data?.kind === "ready") { ready = true; env.clearTimeout(timeout); }
        else deliver(data);
      };
      worker.onerror = () => downgrade();
      worker.port.start();
      worker.port.postMessage({ kind: "subscribe" });
      timeout = env.setTimeout(() => { if (!ready) downgrade(); }, 3000);
    } catch { downgrade(); }
    stopTransport = () => {
      disposed = true;
      if (timeout) env.clearTimeout(timeout);
      fallbackStop?.();
      try { worker?.port.postMessage({ kind: "unsubscribe" }); worker?.port.close(); } catch { /* worker already gone */ }
    };
  }
  function suspend() { stopTransport?.(); stopTransport = null; started = false; connected = false; }
  const pageHide = () => suspend();
  const pageShow = () => { if (listeners.size && !started) start(); };
  env.addEventListener?.("pagehide", pageHide);
  env.addEventListener?.("pageshow", pageShow);
  return {
    subscribe(listener) {
      listeners.add(listener);
      env.queueMicrotask(() => replay(listener));
      if (!started) start();
      return () => { listeners.delete(listener); if (!listeners.size) suspend(); };
    },
    dispose() {
      listeners.clear(); suspend(); snapshots.clear(); activity.length = 0;
      env.removeEventListener?.("pagehide", pageHide);
      env.removeEventListener?.("pageshow", pageShow);
    },
  };
}
