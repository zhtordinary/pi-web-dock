import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  clearGlobalTopLevelSkillOverride,
  clearProjectPackageOverride,
  clearProjectPackageResourceOverride,
  clearProjectTopLevelOverride,
  getGlobalTopLevelSkillOverride,
  getProjectPackageOverride,
  getProjectPackageResourceOverride,
  getProjectTopLevelOverride,
  migrateLegacyProjectOverrides,
  migrateProjectWebStateKeys,
  setGlobalTopLevelSkillOverride,
  setProjectPackageOverride,
  setProjectPackageResourceOverride,
  setProjectTopLevelOverride,
} = await jiti.import("./project-resource-policy.ts");
const { DefaultPackageManager, SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { PROJECT_PLUGIN_EXPLICIT_STATES_SETTING, createProjectPluginSettingsManager } = await jiti.import("./plugin-project-status.ts");
const { setPackageEntryDisabled } = await jiti.import("./plugin-package-state.ts");

async function resolveSkills(root, agentDir, settingsManager) {
  const manager = new DefaultPackageManager({ cwd: root, agentDir, settingsManager });
  const resolved = await manager.resolve(async () => "skip");
  return resolved.skills;
}

test("project package policy changes only the project resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-policy-package-"));
  try {
    await mkdir(join(root, "skills", "demo"), { recursive: true });
    await writeFile(join(root, "skills", "demo", "SKILL.md"), "---\ndescription: demo\n---\n");
    const agentDir = join(root, "agent");
    const settings = SettingsManager.inMemory({ packages: [root] }, { projectTrusted: true });
    const globalOnly = SettingsManager.inMemory(settings.getGlobalSettings(), { projectTrusted: true });

    assert.equal((await resolveSkills(root, agentDir, globalOnly)).find((resource) => resource.path.endsWith(join("skills", "demo", "SKILL.md")))?.enabled, true);
    setProjectPackageOverride(settings, root, "disabled");
    assert.equal(getProjectPackageOverride(settings, root), "disabled");
    assert.equal(Object.hasOwn(settings.getProjectSettings(), PROJECT_PLUGIN_EXPLICIT_STATES_SETTING), true);
    assert.equal((await resolveSkills(root, agentDir, settings)).find((resource) => resource.path.endsWith(join("skills", "demo", "SKILL.md")))?.enabled, false);
    assert.equal((await resolveSkills(root, agentDir, globalOnly)).find((resource) => resource.path.endsWith(join("skills", "demo", "SKILL.md")))?.enabled, true);

    clearProjectPackageOverride(settings, root);
    assert.equal(getProjectPackageOverride(settings, root), "inherit");
    assert.equal(Object.hasOwn(settings.getProjectSettings(), PROJECT_PLUGIN_EXPLICIT_STATES_SETTING), false);
    assert.equal((await resolveSkills(root, agentDir, settings)).find((resource) => resource.path.endsWith(join("skills", "demo", "SKILL.md")))?.enabled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit project enable reopens a globally disabled package without changing global settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-policy-package-reopen-"));
  try {
    await mkdir(join(root, "skills", "demo"), { recursive: true });
    await writeFile(join(root, "skills", "demo", "SKILL.md"), "---\ndescription: demo\n---\n");
    const agentDir = join(root, "agent");
    const globalEntry = {
      source: root,
      autoload: false,
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    };
    const settings = SettingsManager.inMemory({ packages: [globalEntry] }, { projectTrusted: true });
    setProjectPackageOverride(settings, root, "enabled");
    const globalOnly = SettingsManager.inMemory(settings.getGlobalSettings(), { projectTrusted: true });

    assert.equal((await resolveSkills(root, agentDir, globalOnly)).find((resource) => resource.path.endsWith(join("skills", "demo", "SKILL.md")))?.enabled ?? false, false);
    assert.equal((await resolveSkills(root, agentDir, settings)).find((resource) => resource.path.endsWith(join("skills", "demo", "SKILL.md")))?.enabled, true);
    assert.deepEqual(settings.getGlobalSettings().packages, [globalEntry]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parent state remains enabled while preserving a child project override", () => {
  const settings = SettingsManager.inMemory({ packages: ["npm:tool@1.0.0"] }, { projectTrusted: true });
  setProjectPackageOverride(settings, "npm:tool@1.0.0", "enabled");
  setProjectPackageResourceOverride(settings, "npm:tool@1.0.0", "skills", "skills/demo/SKILL.md", "disabled");

  assert.equal(getProjectPackageOverride(settings, "npm:tool@2.0.0"), "enabled");
  assert.equal(
    getProjectPackageResourceOverride(settings, "npm:tool@2.0.0", "skills", "skills/demo/SKILL.md"),
    "disabled",
  );

  clearProjectPackageOverride(settings, "npm:tool@2.0.0");
  assert.equal(getProjectPackageOverride(settings, "npm:tool@2.0.0"), "inherit");
  assert.equal(
    getProjectPackageResourceOverride(settings, "npm:tool@2.0.0", "skills", "skills/demo/SKILL.md"),
    "disabled",
  );
});

test("resolves every global parent and project skill state combination", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-policy-matrix-"));
  try {
    await mkdir(join(root, "skills", "demo"), { recursive: true });
    const skillPath = join(root, "skills", "demo", "SKILL.md");
    await writeFile(skillPath, "---\ndescription: demo\n---\n");
    const agentDir = join(root, "agent");
    const parentStates = [
      ["disabled", "inherit", "disabled"],
      ["disabled", "enabled", "enabled"],
      ["disabled", "disabled", "disabled"],
      ["enabled", "inherit", "enabled"],
      ["enabled", "enabled", "enabled"],
      ["enabled", "disabled", "disabled"],
    ];
    const skillStates = [
      ["enabled", "inherit", "enabled"],
      ["enabled", "enabled", "enabled"],
      ["enabled", "disabled", "disabled"],
      ["disabled", "inherit", "disabled"],
      ["disabled", "enabled", "enabled"],
      ["disabled", "disabled", "disabled"],
    ];

    for (const [globalParent, projectParent, effectiveParent] of parentStates) {
      for (const [globalSkill, projectSkill, baseSkill] of skillStates) {
        const base = {
          source: root,
          autoload: false,
          extensions: ["**"],
          skills: [globalSkill === "enabled" ? "**" : `-${"skills/demo/SKILL.md"}`],
          prompts: ["**"],
          themes: ["**"],
        };
        const globalEntry = globalParent === "disabled"
          ? setPackageEntryDisabled(base, true)
          : base;
        const projectEntry = projectParent === "inherit" && projectSkill === "inherit"
          ? undefined
          : {
              source: root,
              autoload: false,
              extensions: projectParent === "enabled" ? ["**"] : projectParent === "disabled" ? ["!**"] : [],
              skills: [
                ...(projectParent === "enabled" ? ["**"] : projectParent === "disabled" ? ["!**"] : []),
                ...(projectSkill === "enabled" ? ["+skills/demo/SKILL.md"] : projectSkill === "disabled" ? ["-skills/demo/SKILL.md"] : []),
              ],
              prompts: projectParent === "enabled" ? ["**"] : projectParent === "disabled" ? ["!**"] : [],
              themes: projectParent === "enabled" ? ["**"] : projectParent === "disabled" ? ["!**"] : [],
            };
        const settings = SettingsManager.inMemory({ packages: [globalEntry] }, { projectTrusted: true });
        if (projectEntry) settings.setProjectPackages([projectEntry]);
        if (projectParent !== "inherit") setProjectPackageOverride(settings, root, projectParent);
        const effectiveSettings = createProjectPluginSettingsManager(settings, { cwd: root, agentDir });
        const actual = (await resolveSkills(root, agentDir, effectiveSettings))
          .find((resource) => resource.path === skillPath)?.enabled ?? false;
        const expected = effectiveParent === "enabled" && baseSkill === "enabled";
        assert.equal(actual, expected, `${globalParent}/${projectParent}/${globalSkill}/${projectSkill}`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("matches package resource overrides by normalized package identity", () => {
  const settings = SettingsManager.inMemory({}, { projectTrusted: true });
  settings.setProjectPackages([{
    source: "npm:demo-skill@1.0.0",
    autoload: false,
    skills: ["-skills/demo/SKILL.md"],
  }]);

  assert.equal(
    getProjectPackageResourceOverride(settings, "npm:demo-skill@2.0.0", "skills", "skills/demo/SKILL.md"),
    "disabled",
  );
  clearProjectPackageResourceOverride(settings, "npm:demo-skill@2.0.0", "skills", "skills/demo/SKILL.md");
  // A project-only package is a real project declaration, not a delta over a
  // global package. Clearing its last child filter must keep the package
  // installed and restore autoload instead of deleting or disabling it.
  assert.deepEqual(settings.getProjectSettings().packages, ["npm:demo-skill@1.0.0"]);
});

test("project top-level policy can disable and restore a global skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-policy-top-level-"));
  try {
    const agentDir = join(root, "agent");
    const skillPath = join(agentDir, "skills", "global-demo", "SKILL.md");
    await mkdir(join(agentDir, "skills", "global-demo"), { recursive: true });
    await writeFile(skillPath, "---\ndescription: global demo\n---\n");
    const settings = SettingsManager.inMemory({ skills: [skillPath] }, { projectTrusted: true });

    assert.equal(getProjectTopLevelOverride(settings, root, "skills", skillPath), "inherit");
    assert.equal((await resolveSkills(root, agentDir, settings)).find((resource) => resource.path === skillPath)?.enabled, true);

    setProjectTopLevelOverride(settings, root, "skills", skillPath, "disabled");
    assert.equal(getProjectTopLevelOverride(settings, root, "skills", skillPath), "disabled");
    assert.equal((await resolveSkills(root, agentDir, settings)).find((resource) => resource.path === skillPath)?.enabled, false);

    clearProjectTopLevelOverride(settings, root, "skills", skillPath);
    assert.equal(getProjectTopLevelOverride(settings, root, "skills", skillPath), "inherit");
    assert.equal((await resolveSkills(root, agentDir, settings)).find((resource) => resource.path === skillPath)?.enabled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project top-level policy restores SDK-supported directory-configured global skills", async (t) => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  try {
    for (const form of ["absolute", "file-url", "relative", "relative-dot", "home", "absolute-trailing", "relative-trailing", "home-trailing"]) {
      const root = await mkdtemp(join(tmpdir(), `pi-reader-policy-top-level-directory-${form}-`));
      if (form === "file-url") t.diagnostic(`resource-policy fixture: ${root}`);
      try {
        const fakeHome = join(root, "home");
        const skillDir = form === "absolute" || form === "file-url"
          ? join(root, "skills", "hunt")
          : form === "relative" || form === "relative-dot" || form === "relative-trailing"
            ? join(root, ".pi", "skills", "hunt")
            : join(fakeHome, "skills", "hunt");
        const configuredDir = form === "absolute"
          ? skillDir
          : form === "file-url"
            ? pathToFileURL(skillDir).href
            : form === "relative"
              ? "skills/hunt"
              : form === "relative-dot"
                ? "./skills/hunt"
                : form === "home"
                  ? "~/skills/hunt"
                  : form === "absolute-trailing"
                    ? `${skillDir}/`
                    : form === "relative-trailing"
                      ? "skills/hunt/"
                      : "~/skills/hunt/";
        // SDK exact override matching expands only the non-trailing home
        // alias; path.join preserves ~/.../ as a trailing literal separator.
        const sdkSupportsDirectoryAlias = [
          "absolute",
          "file-url",
          "relative",
          "relative-dot",
          "home",
        ].includes(form);
        const skillPath = join(skillDir, "SKILL.md");
        const otherSkillPath = join(root, "skills", "other", "SKILL.md");
        await mkdir(skillDir, { recursive: true });
        await mkdir(join(root, "skills", "other"), { recursive: true });
        await writeFile(skillPath, "---\ndescription: hunt\n---\n");
        await writeFile(otherSkillPath, "---\ndescription: other\n---\n");
        const useFakeHome = form === "home" || form === "home-trailing";
        if (useFakeHome) process.env.HOME = fakeHome;
        else if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        if (process.platform === "win32") {
          if (useFakeHome) process.env.USERPROFILE = fakeHome;
          else if (originalUserProfile === undefined) delete process.env.USERPROFILE;
          else process.env.USERPROFILE = originalUserProfile;
        }

        const settings = SettingsManager.inMemory(
          { skills: [skillDir, otherSkillPath] },
          { projectTrusted: true },
        );
        const globalSnapshot = structuredClone(settings.getGlobalSettings());
        settings.setProjectSkillPaths([
          configuredDir,
          `-${configuredDir}`,
          otherSkillPath,
          `-${otherSkillPath}`,
        ]);

        assert.equal(
          (await resolveSkills(root, join(root, "agent"), settings))
            .find((resource) => resource.path === skillPath)?.enabled,
          !sdkSupportsDirectoryAlias,
          `SDK directory alias: ${form}`,
        );
        assert.equal(
          getProjectTopLevelOverride(settings, root, "skills", skillPath),
          sdkSupportsDirectoryAlias ? "disabled" : "inherit",
          `Reader directory alias: ${form}`,
        );
        assert.equal(getProjectTopLevelOverride(settings, root, "skills", otherSkillPath), "disabled");

        clearProjectTopLevelOverride(settings, root, "skills", skillPath);
        assert.equal(getProjectTopLevelOverride(settings, root, "skills", skillPath), "inherit");
        assert.deepEqual(
          settings.getProjectSettings().skills,
          sdkSupportsDirectoryAlias
            ? [otherSkillPath, `-${otherSkillPath}`]
            : [configuredDir, `-${configuredDir}`, otherSkillPath, `-${otherSkillPath}`],
        );
        assert.equal(
          (await resolveSkills(root, join(root, "agent"), settings))
            .find((resource) => resource.path === skillPath)?.enabled,
          true,
        );
        assert.equal(
          (await resolveSkills(root, join(root, "agent"), settings))
            .find((resource) => resource.path === otherSkillPath)?.enabled,
          false,
        );
        assert.deepEqual(settings.getGlobalSettings(), globalSnapshot);
        assert.equal(await readFile(skillPath, "utf8"), "---\ndescription: hunt\n---\n");

        clearProjectTopLevelOverride(settings, root, "skills", skillPath);
        assert.deepEqual(
          settings.getProjectSettings().skills,
          sdkSupportsDirectoryAlias
            ? [otherSkillPath, `-${otherSkillPath}`]
            : [configuredDir, `-${configuredDir}`, otherSkillPath, `-${otherSkillPath}`],
        );

        if (sdkSupportsDirectoryAlias) {
          setProjectTopLevelOverride(settings, root, "skills", skillPath, "enabled");
          assert.equal(getProjectTopLevelOverride(settings, root, "skills", skillPath), "enabled");
          assert.equal(settings.getProjectSettings().skills.some((entry) => entry === `-${configuredDir}`), false);
          assert.equal(
            (await resolveSkills(root, join(root, "agent"), settings))
              .find((resource) => resource.path === skillPath)?.enabled,
            true,
          );
        }

        const promptDir = join(root, "prompts", "legacy");
        const promptPath = join(promptDir, "SKILL.md");
        settings.setProjectPromptTemplatePaths([promptDir]);
        assert.equal(getProjectTopLevelOverride(settings, root, "prompts", promptPath), "inherit");
        clearProjectTopLevelOverride(settings, root, "prompts", promptPath);
        assert.deepEqual(settings.getProjectSettings().prompts, [promptDir]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  }
});

test("persists directory skill restore through settings flush", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-policy-top-level-persist-"));
  try {
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const skillDir = join(agentDir, "skills", "persisted");
    const skillPath = join(skillDir, "SKILL.md");
    await mkdir(cwd, { recursive: true });
    await mkdir(skillDir, { recursive: true });
    await writeFile(skillPath, "---\ndescription: persisted\n---\n");

    const settings = SettingsManager.create(cwd, agentDir);
    settings.setSkillPaths([skillDir]);
    settings.setProjectSkillPaths([skillDir, `-${skillDir}`]);
    await settings.flush();

    const before = SettingsManager.create(cwd, agentDir);
    assert.equal(getProjectTopLevelOverride(before, cwd, "skills", skillPath), "disabled");
    assert.equal(
      (await resolveSkills(cwd, agentDir, before)).find((resource) => resource.path === skillPath)?.enabled,
      false,
    );

    clearProjectTopLevelOverride(before, cwd, "skills", skillPath);
    await before.flush();

    const after = SettingsManager.create(cwd, agentDir);
    assert.deepEqual(after.getProjectSettings().skills, []);
    assert.equal(getProjectTopLevelOverride(after, cwd, "skills", skillPath), "inherit");
    assert.equal(
      (await resolveSkills(cwd, agentDir, after)).find((resource) => resource.path === skillPath)?.enabled,
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not canonicalize unsupported SDK skill literals or glob exclusions", async () => {
  const cases = [
    "skills/./hunt",
    "skills//hunt",
    "skills/hunt/.",
    "../.pi/skills/hunt",
    "!./skills/hunt",
  ];

  for (const configured of cases) {
    const root = await mkdtemp(join(tmpdir(), "pi-reader-policy-top-level-literal-"));
    try {
      const skillDir = join(root, ".pi", "skills", "hunt");
      const skillPath = join(skillDir, "SKILL.md");
      await mkdir(skillDir, { recursive: true });
      await writeFile(skillPath, "---\ndescription: hunt\n---\n");

      const settings = SettingsManager.inMemory(
        { skills: [skillDir] },
        { projectTrusted: true },
      );
      const entries = configured.startsWith("!")
        ? [configured]
        : [`+${configured}`, `-${configured}`];
      settings.setProjectSkillPaths(entries);

      assert.equal(
        getProjectTopLevelOverride(settings, root, "skills", skillPath),
        "inherit",
        `Reader must not canonicalize ${configured}`,
      );
      assert.equal(
        (await resolveSkills(root, join(root, "agent"), settings))
          .find((resource) => resource.path === skillPath)?.enabled,
        true,
        `SDK must leave ${configured} enabled`,
      );

      clearProjectTopLevelOverride(settings, root, "skills", skillPath);
      assert.deepEqual(
        settings.getProjectSettings().skills,
        entries,
        `clear must preserve literal ${configured}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("ambiguous legacy glob rules refuse edits without changing settings", () => {
  const root = join(tmpdir(), "reader-ambiguous-resource-glob");
  const target = join(root, "home", ".pi", "agent", "skills", "same", "SKILL.md");
  const shadow = join(root, "shadow", ".pi", "agent", "skills", "same", "SKILL.md");
  const unrelated = join(root, "unrelated", "safe", "SKILL.md");
  const legacy = "!**/.pi/agent/skills/same/SKILL.md";
  const settings = SettingsManager.inMemory({ skills: [legacy, "global-unchanged"] }, { projectTrusted: true });
  settings.setProjectSkillPaths([legacy, "project-unchanged"]);
  const globalBefore = structuredClone(settings.getGlobalSettings());
  const projectBefore = structuredClone(settings.getProjectSettings());
  for (const path of [target, shadow]) {
    for (const state of ["enabled", "disabled"]) {
      assert.throws(() => setProjectTopLevelOverride(settings, root, "skills", path, state), /ambiguous legacy resource glob/i);
      assert.throws(() => setGlobalTopLevelSkillOverride(settings, path, state), /ambiguous legacy resource glob/i);
    }
    assert.throws(() => clearProjectTopLevelOverride(settings, root, "skills", path), /ambiguous legacy resource glob/i);
    assert.throws(() => clearGlobalTopLevelSkillOverride(settings, path), /ambiguous legacy resource glob/i);
  }
  assert.deepEqual(settings.getGlobalSettings(), globalBefore);
  assert.deepEqual(settings.getProjectSettings(), projectBefore);

  const globalOnly = SettingsManager.inMemory({ skills: [legacy] }, { projectTrusted: true });
  const projectOnly = SettingsManager.inMemory({}, { projectTrusted: true });
  projectOnly.setProjectSkillPaths([legacy]);
  for (const isolated of [globalOnly, projectOnly]) {
    const beforeGlobal = structuredClone(isolated.getGlobalSettings());
    const beforeProject = structuredClone(isolated.getProjectSettings());
    for (const state of ["enabled", "disabled"]) {
      assert.throws(() => setProjectTopLevelOverride(isolated, root, "skills", shadow, state), /ambiguous legacy resource glob/i);
    }
    assert.throws(() => clearProjectTopLevelOverride(isolated, root, "skills", shadow), /ambiguous legacy resource glob/i);
    assert.deepEqual(isolated.getGlobalSettings(), beforeGlobal);
    assert.deepEqual(isolated.getProjectSettings(), beforeProject);
  }
  setProjectTopLevelOverride(settings, root, "skills", unrelated, "disabled");
  setGlobalTopLevelSkillOverride(settings, unrelated, "disabled");
  assert.ok(settings.getProjectSettings().skills.includes(legacy));
  assert.ok(settings.getGlobalSettings().skills.includes(legacy));

  const migration = SettingsManager.inMemory({}, { projectTrusted: true });
  migration.setProjectSkillPaths(["!**/relative/SKILL.md"]);
  migration.updateProjectSettings("piWebProjectSkillStates", (project) => {
    project.piWebProjectSkillStates = { "top-level:relative/SKILL.md": "disabled" };
  });
  const migrationBefore = structuredClone(migration.getProjectSettings());
  assert.throws(() => migrateLegacyProjectOverrides(migration), /ambiguous legacy resource glob/i);
  assert.throws(() => migrateProjectWebStateKeys(migration, root), /ambiguous legacy resource glob/i);
  assert.deepEqual(migration.getProjectSettings(), migrationBefore);
});

test("a missing SDK matcher refuses ambiguous edits without changing settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reader-legacy-matcher-missing-"));
  t.diagnostic(`resource-policy fixture: ${root}`);
  const previousCwd = process.cwd();
  try {
    assert.throws(() => findPackageJSON("@earendil-works/pi-coding-agent", join(root, "package.json")), { code: "ERR_MODULE_NOT_FOUND" });
    const fresh = createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true });
    const policy = await fresh.import("./project-resource-policy.ts");
    const settings = SettingsManager.inMemory({ skills: ["!**/safe/SKILL.md"] }, { projectTrusted: true });
    const before = structuredClone(settings.getGlobalSettings());
    process.chdir(root);
    assert.throws(() => policy.setGlobalTopLevelSkillOverride(settings, join(root, "safe", "SKILL.md"), "enabled"), /SDK matcher unavailable/i);
    assert.deepEqual(settings.getGlobalSettings(), before);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("ambiguous complex glob rules follow the SDK without blocking unrelated resources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reader-ambiguous-complex-glob-"));
  t.diagnostic(`resource-policy fixture: ${root}`);
  const agentDir = join(root, "agent");
  try {
    const cases = [
      ["!**/team[1]/skill/SKILL.md", "team1", "team2"],
      ["!**/team?/skill/SKILL.md", "team1", "team22"],
      ["!**/{team1,team3}/skill/SKILL.md", "team1", "team2"],
      ["!**/team+(1)/skill/SKILL.md", "team1", "team2"],
      ["!**/team[1]/skill", "team1", "team2"],
    ];
    for (const [index, [legacy, matching, other]] of cases.entries()) {
      const target = join(root, String(index), matching, "skill", "SKILL.md");
      const unrelated = join(root, String(index), other, "skill", "SKILL.md");
      for (const file of [target, unrelated]) {
        await mkdir(join(file, ".."), { recursive: true });
        await writeFile(file, "---\nname: fixture\ndescription: fixture\n---\n");
      }
      for (const scope of ["global", "project"]) {
        const settings = SettingsManager.inMemory({ skills: scope === "global" ? [target, unrelated, legacy] : [] }, { projectTrusted: true });
        if (scope === "project") settings.setProjectSkillPaths([target, unrelated, legacy]);
        const resources = await resolveSkills(root, agentDir, settings);
        assert.equal(resources.find((resource) => resource.path === target)?.enabled, false, `${scope}: ${legacy}`);
        assert.equal(resources.find((resource) => resource.path === unrelated)?.enabled, true, `${scope}: ${legacy}`);
        const globalBefore = structuredClone(settings.getGlobalSettings());
        const projectBefore = structuredClone(settings.getProjectSettings());
        for (const state of ["enabled", "disabled"]) {
          assert.throws(() => setProjectTopLevelOverride(settings, root, "skills", target, state), /ambiguous legacy resource glob/i);
          if (scope === "global") assert.throws(() => setGlobalTopLevelSkillOverride(settings, target, state), /ambiguous legacy resource glob/i);
        }
        assert.throws(() => clearProjectTopLevelOverride(settings, root, "skills", target), /ambiguous legacy resource glob/i);
        if (scope === "global") assert.throws(() => clearGlobalTopLevelSkillOverride(settings, target), /ambiguous legacy resource glob/i);
        assert.deepEqual(settings.getGlobalSettings(), globalBefore);
        assert.deepEqual(settings.getProjectSettings(), projectBefore);
        if (scope === "global") {
          setGlobalTopLevelSkillOverride(settings, unrelated, "disabled");
          assert.ok(settings.getGlobalSettings().skills.includes(legacy));
        } else {
          setProjectTopLevelOverride(settings, root, "skills", unrelated, "disabled");
          assert.ok(settings.getProjectSettings().skills.includes(legacy));
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy globs use the real SDK base when matching parent-relative paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reader-legacy-glob-base-"));
  t.diagnostic(`resource-policy fixture: ${root}`);
  const agentDir = join(root, "agent"), cwd = join(root, "project");
  const target = join(root, "team1", "skill", "SKILL.md");
  const unrelated = join(root, "team2", "skill", "SKILL.md");
  const settingsPath = join(agentDir, "settings.json");
  try {
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    for (const file of [target, unrelated]) {
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, "---\nname: fixture\ndescription: fixture\n---\n");
    }
    for (const legacy of ["!**/../team[1]/skill/SKILL.md", "!../team[1]/skill/SKILL.md"]) {
      const original = JSON.stringify({ skills: [target, unrelated, legacy] });
      await writeFile(settingsPath, original);
      const unknownBase = SettingsManager.inMemory({ skills: [legacy] }, { projectTrusted: true });
      const unknownBefore = structuredClone(unknownBase.getGlobalSettings());
      assert.throws(() => setGlobalTopLevelSkillOverride(unknownBase, target, "enabled"), /without a rule root/i);
      assert.throws(() => setProjectTopLevelOverride(unknownBase, cwd, "skills", target, "enabled"), /without a rule root/i);
      assert.deepEqual(unknownBase.getGlobalSettings(), unknownBefore);
      assert.deepEqual(unknownBase.getProjectSettings(), {});
      const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
      const resources = await resolveSkills(cwd, agentDir, settings);
      assert.equal(resources.find((resource) => resource.path === target)?.enabled, false, legacy);
      assert.equal(resources.find((resource) => resource.path === unrelated)?.enabled, true, legacy);
      assert.throws(() => setGlobalTopLevelSkillOverride(settings, target, "enabled"), /ambiguous legacy resource glob/i);
      assert.throws(() => clearGlobalTopLevelSkillOverride(settings, target), /ambiguous legacy resource glob/i);
      assert.throws(() => setProjectTopLevelOverride(settings, cwd, "skills", target, "enabled"), /ambiguous legacy resource glob/i);
      assert.throws(() => clearProjectTopLevelOverride(settings, cwd, "skills", target), /ambiguous legacy resource glob/i);
      await settings.flush();
      assert.equal(await readFile(settingsPath, "utf8"), original);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy home-relative glob normalization follows the SDK", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reader-legacy-glob-home-"));
  t.diagnostic(`resource-policy fixture: ${root}`);
  const previousHome = process.env.HOME, previousUserProfile = process.env.USERPROFILE;
  const agentDir = join(root, "agent"), cwd = join(root, "project");
  const target = join(root, "skills", "team1", "SKILL.md"), unrelated = join(root, "skills", "team2", "SKILL.md");
  const settingsPath = join(agentDir, "settings.json"), legacy = "!~/skills/team[1]/SKILL.md";
  try {
    process.env.HOME = root;
    if (process.platform === "win32") process.env.USERPROFILE = root;
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    for (const file of [target, unrelated]) {
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, "---\nname: fixture\ndescription: fixture\n---\n");
    }
    const original = JSON.stringify({ skills: [target, unrelated, legacy] });
    await writeFile(settingsPath, original);
    const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const resources = await resolveSkills(cwd, agentDir, settings);
    assert.equal(resources.find((resource) => resource.path === target)?.enabled, false);
    assert.equal(resources.find((resource) => resource.path === unrelated)?.enabled, true);
    assert.throws(() => setGlobalTopLevelSkillOverride(settings, target, "enabled"), /ambiguous legacy resource glob/i);
    setGlobalTopLevelSkillOverride(settings, unrelated, "disabled");
    await settings.flush();
    assert.ok(settings.getGlobalSettings().skills.includes(legacy));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    await rm(root, { recursive: true, force: true });
  }
});

test("a disabled top-level skill rule only disables the exact skill path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-policy-top-level-collision-"));
  t.diagnostic(`resource-policy fixture: ${root}`);
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  try {
    const fakeHome = join(root, "home");
    process.env.HOME = fakeHome;
    if (process.platform === "win32") process.env.USERPROFILE = fakeHome;
    const cwd = join(root, "project");
    const agentDir = join(fakeHome, ".pi", "agent");
    const globalSkill = join(agentDir, "skills", "same", "SKILL.md");
    const projectSkill = join(cwd, ".pi", "skills", "same", "SKILL.md");
    const shadowSkill = join(root, "shadow", ".pi", "agent", "skills", "same", "SKILL.md");
    for (const skillPath of [globalSkill, projectSkill, shadowSkill]) {
      await mkdir(join(skillPath, ".."), { recursive: true });
      await writeFile(skillPath, "---\nname: same\ndescription: same\n---\n");
    }
    const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    settings.setSkillPaths([globalSkill, shadowSkill]);
    const portableTarget = "~/.pi/agent/skills/same/SKILL.md";
    settings.setProjectSkillPaths([portableTarget, `!${portableTarget}`]);
    const exact = await resolveSkills(cwd, agentDir, settings);
    assert.equal(exact.find((resource) => resource.path === globalSkill)?.enabled, false);
    assert.equal(exact.find((resource) => resource.path === shadowSkill)?.enabled, true);
    settings.setProjectSkillPaths([]);

    setProjectTopLevelOverride(settings, cwd, "skills", globalSkill, "disabled");
    await settings.flush();

    const rule = (settings.getProjectSettings().skills ?? []).find((entry) => entry.startsWith("!"));
    assert.equal(rule, "!~/.pi/agent/skills/same/SKILL.md", "rule names only the exact portable skill");

    const resolved = await resolveSkills(cwd, agentDir, settings);
    const global = resolved.find((resource) => resource.path === globalSkill);
    const project = resolved.find((resource) => resource.path === projectSkill);
    assert.equal(global?.enabled, false, "target skill is disabled");
    assert.notEqual(project?.enabled, false, "same-named skill from another root stays enabled");
    assert.equal(resolved.find((resource) => resource.path === shadowSkill)?.enabled, true, "matching suffix outside home stays enabled");

    // Reader must read the rule back the same way the SDK applies it, so the
    // project skill is not reported as disabled in the panel.
    assert.equal(getProjectTopLevelOverride(settings, cwd, "skills", globalSkill), "disabled");
    assert.equal(getProjectTopLevelOverride(settings, cwd, "skills", projectSkill), "inherit");
    assert.equal(getProjectTopLevelOverride(settings, cwd, "skills", shadowSkill), "inherit");

    const movedHome = join(root, "moved-home");
    const movedSkill = join(movedHome, ".pi", "agent", "skills", "same", "SKILL.md");
    await mkdir(join(movedSkill, ".."), { recursive: true });
    await writeFile(movedSkill, "---\nname: same\ndescription: same\n---\n");
    process.env.HOME = movedHome;
    if (process.platform === "win32") process.env.USERPROFILE = movedHome;
    const movedSettings = SettingsManager.inMemory({ skills: [movedSkill, shadowSkill] }, { projectTrusted: true });
    movedSettings.setProjectSkillPaths(settings.getProjectSettings().skills);
    const moved = await resolveSkills(cwd, join(movedHome, ".pi", "agent"), movedSettings);
    assert.equal(moved.find((resource) => resource.path === movedSkill)?.enabled, false, "the exact rule follows home across devices");
    assert.equal(moved.find((resource) => resource.path === shadowSkill)?.enabled, true, "the exact rule still excludes only one root");
    process.env.HOME = fakeHome;
    if (process.platform === "win32") process.env.USERPROFILE = fakeHome;

    clearProjectTopLevelOverride(settings, cwd, "skills", globalSkill);
    assert.equal(getProjectTopLevelOverride(settings, cwd, "skills", globalSkill), "inherit");
    assert.equal(
      (await resolveSkills(cwd, agentDir, settings)).find((resource) => resource.path === globalSkill)?.enabled,
      true,
    );
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    await rm(root, { recursive: true, force: true });
  }
});

test("a path with glob metacharacters disables only the intended skill", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-policy-literal-glob-"));
  t.diagnostic(`resource-policy fixture: ${root}`);
  try {
    const agentDir = join(root, "agent");
    const cases = [["team[1]", "team1", "team[[]1[]]"], ["team{a,b}", "teama", "team[{]a,b[}]"], ["team+(a)", "teama", "team+[(]a[)]"]];
    if (process.platform !== "win32") cases.push(["team**", "teamAB", "team[*][*]"], ["team?", "teamX", "team[?]"], ["team\\x", "teamx", "team-backslash"]);
    for (const [index, [literal, similar, encoded]] of cases.entries()) {
      const discoveryRoot = join(root, String(index));
      const target = join(discoveryRoot, literal, "skill", "SKILL.md");
      const other = join(discoveryRoot, similar, "skill", "SKILL.md");
      const lookalike = join(discoveryRoot, encoded, "skill", "SKILL.md");
      const unrelated = join(discoveryRoot, "unrelated", "skill", "SKILL.md");
      const isWildcard = /[*?]/.test(literal);
      // Pi interprets unsigned * and ? paths as globs; discover them through a literal parent.
      const sources = isWildcard ? [discoveryRoot] : [target, other, lookalike, unrelated];
      for (const skill of [target, other, lookalike, unrelated]) {
        await mkdir(join(skill, ".."), { recursive: true });
        await writeFile(skill, "---\nname: same\ndescription: same\n---\n");
      }
      const settings = SettingsManager.inMemory({ skills: sources }, { projectTrusted: true });
      const existingGlob = `!**/${String(index)}/${literal}/skill/SKILL.md`;
      const absoluteGlob = `!${target.split(sep).join("/")}`;
      const probe = SettingsManager.inMemory({}, { projectTrusted: true });
      probe.setProjectSkillPaths([...sources, existingGlob]);
      const sdkTarget = (await resolveSkills(root, agentDir, probe)).find((resource) => resource.path === target);
      assert.ok(sdkTarget, literal);
      settings.setProjectSkillPaths([existingGlob, absoluteGlob]);
      assert.equal(getProjectTopLevelOverride(settings, root, "skills", target), "inherit", literal);
      if (sdkTarget.enabled) clearProjectTopLevelOverride(settings, root, "skills", target);
      else assert.throws(() => clearProjectTopLevelOverride(settings, root, "skills", target), /ambiguous legacy resource glob/i);
      assert.deepEqual(settings.getProjectSettings().skills, [existingGlob, absoluteGlob], literal);
      settings.setProjectSkillPaths([]);
      if (isWildcard) {
        // An unsigned wildcard is an SDK glob, not an exact entry to delete.
        settings.setProjectSkillPaths([target, `-${target}`]);
        clearProjectTopLevelOverride(settings, root, "skills", target);
        assert.deepEqual(settings.getProjectSettings().skills, [target], literal);
        setProjectTopLevelOverride(settings, root, "skills", target, "disabled");
        assert.equal(settings.getProjectSettings().skills.includes(target), true, literal);
        clearProjectTopLevelOverride(settings, root, "skills", target);
        assert.deepEqual(settings.getProjectSettings().skills, [target], literal);
        settings.setProjectSkillPaths([]);

        const existingGlobal = SettingsManager.inMemory({ skills: [discoveryRoot, target] }, { projectTrusted: true });
        setGlobalTopLevelSkillOverride(existingGlobal, target, "disabled");
        assert.equal(existingGlobal.getGlobalSettings().skills.includes(target), true, literal);
        setGlobalTopLevelSkillOverride(existingGlobal, target, "enabled");
        assert.equal(existingGlobal.getGlobalSettings().skills.includes(target), true, literal);
      }
      setProjectTopLevelOverride(settings, root, "skills", target, "disabled");
      assert.equal(getProjectTopLevelOverride(settings, root, "skills", target), "disabled", literal);
      assert.equal(getProjectTopLevelOverride(settings, root, "skills", lookalike), "inherit", encoded);
      const resources = await resolveSkills(root, agentDir, settings);
      assert.deepEqual({
        target: resources.find((resource) => resource.path === target)?.enabled,
        other: resources.find((resource) => resource.path === other)?.enabled,
        lookalike: resources.find((resource) => resource.path === lookalike)?.enabled,
        unrelated: resources.find((resource) => resource.path === unrelated)?.enabled,
      }, { target: false, other: true, lookalike: true, unrelated: true }, literal);
      clearProjectTopLevelOverride(settings, root, "skills", target);
      assert.equal(getProjectTopLevelOverride(settings, root, "skills", target), "inherit", literal);
      const restored = await resolveSkills(root, agentDir, settings);
      assert.equal(restored.find((resource) => resource.path === target)?.enabled, true, literal);

      const globalSettings = SettingsManager.inMemory({ skills: sources }, { projectTrusted: true });
      setGlobalTopLevelSkillOverride(globalSettings, target, "disabled");
      assert.equal(getGlobalTopLevelSkillOverride(globalSettings, target), "disabled", literal);
      assert.equal(getGlobalTopLevelSkillOverride(globalSettings, lookalike), isWildcard ? "inherit" : "enabled", encoded);
      const globalResources = await resolveSkills(root, agentDir, globalSettings);
      assert.deepEqual({
        target: globalResources.find((resource) => resource.path === target)?.enabled,
        other: globalResources.find((resource) => resource.path === other)?.enabled,
        lookalike: globalResources.find((resource) => resource.path === lookalike)?.enabled,
        unrelated: globalResources.find((resource) => resource.path === unrelated)?.enabled,
      }, { target: false, other: true, lookalike: true, unrelated: true }, literal);
      setGlobalTopLevelSkillOverride(globalSettings, target, "enabled");
      assert.equal(getGlobalTopLevelSkillOverride(globalSettings, target), "enabled", literal);
      const globalRestored = await resolveSkills(root, agentDir, globalSettings);
      assert.equal(globalRestored.find((resource) => resource.path === target)?.enabled, true, literal);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("literal file URLs support exact project and global Skill overrides", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-policy-file-url-"));
  t.diagnostic(`resource-policy fixture: ${root}`);
  try {
    const agentDir = join(root, "agent");
    const name = process.platform === "win32" ? "literal[]#%" : "literal*?[]#%";
    const target = join(root, name, "skill", "SKILL.md");
    const other = join(root, "other", "skill", "SKILL.md");
    for (const skill of [target, other]) {
      await mkdir(join(skill, ".."), { recursive: true });
      await writeFile(skill, "---\nname: same\ndescription: same\n---\n");
    }
    const encoded = pathToFileURL(target).href.replaceAll("*", "%2A");
    assert.equal(fileURLToPath(encoded), target);
    assert.equal(/[*?]/.test(encoded), false);
    const settings = SettingsManager.inMemory({ skills: [encoded, other] }, { projectTrusted: true });
    const globProbe = SettingsManager.inMemory({}, { projectTrusted: true });
    globProbe.setProjectSkillPaths([encoded, other, `!${encoded}`]);
    const sdkGlob = await resolveSkills(root, agentDir, globProbe);
    assert.equal(sdkGlob.find((resource) => resource.path === target)?.enabled, false);
    assert.equal(sdkGlob.find((resource) => resource.path === other)?.enabled, true);
    settings.setProjectSkillPaths([`!${encoded}`]);
    assert.equal(getProjectTopLevelOverride(settings, root, "skills", target), "inherit");
    assert.throws(() => clearProjectTopLevelOverride(settings, root, "skills", target), /ambiguous legacy resource glob/i);
    assert.deepEqual(settings.getProjectSettings().skills, [`!${encoded}`]);

    // Establish the SDK's behavior independently of Reader's rule writer.
    settings.setProjectSkillPaths([encoded, `-${encoded}`]);
    const sdkResolved = await resolveSkills(root, agentDir, settings);
    assert.equal(sdkResolved.find((resource) => resource.path === target)?.enabled, false);
    assert.equal(sdkResolved.find((resource) => resource.path === other)?.enabled, true);
    assert.equal(getProjectTopLevelOverride(settings, root, "skills", target), "disabled");

    settings.setProjectSkillPaths([]);
    setProjectTopLevelOverride(settings, root, "skills", target, "disabled");
    assert.equal(getProjectTopLevelOverride(settings, root, "skills", target), "disabled");
    const project = await resolveSkills(root, agentDir, settings);
    assert.equal(project.find((resource) => resource.path === target)?.enabled, false);
    assert.equal(project.find((resource) => resource.path === other)?.enabled, true);
    clearProjectTopLevelOverride(settings, root, "skills", target);
    assert.equal((await resolveSkills(root, agentDir, settings)).find((resource) => resource.path === target)?.enabled, true);

    setGlobalTopLevelSkillOverride(settings, target, "disabled");
    assert.equal(getGlobalTopLevelSkillOverride(settings, target), "disabled");
    const global = await resolveSkills(root, agentDir, settings);
    assert.equal(global.find((resource) => resource.path === target)?.enabled, false);
    assert.equal(global.find((resource) => resource.path === other)?.enabled, true);
    setGlobalTopLevelSkillOverride(settings, target, "enabled");
    assert.equal((await resolveSkills(root, agentDir, settings)).find((resource) => resource.path === target)?.enabled, true);

    setProjectTopLevelOverride(settings, root, "skills", encoded, "disabled");
    assert.equal(getProjectTopLevelOverride(settings, root, "skills", target), "disabled");
    assert.equal((await resolveSkills(root, agentDir, settings)).find((resource) => resource.path === target)?.enabled, false);
    clearProjectTopLevelOverride(settings, root, "skills", encoded);
    setGlobalTopLevelSkillOverride(settings, encoded, "disabled");
    assert.equal(getGlobalTopLevelSkillOverride(settings, target), "disabled");
    assert.equal((await resolveSkills(root, agentDir, settings)).find((resource) => resource.path === target)?.enabled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project resource overrides preserve SDK behavior outside Skills", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-policy-other-resources-"));
  t.diagnostic(`resource-policy fixture: ${root}`);
  try {
    const agentDir = join(root, "agent");
    const cases = [["extensions", "js"], ["prompts", "md"], ["themes", "json"]];
    for (const [type, extension] of cases) {
      for (const name of process.platform === "win32" ? ["normal", "bracket[1]"] : ["normal", "bracket[1]", "literal*?"]) {
        const dir = join(root, type, name === "normal" ? "ordinary" : "special");
        const target = join(dir, `${name}.${extension}`);
        const other = join(dir, `other.${extension}`);
        await mkdir(dir, { recursive: true });
        await writeFile(target, type === "themes" ? "{}" : "fixture");
        await writeFile(other, type === "themes" ? "{}" : "fixture");
        const settings = SettingsManager.inMemory({ [type]: [dir] }, { projectTrusted: true });
        const resolveResources = async () => (await new DefaultPackageManager({ cwd: root, agentDir, settingsManager: settings }).resolve(async () => "skip"))[type];
        setProjectTopLevelOverride(settings, root, type, target, "disabled");
        assert.equal(getProjectTopLevelOverride(settings, root, type, target), "disabled", `${type}/${name}`);
        let resources = await resolveResources();
        assert.equal(resources.find((resource) => resource.path === target)?.enabled, false, `${type}/${name}`);
        assert.equal(resources.find((resource) => resource.path === other)?.enabled, true, `${type}/${name}`);
        setProjectTopLevelOverride(settings, root, type, target, "enabled");
        assert.equal(getProjectTopLevelOverride(settings, root, type, target), "enabled", `${type}/${name}`);
        resources = await resolveResources();
        assert.equal(resources.find((resource) => resource.path === target)?.enabled, true, `${type}/${name}`);
        clearProjectTopLevelOverride(settings, root, type, target);
        assert.equal(getProjectTopLevelOverride(settings, root, type, target), "inherit", `${type}/${name}`);
        assert.equal((await resolveResources()).find((resource) => resource.path === target)?.enabled, true, `${type}/${name}`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed file URLs remain untouched when another resource is changed", () => {
  const root = join(tmpdir(), "pi-reader-invalid-file-url");
  const target = join(root, "resource", "SKILL.md");
  const invalid = "file:///%ZZ";
  const settings = SettingsManager.inMemory({ skills: [invalid] }, { projectTrusted: true });
  settings.setProjectSkillPaths([invalid]);
  setProjectTopLevelOverride(settings, root, "skills", target, "disabled");
  assert.equal(settings.getProjectSettings().skills.includes(invalid), true);
  clearProjectTopLevelOverride(settings, root, "skills", target);
  assert.deepEqual(settings.getProjectSettings().skills, [invalid]);
  setGlobalTopLevelSkillOverride(settings, target, "disabled");
  assert.equal(settings.getGlobalSettings().skills.includes(invalid), true);
});

test("invalid target paths fail explicitly without modifying settings", () => {
  const root = join(tmpdir(), "pi-reader-invalid-resource-path");
  const settings = SettingsManager.inMemory({ skills: ["other"] }, { projectTrusted: true });
  const globalBefore = structuredClone(settings.getGlobalSettings());
  const projectBefore = structuredClone(settings.getProjectSettings());
  for (const target of ["file:///%ZZ", "file:///invalid%00/SKILL.md", "/fixture/invalid\0/SKILL.md"]) {
    for (const state of ["enabled", "disabled"]) {
      assert.throws(() => setProjectTopLevelOverride(settings, root, "skills", target, state), /cannot safely override/i);
      assert.throws(() => setGlobalTopLevelSkillOverride(settings, target, state), /cannot safely override/i);
    }
  }
  assert.deepEqual(settings.getGlobalSettings(), globalBefore);
  assert.deepEqual(settings.getProjectSettings(), projectBefore);
});

test("Windows file URL conversion does not preserve a device namespace", () => {
  for (const [ordinary, namespaced] of [
    ["C:\\fixture\\SKILL.md", "\\\\?\\C:\\fixture\\SKILL.md"],
    ["\\\\server\\share\\SKILL.md", "\\\\?\\UNC\\server\\share\\SKILL.md"],
  ]) {
    const ordinaryURL = pathToFileURL(ordinary, { windows: true });
    const namespacedURL = pathToFileURL(namespaced, { windows: true });
    assert.equal(fileURLToPath(ordinaryURL, { windows: true }), ordinary);
    assert.notEqual(fileURLToPath(namespacedURL, { windows: true }), namespaced);
  }
});

test("file URL authorities cannot hide Windows device namespaces", () => {
  const root = join(tmpdir(), "pi-reader-file-url-authority");
  const settings = SettingsManager.inMemory({ skills: ["other"] }, { projectTrusted: true });
  settings.setProjectSkillPaths(["project-other"]);
  const globalBefore = structuredClone(settings.getGlobalSettings());
  const projectBefore = structuredClone(settings.getProjectSettings());
  for (const target of ["file://./C:/fixture/SKILL.md", "file://./UNC/server/share/SKILL.md"]) {
    assert.match(fileURLToPath(target, { windows: true }), /^\\\\\.\\/);
    for (const state of ["enabled", "disabled"]) {
      assert.throws(() => setProjectTopLevelOverride(settings, root, "skills", target, state), /cannot safely override/i);
      assert.throws(() => setGlobalTopLevelSkillOverride(settings, target, state), /cannot safely override/i);
    }
  }
  assert.deepEqual(settings.getGlobalSettings(), globalBefore);
  assert.deepEqual(settings.getProjectSettings(), projectBefore);

  const networkShare = "file://server/share/SKILL.md";
  if (process.platform === "win32") {
    setProjectTopLevelOverride(settings, root, "skills", networkShare, "disabled");
    const decodedShare = fileURLToPath(networkShare);
    assert.deepEqual(settings.getProjectSettings().skills, ["project-other", decodedShare, `!${decodedShare}`]);
    assert.equal(getProjectTopLevelOverride(settings, root, "skills", networkShare), "disabled");
    clearProjectTopLevelOverride(settings, root, "skills", networkShare);
    assert.deepEqual(settings.getProjectSettings(), projectBefore);
  } else {
    assert.throws(() => setProjectTopLevelOverride(settings, root, "skills", networkShare, "disabled"), /cannot safely override/i);
    assert.deepEqual(settings.getProjectSettings(), projectBefore);
  }
});

test("question-mark path components respect the current platform", () => {
  const root = join(tmpdir(), "pi-reader-question-component");
  const settings = SettingsManager.inMemory({}, { projectTrusted: true });
  if (process.platform === "win32") {
    assert.throws(() => setProjectTopLevelOverride(settings, root, "skills", "//?/C:/literal/SKILL.md", "disabled"), /namespace/i);
    assert.equal(settings.getProjectSettings().skills, undefined);
  } else {
    const target = "//?/literal/SKILL.md";
    setProjectTopLevelOverride(settings, root, "skills", target, "disabled");
    assert.deepEqual(settings.getProjectSettings().skills, ["file:///%3F/literal/SKILL.md", "-file:///%3F/literal/SKILL.md"]);
    assert.equal(getProjectTopLevelOverride(settings, root, "skills", target), "disabled");
    clearProjectTopLevelOverride(settings, root, "skills", target);
    assert.deepEqual(settings.getProjectSettings().skills, []);
  }
});

test("unrepresentable Windows device paths fail explicitly without changing settings", () => {
  const root = join(tmpdir(), "pi-reader-device-path");
  const target = "\\\\?\\C:\\fixture\\SKILL.md";
  const settings = SettingsManager.inMemory({ skills: ["other"] }, { projectTrusted: true });
  const globalBefore = structuredClone(settings.getGlobalSettings());
  const projectBefore = structuredClone(settings.getProjectSettings());
  for (const state of ["enabled", "disabled"]) {
    assert.throws(() => setProjectTopLevelOverride(settings, root, "skills", target, state), /cannot safely override.*(?:device|namespace|extended)/i);
    assert.throws(() => setGlobalTopLevelSkillOverride(settings, target, state), /cannot safely override.*(?:device|namespace|extended)/i);
  }
  assert.deepEqual(settings.getGlobalSettings(), globalBefore);
  assert.deepEqual(settings.getProjectSettings(), projectBefore);
});

test("exact glob-like overrides remain portable under the home directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-policy-literal-home-"));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = root;
    if (process.platform === "win32") process.env.USERPROFILE = root;
    const agentDir = join(root, "agent");
    const target = join(root, "team[1]", "skill", "SKILL.md");
    const other = join(root, "team1", "skill", "SKILL.md");
    for (const skill of [target, other]) {
      await mkdir(join(skill, ".."), { recursive: true });
      await writeFile(skill, "---\nname: same\ndescription: same\n---\n");
    }
    const settings = SettingsManager.inMemory({ skills: [target, other] }, { projectTrusted: true });
    setProjectTopLevelOverride(settings, root, "skills", target, "disabled");
    assert.equal(settings.getProjectSettings().skills.includes("-~/team[1]/skill/SKILL.md"), true);
    const projectResources = await resolveSkills(root, agentDir, settings);
    assert.equal(projectResources.find((resource) => resource.path === target)?.enabled, false);
    assert.equal(projectResources.find((resource) => resource.path === other)?.enabled, true);
    clearProjectTopLevelOverride(settings, root, "skills", target);
    assert.equal((await resolveSkills(root, agentDir, settings)).find((resource) => resource.path === target)?.enabled, true);

    setGlobalTopLevelSkillOverride(settings, target, "disabled");
    assert.equal(settings.getGlobalSettings().skills.includes("-~/team[1]/skill/SKILL.md"), true);
    const globalResources = await resolveSkills(root, agentDir, settings);
    assert.equal(globalResources.find((resource) => resource.path === target)?.enabled, false);
    assert.equal(globalResources.find((resource) => resource.path === other)?.enabled, true);
    setGlobalTopLevelSkillOverride(settings, target, "enabled");
    assert.equal((await resolveSkills(root, agentDir, settings)).find((resource) => resource.path === target)?.enabled, true);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    await rm(root, { recursive: true, force: true });
  }
});

test("home paths with native backslashes follow SDK matching on Windows", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reader-skill-native-home-"));
  t.diagnostic(`resource-policy fixture: ${root}`);
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = root;
    if (process.platform === "win32") process.env.USERPROFILE = root;
    const target = join(root, "MiXeD", "SKILL.md");
    await mkdir(join(root, "MiXeD"), { recursive: true });
    await writeFile(target, "---\nname: mixed\ndescription: fixture\n---\n");
    const rule = "!~\\MiXeD\\SKILL.md";
    const settings = SettingsManager.inMemory({ skills: [target, rule] }, { projectTrusted: true });
    settings.setProjectSkillPaths([target, rule]);
    const expected = process.platform === "win32" ? "disabled" : "enabled";
    assert.equal(getGlobalTopLevelSkillOverride(settings, target), expected);
    assert.equal(getProjectTopLevelOverride(settings, root, "skills", target), expected);
    const sdk = await resolveSkills(root, join(root, "agent"), settings);
    assert.equal(sdk.find((resource) => resource.path === target)?.enabled, process.platform !== "win32");
    clearProjectTopLevelOverride(settings, root, "skills", target);
    assert.deepEqual(settings.getProjectSettings().skills, process.platform === "win32" ? [] : [rule]);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    await rm(root, { recursive: true, force: true });
  }
});

test("foreign legacy skill paths refuse both migration stages without changing disk", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reader-foreign-skill-state-"));
  t.diagnostic(`resource-policy fixture: ${root}`);
  try {
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const settingsPath = join(cwd, ".pi", "settings.json");
    const paths = process.platform === "win32"
      ? ["/home/example/Skill/SKILL.md"]
      : ["C:\\Users\\Example\\Skill\\SKILL.md", "C:/Users/Example/Skill/SKILL.md", "\\\\server\\share\\Skill\\SKILL.md", "file:///C:/Users/Example/Skill/SKILL.md"];
    for (const path of paths) {
      for (const kind of ["top-level", "package", "legacy-package"]) {
        const project = {
          untouched: true,
          piWebProjectSkillStates: { [`top-level:${join(root, "safe", "SKILL.md")}`]: "disabled" },
          piWebPluginSkillOverrides: { "npm:fixture": { "skills/demo/SKILL.md": "disabled" } },
        };
        if (kind === "top-level") project.piWebProjectSkillStates[`top-level:${path}`] = "disabled";
        if (kind === "package") project.piWebProjectSkillStates[`package:local:${path}:skills/demo/SKILL.md`] = "disabled";
        if (kind === "legacy-package") project.piWebPluginSkillOverrides[path] = { "skills/demo/SKILL.md": "disabled" };
        const before = JSON.stringify(project);
        await writeFile(settingsPath, before);
        const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
        assert.throws(() => migrateLegacyProjectOverrides(settings, cwd), /another platform/);
        assert.throws(() => migrateProjectWebStateKeys(settings, cwd), /another platform/);
        await settings.flush();
        assert.equal(await readFile(settingsPath, "utf8"), before);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported legacy resource paths stop migration before any setting changes", () => {
  const root = process.cwd();
  const safe = join(root, "safe", "SKILL.md");
  const unsupported = "\\\\?\\C:\\fixture\\SKILL.md";
  const project = {
    piWebProjectSkillStates: { [`top-level:${safe}`]: "disabled", [`top-level:${unsupported}`]: "disabled" },
    skills: [],
  };
  const before = structuredClone(project);
  const manager = {
    getGlobalSettings: () => ({}),
    getProjectSettings: () => structuredClone(project),
    setProjectSkillPaths: (value) => { project.skills = value; },
  };
  assert.throws(() => migrateProjectWebStateKeys(manager, root), /cannot safely override/);
  assert.deepEqual(project, before);
});

test("a disabled parent caps a force-included child in the reported state", () => {
  const settings = SettingsManager.inMemory({ packages: ["npm:tool@1.0.0"] }, { projectTrusted: true });
  setProjectPackageOverride(settings, "npm:tool@1.0.0", "disabled");
  setProjectPackageResourceOverride(settings, "npm:tool@1.0.0", "skills", "skills/demo/SKILL.md", "enabled");

  // The child filter stays configured, but the parent disable owns the result.
  const entry = (settings.getProjectSettings().packages ?? [])[0];
  assert.equal(entry.skills.includes("+skills/demo/SKILL.md"), true, "child filter is preserved");
  assert.equal(
    getProjectPackageResourceOverride(settings, "npm:tool@1.0.0", "skills", "skills/demo/SKILL.md"),
    "disabled",
    "parent disable caps the child instead of reporting a child override",
  );

  // Clearing the parent restores the preserved child filter.
  clearProjectPackageOverride(settings, "npm:tool@1.0.0");
  assert.equal(
    getProjectPackageResourceOverride(settings, "npm:tool@1.0.0", "skills", "skills/demo/SKILL.md"),
    "enabled",
  );
});

test("clearing a project-only child filter keeps the package installed and autoloading", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-policy-project-only-clear-"));
  try {
    await mkdir(join(root, "skills", "demo"), { recursive: true });
    await writeFile(join(root, "skills", "demo", "SKILL.md"), "---\ndescription: demo\n---\n");
    const agentDir = join(root, "agent");
    const settings = SettingsManager.create(root, agentDir, { projectTrusted: true });
    settings.setProjectPackages([root]);
    await settings.flush();

    setProjectPackageResourceOverride(settings, root, "skills", "skills/demo/SKILL.md", "disabled");
    await settings.flush();
    assert.equal(
      (await resolveSkills(root, agentDir, settings)).find((resource) => resource.path.endsWith(join("skills", "demo", "SKILL.md")))?.enabled,
      false,
    );

    clearProjectPackageResourceOverride(settings, root, "skills", "skills/demo/SKILL.md");
    await settings.flush();

    const packages = settings.getProjectSettings().packages ?? [];
    assert.equal(packages.length, 1, "project declaration is preserved");
    assert.equal(typeof packages[0], "string", "autoload is restored instead of staying a delta");
    assert.equal(
      (await resolveSkills(root, agentDir, settings)).find((resource) => resource.path.endsWith(join("skills", "demo", "SKILL.md")))?.enabled,
      true,
      "cleared skill autoloads again",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
