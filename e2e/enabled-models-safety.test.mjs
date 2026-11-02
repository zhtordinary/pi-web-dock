import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The verifier isolates HOME; only the browser executable is reused, never a user profile.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(userInfo().homedir,
  process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
const { chromium } = await import("playwright");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = await mkdtemp(join(process.env.HOME || tmpdir(), ".reader-model-scope-e2e-"));
const fixture = join(home, "fixture"), agent = join(home, "agent");
const settingsPath = join(agent, "settings.json"), modelsPath = join(agent, "models.json");
console.log(JSON.stringify({ resource: home, purpose: "isolated model scope UI and API fixture", cleanup: "finally after browser/server exit" }));
let browser, server, serverExited, serverLog = "", releaseAGet, releaseAPut, releaseBGet, releaseBPut;
try {
  await mkdir(join(fixture, "app/api/models/enabled"), { recursive: true });
  await mkdir(agent);
  await symlink(join(root, "node_modules"), join(fixture, "node_modules"), "dir");
  await writeFile(join(fixture, "package.json"), JSON.stringify({ private: true }));
  await writeFile(join(fixture, "next.config.mjs"), `export default { experimental: { externalDir: true }, webpack(config) { config.resolve.alias['@'] = ${JSON.stringify(root)}; return config; } };\n`);
  await writeFile(join(fixture, "app/layout.tsx"), "export default function Layout({children}: {children: React.ReactNode}) { return <html><body>{children}</body></html>; }\n");
  await writeFile(join(fixture, "app/page.tsx"), `"use client";
import { useState } from "react";
import { EnabledModelsSection, useEnabledModels } from ${JSON.stringify(join(root, "components/EnabledModelsSection"))};
import { I18nProvider } from ${JSON.stringify(join(root, "hooks/useI18n"))};
function View() {
  const [peer, setPeer] = useState<string | undefined>();
  const controller = useEnabledModels(null, peer);
  return <><button onClick={() => setPeer("owner-a")}>Peer A</button><button onClick={() => setPeer("owner-b")}>Peer B</button><button onClick={controller.refresh}>Refresh scope</button><button onClick={() => { controller.setModels("one", ["fixture/one"], false); controller.setModels("two", ["fixture/two"], false); }}>Queue two edits</button><EnabledModelsSection providerId="fixture" peer={peer} controller={controller} /></>;
}
export default function Page() { return <I18nProvider><View /></I18nProvider>; }
\n`);
  await writeFile(join(fixture, "app/api/models/enabled/route.ts"), `export { GET, PUT } from ${JSON.stringify(join(root, "app/api/models/enabled/route"))};\n`);
  const models = JSON.stringify({ hiddenModels: ["fixture/two"], providers: {
    fixture: { baseUrl: "https://example.invalid/v1", api: "openai-completions", apiKey: "fixture-not-a-credential", models: [{ id: "one" }, { id: "two" }] },
  } });
  const original = JSON.stringify({ enabledModels: ["fixture/*", "unavailable/model:high"], keep: true });
  await writeFile(modelsPath, models);
  await writeFile(settingsPath, original);
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "--webpack", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: fixture,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverExited = once(server, "exit");
  console.log(JSON.stringify({ ownedServerPid: server.pid, cwd: fixture, port }));
  for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { serverLog = (serverLog + chunk).slice(-12000); });
  const deadline = Date.now() + 90000;
  while (!(await fetch(base, { signal: AbortSignal.timeout(10000) }).catch(() => null))?.ok) {
    if (server.exitCode !== null || Date.now() > deadline) throw new Error(`Fixture server unavailable: ${serverLog}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1000, height: 800 } });
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  const toggle = page.getByRole("switch", { name: "Show one in the model selector" });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await toggle.click();
  const warning = page.locator('.enabled-models-section [role="alert"]');
  await warning.waitFor();
  assert.match(await warning.textContent(), /other models that are not listed.*Nothing was saved/);
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  assert.equal(await readFile(settingsPath, "utf8"), original);
  assert.equal(await readFile(modelsPath, "utf8"), models);

  await writeFile(settingsPath, JSON.stringify({ enabledModels: ["fixture/one", "fixture/two"], keep: true }));
  await page.reload({ waitUntil: "domcontentloaded" });
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Show one in the model selector"]')?.getAttribute("aria-checked") === "false");
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { enabledModels: ["fixture/two"], keep: true });
  assert.equal(await readFile(modelsPath, "utf8"), models, "display-only hidden preferences must remain unchanged");
  const view = (oneEnabled) => ({
    allEnabled: false, patterns: ["fixture/two"], stalePatterns: [], scope: "global", settingsPath: "fixture", editable: true,
    enabledTotal: oneEnabled ? 2 : 1, availableTotal: 2,
    providers: [{ id: "fixture", name: "fixture", kind: "builtin", enabledCount: oneEnabled ? 2 : 1, models: [
      { id: "one", name: "one", ref: "fixture/one", enabled: oneEnabled },
      { id: "two", name: "two", ref: "fixture/two", enabled: true },
    ] }],
  });
  let holdAGet = false, holdAPut = false, signalAGet, signalAPut;
  let aView = true, aConflict = false, aGets = 0, aPuts = 0;
  let holdBGet = true, signalBGet, signalBPut, failBPut = false;
  const bGetStarted = new Promise(resolve => { signalBGet = resolve; });
  const writes = [];
  await page.route("**/api/remote/models/enabled**", async route => {
    const request = route.request();
    const peer = new URL(request.url()).searchParams.get("peer");
    if (request.method() === "GET") {
      if (peer === "owner-a") aGets += 1;
      if (peer === "owner-a" && holdAGet) {
        holdAGet = false;
        await new Promise(resolve => { releaseAGet = resolve; signalAGet(); });
      }
      if (peer === "owner-b" && holdBGet) {
        holdBGet = false;
        await new Promise(resolve => { releaseBGet = resolve; signalBGet(); });
      }
      return route.fulfill({ json: view(peer === "owner-a" && aView) });
    }
    writes.push({ peer, body: request.postDataJSON() });
    if (peer === "owner-a") {
      aPuts += 1;
      if (aConflict) {
        aConflict = false;
        aView = false;
        return route.fulfill({ status: 409, json: { error: "stale revision", reason: "revision-conflict" } });
      }
      if (holdAPut) {
        holdAPut = false;
        await new Promise(resolve => { releaseAPut = resolve; signalAPut(); });
      }
      return route.fulfill({ json: view(false) });
    }
    await new Promise(resolve => { releaseBPut = resolve; signalBPut(); });
    return route.fulfill(failBPut
      ? { status: 409, json: { error: "scope refused", reason: "unsafe-scope" } }
      : { json: view(false) });
  });
  await page.getByRole("button", { name: "Peer A" }).click();
  await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Show one in the model selector"]')?.getAttribute("aria-checked") === "true");
  await page.getByRole("button", { name: "Peer B" }).click();
  await bGetStarted;
  try {
    assert.equal(await toggle.count(), 0, "the previous peer's switches must disappear while the new peer loads");
  } finally {
    releaseBGet();
  }
  await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Show one in the model selector"]')?.getAttribute("aria-checked") === "false");
  for (const { fail, returnToB } of [{ fail: false, returnToB: false }, { fail: true, returnToB: true }]) {
    if (fail) {
      await page.getByRole("button", { name: "Peer B" }).click();
      await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Show one in the model selector"]')?.getAttribute("aria-checked") === "false");
    }
    failBPut = fail;
    const started = new Promise(resolve => { signalBPut = resolve; });
    await toggle.click();
    await started;
    assert.equal(writes.at(-1).peer, "owner-b");
    await page.getByRole("button", { name: "Peer A" }).click();
    await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Show one in the model selector"]')?.getAttribute("aria-checked") === "true");
    assert.equal(await toggle.isEnabled(), true, "a request for another peer must not lock this peer's controls");
    if (returnToB) {
      await page.getByRole("button", { name: "Peer B" }).click();
      await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Show one in the model selector"]')?.getAttribute("aria-checked") === "false");
    }
    const settled = page.waitForResponse(response => response.request().method() === "PUT" && response.url().includes("/models/enabled"));
    releaseBPut();
    await settled;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await toggle.getAttribute("aria-checked"), returnToB ? "false" : "true", "a late peer result must not replace the current view");
    assert.equal(await page.locator('.enabled-models-section [role="alert"]').count(), 0, "a late peer failure must not appear in the current view");
  }
  for (const order of ["get-first", "put-first"]) {
    await page.getByRole("button", { name: "Peer B" }).click();
    await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Show one in the model selector"]')?.getAttribute("aria-checked") === "false");
    await page.getByRole("button", { name: "Peer A" }).click();
    await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Show one in the model selector"]')?.getAttribute("aria-checked") === "true");
    if (order === "put-first") {
      holdAPut = true;
      const started = new Promise(resolve => { signalAPut = resolve; });
      await toggle.click();
      await started;
    }
    holdAGet = true;
    const started = new Promise(resolve => { signalAGet = resolve; });
    await page.getByRole("button", { name: "Refresh scope" }).click();
    await started;
    if (order === "get-first") await toggle.click();
    else releaseAPut();
    await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Show one in the model selector"]')?.getAttribute("aria-checked") === "false");
    const settled = page.waitForResponse(response => response.request().method() === "GET" && response.url().includes("peer=owner-a"));
    releaseAGet();
    await settled;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await toggle.getAttribute("aria-checked"), "false", `a late refresh (${order}) must not undo a completed edit`);
  }
  await page.getByRole("button", { name: "Peer B" }).click();
  await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Show one in the model selector"]')?.getAttribute("aria-checked") === "false");
  await page.getByRole("button", { name: "Peer A" }).click();
  await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Show one in the model selector"]')?.getAttribute("aria-checked") === "true");
  const beforeConflict = { gets: aGets, puts: aPuts };
  aConflict = true;
  await page.getByRole("button", { name: "Queue two edits" }).click();
  await page.locator('.enabled-models-section [role="alert"]').waitFor();
  await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Show one in the model selector"]')?.getAttribute("aria-checked") === "false");
  assert.equal(aGets, beforeConflict.gets + 1, "a revision conflict refreshes the current scope once");
  assert.equal(aPuts, beforeConflict.puts + 1, "a conflict must not replay the refused or queued write");
  assert.match(await page.locator('.enabled-models-section [role="alert"]').textContent(), /changed in another operation.*Nothing was saved/);
  console.log(JSON.stringify({ result: "scope refusals, hidden preferences, peer transitions, refresh races and conflict recovery verified" }));
  await context.close();
} finally {
  releaseAGet?.();
  releaseAPut?.();
  releaseBGet?.();
  releaseBPut?.();
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    const timeout = setTimeout(() => server.kill("SIGKILL"), 10000); timeout.unref();
    try { await serverExited; } finally { clearTimeout(timeout); }
  }
  await rm(home, { recursive: true });
  console.log(JSON.stringify({ cleanedFixtureHome: home, serverExited: !server || server.exitCode !== null || server.signalCode !== null }));
}
