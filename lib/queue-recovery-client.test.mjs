import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true, tsconfigPaths: true });
const { createQueueRecoveryClient } = await jiti.import("./queue-recovery-client.ts");

function fixture(request) {
  let restores = 0;
  const client = createQueueRecoveryClient({ sessionId: "s", peer: "old-peer", request, isCurrent: () => true,
    input: () => ({ availableImageSlots: () => 10, hasQueuedDraft: () => false, isQueuedDraftDurable: () => false, prependQueuedDraft: () => { restores++; return true; } }),
    changed() {}, download() { throw new Error("must not download"); },
  });
  return { client, get restores() { return restores; } };
}

test("an old peer's missing recovery endpoint stays quiet during automatic discovery but explains an explicit attempt", async () => {
  const calls = [];
  const h = fixture(async (url, init) => { calls.push({ url, init }); return new Response("<!doctype html><title>404: This page could not be found</title>", { status: 404, headers: { "Content-Type": "text/html" } }); });
  await h.client.refresh();
  assert.equal(h.client.state.error, null);
  assert.equal(h.client.state.entries.length, 0);
  assert.equal(h.client.state.loading, false);
  await assert.rejects(h.client.ensureAvailable(), { code: "queue_recovery_unsupported", notSent: true });
  assert.match(h.client.state.error, /Update Reader on that device/);
  await h.client.refresh({ interactive: true });
  assert.match(h.client.state.error, /Update Reader on that device/);
  await h.client.refresh();
  assert.match(h.client.state.error, /Update Reader/, "later background discovery must not hide an explicit warning");
  await h.client.restore("old-operation");
  assert.match(h.client.state.error, /does not support queue recovery/);
  assert.equal(h.restores, 0);
  assert.equal(calls.every(call => !call.init.method), true, "capability failure sends only read requests");
});

for (const [title, response] of [
  ["unknown peer", () => Response.json({ error: "Unknown peer: renamed-device" }, { status: 404 })],
  ["missing recovery copy", () => Response.json({ error: "Recovery copy missing", code: "queue_recovery_missing" }, { status: 404 })],
  ["server read failure", () => Response.json({ error: "Recovery disk read failed" }, { status: 500 })],
  ["permission denial", () => Response.json({ error: "Request denied" }, { status: 403 })],
  ["malformed successful response", () => new Response("invalid JSON", { status: 200 })],
  ["wrong successful response schema", () => Response.json({ sessions: [] })],
]) {
  test(`automatic discovery keeps ${title} visible instead of claiming an empty inbox`, async () => {
    const h = fixture(async () => response());
    await h.client.refresh();
    assert.ok(h.client.state.error);
    assert.equal(h.client.state.loading, false);
  });
}

test("partial discovery warnings stay visible alongside usable copies and clear only on a verified clean refresh", async () => {
  let warnings = ["A saved recovery record is corrupt; its bytes are retained"];
  const h = fixture(async () => Response.json({ recoveries: [], warnings }));
  await h.client.refresh();
  assert.deepEqual(h.client.state.warnings, warnings);
  assert.equal(h.client.state.error, null);
  warnings = [];
  await h.client.refresh();
  assert.deepEqual(h.client.state.warnings, []);
});

test("only a confirmed server save emits settlement, not inspection, export or rejected confirmation", async () => {
  const settled = [];
  let permitted = false;
  const entry = { operationId: "operation-A", expected: { bootId: "boot", queueRevision: 1 } };
  const client = createQueueRecoveryClient({ sessionId: "s", peer: null, isCurrent: () => true, input: () => null,
    request: async () => permitted ? Response.json({ saved: true }) : Response.json({ error: "save failed" }, { status: 503 }),
    changed() {}, download() {}, settled: operationId => settled.push(operationId),
  });
  await client.confirmSaved(entry, false);
  await client.confirmSaved(entry, true);
  assert.deepEqual(settled, []);
  permitted = true;
  await client.confirmSaved(entry, true);
  assert.deepEqual(settled, ["operation-A"]);
});

