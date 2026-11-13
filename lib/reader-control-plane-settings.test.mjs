import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

// Run only in Debian's managed checks. Every write is confined to this fixture;
// no production settings, tokens, external server or model turn is involved.
const root = realpathSync(await mkdtemp(join(tmpdir(), "reader-managed-settings-")));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
await mkdir(agentDir);
await mkdir(join(cwd, ".pi"), { recursive: true });
await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
  fixture: { baseUrl: "https://example.invalid/v1", api: "openai-completions", apiKey: "fixture-not-a-credential", models: [{ id: "one" }, { id: "two" }] },
} }));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const settings = await jiti.import("./reader-control-plane-settings.ts");
const settingsPath = join(agentDir, "settings.json");
after(async () => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  await rm(root, { recursive: true, force: true });
});
const target = (area, scope = "global") => ({ area, scope, cwd });
const inspect = (area, scope) => settings.inspectSettings(target(area, scope));
async function mutate(area, operation, changes, expectedRevision, scope) {
  const current = expectedRevision ?? (await inspect(area, scope)).revision;
  return settings.mutateSettings({ ...target(area, scope), operation, changes, expectedRevision: current });
}
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const errorCode = (code) => (error) => error.code === code;

test("inspect, invalid dry-run and stale CAS do not create an absent settings file", async () => {
  await rm(settingsPath, { force: true });
  const before = await readdir(agentDir);
  const view = await inspect("tools_settings");
  assert.match(view.revision, /^[a-f0-9]{64}$/);
  await assert.rejects(settings.validateSettingsChange({ ...target("tools_settings"), operation: "set_codemode", changes: { codemode: "never" } }), errorCode("invalid_changes"));
  await assert.rejects(mutate("tools_settings", "set_codemode", { codemode: "always" }, "f".repeat(64)), errorCode("revision_conflict"));
  assert.deepEqual(await readdir(agentDir), before);
});

test("tools writer preserves unrelated settings and gives actual post-write revision", async () => {
  await writeFile(settingsPath, JSON.stringify({ keep: { nested: "untouched" }, defaultTools: ["read"] }));
  const before = await inspect("tools_settings");
  await settings.validateSettingsChange({ ...target("tools_settings"), operation: "set_codemode", changes: { codemode: "always" } });
  assert.deepEqual((await json(settingsPath)).defaultTools, ["read"], "dry-run did not write");
  const result = await mutate("tools_settings", "set_codemode", { codemode: "always" }, before.revision);
  assert.equal(result.changed, true);
  assert.equal(result.revision, (await inspect("tools_settings")).revision);
  assert.deepEqual(await json(settingsPath), { keep: { nested: "untouched" }, defaultTools: ["read", "+codemode"] });
  const bytes = await readFile(settingsPath, "utf8");
  const unchanged = await mutate("tools_settings", "set_codemode", { codemode: "always" });
  assert.equal(unchanged.changed, false);
  assert.equal(await readFile(settingsPath, "utf8"), bytes);
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
});

