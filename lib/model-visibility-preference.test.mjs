import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./model-visibility-preference.ts");
  } catch {
    return import("./model-visibility-preference.ts");
  }
}

const { filterHiddenProviderNames } = await loadSubject();

test("filters hidden providers while retaining the current selection", () => {
  const names = ["visible", "hidden", "other-hidden"];
  const hidden = new Set(["hidden", "other-hidden"]);

  assert.deepEqual(filterHiddenProviderNames(names, hidden), ["visible"]);
  assert.deepEqual(filterHiddenProviderNames(names, hidden, "hidden"), ["visible", "hidden"]);
});
