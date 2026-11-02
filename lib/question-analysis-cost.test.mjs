import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createJiti } from "jiti";
import { createSealedPublicInputEnvironment } from "../test-support/sealed-public-inputs.mjs";

const sealed = await createSealedPublicInputEnvironment("question-analysis");
after(() => sealed.restore());
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { priceQuestionAnalysis } = await jiti.import("./question-analysis-cost.ts");

test("question analysis uses shared genai-prices engine", async () => {
  const priced = await priceQuestionAnalysis({
    model: "gpt-5.6-luna",
    provider: "openai-compatible",
    input: 1_000,
    output: 200,
    cacheRead: 300,
    cacheWrite: 0,
    timestamp: "2026-08-24T00:00:00.000Z",
  });

  assert.equal(priced.pricing.configured, true);
  assert.equal(priced.pricing.currency, "USD");
  assert.match(priced.pricing.priceTableId ?? "", /gpt-5\.6-luna/);
  assert.equal(typeof priced.pricing.priceTableVersion, "number");
  assert.ok(priced.cost);
  assert.ok(priced.cost.total > 0);
  assert.ok(Math.abs(
    priced.cost.total - (priced.cost.input + priced.cost.output + priced.cost.cacheRead + priced.cost.cacheWrite),
  ) < 1e-12);
});

test("question analysis keeps a lower-bound result when the optional service is absent", async () => {
  const priced = await priceQuestionAnalysis({
    model: "unknown-model",
    provider: "openai",
    input: 12,
    output: 3,
    scriptPath: null,
  });
  assert.equal(priced.pricing.configured, false);
  assert.equal(priced.pricing.lowerBound, true);
  assert.equal(priced.cost?.total, 0);
});
