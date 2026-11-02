import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = await mkdtemp(join(tmpdir(), "reader-compression-route-"));
const old = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
after(async () => {
  if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = old;
  await rm(root, { recursive: true, force: true });
});
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
let disposed = 0;
const mocks = {
  "@earendil-works/pi-ai": await import("@earendil-works/pi-ai"),
  "@/lib/model-runtime": { createModelRuntimeWithExtensions: async () => ({ getAvailable: async () => [
    { provider: "fixture", id: "compress", name: "Fixture compressor", contextWindow: 128000, reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, xhigh: "high", max: "max" } },
    { provider: "virtual", id: "route", name: "Virtual route", api: "pi-virtual" },
  ] }), disposeModelRuntime: () => { disposed++; } },
  "@/lib/compaction-model": await jiti.import("../../../lib/compaction-model.ts"),
  "@/lib/compaction-model-settings": await jiti.import("../../../lib/compaction-model-settings.ts"),
  "@/lib/request-security": await jiti.import("../../../lib/request-security.ts"),
};
const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const loaded = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { module: loaded, exports: loaded.exports, require: (name) => mocks[name] ?? require(name), Response, AbortSignal });
const { GET, PUT } = loaded.exports;
function request(body, headers = {}) {
  return new Request("http://localhost/api/compaction-model", { method: "PUT",
    headers: { Host: "localhost", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

test("lists configured physical models, saves and clears only the Reader preference", async () => {
  const document = { defaultProvider: "fixture", defaultModel: "main", compaction: { enabled: false, keepRecentTokens: 20000 } };
  await writeFile(join(root, "settings.json"), JSON.stringify(document));
  let response = await GET();
  const initial = await response.json();
  assert.equal(initial.model, null);
  assert.equal(initial.models.length, 1);
  assert.equal(initial.models[0].modelId, "compress");
  assert.equal("apiKey" in initial.models[0], false);
  response = await PUT(request({ model: { provider: "fixture", modelId: "compress" } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { model: { provider: "fixture", modelId: "compress" } });
  assert.equal(JSON.parse(await readFile(join(root, "settings.json"), "utf8")).defaultModel, "main");
  response = await PUT(request({ model: null }));
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(await readFile(join(root, "settings.json"), "utf8")), document);
  assert.equal(disposed, 2);
});

test("compression thinking is persisted, capability-checked and exposed with model mapping", async () => {
  const response = await PUT(request({ model: { provider: "fixture", modelId: "compress" }, thinkingLevel: "max" }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).thinkingLevel, "max");
  const snapshot = await GET();
  const data = await snapshot.json();
  assert.equal(data.thinkingLevel, "max");
  assert.equal(data.models[0].thinkingLevelMap.xhigh, "high");
  assert.equal(data.models[0].thinkingLevelMap.max, "max");
  assert.equal((await PUT(request({ model: { provider: "fixture", modelId: "compress" }, thinkingLevel: "minimal" }))).status, 400);
  await PUT(request({ model: null, thinkingLevel: null }));
});

test("a stale settings pane cannot overwrite newer compression choices", async () => {
  const stale = { model: null, thinkingLevel: null };
  const current = { model: { provider: "fixture", modelId: "compress" }, thinkingLevel: "max" };
  assert.equal((await PUT(request(current))).status, 200);
  const before = await readFile(join(root, "settings.json"), "utf8");
  assert.equal((await PUT(request({ model: null, thinkingLevel: "auto", expected: stale }))).status, 409);
  assert.equal(await readFile(join(root, "settings.json"), "utf8"), before);
  assert.equal((await PUT(request({ model: null, thinkingLevel: null, expected: current }))).status, 200);
});

test("rejects malformed, unavailable, virtual and untrusted changes without writing", async () => {
  const before = await readFile(join(root, "settings.json"), "utf8");
  for (const body of [{}, { model: false }, { model: {} }, { model: { provider: "missing", modelId: "m" } }, { model: { provider: "virtual", modelId: "route" } }]) {
    assert.equal((await PUT(request(body))).status, 400);
  }
  assert.equal((await PUT(new Request("http://localhost/api/compaction-model", { method: "PUT", headers: { Host: "localhost", "Content-Type": "application/json" }, body: "{" }))).status, 400);
  assert.equal((await PUT(request({ model: null }, { "Content-Type": "text/plain" }))).status, 415);
  assert.equal((await PUT(request({ model: null }, { Origin: "https://untrusted.invalid" }))).status, 403);
  assert.equal(await readFile(join(root, "settings.json"), "utf8"), before);
});

test("damaged configuration cannot be overwritten, even when clearing", async () => {
  await writeFile(join(root, "settings.json"), "{invalid");
  assert.equal((await GET()).status, 500);
  assert.equal((await PUT(request({ model: null }))).status, 500);
  assert.equal(await readFile(join(root, "settings.json"), "utf8"), "{invalid");
});
