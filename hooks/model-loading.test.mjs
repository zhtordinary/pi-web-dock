import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

const sourceText = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("useAgentSession.ts", sourceText, ts.ScriptTarget.Latest, true);
const nodes = [];
function visit(node) {
  nodes.push(node);
  ts.forEachChild(node, visit);
}
visit(source);

const loader = nodes.find((node) => ts.isVariableDeclaration(node)
  && node.name.getText(source) === "loadModels");
const effect = nodes.find((node) => ts.isCallExpression(node)
  && node.expression.getText(source) === "useEffect"
  && node.arguments[1]?.getText(source) === "[loadModels, modelsRefreshKey]");
assert.ok(loader, "loadModels callback must remain discoverable");
assert.ok(effect, "model refresh effect must remain discoverable");

function script(text) {
  return new Script(ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText);
}

const loadScript = script(`(${loader.initializer.arguments[0].getText(source)})`);
const effectScript = script(effect.arguments[0].getText(source));

function makeState(fetchImpl) {
  const writes = [];
  const context = {
    Error,
    DOMException,
    Response,
    AbortController,
    apiPath: (path) => path,
    newSessionCwd: "/project",
    session: null,
    isNew: true,
    sessionIdRef: { current: null },
    thinkingLevelOverrideRef: { current: null },
    modelListRequestRevisionRef: { current: 0 },
    branchScopeRef: { current: "peer:session" },
    remotePeerRef: { current: "peer" },
    sessionHookMountedRef: { current: true },
    apiPath: (path) => path,
    asConcreteThinkingLevel: (value) => (!value || value === "auto" ? null : value),
    resolveDefaultThinkingLevel: (levels, preferred, pin) => preferred && levels?.includes(preferred)
      ? preferred : pin ?? levels?.at(-1) ?? null,
    fetch: fetchImpl,
    setModelNames: (value) => writes.push(["modelNames", value]),
    setModelError: (value) => writes.push(["modelError", value]),
    setModelScopeWarnings: (value) => writes.push(["modelScopeWarnings", value]),
    setModelThinkingLevels: (value) => writes.push(["thinkingLevels", value]),
    setModelThinkingLevelMaps: (value) => writes.push(["thinkingLevelMaps", value]),
    setModelThinkingLevelPins: (value) => writes.push(["thinkingLevelPins", value]),
    setModelThinkingLevelDefaults: (value) => writes.push(["thinkingLevelDefaults", value]),
    setModelList: (value) => writes.push(["modelList", value]),
    setNewSessionDefaultModel: (value) => writes.push(["defaultModel", value]),
    setThinkingLevel: (value) => writes.push(["thinkingLevel", value]),
    setNewSessionDefaultThinkingLevel: (value) => writes.push(["defaultThinking", value]),
    setSavedDefaultThinkingLevel: (value) => writes.push(["savedDefaultThinking", value]),
  };
  context.loadModels = loadScript.runInNewContext(context);
  return { context, writes };
}

test("model request failures remain visible and reject so the caller can retry", async () => {
  const state = makeState(async () => Response.json({ error: "Access denied" }, { status: 403 }));

  await assert.rejects(state.context.loadModels(), /Access denied/);
  const modelError = state.writes.find(([name]) => name === "modelError")?.[1];
  assert.equal(modelError?.code, "MODEL_REQUEST_FAILED");
  assert.equal(modelError?.message, "Access denied");
});

test("model refresh retries transient failures with bounded delays", async () => {
  let attempts = 0;
  const delays = [];
  const loadModels = async () => {
    attempts += 1;
    if (attempts <= 3) throw new Error("temporary failure");
  };
  const context = {
    AbortController,
    DOMException,
    MODELS_RETRY_DELAYS_MS: [2_000, 5_000, 10_000],
    loadModels,
    delay: async (ms) => { delays.push(ms); },
    setModelNames() {},
    setModelList() {},
    setModelScopeWarnings() {},
    setModelThinkingLevels() {},
    setModelThinkingLevelMaps() {},
    setNewSessionDefaultModel() {},
    setModelError() {},
  };

  const effectCallback = effectScript.runInNewContext(context);
  const cleanup = effectCallback();
  for (let index = 0; index < 12; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  cleanup();

  assert.equal(attempts, 4);
  assert.deepEqual(delays, [2_000, 5_000, 10_000]);
});

test("model refresh source keeps retry count bounded and checks abort state", () => {
  assert.match(sourceText, /const MODELS_RETRY_DELAYS_MS = \[2_000, 5_000, 10_000\]/);
  const effectText = effect.arguments[0].getText(source);
  assert.match(effectText, /MODELS_RETRY_DELAYS_MS/);
  assert.match(effectText, /controller\.signal\.aborted/);
});

// Regression cases introduced by upstream v0.10.0, retained with Reader cases.

const schedule = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "MODELS_RETRY_DELAYS_MS");

const retry = effect.arguments[0].body.statements.find(ts.isExpressionStatement).expression;

const retryScript = script(retry.getText(source));