test("competing writes with one revision admit exactly one and preserve UI changes", async () => {
  await writeFile(settingsPath, "{}");
  const revision = (await inspect("tools_settings")).revision;
  const results = await Promise.allSettled([
    mutate("tools_settings", "set_codemode_mode", { codemodeMode: "only" }, revision),
    mutate("tools_settings", "set_codemode_inline_budget", { inlineBudget: 1234 }, revision),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "revision_conflict");
  const stale = (await inspect("tools_settings")).revision;
  const { writeCodemodePreference } = await jiti.import("./codemode-settings.ts");
  await writeCodemodePreference("always", settingsPath);
  await assert.rejects(mutate("tools_settings", "set_codemode_mode", { codemodeMode: "on" }, stale), errorCode("revision_conflict"));
  assert.equal((await inspect("tools_settings")).value.codemode, "always");
});

test("default thinking and plugin toggles reuse business editors without dropping unknown fields", async () => {
  await writeFile(settingsPath, JSON.stringify({ keep: "unchanged", packages: ["npm:fixture-plugin"] }));
  await mutate("models_default", "set_default", { thinkingLevel: "high" });
  assert.equal((await json(settingsPath)).defaultThinkingLevel, "high");
  await mutate("plugins", "disable", { source: "npm:fixture-plugin" });
  assert.equal((await inspect("plugins")).value.packages[0].disabled, true);
  await mutate("plugins", "enable", { source: "npm:fixture-plugin" });
  assert.deepEqual((await json(settingsPath)).packages, ["npm:fixture-plugin"]);
  assert.equal((await json(settingsPath)).keep, "unchanged");
});

test("Skill policy uses discovered identity and leaves source bytes intact", async () => {
  await writeFile(settingsPath, "{}");
  const dir = join(agentDir, "skills", "fixture");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "SKILL.md");
  const content = "---\nname: fixture\ndescription: An isolated test skill.\n---\nFixture instructions.\n";
  await writeFile(filePath, content);
  const view = await inspect("skills_policy");
  const skill = view.value.skills.find((item) => item.filePath === filePath);
  assert.ok(skill?.policyKey);
  await mutate("skills_policy", "set_skill_invocation_mode", { policyKey: skill.policyKey, mode: "explicit-only" }, view.revision);
  assert.equal((await json(settingsPath)).piWebGlobalSkillInvocationModes[skill.policyKey], "explicit-only");
  assert.equal(await readFile(filePath, "utf8"), content);
  await assert.rejects(mutate("skills_policy", "clear_skill_invocation_mode", { policyKey: "not-a-discovered-skill" }), errorCode("skill_identity_conflict"));
  const projectFile = join(cwd, ".pi", "settings.json");
  await rm(projectFile, { force: true });
  await assert.rejects(mutate("skills_policy", "set_skill_invocation_mode", { policyKey: skill.policyKey, mode: "explicit-only" }, undefined, "project"), errorCode("project_untrusted"));
  await assert.rejects(readFile(projectFile), { code: "ENOENT" });
});

test("project Skill policy writes and clears a project-relative mode key", async () => {
  const project = join(root, "portable-project");
  const dir = join(project, ".agents/skills/project-skill");
  const projectSettings = join(project, ".pi/settings.json");
  await mkdir(dir, { recursive: true });
  await mkdir(join(project, ".pi"), { recursive: true });
  await writeFile(join(dir, "SKILL.md"), "---\nname: project-skill\ndescription: fixture\n---\nbody\n");
  await writeFile(projectSettings, JSON.stringify({ keep: true }));
  const { ProjectTrustStore } = await import("@earendil-works/pi-coding-agent");
  new ProjectTrustStore(agentDir).set(project, true);
  const projectTarget = { area: "skills_policy", scope: "project", cwd: project };
  const before = await settings.inspectSettings(projectTarget);
  const skill = before.value.skills.find((item) => item.name === "project-skill");
  assert.ok(skill?.policyKey);
  await settings.mutateSettings({ ...projectTarget, operation: "set_skill_invocation_mode", changes: { policyKey: skill.policyKey, mode: "explicit-only" }, expectedRevision: before.revision });
  assert.deepEqual((await json(projectSettings)).piWebProjectSkillInvocationModes, { "top-level:project:.agents/skills/project-skill/SKILL.md": "explicit-only" });
  const after = await settings.inspectSettings(projectTarget);
  assert.equal(after.value.skills.find((item) => item.name === "project-skill")?.invocationMode, "explicit-only");
  await settings.mutateSettings({ ...projectTarget, operation: "clear_skill_invocation_mode", changes: { policyKey: skill.policyKey }, expectedRevision: after.revision });
  assert.equal((await json(projectSettings)).piWebProjectSkillInvocationModes, undefined);
  assert.equal((await json(projectSettings)).keep, true);
});

