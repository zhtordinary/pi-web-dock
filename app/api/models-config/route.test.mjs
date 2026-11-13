import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-models-config-route-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");
const routeSource = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const modelsPath = join(testAgentDir, "models.json");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

function put(body) {
  return new Request("http://localhost/api/models-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify(body),
  });
}

test("model-config saves do not create or rewrite enabledModels", () => {
  assert.doesNotMatch(routeSource, /getEnabledModels|setEnabledModels|migrateProviderReferences|detectRemovedModelReferences/);
  assert.match(routeSource, /migrateDefaultProvider/);
});

test("a models.json with a syntax error is reported instead of read as empty, and a save cannot replace it", async () => {
  const original = '{ "providers": { "acme": { "models": [ } } }';
  await writeFile(modelsPath, original);

  let response = await GET();
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /models\.json/);

  response = await PUT(put({ providers: {} }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /models\.json/);
  assert.equal(await readFile(modelsPath, "utf8"), original);
});

test("a commented models.json loads with its providers", async () => {
  await writeFile(modelsPath, '{\n  // local models\n  "providers": { "acme": { "models": [{ "id": "a" },] } },\n}\n');

  const response = await GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { providers: { acme: { models: [{ id: "a" }] } } });
});

test("a provider entry pi would refuse to load is rejected before anything is written", async () => {
  const relay = { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "TEST_ONLY_KEY", models: [{ id: "AURA-think" }] };
  const saved = { providers: { relay, "new-provider": { api: "openai-completions" } } };
  const original = JSON.stringify(saved);
  await writeFile(modelsPath, original);

  // An unrelated edit still carries the stub the Add-provider form left behind.
  const edited = structuredClone(saved);
  edited.providers.relay.models.push({ id: "b" });
  let response = await PUT(put(edited));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Provider new-provider needs a Base URL or at least one model" });
  assert.equal(await readFile(modelsPath, "utf8"), original);

  delete edited.providers["new-provider"];
  assert.equal((await PUT(put(edited))).status, 200);
  assert.deepEqual(await (await GET()).json(), edited);
});

test("an OAuth provider without a Base URL is rejected", async () => {
  await writeFile(modelsPath, JSON.stringify({ providers: {} }));

  const response = await PUT(put({ providers: { oauthless: { oauth: { provider: "acme" }, models: [{ id: "a" }] } } }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Provider oauthless needs a Base URL" });
  assert.deepEqual(await (await GET()).json(), { providers: {} });
});

test("legitimate inherited and overrides-only entries still save", async () => {
  const body = {
    providers: {
      // No Base URL or API: pi resolves both from the built-in provider.
      inherited: { models: [{ id: "a" }] },
      "overrides-only": { modelOverrides: { a: { contextWindow: 1024 } } },
      keyed: { apiKey: "TEST_ONLY_KEY", models: [{ id: "b" }] },
      // A blank model id is dropped by the store, so this entry keeps its Base
      // URL and still loads in pi.
      "blank-model": { baseUrl: "https://blank.example.test/v1", models: [{ id: "  " }] },
    },
  };
  await writeFile(modelsPath, JSON.stringify({ providers: {} }));

  const response = await PUT(put(body));
  assert.equal(response.status, 200);
  const saved = await (await GET()).json();
  assert.deepEqual(saved.providers.inherited, body.providers.inherited);
  assert.deepEqual(saved.providers["overrides-only"], body.providers["overrides-only"]);
  assert.deepEqual(saved.providers.keyed, body.providers.keyed);
  assert.deepEqual(saved.providers["blank-model"], { baseUrl: "https://blank.example.test/v1", models: [] });
});

test("invalid image resize limits are rejected without changing the config", async () => {
  const original = JSON.stringify({ providers: {} });
  await writeFile(modelsPath, original);
  for (const value of [0, -1, 1.5, "100", Number.MAX_SAFE_INTEGER + 1]) {
    const body = { providers: { relay: { models: [{ id: "vision", inputLimits: { images: { resize: { maxBytes: value } } } }] } } };
    const response = await PUT(put(body));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /relay\/vision.*positive safe integer/);
    assert.equal(await readFile(modelsPath, "utf8"), original);
  }
});

test("model URLs and adaptive overrides round-trip through Pi SDK 1.5", async () => {
  const body = { providers: { relay: {
    api: "anthropic-messages", baseUrl: "https://provider.example.test", apiKey: "TEST_ONLY_KEY",
    compat: { forceAdaptiveThinking: true },
    models: [
      { id: "inherited", reasoning: true },
      { id: "override", reasoning: true, baseUrl: "https://model.example.test", compat: { forceAdaptiveThinking: false }, input: ["text", "image"], inputLimits: { images: { resize: { maxBytes: 1024, maxWidth: 512 } } } },
    ],
  } } };
  await writeFile(modelsPath, JSON.stringify({ providers: {} }));
  assert.equal((await PUT(put(body))).status, 200);
  assert.deepEqual(await (await GET()).json(), body);
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create({ modelsPath, authPath: join(testAgentDir, "isolated-auth.json"), refreshOnCreate: false });
  assert.equal(runtime.getError(), undefined);
  assert.equal(runtime.getModel("relay", "inherited").baseUrl, "https://provider.example.test");
  assert.equal(runtime.getModel("relay", "inherited").compat.forceAdaptiveThinking, true);
  assert.equal(runtime.getModel("relay", "override").baseUrl, "https://model.example.test");
  assert.equal(runtime.getModel("relay", "override").compat.forceAdaptiveThinking, false);
  assert.equal(runtime.getModel("relay", "override").inputLimits.images.resize.maxBytes, 1024);
  assert.equal(runtime.getModel("relay", "override").inputLimits.images.resize.maxWidth, 512);
  delete body.providers.relay.models[1].baseUrl;
  delete body.providers.relay.models[1].compat;
  assert.equal((await PUT(put(body))).status, 200);
  await runtime.refresh({ allowModelNetwork: false });
  assert.equal(runtime.getModel("relay", "override").baseUrl, "https://provider.example.test");
  assert.equal(runtime.getModel("relay", "override").compat.forceAdaptiveThinking, true);
});

test("a symlinked models.json keeps its link and a dangling one is refused", async () => {
  const { mkdir, readlink, symlink } = await import("node:fs/promises");
  const targetDir = join(testAgentDir, "shared");
  const targetPath = join(targetDir, "models-target.json");
  await mkdir(targetDir, { recursive: true });
  await writeFile(targetPath, JSON.stringify({ providers: {} }));
  await rm(modelsPath, { force: true });
  await symlink(targetPath, modelsPath);

  let response = await PUT(put({ providers: { acme: { models: [{ id: "a" }] } } }));
  assert.equal(response.status, 200);
  assert.equal(await readlink(modelsPath), targetPath);
  assert.deepEqual(JSON.parse(await readFile(targetPath, "utf8")), { providers: { acme: { models: [{ id: "a" }] } } });

  await rm(targetPath);
  const before = await readlink(modelsPath);
  response = await PUT(put({ providers: { acme: { models: [{ id: "b" }] } } }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /models\.json/);
  assert.equal(await readlink(modelsPath), before);
  await rm(modelsPath, { force: true });
});
