import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  GLOBAL_SKILL_INVOCATION_OVERRIDES_SETTING,
  getGlobalSkillInvocationOverride,
  setGlobalSkillInvocationOverride,
  skillInvocationOverrideKey,
} = await jiti.import("./skill-invocation-overrides.ts");

test("uses a home-relative global Skill identity across devices", () => {
  assert.equal(
    skillInvocationOverrideKey("/Users/alice/.agents/skills/demo/SKILL.md", "/Users/alice"),
    skillInvocationOverrideKey("/home/bob/.agents/skills/demo/SKILL.md", "/home/bob"),
  );
});

test("uses the discovered home path if a global Skill symlink resolves outside home", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-skill-external-link-"));
  try {
    const homes = [join(root, "alice"), join(root, "bob")];
    const keys = [];
    for (const [index, home] of homes.entries()) {
      const skillDir = join(home, ".agents", "skills", "demo");
      const externalDir = join(root, `external-${index}`);
      await mkdir(join(home, ".agents", "skills"), { recursive: true });
      await mkdir(externalDir, { recursive: true });
      await writeFile(join(externalDir, "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n");
      await symlink(externalDir, skillDir);
      keys.push(skillInvocationOverrideKey(join(skillDir, "SKILL.md"), home));
    }
    assert.deepEqual(keys, [
      "top-level:~/.agents/skills/demo/SKILL.md",
      "top-level:~/.agents/skills/demo/SKILL.md",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists invocation state under global settings without changing Skill bytes or unrelated settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-skill-invocation-"));
  try {
    const agentDir = join(root, ".pi", "agent");
    const sharedDir = join(root, "shared");
    const skillsDir = join(root, ".agents", "skills", "demo");
    await mkdir(agentDir, { recursive: true });
    await mkdir(sharedDir, { recursive: true });
    await mkdir(skillsDir, { recursive: true });

    const settingsPath = join(sharedDir, "settings.json");
    const skillPath = join(skillsDir, "SKILL.md");
    const originalSkill = "---\nname: demo\ndescription: demo\ndisable-model-invocation: true\n---\n\nKeep the original body.\n";
    await writeFile(settingsPath, JSON.stringify({ defaultProvider: "demo", customSetting: { keep: true } }, null, 2) + "\n");
    await symlink(settingsPath, join(agentDir, "settings.json"));
    await writeFile(skillPath, originalSkill);

    await setGlobalSkillInvocationOverride(agentDir, skillPath, "enabled");
    let settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(settings.defaultProvider, "demo");
    assert.deepEqual(settings.customSetting, { keep: true });
    const key = skillInvocationOverrideKey(skillPath);
    assert.equal(settings[GLOBAL_SKILL_INVOCATION_OVERRIDES_SETTING][key], "enabled");
    assert.equal(getGlobalSkillInvocationOverride(settings, skillPath), "enabled");
    assert.equal(await readFile(skillPath, "utf8"), originalSkill);

    await setGlobalSkillInvocationOverride(agentDir, skillPath, "disabled");
    settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(getGlobalSkillInvocationOverride(settings, skillPath), "disabled");
    assert.equal(await readFile(skillPath, "utf8"), originalSkill);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes concurrent updates without dropping another Skill override", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-skill-invocation-concurrent-"));
  try {
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    const settingsPath = join(agentDir, "settings.json");
    await writeFile(settingsPath, "{}\n");
    const first = join(root, "skills", "first", "SKILL.md");
    const second = join(root, "skills", "second", "SKILL.md");
    await mkdir(join(first, ".."), { recursive: true });
    await mkdir(join(second, ".."), { recursive: true });
    await writeFile(first, "---\nname: first\ndescription: first\n---\n");
    await writeFile(second, "---\nname: second\ndescription: second\n---\n");

    await Promise.all([
      setGlobalSkillInvocationOverride(agentDir, first, "enabled"),
      setGlobalSkillInvocationOverride(agentDir, second, "disabled"),
    ]);

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    const overrides = settings[GLOBAL_SKILL_INVOCATION_OVERRIDES_SETTING];
    assert.equal(overrides[skillInvocationOverrideKey(first)], "enabled");
    assert.equal(overrides[skillInvocationOverrideKey(second)], "disabled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses malformed settings instead of replacing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-skill-invocation-invalid-"));
  try {
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    const settingsPath = join(agentDir, "settings.json");
    await writeFile(settingsPath, "{invalid json\n");
    await assert.rejects(
      setGlobalSkillInvocationOverride(agentDir, join(root, "demo", "SKILL.md"), "disabled"),
      /not valid JSON/,
    );
    assert.equal(await readFile(settingsPath, "utf8"), "{invalid json\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
