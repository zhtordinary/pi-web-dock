import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import lockfile from "proper-lockfile";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "reader-resource-cas-"));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
const oldPromptFile = process.env.PI_WEB_CUSTOM_PROMPTS_FILE;
process.env.PI_CODING_AGENT_DIR = root;
delete process.env.PI_WEB_CUSTOM_PROMPTS_FILE;
const jiti = createJiti(import.meta.url);
const { inspectResourceSettings, mutateResourceSettings, validateResourceSettingsChange } = await jiti.import("./reader-control-plane-resources.ts");
const { writeBuiltInSubagentsEnabled, writeSubagentMaxConcurrent } = await jiti.import("./subagent-settings.ts");
const { saveCustomPrompt } = await jiti.import("./custom-prompts-state.ts");
const { writeModelRoutingConfig } = await jiti.import("./model-routing.ts");
const { mutateResourceDocument } = await jiti.import("./resource-config-file.ts");
const inspect = (area) => inspectResourceSettings({ area, scope: "global" });
const mutate = (area, operation, changes, expectedRevision = inspect(area).revision) => mutateResourceSettings({ area, scope: "global", operation, changes, expectedRevision });
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const fails = (code) => (error) => error.code === code;

test.after(() => {
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  if (oldPromptFile === undefined) delete process.env.PI_WEB_CUSTOM_PROMPTS_FILE;
  else process.env.PI_WEB_CUSTOM_PROMPTS_FILE = oldPromptFile;
  rmSync(root, { recursive: true, force: true });
});