test("MCP config-only edits preserve opaque fields and never expose connection material", async () => {
  const path = join(agentDir, "mcp.json");
  await writeFile(path, JSON.stringify({ keep: true, mcpServers: { fixture: { url: "https://example.invalid/mcp", headers: { Authorization: "fixture-not-a-credential" } } } }));
  const before = await inspect("mcp");
  assert.ok(!JSON.stringify(before).includes("fixture-not-a-credential"));
  await settings.validateSettingsChange({ ...target("mcp"), operation: "disable", changes: { name: "fixture" } });
  assert.equal((await json(path)).mcpServers.fixture.enabled, undefined);
  await mutate("mcp", "disable", { name: "fixture" }, before.revision);
  assert.equal((await json(path)).mcpServers.fixture.enabled, false);
  assert.equal((await json(path)).mcpServers.fixture.headers.Authorization, "fixture-not-a-credential");
  await assert.rejects(mutate("mcp", "enable", { name: "fixture" }, before.revision), errorCode("revision_conflict"));
  await mutate("mcp", "set_exposure", { name: "fixture", exposure: "direct" });
  assert.equal((await json(path)).mcpServers.fixture.exposure, "direct");
  const original = await readFile(path, "utf8");
  await assert.rejects(mutate("mcp", "add", { name: "not-allowed" }), errorCode("invalid_changes"));
  assert.equal(await readFile(path, "utf8"), original);
});

test("managed model edits reject an unsafe wildcard without changing settings", async () => {
  const original = JSON.stringify({ enabledModels: ["fixture/*", "unavailable/model:high"], keep: true });
  await writeFile(settingsPath, original);
  const view = await inspect("models_enabled");
  await assert.rejects(mutate("models_enabled", "set_models", { refs: ["fixture/one"], enabled: false }, view.revision), errorCode("unsafe_scope"));
  assert.equal(await readFile(settingsPath, "utf8"), original);
});

test("a managed exact disable preserves unrelated settings", async () => {
  await writeFile(settingsPath, JSON.stringify({ enabledModels: ["fixture/one", "fixture/two"], keep: true }));
  const view = await inspect("models_enabled");
  await mutate("models_enabled", "set_models", { refs: ["fixture/one"], enabled: false }, view.revision);
  assert.deepEqual(await json(settingsPath), { enabledModels: ["fixture/two"], keep: true });
});

test("managed resync cannot rewrite an unverified wildcard", async () => {
  const original = JSON.stringify({ enabledModels: ["fixture/*", "unavailable/model:high"], keep: true });
  await writeFile(settingsPath, original);
  const view = await inspect("models_enabled");
  await assert.rejects(mutate("models_enabled", "resync", { renames: [{ from: "fixture", to: "new-fixture" }] }, view.revision), errorCode("unsafe_scope"));
  assert.equal(await readFile(settingsPath, "utf8"), original);
});

test("managed prune preserves unavailable model patterns byte for byte", async () => {
  const original = JSON.stringify({ enabledModels: ["signed-out-provider/model:high", "remote-only/*"], keep: true });
  await writeFile(settingsPath, original);
  const view = await inspect("models_enabled");
  await assert.rejects(mutate("models_enabled", "prune", {}, view.revision), errorCode("unverified_models"));
  assert.equal(await readFile(settingsPath, "utf8"), original);
});

test("model metadata edits preserve opaque fields and share the UI file lock", async () => {
  const path = join(agentDir, "models.json");
  const raw = JSON.stringify({ providers: { fixture: { apiKey: "fixture-not-a-credential", models: [{ id: "fixture-model", name: "Fixture", defaultThinkingLevel: "low" }] } } });
  await writeFile(path, raw);
  const view = await inspect("models_config");
  assert.equal(view.value.providers[0].models[0].id, "fixture-model");
  assert.ok(!JSON.stringify(view).includes("fixture-not-a-credential"));
  await assert.rejects(mutate("models_config", "replace_config", {}), errorCode("unsupported_operation"));
  assert.equal(await readFile(path, "utf8"), raw);
  const result = await mutate("models_config", "set_model_metadata", { provider: "fixture", modelId: "fixture-model", name: "Renamed", thinkingLevel: "high" }, view.revision);
  assert.equal(result.value.providers[0].models[0].name, "Renamed");
  assert.equal((await json(path)).providers.fixture.apiKey, "fixture-not-a-credential");
  assert.ok(!JSON.stringify(result).includes("fixture-not-a-credential"));
  await assert.rejects(mutate("models_config", "set_model_metadata", { provider: "fixture", modelId: "fixture-model", thinkingLevel: "low" }, view.revision), errorCode("revision_conflict"));
  const { writeModelsConfig } = await jiti.import("./models-config-store.ts");
  writeModelsConfig({ providers: { fixture: { models: [{ id: "fixture-model", name: "UI edit" }] } } }, path);
  await assert.rejects(mutate("models_config", "set_model_metadata", { provider: "fixture", modelId: "fixture-model", thinkingLevel: "low" }, result.revision), errorCode("revision_conflict"));
});


