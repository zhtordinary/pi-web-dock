import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const { readModelsJson, writeModelsJson } = await createJiti(import.meta.url, { tsconfigPaths: true })
  .import("./models-json-store.ts");

function withAgentDir(t, initial) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-managed-models-"));
  const agentDir = join(root, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  if (initial !== undefined) {
    const path = join(agentDir, "models.json");
    // The test fixture is synthetic and deliberately contains no credentials.
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path, initial);
  }
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });
  return join(agentDir, "models.json");
}

test("missing models.json remains creatable through the atomic managed writer", (t) => {
  const path = withAgentDir(t);
  assert.deepEqual(readModelsJson(), { providers: {} });
  writeModelsJson({
    collapsedProviders: ["synthetic"],
    providers: { synthetic: { api: "openai-completions", models: [{ id: "model-a" }] } },
  });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    collapsedProviders: ["synthetic"],
    providers: { synthetic: { api: "openai-completions", models: [{ id: "model-a" }] } },
  });
  assert.deepEqual(readdirSync(join(path, "..")), ["models.json"]);
});

test("invalid JSON and invalid schema fail closed while preserving original bytes", (t) => {
  const invalid = '{ "providers": { "synthetic": { "models": [ } } }';
  const path = withAgentDir(t, invalid);
  assert.throws(() => readModelsJson(), /models\.json/);
  assert.throws(() => writeModelsJson({ providers: {} }), /models\.json/);
  assert.equal(readFileSync(path, "utf8"), invalid);

  const malformedSchemas = [
    "{\"providers\":[]}",
    "{\"providers\":{\"synthetic\":[]}}",
    "{\"providers\":{\"synthetic\":{\"models\":{}}}}",
  ];
  for (const content of malformedSchemas) {
    writeFileSync(path, content);
    assert.throws(() => writeModelsJson({ providers: {} }), /expected|must be/);
    assert.equal(readFileSync(path, "utf8"), content);
  }

  writeFileSync(path, "[]");
  assert.throws(() => writeModelsJson({ providers: {} }), /expected a JSON object/);
  assert.equal(readFileSync(path, "utf8"), "[]");
});

test("an existing unreadable path is rejected without replacing it", (t) => {
  const path = withAgentDir(t);
  rmSync(path, { force: true });
  mkdirSync(join(path, ".."), { recursive: true });
  mkdirSync(path);

  assert.throws(() => readModelsJson(), /models\.json/);
  assert.throws(() => writeModelsJson({ providers: {} }), /models\.json/);
  assert.deepEqual(readdirSync(path), []);
});

test("a broken models.json symlink is rejected without replacing the link", (t) => {
  const path = withAgentDir(t);
  const agentDir = join(path, "..");
  mkdirSync(agentDir, { recursive: true });
  const target = join(agentDir, "missing-models.json");
  symlinkSync(target, path);

  assert.throws(() => readModelsJson(), /models\.json/);
  assert.throws(() => writeModelsJson({ providers: {} }), /models\.json/);
  assert.equal(readlinkSync(path), target);
  assert.deepEqual(readdirSync(agentDir), ["models.json"]);
});

test("a symlink loop at models.json is rejected without replacing either link", (t) => {
  const path = withAgentDir(t);
  const agentDir = join(path, "..");
  mkdirSync(agentDir, { recursive: true });
  const loop = join(agentDir, "models-loop");
  symlinkSync(loop, path);
  symlinkSync(path, loop);

  assert.throws(() => readModelsJson(), /models\.json/);
  assert.throws(() => writeModelsJson({ providers: {} }), /models\.json/);
  assert.equal(readlinkSync(path), loop);
  assert.equal(readlinkSync(loop), path);
  assert.deepEqual(readdirSync(agentDir).sort(), ["models-loop", "models.json"]);
});

test("an empty existing models.json remains a valid creatable configuration", (t) => {
  const path = withAgentDir(t, "\n");
  assert.deepEqual(readModelsJson(), { providers: {} });
  writeModelsJson({ providers: { synthetic: { models: [{ id: "empty-file-model" }] } } });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    providers: { synthetic: { models: [{ id: "empty-file-model" }] } },
  });
});

test("valid existing top-level fields and provider fields survive managed discovery writes", (t) => {
  const original = JSON.stringify({
    schemaVersion: 7,
    collapsedProviders: ["synthetic"],
    providers: {
      synthetic: {
        api: "openai-completions",
        baseUrl: "https://models.example.test/v1",
        models: [{ id: "existing", reasoning: false, contextWindow: 8192 }],
      },
    },
  });
  const path = withAgentDir(t, original);
  const document = readModelsJson();
  document.providers.synthetic.models.push({
    id: "discovered",
    api: "openai-completions",
    baseUrl: "https://models.example.test/v1",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 1, output: 2 },
  });
  writeModelsJson(document);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(saved.schemaVersion, 7);
  assert.deepEqual(saved.collapsedProviders, ["synthetic"]);
  assert.equal(saved.providers.synthetic.models[0].reasoning, false);
  assert.deepEqual(saved.providers.synthetic.models[1], document.providers.synthetic.models[1]);
});
