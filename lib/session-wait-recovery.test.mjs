import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { runProcess, waitForWorkerIdle } from "../test-support/test-process.mjs";
const require = createRequire(import.meta.url); const core = require("../bin/session-wait-core.cjs");

test("dead transaction and worker locks recover only after PID liveness fails", (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-lock-recovery-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = `${core.stateFile(root, "reader")}.lock`; mkdirSync(lock, { recursive: true });
  const owner = process.platform === "linux" ? { pid: 999999, startToken: "1" } : { pid: 999999 };
  writeFileSync(join(lock, "owner.json"), JSON.stringify(owner));
  const result = core.createWait(root, "reader", { id: "lock-wait", owner: { deviceId: "d", sessionId: "a" }, target: { deviceId: "d", sessionId: "b" }, condition: "turn_settled" });
  assert.equal(result.id, "lock-wait"); assert.equal(core.readState(root, "reader").waits["lock-wait"].status, "waiting");
});

test("legacy migration retains incomplete owner identity and physical unknown locks", (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-lock-unknown-owner-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = `${core.stateFile(root, "reader")}.lock`; mkdirSync(lock, { recursive: true });
  const malformedOwner = process.platform === "linux" ? { pid: 999999 } : { pid: "999999" };
  writeFileSync(join(lock, "owner.json"), JSON.stringify(malformedOwner));
  assert.throws(() => core.createWait(root, "reader", { id: "blocked", owner: { deviceId: "d", sessionId: "a" }, target: { deviceId: "d", sessionId: "b" }, condition: "turn_settled" }), { code: "ELOCKED" });
  assert.equal(existsSync(lock), true); assert.equal(existsSync(join(lock, "owner.json")), true);
  rmSync(lock, { recursive: true, force: true });
  symlinkSync(join(root, "missing-lock-target"), lock);
  assert.throws(() => core.createWait(root, "reader", { id: "blocked-link", owner: { deviceId: "d", sessionId: "a" }, target: { deviceId: "d", sessionId: "b" }, condition: "turn_settled" }), { code: "ELOCKED" });
  assert.equal(lstatSync(lock).isSymbolicLink(), true);
  rmSync(lock, { force: true });
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(root, "owner-target.json"), JSON.stringify({ pid: 999999 }));
  symlinkSync(join(root, "owner-target.json"), join(lock, "owner.json"));
  assert.throws(() => core.createWait(root, "reader", { id: "blocked-owner-link", owner: { deviceId: "d", sessionId: "a" }, target: { deviceId: "d", sessionId: "b" }, condition: "turn_settled" }), { code: "ELOCKED" });
  assert.equal(lstatSync(join(lock, "owner.json")).isSymbolicLink(), true);
  rmSync(lock, { recursive: true, force: true });
  writeFileSync(lock, "unknown lock entity");
  assert.throws(() => core.createWait(root, "reader", { id: "blocked-entity", owner: { deviceId: "d", sessionId: "a" }, target: { deviceId: "d", sessionId: "b" }, condition: "turn_settled" }), { code: "ELOCKED" });
  assert.equal(lstatSync(lock).isFile(), true);
});

test("external exit without a real result file is failed and not verified", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-external-evidence-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const task = core.enqueueExternalTask(root, "reader", { id: "no-result", argv: [process.execPath, "-e", "process.exit(0)"], resultLocation: join(root, "missing-result.json") });
  const running = core.spawnStructuredTask(root, "reader", task.id); await new Promise((resolve) => running.child.once("close", resolve));
  const saved = core.listExternalTasks(root, "reader").find((item) => item.id === task.id); assert.equal(saved.status, "failed"); assert.equal(saved.resultVerified, false);
});

test("running external task becomes blocked after worker crash and is not rerun", (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-external-unknown-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const task = core.enqueueExternalTask(root, "reader", { id: "unknown", argv: [process.execPath, "-e", "setTimeout(()=>{},10000)"], resultLocation: join(root, "result.json") });
  core.updateExternalTask(root, "reader", task.id, { status: "running", pid: 999999, startToken: "unknown" }); core.recoverState(root, "reader");
  const recovered = core.listExternalTasks(root, "reader").find((item) => item.id === task.id); assert.equal(recovered.status, "blocked"); assert.equal(core.spawnStructuredTask(root, "reader", task.id).child, null);
});

test("in-flight delivery becomes unknown and cancelled waits revoke pending continuation", (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-delivery-race-")); t.after(() => rmSync(root, { recursive: true, force: true })); const owner = { deviceId: "d", sessionId: "owner" }; const target = { deviceId: "d", sessionId: "target" }; const wait = core.createWait(root, "reader", { id: "race", owner, target, condition: "task_completed", taskId: "race-task", continuation: { target: owner, authorizedScope: ["resume_prior_work"], message: "race continuation" } });
  core.applyEvent(root, "reader", { id: "race-event", type: "task_completed", identity: target, waitId: wait.id, taskId: "race-task", success: true, resultLocation: "/fixture/result" }); const item = Object.values(core.readState(root, "reader").outbox)[0]; core.claimOutbox(root, "reader", item.id, "in_flight"); core.recoverState(root, "reader"); assert.equal(core.readState(root, "reader").outbox[item.id].status, "unknown");
  const wait2 = core.createWait(root, "reader", { id: "cancel-race", owner, target, condition: "task_completed", taskId: "cancel-task", continuation: { target: owner, authorizedScope: ["resume_prior_work"], message: "cancel me" } }); const inbox = core.acceptInbox(root, "reader", { messageId: "cancel-message", sender: target, recipient: owner.deviceId, operation: "wake", body: { waitId: wait2.id, target: owner, continuation: { target: owner, authorizedScope: ["resume_prior_work"], message: "cancel me" } } }); assert.equal(inbox.duplicate, false); core.completeInbox(root, "reader", "cancel-message", "queued"); core.transitionWait(root, "reader", wait2.id, "cancel", "user cancelled", owner); assert.equal(core.inboxWakeDecision(root, "reader", "cancel-message", owner.sessionId).allowed, false);
  const crashInbox = core.acceptInbox(root, "reader", { messageId: "crash-message", sender: target, recipient: owner.deviceId, operation: "wake", body: { target: owner, continuation: { target: owner, authorizedScope: ["resume_prior_work"], message: "may have run" } } }); assert.equal(crashInbox.duplicate, false); core.completeInbox(root, "reader", "crash-message", "in_flight"); core.recoverState(root, "reader"); assert.equal(core.readState(root, "reader").inbox["crash-message"].status, "unknown");
});

test("worker lock recovers a complete abandoned PID identity after SIGKILL", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-worker-sigkill-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worker = join(process.cwd(), "bin/session-wait-worker.cjs");
  const health = join(root, "health.json");
  const child = spawn(process.execPath, [worker, "--state-root", root, "--channel", "reader",
    "--health-file", health, "--poll-ms", "60000"], { stdio: "ignore" });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const lock = join(root, ".worker-reader.lock");
  await waitForWorkerIdle(child, health, { releasedLock: lock });
  // Complete abandoned-lock fixture: no crash is injected into an owner-write window.
  mkdirSync(lock);
  const lockIdentity = require("../bin/session-wait-lock.cjs");
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: child.pid,
    startToken: lockIdentity.startIdentity(child.pid), nonce: "fixture", acquiredAt: new Date().toISOString() }));
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGKILL");
  await closed;
  const restarted = await runProcess(process.execPath, [worker, "--state-root", root, "--channel", "reader", "--once"]);
  assert.equal(restarted.code, 0, restarted.stderr);
});
