import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import vm from "node:vm";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";
// Jiti may cache imported builtins. Install stable forwarders before loading the
// production modules; each test changes only the fault branch, not that binding.
const io = { openSync: fs.openSync, writeFileSync: fs.writeFileSync, unlinkSync: fs.unlinkSync };
let faults = {};
const openedFiles = new Map();
for (const name of Object.keys(io)) fs[name] = (...args) => {
  const result = (faults[name] ?? io[name])(...args);
  if (name === "openSync") openedFiles.set(result, args[0]);
  return result;
};
syncBuiltinESMExports();
after(() => { Object.assign(fs, io); syncBuiltinESMExports(); });
const { quickAskFixture, context, log, storage } = await import("../test-support/quick-ask-fixture.mjs");

const scope = { threadId: "a", branchId: "main" };
const require = createRequire(import.meta.url);
const ts = require("typescript");
const { QuickAskRuntime } = await createJiti(import.meta.url).import("./quick-ask-runtime.ts");
const { acquireSessionRuntimeOwnership } = await createJiti(import.meta.url).import("./session-runtime-ownership.ts");
const rpcSource = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
const forkSource = rpcSource.slice(rpcSource.indexOf("export async function forkQuickAskSession("),
  rpcSource.indexOf("export async function inheritSubprojectAssignment("));
