import assert from "node:assert/strict";
import test from "node:test";
import { quickAskFixture, storage } from "../test-support/quick-ask-fixture.mjs";

const texts = (messages) => JSON.stringify(messages.map((message) => message.content));
async function completed(h, body = {}, answer = "answer") {
  const run = await h.start(body);
  h.runs.at(-1).complete(answer);
  return h.waitTerminal(run.id);
}
const promote = (h, fromBranchId) => h.post({ action: "promote_branch", fromBranchId });
const summary = async (h) => (await storage.readSessionQuickAsks(h.file))
  .map((item) => [item.data.branchId, item.data.threadId, item.data.answer]).sort();

/** One topic on main and one on a branch, both numbered "a", fixed at different points of the conversation. */
async function collidingTopics(h) {
  await completed(h, { threadId: "a", branchId: "main", question: "main question" }, "main answer");
  h.manager.appendMessage({ role: "user", content: "the conversation moved on", timestamp: 3 });
  await completed(h, { threadId: "a", branchId: "feature", question: "branch question" }, "branch answer");
  const items = await storage.readSessionQuickAsks(h.file);
  const anchorOf = (branchId) => items.find((item) => item.data.branchId === branchId).data.contextAnchorId;
  assert.notEqual(anchorOf("main"), anchorOf("feature"), "the two topics must have different fixed origins");
  return { mainAnchor: anchorOf("main"), branchAnchor: anchorOf("feature") };
}

test("a branch moving to main keeps a same-numbered topic with another fixed origin apart, each with its own context", async () => {
  const h = await quickAskFixture();
  try {
    const { mainAnchor, branchAnchor } = await collidingTopics(h);
    const response = await promote(h, "feature");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).promotedCount, 1);
    assert.deepEqual(await summary(h), [["main", "a", "main answer"], ["main", "a@feature", "branch answer"]]);
    const moved = (await storage.readSessionQuickAsks(h.file)).find((item) => item.data.threadId === "a@feature");
    assert.equal(moved.data.contextAnchorId, branchAnchor, "the moved topic keeps its own fixed origin");
    assert.notEqual(moved.data.contextAnchorId, mainAnchor);

    await completed(h, { threadId: "a@feature", branchId: "main", question: "follow up on the branch" });
    assert.match(texts(h.runs.at(-1).transcript.messages), /branch answer/);
    assert.doesNotMatch(texts(h.runs.at(-1).transcript.messages), /main answer/);
    await completed(h, { threadId: "a", branchId: "main", question: "follow up on main" });
    assert.match(texts(h.runs.at(-1).transcript.messages), /main answer/);
    assert.doesNotMatch(texts(h.runs.at(-1).transcript.messages), /branch answer/);
  } finally { await h.cleanup(); }
});

test("moving the same branch again is a no-op, so a lost answer can simply be asked again", async () => {
  const h = await quickAskFixture();
  try {
    await collidingTopics(h);
    assert.equal((await (await promote(h, "feature")).json()).promotedCount, 1);
    const before = h.manager.getEntryCount();
    const again = await promote(h, "feature");
    assert.equal(again.status, 200);
    assert.equal((await again.json()).promotedCount, 0);
    assert.equal(h.manager.getEntryCount(), before);
    assert.equal((await storage.readSessionQuickAsks(h.file)).length, 2);
  } finally { await h.cleanup(); }
});

test("a move interrupted before the source is removed resumes without copying anything twice", async () => {
  const h = await quickAskFixture();
  const append = h.host.append;
  try {
    await collidingTopics(h);
    let fail = true;
    h.host.append = (type, data) => {
      if (fail && type === "quick_ask_thread_delete") throw new Error("synthetic append failure");
      return append(type, data);
    };
    assert.equal((await promote(h, "feature")).status, 500);
    fail = false;
    const resumed = await promote(h, "feature");
    assert.equal(resumed.status, 200);
    assert.deepEqual(await summary(h), [["main", "a", "main answer"], ["main", "a@feature", "branch answer"]]);
  } finally { h.host.append = append; await h.cleanup(); }
});

test("a topic that is still answering blocks the move and records the recoverable branch", async () => {
  const h = await quickAskFixture();
  try {
    await collidingTopics(h);
    const running = await h.start({ threadId: "a", branchId: "feature", question: "still answering" });
    const before = h.manager.getEntryCount();
    const refused = await promote(h, "feature");
    assert.equal(refused.status, 409);
    assert.equal(h.manager.getEntryCount(), before + 1);
    assert.equal(h.manager.getEntries().at(-1).customType, "quick_ask_promoted_branch");
    h.runs.at(-1).complete("late answer");
    await h.waitTerminal(running.id);
    assert.equal((await promote(h, "feature")).status, 200);
    assert.deepEqual((await summary(h)).map(([, thread]) => thread), ["a", "a@feature", "a@feature"]);
  } finally { await h.cleanup(); }
});

for (const completedSibling of [false, true]) {
  test(`a first in-flight question blocks moving its branch (completed sibling: ${completedSibling})`, async () => {
    const h = await quickAskFixture();
    try {
      if (completedSibling) await completed(h, { threadId: "a", branchId: "feature", question: "finished question" }, "finished answer");
      const running = await h.start({ threadId: "b", branchId: "feature", question: "first question" });
      const before = h.manager.getEntryCount();
      assert.equal((await promote(h, "feature")).status, 409);
      assert.equal(h.manager.getEntryCount(), before + 1, "only the durable recovery marker is written");
      assert.equal(h.manager.getEntries().at(-1).customType, "quick_ask_promoted_branch");
      h.runs.at(-1).complete("late answer");
      await h.waitTerminal(running.id);
      const moved = await promote(h, "feature");
      assert.equal(moved.status, 200);
      assert.equal((await moved.json()).promotedCount, completedSibling ? 2 : 1);
      assert.deepEqual(await summary(h), completedSibling
        ? [["main", "a", "finished answer"], ["main", "b", "late answer"]]
        : [["main", "b", "late answer"]]);
    } finally { await h.cleanup(); }
  });
}

test("an active question on another branch does not block moving completed topics", async () => {
  const h = await quickAskFixture();
  try {
    await completed(h, { threadId: "a", branchId: "feature" }, "finished answer");
    const running = await h.start({ threadId: "b", branchId: "other", question: "unrelated question" });
    const response = await promote(h, "feature");
    assert.equal(response.status, 200);
    assert.deepEqual(await summary(h), [["main", "a", "finished answer"]]);
    h.runs.at(-1).complete("unrelated answer");
    await h.waitTerminal(running.id);
  } finally { await h.cleanup(); }
});

test("sending the same request again returns the admitted turn without a second model call", async () => {
  const h = await quickAskFixture();
  try {
    const leaf = h.manager.getLeafId();
    const body = { action: "start", requestId: "same-request", threadId: "a", branchId: "main", question: "once only", expectedParentId: leaf };
    const first = await h.post(body);
    assert.equal(first.status, 202);
    await h.side.whenReady("same-request");
    h.manager.appendMessage({ role: "user", content: "the conversation moved on", timestamp: 3 });
    const again = await h.post(body);
    assert.equal(again.status, 202, "the repeat is answered from the admission, not judged against the moved conversation");
    assert.equal((await again.json()).run.id, "same-request");
    assert.equal(h.runs.length, 1);
    h.runs[0].complete("done");
    await h.waitTerminal("same-request");
    const afterCompletion = await h.post(body);
    assert.equal(afterCompletion.status, 202);
    assert.equal((await afterCompletion.json()).run.status, "completed");
    assert.equal(h.runs.length, 1);
  } finally { await h.cleanup(); }
});
