import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  createProjectSkillSettingsManager,
  applySkillInvocationOverrides,
  getEffectiveProjectSkillEnabled,
  getProjectSkillStatus,
  reconcileProjectSkillStates,
} = await jiti.import("./skill-project-status.ts");
const { getPluginPackageIdentity } = await jiti.import("./plugin-project-status.ts");
const { resolveGlobalSkillState } = await jiti.import("./skill-project-status.ts");
const { setProjectTopLevelOverride } = await jiti.import("./project-resource-policy.ts");
const { setGlobalPluginSkillFilter } = await jiti.import("./plugin-overrides.ts");
const { setGlobalSkillInvocationOverride } = await jiti.import("./skill-invocation-overrides.ts");

test("keeps project skill state independent from later global changes", () => {
  const entries = [
    {
      key: "package:npm:tool:skills/a/SKILL.md",
      path: "/global/a/SKILL.md",
      source: "npm:tool@1.0.0",
      resourceKey: "skills/a/SKILL.md",
      packageIdentity: "npm:tool",
      scope: "user",
      globalEnabled: true,
      projectEnabled: true,
    },
  ];
  const initial = reconcileProjectSkillStates(entries, {});
  assert.deepEqual(initial.states, { [entries[0].key]: "enabled" });

  const changed = reconcileProjectSkillStates(
    [{ ...entries[0], globalEnabled: false, projectEnabled: true }],
    { piWebProjectSkillStates: initial.states },
  );
  assert.deepEqual(changed.states, initial.states);
  assert.equal(getProjectSkillStatus(changed.states[entries[0].key], false), "different");
});

test("treats a missing project override as inherited", () => {
  assert.equal(getProjectSkillStatus(undefined, true), "matching");
  assert.equal(getProjectSkillStatus(undefined, false), "matching");
});

test("compares final effective state when a parent plugin disables project resources", () => {
  assert.equal(getProjectSkillStatus("enabled", false, false), "matching");
  assert.equal(getProjectSkillStatus(undefined, false, true), "different");
});

test("parent plugin disable caps a preserved project skill override", () => {
  assert.equal(getEffectiveProjectSkillEnabled("enabled", false), false);
  assert.equal(getEffectiveProjectSkillEnabled("enabled", true), true);
  assert.equal(getEffectiveProjectSkillEnabled(undefined, false), false);
});

test("adds new global skills and removes stale project state", () => {
  const entries = [
    { key: "old", path: "/old", scope: "user", globalEnabled: true, projectEnabled: true },
    { key: "new", path: "/new", scope: "user", globalEnabled: false, projectEnabled: false },
  ];
  const result = reconcileProjectSkillStates(entries, {
    piWebProjectSkillStates: { old: "disabled", stale: "enabled" },
  });
  assert.deepEqual(result.states, { old: "disabled", new: "disabled" });
  assert.deepEqual(result.removedKeys, ["stale"]);
});

