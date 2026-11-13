import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";
import { createSealedPublicInputEnvironment } from "../../../../../test-support/sealed-public-inputs.mjs";

const sealed = await createSealedPublicInputEnvironment("cost-route");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET } = await jiti.import("./route.ts");
const { cacheSessionPath } = await jiti.import("../../../../../lib/session-reader.ts");

const sessionDir = await mkdtemp(join(tmpdir(), "pi-web-cost-"));
const sessionId = "w2b-cost-cache-test";
const sessionFile = join(sessionDir, "session.jsonl");
after(async () => {
  await rm(sessionDir, { recursive: true, force: true });
  await sealed.restore();
});

function message(model, provider, id = "assistant-1", timestamp = "2026-08-26T18:00:00.000Z") {
  return {
    type: "message",
    id,
    timestamp,
    message: { role: "assistant", provider, model, usage: { input: 100, output: 10 } },
  };
}

async function writeSession(...entries) {
  await writeFile(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n"));
}

async function fetchCost(view = "full", id = sessionId) {
  const response = await GET(new Request(`http://localhost/api/sessions/${id}/cost${view === "summary" ? "?view=summary" : ""}`), { params: Promise.resolve({ id }) });
  const body = await response.json();
  if (view === "full") {
    const summary = await fetchCost("summary", id);
    const billing = { ...body };
    for (const key of ["contextUsage", "compactionContexts", "messageCosts", "imageGenerationCosts", "compactionCosts"]) delete billing[key];
    assert.deepEqual(summary, billing, "summary preserves aggregate billing fields without transcript detail");
    assert.equal("messageCosts" in summary, false);
    assert.equal("imageGenerationCosts" in summary, false);
    assert.equal("compactionCosts" in summary, false);
  }
  return body;
}

test("unknown cost sessions are rejected without a billing response", async () => {
  const id = `missing-cost-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response = await GET(new Request(`http://localhost/api/sessions/${id}/cost`), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Session not found" });
});

test("unsafe cost session identifiers cannot escape the session resolver", async () => {
  for (const id of ["../outside", "/absolute", "nested/escape"]) {
    const response = await GET(new Request("http://localhost/api/sessions/invalid/cost"), { params: Promise.resolve({ id }) });
    assert.equal(response.status, 404, id);
    assert.deepEqual(await response.json(), { error: "Session not found" });
  }
});

test("same revision summary and full requests share one in-flight pricing run", async () => {
  const id = `${sessionId}-in-flight`;
  const file = join(sessionDir, "in-flight.jsonl");
  const script = join(sessionDir, "in-flight-pricing.py");
  const marker = join(sessionDir, "in-flight-starts.log");
  const previousScript = process.env.PI_CONVERSATION_COST_SCRIPT;
  try {
    await writeFile(script, [
      "import json, time",
      `open(${JSON.stringify(marker)}, "a", encoding="utf-8").write("start\\n")`,
      "time.sleep(0.1)",
      "def price_usages(items):",
      "    return [{'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 0.5}, 'rates': {'currency': 'USD'}} for _ in items]",
    ].join("\n"), "utf8");
    await writeFile(file, [
      { type: "session", version: 3, id },
      message("gpt-5.5", "openai", "in-flight-assistant"),
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
    cacheSessionPath(id, file);
    process.env.PI_CONVERSATION_COST_SCRIPT = script;
    const [fullResponse, summaryResponse] = await Promise.all([
      GET(new Request(`http://localhost/api/sessions/${id}/cost`), { params: Promise.resolve({ id }) }),
      GET(new Request(`http://localhost/api/sessions/${id}/cost?view=summary`), { params: Promise.resolve({ id }) }),
    ]);
    assert.equal(fullResponse.status, 200);
    assert.equal(summaryResponse.status, 200);
    const full = await fullResponse.json();
    const summary = await summaryResponse.json();
    assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 1);
    assert.equal(summary.totalCost.amount, full.totalCost.amount);
    assert.equal("messageCosts" in summary, false);
    assert.equal("messageCosts" in full, true);
  } finally {
    if (previousScript === undefined) delete process.env.PI_CONVERSATION_COST_SCRIPT;
    else process.env.PI_CONVERSATION_COST_SCRIPT = previousScript;
  }
});

test("cost route reports read-only context usage", async () => {
  await writeSession(
    { type: "session", version: 3, id: sessionId, timestamp: "2026-08-27T00:00:00.000Z", cwd: sessionDir },
    { type: "model_change", id: "model-1", parentId: null, timestamp: "2026-08-27T00:00:01.000Z", provider: "openai", modelId: "gpt-5.5" },
    { type: "message", id: "user-1", parentId: "model-1", timestamp: "2026-08-27T00:00:02.000Z", message: { role: "user", content: "hello" } },
    { type: "compaction", id: "compaction-1", parentId: "user-1", timestamp: "2026-08-27T00:00:02.500Z", summary: "summary", firstKeptEntryId: "assistant-1", tokensBefore: 1000 },
    { type: "message", id: "assistant-1", parentId: "compaction-1", timestamp: "2026-08-27T00:00:03.000Z", message: { role: "assistant", provider: "openai", model: "gpt-5.5", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 } } },
  );
  cacheSessionPath(sessionId, sessionFile);
  const body = await fetchCost();
  assert.ok(body.contextUsage);
  assert.ok(body.contextUsage.contextWindow > 0);
  assert.equal(body.contextUsage.tokens, 110);
  assert.equal(body.compactionContexts["compaction-1"].tokensBefore, 1000);
  assert.equal(body.compactionContexts["compaction-1"].contextWindow, body.contextUsage.contextWindow);
});

test("unknown official model usage is a zero lower bound while preserving the missing model", async () => {
  await writeSession({ type: "session", version: 3, id: sessionId }, message("unknown-model", "openai"));
  cacheSessionPath(sessionId, sessionFile);
  const body = await fetchCost();
  assert.equal(body.status, "partial");
  assert.equal(body.amount, 0);
  assert.equal(body.totalCost.status, "partial");
  assert.equal(body.totalCost.amount, 0);
  assert.equal(body.totalCost.unavailableSessions, 0);
  assert.equal(body.usage.totalTokens, 110);
  assert.deepEqual(body.messageCosts, {});
  assert.deepEqual(body.missingPriceModels, ["openai/unknown-model"]);
});
test("returns per-compaction usage and price from shared billing", async () => {
  await writeSession(
    { type: "session", version: 3, id: sessionId },
    message("gpt-5.5", "openai"),
    {
      type: "compaction",
      id: "compaction-1",
      parentId: "assistant-1",
      timestamp: "2026-08-24T00:00:00.000Z",
      summary: "summary",
      firstKeptEntryId: "next",
      tokensBefore: 1000,
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 110 },
    },
  );
  cacheSessionPath(sessionId, sessionFile);
  const body = await fetchCost();
  assert.equal(body.compactionCosts["compaction-1"].usage.totalTokens, 110);
  assert.ok(Math.abs(body.compactionCosts["compaction-1"].amount - 0.0008) < 1e-12);
  assert.equal(body.compactionCosts["compaction-1"].status, "calculated");
  assert.ok(body.compactionCost);
  assert.ok(Math.abs(body.compactionCost.amount - 0.0008) < 1e-12);
});

