import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const directory = await mkdtemp(join(tmpdir(), "pi-session-activity-"));
const activityFile = join(directory, "activity.json");
process.env.PI_WEB_SESSION_ACTIVITY_FILE = activityFile;
const activity = await import("./session-activity.ts");
const retryStatus = await import("./session-activity-status.ts");

test.after(async () => {
  globalThis.__piSessionActivityRuntime = undefined;
  await rm(directory, { recursive: true, force: true });
});

test("records a completed run and retains its timing", async () => {
  globalThis.__piSessionActivityRuntime = undefined;
  const started = activity.recordSessionRunStart("session-complete", "/tmp/project");
  activity.touchSessionRun("session-complete");
  activity.recordSessionRunSettled("session-complete");

  const [record] = activity.getSessionRunRecords();
  assert.equal(record.runId, started.runId);
  assert.equal(record.status, "completed");
  assert.equal(record.sessionId, "session-complete");
  assert.ok(record.completedAt);
  assert.ok(record.updatedAt >= record.startedAt);
  assert.match(await readFile(activityFile, "utf8"), /session-complete/);
});

test("a runtime without a run cannot mark another runtime unknown", () => {
  const sessionId = "session-no-run-owner";
  const started = activity.recordSessionRunStart(sessionId, "/tmp/project");
  activity.recordSessionRunUnknown(sessionId, null);
  const record = activity.getSessionRunRecords().find((item) => item.runId === started.runId);
  assert.equal(record.status, "running");
  activity.recordSessionRunSettled(sessionId, started.runId);
});

test("late completion reconciles its own unknown run without settling a newer run", () => {
  const sessionId = "session-late-completion";
  const original = activity.recordSessionRunStart(sessionId, "/tmp/project");
  activity.recordSessionRunUnknown(sessionId, original.runId);
  const newer = activity.recordSessionRunStart(sessionId, "/tmp/project");
  assert.notEqual(newer.runId, original.runId);
  activity.recordSessionRunSettled(sessionId, original.runId);
  activity.recordSessionRunError(sessionId, "late stale error", false, original.runId);
  const records = activity.getSessionRunRecords();
  assert.equal(records.find((item) => item.runId === original.runId).status, "completed");
  assert.equal(records.find((item) => item.runId === newer.runId).status, "running");
  activity.recordSessionRunSettled(sessionId, newer.runId);
  assert.equal(activity.getSessionRunRecords().find((item) => item.runId === newer.runId).status, "completed");
});

test("run identity cannot cross sessions or replace failure and abort outcomes", () => {
  const failed = activity.recordSessionRunStart("session-owned-failure", "/tmp/project");
  const aborted = activity.recordSessionRunStart("session-owned-abort", "/tmp/project");
  activity.recordSessionRunUnknown(aborted.sessionId, failed.runId);
  assert.equal(activity.getSessionRunRecords().find((item) => item.runId === aborted.runId).status, "running");
  activity.recordSessionRunError(failed.sessionId, "fixture failure", false, failed.runId);
  activity.recordSessionRunAbort(aborted.sessionId, false, aborted.runId);
  for (const record of [failed, aborted]) {
    activity.recordSessionRunSettled(record.sessionId, record.runId);
    activity.recordSessionRunUnknown(record.sessionId, record.runId);
  }
  const records = activity.getSessionRunRecords();
  assert.equal(records.find((item) => item.runId === failed.runId).status, "failed");
  assert.equal(records.find((item) => item.runId === aborted.runId).status, "aborted");
});

test("records a bounded failure summary", () => {
  globalThis.__piSessionActivityRuntime = undefined;
  activity.recordSessionRunStart("session-failed", "/tmp/project");
  activity.recordSessionRunError("session-failed", `  ${"x".repeat(400)}  `);

  const record = activity.getSessionRunRecords().find((item) => item.sessionId === "session-failed");
  assert.equal(record?.status, "failed");
  assert.equal(record?.error?.length, 280);
  assert.ok(record?.completedAt);
});

test("detects assistant stream errors from agent_end", () => {
  assert.equal(activity.agentEndErrorMessage({
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "error", errorMessage: " stream_read_error " }],
  }), "stream_read_error");
  assert.equal(activity.agentEndErrorMessage({
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop" }],
  }), undefined);
});

