import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";
import { createSealedPublicInputEnvironment } from "../test-support/sealed-public-inputs.mjs";

const sealed = await createSealedPublicInputEnvironment("billing");
after(() => sealed.restore());

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { billingPriceDataSignature, calculateCompactionCosts, calculateSessionCost, extractReaderUsageRecords, findChildSessionPaths, sessionCostRevision, uniqueReaderUsageRecordGroups, priceTokenUsage, priceTokenUsages } = await jiti.import("./billing.ts");

test("uses genai-prices for official model data without changing billing shape", async () => {
  const priced = await priceTokenUsage({
    model: "gpt-5.6-sol",
    provider: "openai",
    input: 100,
    output: 10,
    timestamp: "2026-08-27T00:00:00Z",
  });
  assert.equal(priced.pricing.configured, true);
  assert.equal(priced.pricing.priceEngine, "genai-prices");
  assert.equal(priced.pricing.priceTableId, "genai-prices/openai/gpt-5.6-sol");
  assert.ok(priced.cost);
  assert.ok(Math.abs(priced.cost.total - (priced.cost.input + priced.cost.cacheRead + priced.cost.cacheWrite + priced.cost.output)) < 1e-12);
  assert.equal(priced.usage.totalTokens, 110);
});

test("OpenAI auth aliases retain the canonical OpenAI price table", async () => {
  const priced = await priceTokenUsage({
    model: "gpt-5.6-sol",
    provider: "openai-api",
    input: 100,
    output: 10,
    timestamp: "2026-08-27T00:00:00Z",
  });
  assert.equal(priced.pricing.priceTableId, "genai-prices/openai/gpt-5.6-sol");
});

