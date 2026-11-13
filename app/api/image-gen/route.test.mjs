import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
const routeSource = await readFile(new URL("./route.ts", import.meta.url), "utf8");

function harness() {
  const files = { "/agent/image-generation.json": { providers: { fixture: { baseUrl: "https://api.apimart.ai/v1", apiKey: "never-return-fixture-key", models: ["fixture-model"] } } } };
  let sessionConfig = {};
  let unavailable = false;
  const calls = [];
  const fields = { size: "genSize", resolution: "genResolution", quality: "genQuality", version: "genVersion" };
  const contract = {
    DEFAULT_OUTPUT_DIR: "fixture-output", GEN_OPTION_KEYS: fields,
    genProviderModels: (provider) => provider.models,
    generationPanelCapabilities: (...args) => {
      calls.push({ capabilityArgs: args });
      return { "fixture-model": { note: `package:${args[0]}`, resolutions: ["fixture-resolution"] } };
    },
    generationSessionConfig: (entries) => Object.assign({}, ...entries.map((entry) => entry.data)),
    readGenOptionUnsets: (value) => Array.isArray(value) ? value.filter((item) => item in fields) : [],
    mergeSessionGenOptions: (existing, next) => { calls.push("merge"); return { ...existing, ...next, genOptionsUnset: [] }; },
    clearSessionGenOptions: (existing, requested) => { calls.push("clear"); const next = { ...existing, genOptionsUnset: requested }; for (const key of requested) delete next[fields[key]]; return next; },
    projectGenerationConfigPath: (cwd) => `${cwd}/.pi/image-generation.json`,
    resolveEffectiveConfig: (entries, cwd, agentDir) => {
      calls.push({ entries, cwd, agentDir });
      return { genEnabled: "on", genProvider: "fixture", genModelId: "fixture-model", genBackend: "async-task", genSize: "package-size", genResolution: "package-resolution", genQuality: "max",
        parameterSources: { size: "project" }, outputDirGlobal: "package-global-output", outputDirProject: "package-project-output",
        providers: Object.fromEntries(Object.entries(files["/agent/image-generation.json"].providers).map(([name, provider]) => [name, { baseUrl: provider.baseUrl, models: provider.models }])) };
    },
  };
  const executable = stripTypeScriptTypes(routeSource.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""));
  const route = new Function("deps", `const { getAgentDir, readFileSync, writePrivateFileAtomicSync, join, resolve, dirname, mkdirSync, rmSync, stat, getAllowedFileRoots, isExistingFilePathAllowed, getRpcSessionByFile, loadImageGenerationPackage, imageGenerationQuote } = deps;\n${executable}\nreturn { GET, POST };`)({
    getAgentDir: () => "/agent", join: (...parts) => parts.join("/"), resolve: (path) => path, dirname: (path) => path.slice(0, path.lastIndexOf("/")),
    mkdirSync() {}, rmSync: (path) => { delete files[path]; }, stat: async (path) => { if (path === "/missing") throw new Error("missing"); return { isDirectory: () => true }; },
    getAllowedFileRoots: async () => new Set(["/project"]), isExistingFilePathAllowed: (path) => path === "/project",
    readFileSync: (path) => JSON.stringify(files[path] ?? {}), writePrivateFileAtomicSync: (path, value) => { files[path] = JSON.parse(value); },
    loadImageGenerationPackage: () => { if (unavailable) throw new Error("image package unavailable"); return contract; },
    getRpcSessionByFile: () => ({ assertSessionWriteAllowed() { calls.push("write-admission"); }, inner: { sessionManager: {
      getEntries: () => [{ type: "custom", customType: "image-generation-config", data: sessionConfig }], appendCustomEntry: (_type, data) => { sessionConfig = data; },
    } } }),
    imageGenerationQuote: async (...args) => { calls.push({ quote: args }); return { status: "available", model: args[1], rows: [] }; },
  });
  return { route, files, calls, contract, get sessionConfig() { return sessionConfig; }, set unavailable(value) { unavailable = value; } };
}
function post(route, body) { return route.POST(new Request("https://reader.test/api/image-gen", { method: "POST", body: JSON.stringify(body) })); }

