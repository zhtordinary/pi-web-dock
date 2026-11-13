"use client";

import { FilterAuthorityCursor } from "@/lib/filter-authority";
import { WorktreeSessionBuckets } from "./WorktreeSessionBuckets";
import { openReaderEventSource } from "@/lib/reader-events-client";

// ---------------------------------------------------------------------------
// 面板术语：本文件承载三个面板——
// 3 活动会话侧栏 Activity Session Sidebar（SessionActivitySidebar，.session-activity-sidebar，左栏活动模式）；
// 4 活动大面板 Activity Panel（SessionActivityPanel，.session-activity-panel，顶栏
//   「会话活动」单击弹出的浮层，与左栏可同开）；
// 1 聚合侧栏 Aggregate Sidebar 复用同一 SessionActivitySidebar 组件，外层页传
//   activityScope="all" 渲染为最外层固定左栏。
// 原始会话侧栏（左栏会话模式，SessionSidebar，#session-sidebar）见 ./SessionSidebar。
// ---------------------------------------------------------------------------

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { clampFloatingMenuPosition } from "@/lib/floating-menu-position";
import { Archive, Check, Copy, Eye, EyeOff, FileInput, FileText, FolderGit2, FolderPlus, GitFork, Map as MapIcon, MessageSquare, MessageSquarePlus, MonitorOff, Pencil, Star, Trash2, X } from "lucide-react";
import { assertSessionMutationOk } from "@/lib/session-mutation";
import { copyText } from "@/lib/clipboard";
import { apiPathForPeer } from "@/lib/file-api";
import { sessionCacheHitRate, sessionCostColor, sessionCostPresentation } from "@/lib/session-cost";
import { sessionRecapDisplay } from "@/lib/session-recap";
import { useSessionDetails } from "@/hooks/useSessionDetails";
import { useIsMobile } from "@/hooks/useIsMobile";
import { clearSessionActivityCache, fetchSessionActivity } from "@/lib/session-activity-fetch";
import { useI18n } from "@/hooks/useI18n";
import { statusSoundRequestId, useAudio, tryPlaySoundRequest, waitSoundRequestId } from "@/hooks/useAudio";
import { announceReaderMenuOpen, ReaderFloatingMultiSelect, ReaderFloatingSelect, type ReaderSelectOption } from "./ReaderFloatingSelect";
import { DirectoryPicker } from "./DirectoryPicker";
import { SessionSearchInput } from "./SessionSearchInput";
import { SessionSubprojectMenu } from "./SessionSubprojectMenu";
import { SessionContextMenu } from "./SessionContextMenu";
import type { SessionStorageCategory } from "@/lib/session-category-state";
import { SessionHoverPreview, useSessionHover } from "./SessionHoverPreview";
import { createPortal } from "react-dom";
import { isSubprojectReorderDragBlocked, useSessionSubprojectPointerDrag } from "@/lib/session-subproject-pointer-dnd";
import { filterSubprojectItems, groupBySubproject, orderedSubprojectIds, projectKeysMatch, reorderSubprojectIds } from "@/lib/subproject-groups";
import type {
  SessionActivityDevice,
  SessionActivityItem,
  SessionActivityResponse,
  SessionActivityStatus,
  SessionRunRecord,
  SessionActivitySubprojectSortSetting,
} from "@/lib/session-activity-types";
import type { HiddenKind } from "@/lib/hidden-state";
import type { SubprojectDefinition, SubprojectSortMode, SubprojectSortSetting } from "@/lib/subproject-state";
import { sessionSearchResultMatchesFilter, sessionSearchResultSources, type SessionSearchMatchFilter, type SessionSearchResult } from "@/lib/types";
import { applySessionActivityEvent, applySessionActivityPeerState, isTerminalSessionRunStatus, type SessionActivityEventPayload, type SessionActivityPeerStatePayload } from "@/lib/session-activity-client";
import { ACTIVITY_TIME_RANGE_VALUES, isWithinActivityTimeRange, sessionActivityDisplayTime, type ActivityTimeRange as TimeRangeValue } from "@/lib/session-activity-filters";
import { isSubagentCompletionConfirmed } from "@/lib/session-activity-status";
import { lineageParentId } from "@/lib/session-lineage";
import { sessionDisplayTitle, sessionModelLabel, sessionModelValue } from "@/lib/session-display";
import { useSubagentVisibility, setSubagentVisibility } from "@/hooks/useSubagentVisibility";

const STATE_KEY = "pi-session-activity-panel";
export const ACTIVITY_DEVICE_SLOT_WIDTH = 168;

type FilterValue = "all" | string;
type SortValue = "asked" | "recent" | "status";
type GroupValue = "none" | "project" | "device" | "worktree";
type ActivityScope = "local" | "all" | "hidden" | "favorites" | "to_discuss" | "to_revise" | "completed";
type ArchiveView = "active" | "archived";
type SessionActivityCardAction = (item: SessionActivityItem) => void | Promise<void>;

export function resolveActivityScope(
  requestedScope: ActivityScope,
  views: {
    hiddenView?: boolean;
    favoriteView?: boolean;
    toDiscussView?: boolean;
    toReviseView?: boolean;
    completedView?: boolean;
  },
): ActivityScope {
  if (requestedScope !== "all") return requestedScope;
  if (views.hiddenView) return "hidden";
  if (views.favoriteView) return "favorites";
  if (views.toDiscussView) return "to_discuss";
  if (views.toReviseView) return "to_revise";
  if (views.completedView) return "completed";
  return requestedScope;
}

export function SessionSearchMatchFilterSelect({ value, onChange }: {
  value: SessionSearchMatchFilter;
  onChange: (value: SessionSearchMatchFilter) => void;
}) {
  const { t } = useI18n();
  return (
    <ReaderFloatingSelect
      containerClassName="session-search-match-filter-select"
      value={value}
      onChange={(value) => onChange(value as SessionSearchMatchFilter)}
      ariaLabel={t("sessionActivity.searchMatchFilterLabel")}
      title={t("sessionActivity.searchMatchFilterLabel")}
      triggerStyle={{ height: 24, minWidth: 62, padding: "0 5px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text-muted)", fontSize: 11 }}
      options={[
        { value: "all", label: t("sessionActivity.searchMatchFilterAll") },
        { value: "content", label: t("sessionActivity.searchMatchFilterContent") },
        { value: "title", label: t("sessionActivity.searchMatchFilterTitle") },
        { value: "id", label: t("sessionActivity.searchMatchFilterId") },
      ]}
    />
  );
}

function matchesActivityDevice(deviceId: string, selectedDevice: string, activityScope: ActivityScope): boolean {
  return activityScope === "local" || selectedDevice === "all" || deviceId === selectedDevice;
}

export interface SessionActivityPanelState {
  device: FilterValue;
  archiveView: ArchiveView;
  project: string[];
  status: FilterValue;
  sort: SortValue;
  days: TimeRangeValue;
  group: GroupValue;
  expanded: string[];
  collapsedGroups: string[];
  scrollTop: number;
}

interface Props {
  onOpenSession: (item: SessionActivityItem, searchTerm?: string, deviceFilter?: string) => void;
  /** 旧完整设备视图切换；仅由 deviceSwitchOnly 入口调用。 */
  onDeviceChange?: (device: SessionActivityDevice | null) => void;
  /** 普通活动设备筛选；只改变列表域（必要时退出隐藏/收藏页），不导航工作区。 */
  onActivityDeviceFilterChange?: (device: SessionActivityDevice | null) => void;
  onProjectCwdChange?: (cwd: string | null) => void;
  onProjectRemoved?: (path: string, deviceId: string) => void;
  onNewSession?: (cwd: string, device?: SessionActivityDevice, subprojectId?: string, subprojectLabel?: string) => void;
  /** Open the owning project's Git worktree graph. */
  onOpenWorktreeGraph?: (projectRoot: string, device?: SessionActivityDevice) => void;
  /** Session-card Talk Map action; preserves the item device and focus session. */
  onOpenTalkMapForSession?: SessionActivityCardAction;
  /** Session-card context injection action. */
  onInjectContext?: SessionActivityCardAction;
  /** Session-card source identity copy action. */
  onCopySessionInfo?: SessionActivityCardAction;
  onSessionDeleted?: (sessionId: string) => void;
  /** 远程设备会话操作通道（外层壳提供，iframe 转发到目标设备执行）。 */
  onRemoteMutate?: RemoteMutateFn;
  /** Reader: new-project panel targets this device (aggregate full view). */
  remotePeer?: string;
  activityScope?: ActivityScope;
  onOpenHidden?: () => void;
  onOpenFavorites?: () => void;
  onOpenToDiscuss?: () => void;
  onOpenToRevise?: () => void;
  onOpenCompleted?: () => void;
  hiddenView?: boolean;
  favoriteView?: boolean;
  toDiscussView?: boolean;
  toReviseView?: boolean;
  completedView?: boolean;
  refreshKey?: number;
  viewedAtBySession: Record<string, number>;
  onViewedAtChange?: (viewedAt: Record<string, number>) => void;
  /** Session currently open in the chat. When set, opening the panel locates
   * its row (un-collapsing its group) and scrolls it into view. The recap
   * card is not expanded and no /recap is sent automatically. */
  focusSessionId?: string | null;
  /** Exact device:session identity for an active embedded workspace. */
  focusSessionKey?: string | null;
  /** Talk Map selection highlight; does not change active chat session. */
  highlightedSessionId?: string | null;
  /** Reader: embed page turns off panel status sounds (delegated to outer shell). */
  soundAlerts?: boolean;
  /* Which surface owns status sounds for the focused session. */
  statusSoundOwner?: "chat" | "activity";
}

const DEFAULT_STATE: SessionActivityPanelState = {
  device: "all",
  archiveView: "active",
  project: [],
  status: "all",
  sort: "recent",
  days: "all",
  group: "project",
  expanded: [],
  collapsedGroups: [],
  scrollTop: 0,
};

/** Priority for the "status" sort: sessions needing attention come first
 * (waiting for the user, then fresh results, then in-progress, then error
 * states), finished ones after that, with idle last. Within a bucket,
 * newest activity comes first. */
function statusRank(status: SessionActivityStatus): number {
  switch (status) {
    case "waiting_user": return 0;
    case "just_completed": return 1;
    case "running": return 2;
    case "retrying": return 3;
    case "failed": return 4;
    case "aborted": return 5;
    case "unknown": return 6;
    default: return 7; // idle
  }
}

/** Filter fields shared between the big panel and the sidebar so both stay in
 * sync (the sidebar intentionally hides status/sort to save space, but they
 * still apply to it). Expanded rows / collapsed groups / scroll positions
 * remain per-panel local state. */
export type RemoteMutateFn = (
  device: SessionActivityDevice,
  op: "rename" | "archive" | "unarchive" | "delete",
  sessionId: string,
  name?: string,
) => Promise<boolean>;

type SubprojectMutationMethod = "POST" | "PATCH" | "DELETE" | "PUT";
type SubprojectMutationOptions = { refresh?: boolean; optimistic?: boolean };
type SubprojectMutationFn = (
  deviceId: string,
  method: SubprojectMutationMethod,
  body: Record<string, unknown>,
  options?: SubprojectMutationOptions,
) => Promise<{ ok: boolean; message?: string }>;
type SubprojectRefreshFn = (deviceId: string, waitForCurrent?: boolean) => Promise<void>;

function emptySubprojectDefinitions(definitions: readonly SubprojectDefinition[], items: readonly SessionActivityItem[]): SubprojectDefinition[] {
  const assignedIds = new Set(items.map((item) => item.session.subprojectId).filter((id): id is string => typeof id === "string"));
  return definitions.filter((subproject) => !assignedIds.has(subproject.id));
}

function hiddenSubprojectIdsFor(
  definitions: readonly SubprojectDefinition[],
  autoHiddenIds: ReadonlySet<string>,
): Set<string> {
  return new Set(definitions.filter((subproject) => subproject.hidden || autoHiddenIds.has(subproject.id)).map((subproject) => subproject.id));
}

async function toggleAutoHideEmptySubprojects(
  projectKey: string,
  sortSetting: SubprojectSortSetting | undefined,
  deviceId: string,
  mutate: SubprojectMutationFn,
  refresh: SubprojectRefreshFn,
): Promise<void> {
  const enabled = !Boolean(sortSetting?.autoHideEmptySubprojects);
  const result = await mutate(deviceId, "PUT", {
    projectKey,
    mode: sortSetting?.mode ?? "custom",
    order: sortSetting?.order ?? [],
    autoHideEmptySubprojects: enabled,
  }, { refresh: false, optimistic: true });
  if (!result.ok) throw new Error(result.message ?? "subproject auto-hide update failed");
  void refresh(deviceId, true);
  if (typeof window !== "undefined") window.dispatchEvent(new Event("pi-subprojects-changed"));
}

function AutoHideEmptySubprojectsButton({ projectKey, deviceId, sortSetting, mutate, refresh, t }: {
  projectKey: string;
  deviceId: string;
  sortSetting?: SubprojectSortSetting;
  mutate: SubprojectMutationFn;
  refresh: SubprojectRefreshFn;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const enabled = Boolean(sortSetting?.autoHideEmptySubprojects);
  const label = t("sessionActivity.autoHideEmptySubprojects");

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await toggleAutoHideEmptySubprojects(projectKey, sortSetting, deviceId, mutate, refresh);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      className="activity-project-action"
      type="button"
      data-project-auto-hide-empty-subprojects
      onClick={(event) => { event.stopPropagation(); void toggle(); }}
      disabled={busy}
      title={failed ? `${label}: ${t("sessionActivity.projectPathActionFailed")}` : label}
      aria-label={label}
      aria-pressed={enabled}
      aria-busy={busy}
      style={{ color: enabled ? "var(--text-dim)" : "var(--accent)", opacity: busy ? 0.55 : 1, cursor: busy ? "wait" : "pointer" }}
    >
      {enabled ? <EyeOff size={14} strokeWidth={1.8} aria-hidden="true" /> : <Eye size={14} strokeWidth={1.8} aria-hidden="true" />}
    </button>
  );
}

export type SharedActivityFilters = Pick<SessionActivityPanelState, "device" | "archiveView" | "project" | "status" | "sort" | "days" | "group">;

function normalizeActivityFilterScope<T extends { device: FilterValue; group: GroupValue }>(filters: T): T {
  return filters.device !== "all" && filters.group === "device"
    ? { ...filters, group: "project" }
    : filters;
}

const SHARED_FILTERS_KEY = "pi-session-activity-filters";
const SHARED_FILTER_KEYS: (keyof SharedActivityFilters)[] = ["device", "archiveView", "project", "status", "sort", "days", "group"];

let sharedFilters: SharedActivityFilters | null = null;
const filterListeners = new Set<() => void>();

function readStoredSharedFilters(): Partial<SharedActivityFilters> {
  if (typeof window === "undefined") return {};
  try {
    const localStorageValue = window.localStorage.getItem(SHARED_FILTERS_KEY);
    const raw = localStorageValue ?? window.sessionStorage.getItem(SHARED_FILTERS_KEY);
    if (!raw) return {};
    if (!localStorageValue) window.localStorage.setItem(SHARED_FILTERS_KEY, raw);
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const stored: Partial<SharedActivityFilters> = {};
    if (typeof parsed.device === "string") stored.device = parsed.device;
    if (parsed.archiveView === "active" || parsed.archiveView === "archived") stored.archiveView = parsed.archiveView;
    if (Array.isArray(parsed.project)) stored.project = parsed.project.filter((value): value is string => typeof value === "string");
    if (typeof parsed.status === "string") stored.status = parsed.status;
    if (parsed.sort === "asked" || parsed.sort === "recent" || parsed.sort === "status") stored.sort = parsed.sort;
    if (typeof parsed.days === "string" && ACTIVITY_TIME_RANGE_VALUES.has(parsed.days as TimeRangeValue)) stored.days = parsed.days as TimeRangeValue;
    if (parsed.group === "none" || parsed.group === "project" || parsed.group === "device" || parsed.group === "worktree") stored.group = parsed.group;
    return stored;
  } catch {
    return {};
  }
}

export function readSharedFilters(): SharedActivityFilters {
  if (!sharedFilters) {
    const saved = readState();
    const stored = readStoredSharedFilters();
    sharedFilters = normalizeActivityFilterScope({
      device: stored.device ?? saved.device,
      archiveView: stored.archiveView ?? saved.archiveView,
      project: stored.project ?? saved.project,
      status: stored.status ?? saved.status,
      sort: stored.sort ?? saved.sort,
      days: stored.days ?? saved.days,
      group: stored.group ?? saved.group,
    });
  }
  return sharedFilters;
}

// 跨窗口复制协议（revision）：sharedRevision 单调递增。
// 用户操作（updateSharedFilters）递增版本并广播；接收远端状态
// （applyRemoteSharedFilters）仅在版本更大时应用，绝不广播 ——
// 结构上杜绝回环/死循环。
let sharedRevision = 0;
const remoteFilterCursor = new FilterAuthorityCursor();
let sharedOwnerEpoch: string | undefined;
export function readSharedOwnerEpoch(): string {
  return sharedOwnerEpoch ??= globalThis.crypto.randomUUID();
}
const broadcastListeners = new Set<(patch: Partial<SharedActivityFilters>) => void>();

export function readSharedRevision(): number {
  return sharedRevision;
}

export function subscribeSharedFiltersBroadcast(listener: (patch: Partial<SharedActivityFilters>) => void): () => void {
  broadcastListeners.add(listener);
  return () => {
    broadcastListeners.delete(listener);
  };
}

export function updateSharedFilters(patch: Partial<SharedActivityFilters>): void {
  sharedFilters = normalizeActivityFilterScope({ ...readSharedFilters(), ...patch });
  sharedRevision += 1;
  try {
    window.localStorage.setItem(SHARED_FILTERS_KEY, JSON.stringify(sharedFilters));
  } catch {
    // In-memory state is still consistent.
  }
  for (const listener of filterListeners) listener();
  for (const listener of broadcastListeners) listener(patch);
}

export function applyRemoteSharedFilters(rev: number, filters: SharedActivityFilters, epoch = "legacy-owner", initial = false): boolean {
  if (!remoteFilterCursor.accept(epoch, rev, initial)) return false;
  sharedOwnerEpoch = epoch;
  sharedFilters = normalizeActivityFilterScope({ ...filters });
  sharedRevision = rev;
  try {
    window.localStorage.setItem(SHARED_FILTERS_KEY, JSON.stringify(sharedFilters));
  } catch {
    // In-memory state is still consistent.
  }
  for (const listener of filterListeners) listener();
  // 应用远端状态不触发 broadcastListeners：接收即终态，不回发。
  return true;
}

function subscribeSharedFilters(listener: () => void): () => void {
  filterListeners.add(listener);
  return () => { filterListeners.delete(listener); };
}

export function useSharedActivityFilters(): [SharedActivityFilters, (patch: Partial<SharedActivityFilters>) => void] {
  const filters = useSyncExternalStore(subscribeSharedFilters, readSharedFilters, readSharedFilters);
  return [filters, updateSharedFilters];
}

function readState(): SessionActivityPanelState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("panelState") || window.sessionStorage.getItem(STATE_KEY);
    const parsed = JSON.parse(raw ?? "null") as (Partial<SessionActivityPanelState> & { project?: unknown; collapsedGroups?: unknown }) | null;
    const rawProject = parsed?.project;
    const project = Array.isArray(rawProject)
      ? rawProject.filter((value): value is string => typeof value === "string")
      : typeof rawProject === "string" && rawProject !== "all" ? [rawProject] : [];
    const archiveView = parsed?.archiveView === "archived" ? "archived" : "active";
    const days = typeof parsed?.days === "string" && ACTIVITY_TIME_RANGE_VALUES.has(parsed.days as TimeRangeValue)
      ? parsed.days as TimeRangeValue
      : DEFAULT_STATE.days;
    return normalizeActivityFilterScope({
      ...DEFAULT_STATE,
      ...parsed,
      project,
      archiveView,
      days,
      expanded: Array.isArray(parsed?.expanded) ? parsed.expanded.filter((value): value is string => typeof value === "string") : [],
      collapsedGroups: Array.isArray(parsed?.collapsedGroups) ? parsed.collapsedGroups.filter((value): value is string => typeof value === "string") : [],
    });
  } catch {
    return DEFAULT_STATE;
  }
}

function saveState(state: SessionActivityPanelState): void {
  try {
    sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // Storage is an enhancement; the panel remains usable without it.
  }
}

function itemKey(item: SessionActivityItem): string {
  return `${item.device.id}:${item.session.id}`;
}

interface ActivitySessionNode {
  item: SessionActivityItem;
  children: ActivitySessionNode[];
}

const knownSessionParents = new Map<string, string>();

type SubagentVisibilitySession = Pick<SessionActivityItem["session"], "id" | "relation">;

function isVisibleSubagentSession(session: SubagentVisibilitySession, visibleParentIds: ReadonlySet<string>, keepSessionId?: string): boolean {
  return session.id === keepSessionId
    || session.relation?.kind !== "subagent"
    || visibleParentIds.has(session.relation.parentSessionId);
}

function filterVisibleSubagentItems(items: readonly SessionActivityItem[], visibleParentIds: ReadonlySet<string>, keepSessionId?: string): SessionActivityItem[] {
  return items.filter((item) => isVisibleSubagentSession(item.session, visibleParentIds, keepSessionId));
}

function hasSubagentChildren(items: readonly SessionActivityItem[], item: SessionActivityItem): boolean {
  return items.some((candidate) => candidate.device.id === item.device.id
    && candidate.session.relation?.kind === "subagent"
    && candidate.session.relation.parentSessionId === item.session.id);
}

function hasSubagentChild(items: readonly SessionActivityItem[], parentId: string, deviceId?: string): boolean {
  return items.some((candidate) => (!deviceId || candidate.device.id === deviceId)
    && candidate.session.relation?.kind === "subagent"
    && candidate.session.relation.parentSessionId === parentId);
}

function registerSessionLineage(sessions: readonly SessionActivityItem[]): void {
  for (const item of sessions) {
    const parentId = lineageParentId(item.session);
    if (parentId) {
      knownSessionParents.set(itemKey(item), `${item.device.id}:${parentId}`);
    }
  }
}

/**
 * Nest forked and context-injected sessions by device-local source ID. When a
 * parent is filtered out, the child remains a marked root rather than vanishing.
 */
function buildSessionLineageTree(items: SessionActivityItem[], sort: SortValue): ActivitySessionNode[] {
  const byKey = new Map<string, ActivitySessionNode>();
  for (const item of items) byKey.set(itemKey(item), { item, children: [] });

  const parentOf = new Map<string, string>();
  for (const [key, parentKey] of knownSessionParents) {
    parentOf.set(key, parentKey);
  }
  for (const item of items) {
    const parentId = lineageParentId(item.session);
    if (parentId) {
      const parentKey = `${item.device.id}:${parentId}`;
      parentOf.set(itemKey(item), parentKey);
      knownSessionParents.set(itemKey(item), parentKey);
    }
  }
  function resolveAncestor(key: string): string | null {
    let cur = parentOf.get(key);
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) return null; // cycle guard
      visited.add(cur);
      if (byKey.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return null;
  }
  const roots: ActivitySessionNode[] = [];
  for (const [key, node] of byKey) {
    const ancestor = resolveAncestor(key);
    if (ancestor) byKey.get(ancestor)!.children.push(node);
    else roots.push(node);
  }
  const latestByNode = new Map<ActivitySessionNode, SessionActivityItem>();
  const collectLatest = (node: ActivitySessionNode): SessionActivityItem => {
    let latest = node.item;
    for (const child of node.children) {
      const childLatest = collectLatest(child);
      if (compareBySort(childLatest, latest, sort) < 0) latest = childLatest;
    }
    latestByNode.set(node, latest);
    return latest;
  };
  roots.forEach(collectLatest);
  const sortLineage = (nodes: ActivitySessionNode[]) => {
    nodes.sort((left, right) => compareBySort(latestByNode.get(left)!, latestByNode.get(right)!, sort));
    nodes.forEach((node) => sortLineage(node.children));
  };
  sortLineage(roots);
  return roots;
}

/**
 * Recursive session-lineage renderer. Child rows use one quiet vertical guide,
 * while indentation and the row chevron carry the hierarchy without branch arms.
 */
function SessionLineageBranchList({
  nodes,
  renderRow,
  variant = "panel",
  collapsedBranchKeys,
}: {
  nodes: ActivitySessionNode[];
  renderRow: (node: ActivitySessionNode, depth: number, isLast: boolean, hasChildren: boolean) => React.ReactNode;
  variant?: "panel" | "sidebar";
  collapsedBranchKeys?: Set<string>;
}) {
  const isSidebar = variant === "sidebar";
  const indentLeft = isSidebar ? 14 : 22;
  const paddingLeft = isSidebar ? 9 : 12;
  const guideBorder = "1px solid color-mix(in srgb, var(--text-dim) 28%, transparent)";

  const renderLevel = (levelNodes: ActivitySessionNode[], depth: number): React.ReactNode => (
    <>
      {levelNodes.map((node, index) => {
        const isLast = index === levelNodes.length - 1;
        const hasChildren = node.children.length > 0;
        const key = itemKey(node.item);
        const isBranchCollapsed = Boolean(collapsedBranchKeys?.has(key));
        return (
          <Fragment key={key}>
            {renderRow(node, depth, isLast, hasChildren)}
            {hasChildren && !isBranchCollapsed && (
              <div style={{ position: "relative", marginLeft: indentLeft, paddingLeft, borderLeft: guideBorder }}>
                {renderLevel(node.children, depth + 1)}
              </div>
            )}
          </Fragment>
        );
      })}
    </>
  );
  return <>{renderLevel(nodes, 0)}</>;
}

function sessionTitle(item: SessionActivityItem): string {
  return sessionDisplayTitle(item.session);
}

function deviceLabel(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\.local$/, "");
  if (normalized.includes("debian")) return "Debian";
  if (normalized.includes("macbook air")) return "Mac Air";
  if (normalized.includes("mac mini")) return "Mac Mini";
  return name;
}

/** Per-row context label: device name in flat all-device view, project name
 * in flat single-device or device-grouped view, nothing under project groups
 * (the group header already names the project). */
function rowContextLabel(item: SessionActivityItem, group: GroupValue, activityScope: ActivityScope, deviceAll: boolean): string | undefined {
  if (group === "none") return activityScope === "all" && deviceAll ? deviceLabel(item.device.name) : item.projectLabel;
  if (group === "device") return item.projectLabel;
  return undefined;
}

function itemTime(item: SessionActivityItem, sort: SortValue): string {
  return sessionActivityDisplayTime(item, sort);
}

export function compareBySort(a: SessionActivityItem, b: SessionActivityItem, sort: SortValue): number {
  if (sort === "status") {
    const rankDiff = statusRank(a.status) - statusRank(b.status);
    if (rankDiff !== 0) return rankDiff;
    return itemTime(b, "recent").localeCompare(itemTime(a, "recent"));
  }
  return itemTime(b, sort).localeCompare(itemTime(a, sort));
}

function statusColor(status: SessionActivityStatus): string {
  if (status === "running") return "#16a34a";
  if (status === "retrying") return "#ea580c";
  if (status === "waiting_user") return "#9333ea";
  if (status === "failed") return "#dc2626";
  if (status === "aborted") return "#d97706";
  if (status === "unknown") return "#7c3aed";
  if (status === "just_completed") return "#2563eb";
  return "var(--text-dim)";
}

function duration(run: SessionRunRecord | null, now: number): string | null {
  if (!run) return null;
  const end = run.completedAt ? Date.parse(run.completedAt) : now;
  const start = Date.parse(run.startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

type CostRootRef = { current: Element | null };

// Summary costs share the row cache without making full transcript details ready.
function useLazySessionCost(
  sessionId: string,
  version: string,
  peer: string | undefined,
  rootRef: CostRootRef | undefined,
) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const { cost, costState } = useSessionDetails({
    sessionId,
    version,
    peer,
    costView: "summary",
    loadCost: nearViewport,
  });

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    let cancelled = false;
    if (typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return () => { cancelled = true; };
    }
    const observer = new IntersectionObserver((entries) => {
      if (cancelled) return;
      setNearViewport(entries[0]?.isIntersecting ?? false);
    }, { root: rootRef?.current ?? null, rootMargin: "240px 0px" });
    observer.observe(row);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [rootRef]);

  const mainUsage = cost?.mainCost?.usage;
  const recapUsage = cost?.recapCost?.usage;
  const presentation = sessionCostPresentation(cost?.totalCost, cost?.extensionCosts);
  return {
    cost: cost?.amount ?? null,
    costState,
    costStatus: presentation.onlySuggesterPending && cost?.status === "partial" ? "calculated" : cost?.status ?? null,
    recapCost: cost?.recapCost?.amount ?? null,
    cacheHitRate: mainUsage
      ? sessionCacheHitRate(mainUsage.inputTokens, mainUsage.cachedInputTokens, mainUsage.cacheWriteTokens)
      : cost?.cacheHitRate ?? null,
    recapCacheHitRate: recapUsage
      ? sessionCacheHitRate(recapUsage.inputTokens, recapUsage.cachedInputTokens, recapUsage.cacheWriteTokens)
      : cost?.recapCacheHitRate ?? null,
    missingPriceModels: cost?.missingPriceModels ?? [],
    pendingUsageCount: presentation.pendingUsageCount,
    recordedOnly: presentation.recordedOnly,
    costRef: rowRef,
  };
}

function MetaSeparator() {
  return <span aria-hidden="true" style={{ margin: "0 5px", color: "var(--text-dim)", flexShrink: 0 }}>·</span>;
}

function effectiveStatus(item: SessionActivityItem, viewedAtBySession: Record<string, number>): SessionActivityStatus {
  if (item.status !== "idle" && item.status !== "just_completed") return item.status;
  if (item.latestRun?.status !== "completed") return item.status;
  const completedAt = item.latestRun.completedAt ? Date.parse(item.latestRun.completedAt) : NaN;
  const viewedAt = viewedAtBySession[item.session.id] ?? 0;
  return Number.isFinite(completedAt) && completedAt > viewedAt ? "just_completed" : "idle";
}
function hasCompletedSubagent(item: Pick<SessionActivityItem, "latestRun" | "subagentTerminalState" | "subagentTerminalAt">): boolean {
  return isSubagentCompletionConfirmed({
    parentRunStatus: item.latestRun?.status,
    parentRunStartedAt: item.latestRun?.startedAt,
    subagentTerminalState: item.subagentTerminalState,
    subagentTerminalAt: item.subagentTerminalAt,
  });
}

function Icon({ name, size = 15 }: { name: "chevron" | "refresh" | "activity" | "arrowLeft" | "copy" | "folder"; size?: number }) {
  if (name === "refresh") return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0 1 4" /><path d="M20 4v7h-7" /></svg>;
  if (name === "activity") return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>;
  if (name === "arrowLeft") return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></svg>;
  if (name === "copy") return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="1.5" /><path d="M5 15V5.5A1.5 1.5 0 0 1 6.5 4H15" /></svg>;
  if (name === "folder") return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" /></svg>;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>;
}

const projectContextMenuStyle: React.CSSProperties = {
  position: "fixed",
  zIndex: 1300,
  display: "grid",
  width: "max-content",
  minWidth: 0,
  maxWidth: "calc(100vw - 16px)",
  padding: 4,
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--bg-panel)",
  boxShadow: "0 10px 28px rgba(15,23,42,0.16)",
  maxHeight: "calc(100vh - 16px)",
  overflowY: "auto",
  boxSizing: "border-box",
};

const projectContextMenuItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "max-content",
  minWidth: 0,
  minHeight: 30,
  padding: "0 12px",
  border: 0,
  borderRadius: 5,
  background: "transparent",
  color: "var(--text)",
  cursor: "pointer",
  textAlign: "left",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  fontSize: 12,
  fontWeight: 400,
  lineHeight: 1.35,
  whiteSpace: "nowrap",
};

