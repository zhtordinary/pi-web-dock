import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const routeUrl = new URL("./route.ts", import.meta.url);

test("global top-level Skill invocation updates use discovered-resource validation and shared settings", async () => {
  const source = await readFile(routeUrl, "utf8");
  assert.match(source, /set_global_skill_invocation/);
  assert.match(source, /isApiRequestAllowed\(req\)/);
  assert.match(source, /isExistingFilePathAllowed\(filePath, skillRoots\)/);
  assert.match(source, /loadSkillsWithInstallInfo\(cwd, "global"\)/);
  assert.match(source, /target\.sourceInfo\.scope !== "user" \|\| target\.sourceInfo\.origin !== "top-level"/);
  assert.match(source, /setGlobalSkillInvocationOverride\(agentDir, target\.filePath/);
  assert.doesNotMatch(source, /setDisableModelInvocation/);
  assert.doesNotMatch(source, /writeFileSync\(filePath/);
});

test("top-level local Skill invocation mode set and clear bind to the exact filePath", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-skill-local-mode-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await mkdir(cwd, { recursive: true });
    const filePath = join(agentDir, "skills", "fixture", "SKILL.md");
    await mkdir(join(agentDir, "skills", "fixture"), { recursive: true });
    await writeFile(filePath, "---\nname: fixture\ndescription: Local fixture\n---\nfixture\n");
    const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
    const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
    allowFileRoot(cwd);
    const { PATCH } = await jiti.import("./route.ts");
    const request = (action, extra = {}) => new Request("http://localhost/api/skills", {
      method: "PATCH",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({
        action, cwd, filePath, source: "local", scope: "global", viewScope: "global", ...extra,
      }),
    });

    const setResponse = await PATCH(request("set_skill_invocation_mode", { mode: "explicit-only" }));
    assert.equal(setResponse.status, 200);
    const setSettings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
    assert.equal(Object.values(setSettings.piWebGlobalSkillInvocationModes ?? {})[0], "explicit-only");

    const clearResponse = await PATCH(request("clear_skill_invocation_mode"));
    assert.equal(clearResponse.status, 200);
    const clearSettings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
    assert.equal(clearSettings.piWebGlobalSkillInvocationModes, undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("invocation mode rejects conflicting filePath and package identity before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-skill-conflicting-identity-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const packageDir = join(root, "fixture-package");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await mkdir(cwd, { recursive: true });
    await mkdir(join(agentDir), { recursive: true });
    await mkdir(join(packageDir, "skills", "alpha"), { recursive: true });
    await mkdir(join(packageDir, "skills", "beta"), { recursive: true });
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "reader-conflicting-identity-fixture", version: "1.0.0" }),
    );
    const alphaPath = join(packageDir, "skills", "alpha", "SKILL.md");
    const betaPath = join(packageDir, "skills", "beta", "SKILL.md");
    await writeFile(alphaPath, "---\nname: alpha\ndescription: Alpha fixture\n---\nalpha\n");
    await writeFile(betaPath, "---\nname: beta\ndescription: Beta fixture\n---\nbeta\n");
    const settingsPath = join(agentDir, "settings.json");
    await writeFile(settingsPath, JSON.stringify({
      packages: [packageDir],
      permissions: { allow: ["read"] },
    }));
    const before = await readFile(settingsPath, "utf8");

    const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
    const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
    allowFileRoot(cwd);
    const { PATCH } = await jiti.import("./route.ts");
    const response = await PATCH(new Request("http://localhost/api/skills", {
      method: "PATCH",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({
        action: "set_skill_invocation_mode",
        cwd,
        filePath: alphaPath,
        source: packageDir,
        resourceKey: "skills/beta/SKILL.md",
        mode: "explicit-only",
        scope: "global",
        viewScope: "global",
      }),
    }));

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "filePath and package identity identify different Skills",
    });
    assert.equal(await readFile(settingsPath, "utf8"), before);
    assert.equal((JSON.parse(await readFile(settingsPath, "utf8"))).piWebGlobalSkillInvocationModes, undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("project and package skill actions retain their distinct settings paths", async () => {
  const source = await readFile(routeUrl, "utf8");
  assert.match(source, /set_project_resource/);
  assert.match(source, /set_plugin_skill/);
  assert.match(source, /setProjectTopLevelOverride/);
  assert.match(source, /setProjectPackageResourceOverride/);
  assert.match(source, /setGlobalPluginSkillFilter/);
});


test("unified state API validates every target before writing and preserves Skill source bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-skill-group-"));
  const agentDir = join(root, "agent"), cwd = join(root, "project");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await mkdir(cwd);
    const filePath = join(agentDir, "skills", "fixture", "SKILL.md");
    await mkdir(join(agentDir, "skills", "fixture"), { recursive: true });
    const content = "---\nname: fixture\ndescription: Group fixture\n---\nfixture\n";
    await writeFile(filePath, content);
    const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
    const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
    allowFileRoot(cwd);
    const { PATCH } = await jiti.import("./route.ts");
    const request = (extra = {}) => new Request("http://localhost/api/skills", {
      method: "PATCH", headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ action: "set_skill_group", cwd, state: "explicit-only", viewScope: "global", items: [{ filePath }], ...extra }),
    });
    const response = await PATCH(request());
    assert.equal(response.status, 200);
    const result = await response.json();
    const skill = result.skills.find((skill) => skill.filePath === filePath);
    assert.equal(skill.policy.runtimeLoaded, true);
    assert.equal(skill.policy.promptVisible, false);
    assert.equal(skill.policy.commandUsable, true);
    assert.equal(await readFile(filePath, "utf8"), content);
    const settingsPath = join(agentDir, "settings.json"), before = await readFile(settingsPath, "utf8");
    const missing = await PATCH(request({ state: "disabled", items: [{ filePath }, { filePath: join(agentDir, "missing", "SKILL.md") }] }));
    assert.equal(missing.status, 404);
    assert.equal(await readFile(settingsPath, "utf8"), before);
    const duplicate = await PATCH(request({ items: [{ filePath }, { filePath }] }));
    assert.equal(duplicate.status, 400);
    assert.equal((await PATCH(request({ state: "inherit" }))).status, 400);
    assert.equal((await PATCH(request({ items: [] }))).status, 400);
    const disabled = await PATCH(request({ state: "disabled" }));
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json()).skills.find((s) => s.filePath === filePath).policy.commandUsable, false);
    const restored = await PATCH(request({ state: undefined, restore: result.snapshots }));
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).skills.find((s) => s.filePath === filePath).policy.promptVisible, true);
    assert.equal(await readFile(filePath, "utf8"), content);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
