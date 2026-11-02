import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { sliceActiveBranch, buildSessionContext, buildSessionHistoryInfo, parseSessionTail } = await jiti.import("./session-reader.ts");

function linearChain(n) {
  const entries = [];
  for (let i = 0; i < n; i++) {
    entries.push({ id: `e${i}`, parentId: i === 0 ? null : `e${i - 1}`, type: "message", timestamp: new Date(1000 + i * 1000).toISOString(), message: { role: i % 2 === 0 ? "user" : "assistant", content: i % 2 === 0 ? `msg ${i}` : [{ type: "text", text: `msg ${i}` }] } });
  }
  return entries;
}

test("sliceActiveBranch returns the recent tail in order", () => {
  const sliced = sliceActiveBranch(linearChain(100), "e99", 50);
  assert.equal(sliced.length, 50);
  assert.equal(sliced[0].id, "e50");
  assert.equal(sliced.at(-1).id, "e99");
});

test("sliceActiveBranch walks parents iteratively", () => {
  assert.deepEqual(sliceActiveBranch(linearChain(10), "e5", 3).map((e) => e.id), ["e2", "e3", "e4", "e5"]);
  assert.deepEqual(sliceActiveBranch(linearChain(7), null, 3).map((e) => e.id), ["e4", "e5", "e6"]);
});

test("keeps the preceding user anchor when a tail starts inside a turn", () => {
  const entries = [
    { id: "u1", parentId: null, type: "message", message: { role: "user", content: "question" } },
    { id: "a1", parentId: "u1", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "work" }] } },
    { id: "tr1", parentId: "a1", type: "message", message: { role: "toolResult", toolCallId: "call", content: [{ type: "text", text: "result" }] } },
    { id: "a2", parentId: "tr1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
  ];
  assert.deepEqual(sliceActiveBranch(entries, "a2", 2).map((entry) => entry.id), ["u1", "a1", "tr1", "a2"]);
});

test("deep linear chains do not overflow the stack", () => {
  const sliced = sliceActiveBranch(linearChain(5000), "e4999", 50);
  assert.equal(sliced.length, 50);
  assert.equal(sliced.at(-1).id, "e4999");
});

test("buildSessionContext returns only a requested tail and preserves settings", () => {
  const entries = linearChain(300);
  const context = buildSessionContext(entries, "e299", { tail: 50 });
  assert.equal(context.messages.length, 50);
  assert.equal(context.entryIds[0], "e250");
  assert.equal(context.entryIds.at(-1), "e299");
  assert.equal(context.oldestEntryId, "e250");
  assert.equal(context.hasMore, true);
});

test("does not report earlier history for one turn with many internal entries", () => {
  const entries = [
    { id: "model", parentId: null, type: "model_change", timestamp: "2026-08-31T00:00:00.000Z", provider: "test", modelId: "test" },
    { id: "user", parentId: "model", type: "message", message: { role: "user", content: "question" } },
  ];
  let parentId = "user";
  for (let i = 0; i < 60; i += 1) {
    const id = `tool-${i}`;
    entries.push({ id, parentId, type: "message", message: { role: "toolResult", content: [{ type: "text", text: "work" }] } });
    parentId = id;
  }
  entries.push({ id: "answer", parentId, type: "message", message: { role: "assistant", content: "done" } });

  const context = buildSessionContext(entries, "answer", { tail: 50 });
  const sliced = sliceActiveBranch(entries, "answer", 50);

  assert.equal(sliced[0].id, "user");
  assert.equal(Boolean(sliced[0].parentId), true);
  assert.equal(Boolean(50 && sliced[0]?.parentId), true);
  assert.equal(context.hasMore, false);
  assert.equal(buildSessionHistoryInfo(entries, "answer", context).hasEarlierHistory, false);
});

test("reports earlier history before a long current turn", () => {
  const entries = [
    { id: "model", parentId: null, type: "model_change", timestamp: "2026-08-31T00:00:00.000Z", provider: "test", modelId: "test" },
    { id: "previous-user", parentId: "model", type: "message", message: { role: "user", content: "previous" } },
    { id: "previous-answer", parentId: "previous-user", type: "message", message: { role: "assistant", content: "previous answer" } },
    { id: "user", parentId: "previous-answer", type: "message", message: { role: "user", content: "question" } },
  ];
  let parentId = "user";
  for (let i = 0; i < 60; i += 1) {
    const id = `tool-${i}`;
    entries.push({ id, parentId, type: "message", message: { role: "toolResult", content: [{ type: "text", text: "work" }] } });
    parentId = id;
  }
  entries.push({ id: "answer", parentId, type: "message", message: { role: "assistant", content: "done" } });

  const context = buildSessionContext(entries, "answer", { tail: 50 });

  assert.equal(context.hasMore, true);
});

