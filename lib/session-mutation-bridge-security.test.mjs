import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { proxy } = await jiti.import("../proxy.ts");
const { GET } = await jiti.import("../app/api/session-mutations/bridge/route.ts");
const { createWebSessionToken, PI_WEB_SESSION_COOKIE } = await jiti.import("./web-auth.ts");
const parentOrigin = "https://192.0.2.10:30144";
const targetOrigin = "https://192.0.2.20:30144";
const path = "/api/session-mutations/bridge";
function request({ parent = parentOrigin, method = "GET", pathname = path, headers = {}, channel = "bridge-channel-123" } = {}) {
  const url = new URL(pathname, targetOrigin);
  url.searchParams.set("parentOrigin", parent);
  url.searchParams.set("channel", channel);
  return new NextRequest(url, { method, headers: { host: "192.0.2.20:30144", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe", ...headers } });
}
function setup(t, password) {
  const keys = ["PI_WEB_PASSWORD", "PI_WEB_SESSION_ACTIVITY_CONFIG"];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  if (password) process.env.PI_WEB_PASSWORD = password; else delete process.env.PI_WEB_PASSWORD;
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "target" }, peers: [{ id: "source", name: "Source", url: parentOrigin }] });
  t.after(() => { for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } });
}
test("cross-site configured IP iframe passes proxy and actual bridge route", async t => {
  setup(t);
  const req = request();
  const admitted = await proxy(req);
  assert.equal(admitted.headers.get("x-middleware-next"), "1");
  const response = await GET(req);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors https:\/\/192\.0\.2\.10:30144;/);
  assert.match(await response.text(), /event.source !== window.parent/);
});
test("bridge exception preserves authentication before serving transport HTML", async t => {
  setup(t, "synthetic-bridge-password");
  assert.equal((await proxy(request())).status, 401);
  const token = createWebSessionToken("synthetic-bridge-password");
  assert.equal((await proxy(request({ headers: { cookie: `${PI_WEB_SESSION_COOKIE}=${token}` } }))).headers.get("x-middleware-next"), "1");
});
test("untrusted bridge and ordinary cross-site API requests remain denied", async t => {
  setup(t);
  for (const options of [
    { parent: "https://attacker.invalid" }, { parent: `${parentOrigin}/` }, { channel: "bad" },
    { method: "POST" }, { pathname: `${path}/extra` }, { pathname: "/api/session-mutations" },
    { headers: { host: "attacker.invalid" } }, { headers: { origin: "https://attacker.invalid" } },
    { headers: { origin: "null" } }, { headers: { "sec-fetch-mode": "cors" } },
    { headers: { "sec-fetch-dest": "document" } },
  ]) {
    const req = request(options);
    assert.equal((await proxy(req)).status, 403, JSON.stringify(options));
    assert.equal((await GET(req)).status, 403, JSON.stringify(options));
  }
});

test("unauthenticated trusted bridge returns only a constrained 401 diagnostic, not transport authority", async t => {
  setup(t, "synthetic-bridge-password");
  const response = await proxy(request());
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("www-authenticate"), null);
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'; script-src 'nonce-[^']+'; frame-ancestors https:\/\/192\.0\.2\.10:30144;/);
  const html = await response.text();
  assert.match(html, /session-mutation-auth-required/);
  assert.doesNotMatch(html, /session-mutation-ready|fetch\(|addEventListener|synthetic-bridge-password|pi_web_session/);
  const messages = [];
  const { runInNewContext } = await import("node:vm");
  runInNewContext(html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1], {
    window: { parent: { postMessage: (data, origin) => messages.push({ data, origin }) } },
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].origin, parentOrigin);
  assert.deepEqual(structuredClone(messages[0].data), { type: "session-mutation-auth-required", channel: "bridge-channel-123" });
  for (const options of [{ parent: "https://attacker.invalid" }, { channel: "bridge-channel-</script>" }, { method: "POST" }]) {
    const denied = await proxy(request(options));
    assert.equal(denied.status, 403);
    assert.doesNotMatch(await denied.text(), /postMessage|session-mutation-auth-required/);
  }
  assert.equal((await proxy(request({ pathname: "/api/session-mutations", headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } }))).status, 401);
});

test("real HTTP 401 body reaches the production bridge and mutation client without a POST", async t => {
  setup(t, "synthetic-bridge-password");
  const { createServer, request: httpRequest } = await import("node:http");
  const { once } = await import("node:events");
  const { webcrypto } = await import("node:crypto");
  const { runInNewContext } = await import("node:vm");
  const { openSessionMutationBridge } = await jiti.import("./session-mutation-bridge.ts");
  const { createRemoteSessionMutationClient } = await jiti.import("./remote-session-mutation.ts");
  const requests = [], responses = [];
  const server = createServer(async (incoming, outgoing) => {
    const url = new URL(incoming.url, `http://${incoming.headers.host}`);
    requests.push({ method: incoming.method, pathname: url.pathname, cookie: incoming.headers.cookie });
    const response = url.pathname.startsWith("/api/remote/") ? Response.json({ error: "proxy unreachable" }, { status: 503 })
      : await proxy(new NextRequest(url, { method: incoming.method, headers: incoming.headers }));
    responses.push(response.status);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(await response.text());
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url, options) => realFetch(new URL(url, origin), options));
  const host = new EventTarget(); host.crypto = webcrypto;
  host.location = { origin: parentOrigin, href: `${parentOrigin}/?session=keep-draft` };
  let frame;
  const doc = { createElement() { return frame = { setAttribute() {}, remove() {}, contentWindow: { postMessage() {} } }; },
    body: { appendChild(value) {
      void new Promise((resolve, reject) => {
        const request = httpRequest(value.src, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" } }, response => {
          const chunks = [];
          response.on("data", chunk => chunks.push(chunk));
          response.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
        });
        request.on("error", reject); request.end();
      })
        .then(async response => {
          const html = await response.text();
          const script = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)?.[1];
          assert.ok(script, `${response.status} ${html}`); assert.equal(response.status, 401);
          // VM dispatch validates the actual response/client wiring, not browser
          // cookie policy or whether a browser executes an HTTP 401 document.
          runInNewContext(script, { window: { parent: { postMessage(data, target) {
            assert.equal(target, parentOrigin);
            const event = new Event("message"); Object.assign(event, { data, origin, source: frame.contentWindow }); host.dispatchEvent(event);
          } } } });
        });
    } } };
  const client = createRemoteSessionMutationClient({ storage: { getItem: () => null, setItem() {} },
    openBridge: (deviceId, targetOrigin) => openSessionMutationBridge(deviceId, targetOrigin, { window: host, document: doc, readyTimeoutMs: 1000 }) });
  const result = await client({ id: "target", url: origin }, "delete", "never-posted", undefined, true);
  assert.equal(result.notSent, true); assert.equal(result.authenticationRequired, true);
  assert.deepEqual(client.snapshot(), []);
  assert.equal(requests.some(item => item.method === "POST"), false);
  assert.equal(requests.find(item => item.pathname === path).cookie, undefined);
  assert.deepEqual(responses, [503, 401]);
  assert.equal(host.location.href, `${parentOrigin}/?session=keep-draft`);
});
