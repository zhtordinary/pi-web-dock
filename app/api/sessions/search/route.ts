import { NextResponse } from "next/server";
import { listAllSessions, listArchivedSessions } from "@/lib/session-reader";
import { selectHiddenSessions } from "@/lib/hidden-filter";
import { readFavoriteState } from "@/lib/favorite-state";
import { readSessionCategoryState, sessionCategoryFromState } from "@/lib/session-category-state";
import { matchesSessionStorageScope, type SessionStorageScope } from "@/lib/session-storage-scope";
import { countQueryInSessionFile, sessionIdMatchesQuery } from "@/lib/session-search";
import { configuredPeerList, localDeviceIdentity, readActivityConfig } from "@/lib/activity-peers";
import type { SessionInfo, SessionSearchResult } from "@/lib/types";
import { applySubprojectAssignments } from "@/lib/subproject-state";

const MAX_RESULTS = 50;
const MAX_PARALLEL = 8;
const PEER_TIMEOUT_MS = 3_000;
type CollectionScope = "local" | "hidden" | "favorites" | "to_discuss" | "to_revise" | "completed";
const TIME_RANGE_VALUES = new Set(["1", "3", "7", "14", "30", "90"]);
const DAY_MS = 24 * 60 * 60 * 1000;

function parseTimeRangeDays(value: string | null): number | null {
  if (!value || value === "all") return null;
  return TIME_RANGE_VALUES.has(value) ? Number(value) : null;
}

function isWithinTimeRange(modified: string, days: number | null, nowMs: number): boolean {
  if (days === null) return true;
  const timestamp = Date.parse(modified);
  return Number.isFinite(timestamp) && timestamp >= nowMs - days * DAY_MS;
}

interface FileMatch {
  snippets: string[];
  matchCount: number;
  contentMatchCount: number;
  titleMatchCount: number;
  idMatch: boolean;
}

/** Scan one session file for visible content/titles. */
async function searchSessionFile(path: string, q: string): Promise<FileMatch | null> {
  let result;
  try {
    result = await countQueryInSessionFile(path, q);
  } catch {
    return null;
  }
  if (result.matchCount === 0) return null;
  return { ...result, idMatch: false };
}

function sortSearchResults(hits: SessionSearchResult[]): SessionSearchResult[] {
  return hits.sort((a, b) => {
    if (Boolean(a.idMatch) !== Boolean(b.idMatch)) return a.idMatch ? -1 : 1;
    return (a.activityAt ?? a.modified) === (b.activityAt ?? b.modified)
      ? (a.device?.id ?? "").localeCompare(b.device?.id ?? "")
      : (a.activityAt ?? a.modified) < (b.activityAt ?? b.modified) ? 1 : -1;
  });
}

function searchActivityTime(session: SessionInfo): string {
  return session.modified;
}

async function searchLocalSessions(q: string, archived: boolean, scope: CollectionScope, days: number | null): Promise<SessionSearchResult[]> {
  const listed = applySubprojectAssignments(archived ? await listArchivedSessions() : await listAllSessions());
  const categoryState = readSessionCategoryState();
  const favoriteIds = new Set(readFavoriteState().sessions);
  const hiddenIds = new Set(selectHiddenSessions(listed).map((session) => session.id));
  const storageScope: SessionStorageScope = scope === "local" ? "normal" : scope;
  const sessions: SessionInfo[] = listed.filter((session) => matchesSessionStorageScope(storageScope, {
    category: sessionCategoryFromState(categoryState, session.id),
    favorite: favoriteIds.has(session.id),
    hidden: hiddenIds.has(session.id),
  }));

  // Newest first; stop scanning once the result cap is reached.
  const nowMs = Date.now();
  const ordered = [...sessions].sort((a, b) =>
    a.modified < b.modified ? 1 : -1
  ).map((session) => ({
    session,
    activityAt: searchActivityTime(session),
  })).sort((a, b) => a.activityAt < b.activityAt ? 1 : -1)
    .filter(({ activityAt }) => isWithinTimeRange(activityAt, days, nowMs));
  // Resolve ID matches from the session catalog first. A UUID fragment may also
  // appear in collaboration messages, so content hits must never crowd the
  // session whose own ID matches the query out of the result cap.
  const idMatches = ordered.filter(({ session }) => sessionIdMatchesQuery(session.id, q));
  const idMatchIds = new Set(idMatches.map(({ session }) => session.id));
  const surfacedIdMatches = idMatches.slice(0, MAX_RESULTS);
  // ID priority decides admission/ranking, but it must not erase other source
  // classifications. The same bounded pool scans surfaced ID and content
  // candidates; an unreadable ID file still remains a valid ID-only hit.
  const contentCandidates = ordered.filter(({ session }) => !idMatchIds.has(session.id));
  const scanCandidates = [...surfacedIdMatches, ...contentCandidates];
  const idCandidateIds = new Set(surfacedIdMatches.map(({ session }) => session.id));
  const scanResults = new Map<string, FileMatch | null>();
  const maxContentMatches = Math.max(0, MAX_RESULTS - surfacedIdMatches.length);
  let contentMatches = 0;
  let next = 0;
  const flightHook = (globalThis as { __piSearchScanFlight?: (delta: number) => void }).__piSearchScanFlight;
  const workerCount = Math.min(MAX_PARALLEL, scanCandidates.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push((async () => {
      while (next < scanCandidates.length) {
        const candidate = scanCandidates[next++];
        const isIdCandidate = idCandidateIds.has(candidate.session.id);
        if (!isIdCandidate && contentMatches >= maxContentMatches) return;
        flightHook?.(1);
        let found: FileMatch | null;
        try {
          found = await searchSessionFile(candidate.session.path, q);
        } finally {
          flightHook?.(-1);
        }
        scanResults.set(candidate.session.id, found);
        if (!isIdCandidate && found) contentMatches += 1;
      }
    })());
  }
  await Promise.all(workers);

  const idHits: SessionSearchResult[] = surfacedIdMatches.map(({ session, activityAt }) => ({
    ...session,
    ...(scanResults.get(session.id) ?? { snippets: [], matchCount: 0, contentMatchCount: 0, titleMatchCount: 0 }),
    idMatch: true,
    activityAt,
  } as SessionSearchResult));
  const hits: SessionSearchResult[] = [...idHits];
  for (const candidate of contentCandidates) {
    if (hits.length >= MAX_RESULTS) break;
    const found = scanResults.get(candidate.session.id);
    if (found) hits.push({ ...candidate.session, ...found, activityAt: candidate.activityAt } as SessionSearchResult);
  }

  const device = localDeviceIdentity(readActivityConfig(), new Date().toISOString());
  return sortSearchResults(hits.map((hit) => ({ ...hit, device, favorite: storageScope === "favorites" }))).slice(0, MAX_RESULTS);
}

