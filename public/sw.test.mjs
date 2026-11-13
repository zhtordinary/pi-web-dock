import assert from "node:assert/strict";
import test, { mock } from "node:test";

const listeners = new Map();
globalThis.self = {
  location: {
    href: "https://pi.test/sw.js?v=test",
    origin: "https://pi.test",
  },
  addEventListener: (type, listener) => listeners.set(type, listener),
  clients: null,
};

await import("./sw.js");

function dispatchNotificationClick(data) {
  let pending;
  let closed = false;
  listeners.get("notificationclick")({
    notification: {
      data,
      close: () => { closed = true; },
    },
    waitUntil: (promise) => { pending = promise; },
  });
  return { pending, wasClosed: () => closed };
}

function dispatchPush(payload, clients, getNotifications = async () => []) {
  let pending;
  const shown = [];
  self.clients = {
    matchAll: async () => clients,
    openWindow: async () => assert.fail("push must not open windows"),
  };
  self.registration = {
    showNotification: async (title, options) => { shown.push({ title, options }); },
    getNotifications,
  };
  listeners.get("push")({
    data: { json: () => payload },
    waitUntil: (promise) => { pending = promise; },
  });
  return { pending, shown };
}

test("push always shows a notification, even when a window is visible", async () => {
  const event = dispatchPush(
    {
      title: "Session complete",
      body: "Task finished.",
      url: "/?session=session-1&device=device-1",
      tag: "pi-session-complete:device-1:session-1:run-1",
      deviceId: "device-1",
      sessionId: "session-1",
      runId: "run-1",
    },
    [
      { url: "https://pi.test/?session=other", visibilityState: "hidden" },
      { url: "https://pi.test/?session=session-1", visibilityState: "visible" },
    ],
  );
  await event.pending;

  // iOS revokes the push subscription when a push is handled without a
  // notification, so the notification must never be suppressed.
  const shownAt = event.shown[0].options.data.shownAt;
  assert.equal(typeof shownAt, "number");
  assert.deepEqual(event.shown, [{
    title: "Session complete",
    options: {
      body: "Task finished.",
      data: { url: "/?session=session-1&device=device-1", shownAt, deviceId: "device-1", sessionId: "session-1", runId: "run-1" },
      tag: "pi-session-complete:device-1:session-1:run-1",
      renotify: true,
    },
  }]);
});

const completionPush = {
  title: "Session complete",
  body: "Task finished.",
  url: "/?session=session-1&device=device-1",
  tag: "pi-session-complete:device-1:session-1:run-1",
  deviceId: "device-1",
  sessionId: "session-1",
  runId: "run-1",
};

function existingNotifications(list) {
  return async ({ tag }) => list.filter((notification) => notification.tag === tag);
}

test("push quietly replaces the page notification for the same device/session/run", async () => {
  const event = dispatchPush(completionPush, [], existingNotifications([
    {
      tag: completionPush.tag,
      data: { url: completionPush.url, shownAt: Date.now() - 600, deviceId: "device-1", sessionId: "session-1", runId: "run-1" },
    },
  ]));
  await event.pending;

  assert.equal(event.shown.length, 1);
  assert.equal(event.shown[0].options.tag, completionPush.tag);
  assert.equal(event.shown[0].options.renotify, false);
});

test("different runs and devices are never deduplicated", async () => {
  const run = dispatchPush({ ...completionPush, runId: "run-2", tag: "pi-session-complete:device-1:session-1:run-2" }, [], existingNotifications([
    { tag: completionPush.tag, data: { shownAt: Date.now() - 100, deviceId: "device-1", sessionId: "session-1", runId: "run-1" } },
  ]));
  await run.pending;
  assert.equal(run.shown[0].options.renotify, true);

  const device = dispatchPush({ ...completionPush, deviceId: "device-2", tag: "pi-session-complete:device-2:session-1:run-1" }, [], existingNotifications([
    { tag: completionPush.tag, data: { shownAt: Date.now() - 100, deviceId: "device-1", sessionId: "session-1", runId: "run-1" } },
  ]));
  await device.pending;
  assert.equal(device.shown[0].options.renotify, true);
});

test("missing completion identity keeps every push visible instead of swallowing it", async () => {
  const event = dispatchPush({ ...completionPush, tag: "pi-session-complete:session-1", deviceId: undefined, sessionId: undefined, runId: undefined }, [], existingNotifications([
    { tag: "pi-session-complete:session-1", data: { shownAt: Date.now() - 100 } },
  ]));
  await event.pending;

  assert.equal(event.shown.length, 1);
  assert.equal(event.shown[0].options.tag, undefined);
  assert.equal(typeof event.shown[0].options.data.shownAt, "number");
});

