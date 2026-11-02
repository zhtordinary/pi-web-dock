import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rmdir, stat } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { quickAskFixture, log, storage, image, assistant, model } from "../test-support/quick-ask-fixture.mjs";

const dump = (manager) => JSON.stringify(manager.buildSessionContext());

test("compaction, context edits, model/thinking changes and native Provider fields replay identically after materialization", async () => {
  const h = await quickAskFixture();
  try {
    h.manager.appendMessage(assistant("summarized old answer"));
    const kept = h.manager.appendMessage({ role: "user", content: "kept original", timestamp: 4 });
    const compact = h.manager.appendCompaction("fixed checkpoint", kept, 1000, { synthetic: true });
    h.manager.appendContextEdit(kept, { content: [{ type: "text", text: "edited kept" }, { type: "image", ...image }] });
    const run = await h.start({ threadId: "replay", model: { provider: "fixture", id: "alternative" }, thinkingLevel: "high", images: [image] });
    h.runs[0].think("native thinking");
    h.runs[0].complete("native text", { responseId: "synthetic-response" });
    await h.waitTerminal(run.id);
    const scope = { threadId: "replay", branchId: "main" };
    const branch = log.findQuickAskBranch(h.manager.getEntries(), scope);
    const replay = log.quickAskBranchManager(h.manager, branch, undefined, true);
    assert.equal(replay.buildSessionContext().model.modelId, "alternative");
    assert.equal(replay.buildSessionContext().thinkingLevel, "high");
    assert.match(dump(replay), /fixed checkpoint|edited kept|native thinking|synthetic-response/);
    assert.match(dump(replay), /Stable synthetic instructions/, "the captured source system must survive a checkpoint without its own system message");
    assert.doesNotMatch(dump(replay), /summarized old answer|kept original/);
    h.manager.appendCompaction("new main checkpoint", null, 2000);
    assert.doesNotMatch(dump(log.quickAskBranchManager(h.manager, branch)), /new main checkpoint/);
    const result = log.materializeQuickAskBranch(h.manager, branch);
    const opened = SessionManager.open(result.newSessionPath);
    assert.deepEqual(opened.buildSessionContext(), replay.buildSessionContext());
    assert.equal(opened.getEntry(compact).firstKeptEntryId, kept);
    assert.equal(opened.getHeader().parentSession, h.file);
    assert.equal(h.runs.length, 1);
  } finally { await h.cleanup(); }
});

test("a logical branch does not copy unrelated Side Ask payloads from its source metadata chain", async () => {
  const h = await quickAskFixture();
  try {
    const other = await h.start({ threadId: "other", question: "unrelated-private-side-question", images: [image] });
    h.runs[0].complete("unrelated-private-side-answer");
    await h.waitTerminal(other.id);
    const run = await h.start({ threadId: "selected" });
    h.runs[1].complete("selected answer");
    await h.waitTerminal(run.id);
    const branch = log.findQuickAskBranch(h.manager.getEntries(), { threadId: "selected", branchId: "main" });
    const result = log.materializeQuickAskBranch(h.manager, branch);
    assert.doesNotMatch(await readFile(result.newSessionPath, "utf8"), /unrelated-private-side-question|unrelated-private-side-answer/);
    assert.match(await readFile(result.newSessionPath, "utf8"), /reader.fork_source/);
  } finally { await h.cleanup(); }
});

test("old flat records freeze their first known anchor and retain only recoverable content", async () => {
  const h = await quickAskFixture();
  try {
    const first = h.host.append("quick_ask", { question: "old first", answer: "old answer", thinking: "old thought", images: [image], threadId: "old", createdAt: 1 });
    h.manager.appendMessage({ role: "user", content: "later main not inherited", timestamp: 2 });
    h.host.append("quick_ask", { question: "old second", answer: "second answer", threadId: "old", createdAt: 3 });
    const branch = log.createQuickAskBranch(h.manager.getEntries(), { threadId: "old", branchId: "main" }, h.manager.getLeafId());
    assert.equal(branch.contextAnchorId, first.parentId);
    const result = log.materializeQuickAskBranch(h.manager, branch);
    const contents = dump(SessionManager.open(result.newSessionPath));
    assert.match(contents, /old first|old second|old thought|image\/png/);
    assert.doesNotMatch(contents, /later main not inherited/);
    assert.throws(() => log.createQuickAskBranch([{ type: "custom", customType: "quick_ask", id: "missing-anchor", timestamp: "2026-01-01", data: { question: "old", answer: "old", createdAt: 1 } }],
      { threadId: "default", branchId: "main" }, null), /anchor is unavailable/);
  } finally { await h.cleanup(); }
});

