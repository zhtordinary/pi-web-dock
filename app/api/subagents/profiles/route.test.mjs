import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-subagent-route-global-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT, PATCH, DELETE } = await jiti.import("./route.ts");
const { resolveSubagentProfile } = await jiti.import("@/lib/subagents.ts");
const { writeSubagentProfileOrder } = await jiti.import("@/lib/subagent-settings.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

function profile(overrides = {}) {
  return {
    name: "api-test-agent",
    displayName: "API test agent",
    description: "Used by route tests",
    systemPrompt: "Return a concise result.",
    tools: [],
    inheritSkills: true,
    inheritGlobalContext: true,
    defaultContext: "fresh",
    defaultAsync: true,
    enabled: true,
    ...overrides,
  };
}

function jsonRequest(method, body) {
  return new Request("http://localhost/api/subagents/profiles", {
    method,
    headers: { "Content-Type": "application/json", host: "localhost" },
    body: JSON.stringify(body),
  });
}

function getRequest(url) {
  return new Request(url, {
    headers: { host: "localhost" },
  });
}

test("runtime profile overrides use Pi settings and reject external CLI model edits", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-runtime-route-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const packageDir = join(testAgentDir, "npm", "node_modules", "pi-subagents", "agents");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "worker.md"), "---\nname: worker\ndescription: Worker\nthinking: high\n---\n\nWorker prompt.\n");
  await writeFile(join(packageDir, "claude-code.md"), "---\nname: claude-code\ndescription: Claude\nrunner:\n  type: external-cli\n---\n\nClaude prompt.\n");

  let response = await GET(getRequest(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  const profiles = (await response.json()).profiles;
  assert.equal(profiles.find((item) => item.name === "worker")?.scope, "runtime");
  assert.equal(profiles.find((item) => item.name === "worker")?.runtimeKind, "native");

  response = await PATCH(jsonRequest("PATCH", { cwd, scope: "runtime", name: "worker", model: "provider/worker", thinking: "medium" }));
  assert.equal(response.status, 200);
  const settings = JSON.parse(await readFile(join(testAgentDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.subagents.agentOverrides.worker, { model: "provider/worker", thinking: "medium" });

  response = await PATCH(jsonRequest("PATCH", { cwd, scope: "runtime", name: "claude-code", model: "provider/invalid" }));
  assert.equal(response.status, 400);
});

test("profiles route applies the persisted profile order without changing runtime discovery order", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-order-route-"));
  const globalDir = join(testAgentDir, "agents");
  await mkdir(globalDir, { recursive: true });
  await writeFile(join(globalDir, "alpha.md"), "---\nname: alpha\ndisplay_name: Alpha\n---\n\nAlpha.\n");
  await writeFile(join(globalDir, "beta.md"), "---\nname: beta\ndisplay_name: Beta\n---\n\nBeta.\n");
  writeSubagentProfileOrder(["global:beta", "global:alpha"]);
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(join(globalDir, "alpha.md"), { force: true });
    await rm(join(globalDir, "beta.md"), { force: true });
    writeSubagentProfileOrder([]);
  });

  const response = await GET(getRequest(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  assert.equal(response.status, 200);
  assert.deepEqual(
    (await response.json()).profiles.filter((item) => item.scope === "global").map((item) => item.name),
    ["beta", "alpha"],
  );
});

test("profiles route creates, lists, and deletes a project profile", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-route-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const putResponse = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile() }));
  const putBody = await putResponse.json();
  assert.equal(putResponse.status, 200);
  assert.equal(putBody.profile.scope, "project");
  assert.deepEqual(putBody.profile.tools, []);
  assert.equal(putBody.profile.inheritSkills, true);
  assert.equal(putBody.profile.inheritGlobalContext, true);
  const source = await readFile(join(cwd, ".pi", "agents", "api-test-agent.md"), "utf8");
  assert.match(source, /tools: none/);
  assert.match(source, /inheritSkills: true/);
  assert.match(source, /inheritGlobalContext: true/);

  const getResponse = await GET(getRequest(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  const getBody = await getResponse.json();
  assert.equal(getResponse.status, 200);
  const listedProfile = getBody.profiles.find((item) => item.name === "api-test-agent");
  assert.deepEqual(listedProfile.tools, []);
  assert.equal(listedProfile.inheritSkills, true);
  assert.equal(listedProfile.inheritGlobalContext, true);

  const deleteResponse = await DELETE(jsonRequest("DELETE", { cwd, scope: "project", name: "api-test-agent" }));
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { ok: true });

  const afterDelete = await GET(getRequest(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  const afterDeleteBody = await afterDelete.json();
  assert.equal(afterDeleteBody.profiles.some((item) => item.name === "api-test-agent"), false);
});

test("profiles route copies unexposed restrictions from the source identity", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-copy-route-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const dir = join(cwd, ".pi", "agents");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "original.md"), "---\nname: original\ntools: read\nload_extensions: true\nextensions: [advisor]\ndisallowed_tools: ext:advisor/secret\n---\nPrompt.\n");
  const listed = await GET(getRequest(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  const original = (await listed.json()).profiles.find((item) => item.scope === "project" && item.name === "original");
  assert.ok(original);
  const copy = { ...original, name: "original-copy", copyFrom: { scope: "project", name: "original" } };
  const response = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: copy }));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.equal((await response.json()).profile.copyFrom, undefined);
  const resolved = resolveSubagentProfile(cwd, "original-copy");
  assert.deepEqual(resolved.extensions, ["advisor"]);
  assert.deepEqual(resolved.disallowedExtensionTools, ["ext:advisor/secret"]);
  assert.equal(resolved.loadExtensions, true);
  const conflict = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: copy }));
  assert.equal(conflict.status, 400);
});

