import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { quickAskFixture, storage, log, context, model, image, deferred, tick } from "../../../../../test-support/quick-ask-fixture.mjs";

const texts = (messages) => JSON.stringify(messages.map((message) => message.content));
async function finish(h, admitted, text = "side answer") {
  h.runs.at(-1).complete(text);
  return h.waitTerminal(admitted.id);
}

test("JSON admission, independent observers and cold reads never duplicate inference", async () => {
  const h = await quickAskFixture();
  try {
    const run = await h.start({ requestId: "request-one", images: [image] });
    const events = await h.get(`?runId=${run.id}&stream=1`);
    const reader = events.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /snapshot/);
    await reader.cancel();
    assert.equal(h.runs[0].options.signal.aborted, false);
    h.runs[0].emit("first ");
    await tick();
    assert.equal((await (await h.get(`?runId=${run.id}`)).json()).run.answer, "first ");
    const ended = await finish(h, run, "second");
    assert.equal(ended.answer, "first second");
    const replay = await (await h.get(`?runId=${run.id}&stream=1`)).text();
    const replayed = JSON.parse(replay.trim().replace(/^data: /, ""));
    assert.equal(replayed.run.status, "completed");
    assert.equal(replayed.run.entry.id, ended.entry.id);
    assert.equal(h.runs.length, 1);
    h.state.visible = false;
    const cold = await (await h.get()).json();
    assert.equal(cold.items.length, 1);
    assert.equal(cold.runs[0].status, "completed");
    assert.equal(cold.runs[0].revision, ended.revision);
    assert.equal(h.state.starts, 0);
    assert.equal(h.state.creates, 1);
  } finally { await h.cleanup(); }
});

test("a fixed topic keeps its ancestor while a new topic captures the latest main line", async () => {
  const h = await quickAskFixture();
  try {
    const anchor = h.manager.getLeafId();
    const first = await h.start({ threadId: "fixed", expectedParentId: anchor, history: [{ question: "forged", answer: "forged" }] });
    h.manager.appendMessage({ role: "user", content: "main progressed after admission", timestamp: 3 });
    await finish(h, first, "original side answer");
    const firstEntry = (await storage.readSessionQuickAsks(h.file))[0];
    assert.equal(firstEntry.data.contextAnchorId, anchor);
    assert.ok(h.manager.getEntry(firstEntry.id), "the real owner must index its custom append");
    assert.equal(h.manager.getLeafId(), firstEntry.id, "metadata advances only the physical owner leaf");
    const again = await h.start({ threadId: "fixed", question: "follow up", expectedParentId: anchor });
    assert.doesNotMatch(texts(h.runs.at(-1).transcript.messages), /main progressed|forged/);
    assert.match(texts(h.runs.at(-1).transcript.messages), /original side answer/);
    await finish(h, again);
    const latest = await h.start({ threadId: "latest" });
    assert.match(texts(h.runs.at(-1).transcript.messages), /main progressed after admission/);
    assert.doesNotMatch(texts(h.runs.at(-1).transcript.messages), /original side answer/);
    await finish(h, latest);
    assert.doesNotMatch(texts(h.manager.buildSessionContext().messages), /side answer|follow up/);
    assert.equal((await h.post({ question: "stale", threadId: "new-stale", expectedParentId: anchor })).status, 409);
    h.state.mainRunning = true;
    const concurrent = await h.start({ threadId: "concurrent", expectedParentId: anchor });
    await finish(h, concurrent);
  } finally { await h.cleanup(); }
});

