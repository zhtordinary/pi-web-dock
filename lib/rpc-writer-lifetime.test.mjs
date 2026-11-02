import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createSealedPublicInputEnvironment } from "../test-support/sealed-public-inputs.mjs";

const environment = await createSealedPublicInputEnvironment("writer-lifetime");
const previousActivityFile = process.env.PI_WEB_SESSION_ACTIVITY_FILE;
process.env.PI_WEB_SESSION_ACTIVITY_FILE = join(environment.root, "activity.json");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: true });
const { fauxProvider, fauxAssistantMessage } = await jiti.import("@earendil-works/pi-ai");
const { createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { acquireSessionRuntimeOwnership } = await jiti.import("./session-runtime-ownership.ts");
const { createSubagentController } = await jiti.import("./subagent-runtime.ts");
const { SubagentQueue } = await jiti.import("./subagent-queue.ts");
const { readSubagentRun } = await jiti.import("./subagents.ts");
const { hasActiveSessionLivenessProvider } = await jiti.import("./session-liveness.ts");

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function assertOwned(file) {
  assert.throws(() => {
    const ownership = acquireSessionRuntimeOwnership(file);
    ownership.release();
  }, { code: "session_runtime_owned" });
}

// The contender is another Reader process, never a CLI writer or a real user runtime.
async function readerAttempt(t, sessionId, sessionFile) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createJiti } from ${JSON.stringify(import.meta.resolve("jiti"))};
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    const { startRpcSession } = await jiti.import(${JSON.stringify(new URL("./rpc-manager.ts", import.meta.url).pathname)});
    let result;
    try {
      const { session } = await startRpcSession(${JSON.stringify(sessionId)}, ${JSON.stringify(sessionFile)}, undefined);
      await session.waitUntilReady();
      result = { leaf: session.inner.sessionManager.getLeafId(), entries: session.inner.sessionManager.getEntries(), branchIds: session.inner.sessionManager.getBranch().map(entry => entry.id) };
      await session.shutdown();
    } catch (error) { result = { code: error.code, message: error.message }; }
    process.send(result, () => process.disconnect());
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
  });
  const message = once(child, "message").then(([result]) => result);
  const exit = once(child, "exit").then(() => { throw new Error(`Reader contender exited before replying: ${stderr}`); });
  return Promise.race([message, exit]);
}

