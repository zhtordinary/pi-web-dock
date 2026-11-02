import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const source = await readFile(new URL("./model-runtime.ts", import.meta.url), "utf8");
const require = createRequire(import.meta.url);
const ts = require("typescript");

test("temporary runtime invalidates its own SDK extension state exactly once", async () => {
  let invalidations = 0;
  const runtime = {};
  const cjsModule = { exports: {} };
  new Function("require", "module", "exports", ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText)(() => ({
    getAgentDir: () => "/tmp/synthetic-agent-dir",
    createAgentSessionServices: async () => ({
      modelRuntime: runtime,
      resourceLoader: { getExtensions: () => ({ runtime: { invalidate: () => { invalidations++; } } }) },
    }),
  }), cjsModule, cjsModule.exports);
  const created = await cjsModule.exports.createModelRuntimeWithExtensions();
  assert.equal(created, runtime);
  cjsModule.exports.disposeModelRuntime({});
  assert.equal(invalidations, 0);
  cjsModule.exports.disposeModelRuntime(created);
  cjsModule.exports.disposeModelRuntime(created);
  assert.equal(invalidations, 1);
});
