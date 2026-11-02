import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { createSubagentController, parseSubagentModel } = await jiti.import("./subagent-runtime.ts");
const { SUBAGENT_NOTIFICATION_PREFIX } = await jiti.import("./subagent-extension.ts");

test("model IDs resolve exactly before a legal suffix, and an unknown suffix is rejected", () => {
  const exact = { provider: "faux", id: "tuned:high" };
  const base = { provider: "faux", id: "tuned" };
  const runtime = {
    getModel: (provider, id) => provider === "faux" && id === exact.id ? exact : provider === "faux" && id === base.id ? base : undefined,
    getModels: () => [exact, base],
  };

  assert.deepEqual(parseSubagentModel(runtime, "faux/tuned:high"), { model: exact });
  assert.deepEqual(parseSubagentModel(runtime, "faux/tuned:high:low"), { model: exact, thinkingLevel: "low" });
  assert.throws(() => parseSubagentModel(runtime, "faux/tuned:turbo"), /Subagent model not found/);
});

test("a request model wins over the profile and parent, while explicit thinking wins over model suffix", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-subagent-model-priority-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const sessions = new Map();
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await mkdir(join(dir, "agents"), { recursive: true });
    await writeFile(join(dir, "agents", "fixture.md"), [
      "---", "description: Model priority fixture", "tools: read", "load_skills: false", "load_extensions: false",
      "model: faux/faux-model", "thinking: low", "---", "Complete the task.",
    ].join("\n"));

    const faux = fauxProvider({ models: [
      { id: "faux-model", reasoning: true },
      { id: "tuned:high", reasoning: true },
    ] });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const services = await createAgentSessionServices({
      cwd: dir,
      agentDir: dir,
      modelRuntime,
      settingsManager: SettingsManager.inMemory(),
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      },
    });
    const { session: parent } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.create(dir, join(dir, "sessions")),
      model: faux.getModel("faux-model"),
    });
    const registrations = [];
    const registerSession = (inner, options) => {
      registrations.push(options);
      const wrapper = {
        inner,
        cwd: dir,
        sessionFile: inner.sessionFile ?? "",
        isAlive: () => true,
        isRunning: () => inner.isStreaming,
        waitUntilReady: async () => {},
      };
      sessions.set(inner.sessionId, wrapper);
      return wrapper;
    };
    registerSession(parent);
    const controller = createSubagentController({
      getSession: (id) => sessions.get(id),
      registerSession,
      reopenSession: async () => { throw new Error("unused"); },
      resolveSessionPath: async () => null,
      invalidateSessionList: () => {},
      isBuiltInSubagentsEnabled: () => true,
    });

    faux.setResponses([fauxAssistantMessage([fauxText("priority-ok")])]);
    const execution = await controller.extensionRuntime.start({
      parentContext: { sessionManager: parent.sessionManager },
      parentToolCallId: "priority-call",
      profile: "fixture",
      model: "faux/tuned:high",
      thinking: "minimal",
      task: "exercise model priority",
      description: "Model priority",
      runInBackground: false,
    });
    const result = await execution.completion;
    const child = sessions.get(execution.run.sessionId).inner;
    assert.equal(result.status, "completed");
    assert.equal(child.model.id, "tuned:high");
    assert.equal(child.thinkingLevel, "minimal");
    assert.equal(registrations.length, 2);
    assert.equal(registrations[1].skillRuntimeContext.runtimeSkillsEnabled, false);
    assert.deepEqual(registrations[1].skillRuntimeContext.catalogSkills, []);
  } finally {
    for (const { inner } of sessions.values()) inner.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  }
});