async function fixture(t, label) {
  const cwd = join(environment.root, label);
  await mkdir(cwd, { recursive: true });
  await mkdir(join(environment.agentDir, "agents"), { recursive: true });
  await writeFile(join(environment.agentDir, "agents", "lifetime.md"), [
    "---", "description: Writer lifetime fixture", "tools: none", "load_skills: false", "load_extensions: false", "---", "Complete the task.",
  ].join("\n"));
  await writeFile(join(environment.agentDir, "agents", "settings.json"), JSON.stringify({ builtInEnabled: true, maxConcurrent: 1 }));
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "fixture-auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const services = await createAgentSessionServices({
    cwd, agentDir: environment.agentDir, modelRuntime, settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
  });
  const sessions = new Map();
  const ownerships = [];
  const executions = [];
  const releases = [];
  const previousQueue = globalThis.__piSubagentQueue;
  const previousRuns = globalThis.__piSubagentRuns;
  const queue = new SubagentQueue();
  globalThis.__piSubagentQueue = queue;
  globalThis.__piSubagentRuns = new Map();
  t.after(async () => {
    for (const release of releases) release();
    await Promise.all(executions.map(execution => execution.completion));
    for (const wrapper of sessions.values()) await wrapper.shutdown();
    await nextTurn();
    for (const ownership of ownerships) ownership.release();
    globalThis.__piSubagentQueue = previousQueue;
    globalThis.__piSubagentRuns = previousRuns;
  });
  function host(inner, options = {}) {
    if (options.runtimeOwnership) ownerships.push(options.runtimeOwnership);
    const wrapper = new AgentSessionWrapper(inner, undefined, undefined, { runtimeOwnership: options.runtimeOwnership });
    sessions.set(inner.sessionId, wrapper);
    wrapper.start();
    wrapper.beginExtensionBinding();
    return wrapper;
  }
  let parent;
  async function persistedChild() {
    const manager = SessionManager.create(cwd, join(cwd, "sessions"));
    if (parent) {
      manager.appendCustomEntry("pi-web:subagent", {
        version: 1, parentSessionId: parent.sessionId, parentSessionPath: parent.sessionFile,
        parentToolCallId: "old-call", profile: "lifetime", description: "Old task", task: "Old task", runInBackground: false,
        createdAt: new Date(0).toISOString(),
        resourceSnapshot: { version: 1, tools: [], loadSkills: false, loadExtensions: false, appendSystemPrompt: [] },
      });
    }
    manager.appendMessage({ role: "user", content: "Old task", timestamp: Date.now() });
    if (parent) manager.appendCustomEntry("pi-web:subagent-result", { version: 1, status: "completed", completedAt: new Date(1).toISOString(), result: "Old result" });
    const ownership = acquireSessionRuntimeOwnership(manager.getSessionFile());
    ownerships.push(ownership);
    const { session: inner } = await createAgentSessionFromServices({ services, sessionManager: manager, model: faux.getModel(), tools: [] });
    const wrapper = host(inner, { runtimeOwnership: ownership });
    await wrapper.waitUntilReady();
    return wrapper;
  }
  parent = await persistedChild();
  const controller = createSubagentController({
    getSession: id => sessions.get(id), registerSession: host,
    reopenSession: async () => { throw new Error("fixture child is already hosted"); },
    resolveSessionPath: async id => sessions.get(id)?.sessionFile ?? null,
    invalidateSessionList: () => {}, isBuiltInSubagentsEnabled: () => true,
  });
  async function dispatch(kind, child) {
    const request = {
      parentContext: parent.inner, parentToolCallId: `${label}-call`, task: "New task", description: "New task", runInBackground: false,
    };
    const execution = kind === "start"
      ? await controller.extensionRuntime.start({ ...request, profile: "lifetime" })
      : await controller.extensionRuntime.resume({ ...request, sessionId: child.sessionId });
    executions.push(execution);
    return execution;
  }
  function occupySlot() {
    const gate = deferred();
    releases.push(gate.resolve);
    const occupied = queue.enqueue(parent.sessionId, 1, () => gate.promise, () => {});
    return { release: gate.resolve, completion: occupied.promise };
  }
  return { parent, sessions, faux, queue, controller, releases, persistedChild, dispatch, occupySlot };
}

test.after(async () => {
  if (previousActivityFile === undefined) delete process.env.PI_WEB_SESSION_ACTIVITY_FILE;
  else process.env.PI_WEB_SESSION_ACTIVITY_FILE = previousActivityFile;
  await environment.restore();
});

test("process exit cancels a real SDK model run without recording successful completion", { timeout: 60000 }, async t => {
  const f = await fixture(t, "model-exit");
  const wrapper = await f.persistedChild();
  const entered = deferred(), sdkSettled = deferred();
  f.faux.setResponses([async (_context, options) => {
    entered.resolve();
    await new Promise(resolve => {
      if (options.signal.aborted) resolve();
      else options.signal.addEventListener("abort", resolve, { once: true });
    });
    return fauxAssistantMessage("Cancelled response");
  }]);
  const sdkEvents = [], publicEvents = [];
  const unsubscribe = wrapper.inner.subscribe(event => {
    if (event.type === "agent_settled") { sdkEvents.push(event); sdkSettled.resolve(); }
  });
  t.after(unsubscribe);
  wrapper.onEvent(event => publicEvents.push(event));
  const emit = wrapper.inner.extensionRunner.emit.bind(wrapper.inner.extensionRunner);
  wrapper.inner.extensionRunner.emit = async event => {
    if (event.type === "session_shutdown") await sdkSettled.promise;
    return emit(event);
  };
  const prompt = wrapper.inner.prompt("Run until the host stops");
  await entered.promise;
  const { getSessionRunRecords } = await jiti.import("./session-activity.ts");
  const started = getSessionRunRecords().find(record => record.sessionId === wrapper.sessionId);
  assert.equal(started.status, "running");
  wrapper.destroyForProcessExit();
  await Promise.all([wrapper.waitUntilDisposed(), prompt]);
  await nextTurn();
  assert.equal(sdkEvents.length, 1);
  assert.equal(sdkEvents[0].aborted, true, "real SDK settlement also means cancellation");
  assert.equal(getSessionRunRecords().find(record => record.runId === started.runId).status, "unknown");
  assert.equal(publicEvents.some(event => event.type === "agent_settled"), false);
  assert.equal(wrapper.inner.sessionManager.getEntries().at(-1).message.stopReason, "aborted");
  const ownership = acquireSessionRuntimeOwnership(wrapper.sessionFile); ownership.release();
});

