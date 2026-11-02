import assert from "node:assert/strict";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import lockfile from "proper-lockfile";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const durable = await jiti.import("../packages/pi-web-session-control/index.ts");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "reader-session-control-sdk-"));
  const cwd = join(root, "cwd");
  const sessionDirA = join(root, "sessions-a");
  const sessionDirB = join(root, "sessions-b");
  mkdirSync(cwd, { recursive: true });
  return { root, cwd, sessionDirA, sessionDirB };
}

// The SDK initializes a new file through the public open(empty-file) path;
// appendCustomMessageEntry alone intentionally waits for a user/assistant
// conversation. This helper exercises that supported zero-model bootstrap.
function createNativeSessionManager(cwd, sessionDir) {
  const allocation = SessionManager.create(cwd, sessionDir);
  const sessionFile = allocation.getSessionFile();
  assert.ok(sessionFile);
  const fd = openSync(sessionFile, "wx");
  closeSync(fd);
  return SessionManager.open(sessionFile, allocation.getSessionDir(), cwd);
}

function request(cwd, overrides = {}) {
  return {
    idempotencyKey: "sdk-create",
    scope: { callerSessionId: "caller-sdk", cwd },
    initialMessage: "persist this first user question",
    ...overrides,
  };
}

function observation(manager, candidate, runtimeCreated = false, nativeListVisible = true) {
  const sessionFile = manager.getSessionFile();
  const source = candidate.initialMessage === undefined ? "initialization" : "agent-message";
  const messageKind = source === "initialization" ? "generated-initialization" : "agent-initial-message";
  const messageDigest = durable.initialMessageDigest(candidate.initialMessage ?? durable.SESSION_CONTROL_INITIALIZATION_MESSAGE);
  return {
    sessionId: manager.getSessionId(),
    sessionFile,
    persisted: Boolean(sessionFile && existsSync(sessionFile)),
    visibleInSessionList: nativeListVisible,
    nativeListVisible,
    runtimeVisibleInReader: false,
    runtimeCreated,
    source,
    messageKind,
    messageDigest,
    ...(source === "agent-message" ? { initialMessageDigest: messageDigest } : {}),
    nativeRecordValid: true,
  };
}

const admissionLockOptions = {
  realpath: false,
  stale: 30_000,
  update: 10_000,
  retries: { retries: 20, factor: 1, minTimeout: 25, maxTimeout: 500 },
};

async function withSessionAdmissionLock(sessionDir, candidate, operation) {
  mkdirSync(sessionDir, { recursive: true });
  const lockDir = join(sessionDir, ".pi-web-session-control-admission");
  mkdirSync(lockDir, { recursive: true });
  const lockPath = join(lockDir, durable.durableAdmissionLockKey(candidate));
  let compromisedError;
  const lease = {
    assert() {
      if (compromisedError) {
        throw new durable.DurableSessionAdmissionError(`durable session admission lease was compromised: ${compromisedError.message}`);
      }
    },
  };
  const release = await lockfile.lock(lockPath, {
    ...admissionLockOptions,
    onCompromised: (error) => { compromisedError ??= error; },
  });
  let result;
  let operationError;
  let releaseError;
  try {
    lease.assert();
    result = await operation(lease);
    lease.assert();
  } catch (error) {
    operationError = error;
  }
  try {
    await release();
  } catch (error) {
    releaseError = error;
  }
  const leaseErrors = [
    compromisedError ? `durable session admission lease was compromised: ${compromisedError.message}` : "",
    releaseError ? `durable session admission lock release failed: ${releaseError.message}` : "",
  ].filter(Boolean);
  if (leaseErrors.length > 0) {
    const prior = operationError ? (operationError instanceof Error ? operationError.message : String(operationError)) : "";
    throw new durable.DurableSessionAdmissionError([prior, ...leaseErrors].filter(Boolean).join("; "), operationError?.result ?? result);
  }
  if (operationError) throw operationError;
  if (!result) throw new Error("admission operation returned no result");
  return result;
}

function runWorker(workerPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function waitForFile(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

test("real SDK persists the creation marker for a first user question in an isolated sessionDir", async (t) => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const candidate = request(fixture.cwd);
  const manager = createNativeSessionManager(fixture.cwd, fixture.sessionDirA);
  const appended = durable.appendDurableSessionCreate(manager, candidate);
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile && existsSync(sessionFile), "the public SDK bootstrap must leave a native JSONL transcript");
  assert.equal(manager.isPersisted(), true);
  const listedA = await SessionManager.list(fixture.cwd, fixture.sessionDirA);
  assert.equal(listedA.filter((info) => info.id === manager.getSessionId()).length, 1);
  const listedB = await SessionManager.list(fixture.cwd, fixture.sessionDirB);
  assert.equal(listedB.some((info) => info.id === manager.getSessionId()), false, "a separate sessionDir must not see the transcript");
  const reopened = SessionManager.open(sessionFile, undefined);
  const record = durable.findDurableSessionCreateRecord(reopened.getEntries(), candidate.scope, candidate.idempotencyKey);
  assert.equal(record?.sessionId, manager.getSessionId());
  assert.equal(record?.messageKind, "agent-initial-message");
  assert.equal(record?.messageDigest, appended.record.messageDigest);
  assert.equal(durable.validateDurableSessionCreateRecord(reopened.getEntries(), candidate)?.messageDigest, appended.record.messageDigest);
  assert.equal(durable.validateDurableSessionRecord(reopened.getEntries(), record), true);
});

