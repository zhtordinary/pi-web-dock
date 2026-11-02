import { configuredPeerList, localDeviceIdentity, readActivityConfig } from "./activity-peers";
import { getSessionWaitChannel, readPersistentWaitStatus } from "./session-waits";
import { listSessionSummaries } from "./session-reader";
import { getRpcSessionInfos } from "./rpc-manager";

export type SessionWaitSource = {
  deviceId: string;
  deviceName: string;
  url?: string;
  local: boolean;
  online: boolean;
  error?: string;
};

type WaitSnapshot = Record<string, unknown>;
export type SessionWaitAggregateFetch = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Attach the state owner to each item so controls can return to that peer. */
export function decorateSessionWaitSnapshot(snapshot: WaitSnapshot, source: SessionWaitSource): WaitSnapshot {
  return {
    waits: records(snapshot.waits).map((wait) => ({ ...wait, source })),
    plans: records(snapshot.plans).map((plan) => ({ ...plan, source })),
    notifications: records(snapshot.notifications).map((notification) => ({ ...notification, source })),
    worker: snapshot.worker,
    sessionTitles: snapshot.sessionTitles,
  };
}

function peerError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readPeerSnapshot(
  peer: { id: string; name: string; url: string },
  fetcher: SessionWaitAggregateFetch,
): Promise<{ source: SessionWaitSource; snapshot?: WaitSnapshot }> {
  const source: SessionWaitSource = {
    deviceId: peer.id,
    deviceName: peer.name,
    url: peer.url,
    local: false,
    online: false,
  };
  try {
    const response = await fetcher(`${peer.url.replace(/\/$/, "")}/api/session-control`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as unknown;
    if (!isRecord(payload) || !Array.isArray(payload.waits) || !Array.isArray(payload.plans)) {
      throw new Error("invalid session wait response");
    }
    return {
      source: { ...source, online: true },
      snapshot: decorateSessionWaitSnapshot(payload, { ...source, online: true }),
    };
  } catch (error) {
    return { source: { ...source, error: peerError(error) } };
  }
}

export async function readSessionWaitSnapshot(filter: Record<string, unknown> = {}): Promise<WaitSnapshot> {
  const sessions = await listSessionSummaries();
  const titles = new Map(sessions.map(session => [session.id, session.name || session.firstMessage || ""]));
  for (const session of getRpcSessionInfos()) if (session.name) titles.set(session.id, session.name);
  return { ...readPersistentWaitStatus(filter), sessionTitles: Object.fromEntries(titles) };
}

/** Read the local wait ledger and every configured peer without changing ownership. */
export async function readAggregatedSessionWaitStatus(fetcher: SessionWaitAggregateFetch = fetch): Promise<WaitSnapshot> {
  const config = readActivityConfig();
  const local = localDeviceIdentity(config, new Date().toISOString());
  const localSource: SessionWaitSource = {
    deviceId: local.id,
    deviceName: local.name,
    url: local.url,
    local: true,
    online: true,
  };
  const localSnapshot = decorateSessionWaitSnapshot(await readSessionWaitSnapshot(), localSource);
  const peers = configuredPeerList(config, local);
  const peerResults = await Promise.all(peers.map((peer) => readPeerSnapshot(peer, fetcher)));

  const allSources = [localSource, ...peerResults.map(result => result.source)];
  const titleMaps = new Map([[local.id, localSnapshot.sessionTitles], ...peerResults.map(result => [result.source.deviceId, result.snapshot?.sessionTitles] as const)]);
  const identity = (value: unknown) => {
    if (!isRecord(value)) return value;
    const titles = titleMaps.get(String(value.deviceId));
    return { ...value, ...(isRecord(titles) && typeof titles[String(value.sessionId)] === "string" && titles[String(value.sessionId)] ? { title: titles[String(value.sessionId)] } : {}), deviceName: allSources.find(source => source.deviceId === value.deviceId)?.deviceName ?? value.deviceId };
  };
  return {
    aggregate: true,
    channel: getSessionWaitChannel(),
    updatedAt: new Date().toISOString(),
    waits: [
      ...records(localSnapshot.waits),
      ...peerResults.flatMap((result) => records(result.snapshot?.waits)),
    ].map(wait => ({ ...wait, owner: identity(wait.owner), target: identity(wait.target) })),
    plans: [
      ...records(localSnapshot.plans),
      ...peerResults.flatMap((result) => records(result.snapshot?.plans)),
    ],
    notifications: [
      ...records(localSnapshot.notifications),
      ...peerResults.flatMap((result) => records(result.snapshot?.notifications)),
    ],
    sources: allSources,
  };
}