test("process-exit teardown retains ownership through real SDK bash cancellation and Reader persistence", { timeout: 60000 }, async t => {
  const f = await fixture(t, "bash");
  const wrapper = await f.persistedChild();
  const entered = deferred(), cancelled = deferred(), finish = deferred();
  f.releases.push(finish.resolve);
  const executeBash = wrapper.inner.executeBash.bind(wrapper.inner);
  // Control only the external command boundary; SDK abort/isIdle/result recording remain real.
  wrapper.inner.executeBash = (command, onChunk, options) => executeBash(command, onChunk, {
    ...options, operations: { exec: async (_command, _cwd, { signal, onData }) => {
      onData(Buffer.from("output before cancellation"));
      signal.addEventListener("abort", cancelled.resolve, { once: true });
      entered.resolve();
      await finish.promise;
      throw new Error("aborted");
    } },
  });
  const pending = wrapper.send({ type: "bash", command: "fixture-blocked-command" });
  t.after(async () => { finish.resolve(); await pending; });
  await entered.promise;
  assert.equal(wrapper.inner.isIdle, true);
  await wrapper.inner.abort();
  assert.equal(wrapper.inner.isBashRunning, true, "SDK abort does not settle independent bash");
  let readerPersisted = false;
  const persist = wrapper.persistSessionFileNow.bind(wrapper);
  t.mock.method(wrapper, "persistSessionFileNow", (...args) => {
    assertOwned(wrapper.sessionFile);
    persist(...args);
    readerPersisted = true;
  });
  wrapper.destroyForProcessExit();
  await wrapper.waitUntilDisposed();
  await cancelled.promise;
  assert.equal(wrapper.isAlive(), false, "UI teardown must not wait for the blocked command");
  assert.equal((await readerAttempt(t, wrapper.sessionId, wrapper.sessionFile)).code, "session_runtime_owned");
  finish.resolve();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(readerPersisted, true, "the lock also covers Reader's post-SDK persistence");
  await nextTurn();
  const replacement = await readerAttempt(t, wrapper.sessionId, wrapper.sessionFile);
  assert.equal(replacement.code, undefined);
  assert.equal(replacement.leaf, wrapper.inner.sessionManager.getLeafId());
  assert.equal(replacement.entries.at(-1).message.role, "bashExecution");
  assert.equal(replacement.entries.at(-1).message.cancelled, true);
});

for (const kind of ["start", "resume"]) {
  test(`a ${kind} child stays live without clients while pending in the Reader queue`, { timeout: 60000 }, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = await fixture(t, `queued-idle-${kind}`);
    const previous = kind === "resume" ? await f.persistedChild() : undefined;
    const occupied = f.occupySlot();
    f.faux.setResponses([fauxAssistantMessage("Queued result")]);
    const execution = await f.dispatch(kind, previous);
    const child = f.sessions.get(execution.run.sessionId);
    await child.waitUntilReady();
    const disconnect = child.onEvent(() => {});
    disconnect();
    assert.equal(execution.run.status, "queued");
    assert.equal(child.inner.isIdle, true);
    await assert.rejects(f.controller.steer(child.sessionId, "queued steering", f.parent.inner), /Subagent is not running/);
    for (let deadline = 0; deadline < 3; deadline++) {
      t.mock.timers.tick(600_000);
      await nextTurn();
      assert.equal(child.isAlive(), true, "a Reader-queued writer must outlive the SDK idle deadline");
      assert.equal(child.isRunning(), false, "Reader queue liveness must not broaden SDK busy/steer semantics");
      assert.equal(hasActiveSessionLivenessProvider({ sessionId: child.sessionId, sessionFile: child.sessionFile }), true);
      assertOwned(child.sessionFile);
    }
    occupied.release();
    assert.equal((await execution.completion).status, "completed");
    assert.equal(readSubagentRun(SessionManager.open(child.sessionFile).getEntries(), child.sessionId, child.sessionFile).result, "Queued result");
    await nextTurn();
    assert.equal(hasActiveSessionLivenessProvider({ sessionId: child.sessionId, sessionFile: child.sessionFile }), false);
    t.mock.timers.tick(600_000);
    await child.waitUntilDisposed();
    const ownership = acquireSessionRuntimeOwnership(child.sessionFile);
    ownership.release();
  });
}

