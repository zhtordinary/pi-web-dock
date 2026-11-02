/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

/** Kernel-held, crash-released writer mutex. JSON remains the domain data store.
 * Never unlink this database: its inode is the shared lock identity. No lease,
 * timer, or wall-clock expiry may evict a paused but still live writer.
 */
function resolveStateWriteLockIdentity(file) {
  let identity = path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  try {
    // Managed symlinks are preserved by atomic writers; lock their physical
    // target. Hard links cannot be preserved by replace and are unsupported.
    identity = fs.realpathSync(file);
    if (fs.statSync(identity).nlink > 1) {
      throw Object.assign(new Error("State files must not be hard-linked"), { code: "ESTATEALIAS" });
    }
  }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return identity;
}

function legacyStateWriterLockPaths(file) {
  const identity = resolveStateWriteLockIdentity(file);
  return [...new Set([`${file}.lock`, `${identity}.lock`])];
}

function statePathExists(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function legacyStateWriterLockEntries(file) {
  return legacyStateWriterLockPaths(file).filter(statePathExists);
}

function assertNoLegacyStateWriterLock(file) {
  if (legacyStateWriterLockEntries(file).length > 0) {
    throw Object.assign(new Error("Legacy state writer lock requires quiescent upgrade"), { code: "ELOCKED" });
  }
}

// Lock databases held by this thread. Bundlers may load this module more than
// once per process, so the set lives on the thread's global object.
const heldLockPaths = globalThis.__piStateWriteLockPaths ??= new Set();
const waitCell = new Int32Array(new SharedArrayBuffer(4));

/** waitMs bounds the wait for another thread or process's holder; 0 is try-lock.
 * A holder on this same thread can never release during a synchronous wait,
 * so re-entry is rejected at once instead of waiting.
 */
function acquireStateWriteLock(file, waitMs = 0) {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new TypeError("waitMs must be a non-negative integer");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const identity = resolveStateWriteLockIdentity(file);
  const lockPath = `${identity}.writer.sqlite`;
  if (heldLockPaths.has(lockPath)) throw Object.assign(new Error("state lock conflict"), { code: "ELOCKED" });
  let db;
  try {
    db = new DatabaseSync(lockPath);
    fs.chmodSync(lockPath, 0o600);
    db.exec("PRAGMA busy_timeout=0");
    // SQLite's busy handler backs off to 100 ms checks, so a long waiter keeps
    // losing a contended lock to newcomers. Checking every millisecond keeps all
    // waiters equal; the deadline then only expires behind a holder that is stuck.
    const deadline = performance.now() + waitMs;
    for (;;) {
      try { db.exec("BEGIN IMMEDIATE"); break; }
      catch (error) {
        if ((error.errcode !== 5 && error.errcode !== 6) || performance.now() >= deadline) throw error;
        Atomics.wait(waitCell, 0, 0, 1);
      }
    }
  } catch (error) {
    try { db?.close(); } catch { /* preserve acquisition failure */ }
    if (error.errcode === 5 || error.errcode === 6) {
      throw Object.assign(new Error("state lock conflict"), { code: "ELOCKED", cause: error });
    }
    throw error;
  }
  heldLockPaths.add(lockPath);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    heldLockPaths.delete(lockPath);
    try { db.exec("ROLLBACK"); } finally { db.close(); }
  };
}
module.exports = { acquireStateWriteLock, resolveStateWriteLockIdentity, legacyStateWriterLockPaths, legacyStateWriterLockEntries, assertNoLegacyStateWriterLock };