test("a fixed topic continues from the latest main checkpoint after its anchor", async () => {
  const h = await quickAskFixture();
  try {
    const scope = { threadId: "fixed", branchId: "main" };
    const first = await h.start({ threadId: "fixed", question: "before compaction" });
    await finish(h, first, "answer before compaction");
    const anchor = log.findQuickAskBranch(h.manager.getEntries(), scope).contextAnchorId;
    h.manager.appendMessage({ role: "user", content: "main detail later summarized", timestamp: 3 });
    const kept = h.manager.appendMessage({ role: "user", content: "main kept after anchor", timestamp: 4 });
    const checkpoint = h.manager.appendCompaction("main checkpoint summary", kept, 5000);
    const next = await h.start({ threadId: "fixed", question: "after compaction" });
    const sent = texts(h.runs.at(-1).transcript.messages);
    assert.match(sent, /main checkpoint summary/);
    assert.match(sent, /main kept after anchor/);
    assert.match(sent, /answer before compaction/, "the topic keeps its own questions and answers");
    assert.doesNotMatch(sent, /ancestor question|main detail later summarized/);
    const branch = log.findQuickAskBranch(h.manager.getEntries(), scope);
    assert.equal(branch.contextAnchorId, checkpoint);
    assert.equal(branch.rebasedFromAnchorId, anchor);
    await finish(h, next);
    const branchRecords = () => h.manager.getEntries().filter((entry) => entry.customType === log.QUICK_ASK_BRANCH).length;
    const recorded = branchRecords();
    const again = await h.start({ threadId: "fixed", question: "no newer checkpoint" });
    assert.equal(branchRecords(), recorded, "an unchanged checkpoint is not recorded again");
    await finish(h, again);
    assert.equal((await storage.readSessionQuickAsks(h.file)).at(-1).data.contextAnchorId, checkpoint);
  } finally { await h.cleanup(); }
});

test("a checkpoint on another main line leaves the topic anchor unchanged", async () => {
  const h = await quickAskFixture();
  try {
    const scope = { threadId: "pinned", branchId: "main" };
    const first = await h.start({ threadId: "pinned" });
    await finish(h, first, "pinned answer");
    const anchor = log.findQuickAskBranch(h.manager.getEntries(), scope).contextAnchorId;
    h.manager.branch(h.manager.getEntries()[0].id);
    const other = h.manager.appendMessage({ role: "user", content: "other line", timestamp: 5 });
    h.manager.appendCompaction("other line checkpoint", other, 5000);
    const next = await h.start({ threadId: "pinned", question: "still pinned" });
    const sent = texts(h.runs.at(-1).transcript.messages);
    assert.doesNotMatch(sent, /other line/);
    assert.match(sent, /ancestor question/);
    assert.match(sent, /pinned answer/);
    assert.equal(log.findQuickAskBranch(h.manager.getEntries(), scope).contextAnchorId, anchor);
    await finish(h, next);
  } finally { await h.cleanup(); }
});

test("the window bound is the context plus the SDK reserve plus one answer budget, not a fixed share", async () => {
  let contextWindow = 200000;
  const h = await quickAskFixture({ getModel: (provider, id) => ({ ...model, provider, id, contextWindow }) });
  try {
    h.manager.appendMessage({ role: "user", content: "long main history ".repeat(8000), timestamp: 2 });
    const probe = await h.start({ threadId: "probe", question: "same size" });
    const tokens = estimateContextTokens(normalizeContext(h.runs[0].transcript)).tokens;
    await finish(h, probe);
    contextWindow = tokens + context.QUICK_ASK_WINDOW_RESERVE_TOKENS + context.QUICK_ASK_ANSWER_TOKENS;
    assert.ok(tokens > contextWindow * 0.75, "the former 75% share would have rejected this request");
    const fits = await h.start({ threadId: "fits", question: "same size" });
    assert.equal(h.runs.at(-1).options.maxTokens, context.QUICK_ASK_ANSWER_TOKENS);
    await finish(h, fits);
    contextWindow -= 1;
    const over = await h.post({ threadId: "over", question: "same size" });
    assert.equal(over.status, 413);
    const error = (await over.json()).error;
    assert.match(error, /超出所选模型窗口/);
    assert.match(error, /不会压缩本话题已有问答/);
    assert.equal(h.runs.length, 2);
  } finally { await h.cleanup(); }
});

