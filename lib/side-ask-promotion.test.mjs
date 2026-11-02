import assert from "node:assert/strict";
import test from "node:test";
import { flushSideAskPromotions, pendingSideAskPromotions, queueSideAskPromotion } from "./side-ask-promotion.ts";

function memory(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}
const key = "pi-web:side-ask-promotions:session";
const ok = (promotedCount) => Response.json({ success: true, promotedCount });

test("queued branches are remembered once, never include main, and survive unreadable storage", () => {
  const storage = memory();
  queueSideAskPromotion(storage, "session", "side-1");
  queueSideAskPromotion(storage, "session", "side-1");
  queueSideAskPromotion(storage, "session", "main");
  queueSideAskPromotion(storage, "session", "");
  assert.deepEqual(pendingSideAskPromotions(storage, "session"), ["side-1"]);
  assert.deepEqual(pendingSideAskPromotions(memory({ [key]: "{not json" }), "session"), []);
  assert.deepEqual(pendingSideAskPromotions(memory({ [key]: JSON.stringify([1, "main", "side-2"]) }), "session"), ["side-2"]);
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  queueSideAskPromotion(blocked, "session", "side-3");
  assert.deepEqual(pendingSideAskPromotions(blocked, "session"), []);
});

test("a confirmed move is forgotten, reports what moved and addresses the right host", async () => {
  const storage = memory();
  queueSideAskPromotion(storage, "session", "side-1");
  queueSideAskPromotion(storage, "session", "side-2");
  const calls = [];
  const moved = await flushSideAskPromotions({ storage, sessionId: "session", fetcher: async (url, init) => {
    calls.push([url, JSON.parse(init.body)]); return ok(calls.length);
  } });
  assert.equal(moved, 3);
  assert.deepEqual(calls, [
    ["/api/sessions/session/quick-ask", { action: "promote_branch", fromBranchId: "side-1" }],
    ["/api/sessions/session/quick-ask", { action: "promote_branch", fromBranchId: "side-2" }],
  ]);
  assert.deepEqual(pendingSideAskPromotions(storage, "session"), []);
  assert.equal(storage.values.has(key), false);

  queueSideAskPromotion(storage, "remote session", "side-3");
  let remoteUrl = "";
  await flushSideAskPromotions({ storage, sessionId: "remote session", remotePeer: "mac mini", fetcher: async (url) => { remoteUrl = url; return ok(0); } });
  assert.equal(remoteUrl, "/api/remote/sessions/remote%20session/quick-ask?peer=mac%20mini");
});

test("a refused or unreachable move stays pending and is asked again later; an invalid one is dropped", async () => {
  const storage = memory();
  for (const branch of ["running", "invalid", "later"]) queueSideAskPromotion(storage, "session", branch);
  const answers = { running: () => Response.json({ error: "busy" }, { status: 409 }), invalid: () => Response.json({ error: "bad" }, { status: 400 }), later: () => ok(2) };
  assert.equal(await flushSideAskPromotions({ storage, sessionId: "session", fetcher: async (_url, init) => answers[JSON.parse(init.body).fromBranchId]() }), 2);
  assert.deepEqual(pendingSideAskPromotions(storage, "session"), ["running"]);

  let attempts = 0;
  assert.equal(await flushSideAskPromotions({ storage, sessionId: "session", fetcher: async () => { attempts++; throw new TypeError("offline"); } }), 0);
  assert.equal(attempts, 1);
  assert.deepEqual(pendingSideAskPromotions(storage, "session"), ["running"]);

  assert.equal(await flushSideAskPromotions({ storage, sessionId: "session", fetcher: async () => ok(1) }), 1);
  assert.deepEqual(pendingSideAskPromotions(storage, "session"), []);
});

test("overlapping flushes share one round of requests, and an aborted flush stops before the next branch", async () => {
  const storage = memory();
  queueSideAskPromotion(storage, "session", "side-1");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const fetcher = async () => { calls++; await gate; return ok(1); };
  const first = flushSideAskPromotions({ storage, sessionId: "session", fetcher });
  const second = flushSideAskPromotions({ storage, sessionId: "session", fetcher });
  release();
  assert.deepEqual(await Promise.all([first, second]), [1, 1]);
  assert.equal(calls, 1);

  for (const branch of ["a", "b"]) queueSideAskPromotion(storage, "session", branch);
  const controller = new AbortController();
  const seen = [];
  await flushSideAskPromotions({ storage, sessionId: "session", signal: controller.signal, fetcher: async (_url, init) => {
    seen.push(JSON.parse(init.body).fromBranchId); controller.abort(); return ok(1);
  } });
  assert.deepEqual(seen, ["a"]);
  assert.deepEqual(pendingSideAskPromotions(storage, "session"), ["b"]);
});
