import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  beginQuickAskRequest,
  createQuickAskProviderSessionId,
  finishQuickAskRequest,
  isCurrentQuickAskRequest,
  withQuickAskCacheAffinity,
} = await createJiti(import.meta.url).import("./quick-ask-session.ts");

const base = {
  parentSessionId: "parent-session",
  threadId: "thread-1",
  branchId: "branch-a",
  provider: "claude-remote",
  model: "claude-sonnet-4-6",
};

test("Quick Ask provider session identity is stable across turns", () => {
  const first = createQuickAskProviderSessionId(base);
  const second = createQuickAskProviderSessionId({ ...base });
  assert.equal(first, second);
  assert.match(first, /^pi-web-side-ask-[0-9a-f]{64}$/);
});

test("Quick Ask provider session identity isolates every scope dimension", () => {
  const first = createQuickAskProviderSessionId(base);
  for (const [field, value] of [
    ["parentSessionId", "other-parent-session"],
    ["threadId", "thread-2"],
    ["branchId", "branch-b"],
    ["provider", "anthropic"],
    ["model", "claude-opus-4-6"],
  ]) {
    assert.notEqual(createQuickAskProviderSessionId({ ...base, [field]: value }), first,
      `${field} must isolate the provider session`);
  }
});

test("HTTP payload shares only the parent cache key value and never gains a field", () => {
  const scope = createQuickAskProviderSessionId(base);
  const payload = { prompt_cache_key: scope.slice(0, 64), input: [{ role: "user", content: "parent" }], tool_choice: "none" };
  for (const api of ["openai-responses", "openai-completions", "openai-codex-responses", "azure-openai-responses"]) {
    const patched = withQuickAskCacheAffinity(payload, base.parentSessionId, scope, { api, provider: "CPA GPT" });
    assert.equal(patched.prompt_cache_key, base.parentSessionId);
    assert.deepEqual(Object.keys(patched), Object.keys(payload), "strict gateways reject fields the SDK did not emit");
    assert.equal(patched.input, payload.input);
    assert.equal(patched.tool_choice, "none");
    assert.equal(payload.prompt_cache_key, scope.slice(0, 64), "the original request must remain unchanged");
  }
  const unicodeParent = "界".repeat(70);
  assert.equal(withQuickAskCacheAffinity(payload, unicodeParent, scope, { api: "openai-responses" }).prompt_cache_key, "界".repeat(64));
});

test("absent, disabled, foreign and stateful cache payloads stay untouched", () => {
  const scope = createQuickAskProviderSessionId(base);
  const payload = { prompt_cache_key: scope.slice(0, 64) };
  for (const model of [
    { api: "anthropic-messages", provider: "claude-remote" },
    { api: "openai-responses", provider: "claude-remote" },
    { api: "openai-codex-responses", provider: "claude-remote" },
    { api: "unknown", provider: "custom" },
    {},
  ]) assert.equal(withQuickAskCacheAffinity(payload, base.parentSessionId, scope, model), undefined);
  for (const candidate of [undefined, null, [], {}, { prompt_cache_key: undefined }, { prompt_cache_key: "foreign-provider-key" }]) {
    assert.equal(withQuickAskCacheAffinity(candidate, base.parentSessionId, scope, { api: "openai-responses" }), undefined);
  }
});

test("shared payload cache key does not share cross-thread cancellation", () => {
  const firstScope = createQuickAskProviderSessionId(base);
  const secondScope = createQuickAskProviderSessionId({ ...base, threadId: "thread-2" });
  const model = { api: "openai-responses", provider: "CPA GPT" };
  const firstPayload = withQuickAskCacheAffinity({ prompt_cache_key: firstScope.slice(0, 64) }, base.parentSessionId, firstScope, model);
  const secondPayload = withQuickAskCacheAffinity({ prompt_cache_key: secondScope.slice(0, 64) }, base.parentSessionId, secondScope, model);
  assert.equal(firstPayload.prompt_cache_key, secondPayload.prompt_cache_key);
  const first = beginQuickAskRequest(firstScope);
  const second = beginQuickAskRequest(secondScope);
  first.controller.abort();
  assert.equal(second.controller.signal.aborted, false);
  assert.equal(isCurrentQuickAskRequest(second), true);
  finishQuickAskRequest(first);
  finishQuickAskRequest(second);
});

test("supersession aborts only the previous request and stale cleanup preserves its successor", () => {
  const first = beginQuickAskRequest("generation-test");
  const second = beginQuickAskRequest("generation-test");
  assert.equal(first.controller.signal.aborted, true);
  assert.equal(second.controller.signal.aborted, false);
  assert.equal(isCurrentQuickAskRequest(first), false);
  finishQuickAskRequest(first);
  assert.equal(isCurrentQuickAskRequest(second), true);
  first.controller.abort();
  assert.equal(second.controller.signal.aborted, false);
  finishQuickAskRequest(second);
  const third = beginQuickAskRequest("generation-test");
  assert.equal(isCurrentQuickAskRequest(first), false, "finished generations cannot become current again");
  finishQuickAskRequest(second);
  assert.equal(isCurrentQuickAskRequest(third), true);
  finishQuickAskRequest(third);
});
