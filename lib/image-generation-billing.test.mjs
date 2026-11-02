import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { createSealedPublicInputEnvironment } from "../test-support/sealed-public-inputs.mjs";
import { imageGenerationCostsForFile, imageGenerationCostsFromDetails, imageGenerationOutputFromTask, imageGenerationOutputFromTool, readImageGenerationBilling, readImageGenerationCosts, readImageGenerationOutput } from "./image-generation-cost.ts";

const sealed = await createSealedPublicInputEnvironment("image-billing");
after(() => sealed.restore());
const jiti = createJiti(import.meta.url, { fsCache: false, tsconfigPaths: true });
const { priceTokenUsages, calculateSessionCost, extractReaderUsageRecords, uniqueReaderUsageRecordGroups } = await jiti.import("./billing.ts");
const usage = { input: 0, output: 0, inputImage: 0, outputImage: 0, totalTokens: 0, usageAvailable: false };
const pending = { status: "pending", currency: "USD", source: "apimart-task", taskId: "task-fixture", toolCallId: "call-fixture", startedAt: 1792886400000 };
const confirmed = { ...pending, status: "confirmed", amount: 0.015, credits: 0.15, returnedImages: 2 };
const event = (billing, entryId) => ({ type: "custom", id: entryId, customType: "image-generation-usage", timestamp: "2026-10-25T00:00:00Z",
  data: { version: 2, provider: "apimart", model: "gpt-image-2-official", usage, billing,
    usageEvent: { version: 1, id: "image-generation:fixture", relation: "origin" } } });

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "reader-image-settlement-"));
  try {
    const path = join(root, "session.jsonl");
    await writeFile(path, [{ type: "session", id: "fixture" }, event(pending, "submitted"), event(confirmed, "settled"), event(pending, "stale-copy")]
      .map((row) => JSON.stringify(row)).join("\n") + "\n");
    await run(path);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("confirmed provider charges work without tokens, model rates or a pricing engine", async () => {
  const [charged, refunded, unknown] = await priceTokenUsages([
    { model: "unlisted", ...usage, providerCharge: { amount: 0.015, currency: "USD", source: "apimart-task", taskId: "task-fixture" } },
    { model: "unlisted", ...usage, providerCharge: { amount: 0, currency: "USD", source: "laozhang-log", requestId: "request-fixture" } },
    { model: "unlisted", ...usage },
  ], null);
  assert.equal(charged.cost.total, 0.015); assert.equal(charged.pricing.priceEngine, "provider-ledger");
  assert.equal(refunded.cost.total, 0); assert.equal(refunded.pricing.configured, true);
  assert.equal(unknown.cost, undefined); assert.equal(unknown.pricing.configured, false);
});

test("estimates CPA image costs from official output-token equivalents when usage is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-cpa-image-estimate-"));
  try {
    const path = join(root, "session.jsonl");
    const billing = { status: "unavailable", currency: "USD", startedAt: 1792886400000, returnedImages: 1, reason: "unsupported-provider" };
    const entries = [
      { type: "session", id: "cpa-image-estimate" },
      { type: "custom", id: "gemini-image", customType: "image-generation-usage", timestamp: "2026-10-25T00:00:00Z",
        data: { version: 2, provider: "CPA Gemini Image", model: "gemini-3.1-flash-image", usage, billing,
          usageEvent: { version: 1, id: "image-generation:gemini-estimate", relation: "origin" } } },
      { type: "custom", id: "gpt-image", customType: "image-generation-usage", timestamp: "2026-10-25T00:00:01Z",
        data: { version: 2, provider: "CPA GPT Image", model: "gpt-image-2.5-sunburst", usage, billing,
          usageEvent: { version: 1, id: "image-generation:gpt-estimate", relation: "origin" } } },
    ];
    await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const result = await calculateSessionCost(path, sealed.scriptPath);
    assert.equal(result.cost.status, "calculated");
    assert.ok(Math.abs(result.cost.amount - 0.0972) < 1e-12);
    assert.deepEqual(result.imageGenerationCosts.map((item) => [item.status, item.amount, item.billing.reason]), [
      ["estimated", 0.0672, "official-rate-estimate"],
      ["estimated", 0.03, "official-rate-estimate"],
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid amounts, currencies or untraceable supplier claims remain unknown", async () => {
  for (const charge of [
    { amount: -1, currency: "USD", source: "apimart-task", taskId: "a" },
    { amount: Infinity, currency: "USD", source: "apimart-task", taskId: "a" },
    { amount: 1, currency: "CNY", source: "apimart-task", taskId: "a" },
    { amount: 1, currency: "USD", source: "other", requestId: "a" },
    { amount: 1, currency: "USD", source: "laozhang-log" },
  ]) {
    const [priced] = await priceTokenUsages([{ model: "unlisted", ...usage, providerCharge: charge }], null);
    assert.equal(priced.cost, undefined);
  }
  assert.equal(readImageGenerationBilling({ ...confirmed, amount: null }).status, "unavailable");
  assert.equal(readImageGenerationBilling({ ...confirmed, currency: "CNY" }), undefined);
});

test("pending then settled events charge once, are not multiplied by image count and cannot be downgraded", async () => {
  await fixture(async (path) => {
    const records = await extractReaderUsageRecords(path);
    assert.equal(records.length, 1); assert.equal(records[0].entryId, "submitted");
    assert.equal(records[0].usage.providerCharge.amount, 0.015);
    const total = await calculateSessionCost(path, null);
    assert.equal(total.cost.status, "calculated"); assert.equal(total.cost.amount, 0.015);
    assert.deepEqual(total.messageCosts, {});
    assert.equal(total.imageGenerationCosts.length, 1);
    assert.equal(total.imageGenerationCosts[0].status, "confirmed");
    assert.equal(total.imageGenerationCosts[0].billing.returnedImages, 2);
    assert.equal(total.imageGenerationCosts[0].billing.toolCallId, "call-fixture");
  });
});

test("output links survive later settlement and old direct-tool history without adding charges", async () => {
  await fixture(async (path) => {
    const details = { files: ["/tmp/generated.png"], imageGeneration: [{ id: "image-generation:fixture", billing: confirmed }] };
    const output = imageGenerationOutputFromTool("call-fixture", "generate_image", details);
    assert.deepEqual(output, { version: 1, toolCallId: "call-fixture", files: ["/tmp/generated.png"], usageIds: ["image-generation:fixture"] });
    const settledWithoutCall = { ...confirmed }; delete settledWithoutCall.toolCallId;
    await appendFile(path, [
      { type: "message", id: "old-tool-result", message: { role: "toolResult", toolName: "generate_image", toolCallId: "call-fixture", details } },
      { type: "custom", id: "output", customType: "image-generation-output", data: output },
      event(settledWithoutCall, "later-settlement"),
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const total = await calculateSessionCost(path, null);
    assert.equal(total.cost.amount, 0.015);
    assert.equal(total.imageGenerationCosts.length, 1);
    assert.equal(total.imageGenerationCosts[0].billing.toolCallId, "call-fixture");
    assert.deepEqual(total.imageGenerationCosts[0].outputs, [output]);
    assert.deepEqual(readImageGenerationCosts(total.imageGenerationCosts), total.imageGenerationCosts);
    const matched = imageGenerationCostsForFile("/tmp/generated.png", "/tmp", total.imageGenerationCosts);
    assert.equal(matched.costs[0].amount, 0.015);
    assert.equal(matched.batch, true, "the provider reported two images, not a per-image amount");
    assert.equal(imageGenerationCostsForFile("/tmp/other.png", "/tmp", total.imageGenerationCosts), undefined);
  });
});

test("historical direct-tool outputs retain provider-shaped call IDs and their exact image charge", async () => {
  await fixture(async (path) => {
    const toolCallId = "call_fixture|fc_fixture";
    const billing = { ...confirmed, toolCallId, amount: 0.0085, credits: 0.085, returnedImages: 1 };
    const details = { files: ["/tmp/绘图专区/generated.png"], imageGeneration: [{ id: "image-generation:fixture", billing }] };
    await writeFile(path, [
      { type: "session", id: "fixture" },
      event({ ...pending, toolCallId }, "submitted"), event(billing, "settled"),
      { type: "message", id: "tool-result", message: { role: "toolResult", toolName: "generate_image", toolCallId, details } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const total = await calculateSessionCost(path, null);
    assert.equal(total.cost.amount, 0.0085);
    assert.equal(total.imageGenerationCosts[0].billing.toolCallId, toolCallId);
    const parsed = readImageGenerationCosts(total.imageGenerationCosts);
    assert.deepEqual(parsed, total.imageGenerationCosts);
    const match = imageGenerationCostsForFile(details.files[0], "/tmp", parsed);
    assert.equal(match.costs[0].amount, 0.0085);
    assert.equal(match.costs[0].billing.credits, 0.085);
    assert.equal(match.batch, false);
    assert.equal(imageGenerationCostsForFile("/tmp/unrelated.png", "/tmp", parsed), undefined);
    assert.equal(readImageGenerationBilling({ ...billing, taskId: "task|invalid" }).status, "unavailable");
    for (const bad of ["", "call\nforged", "x".repeat(301)]) {
      assert.equal(readImageGenerationBilling({ ...billing, toolCallId: bad }).toolCallId, undefined);
      assert.equal(readImageGenerationOutput({ version: 1, toolCallId: bad, files: details.files, usageIds: ["image-generation:fixture"] }), undefined);
    }
  });
});

test("recovered task files use matching session, provider, task and original receipt identities", async () => {
  await fixture(async (path) => {
    const task = { state: "saved", provider: "apimart", model: "gpt-image-2-official", owner: { sessionId: "fixture" },
      files: ["/tmp/recovered.png"], billing: [{ id: "image-generation:fixture", taskId: "task-fixture" }] };
    await appendFile(path, JSON.stringify({ type: "custom", id: "task-saved", customType: "image-generation-task", data: task }) + "\n");
    const total = await calculateSessionCost(path, null);
    assert.equal(total.cost.amount, 0.015);
    assert.equal(imageGenerationCostsForFile("/tmp/recovered.png", "/tmp", total.imageGenerationCosts).costs[0].amount, 0.015);
    const receipts = [{ id: "image-generation:fixture", provider: "apimart", model: "gpt-image-2-official", billing: confirmed }];
    assert.equal(imageGenerationOutputFromTask(task, "other-session", receipts), undefined);
    assert.equal(imageGenerationOutputFromTask({ ...task, billing: [{ ...task.billing[0], taskId: "other-task" }] }, "fixture", receipts), undefined);
    assert.equal(imageGenerationOutputFromTask({ ...task, state: "pending" }, "fixture", receipts), undefined);
  });
});

test("output association rejects forged, mismatched, incomplete or ambiguous batches", () => {
  const details = { files: ["/tmp/a.png", "/tmp/b.png"], imageGeneration: [
    { id: "image-generation:a", billing: { ...confirmed, toolCallId: "outer/1" } },
    { id: "image-generation:b", billing: { ...confirmed, toolCallId: "outer/1" } },
  ] };
  const output = imageGenerationOutputFromTool("outer/1", "generate_image", details);
  assert.ok(output);
  assert.equal(imageGenerationOutputFromTool("outer/2", "generate_image", details), undefined);
  assert.equal(imageGenerationOutputFromTool("outer/1", "read", details), undefined);
  assert.equal(readImageGenerationOutput({ ...output, files: ["https://example.com/a.png"] }), undefined);
  assert.equal(readImageGenerationOutput({ ...output, usageIds: ["image-generation:a", "image-generation:a"] }), undefined);
  const rows = output.usageIds.map((id) => ({ id, provider: "apimart", model: "m", status: "confirmed", amount: 0.015,
    billing: { ...confirmed, toolCallId: "outer/1" }, outputs: [output] }));
  assert.equal(imageGenerationCostsForFile("/tmp/a.png", "/tmp", rows).batch, true);
  assert.equal(imageGenerationCostsForFile("/tmp/a.png", "/tmp", rows.slice(0, 1)), undefined, "a missing receipt cannot look like a complete batch");
  const conflict = { ...rows[0], id: "image-generation:c", billing: { ...rows[0].billing, toolCallId: "other" },
    outputs: [{ ...output, toolCallId: "other", files: ["/tmp/a.png"], usageIds: ["image-generation:c"] }] };
  assert.equal(imageGenerationCostsForFile("/tmp/a.png", "/tmp", [...rows, conflict]), undefined, "reused paths do not guess between calls");
});

test("a confirmed receipt copied into a child reconciles the original parent's request without double charging", async () => {
  await fixture(async (path) => {
    const [settled] = await extractReaderUsageRecords(path);
    const original = { ...settled, imageBilling: pending, usage: { ...settled.usage, providerCharge: undefined } };
    const copy = { ...settled, sessionId: "child", entryId: "copied" };
    const [parent, child] = uniqueReaderUsageRecordGroups([[original], [copy]]);
    assert.equal(parent.length, 1); assert.equal(parent[0].usage.providerCharge.amount, 0.015);
    assert.equal(child.length, 0);
    const unrelated = { ...copy, usageEventId: "image-generation:another", imageBilling: { ...confirmed, taskId: "other" } };
    assert.equal(uniqueReaderUsageRecordGroups([[original], [unrelated]])[1].length, 1);
  });
});

test("tool details and cost response keep confirmed zero distinct from missing charges", () => {
  const rows = imageGenerationCostsFromDetails({ imageGeneration: [
    { id: "a", provider: "apimart", model: "m", billing: { ...confirmed, amount: 0, credits: 0 } },
    { id: "b", provider: "apimart", model: "m", billing: pending },
  ] });
  assert.equal(rows[0].amount, 0); assert.equal(rows[0].status, "confirmed");
  assert.equal(rows[1].amount, null); assert.equal(rows[1].status, "pending");
  assert.deepEqual(readImageGenerationCosts(rows), rows);
  assert.deepEqual(readImageGenerationCosts([{ ...rows[0], amount: 2 }]), []);
});
