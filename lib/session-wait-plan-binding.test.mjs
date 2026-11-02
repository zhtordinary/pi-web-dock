import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const require = createRequire(import.meta.url); const core = require("../bin/session-wait-core.cjs");
const id = (deviceId, sessionId) => ({ deviceId, sessionId, sessionFile: `/fixture/${deviceId}/${sessionId}.jsonl` });
function fixture(t) { const root = mkdtempSync(join(tmpdir(), "session-plan-binding-")); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

test("plan result requires exact wait/task/generation/round binding", (t) => {
  const root = fixture(t); const owner = id("d", "owner"); const target = id("d", "A"); const plan = core.createPlan(root, "reader", { id: "binding", owner, maxRounds: 1, nodes: [{ id: "A", session: target, condition: "task_completed", taskId: "A-task", continuation: { message: "A", target } }] });
  const missing = core.applyEvent(root, "reader", { id: "missing-task", type: "task_completed", identity: target, planId: plan.plan.id, waitId: plan.wait.id, generation: 1, round: 1, success: true, resultLocation: "/fixture/result" }); assert.equal(missing.reason, "plan_event_missing_binding");
  const wrongWait = core.applyEvent(root, "reader", { id: "wrong-wait", type: "task_completed", identity: target, planId: plan.plan.id, waitId: "not-current", taskId: "A-task", generation: 1, round: 1, success: true, resultLocation: "/fixture/result" }); assert.equal(wrongWait.reason, "plan_wait_mismatch");
});

test("acceptance needs a structured receipt and dependencies require current successful results", (t) => {
  const root = fixture(t); const owner = id("d", "owner"); const target = id("d", "target"); const wait = core.createWait(root, "reader", { id: "acceptance", owner, target, condition: "acceptance_passed" }); assert.throws(() => core.applyEvent(root, "reader", { id: "no-receipt", type: "acceptance_passed", identity: target, waitId: wait.id, success: true, resultLocation: "/fixture/result" }), /criterion and digest receipt/);
  const plan = core.createPlan(root, "reader", { id: "depends", owner, maxRounds: 1, nodes: [{ id: "A", session: target, condition: "task_completed", taskId: "A-task", nextOnFailure: "B", continuation: { message: "A", target } }, { id: "B", session: target, condition: "acceptance_passed", taskId: "B-task", dependsOn: ["A"], continuation: { message: "B", target } }] }); core.claimOutbox(root, "reader", plan.plan.waitId ? Object.values(core.readState(root, "reader").outbox).find((item) => item.planId === "depends").id : "", "processed"); const failed = core.applyEvent(root, "reader", { id: "A-failed", type: "task_failed", identity: target, planId: "depends", waitId: plan.wait.id, taskId: "A-task", generation: 1, round: 1, reason: "fixture failure" }); assert.equal(failed.accepted, true); assert.equal(core.getStatus(root, "reader").plans.find((item) => item.id === "depends").status, "blocked");
});

test("pre-approved acceptance digest cannot be replaced by criterion-only match", (t) => {
  const root = fixture(t); const owner = id("d", "owner"); const target = id("d", "target"); const plan = core.createPlan(root, "reader", { id: "digest-plan", owner, maxRounds: 1, nodes: [{ id: "A", session: target, condition: "acceptance_passed", taskId: "A-task", acceptance: { criterion: "fixture", digest: "approved" }, continuation: { message: "A", target } }] }); const initial = Object.values(core.readState(root, "reader").outbox).find((item) => item.planId === "digest-plan"); core.claimOutbox(root, "reader", initial.id, "processed"); const rejected = core.applyEvent(root, "reader", { id: "wrong-digest", type: "acceptance_passed", identity: target, planId: "digest-plan", waitId: plan.wait.id, taskId: "A-task", generation: 1, round: 1, success: true, resultLocation: "/fixture/result", acceptance: { criterion: "fixture", digest: "wrong" } }); assert.equal(rejected.rejected, true); assert.match(rejected.reason, /acceptance receipt does not match/); assert.equal(core.readState(root, "reader").waits[plan.wait.id].status, "waiting");
});
