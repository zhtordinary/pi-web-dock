import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";
import { createSealedPublicInputEnvironment, loadCurrentNativeDiscovery } from "../test-support/sealed-public-inputs.mjs";
import { currentPiPackage } from "../test-support/current-pi-package.mjs";

const nativeIntegrationTest = process.env.READER_TEST_PI_AGENT_DIR && process.env.READER_TEST_PI_PACKAGE_MANIFEST ? test : test.skip;
const sealed = await createSealedPublicInputEnvironment("profiles");
after(async () => {
  try {
    if (nativeSnapshot) {
      assert.deepEqual(currentPiPackage("pi-subagents"), nativeSnapshot.package);
      assert.equal(createHash("sha256").update(fs.readFileSync(nativeSnapshot.nativePath)).digest("hex"), nativeSnapshot.fingerprint);
    }
  } finally {
    await sealed.restore();
  }
});
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const { getSubagentSettings, setSubagentSettings, writeBuiltInSubagentOverride } = jiti("./subagent-settings.ts");
const { writePiSubagentOverride } = jiti("./pi-subagent-settings.ts");
const { listSubagentProfiles, saveSubagentProfile, deleteSubagentProfile } = jiti("./subagent-profiles.ts");
const { resolveSubagentProfile, subagentExtensionLoaderOptions } = jiti("./subagents.ts");
let nativeDiscovery;
let nativeSnapshot;
async function ensureNativeDiscovery() {
  if (!nativeDiscovery) {
    const { native, nativePath, fingerprint, ...currentPackage } = await loadCurrentNativeDiscovery();
    nativeDiscovery = native;
    nativeSnapshot = { package: currentPackage, nativePath, fingerprint };
  }
  return nativeDiscovery;
}
function clearAgentDiscoveryCache() {
  nativeDiscovery?.clearAgentDiscoveryCache();
}
function discoverAgents(...args) {
  assert.ok(nativeDiscovery, "native discovery must be loaded by native integration tests");
  return nativeDiscovery.discoverAgents(...args);
}

test("getSubagentSettings returns defaults when file does not exist", () => {
  const tempFile = path.join(os.tmpdir(), `subagent-settings-${Date.now()}.json`);
  const settings = getSubagentSettings(tempFile);
  assert.equal(settings.builtInEnabled, false);
});

