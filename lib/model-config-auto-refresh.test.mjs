import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentSessionWrapper, refreshRpcSessionModels } = await jiti.import("./rpc-manager.ts");

test("syncModelConfigIfStale detects disk mtime advancement and refreshes runtime model", async (t) => {
  const modelV1 = { provider: "cpa", id: "gpt-5.6-luna", apiKey: "key-v1", baseUrl: "https://old.example.test", compat: { forceAdaptiveThinking: true } };
  const modelV2 = { provider: "cpa", id: "gpt-5.6-luna", apiKey: "key-v2", baseUrl: "https://new.example.test", compat: { forceAdaptiveThinking: false } };
  let refreshCalls = 0;
  let failRefresh = false;
  let currentActive = modelV1;

  const inner = {
    isBashRunning: false,
    isStreaming: false,
    isCompacting: false,
    get model() { return currentActive; },
    set model(m) { currentActive = m; },
    modelRuntime: {
      refresh: async () => {
        refreshCalls += 1;
        if (failRefresh) throw new Error("transient refresh failure");
        currentActive = modelV2;
      },
      getModel: (p, id) => (p === "cpa" && id === "gpt-5.6-luna" ? currentActive : undefined),
    },
    extensionRunner: {},
    sessionManager: { getCwd: () => "/tmp" },
    agent: { state: { model: modelV1 } },
    dispose() {},
  };

  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());

  // Manually invoke syncModelConfigIfStale when simulated mtime is newer
  let mtime = 1000;
  wrapper.getModelsConfigMtime = () => mtime;

  // First sync records baseline without refresh
  await wrapper.syncModelConfigIfStale();
  assert.equal(refreshCalls, 0);
  assert.equal(inner.agent.state.model.apiKey, "key-v1");

  // Disk advances mtime
  mtime = 2000;
  await wrapper.syncModelConfigIfStale();
  assert.equal(refreshCalls, 1);
  assert.equal(inner.agent.state.model.apiKey, "key-v2");
  assert.equal(inner.agent.state.model.baseUrl, "https://new.example.test");
  assert.equal(inner.agent.state.model.compat.forceAdaptiveThinking, false);
  assert.deepEqual([inner.agent.state.model.provider, inner.agent.state.model.id], ["cpa", "gpt-5.6-luna"]);

  // Unchanged mtime does not trigger another refresh
  await wrapper.syncModelConfigIfStale();
  assert.equal(refreshCalls, 1);

  // A failed refresh leaves mtime eligible so next prompt can retry.
  mtime = 3000;
  failRefresh = true;
  await assert.rejects(() => wrapper.syncModelConfigIfStale(), /transient refresh failure/);
  failRefresh = false;
  await wrapper.syncModelConfigIfStale();
  assert.equal(refreshCalls, 3);
});

test("bounded model refresh reports slow sessions without blocking a config save", async () => {
  const previousSessions = globalThis.__piSessions;
  let releaseSlowRefresh;
  const slowRefresh = new Promise((resolve) => { releaseSlowRefresh = resolve; });
  globalThis.__piSessions = new Map([
    ["fast", { sessionId: "fast", isAlive: () => true, refreshModelConfig: async () => true }],
    ["slow", { sessionId: "slow", isAlive: () => true, refreshModelConfig: () => slowRefresh }],
  ]);

  try {
    const result = await refreshRpcSessionModels({ timeoutMs: 10 });
    assert.equal(result.liveSessions, 2);
    assert.equal(result.refreshedSessions, 1);
    assert.deepEqual(result.failedSessionIds, []);
    assert.deepEqual(result.timedOutSessionIds, ["slow"]);
  } finally {
    releaseSlowRefresh();
    if (previousSessions === undefined) delete globalThis.__piSessions;
    else globalThis.__piSessions = previousSessions;
  }
});
