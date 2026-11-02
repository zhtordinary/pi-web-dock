import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { CONFIGURED_TOOL_PRESET, getPresetFromToolNames } from "../lib/tool-presets.ts";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const loadSessionSource = source.slice(
  source.indexOf("const loadSession = useCallback"),
  source.indexOf("const loadContext = useCallback"),
);
const switchSource = source.slice(
  source.indexOf("const handleModelChange = useCallback"),
  source.indexOf("const handleCompact = useCallback"),
);

const updateSource = source.slice(source.indexOf("const updateRuntimeSettings = useCallback"), source.indexOf("const handleModelChange = useCallback"));

function createReloadHarness() {
  const requests = [], commands = [], invalidations = [], modelWrites = [];
  const runtime = { messages: [{ role: "assistant", content: "live output" }], entryIds: ["live-entry"] };
  let data = { sessionId: "one", leafId: "old-leaf", context: runtime };
  let model = { provider: "test", modelId: "previously-confirmed" };
  const ctx = {
    useCallback: fn => fn, URLSearchParams, encodeURIComponent, AbortSignal,
    CONFIGURED_TOOL_PRESET, getPresetFromToolNames,
    apiPath: path => path,
    sessionHookMountedRef: { current: true }, sessionIdRef: { current: "one" },
    remotePeerRef: { current: null }, branchScopeRef: { current: "local:one" },
    sessionLoadGenerationRef: { current: 0 }, pendingSessionLoadRef: { current: null },
    blockingLoadOwnerRef: { current: null }, stateRunRevisionRef: { current: 0 },
    currentAgentRunIdRef: { current: null }, transcriptMutationRevisionRef: { current: 0 },
    sessionViewValidationPendingRef: { current: false }, sessionToolsPinnedRef: { current: false },
    reader: { getState: () => ({ transcript: runtime }) },
    branchRef: { current: { state: { phase: "current" }, observeRuntime() {} } },
    modelSwitchPendingRef: { current: false }, runtimeSettingsRevisionRef: { current: 0 },
    ensuringNewSessionRef: { current: null }, agentRunningRef: { current: false }, isNew: false,
    fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
    sendAgentCommandR: (sid, command) => new Promise(resolve => commands.push({ sid, command, resolve })),
    setData: value => { data = typeof value === "function" ? value(data) : value; },
    setCurrentModelOverride: value => {
      model = typeof value === "function" ? value(model) : value;
      modelWrites.push(model);
    },
    setRuntimeSettingsUpdating: value => { ctx.settingsUpdating = value; },
    setModelSwitching: value => { ctx.modelSwitching = value; },
    setSessionStatsOverride() {}, setLoading() {}, setFastModeSelection() {}, setFastModeRuntimeStatus() {},
    setQuestionAnalysisJobs() {}, setQuestionDraftViews() {}, setToolPresetState() {}, setActiveLeafId() {},
    setThinkingLevel() {}, setCurrentThinkingOverride() {}, setNewSessionModel() {},
    asConcreteThinkingLevel: value => value, t: key => key, addNotice: assert.fail,
    clearLoadedSessionView: assert.fail, setError: value => { assert.equal(value, null); },

  };
  vm.createContext(ctx);
  vm.runInContext(stripTypeScriptTypes(loadSessionSource + updateSource
    + "\nObject.assign(globalThis, { load: loadSession, update: updateRuntimeSettings });"), ctx);
  const respond = (request, leafId = "current-head") => request.resolve({ ok: true, status: 200,
    json: async () => ({ sessionId: "one", leafId, metadataOnly: true,
      context: { model: "stale-metadata-model", messages: [], entryIds: [] } }),
  });
  return { ctx, requests, commands, invalidations, modelWrites, runtime, respond,
    get model() { return model; }, get data() { return data; } };
}

test("existing-session configuration changes are serialized and acknowledged", () => {
  assert.match(updateSource, /if \(!sid \|\| modelSwitchPendingRef\.current\) return/);
  assert.match(updateSource, /setModelSwitching\(true\)/);
  assert.match(updateSource, /setModelSwitching\(false\)/);
  assert.match(switchSource, /await updateRuntimeSettings/);
  assert.match(switchSource, /setCurrentModelOverride\(target\)/);
});