test("push ignores malformed payloads", async () => {
  const event = dispatchPush(
    { title: "", body: 42 },
    [],
  );
  await event.pending;

  assert.deepEqual(event.shown, []);
});

test("notification click focuses an existing client at the session URL", async () => {
  const calls = [];
  const focusedClient = {
    url: "https://pi.test/?session=session-1",
    focus: async () => { calls.push("focus"); },
    navigate: async () => assert.fail("exact client should not navigate"),
  };
  self.clients = {
    matchAll: async () => [focusedClient],
    openWindow: async () => assert.fail("existing client should be reused"),
  };

  const event = dispatchNotificationClick({ url: "/?session=session-1" });
  await event.pending;

  assert.equal(event.wasClosed(), true);
  assert.deepEqual(calls, ["focus"]);
});

test("notification click navigates an existing client to the session", async () => {
  const calls = [];
  const navigatedClient = {
    focus: async () => { calls.push("focus"); },
  };
  const existingClient = {
    url: "https://pi.test/?session=other-session",
    navigate: async (url) => {
      calls.push(["navigate", url]);
      return navigatedClient;
    },
    focus: async () => assert.fail("the navigated client should be focused"),
  };
  self.clients = {
    matchAll: async () => [existingClient],
    openWindow: async () => assert.fail("existing client should be reused"),
  };

  const event = dispatchNotificationClick({ url: "/?session=session-1" });
  await event.pending;

  assert.deepEqual(calls, [
    ["navigate", "https://pi.test/?session=session-1"],
    "focus",
  ]);
});

test("notification click opens a window and rejects cross-origin targets", async () => {
  const opened = [];
  self.clients = {
    matchAll: async () => [],
    openWindow: async (url) => { opened.push(url); },
  };

  const event = dispatchNotificationClick({ url: "https://example.com/redirect" });
  await event.pending;

  assert.deepEqual(opened, ["https://pi.test/"]);
});

test("activation keeps prior static caches for documents from older builds", async () => {
  const deleted = [];
  self.clients = { claim: async () => {} };
  globalThis.caches = {
    keys: async () => ["pi-web-static-test", "pi-web-static-older", "unrelated-cache"],
    delete: async (key) => { deleted.push(key); },
  };

  let pending;
  listeners.get("activate")({ waitUntil: (promise) => { pending = promise; } });
  await pending;

  assert.deepEqual(deleted, [], "an older document may still request chunks from its cache");
});

test("static requests prefer the current cache and retain old Next chunks as a fallback", async () => {
  const current = new Response("current");
  const legacy = new Response("legacy");
  const lookups = [];
  globalThis.caches = {
    match: async (request, options) => {
      lookups.push({ url: request.url, cacheName: options?.cacheName });
      if (options?.cacheName === "pi-web-static-test" && request.url.endsWith("current.js")) return current;
      if (!options?.cacheName && request.url.endsWith("older.js")) return legacy;
      return undefined;
    },
    open: async () => ({ put: async () => {} }),
  };
  globalThis.fetch = async () => assert.fail("cached chunks must not hit the current server");

  const currentEvent = dispatchFetch("https://pi.test/_next/static/chunks/current.js");
  assert.equal(await (await currentEvent.pending).text(), "current");
  const olderEvent = dispatchFetch("https://pi.test/_next/static/chunks/older.js");
  assert.equal(await (await olderEvent.pending).text(), "legacy");
  assert.deepEqual(lookups, [
    { url: "https://pi.test/_next/static/chunks/current.js", cacheName: "pi-web-static-test" },
    { url: "https://pi.test/_next/static/chunks/older.js", cacheName: "pi-web-static-test" },
    { url: "https://pi.test/_next/static/chunks/older.js", cacheName: undefined },
  ]);
});

