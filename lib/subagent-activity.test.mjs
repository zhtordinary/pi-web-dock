import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = await mkdtemp(join(tmpdir(), "pi-subagent-activity-"));
const asyncRoot = join(root, "async-subagent-runs");
await mkdir(asyncRoot, { recursive: true });
process.env.PI_SUBAGENTS_TEMP_ROOT = root;
const activity = await import("./subagent-activity.ts");

async function writeStatus(runId, status) {
  const directory = join(asyncRoot, runId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "status.json"), `${JSON.stringify(status)}\n`);
}

function session(id) {
  return { id, path: `/tmp/${id}.jsonl` };
}

test.after(async () => {
  delete process.env.PI_SUBAGENTS_TEMP_ROOT;
  await rm(root, { recursive: true, force: true });
});

test("projects a live async child onto its parent session", async () => {
  const parent = session("parent-running");
  await writeStatus("run-running", {
    runId: "run-running",
    sessionId: parent.path,
    state: "running",
    activityState: "active_long_running",
    currentTool: "bash",
  });

  assert.deepEqual(activity.getSubagentActivityForSessions([parent]).get(parent.id), {
    active: true,
  });
});

test("projects a detached runner's live state onto its child transcript", async () => {
  const parent = session("parent-with-child");
  const child = session("child-running");
  await writeStatus("run-child-running", {
    runId: "run-child-running",
    sessionId: parent.path,
    state: "running",
    steps: [{ sessionFile: child.path, status: "running" }],
  });

  const activities = activity.getSubagentActivityForSessions([parent, child]);
  assert.deepEqual(activities.get(parent.id), { active: true });
  assert.deepEqual(activities.get(child.id), { active: true });
  assert.deepEqual(activity.getSessionBackgroundRunIds(child), ["run-child-running"]);
});

test("an observed process terminal overrides a stale running artifact", async () => {
  const parent = session("parent-stale-running");
  await writeStatus("run-stale-running", {
    sessionId: parent.path, state: "running", pid: process.pid,
    processTerminal: { state: "observed" }, steps: [{ status: "running" }],
  });
  assert.notEqual(activity.getSubagentActivityForSessions([parent]).get(parent.id)?.active, true);
});

test("keeps supervisor attention as internal activity", async () => {
  const parent = session("parent-attention");
  await writeStatus("run-attention", {
    runId: "run-attention",
    sessionId: parent.path,
    state: "running",
    activityState: "needs_attention",
    currentTool: "contact_supervisor",
  });

  assert.deepEqual(activity.getSubagentActivityForSessions([parent]).get(parent.id), {
    active: true,
  });
});

test("keeps paused supervisor attention as internal activity", async () => {
  const parent = session("parent-paused-attention");
  await writeStatus("run-paused-attention", {
    runId: "run-paused-attention",
    sessionId: parent.path,
    state: "paused",
    activityState: "needs_attention",
    currentTool: "contact_supervisor",
  });

  assert.deepEqual(activity.getSubagentActivityForSessions([parent]).get(parent.id), {
    active: true,
  });
});

test("ignores terminal and foreign async runs", async () => {
  const parent = session("parent-terminal");
  await writeStatus("run-terminal", {
    runId: "run-terminal",
    sessionId: parent.path,
    state: "complete",
  });
  await writeStatus("run-foreign", {
    runId: "run-foreign",
    sessionId: "/tmp/another-session.jsonl",
    state: "running",
  });

  assert.equal(activity.getSubagentActivityForSessions([parent]).has(parent.id), false);
});

test("projects an observed terminal completion without reviving activity", async () => {
  const parent = session("parent-completed");
  await writeStatus("run-completed", {
    runId: "run-completed",
    sessionId: parent.path,
    state: "complete",
    startedAt: 100,
    endedAt: 200,
    processTerminal: { state: "observed" },
  });
  assert.deepEqual(activity.getSubagentActivityForSessions([parent]).get(parent.id), {
    active: false,
    terminalState: "completed",
    terminalAt: 200,
  });
});
test("terminal workflow state overrides stale live steps", async () => {
  const parent = session("parent-failed-with-stale-step");
  await writeStatus("run-failed-with-stale-step", {
    runId: "run-failed-with-stale-step",
    sessionId: parent.path,
    state: "failed",
    pid: process.pid,
    steps: [{ status: "running" }],
    workflowChildren: {
      version: 1,
      workflowState: "failed",
      inventoryComplete: true,
      children: [{ childId: "child", state: "failed" }],
    },
  });

  assert.equal(activity.getSubagentActivityForSessions([parent]).has(parent.id), false);
});
