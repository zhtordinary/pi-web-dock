import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const require = createRequire(import.meta.url);
const core = require("../bin/session-wait-core.cjs");
const identity = (deviceId, sessionId) => ({ deviceId, sessionId, sessionFile: `/synthetic/${deviceId}/${sessionId}.jsonl` });
function fixture(t) { const root = mkdtempSync(join(tmpdir(), "reader-session-wait-core-")); t.after(() => rmSync(root, { recursive: true, force: true })); return { root, channel: "test" }; }

test("persistent wait keeps completion conditions separate and restores from disk", (t) => {
  const { root, channel } = fixture(t); const owner = identity("dev", "owner"); const target = identity("dev", "worker");
  const wait = core.createWait(root, channel, { id: "wait-condition", owner, target, condition: "task_completed", taskId: "task-1" });
  const wrong = core.applyEvent(root, channel, { id: "turn", type: "turn_settled", identity: target, waitId: wait.id, taskId: "task-1" });
  assert.equal(wrong.ignored, true); assert.equal(core.getStatus(root, channel).waits[0].status, "waiting");
  const done = core.applyEvent(root, channel, { id: "task", type: "task_completed", identity: target, waitId: wait.id, taskId: "task-1", success: true, resultLocation: "/synthetic/result.json" });
  assert.equal(done.accepted, true); assert.equal(core.getStatus(root, channel).waits.length, 0);
  const duplicate = core.applyEvent(root, channel, { id: "task", type: "task_completed", identity: target, waitId: wait.id, taskId: "task-1", success: true, resultLocation: "/synthetic/result.json" });
  assert.equal(duplicate.duplicate, true);
  const restored = core.readState(root, channel); assert.equal(restored.waits["wait-condition"], undefined); assert.equal(restored.terminalWaits["wait-condition"].status, "completed"); assert.ok(restored.revision >= 3);
});

test("two-round A to B to C loop invalidates old generation events and stops at acceptance", (t) => {
  const { root, channel } = fixture(t); const owner = identity("dev", "owner"); const A = identity("dev", "A"); const B = identity("dev", "B"); const C = identity("dev", "C");
  const created = core.createPlan(root, channel, { id: "loop", owner, maxRounds: 2, maxWakeups: 20, nodes: [
    { id: "A", role: "development", session: A, condition: "task_completed", taskId: "A-task", continuation: { message: "Continue authorized A development", target: A } },
    { id: "B", role: "testing", session: B, condition: "acceptance_passed", taskId: "B-task", continuation: { message: "Run authorized B tests", target: B } },
    { id: "C", role: "review", session: C, condition: "acceptance_passed", taskId: "C-task", continuation: { message: "Run authorized C review", target: C } },
  ] });
  let plan = created.plan; let wait = created.wait; const completed = [];
  for (const [node, actor, condition, resultLocation] of [["A", A, "task_completed", "/r1/a"], ["B", B, "acceptance_passed", "/r1/b"], ["C", C, "acceptance_passed", "/r1/c"], ["A", A, "task_completed", "/r2/a"], ["B", B, "acceptance_passed", "/r2/b"], ["C", C, "acceptance_passed", "/r2/c"]]) {
    if (plan.handoffStatus !== "accepted") { const pending = core.getStatus(root, channel).outbox.find((item) => item.planId === "loop" && item.status === "pending"); assert.ok(pending); core.claimOutbox(root, channel, pending.id, "processed"); plan = core.getStatus(root, channel).plans[0]; }
    const result = core.applyEvent(root, channel, { id: `${node}-${resultLocation}`, type: condition, identity: actor, planId: "loop", waitId: wait.id, taskId: `${node}-task`, generation: plan.generation, round: plan.round, success: true, resultLocation, ...(condition === "acceptance_passed" ? { acceptance: { criterion: "fixture", digest: "fixture-digest" } } : {}), result: { success: true, resultLocation } });
    assert.equal(result.accepted, true); completed.push(node); const status = core.getStatus(root, channel); plan = status.plans[0]; wait = status.waits.find((candidate) => candidate.id === plan.waitId); if (!wait && plan.status === "completed") break;
  }
  assert.deepEqual(completed, ["A", "B", "C", "A", "B", "C"]);
  assert.equal(plan.status, "completed"); assert.equal(plan.round, 2); assert.ok(plan.history.some((entry) => entry.type === "advanced" && entry.round === 2));
  const stale = core.applyEvent(root, channel, { id: "old-round", type: "acceptance_passed", acceptance: { criterion: "fixture", digest: "fixture-digest" }, identity: C, planId: "loop", waitId: created.wait.id, generation: 1, round: 1, success: true, resultLocation: "/old" });
  assert.equal(stale.ignored, true);
});

test("pause, cancel and late results never revive a wait", (t) => {
  const { root, channel } = fixture(t); const owner = identity("dev", "owner"); const target = identity("dev", "worker");
  const wait = core.createWait(root, channel, { id: "controlled", owner, target, condition: "acceptance_passed" });
  assert.equal(core.transitionWait(root, channel, wait.id, "pause").status, "paused");
  assert.equal(core.transitionWait(root, channel, wait.id, "resume").status, "waiting");
  assert.equal(core.transitionWait(root, channel, wait.id, "cancel").status, "cancelled");
  const late = core.applyEvent(root, channel, { id: "late", type: "acceptance_passed", acceptance: { criterion: "fixture", digest: "fixture-digest" }, identity: target, waitId: wait.id, success: true, resultLocation: "/late" });
  assert.equal(late.ignored, true); assert.equal(late.reason, "wait_cancelled"); assert.equal(core.getStatus(root, channel).waits.length, 0); assert.equal(core.readState(root, channel).terminalWaits[wait.id].status, "cancelled");
});

test("session-wait direct writer rejects a physical legacy lock through a root alias", (t) => {
  const { root, channel } = fixture(t);
  const physical = join(root, "physical");
  const alias = join(root, "alias");
  mkdirSync(physical);
  symlinkSync(physical, alias);
  const lock = join(physical, `${channel}.json.lock`);
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));

  assert.throws(() => core.withTransaction(alias, channel, () => {}), /state lock conflict/);
  assert.equal(readFileSync(join(lock, "owner.json"), "utf8"), JSON.stringify({ pid: process.pid }));
});

test("no-progress budget pauses and corrupt state/lock conflicts fail closed", (t) => {
  const { root, channel } = fixture(t); const owner = identity("dev", "owner"); const target = identity("dev", "worker");
  const plan = core.createPlan(root, channel, { id: "budget", owner, maxRounds: 1, maxNoProgress: 1, nodes: [{ id: "A", session: target, condition: "acceptance_passed", continuation: { message: "Run authorized budget step", target } }] });
  core.applyEvent(root, channel, { id: "p1", type: "progress", identity: target, planId: plan.plan.id, waitId: plan.wait.id, generation: 1, round: 1, progress: "same" });
  const paused = core.applyEvent(root, channel, { id: "p2", type: "progress", identity: target, planId: plan.plan.id, waitId: plan.wait.id, generation: 1, round: 1, progress: "same" });
  assert.equal(paused.accepted, true); assert.equal(core.getStatus(root, channel).plans[0].status, "paused");
  const statePath = core.stateFile(root, channel); writeFileSync(statePath, "{\"schema\":999,\"channel\":\"test\"}"); assert.throws(() => core.readState(root, channel), /unknown/);
  writeFileSync(statePath, JSON.stringify({ ...core.initialState?.(channel) }));
});
