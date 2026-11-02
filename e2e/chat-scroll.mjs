import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = await mkdtemp(join(tmpdir(), "reader-scroll-"));
const agent = join(home, "agent"), project = join(home, "project");
const sessions = join(agent, "sessions", "fixture");
const timestamp = "2026-10-22T00:00:00.000Z";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const answer = (text) => ({ role: "assistant", content: [{ type: "text", text }], provider: "fixture",
  model: "fixture", api: "openai-responses", stopReason: "stop", usage });
const paragraphs = (label, count) => Array.from({ length: count }, (_, i) => `${label} paragraph ${i}: reading position must remain stable.`).join("\n\n");
for (const path of [sessions, project]) await mkdir(path, { recursive: true });

const liveMarker = "live-answer-opening-marker";
let liveRunning = true, liveLeafId = "l2";
const liveRuns = new Map();
const pendingPrompts = new Map();
const sessionFile = id => join(sessions, `${timestamp.replaceAll(":", "-")}_${id}.jsonl`);
const sendState = id => ({ isStreaming: Boolean(liveRuns.get(id)?.running), isPromptRunning: Boolean(liveRuns.get(id)?.running),
  autoCompactionEnabled: true, branchPosition: { leafId: liveRuns.get(id)?.leafId ?? (id === "scroll-send" ? "d399" : null), pending: false } });
const tallDiagram = "```mermaid\ngraph TD\n" + Array.from({ length: 24 }, (_, i) => `N${i}[Step ${i}] --> N${i + 1}[Step ${i + 1}]`).join("\n") + "\n```";
for (const [id, prefix] of [["scroll-mixed", "m"], ["scroll-reading", "p"], ["scroll-live", "l"], ["scroll-map", "n"], ["scroll-navigation", "v"], ["scroll-nested", "z"], ["scroll-folded", "f"], ["scroll-switch", "s"], ["scroll-opening", "o"], ["scroll-fast", "q"], ["scroll-send", "d"], ["scroll-complete", "c"], ["scroll-tail", "t"]]) {
  const entries = Array.from({ length: ["scroll-live", "scroll-switch"].includes(id) ? 3 : ["scroll-navigation", "scroll-opening"].includes(id) ? 12 : id === "scroll-tail" ? 320 : id === "scroll-folded" ? 300 : 400 }, (_, i) => {
    let message;
    if (id === "scroll-switch") message = i % 2 ? answer("Switch destination answer") : { role: "user", content: "Warm switch destination" };
    else if (id === "scroll-tail" && [0, 167].includes(i)) message = { role: "user", content: i === 167 ? "Latest long-tool-turn question" : "Earlier long-tool-turn question" };
    else if (id === "scroll-tail" && i === 166) message = answer("Earlier completed answer");
    else if (["scroll-fast", "scroll-send"].includes(id)) message = i % 2 ? answer(paragraphs(`Progressive answer ${i}`, 1)) : { role: "user", content: `Progressive question ${i}` };
    else if (id === "scroll-complete") message = i % 2 ? answer(paragraphs(`Complete answer ${i}`, i === 399 ? 180 : 1) + (i === 399 ? "\n\ncomplete-body-final-marker" : "")) : { role: "user", content: `Complete question ${i}` };
    else if (id === "scroll-folded" && [0, 250].includes(i)) message = { role: "user", content: i === 0 ? "Folded history source" : paragraphs("Visible reading anchor", 24) };
    else if (id === "scroll-folded" && i === 299) message = answer(paragraphs(`Folded answer ${i}`, 4));
    else if (["scroll-reading", "scroll-live", "scroll-navigation", "scroll-nested", "scroll-opening"].includes(id)) {
      const controls = id === "scroll-live" ? "" : `# Reading ${i}\n\n[Reading link ${i}](#reading-fixture)\n\n`;
      const code = id === "scroll-reading" && i === 381 ? "```text\nKeyboard fixture\n```\n\n" : "";
      const diagram = id === "scroll-nested" && i === 381 ? tallDiagram + "\n\n" : "";
      message = i % 2 ? answer(controls + code + diagram + paragraphs(`Reading ${i}`, 4)) : { role: "user", content: id === "scroll-reading" && i === 0 ? "History reading source" : `Question ${i}` };
    }
    else if (!["scroll-folded", "scroll-tail"].includes(id) && (id === "scroll-map" ? [0, 220] : [0, 220, 390]).includes(i)) message = { role: "user", content: `Mixed question ${i}` };
    else if (!["scroll-folded", "scroll-tail"].includes(id) && (i === 365 || i === 399)) message = answer(paragraphs(`Mixed answer ${i}`, 18));
    else if (i % 2) message = { ...answer(""), stopReason: "toolUse", content: [{ type: "toolCall", id: `call-${i}`, name: "read", arguments: { path: "fixture.txt" } }] };
    else message = { role: "toolResult", toolCallId: `call-${i - 1}`, toolName: "read", content: [{ type: "text", text: "fixture output" }], isError: false };
    return { type: "message", id: `${prefix}${i}`, parentId: i ? `${prefix}${i - 1}` : null, timestamp,
      message: { ...message, timestamp: Date.parse(timestamp) + i } };
  });
  await writeFile(join(sessions, `${timestamp.replaceAll(":", "-")}_${id}.jsonl`),
    [{ type: "session", version: 3, id, timestamp, cwd: project }, ...entries].map(JSON.stringify).join("\n") + "\n");
}

await writeFile(sessionFile("shared-reader"), [
  { type: "session", version: 3, id: "shared-reader", timestamp, cwd: project },
  { type: "message", id: "shared-question", parentId: null, timestamp, message: { role: "user", content: "Shared Reader fixture" } },
  { type: "message", id: "shared-answer", parentId: "shared-question", timestamp, message: answer("Shared persisted answer") },
].map(JSON.stringify).join("\n") + "\n");

const freePort = async () => {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
};
const port = await freePort(), upstream = `http://127.0.0.1:${port}`;
const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PI_WEB_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1",
  PI_WEB_SESSION_ACTIVITY_CONFIG: JSON.stringify({ device: { id: "scroll-fixture", name: "Scroll fixture" }, peers: [] }) };
delete env.XDG_CONFIG_HOME; delete env.XDG_STATE_HOME;
const server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)],
  { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { serverLog = (serverLog + chunk).slice(-12000); });
