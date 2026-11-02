import assert from "node:assert/strict";
import { existsSync, appendFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createSealedPublicInputEnvironment } from "../test-support/sealed-public-inputs.mjs";

const environment = await createSealedPublicInputEnvironment("runtime-ownership");
const previousActivityFile = process.env.PI_WEB_SESSION_ACTIVITY_FILE;
process.env.PI_WEB_SESSION_ACTIVITY_FILE = join(environment.root, "activity.json");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: true });
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { AgentSessionWrapper, startRpcSession, getRpcSession, ensureQuestionAnalysisJobsForSession, restorePersistedQuestionAnalysisJobs } = await jiti.import("./rpc-manager.ts");
const { acquireSessionRuntimeOwnership } = await jiti.import("./session-runtime-ownership.ts");
const activity = await jiti.import("./session-activity.ts");

test.after(async () => {
  if (previousActivityFile === undefined) delete process.env.PI_WEB_SESSION_ACTIVITY_FILE;
  else process.env.PI_WEB_SESSION_ACTIVITY_FILE = previousActivityFile;
  await environment.restore();
});

async function fixture(label) {
  const cwd = join(environment.root, label);
  await mkdir(cwd, { recursive: true });
  const manager = SessionManager.create(cwd, join(environment.root, "sessions"));
  manager.appendCustomEntry("pi-web:subagent", {
    version: 1,
    parentSessionId: "fixture-parent",
    parentSessionPath: join(environment.root, "parent.jsonl"),
    parentToolCallId: "fixture-tool-call",
    profile: "fixture",
    description: "fixture task",
    task: "fixture task",
    runInBackground: false,
    createdAt: new Date(0).toISOString(),
    resourceSnapshot: { version: 1, tools: [], loadSkills: false, loadExtensions: false, appendSystemPrompt: [] },
  });
  manager.appendMessage({ role: "user", content: "fixture task", timestamp: Date.now() });
  return { manager, id: manager.getSessionId(), file: manager.getSessionFile() };
}

