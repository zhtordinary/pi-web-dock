import assert from "node:assert/strict";
import test from "node:test";

const events = await import("./activity-events.ts");

test("emits with monotonic seq and notifies listeners", () => {
  globalThis.__piActivityEventRuntime = undefined;
  const received = [];
  const unsubscribe = events.subscribeActivityEvents((event) => received.push(event));
  const first = events.emitActivityEvent({ sessionId: "s1", runId: "r1", status: "running" });
  const second = events.emitActivityEvent({ sessionId: "s1", runId: "r1", status: "completed" });
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(first.bootId, second.bootId);
  assert.equal(events.activityCursor().bootId, first.bootId);
  assert.equal(first.kind, "run"); // kind 默认 run
  const sessionEvent = events.emitActivityEvent({ kind: "session", sessionId: "s9" });
  assert.equal(sessionEvent.kind, "session");
  assert.equal(sessionEvent.status, undefined); // session 事件无 run 状态
  assert.ok(second.at >= first.at);
  assert.deepEqual(received, [first, second, sessionEvent]);
  unsubscribe();
  events.emitActivityEvent({ sessionId: "s2", runId: "r2", status: "failed" });
  assert.equal(received.length, 3); // 退订后不再收到
});

test("boot id changes when runtime is recreated", () => {
  globalThis.__piActivityEventRuntime = undefined;
  const first = events.activityCursor();
  globalThis.__piActivityEventRuntime = undefined;
  const second = events.activityCursor();
  assert.notEqual(second.bootId, first.bootId);
  assert.equal(second.seq, 0);
});

test("activityEventsSince returns only newer events and replays buffer", () => {
  globalThis.__piActivityEventRuntime = undefined;
  events.emitActivityEvent({ sessionId: "s1", runId: "r1", status: "running" });
  events.emitActivityEvent({ sessionId: "s1", runId: "r1", status: "completed" });
  const since1 = events.activityEventsSince(1);
  assert.equal(since1.length, 1);
  assert.equal(since1[0].status, "completed");
  assert.deepEqual(events.activityEventsSince(0), events.activityEventsSince(0));
  assert.equal(events.latestActivitySeq(), 2);
  // 不存在的游标（如重启后 0）也能回放缓冲。
  assert.equal(events.activityEventsSince(99).length, 0);
});

test("buffer caps at MAX_BUFFER keeping newest", () => {
  globalThis.__piActivityEventRuntime = undefined;
  for (let i = 0; i < 205; i++) {
    events.emitActivityEvent({ sessionId: `s${i}`, runId: `r${i}`, status: "running" });
  }
  const replayed = events.activityEventsSince(0);
  assert.equal(replayed.length, 200);
  assert.equal(replayed[0].sessionId, "s5"); // 最旧的 5 条被淘汰
  assert.equal(replayed[replayed.length - 1].sessionId, "s204");
  assert.equal(events.latestActivitySeq(), 205);
});

test("listener errors do not break the emit path", () => {
  globalThis.__piActivityEventRuntime = undefined;
  events.subscribeActivityEvents(() => {
    throw new Error("boom");
  });
  const event = events.emitActivityEvent({ sessionId: "s1", runId: "r1", status: "aborted" });
  assert.equal(event.status, "aborted"); // 异常被吞，emit 正常返回
});
