import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  clearProjectPackageOverride,
  clearProjectPackageResourceOverride,
  clearProjectTopLevelOverride,
  getProjectPackageOverride,
  getProjectPackageResourceOverride,
  getProjectTopLevelOverride,
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

    assert.equal((await resolveSkills(root, agentDir, globalOnly)).find((resource) => resource.path.endsWith("skills/demo/SKILL.md"))?.enabled, true);
    setProjectPackageOverride(settings, root, "disabled");
    assert.equal(getProjectPackageOverride(settings, root), "disabled");
    assert.equal(Object.hasOwn(settings.getProjectSettings(), PROJECT_PLUGIN_EXPLICIT_STATES_SETTING), true);
    assert.equal((await resolveSkills(root, agentDir, settings)).find((resource) => resource.path.endsWith("skills/demo/SKILL.md"))?.enabled, false);
    assert.equal((await resolveSkills(root, agentDir, globalOnly)).find((resource) => resource.path.endsWith("skills/demo/SKILL.md"))?.enabled, true);

    clearProjectPackageOverride(settings, root);
    assert.equal(getProjectPackageOverride(settings, root), "inherit");
    assert.equal(Object.hasOwn(settings.getProjectSettings(), PROJECT_PLUGIN_EXPLICIT_STATES_SETTING), false);
    assert.equal((await resolveSkills(root, agentDir, settings)).find((resource) => resource.path.endsWith("skills/demo/SKILL.md"))?.enabled, true);
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

    assert.equal((await resolveSkills(root, agentDir, globalOnly)).find((resource) => resource.path.endsWith("skills/demo/SKILL.md"))?.enabled ?? false, false);
    assert.equal((await resolveSkills(root, agentDir, settings)).find((resource) => resource.path.endsWith("skills/demo/SKILL.md"))?.enabled, true);
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

test("project top-level policy restores SDK-supported directory-configured global skills", async () => {
  const originalHome = process.env.HOME;
  try {
    for (const form of ["absolute", "relative", "relative-dot", "home", "absolute-trailing", "relative-trailing", "home-trailing"]) {
      const root = await mkdtemp(join(tmpdir(), `pi-reader-policy-top-level-directory-${form}-`));
      try {
        const fakeHome = join(root, "home");
        const skillDir = form === "absolute"
          ? join(root, "skills", "hunt")
          : form === "relative" || form === "relative-dot" || form === "relative-trailing"
            ? join(root, ".pi", "skills", "hunt")
            : join(fakeHome, "skills", "hunt");
        const configuredDir = form === "absolute"
          ? skillDir
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
        process.env.HOME = form === "home" || form === "home-trailing" ? fakeHome : originalHome;

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
          getProjectTopLevelOverride(settings, root, "skills", skillPath),
          sdkSupportsDirectoryAlias ? "disabled" : "inherit",
        );
        assert.equal(
          (await resolveSkills(root, join(root, "agent"), settings))
            .find((resource) => resource.path === skillPath)?.enabled,
          !sdkSupportsDirectoryAlias,
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

test("a disabled top-level skill rule only disables the exact skill path", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-policy-top-level-collision-"));
  const originalHome = process.env.HOME;
  try {
    const fakeHome = join(root, "home");
    process.env.HOME = fakeHome;
    const cwd = join(root, "project");
    const agentDir = join(fakeHome, ".pi", "agent");
    const globalSkill = join(agentDir, "skills", "same", "SKILL.md");
    const projectSkill = join(cwd, ".pi", "skills", "same", "SKILL.md");
    for (const skillPath of [globalSkill, projectSkill]) {
      await mkdir(join(skillPath, ".."), { recursive: true });
      await writeFile(skillPath, "---\nname: same\ndescription: same\n---\n");
    }
    const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    settings.setSkillPaths([globalSkill]);

    setProjectTopLevelOverride(settings, cwd, "skills", globalSkill, "disabled");
    await settings.flush();

    const rule = (settings.getProjectSettings().skills ?? []).find((entry) => entry.startsWith("!"));
    assert.match(rule, /^!\*\*\/\.pi\/agent\/skills\/same\/SKILL\.md$/, "rule names the exact skill");

    const resolved = await resolveSkills(cwd, agentDir, settings);
    const global = resolved.find((resource) => resource.path === globalSkill);
    const project = resolved.find((resource) => resource.path === projectSkill);
    assert.equal(global?.enabled, false, "target skill is disabled");
    assert.notEqual(project?.enabled, false, "same-named skill from another root stays enabled");

    // Reader must read the rule back the same way the SDK applies it, so the
    // project skill is not reported as disabled in the panel.
    assert.equal(getProjectTopLevelOverride(settings, cwd, "skills", globalSkill), "disabled");
    assert.equal(getProjectTopLevelOverride(settings, cwd, "skills", projectSkill), "inherit");

    clearProjectTopLevelOverride(settings, cwd, "skills", globalSkill);
    assert.equal(getProjectTopLevelOverride(settings, cwd, "skills", globalSkill), "inherit");
    assert.equal(
      (await resolveSkills(cwd, agentDir, settings)).find((resource) => resource.path === globalSkill)?.enabled,
      true,
    );
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(root, { recursive: true, force: true });
  }
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
      (await resolveSkills(root, agentDir, settings)).find((resource) => resource.path.endsWith("skills/demo/SKILL.md"))?.enabled,
      false,
    );

    clearProjectPackageResourceOverride(settings, root, "skills", "skills/demo/SKILL.md");
    await settings.flush();

    const packages = settings.getProjectSettings().packages ?? [];
    assert.equal(packages.length, 1, "project declaration is preserved");
    assert.equal(typeof packages[0], "string", "autoload is restored instead of staying a delta");
    assert.equal(
      (await resolveSkills(root, agentDir, settings)).find((resource) => resource.path.endsWith("skills/demo/SKILL.md"))?.enabled,
      true,
      "cleared skill autoloads again",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
