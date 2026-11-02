import assert from "node:assert/strict";
import test from "node:test";
import { quickAskFixture, deferred, log, storage } from "../test-support/quick-ask-fixture.mjs";

const scope = { threadId: "a", branchId: "main" };
async function completed(h, body = {}, result = {}) {
  const run = await h.start(body);
  h.runs.at(-1).complete("answer", result);
  return h.waitTerminal(run.id);
}

for (const mainRunning of [false, true]) {
  test(`deletion before admission rejects that exact request even when mainRunning=${mainRunning}`, async () => {
    const h = await quickAskFixture();
    try {
      h.state.mainRunning = mainRunning;
      const gate = deferred(), requestId = "not-yet-admitted";
      const pending = h.post({ action: "start", ...scope, requestId, question: "late question", expectedParentId: h.manager.getLeafId() }, { params: gate.promise });
      assert.equal((await h.request("DELETE", { ...scope, requestId })).status, 200);
      gate.resolve({ id: h.manager.getSessionId() });
      assert.equal((await pending).status, 410);
      assert.equal(h.runs.length, 0, "a deleted request must not reach even the synthetic provider");
      assert.equal((await h.post({ action: "start", requestId, threadId: "other", question: "different scope" })).status, 409);
      assert.equal(h.runs.length, 0);
      const recovered = await h.get(`?runId=${requestId}`);
      assert.equal(recovered.status, 410);
      assert.deepEqual(await recovered.json(), { error: "该侧问已删除", code: "quick_ask_deleted", runId: requestId, ...scope });
      const next = await completed(h, { requestId: "new-request" });
      assert.equal(next.status, "completed", "a new request may reuse the topic after deletion");
    } finally { await h.cleanup(); }
  });
}

test("a pending deletion identity cannot cancel a recorded request from another scope", async () => {
  const h = await quickAskFixture();
  try {
    const run = await h.start({ threadId: "other" }), before = h.manager.getEntryCount();
    const response = await h.request("DELETE", { ...scope, requestId: run.id });
    assert.equal(response.status, 409);
    assert.equal(h.manager.getEntryCount(), before);
    assert.equal(h.runs[0].options.signal.aborted, false);
    h.runs[0].complete(); await h.waitTerminal(run.id);
  } finally { await h.cleanup(); }
});

test("single deletion removes its run from list/id projections while retaining native usage and other outcomes", async () => {
  const h = await quickAskFixture();
  try {
    const failed = await h.start({ question: "failed" });
    h.runs[0].fail(); await h.waitTerminal(failed.id);
    const done = await completed(h), original = structuredClone(h.manager.getEntry(done.entry.id));
    assert.equal((await h.request("DELETE", { targetId: done.entry.id })).status, 200);
    const list = await (await h.get()).json();
    assert.equal(list.items.length, 0);
    assert.deepEqual(list.runs.map((run) => run.id), [failed.id]);
    assert.equal(list.runs[0].status, "failed");
    assert.equal(h.side.snapshot(done.id), undefined);
    const calls = h.runs.length;
    assert.equal((await h.post({ action: "start", ...scope, requestId: done.id, question: done.question })).status, 410);
    assert.equal(h.runs.length, calls);
    assert.deepEqual(h.manager.getEntry(done.entry.id), original, "display deletion keeps real usage and native provenance");
    for (const cold of [false, true]) {
      h.state.visible = !cold;
      const response = await h.get(`?runId=${done.id}&stream=1`);
      assert.equal(response.status, 410);
      const body = await response.json();
      assert.equal(body.code, "quick_ask_deleted");
      assert.equal(body.runId, done.id);
      assert.equal(body.threadId, "a");
    }
    assert.equal((await h.get("?runId=unknown")).status, 404);
    assert.equal(h.state.starts, 0, "reads never boot an Agent runtime");
    assert.deepEqual(await storage.readSessionQuickAsks(h.file), []);
  } finally { await h.cleanup(); }
});

