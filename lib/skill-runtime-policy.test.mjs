import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  SkillRuntimeRouteError,
  SkillRuntimeTracker,
  filterRuntimeSkills,
  getSkillPolicyKey,
  resolveRuntimeSkillPolicy,
  runtimeSkillCommandEntries,
  routeSkillCommand,
} = await jiti.import("./skill-runtime-policy.ts");

async function withSkill(markdown, callback) {
  const root = await mkdtemp(join(tmpdir(), "reader-skill-runtime-"));
  const filePath = join(root, "SKILL.md");
  await writeFile(filePath, markdown, "utf8");
  const declaresManualInvocation = markdown.includes("disable-model-invocation: true");
  const skill = {
    name: "sample",
    description: "Sample skill",
    filePath,
    baseDir: root,
    // Mirror Pi 1.2's parsed SDK field; policy receives metadata after the
    // loader has read frontmatter and must not read the file itself.
    disableModelInvocation: declaresManualInvocation,
  };
  try {
    return await callback(skill);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("policy keeps enabled automatic and explicit-only orthogonal", async () => {
  await withSkill("---\nname: sample\n---\nInstructions\n", async (skill) => {
    const automatic = resolveRuntimeSkillPolicy(skill, { scope: "global" });
    assert.equal(automatic.resourceState, "enabled");
    assert.equal(automatic.invocationMode, "automatic");
    assert.equal(automatic.runtimeLoaded, true);
    assert.equal(automatic.promptVisible, true);
    assert.equal(automatic.commandUsable, true);

    const key = getSkillPolicyKey({ filePath: skill.filePath });
    const explicit = resolveRuntimeSkillPolicy(skill, {
      scope: "global",
      entries: [{ path: skill.filePath, key }],
      globalInvocationModes: { [key]: "explicit-only" },
    });
    assert.equal(explicit.resourceState, "enabled");
    assert.equal(explicit.invocationMode, "explicit-only");
    assert.equal(explicit.runtimeLoaded, true);
    assert.equal(explicit.promptVisible, false);
    assert.equal(explicit.commandUsable, true);
  });
});

test("frontmatter manual marker is explicit-only while the resource remains loaded", async () => {
  await withSkill("---\ndisable-model-invocation: true\n---\nManual instructions\n", async (skill) => {
    const policy = resolveRuntimeSkillPolicy(skill, { scope: "project" });
    assert.equal(policy.invocationMode, "explicit-only");
    assert.equal(policy.invocationModeSource, "frontmatter");
    assert.equal(policy.resourceState, "enabled");
    assert.equal(policy.runtimeLoaded, true);
    assert.equal(policy.commandUsable, true);
    assert.equal(policy.promptVisible, false);
  });
});

test("project policy applies a disabled global parent cap", async () => {
  await withSkill("Instructions\n", async (skill) => {
    const key = getSkillPolicyKey({ filePath: skill.filePath });
    const policy = resolveRuntimeSkillPolicy(skill, {
      scope: "project",
      entries: [{ path: skill.filePath, key, globalResourceState: "disabled", projectResourceState: "enabled" }],
    });
    assert.equal(policy.globalResourceState, "disabled");
    assert.equal(policy.projectResourceState, "enabled");
    assert.equal(policy.resourceState, "disabled");
    assert.equal(policy.runtimeLoaded, false);
    assert.equal(policy.commandUsable, false);
  });
});

test("project-only ownership does not inherit a residual global invocation mode for the same package key", async () => {
  await withSkill("Instructions\n", async (skill) => {
    const key = "package:fixture:skills/sample/SKILL.md";
    const projectSkill = {
      ...skill,
      sourceInfo: {
        source: "fixture",
        origin: "package",
        scope: "project",
        baseDir: skill.baseDir,
      },
      pluginResourceKey: "skills/sample/SKILL.md",
      policyKey: key,
    };
    const globalResidual = {
      key,
      scope: "user",
      globalInvocationMode: "explicit-only",
      globalResourceState: "enabled",
    };
    const policy = resolveRuntimeSkillPolicy(projectSkill, {
      scope: "project",
      catalogSkills: [projectSkill],
      entries: [globalResidual],
      globalInvocationModes: { [key]: "explicit-only" },
    });
    assert.equal(policy.invocationMode, "automatic");
    assert.equal(policy.invocationModeSource, "default");
    assert.equal(policy.globalInvocationMode, undefined);
    assert.equal(policy.projectInherited, undefined);
  });
});

test("global ownership still inherits its global invocation mode in a project view", async () => {
  await withSkill("Instructions\n", async (skill) => {
    const key = "package:fixture:skills/sample/SKILL.md";
    const globalSkill = {
      ...skill,
      sourceInfo: {
        source: "fixture",
        origin: "package",
        scope: "user",
        baseDir: skill.baseDir,
      },
      pluginResourceKey: "skills/sample/SKILL.md",
      policyKey: key,
    };
    const policy = resolveRuntimeSkillPolicy(globalSkill, {
      scope: "project",
      catalogSkills: [globalSkill],
      globalInvocationModes: { [key]: "explicit-only" },
    });
    assert.equal(policy.invocationMode, "explicit-only");
    assert.equal(policy.invocationModeSource, "inherited");
    assert.equal(policy.projectInherited, true);
  });
});

test("exact slash routing strips frontmatter and leaves complete instructions in the current turn", async () => {
  await withSkill("---\ntitle: Sample\n---\nDo the thing.\n", async (skill) => {
    const route = routeSkillCommand("/skill:sample src/file.ts", { skills: [skill] });
    assert.ok(route);
    assert.equal(route.args, "src/file.ts");
    assert.match(route.expandedText, new RegExp(`<skill name="sample"`));
    assert.match(route.expandedText, /Do the thing\./);
    assert.doesNotMatch(route.expandedText, /title: Sample/);
    assert.match(route.expandedText, /\n\nsrc\/file\.ts$/);
    assert.equal(route.policy.commandUsable, true);
  });
});

test("slash admission follows the SDK literal-space delimiter", async () => {
  await withSkill("Instructions\n", async (skill) => {
    assert.throws(
      () => routeSkillCommand("/skill:sample\targ", { skills: [skill] }),
      (error) => error instanceof SkillRuntimeRouteError && error.code === "unavailable",
    );
    const route = routeSkillCommand("/skill:sample  arg", { skills: [skill] });
    assert.equal(route.args, "arg");
  });
});

test("runtime-disabled child context closes filtering, command listing, and slash admission", async () => {
  await withSkill("Instructions\n", async (skill) => {
    const context = { runtimeSkillsEnabled: false, catalogSkills: [] };
    assert.deepEqual(filterRuntimeSkills([skill], context), []);
    assert.deepEqual(runtimeSkillCommandEntries([skill], context), []);
    assert.throws(
      () => routeSkillCommand("/skill:sample", { skills: [skill], context }),
      (error) => error instanceof SkillRuntimeRouteError && error.code === "unavailable",
    );
    context.runtimeCatalogAvailable = true;
    assert.deepEqual(filterRuntimeSkills([skill], context), []);
    assert.equal(context.runtimeSkillsEnabled, false);
  });
});

test("runtime catalog failure closes a capable child until the same context recovers", async () => {
  await withSkill("Instructions\n", async (skill) => {
    const context = {
      runtimeSkillsEnabled: true,
      requireRuntimeCatalog: true,
      runtimeCatalogAvailable: false,
      catalogSkills: [skill],
    };
    assert.deepEqual(filterRuntimeSkills([skill], context), []);
    assert.deepEqual(runtimeSkillCommandEntries([skill], context), []);
    assert.throws(
      () => routeSkillCommand("/skill:sample", { skills: [skill], context }),
      (error) => error instanceof SkillRuntimeRouteError && error.code === "unavailable",
    );

    context.runtimeCatalogAvailable = true;
    assert.equal(filterRuntimeSkills([skill], context).length, 1);
    assert.equal(runtimeSkillCommandEntries([skill], context).length, 1);
    assert.ok(routeSkillCommand("/skill:sample", { skills: [skill], context }));
    assert.equal(context.runtimeSkillsEnabled, true);
  });
});

test("disabled, stale, unavailable, ambiguous, and missing skills are rejected before expansion", async () => {
  await withSkill("Instructions\n", async (skill) => {
    const key = getSkillPolicyKey({ filePath: skill.filePath });
    const disabledContext = { entries: [{ path: skill.filePath, key, resourceState: "disabled" }] };
    assert.throws(
      () => routeSkillCommand("/skill:sample", { skills: [skill], context: disabledContext }),
      (error) => error instanceof SkillRuntimeRouteError && error.code === "disabled",
    );

    const staleContext = { entries: [{ path: skill.filePath, key, availability: "stale", staleReason: "resource-renamed" }] };
    assert.throws(
      () => routeSkillCommand("/skill:sample", { skills: [skill], context: staleContext }),
      (error) => error instanceof SkillRuntimeRouteError && error.code === "stale",
    );

    assert.throws(
      () => routeSkillCommand("/skill:missing", { skills: [skill] }),
      (error) => error instanceof SkillRuntimeRouteError && error.code === "unavailable",
    );
    assert.throws(
      () => routeSkillCommand("/skill:sample", { skills: [skill, { ...skill, filePath: `${skill.filePath}.copy` }] }),
      (error) => error instanceof SkillRuntimeRouteError && error.code === "ambiguous",
    );
  });
});

test("slash admission uses the live SDK list while consulting retained catalog policy", async () => {
  await withSkill("Instructions\n", async (skill) => {
    const key = getSkillPolicyKey({ filePath: skill.filePath });
    const retainedCatalog = { ...skill, policy: { policyKey: key, resourceState: "enabled", invocationMode: "explicit-only", availability: "available", runtimeLoaded: true, promptVisible: false, commandUsable: true, scope: "global" } };
    const explicit = routeSkillCommand("/skill:sample", {
      skills: [skill],
      context: { catalogSkills: [retainedCatalog] },
    });
    assert.equal(explicit.policy.invocationMode, "explicit-only");
    assert.equal(explicit.policy.promptVisible, false);
    assert.equal(explicit.policy.commandUsable, true);

    const legacyEnabled = resolveRuntimeSkillPolicy(skill, {
      catalogSkills: [retainedCatalog],
      entries: [{ path: skill.filePath, key, globalInvocationOverride: "enabled" }],
    });
    assert.equal(legacyEnabled.invocationMode, "automatic");
    assert.equal(legacyEnabled.invocationModeSource, "legacy");

    const projectGlobalAutomatic = resolveRuntimeSkillPolicy(skill, {
      scope: "project",
      catalogSkills: [retainedCatalog],
      globalInvocationModes: { [key]: "automatic" },
    });
    assert.equal(projectGlobalAutomatic.invocationMode, "automatic");
    assert.equal(projectGlobalAutomatic.invocationModeSource, "inherited");

    const disabledCatalog = { ...skill, policy: { policyKey: key, resourceState: "disabled", invocationMode: "automatic", availability: "available", runtimeLoaded: false, promptVisible: false, commandUsable: false, scope: "global" } };
    assert.throws(
      () => routeSkillCommand("/skill:sample", { skills: [], context: { catalogSkills: [disabledCatalog] } }),
      (error) => error instanceof SkillRuntimeRouteError && error.code === "disabled",
    );
  });
});

test("unreadable skill instructions are rejected before the SDK prompt is admitted", async () => {
  const skill = {
    name: "missing-body",
    description: "Missing body",
    filePath: "/tmp/reader-skill-runtime-does-not-exist/SKILL.md",
    baseDir: "/tmp/reader-skill-runtime-does-not-exist",
    disableModelInvocation: false,
  };
  assert.throws(
    () => routeSkillCommand("/skill:missing-body", { skills: [skill] }),
    (error) => error instanceof SkillRuntimeRouteError && error.code === "read-failed",
  );
});

test("tracker compares local baseline and cleans concurrent observations", async () => {
  await withSkill("Instructions\n", async (skill) => {
    const tracker = new SkillRuntimeTracker();
    const route = routeSkillCommand("/skill:sample", { skills: [skill] });
    const first = tracker.begin(route, "stable baseline");
    const second = tracker.begin(route, "stable baseline");
    assert.equal(tracker.snapshot().activeCount, 2);
    tracker.settle(first, "stable baseline");
    assert.equal(tracker.snapshot().last?.baselineUnchanged, true);
    tracker.settle(second, "changed baseline");
    assert.equal(tracker.snapshot().activeCount, 0);
    assert.equal(tracker.snapshot().last?.baselineUnchanged, false);
    assert.equal(tracker.snapshot().last?.bodySha256, route.bodySha256);
  });
});

test("tracker exposes a local baseline before the first dynamic invocation", () => {
  const tracker = new SkillRuntimeTracker();
  const evidence = tracker.snapshot("stable baseline");
  assert.equal(evidence.activeCount, 0);
  assert.equal(evidence.baseline.characters, "stable baseline".length);
  assert.equal(evidence.last, undefined);
});

test("package policy keys stay stable across installation paths, versions and git refs", () => {
  const root = "/tmp/reader-policy-ref-version-v4";
  const keyFor = (source, filePath = "/tmp/installation-v4/SKILL.md") => getSkillPolicyKey({
    pluginResourceKey: "skills/sample/SKILL.md",
    filePath,
    cwd: root,
    agentDir: join(root, "agent"),
    sourceInfo: { origin: "package", source },
  });
  for (const [source, updated] of [
    ["./local-plugin", "./local-plugin"],
    ["npm:sample-plugin@1.0.0", "npm:sample-plugin@2.0.0"],
    ["git:https://github.com/example/plugin@ref-v4", "git:https://github.com/example/plugin@ref-v5"],
  ]) {
    const key = keyFor(source);
    assert.match(key, /^package:.+:skills\/sample\/SKILL\.md$/);
    assert.equal(keyFor(updated, "/tmp/installation-v5/SKILL.md"), key);
    assert.notEqual(keyFor("npm:another-plugin@1.0.0"), key);
  }
});

test("read-only external source fixtures keep package identity and invocation semantics", async () => {
  // These are metadata/body fixtures derived from the installed package
  // sources audited for B. They intentionally do not read or modify those
  // external checkouts: the Debian harness supplies the real-source run.
  const fixtures = [
    {
      packageSource: "github.com/michael-denyer/pstack-claude",
      resourceKey: "skills/poteto-mode/SKILL.md",
      frontmatter: "---\nname: poteto-mode\n---\n",
      expectedMode: "automatic",
    },
    ...[
      "architect",
      "how",
      "interrogate",
    ].map((name) => ({
      packageSource: "github.com/michael-denyer/pstack-claude",
      resourceKey: `skills/${name}/SKILL.md`,
      frontmatter: `---\nname: ${name}\n---\n`,
      expectedMode: "automatic",
    })),
    ...[
      "dbs",
      "dbs-goal",
      "dbs-good-question",
    ].map((name) => ({
      packageSource: "github.com/dontbesilent2025/dbskill",
      resourceKey: `skills/${name}/SKILL.md`,
      frontmatter: `---\nname: ${name}\n---\n`,
      expectedMode: "explicit-only",
    })),
  ];
  // The installed dbskill files do not declare the frontmatter marker; their
  // explicit-only expectation is the Reader policy map, kept separate from
  // the source fixture so the test does not pretend the package added it.
  for (const fixture of fixtures) {
    await withSkill(`${fixture.frontmatter}${fixture.resourceKey} fixture\n`, async (skill) => {
      const packageSkill = {
        ...skill,
        name: fixture.resourceKey.split("/")[1],
        sourceInfo: { origin: "package", source: fixture.packageSource },
        pluginResourceKey: fixture.resourceKey,
      };
      const policyKey = getSkillPolicyKey({
        filePath: packageSkill.filePath,
        sourceInfo: packageSkill.sourceInfo,
        pluginResourceKey: packageSkill.pluginResourceKey,
      });
      const policy = resolveRuntimeSkillPolicy(packageSkill, {
        scope: "global",
        globalInvocationModes: { [policyKey]: fixture.expectedMode },
      });
      assert.equal(policy.invocationMode, fixture.expectedMode);
      assert.equal(policy.resourceState, "enabled");
      assert.equal(policy.runtimeLoaded, true);
      assert.equal(policy.commandUsable, true);
      assert.match(policy.policyKey, /^package:.+:skills\//);
      assert.doesNotMatch(policy.policyKey, /version|ref/);
      assert.ok(routeSkillCommand(`/skill:${packageSkill.name}`, { skills: [packageSkill] }));
    });
  }
});