test("real custom-message conversion and extension rewrites keep a single marked current question", async () => {
  let mode = "duplicate";
  const h = await quickAskFixture({ transform: async (messages) => {
    const current = messages.at(-1);
    if (mode === "duplicate") return [...messages, structuredClone(current)];
    if (mode === "rewrite") return [...messages.slice(0, -1), { ...current, content: [{ type: "text", text: "rewritten" }] },
      { role: "user", content: "extension-added user", timestamp: 5 }];
    return [...messages.slice(0, -1), { role: "user", content: "extension-added user", timestamp: 5 }];
  } });
  try {
    h.manager.appendMessage({ role: "custom", customType: "memory", content: "remembered preference", display: true, timestamp: 2 });
    h.manager.appendMessage({ role: "user", content: "same question", timestamp: 3 });
    const first = await h.start({ question: "same question" });
    const firstMessages = h.runs[0].transcript.messages;
    assert.equal(firstMessages.some((message) => message.role === "custom"), false);
    assert.match(texts(firstMessages), /remembered preference/);
    assert.equal(firstMessages.filter((message) => message.role === "user" && texts([message]).includes("same question")).length, 2);
    await finish(h, first);
    mode = "rewrite";
    const second = await h.start({ question: "unmodified second" });
    assert.match(texts(h.runs[1].transcript.messages), /rewritten|extension-added user/);
    assert.doesNotMatch(texts(h.runs[1].transcript.messages), /unmodified second|__piWebQuickAskTurn/);
    await finish(h, second);
    mode = "drop";
    const third = await h.start({ question: "restored current" });
    assert.match(texts(h.runs[2].transcript.messages), /restored current|extension-added user/);
    assert.doesNotMatch(texts(h.runs[2].transcript.messages), /__piWebQuickAskTurn/);
    await finish(h, third);
  } finally { await h.cleanup(); }
});

test("extension-owned system sections and tool changes are not undone by a fallback", async () => {
  const h = await quickAskFixture({ transform: async (messages) => [
    { role: "system", content: "extension authoritative", toolsAdded: [], timestamp: 1 },
    ...messages.filter((message) => message.role !== "system"),
    { role: "system", content: "valid later system", toolsAdded: [{ name: "added", description: "added tool", parameters: { type: "object", properties: {} } }], timestamp: 2 },
  ] });
  try {
    const run = await h.start();
    const transcript = h.runs[0].transcript;
    assert.equal(transcript.systemPrompt, undefined);
    assert.equal(transcript.tools, undefined);
    assert.doesNotMatch(texts(transcript.messages), /Stable synthetic instructions/);
    assert.match(texts(transcript.messages), /extension authoritative|valid later system/);
    const normalized = normalizeContext(transcript);
    assert.ok(JSON.stringify(normalized).includes("added tool"));
    assert.equal(h.runs[0].options.toolChoice, "none");
    await finish(h, run);
  } finally { await h.cleanup(); }
});

test("the real estimator preserves HTTP 413 instead of clipping ancestry or executing a provider", async () => {
  const h = await quickAskFixture({ model: { ...model, contextWindow: 32 } });
  try {
    const response = await h.post({ question: "too large" });
    assert.equal(response.status, 413);
    const error = (await response.json()).error;
    assert.match(error, /可新开话题或选择更大窗口的模型/);
    assert.match(error, /当前主线路径包含本话题锚点/);
    assert.equal(h.runs.length, 0);
    assert.equal(h.state.aborts, 0);
    assert.equal(h.owner.isAlive(), true);
    assert.deepEqual(await storage.readSessionQuickAsks(h.file), []);
    assert.equal((await (await h.get()).json()).runs[0].status, "failed");
  } finally { await h.cleanup(); }
});

test("provider and context-hook failures persist truthful outcomes without blank replies or main cancellation", async () => {
  const h = await quickAskFixture();
  try {
    const run = await h.start();
    h.runs[0].fail("provider exploded");
    const terminal = await h.waitTerminal(run.id);
    assert.equal(terminal.status, "failed");
    assert.match(terminal.error, /provider exploded/);
    assert.deepEqual(await storage.readSessionQuickAsks(h.file), []);
    assert.equal(h.state.aborts, 0);
    assert.equal(h.owner.isAlive(), true);
  } finally { await h.cleanup(); }
  const broken = await quickAskFixture({ transform: async () => { throw new context.QuickAskError("context extension runner is unavailable"); } });
  try {
    assert.equal((await broken.post({ question: "requires hook" })).status, 500);
    assert.equal(broken.runs.length, 0);
    assert.equal(broken.state.aborts, 0);
  } finally { await broken.cleanup(); }
});

