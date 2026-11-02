import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  analyzeTurns,
  computeAssistantTiming,
  computeSessionTiming,
  computeSessionTotalActiveMs,
  timingMessagesFromEntries,
  windowSessionTiming,
} = await jiti.import("./session-timing.ts");

const base = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (ms) => new Date(base + ms).toISOString();
let nextId = 0;
const id = (prefix) => `${prefix}${++nextId}`;

function user(at) {
  return { type: "message", id: id("u"), timestamp: iso(at), message: { role: "user", content: [{ type: "text", text: "question" }], timestamp: base + at } };
}
/** An assistant request starting at `start`, persisted when its `duration` ends. */
function assistant(start, duration, content, stopReason) {
  const calls = content.some((block) => block.type === "toolCall");
  return {
    type: "message",
    id: id("a"),
    timestamp: iso(start + duration),
    message: { role: "assistant", content, timestamp: base + start, durationMs: duration, stopReason: stopReason ?? (calls ? "toolUse" : "stop") },
  };
}
const answer = (text = "answer") => [{ type: "text", text }];
const call = (toolCallId, name = "read") => [{ type: "toolCall", id: toolCallId, name, arguments: {} }];
function toolResult(toolCallId, toolName, end, duration) {
  return {
    type: "message",
    id: id("t"),
    timestamp: iso(end),
    message: { role: "toolResult", toolCallId, toolName, content: [], isError: false, timestamp: base + end, durationMs: duration },
  };
}
const compaction = (at) => ({ type: "compaction", id: id("c"), timestamp: iso(at), summary: "summary" });
const notice = (at, customType) => ({ type: "custom_message", id: id("n"), timestamp: iso(at), customType, content: "", display: true });
const span = (start, end) => ({ start: base + start, end: base + end });
const childMessages = (entries) => timingMessagesFromEntries(entries).messages;

function timing(entries, { executionStart, source } = {}) {
  return computeSessionTiming({ ...timingMessagesFromEntries(entries, executionStart), ...source });
}

test("splits one answered turn into model, tool and other time", () => {
  const question = user(0);
  const result = timing([
    question,
    assistant(100, 2_000, call("c1", "bash")),
    toolResult("c1", "bash", 5_100, 3_000),
    assistant(5_200, 1_000, answer()),
  ]);
  assert.equal(result.effectiveMs, 6_200);
  assert.equal(result.agentTotalMs, 6_200);
  assert.equal(result.modelResponseMs, 3_000);
  assert.equal(result.toolMs, 3_000);
  assert.equal(result.otherMs, 200);
  assert.equal(result.modelResponsePercent, (3_000 / 6_200) * 100);
  assert.equal(result.quality, "complete");
  assert.deepEqual(result.turns, [{ entryId: question.id, responseMs: 6_200, modelResponseMs: 3_000, agentTotalMs: 6_200 }]);
});

test("starts a queued question when it was persisted, not when it was typed", () => {
  const queued = user(100_000);
  queued.message.timestamp = base;
  const result = timing([queued, assistant(100_500, 17_500, answer())]);
  assert.equal(result.turns[0].responseMs, 18_000);
  assert.equal(result.modelResponseMs, 17_500);
});

test("ends a request at the earlier of its stamped and persisted ends", () => {
  // The provider stamped the message 2s after its stream opened; the append marks the real end.
  const late = assistant(2_000, 3_000, answer());
  late.timestamp = iso(3_000);
  const result = timing([user(0), late]);
  assert.equal(result.modelResponseMs, 3_000);
  assert.equal(result.turns[0].responseMs, 3_000);
});

test("leaves the idle time between turns out", () => {
  const result = timing([
    user(0), assistant(0, 3_000, answer()),
    user(20_000), assistant(20_000, 3_000, answer()),
  ]);
  assert.equal(result.effectiveMs, 6_000);
  assert.equal(result.agentTotalMs, 6_000);
  assert.equal(result.turns.length, 2);
});

test("keeps a compaction in the middle of a run inside the user's turn", () => {
  const question = user(0);
  const entries = [
    question,
    assistant(0, 1_000, call("c1", "bash")),
    toolResult("c1", "bash", 4_000, 3_000),
    compaction(7_000),
    assistant(7_100, 1_000, answer()),
  ];
  const result = timing(entries);
  assert.deepEqual(result.turns, [{ entryId: question.id, responseMs: 8_100, modelResponseMs: 5_000, agentTotalMs: 8_100 }]);
  assert.equal(result.toolMs, 3_000);
  assert.equal(result.otherMs, 100);
  const turns = analyzeTurns(timingMessagesFromEntries(entries).messages);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].finalAssistantIndex, 4);
});

