import assert from "node:assert/strict";
import test from "node:test";
import {
  filterContinuableSessions,
  shouldShowBatchContinue,
  continueSession,
  continueAllSessions,
  MIN_BATCH_CONTINUE_SESSIONS,
} from "./batch-continue.ts";

function session(id, status = "unknown", deviceId = "local-dev") {
  return { session: { id, name: `Task ${id}` }, status, device: { id: deviceId }, latestRun: { runId: `run-${id}` } };
}

test("batch visibility retains the two-session threshold", () => {
  assert.equal(MIN_BATCH_CONTINUE_SESSIONS, 2);
  for (const count of [0, 1, NaN, Infinity, -1]) assert.equal(shouldShowBatchContinue(count), false);
  for (const count of [2, 3, 5]) assert.equal(shouldShowBatchContinue(count), true);
});

test("unknown and failed sessions share the candidate list; all other statuses stay excluded", () => {
  const statuses = ["unknown", "running", "retrying", "waiting_user", "just_completed", "idle", "failed", "aborted"];
  const candidates = filterContinuableSessions(statuses.map(status => session(status, status)));
  assert.deepEqual(candidates.map(item => item.session.id), ["unknown", "failed"]);
  for (const value of [null, undefined, []]) assert.deepEqual(filterContinuableSessions(value), []);
});

test("batch candidates exclude subagents and sessions without a latest run", () => {
  const subagent = session("subagent", "failed");
  subagent.session.relation = {
    kind: "subagent",
    parentSessionId: "parent",
    profile: "pi-subagents",
    description: "delegated task",
    status: "failed",
  };
  const missingRun = session("missing-run", "unknown");
  missingRun.latestRun = null;

  const candidates = filterContinuableSessions([
    session("normal", "failed"),
    subagent,
    missingRun,
  ]);
  assert.deepEqual(candidates.map(item => item.session.id), ["normal"]);
});

test("batch retry falls back only after a definitive no-anchor rejection", async (t) => {
  const calls = [], effects = [], originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (url.includes("no-anchor") && body.type === "retry_continue_only") {
      return { ok: false, status: 500, json: async () => ({ error: "No continue turn is available to retry", code: "retry_unavailable", accepted: false }) };
    }
    if (url.includes("rejected")) return { ok: false, status: 500, json: async () => ({ error: "Run changed", code: "retry_target_changed", accepted: false }) };
    if (url.includes("already-running")) return { ok: false, status: 409, json: async () => ({ error: "The session has active work, queued input or a pending question", code: "runtime_busy", accepted: false }) };
    if (url.includes("remote-timeout")) return { ok: false, status: 504, json: async () => ({ error: "Remote request timed out", code: "remote_timeout" }) };
    effects.push({ url, body });
    if (url.includes("lost-response")) throw new Error("response lost after server acceptance");
    return { ok: true, status: 200, json: async () => ({ success: true, data: null }) };
  };

  const local = await continueSession(session("local"), "local-dev");
  const remote = await continueSession(session("remote", "failed", "peer-a"), "local-dev");
  assert.equal(local.success, true);
  assert.equal(remote.success, true);
  assert.deepEqual(calls.slice(0, 2), [
    { url: "/api/agent/local", body: { type: "retry_continue_only", expectedRunId: "run-local" } },
    { url: "/api/remote/agent/remote?peer=peer-a", body: { type: "retry_continue_only", expectedRunId: "run-remote" } },
  ]);

  const noAnchor = await continueSession(session("no-anchor"), "local-dev");
  assert.equal(noAnchor.success, true);
  assert.deepEqual(calls.slice(2, 4), [
    { url: "/api/agent/no-anchor", body: { type: "retry_continue_only", expectedRunId: "run-no-anchor" } },
    { url: "/api/agent/no-anchor", body: { type: "retry_continue", expectedRunId: "run-no-anchor" } },
  ]);

  const rejected = await continueSession(session("rejected", "failed"), "local-dev");
  assert.equal(rejected.success, false);
  assert.equal(rejected.issue.uncertain, false);
  assert.equal(rejected.issue.error, "Run changed");
  const alreadyRunning = await continueSession(session("already-running"), "local-dev");
  assert.equal(alreadyRunning.success, false);
  assert.equal(alreadyRunning.issue.code, "runtime_busy");
  assert.equal(alreadyRunning.issue.uncertain, false);
  for (const id of ["lost-response", "remote-timeout"]) {
    const result = await continueSession(session(id), "local-dev");
    assert.equal(result.success, false);
    assert.equal(result.issue.uncertain, true);
  }
  assert.equal(calls.length, 8, "transport failures cannot trigger fallback requests");
  assert.equal(effects.length, 4, "the lost response may already have started a run");
  assert.equal(effects.filter(call => call.url.includes("lost-response")).length, 1);
  assert.equal(calls.filter(call => call.url.includes("no-anchor")).length, 2);
  assert.equal(calls.filter(call => call.body.type === "retry_continue" && call.url.includes("lost-response")).length, 0);

  const results = await continueAllSessions([session("accepted"), session("rejected", "failed"), session("lost-response")], "local-dev");
  assert.deepEqual(results.succeeded, ["accepted"]);
  assert.deepEqual(results.failed, ["rejected", "lost-response"]);
  assert.deepEqual(results.issues.map(issue => [issue.label, issue.uncertain]), [["Task rejected", false], ["Task lost-response", true]]);
  assert.equal(calls.length, 11);
});

test("a candidate without an observed run is rejected before any request", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { calls++; throw new Error("must not request"); };
  const item = session("missing-run");
  item.latestRun = null;
  const result = await continueSession(item, "local-dev");
  assert.equal(result.success, false);
  assert.equal(result.issue.uncertain, false);
  assert.match(result.issue.error, /run identity/);
  assert.equal(calls, 0);
});