test("real SDK child registration carries a policy catalog for enabled Skills", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-subagent-skill-admission-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const sessions = new Map();
  const registrations = [];
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await mkdir(join(dir, "agents"), { recursive: true });
    await writeFile(join(dir, "agents", "skilled.md"), [
      "---", "description: Skill admission fixture", "tools: read", "load_skills: true", "load_extensions: false", "---",
      "Use the enabled Reader Skill catalog.",
    ].join("\n"));
    const faux = fauxProvider({ models: [{ id: "faux-model", reasoning: true }] });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const services = await createAgentSessionServices({
      cwd: dir,
      agentDir: dir,
      modelRuntime,
      settingsManager: SettingsManager.inMemory(),
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      },
    });
    const { session: parent } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.create(dir, join(dir, "sessions")),
      model: faux.getModel("faux-model"),
    });
    const registerSession = (inner, options) => {
      registrations.push(options);
      const wrapper = {
        inner,
        cwd: dir,
        sessionFile: inner.sessionFile ?? "",
        isAlive: () => true,
        isRunning: () => inner.isStreaming,
        waitUntilReady: async () => {},
      };
      sessions.set(inner.sessionId, wrapper);
      return wrapper;
    };
    sessions.set(parent.sessionId, {
      inner: parent,
      cwd: dir,
      sessionFile: parent.sessionFile ?? "",
      isAlive: () => true,
      isRunning: () => parent.isStreaming,
      waitUntilReady: async () => {},
    });
    const controller = createSubagentController({
      getSession: (id) => sessions.get(id),
      registerSession,
      reopenSession: async () => { throw new Error("unused"); },
      resolveSessionPath: async () => null,
      invalidateSessionList: () => {},
      isBuiltInSubagentsEnabled: () => true,
    });
    faux.setResponses([fauxAssistantMessage([fauxText("skill-admission-ok")])]);
    const execution = await controller.extensionRuntime.start({
      parentContext: { sessionManager: parent.sessionManager },
      parentToolCallId: "skill-admission-call",
      profile: "skilled",
      task: "exercise child skill admission",
      description: "Skill admission",
      runInBackground: false,
    });
    const result = await execution.completion;
    assert.equal(result.status, "completed");
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].skillRuntimeContext.runtimeSkillsEnabled, true);
    assert.equal(registrations[0].skillRuntimeContext.cwd, dir);
    assert.equal(registrations[0].skillRuntimeContext.agentDir, dir);
    assert.ok(Array.isArray(registrations[0].skillRuntimeContext.catalogSkills));
  } finally {
    for (const { inner } of sessions.values()) inner.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  }
});

function completedRun() {
  return {
    sessionId: "child-session",
    sessionPath: "/tmp/child.jsonl",
    parentSessionId: "parent-session",
    parentToolCallId: "tool-call",
    profile: "Explore",
    description: "Inspect parser",
    task: "Find the parser",
    runInBackground: true,
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    result: "Parser found",
  };
}

function mcpResumeFixture(sessionId, prepareMcpForRun) {
  const entries = [
    { type: "custom", customType: "pi-web:subagent", data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      parentToolCallId: "old-call",
      profile: "explore",
      description: "old task",
      task: "old",
      runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      resourceSnapshot: { version: 1, appendSystemPrompt: [], tools: [], loadSkills: false, loadExtensions: false },
    } },
    { type: "custom", customType: "pi-web:subagent-result", data: {
      version: 1, status: "completed", completedAt: "2026-01-01T00:01:00.000Z", result: "old result",
    } },
  ];
  const calls = { prompt: 0, innerAbort: 0, signal: undefined };
  const childInner = {
    sessionId,
    sessionFile: `/tmp/${sessionId}.jsonl`,
    sessionManager: { getEntries: () => entries, appendCustomEntry: (type, data) => entries.push({ type: "custom", customType: type, data }) },
    getActiveToolNames: () => [],
    getLastAssistantText: () => undefined,
    prompt: async () => { calls.prompt += 1; },
    abort: async () => { calls.innerAbort += 1; },
  };
  const child = {
    inner: childInner,
    sessionFile: childInner.sessionFile,
    cwd: "/tmp",
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => {},
    prepareMcpForRun: async (signal) => {
      calls.signal = signal;
      return prepareMcpForRun(signal);
    },
  };
  const parent = {
    inner: { sessionManager: { getSessionId: () => "parent" } },
    sessionFile: "/tmp/parent.jsonl",
    cwd: "/tmp",
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => {},
  };
  const controller = createSubagentController({
    getSession: (id) => id === sessionId ? child : parent,
    registerSession: () => {},
    reopenSession: async () => child,
    resolveSessionPath: async () => child.sessionFile,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });
  return { calls, child, parent, controller };
}

