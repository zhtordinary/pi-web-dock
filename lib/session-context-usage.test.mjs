import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { estimateSessionContextUsage, getCompactionContextInfo, getReadOnlyModelRuntime, invalidateReadOnlyModelRuntime } = await jiti.import("./session-context-usage.ts");

function assistantMessage(totalTokens = 120) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    stopReason: "stop",
    usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens },
  };
}

function assistantEntry(id, totalTokens = 120) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-08-27T00:00:00.000Z",
    message: { ...assistantMessage(totalTokens), provider: "test", model: "test-model" },
  };
}

function compactionEntry() {
  return {
    type: "compaction",
    id: "compact-1",
    parentId: null,
    timestamp: "2026-08-27T00:00:00.000Z",
    summary: "summary",
    firstKeptEntryId: "assistant-1",
    tokensBefore: 500,
  };
}

test("uses assistant usage and estimates messages after it", () => {
  const result = estimateSessionContextUsage(
    [assistantMessage(), { role: "user", content: "x".repeat(40) }],
    [assistantEntry("assistant-1")],
    1000,
  );
  assert.equal(result.contextWindow, 1000);
  assert.equal(result.tokens > 120, true);
  assert.equal(result.percent > 12, true);
});

test("returns unknown until a valid assistant response follows compaction", () => {
  const unknown = estimateSessionContextUsage([assistantMessage()], [compactionEntry()], 1000);
  assert.deepEqual(unknown, { tokens: null, contextWindow: 1000, percent: null });

  const known = estimateSessionContextUsage(
    [assistantMessage()],
    [compactionEntry(), assistantEntry("assistant-1")],
    1000,
  );
  assert.equal(known.tokens, 120);
  assert.equal(known.percent, 12);
});

test("rejects non-positive context windows", () => {
  assert.equal(estimateSessionContextUsage([], [], 0), null);
});

test("resolves compaction context windows from the historical model timeline", () => {
  const models = new Map([
    ["provider/small", { contextWindow: 1_000 }],
    ["provider/large", { contextWindow: 2_000 }],
  ]);
  const result = getCompactionContextInfo([
    { type: "model_change", id: "model-1", parentId: null, timestamp: "2026-08-27T00:00:00.000Z", provider: "provider", modelId: "small" },
    { type: "compaction", id: "compact-1", parentId: null, timestamp: "2026-08-27T00:00:00.000Z", summary: "summary", firstKeptEntryId: "kept-1", tokensBefore: 900 },
    { type: "model_change", id: "model-2", parentId: null, timestamp: "2026-08-27T00:00:00.000Z", provider: "provider", modelId: "large" },
    { type: "compaction", id: "compact-2", parentId: null, timestamp: "2026-08-27T00:00:00.000Z", summary: "summary", firstKeptEntryId: "kept-2", tokensBefore: 1_500 },
    { type: "compaction", id: "compact-3", parentId: null, timestamp: "2026-08-27T00:00:00.000Z", summary: "summary", firstKeptEntryId: "kept-3", tokensBefore: 100, provider: "missing", model: "model" },
  ], { getModel: (provider, modelId) => models.get(`${provider}/${modelId}`) });

  assert.deepEqual(result, {
    "compact-1": { tokensBefore: 900, contextWindow: 1_000, provider: "provider", model: "small" },
    "compact-2": { tokensBefore: 1_500, contextWindow: 2_000, provider: "provider", model: "large" },
    "compact-3": { tokensBefore: 100, contextWindow: null, provider: "missing", model: "model" },
  });
});

test("getReadOnlyModelRuntime caches runtime and invalidates on demand", async () => {
  const first = await getReadOnlyModelRuntime();
  const second = await getReadOnlyModelRuntime();
  assert.equal(first, second);
  invalidateReadOnlyModelRuntime();
  const third = await getReadOnlyModelRuntime();
  assert.notEqual(first, third);
});
