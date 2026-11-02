import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { spawn } from "node:child_process";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const service = await jiti.import("./session-mutation-service.ts");
const commands = await jiti.import("./session-mutation-command.ts");
const client = await jiti.import("./remote-session-mutation.ts");
const bridges = await jiti.import("./session-mutation-bridge.ts");
const receipts = await jiti.import("./reader-control-receipts.ts");
const available = { capability: async () => "supported", discovery: async () => ({ operations: [] }), acknowledge: async () => true };
const command = (overrides = {}) => ({ operationId: "operation-fixture-1", deviceId: "remote-device", sessionId: "session-1", op: "delete", force: true, ...overrides });
const result = (input, status) => ({ operationId: input.operationId, deviceId: input.deviceId, sessionId: input.sessionId, status });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "reader-remote-mutation-"));
  const keys = ["PI_WEB_CONTROL_RECEIPT_ROOT", "PI_WEB_SESSION_ACTIVITY_CONFIG"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.PI_WEB_CONTROL_RECEIPT_ROOT = root;
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "remote-device" }, peers: [{ id: "local-device", url: "https://same-host:30141", name: "Local" }] });
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); });
  return root;
}

test("server reserves once across concurrent transports and returns late/reloaded terminal receipts", async (t) => {
  fixture(t);
  const input = command();
  let effects = 0;
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  let complete;
  const completion = new Promise(resolve => { complete = resolve; });
  const first = service.executeSessionMutation(input, async () => { effects++; started(); await completion; return new Response(null, { status: 200 }); });
  await startedPromise;
  const second = await service.executeSessionMutation(input, async () => { effects++; throw new Error("must not execute twice"); });
  assert.equal(second.status, "running");
  assert.equal((await service.querySessionMutation(input)).status, "running");
  complete();
  assert.equal((await first).status, "completed");
  assert.equal((await service.querySessionMutation(input)).status, "completed");
  const reloaded = await createJiti(import.meta.url, { moduleCache: false }).import("./session-mutation-service.ts");
  assert.equal((await reloaded.executeSessionMutation(input, async () => { effects++; return new Response(); })).status, "completed");
  assert.equal(effects, 1);
});

test("operation id binds session, action, name and force; unknown effects never execute again", async (t) => {
  fixture(t);
  let effects = 0;
  const input = command({ op: "rename", name: "First", force: false });
  const execute = async () => { effects++; return new Response(); };
  await service.executeSessionMutation(input, execute);
  for (const changed of [{ name: "Other" }, { force: true }, { sessionId: "session-2" }, { op: "delete", name: undefined }]) {
    assert.equal((await service.executeSessionMutation({ ...input, ...changed }, execute)).status, "conflict");
  }
  const uncertain = command({ operationId: "operation-uncertain" });
  assert.equal((await service.executeSessionMutation(uncertain, async () => { effects++; throw new Error("effect happened but response lost"); })).status, "unknown");
  assert.equal((await service.executeSessionMutation(uncertain, execute)).status, "unknown");
  assert.equal((await service.querySessionMutation(uncertain)).status, "unknown");
  assert.equal(effects, 2);
});

test("wrong device and unreadable reservation store fail before business effects", async (t) => {
  fixture(t);
  let effects = 0;
  const execute = async () => { effects++; return new Response(); };
  assert.equal((await service.executeSessionMutation(command({ deviceId: "wrong-device" }), execute)).status, "conflict");
  writeFileSync(receipts.controlReceiptStorePath(), "corrupt");
  await assert.rejects(service.executeSessionMutation(command(), execute));
  assert.equal(effects, 0);
});