test("project tools require an existing trust decision and apply real SDK overrides without changing global settings", async () => {
  const { ProjectTrustStore, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const globalBytes = JSON.stringify({ keepGlobal: true, defaultTools: ["read", "+codemode"], codemode: { mode: "only", inlineBudget: 5678 } });
  await writeFile(settingsPath, globalBytes);
  const projectPath = join(cwd, ".pi", "settings.json");
  await rm(projectPath, { force: true });
  await assert.rejects(mutate("tools_settings", "set_codemode", { codemode: "automatic" }, undefined, "project"), errorCode("project_untrusted"));
  await assert.rejects(readFile(projectPath), { code: "ENOENT" });
  new ProjectTrustStore(agentDir).set(cwd, true);
  await writeFile(projectPath, JSON.stringify({ keepProject: true }));
  const inherited = await inspect("tools_settings", "project");
  assert.equal(inherited.value.codemode, "always");
  assert.equal(inherited.value.inherited.codemode, true);
  const result = await mutate("tools_settings", "set_codemode", { codemode: "automatic" }, inherited.revision, "project");
  assert.equal(result.value.codemode, "automatic");
  assert.equal(result.value.inherited.codemode, false);
  assert.deepEqual((await json(projectPath)).defaultTools, ["-codemode"]);
  const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  assert.ok(!manager.getDefaultTools().includes("codemode"));
  await mutate("tools_settings", "set_codemode_mode", { codemodeMode: "on" }, undefined, "project");
  await mutate("tools_settings", "set_codemode_inline_budget", { inlineBudget: 777 }, undefined, "project");
  const actual = SettingsManager.create(cwd, agentDir, { projectTrusted: true }).getSettings();
  assert.equal(actual.codemode.mode, "on");
  assert.equal(actual.codemode.inlineBudget, 777);
  assert.equal((await json(projectPath)).keepProject, true);
  assert.equal(await readFile(settingsPath, "utf8"), globalBytes);
  const stale = (await inspect("tools_settings", "project")).revision;
  new ProjectTrustStore(agentDir).set(cwd, false);
  await assert.rejects(mutate("tools_settings", "set_codemode", { codemode: "always" }, stale, "project"), errorCode("project_untrusted"));
  assert.equal(await readFile(settingsPath, "utf8"), globalBytes);
});


test("MCP add/remove/undo share the actual editor and bounded private undo without connecting servers", async () => {
  const path = join(agentDir, "mcp.json");
  await writeFile(path, JSON.stringify({ keep: true, mcpServers: {} }));
  const before = await inspect("mcp");
  const server = { url: "https://example.invalid/isolated", enabled: false };
  await settings.validateSettingsChange({ ...target("mcp"), operation: "add", changes: { name: "isolated", server } });
  assert.deepEqual((await json(path)).mcpServers, {});
  await mutate("mcp", "add", { name: "isolated", server }, before.revision);
  assert.equal((await json(path)).mcpServers.isolated.enabled, false);
  const removed = await mutate("mcp", "remove", { name: "isolated" });
  assert.deepEqual((await json(path)).mcpServers, {});
  assert.ok(removed.impact.undo.id);
  assert.ok(!JSON.stringify(removed).includes(server.url));
  const changes = { undoId: removed.impact.undo.id };
  await settings.validateSettingsChange({ ...target("mcp"), operation: "undo", changes });
  assert.deepEqual((await json(path)).mcpServers, {});
  const restored = await mutate("mcp", "undo", changes, removed.revision);
  assert.equal(restored.changed, true);
  assert.deepEqual((await json(path)).mcpServers.isolated, server);
  await assert.rejects(mutate("mcp", "undo", changes), errorCode("undo_expired"));
  const original = await readFile(path, "utf8");
  process.env.PI_WEB_DISABLE_MCP = "1";
  try { await assert.rejects(mutate("mcp", "disable", { name: "isolated" }), errorCode("mcp-off")); }
  finally { delete process.env.PI_WEB_DISABLE_MCP; }
  assert.equal(await readFile(path, "utf8"), original);
});


test("model metadata does not normalize unrelated rows and reports the actual persisted revision", async () => {
  const path = join(agentDir, "models.json");
  await writeFile(path, JSON.stringify({ providers: { fixture: { models: [{ id: "fixture-model", name: "Fixture" }, { id: "", draft: true }] } } }));
  const before = await inspect("models_config");
  const unchanged = await mutate("models_config", "set_model_metadata", { provider: "fixture", modelId: "fixture-model", name: "Fixture" }, before.revision);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.revision, (await inspect("models_config")).revision);
  const changed = await mutate("models_config", "set_model_metadata", { provider: "fixture", modelId: "fixture-model", name: "Renamed" }, unchanged.revision);
  assert.equal(changed.changed, true);
  assert.equal(changed.revision, (await inspect("models_config")).revision);
  assert.deepEqual((await json(path)).providers.fixture.models[1], { id: "", draft: true });
});

