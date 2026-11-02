export type RelationIdentity = { deviceId: string; sessionId: string; title?: string; deviceName?: string };
export type WaitSource = { deviceId: string; deviceName: string; url?: string; local: boolean; online: boolean; error?: string };
export type SessionRelationWait = {
  id: string; status: string; condition: string; createdAt?: string; owner?: RelationIdentity; target?: RelationIdentity;
  readiness?: { status: string; reason: string }; continuationStatus?: string | null; reason?: string | null; source?: WaitSource; stale?: boolean;
};
export type SessionRelationSnapshot = { waits: SessionRelationWait[]; sources?: WaitSource[] };
export type SessionRelationGroup = { direction: "outgoing" | "incoming"; peer: RelationIdentity; waits: SessionRelationWait[] };

export function isActiveRelation(wait: SessionRelationWait): boolean {
  return wait.status !== "cancelled" && (wait.status !== "completed" || Boolean(wait.continuationStatus));
}

export function sessionRelationGroups(waits: SessionRelationWait[], focus: RelationIdentity): SessionRelationGroup[] {
  const groups = new Map<string, SessionRelationGroup>();
  const seen = new Set<string>();
  for (const wait of waits) {
    const waitKey = JSON.stringify([wait.source?.deviceId, wait.id]);
    if (!isActiveRelation(wait) || seen.has(waitKey)) continue;
    seen.add(waitKey);
    const ownerMatches = wait.owner?.deviceId === focus.deviceId && wait.owner.sessionId === focus.sessionId;
    const targetMatches = wait.target?.deviceId === focus.deviceId && wait.target.sessionId === focus.sessionId;
    if (!ownerMatches && !targetMatches) continue;
    const direction = ownerMatches ? "outgoing" : "incoming";
    const peer = ownerMatches ? wait.target : wait.owner;
    if (!peer) continue;
    const key = JSON.stringify([direction, peer.deviceId, peer.sessionId]);
    const group = groups.get(key) ?? { direction, peer, waits: [] };
    group.waits.push(wait); groups.set(key, group);
  }
  return [...groups.values()];
}

/** Keep only last-known records from sources explicitly reported unavailable. */
export function mergeSessionRelationSnapshots(previous: SessionRelationSnapshot | null, next: SessionRelationSnapshot): SessionRelationSnapshot {
  const offline = new Map((next.sources ?? []).filter(source => !source.online).map(source => [source.deviceId, source]));
  const keys = new Set(next.waits.map(wait => JSON.stringify([wait.source?.deviceId, wait.id])));
  return { ...next, waits: [...next.waits, ...(previous?.waits ?? []).filter(wait => wait.source && offline.has(wait.source.deviceId) && !keys.has(JSON.stringify([wait.source.deviceId, wait.id]))).map(wait => ({ ...wait, stale: true, source: offline.get(wait.source!.deviceId) }))] };
}
