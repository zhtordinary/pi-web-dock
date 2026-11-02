import assert from "node:assert/strict";
import test from "node:test";
import { readHistoryEditMessage } from "./history-edit-message.ts";

const identity = { sessionId: "s", leafId: "leaf", revision: "rev", entryId: "user" };
function sourceReader(message, mutate, input) {
  const source = JSON.stringify(message);
  const calls = [];
  return { calls, read: async (options) => {
    calls.push(options);
    const text = options.surface === "input" ? input ?? (typeof message.content === "string" ? message.content
      : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")) : source;
    const end = Math.min(text.length, options.offset + 17);
    return { ...identity, kind: "content", surface: options.surface, path: "", format: options.surface === "input" ? "text" : "json",
      text: text.slice(options.offset, end), offset: options.offset, totalChars: text.length,
      previousOffset: options.offset > 0 ? Math.max(0, options.offset - 17) : null,
      nextOffset: end < text.length ? end : null, ...mutate?.(options) };
  } };
}

test("editing reads every source JSON segment and retains original image-only and image-plus-text messages", async () => {
  for (const text of ["", "question"]) {
    const original = { role: "user", content: [...(text ? [{ type: "text", text }] : []), { type: "image", data: "AAAA", mimeType: "image/png" }] };
    const source = sourceReader(original);
    assert.deepEqual(await readHistoryEditMessage(identity, source.read, () => true), original);
    assert.ok(source.calls.length > 1);
    for (const call of source.calls) {
      assert.equal(call.path, "");
      assert.ok(call.surface === "source" || call.surface === "input");
      assert.equal(call.revision, undefined);
      assert.equal(call.entryId, identity.entryId);
    }
  }
});

test("changed snapshots, broken continuation and abandoned edits reject before any restore or navigation", async () => {
  for (const mutate of [() => ({ entryId: "other" }), () => ({ nextOffset: 0 }), () => ({ nextOffset: null })]) {
    const source = sourceReader({ role: "user", content: "message" }, mutate);
    await assert.rejects(readHistoryEditMessage(identity, source.read, () => true));
  }
  const source = sourceReader({ role: "user", content: "message" });
  await assert.rejects(readHistoryEditMessage(identity, source.read, () => false), /target changed/);
  assert.equal(source.calls.length, 0);
});

test("editing combines complete authoritative display input with original media, preserving Markdown and whitespace", async () => {
  const original = { role: "user", content: [{ type: "text", text: "expanded template" }, { type: "image", data: "AAAA", mimeType: "image/png" }] };
  const input = " /template **original** " + "argument ".repeat(500);
  const source = sourceReader(original, undefined, input);
  const restored = await readHistoryEditMessage(identity, source.read, () => true);
  assert.equal(restored.content[0].text, input);
  assert.deepEqual(restored.content[1], original.content[1]);
  assert.ok(source.calls.some((call) => call.surface === "input" && call.offset > 0));
});

test("explicit rewrite and command edit intents apply only after complete media and input recovery", async () => {
  const original = { role: "user", content: [{ type: "text", text: "expanded skill" }, { type: "image", data: "AAAA", mimeType: "image/png" }] };
  for (const intent of [{ text: "rewritten **question**" }, { transformInput: (input) => input.replace("expanded skill", "/skill") }]) {
    const source = sourceReader(original);
    const restored = await readHistoryEditMessage(identity, source.read, () => true, intent);
    assert.equal(restored.content[0].text, intent.text ?? "/skill");
    assert.deepEqual(restored.content[1], original.content[1]);
  }
  const source = sourceReader(original, (options) => options.surface === "input" ? { sessionId: "other" } : {});
  await assert.rejects(readHistoryEditMessage(identity, source.read, () => true, { text: "replacement" }), /snapshot/);
});

test("append-only revision and active leaf changes do not invalidate complete edit reads", async () => {
  const original = { role: "user", content: "unchanged original" };
  const source = sourceReader(original, options => ({ revision: `r${options.offset}`, leafId: `new${options.offset}` }));
  assert.deepEqual(await readHistoryEditMessage(identity, source.read, () => true), original);
});
