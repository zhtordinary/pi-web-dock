import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { thinkingBudgetForLevel } from "@earendil-works/pi-ai/api/simple-options";

const { resolveQuickAskOutputBudget, QUICK_ASK_ANSWER_TOKENS: ANSWER, QUICK_ASK_WINDOW_RESERVE_TOKENS: RESERVE, QuickAskError } =
  await createJiti(import.meta.url).import("./quick-ask-context.ts");
const request = { messages: [{ role: "user", content: [{ type: "text", text: "context ".repeat(2000) }], timestamp: 1 }] };
const used = estimateContextTokens(normalizeContext(request)).tokens;
const roomy = { contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true };

test("the answer keeps its own room and reasoning is budgeted on top, as most APIs count it in the output limit", () => {
  assert.equal(resolveQuickAskOutputBudget(roomy, request, undefined), ANSWER);
  for (const level of ["minimal", "low", "medium", "high"]) {
    assert.equal(resolveQuickAskOutputBudget(roomy, request, level), ANSWER + thinkingBudgetForLevel(level), level);
  }
  for (const level of ["xhigh", "max"]) {
    assert.equal(resolveQuickAskOutputBudget(roomy, request, level), ANSWER + thinkingBudgetForLevel("high"), level);
  }
  assert.equal(resolveQuickAskOutputBudget({ ...roomy, reasoning: false }, request, "high"), ANSWER, "a model without reasoning gets no reasoning room");
});

test("the model's own output cap bounds the limit, and an unknown cap or window does not", () => {
  assert.equal(resolveQuickAskOutputBudget({ ...roomy, maxTokens: 8000 }, request, "high"), 8000);
  assert.equal(resolveQuickAskOutputBudget({ ...roomy, maxTokens: 2000 }, request, undefined), 2000);
  assert.equal(resolveQuickAskOutputBudget({ ...roomy, maxTokens: 0 }, request, "low"), ANSWER + thinkingBudgetForLevel("low"));
  assert.equal(resolveQuickAskOutputBudget({ contextWindow: 0, maxTokens: 128_000, reasoning: true }, request, "low"), ANSWER + thinkingBudgetForLevel("low"));
});

test("preflight and request share one bound: window = context + SDK reserve + answer is the smallest that fits", () => {
  const exact = { ...roomy, contextWindow: used + RESERVE + ANSWER };
  assert.equal(resolveQuickAskOutputBudget(exact, request, undefined), ANSWER);
  assert.equal(resolveQuickAskOutputBudget(exact, request, "high"), ANSWER, "no spare room: reasoning cannot push the answer out");
  assert.throws(() => resolveQuickAskOutputBudget({ ...exact, contextWindow: exact.contextWindow - 1 }, request, undefined),
    (error) => error instanceof QuickAskError && error.status === 413 && /超出所选模型窗口/.test(error.message));
  // Spare room goes to reasoning first and is never promised beyond what the SDK would clamp to.
  assert.equal(resolveQuickAskOutputBudget({ ...exact, contextWindow: exact.contextWindow + 100 }, request, "high"), ANSWER + 100);
});