// A reachable port backed by a dead upstream answers nothing at all, so these
// tests drive fetch() with a stub that only settles once the worker aborts it.
function installOfflineStub() {
  const offline = new Response("<!doctype html><title>Pi Web is offline</title>", {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
  globalThis.caches = {
    match: async (request) => ((typeof request === "string" ? request : request.url).endsWith("/offline.html")
      ? offline
      : undefined),
    open: async () => ({ put: async () => {} }),
  };
}

function dispatchFetch(url, { mode = "cors", method = "GET" } = {}) {
  let pending;
  const waitUntilPromises = [];
  const request = new Request(url, { method });
  Object.defineProperty(request, "mode", { value: mode });
  listeners.get("fetch")({
    request,
    respondWith: (promise) => { pending = promise; },
    waitUntil: (promise) => { waitUntilPromises.push(promise); },
  });
  return { pending, waitUntilPromises };
}

/** fetch() that never settles until the signal it was handed is aborted. */
function installHungNetwork() {
  let aborted = false;
  globalThis.fetch = (_request, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  return () => aborted;
}

/**
 * Let a handler's await chain reach its fetch (and schedule its timer) before
 * the fake clock is ticked. setImmediate is not faked, unlike setTimeout.
 */
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

test("a stalled navigation falls back to offline.html", async () => {
  installOfflineStub();
  const wasAborted = installHungNetwork();

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const event = dispatchFetch("https://pi.test/", { mode: "navigate" });
    await flushMicrotasks();
    mock.timers.tick(8000);
    const response = await event.pending;

    assert.equal(wasAborted(), true, "a hung upstream must be aborted, not awaited forever");
    assert.match(await response.text(), /Pi Web is offline/);
  } finally {
    mock.timers.reset();
  }
});

test("a stalled static asset request is bounded as well", async () => {
  installOfflineStub();
  const wasAborted = installHungNetwork();

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const event = dispatchFetch("https://pi.test/_next/static/chunks/app.js");
    // cacheFirst awaits the cache lookup before it reaches the network.
    await flushMicrotasks();
    mock.timers.tick(8000);

    assert.equal(wasAborted(), true);
    await assert.rejects(event.pending, /abort/i);
  } finally {
    mock.timers.reset();
  }
});

test("a response that arrives in time is not cut off mid-stream", async () => {
  installOfflineStub();
  let signal;
  globalThis.fetch = async (_request, init) => {
    signal = init.signal;
    return new Response("<!doctype html><title>Pi Web</title>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  };

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const event = dispatchFetch("https://pi.test/", { mode: "navigate" });
    const response = await event.pending;
    // The budget only covers time to first byte: a long-lived body keeps
    // streaming past it (Next.js streams its SSR payload).
    mock.timers.tick(60000);

    assert.equal(signal.aborted, false);
    assert.match(await response.text(), /<title>Pi Web<\/title>/);
  } finally {
    mock.timers.reset();
  }
});

test("static network responses do not wait for a hanging cache write", async () => {
  let releaseOpen;
  let cachedBody;
  const cacheOpen = new Promise((resolve) => { releaseOpen = resolve; });
  globalThis.caches = {
    match: async () => undefined,
    open: async () => cacheOpen,
  };
  const responseBody = new Response("asset");
  Object.defineProperty(responseBody, "type", { value: "basic" });
  globalThis.fetch = async () => responseBody;

  const event = dispatchFetch("https://pi.test/_next/static/chunks/app.js");
  const response = await event.pending;
  assert.equal(await response.text(), "asset");
  assert.equal(event.waitUntilPromises.length, 1);

  let settled = false;
  event.waitUntilPromises[0].then(() => { settled = true; });
  await flushMicrotasks();
  assert.equal(settled, false, "respondWith must finish before the cache promise");
  releaseOpen({ put: async (_request, cachedResponse) => { cachedBody = await cachedResponse.text(); } });
  await event.waitUntilPromises[0];
  assert.equal(cachedBody, "asset");
});

test("cache write rejection is contained by waitUntil", async () => {
  globalThis.caches = {
    match: async () => undefined,
    open: async () => ({
      put: async () => { throw new Error("synthetic cache failure"); },
    }),
  };
  const responseBody = new Response("asset");
  Object.defineProperty(responseBody, "type", { value: "basic" });
  globalThis.fetch = async () => responseBody;

  const event = dispatchFetch("https://pi.test/_next/static/chunks/app.js");
  const response = await event.pending;
  assert.equal(await response.text(), "asset");
  assert.equal(event.waitUntilPromises.length, 1);
  await event.waitUntilPromises[0];
});

test("local versioned font files use the static-asset cache", async () => {
  const cached = [];
  globalThis.caches = {
    match: async () => undefined,
    open: async () => ({ put: async (request) => { cached.push(request.url); } }),
  };
  globalThis.fetch = async () => {
    const response = new Response("synthetic font");
    Object.defineProperty(response, "type", { value: "basic" });
    return response;
  };

  const urls = [
    "https://pi.test/fonts/noto-sans-mono-v37-latin.woff2",
    "https://pi.test/fonts/symbols-nerd-font-mono-v3.5.1.ttf",
  ];
  for (const url of urls) {
    const event = dispatchFetch(url);
    assert.ok(event.pending, "font request must use the static-asset handler");
    assert.equal(await (await event.pending).text(), "synthetic font");
    await Promise.all(event.waitUntilPromises);
  }
  assert.deepEqual(cached, urls);
  const nonFont = dispatchFetch("https://pi.test/fonts/example.txt");
  assert.equal(nonFont.pending, undefined, "unrelated public files must not enter the font cache");
});