test("metadata reloads cannot clear an in-flight or newly acknowledged model update", async () => {
  for (const acknowledgementFirst of [false, true]) {
    const h = createReloadHarness();
    const target = { provider: "test", modelId: "next" };
    const reload = h.ctx.load("one");
    const update = h.ctx.update({ type: "set_model", ...target }, () => h.ctx.setCurrentModelOverride(target));
    assert.equal(h.ctx.modelSwitchPendingRef.current, true);
    assert.equal(h.commands.length, 1);
    assert.equal(h.commands[0].sid, "one");
    if (acknowledgementFirst) {
      h.commands[0].resolve({});
      await update;
    }
    h.respond(h.requests[0]);
    assert.equal((await reload).leafId, "current-head");
    assert.equal(h.ctx.modelSwitchPendingRef.current, !acknowledgementFirst);
    assert.equal(h.ctx.modelSwitching, !acknowledgementFirst);
    assert.equal(h.ctx.settingsUpdating, !acknowledgementFirst);
    assert.deepEqual(h.model, acknowledgementFirst ? target : { provider: "test", modelId: "previously-confirmed" });
    assert.equal(h.modelWrites.length, acknowledgementFirst ? 1 : 0);
    if (!acknowledgementFirst) {
      h.commands[0].resolve({});
      await update;
    }
    assert.deepEqual(h.model, target);
    assert.equal(h.modelWrites.length, 1);
    assert.equal(h.ctx.modelSwitchPendingRef.current, false);
    assert.equal(h.runtime.messages[0].content, "live output", "metadata cannot replace the transcript");
    assert.equal(h.runtime.entryIds[0], "live-entry");
    assert.deepEqual(h.invalidations, [], "metadata cannot invalidate the transcript");
  }
});

test("a setting change preserves the streaming transcript and reconciles failures from get_state", () => {
  assert.doesNotMatch(updateSource + switchSource, /loadSession\(/);
  assert.match(updateSource, /type: "get_state"/);
  assert.match(updateSource, /setCurrentModelOverride\(actual\)/);
  assert.match(updateSource, /type: "error"/);
  assert.match(updateSource, /runtimeSettingsRevisionRef/);
});

test("model switches keep per-model defaults for new drafts and use server-confirmed thinking", () => {
  assert.match(switchSource, /resolveDefaultThinkingLevel\(modelThinkingLevels/);
  assert.match(switchSource, /modelThinkingLevelDefaults\[.*provider/);
  assert.match(switchSource, /modelThinkingLevelPins\[.*provider/);
  assert.match(switchSource, /thinkingLevelOverrideRef\.current = asConcreteThinkingLevel\(level\)/);
  assert.match(switchSource, /setThinkingLevel\(result.thinkingLevel\)/);
});

test("model config refresh re-reads live context usage after the model list refresh", () => {
  assert.match(source, /A models\.json save refreshes the live runtime/);
  assert.match(source, /fetch\(apiPath\(`agent\/\$\{encodeURIComponent\(sid\)\}`/);
  assert.match(source, /state\?\.contextUsage !== undefined/);
  assert.match(source, /\[apiPath, modelsRefreshKey\]/);
  assert.match(source, /modelConfigRevision: modelsRefreshKey/);
});

test("metadata reload targets current head by default and preserves an explicit leaf", async () => {
  for (const targetLeafId of [undefined, null, "chosen-leaf"]) {
    const h = createReloadHarness();
    const reload = h.ctx.load("one", false, targetLeafId);
    const request = h.requests[0];
    const url = new URL(request.url, "https://test.invalid/");
    assert.equal(url.pathname, "/sessions/one");
    assert.equal(url.searchParams.get("metadataOnly"), "1");
    assert.equal(url.searchParams.get("leafId"), targetLeafId ?? null);
    assert.equal(request.options.cache, "no-store");
    const observedLeaf = targetLeafId ?? "server-current-head";
    h.respond(request, observedLeaf);
    assert.equal((await reload).leafId, observedLeaf);
    assert.deepEqual(h.invalidations, []);
    assert.equal(h.runtime.messages[0].content, "live output");
  }
  assert.doesNotMatch(loadSessionSource, /activeLeafIdRef/);
  assert.doesNotMatch(source, /activeLeafIdRef/);
});

test("AppShell prioritizes live context usage over cost fallback", async () => {
  const appShell = await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
  assert.match(appShell, /const \[liveContextUsageSnapshot, setLiveContextUsageSnapshot\] = useState/);
  assert.match(appShell, /const liveContextUsage = liveContextUsageSnapshot\?\.sessionId === topBarSessionId/);
  assert.match(appShell, /contextUsage = liveContextUsage \?\? topBarDetails\.cost\?\.contextUsage \?\? null/);
  assert.doesNotMatch(appShell, /useEffect\(\(\) => \{\s*const usage = topBarDetails\.cost\?\.contextUsage;\s*if \(usage\) setContextUsage\(usage\);/);
});
