import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createJiti } from "jiti";
import { createSealedPublicInputEnvironment } from "../test-support/sealed-public-inputs.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { estimateSessionContextUsage, getCompactionContextInfo, getReadOnlyModelRuntime, invalidateReadOnlyModelRuntime, readSessionContextUsageFromFile } = await jiti.import("./session-context-usage.ts");

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

test("metadata context usage follows the requested branch leaf", async () => {
  const sealed = await createSealedPublicInputEnvironment("context-leaf");
  const root = await mkdtemp(join(tmpdir(), "pi-web-context-leaf-"));
  const file = join(root, "session.jsonl");
  try {
    await writeFile(join(sealed.agentDir, "models.json"), JSON.stringify({ providers: { openai: { modelOverrides: { "gpt-5.5": { contextWindow: 1000 } } } } }));
    const entries = [
      { type: "session", version: 3, id: "branch-context", timestamp: "2026-01-01T00:00:00.000Z", cwd: root },
      { type: "model_change", id: "model", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", provider: "openai", modelId: "gpt-5.5" },
      { type: "message", id: "root", parentId: "model", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "root" } },
      { type: "message", id: "old", parentId: "root", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", provider: "openai", model: "gpt-5.5", content: [{ type: "text", text: "old" }], stopReason: "stop", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 } } },
      { type: "message", id: "old-tail", parentId: "old", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", content: "old tail" } },
      { type: "message", id: "new", parentId: "root", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "assistant", provider: "openai", model: "gpt-5.5", content: [{ type: "text", text: "new" }], stopReason: "stop", usage: { input: 300, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 320 } } },
      { type: "message", id: "new-tail", parentId: "new", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "user", content: "new tail with more bytes" } },
    ];
    await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    invalidateReadOnlyModelRuntime();
    const oldUsage = await readSessionContextUsageFromFile(file, "old-tail");
    const newUsage = await readSessionContextUsageFromFile(file, "new-tail");
    assert.ok(oldUsage && newUsage);
    assert.notEqual(oldUsage.tokens, newUsage.tokens);
    assert.equal(oldUsage.contextWindow, 1000);
    assert.equal(newUsage.contextWindow, 1000);
  } finally {
    await rm(root, { recursive: true, force: true });
    await sealed.restore();
    invalidateReadOnlyModelRuntime();
  }
});

test("getReadOnlyModelRuntime caches runtime and invalidates on demand", async () => {
  const first = await getReadOnlyModelRuntime();
  const second = await getReadOnlyModelRuntime();
  assert.equal(first, second);
  invalidateReadOnlyModelRuntime();
  const third = await getReadOnlyModelRuntime();
  assert.notEqual(first, third);
});
