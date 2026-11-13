import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { cancelSessionCost, clearSessionDetailsCache, ensureSessionCost, ensureSessionPreview, ensureSessionUserQuestions, invalidateSessionDetails, readSessionDetails, releaseSessionCost, retainSessionCost } from "./session-details-client.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSessionDetailsCache();
});

test("session details client typechecks with the project configuration", () => {
  const configPath = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, fileURLToPath(new URL("..", import.meta.url)), { incremental: false }, configPath);
  const program = ts.createProgram([fileURLToPath(new URL("./session-details-client.ts", import.meta.url))], parsed.options);
  const errors = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)].filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, ts.formatDiagnostics(errors, {
    getCanonicalFileName: (file) => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n",
  }));
});

test("summary cost requests stay within the fixed client concurrency limit", async () => {
  let active = 0;
  let maximum = 0;
  const releases = [];
  globalThis.fetch = async (input) => {
    assert.match(String(input), /view=summary/);
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => releases.push(resolve));
    active -= 1;
    return { ok: true, status: 200, json: async () => ({ amount: 1, status: "calculated", usage: null }) };
  };
  const requests = Array.from({ length: 12 }, (_, index) => ensureSessionCost({ sessionId: `summary-${index}`, version: "v1", costView: "summary" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximum, 4);
  cancelSessionCost({ sessionId: "summary-11", version: "v1", costView: "summary" });
  while (releases.length) {
    releases.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(requests);
  assert.equal(maximum, 4);
});

test("does not cancel a shared queued summary until the last consumer releases it", async () => {
  let calls = 0;
  const blockers = [];
  globalThis.fetch = async () => {
    calls += 1;
    if (calls <= 5) await new Promise((resolve) => blockers.push(resolve));
    return { ok: true, status: 200, json: async () => ({ amount: calls, status: "calculated" }) };
  };
  const active = Array.from({ length: 4 }, (_, index) => ensureSessionCost({ sessionId: `active-${index}`, version: "v1", costView: "summary" }));
  await new Promise((resolve) => setImmediate(resolve));
  const other = ensureSessionCost({ sessionId: "other", version: "v1", costView: "summary" });
  const shared = { sessionId: "shared", version: "v1", costView: "summary" };
  retainSessionCost(shared); retainSessionCost(shared);
  const sharedResult = ensureSessionCost(shared);
  releaseSessionCost(shared);
  blockers.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 5, "the other queued request may start while one shared consumer remains");
  releaseSessionCost(shared);
  for (const release of blockers) release();
  await other;
  assert.equal(await sharedResult, null, "a cancelled queued summary settles with null");
  await Promise.all(active);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 5, "the last release cancels only the still-queued shared request");
});

test("32 visible summary sessions stay within the fixed queue and preserve every result", async () => {
  let active = 0;
  let maximum = 0;
  const releases = [];
  globalThis.fetch = async (input) => {
    assert.match(String(input), /view=summary/);
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => releases.push(resolve));
    active -= 1;
    return { ok: true, status: 200, json: async () => ({ amount: 7, status: "calculated", usage: null }) };
  };
  const requests = Array.from({ length: 32 }, (_, index) => ensureSessionCost({ sessionId: `visible-${index}`, version: "same", costView: "summary" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximum, 4);
  while (releases.length) {
    releases.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  }
  const results = await Promise.all(requests);
  assert.equal(maximum, 4);
  assert.equal(results.length, 32);
  assert.ok(results.every((result) => result?.amount === 7 && result.status === "calculated"));
});

test("shares one cost request between activity row and selected chat", async () => {
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls += 1;
    assert.equal(String(input), "/api/sessions/session-1/cost");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        amount: 1.25,
        currency: "USD",
        status: "calculated",
        usage: { inputTokens: 100, cachedInputTokens: 50, cacheWriteTokens: 0, outputTokens: 20, reasoningTokens: 0, totalTokens: 170 },
        contextUsage: { percent: 42.5, contextWindow: 128000, tokens: 54400 },
        compactionContexts: { compact: { tokensBefore: 118400, contextWindow: 128000, provider: "anthropic", model: "claude-test" } },
        messageCosts: { assistant: 1.25 },
      }),
    };
  };
  const request = { sessionId: "session-1", version: "v1" };
  const [row, chat] = await Promise.all([ensureSessionCost(request), ensureSessionCost(request)]);
  assert.equal(calls, 1);
  assert.deepEqual(chat, row);
  assert.equal(row?.cacheHitRate, 33.33333333333333);
  assert.deepEqual(row?.contextUsage, { percent: 42.5, contextWindow: 128000, tokens: 54400 });
  assert.deepEqual(row?.compactionContexts, { compact: { tokensBefore: 118400, contextWindow: 128000, provider: "anthropic", model: "claude-test" } });
  assert.deepEqual(readSessionDetails("local:session-1:v1").cost, row);
});

