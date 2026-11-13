import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { quickAskFixture, storage, tick } from "../test-support/quick-ask-fixture.mjs";
const decode = (chunk) => new TextDecoder().decode(chunk);
const event = (chunk) => JSON.parse(decode(chunk).trim().replace(/^data: /, ""));
const { createQuickAskEventStream } = await createJiti(import.meta.url).import("./quick-ask-event-stream.ts");

test("large immutable attachments are hydrated once, not copied into every progress snapshot", async () => {
  const h = await quickAskFixture();
  try {
    const image = { data: "A".repeat(900000), mimeType: "image/png" };
    const run = await h.start({ images: [image] });
    const response = await h.get(`?runId=${run.id}&stream=1`);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.ok(first.value.byteLength < 10000);
    assert.deepEqual(event(first.value).run.images, []);
    h.runs[0].complete("saved answer");
    await h.waitTerminal(run.id);
    const frames = [];
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      frames.push(event(chunk.value));
      assert.ok(chunk.value.byteLength < 10000);
    }
    const terminal = frames.find((frame) => frame.run?.status === "completed");
    assert.ok(terminal);
    assert.equal(terminal.run.entry.data.nativeEntries, undefined);
    assert.equal(terminal.run.entry.data.images, undefined);
    const [saved] = await storage.readSessionQuickAsks(h.file);
    assert.equal(saved.data.images[0].data.length, image.data.length);
    assert.equal(saved.data.nativeEntries.find((entry) => entry.message?.role === "user").message.content[1].data.length, image.data.length);
    const finalResponse = await h.get(`?runId=${run.id}&stream=1`);
    const finalText = await finalResponse.text();
    assert.ok(finalText.length < 10000, "cold terminal replay cannot loop on oversized binary payloads");
  } finally { await h.cleanup(); }
});

test("a stream reconnected during cancellation waits for the tool settlement", async () => {
  const stopping = { id: "r", threadId: "t", branchId: "main", status: "cancelled", settling: true,
    question: "q", images: [], answer: "", thinking: "", createdAt: 1, revision: 1 };
  let listener;
  const runtime = { snapshot: () => stopping, subscribe: (_id, fn) => { listener = fn; return () => {}; } };
  const reader = createQuickAskEventStream(new Request("http://reader.test"), stopping, runtime).getReader();
  assert.equal(event((await reader.read()).value).run.settling, true);
  const done = { ...stopping, settling: false, revision: 2 };
  listener({ type: "error", run: done, error: "stopped" });
  assert.equal(event((await reader.read()).value).run.status, "cancelled");
  assert.equal((await reader.read()).done, true);
});

test("a slow observer is disconnected at the backlog bound without stopping inference", async () => {
  const h = await quickAskFixture();
  try {
    const run = await h.start();
    const response = await h.get(`?runId=${run.id}&stream=1`);
    const reader = response.body.getReader();
    h.runs[0].emit("a".repeat(350000));
    h.runs[0].emit("b".repeat(350000));
    h.runs[0].emit("overflow");
    await tick();
    await assert.rejects(reader.read(), /backlog exceeded/);
    assert.equal(h.runs[0].options.signal.aborted, false);
    h.runs[0].complete("done");
    assert.equal((await h.waitTerminal(run.id)).status, "completed");
    assert.equal((await storage.readSessionQuickAsks(h.file)).length, 1);
  } finally { await h.cleanup(); }
});

test("a pre-aborted observer detaches immediately and cannot cancel the host's admitted task", async () => {
  const h = await quickAskFixture();
  try {
    const run = await h.start();
    const abort = new AbortController();
    abort.abort();
    const response = await h.request("GET", undefined, { query: `?runId=${run.id}&stream=1`, signal: abort.signal });
    assert.equal(await response.text(), "");
    assert.equal(h.runs[0].options.signal.aborted, false);
    h.runs[0].complete();
    assert.equal((await h.waitTerminal(run.id)).status, "completed");
  } finally { await h.cleanup(); }
});
