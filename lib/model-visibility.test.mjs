import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./model-visibility.ts");
  } catch {
    return import("./model-visibility.ts");
  }
}

const {
  filterHiddenModels,
  isModelHidden,
  normalizeHiddenModelReferences,
  toggleHiddenModelReference,
} = await loadSubject();

const MODELS = [
  { provider: "opencode-go", id: "qwen3.8-max" },
  { provider: "opencode-go", id: "grok-4.5" },
  { provider: "other", id: "model-a" },
  { provider: "opencode-go", id: "newly-discovered-model" },
];

test("normalizes duplicate and blank hidden model references", () => {
  assert.deepEqual(
    normalizeHiddenModelReferences(["  opencode-go/qwen3.8-max ", "opencode-go/qwen3.8-max", "", "  ", 42, null]),
    ["opencode-go/qwen3.8-max"],
  );
  assert.deepEqual(normalizeHiddenModelReferences(undefined), []);
});

test("hides only the exact provider/model reference and leaves new models visible", () => {
  const hidden = ["opencode-go/grok-4.5"];
  assert.equal(isModelHidden({ provider: "opencode-go", id: "grok-4.5" }, hidden), true);
  assert.equal(isModelHidden({ provider: "opencode-go", id: "qwen3.8-max" }, hidden), false);
  assert.equal(isModelHidden({ provider: "other", id: "grok-4.5" }, hidden), false);
  assert.deepEqual(
    filterHiddenModels(MODELS, hidden).map((model) => model.id),
    ["qwen3.8-max", "model-a", "newly-discovered-model"],
  );
  assert.deepEqual(filterHiddenModels(MODELS, []), MODELS);
});

test("toggling a hidden model reference is reversible", () => {
  const hidden = toggleHiddenModelReference([], { provider: "opencode-go", id: "grok-4.5" });
  assert.deepEqual(hidden, ["opencode-go/grok-4.5"]);
  assert.deepEqual(toggleHiddenModelReference(hidden, { provider: "opencode-go", id: "grok-4.5" }), []);
});