const streams = new Map();
let writerServer, writerBase, writerLog = "";
const proxy = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, upstream);
    const json = value => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/api/agent/new" && req.method === "POST") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const command = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(command.type, "ensure_session", "the fixture only admits creation without generation");
      assert.equal(command.cwd, project, "the fixture must not create sessions outside its isolated project");
      await writeFile(sessionFile("scroll-new"), JSON.stringify({ type: "session", version: 3, id: "scroll-new", timestamp, cwd: project }) + "\n");
      return json({ sessionId: "scroll-new", ...sendState("scroll-new") });
    }
    const fake = url.pathname.match(/^\/api\/(agent|sessions)\/(scroll-send|scroll-new)(?:\/(state|lease))?$/);
    if (fake) {
      const [, owner, id, action] = fake;
      if (owner === "sessions" && action === "state") return json({ running: true, state: sendState(id) });
      if (owner === "agent" && req.method === "GET") return json({ running: true, state: sendState(id) });
      if (owner === "agent" && req.method === "POST") {
        if (action === "lease") return json({ success: true });
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const command = JSON.parse(Buffer.concat(chunks).toString());
        if (command.type === "prompt") {
          assert.equal(pendingPrompts.has(id), false, "a prompt must be admitted exactly once");
          pendingPrompts.set(id, command.message);
          liveRuns.set(id, { running: true, leafId: sendState(id).branchPosition.leafId });
          return json({ success: true, data: {} });
        }
        if (command.type === "get_state" || command.type === "initialize_runtime") return json({ success: true, data: sendState(id) });
        if (command.type === "get_tools" || command.type === "get_commands") return json({ success: true, data: [] });
        if (command.type === "get_unattended") return json({ success: true, data: { enabled: false } });
        res.writeHead(403); res.end("Unexpected fixture command"); return;
      }
    }
    if (/^\/api\/agent\/scroll-[^/]+\/events$/.test(url.pathname)) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const id = url.pathname.split("/")[3], running = id === "scroll-live" ? liveRunning : Boolean(liveRuns.get(id)?.running);
      res.write(`data: ${JSON.stringify({ type: "connected", sessionId: id, isStreaming: running, pendingExtensionUiIds: [] })}\n\n`);
      streams.set(res, id); res.on("close", () => streams.delete(res)); return;
    }
    if (/^\/api\/sessions\/scroll-[^/]+\/state$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3], run = id === "scroll-live" ? { running: liveRunning, leafId: liveLeafId } : liveRuns.get(id);
      const running = Boolean(run?.running);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ running, state: running ? { isStreaming: true, isPromptRunning: true, autoCompactionEnabled: true,
        branchPosition: { leafId: run.leafId, pending: false } } : null })); return;
    }
    let commandBody;
    if (url.pathname.startsWith("/api/agent/") && req.method === "POST") {
      if (url.pathname === "/api/agent/shared-reader") {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        commandBody = Buffer.concat(chunks);
        const command = JSON.parse(commandBody.toString());
        const read = ["get_unattended", "get_tools", "get_commands", "get_state"].includes(command.type);
        const disable = command.type === "set_unattended" && command.enabled === false;
        if (!read && !disable && command.type !== "initialize_runtime") { res.writeHead(403); res.end("Generation forbidden"); return; }
      } else {
        res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "Generation is not allowed in the scroll fixture" })); return;
      }
    }
    const chunks = []; if (!commandBody) for await (const chunk of req) chunks.push(chunk);
    const body = commandBody ?? Buffer.concat(chunks);
    const response = await fetch(url, { method: req.method, headers: { ...req.headers, host: url.host }, ...(body.length ? { body } : {}), redirect: "manual" });
    res.writeHead(response.status, Object.fromEntries([...response.headers].filter(([key]) => !["content-length", "content-encoding", "transfer-encoding"].includes(key))));
    if (response.body) { const stream = Readable.fromWeb(response.body); stream.on("error", () => res.destroy()); res.on("close", () => stream.destroy()); stream.pipe(res); }
    else res.end();
  } catch (error) { res.destroy(error); }
});
let browser;
const failures = [];
const frames = (page, count = 3) => page.evaluate(count => new Promise(resolve => {
  let frame = 0; const next = () => ++frame >= count ? resolve() : requestAnimationFrame(next); requestAnimationFrame(next);
}), count);
const metrics = page => page.locator(".chat-transcript").evaluate(c => ({ top: c.scrollTop, height: c.scrollHeight, client: c.clientHeight }));
const publish = (id, event) => {
  let sent = 0;
  for (const [stream, sessionId] of streams) if (id === sessionId) { stream.write(`data: ${JSON.stringify(event)}\n\n`); sent++; }
  assert.equal(sent, 1, "one browser SSE subscription must receive the event");
};
const offsetOf = locator => locator.evaluate(el => el.getBoundingClientRect().top - el.closest(".chat-transcript").getBoundingClientRect().top);

async function open(id, viewport, preference = "answer-bottom") {
  const context = await browser.newContext({ viewport, locale: "en-US", hasTouch: viewport.width < 600 });
  await context.addInitScript(({ preference, traceOpening }) => {
    localStorage.setItem("pi-session-open-scroll", preference);
    window.__openingDisplay = [];
    if (traceOpening) {
      const sample = () => {
        const c = document.querySelector('.chat-transcript');
        const row = c?.querySelector('[data-chat-message-row]');
        if (row && getComputedStyle(row).visibility !== 'hidden') {
          window.__openingDisplay.push({ top: c.scrollTop, bottomGap: c.scrollHeight - c.clientHeight - c.scrollTop });
        }
        if (window.__openingDisplay.length < 10) requestAnimationFrame(sample);
      }; requestAnimationFrame(sample);
    }
    window.__chatScrollWrites = [];
    const scrollTo = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function (...args) {
      if (this.matches?.(".chat-transcript")) window.__chatScrollWrites.push({ time: performance.now(), top: this.scrollTop, args });
      return scrollTo.apply(this, args);
    };
  }, { preference, traceOpening: id === "scroll-opening" });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const requests = [], traffic = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) traffic.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: request.method() });
    const prefix = `${base}/api/sessions/${id}/history?`;
    if (!request.url().startsWith(prefix)) return;
    const query = new URLSearchParams(request.url().slice(prefix.length));
    if (query.get("mode") === "window") requests.push(query);
  });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(`${base}/?session=${id}`);
    await page.locator(".chat-transcript [data-chat-message-row][data-entry-id]").first().waitFor({ state: "attached" });
    await frames(page, 60);
    const rect = await page.locator(".chat-transcript").boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { context, page, requests, traffic };
  } catch (error) {
    console.error(JSON.stringify({ open: id, url: page.url(), errors, ui: (await page.locator("body").innerText()).slice(0, 1800) }));
    await context.close(); throw error;
  }
}

async function selectFixture(page, viewport, title) {
  const toggle = page.getByRole("button", { name: "Show sessions", exact: true });
  if (viewport.width < 600 && await toggle.count()) await toggle.click();
  await page.locator('button[data-session-open]').filter({ hasText: title }).first().click();
}

async function traceTranscript(page, marker = null) {
  await page.evaluate(marker => {
    window.__transcriptFrames = [];
    window.__traceTranscript = true;
    const sample = () => {
      if (!window.__traceTranscript) return;
      const c = document.querySelector(".chat-transcript");
      const bounds = c?.getBoundingClientRect();
      const rows = c ? [...c.querySelectorAll("[data-chat-message-row][data-entry-id]")] : [];
      const first = rows.find(row => row.getBoundingClientRect().bottom > bounds.top + 1);
      window.__transcriptFrames.push({ id: first?.dataset.entryId ?? null, offset: first ? first.getBoundingClientRect().top - bounds.top : null,
        top: c?.scrollTop ?? null, bottomGap: c ? c.scrollHeight - c.clientHeight - c.scrollTop : null, rows: rows.length, occurrences: marker && c ? [...c.querySelectorAll("[data-chat-message-row]")].filter(row => row.textContent.includes(marker)).length : null });
      requestAnimationFrame(sample);
    }; requestAnimationFrame(sample);
  }, marker);
}
const stopTrace = page => page.evaluate(() => { window.__traceTranscript = false; return window.__transcriptFrames; });
const firstVisible = page => page.locator(".chat-transcript").evaluate(c => {
  const top = c.getBoundingClientRect().top;
  const row = [...c.querySelectorAll("[data-chat-message-row][data-entry-id]")].find(row => row.getBoundingClientRect().bottom > top + 1);
  if (!row) throw new Error("No visible row in fixture");
  return { id: row.dataset.entryId, offset: row.getBoundingClientRect().top - top };
});

