import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { completedSessionRuns } = await createJiti(import.meta.url).import("./session-run-completion.ts");

function item(status = "running", { device = "local", runId = "run-1", ...overrides } = {}) {
  const run = { runId, sessionId: "session-1", status };
  return { device: typeof device === "string" ? { id: device, online: true } : device, session: { id: "session-1" },
    status: status === "completed" ? "just_completed" : status,
    latestRun: run, runs: [run], ...overrides };
}
const snapshot = (...sessions) => ({ sessions });
const initialStart = { device: "local", sessionId: "session-1", runId: "run-1" };

test("only an observed running run can complete; initial history and missing sessions stay silent", () => {
  const done = item("completed");
  assert.deepEqual(completedSessionRuns(null, snapshot(done)), []);
  assert.deepEqual(completedSessionRuns(snapshot(), snapshot(done)), []);
  assert.deepEqual(completedSessionRuns(snapshot(item()), snapshot()), []);
  assert.deepEqual(completedSessionRuns(snapshot(item()), snapshot(done)), [done]);
  assert.deepEqual(completedSessionRuns(snapshot(done), snapshot(done)), []);
});

test("completion is keyed by device/session/run and does not resurrect unknown runs", () => {
  const done = item("completed", { device: "remote" });
  assert.deepEqual(completedSessionRuns(snapshot(item()), snapshot(done)), []);
  assert.deepEqual(completedSessionRuns(snapshot(item("running", { device: "remote", runId: "older" })), snapshot(done)), []);
  assert.deepEqual(completedSessionRuns(snapshot(item("running", { device: "remote" })), snapshot(done)), [done]);
  assert.deepEqual(completedSessionRuns(snapshot(item("unknown")), snapshot(item("completed"))), []);
});

test("an initial live-start identity can supply the missing observation, but never terminal metadata", () => {
  for (const status of ["completed", "failed", "aborted"]) {
    const done = item(status);
    assert.deepEqual(completedSessionRuns(null, snapshot(done), [initialStart]), [done]);
    assert.deepEqual(completedSessionRuns(null, snapshot(done), [{ ...initialStart, device: "other" }]), []);
    assert.deepEqual(completedSessionRuns(null, snapshot(done), [{ ...initialStart, sessionId: "other" }]), []);
    assert.deepEqual(completedSessionRuns(null, snapshot(done), [{ ...initialStart, runId: "other" }]), []);
  }
  assert.deepEqual(completedSessionRuns(null, snapshot(), [initialStart]), []);
  assert.deepEqual(completedSessionRuns(null, snapshot(item()), [initialStart]), []);
  assert.deepEqual(completedSessionRuns(null, snapshot(item("unknown")), [initialStart]), []);
});

test("disconnects, retry queues and pending prompts never masquerade as completion", () => {
  const previous = snapshot(item());
  for (const overrides of [{ device: { id: "local", online: false } }, { currentActivity: { active: true } },
    { status: "running" }, { status: "retrying" }, { status: "waiting_user" }]) {
    assert.deepEqual(completedSessionRuns(previous, snapshot(item("completed", overrides))), []);
    assert.deepEqual(completedSessionRuns(null, snapshot(item("completed", overrides)), [initialStart]), []);
  }
  const promptPending = item("completed", { status: "running", currentActivity: { active: true } });
  const idle = item("completed", { status: "idle", currentActivity: { active: false } });
  assert.deepEqual(completedSessionRuns(snapshot(promptPending), snapshot(idle)), [idle]);
});

test("failed and aborted runs are terminal but unknown or identity-less observations are not", () => {
  for (const status of ["failed", "aborted"]) {
    const terminal = item(status);
    assert.deepEqual(completedSessionRuns(snapshot(item()), snapshot(terminal)), [terminal]);
  }
  assert.deepEqual(completedSessionRuns(snapshot(item()), snapshot(item("unknown"))), []);
  assert.deepEqual(completedSessionRuns(snapshot(item()), snapshot(item("completed", { runId: "" }))), []);
});
