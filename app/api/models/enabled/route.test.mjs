import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "reader-enabled-models-route-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
await mkdir(agentDir);
await mkdir(cwd);
const modelsPath = join(agentDir, "models.json");
const fixtureModels = JSON.stringify({ hiddenModels: ["fixture/two"], providers: {
  fixture: { baseUrl: "https://example.invalid/v1", api: "openai-completions", apiKey: "fixture-not-a-credential", models: [{ id: "one" }, { id: "two" }, { id: "three" }] },
} });
await writeFile(modelsPath, fixtureModels);
const keys = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_OFFLINE"];
const previous = new Map(keys.map(key => [key, process.env[key]]));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { PUT } = await jiti.import("./route.ts");
after(async () => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

test("unrestricted model disable writes a negated pattern without creating a partial scope", async () => {
  const settingsPath = join(agentDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ keep: true }));
  const response = await PUT(new Request("http://localhost/api/models/enabled", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "models", cwd, refs: ["fixture/one"], enabled: false }),
  }));
  assert.equal(response.status, 200);
  const view = await response.json();
  const provider = view.providers.find((item) => item.id === "fixture");
  assert.equal(provider.models.find((item) => item.id === "one").enabled, false);
  assert.equal(provider.models.find((item) => item.id === "two").enabled, true);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    enabledModels: ["!{[f]ixture/one,@(one)}"],
    keep: true,
  });
});

test("direct model edits reject an unsafe wildcard without changing settings", async () => {
  const settingsPath = join(agentDir, "settings.json");
  const original = JSON.stringify({ enabledModels: ["fixture/*", "unavailable/model:high"], keep: true });
  await writeFile(settingsPath, original);
  const response = await PUT(new Request("http://localhost/api/models/enabled", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "models", cwd, refs: ["fixture/one"], enabled: false }),
  }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, "unsafe-scope");
  assert.equal(await readFile(settingsPath, "utf8"), original);
  assert.equal(await readFile(modelsPath, "utf8"), fixtureModels);
});

test("a direct exact disable changes only the intended entry and returns the new view", async () => {
  const settingsPath = join(agentDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ enabledModels: ["fixture/one", "fixture/two"], keep: true }));
  const response = await PUT(new Request("http://localhost/api/models/enabled", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "models", cwd, refs: ["fixture/one"], enabled: false }),
  }));
  assert.equal(response.status, 200);
  const view = await response.json();
  const provider = view.providers.find((item) => item.id === "fixture");
  assert.equal(provider.models.find((item) => item.id === "one").enabled, false);
  assert.equal(provider.models.find((item) => item.id === "two").enabled, true);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { enabledModels: ["fixture/two"], keep: true });
  assert.equal(await readFile(modelsPath, "utf8"), fixtureModels, "display-only hidden preferences stay untouched");
});

test("concurrent direct edits never report success while losing another successful edit", async () => {
  const settingsPath = join(agentDir, "settings.json");
  const refs = ["fixture/one", "fixture/two"];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await writeFile(settingsPath, JSON.stringify({ enabledModels: ["fixture/one", "fixture/two", "fixture/three"], keep: true }));
    const responses = await Promise.all(refs.map((ref) => PUT(new Request("http://localhost/api/models/enabled", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "models", cwd, refs: [ref], enabled: false }),
    }))));
    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(saved.keep, true);
    assert.ok(saved.enabledModels.includes("fixture/three"));
    for (let index = 0; index < responses.length; index += 1) {
      const response = responses[index];
      if (response.status === 200) assert.ok(!saved.enabledModels.includes(refs[index]));
      else {
        const failure = await response.json();
        assert.equal(response.status, 409);
        assert.equal(failure.reason, "revision-conflict");
      }
    }
    assert.ok(responses.some((response) => response.status === 200));
  }
});

test("legacy direct resync cannot rewrite an unverified wildcard", async () => {
  const settingsPath = join(agentDir, "settings.json");
  const original = JSON.stringify({ enabledModels: ["fixture/*", "unavailable/model:high"], keep: true });
  await writeFile(settingsPath, original);
  const response = await PUT(new Request("http://localhost/api/models/enabled", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "resync", cwd, renames: [{ from: "fixture", to: "new-fixture" }] }),
  }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, "unsafe-scope");
  assert.equal(await readFile(settingsPath, "utf8"), original);
});

test("direct prune refuses to delete unavailable model patterns", async () => {
  const settingsPath = join(agentDir, "settings.json");
  const original = JSON.stringify({ enabledModels: ["signed-out-provider/model:high", "remote-only/*"], keep: true });
  await writeFile(settingsPath, original);
  const response = await PUT(new Request("http://localhost/api/models/enabled", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "prune", cwd }),
  }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, "unverified-models");
  assert.equal(await readFile(settingsPath, "utf8"), original);
});
