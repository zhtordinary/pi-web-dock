import assert from "node:assert/strict";
import test from "node:test";
import { mergeProjectList, mergeSelectedSession, shouldApplySessionListResponse } from "./session-list-state.ts";

function session(partial) {
  return {
    id: "s", path: "/sessions/s", cwd: "/tmp", created: "2025-01-01T00:00:00.000Z", modified: "2025-01-01T00:00:00.000Z",
    messageCount: 0, firstMessage: "", name: "", ...partial,
  };
}

test("mergeProjectList keeps saved paths with zero sessions", () => {
  const sessions = [session({ id: "a", cwd: "/tmp/a", projectRoot: "/tmp/a", modified: "2025-02-01T00:00:00.000Z" })];
  const known = [{ path: "/tmp/b", addedAt: "2025-01-01T00:00:00.000Z" }];
  assert.deepEqual(mergeProjectList(sessions, known), ["/tmp/a", "/tmp/b"]);
});

test("mergeProjectList skips saved paths that already have sessions", () => {
  const sessions = [session({ id: "a", cwd: "/tmp/a", projectRoot: "/tmp/a", modified: "2025-02-01T00:00:00.000Z" })];
  const known = [{ path: "/tmp/a", addedAt: "2025-03-01T00:00:00.000Z" }];
  assert.deepEqual(mergeProjectList(sessions, known), ["/tmp/a"]);
});

test("mergeProjectList orders session projects by recency, saved-only paths last", () => {
  const sessions = [
    session({ id: "a", cwd: "/tmp/a", projectRoot: "/tmp/a", modified: "2025-02-01T00:00:00.000Z" }),
    session({ id: "b", cwd: "/tmp/b", projectRoot: "/tmp/b", modified: "2025-03-01T00:00:00.000Z" }),
  ];
  const known = [{ path: "/tmp/old", addedAt: "2025-01-01T00:00:00.000Z" }];
  assert.deepEqual(mergeProjectList(sessions, known), ["/tmp/b", "/tmp/a", "/tmp/old"]);
});

test("mergeSelectedSession appends an unlisted selected session to the front", () => {
  const sessions = [session({ id: "a" })];
  const selected = session({ id: "b", cwd: "/tmp/b" });
  const merged = mergeSelectedSession(sessions, selected, false, "/tmp/b");
  assert.equal(merged[0].id, "b");
  assert.equal(merged[0].projectRoot, "/tmp/b");
});

test("shouldApplySessionListResponse gates stale responses", () => {
  assert.equal(shouldApplySessionListResponse(1, 2), false);
  assert.equal(shouldApplySessionListResponse(2, 2), true);
});

test('authoritative catalog does not resurrect a deleted selected session', () => {
 const selected = session({ id: 'deleted' });
 assert.deepEqual(mergeSelectedSession([], selected, false, '/tmp', true), []);
 // An incomplete initial/page snapshot cannot establish deletion.
 assert.equal(mergeSelectedSession([], selected, false, '/tmp', false)[0].id, 'deleted');
});
