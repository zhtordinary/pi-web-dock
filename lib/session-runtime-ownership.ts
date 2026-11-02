import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { acquireStateWriteLock, resolveStateWriteLockIdentity } from "../bin/state-write-lock.cjs";
import { startIdentity } from "../bin/session-wait-lock.cjs";
import { writePrivateFileAtomicSync } from "./atomic-file";

export interface SessionRuntimeOwner {
  entry: "reader";
  pid: number;
  bootId: string;
  port?: number;
}
export interface SessionRuntimeOwnership {
  release(): void;
}

function readOwner(file: string): SessionRuntimeOwner | undefined {
  try {
    const record = JSON.parse(readFileSync(file, "utf8"));
    if (record.entry !== "reader" || !Number.isSafeInteger(record.pid) || record.pid <= 0
      || typeof record.bootId !== "string" || !record.startToken || startIdentity(record.pid) !== record.startToken) return;
    return { entry: "reader", pid: record.pid, bootId: record.bootId,
      ...(Number.isInteger(record.port) && record.port > 0 && record.port <= 65535 ? { port: record.port } : {}) };
  } catch { return undefined; }
}

/** Cooperative Reader writers hold the existing kernel mutex until SDK teardown, never a TTL lease. */
export function acquireSessionRuntimeOwnership(sessionFile: string): SessionRuntimeOwnership {
  if (!sessionFile) throw new Error("A session file identity is required for runtime ownership");
  const identity = resolveStateWriteLockIdentity(sessionFile);
  const ownerFile = `${identity}.runtime-owner.json`;
  let unlock: () => void;
  try { unlock = acquireStateWriteLock(identity); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
    const owner = readOwner(ownerFile);
    throw Object.assign(new Error(owner?.port
      ? `Session is owned by Reader on port ${owner.port}`
      : "Session is owned by another Reader runtime"), {
      code: "session_runtime_owned", ...(owner ? { owner } : {}),
    });
  }
  const port = Number(process.env.PI_WEB_BOUND_PORT);
  try {
    writePrivateFileAtomicSync(ownerFile, JSON.stringify({
      entry: "reader", pid: process.pid, bootId: randomUUID(), startToken: startIdentity(process.pid),
      // The launcher passes the actual Next listen port; PORT/default/channel guesses are not evidence.
      ...(Number.isInteger(port) && port > 0 && port <= 65535 ? { port } : {}),
    }));
  } catch (error) { unlock(); throw error; }
  let released = false;
  return { release() {
    if (released) return;
    released = true;
    try { unlinkSync(ownerFile); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    finally { unlock(); }
  } };
}