async function duringProjectPluginEdit(action, run) {
  const { DefaultPackageManager, ProjectTrustStore } = await import("@earendil-works/pi-coding-agent");
  const path = join(cwd, ".pi", "settings.json");
  await rm(path, { force: true });
  const extension = join(cwd, "fixture-extension.ts");
  await writeFile(extension, "export default function () {}\n");
  const document = { extensions: [extension], keep: "untouched" };
  await writeFile(path, JSON.stringify(document));
  new ProjectTrustStore(agentDir).set(cwd, true);
  const before = await inspect("plugins", "project");
  const original = DefaultPackageManager.prototype.resolve;
  let calls = 0;
  DefaultPackageManager.prototype.resolve = async function (...args) {
    const result = await original.apply(this, args);
    // First discovery is dry-run validation; second is the locked edit.
    if (++calls === 2) await action({ path, document, store: new ProjectTrustStore(agentDir) });
    return result;
  };
  try { await run(() => mutate("plugins", "set_top_level_extension", { path: extension, enabled: false }, before.revision, "project")); }
  finally {
    DefaultPackageManager.prototype.resolve = original;
    new ProjectTrustStore(agentDir).set(cwd, true);
    await rm(path, { force: true });
    await writeFile(path, JSON.stringify(document));
  }
  assert.equal(calls, 2, "the race must run inside the real locked business editor");
}

test("project settings refuse a same-content symlink redirected outside exact cwd during async editing", async () => {
  const outside = join(agentDir, "outside-settings-fixture.json");
  let bytes;
  await duringProjectPluginEdit(async ({ path, document }) => {
    bytes = JSON.stringify(document);
    await writeFile(outside, bytes);
    await rm(path);
    await symlink(outside, path);
  }, async run => {
    await assert.rejects(run(), errorCode("scope_path_changed"));
    assert.equal(await readFile(outside, "utf8"), bytes, "CAS-equal outside file was not written");
  });
});

test("project settings revalidate trust after async business editing before commit", async () => {
  let bytes;
  await duringProjectPluginEdit(async ({ path, store }) => {
    bytes = await readFile(path, "utf8");
    store.set(cwd, false);
  }, async run => {
    await assert.rejects(run(), errorCode("project_untrusted"));
    assert.equal(await readFile(join(cwd, ".pi", "settings.json"), "utf8"), bytes);
  });
});