test("indexed receipts admit more than 512 mutations and preserve every original identity", async (t) => {
  fixture(t);
  let effects = 0;
  const execute = async () => { effects++; return new Response(); };
  for (let i = 0; i < 530; i++) await service.executeSessionMutation(command({ operationId: `operation-pressure-${i}` }), execute);
  assert.equal(effects, 530);
  const original = command({ operationId: "operation-pressure-0" });
  assert.equal((await service.executeSessionMutation(original, execute)).status, "completed");
  assert.equal((await service.executeSessionMutation({ ...original, force: false }, execute)).status, "conflict");
  const ordinary = await receipts.reserveControlReceipt({ deviceId: "remote-device", sessionId: "another", operation: "prompt",
    idempotencyKey: "ordinary-control-after-mutations", requestFingerprint: "fingerprint", cwd: "fixture" });
  assert.equal(ordinary.replayed, false, "protected mutation history cannot exhaust unrelated controls");
  const cold = await createJiti(import.meta.url, { moduleCache: false }).import("./session-mutation-service.ts");
  assert.equal((await cold.querySessionMutation(original)).status, "completed");
  assert.equal(effects, 530);
  let after = "", count = 0;
  do { const page = await service.listSessionMutations(after); count += page.operations.length; after = page.nextCursor ?? ""; } while (after);
  assert.equal(count, 530, "recovery pages do not lose IDs");
});

test("mutation forwarding preserves exact rename/archive parameters and force", async () => {
  const forced = commands.sessionMutationRequest(command(), "https://target.test:30142");
  assert.equal(forced.method, "DELETE");
  assert.equal(new URL(forced.url).searchParams.get("force"), "1");
  const rename = commands.sessionMutationRequest(command({ op: "rename", name: "same name", force: false }), "https://target.test");
  assert.deepEqual(await rename.json(), { name: "same name" });
  const unarchive = commands.sessionMutationRequest(command({ op: "unarchive" }), "https://target.test");
  assert.deepEqual(await unarchive.json(), { archived: false });
  assert.equal(new URL(unarchive.url).searchParams.get("force"), "1");
});

test("proxy timeout followed by unknown receipt only observes; ready failure never posts again", async () => {
  const input = command();
  const calls = [];
  const actual = await client.reconcileSessionMutation(input, { resume: false,
    proxy: async mode => { calls.push(`proxy:${mode}`); throw new Error("timeout"); },
    openBridge: async () => ({ request: async mode => { calls.push(`bridge:${mode}`); return result(input, "unknown"); }, close() { calls.push("close"); } }) });
  assert.equal(actual.status, "unknown");
  assert.deepEqual(calls, ["proxy:execute", "bridge:query", "close"]);
  calls.length = 0;
  const notReady = await client.reconcileSessionMutation(input, { resume: false,
    proxy: async mode => { calls.push(mode); return result(input, "unknown"); }, openBridge: async () => { throw new Error("ready timeout"); } });
  assert.equal(notReady.status, "unknown");
  assert.deepEqual(calls, ["execute"]);
});

test("only explicit continuation permits the same id through fallback, and a late receipt completes by query", async () => {
  const input = command();
  const calls = [];
  let queries = 0;
  let time = 0;
  const actual = await client.reconcileSessionMutation(input, { resume: true, continueOriginal: true, now: () => time, sleep: async ms => { time += ms; },
    proxy: async () => { throw new Error("timeout"); },
    openBridge: async () => ({ request: async (mode, received) => {
      assert.deepEqual(received, input); calls.push(mode);
      return result(input, mode === "execute" ? "running" : ++queries === 1 ? "not_found" : "completed");
    }, close() {} }) });
  assert.equal(actual.status, "completed");
  assert.deepEqual(calls, ["query", "execute", "query"]);
});

test("a missing receipt after the first POST never automatically resubmits through the bridge", async () => {
  const input = command(), calls = [];
  const receipt = await client.reconcileSessionMutation(input, { resume: false,
    proxy: async mode => { calls.push(`proxy:${mode}`); throw Error("lost before admission"); },
    openBridge: async () => ({ request: async mode => { calls.push(`bridge:${mode}`); return result(input, "not_found"); }, close() {} }) });
  assert.equal(receipt.status, "not_found");
  assert.deepEqual(calls, ["proxy:execute", "bridge:query"]);
});

for (const status of ["accepted", "running", "completed", "failed", "conflict"]) {
  test(`explicit continuation observes ${status} without another execute`, async () => {
    const input = command(), calls = []; let now = 0;
    const receipt = await client.reconcileSessionMutation(input, { resume: true, continueOriginal: true,
      now: () => now, sleep: async ms => { now += ms; },
      proxy: async mode => { calls.push(mode); return result(input, calls.length === 1 ? status : "completed"); },
      openBridge: async () => { throw Error("must not need bridge"); } });
    assert.equal(receipt.status, ["accepted", "running"].includes(status) ? "completed" : status);
    assert.equal(calls.includes("execute"), false);
  });
}

