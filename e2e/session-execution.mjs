import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = await mkdtemp(join(tmpdir(), "reader-execution-e2e-"));
const agent = join(home, "agent"), project = join(home, "project"), asyncRoot = join(home, "subagents", "async-subagent-runs");
for (const path of [agent, project, asyncRoot, join(agent, "extensions"), join(agent, "sessions", "fixture")]) await mkdir(path, { recursive: true });
let inferenceRequests = 0;
const provider = createServer((req, res) => {
  if (req.method === "POST") inferenceRequests++;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: [{ id: "fixture" }] }));
});
provider.listen(0, "127.0.0.1"); await once(provider, "listening");
await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
  baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: "openai-completions", apiKey: "fixture-not-a-credential",
  models: [{ id: "fixture", name: "Offline execution fixture", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], defaultProvider: "fixture", defaultModel: "fixture", extensions: ["./extensions/control.ts"] }));
// This fake implements only the public stop protocol; it cannot launch a child or a model.
await writeFile(join(agent, "extensions", "control.ts"), `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default function(pi) {
  let sessionFile;
  pi.on('session_start', (_event, ctx) => { sessionFile=ctx.sessionManager.getSessionFile(); });
  pi.events.on('subagents:rpc:v1:request', request => {
    if(request?.method!=='stop'||!/^child-[0-9]+$/.test(request.params?.id)) return;
    const dir=join(${JSON.stringify(asyncRoot)},request.params.id);
    const status=JSON.parse(readFileSync(join(dir,'status.json'),'utf8'));
    const success=status.sessionId===sessionFile;
    if(success) writeFileSync(join(dir,'stop'),'stop');
    pi.events.emit('subagents:rpc:v1:reply:'+request.requestId,{version:1,requestId:request.requestId,success,error:success?undefined:{message:'foreign owner'}});
  });
}
`);
const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], {
  cwd: root, env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agent, PI_SUBAGENTS_TEMP_ROOT: dirname(asyncRoot),
    NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", PI_WEB_SESSION_ACTIVITY_CONFIG: JSON.stringify({ device: { id: "execution-fixture", name: "Execution fixture" }, peers: [] }) },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "", browser;
for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { log = (log + chunk).slice(-10000); });
const children = new Set();
const request = async (path, body) => {
  const response = await fetch(base + path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
try {
  const deadline = Date.now() + 60000;
  while (!(await fetch(base + "/api/sessions").catch(() => null))?.ok) {
    if (server.exitCode !== null || Date.now() > deadline) throw new Error(`Fixture server unavailable: ${log}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true });
  for (const width of [1280, 390]) {
    const id = randomUUID(), runId = `child-${width}`, timestamp = new Date().toISOString();
    const file = join(agent, "sessions", "fixture", `${timestamp.replaceAll(":", "-")}_${id}.jsonl`);
    await writeFile(file, [
      { type: "session", version: 3, id, timestamp, cwd: project },
      { type: "message", id: "u", parentId: null, timestamp, message: { role: "user", content: "Offline stop fixture", timestamp: Date.now() } },
      { type: "message", id: "a", parentId: "u", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Parent already completed." }], stopReason: "stop", provider: "fixture", model: "fixture", api: "openai-completions", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } } },
    ].map(JSON.stringify).join("\n") + "\n");
    const dir = join(asyncRoot, runId); await mkdir(dir);
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import {existsSync} from 'node:fs';
      setInterval(()=>{if(existsSync(${JSON.stringify(join(dir, "stop"))})) process.exit(0);},10);
      process.stdout.write('ready\\n');
    `], { stdio: ["ignore", "pipe", "pipe"] });
    children.add(child); await once(child.stdout, "data");
    await writeFile(join(dir, "status.json"), JSON.stringify({ runId, sessionId: file, state: "running", pid: child.pid, processTerminal: { state: "pending" } }));
    const exited = once(child, "exit").then(async () => {
      await writeFile(join(dir, "status.json"), JSON.stringify({ runId, sessionId: file, state: "stopped", endedAt: Date.now(), processTerminal: { state: "observed" } }));
      children.delete(child);
    });
    const initialized = await request(`/api/agent/${id}`, { type: "initialize_runtime" });
    assert.equal(initialized.status, 200, JSON.stringify(initialized.body));
    assert.equal((await request(`/api/sessions/${id}/archive`, {})).status, 409, "a live child must prevent archive even while the parent is idle");
    const context = await browser.newContext({ viewport: { width, height: 844 }, locale: "zh-CN" });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    await page.goto(`${base}/?session=${id}`);
    const stop = page.getByRole("button", { name: "停止此会话全部执行", exact: true });
    await stop.waitFor({ state: "visible" });
    assert.equal(await page.locator("textarea").first().isEditable(), true);
    const stopped = page.waitForResponse(response => response.url().includes(`/api/sessions/${id}/stop`) && response.request().method() === "POST");
    await stop.click();
    const result = await (await stopped).json();
    assert.equal(result.stopped, true, JSON.stringify(result));
    await exited;
    assert.equal((await request(`/api/agent/${id}`)).body.state.execution.active, false);
    const archive = await request(`/api/sessions/${id}/archive`, {});
    assert.equal(archive.status, 200, JSON.stringify(archive.body)); assert.equal(archive.body.executionClosed, true);
    assert.equal((await request(`/api/agent/${id}`)).body.running, false);
    await assert.rejects(access(file));
    assert.equal((await request(`/api/agent/${id}`, { type: "initialize_runtime" })).body.code, "session_archived");
    await page.goto(`${base}/?view=archived&session=${id}`);
    await page.locator("textarea[readonly]").waitFor({ state: "attached" });
    assert.equal((await request(`/api/agent/${id}`)).body.running, false, "reading archived history cannot reopen execution");
    assert.equal(inferenceRequests, 0);
    console.log(JSON.stringify({ width, parentEditable: true, backgroundStopped: true, archiveClosed: true, archivedReadOnly: true, inferenceRequests }));
    await context.close();
  }
} finally {
  await browser?.close();
  for (const child of children) child.kill("SIGKILL");
  const ended = server.exitCode === null ? once(server, "exit") : Promise.resolve(); server.kill("SIGTERM");
  const forceExit = setTimeout(() => server.kill("SIGKILL"), 10_000); forceExit.unref();
  try { await ended; } finally { clearTimeout(forceExit); }
  await new Promise(resolve => provider.close(resolve));
  await rm(home, { recursive: true, force: true });
}
