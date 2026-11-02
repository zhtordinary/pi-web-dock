import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url); const core = require("../bin/session-wait-core.cjs");

test("plan creation and startup recovery drain the local exact-session outbox", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-wait-startup-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = { root: process.env.PI_WEB_SESSION_WAIT_STATE_ROOT, device: process.env.PI_WEB_DEVICE_ID, config: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG }; process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = root; process.env.PI_WEB_DEVICE_ID = "device-local"; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "device-local" } });
  t.after(() => { for (const [key, value] of Object.entries({ PI_WEB_SESSION_WAIT_STATE_ROOT: old.root, PI_WEB_DEVICE_ID: old.device, PI_WEB_SESSION_ACTIVITY_CONFIG: old.config })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const calls = []; const previous = globalThis.__piSessions; globalThis.__piSessions = new Map([["owner", { sessionId: "owner", sessionFile: "/fixture/owner.jsonl", isAlive: () => true, isRunning: () => false, inner: { isBashRunning: false, isCompacting: false }, hasPendingUserInteraction: () => false, sendNativePeerMessage: async (message, options) => calls.push({ message, options }) }]]); t.after(() => { globalThis.__piSessions = previous; });
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }); const waits = await jiti.import("./session-waits.ts");
  waits.createHandoffPlan({ id: "startup-plan", owner: { deviceId: "device-local", sessionId: "owner" }, maxRounds: 1, nodes: [{ id: "owner", session: { deviceId: "device-local", sessionId: "owner", sessionFile: "/fixture/owner.jsonl" }, condition: "task_completed", continuation: { target: { deviceId: "device-local", sessionId: "owner", sessionFile: "/fixture/owner.jsonl" }, authorizedScope: ["resume_prior_work"], message: "run from plan creation" } }] });
  await new Promise((resolve) => setTimeout(resolve, 120)); assert.equal(calls[0].message.customType, "pi-web:session-peer"); assert.equal(calls[0].message.content, "run from plan creation"); assert.equal(calls[0].options.triggerTurn, true); const outbox = Object.values(core.readState(root, "reader").outbox)[0]; assert.equal(outbox.status, "processed");
  core.createPlan(root, "reader", { id: "restart-plan", owner: { deviceId: "device-local", sessionId: "owner" }, maxRounds: 1, nodes: [{ id: "owner", session: { deviceId: "device-local", sessionId: "owner", sessionFile: "/fixture/owner.jsonl" }, condition: "task_completed", continuation: { target: { deviceId: "device-local", sessionId: "owner", sessionFile: "/fixture/owner.jsonl" }, authorizedScope: ["resume_prior_work"], message: "run after restart" } }] });
  await waits.initializeSessionWaitRuntime(); await new Promise((resolve) => setTimeout(resolve, 120)); assert.equal(calls.at(-1)?.message.content, "run after restart"); assert.equal(calls.at(-1)?.message.customType, "pi-web:session-peer");
});