test("preserves persisted project resource state in the settings manager", () => {
  const cwd = "/tmp/pi-reader-skill-runtime";
  const agentDir = `${cwd}/agent`;
  const packageIdentity = getPluginPackageIdentity("npm:tool@1.0.0", { cwd, agentDir, scope: "user" });
  const runtime = {
    entries: [
      {
        key: "package-key",
        path: `${cwd}/global/skills/a/SKILL.md`,
        source: "npm:tool@1.0.0",
        resourceKey: "skills/a/SKILL.md",
        packageIdentity,
        scope: "user",
        globalEnabled: true,
        projectEnabled: true,
      },
      {
        key: "top-level-key",
        path: `${cwd}/global/SKILL.md`,
        scope: "user",
        globalEnabled: false,
        projectEnabled: false,
      },
    ],
    states: { "package-key": "disabled", "top-level-key": "enabled" },
  };
  const settings = SettingsManager.inMemory({
    packages: [{ source: "npm:tool@2.0.0", skills: ["-skills/a/SKILL.md"] }],
  }, { projectTrusted: true });
  settings.setProjectSkillPaths([`${cwd}/global/SKILL.md`]);
  const proxy = createProjectSkillSettingsManager(settings, runtime, { cwd, agentDir });
  assert.deepEqual(proxy.getGlobalSettings().packages[0].skills, ["-skills/a/SKILL.md"]);
  assert.deepEqual(proxy.getProjectSettings().skills, [`${cwd}/global/SKILL.md`]);
  assert.deepEqual(proxy.getSkillPaths(), [`${cwd}/global/SKILL.md`]);

test("panel state overrides disable-model-invocation without editing the skill file", () => {
  const entry = {
    key: "package-key",
    path: "/global/skills/a/SKILL.md",
    source: "npm:tool@1.0.0",
    resourceKey: "skills/a/SKILL.md",
    packageIdentity: "npm:tool",
    scope: "user",
    globalEnabled: true,
    projectEnabled: true,
  };
  const dormant = {
    name: "a",
    description: "a",
    filePath: entry.path,
    disableModelInvocation: true,
  };

  assert.equal(
    applySkillInvocationOverrides([dormant], [entry], {}, "global")[0].disableModelInvocation,
    false,
  );
  assert.equal(
    applySkillInvocationOverrides([dormant], [entry], { [entry.key]: "disabled" }, "project")[0]
      .disableModelInvocation,
    true,
  );
  assert.equal(
    applySkillInvocationOverrides([dormant], [entry], { [entry.key]: "enabled" }, "project")[0]
      .disableModelInvocation,
    false,
  );
});
});

test("uses the effective project resource state for prompt invocation", () => {
  const skill = {
    name: "project-skill",
    description: "project-skill",
    filePath: "/global/skills/project/SKILL.md",
    disableModelInvocation: true,
  };
  const entry = {
    key: "package-project-skill",
    path: skill.filePath,
    source: "npm:tool@1.0.0",
    resourceKey: "skills/project/SKILL.md",
    packageIdentity: "npm:tool",
    scope: "user",
    globalEnabled: false,
    projectEnabled: true,
  };

  assert.equal(applySkillInvocationOverrides([skill], [entry], {}, "project")[0].disableModelInvocation, false);
  assert.equal(
    applySkillInvocationOverrides([skill], [{ ...entry, projectEnabled: false }], { [entry.key]: "enabled" }, "project")[0]
      .disableModelInvocation,
    true,
  );
  assert.equal(
    applySkillInvocationOverrides([skill], [], {}, "project", new Map([[skill.filePath, true]]))[0]
      .disableModelInvocation,
    false,
  );
});

