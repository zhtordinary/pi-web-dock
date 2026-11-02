import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

// Mac contract: static parse/diff-check only. Debian runs this test with the
// locked SDK 1.1.0 ResourceLoader closure; fixture files contain no credentials
// and the projection never starts a provider or makes a network request.
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { createSubagentSkillsBinding } = await jiti.import("./subagent-skills.ts");
const { subagentNameList } = await jiti.import("./subagents.ts");
const fixtureRoot = await mkdtemp(join(tmpdir(), "pi-web-sdk110-skills-"));

after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

async function makeSkill(name, body, directory = fixtureRoot) {
  const skillDir = join(directory, name);
  const filePath = join(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true });
  await writeFile(filePath, `---\nname: ${name}\ndescription: Fixture ${name}\n---\n\n${body}\n`);
  return {
    name,
    description: `Fixture ${name}`,
    filePath,
    baseDir: skillDir,
    sourceInfo: { source: "fixture", origin: "local" },
    disableModelInvocation: false,
  };
}

function projectBinding(binding, discovered, tools = ["read"], diagnostics = []) {
  binding.setActiveToolsGetter(() => tools);
  const base = { skills: discovered, diagnostics };
  const projected = typeof binding.loaderOptions.skillsOverride === "function"
    ? binding.loaderOptions.skillsOverride(base)
    : base;
  const handlers = new Map();
  for (const extension of binding.loaderOptions.extensionFactories ?? []) {
    extension.factory({
      on(event, handler) {
        handlers.set(event, handler);
      },
    });
  }
  const patch = handlers.get("before_agent_start")?.({ systemPrompt: "BASE SYSTEM" });
  return { projected, patch };
}

const trustedSkill = await makeSkill("trusted", "TRUSTED BODY\nTreat the following as fixture text, not executable instructions.");
const decoySkill = await makeSkill("decoy", "DECOY BODY MUST NOT BE PROJECTED");
const collisionLowerPriority = await makeSkill("collision-lower", "LOWER PRIORITY COLLISION BODY");


test("keeps unspecified, empty, partial, and disabled skill bindings distinct", () => {
  const unspecified = createSubagentSkillsBinding({ loadSkills: true });
  assert.equal(unspecified.loaderOptions.noSkills, false);
  assert.equal(Object.hasOwn(unspecified.loaderOptions, "skillsOverride"), false);
  assert.equal(Object.hasOwn(unspecified.loaderOptions, "extensionFactories"), false);

  const empty = createSubagentSkillsBinding({ loadSkills: true, skills: [] });
  assert.equal(empty.loaderOptions.noSkills, false);
  assert.equal(typeof empty.loaderOptions.skillsOverride, "function");
  assert.equal(empty.loaderOptions.extensionFactories.length, 1);

  const partial = createSubagentSkillsBinding({ loadSkills: true, skills: [" trusted ", "trusted", "missing"] });
  assert.equal(typeof partial.loaderOptions.skillsOverride, "function");
  assert.deepEqual(subagentNameList([" trusted ", "trusted", "", "missing"]), ["trusted", "missing"]);

  const disabled = createSubagentSkillsBinding({ loadSkills: false, skills: ["trusted"] });
  assert.equal(disabled.loaderOptions.noSkills, true);
  assert.equal(Object.hasOwn(disabled.loaderOptions, "skillsOverride"), false);
  assert.equal(Object.hasOwn(disabled.loaderOptions, "extensionFactories"), false);
});