async function searchPeerSessions(
  peer: { id: string; name: string; url: string },
  q: string,
  archived: boolean,
  scope: CollectionScope,
  days: number | null,
): Promise<SessionSearchResult[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PEER_TIMEOUT_MS);
  try {
    const target = new URL("/api/sessions/search", peer.url);
    if (target.protocol !== "http:" && target.protocol !== "https:") return [];
    target.searchParams.set("q", q);
    target.searchParams.set("archived", archived ? "1" : "0");
    target.searchParams.set("scope", scope);
    if (days !== null) target.searchParams.set("days", String(days));
    // Peer must scan only its own files; otherwise an all-device request fans
    // out recursively through every device.
    target.searchParams.set("local", "1");
    const response = await fetch(target, {
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { sessions?: unknown };
    if (!Array.isArray(payload.sessions)) throw new Error("invalid response");
    const nowMs = Date.now();
    const device = {
      id: peer.id,
      name: peer.name,
      url: peer.url,
      online: true,
      lastSeenAt: new Date().toISOString(),
    };
    return payload.sessions.filter((hit): hit is SessionSearchResult => Boolean(hit && typeof hit === "object"))
      .filter((hit) => isWithinTimeRange(hit.activityAt ?? hit.modified, days, nowMs))
      .map((hit) => ({ ...hit, device }));
  } catch {
    // A single offline peer must not hide local or other peer results.
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function searchAllDevices(q: string, archived: boolean, scope: CollectionScope, days: number | null): Promise<SessionSearchResult[]> {
  const config = readActivityConfig();
  const local = localDeviceIdentity(config, new Date().toISOString());
  const peers = configuredPeerList(config, local);
  const [localHits, ...peerHits] = await Promise.all([
    searchLocalSessions(q, archived, scope, days),
    ...peers.map((peer) => searchPeerSessions(peer, q, archived, scope, days)),
  ]);
  return sortSearchResults([localHits, ...peerHits].flat()).slice(0, MAX_RESULTS);
}

async function searchOneDevice(deviceId: string, q: string, archived: boolean, scope: CollectionScope, days: number | null): Promise<SessionSearchResult[]> {
  const config = readActivityConfig();
  const local = localDeviceIdentity(config, new Date().toISOString());
  if (deviceId === local.id) return searchLocalSessions(q, archived, scope, days);
  const peer = configuredPeerList(config, local).find((candidate) => candidate.id === deviceId);
  return peer ? searchPeerSessions(peer, q, archived, scope, days) : [];
}

export async function GET(req: Request) {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  // Require at least 2 characters to avoid huge result sets from single chars.
  if (q.length < 2) return NextResponse.json({ sessions: [] });

  const archived = url.searchParams.get("archived") === "1";
  const scopeParam = url.searchParams.get("scope") ?? "local";
  const isCollection = scopeParam === "hidden" || scopeParam === "favorites" || scopeParam === "to_discuss" || scopeParam === "to_revise" || scopeParam === "completed";
  const scope: CollectionScope = isCollection ? (scopeParam as CollectionScope) : "local";
  const days = parseTimeRangeDays(url.searchParams.get("days"));
  const deviceId = url.searchParams.get("device");
  const localOnly = url.searchParams.get("local") === "1";
  try {
    const sessions = localOnly
      ? await searchLocalSessions(q, archived, scope, days)
      : deviceId && deviceId !== "all"
        ? await searchOneDevice(deviceId, q, archived, scope, days)
        : scopeParam === "all"
          ? await searchAllDevices(q, archived, "local", days)
          : isCollection
            ? await searchAllDevices(q, archived, scope, days)
            : await searchLocalSessions(q, archived, scope, days);
    return NextResponse.json({ sessions }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