function cleanup(t, wrappers, release = () => {}) {
  t.after(async () => {
    release();
    for (const wrapper of new Set(wrappers)) {
      await wrapper.waitUntilReady().catch(() => {});
      await wrapper.shutdown();
    }
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// The external SDK event source is controlled; Reader bookkeeping is real.
function eventSource(id, runtimeOwnership) {
  const listeners = new Set();
  const inner = {
    sessionId: id,
    sessionFile: undefined,
    isStreaming: false,
    isBashRunning: false,
    isCompacting: false,
    pendingMessageCount: 0,
    sessionManager: { getCwd: () => environment.root, getEntries: () => [] },
    settingsManager: { getCompactionSettings: () => ({ enabled: false }) },
    agent: { state: { messages: [] } },
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    dispose: () => listeners.clear(),
  };
  const wrapper = new AgentSessionWrapper(inner, undefined, undefined, { runtimeOwnership });
  wrapper.start();
  return { wrapper, emit: (event) => { for (const listener of listeners) listener(event); } };
}

test("concurrent opens share one runtime and one conversation position", async (t) => {
  const { id, file } = await fixture("concurrent");
  const opened = await Promise.all(Array.from({ length: 3 }, () => startRpcSession(id, file, undefined)));
  cleanup(t, opened.map((result) => result.session));
  const wrapper = opened[0].session;
  for (const result of opened) assert.equal(result.session, wrapper);
  assert.equal(getRpcSession(id), wrapper);
  await wrapper.waitUntilReady();
  const leaf = wrapper.inner.sessionManager.appendMessage({ role: "assistant", content: "fixture answer", stopReason: "stop", timestamp: Date.now() });
  const reopened = await startRpcSession(id, file, undefined);
  assert.equal(reopened.session, wrapper);
  assert.equal(reopened.session.inner.sessionManager.getLeafId(), leaf);
  assert.equal(reopened.session.inner.sessionManager.buildSessionContext().messages.at(-1).content, "fixture answer");
});

test("new no-tools runtimes stay transient during startup and extension binding", async (t) => {
  const cwd = join(environment.root, "draft");
  await mkdir(cwd, { recursive: true });
  const { session, realSessionId } = await startRpcSession("fixture-new-draft", "", cwd, { toolNames: [] });
  cleanup(t, [session]);
  await session.waitUntilReady();
  assert.equal(getRpcSession(realSessionId), session);
  assert.equal(existsSync(session.sessionFile), false);
});

test("replacement waits for extension shutdown and loads its final conversation position", async (t) => {
  const { id, file } = await fixture("shutdown");
  const { session: original } = await startRpcSession(id, file, undefined);
  const wrappers = [original];
  const entered = deferred();
  const release = deferred();
  cleanup(t, wrappers, () => release.resolve());
  await original.waitUntilReady();
  const emit = original.inner.extensionRunner.emit.bind(original.inner.extensionRunner);
  original.inner.extensionRunner.emit = async (event) => {
    if (event.type === "session_shutdown") {
      entered.resolve();
      await release.promise;
      original.inner.sessionManager.appendCustomEntry("fixture-shutdown-state", { tasks: [{ id: 4, status: "completed" }] });
    }
    return emit(event);
  };
  const closing = original.shutdown();
  await entered.promise;
  const reopening = startRpcSession(id, file, undefined);
  release.resolve();
  await closing;
  const { session: replacement } = await reopening;
  wrappers.push(replacement);
  assert.notEqual(replacement, original);
  assert.equal(original.isAlive(), false);
  assert.equal(getRpcSession(id), replacement);
  assert.deepEqual(replacement.inner.sessionManager.getBranch().at(-1).data, { tasks: [{ id: 4, status: "completed" }] });
});

test("rejected concurrent opens release admission for a valid retry", async (t) => {
  const { id, file } = await fixture("retry");
  const wrong = await fixture("retry-wrong");
  const rejected = await Promise.allSettled(Array.from({ length: 3 }, () => startRpcSession(id, wrong.file, undefined)));
  for (const result of rejected) {
    assert.equal(result.status, "rejected");
    assert.match(result.reason.message, /session identity changed/i);
  }
  const { session } = await startRpcSession(id, file, undefined);
  cleanup(t, [session]);
  assert.equal(getRpcSession(id), session);
});

test("failure after SDK creation releases ownership before a valid retry", async (t) => {
  const { id, file } = await fixture("failed-sdk-start");
  await assert.rejects(startRpcSession(id, file, undefined, { fastMode: "fast" }), /Fast mode is not available/);
  assert.equal(getRpcSession(id), undefined);
  const { session } = await startRpcSession(id, file, undefined);
  cleanup(t, [session]);
  assert.equal(getRpcSession(id), session);
});

test("an idle runtime without a run cannot erase a working runtime's ledger", (t) => {
  const idle = eventSource("fixture-shared-runtime");
  const working = eventSource("fixture-shared-runtime");
  t.after(() => { idle.wrapper.destroy(); working.wrapper.destroy(); });
  working.emit({ type: "agent_start" });
  const run = activity.getSessionRunRecords().find((record) => record.sessionId === "fixture-shared-runtime");
  idle.wrapper.destroy();
  assert.equal(working.wrapper.isAlive(), true);
  assert.equal(activity.getSessionRunRecords().find((record) => record.runId === run.runId).status, "running");
  working.emit({ type: "agent_settled" });
  assert.equal(activity.getSessionRunRecords().find((record) => record.runId === run.runId).status, "completed");
});

test("a long-running model remains alive across idle timer deadlines", (t) => {
  const previousTimeout = process.env.PI_WEB_IDLE_TIMEOUT_MS;
  process.env.PI_WEB_IDLE_TIMEOUT_MS = "20";
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const working = eventSource("fixture-long-model");
  t.after(() => {
    working.wrapper.destroy();
    if (previousTimeout === undefined) delete process.env.PI_WEB_IDLE_TIMEOUT_MS;
    else process.env.PI_WEB_IDLE_TIMEOUT_MS = previousTimeout;
  });
  working.wrapper.inner.isStreaming = true;
  working.emit({ type: "agent_start" });
  t.mock.timers.tick(100);
  assert.equal(working.wrapper.isAlive(), true);
  assert.equal(working.wrapper.isRunning(), true);
  working.emit({ type: "agent_settled" });
});

test("active runs survive multiple idle deadlines after the last client disconnects", async (t) => {
  const { file } = await fixture("no-clients");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const working = eventSource("fixture-no-clients", acquireSessionRuntimeOwnership(file));
  t.after(async () => { await working.wrapper.shutdown(); });
  const disconnect = working.wrapper.onEvent(() => {});
  working.wrapper.inner.isStreaming = true;
  working.emit({ type: "agent_start" });
  disconnect();
  for (let deadline = 0; deadline < 3; deadline++) {
    t.mock.timers.tick(600_000);
    assert.equal(working.wrapper.isAlive(), true);
    assert.equal(working.wrapper.isRunning(), true);
  }
  working.wrapper.inner.isStreaming = false;
  working.emit({ type: "agent_settled" });
  t.mock.timers.tick(600_000);
  await working.wrapper.waitUntilDisposed();
  assert.equal(working.wrapper.isAlive(), false);
  const next = acquireSessionRuntimeOwnership(file); next.release();
});

test("late SDK settlement cannot finish or delete a replacement runtime's run", (t) => {
  const original = eventSource("fixture-late-runtime");
  t.after(() => original.wrapper.destroy());
  original.emit({ type: "agent_start" });
  const run = activity.getSessionRunRecords().find((record) => record.sessionId === "fixture-late-runtime");
  activity.recordSessionRunUnknown(run.sessionId, run.runId);
  const replacement = activity.recordSessionRunStart(run.sessionId, environment.root);
  original.emit({ type: "agent_settled" });
  original.wrapper.destroy();
  const records = activity.getSessionRunRecords();
  assert.equal(records.find((record) => record.runId === run.runId).status, "completed");
  assert.equal(records.find((record) => record.runId === replacement.runId).status, "running");
  activity.recordSessionRunSettled(replacement.sessionId, replacement.runId);
});

for (const close of ["destroyForProcessExit", "shutdown"]) {
  test(`${close} keeps an SDK-cancelled run unknown without releasing writer ownership early`, async t => {
    const { file } = await fixture(`cancelled-${close}`);
    const ownership = acquireSessionRuntimeOwnership(file);
    const source = eventSource(`fixture-cancelled-${close}`, ownership);
    const { wrapper } = source;
    const cancelled = deferred(), releaseWriter = deferred();
    const delivered = [];
    const trace = [];
    wrapper.onEvent(event => delivered.push(event));
    wrapper.inner.isStreaming = true;
    source.emit({ type: "agent_start" });
    const started = activity.getSessionRunRecords().find(record => record.sessionId === wrapper.sessionId);
    wrapper.inner.extensionRunner = { emit: async () => { await cancelled.promise; } };
    wrapper.inner.abort = async () => {
      trace.push("abort");
      source.emit({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "aborted" }] });
      source.emit({ type: "agent_settled", aborted: true });
      trace.push("agent_settled");
      wrapper.inner.isStreaming = false;
      cancelled.resolve();
      await releaseWriter.promise;
    };
    t.after(async () => { releaseWriter.resolve(); await wrapper.shutdown(); ownership.release(); });
    await wrapper[close]();
    await wrapper.waitUntilDisposed();
    assert.deepEqual(trace, ["abort", "agent_settled"], "the cancellation event must reach Reader before unsubscribe");
    assert.throws(() => acquireSessionRuntimeOwnership(file), { code: "session_runtime_owned" });
    assert.equal(activity.getSessionRunRecords().find(record => record.runId === started.runId).status, "unknown");
    wrapper.emitPromptDone();
    assert.equal(delivered.some(event => event.type === "agent_settled" || event.type === "prompt_done"), false,
      "teardown is not a successful completion event for observers");
    const persisted = JSON.parse(await readFile(process.env.PI_WEB_SESSION_ACTIVITY_FILE, "utf8"));
    assert.equal(persisted.records.find(record => record.runId === started.runId).status, "unknown");
    releaseWriter.resolve();
    await new Promise(resolve => setImmediate(resolve));
    const replacement = acquireSessionRuntimeOwnership(file); replacement.release();
  });
}

test("normal settlement still completes its own run before idle teardown", async t => {
  const source = eventSource("fixture-normal-settlement");
  t.after(() => source.wrapper.shutdown());
  const delivered = [];
  source.wrapper.onEvent(event => delivered.push(event.type));
  source.emit({ type: "agent_start" });
  const started = activity.getSessionRunRecords().find(record => record.sessionId === source.wrapper.sessionId);
  source.emit({ type: "agent_settled", aborted: false });
  await source.wrapper.shutdown();
  assert.equal(activity.getSessionRunRecords().find(record => record.runId === started.runId).status, "completed");
  assert.equal(delivered.includes("agent_settled"), true);
});

test("another Reader process cannot open an owned transcript or mutate its native entries", { timeout: 30000 }, async t => {
  const { id, file } = await fixture("other-process");
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createJiti } from ${JSON.stringify(import.meta.resolve("jiti"))};
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    const { startRpcSession } = await jiti.import(${JSON.stringify(new URL("./rpc-manager.ts", import.meta.url).pathname)});
    const { session } = await startRpcSession(${JSON.stringify(id)}, ${JSON.stringify(file)}, undefined);
    await session.waitUntilReady();
    process.on('message', async () => { await session.shutdown(); process.send('released'); process.disconnect(); });
    process.send('owned');
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(async () => { if (child.exitCode !== null || child.signalCode !== null) return; const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; });
  assert.equal((await once(child, "message"))[0], "owned", stderr);
  const before = await readFile(file, "utf8");
  await assert.rejects(startRpcSession(id, file, undefined), error => {
    assert.equal(error.code, "session_runtime_owned"); assert.equal(error.owner.pid, child.pid); return true;
  });
  assert.equal(getRpcSession(id), undefined); assert.equal(await readFile(file, "utf8"), before);
  const released = once(child, "message"); child.send("release"); await released;
  const { session } = await startRpcSession(id, file, undefined); cleanup(t, [session]);
  assert.equal(session.inner.sessionManager.getSessionId(), id);
});

