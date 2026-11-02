import assert from "node:assert/strict";
import test from "node:test";
import { QueuedDraftProjection, readQueuedDraftState, recalledQueuedDrafts } from "./queued-draft.ts";

const image = data => ({ data, mimeType: "image/png" });
const item = (itemId, text = "same", images) => ({ itemId, role: "user", text, hasImages: Boolean(images?.length), imageCount: images?.length ?? 0, ...(images ? { images } : {}) });
const snapshot = (queueRevision, steering = [], followUp = [], bootId = "boot-A") => ({ bootId, queueRevision, steering, followUp });

test("recall after consuming the first duplicate restores only the second image", () => {
  const projection = new QueuedDraftProjection();
  projection.apply("local:session", snapshot(1, [item("A", "same", [image("AAAA")]), item("B", "same", [image("BBBB")])]));
  projection.apply("local:session", snapshot(2, [item("B", "same", [image("BBBB")])]));
  assert.deepEqual(recalledQueuedDrafts(projection.snapshot), [item("B", "same", [image("BBBB")])]);
});

test("recall preserves duplicate text, image-only items and per-kind queue order", () => {
  const entries = [item("first", "same"), item("second", "same", [image("BBBB")]), item("empty", "", [image("CCCC")])];
  assert.deepEqual(recalledQueuedDrafts(snapshot(4, entries.slice(0, 2), entries.slice(2))), entries);
});

test("server owns attachments across remounts without a local draft mirror", () => {
  const server = snapshot(9, [], [item("image", "", [image("AAAA")])]);
  const remounted = new QueuedDraftProjection();
  remounted.apply("peer:session", server);
  const recalled = recalledQueuedDrafts(remounted.snapshot);
  recalled[0].images[0].data = "changed";
  assert.equal(recalledQueuedDrafts(server)[0].images[0].data, "AAAA");
});

test("a stale snapshot cannot resurrect consumed items or erase a new item", () => {
  const projection = new QueuedDraftProjection();
  projection.apply("s", snapshot(2, [item("second")]));
  assert.equal(projection.apply("s", snapshot(1, [item("first"), item("second")])), null);
  projection.apply("s", snapshot(4, [item("new")]));
  assert.equal(projection.apply("s", snapshot(3)), null);
  assert.deepEqual(projection.snapshot.steering.map(item => item.itemId), ["new"]);
});

test("a late old-boot request and retired-boot event cannot replace a newer queue", () => {
  const projection = new QueuedDraftProjection();
  projection.reset("s");
  const request = projection.generation;
  projection.apply("s", snapshot(1, [item("new")], [], "new-boot"));
  assert.equal(projection.apply("s", snapshot(99, [item("old")], [], "old-boot"), request), null);
  projection.apply("s", snapshot(1, [], [], "next-boot"));
  assert.equal(projection.apply("s", snapshot(100, [item("new")], [], "new-boot")), null);
});

test("session and peer changes reject in-flight responses from the old scope", () => {
  const projection = new QueuedDraftProjection();
  projection.apply("peer-A:shared-session", snapshot(2, [item("A")]));
  const generation = projection.generation;
  projection.reset("peer-B:shared-session");
  projection.apply("peer-B:shared-session", snapshot(1, [item("B")], [], "boot-B"));
  assert.equal(projection.apply("peer-A:shared-session", snapshot(3, [item("A")]), generation), null);
  assert.equal(projection.snapshot.steering[0].itemId, "B");
});

test("a same-scope reset fences old requests before the next producer snapshot", () => {
  const projection = new QueuedDraftProjection();
  projection.apply("s", snapshot(1, [item("old")]));
  const generation = projection.generation;
  projection.reset("s");
  assert.equal(projection.apply("s", snapshot(2, [item("old")]), generation), null);
  assert.equal(projection.snapshot, null);
  assert.ok(projection.apply("s", snapshot(1, [item("fresh")], [], "fresh-boot"), projection.generation));
});

test("confirmed absence retires its boot, fences old reads, and preserves newer enqueues", () => {
  const projection = new QueuedDraftProjection();
  projection.apply("s", snapshot(1, [item("old")]));
  const oldRequest = projection.generation;
  projection.apply("s", snapshot(2, [item("new")]));
  assert.equal(projection.clearAbsent("s", oldRequest), false);
  assert.equal(projection.snapshot.steering[0].itemId, "new");
  assert.equal(projection.clearAbsent("other-scope", projection.generation), false);
  const absentRequest = projection.generation;
  assert.equal(projection.clearAbsent("s", absentRequest), true);
  assert.equal(projection.apply("s", snapshot(3, [item("new")])), null, "retired SSE replay stays retired");
  assert.equal(projection.apply("s", snapshot(1, [item("stale")], [], "unseen-boot"), absentRequest), null);
  assert.equal(projection.snapshot, null);
  assert.ok(projection.apply("s", snapshot(1, [item("fresh")], [], "fresh-boot"), projection.generation));
});

test("same-boot newer revision wins even when the request generation is older", () => {
  const projection = new QueuedDraftProjection();
  projection.apply("s", snapshot(1, [item("old")]));
  const generation = projection.generation;
  projection.apply("s", snapshot(2, [item("new")]));
  assert.ok(projection.apply("s", snapshot(3), generation));
  assert.equal(projection.snapshot.steering.length, 0);
});

test("legacy text, duplicate IDs and incomplete attachment responses fail closed", () => {
  assert.equal(readQueuedDraftState({ steering: ["same"], followUp: [] }), null);
  assert.equal(readQueuedDraftState(snapshot(1, [item("x"), item("x")])), null);
  assert.throws(() => recalledQueuedDrafts({ steering: ["same"], followUp: [] }), /identities/);
  assert.throws(() => recalledQueuedDrafts(snapshot(1, [{ itemId: "x", role: "user", text: "same", hasImages: true, imageCount: 1 }])), /attachments/);
});

test("recall operation identity survives a page reload without persisting attachment bytes", async t => {
  const previous = globalThis.window;
  const storage = new Map();
  globalThis.window = { sessionStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  } };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  const first = await import(`./queued-draft.ts?operation-first=${Date.now()}`);
  const state = snapshot(1, [item("A", "same", [image("AAAA")])]);
  const started = first.beginQueueRecallOperation("peer-A:s", state);
  assert.ok(started.operationId);
  assert.equal([...storage.values()][0].includes('"data"'), false);
  const reloaded = await import(`./queued-draft.ts?operation-reloaded=${Date.now()}`);
  assert.equal(reloaded.getQueueRecallOperation("peer-A:s").operationId, started.operationId);
  assert.equal(reloaded.getQueueRecallOperation("peer-B:s"), null);
  reloaded.clearQueueRecallOperation("peer-A:s");
  assert.equal(storage.size, 0);
});

test("non-user and custom queue identities can be shown but never converted to user drafts", () => {
  for (const entry of [{ ...item("custom"), role: "custom", customType: "reader.peer-message" }, { ...item("unknown"), role: "unknown" }]) {
    const state = snapshot(1, [entry]);
    assert.ok(readQueuedDraftState(state));
    assert.throws(() => recalledQueuedDrafts(state), /non-user messages/);
  }
});
