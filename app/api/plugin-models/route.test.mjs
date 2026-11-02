import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import vm from "node:vm";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url), ts = require("typescript");
const root = await mkdtemp(join(tmpdir(), "reader-plugin-model-route-"));
after(() => rm(root, { recursive: true, force: true }));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const settings = await jiti.import("../../../lib/plugin-model-settings.ts");
const descriptor = settings.parsePluginModelDescriptor("fixture", {
  version: 1, label: "Fixture", directory: "fixture",
  model: { kind: "reference", paths: ["inference.suggesterModel", "inference.seederModel"], follow: "session-default" },
  thinking: { paths: ["inference.suggesterThinking", "inference.seederThinking"], fallback: "session-default", options: ["session-default", "auto", "off", "low", "high"] },
});
let disposed = 0;
const mocks = {
  "@/lib/plugin-model-settings": { ...settings, discoverPluginModelSettings: () => [descriptor] },
  "@/lib/resource-config-file": await jiti.import("../../../lib/resource-config-file.ts"),
  "@/lib/request-security": await jiti.import("../../../lib/request-security.ts"),
  "@/lib/model-runtime": { createModelRuntimeWithExtensions: async () => ({ getAvailable: async () => [
    { provider: "fixture", id: "model", api: "openai-completions", reasoning: true },
    { provider: "fixture", id: "no-reasoning", api: "openai-completions", reasoning: false },
    { provider: "fixture", id: "virtual", api: "pi-virtual", reasoning: true },
  ] }), disposeModelRuntime: () => { disposed++; } },
  "@earendil-works/pi-coding-agent": { getAgentDir: () => root },
  "@earendil-works/pi-ai": { getSupportedThinkingLevels: (model) => model.reasoning ? ["off", "low", "high", "max"] : ["off"] },
};
const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const loaded = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { module: loaded, exports: loaded.exports, require: (name) => mocks[name] ?? require(name), Response, AbortSignal });
const { GET, PUT } = loaded.exports;
const request = (body, headers = {}) => new Request("http://localhost/api/plugin-models", { method: "PUT",
  headers: { Host: "localhost", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("lists and saves the configured plugin once, with explicit concurrency protection", async () => {
  const initial = await (await GET()).json();
  assert.equal(initial.rows.length, 1);
  const row = initial.rows[0];
  const response = await PUT(request({ id: row.id, revision: row.revision, model: { provider: "fixture", modelId: "model" }, thinking: "low" }));
  assert.equal(response.status, 200);
  const saved = (await response.json()).row;
  assert.deepEqual(saved.model, { provider: "fixture", modelId: "model" });
  const document = JSON.parse(await readFile(join(root, "fixture", "config.json"), "utf8"));
  assert.deepEqual(document.inference, { suggesterModel: "fixture/model", seederModel: "fixture/model", suggesterThinking: "low", seederThinking: "low" });
  assert.equal((await PUT(request({ id: row.id, revision: row.revision, thinking: "high" }))).status, 409);
  assert.equal(disposed, 2);
});

test("model capabilities allow a concrete level missing from the legacy descriptor", async () => {
  const row = (await (await GET()).json()).rows[0];
  const response = await PUT(request({ id: row.id, revision: row.revision, model: { provider: "fixture", modelId: "model" }, thinking: "max" }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).row.thinking, "max");
});

test("auto is valid for a non-reasoning model while unsupported explicit levels are rejected", async () => {
  let row = (await (await GET()).json()).rows[0];
  let response = await PUT(request({ id: row.id, revision: row.revision, model: { provider: "fixture", modelId: "no-reasoning" }, thinking: "auto" }));
  assert.equal(response.status, 200);
  row = (await response.json()).row;
  response = await PUT(request({ id: row.id, revision: row.revision, thinking: "high" }));
  assert.equal(response.status, 400);
  response = await PUT(request({ id: row.id, revision: row.revision, model: { provider: "fixture", modelId: "model" }, thinking: "low" }));
  assert.equal(response.status, 200);
});

test("rejects untrusted, unavailable, virtual, and browser-selected paths", async () => {
  const row = (await (await GET()).json()).rows[0];
  const before = await readFile(join(root, "fixture", "config.json"), "utf8");
  for (const body of [
    { id: "unknown", revision: row.revision, model: null },
    { id: row.id, revision: row.revision, model: { provider: "fixture", modelId: "virtual" } },
    { id: row.id, revision: row.revision, model: { provider: "missing", modelId: "model" } },
    { id: row.id, revision: row.revision, thinking: "maximum" },
    { id: row.id, revision: row.revision, model: null, path: "/tmp/evil" },
  ]) assert.ok((await PUT(request(body))).status >= 400);
  assert.equal((await PUT(request({ id: row.id, revision: row.revision, model: null }, { Origin: "https://untrusted.invalid" }))).status, 403);
  assert.equal((await PUT(request({ id: row.id, revision: row.revision, model: null }, { "Content-Type": "text/plain" }))).status, 415);
  assert.equal(await readFile(join(root, "fixture", "config.json"), "utf8"), before);
});
