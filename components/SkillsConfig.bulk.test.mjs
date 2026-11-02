import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { skillStateEdit, canInheritGlobalSkillState, canInheritGlobalSkillGroupState, getSkillUseState, SkillUseStateControl, isSkillsPanelRequestCurrent } = await jiti.import("./SkillsConfig.tsx");
const source = await readFile(new URL("./SkillsConfig.tsx", import.meta.url), "utf8");
const local = { filePath: "/skills/local/SKILL.md", sourceInfo: { origin: "top-level", scope: "user" } };
const plugin = { filePath: "/plugins/pkg/skills/a/SKILL.md", sourceInfo: { origin: "package", source: "npm:pkg", scope: "user" }, pluginResourceKey: "skills/a" };
const projectOnly = { filePath: "/repo/.pi/skills/local/SKILL.md", sourceInfo: { origin: "top-level", scope: "project" } };

test("single and grouped state changes share one scoped native settings transaction", () => {
  for (const scope of ["global", "project"]) for (const state of ["automatic", "explicit-only", "disabled"]) {
    assert.deepEqual(skillStateEdit([local, plugin], state, scope, "/repo"), {
      action: "set_skill_group", cwd: "/repo", viewScope: scope, state,
      items: [{ filePath: local.filePath }, { filePath: plugin.filePath }],
    });
  }
  assert.equal(getSkillUseState({ resourceEnabled: false, invocationMode: "automatic" }, "global"), "disabled");
  assert.equal(getSkillUseState({ resourceEnabled: true, invocationMode: "explicit-only" }, "global"), "explicit-only");
  assert.equal(getSkillUseState({ resourceOverride: "inherit", policy: {} }, "project"), "inherit");
  assert.equal(getSkillUseState({ resourceOverride: "inherit", policy: { projectInvocationMode: "automatic" }, resourceEnabled: true, invocationMode: "automatic" }, "project"), "automatic");
  assert.equal(getSkillUseState({ ...projectOnly, resourceOverride: "inherit", policy: {}, resourceEnabled: true, invocationMode: "automatic" }, "project"), "automatic");
  assert.equal(getSkillUseState({ ...projectOnly, resourceOverride: "inherit", policy: {}, resourceEnabled: false, invocationMode: "automatic" }, "project"), "disabled");
  assert.equal(canInheritGlobalSkillState(plugin, "project"), true);
  assert.equal(canInheritGlobalSkillState(projectOnly, "project"), false);
  assert.equal(canInheritGlobalSkillState(plugin, "global"), false);
  assert.equal(canInheritGlobalSkillGroupState([plugin], "project"), true);
  assert.equal(canInheritGlobalSkillGroupState([plugin, projectOnly], "project"), false);
  assert.equal(canInheritGlobalSkillGroupState([projectOnly], "project"), false);
});

test("group work belongs to its original peer, cwd, revision and trust decision", () => {
  const identity = { cwd: "/repo", viewScope: "project", remotePeer: "air", revision: 1, trustKey: "trusted" };
  const request = { identity, generation: 2 };
  assert.equal(isSkillsPanelRequestCurrent(request, identity, 2), true);
  for (const changed of [{ remotePeer: "debian" }, { cwd: "/other" }, { revision: 2 }, { trustKey: "untrusted" }]) {
    assert.equal(isSkillsPanelRequestCurrent(request, { ...identity, ...changed }, 2), false);
  }
});

test("group changes preserve response snapshots and serialize writes in the original panel", () => {
  assert.match(source, /settingsMutationRef.current = request/);
  assert.match(source, /apiFor\(identity.remotePeer/);
  assert.match(source, /applySkillsResponse\(result\)/);
  assert.match(source, /setGroupSnapshots/);
  assert.match(source, /result.snapshots/);
  assert.doesNotMatch(source, /SkillGroupActionDialog|pendingGroupAction/);
});

test("global and project-only use states render with the right inheritance choices", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const render = (scope, skill = plugin, parentDisabled = false) => renderToStaticMarkup(createElement(SkillUseStateControl, {
    skill: { ...skill, policyKey: "p", resourceEnabled: true, invocationMode: "explicit-only", policy: { availability: "available" } },
    viewScope: scope, parentDisabled, busy: false, onChange() {}, t: (key) => key,
  }));
  assert.equal((render("global").match(/type="radio"/g) ?? []).length, 3);
  assert.equal((render("project").match(/type="radio"/g) ?? []).length, 4);
  assert.equal((render("project", projectOnly).match(/type="radio"/g) ?? []).length, 3);
  assert.doesNotMatch(render("project", projectOnly), /value="inherit"/);
  assert.match(render("global"), /<input\b(?=[^>]*\bvalue="explicit-only")(?=[^>]*\bchecked="")[^>]*>/);
  assert.equal((render("global", plugin, true).match(/disabled=""/g) ?? []).length, 2);
});
