import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./turn-usage.ts");
}

const usage = (input, output, cacheRead, cacheWrite, total) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

const assistant = (messageUsage) => ({
  role: "assistant",
  content: [],
  model: "model",
  provider: "provider",
  usage: messageUsage,
});

test("sums all assistant entries in one user turn", async () => {
  const { summarizeTurnUsage } = await loadSubject();
  const messages = [
    { role: "user", content: "first" },
    assistant(usage(100, 20, 80, 2, 0.1)),
    { role: "toolResult", toolCallId: "call-1", content: [] },
    assistant(usage(300, 40, 240, 4, 0.2)),
    { role: "user", content: "second" },
    assistant(usage(900, 90, 700, 8, 0.9)),
  ];

  assert.deepEqual(
    summarizeTurnUsage(messages, ["u1", "a1", "tool", "a2", "u2", "a3"], { a1: 0.11, a2: 0.22, a3: 0.33 }, 0, 4),
    {
      input: 400,
      output: 60,
      cacheRead: 320,
      cacheWrite: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.33 },
      costAvailable: true,
    },
  );
});

test("does not use native producer cost when shared cost is unavailable", async () => {
  const { summarizeTurnUsage } = await loadSubject();
  const messages = [assistant(usage(1, 2, 3, 4, 0.5))];
  const result = summarizeTurnUsage(messages, ["a1"], {}, 0, 1);
  assert.equal(result?.cost.total, 0);
  assert.equal(result?.costAvailable, false);
});
