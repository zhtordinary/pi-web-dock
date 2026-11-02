import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import {
  fauxProvider,
  fauxText,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const host = await jiti.import("./remote-claude-host.ts");
const { createSubagentExtension } = await jiti.import("./subagent-extension.ts");

const packageRoot = fileURLToPath(new URL("../test-fixtures/pi-remote-claude-contract/", import.meta.url));

test("the isolated remote host tests use the pinned contract snapshot", () => {
  const bytes = readFileSync(join(packageRoot, "lib", "host-contract.mjs"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "f5644dfa67cb4768addd7e13749a38dd59e05bc27f61fd7c988f476fa5e5de26");
});

async function createFixtureSession(dir, faux, extensionFactories = []) {
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const services = await createAgentSessionServices({
    cwd: dir,
    agentDir: dir,
    modelRuntime,
    settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories },
  });
  return createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(dir),
    model: faux.getModel("faux-model"),
  });
}

function removeFixtureDirs(...dirs) {
  // Each argument is an exact mkdtempSync directory; packageRoot is only a child symlink.
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

function disposeSessionsAndRemoveDirs(sessions, ...dirs) {
  try {
    for (const session of sessions) session?.dispose();
  } finally {
    removeFixtureDirs(...dirs);
  }
}

test("remote host scope is opaque and projects only active model-only controls", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-web-remote-host-agent-"));
  mkdirSync(join(agentDir, "packages"), { recursive: true });
  symlinkSync(packageRoot, join(agentDir, "packages", "pi-remote-claude"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-remote-host-cwd-"));
  const faux = fauxProvider({ models: [{ id: "faux-model" }] });
  let session;
  let binding;
  let replacement;
  try {
    const runtime = {
      async start() { throw new Error("fixture start should be called only after model declaration"); },
      async resume() { throw new Error("fixture resume should not be called"); },
      async get() { return null; },
      async steer() {},
      async notifyParent() {},
      markResultConsumed() {},
    };
    ({ session } = await createFixtureSession(cwd, faux, [createSubagentExtension(runtime, () => [])]));
    binding = await host.installRemoteClaudeHost({
      hostIdentity: session,
      sessionManager: session.sessionManager,
      sessionId: session.sessionId,
      cwd,
      agentDir,
      activeTools: ["read", "Agent", "get_subagent_result", "steer_subagent"],
      modelRuntime: session.modelRuntime,
      builtInEnabled: true,
      allowCancellation: true,
    });
    assert.ok(binding);
    assert.equal(binding.policy.orchestration.enabled, true);
    assert.equal(binding.sessionManager, session.sessionManager);
    assert.equal(host.remoteClaudeHostBridge().resolveByManager(session.sessionManager), binding);
    assert.equal(binding.contractVersion, 1);
    assert.throws(() => JSON.stringify(binding.scope), /not serializable/);

    const oldGeneration = binding.generation;
    replacement = await host.installRemoteClaudeHost({
      hostIdentity: session,
      sessionManager: session.sessionManager,
      sessionId: session.sessionId,
      cwd,
      agentDir,
      activeTools: ["read"],
      modelRuntime: session.modelRuntime,
      builtInEnabled: true,
      allowCancellation: true,
      replace: true,
    });
    assert.ok(replacement);
    assert.ok(replacement.generation > oldGeneration);
    assert.equal(host.remoteClaudeHostBridge().resolve(session.sessionId), replacement);
    assert.equal(host.remoteClaudeHostBridge().resolveByHost(session), replacement);
    assert.equal(host.remoteClaudeHostBridge().resolveByManager(session.sessionManager), replacement);
    assert.throws(() => host.assertRemoteClaudeHost(binding, "side-ask"), /no longer current/);
  } finally {
    try {
      host.revokeRemoteClaudeHost(replacement);
      host.revokeRemoteClaudeHost(binding);
      assert.equal(host.remoteClaudeHostBridge().resolve(session?.sessionId ?? ""), undefined);
      assert.equal(host.remoteClaudeHostBridge().resolveByManager(session?.sessionManager), undefined);
    } finally {
      disposeSessionsAndRemoveDirs([session], agentDir, cwd);
    }
  }
});

test("the live manager index and parent generation revoke stale child bindings", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-web-remote-lineage-agent-"));
  mkdirSync(join(agentDir, "packages"), { recursive: true });
  symlinkSync(packageRoot, join(agentDir, "packages", "pi-remote-claude"));
  const parentCwd = mkdtempSync(join(tmpdir(), "pi-web-remote-parent-"));
  const childCwd = mkdtempSync(join(tmpdir(), "pi-web-remote-child-"));
  const faux = fauxProvider({ models: [{ id: "faux-model" }] });
  let parent;
  let child;
  let parentBinding;
  let childBinding;
  let replacement;
  try {
    ({ session: parent } = await createFixtureSession(parentCwd, faux));
    ({ session: child } = await createFixtureSession(childCwd, faux));
    parentBinding = await host.installRemoteClaudeHost({
      hostIdentity: parent, sessionManager: parent.sessionManager, sessionId: parent.sessionId,
      cwd: parentCwd, agentDir, activeTools: ["read", "Agent", "get_subagent_result", "steer_subagent"],
      modelRuntime: parent.modelRuntime, builtInEnabled: true, allowCancellation: true,
    });
    assert.ok(parentBinding);
    childBinding = await host.installRemoteClaudeHost({
      hostIdentity: child, sessionManager: child.sessionManager, sessionId: child.sessionId,
      cwd: childCwd, agentDir, activeTools: ["read"], modelRuntime: child.modelRuntime,
      builtInEnabled: true, parent: parentBinding, allowCancellation: true,
    });
    assert.ok(childBinding);
    assert.equal(host.remoteClaudeHostBridge().resolveByManager(child.sessionManager), childBinding);
    assert.equal(childBinding.parentBinding, parentBinding);
    assert.equal(childBinding.parentGeneration, parentBinding.generation);

    replacement = await host.installRemoteClaudeHost({
      hostIdentity: parent, sessionManager: parent.sessionManager, sessionId: parent.sessionId,
      cwd: parentCwd, agentDir, activeTools: ["read"], modelRuntime: parent.modelRuntime,
      builtInEnabled: true, allowCancellation: true, replace: true,
    });
    assert.ok(replacement);
    assert.notEqual(replacement, parentBinding);
    assert.ok(replacement.generation > parentBinding.generation);
    assert.throws(() => host.assertRemoteClaudeHost(childBinding, "side-ask"), /parent binding/);
  } finally {
    try {
      host.revokeRemoteClaudeHost(replacement);
      host.revokeRemoteClaudeHost(parentBinding);
      host.revokeRemoteClaudeHost(childBinding);
      assert.equal(host.remoteClaudeHostBridge().resolveByManager(child?.sessionManager), undefined);
      assert.equal(host.remoteClaudeHostBridge().resolveByManager(parent?.sessionManager), undefined);
    } finally {
      disposeSessionsAndRemoveDirs([child, parent], agentDir, parentCwd, childCwd);
    }
  }
});

test("provider aliases lease the exact live binding and clean up independently", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-web-remote-association-agent-"));
  mkdirSync(join(agentDir, "packages"), { recursive: true });
  symlinkSync(packageRoot, join(agentDir, "packages", "pi-remote-claude"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-remote-association-cwd-"));
  const faux = fauxProvider({ models: [{ id: "faux-model" }] });
  let session;
  let binding;
  let replacement;
  try {
    ({ session } = await createFixtureSession(cwd, faux));
    binding = await host.installRemoteClaudeHost({
      hostIdentity: session,
      sessionManager: session.sessionManager,
      sessionId: session.sessionId,
      cwd,
      agentDir,
      activeTools: ["read"],
      modelRuntime: session.modelRuntime,
      builtInEnabled: true,
      allowCancellation: true,
    });
    assert.ok(binding);
    const model = { provider: session.model.provider, id: session.model.id };
    const providerSessionId = "pi-web-side-ask-association-test";
    const first = host.associateRemoteClaudeProviderSession({
      providerSessionId,
      hostIdentity: session,
      sessionManager: session.sessionManager,
      model,
    });
    const second = host.associateRemoteClaudeProviderSession({
      providerSessionId,
      hostIdentity: session,
      sessionManager: session.sessionManager,
      model,
    });
    const resolved = host.resolveRemoteClaudeProviderSession(providerSessionId);
    assert.equal(resolved?.binding, binding);
    assert.equal(resolved?.generation, binding.generation);
    assert.deepEqual(resolved?.model, model);

    first.dispose();
    assert.equal(host.resolveRemoteClaudeProviderSession(providerSessionId)?.binding, binding);
    second.dispose();
    assert.equal(host.resolveRemoteClaudeProviderSession(providerSessionId), undefined);

    const staleLease = host.associateRemoteClaudeProviderSession({
      providerSessionId,
      hostIdentity: session,
      sessionManager: session.sessionManager,
      model,
    });
    replacement = await host.installRemoteClaudeHost({
      hostIdentity: session,
      sessionManager: session.sessionManager,
      sessionId: session.sessionId,
      cwd,
      agentDir,
      activeTools: ["read", "Agent"],
      modelRuntime: session.modelRuntime,
      builtInEnabled: true,
      allowCancellation: true,
      replace: true,
    });
    assert.ok(replacement);
    assert.equal(host.resolveRemoteClaudeProviderSession(providerSessionId), undefined);
    staleLease.dispose();
    host.revokeRemoteClaudeHost(replacement);
  } finally {
    try {
      host.revokeRemoteClaudeHost(replacement);
      host.revokeRemoteClaudeHost(binding);
    } finally {
      disposeSessionsAndRemoveDirs([session], agentDir, cwd);
    }
  }
});

test("real AgentSession fixture keeps control tools model-only and excludes nested execution", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-remote-subagent-session-"));
  const faux = fauxProvider({ models: [{ id: "faux-model" }] });
  const calls = [];
  const runtime = {
    async start() { calls.push("start"); throw new Error("not called by nested tools"); },
    async resume() { calls.push("resume"); throw new Error("not called by nested tools"); },
    async get() { calls.push("get"); return { sessionId: "child", parentSessionId: "parent", status: "completed", runInBackground: false, profile: "explore", description: "fixture", task: "fixture", createdAt: new Date().toISOString(), result: "ok" }; },
    async steer() { calls.push("steer"); },
    async notifyParent() {},
    markResultConsumed() {},
  };
  let session;
  try {
    ({ session } = await createFixtureSession(cwd, faux, [createSubagentExtension(runtime, () => [])]));
    const names = new Map(session.getAllTools().map((tool) => [tool.name, tool]));
    for (const name of ["Agent", "get_subagent_result", "steer_subagent"]) {
      assert.equal(names.get(name)?.exposure, "model-only", name);
      assert.ok(session.getActiveToolNames().includes(name), `${name} must be active`);
    }
    assert.deepEqual(session.getCallableToolNames().filter((name) => ["Agent", "get_subagent_result", "steer_subagent"].includes(name)), []);
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall("get_subagent_result", { agent_id: "child" })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxText("done")]),
    ]);
    await session.prompt("collect the fixture child");
    assert.deepEqual(calls, ["get"]);
  } finally {
    disposeSessionsAndRemoveDirs([session], cwd);
  }
});