test("setSubagentSettings updates and persists builtInEnabled", () => {
  const tempFile = path.join(os.tmpdir(), `subagent-settings-${Date.now()}.json`);
  try {
    const updated = setSubagentSettings(true, tempFile);
    assert.equal(updated.builtInEnabled, true);
    const reloaded = getSubagentSettings(tempFile);
    assert.equal(reloaded.builtInEnabled, true);
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
});

test("listSubagentProfiles includes builtin profiles", () => {
  const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-subagent-test-"));
  try {
    const profiles = listSubagentProfiles(tempCwd);
    const names = profiles.map((p) => p.name);
    assert.ok(names.includes("general-purpose"));
    assert.ok(names.includes("explore"));
    assert.ok(names.includes("plan"));
    const general = profiles.find((p) => p.name === "general-purpose");
    const explore = profiles.find((p) => p.name === "explore");
    const plan = profiles.find((p) => p.name === "plan");
    assert.equal(general?.builtinKind, "reader");
    assert.deepEqual({ project: general?.inheritProjectContext, global: general?.inheritGlobalContext, skills: general?.inheritSkills, async: general?.defaultAsync, runInBackground: general?.reader?.runInBackground, loadSkills: general?.reader?.loadSkills, loadExtensions: general?.reader?.loadExtensions, codemode: general?.reader?.codemode, mcp: general?.reader?.mcp }, { project: true, global: true, skills: true, async: true, runInBackground: true, loadSkills: true, loadExtensions: true, codemode: "inherit", mcp: "on" });
    for (const profile of [explore, plan]) {
      assert.deepEqual({ project: profile?.inheritProjectContext, global: profile?.inheritGlobalContext, skills: profile?.inheritSkills, async: profile?.defaultAsync, maxTurns: profile?.reader?.maxTurns, loadSkills: profile?.reader?.loadSkills, loadExtensions: profile?.reader?.loadExtensions, codemode: profile?.reader?.codemode, mcp: profile?.reader?.mcp, tools: profile?.tools }, { project: false, global: false, skills: true, async: true, maxTurns: undefined, loadSkills: true, loadExtensions: true, codemode: "inherit", mcp: "on", tools: ["read", "grep", "find", "ls"] });
    }
  } finally {
    fs.rmSync(tempCwd, { recursive: true, force: true });
  }
});

nativeIntegrationTest("runtime package profiles expose a native override without entering Reader-owned scopes", async () => {
  const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-subagent-test-"));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-agent-dir-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const packageRoot = path.join(agentDir, "npm", "node_modules", "pi-subagents");
    const packageAgentsDir = path.join(packageRoot, "agents");
    fs.mkdirSync(packageAgentsDir, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "pi-subagents",
      version: "test",
      "pi-subagents": { agents: ["agents"] },
    }));
    fs.writeFileSync(path.join(packageAgentsDir, "worker.md"), `---
name: worker
description: Implementation agent
thinking: high
---

Implement the assigned task carefully.
`);

    let worker = listSubagentProfiles(tempCwd).find((profile) => profile.name === "worker");
    assert.ok(worker);
    assert.equal(worker.scope, "runtime");
    assert.equal(worker.runtimeKind, "native");
    assert.equal(worker.modelSource, "parent");
    assert.equal(worker.thinking, "high");

    writePiSubagentOverride("worker", { model: "provider/model", thinking: "medium" }, agentDir);
    worker = listSubagentProfiles(tempCwd).find((profile) => profile.name === "worker");
    assert.equal(worker?.model, "provider/model");
    assert.equal(worker?.modelSource, "override");
    assert.equal(worker?.thinking, "medium");

    writePiSubagentOverride("worker", { thinking: false }, agentDir);
    worker = listSubagentProfiles(tempCwd).find((profile) => profile.name === "worker");
    assert.equal(worker?.thinking, undefined);
    assert.equal(worker?.thinkingOverride, false);

    await ensureNativeDiscovery();
    clearAgentDiscoveryCache();
    const discovered = discoverAgents(tempCwd, "user", undefined, { globalNpmRoot: "" });
    const resolved = discovered.agents.find((agent) => agent.name === "worker");
    assert.ok(resolved, JSON.stringify(discovered.diagnostics));
    assert.equal(resolved.thinking, undefined);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(tempCwd, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Reader migrates native runtime resource opt-outs without widening external CLI profiles", () => {
  const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-subagent-resource-migration-"));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-agent-dir-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const packageRoot = path.join(agentDir, "npm", "node_modules", "pi-subagents");
    const packageAgentsDir = path.join(packageRoot, "agents");
    fs.mkdirSync(packageAgentsDir, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "pi-subagents",
      version: "test",
      "pi-subagents": { agents: ["agents"] },
    }));
    fs.writeFileSync(path.join(packageAgentsDir, "legacy-native.md"), `---
name: legacy-native
tools: read
inheritSkills: false
reader:
  loadSkills: false
  loadExtensions: false
  mcp: off
---
Native profile.
`);
    fs.writeFileSync(path.join(packageAgentsDir, "external-cli.md"), `---
name: external-cli
inheritSkills: false
runner:
  type: external-cli
  adapter: claude-code-writer
  command: claude
reader:
  loadSkills: false
  loadExtensions: false
  mcp: off
---
External profile.
`);

    const profiles = listSubagentProfiles(tempCwd);
    const native = profiles.find((profile) => profile.name === "legacy-native");
    const external = profiles.find((profile) => profile.name === "external-cli");
    assert.deepEqual({ kind: native?.runtimeKind, skills: native?.inheritSkills, loadSkills: native?.reader?.loadSkills, loadExtensions: native?.reader?.loadExtensions, mcp: native?.reader?.mcp }, { kind: "native", skills: true, loadSkills: true, loadExtensions: true, mcp: "on" });
    assert.deepEqual({ kind: external?.runtimeKind, skills: external?.inheritSkills, loadSkills: external?.reader?.loadSkills, loadExtensions: external?.reader?.loadExtensions, mcp: external?.reader?.mcp }, { kind: "external-cli", skills: false, loadSkills: false, loadExtensions: false, mcp: "off" });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(tempCwd, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Reader built-in model overrides are persisted separately from profile files", () => {
  const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-subagent-test-"));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-agent-dir-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    writeBuiltInSubagentOverride("explore", { model: "provider/explore", thinking: "low" });
    const explore = listSubagentProfiles(tempCwd).find((profile) => profile.name === "explore");
    assert.equal(explore?.scope, "builtin");
    assert.equal(explore?.model, "provider/explore");
    assert.equal(explore?.modelSource, "override");
    assert.equal(explore?.thinking, "low");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(tempCwd, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("project and workspace agent scans retain their source scopes", () => {
  const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-subagent-test-"));
  try {
    const projectDir = path.join(tempCwd, ".pi", "agents");
    const workspaceDir = path.join(tempCwd, ".agents", "agents");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "project-only.md"), "---\ndescription: Project agent\n---\nProject prompt.\n");
    fs.writeFileSync(path.join(workspaceDir, "workspace-only.md"), "---\ndescription: Workspace agent\n---\nWorkspace prompt.\n");

    const profiles = listSubagentProfiles(tempCwd);
    const project = profiles.find((p) => p.name === "project-only");
    const workspace = profiles.find((p) => p.name === "workspace-only");
    assert.ok(project);
    assert.equal(project.scope, "project");
    assert.equal(project.filePath, path.join(projectDir, "project-only.md"));
    assert.ok(workspace);
    assert.equal(workspace.scope, "workspace");
    assert.equal(workspace.filePath, path.join(workspaceDir, "workspace-only.md"));
  } finally {
    fs.rmSync(tempCwd, { recursive: true, force: true });
  }
});