test("GET returns stored provider keys only when the settings editor requests them", async () => {
  const h = harness();
  const result = await h.route.GET(new Request("https://reader.test/api/image-gen?sessionFile=session.jsonl&cwd=/project&includeProviderKeys=1"));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  const data = await result.json();
  assert.equal(data.genSize, "package-size"); assert.equal(data.genResolution, "package-resolution"); assert.equal(data.genBackend, "apimart");
  assert.deepEqual(data.parameterSources, { size: "project" }); assert.equal(data.capabilities["fixture-model"].note, "package:fixture");
  assert.equal(data.outputDir, "package-project-output"); assert.equal(data.outputDirScope, "project");
  assert.equal(data.providers.fixture.baseUrl, "https://api.apimart.ai/v1");
  assert.equal(data.providers.fixture.apiKey, "never-return-fixture-key");
  assert.equal(data.providers.fixture.apiKeyConfigured, true);
  assert.equal("apiKey" in h.contract.resolveEffectiveConfig([], "/project", "/agent").providers.fixture, false);
  const ordinary = await h.route.GET(new Request("https://reader.test/api/image-gen?cwd=/project"));
  const ordinaryData = await ordinary.json();
  assert.equal(ordinaryData.providers.fixture.apiKey, undefined);
  assert.doesNotMatch(JSON.stringify(ordinaryData), /never-return-fixture-key/);
  assert.ok(h.calls.some((call) => call.cwd === "/project" && call.agentDir === "/agent"));
  assert.deepEqual(h.calls.find((call) => call.capabilityArgs)?.capabilityArgs, ["fixture", "/agent", "/project", "async-task"]);
});

test("POST preserves global/session option scope and delegates merging and clearing to the package", async () => {
  const h = harness();
  for (const quality of ["xhigh", "max"]) {
    assert.equal((await post(h.route, { action: "setGenOptions", quality })).status, 200);
    assert.equal(h.files["/agent/multimodal-proxy.json"].genQuality, quality);
    assert.equal((await post(h.route, { action: "setGenOptions", sessionFile: "session.jsonl", quality })).status, 200);
    assert.equal(h.sessionConfig.genQuality, quality);
  }
  await post(h.route, { action: "clearGenOptions", sessionFile: "session.jsonl", fields: ["quality"] });
  assert.equal(h.sessionConfig.genQuality, undefined);
  assert.deepEqual(h.sessionConfig.genOptionsUnset, ["quality"]);
  assert.ok(h.calls.includes("merge")); assert.ok(h.calls.includes("clear")); assert.ok(h.calls.includes("write-admission"));
  assert.equal((await post(h.route, { action: "setGenOptions", quality: "ultra" })).status, 400);
});

test("Ext version selection preserves session scope and rejects unsupported versions", async () => {
  const h = harness();
  assert.equal((await post(h.route, { action: "setGenOptions", version: "flare" })).status, 200);
  assert.equal(h.files["/agent/multimodal-proxy.json"].genVersion, "flare");
  assert.equal((await post(h.route, { action: "setGenOptions", sessionFile: "session.jsonl", version: "sunburst" })).status, 200);
  assert.equal(h.sessionConfig.genVersion, "sunburst");
  assert.equal(h.files["/agent/multimodal-proxy.json"].genVersion, "flare");
  assert.equal((await post(h.route, { action: "setGenOptions", version: "invented" })).status, 400);
  assert.equal((await post(h.route, { action: "clearGenOptions", sessionFile: "session.jsonl", fields: ["version"] })).status, 200);
  assert.equal(h.sessionConfig.genVersion, undefined);
});

test("generation switch and provider/model persistence preserve shared defaults and session fields", async () => {
  const h = harness();
  h.files["/agent/multimodal-proxy.shared.json"] = { genEnabled: "on" };
  h.files["/agent/multimodal-proxy.json"] = { genEnabled: "on", genSize: "2:3" };
  await post(h.route, { action: "setModel", provider: "fixture", modelId: "fixture-model", sessionFile: "session.jsonl" });
  await post(h.route, { action: "toggle", enabled: false, sessionFile: "session.jsonl" });
  assert.equal(h.files["/agent/multimodal-proxy.shared.json"].genEnabled, "off");
  assert.equal(h.files["/agent/multimodal-proxy.json"].genEnabled, undefined);
  assert.equal(h.sessionConfig.genModelId, "fixture-model"); assert.equal(h.sessionConfig.genEnabled, "off");
  assert.equal((await post(h.route, { action: "setModel", provider: "provider", modelId: "model-id" })).status, 400);
  assert.equal((await post(h.route, { action: "setModel", provider: "missing", modelId: "fixture-model" })).status, 400);
});

test("project output writes use the package-selected file for an existing project", async () => {
  const h = harness();
  assert.equal((await post(h.route, { action: "setOutputDir", outputDir: "./images", cwd: "/missing", scope: "project" })).status, 400);
  assert.equal((await post(h.route, { action: "setOutputDir", outputDir: "./images", cwd: "/outside", scope: "project" })).status, 200);
  assert.equal(h.files["/outside/.pi/image-generation.json"].outputDir, "./images");
  assert.equal((await post(h.route, { action: "setOutputDir", outputDir: "./images", cwd: "/project", scope: "project" })).status, 200);
  assert.equal(h.files["/project/.pi/image-generation.json"].outputDir, "./images");
  assert.equal((await post(h.route, { action: "clearProjectOutputDir", cwd: "/project" })).status, 200);
  assert.equal(h.files["/project/.pi/image-generation.json"], undefined);
});

