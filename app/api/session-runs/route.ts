import { readCatalogMetadata } from "@/lib/catalog-metadata";
import { projectSessionRuns } from "@/lib/session-run-projection";
import { readActivityConfig, localDeviceIdentity, configuredPeerList } from "@/lib/activity-peers";
import { statSync } from "node:fs";
import { NextResponse } from "next/server";
import { attachSessionProjectInfo, listAllSessions, listArchivedSessions, getSessionEntries, getSessionListVersion, resolveSessionPath, readSessionHeader, resolveSessionIdByPath } from "@/lib/session-reader";
import { lineageParentId, resolveNearestLineageAncestorAsync } from "@/lib/session-lineage";
import { getRpcSession, getWaitingForUserRpcSessionIds, getWaitingForUserRequests, getRunningRpcSessionIds, restorePersistedQuestionAnalysisJobs } from "@/lib/rpc-manager";
import { getProjectIdentity, projectIdentityKey } from "@/lib/project-identity";
import { peekProject } from "@/lib/worktree";
import { listKnownProjects } from "@/lib/known-projects";
import { getSessionRunRecords, getPersistedUnattendedState } from "@/lib/session-activity";
import { shouldShowRetryingStatus } from "@/lib/session-activity-status";
import { readSiblingExecution } from "@/lib/session-channel-control";
import type { SessionExecutionState } from "@/lib/session-execution";
import { getSubagentActivityForSessions, type SubagentSessionActivity } from "@/lib/subagent-activity";
import { isHiddenInState, readHiddenState, type HiddenState } from "@/lib/hidden-state";
import { readFavoriteState } from "@/lib/favorite-state";
import { filterSessionsByCategory, readSessionCategoryState, sessionCategoryFromState, type SessionStorageCategory } from "@/lib/session-category-state";
import { isSessionStorageCategory, sessionStorageScopeFor, type SessionStorageScope } from "@/lib/session-storage-scope";
import { readViewedState } from "@/lib/viewed-state";
import { applySubprojectAssignments, listSubprojectSortSettings, listSubprojects } from "@/lib/subproject-state";
import { readSessionRecap } from "@/lib/session-recap";
import { isContinuationPrompt, textContent } from "@/lib/user-question";
import { startServerPerf } from "@/lib/perf";
import type {
  KnownProjectEntry,
  SessionActivityDevice,
  SessionActivityItem,
  SessionActivityResponse,
  SessionRecapSummary,
  SessionRunRecord,
  SessionActivitySubproject,
} from "@/lib/session-activity-types";
import type { SessionInfo } from "@/lib/types";

export const dynamic = "force-dynamic";

const JUST_COMPLETED_MS = 5 * 60 * 1000;
// Allow for transient peer delays; successful results are retained briefly between polls.
const PEER_TIMEOUT_MS = 3000;
interface PeerResult {
  metadataWarnings?: SessionActivityResponse["metadataWarnings"];
  device: SessionActivityDevice;
  sessions: SessionActivityItem[];
  knownProjects: KnownProjectEntry[];
  subprojects: SessionActivitySubproject[];
  subprojectSortSettings: NonNullable<SessionActivityResponse["subprojectSortSettings"]>;
  /** 该 peer 自述的隐藏清单（含设备自身是否被隐藏）。 */
  hidden?: HiddenState;
}

const readConfig = readActivityConfig;
const localDevice = localDeviceIdentity;
const configuredPeers = configuredPeerList;

// Cost is deliberately omitted here. Activity rows load it from the dedicated
// cost route only after entering the viewport, so the session list never prices
// every JSONL file during its initial refresh.
import {
  cacheSessionMetadata,
  readSessionMetadata,
} from "@/lib/session-caches";

// Bound repeated parsing of large session files while the mtime check detects changes.
// The cache is bounded so archived or deleted sessions cannot accumulate.
const SESSION_METADATA_CACHE_TTL_MS = 15_000;

type SessionEntryWithMetadata = {
  type?: string;
  customType?: unknown;
  data?: unknown;
  modelId?: unknown;
  provider?: unknown;
  timestamp?: unknown;
  message?: {
    role?: unknown;
    provider?: unknown;
    model?: unknown;
    stopReason?: unknown;
    content?: unknown;
  };
};


