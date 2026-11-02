import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { quickAskFixture, storage, log, image } from "../test-support/quick-ask-fixture.mjs";

// File mutation belongs to the actual live SessionManager, not a route-local append queue.
test("concurrent producers share one SDK index, parent chain and durable file", async () => {
  const h = await quickAskFixture();
  try {
    const before = h.manager.buildSessionContext();
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => Promise.resolve().then(() =>
      h.host.append("quick_ask", { question: `Q ${index}`, answer: `A ${index}`, createdAt: index }))));
    assert.equal(new Set(results.map((entry) => entry.id)).size, 20);
    for (let index = 1; index < results.length; index++) assert.equal(results[index].parentId, results[index - 1].id);
    assert.equal(h.manager.getLeafId(), results.at(-1).id);
    assert.deepEqual(h.manager.buildSessionContext(), before, "plain custom entries cannot enter the main model context");
    assert.deepEqual((await storage.readSessionQuickAsks(h.file)).map((item) => item.id), results.map((item) => item.id));
  } finally { await h.cleanup(); }
});

test("native admission and completion project text, images, thinking and signatures without storing duplicate strings", async () => {
  const h = await quickAskFixture();
  try {
    const admitted = await h.start({ images: [image] });
    h.runs[0].think("reasoned carefully");
    h.runs[0].complete("native answer");
    await h.waitTerminal(admitted.id);
    const [item] = await storage.readSessionQuickAsks(h.file);
    assert.equal(item.data.question, "side question");
    assert.equal(item.data.answer, "native answer");
    assert.equal(item.data.thinking, "reasoned carefully");
    assert.deepEqual(item.data.images, [image]);
    assert.equal(item.usageEvent.relation, "origin");
    assert.equal(item.data.nativeEntries.at(-1).message.content[0].thinkingSignature, "synthetic-signature");
    const rows = (await readFile(h.file, "utf8")).trim().split("\n").map(JSON.parse);
    const saved = rows.find((row) => row.customType === "quick_ask");
    assert.equal(saved.data.question, undefined);
    assert.equal(saved.data.answer, undefined);
    assert.equal(saved.data.nativeEntries.length, 1);
    assert.equal(saved.data.nativeEntries[0].message.role, "assistant");
  } finally { await h.cleanup(); }
});

for (const [text, stopReason] of [["partial answer", "length"], ["", "length"], ["", "stop"]]) {
  test(`native outcome ${stopReason}/${text || "no body"} survives history and SSE without a second stored status`, async () => {
    const h = await quickAskFixture();
    try {
      const admitted = await h.start();
      const live = await h.get(`?runId=${admitted.id}&stream=1`);
      h.runs[0].think("thinking is not an answer");
      h.runs[0].complete(text, { stopReason });
      const terminal = await h.waitTerminal(admitted.id);
      assert.equal(terminal.status, "completed");
      assert.equal(terminal.entry.stopReason, stopReason);
      const liveEvents = (await live.text()).trim().split("\n\n").map(event => JSON.parse(event.replace(/^data: /, "")));
      assert.equal(liveEvents.at(-1).run.entry.stopReason, stopReason);
      assert.equal(liveEvents.at(-1).run.entry.data.nativeEntries, undefined);
      const [item] = await storage.readSessionQuickAsks(h.file);
      assert.equal(item.stopReason, stopReason);
      assert.equal(item.data.answer, text);
      assert.equal(item.data.thinking, "thinking is not an answer");
      assert.deepEqual(item.usage, terminal.entry.usage);
      h.state.visible = false;
      const history = await (await h.get()).json();
      assert.equal(history.items[0].stopReason, stopReason);
      const replay = await (await h.get(`?runId=${admitted.id}&stream=1`)).text();
      const event = JSON.parse(replay.trim().replace(/^data: /, ""));
      assert.equal(event.run.status, "completed");
      assert.equal(event.run.entry.stopReason, stopReason);
      assert.equal(event.run.entry.data.nativeEntries, undefined, "progress does not need the raw transcript");
      const saved = (await readFile(h.file, "utf8")).trim().split("\n").map(JSON.parse)
        .find(row => row.customType === "quick_ask");
      assert.equal(saved.stopReason, undefined);
      assert.equal(saved.data.stopReason, undefined);
      assert.equal(saved.data.nativeEntries.at(-1).message.stopReason, stopReason);
      assert.equal(h.runs.length, 1, "truncation never triggers an automatic retry");
    } finally { await h.cleanup(); }
  });
}

