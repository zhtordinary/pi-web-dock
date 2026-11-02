import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import * as React from "react";
import { createRoot } from "react-dom/client";
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });

const { builtinRuntimeExtensionKey, comparePluginPackages, filterBuiltinRuntimeExtensions, filterPackagesForProjectStatusCounts, filterTopLevelExtensions, firstRenderedPluginKey, isPackageVisible, isPluginOwnerCurrent, isPluginSearchMatch, isProjectPackageVisible, isProjectTopLevelExtensionVisible, isTopLevelExtensionVisible, pluginDisplayName, projectPackageFilterCounts, projectTopLevelExtensionFilterCounts, topLevelExtensionKey, usePluginLoadEffect } = await jiti.import("./PluginsConfig.tsx");
const { filterSkillsForProjectStatusCounts, isPluginDisabledForSkill, isProjectSkillVisible, isSkillSearchMatch, isSkillVisible, pluginEnableAction, pluginSkillGroupLabel, sortSkillsByName, projectSkillFilterCounts, selectVisibleSkillPath, skillProjectStatus } = await jiti.import("./SkillsConfig.tsx");
test("scope badges localize global and use the shared neutral background", async () => {
  const source = await readFile(new URL("./PluginsConfig.tsx", import.meta.url), "utf8");
  assert.match(source, /skills\.scope\.global/);
  assert.match(source, /<ConfigScopeTag scope=\{pkg.scope\}>/);
  assert.match(source, /<ConfigScopeTag scope=\{extension.scope\}>/);
});

