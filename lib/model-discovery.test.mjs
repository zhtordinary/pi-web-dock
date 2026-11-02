import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject(path) {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import(path);
  } catch {
    return import(path);
  }
}

const {
  buildModelsListUrl,
  discoveredModelToConfig,
  mergeDiscoveredModelMetadata,
  modelDiscoveryKey,
  parseDiscoveredModels,
} = await loadSubject("./model-discovery.ts");
const { resolveModelDiscoveryAuth } = await loadSubject("./model-discovery-auth.ts");
const { getSupportedThinkingLevels } = await loadSubject("@earendil-works/pi-ai");

test("builds protocol-appropriate model list URLs", () => {
  assert.equal(buildModelsListUrl("https://api.example.com/v1/", "openai-completions").toString(), "https://api.example.com/v1/models");
  assert.equal(buildModelsListUrl("https://api.anthropic.com", "anthropic-messages").toString(), "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(buildModelsListUrl("https://generativelanguage.googleapis.com", "google-generative-ai").toString(), "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
  assert.equal(buildModelsListUrl("https://api.example.com/custom/models", "openai-responses").toString(), "https://api.example.com/custom/models");
});

test("parses OpenAI, Anthropic, Google, and string model lists", () => {
  assert.deepEqual(parseDiscoveredModels({ data: [{ id: "gpt-5" }, { id: "claude", display_name: "Claude" }] }), [
    { id: "claude", name: "Claude" },
    { id: "gpt-5" },
  ]);
  assert.deepEqual(parseDiscoveredModels({ models: [{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" }] }), [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  ]);
  assert.deepEqual(parseDiscoveredModels(["zeta", "alpha", "alpha"]), [
    { id: "alpha" },
    { id: "zeta" },
  ]);
});

test("preserves explicit capability metadata from OpenAI, Anthropic, and Google shaped entries", () => {
  const models = parseDiscoveredModels({ data: [
    {
      id: "reasoning-gateway",
      display_name: "Reasoning Gateway",
      capabilities: {
        reasoning: false,
        input_modalities: ["text", "image", "unsupported"],
        context_window: 131072,
        max_output_tokens: 16384,
        pricing: { input: 1.2, output: 4.8, cacheRead: 0.2, cacheWrite: 0 },
      },
    },
    {
      id: "claude-synthetic",
      name: "Claude Synthetic",
      reasoning: true,
      contextWindow: 200000,
      maxTokens: 8192,
      input: ["text"],
      cost: { input: 3, output: 15, cacheWrite: 3.75 },
    },
    {
      name: "models/gemini-synthetic",
      displayName: "Gemini Synthetic",
      inputTokenLimit: 1048576,
      outputTokenLimit: 8192,
      capabilities: { vision: true, thinking: true, supportedEfforts: ["low", "high", "xhigh"] },
    },
  ] });

  assert.deepEqual(models, [
    {
      id: "claude-synthetic",
      name: "Claude Synthetic",
      reasoning: true,
      input: ["text"],
      contextWindow: 200000,
      maxTokens: 8192,
      cost: { input: 3, output: 15, cacheWrite: 3.75 },
    },
    {
      id: "gemini-synthetic",
      name: "Gemini Synthetic",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1048576,
      maxTokens: 8192,
      thinkingLevelMap: { minimal: null, medium: null, xhigh: "xhigh", max: null },
    },
    {
      id: "reasoning-gateway",
      name: "Reasoning Gateway",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 131072,
      maxTokens: 16384,
      cost: { input: 1.2, output: 4.8, cacheRead: 0.2, cacheWrite: 0 },
    },
  ]);
});

test("deduplicates on provider endpoint identity and fills missing fields without replacing false", () => {
  const first = { id: "same", api: "openai-completions", baseUrl: "https://one.example/v1", reasoning: false };
  const second = { id: "same", api: "openai-completions", baseUrl: "https://one.example/v1/", contextWindow: 32768 };
  const otherEndpoint = { id: "same", api: "openai-completions", baseUrl: "https://two.example/v1", reasoning: true };
  const models = parseDiscoveredModels({ data: [first, second, otherEndpoint] });
  assert.equal(models.length, 2);
  assert.deepEqual(models.find((model) => model.baseUrl?.includes("one.example")), {
    id: "same",
    api: "openai-completions",
    baseUrl: "https://one.example/v1",
    reasoning: false,
    contextWindow: 32768,
  });
  assert.notEqual(modelDiscoveryKey(models[0]), modelDiscoveryKey(models[1]));

  const merged = mergeDiscoveredModelMetadata(
    { id: "same", reasoning: false, name: "User name", cost: { input: 1 } },
    { id: "same", reasoning: true, name: "Upstream name", maxTokens: 4096, cost: { input: 2, output: 3 } },
  );
  assert.deepEqual(merged, {
    id: "same",
    reasoning: false,
    name: "User name",
    maxTokens: 4096,
    cost: { input: 1, output: 3 },
  });
  assert.deepEqual(discoveredModelToConfig({
    id: "same",
    api: "openai-completions",
    baseUrl: "https://one.example/v1",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 32768,
    maxTokens: 4096,
    cost: { input: 1 },
  }), {
    id: "same",
    api: "openai-completions",
    baseUrl: "https://one.example/v1",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 32768,
    maxTokens: 4096,
    cost: { input: 1 },
  });
});

test("retains SDK-disabled thinking levels when same-endpoint entries merge", () => {
  const base = {
    provider: "synthetic",
    id: "same",
    api: "openai-completions",
    baseUrl: "https://same.example/v1",
    reasoning: true,
    thinkingLevelMap: { high: "high" },
    cost: { input: 1 },
  };
  const incoming = {
    ...base,
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
  };
  const merged = mergeDiscoveredModelMetadata(base, incoming);
  assert.deepEqual(getSupportedThinkingLevels(merged), ["off", "high"]);

  const models = parseDiscoveredModels({ data: [base,
    {
      ...incoming,
      reasoning: false,
      cost: { input: null, output: 3 },
    },
  ] });

  assert.deepEqual(models, [{
    id: "same",
    api: "openai-completions",
    baseUrl: "https://same.example/v1",
    reasoning: true,
    thinkingLevelMap: { high: "high", minimal: null, low: null, medium: null, xhigh: null, max: null },
    cost: { input: 1, output: 3 },
  }]);
});

test("resolves environment-backed headers without an API key", async () => {
  process.env.PI_WEB_DISCOVERY_TEST_TOKEN = "resolved-token";
  try {
    const auth = await resolveModelDiscoveryAuth("pi-web-header-only-test", {
      baseUrl: "https://example.invalid/v1",
      api: "openai-completions",
      headers: { "X-Discovery-Token": "$PI_WEB_DISCOVERY_TEST_TOKEN" },
    });
    assert.equal(auth.apiKey, undefined);
    assert.deepEqual(auth.headers, { "X-Discovery-Token": "resolved-token" });
  } finally {
    delete process.env.PI_WEB_DISCOVERY_TEST_TOKEN;
  }
});

test("resolves the effective base URL and API for the requested provider", async () => {
  const configured = await resolveModelDiscoveryAuth("pi-web-baseurl-test", {
    baseUrl: "https://example.invalid/v1/",
    api: "anthropic-messages",
  });
  assert.equal(configured.baseUrl, "https://example.invalid/v1/");
  assert.equal(configured.api, "anthropic-messages");

  // A models-only entry keeps the endpoint and protocol pi ships for that
  // provider, so discovery does not depend on models.json repeating the base URL.
  const builtin = await resolveModelDiscoveryAuth("deepseek", {
    models: [{ id: "deepseek-flash" }],
  });
  assert.equal(builtin.baseUrl, "https://api.deepseek.com");
  assert.equal(builtin.api, "openai-completions");
});

test("asks for a Base URL when a custom provider has none and pi ships no endpoint", async () => {
  const { createJiti } = await import("jiti");
  const { POST } = await createJiti(import.meta.url, { tsconfigPaths: true })
    .import("../app/api/models-config/discover/route.ts");
  const response = await POST(new Request("http://localhost/api/models-config/discover", {
    method: "POST",
    headers: {
      host: "localhost",
      "content-type": "application/json",
    },
    body: JSON.stringify({ providerName: "pi-web-no-baseurl-test", provider: {} }),
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Base URL is required" });
});
