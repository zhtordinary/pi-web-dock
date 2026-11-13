import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { mergeSessionCostSummaries, sessionCostColor, sessionCostPresentation, summarizeCompactionCosts } = await jiti.import("./session-cost.ts");

test("plugin cost summary combines known component amounts and preserves partial status", () => {
  const summary = (amount, status, model) => ({
    amount,
    currency: "USD",
    status,
    usage: null,
    sessionCount: 1,
    models: [model],
    missingPriceModels: status === "calculated" ? [] : [model],
    pendingUsageCount: 0,
    pendingUsageModels: [],
    unavailableSessions: 0,
  });
  const merged = mergeSessionCostSummaries([
    summary(0.1932, "calculated", "compaction-model"),
    summary(0.032, "partial", "recap-model"),
    summary(0.1589, "calculated", "suggester-model"),
  ]);
  assert.ok(merged);
  assert.ok(Math.abs(merged.amount - 0.3841) < 1e-12);
  assert.equal(merged.status, "partial");
  assert.deepEqual(merged.models, ["compaction-model", "recap-model", "suggester-model"]);
  assert.deepEqual(merged.missingPriceModels, ["recap-model"]);
});

test("compaction lower bounds aggregate while remaining partial", () => {
  const usage = { inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 2, reasoningTokens: 0, totalTokens: 12 };
  const summary = summarizeCompactionCosts({
    priced: { usage, amount: 0.0008, currency: "USD", status: "calculated" },
    unknown: { usage, amount: 0, currency: "USD", status: "partial", model: "openai/unknown-model" },
  });
  assert.equal(summary.status, "partial");
  assert.equal(summary.amount, 0.0008);
  assert.equal(summary.unavailableSessions, 0);
  assert.deepEqual(summary.models, ["openai/unknown-model"]);
  assert.deepEqual(summary.missingPriceModels, ["openai/unknown-model"]);
});

test("suggester unknown usage is quiet without changing the accounting summary", () => {
  const summary = { status: "partial", pendingUsageCount: 2, missingPriceModels: [] };
  const extensions = [{ id: "pi-prompt-suggester", pendingUsageCount: 2 }];
  assert.deepEqual(sessionCostPresentation(summary, extensions), {
    pendingUsageCount: 0, recordedOnly: true, onlySuggesterPending: true,
  });
  assert.equal(summary.pendingUsageCount, 2);
  assert.equal(extensions[0].pendingUsageCount, 2);
});

test("other pending usage and missing prices keep their own warnings", () => {
  const extensions = [{ id: "pi-prompt-suggester", pendingUsageCount: 2 }, { id: "other", pendingUsageCount: 1 }];
  assert.deepEqual(sessionCostPresentation({ status: "partial", pendingUsageCount: 3, missingPriceModels: [] }, extensions), {
    pendingUsageCount: 1, recordedOnly: true, onlySuggesterPending: false,
  });
  assert.deepEqual(sessionCostPresentation({ status: "partial", pendingUsageCount: 2, missingPriceModels: ["missing"] }, extensions), {
    pendingUsageCount: 0, recordedOnly: true, onlySuggesterPending: false,
  });
  assert.deepEqual(sessionCostPresentation({ status: "partial", pendingUsageCount: 1, missingPriceModels: [] }, []), {
    pendingUsageCount: 1, recordedOnly: false, onlySuggesterPending: false,
  });
  assert.deepEqual(sessionCostPresentation({ status: "partial", pendingUsageCount: 1, missingPriceModels: [] }, extensions), {
    pendingUsageCount: 1, recordedOnly: false, onlySuggesterPending: false,
  }, "inconsistent peer counts must not hide another extension's warning");
});

test("quiet suggester usage does not hide an unrelated incomplete extension", () => {
  const summary = { status: "partial", pendingUsageCount: 1, missingPriceModels: [] };
  const suggester = { id: "pi-prompt-suggester", pendingUsageCount: 1, status: "partial" };
  assert.equal(sessionCostPresentation(summary, [suggester, { id: "other", pendingUsageCount: 0, status: "calculated" }]).onlySuggesterPending, true);
  for (const status of ["partial", "unavailable"]) {
    assert.equal(sessionCostPresentation(summary, [suggester, { id: "other", pendingUsageCount: 0, status }]).onlySuggesterPending, false);
  }
});

test("settled usage clears the quiet marker, while unknown-only is not presented as zero", () => {
  assert.deepEqual(sessionCostPresentation({ status: "calculated", pendingUsageCount: 0, missingPriceModels: [] }, [{ id: "pi-prompt-suggester", pendingUsageCount: 0 }]), {
    pendingUsageCount: 0, recordedOnly: false, onlySuggesterPending: false,
  });
  assert.deepEqual(sessionCostPresentation({ status: "unavailable", pendingUsageCount: 1, missingPriceModels: [] }, [{ id: "pi-prompt-suggester", pendingUsageCount: 1 }]), {
    pendingUsageCount: 0, recordedOnly: true, onlySuggesterPending: true,
  });
});

test("session cost color keeps only high-cost red emphasis", () => {
  assert.equal(sessionCostColor(0), "var(--text-muted)");
  assert.equal(sessionCostColor(10), "var(--text-muted)");
  assert.equal(sessionCostColor(10.01), "#dc2626");
});
