import assert from "node:assert/strict";
import test from "node:test";

const { applySessionActivityEvent, applySessionActivityItemsEvent, applySessionActivityPeerState } = await import("./session-activity-client.ts");

function response() {
  const session = {
    id: "s1",
    cwd: "/tmp/project",
    path: "/tmp/project/session.jsonl",
    name: "Session",
    modified: "2026-08-20T12:00:00.000Z",
  };
  const run = {
    runId: "r1",
    sessionId: "s1",
    cwd: "/tmp/project",
    startedAt: "2026-08-20T11:59:00.000Z",
    updatedAt: "2026-08-20T12:00:00.000Z",
    status: "running",
  };
  return {
    schemaVersion: 1,
    scope: "all",
    generatedAt: "2026-08-20T12:00:00.000Z",
    device: { id: "macmini", name: "Mac mini", online: true },
    devices: [
      { id: "macmini", name: "Mac mini", online: true },
      { id: "macbook-air", name: "MacBook Air", online: true },
    ],
    sessions: [{
      device: { id: "macmini", name: "Mac mini", online: true },
      session,
      projectKey: "project",
      projectLabel: "project",
      status: "running",
      lastActivityAt: run.updatedAt,
      latestRun: run,
      runs: [run],
    }],
  };
}

test("run lifecycle events do not replace last message activity time", () => {
  const result = applySessionActivityEvent(response(), {
    type: "activity",
    device: "macmini",
    sessionId: "s1",
    runId: "r1",
    status: "running",
    at: Date.parse("2026-08-20T12:05:00.000Z"),
  });
  assert.equal(result.changed, true);
  assert.equal(result.response.sessions[0].lastActivityAt, "2026-08-20T12:00:00.000Z");
});

test("live completion event projects status without a snapshot round trip", () => {
  const result = applySessionActivityEvent(response(), {
    type: "activity",
    device: "macmini",
    sessionId: "s1",
    runId: "r1",
    status: "completed",
    at: Date.parse("2026-08-20T12:00:01.000Z"),
  });
  assert.equal(result.matched, true);
  assert.equal(result.changed, true);
  assert.equal(result.response.sessions[0].status, "just_completed");
  assert.equal(result.response.sessions[0].latestRun.status, "completed");
  assert.equal(result.response.sessions[0].latestRun.completedAt, "2026-08-20T12:00:01.000Z");
});

test("live terminal event carries server unattended truth into activity row", () => {
  const result = applySessionActivityEvent(response(), {
    type: "activity",
    device: "macmini",
    sessionId: "s1",
    runId: "r1",
    status: "failed",
    unattended: true,
    at: Date.parse("2026-08-20T12:00:01.000Z"),
  });
  assert.equal(result.changed, true);
  assert.equal(result.response.sessions[0].status, "failed");
  assert.equal(result.response.sessions[0].unattended, true);
});

test("an older run event cannot regress the newer run", () => {
  const newer = applySessionActivityEvent(response(), {
    type: "activity",
    device: "macmini",
    sessionId: "s1",
    runId: "r2",
    status: "running",
    at: Date.parse("2026-08-20T12:01:00.000Z"),
  });
  const stale = applySessionActivityEvent(newer.response, {
    type: "activity",
    device: "macmini",
    sessionId: "s1",
    runId: "r1",
    status: "completed",
    at: Date.parse("2026-08-20T12:00:30.000Z"),
  });
  assert.equal(stale.matched, true);
  assert.equal(stale.changed, false);
  assert.equal(stale.response.sessions[0].latestRun.runId, "r2");
  assert.equal(stale.response.sessions[0].status, "running");
});

test("a delayed terminal event from an older run cannot regress a newer completion", () => {
  const newer = applySessionActivityEvent(response(), {
    type: "activity",
    device: "macmini",
    sessionId: "s1",
    runId: "r2",
    status: "running",
    startedAt: "2026-08-20T12:01:00.000Z",
    at: Date.parse("2026-08-20T12:01:00.000Z"),
  });
  const completed = applySessionActivityEvent(newer.response, {
    type: "activity",
    device: "macmini",
    sessionId: "s1",
    runId: "r2",
    status: "completed",
    startedAt: "2026-08-20T12:01:00.000Z",
    at: Date.parse("2026-08-20T12:02:00.000Z"),
  });
  const stale = applySessionActivityEvent(completed.response, {
    type: "activity",
    device: "macmini",
    sessionId: "s1",
    runId: "r1",
    status: "aborted",
    startedAt: "2026-08-20T11:59:00.000Z",
    at: Date.parse("2026-08-20T12:03:00.000Z"),
  });
  assert.equal(stale.matched, true);
  assert.equal(stale.changed, false);
  assert.equal(stale.response.sessions[0].latestRun.runId, "r2");
  assert.equal(stale.response.sessions[0].status, "just_completed");
});

test("peer state is projected immediately and updates rows for that device", () => {
  const result = applySessionActivityPeerState(response(), {
    type: "peer_state",
    device: "macbook-air",
    online: false,
  });
  assert.equal(result.matched, true);
  assert.equal(result.changed, true);
  assert.equal(result.response.devices.find((device) => device.id === "macbook-air")?.online, false);
});

test("Talk Map item projection updates live completion without snapshot", () => {
  const result = applySessionActivityItemsEvent(response().sessions, {
    type: "activity",
    device: "macmini",
    sessionId: "s1",
    runId: "r1",
    status: "completed",
    at: Date.parse("2026-08-20T12:00:01.000Z"),
  });
  assert.equal(result.matched, true);
  assert.equal(result.changed, true);
  assert.equal(result.sessions[0].status, "just_completed");
  assert.equal(result.sessions[0].latestRun.status, "completed");
});