test("unknown official recap usage remains a zero lower bound", async () => {
  await writeSession(
    { type: "session", version: 3, id: sessionId },
    {
      type: "custom",
      id: "recap-unknown",
      timestamp: "2026-08-24T00:00:00.000Z",
      data: {
        kind: "recap",
        provider: "openai",
        model: "unknown-recap-model",
        usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 110 },
      },
    },
  );
  cacheSessionPath(sessionId, sessionFile);
  const body = await fetchCost();
  assert.equal(body.recapCost.status, "partial");
  assert.equal(body.recapCost.amount, 0);
  assert.deepEqual(body.recapCost.missingPriceModels, ["openai/unknown-recap-model"]);
});

test("unknown official compaction usage exposes a zero lower bound", async () => {
  await writeSession(
    { type: "session", version: 3, id: sessionId },
    message("unknown-compaction-model", "openai"),
    {
      type: "compaction",
      id: "compaction-unknown",
      parentId: "assistant-1",
      timestamp: "2026-08-24T00:00:00.000Z",
      summary: "summary",
      firstKeptEntryId: "next",
      tokensBefore: 1000,
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 110 },
    },
  );
  cacheSessionPath(sessionId, sessionFile);
  const body = await fetchCost();
  assert.equal(body.compactionCosts["compaction-unknown"].status, "partial");
  assert.equal(body.compactionCosts["compaction-unknown"].amount, 0);
  assert.equal(body.compactionCost.status, "partial");
  assert.equal(body.compactionCost.amount, 0);
  assert.deepEqual(body.compactionCost.missingPriceModels, ["openai/unknown-compaction-model"]);
});