test("persists unattended preference and scheduler across process reload", async () => {
  globalThis.__piSessionActivityRuntime = undefined;
  const schedulerState = {
    active: true,
    reason: "error",
    attempt: 2,
    nextDelayMs: 60_000,
    nextRetryAt: Date.now() + 60_000,
    errorMessage: "503 Service Unavailable",
    key: "user:turn-1:继续",
  };
  activity.setPersistedUnattendedState("session-unattended", true, schedulerState);
  assert.deepEqual(activity.getPersistedUnattendedState("session-unattended"), {
    enabled: true,
    schedulerState,
    updatedAt: activity.getPersistedUnattendedState("session-unattended").updatedAt,
  });
  assert.equal(activity.listPersistedUnattendedStates().some(({ sessionId }) => sessionId === "session-unattended"), true);
  assert.match(await readFile(activityFile, "utf8"), /"unattended"/);
});

test("marks an unfinished persisted run unknown after restart", async () => {
  const timestamp = new Date(Date.now() - 1000).toISOString();
  await writeFile(activityFile, JSON.stringify({
    records: [{
      runId: "old-run",
      sessionId: "session-restarted",
      cwd: "/tmp/project",
      startedAt: timestamp,
      updatedAt: timestamp,
      status: "running",
    }],
  }));
  globalThis.__piSessionActivityRuntime = undefined;

  const [record] = activity.getSessionRunRecords();
  assert.equal(record.sessionId, "session-restarted");
  assert.equal(record.status, "unknown");
});

test("concurrent Reader processes record every run in one shared activity file", async () => {
  const sharedFile = join(directory, "shared-activity.json");
  const worker = join(directory, "activity-writer.mjs");
  await writeFile(worker, `const activity = await import(${JSON.stringify(new URL("./session-activity.ts", import.meta.url).href)});
for (let i = 0; i < 25; i++) {
  const run = activity.recordSessionRunStart(process.argv[2] + "-" + i, "/tmp/project");
  activity.touchSessionRun(run.sessionId, run.runId);
  activity.recordSessionRunSettled(run.sessionId, run.runId);
}`);
  await Promise.all(["A", "B", "C", "D"].map((id) => new Promise((resolve, reject) => {
    const child = fork(worker, [id], { env: { ...process.env, PI_WEB_SESSION_ACTIVITY_FILE: sharedFile }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`activity writer ${id} exited ${code}`)));
  })));
  const { records } = JSON.parse(await readFile(sharedFile, "utf8"));
  assert.equal(records.filter((record) => record.status === "completed").length, 100);
});


test("active streaming retry uses the running state after recovery", () => {
  const base = {
    retryInFlight: true,
    userPromptActive: false,
    schedulerActive: false,
    active: true,
    hasErrorTail: true,
  };
  assert.equal(retryStatus.shouldShowRetryingStatus({ ...base, streaming: true }), false);
  assert.equal(retryStatus.shouldShowRetryingStatus({ ...base, streaming: false }), true);
});

test("a normal prompt is not masked by stale retry signals", () => {
  assert.equal(retryStatus.shouldShowRetryingStatus({
    streaming: false,
    retryInFlight: false,
    userPromptActive: true,
    schedulerActive: true,
    active: true,
    hasErrorTail: true,
  }), false);
});

test("a terminal completed run suppresses stale retry signals", () => {
  const staleRetry = {
    streaming: false,
    retryInFlight: false,
    userPromptActive: false,
    schedulerActive: true,
    active: true,
    hasErrorTail: true,
  };
  assert.equal(retryStatus.shouldShowRetryingStatus({ ...staleRetry, latestRunStatus: "completed" }), false);
  assert.equal(retryStatus.shouldShowRetryingStatus({ ...staleRetry, latestRunStatus: "aborted" }), false);
  assert.equal(retryStatus.shouldShowRetryingStatus({ ...staleRetry, latestRunStatus: "failed" }), true);
  assert.equal(retryStatus.shouldShowRetryingStatus({ ...staleRetry, retryInFlight: true, latestRunStatus: "completed" }), true);
});