for (const kind of ["start", "resume"]) {
  test(`explicit close safely settles a ${kind} child still pending in the Reader queue before transferring ownership`, { timeout: 60000 }, async t => {
    const f = await fixture(t, `queued-close-${kind}`);
    const occupied = f.occupySlot();
    const cancellation = deferred();
    f.releases.push(cancellation.resolve);
    let cancelEntered = false;
    const enqueue = f.queue.enqueue.bind(f.queue);
    t.mock.method(f.queue, "enqueue", (parentId, limit, run, onState, onCancel) => enqueue(parentId, limit, run, onState, async () => {
      cancelEntered = true;
      await cancellation.promise;
      await onCancel?.();
    }));
    const previous = kind === "resume" ? await f.persistedChild() : undefined;
    const execution = await f.dispatch(kind, previous);
    const child = f.sessions.get(execution.run.sessionId);
    await child.waitUntilReady();
    assert.equal(execution.run.status, "queued");
    assert.equal(child.inner.isIdle, true);
    assert.equal(existsSync(child.sessionFile), true, "even a queued new child must survive runtime close");
    const beforeClose = child.inner.sessionManager.getLeafId();
    const manager = child.inner.sessionManager;
    const append = manager.appendCustomEntry.bind(manager);
    t.mock.method(manager, "appendCustomEntry", (type, data) => {
      if (type === "pi-web:subagent-result") assertOwned(child.sessionFile);
      return append(type, data);
    });
    await child.shutdown();
    assert.equal(child.isAlive(), false, "UI shutdown stays independent of queue cancellation settlement");
    assert.equal((await readerAttempt(t, child.sessionId, child.sessionFile)).code, "session_runtime_owned");
    assert.equal(cancelEntered, true);
    assert.equal(child.inner.sessionManager.getLeafId(), beforeClose, "cancellation persistence is still blocked");
    cancellation.resolve();
    const result = await execution.completion;
    assert.equal(result.status, "aborted");
    await nextTurn();
    const replacement = await readerAttempt(t, child.sessionId, child.sessionFile);
    assert.equal(replacement.code, undefined);
    const resultId = child.inner.sessionManager.getLeafId();
    assert.ok(replacement.branchIds.includes(resultId), "the replacement must open after the final result, not an old leaf");
    assert.equal(replacement.entries.find(entry => entry.id === resultId).data.status, "aborted");
    if (kind === "resume") assert.equal(replacement.leaf, resultId);
    const settled = await readFile(child.sessionFile, "utf8");
    const next = f.queue.enqueue(f.parent.sessionId, 1, async () => "next task", () => {});
    occupied.release();
    await occupied.completion;
    assert.equal(await next.promise, "next task", "cancelling a pending child must not jam its parent's queue");
    await nextTurn();
    assert.equal(await readFile(child.sessionFile, "utf8"), settled, "no old-manager write after ownership transfer");
    assert.equal(f.faux.state.callCount, 0, "the cancelled child must never reach SDK prompt");
  });
}

test("SDK idle is not completion of a resumed child's Reader result write", { timeout: 60000 }, async t => {
  const f = await fixture(t, "running-tail");
  const child = await f.persistedChild();
  const sdkSettled = deferred(), finishReader = deferred();
  f.releases.push(finishReader.resolve);
  f.faux.setResponses([fauxAssistantMessage("Result before close")]);
  const prompt = child.inner.prompt.bind(child.inner);
  child.inner.prompt = async (...args) => {
    await prompt(...args);
    sdkSettled.resolve();
    await finishReader.promise;
  };
  const execution = await f.dispatch("resume", child);
  await sdkSettled.promise;
  assert.equal(child.inner.isIdle, true);
  assert.equal(child.isRunning(), false);
  assert.equal(hasActiveSessionLivenessProvider({ sessionId: child.sessionId, sessionFile: child.sessionFile }), true);
  await assert.rejects(f.controller.steer(child.sessionId, "late steering", f.parent.inner), /Subagent is not running/);
  await child.inner.abort();
  await child.shutdown();
  assert.equal(child.isAlive(), false);
  assertOwned(child.sessionFile);
  finishReader.resolve();
  const result = await execution.completion;
  assert.equal(result.status, "aborted");
  assert.equal(result.result, "Result before close");
  await nextTurn();
  const ownership = acquireSessionRuntimeOwnership(child.sessionFile);
  ownership.release();
  assert.equal(SessionManager.open(child.sessionFile).getEntries().at(-1).data.status, "aborted");
});
