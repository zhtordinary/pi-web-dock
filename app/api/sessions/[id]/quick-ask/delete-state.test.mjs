import assert from "node:assert/strict";
import test from "node:test";
import { quickAskFixture, storage } from "../../../../../test-support/quick-ask-fixture.mjs";

async function fixture() {
  const h = await quickAskFixture();
  const add = (question, branchId, threadId = "default") => h.host.append("quick_ask", { question, answer: question, branchId, threadId, createdAt: Date.now() });
  return { ...h, entries: { main: add("main", undefined), feature: add("feature", "feature"), other: add("other", "main", "other") } };
}
const questions = async (h) => (await storage.readSessionQuickAsks(h.file)).map((entry) => entry.data.question);

test("DELETE writes one branch/thread tombstone through the live SDK owner", async () => {
  const h = await fixture();
  try {
    assert.equal((await h.request("DELETE", { threadId: "default", branchId: "feature" })).status, 200);
    assert.deepEqual(await questions(h), ["main", "other"]);
    assert.equal(h.manager.getEntry(h.manager.getLeafId()).customType, "quick_ask_thread_delete");
  } finally { await h.cleanup(); }
});

test("missing branch means main, not all branches with the same thread name", async () => {
  const h = await fixture();
  try {
    assert.equal((await h.request("DELETE", { threadId: "default" })).status, 200);
    assert.deepEqual(await questions(h), ["feature", "other"]);
  } finally { await h.cleanup(); }
});

test("invalid selectors and targets on another branch cannot append deletion records", async () => {
  const h = await fixture();
  try {
    const before = h.manager.getEntryCount();
    for (const body of [{}, { threadId: "default", targetId: h.entries.main.id }, { threadId: "default", branchId: {} }]) {
      assert.equal((await h.request("DELETE", body)).status, 400);
    }
    assert.equal((await h.request("DELETE", { targetId: h.entries.feature.id, branchId: "main" })).status, 404);
    assert.equal(h.manager.getEntryCount(), before);
  } finally { await h.cleanup(); }
});

test("deleting an older completed item does not implicitly stop the topic's current turn", async () => {
  const h = await quickAskFixture();
  try {
    const first = await h.start();
    h.runs[0].complete("old answer");
    const old = await h.waitTerminal(first.id);
    const current = await h.start({ question: "current question" });
    assert.equal((await h.request("DELETE", { targetId: old.entry.id })).status, 200);
    assert.equal(h.runs[1].options.signal.aborted, false);
    h.runs[1].complete("new answer");
    await h.waitTerminal(current.id);
    assert.deepEqual(await questions(h), ["current question"]);
  } finally { await h.cleanup(); }
});

test("deleting a whole running thread explicitly stops it and prevents late resurrection", async () => {
  const h = await quickAskFixture();
  try {
    const run = await h.start({ requestId: "deleted-run" });
    assert.equal((await h.request("DELETE", { threadId: "a" })).status, 200);
    assert.equal(h.runs[0].options.signal.aborted, true);
    h.runs[0].complete("late answer");
    assert.equal(h.side.snapshot(run.id), undefined);
    assert.deepEqual(await questions(h), []);
    assert.equal((await h.post({ action: "start", requestId: "deleted-run", question: "side question", threadId: "a" })).status, 410);
  } finally { await h.cleanup(); }
});
