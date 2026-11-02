const CACHE_PREFIX = "pi-web";
const CACHE_VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const STATIC_CACHE = `${CACHE_PREFIX}-static-${CACHE_VERSION}`;
const OFFLINE_URL = "/offline.html";
const PRECACHE_URLS = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];
// A reachable port backed by a dead upstream accepts the connection and then
// never answers: fetch() neither resolves nor rejects, so the navigation hangs
// forever instead of falling back to offline.html. Bound every network wait.
const NAVIGATION_TIMEOUT_MS = 8000;
const ASSET_TIMEOUT_MS = 8000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  // AppShell can keep an older document alive while a session, iframe, or
  // draft is active. Deleting its cache here turns that document's hashed
  // chunk request into a network 404 against the new build.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Session data and live agent traffic must always come from the local server.
  if (url.pathname.startsWith("/api/") || url.pathname === "/sw.js") return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetchWithTimeout(request, NAVIGATION_TIMEOUT_MS).catch(async () => {
        const fallback = await caches.match(OFFLINE_URL);
        return fallback ?? Response.error();
      }),
    );
    return;
  }

  const isStaticAsset =
    url.pathname.startsWith("/_next/static/") ||
    (url.pathname.startsWith("/fonts/") && (url.pathname.endsWith(".woff2") || url.pathname.endsWith(".ttf"))) ||
    PRECACHE_URLS.includes(url.pathname);

  if (isStaticAsset) {
    event.respondWith(cacheFirst(request, event));
  }
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // Ignore malformed or missing push payloads.
  }
  const { title, body, url, tag } = payload;
  if (typeof title !== "string" || !title || typeof body !== "string" || !body) return;

  // Always surface a system notification. iOS revokes the push subscription
  // when a service worker handles a push without showing a notification, so
  // suppressing the notification while a window is visible poisons the
  // subscription in the background-delivery case. Notifications sharing a tag
  // replace each other instead of stacking, so a visible window merely sees
  // the completion notification re-appear.
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      data: { url: typeof url === "string" && url ? url : "/" },
      ...(typeof tag === "string" && tag ? { tag, renotify: true } : {}),
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const requestedUrl = typeof event.notification.data?.url === "string"
    ? event.notification.data.url
    : "/";
  let targetUrl = new URL("/", self.location.origin);
  try {
    const candidate = new URL(requestedUrl, self.location.origin);
    if (candidate.origin === self.location.origin) targetUrl = candidate;
  } catch {
    // Keep the root URL when notification data is malformed.
  }

  event.waitUntil(focusOrOpenWindow(targetUrl.href));
});

async function focusOrOpenWindow(targetUrl) {
  const windowClients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const exactClient = windowClients.find((client) => client.url === targetUrl);
  const candidates = exactClient
    ? [exactClient, ...windowClients.filter((client) => client !== exactClient)]
    : windowClients;

  for (const client of candidates) {
    try {
      const targetClient = client.url === targetUrl
        ? client
        : (await client.navigate(targetUrl)) ?? client;
      await targetClient.focus();
      return;
    } catch {
      // The window may have closed between matchAll and focus; try the next one.
    }
  }

  await self.clients.openWindow(targetUrl);
}

/**
 * Fetch with a ceiling on the wait for the response headers (time to first
 * byte). The timer is cleared as soon as they arrive, so a response that
 * streams a long body — Next.js streams SSR output — is never cut off
 * mid-stream.
 */
async function fetchWithTimeout(request, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function queueCacheWrite(request, response, event) {
  let cacheTask;
  try {
    cacheTask = Promise.resolve()
      .then(() => caches.open(STATIC_CACHE))
      .then((cache) => cache.put(request, response));
  } catch (error) {
    cacheTask = Promise.reject(error);
  }
  // Cache failures are deliberately contained: the network response must not
  // be delayed or rejected, while the service-worker lifecycle still tracks
  // the best-effort write.
  try {
    event.waitUntil(cacheTask.catch(() => undefined));
  } catch {
    // A late lifecycle event cannot extend itself; the network response still
    // remains valid and must not be converted into a cache failure.
  }
}

async function cacheFirst(request, event) {
  // Prefer this build for shared, un-hashed assets. Older Next chunks may
  // still be needed by a document that has not crossed the refresh guard.
  const cached = await caches.match(request, { cacheName: STATIC_CACHE });
  if (cached) return cached;
  if (request.url.includes("/_next/static/")) {
    const legacy = await caches.match(request);
    if (legacy) return legacy;
  }

  const response = await fetchWithTimeout(request, ASSET_TIMEOUT_MS);
  if (response.ok && response.type === "basic") {
    let cacheResponse;
    try {
      // Clone before returning the original body to the page; a later clone can fail once it is consumed.
      cacheResponse = response.clone();
    } catch {
      cacheResponse = undefined;
    }
    if (cacheResponse) queueCacheWrite(request, cacheResponse, event);
  }
  return response;
}