async function resumeMcpFixture(fixture, signal) {
  return fixture.controller.extensionRuntime.resume({
    parentContext: fixture.parent.inner,
    parentToolCallId: "stop-call",
    sessionId: fixture.child.inner.sessionId,
    task: "continue after MCP",
    description: "Continue",
    ...(signal ? { signal } : {}),
  });
}

test("Stop aborts an MCP connection wait while the wrapper is idle and never prompts", async () => {
  let release;
  const fixture = mcpResumeFixture("mcp-stop-wait", () => new Promise((resolve) => { release = resolve; }));
  const execution = await resumeMcpFixture(fixture);
  assert.ok(fixture.calls.signal, "the child must enter the MCP wait before Stop");

  await fixture.controller.abort(fixture.child.inner.sessionId, fixture.parent.inner);
  assert.equal(fixture.calls.signal.aborted, true);
  release(true);

  const result = await execution.completion;
  assert.equal(result.status, "aborted");
  assert.equal(fixture.calls.prompt, 0, "Stop during MCP wait must not execute the prompt");
  assert.equal(fixture.calls.innerAbort, 0, "MCP wait cancellation must not call SDK abort after the idle guard");
});

test("an MCP-ready completion raced by parent cancellation stays aborted before prompt", async () => {
  const parentAbort = new AbortController();
  const fixture = mcpResumeFixture("mcp-stop-ready-race", () => {
    queueMicrotask(() => parentAbort.abort());
    return true;
  });
  const execution = await resumeMcpFixture(fixture, parentAbort.signal);
  const result = await execution.completion;

  assert.equal(result.status, "aborted");
  assert.equal(fixture.calls.prompt, 0, "a cancellation queued with MCP readiness must win before prompt");
  assert.equal(fixture.calls.innerAbort, 0);
});

