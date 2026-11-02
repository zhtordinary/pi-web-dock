import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { calculateResponseDurationMs, formatResponseDuration } = await jiti.import("./response-duration.ts");

test("calculates response duration only for ordered finite timestamps", () => {
  assert.equal(calculateResponseDurationMs(1_000, 3_500), 2_500);
  assert.equal(calculateResponseDurationMs(3_500, 1_000), undefined);
  assert.equal(calculateResponseDurationMs(undefined, 1_000), undefined);
  assert.equal(calculateResponseDurationMs(Number.NaN, 1_000), undefined);
});

test("formats short, minute, and hour response durations", () => {
  assert.equal(formatResponseDuration(800), "0.8s");
  assert.equal(formatResponseDuration(12_400), "12s");
  assert.equal(formatResponseDuration(65_000), "1m 5s");
  assert.equal(formatResponseDuration(3_661_000), "1h 1m 1s");
  assert.equal(formatResponseDuration(-1), "");
});
