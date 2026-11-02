import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  normalizeStreamingToolCalls,
  normalizeToolCalls,
} = await jiti.import("./normalize.ts");

function assistant(block) {
  return {
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  };
}

test("keeps SDK scratch input only for an in-flight snapshot", () => {
  const message = assistant({
    type: "toolCall",
    id: "call-1",
    name: "write",
    arguments: { path: "/tmp/file" },
    partialJson: '{"path":"/tmp/file","content":"hel',
  });

  assert.deepEqual(normalizeStreamingToolCalls(message).content[0], {
    type: "toolCall",
    toolCallId: "call-1",
    toolName: "write",
    input: { path: "/tmp/file" },
    rawInput: '{"path":"/tmp/file","content":"hel',
  });
  assert.deepEqual(normalizeToolCalls(message).content[0], {
    type: "toolCall",
    toolCallId: "call-1",
    toolName: "write",
    input: { path: "/tmp/file" },
  });
});

test("drops provider-only signatures from rendered assistant content", () => {
  const message = {
    ...assistant({
      type: "thinking",
      thinking: "private reasoning",
      thinkingSignature: "large-provider-signature",
    }),
    thinkingSignature: "top-level-signature",
  };
  const normalized = normalizeToolCalls({
    ...message,
    content: [
      ...message.content,
      { type: "text", text: "answer", textSignature: "text-signature" },
    ],
  });

  assert.deepEqual(normalized.content, [
    { type: "thinking", thinking: "private reasoning" },
    { type: "text", text: "answer" },
  ]);
  assert.equal(Object.hasOwn(normalized, "thinkingSignature"), false);
});

test("removes a client raw buffer when normalizing a completed message", () => {
  const message = assistant({
    type: "toolCall",
    toolCallId: "call-2",
    toolName: "write",
    input: { path: "/tmp/file", content: "complete" },
    rawInput: "temporary",
  });

  assert.equal(Object.hasOwn(normalizeToolCalls(message).content[0], "rawInput"), false);
});