let base;
try {
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 60000;
    const probe = async () => {
      if (server.exitCode !== null) return reject(new Error(`Server exited: ${serverLog}`));
      if ((await fetch(`${upstream}/api/sessions`).catch(() => null))?.ok) return resolve();
      if (Date.now() > deadline) return reject(new Error(`Server startup timed out: ${serverLog}`));
      setTimeout(probe, 100);
    }; void probe();
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening"); base = `http://127.0.0.1:${proxy.address().port}`;
  // Playwright otherwise hides the native scrollbar, leaving a non-interactive gutter.
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });

  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    for (const [name, test] of [
      ["R-a append while paging preserves the visible line without clearing", async (name) => {
        const path = sessionFile("scroll-reading"), original = await readFile(path, "utf8");
        liveRuns.set("scroll-reading", { running: true, leafId: "p399" });
        const { context, page } = await open("scroll-reading", viewport);
        let release; const held = new Promise(resolve => { release = resolve; });
        try {
          await page.route("**/api/sessions/scroll-reading/history?*", async route => {
            const q = new URL(route.request().url()).searchParams;
            if (q.get("mode") === "window" && q.has("before")) { await held; await route.continue(); }
            else await route.continue();
          });
          const pending = page.waitForRequest(request => new URL(request.url()).pathname.endsWith("/scroll-reading/history") && new URL(request.url()).searchParams.has("before"));
          await page.locator(".chat-transcript").evaluate(c => { c.scrollTop = 280; }); await page.mouse.wheel(0, -80);
          await pending; await frames(page, 12);
          const anchor = await firstVisible(page); await traceTranscript(page);
          await appendFile(path, JSON.stringify({ type: "message", id: "p400", parentId: "p399", timestamp, message: { role: "user", content: "Appended while paging" } }) + "\n");
          liveRuns.set("scroll-reading", { running: true, leafId: "p400" });
          const response = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/scroll-reading/history") && new URL(response.url()).searchParams.has("before"));
          release(); const received = await response; await frames(page, 45);
          const samples = await stopTrace(page);
          assert.equal(received.status(), 200, `append invalidated a stable entry cursor; frames=${JSON.stringify(samples.slice(-8))}`);
          assert.ok(samples.every(sample => sample.rows > 0 && sample.id === anchor.id && Math.abs(sample.offset - anchor.offset) < 2),
            `a data commit moved or blanked the visible line: ${JSON.stringify(samples.filter(sample => sample.id !== anchor.id || Math.abs(sample.offset - anchor.offset) >= 2).slice(0, 8))}`);
          console.log(JSON.stringify({ name, width: viewport.width, samples: samples.length, result: "passed" }));
        } finally { release(); await context.close(); await writeFile(path, original); liveRuns.delete("scroll-reading"); }
      }],
      ["R-b fast upward reading retains loaded content and never blanks", async (name) => {
        const { context, page, requests } = await open("scroll-fast", viewport);
        try {
          const initial = await page.locator('.chat-transcript [data-chat-message-row][data-entry-id]').evaluateAll(rows => rows.map(row => row.dataset.entryId));
          assert.ok(initial.length < 400, "cold opening must not fetch all history");
          await page.locator(".chat-transcript").evaluate(c => { c.scrollTop = 250; }); await frames(page, 6);
          await traceTranscript(page);
          for (let step = 0; step < 20; step++) { await page.mouse.wheel(0, -500); await frames(page, 18); }
          await frames(page, 30);
          const samples = await stopTrace(page), loaded = await page.locator('.chat-transcript [data-chat-message-row][data-entry-id]').evaluateAll(rows => rows.map(row => row.dataset.entryId));
          assert.ok(requests.some(q => q.has("before")), "fast input must exercise a real prepend");
          assert.ok(initial.every(id => loaded.includes(id)), `reading evicted loaded rows: ${initial.filter(id => !loaded.includes(id)).join(",")}`);
          assert.ok(samples.every(sample => sample.rows > 0), "fast reading must not blank the transcript");
          console.log(JSON.stringify({ name, width: viewport.width, initial: initial.length, loaded: loaded.length, samples: samples.length, result: "passed" }));
        } finally { await context.close(); }
      }],
      ["R-c returning opens latest before delayed metadata returns", async (name) => {
        const { context, page } = await open("scroll-reading", viewport);
        let release; const held = new Promise(resolve => { release = resolve; });
        try {
          await page.mouse.wheel(0, -600); await frames(page, 30);
          const anchor = await firstVisible(page);
          await selectFixture(page, viewport, "Warm switch destination");
          await page.locator('.chat-transcript [data-entry-id="s0"]').waitFor({ state: "attached" }); await frames(page, 10);
          let delayed = 0;
          await page.route("**/api/sessions/scroll-reading?*", async route => {
            if (new URL(route.request().url()).searchParams.has("metadataOnly")) { delayed++; await held; }
            await route.continue();
          });
          await selectFixture(page, viewport, "History reading source"); await frames(page, 2); await traceTranscript(page); await frames(page, 30);
          const samples = await stopTrace(page);
          assert.ok(delayed > 0, "the metadata response must really be outstanding");
          assert.ok(samples.length > 0 && samples.every(sample => sample.rows > 0 && Math.abs(sample.bottomGap) < 2),
            `return must show latest, not the old reading location or a metadata blank: ${JSON.stringify(samples.slice(0, 8))}`);
          assert.notEqual(samples[0].id, anchor.id, "the fixture must distinguish latest from the old reading position");
          release(); await frames(page, 45);
          const latest = await metrics(page);
          assert.ok(Math.abs(latest.height - latest.client - latest.top) < 2, "metadata must not restore the abandoned reading position");
          console.log(JSON.stringify({ name, width: viewport.width, result: "passed" }));
        } finally { release(); await context.close(); }
      }],
      ["R-d sent messages survive persistence promotion and settle while reading", async (name) => {
        for (const fresh of [false, true]) {
          const id = fresh ? "scroll-new" : "scroll-send", path = sessionFile("scroll-send"), original = await readFile(path, "utf8");
          const { context, page } = await open("scroll-send", viewport);
          let release; const held = new Promise(resolve => { release = resolve; });
          try {
            if (fresh) {
              const toggle = page.getByRole("button", { name: "Show sessions", exact: true });
              if (viewport.width < 600 && await toggle.count()) await toggle.click();
              await page.getByTitle(`New session in ${project}`, { exact: true }).first().click(); await frames(page, 15);
            }
            const marker = `prompt-continuity-${fresh ? "new" : "existing"}-${viewport.width}`;
            const admitted = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/agent/${id}` && response.request().postDataJSON()?.type === "prompt");
            await page.locator(".chat-input-textarea").fill(marker); await page.getByRole("button", { name: "Send", exact: true }).click();
            await admitted;
            assert.equal(pendingPrompts.get(id), marker, "the browser must submit to the isolated fake agent");
            await traceTranscript(page, marker); await frames(page, 5);
            await page.route(`**/api/sessions/${id}/history?*`, async route => { await held; await route.continue(); });
            const message = { role: "user", content: marker, timestamp: Date.now() }, parentId = fresh ? null : "d399";
            publish(id, { type: "agent_start" }); publish(id, { type: "message_start", message }); await frames(page, 5);
            await appendFile(sessionFile(id), JSON.stringify({ type: "message", id: "sent-user", parentId, timestamp, message }) + "\n");
            liveRuns.set(id, { running: true, leafId: "sent-user" });
            publish(id, { type: "message_end", entryId: "sent-user", message }); await frames(page, 15);
            const reply = { ...answer("settled-answer-final-marker"), timestamp: Date.now() + 1 };
            publish(id, { type: "message_start", message: reply }); await frames(page, 10);
            await page.mouse.wheel(0, -500); await frames(page, 20);
            await appendFile(sessionFile(id), JSON.stringify({ type: "message", id: "sent-answer", parentId: "sent-user", timestamp, message: reply }) + "\n");
            liveRuns.set(id, { running: false, leafId: "sent-answer" });
            publish(id, { type: "message_end", entryId: "sent-answer", message: reply });
            publish(id, { type: "agent_end", messages: [reply] }); publish(id, { type: "agent_settled" }); await frames(page, 30);
            const samples = await stopTrace(page);
            assert.ok(samples.every(sample => sample.occurrences === 1), `message disappeared or duplicated: ${JSON.stringify(samples.filter(sample => sample.occurrences !== 1).slice(0, 8))}`);
            assert.equal(await page.locator(".chat-transcript").getByText("settled-answer-final-marker", { exact: true }).count(), 1,
              "the settled reply must remain without a history reload");
            release(); await frames(page, 45);
            assert.equal(await page.locator(".chat-transcript").getByText(marker, { exact: true }).count(), 1);
            assert.equal(await page.locator(".chat-transcript").getByText("settled-answer-final-marker", { exact: true }).count(), 1);
            pendingPrompts.delete(id);
            const secondMarker = `${marker}-second-turn`;
            const secondAdmission = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/agent/${id}` && response.request().postDataJSON()?.type === "prompt");
            await page.locator(".chat-input-textarea").fill(secondMarker); await page.getByRole("button", { name: "Send", exact: true }).click(); await secondAdmission;
            await traceTranscript(page, secondMarker); await frames(page, 8);
            const nextUser = { role: "user", content: secondMarker, timestamp: Date.now() };
            publish(id, { type: "agent_start" }); publish(id, { type: "message_start", message: nextUser }); await frames(page, 6);
            await appendFile(sessionFile(id), JSON.stringify({ type: "message", id: "second-user", parentId: "sent-answer", timestamp, message: nextUser }) + "\n");
            liveRuns.set(id, { running: true, leafId: "second-user" });
            publish(id, { type: "message_end", entryId: "second-user", message: nextUser }); await frames(page, 60);
            const nextReply = { ...answer("second-turn-answer-marker"), timestamp: Date.now() + 1 };
            publish(id, { type: "message_start", message: nextReply }); await frames(page, 30);
            await appendFile(sessionFile(id), JSON.stringify({ type: "message", id: "second-answer", parentId: "second-user", timestamp, message: nextReply }) + "\n");
            liveRuns.set(id, { running: false, leafId: "second-answer" });
            for (const event of [{ type: "message_end", entryId: "second-answer", message: nextReply }, { type: "agent_end", messages: [nextReply] }, { type: "agent_settled" }]) publish(id, event);
            await frames(page, 45);
            const secondSamples = await stopTrace(page);
            assert.ok(secondSamples.length > 100 && secondSamples.every(sample => sample.occurrences === 1),
              `a follow-up after settle disappeared without switching sessions: ${JSON.stringify(secondSamples.filter(sample => sample.occurrences !== 1).slice(0, 8))}`);
            assert.equal(await page.locator(".chat-transcript").getByText("second-turn-answer-marker", { exact: true }).count(), 1);
            console.log(JSON.stringify({ name, width: viewport.width, fresh, samples: samples.length, secondSamples: secondSamples.length, result: "passed" }));
          } catch (error) { failures.push(`${viewport.width}px ${name}/${fresh ? "new" : "existing"}: ${error.stack ?? error}; ui=${(await page.locator("body").innerText()).slice(-1400)}`); console.error(`FAIL: ${failures.at(-1)}`); }
          finally { release(); await context.close(); pendingPrompts.delete(id); liveRuns.delete(id); await writeFile(path, original); }
        }
      }],
      ["R-e switching away unmounts a running transcript without background reads", async (name) => {
        liveRuns.set("scroll-reading", { running: true, leafId: "p399" });
        const { context, page, traffic } = await open("scroll-reading", viewport);
        try {
          traffic.length = 0;
          await selectFixture(page, viewport, "Warm switch destination");
          await page.locator('.chat-transcript [data-entry-id="s0"]').waitFor({ state: "attached" }); await frames(page, 60);
          assert.equal(await page.locator(".chat-transcript").count(), 1, "a hidden running ChatWindow must not remain mounted");
          assert.equal(traffic.filter(r => r.path === "/api/sessions/scroll-reading/history" || r.path === "/api/sessions/scroll-reading" && r.query.metadataOnly).length, 0,
            "switching away must not mount and reload the departed session");
          console.log(JSON.stringify({ name, width: viewport.width, result: "passed" }));
        } finally { await context.close(); liveRuns.delete("scroll-reading"); }
      }],
      ["R-f cold opening starts each transcript read once", async (name) => {
        const { context, traffic } = await open("scroll-reading", viewport);
        try {
          for (const mode of ["window", "index"]) assert.equal(traffic.filter(r => r.path === "/api/sessions/scroll-reading/history" && r.query.mode === mode).length, 1, `${mode} must start once`);
          assert.equal(traffic.filter(r => r.path === "/api/sessions/scroll-reading" && r.query.metadataOnly).length, 1, "metadata must start once");
          console.log(JSON.stringify({ name, width: viewport.width, result: "passed" }));
        } finally { await context.close(); }
      }],
      ["R-g long messages display complete text without manual segments", async (name) => {
        const { context, page } = await open("scroll-complete", viewport);
        try {
          const row = page.locator('.chat-transcript [data-chat-message-row][data-entry-id="c399"]');
          await row.getByText("complete-body-final-marker", { exact: true }).waitFor({ state: "attached" });
          assert.ok((await row.innerText()).includes("Complete answer 399 paragraph 0"), "complete means both the beginning and the end are available");
          assert.equal(await page.locator(".chat-transcript").getByRole("button", { name: /Read current segment|Previous segment|Next segment/ }).count(), 0);
          console.log(JSON.stringify({ name, width: viewport.width, result: "passed" }));
        } finally { await context.close(); }
      }],
      ["R-h opening a long running tool turn includes its question and latest minimap node", async (name) => {
        liveRuns.set("scroll-tail", { running: true, leafId: "t319" });
        const { context, page, requests } = await open("scroll-tail", viewport);
        try {
          assert.equal(await page.locator('.chat-transcript [data-chat-message-row][data-entry-id="t167"]').count(), 1,
            "the latest question must not fall outside a tail page of tool messages");
          assert.equal(await page.locator(".chat-transcript").getByText("Latest long-tool-turn question", { exact: true }).count(), 1);
          assert.ok((await page.locator(".chat-transcript").innerText()).includes("Process details"), "a running tool turn must show its process summary");
          if (viewport.width >= 600) assert.equal(await page.locator('[data-minimap-node-index="1"]').count(), 1, "the latest question must be navigable without expanding full history");
          assert.equal(requests.filter(q => q.get("mode") === "window" && !q.has("before") && !q.has("after")).length, 1);
          assert.equal(requests.filter(q => q.has("before")).length, 0, "opening a long tool turn must not drain raw process pages");
          console.log(JSON.stringify({ name, width: viewport.width, result: "passed" }));
        } finally { await context.close(); liveRuns.delete("scroll-tail"); }
      }],
      ["R-i another Reader reads fresh history without acquiring a writer", async (name) => {
        if (!writerServer) {
          const port = await freePort(); writerBase = `http://127.0.0.1:${port}`;
          writerServer = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)],
            { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
          for (const stream of [writerServer.stdout, writerServer.stderr]) stream.on("data", chunk => { writerLog = (writerLog + chunk).slice(-12000); });
          const deadline = Date.now() + 60000;
          while (!(await fetch(`${writerBase}/api/sessions`).catch(() => null))?.ok) {
            assert.equal(writerServer.exitCode, null, writerLog); assert.ok(Date.now() < deadline, writerLog);
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        if (!(await (await fetch(`${writerBase}/api/agent/shared-reader`)).json()).running) {
          const start = await fetch(`${writerBase}/api/agent/shared-reader`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "set_unattended", enabled: false }) });
          assert.equal(start.status, 200, `the non-generating writer initialization failed: ${await start.text()}`);
        }
        assert.equal((await (await fetch(`${writerBase}/api/agent/shared-reader`)).json()).running, true, "process A must own a real runtime");
        const { context, page } = await open("shared-reader", viewport);
        try {
          assert.equal((await (await fetch(`${upstream}/api/agent/shared-reader`)).json()).running, false,
            "opening in process B must not create a second runtime");
          const records = (await readFile(sessionFile("shared-reader"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
          const question = `shared-user-${viewport.width}`, reply = `shared-reply-${viewport.width}`;
          await appendFile(sessionFile("shared-reader"), [
            { type: "message", id: question, parentId: records.at(-1).id, timestamp: new Date().toISOString(), message: { role: "user", content: `External question ${viewport.width}` } },
            { type: "message", id: reply, parentId: question, timestamp: new Date().toISOString(), message: answer(`External answer ${viewport.width}`) },
          ].map(JSON.stringify).join("\n") + "\n");
          await page.evaluate(() => window.dispatchEvent(new Event("focus")));
          await page.locator(`.chat-transcript [data-chat-message-row][data-entry-id="${reply}"]`).waitFor({ state: "attached" });
          assert.equal(await page.locator(`.chat-transcript [data-chat-message-row][data-entry-id="${question}"]`).count(), 1,
            "another process's persisted question must arrive without local SSE or manual history expansion");
          const refused = await fetch(`${upstream}/api/agent/shared-reader`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "set_unattended", enabled: false }) });
          const conflict = await refused.json();
          assert.equal(refused.status, 409, "process B must not become a second writer even for a non-generating setting write");
          assert.equal(typeof conflict.code, "string", "a write conflict needs a stable distinguishable code");
          assert.equal((await (await fetch(`${upstream}/api/agent/shared-reader`)).json()).running, false);
          console.log(JSON.stringify({ name, width: viewport.width, conflict: conflict.code, result: "passed" }));
        } finally { await context.close(); }
      }],
      ["R-k a new question remains visible when sent immediately after settle", async (name) => {
        const id = "scroll-send", path = sessionFile(id), original = await readFile(path, "utf8");
        liveRuns.set(id, { running: true, leafId: "d399" });
        const { context, page } = await open(id, viewport);
        try {
          const settled = { ...answer("previous-run-finished-marker"), timestamp: Date.now() };
          publish(id, { type: "agent_start" }); publish(id, { type: "message_start", message: settled });
          await appendFile(path, JSON.stringify({ type: "message", id: "previous-final", parentId: "d399", timestamp, message: settled }) + "\n");
          liveRuns.set(id, { running: false, leafId: "previous-final" });
          for (const event of [{ type: "message_end", entryId: "previous-final", message: settled }, { type: "agent_end", messages: [settled] }, { type: "agent_settled" }]) publish(id, event);
          await frames(page, 30);
          const marker = `post-settle-question-${viewport.width}`;
          const admitted = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/agent/${id}` && response.request().postDataJSON()?.type === "prompt");
          await page.locator(".chat-input-textarea").fill(marker); await page.getByRole("button", { name: "Send", exact: true }).click(); await admitted;
          await traceTranscript(page, marker); await frames(page, 6);
          const message = { role: "user", content: marker, timestamp: Date.now() };
          publish(id, { type: "agent_start" }); publish(id, { type: "message_start", message });
          await appendFile(path, JSON.stringify({ type: "message", id: "post-settle-user", parentId: "previous-final", timestamp, message }) + "\n");
          liveRuns.set(id, { running: true, leafId: "post-settle-user" });
          publish(id, { type: "message_end", entryId: "post-settle-user", message }); await frames(page, 60);
          const reply = { ...answer("post-settle-stream-marker"), timestamp: Date.now() + 1 };
          publish(id, { type: "message_start", message: reply }); await frames(page, 30);
          await appendFile(path, JSON.stringify({ type: "message", id: "post-settle-answer", parentId: "post-settle-user", timestamp, message: reply }) + "\n");
          liveRuns.set(id, { running: false, leafId: "post-settle-answer" });
          for (const event of [{ type: "message_end", entryId: "post-settle-answer", message: reply }, { type: "agent_end", messages: [reply] }, { type: "agent_settled" }]) publish(id, event);
          await frames(page, 30);
          const samples = await stopTrace(page);
          assert.ok(samples.length > 100 && samples.every(sample => sample.occurrences === 1),
            `post-settle sending lost the question until reopening: ${JSON.stringify(samples.filter(sample => sample.occurrences !== 1).slice(0, 5))}`);
          assert.equal(await page.locator(".chat-transcript").getByText("post-settle-stream-marker", { exact: true }).count(), 1);
          console.log(JSON.stringify({ name, width: viewport.width, samples: samples.length, result: "passed" }));
        } finally { await context.close(); pendingPrompts.delete(id); liveRuns.delete(id); await writeFile(path, original); }
      }],
      ["R-j same-process tool events and settle never clear the transcript", async (name) => {
        const path = sessionFile("scroll-reading"), original = await readFile(path, "utf8");
        liveRuns.set("scroll-reading", { running: true, leafId: "p399" });
        const { context, page } = await open("scroll-reading", viewport);
        try {
          const question = { role: "user", content: "Continuous tool turn question", timestamp: Date.now() };
          publish("scroll-reading", { type: "agent_start" }); publish("scroll-reading", { type: "message_start", message: question });
          await appendFile(path, JSON.stringify({ type: "message", id: "settle-question", parentId: "p399", timestamp, message: question }) + "\n");
          liveRuns.set("scroll-reading", { running: true, leafId: "settle-question" });
          publish("scroll-reading", { type: "message_end", entryId: "settle-question", message: question }); await frames(page, 30);
          const initialIds = await page.locator('.chat-transcript [data-chat-message-row][data-entry-id]').evaluateAll(rows => rows.map(row => row.dataset.entryId));
          await page.locator(".chat-transcript").evaluate(c => {
            window.__retainedFrames = []; window.__retainTrace = true;
            const sample = () => {
              if (!window.__retainTrace) return;
              const ids = [...c.querySelectorAll('[data-chat-message-row][data-entry-id]')].map(row => row.dataset.entryId);
              window.__retainedFrames.push({ ids, top: c.scrollTop, gap: c.scrollHeight - c.clientHeight - c.scrollTop });
              requestAnimationFrame(sample);
            }; requestAnimationFrame(sample);
          });
          let parentId = "settle-question";
          for (let i = 0; i < 8; i++) {
            const tool = i % 2 === 0;
            const message = tool ? { ...answer(""), timestamp: Date.now(), stopReason: "toolUse", content: [{ type: "toolCall", id: `settle-tool-${i}`, name: "read", arguments: { path: "fixture.txt" } }] }
              : { role: "toolResult", timestamp: Date.now(), toolCallId: `settle-tool-${i - 1}`, toolName: "read", content: [{ type: "text", text: `settle output ${i}` }], isError: false };
            const entryId = `settle-entry-${i}`;
            if (tool) publish("scroll-reading", { type: "message_start", message });
            await appendFile(path, JSON.stringify({ type: "message", id: entryId, parentId, timestamp, message }) + "\n");
            parentId = entryId; liveRuns.set("scroll-reading", { running: true, leafId: parentId });
            publish("scroll-reading", { type: "message_end", entryId, message }); await frames(page, 60);
          }
          const final = { ...answer(paragraphs("Complete settlement answer", 8)), timestamp: Date.now() };
          publish("scroll-reading", { type: "message_start", message: final }); await frames(page, 20);
          await appendFile(path, JSON.stringify({ type: "message", id: "settle-final", parentId, timestamp, message: final }) + "\n");
          liveRuns.set("scroll-reading", { running: false, leafId: "settle-final" });
          for (const event of [{ type: "message_end", entryId: "settle-final", message: final }, { type: "agent_end", messages: [final] }, { type: "agent_settled" }, { type: "prompt_done" }]) publish("scroll-reading", event);
          await frames(page, 60);
          const samples = await page.evaluate(() => { window.__retainTrace = false; return window.__retainedFrames; });
          assert.ok(samples.length > 450 && samples.every(sample => sample.ids.length > 0 && initialIds.every(id => sample.ids.includes(id))),
            `settlement cleared or replaced displayed history: ${JSON.stringify(samples.filter(sample => !initialIds.every(id => sample.ids.includes(id))).slice(0, 5))}`);
          assert.ok(samples.every(sample => sample.top > 0 && Math.abs(sample.gap) < 2),
            `followed transcript jumped away from the tail: ${JSON.stringify(samples.filter(sample => sample.top <= 0 || Math.abs(sample.gap) >= 2).slice(0, 5))}`);
          assert.equal(await page.locator('.chat-transcript [data-entry-id="settle-question"]').count(), 1, "latest question remains after settle");
          assert.equal(await page.locator('.chat-transcript [data-entry-id="settle-final"]').count(), 1, "latest answer remains after settle");
          console.log(JSON.stringify({ name, width: viewport.width, samples: samples.length, result: "passed" }));
        } finally { await context.close(); await writeFile(path, original); liveRuns.delete("scroll-reading"); }
      }],
      ["no reciprocal paging or bottom pull without input", async (name) => {
        const { context, page, requests } = await open("scroll-reading", viewport);
        try {
          for (let step = 0; step < 12; step++) {
            await page.mouse.wheel(0, -550); await frames(page, 6);
            if (requests.some(q => q.has("after")) || requests.filter(q => q.has("before")).length >= 4) break;
          }
          await frames(page, 60);
          assert.ok(requests.some(q => q.has("before")), "the real history prepend path must run");
          assert.equal(requests.filter(q => q.has("after")).length, 0, "upward reading must not produce reverse pagination");
          const count = requests.length, before = await metrics(page);
          const writes = await page.evaluate(() => window.__chatScrollWrites.length);
          await frames(page, 60);
          assert.equal(requests.length, count, "stopping user input must stop history navigation");
          assert.equal(await page.evaluate(() => window.__chatScrollWrites.length), writes, "idle history must not repeatedly scroll to latest");
          assert.deepEqual(await metrics(page), before, "the idle reading viewport must settle");
          console.log(JSON.stringify({ name, width: viewport.width, requests: count, viewport: before, result: "passed" }));
        } finally { await context.close(); }
      }],
      ["cold opening reveals rows only after its initial target is measured", async (name) => {
        const { context, page } = await open("scroll-opening", viewport);
        try {
          const samples = await page.evaluate(() => window.__openingDisplay);
          assert.ok(samples.length > 0, "the frame probe must observe visible transcript rows");
          assert.ok(samples.every(sample => sample.top > 0 && Math.abs(sample.bottomGap) < 2),
            `the first painted content must already occupy the opening target: ${JSON.stringify(samples)}`);
          console.log(JSON.stringify({ name, width: viewport.width, result: "passed" }));
        } finally { await context.close(); }
      }],
      ["one process expansion reads its complete source without manual segments", async (name) => {
        const { context, page, requests } = await open("scroll-folded", viewport);
        const entries = new Set(), reads = [];
        const onResponse = response => {
          const url = new URL(response.url());
          if (!url.pathname.endsWith("/scroll-folded/history") || !url.searchParams.has("from")) return;
          reads.push(response.json().then(body => { for (const item of body.items ?? []) entries.add(item.entryId); }));
        };
        page.on("response", onResponse);
        try {
          assert.equal(await page.locator('.chat-transcript [data-chat-message-row][data-entry-id="f0"]').count(), 1,
            "a long process must not conceal the question in its own turn");
          assert.equal(requests.filter(q => q.has("before")).length, 0, "two turns must not require draining raw tool pages");
          await page.locator('.chat-transcript button[aria-expanded="false"]').filter({ hasText: "Process details" }).first().click();
          const deadline = Date.now() + 15000;
          while (entries.size < 249 && Date.now() < deadline) { await frames(page, 6); await Promise.all(reads); }
          assert.deepEqual([...entries].sort(), Array.from({ length: 249 }, (_, index) => `f${index + 1}`).sort(),
            "one expansion must fetch every source entry, not a sample or a manual segment");
          assert.equal(await page.locator('.chat-transcript button[aria-expanded="true"]').filter({ hasText: "Process details" }).count(), 1);
          assert.equal(await page.locator(".chat-transcript").getByRole("button", { name: /Read current segment|Previous segment|Next segment/ }).count(), 0);
          const stopped = await metrics(page), count = requests.length;
          await frames(page, 45);
          assert.equal(requests.length, count, "completed expansion must stop requesting content");
          assert.deepEqual(await metrics(page), stopped, "completed expansion must settle its viewport");
          console.log(JSON.stringify({ name, width: viewport.width, entries: entries.size, result: "passed" }));
        } finally { page.off("response", onResponse); await context.close(); await Promise.allSettled(reads); }
      }],
      ["returning follows the current file tail and applies the opening preference", async (name) => {
        const path = sessionFile("scroll-reading"), original = await readFile(path, "utf8");
        for (const preference of ["answer-bottom", "last-question"]) {
          const { context, page } = await open("scroll-reading", viewport, preference);
          try {
            await page.mouse.wheel(0, -800); await frames(page, 20);
            await selectFixture(page, viewport, "Warm switch destination");
            await page.locator('.chat-transcript [data-entry-id="s0"]').waitFor({ state: "attached" });
            await appendFile(path, [
              { type: "message", id: "p400", parentId: "p399", timestamp, message: { role: "user", content: "Question written while away" } },
              { type: "message", id: "p401", parentId: "p400", timestamp, message: answer(paragraphs("Answer written while away", 30)) },
            ].map(JSON.stringify).join("\n") + "\n");
            await selectFixture(page, viewport, "History reading source");
            const question = page.locator('.chat-transcript [data-chat-message-row][data-entry-id="p400"]');
            await question.waitFor({ state: "attached" }); await frames(page, 45);
            assert.equal(await page.locator('.chat-transcript [data-chat-message-row][data-entry-id="p401"]').count(), 1,
              "cache restoration must not pin the old physical leaf");
            if (preference === "answer-bottom") {
              const latest = await metrics(page);
              assert.ok(Math.abs(latest.height - latest.client - latest.top) < 2, "return must reach the new answer bottom");
            } else assert.ok(Math.abs(await offsetOf(question)) < 24, "return must reach the newest question, not the abandoned reading anchor");
            console.log(JSON.stringify({ name, width: viewport.width, preference, result: "passed" }));
          } catch (error) {
            failures.push(`${viewport.width}px ${name}/${preference}: ${error.stack ?? error}`); console.error(`FAIL: ${failures.at(-1)}`);
          } finally { await context.close(); await writeFile(path, original); }
        }
      }],
      ["native reading input pages in its own direction", async (name) => {
        for (const kind of viewport.width < 600 ? ["keyboard", "descendant-link", "descendant-button", "touch", "scrollbar", "scrollbar-track"] : ["keyboard", "descendant-link", "descendant-button", "scrollbar", "scrollbar-track"]) {
          const { context, page, requests } = await open("scroll-reading", viewport);
          let release;
          const held = new Promise(resolve => { release = resolve; });
          try {
            await page.route("**/api/sessions/scroll-reading/history?*", async route => {
              const url = new URL(route.request().url());
              if (url.searchParams.get("mode") === "window" && url.searchParams.has("before")) {
                const response = await route.fetch(); await held; await route.fulfill({ response });
              } else await route.continue();
            });
            await page.locator(".chat-transcript").evaluate((c, kind) => { c.scrollTop = kind === "keyboard" || kind.startsWith("descendant-") ? c.clientHeight + 125 : 450; }, kind);
            await frames(page, 6);
            const count = requests.length, start = await metrics(page);
            await page.locator(".chat-transcript").evaluate(c => {
              window.__nativeInputs = [];
              for (const type of ["pointerdown", "pointermove", "pointerup", "mousedown", "mouseup", "scroll", "scrollend"]) {
                c.addEventListener(type, event => { window.__nativeInputs.push({ type, top: c.scrollTop, x: event.clientX, y: event.clientY }); });
              }
            });
            const pending = page.waitForRequest(request => {
              const url = new URL(request.url()); return url.pathname.endsWith("/scroll-reading/history") && url.searchParams.has("before");
            });
            if (kind === "keyboard" || kind.startsWith("descendant-")) {
              const focus = kind === "keyboard" ? page.locator(".chat-transcript") : kind === "descendant-link"
                ? page.locator('.chat-transcript [data-entry-id="p381"] a').first()
                : page.locator('.chat-transcript [data-entry-id="p381"] .markdown-code-action').first();
              await focus.evaluate(el => el.focus({ preventScroll: true }));
              assert.equal(await focus.evaluate(el => document.activeElement === el), true);
              await page.keyboard.press("PageUp");
            } else if (kind === "touch") {
              const box = await page.locator(".chat-transcript").boundingBox();
              const session = await context.newCDPSession(page);
              const point = { x: box.x + box.width / 2, y: box.y + 200 };
              await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
              await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, y: point.y + 90 }] });
              await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
              await session.detach();
            } else {
              const thumb = await page.locator(".chat-transcript").evaluate(c => {
                const box = c.getBoundingClientRect(), gutter = box.width - c.clientWidth;
                const height = Math.max(20, c.clientHeight * c.clientHeight / c.scrollHeight);
                return { gutter, x: box.right - gutter / 2,
                  y: box.top + c.scrollTop / (c.scrollHeight - c.clientHeight) * (c.clientHeight - height) + height / 2,
                  target: box.top + height / 2, track: box.top + 3 };
              });
              assert.ok(thumb.gutter > 0, "the browser must expose the native scrollbar under test");
              if (kind === "scrollbar-track") await page.mouse.click(thumb.x, thumb.track);
              else {
                await page.mouse.move(thumb.x, thumb.y); await page.mouse.down();
                await page.mouse.move(thumb.x, thumb.target, { steps: 5 }); await page.mouse.up();
              }
            }
            await pending; await frames(page, 20);
            assert.ok((await metrics(page)).top < start.top - 30, `${kind} must actually scroll before the held response applies`);
            release(); await frames(page, 30);
            assert.ok(requests.length > count, `${kind} must reach the real history read`);
            assert.equal(requests.filter(query => query.has("after")).length, 0);
            console.log(JSON.stringify({ name, width: viewport.width, input: kind, result: "passed" }));
          } catch (error) {
            failures.push(`${viewport.width}px ${name}/${kind}: ${error.stack ?? error}; viewport=${JSON.stringify(await metrics(page))}; inputs=${JSON.stringify(await page.evaluate(() => window.__nativeInputs))}`);
            console.error(`FAIL: ${failures.at(-1)}`);
          } finally { release(); await context.close(); }
        }
      }],
      ["a complete minimap is independent of body pagination", async (name) => {
        const { context, page, requests } = await open("scroll-map", viewport);
        try {
          if (viewport.width < 600) {
            assert.equal(await page.locator("[data-minimap-node-index]").count(), 0, "the desktop rail stays absent on narrow screens");
          } else {
            await page.waitForFunction(() => document.querySelectorAll("[data-minimap-node-index]").length === 2);
            assert.equal(await page.locator("[data-minimap-history-all]").count(), 0,
              "two indexed turns must not imply hidden earlier turns because their tool bodies span pages");
            const target = await page.locator('[data-minimap-node-index="0"]').boundingBox();
            await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
            await page.locator('[data-chat-message-row][data-entry-id="n0"]').waitFor({ state: "attached" });
            await frames(page, 15);
            assert.equal(await page.locator("[data-minimap-node-index]").count(), 2,
              "a folded short body window must retain its complete navigation rail");
            assert.equal(requests.filter(query => query.has("around")).length, 0, "an already loaded turn must navigate without another body request");
            assert.equal(requests.filter(query => query.has("before") || query.has("after")).length, 0,
              "a distant node click must not read every intervening body page");
          }
          assert.equal(await page.locator("[data-minimap-history-all]").count(), 0);
          console.log(JSON.stringify({ name, width: viewport.width, result: "passed" }));
        } finally { await context.close(); }
      }],
      ["opening preference controls following without hiding live output", async (name) => {
        const path = join(sessions, `${timestamp.replaceAll(":", "-")}_scroll-live.jsonl`);
        const original = await readFile(path, "utf8");
        for (const preference of ["answer-bottom", "last-question"]) {
          liveRunning = true; liveLeafId = "l2";
          const { context, page } = await open("scroll-live", viewport, preference);
          try {
            const publish = event => {
              let sent = 0;
              for (const [stream, id] of streams) if (id === "scroll-live") { stream.write(`data: ${JSON.stringify(event)}\n\n`); sent++; }
              assert.equal(sent, 1, "one real browser SSE subscription must receive the event");
            };
            publish({ type: "message_start", message: answer(liveMarker) });
            await page.locator(".chat-transcript").getByText(liveMarker, { exact: true }).waitFor({ state: "visible" });
            await frames(page, 60);
            const parked = await metrics(page);
            assert.ok(parked.height >= parked.client, "the opening fixture has a measurable viewport before live growth");
            if (preference === "last-question") assert.ok(await page.locator(".chat-scroll-to-bottom").evaluate(button => button.classList.contains("is-visible")),
              "a detached question reader must have an explicit follow-latest action");
            const delta = `\n\n${paragraphs("Live growth", 30)}\n\nlive-delta-end-marker`;
            publish({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
            await page.locator(".chat-transcript").getByText("live-delta-end-marker", { exact: true }).waitFor({ state: "attached" });
            await frames(page, 15);
            assert.ok((await metrics(page)).height > parked.client + 500, "the live answer must really grow beyond the viewport");
            if (preference === "last-question") assert.equal((await metrics(page)).top, parked.top, "live growth must not drag a question reader");
            else { const latest = await metrics(page); assert.ok(Math.abs(latest.height - latest.client - latest.top) < 2, "bottom opening must follow live growth"); }
            const message = { ...answer(liveMarker + delta), timestamp: Date.parse(timestamp) + 3 };
            await appendFile(path, JSON.stringify({ type: "message", id: "l3", parentId: "l2", timestamp, message }) + "\n");
            liveRunning = false; liveLeafId = "l3";
            publish({ type: "message_end", entryId: "l3", message });
            publish({ type: "agent_end", messages: [message] });
            publish({ type: "agent_settled" });
            publish({ type: "prompt_done" });
            await page.locator('[data-chat-message-row][data-entry-id="l3"]').waitFor({ state: "attached" });
            assert.equal(await page.locator(".chat-transcript").getByText("live-delta-end-marker", { exact: true }).count(), 1,
              "the persisted answer must replace, not lose or duplicate, the live answer");
            if (preference === "last-question") {
              assert.equal((await metrics(page)).top, parked.top);
              assert.ok(await page.locator(".chat-scroll-to-bottom").evaluate(button => button.classList.contains("is-visible")), "a question reader can explicitly follow latest");
            } else { const latest = await metrics(page); assert.ok(Math.abs(latest.height - latest.client - latest.top) < 2, "persisting a followed answer must remain at its tail"); }
            console.log(JSON.stringify({ name, width: viewport.width, preference, result: "passed" }));
          } catch (error) {
            failures.push(`${viewport.width}px ${name}/${preference}: ${error.stack ?? error}; viewport=${JSON.stringify(await metrics(page))}; rows=${await page.locator('[data-chat-message-row][data-entry-id]').count()}`);
            console.error(`FAIL: ${failures.at(-1)}`);
          } finally { await context.close(); await writeFile(path, original); }
        }
      }],
      ["editable fields and button activation keep their native keyboard behavior", async (name) => {
        const { context, page, requests } = await open("scroll-reading", viewport);
        try {
          const copy = page.locator('.chat-transcript [data-entry-id="p381"] .markdown-code-action').first();
          await page.locator(".chat-transcript").evaluate(c => { c.scrollTop = 200; });
          await frames(page, 10);
          const count = requests.length, writes = await page.evaluate(() => window.__chatScrollWrites.length);
          await copy.evaluate(el => el.focus({ preventScroll: true }));
          await page.keyboard.press("ArrowUp"); await frames(page, 10);
          assert.equal(requests.length, count, "a button cursor key must not create transcript pagination");
          assert.equal(await page.evaluate(() => window.__chatScrollWrites.length), writes,
            "a button cursor key must not invoke programmatic transcript scrolling");
          const beforeSpace = await metrics(page);
          await page.keyboard.press("Shift+Space");
          await page.waitForFunction(() => [...document.querySelectorAll('.chat-transcript [data-entry-id="p381"] .markdown-code-action')].some(el => el.textContent === "Copied"));
          assert.equal((await metrics(page)).top, beforeSpace.top, "Space activates a button without scrolling its parent");
          for (const kind of ["textarea", "contenteditable"]) {
            await page.locator('.chat-transcript [data-entry-id="p381"]').evaluate((row, kind) => {
              const editor = document.createElement(kind === "textarea" ? "textarea" : "div");
              editor.id = "native-editor-fixture";
              if (kind === "textarea") editor.value = "Native editing line\n".repeat(50);
              else {
                editor.contentEditable = "true";
                for (let i = 0; i < 50; i++) { const line = document.createElement("div"); line.textContent = `Native editing line ${i}`; editor.append(line); }
              }
              editor.style.cssText = "height:40px;overflow:auto;white-space:pre-wrap";
              row.append(editor); editor.focus({ preventScroll: true });
              editor.scrollTop = Math.max(0, (editor.scrollHeight - editor.clientHeight) / 2);
            }, kind);
            await frames(page, 5);
            const writes = await page.evaluate(() => window.__chatScrollWrites.length);
            await page.keyboard.press("PageUp"); await frames(page, 20);
            assert.equal(await page.locator("#native-editor-fixture").evaluate(el => document.activeElement === el), true,
              `${kind} must retain focus while handling native editing input`);
            assert.equal(requests.length, count, `${kind} must not create transcript pagination`);
            assert.equal(await page.evaluate(() => window.__chatScrollWrites.length), writes,
              `${kind} must not invoke the transcript programmatic scroll path`);
            await page.locator("#native-editor-fixture").evaluate(el => el.remove());
          }
          assert.equal(requests.length, count);
          console.log(JSON.stringify({ name, width: viewport.width, result: "passed" }));
        } finally { await context.close(); }
      }],
      ["mounted minimap reading survives streaming and persistence", async (name) => {
        if (viewport.width < 600) return;
        const path = join(sessions, `${timestamp.replaceAll(":", "-")}_scroll-navigation.jsonl`);
        const original = await readFile(path, "utf8");
        for (const target of ["question", "answer", "heading"]) {
          liveRuns.set("scroll-navigation", { running: true, leafId: "v11" });
          const { context, page, requests } = await open("scroll-navigation", viewport);
          try {
            publish("scroll-navigation", { type: "message_start", message: answer("navigation-live-marker") });
            await page.locator(".chat-transcript").getByText("navigation-live-marker", { exact: true }).waitFor();
            await frames(page, 60);
            const latest = await metrics(page), count = requests.length;
            assert.ok(latest.top > latest.client, "the live fixture must have a mounted earlier reading target");
            const rail = page.locator('[data-minimap-node-index="0"]');
            const box = await rail.boundingBox();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            const prefix = target === "question" ? '[data-minimap-preview-user="0"]'
              : target === "answer" ? '[data-minimap-preview-assistant="0-0"]'
              : '[data-minimap-preview-index="0"] [data-preview-heading-index="0"]';
            await page.locator(prefix).click(); await frames(page, 45);
            const row = target === "question" ? page.locator('[data-chat-message-row][data-entry-id="v0"]')
              : target === "answer" ? page.locator('[data-chat-message-row][data-entry-id="v1"]')
              : page.locator('[data-chat-message-row][data-entry-id="v1"] h1');
            const desired = await offsetOf(row);
            assert.ok((await metrics(page)).top < latest.top - latest.client, "minimap input must really navigate away from latest");
            publish("scroll-navigation", { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "\n\nnext live delta" } });
            await frames(page, 20);
            assert.ok(Math.abs(await offsetOf(row) - desired) < 2, `${target}: streaming pulled the mounted reading target away`);
            const message = { ...answer("navigation-live-marker\n\nnext live delta"), timestamp: Date.parse(timestamp) + 12 };
            await appendFile(path, JSON.stringify({ type: "message", id: "v12", parentId: "v11", timestamp, message }) + "\n");
            liveRuns.set("scroll-navigation", { running: false, leafId: "v12" });
            for (const event of [{ type: "message_end", entryId: "v12", message }, { type: "agent_end", messages: [message] }, { type: "agent_settled" }]) publish("scroll-navigation", event);
            await frames(page, 30);
            assert.ok(Math.abs(await offsetOf(row) - desired) < 2, `${target}: persistence pulled the reading target away`);
            assert.equal(requests.slice(count).filter(query => query.has("around") || query.has("before")).length, 0,
              "mounted minimap navigation must not reload its body; incremental tail reconciliation is independent");
            await page.locator(".chat-scroll-to-bottom").click();
            await page.locator('[data-chat-message-row][data-entry-id="v12"]').waitFor({ state: "attached" });
            await frames(page, 45);
            const bottom = await metrics(page);
            assert.ok(bottom.height - bottom.client - bottom.top < 2, "explicit latest must still reach the actual tail");
            console.log(JSON.stringify({ name, width: viewport.width, target, result: "passed" }));
          } catch (error) {
            failures.push(`${viewport.width}px ${name}/${target}: ${error.stack ?? error}`); console.error(`FAIL: ${failures.at(-1)}`);
          } finally { await context.close(); await writeFile(path, original); liveRuns.delete("scroll-navigation"); }
        }
      }],
      ["nested native scrolling leaves transcript intent and paging alone", async (name) => {
        for (const input of viewport.width < 600 ? ["wheel", "touch"] : ["wheel"]) {
          liveRuns.set("scroll-nested", { running: true, leafId: "z399" });
          const { context, page, requests } = await open("scroll-nested", viewport);
          try {
            const preview = page.locator('.chat-transcript [data-entry-id="z381"] .mermaid-preview-button');
            await preview.waitFor({ state: "attached" });
            await preview.evaluate(el => {
              const container = el.closest(".chat-transcript");
              container.scrollTop += el.getBoundingClientRect().top - container.getBoundingClientRect().top - 40;
              el.scrollTop = Math.min(400, (el.scrollHeight - el.clientHeight) / 2);
            });
            await frames(page, 20);
            publish("scroll-nested", { type: "message_start", message: answer("nested-live-marker") });
            await page.locator(".chat-transcript").getByText("nested-live-marker", { exact: true }).waitFor({ state: "attached" });
            await frames(page, 60);
            const initial = await metrics(page), innerTop = await preview.evaluate(el => el.scrollTop), count = requests.length;
            const previewOffset = await offsetOf(preview);
            assert.ok(previewOffset >= 0 && previewOffset < initial.client, "the nested preview must be visible before native input");
            assert.ok(innerTop > 150, "the real Mermaid preview must have internal overflow");
            const box = await preview.boundingBox();
            if (input === "wheel") {
              await page.mouse.move(box.x + box.width / 2, box.y + 160); await page.mouse.wheel(0, -80);
            } else {
              const session = await context.newCDPSession(page), point = { x: box.x + box.width / 2, y: box.y + 130 };
              await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
              await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, y: point.y + 80 }] });
              await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await session.detach();
            }
            await frames(page, 30);
            assert.ok(await preview.evaluate(el => el.scrollTop) < innerTop - 30, `${input} must actually scroll the nested preview`);
            assert.equal((await metrics(page)).top, initial.top, `${input} must not move the transcript during inner scrolling`);
            assert.equal(requests.length, count, `${input} in a nested preview must not request transcript history`);
            assert.equal(await page.locator(".chat-transcript").getByText("nested-live-marker", { exact: true }).count(), 1,
              "nested scrolling must not turn parked live output into hidden history");
            await preview.evaluate(el => { el.scrollTop = 0; }); await frames(page, 10);
            const pending = page.waitForRequest(request => new URL(request.url()).pathname.endsWith("/scroll-nested/history") && new URL(request.url()).searchParams.has("before"));
            await page.mouse.move(box.x + box.width / 2, box.y + 160); await page.mouse.wheel(0, -Math.max(500, initial.top));
            await pending;
            console.log(JSON.stringify({ name, width: viewport.width, input, result: "passed" }));
          } catch (error) {
            failures.push(`${viewport.width}px ${name}/${input}: ${error.stack ?? error}`); console.error(`FAIL: ${failures.at(-1)}`);
          } finally { await context.close(); liveRuns.delete("scroll-nested"); }
        }
      }],
      ["keep wheel displacement while an earlier page is in flight", async (name) => {
        const { context, page } = await open("scroll-reading", viewport);
        let release;
        const held = new Promise(resolve => { release = resolve; });
        try {
          await page.route("**/api/sessions/scroll-reading/history?*", async route => {
            const url = new URL(route.request().url());
            if (url.searchParams.get("mode") === "window" && url.searchParams.has("before")) {
              const response = await route.fetch(); await held; await route.fulfill({ response });
            } else await route.continue();
          });
          const pending = page.waitForRequest(request => {
            const url = new URL(request.url()); return url.pathname.endsWith("/scroll-reading/history") && url.searchParams.has("before");
          });
          await page.locator(".chat-transcript").evaluate(c => { c.scrollTop = 280; });
          await page.mouse.wheel(0, -20);
          const request = await pending;
          const before = new URL(request.url()).searchParams.get("before");
          const incoming = page.locator(`[data-chat-message-row][data-entry-id="p${Number(before.slice(1)) - 2}"]`);
          assert.equal(await incoming.count(), 0, "the held page must not already be in the DOM");
          await frames(page);
          const anchor = await page.locator(".chat-transcript").evaluate(c => {
            const top = c.getBoundingClientRect().top;
            const row = [...c.querySelectorAll("[data-chat-message-row][data-entry-id]")].find(row => row.getBoundingClientRect().bottom > top + 1);
            return { id: row.dataset.entryId, offset: row.getBoundingClientRect().top - top };
          });
          const row = page.locator(`[data-chat-message-row][data-entry-id="${anchor.id}"]`);
          const offset = () => row.evaluate(row => row.getBoundingClientRect().top - row.closest(".chat-transcript").getBoundingClientRect().top);
          await page.mouse.wheel(0, -95); await frames(page, 6);
          const desired = await offset();
          assert.ok(desired - anchor.offset > 70, "the user must really move while the response is held");
          release();
          await incoming.waitFor({ state: "attached" });
          await frames(page, 30);
          const restored = await offset();
          assert.ok(Math.abs(restored - desired) < 2, `response erased user scrolling: expected ${desired}, got ${restored}`);
          console.log(JSON.stringify({ name, width: viewport.width, anchor: anchor.id, desired, restored, result: "passed" }));
        } finally { release(); await context.close(); }
      }],
    ]) {
      if (process.env.CHAT_SCROLL_CASE && !new RegExp(process.env.CHAT_SCROLL_CASE).test(name)) continue;
      try { await test(name); }
      catch (error) { failures.push(`${viewport.width}px ${name}: ${error.stack ?? error}`); console.error(`FAIL: ${failures.at(-1)}`); }
    }
  }
} finally {
  await browser?.close();
  for (const stream of streams.keys()) stream.end();
  proxy.closeAllConnections(); if (proxy.listening) await new Promise(resolve => proxy.close(resolve));
  for (const child of [writerServer, server].filter(Boolean)) {
    const exited = child.exitCode === null ? once(child, "exit") : Promise.resolve();
    child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited; clearTimeout(timer);
  }
  await rm(home, { recursive: true, force: true });
}
assert.deepEqual(failures, [], "scroll behavior regressions");