test("keeps same session ids isolated by peer/device scope", async () => {
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls += 1;
    assert.match(String(input), /cost/);
    return { ok: true, status: 200, json: async () => ({ amount: calls, status: "calculated" }) };
  };
  const local = await ensureSessionCost({ sessionId: "same", version: "v1", deviceId: "device-a" });
  const other = await ensureSessionCost({ sessionId: "same", version: "v1", deviceId: "device-b" });
  assert.equal(calls, 2);
  assert.equal(local?.amount, 1);
  assert.equal(other?.amount, 2);
});

test("refetches context usage after the model config revision changes", async () => {
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls += 1;
    assert.equal(String(input), "/api/sessions/session-1/cost");
    const contextWindow = calls === 1 ? 256000 : 512000;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        amount: 0,
        currency: "USD",
        status: "calculated",
        usage: null,
        contextUsage: { percent: 1, contextWindow, tokens: 1000 },
      }),
    };
  };

  const first = await ensureSessionCost({ sessionId: "session-1", version: "same", modelConfigRevision: 0 });
  const second = await ensureSessionCost({ sessionId: "session-1", version: "same", modelConfigRevision: 1 });

  assert.equal(calls, 2);
  assert.equal(first?.contextUsage?.contextWindow, 256000);
  assert.equal(second?.contextUsage?.contextWindow, 512000);
});

test("refreshing versioned session cost also clears the revisionless activity cache", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ amount: calls, currency: "USD", status: "calculated" }),
    };
  };

  const activityRequest = { sessionId: "session-1", version: "same" };
  const topBarRequest = { ...activityRequest, modelConfigRevision: 1 };
  const oldActivityCost = await ensureSessionCost(activityRequest);
  const oldTopBarCost = await ensureSessionCost(topBarRequest);
  assert.equal(oldActivityCost?.amount, 1);
  assert.equal(oldTopBarCost?.amount, 2);

  invalidateSessionDetails(topBarRequest);
  invalidateSessionDetails(activityRequest);
  assert.equal(readSessionDetails("local:session-1:same").cost, undefined);
  assert.equal(readSessionDetails("local:session-1:same:1").cost, undefined);

  const refreshedActivityCost = await ensureSessionCost(activityRequest);
  assert.equal(refreshedActivityCost?.amount, 3);
});

test("distinguishes cost errors from an in-flight loading state", async () => {
  let resolveFetch;
  globalThis.fetch = () => new Promise((resolve) => { resolveFetch = resolve; });
  const request = { sessionId: "session-error", version: "v1" };
  const pending = ensureSessionCost(request);
  assert.equal(readSessionDetails("local:session-error:v1").costState, "loading");
  resolveFetch({ ok: false, status: 503, json: async () => ({}) });
  assert.equal(await pending, null);
  assert.equal(readSessionDetails("local:session-error:v1").costState, "error");
});

test("keeps partial cost and missing model details", async () => {
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "/api/sessions/session-1/cost");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        amount: 0,
        currency: "USD",
        status: "partial",
        missingPriceModels: ["unknown-model", 42, ""],
        pendingUsageCount: 2,
        pendingUsageModels: ["pending-model", 42, ""],
        usage: { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0, totalTokens: 110 },
        compactionCosts: {
          compact: {
            amount: 0,
            currency: "USD",
            status: "partial",
            model: "unknown-model",
            usage: { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0, totalTokens: 110 },
          },
        },
      }),
    };
  };
  const cost = await ensureSessionCost({ sessionId: "session-1", version: "v2" });
  assert.equal(cost?.amount, 0);
  assert.equal(cost?.status, "partial");
  assert.deepEqual(cost?.missingPriceModels, ["unknown-model"]);
  assert.equal(cost?.pendingUsageCount, 2);
  assert.deepEqual(cost?.pendingUsageModels, ["pending-model"]);
  assert.equal(cost?.compactionCosts.compact.status, "partial");
  assert.equal(cost?.compactionCosts.compact.amount, 0);
});