test("does not stretch a turn to a later compaction", () => {
  const result = timing([
    user(0), assistant(0, 2_000, answer()),
    compaction(50_000),
    user(60_000), assistant(60_000, 1_000, answer()),
  ]);
  assert.equal(result.effectiveMs, 3_000);
  assert.equal(result.modelResponseMs, 3_000);
  assert.equal(result.turns.length, 2);
});

test("caps a turn where the next message arrives while the agent works", () => {
  const result = timing([
    user(0),
    assistant(100, 900, call("c1", "bash")),
    toolResult("c1", "bash", 3_500, 2_500),
    user(3_000),
    assistant(3_600, 1_000, answer()),
  ]);
  assert.deepEqual(result.turns.map((turn) => turn.responseMs), [3_000, 1_600]);
  assert.equal(result.effectiveMs, 4_600);
  assert.equal(result.agentTotalMs, 4_600);
});

test("ends an unanswered turn at its last agent activity, not at later notices", () => {
  const result = timing([
    user(0),
    assistant(0, 1_000, call("c1", "bash")),
    toolResult("c1", "bash", 3_000, 2_000),
    notice(40_000, "honcho-memory-context"),
  ]);
  assert.equal(result.turns[0].responseMs, 3_000);
  assert.equal(result.effectiveMs, 3_000);
});

test("leaves waits for the user's answer out of working time", () => {
  const result = timing([
    user(0),
    assistant(0, 1_000, call("q1", "ask_user_question")),
    toolResult("q1", "ask_user_question", 61_000, 60_000),
    assistant(61_000, 1_000, answer()),
  ]);
  assert.equal(result.turns[0].responseMs, 62_000);
  assert.equal(result.effectiveMs, 2_000);
  assert.equal(result.agentTotalMs, 2_000);
  assert.equal(result.userWaitMs, 60_000);
  assert.equal(result.modelResponsePercent, 100);
});

test("counts failed attempts as model time and the retry backoff as other", () => {
  const result = timing([
    user(0),
    assistant(0, 2_000, [], "error"),
    assistant(6_000, 2_000, answer()),
  ]);
  assert.equal(result.modelResponseMs, 4_000);
  assert.equal(result.retryWaitMs, 4_000);
  assert.equal(result.otherMs, 4_000);
  assert.equal(result.agentTotalMs, 8_000);
});

test("counts the compaction before an overflow retry as model time", () => {
  const result = timing([
    user(0),
    assistant(0, 1_000, [], "error"),
    compaction(4_000),
    assistant(4_500, 1_000, answer()),
  ]);
  assert.equal(result.modelResponseMs, 5_000);
  assert.equal(result.retryWaitMs, 500);
  assert.equal(result.agentTotalMs, 5_500);
});

test("counts a foreground subagent's time once, for the subagent", () => {
  const question = user(0);
  const child = childMessages([
    user(1_500),
    assistant(1_500, 4_000, call("cc1")),
    toolResult("cc1", "read", 7_500, 2_000),
    assistant(7_500, 3_000, answer()),
  ]);
  const result = timing([
    question,
    assistant(0, 1_000, call("s1", "subagent")),
    toolResult("s1", "subagent", 11_000, 10_000),
    assistant(11_000, 1_000, answer()),
  ], { source: { children: [{ id: "child", messages: child, launchToolCallId: "s1", quality: "complete" }] } });
  assert.equal(result.effectiveMs, 12_000);
  assert.deepEqual(result.parent, { agentTotalMs: 3_000, modelResponseMs: 2_000 });
  assert.deepEqual(result.children, { count: 1, agentTotalMs: 9_000, modelResponseMs: 7_000, missingRecords: 0 });
  assert.equal(result.agentTotalMs, 12_000);
  assert.equal(result.modelResponseMs, 9_000);
  assert.equal(result.modelResponsePercent, 75);
  assert.deepEqual(result.turns, [{ entryId: question.id, responseMs: 12_000, modelResponseMs: 9_000, agentTotalMs: 12_000 }]);
});

