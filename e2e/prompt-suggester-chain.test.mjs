import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(userInfo().homedir,
  process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
const { chromium } = await import("playwright");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = await mkdtemp(join(process.env.HOME || tmpdir(), ".reader-suggester-chain-"));
const agent = join(home, "agent"), project = join(home, "project"), sessions = join(agent, "sessions", "fixture");
const suggestion = "继续检查插件的真实建议。";
const requests = [];
let browser, server, serverExited, serverLog = "", provider;
console.log(JSON.stringify({ fixtureHome: home, purpose: "offline real-plugin-to-browser acceptance", cleanup: "stop fixture browser and servers, then remove this HOME" }));
try {
  for (const directory of [project, sessions, join(agent, "prompt-suggester")]) await mkdir(directory, { recursive: true });
  await writeFile(join(project, "readme.md"), "Offline fixture project.\n");
  const packageSource = process.env.PI_PROMPT_SUGGESTER_PACKAGE ?? join(userInfo().homedir, ".pi/agent/packages/pi-prompt-suggester");
  assert.ok(isAbsolute(packageSource), "PI_PROMPT_SUGGESTER_PACKAGE must be an absolute package path");
  const packageDir = join(home, "pi-prompt-suggester");
  await cp(packageSource, packageDir, { recursive: true, filter: path => ![".git", "node_modules"].includes(basename(path)) });
  const packageVersion = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")).version;
  const packageTests = [];
  for (const directory of ["src/app/orchestrators", "src/infra/model", "src/infra/pi"]) {
    for (const name of await readdir(join(packageDir, directory))) if (name.endsWith(".test.mjs")) packageTests.push(join(packageDir, directory, name));
  }
  assert.ok(packageTests.some(path => path.endsWith("/session-start.test.mjs")), "the reviewed package must include startup regressions");
  const dependencyLink = join(packageDir, "node_modules");
  await symlink(join(root, "node_modules"), dependencyLink, "dir");
  try {
    const unit = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...packageTests], {
      cwd: packageDir,
      env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" },
      encoding: "utf8",
      timeout: 60000,
    });
    assert.equal(unit.status, 0, `${unit.error ?? ""}\n${unit.stdout}\n${unit.stderr}`);
    const passed = Number(unit.stdout.match(/^# pass (\d+)$/m)?.[1]);
    assert.ok(passed >= packageTests.length, "nested tests must actually execute");
    console.log(JSON.stringify({ phase: "independent-package-unit-tests", packageVersion, testFiles: packageTests.length, passed }));
  } finally {
    await unlink(dependencyLink);
  }
  provider = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const input = JSON.stringify(body.messages ?? []);
    const isSeeder = input.includes("agentic read-only repository seeder");
    requests.push({ path: req.url, model: body.model, isSuggester: input.includes("Write the next message the user would most likely send"), isSeeder });
    const seederCalls = requests.filter(item => item.isSeeder).length;
    const missing = Object.fromEntries(["vision", "architecture", "principles_guidelines"].map(key => [key, { found: false, rationale: "not in offline fixture", files: [] }]));
    const seed = { projectIntentSummary: "fixture", objectivesSummary: "fixture", constraintsSummary: "fixture", principlesGuidelinesSummary: "fixture", implementationStatusSummary: "fixture",
      topObjectives: [], constraints: [], openQuestions: [], categoryFindings: missing, keyFiles: [{ path: "readme.md", category: "other", whyImportant: "fixture" }] };
    const content = isSeeder ? JSON.stringify(seederCalls === 1
      ? { type: "tool", tool: "read", arguments: { path: "readme.md" } }
      : { type: "final", seed }) : suggestion;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (delta, finishReason = null, usage) => ({ id: "fixture-response", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) });
    res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content }))}\n\n`);
    res.write(`data: ${JSON.stringify(chunk({}, "stop", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }))}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: "openai-completions", apiKey: "fixture-not-a-credential",
    models: ["fixture", "other"].map(id => ({ id, name: `Offline ${id} fixture`, reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  } } }));
  await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [packageDir], defaultProvider: "fixture", defaultModel: "fixture" }));
  await writeFile(join(agent, "prompt-suggester", "config.json"), JSON.stringify({ schemaVersion: 8, reseed: { enabled: false }, suggestion: { displayMode: "ghost", showUsageInPanel: true } }));
  const id = "suggester-offline-acceptance", timestamp = "2026-10-27T00:00:00.000Z";
  const projectKey = `project-${createHash("sha256").update(project).digest("hex").slice(0, 12)}`;
  const legacyUsagePath = join(agent, "prompt-suggester", "projects", projectKey, "sessions", id, "usage.json");
  await mkdir(dirname(legacyUsagePath), { recursive: true });
  const legacyStats = { calls: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 110, costTotal: 999 };
  await writeFile(legacyUsagePath, JSON.stringify({ schemaVersion: 1, suggestionUsage: legacyStats,
    seederUsage: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costTotal: 0 }, updatedAt: timestamp }));
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  await writeFile(join(sessions, `${timestamp.replaceAll(":", "-")}_${id}.jsonl`), [
    { type: "session", version: 3, id, timestamp, cwd: project },
    { type: "message", id: "user", parentId: null, timestamp, message: { role: "user", content: "请检查插件。", timestamp: Date.now() } },
    { type: "message", id: "answer", parentId: "user", timestamp, message: { role: "assistant", content: [{ type: "text", text: "已经完成检查，是否继续？" }], api: "openai-completions", provider: "fixture", model: "fixture", usage, stopReason: "stop", timestamp: Date.now() } },
  ].map(JSON.stringify).join("\n") + "\n");
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "--webpack", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root, env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agent, PI_WEB_PASSWORD: "", PI_OFFLINE: "1", NEXT_TELEMETRY_DISABLED: "1", PI_WEB_SESSION_ACTIVITY_CONFIG: JSON.stringify({ device: { id: "suggester-fixture", name: "Suggester fixture" }, peers: [] }) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverExited = once(server, "exit");
  console.log(JSON.stringify({ ownedReaderPid: server.pid, port, providerPort: provider.address().port }));
  for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { serverLog = (serverLog + chunk).slice(-12000); });
  const deadline = Date.now() + 120000;
  while (!(await fetch(base + "/api/sessions", { signal: AbortSignal.timeout(10000) }).catch(() => null))?.ok) {
    if (server.exitCode !== null || Date.now() > deadline) throw new Error(`Fixture server unavailable: ${serverLog}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const command = async body => {
    const response = await fetch(`${base}/api/agent/${id}`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
  };
  await command({ type: "initialize_runtime" });
  assert.equal(requests.length, 0, "initialization must restore state without historical inference");
  const pluginSettings = await (await fetch(`${base}/api/plugin-models`)).json();
  const suggesterSettings = pluginSettings.rows.find(row => row.id === "pi-prompt-suggester");
  assert.equal(suggesterSettings?.label, "Suggester", JSON.stringify(pluginSettings));
  const saveSettings = await fetch(`${base}/api/plugin-models`, {
    method: "PUT", headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ id: suggesterSettings.id, revision: suggesterSettings.revision, model: { provider: "fixture", modelId: "other" } }),
  });
  assert.equal(saveSettings.status, 200, await saveSettings.text());
  const persistedSettings = JSON.parse(await readFile(join(agent, "prompt-suggester", "config.json"), "utf8"));
  assert.equal(persistedSettings.inference.suggesterModel, "fixture/other");
  assert.equal(persistedSettings.inference.seederModel, "fixture/other");
  assert.equal(persistedSettings.reseed.enabled, false);
  await command({ type: "prompt", message: "检查真实回合结束后的建议。", clientMessageId: "fixture-live-turn" });
  const completedBy = Date.now() + 60000;
  let settledState;
  while (true) {
    settledState = await command({ type: "get_state" });
    const hasUsage = settledState.data?.extensionUsages?.some(item => item.key === "pi-prompt-suggester");
    if (requests.some(item => item.isSuggester) && !settledState.data?.isPromptRunning && hasUsage) break;
    assert.ok(Date.now() < completedBy, "the real turn, suggestion, and usage must finish");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const commands = await command({ type: "get_commands" });
  for (const name of ["suggester", "suggesterSettings"]) {
    const matches = commands.data.commands.filter(item => item.name === name);
    assert.equal(matches.length, 1, `${name} must come from one package`);
    assert.match(JSON.stringify(matches[0]), /pi-prompt-suggester/);
    assert.doesNotMatch(JSON.stringify(matches[0]), /builtin:prompt-suggester/);
  }
  assert.equal(requests.find(item => item.isSuggester)?.model, "other", "an existing session must use the updated global model");
  const eventPath = join(agent, "prompt-suggester", "projects", projectKey, "logs", "events.ndjson");
  const events = (await readFile(eventPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(events.some(event => event.message === "suggestion.generated" && event.meta?.displayMode === "ghost"));
  const costResponse = await fetch(`${base}/api/sessions/${id}/cost`);
  const cost = await costResponse.json();
  assert.equal(costResponse.status, 200, JSON.stringify(cost));
  const extensionCost = cost.extensionCosts.find(item => item.id === "pi-prompt-suggester");
  assert.ok(extensionCost, JSON.stringify(cost));
  assert.equal(extensionCost.usage, null, "an incomplete cumulative baseline must not pretend to be per-call usage");
  assert.equal(extensionCost.historicalIncomplete, true);
  assert.equal(extensionCost.status, "partial");
  assert.equal(extensionCost.historicalEstimated, true);
  assert.notEqual(cost.status, "calculated", "the offline fixture provider has no canonical tariff");
  const usagePath = join(agent, "session-extension-usage", createHash("sha256").update(id).digest("hex"), "pi-prompt-suggester.jsonl");
  const usageEvents = (await readFile(usagePath, "utf8")).trim().split("\n").map(JSON.parse);
  const completedUsage = usageEvents.filter(item => item.status === "settled");
  assert.equal(completedUsage.length, 1); assert.equal(completedUsage[0].usage.totalTokens, 15);
  assert.equal(completedUsage[0].usage.cost, undefined, "SDK-estimated cost is not the billing authority");
  assert.ok(usageEvents.some(item => item.type === "aggregate_coverage" && item.eventIds.includes(completedUsage[0].usageEvent.id)));
  const sessionPath = join(sessions, `${timestamp.replaceAll(":", "-")}_${id}.jsonl`);
  const savedEntries = (await readFile(sessionPath, "utf8")).trim().split("\n").map(JSON.parse);
  const savedUsage = savedEntries.find(item => item.type === "custom" && item.customType === "pi-extension-usage");
  const persistedEvent = savedUsage?.data?.event ?? savedUsage?.data;
  assert.equal(persistedEvent?.usageEvent?.id, completedUsage[0].usageEvent.id);
  const inventoryResponse = await fetch(`${base}/api/plugins?cwd=${encodeURIComponent(project)}&scope=global`);
  const inventory = await inventoryResponse.json();
  assert.equal(inventoryResponse.status, 200, JSON.stringify(inventory));
  const installed = inventory.packages.find(item => item.source === packageDir);
  assert.equal(installed?.packageName, "pi-prompt-suggester", JSON.stringify(inventory));
  assert.match(installed.description, /提示词建议/);
  browser = await chromium.launch({ headless: true });
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "zh-CN" });
    const page = await context.newPage(); page.setDefaultTimeout(30000);
    await page.goto(`${base}/?session=${id}`, { waitUntil: "domcontentloaded", timeout: 120000 });
    const textarea = page.locator(".chat-input-textarea"); await textarea.waitFor({ state: "visible" });
    await page.waitForFunction(text => document.querySelector('.chat-input-textarea')?.parentElement.querySelector('div[aria-hidden="true"]')?.textContent === text, suggestion);
    assert.equal(await textarea.getAttribute("placeholder"), "");
    for (const key of ["Tab", "ArrowRight"]) {
      await textarea.fill("继续"); await textarea.press(key);
      assert.equal(await textarea.inputValue(), suggestion);
    }
    if (width === 1280) {
      const sessionInfoButton = page.getByRole("button", { name: "会话信息", exact: true });
      await sessionInfoButton.click();
      await page.getByText(/suggester 费用/).waitFor({ state: "visible" });
      await page.getByText(/历史.*估算/).waitFor({ state: "visible" });
      assert.equal(await page.getByText(/扩展：suggester usage/).count(), 0);
      assert.equal(await page.getByText("单独显示，不计入会话总费用。", { exact: true }).count(), 0);
      assert.equal(await page.locator(".extension-widget-trigger").filter({ hasText: "suggester-panel" }).count(), 0);
      await sessionInfoButton.click();
      await page.getByRole("button", { name: "插件", exact: true }).click();
      const search = page.locator(".config-sidebar-filter input[type=search]");
      await search.fill("提示词建议");
      const entry = page.locator(".config-sidebar-item").filter({ hasText: "pi-prompt-suggester" });
      await entry.waitFor({ state: "visible" });
      await entry.click();
      await page.getByText(/使用 \/suggester 查看状态/).waitFor({ state: "visible" });
    }
    console.log(JSON.stringify({ width, loadedCommand: "suggesterSettings", providerRequests: requests.length, generatedByPlugin: true, visible: true, pluginCatalogChecked: width === 1280, acceptedKeys: ["Tab", "ArrowRight"] }));
    await context.close();
  }
  const projectConfig = join(agent, "prompt-suggester", "projects", projectKey, "config.json");
  await mkdir(dirname(projectConfig), { recursive: true });
  await writeFile(projectConfig, JSON.stringify({ inference: { suggesterModel: "fixture/fixture" } }));
  await command({ type: "prompt", message: "检查项目模型覆盖。", clientMessageId: "fixture-project-override" });
  const overrideDeadline = Date.now() + 60000;
  while (true) {
    const recent = (await readFile(eventPath, "utf8")).trim().split("\n").map(JSON.parse);
    const completed = recent.some(event => event.message === "suggestion.suppressed.repeated_rejected")
      || recent.filter(event => event.message === "suggestion.generated").length >= 2;
    if (requests.filter(item => item.isSuggester).length >= 2 && completed) break;
    assert.ok(Date.now() < overrideDeadline, "the project override must finish its suggestion request");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(requests.filter(item => item.isSuggester)[1].model, "fixture", "project model override must take precedence");
  const secondCost = await (await fetch(`${base}/api/sessions/${id}/cost`)).json();
  const secondExtensionCost = secondCost.extensionCosts.find(item => item.id === "pi-prompt-suggester");
  assert.equal(secondExtensionCost?.usage, null, JSON.stringify(secondCost));
  assert.equal(secondExtensionCost?.historicalIncomplete, true);
  const adapterPath = join(packageDir, "src/infra/pi/extension-adapter.ts");
  const adapter = await readFile(adapterPath, "utf8");
  const description = "Interactive suggester settings menu";
  assert.equal(adapter.split(description).length, 2, "fixture modifies only the independent package copy");
  await writeFile(adapterPath, adapter.replace(description, `${description} (updated fixture)`));
  const globalConfigPath = join(agent, "prompt-suggester", "config.json");
  const updatedConfig = JSON.parse(await readFile(globalConfigPath, "utf8"));
  updatedConfig.reseed = { enabled: true, checkAfterEveryTurn: false, turnCheckInterval: 0 };
  await writeFile(globalConfigPath, JSON.stringify(updatedConfig));
  await command({ type: "reload" });
  const updatedCommands = await command({ type: "get_commands" });
  const updatedSettings = updatedCommands.data.commands.filter(item => item.name === "suggesterSettings");
  assert.equal(updatedSettings.length, 1);
  assert.match(updatedSettings[0].description, /updated fixture/, "the package reloads without rebuilding or restarting Reader");
  assert.ok(server.exitCode === null, "the original Reader process stayed running during the update");
  await command({ type: "prompt", message: "/suggester reseed", clientMessageId: "fixture-reseed" });
  const seedDeadline = Date.now() + 60000;
  let allUsage;
  while (true) {
    allUsage = (await readFile(usagePath, "utf8")).trim().split("\n").map(JSON.parse);
    if (allUsage.filter(item => item.kind === "seeder" && item.status === "settled").length === 2
        && allUsage.some(item => item.kind === "seeder" && item.type === "aggregate_coverage")) break;
    assert.ok(Date.now() < seedDeadline, `multi-step Seeder must settle: ${JSON.stringify(requests)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const seedEvents = allUsage.filter(item => item.kind === "seeder" && item.status === "settled");
  const seedCoverage = allUsage.find(item => item.kind === "seeder" && item.type === "aggregate_coverage");
  assert.equal(new Set(seedEvents.map(item => item.usageEvent.id)).size, 2);
  assert.deepEqual(new Set(seedCoverage.eventIds), new Set(seedEvents.map(item => item.usageEvent.id)));
  const afterSeed = await (await fetch(`${base}/api/sessions/${id}/cost`)).json();
  const afterSeedExtensionCost = afterSeed.extensionCosts.find(item => item.id === "pi-prompt-suggester");
  assert.equal(afterSeedExtensionCost?.usage, null, JSON.stringify(afterSeed));
  assert.equal(afterSeedExtensionCost?.historicalIncomplete, true);
  const countBeforeRestore = requests.length;
  await command({ type: "reload" });
  assert.equal(requests.length, countBeforeRestore, "session restoration must not call a model");
  const afterRestore = await (await fetch(`${base}/api/sessions/${id}/cost`)).json();
  const afterRestoreExtensionCost = afterRestore.extensionCosts.find(item => item.id === "pi-prompt-suggester");
  assert.equal(afterRestoreExtensionCost?.usage, null);
  assert.equal(afterRestoreExtensionCost?.historicalIncomplete, true);
  assert.ok(requests.every(item => item.path === "/v1/chat/completions"), "all inference must use the offline provider");
  assert.equal(requests.filter(item => !item.isSuggester && !item.isSeeder).length, 2, "only the two explicit live turns invoke the main model");
  assert.equal(requests.filter(item => item.isSuggester).length, 2, "each completed live turn generates one suggestion");
  assert.equal(requests.filter(item => item.isSeeder).length, 2, "each Seeder step is recorded separately");
  console.log(JSON.stringify({ phase: "extension-cost", suggestionCalls: 2, seederCalls: 2, totalTokens: 60, restoredWithoutInference: true }));
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM"); const timer = setTimeout(() => server.kill("SIGKILL"), 10000); timer.unref();
    try { await serverExited; } finally { clearTimeout(timer); }
  }
  if (provider) await new Promise(resolve => provider.close(resolve));
  await rm(home, { recursive: true });
  console.log(JSON.stringify({ cleanedFixtureHome: home, readerExited: !server || server.exitCode !== null || server.signalCode !== null }));
}
