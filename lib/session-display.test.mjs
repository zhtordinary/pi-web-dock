import assert from "node:assert/strict";
import test from "node:test";

import { sessionDisplayTitle, sessionModelLabel, sessionModelValue } from "./session-display.ts";

const subagent = (overrides = {}) => ({
  id: "child-1",
  firstMessage: "Inspect the failing session state\nwith more detail",
  relation: { kind: "subagent", parentSessionId: "parent-1", profile: "reviewer", description: "Inspect state", status: "completed" },
  ...overrides,
});

test("uses the session task title instead of the subagent model", () => {
  assert.equal(sessionDisplayTitle(subagent()), "Inspect the failing session state");
  assert.equal(sessionDisplayTitle(subagent({ name: "Named child" })), "Named child");
});

test("shortens provider/model paths to the model segment", () => {
  assert.equal(sessionModelLabel("vercel-ai-gateway/openai/gpt-6.1-terra"), "gpt-6.1-terra");
  assert.equal(sessionModelLabel("claude-opus-5-5"), "claude-opus-5-5");
  assert.equal(sessionModelLabel(" /gateway//model-x/ "), "model-x");
});

test("prefers the live model value and falls back to persisted relation metadata", () => {
  assert.equal(sessionModelValue(subagent({ modelName: "openai/gpt-5" }), "gateway/gpt-6.1"), "gateway/gpt-6.1");
  assert.equal(sessionModelValue(subagent({ modelName: "openai/gpt-5" })), "openai/gpt-5");
  assert.equal(sessionModelValue(subagent()), undefined);
});