test("image generation is priced by modality and counted once per persisted event", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-image-billing-"));
  try {
    const usage = { input: 100, output: 1000, inputImage: 40, outputImage: 1000, totalTokens: 1100, usageAvailable: true };
    const timestamp = "2026-10-25T00:00:00Z";
    const image = await priceTokenUsage({ model: "gpt-image-2.5-flare", provider: "openai", timestamp, ...usage });
    assert.equal(image.pricing.configured, true);
    assert.equal(image.pricing.imageTokenPricing, true);
    assert.ok(Math.abs(image.cost.total - 0.03062) < 1e-12);
    assert.equal(image.usage.totalTokens, 1100);
    const path = join(root, "session.jsonl");
    const data = { provider: "openai", model: "gpt-image-2.5-flare", usage,
      usageEvent: { version: 1, id: "image-generation:test-request", relation: "origin" } };
    await writeFile(path, [
      { type: "session", id: "image-test" },
      { type: "custom", id: "image", customType: "image-generation-usage", timestamp, data },
      { type: "custom", id: "image-copy", customType: "image-generation-usage", timestamp, data },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const records = await extractReaderUsageRecords(path);
    assert.equal(records[0].usage.inputImage, 40);
    assert.equal(records[0].usage.outputImage, 1000);
    const result = await calculateSessionCost(path, sealed.scriptPath);
    assert.equal(result.cost.status, "calculated");
    assert.ok(Math.abs(result.cost.amount - image.cost.total) < 1e-10);
    assert.equal(result.usage.totalTokens, 1100);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("uses official image tariffs for CPA gateway labels", async () => {
  const usage = { input: 100, output: 1000, inputImage: 0, outputImage: 1000, totalTokens: 1100, usageAvailable: true };
  const [gemini, gpt] = await priceTokenUsages([
    { provider: "CPA Gemini Image", model: "gemini-3.1-flash-image", timestamp: "2026-10-25T00:00:00Z", ...usage },
    { provider: "CPA GPT IMAGE", model: "gpt-image-2", timestamp: "2026-10-25T00:00:00Z", ...usage },
  ]);
  assert.equal(gemini.pricing.configured, true);
  assert.equal(gemini.pricing.priceTableId, "genai-prices/google/gemini-3.1-flash-image-preview");
  assert.ok(Math.abs(gemini.cost.total - 0.06005) < 1e-12);
  assert.equal(gpt.pricing.configured, true);
  assert.equal(gpt.pricing.priceTableId, "genai-prices/openai/gpt-image-2");
  assert.ok(Math.abs(gpt.cost.total - 0.0305) < 1e-12);
});

test("empty pricing batches start no Python and official image estimates start exactly one necessary process", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-billing-image-estimate-process-"));
  try {
    const marker = join(root, "starts.log");
    const script = join(root, "pricing.py");
    await writeFile(script, [
      "import json, sys",
      `open(${JSON.stringify(marker)}, "a", encoding="utf-8").write("start\\n")`,
      "def price_usages(items):",
      "    return [{'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 0.25}, 'rates': {'currency': 'USD', 'imageTokenPricing': True}} for _ in items]",
    ].join("\n"), "utf8");
    assert.deepEqual(await priceTokenUsages([], script), []);
    assert.equal(await readFile(marker, "utf8").catch(() => ""), "");

    const sessionPath = join(root, "image.jsonl");
    await writeFile(sessionPath, [
      { type: "session", version: 3, id: "image-estimate" },
      { type: "custom", id: "image-estimate", customType: "image-generation-usage", timestamp: "2026-10-25T00:00:00Z",
        data: {
          provider: "CPA GPT IMAGE", model: "gpt-image-2",
          usage: { input: 0, output: 0, usageAvailable: false },
          billing: { status: "pending", currency: "USD", startedAt: 1792886400000, source: "apimart-task", taskId: "task-estimate", requestedImages: 1, resolution: "1024x1024", toolCallId: "call-estimate" },
          usageEvent: { version: 1, id: "image-generation:estimate", relation: "origin" },
        },
      },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
    const result = await calculateSessionCost(sessionPath, script);
    assert.equal((await readFile(marker, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length, 1, "only the necessary official image estimate starts Python");
    assert.equal(result.imageGenerationCosts[0].status, "estimated");
    assert.equal(result.imageGenerationCosts[0].amount, 0.25);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("image generation without usage, model price or engine is unknown rather than free", async () => {
  for (const input of [
    { model: "gpt-image-2.5-flare", usageAvailable: false },
    { model: "unlisted-image-model", usageAvailable: true },
    { model: "gpt-image-2.5-flare", inputImage: 101, usageAvailable: true },
  ]) {
    const priced = await priceTokenUsage({ provider: "openai", timestamp: "2026-10-25T00:00:00Z",
      input: 100, output: 1000, inputImage: 40, outputImage: 1000, ...input });
    assert.equal(priced.pricing.configured, false);
    assert.notEqual(priced.pricing.lowerBound, true);
    assert.equal(priced.cost, undefined);
  }
  const engineMissing = await priceTokenUsage({ model: "gpt-image-2.5-flare", inputImage: 0, outputImage: 10, output: 10 }, null);
  assert.equal(engineMissing.cost, undefined);
});

test("unavailable persisted image usage makes the session amount unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-image-unavailable-"));
  try {
    const path = join(root, "session.jsonl");
    await writeFile(path, [
      { type: "session", id: "image-unknown" },
      { type: "custom", id: "image", customType: "image-generation-usage", timestamp: "2026-10-25T00:00:00Z",
        data: { provider: "openai", model: "gpt-image-2.5-flare", usage: { input: 0, output: 0, usageAvailable: false } } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const result = await calculateSessionCost(path, sealed.scriptPath);
    assert.equal(result.cost.status, "unavailable");
    assert.equal(result.cost.amount, null);
    assert.deepEqual(result.missingPriceModels, []);
    assert.equal(result.pendingUsageCount, 1);
    assert.deepEqual(result.pendingUsageModels, ["openai/gpt-image-2.5-flare"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("preserves explicit totalTokens through child billing pricing", async () => {
  const priced = await priceTokenUsage({
    model: "test",
    input: 1,
    output: 1,
    reasoning: 7,
    totalTokens: 99,
  });
  assert.equal(priced.usage.totalTokens, 99);
});

test("passes one-hour cache writes as a separate usage partition", async () => {
  const fiveMinute = await priceTokenUsage({
    model: "claude-sonnet-4",
    provider: "anthropic",
    cacheWrite: 100,
    timestamp: "2026-08-26T18:00:00Z",
  });
  const oneHour = await priceTokenUsage({
    model: "claude-sonnet-4",
    provider: "anthropic",
    cacheWrite: 100,
    cacheWrite1h: 100,
    timestamp: "2026-08-26T18:00:00Z",
  });
  assert.equal(fiveMinute.pricing.priceEngine, "genai-prices");
  assert.equal(oneHour.pricing.priceEngine, "genai-prices");
  assert.ok((oneHour.cost?.cacheWrite ?? 0) > (fiveMinute.cost?.cacheWrite ?? 0));
});

test("prices WorkBuddy models with their official provider tariff", async () => {
  const official = await priceTokenUsage({ model: "minimax-m3", provider: "minimax", input: 100, output: 10, timestamp: "2026-08-26T18:00:00Z" });
  const workbuddy = await priceTokenUsage({ model: "minimax-m3", provider: "WorkBuddy", input: 100, output: 10, timestamp: "2026-08-26T18:00:00Z" });
  assert.equal(official.pricing.priceEngine, "genai-prices");
  assert.equal(workbuddy.pricing.priceEngine, "genai-prices");
  assert.equal(workbuddy.pricing.priceTableId, "genai-prices/minimax/minimax-m3");
  assert.deepEqual(workbuddy.cost, official.cost);
});

async function createUnknownPricingScript(root, status) {
  const engineDir = join(root, "genai-prices");
  await mkdir(engineDir, { recursive: true });
  await writeFile(join(engineDir, "cli.cjs"), "// test CLI path\n", "utf8");
  await writeFile(join(engineDir, "engine.cjs"), `exports.state = () => ({ status: ${JSON.stringify(status)} });
exports.providerIdFor = (_model, provider) => String(provider).toLowerCase() === "openai" ? "openai" : null;
exports.isGatewayProvider = (provider) => String(provider).toLowerCase().includes("sub2api");\n`, "utf8");
  const scriptPath = join(root, "session_cost.py");
  await writeFile(scriptPath, `from pathlib import Path
import shutil

def price_usages(items):
    return [None for _ in items]

def engine_cli_path():
    return Path(__file__).resolve().parent / "genai-prices" / "cli.cjs"

def node_binary():
    return shutil.which("node")
`, "utf8");
  return scriptPath;
}

test("unpriced models are represented as zero-cost partial rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-billing-lower-bound-"));
  try {
    const scriptPath = await createUnknownPricingScript(root, "remote");
    const priced = await priceTokenUsages([
      { model: "not-in-catalog", provider: "openai", input: 10, timestamp: "2026-08-27T00:00:00Z" },
      { model: "not-in-catalog", provider: "Sub2API gateway", input: 10, timestamp: "2026-08-27T00:00:00Z" },
      { model: "not-in-catalog", provider: "custom-provider", input: 10, timestamp: "2026-08-27T00:00:00Z" },
      { model: "not-in-catalog", provider: "openai", input: 10 },
    ], scriptPath);
    assert.deepEqual(priced.map((item) => item.pricing.lowerBound === true), [true, true, true, true]);
    assert.ok(priced.every((item) => item.pricing.configured === false));
    assert.deepEqual(priced.map((item) => item.cost?.total), [0, 0, 0, 0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pricing engine outages still represent unknown models as zero cost", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-billing-engine-down-"));
  try {
    const priced = await priceTokenUsage({
      model: "not-in-catalog",
      provider: "openai",
      input: 10,
      timestamp: "2026-08-27T00:00:00Z",
    }, join(root, "missing-session-cost.py"));
    assert.equal(priced.pricing.configured, false);
    assert.equal(priced.pricing.lowerBound, true);
    assert.equal(priced.cost?.total, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing pricing engine keeps session totals as a zero-cost partial result", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-billing-engine-down-session-"));
  const sessionPath = join(root, "session.jsonl");
  try {
    await writeFile(sessionPath, [
      JSON.stringify({ type: "session", id: "engine-down" }),
      JSON.stringify({ type: "message", id: "assistant-1", timestamp: "2026-01-01T10:00:00Z", message: { role: "assistant", provider: "openai", model: "unknown-model", usage: { input: 10, output: 1 } } }),
    ].join("\n") + "\n", "utf8");
    const result = await calculateSessionCost(sessionPath, null);
    assert.equal(result.totalCost.status, "partial");
    assert.equal(result.totalCost.amount, 0);
    assert.equal(result.totalCost.unavailableSessions, 0);
    assert.equal(result.usage.totalTokens, 11);
    assert.deepEqual(result.totalCost.missingPriceModels, ["openai/unknown-model"]);
    assert.deepEqual(result.messageCosts ?? {}, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session totals keep priced models and treat unpriced models as zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-billing-mixed-unpriced-"));
  const sessionPath = join(root, "session.jsonl");
  const pricing = join(root, "pricing.py");
  try {
    await writeFile(pricing, [
      "import json, sys",
      "def price_usages(items):",
      "    rows = []",
      "    for item in items:",
      "        if item.get('model') == 'unknown-model': rows.append(None); continue",
      "        u = item['usage']; total = sum(int(u.get(k, 0) or 0) for k in ('input', 'cacheRead', 'cacheWrite', 'output'))",
      "        rows.append({'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': total}, 'rates': {'currency': 'USD'}})",
      "    return rows",
      "if len(sys.argv) > 1 and sys.argv[1] == 'path':",
      "    print(json.dumps({'cost': {'amount': 0, 'currency': 'USD', 'status': 'calculated'}, 'usage': {'inputTokens': 0, 'cachedInputTokens': 0, 'cacheWriteTokens': 0, 'outputTokens': 0, 'reasoningTokens': 0, 'totalTokens': 0}, 'missingPriceModels': [], 'messageCosts': {}, 'compactionCosts': {}}))",
    ].join("\n"), "utf8");
    await writeFile(sessionPath, [
      JSON.stringify({ type: "session", id: "mixed" }),
      JSON.stringify({ type: "message", id: "known", timestamp: "2026-01-01T10:00:00Z", message: { role: "assistant", provider: "test", model: "known-model", usage: { input: 10, output: 1 } } }),
      JSON.stringify({ type: "message", id: "unknown", timestamp: "2026-01-01T10:01:00Z", message: { role: "assistant", provider: "test", model: "unknown-model", usage: { input: 20, output: 2 } } }),
    ].join("\n") + "\n", "utf8");
    const result = await calculateSessionCost(sessionPath, pricing);
    assert.equal(result.totalCost.amount, 11);
    assert.equal(result.totalCost.status, "partial");
    assert.deepEqual(result.totalCost.missingPriceModels, ["test/unknown-model"]);
    assert.equal(result.cost?.amount, 11);
    assert.equal(result.cost?.status, "partial");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("price data signature changes when cache expires or refresh fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-price-signature-"));
  const cacheFile = join(root, "pi-sync-maintenance", "genai-prices-v2.json");
  try {
    const missing = await billingPriceDataSignature(cacheFile);
    await mkdir(dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, "[]", "utf8");
    const fresh = await billingPriceDataSignature(cacheFile);
    assert.notEqual(fresh, missing);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(cacheFile, old, old);
    const stale = await billingPriceDataSignature(cacheFile);
    assert.match(stale, /freshness=stale/);
    assert.notEqual(stale, fresh);
    await writeFile(`${cacheFile}.fetch-failed`, "{}", "utf8");
    const failed = await billingPriceDataSignature(cacheFile);
    assert.notEqual(failed, stale);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads JSONL records containing U+2028 before compaction usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-billing-jsonl-"));
  const sessionPath = join(root, "session.jsonl");
  const scriptPath = join(root, "pricing.py");
  try {
    await writeFile(scriptPath, [
      "def price_usages(items):",
      `    return [{'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 0.25}, 'rates': {'currency': 'USD'}} for _ in items]`,
    ].join("\n"), "utf8");
    const recordWithSeparator = JSON.stringify({ type: "custom", data: { text: "left\u2028right" } });
    assert.equal(recordWithSeparator.includes("\u2028"), true);
    await writeFile(sessionPath, [
      JSON.stringify({ type: "message", message: { role: "assistant", provider: "test", model: "test" } }),
      recordWithSeparator,
      JSON.stringify({ type: "compaction", id: "compact-1", usage: { input: 100, output: 5 } }),
    ].join("\r\n"), "utf8");

    const costs = await calculateCompactionCosts(sessionPath, scriptPath);
    assert.equal(costs["compact-1"].status, "calculated");
    assert.equal(costs["compact-1"].amount, 0.25);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("separates Recap usage from main cache statistics while total cost includes both", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-billing-recap-"));
  const sessionPath = join(root, "session.jsonl");
  const pricing = join(root, "pricing.py");
  try {
    await writeFile(pricing, [
      "import json, sys",
      "def price_usages(items):",
      "    rows = []",
      "    for item in items:",
      "        u = item['usage']",
      "        total = sum(int(u.get(k, 0) or 0) for k in ('input', 'cacheRead', 'cacheWrite', 'output'))",
      "        rows.append({'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': total}, 'rates': {'currency': 'USD'}})",
      "    return rows",
      "if len(sys.argv) > 1 and sys.argv[1] == 'path':",
      "    print(json.dumps({'cost': {'amount': 111, 'currency': 'USD', 'status': 'calculated'}, 'usage': {'inputTokens': 999, 'cachedInputTokens': 999, 'cacheWriteTokens': 0, 'outputTokens': 0, 'reasoningTokens': 0, 'totalTokens': 1998}, 'missingPriceModels': [], 'messageCosts': {}, 'compactionCosts': {}}))",
    ].join("\n"), "utf8");
    await writeFile(sessionPath, [
      JSON.stringify({ type: "session", id: "recap-session" }),
      JSON.stringify({ type: "message", id: "main-1", timestamp: "2026-01-01T10:00:00Z", message: { role: "assistant", provider: "openai", model: "main-model", usage: { input: 20, cacheRead: 80, output: 5 } } }),
      JSON.stringify({ type: "custom", id: "recap-1", timestamp: "2026-01-01T10:01:00Z", customType: "session-recap-title:usage", data: { provider: "anthropic", model: "recap-model", usageEvent: { version: 1, id: "usage-1", relation: "origin" }, usage: { input: 10, output: 2 } } }),
    ].join("\n") + "\n", "utf8");

    const records = await extractReaderUsageRecords(sessionPath);
    assert.deepEqual(records.map((record) => record.usageKind), ["main", "recap"]);
    assert.equal(records[1].usageEventId, "usage-1");
    const result = await calculateSessionCost(sessionPath, pricing);
    assert.equal(result.mainCost.amount, 105);
    assert.equal(result.mainCost.usage.inputTokens, 20);
    assert.equal(result.mainCost.usage.cachedInputTokens, 80);
    assert.equal(result.recapCost.amount, 12);
    assert.equal(result.recapCost.usage.inputTokens, 10);
    assert.deepEqual(result.mainCost.models, ["openai/main-model"]);
    assert.deepEqual(result.recapCost.models, ["anthropic/recap-model"]);
    assert.deepEqual(result.messageCosts, { "main-1": 105 });
    assert.deepEqual(result.parentCost.models, ["anthropic/recap-model", "openai/main-model"]);
    assert.deepEqual(result.totalCost.models, ["anthropic/recap-model", "openai/main-model"]);
    assert.equal(result.totalCost.amount, 117);
    assert.equal(result.usage.inputTokens, 20);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizes numeric Pi message timestamps before child pricing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-billing-numeric-timestamp-"));
  const parent = join(root, "parent.jsonl");
  const child = join(root, "parent", "run-0", "session.jsonl");
  const pricing = join(root, "pricing.py");
  try {
    await mkdir(dirname(child), { recursive: true });
    await writeFile(pricing, [
      "import json, sys",
      "def price_usages(items):",
      "    total = 0.5 if items[0].get('timestamp') == '2026-01-01T10:00:00.000Z' else 0",
      "    return [{'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': total}, 'rates': {'currency': 'USD'}} for _ in items]",
      "if len(sys.argv) > 1 and sys.argv[1] == 'path':",
      "    print(json.dumps({'cost': {'amount': 0, 'currency': 'USD', 'status': 'calculated'}, 'usage': {'inputTokens': 0, 'cachedInputTokens': 0, 'cacheWriteTokens': 0, 'outputTokens': 0, 'reasoningTokens': 0, 'totalTokens': 0}, 'missingPriceModels': [], 'messageCosts': {}, 'compactionCosts': {}}))",
    ].join("\n"), "utf8");
    await writeFile(parent, JSON.stringify({ type: "session", id: "parent" }) + "\n", "utf8");
    await writeFile(child, [
      JSON.stringify({ type: "session", id: "child", parentSession: parent }),
      JSON.stringify({ type: "message", id: "numeric", message: {
        role: "assistant", provider: "test", model: "model", timestamp: 1767261600000,
        usage: { input: 1, output: 1 },
      } }),
    ].join("\n") + "\n", "utf8");

    const result = await calculateSessionCost(parent, pricing);
    assert.equal(result.childCost.amount, 0.5);
    assert.equal(result.totalCost.amount, 0.5);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("prices large child batches without overflowing the pricing subprocess", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-billing-large-child-batch-"));
  const parent = join(root, "parent.jsonl");
  const child = join(root, "parent", "run-0", "session.jsonl");
  const pricing = join(root, "pricing.py");
  try {
    await mkdir(dirname(child), { recursive: true });
    await writeFile(pricing, [
      "import json, sys",
      "def price_usages(items):",
      "    return [{'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 0.01}, 'rates': {'currency': 'USD', 'source': 'x' * 1200}} for _ in items]",
      "if len(sys.argv) > 1 and sys.argv[1] == 'path':",
      "    print(json.dumps({'cost': {'amount': 0, 'currency': 'USD', 'status': 'calculated'}, 'usage': {'inputTokens': 0, 'cachedInputTokens': 0, 'cacheWriteTokens': 0, 'outputTokens': 0, 'reasoningTokens': 0, 'totalTokens': 0}, 'missingPriceModels': [], 'messageCosts': {}, 'compactionCosts': {}}))",
    ].join("\n"), "utf8");
    await writeFile(parent, JSON.stringify({ type: "session", id: "parent" }) + "\n", "utf8");
    await writeFile(child, [
      JSON.stringify({ type: "session", id: "child", parentSession: parent }),
      ...Array.from({ length: 300 }, (_, index) => JSON.stringify({
        type: "message", id: `child-${index}`, timestamp: "2026-01-01T10:00:00Z", message: {
          role: "assistant", provider: "test", model: "model", timestamp: "2026-01-01T10:00:00Z",
          usage: { input: 1, output: 1 },
        },
      })),
    ].join("\n") + "\n", "utf8");

    const result = await calculateSessionCost(parent, pricing);
    assert.equal(result.childCost.amount, 3);
    assert.equal(result.childCost.status, "calculated");
    assert.equal(result.totalCost.amount, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("child billing counts inherited history once, keeps fresh nested requests, and ignores artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-billing-child-tree-"));
  const parent = join(root, "parent.jsonl");
  const child = join(root, "parent", "run-1", "run-0", "session.jsonl");
  const nested = join(root, "parent", "run-1", "run-0", "session", "run-2", "run-0", "session.jsonl");
  const artifact = join(root, "parent", "subagent-artifacts", "trace.jsonl");
  const malformed = join(root, "parent", "not-a-session.jsonl");
  const pricing = join(root, "pricing.py");
  const assistant = (id, timestamp, input, output, extra = {}) => JSON.stringify({
    type: "message",
    id,
    timestamp,
    message: { role: "assistant", provider: "test", model: "model", usage: { input, output, ...extra } },
  });
  const summary = (type, id, timestamp, input) => JSON.stringify({
    type,
    id,
    timestamp,
    provider: "test",
    model: "model",
    usage: { input, output: 0 },
  });
  try {
    await mkdir(dirname(child), { recursive: true });
    await mkdir(dirname(nested), { recursive: true });
    await mkdir(dirname(artifact), { recursive: true });
    await writeFile(pricing, [
      "import json, sys",
      "def price_usages(items):",
      "    rows = []",
      "    for item in items:",
      "        u = item['usage']",
      "        total = sum(int(u.get(k, 0) or 0) for k in ('input', 'cacheRead', 'cacheWrite', 'output'))",
      "        rows.append({'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': total}, 'rates': {'currency': 'USD'}})",
      "    return rows",
      "if len(sys.argv) > 1 and sys.argv[1] == 'path':",
      "    print(json.dumps({'cost': {'amount': 2, 'currency': 'USD', 'status': 'calculated'}, 'usage': {'inputTokens': 1, 'cachedInputTokens': 0, 'cacheWriteTokens': 0, 'outputTokens': 1, 'reasoningTokens': 0, 'totalTokens': 2}, 'missingPriceModels': [], 'messageCosts': {}, 'compactionCosts': {}}))",
    ].join("\n"), "utf8");
    await writeFile(parent, [
      JSON.stringify({ type: "session", id: "parent" }),
      assistant("origin", "2026-01-01T10:00:00Z", 1, 1),
    ].join("\n") + "\n", "utf8");
    await writeFile(child, [
      JSON.stringify({ type: "session", id: "child", parentSession: parent }),
      assistant("origin", "2026-01-01T10:00:00Z", 1, 1),
      assistant("child-new", "2026-01-01T10:01:00Z", 2, 2, { totalTokens: 99 }),
      summary("compaction", "compact-1", "2026-01-01T10:02:00Z", 3),
    ].join("\n") + "\n", "utf8");
    await writeFile(nested, [
      JSON.stringify({ type: "session", id: "nested", parentSession: child }),
      assistant("origin", "2026-01-01T10:00:00Z", 1, 1),
      assistant("child-new", "2026-01-01T10:01:00Z", 2, 2, { totalTokens: 99 }),
      summary("compaction", "compact-1", "2026-01-01T10:02:00Z", 3),
    ].join("\n") + "\n", "utf8");
    await writeFile(artifact, JSON.stringify({ type: "message", id: "artifact", message: { role: "assistant", usage: { input: 999, output: 999 } } }) + "\n", "utf8");
    await writeFile(malformed, assistant("bad", "bad", 999, 999) + "\n", "utf8");

    assert.deepEqual(await findChildSessionPaths(parent), [child, nested]);
    const records = await extractReaderUsageRecords(nested);
    assert.deepEqual(records.map((record) => record.entryId), ["origin", "child-new", "compact-1"]);
    const result = await calculateSessionCost(parent, pricing);
    assert.equal(result.parentCost.amount, 2);
    assert.equal(result.childCost.amount, 7);
    assert.equal(result.childCost.usage.outputTokens, 2);
    assert.equal(result.childCost.usage.inputTokens, 5);
    assert.equal(result.childCost.usage.totalTokens, 102);
    assert.equal(result.totalCost.amount, 9);
    assert.equal(result.compactionCost.amount, 3);
    assert.equal(result.compactionCost.usage.inputTokens, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("Side Ask accounting preserves each native request, tier and tool charge through failed copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-side-billing-"));
  try {
    const timestamp = "2026-10-25T00:00:00Z";
    const native = (id, event, tier, input) => ({ type: "message", id, timestamp,
      message: { role: "assistant", provider: "openai", model: "fixture", response_service_tier: tier,
        usage: { input, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: input + 2 },
        usageEvent: { version: 1, id: event, relation: "origin" } } });
    const first = native("native-first", "side-first", "priority", 10);
    const second = native("native-second", "side-second", "default", 20);
    const image = { type: "custom", id: "native-image", timestamp, customType: "image-generation-usage", data: {
      provider: "apimart", model: "gpt-image-2-official",
      usage: { input: 0, output: 0, totalTokens: 0, usageAvailable: false },
      billing: { status: "confirmed", currency: "USD", source: "apimart-task", taskId: "side-task", startedAt: 1792886400000, amount: 0.015 },
      usageEvent: { version: 1, id: "side-image", relation: "origin" },
    } };
    const summary = { provider: "openai", model: "fixture", usage: second.message.usage, usageEvent: second.message.usageEvent };
    const parent = join(root, "parent.jsonl"), child = join(root, "child.jsonl"), interrupted = join(root, "interrupted.jsonl");
    const write = (path, rows) => writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    await write(parent, [
      { type: "session", id: "side-parent" },
      { type: "custom", id: "step-one", timestamp, customType: "quick_ask_step", data: { runId: "run", nativeEntries: [first], ...summary, usageEvent: first.message.usageEvent, usage: first.message.usage } },
      { type: "custom", id: "step-two", timestamp, customType: "quick_ask_step", data: { runId: "run", nativeEntries: [image, second], ...summary } },
      { type: "custom", id: "failed", timestamp, customType: "quick_ask_outcome", data: { runId: "run", nativeEntries: [first, image, second], ...summary } },
    ]);
    await write(child, [{ type: "session", id: "side-child", parentSession: parent },
      { type: "custom", id: "copied", timestamp, customType: "reader.side_ask_outcome", data: { nativeEntries: [first, image, second], ...summary } }]);
    await write(interrupted, [{ type: "session", id: "side-interrupted" },
      { type: "custom", id: "interrupted-step", timestamp, customType: "quick_ask_step", data: { runId: "run", nativeEntries: [first, image, second] } }]);
    const groups = await Promise.all([parent, child, interrupted].map(extractReaderUsageRecords));
    for (const records of groups) {
      const unique = uniqueReaderUsageRecordGroups([records])[0];
      assert.deepEqual(new Set(unique.map((record) => record.usageEventId)), new Set(["side-first", "side-second", "side-image"]));
      assert.equal(unique.find((record) => record.usageEventId === "side-first").serviceTier, "priority");
      assert.equal(unique.find((record) => record.usageEventId === "side-image").usage.providerCharge.amount, 0.015);
    }
    assert.equal(uniqueReaderUsageRecordGroups(groups).flat().length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Reader identity never guesses missing observations or merges tier/usage/request collisions", () => {
  const record = { entryType: "message", entryId: "entry", sessionId: "session", timestamp: "2026-01-01T10:00:00Z",
    provider: "test", model: "model", usage: { model: "model", input: 10, output: 2 } };
  const variants = [record, { ...record, serviceTier: "priority" }, { ...record, usage: { ...record.usage, input: 11 } },
    { ...record, entryId: "new" }, { ...record, entryId: "" }, { ...record, entryId: "" },
    { ...record, timestamp: "" }, { ...record, timestamp: "" },
    { ...record, usageEventId: "request-a" }, { ...record, usageEventId: "request-b" }];
  assert.equal(uniqueReaderUsageRecordGroups([variants])[0].length, variants.length);
  const copy = { ...record, entryId: "copy", usageEventId: "explicit", sourceSessionId: "session", sourceEntryId: "entry" };
  for (const groups of [[[record], [copy]], [[copy], [record]]]) {
    assert.equal(uniqueReaderUsageRecordGroups(groups).flat().length, 1);
  }
  assert.equal(uniqueReaderUsageRecordGroups([[record, variants[1]], [copy]]).flat().length, 3, "ambiguous source address preserves requests");
});

test("Side Ask child accounting follows only contained, header-matched native references", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-side-child-billing-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    const sessionRoot = join(root, "agent", "sessions");
    const parent = join(root, "parent.jsonl");
    const child = join(sessionRoot, "project", "child.jsonl");
    const nextChild = join(sessionRoot, "project", "next-child.jsonl");
    const foreign = join(sessionRoot, "project", "foreign.jsonl");
    const link = join(sessionRoot, "project", "link.jsonl");
    const outside = join(root, "outside.jsonl");
    await mkdir(dirname(child), { recursive: true });
    await writeFile(child, JSON.stringify({ type: "session", id: "child", parentSession: parent }) + "\n");
    await writeFile(nextChild, JSON.stringify({ type: "session", id: "next", parentSession: parent }) + "\n");
    await writeFile(foreign, JSON.stringify({ type: "session", id: "foreign", parentSession: "/different/parent.jsonl" }) + "\n");
    await writeFile(outside, JSON.stringify({ type: "session", id: "outside", parentSession: parent }) + "\n");
    await symlink(child, link);
    const ref = (sessionId, childPath) => ({ type: "custom", customType: "quick_ask_child", data: {
      version: 1, sessionId, childPath, parentSessionPath: parent,
    } });
    await writeFile(parent, [
      { type: "session", id: "parent" }, ref("child", "project/child.jsonl"),
      ref("child", "project/child.jsonl"), ref("foreign", "project/foreign.jsonl"),
      ref("child", "project/link.jsonl"), ref("outside", "../../outside.jsonl"),
    ].map((value) => JSON.stringify(value)).join("\n") + "\n");
    assert.deepEqual(await findChildSessionPaths(parent), [child]);
    assert.deepEqual(await findChildSessionPaths(parent), [child], "an unchanged transcript keeps its verified references");
    await appendFile(parent, JSON.stringify(ref("next", "project/next-child.jsonl")) + "\n");
    assert.deepEqual(await findChildSessionPaths(parent), [child, nextChild], "new references invalidate the transcript cache");
    const revision = await sessionCostRevision(parent);
    await appendFile(child, JSON.stringify({ type: "message", id: "later" }) + "\n");
    assert.notEqual(await sessionCostRevision(parent), revision);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("child discovery bounds first header and excludes canonical artifact transcripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-billing-bounded-"));
  try {
    const parent = join(root, "parent.jsonl");
    await mkdir(join(root, "parent", "subagent-artifacts"), { recursive: true });
    await writeFile(join(root, "parent", "oversized.jsonl"), JSON.stringify({ type: "session", id: "s", extra: "x".repeat(20000) }) + "\n");
    await writeFile(join(root, "parent", "subagent-artifacts", "canonical.jsonl"), JSON.stringify({ type: "session", id: "artifact" }) + "\n");
    assert.deepEqual(await findChildSessionPaths(parent), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("batch billing keeps usage when the legacy path mode fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-billing-legacy-path-failure-"));
  const sessionPath = join(root, "session.jsonl");
  const scriptPath = join(root, "pricing.py");
  try {
    await writeFile(scriptPath, [
      "import sys",
      "if len(sys.argv) > 1 and sys.argv[1] == 'path': raise SystemExit('legacy path unavailable')",
      "def price_usages(items): return [None for _ in items]",
    ].join("\n"), "utf8");
    await writeFile(sessionPath, [
      JSON.stringify({ type: "session", id: "legacy-path-failure" }),
      JSON.stringify({ type: "message", id: "assistant-1", timestamp: "2026-01-01T00:00:00Z", message: { role: "assistant", provider: "openai", model: "unknown-model", usage: { input: 10, output: 1 } } }),
    ].join("\n") + "\n", "utf8");
    const result = await calculateSessionCost(sessionPath, scriptPath);
    assert.equal(result.totalCost.status, "partial");
    assert.equal(result.totalCost.amount, 0);
    assert.equal(result.usage.totalTokens, 11);
    assert.deepEqual(result.totalCost.missingPriceModels, ["openai/unknown-model"]);
    assert.deepEqual(result.messageCosts, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid parent session headers are rejected instead of becoming free", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-billing-invalid-header-"));
  const sessionPath = join(root, "session.jsonl");
  try {
    await writeFile(sessionPath, JSON.stringify({ type: "message", id: "not-a-session" }) + "\n", "utf8");
    await assert.rejects(() => calculateSessionCost(sessionPath, null), /invalid session header/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pricing service failures preserve usage and lower-bound identity", async () => {
  const modes = {
    nonzero: ["raise RuntimeError('engine unavailable')"],
    malformed: ["print('not-json')", "def price_usages(items): return [None for _ in items]"],
    wrongRows: ["def price_usages(items): return []"],
    timeout: ["import time", "def price_usages(items):", "    time.sleep(31)", "    return [None for _ in items]"],
  };
  for (const [mode, lines] of Object.entries(modes)) {
    const root = await mkdtemp(join(tmpdir(), `pi-web-billing-failure-${mode}-`));
    const sessionPath = join(root, "session.jsonl");
    const scriptPath = join(root, "pricing.py");
    try {
      await writeFile(scriptPath, lines.join("\n"), "utf8");
      await writeFile(sessionPath, [
        JSON.stringify({ type: "session", id: `failure-${mode}` }),
        JSON.stringify({ type: "message", id: "assistant-1", timestamp: "2026-01-01T00:00:00Z", message: { role: "assistant", provider: "openai", model: "unknown-model", usage: { input: 10, output: 1 } } }),
      ].join("\n") + "\n", "utf8");
      const result = await calculateSessionCost(sessionPath, scriptPath);
      assert.equal(result.totalCost.status, "partial", mode);
      assert.equal(result.totalCost.amount, 0, mode);
      assert.equal(result.totalCost.unavailableSessions, 0, mode);
      assert.equal(result.usage.totalTokens, 11, mode);
      assert.deepEqual(result.totalCost.missingPriceModels, ["openai/unknown-model"], mode);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