test("provider edits preserve redacted credentials and quote requests remain scoped to registered models", async () => {
  const h = harness();
  await post(h.route, { action: "saveGenProvider", providerName: "fixture", provider: { apiKey: "", baseUrl: "", models: ["fixture-model"] } });
  assert.equal(h.files["/agent/image-generation.json"].providers.fixture.apiKey, "never-return-fixture-key");
  const result = await h.route.GET(new Request("https://reader.test/api/image-gen?quote=1&provider=fixture&model=fixture-model"));
  assert.equal(result.status, 200); assert.doesNotMatch(await result.text(), /never-return-fixture-key/);
  const invalid = await h.route.GET(new Request("https://reader.test/api/image-gen?quote=1&provider=fixture&model=unregistered"));
  assert.equal(invalid.status, 400); assert.equal(h.calls.filter((call) => call.quote).length, 1);
});

test("quote requests match registered provider labels without case-sensitive UI casing", async () => {
  const h = harness();
  h.files["/agent/image-generation.json"].providers["CPA GPT Image"] = {
    baseUrl: "https://gateway.test/v1",
    apiKey: "never-return-fixture-key",
    models: ["gpt-image-2.5-flare"],
  };
  const result = await h.route.GET(new Request("https://reader.test/api/image-gen?quote=1&provider=CPA%20GPT%20IMAGE&model=gpt-image-2.5-flare"));
  assert.equal(result.status, 200);
  assert.equal(h.calls.at(-1).quote[4], "CPA GPT Image");
});

test("an unavailable package fails honestly without writing settings or inventing fallback rules", async () => {
  const h = harness(); h.unavailable = true; const original = structuredClone(h.files);
  // Composer reads see no generation; the settings editor and writes report the missing package.
  assert.equal((await h.route.GET(new Request("https://reader.test/api/image-gen"))).status, 204);
  const editor = await h.route.GET(new Request("https://reader.test/api/image-gen?includeProviderKeys=1"));
  assert.equal(editor.status, 503);
  assert.match((await editor.json()).error, /unavailable/);
  assert.equal((await post(h.route, { action: "toggle", enabled: true })).status, 503);
  assert.deepEqual(h.files, original);
});

test("Reader retains session write admission while delegating all capability interpretation", () => {
  assert.match(routeSource, /live\.assertSessionWriteAllowed\(\)/);
  assert.match(routeSource, /generation\.resolveEffectiveConfig/);
  assert.match(routeSource, /generation\.generationPanelCapabilities/);
  assert.doesNotMatch(routeSource, /const eff = \{ \.\.\.fileCfg/);
  assert.match(routeSource, /cwdStat\.isDirectory\(\)/);
});


test("clearing project output removes both supported overrides and preserves other config", async () => {
  const h = harness();
  h.files["/project/.pi/image-generation.json"] = { outputDir: "./primary", defaultModelId: "keep-project-model" };
  h.files["/project/.pi/multimodal-proxy.json"] = { outputDir: "./compatible", unrelated: true };
  h.contract.projectGenerationConfigPath = () => h.files["/project/.pi/image-generation.json"]?.outputDir
    ? "/project/.pi/image-generation.json" : "/project/.pi/multimodal-proxy.json";
  assert.equal((await post(h.route, { action: "clearProjectOutputDir", cwd: "/project" })).status, 200);
  assert.deepEqual(h.files["/project/.pi/image-generation.json"], { defaultModelId: "keep-project-model" });
  assert.deepEqual(h.files["/project/.pi/multimodal-proxy.json"], { unrelated: true });
});
test("global provider edits preserve canonical defaults and model choices update their owning defaults", async () => {
  const h = harness();
  Object.assign(h.files["/agent/image-generation.json"], { defaultProvider: "fixture", defaultModelId: "original-model", customPolicy: true });
  await post(h.route, { action: "saveGenProvider", providerName: "fixture", provider: { models: ["fixture-model"] } });
  assert.equal(h.files["/agent/image-generation.json"].defaultModelId, "original-model");
  await post(h.route, { action: "setModel", provider: "fixture", modelId: "fixture-model" });
  assert.equal(h.files["/agent/image-generation.json"].defaultModelId, "fixture-model");
  assert.equal(h.files["/agent/image-generation.json"].defaultBackend, "sync");
  assert.equal(h.files["/agent/image-generation.json"].customPolicy, true);
});