test("flat history never infers a stop reason from token counts", () => {
  const item = storage.normalizeQuickAskEntry({ type: "custom", customType: "quick_ask", id: "flat",
    timestamp: "2026-01-01", data: { question: "q", answer: "a", createdAt: 1, usage: { output: 4096 } } });
  assert.equal(item.stopReason, undefined);
});

test("both tombstone formats and branch-scoped deletion retain unrelated history", async () => {
  const h = await quickAskFixture();
  try {
    const main = h.host.append("quick_ask", { threadId: "default", question: "main", answer: "main", createdAt: 1 });
    const feature = h.host.append("quick_ask", { threadId: "default", branchId: "feature", question: "feature", answer: "feature", createdAt: 2 });
    const other = h.host.append("quick_ask", { threadId: "other", question: "other", answer: "other", createdAt: 3 });
    h.side.delete({ threadId: "default", branchId: "feature" });
    assert.deepEqual((await storage.readSessionQuickAsks(h.file)).map((item) => item.id), [main.id, other.id]);
    const lines = (await readFile(h.file, "utf8")).trim().split("\n").map(JSON.parse);
    lines.push({ type: "custom", id: "historical-delete", customType: "quick_ask_delete", targetId: main.id, timestamp: new Date().toISOString() });
    await writeFile(h.file, lines.map(JSON.stringify).join("\n") + "\n{incomplete");
    assert.deepEqual((await storage.readSessionQuickAsks(h.file)).map((item) => item.id), [other.id]);
    assert.equal(storage.projectSessionQuickAsks(lines).some((item) => item.id === feature.id), false);
  } finally { await h.cleanup(); }
});

test("cold reads parse only Side Ask lines and still confirm every marker match", async () => {
  const h = await quickAskFixture();
  try {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const record = { type: "custom", id: "admission", parentId: null, timestamp, customType: "quick_ask_run",
      data: { id: "run", threadId: "default", branchId: "main", status: "running" } };
    await writeFile(h.file, [
      JSON.stringify({ type: "message", id: "quoted", parentId: null, timestamp,
        message: { role: "user", content: [{ type: "text", text: JSON.stringify({ customType: "quick_ask" }) }], timestamp: 1 } }),
      JSON.stringify({ type: "custom", id: "other", parentId: null, timestamp, customType: "rpiv-todo-state", data: {} }),
      JSON.stringify({ type: "custom_message", id: "lookalike", parentId: null, timestamp, customType: "quick_ask_note", content: "", display: false }),
      JSON.stringify(record),
      '{"type":"custom","customType":"quick_ask_run"',
      "",
    ].join("\n") + "\n");
    assert.deepEqual(await storage.readQuickAskRecords(h.file), [record]);
  } finally { await h.cleanup(); }
});

test("origin, copy and replace usage share only a concrete request lineage", () => {
  const origin = storage.createQuickAskOriginUsageEvent();
  const copy = storage.createQuickAskDerivativeUsageEvent("source", "entry", origin, "copy");
  const replace = storage.createQuickAskDerivativeUsageEvent("source", "entry", origin, "replace");
  assert.equal(origin.relation, "origin");
  assert.equal(copy.id, origin.id);
  assert.equal(replace.id, origin.id);
  assert.equal(copy.sourceSessionId, "source");
  assert.equal(copy.sourceEntryId, "entry");
  const legacy = storage.createQuickAskDerivativeUsageEvent("source", "old", undefined, "copy");
  assert.equal(legacy.id, storage.createQuickAskDerivativeUsageEvent("source", "old", undefined, "replace").id);
  assert.notEqual(legacy.id, storage.createQuickAskDerivativeUsageEvent("different", "old", undefined, "copy").id);
});