test("the first metadata-only persistence keeps the exact active SDK leaf and future main appends", async () => {
  const h = await quickAskFixture({ empty: true });
  try {
    assert.equal(existsSync(h.file), false);
    const intended = h.manager.getEntries()[0].id;
    h.manager.appendCustomEntry("unselected-setup", { synthetic: true });
    h.manager.branch(intended);
    h.persistence.persistSessionFileNow(true);
    assert.equal(h.manager.getLeafId(), intended);
    assert.equal((await stat(h.file)).mode & 0o777, 0o600);
    const side = h.host.append("quick_ask", { question: "durable work", answer: "saved", createdAt: 1 });
    assert.equal(side.parentId, intended);
    const user = h.manager.appendMessage({ role: "user", content: "main still works", timestamp: 3 });
    const reopened = SessionManager.open(h.file);
    assert.equal(reopened.getEntry(user).message.content, "main still works");
    assert.equal(reopened.getEntry(side.id).customType, "quick_ask");
  } finally { await h.cleanup(); }
});

test("serialization errors stay isolated from main persistence", async () => {
  const h = await quickAskFixture();
  try {
    const cycle = {}; cycle.self = cycle;
    const leaf = h.manager.getLeafId();
    assert.throws(() => h.host.append("quick_ask", cycle), /circular/i);
    assert.equal(h.manager.getLeafId(), leaf);
    assert.equal(h.state.closed, false);
    assert.equal(h.state.aborts, 0);
    h.host.append("quick_ask", { question: "valid", answer: "valid", createdAt: 1 });
    assert.equal((await storage.readSessionQuickAsks(h.file)).length, 1);
  } finally { await h.cleanup(); }
});

test("a real SDK disk append failure quarantines its unconfirmed in-memory index", async () => {
  const h = await quickAskFixture();
  const saved = `${h.file}.saved`;
  try {
    await rename(h.file, saved);
    await mkdir(h.file);
    assert.throws(() => h.host.append("quick_ask", { question: "cannot save", answer: "must not claim success", createdAt: 1 }), /EISDIR|directory/i);
    assert.equal(h.state.closed, true);
    assert.equal(h.state.aborts, 1);
    assert.throws(() => h.host.append("quick_ask", {}), /closed/);
    await rmdir(h.file);
    await rename(saved, h.file);
    const reopened = SessionManager.open(h.file);
    assert.equal(storage.projectSessionQuickAsks(reopened.getEntries()).length, 0);
    reopened.appendMessage({ role: "user", content: "recovered from confirmed disk state", timestamp: 5 });
    assert.match(dump(SessionManager.open(h.file)), /recovered from confirmed disk state/);
  } finally { await h.cleanup(); }
});

const toolCall = (id) => ({ type: "toolCall", id, name: "fixture-tool", arguments: {} });
const toolResult = (id, text) => ({ role: "toolResult", toolCallId: id, toolName: "fixture-tool", content: [{ type: "text", text }], isError: false, timestamp: Date.now() });

test("a topic anchored mid tool call tells the model the unreturned calls are still running, in requests only", async () => {
  const h = await quickAskFixture();
  try {
    h.manager.appendMessage(assistant("", model, { content: [toolCall("call-done"), toolCall("call-running")], stopReason: "toolUse" }));
    h.manager.appendMessage(toolResult("call-done", "real result"));
    const first = await h.start({ threadId: "mid", question: "what is it doing?" });
    const sent = h.runs[0].transcript.messages;
    const results = sent.filter((message) => message.role === "toolResult");
    assert.deepEqual(results.map((message) => [message.toolCallId, message.isError]), [["call-done", false], ["call-running", false]]);
    assert.equal(results[0].content[0].text, "real result");
    assert.equal(results[1].content[0].text, log.QUICK_ASK_PENDING_TOOL_RESULT);
    assert.equal(sent.at(-1).role, "user", "the results sit before the side question");
    assert.ok(sent.indexOf(results[1]) < sent.length - 1);
    h.runs[0].complete("it is running the tool");
    await h.waitTerminal(first.id);
    // The frozen anchor keeps the note for later questions of the topic, once.
    await h.start({ threadId: "mid", question: "and now?" });
    const again = h.runs[1].transcript.messages.filter((message) => message.role === "toolResult");
    assert.deepEqual(again.map((message) => message.toolCallId), ["call-done", "call-running"]);
    // Nothing synthetic is persisted or replayed into a fork.
    const branch = log.findQuickAskBranch(h.manager.getEntries(), { threadId: "mid", branchId: "main" });
    assert.doesNotMatch(JSON.stringify(h.manager.getEntries()), /仍在执行/);
    assert.doesNotMatch(JSON.stringify(log.quickAskBranchManager(h.manager, branch, undefined, true).buildSessionContext()), /仍在执行/);
  } finally { await h.cleanup(); }
});