test("keeps delegated completion evidence beside a failed parent run", async () => {
  const { isSubagentCompletionConfirmed } = await import("./session-activity-status.ts");
  assert.equal(isSubagentCompletionConfirmed({
    parentRunStatus: "failed",
    parentRunStartedAt: "2026-08-20T12:00:00.000Z",
    subagentTerminalState: "completed",
    subagentTerminalAt: Date.parse("2026-08-20T12:01:00.000Z"),
  }), true);
  assert.equal(isSubagentCompletionConfirmed({
    parentRunStatus: "failed",
    parentRunStartedAt: "2026-08-20T12:02:00.000Z",
    subagentTerminalState: "completed",
    subagentTerminalAt: Date.parse("2026-08-20T12:01:00.000Z"),
  }), false);
  assert.equal(isSubagentCompletionConfirmed({
    parentRunStatus: "completed",
    parentRunStartedAt: "2026-08-20T12:00:00.000Z",
    subagentTerminalState: "completed",
    subagentTerminalAt: Date.parse("2026-08-20T12:01:00.000Z"),
  }), false);
});
test("last activity follows latest message instead of current wall clock", async () => {
  const route = await readFile(new URL("../app/api/session-runs/route.ts", import.meta.url), "utf8");
  assert.match(route, /const lastActivityAt = session\.modified;/);
  assert.doesNotMatch(route, /new Date\(nowMs\)\.toISOString\(\)/);
});

test("session-runs passes live streaming state into retry classification", async () => {
  const route = await readFile(new URL("../app/api/session-runs/route.ts", import.meta.url), "utf8");
  assert.match(route, /import \{ shouldShowRetryingStatus \} from "@\/lib\/session-activity-status"/);
  assert.match(route, /const retrying = shouldShowRetryingStatus\(\{/);
  assert.match(route, /streaming: rpc\?\.isStreaming === true/);
  assert.match(route, /latestRunStatus: latestRun\?\.status \?\? null/);
  assert.match(route, /getUnattendedConfigured\(\)/);
});

test("session-runs does not synthesize a live running run over completed records when execution is idle", async () => {
  const route = await readFile(new URL("../app/api/session-runs/route.ts", import.meta.url), "utf8");
  assert.match(route, /const liveExecuting = rpc\?\.isStreaming === true \|\| rpc\?\.isPromptRunning === true \|\| subagentActivity\?\.active === true/);
  assert.match(route, /execution\?\.parentActive === true \|\| Boolean\(execution\?\.backgroundRunIds.length\)/);
  assert.match(route, /projectSessionRuns\(records, session.id, liveExecuting\)/);
  assert.doesNotMatch(route, /runId: `live:/);
  assert.match(route, /else if \(liveExecuting \|\| latestRun\?\.status === "running"\) status = "running";/);
});


test("session-runs projects async subagent lifecycle onto parent activity", async () => {
  const route = await readFile(new URL("../app/api/session-runs/route.ts", import.meta.url), "utf8");
  assert.match(route, /getSubagentActivityForSessions/);
  assert.match(route, /const subagentActivityBySession = getSubagentActivityForSessions\(sessions\)/);
  assert.match(route, /const active = runningSessionIds\.has\(session\.id\) \|\| subagentActivity\?\.active === true/);
  assert.match(route, /const waitingForUser = waitingForUserSessionIds\.has\(session\.id\);/);
  assert.doesNotMatch(route, /subagentActivity\?\.waitingForUser/);
});


test("session-runs diagnostics attach without changing activity response branches", async () => {
  const route = await readFile(new URL("../app/api/session-runs/route.ts", import.meta.url), "utf8");
  assert.match(route, /import \{ startServerPerf \} from "@\/lib\/perf";/);
  assert.match(route, /const perf = startServerPerf\("GET \/api\/session-runs"\);/);
  for (const phase of ["local", "peer-fetch", "peer-normalize", "assemble", "error"]) {
    assert.ok(route.includes(`perf?.span("${phase}")`), phase);
  }
  assert.equal((route.match(/return perf\?\.attach\(response\) \?\? response;/g) ?? []).length, 2);
  assert.equal((route.match(/return perf\?\.attach\(output\) \?\? output;/g) ?? []).length, 2);
  assert.match(route, /status: 500, headers: \{ "Cache-Control": "no-store" \}/);
  assert.match(route, /scope === "local"/);
  assert.match(route, /params\.get\("local"\) === "1"/);
});