test("keeps plugin switches with the detail actions", async () => {
  const source = await readFile(new URL("./PluginsConfig.tsx", import.meta.url), "utf8");
  const detailStart = source.indexOf("function PackageDetail");
  const detailEnd = source.indexOf("function topLevelExtensionStatusColor");
  const detail = source.slice(detailStart, detailEnd);
  const headerInfoEnd = detail.indexOf("</div>\n\n        <div className=\"config-detail-actions\">");
  const headerInfo = detail.slice(0, headerInfoEnd);
  const actions = detail.slice(headerInfoEnd);
  assert.doesNotMatch(headerInfo, /<ConfigSwitch/);
  assert.match(actions, /<ConfigSwitch/);
});
test("requires the parent plugin before enabling a disabled plugin skill", () => {
  const skill = { sourceInfo: { origin: "package", source: "npm:tool" } };
  assert.equal(isPluginDisabledForSkill(skill, {
    "npm:tool": { source: "npm:tool", scope: "project", disabled: true },
  }), true);
  assert.equal(isPluginDisabledForSkill(skill, {
    "npm:tool": { source: "npm:tool", scope: "project", disabled: false },
  }), false);
  assert.equal(isSkillVisible(skill, true, false, "global", {
    "npm:tool": { source: "npm:tool", scope: "project", disabled: true },
  }), false);
  assert.deepEqual(pluginEnableAction({ scope: "global" }, "project"), {
    action: "set_project_override",
    scope: "project",
  });
  assert.deepEqual(pluginEnableAction({ scope: "project" }, "project"), {
    action: "enable",
    scope: "project",
  });
});
test("sorts skills by name and path", () => {
  const skills = [
    { name: "zeta", filePath: "/skills/zeta/SKILL.md" },
    { name: "same", filePath: "/skills/b/SKILL.md" },
    { name: "same", filePath: "/skills/a/SKILL.md" },
  ];
  assert.deepEqual(sortSkillsByName(skills).map((skill) => skill.filePath), [
    "/skills/a/SKILL.md",
    "/skills/b/SKILL.md",
    "/skills/zeta/SKILL.md",
  ]);
});
const { getEditNavigationEntryId } = await jiti.import("./MessageView.tsx");
const { getEffectivePluginOverride, getPluginProjectStatus } = await jiti.import("../lib/plugin-project-status.ts");
const { getSkillProjectStatus } = await jiti.import("../lib/skills-service.ts");
const { DefaultPackageManager, SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { isDisabledPackage, setPackageEntryDisabled } = await jiti.import("../lib/plugin-package-state.ts");
const {
  clearPluginOverride,
  clearPluginSkillOverride,
  createPluginOverrideSettingsManager,
  getPluginOverrides,
  getPluginSkillOverrides,
  setGlobalPluginSkillFilter,
  setPluginOverride,
  setPluginSkillOverride,
} = await jiti.import("../lib/plugin-overrides.ts");
function pkg(source, packageName) {
  return {
    source,
    packageName,
    scope: "global",
    projectStatus: "matching",
    filtered: false,
    disabled: false,
    counts: { extensions: 0, skills: 0, prompts: 0, themes: 0 },
    resources: [],
    status: "installed",
  };
}
test("shows a compact package name for each source group", () => {
  assert.equal(
    pluginDisplayName(pkg("npm:@hypabolic/pi-hypa@0.1.0", "@hypabolic/pi-hypa")),
    "pi-hypa",
  );
  assert.equal(
    pluginDisplayName(pkg("~/.pi/agent/packages/local-tools", "local-tools")),
    "local-tools",
  );
  assert.equal(
    pluginDisplayName(pkg("git:https://github.com/example/marketingskills@c21a984a56d1", "marketingskills@c21a984a56d1")),
    "marketingskills",
  );
  assert.equal(
    pluginDisplayName(pkg("git:https://github.com/example/dbskill#195f8f0dcb05", undefined)),
    "dbskill",
  );
});
test("filters enabled and not-enabled packages independently", () => {
  const enabled = pkg("npm:enabled", "enabled");
  const disabled = { ...pkg("npm:disabled", "disabled"), disabled: true, status: "disabled" };
  const missing = { ...pkg("npm:missing", "missing"), status: "missing" };

  assert.equal(isPackageVisible(enabled, false), false);
  assert.equal(isPackageVisible(enabled, true, false), true);
  assert.equal(isPackageVisible(enabled, false, false), false);
  assert.equal(isPackageVisible(disabled, true, false), false);
  assert.equal(isPackageVisible(disabled, false, true), true);
  assert.equal(isPackageVisible(disabled, false, false), false);
  assert.equal(isPackageVisible(missing, false, true), true);
  assert.equal(isPackageVisible(missing, true, false), false);
  assert.equal(isPackageVisible(enabled, true, true), true);
});

test("keeps top-level extensions visible and tracks project state", () => {
  const enabled = {
    name: "execution-supervisor",
    path: "/home/alice/.pi/agent/extensions/execution-supervisor/index.ts",
    relativePath: "extensions/execution-supervisor/index.ts",
    source: "auto",
    scope: "global",
    enabled: true,
    globalEnabled: true,
    projectStatus: "matching",
    status: "loaded",
  };
  const disabled = {
    ...enabled,
    name: "tokentracker-notify",
    path: "/home/alice/.pi/agent/extensions/tokentracker-notify.ts",
    relativePath: "extensions/tokentracker-notify.ts",
    enabled: false,
    globalEnabled: true,
    projectStatus: "different",
    projectOverride: "disabled",
    status: "disabled",
  };

  assert.equal(topLevelExtensionKey(enabled), `global\0${enabled.path}`);
  assert.equal(isTopLevelExtensionVisible(enabled, true, false), true);
  assert.equal(isTopLevelExtensionVisible(disabled, true, false), false);
  assert.deepEqual(filterTopLevelExtensions([enabled, disabled], {
    searchQuery: "supervisor",
    showEnabled: true,
    showNotEnabled: true,
  }).map((extension) => extension.name), ["execution-supervisor"]);
  assert.equal(isProjectTopLevelExtensionVisible(enabled, "matching"), true);
  assert.equal(isProjectTopLevelExtensionVisible(disabled, "different"), true);
  assert.deepEqual(projectTopLevelExtensionFilterCounts([enabled, disabled]), {
    different: 1,
    all: 2,
    matching: 1,
    project: 0,
  });
});

test("shows built-in runtime extensions as an enabled, searchable read-only category with package-aligned details", async () => {
  const extensions = [
    {
      id: "pi-web-fast-mode",
      labelKey: "i18n.builtinRuntimeExtensionFastMode",
      descriptionKey: "i18n.builtinRuntimeExtensionFastModeDescription",
      source: "reader",
      origin: "inline",
      scope: "session",
      status: "reader-provided",
      capabilities: [{ kind: "hook", name: "before_provider_request" }],
    },
    {
      id: "pi-web-session-control",
      labelKey: "i18n.builtinRuntimeExtensionSessionControl",
      descriptionKey: "i18n.builtinRuntimeExtensionSessionControlDescription",
      source: "reader",
      origin: "inline",
      scope: "session",
      status: "reader-provided",
      capabilities: [{ kind: "tool", name: "session_control" }],
    },
  ];

  assert.equal(builtinRuntimeExtensionKey(extensions[0]), "builtin:pi-web-fast-mode");
  assert.deepEqual(filterBuiltinRuntimeExtensions(extensions, { searchQuery: "session_control", showEnabled: true, viewScope: "global" }), [extensions[1]]);
  assert.deepEqual(filterBuiltinRuntimeExtensions(extensions, { searchQuery: "", showEnabled: false, viewScope: "global" }), []);
  assert.deepEqual(filterBuiltinRuntimeExtensions(extensions, { searchQuery: "", showEnabled: true, viewScope: "project" }), []);

  const source = await readFile(new URL("./PluginsConfig.tsx", import.meta.url), "utf8");
  const detailStart = source.indexOf("function BuiltinRuntimeExtensionDetail");
  const detailEnd = source.indexOf("function BuiltinRuntimeExtensionGroup");
  assert.ok(detailStart >= 0 && detailEnd > detailStart, "built-in runtime detail component exists");
  const detail = source.slice(detailStart, detailEnd);
  const packageStart = source.indexOf("function PackageDetail");
  const packageEnd = source.indexOf("function topLevelExtensionStatusColor");
  assert.ok(packageStart >= 0 && packageEnd > packageStart, "regular package detail component exists");
  const packageDetail = source.slice(packageStart, packageEnd);
  for (const layout of [
    'display: "flex", flexDirection: "column", gap: 16, maxWidth: 680',
    'alignItems: "center", justifyContent: "space-between", gap: 12, minWidth: 0, minHeight: "var(--config-control-height)", flexWrap: "wrap"',
    'minWidth: 180, flex: 1',
    'gridTemplateColumns: "minmax(96px, 130px) minmax(0, 1fr)"',
  ]) {
    assert.ok(packageDetail.includes(layout), `regular package detail includes ${layout}`);
    assert.ok(detail.includes(layout), `built-in runtime detail matches ${layout}`);
  }
  assert.match(detail, /i18n\.builtinRuntimeExtensionReadOnly/);
  assert.match(detail, /i18n\.pluginRuntimeStatusTitle/);
  assert.match(detail, /i18n\.builtinRuntimeExtensionProvided/);
  assert.match(detail, /i18n\.builtinRuntimeExtensionCapabilities/);
  assert.match(detail, /extension\.capabilities\.map/);
  assert.match(detail, /i18n\.builtinRuntimeExtensionHint/);
  assert.doesNotMatch(detail, /onAction|runAction|onToggle|fetch\(|<button/, "built-in runtime details stay read-only");
});

test("finds a local package by its description as well as its name", () => {
  const local = { ...pkg("~/.pi/agent/packages/fixture", "fixture"), description: "示例扩展：使用 /fixtureSettings 调整设置" };
  assert.equal(isPluginSearchMatch(local, "示例扩展"), true);
  assert.equal(isPluginSearchMatch(local, "fixturesettings"), true);
  assert.equal(isPluginSearchMatch(local, "不存在"), false);
});

test("default selection follows the first rendered package after API-order and filters", () => {
  const apiOrder = [
    pkg("npm:second", "second"),
    pkg("~/.pi/agent/packages/first", "first"),
  ];
  assert.equal(firstRenderedPluginKey(apiOrder, [], []), "global\0~/.pi/agent/packages/first");

  const filtered = apiOrder.filter((item) => item.packageName !== "first");
  assert.equal(firstRenderedPluginKey(filtered, [], []), "global\0npm:second");
});

test("renders package groups before standalone and built-in runtime groups", async () => {
  const source = await readFile(new URL("./PluginsConfig.tsx", import.meta.url), "utf8");
  const packageGroups = source.indexOf("{groupedPackages.map((group) => {");
  const builtInRuntimeGroup = source.indexOf("<BuiltinRuntimeExtensionGroup");
  const standaloneGroup = source.indexOf("<TopLevelExtensionGroup");
  assert.ok(packageGroups >= 0 && builtInRuntimeGroup > packageGroups && standaloneGroup > builtInRuntimeGroup);
});

test("project package status counts follow active visibility filters", () => {
  const enabled = pkg("npm:enabled", "enabled");
  const disabled = { ...pkg("npm:disabled", "disabled"), disabled: true, status: "disabled" };
  const candidates = filterPackagesForProjectStatusCounts([enabled, disabled], {
    searchQuery: "",
    showEnabled: true,
    showNotEnabled: false,
  });

  assert.deepEqual(projectPackageFilterCounts(candidates), {
    different: 0,
    all: 1,
    matching: 1,
    project: 0,
  });
});

test("derives project status from effective package state", () => {
  assert.equal(getEffectivePluginOverride(false, "enabled"), undefined);
  assert.equal(getEffectivePluginOverride(true, "disabled"), undefined);
  assert.equal(getEffectivePluginOverride(false, "disabled"), "disabled");
  assert.equal(getEffectivePluginOverride(true, "enabled"), "enabled");
  assert.equal(getPluginProjectStatus("global", false, "enabled"), "matching");
  assert.equal(getPluginProjectStatus("global", true, "disabled"), "matching");
  assert.equal(getPluginProjectStatus("global", false, "disabled"), "different");
  assert.equal(getPluginProjectStatus("project", undefined, undefined), "project");
});

test("separates inherited, changed, and project-only package filters", () => {
  const inherited = pkg("npm:inherited", "inherited");
  const overridden = { ...pkg("npm:overridden", "overridden"), projectOverride: "disabled", projectStatus: "different" };
  const redundant = { ...pkg("npm:redundant", "redundant"), projectOverride: "enabled", projectStatus: "matching" };
  const project = { ...pkg("npm:project", "project"), projectStatus: "different" };
  const projectOnly = { ...pkg("npm:only", "only"), scope: "project", projectStatus: "project" };
  const filteredInherited = { ...inherited, source: "npm:filtered", filtered: true };

  assert.equal(isProjectPackageVisible(inherited, "matching"), true);
  assert.equal(isProjectPackageVisible(inherited, "different"), false);
  assert.equal(isProjectPackageVisible(overridden, "different"), true);
  assert.equal(isProjectPackageVisible(project, "different"), true);
  assert.equal(isProjectPackageVisible(projectOnly, "project"), true);
  assert.equal(isProjectPackageVisible(projectOnly, "different"), false);
  assert.equal(isProjectPackageVisible(projectOnly, "matching"), false);
  assert.equal(isPluginSearchMatch(inherited, "INHERITED"), true);
  assert.equal(isPluginSearchMatch(inherited, "missing"), false);
  assert.equal(isProjectPackageVisible(redundant, "matching"), true);
  assert.equal(isProjectPackageVisible(redundant, "different"), false);
  assert.equal(isProjectPackageVisible(filteredInherited, "matching"), true);
  assert.equal(isProjectPackageVisible(filteredInherited, "different"), false);
  assert.deepEqual(projectPackageFilterCounts([inherited, overridden, redundant, project, projectOnly]), {
    different: 2,
    all: 5,
    matching: 2,
    project: 1,
  });
});

test("sorts plugin sources as local, npm, then git", () => {
  const packages = [
    pkg("git:https://github.com/example/reader-tools.git", "reader-tools"),
    pkg("npm:@hypabolic/pi-hypa@0.1.0", "@hypabolic/pi-hypa"),
    pkg("~/.pi/agent/packages/local-tools", "local-tools"),
  ].sort(comparePluginPackages);
  assert.deepEqual(packages.map((item) => item.source), [
    "~/.pi/agent/packages/local-tools",
    "npm:@hypabolic/pi-hypa@0.1.0",
    "git:https://github.com/example/reader-tools.git",
  ]);
});
test("uses clean names for plugin skill groups", () => {
  assert.equal(
    pluginSkillGroupLabel("git:https://github.com/example/marketingskills@c21a984a56d1"),
    "marketingskills",
  );
  assert.equal(
    pluginSkillGroupLabel("npm:@scope/pony-tail@4.8.4"),
    "pony-tail",
  );
  assert.equal(
    pluginSkillGroupLabel("~/.pi/agent/packages/local-tools"),
    "local-tools",
  );
  assert.equal(
    pluginSkillGroupLabel("~/.pi/agent/packages/paperspine-pi"),
    "PaperSpine Pi",
  );
});

test("filters enabled and not-enabled skills independently", () => {
  const enabled = { sourceInfo: { origin: "package" }, resourceEnabled: true };
  const disabled = { sourceInfo: { origin: "package" }, resourceEnabled: false };

  assert.equal(isSkillVisible(enabled, true, false), true);
  assert.equal(isSkillVisible(enabled, false, true), false);
  assert.equal(isSkillVisible(disabled, true, false), false);
  assert.equal(isSkillVisible(disabled, false, true), true);
  assert.equal(isSkillVisible(enabled, true, true), true);
  assert.equal(isSkillVisible(disabled, true, true), true);
});

test("project skill status counts follow active visibility filters", () => {
  const enabled = {
    name: "enabled",
    description: "",
    filePath: "/skills/enabled/SKILL.md",
    sourceInfo: { origin: "package", scope: "user" },
    resourceEnabled: true,
    globalResourceEnabled: true,
  };
  const disabled = {
    ...enabled,
    name: "disabled",
    filePath: "/skills/disabled/SKILL.md",
    resourceEnabled: false,
  };
  const candidates = filterSkillsForProjectStatusCounts([enabled, disabled], {
    searchQuery: "",
    showEnabled: true,
    showNotEnabled: false,
    viewScope: "project",
  });

  assert.deepEqual(projectSkillFilterCounts(candidates), {
    different: 0,
    all: 1,
    matching: 1,
    project: 0,
  });
});

test("classifies skills by final state and project-only scope", () => {
  const inherited = {
    sourceInfo: { origin: "package", scope: "user" },
    resourceEnabled: true,
    globalResourceEnabled: true,
  };
  const overridden = {
    ...inherited,
    resourceEnabled: false,
    projectOverride: "disabled",
    globalResourceEnabled: true,
  };
  const redundant = { ...inherited, projectOverride: "enabled" };
  const project = { sourceInfo: { origin: "top-level", scope: "project" }, resourceEnabled: true };

  assert.equal(skillProjectStatus(inherited), "matching");
  assert.equal(skillProjectStatus(overridden), "different");
  assert.equal(skillProjectStatus(redundant), "matching");
  assert.equal(skillProjectStatus(project), "project");
  assert.equal(getSkillProjectStatus("user", true, true), "matching");
  assert.equal(getSkillProjectStatus("user", false, true), "different");
  assert.equal(getSkillProjectStatus("project", true, undefined), "project");
  assert.equal(isProjectSkillVisible(inherited, "matching"), true);
  assert.equal(isProjectSkillVisible(overridden, "different"), true);
  assert.equal(isProjectSkillVisible(redundant, "different"), false);
  assert.equal(isProjectSkillVisible(project, "project"), true);
  const searchSkill = { ...inherited, name: "Browser helper", description: "Search tools", filePath: "/tmp/browser/SKILL.md" };
  assert.equal(isSkillSearchMatch(searchSkill, "browser"), true);
  assert.equal(isSkillSearchMatch(searchSkill, "missing"), false);
  assert.deepEqual(projectSkillFilterCounts([inherited, overridden, redundant, project]), {
    different: 1,
    all: 4,
    matching: 2,
    project: 1,
  });
});

test("skill project counts, filters, and badges use the service's complete effective state", () => {
  const inherited = {
    sourceInfo: { scope: "user", origin: "package" },
    resourceEnabled: true,
    invocationMode: "automatic",
    projectStatus: "matching",
    policy: {
      resourceState: "enabled",
      globalResourceState: "enabled",
      projectResourceState: "enabled",
      invocationMode: "automatic",
    },
  };
  const manual = {
    ...inherited,
    invocationMode: "explicit-only",
    projectStatus: "different",
    policy: { ...inherited.policy, invocationMode: "explicit-only", projectInvocationMode: "explicit-only" },
  };
  const disabled = {
    ...manual,
    resourceEnabled: false,
    projectStatus: "matching",
    policy: { ...manual.policy, resourceState: "disabled", globalResourceState: "disabled", projectResourceState: "disabled" },
  };
  const project = { ...manual, sourceInfo: { scope: "project", origin: "top-level" }, projectStatus: "project" };

  assert.equal(skillProjectStatus(manual), "different");
  assert.equal(skillProjectStatus(inherited), "matching");
  assert.equal(skillProjectStatus(disabled), "matching");
  assert.equal(skillProjectStatus(project), "project");
  assert.equal(isProjectSkillVisible(manual, "different"), true);
  assert.equal(isProjectSkillVisible(inherited, "different"), false);
  assert.deepEqual(projectSkillFilterCounts([inherited, manual, disabled, project]), {
    different: 1, all: 4, matching: 2, project: 1,
  });
});

test("follows the selected skill when the project filter changes", () => {
  const skills = [
    { filePath: "/different/SKILL.md" },
    { filePath: "/project/SKILL.md" },
  ];
  assert.equal(selectVisibleSkillPath(skills, "/different/SKILL.md"), "/different/SKILL.md");
  assert.equal(selectVisibleSkillPath(skills.slice(1), "/different/SKILL.md"), "/project/SKILL.md");
  assert.equal(selectVisibleSkillPath([], "/different/SKILL.md"), null);
});

test("edits the first user message from its own entry", () => {
  assert.equal(getEditNavigationEntryId("user-1"), "user-1");
  assert.equal(getEditNavigationEntryId("user-2", "assistant-1"), "assistant-1");
});

test("stores project plugin overrides without changing global settings", () => {
  const globalSettings = {
    packages: [
      { source: "npm:disabled", extensions: [], skills: [], prompts: [], themes: [] },
      "npm:enabled",
    ],
  };
  const projectSettings = {};
  const manager = {
    getGlobalSettings: () => structuredClone(globalSettings),
    getProjectSettings: () => structuredClone(projectSettings),
    updateProjectSettings: (_field, update) => update(projectSettings),
    getPackages: () => [...globalSettings.packages],
  };
  const sourceNames = (packages) => packages.map((entry) => typeof entry === "string" ? entry : entry.source);
  const effective = createPluginOverrideSettingsManager(manager);

  setPluginOverride(manager, "npm:disabled", "enabled");
  setPluginOverride(manager, "npm:enabled", "disabled");
  assert.deepEqual(getPluginOverrides(manager), {
    "npm:disabled": "enabled",
    "npm:enabled": "disabled",
  });
  assert.deepEqual(sourceNames(effective.getGlobalSettings().packages), ["npm:disabled"]);
  assert.deepEqual(sourceNames(globalSettings.packages), ["npm:disabled", "npm:enabled"]);

  clearPluginOverride(manager, "npm:disabled");
  clearPluginOverride(manager, "npm:enabled");
  assert.deepEqual(getPluginOverrides(manager), {});
  assert.deepEqual(sourceNames(effective.getGlobalSettings().packages), ["npm:disabled", "npm:enabled"]);
});

test("preserves package filters when toggling package disabled state", () => {
  const configured = {
    source: "npm:filtered",
    autoload: false,
    extensions: ["extensions/index.ts"],
    skills: ["skills/example/SKILL.md"],
  };
  assert.equal(isDisabledPackage(configured), false);
  const disabled = setPackageEntryDisabled(configured, true);
  assert.equal(isDisabledPackage(disabled), true);
  assert.deepEqual(disabled, {
    source: "npm:filtered",
    autoload: false,
    extensions: ["extensions/index.ts", "!**", "!__pi_web_package_disabled_present__"],
    skills: ["skills/example/SKILL.md", "!**", "!__pi_web_package_disabled_present__"],
    prompts: ["!**", "!__pi_web_package_disabled_missing__"],
    themes: ["!**", "!__pi_web_package_disabled_missing__"],
  });
  assert.deepEqual(setPackageEntryDisabled(disabled, false), configured);
  assert.equal(setPackageEntryDisabled("npm:legacy", true).source, "npm:legacy");
  assert.equal(setPackageEntryDisabled(setPackageEntryDisabled("npm:legacy", true), false), "npm:legacy");
  assert.equal(
    setPackageEntryDisabled({ source: "npm:legacy-filter", autoload: false, extensions: [], skills: [], prompts: [], themes: [] }, false),
    "npm:legacy-filter",
  );

  const forceIncluded = {
    source: "npm:force-included",
    extensions: ["extensions/index.ts", "+extensions/forced.ts"],
    skills: [],
    prompts: [],
    themes: [],
  };
  const disabledForceIncluded = setPackageEntryDisabled(forceIncluded, true);
  assert.deepEqual(disabledForceIncluded.extensions, [
    "extensions/index.ts",
    "+extensions/forced.ts",
    "!**",
    "!__pi_web_package_disabled_present__",
    "-extensions/forced.ts",
  ]);
  assert.deepEqual(setPackageEntryDisabled(disabledForceIncluded, false), forceIncluded);
});

test("disabled package patterns remain invisible to the SDK and restore cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-package-state-"));
  try {
    await mkdir(join(root, "extensions"), { recursive: true });
    await mkdir(join(root, "skills", "example"), { recursive: true });
    await writeFile(join(root, "extensions", "index.js"), "export default {};\n");
    await writeFile(join(root, "skills", "example", "SKILL.md"), "---\ndescription: fixture\n---\n");
    const configured = {
      source: root,
      extensions: ["extensions/index.js"],
      skills: ["skills/example/SKILL.md"],
    };
    const resolve = async (entry) => {
      const settings = SettingsManager.inMemory({ packages: [entry] });
      const manager = new DefaultPackageManager({ cwd: root, agentDir: join(root, "agent"), settingsManager: settings });
      return manager.resolve(async () => "skip");
    };

    const disabled = setPackageEntryDisabled(configured, true);
    const disabledPaths = await resolve(disabled);
    assert.equal(disabledPaths.extensions.find((resource) => resource.path.endsWith("extensions/index.js"))?.enabled, false);
    assert.equal(disabledPaths.skills.find((resource) => resource.path.endsWith("skills/example/SKILL.md"))?.enabled, false);

    const restoredPaths = await resolve(setPackageEntryDisabled(disabled, false));
    assert.equal(restoredPaths.extensions.find((resource) => resource.path.endsWith("extensions/index.js"))?.enabled, true);
    assert.equal(restoredPaths.skills.find((resource) => resource.path.endsWith("skills/example/SKILL.md"))?.enabled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes a redundant project override when setting the global state", () => {
  const globalSettings = {
    packages: ["npm:enabled", { source: "npm:disabled", extensions: [], skills: [], prompts: [], themes: [] }],
  };
  const projectSettings = {};
  const manager = {
    getGlobalSettings: () => structuredClone(globalSettings),
    getProjectSettings: () => structuredClone(projectSettings),
    updateProjectSettings: (_field, update) => update(projectSettings),
  };

  setPluginOverride(manager, "npm:enabled", "enabled");
  assert.deepEqual(getPluginOverrides(manager), {});
  setPluginOverride(manager, "npm:disabled", "disabled");
  assert.deepEqual(getPluginOverrides(manager), {});
  setPluginOverride(manager, "npm:enabled", "disabled");
  assert.deepEqual(getPluginOverrides(manager), { "npm:enabled": "disabled" });
});

test("keeps a disabled plugin narrowed when enabling one skill", () => {
  const globalSettings = {
    packages: [{ source: "npm:disabled", extensions: [], skills: [], prompts: [], themes: [] }],
  };
  const projectSettings = {};
  const manager = {
    getGlobalSettings: () => structuredClone(globalSettings),
    getProjectSettings: () => structuredClone(projectSettings),
    getPackages: () => [...globalSettings.packages],
    setPackages: (packages) => { globalSettings.packages = packages; },
  };
  const effective = createPluginOverrideSettingsManager(manager);
  const resourceKey = "skills/example/SKILL.md";

  setGlobalPluginSkillFilter(manager, "npm:disabled", resourceKey, "enabled");
  assert.deepEqual(effective.getGlobalSettings().packages, [{
    source: "npm:disabled",
    extensions: [],
    skills: ["!**", `+${resourceKey}`],
    prompts: [],
    themes: [],
  }]);
});

test("applies project plugin skill overrides through package filters", () => {
  const globalSettings = { packages: ["npm:tool"] };
  const projectSettings = {};
  const manager = {
    getGlobalSettings: () => structuredClone(globalSettings),
    getProjectSettings: () => structuredClone(projectSettings),
    updateProjectSettings: (_field, update) => update(projectSettings),
    getPackages: () => [...globalSettings.packages],
  };
  const effective = createPluginOverrideSettingsManager(manager);
  const resourceKey = "skills/example/SKILL.md";

  setPluginSkillOverride(manager, "npm:tool", resourceKey, "disabled");
  assert.deepEqual(getPluginSkillOverrides(manager), {
    "npm:tool": { [resourceKey]: "disabled" },
  });
  assert.deepEqual(effective.getGlobalSettings().packages, [{
    source: "npm:tool",
    skills: [`-${resourceKey}`],
  }]);
  assert.deepEqual(globalSettings.packages, ["npm:tool"]);

  clearPluginSkillOverride(manager, "npm:tool", resourceKey);
  assert.deepEqual(getPluginSkillOverrides(manager), {});
  assert.deepEqual(effective.getGlobalSettings().packages, ["npm:tool"]);
});

test("installed-path copy uses the shared clipboard helper with fallback", async () => {
  const src = await readFile(new URL("./PluginsConfig.tsx", import.meta.url), "utf8");
  assert.match(src, /import \{ copyText \} from "@\/lib\/clipboard";/);
  assert.match(src, /copyText\(pkg\.installedPath \?\? ""\)/);
  assert.match(src, /setCopyFailed\(true\)/);
  assert.ok(!/navigator\.clipboard\.writeText/.test(src), "raw clipboard without fallback must not remain");
});


test("deferred plugin load callback ignores a response after peer/view owner changes", async () => {
  const oldOwner = { generation: 1, cwd: "/repo", peer: "debian", viewScope: "global" };
  let current = { ...oldOwner };
  let resolve;
  const deferred = new Promise((done) => { resolve = done; });
  const callback = deferred.then((value) => isPluginOwnerCurrent(oldOwner, current) ? value : "stale");
  current = { ...oldOwner, generation: 2, peer: "air" };
  resolve("old response");
  assert.equal(await callback, "stale");
});


test("deferred plugin action callback cannot write after owner changes", async () => {
  const oldOwner = { generation: 4, cwd: "/repo", peer: "debian", viewScope: "project" };
  let current = { ...oldOwner };
  let resolve;
  const deferred = new Promise((done) => { resolve = done; });
  const callback = deferred.then((value) => isPluginOwnerCurrent(oldOwner, current) ? value : "stale");
  current = { ...oldOwner, generation: 5, cwd: "/other" };
  resolve("old action response");
  assert.equal(await callback, "stale");
});


class ReactDomNodeShim {
  constructor(ownerDocument, nodeName = "div") {
    this.ownerDocument = ownerDocument;
    this.nodeName = nodeName.toUpperCase();
    this.tagName = this.nodeName;
    this.nodeType = 1;
    this.nodeValue = null;
    this.childNodes = [];
    this.children = this.childNodes;
    this.parentNode = null;
    this.style = {};
    this.attributes = {};
    this.namespaceURI = "http://www.w3.org/1999/xhtml";
  }
  appendChild(node) { this.childNodes.push(node); node.parentNode = this; return node; }
  insertBefore(node, before) {
    const index = this.childNodes.indexOf(before);
    if (index < 0) return this.appendChild(node);
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener() {}
  removeEventListener() {}
  contains(node) { return node === this || this.childNodes.some((child) => child.contains?.(node)); }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  focus() {}
}

class ReactDomTextShim {
  constructor(ownerDocument, value) {
    this.ownerDocument = ownerDocument;
    this.nodeType = 3;
    this.nodeValue = value;
    this.parentNode = null;
  }
}

class ReactDomDocumentShim {
  constructor() {
    this.nodeType = 9;
    this.defaultView = globalThis.window;
    this.documentElement = new ReactDomNodeShim(this, "html");
    this.body = new ReactDomNodeShim(this, "body");
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }
  createElement(name) { return new ReactDomNodeShim(this, name); }
  createElementNS(_namespace, name) { return new ReactDomNodeShim(this, name); }
  createTextNode(value) { return new ReactDomTextShim(this, value); }
  addEventListener() {}
  removeEventListener() {}
  getElementById() { return null; }
}

class ReactDomIFrameShim extends ReactDomNodeShim {}

function installReactDomShim() {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  };
  globalThis.window = {};
  globalThis.window.HTMLIFrameElement = ReactDomIFrameShim;
  globalThis.window.HTMLElement = ReactDomNodeShim;
  globalThis.window.Node = ReactDomNodeShim;
  globalThis.window.Document = ReactDomDocumentShim;
  globalThis.window.location = { protocol: "http:" };
  globalThis.document = new ReactDomDocumentShim();
  globalThis.window.document = globalThis.document;
  globalThis.window.window = globalThis.window;
  globalThis.window.self = globalThis.window;
  globalThis.window.top = globalThis.window;
  globalThis.window.parent = globalThis.window;
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "node" },
    configurable: true,
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return previous;
}

