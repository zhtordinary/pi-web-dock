import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { priceTokenUsages } = await jiti.import("./billing.ts");

test("prices a large batch in one short-lived Python process through stdin", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-billing-batch-"));
  try {
    const marker = join(root, "starts.log");
    const script = join(root, "pricing.py");
    await writeFile(script, [
      "import json",
      `open(${JSON.stringify(marker)}, "a", encoding="utf-8").write("start\\n")`,
      "def price_usages(items):",
      "    return [{'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': item['usage']['input'] + item['usage']['output']}, 'rates': {'currency': 'USD'}} for item in items]",
    ].join("\n"), "utf8");
    const inputs = Array.from({ length: 2_000 }, (_, index) => ({
      provider: "fixture",
      // Make the serialized input exceed common exec argv limits; the adapter
      // must receive it through stdin while preserving row order.
      model: `${"model-"}${index}-${"x".repeat(5_000)}`,
      input: index + 1,
      output: 2,
      totalTokens: index + 3,
      usageAvailable: true,
    }));
    const priced = await priceTokenUsages(inputs, script);
    assert.equal(priced.length, inputs.length);
    assert.deepEqual(priced.slice(0, 3).map((row) => row.cost?.total), [3, 4, 5]);
    assert.deepEqual(priced.slice(-3).map((row) => row.cost?.total), [2000, 2001, 2002]);
    assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
