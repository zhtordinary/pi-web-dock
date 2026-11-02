import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createDurableSessionResult,
  DurableSessionAdmissionError,
  durableAdmissionLockKey,
  findDurableSessionCreateRecord,
  appendDurableSessionCreate,
  initialMessageDigest,
  SESSION_CONTROL_INITIALIZATION_MESSAGE,
  validateDurableSessionRecord,
  createOrReuseDurableSession,
} from "../packages/pi-web-session-control/index.ts";

const [sessionDir, cwd, owner, readyPath, goPath] = process.argv.slice(2);
if (!sessionDir || !cwd || !owner || !readyPath || !goPath) throw new Error("worker requires sessionDir, cwd, owner, readyPath and goPath");
const request = {
  idempotencyKey: "sdk-cross-process",
  scope: { callerSessionId: "caller-sdk", cwd },
  initialMessage: "persist this first user question",
};
const lockOptions = {
  realpath: false,
  stale: 30_000,
  update: 10_000,
  retries: { retries: 20, factor: 1, minTimeout: 25, maxTimeout: 500 },
};

function observation(manager, candidate, nativeListVisible = true) {
  const source = candidate.initialMessage === undefined ? "initialization" : "agent-message";
  const messageKind = source === "initialization" ? "generated-initialization" : "agent-initial-message";
  const messageDigest = initialMessageDigest(candidate.initialMessage ?? SESSION_CONTROL_INITIALIZATION_MESSAGE);
  const sessionFile = manager.getSessionFile();
  return {
    sessionId: manager.getSessionId(),
    sessionFile,
    persisted: Boolean(sessionFile && existsSync(sessionFile)),
    visibleInSessionList: nativeListVisible,
    nativeListVisible,
    runtimeVisibleInReader: true,
    runtimeCreated: true,
    source,
    messageKind,
    messageDigest,
    ...(source === "agent-message" ? { initialMessageDigest: messageDigest } : {}),
    nativeRecordValid: true,
  };
}

function createNativeSessionManager() {
  const allocation = SessionManager.create(cwd, sessionDir);
  const sessionFile = allocation.getSessionFile();
  if (!sessionFile) throw new Error("worker SessionManager did not allocate a session file path");
  const fd = openSync(sessionFile, "wx");
  closeSync(fd);
  return SessionManager.open(sessionFile, allocation.getSessionDir(), cwd);
}

async function withAdmissionLock(candidate, operation) {
  mkdirSync(sessionDir, { recursive: true });
  const lockDir = join(sessionDir, ".pi-web-session-control-admission");
  mkdirSync(lockDir, { recursive: true });
  const lockPath = join(lockDir, durableAdmissionLockKey(candidate));
  let compromisedError;
  const lease = {
    assert() {
      if (compromisedError) {
        throw new DurableSessionAdmissionError(`durable session admission lease was compromised: ${compromisedError.message}`);
      }
    },
  };
  const release = await lockfile.lock(lockPath, {
    ...lockOptions,
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
    throw new DurableSessionAdmissionError([prior, ...leaseErrors].filter(Boolean).join("; "), operationError?.result ?? result);
  }
  if (operationError) throw operationError;
  if (!result) throw new Error("admission operation returned no result");
  return result;
}

const initialList = await SessionManager.list(cwd, sessionDir);
writeFileSync(readyPath, JSON.stringify({ owner, initialCount: initialList.length }));
while (!existsSync(goPath)) await new Promise((resolve) => setTimeout(resolve, 10));

const host = {
  withAdmissionLock,
  findExisting: async (candidate) => {
    const listed = await SessionManager.list(cwd, sessionDir);
    for (const info of listed) {
      const manager = SessionManager.open(info.path, undefined);
      const record = findDurableSessionCreateRecord(manager.getEntries(), candidate.scope, candidate.idempotencyKey);
      if (!record) continue;
      return {
        ...observation(manager, candidate),
        source: record.source,
        messageKind: record.messageKind,
        messageDigest: record.messageDigest,
        initialMessageDigest: record.initialMessageDigest,
        nativeRecordValid: validateDurableSessionRecord(manager.getEntries(), record),
      };
    }
    return undefined;
  },
  create: async (candidate) => {
    // Keep the first owner inside the admission interval long enough that a
    // missing cross-process lock deterministically exposes the old race.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const manager = createNativeSessionManager();
    appendDurableSessionCreate(manager, candidate);
    return createDurableSessionResult(candidate, observation(manager, candidate), "created", false);
  },
  recover: async (facts, candidate, lease) => {
    lease?.assert();
    const manager = SessionManager.open(facts.sessionFile, sessionDir, cwd);
    appendDurableSessionCreate(manager, candidate);
    lease?.assert();
    const record = findDurableSessionCreateRecord(manager.getEntries(), candidate.scope, candidate.idempotencyKey);
    const recovered = { ...observation(manager, candidate), nativeRecordValid: Boolean(record && validateDurableSessionRecord(manager.getEntries(), record)) };
    if (!recovered.nativeRecordValid) throw new Error("native recovery readback failed");
    return createDurableSessionResult(candidate, recovered, "reused", true);
  },
};
const result = await createOrReuseDurableSession(request, host);
const listed = await SessionManager.list(cwd, sessionDir);
process.stdout.write(`${JSON.stringify({ owner, result, listCount: listed.length, listIds: listed.map((info) => info.id) })}\n`);
