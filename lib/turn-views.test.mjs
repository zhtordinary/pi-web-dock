import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, fsCache: false, jsx: { runtime: "automatic" } });
const { getFinalAnswerViews, keepWrittenFiles } = await jiti.import("./turn-views.ts");
const { MessageView } = await jiti.import("../components/MessageView.tsx");
const { extractTurnWrittenFiles } = await jiti.import("./turn-written-files.ts");

function assistant(overrides = {}) {
  return {
    role: "assistant", provider: "test", model: "test-model", stopReason: "stop",
    usage: { input: 1, output: 2 },
    content: [
      { type: "thinking", thinking: "", deferred: false },
      { type: "thinking", thinking: "", deferred: true },
      { type: "toolCall", toolCallId: "t1", toolName: "write", input: { path: "a.txt" } },
      { type: "text", text: "Done." },
    ],
    ...overrides,
  };
}

test("unchanged answer/process copies satisfy the actual MessageView memo comparator", () => {
  const cache = new WeakMap();
  const message = assistant();
  const first = getFinalAnswerViews(cache, message);
  const files = keepWrittenFiles(first, [{ filePath: "/p/a.txt" }]);
  for (let render = 0; render < 100; render++) {
    const again = getFinalAnswerViews(cache, message);
    const props = { message: again.answer, writtenFiles: keepWrittenFiles(again, [{ filePath: "/p/a.txt" }]) };
    assert.strictEqual(again, first);
    assert.strictEqual(again.process, first.process);
    assert.equal(MessageView.compare({ message: first.answer, writtenFiles: files }, props), true);
  }
  const replaced = getFinalAnswerViews(cache, { ...message, content: [...message.content.slice(0, -1), { type: "text", text: "Changed." }] });
  assert.equal(MessageView.compare({ message: first.answer }, { message: replaced.answer }), false);
});

test("process prefix retains stored thinking block indices while answer alone owns usage", () => {
  const message = assistant();
  const views = getFinalAnswerViews(new WeakMap(), message);
  assert.deepEqual(views.answer.content, [message.content[3]]);
  assert.strictEqual(views.answer.usage, message.usage);
  assert.deepEqual(views.process.content, message.content.slice(0, 3));
  assert.strictEqual(views.process.content[1], message.content[1], "deferred thinking must keep its original blockIndex=1");
  assert.equal(views.process.usage, undefined);
  assert.equal(message.usage.output, 2, "never mutate stored messages");
});

test("pure errors stay process-only; output-limit truncation still has its recovery answer", () => {
  const cache = new WeakMap();
  const pureError = assistant({ content: [], stopReason: "error", errorMessage: "synthetic failure" });
  const errorViews = getFinalAnswerViews(cache, pureError);
  assert.equal(errorViews.answer, null);
  assert.strictEqual(errorViews.process, pureError);
  const truncated = assistant({ content: [{ type: "thinking", thinking: "unfinished" }], stopReason: "length" });
  const views = getFinalAnswerViews(cache, truncated);
  assert.ok(views.answer);
  assert.deepEqual(views.answer.content, []);
  assert.equal(views.answer.stopReason, "length");
  assert.equal(views.process.usage, undefined);
  const withAnswer = assistant({ stopReason: "error", errorMessage: "synthetic error after answer" });
  assert.equal(getFinalAnswerViews(cache, withAnswer).answer.content[0].text, "Done.");
});

test("written files retain identity only while actual result-derived paths agree", () => {
  const message = assistant();
  const views = getFinalAnswerViews(new WeakMap(), message);
  const results = new Map([["t1", { role: "toolResult", toolCallId: "t1", content: [], isError: false }]]);
  const first = keepWrittenFiles(views, extractTurnWrittenFiles(message.content, results, "/p"));
  assert.deepEqual(first, [{ filePath: "/p/a.txt" }]);
  assert.strictEqual(keepWrittenFiles(views, extractTurnWrittenFiles(message.content, results, "/p")), first);
  results.set("t1", { ...results.get("t1"), isError: true });
  const failed = keepWrittenFiles(views, extractTurnWrittenFiles(message.content, results, "/p"));
  assert.notStrictEqual(failed, first);
  assert.deepEqual(failed, []);
  assert.notStrictEqual(keepWrittenFiles(views, [{ filePath: "/other/a.txt" }]), failed);
});

test("memo continues to observe relevant tool results, fees, resources and timing", () => {
  const views = getFinalAnswerViews(new WeakMap(), assistant());
  const result = { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "old" }] };
  const oldResults = new Map([["t1", result]]);
  const nextResults = new Map([["t1", { ...result, content: [{ type: "text", text: "new" }] }]]);
  assert.equal(MessageView.compare({ message: views.process, toolResults: oldResults }, { message: views.process, toolResults: nextResults }), false);
  const base = { message: views.answer, calculatedCost: 1, turnResources: {}, turnUsage: {}, responseDurationMs: 100, modelWaitPercent: 50 };
  for (const changed of [
    { calculatedCost: 2 }, { turnResources: {} }, { turnUsage: {} },
    { responseDurationMs: 200 }, { modelWaitPercent: 60 }, { remotePeer: "peer-b" },
  ]) assert.equal(MessageView.compare(base, { ...base, ...changed }), false);
});
