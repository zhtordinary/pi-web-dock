import { resolveSessionPathReadOnly } from "./session-reader";
import { getSessionReadSnapshot, type SessionReadSnapshot } from "./session-read-cache";
import { createHistoryProjection, HistoryReadError, type HistoryProjection } from "./session-history";

// Only immutable disk snapshots are memoized. Weak keys follow the existing
// read-cache eviction; each snapshot keeps at most two branch projections.
const diskProjections = new WeakMap<SessionReadSnapshot, Map<string, HistoryProjection>>();
const MAX_BRANCH_PROJECTIONS = 2;

function diskProjection(snapshot: SessionReadSnapshot, sessionId: string, leafId?: string | null): HistoryProjection {
  const branchKey = JSON.stringify({ leafId });
  let branches = diskProjections.get(snapshot);
  const cached = branches?.get(branchKey);
  if (cached && cached.sessionId === sessionId) return cached;
  const projection = createHistoryProjection(snapshot.entries, {
    sessionId, leafId, currentLeafId: snapshot.leafId,
    sourceRevision: JSON.stringify([
      snapshot.path, snapshot.fileDev, snapshot.fileIno, snapshot.fileSize,
      snapshot.fileMtimeMs, snapshot.fileCtimeMs, snapshot.entries.length, snapshot.entries.at(-1)?.id ?? null,
    ]),
  });
  if (!branches) {
    branches = new Map();
    diskProjections.set(snapshot, branches);
  }
  branches.delete(branchKey);
  branches.set(branchKey, projection);
  while (branches.size > MAX_BRANCH_PROJECTIONS) branches.delete(branches.keys().next().value!);
  return projection;
}

/** Capture entries and leaf from one source without starting/navigating a runtime. */
export async function loadSessionHistoryProjection(sessionId: string, leafId?: string | null): Promise<HistoryProjection> {
  const path = await resolveSessionPathReadOnly(sessionId);
  if (!path) throw new HistoryReadError(404, "history_session_not_found", "Session not found");
  return diskProjection(getSessionReadSnapshot(path), sessionId, leafId);
}
