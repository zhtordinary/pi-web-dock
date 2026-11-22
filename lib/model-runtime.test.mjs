import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const source = await readFile(new URL("./model-runtime.ts", import.meta.url), "utf8");
const require = createRequire(import.meta.url);
const ts = require("typescript");

test("temporary runtime invalidates its own SDK extension state exactly once", async () => {
  let invalidations = 0;
  let transportBindings = 0;
  const runtime = {};
  const cjsModule = { exports: {} };
  new Function("require", "module", "exports", ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText)((specifier) => specifier === "./cpa-responses-transport" ? {
    installCpaTransport: (value) => { assert.equal(value, runtime); transportBindings++; },
  } : specifier === "./reader-child-extensions" ? {
    createReaderChildExtensions: () => ({}),
  } : ({
    getAgentDir: () => "/tmp/synthetic-agent-dir",
    createAgentSessionServices: async () => ({
      modelRuntime: runtime,
      resourceLoader: { getExtensions: () => ({ runtime: { invalidate: () => { invalidations++; } } }) },
    }),
  }), cjsModule, cjsModule.exports);
  const created = await cjsModule.exports.createModelRuntimeWithExtensions();
  assert.equal(created, runtime);
  assert.equal(transportBindings, 1);
  cjsModule.exports.disposeModelRuntime({});
  assert.equal(invalidations, 0);
  cjsModule.exports.disposeModelRuntime(created);
  cjsModule.exports.disposeModelRuntime(created);
  assert.equal(invalidations, 1);
});

test("createReaderAgentSessionServices leaves Pi's native OpenAI providers untouched", async () => {
  let refreshed = false;
  const runtime = { refresh: async () => { refreshed = true; } };
  const cjsModule = { exports: {} };
  new Function("require", "module", "exports", ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText)((specifier) => specifier === "./cpa-responses-transport" ? {
    installCpaTransport: () => {},
  } : specifier === "./reader-child-extensions" ? {
    createReaderChildExtensions: () => ({}),
  } : ({
    getAgentDir: () => "/tmp/synthetic-agent-dir",
    createAgentSessionServices: async () => ({ modelRuntime: runtime }),
  }), cjsModule, cjsModule.exports);

  await cjsModule.exports.createReaderAgentSessionServices({});
  assert.equal(refreshed, false);
});

test("shared read-only runtime joins concurrent builds and refreshes credentials", async () => {
  globalThis.__piWebSharedModelRuntime = undefined;
  let created = 0;
  let refreshes = 0;
  const runtime = {
    refresh: async (opts) => {
      assert.deepEqual(opts, { allowNetwork: false });
      refreshes += 1;
    },
  };
  const cjsModule = { exports: {} };
  new Function("require", "module", "exports", ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText)((specifier) => specifier === "node:crypto" ? {
    randomUUID: () => "test-runtime",
  } : specifier === "./cpa-responses-transport" ? {
    installCpaTransport: () => {},
  } : specifier === "./key-serializer" ? {
    serializeByKey: (_storeKey, _queueKey, task) => task(),
  } : specifier === "./reader-child-extensions" ? {
    createReaderChildExtensions: () => ({}),
  } : ({
    getAgentDir: () => "/tmp/shared-agent-dir",
    createAgentSessionServices: async () => {
      created += 1;
      return {
        modelRuntime: runtime,
        resourceLoader: { getExtensions: () => ({ runtime: { invalidate: () => {} } }) },
      };
    },
  }), cjsModule, cjsModule.exports);

  const [first, second] = await Promise.all([
    cjsModule.exports.getModelRuntimeWithExtensions(),
    cjsModule.exports.getModelRuntimeWithExtensions(),
  ]);
  assert.equal(first, runtime);
  assert.equal(second, runtime);
  assert.equal(created, 1, "concurrent readers share one extension build");
  assert.equal(refreshes, 2, "each reader still refreshes the shared runtime offline");

  cjsModule.exports.invalidateModelRuntimeWithExtensions();
  await cjsModule.exports.getModelRuntimeWithExtensions();
  assert.equal(created, 2, "invalidating the entry rebuilds it on the next read");
  globalThis.__piWebSharedModelRuntime = undefined;
});

test("createReaderAgentSessionServices carries Reader child factories into normal sessions", async () => {
  const runtime = { refresh: async () => {} };
  const readerChildExtensions = { name: "reader-child-extensions" };
  let captured;
  const cjsModule = { exports: {} };
  new Function("require", "module", "exports", ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText)((specifier) => specifier === "./cpa-responses-transport" ? {
    installCpaTransport: () => {},
  } : specifier === "./reader-child-extensions" ? {
    createReaderChildExtensions: (agentDir) => {
      assert.equal(agentDir, "/agent");
      return readerChildExtensions;
    },
  } : ({
    getAgentDir: () => "/tmp/synthetic-agent-dir",
    createAgentSessionServices: async (options) => {
      captured = options;
      return { modelRuntime: runtime };
    },
  }), cjsModule, cjsModule.exports);

  await cjsModule.exports.createReaderAgentSessionServices({
    cwd: "/work",
    agentDir: "/agent",
    resourceLoaderOptions: { extensionFactories: ["base"], noExtensions: true },
  });
  assert.equal(captured.resourceLoaderOptions.noExtensions, true);
  assert.deepEqual(captured.resourceLoaderOptions.extensionFactories, ["base"]);

  await cjsModule.exports.createReaderAgentSessionServices({
    cwd: "/work", agentDir: "/agent", resourceLoaderOptions: { extensionFactories: ["base"] },
  });
  assert.deepEqual(captured.resourceLoaderOptions.extensionFactories, ["base", readerChildExtensions]);

  await cjsModule.exports.createReaderAgentSessionServices({ cwd: "/work", agentDir: "/agent" });
  assert.deepEqual(captured.resourceLoaderOptions.extensionFactories, [readerChildExtensions]);
});
