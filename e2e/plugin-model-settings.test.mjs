import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { checkCompactionModelSettings } from "./compaction-model.mjs";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(userInfo().homedir, process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
const { chromium } = await import("playwright");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = await mkdtemp(join(process.env.HOME || tmpdir(), ".reader-plugin-models-"));
const agent = join(home, "agent"), project = join(home, "project"), sessions = join(agent, "sessions", "fixture");
const artifacts = join(home, "screenshots");
let browser, server, serverExited, serverLog = "";
console.log(JSON.stringify({ fixtureHome: home, purpose: "plugin model settings browser acceptance", cleanup: "stop fixture processes, remove fixture HOME; retain only desktop/mobile QA screenshots" }));
try {
  await mkdir(project, { recursive: true }); await mkdir(sessions, { recursive: true }); await mkdir(artifacts);
  const packages = [];
  for (const name of ["pi-prompt-suggester", "session-recap-title"]) {
    const source = await realpath(join(userInfo().homedir, ".pi/agent/packages", name)), destination = join(home, "packages", name);
    await cp(source, destination, { recursive: true, filter: async (path) => {
      const name = basename(path).toLowerCase();
      if (["node_modules", ".git"].includes(name)) return false;
      if (name === ".env" || name === ".npmrc" || /(?:credential|secret|token|auth)/.test(name) || /\.(?:pem|key)$/.test(name) || (await lstat(path)).isSymbolicLink()) {
        throw new Error("Unsafe package fixture entry");
      }
      return true;
    } });
    packages.push(destination);
  }
  await writeFile(join(agent, "settings.json"), JSON.stringify({ packages }));
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { "fixture-provider": {
    baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "fixture-not-a-credential",
    models: [{ id: "fixture-model", name: "Fixture model", reasoning: true, input: ["text"], contextWindow: 32000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  await mkdir(join(agent, "session-recap-title"));
  await writeFile(join(agent, "session-recap-title", "config.json"), JSON.stringify({ mode: "follow", thinkingLevel: "low", unrelated: "preserved" }));
  await mkdir(join(agent, "prompt-suggester"));
  await writeFile(join(agent, "prompt-suggester", "config.json"), JSON.stringify({ schemaVersion: 8, suggestion: { displayMode: "ghost" } }));
  const id = "plugin-model-settings-fixture", timestamp = "2026-10-27T00:00:00.000Z";
  await writeFile(join(sessions, `2026-10-27T00-00-00-000Z_${id}.jsonl`), [
    { type: "session", version: 3, id, timestamp, cwd: project },
    { type: "message", id: "user", parentId: null, timestamp, message: { role: "user", content: "模型设置测试" } },
    { type: "message", id: "answer", parentId: "user", timestamp, message: { role: "assistant", content: [{ type: "text", text: "测试会话" }], provider: "fixture", model: "fixture" } },
  ].map(JSON.stringify).join("\n") + "\n");
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "--webpack", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root, env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agent, PI_WEB_PASSWORD: "", PI_OFFLINE: "1", NEXT_TELEMETRY_DISABLED: "1",
      PI_WEB_SESSION_ACTIVITY_CONFIG: JSON.stringify({ device: { id: "plugin-model-fixture", name: "Fixture" }, peers: [] }) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverExited = once(server, "exit");
  console.log(JSON.stringify({ ownedReaderPid: server.pid, port }));
  for (const stream of [server.stdout, server.stderr]) stream.on("data", (chunk) => { serverLog = (serverLog + chunk).slice(-12000); });
  const deadline = Date.now() + 120000;
  while (!(await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(10000) }).catch(() => null))?.ok) {
    if (server.exitCode !== null || Date.now() > deadline) throw new Error(`Fixture server unavailable: ${serverLog}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const available = await (await fetch(`${base}/api/plugin-models`)).json();
  for (const [id, label] of [["session-recap-title", "Recap"], ["pi-prompt-suggester", "Suggester"]]) {
    const row = available.rows.find(item => item.id === id);
    if (row?.label !== label) throw new Error(`Installed plugin was not discovered: ${JSON.stringify(available)}`);
    const response = await fetch(`${base}/api/plugin-models`, { method: "PUT", headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ id, revision: row.revision, model: { provider: "fixture-provider", modelId: "fixture-model" }, thinking: "high" }) });
    if (!response.ok) throw new Error(`Could not save ${label}: ${await response.text()}`);
  }
  const recapConfig = JSON.parse(await readFile(join(agent, "session-recap-title", "config.json"), "utf8"));
  const suggesterConfig = JSON.parse(await readFile(join(agent, "prompt-suggester", "config.json"), "utf8"));
  if (recapConfig.unrelated !== "preserved" || recapConfig.provider !== "fixture-provider" || recapConfig.model !== "fixture-model" || recapConfig.thinkingLevel !== "high") throw new Error("Recap settings were not persisted safely");
  if (suggesterConfig.suggestion?.displayMode !== "ghost" || suggesterConfig.inference?.suggesterModel !== "fixture-provider/fixture-model" || suggesterConfig.inference?.seederModel !== "fixture-provider/fixture-model" || suggesterConfig.inference?.suggesterThinking !== "high" || suggesterConfig.inference?.seederThinking !== "high") throw new Error("Suggester settings were not persisted safely");
  console.log("PASS: installed Recap and Suggester descriptors discovered; model settings persisted independently");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  await context.addInitScript(() => localStorage.setItem("pi-locale", "zh-CN"));
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  await page.goto(`${base}/?session=${id}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.getByRole("button", { name: /^(模型|显示侧边栏)$/ }).first().waitFor();
  await checkCompactionModelSettings(page, artifacts);
  await context.close();
  const qaRoot = join(userInfo().homedir, ".local/share/pi-web-reader/qa");
  await mkdir(qaRoot, { recursive: true });
  const qa = await mkdtemp(join(qaRoot, "plugin-model-settings-"));
  await cp(join(artifacts, "plugin-models-zh-CN-1280-dark.png"), join(qa, "desktop.png"));
  await cp(join(artifacts, "plugin-models-zh-CN-390-dark.png"), join(qa, "mobile.png"));
  console.log(JSON.stringify({ qa, desktop: join(qa, "desktop.png"), mobile: join(qa, "mobile.png") }));
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM"); const timer = setTimeout(() => server.kill("SIGKILL"), 10000); timer.unref();
    try { await serverExited; } finally { clearTimeout(timer); }
  }
  await rm(home, { recursive: true });
  console.log(JSON.stringify({ cleanedFixtureHome: home, readerExited: !server || server.exitCode !== null || server.signalCode !== null }));
}
