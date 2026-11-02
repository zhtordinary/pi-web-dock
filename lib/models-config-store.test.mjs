import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  ModelsConfigReadError,
  detectProviderRenames,
  getModelThinkingDefaults,
  readModelsConfig,
  writeModelsConfig,
} = await jiti.import("./models-config-store.ts");
const { invalidateModelsCache, loadModelsWithCache } = await jiti.import("./models-cache.ts");
const { buildSessionContext, getSessionEntries } = await jiti.import("./session-reader.ts");

function createTempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-models-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function modelsData(id) {
  return {
    models: { [`provider:${id}`]: id },
    modelList: [{ id, name: id, provider: "provider" }],
    defaultModel: null,
    thinkingLevels: {},
    thinkingLevelMaps: {},
    thinkingLevelPins: {},
  };
}

test("reads valid per-model default thinking levels from models.json", () => {
  assert.deepEqual(
    getModelThinkingDefaults({
      providers: {
        acme: {
          models: [
            { id: "expensive", defaultThinkingLevel: "low" },
            { id: "automatic", defaultThinkingLevel: "not-a-level" },
            { id: "missing" },
          ],
        },
      },
    }),
    { "acme/expensive": "low" },
  );
});

test("saving models.json atomically invalidates the model-list cache", async (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "agent", "models.json");
  const config = {
    providers: {
      acme: {
        baseUrl: "https://models.example.test/v1",
        api: "openai-completions",
        models: [{ id: "acme-2" }],
      },
    },
  };
  let loads = 0;

  invalidateModelsCache();
  await loadModelsWithCache(root, async () => modelsData(`load-${++loads}`));
  writeModelsConfig(config, modelsPath);
  const reloaded = await loadModelsWithCache(root, async () => modelsData(`load-${++loads}`));

  assert.equal(loads, 2);
  assert.equal(reloaded.modelList[0].id, "load-2");
  assert.deepEqual(readModelsConfig(modelsPath), config);
  assert.deepEqual(readdirSync(join(root, "agent")), ["models.json"]);
  if (process.platform !== "win32") {
    assert.equal(statSync(modelsPath).mode & 0o777, 0o600);
  }
});

test("saving models.json preserves legacy price fields and drops blank rows", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "agent", "models.json");

  writeModelsConfig({
    providers: {
      acme: {
        baseUrl: "https://models.example.test/v1",
        api: "openai-completions",
        models: [
          { id: "working-model", cost: { input: 1 } },
          { id: "" },
          { id: "  " },
          { id: 42 },
          { name: "Missing identifier" },
          null,
        ],
      },
    },
  }, modelsPath);

  assert.deepEqual(readModelsConfig(modelsPath), {
    providers: {
      acme: {
        baseUrl: "https://models.example.test/v1",
        api: "openai-completions",
        models: [
          { id: "working-model", cost: { input: 1 } },
          { id: 42 },
          { name: "Missing identifier" },
          null,
        ],
      },
    },
  });
});

test("an existing session opens after its historical model is removed from config", (t) => {
  const root = createTempRoot(t);
  const sessionPath = join(root, "session.jsonl");
  const modelsPath = join(root, "models.json");
  const records = [
    {
      type: "session",
      version: 3,
      id: "existing-session",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: root,
    },
    {
      type: "model_change",
      id: "model-old",
      parentId: null,
      provider: "retired-provider",
      modelId: "retired-model",
      timestamp: "2026-01-01T00:00:01.000Z",
    },
    {
      type: "message",
      id: "user-1",
      parentId: "model-old",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "user", content: "keep this conversation" },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: {
        role: "assistant",
        provider: "retired-provider",
        model: "retired-model",
        content: [{ type: "text", text: "still readable" }],
      },
    },
  ];
  writeFileSync(sessionPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

  writeModelsConfig({
    providers: {
      "retired-provider": {
        baseUrl: "https://retired.example.test/v1",
        api: "openai-completions",
        models: [{ id: "retired-model" }],
      },
    },
  }, modelsPath);
  const beforeChange = buildSessionContext(getSessionEntries(sessionPath));
  assert.equal(beforeChange.messages[1].content[0].text, "still readable");

  writeModelsConfig({
    providers: {
      replacement: {
        baseUrl: "https://replacement.example.test/v1",
        api: "openai-completions",
        models: [{ id: "replacement-model" }],
      },
    },
  }, modelsPath);

  const afterChange = buildSessionContext(getSessionEntries(sessionPath));
  assert.deepEqual(afterChange.entryIds, ["user-1", "assistant-1"]);
  assert.equal(afterChange.messages[0].content, "keep this conversation");
  assert.equal(afterChange.messages[1].content[0].text, "still readable");
});

test("collapsed providers persist as top-level models.json field without touching providers/apiKey", async (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "agent", "models.json");
  const base = {
    providers: {
      acme: {
        baseUrl: "https://models.example.test/v1",
        apiKey: "sk-secret",
        models: [{ id: "acme-2" }],
      },
    },
  };
  writeModelsConfig(base, modelsPath);

  // 折叠写入：在已加载文档上改 collapsedProviders 后写回，providers/apiKey 必须原样保留。
  const cfg = readModelsConfig(modelsPath);
  cfg.collapsedProviders = ["acme", "beta"];
  writeModelsConfig(cfg, modelsPath);

  const reloaded = readModelsConfig(modelsPath);
  assert.deepEqual(reloaded.collapsedProviders, ["acme", "beta"]);
  assert.equal(reloaded.providers.acme.apiKey, "sk-secret");
  assert.equal(reloaded.providers.acme.models[0].id, "acme-2");

  // 空折叠清理时应删除字段（normalize 语义）而不是残留空数组覆盖 providers。
  const cleared = readModelsConfig(modelsPath);
  cleared.collapsedProviders = [];
  writeModelsConfig(cleared, modelsPath);
  assert.deepEqual(readModelsConfig(modelsPath).collapsedProviders, []);
  assert.equal(readModelsConfig(modelsPath).providers.acme.apiKey, "sk-secret");
});