test("prices WorkBuddy MiniMax through the official tariff", async () => {
  await writeSession({ type: "session", version: 3, id: sessionId }, message("minimax-m3", "WorkBuddy"));
  cacheSessionPath(sessionId, sessionFile);
  const body = await fetchCost();
  assert.equal(body.status, "calculated");
  assert.equal(body.amount, 0.000042);
  assert.deepEqual(body.missingPriceModels, []);
});

test("treats an unmatched gateway model as zero-cost partial usage", async () => {
  await writeSession({ type: "session", version: 3, id: sessionId }, message("minimax-m3-free", "Sub2API 国产"));
  cacheSessionPath(sessionId, sessionFile);
  const body = await fetchCost();
  assert.equal(body.status, "partial");
  assert.equal(body.amount, 0);
  assert.deepEqual(body.missingPriceModels, ["Sub2API 国产/minimax-m3-free"]);
});

test("mixed priced and unknown models return known partial amount", async () => {
  await writeSession(
    { type: "session", version: 3, id: sessionId },
    message("unknown-model", "openai"),
    message("gpt-5.5", "openai"),
  );
  cacheSessionPath(sessionId, sessionFile);
  const body = await fetchCost();
  assert.equal(body.status, "partial");
  assert.ok(Math.abs(body.amount - 0.0008) < 1e-12);
  assert.equal(body.totalCost.status, "partial");
  assert.ok(Math.abs(body.totalCost.amount - 0.0008) < 1e-12);
  assert.deepEqual(body.missingPriceModels, ["openai/unknown-model"]);
});

test("priced sessions pass through and appends invalidate the mtime cache", async () => {
  await writeSession({ type: "session", version: 3, id: sessionId }, message("gpt-5.5", "openai", "assistant-1"));
  const first = await fetchCost();
  assert.equal(first.status, "calculated");
  assert.equal(first.amount, 0.0008);
  assert.equal(first.usage.totalTokens, 110);

  // Unchanged file: the cache serves an identical result.
  assert.deepEqual(await fetchCost(), first);

  // Append-only growth changes the mtime, so the result must be recomputed.
  await writeSession(
    { type: "session", version: 3, id: sessionId },
    message("gpt-5.5", "openai", "assistant-1"),
    message("gpt-5.5", "openai", "assistant-2"),
  );
  const grown = await fetchCost();
  assert.equal(grown.status, "calculated");
  assert.equal(grown.amount, 0.0016);
  assert.equal(grown.usage.totalTokens, 220);
});

test("cost route invalidates for session, calculator, and price-table changes", async () => {
  // Cache structure moved to the shared bounded cache (lib/session-caches.ts);
  // the route still consumes it via readCost/cacheCost and re-checks revisions.
  const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
  const cacheSource = await readFile(new URL("../../../../../lib/session-caches.ts", import.meta.url), "utf8");
  assert.match(cacheSource, /sessionMtimeMs: number;/);
  assert.match(cacheSource, /scriptMtimeMs: number \| null;/);
  assert.match(cacheSource, /priceTableSignature: string;/);
  assert.match(cacheSource, /sessionRevision\?: string;/);
  assert.match(cacheSource, /const COST_CACHE_MAX = 500;/);
  assert.match(source, /readCost\(id\)/);
  assert.match(source, /costInFlight = new Map<string, Promise<SessionCostResult>>\(\)/);
  assert.match(source, /cached\.sessionMtimeMs === sessionMtimeMs/);
  assert.match(source, /sessionCostRevision/);
  assert.match(source, /cached\.sessionRevision === sessionRevision/);
  assert.match(source, /cached\.scriptMtimeMs === scriptMtimeMs/);
  assert.match(source, /billingPriceDataSignature\(\)/);
  assert.match(source, /cached\.priceTableSignature === priceTableSignature/);
  assert.doesNotMatch(source, /billingPriceDataCachePath/);
  assert.doesNotMatch(source, /billingPriceTablePath/);
});

