import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(userInfo().homedir,
  process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
const { chromium } = await import("playwright");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = await mkdtemp(join(process.env.HOME || tmpdir(), ".reader-idle-send-"));
const agent = join(home, "agent"), project = join(home, "project"), sessions = join(agent, "sessions", "fixture");
const id = "idle-send-fixture", prompt = "检查冷会话首次发送的持久化。", answer = "冷会话消息已正常受理。";
const timestamp = "2026-10-27T00:00:00.000Z";
const sessionFile = join(sessions, `${timestamp.replaceAll(":", "-")}_${id}.jsonl`);
const requests = [], commands = [];
let browser, page, server, serverExited, provider, serverLog = "", releaseSuggestions, sendRejected = false;
const suggestionGate = new Promise(resolve => { releaseSuggestions = resolve; });
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
const entries = async () => (await readFile(sessionFile, "utf8")).trim().split("\n").map(JSON.parse);
const delivered = async () => (await entries()).filter(entry => entry.type === "message" && entry.message.role === "user"
  && (typeof entry.message.content === "string" ? entry.message.content : entry.message.content.map(block => block.text ?? "").join("")) === prompt);
async function until(check, milliseconds) {
  const deadline = Date.now() + milliseconds;
  do { if (await check()) return true; await tick(100); } while (Date.now() < deadline);
  return false;
}
console.log(JSON.stringify({ fixtureHome: home, purpose: "cold persisted session, real send and reload, stalled auxiliary provider", cleanup: "release provider, close browser, stop owned Reader, remove fixture HOME" }));
try {
  for (const directory of [project, sessions, join(agent, "prompt-suggester")]) await mkdir(directory, { recursive: true });
  const packageSource = process.env.PI_PROMPT_SUGGESTER_PACKAGE ?? join(userInfo().homedir, ".pi/agent/packages/pi-prompt-suggester");
  assert.ok(isAbsolute(packageSource), "the reviewed independent package source must be absolute");
  const packageDir = join(home, "pi-prompt-suggester");
  await cp(packageSource, packageDir, { recursive: true, filter: path => ![".git", "node_modules"].includes(basename(path)) });
  console.log(JSON.stringify({ packageSource, packageVersion: JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")).version }));
  provider = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const isSuggester = JSON.stringify(body.messages ?? []).includes("Write the next message the user would most likely send");
      requests.push({ isSuggester });
      if (isSuggester) await suggestionGate;
      if (res.destroyed) return;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta, finishReason = null, usage) => ({ id: "fixture-response", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) });
      res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: isSuggester ? "继续检查。" : answer }))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk({}, "stop", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }))}\n\n`);
      res.end("data: [DONE]\n\n");
    } catch (error) { res.destroy(error); }
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: "openai-completions", apiKey: "fixture-not-a-credential",
    models: [{ id: "fixture", name: "Offline idle-send fixture", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const startupExtension = join(agent, "startup-confirm.ts");
  await writeFile(startupExtension, `export default function (pi) {
    pi.on("session_start", async (_event, ctx) => {
      await ctx.ui.confirm("发送初始化确认", "确认后才允许初始化完成。");
    });
  }`);
  await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [packageDir], extensions: [startupExtension], defaultProvider: "fixture", defaultModel: "fixture" }));
  await writeFile(join(agent, "prompt-suggester", "config.json"), JSON.stringify({ schemaVersion: 8, reseed: { enabled: false }, suggestion: { displayMode: "ghost", showUsageInPanel: false } }));
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  await writeFile(sessionFile, [
    { type: "session", version: 3, id, timestamp, cwd: project },
    { type: "message", id: "user", parentId: null, timestamp, message: { role: "user", content: "此前的历史提问。", timestamp: Date.now() } },
    { type: "message", id: "answer", parentId: "user", timestamp, message: { role: "assistant", content: [{ type: "text", text: "此前的历史回复。" }], api: "openai-completions", provider: "fixture", model: "fixture", usage, stopReason: "stop", timestamp: Date.now() } },
  ].map(JSON.stringify).join("\n") + "\n");
  const portProbe = createServer(); portProbe.listen(0, "127.0.0.1"); await once(portProbe, "listening");
  const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "--webpack", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root, env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agent, PI_WEB_PASSWORD: "", PI_OFFLINE: "1", NEXT_TELEMETRY_DISABLED: "1", PI_WEB_SESSION_ACTIVITY_CONFIG: JSON.stringify({ device: { id: "idle-send-fixture", name: "Idle send fixture" }, peers: [] }) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverExited = once(server, "exit");
  console.log(JSON.stringify({ ownedReaderPid: server.pid, port, providerPort: provider.address().port }));
  for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { serverLog = (serverLog + chunk).slice(-12000); });
  assert.ok(await until(async () => {
    if (server.exitCode !== null) throw new Error(`Fixture Reader exited: ${serverLog}`);
    return (await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(10000) }).catch(() => null))?.ok;
  }, 120000), `Fixture Reader readiness failed: ${serverLog}`);
  // Compile read-only routes before observing user timing; none may wake the runtime.
  for (const path of [`/?session=${id}`, `/api/sessions/${id}?metadataOnly=1`, `/api/sessions/${id}/state`, `/api/sessions/${id}/history?mode=window`, `/api/sessions/${id}/history?mode=index`]) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(120000) });
    assert.equal(response.status, 200, `read-only fixture preparation: ${path}`);
    await response.arrayBuffer();
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  page = await context.newPage(); page.setDefaultTimeout(60000);
  page.on("console", message => {
    if (message.text().includes("Failed to send message:")) sendRejected = true;
    if (message.type() === "error" && !message.text().includes("hydration")) console.log(JSON.stringify({ browserError: message.text().slice(0, 1600) }));
  });
  page.on("response", response => {
    const request = response.request();
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/agent/${id}`) {
      console.log(JSON.stringify({ commandResponse: request.postDataJSON().type, status: response.status() }));
    }
  });
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/agent/${id}`) commands.push(request.postDataJSON().type);
  });
  const open = async () => {
    await page.goto(`${base}/?session=${id}`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.getByText("此前的历史回复。", { exact: true }).waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const textarea = document.querySelector(".chat-input-textarea");
      return textarea && !textarea.disabled;
    });
  };
  await open();
  const initialState = await (await fetch(`${base}/api/agent/${id}`)).json();
  assert.equal(initialState.running, false, "opening history must leave the runtime cold");
  assert.equal(requests.length, 0, "the browser has not sent any model request before submission");
  const send = async () => {
    const textarea = page.locator(".chat-input-textarea");
    await textarea.fill(prompt); await page.getByRole("button", { name: /^(发送|Send)$/ }).click();
    await page.locator(".chat-transcript [data-chat-message-row]").filter({ hasText: prompt }).waitFor({ state: "visible" });
  };
  await send();
  const confirmation = page.getByRole("dialog").filter({ hasText: "发送初始化确认" });
  await confirmation.waitFor({ state: "visible" });
  assert.equal(commands.filter(type => type === "prompt").length, 0, "readiness remains required while startup UI waits");
  assert.equal((await delivered()).length, 0);
  await page.evaluate(() => { window.dispatchEvent(new Event("online")); document.dispatchEvent(new Event("visibilitychange")); });
  assert.equal(await page.locator(".chat-transcript [data-chat-message-row]").filter({ hasText: prompt }).count(), 1, "idle observations cannot settle the local submission");
  console.log(JSON.stringify({ phase: "startup-ui-before-readiness", promptPosts: 0, persistedUserEntries: 0, pendingInputVisible: true }));
  await confirmation.getByRole("button", { name: "确认", exact: true }).click();
  // Distinguish readiness/first compilation from a provider-blocked startup by its first inference.
  await until(async () => (await delivered()).length === 1
    || sendRejected || (requests.some(item => item.isSuggester) && !requests.some(item => !item.isSuggester)), 120000);
  const firstDelivered = (await delivered()).length === 1;
  const firstPhase = { firstDelivered, initializePosts: commands.filter(type => type === "initialize_runtime").length,
    promptPosts: commands.filter(type => type === "prompt").length, auxiliaryRequests: requests.filter(item => item.isSuggester).length,
    mainRequests: requests.filter(item => !item.isSuggester).length, persistedUserEntries: (await delivered()).length };
  console.log(JSON.stringify({ phase: "first-cold-send-with-auxiliary-provider-held", ...firstPhase }));
  if (!firstDelivered) {
    console.log(JSON.stringify({ phase: "first-failure-before-reload", ui: (await page.locator("body").innerText()).slice(-4500), fixtureServerLog: serverLog }));
    await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
    await page.getByText("此前的历史回复。", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.locator(".chat-transcript [data-chat-message-row]").filter({ hasText: prompt }).count(), 0, "the failed local transcript row is absent after a reload");
    assert.equal((await delivered()).length, 0, "the vanished row was never persisted");
    console.log(JSON.stringify({ phase: "reload-before-initialization-finishes", failedRowVisible: false, persistedUserEntries: 0 }));
    releaseSuggestions();
    assert.ok(await until(async () => {
      const response = await fetch(`${base}/api/agent/${id}`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ type: "get_commands" }), signal: AbortSignal.timeout(15000) });
      return response.ok;
    }, 30000), "the initialized runtime must become usable after auxiliary inference is released");
    await send();
  }
  assert.ok(await until(async () => (await delivered()).length === 1 && requests.some(item => !item.isSuggester), 30000), "a real main-model call and exactly one persisted input are required");
  await page.getByText(answer, { exact: true }).waitFor({ state: "visible" });
  if (firstDelivered) {
    assert.equal(requests[0].isSuggester, false, "startup must not run suggestion inference before the user prompt");
    assert.ok(await until(() => requests.some(item => item.isSuggester), 10000), "live turn suggestions remain enabled");
    assert.equal((await delivered()).length, 1, "a held live-turn suggestion cannot prevent input persistence");
    releaseSuggestions();
  }
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
  await page.locator(".chat-transcript [data-chat-message-row]").filter({ hasText: prompt }).waitFor({ state: "visible" });
  await page.getByText(answer, { exact: true }).waitFor({ state: "visible" });
  assert.equal((await delivered()).length, 1);
  assert.equal(requests.filter(item => !item.isSuggester).length, 1, "refresh must not dispatch or duplicate a model run");
  console.log(JSON.stringify({ phase: "persisted-after-reload", persistedUserEntries: 1, mainRequests: 1, requiredWarmRetry: !firstDelivered }));
  assert.ok(firstDelivered, "cold input did not reach durable admission; inspect the recorded preparation and request phases rather than assuming one blocker");
} catch (error) {
  console.error(JSON.stringify({ commands, requests, ui: page && !page.isClosed() ? (await page.locator("body").innerText().catch(() => "unavailable")).slice(0, 2400) : "unavailable", fixtureServerLog: serverLog }));
  throw error;
} finally {
  releaseSuggestions();
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM"); const timer = setTimeout(() => server.kill("SIGKILL"), 10000); timer.unref();
    try { await serverExited; } finally { clearTimeout(timer); }
  }
  if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
  await rm(home, { recursive: true });
  console.log(JSON.stringify({ cleanedFixtureHome: home, readerExited: !server || server.exitCode !== null || server.signalCode !== null }));
}
