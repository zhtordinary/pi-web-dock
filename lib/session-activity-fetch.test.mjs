import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { clearSessionActivityCache, fetchSessionActivity } from "./session-activity-fetch.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSessionActivityCache();
});

test("coalesces concurrent activity snapshots and reuses short cache", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ sessions: [] }) };
  };
  const first = fetchSessionActivity("/api/session-runs?scope=local");
  const second = fetchSessionActivity("/api/session-runs?scope=local");
  assert.strictEqual(await first, await second);
  assert.equal(calls, 1);
  await fetchSessionActivity("/api/session-runs?scope=local");
  assert.equal(calls, 1);
});

test("force bypasses completed cache but still joins in-flight request", async () => {
  let calls = 0;
  let releaseFirst;
  globalThis.fetch = () => {
    calls += 1;
    if (calls === 1) {
      return new Promise((resolve) => {
        releaseFirst = resolve;
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ sessions: [] }) });
  };
  const first = fetchSessionActivity("/api/session-runs?scope=local");
  const forcedInFlight = fetchSessionActivity("/api/session-runs?scope=local", { force: true });
  assert.equal(calls, 1);
  releaseFirst({ ok: true, status: 200, json: async () => ({ sessions: [] }) });
  assert.strictEqual(await first, await forcedInFlight);
  await fetchSessionActivity("/api/session-runs?scope=local", { force: true });
  assert.equal(calls, 2);
});
