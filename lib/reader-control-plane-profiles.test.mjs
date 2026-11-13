import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import lockfile from "proper-lockfile";
import { createJiti } from "jiti";

const root = realpathSync(mkdtempSync(join(tmpdir(), "reader-profile-cas-")));
const agentDir = join(root, "agent"); const cwd = join(root, "project");
mkdirSync(agentDir); mkdirSync(cwd);
const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url);
const contract = await jiti.import("./reader-control-plane-profiles.ts");
const native = await jiti.import("./subagent-profiles.ts");
const { ProjectTrustStore } = await import("@earendil-works/pi-coding-agent");
const trust = new ProjectTrustStore(agentDir);
after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(root, { recursive: true, force: true }); });
const target = (scope = "global") => ({ area: "subagent_profiles", scope, cwd });
const inspect = (scope) => contract.inspectManagedProfiles(target(scope));
const fixture = { name: "fixture", description: "Isolated fixture", systemPrompt: "Only inspect the fixture.", tools: ["ls"], enabled: false };
const mutate = (operation, changes, revision = inspect().revision, scope = "global") => contract.mutateManagedProfiles({ ...target(scope), operation, changes, expectedRevision: revision });
const fails = code => error => error.code === code;

test("profile read and dry run do not create files, and stale first CAS leaves no profile scope", () => {
  const before = readdirSync(agentDir);
  const view = inspect();
  assert.deepEqual(view.value.profiles, []);
  contract.validateManagedProfileChange({ ...target(), operation: "upsert", changes: fixture });
  assert.deepEqual(readdirSync(agentDir), before);
  assert.throws(() => mutate("upsert", fixture, "f".repeat(64)), fails("revision_conflict"));
  assert.deepEqual(readdirSync(agentDir), before);
});

test("profile CRUD uses native editor, actual scope revision, UI invalidation and exact deletion", () => {
  const first = mutate("upsert", fixture);
  assert.equal(first.changed, true);
  assert.equal(first.revision, inspect().revision);
  assert.equal(first.value.profiles[0].enabled, false);
  assert.equal(first.value.profiles[0].inheritProjectContext, true);
  assert.equal(first.value.profiles[0].inheritGlobalContext, true);
  assert.equal(first.value.profiles[0].inheritSkills, true);
  assert.equal(first.value.profiles[0].defaultAsync, true, "managed profiles default to background");
  assert.equal(first.value.profiles[0].filePath, undefined);
  const path = join(agentDir, "agents", "fixture.md");
  assert.match(readFileSync(path, "utf8"), /Only inspect the fixture/);
  const enabled = mutate("set_enabled", { name: "fixture", enabled: true }, first.revision);
  assert.equal(enabled.value.profiles[0].enabled, true);
  const noChange = mutate("set_enabled", { name: "fixture", enabled: true }, enabled.revision);
  assert.equal(noChange.changed, false);
  const existing = native.listSubagentProfiles(cwd).find(profile => profile.scope === "global" && profile.name === "fixture");
  native.saveSubagentProfile(cwd, "global", { ...existing, description: "UI changed" });
  assert.throws(() => mutate("delete", { name: "fixture" }, enabled.revision), fails("revision_conflict"));
  const removed = mutate("delete", { name: "fixture" });
  assert.equal(removed.changed, true); assert.deepEqual(removed.value.profiles, []);
  assert.equal(mutate("delete", { name: "fixture" }).changed, false);
});

test("writer profiles also default to background execution", () => {
  const first = mutate("upsert", { ...fixture, name: "writer-fixture", tools: ["edit"] });
  assert.equal(first.value.profiles[0].defaultAsync, true);
  mutate("delete", { name: "writer-fixture" }, first.revision);
});

test("native UI and managed profile writes share the scope lock", () => {
  const revision = inspect().revision;
  const release = lockfile.lockSync(join(agentDir, "agents"), { realpath: false });
  try {
    assert.throws(() => mutate("upsert", fixture, revision), fails("configuration_busy"));
    assert.throws(() => native.saveSubagentProfile(cwd, "global", { ...fixture, displayName: "Fixture", scope: "global" }), fails("configuration_busy"));
  } finally { release(); }
});

test("project profile CRUD requires existing trust and never modifies global profiles", () => {
  const revision = inspect("project").revision;
  assert.throws(() => mutate("upsert", fixture, revision, "project"), fails("project_untrusted"));
  assert.deepEqual(readdirSync(cwd), []);
  trust.set(cwd, true);
  const globalRevision = inspect().revision;
  const saved = mutate("upsert", fixture, revision, "project");
  assert.equal(saved.value.profiles[0].scope, "project");
  assert.equal(inspect().revision, globalRevision);
  trust.set(cwd, false);
  assert.throws(() => mutate("delete", { name: "fixture" }, saved.revision, "project"), fails("project_untrusted"));
  trust.set(cwd, true);
  mutate("delete", { name: "fixture" }, saved.revision, "project");
});

test("profile validation rejects traversal, unknown fields, implicit tools and unsafe scope links", () => {
  for (const changes of [{ ...fixture, name: "../escape" }, { ...fixture, tools: undefined }, { ...fixture, tools: ["external_tool"] }, { ...fixture, credentials: "fixture" }, { ...fixture, enabled: "true" }]) {
    assert.throws(() => contract.validateManagedProfileChange({ ...target(), operation: "upsert", changes }), fails("invalid_changes"));
  }
  const outside = join(root, "outside.md"); writeFileSync(outside, "Fixture.");
  symlinkSync(outside, join(agentDir, "agents", "linked.md"));
  try { assert.throws(() => inspect(), fails("unsupported_path")); }
  finally { rmSync(join(agentDir, "agents", "linked.md")); }
});
