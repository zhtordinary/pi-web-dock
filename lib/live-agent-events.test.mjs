import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const liveEvents = await createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false })
  .import("./live-agent-events.ts");

test("omitted wire events do not allocate a public cursor hole", () => {
  const records = [];
  assert.equal(liveEvents.appendLiveEvent(records, 7, { type: "entry_appended" }), 7);
  assert.deepEqual(records, []);
  assert.equal(liveEvents.appendLiveEvent(records, 7, { type: "agent_start" }), 8);
});

test("live event projection redacts credentials and absolute paths", () => {
  const projected = liveEvents.publicLiveAgentEvent({
    type: "tool_execution_update",
    toolCallId: "tc",
    toolName: "bash",
    partialResult: {
      token: "secret-token",
      text: "Bearer abcdefghijk /Users/alice/project https://user:password@example.com/private",
    },
  });
  assert.ok(projected);
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("abcdefghijk"), false);
  assert.equal(serialized.includes("/Users/alice"), false);
  assert.equal(serialized.includes("/private"), false);
  assert.equal(serialized.includes("user:password"), false);
  assert.equal(serialized.includes("https://example.com/[REDACTED_PATH]"), true);
  assert.match(serialized, /\[REDACTED\]/);
});

test("live event buffer is bounded and reports stale cursors", () => {
  const records = [];
  let cursor = 0;
  for (let index = 0; index < 300; index += 1) {
    cursor = liveEvents.appendLiveEvent(records, cursor, { type: "agent_start", text: `event-${index}` });
  }
  assert.equal(cursor, 300);
  assert.equal(records.length, liveEvents.LIVE_EVENT_BUFFER_SIZE);
  assert.equal(records[0].cursor, 45);

  const page = liveEvents.sliceLiveEvents(records, cursor, 0, 100, liveEvents.LIVE_EVENT_MAX_BYTES);
  assert.equal(page.events.length, 100);
  assert.equal(page.truncated, true);

  const stale = liveEvents.sliceLiveEvents(records, cursor, 1, 10, 64 * 1024);
  assert.equal(stale.truncated, true);

  const future = liveEvents.sliceLiveEvents(records, cursor, 999999, 10, 64 * 1024);
  assert.equal(future.events.length, 0);
  assert.equal(future.nextCursor, cursor);
});

test("oversized projected events become bounded markers", () => {
  const projected = liveEvents.publicLiveAgentEvent({
    type: "agent_start",
    payload: Array.from({ length: 64 }, () => "x".repeat(9000)),
  });
  assert.deepEqual(projected, {
    type: "agent_start",
    truncated: true,
    note: "live event exceeded the per-event safety bound",
  });
});