test("resource CAS, UI writes and validation share the business configuration", async (t) => {
  const agents = join(root, "agents");
  const settingsPath = join(agents, "settings.json");
  const promptsPath = join(root, "custom-prompts.json");
  const routingPath = join(root, "model-routing.json");

  await t.test("reads and rejected preflight do not create missing files or directories", () => {
    const initial = inspect("subagents_settings");
    assert.equal(initial.revision, inspect("subagents_settings").revision);
    assert.equal(initial.value.maxConcurrent, 10);
    validateResourceSettingsChange({ area: "subagents_settings", scope: "global", operation: "patch", changes: { maxConcurrent: 2 } });
    assert.equal(existsSync(agents), false);
    assert.throws(() => validateResourceSettingsChange({ area: "subagents_settings", scope: "global", operation: "set_profile_enabled", changes: { name: "explore", enabled: "false" } }), fails("invalid_changes"));
    assert.throws(() => validateResourceSettingsChange({ area: "custom_prompts", scope: "global", operation: "delete", changes: { id: "" } }), fails("invalid_changes"));
    assert.throws(() => validateResourceSettingsChange({ area: "subagents_settings", scope: "global", operation: "set_profile_override", changes: { name: "unknown-fixture-profile", thinking: "low" } }), fails("profile_not_found"));
    assert.throws(() => mutate("subagents_settings", "patch", { maxConcurrent: 2 }, "0".repeat(64)), fails("configuration_unavailable"));
    assert.equal(existsSync(agents), false);
    assert.throws(() => mutate("subagents_settings", "patch", { maxConcurrent: 0 }), fails("invalid_changes"));
    assert.equal(existsSync(agents), false);
    assert.throws(() => inspectResourceSettings({ area: "model_routing", scope: "project", cwd: root }), fails("unsupported_scope"));
    assert.throws(() => mutate("custom_prompts", "upsert", { title: "x", content: "y", path: "/untrusted" }), fails("invalid_changes"));
    assert.equal(existsSync(promptsPath), false);
    assert.throws(() => mutate("model_routing", "replace", { enabled: false, routes: [] }, ""), fails("revision_required"));
    assert.equal(existsSync(routingPath), false);
    mkdirSync(agents);
    assert.throws(() => mutate("subagents_settings", "patch", { maxConcurrent: 2 }, "0".repeat(64)), fails("revision_conflict"));
    assert.equal(existsSync(settingsPath), false);
  });

  await t.test("subagent CAS detects UI updates and preserves unknown fields without projecting them", () => {
    const initial = inspect("subagents_settings");
    const result = mutate("subagents_settings", "patch", { builtInEnabled: true, maxConcurrent: 2 }, initial.revision);
    assert.equal(result.changed, true);
    assert.equal(result.value.maxConcurrent, 2);
    assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
    writeSubagentMaxConcurrent(3);
    assert.throws(() => mutate("subagents_settings", "patch", { maxConcurrent: 4 }, result.revision), fails("revision_conflict"));
    const external = json(settingsPath);
    external.futureSetting = { privateFixtureField: "not exposed" };
    external.modelOverrides = { Explore: { model: "fixture/old", futureOverride: true } };
    writeFileSync(settingsPath, JSON.stringify(external));
    const next = mutate("subagents_settings", "set_profile_override", { name: "explore", model: "fixture/new", thinking: "low" });
    assert.deepEqual(next.value.modelOverrides, { Explore: { model: "fixture/new", thinking: "low" } });
    assert.equal(next.value.futureSetting, undefined);
    assert.equal(json(settingsPath).modelOverrides.Explore.futureOverride, true);
    assert.equal(json(settingsPath).futureSetting.privateFixtureField, "not exposed");
    const disabled = mutate("subagents_settings", "set_profile_enabled", { name: "Explore", enabled: false });
    assert.deepEqual(disabled.value.disabledBuiltIns, ["Explore"]);
    const unchanged = mutate("subagents_settings", "set_profile_enabled", { name: "explore", enabled: false });
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.revision, disabled.revision);
  });

  await t.test("the same external lock blocks both legacy UI and managed writers", () => {
    const before = readFileSync(settingsPath, "utf8");
    const revision = inspect("subagents_settings").revision;
    const release = lockfile.lockSync(settingsPath, { realpath: false });
    try {
      assert.throws(() => writeBuiltInSubagentsEnabled(false), fails("configuration_busy"));
      assert.throws(() => mutate("subagents_settings", "patch", { builtInEnabled: false }, revision), fails("configuration_busy"));
      assert.equal(readFileSync(settingsPath, "utf8"), before);
    } finally { release(); }
    assert.equal(mutate("subagents_settings", "patch", { builtInEnabled: false }, revision).value.builtInEnabled, false);
  });

  await t.test("prompt CRUD and ordering persist, while stale UI revisions cannot overwrite newer prompts", () => {
    mutate("custom_prompts", "upsert", { id: "one", title: "One", content: "Fixture one" });
    const second = mutate("custom_prompts", "upsert", { id: "two", title: "Two", content: "Fixture two" });
    saveCustomPrompt({ id: "three", title: "Three", content: "Fixture three" });
    assert.throws(() => mutate("custom_prompts", "delete", { id: "one" }, second.revision), fails("revision_conflict"));
    const reordered = mutate("custom_prompts", "reorder", { orderedIds: ["three", "one", "two"] });
    assert.deepEqual(reordered.value.prompts.map((prompt) => prompt.id), ["three", "one", "two"]);
    const before = readFileSync(promptsPath, "utf8");
    assert.throws(() => mutate("custom_prompts", "reorder", { orderedIds: ["one", "one"] }), fails("invalid_changes"));
    assert.equal(readFileSync(promptsPath, "utf8"), before);
    assert.deepEqual(mutate("custom_prompts", "delete", { id: "one" }).value.prompts.map((prompt) => prompt.id), ["three", "two"]);
    const noChange = mutate("custom_prompts", "delete", { id: "missing" });
    assert.equal(noChange.changed, false);
    const raw = json(promptsPath);
    raw.privateFixtureField = "not exposed";
    raw.prompts[0].futureField = 42;
    writeFileSync(promptsPath, JSON.stringify(raw));
    const projected = mutate("custom_prompts", "upsert", { id: "three", title: "Changed", content: "Updated fixture" });
    assert.equal(projected.value.privateFixtureField, undefined);
    assert.equal(projected.value.prompts[0].futureField, undefined);
    assert.equal(json(promptsPath).prompts.find((prompt) => prompt.id === "three").futureField, 42);
  });

  await t.test("routing replace is atomic, detects legacy writes and rejects malformed replacements", async () => {
    const initial = inspect("model_routing");
    const routes = [{ id: "a", provider: "fixture", model: "fixture-model", thinkingLevel: "low", maxAttempts: 2 }];
    await writeModelRoutingConfig({ enabled: true, routes });
    assert.throws(() => mutate("model_routing", "replace", { enabled: false, routes: [] }, initial.revision), fails("revision_conflict"));
    const raw = json(routingPath);
    raw.futureField = { keep: true };
    writeFileSync(routingPath, JSON.stringify(raw));
    const result = mutate("model_routing", "replace", { enabled: false, routes });
    assert.equal(result.value.enabled, false);
    assert.equal(result.value.futureField, undefined);
    assert.deepEqual(json(routingPath).futureField, { keep: true });
    assert.equal(statSync(routingPath).mode & 0o777, 0o600);
    const before = readFileSync(routingPath, "utf8");
    assert.throws(() => mutate("model_routing", "replace", { enabled: true, routes: [{ ...routes[0], maxAttempts: 0 }] }), fails("invalid_changes"));
    assert.throws(() => mutate("model_routing", "replace", { enabled: true, routes: [{ ...routes[0], credential: "fixture" }] }), fails("invalid_changes"));
    assert.equal(readFileSync(routingPath, "utf8"), before);
    const release = lockfile.lockSync(routingPath, { realpath: false });
    try { await assert.rejects(writeModelRoutingConfig({ enabled: true, routes: [] }), fails("configuration_busy")); }
    finally { release(); }
    writeFileSync(routingPath, "{");
    assert.throws(() => inspect("model_routing"), fails("invalid_configuration"));
    await assert.rejects(writeModelRoutingConfig({ enabled: true, routes: [] }), fails("invalid_configuration"));
    assert.equal(readFileSync(routingPath, "utf8"), "{");
  });

  await t.test("managed symlinks are preserved while non-files and oversized files are rejected", () => {
    const safeTarget = join(root, "safe-fixture.json");
    writeFileSync(safeTarget, JSON.stringify({ enabled: true, routes: [] }));
    rmSync(routingPath);
    symlinkSync(safeTarget, routingPath);
    assert.equal(inspect("model_routing").value.enabled, true);
    const updated = mutate("model_routing", "replace", { enabled: false, routes: [] });
    assert.equal(updated.value.enabled, false);
    assert.equal(json(safeTarget).enabled, false);
    assert.equal(lstatSync(routingPath).isSymbolicLink(), true);
    rmSync(routingPath);
    mkdirSync(routingPath);
    assert.throws(() => inspect("model_routing"), fails("unsupported_path"));
    assert.throws(() => mutateResourceDocument(routingPath, "0".repeat(64), () => {}), fails("unsupported_path"));
    rmSync(routingPath, { recursive: true, force: true });
    writeFileSync(routingPath, JSON.stringify({ fixture: "a".repeat(1024 * 1024) }));
    assert.throws(() => inspect("model_routing"), fails("configuration_too_large"));
  });
});
