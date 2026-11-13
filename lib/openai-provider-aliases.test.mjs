import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  OPENAI_API_PROVIDER_ID,
  OPENAI_API_USAGE_SOURCE,
  annotateOpenAIProviderCredential,
  OPENAI_SUBSCRIPTION_PROVIDER_ID,
  canonicalOpenAIProviderId,
  installOpenAIProviderAliases,
} = await createJiti(import.meta.url).import("./openai-provider-aliases.ts");

function runtimeFixture() {
  const calls = [];
  const source = {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    auth: {
      apiKey: { login: async () => ({ type: "api_key", key: "unused" }) },
      oauth: { name: "OpenAI (ChatGPT subscription)", login: async () => ({ type: "oauth" }) },
    },
    getModels: () => [{ provider: "openai", id: "gpt-test", api: "openai-responses", compat: { supportsExplicitPromptCacheMode: true, supportsLongCacheRetention: true } }],
    getAllModels: () => [{ provider: "openai", id: "gpt-test", api: "openai-responses", compat: { supportsExplicitPromptCacheMode: true, supportsLongCacheRetention: true } }],
    filterModels: (models) => models,
    stream: (model, _context, options) => { calls.push(["stream", model.provider, options]); return "stream"; },
    streamSimple: (model, _context, options) => { calls.push(["streamSimple", model.provider, options]); return "stream"; },
  };
  const providers = new Map([[source.id, source]]);
  const nativeProviders = new Map();
  return {
    calls,
    providers,
    runtime: {
      getProvider: (id) => providers.get(id),
      getRegisteredNativeProvider: (id) => nativeProviders.get(id),
      registerNativeProvider: (provider) => {
        nativeProviders.set(provider.id, provider);
        providers.set(provider.id, provider);
      },
    },
  };
}

test("registers independent subscription and API-key provider ids", () => {
  const { runtime } = runtimeFixture();
  const installed = installOpenAIProviderAliases(runtime);
  assert.equal(installed, true);
  const reinstalled = installOpenAIProviderAliases(runtime);
  assert.equal(reinstalled, false);

  const legacy = runtime.getProvider("openai");
  const subscription = runtime.getProvider(OPENAI_SUBSCRIPTION_PROVIDER_ID);
  const api = runtime.getProvider(OPENAI_API_PROVIDER_ID);
  assert.ok(legacy);
  assert.equal(legacy.id, "openai");
  assert.ok(subscription);
  assert.ok(api);
  assert.equal(subscription.auth.oauth.name, "OpenAI (ChatGPT subscription)");
  assert.equal(subscription.auth.apiKey, undefined);
  assert.equal(api.name, "OpenAI API");
  assert.equal(api.auth.oauth, undefined);
  assert.ok(api.auth.apiKey);
  assert.equal(subscription.getModels()[0].provider, OPENAI_SUBSCRIPTION_PROVIDER_ID);
  assert.equal(subscription.getModels()[0].compat.supportsExplicitPromptCacheMode, false);
  assert.equal(subscription.getModels()[0].compat.supportsLongCacheRetention, false);
  assert.equal(subscription.getModels()[0].compat.supportsMidConvoEffort, false);
  assert.equal(subscription.getModels()[0].compat.supportsMaxOutputTokens, false);
  assert.equal(subscription.getModels()[0].compat.supportsToolSearch, false);
  assert.equal(api.getModels()[0].provider, OPENAI_API_PROVIDER_ID);
  assert.equal(api.getModels()[0].compat.supportsExplicitPromptCacheMode, true);
  assert.equal(api.getModels()[0].compat.supportsLongCacheRetention, true);
  assert.equal(canonicalOpenAIProviderId(OPENAI_SUBSCRIPTION_PROVIDER_ID), "openai");
  assert.equal(canonicalOpenAIProviderId(OPENAI_API_PROVIDER_ID), "openai");
  assert.equal(OPENAI_API_USAGE_SOURCE, "chatgpt_subscription");
});

test("marks only the reserved subscription API-key provider", () => {
  assert.deepEqual(
    annotateOpenAIProviderCredential(OPENAI_API_PROVIDER_ID, { type: "api_key", key: "secret" }),
    { type: "api_key", key: "secret", usageSource: OPENAI_API_USAGE_SOURCE },
  );
  const ordinary = { type: "api_key", key: "secret" };
  assert.deepEqual(annotateOpenAIProviderCredential("openai", ordinary), ordinary);
  const oauth = { type: "oauth", access: "token" };
  assert.deepEqual(annotateOpenAIProviderCredential(OPENAI_API_PROVIDER_ID, oauth), oauth);
});
test("replaces unaliased models.json stub with native alias provider", () => {
  const { runtime, providers } = runtimeFixture();
  // Simulate models.json having created a bare stub before aliases were installed:
  providers.set(OPENAI_SUBSCRIPTION_PROVIDER_ID, {
    id: OPENAI_SUBSCRIPTION_PROVIDER_ID,
    name: OPENAI_SUBSCRIPTION_PROVIDER_ID,
    auth: { apiKey: { login: async () => ({ type: "api_key", key: "stub" }) } },
    getModels: () => [],
  });

  installOpenAIProviderAliases(runtime);

  const subscription = runtime.getProvider(OPENAI_SUBSCRIPTION_PROVIDER_ID);
  assert.equal(subscription.name, "OpenAI (ChatGPT subscription)");
  assert.ok(subscription.auth.oauth);
  assert.equal(subscription.auth.apiKey, undefined);
  assert.equal(subscription.getModels().length, 1);
});

test("alias providers pass their own model identity to the shared OpenAI implementation", () => {
  const { runtime, calls } = runtimeFixture();
  installOpenAIProviderAliases(runtime);

  const model = runtime.getProvider(OPENAI_API_PROVIDER_ID).getModels()[0];
  runtime.getProvider(OPENAI_API_PROVIDER_ID).streamSimple(model, { messages: [] });
  assert.deepEqual(calls, [["streamSimple", OPENAI_API_PROVIDER_ID, undefined]]);
});

test("subscription alias shapes effort, sampling and session-affinity options", () => {
  const { runtime, calls } = runtimeFixture();
  installOpenAIProviderAliases(runtime);

  const model = runtime.getProvider(OPENAI_SUBSCRIPTION_PROVIDER_ID).getModels()[0];
  runtime.getProvider(OPENAI_SUBSCRIPTION_PROVIDER_ID).streamSimple(model, { messages: [] }, {
    sessionId: "subscription-session",
    temperature: 0.2,
    maxTokens: 128,
    serviceTier: "priority",
    samplingParams: { temperature: 0.3, top_p: 0.4, service_tier: "priority" },
    headers: { "x-client-request-id": "caller-request" },
  });

  const options = calls[0][2];
  assert.equal(options.temperature, undefined);
  assert.equal(options.maxTokens, undefined);
  assert.equal(options.serviceTier, undefined);
  assert.deepEqual(options.samplingParams, {});
  assert.deepEqual(options.headers, {
    "session-id": "subscription-session",
    "thread-id": "subscription-session",
    "x-client-request-id": "caller-request",
  });
});