test("project MCP edits a linked config with the existing revision check", async () => {
  const { ProjectTrustStore } = await import("@earendil-works/pi-coding-agent");
  new ProjectTrustStore(agentDir).set(cwd, true);
  const outside = join(agentDir, "outside-mcp-fixture.json");
  const path = join(cwd, ".pi", "mcp.json");
  const bytes = JSON.stringify({ mcpServers: { fixture: { url: "https://example.invalid/fixture" } } });
  await writeFile(outside, bytes);
  await rm(path, { force: true });
  await symlink(outside, path);
  try {
    await assert.rejects(settings.mutateSettings({ ...target("mcp", "project"), operation: "disable", changes: { name: "fixture" }, expectedRevision: "f".repeat(64) }), errorCode("revision_conflict"));
    assert.equal(await readFile(outside, "utf8"), bytes);
    const before = await inspect("mcp", "project");
    await mutate("mcp", "disable", { name: "fixture" }, before.revision, "project");
    assert.equal(JSON.parse(await readFile(outside, "utf8")).mcpServers.fixture.enabled, false);
  } finally { await rm(path, { force: true }); }
});


test("project Skill policy obeys an inherited disabled parent and allows an explicit enabled parent", async () => {
  const { ProjectTrustStore, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const { setPackageEntryDisabled } = await jiti.import("./plugin-package-state.ts");
  const { readSkillStateSettings } = await jiti.import("./skill-state-settings.ts");
  const source = join(root, "parent-cap-plugin");
  const filePath = join(source, "skills", "parent-cap", "SKILL.md");
  await mkdir(join(source, "skills", "parent-cap"), { recursive: true });
  await writeFile(filePath, "---\nname: parent-cap\ndescription: Isolated parent policy fixture.\n---\nFixture.\n");
  await writeFile(settingsPath, JSON.stringify({ packages: [setPackageEntryDisabled(source, true)], keepGlobal: true }));
  const projectPath = join(cwd, ".pi", "settings.json");
  await writeFile(projectPath, JSON.stringify({ keepProject: true }));
  new ProjectTrustStore(agentDir).set(cwd, true);
  const globalBytes = await readFile(settingsPath, "utf8");
  const projectBytes = await readFile(projectPath, "utf8");
  const view = await inspect("skills_policy", "project");
  const skill = view.value.skills.find((entry) => entry.filePath === filePath);
  assert.ok(skill?.policyKey, "disabled package resources retain their discovered identity");
  const changes = { policyKey: skill.policyKey, enabled: true };
  await assert.rejects(settings.validateSettingsChange({ ...target("skills_policy", "project"), operation: "set_plugin_skill", changes }), errorCode("plugin_disabled"));
  await assert.rejects(mutate("skills_policy", "set_plugin_skill", changes, view.revision, "project"), errorCode("plugin_disabled"));
  assert.equal(await readFile(projectPath, "utf8"), projectBytes);
  assert.equal(await readFile(settingsPath, "utf8"), globalBytes);

  await mutate("plugins", "set_project_override", { source, enabled: true }, undefined, "project");
  await mutate("skills_policy", "set_plugin_skill", changes, undefined, "project");
  const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const skillState = {
    ...skill,
    pluginResourceKey: skill.resourceKey,
    sourceInfo: { origin: "package", scope: "user", source: skill.source },
  };
  assert.equal(readSkillStateSettings(manager, cwd, "project", skillState).resource, "enabled");
  assert.equal((await json(projectPath)).keepProject, true);
  assert.equal(await readFile(settingsPath, "utf8"), globalBytes);
});

test("opaque discovered Skill identities round-trip without paths and reject scope/conflicting/stale identity", async () => {
  const skillDir = join(agentDir, "skills", "opaque-fixture");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "---\nname: opaque-fixture\ndescription: Opaque identity test\n---\nFixture\n");
  await writeFile(settingsPath, "{}");
  const view = await inspect("skills_policy");
  const skill = view.value.skills.find(s => s.name === "opaque-fixture");
  assert.match(skill.resourceId, /^resource_[a-f0-9]{64}$/);
  const { redactLiveValue } = await jiti.import("./live-agent-events.ts");
  assert.equal(redactLiveValue(view.value).skills.find(s => s.name === skill.name).resourceId, skill.resourceId);
  assert.equal((await inspect("skills_policy")).value.skills.find(s=>s.name===skill.name).resourceId, skill.resourceId);
  await mutate("skills_policy", "set_global_skill_resource", { resourceId: skill.resourceId, enabled: false }, view.revision);
  await mutate("skills_policy", "clear_global_skill_resource", { resourceId: skill.resourceId });
  await assert.rejects(mutate("skills_policy", "set_skill_invocation_mode", { resourceId: skill.resourceId, filePath: skill.filePath, mode: "explicit-only" }), errorCode("resource_identity_conflict"));
  await assert.rejects(mutate("skills_policy", "set_project_resource", { resourceId: skill.resourceId, enabled: false }, undefined, "project"), errorCode("resource_unavailable"));
  await rm(skillDir, { recursive: true });
  await assert.rejects(mutate("skills_policy", "clear_global_skill_resource", { resourceId: skill.resourceId }), errorCode("resource_unavailable"));
});

