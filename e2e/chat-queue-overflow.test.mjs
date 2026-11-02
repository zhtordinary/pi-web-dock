import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The verifier isolates HOME; reuse only the browser executable, not a user profile.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(userInfo().homedir,
  process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
const { chromium } = await import("playwright");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = await mkdtemp(join(process.env.HOME || tmpdir(), ".reader-queue-overflow-e2e-"));
const fixture = join(home, "fixture");
console.log(JSON.stringify({ resource: home, purpose: "isolated chat queue and rendering browser fixture", cleanup: "finally after browser/server exit" }));
let browser, server, serverExited, serverLog = "";
try {
  await mkdir(join(fixture, "app"), { recursive: true });
  await symlink(join(root, "node_modules"), join(fixture, "node_modules"), "dir");
  await writeFile(join(fixture, "package.json"), JSON.stringify({ private: true }));
  await writeFile(join(fixture, "next.config.mjs"), `export default { experimental: { externalDir: true }, webpack(config) { config.resolve.alias['@'] = ${JSON.stringify(root)}; return config; } };\n`);
  await writeFile(join(fixture, "app/layout.tsx"), `import ${JSON.stringify(join(root, "app/globals.css"))};\nexport default function Layout({children}: {children: React.ReactNode}) { return <html><body>{children}</body></html>; }\n`);
  await writeFile(join(fixture, "app/page.tsx"), `"use client";
import { useState } from "react";
import { ChatInput } from ${JSON.stringify(join(root, "components/ChatInput"))};
import { I18nProvider } from ${JSON.stringify(join(root, "hooks/useI18n"))};
function View() {
  const [count, setCount] = useState(20), [recalls, setRecalls] = useState(0);
  const steering = Array.from({length: count}, (_, i) => ({itemId: "s-" + i, text: "message-" + i, hasImages: i === 0}));
  return <main style={{height:"100dvh",display:"flex",flexDirection:"column"}}><header><button onClick={() => setCount(1)}>Short queue</button><button onClick={() => setCount(20)}>Long queue</button><output data-testid="recalls">{recalls}</output></header><div style={{flex:1,minHeight:0}}>Transcript</div><ChatInput onSend={() => {}} onAbort={() => {}} onRecallQueue={() => setRecalls(value => value + 1)} isStreaming canStop queuedMessages={{steering,followUp:[{itemId:"f",text:"last-followup",hasImages:false}]}} /></main>;
}
export default function Page() { return <I18nProvider><View /></I18nProvider>; }\n`);
  await mkdir(join(fixture, "app/render"));
  const sourceCode = `  const value = "${"verylongtoken".repeat(35)}";\n  next();`;
  const markdown = "```javascript\n" + sourceCode + "\n```";
  const patch = ["*** Begin Patch", "*** Update File: a.ts", "@@ first", " context", "-old-a", "-old-extra", "+new-a", "@@ second", "-old-b", "+new-b", "*** End Patch"].join("\n");
  const tocMarkdown = "Setext\n======\n\nSome text\n\n## Second\n\nmore";
  await writeFile(join(fixture, "app/render/page.tsx"), `"use client";
import { useRef } from "react";
import { MarkdownTocPanel } from ${JSON.stringify(join(root, "components/MarkdownToc"))};
import { MessageView } from ${JSON.stringify(join(root, "components/MessageView"))};
import { MarkdownBody } from ${JSON.stringify(join(root, "components/MarkdownBody"))};
import { I18nProvider } from ${JSON.stringify(join(root, "hooks/useI18n"))};
export default function Page() { const root = useRef<HTMLDivElement>(null); return <I18nProvider><div data-testid="render-root" style={{width:280}}><div data-testid="user"><MarkdownBody keepLineBreaks literalHtml>{${JSON.stringify('<div style="display:none">user-visible</div>')}}</MarkdownBody></div><div data-testid="streaming"><MarkdownBody isStreaming>{${JSON.stringify(markdown)}}</MarkdownBody></div><div data-testid="complete"><MarkdownBody>{${JSON.stringify(markdown)}}</MarkdownBody></div><div data-testid="math"><MarkdownBody>{${JSON.stringify('$$\nx^2 + y^2\n$$')}}</MarkdownBody></div><div data-testid="doc-a"><MarkdownBody>{${JSON.stringify('## Target\n\n[Jump](#target)')}}</MarkdownBody></div><div data-testid="doc-b"><MarkdownBody>{${JSON.stringify('## Target\n\n[Jump](#target)')}}</MarkdownBody></div><div data-testid="diff"><MessageView message={{role:"assistant",provider:"fixture",model:"fixture",content:[{type:"toolCall",toolCallId:"patch-fixture",toolName:"apply_patch",input:{input:${JSON.stringify(patch)}}}]}} /></div><div data-testid="toccase"><div ref={root} data-testid="toc-scroll" style={{height:140,overflow:"auto"}}><MarkdownBody>{${JSON.stringify(tocMarkdown)}}</MarkdownBody></div><MarkdownTocPanel source={${JSON.stringify(tocMarkdown)}} scrollRootRef={root} /></div></div></I18nProvider>; }\n`);
  await mkdir(join(fixture, "app/models"));
  await writeFile(join(fixture, "app/models/page.tsx"), `"use client";
import { ModelsConfig } from ${JSON.stringify(join(root, "components/ModelsConfig"))};
import { I18nProvider } from ${JSON.stringify(join(root, "hooks/useI18n"))};
export default function Page() { return <I18nProvider><ModelsConfig onClose={() => {}} /></I18nProvider>; }\n`);
  await mkdir(join(fixture, "app/textarea"));
  await writeFile(join(fixture, "app/textarea/page.tsx"), `"use client";
import { useEffect, useState } from "react";
import { ChatInput } from ${JSON.stringify(join(root, "components/ChatInput"))};
import { I18nProvider } from ${JSON.stringify(join(root, "hooks/useI18n"))};
export default function Page() { const [hint, setHint] = useState(true), [preset, setPreset] = useState(""); useEffect(() => { document.documentElement.dataset.fixtureReady = "true"; }, []); return <I18nProvider><button onClick={() => setHint(false)}>Enable typing</button><output data-testid="preset">{preset}</output><ChatInput onSend={() => {}} onAbort={() => {}} onToolPresetChange={setPreset} isStreaming={false} readOnlyReason={hint ? ${JSON.stringify('Long placeholder '.repeat(2))} : undefined} /></I18nProvider>; }\n`);
  await mkdir(join(fixture, "app/tabs"));
  await writeFile(join(fixture, "app/tabs/page.tsx"), `"use client";
import { useEffect, useState } from "react";
import { TabBar } from ${JSON.stringify(join(root, "components/TabBar"))};
import { I18nProvider } from ${JSON.stringify(join(root, "hooks/useI18n"))};
export default function Page() {
  const [active, setActive] = useState("id-0"), [closed, setClosed] = useState("");
  useEffect(() => { document.documentElement.dataset.fixtureReady = "true"; }, []);
  const tabs = Array.from({length: 14}, (_, i) => ({id:"id-"+i,label:"Tab "+i,filePath:"/fixture/file-"+i,remotePeer:"fixture-peer",dirty:i===13}));
  return <I18nProvider><button onClick={() => setActive("id-13")}>Select last</button><output data-testid="closed">{closed}</output><div style={{width:300}}><TabBar tabs={tabs} activeTabId={active} onSelectTab={setActive} onCloseTab={setClosed} /></div></I18nProvider>;
}\n`);
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "--webpack", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: fixture,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, "agent"), PI_OFFLINE: "1", NEXT_TELEMETRY_DISABLED: "1" },
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
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 500 }]) {
    const context = await browser.newContext({ locale: "en-US", viewport });
    const page = await context.newPage();
    await page.route("**/api/**", route => route.fulfill({ json: {} }));
    await page.goto(base, { waitUntil: "domcontentloaded" });
    const list = page.getByRole("region", { name: "Queued · 21" });
    await list.waitFor({ timeout: 5000 });
    const recall = page.getByRole("button", { name: "Recall to input" });
    const textarea = page.locator(".chat-input-textarea");
    const stop = page.getByRole("button", { name: "Stop all execution for this session" });
    const before = await recall.boundingBox();
    const sizes = await list.evaluate(element => ({ client: element.clientHeight, scroll: element.scrollHeight, max: getComputedStyle(element).maxHeight, tabindex: element.tabIndex }));
    assert.ok(sizes.scroll > sizes.client, `long queue scrolls at ${viewport.width}: ${JSON.stringify(sizes)}`);
    assert.ok(sizes.client <= Math.min(180, viewport.height * 0.25) + 1);
    assert.equal(sizes.tabindex, 0);
    await list.focus();
    assert.equal(await list.evaluate(element => document.activeElement === element), true, "queue region can receive keyboard focus");
    await page.keyboard.press("End");
    await page.waitForFunction(() => {
      const element = document.activeElement;
      return element && element.scrollTop > 0 && element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
    }, null, { timeout: 3000 });
    assert.ok(Math.abs((await recall.boundingBox()).y - before.y) < 1, "Recall remains fixed while rows scroll");
    for (const control of [recall, textarea, stop]) {
      const box = await control.boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height, `control remains visible at ${viewport.width}`);
    }
    const last = list.getByTitle("last-followup");
    const lastBox = await last.boundingBox(), listBox = await list.boundingBox();
    assert.ok(lastBox && listBox && lastBox.y >= listBox.y && lastBox.y + lastBox.height <= listBox.y + listBox.height + 1, "last queued item is fully visible at the end");
    assert.equal(await list.getByLabel("Contains images").count(), 1);
    await recall.click();
    assert.equal(await page.getByTestId("recalls").textContent(), "1");
    await page.getByRole("button", { name: "Short queue" }).click();
    const short = page.getByRole("region", { name: "Queued · 2" });
    await short.waitFor();
    assert.equal(await short.evaluate(element => element.scrollHeight > element.clientHeight), false, "short queues do not gain a scrollbar");
    console.log(JSON.stringify({ viewport, longQueue: sizes, shortQueue: "not clipped", controls: "visible" }));
    await context.close();
  }
  {
    const context = await browser.newContext({ locale: "en-US", viewport: { width: 320, height: 700 }, permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    await page.goto(`${base}/render`, { waitUntil: "domcontentloaded" });
    const user = page.getByTestId("user");
    assert.ok(await user.getByText(/user-visible/).isVisible());
    assert.equal(await user.locator('div[style*="display: none"]').count(), 0);
    for (const name of ["streaming", "complete"]) {
      const block = page.getByTestId(name).locator(".markdown-code-block");
      const pre = block.locator("pre");
      await pre.waitFor();
      const sizes = await pre.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth, height: element.clientHeight }));
      assert.ok(sizes.scroll <= sizes.client + 1, `${name} code must not scroll horizontally: ${JSON.stringify(sizes)}`);
      assert.ok(sizes.height > 60, `${name} long token wraps onto multiple visual lines`);
      if (name === "complete") {
        const layout = await pre.evaluate(element => {
          const line = element.querySelector("code > span"), number = line?.querySelector(".react-syntax-highlighter-line-number");
          const keyword = [...element.querySelectorAll(".token")].find(token => token.textContent === "const");
          const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
          const keywordBox = keyword?.getBoundingClientRect(), numberBox = number?.getBoundingClientRect();
          return { display: line && getComputedStyle(line).display, lineHeight, keywordHeight: keywordBox?.height, keywordLeft: keywordBox?.left, numberRight: numberBox?.right };
        });
        assert.equal(layout.display, "block", "syntax tokens flow together rather than shrinking as flex items");
        assert.ok(layout.keywordHeight <= layout.lineHeight * 1.25 && layout.keywordLeft >= layout.numberRight - 1, `keywords and gutter stay aligned: ${JSON.stringify(layout)}`);
      }
      await block.getByRole("button", { name: "Copy" }).click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), sourceCode, `${name} copies the original source`);
      console.log(JSON.stringify({ rendering: name, sizes, copy: "exact" }));
    }
    await page.getByTestId("math").getByRole("button", { name: "Copy" }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "x^2 + y^2", "math copy returns the original TeX");
    await page.evaluate(() => {
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function(options) { this.setAttribute("data-test-scrolled", "yes"); return original.call(this, options); };
    });
    await page.getByTestId("doc-b").getByRole("link", { name: "Jump" }).click();
    assert.equal(await page.getByTestId("doc-a").locator('[data-heading-anchor="target"]').getAttribute("data-test-scrolled"), null);
    assert.equal(await page.getByTestId("doc-b").locator('[data-heading-anchor="target"]').getAttribute("data-test-scrolled"), "yes");
    const scroll = page.getByTestId("toc-scroll");
    const expectedTop = await scroll.evaluate(root => {
      const target = root.querySelector('[data-heading-anchor="second"]');
      root.scrollTo = options => { root.dataset.scrolledTop = String(options.top); };
      return Math.max(0, root.scrollTop + target.getBoundingClientRect().top - root.getBoundingClientRect().top - 12);
    });
    await page.getByTestId("toccase").getByRole("button", { name: "Second" }).click();
    assert.equal(Number(await scroll.getAttribute("data-scrolled-top")), expectedTop, "TOC jumps to the ATX heading, not the earlier Setext heading");
    const diff = page.getByTestId("diff");
    await diff.getByRole("button", { name: /apply_patch/ }).click();
    const grid = diff.locator(".chat-split-diff-grid");
    await grid.waitFor();
    const visibleRows = await grid.locator(".chat-split-diff-cell").evaluateAll(cells => cells.filter(cell => getComputedStyle(cell).display !== "none").map(cell => cell.textContent.trim()));
    assert.deepEqual(visibleRows, ["context", "-old-a", "+new-a", "-old-extra", "-old-b", "+new-b"]);
    assert.equal(await grid.locator(".chat-split-diff-cell.is-right.is-context").isVisible(), false);
    assert.match(await grid.textContent(), /@@ second/);
    await page.setViewportSize({ width: 1280, height: 800 });
    const left = await grid.locator(".is-left.is-removed").first().boundingBox();
    const right = await grid.locator(".is-right.is-added").first().boundingBox();
    assert.ok(left && right && Math.abs(left.y - right.y) < 1 && right.x > left.x, "desktop keeps the paired two-column diff");
    await page.setViewportSize({ width: 320, height: 700 });
    await context.close();
  }
  {
    const context = await browser.newContext({ locale: "en-US", viewport: { width: 390, height: 700 } });
    const page = await context.newPage();
    await page.route("**/api/**", route => route.fulfill({ json: {} }));
    await page.goto(`${base}/textarea`, { waitUntil: "domcontentloaded" });
    await page.locator('html[data-fixture-ready="true"]').waitFor();
    const textarea = page.locator(".chat-input-textarea");
    await textarea.waitFor();
    const placeholder = await textarea.evaluate(element => ({ height: element.getBoundingClientRect().height, width: element.clientWidth, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollbar: getComputedStyle(element).scrollbarWidth }));
    assert.ok(placeholder.height > 30 && placeholder.scrollHeight <= placeholder.clientHeight + 1 && placeholder.scrollbar === "none", `wrapped placeholders stay visible without a scrollbar: ${JSON.stringify(placeholder)}`);
    await page.getByRole("button", { name: "Enable typing" }).click();
    await textarea.fill(Array.from({length: 40}, (_, index) => `line ${index}`).join("\n"));
    await textarea.press("End"); await textarea.press("Shift+Enter");
    const dimensions = await textarea.evaluate(element => ({ height: element.getBoundingClientRect().height, scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, cursor: element.selectionStart, length: element.value.length }));
    assert.ok(dimensions.height <= 201 && dimensions.scrollTop > 0 && dimensions.scrollTop + dimensions.clientHeight >= dimensions.scrollHeight - 1 && dimensions.cursor === dimensions.length, `long drafts retain the last caret line: ${JSON.stringify(dimensions)}`);
    await page.getByRole("button", { name: "More controls" }).click();
    await page.getByRole("button", { name: "Change tool preset" }).click();
    const menu = page.getByRole("listbox", { name: "Change tool preset" });
    const menuBounds = await menu.boundingBox();
    assert.ok(menuBounds && menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= 390, `tool menu remains within the viewport: ${JSON.stringify(menuBounds)}`);
    await menu.getByRole("option", { name: /read-only/ }).click();
    assert.equal(await page.getByTestId("preset").textContent(), "read-only");
    console.log(JSON.stringify({ textarea: "placeholder and caret", dimensions, toolMenu: menuBounds }));
    await context.close();
  }
  {
    const context = await browser.newContext({ locale: "en-US", viewport: { width: 390, height: 700 } });
    const page = await context.newPage();
    await page.goto(`${base}/tabs`, { waitUntil: "domcontentloaded" });
    await page.locator('html[data-fixture-ready="true"]').waitFor();
    const strip = page.getByRole("tablist");
    await page.getByRole("button", { name: "Select last" }).click();
    await page.waitForFunction(() => document.querySelector('[role="tablist"]')?.scrollLeft > 0);
    const last = strip.locator('[data-active="true"]');
    const bounds = await last.evaluate(element => ({ tab: element.getBoundingClientRect().toJSON(), list: element.parentElement.getBoundingClientRect().toJSON() }));
    assert.ok(bounds.tab.left >= bounds.list.left - 1 && bounds.tab.right <= bounds.list.right + 1);
    assert.equal(Math.round(bounds.list.height), 36);
    assert.equal(await last.getByLabel("Unsaved changes").count(), 1);
    const before = await strip.evaluate(element => element.scrollLeft);
    await strip.hover(); await page.mouse.wheel(0, -500);
    await page.waitForFunction(old => document.querySelector('[role="tablist"]')?.scrollLeft < old, before);
    await page.getByRole("button", { name: "Select last" }).click();
    await last.getByRole("button", { name: "Close Tab 13" }).click();
    assert.equal(await page.getByTestId("closed").textContent(), "id-13");
    console.log(JSON.stringify({ tabs: "active visible, wheel and close work", height: bounds.list.height }));
    await context.close();
  }
  {
    const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const config = { providers: { relay: { api: "anthropic-messages", baseUrl: "https://provider.example.test", compat: { forceAdaptiveThinking: true, unrelated: "kept" }, models: [{ id: "alpha", name: "Friendly Alpha", reasoning: true, input: ["text", "image"], inputLimits: { images: { maxPerMessage: 3, resize: { maxBytes: 1024, maxWidth: 512 } } } }] } }, hiddenModels: ["relay/hidden-other"] };
    let releaseFirst, markStarted, markCompleted, saved;
    const started = new Promise(resolve => { markStarted = resolve; });
    const completed = new Promise(resolve => { markCompleted = resolve; });
    const gate = new Promise(resolve => { releaseFirst = resolve; });
    const requests = [];
    await page.route("**/api/**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === "/api/models-config/test") {
        requests.push(request.postDataJSON());
        if (requests.length === 1) { markStarted(); await gate; }
        await route.fulfill({ json: { ok: true, responseText: requests.length === 1 ? "STALE_RESPONSE" : "FRESH_RESPONSE" } });
        if (requests.length === 1) markCompleted();
      } else if (path === "/api/models-config" && request.method() === "PUT") {
        saved = request.postDataJSON();
        await route.fulfill({ json: { success: true, runtimeRefresh: {} } });
      } else if (path === "/api/models-config") await route.fulfill({ json: config });
      else if (path === "/api/models/enabled") await route.fulfill({ json: { allEnabled: true, patterns: [], stalePatterns: [], scope: "global", settingsPath: "fixture", editable: true, enabledTotal: 0, availableTotal: 0, providers: [] } });
      else if (path === "/api/auth/providers") await route.fulfill({ json: { oauthProviders: [], apiKeyProviders: [] } });
      else await route.fulfill({ json: {} });
    });
    page.on("pageerror", error => console.log(`MODEL_PAGE_ERROR ${error.message}`));
    const response = await page.goto(`${base}/models`, { waitUntil: "domcontentloaded" });
    if (!response?.ok()) throw new Error(`model fixture HTTP ${response?.status()}: ${serverLog.slice(-3000)}`);
    try {
      await page.getByText("Friendly Alpha", { exact: true }).waitFor({ timeout: 8000 });
    } catch (error) {
      console.log("MODEL_FIXTURE_TEXT " + (await page.locator("body").innerText()).slice(0, 3000));
      console.log("MODEL_FIXTURE_SERVER " + serverLog.slice(-3000));
      throw error;
    }
    await page.getByText("Friendly Alpha", { exact: true }).click();
    await page.getByRole("button", { name: /Advanced settings/ }).click();
    const url = page.getByPlaceholder("https://provider.example.test");
    await url.fill("https://one.example.test");
    const test = page.getByRole("button", { name: "Test", exact: true });
    await test.click(); await started;
    await url.fill("https://two.example.test");
    releaseFirst(); await completed;
    await test.click();
    await page.getByText(/FRESH_RESPONSE/).waitFor();
    assert.equal(await page.getByText(/STALE_RESPONSE/).count(), 0, "old endpoint response cannot replace the current result");
    assert.equal(requests[0].model.baseUrl, "https://one.example.test");
    assert.equal(requests[1].model.baseUrl, "https://two.example.test");
    await page.getByRole("button", { name: "Adaptive thinking" }).click();
    await page.getByRole("option", { name: "Disabled", exact: true }).click();
    const imageLimit = page.getByLabel("Image resize limit (base64 bytes)");
    assert.equal(await imageLimit.inputValue(), "1024");
    await imageLimit.fill("0");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText(/relay\/alpha: enter a positive whole number/).waitFor();
    assert.equal(saved, undefined, "invalid image limit is rejected before the network write");
    await imageLimit.fill("2048");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Saved", { exact: true }).waitFor();
    assert.equal(saved.providers.relay.models[0].baseUrl, "https://two.example.test");
    assert.equal(saved.providers.relay.models[0].compat.forceAdaptiveThinking, false);
    assert.deepEqual(saved.providers.relay.models[0].inputLimits, { images: { maxPerMessage: 3, resize: { maxBytes: 2048, maxWidth: 512 } } });
    assert.deepEqual(saved.hiddenModels, ["relay/hidden-other"]);
    assert.equal(saved.providers.relay.compat.unrelated, "kept");
    console.log(JSON.stringify({ models: "endpoint race and inherited compat", requests: requests.length, hiddenPreference: "unchanged" }));
    await context.close();
  }
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    const timeout = setTimeout(() => server.kill("SIGKILL"), 10000); timeout.unref();
    try { await serverExited; } finally { clearTimeout(timeout); }
  }
  await rm(home, { recursive: true });
  console.log(JSON.stringify({ cleanedFixtureHome: home, serverExited: !server || server.exitCode !== null || server.signalCode !== null }));
}