test("completion notification reopens an idle parent and uses its current session", async () => {
  const delivered = [];
  const reopened = [];
  let ready = false;
  let parent;
  const liveParent = {
    cwd: "/tmp",
    sessionFile: "/tmp/parent.jsonl",
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => { ready = true; },
    inner: {
      sendCustomMessage: async (message, options) => delivered.push({ message, options }),
    },
  };
  const controller = createSubagentController({
    getSession: () => parent,
    registerSession: () => {},
    reopenSession: async (sessionId, sessionFile) => {
      reopened.push([sessionId, sessionFile]);
      parent = liveParent;
      return liveParent;
    },
    resolveSessionPath: async () => "/tmp/parent.jsonl",
    invalidateSessionList: () => {},
  });

  await controller.extensionRuntime.notifyParent(completedRun());

  assert.deepEqual(reopened, [["parent-session", "/tmp/parent.jsonl"]]);
  assert.equal(ready, true);
  assert.equal(delivered.length, 1);
  assert.equal(
    delivered[0].message.content,
    `${SUBAGENT_NOTIFICATION_PREFIX}Subagent child-session completed.\n\nParser found`,
  );
  // Compaction reads custom messages as user turns, so the report must announce that it is not one (#875).
  assert.match(delivered[0].message.content, /^The following is a background subagent's report/);
  assert.equal(delivered[0].message.details.sessionId, "child-session");
  assert.deepEqual(delivered[0].options, { deliverAs: "followUp", triggerTurn: true });
});

test("disabled built-in subagents reject stale Agent calls before starting", async () => {
  const controller = createSubagentController({
    getSession: () => { throw new Error("must not inspect a parent"); },
    registerSession: () => {},
    reopenSession: async () => { throw new Error("unused"); },
    resolveSessionPath: async () => null,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => false,
  });

  await assert.rejects(
    controller.extensionRuntime.start({
      parentContext: { sessionManager: { getSessionId: () => "parent" } },
      parentToolCallId: "call",
      profile: "explore",
      task: "Inspect",
      description: "Inspect",
    }),
    /built-in sub-agents are disabled/,
  );
});

test("resume reuses the persisted child session and keeps its session id", async () => {
  const calls = [];
  const entries = [
    { type: "custom", customType: "pi-web:subagent", data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      parentToolCallId: "old-call",
      profile: "explore",
      description: "old task",
      task: "old",
      runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      resourceSnapshot: { version: 1, appendSystemPrompt: [], tools: [], loadSkills: false, loadExtensions: false },
    } },
    { type: "custom", customType: "pi-web:subagent-result", data: {
      version: 1, status: "completed", completedAt: "2026-01-01T00:01:00.000Z", result: "old result",
    } },
  ];
  const childInner = {
    sessionId: "child",
    sessionFile: "/tmp/child.jsonl",
    sessionManager: { getEntries: () => entries, appendCustomEntry: (type, data) => entries.push({ type: "custom", customType: type, data }) },
    prompt: async (task) => { calls.push(task); },
    getLastAssistantText: () => "new result",
    abort: async () => {},
  };
  const child = { inner: childInner, sessionFile: childInner.sessionFile, cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} };
  const parent = { inner: { sessionManager: { getSessionId: () => "parent" } }, sessionFile: "/tmp/parent.jsonl", cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} };
  const controller = createSubagentController({
    getSession: (id) => id === "child" ? child : parent,
    registerSession: () => {},
    reopenSession: async () => child,
    resolveSessionPath: async () => child.sessionFile,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });
  const execution = await controller.extensionRuntime.resume({
    parentContext: parent.inner,
    parentToolCallId: "new-call",
    sessionId: "child",
    task: "continue this",
    description: "Continue task",
  });
  const result = await execution.completion;
  assert.equal(execution.run.sessionId, "child");
  assert.equal(result.sessionId, "child");
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, ["continue this"]);
});

test("resume rejects a child owned by another parent", async () => {
  const controller = createSubagentController({
    getSession: (id) => id === "parent" ? { inner: { sessionManager: { getSessionId: () => "parent" } }, sessionFile: "/tmp/parent.jsonl", cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} } : undefined,
    registerSession: () => {},
    reopenSession: async () => { throw new Error("unused"); },
    resolveSessionPath: async () => null,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });
  await assert.rejects(controller.extensionRuntime.resume({
    parentContext: { sessionManager: { getSessionId: () => "parent" } },
    parentToolCallId: "call",
    sessionId: "missing",
    task: "continue",
    description: "Continue",
  }), /Subagent not found/);
});

test("a run whose last assistant message ended with a provider error is reported as failed, not completed", async () => {
  const entries = [
    { type: "custom", customType: "pi-web:subagent", data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      parentToolCallId: "old-call",
      profile: "builder",
      description: "old task",
      task: "old",
      runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      resourceSnapshot: { version: 1, appendSystemPrompt: [], tools: [], loadSkills: false, loadExtensions: false },
    } },
    { type: "custom", customType: "pi-web:subagent-result", data: { version: 1, status: "completed", completedAt: "2026-01-01T00:01:00.000Z" } },
  ];
  const childInner = {
    sessionId: "child",
    sessionFile: "/tmp/child.jsonl",
    sessionManager: { getEntries: () => entries, appendCustomEntry: (type, data) => entries.push({ type: "custom", customType: type, data }) },
    // pi's agent loop records a provider stream error as an assistant message and resolves prompt() normally.
    prompt: async () => {
      entries.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "edit", arguments: {} }], stopReason: "error", errorMessage: "stream error: stream disconnected before completion" } });
    },
    getLastAssistantText: () => undefined,
    abort: async () => {},
  };
  const child = { inner: childInner, sessionFile: childInner.sessionFile, cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} };
  const parent = { inner: { sessionManager: { getSessionId: () => "parent" } }, sessionFile: "/tmp/parent.jsonl", cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} };
  const controller = createSubagentController({
    getSession: (id) => id === "child" ? child : parent,
    registerSession: () => {},
    reopenSession: async () => child,
    resolveSessionPath: async () => child.sessionFile,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });
  const execution = await controller.extensionRuntime.resume({
    parentContext: parent.inner,
    parentToolCallId: "new-call",
    sessionId: "child",
    task: "continue this",
    description: "Continue task",
  });
  const result = await execution.completion;
  assert.equal(result.status, "failed");
  assert.match(result.error, /stream disconnected/);
  const persisted = entries.at(-1);
  assert.equal(persisted.customType, "pi-web:subagent-result");
  assert.equal(persisted.data.status, "failed");
  assert.match(persisted.data.error, /stream disconnected/);
});

