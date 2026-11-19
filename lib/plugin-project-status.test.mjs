import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  PROJECT_PLUGIN_EXPLICIT_STATES_SETTING,
  createProjectPluginSettingsManager,
  getGlobalPluginState,
  getPluginComparison,
  getPluginPackageIdentity,
  getProjectPackageState,
  getProjectPluginExplicitState,
  reconcileProjectPluginSettings,
  reconcileProjectPluginStates,
  setProjectPluginExplicitState,
  setProjectPluginState,
} = await jiti.import("./plugin-project-status.ts");
const { isDisabledPackage, setPackageEntryDisabled } = await jiti.import("./plugin-package-state.ts");
const { migrateProjectWebStateKeys } = await jiti.import("./project-resource-policy.ts");

function manager(globalSettings, projectSettings) {
  const global = structuredClone(globalSettings);
  const project = structuredClone(projectSettings);
  return {
    getGlobalSettings: () => structuredClone(global),
    getProjectSettings: () => structuredClone(project),
    updateProjectSettings: (_field, update) => {
      const next = structuredClone(project);
      update(next);
      for (const key of Object.keys(project)) delete project[key];
      Object.assign(project, next);
    },
    setProjectPackages: (packages) => {
      project.packages = structuredClone(packages);
    },
    flush: async () => {},
    global,
    project,
  };
}

