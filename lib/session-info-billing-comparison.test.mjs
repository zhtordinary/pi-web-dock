import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSealedPublicInputEnvironment } from "../test-support/sealed-public-inputs.mjs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { calculateSessionCost, extractReaderUsageRecords } = await jiti.import("./billing.ts");

function line(value) { return JSON.stringify(value) + "\n"; }
function assistant(id, model = "gpt-5.5", usage = { input: 100, cacheRead: 20, cacheWrite: 5, output: 10, totalTokens: 135 }) {
  return { type: "message", id, timestamp: "2026-10-25T00:00:00.000Z", message: {
    role: "assistant", provider: "openai", model, usage,
  } };
}

function canonical(result) {
  return {
    cost: result.cost,
    usage: result.usage,
    parentCost: result.parentCost,
    childCost: result.childCost,
    mainCost: result.mainCost,
    recapCost: result.recapCost,
    compactionCost: result.compactionCost,
    extensionCosts: result.extensionCosts,
    imageGenerationCosts: result.imageGenerationCosts,
    messageCosts: result.messageCosts,
    compactionCosts: result.compactionCosts,
    missingPriceModels: result.missingPriceModels,
    pendingUsageCount: result.pendingUsageCount,
    pendingUsageModels: result.pendingUsageModels,
    totalCost: result.totalCost,
  };
}

test("complex persisted billing result covers parent, child, Quick Ask, recap, compaction, plugin, image, dedup and partial", async (t) => {
  const sealed = await createSealedPublicInputEnvironment("billing-comparison");
  const root = await mkdtemp(join(tmpdir(), "pi-web-billing-comparison-"));
  const parent = join(root, "parent.jsonl");
  const child = join(root, "parent", "run-0", "session.jsonl");
  const sessionId = "billing-comparison-parent";
  try {
    await mkdir(join(root, "parent", "run-0"), { recursive: true });
    const imageBilling = { status: "confirmed", source: "apimart-task", taskId: "task-comparison", toolCallId: "call-comparison", amount: 0.015, currency: "USD", startedAt: 1792886400000, returnedImages: 1 };
    const quickAskNative = assistant("quick-ask-assistant", "gpt-5.5", { input: 50, output: 5, totalTokens: 55 });
    await writeFile(parent, [
      { type: "session", version: 3, id: sessionId, timestamp: "2026-10-25T00:00:00.000Z", cwd: root },
      { type: "model_change", id: "model-change", parentId: null, timestamp: "2026-10-25T00:00:00.000Z", provider: "openai", modelId: "gpt-5.5" },
      assistant("main-assistant"),
      { type: "compaction", id: "compaction-comparison", timestamp: "2026-10-25T00:00:01.000Z", provider: "openai", model: "gpt-5.5", tokensBefore: 1000, usage: { input: 30, output: 3, totalTokens: 33 } },
      { type: "custom", id: "recap-comparison", customType: "session-recap-title:usage", timestamp: "2026-10-25T00:00:02.000Z", data: { provider: "openai", model: "gpt-5.5", usage: { input: 15, output: 2, totalTokens: 17 } } },
      { type: "custom", id: "image-comparison", customType: "image-generation-usage", timestamp: "2026-10-25T00:00:03.000Z", data: { provider: "openai", model: "gpt-image-2.5-flare", usage: { input: 0, output: 0, usageAvailable: false }, billing: imageBilling, usageEvent: { version: 1, id: "image-generation:comparison", relation: "origin" } } },
      { type: "custom", id: "quick-ask-wrapper", customType: "quick_ask", timestamp: "2026-10-25T00:00:04.000Z", data: { usageEvent: { version: 1, id: "quick-ask:comparison", relation: "origin" }, nativeEntries: [quickAskNative] } },
      assistant("unknown-main", "unknown-model", { input: 4, output: 1, totalTokens: 5 }),
    ].map(line).join(""), "utf8");
    await writeFile(child, [
      { type: "session", version: 3, id: "billing-comparison-child", parentSession: parent },
      assistant("child-assistant", "gpt-5.5", { input: 40, output: 4, totalTokens: 44 }),
      { type: "compaction", id: "child-compaction", timestamp: "2026-10-25T00:00:05.000Z", provider: "openai", model: "gpt-5.5", tokensBefore: 500, usage: { input: 10, output: 1, totalTokens: 11 } },
    ].map(line).join(""), "utf8");
    const extensionDir = join(sealed.agentDir, "session-extension-usage", createHash("sha256").update(sessionId).digest("hex"));
    await mkdir(extensionDir, { recursive: true });
    const extensionEvent = { version: 1, extensionId: "fixture-extension", kind: "plugin", status: "settled", provider: "openai", model: "gpt-5.5", timestamp: "2026-10-25T00:00:06.000Z", usageEvent: { version: 1, id: "plugin:comparison", relation: "origin" }, usage: { input: 25, output: 3, totalTokens: 28, usageAvailable: true } };
    await writeFile(join(extensionDir, "comparison.jsonl"), `${JSON.stringify(extensionEvent)}\n${JSON.stringify(extensionEvent)}\n`, "utf8");

    const records = await extractReaderUsageRecords(parent);
    assert.ok(records.some((record) => record.usageKind === "recap"));
    assert.ok(records.some((record) => record.usageKind === "compaction"));
    assert.ok(records.some((record) => record.imageBilling));
    assert.ok(records.some((record) => record.usageKind === "extension"));
    const result = await calculateSessionCost(parent, sealed.scriptPath);
    assert.ok(result.parentCost && result.childCost && result.mainCost && result.recapCost && result.totalCost);
    assert.ok(result.imageGenerationCosts.length >= 1);
    assert.ok(result.extensionCosts.length >= 1);
    assert.ok(result.compactionCost);
    assert.ok(result.mainCost.usage.totalTokens > 0);
    assert.ok(result.messageCosts && typeof result.messageCosts === "object");
    assert.ok(result.missingPriceModels.includes("openai/unknown-model"));
    assert.equal(result.imageGenerationCosts[0].status, "confirmed");
    assert.ok(result.childCost.amount > 0);
    assert.ok(result.totalCost.amount >= result.parentCost.amount);
    t.diagnostic(JSON.stringify({
      input: { sessionId, parentRecords: records.length, childPath: child, priceManifest: sealed.manifest },
      canonical: canonical(result),
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
    await sealed.restore();
  }
});