function ProjectPathContextMenu({ path, deviceId, canDelete = false, hasSessions = false, hasSubprojects = false, autoHideEmptySubprojects = false, openAt, onOpenAtChange, onDelete, onRequestDelete, onHide, onUnhide, onToggleAutoHideEmptySubprojects, subprojectAction, t, children, style }: {
  path?: string;
  deviceId?: string;
  canDelete?: boolean;
  hasSessions?: boolean;
  hasSubprojects?: boolean;
  autoHideEmptySubprojects?: boolean;
  openAt?: { x: number; y: number } | null;
  onOpenAtChange?: (position: { x: number; y: number } | null) => void;
  onDelete?: () => void | Promise<void>;
  onRequestDelete?: () => void;
  /** 正常视图：隐藏项目（联动隐藏该项目全部会话）。 */
  onHide?: () => void | Promise<void>;
  /** 隐藏页：取消隐藏项目。 */
  onUnhide?: () => void | Promise<void>;
  /** 项目标题右键菜单中的项目级自动隐藏开关。 */
  onToggleAutoHideEmptySubprojects?: () => void | Promise<void>;
  /** 项目标题右键菜单中的子项目入口。 */
  subprojectAction?: React.ReactNode;
  t: (key: string, params?: Record<string, string | number>) => string;
  children: React.ReactNode;
  style: React.CSSProperties;
}) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const [busy, setBusy] = useState<"copy" | "open" | "delete" | "hide" | "auto-hide-empty" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => {
    setPosition(null);
    onOpenAtChange?.(null);
  }, [onOpenAtChange]);
  const focusMenuItem = useCallback(() => {
    const first = menuRef.current?.querySelector<HTMLElement>("[role=\"menuitem\"]");
    first?.focus({ preventScroll: true });
  }, []);
  const handleMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role=\"menuitem\"]") ?? [])]
      .filter((item) => !(item instanceof HTMLButtonElement && item.disabled));
    if (items.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : current < 0
          ? event.key === "ArrowUp" ? items.length - 1 : 0
          : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  }, [closeMenu]);

  useEffect(() => {
    if (!position) return;
    const frame = window.requestAnimationFrame(focusMenuItem);
    return () => window.cancelAnimationFrame(frame);
  }, [confirmDelete, focusMenuItem, position]);

  useEffect(() => {
    if (!openAt) return;
    setError(null);
    setConfirmDelete(false);
    setMenuPosition(null);
    setPosition(openAt);
  }, [openAt]);

  const reposition = useCallback(() => {
    if (!position || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const next = clampFloatingMenuPosition(
      position,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setMenuPosition((current) => (
      current?.left === next.left && current.top === next.top ? current : next
    ));
  }, [position]);

  useLayoutEffect(() => {
    if (!position) {
      setMenuPosition(null);
      return;
    }
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [busy, canDelete, confirmDelete, error, hasSubprojects, autoHideEmptySubprojects, hasSessions, onHide, onUnhide, onToggleAutoHideEmptySubprojects, position, reposition, subprojectAction]);

  useEffect(() => {
    if (!position) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      const inSubprojectPopover = target instanceof Element && target.closest("[data-subproject-manager-submenu], [data-subproject-context-menu], [data-worktree-manager-submenu]");
      if (!menuRef.current?.contains(target as Node) && !inSubprojectPopover) closeMenu();
    };
    const closeOnContextMenu = (event: MouseEvent) => {
      const target = event.target;
      const inSubprojectPopover = target instanceof Element && target.closest("[data-subproject-manager-submenu], [data-subproject-context-menu], [data-worktree-manager-submenu]");
      if (!menuRef.current?.contains(target as Node) && !inSubprojectPopover) closeMenu();
    };
    // A click inside an iframe never bubbles to the parent document. embedded session
    // session-only workspaces therefore dismiss the menu through focus changes.
    const closeOnFocusIn = (event: FocusEvent) => {
      if (event.target instanceof HTMLIFrameElement) closeMenu();
    };
    const closeOnWindowBlur = () => {
      if (document.activeElement instanceof HTMLIFrameElement || !document.hasFocus()) closeMenu();
    };
    const closeOnKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    document.addEventListener("pointerdown", closeOnPointerDown, true);
    document.addEventListener("contextmenu", closeOnContextMenu, true);
    document.addEventListener("focusin", closeOnFocusIn);
    document.addEventListener("keydown", closeOnKeyDown);
    window.addEventListener("blur", closeOnWindowBlur);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown, true);
      document.removeEventListener("contextmenu", closeOnContextMenu, true);
      document.removeEventListener("focusin", closeOnFocusIn);
      document.removeEventListener("keydown", closeOnKeyDown);
      window.removeEventListener("blur", closeOnWindowBlur);
    };
  }, [closeMenu, position]);

  if (!path) return <div style={style}>{children}</div>;

  const copyProjectPath = async () => {
    setBusy("copy");
    setError(null);
    try {
      await copyText(path);
      closeMenu();
    } catch {
      setError(t("sessionActivity.projectPathActionFailed"));
    } finally {
      setBusy(null);
    }
  };

  const openProjectPath = async () => {
    setBusy("open");
    setError(null);
    try {
      const response = await fetch("/api/files/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, ...(deviceId ? { deviceId } : {}) }),
      });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      closeMenu();
    } catch {
      setError(t("sessionActivity.projectPathActionFailed"));
    } finally {
      setBusy(null);
    }
  };

  const removeProjectPath = async () => {
    if (!onDelete) return;
    setBusy("delete");
    setError(null);
    try {
      await onDelete();
      closeMenu();
      setConfirmDelete(false);
    } catch (error) {
      setError(error instanceof Error && error.message ? error.message : t("sessionActivity.projectPathActionFailed"));
    } finally {
      setBusy(null);
    }
  };

  const toggleHidden = async () => {
    const action = onUnhide ?? onHide;
    if (!action) return;
    setBusy("hide");
    setError(null);
    try {
      await action();
      closeMenu();
    } catch (error) {
      setError(error instanceof Error ? error.message : t("sessionActivity.projectVisibilityFailed"));
    } finally {
      setBusy(null);
    }
  };

  const toggleAutoHideEmptySubprojects = async () => {
    if (!onToggleAutoHideEmptySubprojects) return;
    setBusy("auto-hide-empty");
    setError(null);
    try {
      await onToggleAutoHideEmptySubprojects();
      closeMenu();
    } catch {
      setError(t("sessionActivity.projectPathActionFailed"));
    } finally {
      setBusy(null);
    }
  };

  const menuPositionStyle: React.CSSProperties = position
    ? {
        left: menuPosition?.left ?? -10_000,
        top: menuPosition?.top ?? -10_000,
        visibility: menuPosition ? "visible" : "hidden",
      }
    : {};
  return (
    <>
      <div
        style={{ ...style, userSelect: "none" }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          window.getSelection()?.removeAllRanges();
          setError(null);
          setConfirmDelete(false);
          setMenuPosition(null);
          setPosition({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          setError(null);
          setConfirmDelete(false);
          setMenuPosition(null);
          setPosition({ x: rect.left + Math.min(24, rect.width), y: rect.bottom });
        }}
      >
        {children}
      </div>
      {position && typeof document !== "undefined"
        ? createPortal(
            <div ref={menuRef} role="menu" tabIndex={-1} aria-label={t("sessionActivity.projectActions")} onContextMenu={(event) => event.preventDefault()} onKeyDown={handleMenuKeyDown} style={{ ...projectContextMenuStyle, ...menuPositionStyle }}>
          {confirmDelete ? (
            <div style={{ padding: "6px 8px", display: "grid", gap: 6 }}>
              <span style={{ color: "var(--text)", fontSize: 11, maxWidth: 220, whiteSpace: "normal" }}>
                {t("sessionActivity.deleteProjectEmpty")}
              </span>
              <div style={{ display: "flex", gap: 5, justifyContent: "flex-end" }}>
                <button
                  className="reader-context-menu-item"
                  data-danger="true"
                  type="button"
                  role="menuitem"
                  disabled={busy !== null}
                  onClick={() => void removeProjectPath()}
                  style={{
                    height: 24,
                    padding: "0 8px",
                    background: "#ef4444",
                    color: "#fff",
                    border: "1px solid #ef4444",
                    borderRadius: 4,
                    fontSize: 10,
                    fontWeight: 600,
                    cursor: busy ? "wait" : "pointer",
                  }}
                >
                  {t("sidebar.confirm")}
                </button>
                <button
                  className="reader-context-menu-item"
                  type="button"
                  role="menuitem"
                  disabled={busy !== null}
                  onClick={() => { setConfirmDelete(false); closeMenu(); }}
                  style={{
                    height: 24,
                    padding: "0 8px",
                    background: "var(--bg)",
                    color: "var(--text-muted)",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    fontSize: 10,
                    cursor: busy ? "wait" : "pointer",
                  }}
                >
                  {t("sidebar.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <>
              <button className="reader-context-menu-item" type="button" role="menuitem" disabled={busy !== null} onClick={() => void copyProjectPath()} style={{ ...projectContextMenuItemStyle, width: "100%", opacity: busy && busy !== "copy" ? 0.55 : 1 }}>
                <Icon name="copy" size={14} />
                <span>{t("sessionActivity.copyProjectPath")}</span>
              </button>
              <button className="reader-context-menu-item" type="button" role="menuitem" disabled={busy !== null} onClick={() => void openProjectPath()} style={{ ...projectContextMenuItemStyle, width: "100%", opacity: busy && busy !== "open" ? 0.55 : 1 }}>
                <Icon name="folder" size={14} />
                <span>{busy === "open" ? t("sessionActivity.openingProjectPath") : t("sessionActivity.openProjectPath")}</span>
              </button>
              {subprojectAction}
              {hasSubprojects && onToggleAutoHideEmptySubprojects && (
                <button className="reader-context-menu-item" type="button" role="menuitem" disabled={busy !== null} onClick={() => void toggleAutoHideEmptySubprojects()} style={{ ...projectContextMenuItemStyle, width: "100%", opacity: busy && busy !== "auto-hide-empty" ? 0.55 : 1, color: autoHideEmptySubprojects ? "var(--text-dim)" : "var(--accent)" }}>
                  {autoHideEmptySubprojects ? <EyeOff size={14} /> : <Eye size={14} />}
                  <span>{t("sessionActivity.autoHideEmptySubprojects")}</span>
                </button>
              )}
              {(onHide || onUnhide || (canDelete && onDelete)) && (
                <div role="separator" aria-orientation="horizontal" style={{ height: 1, alignSelf: "stretch", margin: "3px 4px", background: "var(--border)" }} />
              )}
              {(onHide || onUnhide) && (
                <button className="reader-context-menu-item" type="button" role="menuitem" disabled={busy !== null} aria-busy={busy === "hide"} title={onUnhide ? undefined : t("sessionActivity.hideProjectHint")} onClick={() => void toggleHidden()} style={{ ...projectContextMenuItemStyle, width: "100%", opacity: busy && busy !== "hide" ? 0.55 : 1, color: onUnhide ? "var(--text-dim)" : "var(--accent)" }}>
                  {onUnhide ? <Eye size={14} /> : <EyeOff size={14} />}
                  <span>{onUnhide ? t("sessionActivity.unhideProject") : t("sessionActivity.hideProject")}</span>
                </button>
              )}
              {canDelete && onDelete && !hasSessions && (
                <button
                  className="reader-context-menu-item"
                  data-danger="true"
                  type="button"
                  role="menuitem"
                  disabled={busy !== null}
                  onClick={() => {
                    closeMenu();
                    if (onRequestDelete) {
                      onRequestDelete();
                    } else {
                      setConfirmDelete(true);
                    }
                  }}
                  style={{ ...projectContextMenuItemStyle, width: "100%", color: "#dc2626" }}
                >
                  <Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
                  <span>{t("sessionActivity.deleteProject")}</span>
                </button>
              )}
            </>
          )}
          {error && <div role="alert" style={{ padding: "5px 8px", color: "#dc2626", fontSize: 10, overflowWrap: "anywhere" }}>{error}</div>}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

interface FilterOption {
  value: string;
  label: React.ReactNode;
  kind?: "option" | "group";
}

export function SubprojectContextMenu({ subproject, onRenameRequest, onDeleteRequest, children }: {
  subproject: SubprojectDefinition;
  onRenameRequest: (subproject: SubprojectDefinition) => void;
  onDeleteRequest: (subproject: SubprojectDefinition) => void;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => {
    setPosition(null);
    setMenuPosition(null);
  }, []);
  const openMenu = useCallback((point: { x: number; y: number }) => {
    setMenuPosition(null);
    setPosition(point);
  }, []);
  const focusInitial = useCallback(() => {
    menuRef.current?.querySelector<HTMLElement>("[role=\"menuitem\"]")?.focus();
  }, []);
  const handleMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role=\"menuitem\"]") ?? [])]
      .filter((item) => !(item instanceof HTMLButtonElement && item.disabled));
    if (items.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : current < 0
          ? event.key === "ArrowUp" ? items.length - 1 : 0
          : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  }, [closeMenu]);

  useEffect(() => {
    if (!position) return;
    const frame = window.requestAnimationFrame(focusInitial);
    return () => window.cancelAnimationFrame(frame);
  }, [focusInitial, position]);

  const reposition = useCallback(() => {
    if (!position || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const next = clampFloatingMenuPosition(
      position,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setMenuPosition((current) => current?.left === next.left && current.top === next.top ? current : next);
  }, [position]);
  useLayoutEffect(() => {
    if (!position) {
      setMenuPosition(null);
      return;
    }
    const frame = window.requestAnimationFrame(reposition);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [position, reposition]);

  useEffect(() => {
    if (!position) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const closeOnContextMenu = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const closeOnFocusIn = (event: FocusEvent) => {
      if (event.target instanceof HTMLIFrameElement) closeMenu();
    };
    const closeOnWindowBlur = () => {
      if (document.activeElement instanceof HTMLIFrameElement || !document.hasFocus()) closeMenu();
    };
    const closeOnKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    document.addEventListener("pointerdown", closeOnPointerDown, true);
    document.addEventListener("contextmenu", closeOnContextMenu, true);
    document.addEventListener("focusin", closeOnFocusIn);
    document.addEventListener("keydown", closeOnKeyDown);
    window.addEventListener("blur", closeOnWindowBlur);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown, true);
      document.removeEventListener("contextmenu", closeOnContextMenu, true);
      document.removeEventListener("focusin", closeOnFocusIn);
      document.removeEventListener("keydown", closeOnKeyDown);
      window.removeEventListener("blur", closeOnWindowBlur);
    };
  }, [closeMenu, position]);

  const handleContextMenu = (event: React.MouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    window.getSelection()?.removeAllRanges();
    openMenu({ x: event.clientX, y: event.clientY });
  };
  const handleContextMenuKey = (event: React.KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.target instanceof Element ? event.target : event.currentTarget;
    const rect = target.getBoundingClientRect();
    openMenu({ x: rect.left + Math.min(24, rect.width), y: rect.bottom });
  };

  const menu = position && typeof document !== "undefined"
    ? createPortal(
      <div
        ref={menuRef}
        data-subproject-context-menu="true"
        role="menu"
        tabIndex={-1}
        aria-label={`${t("sessionActivity.subprojectActions")}: ${subproject.label}`}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={handleMenuKeyDown}
        style={{ ...projectContextMenuStyle, minWidth: 0, left: menuPosition?.left ?? -10000, top: menuPosition?.top ?? -10000, visibility: menuPosition ? "visible" : "hidden" }}
      >
        <button className="reader-context-menu-item" type="button" role="menuitem" onClick={() => { closeMenu(); onRenameRequest(subproject); }} style={{ ...projectContextMenuItemStyle, width: "100%" }}>
          <Pencil size={14} strokeWidth={1.8} aria-hidden="true" />
          <span>{t("sidebar.rename")}</span>
        </button>
        <div className="reader-context-menu-separator" role="separator" aria-orientation="horizontal" />
        <button className="reader-context-menu-item" data-danger="true" type="button" role="menuitem" onClick={() => { closeMenu(); onDeleteRequest(subproject); }} style={{ ...projectContextMenuItemStyle, width: "100%", color: "#dc2626" }}>
          <Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
          <span>{t("sidebar.delete")}</span>
        </button>
      </div>,
      document.body,
    )
    : null;

  return (
    <span ref={anchorRef} data-subproject-no-drag="true" style={{ display: "contents", userSelect: "none" }} onContextMenu={handleContextMenu} onKeyDown={handleContextMenuKey}>
      {children}
      {menu}
    </span>
  );
}


const ADD_DEVICE_VALUE = "__add_device__";
const HIDDEN_PAGE_VALUE = "__hidden_page__";
const FAVORITES_PAGE_VALUE = "__favorites_page__";
const TO_DISCUSS_PAGE_VALUE = "__to_discuss_page__";
const TO_REVISE_PAGE_VALUE = "__to_revise_page__";
const COMPLETED_PAGE_VALUE = "__completed_page__";
const HIDE_DEVICE_VALUE = "__hide_device__";

/** Codes returned by POST /api/peers, shown in the current UI language. */
const ADD_DEVICE_ERROR_KEYS: Record<string, string> = {
  peer_config_from_env: "sessionActivity.addDeviceConfigFromEnv",
  peer_url_required: "sessionActivity.addDeviceUrlRequired",
  peer_url_invalid: "sessionActivity.addDeviceUrlInvalid",
  peer_url_protocol: "sessionActivity.addDeviceUrlProtocol",
  peer_unreachable: "sessionActivity.addDeviceUnreachable",
  peer_is_local: "sessionActivity.addDeviceIsLocal",
  peer_exists: "sessionActivity.addDeviceExists",
};

function ActivityDeviceFilter({ value, devices, activityScope, onChange, showAddDevice = false, compact = false, hiddenView = false, favoriteView = false, toDiscussView = false, toReviseView = false, completedView = false, onOpenHidden, onOpenFavorites, onOpenToDiscuss, onOpenToRevise, onOpenCompleted, onHideDevice }: {
  value: string;
  devices: readonly SessionActivityDevice[];
  activityScope: ActivityScope;
  onChange: (value: string) => void;
  /** true 时下拉末尾出现「添加设备」入口（成功后事件刷新会自动带上新设备）。 */
  showAddDevice?: boolean;
  /** 隐藏/收藏页视图：下拉固定当前收纳项，选其他项退出当前页。 */
  hiddenView?: boolean;
  favoriteView?: boolean;
  toDiscussView?: boolean;
  toReviseView?: boolean;
  completedView?: boolean;
  /** 下拉选「隐藏页/收藏页/收纳分类」：外层切换数据域。 */
  onOpenHidden?: () => void;
  onOpenFavorites?: () => void;
  onOpenToDiscuss?: () => void;
  onOpenToRevise?: () => void;
  onOpenCompleted?: () => void;
  /** 下拉「隐藏设备…」弹层：隐藏所选设备（写入该设备自身）。 */
  onHideDevice?: (device: SessionActivityDevice) => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [addOpen, setAddOpen] = useState(false);
  const [addUrl, setAddUrl] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const addRef = useRef<HTMLDivElement | null>(null);
  const [hideOpen, setHideOpen] = useState(false);

  useEffect(() => {
    // 添加设备 / 隐藏设备 弹层共用容器 ref：点击容器外任一弹层都关闭
    //（隐藏设备弹层此前缺外部点击监听 → 点别处不消失）。
    if (!addOpen && !hideOpen) return;
    const onDown = (event: MouseEvent) => {
      if (addRef.current && !addRef.current.contains(event.target as Node)) {
        setAddOpen(false);
        setHideOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [addOpen, hideOpen]);

  const handleChange = (next: string) => {
    if (next === ADD_DEVICE_VALUE) {
      setAddOpen(true);
      return;
    }
    if (next === HIDE_DEVICE_VALUE) {
      setHideOpen((open) => !open);
      return;
    }
    if (next === HIDDEN_PAGE_VALUE) {
      if (!hiddenView) onOpenHidden?.();
      return;
    }
    if (next === FAVORITES_PAGE_VALUE) {
      if (!favoriteView) onOpenFavorites?.();
      return;
    }
    if (next === TO_DISCUSS_PAGE_VALUE) {
      if (!toDiscussView) onOpenToDiscuss?.();
      return;
    }
    if (next === TO_REVISE_PAGE_VALUE) {
      if (!toReviseView) onOpenToRevise?.();
      return;
    }
    if (next === COMPLETED_PAGE_VALUE) {
      if (!completedView) onOpenCompleted?.();
      return;
    }
    onChange(next);
  };

  const hiddenPageOption = {
    value: HIDDEN_PAGE_VALUE,
    label: (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <Archive size={12} strokeWidth={1.8} aria-hidden="true" />
        {t("sessionActivity.hiddenPage")}
      </span>
    ),
  };
  const favoritesPageOption = {
    value: FAVORITES_PAGE_VALUE,
    label: (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <Star size={12} strokeWidth={1.8} aria-hidden="true" />
        {t("sessionActivity.favoritesPage")}
      </span>
    ),
  };
  const toDiscussPageOption = {
    value: TO_DISCUSS_PAGE_VALUE,
    label: (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <MessageSquare size={12} strokeWidth={1.8} aria-hidden="true" />
        {t("sessionActivity.toDiscussPage")}
      </span>
    ),
  };
  const toRevisePageOption = {
    value: TO_REVISE_PAGE_VALUE,
    label: (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <Pencil size={12} strokeWidth={1.8} aria-hidden="true" />
        {t("sessionActivity.toRevisePage")}
      </span>
    ),
  };
  const completedPageOption = {
    value: COMPLETED_PAGE_VALUE,
    label: (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <Check size={12} strokeWidth={1.8} aria-hidden="true" />
        {t("sessionActivity.completedPage")}
      </span>
    ),
  };
  const hideDeviceOption = {
    value: HIDE_DEVICE_VALUE,
    label: (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <MonitorOff size={12} strokeWidth={1.8} aria-hidden="true" />
        {t("sessionActivity.hideDevice")}
      </span>
    ),
  };
  const collectionGroupOption = { value: "__group_collection__", kind: "group" as const, label: t("sessionActivity.collectionPageGroup") };
  const manageGroupOption = { value: "__group_manage__", kind: "group" as const, label: t("sessionActivity.deviceManageGroup") };
  const addDeviceOption = { value: ADD_DEVICE_VALUE, label: `+ ${t("sessionActivity.addDevice")}` };
  // 顺序由服务端按本机配置 order 字段给出（全部设备 → order 升序），
  // 这里直接按 devices 顺序展示，不再 reverse。
  const deviceOptions = devices.map((device) => ({ value: device.id, label: `${deviceLabel(device.name)}${device.online === false ? ` · ${t("sessionActivity.offline")}` : ""}` }));
  // 语义分组：隐藏页和收藏页都属于收纳；隐藏设备… = 管理动作（MonitorOff）。
  // 页面入口统一放在一个收纳分组下，避免把同一类内容拆成两个顶层分组。
  const collectionOptions = [
    ...(onOpenHidden ? [hiddenPageOption] : []),
    ...(onOpenFavorites ? [favoritesPageOption] : []),
    ...(onOpenToDiscuss ? [toDiscussPageOption] : []),
    ...(onOpenToRevise ? [toRevisePageOption] : []),
    ...(onOpenCompleted ? [completedPageOption] : []),
  ];
  const manageOptions = [...(showAddDevice ? [addDeviceOption] : []), ...(onHideDevice ? [hideDeviceOption] : [])];
  const options = [
    { value: "all", label: activityScope === "local" ? t("sessionActivity.currentDevice") : t("sessionActivity.allDevices") },
    ...deviceOptions,
    ...(collectionOptions.length > 0 ? [collectionGroupOption, ...collectionOptions] : []),
    ...(manageOptions.length > 0 ? [manageGroupOption, ...manageOptions] : []),
  ];

  const submitAdd = async () => {
    const url = addUrl.trim();
    if (!url || addBusy) return;
    setAddBusy(true);
    setAddError(null);
    try {
      const response = await fetch("/api/peers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const body = await response.json().catch(() => null) as { error?: string; code?: string } | null;
      const errorKey = body?.code ? ADD_DEVICE_ERROR_KEYS[body.code] : undefined;
      if (!response.ok || !body) throw new Error(errorKey ? t(errorKey) : body?.error || `HTTP ${response.status}`);
      setAddOpen(false);
      setAddUrl("");
    } catch (error) {
      setAddError(error instanceof Error ? error.message : String(error));
    } finally {
      setAddBusy(false);
    }
  };

  const select = (
    <div ref={addRef} style={{ position: "relative", minWidth: 0, width: "100%" }}>
      <FilterSelect
        value={value}
        onChange={handleChange}
        ariaLabel={t("sessionActivity.deviceSelector")}
        compact={compact}
        options={options}
      />
      {addOpen && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 520, width: 264, padding: 10, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,0.18)", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>{t("sessionActivity.addDevice")}</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("sessionActivity.addDeviceHint")}</div>
          <input
            autoFocus
            value={addUrl}
            onChange={(event) => setAddUrl(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void submitAdd(); if (event.key === "Escape") setAddOpen(false); }}
            placeholder={t("sessionActivity.addDevicePlaceholder")}
            style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 7, color: "var(--text)" }}
          />
          {addError && <div style={{ fontSize: 11, color: "#dc2626" }}>{addError}</div>}
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => setAddOpen(false)}
              disabled={addBusy}
              style={{ padding: "5px 12px", fontSize: 12, background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 7, color: "var(--text)", cursor: addBusy ? "default" : "pointer" }}
            >
              {t("sessionActivity.addDeviceCancel")}
            </button>
            <button
              type="button"
              onClick={() => void submitAdd()}
              disabled={addBusy || !addUrl.trim()}
              style={{ padding: "5px 12px", fontSize: 12, background: "var(--accent)", border: "none", borderRadius: 7, color: "#fff", cursor: addBusy || !addUrl.trim() ? "default" : "pointer", opacity: addBusy || !addUrl.trim() ? 0.6 : 1 }}
            >
              {addBusy ? t("sessionActivity.addDeviceBusy") : t("sessionActivity.addDeviceSubmit")}
            </button>
          </div>
        </div>
      )}
      {hideOpen && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 520, width: 264, padding: 10, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,0.18)", display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>{t("sessionActivity.hideDevice")}</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("sessionActivity.hideDeviceHint")}</div>
          {devices.map((device) => (
            <div key={device.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "4px 2px", fontSize: 12 }}>
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{deviceLabel(device.name)}{device.online === false ? ` · ${t("sessionActivity.offline")}` : ""}</span>
              <button
                type="button"
                onClick={() => { onHideDevice?.(device); setHideOpen(false); }}
                style={{ padding: "3px 9px", fontSize: 11, background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", cursor: "pointer", flexShrink: 0 }}
              >
                {t("sessionActivity.hide")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
  return select;
}

function FilterSelect({
  value,
  options,
  onChange,
  ariaLabel,
  title,
  compact = false,
}: {
  value: string;
  options: readonly FilterOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  title?: string;
  compact?: boolean;
}) {
  return (
    <ReaderFloatingSelect
      value={value}
      options={options}
      onChange={onChange}
      ariaLabel={ariaLabel}
      title={title}
      placement="below"
      align={compact ? "end" : "start"}
      containerStyle={compact
        ? { display: "block", flex: 1, minWidth: 0, width: "100%" }
        : { width: "max-content", maxWidth: 220 }}
      triggerStyle={compact
        ? { ...sidebarSelectStyle, display: "flex", justifyContent: "space-between", gap: 4, width: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
        : { ...selectStyle, display: "flex", justifyContent: "space-between", gap: 5, width: "max-content", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      menuMaxWidth="min(320px, calc(100vw - 16px))"
      optionFontSize={11}
      optionMinHeight={compact ? 24 : 26}
    />
  );
}

type ActivityProjectInfo = { key: string; projectKey: string; label: string; path: string; deviceId: string; deviceName: string; addedAt: string; saved: boolean; hasSessions: boolean; hidden?: boolean; isGit?: boolean };
type ActivityProjectEntry = readonly [string, ActivityProjectInfo];
type ActivityGroup = readonly [key: string, items: SessionActivityItem[], project?: ActivityProjectInfo];
type ActivityProjectBucket = { items: SessionActivityItem[]; subprojects: NonNullable<SessionActivityResponse["subprojects"]> };

function activityProjectFilterKey(projectKey: string, deviceId: string): string {
  return `${projectKey}\u0000${deviceId}`;
}

function projectInfoFromSession(item: SessionActivityItem): ActivityProjectInfo {
  return {
    key: activityProjectFilterKey(item.projectKey, item.device.id),
    projectKey: item.projectKey,
    label: item.projectLabel,
    path: item.session.projectRoot ?? item.session.cwd,
    deviceId: item.device.id,
    deviceName: deviceLabel(item.device.name),
    addedAt: item.lastActivityAt,
    saved: false,
    hasSessions: true,
    hidden: item.projectHidden,
    isGit: item.session.isGit,
  };
}

function buildProjectFilterOptions(
  projects: readonly ActivityProjectEntry[],
  devices: readonly SessionActivityDevice[],
  showDeviceGroups: boolean,
  allProjectsLabel: React.ReactNode,
  onContextMenu?: (info: ActivityProjectInfo, event: React.MouseEvent<HTMLButtonElement>) => void,
  onContextMenuKey?: (info: ActivityProjectInfo, event: React.KeyboardEvent<HTMLButtonElement>) => void,
): ReaderSelectOption[] {
  const allOption: ReaderSelectOption = { value: "__all_projects__", label: allProjectsLabel };
  if (!showDeviceGroups) {
    return [allOption, ...projects.map(([key, info]) => ({
      value: key,
      label: info.label,
      onContextMenu: onContextMenu ? (event: React.MouseEvent<HTMLButtonElement>) => onContextMenu(info, event) : undefined,
      onContextMenuKey: onContextMenuKey ? (event: React.KeyboardEvent<HTMLButtonElement>) => onContextMenuKey(info, event) : undefined,
    }))];
  }

  const byDevice = new Map<string, ActivityProjectEntry[]>();
  for (const entry of projects) {
    const deviceId = entry[1].deviceId;
    const group = byDevice.get(deviceId) ?? [];
    group.push(entry);
    byDevice.set(deviceId, group);
  }
  const deviceOrder = new Map(devices.map((device, index) => [device.id, index]));
  const groups = [...byDevice.entries()].sort(([left], [right]) => {
    const leftOrder = deviceOrder.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = deviceOrder.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder;
  });

  return [
    allOption,
    ...groups.flatMap(([deviceId, entries]) => [
      {
        value: `__project_device_group__${deviceId}`,
        label: entries[0]?.[1].deviceName ?? deviceId,
        kind: "group" as const,
      },
      ...entries.map(([key, info]) => ({
        value: key,
        label: info.label,
        onContextMenu: onContextMenu ? (event: React.MouseEvent<HTMLButtonElement>) => onContextMenu(info, event) : undefined,
        onContextMenuKey: onContextMenuKey ? (event: React.KeyboardEvent<HTMLButtonElement>) => onContextMenuKey(info, event) : undefined,
      })),
    ]),
  ];
}

function ActivityProjectFilter({
  values,
  projects,
  devices,
  label,
  onChange,
  onDeleteProject,
  onChangeVisibility,
  allowProjectHiding,
  subprojects,
  subprojectSortSettings,
  sessionItems = [],
  mutateSubprojects,
  refresh,
  allowEmptySubprojectActions,
  t,
  showDeviceGroups,
  onClose,
  compact = false,
}: {
  values: readonly string[];
  projects: readonly ActivityProjectEntry[];
  devices: readonly SessionActivityDevice[];
  label: React.ReactNode;
  onChange: (values: string[]) => void;
  onDeleteProject?: (info: ActivityProjectInfo) => void | Promise<void>;
  onChangeVisibility: (info: ActivityProjectInfo, hidden: boolean) => Promise<void>;
  allowProjectHiding: boolean;
  subprojects?: SessionActivityResponse["subprojects"];
  subprojectSortSettings?: SessionActivityResponse["subprojectSortSettings"];
  sessionItems?: SessionActivityItem[];
  mutateSubprojects?: SubprojectMutationFn;
  refresh?: SubprojectRefreshFn;
  allowEmptySubprojectActions: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
  showDeviceGroups: boolean;
  onClose: () => void;
  compact?: boolean;
}) {
  const [contextMenu, setContextMenu] = useState<{ info: ActivityProjectInfo; point: { x: number; y: number } } | null>(null);
  const setProjectContextMenu = useCallback((info: ActivityProjectInfo, point: { x: number; y: number }) => {
    announceReaderMenuOpen("project-context-menu");
    setContextMenu({ info, point });
  }, []);
  const openProjectContextMenu = useCallback((info: ActivityProjectInfo, event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setProjectContextMenu(info, { x: event.clientX, y: event.clientY });
  }, [setProjectContextMenu]);
  const openProjectContextMenuFromKeyboard = useCallback((info: ActivityProjectInfo, event: React.KeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setProjectContextMenu(info, { x: rect.left + Math.min(24, rect.width), y: rect.bottom });
  }, [setProjectContextMenu]);

  const contextSubprojects = contextMenu && subprojects
    ? subprojects.filter((subproject) => subproject.deviceId === contextMenu.info.deviceId && projectKeysMatch(subproject.projectKey, contextMenu.info.projectKey))
    : [];
  const contextItems = contextMenu
    ? sessionItems.filter((item) => item.device.id === contextMenu.info.deviceId && projectKeysMatch(item.projectKey, contextMenu.info.projectKey))
    : [];
  const contextSortSetting = contextMenu
    ? subprojectSortSettings?.find((setting) => setting.deviceId === contextMenu.info.deviceId && projectKeysMatch(setting.projectKey, contextMenu.info.projectKey))
    : undefined;

  return (
    <>
      <ReaderFloatingMultiSelect
        values={values}
        onChange={onChange}
        selectedLabel={label}
        onClose={onClose}
        allValue="__all_projects__"
        ariaLabel={t("sessionActivity.projectFilter")}
        placement="below"
        align={compact ? "end" : "start"}
        containerStyle={compact ? { display: "block", flex: 1, minWidth: 0, width: "100%" } : { width: "max-content", maxWidth: 320 }}
        triggerStyle={compact
          ? { ...sidebarSelectStyle, display: "flex", justifyContent: "space-between", gap: 4, width: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
          : { ...selectStyle, display: "flex", justifyContent: "space-between", gap: 5, width: "max-content", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        menuMaxWidth="min(320px, calc(100vw - 16px))"
        optionFontSize={11}
        optionMinHeight={compact ? 24 : 26}
        options={buildProjectFilterOptions(projects, devices, showDeviceGroups, t("sessionActivity.allProjects"), openProjectContextMenu, openProjectContextMenuFromKeyboard)}
        renderOption={(option) => <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{option.label}</span>}
      />
      {contextMenu && (
        <ProjectPathContextMenu
          path={contextMenu.info.path}
          deviceId={contextMenu.info.deviceId}
          canDelete={Boolean(contextMenu.info.saved && !contextMenu.info.hasSessions)}
          hasSessions={contextMenu.info.hasSessions}
          hasSubprojects={contextSubprojects.length > 0}
          autoHideEmptySubprojects={Boolean(contextSortSetting?.autoHideEmptySubprojects)}
          onDelete={onDeleteProject ? () => onDeleteProject(contextMenu.info) : undefined}
          onHide={allowProjectHiding && !contextMenu.info.hidden ? () => onChangeVisibility(contextMenu.info, true) : undefined}
          onUnhide={contextMenu.info.hidden ? () => onChangeVisibility(contextMenu.info, false) : undefined}
          onToggleAutoHideEmptySubprojects={allowEmptySubprojectActions && contextMenu && mutateSubprojects && refresh && contextSubprojects.length > 0 ? () => toggleAutoHideEmptySubprojects(contextMenu.info.projectKey, contextSortSetting, contextMenu.info.deviceId, mutateSubprojects, refresh) : undefined}
          subprojectAction={contextMenu && mutateSubprojects && contextSubprojects.length > 0 ? <ActivitySubprojectManager projectKey={contextMenu.info.projectKey} deviceId={contextMenu.info.deviceId} definitions={contextSubprojects} sortSetting={contextSortSetting} sessionItems={contextItems} sessionSort="recent" mutate={mutateSubprojects} /> : undefined}
          openAt={contextMenu.point}
          onOpenAtChange={(point) => {
            if (!point) setContextMenu(null);
          }}
          t={t}
          style={{ display: "none" }}
        >
          <span />
        </ProjectPathContextMenu>
      )}
    </>
  );
}

interface SessionActivityDataOptions {
  filters: SharedActivityFilters;
  activityScope: ActivityScope;
  viewedAtBySession: Record<string, number>;
  onViewedAtChange?: (viewedAt: Record<string, number>) => void;
  refreshKey?: number;
  /** Extra delayed refresh after refreshKey changes (panel uses 250ms). */
  refreshKeyRetryMs?: number;
  onOpenSession: (item: SessionActivityItem, searchTerm?: string, deviceFilter?: string) => void;
  onProjectCwdChange?: (cwd: string | null) => void;
  onProjectRemoved?: (path: string, deviceId: string) => void;
  onFilterChange: (patch: Partial<SharedActivityFilters>) => void;
  /** 当前打开中的会话（跳过其播报——打开页面的弹窗音已覆盖）。 */
  activeSessionKey?: string | null;
  activeSessionId?: string | null;
  /** 关闭聚合页等待音（嵌入页形态关闭，避免与外层跨源双播）。 */
  soundAlerts?: boolean;
  statusSoundOwner?: "chat" | "activity";
}

/**
 * Shared data/derivation/refresh logic for the activity panel and the
 * activity sidebar. Single implementation of the event-driven refresh,
 * project/device lists, filtering, grouping and known-project delete flow.
 */
function useSessionActivityData({
  filters,
  activityScope,
  viewedAtBySession,
  onViewedAtChange,
  refreshKey,
  activeSessionKey,
  activeSessionId,
  soundAlerts = true,
  statusSoundOwner = "chat",
  refreshKeyRetryMs,
  onOpenSession,
  onProjectCwdChange,
  onProjectRemoved,
  onFilterChange,
}: SessionActivityDataOptions) {
  const { locale, t } = useI18n();
  // 渲染期不调用 Date.now()（react-hooks/purity），相对时间/天筛选以状态
  // 下发、每 60s 节流刷新一次（列表有活动事件时会顺带重算，60s 只保证
  // 空闲窗口过期标签也会更新）。
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const [data, setData] = useState<SessionActivityResponse | null>(null);
  // 删除仍可乐观移除；归档/恢复等到服务端确认移动后再移除，失败时保留错误行。
  const [removedSessionIds, setRemovedSessionIds] = useState<Set<string>>(new Set());
  const markSessionRemoved = useCallback((sessionId: string) => {
    setRemovedSessionIds((previous) => {
      if (previous.has(sessionId)) return previous;
      const next = new Set(previous);
      next.add(sessionId);
      return next;
    });
  }, []);
  const unmarkSessionRemoved = useCallback((sessionId: string) => {
    setRemovedSessionIds((previous) => {
      if (!previous.has(sessionId)) return previous;
      const next = new Set(previous);
      next.delete(sessionId);
      return next;
    });
  }, []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshInFlightRef = useRef<string | null>(null);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const projectFilterDirtyRef = useRef(false);
  const activityEventTimerRef = useRef<number | null>(null);
  const activityRevisionRef = useRef(0);
  const activityCursorRef = useRef(new Map<string, { bootId: string; seq: number }>());
  const activityDataRef = useRef<SessionActivityResponse | null>(null);
  const prevStateKeysRef = useRef<Set<string> | null>(null);
  const pendingActivityEventsRef = useRef<SessionActivityEventPayload[]>([]);
  const soundAlertsRef = useRef(soundAlerts);
  const activeSessionKeyRef = useRef(activeSessionKey);
  const activeSessionIdRef = useRef(activeSessionId);
  activityDataRef.current = data;
  soundAlertsRef.current = soundAlerts;
  activeSessionKeyRef.current = activeSessionKey;
  activeSessionIdRef.current = activeSessionId;
  // 请求状态键（scope|archived）：fetch 完成时对比，过期响应（scope 已切换）
  // 直接丢弃，避免旧 scope 数据覆盖新视图（“先显示别的东西再闪现消失”）。
  const stateKeyRef = useRef<string>(`${activityScope}|${filters.archiveView}`);
  useEffect(() => {
    stateKeyRef.current = `${activityScope}|${filters.archiveView}`;
    setRemovedSessionIds(new Set());
  }, [activityScope, filters.archiveView]);

  const refresh = useCallback(async (bustDevice?: string, waitForCurrent = false, force = false) => {
    const stateKey = `${activityScope}|${filters.archiveView}`;
    const eventRevisionAtRequest = activityRevisionRef.current;
    // 同 scope 的并发刷新合并；变更操作等待旧响应结束后再取一次，避免旧数据覆盖新标记。
    if (refreshInFlightRef.current === stateKey) {
      if (!waitForCurrent || !refreshPromiseRef.current) return;
      await refreshPromiseRef.current;
    }
    refreshInFlightRef.current = stateKey;
    const request = (async () => {
      try {
        const query = filters.archiveView === "archived" ? "&archived=1" : "";
        // hidden 与正常聚合使用同一 archiveView 行为；区别只有数据 scope。
        // 事件驱动刷新带 &refresh=<deviceId>：只绕过变更设备的 peer TTL，
        // 其余 peer 走缓存，避免每次事件都等待所有 peer 重建列表。
        const bust = bustDevice ? `&refresh=${encodeURIComponent(bustDevice)}` : "";
        const forceQuery = force ? "&force=1" : "";
        const body = await fetchSessionActivity<SessionActivityResponse>(
          `/api/session-runs?scope=${activityScope}${query}${bust}${forceQuery}`,
          { force: force || Boolean(bustDevice) },
        );
        if (!body || !("sessions" in body)) throw new Error("Invalid session activity response");
        // 过期响应丢弃：请求期间 scope/归档视图已切换的旧数据不上屏。
        if (stateKeyRef.current !== stateKey) return;
        // SSE 已经先行投影过的事件不能被请求开始前的旧快照覆盖。
        // 事件触发的 waitForCurrent 刷新会在旧请求结束后再取一次。
        if (eventRevisionAtRequest !== activityRevisionRef.current) return;
        setData(body);
        if (body.sessions) registerSessionLineage(body.sessions);
        if (body.viewedAt) onViewedAtChange?.(body.viewedAt);
        setError(null);
      } catch (nextError) {
        if (stateKeyRef.current !== stateKey) return;
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      } finally {
        if (refreshInFlightRef.current === stateKey) {
          refreshInFlightRef.current = null;
          refreshPromiseRef.current = null;
        }
        setLoading(false);
      }
    })();
    refreshPromiseRef.current = request;
    await request;
  }, [activityScope, filters.archiveView, onViewedAtChange]);

  useEffect(() => {
    // 首次挂载 / archiveView 或 activityScope 变化（refresh 身份重建）→ 带 bust
    // 强制绕过 peer 4s TTL，删除/归档/切换归档视图立即反映。
    prevStateKeysRef.current = null;
    pendingActivityEventsRef.current = [];
    // 切换时清掉旧会话，保留已知设备 roster：归档请求可能比活动请求慢，
    // 不能因为中间 loading 把设备筛选器退化成“全部设备”。
    const previous = activityDataRef.current;
    if (previous) {
      setData({
        ...previous,
        scope: activityScope,
        sessions: [],
        knownProjects: [],
        subprojects: [],
        subprojectSortSettings: [],
      });
    }
    setLoading(true);
    void refresh();
    const refreshWhenVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    const refreshOnFocus = () => void refresh();
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [refresh, activityScope]);

  useEffect(() => {
    const handleKnownProjectsChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ deviceId?: unknown }>).detail;
      const deviceId = typeof detail?.deviceId === "string" ? detail.deviceId : activityDataRef.current?.device.id;
      void refresh(deviceId, true);
    };
    window.addEventListener("pi-known-projects-changed", handleKnownProjectsChanged);
    return () => window.removeEventListener("pi-known-projects-changed", handleKnownProjectsChanged);
  }, [refresh]);

  // SSE is the fast path. Keep a low-frequency visible-tab snapshot fallback
  // so a silently half-open stream cannot leave archive/remove state stale.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  // 即时事件通道（/api/activity/events SSE）：本机 + peer 的 run/session 事件
  // 事件到达先更新内存状态并触发声音；快照只做后台校准。peer 连接状态变化
  // 也先原地更新 online/offline，再定向刷新。SSE 重连和 15s 快照覆盖进程重启、
  // 新建空会话和事件缓冲丢失。
  const { playWaitSound, playErrorSound, playDoneSound, canPlaySound } = useAudio();
  const playActivityTerminalEvent = useCallback((liveEvent: SessionActivityEventPayload, queuedDuringInitialLoad = false) => {
    if (
      !soundAlertsRef.current
      || typeof liveEvent.sessionId !== "string"
      || typeof liveEvent.runId !== "string"
      || !isTerminalSessionRunStatus(liveEvent.status)
    ) return;
    // Replay events are silent on the first snapshot; a prior state or a live
    // event received during the initial fetch is required before alerting.
    if (liveEvent.replay && prevStateKeysRef.current === null) return;
    const currentItem = activityDataRef.current?.sessions.find((item) => (
      item.session.id === liveEvent.sessionId
      && (!liveEvent.device || item.device.id === liveEvent.device)
    ));
    // Subagent completions are represented in Activity for visibility, but
    // never claim the user's wait/error/done sound channel.
    if (currentItem?.session.relation?.kind === "subagent") return;
    const sameLatestRun = currentItem?.latestRun?.runId === liveEvent.runId;
    const wasRunning = queuedDuringInitialLoad
      ? sameLatestRun
      : Boolean(
        sameLatestRun
        && (
          currentItem?.latestRun?.status === "running"
          || prevStateKeysRef.current?.has(`${liveEvent.runId}:running`)
        ),
      );
    const isActive = currentItem
      ? activeSessionKeyRef.current
        ? itemKey(currentItem) === activeSessionKeyRef.current
        : currentItem.session.id === activeSessionIdRef.current
      : false;
    const unattended = liveEvent.unattended ?? currentItem?.unattended;
    if (!currentItem || !wasRunning || (isActive && statusSoundOwner !== "activity")) return;
    if (unattended && (liveEvent.status === "failed" || liveEvent.status === "aborted")) return;
    const kind = liveEvent.status === "completed" ? "done" : "error";
    const soundKey = statusSoundRequestId(liveEvent.sessionId, kind, liveEvent.runId);
    if (!soundKey) return;
    tryPlaySoundRequest(soundKey, kind === "done" ? playDoneSound : playErrorSound, () => canPlaySound(kind));
  }, [canPlaySound, playDoneSound, playErrorSound, statusSoundOwner]);

  useEffect(() => {
    const source = openReaderEventSource(["activity", "peer_state", "activity_meta"]);
    const scheduleRefresh = (device?: string) => {
      if (activityEventTimerRef.current !== null) return;
      activityEventTimerRef.current = window.setTimeout(() => {
        activityEventTimerRef.current = null;
        void refresh(device, true);
      }, 0);
    };
    source.onopen = () => { void refresh(); };
    source.onmessage = (event: MessageEvent<string>) => {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(event.data) as Record<string, unknown> | null;
      } catch {
        return;
      }
      if (parsed?.type === "activity_meta" && parsed.reset === true) {
        const resetDevice = typeof parsed.device === "string" ? parsed.device : undefined;
        if (resetDevice) activityCursorRef.current.delete(resetDevice);
        else activityCursorRef.current.clear();
        activityRevisionRef.current += 1;
        scheduleRefresh(resetDevice);
        return;
      }
      if (parsed?.type !== "activity" && parsed?.type !== "peer_state") return;
      const device = typeof parsed.device === "string" ? parsed.device : undefined;
      if (parsed.type === "activity") {
        const bootId = typeof parsed.bootId === "string" ? parsed.bootId : undefined;
        const seq = typeof parsed.seq === "number" && Number.isFinite(parsed.seq) ? parsed.seq : undefined;
        if (device && bootId && seq !== undefined) {
          const previous = activityCursorRef.current.get(device);
          if (previous?.bootId === bootId && seq <= previous.seq) return;
          activityCursorRef.current.set(device, { bootId, seq });
        }
        const liveEvent = {
          ...parsed,
          type: "activity" as const,
          ...(device ? { device } : {}),
        } as SessionActivityEventPayload;
        activityRevisionRef.current += 1;
        setData((previous) => {
          if (!previous) return previous;
          const result = applySessionActivityEvent(previous, liveEvent);
          return result.changed ? result.response : previous;
        });

        // The event itself is the completion signal. Queue terminal events that
        // arrive before the first snapshot so the old running state can be
        // reconciled instead of silently dropping the sound decision.
        if (isTerminalSessionRunStatus(liveEvent.status)) {
          const currentItem = activityDataRef.current?.sessions.find((item) => (
            item.session.id === liveEvent.sessionId
            && (!liveEvent.device || item.device.id === liveEvent.device)
          ));
          if (!currentItem || currentItem.latestRun?.runId !== liveEvent.runId) {
            pendingActivityEventsRef.current = [
              ...pendingActivityEventsRef.current,
              liveEvent,
            ].slice(-64);
          } else {
            playActivityTerminalEvent(liveEvent);
          }
        }
      } else {
        const peerEvent = {
          type: "peer_state" as const,
          ...(device ? { device } : {}),
          ...(typeof parsed.online === "boolean" ? { online: parsed.online } : {}),
        } as SessionActivityPeerStatePayload;
        activityRevisionRef.current += 1;
        setData((previous) => {
          if (!previous) return previous;
          const result = applySessionActivityPeerState(previous, peerEvent);
          return result.changed ? result.response : previous;
        });
      }
      scheduleRefresh(device);
    };
    return () => {
      source.close();
      if (activityEventTimerRef.current !== null) {
        window.clearTimeout(activityEventTimerRef.current);
        activityEventTimerRef.current = null;
      }
    };
  }, [playActivityTerminalEvent, refresh]);

  useEffect(() => {
    if (!data || pendingActivityEventsRef.current.length === 0) return;
    const pending = pendingActivityEventsRef.current;
    pendingActivityEventsRef.current = [];
    for (const event of pending) {
      playActivityTerminalEvent(event, true);
    }
  }, [data, playActivityTerminalEvent]);

  useEffect(() => {
    if (refreshKey === undefined) return;
    // 变更（删除/归档等）后立即刷新：强制绕过 activity 缓存即时下发
    clearSessionActivityCache();
    void refresh(undefined, false, true);
    if (refreshKeyRetryMs === undefined) return;
    const retry = window.setTimeout(() => void refresh(undefined, false, true), refreshKeyRetryMs);
    return () => window.clearTimeout(retry);
  }, [refresh, refreshKey, refreshKeyRetryMs]);

  // 快照/乐观投影的状态变化仍保留这层去重：它覆盖首屏快照、SSE 重连和
  // 页面从隐藏恢复等无法直接归因于某一个 live event 的情况。
  useEffect(() => {
    if (!soundAlerts || !data) return;
    const next = new Set<string>();
    for (const item of data.sessions ?? []) {
      const runId = item.latestRun?.runId;
      const requestId = item.waitingRequestIds?.[0];
      if (item.status === "waiting_user" ? !requestId : !runId) continue;
      // 状态记录先于跳过：iframe 内（正在看的）会话也要记账，否则跳出会话后
      // 外层第一次看到该会话状态会误判为「新转换」而补播三种状态音。
      const key = item.status === "waiting_user" ? waitSoundRequestId(requestId) : `${runId}:${item.status}`;
      next.add(key);
      if (item.session.relation?.kind === "subagent") continue;
      const isFocusedSession = activeSessionKey ? itemKey(item) === activeSessionKey : item.session.id === activeSessionId;
      if (isFocusedSession && statusSoundOwner !== "activity") continue;
      if (prevStateKeysRef.current === null) continue;
      if (prevStateKeysRef.current.has(key)) continue;
      if (item.status === "waiting_user") {
        // The same pending request uses the same fact ID in every surface.
        tryPlaySoundRequest(waitSoundRequestId(requestId), playWaitSound, () => canPlaySound("wait"));
      } else if (item.status === "failed" || item.status === "aborted") {
        // 无人值守会话失败静音（错误仍显示在界面，完成/等待音照常）。
        if (item.unattended) continue;
        tryPlaySoundRequest(statusSoundRequestId(item.session.id, "error", runId), playErrorSound, () => canPlaySound("error"));
      } else if (item.status === "just_completed") {
        tryPlaySoundRequest(statusSoundRequestId(item.session.id, "done", runId), playDoneSound, () => canPlaySound("done"));
      }
    }
    prevStateKeysRef.current = next;
  }, [data, soundAlerts, activeSessionKey, activeSessionId, statusSoundOwner, playWaitSound, playErrorSound, playDoneSound, canPlaySound]);

  const devices = useMemo(() => {
    const values = new Map<string, SessionActivityDevice>();
    for (const device of data?.devices ?? []) values.set(device.id, device);
    for (const item of data?.sessions ?? []) values.set(item.device.id, item.device);
    // 顺序由服务端按本机配置的 order 字段给出（全部设备 → order 升序），
    // 客户端保持该顺序，不再按名称字典序重排。
    return [...values.values()];
  }, [data]);

  // 隐藏页视图：被隐藏的设备对象（下拉/区块渲染 + 取消隐藏）。
  const hiddenDevices = useMemo(() => {
    const ids = new Set(data?.hidden?.devices ?? []);
    if (ids.size === 0) return [];
    return devices.filter((device) => ids.has(device.id));
  }, [data, devices]);

  // 隐藏/取消隐藏（数据所属设备模型）：本机数据直写 /api/hidden；异设备数据经
  // /api/remote/hidden?peer= 代理写回数据所属设备（隐藏清单在源端过滤，三处生效）。
  const setHidden = useCallback(async (kind: HiddenKind, id: string, hidden: boolean, deviceId?: string) => {
    const isLocal = !deviceId || deviceId === data?.device.id;
    const base = isLocal ? "/api/hidden" : `/api/remote/hidden?peer=${encodeURIComponent(deviceId)}`;
    let ok = false;
    try {
      if (hidden) {
        const response = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, id }),
        });
        ok = response.ok;
      } else {
        const response = await fetch(`${base}${isLocal ? "?" : "&"}kind=${kind}&id=${encodeURIComponent(id)}`, { method: "DELETE" });
        ok = response.ok;
      }
    } catch {
      ok = false;
    }
    if (ok) await refresh(deviceId, true); // 变更操作等旧聚合响应结束后再取一次，避免旧数据覆盖新状态。
    return ok;
  }, [data, refresh]);

  const changeProjectVisibility = useCallback(async (project: ActivityProjectInfo, hidden: boolean) => {
    if (!await setHidden("project", project.projectKey, hidden, project.deviceId)) {
      throw new Error(t("sessionActivity.projectVisibilityFailed"));
    }
  }, [setHidden, t]);

  const setFavorite = useCallback(async (sessionId: string, favorite: boolean, deviceId?: string) => {
    const isLocal = !deviceId || deviceId === data?.device.id;
    const base = isLocal ? "/api/favorites" : `/api/remote/favorites?peer=${encodeURIComponent(deviceId)}`;
    let ok = false;
    try {
      if (favorite) {
        const response = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "session", id: sessionId }),
        });
        ok = response.ok;
      } else {
        const response = await fetch(`${base}${isLocal ? "?" : "&"}kind=session&id=${encodeURIComponent(sessionId)}`, { method: "DELETE" });
        ok = response.ok;
      }
    } catch {
      ok = false;
    }
    if (ok) await refresh(deviceId, true);
    return ok;
  }, [data, refresh]);

  const setCategory = useCallback(async (sessionId: string, category: SessionStorageCategory | null, deviceId?: string) => {
    const isLocal = !deviceId || deviceId === data?.device.id;
    const base = isLocal ? "/api/session-categories" : `/api/remote/session-categories?peer=${encodeURIComponent(deviceId)}`;
    let ok = false;
    try {
      if (category !== null) {
        const response = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "session", id: sessionId, category }),
        });
        ok = response.ok;
      } else {
        const response = await fetch(`${base}${isLocal ? "?" : "&"}kind=session&id=${encodeURIComponent(sessionId)}`, { method: "DELETE" });
        ok = response.ok;
      }
    } catch {
      ok = false;
    }
    if (ok) await refresh(deviceId, true);
    return ok;
  }, [data, refresh]);

  const projects = useMemo(() => {
    const deviceNames = new Map(devices.map((device) => [device.id, deviceLabel(device.name)]));
    const values = new Map<string, ActivityProjectInfo>();
    for (const item of data?.sessions ?? []) {
      if (!matchesActivityDevice(item.device.id, filters.device, activityScope)) continue;
      values.set(activityProjectFilterKey(item.projectKey, item.device.id), projectInfoFromSession(item));
    }
    for (const entry of data?.knownProjects ?? []) {
      if (!matchesActivityDevice(entry.deviceId, filters.device, activityScope)) continue;
      const matching = [...values.entries()].find(([, candidate]) => candidate.deviceId === entry.deviceId && projectKeysMatch(candidate.projectKey, entry.key));
      const key = matching?.[0] ?? activityProjectFilterKey(entry.key, entry.deviceId);
      const existing = matching?.[1];
      values.set(key, {
        key,
        projectKey: entry.key,
        label: entry.label,
        path: entry.path,
        deviceId: entry.deviceId,
        deviceName: deviceNames.get(entry.deviceId) ?? existing?.deviceName ?? entry.deviceId,
        addedAt: entry.addedAt,
        saved: true,
        hasSessions: existing?.hasSessions ?? false,
        hidden: entry.hidden ?? existing?.hidden,
        isGit: existing?.isGit ?? entry.isGit,
      });
    }
    return [...values.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label));
  }, [activityScope, data, devices, filters.device]);

  useEffect(() => {
    // A collection scope can remove projects that remain in shared filters.
    // Reconcile only after matching-scope data arrives, so a scope switch does
    // not clear a valid selection while its replacement snapshot is loading.
    if (!data || data.scope !== activityScope || filters.project.length === 0) return;
    const next = filters.project.filter((value) => projects.some(([key, info]) => key === value || projectKeysMatch(value, info.projectKey)));
    if (next.length !== filters.project.length) onFilterChange({ project: next });
  }, [activityScope, data, filters.project, onFilterChange, projects]);

  const projectBuckets = useMemo(() => {
    const allItems = data?.sessions ?? [];
    const allSubprojects = data?.subprojects ?? [];
    const buckets = new Map<string, ActivityProjectBucket>();
    for (const [key, info] of projects) {
      buckets.set(key, {
        items: allItems.filter((item) => item.device.id === info.deviceId && projectKeysMatch(item.projectKey, info.projectKey)),
        subprojects: allSubprojects.filter((subproject) => subproject.deviceId === info.deviceId && projectKeysMatch(subproject.projectKey, info.projectKey)),
      });
    }
    return buckets;
  }, [data, projects]);

  const timeFiltered = useMemo(() => {
    return (data?.sessions ?? [])
      .map((item) => ({ ...item, status: effectiveStatus(item, viewedAtBySession) }))
      .filter((item) => matchesActivityDevice(item.device.id, filters.device, activityScope))
      .filter((item) => isWithinActivityTimeRange(item.lastActivityAt, filters.days, nowMs));
  }, [activityScope, data, filters.days, filters.device, nowMs, viewedAtBySession]);

  const filtered = useMemo(() => {
    return timeFiltered
      .filter((item) => {
        const filterKey = activityProjectFilterKey(item.projectKey, item.device.id);
        if (filters.project.length > 0 && !filters.project.includes(filterKey) && !filters.project.includes(item.projectKey)) return false;
        if (filters.status !== "all" && item.status !== filters.status) return false;
        return true;
      })
      .filter((item) => !removedSessionIds.has(item.session.id))
      .sort((a, b) => compareBySort(a, b, filters.sort));
  }, [filters.project, filters.sort, filters.status, removedSessionIds, timeFiltered]);

  const groups = useMemo<ActivityGroup[]>(() => {
    if (filters.group === "none") return [["", filtered]];
    const grouped = new Map<string, SessionActivityItem[]>();
    for (const item of filtered) {
      const key = (filters.group === "project" || filters.group === "worktree") ? `${item.projectKey}:${item.device.id}` : item.device.id;
      const current = grouped.get(key) ?? [];
      current.push(item);
      grouped.set(key, current);
    }
    if ((filters.group === "project" || filters.group === "worktree")) {
      for (const [filterKey, info] of projects) {
        if (filters.project.length > 0 && !filters.project.includes(filterKey) && !filters.project.includes(info.projectKey)) continue;
        const key = `${info.projectKey}:${info.deviceId}`;
        if (!grouped.has(key)) grouped.set(key, []);
      }
    }
    return [...grouped.entries()].map(([key, items]) => {
      const project = (filters.group === "project" || filters.group === "worktree")
        ? items.length > 0
          ? projects.find(([, info]) => info.deviceId === items[0]?.device.id && projectKeysMatch(info.projectKey, items[0]?.projectKey))?.[1]
          : projects.find(([, info]) => `${info.projectKey}:${info.deviceId}` === key)?.[1]
        : undefined;
      return [`${filters.group}:${key}`, items, project];
    });
  }, [filtered, filters.group, filters.project, projects]);

  const showProjectDeviceGroups = activityScope === "all" && filters.device === "all";

  const projectFilterLabel = filters.project.length === 0
    ? t("sessionActivity.allProjects")
    : filters.project.length === 1
      ? (() => { const info = projects.find(([key, candidate]) => key === filters.project[0] || candidate.projectKey === filters.project[0])?.[1]; return info?.label ?? filters.project[0]; })()
      : t("sessionActivity.selectedProjects", { count: filters.project.length });

  const formatTime = (value: string): string => {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return "-";
    const deltaSeconds = Math.round((nowMs - timestamp) / 1000);
    if (deltaSeconds < 0) {
      // Server refreshes can outrun the client's throttled clock; future is not an ETA.
      return new Intl.RelativeTimeFormat(locale === "zh-CN" ? "zh-CN" : "en", { numeric: "auto" }).format(0, "second");
    }
    const amount = Math.max(1, deltaSeconds);
    const direction = -1;
    const relative = new Intl.RelativeTimeFormat(locale === "zh-CN" ? "zh-CN" : "en", { numeric: "always" });
    if (amount < 60) return relative.format(direction * amount, "second");
    const minutes = Math.round(amount / 60);
    if (minutes < 60) return relative.format(direction * minutes, "minute");
    const hours = Math.round(minutes / 60);
    if (hours < 24) return relative.format(direction * hours, "hour");
    const days = Math.round(hours / 24);
    if (days < 7) return relative.format(direction * days, "day");
    return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en", { year: "numeric", month: "2-digit", day: "2-digit" }).format(timestamp);
  };

  const formatDuration = (run: SessionRunRecord | null): string | null => duration(run, nowMs);

  const statusLabel = (status: SessionActivityStatus): string => t(`sessionActivity.status.${status}`);

  const handleDeleteKnownProject = useCallback(async (info: ActivityProjectInfo) => {
    const isLocal = info.deviceId === data?.device.id;
    const endpoint = isLocal ? "/api/projects" : `/api/remote/projects?peer=${encodeURIComponent(info.deviceId)}`;
    const res = await fetch(endpoint, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: info.path }),
    });
    const payload = await res.json().catch(() => null) as { code?: unknown } | null;
    if (!res.ok) {
      if (payload?.code === "project_has_subprojects") throw new Error(t("sessionActivity.projectHasSubprojects"));
      throw new Error(t("sessionActivity.projectPathActionFailed"));
    }
    activityRevisionRef.current += 1;
    setData((prev) => prev ? { ...prev, knownProjects: (prev.knownProjects ?? []).filter((entry) => entry.deviceId !== info.deviceId || entry.path !== info.path) } : prev);
    if (filters.project.includes(info.key) || filters.project.includes(info.projectKey)) {
      onFilterChange({ project: filters.project.filter((key) => key !== info.key && key !== info.projectKey) });
    }
    onProjectRemoved?.(info.path, info.deviceId);
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("pi-known-projects-changed", { detail: { path: info.path, deviceId: info.deviceId } }));
  }, [data?.device.id, filters.project, onFilterChange, onProjectRemoved, t]);

  const openActivitySession = useCallback((item: SessionActivityItem, searchTerm?: string) => {
    onOpenSession(item, searchTerm);
  }, [onOpenSession]);

  const focusFirstProjectSession = useCallback(() => {
    if (filters.project.length === 0) return;
    const first = filtered[0];
    if (first) {
      openActivitySession(first);
      return;
    }
    if (filters.project.length === 1) {
      const info = projects.find(([key, candidate]) => key === filters.project[0] || candidate.projectKey === filters.project[0])?.[1];
      if (!info || info.deviceId !== data?.device.id) return;
      onProjectCwdChange?.(info.path);
    }
  }, [data?.device.id, filtered, filters.project, openActivitySession, onProjectCwdChange, projects]);

  const handleProjectFilterChange = useCallback((project: string[]) => {
    projectFilterDirtyRef.current = true;
    onFilterChange({ project });
  }, [onFilterChange]);

  const handleProjectFilterClose = useCallback(() => {
    if (!projectFilterDirtyRef.current) return;
    projectFilterDirtyRef.current = false;
    focusFirstProjectSession();
  }, [focusFirstProjectSession]);

  const mutateSubprojects = useCallback(async (deviceId: string, method: SubprojectMutationMethod, body: Record<string, unknown>, options: SubprojectMutationOptions = {}): Promise<{ ok: boolean; message?: string }> => {
    const local = deviceId === data?.device.id;
    const endpoint = local
      ? "/api/subprojects"
      : `/api/remote/subprojects?peer=${encodeURIComponent(deviceId)}`;
    const previousSortSettings = data?.subprojectSortSettings;
    const optimisticSetting: SessionActivitySubprojectSortSetting | null = options.optimistic && method === "PUT" && typeof body.projectKey === "string"
      ? {
          projectKey: body.projectKey,
          mode: (body.mode as SubprojectSortMode) ?? "custom",
          order: Array.isArray(body.order) ? (body.order as string[]) : [],
          deviceId,
          ...(typeof body.autoHideEmptySubprojects === "boolean" ? { autoHideEmptySubprojects: body.autoHideEmptySubprojects } : {}),
        }
      : null;

    if (optimisticSetting) {
      activityRevisionRef.current += 1;
      setData((previous) => {
        if (!previous) return previous;
        const settings = previous.subprojectSortSettings ?? [];
        const matches = (setting: typeof optimisticSetting) => setting.deviceId === deviceId && projectKeysMatch(setting.projectKey, optimisticSetting.projectKey);
        const nextSettings = settings.some(matches)
          ? settings.map((setting) => matches(setting) ? { ...setting, ...optimisticSetting } : setting)
          : [...settings, optimisticSetting];
        return { ...previous, subprojectSortSettings: nextSettings };
      });
      if (typeof window !== "undefined") window.dispatchEvent(new Event("pi-subprojects-changed"));
    }

    try {
      const response = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null) as { error?: unknown; sortSetting?: SubprojectSortSetting } | null;
      if (!response.ok) {
        if (optimisticSetting && previousSortSettings) {
          setData((previous) => previous ? { ...previous, subprojectSortSettings: previousSortSettings } : previous);
          if (typeof window !== "undefined") window.dispatchEvent(new Event("pi-subprojects-changed"));
        }
        return { ok: false, message: typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}` };
      }
      if (options.optimistic && method === "PUT" && payload?.sortSetting) {
        const nextSetting = { ...payload.sortSetting, deviceId };
        activityRevisionRef.current += 1;
        setData((previous) => {
          if (!previous) return previous;
          const settings = previous.subprojectSortSettings ?? [];
          const matches = (setting: typeof nextSetting) => setting.deviceId === deviceId && projectKeysMatch(setting.projectKey, nextSetting.projectKey);
          const nextSettings = settings.some(matches)
            ? settings.map((setting) => matches(setting) ? nextSetting : setting)
            : [...settings, nextSetting];
          return { ...previous, subprojectSortSettings: nextSettings };
        });
      }
      if (options.refresh !== false) {
        const pendingRefresh = refresh(deviceId, true);
        if (options.optimistic) void pendingRefresh;
        else await pendingRefresh;
        if (typeof window !== "undefined") window.dispatchEvent(new Event("pi-subprojects-changed"));
      }
      return { ok: true };
    } catch (error) {
      if (optimisticSetting && previousSortSettings) {
        setData((previous) => previous ? { ...previous, subprojectSortSettings: previousSortSettings } : previous);
        if (typeof window !== "undefined") window.dispatchEvent(new Event("pi-subprojects-changed"));
      }
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }, [data?.device.id, data?.subprojectSortSettings, refresh]);

  const moveSessionToSubproject = useCallback(async (item: SessionActivityItem, subprojectId: string | null): Promise<boolean> => {
    if (item.session.transient || !item.projectKey || item.device.online === false) return false;
    const previousSubprojectId = item.session.subprojectId;
    const applyAssignment = (nextSubprojectId: string | undefined, onlyIf?: string, guard = false) => {
      activityRevisionRef.current += 1;
      setData((previous) => {
        if (!previous) return previous;
        let changed = false;
        const sessions = previous.sessions.map((candidate) => {
          if (candidate.session.id !== item.session.id || candidate.device.id !== item.device.id) return candidate;
          if (guard && candidate.session.subprojectId !== onlyIf) return candidate;
          if (candidate.session.subprojectId === nextSubprojectId) return candidate;
          changed = true;
          return { ...candidate, session: { ...candidate.session, subprojectId: nextSubprojectId } };
        });
        return changed ? { ...previous, sessions } : previous;
      });
    };
    const optimisticSubprojectId = subprojectId ?? undefined;
    // PATCH is authoritative; show local bucket change immediately and reconcile in background.
    applyAssignment(optimisticSubprojectId);
    const local = item.device.id === data?.device.id;
    const endpoint = local
      ? `/api/sessions/${encodeURIComponent(item.session.id)}/subproject`
      : `/api/remote/sessions/${encodeURIComponent(item.session.id)}/subproject?peer=${encodeURIComponent(item.device.id)}`;
    try {
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectKey: item.projectKey, subprojectId }),
      });
      if (!response.ok) {
        applyAssignment(previousSubprojectId, optimisticSubprojectId, true);
        return false;
      }
      void refresh(item.device.id, true, true);
      return true;
    } catch {
      applyAssignment(previousSubprojectId, optimisticSubprojectId, true);
      return false;
    }
  }, [data?.device.id, refresh]);

  return {
    data, loading, error, refresh, devices, projects, timeFiltered, filtered, groups,
    showProjectDeviceGroups, projectFilterLabel, formatTime, formatDuration, statusLabel,
    handleDeleteKnownProject,
    projectBuckets,
    openActivitySession, focusFirstProjectSession, handleProjectFilterChange,
    handleProjectFilterClose,
    changeProjectVisibility,
    hiddenDevices, setHidden, setFavorite, setCategory, markSessionRemoved, unmarkSessionRemoved, moveSessionToSubproject, mutateSubprojects,
    subprojects: data?.subprojects ?? [],
    subprojectSortSettings: data?.subprojectSortSettings ?? [],
  };
}

export function SessionActivityPanel({
  onOpenSession,
  onActivityDeviceFilterChange,
  onProjectCwdChange,
  onProjectRemoved,
  onNewSession,
  onOpenWorktreeGraph,
  onOpenTalkMapForSession,
  onInjectContext,
  onCopySessionInfo,
  onSessionDeleted,
  onRemoteMutate,
  activityScope: requestedActivityScope = "all",
  onOpenHidden,
  onOpenFavorites,
  onOpenToDiscuss,
  onOpenToRevise,
  onOpenCompleted,
  hiddenView,
  favoriteView,
  toDiscussView,
  toReviseView,
  completedView,
  refreshKey,
  viewedAtBySession,
  onViewedAtChange,
  focusSessionId,
  focusSessionKey,
  highlightedSessionId,
  remotePeer,
  soundAlerts = true,
  statusSoundOwner = "chat",
}: Props) {
  const { t } = useI18n();
  const visibleSubagentParentIds = useSubagentVisibility();
  const activityScope = resolveActivityScope(requestedActivityScope, { hiddenView, favoriteView, toDiscussView, toReviseView, completedView });
  const [state, setState] = useState<SessionActivityPanelState>(readState);
  const [projectDeleteConfirmKey, setProjectDeleteConfirmKey] = useState<string | null>(null);
  const [projectDeleteBusyKey, setProjectDeleteBusyKey] = useState<string | null>(null);
  const [projectDeleteError, setProjectDeleteError] = useState<string | null>(null);

  const [sharedFilters, setSharedFilters] = useSharedActivityFilters();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Focus flow: when the panel opens with a known open session, relax filters
  // that would hide it, expand its row (recap group), scroll it into view and
  // request a recap on demand when the session has none.
  const handledFocusSessionRef = useRef<string | null>(null);
  const [locateKey, setLocateKey] = useState<string | null>(null);
  const pendingScrollKeyRef = useRef<string | null>(null);

  // Mirror shared filter changes (e.g. from the sidebar) into local state.
  useEffect(() => {
    setState((current) => ({
      ...current,
      device: sharedFilters.device,
      archiveView: sharedFilters.archiveView,
      project: sharedFilters.project,
      status: sharedFilters.status,
      sort: sharedFilters.sort,
      days: sharedFilters.days,
      group: sharedFilters.group,
    }));
  }, [sharedFilters]);
  useEffect(() => {
    saveState(state);
  }, [state]);

  // When the panel closes (unmounts), collapse every expanded row; the next
  // open starts from a clean recap state. Filters persist, expansions do not.
  useEffect(() => {
    return () => {
      saveState({ ...readState(), expanded: [] });
    };
  }, []);

  const updateState = useCallback((patch: Partial<SessionActivityPanelState>) => {
    setState((current) => normalizeActivityFilterScope({ ...current, ...patch }));
    const filterPatch: Partial<SharedActivityFilters> = {};
    for (const key of SHARED_FILTER_KEYS) {
      if (key in patch) (filterPatch as Record<string, unknown>)[key] = (patch as Record<string, unknown>)[key];
    }
    if (Object.keys(filterPatch).length > 0) {
      // 用户手动改过筛选后，不再让 focus 定位把筛选放宽回全部（否则每次
      // 点项目/状态筛选都会被立即重置，表现为“点击没反应”）。
      handledFocusSessionRef.current = focusSessionId ?? "adjusted";
      setSharedFilters(filterPatch);
    }
  }, [focusSessionId, setSharedFilters]);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SessionSearchResult[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchNonce, setSearchNonce] = useState(0);
  const [searchMatchFilter, setSearchMatchFilter] = useState<SessionSearchMatchFilter>("all");
  const searchSeqRef = useRef(0);

  // Debounced on-demand session-content search; aggregate scope fans out to
  // configured peers only while a query is active.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      searchSeqRef.current += 1;
      setSearchResults(null);
      setSearchLoading(false);
      setSearchError(null);
      return;
    }
    if (q.length < 2) {
      searchSeqRef.current += 1;
      setSearchResults(null);
      setSearchLoading(false);
      setSearchError(null);
      return;
    }
    const seq = ++searchSeqRef.current;
    const controller = new AbortController();
    setSearchLoading(true);
    setSearchError(null);
    const timer = setTimeout(() => {
      const scopeQuery = activityScope === "hidden"
        ? state.device === "all" ? "&scope=hidden" : `&scope=hidden&device=${encodeURIComponent(state.device)}`
        : activityScope === "favorites"
          ? state.device === "all" ? "&scope=favorites" : `&scope=favorites&device=${encodeURIComponent(state.device)}`
          : activityScope === "to_discuss"
            ? state.device === "all" ? "&scope=to_discuss" : `&scope=to_discuss&device=${encodeURIComponent(state.device)}`
            : activityScope === "to_revise"
              ? state.device === "all" ? "&scope=to_revise" : `&scope=to_revise&device=${encodeURIComponent(state.device)}`
              : activityScope === "completed"
                ? state.device === "all" ? "&scope=completed" : `&scope=completed&device=${encodeURIComponent(state.device)}`
                : activityScope !== "all"
                  ? "&scope=local"
                  : state.device === "all"
                    ? "&scope=all"
                    : `&scope=local&device=${encodeURIComponent(state.device)}`;
      void fetch(`/api/sessions/search?q=${encodeURIComponent(q)}&archived=${state.archiveView === "archived" ? "1" : "0"}&days=${encodeURIComponent(state.days)}${scopeQuery}`, { signal: controller.signal })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<{ sessions: SessionSearchResult[] }>;
        })
        .then((data) => {
          if (searchSeqRef.current !== seq) return;
          setSearchResults(data.sessions ?? []);
          setSearchLoading(false);
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          if (searchSeqRef.current !== seq) return;
          setSearchError(err?.message || t("sidebar.searchFailed"));
          setSearchResults([]);
          setSearchLoading(false);
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [activityScope, searchQuery, state.archiveView, state.days, state.device, searchNonce, t]);

  const toggleExpanded = useCallback((key: string) => {
    setState((current) => ({
      ...current,
      expanded: current.expanded.includes(key)
        ? current.expanded.filter((value) => value !== key)
        : [...current.expanded, key],
    }));
  }, []);

  useEffect(() => {
    if (activityScope === "local" && state.group === "device") updateState({ group: "project" });
  }, [activityScope, state.group, updateState]);

  // 包装 onOpenSession：携带当前设备筛选值，外层据此决定会话是否带全部设备语境（scope=all）。
  const handleOpenSession = useCallback((item: SessionActivityItem, searchTerm?: string) => {
    onOpenSession(item, searchTerm, state.device);
  }, [onOpenSession, state.device]);

  const activity = useSessionActivityData({
    filters: state,
    activityScope,
    viewedAtBySession,
    onViewedAtChange,
    refreshKey,
    refreshKeyRetryMs: 250,
    onOpenSession: handleOpenSession,
    onProjectCwdChange,
    onProjectRemoved,
    onFilterChange: (patch) => updateState(patch),
    activeSessionKey: focusSessionKey,
    activeSessionId: focusSessionId,
    soundAlerts,
    statusSoundOwner,
  });

  const visibleSearchResults = filterSearchResults(
    searchResults ?? [],
    activity.data?.sessions,
    activity.data?.device,
    activityScope,
    state,
    viewedAtBySession,
    searchMatchFilter,
  ).filter((hit) => isVisibleSubagentSession(hit, visibleSubagentParentIds, focusSessionId ?? undefined));

  if (activity.data?.sessions) registerSessionLineage(activity.data.sessions);

  const localDeviceId = activity.data?.device.id;
  const mutateSubprojects = activity.mutateSubprojects;
  const toggleSubprojectVisibility = useCallback(async (deviceId: string, subproject: SubprojectDefinition): Promise<boolean> => {
    const result = await mutateSubprojects(deviceId, "PATCH", { id: subproject.id, hidden: !Boolean(subproject.hidden) });
    return result.ok;
  }, [mutateSubprojects]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = state.scrollTop;
  }, [activity.data, state.scrollTop]);

  // Locate the currently open session when the panel opens. If filters would
  // hide it, relax the hiding ones first and retry once data re-settles. Only
  // the first open does this: once the user adjusts any filter (or the focus
  // was already handled), filters stay as the user left them.
  useEffect(() => {
    if (!focusSessionId || !activity.data) return;
    if (handledFocusSessionRef.current === focusSessionId) return;
    const target = activity.data.sessions.find((candidate) => candidate.session.id === focusSessionId);
    if (!target) return;
    if (!activity.filtered.some((candidate) => candidate.session.id === focusSessionId)) {
      if (state.device !== "all" || state.archiveView !== "active" || state.project.length > 0 || state.status !== "all" || state.days !== "all") {
        updateState({ device: "all", archiveView: "active", project: [], status: "all", days: "all" });
      }
      return;
    }
    if (handledFocusSessionRef.current === focusSessionId) return;
    handledFocusSessionRef.current = focusSessionId;
    const key = itemKey(target);
    setLocateKey(key);
    pendingScrollKeyRef.current = key;
    setState((current) => {
      const groupKey = (current.group === "project" || current.group === "worktree")
        ? `${current.group}:${target.projectKey}:${target.device.id}`
        : current.group === "device"
          ? `device:${target.device.id}`
          : null;
      return {
        ...current,
        collapsedGroups: groupKey ? current.collapsedGroups.filter((group) => group !== groupKey) : current.collapsedGroups,
      };
    });
  }, [activity.data, activity.filtered, focusSessionId, state.device, state.archiveView, state.project, state.status, state.days, updateState]);

  // Scroll the located row into view once it renders (its group is expanded).
  useEffect(() => {
    const key = pendingScrollKeyRef.current;
    if (!key || key !== locateKey) return;
    const row = scrollRef.current
      ? Array.from(scrollRef.current.querySelectorAll("[data-session-key]")).find((element) => element.getAttribute("data-session-key") === key)
      : null;
    if (!row) return;
    pendingScrollKeyRef.current = null;
    row.scrollIntoView({ block: "nearest" });
  }, [locateKey, state.collapsedGroups, activity.data]);


  const [collapsedBranchKeys, setCollapsedBranchKeys] = useState<Set<string>>(() => new Set());
  const toggleBranch = useCallback((key: string) => {
    setCollapsedBranchKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const timeLabel = state.sort === "asked" || state.sort === "status" ? t("sessionActivity.sortAsked") : t("sessionActivity.sortRecent");
  const renderPanelSessionRow = (node: ActivitySessionNode, depth = 0, isLast = false, hasChildren = false) => {
    const item = node.item;
    const key = itemKey(item);
    const expanded = state.expanded.includes(key);
    const isBranchCollapsed = collapsedBranchKeys.has(key);
    return <SessionActivityRow key={key} item={item} highlighted={item.session.id === highlightedSessionId} forked={Boolean(item.session.parentSessionId)} contextInjected={Boolean(item.session.contextSourceSessionId)} expanded={expanded} contextLabel={rowContextLabel(item, state.group, activityScope, state.device === "all")} t={t} formatTime={activity.formatTime} formatDuration={activity.formatDuration} statusLabel={activity.statusLabel} timeValue={itemTime(item, state.sort)} timeLabel={timeLabel} onToggle={() => toggleExpanded(key)} depth={depth} hasChildren={hasChildren} branchCollapsed={isBranchCollapsed} onToggleBranch={hasChildren ? () => toggleBranch(key) : undefined} onOpen={() => activity.openActivitySession(item)} onOpenTalkMapForSession={onOpenTalkMapForSession} onInjectContext={onInjectContext} onCopySessionInfo={onCopySessionInfo} canMutate={item.device.id === localDeviceId} onRemoteMutate={onRemoteMutate} onChanged={() => void activity.refresh(item.device.id, true)} onSessionDeleted={onSessionDeleted} recapPeer={item.device.id === localDeviceId ? undefined : item.device.id} costRootRef={scrollRef} onRemoved={(sessionId) => activity.markSessionRemoved(sessionId)} onRestoreRemoved={(sessionId) => activity.unmarkSessionRemoved(sessionId)} onHide={activityScope !== "hidden" ? () => void activity.setHidden("session", item.session.id, true, item.device.id) : undefined} onUnhide={activityScope === "hidden" ? () => void activity.setHidden("session", item.session.id, false, item.device.id) : undefined} onFavorite={() => activity.setFavorite(item.session.id, true, item.device.id)} onUnfavorite={() => activity.setFavorite(item.session.id, false, item.device.id)} onSetCategory={(sessionId, category, deviceId) => activity.setCategory(sessionId, category, deviceId)} subprojects={activity.subprojects} onMoveToSubproject={activity.moveSessionToSubproject} hasSubagents={hasSubagentChildren(activity.data?.sessions ?? [], item)} subagentsVisible={visibleSubagentParentIds.has(item.session.id)} onToggleSubagents={() => setSubagentVisibility(item.session.id, !visibleSubagentParentIds.has(item.session.id))} />;
  };

  return (
    <div
      className="session-activity-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        height: "100%",
        background: "var(--bg)",
        color: "var(--text)",
      } as React.CSSProperties}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0, minWidth: 0, overflowX: "auto", scrollbarWidth: "thin" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          <Icon name="activity" size={16} />
          <strong style={{ fontSize: 13, fontWeight: 650, whiteSpace: "nowrap" }}>{t("sessionActivity.title")}</strong>
          <span style={{ color: "var(--text-dim)", fontSize: 11, whiteSpace: "nowrap" }}>{activity.filtered.length}/{activity.data?.sessions.length ?? 0}</span>
        </div>
        <span style={{ flex: 1, minWidth: 0 }} />
        {activityScope !== "local" && (
          <div style={{ width: ACTIVITY_DEVICE_SLOT_WIDTH, flexShrink: 0 }}>
            <ActivityDeviceFilter
              value={
                activityScope === "hidden"
                  ? HIDDEN_PAGE_VALUE
                  : activityScope === "favorites"
                    ? FAVORITES_PAGE_VALUE
                    : activityScope === "to_discuss"
                      ? TO_DISCUSS_PAGE_VALUE
                      : activityScope === "to_revise"
                        ? TO_REVISE_PAGE_VALUE
                        : activityScope === "completed"
                          ? COMPLETED_PAGE_VALUE
                          : state.device
              }
              devices={activity.devices}
              activityScope={activityScope}
              compact
              showAddDevice
              hiddenView={hiddenView || activityScope === "hidden"}
              favoriteView={favoriteView || activityScope === "favorites"}
              toDiscussView={toDiscussView || activityScope === "to_discuss"}
              toReviseView={toReviseView || activityScope === "to_revise"}
              completedView={completedView || activityScope === "completed"}
              onOpenHidden={onOpenHidden}
              onOpenFavorites={onOpenFavorites}
              onOpenToDiscuss={onOpenToDiscuss}
              onOpenToRevise={onOpenToRevise}
              onOpenCompleted={onOpenCompleted}
              onHideDevice={(device) => void activity.setHidden("device", device.id, true, device.id)}
              onChange={(value) => {
                updateState({ device: value, project: [] });
                // 普通设备筛选只改变活动列表；外层仅在隐藏/收藏页时退出数据域。
                const device = value === "all" ? null : activity.devices.find((candidate) => candidate.id === value) ?? null;
                onActivityDeviceFilterChange?.(device);
              }}
            />
          </div>
        )}
        <div style={{ width: 112, flexShrink: 0 }}>
          <FilterSelect value={state.archiveView} onChange={(value) => updateState({ archiveView: value as ArchiveView })} ariaLabel={t("sessionActivity.archiveView")} compact options={[{ value: "active", label: t("sessionActivity.activeSessions") }, { value: "archived", label: t("sessionActivity.archivedSessions") }]} />
        </div>
        <NewProjectButton onRefresh={activity.refresh} remotePeer={remotePeer} />
        <button type="button" onClick={() => void activity.refresh()} title={t("sessionActivity.refresh")} aria-label={t("sessionActivity.refresh")} style={iconButtonStyle}>
          <Icon name="refresh" />
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, padding: "8px 14px 0", flexShrink: 0 }}>
        <ActivityProjectFilter
          values={state.project}
          allowEmptySubprojectActions={(activityScope === "all" || activityScope === "local") && state.archiveView === "active"}
          projects={activity.projects}
          devices={activity.devices}
          label={activity.projectFilterLabel}
          onChange={(project) => activity.handleProjectFilterChange(project)}
          onDeleteProject={activity.handleDeleteKnownProject}
          onChangeVisibility={activity.changeProjectVisibility}
          allowProjectHiding={activityScope !== "hidden" && Boolean(onOpenHidden)}
          subprojects={activity.subprojects}
          subprojectSortSettings={activity.subprojectSortSettings}
          sessionItems={activity.timeFiltered}
          mutateSubprojects={activity.mutateSubprojects}
          refresh={activity.refresh}
          onClose={activity.handleProjectFilterClose}
          showDeviceGroups={activity.showProjectDeviceGroups}
          t={t}
        />
        <FilterSelect
          value={state.days}
          onChange={(value) => updateState({ days: value as TimeRangeValue })}
          ariaLabel={t("sessionActivity.timeRange")}
          options={[{ value: "all", label: t("sessionActivity.allTime") }, ...["1", "3", "7", "14", "30", "90"].map((days) => ({ value: days, label: t("sessionActivity.withinDays", { count: Number(days) }) }))]}
        />
        <FilterSelect
          value={state.group}
          onChange={(value) => updateState({ group: value as GroupValue })}
          ariaLabel={t("sessionActivity.group")}
          options={[
            { value: "project", label: t("sessionActivity.groupProject") },
              { value: "worktree", label: t("sessionActivity.groupWorktree") },
            ...(activityScope === "all" && state.device === "all" ? [{ value: "device", label: t("sessionActivity.groupDevice") }] : []),
            { value: "none", label: t("sessionActivity.groupNone") },
          ]}
        />
        <FilterSelect
          value={state.status}
          onChange={(value) => updateState({ status: value })}
          ariaLabel={t("sessionActivity.statusFilter")}
          options={[{ value: "all", label: t("sessionActivity.allStatuses") }, ...(["running", "retrying", "waiting_user", "just_completed", "idle", "failed", "aborted", "unknown"] as SessionActivityStatus[]).map((status) => ({ value: status, label: activity.statusLabel(status) }))]}
        />
        <FilterSelect
          value={state.sort}
          onChange={(value) => updateState({ sort: value as SortValue })}
          ariaLabel={t("sessionActivity.sort")}
          title={state.sort === "asked" ? t("sessionActivity.sortAskedHint") : state.sort === "status" ? t("sessionActivity.sortStatusHint") : t("sessionActivity.sortRecentHint")}
          options={[
            { value: "asked", label: t("sessionActivity.sortAsked") },
            { value: "recent", label: t("sessionActivity.sortRecent") },
            { value: "status", label: t("sessionActivity.sortStatus") },
          ]}
        />
      </div>

      <div style={{ padding: "8px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <SessionSearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={t("sessionActivity.searchPlaceholder")}
          title={t("sessionActivity.searchHint")}
          clearLabel={t("sessionActivity.clearSearch")}
        />
      </div>

      <div ref={scrollRef} onScroll={(event) => updateState({ scrollTop: event.currentTarget.scrollTop })} style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {activity.loading && (!activity.data || activity.data.sessions.length === 0) && <div style={emptyStyle}>{t("sessionActivity.loading")}</div>}
        {(activity.data?.metadataWarnings?.length ?? 0) > 0 && <div role="status" style={{ ...emptyStyle, color: "var(--warning, #a16207)" }}>
          {t(activity.data!.metadataWarnings!.some(warning => warning.domain === "hidden") ? "sessionActivity.visibilityUnavailable" : "sessionActivity.metadataUnavailable")}
          {" "}{activity.data!.metadataWarnings!.map(warning => `${warning.deviceId}: ${warning.domain}`).join(", ")}
          <button type="button" onClick={() => void activity.refresh()} style={iconButtonStyle}>{t("sessionActivity.refresh")}</button>
        </div>}
        {!activity.loading && activity.error && !activity.data && <div style={{ ...emptyStyle, color: "#dc2626" }}>{t("sessionActivity.loadFailed")}: {activity.error}</div>}
        {/* Offline state is surfaced in the device filter selector labels, not as a separate banner row. */}
        {searchQuery.trim().length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px 4px", color: "var(--text-muted)", fontSize: 11 }}>
            <span>{searchLoading ? t("sessionActivity.searching") : `${t("sessionActivity.searchResults")} ${visibleSearchResults.length}`}</span>
            {!searchLoading && <SessionSearchMatchFilterSelect value={searchMatchFilter} onChange={setSearchMatchFilter} />}
          </div>
        )}
        {searchQuery.trim().length > 0 && !searchLoading && searchError && (
          <div style={{ ...emptyStyle, color: "#dc2626" }}>
            <div>{searchError}</div>
            <button
              type="button"
              onClick={() => setSearchNonce((n) => n + 1)}
              style={{
                marginTop: 8,
                padding: "4px 10px",
                borderRadius: 4,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              {t("i18n.retry")}
            </button>
          </div>
        )}
        {searchQuery.trim().length > 0 && !searchLoading && !searchError && searchResults && visibleSearchResults.length === 0 && (
          <div style={emptyStyle}>
            <div>{t("sessionActivity.searchNoResults")}</div>
          </div>
        )}
        {searchQuery.trim().length > 0 && !searchLoading && !searchError && searchResults && visibleSearchResults.length > 0 && (
          visibleSearchResults.map((hit) => (
            <ActivitySearchHitRow
              key={`${hit.device?.id ?? "local"}:${hit.id}`}
              hit={hit}
              activityItems={activity.data?.sessions}
              visibleSubagentParentIds={visibleSubagentParentIds}
              viewedAtBySession={viewedAtBySession}
              sort={state.sort}
              selected={hit.id === focusSessionId}
              highlighted={hit.id === highlightedSessionId}
              localDevice={activity.data?.device}
              onRemoteMutate={onRemoteMutate}
              onSessionDeleted={onSessionDeleted}
              statusLabel={activity.statusLabel}
              formatTime={activity.formatTime}
              costRootRef={scrollRef}
              onOpen={() => activity.openActivitySession(searchHitToItem(hit, activity.data?.device, activity.data?.sessions, viewedAtBySession), hit.contentMatchCount > 0 ? searchQuery.trim() : undefined)}
              onOpenTalkMapForSession={onOpenTalkMapForSession}
              onInjectContext={onInjectContext}
              onCopySessionInfo={onCopySessionInfo}
              onChanged={() => setSearchNonce((n) => n + 1)}
              onHide={activityScope !== "hidden" ? () => void activity.setHidden("session", hit.id, true, hit.device?.id) : undefined}
              onUnhide={activityScope === "hidden" ? () => void activity.setHidden("session", hit.id, false, hit.device?.id) : undefined}
              onFavorite={() => activity.setFavorite(hit.id, true, hit.device?.id)}
              onUnfavorite={() => activity.setFavorite(hit.id, false, hit.device?.id)}
              onSetCategory={(sessionId, category, deviceId) => activity.setCategory(sessionId, category, deviceId)}
              subprojects={activity.subprojects}
              onMoveToSubproject={activity.moveSessionToSubproject}
            />
          ))
        )}
        {searchQuery.trim().length === 0 && !activity.loading && activity.data && activity.groups.length === 0 && (
          <div style={emptyStyle}>
            <div>{t("sessionActivity.empty")}</div>

          </div>
        )}
        {searchQuery.trim().length === 0 && activity.groups.map(([groupKey, items, emptyProject]) => {
          const visibleItems = filterVisibleSubagentItems(items, visibleSubagentParentIds, focusSessionId ?? undefined);
          const groupKeys = new Set(visibleItems.map(itemKey));
          const groupCollapsed = state.group !== "none" && state.collapsedGroups.includes(groupKey);
          const groupExpanded = visibleItems.length > 0 && visibleItems.every((item) => state.expanded.includes(itemKey(item)));
          const sessionProject = items[0] ? projectInfoFromSession(items[0]) : null;
          const groupProject = (state.group === "project" || state.group === "worktree") ? emptyProject ?? sessionProject : null;
          const groupName = groupProject?.label ?? deviceLabel(items[0]?.device.name ?? "-");
          const groupDevice = (state.group === "project" || state.group === "worktree") ? groupProject?.deviceName ?? null : null;
          const groupPath = (state.group === "project" || state.group === "worktree") ? groupProject?.path : undefined;
          const groupDeviceId = groupProject?.deviceId ?? items[0]?.device.id;
          const groupDeviceInfo = groupDeviceId ? activity.devices.find((device) => device.id === groupDeviceId) : undefined;
          const projectBucket = groupProject ? activity.projectBuckets.get(groupProject.key) : undefined;
          const groupSubprojects = groupDeviceId && groupProject
            ? projectBucket?.subprojects ?? activity.subprojects.filter((subproject) => subproject.deviceId === groupDeviceId && projectKeysMatch(subproject.projectKey, groupProject.projectKey))
            : [];
          const groupSubprojectSort = groupDeviceId && groupProject
            ? activity.subprojectSortSettings.find((setting) => setting.deviceId === groupDeviceId && projectKeysMatch(setting.projectKey, groupProject.projectKey))
            : undefined;
          const groupAllItems = groupProject && groupDeviceId
            ? activity.timeFiltered.filter((item) => item.device.id === groupDeviceId && projectKeysMatch(item.projectKey, groupProject.projectKey))
            : [];
          const emptyGroupSubprojects = emptySubprojectDefinitions(groupSubprojects, groupAllItems);
          const autoHiddenGroupSubprojectIds = new Set(
            groupSubprojectSort?.autoHideEmptySubprojects
              ? emptyGroupSubprojects.map((subproject) => subproject.id)
              : [],
          );
          const visibleGroupSubprojects = groupSubprojects.filter((subproject) => !subproject.hidden && !autoHiddenGroupSubprojectIds.has(subproject.id));
          const visibleGroupItems = filterSubprojectItems(visibleItems, hiddenSubprojectIdsFor(groupSubprojects, autoHiddenGroupSubprojectIds));
          const hasProjectSessions = Boolean(groupProject?.hasSessions || visibleItems.length > 0);
          const canDeleteProject = Boolean((state.group === "project" || state.group === "worktree") && !hasProjectSessions && groupProject?.saved && groupDeviceId);
          return (
            <section key={groupKey || "all"}>
              {state.group !== "none" && (
                <ProjectPathContextMenu
                  path={groupPath}
                  deviceId={groupDeviceId}
                  canDelete={state.group === "project" && canDeleteProject}
                  hasSessions={groupProject?.hasSessions ?? visibleItems.length > 0}
                  hasSubprojects={state.group === "project" && groupSubprojects.length > 0}
                  autoHideEmptySubprojects={Boolean(groupSubprojectSort?.autoHideEmptySubprojects)}
                  onRequestDelete={() => {
                    setProjectDeleteError(null);
                    setProjectDeleteConfirmKey(groupKey);
                  }}
                  onDelete={state.group === "project" && canDeleteProject && groupProject ? () => activity.handleDeleteKnownProject(groupProject) : undefined}
                  onHide={state.group === "project" && !groupProject?.hidden && activityScope !== "hidden" && groupProject && groupDeviceId ? () => activity.changeProjectVisibility(groupProject, true) : undefined}
                  onUnhide={state.group === "project" && groupProject?.hidden && groupDeviceId ? () => activity.changeProjectVisibility(groupProject, false) : undefined}
                  onToggleAutoHideEmptySubprojects={state.group === "project" && (activityScope === "all" || activityScope === "local") && state.archiveView === "active" && groupDeviceId && groupProject ? () => toggleAutoHideEmptySubprojects(groupProject.projectKey, groupSubprojectSort, groupDeviceId, activity.mutateSubprojects, activity.refresh) : undefined}
                  subprojectAction={state.group === "project" && groupProject && groupDeviceId ? <ActivitySubprojectManager projectKey={groupProject.projectKey} deviceId={groupDeviceId} definitions={groupSubprojects} sortSetting={groupSubprojectSort} sessionItems={groupAllItems} sessionSort={state.sort} mutate={activity.mutateSubprojects} /> : state.group === "worktree" && groupPath && groupProject && groupProject.isGit !== false ? <ActivityWorktreeManager projectRoot={groupPath} deviceId={groupDeviceId} localDeviceId={localDeviceId} gitKnown={groupProject.isGit === true} t={t} /> : undefined}
                  t={t}
                  style={state.group === "worktree" ? { ...groupHeaderStyle, color: "#60a5fa" } : groupHeaderStyle}
                >
                  <div className="activity-project-header">
                    <button className="activity-group-toggle" type="button" onClick={() => updateState({ collapsedGroups: groupCollapsed ? state.collapsedGroups.filter((key) => key !== groupKey) : [...state.collapsedGroups, groupKey] })} aria-expanded={!groupCollapsed} aria-haspopup={groupPath ? "menu" : undefined} aria-label={groupCollapsed ? t("sessionActivity.expandGroup") : t("sessionActivity.collapseGroup")} style={groupToggleStyle}>
                      <span style={{ display: "inline-flex", flexShrink: 0, color: groupCollapsed ? "#dc2626" : undefined, transform: groupCollapsed ? "none" : "rotate(90deg)", transition: "transform 0.12s" }}><Icon name="chevron" size={13} /></span>
                      <span className="activity-project-identity">
                        <strong className="activity-project-name">{groupName}</strong>
                        {groupDevice && <span className="activity-project-device">· {groupDevice}</span>}
                      </span>
                    </button>
                    <div className="activity-project-action-group">
                      {(state.group === "project" || state.group === "worktree") && (
                        <div style={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
                          {state.group === "worktree" && groupPath && groupProject && groupProject.isGit !== false && (
                            <ActivityWorktreeManager
                              triggerMode="toolbar"
                              projectRoot={groupPath}
                              deviceId={groupDeviceId}
                              localDeviceId={localDeviceId}
                              gitKnown={groupProject.isGit === true}
                              t={t}
                            />
                          )}
                          {state.group === "project"
                            && groupSubprojects.length > 0
                            && (activityScope === "all" || activityScope === "local")
                            && state.archiveView === "active"
                            && groupProject
                            && groupDeviceId && (
                              <AutoHideEmptySubprojectsButton
                                projectKey={groupProject.projectKey}
                                deviceId={groupDeviceId}
                                sortSetting={groupSubprojectSort}
                                mutate={activity.mutateSubprojects}
                                refresh={activity.refresh}
                                t={t}
                              />
                            )}
                          {state.group === "project"
                            && groupPath
                            && groupDeviceId
                            && groupProject?.isGit === true
                            && onOpenWorktreeGraph && (
                            <button
                              className="activity-project-action"
                              type="button"
                              onClick={() => onOpenWorktreeGraph(groupPath, groupDeviceInfo)}
                              title={t("worktreeGraph.open")}
                              aria-label={t("worktreeGraph.open")}
                            >
                              <GitFork size={14} strokeWidth={1.8} aria-hidden="true" />
                            </button>
                          )}
                          <ActivityNewSessionButton cwd={groupPath ?? null} device={groupDeviceInfo} localDeviceId={localDeviceId} onNewSession={onNewSession} t={t} />
                        </div>
                      )}
                      {visibleItems.length > 0 && (
                        <button className="activity-project-action" type="button" onClick={() => updateState({ expanded: groupExpanded ? state.expanded.filter((key) => !groupKeys.has(key)) : [...new Set([...state.expanded, ...groupKeys])], ...(groupExpanded ? {} : { collapsedGroups: state.collapsedGroups.filter((key) => key !== groupKey) }) })} title={groupExpanded ? t("sessionActivity.collapseAll") : t("sessionActivity.expandAll")} aria-label={groupExpanded ? t("sessionActivity.collapseAll") : t("sessionActivity.expandAll")}>
                          <span style={{ fontSize: 0 }}>{groupExpanded ? t("sessionActivity.collapseAll") : t("sessionActivity.expandAll")}</span>
                          <Icon name="chevron" size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                </ProjectPathContextMenu>
              )}
              {projectDeleteConfirmKey === groupKey && groupProject && (
                <div className="activity-project-delete-confirm activity-subproject-delete-confirm" role="alert">
                  <span>{t("sessionActivity.deleteProjectEmpty")}</span>
                  <button
                    type="button"
                    disabled={projectDeleteBusyKey !== null}
                    onClick={async () => {
                      setProjectDeleteBusyKey(groupKey);
                      setProjectDeleteError(null);
                      try {
                        await activity.handleDeleteKnownProject(groupProject);
                        setProjectDeleteConfirmKey(null);
                      } catch (error) {
                        setProjectDeleteError(error instanceof Error && error.message ? error.message : t("sessionActivity.projectPathActionFailed"));
                      } finally {
                        setProjectDeleteBusyKey(null);
                      }
                    }}
                  >
                    {t("sidebar.confirm")}
                  </button>
                  <button
                    type="button"
                    disabled={projectDeleteBusyKey !== null}
                    onClick={() => {
                      setProjectDeleteConfirmKey(null);
                      setProjectDeleteError(null);
                    }}
                  >
                    {t("sidebar.cancel")}
                  </button>
                </div>
              )}
              {projectDeleteError && projectDeleteConfirmKey === groupKey && (
                <div role="alert" style={{ padding: "2px 10px 4px", color: "#dc2626", fontSize: 10 }}>
                  {projectDeleteError}
                </div>
              )}
              {(!groupCollapsed || state.group === "none") && (() => {
                  if (state.group === "worktree") return <WorktreeSessionBuckets onNewSession={onNewSession ? (cwd, deviceId) => onNewSession(cwd, deviceId ? activity.devices.find((d) => d.id === deviceId) : groupDeviceInfo) : undefined} focusSessionId={focusSessionId ?? undefined} focusSessionKey={focusSessionKey ?? undefined} items={visibleGroupItems} inventoryProjectKey={groupProject?.projectKey} inventoryProjectRoot={groupPath} inventoryDeviceId={groupDeviceId} inventoryUrl={groupPath ? (groupDeviceId && groupDeviceId !== localDeviceId ? `/api/remote/worktrees?peer=${encodeURIComponent(groupDeviceId)}&cwd=${encodeURIComponent(groupPath)}` : `/api/worktrees?cwd=${encodeURIComponent(groupPath)}`) : undefined} sessionOf={item => item.session} deviceOf={item => item.device.id} mainLabel={t("sessionActivity.worktreeMain")} worktreeLabel={t("sessionActivity.worktreeLinked")} renderItems={rows => <SessionLineageBranchList variant="panel" collapsedBranchKeys={collapsedBranchKeys} nodes={buildSessionLineageTree(rows, state.sort)} renderRow={renderPanelSessionRow} />} />;
                  const definitions = state.group === "project" && groupProject
                    ? groupSubprojects
                    : [];
                  return definitions.length > 0
                    ? <SubprojectBucketList
                      items={visibleGroupItems}
                      definitions={visibleGroupSubprojects}
                      projectKey={groupProject!.projectKey}
                      deviceId={groupDeviceId!}
                       projectCwd={groupPath ?? null}
                       newSessionDevice={groupDeviceInfo}
                       localDeviceId={localDeviceId}
                       onNewSession={onNewSession}
                      unclassifiedLabel={t("sessionActivity.unclassified")}
                      renderRow={renderPanelSessionRow}
                       sortSetting={groupSubprojectSort}
                       sessionSort={state.sort}
                       onSortSubprojects={(order) => activity.mutateSubprojects(groupDeviceId!, "PUT", { projectKey: groupProject!.projectKey, mode: "custom", order }).then((result) => result.ok)}
                      onToggleSubprojectVisibility={(subproject) => toggleSubprojectVisibility(groupDeviceId!, subproject)}
                      mutateSubprojects={activity.mutateSubprojects}
                      variant="panel"
                      collapsedBranchKeys={collapsedBranchKeys}
                    />
                    : <SessionLineageBranchList variant="panel" collapsedBranchKeys={collapsedBranchKeys} nodes={buildSessionLineageTree(visibleItems, state.sort)} renderRow={renderPanelSessionRow} />;
              })()}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function SubprojectBucketList({ items, definitions, projectKey, deviceId, projectCwd, newSessionDevice, localDeviceId, onNewSession, unclassifiedLabel, renderRow, sortSetting, sessionSort, onSortSubprojects, onToggleSubprojectVisibility, mutateSubprojects, variant = "panel", collapsedBranchKeys }: {
  items: SessionActivityItem[];
  definitions: NonNullable<SessionActivityResponse["subprojects"]>;
  projectKey: string;
  deviceId: string;
  projectCwd: string | null;
  newSessionDevice?: SessionActivityDevice;
  localDeviceId?: string;
  onNewSession?: (cwd: string, device?: SessionActivityDevice, subprojectId?: string, subprojectLabel?: string) => void;
  unclassifiedLabel: string;
  renderRow: (node: ActivitySessionNode, depth: number, isLast: boolean, hasChildren: boolean) => React.ReactNode;
  sortSetting?: SubprojectSortSetting;
  sessionSort: SortValue;
  onSortSubprojects?: (order: string[]) => Promise<boolean>;
  onToggleSubprojectVisibility?: (subproject: SubprojectDefinition) => Promise<boolean>;
  mutateSubprojects: SubprojectMutationFn;
  variant?: "panel" | "sidebar";
  collapsedBranchKeys?: Set<string>;
}) {
  const { t } = useI18n();
  const [collapsedKeys, setCollapsedKeys] = useState<string[]>([]);
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameLabel, setRenameLabel] = useState("");
  const [renameBusyId, setRenameBusyId] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [visibilityBusyId, setVisibilityBusyId] = useState<string | null>(null);
  const [visibilityError, setVisibilityError] = useState<string | null>(null);
  const [reorderOverId, setReorderOverId] = useState<string | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const sortMode = sortSetting?.mode ?? "custom";
  const canReorder = sortMode === "custom" && Boolean(onSortSubprojects);
  const customOrder = orderedSubprojectIds(definitions, sortSetting?.order);
  const buckets = groupBySubproject(items, definitions, projectKey, unclassifiedLabel, {
    mode: sortMode,
    customOrder: sortSetting?.order,
    compareItems: (left, right) => compareBySort(left, right, sessionSort),
  });

  const bucketKey = (id: string) => `${projectKey}:${id}`;
  const toggleBucket = (id: string) => {
    const key = bucketKey(id);
    setCollapsedKeys((current) => current.includes(key) ? current.filter((value) => value !== key) : [...current, key]);
  };
  const beginRename = (subproject: SubprojectDefinition) => {
    setDeleteConfirmId(null);
    setDeleteError(null);
    setRenameError(null);
    setRenameId(subproject.id);
    setRenameLabel(subproject.label);
  };
  const cancelRename = () => {
    setRenameId(null);
    setRenameLabel("");
    setRenameError(null);
  };
  const handleRename = async (subproject: SubprojectDefinition) => {
    if (renameBusyId) return;
    const nextLabel = renameLabel.trim();
    if (!nextLabel) return;
    if (nextLabel === subproject.label) {
      cancelRename();
      return;
    }
    setRenameBusyId(subproject.id);
    setRenameError(null);
    const renamed = await mutateSubprojects(deviceId, "PATCH", { id: subproject.id, label: nextLabel }).then((result) => result.ok).catch(() => false);
    setRenameBusyId(null);
    if (renamed) cancelRename();
    else setRenameError(t("sessionActivity.subprojectRenameFailed"));
  };
  const requestDelete = (subproject: SubprojectDefinition) => {
    setRenameId(null);
    setRenameError(null);
    setDeleteError(null);
    setDeleteConfirmId(subproject.id);
  };
  const handleDelete = async (subproject: SubprojectDefinition) => {
    if (deleteBusyId) return;
    setDeleteBusyId(subproject.id);
    setDeleteError(null);
    const deleted = await mutateSubprojects(deviceId, "DELETE", { id: subproject.id }).then((result) => result.ok).catch(() => false);
    setDeleteBusyId(null);
    if (deleted) setDeleteConfirmId(null);
    else setDeleteError(t("sessionActivity.subprojectDeleteFailed"));
  };
  const handleToggleVisibility = async (subproject: SubprojectDefinition) => {
    if (!onToggleSubprojectVisibility || visibilityBusyId) return;
    setVisibilityBusyId(subproject.id);
    setVisibilityError(null);
    const changed = await onToggleSubprojectVisibility(subproject).catch(() => false);
    setVisibilityBusyId(null);
    if (!changed) setVisibilityError(t("sessionActivity.subprojectVisibilityFailed"));
  };
  const reorderOriginRef = useRef<EventTarget | null>(null);
  const handleReorderStart = (event: React.DragEvent<HTMLElement>, id: string) => {
    if (isSubprojectReorderDragBlocked(reorderOriginRef.current ?? event.target)) {
      event.preventDefault();
      reorderOriginRef.current = null;
      return;
    }
    if (!canReorder || reorderBusy) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/subproject-id", id);
    event.dataTransfer.setData("text/plain", id);
  };
  const handleReorderOver = (event: React.DragEvent<HTMLElement>, id: string) => {
    if (!canReorder || id === "__unclassified__" || !Array.from(event.dataTransfer.types).includes("text/subproject-id")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setReorderOverId(id);
  };
  const handleReorderDrop = (event: React.DragEvent<HTMLElement>, targetId: string) => {
    if (!canReorder || targetId === "__unclassified__") return;
    event.preventDefault();
    setReorderOverId(null);
    const sourceId = event.dataTransfer.getData("text/subproject-id");
    if (!sourceId || sourceId === targetId || !onSortSubprojects) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const nextOrder = reorderSubprojectIds(customOrder, sourceId, targetId, event.clientY < rect.top + rect.height / 2);
    if (nextOrder.every((id, index) => id === customOrder[index])) return;
    setReorderBusy(true);
    setReorderError(null);
    void onSortSubprojects(nextOrder)
      .then((saved) => { if (!saved) setReorderError(t("sessionActivity.subprojectSortFailed")); })
      .catch(() => setReorderError(t("sessionActivity.subprojectSortFailed")))
      .finally(() => setReorderBusy(false));
  };

  return <>{buckets.map((bucket) => {
    const key = bucketKey(bucket.id);
    const collapsed = collapsedKeys.includes(key);
    const visibilityBusy = bucket.subproject && visibilityBusyId === bucket.id;
    const confirmDelete = Boolean(bucket.subproject && deleteConfirmId === bucket.id);
    const editing = Boolean(bucket.subproject && renameId === bucket.id);
    const toggle = (
      <button className="activity-subproject-toggle" type="button" onClick={() => toggleBucket(bucket.id)} aria-expanded={!collapsed} aria-label={collapsed ? t("sessionActivity.expandSubproject") : t("sessionActivity.collapseSubproject")}>
        <span style={{ display: "inline-flex", flexShrink: 0, color: collapsed ? "#dc2626" : undefined, transform: collapsed ? "none" : "rotate(90deg)", transition: "transform 0.12s" }}><Icon name="chevron" size={11} /></span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bucket.label}</span>
      </button>
    );
    const title = editing ? (
      <>
        <button className="activity-subproject-toggle activity-subproject-toggle-editing" type="button" onClick={() => toggleBucket(bucket.id)} aria-expanded={!collapsed} aria-label={collapsed ? t("sessionActivity.expandSubproject") : t("sessionActivity.collapseSubproject")}>
          <span style={{ display: "inline-flex", flexShrink: 0, color: collapsed ? "#dc2626" : undefined, transform: collapsed ? "none" : "rotate(90deg)", transition: "transform 0.12s" }}><Icon name="chevron" size={11} /></span>
        </button>
        <div className="activity-subproject-rename activity-subproject-rename-inline" role="group" aria-label={`${t("sidebar.rename")}: ${bucket.label}`} onClick={(event) => event.stopPropagation()}>
          <input autoFocus value={renameLabel} disabled={renameBusyId !== null} onChange={(event) => setRenameLabel(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void handleRename(bucket.subproject!); if (event.key === "Escape") cancelRename(); }} aria-label={`${t("sidebar.rename")}: ${bucket.label}`} />
          <button type="button" disabled={renameBusyId !== null || !renameLabel.trim()} onClick={() => void handleRename(bucket.subproject!)} title={t("sidebar.confirm")} aria-label={t("sidebar.confirm")}><Check size={13} aria-hidden="true" /></button>
          <button type="button" disabled={renameBusyId !== null} onClick={cancelRename} title={t("sidebar.cancel")} aria-label={t("sidebar.cancel")}><X size={13} aria-hidden="true" /></button>
        </div>
      </>
    ) : toggle;
    return (
      <section
        key={bucket.id}
        className={`activity-subproject-drop-zone${reorderOverId === bucket.id ? " subproject-reorder-over" : ""}`}
        data-session-subproject-drop="true"
        data-session-project-key={projectKey}
        data-session-device-id={deviceId}
        data-session-subproject-id={bucket.id === "__unclassified__" ? "" : bucket.id}
        onDragOver={(event) => handleReorderOver(event, bucket.id)}
        onDrop={(event) => handleReorderDrop(event, bucket.id)}
        onDragLeave={() => { if (reorderOverId === bucket.id) setReorderOverId(null); }}
      >
        <div
          className="activity-subproject-header"
          data-unclassified={bucket.id === "__unclassified__" ? "true" : undefined}
          draggable={Boolean(bucket.subproject && canReorder && !reorderBusy)}
          onPointerDownCapture={(event) => { reorderOriginRef.current = event.target; }}
          onPointerUpCapture={() => { reorderOriginRef.current = null; }}
          onPointerCancelCapture={() => { reorderOriginRef.current = null; }}
          onKeyDownCapture={() => { reorderOriginRef.current = null; }}
          onDragStart={(event) => { if (bucket.subproject) handleReorderStart(event, bucket.subproject.id); }}
          onDragEnd={() => { reorderOriginRef.current = null; setReorderOverId(null); }}
          style={{ padding: "5px 14px 4px 14px" }}
        >
          {bucket.subproject ? (
            <SubprojectContextMenu
              subproject={bucket.subproject}
              onRenameRequest={beginRename}
              onDeleteRequest={requestDelete}
            >
              {title}
            </SubprojectContextMenu>
          ) : title}
          {bucket.subproject && onToggleSubprojectVisibility && (
            <button
              className="activity-subproject-visibility"
              type="button"
              data-session-subproject-visibility="true"
              disabled={visibilityBusyId !== null}
              onClick={(event) => { event.stopPropagation(); void handleToggleVisibility(bucket.subproject!); }}
              title={`${t("sessionActivity.hideSubproject")}: ${bucket.label}`}
              aria-label={`${t("sessionActivity.hideSubproject")}: ${bucket.label}`}
              aria-busy={visibilityBusy}
            >
              <Eye size={12} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
          <span style={{ flexShrink: 0, color: "inherit", fontSize: 10, fontWeight: 500 }}>{bucket.items.length}</span>
          {bucket.subproject && onNewSession && (
            <ActivityNewSessionButton
              cwd={projectCwd}
              device={newSessionDevice}
              localDeviceId={localDeviceId}
              onNewSession={onNewSession}
              subprojectId={bucket.subproject.id}
              subprojectLabel={bucket.subproject.label}
              t={t}
            />
          )}
        </div>
        {renameError && editing && <div role="alert" style={{ padding: "2px 14px 4px 28px", color: "#dc2626", fontSize: 10 }}>{renameError}</div>}
        {confirmDelete && bucket.subproject && (
          <div className="activity-subproject-delete-confirm" role="alert">
            <span>{t("sessionActivity.deleteSubproject", { label: bucket.label })}</span>
            <button type="button" disabled={deleteBusyId !== null} onClick={() => void handleDelete(bucket.subproject!)}>{t("sidebar.confirm")}</button>
            <button type="button" disabled={deleteBusyId !== null} onClick={() => { setDeleteConfirmId(null); setDeleteError(null); }}>{t("sidebar.cancel")}</button>
          </div>
        )}
        {!collapsed && deleteError && confirmDelete && <div role="alert" style={{ padding: "2px 14px 4px 28px", color: "#dc2626", fontSize: 10 }}>{deleteError}</div>}
        {!collapsed && visibilityError && <div role="alert" style={{ padding: "2px 14px 4px 14px", color: "#dc2626", fontSize: 10 }}>{visibilityError}</div>}
        {!collapsed && reorderError && <div role="alert" style={{ padding: "2px 14px 4px 14px", color: "#dc2626", fontSize: 10 }}>{reorderError}</div>}
        {!collapsed && <SessionLineageBranchList variant={variant} collapsedBranchKeys={collapsedBranchKeys} nodes={buildSessionLineageTree(bucket.items, sessionSort)} renderRow={renderRow} />}
      </section>
    );
  })}</>;
}

function ActivitySubprojectManager({ projectKey, deviceId, definitions, sortSetting, sessionItems, sessionSort, mutate }: {
  projectKey: string;
  deviceId: string;
  definitions: NonNullable<SessionActivityResponse["subprojects"]>;
  sortSetting?: SubprojectSortSetting;
  sessionItems: SessionActivityItem[];
  sessionSort: SortValue;
  mutate: SubprojectMutationFn;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [reorderOverId, setReorderOverId] = useState<string | null>(null);
  const [sortModeOverride, setSortModeOverride] = useState<SubprojectSortMode | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const sortMode = sortModeOverride ?? sortSetting?.mode ?? "custom";
  const customOrder = orderedSubprojectIds(definitions, sortSetting?.order);
  const autoHiddenSubprojectIds = new Set(
    sortSetting?.autoHideEmptySubprojects
      ? emptySubprojectDefinitions(definitions, sessionItems).map((subproject) => subproject.id)
      : [],
  );
  const isAutomaticallyHidden = (subproject: SubprojectDefinition): boolean => autoHiddenSubprojectIds.has(subproject.id);
  const isHidden = (subproject: SubprojectDefinition): boolean => Boolean(subproject.hidden || isAutomaticallyHidden(subproject));
  const orderedDefinitions = groupBySubproject(sessionItems, definitions, projectKey, "", {
    mode: sortMode,
    customOrder: sortSetting?.order,
    compareItems: (left, right) => compareBySort(left, right, sessionSort),
  }).flatMap((bucket) => bucket.subproject ? [bucket.subproject] : []);
  const displayDefinitions = [
    ...orderedDefinitions.filter((subproject) => !isHidden(subproject)),
    ...orderedDefinitions.filter((subproject) => isHidden(subproject)),
  ];
  const canReorder = sortMode === "custom";

  useEffect(() => {
    setSortModeOverride(null);
  }, [sortSetting?.mode]);

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const submenu = submenuRef.current?.getBoundingClientRect();
    const width = submenu?.width || 292;
    const height = submenu?.height || 320;
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const right = rect.right + 4;
    const left = right + width <= window.innerWidth - 8 ? right : Math.max(8, rect.left - width - 4);
    const top = Math.min(Math.max(8, rect.top), Math.max(8, window.innerHeight - height - 8));
    setPosition({ left: Math.min(left, maxLeft), top });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const frame = window.requestAnimationFrame(reposition);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [deleteConfirmId, definitions.length, editingId, error, open, reposition, sortMode]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (anchorRef.current?.contains(target) || submenuRef.current?.contains(target) || (target instanceof Element && target.closest("[data-subproject-context-menu]")))) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        anchorRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const run = async (method: SubprojectMutationMethod, body: Record<string, unknown>, options: SubprojectMutationOptions = {}): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    const result = await mutate(deviceId, method, body, options);
    setBusy(false);
    if (!result.ok) {
      setError(result.message ?? "subproject mutation failed");
      return false;
    }
    return true;
  };

  const create = async () => {
    const nextLabel = label.trim();
    if (!nextLabel) return;
    if (await run("POST", { projectKey, label: nextLabel })) setLabel("");
  };
  const beginRename = (subproject: SubprojectDefinition) => {
    if (busy) return;
    setDeleteConfirmId(null);
    setError(null);
    setEditingId(subproject.id);
    setEditingLabel(subproject.label);
  };
  const cancelRename = () => {
    setEditingId(null);
    setEditingLabel("");
    setError(null);
  };
  const saveRename = async (subproject: SubprojectDefinition) => {
    const nextLabel = editingLabel.trim();
    if (!nextLabel || busy) return;
    if (nextLabel === subproject.label) {
      cancelRename();
      return;
    }
    if (await run("PATCH", { id: subproject.id, label: nextLabel })) cancelRename();
  };
  const requestDelete = (subproject: SubprojectDefinition) => {
    if (busy) return;
    setEditingId(null);
    setEditingLabel("");
    setError(null);
    setDeleteConfirmId(subproject.id);
  };
  const confirmDelete = async (subproject: SubprojectDefinition) => {
    if (busy) return;
    if (await run("DELETE", { id: subproject.id })) setDeleteConfirmId(null);
  };
  const toggleVisibility = async (subproject: SubprojectDefinition) => {
    if (isAutomaticallyHidden(subproject)) return;
    await run("PATCH", { id: subproject.id, hidden: !subproject.hidden });
  };
  const toggleAutoHide = async () => {
    await run("PUT", { projectKey, mode: sortMode, order: customOrder, autoHideEmptySubprojects: !Boolean(sortSetting?.autoHideEmptySubprojects) }, { optimistic: true });
  };
  const changeSortMode = async (mode: SubprojectSortMode) => {
    if (await run("PUT", { projectKey, mode, order: customOrder })) setSortModeOverride(mode);
  };
  const reorderOriginRef = useRef<EventTarget | null>(null);
  const handleReorderStart = (event: React.DragEvent<HTMLElement>, id: string) => {
    if (isSubprojectReorderDragBlocked(reorderOriginRef.current ?? event.target)) {
      event.preventDefault();
      reorderOriginRef.current = null;
      return;
    }
    if (!canReorder || busy) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/subproject-id", id);
    event.dataTransfer.setData("text/plain", id);
  };
  const handleReorderOver = (event: React.DragEvent<HTMLElement>, id: string) => {
    if (!canReorder || !Array.from(event.dataTransfer.types).includes("text/subproject-id")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setReorderOverId(id);
  };
  const handleReorderDrop = (event: React.DragEvent<HTMLElement>, targetId: string) => {
    if (!canReorder) return;
    event.preventDefault();
    setReorderOverId(null);
    const sourceId = event.dataTransfer.getData("text/subproject-id");
    if (!sourceId || sourceId === targetId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const nextOrder = reorderSubprojectIds(customOrder, sourceId, targetId, event.clientY < rect.top + rect.height / 2);
    if (nextOrder.every((id, index) => id === customOrder[index])) return;
    void run("PUT", { projectKey, mode: "custom", order: nextOrder });
  };

  const submenu = open && typeof document !== "undefined"
    ? createPortal(
      <div
        ref={submenuRef}
        data-subproject-manager-submenu="true"
        role="menu"
        aria-label={t("sessionActivity.subprojectManageMenu")}
        onClick={(event) => event.stopPropagation()}
        style={{
          position: "fixed",
          left: position?.left ?? -1000,
          top: position?.top ?? -1000,
          zIndex: 1001,
          width: 292,
          maxWidth: "calc(100vw - 16px)",
          maxHeight: "calc(100vh - 16px)",
          overflowY: "auto",
          boxSizing: "border-box",
          padding: 8,
          border: "1px solid var(--border)",
          borderRadius: 7,
          background: "var(--bg-panel)",
          color: "var(--text)",
          boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
          visibility: position ? "visible" : "hidden",
        }}
      >
        <div style={{ marginBottom: 5, color: "var(--text-muted)", fontSize: 10, fontWeight: 650 }}>{t("sessionActivity.subprojectManageMenu")}</div>
        <div style={{ display: "flex", gap: 5 }}>
          <input autoFocus={definitions.length === 0} value={label} disabled={busy} onChange={(event) => setLabel(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void create(); if (event.key === "Escape") setOpen(false); }} placeholder={t("sessionActivity.newSubproject")} aria-label={t("sessionActivity.newSubproject")} style={{ flex: 1, minWidth: 0, boxSizing: "border-box", height: 27, padding: "0 7px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)", fontSize: 11 }} />
          <button type="button" role="menuitem" disabled={busy || !label.trim()} onClick={() => void create()} aria-label={t("sessionActivity.newSubproject")} title={t("sessionActivity.newSubproject")} style={{ ...groupActionStyle, width: 28, height: 27, padding: 0 }}>+</button>
        </div>
        {definitions.length > 0 && (
          <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
            <label style={{ display: "grid", gap: 3, color: "var(--text-dim)", fontSize: 10 }}>
              <span>{t("sessionActivity.subprojectSort")}</span>
              <ReaderFloatingSelect
                value={sortMode}
                disabled={Boolean(busy)}
                onChange={(value) => void changeSortMode(value as SubprojectSortMode)}
                options={[{ value: "alpha", label: t("sessionActivity.subprojectSortAlpha") }, { value: "inherit", label: t("sessionActivity.subprojectSortInherit") }, { value: "custom", label: t("sessionActivity.subprojectSortCustom") }]}
                ariaLabel={t("sessionActivity.subprojectSort")}
                title={t("sessionActivity.subprojectSort")}
                containerStyle={{ width: "100%" }}
                triggerStyle={{ width: "100%", height: 27, padding: "0 6px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)", fontSize: 11, justifyContent: "space-between", overflow: "hidden", textOverflow: "ellipsis" }}
                menuMinWidth="max-content"
                optionMinHeight={26}
              />
            </label>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, color: "var(--text-dim)", fontSize: 10 }}>
              <span>{t("sessionActivity.subprojectManage")}</span>
              <button
                type="button"
                data-subproject-auto-hide
                disabled={busy}
                onClick={() => void toggleAutoHide()}
                title={t("sessionActivity.autoHideEmptySubprojects")}
                aria-label={t("sessionActivity.autoHideEmptySubprojects")}
                aria-pressed={Boolean(sortSetting?.autoHideEmptySubprojects)}
                style={{ ...groupActionStyle, display: "inline-flex", alignItems: "center", gap: 4, minHeight: 24, padding: "0 5px", color: sortSetting?.autoHideEmptySubprojects ? "var(--text-dim)" : "var(--accent)" }}
              >
                {sortSetting?.autoHideEmptySubprojects ? <EyeOff size={12} strokeWidth={1.8} /> : <Eye size={12} strokeWidth={1.8} />}
                <span>{t("sessionActivity.autoHideEmptySubprojects")}</span>
              </button>
            </div>
            {displayDefinitions.map((subproject) => {
              const editing = editingId === subproject.id;
              const deleting = deleteConfirmId === subproject.id;
              return (
              <div
                key={subproject.id}
                className={reorderOverId === subproject.id ? "subproject-reorder-over" : undefined}
                onDragOver={(event) => handleReorderOver(event, subproject.id)}
                onDrop={(event) => handleReorderDrop(event, subproject.id)}
                onDragLeave={() => { if (reorderOverId === subproject.id) setReorderOverId(null); }}
                style={{ display: "grid", gap: 4, padding: 2, borderRadius: 4, opacity: isHidden(subproject) ? 0.72 : 1 }}
              >
                <div
                  data-subproject-reorder-row="true"
                  draggable={Boolean(canReorder && !busy)}
                  onPointerDownCapture={(event) => { reorderOriginRef.current = event.target; }}
                  onPointerUpCapture={() => { reorderOriginRef.current = null; }}
                  onPointerCancelCapture={() => { reorderOriginRef.current = null; }}
                  onKeyDownCapture={() => { reorderOriginRef.current = null; }}
                  onDragStart={(event) => handleReorderStart(event, subproject.id)}
                  onDragEnd={() => { reorderOriginRef.current = null; setReorderOverId(null); }}
                  style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, padding: "3px 4px", border: "1px solid var(--border)", borderRadius: 4, opacity: isHidden(subproject) ? 0.55 : 1 }}
                >
                  <SubprojectContextMenu
                    subproject={subproject}
                    onRenameRequest={beginRename}
                    onDeleteRequest={requestDelete}
                  >
                    {editing ? (
                      <input autoFocus value={editingLabel} disabled={busy} onChange={(event) => setEditingLabel(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveRename(subproject); if (event.key === "Escape") cancelRename(); }} aria-label={`${t("sidebar.rename")}: ${subproject.label}`} style={{ flex: 1, minWidth: 0, height: 24, boxSizing: "border-box", padding: "0 6px", border: "1px solid var(--accent)", borderRadius: 4, background: "var(--bg)", color: "var(--text)", fontSize: 10 }} />
                    ) : (
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: isHidden(subproject) ? "var(--text-dim)" : "var(--text)", fontSize: 10 }}>{subproject.label}</span>
                    )}
                  </SubprojectContextMenu>
                  {editing ? (
                    <>
                      <button className="subproject-manage-action" type="button" disabled={busy || !editingLabel.trim()} onClick={() => void saveRename(subproject)} title={t("sidebar.confirm")} aria-label={t("sidebar.confirm")}><Check size={12} aria-hidden="true" /></button>
                      <button className="subproject-manage-action" type="button" disabled={busy} onClick={cancelRename} title={t("sidebar.cancel")} aria-label={t("sidebar.cancel")}><X size={12} aria-hidden="true" /></button>
                    </>
                  ) : null}
                  <button className="subproject-manage-action" type="button" disabled={busy || isAutomaticallyHidden(subproject)} onClick={() => void toggleVisibility(subproject)} title={t(isAutomaticallyHidden(subproject) ? "sessionActivity.autoHideEmptySubprojects" : isHidden(subproject) ? "sessionActivity.showSubproject" : "sessionActivity.hideSubproject")} aria-label={t(isAutomaticallyHidden(subproject) ? "sessionActivity.autoHideEmptySubprojects" : isHidden(subproject) ? "sessionActivity.showSubproject" : "sessionActivity.hideSubproject")} aria-pressed={!isHidden(subproject)} style={{ color: isHidden(subproject) ? "var(--text-dim)" : "var(--accent)" }}>
                    {isAutomaticallyHidden(subproject) ? <EyeOff size={12} strokeWidth={1.8} aria-hidden="true" /> : isHidden(subproject) ? <EyeOff size={12} strokeWidth={1.8} aria-hidden="true" /> : <Eye size={12} strokeWidth={1.8} aria-hidden="true" />}
                  </button>
                </div>
                {deleting && (
                  <div className="activity-subproject-delete-confirm" role="alert" style={{ paddingLeft: 6 }}>
                    <span>{t("sessionActivity.deleteSubproject", { label: subproject.label })}</span>
                    <button type="button" disabled={busy} onClick={() => void confirmDelete(subproject)}>{t("sidebar.confirm")}</button>
                    <button type="button" disabled={busy} onClick={() => setDeleteConfirmId(null)}>{t("sidebar.cancel")}</button>
                  </div>
                )}
              </div>
            );
            })}
          </div>
        )}
        {error && <div role="alert" style={{ marginTop: 6, color: "#dc2626", fontSize: 10, overflowWrap: "anywhere" }}>{error}</div>}
      </div>,
      document.body,
    )
    : null;

  return (
    <div style={{ flexShrink: 0 }} onClick={(event) => event.stopPropagation()}>
      <button
        ref={anchorRef}
        role="menuitem"
        type="button"
        title={t("sessionActivity.subprojectManageMenu")}
        aria-label={t("sessionActivity.subprojectManageMenu")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => { setOpen((value) => !value); setError(null); }}
        style={{ ...projectContextMenuItemStyle, justifyContent: "space-between", width: "100%" }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><FolderPlus size={14} strokeWidth={1.8} aria-hidden="true" /><span>{t("sessionActivity.subprojectManageMenu")}</span></span>
        <Icon name="chevron" size={13} />
      </button>
      {submenu}
    </div>
  );
}

function useCoarsePointer() {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarse(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return coarse;
}

function isSessionActionTarget(target: EventTarget | null, row: HTMLElement | null, sessionId: string): boolean {
  if (!(target instanceof Element)) return false;
  if (row?.contains(target) && target.closest(".activity-action-button")) return true;
  return target.closest("[data-session-row-extra-actions]")?.getAttribute("data-session-row-extra-actions") === sessionId;
}

function SessionActivityRow({
  item,
  expanded,
  highlighted,
  contextLabel,
  forked = false,
  contextInjected = false,
  t,
  formatTime,
  formatDuration,
  statusLabel,
  timeValue,
  timeLabel,
  onToggle,
  onOpen,
  onOpenTalkMapForSession,
  onInjectContext,
  onCopySessionInfo,
  recapPeer,
  costRootRef,
  canMutate,
  onRemoteMutate,
  onChanged,
  onSessionDeleted,
  onHide,
  onUnhide,
  onRemoved,
  onRestoreRemoved,
  onFavorite,
  onUnfavorite,
  onSetCategory,
  subprojects = [],
  onMoveToSubproject,
  hasSubagents = false,
  subagentsVisible = false,
  onToggleSubagents,
  depth = 0,
  hasChildren = false,
  branchCollapsed = false,
  onToggleBranch,
}: {
  item: SessionActivityItem;
  expanded: boolean;
  highlighted?: boolean;
  contextLabel?: string;
  /** True when this session was forked from another session. */
  forked?: boolean;
  /** True when this session received context from another session. */
  contextInjected?: boolean;
  hasSubagents?: boolean;
  subagentsVisible?: boolean;
  onToggleSubagents?: () => void;
  depth?: number;
  hasChildren?: boolean;
  branchCollapsed?: boolean;
  onToggleBranch?: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  formatTime: (value: string) => string;
  formatDuration: (run: SessionRunRecord | null) => string | null;
  statusLabel: (status: SessionActivityStatus) => string;
  timeValue: string;
  timeLabel: string;
  onToggle: () => void;
  onOpen: () => void;
  onOpenTalkMapForSession?: SessionActivityCardAction;
  onInjectContext?: SessionActivityCardAction;
  onCopySessionInfo?: SessionActivityCardAction;
  /** Peer id for remote session cost requests. */
  recapPeer?: string;
  costRootRef?: CostRootRef;
  canMutate: boolean;
  onRemoteMutate?: RemoteMutateFn;
  onChanged: () => void;
  onSessionDeleted?: (sessionId: string) => void;
  /** 正常视图：隐藏会话（写入数据所属设备）。 */
  onHide?: () => void;
  /** 隐藏页视图：取消隐藏会话。 */
  onUnhide?: () => void;
  /** 变更成功后从列表移除；归档/恢复请求期间保留行以显示忙碌或错误。 */
  onRemoved?: (sessionId: string) => void;
  onRestoreRemoved?: (sessionId: string) => void;
  onFavorite?: () => Promise<boolean> | void;
  onUnfavorite?: () => Promise<boolean> | void;
  onSetCategory?: (sessionId: string, category: SessionStorageCategory | null, deviceId?: string) => Promise<boolean> | void;
  subprojects?: SessionActivityResponse["subprojects"];
  onMoveToSubproject?: (item: SessionActivityItem, subprojectId: string | null) => Promise<boolean>;
}) {
  const latest = item.latestRun;
  const subagentCompleted = hasCompletedSubagent(item);
  const durationText = formatDuration(latest);
  const { cost, costState, costStatus, cacheHitRate, missingPriceModels, pendingUsageCount, recordedOnly, costRef } = useLazySessionCost(item.session.id, item.session.modified, recapPeer, costRootRef);
  const costValue = typeof cost === "number" ? cost : 0;
  const partialCost = costStatus === "partial";
  const formattedCost = partialCost
    ? `≥$${(Math.floor(costValue * 100) / 100).toFixed(2)}`
    : typeof cost === "number" && (costValue > 0 || recordedOnly) ? `$${costValue.toFixed(2)}` : null;
  const costText = costState === "loading" ? "…" : costState === "error" ? "?" : formattedCost;
  const unpricedText = missingPriceModels.length > 0 && !partialCost ? t("sessionActivity.unpriced") : null;
  const unpricedTitle = missingPriceModels.length > 0
    ? partialCost ? missingPriceModels.join(", ") : `${t("session.unpricedModels")}: ${missingPriceModels.join(", ")}`
    : undefined;
  const pendingUsageText = pendingUsageCount > 0 ? t("session.pendingUsageCount", { count: pendingUsageCount }) : null;
  const cacheHitText = cacheHitRate != null ? `CH ${cacheHitRate.toFixed(1)}%` : null;
  const [busy, setBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const hover = useSessionHover();
  const [contextMenuPoint, setContextMenuPoint] = useState<{ x: number; y: number } | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const coarsePointer = useCoarsePointer();
  const actionsVisible = hover.hovered || coarsePointer;
  const [name, setName] = useState("");
  const [editing, setEditing] = useState(false);
  const title = sessionTitle(item);
  const modelValue = item.session.relation?.kind === "subagent" ? sessionModelValue(item.session, item.modelName) : undefined;
  const modelLabel = item.session.relation?.kind === "subagent"
    ? sessionModelLabel(modelValue) ?? t("sidebar.subagentModelPending")
    : undefined;
  const pointerDrag = useSessionSubprojectPointerDrag({
    projectKey: item.projectKey,
    deviceId: item.device.id,
    disabled: item.session.transient || item.device.online === false || !onMoveToSubproject,
    onMove: (subprojectId) => onMoveToSubproject ? onMoveToSubproject(item, subprojectId) : Promise.resolve(false),
  });

  const canRemote = !canMutate && item.device.online !== false && Boolean(onRemoteMutate);
  const canMutateAny = canMutate || canRemote;
  const mutateTitle = canMutate ? null : canRemote ? t("sessionActivity.remoteActionViaDevice") : t("sessionActivity.remoteActionUnavailable");
  const lifecycleManagedByParent = item.session.relation?.kind === "subagent";
  const lifecycleTitle = lifecycleManagedByParent ? t("sessionActivity.subagentLifecycleRequiresParent") : undefined;

  const archive = async () => {
    if (!canMutateAny || busy || lifecycleManagedByParent) return;
    setArchiveError(null);
    setBusy(true);
    try {
      let ok: boolean;
      if (canMutate) {
        const response = await fetch(`/api/sessions/${encodeURIComponent(item.session.id)}/archive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived: !item.session.archived }) });
        await assertSessionMutationOk(response);
        ok = true;
      } else {
        ok = await onRemoteMutate!(item.device, item.session.archived ? "unarchive" : "archive", item.session.id);
      }
      if (!ok) throw new Error(t("sessionActivity.archiveFailed"));
      clearSessionActivityCache();
      onRemoved?.(item.session.id);
      onSessionDeleted?.(item.session.id);
      onChanged();
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!canMutateAny || busy || lifecycleManagedByParent) return;
    setConfirmDelete(false);
    setBusy(true);
    onRemoved?.(item.session.id);
    try {
      const ok = canMutate
        ? (await fetch(`/api/sessions/${encodeURIComponent(item.session.id)}`, { method: "DELETE" })).ok
        : await onRemoteMutate!(item.device, "delete", item.session.id);
      if (ok) {
        clearSessionActivityCache();
        onSessionDeleted?.(item.session.id);
        onChanged();
      } else {
        onRestoreRemoved?.(item.session.id);
      }
    } catch {
      onRestoreRemoved?.(item.session.id);
    } finally {
      setBusy(false);
    }
  };

  const requestDelete = () => {
    if (!canMutateAny || busy || lifecycleManagedByParent) return;
    setConfirmDelete(true);
  };

  const recapDisplay = sessionRecapDisplay(item.lastRecap);

  const commitRename = async () => {
    const nextName = name.trim();
    setEditing(false);
    if (!canMutateAny || !nextName || nextName === (item.session.name ?? "")) return;
    setBusy(true);
    try {
      const ok = canMutate
        ? (await fetch(`/api/sessions/${encodeURIComponent(item.session.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: nextName }) })).ok
        : await onRemoteMutate!(item.device, "rename", item.session.id, nextName);
      if (ok) onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={(node) => { costRef.current = node; rowRef.current = node; }}
      data-session-key={itemKey(item)}
      data-session-id={item.session.id}
      data-talk-map-highlighted={highlighted ? "true" : undefined}
      onPointerDown={pointerDrag.onPointerDown}
      onPointerMove={pointerDrag.onPointerMove}
      onPointerUp={pointerDrag.onPointerUp}
      onPointerCancel={pointerDrag.onPointerCancel}
      onClickCapture={pointerDrag.onClickCapture}
      onMouseEnter={hover.enter}
      onMouseLeave={hover.leave}
      onFocus={hover.enter}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hover.leave(); }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        window.getSelection()?.removeAllRanges();
        setContextMenuPoint({ x: event.clientX, y: event.clientY });
      }}
      style={{
        borderTop: "1px solid var(--border)",
        borderLeft: highlighted ? "2px solid var(--accent)" : "2px solid transparent",
        background: highlighted ? "var(--bg-selected)" : "transparent",
        opacity: pointerDrag.dragging || busy ? 0.55 : 1,
        position: "relative",
        overflow: "visible",
        zIndex: contextMenuPoint ? 2 : 0,
        cursor: pointerDrag.dragging ? "grabbing" : "pointer",
      }}
    >
          <div className="activity-session-row-header" style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px 9px" }}>
            <div className="activity-session-leading" style={{ display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0, minWidth: depth > 0 && !hasChildren ? 0 : 20 }}>
              {hasChildren ? (
                <button
                  className="activity-session-toggle"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (onToggleBranch) onToggleBranch();
                    else onToggle();
                  }}
                  title={branchCollapsed ? t("sessionActivity.expandBranch") : t("sessionActivity.collapseBranch")}
                  aria-label={branchCollapsed ? t("sessionActivity.expandBranch") : t("sessionActivity.collapseBranch")}
                  aria-expanded={!branchCollapsed}
                  style={{ ...iconButtonStyle, width: 20, height: 20, color: "var(--text-dim)", transform: branchCollapsed ? "none" : "rotate(90deg)", transition: "transform 0.12s" }}
                >
                  <Icon name="chevron" size={13} />
                </button>
              ) : depth === 0 ? (
                <button
                  className="activity-session-toggle"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggle();
                  }}
                  title={expanded ? t("sessionActivity.collapse") : t("sessionActivity.expand")}
                  aria-label={expanded ? t("sessionActivity.collapse") : t("sessionActivity.expand")}
                  aria-expanded={expanded}
                  style={{ ...iconButtonStyle, width: 20, height: 20, color: "var(--text-dim)", transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.12s" }}
                >
                  <Icon name="chevron" size={13} />
                </button>
              ) : null}
            </div>
            <button data-session-open="true" type="button" onClick={(event) => { event.stopPropagation(); setArchiveError(null); onOpen(); }} style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 2, flex: 1, minWidth: 0, textAlign: "left", padding: 0, border: 0, background: "none", color: "inherit", cursor: "pointer" }}>
              <div className="activity-session-title-row" style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, width: "100%", minHeight: 25 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, flex: 1, minWidth: 0, overflow: "hidden" }}>
                  {item.session.relation?.kind === "subagent" ? (
                    <span title={t("sidebar.subagent")} style={{ display: "inline-flex", flexShrink: 0 }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-label={t("sidebar.subagent")} style={{ opacity: 0.85 }}>
                        <rect x="5" y="7" width="14" height="11" rx="2" /><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
                      </svg>
                    </span>
                  ) : forked ? (
                    <span title={t("sessionActivity.forkedSession")} style={{ display: "inline-flex", flexShrink: 0 }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-label={t("sessionActivity.forkedSession")} style={{ opacity: 0.85 }}>
                        <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
                      </svg>
                    </span>
                  ) : contextInjected ? (
                    <span title={t("sessionActivity.contextInjectedSession")} style={{ display: "inline-flex", flexShrink: 0 }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label={t("sessionActivity.contextInjectedSession")} style={{ opacity: 0.85 }}>
                        <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                        <path d="M14 11a5 5 0 0 0-7.07 0l-3 3A5 5 0 0 0 9 21l1.71-1.71" />
                      </svg>
                    </span>
                  ) : null}
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor(item.status), flexShrink: 0 }} />
                  {editing ? (
                    <input autoFocus value={name} onChange={(event) => setName(event.target.value)} onBlur={() => void commitRename()} onKeyDown={(event) => { if (event.key === "Enter") void commitRename(); if (event.key === "Escape") setEditing(false); }} style={sidebarRenameInputStyle} />
                  ) : (
                    <>
                      <strong className="activity-session-title" style={{ flex: "1 1 auto", maxWidth: "none", minWidth: 0, fontSize: 12, fontWeight: highlighted ? 700 : 620, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</strong>
                      {archiveError && <span role="alert" title={archiveError} aria-label={archiveError} style={{ color: "#dc2626", fontSize: 11, fontWeight: 700, flexShrink: 0, cursor: "help" }}>!</span>}
                    </>
                  )}
                </div>
              </div>
              <div className="activity-session-meta" style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0, width: "100%", overflow: "hidden", color: "var(--text-dim)", fontSize: 10, lineHeight: 1.35, whiteSpace: "nowrap" }}>
                <span className="activity-session-status" style={{ color: statusColor(item.status), flexShrink: 0 }}>{statusLabel(item.status)}</span>
                {item.category && (
                  <>
                    <MetaSeparator />
                    <span
                      style={{
                        color: item.category === "to_discuss"
                          ? "#3b82f6"
                          : item.category === "to_revise"
                            ? "#f59e0b"
                            : "#10b981",
                        fontWeight: 600,
                        flexShrink: 0,
                      }}
                    >
                      {t(`sessionActivity.${item.category === "to_discuss" ? "toDiscuss" : item.category === "to_revise" ? "toRevise" : "completed"}`)}
                    </span>
                  </>
                )}
                {subagentCompleted && <><MetaSeparator /><span title={t("sessionActivity.subagentCompletedHint")} style={{ color: "#2563eb", flexShrink: 0 }}>{t("sessionActivity.subagentCompleted")}</span></>}
                <span className="activity-session-meta-extra" style={{ display: "inline-flex", alignItems: "center", flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {contextLabel && <><MetaSeparator /><span>{contextLabel}</span></>}
                  {modelLabel && <><MetaSeparator /><span title={modelValue ?? modelLabel} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{modelLabel}</span></>}
                  {costText && <><MetaSeparator /><span title={[recordedOnly ? t("session.costPartialHint") : "", partialCost ? unpricedTitle : ""].filter(Boolean).join(" · ") || undefined} style={{ color: sessionCostColor(costValue) }}>{costText}</span></>}
                  {unpricedText && <><MetaSeparator /><span title={unpricedTitle} style={{ color: "#d97706", fontWeight: 600 }}>{unpricedText}</span></>}
                  {pendingUsageText && <><MetaSeparator /><span title={pendingUsageText} style={{ color: "#d97706", fontWeight: 600 }}>{pendingUsageText}</span></>}
                  {cacheHitText && <><MetaSeparator /><span>{cacheHitText}</span></>}
                  {durationText && <><MetaSeparator /><span>{t("sessionActivity.runDuration", { value: durationText })}</span></>}
                </span>
                <span className="activity-session-time" title={`${timeLabel}: ${timeValue}`} style={{ marginLeft: "auto", flexShrink: 0, color: "var(--text-dim)", fontSize: 10, whiteSpace: "nowrap" }}>{formatTime(timeValue)}</span>
              </div>
            </button>
            {confirmDelete ? (
              <SessionDeleteActions onConfirm={() => void remove()} onCancel={() => setConfirmDelete(false)} disabled={busy} t={t} />
            ) : actionsVisible && (
              <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                <ActivityActionButton
                  title={expanded ? t("sessionActivity.collapse") : (recapDisplay.body ? t("sessionActivity.recap") : t("sessionActivity.expand"))}
                  disabled={busy}
                  onClick={onToggle}
                >
                  <FileText size={12} strokeWidth={2} />
                </ActivityActionButton>
                <ActivityActionButton title={mutateTitle ?? t("sessionActivity.rename")} disabled={!canMutateAny || busy} onClick={() => { setName(item.session.name ?? ""); setEditing(true); }}>
                  <Pencil size={12} strokeWidth={2} />
                </ActivityActionButton>
                <ActivityActionButton title={archiveError ?? lifecycleTitle ?? (mutateTitle ?? (item.session.archived ? t("sessionActivity.restore") : t("sessionActivity.archive")))} disabled={!canMutateAny || busy || lifecycleManagedByParent} onClick={() => void archive()}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="21 8 21 21 3 21 3 8" /><rect x="1" y="3" width="22" height="5" /><line x1="10" y1="12" x2="14" y2="12" /></svg>
                </ActivityActionButton>
                <ActivityActionButton title={lifecycleTitle ?? mutateTitle ?? t("sessionActivity.delete")} disabled={!canMutateAny || busy || lifecycleManagedByParent} onClick={requestDelete} danger>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1 1h4a1 1 0 0 1 1 1v2" /></svg>
                </ActivityActionButton>
              </div>
            )}
          </div>
          {contextMenuPoint && (
            <SessionContextMenu
              item={item}
              canMutateAny={canMutateAny}
              busy={busy}
              mutateTitle={mutateTitle}
              position={contextMenuPoint}
              onClose={() => setContextMenuPoint(null)}
              subprojects={subprojects}
              onMoveToSubproject={onMoveToSubproject}
              hasSubagents={hasSubagents}
              subagentsVisible={subagentsVisible}
              onToggleSubagents={onToggleSubagents}
              onFavorite={onFavorite}
              onUnfavorite={onUnfavorite}
              onSetCategory={onSetCategory}
              onHide={onHide}
              onUnhide={onUnhide}
              onRename={() => { setName(item.session.name ?? ""); setEditing(true); }}
              onArchive={() => void archive()}
              archiveDisabled={!canMutateAny || busy || lifecycleManagedByParent}
              archiveTitle={archiveError ?? lifecycleTitle ?? (mutateTitle ?? (item.session.archived ? t("sessionActivity.restore") : t("sessionActivity.archive")))}
              onDelete={requestDelete}
              deleteDisabled={!canMutateAny || busy || lifecycleManagedByParent}
              deleteTitle={lifecycleTitle ?? mutateTitle ?? t("sessionActivity.delete")}
              t={t}
            />
          )}
          {expanded && (
            <div style={{ margin: "0 14px 12px 47px", border: "1px solid var(--border)", borderLeft: "3px solid var(--accent)", borderRadius: 6, background: "var(--bg-panel)", color: "var(--text-muted)", boxShadow: "0 1px 2px color-mix(in srgb, var(--text) 8%, transparent)", overflow: "hidden" }}>
              <div style={{ padding: "10px 11px 11px" }}>
                {recapDisplay.taskFlow.length > 0 ? (
                  <div data-session-task-flow>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 5, color: "var(--text)", fontSize: 11, fontWeight: 650 }}>
                      <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 }} />
                      {t("sessionActivity.taskFlow")}
                    </div>
                    <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{recapDisplay.body}</div>
                  </div>
                ) : (
                  <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: recapDisplay.body ? "var(--text)" : "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.45 }}>
                    {recapDisplay.body || t("sessionActivity.noRecap")}
                  </div>
                )}
              </div>
            </div>
          )}
    </div>
  );
}

const iconButtonStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", width: 25, height: 25,
  padding: 0, border: 0, background: "none", color: "var(--text-muted)", cursor: "pointer", flexShrink: 0,
};

const groupHeaderStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
  padding: "8px 14px", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
  background: "var(--bg-subtle)", color: "var(--text-muted)", fontSize: 11, fontWeight: 700,
};

const activitySidebarGroupHeaderStyle: React.CSSProperties = {
  ...groupHeaderStyle,
  padding: "6px 10px 6px 8px",
  background: "color-mix(in srgb, var(--accent) 9%, var(--bg-panel))",
  borderTop: "1px solid color-mix(in srgb, var(--accent) 24%, var(--border))",
  borderBottom: "1px solid color-mix(in srgb, var(--accent) 24%, var(--border))",
  borderLeft: "3px solid color-mix(in srgb, var(--accent) 56%, transparent)",
};

const groupToggleStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, flex: "1 1 0", minWidth: 0, minHeight: 26, padding: 0,
  border: 0, background: "none", color: "var(--text)", cursor: "pointer", fontSize: 12, fontWeight: 650,
};

const groupActionStyle: React.CSSProperties = {
  height: 24, padding: "0 7px", border: "1px solid var(--border)", borderRadius: 4,
  background: "var(--bg-panel)", color: "var(--text-muted)", cursor: "pointer", fontSize: 10, fontWeight: 600,
};


function ActivityWorktreeManager({
  projectRoot,
  deviceId,
  localDeviceId,
  gitKnown,
  t,
  triggerMode = "menu",
}: {
  projectRoot: string;
  deviceId?: string;
  localDeviceId?: string;
  gitKnown: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
  triggerMode?: "menu" | "toolbar";
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [gitConfirmed, setGitConfirmed] = useState(gitKnown);

  useEffect(() => {
    if (gitKnown) {
      setGitConfirmed(true);
      return;
    }
    let cancelled = false;
    setGitConfirmed(false);
    const peer = deviceId && deviceId !== localDeviceId ? deviceId : undefined;
    void fetch(apiPathForPeer(peer, `worktrees?cwd=${encodeURIComponent(projectRoot)}`), { cache: "no-store" })
      .then(async (response) => response.ok ? await response.json() as { isGit?: boolean } : null)
      .then((state) => { if (!cancelled) setGitConfirmed(state?.isGit === true); })
      .catch(() => { if (!cancelled) setGitConfirmed(false); });
    return () => { cancelled = true; };
  }, [deviceId, gitKnown, localDeviceId, projectRoot]);

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = 292;
    const height = 110;
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const right = rect.right + 4;
    const left = right + width <= window.innerWidth - 8 ? right : Math.max(8, rect.left - width - 4);
    const top = Math.min(Math.max(8, rect.top), Math.max(8, window.innerHeight - height - 8));
    setPosition({ left: Math.min(left, maxLeft), top });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const frame = window.requestAnimationFrame(reposition);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (anchorRef.current?.contains(target) || submenuRef.current?.contains(target))) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const peer = deviceId && deviceId !== localDeviceId ? deviceId : undefined;
      const res = await fetch(apiPathForPeer(peer, "worktrees"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectRoot, branch: trimmed }),
      });
      const result = (await res.json().catch(() => null)) as { path?: string; branch?: string; error?: string } | null;
      if (!res.ok || !result?.path) throw new Error(result?.error || `HTTP ${res.status}`);
      setName("");
      setNotice(t("sessionActivity.worktreeCreated", { branch: result.branch ?? trimmed, path: result.path }));
      window.dispatchEvent(new CustomEvent("pi-web:worktree-management-changed"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sessionActivity.createWorktreeFailed"));
      window.dispatchEvent(new CustomEvent("pi-web:worktree-management-changed"));
    } finally {
      setBusy(false);
    }
  };

  if (!gitConfirmed) return null;

  const submenu = open && typeof document !== "undefined"
    ? createPortal(
      <div
        ref={submenuRef}
        data-subproject-manager-submenu="true"
        data-worktree-manager-submenu="true"
        role="menu"
        aria-label={t("sessionActivity.newWorktree")}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          left: position?.left ?? -1000,
          top: position?.top ?? -1000,
          zIndex: 1305,
          width: 292,
          maxWidth: "calc(100vw - 16px)",
          padding: 8,
          border: "1px solid var(--border)",
          borderRadius: 7,
          background: "var(--bg-panel)",
          color: "var(--text)",
          boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
          visibility: position ? "visible" : "hidden",
        }}
      >
        <div style={{ marginBottom: 5, color: "var(--text-muted)", fontSize: 10, fontWeight: 650 }}>{t("sessionActivity.newWorktree")}</div>
        <div style={{ display: "flex", gap: 5 }}>
          <input
            autoFocus
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
              if (e.key === "Escape") setOpen(false);
            }}
            placeholder={t("sessionActivity.worktreeBranchPlaceholder")}
            aria-label={t("sessionActivity.worktreeBranchName")}
            style={{ flex: 1, minWidth: 0, height: 27, padding: "0 7px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)", fontSize: 11 }}
          />
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => void create()}
            style={{ ...groupActionStyle, width: 28, height: 27, padding: 0 }}
          >
            +
          </button>
        </div>
        {error && <div role="alert" style={{ marginTop: 6, color: "#dc2626", fontSize: 10 }}>{error}</div>}
        {notice && <div role="status" style={{ marginTop: 6, color: "var(--text-muted)", fontSize: 10 }}>{notice}</div>}
      </div>,
      document.body,
    ) : null;

  if (triggerMode === "toolbar") {
    return (
      <div style={{ display: "inline-flex" }} onClick={(e) => e.stopPropagation()}>
        <button
          ref={anchorRef}
          className="activity-project-action"
          type="button"
          title={t("sessionActivity.newWorktree")}
          aria-label={t("sessionActivity.newWorktree")}
          aria-expanded={open}
          onClick={() => { setOpen((v) => !v); setError(null); }}
        >
          <FolderGit2 size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
        {submenu}
      </div>
    );
  }

  return (
    <div style={{ flexShrink: 0 }} onClick={(event) => event.stopPropagation()}>
      <button
        ref={anchorRef}
        role="menuitem"
        type="button"
        title={t("sessionActivity.newWorktree")}
        aria-label={t("sessionActivity.newWorktree")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => { setOpen((value) => !value); setError(null); }}
        style={{ ...projectContextMenuItemStyle, justifyContent: "space-between", width: "100%" }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <FolderGit2 size={14} strokeWidth={1.8} aria-hidden="true" />
          <span>{t("sessionActivity.newWorktree")}</span>
        </span>
        <Icon name="chevron" size={13} />
      </button>
      {submenu}
    </div>
  );
}


const selectStyle: React.CSSProperties = {
  height: 26, padding: "0 5px", border: "1px solid var(--border)", borderRadius: 4,
  background: "var(--bg)", color: "var(--text-muted)", fontSize: 11,
};

const emptyStyle: React.CSSProperties = { padding: "28px 14px", color: "var(--text-dim)", fontSize: 12, textAlign: "center" };

interface SessionActivitySidebarProps {
  selectedSessionId: string | null;
  selectedSessionKey?: string | null;
  /** Talk Map selection highlight; does not change active chat session. */
  highlightedSessionId?: string | null;
  /** Optional first-cell control for the left activity toolbar (A). */
  leadingControl?: ReactNode;
  onOpenSession: (item: SessionActivityItem, searchTerm?: string, deviceFilter?: string) => void;
  /** 旧完整设备视图切换；仅由 deviceSwitchOnly 入口调用。 */
  onDeviceChange?: (device: SessionActivityDevice | null) => void;
  /** 普通活动设备筛选；只改变列表域（必要时退出隐藏/收藏页），不导航工作区。 */
  onActivityDeviceFilterChange?: (device: SessionActivityDevice | null) => void;
  onProjectCwdChange?: (cwd: string | null) => void;
  onProjectRemoved?: (path: string, deviceId: string) => void;
  onNewSession?: (cwd: string, device?: SessionActivityDevice, subprojectId?: string, subprojectLabel?: string) => void;
  /** Open the owning project's Git worktree graph. */
  onOpenWorktreeGraph?: (projectRoot: string, device?: SessionActivityDevice) => void;
  onSessionDeleted?: (sessionId: string) => void;
  /** 远程设备会话操作通道（外层壳提供，iframe 转发到目标设备执行）。 */
  onRemoteMutate?: RemoteMutateFn;
  /** Reader: new-project panel targets this device (aggregate full view). */
  remotePeer?: string;
  /** 聚合页等待音（嵌入页形态由外层统一播报，传 false 防跨源双播）。 */
  soundAlerts?: boolean;
  /* Focused session is skipped only when ChatWindow owns its status sounds. */
  statusSoundOwner?: "chat" | "activity";
  activityScope?: ActivityScope;
  showDeviceSelector?: boolean;
  refreshKey?: number;
  viewedAtBySession: Record<string, number>;
  onViewedAtChange?: (viewedAt: Record<string, number>) => void;
  /** 只渲染设备/归档筛选行（外层保留设备筛选，不显示列表）。 */
  headerOnly?: boolean;
  /** 设备工作区嵌入时只保留设备切换控件，覆盖 iframe 自己的顶部栏。 */
  deviceSwitchOnly?: boolean;
  deviceSwitchValue?: string;
  /** 收纳/收藏页视图：设备下拉固定当前页选中项；其余控件保持同构。 */
  hiddenView?: boolean;
  favoriteView?: boolean;
  toDiscussView?: boolean;
  toReviseView?: boolean;
  completedView?: boolean;
  /** 下拉选「隐藏页/收藏页/收纳分类」：外层切换数据域。 */
  onOpenHidden?: () => void;
  onOpenFavorites?: () => void;
  onOpenToDiscuss?: () => void;
  onOpenToRevise?: () => void;
  onOpenCompleted?: () => void;
  /** Session-card Talk Map action; preserves the item device and focus session. */
  onOpenTalkMapForSession?: SessionActivityCardAction;
  /** Session-card context injection action. */
  onInjectContext?: SessionActivityCardAction;
  /** Session-card source identity copy action. */
  onCopySessionInfo?: SessionActivityCardAction;
}

export function SessionActivitySidebar({ selectedSessionId, selectedSessionKey, highlightedSessionId, leadingControl, onOpenSession, onActivityDeviceFilterChange, onProjectCwdChange, onProjectRemoved, onNewSession, onOpenWorktreeGraph, onSessionDeleted, onRemoteMutate, soundAlerts = true, statusSoundOwner = "chat", onDeviceChange, activityScope: requestedActivityScope = "all", showDeviceSelector = true, refreshKey, viewedAtBySession, onViewedAtChange, headerOnly = false, deviceSwitchOnly = false, deviceSwitchValue, remotePeer, hiddenView = false, favoriteView = false, toDiscussView = false, toReviseView = false, completedView = false, onOpenHidden, onOpenFavorites, onOpenToDiscuss, onOpenToRevise, onOpenCompleted, onOpenTalkMapForSession, onInjectContext, onCopySessionInfo }: SessionActivitySidebarProps) {
  const { t } = useI18n();
  const visibleSubagentParentIds = useSubagentVisibility();
  const activityScope = resolveActivityScope(requestedActivityScope, { hiddenView, favoriteView, toDiscussView, toReviseView, completedView });
  const isMobile = useIsMobile();
  const [projectDeleteConfirmKey, setProjectDeleteConfirmKey] = useState<string | null>(null);
  const [projectDeleteBusyKey, setProjectDeleteBusyKey] = useState<string | null>(null);
  const [projectDeleteError, setProjectDeleteError] = useState<string | null>(null);
  const [filters, setFilters] = useSharedActivityFilters();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SessionSearchResult[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchNonce, setSearchNonce] = useState(0);
  const [searchMatchFilter, setSearchMatchFilter] = useState<SessionSearchMatchFilter>("all");
  const searchSeqRef = useRef(0);

  const handleOpenSession = useCallback((item: SessionActivityItem, searchTerm?: string) => {
    onOpenSession(item, searchTerm, filters.device);
  }, [filters.device, onOpenSession]);

  // Debounced on-demand session-content search; aggregate scope fans out to
  // configured peers only while a query is active.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      searchSeqRef.current += 1;
      setSearchResults(null);
      setSearchLoading(false);
      setSearchError(null);
      return;
    }
    if (q.length < 2) {
      searchSeqRef.current += 1;
      setSearchResults(null);
      setSearchLoading(false);
      setSearchError(null);
      return;
    }
    const seq = ++searchSeqRef.current;
    const controller = new AbortController();
    setSearchLoading(true);
    setSearchError(null);
    const timer = setTimeout(() => {
      // 收纳/收藏页搜索走对应数据域；正常聚合页按设备筛选决定本机、指定设备或全部设备。
      const scopeQuery = activityScope === "hidden"
        ? filters.device === "all" ? "&scope=hidden" : `&scope=hidden&device=${encodeURIComponent(filters.device)}`
        : activityScope === "favorites"
          ? filters.device === "all" ? "&scope=favorites" : `&scope=favorites&device=${encodeURIComponent(filters.device)}`
          : activityScope === "to_discuss"
            ? filters.device === "all" ? "&scope=to_discuss" : `&scope=to_discuss&device=${encodeURIComponent(filters.device)}`
            : activityScope === "to_revise"
              ? filters.device === "all" ? "&scope=to_revise" : `&scope=to_revise&device=${encodeURIComponent(filters.device)}`
              : activityScope === "completed"
                ? filters.device === "all" ? "&scope=completed" : `&scope=completed&device=${encodeURIComponent(filters.device)}`
                : activityScope !== "all"
                  ? "&scope=local"
                  : filters.device === "all"
                    ? "&scope=all"
                    : `&scope=local&device=${encodeURIComponent(filters.device)}`;
      void fetch(`/api/sessions/search?q=${encodeURIComponent(q)}&archived=${filters.archiveView === "archived" ? "1" : "0"}&days=${encodeURIComponent(filters.days)}${scopeQuery}`, { signal: controller.signal })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<{ sessions: SessionSearchResult[] }>;
        })
        .then((data) => {
          if (searchSeqRef.current !== seq) return;
          setSearchResults(data.sessions ?? []);
          setSearchLoading(false);
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          if (searchSeqRef.current !== seq) return;
          setSearchError(err?.message || t("sidebar.searchFailed"));
          setSearchResults([]);
          setSearchLoading(false);
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [activityScope, filters.archiveView, filters.days, filters.device, searchQuery, searchNonce, t]);
  useEffect(() => {
    if (activityScope === "local" && filters.group === "device") setFilters({ group: "project" });
  }, [activityScope, filters.group, setFilters]);

  const activity = useSessionActivityData({
    filters,
    activityScope,
    viewedAtBySession,
    onViewedAtChange,
    refreshKey,
    onOpenSession: handleOpenSession,
    onProjectCwdChange,
    onProjectRemoved,
    onFilterChange: (patch) => setFilters(patch),
    activeSessionKey: selectedSessionKey,
    activeSessionId: selectedSessionId,
    soundAlerts,
    statusSoundOwner,
  });

  const visibleSearchResults = filterSearchResults(
    searchResults ?? [],
    activity.data?.sessions,
    activity.data?.device,
    activityScope,
    filters,
    viewedAtBySession,
    searchMatchFilter,
  ).filter((hit) => isVisibleSubagentSession(hit, visibleSubagentParentIds, selectedSessionId ?? undefined));

  if (activity.data?.sessions) registerSessionLineage(activity.data.sessions);

  const localDeviceId = activity.data?.device.id;
  const mutateSubprojects = activity.mutateSubprojects;
  const toggleSubprojectVisibility = useCallback(async (deviceId: string, subproject: SubprojectDefinition): Promise<boolean> => {
    const result = await mutateSubprojects(deviceId, "PATCH", { id: subproject.id, hidden: !Boolean(subproject.hidden) });
    return result.ok;
  }, [mutateSubprojects]);
  const hidden = hiddenView || activityScope === "hidden";
  const favorites = favoriteView || activityScope === "favorites";
  const toDiscuss = toDiscussView || activityScope === "to_discuss";
  const toRevise = toReviseView || activityScope === "to_revise";
  const completed = completedView || activityScope === "completed";
  const onHideDevice = useCallback((device: SessionActivityDevice) => {
    void activity.setHidden("device", device.id, true, device.id);
  }, [activity]);

  const [collapsedSidebarBranchKeys, setCollapsedSidebarBranchKeys] = useState<Set<string>>(() => new Set());
  const toggleSidebarBranch = useCallback((key: string) => {
    setCollapsedSidebarBranchKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  if (deviceSwitchOnly) return (
    <div className="session-activity-sidebar" style={{ display: "flex", alignItems: "flex-start", width: "100%", padding: "6px 6px 6px 8px", background: "var(--bg-panel)", color: "var(--text)" }}>
      <ActivityDeviceFilter
        value={deviceSwitchValue ?? filters.device}
        devices={activity.devices}
        activityScope={activityScope}
        compact
        showAddDevice
        onOpenHidden={onOpenHidden}
        onOpenFavorites={onOpenFavorites}
        onHideDevice={onHideDevice}
        onChange={(value) => {
          setFilters({ device: value, project: [] });
          const device = value === "all" ? null : activity.devices.find((candidate) => candidate.id === value) ?? null;
          onDeviceChange?.(device);
        }}
      />
    </div>
  );

  const renderSidebarSessionRow = (node: ActivitySessionNode, depth = 0, isLast = false, hasChildren = false) => {
    const item = node.item;
    const key = itemKey(item);
    const isBranchCollapsed = collapsedSidebarBranchKeys.has(key);
    return <SessionActivitySidebarRow key={key} item={item} sort={filters.sort} forked={Boolean(item.session.parentSessionId)} contextInjected={Boolean(item.session.contextSourceSessionId)} selected={selectedSessionKey ? key === selectedSessionKey : item.session.id === selectedSessionId} highlighted={item.session.id === highlightedSessionId} statusLabel={activity.statusLabel} formatTime={activity.formatTime} canMutate={item.device.id === localDeviceId} onRemoteMutate={onRemoteMutate} onOpen={() => activity.openActivitySession(item)} onOpenTalkMapForSession={onOpenTalkMapForSession} onInjectContext={onInjectContext} onCopySessionInfo={onCopySessionInfo} contextLabel={rowContextLabel(item, filters.group, activityScope, filters.device === "all")} costPeer={item.device.id === localDeviceId ? undefined : item.device.id} costRootRef={scrollRef} onChanged={() => void activity.refresh(item.device.id, true)} onSessionDeleted={onSessionDeleted} onRemoved={(sessionId) => activity.markSessionRemoved(sessionId)} onRestoreRemoved={(sessionId) => activity.unmarkSessionRemoved(sessionId)} onHide={!hidden ? () => void activity.setHidden("session", item.session.id, true, item.device.id) : undefined} onUnhide={hidden ? () => void activity.setHidden("session", item.session.id, false, item.device.id) : undefined} onFavorite={() => activity.setFavorite(item.session.id, true, item.device.id)} onUnfavorite={() => activity.setFavorite(item.session.id, false, item.device.id)} onSetCategory={(sessionId, category, deviceId) => activity.setCategory(sessionId, category, deviceId)} subprojects={activity.subprojects} onMoveToSubproject={activity.moveSessionToSubproject} hasSubagents={hasSubagentChildren(activity.data?.sessions ?? [], item)} subagentsVisible={visibleSubagentParentIds.has(item.session.id)} onToggleSubagents={() => setSubagentVisibility(item.session.id, !visibleSubagentParentIds.has(item.session.id))} t={t} depth={depth} hasChildren={hasChildren} branchCollapsed={isBranchCollapsed} onToggleBranch={hasChildren ? () => toggleSidebarBranch(key) : undefined} />;
  };

  return (
    <div className="session-activity-sidebar" style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%", background: "var(--bg-panel)", color: "var(--text)" }}>
      <div style={{ flexShrink: 0, borderBottom: "1px solid var(--border)" }}>
        <div
          data-layout-control-group="activity-sidebar"
          style={{
            display: "flex",
            alignItems: "center",
            height: isMobile ? 44 : 36,
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            flexShrink: 0,
          }}
        >
          {leadingControl}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0, padding: "0 8px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 6, flex: 1, minWidth: 0 }}>
              {showDeviceSelector ? (
                <ActivityDeviceFilter
                  value={
                    hidden
                      ? HIDDEN_PAGE_VALUE
                      : favorites
                        ? FAVORITES_PAGE_VALUE
                        : toDiscuss
                          ? TO_DISCUSS_PAGE_VALUE
                          : toRevise
                            ? TO_REVISE_PAGE_VALUE
                            : completed
                              ? COMPLETED_PAGE_VALUE
                              : filters.device
                  }
                  devices={activity.devices}
                  activityScope={activityScope}
                  compact
                  showAddDevice
                  hiddenView={hidden}
                  favoriteView={favorites}
                  toDiscussView={toDiscuss}
                  toReviseView={toRevise}
                  completedView={completed}
                  onOpenHidden={onOpenHidden}
                  onOpenFavorites={onOpenFavorites}
                  onOpenToDiscuss={onOpenToDiscuss}
                  onOpenToRevise={onOpenToRevise}
                  onOpenCompleted={onOpenCompleted}
                  onHideDevice={onHideDevice}
                  onChange={(value) => {
                    // 普通设备筛选只改变活动列表；外层仅在隐藏/收藏页时退出数据域。
                    setFilters({ device: value, project: [] });
                    const device = value === "all" ? null : activity.devices.find((candidate) => candidate.id === value) ?? null;
                    onActivityDeviceFilterChange?.(device);
                  }}
                />
              ) : <div aria-hidden="true" style={{ width: "100%" }} />}
              <FilterSelect
                value={filters.archiveView}
                onChange={(value) => setFilters({ archiveView: value as ArchiveView })}
                ariaLabel={t("sessionActivity.archiveView")}
                compact
                options={[
                  { value: "active", label: t("sessionActivity.activeSessions") },
                  { value: "archived", label: t("sessionActivity.archivedSessions") },
                ]}
              />
            </div>
            <NewProjectButton onRefresh={activity.refresh} remotePeer={remotePeer} />
          </div>
        </div>
        {!headerOnly && (
        <div style={{ padding: "8px 8px 6px", flexShrink: 0 }}>
          <SessionSearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={t("sessionActivity.searchPlaceholder")}
            title={t("sessionActivity.searchHint")}
            clearLabel={t("sessionActivity.clearSearch")}
          />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, marginTop: 6 }}>
          <ActivityProjectFilter
            values={filters.project}
            allowEmptySubprojectActions={(activityScope === "all" || activityScope === "local") && filters.archiveView === "active"}
            projects={activity.projects}
            devices={activity.devices}
            label={activity.projectFilterLabel}
            onChange={activity.handleProjectFilterChange}
            onDeleteProject={activity.handleDeleteKnownProject}
            onChangeVisibility={activity.changeProjectVisibility}
            allowProjectHiding={!hidden && Boolean(onOpenHidden)}
            subprojects={activity.subprojects}
            subprojectSortSettings={activity.subprojectSortSettings}
            sessionItems={activity.timeFiltered}
            mutateSubprojects={activity.mutateSubprojects}
            refresh={activity.refresh}
            onClose={activity.handleProjectFilterClose}
            showDeviceGroups={activity.showProjectDeviceGroups}
            t={t}
            compact
          />
          <FilterSelect
            value={filters.days}
            onChange={(value) => setFilters({ days: value as TimeRangeValue })}
            ariaLabel={t("sessionActivity.timeRange")}
            compact
            options={[{ value: "all", label: t("sessionActivity.allTime") }, ...["1", "3", "7", "14", "30", "90"].map((days) => ({ value: days, label: t("sessionActivity.withinDays", { count: Number(days) }) }))]}
          />
          <FilterSelect
            value={filters.group}
            onChange={(value) => setFilters({ group: value as GroupValue })}
            ariaLabel={t("sessionActivity.group")}
            compact
            options={[
              { value: "project", label: t("sessionActivity.groupProject") },
              { value: "worktree", label: t("sessionActivity.groupWorktree") },
              ...(activityScope === "all" && filters.device === "all" ? [{ value: "device", label: t("sessionActivity.groupDevice") }] : []),
              { value: "none", label: t("sessionActivity.groupNone") },
            ]}
          />
          <FilterSelect
            value={filters.sort}
            onChange={(value) => setFilters({ sort: value as SortValue })}
            ariaLabel={t("sessionActivity.sort")}
            title={filters.sort === "asked" ? t("sessionActivity.sortAskedHint") : filters.sort === "status" ? t("sessionActivity.sortStatusHint") : t("sessionActivity.sortRecentHint")}
            compact
            options={[
              { value: "asked", label: t("sessionActivity.sortAsked") },
              { value: "recent", label: t("sessionActivity.sortRecent") },
              { value: "status", label: t("sessionActivity.sortStatus") },
            ]}
          />
          </div>
        </div>
        )}
      </div>
      {!headerOnly && (
      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {hidden && activity.hiddenDevices.length > 0 && (
          <section>
            <div style={{ ...activitySidebarGroupHeaderStyle, width: "100%", justifyContent: "space-between" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden" }}>
                <EyeOff size={12} strokeWidth={1.8} aria-hidden="true" style={{ color: "var(--text-dim)" }} />
                <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("sessionActivity.hiddenDevices")}</strong>
              </span>
              <span style={{ color: "var(--text-dim)", fontSize: 10, fontWeight: 500, flexShrink: 0 }}>{activity.hiddenDevices.length}</span>
            </div>
            {activity.hiddenDevices.map((device) => (
              <div key={device.id} className="session-activity-sidebar-row" style={{ height: 44, display: "flex", alignItems: "center", gap: 8, padding: "0 8px 0 9px", borderBottom: "1px solid var(--border)" }}>
                <EyeOff size={13} strokeWidth={1.8} aria-hidden="true" style={{ color: "var(--text-dim)", flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: 12 }}>{deviceLabel(device.name)}</span>
                <span style={{ color: "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>{device.online === false ? t("sessionActivity.offline") : ""}</span>
                <ActivityActionButton title={t("sessionActivity.unhideDevice")} disabled={false} color="var(--text-dim)" onClick={() => void activity.setHidden("device", device.id, false, device.id)}>
                  <EyeOff size={12} strokeWidth={2} />
                </ActivityActionButton>
              </div>
            ))}
          </section>
        )}
        {searchQuery.trim().length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px 2px", color: "var(--text-muted)", fontSize: 10 }}>
            <span>{searchLoading ? t("sessionActivity.searching") : `${t("sessionActivity.searchResults")} ${visibleSearchResults.length}`}</span>
            {!searchLoading && <SessionSearchMatchFilterSelect value={searchMatchFilter} onChange={setSearchMatchFilter} />}
          </div>
        )}
        {searchQuery.trim().length > 0 && !searchLoading && searchError && (
          <div style={{ ...emptyStyle, color: "#dc2626" }}>
            <div>{searchError}</div>
            <button
              type="button"
              onClick={() => setSearchNonce((n) => n + 1)}
              style={{
                marginTop: 8,
                padding: "3px 8px",
                borderRadius: 4,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              {t("i18n.retry")}
            </button>
          </div>
        )}
        {searchQuery.trim().length > 0 && !searchLoading && !searchError && searchResults && visibleSearchResults.length === 0 && (
          <div style={emptyStyle}>{t("sessionActivity.searchNoResults")}</div>
        )}
        {searchQuery.trim().length > 0 && !searchLoading && !searchError && searchResults && visibleSearchResults.length > 0 && (
          visibleSearchResults.map((hit) => (
            <ActivitySearchHitRow
              key={`${hit.device?.id ?? "local"}:${hit.id}`}
              hit={hit}
              activityItems={activity.data?.sessions}
              visibleSubagentParentIds={visibleSubagentParentIds}
              viewedAtBySession={viewedAtBySession}
              sort={filters.sort}
              selected={selectedSessionKey ? itemKey(searchHitToItem(hit, activity.data?.device, activity.data?.sessions, viewedAtBySession)) === selectedSessionKey : hit.id === selectedSessionId}
              highlighted={hit.id === highlightedSessionId}
              localDevice={activity.data?.device}
              onSessionDeleted={onSessionDeleted}
              onRemoteMutate={onRemoteMutate}
              statusLabel={activity.statusLabel}
              formatTime={activity.formatTime}
              costRootRef={scrollRef}
              onOpen={() => activity.openActivitySession(searchHitToItem(hit, activity.data?.device, activity.data?.sessions, viewedAtBySession), hit.contentMatchCount > 0 ? searchQuery.trim() : undefined)}
              onOpenTalkMapForSession={onOpenTalkMapForSession}
              onInjectContext={onInjectContext}
              onCopySessionInfo={onCopySessionInfo}
              onChanged={() => setSearchNonce((n) => n + 1)}
              onHide={activityScope !== "hidden" ? () => void activity.setHidden("session", hit.id, true, hit.device?.id) : undefined}
              onUnhide={activityScope === "hidden" ? () => void activity.setHidden("session", hit.id, false, hit.device?.id) : undefined}
              onFavorite={() => activity.setFavorite(hit.id, true, hit.device?.id)}
              onUnfavorite={() => activity.setFavorite(hit.id, false, hit.device?.id)}
              onSetCategory={(sessionId, category, deviceId) => activity.setCategory(sessionId, category, deviceId)}
              subprojects={activity.subprojects}
              onMoveToSubproject={activity.moveSessionToSubproject}
            />
          ))
        )}
        {searchQuery.trim().length === 0 && activity.loading && (!activity.data || activity.data.sessions.length === 0) && <div style={emptyStyle}>{t("sessionActivity.loading")}</div>}
        {(activity.data?.metadataWarnings?.length ?? 0) > 0 && <div role="status" style={emptyStyle}>
          {t(activity.data!.metadataWarnings!.some(warning => warning.domain === "hidden") ? "sessionActivity.visibilityUnavailable" : "sessionActivity.metadataUnavailable")}
          <button type="button" onClick={() => void activity.refresh()} style={iconButtonStyle}>{t("sessionActivity.refresh")}</button>
        </div>}
        {searchQuery.trim().length === 0 && !activity.loading && activity.error && !activity.data && <div style={{ ...emptyStyle, color: "#dc2626" }}>{t("sessionActivity.loadFailed")}</div>}
        {searchQuery.trim().length === 0 && !activity.loading && activity.data && activity.groups.length === 0 && (
          <div style={emptyStyle}>
            <div>{hidden ? t("sessionActivity.noHidden") : favorites ? t("sessionActivity.noFavorites") : toDiscuss ? t("sessionActivity.noToDiscuss") : toRevise ? t("sessionActivity.noToRevise") : completed ? t("sessionActivity.noCompleted") : filters.archiveView === "archived" ? t("sessionActivity.noArchived") : t("sessionActivity.empty")}</div>

          </div>
        )}
        {searchQuery.trim().length === 0 && activity.groups.map(([groupKey, items, emptyProject]) => {
          const visibleItems = filterVisibleSubagentItems(items, visibleSubagentParentIds, selectedSessionId ?? undefined);
          const collapsed = filters.group !== "none" && collapsedGroups.includes(groupKey);
          const sessionProject = items[0] ? projectInfoFromSession(items[0]) : null;
          const groupProject = (filters.group === "project" || filters.group === "worktree") ? emptyProject ?? sessionProject : null;
          const groupName = groupProject?.label ?? deviceLabel(items[0]?.device.name ?? "-");
          const groupDevice = (filters.group === "project" || filters.group === "worktree") ? groupProject?.deviceName ?? null : null;
          const groupPath = (filters.group === "project" || filters.group === "worktree") ? groupProject?.path : undefined;
          const groupDeviceId = groupProject?.deviceId ?? items[0]?.device.id;
          const groupDeviceInfo = groupDeviceId ? activity.devices.find((device) => device.id === groupDeviceId) : undefined;
          const projectBucket = groupProject ? activity.projectBuckets.get(groupProject.key) : undefined;
          const groupSubprojects = groupDeviceId && groupProject
            ? projectBucket?.subprojects ?? activity.subprojects.filter((subproject) => subproject.deviceId === groupDeviceId && projectKeysMatch(subproject.projectKey, groupProject.projectKey))
            : [];
          const groupSubprojectSort = groupDeviceId && groupProject
            ? activity.subprojectSortSettings.find((setting) => setting.deviceId === groupDeviceId && projectKeysMatch(setting.projectKey, groupProject.projectKey))
            : undefined;
          const groupAllItems = groupProject && groupDeviceId
            ? activity.timeFiltered.filter((item) => item.device.id === groupDeviceId && projectKeysMatch(item.projectKey, groupProject.projectKey))
            : [];
          const emptyGroupSubprojects = emptySubprojectDefinitions(groupSubprojects, groupAllItems);
          const autoHiddenGroupSubprojectIds = new Set(
            groupSubprojectSort?.autoHideEmptySubprojects
              ? emptyGroupSubprojects.map((subproject) => subproject.id)
              : [],
          );
          const visibleGroupSubprojects = groupSubprojects.filter((subproject) => !subproject.hidden && !autoHiddenGroupSubprojectIds.has(subproject.id));
          const visibleGroupItems = filterSubprojectItems(visibleItems, hiddenSubprojectIdsFor(groupSubprojects, autoHiddenGroupSubprojectIds));
          const hasProjectSessions = Boolean(groupProject?.hasSessions || visibleItems.length > 0);
          const canDeleteProject = Boolean((filters.group === "project" || filters.group === "worktree") && !hasProjectSessions && groupProject?.saved && groupDeviceId);
          return (
            <section key={groupKey || "all"}>
              {filters.group !== "none" && (
                <ProjectPathContextMenu
                  path={groupPath}
                  deviceId={groupDeviceId}
                  canDelete={filters.group === "project" && canDeleteProject}
                  hasSessions={groupProject?.hasSessions ?? visibleItems.length > 0}
                  hasSubprojects={filters.group === "project" && groupSubprojects.length > 0}
                  autoHideEmptySubprojects={Boolean(groupSubprojectSort?.autoHideEmptySubprojects)}
                  onRequestDelete={() => {
                    setProjectDeleteError(null);
                    setProjectDeleteConfirmKey(groupKey);
                  }}
                  onDelete={filters.group === "project" && canDeleteProject && groupProject ? () => activity.handleDeleteKnownProject(groupProject) : undefined}
                  onHide={filters.group === "project" && !groupProject?.hidden && !hidden && groupProject && groupDeviceId ? () => activity.changeProjectVisibility(groupProject, true) : undefined}
                  onUnhide={filters.group === "project" && groupProject?.hidden && groupDeviceId ? () => activity.changeProjectVisibility(groupProject, false) : undefined}
                  onToggleAutoHideEmptySubprojects={filters.group === "project" && (activityScope === "all" || activityScope === "local") && filters.archiveView === "active" && groupDeviceId && groupProject ? () => toggleAutoHideEmptySubprojects(groupProject.projectKey, groupSubprojectSort, groupDeviceId, activity.mutateSubprojects, activity.refresh) : undefined}
                  subprojectAction={filters.group === "project" && groupProject && groupDeviceId ? <ActivitySubprojectManager projectKey={groupProject.projectKey} deviceId={groupDeviceId} definitions={groupSubprojects} sortSetting={groupSubprojectSort} sessionItems={groupAllItems} sessionSort={filters.sort} mutate={activity.mutateSubprojects} /> : filters.group === "worktree" && groupPath && groupProject && groupProject.isGit !== false ? <ActivityWorktreeManager projectRoot={groupPath} deviceId={groupDeviceId} localDeviceId={localDeviceId} gitKnown={groupProject.isGit === true} t={t} /> : undefined}
                  t={t}
                  style={{ ...activitySidebarGroupHeaderStyle, width: "100%" }}
                >
                  <div className="activity-project-header">
                    <button className="activity-group-toggle" type="button" onClick={() => setCollapsedGroups((current) => collapsed ? current.filter((key) => key !== groupKey) : [...current, groupKey])} aria-expanded={!collapsed} aria-haspopup={groupPath ? "menu" : undefined} style={{ ...groupToggleStyle, flex: 1, textAlign: "left" }}>
                      <span style={{ display: "inline-flex", flexShrink: 0, color: collapsed ? "#dc2626" : undefined, transform: collapsed ? "none" : "rotate(90deg)", transition: "transform 0.12s" }}><Icon name="chevron" size={12} /></span>
                      <span className="activity-project-identity">
                        <strong className="activity-project-name">{groupName}</strong>
                        {groupDevice && <span className="activity-project-device">· {groupDevice}</span>}
                      </span>
                    </button>
                    <div className="activity-project-action-group">
                      {(filters.group === "project" || filters.group === "worktree") && (
                        <div style={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
                          {filters.group === "project"
                            && groupSubprojects.length > 0
                            && (activityScope === "all" || activityScope === "local")
                            && filters.archiveView === "active"
                            && groupProject
                            && groupDeviceId && (
                              <AutoHideEmptySubprojectsButton
                                projectKey={groupProject.projectKey}
                                deviceId={groupDeviceId}
                                sortSetting={groupSubprojectSort}
                                mutate={activity.mutateSubprojects}
                                refresh={activity.refresh}
                                t={t}
                              />
                            )}
                          {filters.group === "project"
                            && groupPath
                            && groupDeviceId
                            && groupProject?.isGit === true
                            && onOpenWorktreeGraph && (
                            <button
                              className="activity-project-action"
                              type="button"
                              onClick={() => onOpenWorktreeGraph(groupPath, groupDeviceInfo)}
                              title={t("worktreeGraph.open")}
                              aria-label={t("worktreeGraph.open")}
                            >
                              <GitFork size={14} strokeWidth={1.8} aria-hidden="true" />
                            </button>
                          )}
                          <ActivityNewSessionButton
                            cwd={groupPath ?? null}
                            device={groupDeviceInfo}
                            localDeviceId={localDeviceId}
                            onNewSession={onNewSession}
                            t={t}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </ProjectPathContextMenu>
              )}
              {projectDeleteConfirmKey === groupKey && groupProject && (
                <div className="activity-project-delete-confirm activity-subproject-delete-confirm" role="alert">
                  <span>{t("sessionActivity.deleteProjectEmpty")}</span>
                  <button
                    type="button"
                    disabled={projectDeleteBusyKey !== null}
                    onClick={async () => {
                      setProjectDeleteBusyKey(groupKey);
                      setProjectDeleteError(null);
                      try {
                        await activity.handleDeleteKnownProject(groupProject);
                        setProjectDeleteConfirmKey(null);
                      } catch (error) {
                        setProjectDeleteError(error instanceof Error && error.message ? error.message : t("sessionActivity.projectPathActionFailed"));
                      } finally {
                        setProjectDeleteBusyKey(null);
                      }
                    }}
                  >
                    {t("sidebar.confirm")}
                  </button>
                  <button
                    type="button"
                    disabled={projectDeleteBusyKey !== null}
                    onClick={() => {
                      setProjectDeleteConfirmKey(null);
                      setProjectDeleteError(null);
                    }}
                  >
                    {t("sidebar.cancel")}
                  </button>
                </div>
              )}
              {projectDeleteError && projectDeleteConfirmKey === groupKey && (
                <div role="alert" style={{ padding: "2px 10px 4px", color: "#dc2626", fontSize: 10 }}>
                  {projectDeleteError}
                </div>
              )}
              {!collapsed && (() => {
                  if (filters.group === "worktree") return <WorktreeSessionBuckets onNewSession={onNewSession ? (cwd, deviceId) => onNewSession(cwd, deviceId ? activity.devices.find((d) => d.id === deviceId) : groupDeviceInfo) : undefined} focusSessionKey={selectedSessionKey ?? undefined} items={visibleGroupItems} inventoryProjectKey={groupProject?.projectKey} inventoryProjectRoot={groupPath} inventoryDeviceId={groupDeviceId} inventoryUrl={groupPath ? (groupDeviceId && groupDeviceId !== localDeviceId ? `/api/remote/worktrees?peer=${encodeURIComponent(groupDeviceId)}&cwd=${encodeURIComponent(groupPath)}` : `/api/worktrees?cwd=${encodeURIComponent(groupPath)}`) : undefined} sessionOf={item => item.session} deviceOf={item => item.device.id} mainLabel={t("sessionActivity.worktreeMain")} worktreeLabel={t("sessionActivity.worktreeLinked")} renderItems={rows => <SessionLineageBranchList variant="sidebar" collapsedBranchKeys={collapsedSidebarBranchKeys} nodes={buildSessionLineageTree(rows, filters.sort)} renderRow={renderSidebarSessionRow} />} />;
                  const definitions = filters.group === "project" && groupProject
                    ? groupSubprojects
                    : [];
                  return definitions.length > 0
                    ? <SubprojectBucketList
                      items={visibleGroupItems}
                      definitions={visibleGroupSubprojects}
                      projectKey={groupProject!.projectKey}
                      deviceId={groupDeviceId!}
                       projectCwd={groupPath ?? null}
                       newSessionDevice={groupDeviceInfo}
                       localDeviceId={localDeviceId}
                       onNewSession={onNewSession}
                      unclassifiedLabel={t("sessionActivity.unclassified")}
                      renderRow={renderSidebarSessionRow}
                       sortSetting={groupSubprojectSort}
                       sessionSort={filters.sort}
                       onSortSubprojects={(order) => activity.mutateSubprojects(groupDeviceId!, "PUT", { projectKey: groupProject!.projectKey, mode: "custom", order }).then((result) => result.ok)}
                      onToggleSubprojectVisibility={(subproject) => toggleSubprojectVisibility(groupDeviceId!, subproject)}
                      mutateSubprojects={activity.mutateSubprojects}
                      variant="sidebar"
                      collapsedBranchKeys={collapsedSidebarBranchKeys}
                    />
                    : <SessionLineageBranchList variant="sidebar" collapsedBranchKeys={collapsedSidebarBranchKeys} nodes={buildSessionLineageTree(visibleItems, filters.sort)} renderRow={renderSidebarSessionRow} />;
              })()}
            </section>
          );
        })}
      </div>
      )}
    </div>
  );
}

function NewProjectButton({ onRefresh, remotePeer }: { onRefresh: () => Promise<void>; remotePeer?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addProject = async (path: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(remotePeer ? `/api/remote/projects?peer=${encodeURIComponent(remotePeer)}` : "/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
      setOpen(false);
      await onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => { setError(null); setOpen(true); }}
        title={t("sessionActivity.newProject")}
        aria-label={t("sessionActivity.newProject")}
        style={iconButtonStyle}
      >
        <FolderPlus size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {open && <DirectoryPicker busy={busy} error={error} remotePeer={remotePeer} onCancel={() => setOpen(false)} onSelect={(path) => void addProject(path)} />}
    </>
  );
}

function ActivityNewSessionButton({ cwd, device, localDeviceId, onNewSession, subprojectId, subprojectLabel, t }: {
  cwd: string | null;
  device?: SessionActivityDevice;
  localDeviceId?: string;
  onNewSession?: (cwd: string, device?: SessionActivityDevice, subprojectId?: string, subprojectLabel?: string) => void;
  subprojectId?: string;
  subprojectLabel?: string;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const isLocal = Boolean(device && device.id === localDeviceId);
  const remoteAvailable = Boolean(device && !isLocal && device.url && device.online !== false);
  const enabled = Boolean(cwd && onNewSession) && (isLocal || remoteAvailable);
  const title = enabled
    ? t("sidebar.newSessionTitle", { path: cwd! })
    : device && !isLocal
      ? t("sessionActivity.remoteActionUnavailable")
      : t("sidebar.selectProject");
  return (
    <button
      type="button"
      onClick={() => { if (enabled && cwd) onNewSession?.(cwd, device, subprojectId, subprojectLabel); }}
      disabled={!enabled}
      title={title}
      aria-label={title}
      className="activity-project-action"
      style={{ color: enabled ? "var(--text-muted)" : "var(--text-dim)", cursor: enabled ? "pointer" : "not-allowed", opacity: enabled ? 1 : 0.6 }}
    >
      <MessageSquarePlus size={14} strokeWidth={1.8} aria-hidden="true" />
    </button>
  );
}

function SessionActivitySidebarRow({ item, selected, highlighted, contextLabel, searchLabels, forked = false, contextInjected = false, sort, statusLabel, formatTime, costPeer, costRootRef, canMutate, onRemoteMutate, onOpen, onOpenTalkMapForSession, onInjectContext, onCopySessionInfo, onChanged, onSessionDeleted, onHide, onUnhide, onRemoved, onRestoreRemoved, onFavorite, onUnfavorite, onSetCategory, subprojects = [], onMoveToSubproject, hasSubagents = false, subagentsVisible = false, onToggleSubagents, t, depth = 0, hasChildren = false, branchCollapsed = false, onToggleBranch }: {
  sort: SortValue;
  item: SessionActivityItem;
  selected: boolean;
  highlighted?: boolean;
  contextLabel?: string;
  searchLabels?: string[];
  /** True when this session was forked from another session. */
  forked?: boolean;
  /** True when this session received context from another session. */
  contextInjected?: boolean;
  hasSubagents?: boolean;
  subagentsVisible?: boolean;
  onToggleSubagents?: () => void;
  depth?: number;
  hasChildren?: boolean;
  branchCollapsed?: boolean;
  onToggleBranch?: () => void;
  statusLabel: (status: SessionActivityStatus) => string;
  formatTime: (value: string) => string;
  costPeer?: string;
  costRootRef?: CostRootRef;
  canMutate: boolean;
  onRemoteMutate?: RemoteMutateFn;
  onOpen: () => void;
  onOpenTalkMapForSession?: SessionActivityCardAction;
  onInjectContext?: SessionActivityCardAction;
  onCopySessionInfo?: SessionActivityCardAction;
  onChanged: () => void;
  onSessionDeleted?: (sessionId: string) => void;
  /** 正常视图：隐藏会话（写入数据所属设备）。 */
  onHide?: () => void;
  /** 隐藏页视图：取消隐藏会话。 */
  onUnhide?: () => void;
  /** 变更成功后从列表移除；归档/恢复请求期间保留行以显示忙碌或错误。 */
  onRemoved?: (sessionId: string) => void;
  onRestoreRemoved?: (sessionId: string) => void;
  onFavorite?: () => Promise<boolean> | void;
  onUnfavorite?: () => Promise<boolean> | void;
  onSetCategory?: (sessionId: string, category: SessionStorageCategory | null, deviceId?: string) => Promise<boolean> | void;
  subprojects?: SessionActivityResponse["subprojects"];
  onMoveToSubproject?: (item: SessionActivityItem, subprojectId: string | null) => Promise<boolean>;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const hover = useSessionHover();
  const [contextMenuPoint, setContextMenuPoint] = useState<{ x: number; y: number } | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const coarsePointer = useCoarsePointer();
  const actionsVisible = hover.hovered || coarsePointer;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.session.name ?? "");
  const [busy, setBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const title = sessionTitle(item);
  const modelValue = item.session.relation?.kind === "subagent" ? sessionModelValue(item.session, item.modelName) : undefined;
  const modelLabel = item.session.relation?.kind === "subagent"
    ? sessionModelLabel(modelValue) ?? t("sidebar.subagentModelPending")
    : undefined;
  const pointerDrag = useSessionSubprojectPointerDrag({
    projectKey: item.projectKey,
    deviceId: item.device.id,
    disabled: item.session.transient || item.device.online === false || !onMoveToSubproject,
    onMove: (subprojectId) => onMoveToSubproject ? onMoveToSubproject(item, subprojectId) : Promise.resolve(false),
  });
  const status = item.status;
  const subagentCompleted = hasCompletedSubagent(item);
  const { cost, costState, costStatus, cacheHitRate, missingPriceModels, pendingUsageCount, recordedOnly, costRef } = useLazySessionCost(item.session.id, item.session.modified, costPeer, costRootRef);
  const costValue = typeof cost === "number" ? cost : 0;
  const partialCost = costStatus === "partial";
  const formattedCost = partialCost
    ? `≥$${(Math.floor(costValue * 100) / 100).toFixed(2)}`
    : typeof cost === "number" && (costValue > 0 || recordedOnly) ? `$${costValue.toFixed(2)}` : null;
  const costText = costState === "loading" ? "…" : costState === "error" ? "?" : formattedCost;
  const unpricedText = missingPriceModels.length > 0 && !partialCost ? t("sessionActivity.unpriced") : null;
  const unpricedTitle = missingPriceModels.length > 0
    ? partialCost ? missingPriceModels.join(", ") : `${t("session.unpricedModels")}: ${missingPriceModels.join(", ")}`
    : undefined;
  const pendingUsageText = pendingUsageCount > 0 ? t("session.pendingUsageCount", { count: pendingUsageCount }) : null;
  const cacheHitText = cacheHitRate != null ? `CH ${cacheHitRate.toFixed(1)}%` : null;
  // 本机设备会话直接 fetch（同源）；远程设备会话经 onRemoteMutate（外层 iframe 通道）执行。
  const canRemote = !canMutate && item.device.online !== false && Boolean(onRemoteMutate);
  const canMutateAny = canMutate || canRemote;
  const mutateTitle = canMutate ? null : canRemote ? t("sessionActivity.remoteActionViaDevice") : t("sessionActivity.remoteActionUnavailable");
  const lifecycleManagedByParent = item.session.relation?.kind === "subagent";
  const lifecycleTitle = lifecycleManagedByParent ? t("sessionActivity.subagentLifecycleRequiresParent") : undefined;
  const cardActionProjectRoot = item.session.projectRoot?.trim() || item.session.cwd?.trim() || "";
  const hasFooterActions = Boolean(
    (onOpenTalkMapForSession && cardActionProjectRoot)
      || (onInjectContext && cardActionProjectRoot)
      || (onCopySessionInfo && item.session.path?.trim()),
  );

  const commitRename = async () => {
    const nextName = name.trim();
    setEditing(false);
    if (!canMutateAny || !nextName || nextName === (item.session.name ?? "")) return;
    setBusy(true);
    try {
      const ok = canMutate
        ? (await fetch(`/api/sessions/${encodeURIComponent(item.session.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: nextName }) })).ok
        : await onRemoteMutate!(item.device, "rename", item.session.id, nextName);
      if (ok) onChanged();
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!canMutateAny || busy || lifecycleManagedByParent) return;
    setArchiveError(null);
    setBusy(true);
    try {
      let ok: boolean;
      if (canMutate) {
        const response = await fetch(`/api/sessions/${encodeURIComponent(item.session.id)}/archive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived: !item.session.archived }) });
        await assertSessionMutationOk(response);
        ok = true;
      } else {
        ok = await onRemoteMutate!(item.device, item.session.archived ? "unarchive" : "archive", item.session.id);
      }
      if (!ok) throw new Error(t("sessionActivity.archiveFailed"));
      clearSessionActivityCache();
      onRemoved?.(item.session.id);
      onSessionDeleted?.(item.session.id);
      onChanged();
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!canMutateAny || busy || lifecycleManagedByParent) return;
    setConfirmDelete(false);
    setBusy(true);
    onRemoved?.(item.session.id);
    try {
      const ok = canMutate
        ? (await fetch(`/api/sessions/${encodeURIComponent(item.session.id)}`, { method: "DELETE" })).ok
        : await onRemoteMutate!(item.device, "delete", item.session.id);
      if (ok) {
        clearSessionActivityCache();
        onSessionDeleted?.(item.session.id);
        onChanged();
      } else {
        onRestoreRemoved?.(item.session.id);
      }
    } catch {
      onRestoreRemoved?.(item.session.id);
    } finally {
      setBusy(false);
    }
  };

  const requestDelete = () => {
    if (!canMutateAny || busy || lifecycleManagedByParent) return;
    setConfirmDelete(true);
  };

  return (
    <div
      ref={(node) => { costRef.current = node; rowRef.current = node; }}
      className="session-activity-sidebar-row"
      data-session-id={item.session.id}
      data-talk-map-highlighted={highlighted ? "true" : undefined}
      onPointerDown={pointerDrag.onPointerDown}
      onPointerMove={pointerDrag.onPointerMove}
      onPointerUp={pointerDrag.onPointerUp}
      onPointerCancel={pointerDrag.onPointerCancel}
      onClickCapture={pointerDrag.onClickCapture}
      onMouseEnter={hover.enter}
      onMouseLeave={hover.leave}
      onFocus={hover.enter}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hover.leave(); }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        window.getSelection()?.removeAllRanges();
        setContextMenuPoint({ x: event.clientX, y: event.clientY });
      }}
      style={{
        height: 54,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 8px 0 9px",
        borderBottom: "1px solid var(--border)",
        borderLeft: highlighted || selected ? "2px solid var(--accent)" : "2px solid transparent",
        background: confirmDelete ? "rgba(239,68,68,0.06)" : highlighted || selected ? "var(--bg-selected)" : hover.hovered ? "var(--bg-hover)" : "transparent",
        opacity: pointerDrag.dragging || busy ? 0.55 : 1,
        overflow: "visible",
        position: "relative",
        zIndex: contextMenuPoint ? 2 : 0,
        cursor: "pointer",
      }}
    >
          {editing ? (
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} onBlur={() => void commitRename()} onKeyDown={(event) => { if (event.key === "Enter") void commitRename(); if (event.key === "Escape") setEditing(false); }} style={sidebarRenameInputStyle} />
          ) : (
            <>
              <button data-session-open="true" type="button" onClick={() => { setArchiveError(null); onOpen(); }} style={sidebarRowButtonStyle}>
              {hasChildren && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleBranch?.();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.stopPropagation();
                      event.preventDefault();
                      onToggleBranch?.();
                    }
                  }}
                  title={branchCollapsed ? t("sessionActivity.expandBranch") : t("sessionActivity.collapseBranch")}
                  aria-label={branchCollapsed ? t("sessionActivity.expandBranch") : t("sessionActivity.collapseBranch")}
                  aria-expanded={!branchCollapsed}
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, padding: 0, color: "var(--text-dim)", cursor: "pointer", flexShrink: 0, transform: branchCollapsed ? "none" : "rotate(90deg)", transition: "transform 0.12s" }}
                >
                  <Icon name="chevron" size={11} />
                </span>
              )}
              {item.session.relation?.kind === "subagent" ? (
                <span title={t("sidebar.subagent")} style={{ display: "inline-flex", flexShrink: 0 }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-label={t("sidebar.subagent")} style={{ opacity: 0.85 }}>
                    <rect x="5" y="7" width="14" height="11" rx="2" /><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
                  </svg>
                </span>
              ) : forked ? (
                <span title={t("sessionActivity.forkedSession")} style={{ display: "inline-flex", flexShrink: 0 }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-label={t("sessionActivity.forkedSession")} style={{ opacity: 0.85 }}>
                    <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                </span>
              ) : contextInjected ? (
                <span title={t("sessionActivity.contextInjectedSession")} style={{ display: "inline-flex", flexShrink: 0 }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label={t("sessionActivity.contextInjectedSession")} style={{ opacity: 0.85 }}>
                    <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.07 0l-3 3A5 5 0 0 0 9 21l1.71-1.71" />
                  </svg>
                </span>
              ) : null}
              <span style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: statusColor(status) }} />
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" }}>
                <span className="activity-session-title" title={title} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: 12, fontWeight: highlighted || selected ? 500 : 400, lineHeight: 1.35 }}>{title}</span>
                {searchLabels && searchLabels.length > 0 && <span title={searchLabels.join(" · ")} style={{ alignSelf: "flex-start", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: "1px 4px", border: "1px solid var(--border)", borderRadius: 3, color: "var(--accent)", fontSize: 9, lineHeight: 1.15 }}>{searchLabels.join(" · ")}</span>}
                {archiveError && <span role="alert" title={archiveError} aria-label={archiveError} style={{ color: "#dc2626", fontSize: 11, fontWeight: 700, flexShrink: 0, cursor: "help" }}>!</span>}
                <span className="activity-session-meta" style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, lineHeight: 1.35, whiteSpace: "nowrap" }}>
                  <span style={{ color: statusColor(status) }}>{statusLabel(status)}</span>
                  {item.category && (
                    <>
                      <span aria-hidden="true" style={{ color: "var(--text-dim)" }}>·</span>
                      <span
                        style={{
                          color: item.category === "to_discuss"
                            ? "#3b82f6"
                            : item.category === "to_revise"
                              ? "#f59e0b"
                              : "#10b981",
                          fontWeight: 600,
                          flexShrink: 0,
                        }}
                      >
                        {t(`sessionActivity.${item.category === "to_discuss" ? "toDiscuss" : item.category === "to_revise" ? "toRevise" : "completed"}`)}
                      </span>
                    </>
                  )}
                  {subagentCompleted && <><span aria-hidden="true" style={{ color: "var(--text-dim)" }}>·</span><span title={t("sessionActivity.subagentCompletedHint")} style={{ color: "#2563eb" }}>{t("sessionActivity.subagentCompleted")}</span></>}
                  <span aria-hidden="true" style={{ color: "var(--text-dim)" }}>·</span>
                  <span style={{ color: "var(--text-dim)" }}>{formatTime(itemTime(item, sort))}</span>
                  {modelLabel && <><span aria-hidden="true" style={{ color: "var(--text-dim)" }}>·</span><span title={modelValue ?? modelLabel} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{modelLabel}</span></>}
                  {costText && <><span aria-hidden="true" style={{ color: "var(--text-dim)" }}>·</span><span title={[recordedOnly ? t("session.costPartialHint") : "", partialCost ? unpricedTitle : ""].filter(Boolean).join(" · ") || undefined} style={{ color: sessionCostColor(costValue) }}>{costText}</span></>}
                  {unpricedText && <><span aria-hidden="true" style={{ color: "var(--text-dim)" }}>·</span><span title={unpricedTitle} style={{ color: "#d97706", fontWeight: 600 }}>{unpricedText}</span></>}
                  {pendingUsageText && <><span aria-hidden="true" style={{ color: "var(--text-dim)" }}>·</span><span title={pendingUsageText} style={{ color: "#d97706", fontWeight: 600 }}>{pendingUsageText}</span></>}
                  {cacheHitText && <><span aria-hidden="true" style={{ color: "var(--text-dim)" }}>·</span><span style={{ color: "var(--text-dim)" }}>{cacheHitText}</span></>}
                  {contextLabel && <><span aria-hidden="true" style={{ color: "var(--text-dim)" }}>·</span><span style={{ color: "var(--text-dim)" }}>{contextLabel}</span></>}
                </span>
              </span>
              </button>
            </>
          )}
            {confirmDelete ? (
            <SessionDeleteActions onConfirm={() => void remove()} onCancel={() => setConfirmDelete(false)} disabled={busy} t={t} />
          ) : actionsVisible && !editing && (
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              <ActivityActionButton
                title={mutateTitle ?? t("sessionActivity.rename")}
                disabled={!canMutateAny || busy}
                onClick={() => { setName(item.session.name ?? ""); setEditing(true); }}
              >
                <Pencil size={12} strokeWidth={2} />
              </ActivityActionButton>
              <ActivityActionButton
                title={archiveError ?? lifecycleTitle ?? (mutateTitle ?? (item.session.archived ? t("sessionActivity.restore") : t("sessionActivity.archive")))}
                disabled={!canMutateAny || busy || lifecycleManagedByParent}
                onClick={() => void archive()}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="21 8 21 21 3 21 3 8" /><rect x="1" y="3" width="22" height="5" /><line x1="10" y1="12" x2="14" y2="12" /></svg>
              </ActivityActionButton>
                <ActivityActionButton
                  title={lifecycleTitle ?? mutateTitle ?? t("sessionActivity.delete")}
                  disabled={!canMutateAny || busy || lifecycleManagedByParent}
                  onClick={requestDelete}
                  danger
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
                </ActivityActionButton>
              </div>
          )}
          {contextMenuPoint && (
            <SessionContextMenu
              item={item}
              canMutateAny={canMutateAny}
              busy={busy}
              mutateTitle={mutateTitle}
              position={contextMenuPoint}
              onClose={() => setContextMenuPoint(null)}
              subprojects={subprojects}
              onMoveToSubproject={onMoveToSubproject}
              hasSubagents={hasSubagents}
              subagentsVisible={subagentsVisible}
              onToggleSubagents={onToggleSubagents}
              onFavorite={onFavorite}
              onUnfavorite={onUnfavorite}
              onSetCategory={onSetCategory}
              onHide={onHide}
              onUnhide={onUnhide}
              onRename={() => { setName(item.session.name ?? ""); setEditing(true); }}
              onArchive={() => void archive()}
              archiveDisabled={!canMutateAny || busy || lifecycleManagedByParent}
              archiveTitle={archiveError ?? lifecycleTitle ?? (mutateTitle ?? (item.session.archived ? t("sessionActivity.restore") : t("sessionActivity.archive")))}
              onDelete={requestDelete}
              deleteDisabled={!canMutateAny || busy || lifecycleManagedByParent}
              deleteTitle={lifecycleTitle ?? mutateTitle ?? t("sessionActivity.delete")}
              t={t}
            />
          )}
          <SessionHoverPreview
            sessionId={item.session.id}
            version={item.session.modified}
            deviceId={item.device.id}
            peer={costPeer}
            initialRecap={item.lastRecap}
            activityItem={item}
            activitySort={sort}
            activityFormatTime={formatTime}
            activityStatusLabel={statusLabel}
            activityContextLabel={contextLabel}
            activityCostPeer={costPeer}
            activityCostRootRef={costRootRef}
            footerActions={hasFooterActions ? <SessionCardQuickActions item={item} onOpenTalkMapForSession={onOpenTalkMapForSession} onInjectContext={onInjectContext} onCopySessionInfo={onCopySessionInfo} t={t} compact /> : undefined}
            anchorRef={rowRef}
            visible={hover.hovered && !confirmDelete && !editing && !item.session.transient}
            onMouseEnter={hover.enter}
            onMouseLeave={hover.leave}
            onInteraction={hover.keepOpenBriefly}
            onDismiss={hover.dismiss}
          />
    </div>
  );
}

function SessionRowExtraActions({ item, canMutateAny, busy, mutateTitle, onClose, onOpenTalkMapForSession, onInjectContext, onCopySessionInfo, onArchive, archiveDisabled, archiveTitle, onDelete, deleteDisabled, deleteTitle, onHide, onUnhide, onFavorite, onUnfavorite, onRename, subprojects = [], onMoveToSubproject, t, style }: {
  item: SessionActivityItem;
  canMutateAny: boolean;
  busy: boolean;
  mutateTitle: string | null;
  onClose: () => void;
  onOpenTalkMapForSession?: SessionActivityCardAction;
  onInjectContext?: SessionActivityCardAction;
  onCopySessionInfo?: SessionActivityCardAction;
  onHide?: () => void;
  onUnhide?: () => void;
  onFavorite?: () => Promise<boolean> | void;
  onUnfavorite?: () => Promise<boolean> | void;
  onRename: () => void;
  onArchive?: () => void;
  archiveDisabled?: boolean;
  archiveTitle?: string;
  onDelete?: () => void;
  deleteDisabled?: boolean;
  deleteTitle?: string;
  subprojects?: NonNullable<SessionActivityResponse["subprojects"]>;
  onMoveToSubproject?: (item: SessionActivityItem, subprojectId: string | null) => Promise<boolean>;
  t: (key: string, params?: Record<string, string | number>) => string;
  style?: React.CSSProperties;
}) {
  return (
    <div data-session-row-extra-actions={item.session.id} style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: 6, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", boxShadow: "0 5px 14px rgba(0,0,0,0.12)", ...style }}>
      <SessionCardQuickActions
        item={item}
        onOpenTalkMapForSession={onOpenTalkMapForSession ? (target) => { onClose(); onOpenTalkMapForSession(target); } : undefined}
        onInjectContext={onInjectContext ? (target) => { onClose(); onInjectContext(target); } : undefined}
        onCopySessionInfo={onCopySessionInfo ? (target) => { onClose(); return onCopySessionInfo(target); } : undefined}
        t={t}
      />
      {onArchive && (
        <ActivityActionButton title={archiveTitle ?? mutateTitle ?? t("sessionActivity.archive")} disabled={archiveDisabled ?? (!canMutateAny || busy)} onClick={() => { onClose(); onArchive(); }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="21 8 21 21 3 21 3 8" /><rect x="1" y="3" width="22" height="5" /><line x1="10" y1="12" x2="14" y2="12" /></svg>
        </ActivityActionButton>
      )}
      {onDelete && (
        <ActivityActionButton title={deleteTitle ?? mutateTitle ?? t("sessionActivity.delete")} disabled={deleteDisabled ?? (!canMutateAny || busy)} onClick={() => { onClose(); onDelete(); }} danger>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1 1h4a1 1 0 0 1 1 1v2" /></svg>
        </ActivityActionButton>
      )}
      {onMoveToSubproject && !item.session.transient && (
        <SessionSubprojectMenu
          subprojects={subprojects.filter((subproject) => subproject.deviceId === item.device.id && projectKeysMatch(subproject.projectKey, item.projectKey))}
          currentSubprojectId={item.session.subprojectId}
          ownerId={item.session.id}
          disabled={item.device.online === false}
          onMove={(subprojectId) => onMoveToSubproject(item, subprojectId)}
          onMoved={onClose}
        />
      )}
      {onUnhide ? (
        <ActivityActionButton title={t("sessionActivity.unhideSession")} disabled={busy} color="var(--text-dim)" onClick={() => { onClose(); void onUnhide(); }}>
          <EyeOff size={12} strokeWidth={2} />
        </ActivityActionButton>
      ) : onHide ? (
        <ActivityActionButton title={t("sessionActivity.hideSession")} disabled={busy} color="var(--accent)" onClick={() => { onClose(); void onHide(); }}>
          <Eye size={12} strokeWidth={2} />
        </ActivityActionButton>
      ) : null}
      {(onFavorite || onUnfavorite) && (
        <ActivityActionButton title={item.favorite ? t("sessionActivity.unfavoriteSession") : t("sessionActivity.favoriteSession")} disabled={!canMutateAny || busy} onClick={() => { onClose(); void (item.favorite ? onUnfavorite : onFavorite)?.(); }}>
          <Star size={12} strokeWidth={2} fill={item.favorite ? "currentColor" : "none"} />
        </ActivityActionButton>
      )}
      <ActivityActionButton title={mutateTitle ?? t("sessionActivity.rename")} disabled={!canMutateAny || busy} onClick={() => { onClose(); onRename(); }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
      </ActivityActionButton>
    </div>
  );
}

function SessionDeleteActions({ onConfirm, onCancel, disabled, t }: {
  onConfirm: () => void;
  onCancel: () => void;
  disabled: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
      <button type="button" onClick={(event) => { event.stopPropagation(); onConfirm(); }} disabled={disabled} style={{ height: 30, padding: "0 10px", border: "none", borderRadius: 6, background: "#ef4444", color: "#fff", cursor: disabled ? "wait" : "pointer", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", opacity: disabled ? 0.7 : 1 }}>
        {t("sidebar.confirm")}
      </button>
      <button type="button" onClick={(event) => { event.stopPropagation(); onCancel(); }} disabled={disabled} style={{ height: 30, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text-muted)", cursor: disabled ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 500, whiteSpace: "nowrap" }}>
        {t("sidebar.cancel")}
      </button>
    </div>
  );
}

function ActivityActionButton({ title, disabled, onClick, danger = false, color = "var(--text-muted)", compact = false, children }: { title: string; disabled: boolean; onClick: () => void; danger?: boolean; color?: string; compact?: boolean; children: React.ReactNode }) {
  return <button
    className="activity-action-button"
    type="button"
    title={title}
    aria-label={title}
    disabled={disabled}
    onClick={(event) => { event.stopPropagation(); onClick(); }}
    onMouseEnter={(event) => {
      if (disabled) return;
      if (compact) {
        event.currentTarget.style.background = danger ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.14)";
        event.currentTarget.style.color = danger ? "#f87171" : "rgba(255,255,255,0.96)";
        event.currentTarget.style.borderColor = danger ? "rgba(239,68,68,0.45)" : "rgba(255,255,255,0.26)";
      } else {
        event.currentTarget.style.background = danger ? "rgba(239,68,68,0.08)" : "var(--bg-selected)";
        event.currentTarget.style.color = danger ? "#ef4444" : "var(--accent)";
        event.currentTarget.style.borderColor = danger ? "rgba(239,68,68,0.35)" : "rgba(37,99,235,0.35)";
      }
    }}
    onMouseLeave={(event) => {
      if (compact) {
        event.currentTarget.style.background = "rgba(255,255,255,0.06)";
        event.currentTarget.style.color = color;
        event.currentTarget.style.borderColor = "rgba(255,255,255,0.12)";
      } else {
        event.currentTarget.style.background = "var(--bg-hover)";
        event.currentTarget.style.color = color;
        event.currentTarget.style.borderColor = "var(--border)";
      }
    }}
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      width: compact ? 22 : 32,
      height: compact ? 22 : 32,
      padding: 0,
      background: compact ? "rgba(255,255,255,0.06)" : "var(--bg-hover)",
      border: compact ? "1px solid rgba(255,255,255,0.12)" : "1px solid var(--border)",
      borderRadius: compact ? 5 : 7,
      color,
      opacity: disabled ? 0.35 : 1,
      cursor: disabled ? "not-allowed" : "pointer",
      flexShrink: 0,
      transition: "background 0.12s, color 0.12s, border-color 0.12s",
    }}
  >{children}</button>;
}

function SessionCardQuickActions({ item, onOpenTalkMapForSession, onInjectContext, onCopySessionInfo, t, compact = false }: {
  item: SessionActivityItem;
  onOpenTalkMapForSession?: SessionActivityCardAction;
  onInjectContext?: SessionActivityCardAction;
  onCopySessionInfo?: SessionActivityCardAction;
  t: (key: string, params?: Record<string, string | number>) => string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copyResetTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
  }, []);
  const copySource = async () => {
    if (!onCopySessionInfo) return;
    try {
      await onCopySessionInfo(item);
      setCopied(true);
      if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = window.setTimeout(() => {
        copyResetTimerRef.current = null;
        setCopied(false);
      }, 1400);
    } catch {
      setCopied(false);
    }
  };
  const projectRoot = item.session.projectRoot?.trim() || item.session.cwd?.trim() || "";
  const hasSourcePath = Boolean(item.session.path?.trim());
  const showTalkMap = Boolean(onOpenTalkMapForSession && projectRoot);
  const showInjectContext = Boolean(onInjectContext && projectRoot);
  const showCopySource = Boolean(onCopySessionInfo && hasSourcePath);
  if (!showTalkMap && !showInjectContext && !showCopySource) return null;
  const iconSize = compact ? 12 : 13;
  const buttonColor = compact ? "rgba(255,255,255,0.72)" : "var(--text-muted)";
  return (
    <div data-session-card-actions={item.session.id} style={{ display: "flex", gap: 4, flexShrink: 0, alignItems: "center" }}>
      {showTalkMap && (
        <ActivityActionButton title={t("talkMap.locateSession")} disabled={false} onClick={() => onOpenTalkMapForSession?.(item)} color={buttonColor} compact={compact}>
          <MapIcon size={iconSize} strokeWidth={1.8} aria-hidden="true" />
        </ActivityActionButton>
      )}
      {showInjectContext && (
        <ActivityActionButton title={t("talkMap.injectContext")} disabled={false} onClick={() => onInjectContext?.(item)} color={buttonColor} compact={compact}>
          <FileInput size={iconSize} strokeWidth={1.8} aria-hidden="true" />
        </ActivityActionButton>
      )}
      {showCopySource && (
        <ActivityActionButton title={copied ? t("session.copied") : t("session.copySourceInfo")} disabled={false} onClick={() => void copySource()} color={copied ? "var(--accent)" : buttonColor} compact={compact}>
          <span aria-hidden="true" style={{ position: "relative", display: "inline-flex", width: iconSize, height: iconSize }}>
            <Copy size={iconSize} strokeWidth={1.8} style={{ position: "absolute", inset: 0, opacity: copied ? 0 : 1, transform: copied ? "scale(0.65)" : "scale(1)", transition: "opacity 140ms ease, transform 160ms ease" }} />
            <Check size={iconSize} strokeWidth={2.1} style={{ position: "absolute", inset: 0, opacity: copied ? 1 : 0, transform: copied ? "scale(1)" : "scale(0.65)", transition: "opacity 140ms ease, transform 160ms ease" }} />
          </span>
        </ActivityActionButton>
      )}
    </div>
  );
}

const sidebarSelectStyle: React.CSSProperties = { flex: 1, minWidth: 0, height: 26, padding: "0 6px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text-muted)", fontSize: 11 };
const sidebarRowButtonStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 7, flex: 1, minWidth: 0, minHeight: 54, padding: "6px 0", border: 0, background: "none", color: "inherit", textAlign: "left", cursor: "pointer" };
const sidebarRenameInputStyle: React.CSSProperties = { boxSizing: "border-box", width: "calc(100% - 14px)", height: 28, margin: "12px 7px", padding: "0 7px", border: "1px solid var(--accent)", borderRadius: 4, outline: "none", background: "var(--bg)", color: "var(--text)", fontSize: 12 };


/** Lightweight row for a session-content search hit (local device only). */
function ActivitySearchHitRow({
  hit,
  selected,
  highlighted,
  localDevice,
  activityItems,
  visibleSubagentParentIds,
  viewedAtBySession,
  sort,
  statusLabel,
  formatTime,
  onSessionDeleted,
  onOpen,
  onOpenTalkMapForSession,
  onInjectContext,
  onCopySessionInfo,
  onChanged,
  onRemoteMutate,
  costRootRef,
  onHide,
  onUnhide,
  onFavorite,
  onUnfavorite,
  onSetCategory,
  subprojects = [],
  onMoveToSubproject,
}: {
  activityItems?: readonly SessionActivityItem[];
  visibleSubagentParentIds: ReadonlySet<string>;
  viewedAtBySession?: Record<string, number>;
  sort: SortValue;
  hit: SessionSearchResult;
  selected: boolean;
  highlighted?: boolean;
  localDevice: SessionActivityDevice | undefined;
  onRemoteMutate?: RemoteMutateFn;
  costRootRef?: CostRootRef;
  statusLabel: (status: SessionActivityStatus) => string;
  onSessionDeleted?: (sessionId: string) => void;
  formatTime: (value: string) => string;
  onOpen: () => void;
  onOpenTalkMapForSession?: SessionActivityCardAction;
  onInjectContext?: SessionActivityCardAction;
  onCopySessionInfo?: SessionActivityCardAction;
  onChanged: () => void;
  onHide?: () => void;
  onUnhide?: () => void;
  onFavorite?: () => Promise<boolean> | void;
  onUnfavorite?: () => Promise<boolean> | void;
  onSetCategory?: (sessionId: string, category: SessionStorageCategory | null, deviceId?: string) => Promise<boolean> | void;
  subprojects?: SessionActivityResponse["subprojects"];
  onMoveToSubproject?: (item: SessionActivityItem, subprojectId: string | null) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const item = searchHitToItem(hit, localDevice, activityItems, viewedAtBySession);
  const canMutate = !hit.device || hit.device.id === localDevice?.id;
  const searchLabels = sessionSearchResultSources(hit).map((source) => source === "content"
    ? t("sessionActivity.searchContentMatch", { count: hit.contentMatchCount })
    : source === "title"
      ? t("sessionActivity.searchTitleMatch", { count: hit.titleMatchCount ?? 0 })
      : t("sessionActivity.searchIdMatch"));
  return (
    <div style={{ background: "var(--bg-panel)" }}>
      <SessionActivitySidebarRow
        item={item}
        sort={sort}
        selected={selected}
        highlighted={highlighted}
        searchLabels={searchLabels}
        forked={Boolean(hit.parentSessionId)}
        contextInjected={Boolean(hit.contextSourceSessionId)}
        statusLabel={statusLabel}
        formatTime={formatTime}
        costPeer={hit.device && hit.device.id !== localDevice?.id ? hit.device.id : undefined}
        costRootRef={costRootRef}
        onSessionDeleted={onSessionDeleted}
        canMutate={canMutate}
        onRemoteMutate={onRemoteMutate}
        onOpen={onOpen}
        onOpenTalkMapForSession={onOpenTalkMapForSession}
        onInjectContext={onInjectContext}
        onCopySessionInfo={onCopySessionInfo}
        onChanged={onChanged}
        onHide={onHide}
        onUnhide={onUnhide}
        onFavorite={onFavorite}
        onUnfavorite={onUnfavorite}
        onSetCategory={onSetCategory}
        subprojects={subprojects}
        onMoveToSubproject={onMoveToSubproject}
        hasSubagents={hasSubagentChild(activityItems ?? [], hit.id, hit.device?.id)}
        subagentsVisible={visibleSubagentParentIds.has(hit.id)}
        onToggleSubagents={() => setSubagentVisibility(hit.id, !visibleSubagentParentIds.has(hit.id))}
        t={t}
      />
    </div>
  );
}

function searchHitToItem(
  hit: SessionSearchResult,
  localDevice: SessionActivityDevice | undefined,
  activityItems: readonly SessionActivityItem[] = [],
  viewedAtBySession: Record<string, number> = {},
): SessionActivityItem {
  const deviceId = hit.device?.id ?? localDevice?.id;
  const current = activityItems.find((item) => (
    item.session.id === hit.id && (!deviceId || item.device.id === deviceId)
  ));
  if (current) {
    return {
      ...current,
      session: hit,
      device: hit.device ?? current.device,
      status: effectiveStatus(current, viewedAtBySession),
      favorite: hit.favorite ?? current.favorite,
      category: current.category,
      lastActivityAt: hit.activityAt ?? current.lastActivityAt,
    };
  }
  const projectRoot = hit.projectRoot ?? hit.cwd;
  return {
    device: hit.device ?? localDevice ?? { id: "local", name: "local" },
    session: hit,
    favorite: Boolean(hit.favorite),
    projectKey: hit.projectKey ?? projectRoot,
    projectLabel: projectRoot.split("/").filter(Boolean).pop() ?? projectRoot,
    status: "idle",
    lastUserMessage: hit.firstMessage,
    lastActivityAt: hit.activityAt ?? hit.modified,
    latestRun: null,
    runs: [],
  };
}

function filterSearchResults(
  hits: readonly SessionSearchResult[],
  activityItems: readonly SessionActivityItem[] | undefined,
  localDevice: SessionActivityDevice | undefined,
  activityScope: ActivityScope,
  filters: Pick<SharedActivityFilters, "device" | "project" | "status" | "sort">,
  viewedAtBySession: Record<string, number>,
  searchMatchFilter: SessionSearchMatchFilter,
): SessionSearchResult[] {
  const matched = hits.flatMap((hit) => {
    if (!sessionSearchResultMatchesFilter(hit, searchMatchFilter)) return [];
    const item = searchHitToItem(hit, localDevice, activityItems, viewedAtBySession);
    if (!matchesActivityDevice(item.device.id, filters.device, activityScope)) return [];
    const projectKey = activityProjectFilterKey(item.projectKey, item.device.id);
    if (filters.project.length > 0 && !filters.project.includes(projectKey) && !filters.project.includes(item.projectKey)) return [];
    if (filters.status !== "all" && item.status !== filters.status) return [];
    return [{ hit, item }];
  });
  matched.sort((a, b) => {
    if (Boolean(a.hit.idMatch) !== Boolean(b.hit.idMatch)) return a.hit.idMatch ? -1 : 1;
    return compareBySort(a.item, b.item, filters.sort);
  });
  return matched.map(({ hit }) => hit);
}
