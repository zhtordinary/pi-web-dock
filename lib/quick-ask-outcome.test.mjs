import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { quickAskFixture, storage, log, image, tick, usage } from "../test-support/quick-ask-fixture.mjs";

const outcomes = (h) => h.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "quick_ask_outcome");

test("provider failures retain their native assistant result and known usage without creating an empty successful reply", async () => {
  const h = await quickAskFixture();
  try {
    const run = await h.start({ images: [image] });
    h.runs[0].fail("native provider failure");
    assert.equal((await h.waitTerminal(run.id)).status, "failed");
    await tick();
    assert.deepEqual(await storage.readSessionQuickAsks(h.file), []);
    const [outcome] = outcomes(h);
    assert.equal(outcomes(h).length, 1);
    assert.equal(outcome.data.runId, run.id);
    assert.equal(outcome.data.nativeEntries[0].message.stopReason, "error");
    assert.equal(outcome.data.nativeEntries[0].message.errorMessage, "native provider failure");
    assert.deepEqual(outcome.data.usage, usage);
    assert.equal(outcome.data.usageEvent.relation, "origin");
    assert.equal(h.state.aborts, 0);
  } finally { await h.cleanup(); }
});

test("a late cancelled SDK result records usage but cannot resurrect a deleted topic", async () => {
  const h = await quickAskFixture();
  try {
    const run = await h.start({ requestId: "cancelled-and-deleted" });
    h.runs[0].emit("partial");
    await tick();
    assert.equal((await h.request("DELETE", { threadId: "a" })).status, 200);
    await tick();
    assert.equal(h.side.snapshot(run.id), undefined);
    assert.deepEqual(await storage.readSessionQuickAsks(h.file), []);
    const [outcome] = outcomes(h);
    assert.equal(outcomes(h).length, 1);
    assert.equal(outcome.data.nativeEntries[0].message.stopReason, "aborted");
    assert.equal(outcome.data.usageEvent.relation, "origin");
    assert.equal((await h.post({ action: "start", requestId: run.id, question: "side question", threadId: "a" })).status, 410);
  } finally { await h.cleanup(); }
});

test("fork waits for a cancelled native result before materializing", async () => {
  const h = await quickAskFixture({ deferAbort: true });
  try {
    const completed = await h.start();
    h.runs[0].complete("prior committed answer");
    await h.waitTerminal(completed.id);
    const run = await h.start({ question: "cancel this second request" });
    assert.equal(h.side.stop(run.id)?.status, "cancelled");
    const result = await h.side.fork({ threadId: "a", branchId: "main" });
    const opened = SessionManager.open(result.newSessionPath);
    const saved = opened.getEntries().find((entry) => entry.customType === "reader.side_ask_outcome");
    assert.equal(saved.data.state.status, "cancelled");
    assert.equal(saved.data.nativeEntries.at(-1).message.stopReason, "aborted");
  } finally { await h.cleanup(); }
});

test("materialization preserves failed native records as non-model metadata and respects an earlier fork point", async () => {
  const h = await quickAskFixture();
  try {
    const first = await h.start();
    h.runs[0].complete("committed answer");
    const completed = await h.waitTerminal(first.id);
    const failed = await h.start({ question: "failed question", images: [image] });
    h.runs[1].fail("failed native outcome");
    await h.waitTerminal(failed.id);
    const branch = log.findQuickAskBranch(h.manager.getEntries(), { threadId: "a", branchId: "main" });
    const source = log.quickAskBranchManager(h.manager, branch).buildSessionContext();
    const earlier = log.materializeQuickAskBranch(h.manager, branch, [completed.entry], completed.entry.id);
    assert.equal(SessionManager.open(earlier.newSessionPath).getEntries().some((entry) => entry.customType === "reader.side_ask_outcome"), false);
    const result = log.materializeQuickAskBranch(h.manager, branch);
    const opened = SessionManager.open(result.newSessionPath);
    const copiedContext = opened.buildSessionContext();
    const withoutUsage = context => ({ ...context, messages: context.messages.map(message => {
      const { usageEvent, ...content } = message;
      return content;
    }) });
    assert.deepEqual(withoutUsage(copiedContext), withoutUsage(source));
    for (let index = 0; index < source.messages.length; index++) {
      const original = source.messages[index].usageEvent;
      if (!original) continue;
      const copied = copiedContext.messages[index].usageEvent;
      assert.equal(copied.id, original.id);
      assert.equal(copied.relation, "copy");
      assert.equal(copied.sourceSessionId, h.manager.getSessionId());
      assert.equal(typeof copied.sourceEntryId, "string");
      assert.equal(original.relation, "origin");
    }
    assert.doesNotMatch(JSON.stringify(source.messages), /failed question|failed native outcome/);
    const saved = opened.getEntries().find((entry) => entry.customType === "reader.side_ask_outcome");
    assert.equal(saved.data.state.status, "failed");
    assert.equal(saved.data.nativeEntries.find((entry) => entry.message?.role === "user").message.content[1].mimeType, "image/png");
    assert.equal(saved.data.nativeEntries.at(-1).message.errorMessage, "failed native outcome");
    assert.equal(saved.data.usageEvent.id, outcomes(h)[0].data.usageEvent.id);
    assert.equal(saved.data.usageEvent.relation, "copy");
    assert.equal(h.runs.length, 2, "copying outcomes must not invoke a model");
  } finally { await h.cleanup(); }
});