test("saveSubagentProfile writes frontmatter and markdown body in project scope", () => {
  const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-subagent-test-"));
  try {
    const saved = saveSubagentProfile(tempCwd, "project", {
      name: "test-bot",
      displayName: "Test Bot",
      description: "A bot for testing",
      systemPrompt: "You are a test bot.",
      tools: ["read", "bash"],
      enabled: true,
      defaultContext: "fresh",
      defaultAsync: true,
      inheritProjectContext: false,
      inheritGlobalContext: false,
      inheritSkills: false,
      scope: "project",
    });

    assert.equal(saved.name, "test-bot");
    assert.equal(saved.scope, "project");
    assert.ok(saved.filePath && fs.existsSync(saved.filePath));

    const content = fs.readFileSync(saved.filePath, "utf8");
    assert.match(content, /name: test-bot/);
    assert.match(content, /display_name: Test Bot/);
    assert.match(content, /tools: read, bash/);
    assert.match(content, /systemPromptMode: replace/);
    assert.match(content, /inheritProjectContext: false/);
    assert.match(content, /^defaultContext: fresh$/m);
    assert.match(content, /^async: true$/m);
    assert.doesNotMatch(content, /load_skills|load_extensions|inherit_context|run_in_background|max_turns/);
    assert.match(content, /You are a test bot\./);

    const reloaded = listSubagentProfiles(tempCwd);
    const found = reloaded.find((p) => p.name === "test-bot");
    assert.ok(found);
    assert.equal(found.displayName, "Test Bot");
    assert.deepEqual(found.tools, ["read", "bash"]);
    assert.equal(found.defaultAsync, true);
    assert.equal(found.defaultContext, "fresh");

    deleteSubagentProfile(tempCwd, "project", "test-bot");
    assert.equal(fs.existsSync(saved.filePath), false);
  } finally {
    fs.rmSync(tempCwd, { recursive: true, force: true });
  }
});

