import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(userInfo().homedir,
  process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
const { chromium } = await import("playwright");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const id = "quote-reload-fixture";
const timestamp = "2026-10-30T00:00:00.000Z";
const quoteText = Array.from({ length: 41 }, (_, i) => `${String(i).padStart(2, "0")} ${"x".repeat(i < 20 ? 17 : 16)}`).join("\n");
const quote = { id: "fixture-quote", text: quoteText, sourceEntryId: "entry-6599", reply: "fixture reply",
  startSnippet: quoteText.split("\n")[0], endSnippet: quoteText.split("\n").at(-1) };

async function until(check, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

test("a long session restores its unsent quote across search, edits, and reload", { timeout: 240000 }, async () => {
  assert.equal(quoteText.length, 839);
  const home = await mkdtemp(join(process.env.HOME || tmpdir(), ".reader-quote-reload-"));
  const agent = join(home, "agent"), project = join(home, "project"), sessions = join(agent, "sessions", "fixture");
  const sessionFile = join(sessions, `${timestamp.replaceAll(":", "-")}_${id}.jsonl`);
  let browser, server, serverExited, serverLog = "";
  console.log(JSON.stringify({ fixtureHome: home, purpose: "isolated synthetic 36 MB session and unsent quote", cleanup: "close browser, stop owned Reader, remove fixture HOME" }));
  try {
    await mkdir(project, { recursive: true });
    await mkdir(sessions, { recursive: true });
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const filler = `history ${"x".repeat(5300)}`;
    const entries = [{ type: "session", version: 3, id, timestamp, cwd: project }];
    for (let index = 0; index < 6600; index++) {
      const assistant = index % 2 === 1;
      const text = index === 6599 ? `searchable-prefix\n\n${quoteText}\n\nsearchable-suffix` : filler;
      const message = assistant
        ? { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "fixture", model: "fixture", usage, stopReason: "stop", timestamp: Date.now() }
        : { role: "user", content: text, timestamp: Date.now() };
      entries.push({ type: "message", id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null, timestamp, message });
    }
    await writeFile(sessionFile, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const sessionBytes = (await stat(sessionFile)).size;
    assert.ok(sessionBytes > 35000000, `synthetic session is large: ${sessionBytes}`);
    console.log(JSON.stringify({ sessionBytes, entries: 6600, quoteChars: quoteText.length, quoteLines: 41 }));
    const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "--webpack", "-H", "127.0.0.1", "-p", String(port)], {
      cwd: root, env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agent, PI_WEB_PASSWORD: "", PI_OFFLINE: "1",
        NEXT_TELEMETRY_DISABLED: "1", PI_WEB_SESSION_ACTIVITY_CONFIG: JSON.stringify({ device: { id: "quote-fixture", name: "Quote fixture" }, peers: [] }) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverExited = once(server, "exit");
    console.log(JSON.stringify({ ownedReaderPid: server.pid, port }));
    for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { serverLog = (serverLog + chunk).slice(-12000); });
    assert.ok(await until(async () => {
      if (server.exitCode !== null) throw new Error(`Fixture Reader exited: ${serverLog}`);
      return (await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(10000) }).catch(() => null))?.ok;
    }, 120000), `Fixture Reader readiness failed: ${serverLog}`);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1280, height: 900 } });
    await context.addInitScript(({ id, quote }) => {
      if (sessionStorage.getItem("quote-fixture-seeded")) return;
      localStorage.setItem(`pi-web-draft:${id}`, JSON.stringify({ value: "", images: [], quotes: [quote] }));
      sessionStorage.setItem("quote-fixture-seeded", "true");
    }, { id, quote });
    const page = await context.newPage(); page.setDefaultTimeout(60000);
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push({ name: error.name, message: error.message.split("\n")[0] }));
    const open = async () => {
      await page.goto(`${base}/?session=${id}`, { waitUntil: "domcontentloaded", timeout: 120000 });
      await page.locator('[data-chat-message-row][data-entry-id="entry-6599"]').waitFor({ state: "visible" });
      await page.locator('[data-reader-quote-mark="true"]').first().waitFor({ state: "attached" });
      await page.getByRole("button", { name: "编辑引用 1" }).waitFor({ state: "visible" });
      assert.equal(await page.locator(".chat-input-textarea").count(), 1);
      assert.equal(await page.getByText("This page couldn’t load").count(), 0);
    };
    const started = Date.now();
    await open();
    console.log(JSON.stringify({ phase: "open", elapsedMs: Date.now() - started,
      rows: await page.locator("[data-chat-message-row]").count(), quoteRects: await page.locator('[data-reader-quote-mark="true"]').count() }));
    await page.getByRole("button", { name: "编辑引用 1" }).click();
    await page.getByRole("dialog").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.keyboard.press("Control+f");
    const search = page.getByRole("search").getByRole("textbox");
    await search.fill("searchable-prefix");
    await page.locator('[data-session-search-match="true"]').first().waitFor({ state: "attached" });
    await search.press("Escape");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
    await page.locator('[data-chat-message-row][data-entry-id="entry-6599"]').waitFor({ state: "visible" });
    await page.getByRole("button", { name: "编辑引用 1" }).waitFor({ state: "visible" });
    const draft = await page.evaluate((id) => JSON.parse(localStorage.getItem(`pi-web-draft:${id}`)), id);
    assert.equal(draft.value, "");
    assert.equal(draft.quotes.length, 1);
    assert.equal(draft.quotes[0].text, quoteText);
    assert.equal(draft.quotes[0].reply, "fixture reply");
    assert.equal(await page.getByText("This page couldn’t load").count(), 0);
    const unexpectedErrors = pageErrors.filter(error => !error.message.includes("Minified React error #418")
      && !error.message.startsWith("Hydration failed because the server rendered HTML didn't match the client."));
    assert.deepEqual(unexpectedErrors, []);
    console.log(JSON.stringify({ phase: "reloaded", draftPreserved: true, quoteBadge: true, recoverableHydrationErrors: pageErrors.length }));
  } finally {
    await browser?.close();
    if (server && server.exitCode === null) {
      server.kill("SIGTERM"); const timer = setTimeout(() => server.kill("SIGKILL"), 10000); timer.unref();
      try { await serverExited; } finally { clearTimeout(timer); }
    }
    await rm(home, { recursive: true });
    console.log(JSON.stringify({ cleanedFixtureHome: home, readerExited: !server || server.exitCode !== null || server.signalCode !== null }));
  }
});
