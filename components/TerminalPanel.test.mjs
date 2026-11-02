import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { closeTerminal, createTerminalWriter, terminalEventPath, terminalRequest } from "../lib/terminal-client.ts";

test("terminal prefers patched local fonts for Powerlevel10k glyphs and waits for font metrics", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("./TerminalPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /--terminal-font-mono/);
  assert.match(source, /await document\.fonts\?\.ready/);
  assert.match(css, /\.terminal-xterm-host \{[\s\S]*--terminal-font-mono: "MesloLGS NF"/);
  assert.match(css, /--terminal-font-mono:[\s\S]*"Symbols Nerd Font Mono"/);
});

test("terminal errors preserve server diagnostics and explain non-JSON responses", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch");
  for (const body of [null, "<html>Server error</html>", "null"]) {
    fetch.mock.mockImplementation(async () => new Response(body, { status: 500 }));
    await assert.rejects(terminalRequest("/api/terminal"), /HTTP 500.*pi-web server log/);
  }
  fetch.mock.mockImplementation(async () => Response.json({ error: "Native module missing; run npm rebuild node-pty" }, { status: 500 }));
  await assert.rejects(terminalRequest("/api/terminal"), /Native module missing; run npm rebuild node-pty/);
});

test("a delayed input request cannot be overtaken by typing or resize", async (t) => {
  const received = [];
  let finishFirst;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    received.push(JSON.parse(options.body));
    if (received.length === 1) await new Promise((resolve) => { finishFirst = resolve; });
    return Response.json({ success: true });
  });
  const writer = createTerminalWriter("id", assert.fail);
  writer.write("a");
  writer.resize(100, 30);
  writer.write("b\r");
  await setImmediate();
  assert.equal(received.length, 1);
  finishFirst();
  await setImmediate();
  assert.deepEqual(received, [
    { type: "input", data: "a" },
    { type: "resize", cols: 100, rows: 30 },
    { type: "input", data: "b\r" },
  ]);
  await writer.stop();
});

test("large Unicode pastes preserve characters while bounding input requests", async (t) => {
  const chunks = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    chunks.push(JSON.parse(options.body).data);
    return Response.json({ success: true });
  });
  const writer = createTerminalWriter("id", assert.fail);
  const text = "a".repeat(32767) + "\u{1f600}".repeat(40000);
  writer.write(text);
  await setImmediate();
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 65536 && chunk.isWellFormed()));
  await writer.stop();
});

test("typing during a slow request is batched into the next ordered write", async (t) => {
  const received = [];
  let release;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    received.push(JSON.parse(options.body).data);
    if (received.length === 1) await new Promise((resolve) => { release = resolve; });
    return Response.json({ success: true });
  });
  const writer = createTerminalWriter("id", assert.fail);
  writer.write("first");
  await setImmediate();
  for (const character of "a long command\r") writer.write(character);
  assert.deepEqual(received, ["first"]);
  release();
  await setImmediate();
  assert.deepEqual(received, ["first", "a long command\r"]);
  await writer.stop();
});

test("failed or stopped delivery discards queued input without retrying commands", async (t) => {
  const errors = [];
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ error: "gone" }, { status: 404 }));
  const writer = createTerminalWriter("id", (error) => errors.push(error.message));
  writer.write("first");
  writer.write("second");
  await setImmediate();
  assert.deepEqual(errors, ["gone"]);
  assert.equal(fetch.mock.callCount(), 1);
  await writer.stop();
  writer.write("third");
  await setImmediate();
  assert.equal(fetch.mock.callCount(), 1);
});


test("peer terminal URLs keep the same peer on events and commands", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return Response.json({ success: true });
  });
  const writer = createTerminalWriter("a".repeat(32), assert.fail, "peer-a");
  writer.write("pwd\r");
  await setImmediate();
  await writer.stop();
  assert.equal(calls[0].url, `/api/remote/terminal/${"a".repeat(32)}?peer=peer-a`);
  assert.equal(terminalEventPath("a".repeat(32), "peer-a", 12), `/api/remote/terminal/${"a".repeat(32)}/events?after=12&peer=peer-a`);
});

test("stopping a terminal aborts in-flight input and does not report expected disposal as a failure", async (t) => {
  const errors = [];
  let signal;
  t.mock.method(globalThis, "fetch", async (_url, options) => new Promise((_resolve, reject) => {
    signal = options.signal;
    options.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
  }));
  const writer = createTerminalWriter("id", (error) => errors.push(error));
  writer.write("one");
  await setImmediate();
  await writer.stop();
  assert.equal(signal.aborted, true);
  assert.deepEqual(errors, []);
});

test("failed creation and an already absent terminal can still close", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Terminal not found" }, { status: 404 }));
  await closeTerminal("id", Promise.reject(new Error("Fetch is aborted")), null);
});

test("closing propagates a cleanup failure instead of declaring the shell stopped", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "offline" }, { status: 503 }));
  await assert.rejects(closeTerminal("id", Promise.resolve(), null), /offline/);
});