test("an explicit project enable wakes a dormant global skill and an inherited state does not", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-skill-dormant-"));
  try {
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const skillPath = join(agentDir, "skills", "dormant", "SKILL.md");
    await mkdir(join(skillPath, ".."), { recursive: true });
    await writeFile(skillPath, "---\nname: dormant\ndescription: dormant\ndisable-model-invocation: true\n---\n");
    await mkdir(cwd, { recursive: true });

    const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    settings.setSkillPaths([skillPath]);
    await settings.flush();

    // Inherited: the file policy stays in force.
    const inherited = await resolveGlobalSkillState(cwd, agentDir, settings);
    const inheritedEntry = inherited.entries.find((entry) => entry.path === skillPath);
    assert.equal(inheritedEntry?.globalEnabled, false, "file policy keeps the skill dormant by default");

    // Explicit project enable: the Reader switch overrides the file policy.
    setProjectTopLevelOverride(settings, cwd, "skills", skillPath, "enabled");
    await settings.flush();
    const enabled = await resolveGlobalSkillState(cwd, agentDir, settings);
    const enabledEntry = enabled.entries.find((entry) => entry.path === skillPath);
    assert.equal(enabledEntry?.projectEnabled, true, "explicit project enable wakes the skill");

    // Explicit project disable wins in the other direction too.
    setProjectTopLevelOverride(settings, cwd, "skills", skillPath, "disabled");
    await settings.flush();
    const disabled = await resolveGlobalSkillState(cwd, agentDir, settings);
    const disabledEntry = disabled.entries.find((entry) => entry.path === skillPath);
    assert.equal(disabledEntry?.projectEnabled, false);

    assert.equal(await readFile(skillPath, "utf8"), "---\nname: dormant\ndescription: dormant\ndisable-model-invocation: true\n---\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an inherited package skill keeps its file policy instead of being force-woken", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-skill-package-dormant-"));
  try {
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const packageRoot = join(root, "pkg");
    const skillPath = join(packageRoot, "skills", "demo", "SKILL.md");
    await mkdir(join(skillPath, ".."), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(skillPath, "---\nname: demo\ndescription: demo\ndisable-model-invocation: true\n---\n");

    const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    settings.setPackages([packageRoot]);
    await settings.flush();

    const state = await resolveGlobalSkillState(cwd, agentDir, settings);
    const entry = state.entries.find((candidate) => candidate.path === skillPath);
    assert.equal(entry?.globalEnabled, false, "no explicit Reader switch means the file policy applies");
    assert.equal(entry?.projectEnabled, false);

    // An explicit global switch is what overrides the file policy.
    setGlobalPluginSkillFilter(settings, packageRoot, "skills/demo/SKILL.md", "enabled");
    await settings.flush();
    const enabled = await resolveGlobalSkillState(cwd, agentDir, settings);
    assert.equal(
      enabled.entries.find((candidate) => candidate.path === skillPath)?.globalEnabled,
      true,
      "explicit global enable wakes the package skill",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("global top-level invocation settings override frontmatter and preserve the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-global-skill-invocation-"));
  try {
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const skillPath = join(agentDir, "skills", "dormant", "SKILL.md");
    const original = "---\nname: dormant\ndescription: dormant\ndisable-model-invocation: true\n---\n\nPreserve this body.\n";
    await mkdir(join(skillPath, ".."), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(skillPath, original);

    let settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    settings.setSkillPaths([skillPath]);
    await settings.flush();
    const inherited = await resolveGlobalSkillState(cwd, agentDir, settings);
    assert.equal(inherited.entries.find((entry) => entry.path === skillPath)?.globalEnabled, false);

    await setGlobalSkillInvocationOverride(agentDir, skillPath, "enabled");
    settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    let state = await resolveGlobalSkillState(cwd, agentDir, settings);
    let entry = state.entries.find((candidate) => candidate.path === skillPath);
    assert.equal(entry?.globalEnabled, true);
    assert.equal(entry?.globalInvocationOverride, "enabled");
    assert.equal(applySkillInvocationOverrides([{ name: "dormant", filePath: skillPath, disableModelInvocation: true }], state.entries, {}, "global")[0].disableModelInvocation, false);

    await setGlobalSkillInvocationOverride(agentDir, skillPath, "disabled");
    settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    state = await resolveGlobalSkillState(cwd, agentDir, settings);
    entry = state.entries.find((candidate) => candidate.path === skillPath);
    assert.equal(entry?.globalEnabled, false);
    assert.equal(entry?.globalInvocationOverride, "disabled");
    assert.equal(applySkillInvocationOverrides([{ name: "dormant", filePath: skillPath, disableModelInvocation: false }], state.entries, {}, "global")[0].disableModelInvocation, true);
    assert.equal(await readFile(skillPath, "utf8"), original);

    settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    settings.setSkillPaths([skillPath]);
    setProjectTopLevelOverride(settings, cwd, "skills", skillPath, "enabled");
    await settings.flush();
    state = await resolveGlobalSkillState(cwd, agentDir, settings);
    entry = state.entries.find((candidate) => candidate.path === skillPath);
    assert.equal(entry?.projectEnabled, true, "explicit project enable can override global invocation policy");
    assert.equal(applySkillInvocationOverrides([{ name: "dormant", filePath: skillPath, disableModelInvocation: true }], state.entries, {}, "project")[0].disableModelInvocation, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