test("aggregates persisted subagent costs and invalidates when child content grows", async () => {
  const childFile = join(sessionDir, "session", "run-0", "session.jsonl");
  const nestedChildFile = join(sessionDir, "session", "run-0", "nested", "run-0", "session.jsonl");
  await writeSession({ type: "session", version: 3, id: sessionId }, message("gpt-5.5", "openai", "parent-assistant"));
  await mkdir(join(sessionDir, "session", "run-0"), { recursive: true });
  await mkdir(join(sessionDir, "session", "run-0", "nested", "run-0"), { recursive: true });
  await writeFile(childFile, [
    JSON.stringify({ type: "session", version: 3, id: "child-1", parentSession: sessionFile }),
    JSON.stringify(message("gpt-5.5", "openai", "child-assistant")),
  ].join("\n"));
  await writeFile(nestedChildFile, [
    JSON.stringify({ type: "session", version: 3, id: "nested-child-1", parentSession: childFile }),
    JSON.stringify(message("gpt-5.5", "openai", "nested-assistant")),
  ].join("\n"));
  cacheSessionPath(sessionId, sessionFile);

  const first = await fetchCost();
  assert.equal(first.parentCost.amount, 0.0008);
  assert.equal(first.childCost.amount, 0.0016);
  assert.equal(first.childCost.sessionCount, 2);
  assert.equal(first.totalCost.amount, 0.0024);
  assert.equal(first.amount, 0.0024);
  assert.equal(first.usage.totalTokens, 330);

  await writeFile(childFile, [
    JSON.stringify({ type: "session", version: 3, id: "child-1", parentSession: sessionFile }),
    JSON.stringify(message("gpt-5.5", "openai", "child-assistant")),
    JSON.stringify(message("gpt-5.5", "openai", "child-assistant-2")),
  ].join("\n"));
  const grown = await fetchCost();
  assert.equal(grown.childCost.amount, 0.0024);
  assert.equal(grown.totalCost.amount, 0.0032);
  assert.equal(grown.usage.totalTokens, 440);
  await writeFile(childFile, [
    JSON.stringify({ type: "session", version: 3, id: "child-1", parentSession: sessionFile }),
    JSON.stringify(message("unknown-model", "openai")),
  ].join("\n"));
  const partial = await fetchCost();
  assert.equal(partial.parentCost.amount, 0.0008);
  assert.equal(partial.childCost.status, "partial");
  assert.equal(partial.childCost.amount, 0.0008);
  assert.equal(partial.totalCost.status, "partial");
  assert.ok(Math.abs(partial.totalCost.amount - 0.0016) < 1e-12);
  assert.ok(Math.abs(partial.amount - 0.0016) < 1e-12);
  assert.deepEqual(partial.missingPriceModels, ["openai/unknown-model"]);

  await rm(join(sessionDir, "session"), { recursive: true, force: true });
  const removed = await fetchCost();
  assert.equal(removed.childCost.sessionCount, 0, "deleting persisted children invalidates the child aggregate");
  assert.equal(removed.totalCost.amount, removed.parentCost.amount);
});

test("cost route returns live RPC context usage when session is active", async () => {
  const previousRegistry = globalThis.__piSessions;
  const mockRegistry = new Map();
  mockRegistry.set(sessionId, {
    isAlive: () => true,
    isShuttingDown: () => false,
    getContextUsage: () => ({ percent: 40, contextWindow: 512000, tokens: 204800 }),
  });
  globalThis.__piSessions = mockRegistry;
  try {
    const body = await fetchCost();
    assert.deepEqual(body.contextUsage, { percent: 40, contextWindow: 512000, tokens: 204800 });
  } finally {
    globalThis.__piSessions = previousRegistry;
  }
});

test("full context follows model configuration changes after a summary cache hit", async () => {
  const modelsFile = join(sealed.agentDir, "models.json");
  const { invalidateReadOnlyModelRuntime } = await jiti.import("../../../../../lib/session-context-usage.ts");
  await writeSession(
    { type: "session", version: 3, id: sessionId, cwd: sessionDir },
    { type: "model_change", id: "model-config", parentId: null, provider: "openai", modelId: "gpt-5.5" },
    { ...message("gpt-5.5", "openai"), parentId: "model-config" },
  );
  try {
    for (const contextWindow of [256000, 512000]) {
      await writeFile(modelsFile, JSON.stringify({ providers: { openai: { modelOverrides: { "gpt-5.5": { contextWindow } } } } }));
      // Same invalidation as an explicit model configuration save, not a session change.
      invalidateReadOnlyModelRuntime();
      const summary = await fetchCost("summary");
      assert.equal("contextUsage" in summary, false);
      const full = await fetchCost();
      assert.equal(full.contextUsage.contextWindow, contextWindow);
      assert.equal(full.parentCost.amount, 0.0008);
    }
  } finally {
    await rm(modelsFile, { force: true });
    invalidateReadOnlyModelRuntime();
  }
});