test("shutdown deadline never transfers ownership while late native writers can still append", async t => {
  const { file } = await fixture("late-writer");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  const ownership = acquireSessionRuntimeOwnership(file);
  const { wrapper } = eventSource("fixture-late-writer", ownership);
  const releaseHook = deferred(), releaseAbort = deferred();
  wrapper.inner.abort = () => releaseAbort.promise;
  wrapper.inner.extensionRunner = { emit: async () => { await releaseHook.promise; appendFileSync(file, '{"type":"fixture-late-write"}\n'); } };
  t.after(async () => { releaseHook.resolve(); releaseAbort.resolve(); await wrapper.shutdown(); ownership.release(); });
  const closing = wrapper.shutdown();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(5000); await closing;
  assert.equal(wrapper.isAlive(), false);
  assert.throws(() => acquireSessionRuntimeOwnership(file), { code: "session_runtime_owned" });
  releaseHook.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => acquireSessionRuntimeOwnership(file), { code: "session_runtime_owned" });
  releaseAbort.resolve(); await new Promise(resolve => setImmediate(resolve));
  const next = acquireSessionRuntimeOwnership(file); next.release();
  assert.match(await readFile(file, "utf8"), /fixture-late-write/);
});

test("GET recovery helpers cannot rehydrate cold pending terminology work", async () => {
  const { id, file, manager } = await fixture("cold-terminology");
  manager.appendCustomEntry("question-terminology", {
    version: 1, jobId: "fixture-job", targetEntryId: manager.getLeafId(), status: "pending",
    question: "fixture question", mode: "context", model: { provider: "fixture", modelId: "no-network" },
    priorContext: "", context: { source: "recent-messages", summaryChars: 0, recentChars: 0, recentMessages: 0 }, requestedAt: 10,
  });
  const before = await readFile(file, "utf8");
  await ensureQuestionAnalysisJobsForSession(id, file);
  await restorePersistedQuestionAnalysisJobs([{ id, path: file }]);
  assert.equal(getRpcSession(id), undefined); assert.equal(await readFile(file, "utf8"), before);
});