function restoreReactDomShim(previous) {
  if (previous.window === undefined) delete globalThis.window;
  else globalThis.window = previous.window;
  if (previous.document === undefined) delete globalThis.document;
  else globalThis.document = previous.document;
  if (previous.fetch === undefined) delete globalThis.fetch;
  else globalThis.fetch = previous.fetch;
  if (previous.actEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  else globalThis.IS_REACT_ACT_ENVIRONMENT = previous.actEnvironment;
  if (previous.navigator) Object.defineProperty(globalThis, "navigator", previous.navigator);
  else delete globalThis.navigator;
}

test("mounted plugin load effect refetches scope/cwd and drops each older response", async () => {
  const previous = installReactDomShim();
  const requests = [];
  const commits = [];
  globalThis.fetch = (url) => new Promise((resolve) => {
    requests.push({ url: String(url), resolve });
  });

  function Probe({ cwd, viewScope, peer, onCommit }) {
    const ownerRef = React.useRef({ cwd, peer, viewScope, generation: 0 });
    const loadSeqRef = React.useRef(0);
    if (ownerRef.current.cwd !== cwd || ownerRef.current.peer !== peer || ownerRef.current.viewScope !== viewScope) {
      ownerRef.current = {
        cwd,
        peer,
        viewScope,
        generation: ownerRef.current.generation + 1,
      };
      loadSeqRef.current += 1;
    }
    const loadPlugins = React.useCallback(async () => {
      const owner = ownerRef.current;
      const loadSeq = ++loadSeqRef.current;
      const response = await fetch(`/api/remote/plugins?cwd=${encodeURIComponent(owner.cwd)}&scope=${owner.viewScope}&peer=${owner.peer}`);
      const next = await response.json();
      if (!isPluginOwnerCurrent(owner, ownerRef.current) || loadSeq !== loadSeqRef.current) return;
      onCommit(next);
    }, [onCommit]);
    usePluginLoadEffect(loadPlugins, peer, 0, cwd, viewScope);
    return null;
  }

  let root;
  try {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const onCommit = (value) => commits.push(value);

    await React.act(async () => {
      root.render(React.createElement(Probe, { cwd: "/repo", viewScope: "global", peer: "debian", onCommit }));
    });
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /cwd=%2Frepo&scope=global/);

    await React.act(async () => {
      root.render(React.createElement(Probe, { cwd: "/repo", viewScope: "project", peer: "debian", onCommit }));
    });
    assert.equal(requests.length, 2);
    assert.match(requests[1].url, /cwd=%2Frepo&scope=project/);
    requests[0].resolve({ ok: true, status: 200, json: async () => ({ cwd: "/repo", scope: "global" }) });
    await React.act(async () => {});
    assert.deepEqual(commits, []);

    await React.act(async () => {
      root.render(React.createElement(Probe, { cwd: "/other", viewScope: "project", peer: "debian", onCommit }));
    });
    assert.equal(requests.length, 3);
    assert.match(requests[2].url, /cwd=%2Fother&scope=project/);
    requests[1].resolve({ ok: true, status: 200, json: async () => ({ cwd: "/repo", scope: "project" }) });
    await React.act(async () => {});
    assert.deepEqual(commits, []);
    requests[2].resolve({ ok: true, status: 200, json: async () => ({ cwd: "/other", scope: "project" }) });
    await React.act(async () => {});
    assert.deepEqual(commits, [{ cwd: "/other", scope: "project" }]);
  } finally {
    if (root) await React.act(async () => { root.unmount(); });
    restoreReactDomShim(previous);
  }
});


test("package mutations reject an old revision or trust decision", () => {
  const owner = { generation: 1, cwd: "/repo", peer: "air", viewScope: "project", revision: 4, trustKey: "trusted" };
  assert.equal(isPluginOwnerCurrent(owner, owner), true);
  assert.equal(isPluginOwnerCurrent(owner, { ...owner, revision: 5 }), false);
  assert.equal(isPluginOwnerCurrent(owner, { ...owner, trustKey: "untrusted" }), false);
});

test("package source groups keep their counts without a bulk switch", async () => {
  const source = await readFile(new URL("./PluginsConfig.tsx", import.meta.url), "utf8");
  assert.match(source, /group\.packages\.length/);
  assert.doesNotMatch(source, /set_packages_enabled|ConfigSidebarGroupSwitch|ConfigSidebarGroupStatus|setGroupPackages|bulkGroup/);
  assert.match(source, /<ConfigSwitch[\s\S]*onChange=\{\(\) => \{/);
});