test("without tail, buildSessionContext keeps current full behavior", () => {
  assert.equal(buildSessionContext(linearChain(20), "e19").messages.length, 20);
});

test("propagates persisted outer time only for user messages across forward and backward pages", () => {
  const entries = [
    { id: "u0", parentId: null, type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", timestamp: 101, content: "old" } },
    { id: "a0", parentId: "u0", type: "message", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", timestamp: 102, content: "old answer" } },
    { id: "u1", parentId: "a0", type: "message", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", timestamp: 103, content: "middle" } },
    { id: "a1", parentId: "u1", type: "message", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "assistant", timestamp: 104, content: "middle answer" } },
    { id: "u2", parentId: "a1", type: "message", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "user", timestamp: 105, content: "latest" } },
    { id: "a2", parentId: "u2", type: "message", timestamp: "2026-01-01T00:00:06.000Z", message: { role: "assistant", timestamp: 106, content: "latest answer" } },
  ];
  const page = buildSessionContext(entries, "a2", { tail: 3 });
  const pageUser = page.messages.find((message) => message.role === "user");
  assert.equal(pageUser.displayTimestamp, Date.parse("2026-01-01T00:00:03.000Z"));
  assert.equal(pageUser.timestamp, 103);

  const backward = buildSessionContext(entries, page.entryIds[0], { tail: 3, excludeLeaf: true });
  const backwardUser = backward.messages.find((message) => message.role === "user");
  assert.equal(backwardUser.displayTimestamp, Date.parse("2026-01-01T00:00:01.000Z"));
  assert.equal(backwardUser.timestamp, 101);
});

test("excludeLeaf pages backward without duplicating the cursor", () => {
  const entries = linearChain(100);
  const page1 = buildSessionContext(entries, "e52", { tail: 5 }).entryIds;
  const page2 = buildSessionContext(entries, page1[0], { tail: 5, excludeLeaf: true }).entryIds;
  assert.deepEqual(page1, ["e48", "e49", "e50", "e51", "e52"]);
  assert.deepEqual(page2, ["e42", "e43", "e44", "e45", "e46", "e47"]);
  assert.equal(page2.at(-1), "e47");
  assert.ok(page1.every((id) => !page2.includes(id)));
});

test("backward pagination stops at the root", () => {
  const page = buildSessionContext(linearChain(3), "e0", { tail: 5, excludeLeaf: true });
  assert.deepEqual(page.entryIds, []);
  assert.equal(page.hasMore, false);
});

test("tail parsing is additive and capped", () => {
  assert.equal(parseSessionTail(null, false), undefined);
  assert.equal(parseSessionTail(null, true), 50);
  assert.equal(parseSessionTail("0", true), 1);
  assert.equal(parseSessionTail("5000", true), 1000);
  assert.equal(parseSessionTail("bad", true), 50);
});

test("keeps the compaction card in front of a bounded page", () => {
  const entries = [
    { id: "old-user", parentId: null, type: "message", message: { role: "user", content: "old" } },
    { id: "old-answer", parentId: "old-user", type: "message", message: { role: "assistant", content: "old answer" } },
    { id: "kept-user", parentId: "old-answer", type: "message", message: { role: "user", content: "kept" } },
    {
      id: "compact",
      parentId: "kept-user",
      type: "compaction",
      summary: "summary",
      firstKeptEntryId: "kept-user",
      tokensBefore: 100,
    },
    { id: "current-user", parentId: "compact", type: "message", message: { role: "user", content: "current" } },
    { id: "tool", parentId: "current-user", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "result" }] } },
    { id: "answer", parentId: "tool", type: "message", message: { role: "assistant", content: "final answer" } },
  ];

  const page = buildSessionContext(entries, "answer", { tail: 3 });

  // The page is bounded to the requested tail; the compaction card that
  // summarizes the hidden prefix is carried in front of it.
  assert.deepEqual(page.entryIds, ["compact", "current-user", "tool", "answer"]);
  assert.equal(page.messages[0].customType, "compaction");
  assert.equal(typeof page.messages.at(-1).content === "string" ? page.messages.at(-1).content : page.messages.at(-1).content[0].text, "final answer");
  // The cursor is a real page entry, not the added card, so paging back does
  // not re-offer an already-visible message.
  assert.equal(page.oldestEntryId, "current-user");
  assert.equal(page.hasMore, true);
});