test("real SDK no-argument create writes generated initialization and is list-visible", async (t) => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const candidate = request(fixture.cwd, { idempotencyKey: "sdk-init", initialMessage: undefined });
  const manager = createNativeSessionManager(fixture.cwd, fixture.sessionDirA);
  const appended = durable.appendDurableSessionCreate(manager, candidate);
  assert.equal(appended.record.source, "initialization");
  assert.equal(appended.record.messageKind, "generated-initialization");
  assert.equal(appended.record.messageDigest, durable.initialMessageDigest(durable.SESSION_CONTROL_INITIALIZATION_MESSAGE));
  assert.equal(appended.messageEntryId !== undefined, true);
  assert.equal(manager.getEntries().filter((entry) => entry.type === "custom_message").length, 1);
  assert.equal(manager.getEntries().find((entry) => entry.type === "custom_message").content, durable.SESSION_CONTROL_INITIALIZATION_MESSAGE);
  assert.equal(manager.isPersisted(), true);
  const initFile = manager.getSessionFile();
  assert.ok(initFile && existsSync(initFile));
  const listedA = await SessionManager.list(fixture.cwd, fixture.sessionDirA);
  assert.equal(listedA.some((info) => info.id === manager.getSessionId()), true);
  const listedB = await SessionManager.list(fixture.cwd, fixture.sessionDirB);
  assert.equal(listedB.some((info) => info.id === manager.getSessionId()), false);
  const reopened = SessionManager.open(initFile, undefined);
  assert.equal(durable.validateDurableSessionCreateRecord(reopened.getEntries(), candidate)?.messageKind, "generated-initialization");
  assert.equal(durable.validateDurableSessionRecord(reopened.getEntries(), appended.record), true);
  assert.equal(reopened.getEntries().some((entry) => entry.type === "custom_message" && entry.content === durable.SESSION_CONTROL_INITIALIZATION_MESSAGE), true);
});

test("real SDK append failure leaves no false durable fact and a later retry can commit", async (t) => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const failed = createNativeSessionManager(fixture.cwd, fixture.sessionDirA);
  const originalAppend = failed.appendCustomMessageEntry;
  failed.appendCustomMessageEntry = () => { throw new Error("fixture append failure"); };
  assert.throws(() => durable.appendDurableSessionCreate(failed, request(fixture.cwd, { idempotencyKey: "retry" })), /fixture append failure/);
  const failedFile = failed.getSessionFile();
  assert.ok(failedFile, "failed manager should expose its candidate session file");
  assert.equal(existsSync(failedFile), true, "the SDK header is durable before the second append");
  const partial = durable.findDurableSessionCreateRecord(failed.getEntries(), request(fixture.cwd, { idempotencyKey: "retry" }).scope, "retry");
  assert.ok(partial, "the first native marker is durable");
  assert.equal(durable.validateDurableSessionRecord(failed.getEntries(), partial), false, "the missing custom message is not a durable success");
  failed.appendCustomMessageEntry = originalAppend;
  const retried = durable.appendDurableSessionCreate(failed, request(fixture.cwd, { idempotencyKey: "retry" }));
  assert.equal(retried.record.sessionId, failed.getSessionId());
  assert.equal((await SessionManager.list(fixture.cwd, fixture.sessionDirA)).some((info) => info.id === failed.getSessionId()), true);
});

test("real SDK isolated list plus protocol lock coalesces concurrent retries", async (t) => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  let creates = 0;
  const candidate = request(fixture.cwd, { idempotencyKey: "concurrent" });
  const host = {
    withAdmissionLock: (input, operation) => withSessionAdmissionLock(fixture.sessionDirA, input, operation),
    findExisting: async (input) => {
      const listed = await SessionManager.list(fixture.cwd, fixture.sessionDirA);
      for (const info of listed) {
        const manager = SessionManager.open(info.path, undefined);
        const record = durable.findDurableSessionCreateRecord(manager.getEntries(), input.scope, input.idempotencyKey);
        if (!record) continue;
        return {
          ...observation(manager, input, false, true),
          source: record.source,
          messageKind: record.messageKind,
          messageDigest: record.messageDigest,
          initialMessageDigest: record.initialMessageDigest,
          nativeRecordValid: durable.validateDurableSessionRecord(manager.getEntries(), record),
        };
      }
      return undefined;
    },
    create: async (input) => {
      creates += 1;
      const manager = createNativeSessionManager(fixture.cwd, fixture.sessionDirA);
      durable.appendDurableSessionCreate(manager, input);
      const facts = observation(manager, input, false, true);
      return durable.createDurableSessionResult(input, facts, "created", false);
    },
    recover: async (facts, input) => durable.createDurableSessionResult(input, facts, "reused", true),
  };
  const [first, second] = await Promise.all([
    durable.createOrReuseDurableSession(candidate, host),
    durable.createOrReuseDurableSession(candidate, host),
  ]);
  assert.equal(creates, 1);
  assert.deepEqual([first.status, second.status].sort(), ["created", "reused"]);
  assert.equal(first.durability, "durable");
  assert.equal(second.durability, "durable");
  assert.equal((await SessionManager.list(fixture.cwd, fixture.sessionDirA)).filter((info) => info.cwd === fixture.cwd).length, 1);
});

