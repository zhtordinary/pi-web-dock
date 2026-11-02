import assert from "node:assert/strict";
import test from "node:test";
import { flushSideAskPromotions, queueSideAskPromotion } from "./side-ask-promotion.ts";
import { quickAskFixture } from "../test-support/quick-ask-fixture.mjs";

function memory() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key) };
}

function promotions(h, browser) {
  return flushSideAskPromotions({ storage: browser, sessionId: h.host.sessionId,
    fetcher: async (_url, options) => h.post(JSON.parse(options.body)) });
}

test("a branch question admitted after promotion remains reachable", async () => {
  const h = await quickAskFixture(), browser = memory(), events = [];
  try {
    const expectedParentId = h.manager.getLeafId();
    const delayedRequest = { requestId: "late-admission", threadId: "a", branchId: "feature",
      question: "delayed question", expectedParentId };
    queueSideAskPromotion(browser, h.host.sessionId, "feature");
    events.push("promote");
    await promotions(h, browser);
    h.state.mainRunning = true;
    h.manager.appendMessage({ role: "user", content: "the branch became main", timestamp: 3 });
    events.push("admit");
    const run = await h.start(delayedRequest);
    h.runs.at(-1).complete("delayed answer");
    await h.waitTerminal(run.id);
    events.push("complete");
    await promotions(h, browser);
    const { items, promotedBranches } = await (await h.get()).json();
    assert.deepEqual(events, ["promote", "admit", "complete"]);
    assert.equal(items.length, 1, "the late question was persisted");
    assert.equal(items[0].data.answer, "delayed answer");
    assert.ok(items[0].data.branchId === "main" || promotedBranches.includes(items[0].data.branchId),
      "the finished answer must be reachable after the branch tab disappears");
    h.state.visible = false;
    const cold = await (await h.get()).json();
    assert.ok(cold.promotedBranches.includes("feature"), "the recovery entry survives a cold read");
    assert.equal(cold.items[0].data.answer, "delayed answer");
  } finally { await h.cleanup(); }
});

test("promotion cannot delete a failed question in a topic with an earlier completed answer", async () => {
  const h = await quickAskFixture();
  try {
    const finished = await h.start({ threadId: "a", branchId: "feature", question: "earlier" });
    h.runs.at(-1).complete("earlier answer");
    await h.waitTerminal(finished.id);
    const failed = await h.start({ requestId: "failed-after-answer", threadId: "a", branchId: "feature", question: "recover me" });
    h.runs.at(-1).fail("synthetic provider failure");
    await h.waitTerminal(failed.id);
    const before = await (await h.get()).json();
    assert.equal(before.runs.find((run) => run.id === failed.id)?.status, "failed");
    const response = await h.post({ action: "promote_branch", fromBranchId: "feature" });
    const after = await (await h.get()).json();
    assert.equal(response.status, 409, "a retained failed turn prevents destructive topic migration");
    assert.equal(after.runs.find((run) => run.id === failed.id)?.question, "recover me");
    assert.equal(after.items[0].data.answer, "earlier answer");
    assert.ok(after.promotedBranches.includes("feature"));
  } finally { await h.cleanup(); }
});

test("a newer completed question cannot erase an older failed request during promotion", async () => {
  const h = await quickAskFixture();
  try {
    const failed = await h.start({ requestId: "older-failed", threadId: "a", branchId: "feature", question: "retain me" });
    h.runs.at(-1).fail("synthetic provider failure");
    await h.waitTerminal(failed.id);
    const finished = await h.start({ requestId: "newer-completed", threadId: "a", branchId: "feature", question: "another request" });
    h.runs.at(-1).complete("another answer");
    await h.waitTerminal(finished.id);
    assert.equal((await h.get(`?runId=${failed.id}`)).status, 200);
    const response = await h.post({ action: "promote_branch", fromBranchId: "feature" });
    assert.equal(response.status, 409, "an older failed identity must not be erased by a later success");
    assert.equal((await h.get(`?runId=${failed.id}`)).status, 200);
    const view = await (await h.get()).json();
    assert.equal(view.items[0].data.answer, "another answer");
    assert.ok(view.runs.some((run) => run.id === failed.id), "an older retained failure is included in the recovery view");
    h.state.visible = false;
    const cold = await (await h.get()).json();
    assert.ok(cold.runs.some((run) => run.id === failed.id), "cold reads also include the older failure");
  } finally { await h.cleanup(); }
});

test("a failed branch question remains recoverable after promotion", async () => {
  const h = await quickAskFixture(), browser = memory();
  try {
    const run = await h.start({ requestId: "failed-question", threadId: "a", branchId: "feature",
      question: "question to recover", images: [{ data: "AAAA", mimeType: "image/png" }] });
    h.runs.at(-1).fail("synthetic provider failure");
    await h.waitTerminal(run.id);
    const before = await (await h.get()).json();
    assert.equal(before.runs.find((item) => item.id === run.id)?.status, "failed");
    queueSideAskPromotion(browser, h.host.sessionId, "feature");
    await promotions(h, browser);
    const after = await (await h.get()).json();
    const recoverable = after.runs.find((item) => item.id === run.id);
    assert.ok(recoverable, "the failed request must remain in the public run list");
    assert.equal(recoverable.question, "question to recover");
    assert.ok(recoverable.branchId === "main" || after.promotedBranches.includes(recoverable.branchId),
      "the recovery action must remain reachable after the source tab disappears");
    h.state.visible = false;
    const cold = await (await h.get()).json();
    assert.ok(cold.promotedBranches.includes("feature"));
    assert.equal(cold.runs.find((item) => item.id === run.id)?.question, "question to recover");
  } finally { await h.cleanup(); }
});
