"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { Archive, Check, Copy, ExternalLink, Eye, EyeOff, FileInput, GitFork, Link2, List, Lock, Maximize2, MessageSquarePlus, PanelLeft, RefreshCw, RotateCcw, StickyNote, Trash2, Unlock, X, ZoomIn, ZoomOut } from "lucide-react";
import type { SessionActivityItem, SessionActivityResponse, SessionActivityStatus, SessionActivitySubprojectSortSetting } from "@/lib/session-activity-types";
import { compareSessionActivityItems as compareBySort, filterSessionsByActivityTime, type ActivityTimeRange } from "@/lib/session-activity-filters";
import { apiPathForPeer } from "@/lib/file-api";
import { clearSessionActivityCache, fetchSessionActivity } from "@/lib/session-activity-fetch";
import { applySessionActivityItemsEvent, type SessionActivityEventPayload } from "@/lib/session-activity-client";
import { groupBySubproject, UNCLASSIFIED_SUBPROJECT_ID, orderedSubprojectIds, projectKeysMatch, reorderSubprojectIds } from "@/lib/subproject-groups";
import { useSessionDetails } from "@/hooks/useSessionDetails";
import { formatUserQuestion, stripHiddenUserQuestion } from "@/lib/session-hover-preview";
import { sessionRecapDisplay } from "@/lib/session-recap";
import { skillExpansionToCommand } from "@/lib/slash-display";
import type { SubprojectDefinition, SubprojectSortSetting } from "@/lib/subproject-state";
import type { SessionInfo } from "@/lib/types";
import {
  defaultTalkMapCamera,
  defaultTalkMapLayout,
  defaultTalkMapPosition,
  type TalkMapBoard,
  type TalkMapCamera,
  type TalkMapEdge,
  type TalkMapLayoutState,
  type TalkMapFrame,
  type TalkMapGhostCardState,
  type TalkMapMutation,
} from "@/lib/talk-map-types";
import {
  buildTalkMapSubprojectLayout,
  filterTalkMapSessions,
  reorderTalkMapSessionOrder,
  talkMapSubprojectContentYForClient,
  talkMapSubprojectDropIndex,
  talkMapSubprojectPointInRect,
  TALK_MAP_SUBPROJECT_FRAME_HEIGHT,
  TALK_MAP_SUBPROJECT_HEADER_HEIGHT,
  TALK_MAP_SUBPROJECT_STAGE_PADDING,
  TALK_MAP_SUBPROJECT_VERTICAL_PADDING,
  talkMapSubprojectFrameHeight,
  type TalkMapSubprojectLayout,
  type TalkMapSubprojectModule,
} from "@/lib/talk-map-layout";
import { useI18n } from "@/hooks/useI18n";
import { useSharedActivityFilters } from "./SessionActivityPanel";
import { ReaderFloatingSelect } from "./ReaderFloatingSelect";
import { SessionSubprojectMenu } from "./SessionSubprojectMenu";
import { SessionActivityMeta, sessionActivityStatusColor } from "./SessionActivityMeta";
import { SessionListMeta } from "./SessionListMeta";
import { notifyEmbeddedModalState } from "@/lib/embedded-modal";

interface Props {
  open: boolean;
  projectRoot: string | null;
  deviceName?: string | null;
  focusSessionId?: string | null;
  remotePeer?: string;
  refreshKey?: number;
  onClose: () => void;
  onNewSession?: (subprojectId?: string, subprojectLabel?: string) => void;
  onOpenSession: (session: SessionInfo) => void;
  onSelectCard?: (session: SessionInfo | null) => void;
  onForkSession?: (session: SessionInfo) => Promise<void>;
  onInjectContext?: (session: SessionInfo) => void;
  onCopySessionInfo?: (item: SessionActivityItem) => void | Promise<void>;
  onArchiveSession?: (session: SessionInfo) => Promise<void>;
  onDeleteSession?: (session: SessionInfo) => Promise<void>;
  onConvertGhost?: (ghostId: string, ghost: TalkMapGhostCardState, subprojectId?: string) => void;
}

interface SessionListResponse {
  sessions?: SessionInfo[];
}

interface TalkMapResponse {
  board?: TalkMapBoard;
  error?: string;
}

interface TalkMapRelationsResponse {
  relations?: TalkMapEdge[];
  error?: string;
}

interface PendingCardDrop {
  sessionId: string;
  x: number;
  y: number;
  clientX: number;
  clientY: number;
}

const CARD_WIDTH = 470;
const CARD_MIN_HEIGHT = 120;
const TALK_MAP_CARD_DRAG_THRESHOLD = 6;
const TALK_MAP_CARD_DRAGGING_CLASS = "talk-map-card-pointer-dragging";
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const DEFAULT_TALK_MAP_LAYOUT = defaultTalkMapLayout();
const EMPTY_SUBPROJECT_LAYOUT: TalkMapSubprojectLayout = { modules: [], positions: {}, bounds: null };