async function sessionMetadata(session: SessionInfo): Promise<{ modelName?: string; lastUserMessage?: string; lastAskedAt?: string; lastRecap?: SessionRecapSummary; hasErrorTail?: boolean }> {
  // The session list's `modified` only advances on user/assistant message
  // timestamps; recap entries and other custom entries never move it. Key the
  // cache on the file mtime too so a freshly generated recap is picked up.
  let fileMtimeMs = 0;
  try { fileMtimeMs = statSync(session.path).mtimeMs; } catch { /* session may vanish between list and read */ }
  const cached = readSessionMetadata(session.id);
  if (cached && (Date.now() - cached.fetchedAt < SESSION_METADATA_CACHE_TTL_MS || (cached.modified === session.modified && cached.fileMtimeMs === fileMtimeMs))) return cached;

  let modelName: string | undefined;
  let lastUserMessage: string | undefined;
  let lastAskedAt: string | undefined;
  let lastRecap: SessionRecapSummary | undefined;
  let newestMessageRole: string | undefined;
  let hasErrorTail = false;
  try {
    const entries = getSessionEntries(session.path);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index] as SessionEntryWithMetadata;
      if (!modelName && entry.type === "message" && entry.message?.role === "assistant") {
        const provider = typeof entry.message.provider === "string" ? entry.message.provider.trim() : "";
        const model = typeof entry.message.model === "string" ? entry.message.model.trim() : "";
        if (model) modelName = provider ? `${provider}/${model}` : model;
      }
      if (!modelName && entry.type === "model_change" && typeof entry.modelId === "string" && entry.modelId.trim()) {
        const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
        modelName = provider ? `${provider}/${entry.modelId.trim()}` : entry.modelId.trim();
      }
      if (!modelName && entry.type === "custom" && entry.customType === "pi-web:subagent" && entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)) {
        const model = (entry.data as { model?: unknown }).model;
        if (typeof model === "string" && model.trim()) modelName = model.trim();
      }
      if (!lastRecap) lastRecap = readSessionRecap(entry);
      if (entry.type !== "message" || !entry.message) continue;
      // The newest message decides whether the session is stuck behind a
      // failed assistant turn: an assistant error entry newer than the last
      // user message means the tail is a pending retry (auto or manual), not
      // a fresh turn already answered by a newer user message.
      if (newestMessageRole === undefined) {
        newestMessageRole = String(entry.message.role);
        hasErrorTail = entry.message.role === "assistant" && entry.message.stopReason === "error";
      }
      if (!lastUserMessage && entry.message.role === "user") {
        const message = textContent(entry.message.content);
        if (message && !isContinuationPrompt(message)) {
          lastUserMessage = message;
          if (typeof entry.timestamp === "string") lastAskedAt = entry.timestamp;
        }
      }
    }
  } catch {
    // A session can disappear between list and read; the row remains usable without metadata.
  }
  const metadata = { modified: session.modified, fileMtimeMs, modelName, lastUserMessage, lastAskedAt, lastRecap, hasErrorTail, fetchedAt: Date.now() };
  cacheSessionMetadata(session.id, metadata);
  return metadata;
}