test("UI teardown stays prompt while an unfinished SDK abort retains write ownership", async t => {
  const { file } = await fixture("abort-lifetime");
  const ownership = acquireSessionRuntimeOwnership(file);
  const { wrapper } = eventSource("fixture-abort-lifetime", ownership);
  const abort = deferred(); wrapper.inner.abort = () => abort.promise;
  t.after(async () => { abort.resolve(); await wrapper.shutdown(); ownership.release(); });
  await wrapper.shutdown();
  assert.equal(wrapper.isAlive(), false);
  assert.throws(() => acquireSessionRuntimeOwnership(file), { code: "session_runtime_owned" });
  abort.resolve(); await new Promise(resolve => setImmediate(resolve));
  const next = acquireSessionRuntimeOwnership(file); next.release();
});

test("failed extension binding closes an owned runtime and releases its admission", async t => {
  const { file } = await fixture("extension-start-failure");
  t.mock.method(console, "error", () => {});
  const ownership = acquireSessionRuntimeOwnership(file);
  const { wrapper } = eventSource("fixture-extension-start-failure", ownership);
  wrapper.inner.bindExtensions = async () => { throw new Error("fixture extension failure"); };
  t.after(async () => { await wrapper.shutdown(); ownership.release(); });
  wrapper.beginExtensionBinding();
  await assert.rejects(wrapper.waitUntilReady(), /fixture extension failure/);
  await wrapper.shutdown(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(wrapper.isAlive(), false);
  const next = acquireSessionRuntimeOwnership(file); next.release();
});