test("uncertain browser operations survive reload and next click queries the original id", async () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const calls = [];
  const proxy = async (mode, input) => { calls.push({ mode, input }); return result(input, calls.length === 1 ? "unknown" : "completed"); };
  const settings = { ...available, storage, uuid: () => "original-operation-id", proxy, openBridge: async () => { throw new Error("not ready"); } };
  const first = await client.createRemoteSessionMutationClient(settings)({ id: "remote-device", url: "https://host.test:30142" }, "delete", "session-1", undefined, true);
  assert.equal(first.status, "unknown");
  const second = await client.createRemoteSessionMutationClient({ ...settings, uuid: () => "must-not-be-used" })({ id: "remote-device", url: "https://host.test:30142" }, "delete", "session-1", undefined, true);
  assert.equal(second.status, "completed");
  assert.deepEqual(calls.map(entry => entry.mode), ["execute", "query"]);
  assert.equal(calls[1].input.operationId, "original-operation-id");
  assert.equal(calls[1].input.force, true);
});

function browserFixture({ ready = true, wrongOrigin = false, protocol = 2 } = {}) {
  const host = new EventTarget();
  host.crypto = webcrypto;
  host.location = { origin: "https://same-host:30141", href: "https://same-host:30141/?session=original" };
  const calls = [];
  let frame;
  const emit = (data, origin = "https://same-host:30142", source = frame.contentWindow) => {
    const event = new Event("message"); Object.assign(event, { data, origin, source }); host.dispatchEvent(event);
  };
  const doc = { createElement: () => (frame = { setAttribute() {}, remove() { calls.push("remove transport"); },
    contentWindow: { postMessage(data, origin) { calls.push({ data, origin }); } } }),
    body: { appendChild(value) {
      calls.push("append transport");
      const channel = new URL(value.src).searchParams.get("channel");
      if (ready) queueMicrotask(() => emit({ type: "session-mutation-ready", channel, deviceId: "remote-device", protocol }, wrongOrigin ? host.location.origin : undefined));
    } } };
  return { host, doc, calls, emit, get frame() { return frame; } };
}

test("dedicated bridge requires exact origin readiness and preserves concurrent user navigation", async () => {
  const browser = browserFixture();
  const channel = await bridges.openSessionMutationBridge("remote-device", "https://same-host:30142", { window: browser.host, document: browser.doc, readyTimeoutMs: 20, requestTimeoutMs: 20 });
  browser.host.location.href = "https://same-host:30141/?session=user-new-choice";
  const input = command();
  const reply = channel.request("execute", input);
  const sent = browser.calls.at(-1);
  assert.equal(sent.origin, "https://same-host:30142");
  assert.equal(sent.data.command.force, true);
  const response = { type: "session-mutation-result", channel: sent.data.channel, requestId: sent.data.requestId, result: result(input, "completed") };
  browser.emit(response, "https://same-host:30141"); // Same hostname is insufficient.
  browser.emit(response);
  assert.equal((await reply).status, "completed");
  channel.close();
  assert.equal(browser.host.location.href, "https://same-host:30141/?session=user-new-choice");
  assert.equal(browser.calls.at(-1), "remove transport");
  assert.equal(new URL(browser.frame.src).pathname, "/api/session-mutations/bridge");
});

test("wrong-origin ready and absent ready fail closed; late bridge response cannot settle a timed-out request", async () => {
  for (const setup of [{ ready: false }, { wrongOrigin: true }]) {
    const browser = browserFixture(setup);
    await assert.rejects(bridges.openSessionMutationBridge("remote-device", "https://same-host:30142", { window: browser.host, document: browser.doc, readyTimeoutMs: 2 }), /readiness/);
    assert.equal(browser.calls.some(call => call.data?.type === "session-mutation-command"), false);
  }
  const browser = browserFixture();
  const channel = await bridges.openSessionMutationBridge("remote-device", "https://same-host:30142", { window: browser.host, document: browser.doc, requestTimeoutMs: 2 });
  const input = command();
  const pending = channel.request("execute", input);
  const sent = browser.calls.at(-1).data;
  assert.equal((await pending).status, "unknown");
  browser.emit({ type: "session-mutation-result", channel: sent.channel, requestId: sent.requestId, result: result(input, "completed") });
  channel.close();
});

