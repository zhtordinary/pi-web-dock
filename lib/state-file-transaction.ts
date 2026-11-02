// The CJS primitive is also used by the durable worker process.
import { acquireStateWriteLock, assertNoLegacyStateWriterLock } from "../bin/state-write-lock.cjs";

export { acquireStateWriteLock };

// A domain transaction is one synchronous reread and atomic replace. Reader
// processes sharing a state file (30141 and 30142) contend by design, so a
// writer waits for the holder's section; the bound only surfaces a stopped holder.
const STATE_FILE_TRANSACTION_WAIT_MS = 5_000;

/** Read the latest domain file inside the crash-released writer transaction. */
export function withStateFileTransaction<T>(file: string, mutate: () => T): T {
  const release = acquireStateWriteLock(file, STATE_FILE_TRANSACTION_WAIT_MS);
  try {
    // A pre-upgrade proper-lockfile writer has no kernel-lock participation.
    // Fail closed rather than stealing its lock during a mixed-version rollout.
    assertNoLegacyStateWriterLock(file);
    return mutate();
  } finally { release(); }
}
