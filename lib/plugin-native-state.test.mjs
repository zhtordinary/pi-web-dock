import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createProjectPluginSettingsManager, getPluginPackageIdentity, PROJECT_PLUGIN_EXPLICIT_STATES_SETTING, reconcileProjectPluginSettings } = await jiti.import("./plugin-project-status.ts");
const { isDisabledPackage, setPackageEntryDisabled } = await jiti.import("./plugin-package-state.ts");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "reader-plugin-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), agentDir = join(root, "agent"), source = join(agentDir, "pkg");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  for (const name of ["a", "b"]) {
    await mkdir(join(source, "skills", name), { recursive: true });
    await writeFile(join(source, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n`);
  }
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", pi: { skills: ["skills"] } }));
  const options = { cwd, agentDir };
  const resolve = async (settings) => {
    const manager = new DefaultPackageManager({ ...options, settingsManager: settings });
    const paths = await manager.resolve(async () => "skip");
    return Object.fromEntries(paths.skills.filter(entry => entry.metadata.origin === "package")
      .map(entry => [relative(source, entry.path), entry.enabled]));
  };
  const manager = (global, project = {}) => {
    const state = SettingsManager.inMemory(global, { projectTrusted: true });
    for (const [key, value] of Object.entries(project)) state.updateProjectSettings(key, settings => { settings[key] = value; });
    return state;
  };
  return { root, cwd, agentDir, source, options, resolve, manager };
}

test("SDK native delta is not a parent cap: child force-enable wins unless Reader projects its explicit parent", async t => {
  const f = await fixture(t);
  const delta = { source: f.source, autoload: false, skills: ["!**", "+skills/a/SKILL.md"] };
  const state = f.manager({ packages: [f.source] }, { packages: [delta],
    [PROJECT_PLUGIN_EXPLICIT_STATES_SETTING]: { [getPluginPackageIdentity(f.source, { ...f.options, scope: "user" })]: "disabled" } });
  assert.equal((await f.resolve(state))["skills/a/SKILL.md"], true);
  assert.deepEqual(await f.resolve(createProjectPluginSettingsManager(state, f.options)), { "skills/a/SKILL.md": false, "skills/b/SKILL.md": false });
  assert.deepEqual(state.getProjectSettings().packages, [delta]);
});

test("global relative source and project absolute delta refer to one package in their own scopes", async t => {
  const f = await fixture(t);
  const state = f.manager({ packages: ["./pkg"] }, { packages: [{ source: f.source, autoload: false, skills: ["-skills/a/SKILL.md"] }] });
  assert.deepEqual(await f.resolve(createProjectPluginSettingsManager(state, f.options)), { "skills/a/SKILL.md": false, "skills/b/SKILL.md": true });
});

test("CLI rules appended while disabled survive enable and cannot bypass the Reader parent cap", async t => {
  const f = await fixture(t);
  const original = { source: f.source, autoload: false, skills: ["+skills/a/SKILL.md"] };
  const disabled = setPackageEntryDisabled(original, true);
  disabled.skills.push("+skills/b/SKILL.md");
  const stored = structuredClone(disabled);
  const state = f.manager({ packages: [disabled] });
  assert.equal(isDisabledPackage(disabled), true);
  assert.deepEqual(await f.resolve(createProjectPluginSettingsManager(state, f.options)), { "skills/a/SKILL.md": false, "skills/b/SKILL.md": false });
  assert.deepEqual(setPackageEntryDisabled(disabled, false), { ...original, skills: ["+skills/a/SKILL.md", "+skills/b/SKILL.md"] });
  assert.deepEqual(state.getGlobalSettings().packages, [stored], "generated projection must never rewrite user rules");
});

test("same long-lived projection reloads external CLI edits without persisting generated policy", async t => {
  const f = await fixture(t);
  const path = join(f.agentDir, "settings.json");
  await writeFile(path, JSON.stringify({ packages: [f.source], untouched: "user" }));
  const state = SettingsManager.create(f.cwd, f.agentDir, { projectTrusted: true });
  const projected = createProjectPluginSettingsManager(state, f.options);
  assert.equal((await f.resolve(projected))["skills/a/SKILL.md"], true);
  const changed = { packages: [{ source: f.source, skills: ["!skills/a/**"] }], untouched: "CLI" };
  await writeFile(path, JSON.stringify(changed));
  await reconcileProjectPluginSettings(projected, f.options);
  assert.deepEqual(await f.resolve(projected), { "skills/a/SKILL.md": false, "skills/b/SKILL.md": true });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), changed);
});

test("project-only disabled packages also cap later CLI child enables without rewriting them", async t => {
  const f = await fixture(t);
  const disabled = setPackageEntryDisabled(f.source, true);
  disabled.skills.push("+skills/a/SKILL.md");
  const state = f.manager({}, { packages: [disabled] });
  assert.deepEqual(await f.resolve(createProjectPluginSettingsManager(state, f.options)), { "skills/a/SKILL.md": false, "skills/b/SKILL.md": false });
  assert.deepEqual(state.getProjectSettings().packages, [disabled]);
});

test("global disabled to explicit project enabled restores the original filters and later CLI additions", async t => {
  const f = await fixture(t);
  const disabled = setPackageEntryDisabled({ source: f.source, autoload: false, skills: ["+skills/a/SKILL.md"] }, true);
  disabled.skills.push("+skills/b/SKILL.md");
  const state = f.manager({ packages: [disabled] }, { [PROJECT_PLUGIN_EXPLICIT_STATES_SETTING]: {
    [getPluginPackageIdentity(f.source, { ...f.options, scope: "user" })]: "enabled" } });
  const first = createProjectPluginSettingsManager(state, f.options);
  const twice = createProjectPluginSettingsManager(first, f.options);
  assert.deepEqual(await f.resolve(first), { "skills/a/SKILL.md": true, "skills/b/SKILL.md": true });
  assert.deepEqual(await f.resolve(twice), await f.resolve(first));
  assert.deepEqual(state.getGlobalSettings().packages, [disabled]);
});

test("enable removes only the recognized generated prefix and preserves all user rule suffixes", () => {
  const originals = ["./fixture", { source: "./fixture", autoload: false },
    { source: "./fixture", extensions: ["extensions/a.ts", "!extensions/b/**", "+extensions/c.ts"],
      skills: [], prompts: ["+prompts/a.md", "+prompts/b.md"], themes: ["!themes/private/**"] }];
  for (const original of originals) {
    const disabled = setPackageEntryDisabled(original, true);
    for (const type of ["extensions", "skills", "prompts", "themes"]) disabled[type].push("!CLI/user/**", "+CLI/new-resource", "-CLI/denied-resource");
    const before = structuredClone(disabled);
    const restored = setPackageEntryDisabled(disabled, false);
    for (const type of ["extensions", "skills", "prompts", "themes"]) {
      assert.deepEqual(restored[type], [...(typeof original === "string" ? [] : original[type] ?? []), "!CLI/user/**", "+CLI/new-resource", "-CLI/denied-resource"]);
    }
    assert.deepEqual(setPackageEntryDisabled(setPackageEntryDisabled(disabled, true), false), restored);
    assert.deepEqual(disabled, before);
  }
});

test("corrupt external settings cannot be reported as a successful fresh reconciliation", async t => {
  const f = await fixture(t);
  const path = join(f.agentDir, "settings.json");
  await writeFile(path, JSON.stringify({ packages: [f.source] }));
  const state = SettingsManager.create(f.cwd, f.agentDir, { projectTrusted: true });
  await writeFile(path, "{ broken CLI write");
  await assert.rejects(reconcileProjectPluginSettings(createProjectPluginSettingsManager(state, f.options), f.options), /reload/i);
  assert.equal(await readFile(path, "utf8"), "{ broken CLI write");
});

test("global and untrusted-project Skills consumers enforce the same parent cap after CLI edits", async t => {
  const f = await fixture(t);
  const disabled = setPackageEntryDisabled(f.source, true);
  disabled.skills.push("+skills/a/SKILL.md");
  await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ packages: [disabled] }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const { loadSkillsWithInstallInfo } = await jiti.import("./skills-service.ts");
  for (const viewScope of ["global", "project"]) {
    const catalog = await loadSkillsWithInstallInfo(f.cwd, viewScope, { readOnly: true });
    const entry = catalog.skills.find(skill => skill.filePath === join(f.source, "skills", "a", "SKILL.md"));
    assert.ok(entry, "disabled skill remains inspectable");
    assert.equal(entry.resourceState, "disabled", viewScope);
  }
  const { resolveGlobalSkillState } = await jiti.import("./skill-project-status.ts");
  const state = f.manager({ packages: [disabled] }, { [PROJECT_PLUGIN_EXPLICIT_STATES_SETTING]: {
    [getPluginPackageIdentity(f.source, { ...f.options, scope: "user" })]: "enabled" } });
  const catalog = await resolveGlobalSkillState(f.cwd, f.agentDir, state, createProjectPluginSettingsManager(state, f.options));
  const entry = catalog.entries.find(skill => skill.path === join(f.source, "skills", "a", "SKILL.md"));
  assert.equal(entry.globalEnabled, false);
  assert.equal(entry.projectEnabled, true);
});