test("runtime-free bridge only accepts a configured parent, matching source, origin and channel", async (t) => {
  fixture(t);
  const route = await jiti.import("../app/api/session-mutations/bridge/route.ts");
  const request = origin => new Request(`https://same-host:30142/api/session-mutations/bridge?parentOrigin=${encodeURIComponent(origin)}&channel=test-channel-123`, { headers: { host: "127.0.0.1" } });
  assert.equal((await route.GET(request("https://evil.invalid"))).status, 403);
  const response = await route.GET(request("https://same-host:30141"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors https:\/\/same-host:30141;/);
  const html = await response.text();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
  let listener;
  const messages = [];
  const parent = { postMessage: (data, origin) => messages.push({ data, origin }) };
  const fetches = [];
  runInNewContext(script, { URLSearchParams, window: { parent, addEventListener: (_name, callback) => { listener = callback; } }, fetch: async (...args) => {
    fetches.push(args); return new Response(JSON.stringify(result(command(), "completed")), { headers: { "content-type": "application/json" } });
  } });
  assert.equal(messages[0].data.type, "session-mutation-ready");
  assert.equal(messages[0].data.deviceId, "remote-device");
  const data = { type: "session-mutation-command", channel: "test-channel-123", requestId: "request-1", mode: "execute", command: command() };
  await listener({ source: parent, origin: "https://evil.invalid", data });
  await listener({ source: {}, origin: "https://same-host:30141", data });
  await listener({ source: parent, origin: "https://same-host:30141", data: { ...data, channel: "wrong-channel" } });
  assert.equal(fetches.length, 0);
  await listener({ source: parent, origin: "https://same-host:30141", data });
  assert.equal(fetches.length, 1);
  assert.equal(JSON.parse(fetches[0][1].body).force, true);
  assert.equal(messages.at(-1).origin, "https://same-host:30141");
});

test("another server boot observes a reservation without overwriting its eventual result", async (t) => {
  fixture(t);
  const input = command();
  const reservation = { deviceId: input.deviceId, sessionId: input.sessionId, operation: "session_mutation", idempotencyKey: input.operationId,
    requestFingerprint: receipts.controlRequestFingerprint(input), cwd: "session-mutation", bootId: "worker-a" };
  const first = await receipts.reserveControlReceipt(reservation);
  const duplicate = await receipts.reserveControlReceipt({ ...reservation, bootId: "worker-b" });
  assert.equal(duplicate.replayed, true);
  assert.equal(duplicate.receipt.outcome, "accepted");
  assert.equal((await service.querySessionMutation(input)).status, "unknown", "another boot is conservatively observed");
  await receipts.updateControlReceipt(first.receipt.receiptId, { outcome: "completed" });
  assert.equal((await service.querySessionMutation(input)).status, "completed", "late owner result remains publishable");
});

test("real mutation POST/GET routes run the existing rename handler once and expose its receipt", async (t) => {
  fixture(t);
  const previous = globalThis.__piSessions;
  const calls = [];
  globalThis.__piSessions = new Map([["session-1", { isAlive: () => true, send: async event => { calls.push(event); } }]]);
  t.after(() => { globalThis.__piSessions = previous; });
  const route = await jiti.import("../app/api/session-mutations/route.ts");
  const input = command({ op: "rename", name: "Renamed once", force: false });
  const post = body => route.POST(new Request("http://localhost/api/session-mutations", { method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify(body) }));
  assert.equal((await (await post(input)).json()).status, "completed");
  assert.equal((await (await post(input)).json()).status, "completed");
  assert.deepEqual(calls, [{ type: "set_session_name", name: "Renamed once" }]);
  const query = new URLSearchParams({ operationId: input.operationId, deviceId: input.deviceId, sessionId: input.sessionId });
  const receipt = await route.GET(new Request(`http://localhost/api/session-mutations?${query}`, { headers: { host: "localhost" } }));
  assert.equal((await receipt.json()).status, "completed");
  assert.equal((await (await post({ ...input, force: true })).json()).status, "conflict");
  assert.equal((await post({ ...input, operationId: "operation-invalid", force: undefined })).status, 400);
  assert.equal(calls.length, 1);
});

test("unresolved mutation queries its original parameters before accepting a changed intent", async () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const calls = [];
  const perform = client.createRemoteSessionMutationClient({ ...available, storage, uuid: () => "pending-operation", proxy: async (mode, input) => { calls.push(mode); return result(input, "unknown"); }, openBridge: async () => { throw new Error("not ready"); } });
  const target = { id: "remote-device", url: "https://host.test:30142" };
  await perform(target, "delete", "session-1", undefined, false);
  const changed = await perform(target, "delete", "session-1", undefined, true);
  assert.equal(changed.status, "unknown");
  assert.equal(changed.operationId, "pending-operation");
  assert.deepEqual(calls, ["execute", "query"]);
  assert.equal(changed.previousOperation, true);

});


