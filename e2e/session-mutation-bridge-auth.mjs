import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";
import { chromium } from "playwright";
import ts from "typescript";

const executablePath = [process.env.PI_WEB_TEST_CHROMIUM, "/usr/bin/chromium", chromium.executablePath()].find(value => value && existsSync(value));
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { proxy } = await jiti.import("../proxy.ts");
const authentication = await jiti.import("../app/api/web-auth/route.ts");
const bridgeRoute = await jiti.import("../app/api/session-mutations/bridge/route.ts");
const mutations = await jiti.import("../app/api/session-mutations/route.ts");
const modules = ["session-mutation-command", "session-mutation-recovery", "session-mutation-bridge", "remote-session-mutation"];
const bundle = `const modules = {}, cache = {}; function require(name) { if (cache[name]) return cache[name]; const exports = {}; cache[name] = exports; modules[name](exports, require); return exports; }\n`
  + modules.map(name => `modules[${JSON.stringify(`./${name}`)}] = (exports, require) => {\n${ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText}\n};`).join("\n")
  + `\nwindow.bridges = require("./session-mutation-bridge"); window.mutations = require("./remote-session-mutation");`;

test("real cross-site browser keeps Lax authentication and receives immediate safe target-page guidance", { skip: !executablePath && "No Chromium executable is available", timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "reader-bridge-browser-"));
  const keys = ["HOME", "PI_CODING_AGENT_DIR", "PI_WEB_PASSWORD", "PI_WEB_SESSION_ACTIVITY_CONFIG", "PI_WEB_CONTROL_RECEIPT_ROOT"];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_WEB_PASSWORD: "synthetic-browser-password", PI_WEB_CONTROL_RECEIPT_ROOT: join(root, "receipts") });
  const requests = [];
  let sourceOrigin, targetOrigin, browser;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const origin = `http://${incoming.headers.host}`;
      const url = new URL(incoming.url, origin);
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      requests.push({ origin, pathname: url.pathname, method: incoming.method, cookie: incoming.headers.cookie ?? "", authorization: incoming.headers.authorization, site: incoming.headers["sec-fetch-site"] });
      let response;
      if (origin === sourceOrigin) {
        if (url.pathname === "/bundle.js") response = new Response(bundle, { headers: { "content-type": "text/javascript" } });
        else if (url.pathname.startsWith("/api/remote/")) response = Response.json({ error: "synthetic server proxy unavailable" }, { status: 503 });
        else response = new Response(`<!doctype html><textarea id="draft">unsent workspace draft</textarea><iframe id="workspace" src="about:blank"></iframe><a id="target" target="_blank" rel="noopener noreferrer" href="${targetOrigin}">Open target Reader</a><script src="/bundle.js"></script>`, { headers: { "content-type": "text/html" } });
      } else {
        const request = new NextRequest(url, { method: incoming.method, headers: incoming.headers, ...(body ? { body } : {}) });
        response = await proxy(request);
        if (response.headers.get("x-middleware-next") === "1") {
          if (url.pathname === "/api/web-auth") response = await authentication[incoming.method](request);
          else if (url.pathname === "/api/session-mutations/bridge") response = await bridgeRoute.GET(request);
          else if (url.pathname === "/api/session-mutations") response = await mutations[incoming.method](request);
          else if (url.pathname === "/bundle.js") response = new Response(bundle, { headers: { "content-type": "text/javascript" } });
          else if (url.pathname === "/login") response = new Response(`<!doctype html><form><input id="password" type="password"><button>Log in</button></form><script>document.querySelector("form").onsubmit = async event => { event.preventDefault(); const response = await fetch("/api/web-auth", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:document.querySelector("input").value})}); if(response.ok) location.replace("/"); };</script>`, { headers: { "content-type": "text/html" } });
          else response = new Response('<!doctype html><h1>Target workspace</h1><script src="/bundle.js"></script>', { headers: { "content-type": "text/html" } });
        }
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { outgoing.writeHead(500); outgoing.end(String(error)); }
  });
  try {
    server.listen(0, "0.0.0.0"); await once(server, "listening");
    const port = server.address().port;
    sourceOrigin = `http://127.0.0.1:${port}`; targetOrigin = `http://127.0.0.2:${port}`;
    process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "target" }, peers: [{ id: "source", name: "Source", url: sourceOrigin }] });
    browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
    const context = await browser.newContext();
    // Normal form login uses the production auth route. No Basic credentials,
    // cookies, headers or storage-access grants are injected by the test.
    const login = await context.newPage();
    await login.goto(`${targetOrigin}/login`);
    await login.locator("#password").fill("synthetic-browser-password");
    await Promise.all([login.waitForURL(`${targetOrigin}/`), login.locator("button").click()]);
    const cookie = (await context.cookies(targetOrigin)).find(item => item.name === "pi_web_session");
    assert.ok(cookie); assert.equal(cookie.sameSite, "Lax"); assert.equal(cookie.httpOnly, true); assert.equal(cookie.secure, false);
    await login.close();
    const page = await context.newPage();
    await page.goto(`${sourceOrigin}/?session=keep-current`);
    const responsePromise = page.waitForResponse(response => response.url().startsWith(`${targetOrigin}/api/session-mutations/bridge`));
    const observed = await page.evaluate(async targetOrigin => {
      const client = window.mutations.createRemoteSessionMutationClient({ storage: localStorage });
      const started = Date.now();
      const result = await client({ id: "target", url: targetOrigin }, "delete", "not-sent-session", undefined, true);
      return { result, elapsed: Date.now() - started, pending: client.snapshot(), url: location.href, frame: document.querySelector("#workspace").src };
    }, targetOrigin);
    const response = await responsePromise;
    assert.equal(response.status(), 401, "diagnostic HTML must not masquerade as authenticated transport");
    assert.equal(response.headers()["www-authenticate"], undefined, "do not trigger browser Basic credential prompts");
    assert.match(response.headers()["content-security-policy"], /default-src 'none'/);
    assert.equal(observed.result.notSent, true); assert.equal(observed.result.authenticationRequired, true);
    assert.equal(observed.result.notSentReason, "authenticationRequired");
    assert.ok(observed.elapsed < 3000, `must not wait for the 10s readiness timeout: ${observed.elapsed}ms`);
    assert.deepEqual(observed.pending, []);
    assert.equal(observed.url, `${sourceOrigin}/?session=keep-current`); assert.equal(observed.frame, "about:blank");
    assert.equal(await page.locator("#draft").inputValue(), "unsent workspace draft");
    assert.equal(context.pages().length, 1, "authentication errors must never open an automatic popup");
    const frameRequest = requests.find(item => item.pathname === "/api/session-mutations/bridge");
    assert.equal(frameRequest.site, "cross-site"); assert.equal(frameRequest.cookie, ""); assert.equal(frameRequest.authorization, undefined);
    assert.equal(requests.some(item => item.method === "POST" && item.pathname.includes("session-mutations")), false);
    // Only an explicit link click opens the target. Lax login still works there,
    // and the current workspace/draft remains untouched.
    const [target] = await Promise.all([page.waitForEvent("popup"), page.locator("#target").click()]);
    await target.waitForLoadState();
    assert.equal(target.url(), `${targetOrigin}/`);
    assert.equal(await target.evaluate(() => window.opener), null);
    const sameOrigin = await target.evaluate(async targetOrigin => {
      const channel = await window.bridges.openSessionMutationBridge("target", targetOrigin);
      try { return { page: await channel.recovery(), receipt: await channel.request("query", { operationId: "original-operation-id", deviceId: "target", sessionId: "session", op: "delete", force: true }) }; }
      finally { channel.close(); }
    }, targetOrigin);
    assert.deepEqual(sameOrigin.page.operations, []); assert.equal(sameOrigin.receipt.status, "not_found");
    assert.equal(page.url(), `${sourceOrigin}/?session=keep-current`);
    assert.equal(await page.locator("#draft").inputValue(), "unsent workspace draft");
    // No-password cross-site peers retain the supported bridge path.
    delete process.env.PI_WEB_PASSWORD;
    const direct = await page.evaluate(async targetOrigin => {
      const channel = await window.bridges.openSessionMutationBridge("target", targetOrigin);
      try { return await channel.recovery(); } finally { channel.close(); }
    }, targetOrigin);
    assert.deepEqual(direct.operations, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
    rmSync(root, { recursive: true, force: true });
  }
});
