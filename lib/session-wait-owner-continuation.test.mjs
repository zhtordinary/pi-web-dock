import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url); const core = require("../bin/session-wait-core.cjs");

test("ordinary wait completion drains the owner outbox into the exact live owner session", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-owner-continuation-")); const old = { root: process.env.PI_WEB_SESSION_WAIT_STATE_ROOT, channel: process.env.PI_WEB_SESSION_WAIT_CHANNEL, device: process.env.PI_WEB_DEVICE_ID, config: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG };
  process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = root; process.env.PI_WEB_SESSION_WAIT_CHANNEL = "r1"; process.env.PI_WEB_DEVICE_ID = "dev"; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "dev", name: "fixture" } });
  const calls = []; const previous = globalThis.__piSessions; globalThis.__piSessions = new Map([["A", { sessionId: "A", sessionFile: "/fixture/dev/A.jsonl", isAlive: () => true, isRunning: () => false, inner: { isBashRunning: false, isCompacting: false }, hasPendingUserInteraction: () => false, sendNativePeerMessage: async (message, options) => { calls.push({ message, options }); } }]]);
  t.after(() => { rmSync(root, { recursive: true, force: true }); globalThis.__piSessions = previous; for (const [key, value] of Object.entries({ PI_WEB_SESSION_WAIT_STATE_ROOT: old.root, PI_WEB_SESSION_WAIT_CHANNEL: old.channel, PI_WEB_DEVICE_ID: old.device, PI_WEB_SESSION_ACTIVITY_CONFIG: old.config })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }); const waits = await jiti.import("./session-waits.ts");
  const wait = waits.createPersistentWait({ id: "ordinary-owner", owner: { deviceId: "dev", sessionId: "A", sessionFile: "/fixture/dev/A.jsonl" }, target: { deviceId: "dev", sessionId: "B", sessionFile: "/fixture/dev/B.jsonl" }, condition: "task_completed", taskId: "task-1", continuation: { target: { deviceId: "dev", sessionId: "A", sessionFile: "/fixture/dev/A.jsonl" }, authorizedScope: ["resume_prior_work"], message: "Continue the approved owner work" } });
  const result = waits.applyPersistentEvent({ id: "task-1-complete", type: "task_completed", identity: { deviceId: "dev", sessionId: "B", sessionFile: "/fixture/dev/B.jsonl" }, waitId: wait.id, taskId: "task-1", success: true, resultLocation: "/fixture/result.json" });
  assert.equal(result.accepted, true); await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls[0].message.customType, "pi-web:session-peer"); assert.equal(calls[0].message.content, "Continue the approved owner work"); assert.equal(calls[0].message.details.source, "session-control-wake"); assert.equal(calls[0].options.triggerTurn, true);
  assert.equal(core.readState(root, "r1").outbox[Object.keys(core.readState(root, "r1").outbox)[0]].status, "processed");
});