test("does not turn a partial summary without a numeric amount into a zero lower bound", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      amount: null,
      status: "partial",
      missingPriceModels: ["openai/unknown-model"],
      usage: null,
      parentCost: {
        amount: null,
        currency: "USD",
        status: "partial",
        usage: null,
        sessionCount: 1,
        missingPriceModels: ["openai/unknown-model"],
        unavailableSessions: 0,
      },
      totalCost: {
        amount: null,
        currency: "USD",
        status: "partial",
        usage: null,
        sessionCount: 1,
        missingPriceModels: ["openai/unknown-model"],
        unavailableSessions: 0,
      },
      compactionCosts: {
        compact: {
          amount: null,
          currency: "USD",
          status: "partial",
          model: "openai/unknown-model",
          usage: { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 1 },
        },
      },
    }),
  });

  const cost = await ensureSessionCost({ sessionId: "session-1", version: "invalid-partial" });
  assert.equal(cost?.status, "unavailable");
  assert.equal(cost?.amount, null);
  assert.equal(cost?.parentCost.status, "unavailable");
  assert.equal(cost?.parentCost.amount, null);
  assert.equal(cost?.totalCost.status, "unavailable");
  assert.equal(cost?.totalCost.amount, null);
  assert.equal(cost?.compactionCosts.compact.status, "unavailable");
  assert.equal(cost?.compactionCosts.compact.amount, null);
});

test("shares preview request between hover and top bar", async () => {
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls += 1;
    assert.equal(String(input), "/api/sessions/session-1/hover-preview");
    return { ok: true, status: 200, json: async () => ({ recap: { recap: "done" } }) };
  };
  const request = { sessionId: "session-1", version: "v1" };
  const [hover, topBar] = await Promise.all([ensureSessionPreview(request), ensureSessionPreview(request)]);
  assert.equal(calls, 1);
  assert.deepEqual(topBar, hover);
});


test("loads all user questions only through explicit lazy request and shares it", async () => {
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls += 1;
    assert.equal(String(input), "/api/sessions/session-1/hover-preview?section=user-question");
    return { ok: true, status: 200, json: async () => ({ userQuestions: ["first question", "second question"] }) };
  };
  const request = { sessionId: "session-1", version: "v1" };
  const [first, second] = await Promise.all([ensureSessionUserQuestions(request), ensureSessionUserQuestions(request)]);
  assert.equal(calls, 1);
  assert.deepEqual(first, ["first question", "second question"]);
  assert.deepEqual(second, first);
  assert.deepEqual(readSessionDetails("local:session-1:v1").userQuestions, first);
});

test("routes lazy questions through peer URL", async () => {
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "/api/remote/sessions/session-1/hover-preview?section=user-question&peer=debian");
    return { ok: true, status: 200, json: async () => ({ userQuestions: ["remote question"] }) };
  };
  const questions = await ensureSessionUserQuestions({ sessionId: "session-1", peer: "debian" });
  assert.deepEqual(questions, ["remote question"]);
});

test("invalidating keeps subscribers on same key and ignores stale response", async () => {
  let calls = 0;
  const responses = [];
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => responses.shift() };
  };
  const request = { sessionId: "session-1", version: "v1" };
  responses.push({ amount: 1, currency: "USD", status: "calculated", usage: null });
  const first = ensureSessionCost(request);
  invalidateSessionDetails(request);
  responses.push({ amount: 2, currency: "USD", status: "calculated", usage: null });
  const second = ensureSessionCost(request);
  await Promise.all([first, second]);
  assert.equal(calls, 2);
  assert.equal(readSessionDetails("local:session-1:v1").cost?.amount, 2);
});