test("independent server processes share the same durable mutation admission", async (t) => {
  const root = fixture(t);
  const script = `import { createJiti } from "jiti";
    import { appendFileSync } from "node:fs";
    const service = await createJiti(${JSON.stringify(import.meta.url)}).import(${JSON.stringify(new URL("./session-mutation-service.ts", import.meta.url).pathname)});
    const result = await service.executeSessionMutation(${JSON.stringify(command())}, async () => {
      appendFileSync(${JSON.stringify(join(root, "effects.txt"))}, "effect\\n");
      await new Promise(resolve => setTimeout(resolve, 30));
      return new Response();
    });
    if (!["completed", "unknown", "running", "accepted"].includes(result.status)) throw new Error(result.status);`;
  await Promise.all(Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), env: {
      PATH: process.env.PATH, HOME: root, PI_WEB_CONTROL_RECEIPT_ROOT: root,
      PI_WEB_SESSION_ACTIVITY_CONFIG: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG,
    }, stdio: ["ignore", "ignore", "pipe"] });
    let diagnostic = "";
    child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-2000); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(diagnostic)));
  })));
  assert.equal(readFileSync(join(root, "effects.txt"), "utf8"), "effect\n");
  assert.equal((await service.querySessionMutation(command())).status, "completed");
});


test("receipt admission cannot evict a paused kernel writer and recovers after process death", async (t) => {
  const root = fixture(t);
  const path = receipts.controlReceiptStorePath();
  const script = `const { acquireStateWriteLock } = require(${JSON.stringify(new URL("../bin/state-write-lock.cjs", import.meta.url).pathname)});
    acquireStateWriteLock(${JSON.stringify(path)}); process.send("locked"); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["-e", script], { cwd: root, env: { PATH: process.env.PATH, HOME: root }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", code => reject(new Error(`lock holder exited ${code}`))); });
  child.kill("SIGSTOP");
  utimesSync(`${path}.writer.sqlite`, new Date(0), new Date(0));
  let effects = 0;
  const execute = async () => { effects++; return new Response(); };
  await assert.rejects(service.executeSessionMutation(command(), execute), { code: "ELOCKED" });
  assert.equal(effects, 0);
  const stopped = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGKILL"); await stopped;
  assert.equal((await service.executeSessionMutation(command(), execute)).status, "completed");
  assert.equal(effects, 1);
});

test("legacy receipt lock is never stolen during a mixed-version upgrade", async (t) => {
  fixture(t);
  const path = `${receipts.controlReceiptStorePath()}.lock`;
  mkdirSync(path);
  utimesSync(path, new Date(0), new Date(0));
  let effects = 0;
  await assert.rejects(service.executeSessionMutation(command(), async () => { effects++; return new Response(); }), { code: "ELOCKED" });
  assert.equal(effects, 0);
});


test("legacy ready requires an upgrade and never emits a mutation command", async () => {
  const browser = browserFixture({ protocol: 1 });
  await assert.rejects(bridges.openSessionMutationBridge("remote-device", "https://same-host:30142", {
    window: browser.host, document: browser.doc, readyTimeoutMs: 20,
  }), { code: "UPGRADE_REQUIRED" });
  assert.equal(browser.calls.some(call => call.data?.type === "session-mutation-command"), false);
});

test("bridge authentication diagnostic is immediate and requires exact origin, source and channel", async () => {
  const browser = browserFixture({ ready: false });
  const opened = bridges.openSessionMutationBridge("remote-device", "https://same-host:30142", { window: browser.host, document: browser.doc, readyTimeoutMs: 1000 });
  const channel = new URL(browser.frame.src).searchParams.get("channel");
  const data = { type: "session-mutation-auth-required", channel };
  let finished = false;
  void opened.then(() => { finished = true; }, () => { finished = true; });
  browser.emit(data, browser.host.location.origin);
  browser.emit(data, undefined, {});
  browser.emit({ ...data, channel: "wrong-channel" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  browser.emit(data);
  await assert.rejects(opened, { code: "AUTH_REQUIRED" });
  assert.equal(browser.host.location.href, "https://same-host:30141/?session=original");
  assert.equal(browser.calls.some(call => call.data?.type === "session-mutation-command"), false);
  assert.equal(browser.calls.at(-1), "remove transport");
});

test("missing frame authentication rejects new mutations before IDs, storage reservations or POSTs", async () => {
  let ids = 0, posts = 0;
  const auth = Object.assign(new Error("authentication required"), { code: "AUTH_REQUIRED" });
  const perform = client.createRemoteSessionMutationClient({ storage: { getItem: () => null, setItem() {} },
    uuid: () => { ids++; return "must-not-allocate"; }, capability: async () => "authentication_required",
    proxy: async () => { posts++; throw Error("must not post"); }, openBridge: async () => { throw auth; } });
  const target = { id: "remote-device", url: "https://target.test" };
  const observed = await perform(target, "delete", "session-1");
  assert.equal(observed.notSentReason, "authenticationRequired"); assert.equal(observed.notSent, true);
  assert.equal(observed.authenticationRequired, true); assert.equal(ids, 0); assert.equal(posts, 0);
  assert.deepEqual(perform.snapshot(), []);
  const recovery = await perform.recover([target]);
  assert.deepEqual(recovery.authenticationRequiredTargets, [target]);
  assert.deepEqual(recovery.unavailableTargets, [target]);
});

test("authentication failures during unknown-operation recovery preserve original ID and never execute again", async () => {
  const saved = new Map();
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const calls = [];
  const target = { id: "remote-device", url: "https://target.test" };
  const auth = Object.assign(new Error("authentication required"), { code: "AUTH_REQUIRED" });
  const first = client.createRemoteSessionMutationClient({ ...available, storage, uuid: () => "original-auth-operation",
    proxy: async (mode, input) => { calls.push({ mode, input }); return result(input, "unknown"); },
    openBridge: async () => { throw auth; } });
  const outcome = await first(target, "delete", "session-1", undefined, true);
  assert.equal(outcome.authenticationRequired, true); assert.equal(outcome.notSent, undefined);
  assert.equal(outcome.status, "unknown"); assert.equal(first.snapshot()[0].command.operationId, "original-auth-operation");
  assert.equal(first.snapshot()[0].receipt.authenticationRequired, undefined, "auth errors must not become durable outcome facts");
  const reloaded = client.createRemoteSessionMutationClient({ storage, uuid: () => { throw Error("must not allocate"); },
    capability: async () => "authentication_required", discovery: async () => { throw auth; },
    proxy: async (mode, input) => { calls.push({ mode, input }); return result(input, "unknown"); }, openBridge: async () => { throw auth; } });
  const next = await reloaded(target, "archive", "session-1");
  assert.equal(next.previousOperation, true); assert.equal(next.authenticationRequired, true);
  const continued = await reloaded.continueOriginal("original-auth-operation", target.id);
  assert.equal(continued.notSent, true); assert.equal(continued.authenticationRequired, true);
  const recovery = await reloaded.recover([target]);
  assert.deepEqual(recovery.authenticationRequiredTargets, [target]);
  assert.equal(reloaded.snapshot().length, 1);
  assert.equal(calls.filter(call => call.mode === "execute").length, 1);
  assert.equal(calls.every(call => call.input.operationId === "original-auth-operation" && call.input.op === "delete" && call.input.force === true), true);
});
