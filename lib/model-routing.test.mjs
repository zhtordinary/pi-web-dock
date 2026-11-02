import test from "node:test";
import assert from "node:assert/strict";

async function loadSubject() {
  return import("./model-routing.ts");
}

const mockConfig = {
  enabled: true,
  routes: [
    { id: "1", provider: "CPA GPT", model: "gpt-5.6-luna", thinkingLevel: "max" },
    { id: "2", provider: "Sub2API GPT", model: "gpt-5.6-luna", thinkingLevel: "max" },
    { id: "3", provider: "Sub2API WorkBuddy", model: "deepseek-v4-pro", thinkingLevel: "max" },
  ],
};

const providerModels = {
  "CPA GPT": ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
  "Sub2API GPT": ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
  "Sub2API WorkBuddy": ["deepseek-v4-flash", "deepseek-v4-pro", "kimi-k2.6"],
};

const getModels = (p) => providerModels[p];

test("scenario 1: uses the route preset instead of inheriting an out-of-route model", async () => {
  const { resolveNextRoute } = await loadSubject();
  const tried = new Set(["CPA GPT"]);
  const next = resolveNextRoute(
    mockConfig,
    "CPA GPT",
    "gpt-5.6-sol",
    "medium",
    tried,
    getModels,
  );

  assert.deepEqual(next, {
    provider: "Sub2API GPT",
    modelId: "gpt-5.6-luna",
    thinkingLevel: "max",
    inherited: false,
  });
});

test("skips a route when its provider model catalog is missing", async () => {
  const { resolveNextRoute } = await loadSubject();
  const config = {
    enabled: true,
    routes: [
      { id: "1", provider: "CPA GPT", model: "gpt-5.6-luna", thinkingLevel: "max" },
      { id: "2", provider: "Missing Provider", model: "missing-model", thinkingLevel: "high" },
      { id: "3", provider: "Sub2API GPT", model: "gpt-5.6-luna", thinkingLevel: "max" },
    ],
  };
  const next = resolveNextRoute(
    config,
    "CPA GPT",
    "gpt-5.6-luna",
    "max",
    new Set(["CPA GPT"]),
    (provider) => provider === "Sub2API GPT" ? ["gpt-5.6-luna"] : undefined,
  );

  assert.deepEqual(next, {
    provider: "Sub2API GPT",
    modelId: "gpt-5.6-luna",
    thinkingLevel: "max",
    inherited: true,
  });
});

test("skips a route when its configured model is unavailable", async () => {
  const { resolveNextRoute } = await loadSubject();
  const config = {
    enabled: true,
    routes: [
      { id: "1", provider: "CPA GPT", model: "gpt-5.6-luna", thinkingLevel: "max" },
      { id: "2", provider: "Sub2API GPT", model: "gpt-6-luna", thinkingLevel: "max" },
      { id: "3", provider: "Sub2API WorkBuddy", model: "deepseek-v4-pro", thinkingLevel: "high" },
    ],
  };
  const next = resolveNextRoute(
    config,
    "CPA GPT",
    "gpt-5.6-luna",
    "max",
    new Set(["CPA GPT"]),
    (provider) => provider === "Sub2API GPT"
      ? ["gpt-6-astra", "gpt-5.6-luna"]
      : provider === "Sub2API WorkBuddy"
        ? ["deepseek-v4-flash", "deepseek-v4-pro"]
        : undefined,
  );

  assert.deepEqual(next, {
    provider: "Sub2API WorkBuddy",
    modelId: "deepseek-v4-pro",
    thinkingLevel: "high",
    inherited: false,
  });
});

test("stops when only the current model is available and the route model is missing", async () => {
  const { resolveNextRoute } = await loadSubject();
  const config = {
    enabled: true,
    routes: [
      { id: "1", provider: "CPA GPT", model: "gpt-5.6-luna", thinkingLevel: "max" },
      { id: "2", provider: "Sub2API GPT", model: "gpt-6-luna", thinkingLevel: "max" },
    ],
  };
  const next = resolveNextRoute(
    config,
    "CPA GPT",
    "gpt-5.6-sol",
    "medium",
    new Set(["CPA GPT"]),
    () => ["gpt-5.6-sol"],
  );

  assert.equal(next, null, "do not inherit the current model when the route preset is unavailable");
});

test("scenario 1 step 2: falls back to preset model and thinkingLevel when next provider lacks current model", async () => {
  const { resolveNextRoute } = await loadSubject();
  const tried = new Set(["CPA GPT", "Sub2API GPT"]);
  const next = resolveNextRoute(
    mockConfig,
    "Sub2API GPT",
    "gpt-5.6-sol",
    "medium",
    tried,
    getModels,
  );

  assert.deepEqual(next, {
    provider: "Sub2API WorkBuddy",
    modelId: "deepseek-v4-pro",
    thinkingLevel: "max",
    inherited: false,
  });
});