test("adds parallel subagents to agent time but counts their wall-clock once", () => {
  const childA = childMessages([user(1_000), assistant(1_000, 8_000, answer())]);
  const childB = childMessages([
    user(1_000),
    assistant(1_000, 4_000, call("cb1")),
    toolResult("cb1", "read", 8_000, 3_000),
    assistant(8_000, 1_000, answer()),
  ]);
  const result = timing([
    user(0),
    assistant(0, 1_000, call("s1", "subagent")),
    toolResult("s1", "subagent", 9_000, 8_000),
    assistant(9_000, 1_000, answer()),
  ], { source: { children: [
    { id: "a", messages: childA, launchToolCallId: "s1", quality: "complete" },
    { id: "b", messages: childB, launchToolCallId: "s1", quality: "complete" },
  ] } });
  assert.equal(result.effectiveMs, 10_000);
  assert.equal(result.agentTotalMs, 18_000);
  assert.equal(result.modelResponseMs, 15_000);
  assert.equal(result.children.count, 2);
});

test("keeps counting a background subagent after the main agent replies", () => {
  const child = childMessages([user(1_100), assistant(1_100, 20_000, answer())]);
  const result = timing([
    user(0),
    assistant(0, 1_000, call("b1", "Agent")),
    toolResult("b1", "Agent", 1_100, 50),
    assistant(1_200, 1_000, answer("started")),
    notice(30_000, "pi-web:subagent-notification"),
    assistant(30_100, 1_000, answer("done")),
  ], { source: { children: [{ id: "child", messages: child, launchToolCallId: "b1", quality: "complete" }] } });
  // The question waited 31.1s for its answer, but the main agent was idle between its two runs.
  assert.equal(result.turns[0].responseMs, 31_100);
  assert.deepEqual(result.parent, { agentTotalMs: 3_300, modelResponseMs: 3_000 });
  assert.equal(result.effectiveMs, 22_200);
  assert.equal(result.agentTotalMs, 23_300);
  assert.equal(result.modelResponseMs, 23_000);
});

test("credits a subagent to the turn that started it", () => {
  const first = user(0);
  const firstAnswer = assistant(0, 2_000, answer());
  const second = user(10_000);
  const child = childMessages([user(11_000), assistant(11_000, 4_000, answer())]);
  const result = timing([
    first, firstAnswer,
    second,
    assistant(10_000, 1_000, call("s1", "subagent")),
    toolResult("s1", "subagent", 16_000, 5_000),
    assistant(16_000, 1_000, answer()),
  ], { source: { children: [{ id: "child", messages: child, launchToolCallId: "s1", quality: "complete" }] } });
  assert.deepEqual(result.turns, [
    { entryId: first.id, responseMs: 2_000, modelResponseMs: 2_000, agentTotalMs: 2_000 },
    { entryId: second.id, responseMs: 7_000, modelResponseMs: 6_000, agentTotalMs: 7_000 },
  ]);
});

test("adds a missing subagent record's recorded run window and marks timing partial", () => {
  const result = timing([
    user(0),
    assistant(0, 1_000, call("s1", "subagent")),
    toolResult("s1", "subagent", 1_100, 100),
    assistant(1_200, 1_000, answer()),
  ], { source: {
    children: [{ id: "missing:run:r1", fallbackWindow: span(1_100, 11_100), launchToolCallId: "s1", quality: "partial" }],
    missingChildRecords: 1,
  } });
  assert.equal(result.effectiveMs, 11_100);
  assert.equal(result.agentTotalMs, 12_200);
  assert.equal(result.modelResponseMs, 2_000);
  assert.equal(result.children.missingRecords, 1);
  assert.equal(result.quality, "partial");
});

test("drops history inherited before a fork's own execution", () => {
  const result = timing([
    user(1_000), assistant(1_000, 3_000, answer("old")),
    user(12_000), assistant(12_000, 3_000, answer("new")),
  ], { executionStart: base + 10_000, source: { scope: "fork-execution" } });
  assert.equal(result.effectiveMs, 3_000);
  assert.equal(result.turns.length, 1);
  assert.equal(result.scope, "fork-execution");
});

test("ignores Side Ask records stored in the session", () => {
  const sideAsk = {
    type: "custom",
    id: id("q"),
    timestamp: iso(1_500),
    customType: "quick_ask_run",
    data: { nativeEntries: [
      { type: "message", id: "q-u", timestamp: iso(1_500), message: { role: "user", content: "side", timestamp: base + 1_500 } },
      { type: "message", id: "q-a", timestamp: iso(9_500), message: { role: "assistant", content: answer(), timestamp: base + 1_500, durationMs: 8_000, stopReason: "stop" } },
    ] },
  };
  const plain = [user(0), assistant(0, 1_000, call("c1")), toolResult("c1", "read", 2_000, 1_000), assistant(2_000, 1_000, answer())];
  assert.deepEqual(timing([...plain.slice(0, 2), sideAsk, ...plain.slice(2)]), timing(plain));
});