function sessionActivity(
  session: SessionInfo,
  device: SessionActivityDevice,
  records: SessionRunRecord[],
  runningSessionIds: Set<string>,
  waitingForUserSessionIds: Set<string>,
  waitingRequestIdsBySession: ReadonlyMap<string, string[]>,
  subagentActivity: SubagentSessionActivity | undefined,
  nowMs: number,
  favoriteSessionIds: ReadonlySet<string>,
  categoryBySessionId: ReadonlyMap<string, SessionStorageCategory>,
  metadata: Awaited<ReturnType<typeof sessionMetadata>>,
  siblingExecution?: SessionExecutionState,
): SessionActivityItem {
  const projectRoot = session.projectRoot || session.cwd;
  const project = getProjectIdentity(projectRoot);
  const rpc = getRpcSession(session.id);
  const persistedUnattended = getPersistedUnattendedState(session.id);
  const execution = rpc?.getExecutionState() ?? siblingExecution;
  const persistedSubagentStatus = session.relation?.kind === "subagent" ? session.relation.status : undefined;
  // A terminal runtime observation is newer evidence than a stale relation status
  // inferred from a child transcript that may have been interrupted or oversized.
  const subagentTerminalObserved = subagentActivity?.active !== true && subagentActivity?.terminalState !== undefined;
  const persistedSubagentActive = !subagentTerminalObserved
    && (persistedSubagentStatus === "starting" || persistedSubagentStatus === "queued" || persistedSubagentStatus === "running");
  const subagentTerminalFailure = subagentActivity?.terminalState === "failed"
    || subagentActivity?.terminalState === "partial"
    || subagentActivity?.terminalState === "rejected"
    || persistedSubagentStatus === "failed";
  const subagentTerminalAbort = subagentActivity?.terminalState === "stopped"
    || persistedSubagentStatus === "aborted"
    || persistedSubagentStatus === "interrupted";
  const subagentJustCompleted = subagentActivity?.terminalState === "completed"
    && typeof subagentActivity.terminalAt === "number"
    && nowMs - subagentActivity.terminalAt >= 0
    && nowMs - subagentActivity.terminalAt <= JUST_COMPLETED_MS;
  const active = runningSessionIds.has(session.id) || subagentActivity?.active === true || persistedSubagentActive || execution?.active === true;
  // Only pending extension UI requests (ask_user/select/confirm/input/editor)
  // are user-facing waits. A child supervisor request is internal activity.
  const waitingForUser = waitingForUserSessionIds.has(session.id);
  // Current runtime activity must never rewrite a historical run or invent an ID.
  const liveExecuting = rpc?.isStreaming === true || rpc?.isPromptRunning === true || subagentActivity?.active === true || persistedSubagentActive
    || execution?.parentActive === true || Boolean(execution?.backgroundRunIds.length);
  const { runs: sessionRuns, currentActivity } = projectSessionRuns(records, session.id, liveExecuting);
  const latestRun = sessionRuns[0] ?? null;
  const completedAt = latestRun?.completedAt ? Date.parse(latestRun.completedAt) : NaN;
  // A retry label describes queued retry work. Once the provider has resumed
  // an actual stream, show the ordinary running state even for a retry attempt.
  const schedulerActive = Boolean(execution?.retrying ?? (rpc?.getSchedulerState()?.active === true));
  const retryInFlight = rpc?.isRetryInFlight() === true;
  const userPromptActive = rpc?.isUserPromptActive() === true;
  const retrying = shouldShowRetryingStatus({
    streaming: rpc?.isStreaming === true || Boolean(!rpc && execution?.parentActive && !execution.retrying),
    retryInFlight: retryInFlight || Boolean(!rpc && execution?.retrying),
    userPromptActive,
    schedulerActive,
    active,
    hasErrorTail: !execution && !subagentActivity?.active && metadata.hasErrorTail === true,
    latestRunStatus: latestRun?.status ?? null,
  });
  let status: SessionActivityItem["status"] = "idle";
  if (waitingForUser) status = "waiting_user";
  else if (retrying) status = "retrying";
  else if (liveExecuting || latestRun?.status === "running") status = "running";
  // A parent's persisted run is authoritative. Child terminal observations fill
  // a row with no parent run, but cannot rewrite the parent's own outcome.
  else if (latestRun?.status === "failed") status = "failed";
  else if (latestRun?.status === "aborted") status = "aborted";
  else if (latestRun?.status === "unknown" && metadata.hasErrorTail) status = "failed";
  else if (latestRun?.status === "unknown") status = "unknown";
  else if (Number.isFinite(completedAt) && nowMs - completedAt <= JUST_COMPLETED_MS) status = "just_completed";
  else if (!latestRun && subagentTerminalFailure) status = "failed";
  else if (!latestRun && subagentTerminalAbort) status = "aborted";
  else if (!latestRun && subagentJustCompleted) status = "just_completed";

  // SessionInfo.modified is the timestamp of the newest user or assistant message.
  const lastActivityAt = session.modified;

  const unattended = execution?.unattended ?? (rpc?.getUnattendedConfigured()
    ? rpc.getUnattendedEnabled()
    : Boolean(persistedUnattended?.enabled));
  return {
    device,
    session,
    favorite: favoriteSessionIds.has(session.id),
    category: categoryBySessionId.get(session.id),
    // Keep activity project identity aligned with SessionInfo and mutation routes.
    projectKey: session.projectKey ?? project.key,
    projectLabel: project.label,
    status,
    unattended,
    modelName: metadata.modelName,
    lastUserMessage: metadata.lastUserMessage,
    lastAskedAt: metadata.lastAskedAt,
    lastRecap: metadata.lastRecap,
    lastActivityAt,
    latestRun,
    currentActivity,
    execution,
    runs: sessionRuns,
    ...(subagentActivity?.terminalState ? {
      subagentTerminalState: subagentActivity.terminalState,
      ...(typeof subagentActivity.terminalAt === "number" ? { subagentTerminalAt: subagentActivity.terminalAt } : {}),
    } : {}),
    waitingRequestIds: waitingForUser ? waitingRequestIdsBySession.get(session.id) : undefined,
  };
}