test("ordinary RPC sessions bypass the remote guard while remote provider or lineage remains guarded", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-web-remote-guard-agent-"));
  mkdirSync(join(agentDir, "packages"), { recursive: true });
  symlinkSync(packageRoot, join(agentDir, "packages", "pi-remote-claude"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-remote-guard-cwd-"));
  const parentCwd = mkdtempSync(join(tmpdir(), "pi-web-remote-guard-parent-"));
  const manager = { getSessionId: () => "ordinary-rpc", getCwd: () => cwd };
  const childManager = { getSessionId: () => "remote-child", getCwd: () => parentCwd };
  let rootBinding;
  let childBinding;
  let toolCall;
  try {
    rootBinding = await host.installRemoteClaudeHost({
      hostIdentity: {}, sessionManager: manager, sessionId: "ordinary-rpc", cwd, agentDir,
      activeTools: ["bash", "Agent", "get_subagent_result", "steer_subagent"],
      modelRuntime: { getModels: () => [{ provider: "faux", id: "faux-model" }] },
      builtInEnabled: true, allowCancellation: true,
    });
    assert.ok(rootBinding);
    childBinding = await host.installRemoteClaudeHost({
      hostIdentity: {}, sessionManager: childManager, sessionId: "remote-child", cwd: parentCwd, agentDir,
      activeTools: ["bash"], modelRuntime: { getModels: () => [{ provider: "faux", id: "faux-model" }] },
      builtInEnabled: true, parent: rootBinding, allowCancellation: true,
    });
    assert.ok(childBinding);
    host.createRemoteClaudeHostGuardExtension().factory({
      on(name, handler) { if (name === "tool_call") toolCall = handler; },
    });
    assert.equal(typeof toolCall, "function");

    // The same binding exists during an ordinary RPC session, but its local
    // provider must not inherit the remote-only ordinary-tool policy.
    assert.equal(toolCall({ toolName: "bash" }, { sessionManager: manager, model: { provider: "faux" } }), undefined);
    const remoteResult = toolCall({ toolName: "bash" }, { sessionManager: manager, model: { provider: "claude-remote" } });
    assert.equal(remoteResult?.block, true);
    assert.match(remoteResult?.reason ?? "", /bash|policy|tool/i);

    // A child binding carries explicit remote lineage and stays guarded even if
    // its model context has not yet reported the remote provider.
    const childResult = toolCall({ toolName: "bash" }, { sessionManager: childManager, model: { provider: "faux" } });
    assert.equal(childResult?.block, true);
  } finally {
    try {
      host.revokeRemoteClaudeHost(childBinding);
      host.revokeRemoteClaudeHost(rootBinding);
      assert.equal(host.remoteClaudeHostBridge().resolveByManager(childManager), undefined);
      assert.equal(host.remoteClaudeHostBridge().resolveByManager(manager), undefined);
    } finally {
      removeFixtureDirs(agentDir, cwd, parentCwd);
    }
  }
});
