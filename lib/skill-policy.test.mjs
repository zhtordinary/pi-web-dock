import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { homedir, tmpdir } from "node:os";
import { createJiti } from "jiti";
import { ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getConfiguredSkillInvocationMode, getSkillInvocationModes, getSkillPolicyKey, resolveSkillPolicy, setProjectSkillInvocationMode, updateModeMap } = await jiti.import("./skill-policy.ts");
const { resolveRuntimeSkillPolicy } = await jiti.import("./skill-runtime-policy.ts");
const { trustProject } = await jiti.import("./project-trust.ts");

test("local package modes persist portably and resolve exact SDK keys on different homes", () => {
  const previousHome = process.env.HOME;
  const portable = "package:local:~/.pi/agent/packages/pi-plan-execute:skills/plan-execute/SKILL.md";
  const field = "piWebGlobalSkillInvocationModes";
  const settings = {};
  try {
    for (const home of ["/Users/reader-fixture", "/home/reader-fixture"]) {
      process.env.HOME = home;
      const sourceInfo = { origin: "package", scope: "user", source: "~/.pi/agent/packages/pi-plan-execute" };
      const filePath = join(home, ".pi/agent/packages/pi-plan-execute/skills/plan-execute/SKILL.md");
      const pluginResourceKey = "skills/plan-execute/SKILL.md";
      const policyKey = getSkillPolicyKey({ filePath, sourceInfo, pluginResourceKey, cwd: home, agentDir: join(home, ".pi/agent") });
      assert.equal(policyKey, `package:local:${home}/.pi/agent/packages/pi-plan-execute:${pluginResourceKey}`);
      if (!settings[field]) updateModeMap(settings, field, policyKey, "explicit-only");
      assert.deepEqual(settings[field], { [portable]: "explicit-only" });
      const modes = getSkillInvocationModes(settings, "global");
      assert.deepEqual(modes, { [policyKey]: "explicit-only" });
      assert.equal(getConfiguredSkillInvocationMode(settings, "global", policyKey), "explicit-only");
      const policy = resolveRuntimeSkillPolicy({ filePath, sourceInfo, pluginResourceKey }, {
        scope: "global", cwd: home, agentDir: join(home, ".pi/agent"), globalInvocationModes: modes,
      });
      assert.equal(policy.invocationMode, "explicit-only");
      assert.equal(policy.promptVisible, false);
      assert.equal(policy.commandUsable, true);
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("project Skill modes use one relative setting across different device roots", () => {
  const previousHome = process.env.HOME;
  const field = "piWebProjectSkillInvocationModes";
  const portable = "top-level:project:.agents/skills/demo/SKILL.md";
  const settings = {};
  try {
    for (const [home, cwd] of [
      ["/Users/reader-fixture", "/Users/reader-fixture/Projects/drawing"],
      ["/Users/air-fixture", "/Volumes/external/Projects/drawing"],
    ]) {
      process.env.HOME = home;
      const filePath = join(cwd, ".agents/skills/demo/SKILL.md");
      const key = getSkillPolicyKey({ filePath });
      if (!settings[field]) updateModeMap(settings, field, key, "explicit-only", cwd);
      assert.deepEqual(settings[field], { [portable]: "explicit-only" });
      const modes = getSkillInvocationModes(settings, "project", cwd);
      assert.equal(modes[key], "explicit-only");
      const skill = { name: "demo", filePath, baseDir: join(cwd, ".agents/skills/demo"), sourceInfo: { scope: "project", origin: "top-level" } };
      const policy = resolveRuntimeSkillPolicy(skill, { scope: "project", cwd, projectInvocationModes: modes });
      assert.equal(policy.invocationMode, "explicit-only");
      assert.equal(policy.promptVisible, false);
      assert.equal(policy.commandUsable, true);
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("project-relative modes take precedence and writes clear their local legacy alias", () => {
  const field = "piWebProjectSkillInvocationModes";
  const cwd = "/reader-fixture/project";
  const local = getSkillPolicyKey({ filePath: join(cwd, ".agents/skills/demo/SKILL.md") });
  const portable = "top-level:project:.agents/skills/demo/SKILL.md";
  const settings = { [field]: { [local]: "explicit-only", "future:key": "future-mode" } };
  assert.equal(getConfiguredSkillInvocationMode(settings, "project", local, cwd), "explicit-only");
  assert.equal(updateModeMap(settings, field, local, "automatic", cwd), true);
  assert.deepEqual(settings[field], { [portable]: "automatic", "future:key": "future-mode" });
  settings[field][local] = "explicit-only";
  assert.equal(getConfiguredSkillInvocationMode(settings, "project", local, cwd), "automatic");
  assert.equal(updateModeMap(settings, field, local, null, cwd), true);
  assert.deepEqual(settings[field], { "future:key": "future-mode" });
});

test("project-relative mode keys cannot escape their project", () => {
  const field = "piWebProjectSkillInvocationModes";
  const cwd = "/reader-fixture/project";
  const escaped = "top-level:project:../../outside/SKILL.md";
  const absolute = "top-level:project:/outside/SKILL.md";
  const outside = getSkillPolicyKey({ filePath: "/outside/SKILL.md" });
  const settings = { [field]: { [escaped]: "explicit-only", [absolute]: "explicit-only" } };
  const modes = getSkillInvocationModes(settings, "project", cwd);
  assert.equal(modes[outside], undefined);
  assert.equal(modes[escaped], "explicit-only");
  assert.equal(modes[absolute], "explicit-only");
});

test("project-relative modes canonicalize internal aliases but reject external symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-project-mode-symlinks-"));
  const cwd = join(root, "project"), real = join(cwd, ".agents/skills/demo"), alias = join(cwd, ".pi/skills/demo");
  const external = join(root, "external");
  const field = "piWebProjectSkillInvocationModes";
  try {
    await mkdir(real, { recursive: true });
    await mkdir(join(cwd, ".pi/skills"), { recursive: true });
    await mkdir(external);
    await writeFile(join(real, "SKILL.md"), "demo");
    await writeFile(join(external, "SKILL.md"), "external");
    await symlink("../../.agents/skills/demo", alias);
    await symlink(external, join(cwd, ".agents/skills/outside"));
    const key = getSkillPolicyKey({ filePath: join(alias, "SKILL.md") });
    const settings = {};
    updateModeMap(settings, field, key, "explicit-only", cwd);
    assert.deepEqual(settings[field], { "top-level:project:.agents/skills/demo/SKILL.md": "explicit-only" });
    const escaped = "top-level:project:.agents/skills/outside/SKILL.md";
    settings[field][escaped] = "automatic";
    const modes = getSkillInvocationModes(settings, "project", cwd);
    assert.equal(modes[key], "explicit-only");
    assert.equal(modes[getSkillPolicyKey({ filePath: join(external, "SKILL.md") })], undefined);
    assert.equal(modes[escaped], "automatic");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable modes win over local legacy aliases and writes migrate or clear both forms", () => {
  const field = "piWebProjectSkillInvocationModes";
  const legacy = `package:local:${homedir()}/packages/demo:skills/demo/SKILL.md`;
  const portable = "package:local:~/packages/demo:skills/demo/SKILL.md";
  for (const entries of [
    [[legacy, "automatic"], [portable, "explicit-only"]],
    [[portable, "explicit-only"], [legacy, "automatic"]],
  ]) {
    const settings = { [field]: Object.fromEntries(entries), untouched: true };
    assert.deepEqual(getSkillInvocationModes(settings, "project"), { [legacy]: "explicit-only" });
    assert.equal(updateModeMap(settings, field, legacy, "explicit-only"), true);
    assert.deepEqual(settings, { [field]: { [portable]: "explicit-only" }, untouched: true });
    assert.equal(updateModeMap(settings, field, legacy, "explicit-only"), false);
    settings[field][legacy] = "automatic";
    assert.equal(updateModeMap(settings, field, legacy, null), true);
    assert.deepEqual(settings, { untouched: true });
  }
  const settings = { [field]: { [legacy]: "explicit-only", "future:key": "future-mode" } };
  assert.deepEqual(getSkillInvocationModes(settings, "project"), { [legacy]: "explicit-only" });
  assert.equal(updateModeMap(settings, field, legacy, "explicit-only"), true);
  assert.deepEqual(settings[field], { [portable]: "explicit-only", "future:key": "future-mode" });
  assert.equal(updateModeMap(settings, field, portable, null), true);
  assert.deepEqual(settings[field], { "future:key": "future-mode" });
});

test("non-home packages and foreign legacy keys keep their exact identities", () => {
  const field = "piWebGlobalSkillInvocationModes";
  const keys = [
    `package:local:${homedir()}-other/packages/demo:skills/demo/SKILL.md`,
    "package:local:/foreign/home/packages/demo:skills/demo/SKILL.md",
    "package:npm:demo:skills/demo/SKILL.md",
    "package:git:github.com/example/demo:skills/demo/SKILL.md",
    "top-level:~/skills/demo/SKILL.md",
  ];
  const settings = {};
  for (const key of keys) updateModeMap(settings, field, key, "explicit-only");
  const expected = Object.fromEntries(keys.map((key) => [key, "explicit-only"]));
  assert.deepEqual(settings[field], expected);
  assert.deepEqual(getSkillInvocationModes(settings, "global"), expected);
});

test("resource disabled caps loading, prompt visibility, and explicit command use", () => {
  const policy = resolveSkillPolicy({
    policyKey: "top-level:~/skills/demo/SKILL.md",
    scope: "global",
    resourceState: "disabled",
    globalInvocationMode: "automatic",
  });
  assert.equal(policy.invocationMode, "automatic");
  assert.equal(policy.runtimeLoaded, false);
  assert.equal(policy.promptVisible, false);
  assert.equal(policy.commandUsable, false);
});

test("explicit-only keeps an enabled Skill loaded and manually usable", () => {
  const policy = resolveSkillPolicy({
    policyKey: "package:npm:demo:skills/demo/SKILL.md",
    scope: "project",
    resourceState: "enabled",
    globalInvocationMode: "automatic",
    projectInvocationMode: "explicit-only",
  });
  assert.equal(policy.invocationMode, "explicit-only");
  assert.equal(policy.invocationModeSource, "explicit");
  assert.equal(policy.runtimeLoaded, true);
  assert.equal(policy.promptVisible, false);
  assert.equal(policy.commandUsable, true);
});

test("project mode inherits global mode only when project has no override", () => {
  const inherited = resolveSkillPolicy({
    policyKey: "package:npm:demo:skills/demo/SKILL.md",
    scope: "project",
    resourceState: "enabled",
    globalInvocationMode: "explicit-only",
  });
  assert.equal(inherited.invocationMode, "explicit-only");
  assert.equal(inherited.invocationModeSource, "inherited");

  const overridden = resolveSkillPolicy({
    policyKey: inherited.policyKey,
    scope: "project",
    resourceState: "enabled",
    globalInvocationMode: "explicit-only",
    projectInvocationMode: "automatic",
  });
  assert.equal(overridden.invocationMode, "automatic");
  assert.equal(overridden.invocationModeSource, "explicit");
  assert.equal(overridden.promptVisible, true);
});

test("legacy global and frontmatter/manual metadata remain fallback sources", () => {
  assert.equal(resolveSkillPolicy({
    policyKey: "top-level:~/legacy/SKILL.md",
    scope: "global",
    resourceState: "enabled",
    legacyGlobalInvocationOverride: "enabled",
    declaresManualInvocation: true,
  }).invocationMode, "automatic");
  assert.equal(resolveSkillPolicy({
    policyKey: "top-level:~/frontmatter/SKILL.md",
    scope: "global",
    resourceState: "enabled",
    declaresManualInvocation: true,
  }).invocationMode, "explicit-only");
  assert.equal(resolveSkillPolicy({
    policyKey: "top-level:~/analysis/SKILL.md",
    scope: "global",
    resourceState: "enabled",
    triggerMode: "manual",
  }).invocationMode, "explicit-only");
});

test("stale and unavailable resources are explicit availability states", () => {
  for (const availability of ["stale", "unavailable"]) {
    const policy = resolveSkillPolicy({
      policyKey: `top-level:~/${availability}/SKILL.md`,
      scope: "global",
      resourceState: "enabled",
      availability,
    });
    assert.equal(policy.availability, availability);
    assert.equal(policy.runtimeLoaded, false);
    assert.equal(policy.promptVisible, false);
    assert.equal(policy.commandUsable, false);
  }
});

test("independent SDK SettingsManagers merge project mode keys under the Reader lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-skill-policy-project-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const settingsPath = join(cwd, ".pi", "settings.json");
  const firstKey = "package:npm:fixture:skills/first/SKILL.md";
  const secondKey = "package:npm:fixture:skills/second/SKILL.md";
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({
      permissions: { bash: "ask" },
      piWebProjectSkillInvocationModes: {
        "package:npm:fixture:skills/existing/SKILL.md": "automatic",
        "future:unknown": "future-mode",
      },
    }, null, 2));
    trustProject(cwd, agentDir);

    // Deliberately use two independently loaded SDK managers. The SDK's
    // updateProjectSettings snapshots can lose one key; Reader's helper must
    // re-read and merge each nested key while holding the Reader file lock.
    const first = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const second = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    await Promise.all([
      setProjectSkillInvocationMode(cwd, agentDir, firstKey, "explicit-only"),
      setProjectSkillInvocationMode(cwd, agentDir, secondKey, "automatic"),
    ]);
    await Promise.all([first.flush(), second.flush()]);

    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepEqual(saved.permissions, { bash: "ask" });
    assert.deepEqual(saved.piWebProjectSkillInvocationModes, {
      "package:npm:fixture:skills/existing/SKILL.md": "automatic",
      "future:unknown": "future-mode",
      [firstKey]: "explicit-only",
      [secondKey]: "automatic",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("merges independent SDK managers on the first write when project settings are missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-skill-policy-project-first-write-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const settingsPath = join(cwd, ".pi", "settings.json");
  const firstKey = "package:npm:fixture:skills/first/SKILL.md";
  const secondKey = "package:npm:fixture:skills/second/SKILL.md";
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "mcp.json"), "{}\n");
    trustProject(cwd, agentDir);
    const first = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const second = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    await Promise.all([
      setProjectSkillInvocationMode(cwd, agentDir, firstKey, "explicit-only"),
      setProjectSkillInvocationMode(cwd, agentDir, secondKey, "automatic"),
    ]);

    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepEqual(saved.piWebProjectSkillInvocationModes, {
      [firstKey]: "explicit-only",
      [secondKey]: "automatic",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clears one project mode while preserving the other mode and settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-skill-policy-project-clear-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const settingsPath = join(cwd, ".pi", "settings.json");
  const clearKey = "package:npm:fixture:skills/clear/SKILL.md";
  const keepKey = "package:npm:fixture:skills/keep/SKILL.md";
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({
      permissions: { bash: "ask" },
      piWebProjectSkillInvocationModes: {
        [clearKey]: "explicit-only",
        [keepKey]: "automatic",
        "future:unknown": "future-mode",
      },
    }, null, 2));
    trustProject(cwd, agentDir);
    await setProjectSkillInvocationMode(cwd, agentDir, clearKey, null);

    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepEqual(saved.permissions, { bash: "ask" });
    assert.deepEqual(saved.piWebProjectSkillInvocationModes, {
      [keepKey]: "automatic",
      "future:unknown": "future-mode",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses the target project's trust and rejects a revoked decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-skill-policy-project-trust-boundary-"));
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  const agentDir = join(root, "agent");
  const settingsA = join(projectA, ".pi", "settings.json");
  const settingsB = join(projectB, ".pi", "settings.json");
  try {
    await mkdir(join(projectA, ".pi"), { recursive: true });
    await mkdir(join(projectB, ".pi"), { recursive: true });
    await writeFile(settingsA, "{}\n");
    await writeFile(settingsB, "{}\n");
    const trustStore = new ProjectTrustStore(agentDir);
    trustStore.set(projectA, true);
    await setProjectSkillInvocationMode(projectA, agentDir, "top-level:~/skills/trusted/SKILL.md", "automatic");

    const beforeB = await readFile(settingsB, "utf8");
    await assert.rejects(
      () => setProjectSkillInvocationMode(projectB, agentDir, "top-level:~/skills/untrusted/SKILL.md", "automatic"),
      /untrusted project/,
    );
    assert.equal(await readFile(settingsB, "utf8"), beforeB);

    trustProject(projectB, agentDir);
    await setProjectSkillInvocationMode(projectB, agentDir, "top-level:~/skills/trusted/SKILL.md", "automatic");
    assert.equal(
      JSON.parse(await readFile(settingsB, "utf8")).piWebProjectSkillInvocationModes["top-level:~/skills/trusted/SKILL.md"],
      "automatic",
    );

    trustStore.set(projectB, false);
    const beforeRevoked = await readFile(settingsB, "utf8");
    await assert.rejects(
      () => setProjectSkillInvocationMode(projectB, agentDir, "top-level:~/skills/trusted/SKILL.md", null),
      /untrusted project/,
    );
    assert.equal(await readFile(settingsB, "utf8"), beforeRevoked);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leaves a corrupt project settings file untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-skill-policy-project-corrupt-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const settingsPath = join(cwd, ".pi", "settings.json");
  const corrupt = "{\n  \"permissions\":\n";
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(settingsPath, corrupt);
    trustProject(cwd, agentDir);
    await assert.rejects(
      () => setProjectSkillInvocationMode(cwd, agentDir, "top-level:~/skills/corrupt/SKILL.md", "automatic"),
      SyntaxError,
    );
    assert.equal(await readFile(settingsPath, "utf8"), corrupt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