test("actual model attribution does not overwrite the branch's requested model intent", async () => {
  const h = await quickAskFixture();
  try {
    const first = await h.start({ model: { provider: "fixture", id: "virtual-intent" } });
    h.runs[0].complete("routed answer", { provider: "routed-fixture", model: "actual-wire-model" });
    const done = await h.waitTerminal(first.id);
    assert.equal(done.entry.provider, "routed-fixture");
    assert.equal(done.entry.model, "actual-wire-model");
    assert.equal(done.entry.data.nativeEntries.at(-1).type, "model_change");
    assert.equal(done.entry.data.nativeEntries.at(-1).modelId, "virtual-intent");
    const followUp = await h.start({ question: "keep requested model" });
    assert.equal(h.runs[1].model.id, "virtual-intent");
    assert.equal(h.runs[1].model.provider, "fixture");
    h.runs[1].complete();
    await h.waitTerminal(followUp.id);
  } finally { await h.cleanup(); }
});

test("a provider tool request is retained as a failure and cannot start a Side Ask tool loop", async () => {
  const h = await quickAskFixture();
  try {
    const run = await h.start();
    h.runs[0].complete("", { stopReason: "toolUse", content: [{ type: "toolCall", id: "unexpected", name: "fixture-tool", arguments: {} }] });
    const stopped = await h.waitTerminal(run.id);
    assert.equal(stopped.status, "failed");
    assert.equal(stopped.errorStatus, 502);
    assert.equal(h.runs[0].options.toolChoice, "none");
    assert.equal(h.runs.length, 1);
    assert.deepEqual(await storage.readSessionQuickAsks(h.file), []);
    assert.equal(outcomes(h)[0].data.nativeEntries[0].message.content[0].type, "toolCall");
    assert.equal(h.state.aborts, 0);
  } finally { await h.cleanup(); }
});

test("a changed source SDK identity cannot receive a late side result belonging to the old source", async () => {
  const h = await quickAskFixture();
  try {
    const run = await h.start();
    const terminal = h.waitTerminal(run.id);
    const original = await readFile(h.file, "utf8");
    const successor = SessionManager.create(h.root, h.root);
    successor.appendMessage({ role: "user", content: "new main source", timestamp: 10 });
    const file = successor.getSessionFile();
    const next = await readFile(file, "utf8");
    h.manager.setSessionFile(file);
    h.runs[0].complete("late old source answer");
    assert.equal((await terminal).status, "failed");
    assert.equal(await readFile(h.file, "utf8"), original);
    assert.equal(await readFile(file, "utf8"), next);
    assert.equal(h.state.aborts, 0);
    assert.equal(h.owner.isAlive(), true);
  } finally { await h.cleanup(); }
});


test("cancelled-only branch cannot materialize a completed conversation but retains its native audit outcome", async () => {
  const h = await quickAskFixture({ deferAbort: true });
  try {
    const run = await h.start();
    h.side.stop(run.id);
    await assert.rejects(h.side.fork({ threadId: "a", branchId: "main" }), { status: 400 });
    const [outcome] = outcomes(h);
    assert.equal(outcome.data.nativeEntries.at(-1).message.stopReason, "aborted");
    assert.equal((await storage.readSessionQuickAsks(h.file)).length, 0);
  } finally { await h.cleanup(); }
});