test("profiles route rejects invalid Reader limits and chat-only capabilities", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-validation-route-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const reader = { loadSkills: false, loadExtensions: false, codemode: "off", mcp: "off", inheritContext: false, runInBackground: false };
  for (const maxTurns of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const response = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile({ reader: { ...reader, maxTurns } }) }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /maxTurns/);
  }
  for (const option of [{ mcp: "on" }, { codemode: "on" }]) {
    const response = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile({ reader: { ...reader, ...option } }) }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /require a tool, skill, or extension/);
  }
  const allowed = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile({ tools: ["read"], reader: { ...reader, mcp: "on", maxTurns: 2 } }) }));
  assert.equal(allowed.status, 200, JSON.stringify(await allowed.clone().json()));
  assert.equal(resolveSubagentProfile(cwd, "api-test-agent").maxTurns, 2);
});

test("profiles route keeps same-name global and project profiles independently editable", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-route-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  let response = await PUT(jsonRequest("PUT", {
    cwd,
    scope: "global",
    profile: profile({ description: "Global profile" }),
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).profile.scope, "global");
  assert.match(await readFile(join(testAgentDir, "agents", "api-test-agent.md"), "utf8"), /Global profile/);

  response = await PUT(jsonRequest("PUT", {
    cwd,
    scope: "project",
    profile: profile({ description: "Project profile" }),
  }));
  assert.equal(response.status, 200);

  response = await GET(getRequest(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  const sources = (await response.json()).profiles
    .filter((item) => item.name === "api-test-agent")
    .sort((a, b) => a.scope.localeCompare(b.scope));
  assert.deepEqual(sources.map((item) => item.scope), ["global", "project"]);
  assert.deepEqual(sources.map((item) => item.description), ["Global profile", "Project profile"]);

  response = await PATCH(jsonRequest("PATCH", {
    cwd,
    scope: "global",
    name: "api-test-agent",
    enabled: false,
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).profile.enabled, false);
  response = await GET(getRequest(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  const toggledSources = (await response.json()).profiles.filter((item) => item.name === "api-test-agent");
  assert.equal(toggledSources.find((item) => item.scope === "global").enabled, false);
  assert.equal(toggledSources.find((item) => item.scope === "global").description, "Global profile");
  assert.equal(toggledSources.find((item) => item.scope === "global").inheritSkills, true);
  assert.equal(toggledSources.find((item) => item.scope === "global").inheritGlobalContext, true);
  assert.equal(toggledSources.find((item) => item.scope === "project").enabled, true);

  response = await DELETE(jsonRequest("DELETE", { cwd, scope: "project", name: "api-test-agent" }));
  assert.equal(response.status, 200);
  response = await GET(getRequest(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  assert.deepEqual(
    (await response.json()).profiles.filter((item) => item.name === "api-test-agent").map((item) => item.scope),
    ["global"],
  );

  response = await DELETE(jsonRequest("DELETE", { cwd, scope: "global", name: "api-test-agent" }));
  assert.equal(response.status, 200);
});

test("profiles route toggles a built-in through settings.json without writing a profile file", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-route-"));
  t.after(async () => {
    await PATCH(jsonRequest("PATCH", { cwd, scope: "builtin", name: "explore", enabled: true }));
    await rm(cwd, { recursive: true, force: true });
  });

  let response = await PATCH(jsonRequest("PATCH", { cwd, scope: "builtin", name: "Explore", enabled: false }));
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.profile.scope, "builtin");
  assert.equal(body.profile.enabled, false);
  assert.equal(body.profile.filePath, undefined);
  assert.deepEqual(
    JSON.parse(await readFile(join(testAgentDir, "agents", "settings.json"), "utf8")).disabledBuiltIns,
    ["explore"],
  );
  assert.equal(existsSync(join(testAgentDir, "agents", "explore.md")), false);

  response = await GET(getRequest(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  const builtIns = (await response.json()).profiles.filter((item) => item.scope === "builtin");
  assert.equal(builtIns.find((item) => item.name === "explore").enabled, false);
  assert.equal(builtIns.filter((item) => item.enabled).length, builtIns.length - 1);

  response = await PATCH(jsonRequest("PATCH", { cwd, scope: "builtin", name: "explore", enabled: true }));
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.profile.enabled, true);
  assert.deepEqual(
    JSON.parse(await readFile(join(testAgentDir, "agents", "settings.json"), "utf8")).disabledBuiltIns,
    [],
  );

  response = await PATCH(jsonRequest("PATCH", { cwd, scope: "builtin", name: "not-a-built-in", enabled: false }));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Agent profile not found" });
});

test("profiles route rejects missing paths, malformed profiles, and unsafe names", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-route-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  let response = await GET(getRequest("http://localhost/api/subagents/profiles"));
  assert.equal(response.status, 400);

  response = await PUT(jsonRequest("PUT", { cwd, scope: "project" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "profile required" });

  response = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile({ name: "../escape" }) }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Agent name may contain only/);

  response = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile({ thinking: "extreme" }) }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Invalid thinking level/);

  response = await DELETE(jsonRequest("DELETE", { cwd, scope: "project" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "name required" });

  response = await PUT(jsonRequest("PUT", { cwd, scope: "workspace", profile: profile() }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "scope must be global or project" });

  response = await PUT(jsonRequest("PUT", { cwd, scope: "builtin", profile: profile() }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "scope must be global or project" });

  response = await PATCH(jsonRequest("PATCH", { cwd, scope: "workspace", name: "explore", enabled: false }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "scope must be global, project, or builtin" });

  response = await DELETE(jsonRequest("DELETE", { cwd, scope: "builtin", name: "Explore" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "scope must be global or project" });

  response = await PATCH(jsonRequest("PATCH", { cwd, scope: "project", name: "missing", enabled: false }));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Agent profile not found" });

  response = await PATCH(jsonRequest("PATCH", { cwd, scope: "project", name: "api-test-agent" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "enabled required" });
});

test("PATCH validates the complete request before toggling and returns the same projection as GET", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-route-validation-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const putResponse = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile({ name: "validation-agent" }) }));
  assert.equal(putResponse.status, 200);
  const profilePath = join(cwd, ".pi", "agents", "validation-agent.md");
  const before = await readFile(profilePath, "utf8");

  let response = await PATCH(jsonRequest("PATCH", {
    cwd,
    scope: "project",
    name: "validation-agent",
    enabled: false,
    thinking: "invalid-level",
  }));
  assert.equal(response.status, 400);
  assert.equal(await readFile(profilePath, "utf8"), before);

  response = await PATCH(jsonRequest("PATCH", {
    cwd,
    scope: "project",
    name: "validation-agent",
    enabled: false,
  }));
  assert.equal(response.status, 200);
  const patched = (await response.json()).profile;
  const listed = (await (await GET(getRequest(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`))).json()).profiles
    .find((item) => item.scope === "project" && item.name === "validation-agent");
  assert.deepEqual(patched, listed);
});

test("external runtime PATCH is rejected without changing the package file", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-route-external-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const packagePath = join(testAgentDir, "npm", "node_modules", "pi-subagents", "agents", "claude-code.md");
  const before = await readFile(packagePath, "utf8");
  const response = await PATCH(jsonRequest("PATCH", { cwd, scope: "runtime", name: "claude-code", model: "provider/invalid" }));
  assert.equal(response.status, 400);
  assert.equal(await readFile(packagePath, "utf8"), before);
});

test("GET rejects untrusted API requests before reading parameters", async () => {
  const response = await GET(new Request("http://attacker.example.com/api/subagents/profiles?cwd=/tmp"));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Untrusted API request" });
});