test("real SDK cross-process admission lock coalesces the same scoped key", async (t) => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const workerPath = fileURLToPath(new URL("./session-control-durable-sdk-worker.mjs", import.meta.url));
  const goPath = join(fixture.root, "go");
  const owners = ["A", "B"];
  const children = owners.map((owner) => {
    const readyPath = join(fixture.root, `ready-${owner}`);
    return {
      owner,
      readyPath,
      promise: runWorker(workerPath, [fixture.sessionDirA, fixture.cwd, owner, readyPath, goPath]),
    };
  });
  try {
    await Promise.all(children.map((child) => waitForFile(child.readyPath)));
    writeFileSync(goPath, "go\n");
    const completed = await Promise.all(children.map((child) => child.promise));
    for (const child of completed) {
      assert.equal(child.code, 0, `${child.owner} failed: ${child.stderr}`);
      assert.equal(child.signal, null);
    }
    const results = completed.map((child) => JSON.parse(child.stdout.trim().split("\n").at(-1)));
    assert.deepEqual(results.map((entry) => entry.result.status).sort(), ["created", "reused"]);
    assert.deepEqual(results.map((entry) => entry.result.durability).sort(), ["durable", "durable"]);
    assert.equal(new Set(results.flatMap((entry) => entry.listIds)).size, 1);
    assert.equal(results[0].listCount, 1);
    assert.equal(results[1].listCount, 1);
    assert.equal((await SessionManager.list(fixture.cwd, fixture.sessionDirA)).length, 1);
  } finally {
    if (!existsSync(goPath)) writeFileSync(goPath, "go\n");
    await Promise.all(children.map((child) => child.promise.catch(() => undefined)));
  }
});


for (const mode of ["marker-only-v4", "legacy-v3"]) {
  test(`fresh SDK process recovers ${mode} under the original admission lock without creating another session`, async t => {
    const fixture = createFixture();
    t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
    const manager = createNativeSessionManager(fixture.cwd, fixture.sessionDirA);
    const candidate = request(fixture.cwd, { idempotencyKey: "sdk-cross-process" });
    if (mode === "marker-only-v4") {
      const append = manager.appendCustomMessageEntry;
      manager.appendCustomMessageEntry = () => { throw new Error("crash after durable marker"); };
      assert.throws(() => durable.appendDurableSessionCreate(manager, candidate), /crash after durable marker/);
      manager.appendCustomMessageEntry = append;
    } else {
      manager.appendCustomEntry(durable.SESSION_CONTROL_CREATE_CUSTOM_TYPE, {
        version: 3, idempotencyKey: candidate.idempotencyKey, scope: candidate.scope,
        source: "user-message", messageKind: "user-initial-message", sessionId: manager.getSessionId(),
        messageDigest: durable.initialMessageDigest(candidate.initialMessage),
        initialMessageDigest: durable.initialMessageDigest(candidate.initialMessage),
      });
      manager.appendMessage({ role: "user", content: candidate.initialMessage, timestamp: Date.now() });
    }
    const originalId = manager.getSessionId();
    const beforeEntries = manager.getEntries().length;
    const readyPath = join(fixture.root, "recovery-ready");
    const goPath = join(fixture.root, "recovery-go");
    writeFileSync(goPath, "go");
    const worker = fileURLToPath(new URL("./session-control-durable-sdk-worker.mjs", import.meta.url));
    const execution = await runWorker(worker, [fixture.sessionDirA, fixture.cwd, "recovery", readyPath, goPath]);
    assert.equal(execution.code, 0, execution.stderr);
    const result = JSON.parse(execution.stdout.trim());
    assert.equal(result.result.success, true);
    assert.equal(result.result.sessionId, originalId);
    assert.equal(result.result.reused, true);
    assert.equal(result.listCount, 1);
    const reopened = SessionManager.open(manager.getSessionFile(), fixture.sessionDirA);
    assert.ok(durable.validateDurableSessionCreateRecord(reopened.getEntries(), candidate));
    assert.equal(reopened.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user").length, mode === "legacy-v3" ? 1 : 0);
    assert.equal(reopened.getEntries().length, beforeEntries + (mode === "marker-only-v4" ? 1 : 0));
  });
}
