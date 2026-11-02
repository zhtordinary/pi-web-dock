import assert from "node:assert/strict";
import test from "node:test";
import { filterSessionsByActivityTime, isWithinActivityTimeRange, sessionActivityDisplayTime } from "./session-activity-filters.ts";

const nowMs = Date.parse("2026-08-29T12:00:00.000Z");
const activities = [
  { session: { id: "recent" }, lastActivityAt: "2026-08-29T11:30:00.000Z" },
  { session: { id: "old" }, lastActivityAt: "2026-08-27T11:30:00.000Z" },
];

test("activity time ranges use the last activity timestamp", () => {
  assert.equal(isWithinActivityTimeRange("2026-08-29T11:00:00.000Z", "1", nowMs), true);
  assert.equal(isWithinActivityTimeRange("2026-08-28T11:59:59.999Z", "1", nowMs), false);
  assert.deepEqual(
    filterSessionsByActivityTime([
      { id: "recent", modified: "2026-01-01T00:00:00.000Z" },
      { id: "old", modified: "2026-08-29T11:45:00.000Z" },
      { id: "fallback", modified: "2026-08-29T10:00:00.000Z" },
    ], activities, "1", nowMs).map((session) => session.id),
    ["recent", "fallback"],
  );
});

test("all time keeps every session", () => {
  assert.deepEqual(
    filterSessionsByActivityTime([{ id: "old", modified: "bad" }], [], "all", nowMs).map((session) => session.id),
    ["old"],
  );
});

test("selected activity sort drives shared display time", () => {
  const item = {
    lastAskedAt: "2026-08-29T11:00:00.000Z",
    lastActivityAt: "2026-08-29T11:30:00.000Z",
  };
  assert.equal(sessionActivityDisplayTime(item, "recent"), item.lastActivityAt);
  assert.equal(sessionActivityDisplayTime(item, "asked"), item.lastAskedAt);
  assert.equal(sessionActivityDisplayTime(item, "status"), item.lastAskedAt);
  assert.equal(sessionActivityDisplayTime({ lastActivityAt: item.lastActivityAt }, "status"), item.lastActivityAt);
});
