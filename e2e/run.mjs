// Adapted from @Nuctori's script-style CI/E2E fixtures in PR #617 (issue #599).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { checkFilePanel, filePanelFixture } from "./file-panel.mjs";
import { checkExtensionDialogs, extensionSource } from "./extension-dialog.mjs";
import { checkChatAppearance } from "./chat-appearance.mjs";
import { checkFloatingSelectLayout } from "./floating-select.mjs";
import { checkSettingsSelects } from "./settings-select.mjs";
import { checkCompactionModelSettings } from "./compaction-model.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.env.E2E_SERVER_MODE || "dev";
assert.ok(mode === "dev" || mode === "start", "E2E_SERVER_MODE must be dev or start");
assert.ok(mode !== "dev" || !existsSync(join(root, ".next/dev/lock")), "Use a checkout without an active dev server");
const artifacts = join(root, "test-results/e2e");
mkdirSync(artifacts, { recursive: true });
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-e2e-"));
console.log(JSON.stringify({ resource: agentDir, purpose: "synthetic browser session fixtures", cleanup: "finally after browser and server exit" }));
const project = join(agentDir, "project");
const sessionDir = join(agentDir, "sessions", "e2e");
mkdirSync(project);
const previewFile = join(project, "preview.html");
writeFileSync(previewFile, filePanelFixture);
mkdirSync(sessionDir, { recursive: true });
const timestamp = "2026-08-23T00:00:00.000Z";
const LONG = "e2e-long-session";
const BRANCH = "e2e-branch-session";
const RICH = "e2e-rich-session";
const COMPACTED = "e2e-compacted-session";
const APPEND = "e2e-external-append-session";
const text = (i) => `E2E message ${String(i).padStart(4, "0")}`;
const ids = (start, end) => Array.from({ length: end - start }, (_, i) => `e${start + i}`);

function message(id, parentId, role, content) {
  return { type: "message", id, parentId, timestamp, message: { role, content } };
}

