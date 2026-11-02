import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "reader-live-peer-"));
const keys = ["PI_CODING_AGENT_DIR", "PI_WEB_SESSION_WAIT_STATE_ROOT", "PI_WEB_SESSION_ACTIVITY_CONFIG", "PI_WEB_SESSION_ACTIVITY_FILE", "PI_WEB_SESSION_WAIT_CHANNEL"];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const priorSessions = globalThis.__piSessions;
const remoteRoot = join(root, "remote"); mkdirSync(remoteRoot);
const child = fork(new URL("./__fixtures__/session-control-peer.mjs", import.meta.url), [], { env: { ...process.env, PI_CODING_AGENT_DIR: remoteRoot, PI_WEB_SESSION_WAIT_STATE_ROOT: join(remoteRoot, "waits"), PI_WEB_SESSION_WAIT_CHANNEL: "peer-test" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
const ready = await Promise.race([once(child, "message").then(([value]) => value), once(child, "exit").then(([code]) => { throw new Error(`Peer fixture exited ${code}: ${stderr}`); }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`Peer fixture timed out: ${stderr}`)), 30000); timer.unref(); })]);
const url = ready.url;
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = join(root, "waits");
process.env.PI_WEB_SESSION_WAIT_CHANNEL = "peer-test";
process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "local", name: "Mac mini" }, peers: [{ id: "remote", name: "Debian", url }] });
process.env.PI_WEB_SESSION_ACTIVITY_FILE = join(root, "activity.json");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: true });
const { createSessionControlExtension } = await jiti.import("./session-control.ts");
const waits = await jiti.import("./session-waits.ts");
const ownerFile = join(root, "owner.jsonl"); writeFileSync(ownerFile, "");
const messages = [];
const owner = { sessionId: "owner", sessionFile: ownerFile, cwd: root, isAlive: () => true, isRunning: () => false, inner: { sessionManager: { getSessionId: () => "owner", getSessionFile: () => ownerFile, getHeader: () => ({ id: "owner", cwd: root }) } }, async sendNativePeerMessage(message, options) { if (options.beforeSubmit && !options.beforeSubmit()) throw new Error("stale notification"); messages.push(message); } };
globalThis.__piSessions = new Map([["owner", owner]]);
let definition; createSessionControlExtension().factory({ registerTool(value) { definition = value; } });
const run = async params => JSON.parse((await definition.execute("remote-call", { target: "worker", targetDeviceId: "remote", ...params }, undefined, undefined, { cwd: root, sessionManager: owner.inner.sessionManager })).content[0].text);
const fixture = async (action, body = {}) => (await fetch(`${url}/fixture/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
async function eventually(check) { const end = Date.now() + 10000; while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); } assert.fail("Timed out waiting for a non-empty remote result"); }
const continuation = { message: "检查远程问题后继续当前任务", target: { deviceId: "local", sessionId: "owner", sessionFile: ownerFile }, authorizedScope: ["resume_prior_work"] };

test.after(async () => { waits.closeRemoteUiWaits(); child.send("close"); await once(child, "exit"); globalThis.__piSessions = priorSessions; for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); });

test("trusted peer live operations preserve full UI content and native answer receipts across HTTP", async () => {
  await fixture("publish", { requests: [{ id: "editor", method: "editor" }, { id: "select", method: "select" }] });
  const inspected = await run({ action: "inspect" });
  assert.equal(inspected.deviceId, "remote"); assert.equal(inspected.sessionId, "worker");
  assert.ok(inspected.pendingUi.requests[0].prefill.length > 48000);
  const pending = await run({ action: "pending_ui" }); assert.deepEqual(pending.pendingUi, inspected.pendingUi);
  const params = { action: "answer_ui", requestId: "select", runtimeGeneration: "generation-1", value: "手动输入" };
  const accepted = await run(params); assert.equal(accepted.status, "accepted"); assert.equal(accepted.pendingUi.requests.at(-1).id, "manual");
  assert.equal((await run(params)).status, "replayed");
  assert.equal((await run({ ...params, value: "继续" })).code, "ui_request_conflict");
  assert.equal((await run({ ...params, runtimeGeneration: "stale" })).code, "ui_generation_mismatch");
  assert.equal((await run({ action: "answer_ui", requestId: "manual", runtimeGeneration: "generation-1", value: "自定义答案" })).status, "accepted");
  assert.equal((await fixture("state")).submissions, 2);
});

test("remote wait_for receives native events and releases its subscription", async () => {
  await fixture("run");
  const waiting = run({ action: "wait_for", until: "settled", timeoutMs: 3000 });
  await eventually(async () => (await fixture("state")).eventListeners > 0);
  await fixture("settle");
  const result = await waiting; assert.equal(result.timedOut, false); assert.equal(result.event.type, "agent_settled");
  const timeout = await run({ action: "wait_for", until: "tool_start", timeoutMs: 100 }); assert.equal(timeout.timedOut, true);
});

test("remote live endpoint rejects unknown devices, cross-site requests and channel mixing", async () => {
  const body = { channel: "peer-test", caller: { deviceId: "unknown", sessionId: "owner" }, params: { action: "pending_ui", target: "worker" } };
  const post = (value, headers = {}) => fetch(`${url}/api/session-control/live`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(value) });
  assert.equal((await post(body)).status, 400);
  assert.equal((await post({ ...body, caller: { deviceId: "local", sessionId: "owner" }, channel: "reader" })).status, 403);
  assert.equal((await post(body, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.match((await run({ action: "inspect", targetDeviceId: "unknown" })).error, /Unknown trusted Reader device/);
  assert.equal((await post({ ...body, caller: { deviceId: "local", sessionId: "owner" }, params: { action: "abort", target: "worker" } })).status, 400);
  assert.match((await run({ action: "abort" })).error, /no local fallback/);
  assert.match((await run({ action: "wait_for", until: "invalid" })).error, /Unsupported wait_for condition/);
});

test("remote popup supervision uses one canonical local wait and wakes its owner once without a worker", async () => {
  await fixture("publish", { requests: [] });
  const result = await run({ action: "register_wait", waitId: "remote-ui-1", condition: "ui_request", continuation });
  assert.equal(result.registered, true); assert.equal(result.target.deviceId, "remote"); assert.equal(result.readiness.driver, "reader");
  await eventually(() => waits.readPersistentWaitStatus({ waitId: "remote-ui-1" }).waits[0].readiness.status === "ready");
  await fixture("publish", { requests: [{ id: "new-question", method: "select" }] });
  await eventually(() => messages.length === 1);
  assert.match(messages[0].content, /targetDeviceId=remote/);
  const state = waits.readPersistentWaitStatus({ waitId: "remote-ui-1" }); assert.equal(state.waits.length, 0);
  await fixture("publish", { requests: [{ id: "new-question", method: "select" }] });
  await waits.drainLocalOwnerOutboxes(); assert.equal(messages.length, 1);
});

test("remote generation changes invalidate the old durable subscription and never wake it", async () => {
  await fixture("publish", { requests: [] });
  await run({ action: "register_wait", waitId: "remote-ui-2", condition: "ui_request", continuation });
  await eventually(async () => (await fixture("state")).uiListeners > 0);
  await fixture("restart", { generation: "generation-2" });
  await eventually(() => waits.readPersistentWaitStatus({ waitId: "remote-ui-2" }).waits.length === 0);
  await fixture("publish", { requests: [{ id: "different-runtime", method: "confirm" }] });
  assert.equal(messages.length, 1);
});

test("paused and cancelled remote subscriptions cannot be revived by a later popup", async () => {
  await fixture("publish", { requests: [] });
  await run({ action: "register_wait", waitId: "remote-ui-3", condition: "ui_request", continuation });
  const actor = { deviceId: "local", sessionId: "owner" };
  waits.transitionPersistentWait("remote-ui-3", "pause", undefined, actor);
  await fixture("publish", { requests: [{ id: "paused-question", method: "select" }] });
  assert.equal(waits.readPersistentWaitStatus({ waitId: "remote-ui-3" }).waits[0].status, "paused");
  waits.transitionPersistentWait("remote-ui-3", "cancel", undefined, actor);
  await waits.drainLocalOwnerOutboxes(); assert.equal(messages.length, 1);
});