test("image reconciliation preserves known message prices and publishes the final request charge once", async () => {
  const billing = { status: "pending", source: "apimart-task", taskId: "task-route", toolCallId: "call_fixture|fc_fixture", currency: "USD", startedAt: 1792886400000 };
  const image = (id, observed) => ({ type: "custom", id, customType: "image-generation-usage", timestamp: "2026-10-25T00:00:00Z",
    data: { version: 2, provider: "apimart", model: "gpt-image-2-official", billing: observed,
      usage: { input: 0, output: 0, inputImage: 0, outputImage: 0, usageAvailable: false },
      usageEvent: { version: 1, id: "image-generation:route", relation: "origin" } } });
  // This session must not inherit the preceding subagent fixture's unpriced children.
  const imageSessionId = `${sessionId}-image`;
  const imageSessionFile = join(sessionDir, "image-settlement.jsonl");
  const writeImageSession = (...entries) => writeFile(imageSessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  const header = { type: "session", version: 3, id: imageSessionId };
  await writeImageSession(header, message("gpt-5.5", "openai"), image("submitted", billing));
  cacheSessionPath(imageSessionId, imageSessionFile);
  const waiting = await fetchCost("full", imageSessionId);
  assert.equal(waiting.amount, null);
  assert.equal(waiting.status, "unavailable");
  assert.equal(waiting.childCost.sessionCount, 0);
  assert.ok(waiting.messageCosts["assistant-1"] > 0);
  assert.equal(waiting.imageGenerationCosts[0].status, "pending");
  const output = { version: 1, toolCallId: "call_fixture|fc_fixture", files: ["/tmp/generated.png"], usageIds: ["image-generation:route"] };
  await writeImageSession(header, message("gpt-5.5", "openai"), image("submitted", billing),
    { type: "custom", id: "output-route", customType: "image-generation-output", data: output },
    image("settled", { ...billing, status: "confirmed", amount: 0.015, credits: 0.15, returnedImages: 2 }));
  const settled = await fetchCost("full", imageSessionId);
  assert.equal(settled.status, "calculated");
  assert.equal(settled.amount, 0.0158);
  assert.equal(settled.imageGenerationCosts.length, 1);
  assert.equal(settled.imageGenerationCosts[0].amount, 0.015);
  assert.deepEqual(settled.imageGenerationCosts[0].outputs, [output]);
  assert.equal("imageGenerationCosts" in (await fetchCost("summary", imageSessionId)), false);
});

test("cost cache observes late extension journal settlement without a session file change", async () => {
  const id = `${sessionId}-extension`, file = join(sessionDir, "extension.jsonl");
  await writeFile(file, JSON.stringify({ type: "session", version: 3, id, cwd: sessionDir }) + "\n");
  cacheSessionPath(id, file);
  assert.equal((await fetchCost("summary", id)).amount, 0);
  const dir = join(sealed.agentDir, "session-extension-usage", createHash("sha256").update(id).digest("hex"));
  await mkdir(dir, { recursive: true });
  const journal = join(dir, "fixture-extension.jsonl");
  const event = { version: 1, extensionId: "fixture-extension", kind: "suggester", status: "started", provider: "openai", model: "gpt-5.5",
    timestamp: "2026-08-26T18:00:00Z", usageEvent: { version: 1, id: "request-1", relation: "origin" }, usage: { usageAvailable: false } };
  await writeFile(journal, JSON.stringify(event) + "\n");
  assert.equal((await fetchCost("summary", id)).status, "unavailable");
  await appendFile(journal, JSON.stringify({ ...event, status: "settled", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, usageAvailable: true } }) + "\n");
  const settled = await fetchCost("full", id);
  assert.equal(settled.status, "calculated"); assert.equal(settled.amount, 0.0008);
  assert.equal(settled.extensionCosts[0].id, "fixture-extension");
});

test("summary and full costs both reprice when the canonical price input changes", async () => {
  const original = await readFile(sealed.cachePath, "utf8");
  await writeSession({ type: "session", version: 3, id: sessionId }, message("gpt-5.5", "openai"));
  assert.equal((await fetchCost("summary")).parentCost.amount, 0.0008);
  try {
    const prices = JSON.parse(original);
    const model = prices.find((provider) => provider.id === "openai").models.find((model) => model.id === "gpt-5.5");
    model.prices.input_mtok.base = 10;
    await writeFile(sealed.cachePath, JSON.stringify(prices));
    const summary = await fetchCost("summary");
    assert.ok(Math.abs(summary.parentCost.amount - 0.0013) < 1e-12);
    const full = await fetchCost();
    assert.equal(full.parentCost.amount, summary.parentCost.amount);
  } finally {
    await writeFile(sealed.cachePath, original);
  }
});
