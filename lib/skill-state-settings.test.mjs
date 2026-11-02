import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { readSkillStateSettings, writeSkillStateSettings } = await jiti.import("./skill-state-settings.ts");
const { getSkillPolicyKey } = await jiti.import("./skill-policy.ts");
const { trustProject } = await jiti.import("./project-trust.ts");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "reader-skill-use-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), agentDir = join(root, "agent"), pkg = join(root, "plugin");
  await Promise.all([mkdir(join(cwd, ".pi"), { recursive: true }), mkdir(join(agentDir, "skills", "local"), { recursive: true }), mkdir(join(pkg, "skills", "one"), { recursive: true })]);
  const local = { filePath: join(agentDir, "skills", "local", "SKILL.md"), policyKey: "top-level:local", sourceInfo: { scope: "user", origin: "top-level" } };
  const plugin = { filePath: join(pkg, "skills", "one", "SKILL.md"), policyKey: "package:fixture:skills/one/SKILL.md", pluginResourceKey: "skills/one/SKILL.md", sourceInfo: { scope: "user", origin: "package", source: pkg, baseDir: pkg } };
  await Promise.all([writeFile(local.filePath, "---\nname: local\ndescription: test\n---\nlocal\n"), writeFile(plugin.filePath, "---\nname: one\ndescription: test\n---\none\n"), writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg], permissions: { bash: "ask" }, piWebGlobalSkillInvocationModes: { "future:key": "future-value" } })), writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ permissions: { read: "allow" } }))]);
  trustProject(cwd, agentDir);
  const read = (scope, skill) => readSkillStateSettings(SettingsManager.create(cwd, agentDir, { projectTrusted: true }), cwd, scope, skill);
  const write = (scope, changes) => writeSkillStateSettings(cwd, agentDir, scope, changes);
  return { root, cwd, agentDir, local, plugin, read, write };
}

test("local and plugin resources transition through three states in the same settings file and restore prior filters/modes", async (t) => {
  const f = await fixture(t), skills = [f.local, f.plugin];
  const original = await Promise.all(skills.map((skill) => readFile(skill.filePath, "utf8")));
  for (const scope of ["global", "project"]) {
    const initial = skills.map((skill) => f.read(scope, skill));
    for (const state of ["automatic", "explicit-only", "disabled"]) {
      const snapshots = await f.write(scope, skills.map((skill) => ({ skill, state })));
      assert.equal(snapshots.length, 2);
      for (const skill of skills) {
        const after = f.read(scope, skill);
        assert.equal(after.resource, state === "disabled" ? "disabled" : "enabled");
        assert.equal(after.mode, state === "automatic" ? "automatic" : "explicit-only");
      }
    }
    await f.write(scope, skills.map((skill, index) => ({ skill, restore: initial[index] })));
    assert.deepEqual(skills.map((skill) => f.read(scope, skill)), initial);
  }
  assert.deepEqual(await Promise.all(skills.map((skill) => readFile(skill.filePath, "utf8"))), original);
  const saved = JSON.parse(await readFile(join(f.agentDir, "settings.json"), "utf8"));
  assert.deepEqual(saved.permissions, { bash: "ask" });
  assert.equal(saved.piWebGlobalSkillInvocationModes["future:key"], "future-value");
});

test("project Skill state writes preserve and normalize an existing invocation mode", async (t) => {
  const f = await fixture(t);
  const filePath = join(f.cwd, ".agents/skills/project-owned/SKILL.md");
  await mkdir(join(f.cwd, ".agents/skills/project-owned"), { recursive: true });
  await writeFile(filePath, "---\nname: project-owned\ndescription: test\n---\nproject\n");
  const policyKey = getSkillPolicyKey({ filePath });
  const skill = { filePath, policyKey, sourceInfo: { scope: "project", origin: "top-level" } };
  const settingsPath = join(f.cwd, ".pi/settings.json");
  await writeFile(settingsPath, JSON.stringify({ untouched: true, piWebProjectSkillInvocationModes: { [policyKey]: "explicit-only" } }));
  assert.equal(f.read("project", skill).mode, "explicit-only");
  await f.write("project", [{ skill, state: "automatic" }]);
  const saved = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(saved.untouched, true);
  assert.deepEqual(saved.piWebProjectSkillInvocationModes, { "top-level:project:.agents/skills/project-owned/SKILL.md": "automatic" });
  assert.equal(f.read("project", skill).mode, "automatic");
});

test("project inheritance clears both explicit axes and leaves global policy untouched", async (t) => {
  const f = await fixture(t);
  await f.write("global", [{ skill: f.local, state: "explicit-only" }]);
  const global = await readFile(join(f.agentDir, "settings.json"), "utf8");
  await f.write("project", [{ skill: f.local, state: "disabled" }]);
  await f.write("project", [{ skill: f.local, state: "inherit" }]);
  assert.deepEqual(f.read("project", f.local), { filePath: f.local.filePath, resource: "inherit", mode: null });
  assert.equal(await readFile(join(f.agentDir, "settings.json"), "utf8"), global);
});

test("a failing item aborts the complete settings write; parent disable cannot be bypassed", async (t) => {
  const f = await fixture(t), settingsPath = join(f.agentDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ packages: [{ source: f.plugin.sourceInfo.source, extensions: [], skills: [], prompts: [], themes: [] }], untouched: true }));
  const before = await readFile(settingsPath, "utf8");
  await assert.rejects(f.write("global", [{ skill: f.local, state: "disabled" }, { skill: f.plugin, state: "automatic" }]), /parent plugin/);
  assert.equal(await readFile(settingsPath, "utf8"), before);
  await assert.rejects(f.write("global", [{ skill: f.local, state: "inherit" }]), /Inheritance/);
  assert.equal(await readFile(settingsPath, "utf8"), before);
});

test("independent concurrent changes merge and atomic replacement preserves managed symlinks", async (t) => {
  const f = await fixture(t), settingsPath = join(f.agentDir, "settings.json"), backing = join(f.root, "shared-settings.json");
  await writeFile(backing, await readFile(settingsPath));
  await rm(settingsPath);
  await symlink(backing, settingsPath);
  await Promise.all([f.write("global", [{ skill: f.local, state: "explicit-only" }]), f.write("global", [{ skill: f.plugin, state: "automatic" }])]);
  assert.equal((await lstat(settingsPath)).isSymbolicLink(), true);
  assert.equal(f.read("global", f.local).mode, "explicit-only");
  assert.equal(f.read("global", f.plugin).mode, "automatic");
});

test("untrusted project writes preserve the prior file", async (t) => {
  const f = await fixture(t), untrusted = join(f.root, "untrusted");
  await mkdir(join(untrusted, ".pi"), { recursive: true });
  const path = join(untrusted, ".pi", "settings.json");
  await writeFile(path, '{"unchanged":true}');
  await assert.rejects(writeSkillStateSettings(untrusted, f.agentDir, "project", [{ skill: f.local, state: "disabled" }]), /trusted/);
  assert.equal(await readFile(path, "utf8"), '{"unchanged":true}');
});
