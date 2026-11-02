import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createJiti } from "jiti";
const source = await readFile(new URL("./ModelSelector.tsx", import.meta.url), "utf8");
const { filterModelOptions } = await createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true }).import("./ModelSelector.tsx");

test("searches provider, model identity, and display name without changing order", () => {
  const options = [
    { provider: "relay", modelId: "alpha", name: "First Model" },
    { provider: "other", modelId: "alpha", name: "Second Model" },
    { provider: "relay", modelId: "beta", name: "Last Model" },
  ];
  assert.deepEqual(filterModelOptions(options, "relay"), [options[0], options[2]]);
  assert.deepEqual(filterModelOptions(options, "RELAY/alpha"), [options[0]]);
  assert.deepEqual(filterModelOptions(options, "other/Second"), [options[1]]);
  assert.deepEqual(filterModelOptions(options, "alpha"), options.slice(0, 2));
  assert.equal(filterModelOptions(options, " "), options);
});

test("does not autofocus the model filter on mobile", () => {
  // Autofocus would open the on-screen keyboard as soon as the picker opens.
  assert.match(source, /aria-label=\{t\("chat\.filterModels"\)\}[\s\S]*?autoFocus=\{!isMobile\}/);
  assert.doesNotMatch(source, /^\s*autoFocus\s*$/m);
});
