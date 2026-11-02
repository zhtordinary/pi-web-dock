import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const mod = await jiti.import("./session-caches.ts");

test("session metadata cache is capped and evicts the oldest entry", () => {
  // Fill past the 500-entry cap with increasing fetchedAt; the first (oldest)
  // must be evicted so the map stays at the cap.
  const base = 1_700_000_000_000;
  for (let i = 0; i < 501; i += 1) {
    mod.cacheSessionMetadata(`s${i}`, {
      modified: `m${i}`,
      fileMtimeMs: i,
      fetchedAt: base + i,
    });
  }
  // 501st insert pushed the map to 500; s0 (oldest) evicted.
  assert.equal(mod.readSessionMetadata("s0"), undefined, "oldest entry should be evicted");
  assert.ok(mod.readSessionMetadata("s500"), "newest entry should remain");
  // Subsequent entries still bounded: add one more, oldest (s1) evicted.
  mod.cacheSessionMetadata("s501", { modified: "m", fileMtimeMs: 1, fetchedAt: base + 502 });
  assert.equal(mod.readSessionMetadata("s1"), undefined);
  assert.ok(mod.readSessionMetadata("s501"));
});

test("cost cache is capped and evicts the oldest entry", () => {
  const base = 1_700_000_000_000;
  for (let i = 0; i < 501; i += 1) {
    mod.cacheCost(`c${i}`, { sessionMtimeMs: base + i, scriptMtimeMs: null, priceTableSignature: "missing", result: { x: i } });
  }
  assert.equal(mod.readCost("c0"), undefined);
  assert.ok(mod.readCost("c500"));
});

test("clearSessionCaches removes a session from both caches", () => {
  mod.cacheSessionMetadata("target", { modified: "m", fileMtimeMs: 1, fetchedAt: 1 });
  mod.cacheCost("target", { sessionMtimeMs: 1, scriptMtimeMs: null, priceTableSignature: "missing", result: {} });
  assert.ok(mod.readSessionMetadata("target"));
  assert.ok(mod.readCost("target"));
  mod.clearSessionCaches("target");
  assert.equal(mod.readSessionMetadata("target"), undefined);
  assert.equal(mod.readCost("target"), undefined);
  // Other sessions unaffected.
  assert.ok(mod.readSessionMetadata("s501"));
});