test("reports timing as unavailable before any answer", () => {
  const result = timing([user(0)]);
  assert.equal(result.quality, "unavailable");
  assert.equal(result.effectiveMs, 0);
  assert.equal(result.modelResponsePercent, undefined);
  assert.deepEqual(result.turns, []);
});

test("marks timing partial when a later parent or child turn has no response", () => {
  const parent = timing([user(0), assistant(0, 1_000, answer()), user(2_000)]);
  assert.equal(parent.quality, "partial");
  assert.equal(parent.turns.length, 1);
  assert.equal(parent.modelResponseMs, 1_000);

  const child = childMessages([user(100), assistant(100, 500, answer()), user(700)]);
  const withChild = timing([user(0), assistant(0, 1_000, answer())], {
    source: { children: [{ id: "child", messages: child, quality: "complete" }] },
  });
  assert.equal(withChild.quality, "partial");
  assert.equal(withChild.children.modelResponseMs, 500);

  const withoutChildActivity = timing([user(0), assistant(0, 1_000, answer())], {
    source: { children: [{ id: "child", messages: [], quality: "complete" }] },
  });
  assert.equal(withoutChildActivity.quality, "partial");
});

test("falls back to append times for messages without measured durations", () => {
  const legacyCall = assistant(0, 1_000, call("c1"));
  delete legacyCall.message.durationMs;
  legacyCall.timestamp = iso(1_500);
  const legacyResult = toolResult("c1", "read", 4_000, 0);
  delete legacyResult.message.durationMs;
  const result = timing([user(0), legacyCall, legacyResult, assistant(4_000, 1_000, answer())]);
  assert.equal(result.modelResponseMs, 2_500);
  assert.equal(result.toolMs, 2_500);
  assert.equal(result.quality, "complete");
});

test("marks timing partial when an assistant has no usable timestamps", () => {
  const broken = { type: "message", id: id("a"), timestamp: "not-a-time", message: { role: "assistant", content: call("c1"), stopReason: "toolUse" } };
  const result = timing([user(0), broken, assistant(5_000, 1_000, answer())]);
  assert.equal(result.quality, "partial");
  assert.equal(result.modelResponseMs, 1_000);
});

test("adds up question-to-answer time across turns for usage summaries", () => {
  assert.equal(computeSessionTotalActiveMs([
    user(0), assistant(0, 3_000, answer()),
    user(20_000), assistant(20_000, 2_000, answer()),
  ]), 5_000);
  assert.equal(computeSessionTotalActiveMs([]), 0);
});

test("keeps one assistant row's model wait and tool batch", () => {
  const calls = assistant(0, 25_000, [
    { type: "toolCall", toolCallId: "a", toolName: "read", input: {} },
    { type: "toolCall", toolCallId: "b", toolName: "read", input: {} },
  ]);
  const resultA = toolResult("a", "read", 26_000, 1_000);
  const resultB = toolResult("b", "read", 28_000, 2_000);
  const rowTiming = computeAssistantTiming(
    { ...calls.message, entryTimestamp: calls.timestamp },
    [{ ...resultA.message, entryTimestamp: resultA.timestamp }, { ...resultB.message, entryTimestamp: resultB.timestamp }],
  );
  assert.equal(rowTiming.modelWaitMs, 25_000);
  assert.equal(rowTiming.toolBatchMs, 3_000);
  assert.equal(rowTiming.toolBatchQuality, "complete");
});

test("a transcript page keeps the aggregates but only its own turns", () => {
  const timing = {
    effectiveMs: 9, agentTotalMs: 9, modelResponseMs: 6, toolMs: 3, otherMs: 0, retryWaitMs: 0, userWaitMs: 0,
    parent: { agentTotalMs: 9, modelResponseMs: 6 }, children: { count: 0, agentTotalMs: 0, modelResponseMs: 0, missingRecords: 0 },
    turns: ["old", "kept"].map((entryId) => ({ entryId, responseMs: 3, modelResponseMs: 2, agentTotalMs: 3 })),
    quality: "complete", scope: "session",
  };
  const page = windowSessionTiming(timing, ["kept", "kept-answer"]);
  assert.deepEqual(page.turns.map((turn) => turn.entryId), ["kept"]);
  assert.equal(page.turnsScope, "window");
  assert.equal(page.effectiveMs, timing.effectiveMs);
  assert.equal(timing.turns.length, 2, "the computed timing is not mutated");
});
