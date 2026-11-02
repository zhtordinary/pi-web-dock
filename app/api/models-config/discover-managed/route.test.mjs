import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-managed-discovery-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");
const { collectModelEndpointConflicts } = await jiti.import("../../../../lib/model-discovery.ts");
const modelsPath = join(testAgentDir, "models.json");
const routeSource = await readFile(new URL("./route.ts", import.meta.url), "utf8");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

test("managed discovery rejects damaged config before runtime or upstream access", async () => {
  const original = '{ "providers": { "synthetic": { "models": [ } } }';
  await writeFile(modelsPath, original);

  const response = await POST(new Request("http://localhost/api/models-config/discover-managed", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify({ providerName: "synthetic" }),
  }));

  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /models\.json/);
  assert.equal(await readFile(modelsPath, "utf8"), original);
});

test("managed discovery exposes and rejects same-provider IDs at different endpoints", () => {
  const conflicts = collectModelEndpointConflicts("synthetic", [
    { id: "shared", api: "openai-completions", baseUrl: "https://east.example/v1" },
    { id: "shared", api: "openai-completions", baseUrl: "https://west.example/v1" },
  ], { api: "openai-completions", baseUrl: "https://default.example/v1" });

  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /synthetic\/shared/);
  assert.match(conflicts[0], /east\.example/);
  assert.match(conflicts[0], /west\.example/);
  assert.match(routeSource, /throwOnModelEndpointConflicts\(providerName, \[\s*\.\.\.currentModels,\s*\.\.\.runtimeModels,\s*\.\.\.discovered/);
  assert.match(routeSource, /ModelIdentityConflictError/);
});

test("managed discovery keeps model-only entries on the provider default endpoint", () => {
  const conflicts = collectModelEndpointConflicts("synthetic", [
    { id: "shared" },
    { id: "shared" },
  ], { api: "openai-completions", baseUrl: "https://default.example/v1" });

  assert.deepEqual(conflicts, []);
  assert.match(routeSource, /runtime\.getProvider\(providerName\)/);
  assert.match(routeSource, /identityProvider\.api/);
  assert.match(routeSource, /identityProvider\.baseUrl/);
});