const archivedAncestorParentCache = new Map<string, string | undefined>();

async function getStoredParentSessionId(id: string): Promise<string | undefined> {
  if (archivedAncestorParentCache.has(id)) return archivedAncestorParentCache.get(id);
  try {
    const filePath = await resolveSessionPath(id, { archived: true });
    if (!filePath) {
      archivedAncestorParentCache.set(id, undefined);
      return undefined;
    }
    const header = readSessionHeader(filePath);
    if (!header) {
      archivedAncestorParentCache.set(id, undefined);
      return undefined;
    }
    let parentId = header.contextSourceSessionId?.trim();
    if (!parentId && header.parentSession) {
      parentId = await resolveSessionIdByPath(header.parentSession);
    }
    const result = parentId?.trim() || undefined;
    archivedAncestorParentCache.set(id, result);
    return result;
  } catch {
    archivedAncestorParentCache.set(id, undefined);
    return undefined;
  }
}

type LocalActivityScope = "local" | "hidden" | "favorites" | "to_discuss" | "to_revise" | "completed";

async function buildLocalResponse(includeArchived: boolean, scope: LocalActivityScope, force = false, observeOnly = false, completionView = false, retries = 0): Promise<SessionActivityResponse> {
  const generatedAt = new Date().toISOString();
  const config = readConfig();
  const device = localDevice(config, generatedAt);
  let preliminaryFavorites: Set<string> | null = null;
  if (scope === "favorites" && !completionView) {
    preliminaryFavorites = new Set();
    try { preliminaryFavorites = new Set(readFavoriteState().sessions); } catch { /* catalog reports the final read failure */ }
  }
  const listOptions = { force, ...(observeOnly ? { readOnly: true } : {}), ...(preliminaryFavorites ? { projectSessionIds: preliminaryFavorites } : {}) };
  const listing = includeArchived ? listArchivedSessions(listOptions) : listAllSessions(listOptions);
  const listVersion = getSessionListVersion();
  const sessions = applySubprojectAssignments(await listing);

  // Reparent orphaned active sessions to their nearest active ancestor if the
  // direct parent was archived or removed, preserving session hierarchy.
  const activeIds = new Set(sessions.map((session) => session.id));
  const nearestAncestorByMissingId = new Map<string, string | undefined>();
  for (const session of sessions) {
    const directParentId = lineageParentId(session);
    if (!directParentId || activeIds.has(directParentId)) continue;
    if (!nearestAncestorByMissingId.has(directParentId)) {
      const nearest = await resolveNearestLineageAncestorAsync(
        directParentId,
        getStoredParentSessionId,
        (id) => activeIds.has(id),
      );
      nearestAncestorByMissingId.set(directParentId, nearest);
    }
    const nearest = nearestAncestorByMissingId.get(directParentId);
    if (nearest) {
      session.parentSessionId = nearest;
      if (session.relation?.kind === "fork") {
        session.relation.originSessionId = nearest;
      }
    }
  }
  // Favorites are the only sessions that can appear in this view.
  const metadataSessions = preliminaryFavorites ? sessions.filter((session) => preliminaryFavorites.has(session.id)) : sessions;
  const metadataById = new Map(await Promise.all(metadataSessions.map(async session => [session.id, await sessionMetadata(session)] as const)));
  let siblingObservation = await readSiblingExecution();
  const metadata = readCatalogMetadata(device.id, {hidden:readHiddenState, favorites:readFavoriteState, categories:readSessionCategoryState, viewed:readViewedState});
  const visibilityAvailable = metadata.hidden !== null;
  const hidden = metadata.hidden ?? {sessions:[],projects:[],devices:[device.id],visibleSessions:[]};
  const favoriteSessionIds = new Set(metadata.favorites.sessions);
  if (preliminaryFavorites) {
    const newlyFavorited = sessions.filter((session) => favoriteSessionIds.has(session.id) && !metadataById.has(session.id));
    if (newlyFavorited.length) {
      const enriched = applySubprojectAssignments(await attachSessionProjectInfo(newlyFavorited));
      const enrichedById = new Map(enriched.map((session) => [session.id, session]));
      for (let index = 0; index < sessions.length; index += 1) {
        sessions[index] = enrichedById.get(sessions[index].id) ?? sessions[index];
      }
      await Promise.all(enriched.map(async (session) => metadataById.set(session.id, await sessionMetadata(session))));
      siblingObservation = await readSiblingExecution();
    }
  }
  // A move during asynchronous enrichment must not return an obsolete session path.
  if (getSessionListVersion() !== listVersion) {
    if (retries >= 2) throw new Error("Session activity changed while loading; retry");
    return buildLocalResponse(includeArchived, scope, false, observeOnly, completionView, retries + 1);
  }
  // Complete asynchronous enrichment before taking the runtime/queue/run-history cut.
  const siblingExecution = siblingObservation.execution;
  const categoryState = metadata.categories;
  const categoryBySessionId = new Map<string, SessionStorageCategory>();
  const categorizedIds = new Set([...(categoryState?.to_discuss ?? []), ...(categoryState?.to_revise ?? []), ...(categoryState?.completed ?? [])]);
  for (const id of categorizedIds) {
    const category = sessionCategoryFromState(categoryState, id);
    if (category) categoryBySessionId.set(id, category);
  }
  const categoryScope: SessionStorageCategory | null | undefined = scope === "local"
    ? null : scope === "to_discuss" || scope === "to_revise" || scope === "completed" ? scope : undefined;
  const storageScope: SessionStorageScope = scope === "local" ? "normal" : scope;
  const scopedSessions = completionView || categoryScope === undefined ? sessions : filterSessionsByCategory(sessions, categoryState, categoryScope);
  const scopedIds = new Set(scopedSessions.map(session => session.id));
  const byId = new Map(sessions.map(session => [session.id, session]));
  for (const session of scopedSessions) {
    let parentId = lineageParentId(session);
    const seen = new Set<string>([session.id]);
    while (parentId && !scopedIds.has(parentId) && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      parentId = lineageParentId(parent);
    }
    if (parentId && scopedIds.has(parentId)) {
      session.parentSessionId = parentId;
      if (session.relation?.kind === "fork") session.relation.originSessionId = parentId;
    }
  }
  if (!observeOnly && !includeArchived) void restorePersistedQuestionAnalysisJobs(scopedSessions.map(session => ({ id: session.id, path: session.path })));
  const deviceHidden = hidden.devices.includes(device.id);
  const records = getSessionRunRecords();
  const runningSessionIds = new Set(getRunningRpcSessionIds());
  const waitingForUserSessionIds = new Set(getWaitingForUserRpcSessionIds());
  const waitingRequestIdsBySession = new Map(getWaitingForUserRequests().map((entry) => [entry.sessionId, entry.requestIds]));
  const subagentActivityBySession = getSubagentActivityForSessions(sessions);
  const nowMs = Date.now();
  // 隐藏语义（联动）：设备被隐藏 → 全部会话隐藏；项目 key 被隐藏 → 该项目全部会话隐藏。
  // scope=local 只返回未隐藏项；scope=hidden 只返回被隐藏项；scope=favorites 只返回收藏会话；
  // scope=to_discuss / to_revise / completed 返回对应收纳分类会话。
  const activitySessions = preliminaryFavorites ? scopedSessions.filter((session) => favoriteSessionIds.has(session.id)) : scopedSessions;
  const activities = activitySessions.map((session) => {
    const item = sessionActivity(session, device, records, runningSessionIds, waitingForUserSessionIds, waitingRequestIdsBySession, subagentActivityBySession.get(session.id), nowMs, favoriteSessionIds, categoryBySessionId, metadataById.get(session.id)!, siblingExecution[session.id]);
    const classification = sessionStorageScopeFor({
      category: item.category,
      favorite: item.favorite === true,
      hidden: isHiddenInState(hidden, device.id, item.session.id, item.projectKey),
    });
    return { item, classification };
  })
    .filter(({ classification }) => visibilityAvailable && (completionView || classification === storageScope))
    .map(({ item, classification }) => ({
      ...item,
      projectHidden: hidden.projects.includes(item.projectKey),
      favorite: classification === "favorites",
      category: isSessionStorageCategory(classification) ? classification : undefined,
    }))
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));

  const scopedProjectKeys = new Set(activities.map((item) => item.projectKey));
  const visibleKnownProjects = listKnownProjects().filter((project) => {
    if (!visibilityAvailable) return false;
    const key = projectIdentityKey(project.path);
    if (scope === "hidden") return deviceHidden || hidden.projects.includes(key);
    if (scope === "favorites" || scope === "to_discuss" || scope === "to_revise" || scope === "completed") {
      return scopedProjectKeys.has(key);
    }
    return !(deviceHidden || hidden.projects.includes(key));
  });
  // Git state is display-only; an unprobed project remains unknown until its background lookup completes.
  const knownProjects = visibleKnownProjects.map((project) => {
    const projectInfo = peekProject(project.path);
    return {
      deviceId: device.id,
      path: project.path,
      addedAt: project.addedAt,
      key: projectIdentityKey(project.path),
      hidden: hidden.projects.includes(projectIdentityKey(project.path)),
      label: getProjectIdentity(project.path).label,
      ...(projectInfo ? { isGit: projectInfo.isGit } : {}),
    };
  });

  return {
    metadataWarnings: [
      ...metadata.warnings,
      ...(siblingObservation.complete ? [] : [{ deviceId: device.id, domain: "execution" as const, code: "execution_observation_incomplete" as const }]),
    ],
    schemaVersion: 1,
    ...(completionView ? { view: "completion" as const } : {}),
    scope,
    generatedAt,
    device,
    devices: [device],
    sessions: activities,
    knownProjects,
    subprojects: (visibilityAvailable ? listSubprojects() : []).map((subproject) => ({ ...subproject, deviceId: device.id })),
    subprojectSortSettings: (visibilityAvailable ? listSubprojectSortSettings() : []).map((setting) => ({ ...setting, deviceId: device.id })),
    viewedAt: metadata.viewed,
    hidden,
  };
}

