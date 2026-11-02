import assert from "node:assert/strict";
import { createJiti } from "jiti";
import test from "node:test";

test("wake bridge submits the approved continuation to the exact live session and queues busy targets", async (t) => {
  const oldDevice = process.env.PI_WEB_DEVICE_ID; const oldConfig = process.env.PI_WEB_SESSION_ACTIVITY_CONFIG; process.env.PI_WEB_DEVICE_ID = "device-a"; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "device-a", name: "fixture" } });
  const previous = globalThis.__piSessions;
  const calls = [];
  const makeSession = (running) => ({ sessionId: "session-a", sessionFile: "/fixture/session-a.jsonl", isAlive: () => true, isRunning: () => running, inner: { isBashRunning: false, isCompacting: false }, hasPendingUserInteraction: () => false, sendNativePeerMessage: async (message, options) => { calls.push({ message, options }); } });
  globalThis.__piSessions = new Map([["session-a", makeSession(false)]]);
  t.after(() => { globalThis.__piSessions = previous; if (oldDevice === undefined) delete process.env.PI_WEB_DEVICE_ID; else process.env.PI_WEB_DEVICE_ID = oldDevice; if (oldConfig === undefined) delete process.env.PI_WEB_SESSION_ACTIVITY_CONFIG; else process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = oldConfig; });
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
  const { queueAuthorizedSessionWake } = await jiti.import("./session-control-wake.ts");
  const submitted = await queueAuthorizedSessionWake({ deviceId: "device-a", sessionId: "session-a", operation: "resume_prior_authorized_work", authorizedScope: ["resume_prior_work"], continuation: { target: { deviceId: "device-a", sessionId: "session-a" }, authorizedScope: ["resume_prior_work"], message: "Continue the approved next round" } });
  assert.equal(submitted.status, "submitted"); assert.equal(calls[0].message.customType, "pi-web:session-peer"); assert.equal(calls[0].message.content, "Continue the approved next round"); assert.equal(calls[0].message.details.source, "session-control-wake"); assert.equal(calls[0].options.triggerTurn, true);
  globalThis.__piSessions.set("session-a", makeSession(true));
  const queued = await queueAuthorizedSessionWake({ deviceId: "device-a", sessionId: "session-a", operation: "resume_prior_authorized_work", authorizedScope: ["resume_prior_work"], continuation: { target: { deviceId: "device-a", sessionId: "session-a" }, authorizedScope: ["resume_prior_work"], message: "Do not preempt the busy session" } });
  assert.equal(queued.status, "queued_busy"); assert.equal(calls.length, 1);
  const mismatch = await queueAuthorizedSessionWake({ deviceId: "device-a", sessionId: "session-a", operation: "resume_prior_authorized_work", authorizedScope: ["resume_prior_work"], continuation: { target: { deviceId: "device-b", sessionId: "session-a" }, authorizedScope: ["resume_prior_work"], message: "wrong device must not run" } });
  assert.equal(mismatch.status, "blocked"); assert.equal(mismatch.reason, "continuation target device mismatch");
});
