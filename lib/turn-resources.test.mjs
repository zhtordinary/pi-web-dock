import assert from "node:assert/strict";
import test from "node:test";
import { summarizeTurnResources, turnCacheHitRate } from "./turn-resources.ts";

const call = (id, toolName, input = {}) => ({ type: "toolCall", toolCallId: id, toolName, input });
const assistant = (...content) => ({ role: "assistant", model: "test", provider: "test", content });
const result = (id, overrides = {}) => ({ role: "toolResult", toolCallId: id, content: [], ...overrides });

test("counts the whole turn and excludes adjacent turns, results, and prose mentions", () => {
  const messages = [
    assistant(call("old", "write")),
    { role: "user", content: "Please use skill review and read SKILL.md" },
    assistant(call("a", "read", { path: "/skills/review/SKILL.md" }), call("b", "read", { path: "/tmp/code.ts" })),
    result("a"), result("b", { isError: true }),
    assistant(call("c", "bash", { command: "cat /skills/other/SKILL.md" })),
    result("c"),
    assistant({ type: "text", text: "Used another skill and write" }),
    { role: "user", content: "next" },
    assistant(call("next", "edit")),
  ];
  assert.deepEqual(summarizeTurnResources(messages, 1, 8), {
    tools: [{ name: "read", count: 2 }, { name: "bash", count: 1 }],
    nestedTools: [], omittedNestedCalls: 0,
    skills: [{ name: "review", path: "/skills/review/SKILL.md", count: 1 }],
    plugins: [],
  });
});

test("only successful structured Skill reads count and same-named paths remain distinct", () => {
  const messages = [assistant(
    call("a", "read", { path: "/one/review/SKILL.md" }),
    call("b", "read", { path: "/one/review/SKILL.md" }),
    call("c", "read", { file_path: "/two/review/SKILL.md" }),
    call("failed", "read", { path: "/skills/failed/SKILL.md" }),
    call("pending", "read", { path: "/skills/pending/SKILL.md" }),
    call("write", "write", { path: "/skills/written/SKILL.md" }),
  ), result("a"), result("b"), result("c"), result("failed", { isError: true }), result("write")];
  assert.deepEqual(summarizeTurnResources(messages).skills, [
    { name: "review", path: "/one/review/SKILL.md", count: 2 },
    { name: "review", path: "/two/review/SKILL.md", count: 1 },
  ]);
});

test("recognizes complete SDK expansions including multimodal user content", () => {
  const expansion = '<skill name="review" location="/skills/review/SKILL.md">\nReferences are relative to /skills/review.\n\nUse this Skill\n</skill>\n\nmy args';
  const summary = summarizeTurnResources([
    { role: "user", content: [{ type: "text", text: expansion }, { type: "image", source: { type: "url", url: "test" } }] },
    { role: "user", content: '<skill name="fake" location="/skills/fake/SKILL.md">\nincomplete' },
    { role: "user", content: "/skill:unexpanded" },
  ]);
  assert.deepEqual(summary.skills, [{ name: "review", path: "/skills/review/SKILL.md", count: 1 }]);
});

test("codemode reports recorded inner calls separately and never invents truncated args or omitted names", () => {
  const summary = summarizeTurnResources([
    assistant(call("code", "codemode", { code: "irrelevant" })),
    result("code", { details: { calls: [
      { name: "read", args: '{"path":"/skills/nested/SKILL.md"}', status: "ok" },
      { name: "read", args: '{"path":"/skills/failure/SKILL.md"}', status: "error" },
      { name: "read", args: '{"path":"/skills/truncated/SKILL.md"…', status: "ok" },
      { name: "tools.read", args: '{"path":"/skills/also/SKILL.md"}', status: "ok" },
      { name: "read", args: '{"path":"/skills/unknown/SKILL.md"}' },
      { name: "bash", args: "{}", status: "cancelled" },
    ], omittedCalls: 2 } }),
  ]);
  assert.deepEqual(summary.tools, [{ name: "codemode", count: 1 }]);
  assert.deepEqual(summary.nestedTools, [{ name: "read", count: 4 }, { name: "tools.read", count: 1 }, { name: "bash", count: 1 }]);
  assert.equal(summary.omittedNestedCalls, 2);
  assert.deepEqual(summary.skills, [
    { name: "nested", path: "/skills/nested/SKILL.md", count: 1 },
    { name: "also", path: "/skills/also/SKILL.md", count: 1 },
  ]);
});

test("counts package-owned tool calls as plugin calls and excludes lifecycle custom entries", () => {
  const sourceInfo = {
    path: "/plugin/pi-plan-mode/index.ts",
    source: "npm:@narumitw/pi-plan-mode@0.59.2",
    scope: "user",
    origin: "package",
  };
  const summary = summarizeTurnResources([
    assistant(call("question", "plan_mode_question"), call("complete", "plan_mode_complete")),
    result("question"), result("complete", { isError: true }),
    { role: "custom", customType: "plan-mode-state", content: "state", display: true },
  ], 0, 4, [
    { name: "plan_mode_question", sourceInfo },
    { name: "plan_mode_complete", sourceInfo },
  ]);

  assert.deepEqual(summary.plugins, [{
    name: "pi-plan-mode",
    count: 2,
    source: "npm:@narumitw/pi-plan-mode@0.59.2",
    path: "/plugin/pi-plan-mode/index.ts",
    tools: [
      { name: "plan_mode_question", count: 1 },
      { name: "plan_mode_complete", count: 1 },
    ],
  }]);
});

test("cache hit rate uses all prompt tokens, displays zero hits, and rejects unavailable usage", () => {
  assert.equal(turnCacheHitRate({ input: 20, cacheRead: 70, cacheWrite: 10 }), 70);
  assert.equal(turnCacheHitRate({ input: 100, cacheRead: 0, cacheWrite: 0 }), 0);
  assert.equal(turnCacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 }), null);
  assert.equal(turnCacheHitRate({ input: NaN, cacheRead: 10, cacheWrite: 0 }), null);
  assert.equal(turnCacheHitRate({ input: -5, cacheRead: 10, cacheWrite: 0 }), null);
});