for (const scenario of ["ordinary-cancel", "plan-cancel", "plan-pause"]) test(`${scenario} during admission cannot submit a stale continuation`, async t => {
  const root = mkdtempSync(join(tmpdir(), "session-owner-admission-"));
  const keys = ["PI_WEB_SESSION_WAIT_STATE_ROOT", "PI_WEB_SESSION_WAIT_CHANNEL", "PI_WEB_DEVICE_ID", "PI_WEB_SESSION_ACTIVITY_CONFIG"];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = root; process.env.PI_WEB_SESSION_WAIT_CHANNEL = "admission";
  process.env.PI_WEB_DEVICE_ID = "dev"; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "dev" } });
  const previous = globalThis.__piSessions, calls = []; let waitId, changed = false;
  const owner = { deviceId: "dev", sessionId: "A", sessionFile: "/fixture/A.jsonl" };
  const target = { deviceId: "dev", sessionId: "B", sessionFile: "/fixture/B.jsonl" };
  const continuation = { target: owner, authorizedScope: ["resume_prior_work"], message: "approved continuation" };
  globalThis.__piSessions = new Map([["A", { sessionId: "A", sessionFile: owner.sessionFile, isAlive: () => true, isRunning: () => false, inner: {}, hasPendingUserInteraction: () => false, sendNativePeerMessage: async (message, options) => {
    await Promise.resolve();
    if (!changed) { changed = true; core.transitionWait(root, "admission", waitId, scenario === "plan-pause" ? "pause" : "cancel"); }
    if (options.beforeSubmit && !options.beforeSubmit()) throw new Error("notification_no_longer_pending");
    calls.push(message);
  } }]]);
  t.after(() => { globalThis.__piSessions = previous; for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } rmSync(root, { recursive: true, force: true }); });
  const waits = await createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }).import("./session-waits.ts");
  if (scenario === "ordinary-cancel") {
    const wait = core.createWait(root, "admission", { id: "wait", owner, target, condition: "task_completed", continuation }); waitId = wait.id;
    core.applyEvent(root, "admission", { id: "done", type: "task_completed", identity: target, waitId, success: true, resultLocation: "/fixture/result" });
  } else {
    const plan = core.createPlan(root, "admission", { id: "plan", owner: target, maxRounds: 1, nodes: [{ id: "node", session: owner, condition: "task_completed", continuation }] }); waitId = plan.wait.id;
  }
  await waits.drainLocalOwnerOutboxes();
  const item = Object.values(core.readState(root, "admission").outbox).find(value => value.waitId === waitId);
  assert.equal(calls.length, 0);
  assert.equal(item.status, scenario === "plan-pause" ? "pending" : "cancelled");
  if (scenario === "plan-pause") {
    waits.transitionPersistentWait(waitId, "resume"); await waits.drainLocalOwnerOutboxes();
    assert.equal(calls.length, 1);
    assert.equal(core.readState(root, "admission").outbox[item.id].status, "processed");
  }
});

test("owner delivery waits for running, bash, compaction and user interaction, then retries without stream traffic", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-owner-busy-"));
  const keys = ["PI_WEB_SESSION_WAIT_STATE_ROOT", "PI_WEB_SESSION_WAIT_CHANNEL", "PI_WEB_DEVICE_ID", "PI_WEB_SESSION_ACTIVITY_CONFIG"];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = root; process.env.PI_WEB_SESSION_WAIT_CHANNEL = "busy";
  process.env.PI_WEB_DEVICE_ID = "dev"; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "dev" } });
  let mode = "running"; const calls = []; const previous = globalThis.__piSessions;
  const inner = { get isBashRunning() { return mode === "bash"; }, get isCompacting() { return mode === "compaction"; } };
  globalThis.__piSessions = new Map([["A", { sessionId: "A", sessionFile: "/fixture/A.jsonl", isAlive: () => true, isRunning: () => mode === "running", inner, hasPendingUserInteraction: () => mode === "user", sendNativePeerMessage: async (message, options) => calls.push({ message, options }) }]]);
  t.after(() => { rmSync(root, { recursive: true, force: true }); globalThis.__piSessions = previous; for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } });
  const waits = await createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }).import("./session-waits.ts");
  for (const busy of ["running", "bash", "compaction", "user"]) {
    mode = busy;
    const before = calls.length;
    const wait = core.createWait(root, "busy", { id: busy, owner: { deviceId: "dev", sessionId: "A", sessionFile: "/fixture/A.jsonl" }, target: { deviceId: "dev", sessionId: "B" }, condition: "task_completed", continuation: { target: { deviceId: "dev", sessionId: "A", sessionFile: "/fixture/A.jsonl" }, authorizedScope: ["resume_prior_work"], message: busy } });
    waits.applyPersistentEvent({ id: `done-${busy}`, type: "task_completed", identity: { deviceId: "dev", sessionId: "B" }, waitId: wait.id, success: true, resultLocation: "/fixture/result.json" });
    await waits.drainLocalOwnerOutboxes();
    assert.equal(calls.length, before, busy);
    assert.equal(Object.values(core.readState(root, "busy").outbox).find(item => item.waitId === wait.id).status, "pending");
    mode = "idle";
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(calls.length, before + 1, `${busy} must retry without another event`);
    assert.equal(calls.at(-1).message.content, busy);
    assert.equal(calls.at(-1).message.customType, "pi-web:session-peer");
    assert.equal(calls.at(-1).options.triggerTurn, true);
    assert.equal(Object.values(core.readState(root, "busy").outbox).find(item => item.waitId === wait.id).status, "processed");
  }
});
