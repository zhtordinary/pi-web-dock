import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { loadSkillPolicyCatalog, loadSkillsPreservingDuplicates, loadSkillsWithInstallInfo } = await jiti.import("./skills-service.ts");
const { ProjectTrustStore } = await jiti.import("@earendil-works/pi-coding-agent");
const { writeSkillStateSettings } = await jiti.import("./skill-state-settings.ts");
const { setProjectSkillInvocationMode } = await jiti.import("./skill-policy.ts");

test("keeps same-named skills from separate resources", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-reader-skills-"));
  const first = join(root, "first", "SKILL.md");
  const second = join(root, "second", "SKILL.md");
  try {
    mkdirSync(join(root, "first"));
    mkdirSync(join(root, "second"));
    const content = (description) => "---\nname: same-skill\ndescription: " + description + "\n---\n";
    writeFileSync(first, content("first resource"));
    writeFileSync(second, content("second resource"));

    const loaded = loadSkillsPreservingDuplicates({
      cwd: root,
      agentDir: root,
      skillPaths: [first, second],
    });

    assert.equal(loaded.diagnostics.length, 0);
    assert.deepEqual(loaded.skills.map((skill) => skill.name), ["same-skill", "same-skill"]);
    assert.deepEqual(loaded.skills.map((skill) => skill.filePath), [first, second]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeGlobalSettings(agentDir, settings) {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
}

async function readGlobalCatalog(cwd, agentDir, viewScope = "global") {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await loadSkillPolicyCatalog(cwd, viewScope);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

async function readService(cwd, agentDir, viewScope = "global") {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await loadSkillsWithInstallInfo(cwd, viewScope);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

for (const [kind, path] of [
  ["device namespace", "\\\\?\\C:\\fixture\\SKILL.md"],
  ["malformed file URL", "file:///%ZZ"],
  ["encoded NUL file URL", "file:///invalid%00/SKILL.md"],
  ["NUL path", "/fixture/invalid\0/SKILL.md"],
]) {
  test(`failed legacy Skill migration preserves the entire settings file: ${kind}`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "pi-reader-skill-migration-atomic-"));
    t.diagnostic(`resource-policy fixture: ${root}`);
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const settingsPath = join(cwd, ".pi", "settings.json");
    try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeGlobalSettings(agentDir, {});
      new ProjectTrustStore(agentDir).set(cwd, true);
      const original = JSON.stringify({
        piWebPluginSkillOverrides: { "npm:fixture@1.0.0": { "skills/demo/SKILL.md": "disabled" } },
        piWebProjectSkillStates: { [`top-level:${path}`]: "disabled" },
        unrelated: { keep: true },
      }, null, 2) + "\n";
      writeFileSync(settingsPath, original);

      await assert.rejects(readService(cwd, agentDir, "project"), /cannot safely override/);
      assert.equal(readFileSync(settingsPath, "utf8"), original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const [kind, legacy, parts] of [
  ["literal", "!**/.pi/agent/skills/same/SKILL.md", [".pi", "agent", "skills", "same", "SKILL.md"]],
  ["character class", "!**/team[1]/skill/SKILL.md", ["team1", "skill", "SKILL.md"]],
]) for (const scope of ["project", "global"]) {
  test(`ambiguous ${scope} ${kind} legacy glob stops both migration stages before disk writes`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "pi-reader-skill-migration-ambiguous-"));
    t.diagnostic(`resource-policy fixture: ${root}`);
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const settingsPath = join(cwd, ".pi", "settings.json");
    const globalPath = join(agentDir, "settings.json");
    const shadow = join(root, "shadow", ...parts);
    try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeGlobalSettings(agentDir, scope === "global" ? { skills: [legacy] } : {});
      new ProjectTrustStore(agentDir).set(cwd, true);
      const original = JSON.stringify({
        ...(scope === "project" ? { skills: [legacy] } : {}),
        piWebPluginSkillOverrides: { "npm:fixture@1.0.0": { "skills/demo/SKILL.md": "disabled" } },
        piWebProjectSkillStates: { [`top-level:${shadow}`]: "enabled" },
        unrelated: { keep: true },
      }, null, 2) + "\n";
      writeFileSync(settingsPath, original);
      const globalBefore = readFileSync(globalPath, "utf8");

      await assert.rejects(readService(cwd, agentDir, "project"), /ambiguous legacy resource glob/i);
      assert.equal(readFileSync(settingsPath, "utf8"), original);
      assert.equal(readFileSync(globalPath, "utf8"), globalBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("successful legacy Skill migration preserves both stages and unrelated settings", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-reader-skill-migration-complete-"));
  t.diagnostic(`resource-policy fixture: ${root}`);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const settingsPath = join(cwd, ".pi", "settings.json");
  const skillPath = join(agentDir, "skills", "sample", "SKILL.md");
  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, "---\nname: sample\ndescription: sample\n---\n");
    writeGlobalSettings(agentDir, { skills: [skillPath] });
    new ProjectTrustStore(agentDir).set(cwd, true);
    writeFileSync(settingsPath, JSON.stringify({
      piWebPluginSkillOverrides: { "npm:fixture@1.0.0": { "skills/demo/SKILL.md": "disabled" } },
      piWebProjectSkillStates: { [`top-level:${skillPath}`]: "disabled" },
      unrelated: { keep: true },
    }, null, 2) + "\n");

    const result = await readService(cwd, agentDir, "project");
    assert.equal(result.skills.find((skill) => skill.filePath === skillPath)?.policy.resourceState, "disabled");
    const after = readFileSync(settingsPath, "utf8");
    const saved = JSON.parse(after);
    assert.deepEqual(saved.packages, [{ source: "npm:fixture@1.0.0", autoload: false, skills: ["-skills/demo/SKILL.md"] }]);
    assert.deepEqual(saved.unrelated, { keep: true });
    assert.equal(Object.hasOwn(saved, "piWebPluginSkillOverrides"), false);
    assert.equal(Object.hasOwn(saved, "piWebProjectSkillStates"), false);
    await readService(cwd, agentDir, "project");
    assert.equal(readFileSync(settingsPath, "utf8"), after);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project Skill modes follow the same relative resource across project roots", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-reader-project-skill-policy-"));
  const agentDir = join(root, "agent"), projects = [join(root, "mini", "drawing"), join(root, "air", "drawing")];
  const portableKey = "top-level:project:.agents/skills/demo/SKILL.md";
  try {
    writeGlobalSettings(agentDir, {});
    for (const cwd of projects) {
      const skillPath = join(cwd, ".agents/skills/demo/SKILL.md");
      mkdirSync(dirname(skillPath), { recursive: true });
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(skillPath, "---\nname: demo\ndescription: demo\n---\ndemo\n");
      writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify({
        skills: ["../.agents/skills/demo/SKILL.md"],
        piWebProjectSkillInvocationModes: { [portableKey]: "explicit-only" },
      }));
      new ProjectTrustStore(agentDir).set(cwd, true);
    }
    for (const cwd of projects) {
      const catalog = await readService(cwd, agentDir, "project");
      const skill = catalog.skills.find((entry) => entry.name === "demo");
      assert.equal(skill?.sourceInfo.scope, "project");
      assert.equal(skill.invocationMode, "explicit-only");
      assert.equal(skill.promptVisible, false);
      assert.equal(skill.commandUsable, true);
      assert.deepEqual(catalog.stalePolicies, []);
    }
    const first = await readService(projects[0], agentDir, "project");
    const key = first.skills.find((skill) => skill.name === "demo").policyKey;
    await setProjectSkillInvocationMode(projects[0], agentDir, key, "automatic");
    const saved = readFileSync(join(projects[0], ".pi/settings.json"), "utf8");
    assert.deepEqual(JSON.parse(saved).piWebProjectSkillInvocationModes, { [portableKey]: "automatic" });
    writeFileSync(join(projects[1], ".pi/settings.json"), saved);
    const synced = await readService(projects[1], agentDir, "project");
    assert.equal(synced.skills.find((skill) => skill.name === "demo")?.invocationMode, "automatic");
    assert.deepEqual(synced.stalePolicies, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("portable local package modes match catalog keys without stale aliases or name fallback", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-reader-portable-policy-"));
  t.diagnostic(`resource-policy fixture: ${root}`);
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  const packageRoot = join(root, "MixedPackage"), skillPath = join(packageRoot, "skills/demo/SKILL.md");
  const portableKey = "package:local:~/MixedPackage:skills/demo/SKILL.md";
  const legacyKey = `package:local:${packageRoot}:skills/demo/SKILL.md`;
  const canonicalRoot = process.platform === "win32" ? packageRoot.toLowerCase() : packageRoot;
  const canonicalKey = `package:local:${canonicalRoot}:skills/demo/SKILL.md`;
  const otherResource = "package:local:~/MixedPackage:skills/other/SKILL.md";
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = root;
    if (process.platform === "win32") process.env.USERPROFILE = root;
    mkdirSync(dirname(skillPath), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(skillPath, "---\nname: demo\ndescription: demo\n---\ndemo\n");
    writeGlobalSettings(agentDir, { packages: ["~/MixedPackage"], piWebGlobalSkillInvocationModes: {
      [legacyKey]: "automatic", [portableKey]: "explicit-only", [otherResource]: "automatic",
    } });
    new ProjectTrustStore(agentDir).set(cwd, true);
    for (const viewScope of ["global", "project"]) {
      const catalog = await readGlobalCatalog(cwd, agentDir, viewScope);
      const skill = catalog.skills.find((entry) => entry.filePath === skillPath);
      assert.equal(skill?.policyKey, canonicalKey);
      assert.equal(skill.invocationMode, "explicit-only");
      assert.equal(skill.invocationModeSource, viewScope === "global" ? "explicit" : "inherited");
      assert.equal(skill.promptVisible, false);
      assert.equal(skill.commandUsable, true);
      assert.deepEqual(catalog.stale.map((entry) => entry.policyKey), viewScope === "global"
        ? [`package:local:${canonicalRoot}:skills/other/SKILL.md`] : []);
    }
    const writable = (await readService(cwd, agentDir, "global")).skills.find((entry) => entry.filePath === skillPath);
    await writeSkillStateSettings(cwd, agentDir, "global", [{ skill: writable, state: "automatic" }]);
    const savedModes = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).piWebGlobalSkillInvocationModes;
    assert.equal(savedModes[portableKey], "automatic");
    assert.equal(Object.hasOwn(savedModes, legacyKey), false);
    assert.equal(savedModes[otherResource], "automatic");

    writeGlobalSettings(agentDir, { packages: ["~/MixedPackage"], piWebGlobalSkillInvocationModes: { [legacyKey]: "explicit-only" } });
    const legacyCatalog = await readGlobalCatalog(cwd, agentDir);
    assert.equal(legacyCatalog.skills.find((entry) => entry.filePath === skillPath)?.invocationMode, "explicit-only");
    assert.deepEqual(legacyCatalog.stale, []);
    writeGlobalSettings(agentDir, { packages: [], piWebGlobalSkillInvocationModes: { [portableKey]: "explicit-only" } });
    const removed = await readGlobalCatalog(cwd, agentDir);
    assert.equal(removed.skills.some((entry) => entry.filePath === skillPath), false);
    assert.deepEqual(removed.stale.map((entry) => [entry.policyKey, entry.availability]), [[canonicalKey, "unavailable"]]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(root, { recursive: true, force: true });
  }
});

test("project classification follows effective use states through writes and inheritance", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-reader-skill-project-states-"));
  const cwd = join(root, "project"), agentDir = join(root, "agent"), packageRoot = join(root, "package");
  const paths = [];
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    for (const origin of ["top-level", "package"]) {
      for (const manual of [false, true]) {
        const name = `${origin}-${manual ? "manual" : "automatic"}`;
        const filePath = join(origin === "package" ? packageRoot : agentDir, "skills", name, "SKILL.md");
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name}\n${manual ? "disable-model-invocation: true\n" : ""}---\n${name}\n`);
        paths.push(filePath);
      }
    }
    writeGlobalSettings(agentDir, { packages: [packageRoot] });
    new ProjectTrustStore(agentDir).set(cwd, true);
    const initial = await readService(cwd, agentDir, "project");
    const getSkill = async (filePath, scope = "project") => (await readService(cwd, agentDir, scope)).skills.find((skill) => skill.filePath === filePath);
    for (const filePath of paths) {
      const skill = initial.skills.find((entry) => entry.filePath === filePath);
      assert.ok(skill, filePath);
      assert.equal(skill.projectStatus, "matching");
      const originalFile = readFileSync(filePath, "utf8");
      const baselineMode = skill.invocationMode;
      const oppositeMode = baselineMode === "automatic" ? "explicit-only" : "automatic";
      await writeSkillStateSettings(cwd, agentDir, "project", [{ skill, state: oppositeMode }]);
      const overridden = await getSkill(filePath);
      assert.equal(overridden.invocationMode, oppositeMode);
      assert.equal(overridden.policy.resourceState, "enabled");
      assert.equal(overridden.projectStatus, "different", `${skill.name}: invocation-only override`);
      assert.equal((await getSkill(filePath, "global")).invocationMode, baselineMode);

      await writeSkillStateSettings(cwd, agentDir, "project", [{ skill, state: "inherit" }]);
      const inherited = await getSkill(filePath);
      assert.equal(inherited.invocationMode, baselineMode);
      assert.equal(inherited.resourceOverride, "inherit");
      assert.equal(inherited.projectStatus, "matching");
      await writeSkillStateSettings(cwd, agentDir, "project", [{ skill, state: baselineMode }]);
      assert.equal((await getSkill(filePath)).projectStatus, "matching", "same-value explicit override");
      await writeSkillStateSettings(cwd, agentDir, "global", [{ skill, state: oppositeMode }]);
      assert.equal((await getSkill(filePath)).projectStatus, "different", "global invocation changes are compared independently");
      await writeSkillStateSettings(cwd, agentDir, "project", [{ skill, state: oppositeMode }]);
      assert.equal((await getSkill(filePath)).projectStatus, "matching");
      await writeSkillStateSettings(cwd, agentDir, "global", [{ skill, state: baselineMode }]);
      assert.equal((await getSkill(filePath)).projectStatus, "different");

      await writeSkillStateSettings(cwd, agentDir, "project", [{ skill, state: oppositeMode }]);
      await writeSkillStateSettings(cwd, agentDir, "project", [{ skill, state: "disabled" }]);
      const disabled = await getSkill(filePath);
      assert.equal(disabled.resourceState, "disabled");
      assert.equal(disabled.projectStatus, "different", "project disabled while global enabled");
      await writeSkillStateSettings(cwd, agentDir, "global", [{ skill, state: "disabled" }]);
      const bothDisabled = await getSkill(filePath);
      assert.equal(bothDisabled.projectStatus, "matching", "disabled states match despite different saved invocation modes");
      assert.equal(bothDisabled.invocationMode, oppositeMode);
      await writeSkillStateSettings(cwd, agentDir, "project", [{ skill, state: "inherit" }]);
      const inheritedDisabled = await getSkill(filePath);
      assert.equal(inheritedDisabled.resourceState, "disabled");
      assert.equal(inheritedDisabled.projectStatus, "matching");
      assert.equal(readFileSync(filePath, "utf8"), originalFile);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("service follows SDK top-level/package precedence and keeps the winning source identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-reader-skill-precedence-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const packageRoot = join(root, "package");
  const userPath = join(agentDir, "skills", "same", "SKILL.md");
  const packagePath = join(packageRoot, "skills", "same", "SKILL.md");
  const projectPath = join(cwd, ".pi", "skills", "same", "SKILL.md");
  try {
    const skill = (body) => `---\nname: same\ndescription: same\n---\n${body}\n`;
    for (const path of [userPath, packagePath, projectPath]) {
      mkdirSync(dirname(path), { recursive: true });
    }
    writeFileSync(userPath, skill("USER"));
    writeFileSync(packagePath, skill("PACKAGE"));
    writeFileSync(projectPath, skill("PROJECT-TOP-LEVEL"));
    writeGlobalSettings(agentDir, { skills: [userPath], packages: [packageRoot] });
    new ProjectTrustStore(agentDir).set(cwd, true);

    const global = await readService(cwd, agentDir, "global");
    assert.deepEqual(global.skills.filter((entry) => entry.name === "same").map((entry) => entry.filePath), [userPath]);
    assert.ok(global.diagnostics.some((item) => item.type === "collision" && item.collision?.winnerPath === userPath));

    const project = await readService(cwd, agentDir, "project");
    assert.deepEqual(project.skills.filter((entry) => entry.name === "same").map((entry) => entry.filePath), [projectPath]);
    assert.equal(project.skills.find((entry) => entry.name === "same")?.sourceInfo?.scope, "project");

    rmSync(projectPath);
    const userFallback = await readGlobalCatalog(cwd, agentDir, "project");
    assert.deepEqual(userFallback.skills.filter((entry) => entry.name === "same").map((entry) => entry.filePath), [userPath]);
    assert.equal(userFallback.skills.find((entry) => entry.name === "same")?.sourceInfo?.scope, "user");

    rmSync(userPath);
    const packageFallback = await readGlobalCatalog(cwd, agentDir, "project");
    const packageSkill = packageFallback.skills.find((entry) => entry.name === "same");
    assert.equal(packageSkill?.filePath, packagePath);
    assert.equal(packageSkill?.sourceInfo?.origin, "package");
    assert.ok(packageSkill?.policyKey?.startsWith("package:"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("service keeps exact policy keys unavailable across rename, delete, and package removal", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-reader-skill-lifecycle-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const oldPath = join(agentDir, "skills", "same", "SKILL.md");
  const renamedPath = join(agentDir, "skills", "renamed", "SKILL.md");
  try {
    mkdirSync(dirname(oldPath), { recursive: true });
    writeFileSync(oldPath, "---\nname: same\ndescription: same\n---\nold\n");
    writeGlobalSettings(agentDir, { skills: [oldPath] });
    const initial = await readGlobalCatalog(cwd, agentDir);
    const oldSkill = initial.skills.find((entry) => entry.name === "same");
    assert.ok(oldSkill?.policyKey);
    const oldKey = oldSkill.policyKey;

    writeGlobalSettings(agentDir, {
      skills: [oldPath],
      piWebGlobalSkillInvocationModes: { [oldKey]: "explicit-only" },
    });
    const explicit = await readGlobalCatalog(cwd, agentDir);
    assert.equal(explicit.skills.find((entry) => entry.name === "same")?.invocationMode, "explicit-only");

    mkdirSync(dirname(renamedPath), { recursive: true });
    renameSync(oldPath, renamedPath);
    writeGlobalSettings(agentDir, {
      skills: [renamedPath],
      piWebGlobalSkillInvocationModes: { [oldKey]: "explicit-only" },
    });
    const renamed = await readGlobalCatalog(cwd, agentDir);
    const renamedSkill = renamed.skills.find((entry) => entry.name === "same");
    assert.ok(renamedSkill?.policyKey);
    assert.notEqual(renamedSkill.policyKey, oldKey);
    assert.equal(renamedSkill.invocationMode, "automatic");
    assert.equal(renamed.stale.find((entry) => entry.policyKey === oldKey)?.availability, "unavailable");

    const renamedKey = renamedSkill.policyKey;
    rmSync(renamedPath);
    writeGlobalSettings(agentDir, {
      skills: [renamedPath],
      piWebGlobalSkillInvocationModes: {
        [oldKey]: "explicit-only",
        [renamedKey]: "automatic",
      },
    });
    const deleted = await readGlobalCatalog(cwd, agentDir);
    assert.equal(deleted.skills.some((entry) => entry.policyKey === renamedKey), false);
    assert.equal(deleted.stale.find((entry) => entry.policyKey === renamedKey)?.availability, "unavailable");

    const packageRoot = join(root, "package");
    const packagePath = join(packageRoot, "skills", "same", "SKILL.md");
    mkdirSync(dirname(packagePath), { recursive: true });
    writeFileSync(packagePath, "---\nname: same\ndescription: package\n---\npackage\n");
    writeGlobalSettings(agentDir, { packages: [packageRoot] });
    const packageCatalog = await readGlobalCatalog(cwd, agentDir);
    const packageSkill = packageCatalog.skills.find((entry) => entry.name === "same");
    assert.equal(packageSkill?.sourceInfo?.origin, "package");
    assert.ok(packageSkill?.policyKey);
    const packageKey = packageSkill.policyKey;

    const newTopLevelPath = join(agentDir, "skills", "same-new", "SKILL.md");
    mkdirSync(dirname(newTopLevelPath), { recursive: true });
    writeFileSync(newTopLevelPath, "---\nname: same\ndescription: new\n---\nnew\n");
    writeGlobalSettings(agentDir, {
      packages: [],
      skills: [newTopLevelPath],
      piWebGlobalSkillInvocationModes: { [packageKey]: "explicit-only" },
    });
    const removed = await readGlobalCatalog(cwd, agentDir);
    const replacement = removed.skills.find((entry) => entry.name === "same");
    assert.ok(replacement?.policyKey);
    assert.notEqual(replacement.policyKey, packageKey);
    assert.equal(replacement.invocationMode, "automatic");
    assert.equal(removed.stale.find((entry) => entry.policyKey === packageKey)?.availability, "unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
