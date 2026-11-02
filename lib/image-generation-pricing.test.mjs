import assert from "node:assert/strict";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { createSealedPublicInputEnvironment } from "../test-support/sealed-public-inputs.mjs";
import { testTranslator } from "../components/test-locale.mjs";
const sealed = await createSealedPublicInputEnvironment("image-quotes");
after(() => sealed.restore());
await mkdir(join(sealed.agentDir, "packages"));
await symlink(new URL("../test-fixtures/image-generation", import.meta.url).pathname, join(sealed.agentDir, "packages/pi-image-generation"), "dir");
const jiti = createJiti(import.meta.url, { fsCache: false, tsconfigPaths: true });
const { imageGenerationQuote, apimartPriceRows } = await jiti.import("./image-generation-pricing.ts");
const { compactImageQuoteSummary } = await jiti.import("../components/image-generation-quote-display.ts");
const en = testTranslator("en");

const apimart = "https://api.apimart.ai/v1";
const response = (data) => async (_url, init) => {
  assert.deepEqual(init.headers, { accept: "application/json" });
  assert.equal(init.redirect, "error");
  assert.equal(init.cache, "no-store");
  return Response.json({ success: true, data });
};

test("compact token quote summaries keep every official rate visible", () => {
  assert.equal(compactImageQuoteSummary({ unit: "million-tokens", rows: [
    { name: "text_input", amount: 5 },
    { name: "image_input", amount: 8 },
    { name: "image_output", amount: 30 },
  ] }, en), "$5/$8/$30/M token");
  assert.equal(compactImageQuoteSummary({ unit: "million-tokens", rows: [
    { name: "text_input", amount: 0.5 },
    { name: "image_output", amount: 60 },
  ] }, en), "$0.5/$60/M token");
  assert.equal(compactImageQuoteSummary({ unit: "image", rows: [{ name: "image", amount: 0.04 }] }, en), "$0.04/image");
  assert.equal(compactImageQuoteSummary({ unit: "call", rows: [{ name: "call", amount: 0.1 }] }, en), "$0.1/call");
  assert.equal(compactImageQuoteSummary({ unit: "million-tokens", rows: [] }, en), en("chat.imagePriceByToken"));
});

test("official OpenAI quotes use the shared pricing engine rather than a second rate table", async () => {
  const quote = await imageGenerationQuote("https://api.openai.com/v1", "gpt-image-2.5-flare", async () => { throw new Error("must not fetch credentials or OpenAI API"); }, true);
  assert.equal(quote.status, "available");
  assert.equal(quote.unit, "million-tokens");
  assert.deepEqual(quote.rows, [{ name: "text_input", amount: 5 }, { name: "image_input", amount: 8 }, { name: "image_output", amount: 30 }]);
});

test("CPA gateway image quotes use the official model tariff", async () => {
  const base = "http://127.0.0.1:8317/v1";
  const gemini = await imageGenerationQuote(base, "gemini-3.1-flash-image", async () => { throw new Error("must not call the CPA gateway"); }, true, "CPA Gemini Image");
  assert.equal(gemini.status, "available");
  assert.equal(gemini.source, "google");
  assert.deepEqual(gemini.rows, [{ name: "text_input", amount: 0.5 }, { name: "image_output", amount: 60 }]);
  const gpt = await imageGenerationQuote(base, "gpt-image-2.5-sunburst", async () => { throw new Error("must not call the CPA gateway"); }, true, "CPA GPT Image");
  assert.equal(gpt.status, "available");
  assert.equal(gpt.source, "openai");
  assert.deepEqual(gpt.rows, [{ name: "text_input", amount: 5 }, { name: "image_input", amount: 8 }, { name: "image_output", amount: 30 }]);
});

