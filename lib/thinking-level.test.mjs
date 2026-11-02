import assert from "node:assert/strict";
import test from "node:test";

const { maxSupportedThinkingLevel, resolveDefaultThinkingLevel, getThinkingChoices } = await import("./thinking-level.ts");

test("uses strongest supported level when model has no explicit default", () => {
  assert.equal(maxSupportedThinkingLevel(["off", "low", "high"]), "high");
  assert.equal(resolveDefaultThinkingLevel(["off", "low", "high"]), "high");
  assert.equal(resolveDefaultThinkingLevel(["off", "low", "high", "max"], "low"), "low");
  assert.equal(resolveDefaultThinkingLevel(["off", "low", "high"], undefined, "low"), "low");
});

test("keeps an explicit enabled-model pin as a fallback default", () => {
  assert.equal(resolveDefaultThinkingLevel(["off", "low", "high"], undefined, "max"), "max");
  assert.equal(maxSupportedThinkingLevel([]), null);
});

test("uses the same model-supported choices for chat and plugin models", () => {
  assert.deepEqual(getThinkingChoices(["xhigh", "max"]), ["auto", "xhigh", "max"]);
  assert.deepEqual(getThinkingChoices(["off", "low", "high"]), ["auto", "off", "low", "high"]);
  assert.deepEqual(getThinkingChoices(["off"]), ["auto", "off"]);
});