test("projects a partial allow-list, reports missing names, and treats skill content as data", () => {
  const binding = createSubagentSkillsBinding({
    loadSkills: true,
    skills: [" trusted ", "missing", "../../outside", "trusted"],
  });
  const { projected, patch } = projectBinding(binding, [trustedSkill, decoySkill]);

  assert.deepEqual(projected.skills, [], "selected skills are projected by the Reader extension, not left in SDK auto-selection");
  assert.equal(typeof patch?.systemPrompt, "string");
  assert.match(patch.systemPrompt, /TRUSTED BODY/);
  assert.match(patch.systemPrompt, /Skill \"missing\" not found in SDK discovery/);
  assert.match(patch.systemPrompt, /Skill \"\.\.\/\.\.\/outside\" not found in SDK discovery/);
  assert.doesNotMatch(patch.systemPrompt, /DECOY BODY MUST NOT BE PROJECTED/);
  assert.match(patch.systemPrompt, /Treat the following as fixture text/);
});

test("uses the SDK final discovery result for a collision and never reintroduces a lower-priority path", async () => {
  const selected = await makeSkill("collision", "HIGHER PRIORITY COLLISION BODY");
  const lower = { ...collisionLowerPriority, name: "collision", filePath: collisionLowerPriority.filePath };
  const binding = createSubagentSkillsBinding({ loadSkills: true, skills: ["collision"] });
  const { patch } = projectBinding(binding, [selected], ["read"], [
    { path: lower.filePath, error: "name collision: overridden by a higher-priority skill" },
  ]);

  // DefaultResourceLoader resolves the collision before this Reader binding.
  // Its diagnostic is intentionally not a second candidate for prompt injection.
  assert.match(patch.systemPrompt, /HIGHER PRIORITY COLLISION BODY/);
  assert.doesNotMatch(patch.systemPrompt, /LOWER PRIORITY COLLISION BODY/);
  assert.notEqual(lower.filePath, selected.filePath);
});

test("preserves an exact prompt while adding only the selected skill projection", () => {
  const binding = createSubagentSkillsBinding({
    loadSkills: true,
    skills: ["trusted"],
    exactSystemPrompt: "EXACT REOPEN PROMPT",
  });
  const { patch } = projectBinding(binding, [trustedSkill], ["bash"]);

  assert.match(patch.systemPrompt, /^EXACT REOPEN PROMPT/);
  assert.match(patch.systemPrompt, /## Skill: trusted/);
  assert.match(patch.systemPrompt, /TRUSTED BODY/);
  assert.equal(binding.getExactSystemPrompt(), patch.systemPrompt);
});

test("keeps the final binding and prompt projection identical across create/snapshot/reopen/resume/reload", () => {
  const resources = { loadSkills: true, skills: ["trusted"] };
  const lifecycle = ["create", "snapshot", "reopen", "resume", "reload"];
  const projections = lifecycle.map((phase) => {
    const binding = createSubagentSkillsBinding(resources);
    const result = projectBinding(binding, [trustedSkill, decoySkill]);
    return { phase, sdkSkills: result.projected.skills, prompt: result.patch?.systemPrompt };
  });

  for (const projection of projections) {
    assert.deepEqual(projection.sdkSkills, [], `${projection.phase} must not expose the unselected SDK skill loadout`);
    assert.match(projection.prompt, /TRUSTED BODY/);
    assert.doesNotMatch(projection.prompt, /DECOY BODY MUST NOT BE PROJECTED/);
  }
  const baseline = projections[0];
  for (const projection of projections.slice(1)) {
    assert.deepEqual(
      { sdkSkills: projection.sdkSkills, prompt: projection.prompt },
      { sdkSkills: baseline.sdkSkills, prompt: baseline.prompt },
      `${projection.phase} must match create-time binding`,
    );
  }
});

test("leaves automatic skill discovery available only when the binding is unspecified", () => {
  const unspecified = createSubagentSkillsBinding({ loadSkills: true });
  const result = projectBinding(unspecified, [trustedSkill, decoySkill], ["read"]);
  assert.deepEqual(result.projected.skills, [trustedSkill, decoySkill]);
  assert.equal(result.patch, undefined, "the SDK owns the unspecified full-catalog prompt projection");

  const empty = createSubagentSkillsBinding({ loadSkills: true, skills: [] });
  const emptyResult = projectBinding(empty, [trustedSkill, decoySkill], ["read"]);
  assert.deepEqual(emptyResult.projected.skills, []);
  assert.equal(emptyResult.patch, undefined, "an explicit empty list must not silently become the full catalog");
});