function projectDisplayName(projectRoot: string | null): string | null {
  const trimmed = projectRoot?.replace(/[\\/]+$/, "");
  if (!trimmed) return null;
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

function sessionTitle(session: SessionInfo): string {
  const displayName = stripHiddenUserQuestion(session.name ?? "");
  const displayFirstMessage = stripHiddenUserQuestion(skillExpansionToCommand(session.firstMessage) ?? session.firstMessage);
  return displayName
    || displayFirstMessage.trim().split("\n")[0]
    || session.id;
}


function statusColor(status: SessionActivityStatus | undefined): string {
  return status ? sessionActivityStatusColor(status) : "var(--text-dim)";
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function findRelatedEdge(edges: TalkMapEdge[], first: string, second: string): TalkMapEdge | undefined {
  return edges.find((edge) => edge.type === "related"
    && ((edge.source === first && edge.target === second) || (edge.source === second && edge.target === first)));
}

function controlStyle(disabled = false): React.CSSProperties {
  return {
    height: 30,
    padding: "0 9px",
    border: "1px solid var(--border)",
    borderRadius: 6,
    background: "var(--bg-panel)",
    color: disabled ? "var(--text-dim)" : "var(--text-muted)",
    cursor: disabled ? "not-allowed" : "pointer",
    touchAction: "manipulation",
    fontSize: 11,
    whiteSpace: "nowrap",
  };
}

function measuredCardHeight(cardHeights: Readonly<Record<string, number>>, key: string): number {
  const height = cardHeights[key];
  return Number.isFinite(height) && height > 0 ? Math.ceil(height) : CARD_MIN_HEIGHT;
}

function clearCardTextSelection(): void {
  if (typeof window === "undefined") return;
  window.getSelection()?.removeAllRanges();
}

interface TalkMapCardQuestionsProps {
  sessionId: string;
  version?: string;
  peer?: string;
  deviceId?: string;
  expanded?: boolean;
}

function TalkMapCardQuestions({ sessionId, version = "", peer, deviceId, expanded = false }: TalkMapCardQuestionsProps) {
  const { t } = useI18n();
  const details = useSessionDetails({
    sessionId,
    version,
    peer,
    deviceId,
    loadUserQuestions: true,
  });
  const userQuestions = details.userQuestions;
  const loading = userQuestions === undefined;
  const displayQuestions = (userQuestions ?? [])
    .slice()
    .reverse()
    .map((question) => formatUserQuestion(question, 5))
    .filter(Boolean);
  const visibleQuestions = expanded ? displayQuestions : displayQuestions.slice(0, 1);

  return (
    <div
      data-talk-map-user-questions
      style={{ marginTop: 0 }}
    >
      <div
          data-talk-map-questions-content
          style={{
            marginTop: 6,
            color: displayQuestions.length ? "var(--text)" : "var(--text-dim)",
            fontSize: 11,
            lineHeight: 1.5,
          }}
        >
          {loading ? (
            t("sessionActivity.loading")
          ) : displayQuestions.length ? (
            <div style={{ display: "grid", gap: 5 }}>
              {visibleQuestions.map((question, index) => (
                <div key={index} style={{ display: "flex", alignItems: "flex-start", gap: 6, minWidth: 0 }}>
                  <svg
                    data-talk-map-question-icon="heroicons-chat-bubble-oval-left-ellipsis"
                    aria-hidden="true"
                    width={11}
                    height={11}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ width: 11, flexShrink: 0, color: "var(--accent)", marginTop: 2 }}
                  >
                    <path d="M8.625 12a.375.375 0 1 1-.75 0a.375.375 0 0 1 .75 0m0 0H8.25m4.125 0a.375.375 0 1 1-.75 0a.375.375 0 0 1 .75 0m0 0H12m4.125 0a.375.375 0 1 1-.75 0a.375.375 0 0 1 .75 0m0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.8 9.8 0 0 1-2.555-.337A5.97 5.97 0 0 1 5.41 20.97a6 6 0 0 1-.474-.065a4.5 4.5 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25" />
                  </svg>
                  <span style={{ minWidth: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                    {question}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            t("sessionActivity.noQuestion")
          )}

        </div>
    </div>
  );
}

interface TalkMapCardRecapProps {
  children: React.ReactNode;
  expanded: boolean;
}

function TalkMapCardRecap({ children, expanded }: TalkMapCardRecapProps) {
  return (
    <div data-talk-map-recap style={{ marginTop: 0 }}>
      {expanded && (
        <div
          data-talk-map-recap-content
          style={{
            marginTop: 6,
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            lineHeight: 1.45,
            color: "var(--text)",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function TalkMapOverlay({ open, projectRoot, deviceName, focusSessionId, remotePeer, refreshKey = 0, onClose, onNewSession, onOpenSession, onSelectCard, onForkSession, onInjectContext, onCopySessionInfo, onArchiveSession, onDeleteSession, onConvertGhost }: Props) {
  const { t } = useI18n();
  const [sharedFilters, updateSharedFilters] = useSharedActivityFilters();
  const mapTimeRange = sharedFilters.days as ActivityTimeRange;
  const mapLabel = [deviceName?.trim(), projectDisplayName(projectRoot)].filter(Boolean).join(" · ") || t("talkMap.noProject");
  const canvasRef = useRef<HTMLDivElement>(null);
  const subprojectStageRef = useRef<HTMLDivElement>(null);
  const subprojectScrollRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const subprojectPanelRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const cameraSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; camera: TalkMapCamera; captured: boolean } | null>(null);
  const subprojectStagePanRef = useRef<{ pointerId: number; startX: number; scrollLeft: number; captured: boolean } | null>(null);
  const dragRef = useRef<{ sessionId: string; pointerId: number; startX: number; startY: number; lastX: number; lastY: number; x: number; y: number; active: boolean; pointerOffset?: { x: number; y: number } } | null>(null);
  const cardDragClickRef = useRef(false);
  const frameDragRef = useRef<{ frameId: string; pointerId: number; lastX: number; lastY: number; x: number; y: number } | null>(null);
  const ghostDragRef = useRef<{ ghostId: string; pointerId: number; lastX: number; lastY: number; x: number; y: number } | null>(null);
  const subprojectDragRef = useRef<{ subprojectId: string; pointerId: number } | null>(null);
  const focusedSessionRef = useRef<string | null>(null);
  const userInteractedRef = useRef(false);
  const initialFitDoneRef = useRef(false);
  const previousLayoutModeRef = useRef<TalkMapLayoutState["mode"] | null>(null);
  const previousOpenedSubprojectRef = useRef<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [rawBoard, setBoard] = useState<TalkMapBoard | null>(null);
  // projectRoot 变化后的首帧仍可能保留旧 board；只有当前项目的 board 才能作为布局真源。
  const board = rawBoard && projectKeysMatch(rawBoard.projectRoot, projectRoot ?? undefined) ? rawBoard : null;
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [cardHeights, setCardHeights] = useState<Record<string, number>>({});
  const [subprojectFrameHeight, setSubprojectFrameHeight] = useState(TALK_MAP_SUBPROJECT_FRAME_HEIGHT);
  const sessionsRef = useRef<SessionInfo[]>([]);
  const backgroundBoardRefreshRef = useRef(false);
  const boardRequestRef = useRef(0);
  const activityRevisionRef = useRef(0);
  const activityRequestRef = useRef(0);
  const [edgeSaving, setEdgeSaving] = useState(false);
  const [subprojects, setSubprojects] = useState<SubprojectDefinition[]>([]);
  const [openedSubprojectId, setOpenedSubprojectId] = useState<string | null>(null);
  const [activities, setActivities] = useState<SessionActivityItem[]>([]);
  const [activitySnapshotReady, setActivitySnapshotReady] = useState(false);
  const [subprojectSortSettings, setSubprojectSortSettings] = useState<NonNullable<SessionActivityResponse["subprojectSortSettings"]>>([]);
  const [edgeMode, setEdgeMode] = useState(false);
  const [edgeSource, setEdgeSource] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const [activeCardDragId, setActiveCardDragId] = useState<string | null>(null);
  const [pendingCardDrop, setPendingCardDrop] = useState<PendingCardDrop | null>(null);
  const [subprojectScrollTops, setSubprojectScrollTops] = useState<Record<string, number>>({});
  const [subprojectGeometryRevision, setSubprojectGeometryRevision] = useState(0);
  const [subprojectDragOverId, setSubprojectDragOverId] = useState<string | null>(null);
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [canHover, setCanHover] = useState(true);
  const [mapLocked, setMapLocked] = useState(false);
  const [expandedRecapIds, setExpandedRecapIds] = useState<Set<string>>(() => new Set());
  const [subprojectPanelOpen, setSubprojectPanelOpen] = useState(true);
  const [subprojectVisibilityBusy, setSubprojectVisibilityBusy] = useState(false);
  const [autoHideEmptySubprojectsOverride, setAutoHideEmptySubprojectsOverride] = useState<boolean | null>(null);
  const [ghostComposerOpen, setGhostComposerOpen] = useState(false);
  const [ghostLabel, setGhostLabel] = useState("");
  const [relationNotice, setRelationNotice] = useState<string | null>(null);
  const [ghostBody, setGhostBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [relationPanelOpen, setRelationPanelOpen] = useState(false);
  const [relationSearch, setRelationSearch] = useState("");
  const [relationEdges, setRelationEdges] = useState<TalkMapEdge[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 切项目时先作废旧 board，等待当前项目的布局真源重新解析。
    boardRequestRef.current += 1;
    activityRequestRef.current += 1;
    activityRevisionRef.current += 1;
    setBoard(null);
    sessionsRef.current = [];
    setSessions([]);
    setActivities([]);
    setSubprojects([]);
    setSubprojectSortSettings([]);
    userInteractedRef.current = false;
    initialFitDoneRef.current = false;
    setMapLocked(false);
    setExpandedRecapIds(new Set());
    setActivitySnapshotReady(false);
    setSubprojectPanelOpen(true);
    setOpenedSubprojectId(null);
    setSelectedCardId(null);
    setCardHeights({});
    setSubprojectScrollTops({});
    dragRef.current = null;
    setDragPreview(null);
    setActiveCardDragId(null);
    setPendingCardDrop(null);
    setSubprojectDragOverId(null);
    document.body.classList.remove(TALK_MAP_CARD_DRAGGING_CLASS);
    setAutoHideEmptySubprojectsOverride(null);
    setEdgeMode(false);
    setEdgeSource(null);
    setEdgeSaving(false);
    setSelectedEdgeId(null);
    setRelationPanelOpen(false);
    setRelationSearch("");
    setRelationNotice(null);
    setRelationEdges([]);
  }, [open, projectRoot, remotePeer]);

  useEffect(() => {
    if (!open) return;
    notifyEmbeddedModalState(true, "talk-map");
    return () => notifyEmbeddedModalState(false, "talk-map");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [open]);

  useEffect(() => {
    const media = window.matchMedia("(hover: hover)");
    const update = () => setCanHover(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const activityBySession = useMemo(
    () => new Map(activities.map((item) => [item.session.id, item])),
    [activities],
  );
  const mapProjectKey = useMemo(
    () => sessions.find((session) => session.projectKey)?.projectKey ?? projectRoot ?? undefined,
    [projectRoot, sessions],
  );
  const projectSubprojects = useMemo(
    () => subprojects.filter((subproject) => projectKeysMatch(subproject.projectKey, mapProjectKey)),
    [mapProjectKey, subprojects],
  );
  const subprojectSortSetting = useMemo(
    () => subprojectSortSettings.find((setting) => projectKeysMatch(setting.projectKey, mapProjectKey)),
    [mapProjectKey, subprojectSortSettings],
  );
  const activeSessions = useMemo(() => filterTalkMapSessions(sessions), [sessions]);
  const timeFilteredSessions = useMemo(
    () => filterSessionsByActivityTime(activeSessions, activities, mapTimeRange, nowMs),
    [activeSessions, activities, mapTimeRange, nowMs],
  );
  const ownedSubprojects = useMemo(() => groupBySubproject(
    timeFilteredSessions,
    projectSubprojects,
    mapProjectKey ?? "",
    "",
    {
      mode: subprojectSortSetting?.mode ?? "custom",
      customOrder: subprojectSortSetting?.order,
      compareItems: (left, right) => {
        const leftActivity = activityBySession.get(left.id);
        const rightActivity = activityBySession.get(right.id);
        if (leftActivity && rightActivity) return compareBySort(leftActivity, rightActivity, sharedFilters.sort);
        if (leftActivity) return -1;
        if (rightActivity) return 1;
        return right.modified.localeCompare(left.modified);
      },
    },
  ).flatMap((bucket) => bucket.subproject ? [bucket.subproject] : []), [activityBySession, mapProjectKey, projectSubprojects, sharedFilters.sort, subprojectSortSetting?.mode, subprojectSortSetting?.order, timeFilteredSessions]);
  const emptySubprojects = useMemo(() => {
    const assignedIds = new Set(timeFilteredSessions.map((session) => session.subprojectId).filter((id): id is string => typeof id === "string"));
    return ownedSubprojects.filter((subproject) => !assignedIds.has(subproject.id));
  }, [ownedSubprojects, timeFilteredSessions]);
  const persistedAutoHideEmptySubprojects = Boolean(subprojectSortSetting?.autoHideEmptySubprojects);
  const autoHideEmptySubprojects = autoHideEmptySubprojectsOverride ?? persistedAutoHideEmptySubprojects;
  const autoHiddenSubprojectIds = useMemo(
    () => autoHideEmptySubprojects ? new Set(emptySubprojects.map((subproject) => subproject.id)) : new Set<string>(),
    [autoHideEmptySubprojects, emptySubprojects],
  );
  const visibleSubprojects = useMemo(
    () => ownedSubprojects.filter((subproject) => !subproject.hidden && !autoHiddenSubprojectIds.has(subproject.id)),
    [autoHiddenSubprojectIds, ownedSubprojects],
  );
  const layoutSubprojects = useMemo(
    () => openedSubprojectId
      ? visibleSubprojects.filter((subproject) => subproject.id === openedSubprojectId)
      : visibleSubprojects,
    [openedSubprojectId, visibleSubprojects],
  );
  const hiddenSubprojectIds = useMemo(
    () => new Set(ownedSubprojects.filter((subproject) => subproject.hidden || autoHiddenSubprojectIds.has(subproject.id)).map((subproject) => subproject.id)),
    [autoHiddenSubprojectIds, ownedSubprojects],
  );
  const subprojectById = useMemo(
    () => new Map(ownedSubprojects.map((subproject) => [subproject.id, subproject])),
    [ownedSubprojects],
  );
  const ownedSubprojectIds = useMemo(
    () => new Set(ownedSubprojects.map((subproject) => subproject.id)),
    [ownedSubprojects],
  );
  const visibleSessions = useMemo(() => {
    const displayableSessions = filterTalkMapSessions(timeFilteredSessions, hiddenSubprojectIds);
    if (!openedSubprojectId) return displayableSessions;
    return displayableSessions.filter((session) => session.subprojectId === openedSubprojectId);
  }, [hiddenSubprojectIds, openedSubprojectId, timeFilteredSessions]);
  const selectedCard = useMemo(
    () => selectedCardId ? visibleSessions.find((session) => session.id === selectedCardId) ?? null : null,
    [selectedCardId, visibleSessions],
  );
  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const selectedCardTitle = selectedCard ? sessionTitle(selectedCard) : null;
  const visibleSessionById = useMemo(
    () => new Map(visibleSessions.map((session) => [session.id, session])),
    [visibleSessions],
  );
  const visibleCardIds = useMemo(
    () => visibleSessions.filter((session) => !board?.cards[session.id]?.hidden).map((session) => session.id),
    [board?.cards, visibleSessions],
  );
  const allRecapsExpanded = visibleCardIds.length > 0 && visibleCardIds.every((sessionId) => expandedRecapIds.has(sessionId));
  const recapToggleAllLabel = allRecapsExpanded ? t("talkMap.collapseAllRecaps") : t("talkMap.expandAllRecaps");
  useEffect(() => {
    if (!open || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      setCardHeights((current) => {
        let changed = false;
        const next = { ...current };
        for (const entry of entries) {
          const element = entry.target as HTMLElement;
          const key = element.dataset.talkMapCardId ?? element.dataset.talkMapGhostId;
          if (!key) continue;
          const measured = Math.ceil(entry.borderBoxSize?.[0]?.blockSize ?? element.offsetHeight);
          if (measured > 0 && next[key] !== measured) {
            next[key] = measured;
            changed = true;
          }
        }
        return changed ? next : current;
      });
    });
    canvasRef.current?.querySelectorAll<HTMLElement>("[data-talk-map-card-id], [data-talk-map-ghost-id]").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [activities, board?.ghosts, open, openedSubprojectId, sessions, visibleSessions]);

  useEffect(() => {
    if (selectedCardId && !visibleSessionById.has(selectedCardId)) {
      setSelectedCardId(null);
      onSelectCard?.(null);
    }
  }, [onSelectCard, selectedCardId, visibleSessionById]);
  const talkMapLayout = board?.layout ?? DEFAULT_TALK_MAP_LAYOUT;
  // 未加载 board 前不声称任何布局模式：首帧不得画出稍后被持久化布局推翻的视图。
  const layoutMode = board ? talkMapLayout.mode : null;
  const isSubprojectView = layoutMode === "subprojects" || Boolean(openedSubprojectId);
  const subprojectOrder = useMemo(
    () => orderedSubprojectIds(ownedSubprojects, subprojectSortSetting?.order),
    [ownedSubprojects, subprojectSortSetting?.order],
  );
  const subprojectLayout = useMemo(
    () => isSubprojectView
      ? buildTalkMapSubprojectLayout({
        sessions: visibleSessions,
        activities,
        subprojects: layoutSubprojects,
        projectKey: mapProjectKey,
        sort: talkMapLayout.sort,
        manualOrder: talkMapLayout.manualOrder,
        subprojectSortMode: subprojectSortSetting?.mode,
        subprojectOrder: subprojectSortSetting?.order,
        subprojectDisplayOrder: layoutSubprojects.map((subproject) => subproject.id),
        unclassifiedLabel: t("sessionActivity.unclassified"),
        cardWidth: CARD_WIDTH,
        cardHeight: CARD_MIN_HEIGHT,
        frameHeight: subprojectFrameHeight,
        cardHeights,
      })
      : EMPTY_SUBPROJECT_LAYOUT,
    [activities, cardHeights, isSubprojectView, layoutSubprojects, mapProjectKey, subprojectFrameHeight, subprojectSortSetting?.mode, subprojectSortSetting?.order, t, talkMapLayout, visibleSessions],
  );
  const canReorderSubprojects = talkMapLayout.mode === "subprojects"
    && (subprojectSortSetting?.mode ?? "custom") === "custom";
  const canDragCards = !isSubprojectView || talkMapLayout.sort === "manual";
  const positionForSession = useCallback((session: SessionInfo, index: number) => {
    if (dragPreview?.sessionId === session.id) return { x: dragPreview.x, y: dragPreview.y };
    if (isSubprojectView) return subprojectLayout.positions[session.id] ?? defaultTalkMapPosition(index);
    return board?.cards[session.id] ?? defaultTalkMapPosition(index);
  }, [board?.cards, dragPreview, isSubprojectView, subprojectLayout.positions]);
  useEffect(() => {
    if (!openedSubprojectId || visibleSubprojects.some((subproject) => subproject.id === openedSubprojectId)) return;
    setOpenedSubprojectId(null);
  }, [openedSubprojectId, visibleSubprojects]);
  const worktreeFrames = useMemo(() => {
    if (!board || openedSubprojectId || talkMapLayout.mode === "subprojects") return [];
    if (!visibleSessions.some((session) => session.worktreeBranch?.trim())) {
      return board.frames;
    }
    const groups = new Map<string, SessionInfo[]>();
    for (const session of visibleSessions) {
      const branch = session.worktreeBranch?.trim() || "main worktree";
      const group = groups.get(branch) ?? [];
      group.push(session);
      groups.set(branch, group);
    }
    return [...groups.entries()].map(([label, group]) => {
      const positions = group.map((session) => {
        const index = sessions.findIndex((candidate) => candidate.id === session.id);
        return { ...positionForSession(session, index), height: measuredCardHeight(cardHeights, session.id) };
      });
      const stored = board.frames.find((frame) => frame.id === `worktree:${label}`);
      if (stored) return stored;
      const minX = Math.min(...positions.map((position) => position.x));
      const minY = Math.min(...positions.map((position) => position.y));
      const maxX = Math.max(...positions.map((position) => position.x + CARD_WIDTH));
      const maxY = Math.max(...positions.map((position) => position.y + position.height));
      return {
        id: `worktree:${label}`,
        label,
        kind: "worktree" as const,
        x: minX - 32,
        y: minY - 46,
        width: Math.max(360, maxX - minX + 64),
        height: Math.max(250, maxY - minY + 78),
      };
    });
  }, [board, cardHeights, openedSubprojectId, positionForSession, sessions, talkMapLayout.mode, visibleSessions]);

  const fetchActivities = useCallback(async (force = false): Promise<SessionActivityResponse | null> => {
    try {
      const url = apiPathForPeer(remotePeer, "session-runs?scope=local");
      if (force) clearSessionActivityCache(url);
      return await fetchSessionActivity<SessionActivityResponse>(url, { force });
    } catch {
      return null;
    }
  }, [remotePeer]);

  const loadRelations = useCallback(async () => {
    if (!projectRoot) return;
    const response = await fetch(apiPathForPeer(remotePeer, `talk-map/relations?projectRoot=${encodeURIComponent(projectRoot)}`), { cache: "no-store" });
    const body = await response.json().catch(() => ({})) as TalkMapRelationsResponse;
    if (!response.ok) throw new Error(body.error || `Talk Map relations HTTP ${response.status}`);
    setRelationEdges(body.relations ?? []);
  }, [projectRoot, remotePeer]);

  const filteredRelations = useMemo(() => {
    const needle = relationSearch.trim().toLowerCase();
    if (!needle) return relationEdges;
    return relationEdges.filter((edge) => {
      const sourceSession = sessionById.get(edge.source);
      const targetSession = sessionById.get(edge.target);
      return `${sourceSession ? sessionTitle(sourceSession) : edge.source} ${targetSession ? sessionTitle(targetSession) : edge.target} ${edge.source} ${edge.target} ${edge.type}`.toLowerCase().includes(needle);
    });
  }, [relationEdges, relationSearch, sessionById]);

  const cancelEdgeMode = useCallback(() => {
    if (edgeSaving) return;
    setEdgeMode(false);
    setEdgeSource(null);
    setSelectedEdgeId(null);
    setRelationNotice(null);
  }, [edgeSaving]);

  const startEdgeMode = useCallback(() => {
    if (!board || edgeSaving) return;
    setError(null);
    setRelationNotice(null);
    setRelationSearch("");
    setSelectedEdgeId(null);
    setEdgeSource(null);
    setRelationPanelOpen(true);
    setEdgeMode(true);
  }, [board, edgeSaving]);

  const closeRelationPanel = useCallback(() => {
    if (edgeSaving) return;
    cancelEdgeMode();
    setRelationPanelOpen(false);
    setRelationSearch("");
  }, [cancelEdgeMode, edgeSaving]);

  const toggleRelationPanel = useCallback(() => {
    if (relationPanelOpen) {
      closeRelationPanel();
      return;
    }
    setRelationPanelOpen(true);
  }, [closeRelationPanel, relationPanelOpen]);

  const handleOverlayPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!relationPanelOpen || edgeMode || edgeSaving) return;
    const target = event.target as Element;
    if (target.closest("[data-talk-map-relations], [data-talk-map-relations-toggle], [data-talk-map-add-edge], [data-talk-map-edge]")) return;
    closeRelationPanel();
  }, [closeRelationPanel, edgeMode, edgeSaving, relationPanelOpen]);

  const loadBoard = useCallback(async (root: string, options: { background?: boolean; forceActivity?: boolean } = {}) => {
    const background = options.background === true;
    const activityRevisionAtRequest = activityRevisionRef.current;
    const requestId = boardRequestRef.current;
    if (background) {
      // Ignore overlapping SSE refreshes. They are snapshots, not user actions;
      // ponytail: one in-flight refresh keeps a noisy event stream from
      // reflowing the toolbar and piling up full-device requests.
      if (backgroundBoardRefreshRef.current) return;
      backgroundBoardRefreshRef.current = true;
    } else {
      setLoading(true);
      setError(null);
    }
    const activityRequestId = ++activityRequestRef.current;
    void fetchActivities(options.forceActivity === true).then((activityBody) => {
      if (requestId !== boardRequestRef.current || activityRequestId !== activityRequestRef.current || activityRevisionAtRequest !== activityRevisionRef.current) return;
      setActivities(activityBody?.sessions ?? []);
      setSubprojects(activityBody?.subprojects ?? []);
      setSubprojectSortSettings(activityBody?.subprojectSortSettings ?? []);
      setActivitySnapshotReady(true);
    }).catch(() => {
      if (background || requestId !== boardRequestRef.current || activityRequestId !== activityRequestRef.current || activityRevisionAtRequest !== activityRevisionRef.current) return;
      setActivities([]);
      setSubprojects([]);
      setSubprojectSortSettings([]);
      setActivitySnapshotReady(true);
    });
    try {
      const [boardResponse, sessionsResponse] = await Promise.all([
        fetch(apiPathForPeer(remotePeer, `talk-map?projectRoot=${encodeURIComponent(root)}`), { cache: "no-store" }),
        fetch(apiPathForPeer(remotePeer, `sessions?projectRoot=${encodeURIComponent(root)}`), { cache: "no-store" }),
      ]);
      if (!boardResponse.ok) throw new Error(`Talk Map HTTP ${boardResponse.status}`);
      if (!sessionsResponse.ok) throw new Error(`Session list HTTP ${sessionsResponse.status}`);
      const boardBody = await boardResponse.json() as TalkMapResponse;
      const sessionsBody = await sessionsResponse.json() as SessionListResponse;
      if (!boardBody.board) throw new Error(boardBody.error || "Talk Map board unavailable");
      const nextBoard = boardBody.board;
      const nextSessions = (sessionsBody.sessions ?? []).filter((session) => (
        (session.projectRoot ?? session.cwd) === nextBoard.projectRoot
      ));
      // 旧项目请求晚到时不得覆盖当前项目的 board 或会话列表。
      if (requestId !== boardRequestRef.current) return;
      sessionsRef.current = nextSessions;
      setBoard(nextBoard);
      setSessions(nextSessions);
      setRelationEdges(nextBoard.edges);
      setSelectedEdgeId((current) => current && nextBoard.edges.some((edge) => edge.id === current) ? current : null);
      if (background) setError(null);
    } catch (cause) {
      if (!background) {
        setError(cause instanceof Error ? cause.message : String(cause));
        sessionsRef.current = [];
        setBoard(null);
        setSessions([]);
        setSubprojects([]);
        setSubprojectSortSettings([]);
        setActivities([]);
      }
    } finally {
      if (background) backgroundBoardRefreshRef.current = false;
      else setLoading(false);
    }
  }, [fetchActivities, remotePeer]);

  useEffect(() => {
    if (!open || !projectRoot) return;
    void loadBoard(projectRoot);
  }, [loadBoard, open, projectRoot, refreshKey]);

  useEffect(() => {
    if (!open || !projectRoot) return;
    const source = new EventSource(apiPathForPeer(remotePeer, "activity/events"));
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (reloadBoard: boolean) => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (reloadBoard) {
          void loadBoard(projectRoot, { background: true, forceActivity: true });
          return;
        }
        const activityRevisionAtRequest = activityRevisionRef.current;
        const activityRequestId = ++activityRequestRef.current;
        const boardRequestAtActivity = boardRequestRef.current;
        void fetchActivities(true).then((body) => {
          if (body && boardRequestAtActivity === boardRequestRef.current && activityRequestId === activityRequestRef.current && activityRevisionAtRequest === activityRevisionRef.current) {
            setActivities(body.sessions ?? []);
            setSubprojects(body.subprojects ?? []);
            setSubprojectSortSettings(body.subprojectSortSettings ?? []);
            setActivitySnapshotReady(true);
          }
        }).catch(() => {});
      }, 80);
    };
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { type?: string; kind?: string; sessionId?: string };
        if (payload.type !== "activity") return;
        const liveEvent = { ...payload, type: "activity" as const } as SessionActivityEventPayload;
        activityRevisionRef.current += 1;
        if (liveEvent.kind !== "session") {
          setActivities((current) => {
            const result = applySessionActivityItemsEvent(current, liveEvent);
            return result.changed ? result.sessions : current;
          });
        }
        const known = typeof payload.sessionId === "string" && sessionsRef.current.some((session) => session.id === payload.sessionId);
        schedule(payload.kind === "session" || !known);
      } catch {
        // Ignore malformed/heartbeat frames; EventSource will reconnect.
      }
    };
    return () => {
      source.close();
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [fetchActivities, loadBoard, open, projectRoot, remotePeer]);

  useEffect(() => {
    if (!relationPanelOpen) return;
    void loadRelations().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [board?.revision, loadRelations, relationPanelOpen]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (edgeSaving) return;
      if (edgeMode) {
        cancelEdgeMode();
        return;
      }
      if (relationPanelOpen) {
        closeRelationPanel();
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancelEdgeMode, closeRelationPanel, edgeMode, edgeSaving, onClose, open, relationPanelOpen]);

  useEffect(() => () => {
    if (cameraSaveTimerRef.current) clearTimeout(cameraSaveTimerRef.current);
  }, []);

  const persistMutation = useCallback(async (mutation: TalkMapMutation): Promise<TalkMapBoard | null> => {
    if (!projectRoot) return null;
    setSaving(true);
    try {
      const response = await fetch(apiPathForPeer(remotePeer, "talk-map"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectRoot, mutation }),
      });
      const body = await response.json().catch(() => ({})) as TalkMapResponse;
      if (!response.ok || !body.board) throw new Error(body.error || `Talk Map HTTP ${response.status}`);
      setBoard((current) => {
        if (!current) return current;
        return {
          ...current,
          revision: body.board!.revision,
          updatedAt: body.board!.updatedAt,
          ...(mutation.op === "upsert-card" ? { cards: { ...current.cards, [mutation.sessionId]: body.board!.cards[mutation.sessionId] ?? current.cards[mutation.sessionId] } } : {}),
          ...(mutation.op === "append-session" ? { layout: body.board!.layout ?? current.layout } : {}),
          ...(mutation.op === "set-camera" ? { camera: body.board!.camera } : {}),
          ...(mutation.op === "set-layout" ? { layout: body.board!.layout ?? current.layout } : {}),
          ...(mutation.op === "reset-view" ? { camera: body.board!.camera, cards: body.board!.cards } : {}),
          ...(mutation.op === "upsert-edge" || mutation.op === "delete-edge" ? { edges: body.board!.edges } : {}),
          ...(mutation.op === "upsert-frame" || mutation.op === "delete-frame" ? { frames: body.board!.frames } : {}),
          ...(mutation.op === "upsert-ghost" || mutation.op === "delete-ghost" ? { ghosts: body.board!.ghosts } : {}),
        };
      });
      if (mutation.op === "upsert-edge" || mutation.op === "delete-edge") setRelationEdges(body.board.edges);
      setError(null);
      return body.board;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      setSaving(false);
    }
  }, [projectRoot, remotePeer]);

  const updateTalkMapLayout = useCallback((patch: Partial<TalkMapLayoutState>) => {
    if (!board) return;
    void persistMutation({ op: "set-layout", layout: { ...talkMapLayout, ...patch } });
  }, [board, persistMutation, talkMapLayout]);

  const selectLayoutMode = useCallback((mode: TalkMapLayoutState["mode"]) => {
    setOpenedSubprojectId(null);
    updateTalkMapLayout({ mode });
  }, [updateTalkMapLayout]);

  const setSubprojectHidden = useCallback(async (subprojectId: string, hidden: boolean): Promise<void> => {
    setSubprojectVisibilityBusy(true);
    try {
      const response = await fetch(apiPathForPeer(remotePeer, "subprojects"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: subprojectId, hidden }),
      });
      const body = await response.json().catch(() => ({})) as { subproject?: SubprojectDefinition; error?: string };
      if (!response.ok || !body.subproject) throw new Error(body.error || `Subproject HTTP ${response.status}`);
      setSubprojects((current) => current.map((subproject) => subproject.id === subprojectId ? body.subproject! : subproject));
      if (typeof window !== "undefined") window.dispatchEvent(new Event("pi-subprojects-changed"));
    } finally {
      setSubprojectVisibilityBusy(false);
    }
  }, [remotePeer]);

  const toggleAutoHideEmptySubprojects = useCallback(async (): Promise<void> => {
    if (!mapProjectKey) return;
    const previousSetting = subprojectSortSetting;
    const enabled = !autoHideEmptySubprojects;
    const activityCacheKey = apiPathForPeer(remotePeer, "session-runs?scope=local");
    setAutoHideEmptySubprojectsOverride(enabled);
    setError(null);
    const optimisticSetting: SessionActivitySubprojectSortSetting = {
      projectKey: mapProjectKey,
      mode: previousSetting?.mode ?? "custom",
      order: previousSetting?.order ?? [],
      deviceId: previousSetting?.deviceId ?? remotePeer ?? "local",
      autoHideEmptySubprojects: enabled,
    };
    setSubprojectSortSettings((current) => [
      ...current.filter((setting) => !projectKeysMatch(setting.projectKey, mapProjectKey)),
      optimisticSetting,
    ]);
    if (typeof window !== "undefined") window.dispatchEvent(new Event("pi-subprojects-changed"));

    try {
      const response = await fetch(apiPathForPeer(remotePeer, "subprojects"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectKey: mapProjectKey,
          mode: optimisticSetting.mode,
          order: optimisticSetting.order,
          autoHideEmptySubprojects: enabled,
        }),
      });
      const body = await response.json().catch(() => ({})) as { sortSetting?: SubprojectSortSetting; error?: string };
      if (!response.ok || !body.sortSetting) throw new Error(body.error || `Subproject HTTP ${response.status}`);
      clearSessionActivityCache(activityCacheKey);
      setSubprojectSortSettings((current) => {
        const existing = current.find((setting) => projectKeysMatch(setting.projectKey, mapProjectKey));
        const nextSetting = { ...body.sortSetting!, deviceId: existing?.deviceId ?? remotePeer ?? "local" };
        return [...current.filter((setting) => !projectKeysMatch(setting.projectKey, mapProjectKey)), nextSetting];
      });
      if (typeof window !== "undefined") window.dispatchEvent(new Event("pi-subprojects-changed"));
    } catch (cause) {
      setSubprojectSortSettings((current) => [
        ...current.filter((setting) => !projectKeysMatch(setting.projectKey, mapProjectKey)),
        ...(previousSetting ? [previousSetting] : []),
      ]);
      setError(cause instanceof Error ? cause.message : String(cause));
      if (typeof window !== "undefined") window.dispatchEvent(new Event("pi-subprojects-changed"));
    } finally {
      setAutoHideEmptySubprojectsOverride(null);
    }
  }, [autoHideEmptySubprojects, mapProjectKey, remotePeer, subprojectSortSetting]);

  const toggleSubprojectVisibility = useCallback(async (subproject: SubprojectDefinition): Promise<void> => {
    // Automatic visibility belongs to project policy; quick tags only change
    // the persisted manual hidden flag.
    if (autoHiddenSubprojectIds.has(subproject.id)) return;
    await setSubprojectHidden(subproject.id, !Boolean(subproject.hidden));
  }, [autoHiddenSubprojectIds, setSubprojectHidden]);

  const openSubproject = useCallback((subprojectId: string) => {
    setOpenedSubprojectId((current) => current === subprojectId ? null : subprojectId);
    setSelectedCardId(null);
    onSelectCard?.(null);
  }, [onSelectCard]);

  const saveSubprojectOrder = useCallback(async (order: string[]): Promise<boolean> => {
    if (!mapProjectKey) return false;
    try {
      const response = await fetch(apiPathForPeer(remotePeer, "subprojects"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectKey: mapProjectKey, mode: "custom", order }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || `Subproject HTTP ${response.status}`);
      if (subprojectSortSetting) {
        setSubprojectSortSettings((current) => current.map((setting) => projectKeysMatch(setting.projectKey, mapProjectKey)
          ? { ...setting, mode: "custom", order: [...order] }
          : setting));
      } else if (projectRoot) {
        void loadBoard(projectRoot, { background: true });
      }
      setError(null);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }, [loadBoard, mapProjectKey, projectRoot, remotePeer, subprojectSortSetting]);

  useEffect(() => {
    if (!open || !board || worktreeFrames.length === 0) return;
    const missing = worktreeFrames.filter((frame) => !board.frames.some((candidate) => candidate.id === frame.id));
    if (missing.length === 0) return;
    void Promise.all(missing.map((frame) => persistMutation({ op: "upsert-frame", frame })));
  }, [board, open, persistMutation, worktreeFrames]);

  const queueCameraSave = useCallback((camera: TalkMapCamera) => {
    if (cameraSaveTimerRef.current) clearTimeout(cameraSaveTimerRef.current);
    cameraSaveTimerRef.current = setTimeout(() => {
      cameraSaveTimerRef.current = null;
      void persistMutation({ op: "set-camera", camera });
    }, 260);
  }, [persistMutation]);

  const updateCamera = useCallback((camera: TalkMapCamera, persist = true) => {
    setBoard((current) => current ? { ...current, camera } : current);
    if (persist) queueCameraSave(camera);
  }, [queueCameraSave]);

  const handleCanvasPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !board || isSubprojectView) return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-talk-map-edge]") || (!mapLocked && target.closest("[data-talk-map-card]"))) return;
    if (edgeMode) {
      setEdgeSource(null);
      setSelectedEdgeId(null);
      setRelationNotice(null);
      return;
    }
    setSelectedCardId(null);
    onSelectCard?.(null);
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      camera: board.camera,
      captured: false,
    };
  }, [board, edgeMode, isSubprojectView, mapLocked, onSelectCard]);

  const handleCanvasPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - pan.startX;
    const deltaY = event.clientY - pan.startY;
    if (!pan.captured && Math.hypot(deltaX, deltaY) < 6) return;
    if (!pan.captured) {
      event.currentTarget.setPointerCapture(event.pointerId);
      panRef.current = { ...pan, captured: true };
    }
    userInteractedRef.current = true;
    updateCamera({
      ...pan.camera,
      x: pan.camera.x + deltaX,
      y: pan.camera.y + deltaY,
    }, false);
  }, [updateCamera]);

  const handleCanvasPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    panRef.current = null;
    if (!pan.captured) return;
    const camera = board?.camera;
    if (camera) queueCameraSave(camera);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
  }, [board?.camera, queueCameraSave]);

  const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (isSubprojectView || !board || !canvasRef.current) return;
    event.preventDefault();
    userInteractedRef.current = true;
    const rect = canvasRef.current.getBoundingClientRect();
    const pointX = event.clientX - rect.left;
    const pointY = event.clientY - rect.top;
    const nextZoom = clampZoom(board.camera.zoom * Math.exp(-event.deltaY * 0.001));
    const worldX = (pointX - board.camera.x) / board.camera.zoom;
    const worldY = (pointY - board.camera.y) / board.camera.zoom;
    updateCamera({
      x: pointX - worldX * nextZoom,
      y: pointY - worldY * nextZoom,
      zoom: nextZoom,
    });
  }, [board, isSubprojectView, updateCamera]);

  const subprojectContentYForClient = useCallback((moduleId: string, clientY: number) => {
    const scroll = subprojectScrollRefs.current[moduleId];
    if (!scroll) return null;
    const rect = scroll.getBoundingClientRect();
    return talkMapSubprojectContentYForClient(clientY, rect.top, scroll.scrollTop);
  }, []);

  const subprojectAtPoint = useCallback((clientX: number, clientY: number) => {
    if (!isSubprojectView) return null;
    return subprojectLayout.modules.find((module) => {
      const panel = subprojectPanelRefs.current[module.id];
      const rect = panel?.getBoundingClientRect();
      return Boolean(rect) && talkMapSubprojectPointInRect(rect!, clientX, clientY);
    }) ?? null;
  }, [isSubprojectView, subprojectLayout.modules]);

  const handleSubprojectScroll = useCallback((moduleId: string, event: React.UIEvent<HTMLDivElement>) => {
    const scrollTop = event.currentTarget.scrollTop;
    if (subprojectScrollTops[moduleId] === scrollTop) return;
    setSubprojectScrollTops((current) => current[moduleId] === scrollTop ? current : { ...current, [moduleId]: scrollTop });
    setSubprojectGeometryRevision((current) => current + 1);
  }, [subprojectScrollTops]);

  const subprojectDragPosition = useCallback((clientX: number, clientY: number, pointerOffset: { x: number; y: number }) => {
    const stage = subprojectStageRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    return {
      x: clientX - rect.left + stage.scrollLeft - pointerOffset.x,
      y: clientY - rect.top + stage.scrollTop - pointerOffset.y,
    };
  }, []);

  const handleSubprojectStageScroll = useCallback(() => {
    setSubprojectGeometryRevision((current) => current + 1);
    const drag = dragRef.current;
    if (!drag?.active || !drag.pointerOffset) return;
    const position = subprojectDragPosition(drag.lastX, drag.lastY, drag.pointerOffset);
    if (!position) return;
    dragRef.current = { ...drag, ...position };
    setDragPreview({ sessionId: drag.sessionId, ...position });
  }, [subprojectDragPosition]);

  const handleSubprojectStagePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !isSubprojectView) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("[data-talk-map-subproject-scroll], [data-talk-map-card], [data-talk-map-canvas-controls], button, input, select, textarea, a")) return;
    subprojectStagePanRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      scrollLeft: event.currentTarget.scrollLeft,
      captured: false,
    };
  }, [isSubprojectView]);

  const handleSubprojectStagePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = subprojectStagePanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - pan.startX;
    if (!pan.captured && Math.abs(deltaX) < 6) return;
    if (!pan.captured) {
      event.currentTarget.setPointerCapture(event.pointerId);
      subprojectStagePanRef.current = { ...pan, captured: true };
    }
    event.preventDefault();
    event.currentTarget.scrollLeft = pan.scrollLeft - deltaX;
  }, []);

  const handleSubprojectStagePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = subprojectStagePanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    subprojectStagePanRef.current = null;
    if (!pan.captured) return;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
  }, []);

  const handleSubprojectStageWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    const insideCardScroll = Boolean(target?.closest?.("[data-talk-map-subproject-scroll]"));
    const horizontalIntent = event.deltaX !== 0 && Math.abs(event.deltaX) >= Math.abs(event.deltaY);
    if (insideCardScroll && !horizontalIntent) return;
    const delta = horizontalIntent ? event.deltaX : event.deltaY;
    if (!delta) return;
    event.preventDefault();
    event.currentTarget.scrollLeft += delta;
  }, []);

  useLayoutEffect(() => {
    if (!open || !isSubprojectView) return;
    setSubprojectGeometryRevision((current) => current + 1);
  }, [cardHeights, expandedRecapIds, isSubprojectView, open, subprojectLayout.modules, visibleSessions]);

  const handleSubprojectPointerDown = useCallback((event: ReactPointerEvent<HTMLSpanElement>, subprojectId: string) => {
    if (event.button !== 0 || edgeMode || mapLocked || !canReorderSubprojects || !board) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    subprojectDragRef.current = { subprojectId, pointerId: event.pointerId };
    setSubprojectDragOverId(subprojectId);
  }, [board, canReorderSubprojects, edgeMode, mapLocked]);

  const handleSubprojectPointerMove = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = subprojectDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setSubprojectDragOverId(subprojectAtPoint(event.clientX, event.clientY)?.id ?? null);
  }, [subprojectAtPoint]);

  const handleSubprojectPointerUp = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = subprojectDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    subprojectDragRef.current = null;
    const target = subprojectAtPoint(event.clientX, event.clientY);
    const targetRect = target ? subprojectPanelRefs.current[target.id]?.getBoundingClientRect() : null;
    setSubprojectDragOverId(null);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
    if (!target || !targetRect || target.id === drag.subprojectId) return;
    const before = event.clientX < targetRect.left + targetRect.width / 2;
    const nextOrder = reorderSubprojectIds(subprojectOrder, drag.subprojectId, target.id, before);
    if (nextOrder.every((id, index) => id === subprojectOrder[index])) return;
    void saveSubprojectOrder(nextOrder);
  }, [saveSubprojectOrder, subprojectAtPoint, subprojectOrder]);

  const handleSubprojectPointerCancel = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = subprojectDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    subprojectDragRef.current = null;
    setSubprojectDragOverId(null);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
  }, []);

  const zoomBy = useCallback((factor: number) => {
    if (isSubprojectView || !board || !canvasRef.current) return;
    userInteractedRef.current = true;
    const rect = canvasRef.current.getBoundingClientRect();
    const pointX = rect.width / 2;
    const pointY = rect.height / 2;
    const nextZoom = clampZoom(board.camera.zoom * factor);
    const worldX = (pointX - board.camera.x) / board.camera.zoom;
    const worldY = (pointY - board.camera.y) / board.camera.zoom;
    updateCamera({ x: pointX - worldX * nextZoom, y: pointY - worldY * nextZoom, zoom: nextZoom });
  }, [board, isSubprojectView, updateCamera]);

  const resetView = useCallback(() => {
    if (isSubprojectView || !board) return;
    const cards = Object.fromEntries(sessions.map((session, index) => {
      const position = defaultTalkMapPosition(index);
      return [session.id, { x: position.x, y: position.y }];
    }));
    void persistMutation({ op: "reset-view", camera: defaultTalkMapCamera(), cards });
  }, [board, isSubprojectView, persistMutation, sessions]);

  const showAllSessions = useCallback(() => {
    setOpenedSubprojectId(null);
    updateSharedFilters({ days: "all" });
  }, [updateSharedFilters]);

  const toggleRecap = useCallback((sessionId: string) => {
    setExpandedRecapIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  const toggleAllRecaps = useCallback(() => {
    setExpandedRecapIds((current) => {
      if (visibleCardIds.length > 0 && visibleCardIds.every((sessionId) => current.has(sessionId))) return new Set();
      return new Set(visibleCardIds);
    });
  }, [visibleCardIds]);

  const fitView = useCallback((persist = true) => {
    if (persist) userInteractedRef.current = false;
    if (isSubprojectView) return;
    if (!board || !canvasRef.current) {
      updateCamera(defaultTalkMapCamera(), persist);
      return;
    }
    const fitNodeCount = visibleSessions.length + subprojectLayout.modules.length
      + (openedSubprojectId ? 0 : Object.keys(board.ghosts).length);
    if (fitNodeCount === 0) {
      updateCamera(defaultTalkMapCamera(), persist);
      return;
    }
    const rect = canvasRef.current.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100) return;
    const positions = [
      ...visibleSessions
        .filter((session) => !board.cards[session.id]?.hidden)
        .map((session) => {
          const index = sessions.findIndex((candidate) => candidate.id === session.id);
          const position = positionForSession(session, index);
          return { x: position.x, y: position.y, width: CARD_WIDTH, height: measuredCardHeight(cardHeights, session.id) };
        }),
      ...subprojectLayout.modules.map((module) => ({ x: module.x, y: module.y, width: module.width, height: module.height })),
      ...(!openedSubprojectId ? Object.entries(board.ghosts).map(([ghostId, ghost]) => ({ x: ghost.x, y: ghost.y, width: CARD_WIDTH, height: measuredCardHeight(cardHeights, `ghost:${ghostId}`) })) : []),
    ];
    if (positions.length === 0) {
      updateCamera(defaultTalkMapCamera(), persist);
      return;
    }
    const minX = Math.min(...positions.map((position) => position.x));
    const minY = Math.min(...positions.map((position) => position.y));
    const maxX = Math.max(...positions.map((position) => position.x + position.width));
    const maxY = Math.max(...positions.map((position) => position.y + position.height));
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const zoom = clampZoom(Math.min((rect.width - 80) / width, (rect.height - 80) / height));
    const targetCamera = {
      x: (rect.width - width * zoom) / 2 - minX * zoom,
      y: (rect.height - height * zoom) / 2 - minY * zoom,
      zoom,
    };
    if (
      Math.abs(board.camera.x - targetCamera.x) < 0.5 &&
      Math.abs(board.camera.y - targetCamera.y) < 0.5 &&
      Math.abs(board.camera.zoom - targetCamera.zoom) < 0.001
    ) {
      return;
    }
    updateCamera(targetCamera, persist);
  }, [board, cardHeights, isSubprojectView, openedSubprojectId, positionForSession, sessions, subprojectLayout.modules, updateCamera, visibleSessions]);

  const handleCanvasDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !board || edgeMode) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("[data-talk-map-card], [data-talk-map-ghost-card], [data-talk-map-canvas-controls], [data-talk-map-edge], button, input, select, textarea, a")) {
      return;
    }
    userInteractedRef.current = false;
    fitView();
  }, [board, edgeMode, fitView]);

  useLayoutEffect(() => {
    if (!open || !board || !canvasRef.current) return;
    if (userInteractedRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100) return;
    initialFitDoneRef.current = true;
    fitView(false);
  }, [board, cardHeights, fitView, loading, open, subprojectLayout.modules, visibleSessions]);

  useLayoutEffect(() => {
    if (!open || !canvasRef.current) return;
    const updateViewportMeasurements = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const { width, height } = canvas.getBoundingClientRect();
      if (isSubprojectView) {
        const stage = subprojectStageRef.current;
        const scrollbarGutter = stage ? Math.max(0, stage.offsetHeight - stage.clientHeight) : 0;
        const nextFrameHeight = talkMapSubprojectFrameHeight(height, TALK_MAP_SUBPROJECT_VERTICAL_PADDING, scrollbarGutter);
        setSubprojectFrameHeight((current) => current === nextFrameHeight ? current : nextFrameHeight);
      }
      if (typeof ResizeObserver === "undefined") return;
      if (width >= 100 && height >= 100 && !userInteractedRef.current) {
        fitView(false);
      }
    };
    updateViewportMeasurements();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateViewportMeasurements);
    observer.observe(canvasRef.current);
    if (subprojectStageRef.current) observer.observe(subprojectStageRef.current);
    return () => observer.disconnect();
  }, [fitView, isSubprojectView, open]);

  useLayoutEffect(() => {
    const previous = previousLayoutModeRef.current;
    previousLayoutModeRef.current = board ? talkMapLayout.mode : null;
    if (!open || !board || previous === null || previous === talkMapLayout.mode) return;
    userInteractedRef.current = false;
    fitView();
  }, [board, fitView, open, talkMapLayout.mode]);

  useEffect(() => {
    const previous = previousOpenedSubprojectRef.current;
    previousOpenedSubprojectRef.current = openedSubprojectId;
    if (!open || !board || previous === openedSubprojectId) return;
    userInteractedRef.current = false;
    fitView();
  }, [board, fitView, open, openedSubprojectId]);

  const ghostCount = board ? Object.keys(board.ghosts).length : 0;
  const hasNodes = visibleSessions.length > 0
    || (isSubprojectView && subprojectLayout.modules.length > 0)
    || (!openedSubprojectId && ghostCount > 0);

  useLayoutEffect(() => {
    focusedSessionRef.current = null;
  }, [focusSessionId]);

  useLayoutEffect(() => {
    if (!open || !board || !canvasRef.current || !focusSessionId || focusedSessionRef.current === focusSessionId) return;
    const index = sessions.findIndex((session) => session.id === focusSessionId);
    if (index < 0) return;
    if (isSubprojectView) {
      const focusedModule = subprojectLayout.modules.find((candidate) => candidate.sessionIds.includes(focusSessionId));
      const scroll = focusedModule ? subprojectScrollRefs.current[focusedModule.id] : null;
      const card = cardRefs.current[focusSessionId];
      if (!focusedModule || !scroll || !card) return;
      const cardTop = card.offsetTop;
      const cardBottom = cardTop + card.offsetHeight;
      const viewportTop = scroll.scrollTop;
      const viewportBottom = viewportTop + scroll.clientHeight;
      if (cardTop < viewportTop) scroll.scrollTop = cardTop;
      else if (cardBottom > viewportBottom) scroll.scrollTop = Math.max(0, cardBottom - scroll.clientHeight);
      focusedSessionRef.current = focusSessionId;
      return;
    }
    if (talkMapLayout.mode === "subprojects" && !subprojectLayout.positions[focusSessionId]) return;
    focusedSessionRef.current = focusSessionId;
    userInteractedRef.current = false;
    fitView(false);
  }, [board, cardHeights, fitView, focusSessionId, isSubprojectView, open, positionForSession, sessions, subprojectLayout.modules, subprojectLayout.positions, talkMapLayout.mode, updateCamera]);



  const handleFramePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, frame: TalkMapFrame) => {
    if (event.button !== 0 || edgeMode || mapLocked) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    frameDragRef.current = { frameId: frame.id, pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY, x: frame.x, y: frame.y };
  }, [edgeMode, mapLocked]);

  const handleFramePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = frameDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !board) return;
    const x = drag.x + (event.clientX - drag.lastX) / board.camera.zoom;
    const y = drag.y + (event.clientY - drag.lastY) / board.camera.zoom;
    frameDragRef.current = { ...drag, lastX: event.clientX, lastY: event.clientY, x, y };
    setBoard((current) => current ? {
      ...current,
      frames: current.frames.map((frame) => frame.id === drag.frameId ? { ...frame, x, y } : frame),
    } : current);
  }, [board]);

  const handleFramePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = frameDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    frameDragRef.current = null;
    const frame = board?.frames.find((candidate) => candidate.id === drag.frameId)
      ?? worktreeFrames.find((candidate) => candidate.id === drag.frameId);
    if (frame) void persistMutation({ op: "upsert-frame", frame: { ...frame, x: drag.x, y: drag.y } });
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
  }, [board?.frames, persistMutation, worktreeFrames]);

  const handleGhostPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, ghostId: string, ghost: TalkMapGhostCardState) => {
    if (event.button !== 0 || edgeMode) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, textarea, select")) {
      event.stopPropagation();
      return;
    }
    if (mapLocked) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    ghostDragRef.current = { ghostId, pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY, x: ghost.x, y: ghost.y };
  }, [edgeMode, mapLocked]);

  const handleGhostPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = ghostDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !board) return;
    const scale = isSubprojectView ? 1 : board.camera.zoom;
    const x = drag.x + (event.clientX - drag.lastX) / scale;
    const y = drag.y + (event.clientY - drag.lastY) / scale;
    ghostDragRef.current = { ...drag, lastX: event.clientX, lastY: event.clientY, x, y };
    setBoard((current) => {
      if (!current) return current;
      const ghost = current.ghosts[drag.ghostId];
      if (!ghost) return current;
      return { ...current, ghosts: { ...current.ghosts, [drag.ghostId]: { ...ghost, x, y } } };
    });
  }, [board, isSubprojectView]);

  const handleGhostPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = ghostDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    ghostDragRef.current = null;
    const ghost = board?.ghosts[drag.ghostId];
    if (ghost && isSubprojectView && onConvertGhost) {
      const target = subprojectAtPoint(event.clientX, event.clientY);
      if (target && target.id !== UNCLASSIFIED_SUBPROJECT_ID) {
        onConvertGhost(drag.ghostId, ghost, target.id);
        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
        return;
      }
    }
    if (ghost) void persistMutation({ op: "upsert-ghost", ghostId: drag.ghostId, ghost: { ...ghost, x: drag.x, y: drag.y } });
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
  }, [board?.ghosts, isSubprojectView, onConvertGhost, persistMutation, subprojectAtPoint]);

  const deleteGhost = useCallback((ghostId: string) => {
    void persistMutation({ op: "delete-ghost", ghostId });
  }, [persistMutation]);

  const createGhost = useCallback(() => {
    const label = ghostLabel.trim();
    if (!label || !board) return;
    const position = defaultTalkMapPosition(sessions.length + Object.keys(board.ghosts).length);
    void persistMutation({
      op: "upsert-ghost",
      ghost: {
        label,
        ...(ghostBody.trim() ? { body: ghostBody.trim() } : {}),
        x: position.x,
        y: position.y,
        createdAt: new Date().toISOString(),
      },
    });
    setGhostLabel("");
    setGhostBody("");
    setGhostComposerOpen(false);
  }, [board, ghostBody, ghostLabel, persistMutation, sessions.length]);

  const handleCardClick = useCallback(async (event: React.MouseEvent<HTMLDivElement>, sessionId: string) => {
    event.stopPropagation();
    if (cardDragClickRef.current) {
      cardDragClickRef.current = false;
      event.preventDefault();
      return;
    }
    if (edgeSaving) return;
    setSelectedCardId(sessionId);
    const selectedSession = sessions.find((session) => session.id === sessionId);
    if (selectedSession) onSelectCard?.(selectedSession);
    if (!edgeMode) {
      setExpandedRecapIds((current) => {
        const next = new Set(current);
        if (next.has(sessionId)) next.delete(sessionId);
        else next.add(sessionId);
        return next;
      });
      return;
    }
    setSelectedEdgeId(null);
    if (!edgeSource || edgeSource === sessionId) {
      setEdgeSource(edgeSource === sessionId ? null : sessionId);
      setRelationNotice(null);
      return;
    }
    const source = edgeSource;
    const duplicate = Boolean(findRelatedEdge(relationEdges, source, sessionId));
    setEdgeSaving(true);
    const savedBoard = await persistMutation({ op: "upsert-edge", source, target: sessionId, type: "related" });
    setEdgeSaving(false);
    if (!savedBoard) {
      setEdgeSource(source);
      return;
    }
    const savedEdge = findRelatedEdge(savedBoard.edges, source, sessionId);
    setEdgeMode(false);
    setEdgeSource(null);
    setSelectedEdgeId(savedEdge?.id ?? null);
    setRelationNotice(t(duplicate ? "talkMap.relationExists" : "talkMap.relationAdded"));
  }, [edgeMode, edgeSaving, edgeSource, onSelectCard, persistMutation, relationEdges, sessions, t]);

  const beginCardDrag = useCallback((event: ReactPointerEvent<HTMLElement>, sessionId: string, x: number, y: number) => {
    cardDragClickRef.current = false;
    // Layout positions include the source list's scroll content. Capture the
    // visible card instead, so lifting a scrolled card does not make it jump.
    const cardRect = isSubprojectView
      ? event.currentTarget.closest<HTMLElement>("[data-talk-map-card]")?.getBoundingClientRect()
      : undefined;
    dragRef.current = {
      sessionId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      x,
      y,
      active: false,
      pointerOffset: cardRect ? { x: event.clientX - cardRect.left, y: event.clientY - cardRect.top } : undefined,
    };
    setDragPreview({ sessionId, x, y });
  }, [isSubprojectView]);

  const handleCardPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, sessionId: string, x: number, y: number) => {
    if (event.button !== 0 || !canDragCards) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, textarea, select, [data-talk-map-card-drag-handle]")) {
      event.stopPropagation();
      return;
    }
    if (mapLocked) {
      if (edgeMode) event.stopPropagation();
      return;
    }
    event.stopPropagation();
    if (edgeMode) return;
    beginCardDrag(event, sessionId, x, y);
  }, [beginCardDrag, canDragCards, edgeMode, mapLocked]);

  const handleCardDragHandlePointerDown = useCallback((event: ReactPointerEvent<HTMLSpanElement>, sessionId: string, x: number, y: number) => {
    if (event.button !== 0 || edgeMode || mapLocked) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    beginCardDrag(event, sessionId, x, y);
  }, [beginCardDrag, edgeMode, mapLocked]);

  const handleCardPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !board) return;
    let activeDrag = drag;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < TALK_MAP_CARD_DRAG_THRESHOLD) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      activeDrag = { ...drag, active: true };
      setActiveCardDragId(activeDrag.sessionId);
      cardDragClickRef.current = true;
      clearCardTextSelection();
      document.body.classList.add(TALK_MAP_CARD_DRAGGING_CLASS);
    }
    event.preventDefault();
    clearCardTextSelection();
    if (isSubprojectView) setSubprojectDragOverId(subprojectAtPoint(event.clientX, event.clientY)?.id ?? null);
    const scale = isSubprojectView ? 1 : board.camera.zoom;
    const stagePosition = isSubprojectView && activeDrag.pointerOffset
      ? subprojectDragPosition(event.clientX, event.clientY, activeDrag.pointerOffset)
      : null;
    const x = stagePosition?.x ?? activeDrag.x + (event.clientX - activeDrag.lastX) / scale;
    const y = stagePosition?.y ?? activeDrag.y + (event.clientY - activeDrag.lastY) / scale;
    dragRef.current = { ...activeDrag, lastX: event.clientX, lastY: event.clientY, x, y };
    setDragPreview({ sessionId: activeDrag.sessionId, x, y });
    if (!isSubprojectView) {
      setBoard((current) => current ? {
        ...current,
        cards: { ...current.cards, [activeDrag.sessionId]: { ...(current.cards[activeDrag.sessionId] ?? {}), x, y } },
      } : current);
    }
  }, [board, isSubprojectView, subprojectAtPoint, subprojectDragPosition]);

  const handleCardPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setActiveCardDragId(null);
    document.body.classList.remove(TALK_MAP_CARD_DRAGGING_CLASS);
    if (isSubprojectView) setSubprojectDragOverId(null);
    if (!drag.active) {
      setDragPreview(null);
      return;
    }
    event.preventDefault();
    clearCardTextSelection();
    if (event.type !== "pointercancel") {
      if (isSubprojectView) setPendingCardDrop({ sessionId: drag.sessionId, x: drag.x, y: drag.y, clientX: event.clientX, clientY: event.clientY });
      else void persistMutation({ op: "upsert-card", sessionId: drag.sessionId, x: drag.x, y: drag.y });
    }
    setDragPreview(null);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
  }, [isSubprojectView, persistMutation]);

  useEffect(() => () => { document.body.classList.remove(TALK_MAP_CARD_DRAGGING_CLASS); }, []);

  const deleteSelectedEdge = useCallback(async () => {
    if (!selectedEdgeId || edgeSaving) return;
    const edgeId = selectedEdgeId;
    setEdgeSaving(true);
    const savedBoard = await persistMutation({ op: "delete-edge", edgeId });
    setEdgeSaving(false);
    if (!savedBoard) return;
    setSelectedEdgeId(null);
    setRelationNotice(t("talkMap.relationDeleted"));
  }, [edgeSaving, persistMutation, selectedEdgeId, t]);

  const forkCardSession = useCallback(async (session: SessionInfo) => {
    if (!onForkSession || actionKey) return;
    setActionKey(`fork:${session.id}`);
    setError(null);
    try {
      await onForkSession(session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActionKey(null);
    }
  }, [actionKey, onForkSession]);

  const archiveCardSession = useCallback(async (session: SessionInfo) => {
    if (!onArchiveSession || actionKey || session.transient) return;
    setActionKey(`archive:${session.id}`);
    setError(null);
    try {
      await onArchiveSession(session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActionKey(null);
    }
  }, [actionKey, onArchiveSession]);

  const deleteCardSession = useCallback(async (session: SessionInfo) => {
    if (!onDeleteSession || actionKey || session.transient) return;
    if (typeof window !== "undefined" && !window.confirm(t("talkMap.deleteConfirm", { title: sessionTitle(session) }))) return;
    setActionKey(`delete:${session.id}`);
    setError(null);
    try {
      await onDeleteSession(session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActionKey(null);
    }
  }, [actionKey, onDeleteSession, t]);

  const moveSessionToSubproject = useCallback(async (session: SessionInfo, subprojectId: string | null): Promise<boolean> => {
    if (session.transient || !session.projectKey) return false;
    const previousSubprojectId = session.subprojectId;
    const optimisticSubprojectId = subprojectId ?? null;
    const applyAssignment = (nextSubprojectId: string | undefined, onlyIf?: string | null) => {
      setSessions((current) => current.map((candidate) => {
        if (candidate.id !== session.id) return candidate;
        if (onlyIf !== undefined && (candidate.subprojectId ?? null) !== onlyIf) return candidate;
        return candidate.subprojectId === nextSubprojectId ? candidate : { ...candidate, subprojectId: nextSubprojectId };
      }));
    };
    applyAssignment(subprojectId ?? undefined);
    try {
      const response = await fetch(apiPathForPeer(remotePeer, `sessions/${encodeURIComponent(session.id)}/subproject`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectKey: session.projectKey, subprojectId }),
      });
      const body = await response.json().catch(() => ({})) as { session?: SessionInfo; error?: string };
      if (!response.ok) throw new Error(body.error || `Subproject HTTP ${response.status}`);
      const serverSubprojectId = body.session ? body.session.subprojectId : subprojectId ?? undefined;
      applyAssignment(serverSubprojectId, optimisticSubprojectId);
      setError(null);
      return true;
    } catch (cause) {
      applyAssignment(previousSubprojectId, optimisticSubprojectId);
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }, [remotePeer]);

  useEffect(() => {
    const drop = pendingCardDrop;
    if (!drop || !board || !isSubprojectView) return;
    setPendingCardDrop(null);
    const session = sessions.find((candidate) => candidate.id === drop.sessionId);
    if (!session) return;
    const target = subprojectAtPoint(drop.clientX, drop.clientY);
    if (!target) return;
    const targetIds = target.sessionIds.filter((id) => id !== session.id);
    const contentY = subprojectContentYForClient(target.id, drop.clientY);
    const targetIndex = contentY === null ? null : talkMapSubprojectDropIndex(targetIds, contentY, CARD_MIN_HEIGHT, cardHeights);
    const currentOrder = [...talkMapLayout.manualOrder, ...sessions.map((candidate) => candidate.id)]
      .filter((id, index, ids) => ids.indexOf(id) === index);
    const nextLayout = targetIndex === null
      ? null
      : { ...talkMapLayout, manualOrder: reorderTalkMapSessionOrder(currentOrder, targetIds, session.id, targetIndex) };
    const currentSubprojectId = session.subprojectId && ownedSubprojectIds.has(session.subprojectId) ? session.subprojectId : null;
    const targetSubprojectId = target.id === UNCLASSIFIED_SUBPROJECT_ID ? null : target.id;
    const assignment = currentSubprojectId === targetSubprojectId
      ? Promise.resolve(true)
      : moveSessionToSubproject(session, targetSubprojectId);
    void assignment.then((ok) => {
      if (!ok || talkMapLayout.sort !== "manual" || !nextLayout) return;
      void persistMutation({ op: "set-layout", layout: nextLayout });
    });
  }, [board, cardHeights, isSubprojectView, moveSessionToSubproject, ownedSubprojectIds, pendingCardDrop, persistMutation, sessions, subprojectAtPoint, subprojectContentYForClient, talkMapLayout]);


  const renderSessionCard = (session: SessionInfo, module?: TalkMapSubprojectModule, overlay = false) => {
    const stored = board?.cards[session.id];
    if (stored?.hidden) return null;
    const index = sessions.findIndex((candidate) => candidate.id === session.id);
    const isActiveDrag = activeCardDragId === session.id;
    // The hidden source remains at its layout position so it cannot enlarge
    // the source list's scroll area while the overlay crosses other frames.
    const position = module && isActiveDrag
      ? subprojectLayout.positions[session.id] ?? defaultTalkMapPosition(index)
      : positionForSession(session, index);
    const cardPosition = module
      ? { x: position.x - module.x, y: position.y - module.y - TALK_MAP_SUBPROJECT_HEADER_HEIGHT }
      : position;
    const activity = activityBySession.get(session.id);
    const recapText = sessionRecapDisplay(activity?.lastRecap).body;
    const status = activity?.status;
    const sessionSubproject = session.subprojectId ? subprojectById.get(session.subprojectId) : undefined;
    const isFocused = focusSessionId === session.id;
    const isEdgeSource = edgeSource === session.id;
    const recapExpanded = expandedRecapIds.has(session.id);
    const recapToggleLabel = recapExpanded ? t("talkMap.collapseRecap") : t("talkMap.expandRecap");
    const hasKeyboardFocus = focusedCardId === session.id;
    const actionsVisible = !canHover || hoveredCardId === session.id || hasKeyboardFocus || selectedCardId === session.id;
    return (
      <div
        key={session.id}
        data-talk-map-card
        data-talk-map-card-id={overlay ? undefined : session.id}
        data-talk-map-drag-overlay={overlay ? "true" : undefined}
        aria-hidden={overlay ? true : undefined}
        inert={overlay ? true : undefined}
        ref={(element) => { if (!overlay) cardRefs.current[session.id] = element; }}
        role="button"
        tabIndex={overlay ? -1 : 0}
        data-talk-map-focused={isFocused ? "true" : undefined}
        data-talk-map-edge-source={isEdgeSource ? "true" : undefined}
        onClick={(event) => handleCardClick(event, session.id)}
        onMouseEnter={() => setHoveredCardId(session.id)}
        onMouseLeave={() => setHoveredCardId((current) => current === session.id ? null : current)}
        onFocus={() => setFocusedCardId(session.id)}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedCardId((current) => current === session.id ? null : current); }}
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === " ") && !edgeMode) {
            event.preventDefault();
            onOpenSession(session);
          }
        }}
        onPointerDown={(event) => handleCardPointerDown(event, session.id, position.x, position.y)}
        onPointerMove={handleCardPointerMove}
        onPointerUp={handleCardPointerUp}
        onPointerCancel={handleCardPointerUp}
        onDoubleClick={(event) => { event.stopPropagation(); if (!edgeMode) onOpenSession(session); }}
        title={t("talkMap.openHint")}
        style={{
          position: "absolute",
          left: cardPosition.x,
          top: cardPosition.y,
          width: CARD_WIDTH,
          minHeight: CARD_MIN_HEIGHT,
          boxSizing: "border-box",
          padding: "10px 12px 8px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          border: isFocused ? "2px solid #2563eb" : "1px solid var(--border)",
          borderTop: `3px solid ${statusColor(status)}`,
          borderRadius: 10,
          outline: isFocused ? "3px solid #2563eb" : isEdgeSource ? "3px dashed #2563eb" : hasKeyboardFocus ? "2px solid var(--accent)" : "none",
          outlineOffset: isFocused || isEdgeSource || hasKeyboardFocus ? 4 : 0,
          background: "var(--bg-panel)",
          boxShadow: isFocused
            ? "0 0 0 7px rgba(37,99,235,0.2), 0 8px 24px rgba(0,0,0,0.12)"
            : "0 8px 24px rgba(0,0,0,0.12)",
          userSelect: "none",
          visibility: isActiveDrag && module && !overlay ? "hidden" : undefined,
          pointerEvents: overlay ? "none" : undefined,
          zIndex: overlay ? 100 : dragPreview?.sessionId === session.id ? 30 : isFocused ? 2 : 1,
          cursor: edgeMode ? "crosshair" : mapLocked || canDragCards ? "grab" : "default",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {isSubprojectView && <span
            data-talk-map-card-drag-handle
            onPointerDown={(event) => handleCardDragHandlePointerDown(event, session.id, position.x, position.y)}
            onClick={(event) => {
              event.stopPropagation();
              cardDragClickRef.current = false;
            }}
            title={t("talkMap.dragCard")}
            aria-label={t("talkMap.dragCard")}
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, flexShrink: 0, margin: "-2px 0 -2px -4px", color: "var(--text-dim)", cursor: edgeMode ? "not-allowed" : mapLocked ? "default" : "grab", touchAction: "none", userSelect: "none", fontSize: 12, letterSpacing: -2 }}
          >⋮⋮</span>}
          <span
            aria-hidden="true"
            data-talk-map-card-status
            style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: statusColor(status) }}
          />
          <strong style={{ flex: "1 1 auto", minWidth: 0, fontSize: 12, lineHeight: 1.3, overflowWrap: "anywhere" }}>{sessionTitle(session)}</strong>
          <button type="button" data-talk-map-open-session onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); if (!edgeMode) onOpenSession(session); }} title={t("talkMap.openHint")} aria-label={t("talkMap.openHint")} style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, flexShrink: 0, padding: 0, border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text-muted)", cursor: edgeMode ? "not-allowed" : "pointer" }}>
            <ExternalLink size={13} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <button
            type="button"
            data-talk-map-recap-toggle
            disabled={edgeMode}
            aria-expanded={recapExpanded}
            aria-label={recapToggleLabel}
            title={recapToggleLabel}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); if (!edgeMode) toggleRecap(session.id); }}
            style={{ ...controlStyle(edgeMode), width: 24, height: 24, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", color: edgeMode ? "var(--text-dim)" : recapExpanded ? "var(--accent)" : "var(--text-dim)" }}
          >
            {recapExpanded ? <Eye size={13} strokeWidth={1.8} aria-hidden="true" /> : <EyeOff size={13} strokeWidth={1.8} aria-hidden="true" />}
          </button>
        </div>
        {sessionSubproject && talkMapLayout.mode !== "subprojects" && <span data-talk-map-subproject={sessionSubproject.id} style={{ alignSelf: "flex-start", maxWidth: "100%", display: "inline-flex", alignItems: "center", height: 18, boxSizing: "border-box", padding: "0 7px", borderRadius: 999, background: "rgba(139,92,246,0.12)", color: "#7c3aed", fontSize: 10, lineHeight: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sessionSubproject.label}</span>}
        <TalkMapCardQuestions
          sessionId={session.id}
          version={session.modified}
          peer={activity?.device?.id ?? remotePeer}
          deviceId={activity?.device?.id ?? remotePeer}
          expanded={recapExpanded}
        />
        {recapText && (
          <TalkMapCardRecap
            expanded={recapExpanded}
          >
            {recapText}
          </TalkMapCardRecap>
        )}
        <div data-talk-map-card-footer style={{ display: "flex", alignItems: "center", gap: 4, minHeight: 24, marginTop: 4, flexShrink: 0 }}>
          {(onForkSession || onInjectContext || (onCopySessionInfo && activity?.session.path?.trim()) || ownedSubprojects.length > 0 || onArchiveSession || onDeleteSession) && (
            <div style={{ display: actionsVisible ? "flex" : "none", alignItems: "center", gap: 4, flexShrink: 0 }}>
              {onForkSession && <button
              type="button"
              data-talk-map-fork
              disabled={edgeMode || Boolean(actionKey)}
              aria-label={actionKey === `fork:${session.id}` ? t("talkMap.forking") : t("talkMap.fork")}
              title={actionKey === `fork:${session.id}` ? t("talkMap.forking") : t("talkMap.fork")}
              aria-busy={actionKey === `fork:${session.id}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); void forkCardSession(session); }}
              style={{ ...controlStyle(edgeMode || Boolean(actionKey)), width: 24, height: 24, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
            ><GitFork size={12} strokeWidth={1.8} aria-hidden="true" /></button>}
            {onInjectContext && <button
              type="button"
              data-talk-map-inject
              disabled={edgeMode || Boolean(actionKey)}
              aria-label={t("talkMap.injectContext")}
              title={t("talkMap.injectContext")}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onInjectContext(session);
              }}
              style={{ ...controlStyle(edgeMode || Boolean(actionKey)), width: 24, height: 24, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
            ><FileInput size={12} strokeWidth={1.8} aria-hidden="true" /></button>}
            {onCopySessionInfo && activity?.session.path?.trim() && <button
              type="button"
              data-talk-map-copy-session-info
              disabled={edgeMode || Boolean(actionKey)}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                void Promise.resolve()
                  .then(() => onCopySessionInfo(activity))
                  .then(() => {
                    setActionKey(`copy:${session.id}`);
                    window.setTimeout(() => setActionKey((current) => current === `copy:${session.id}` ? null : current), 900);
                  })
                  .catch(() => {
                    setActionKey((current) => current === `copy:${session.id}` ? null : current);
                  });
              }}
              title={actionKey === `copy:${session.id}` ? t("session.copied") : t("session.copySourceInfo")}
              aria-label={actionKey === `copy:${session.id}` ? t("session.copied") : t("session.copySourceInfo")}
              aria-live="polite"
              style={{ ...controlStyle(edgeMode || (Boolean(actionKey) && actionKey !== `copy:${session.id}`)), width: 24, height: 24, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", color: actionKey === `copy:${session.id}` ? "var(--accent)" : undefined, transform: actionKey === `copy:${session.id}` ? "scale(1.08)" : "scale(1)", boxShadow: actionKey === `copy:${session.id}` ? "0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent)" : "none", transition: "transform 140ms ease, box-shadow 140ms ease, color 140ms ease" }}
            >
              {actionKey === `copy:${session.id}` ? <Check size={12} strokeWidth={2.2} aria-hidden="true" /> : <Copy size={12} strokeWidth={1.8} aria-hidden="true" />}
            </button>}
            {onArchiveSession && <button
              type="button"
              data-talk-map-archive
              disabled={edgeMode || Boolean(actionKey) || Boolean(session.transient) || status === "running"}
              aria-busy={actionKey === `archive:${session.id}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); void archiveCardSession(session); }}
              title={actionKey === `archive:${session.id}` ? t("talkMap.archiving") : status === "running" ? t("talkMap.archiveRunning") : t("talkMap.archive")}
              aria-label={actionKey === `archive:${session.id}` ? t("talkMap.archiving") : status === "running" ? t("talkMap.archiveRunning") : t("talkMap.archive")}
              style={{ ...controlStyle(edgeMode || Boolean(actionKey) || Boolean(session.transient) || status === "running"), width: 24, height: 24, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
            >
              <Archive size={12} strokeWidth={1.8} aria-hidden="true" />
            </button>}
            {onDeleteSession && <button
              type="button"
              data-talk-map-delete
              disabled={edgeMode || Boolean(actionKey) || Boolean(session.transient)}
              aria-busy={actionKey === `delete:${session.id}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); void deleteCardSession(session); }}
              title={actionKey === `delete:${session.id}` ? t("talkMap.deleting") : t("talkMap.delete")}
              aria-label={actionKey === `delete:${session.id}` ? t("talkMap.deleting") : t("talkMap.delete")}
              style={{ ...controlStyle(edgeMode || Boolean(actionKey) || Boolean(session.transient)), width: 24, height: 24, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#dc2626" }}
            >
              <Trash2 size={12} strokeWidth={1.8} aria-hidden="true" />
            </button>}
            <SessionSubprojectMenu
              subprojects={ownedSubprojects}
              currentSubprojectId={session.subprojectId}
              compact
              disabled={Boolean(session.transient || !session.projectKey)}
              onMove={(subprojectId) => moveSessionToSubproject(session, subprojectId)}
            />
            </div>
          )}
          <div data-talk-map-card-meta style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", minWidth: 0, maxWidth: "100%", marginLeft: "auto", overflow: "hidden" }}>
            {activity ? (
              <SessionActivityMeta item={activity} sort={sharedFilters.sort} modelPlacement="after-time" style={{ width: "auto", maxWidth: "100%", justifyContent: "flex-end" }} />
            ) : activitySnapshotReady ? (
              <SessionListMeta session={session} style={{ marginTop: 0, maxWidth: "100%", justifyContent: "flex-end" }} />
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  const subprojectClientCenter = useCallback((sessionId: string) => {
    const card = cardRefs.current[sessionId];
    const stage = subprojectStageRef.current;
    if (!card || !stage) return null;
    const cardRect = card.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    return {
      x: cardRect.left - stageRect.left + stage.scrollLeft + cardRect.width / 2,
      y: cardRect.top - stageRect.top + stage.scrollTop + cardRect.height / 2,
    };
  }, []);

  const relationPointForSession = useCallback((session: SessionInfo, index: number) => {
    if (isSubprojectView) return subprojectClientCenter(session.id);
    const position = positionForSession(session, index);
    return {
      x: position.x + CARD_WIDTH / 2,
      y: position.y + measuredCardHeight(cardHeights, session.id) / 2,
    };
  }, [cardHeights, isSubprojectView, positionForSession, subprojectClientCenter]);

  const renderRelationEdges = () => (
    <svg data-talk-map-edges data-talk-map-geometry-revision={subprojectGeometryRevision} width="1" height="1" aria-hidden="true" style={{ position: "absolute", left: 0, top: 0, width: 1, height: 1, overflow: "visible", pointerEvents: "auto", zIndex: 0 }}>
      {board?.edges.map((edge) => {
        const sourceSession = visibleSessionById.get(edge.source);
        const targetSession = visibleSessionById.get(edge.target);
        const sourceIndex = sourceSession ? sessions.findIndex((session) => session.id === sourceSession.id) : -1;
        const targetIndex = targetSession ? sessions.findIndex((session) => session.id === targetSession.id) : -1;
        const sourceStored = sourceSession ? board.cards[sourceSession.id] : undefined;
        const targetStored = targetSession ? board.cards[targetSession.id] : undefined;
        if (!sourceSession || !targetSession || sourceStored?.hidden || targetStored?.hidden || sourceIndex < 0 || targetIndex < 0) return null;
        const sourcePosition = relationPointForSession(sourceSession, sourceIndex);
        const targetPosition = relationPointForSession(targetSession, targetIndex);
        if (!sourcePosition || !targetPosition) return null;
        const selected = selectedEdgeId === edge.id;
        return (
          <g key={edge.id}>
            <line
              data-talk-map-edge
              x1={sourcePosition.x}
              y1={sourcePosition.y}
              x2={targetPosition.x}
              y2={targetPosition.y}
              stroke="transparent"
              strokeWidth={18}
              strokeLinecap="round"
              pointerEvents="stroke"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); if (!edgeMode && !edgeSaving) { setSelectedEdgeId(edge.id); setRelationNotice(null); setRelationPanelOpen(true); } }}
            />
            <line x1={sourcePosition.x} y1={sourcePosition.y} x2={targetPosition.x} y2={targetPosition.y} stroke={selected ? "#2563eb" : "var(--text-dim)"} strokeWidth={selected ? 3 : 2} strokeLinecap="round" strokeDasharray={edge.type === "lineage" ? "6 4" : undefined} pointerEvents="none" />
          </g>
        );
      })}
    </svg>
  );

  const renderGhostCards = () => (
    !openedSubprojectId && Object.entries(board?.ghosts ?? {}).map(([ghostId, ghost]) => (
      <div
        key={ghostId}
        data-talk-map-ghost-card
        data-talk-map-ghost-id={ghostId}
        onPointerDown={(event) => handleGhostPointerDown(event, ghostId, ghost)}
        onPointerMove={handleGhostPointerMove}
        onPointerUp={handleGhostPointerUp}
        onPointerCancel={handleGhostPointerUp}
        style={{ position: "absolute", left: ghost.x, top: ghost.y, width: CARD_WIDTH, minHeight: CARD_MIN_HEIGHT, boxSizing: "border-box", padding: "10px 12px 8px", display: "flex", flexDirection: "column", gap: 6, border: "2px dashed #a855f7", borderRadius: 10, background: "color-mix(in srgb, #a855f7 7%, var(--bg-panel))", color: "var(--text)", opacity: 0.88, userSelect: "none", cursor: edgeMode ? "crosshair" : mapLocked ? "grab" : "move", zIndex: 2 }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
          <strong style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.3, overflowWrap: "anywhere" }}>{ghost.label}</strong>
          <span style={{ color: "#a855f7", fontSize: 10, whiteSpace: "nowrap" }}>{t("talkMap.ghost")}</span>
        </div>
        <div style={{ color: ghost.body ? "var(--text-muted)" : "var(--text-dim)", fontSize: 11, lineHeight: 1.65, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {ghost.body || t("talkMap.ghostHint")}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
          {onConvertGhost && <button type="button" data-talk-map-convert-ghost onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onConvertGhost(ghostId, ghost); }} disabled={edgeMode} style={{ ...controlStyle(edgeMode), height: 24, padding: "0 6px", fontSize: 10 }}>{t("talkMap.convertGhost")}</button>}
          <button type="button" data-talk-map-delete-ghost onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); deleteGhost(ghostId); }} disabled={edgeMode} style={{ ...controlStyle(edgeMode), height: 24, padding: "0 6px", fontSize: 10 }}>{t("talkMap.ghostDelete")}</button>
        </div>
      </div>
    ))
  );

  const startNewSession = useCallback((subprojectId?: string, subprojectLabel?: string) => {
    onClose();
    onNewSession?.(subprojectId, subprojectLabel);
  }, [onClose, onNewSession]);

  // A dragged subproject card must leave its scroll/overflow stacking context.
  // Keep the source card in place for layout, but paint the active card once at
  // the stage root so it can cross another subproject frame without clipping.
  const draggingSubprojectSession = isSubprojectView && activeCardDragId
    ? visibleSessionById.get(activeCardDragId) ?? null
    : null;

  if (!open) return null;

  return (
    <div
      className="talk-map-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t("talkMap.title")}
      onPointerDownCapture={handleOverlayPointerDown}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 800,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        color: "var(--text)",
        overflow: "hidden",
      }}
    >
      <div className="talk-map-toolbar" style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 48, padding: "8px 12px", boxSizing: "border-box", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)", flexShrink: 0, position: "relative", zIndex: 20 }}>
        <div className="talk-map-toolbar-top">
          <div className="talk-map-toolbar-identity">
            <button type="button" onClick={onClose} style={controlStyle()} title={t("talkMap.close")} aria-label={t("talkMap.close")}>
              <X size={15} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <div className="talk-map-toolbar-names">
              <strong className="talk-map-title" style={{ color: "var(--text)", fontSize: 14, fontWeight: 700, minWidth: 0 }} title={projectRoot ?? ""}>
                {mapLabel}
              </strong>
              {selectedCardTitle && <>
                <span aria-hidden="true" style={{ color: "var(--text-dim)", flexShrink: 0 }}>·</span>
                <span className="talk-map-selected-card-title" data-talk-map-selected-card-title title={selectedCardTitle} style={{ minWidth: 0, color: "var(--text)", fontSize: 12, fontWeight: 650 }}>
                  {selectedCardTitle}
                </span>
              </>}
            </div>
          </div>
          <div className="talk-map-toolbar-top-actions" role="toolbar" aria-label={t("talkMap.refresh")} data-talk-map-refresh-area>
            {saving && (
              <span
                className="talk-map-save-status"
                data-talk-map-save-status
                role="status"
                aria-live="polite"
                style={{ color: "var(--accent)", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}
              >
                {t("talkMap.saving")}
              </span>
            )}
            <div className="talk-map-toolbar-group" data-talk-map-time-range>
              <ReaderFloatingSelect
                value={mapTimeRange}
                onChange={(value) => updateSharedFilters({ days: value as ActivityTimeRange })}
                options={[{ value: "all", label: t("sessionActivity.allTime") }, ...["1", "3", "7", "14", "30", "90"].map((days) => ({ value: days, label: t("sessionActivity.withinDays", { count: Number(days) }) }))]}
                ariaLabel={t("sessionActivity.timeRange")}
                title={t("sessionActivity.timeRange")}
                placement="below"
                triggerStyle={{ ...controlStyle(), maxWidth: 120, display: "inline-flex", justifyContent: "space-between", gap: 5, overflow: "hidden", textOverflow: "ellipsis" }}
                menuMinWidth={140}
                optionMinHeight={28}
              />
            </div>
            <button
              type="button"
              onClick={() => { if (projectRoot) void loadBoard(projectRoot); }}
              disabled={!board || loading}
              data-talk-map-refresh
              aria-busy={loading}
              title={t("talkMap.refresh")}
              aria-label={t("talkMap.refresh")}
              className="talk-map-refresh-action"
              style={{ ...controlStyle(!board || loading), display: "inline-flex", alignItems: "center", gap: 5 }}
            >
              <RefreshCw size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>{t("talkMap.refresh")}</span>
            </button>
          </div>
        </div>
        <div className="talk-map-toolbar-actions" role="toolbar" aria-label={t("talkMap.title")}>
          <div className="talk-map-toolbar-group talk-map-toolbar-group-sidebar">
              <button
                type="button"
                onClick={() => setSubprojectPanelOpen((current) => !current)}
                disabled={!mapProjectKey}
                aria-expanded={subprojectPanelOpen}
                aria-controls="talk-map-subproject-sidebar"
                data-talk-map-subproject-panel-toggle
                title={t("talkMap.subprojectVisibility")}
                style={{ ...controlStyle(!mapProjectKey), display: "inline-flex", alignItems: "center", gap: 5, color: subprojectPanelOpen ? "var(--accent)" : undefined }}
              >
                <PanelLeft size={14} strokeWidth={1.8} aria-hidden="true" />
                <span>{t("talkMap.subprojectVisibility")}</span>
              </button>
            </div>
          <div className="talk-map-toolbar-group talk-map-toolbar-layout-center" data-talk-map-layout>
            <div className="talk-map-layout-toggle" role="group" aria-label={t("talkMap.layout")} style={{ display: "inline-flex", alignItems: "center", gap: 2, padding: 2, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)", boxSizing: "border-box", boxShadow: "inset 0 1px 2px rgba(0,0,0,0.04)" }}>
              <button
                type="button"
                onClick={() => selectLayoutMode("free")}
                disabled={!board}
                aria-pressed={layoutMode === "free"}
                data-talk-map-layout-free
                style={{ ...controlStyle(!board), height: 28, minWidth: 86, padding: "0 10px", border: "1px solid transparent", borderRadius: 6, background: layoutMode === "free" ? "var(--accent)" : "transparent", color: layoutMode === "free" ? "#fff" : "var(--text-muted)", boxShadow: layoutMode === "free" ? "0 1px 2px rgba(0,0,0,0.14)" : "none", fontWeight: layoutMode === "free" ? 650 : 500, boxSizing: "border-box", whiteSpace: "nowrap" }}
              >{t("talkMap.layoutFree")}</button>
              <button
                type="button"
                onClick={() => selectLayoutMode("subprojects")}
                disabled={!board}
                aria-pressed={layoutMode === "subprojects"}
                data-talk-map-layout-subprojects
                style={{ ...controlStyle(!board), height: 28, minWidth: 86, padding: "0 10px", border: "1px solid transparent", borderRadius: 6, background: layoutMode === "subprojects" ? "var(--accent)" : "transparent", color: layoutMode === "subprojects" ? "#fff" : "var(--text-muted)", boxShadow: layoutMode === "subprojects" ? "0 1px 2px rgba(0,0,0,0.14)" : "none", fontWeight: layoutMode === "subprojects" ? 650 : 500, boxSizing: "border-box", whiteSpace: "nowrap" }}
              >{t("talkMap.layoutSubprojects")}</button>
            </div>
          </div>
          {layoutMode === "subprojects" && (
            <div className="talk-map-toolbar-group" data-talk-map-card-sort-group>
              <span data-talk-map-card-sort style={{ display: "inline-flex" }}>
                <ReaderFloatingSelect
                  value={talkMapLayout.sort}
                  onChange={(value) => updateTalkMapLayout({ sort: value === "status" || value === "asked" ? value : "manual" })}
                  disabled={!board}
                  options={[{ value: "asked", label: t("talkMap.sortAsked") }, { value: "manual", label: t("talkMap.sortManual") }, { value: "status", label: t("talkMap.sortStatus") }]}
                  ariaLabel={t("talkMap.cardSort")}
                  title={t("talkMap.cardSort")}
                  placement="below"
                  triggerStyle={{ ...controlStyle(!board), maxWidth: 132, display: "inline-flex", justifyContent: "space-between", gap: 5, overflow: "hidden", textOverflow: "ellipsis" }}
                  menuMinWidth={145}
                  optionMinHeight={28}
                />
              </span>
            </div>
          )}
          <div className="talk-map-toolbar-group talk-map-toolbar-group-actions" data-talk-map-core-actions>
            <button type="button" onClick={() => setGhostComposerOpen(true)} disabled={!board} data-talk-map-add-ghost title={t("talkMap.addGhost")} aria-label={t("talkMap.addGhost")} style={{ ...controlStyle(!board), display: "inline-flex", alignItems: "center", gap: 5 }}>
              <StickyNote size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>{t("talkMap.addGhost")}</span>
            </button>
          </div>
          <div className="talk-map-toolbar-group talk-map-relation-actions">
            <button
              type="button"
              onClick={edgeMode ? cancelEdgeMode : startEdgeMode}
              disabled={!board || edgeSaving}
              data-talk-map-add-edge
              data-talk-map-edge-toggle
              aria-pressed={edgeMode}
              title={t(edgeMode ? "talkMap.cancelEdge" : "talkMap.addEdgeHint")}
              style={{
                ...controlStyle(!board || edgeSaving),
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                ...(edgeMode ? {
                  background: "var(--bg-selected)",
                  borderColor: "var(--accent)",
                  color: "var(--text)",
                  fontWeight: 650,
                } : {}),
              }}
            >
              {edgeMode ? <X size={14} strokeWidth={1.8} aria-hidden="true" /> : <Link2 size={14} strokeWidth={1.8} aria-hidden="true" />}
              <span>{t(edgeMode ? "talkMap.cancelEdge" : "talkMap.addEdge")}</span>
            </button>
            <button
              type="button"
              onClick={toggleRelationPanel}
              disabled={!board}
              data-talk-map-relations-toggle
              aria-expanded={relationPanelOpen}
              aria-controls="talk-map-relations"
              title={t("talkMap.relationsHint")}
              style={{ ...controlStyle(!board), display: "inline-flex", alignItems: "center", gap: 5, background: relationPanelOpen ? "var(--bg-selected)" : "var(--bg-panel)", color: relationPanelOpen ? "var(--text)" : undefined }}
            >
              <List size={14} strokeWidth={1.8} aria-hidden="true" />
              {t("talkMap.relations")} ({relationEdges.length})
            </button>
          </div>
          <div className="talk-map-toolbar-group talk-map-toolbar-group-actions">
            <button
              type="button"
              onClick={() => setMapLocked((current) => !current)}
              disabled={!board}
              data-talk-map-lock
              aria-pressed={mapLocked}
              title={mapLocked ? t("talkMap.unlockCards") : t("talkMap.lockCards")}
              style={{ ...controlStyle(!board), display: "inline-flex", alignItems: "center", gap: 5, background: mapLocked ? "var(--bg-selected)" : "var(--bg-panel)", color: mapLocked ? "var(--text)" : undefined }}
            >
              {mapLocked ? <Unlock size={14} strokeWidth={1.8} aria-hidden="true" /> : <Lock size={14} strokeWidth={1.8} aria-hidden="true" />}
              <span>{mapLocked ? t("talkMap.unlockCards") : t("talkMap.lockCards")}</span>
            </button>
            <button
              type="button"
              onClick={toggleAllRecaps}
              disabled={!board || visibleCardIds.length === 0}
              data-talk-map-recap-toggle-all
              aria-pressed={allRecapsExpanded}
              title={recapToggleAllLabel}
              aria-label={recapToggleAllLabel}
              style={{ ...controlStyle(!board || visibleCardIds.length === 0), display: "inline-flex", alignItems: "center", gap: 5, color: !board || visibleCardIds.length === 0 ? "var(--text-dim)" : allRecapsExpanded ? "var(--accent)" : "var(--text-dim)" }}
            >
              {allRecapsExpanded ? <Eye size={14} strokeWidth={1.8} aria-hidden="true" /> : <EyeOff size={14} strokeWidth={1.8} aria-hidden="true" />}
              <span>{recapToggleAllLabel}</span>
            </button>
          </div>
        </div>
        {relationPanelOpen && (
          <div
            id="talk-map-relations"
            className="talk-map-relations-panel"
            data-talk-map-relations
            role="dialog"
            aria-modal={false}
            aria-labelledby="talk-map-relations-title"
            onPointerDown={(event) => event.stopPropagation()}
            style={{ position: "absolute", zIndex: 15, top: "calc(100% + 8px)", right: 12, width: "min(380px, calc(100vw - 24px))", maxHeight: "min(60vh, 460px)", overflowY: "auto", padding: 10, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", boxShadow: "0 10px 28px rgba(0,0,0,0.16)" }}
          >
            <div className="talk-map-relations-header">
              <strong id="talk-map-relations-title">{t("talkMap.relations")} ({relationEdges.length})</strong>
              <div className="talk-map-relations-actions" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {selectedEdgeId && !edgeMode && <button type="button" onClick={() => void deleteSelectedEdge()} disabled={edgeSaving} data-talk-map-delete-edge aria-busy={edgeSaving} style={{ ...controlStyle(edgeSaving), height: 26, padding: "0 7px", display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <Trash2 size={13} strokeWidth={1.8} aria-hidden="true" />
                  <span>{t("talkMap.deleteEdge")}</span>
                </button>}
                <button type="button" onClick={closeRelationPanel} disabled={edgeSaving} data-talk-map-relations-close title={t("talkMap.closeRelations")} aria-label={t("talkMap.closeRelations")} style={{ ...controlStyle(edgeSaving), width: 26, height: 26, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                  <X size={14} strokeWidth={1.8} aria-hidden="true" />
                </button>
              </div>
            </div>
            {edgeMode && <div role="status" aria-live="polite" data-talk-map-edge-status className="talk-map-relation-status" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Link2 size={13} strokeWidth={1.8} aria-hidden="true" />
              <span>{edgeSaving ? t("talkMap.edgeSaving") : t(edgeSource ? "talkMap.edgeTargetHint" : "talkMap.edgeSourceHint")}</span>
              {edgeSource && <strong style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={sessionById.get(edgeSource) ? sessionTitle(sessionById.get(edgeSource)!) : edgeSource}>{sessionById.get(edgeSource) ? sessionTitle(sessionById.get(edgeSource)!) : edgeSource.slice(0, 12)}</strong>}
            </div>}
            {relationNotice && !edgeMode && <div role="status" aria-live="polite" data-talk-map-relation-notice className="talk-map-relation-status" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Check size={13} strokeWidth={1.8} aria-hidden="true" />
              <span>{relationNotice}</span>
            </div>}
            <input value={relationSearch} onChange={(event) => setRelationSearch(event.target.value)} disabled={edgeMode || edgeSaving} placeholder={t("talkMap.relationSearch")} aria-label={t("talkMap.relationSearch")} style={{ width: "100%", boxSizing: "border-box", marginBottom: 8, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", fontSize: 11 }} />
            {filteredRelations.length === 0 ? <div style={{ padding: "8px 2px", color: "var(--text-dim)", fontSize: 11 }}>{relationSearch.trim() ? t("talkMap.noMatchingRelations") : t("talkMap.noRelations")}</div> : filteredRelations.map((edge) => {
              const sourceSession = sessionById.get(edge.source);
              const targetSession = sessionById.get(edge.target);
              const endpointHidden = !visibleSessionById.has(edge.source) || !visibleSessionById.has(edge.target);
              const endpointState = !sourceSession || !targetSession
                ? t("talkMap.relationUnavailable")
                : endpointHidden ? t("talkMap.relationFiltered") : null;
              const selected = selectedEdgeId === edge.id;
              return (
                <button key={edge.id} type="button" data-talk-map-relation-row disabled={edgeMode || edgeSaving} aria-pressed={selected} onClick={() => { setSelectedEdgeId(edge.id); setRelationNotice(null); }} style={{ display: "block", width: "100%", padding: "7px 6px", border: 0, borderBottom: "1px solid var(--border)", background: selected ? "var(--bg-selected)" : "transparent", color: "var(--text-muted)", textAlign: "left", cursor: edgeMode || edgeSaving ? "not-allowed" : "pointer", fontSize: 11 }}>
                  <strong style={{ color: "var(--text)", overflowWrap: "anywhere" }}>{sourceSession ? sessionTitle(sourceSession) : edge.source.slice(0, 12)}</strong> <span>↔</span> <strong style={{ color: "var(--text)", overflowWrap: "anywhere" }}>{targetSession ? sessionTitle(targetSession) : edge.target.slice(0, 12)}</strong>
                  <span style={{ display: "block", marginTop: 3, color: "var(--text-dim)", fontSize: 10 }}>{t(edge.type === "related" ? "talkMap.related" : "talkMap.lineage")}{endpointState ? ` · ${endpointState}` : ""}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {error && <div role="alert" style={{ padding: "7px 12px", borderBottom: "1px solid rgba(220,38,38,0.25)", background: "rgba(220,38,38,0.08)", color: "#dc2626", fontSize: 11 }}>{error}</div>}
      {ghostComposerOpen && <div role="alertdialog" aria-modal="true" aria-label={t("talkMap.ghostTitle")} onPointerDown={(event) => event.stopPropagation()} style={{ position: "fixed", zIndex: 20, top: 70, left: "50%", transform: "translateX(-50%)", width: "min(420px, calc(100vw - 32px))", padding: 14, border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-panel)", boxShadow: "0 12px 40px rgba(0,0,0,0.2)" }}>
        <strong style={{ display: "block", marginBottom: 10, fontSize: 13 }}>{t("talkMap.ghostTitle")}</strong>
        <label style={{ display: "block", marginBottom: 8, color: "var(--text-muted)", fontSize: 11 }}>{t("talkMap.ghostLabel")}
          <input autoFocus value={ghostLabel} onChange={(event) => setGhostLabel(event.target.value)} style={{ display: "block", width: "100%", boxSizing: "border-box", marginTop: 4, padding: "7px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", fontSize: 12 }} />
        </label>
        <label style={{ display: "block", marginBottom: 12, color: "var(--text-muted)", fontSize: 11 }}>{t("talkMap.ghostBody")}
          <textarea value={ghostBody} onChange={(event) => setGhostBody(event.target.value)} rows={4} style={{ display: "block", width: "100%", boxSizing: "border-box", resize: "vertical", marginTop: 4, padding: "7px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", fontSize: 12, lineHeight: 1.45 }} />
        </label>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={() => { setGhostComposerOpen(false); setGhostLabel(""); setGhostBody(""); }} style={controlStyle()}>{t("talkMap.ghostCancel")}</button>
          <button type="button" onClick={createGhost} disabled={!ghostLabel.trim()} style={controlStyle(!ghostLabel.trim())}>{t("talkMap.ghostCreate")}</button>
        </div>
      </div>}
      <div className="talk-map-workspace">
        {subprojectPanelOpen && (
          <aside id="talk-map-subproject-sidebar" className="talk-map-subproject-sidebar" data-talk-map-subproject-strip role="region" aria-label={t("talkMap.subprojectVisibility")}>
            {ownedSubprojects.length > 0 ? <>
            <div className="talk-map-subproject-sidebar-list">
              {ownedSubprojects.map((subproject) => {
                const automaticallyHidden = autoHiddenSubprojectIds.has(subproject.id);
                const manuallyHidden = Boolean(subproject.hidden);
                const isVisible = !automaticallyHidden && !manuallyHidden;
                const label = automaticallyHidden
                  ? `${t("sessionActivity.autoHideEmptySubprojects")}: ${subproject.label}`
                  : manuallyHidden
                    ? `${t("sessionActivity.showSubproject")}: ${subproject.label}`
                    : `${t("sessionActivity.hideSubproject")}: ${subproject.label}`;
                const isOpened = openedSubprojectId === subproject.id;
                const canOpen = isVisible && !subprojectVisibilityBusy && Boolean(board);
                const openLabel = isOpened
                  ? t("talkMap.showAllSubprojects")
                  : `${t("talkMap.openSubproject")}: ${subproject.label}`;
                return (
                  <div
                    key={subproject.id}
                    data-talk-map-subproject-id={subproject.id}
                    data-talk-map-subproject-opened={isOpened ? "true" : undefined}
                    className="talk-map-subproject-sidebar-item"
                    style={{ opacity: automaticallyHidden ? 0.62 : 1 }}
                  >
                    <button
                      type="button"
                      className="talk-map-subproject-name"
                      data-talk-map-subproject-open
                      disabled={!canOpen}
                      aria-pressed={isOpened}
                      aria-label={openLabel}
                      title={openLabel}
                      onClick={() => openSubproject(subproject.id)}
                    >
                      {subproject.label}
                    </button>
                    <button
                      type="button"
                      data-talk-map-subproject-visibility
                      disabled={!board || subprojectVisibilityBusy || automaticallyHidden}
                      aria-pressed={isVisible}
                      aria-label={label}
                      title={label}
                      onClick={() => { void toggleSubprojectVisibility(subproject).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }}
                      style={{ ...controlStyle(!board || subprojectVisibilityBusy || automaticallyHidden), color: isVisible ? "var(--accent)" : "var(--text-dim)", background: isVisible ? "color-mix(in srgb, var(--accent) 10%, var(--bg-panel))" : "var(--bg-panel)" }}
                    >
                      {isVisible ? <Eye size={14} strokeWidth={1.8} aria-hidden="true" /> : <EyeOff size={14} strokeWidth={1.8} aria-hidden="true" />}
                    </button>
                    {onNewSession && <button
                      type="button"
                      data-talk-map-new-session
                      data-talk-map-subproject-new-session
                      data-talk-map-subproject-id={subproject.id}
                      disabled={!mapProjectKey}
                      aria-label={`${t("sessionActivity.newSession")}: ${subproject.label}`}
                      title={`${t("sessionActivity.newSession")}: ${subproject.label}`}
                      onClick={() => startNewSession(subproject.id, subproject.label)}
                      style={controlStyle(!mapProjectKey)}
                    >
                      <MessageSquarePlus size={14} strokeWidth={1.8} aria-hidden="true" />
                    </button>}
                  </div>
                );
              })}
            </div>
            <div className="talk-map-subproject-sidebar-policy">
              <button
                type="button"
                onClick={() => void toggleAutoHideEmptySubprojects()}
                disabled={!mapProjectKey || subprojectVisibilityBusy}
                title={t("sessionActivity.autoHideEmptySubprojects")}
                aria-label={t("sessionActivity.autoHideEmptySubprojects")}
                aria-pressed={autoHideEmptySubprojects}
                aria-busy={subprojectVisibilityBusy}
                data-talk-map-hide-empty-subprojects
                style={{ ...controlStyle(!mapProjectKey || subprojectVisibilityBusy), width: "100%", height: "auto", minHeight: 34, padding: "7px 9px", display: "inline-flex", alignItems: "center", justifyContent: "center", textAlign: "center", whiteSpace: "normal", gap: 6, color: autoHideEmptySubprojects ? "var(--text-dim)" : "var(--accent)", background: autoHideEmptySubprojects ? "var(--bg-panel)" : "color-mix(in srgb, var(--accent) 10%, var(--bg-panel))", fontWeight: autoHideEmptySubprojects ? 650 : 500 }}
              >
                {autoHideEmptySubprojects ? <EyeOff size={14} strokeWidth={1.8} aria-hidden="true" /> : <Eye size={14} strokeWidth={1.8} aria-hidden="true" />}
                <span>{t("sessionActivity.autoHideEmptySubprojects")}</span>
              </button>
            </div>
            </> : <div data-talk-map-no-subprojects role="status" style={{ padding: "10px 8px", color: "var(--text-dim)", fontSize: 11, lineHeight: 1.45 }}>
              {t("talkMap.noSubprojects")}
            </div>}
          </aside>
        )}
        <div
          className="talk-map-canvas"
          ref={canvasRef}
        onDoubleClick={handleCanvasDoubleClick}
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handleCanvasPointerMove}
        onPointerUp={handleCanvasPointerUp}
        onPointerCancel={handleCanvasPointerUp}
        onWheel={handleWheel}
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          touchAction: "none",
          userSelect: "none",
          cursor: edgeMode ? "crosshair" : panRef.current?.captured ? "grabbing" : "grab",
          backgroundColor: "var(--bg)",
          // 自由画布点阵仅在布局真源就绪后绘制，避免首帧闪出自由画布样式。
          backgroundImage: board ? "radial-gradient(circle, color-mix(in srgb, var(--text-dim) 22%, transparent) 1px, transparent 1px)" : undefined,
          backgroundSize: board ? "24px 24px" : undefined,
        }}
      >
        {!board && <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>{t("talkMap.loading")}</div>}
        {!loading && board && !hasNodes && <div className="talk-map-empty-state" role="status">
          <div>{sessions.length > 0 ? t("talkMap.filteredEmpty") : t("talkMap.empty")}</div>
          {sessions.length > 0 && <button type="button" onClick={showAllSessions} style={{ ...controlStyle(), marginTop: 10 }}>{t("talkMap.showAll")}</button>}
        </div>}
        {board && !isSubprojectView && <div className="talk-map-canvas-controls" role="toolbar" aria-label={t("talkMap.layout")} onPointerDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            onClick={() => fitView()}
            disabled={!board}
            data-talk-map-fit
            title={t("talkMap.fit")}
            aria-label={t("talkMap.fit")}
            style={{ ...controlStyle(!board), padding: "0 8px", width: "auto", display: "inline-flex", alignItems: "center", gap: 5 }}
          >
            <Maximize2 size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>{t("talkMap.fit")}</span>
          </button>
          <button
            type="button"
            onClick={() => { if (typeof window === "undefined" || window.confirm(t("talkMap.resetConfirm"))) resetView(); }}
            disabled={!board}
            data-talk-map-reset
            title={t("talkMap.reset")}
            aria-label={t("talkMap.reset")}
            style={{ ...controlStyle(!board), padding: "0 8px", width: "auto", display: "inline-flex", alignItems: "center", gap: 5 }}
          >
            <RotateCcw size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>{t("talkMap.reset")}</span>
          </button>
          <div style={{ width: 1, height: 16, background: "var(--border)", margin: "0 2px" }} />
          <button type="button" onClick={() => zoomBy(0.85)} disabled={!board} style={controlStyle(!board)} title={t("talkMap.zoomOut")} aria-label={t("talkMap.zoomOut")}>
            <ZoomOut size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <span data-talk-map-zoom style={{ minWidth: 42, textAlign: "center", color: "var(--text-muted)", fontSize: 11 }}>{`${Math.round(board.camera.zoom * 100)}%`}</span>
          <button type="button" onClick={() => zoomBy(1.15)} disabled={!board} style={controlStyle(!board)} title={t("talkMap.zoomIn")} aria-label={t("talkMap.zoomIn")}>
            <ZoomIn size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>}
        {board && hasNodes && (
          isSubprojectView ? (
            <div
              ref={subprojectStageRef}
              className="talk-map-subproject-stage"
              data-talk-map-subproject-stage
              onScroll={handleSubprojectStageScroll}
              onPointerDown={handleSubprojectStagePointerDown}
              onPointerMove={handleSubprojectStagePointerMove}
              onPointerUp={handleSubprojectStagePointerUp}
              onPointerCancel={handleSubprojectStagePointerUp}
              onWheel={handleSubprojectStageWheel}
              style={{ position: "absolute", inset: 0, overflowX: "auto", overflowY: "hidden", minWidth: 0, minHeight: 0, touchAction: "pan-x", overscrollBehaviorX: "contain", overscrollBehaviorY: "none", cursor: "grab" }}
            >
              <div
                style={{
                  position: "relative",
                  width: subprojectLayout.bounds ? subprojectLayout.bounds.x + subprojectLayout.bounds.width + TALK_MAP_SUBPROJECT_STAGE_PADDING : "100%",
                  height: subprojectLayout.bounds ? subprojectLayout.bounds.y + subprojectLayout.bounds.height + TALK_MAP_SUBPROJECT_VERTICAL_PADDING : "100%",
                  minWidth: "100%",
                  minHeight: "100%",
                }}
              >
                {renderRelationEdges()}
                {subprojectLayout.modules.map((module) => (
                  <div
                    key={module.id}
                    ref={(element) => { subprojectPanelRefs.current[module.id] = element; }}
                    data-talk-map-subproject-frame
                    data-talk-map-subproject-id={module.id}
                    style={{ position: "absolute", left: module.x, top: module.y, width: module.width, height: module.height, boxSizing: "border-box", display: "flex", flexDirection: "column", overflow: "hidden", border: "1px dashed color-mix(in srgb, #8b5cf6 55%, var(--border))", borderRadius: 14, background: "color-mix(in srgb, #8b5cf6 4%, transparent)", boxShadow: subprojectDragOverId === module.id ? "0 0 0 3px rgba(124,58,237,0.2)" : "none", pointerEvents: "auto", zIndex: 1 }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, width: "calc(100% + 1px)", boxSizing: "border-box", margin: "-1px 0 0 -1px", padding: "5px 9px", border: "1px dashed color-mix(in srgb, #8b5cf6 55%, var(--border))", borderTopLeftRadius: 12, borderBottomRightRadius: 8, background: "var(--bg-panel)", color: "#7c3aed", fontSize: 13, fontWeight: 700, lineHeight: 1.2, flexShrink: 0 }}>
                      {module.id !== UNCLASSIFIED_SUBPROJECT_ID && canReorderSubprojects && <span
                        data-talk-map-subproject-reorder-handle
                        onPointerDown={(event) => handleSubprojectPointerDown(event, module.id)}
                        onPointerMove={handleSubprojectPointerMove}
                        onPointerUp={handleSubprojectPointerUp}
                        onPointerCancel={handleSubprojectPointerCancel}
                        title={t("sessionActivity.dragSubprojectOrder")}
                        aria-label={t("sessionActivity.dragSubprojectOrder")}
                        style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, margin: "-2px 0 -2px -4px", color: "var(--text-dim)", cursor: "grab", pointerEvents: "auto", touchAction: "none", userSelect: "none", fontSize: 12, letterSpacing: -2 }}
                      >⋮⋮</span>}
                      <strong>{module.label}</strong>
                      <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{module.sessionIds.length}</span>
                      {onNewSession && module.id !== UNCLASSIFIED_SUBPROJECT_ID && <button
                        type="button"
                        data-talk-map-new-session
                        data-talk-map-subproject-new-session
                        data-talk-map-subproject-id={module.id}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          const subprojectId = module.id === UNCLASSIFIED_SUBPROJECT_ID ? undefined : module.id;
                          startNewSession(subprojectId, subprojectId ? module.label : undefined);
                        }}
                        title={`${t("sessionActivity.newSession")}: ${module.label}`}
                        aria-label={`${t("sessionActivity.newSession")}: ${module.label}`}
                        style={{ ...controlStyle(), width: 24, height: 24, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", marginLeft: "auto", pointerEvents: "auto" }}
                      >
                        <MessageSquarePlus size={14} strokeWidth={1.8} aria-hidden="true" />
                      </button>}
                    </div>
                    <div
                      ref={(element) => { subprojectScrollRefs.current[module.id] = element; }}
                      className="talk-map-subproject-scroll"
                      data-talk-map-subproject-scroll
                      onScroll={(event) => handleSubprojectScroll(module.id, event)}
                      style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", overscrollBehavior: "contain" }}
                    >
                      <div style={{ position: "relative", width: "100%", height: Math.max(1, module.contentHeight), minHeight: "100%" }}>
                        {module.sessionIds.map((sessionId) => {
                          const session = visibleSessionById.get(sessionId);
                          return session ? renderSessionCard(session, module) : null;
                        })}
                      </div>
                    </div>
                  </div>
                ))}
                {draggingSubprojectSession ? renderSessionCard(draggingSubprojectSession, undefined, true) : null}
                {renderGhostCards()}
              </div>
            </div>
          ) : (
            <div style={{ position: "absolute", left: 0, top: 0, width: 0, height: 0, transform: `translate(${board.camera.x}px, ${board.camera.y}px) scale(${board.camera.zoom})`, transformOrigin: "0 0" }}>
              {worktreeFrames.map((frame) => (
                <div
                  key={frame.id}
                  data-talk-map-frame
                  style={{ position: "absolute", left: frame.x, top: frame.y, width: frame.width, height: frame.height, boxSizing: "border-box", border: "1px dashed color-mix(in srgb, var(--accent) 55%, var(--border))", borderRadius: 14, background: "color-mix(in srgb, var(--accent) 5%, transparent)", pointerEvents: "none", zIndex: 0 }}
                >
                  <div
                    data-talk-map-frame-header
                    onPointerDown={(event) => handleFramePointerDown(event, frame)}
                    onPointerMove={handleFramePointerMove}
                    onPointerUp={handleFramePointerUp}
                    onPointerCancel={handleFramePointerUp}
                    style={{ display: "inline-flex", alignItems: "center", gap: 5, margin: "-1px 0 0 -1px", padding: "4px 8px", border: "1px dashed color-mix(in srgb, var(--accent) 55%, var(--border))", borderTopLeftRadius: 12, borderBottomRightRadius: 8, background: "var(--bg-panel)", color: "var(--accent)", fontSize: 10, cursor: edgeMode ? "crosshair" : mapLocked ? "grab" : "move", pointerEvents: "auto", userSelect: "none" }}
                  >
                    <span>{t("talkMap.worktreeFrame")}</span>
                    <strong>{frame.label}</strong>
                  </div>
                </div>
              ))}
              {renderRelationEdges()}
              {visibleSessions.map((session) => renderSessionCard(session))}
              {renderGhostCards()}
            </div>
          )
        )}
      </div>
      </div>
    </div>
  );
}
