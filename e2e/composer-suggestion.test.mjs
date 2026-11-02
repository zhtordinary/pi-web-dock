import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The release verifier isolates HOME; reuse only the installed browser binary, not a user profile.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(userInfo().homedir,
  process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
const { chromium } = await import("playwright");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = await mkdtemp(join(process.env.HOME || tmpdir(), ".reader-composer-e2e-"));
const agent = join(home, "agent"), project = join(home, "project"), sessions = join(agent, "sessions", "fixture");
console.log(JSON.stringify({ resource: home, purpose: "isolated composer browser fixture", cleanup: "finally removes fixture HOME after browser/server exit" }));
let browser, server, serverExited, serverLog = "";
try {
  for (const path of [project, sessions]) await mkdir(path, { recursive: true });
  const id = "composer-suggestion-layout", timestamp = "2026-10-27T00:00:00.000Z";
  await writeFile(join(sessions, `${timestamp.replaceAll(":", "-")}_${id}.jsonl`), [
    { type: "session", version: 3, id, timestamp, cwd: project },
    { type: "message", id: "user", parentId: null, timestamp, message: { role: "user", content: "Composer layout fixture" } },
    { type: "message", id: "answer", parentId: "user", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Offline browser fixture." }], stopReason: "stop" } },
  ].map(JSON.stringify).join("\n") + "\n");
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  // Match the production webpack pipeline, including node:sqlite externals.
  server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "--webpack", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agent, PI_WEB_PASSWORD: "", PI_OFFLINE: "1", NEXT_TELEMETRY_DISABLED: "1",
      PI_WEB_SESSION_ACTIVITY_CONFIG: JSON.stringify({ device: { id: "composer-fixture", name: "Composer fixture" }, peers: [] }) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverExited = once(server, "exit");
  console.log(JSON.stringify({ ownedServerPid: server.pid, cwd: root, port }));
  for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { serverLog = (serverLog + chunk).slice(-12000); });
  const deadline = Date.now() + 90000;
  while (!(await fetch(base + "/api/sessions", { signal: AbortSignal.timeout(10000) }).catch(() => null))?.ok) {
    if (server.exitCode !== null || Date.now() > deadline) throw new Error(`Fixture server unavailable: ${serverLog}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true });
  const failures = [], screenshots = [], writes = [];
  for (const width of [1280, 641, 640, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(); page.setDefaultTimeout(30000);
    let suggestion = null;
    const state = () => ({ isStreaming: false, isPromptRunning: false, autoCompactionEnabled: true,
      editorSuggestion: suggestion, branchPosition: { leafId: "answer", pending: false } });
    const quietCost = { amount: 1.23, currency: "USD", status: "partial", pendingUsageCount: 1,
      pendingUsageModels: ["fixture/model"], missingPriceModels: [], models: ["fixture/model"], sessionCount: 1 };
    let costBody = { ...quietCost, totalCost: quietCost, parentCost: quietCost,
      extensionCosts: [{ ...quietCost, id: "pi-prompt-suggester" }] };
    await page.route(`**/api/sessions/${id}/cost**`, route => route.fulfill({ json: costBody }));
    await page.route("**/api/agent/**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname.endsWith("/events")) {
        return route.fulfill({ contentType: "text/event-stream", body: [
          { type: "connected", sessionId: id, isStreaming: false, pendingExtensionUiIds: [] },
          { type: "extension_ui_request", method: "set_editor_suggestion", suggestion },
        ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") });
      }
      const command = request.method() === "POST" && !url.pathname.endsWith("/lease") ? request.postDataJSON() : null;
      if (["prompt", "steer", "follow_up", "retry_continue"].includes(command?.type)) writes.push(command.type);
      const data = command?.type === "get_tools" || command?.type === "get_commands" ? []
        : command?.type === "get_unattended" ? { enabled: false } : state();
      return route.fulfill({ json: { success: true, running: true, state: state(), data } });
    });
    await page.route(`**/api/sessions/${id}/state`, route => route.fulfill({ json: { running: true, state: state() } }));
    const textarea = page.locator(".chat-input-textarea");
    for (const mode of ["empty", "suggested"]) {
      suggestion = mode === "suggested" ? "继续检查输入框的建议显示。" : null;
      if (mode === "suggested") await textarea.fill("");
      await page.goto(`${base}/?session=${id}`, { waitUntil: "domcontentloaded", timeout: 120000 });
      await textarea.waitFor({ state: "visible" });
      await page.waitForFunction(text => {
        const input = document.querySelector(".chat-input-textarea");
        const overlay = input?.parentElement.querySelector('div[aria-hidden="true"]');
        return input && (text ? overlay?.textContent === text : !overlay);
      }, suggestion);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const metrics = await textarea.evaluate(input => {
        const css = getComputedStyle(input), rect = input.getBoundingClientRect(), row = input.parentElement.parentElement.getBoundingClientRect();
        const mirror = document.createElement("div");
        Object.assign(mirror.style, { position: "fixed", visibility: "hidden", width: `${input.clientWidth}px`, whiteSpace: "pre-wrap", overflowWrap: "break-word",
          fontFamily: css.fontFamily, fontSize: css.fontSize, fontWeight: css.fontWeight, lineHeight: css.lineHeight });
        mirror.textContent = input.value || input.placeholder || " "; document.body.append(mirror);
        const textHeight = Math.max(parseFloat(css.lineHeight), mirror.getBoundingClientRect().height); mirror.remove();
        const firstLine = rect.top + parseFloat(css.paddingTop) + parseFloat(css.lineHeight) / 2;
        const overlay = input.parentElement.querySelector('div[aria-hidden="true"]');
        const overlayCss = overlay && getComputedStyle(overlay);
        return { placeholder: input.placeholder, label: input.getAttribute("aria-label"),
          centerDelta: rect.top + parseFloat(css.paddingTop) + textHeight / 2 - (row.top + row.height / 2),
          overlayDelta: overlay && overlay.getBoundingClientRect().top + parseFloat(overlayCss.paddingTop) + parseFloat(overlayCss.lineHeight) / 2 - firstLine };
      });
      console.log("COMPOSER_METRICS " + JSON.stringify({ width, mode, ...metrics }));
      if (Math.abs(metrics.centerDelta) > 1) failures.push(`${width}/${mode}: center delta ${metrics.centerDelta}`);
      if (suggestion && (metrics.placeholder !== "" || Math.abs(metrics.overlayDelta) > 1)) failures.push(`${width}/${mode}: placeholder or ghost baseline overlaps`);
      if (!suggestion && !metrics.placeholder) failures.push(`${width}/${mode}: missing placeholder`);
      if (!suggestion && width === 390) {
        await textarea.fill("plain");
        await page.keyboard.insertText(" ");
        assert.equal(await textarea.inputValue(), "plain ", "mobile space remains ordinary input without a suggestion");
      }
      if (suggestion) {
        assert.ok(metrics.label, "hiding the placeholder must retain an accessible input name");
        if ([1280, 390].includes(width)) screenshots.push({ width, png: (await page.locator(".chat-input-shell").screenshot()).toString("base64") });
        for (const key of ["Tab", "ArrowRight"]) {
          await textarea.fill("继续"); await textarea.press(key);
          assert.equal(await textarea.inputValue(), suggestion, `${width}: ${key} accepts the suggestion`);
        }
        if (width === 390) {
          await textarea.fill("");
          await textarea.focus();
          await page.keyboard.insertText(" ");
          assert.equal(await textarea.inputValue(), suggestion, "mobile insertText space accepts the suggestion without keydown");
          await textarea.fill("继续");
          await page.keyboard.insertText(" ");
          assert.equal(await textarea.inputValue(), suggestion, "mobile space accepts a matching prefix");
          await textarea.fill("继续");
          await textarea.evaluate(input => input.setSelectionRange(0, 1));
          await page.keyboard.insertText(" ");
          assert.equal(await textarea.inputValue(), " 续", "mobile replacement preserves the selected text operation");
          await textarea.fill("");
          await textarea.evaluate(input => input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
          await page.keyboard.insertText(" ");
          assert.equal(await textarea.inputValue(), " ", "space during IME composition must not accept the suggestion");
          await textarea.evaluate(input => input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
          const stats = page.getByRole("button", { name: "会话信息", exact: true });
          await stats.waitFor({ state: "visible" });
          await page.waitForFunction(() => document.querySelector('button[aria-label="会话信息"]')?.textContent?.includes("$1.23"));
          // The mobile top bar intentionally scrolls horizontally when its controls do not fit.
          await stats.scrollIntoViewIfNeeded();
          const statsBounds = await stats.evaluate(button => ({ left: button.getBoundingClientRect().left, right: button.getBoundingClientRect().right, width: window.innerWidth }));
          assert.ok(statsBounds.left >= 0 && statsBounds.right <= statsBounds.width, `cost control can be scrolled into view: ${JSON.stringify(statsBounds)}`);
          await stats.click();
          await page.getByText("总费用", { exact: true }).waitFor({ state: "visible" });
          const visibleText = await page.locator("body").innerText();
          assert.doesNotMatch(visibleText, /用量待对账/, "suggester unknown usage stays out of the user-facing cost view");
          const costPanel = page.locator(".session-info-popover");
          const costText = await costPanel.innerText();
          assert.doesNotMatch(costText, /已记录|已記錄|Recorded/);
          assert.doesNotMatch(costText, /≥\$/, "only suggester unknown usage stays out of the pending lower-bound display");
          assert.match(costText, /父会话费用/);
          assert.match(costText, /pi-prompt-suggester 费用/);
          screenshots.push({ width, kind: "cost", png: (await costPanel.screenshot()).toString("base64") });
          const mixedCost = { ...quietCost, pendingUsageCount: 2 };
          costBody = { ...mixedCost, totalCost: mixedCost, parentCost: mixedCost,
            extensionCosts: [{ ...quietCost, id: "pi-prompt-suggester" }, { ...quietCost, id: "fixture-extension" }] };
          await page.reload({ waitUntil: "domcontentloaded" });
          await stats.waitFor({ state: "visible" });
          await page.waitForFunction(() => document.querySelector('button[aria-label="会话信息"]')?.title.includes("1 条用量待对账"));
          await stats.click();
          const mixedText = await page.locator("body").innerText();
          assert.match(mixedText, /1 条用量待对账/, "other extensions retain their pending-usage warning");
          assert.match(mixedText, /≥\$/, "other pending usage retains the lower-bound amount");
          assert.doesNotMatch(mixedText, /2 条用量待对账/);
          const unknownOnly = { ...quietCost, amount: null, status: "unavailable" };
          costBody = { ...unknownOnly, totalCost: unknownOnly, parentCost: unknownOnly,
            extensionCosts: [{ ...unknownOnly, id: "pi-prompt-suggester" }] };
          await page.reload({ waitUntil: "domcontentloaded" });
          await stats.waitFor({ state: "visible" });
          await page.waitForFunction(() => document.querySelector('button[aria-label="会话信息"]')?.textContent?.includes("—"));
          assert.doesNotMatch(await stats.innerText(), /已记录|已記錄|Recorded/);
          assert.doesNotMatch(await stats.innerText(), /\$0/, "unknown-only usage is not presented as free");
        }
      }
    }
    await context.close();
  }
  assert.deepEqual(writes, [], "the fixture must never request generation");
  assert.deepEqual(failures, []);
  for (const screenshot of screenshots) console.log("COMPOSER_SCREENSHOT " + JSON.stringify(screenshot));
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