test("materialization preserves native content, fixed context, settings and usage without inference", async () => {
  const h = await quickAskFixture();
  try {
    const run = await h.start({ images: [image], threadId: "forkable", branchId: "feature" });
    h.runs[0].think("native thought");
    await finish(h, run, "native answer");
    h.manager.appendMessage({ role: "user", content: "later unrelated main", timestamp: 8 });
    const scope = { threadId: "forkable", branchId: "feature" };
    const branch = log.findQuickAskBranch(h.manager.getEntries(), scope);
    const expected = log.quickAskBranchManager(h.manager, branch, undefined, true).buildSessionContext();
    const mainBefore = h.manager.buildSessionContext();
    const leaf = h.manager.getLeafId();
    const response = await h.post({ action: "fork", ...scope });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    const opened = SessionManager.open(result.newSessionPath);
    assert.deepEqual(opened.buildSessionContext(), expected);
    assert.equal(opened.getHeader().parentSession, h.file);
    assert.equal(h.manager.getLeafId() === leaf, false, "only transfer metadata may advance the owner leaf");
    assert.deepEqual(h.manager.buildSessionContext(), mainBefore);
    assert.equal(h.runs.length, 1);
    const copied = opened.getEntries().find((entry) => entry.message?.usageEvent?.relation === "copy");
    assert.equal(copied.message.usageEvent.id, (await storage.readSessionQuickAsks(h.file))[0].usageEvent.id);
    assert.equal(copied.message.content[0].thinkingSignature, "synthetic-signature");
    assert.equal((await (await h.post({ action: "fork", ...scope })).json()).newSessionId, result.newSessionId);
    assert.equal((await h.post({ action: "start", question: "after transfer", ...scope })).status, 409);
  } finally { await h.cleanup(); }
});

test("cold materialization persists an idempotent transfer without booting an Agent runtime", async () => {
  const h = await quickAskFixture();
  try {
    const run = await h.start();
    await finish(h, run);
    const creates = h.state.creates;
    const sourcePrefix = await readFile(h.file, "utf8");
    h.state.visible = false;
    const first = await (await h.post({ action: "fork", threadId: "a" })).json();
    assert.equal(first.success, true);
    assert.ok((await readFile(h.file, "utf8")).startsWith(sourcePrefix));
    assert.equal((await (await h.post({ action: "fork", threadId: "a" })).json()).newSessionId, first.newSessionId);
    assert.equal(h.state.starts, 0);
    assert.equal(h.state.creates, creates);
  } finally { await h.cleanup(); }
});

test("in-flight conversion admits a short response, waits only for its own side turn, and survives observer detachment", async () => {
  const h = await quickAskFixture();
  try {
    const run = await h.start();
    h.state.mainRunning = true;
    const pending = await h.post({ action: "fork", threadId: "a", wait: false });
    assert.equal(pending.status, 202);
    assert.equal((await pending.json()).run.id, run.id);
    await finish(h, run);
    const result = await (await h.post({ action: "fork", threadId: "a", wait: false })).json();
    assert.equal(result.success, true);
    assert.equal(h.state.mainRunning, true);
    assert.equal(h.state.aborts, 0);
  } finally { await h.cleanup(); }
});

test("promotion keeps the fixed origin and replacement lineage", async () => {
  const h = await quickAskFixture();
  try {
    const run = await h.start({ branchId: "feature" });
    await finish(h, run, "promoted answer");
    const original = (await storage.readSessionQuickAsks(h.file))[0];
    const result = await (await h.post({ action: "promote_branch", fromBranchId: "feature" })).json();
    assert.equal(result.promotedCount, 1);
    const [promoted] = await storage.readSessionQuickAsks(h.file);
    assert.equal(promoted.data.branchId, "main");
    assert.equal(promoted.usageEvent.id, original.usageEvent.id);
    assert.equal(promoted.usageEvent.relation, "replace");
    assert.equal(promoted.data.contextAnchorId, original.data.contextAnchorId);
    const promotedAssistant = [...(promoted.data.nativeEntries ?? [])].reverse()
      .find((entry) => entry.type === "message" && entry.message.role === "assistant");
    assert.equal(promotedAssistant.message.usageEvent.relation, "replace");
    assert.equal(h.runs.length, 1);
    const followUp = await h.start({ question: "after promotion" });
    assert.match(texts(h.runs[1].transcript.messages), /promoted answer/);
    await finish(h, followUp);
  } finally { await h.cleanup(); }
});

