import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./format-metric-number.ts");
  } catch {
    return import("./format-metric-number.ts");
  }
}

const { formatMetricNumber } = await loadSubject();

test("matches session panel KMB formatting", () => {
  assert.equal(formatMetricNumber(2_300_000), "2.3M");
  assert.equal(formatMetricNumber(64_700), "64.7K");
  assert.equal(formatMetricNumber(25_500_000), "25.5M");
  assert.equal(formatMetricNumber(1_640_791), "1.64M");
  assert.equal(formatMetricNumber(29_912), "29.9K");
  assert.equal(formatMetricNumber(17_857_024), "17.9M");
});
