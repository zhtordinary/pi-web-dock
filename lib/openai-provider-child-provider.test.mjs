import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { default: installChildProviders } = await createJiti(import.meta.url).import("../packages/reader-openai-subscription/index.ts");

function fakePi() {
  const providers = [];
  const events = [];
  const handlers = new Map();
  return {
    providers,
    eventLog: events,
    handlers,
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerProvider(provider) {
      providers.push(provider);
    },
    events: { emit: (...event) => events.push(event) },
  };
}

test("child extension registers the ChatGPT subscription alias from its own OpenAI provider", () => {
  const pi = fakePi();
  installChildProviders(pi);

  const subscription = pi.providers.find((provider) => provider.id === "openai-subscription");
  assert.ok(subscription);
  assert.equal(subscription.auth.apiKey, undefined);
  assert.ok(subscription.auth.oauth);
  const model = subscription.getModels().find((candidate) => candidate.id === "gpt-6.1-sol");
  assert.ok(model);
  assert.equal(model.provider, "openai-subscription");
  assert.equal(model.thinkingLevelMap?.max, "max");
  assert.equal(model.compat?.supportsMidConvoEffort, false);
  assert.equal(model.compat?.supportsMaxOutputTokens, false);
  assert.equal(model.compat?.supportsToolSearch, false);
  assert.deepEqual(pi.eventLog, [["subagent:acknowledge-extension", { id: "reader-openai-provider-aliases" }]]);
});

test("child subscription requests use supported effort fields and cache-affinity headers", async () => {
  const pi = fakePi();
  installChildProviders(pi);
  const subscription = pi.providers.find((provider) => provider.id === "openai-subscription");
  const model = subscription.getModels().find((candidate) => candidate.id === "gpt-6.1-sol");
  let payload;
  let headers;
  const stream = subscription.streamSimple(model, { messages: [] }, {
    apiKey: "synthetic-not-a-real-token",
    sessionId: "child-session",
    reasoning: "max",
    maxTokens: 128,
    fetch: async (input, init) => {
      headers = Object.fromEntries(new Request(input, init).headers);
      throw new Error("synthetic capture stop");
    },
    onPayload(body) {
      payload = body;
      return body;
    },
  });
  const result = await stream.result();

  assert.equal(result.stopReason, "error");
  assert.equal(payload.store, false);
  assert.equal(payload.stream, true);
  assert.equal(payload.max_output_tokens, undefined);
  assert.equal(payload.temperature, undefined);
  assert.equal(payload.top_p, undefined);
  assert.equal(payload.service_tier, undefined);
  assert.equal(payload.prompt_cache_retention, undefined);
  assert.equal(payload.prompt_cache_options, undefined);
  assert.equal(payload.input.some((item) => item.type === "configuration_update"), false);
  assert.equal(payload.reasoning.effort, "max");
  assert.equal(headers["session-id"], "child-session");
  assert.equal(headers["thread-id"], "child-session");
  assert.equal(headers["x-client-request-id"], "child-session");
});

test("child extension routes subscription forks to the parent cache session", async (t) => {
  const parentDir = await mkdtemp(join(tmpdir(), "pi-web-child-subscription-affinity-"));
  t.after(() => rm(parentDir, { recursive: true, force: true }));
  const parentSession = join(parentDir, "parent.jsonl");
  await writeFile(parentSession, `${JSON.stringify({ type: "session", id: "parent-session" })}\n`);

  const pi = fakePi();
  installChildProviders(pi);
  const headers = {
    "session-id": "child-session",
    "thread-id": "child-session",
    "x-client-request-id": "child-session",
  };
  pi.handlers.get("before_provider_headers")(
    { headers },
    {
      model: { provider: "openai-subscription" },
      sessionManager: { getHeader: () => ({ id: "child-session", parentSession }) },
    },
  );

  assert.equal(headers["session-id"], "parent-session");
  assert.equal(headers["thread-id"], "child-session");
  assert.equal(headers["x-client-request-id"], "child-session");
});