test("initializes every global plugin state, including disabled packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-plugin-state-init-"));
  try {
    const options = { cwd: root, agentDir: join(root, "agent") };
    const globalPackages = [
      "npm:enabled@1.0.0",
      { source: "npm:disabled@1.0.0", extensions: [], skills: [], prompts: [], themes: [] },
    ];
    const result = reconcileProjectPluginStates(globalPackages, {}, options);
    assert.deepEqual(result.states, {
      [getPluginPackageIdentity("npm:enabled@1.0.0", { ...options, scope: "user" })]: "enabled",
      [getPluginPackageIdentity("npm:disabled@1.0.0", { ...options, scope: "user" })]: "disabled",
    });
    assert.equal(result.changed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps explicit project state independent from later global changes and sync", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-plugin-state-independent-"));
  try {
    const options = { cwd: root, agentDir: join(root, "agent") };
    const source = "npm:tool@1.0.0";
    const managerState = manager({ packages: [source] }, {
      [PROJECT_PLUGIN_EXPLICIT_STATES_SETTING]: { "npm:tool": "enabled" },
    });
    managerState.global.packages = [{ source, extensions: [], skills: [], prompts: [], themes: [] }];
    const disabledGlobal = managerState.global.packages[0];
    disabledGlobal.extensions = [];
    disabledGlobal.skills = [];
    disabledGlobal.prompts = [];
    disabledGlobal.themes = [];
    const result = reconcileProjectPluginStates(managerState.global.packages, managerState.project, options);
    assert.equal(result.states["npm:tool"], "enabled");
    assert.equal(getPluginComparison(result.states["npm:tool"], getGlobalPluginState(disabledGlobal)), "different");

    await setProjectPluginState(managerState, source, "disabled", options);
    assert.equal(getProjectPluginExplicitState(managerState.project, source, options), "disabled");
    await setProjectPluginState(managerState, source, "disabled", options);
    assert.equal(Object.keys(managerState.project[PROJECT_PLUGIN_EXPLICIT_STATES_SETTING]).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adds new global plugins without rewriting existing explicit states", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-plugin-state-add-"));
  try {
    const options = { cwd: root, agentDir: join(root, "agent") };
    const existing = "npm:existing@1.0.0";
    const added = "npm:added@1.0.0";
    const existingIdentity = getPluginPackageIdentity(existing, { ...options, scope: "user" });
    const first = reconcileProjectPluginStates([existing], {
      [PROJECT_PLUGIN_EXPLICIT_STATES_SETTING]: { [existingIdentity]: "disabled" },
    }, options);
    assert.equal(first.states[existingIdentity], "disabled");
    const second = reconcileProjectPluginStates([existing, added], {
      [PROJECT_PLUGIN_EXPLICIT_STATES_SETTING]: { [existingIdentity]: "disabled" },
    }, options);
    assert.equal(second.states[existingIdentity], "disabled");
    assert.equal(second.states[getPluginPackageIdentity(added, { ...options, scope: "user" })], "enabled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes stale global state but preserves project-only package configuration without diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-plugin-state-remove-"));
  try {
    const options = { cwd: root, agentDir: join(root, "agent") };
    const result = reconcileProjectPluginStates([], {
      [PROJECT_PLUGIN_EXPLICIT_STATES_SETTING]: { "npm:removed": "disabled" },
      packages: ["npm:project-only"],
    }, options);
    assert.deepEqual(result.states, {});
    assert.deepEqual(result.removedIdentities, ["npm:removed"]);
    assert.deepEqual(result.projectOnlyPackages, ["npm:project-only"]);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("treats an unmarked project package snapshot as inherited", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-plugin-state-inherit-"));
  try {
    const options = { cwd: root, agentDir: join(root, "agent") };
    const source = "npm:legacy-snapshot@1.0.0";
    const snapshot = {
      source,
      autoload: false,
      extensions: ["!**"],
      skills: ["!**"],
      prompts: ["!**"],
      themes: ["!**"],
    };
    const stateManager = manager({ packages: [source] }, { packages: [snapshot] });
    const effectiveManager = createProjectPluginSettingsManager(stateManager, options);

    assert.equal(isDisabledPackage(effectiveManager.getGlobalSettings().packages[0]), false);
    stateManager.global.packages = [setPackageEntryDisabled(source, true)];
    assert.equal(isDisabledPackage(effectiveManager.getGlobalSettings().packages[0]), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves global package filters while applying project enable and disable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-plugin-state-filters-"));
  try {
    const options = { cwd: root, agentDir: join(root, "agent") };
    const source = "npm:filtered@1.0.0";
    const entry = {
      source,
      autoload: false,
      extensions: ["extensions/index.ts"],
      skills: ["skills/example/SKILL.md"],
      prompts: ["prompts/example.md"],
      themes: ["themes/example.json"],
    };
    const stateManager = manager({ packages: [entry] }, {
      [PROJECT_PLUGIN_EXPLICIT_STATES_SETTING]: { "npm:filtered": "disabled" },
    });
    const effectiveDisabled = createProjectPluginSettingsManager(stateManager, options)
      .getGlobalSettings().packages[0];
    assert.equal(effectiveDisabled.autoload, false);
    assert.equal(effectiveDisabled.extensions.includes("extensions/index.ts"), true);
    assert.equal(Object.keys(effectiveDisabled).some((key) => key.includes("piWeb")), false);

    stateManager.project[PROJECT_PLUGIN_EXPLICIT_STATES_SETTING]["npm:filtered"] = "enabled";
    const effectiveEnabled = createProjectPluginSettingsManager(stateManager, options)
      .getGlobalSettings().packages[0];
    assert.deepEqual(effectiveEnabled, entry);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applies explicit project parent and child package state to global resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-plugin-native-project-state-"));
  try {
    const options = { cwd: root, agentDir: join(root, "agent") };
    const sources = [
      "npm:native-state@1.0.0",
      "git:https://github.com/example/native-state@abc123",
      root,
    ];
    for (const source of sources) {
      const globalEntry = {
        source,
        autoload: false,
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
      };
      const projectEntry = {
        source,
        autoload: false,
        extensions: ["**"],
        skills: ["**", "-skills/example/SKILL.md"],
        prompts: ["**"],
        themes: ["**"],
      };
      const stateManager = manager({ packages: [globalEntry] }, {
        [PROJECT_PLUGIN_EXPLICIT_STATES_SETTING]: { [getPluginPackageIdentity(source, { ...options, scope: "user" })]: "enabled" },
        packages: [projectEntry],
      });
      const effective = createProjectPluginSettingsManager(stateManager, options)
        .getGlobalSettings().packages[0];
      assert.equal(getProjectPackageState(projectEntry), "enabled");
      assert.equal(isDisabledPackage(effective), false);
      assert.equal((effective && typeof effective !== "string" ? effective.skills : []).includes("-skills/example/SKILL.md"), true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit project parent disable caps child resource enable without deleting its pattern", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-plugin-native-parent-cap-"));
  try {
    const options = { cwd: root, agentDir: join(root, "agent") };
    const source = "npm:native-parent-cap@1.0.0";
    const projectEntry = {
      source,
      autoload: false,
      extensions: ["!**"],
      skills: ["!**", "+skills/example/SKILL.md"],
      prompts: ["!**"],
      themes: ["!**"],
    };
    const stateManager = manager(
      { packages: [source] },
      {
        [PROJECT_PLUGIN_EXPLICIT_STATES_SETTING]: { [getPluginPackageIdentity(source, { ...options, scope: "user" })]: "disabled" },
        packages: [projectEntry],
      },
    );
    const effective = createProjectPluginSettingsManager(stateManager, options)
      .getGlobalSettings().packages[0];
    assert.equal(getProjectPackageState(projectEntry), "disabled");
    assert.equal(isDisabledPackage(effective), true);
    assert.equal(projectEntry.skills.includes("+skills/example/SKILL.md"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discards legacy parent state without deleting project-only packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-plugin-state-migrate-"));
  try {
    const stateManager = manager(
      { packages: ["npm:legacy@1.0.0"] },
      { piWebPluginOverrides: { "npm:legacy@0.9.0": "disabled" }, packages: ["npm:project-only"] },
    );
    assert.equal(migrateProjectWebStateKeys(stateManager, root), true);
    assert.deepEqual(stateManager.project.packages, [
      "npm:project-only",
    ]);
    assert.equal(Object.hasOwn(stateManager.project, "piWebPluginOverrides"), false);
    assert.equal(Object.hasOwn(stateManager.project, PROJECT_PLUGIN_EXPLICIT_STATES_SETTING), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses package identity independent of npm version and git ref", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-plugin-state-identity-"));
  t.diagnostic(`resource-policy fixture: ${root}`);
  try {
    const options = { cwd: root, agentDir: join(root, "agent") };
    assert.equal(
      getPluginPackageIdentity("npm:@scope/tool@1.0.0", { ...options, scope: "user" }),
      getPluginPackageIdentity("npm:@scope/tool@2.0.0", { ...options, scope: "user" }),
    );
    assert.equal(
      getPluginPackageIdentity("git:https://github.com/example/tool@abc123", { ...options, scope: "user" }),
      getPluginPackageIdentity("git:https://github.com/example/tool@def456", { ...options, scope: "user" }),
    );
    const localPath = join(root, ".pi", "local-tool");
    const expectedPath = process.platform === "win32" ? localPath.toLowerCase() : localPath;
    assert.equal(getPluginPackageIdentity("./local-tool", { ...options, scope: "project" }), `local:${expectedPath}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local plugin state preserves source case and follows a moved home", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-plugin-state-portable-"));
  t.diagnostic(`resource-policy fixture: ${root}`);
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const setHome = (home) => {
    process.env.HOME = home;
    if (process.platform === "win32") process.env.USERPROFILE = home;
  };
  try {
    const firstHome = join(root, "FirstHome");
    const nextHome = join(root, "SecondHome");
    setHome(firstHome);
    const firstSource = join(firstHome, ".pi", "Agent", "MiXeDPlugin");
    const firstOptions = { cwd: root, agentDir: join(firstHome, ".pi", "agent") };
    const oldKey = getPluginPackageIdentity(firstSource, { ...firstOptions, scope: "user" });
    const stateManager = manager({ packages: [firstSource] }, {
      [PROJECT_PLUGIN_EXPLICIT_STATES_SETTING]: { [oldKey]: "enabled" },
    });
    setProjectPluginExplicitState(stateManager, firstSource, "disabled", firstOptions);
    assert.deepEqual(stateManager.project[PROJECT_PLUGIN_EXPLICIT_STATES_SETTING], {
      "local:~/.pi/Agent/MiXeDPlugin": "disabled",
    });
    assert.equal(getProjectPluginExplicitState(stateManager.project, firstSource, firstOptions), "disabled");
    for (const alias of [join("..", "Agent", "MiXeDPlugin"), pathToFileURL(firstSource).href]) {
      setProjectPluginExplicitState(stateManager, alias, "enabled", firstOptions);
      assert.deepEqual(stateManager.project[PROJECT_PLUGIN_EXPLICIT_STATES_SETTING], {
        "local:~/.pi/Agent/MiXeDPlugin": "enabled",
      });
    }
    setProjectPluginExplicitState(stateManager, firstSource, "disabled", firstOptions);

    setHome(nextHome);
    const movedSource = join(nextHome, ".pi", "Agent", "MiXeDPlugin");
    const movedOptions = { cwd: root, agentDir: join(nextHome, ".pi", "agent") };
    assert.equal(getProjectPluginExplicitState(stateManager.project, movedSource, movedOptions), "disabled");
    const result = reconcileProjectPluginStates([movedSource], stateManager.project, movedOptions);
    assert.deepEqual(result.states, { "local:~/.pi/Agent/MiXeDPlugin": "disabled" });
    assert.deepEqual(result.removedIdentities, []);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    await rm(root, { recursive: true, force: true });
  }
});

test("foreign absolute plugin state is not silently treated as inherited", () => {
  const foreign = process.platform === "win32" ? "/home/example/plugin" : "C:\\Users\\Example\\Plugin";
  const options = { cwd: process.cwd(), agentDir: join(process.cwd(), "agent") };
  const stateManager = manager({ packages: ["npm:tool"] }, {
    [PROJECT_PLUGIN_EXPLICIT_STATES_SETTING]: { [`local:${foreign}`]: "disabled" },
  });
  const before = structuredClone(stateManager.project);
  assert.throws(() => getProjectPluginExplicitState(stateManager.project, "npm:tool", options), /another platform/);
  assert.throws(() => reconcileProjectPluginStates(stateManager.global.packages, stateManager.project, options), /another platform/);
  assert.throws(() => setProjectPluginExplicitState(stateManager, "npm:tool", "enabled", options), /another platform/);
  assert.deepEqual(stateManager.project, before);
});

test("serializes concurrent state reconciliation without losing an explicit state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-plugin-state-lock-"));
  try {
    const options = { cwd: root, agentDir: join(root, "agent") };
    const stateManager = manager({ packages: ["npm:tool"] }, {});
    await Promise.all([
      reconcileProjectPluginSettings(stateManager, options),
      setProjectPluginState(stateManager, "npm:tool", "disabled", options),
    ]);
    assert.equal(getProjectPluginExplicitState(stateManager.project, "npm:tool", options), "disabled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