function idleParentDependencies(delivered, overrides = {}) {
  const parent = {
    cwd: "/tmp",
    sessionFile: "/tmp/parent.jsonl",
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => {},
    inner: {
      sendCustomMessage: async (message, options) => delivered.push({ message, options }),
    },
    ...overrides,
  };
  return {
    getSession: () => parent,
    registerSession: () => {},
    reopenSession: async () => parent,
    resolveSessionPath: async () => "/tmp/parent.jsonl",
    invalidateSessionList: () => {},
  };
}

test("a result already collected with get_subagent_result is never delivered again", async () => {
  const delivered = [];
  const controller = createSubagentController(idleParentDependencies(delivered));
  const run = { ...completedRun(), sessionId: "collected-child" };

  controller.extensionRuntime.markResultConsumed(run);
  await controller.extensionRuntime.notifyParent(run);

  assert.equal(delivered.length, 0);

  // The mark is consumed, so a later run reusing that session ID still notifies.
  await controller.extensionRuntime.notifyParent(run);
  assert.equal(delivered.length, 1);
});

test("a notification waits for a busy parent and is dropped when that turn collects the result", async () => {
  const delivered = [];
  let running = true;
  const controller = createSubagentController(idleParentDependencies(delivered, { isRunning: () => running }));
  const run = { ...completedRun(), sessionId: "racing-child" };

  const notified = controller.extensionRuntime.notifyParent(run);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(delivered.length, 0, "must not deliver while the parent turn is still running");

  // The parent's in-flight get_subagent_result call returns the same result, then the turn ends.
  controller.extensionRuntime.markResultConsumed(run);
  running = false;
  await notified;

  assert.equal(delivered.length, 0);
});

test("a notification held for a busy parent is delivered once that parent goes idle", async () => {
  const delivered = [];
  let running = true;
  const controller = createSubagentController(idleParentDependencies(delivered, { isRunning: () => running }));
  const run = { ...completedRun(), sessionId: "waiting-child" };

  const notified = controller.extensionRuntime.notifyParent(run);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(delivered.length, 0);

  running = false;
  await notified;

  assert.equal(delivered.length, 1);
  assert.equal(
    delivered[0].message.content,
    `${SUBAGENT_NOTIFICATION_PREFIX}Subagent waiting-child completed.\n\nParser found`,
  );
  assert.deepEqual(delivered[0].options, { deliverAs: "followUp", triggerTurn: true });
});

// Regression cases introduced by upstream v0.10.0, retained with Reader cases.