test("returns a bounded page when the branch has several compactions", () => {
  const entries = [
    { id: "u1", parentId: null, type: "message", message: { role: "user", content: "old request" } },
    { id: "a1", parentId: "u1", type: "message", message: { role: "assistant", content: "old answer" } },
    {
      id: "cmp1",
      parentId: "a1",
      type: "compaction",
      summary: "first summary",
      firstKeptEntryId: "a1",
      tokensBefore: 100,
    },
    { id: "u2", parentId: "cmp1", type: "message", message: { role: "user", content: "middle request" } },
    { id: "a2", parentId: "u2", type: "message", message: { role: "assistant", content: "middle answer" } },
    {
      id: "cmp2",
      parentId: "a2",
      type: "compaction",
      summary: "latest summary",
      firstKeptEntryId: "a2",
      tokensBefore: 200,
    },
    { id: "u3", parentId: "cmp2", type: "message", message: { role: "user", content: "latest request" } },
    { id: "a3", parentId: "u3", type: "message", message: { role: "assistant", content: "latest answer" } },
  ];

  const page = buildSessionContext(entries, "a3", { tail: 2 });

  // Only the newest compaction travels with the page. The older one stays
  // behind the pagination cursor and is fetched when the reader scrolls up,
  // or all at once through the minimap's expand control.
  assert.deepEqual(page.entryIds, ["cmp2", "u3", "a3"]);
  assert.equal(page.messages.some((message) => message.content === "first summary"), false);
  assert.equal(page.messages.some((message) => message.content === "latest summary"), true);
  assert.equal(typeof page.messages.at(-1).content === "string" ? page.messages.at(-1).content : page.messages.at(-1).content[0].text, "latest answer");
  // Cursor is the oldest real page entry, not the added card.
  assert.equal(page.oldestEntryId, "u3");
  assert.equal(page.hasMore, true);
  assert.deepEqual(buildSessionHistoryInfo(entries, "a3", page), {
    hasEarlierHistory: true,
    hasCompaction: true,
    totalMessages: 8,
  });
});

test("backward pagination still excludes its cursor around compaction entries", () => {
  const entries = [
    { id: "old-user", parentId: null, type: "message", message: { role: "user", content: "old" } },
    { id: "kept-user", parentId: "old-user", type: "message", message: { role: "user", content: "kept" } },
    { id: "old-answer", parentId: "kept-user", type: "message", message: { role: "assistant", content: "old answer" } },
    { id: "current-user", parentId: "old-answer", type: "message", message: { role: "user", content: "current" } },
    { id: "tool", parentId: "current-user", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "result" }] } },
    { id: "answer", parentId: "tool", type: "message", message: { role: "assistant", content: "final answer" } },
    {
      id: "compact",
      parentId: "answer",
      type: "compaction",
      summary: "summary",
      firstKeptEntryId: "kept-user",
      tokensBefore: 100,
    },
  ];

  const page = buildSessionContext(entries, "answer", { tail: 2, excludeLeaf: true });
  assert.deepEqual(page.entryIds, ["current-user", "tool"]);
  assert.equal(page.oldestEntryId, "current-user");
  assert.equal(page.hasMore, true);
});

test("mid-turn compaction does not prepend compaction card above initiating user prompt", () => {
  const entries = [
    { id: "u1", parentId: null, type: "message", message: { role: "user", content: "initial prompt" } },
    { id: "t1", parentId: "u1", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "step 1" }] } },
    { id: "t2", parentId: "t1", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "step 2" }] } },
    {
      id: "mid-compact",
      parentId: "t2",
      type: "compaction",
      summary: "mid-turn summary",
      firstKeptEntryId: "t2",
      tokensBefore: 200,
    },
    { id: "t3", parentId: "mid-compact", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "step 3" }] } },
    { id: "a1", parentId: "t3", type: "message", message: { role: "assistant", content: "still working" } },
  ];

  // A bounded page anchored to the initiating prompt must keep the prompt first;
  // it must never place the mid-turn compaction summary above the prompt that caused it.
  const page = buildSessionContext(entries, "a1", { tail: 3 });
  assert.equal(page.entryIds[0], "u1");
  assert.equal(page.messages[0].role, "user");
  assert.equal(page.messages[0].content, "initial prompt");
});