for (const confirmation of ["lost response", "another tab"]) {
  test(`a clean discovery reconciles ${confirmation} without changing or resending the draft`, async () => {
    const entry = { operationId: "operation-A", status: "committed", expected: { bootId: "boot", queueRevision: 1 } };
    let serverEntries = [entry];
    let retained = entry.operationId;
    const settled = [], restored = [], calls = [];
    const draft = { text: "dirty original plus recovered message", images: ["original", "recovered"] };
    const client = createQueueRecoveryClient({ sessionId: "s", peer: null, isCurrent: () => true,
      input: () => { throw new Error("discovery must never mutate the composer"); },
      retainedOperation: () => retained,
      settled: id => { settled.push(id); retained = null; }, restored: id => restored.push(id),
      request: async (_url, init) => {
        calls.push(init.method ?? "GET");
        if (init.method === "POST") { serverEntries = []; throw new Error("response lost after commit"); }
        return Response.json({ recoveries: serverEntries, warnings: [] });
      }, changed() {}, download() {},
    });
    await client.refresh();
    if (confirmation === "lost response") await client.confirmSaved(entry, true);
    else serverEntries = [];
    await client.refresh();
    assert.deepEqual(settled, [entry.operationId]);
    assert.deepEqual(restored, [], "list disappearance confirms retention only, not restoration");
    assert.equal(retained, null);
    assert.equal(client.state.entries.length, 0);
    assert.equal(client.state.error, null);
    assert.equal(calls.filter(method => method === "POST").length, confirmation === "lost response" ? 1 : 0);
    assert.deepEqual(draft, { text: "dirty original plus recovered message", images: ["original", "recovered"] });
  });
}

test("failed, corrupt, or malformed discovery cannot settle a missing server copy", async () => {
  const settled = [];
  let response = () => Response.json({ error: "unreadable" }, { status: 500 });
  const client = createQueueRecoveryClient({ sessionId: "s", peer: null, isCurrent: () => true, input: () => null,
    retainedOperation: () => "operation-A", settled: id => settled.push(id),
    request: async () => response(), changed() {}, download() {},
  });
  await client.refresh();
  response = () => Response.json({ recoveries: [], warnings: ["corrupt record"] });
  await client.refresh();
  response = () => Response.json({ recoveries: [{ operationId: null }], warnings: [] });
  await client.refresh();
  assert.deepEqual(settled, []);
});

test("a delayed empty discovery cannot settle an operation created after that read began", async () => {
  let finish;
  let retained = null;
  const settled = [];
  const client = createQueueRecoveryClient({ sessionId: "s", peer: null, isCurrent: () => true, input: () => null,
    retainedOperation: () => retained, settled: id => settled.push(id),
    request: () => new Promise(resolve => { finish = resolve; }), changed() {}, download() {},
  });
  const refresh = client.refresh();
  retained = "new-operation";
  finish(Response.json({ recoveries: [], warnings: [] }));
  await refresh;
  assert.deepEqual(settled, []);
});

test("older ensureAvailable cannot settle or replace a newer discovery", async () => {
  const waiting = [], settled = [];
  const entry = { operationId: "operation-A", status: "committed" };
  const client = createQueueRecoveryClient({ sessionId: "s", peer: null, isCurrent: () => true, input: () => null,
    retainedOperation: () => entry.operationId, settled: id => settled.push(id),
    request: () => new Promise(resolve => waiting.push(resolve)), changed() {}, download() {},
  });
  const old = client.ensureAvailable();
  const newer = client.refresh();
  waiting[1](Response.json({ recoveries: [entry], warnings: [] }));
  await newer;
  waiting[0](Response.json({ recoveries: [], warnings: [] }));
  await old;
  assert.deepEqual(settled, []);
  assert.equal(client.state.entries[0].operationId, entry.operationId);
});