test("a run collected and resumed in the same turn keeps its held notification suppressed", async () => {
  const delivered = [];
  let parentRunning = true;
  const entries = [
    { type: "custom", customType: "pi-web:subagent", data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      parentToolCallId: "old-call",
      profile: "explore",
      description: "old task",
      task: "old",
      runInBackground: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      resourceSnapshot: { version: 1, appendSystemPrompt: [], tools: [], loadSkills: false, loadExtensions: false },
    } },
    { type: "custom", customType: "pi-web:subagent-result", data: {
      version: 1, status: "completed", completedAt: "2026-01-01T00:01:00.000Z", result: "old result",
    } },
  ];
  let finishResumed;
  const childInner = {
    sessionId: "collect-and-resume-child",
    sessionFile: "/tmp/child.jsonl",
    sessionManager: { getEntries: () => entries, appendCustomEntry: (type, data) => entries.push({ type: "custom", customType: type, data }) },
    prompt: () => new Promise((resolve) => { finishResumed = resolve; }),
    getLastAssistantText: () => "new result",
    abort: async () => {},
  };
  const child = { inner: childInner, sessionFile: childInner.sessionFile, cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} };
  const parent = {
    inner: {
      sessionManager: { getSessionId: () => "parent" },
      sendCustomMessage: async (message, options) => delivered.push({ message, options }),
    },
    sessionFile: "/tmp/parent.jsonl",
    cwd: "/tmp",
    isAlive: () => true,
    isRunning: () => parentRunning,
    waitUntilReady: async () => {},
  };
  const controller = createSubagentController({
    getSession: (id) => id === "collect-and-resume-child" ? child : parent,
    registerSession: () => {},
    reopenSession: async () => child,
    resolveSessionPath: async () => child.sessionFile,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });
  const first = await controller.extensionRuntime.get("collect-and-resume-child");

  // Run 1's notification is held while the parent turn runs; in that turn the parent
  // collects run 1 with get_subagent_result and immediately resumes the same child.
  const heldFirst = controller.extensionRuntime.notifyParent(first);
  await new Promise((resolve) => setTimeout(resolve, 250));
  controller.extensionRuntime.markResultConsumed(first);
  const execution = await controller.extensionRuntime.resume({
    parentContext: parent.inner,
    parentToolCallId: "new-call",
    sessionId: "collect-and-resume-child",
    task: "continue this",
    description: "Continue task",
  });
  parentRunning = false;
  await heldFirst;
  assert.equal(delivered.length, 0, "run 1 was already collected; delivering it again is the #889 duplicate");

  // The resumed run finishes later and is notified: the earlier mark names run 1, not this run.
  finishResumed();
  const second = await execution.completion;
  assert.notEqual(second.completedAt, first.completedAt);
  await controller.extensionRuntime.notifyParent(second);
  assert.equal(delivered.length, 1);
});


test("a resumed run that fails right away still notifies after the parent inspected the earlier failure (#987)", async () => {
  const delivered = [];
  const entries = [
    { type: "custom", customType: "pi-web:subagent", data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      parentToolCallId: "old-call",
      profile: "explore",
      description: "old task",
      task: "old",
      runInBackground: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      resourceSnapshot: { version: 1, appendSystemPrompt: [], tools: [], loadSkills: false, loadExtensions: false },
    } },
    { type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "stream disconnected" } },
    { type: "custom", customType: "pi-web:subagent-result", data: {
      version: 1, status: "failed", completedAt: "2026-01-01T00:01:00.000Z", error: "stream disconnected",
    } },
  ];
  const childInner = {
    sessionId: "failed-resume-child",
    sessionFile: "/tmp/child.jsonl",
    sessionManager: { getEntries: () => entries, appendCustomEntry: (type, data) => entries.push({ type: "custom", customType: type, data }) },
    // The resumed run is rejected by the provider at once; pi records that as an errored assistant message.
    prompt: async () => {
      entries.push({ type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "400 Bad Request" } });
    },
    getLastAssistantText: () => undefined,
    abort: async () => {},
  };
  const child = { inner: childInner, sessionFile: childInner.sessionFile, cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} };
  const parent = {
    inner: {
      sessionManager: { getSessionId: () => "parent" },
      sendCustomMessage: async (message, options) => delivered.push({ message, options }),
    },
    sessionFile: "/tmp/parent.jsonl",
    cwd: "/tmp",
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => {},
  };
  const controller = createSubagentController({
    getSession: (id) => id === "failed-resume-child" ? child : parent,
    registerSession: () => {},
    reopenSession: async () => child,
    resolveSessionPath: async () => child.sessionFile,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });

  // Run 1's failure is delivered, then the parent inspects it with get_subagent_result before retrying.
  const first = await controller.extensionRuntime.get("failed-resume-child");
  await controller.extensionRuntime.notifyParent(first);
  controller.extensionRuntime.markResultConsumed(first);

  const execution = await controller.extensionRuntime.resume({
    parentContext: parent.inner,
    parentToolCallId: "retry-call",
    sessionId: "failed-resume-child",
    task: "retry with the fix",
    description: "Retry",
  });
  const second = await execution.completion;
  assert.equal(second.status, "failed");
  await controller.extensionRuntime.notifyParent(second);

  assert.equal(delivered.length, 2, "the retry's failure must reach the parent, or it waits forever");
  assert.match(delivered[1].message.content, /Subagent failed-resume-child failed: 400 Bad Request/);
  assert.deepEqual(delivered[1].options, { deliverAs: "followUp", triggerTurn: true });
});