nativeIntegrationTest("saving a native Agent preserves inherited tools and unexposed frontmatter", () => {
  const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-subagent-native-cwd-"));
  const tempAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-subagent-native-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tempAgentDir;
  try {
    const agentDir = path.join(tempAgentDir, "agents");
    fs.mkdirSync(agentDir, { recursive: true });
    const filePath = path.join(agentDir, "native-preserve.md");
    fs.writeFileSync(filePath, `---
name: native-preserve
description: Preserve native fields
aliases: [native-alias]
extensions: ./child-tools.ts
async: true
defaultContext: fork
systemPromptMode: append
inheritProjectContext: true
inheritGlobalContext: true
inheritSkills: true
---
Original native prompt.
`);

    const profile = listSubagentProfiles(tempCwd).find((candidate) => candidate.name === "native-preserve");
    assert.ok(profile);
    assert.equal(profile.toolsExplicit, false);
    assert.equal(profile.systemPromptMode, "append");
    assert.equal(profile.defaultAsync, true);
    assert.equal(profile.defaultContext, "fork");
    assert.equal(profile.inheritGlobalContext, true);
    assert.equal(profile.inheritSkills, true);

    saveSubagentProfile(tempCwd, "global", { ...profile, systemPrompt: "Edited through the panel." });
    let content = fs.readFileSync(filePath, "utf8");
    assert.doesNotMatch(content, /^tools:/m);
    assert.match(content, /^aliases:/m);
    assert.match(content, /native-alias/);
    assert.match(content, /^extensions: \.\/child-tools\.ts$/m);
    assert.match(content, /^async: true$/m);
    assert.match(content, /^defaultContext: fork$/m);
    assert.match(content, /^systemPromptMode: append$/m);
    assert.match(content, /^inheritGlobalContext: true$/m);
    assert.match(content, /^reader:/m);
    assert.match(content, /Edited through the panel\./);

    clearAgentDiscoveryCache();
    const rediscovered = discoverAgents(tempCwd, "user", undefined, { globalNpmRoot: "" });
    assert.ok(rediscovered.agents.some((agent) => agent.name === "native-preserve"), JSON.stringify(rediscovered.diagnostics));

    const legacyClientProfile = { ...profile };
    delete legacyClientProfile.toolsExplicit;
    saveSubagentProfile(tempCwd, "global", { ...legacyClientProfile, systemPrompt: "Edited by an older panel." });
    content = fs.readFileSync(filePath, "utf8");
    assert.doesNotMatch(content, /^tools:/m);

    fs.writeFileSync(filePath, `---
name: native-preserve
description: Preserve native fields
tools: read, mcp:github/search
---
Native tool prompt.
`);
    const explicit = listSubagentProfiles(tempCwd).find((candidate) => candidate.name === "native-preserve");
    assert.ok(explicit);
    assert.equal(explicit.toolsExplicit, true);
    assert.deepEqual(explicit.tools, ["read", "mcp:github/search"]);
    saveSubagentProfile(tempCwd, "global", { ...explicit, systemPrompt: "Keep the MCP tool." });
    content = fs.readFileSync(filePath, "utf8");
    assert.match(content, /mcp:github\/search/);
    assert.doesNotMatch(content, /fallbackModels/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    clearAgentDiscoveryCache();
    fs.rmSync(tempCwd, { recursive: true, force: true });
    fs.rmSync(tempAgentDir, { recursive: true, force: true });
  }
});

test("Reader options preserve explicit false, legacy resource semantics and prompt defaults", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-subagent-reader-compat-"));
  try {
    const dir = path.join(cwd, ".pi", "agents");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "explicit.md"), `---
name: explicit
async: true
defaultContext: fork
systemPromptMode: replace
reader:
  inheritContext: false
  runInBackground: false
  maxTurns: 7
  futurePolicy: retained
---
Prompt.
`);
    fs.writeFileSync(path.join(dir, "legacy.md"), `---
name: legacy
async: false
tools: read, ext:advisor
skills: [review]
codemode: true
mcp: true
---
Prompt.
`);

    const listed = listSubagentProfiles(cwd);
    const explicit = listed.find((profile) => profile.name === "explicit");
    assert.ok(explicit);
    assert.equal(explicit.defaultContext, "fork");
    assert.equal(explicit.defaultAsync, true);
    assert.equal(explicit.reader.inheritContext, true, "canonical context wins over the old nested Reader value");
    assert.equal(explicit.reader.runInBackground, true, "canonical async value wins over the old nested Reader value");
    assert.equal(resolveSubagentProfile(cwd, "explicit").promptMode, "append");
    const cleared = JSON.parse(JSON.stringify({ ...explicit, reader: { ...explicit.reader, maxTurns: undefined } }));
    saveSubagentProfile(cwd, "project", cleared);
    const migrated = fs.readFileSync(path.join(dir, "explicit.md"), "utf8");
    assert.match(migrated, /^defaultContext: fork$/m);
    assert.match(migrated, /^async: true$/m);
    assert.doesNotMatch(migrated, /^  inheritContext:|^  runInBackground:/m, "unified settings remove duplicate Reader fields");
    const resolved = resolveSubagentProfile(cwd, "explicit");
    assert.equal(resolved.inheritContext, true);
    assert.equal(resolved.runInBackground, true);
    assert.equal(resolved.maxTurns, undefined);
    assert.equal(resolved.promptMode, "append");
    assert.match(migrated, /futurePolicy: retained/);

    const legacy = listed.find((profile) => profile.name === "legacy");
    assert.ok(legacy);
    assert.equal(legacy.reader.loadSkills, true);
    assert.equal(legacy.reader.loadExtensions, true);
    assert.equal(legacy.reader.codemode, "on");
    assert.equal(legacy.reader.mcp, "on");
    const before = resolveSubagentProfile(cwd, "legacy");
    assert.equal(before.loadSkills, true);
    assert.equal(before.loadExtensions, true);
    assert.equal(before.codemode, "on");
    assert.equal(before.mcp, "on");
    saveSubagentProfile(cwd, "project", legacy);
    const after = resolveSubagentProfile(cwd, "legacy");
    assert.equal(after.loadSkills, true);
    assert.equal(after.loadExtensions, true);
    assert.equal(after.codemode, "on");
    assert.equal(after.mcp, "on");
    assert.deepEqual(after.extensionTools, ["ext:advisor"]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("Reader resource aliases keep selectors, explicit opt-outs, and legacy spellings", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-subagent-resource-matrix-"));
  try {
    const dir = path.join(cwd, ".pi", "agents");
    fs.mkdirSync(dir, { recursive: true });
    const cases = [
      { name: "selector", fields: "tools: read, ext:advisor\nasync: false", skills: true, extensions: true },
      { name: "arrays", fields: "skills: [review]\nextensions: [advisor]\nasync: false", skills: true, extensions: true },
      { name: "disabled", fields: "skills: [review]\nextensions: [advisor]\nreader:\n  loadSkills: false\n  loadExtensions: false", skills: false, extensions: false },
      { name: "legacy-off", fields: "skills: off", skills: true, extensions: true },
      { name: "projected-off", fields: "skills: off\nasync: false", skills: false, extensions: true },
    ];
    for (const item of cases) {
      fs.writeFileSync(path.join(dir, `${item.name}.md`), `---\nname: ${item.name}\n${item.fields}\n---\nPrompt.\n`);
      const panel = listSubagentProfiles(cwd).find((profile) => profile.name === item.name);
      const runtime = resolveSubagentProfile(cwd, item.name);
      assert.equal(panel.reader.loadSkills, item.skills, item.name);
      assert.equal(panel.reader.loadExtensions, item.extensions, item.name);
      assert.equal(runtime.loadSkills, item.skills, item.name);
      assert.equal(runtime.loadExtensions, item.extensions, item.name);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("duplicating a profile retains unexposed constraints without overwriting a target", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-subagent-copy-"));
  try {
    const dir = path.join(cwd, ".pi", "agents");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "scoped.md"), `---
name: scoped
tools: read
load_extensions: true
extensions: [advisor]
skills: [review]
disallowed_tools: ext:advisor/secret
allowed_subagents: [reviewer]
---
Prompt.
`);
    const original = listSubagentProfiles(cwd).find((profile) => profile.name === "scoped");
    assert.ok(original);
    const copy = { ...original, name: "scoped-copy", copyFrom: { scope: "project", name: "scoped" } };
    saveSubagentProfile(cwd, "project", copy);
    const copied = resolveSubagentProfile(cwd, "scoped-copy");
    assert.deepEqual(copied.extensions, ["advisor"]);
    assert.deepEqual(copied.skills, ["review"]);
    assert.deepEqual(copied.disallowedExtensionTools, ["ext:advisor/secret"]);
    assert.equal(copied.loadExtensions, true);
    const content = fs.readFileSync(path.join(dir, "scoped-copy.md"), "utf8");
    assert.match(content, /allowed_subagents:/);
    const restrict = subagentExtensionLoaderOptions(copied).extensionsOverride;
    assert.equal(typeof restrict, "function");
    const extensions = [
      { path: "/tmp/advisor/index.ts", tools: new Map() },
      { path: "/tmp/other/index.ts", tools: new Map() },
    ];
    assert.deepEqual(restrict({ extensions }).extensions.map((item) => item.path), ["/tmp/advisor/index.ts"]);
    assert.throws(() => saveSubagentProfile(cwd, "project", copy), /exist/i);
    assert.throws(() => saveSubagentProfile(cwd, "project", { ...copy, name: "missing-copy", copyFrom: { scope: "project", name: "missing" } }), /not found|missing/i);
    assert.throws(() => saveSubagentProfile(cwd, "project", { ...copy, name: "escape-copy", copyFrom: { scope: "project", name: "../escape" } }), /name may contain/i);
    assert.throws(() => saveSubagentProfile(cwd, "project", { ...copy, name: "builtin-copy", copyFrom: { scope: "builtin", name: "missing" } }), /not found/i);
    const builtin = listSubagentProfiles(cwd).find((profile) => profile.scope === "builtin" && profile.name === "explore");
    assert.ok(builtin);
    const builtinCopy = { ...builtin, name: "explore-copy", scope: "project", copyFrom: { scope: "builtin", name: "explore" } };
    saveSubagentProfile(cwd, "project", builtinCopy);
    assert.throws(() => saveSubagentProfile(cwd, "project", builtinCopy), /exist/i);
    fs.symlinkSync(path.join(dir, "scoped.md"), path.join(dir, "link.md"));
    assert.throws(() => saveSubagentProfile(cwd, "project", { ...copy, name: "link-copy", copyFrom: { scope: "project", name: "link" } }), /not found|symbolic|symlink/i);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("legacy Reader controls migrate to native pi-subagents fields on save", () => {
  const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-subagent-legacy-controls-"));
  try {
    const filePath = path.join(tempCwd, ".pi", "agents", "legacy-controls.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `---
name: legacy-controls
description: Legacy controls
tools: read
load_skills: true
load_extensions: true
inherit_context: true
run_in_background: true
max_turns: 12
---

Legacy prompt.
`);

    const listed = listSubagentProfiles(tempCwd).find((candidate) => candidate.name === "legacy-controls");
    assert.ok(listed);
    assert.equal(listed.defaultContext, "fork");
    assert.equal(listed.defaultAsync, true);
    assert.equal(listed.inheritSkills, true);

    saveSubagentProfile(tempCwd, "project", listed);
    const migrated = fs.readFileSync(filePath, "utf8");
    assert.match(migrated, /^defaultContext: fork$/m);
    assert.match(migrated, /^async: true$/m);
    assert.match(migrated, /^inheritSkills: true$/m);
    assert.match(migrated, /^reader:/m);
    assert.match(migrated, /^  loadSkills: true$/m);
    assert.match(migrated, /^  maxTurns: 12$/m);
    assert.doesNotMatch(migrated, /^  inheritContext:|^  runInBackground:/m);
    assert.doesNotMatch(migrated, /^load_skills:|^load_extensions:|^inherit_context:|^run_in_background:|^max_turns:/m);
  } finally {
    fs.rmSync(tempCwd, { recursive: true, force: true });
  }
});

test("legacy Reader context and background fields migrate to unified profile defaults", () => {
  const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-subagent-reader-unified-migration-"));
  try {
    const filePath = path.join(tempCwd, ".pi", "agents", "reader-only-controls.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `---
name: reader-only-controls
description: Reader-only controls
reader:
  inheritContext: true
  runInBackground: true
  maxTurns: 4
---

Reader-only prompt.
`);

    const listed = listSubagentProfiles(tempCwd).find((candidate) => candidate.name === "reader-only-controls");
    assert.ok(listed);
    assert.equal(listed.defaultContext, "fork");
    assert.equal(listed.defaultAsync, true);

    saveSubagentProfile(tempCwd, "project", listed);
    const migrated = fs.readFileSync(filePath, "utf8");
    assert.match(migrated, /^defaultContext: fork$/m);
    assert.match(migrated, /^async: true$/m);
    assert.match(migrated, /^  maxTurns: 4$/m);
    assert.doesNotMatch(migrated, /^  inheritContext:|^  runInBackground:/m);

    const resolved = resolveSubagentProfile(tempCwd, "reader-only-controls");
    assert.equal(resolved.inheritContext, true);
    assert.equal(resolved.runInBackground, true);
  } finally {
    fs.rmSync(tempCwd, { recursive: true, force: true });
  }
});

test("a legacy fallbackModels key is dropped on save instead of resurrected", () => {
  const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-subagent-legacy-"));
  try {
    // The key must sit INSIDE a valid frontmatter block: patching the fences
    // would make parseFrontmatter return null and pass without exercising the
    // deletion path at all.
    const filePath = path.join(tempCwd, ".pi", "agents", "legacy-fallback.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `---
name: legacy-fallback
description: Legacy Fallback
tools: read
fallbackModels:
  - provider/backup
fallback_models:
  - provider/backup-two
acceptanceRole: read-only
---

Legacy prompt.
`);

    const listed = listSubagentProfiles(tempCwd).find((candidate) => candidate.name === "legacy-fallback");
    assert.ok(listed, "a legacy file must still be listed");
    assert.equal(listed.fallbackModels, undefined, "the removed field must not be surfaced");

    const saved = saveSubagentProfile(tempCwd, "project", { ...listed, systemPrompt: "edited" });
    assert.equal(saved.fallbackModels, undefined, "the removed field must not be echoed back");

    const cleaned = fs.readFileSync(filePath, "utf8");
    assert.doesNotMatch(cleaned, /fallbackModels/, "the removed field must not be re-written");
    assert.doesNotMatch(cleaned, /fallback_models/);
    assert.match(cleaned, /^tools: read$/m, "unrelated metadata must be preserved");
    assert.match(cleaned, /^acceptanceRole: read-only$/m);
    assert.match(cleaned, /^name: legacy-fallback$/m);
    assert.match(cleaned, /edited/, "the edited prompt must be saved");
  } finally {
    fs.rmSync(tempCwd, { recursive: true, force: true });
  }
});

test("a stale client cannot resurrect the removed field through the save API", () => {
  const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-subagent-stale-client-"));
  try {
    // The PUT route forwards runtime JSON straight through, so the removal
    // contract must hold even when the caller still sends the old field.
    const saved = saveSubagentProfile(tempCwd, "project", {
      name: "stale-client",
      displayName: "Stale Client",
      description: "d",
      systemPrompt: "p",
      tools: ["read"],
      enabled: true,
      defaultContext: "fresh",
      defaultAsync: false,
      inheritProjectContext: false,
      inheritGlobalContext: false,
      inheritSkills: false,
      scope: "project",
      model: "anthropic/claude-sonnet-4",
      fallbackModels: ["openai-codex/gpt-5.6-luna:low"],
    });
    assert.equal(saved.fallbackModels, undefined, "the removed field must not be returned");
    const content = fs.readFileSync(saved.filePath, "utf8");
    assert.doesNotMatch(content, /fallbackModels/);
    // An unrelated, still-supported field must survive the strict return shape.
    assert.match(content, /^model: anthropic\/claude-sonnet-4$/m);
  } finally {
    fs.rmSync(tempCwd, { recursive: true, force: true });
  }
});

nativeIntegrationTest("global save preserves native Agent identity and is discoverable by pi-subagents", async () => {
  const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-subagent-global-cwd-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = sealed.agentDir;
  try {
    await sealed.linkInstalledPiSubagents(sealed.agentDir);
    await ensureNativeDiscovery();
    const saved = saveSubagentProfile(tempCwd, "global", {
      name: "plan-execute-planner",
      displayName: "Plan Execute Planner",
      description: "Plan an approved task",
      systemPrompt: "Read the project and write a plan.",
      tools: ["read", "write"],
      enabled: true,
      defaultContext: "fork",
      defaultAsync: false,
      inheritProjectContext: true,
      inheritGlobalContext: false,
      inheritSkills: false,
      scope: "global",
      model: "CPA GPT/gpt-6-astra",
      thinking: "low",
      systemPromptMode: "replace",
      inheritProjectContext: true,
      inheritGlobalContext: false,
      inheritSkills: false,
      acceptanceRole: "read-only",
    });

    const content = fs.readFileSync(saved.filePath, "utf8");
    assert.match(content, /^name: plan-execute-planner$/m);
    assert.match(content, /^model: CPA GPT\/gpt-6-astra$/m);
    assert.match(content, /^thinking: low$/m);
    assert.doesNotMatch(content, /fallbackModels/);

    clearAgentDiscoveryCache();
    const discovered = discoverAgents(tempCwd, "user", undefined, { globalNpmRoot: "" });
    const agent = discovered.agents.find((candidate) => candidate.name === "plan-execute-planner");
    assert.ok(agent, JSON.stringify(discovered.diagnostics));
    assert.equal(agent.source, "user");
    assert.equal(agent.model, "CPA GPT/gpt-6-astra");
    assert.equal(agent.thinking, "low");
    assert.equal(agent.systemPromptMode, "replace");
    assert.equal(agent.defaultContext, "fork");
    assert.equal(agent.defaultAsync, false);
    assert.equal(agent.inheritProjectContext, true);
    assert.equal(agent.acceptanceRole, "read-only");
    assert.equal(agent.systemPrompt, "Read the project and write a plan.");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    clearAgentDiscoveryCache();
    fs.rmSync(tempCwd, { recursive: true, force: true });
  }
});

nativeIntegrationTest("native catalog separates editable overrides from effective defaults and sentinels", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-subagent-native-resolution-"));
  const agentDir = sealed.agentDir;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await ensureNativeDiscovery();
    const packageDir = path.join(agentDir, "npm", "node_modules", "pi-subagents", "agents");
    assert.ok(fs.existsSync(path.join(packageDir, "worker.md")), "current package worker profile must be present");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
      subagents: {
        defaultModel: "user-default",
        defaultProvider: "user-provider",
        defaultThinking: "low",
        agentOverrides: { worker: { thinking: "medium" } },
        agentOverridesByProvider: { "context-provider": { worker: { model: "context-model" } } },
      },
    }));
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({
      subagents: { agentOverrides: { worker: { thinking: false } } },
    }));

    let worker = listSubagentProfiles(cwd, { parentProvider: "context-provider" }).find((profile) => profile.name === "worker");
    assert.ok(worker);
    assert.equal(worker.model, undefined, "bare effective IDs are not promoted to provider/model");
    assert.equal(worker.modelId, "context-model");
    assert.equal(worker.modelProvider, "user-provider");
    assert.equal(worker.modelSource, "override");
    assert.equal(worker.modelSourceScope, "provider");
    assert.equal(worker.modelOverride, undefined, "provider-scoped effective values are not editable user overrides");
    assert.equal(worker.thinking, undefined);
    assert.equal(worker.thinkingOverride, "medium");

    clearAgentDiscoveryCache();
    const upstream = discoverAgents(cwd, "both", "context-provider", { globalNpmRoot: "" }).agents.find((profile) => profile.name === "worker");
    assert.ok(upstream, "upstream resolver discovers the same physical package profile");
    assert.equal(upstream.name, "worker");
    // Reader retains the provider-scoped model ID/source distinction above.
    assert.equal(upstream.model, worker.modelId);
    assert.equal(upstream.modelProvider, "user-provider");
    assert.equal(upstream.thinking, undefined);

    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
      subagents: { agentOverrides: { worker: { thinking: "medium" } } },
    }));
    fs.rmSync(path.join(cwd, ".pi", "settings.json"));
    worker = listSubagentProfiles(cwd).find((profile) => profile.name === "worker");
    assert.ok(worker);
    assert.equal(worker.model, undefined, "the worker has a bare effective default ID");
    assert.equal(worker.modelId, undefined);
    assert.equal(worker.modelProvider, undefined);
    assert.equal(worker.modelSource, "parent");
    assert.equal(worker.thinking, "medium");
    assert.equal(worker.modelOverride, undefined);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    clearAgentDiscoveryCache();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("project profile symlink escape is rejected without touching the external file", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-subagent-project-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-subagent-project-outside-"));
  try {
    const outsideFile = path.join(outside, "outside.md");
    fs.writeFileSync(outsideFile, "---\ndescription: outside\n---\nexternal\n");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.symlinkSync(outside, path.join(cwd, ".pi", "agents"), "dir");
    const before = fs.readFileSync(outsideFile, "utf8");
    assert.equal(listSubagentProfiles(cwd).some((profile) => profile.name === "outside"), false);
    assert.throws(() => saveSubagentProfile(cwd, "project", {
      name: "escape",
      displayName: "Escape",
      description: "escape",
      systemPrompt: "escape",
      tools: ["read"],
      enabled: true,
      defaultContext: "fresh",
      defaultAsync: false,
      inheritProjectContext: false,
      inheritGlobalContext: false,
      inheritSkills: false,
      scope: "project",
    }), /outside the project root/);
    assert.equal(fs.readFileSync(outsideFile, "utf8"), before);
    assert.throws(() => deleteSubagentProfile(cwd, "project", "outside"), /outside the project root/);
    assert.equal(fs.readFileSync(outsideFile, "utf8"), before);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