test("public APIMart quotes preserve resolution rates and never send credentials", async () => {
  const quote = await imageGenerationQuote(apimart, "gpt-image-2", response({ quota_type: 1, paid_price: 0.0085,
    resolution_paid_prices: { "1K": 0.0085, "2K": 0.015, "4K": 0.022 } }), true);
  assert.equal(quote.status, "available");
  assert.equal(quote.unit, "image");
  assert.deepEqual(quote.rows, [{ name: "default", amount: 0.0085 }, { name: "1K", amount: 0.0085 }, { name: "2K", amount: 0.015 }, { name: "4K", amount: 0.022 }]);
});

test("token models display effective rates, not their fixed precharge amount", async () => {
  const quote = await imageGenerationQuote(apimart, "gemini-3.1-flash-lite-image", response({ quota_type: 0, paid_price: 0.032,
    pricing: { unit: "usd_per_million_tokens", tier_count: 1, group: "default", limits: { supports_cache_read: false },
      effective_rates: { text_input: 0.2, cached_text_input: 0, image_input: 0.2, text_output: 1.2, image_output: 24 } } }), true);
  assert.equal(quote.unit, "million-tokens");
  assert.equal(quote.rows.some((row) => row.amount === 0.032), false);
  assert.deepEqual(quote.rows.map((row) => row.name), ["text_input", "image_input", "text_output", "image_output"]);
});

test("unknown or multi-tier pricing is not silently interpreted as a per-image price", async () => {
  for (const data of [{ quota_type: 0, paid_price: 1 }, { quota_type: 1, paid_price: 1, pricing: { tier_count: 2 } }]) {
    const quote = await imageGenerationQuote(apimart, "gpt-image-2-official", response(data), true);
    assert.equal(quote.status, "unavailable"); assert.deepEqual(quote.rows, []);
  }
});

test("LaoZhang quotes distinguish per-call prices from expression billing", async () => {
  const rows = [{ model_name: "gpt-image-2-vip", quota_type: 1, model_price: 0.03 },
    { model_name: "gpt-image-2.5-flare", quota_type: 1, model_price: 0.2, billing_mode: "tiered_expr" }];
  const quote = await imageGenerationQuote("https://api2.laozhang.ai/v1", "gpt-image-2-vip", response(rows), true);
  assert.equal(quote.unit, "call"); assert.equal(quote.rows[0].amount, 0.03);
  assert.equal((await imageGenerationQuote("https://api.laozhang.ai/v1", "gpt-image-2.5-flare", response(rows), true)).status, "unavailable");
});

test("quote fetching rejects arbitrary endpoints and malformed model identifiers", async () => {
  let calls = 0;
  const request = async () => { calls++; throw new Error("must not fetch"); };
  for (const url of ["http://api.apimart.ai/v1", "https://api.apimart.ai.evil.test/v1", "https://api.apimart.ai/other", "https://user:pass@api.apimart.ai/v1", "https://localhost/v1"]) {
    assert.equal((await imageGenerationQuote(url, "gpt-image-2", request, true)).status, "unavailable");
  }
  assert.equal((await imageGenerationQuote(apimart, "../invalid", request, true)).status, "unavailable");
  assert.equal(calls, 0);
});

test("GPT Image 2.5 Ext preserves both versions and all resolution prices", async () => {
  const quote = await imageGenerationQuote(apimart, "gpt-image-2.5-ext", response({ quota_type: 1, billing_type: "version_resolution", paid_price: 0.0085,
    version_resolution_paid_prices: { flare: { "1K": 0.0085, "2K": 0.03, "4K": 0.04 }, sunburst: { "1K": 0.0085, "2K": 0.03, "4K": 0.04 } } }), true);
  assert.equal(quote.unit, "image");
  assert.equal(quote.rows.length, 6);
  assert.deepEqual(quote.rows[5], { name: "sunburst · 4K", amount: 0.04 });
  assert.equal(quote.sourceUrl, "https://api.apimart.ai/api/pricing/model?model=gpt-image-2.5-ext");
});

