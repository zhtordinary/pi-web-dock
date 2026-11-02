import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";
import { createSealedPublicInputEnvironment, loadPinnedNativeDiscovery } from "../test-support/sealed-public-inputs.mjs";

const sealed = await createSealedPublicInputEnvironment("profiles");
after(() => sealed.restore());
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const { getSubagentSettings, setSubagentSettings, writeBuiltInSubagentOverride } = jiti("./subagent-settings.ts");
const { writePiSubagentOverride } = jiti("./pi-subagent-settings.ts");
const { listSubagentProfiles, saveSubagentProfile, deleteSubagentProfile } = jiti("./subagent-profiles.ts");
let nativeDiscovery;
async function ensureNativeDiscovery() {
  if (!nativeDiscovery) nativeDiscovery = (await loadPinnedNativeDiscovery()).native;
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
    assert.equal(profiles.find((p) => p.name === "general-purpose")?.builtinKind, "reader");
  } finally {
    fs.rmSync(tempCwd, { recursive: true, force: true });
  }
});

test("runtime package profiles expose a native override without entering Reader-owned scopes", async () => {
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

test("saving a native Agent preserves inherited tools and unexposed frontmatter", () => {
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
    assert.match(content, /Edited through the panel\./);

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
    assert.doesNotMatch(migrated, /load_skills|load_extensions|inherit_context|run_in_background|max_turns/);
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

test("global save preserves native Agent identity and is discoverable by pi-subagents", async () => {
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

test("native catalog separates editable overrides from effective defaults and sentinels", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-subagent-native-resolution-"));
  const agentDir = sealed.agentDir;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await ensureNativeDiscovery();
    const packageDir = path.join(agentDir, "npm", "node_modules", "pi-subagents", "agents");
    assert.ok(fs.existsSync(path.join(packageDir, "worker.md")), "pinned package worker profile must be present");
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
    // pi-subagents@0.74.0 exposes its effective default model while Reader
    // retains the provider-scoped model ID/source distinction above.
    assert.equal(upstream.model, "user-default");
    assert.equal(upstream.modelProvider, "user-provider");
    assert.equal(upstream.thinking, undefined);

    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
      subagents: { agentOverrides: { worker: { thinking: "medium" } } },
    }));
    fs.rmSync(path.join(cwd, ".pi", "settings.json"));
    worker = listSubagentProfiles(cwd).find((profile) => profile.name === "worker");
    assert.ok(worker);
    assert.equal(worker.model, undefined, "pinned worker has a bare effective default ID");
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