// Peers are fetched on demand by activity events and the visible-page snapshot
// fallback; each live fetch waits for the slowest peer. A short TTL keeps
// concurrent panels bounded without hiding an event-targeted refresh.
const peerResultCache = new Map<string, { fetchedAt: number; result: PeerResult }>();
const PEER_RESULT_CACHE_TTL_MS = 4_000;

async function fetchPeer(peer: { id: string; name: string; url: string }, scope: LocalActivityScope = "local", includeArchived = false, force = false, observeOnly = false, completionView = false): Promise<PeerResult> {
  const cacheKey = `${peer.id}:${scope}:${includeArchived ? "archived" : "active"}:${observeOnly ? "observe" : "activity"}:${completionView ? "completion" : "list"}`;
  const cachedPeer = peerResultCache.get(cacheKey);
  if (!force && cachedPeer && Date.now() - cachedPeer.fetchedAt < PEER_RESULT_CACHE_TTL_MS) return cachedPeer.result;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PEER_TIMEOUT_MS);
  const device: SessionActivityDevice = { id: peer.id, name: peer.name, url: peer.url };
  try {
    const baseUrl = peer.url.replace(/\/$/, "");
    // 对端永远返回本机视角，不继续聚合；否则请求会递归拉 peers。
    const scopeQuery = scope === "hidden"
      ? "hidden&local=1"
      : scope === "favorites"
        ? "favorites&local=1"
        : scope === "to_discuss"
          ? "to_discuss&local=1"
          : scope === "to_revise"
            ? "to_revise&local=1"
            : scope === "completed"
              ? "completed&local=1"
              : "local";
    // Older peers cannot prove the observe-only contract. Do not fall back to
    // session-runs: that endpoint may resume pending analysis jobs.
    const route = observeOnly ? "/api/reader/session-catalog" : "/api/session-runs";
    const response = await fetch(`${baseUrl}${route}?scope=${scopeQuery}${includeArchived ? "&archived=1" : ""}${force ? "&force=1" : ""}${completionView ? "&view=completion" : ""}`, {
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as Partial<SessionActivityResponse> & {
      observation?: { schemaVersion?: number; readOnly?: boolean; runtimeStartAttempted?: boolean; writeSideEffects?: boolean };
    };
    if (payload.schemaVersion !== 1 || !Array.isArray(payload.sessions)) throw new Error("invalid response");
    if (completionView && payload.view !== "completion") throw new Error("peer completion view unavailable");
    if (observeOnly && (payload.observation?.schemaVersion !== 1 || payload.observation.readOnly !== true
      || payload.observation.runtimeStartAttempted !== false || payload.observation.writeSideEffects !== false)) {
      throw new Error("peer observe-only contract unavailable");
    }
    const onlineDevice = { ...device, online: true, lastSeenAt: new Date().toISOString() };
    const result: PeerResult = {
      device: onlineDevice,
      metadataWarnings: (payload.metadataWarnings ?? []).filter(warning => warning.deviceId === peer.id),
      sessions: payload.sessions.map((item) => ({ ...item, device: onlineDevice })),
      knownProjects: (payload.knownProjects ?? []).map((entry) => ({ ...entry, deviceId: device.id })),
      subprojects: (payload.subprojects ?? []).map((entry) => ({ ...entry, deviceId: device.id })),
      subprojectSortSettings: (payload.subprojectSortSettings ?? []).map((entry) => ({ ...entry, deviceId: device.id })),
      hidden: payload.hidden,
    };
    peerResultCache.set(cacheKey, { fetchedAt: Date.now(), result });
    return result;
  } catch (error) {
    return {
      device: {
        ...device,
        online: false,
        error: error instanceof Error && error.name === "AbortError" ? "timeout" : "offline",
      },
      sessions: [],
      knownProjects: [],
      subprojects: [],
      subprojectSortSettings: [],
      hidden: { sessions: [], projects: [], devices: [], visibleSessions: [] },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(req: Request) {
  const perf = startServerPerf("GET /api/session-runs");
  let observeOnly = false;
  let observation: {
    schemaVersion: number; readOnly: boolean; runtimeStartAttempted: boolean; writeSideEffects: boolean;
  } | undefined;
  try {
    const url = new URL(req.url);
    const completionView = url.searchParams.get("view") === "completion";
    observeOnly = completionView || url.searchParams.get("observeOnly") === "1";
    if (observeOnly) {
      observation = {
        schemaVersion: 1, readOnly: true, runtimeStartAttempted: false, writeSideEffects: false,
      };
    }
    const params = url.searchParams;
    const includeArchived = params.get("archived") === "1";
    const force = params.get("force") === "1";
    // 事件驱动刷新带 &refresh=<deviceId>：只绕过**变更设备**的 peer 4s TTL，
    // 其余 peer 走缓存（全量 bust 会让每次变更/事件都等待所有 peer 重建列表）。
    const refreshPeer = params.get("refresh");
    if (refreshPeer) {
      if (refreshPeer === "1") {
        peerResultCache.clear();
      } else {
        const peerId = decodeURIComponent(refreshPeer);
        for (const key of [...peerResultCache.keys()]) {
          if (key.startsWith(`${peerId}:`)) peerResultCache.delete(key);
        }
      }
    }
    const scopeParam = params.get("scope");
    const validScopes: LocalActivityScope[] = ["local", "hidden", "favorites", "to_discuss", "to_revise", "completed"];
    const scope = validScopes.includes(scopeParam as LocalActivityScope) ? (scopeParam as LocalActivityScope) : "all";
    const hiddenScope = scope === "hidden";
    const collectionScope = hiddenScope || scope === "favorites" || scope === "to_discuss" || scope === "to_revise" || scope === "completed";
    const localScope: LocalActivityScope = hiddenScope ? "hidden" : collectionScope ? (scope as LocalActivityScope) : "local";
    const local = {
      ...await buildLocalResponse(includeArchived, localScope, force, observeOnly, completionView),
      ...(observation ? { observation } : {}),
    };
    perf?.span("local");
    if (scope === "local") {
      const response = NextResponse.json(local, { headers: { "Cache-Control": "no-store" } });
      perf?.span("assemble");
      return perf?.attach(response) ?? response;
    }
    // 对端视角请求（fetchPeer 带 &local=1）：只回本机数据，不聚合 peers。
    const localOnly = params.get("local") === "1";
    if (localOnly) {
      const response = NextResponse.json(local, { headers: { "Cache-Control": "no-store" } });
      perf?.span("assemble");
      return perf?.attach(response) ?? response;
    }

    const config = readConfig();
    const peers = configuredPeers(config, local.device);
    const refreshedPeerId = refreshPeer && refreshPeer !== "1" ? decodeURIComponent(refreshPeer) : null;
    const peerResults = await Promise.allSettled(peers.map((peer) => fetchPeer(
      peer,
      collectionScope ? localScope : "local",
      includeArchived,
      force && (!refreshPeer || refreshPeer === "1" || peer.id === refreshedPeerId),
      observeOnly,
      completionView,
    )));
    perf?.span("peer-fetch");
    const normalizedPeerResults: PeerResult[] = peerResults.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      const peer = peers[index];
      return {
        device: { id: peer.id, name: peer.name, url: peer.url, online: false, error: "offline" },
        sessions: [],
        knownProjects: [],
        subprojects: [],
        subprojectSortSettings: [],
        hidden: { sessions: [], projects: [], devices: [], visibleSessions: [] },
      };
    });
    perf?.span("peer-normalize");
    const sessions = [...local.sessions, ...normalizedPeerResults.flatMap((result) => result.sessions)]
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    // 设备展示顺序由本机配置的 order 字段决定（全部设备 → order 升序），
    // 缺省按名称排序，保证下拉顺序不随服务端返回顺序/字典序漂移。
    const orderOf = new Map<string, number>();
    if (config.device?.order != null) orderOf.set(local.device.id, config.device.order);
    for (const peer of Array.isArray(config.peers) ? config.peers : []) {
      if (peer.order != null) orderOf.set(peer.id, peer.order);
    }
    // 隐藏清单合并：正常视图剔除被隐藏设备（其会话/项目已被源端联动过滤）；
    // 隐藏页视图保留全部设备，供「隐藏设备」区块渲染与恢复。
    const hiddenUnion: HiddenState = { sessions: [], projects: [], devices: [], visibleSessions: [] };
    for (const result of [local, ...normalizedPeerResults]) {
      for (const kind of ["sessions", "projects", "devices", "visibleSessions"] as const) {
        for (const id of result.hidden?.[kind] ?? []) {
          if (!hiddenUnion[kind].includes(id)) hiddenUnion[kind].push(id);
        }
      }
    }
    const devices = [local.device, ...normalizedPeerResults.map((result) => result.device)]
      .filter((device) => completionView || collectionScope || !hiddenUnion.devices.includes(device.id))
      .sort((a, b) => (orderOf.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (orderOf.get(b.id) ?? Number.MAX_SAFE_INTEGER)
        || a.name.localeCompare(b.name));
    const knownProjects = [...(local.knownProjects ?? []), ...normalizedPeerResults.flatMap((result) => result.knownProjects ?? [])];
    const subprojects = [...(local.subprojects ?? []), ...normalizedPeerResults.flatMap((result) => result.subprojects ?? [])];
    const subprojectSortSettings = [...(local.subprojectSortSettings ?? []), ...normalizedPeerResults.flatMap((result) => result.subprojectSortSettings ?? [])];
    // scope=all 响应不带本机隐藏清单（客户端正常视图不消费）；隐藏页响应才带合并后的清单。
    const localBase = { ...local };
    Reflect.deleteProperty(localBase, "hidden");
    const response: SessionActivityResponse = {
      ...localBase,
      metadataWarnings: [...(local.metadataWarnings ?? []), ...normalizedPeerResults.flatMap(result => result.metadataWarnings ?? [])],
      scope,
      devices,
      sessions,
      knownProjects,
      subprojects,
      subprojectSortSettings,
    };
    if (hiddenScope) response.hidden = hiddenUnion;
    const output = NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
    perf?.span("assemble");
    return perf?.attach(output) ?? output;
  } catch (error) {
    const output = NextResponse.json(
      { error: observeOnly ? "Reader session catalog unavailable" : String(error), ...(observation ? { observation } : {}) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
    perf?.span("error");
    return perf?.attach(output) ?? output;
  }
}