test("fixed image tariffs beat incidental token metadata, while token tariffs ignore precharges", () => {
  const fixed = apimartPriceRows({ quota_type: 1, paid_price: 0.0072, resolution_paid_prices: { "1K": 0.0072, "2K": 0.0112 },
    pricing: { tier_count: 1, unit: "usd_per_million_tokens", effective_rates: { input: 9, output: 9 } } });
  assert.equal(fixed.unit, "image");
  assert.equal(fixed.rows.some((row) => row.amount === 9), false);
  const token = apimartPriceRows({ quota_type: 0, billing_type: "tiered_token", paid_price: 0.016, resolution_paid_prices: { "2K": 0.036 },
    pricing: { tier_count: 1, unit: "usd_per_million_tokens", effective_rates: { text_input: 1.4, image_input: 2, image_output: 15.2 } } });
  assert.equal(token.unit, "million-tokens");
  assert.deepEqual(token.rows.map((row) => row.amount), [1.4, 2, 15.2]);
});

test("quality, prompt enhancement, layers and reference surcharges retain separate dimensions", () => {
  const quote = apimartPriceRows({ quota_type: 1, billing_type: "size_quality", paid_price: 99,
    size_quality_paid_prices: { "1K": { low: 0.032, medium: 0.048 }, "2K": { low: 0.048, medium: 0.064 } },
    billing_variant_paid_prices: { prompt_extend: 0.02 }, layer_decomposition_paid_prices: { "1K": 0.014625 }, input_image_paid_price: 0.008, input_image_first_free: true });
  assert.equal(quote.rows.length, 7);
  assert.deepEqual(quote.rows[3], { name: "2K · medium", amount: 0.064 });
  assert.deepEqual(quote.rows[6], { name: "reference_image", amount: 0.008 });
  assert.equal(quote.rows.some((row) => row.amount === 99), false);
  assert.deepEqual(quote.warnings, ["first-reference-free"]);
});

test("pixel-priced FLUX routes retain per-resolution output and input-image rates", () => {
  const quote = apimartPriceRows({ quota_type: 0, resolution_paid_prices: { "1MP": 0.024, "2MP": 0.036 },
    input_image_paid_prices: { "1MP": 0.012, "2MP": 0.024 } });
  assert.equal(quote.unit, "image");
  assert.deepEqual(quote.rows[3], { name: "reference_image · 2MP", amount: 0.024 });
});

test("price conflicts are explicit and malformed amounts never become zero-priced success", () => {
  for (const model_name of ["seedream-5-0-flash", "grok-imagine-2.0-ext"]) {
    assert.deepEqual(apimartPriceRows({ model_name, quota_type: 1, paid_price: 0.015 }).warnings, ["pricing-conflict"]);
  }
  assert.equal(apimartPriceRows({ quota_type: 1, billing_type: "version_resolution", paid_price: 0.0085,
    version_resolution_paid_prices: { flare: { "1K": -1, "2K": Infinity } } }), undefined);
  assert.deepEqual(apimartPriceRows({ quota_type: 1, paid_price: 0 }).rows, [{ name: "default", amount: 0 }]);
});

test("cache shares concurrent public queries, explicit refresh bypasses it and errors stay unknown", async () => {
  let calls = 0;
  const request = async () => { calls++; return Response.json({ success: true, data: { quota_type: 1, paid_price: 0 } }); };
  const first = imageGenerationQuote(apimart, "cache-fixture", request);
  const second = imageGenerationQuote(apimart, "cache-fixture", request);
  assert.equal((await first).rows[0].amount, 0); await second; assert.equal(calls, 1);
  await imageGenerationQuote(apimart, "cache-fixture", request, true); assert.equal(calls, 2);
  const failed = await imageGenerationQuote(apimart, "cache-fixture", async () => { throw new Error("offline"); }, true);
  assert.equal(failed.status, "unavailable"); assert.deepEqual(failed.rows, []);
});