test("opaque package and extension handles preserve existing editor boundaries", async () => {
  const source = join(root, "opaque-package");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "opaque-package", version: "1.0.0", pi: { extensions: [] } }));
  await writeFile(settingsPath, JSON.stringify({ packages: [source] }));
  const view = await inspect("plugins");
  const pkg = view.value.resources.find(r => r.kind === "package");
  assert.match(pkg.resourceId, /^resource_[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(pkg).sort(), ["kind", "name", "resourceId", "sourceScope"]);
  await mutate("plugins", "disable", { resourceId: pkg.resourceId }, view.revision);
  await mutate("plugins", "enable", { resourceId: pkg.resourceId });
  await assert.rejects(mutate("plugins", "disable", { resourceId: pkg.resourceId, source }), errorCode("resource_identity_conflict"));
  await writeFile(settingsPath, "{}");
  await assert.rejects(mutate("plugins", "disable", { resourceId: pkg.resourceId }), errorCode("resource_unavailable"));
});

test("uninitialized project scope reports a definite refusal rather than an unknown write", async () => {
  const empty = join(root, "empty-project"); await mkdir(empty);
  const { ProjectTrustStore } = await import("@earendil-works/pi-coding-agent");
  new ProjectTrustStore(agentDir).set(empty, true);
  await assert.rejects(settings.mutateSettings({ area: "tools_settings", scope: "project", cwd: empty, operation: "set_codemode", changes: { codemode: "always" }, expectedRevision: "0".repeat(64) }), errorCode("scope_uninitialized"));
  assert.deepEqual(await readdir(empty), []);
});


test("relative packages in global and project scopes retain distinct opaque owners", async () => {
  await writeFile(settingsPath, JSON.stringify({ packages: ["./same-package"] }));
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["./same-package"] }));
  for (const base of [agentDir, cwd]) { await mkdir(join(base, "same-package"), { recursive: true }); await writeFile(join(base, "same-package", "package.json"), JSON.stringify({ name: "same-package", version: "1.0.0", pi: { extensions: [] } })); }
  const view = await inspect("plugins", "project");
  const entries = view.value.resources.filter(r => r.kind === "package");
  assert.equal(entries.length, 2); assert.notEqual(entries[0].resourceId, entries[1].resourceId);
  const global = entries.find(r=>r.sourceScope === "global"), project = entries.find(r=>r.sourceScope === "project");
  await assert.rejects(mutate("plugins", "disable", { resourceId: global.resourceId }, undefined, "project"), errorCode("resource_scope_mismatch"));
  await mutate("plugins", "disable", { resourceId: project.resourceId }, undefined, "project");
  assert.deepEqual((await json(settingsPath)).packages, ["./same-package"]);
});