test("scenario 2: when current session is Sub2API, tries CPA first, then WorkBuddy", async () => {
  const { resolveNextRoute } = await loadSubject();
  const tried = new Set(["Sub2API GPT"]);
  const next1 = resolveNextRoute(
    mockConfig,
    "Sub2API GPT",
    "gpt-5.6-luna",
    "max",
    tried,
    getModels,
  );
  assert.equal(next1.provider, "CPA GPT");
  assert.equal(next1.modelId, "gpt-5.6-luna");
  assert.equal(next1.inherited, true);

  tried.add("CPA GPT");
  const next2 = resolveNextRoute(
    mockConfig,
    "CPA GPT",
    "gpt-5.6-luna",
    "max",
    tried,
    getModels,
  );
  assert.equal(next2.provider, "Sub2API WorkBuddy");
  assert.equal(next2.modelId, "deepseek-v4-pro");
  assert.equal(next2.inherited, false);
});

test("scenario 3: when current session is WorkBuddy, tries CPA first, then Sub2API, then stops", async () => {
  const { resolveNextRoute } = await loadSubject();
  const tried = new Set(["Sub2API WorkBuddy"]);
  const next1 = resolveNextRoute(
    mockConfig,
    "Sub2API WorkBuddy",
    "deepseek-v4-pro",
    "max",
    tried,
    getModels,
  );
  assert.equal(next1.provider, "CPA GPT");

  tried.add("CPA GPT");
  const next2 = resolveNextRoute(
    mockConfig,
    "CPA GPT",
    "deepseek-v4-pro",
    "max",
    tried,
    getModels,
  );
  assert.equal(next2.provider, "Sub2API GPT");

  tried.add("Sub2API GPT");
  const next3 = resolveNextRoute(
    mockConfig,
    "Sub2API GPT",
    "deepseek-v4-pro",
    "max",
    tried,
    getModels,
  );
  assert.equal(next3, null, "All providers tried, must return null without infinite loop");
});

test("does not route a provider outside the configured priority list", async () => {
  const { resolveNextRoute } = await loadSubject();
  const next = resolveNextRoute(
    mockConfig,
    "Sub2API 国产",
    "glm-5.3",
    "max",
    new Set(["Sub2API 国产"]),
    getModels,
  );

  assert.equal(next, null, "manually selected providers outside the route list must not be auto-switched");
});

test("returns null when config is disabled or routes empty", async () => {
  const { resolveNextRoute } = await loadSubject();
  assert.equal(
    resolveNextRoute({ enabled: false, routes: mockConfig.routes }, "CPA GPT", "gpt-5.6-sol", "medium", new Set(), getModels),
    null,
  );
  assert.equal(
    resolveNextRoute({ enabled: true, routes: [] }, "CPA GPT", "gpt-5.6-sol", "medium", new Set(), getModels),
    null,
  );
});

test("normalizes legacy routes to four attempts and uses bounded exponential backoff", async () => {
  const { getModelRoutingRetryDelayMs, normalizeRouteMaxAttempts, getRouteMaxAttempts, resolveNextRoute } = await loadSubject();
  assert.equal(normalizeRouteMaxAttempts(undefined), 4);
  assert.equal(normalizeRouteMaxAttempts(0), 1);
  assert.equal(normalizeRouteMaxAttempts(99), 20);
  assert.equal(getRouteMaxAttempts({}), 4);
  assert.deepEqual([1, 2, 3, 4, 5].map(getModelRoutingRetryDelayMs), [1000, 2000, 4000, 8000, 8000]);

  let retryCount = 0;
  let currentProvider = "CPA GPT";
  let currentModel = "gpt-5.6-sol";
  let currentThinking = "medium";
  const tried = new Set([currentProvider]);

  // The default route allows four failed retries before switching.
  retryCount++;
  assert.equal(retryCount < 4, true, "1 retry failure should not trigger switch");
  retryCount++;
  retryCount++;
  assert.equal(retryCount < 4, true, "3 retry failures should not trigger switch");
  retryCount++;
  assert.equal(retryCount >= 4, true, "4 retry failures trigger switch");

  // Route
  const route = resolveNextRoute(
    mockConfig,
    currentProvider,
    currentModel,
    currentThinking,
    tried,
    getModels,
  );
  assert.ok(route);
  assert.equal(route.provider, "Sub2API GPT");
  assert.equal(route.modelId, "gpt-5.6-luna");

  // Once switched, treated as new:
  currentProvider = route.provider;
  currentModel = route.modelId;
  currentThinking = route.thinkingLevel;
  retryCount = 0;
  tried.add(currentProvider);

  // New provider also gets the default four retries.
  retryCount++;
  assert.equal(retryCount < 4, true);
  retryCount++;
  retryCount++;
  retryCount++;
  assert.equal(retryCount >= 4, true);

  // Switches to 3rd
  const route3 = resolveNextRoute(
    mockConfig,
    currentProvider,
    currentModel,
    currentThinking,
    tried,
    getModels,
  );
  assert.ok(route3);
  assert.equal(route3.provider, "Sub2API WorkBuddy");
  assert.equal(route3.modelId, "deepseek-v4-pro");
});