test("promotion accepts legacy top-level branch identity", async () => {
  const h = await quickAskFixture();
  try {
    const anchor = h.manager.getLeafId();
    const id = h.manager.appendCustomEntry("quick_ask", {
      question: "legacy question", answer: "legacy answer", createdAt: 1, contextAnchorId: anchor,
    });
    const legacy = h.manager.getEntry(id);
    legacy.branchId = "feature";
    const lines = (await readFile(h.file, "utf8")).trim().split("\n").map(JSON.parse);
    const row = lines.find((entry) => entry.id === id);
    row.branchId = "feature";
    await writeFile(h.file, `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    const response = await h.post({ action: "promote_branch", fromBranchId: "feature" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).promotedCount, 1);
    const items = await storage.readSessionQuickAsks(h.file);
    assert.equal(items.length, 1);
    assert.equal(items[0].data.branchId, "main");
    assert.equal(items[0].data.answer, "legacy answer");
  } finally { await h.cleanup(); }
});

test("transfer append failure leaves an idempotent ready marker instead of rematerializing", async () => {
  const h = await quickAskFixture();
  const append = h.host.append;
  let failTransfer = true;
  h.host.append = (type, data) => {
    if (failTransfer && type === "quick_ask_transfer") throw new Error("transfer append failed");
    return append(type, data);
  };
  try {
    const run = await h.start();
    await finish(h, run);
    const first = await h.post({ action: "fork", threadId: "a" });
    assert.equal(first.status, 500);
    const pending = h.manager.getEntries().filter((entry) => entry.customType === "quick_ask_transfer_pending");
    assert.equal(pending.length, 2);
    const saved = pending.at(-1).data.result;
    assert.ok(saved?.newSessionId);

    failTransfer = false;
    const second = await h.post({ action: "fork", threadId: "a" });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).newSessionId, saved.newSessionId);
    assert.equal(h.runs.length, 1);
    assert.equal(h.manager.getEntries().filter((entry) => entry.customType === "quick_ask_transfer").length, 0);
  } finally { await h.cleanup(); }
});

test("transfer replay preserves a subproject assignment failure result", async () => {
  const h = await quickAskFixture({ materialized: async () => ({ subprojectAssignmentFailed: true }) });
  try {
    const run = await h.start();
    await finish(h, run);
    const first = await (await h.post({ action: "fork", threadId: "a" })).json();
    assert.equal(first.subprojectAssignmentFailed, true);
    const second = await (await h.post({ action: "fork", threadId: "a" })).json();
    assert.equal(second.newSessionId, first.newSessionId);
    assert.equal(second.subprojectAssignmentFailed, true);
  } finally { await h.cleanup(); }
});

test("malformed scopes and model overrides fail before inference", async () => {
  const h = await quickAskFixture();
  try {
    for (const body of [null, [], { question: "q", model: [] }, { question: "q", branchId: {} }, { question: "q", images: {} },
      { question: "q", thinkingLevel: "invented" }, { question: "q", expectedParentId: 2 }]) {
      assert.equal((await h.post(body)).status, 400, JSON.stringify(body));
    }
    assert.equal(h.runs.length, 0);
    const guard = deferred();
    const abort = new AbortController();
    const request = h.post({ question: "stale" }, { signal: abort.signal, params: guard.promise });
    abort.abort();
    guard.resolve({ id: h.manager.getSessionId() });
    assert.equal((await request).status, 499);
    assert.equal(h.runs.length, 0);
  } finally { await h.cleanup(); }
});

test("the history list carries display fields only: no native SDK entries, and attachments are not repeated", async () => {
  const attachment = { data: "QUJD".repeat(500), mimeType: "image/png" };
  const h = await quickAskFixture();
  try {
    const admitted = await h.start({ images: [attachment] });
    h.runs[0].think("a private reasoning trace");
    h.runs[0].complete("the answer");
    await h.waitTerminal(admitted.id);
    for (const visible of [false, true]) {
      h.state.visible = visible;
      const text = await (await h.get()).text();
      const body = JSON.parse(text);
      assert.equal(body.items.length, 1);
      assert.equal(body.items[0].data.nativeEntries, undefined);
      assert.equal(body.items[0].data.answer, "the answer");
      assert.deepEqual(body.items[0].data.images, [attachment]);
      const run = body.runs.find((item) => item.id === admitted.id);
      assert.equal(run.nativeEntries, undefined);
      assert.equal(run.entry.data.nativeEntries, undefined);
      assert.equal(run.entry.data.images, undefined, "the observer fills the entry's attachments from the run");
      assert.deepEqual(run.images, [attachment]);
      assert.doesNotMatch(text, /synthetic-signature/);
      assert.equal(text.split(attachment.data).length - 1, 2, `${visible ? "live" : "cold"}: once for the item, once for the run`);
    }
  } finally { await h.cleanup(); }
});