test("usage preserves cache partitions, reasoning and fractional costs", () => {
  const cost = { input: 0.00012, output: 0.003, cacheRead: 0, cacheWrite: 0.02, total: 0.02312 };
  assert.deepEqual(storage.normalizeSessionUsage({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 35, reasoning: 50, cost }), {
    input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 35, reasoning: 50, totalTokens: 100, cost,
  });
});

test("an unchanged transcript is not read again, and any change to it is noticed", async () => {
  const h = await quickAskFixture();
  let scans = 0;
  const counting = (path) => { scans++; return storage.readJsonlLines(path); };
  try {
    h.host.append("quick_ask", { threadId: "default", question: "one", answer: "a", createdAt: 1 });
    const first = await storage.readQuickAskRecords(h.file, counting);
    assert.equal(first.length, 1);
    assert.equal(scans, 1);
    const again = await storage.readQuickAskRecords(h.file, counting);
    assert.equal(scans, 1, "a stat-validated hit does not touch the transcript");
    assert.deepEqual(again, first);
    again.length = 0;
    assert.equal((await storage.readQuickAskRecords(h.file, counting)).length, 1, "callers get their own array");
    assert.equal(scans, 1);
    h.host.append("quick_ask", { threadId: "default", question: "two", answer: "b", createdAt: 2 });
    assert.equal((await storage.readQuickAskRecords(h.file, counting)).length, 2);
    assert.equal(scans, 2, "an appended record changes the file version and forces one fresh scan");
  } finally { await h.cleanup(); }
});

const attachment = { data: "QUJD".repeat(500), mimeType: "image/png" };
const copiesIn = async (h) => ((await readFile(h.file, "utf8")).match(new RegExp(attachment.data, "g")) ?? []).length;

test("an attachment is stored once, in the admitted message, however the run ends, and snapshots recover it", async () => {
  for (const ending of ["completed", "cancelled", "failed"]) {
    const h = await quickAskFixture();
    try {
      const admitted = await h.start({ images: [attachment] });
      assert.equal(await copiesIn(h), 1, `${ending}: admission`);
      if (ending === "completed") h.runs[0].complete("answer");
      else if (ending === "cancelled") assert.equal((await h.post({ action: "stop", runId: admitted.id })).status, 200);
      else h.runs[0].fail("provider error");
      await h.waitTerminal(admitted.id);
      assert.equal(await copiesIn(h), 1, `${ending}: the terminal record adds no copy`);
      const run = log.quickAskRunSnapshots(await storage.readQuickAskRecords(h.file), [], false).find((item) => item.id === admitted.id);
      assert.deepEqual(run.images, [attachment], `${ending}: the snapshot derives the attachment`);
    } finally { await h.cleanup(); }
  }
});

test("run records written with their own attachment copy still read back, and newer ones derive it", () => {
  const stamp = "2026-01-01T00:00:00.000Z";
  const base = { id: "run-1", threadId: "t", branchId: "main", status: "running", question: "q", answer: "", thinking: "", createdAt: 1, revision: 0 };
  const user = { type: "message", id: "u1", parentId: null, timestamp: stamp, message: { role: "user", content: [{ type: "text", text: "q" }, { type: "image", ...image }], timestamp: 1 } };
  const admission = (data) => ({ type: "custom", id: "r1", parentId: null, timestamp: stamp, customType: "quick_ask_run", data });
  const later = { type: "custom", id: "r2", parentId: "r1", timestamp: stamp, customType: "quick_ask_run", data: { ...base, status: "cancelled", revision: 1, error: "stopped" } };
  for (const record of [admission({ ...base, images: [image], nativeEntries: [user] }), admission({ ...base, nativeEntries: [user] })]) {
    const [run] = log.quickAskRunSnapshots([record, later], [], false);
    assert.deepEqual(run.images, [image]);
    assert.equal(run.status, "cancelled");
  }
});