function setup(fetchImpl) {
  const writes = [];
  const delays = [];
  const context = {
    Error, DOMException,
    controller: new AbortController(),
    newSessionCwd: "/project", session: null, isNew: true,
    sessionIdRef: { current: null }, thinkingLevelOverrideRef: { current: null },
    thinkingLevelPinsRef: { current: {} }, defaultThinkingLevelRef: { current: null },
    modelListRequestRevisionRef: { current: 0 },
    branchScopeRef: { current: "peer:session" },
    remotePeerRef: { current: "peer" },
    sessionHookMountedRef: { current: true },
    apiPath: (path) => path,
    asConcreteThinkingLevel: (value) => (!value || value === "auto" ? null : value),
    resolveDefaultThinkingLevel: (levels, preferred, pin) => preferred && levels?.includes(preferred)
      ? preferred : pin ?? levels?.at(-1) ?? null,

    asConcreteThinkingLevel: (value) => (!value || value === "auto" ? null : value),
    fetch: fetchImpl,
    MODELS_RETRY_DELAYS_MS: script(schedule.initializer.getText(source)).runInNewContext(),
    delay: async (ms) => { delays.push(ms); },
  };
  for (const name of ["ModelError", "ModelNames", "ModelScopeWarnings", "ModelThinkingLevels", "ModelThinkingLevelMaps", "ModelThinkingLevelPins", "ModelThinkingLevelDefaults", "ThinkingLevel", "ModelList", "NewSessionDefaultModel", "NewSessionDefaultThinkingLevel", "SavedDefaultThinkingLevel"]) {
    context[`set${name}`] = (value) => writes.push([name, value]);
  }
  context.loadModels = loadScript.runInNewContext(context);
  return { context, writes, delays, run: () => retryScript.runInNewContext(context) };
}


test("model-load failures stay visible through bounded retries and clear on recovery", async () => {
  for (const [fetchImpl, expected] of [
    [async () => { throw new TypeError("Failed to fetch"); }, "Failed to fetch"],
    [async () => Response.json({ error: "Access denied" }, { status: 403 }), "Access denied"],
    [async () => new Response("Unavailable", { status: 503 }), "Failed to load models (HTTP 503)"],
    [async () => ({ ok: true, json: async () => { throw new SyntaxError("Invalid JSON"); } }), "Invalid JSON"],
  ]) {
    const state = setup(fetchImpl);
    await state.run();
    assert.deepEqual(state.delays, [2_000, 5_000, 10_000]);
    const errors = state.writes.filter(([name]) => name === "ModelError").map(([, value]) => value);
    assert.ok(errors.length >= 4, "Every bounded failed attempt remains visible");
    assert.ok(errors.every((value) => value.code === "MODEL_REQUEST_FAILED" && value.message === expected));
  }

  let attempts = 0;
  const recovered = setup(async () => {
    if (++attempts === 1) throw new TypeError("Failed to fetch");
    return Response.json({
      models: { "custom:test": "Test" },
      modelList: [{ provider: "custom", id: "test", name: "Test" }],
      defaultModel: { provider: "custom", modelId: "test" },
      thinkingLevelPins: { "custom/test": "high" },
    });
  });
  await recovered.run();
  assert.equal(attempts, 2);
  assert.deepEqual(recovered.delays, [2_000]);
  assert.deepEqual(JSON.parse(JSON.stringify(recovered.writes.filter(([name]) => name === "ModelError"))), [["ModelError", { code: "MODEL_REQUEST_FAILED", message: "Failed to fetch" }], ["ModelError", null]]);
  assert.ok(recovered.writes.some(([name, value]) => name === "ModelList" && value[0].id === "test"));
  assert.ok(recovered.writes.some(([name, value]) => name === "NewSessionDefaultModel" && value.modelId === "test"));
  assert.ok(recovered.writes.some(([name, value]) => name === "NewSessionDefaultThinkingLevel" && value === "high"));
});


test("cancelling model loads prevents state writes and further retries", async () => {
  for (const status of [200, 403]) {
    const reading = Promise.withResolvers();
    const state = setup(async (_url, { signal }) => ({
      ok: status === 200, status,
      json: () => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        reading.resolve();
      }),
    }));
    const completed = state.run();
    await reading.promise;
    state.context.controller.abort();
    await completed;
    assert.deepEqual(state.writes, []);
    assert.deepEqual(state.delays, []);
  }

  const late = setup(async (_url, { signal }) => ({
    ok: true,
    json: async () => {
      late.context.controller.abort();
      assert.equal(signal.aborted, true);
      return { models: {}, modelList: [] };
    },
  }));
  await late.run();
  assert.deepEqual(late.writes, []);

  let attempts = 0;
  const waiting = setup(async () => { attempts++; throw new TypeError("Failed to fetch"); });
  waiting.context.delay = async () => waiting.context.controller.abort();
  await waiting.run();
  assert.equal(attempts, 1);
});


test("late model responses cannot replace another peer or a newer request", async () => {
  for (const replacement of ["peer", "scope", "request", "unmounted"]) {
    const reading = Promise.withResolvers();
    const release = Promise.withResolvers();
    const state = setup(async () => ({ ok: true, json: async () => { reading.resolve(); return release.promise; } }));
    const done = state.context.loadModels();
    await reading.promise;
    if (replacement === "peer") state.context.remotePeerRef.current = "other-peer";
    if (replacement === "scope") state.context.branchScopeRef.current = "other-session";
    if (replacement === "request") state.context.modelListRequestRevisionRef.current++;
    if (replacement === "unmounted") state.context.sessionHookMountedRef.current = false;
    release.resolve({ models: { "stale:old": "Old" }, modelList: [] });
    await done;
    assert.deepEqual(state.writes, [], replacement);
  }
});