function orphanedEntries(status) {
  return [
    { type: "custom", customType: "pi-web:subagent", data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      parentToolCallId: "call",
      profile: "explore",
      description: "Find parser",
      task: "Find the parser",
      runInBackground: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    } },
    { type: "custom", customType: "pi-web:subagent-status", data: { version: 1, status } },
  ];
}


function orphanController(child) {
  return createSubagentController({
    getSession: () => child,
    registerSession: () => {},
    reopenSession: async () => child,
    resolveSessionPath: async () => undefined,
    invalidateSessionList: () => {},
  });
}


test("a live child left with a running status but no active run reads as interrupted", async () => {
  for (const status of ["running", "queued"]) {
    const entries = orphanedEntries(status);
    const child = {
      inner: { sessionManager: { getEntries: () => entries } },
      sessionFile: "/tmp/child.jsonl",
      isAlive: () => true,
      isRunning: () => false,
    };

    const run = await orphanController(child).extensionRuntime.get("orphan-child");

    assert.equal(run.status, "interrupted", `persisted ${status} without a result`);
  }
});


test("a child whose wrapper is still running keeps reporting running", async () => {
  const entries = orphanedEntries("running");
  const child = {
    inner: { sessionManager: { getEntries: () => entries } },
    sessionFile: "/tmp/child.jsonl",
    isAlive: () => true,
    isRunning: () => true,
  };

  const run = await orphanController(child).extensionRuntime.get("orphan-child");

  assert.equal(run.status, "running");
});


test("a child session read back from disk after a restart mid-run reads as interrupted", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "pi-web-orphaned-subagent-"));
  try {
    const sessionPath = join(dir, "child.jsonl");
    const header = { type: "session", version: 3, id: "orphan-child", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir, parentSession: "/tmp/parent.jsonl" };
    const lines = [header, ...orphanedEntries("running").map((entry, index) => ({
      ...entry,
      id: `e${index}`,
      parentId: index === 0 ? null : `e${index - 1}`,
      timestamp: "2026-01-01T00:00:00.000Z",
    }))];
    await writeFile(sessionPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const controller = createSubagentController({
      getSession: () => undefined,
      registerSession: () => {},
      reopenSession: async () => { throw new Error("unused"); },
      resolveSessionPath: async () => sessionPath,
      invalidateSessionList: () => {},
    });

    const run = await controller.extensionRuntime.get("orphan-child");

    assert.equal(run.status, "interrupted");
    assert.equal(run.completedAt, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("a mark left by an earlier run never swallows the next run's notification (#987)", async () => {
  const delivered = [];
  const controller = createSubagentController(idleParentDependencies(delivered));
  const first = { ...completedRun(), sessionId: "rerun-child" };

  // Run 1 notifies first; the parent then polls get_subagent_result and marks a result
  // whose notification has already been delivered, so no notifyParent ever takes that mark.
  await controller.extensionRuntime.notifyParent(first);
  controller.extensionRuntime.markResultConsumed(first);
  assert.equal(delivered.length, 1);

  const second = { ...first, parentToolCallId: "second-call", completedAt: "2026-01-01T00:05:00.000Z" };
  await controller.extensionRuntime.notifyParent(second);

  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].options.triggerTurn, true);
});