test("a tool call abandoned behind a newer user message is not described as running", async () => {
  const h = await quickAskFixture();
  try {
    h.manager.appendMessage(assistant("", model, { content: [toolCall("call-abandoned")], stopReason: "toolUse" }));
    h.manager.appendMessage({ role: "user", content: "next question", timestamp: Date.now() });
    await h.start({ threadId: "abandoned", question: "side" });
    assert.equal(h.runs[0].transcript.messages.some((message) => message.role === "toolResult"), false);
    // A finished turn has no pending call either.
    const done = await quickAskFixture();
    try {
      done.manager.appendMessage(assistant("", model, { content: [toolCall("call-1")], stopReason: "toolUse" }));
      done.manager.appendMessage(toolResult("call-1", "ok"));
      done.manager.appendMessage(assistant("finished"));
      await done.start({ threadId: "finished", question: "side" });
      assert.deepEqual(done.runs[0].transcript.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId), ["call-1"]);
    } finally { await done.cleanup(); }
  } finally { await h.cleanup(); }
});

const anchorFields = new Set(["branchId", "contextAnchorId", "createdAt", "id", "sourceSystem", "threadId", "version", "rebasedFromAnchorId"]);
const branchRecords = async (h) => (await readFile(h.file, "utf8")).trim().split("\n").map(JSON.parse).filter((row) => row.customType === "quick_ask_branch");
const bigImage = { data: "QUJD".repeat(500), mimeType: "image/png" };

test("a topic anchor record keeps only its anchor fields, not the submission that created it", async () => {
  const h = await quickAskFixture();
  try {
    const admitted = await h.start({ threadId: "anchor", question: "first question", images: [bigImage], threadTitle: "话题 1",
      requestId: "request-1", model: { provider: "fixture", id: "alternative" }, thinkingLevel: "high" });
    h.runs[0].complete("answer");
    await h.waitTerminal(admitted.id);
    const assertAnchorOnly = (data) => {
      assert.deepEqual(Object.keys(data).filter((key) => !anchorFields.has(key)), []);
      for (const key of ["version", "id", "threadId", "branchId", "contextAnchorId", "createdAt"]) assert.ok(key in data, key);
    };
    const [created] = await branchRecords(h);
    assertAnchorOnly(created.data);
    assert.equal((await readFile(h.file, "utf8")).split(bigImage.data).length - 1, 1, "the attachment is stored once, in the admitted message");
    // A main-line checkpoint moves the topic: the new anchor record is just as small.
    h.manager.appendCompaction("moved checkpoint", null, 5000);
    await h.start({ threadId: "anchor", question: "after the move" });
    const records = await branchRecords(h);
    assert.equal(records.length, 2);
    assertAnchorOnly(records[1].data);
    assert.ok("rebasedFromAnchorId" in records[1].data);
  } finally { await h.cleanup(); }
});

test("an anchor record written by an earlier version reads back as its anchor fields only", () => {
  const stamp = "2026-01-01T00:00:00.000Z";
  const legacy = { type: "custom", id: "b1", parentId: null, timestamp: stamp, customType: "quick_ask_branch", data: {
    version: 1, id: "branch-1", threadId: "t", branchId: "main", contextAnchorId: "anchor-1", createdAt: 1,
    question: "old submission", images: [image], requestId: "r", model: { provider: "p", id: "m" }, thinkingLevel: "high", threadTitle: "话题 1", expectedParentId: "x" } };
  const branch = log.findQuickAskBranch([legacy], { threadId: "t", branchId: "main" });
  assert.deepEqual(branch, { version: 1, id: "branch-1", threadId: "t", branchId: "main", contextAnchorId: "anchor-1", createdAt: 1 });
});