const exports = {};
vm.runInNewContext(ts.transpileModule(forkSource, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText, { exports, console, SessionManager, acquireSessionRuntimeOwnership, ...context, ...log,
  getLocks: () => new Map(), getRpcSession: () => undefined,
  projectSessionQuickAsksForFork: storage.projectSessionQuickAsks,
  invalidateSessionReadCache() {}, cacheSessionPath() {}, invalidateSessionListCache() {},
  inheritSubprojectAssignment: async () => true,
});
const coldFork = (h) => exports.forkQuickAskSession(h.manager.getSessionId(), h.file, scope);
const records = (h) => SessionManager.open(h.file).getEntries();
const pending = (h) => records(h).findLast((entry) => entry.type === "custom" && entry.customType === log.QUICK_ASK_TRANSFER_PENDING);
const failed = (h) => records(h).filter((entry) => entry.type === "custom" && entry.customType === log.QUICK_ASK_TRANSFER_FAILED);
const destinations = async (h) => (await readdir(h.root)).filter((name) => name.endsWith(".jsonl") && !h.file.endsWith(name));
const ioError = (code) => Object.assign(new Error(`synthetic ${code} destination failure`), { code });
function isDestination(h, file) {
  const path = typeof file === "number" ? openedFiles.get(file) : file;
  return typeof path === "string" && path.endsWith(".jsonl") && path !== h.file;
}
async function seeded() {
  const h = await quickAskFixture();
  const run = await h.start();
  h.runs[0].complete("saved answer");
  await h.waitTerminal(run.id);
  return h;
}
function restarted(h) {
  const manager = SessionManager.open(h.file);
  return new QuickAskRuntime({ ...h.host, manager, assertWritable() {},
    append(type, data) { const id = manager.appendCustomEntry(type, data); return manager.getEntry(id); },
  }, async () => h.runs[0].runtime, () => {});
}
function failCreation(_t, h, code = "EACCES") {
  const open = io.openSync;
  faults.openSync = (file, flags, ...args) => {
    if (flags === "wx" && isDestination(h, file)) throw ioError(code);
    return open(file, flags, ...args);
  };
}
function restore() { faults = {}; }

for (const mode of ["hot", "cold"]) {
  test(`${mode} known-no-effect creation failure settles durably and can retry once`, async (t) => {
    const h = await seeded();
    const fork = () => mode === "hot" ? h.side.fork(scope) : coldFork(h);
    try {
      failCreation(t, h);
      await assert.rejects(fork(), /synthetic EACCES/);
      assert.equal(failed(h).length, 1);
      assert.equal(failed(h)[0].data.effect, "none");
      assert.equal(failed(h)[0].data.attemptId, pending(h).data.attemptId);
      assert.equal(log.quickAskTransferResult(records(h), scope), undefined);
      assert.deepEqual(await destinations(h), []);
      restore(t);
      const result = await fork();
      assert.equal(result.success, true);
      assert.equal((await fork()).newSessionId, result.newSessionId);
      assert.equal((await destinations(h)).length, 1, "retry must not duplicate the successful destination");
    } finally { restore(t); await h.cleanup(); }
  });

  test(`${mode} failed transfer remains usable for another question after restart`, async (t) => {
    const h = await seeded();
    let recovered;
    try {
      failCreation(t, h, "ENOSPC");
      await assert.rejects(mode === "hot" ? h.side.fork(scope) : coldFork(h), /synthetic ENOSPC/);
      restore(t);
      h.side.close();
      recovered = restarted(h);
      const next = await recovered.start({ ...scope, question: "continue after failed transfer", images: [] });
      assert.equal(next.status, "running");
      await recovered.whenReady(next.id);
      const terminal = new Promise((resolve) => recovered.subscribe(next.id, (event) => {
        if (event.type === "done" || event.type === "error") resolve(event);
      }));
      h.runs.at(-1).complete("continued answer");
      assert.equal((await terminal).type, "done");
      const result = await recovered.fork(scope);
      const transcript = JSON.stringify(SessionManager.open(result.newSessionPath).buildSessionContext());
      assert.match(transcript, /saved answer/);
      assert.match(transcript, /continue after failed transfer/);
      assert.equal((await destinations(h)).length, 1);
    } finally { restore(t); recovered?.close(); await h.cleanup(); }
  });
}

test("hot creation failure allows continued questions without restarting the runtime", async (t) => {
  const h = await seeded();
  try {
    failCreation(t, h);
    await assert.rejects(h.side.fork(scope), /synthetic EACCES/);
    restore(t);
    const next = await h.start({ question: "continue in the same runtime" });
    h.runs.at(-1).complete("still usable");
    assert.equal((await h.waitTerminal(next.id)).status, "completed");
    assert.equal(h.state.closed, false);
  } finally { restore(t); await h.cleanup(); }
});

test("successful cleanup of a partial destination is known-no-effect and retryable", async (t) => {
  const h = await seeded();
  const write = io.writeFileSync;
  try {
    faults.writeFileSync = (file, data, ...args) => {
      if (isDestination(h, file)) { write(file, String(data).slice(0, 80)); throw ioError("ENOSPC"); }
      return write(file, data, ...args);
    };
    await assert.rejects(h.side.fork(scope), /synthetic ENOSPC/);
    assert.equal(failed(h).length, 1);
    assert.deepEqual(await destinations(h), []);
    restore(t);
    assert.equal((await coldFork(h)).success, true);
    assert.equal((await destinations(h)).length, 1);
  } finally { restore(t); await h.cleanup(); }
});

for (const mode of ["hot", "cold"]) {
  test(`${mode} unknown cleanup retains pending across restart and recovers only the matching target`, async (t) => {
    const h = await seeded();
    const write = io.writeFileSync;
    let contents;
    let recovered;
    try {
      faults.writeFileSync = (file, data, ...args) => {
        if (isDestination(h, file)) { contents = String(data); write(file, contents.slice(0, 80)); throw ioError("EIO"); }
        return write(file, data, ...args);
      };
      faults.unlinkSync = (file) => { if (isDestination(h, file)) throw ioError("EACCES"); return io.unlinkSync(file); };
      await assert.rejects(mode === "hot" ? h.side.fork(scope) : coldFork(h), /synthetic EIO/);
      const reservation = pending(h).data;
      const destination = reservation.destination.result;
      assert.equal(failed(h).length, 0, "uncertain cleanup must never emit a retryable terminal state");
      assert.throws(() => log.quickAskTransferResult(records(h), scope), { status: 409 });
      restore(t);
      h.side.close();
      recovered = restarted(h);
      await assert.rejects(recovered.start({ ...scope, question: "must remain blocked", images: [] }), { status: 409 });
      await assert.rejects(recovered.fork(scope), { status: 409 });
      await assert.rejects(coldFork(h), { status: 409 });
      assert.equal((await destinations(h)).length, 1, "uncertain retries may not allocate another target");
      assert.equal(pending(h).data.attemptId, reservation.attemptId);
      // Recovery observes, never rewrites, the exact reserved file. Later main
      // turns on that destination must not make a successful transfer unrecoverable.
      write(destination.newSessionPath, contents);
      SessionManager.open(destination.newSessionPath).appendMessage({ role: "user", content: "target already continued", timestamp: 2 });
      const result = await coldFork(h);
      assert.equal(result.newSessionId, destination.newSessionId);
      assert.equal(result.newSessionPath, destination.newSessionPath);
      assert.equal((await destinations(h)).length, 1);
      assert.match(JSON.stringify(SessionManager.open(result.newSessionPath).buildSessionContext()), /target already continued/);
      assert.equal((await coldFork(h)).newSessionId, result.newSessionId);
    } finally { restore(t); recovered?.close(); await h.cleanup(); }
  });
}

test("legacy pending and a missing unknown-effect target stay blocked without allocating a replacement", async (t) => {
  const h = await seeded();
  try {
    failCreation(t, h, "EIO");
    await assert.rejects(h.side.fork(scope), /synthetic EIO/);
    restore(t);
    assert.equal(failed(h).length, 0);
    await assert.rejects(coldFork(h), { status: 409 });
    assert.deepEqual(await destinations(h), []);
    const legacy = { threadId: "legacy", branchId: "main" };
    h.host.append(log.QUICK_ASK_TRANSFER_PENDING, legacy);
    assert.throws(() => log.quickAskTransferResult(records(h), legacy), { status: 409 });
    await assert.rejects(exports.forkQuickAskSession(h.manager.getSessionId(), h.file, legacy), { status: 409 });
    assert.deepEqual(await destinations(h), []);
  } finally { restore(t); await h.cleanup(); }
});

for (const mode of ["hot", "cold"]) {
  test(`${mode} failure-settlement append failure preserves unknown instead of reopening the thread`, async (t) => {
    const h = await seeded();
    let recovered;
    const append = SessionManager.prototype.appendCustomEntry;
    try {
      t.mock.method(SessionManager.prototype, "appendCustomEntry", function (type, data) {
        if (this.getSessionFile() === h.file && type === log.QUICK_ASK_TRANSFER_FAILED) throw new Error("synthetic failure-settlement append failure");
        return append.call(this, type, data);
      });
      failCreation(t, h);
      await assert.rejects(mode === "hot" ? h.side.fork(scope) : coldFork(h), /failure-settlement append failure/);
      assert.equal(failed(h).length, 0);
      assert.equal(log.quickAskTransferState(records(h), scope).status, "pending");
      if (mode === "hot") assert.equal(h.state.closed, true, "uncertain source persistence must quarantine its manager");
      restore(t);
      t.mock.restoreAll();
      h.side.close();
      recovered = restarted(h);
      await assert.rejects(recovered.start({ ...scope, question: "cannot assume settlement", images: [] }), { status: 409 });
      await assert.rejects(coldFork(h), { status: 409 });
      assert.deepEqual(await destinations(h), []);
    } finally { restore(t); t.mock.restoreAll(); recovered?.close(); await h.cleanup(); }
  });
}

test("a complete target survives first success-settlement failure and is recovered without another creation", async (t) => {
  const h = await seeded();
  const append = h.manager.appendCustomEntry.bind(h.manager);
  try {
    t.mock.method(h.manager, "appendCustomEntry", (type, data) => {
      if (type === log.QUICK_ASK_TRANSFER_PENDING && data.result) throw new Error("synthetic first success-settlement failure");
      return append(type, data);
    });
    await assert.rejects(h.side.fork(scope), /first success-settlement failure/);
    assert.equal(h.state.closed, true);
    const destination = pending(h).data.destination.result;
    assert.equal(failed(h).length, 0);
    t.mock.restoreAll();
    const result = await coldFork(h);
    assert.equal(result.newSessionId, destination.newSessionId);
    assert.equal(result.newSessionPath, destination.newSessionPath);
    assert.equal((await destinations(h)).length, 1);
    assert.equal(log.quickAskTransferResult(records(h), scope).newSessionId, result.newSessionId);
  } finally { t.mock.restoreAll(); await h.cleanup(); }
});

for (const mode of ["hot", "cold"]) {
  test(`${mode} uncertain reservation append never starts a destination or erases the durable pending`, async (t) => {
    const h = await seeded();
    const append = SessionManager.prototype.appendCustomEntry;
    try {
      t.mock.method(SessionManager.prototype, "appendCustomEntry", function (type, data) {
        const id = append.call(this, type, data);
        if (this.getSessionFile() === h.file && type === log.QUICK_ASK_TRANSFER_PENDING && !data.result) {
          throw new Error("synthetic reservation append unconfirmed");
        }
        return id;
      });
      await assert.rejects(mode === "hot" ? h.side.fork(scope) : coldFork(h), /reservation append unconfirmed/);
      assert.equal(log.quickAskTransferState(records(h), scope).status, "pending");
      assert.equal(failed(h).length, 0);
      assert.deepEqual(await destinations(h), []);
      if (mode === "hot") assert.equal(h.state.closed, true);
      t.mock.restoreAll();
      await assert.rejects(coldFork(h), { status: 409 });
      assert.deepEqual(await destinations(h), []);
    } finally { t.mock.restoreAll(); await h.cleanup(); }
  });
}

test("actual cold RPC export settles EACCES and retries with real filesystem and metadata integration", async (t) => {
  const h = await seeded();
  const overrides = { HOME: h.root, PI_CODING_AGENT_DIR: `${h.root}/agent`,
    PI_WEB_SUBPROJECTS_FILE: `${h.root}/subprojects.json`, PI_WEB_SESSION_ACTIVITY_FILE: `${h.root}/activity.json` };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    const { forkQuickAskSession, getRpcSession } = await createJiti(import.meta.url).import("./rpc-manager.ts");
    const id = h.manager.getSessionId();
    assert.equal(getRpcSession(id), undefined);
    failCreation(t, h);
    await assert.rejects(forkQuickAskSession(id, h.file, scope), /synthetic EACCES/);
    assert.equal(failed(h).length, 1);
    restore(t);
    const result = await forkQuickAskSession(id, h.file, scope);
    assert.equal(result.success, true);
    assert.equal((await forkQuickAskSession(id, h.file, scope)).newSessionId, result.newSessionId);
    assert.equal(SessionManager.open(result.newSessionPath).getSessionId(), result.newSessionId);
    assert.equal((await destinations(h)).length, 1);
    assert.equal(getRpcSession(id), undefined, "cold recovery must never boot the Agent");
  } finally {
    restore(t);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await h.cleanup();
  }
});
