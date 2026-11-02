import assert from "node:assert/strict";
import test from "node:test";
import { quickAskFixture, storage, deferred, tick, image } from "../../../../../test-support/quick-ask-fixture.mjs";

// Disconnect is observer cleanup. Stopping inference is a separate explicit action.
test("legacy SSE cancellation detaches without aborting or discarding the saved result", async () => {
  const h = await quickAskFixture();
  try {
    const browser = new AbortController();
    const response = await h.post({ question: "persistent", threadId: "a" }, { signal: browser.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    await reader.cancel();
    browser.abort();
    assert.equal(h.runs[0].options.signal.aborted, false);
    const [run] = h.side.snapshots();
    h.runs[0].complete("after disconnect");
    assert.equal((await h.waitTerminal(run.id)).status, "completed");
    assert.equal((await storage.readSessionQuickAsks(h.file))[0].data.answer, "after disconnect");
    assert.equal(h.state.disposes, 1);
  } finally { await h.cleanup(); }
});

test("parallel topics and the main line survive stopping one side topic", async () => {
  const h = await quickAskFixture();
  try {
    h.state.mainRunning = true;
    const a = await h.start({ threadId: "a" });
    const b = await h.start({ threadId: "b" });
    assert.equal((await h.post({ question: "conflict", threadId: "a" })).status, 409);
    assert.equal(h.runs[0].options.signal.aborted, false);
    const stopped = await (await h.post({ action: "stop", runId: a.id })).json();
    assert.equal(stopped.run.status, "cancelled");
    assert.equal(h.runs[0].options.signal.aborted, true);
    assert.equal(h.runs[1].options.signal.aborted, false);
    assert.equal(h.state.mainRunning, true);
    assert.equal(h.state.aborts, 0);
    h.runs[0].complete("late stale output");
    h.runs[1].complete("surviving answer");
    await h.waitTerminal(b.id);
    assert.deepEqual((await storage.readSessionQuickAsks(h.file)).map((item) => item.data.answer), ["surviving answer"]);
  } finally { await h.cleanup(); }
});

test("the same admission ID is idempotent before and after completion, but never aliases a different payload", async () => {
  const h = await quickAskFixture();
  const body = { action: "start", requestId: "stable-id", threadId: "a", question: "stable", images: [image] };
  try {
    const first = await (await h.post(body)).json();
    await h.side.whenReady(first.run.id);
    assert.equal((await (await h.post(body)).json()).run.id, first.run.id);
    assert.equal(h.runs.length, 1);
    for (const difference of [{ question: "different" }, { images: [] }, { threadId: "b" }, { thinkingLevel: "high" }]) {
      assert.equal((await h.post({ ...body, ...difference })).status, 409);
    }
    h.runs[0].complete();
    await h.waitTerminal(first.run.id);
    assert.equal((await (await h.post(body)).json()).run.status, "completed");
    assert.equal(h.runs.length, 1);
    assert.equal((await h.request("DELETE", { threadId: "a" })).status, 200);
    assert.equal((await h.post(body)).status, 410);
    assert.equal(h.runs.length, 1, "deleted request identities cannot trigger another billed call");
  } finally { await h.cleanup(); }
});

test("cancelling during runtime creation does not leak a late runtime or reach its provider", async () => {
  const gate = deferred();
  const h = await quickAskFixture({ createRuntime: () => gate.promise });
  try {
    const admitted = await (await h.post({ action: "start", question: "preparing", threadId: "a" })).json();
    const ready = assert.rejects(h.side.whenReady(admitted.run.id), /已停止/);
    assert.equal((await h.post({ action: "stop", runId: admitted.run.id })).status, 200);
    gate.resolve({ getModel() { throw new Error("cancelled work cannot resolve a model"); } });
    await ready;
    await tick();
    assert.equal(h.state.creates, 1);
    assert.equal(h.state.disposes, 1);
    assert.equal(h.side.snapshot(admitted.run.id).status, "cancelled");
    assert.equal(h.state.aborts, 0);
  } finally { gate.resolve({}); await h.cleanup(); }
});

test("explicit stop during a context hook suppresses its late output and preserves the cancellation", async () => {
  const gate = deferred();
  const h = await quickAskFixture({ transform: async (messages) => { await gate.promise; return messages; } });
  try {
    const admitted = await (await h.post({ action: "start", question: "preparing", threadId: "a" })).json();
    await tick();
    await h.post({ action: "stop", runId: admitted.run.id });
    gate.resolve();
    await tick();
    assert.equal(h.runs.length, 0);
    assert.equal(h.state.disposes, 1);
    assert.equal(h.side.snapshot(admitted.run.id).status, "cancelled");
    assert.deepEqual(await storage.readSessionQuickAsks(h.file), []);
  } finally { gate.resolve(); await h.cleanup(); }
});

test("stopping preserves partial progress for a later cold terminal read", async () => {
  const h = await quickAskFixture();
  try {
    const admitted = await h.start();
    h.runs[0].emit("partial answer");
    h.runs[0].think("partial thought");
    await tick();
    const stop = await (await h.post({ action: "stop", runId: admitted.id })).json();
    h.state.visible = false;
    const cold = await (await h.get(`?runId=${admitted.id}`)).json();
    assert.equal(cold.run.status, "cancelled");
    assert.equal(cold.run.answer, "partial answer");
    assert.equal(cold.run.thinking, "partial thought");
    assert.equal(cold.run.revision, stop.run.revision);
    assert.deepEqual(await storage.readSessionQuickAsks(h.file), []);
  } finally { await h.cleanup(); }
});

test("an abort while awaiting route params cannot cancel or replace an admitted successor", async () => {
  const h = await quickAskFixture();
  try {
    const gate = deferred();
    const browser = new AbortController();
    const stale = h.post({ question: "stale", threadId: "a" }, { signal: browser.signal, params: gate.promise });
    const current = await h.start({ threadId: "b" });
    browser.abort();
    gate.resolve({ id: h.manager.getSessionId() });
    assert.equal((await stale).status, 499);
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].options.signal.aborted, false);
    h.runs[0].complete();
    await h.waitTerminal(current.id);
  } finally { await h.cleanup(); }
});