test("historical top-level single tombstones are honored by the same run projection", async () => {
  const h = await quickAskFixture();
  try {
    const done = await completed(h);
    const records = [...h.manager.getEntries(), { type: "custom", customType: "quick_ask_delete", id: "old-tombstone",
      parentId: h.manager.getLeafId(), timestamp: new Date().toISOString(), targetId: done.entry.id }];
    assert.equal(storage.projectSessionQuickAsks(records).length, 0);
    assert.equal(log.quickAskRunSnapshots(records, [], false).some((run) => run.id === done.id), false);
  } finally { await h.cleanup(); }
});

test("requested model is projected from native state consistently in completion and cold history, without changing actual attribution", async () => {
  const h = await quickAskFixture();
  try {
    const requested = { provider: "fixture", id: "virtual-intent" };
    const done = await completed(h, { model: requested }, { provider: "routed", model: "actual-wire" });
    const intent = { provider: requested.provider, modelId: requested.id };
    assert.deepEqual(done.entry.requestedModel, intent);
    assert.equal(done.entry.provider, "routed");
    assert.equal(done.entry.model, "actual-wire");
    h.state.visible = false;
    const cold = await (await h.get()).json();
    assert.deepEqual(cold.items[0].requestedModel, intent);
    assert.deepEqual(cold.runs[0].entry.requestedModel, intent);
    assert.equal(cold.items[0].data.nativeEntries, undefined);
    const persisted = h.manager.getEntry(done.entry.id);
    assert.equal(persisted.requestedModel, undefined);
    assert.equal(persisted.data.requestedModel, undefined, "model intent is a read projection, not another persisted setting");
    assert.equal(persisted.data.provider, "routed");
    assert.equal(persisted.data.model, "actual-wire");
    const ordinary = await completed(h, { threadId: "b" });
    assert.deepEqual(ordinary.entry.requestedModel, { provider: "fixture", modelId: "model" });
    const flat = storage.normalizeQuickAskEntry({ type: "custom", customType: "quick_ask", id: "flat", data: {
      question: "q", answer: "a", provider: "old", model: "old-model", createdAt: 1,
    } });
    assert.equal(flat.requestedModel, undefined);
  } finally { await h.cleanup(); }
});

test("invalid deletion identities cannot append a tombstone or stop an accepted task", async () => {
  const h = await quickAskFixture();
  try {
    const run = await h.start(), before = h.manager.getEntryCount();
    for (const body of [{ ...scope, requestId: [] }, { ...scope, requestId: " " }, { targetId: "item", requestId: run.id }]) {
      assert.equal((await h.request("DELETE", body)).status, 400);
    }
    assert.equal(h.manager.getEntryCount(), before);
    assert.equal(h.runs[0].options.signal.aborted, false);
    assert.equal((await h.request("DELETE", { ...scope, requestId: run.id })).status, 200);
    assert.equal(h.runs[0].options.signal.aborted, true);
    assert.equal(h.side.snapshot(run.id), undefined);
  } finally { await h.cleanup(); }
});

test("identity recovery hydrates attachments once and never exports native records", async () => {
  const h = await quickAskFixture();
  try {
    const image = { data: "AAAA", mimeType: "image/png" };
    const done = await completed(h, { images: [image] });
    for (const cold of [false, true]) {
      h.state.visible = !cold;
      const response = await h.get(`?runId=${done.id}`);
      assert.equal(response.status, 200);
      const { run } = await response.json();
      assert.deepEqual(run.images, [image]);
      assert.equal(run.nativeEntries, undefined);
      assert.equal(run.entry.data.nativeEntries, undefined);
      assert.equal(run.entry.data.images, undefined);
      assert.deepEqual(run.entry.requestedModel, { provider: "fixture", modelId: "model" });
    }
    assert.equal(h.state.starts, 0);
  } finally { await h.cleanup(); }
});