test("detects key-only provider renames", () => {
  const provider = { api: "openai-completions", baseUrl: "https://example.test", models: [{ id: "model-a" }] };
  assert.deepEqual(
    detectProviderRenames(
      { providers: { WorkBuddy: provider } },
      { providers: { "Sub2API WorkBuddy": provider } },
    ),
    [{ oldName: "WorkBuddy", newName: "Sub2API WorkBuddy" }],
  );
});

test("does not guess when identical providers make rename ambiguous", () => {
  const provider = { api: "openai-completions", models: [{ id: "model-a" }] };
  assert.deepEqual(
    detectProviderRenames(
      { providers: { oldA: provider, oldB: provider } },
      { providers: { newA: provider, newB: provider } },
    ),
    [],
  );
});

test("models.json reads accept the BOM, comments and trailing commas pi accepts", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "models.json");
  writeFileSync(modelsPath, `\uFEFF{
  // Hand-edited provider
  "providers": {
    "acme": {
      "baseUrl": "https://models.example.test/v1", // keeps the // inside strings
      "apiKey": "key,}",
      "models": [{ "id": "acme-2", }],
    },
  },
}
`);

  assert.deepEqual(readModelsConfig(modelsPath), {
    providers: {
      acme: {
        baseUrl: "https://models.example.test/v1",
        apiKey: "key,}",
        models: [{ id: "acme-2" }],
      },
    },
  });
});

test("models.json reads also drop block comments, which pi itself rejects", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "models.json");
  writeFileSync(modelsPath, '{ /* hand-edited */ "providers": { "acme": { "models": [] } } }');

  assert.deepEqual(readModelsConfig(modelsPath), { providers: { acme: { models: [] } } });
});

test("an unreadable models.json is reported and never replaced by a save", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "models.json");
  const original = '{ "providers": { "acme": { "models": [ } } }';
  writeFileSync(modelsPath, original);

  assert.throws(() => readModelsConfig(modelsPath), ModelsConfigReadError);
  assert.throws(
    () => writeModelsConfig({ providers: { other: { models: [] } } }, modelsPath),
    ModelsConfigReadError,
  );
  assert.equal(readFileSync(modelsPath, "utf8"), original);

  writeFileSync(modelsPath, "[]");
  assert.throws(() => readModelsConfig(modelsPath), /expected a JSON object/);
});

test("an empty models.json reads as no providers and can be saved over", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "models.json");
  writeFileSync(modelsPath, "\n");

  assert.deepEqual(readModelsConfig(modelsPath), { providers: {} });
  writeModelsConfig({ providers: { acme: { models: [] } } }, modelsPath);
  assert.deepEqual(readModelsConfig(modelsPath), { providers: { acme: { models: [] } } });
});

test("a valid models.json symlink is written through, not replaced", (t) => {
  const root = createTempRoot(t);
  const target = join(root, "shared", "models.json");
  const modelsPath = join(root, "models.json");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ providers: { acme: { models: [{ id: "old" }] } } }));
  symlinkSync(target, modelsPath);

  writeModelsConfig({ providers: { acme: { models: [{ id: "new" }] } } }, modelsPath);

  assert.equal(lstatSync(modelsPath).isSymbolicLink(), true);
  assert.equal(readlinkSync(modelsPath), target);
  assert.deepEqual(readModelsConfig(modelsPath), { providers: { acme: { models: [{ id: "new" }] } } });
  assert.deepEqual(readdirSync(root).sort(), ["models.json", "shared"]);
});

test("a dangling models.json symlink is rejected and left untouched", (t) => {
  const root = createTempRoot(t);
  const target = join(root, "missing-models.json");
  const modelsPath = join(root, "models.json");
  symlinkSync(target, modelsPath);

  assert.throws(() => readModelsConfig(modelsPath), ModelsConfigReadError);
  assert.throws(
    () => writeModelsConfig({ providers: { acme: { models: [] } } }, modelsPath),
    ModelsConfigReadError,
  );
  assert.equal(lstatSync(modelsPath).isSymbolicLink(), true);
  assert.equal(readlinkSync(modelsPath), target);
  assert.deepEqual(readdirSync(root), ["models.json"]);
});

test("a models.json symlink loop is rejected and left untouched", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "models.json");
  const loop = join(root, "models-loop");
  symlinkSync(loop, modelsPath);
  symlinkSync(modelsPath, loop);

  assert.throws(() => readModelsConfig(modelsPath), ModelsConfigReadError);
  assert.throws(
    () => writeModelsConfig({ providers: { acme: { models: [] } } }, modelsPath),
    ModelsConfigReadError,
  );
  assert.equal(readlinkSync(modelsPath), loop);
  assert.equal(readlinkSync(loop), modelsPath);
  assert.deepEqual(readdirSync(root).sort(), ["models-loop", "models.json"]);
});

test("a genuinely missing models.json is created on the first save", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "nested", "models.json");

  assert.deepEqual(readModelsConfig(modelsPath), { providers: {} });
  writeModelsConfig({ providers: { acme: { models: [] } } }, modelsPath);

  assert.equal(lstatSync(modelsPath).isSymbolicLink(), false);
  assert.deepEqual(readModelsConfig(modelsPath), { providers: { acme: { models: [] } } });
});