function writeSession(id, entries) {
  const header = { type: "session", version: 3, id, timestamp, cwd: project };
  writeFileSync(join(sessionDir, `2026-08-23T00-00-00-000Z_${id}.jsonl`),
    [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

async function assertEnglishUi(page, selector, label) {
  const content = await page.locator(selector).evaluate((root) => {
    const visible = (element) => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const attributes = [...root.querySelectorAll("[title], [aria-label], [placeholder]")]
      .filter(visible)
      .flatMap((element) => [element.getAttribute("title"), element.getAttribute("aria-label"), element.getAttribute("placeholder")]);
    return [root.innerText, ...attributes].filter(Boolean).join("\n");
  });
  const withoutLanguageNames = content.replaceAll("简体中文", "").replaceAll("繁體中文", "");
  assert.doesNotMatch(withoutLanguageNames, /[\u3400-\u9fff]/u, `${label} contains Chinese UI copy`);
}

async function checkEnglishMessages(page, width) {
  await page.getByText("Edit in input", { exact: true }).first().waitFor({ state: "attached" });
  await page.getByText("Fork to session", { exact: true }).first().waitFor({ state: "attached" });
  await assertEnglishUi(page, "body", `${width}px message actions`);
}

async function checkEnglishSettings(page, width) {
  // Settings open from the sessions sidebar; open it only when it is hidden and close it again afterwards,
  // because on phones it is an overlay over the composer.
  const sessionToggle = page.locator('.app-top-bar [data-layout-control="sessions"]');
  const openedSessions = await sessionToggle.count() > 0 && await sessionToggle.getAttribute("aria-label") === "Show sessions";
  if (openedSessions) await sessionToggle.click();
  await page.getByRole("button", { name: "Models", exact: true }).first().click({ timeout: 20_000 });
  await page.getByRole("button", { name: "General", exact: true }).click({ timeout: 20_000 });
  await assertEnglishUi(page, '[role="dialog"][aria-label="Settings"]', `${width}px settings`);
  await page.keyboard.press("Escape");
  if (openedSessions) await page.getByRole("button", { name: "Hide sessions", exact: true }).first().click();
}

let server;
let serverExited;
let browser;
let page;
let context;
let serverError;
let browserErrors = [];
const serverLog = createWriteStream(join(artifacts, "server.log"));
const interrupt = () => {
  process.exitCode = 1;
  server?.kill("SIGTERM");
  void browser?.close().catch(() => {});
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

try {
  // Seed before startup so the first catalogue scan sees every fixture.
  mkdirSync(join(agentDir, "extensions"));
  writeFileSync(join(agentDir, "extensions", "e2e-dialog.js"), extensionSource);
  const longEntries = Array.from({ length: 5000 }, (_, i) =>
    message(`e${i}`, i ? `e${i - 1}` : null, i % 2 ? "assistant" : "user", text(i)));
  // A branch ends on an answer, as in a real session; navigating to a bare user prompt reopens it for editing instead.
  longEntries.splice(1, 0, message("alternate", "e0", "user", "E2E alternate history branch"),
    message("alternate-answer", "alternate", "assistant", "E2E alternate branch answer"));
  writeSession(LONG, longEntries);
  writeSession(BRANCH, [
    message("root", null, "user", "Branch root"),
    message("old", "root", "assistant", "Inactive branch answer"),
    message("new", "root", "assistant", "Active branch answer"),
  ]);
  const toolResult = message("result", "call", "toolResult", [{ type: "text", text: "E2E tool output" }]);
  Object.assign(toolResult.message, { toolCallId: "t1", toolName: "bash", isError: false });
  const richEntries = [
    message("user", null, "user", "Render **E2E markdown**"),
    message("call", "user", "assistant", [
      { type: "thinking", thinking: "" },
      { type: "thinking", thinking: "E2E intermediate reasoning\nIntermediate thinking details." },
      { type: "text", text: "E2E process paragraph.\n\n".repeat(20) },
      { type: "toolCall", id: "t1", name: "bash", arguments: { command: "echo E2E tool output" } },
    ]),
    toolResult,
    message("answer", "result", "assistant", [
      { type: "thinking", thinking: "" },
      { type: "thinking", thinking: "E2E follow-up reasoning\nFollow-up thinking details." },
      { type: "text", text: "E2E process note" },
      { type: "thinking", thinking: "E2E final reasoning\nFinal thinking details." },
      { type: "text", text:
        "E2E final answer\n```js\nconsole.log('E2E code');\n```\n\n"
        + "E2E answer paragraph.\n\n".repeat(20)
        + "## E2E reading position\n\n"
        + "E2E answer paragraph.\n\n".repeat(20),
      },
    ]),
  ];
  Object.assign(richEntries.at(-1).message, { provider: "test", model: "E2E Model" });
  writeSession(RICH, richEntries);
  // The default page is 50 *visible* messages (user / assistant / compaction).
  // toolResults ride along free after #810, so 48 tool-call assistants + the
  // final answer + the divider fill that window; the user prompt is the 51st
  // visible entry and must stay outside the first page.
  const compactedEntries = [
    message("user", null, "user", "E2E prompt outside the compacted page"),
    { type: "compaction", id: "compact", parentId: "user", timestamp, summary: "E2E compaction anchor", firstKeptEntryId: "user", tokensBefore: 100 },
  ];
  for (let i = 0; i < 48; i++) {
    compactedEntries.push(message(`call${i}`, compactedEntries.at(-1).id, "assistant", [
      { type: "toolCall", id: `t${i}`, name: "bash", arguments: { command: `echo step${i}` } },
    ]));
    const result = message(`result${i}`, `call${i}`, "toolResult", [{ type: "text", text: `step${i}` }]);
    Object.assign(result.message, { toolCallId: `t${i}`, toolName: "bash", isError: false });
    compactedEntries.push(result);
  }
  compactedEntries.push(message("answer", "result47", "assistant", [{ type: "text", text:
    "E2E compacted answer paragraph.\n\n".repeat(20)
    + "## E2E compacted heading\n\n"
    + "E2E compacted answer paragraph.\n\n".repeat(20),
  }]));
  writeSession(COMPACTED, compactedEntries);
  writeSession(APPEND, [
    message("root", null, "user", "E2E wrapper root"),
    message("reply", "root", "assistant", "E2E wrapper reply"),
  ]);

  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  // Builds use webpack (scripts/build-reader.mjs); Turbopack cannot load the node:sqlite runtime modules.
  server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), mode, ...(mode === "dev" ? ["--webpack"] : []), "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  console.log(JSON.stringify({ ownedServerPid: server.pid, cwd: root, port }));
  server.once("error", (error) => { serverError = error; });
  serverExited = once(server, "exit");
  server.stdout.pipe(serverLog, { end: false });
  server.stderr.pipe(serverLog, { end: false });

  async function api(path, status = 200) {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30_000) });
    // Route handlers report failures in the body; keep it so CI shows the cause, not only the status.
    if (response.status !== status) assert.fail(`${path}: ${response.status} !== ${status}\n${(await response.text()).slice(0, 4000)}`);
    return response.json();
  }

  async function post(path, body) {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    assert.ok(response.ok, `POST ${path} -> ${response.status}`);
    return response.json();
  }

  const deadline = Date.now() + 120_000;
  while (true) {
    if (serverError) throw serverError;
    assert.equal(server.exitCode, null, "Server exited before readiness; see server.log");
    const response = await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (response?.ok) {
      const { sessions } = await response.json();
      assert.deepEqual(sessions.map((session) => session.id).sort(), [LONG, BRANCH, RICH, COMPACTED, APPEND].sort());
      break;
    }
    assert.ok(Date.now() < deadline, "Server readiness timed out; see server.log");
    await delay(250);
  }

  const detail = await api(`/api/sessions/${LONG}?deferThinking=1&deferMedia=1`);
  assert.deepEqual(detail.context.entryIds, ids(4950, 5000));
  assert.equal(detail.context.messages.length, 50);
  assert.equal(detail.context.hasMore, true);
  const detailBytes = JSON.stringify(detail).length;
  assert.ok(detailBytes < 100_000, `Detail transferred unbounded history: ${detailBytes} bytes (${
    Object.entries(detail).map(([key, value]) => `${key}=${JSON.stringify(value ?? null).length}`).join(", ")})`);
  const tail = await api(`/api/sessions/${LONG}/context?tail=50`);
  assert.deepEqual(tail.context.entryIds, ids(4950, 5000));
  assert.equal(tail.context.messages.length, 50);
  const selectedBranch = await api(`/api/sessions/${BRANCH}/context?leafId=old`);
  assert.deepEqual(selectedBranch.context.entryIds, ["root", "old"]);
  const rootPage = await api(`/api/sessions/${BRANCH}/context?before=old&tail=1`);
  assert.deepEqual(rootPage.context.entryIds, ["root"]);
  assert.equal(rootPage.context.hasMore, false);
  const beforeRoot = await api(`/api/sessions/${BRANCH}/context?before=root`);
  assert.deepEqual(beforeRoot.context.entryIds, []);
  assert.equal(beforeRoot.context.hasMore, false);
  await api("/api/sessions/e2e-does-not-exist", 404);
  await api("/api/files/..%2F..%2Fetc%2Fpasswd?type=read", 400);
  const compacted = await api(`/api/sessions/${COMPACTED}`);
  assert.equal(compacted.context.entryIds[0], "compact");
  assert.equal(compacted.context.messages.some((entry) => entry.role === "user"), false);
  console.log("PASS: bounded history, branch context, pagination root, and API errors");

  // Reads never wake a runtime, and they come from the durable session file:
  // the read cache keys on file identity, so another process's append is
  // visible on the next ordinary read.
  {
    const file = join(sessionDir, `2026-08-23T00-00-00-000Z_${APPEND}.jsonl`);
    const cold = await fetch(`${base}/api/agent/${APPEND}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "get_state" }),
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(cold.status, 409, "a state read must not start a runtime");
    assert.equal((await cold.json()).code, "runtime_not_live");
    const beforeAppend = await api(`/api/sessions/${APPEND}`);
    assert.deepEqual(beforeAppend.context.entryIds, ["root", "reply"]);
    appendFileSync(file, `${JSON.stringify(message("external", "reply", "assistant", "E2E external append"))}\n`);
    const afterAppend = await api(`/api/sessions/${APPEND}`);
    assert.deepEqual(afterAppend.context.entryIds, ["root", "reply", "external"], "reads follow the durable file");
    const again = await api(`/api/sessions/${APPEND}`);
    assert.deepEqual(again.context.entryIds, ["root", "reply", "external"], "repeated reads must stay stable");
    const appended = await api(`/api/sessions/${APPEND}/context?tail=1`);
    // A tail page keeps its newest turn intact, so it starts at the turn's user prompt.
    assert.deepEqual(appended.context.entryIds, ["root", "reply", "external"], "the appended entry ends the intact tail turn");
    console.log("PASS: reads never wake a runtime and follow external appends to the session file");
  }

  const isOlderHistoryPage = (value) => {
    const url = new URL(value);
    return url.pathname === `/api/sessions/${LONG}/history` && url.searchParams.get("mode") === "window" && url.searchParams.has("before");
  };
  if (process.env.E2E_ONLY_I18N === "1") {
    await api(`/api/sessions/${LONG}/state`);
    await api(`/api/sessions/${RICH}/state`);
  }
  browser = await chromium.launch();
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    context = await browser.newContext({ viewport, locale: "en-US" });
    await context.tracing.start({ screenshots: true, snapshots: true });
    page = await context.newPage();
    page.setDefaultTimeout(mode === "dev" ? 90_000 : 30_000);
    const errors = [];
    browserErrors = errors;
    const olderResponses = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (event) => { if (event.type() === "error") errors.push(event.text()); });
    page.on("response", (response) => {
      if (response.url().startsWith(base) && response.status() >= 500) errors.push(`${response.status()} ${response.url()}`);
      if (isOlderHistoryPage(response.url())) olderResponses.push(response);
    });
    const stateReady = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/sessions/${LONG}/state`);
    await page.goto(`${base}/?session=${LONG}`, { waitUntil: "domcontentloaded" });
    assert.equal((await stateReady).status(), 200);
    await page.getByText(text(4999), { exact: true }).waitFor();
    await assertEnglishUi(page, "body", `${viewport.width}px session`);
    if (process.env.E2E_ONLY_I18N === "1") {
      await page.goto(`${base}/?session=${RICH}`, { waitUntil: "domcontentloaded" });
      await page.locator("strong").filter({ hasText: "E2E markdown" }).waitFor();
      await checkEnglishMessages(page, viewport.width);
      await checkFilePanel(page, previewFile, assertEnglishUi);
      await checkEnglishSettings(page, viewport.width);
      assert.deepEqual(errors, [], `Browser errors at width ${viewport.width}`);
      console.log(`PASS: ${viewport.width}px English session, messages, file panel and settings`);
      await context.tracing.stop();
      await context.close();
      context = undefined;
      page = undefined;
      continue;
    }
    if (viewport.width === 1280) await checkFloatingSelectLayout(page);
    const latestUser = await page.getByText(text(4998), { exact: true }).elementHandle();
    assert.ok(latestUser, "Latest user message must be mounted before pagination");
    // The transcript loads older windows through /history when its top sentinel scrolls into view.
    const sentinel = page.locator("[data-history-sentinel='earlier']");
    await sentinel.waitFor({ state: "attached" });
    assert.equal(await page.getByText(text(2500), { exact: true }).count(), 0, "The first page must not render the whole session");

    // Exercise the real IntersectionObserver and prepend path, twice.
    for (let turn = 0; turn < 2; turn++) {
      const responsePromise = page.waitForResponse((response) => isOlderHistoryPage(response.url()));
      await sentinel.evaluate((element) => element.scrollIntoView({ block: "start", behavior: "instant" }));
      const response = await responsePromise;
      assert.equal(response.status(), 200);
      const older = await response.json();
      assert.equal(older.kind, "window");
      const firstUser = older.items.find((item) => item.role === "user" && typeof item.message?.content === "string");
      assert.ok(firstUser, "Older page must contain user messages");
      await page.getByText(firstUser.message.content, { exact: true }).waitFor({ state: "attached" });
      await page.getByText(text(4999), { exact: true }).evaluate((element) => element.scrollIntoView({ block: "end", behavior: "instant" }));
    }
    assert.deepEqual(await latestUser.evaluate((element) => ({
      connected: element.isConnected,
      text: element.textContent,
    })), { connected: true, text: text(4998) }, "Prepending history must preserve existing message nodes");
    await latestUser.dispose();
    assert.ok(olderResponses.length >= 2, "Scrolling must fetch consecutive older pages");
    // The sidebar also displays the first message as the session title.
    const rendered = (await page.getByText(/^E2E message \d{4}$/).allTextContents()).filter((value) => value !== text(0));
    const oldest = Number(rendered[0]?.slice(-4));
    assert.ok(oldest < 4950, "Older pages must extend the rendered history");
    assert.deepEqual(rendered, Array.from({ length: 5000 - oldest }, (_, i) => text(oldest + i)), "Missing, reordered, or duplicate chat messages");
    await page.screenshot({ path: join(artifacts, `history-${viewport.width}.png`) });

    await page.goto(`${base}/?session=${BRANCH}`, { waitUntil: "domcontentloaded" });
    await page.getByText("Active branch answer", { exact: true }).waitFor();
    assert.equal(await page.getByText("Inactive branch answer", { exact: true }).count(), 0);
    const thinkingRequests = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith("/thinking")) thinkingRequests.push(request.url());
    });
    await page.goto(`${base}/?session=${RICH}`, { waitUntil: "domcontentloaded" });
    await page.locator("strong").filter({ hasText: "E2E markdown" }).waitFor();
    await checkEnglishMessages(page, viewport.width);
    // A code block is one .markdown-code-block: header, copy button and the highlighted <pre>.
    await page.locator(".markdown-code-block").filter({ hasText: "console.log('E2E code');" }).waitFor();
    await page.getByText("E2E final answer", { exact: true }).waitFor();
    const processDetails = page.getByRole("button", { name: /^Process details/ });
    const thinking = page.getByRole("button", { name: /^Thinking/ });
    assert.equal(await processDetails.count(), 1);
    assert.equal(await thinking.count(), 0, "All thinking stays inside process details");
    const finalMessage = page.locator("[data-entry-id='answer']");
    assert.equal(await finalMessage.getByRole("button", { name: /^Thinking/ }).count(), 0);
    // The answer header shows the model's display name, without the provider prefix.
    assert.equal(await finalMessage.getByText("E2E Model", { exact: true }).count(), 1);
    assert.equal(thinkingRequests.length, 0);
    await processDetails.click();
    const thinkingCount = await thinking.count();
    // Live-tail fixtures may keep process content in an already-active stream rather than expose the deferred toggle buttons.
    if (thinkingCount > 0) {
      assert.equal(thinkingCount, 3);
      // Deferred thinking shows a plain label; its text loads only when opened.
      assert.deepEqual(await thinking.allInnerTexts(), ["Thinking", "Thinking", "Thinking"]);
      assert.equal(thinkingRequests.length, 0);
      for (const [index, text] of ["Intermediate thinking details.", "Follow-up thinking details.", "Final thinking details."].entries()) {
        await thinking.nth(index).click();
        await page.getByText(text, { exact: false }).waitFor();
      }
      // Opening process details reads the whole process range at once; single blocks need no further reads.
      assert.equal(thinkingRequests.length, 0);
    } else {
      assert.equal(thinkingCount, 0);
    }
    const processText = await processDetails.locator("..").innerText();
    assert.ok(processText.indexOf("E2E intermediate reasoning") < processText.indexOf("echo E2E tool output"));
    assert.ok(processText.indexOf("echo E2E tool output") < processText.indexOf("E2E follow-up reasoning"));
    assert.ok(processText.indexOf("E2E follow-up reasoning") < processText.indexOf("E2E process note"));
    assert.ok(processText.indexOf("E2E process note") < processText.indexOf("E2E final reasoning"));
    assert.equal(processText.split("E2E final reasoning").length - 1, 1);
    assert.ok(!(await finalMessage.last().innerText()).includes("E2E final reasoning"));
    await page.getByText("echo E2E tool output", { exact: true }).waitFor();
    await page.getByRole("button", { name: /bash.*echo E2E tool output/ }).click();
    await page.getByText("E2E tool output", { exact: true }).waitFor();
    await page.goto(`${base}/?session=${COMPACTED}`, { waitUntil: "domcontentloaded" });
    const heading = page.getByRole("heading", { name: "E2E compacted heading", exact: true });
    await heading.waitFor({ state: "attached" });
    if (viewport.width > 600) {
      const node = page.locator("[data-minimap-node-index='0']");
      await node.waitFor();
      const rect = await node.boundingBox();
      assert.ok(rect);
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
      const preview = page.locator("[data-minimap-preview-box]");
      // The preview names a compaction node generically; its summary stays in the transcript.
      await preview.getByRole("button", { name: "Compaction summary", exact: true }).waitFor();
      await preview.getByRole("button", { name: "E2E compacted heading", exact: true }).click();
      await page.waitForFunction(() => {
        const heading = document.querySelector("[data-entry-id='answer'] h2");
        const scroll = heading?.closest(".overflow-y-auto");
        // A minimap jump aligns its target just below the transcript's top edge (MINIMAP_ANCHOR_OFFSET).
        return heading && scroll && Math.abs(heading.getBoundingClientRect().top
          - scroll.getBoundingClientRect().top - 12) < 5;
      });
      await page.screenshot({ path: join(artifacts, "compaction-minimap.png") });

      const selectSession = async (title, entryId) => {
        await page.locator(`[title="${title}"]`).click();
        // Leave the sidebar so its session hover preview closes instead of covering the transcript.
        await page.mouse.move(viewport.width / 2, 5);
        await page.locator(`[data-chat-message-row][data-entry-id="${entryId}"]`).waitFor({ state: "visible" });
      };
      const positionForReading = (target) => target.evaluate((element) => {
        const scroll = element.closest(".overflow-y-auto");
        scroll.scrollTop += element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 120;
      });
      const latestInView = (entryId) => page.waitForFunction((id) => {
        const element = document.querySelector(`[data-chat-message-row][data-entry-id="${id}"]`);
        const scroll = element?.closest(".overflow-y-auto");
        if (!element || !scroll) return false;
        const rect = element.getBoundingClientRect(), view = scroll.getBoundingClientRect();
        return rect.bottom > view.top && rect.top < view.bottom;
      }, entryId);
      await selectSession(text(0), "e4999");
      const olderPage = page.waitForResponse((response) => isOlderHistoryPage(response.url()));
      await page.locator("[data-history-sentinel='earlier']").evaluate((element) => element.scrollIntoView({ block: "start", behavior: "instant" }));
      // Read a row from the window that was just prepended; its size is the reader's own.
      const olderEntryId = (await (await olderPage).json()).items[0].entryId;
      await positionForReading(page.locator(`[data-chat-message-row][data-entry-id="${olderEntryId}"]`));
      await selectSession("Render **E2E markdown**", "user");
      const process = page.getByRole("button", { name: /process details/i });
      await process.click();
      await positionForReading(page.getByRole("heading", { name: "E2E reading position", exact: true }));
      // Reopening a session lands on its latest turn (the reader's latest-question/bottom preference)
      // instead of restoring an older reading offset, and its process details start collapsed.
      await selectSession(text(0), "e4999");
      await latestInView("e4999");
      await selectSession("Render **E2E markdown**", "answer");
      await latestInView("answer");
      assert.equal(await process.getAttribute("aria-expanded"), "false");

      // Hold pagination until a different branch has loaded, exercising effect cancellation.
      let releaseHistory;
      const historyGate = new Promise((resolve) => { releaseHistory = resolve; });
      const historyRoute = `**/api/sessions/${LONG}/history?*`;
      await page.route(historyRoute, async (route) => {
        if (isOlderHistoryPage(route.request().url())) await historyGate;
        await route.continue().catch(() => {});
      });
      // Branch navigation is confirmed by the session runtime before the view switches, so it runs for real.
      try {
        // Opening a session lands on its latest turn, so scroll up to put an older-page read in flight.
        await selectSession(text(0), "e4999");
        const pendingHistory = page.waitForRequest((request) => isOlderHistoryPage(request.url()));
        await page.locator("[data-history-sentinel='earlier']").evaluate((element) => element.scrollIntoView({ block: "start", behavior: "instant" }));
        await pendingHistory;
        await page.getByRole("button", { name: "Branches", exact: true }).click();
        await page.getByText("E2E alternate history branch", { exact: true }).click();
        await page.locator("[data-chat-message-row][data-entry-id='alternate']").waitFor({ state: "visible" });
        await page.screenshot({ path: join(artifacts, "pending-history-branch.png") });
      } finally {
        releaseHistory();
        await page.unroute(historyRoute);
      }
      // The runtime persists the switch in the session, so return to the main line before the next viewport opens it.
      await page.getByRole("button", { name: "Branches", exact: true }).click();
      await page.getByText(text(1), { exact: true }).click();
      await page.locator("[data-chat-message-row][data-entry-id='e4999']").waitFor({ state: "visible" });
      console.log("PASS: reopened sessions land on their latest turn, collapsed process details, and branch switches cancel pending history reads");
      await page.goto(`${base}/?session=${COMPACTED}`, { waitUntil: "domcontentloaded" });
      await heading.waitFor({ state: "visible" });
    }
    await page.goto(`${base}/?session=${RICH}`, { waitUntil: "domcontentloaded" });
    await page.locator(".markdown-code-block").first().waitFor();
    await checkFilePanel(page, previewFile, assertEnglishUi);
    await checkEnglishSettings(page, viewport.width);
    await checkExtensionDialogs(page, artifacts, viewport.width);
    if (viewport.width > 600) {
      await page.goto(`${base}/?session=${RICH}`, { waitUntil: "domcontentloaded" });
      await page.locator(".markdown-code-block").first().waitFor();
      await checkChatAppearance(page);
      await checkSettingsSelects(page, artifacts);
      await checkCompactionModelSettings(page, artifacts);
    }
    assert.deepEqual(errors, [], `Browser errors at width ${viewport.width}`);
    console.log(`PASS: ${viewport.width}px browser pagination, branch, markdown, code, tool call, and compaction navigation`);
    await context.tracing.stop();
    await context.close();
    context = undefined;
    page = undefined;
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  if (page) {
    console.error("Browser errors:", JSON.stringify(browserErrors));
    console.error("Visible fixture page:", (await page.locator("body").innerText().catch(() => "unavailable")).slice(0, 1000));
    await page.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {});
    await page.content().then((html) => writeFileSync(join(artifacts, "failure.html"), html)).catch(() => {});
    await page.locator("body").ariaSnapshot().then((tree) => writeFileSync(join(artifacts, "failure-aria.yml"), tree)).catch(() => {});
  }
  if (context) await context.tracing.stop({ path: join(artifacts, "trace.zip") }).catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    const forceKill = setTimeout(() => server.kill("SIGKILL"), 10_000);
    await serverExited;
    clearTimeout(forceKill);
  }
  serverLog.end();
  rmSync(agentDir, { recursive: true, force: true });
  console.log(JSON.stringify({ cleanedFixtureHome: agentDir, serverExited: !server || server.exitCode !== null || server.signalCode !== null }));
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
