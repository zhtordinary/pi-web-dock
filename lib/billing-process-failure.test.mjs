import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { priceTokenUsages } = await jiti.import("./billing.ts");

test("early pricing-process exit is a safe unavailable result without an unhandled stdin EPIPE", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-billing-early-exit-"));
  try {
    const script = join(root, "exit.py");
    await writeFile(script, "import os\nos.close(0)\n", "utf8");
    const inputs = Array.from({ length: 2_000 }, (_, index) => ({
      provider: "fixture",
      model: `${index}-${"x".repeat(4_000)}`,
      input: 1,
      output: 1,
      totalTokens: 2,
      usageAvailable: true,
    }));
    const priced = await priceTokenUsages(inputs, script);
    assert.equal(priced.length, inputs.length);
    assert.equal(priced.every((row) => row.pricing.configured === false), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