test("parses parent, subagent, and total cost summaries", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      amount: 3,
      currency: "USD",
      status: "calculated",
      usage: { inputTokens: 300, cachedInputTokens: 50, cacheWriteTokens: 0, outputTokens: 30, reasoningTokens: 0, totalTokens: 380 },
      parentCost: {
        amount: 2,
        currency: "USD",
        status: "calculated",
        usage: { inputTokens: 200, cachedInputTokens: 20, cacheWriteTokens: 0, outputTokens: 20, reasoningTokens: 0, totalTokens: 240 },
        sessionCount: 1,
        missingPriceModels: [],
        unavailableSessions: 0,
      },
      childCost: {
        amount: 1,
        currency: "USD",
        status: "calculated",
        usage: { inputTokens: 100, cachedInputTokens: 30, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0, totalTokens: 140 },
        sessionCount: 2,
        missingPriceModels: [],
        unavailableSessions: 0,
      },
      mainCost: {
        amount: 2,
        currency: "USD",
        status: "calculated",
        usage: { inputTokens: 200, cachedInputTokens: 20, cacheWriteTokens: 0, outputTokens: 20, reasoningTokens: 0, totalTokens: 240 },
        sessionCount: 1,
        missingPriceModels: [],
        unavailableSessions: 0,
      },
      recapCost: {
        amount: 0.5,
        currency: "USD",
        status: "calculated",
        usage: { inputTokens: 10, cachedInputTokens: 5, cacheWriteTokens: 0, outputTokens: 2, reasoningTokens: 0, totalTokens: 17 },
        sessionCount: 1,
        missingPriceModels: [],
        unavailableSessions: 0,
      },
      extensionCosts: [{ id: "fixture-extension", amount: 0.25, currency: "USD", status: "partial", usage: null,
        sessionCount: 1, models: ["openai/model"], missingPriceModels: ["unknown/unknown"], unavailableSessions: 0, historicalIncomplete: true, historicalEstimated: true }, { id: "" }],
      totalCost: {
        amount: 3,
        currency: "USD",
        status: "calculated",
        usage: { inputTokens: 300, cachedInputTokens: 50, cacheWriteTokens: 0, outputTokens: 30, reasoningTokens: 0, totalTokens: 380 },
        sessionCount: 3,
        missingPriceModels: [],
        unavailableSessions: 0,
      },
    }),
  });
  const cost = await ensureSessionCost({ sessionId: "session-1", version: "breakdown" });
  assert.equal(cost?.parentCost.amount, 2);
  assert.equal(cost?.childCost.amount, 1);
  assert.equal(cost?.childCost.sessionCount, 2);
  assert.equal(cost?.mainCost.amount, 2);
  assert.equal(cost?.recapCost.amount, 0.5);
  assert.equal(cost?.recapCacheHitRate, 33.33333333333333);
  assert.equal(cost?.extensionCosts.length, 1);
  assert.equal(cost?.extensionCosts[0].id, "fixture-extension");
  assert.equal(cost?.extensionCosts[0].historicalIncomplete, true);
  assert.equal(cost?.extensionCosts[0].historicalEstimated, true);
  assert.equal(cost?.extensionCosts[0].status, "partial");
  assert.equal(cost?.totalCost.amount, 3);
  assert.equal(cost?.amount, 3);
  assert.equal(cost?.usage.totalTokens, 240);
});

for (const peer of [undefined, "debian"]) {
  test(`summary cost is isolated from full context and explicitly invalidated (${peer ?? "local"})`, async () => {
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      const summary = String(url).includes("view=summary");
      return { ok: true, json: async () => ({
        amount: 1, status: "calculated",
        ...(summary ? {} : { contextUsage: { tokens: 1000, contextWindow: 128000, percent: 1 } }),
      }) };
    };
    const full = { sessionId: "s", version: "v", peer };
    const summary = { ...full, costView: "summary" };
    const [row, duplicate] = await Promise.all([ensureSessionCost(summary), ensureSessionCost(summary)]);
    assert.equal(urls.length, 1);
    assert.deepEqual(row, duplicate);
    assert.match(urls[0], /[?&]view=summary(?:&|$)/);
    if (peer) assert.match(urls[0], /[?&]peer=debian/);
    const chat = await ensureSessionCost(full);
    assert.equal(urls.length, 2);
    assert.equal(chat.contextUsage.contextWindow, 128000);
    assert.equal(row.contextUsage, null);
    invalidateSessionDetails(full);
    await ensureSessionCost(summary);
    await ensureSessionCost(full);
    assert.equal(urls.length, 4, "full refresh invalidates both representations");
  });
}
