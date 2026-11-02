import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { quickAskFixture, context, log, storage, deferred, tick } from "../test-support/quick-ask-fixture.mjs";

// Exercise actual registered SDK runtimes, with no user configuration or model calls.
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
const oldActivityFile = process.env.PI_WEB_SESSION_ACTIVITY_FILE;
const agentDir = await mkdtemp(join(tmpdir(), "reader-cold-fork-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_WEB_SESSION_ACTIVITY_FILE = join(agentDir, "activity.json");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getRpcSession, startRpcSession } = await jiti.import("./rpc-manager.ts");
const { acquireSessionRuntimeOwnership } = await jiti.import("./session-runtime-ownership.ts");
after(async () => {
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  if (oldActivityFile === undefined) delete process.env.PI_WEB_SESSION_ACTIVITY_FILE;
  else process.env.PI_WEB_SESSION_ACTIVITY_FILE = oldActivityFile;
  await rm(agentDir, { recursive: true, force: true });
});
const require = createRequire(import.meta.url);
const ts = require("typescript");
const rpcSource = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
const forkSource = rpcSource.slice(rpcSource.indexOf("export async function forkQuickAskSession("),
  rpcSource.indexOf("export async function inheritSubprojectAssignment("));
const forkCode = ts.transpileModule(forkSource, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const scope = { threadId: "a", branchId: "main" };

async function coldForkFixture() {
  const h = await quickAskFixture();
  const run = await h.start();
  h.runs[0].complete();
  await h.waitTerminal(run.id);
  const entered = deferred(), inherit = deferred();
  const exports = {};
  // Only optional metadata inheritance is gated. The fork, SDK, registry,
  // startup lock and live wrapper persistence methods are the production ones.
  vm.runInNewContext(forkCode, { exports, console, SessionManager, ...context, ...log,
    getLocks: () => (globalThis.__piStartLocks ??= new Map()), getRpcSession, acquireSessionRuntimeOwnership,
    projectSessionQuickAsksForFork: storage.projectSessionQuickAsks,
    invalidateSessionReadCache() {}, cacheSessionPath() {}, invalidateSessionListCache() {},
    inheritSubprojectAssignment: async () => { entered.resolve(); return inherit.promise; },
  });
  const id = h.manager.getSessionId();
  const wrappers = [];
  return { ...h, id, entered, inherit,
    fork: () => exports.forkQuickAskSession(id, h.file, scope),
    async startRuntime() {
      const started = await startRpcSession(id, h.file, undefined, { toolNames: [] });
      wrappers.push(started.session);
      return started.session;
    },
    async cleanup() {
      inherit.resolve(true);
      for (const wrapper of wrappers.reverse()) await wrapper.shutdown();
      await h.cleanup();
    },
  };
}
function appendMain(manager, text) {
  return manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
}
function assertReachable(manager, ...ids) {
  const branchIds = new Set(manager.getBranch().map((entry) => entry.id));
  for (const id of ids) assert.ok(branchIds.has(id), `${id} must remain reachable from the active leaf`);
}
function transfers(manager) {
  return manager.getEntries().filter((entry) => entry.type === "custom"
    && [log.QUICK_ASK_TRANSFER_PENDING, log.QUICK_ASK_TRANSFER].includes(entry.customType));
}

test("cold fork reacquires the latest SDK leaf after metadata inheritance yields", async () => {
  const h = await coldForkFixture();
  try {
    const fork = h.fork();
    await h.entered.promise;
    const prefix = await readFile(h.file, "utf8");
    const writer = SessionManager.open(h.file);
    const mainId = appendMain(writer, "main conversation admitted while inheritance waits");
    h.inherit.resolve(false);
    const result = await fork;
    const reopened = SessionManager.open(h.file);
    assertReachable(reopened, mainId);
    const markers = transfers(reopened);
    assert.equal(markers.length, 3);
    assert.equal(markers[1].parentId, mainId);
    assert.equal(markers[2].parentId, markers[1].id);
    assert.equal(result.subprojectAssignmentFailed, true);
    assert.deepEqual(log.quickAskTransferResult(reopened.getEntries(), scope), structuredClone(result));
    assert.equal((await h.fork()).newSessionId, result.newSessionId);
    assert.equal(transfers(SessionManager.open(h.file)).length, 3);
    assert.ok((await readFile(h.file, "utf8")).startsWith(prefix));
    assert.equal(getRpcSession(h.id), undefined);
  } finally { await h.cleanup(); }
});

test("cold fork hands final records to the actual runtime admitted during inheritance", async () => {
  const h = await coldForkFixture();
  try {
    const fork = h.fork();
    await h.entered.promise;
    const owner = await h.startRuntime();
    const mainId = appendMain(owner.inner.sessionManager, "live main conversation before transfer");
    h.inherit.resolve(true);
    const result = await fork;
    const markers = transfers(owner.inner.sessionManager);
    assert.equal(markers.length, 3, "the live SDK index owns both completion records");
    assert.equal(markers[1].parentId, mainId);
    const laterId = appendMain(owner.inner.sessionManager, "live main conversation after transfer");
    assertReachable(owner.inner.sessionManager, mainId, laterId, markers[2].id);
    assertReachable(SessionManager.open(h.file), mainId, laterId, markers[2].id);
    assert.equal((await h.fork()).newSessionId, result.newSessionId);
    assert.equal(transfers(owner.inner.sessionManager).length, 3);
  } finally { await h.cleanup(); }
});

test("cold completion waits for real replacement admission and writes only through the replacement", async () => {
  const h = await coldForkFixture();
  let releaseShutdown;
  let replacement;
  try {
    const fork = h.fork();
    await h.entered.promise;
    const old = await h.startRuntime();
    const shutdownEntered = deferred(), shutdown = deferred();
    releaseShutdown = shutdown.resolve;
    old.inner.extensionRunner.emit = async () => { shutdownEntered.resolve(); await shutdown.promise; };
    const closing = old.shutdown();
    await shutdownEntered.promise;
    replacement = h.startRuntime();
    assert.ok(globalThis.__piStartLocks.has(h.id));
    let completed = false;
    void fork.then(() => { completed = true; }, () => {});
    h.inherit.resolve(true);
    await tick();
    assert.equal(completed, false, "completion must not bypass the existing runtime admission lock");
    assert.equal(transfers(SessionManager.open(h.file)).length, 1);
    releaseShutdown();
    await closing;
    const owner = await replacement;
    assert.ok(owner !== old);
    const result = await fork;
    assert.equal(result.success, true);
    assert.equal(transfers(old.inner.sessionManager).length, 1);
    const markers = transfers(owner.inner.sessionManager);
    assert.equal(markers.length, 3);
    const mainId = appendMain(owner.inner.sessionManager, "replacement main turn");
    assertReachable(SessionManager.open(h.file), mainId, markers[2].id);
  } finally { releaseShutdown?.(); await replacement; await h.cleanup(); }
});

test("handoff append failure uses wrapper quarantine and preserves the ready transfer for recovery", async (t) => {
  const h = await coldForkFixture();
  try {
    const fork = h.fork();
    await h.entered.promise;
    const owner = await h.startRuntime();
    const manager = owner.inner.sessionManager;
    const mainId = appendMain(manager, "main turn preceding transfer append failure");
    const append = manager.appendCustomEntry.bind(manager);
    t.mock.method(manager, "appendCustomEntry", (type, data) => {
      if (type === log.QUICK_ASK_TRANSFER) throw new Error("synthetic transfer append failure");
      return append(type, data);
    });
    h.inherit.resolve(true);
    await assert.rejects(fork, /synthetic transfer append failure/);
    assert.equal(owner.isAlive(), false, "uncertain live writes must quarantine the runtime");
    const reopened = SessionManager.open(h.file);
    assertReachable(reopened, mainId);
    const markers = transfers(reopened);
    assert.equal(markers.length, 2);
    assert.equal(markers[1].parentId, mainId);
    assert.equal(markers[1].data.result.success, true);
    await owner.shutdown();
    const recovered = await h.fork();
    assert.equal(recovered.newSessionId, markers[1].data.result.newSessionId);
    assert.equal(transfers(SessionManager.open(h.file)).length, 2);
  } finally { await h.cleanup(); }
});

test("cold completion rejects a shutting-down owner instead of writing around it", async () => {
  const h = await coldForkFixture();
  let releaseShutdown;
  try {
    const fork = h.fork();
    await h.entered.promise;
    const owner = await h.startRuntime();
    const entered = deferred(), shutdown = deferred();
    releaseShutdown = shutdown.resolve;
    owner.inner.extensionRunner.emit = async () => { entered.resolve(); await shutdown.promise; };
    const closing = owner.shutdown();
    await entered.promise;
    h.inherit.resolve(true);
    await assert.rejects(fork, /Session is shutting down/);
    assert.equal(transfers(SessionManager.open(h.file)).length, 1);
    releaseShutdown();
    await closing;
    const reserved = transfers(SessionManager.open(h.file))[0].data.destination.result;
    const recovered = await h.fork();
    assert.equal(recovered.newSessionId, reserved.newSessionId, "recovery must reuse the target created before shutdown");
    assert.equal(recovered.newSessionPath, reserved.newSessionPath);
    assert.equal(transfers(SessionManager.open(h.file)).length, 3);
  } finally { releaseShutdown?.(); await h.cleanup(); }
});
