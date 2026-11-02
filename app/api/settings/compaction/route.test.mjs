import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalCwd = process.cwd();
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-compaction-settings-route-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

function request(body, contentType = "application/json") {
  return new Request("http://localhost/api/settings/compaction", {
    method: "PUT",
    headers: { "Content-Type": contentType, Host: "localhost" },
    body: JSON.stringify(body),
  });
}

test("compaction settings default on and persist global changes", async () => {
  let response = await GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: true });

  response = await PUT(request({ enabled: false }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: false });
  assert.equal(JSON.parse(await readFile(join(testAgentDir, "settings.json"), "utf8")).compaction.enabled, false);

  response = await PUT(request({ enabled: true }));
  assert.deepEqual(await response.json(), { enabled: true });
});

test("global default ignores an effective project compaction override", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-web-compaction-project-"));
  const projectSettingsDir = join(projectDir, ".pi");
  const projectAgentDir = await mkdtemp(join(tmpdir(), "pi-web-compaction-global-"));
  await mkdir(projectSettingsDir, { recursive: true });
  await writeFile(
    join(projectSettingsDir, "settings.json"),
    JSON.stringify({ compaction: { enabled: false } }),
  );

  process.env.PI_CODING_AGENT_DIR = projectAgentDir;
  process.chdir(projectDir);
  try {
    let response = await PUT(request({ enabled: true }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { enabled: true });
    assert.equal(
      JSON.parse(await readFile(join(projectAgentDir, "settings.json"), "utf8")).compaction.enabled,
      true,
    );
    assert.equal(
      JSON.parse(await readFile(join(projectSettingsDir, "settings.json"), "utf8")).compaction.enabled,
      false,
    );

    response = await GET();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { enabled: true });
  } finally {
    process.chdir(originalCwd);
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(projectDir, { recursive: true, force: true });
    await rm(projectAgentDir, { recursive: true, force: true });
  }
});

test("compaction settings validate requests", async () => {
  let response = await PUT(request({ enabled: "yes" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "enabled must be a boolean" });

  response = await PUT(request({ enabled: true }, "text/plain"));
  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), { error: "Content-Type must be application/json" });
});
