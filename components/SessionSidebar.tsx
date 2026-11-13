"use client";
import { WorktreeSessionBuckets, type WorktreeVirtualTreeNode } from "./WorktreeSessionBuckets";
import { flattenBucketedSessionRows, flattenSessionTreeRows, getPinnedInteractionIds, getVirtualRowWindow, SESSION_ROW_HEIGHT, type SessionSidebarRow } from "./session-sidebar-virtual";

import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { Check, ChevronRight, Eye, MessageSquarePlus, X } from "lucide-react";
import { sessionSearchResultMatchesFilter, sessionSearchResultSources, type SessionInfo, type SessionSearchMatchFilter, type SessionSearchResult } from "@/lib/types";
import type { SubprojectDefinition, SubprojectSortSetting } from "@/lib/subproject-state";
import { filterSubprojectItems, groupBySubproject, orderedSubprojectIds, projectKeysMatch, reorderSubprojectIds } from "@/lib/subproject-groups";
import { mergeProjectList, mergeSelectedSession, shouldApplySessionListResponse } from "@/lib/session-list-state";
import { assertSessionMutationOk } from "@/lib/session-mutation";
import { clearSessionActivityCache, fetchSessionActivity } from "@/lib/session-activity-fetch";
import { loadExplorerOpen } from "@/lib/file-explorer-state";
import { dispatchSessionRowContextMenu } from "@/lib/session-row-context-menu";
import { sessionDisplayTitle } from "@/lib/session-display";
import { useI18n } from "@/hooks/useI18n";
import { useScrollbarVisibility } from "@/hooks/useScrollbarVisibility";
import { isWithinActivityTimeRange } from "@/lib/session-activity-filters";
import { SessionSearchMatchFilterSelect, SubprojectContextMenu, useSharedActivityFilters } from "./SessionActivityPanel";
import { SessionHoverPreview, useSessionHover } from "./SessionHoverPreview";
import { SessionListMeta } from "./SessionListMeta";
import { DirectoryPicker } from "./DirectoryPicker";
import { ExplorerSection } from "./ExplorerSection";
import { SessionSearchInput } from "./SessionSearchInput";
import { SubagentVisibilityMenu } from "./SubagentVisibilityMenu";
import { useSubagentVisibility, setSubagentVisibility } from "@/hooks/useSubagentVisibility";
import { SessionSubprojectMenu } from "./SessionSubprojectMenu";
import { isSubprojectReorderDragBlocked, useSessionSubprojectPointerDrag } from "@/lib/session-subproject-pointer-dnd";
import { lineageParentId } from "@/lib/session-lineage";
export { ToolbarIconButton } from "./ToolbarIconButton";

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

interface Props {
  selectedSessionId: string | null;
  selectedSession?: SessionInfo | null;
  /** Talk Map selection highlight; does not change active chat session. */
  highlightedSessionId?: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean, searchTerm?: string) => void;
  onNewSession?: (sessionId: string, cwd: string, subprojectId?: string, subprojectLabel?: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (cwd: string | null, projectRoot?: string | null) => void;
  onOpenFile?: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff"; reuseActiveTab?: boolean }) => void;
  onPathRenamed?: (oldPath: string, newPath: string, isDir: boolean, peer?: string) => void;
  activeFilePath?: string | null;
  filePanelOpen?: boolean;
  explorerRefreshKey?: number;
  onExplorerRefresh?: () => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  /** Hide agent chrome; focus file explorer (reader mode). */
  readerMode?: boolean;
  /** AppShell-controlled sibling session visibility. */
  controlledSessionsOpen?: boolean;
  onSessionsOpenChange?: (open: boolean) => void;
  /** AppShell-controlled Explorer visibility. */
  controlledExplorerOpen?: boolean;
  /** Optional control occupying the first cell of the Explorer toolbar. */
  explorerLeadingControl?: ReactNode;
  reservedLeadingControl?: ReactNode;
  folderControl?: ReactNode;
  onExplorerOpenChange?: (open: boolean) => void;
  /** Keep explicit AppShell mainline file/terminal context across session clicks. */
  preserveExplorerContextOnSessionSelect?: boolean;
  /** Actual AppShell reader-mode signal used for Explorer transition sync. */
  readerModeTransition?: boolean;
  /** Compact target sidebar keeps directory collapsed like the outer activity sidebar. */
  compactReaderMode?: boolean;
  /** Fired when sessions that are not currently selected finish running. */
  onBackgroundTaskDone?: (sessionIds: string[]) => void;
  runningSessionIds: Set<string>;
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

interface WorktreeState {
  /** The cwd this data was fetched for — guards against stale responses */
  forCwd: string;
  projectRoot: string;
  isGit: boolean;
  /** False when forCwd is a repo subdirectory — the switcher is hidden there
   *  because subdir sessions keep their own project identity */
  isTopLevel: boolean;
  /** Canonical path of the checkout containing forCwd, resolved server-side. */
  currentWorktreePath: string | null;
  worktrees: WorktreeEntry[];
}

interface ValidatedProject {
  cwd: string;
  root: string;
  key: string;
}

const LAST_CUSTOM_CWD_STORAGE_KEY = "pi-web:last-custom-cwd";

function loadLastCustomCwd(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(LAST_CUSTOM_CWD_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveLastCustomCwd(cwd: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_CUSTOM_CWD_STORAGE_KEY, cwd);
  } catch {
    // Persistence is best-effort.
  }
}

const UNREAD_SESSIONS_STORAGE_KEY = "pi-web:unread-session-ids";
function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

function watchUnreadSessionIds(onChange: (ids: Set<string>) => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== UNREAD_SESSIONS_STORAGE_KEY) return;
    try {
      if (event.storageArea !== window.localStorage) return;
    } catch {
      return;
    }
    onChange(loadUnreadSessionIds());
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

/**
 * Return all projects (deduped by projectRoot so worktrees collapse into their
 * main repo) sorted by most recent session activity.
 */
function getRecentProjects(sessions: SessionInfo[]): string[] {
  const latestByRoot = new Map<string, string>(); // projectRoot -> most recent modified
  for (const s of sessions) {
    const root = s.projectRoot ?? s.cwd;
    if (!root) continue;
    const prev = latestByRoot.get(root);
    if (!prev || s.modified > prev) {
      latestByRoot.set(root, s.modified);
    }
  }
  return [...latestByRoot.entries()]
    .sort((a, b) => b[1].localeCompare(a[1]))
    .map(([root]) => root);
}

/** Substitute the home dir prefix with ~ (no path truncation — see PathLabel) */
function displayCwd(cwd: string, homeDir?: string): string {
  return (homeDir && cwd.startsWith(homeDir)) ? "~" + cwd.slice(homeDir.length) : cwd;
}

/**
 * Path label that ellipsizes on the LEFT, keeping the (most relevant) trailing
 * segments visible: "…orkspace/pi-web". Shows as much of the path as fits
 * instead of a fixed number of segments. The rtl container moves the ellipsis
 * to the left edge; the inner plaintext bidi isolation keeps the path itself
 * rendered strictly left-to-right (no punctuation reordering).
 */
function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        minWidth: 0,
        lineHeight: 1.35,
        direction: "rtl",
        textAlign: "left",
        ...style,
      }}
    >
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}

const DROPDOWN_ANIMATION_MS = 140;

function AnimatedDropdown({ open, children, style }: { open: boolean; children: ReactNode; style: CSSProperties }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    let frame: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (open) {
      setMounted(true);
      setVisible(false);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      timeout = setTimeout(() => setMounted(false), DROPDOWN_ANIMATION_MS);
    }

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (timeout) clearTimeout(timeout);
    };
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      style={{
        ...style,
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0) scale(1)" : "translateY(-8px) scale(0.96)",
        transformOrigin: "top center",
        transition: `opacity ${DROPDOWN_ANIMATION_MS}ms ease, transform ${DROPDOWN_ANIMATION_MS}ms ease`,
        pointerEvents: open ? "auto" : "none",
      }}
    >
      {children}
    </div>
  );
}



interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const s of sessions) {
    byId.set(s.id, { session: s, children: [] });
  }

  // Build a map of fork/context-source chains so filtered ancestors can be resolved.
  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    const parentId = lineageParentId(s);
    if (parentId) parentOf.set(s.id, parentId);
  }

  // Walk up the relationship chain to find the nearest ancestor that exists in byId
  function resolveAncestor(id: string): string | null {
    let cur = parentOf.get(id);
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) return null; // cycle guard
      visited.add(cur);
      if (byId.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return null;
  }

  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id);
    if (ancestor) {
      byId.get(ancestor)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort each level by modified desc
  const sort = (nodes: SessionTreeNode[]) => {
    nodes.sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

function MeasuredVirtualRow({
  rowId,
  top,
  height,
  onMeasure,
  children,
}: {
  rowId: string;
  top: number;
  height: number;
  onMeasure?: (rowId: string, height: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !onMeasure) return;
    const measure = () => {
      const next = Math.ceil(element.getBoundingClientRect().height);
      if (next > 0) onMeasure(rowId, next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [height, onMeasure, rowId]);
  return (
    <div ref={ref} data-virtual-row-id={rowId} style={{ position: "absolute", top, left: 0, right: 0, minHeight: height }}>
      {children}
    </div>
  );
}

function VirtualizedRows<T, B>({
  rows,
  scrollTop,
  viewportHeight,
  overscanRows = 4,
  pinnedIds,
  onMeasure,
  renderRow,
}: {
  rows: SessionSidebarRow<T, B>[];
  scrollTop: number;
  viewportHeight: number;
  overscanRows?: number;
  pinnedIds?: ReadonlySet<string>;
  onMeasure?: (rowId: string, height: number) => void;
  renderRow: (row: SessionSidebarRow<T, B>, index: number) => ReactNode;
}) {
  const window = getVirtualRowWindow(rows, scrollTop, viewportHeight, overscanRows, pinnedIds);
  return (
    <div data-virtual-row-window="true" style={{ position: "relative", height: window.totalHeight }}>
      {window.indices.map((index) => {
        const row = rows[index];
        return (
          <MeasuredVirtualRow key={row.id} rowId={row.id} top={window.offsets[index]} height={row.height} onMeasure={onMeasure}>
            {renderRow(row, index)}
          </MeasuredVirtualRow>
        );
      })}
    </div>
  );
}

const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";

function useScramble(target: string, running: boolean): string {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number | null>(null);
  const iterRef = useRef(0);

  useEffect(() => {
    if (!running) {
      setDisplay(target);
      return;
    }
    iterRef.current = 0;
    const totalFrames = target.length * 4;

    const step = () => {
      iterRef.current += 1;
      const progress = iterRef.current / totalFrames;
      const resolved = Math.floor(progress * target.length);

      setDisplay(
        target
          .split("")
          .map((char, i) => {
            if (char === " ") return " ";
            if (i < resolved) return char;
            return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
          })
          .join("")
      );

      if (iterRef.current < totalFrames) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        setDisplay(target);
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [target, running]);

  return display;
}

export function PiWebTitle() {
  const [showVersion, setShowVersion] = useState(false);
  const [scrambling, setScrambling] = useState(false);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const target = showVersion ? `${process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}p${process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}` : "Pi Web";
  const display = useScramble(target, scrambling);

  const triggerScramble = useCallback((toVersion: boolean) => {
    setShowVersion(toVersion);
    setScrambling(true);
    setTimeout(() => setScrambling(false), (toVersion ? 6 : 8) * 4 * (1000 / 60) + 100);
  }, []);

  const handleClick = useCallback(() => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);

    const next = !showVersion;
    triggerScramble(next);

    if (next) {
      revertTimerRef.current = setTimeout(() => triggerScramble(false), 3000);
    }
  }, [showVersion, triggerScramble]);

  useEffect(() => () => { if (revertTimerRef.current) clearTimeout(revertTimerRef.current); }, []);

  return (
    <button
      onClick={handleClick}
      style={{
        background: "none", border: "none", padding: 0, cursor: "pointer",
        fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em",
        color: showVersion ? "var(--accent)" : "var(--text)",
        fontFamily: "var(--font-mono)",
        minWidth: "6ch",
      }}
    >
      {display}
    </button>
  );
}

export function SessionSidebar({ selectedSessionId, selectedSession: selectedSessionInfo, highlightedSessionId, onSelectSession, onNewSession, skipInitialProjectSelection, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onOpenFile, onPathRenamed, activeFilePath, filePanelOpen = false, explorerRefreshKey, onExplorerRefresh, onAtMention, onAtMentions, onBackgroundTaskDone, runningSessionIds, readerMode = false, readerModeTransition = readerMode, preserveExplorerContextOnSessionSelect = false, compactReaderMode = false, controlledSessionsOpen, onSessionsOpenChange, controlledExplorerOpen, onExplorerOpenChange, explorerLeadingControl, reservedLeadingControl, folderControl }: Props) {
  const { t } = useI18n();
  const [sharedFilters] = useSharedActivityFilters();
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [activityTimes, setActivityTimes] = useState<Record<string, string>>({});
  const [activityRunningSessionIds, setActivityRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [sessionModelNames, setSessionModelNames] = useState<Record<string, string>>({});
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [sessionListSnapshotView, setSessionListSnapshotView] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string>("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState("");
  const [wtFilter, setWtFilter] = useState("");
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState(loadLastCustomCwd);
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  // Official v0.8.9 #490: identity resolved by /api/cwd/validate before the
  // cwd becomes active. Reader keeps its projectRootFor display hierarchy;
  // this state is the server-validated identity for future grouping use.
  const [validatedProject, setValidatedProject] = useState<ValidatedProject | null>(null);
  const [knownProjects, setKnownProjects] = useState<Array<{ path: string; addedAt: string }>>([]);
  const [subprojects, setSubprojects] = useState<SubprojectDefinition[]>([]);
  const [subprojectSortSettings, setSubprojectSortSettings] = useState<SubprojectSortSetting[]>([]);
  const [collapsedSubprojectBuckets, setCollapsedSubprojectBuckets] = useState<string[]>([]);
  const [collapsedSessionIds, setCollapsedSessionIds] = useState<Set<string>>(() => new Set());
  const [subagentContextMenu, setSubagentContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const visibleSubagentParentIds = useSubagentVisibility();
  const [subprojectDeleteConfirmId, setSubprojectDeleteConfirmId] = useState<string | null>(null);
  const [subprojectDeleteBusyId, setSubprojectDeleteBusyId] = useState<string | null>(null);
  const [subprojectDeleteError, setSubprojectDeleteError] = useState<string | null>(null);
  const [subprojectRenameId, setSubprojectRenameId] = useState<string | null>(null);
  const [subprojectRenameLabel, setSubprojectRenameLabel] = useState("");
  const [subprojectRenameBusyId, setSubprojectRenameBusyId] = useState<string | null>(null);
  const [subprojectRenameError, setSubprojectRenameError] = useState<string | null>(null);
  const [subprojectVisibilityBusyId, setSubprojectVisibilityBusyId] = useState<string | null>(null);
  const [subprojectVisibilityError, setSubprojectVisibilityError] = useState<{ id: string; message: string } | null>(null);
  const [subprojectReorderOverId, setSubprojectReorderOverId] = useState<string | null>(null);
  const [subprojectReorderBusy, setSubprojectReorderBusy] = useState(false);
  const [subprojectReorderError, setSubprojectReorderError] = useState<string | null>(null);
  const [projectDeleteConfirm, setProjectDeleteConfirm] = useState<string | null>(null);
  const [projectDeleteBusy, setProjectDeleteBusy] = useState(false);
  const [projectDeleteError, setProjectDeleteError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Worktree switcher state
  const [worktreeState, setWorktreeState] = useState<WorktreeState | null>(null);
  const [wtDropdownOpen, setWtDropdownOpen] = useState(false);
  const [wtNewOpen, setWtNewOpen] = useState(false);
  const [wtNewName, setWtNewName] = useState("");
  const [wtError, setWtError] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [worktreeLoadingCwd, setWorktreeLoadingCwd] = useState<string | null>(null);
  const wtDropdownRef = useRef<HTMLDivElement>(null);
  const wtNewInputRef = useRef<HTMLInputElement>(null);
  const [internalSessionsOpen, setInternalSessionsOpen] = useState(true);
  const sessionsOpen = controlledSessionsOpen ?? internalSessionsOpen;
  const setSessionsOpen = useCallback((value: boolean | ((previous: boolean) => boolean)) => {
    if (controlledSessionsOpen === undefined) {
      setInternalSessionsOpen((previous) => {
        const next = typeof value === "function" ? value(previous) : value;
        onSessionsOpenChange?.(next);
        return next;
      });
      return;
    }
    onSessionsOpenChange?.(typeof value === "function" ? value(controlledSessionsOpen) : value);
  }, [controlledSessionsOpen, onSessionsOpenChange]);
  const [showArchived, setShowArchived] = useState(false);
  const [groupByWorktree, setGroupByWorktree] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SessionSearchResult[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchMatchFilter, setSearchMatchFilter] = useState<SessionSearchMatchFilter>("all");
  const [searchNonce, setSearchNonce] = useState(0);
  const searchSeqRef = useRef(0);
  const [internalExplorerOpen, setInternalExplorerOpen] = useState(
    readerModeTransition || !compactReaderMode,
  );
  const explorerOpen = controlledExplorerOpen ?? internalExplorerOpen;
  const setExplorerOpen = useCallback((value: boolean | ((previous: boolean) => boolean)) => {
    if (controlledExplorerOpen === undefined) {
      setInternalExplorerOpen((previous) => {
        const next = typeof value === "function" ? value(previous) : value;
        onExplorerOpenChange?.(next);
        return next;
      });
      return;
    }
    onExplorerOpenChange?.(typeof value === "function" ? value(controlledExplorerOpen) : value);
  }, [controlledExplorerOpen, onExplorerOpenChange]);
  const explorerPreferenceHydratedRef = useRef(false);
  const sessionListRef = useRef<HTMLDivElement>(null);
  const virtualContentRef = useRef<HTMLDivElement>(null);
  const [virtualViewport, setVirtualViewport] = useState({ scrollTop: 0, viewportHeight: 0 });
  const [virtualOrigin, setVirtualOrigin] = useState(0);
  const [virtualRowHeights, setVirtualRowHeights] = useState<Record<string, number>>({});
  const [activeVirtualRowIds, setActiveVirtualRowIds] = useState<string[]>([]);
  const updateVirtualViewport = useCallback(() => {
    const root = sessionListRef.current;
    const content = virtualContentRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const contentRect = content?.getBoundingClientRect();
    setVirtualViewport({ scrollTop: root.scrollTop, viewportHeight: root.clientHeight });
    setVirtualOrigin(contentRect ? contentRect.top - rootRect.top + root.scrollTop : 0);
  }, []);
  useLayoutEffect(() => {
    const root = sessionListRef.current;
    if (!root) return;
    updateVirtualViewport();
    root.addEventListener("scroll", updateVirtualViewport, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateVirtualViewport);
    observer?.observe(root);
    if (virtualContentRef.current) observer?.observe(virtualContentRef.current);
    return () => {
      root.removeEventListener("scroll", updateVirtualViewport);
      observer?.disconnect();
    };
  }, [updateVirtualViewport, sessionsOpen, searchQuery, groupByWorktree, selectedCwd]);
  const markVirtualInteraction = useCallback((id: string, active: boolean) => {
    if (!id) return;
    setActiveVirtualRowIds((current) => {
      const next = current.filter((value) => value !== id);
      if (active) next.push(id);
      return next.slice(-8);
    });
  }, []);
  const updateVirtualRowHeight = useCallback((id: string, height: number) => {
    setVirtualRowHeights((current) => {
      if (Math.abs((current[id] ?? 0) - height) < 1) return current;
      return { ...current, [id]: height };
    });
  }, []);
  useScrollbarVisibility(sessionListRef, sessionsOpen);

  useEffect(() => {
    const handleFocusSearch = () => {
      setExplorerOpen(true);
    };
    window.addEventListener("reader:focus-file-search", handleFocusSearch);
    return () => window.removeEventListener("reader:focus-file-search", handleFocusSearch);
  }, [setExplorerOpen]);

  useEffect(() => {
    if (readerMode) {
      setDropdownOpen(false);
      setWtDropdownOpen(false);
    }
  }, [readerMode]);

  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const externalUnreadUpdateRef = useRef<Set<string> | null>(null);
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  const sessionLoadRequestRef = useRef(0);
  const activityLoadRequestRef = useRef(0);
  const sessionLoadInFlightRef = useRef<{ view: boolean; promise: Promise<void> } | null>(null);
  const activityLoadInFlightRef = useRef<{ view: boolean; promise: Promise<void> } | null>(null);
  const currentArchiveViewRef = useRef(showArchived);
  currentArchiveViewRef.current = showArchived;
  const effectiveRunningSessionIds = useMemo(() => {
    if (activityRunningSessionIds.size === 0) return runningSessionIds;
    return new Set([...runningSessionIds, ...activityRunningSessionIds]);
  }, [activityRunningSessionIds, runningSessionIds]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const loadSessionActivityTimes = useCallback(async (force = false) => {
    if (currentArchiveViewRef.current !== showArchived) return;
    const previous = activityLoadInFlightRef.current;
    if (previous?.view === showArchived && !force) return previous.promise;
    const requestId = ++activityLoadRequestRef.current;
    const request = (async () => {
      if (previous?.view === showArchived) await previous.promise;
      if (currentArchiveViewRef.current !== showArchived) return;
      try {
        const activityUrl = `/api/session-runs?scope=local${showArchived ? "&archived=1" : ""}`;
        const body = await fetchSessionActivity<{ sessions?: Array<{ session?: { id?: string }; lastActivityAt?: string; modelName?: string; status?: string; execution?: { active?: boolean } }> }>(activityUrl, { force: true });
        if (requestId !== activityLoadRequestRef.current || currentArchiveViewRef.current !== showArchived) return;
        const next: Record<string, string> = {};
        const nextModels: Record<string, string> = {};
        const nextRunning = new Set<string>();
        for (const item of body.sessions ?? []) {
          const id = item.session?.id;
          if (typeof id !== "string") continue;
          if (typeof item.lastActivityAt === "string") next[id] = item.lastActivityAt;
          if (typeof item.modelName === "string" && item.modelName.trim()) nextModels[id] = item.modelName.trim();
          if (item.execution?.active || item.status === "running" || item.status === "retrying" || item.status === "waiting_user") nextRunning.add(id);
        }
        if (requestId !== activityLoadRequestRef.current || currentArchiveViewRef.current !== showArchived) return;
        setActivityTimes(next);
        setActivityRunningSessionIds(nextRunning);
        setSessionModelNames(nextModels);
      } catch {
        // Session modified timestamps remain the local fallback.
      }
    })();
    activityLoadInFlightRef.current = { view: showArchived, promise: request };
    try { await request; } finally {
      if (activityLoadInFlightRef.current?.promise === request) activityLoadInFlightRef.current = null;
    }
  }, [showArchived]);

  const loadSessions = useCallback(async (showLoading = false, force = false) => {
    if (currentArchiveViewRef.current !== showArchived) return;
    const previous = sessionLoadInFlightRef.current;
    if (previous?.view === showArchived && !force) return previous.promise;
    const requestId = ++sessionLoadRequestRef.current;
    const request = (async () => {
      if (previous?.view === showArchived) await previous.promise;
      if (currentArchiveViewRef.current !== showArchived) return;
      try {
        if (showLoading) setLoading(true);
        const res = await fetch(showArchived ? `/api/sessions?archived=1${force ? "&force=1" : ""}` : force ? "/api/sessions?force=1" : "/api/sessions", {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { sessions: SessionInfo[] };
        if (!shouldApplySessionListResponse(requestId, sessionLoadRequestRef.current) || currentArchiveViewRef.current !== showArchived) return;
        setAllSessions(data.sessions);
        setSessionListSnapshotView(showArchived);
        setError(null);
        void loadSessionActivityTimes(force);
      } catch (e) {
        if (shouldApplySessionListResponse(requestId, sessionLoadRequestRef.current) && currentArchiveViewRef.current === showArchived) setError(String(e));
      } finally {
        if (shouldApplySessionListResponse(requestId, sessionLoadRequestRef.current) && currentArchiveViewRef.current === showArchived) setLoading(false);
      }
    })();
    sessionLoadInFlightRef.current = { view: showArchived, promise: request };
    try { await request; } finally {
      if (sessionLoadInFlightRef.current?.promise === request) sessionLoadInFlightRef.current = null;
    }
  }, [loadSessionActivityTimes, showArchived]);

  useEffect(() => {
    setAllSessions((current) => {
      let changed = false;
      const next = current.map((session) => {
        const modelName = sessionModelNames[session.id];
        if (session.modelName === modelName) return session;
        changed = true;
        if (modelName) return { ...session, modelName };
        const withoutModel = { ...session };
        delete withoutModel.modelName;
        return withoutModel;
      });
      return changed ? next : current;
    });
  }, [sessionModelNames]);

  useEffect(() => {
    const refreshActivityWhenVisible = () => {
      if (document.visibilityState === "visible") void loadSessionActivityTimes(true);
    };
    const id = window.setInterval(refreshActivityWhenVisible, 5_000);
    document.addEventListener("visibilitychange", refreshActivityWhenVisible);
    window.addEventListener("focus", refreshActivityWhenVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", refreshActivityWhenVisible);
      window.removeEventListener("focus", refreshActivityWhenVisible);
    };
  }, [loadSessionActivityTimes]);

  const initialLoadDone = useRef(false);
  const previousShowArchivedRef = useRef(showArchived);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    const viewChanged = previousShowArchivedRef.current !== showArchived;
    initialLoadDone.current = true;
    previousShowArchivedRef.current = showArchived;
    // Active/Archived is a dataset switch, not a freshness request. Reuse the
    // server list cache here; explicit refreshes and mutations still force it.
    loadSessions(isFirst || viewChanged, !isFirst && !viewChanged);
  }, [loadSessions, refreshKey, showArchived]);

  // Browser storage is unavailable during server rendering. Restore the panel
  // preference after hydration so a collapsed explorer stays collapsed on reload.
  useEffect(() => {
    if (controlledExplorerOpen !== undefined) return;
    if (explorerPreferenceHydratedRef.current) return;
    explorerPreferenceHydratedRef.current = true;
    if (!readerMode) setExplorerOpen(loadExplorerOpen());
  }, [controlledExplorerOpen, readerMode, setExplorerOpen]);

  useEffect(() => watchUnreadSessionIds((next) => {
    externalUnreadUpdateRef.current = next;
    setUnreadSessionIds((previous) => previous.size === next.size && [...previous].every((id) => next.has(id)) ? previous : next);
  }), []);

  // Updates received from another tab already exist in storage; do not echo them.
  useEffect(() => {
    if (externalUnreadUpdateRef.current === unreadSessionIds) {
      externalUnreadUpdateRef.current = null;
      return;
    }
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

  const handleSessionDeleted = useCallback((id: string) => {
    setUnreadSessionIds((previous) => {
      if (!previous.has(id)) return previous;
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
    onSessionDeleted?.(id);
  }, [onSessionDeleted]);

  // Debounced on-demand session-content search. No index is maintained; the
  // server scans session jsonl files only while a query is active, so the
  // running service carries no background cost.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      searchSeqRef.current += 1;
      setSearchResults(null);
      setSearchLoading(false);
      setError(null);
      return;
    }
    if (q.length < 2) {
      searchSeqRef.current += 1;
      setSearchResults(null);
      setSearchLoading(false);
      setError(null);
      return;
    }
    const seq = ++searchSeqRef.current;
    const controller = new AbortController();
    setSearchLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      void fetch(
        `/api/sessions/search?q=${encodeURIComponent(q)}&archived=${showArchived ? "1" : "0"}&days=${encodeURIComponent(sharedFilters.days)}`,
        { signal: controller.signal },
      )
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
          setError(err?.message || t("sidebar.searchFailed"));
          setSearchResults([]);
          setSearchLoading(false);
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchQuery, sharedFilters.days, showArchived, searchNonce, t]);

  const visibleSearchResults = useMemo(
    () => (searchResults ?? []).filter((hit) => sessionSearchResultMatchesFilter(hit, searchMatchFilter)),
    [searchMatchFilter, searchResults],
  );

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter((id) => !effectiveRunningSessionIds.has(id) && id !== selectedSessionId);
    const newlyRunning = [...effectiveRunningSessionIds].filter((id) => !previous.has(id));

    if (completedInBackground.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        effectiveRunningSessionIds.forEach((id) => next.delete(id));
        completedInBackground.forEach((id) => next.add(id));
        return next;
      });
    }
    const hasUnlistedRunningSession = newlyRunning.some(
      (id) => !allSessions.some((session) => session.id === id),
    );
    if (completedInBackground.length > 0 || hasUnlistedRunningSession) {
      loadSessions(false, true);
    }
    if (completedInBackground.length > 0) {
      onBackgroundTaskDone?.(completedInBackground);
    }

    previousRunningSessionIdsRef.current = effectiveRunningSessionIds;
  }, [effectiveRunningSessionIds, selectedSessionId, allSessions, loadSessions, onBackgroundTaskDone]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch(() => {});
  }, []);

  const loadKnownProjects = useCallback(async () => {
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json() as { projects?: Array<{ path: string; addedAt: string }> };
      if (Array.isArray(data.projects)) setKnownProjects(data.projects);
    } catch {
      // Keep the current list when project storage is temporarily unavailable.
    }
  }, []);
  useEffect(() => {
    void loadKnownProjects();
  }, [loadKnownProjects]);
  useEffect(() => {
    const handleKnownProjectsChanged = (event: Event) => {
      void loadKnownProjects();
      const path = (event as CustomEvent<{ path?: unknown }>).detail?.path;
      if (typeof path !== "string" || selectedCwd !== path) return;
      if (!allSessions.some((session) => (session.projectRoot ?? session.cwd) === path)) setSelectedCwd(null);
    };
    window.addEventListener("pi-known-projects-changed", handleKnownProjectsChanged);
    return () => window.removeEventListener("pi-known-projects-changed", handleKnownProjectsChanged);
  }, [allSessions, loadKnownProjects, selectedCwd]);
  const loadSubprojectState = useCallback(async () => {
    try {
      const response = await fetch("/api/subprojects", { cache: "no-store" });
      const d = await response.json() as { subprojects?: SubprojectDefinition[]; sortSettings?: SubprojectSortSetting[] };
      if (Array.isArray(d.subprojects)) setSubprojects(d.subprojects);
      if (Array.isArray(d.sortSettings)) setSubprojectSortSettings(d.sortSettings);
    } catch {
      // Keep current bucket order when the sidecar is temporarily unavailable.
    }
  }, []);
  useEffect(() => {
    void loadSubprojectState();
  }, [loadSubprojectState, refreshKey]);
  useEffect(() => {
    window.addEventListener("pi-subprojects-changed", loadSubprojectState);
    return () => window.removeEventListener("pi-subprojects-changed", loadSubprojectState);
  }, [loadSubprojectState]);

  /** Resolve the project root for a cwd from the freshest data available */
  const projectRootFor = useCallback((cwd: string | null): string | null => {
    if (!cwd) return null;
    if (worktreeState && worktreeState.forCwd === cwd) return worktreeState.projectRoot;
    if (validatedProject?.cwd === cwd) return validatedProject.root;
    // Any path in the loaded worktree list belongs to that project — covers
    // worktrees without sessions, so switching to them keeps the row mounted.
    if (worktreeState?.worktrees.some((w) => w.path === cwd)) return worktreeState.projectRoot;
    const match = allSessions.find((s) => s.cwd === cwd);
    return match?.projectRoot ?? cwd;
  }, [allSessions, validatedProject, worktreeState]);

  // Notify parent only when the effective cwd actually changes (not when
  // projectRootFor identity changes due to session/worktree refreshes).
  const lastNotifiedCwdRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastNotifiedCwdRef.current === selectedCwd) return;
    lastNotifiedCwdRef.current = selectedCwd;
    onCwdChange?.(selectedCwd, projectRootFor(selectedCwd));
  }, [selectedCwd, onCwdChange, projectRootFor]);

  // Sync the worktree switcher to the selected session's cwd. Sessions of all
  // worktrees in a project share one list, so clicking a session from another
  // worktree should move the effective cwd there. Only fires when the prop
  // value changes, so a manual switcher change is not snapped back.
  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedCwdProp && selectedCwdProp !== lastSyncedCwdPropRef.current) {
      lastSyncedCwdPropRef.current = selectedCwdProp;
      setSelectedCwd(selectedCwdProp);
    }
  }, [selectedCwdProp]);

  // Load worktrees for the current effective cwd
  const [wtRefreshKey, setWtRefreshKey] = useState(0);
  useLayoutEffect(() => {
    if (!selectedCwd) {
      setWorktreeState(null);
      setWorktreeLoadingCwd(null);
      return;
    }
    let cancelled = false;
    setWorktreeLoadingCwd(selectedCwd);
    fetch(`/api/worktrees?cwd=${encodeURIComponent(selectedCwd)}`)
      .then((r) => r.json())
      .then((d: { projectRoot?: string; isGit?: boolean; isTopLevel?: boolean; currentWorktreePath?: string | null; worktrees?: WorktreeEntry[]; error?: string }) => {
        if (cancelled) return;
        setWorktreeLoadingCwd(null);
        if (d.error || !d.projectRoot) {
          setWorktreeState(null);
          return;
        }
        setWorktreeState({
          forCwd: selectedCwd,
          projectRoot: d.projectRoot,
          isGit: d.isGit ?? false,
          isTopLevel: d.isTopLevel ?? false,
          currentWorktreePath: d.currentWorktreePath ?? null,
          worktrees: d.worktrees ?? [],
        });
      })
      .catch(() => {
        if (!cancelled) {
          setWorktreeLoadingCwd(null);
          setWorktreeState(null);
        }
      });
    return () => { cancelled = true; };
  }, [selectedCwd, wtRefreshKey, refreshKey]);

  // Auto-select the most recent project once sessions load. URL session
  // restore lives in AppShell so it also works in the default activity mode.
  useEffect(() => {
    if (allSessions.length === 0 || skipInitialProjectSelection || selectedCwd !== null) return;
    const projects = getRecentProjects(allSessions);
    if (projects.length > 0) setSelectedCwd(projects[0]);
  }, [allSessions, selectedCwd, skipInitialProjectSelection]);

  // Prefer an exact UI selection while a refetch is in flight. Once the
  // response catches up, the server-resolved path handles Windows case and
  // separator differences without teaching the browser OS path semantics.
  const currentWorktree = worktreeState
    ? worktreeState.worktrees.find((worktree) => worktree.path === selectedCwd)
      ?? (worktreeState.forCwd === selectedCwd && worktreeState.currentWorktreePath
        ? worktreeState.worktrees.find((worktree) => worktree.path === worktreeState.currentWorktreePath)
        : undefined)
      ?? worktreeState.worktrees.find((worktree) => worktree.isMain)
    : undefined;
  const currentWorktreePath = currentWorktree?.path ?? null;

  const commitCustomPath = useCallback(async (candidate?: string, { remember = true } = {}) => {
    const path = (candidate ?? customPathValue).trim();
    if (!path || customPathValidating) return;

    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path, grant: true }),
      });
      const data = await res.json().catch(() => ({})) as { cwd?: string; projectRoot?: string; projectKey?: string; error?: string };
      if (!res.ok || data.error || !data.cwd) {
        setCustomPathError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      if (data.projectRoot && data.projectKey) {
        setValidatedProject({ cwd: data.cwd, root: data.projectRoot, key: data.projectKey });
      }
      if (remember) {
        saveLastCustomCwd(data.cwd);
        setCustomPathValue(data.cwd);
      }
      setSelectedCwd(data.cwd);
      // Remember the actively typed path so the project stays listed even
      // when it has no sessions yet.
      void fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: data.cwd ?? path }),
      }).then((r) => r.json()).then((d: { projects?: Array<{ path: string; addedAt: string }> }) => {
        if (Array.isArray(d.projects)) setKnownProjects(d.projects);
      }).catch(() => {});
      setCustomPathOpen(false);
      setCustomPathValue("");
      setDropdownOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, customPathValidating]);

  const handleCustomPathClick = useCallback(() => {
    setCustomPathOpen(true);
    setCustomPathError(null);
    setDropdownOpen(false);
  }, []);

  const handleDefaultCwd = useCallback(async () => {
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = await res.json() as { cwd?: string; error?: string };
      // Select it like any other directory, so validation, project identity and
      // the file allow-list all go through /api/cwd/validate. It is not a path
      // the user typed, so the custom-path picker does not remember it.
      if (data.cwd) await commitCustomPath(data.cwd, { remember: false });
    } catch (error) {
      setCustomPathError(error instanceof Error ? error.message : String(error));
      setCustomPathOpen(true);
    }
  }, [commitCustomPath]);

  const handleCreateWorktree = useCallback(async () => {
    const name = wtNewName.trim();
    if (!name || wtBusy || !worktreeState) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, branch: name }),
      });
      const data = await res.json().catch(() => ({})) as { path?: string; branch?: string; error?: string };
      if (!res.ok || data.error || !data.path) {
        setWtError(data.error ?? `HTTP ${res.status}`);
        setWtRefreshKey((key) => key + 1);
        return;
      }
      setWtNewOpen(false);
      setWtNewName("");
      setWtDropdownOpen(false);
      setSelectedCwd(data.path);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [wtNewName, wtBusy, worktreeState]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setProjectFilter("");
      }
      if (wtDropdownRef.current && !wtDropdownRef.current.contains(e.target as Node)) {
        setWtDropdownOpen(false);
        setWtNewOpen(false);
        setWtNewName("");
        setWtError(null);
        setWtFilter("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees.
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleNewSession = useCallback(async () => {
    if (!selectedCwd) return;
    onNewSession?.(`new-${Date.now()}`, selectedCwd, selectedSessionInfo?.subprojectId);
  }, [onNewSession, selectedCwd, selectedSessionInfo?.subprojectId]);
  const handleRefreshSessions = useCallback(() => {
    void loadSessions(false, true);
    setSessionRefreshDone(true);
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
  }, [loadSessions]);

  const handleSelectSessionFromList = useCallback((s: SessionInfo, searchTerm?: string) => {
    if (s.cwd && !preserveExplorerContextOnSessionSelect) setSelectedCwd(s.cwd);
    onSelectSession(s, false, searchTerm);
  }, [onSelectSession, preserveExplorerContextOnSessionSelect]);

  const selectedProject = projectRootFor(selectedCwd);
  const sessionsForDisplay = mergeSelectedSession(allSessions, selectedSessionInfo, showArchived, selectedProject, sessionListSnapshotView === showArchived);

  const handleDeleteProject = useCallback(async (project: string) => {
    if (projectDeleteBusy) return;
    setProjectDeleteBusy(true);
    setProjectDeleteError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: project }),
      });
      const data = await res.json().catch(() => ({})) as { projects?: Array<{ path: string; addedAt: string }>; code?: unknown };
      if (!res.ok) {
        setProjectDeleteError(data.code === "project_has_subprojects" ? t("sessionActivity.projectHasSubprojects") : t("sessionActivity.projectPathActionFailed"));
        return;
      }
      if (Array.isArray(data.projects)) setKnownProjects(data.projects);
      // A saved-only project that was selected disappears; drop the stale cwd.
      if (selectedCwd === project && !sessionsForDisplay.some((s) => (s.projectRoot ?? s.cwd) === project)) {
        setSelectedCwd(null);
      }
      setProjectDeleteConfirm(null);
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("pi-known-projects-changed", { detail: { path: project } }));
    } catch {
      setProjectDeleteError(t("sessionActivity.projectPathActionFailed"));
    } finally {
      setProjectDeleteBusy(false);
    }
  }, [projectDeleteBusy, selectedCwd, sessionsForDisplay, t]);
  const recentProjects = mergeProjectList(sessionsForDisplay, knownProjects);
  const showProjectFilter = recentProjects.length > 8;
  const sessionProjectSet = new Set(sessionsForDisplay.map((s) => s.projectRoot ?? s.cwd));
  const knownProjectPaths = new Set(knownProjects.map((project) => project.path));
  const visibleProjects = projectFilter.trim()
    ? recentProjects.filter((p) => p.toLowerCase().includes(projectFilter.trim().toLowerCase()))
    : recentProjects;

  // Sessions of every worktree in the selected project are shown together
  // Per-project activity counts (running / unread) for the workspace selector.
  // Keyed the same way as getRecentProjects (projectRoot ?? cwd) so the counts
  // line up with each dropdown item. Small data set — cheap to recompute.
  const projectActivity = useMemo(() => {
    const counts = new Map<string, { running: number; unread: number }>();
    for (const s of allSessions) {
      const key = s.projectRoot ?? s.cwd;
      if (!key) continue;
      let entry = counts.get(key);
      if (!entry) { entry = { running: 0, unread: 0 }; counts.set(key, entry); }
      if (effectiveRunningSessionIds.has(s.id)) entry.running++;
      if (unreadSessionIds.has(s.id)) entry.unread++;
    }
    return counts;
  }, [allSessions, effectiveRunningSessionIds, unreadSessionIds]);

  // Any activity in a project other than the one currently selected — shown as
  // a dot on the (collapsed) selector button so it is visible without opening
  // the dropdown.
  const hasOtherWorkspaceActivity = useMemo(
    () => [...projectActivity.entries()].some(
      ([key, { running, unread }]) => key !== selectedProject && (running > 0 || unread > 0),
    ),
    [projectActivity, selectedProject],
  );

  const projectFilteredSessions = selectedProject
    ? sessionsForDisplay.filter((s) => (s.projectRoot ?? s.cwd) === selectedProject)
    : sessionsForDisplay;
  const filteredSessions = projectFilteredSessions.filter((session) => isWithinActivityTimeRange(
    activityTimes[session.id] ?? session.modified,
    sharedFilters.days,
    nowMs,
  ));
  const selectedProjectKey = validatedProject?.root === selectedProject
    ? validatedProject.key
    : projectFilteredSessions.find((session) => (session.projectRoot ?? session.cwd) === selectedProject)?.projectKey;
  const projectSubprojects = useMemo(
    () => selectedProjectKey
      ? subprojects.filter((subproject) => projectKeysMatch(subproject.projectKey, selectedProjectKey))
      : [],
    [selectedProjectKey, subprojects],
  );
  const selectedSubprojectSort = selectedProjectKey
    ? subprojectSortSettings.find((setting) => projectKeysMatch(setting.projectKey, selectedProjectKey))
    : undefined;
  const autoHiddenSubprojectIds = useMemo(() => {
    if (!selectedSubprojectSort?.autoHideEmptySubprojects) return new Set<string>();
    const assignedIds = new Set(filteredSessions.map((session) => session.subprojectId).filter((id): id is string => typeof id === "string"));
    return new Set(projectSubprojects.filter((subproject) => !assignedIds.has(subproject.id)).map((subproject) => subproject.id));
  }, [filteredSessions, projectSubprojects, selectedSubprojectSort?.autoHideEmptySubprojects]);
  const selectedSubprojects = projectSubprojects.filter((subproject) => !subproject.hidden && !autoHiddenSubprojectIds.has(subproject.id));
  const selectedSubprojectHiddenIds = useMemo(
    () => new Set(projectSubprojects.filter((subproject) => subproject.hidden || autoHiddenSubprojectIds.has(subproject.id)).map((subproject) => subproject.id)),
    [autoHiddenSubprojectIds, projectSubprojects],
  );
  const visibleFilteredSessions = filterSubprojectItems(filteredSessions, selectedSubprojectHiddenIds);
  const visibleSubagentSessions = useMemo(
    () => visibleFilteredSessions.filter((session) => session.id === selectedSessionId
      || session.relation?.kind !== "subagent"
      || visibleSubagentParentIds.has(session.relation.parentSessionId)),
    [selectedSessionId, visibleFilteredSessions, visibleSubagentParentIds],
  );
  const subagentParentIds = useMemo(
    () => new Set(allSessions.flatMap((session) => session.relation?.kind === "subagent" ? [session.relation.parentSessionId] : [])),
    [allSessions],
  );
  const selectedSubprojectSortMode = selectedSubprojectSort?.mode ?? "custom";
  const selectedSubprojectCustomOrder = orderedSubprojectIds(selectedSubprojects, selectedSubprojectSort?.order);
  const subprojectBuckets = useMemo(
    () => selectedSubprojects.length > 0 && selectedProjectKey
      ? groupBySubproject(visibleSubagentSessions, selectedSubprojects, selectedProjectKey, t("sessionActivity.unclassified"), {
        mode: selectedSubprojectSortMode,
        customOrder: selectedSubprojectSort?.order,
        compareItems: (left, right) => right.modified.localeCompare(left.modified),
      })
      : [],
    [selectedProjectKey, selectedSubprojectSort?.order, selectedSubprojectSortMode, selectedSubprojects, t, visibleSubagentSessions],
  );
  const persistSubprojectSort = useCallback(async (order: string[]): Promise<boolean> => {
    if (!selectedProjectKey || selectedSubprojectSortMode !== "custom") return false;
    setSubprojectReorderError(null);
    try {
      const response = await fetch("/api/subprojects", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectKey: selectedProjectKey, mode: "custom", order }),
      });
      const payload = await response.json().catch(() => ({})) as { sortSetting?: SubprojectSortSetting; error?: unknown };
      if (!response.ok || !payload.sortSetting) {
        setSubprojectReorderError(typeof payload.error === "string" ? payload.error : t("sessionActivity.subprojectSortFailed"));
        return false;
      }
      setSubprojectSortSettings((current) => [...current.filter((setting) => !projectKeysMatch(setting.projectKey, selectedProjectKey)), payload.sortSetting!]);
      return true;
    } catch {
      setSubprojectReorderError(t("sessionActivity.subprojectSortFailed"));
      return false;
    }
  }, [selectedProjectKey, selectedSubprojectSortMode, t]);
  const subprojectReorderOriginRef = useRef<EventTarget | null>(null);
  const handleSubprojectReorderStart = useCallback((event: React.DragEvent<HTMLElement>, id: string) => {
    if (isSubprojectReorderDragBlocked(subprojectReorderOriginRef.current ?? event.target)) {
      event.preventDefault();
      subprojectReorderOriginRef.current = null;
      return;
    }
    if (selectedSubprojectSortMode !== "custom" || subprojectReorderBusy) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/subproject-id", id);
    event.dataTransfer.setData("text/plain", id);
  }, [selectedSubprojectSortMode, subprojectReorderBusy]);
  const handleSubprojectReorderOver = useCallback((event: React.DragEvent<HTMLElement>, id: string) => {
    if (selectedSubprojectSortMode !== "custom" || id === "__unclassified__" || !Array.from(event.dataTransfer.types).includes("text/subproject-id")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setSubprojectReorderOverId(id);
  }, [selectedSubprojectSortMode]);
  const handleSubprojectReorderDrop = useCallback((event: React.DragEvent<HTMLElement>, targetId: string) => {
    if (selectedSubprojectSortMode !== "custom" || targetId === "__unclassified__") return;
    event.preventDefault();
    setSubprojectReorderOverId(null);
    const sourceId = event.dataTransfer.getData("text/subproject-id");
    if (!sourceId || sourceId === targetId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const nextOrder = reorderSubprojectIds(selectedSubprojectCustomOrder, sourceId, targetId, event.clientY < rect.top + rect.height / 2);
    if (nextOrder.every((id, index) => id === selectedSubprojectCustomOrder[index])) return;
    setSubprojectReorderBusy(true);
    void persistSubprojectSort(nextOrder).finally(() => setSubprojectReorderBusy(false));
  }, [persistSubprojectSort, selectedSubprojectCustomOrder, selectedSubprojectSortMode]);
  const moveSessionToSubproject = useCallback(async (session: SessionInfo, subprojectId: string | null): Promise<boolean> => {
    if (session.transient || !session.projectKey) return false;
    const previousSubprojectId = session.subprojectId;
    const optimisticSubprojectId = subprojectId ?? undefined;
    const applyAssignment = (nextSubprojectId: string | undefined, onlyIf?: string, guard = false) => {
      setAllSessions((current) => current.map((candidate) => {
        if (candidate.id !== session.id) return candidate;
        if (guard && candidate.subprojectId !== onlyIf) return candidate;
        return candidate.subprojectId === nextSubprojectId ? candidate : { ...candidate, subprojectId: nextSubprojectId };
      }));
      setSearchResults((current) => current?.map((candidate) => {
        if (candidate.id !== session.id) return candidate;
        if (guard && candidate.subprojectId !== onlyIf) return candidate;
        return candidate.subprojectId === nextSubprojectId ? candidate : { ...candidate, subprojectId: nextSubprojectId };
      }) ?? current);
    };
    applyAssignment(optimisticSubprojectId);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/subproject`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectKey: session.projectKey, subprojectId }),
      });
      if (!response.ok) {
        applyAssignment(previousSubprojectId, optimisticSubprojectId, true);
        return false;
      }
      void loadSessions(false, true);
      return true;
    } catch {
      applyAssignment(previousSubprojectId, optimisticSubprojectId, true);
      return false;
    }
  }, [loadSessions]);


  const renameSubprojectInSidebar = useCallback(async (subproject: SubprojectDefinition, label: string): Promise<boolean> => {
    try {
      const response = await fetch("/api/subprojects", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: subproject.id, label }) });
      if (!response.ok) return false;
      setSubprojects((current) => current.map((item) => item.id === subproject.id ? { ...item, label } : item));
      if (typeof window !== "undefined") window.dispatchEvent(new Event("pi-subprojects-changed"));
      return true;
    } catch {
      return false;
    }
  }, []);
  const deleteSubprojectInSidebar = useCallback(async (subproject: SubprojectDefinition): Promise<boolean> => {
    try {
      const response = await fetch("/api/subprojects", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: subproject.id }) });
      if (!response.ok) return false;
      setSubprojects((current) => current.filter((item) => item.id !== subproject.id));
      if (typeof window !== "undefined") window.dispatchEvent(new Event("pi-subprojects-changed"));
      return true;
    } catch {
      return false;
    }
  }, []);
  const beginSubprojectRename = (subproject: SubprojectDefinition) => {
    setSubprojectDeleteConfirmId(null);
    setSubprojectDeleteError(null);
    setSubprojectRenameError(null);
    setSubprojectRenameId(subproject.id);
    setSubprojectRenameLabel(subproject.label);
  };
  const cancelSubprojectRename = () => {
    setSubprojectRenameId(null);
    setSubprojectRenameLabel("");
    setSubprojectRenameError(null);
  };
  const handleSubprojectRename = async (subproject: SubprojectDefinition) => {
    if (subprojectRenameBusyId) return;
    const nextLabel = subprojectRenameLabel.trim();
    if (!nextLabel) return;
    if (nextLabel === subproject.label) {
      cancelSubprojectRename();
      return;
    }
    setSubprojectRenameBusyId(subproject.id);
    setSubprojectRenameError(null);
    const renamed = await renameSubprojectInSidebar(subproject, nextLabel).catch(() => false);
    setSubprojectRenameBusyId(null);
    if (renamed) cancelSubprojectRename();
    else setSubprojectRenameError(t("sessionActivity.subprojectRenameFailed"));
  };
  const requestSubprojectDelete = (subproject: SubprojectDefinition) => {
    setSubprojectRenameId(null);
    setSubprojectRenameError(null);
    setSubprojectDeleteError(null);
    setSubprojectDeleteConfirmId(subproject.id);
  };
  const handleSubprojectDelete = async (subproject: SubprojectDefinition) => {
    if (subprojectDeleteBusyId) return;
    setSubprojectDeleteBusyId(subproject.id);
    setSubprojectDeleteError(null);
    const deleted = await deleteSubprojectInSidebar(subproject).catch(() => false);
    setSubprojectDeleteBusyId(null);
    if (deleted) setSubprojectDeleteConfirmId(null);
    else setSubprojectDeleteError(t("sessionActivity.subprojectDeleteFailed"));
  };
  const toggleSubprojectVisibilityInSidebar = useCallback(async (subproject: SubprojectDefinition): Promise<boolean> => {
    if (subprojectVisibilityBusyId) return false;
    setSubprojectVisibilityBusyId(subproject.id);
    setSubprojectVisibilityError(null);
    try {
      const response = await fetch("/api/subprojects", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: subproject.id, hidden: !subproject.hidden }) });
      if (!response.ok) {
        setSubprojectVisibilityError({ id: subproject.id, message: t("sessionActivity.subprojectVisibilityFailed") });
        return false;
      }
      setSubprojects((current) => current.map((item) => item.id === subproject.id ? { ...item, hidden: !subproject.hidden } : item));
      if (typeof window !== "undefined") window.dispatchEvent(new Event("pi-subprojects-changed"));
      return true;
    } catch {
      setSubprojectVisibilityError({ id: subproject.id, message: t("sessionActivity.subprojectVisibilityFailed") });
      return false;
    } finally {
      setSubprojectVisibilityBusyId(null);
    }
  }, [subprojectVisibilityBusyId, t]);
  const showWorktreeSwitcher = Boolean(
    worktreeState?.isGit
    && worktreeState.isTopLevel
    && selectedCwd
    && selectedProject === worktreeState.projectRoot
  );
  const worktreeGuide = selectedCwd
    && worktreeState
    && selectedProject === worktreeState.projectRoot
    && !showWorktreeSwitcher
    ? (worktreeState.isGit
        ? {
             label: t("sidebar.openRepoRoot"),
             title: t("sidebar.openRepoRootTitle"),
          }
        : {
             label: t("sidebar.gitRepoRootOnly"),
             title: t("sidebar.gitRepoRootOnlyTitle"),
          })
    : null;
  const worktreeLoading = Boolean(selectedCwd && worktreeLoadingCwd === selectedCwd);
  const inactiveWorktreeSelector = worktreeGuide
    ?? (worktreeLoading && !showWorktreeSwitcher
      ? {
           label: t("sidebar.worktrees"),
           title: t("sidebar.checkingWorktrees"),
        }
      : null);

  // Build parent-child tree within the filtered set
  const sessionTree = buildSessionTree(visibleSubagentSessions);
  const virtualScopeKey = `${showArchived ? "archived" : "active"}:${searchQuery.trim() ? "search" : groupByWorktree ? "worktree" : selectedSubprojects.length > 0 ? "subproject" : "tree"}:${selectedProjectKey ?? ""}`;
  useEffect(() => {
    setVirtualRowHeights({});
    setActiveVirtualRowIds([]);
  }, [virtualScopeKey]);
  const virtualPinnedIds = getPinnedInteractionIds(
    activeVirtualRowIds,
    [
      ...(subprojectRenameId ? [`subproject:${subprojectRenameId}`] : []),
      ...(subprojectDeleteConfirmId ? [`subproject:${subprojectDeleteConfirmId}`] : []),
    ],
  );
  const localVirtualScrollTop = Math.max(0, virtualViewport.scrollTop - virtualOrigin);
  const localVirtualViewportHeight = Math.max(0, virtualViewport.viewportHeight - Math.max(0, virtualOrigin - virtualViewport.scrollTop));
  const measuredRows = <T, B>(rows: SessionSidebarRow<T, B>[]) => rows.map((row) => ({
    ...row,
    height: virtualRowHeights[row.id] ?? row.height,
  })) as SessionSidebarRow<T, B>[];
  const openSubagentContextMenu = useCallback((id: string, clientX: number, clientY: number) => {
    setSubagentContextMenu({ id, x: clientX, y: clientY });
  }, []);
  const renderVirtualSession = (session: SessionInfo, depth: number, hasChildren: boolean, collapsed: boolean): ReactNode => (
    <SessionTreeItem
      node={{ session, children: [] }}
      selectedSessionId={selectedSessionId}
      highlightedSessionId={highlightedSessionId}
      runningSessionIds={effectiveRunningSessionIds}
      unreadSessionIds={unreadSessionIds}
      onSelectSession={handleSelectSessionFromList}
      onRenamed={() => loadSessions(false, true)}
      onSessionDeleted={(id) => { handleSessionDeleted(id); loadSessions(false, true); }}
      onSessionArchived={(id) => { onSessionDeleted?.(id); loadSessions(false, true); }}
      depth={depth}
      subprojects={selectedSubprojects}
      onMoveToSubproject={moveSessionToSubproject}
      controlledCollapsed={collapsed}
      onToggleCollapse={() => setCollapsedSessionIds((current) => {
        const next = new Set(current);
        if (next.has(session.id)) next.delete(session.id); else next.add(session.id);
        return next;
      })}
      hasChildrenOverride={hasChildren}
      hasSubagentChildren={() => subagentParentIds.has(session.id)}
      subagentsVisible={() => visibleSubagentParentIds.has(session.id)}
      onSubagentContextMenu={openSubagentContextMenu}
      virtualized
      onInteractionChange={markVirtualInteraction}
    />
  );
  const treeVirtualRows = measuredRows(flattenSessionTreeRows(sessionTree, collapsedSessionIds));
  const searchVirtualRows = measuredRows(visibleSearchResults.map((hit): SessionSidebarRow<SessionSearchResult, never> => ({
    kind: "session",
    id: hit.id,
    session: hit,
    depth: 0,
    hasChildren: false,
    collapsed: false,
    height: SESSION_ROW_HEIGHT,
  })));
  const subprojectVirtualRows = measuredRows(flattenBucketedSessionRows(
    subprojectBuckets.map((bucket) => ({ id: `subproject:${bucket.id}`, label: bucket.label, items: bucket.items, value: bucket })),
    buildSessionTree,
    new Set(collapsedSubprojectBuckets),
    collapsedSessionIds,
  ));
  const buildWorktreeTree = (items: SessionInfo[]): WorktreeVirtualTreeNode<SessionInfo>[] => {
    const convert = (node: SessionTreeNode): WorktreeVirtualTreeNode<SessionInfo> => ({
      item: node.session,
      children: node.children.map((child) => convert(child)),
    });
    return buildSessionTree(items).map((node) => convert(node));
  };
  type SidebarSubprojectBucket = (typeof subprojectBuckets)[number];
  const renderVirtualSubprojectRow = (row: SessionSidebarRow<SessionInfo, SidebarSubprojectBucket>): ReactNode => {
    if (row.kind === "session") return renderVirtualSession(row.session, row.depth, row.hasChildren, row.collapsed);
    if (row.kind !== "bucket") return null;
    const bucket = row.bucket.value;
    const bucketKey = `${selectedProjectKey}:${bucket.id}`;
    const collapsed = row.collapsed;
    const confirmDelete = Boolean(bucket.subproject && subprojectDeleteConfirmId === bucket.id);
    const editing = Boolean(bucket.subproject && subprojectRenameId === bucket.id);
    const title = (
      <button className="activity-subproject-toggle" type="button" onClick={() => setCollapsedSubprojectBuckets((current) => current.includes(bucketKey) ? current.filter((key) => key !== bucketKey) : [...current, bucketKey])} aria-expanded={!collapsed} aria-label={collapsed ? t("sessionActivity.expandSubproject") : t("sessionActivity.collapseSubproject")}>
        <ChevronRight size={11} strokeWidth={1.9} aria-hidden="true" style={{ flexShrink: 0, color: collapsed ? "#dc2626" : undefined, transform: collapsed ? "none" : "rotate(90deg)", transition: "transform 0.12s" }} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bucket.label}</span>
      </button>
    );
    const subprojectTitle = editing ? (
      <>
        <button className="activity-subproject-toggle activity-subproject-toggle-editing" type="button" onClick={() => setCollapsedSubprojectBuckets((current) => current.includes(bucketKey) ? current.filter((key) => key !== bucketKey) : [...current, bucketKey])} aria-expanded={!collapsed} aria-label={collapsed ? t("sessionActivity.expandSubproject") : t("sessionActivity.collapseSubproject")}>
          <ChevronRight size={11} strokeWidth={1.9} aria-hidden="true" style={{ flexShrink: 0, color: collapsed ? "#dc2626" : undefined, transform: collapsed ? "none" : "rotate(90deg)", transition: "transform 0.12s" }} />
        </button>
        <div className="activity-subproject-rename activity-subproject-rename-inline activity-subproject-rename-sidebar" role="group" aria-label={`${t("sidebar.rename")}: ${bucket.label}`} onClick={(event) => event.stopPropagation()}>
          <input autoFocus value={subprojectRenameLabel} disabled={subprojectRenameBusyId !== null} onChange={(event) => setSubprojectRenameLabel(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void handleSubprojectRename(bucket.subproject!); if (event.key === "Escape") cancelSubprojectRename(); }} aria-label={`${t("sidebar.rename")}: ${bucket.label}`} />
          <button type="button" disabled={subprojectRenameBusyId !== null || !subprojectRenameLabel.trim()} onClick={() => void handleSubprojectRename(bucket.subproject!)} title={t("sidebar.confirm")} aria-label={t("sidebar.confirm")}><Check size={13} aria-hidden="true" /></button>
          <button type="button" disabled={subprojectRenameBusyId !== null} onClick={cancelSubprojectRename} title={t("sidebar.cancel")} aria-label={t("sidebar.cancel")}><X size={13} aria-hidden="true" /></button>
        </div>
      </>
    ) : title;
    return (
      <div className={`activity-subproject-drop-zone${subprojectReorderOverId === bucket.id ? " subproject-reorder-over" : ""}`} data-session-subproject-drop="true" data-session-project-key={selectedProjectKey} data-session-subproject-id={bucket.id === "__unclassified__" ? "" : bucket.id} onDragOver={(event) => handleSubprojectReorderOver(event, bucket.id)} onDrop={(event) => handleSubprojectReorderDrop(event, bucket.id)} onDragLeave={() => { if (subprojectReorderOverId === bucket.id) setSubprojectReorderOverId(null); }}>
        <div className="activity-subproject-header activity-subproject-header-sidebar" data-unclassified={bucket.id === "__unclassified__" ? "true" : undefined} draggable={Boolean(bucket.subproject && selectedSubprojectSortMode === "custom" && !subprojectReorderBusy)} onPointerDownCapture={(event) => { subprojectReorderOriginRef.current = event.target; }} onPointerUpCapture={() => { subprojectReorderOriginRef.current = null; }} onPointerCancelCapture={() => { subprojectReorderOriginRef.current = null; }} onKeyDownCapture={() => { subprojectReorderOriginRef.current = null; }} onDragStart={(event) => { if (bucket.subproject) handleSubprojectReorderStart(event, bucket.subproject.id); }} onDragEnd={() => { subprojectReorderOriginRef.current = null; setSubprojectReorderOverId(null); }}>
          {bucket.subproject ? <SubprojectContextMenu subproject={bucket.subproject} onRenameRequest={beginSubprojectRename} onDeleteRequest={requestSubprojectDelete}>{subprojectTitle}</SubprojectContextMenu> : title}
          {bucket.subproject && <button className="activity-subproject-visibility" type="button" data-session-subproject-visibility="true" disabled={subprojectVisibilityBusyId !== null} onClick={(event) => { event.stopPropagation(); void toggleSubprojectVisibilityInSidebar(bucket.subproject!); }} title={`${t("sessionActivity.hideSubproject")}: ${bucket.label}`} aria-label={`${t("sessionActivity.hideSubproject")}: ${bucket.label}`} aria-busy={subprojectVisibilityBusyId === bucket.id}><Eye size={12} strokeWidth={1.8} aria-hidden="true" /></button>}
          <span style={{ flexShrink: 0, color: "inherit", fontSize: 10, fontWeight: 500 }}>{bucket.items.length}</span>
          {bucket.subproject && onNewSession && <button className="activity-project-action" type="button" onClick={(event) => { event.stopPropagation(); if (selectedCwd) onNewSession(`subproject-${Date.now()}`, selectedCwd, bucket.subproject!.id, bucket.label); }} title={t("sidebar.newSessionTitle", { path: selectedCwd ?? "" })} aria-label={t("sidebar.newSessionTitle", { path: selectedCwd ?? "" })}><MessageSquarePlus size={14} strokeWidth={1.8} aria-hidden="true" /></button>}
        </div>
        {subprojectRenameError && editing && <div role="alert" style={{ padding: "2px 10px 4px", color: "#dc2626", fontSize: 10 }}>{subprojectRenameError}</div>}
        {confirmDelete && bucket.subproject && <div className="activity-subproject-delete-confirm" role="alert"><span>{t("sessionActivity.deleteSubproject", { label: bucket.label })}</span><button type="button" disabled={subprojectDeleteBusyId !== null} onClick={() => void handleSubprojectDelete(bucket.subproject!)}>{t("sidebar.confirm")}</button><button type="button" disabled={subprojectDeleteBusyId !== null} onClick={() => { setSubprojectDeleteConfirmId(null); setSubprojectDeleteError(null); }}>{t("sidebar.cancel")}</button></div>}
        {subprojectDeleteError && confirmDelete && <div role="alert" style={{ padding: "2px 10px 4px", color: "#dc2626", fontSize: 10 }}>{subprojectDeleteError}</div>}
        {subprojectVisibilityError?.id === bucket.id && <div role="alert" style={{ padding: "2px 10px 4px", color: "#dc2626", fontSize: 10 }}>{subprojectVisibilityError.message}</div>}
        {subprojectReorderError && <div role="alert" style={{ padding: "2px 10px 4px", color: "#dc2626", fontSize: 10 }}>{subprojectReorderError}</div>}
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", cursor: "pointer" }}>
      {customPathOpen && (
        <DirectoryPicker
          initialPath={customPathValue}
          busy={customPathValidating}
          error={customPathError}
          onCancel={() => {
            setCustomPathOpen(false);
            setCustomPathError(null);
          }}
          onSelect={(path) => void commitCustomPath(path)}
        />
      )}
      {/* Header — hidden in reader mode */}
      {!readerMode && (
      <div
        style={{
          padding: "12px 10px 10px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <PiWebTitle />
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={handleNewSession}
              disabled={!selectedCwd}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                background: "var(--bg-hover)",
                border: "1px solid var(--border)",
                color: selectedCwd ? "var(--text-muted)" : "var(--text-dim)",
                cursor: selectedCwd ? "pointer" : "not-allowed",
                height: 32,
                paddingLeft: 10,
                paddingRight: 12,
                borderRadius: 7,
                fontSize: 12,
                fontWeight: 500,
                letterSpacing: "-0.01em",
                flexShrink: 0,
                transition: "background 0.12s, color 0.12s, border-color 0.12s",
              }}
             title={selectedCwd ? t("sidebar.newSessionTitle", { path: selectedCwd }) : t("sidebar.selectProject")}
              onMouseEnter={(e) => {
                if (!selectedCwd) return;
                e.currentTarget.style.background = "var(--bg-selected)";
                e.currentTarget.style.color = "var(--accent)";
                e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = selectedCwd ? "var(--text-muted)" : "var(--text-dim)";
                e.currentTarget.style.borderColor = "var(--border)";
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="6" y1="1" x2="6" y2="11" />
                <line x1="1" y1="6" x2="11" y2="6" />
              </svg>
              {t("sidebar.new")}
            </button>
            <button
              onClick={handleRefreshSessions}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                background: sessionRefreshDone ? "rgba(74,222,128,0.18)" : "var(--bg-hover)",
                border: `1px solid ${sessionRefreshDone ? "rgba(74,222,128,0.4)" : "var(--border)"}`,
                color: sessionRefreshDone ? "#4ade80" : "var(--text-muted)",
                cursor: "pointer",
                width: 32, height: 32,
                borderRadius: 7,
                padding: 0,
                flexShrink: 0,
                transition: "background 0.3s, color 0.3s, border-color 0.3s",
              }}
              onMouseEnter={(e) => {
                if (sessionRefreshDone) return;
                e.currentTarget.style.background = "var(--bg-selected)";
                e.currentTarget.style.color = "var(--accent)";
                e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
              }}
              onMouseLeave={(e) => {
                if (sessionRefreshDone) return;
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text-muted)";
                e.currentTarget.style.borderColor = "var(--border)";
              }}
               title={t("sidebar.refresh")}
            >
              {sessionRefreshDone ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* CWD picker */}
        <div style={{ display: "flex", alignItems: "stretch", gap: 6 }}>
          <div ref={dropdownRef} style={{ position: "relative", flex: 1, minWidth: 0 }}>
          <button
            onClick={() => setDropdownOpen((v) => !v)}
            title={selectedProject ?? selectedCwd ?? ""}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              padding: "6px 10px",
              background: selectedCwd ? "var(--bg-hover)" : "rgba(37,99,235,0.06)",
              border: selectedCwd ? "1px solid var(--border)" : "1px solid rgba(37,99,235,0.4)",
              borderRadius: 7,
              cursor: "pointer",
              fontSize: 12,
              color: "var(--text)",
              textAlign: "left",
              transition: "border-color 0.15s, background 0.15s",
            }}
          >
            {selectedCwd ? (
              <PathLabel
                text={displayCwd(selectedProject ?? selectedCwd, homeDir)}
                style={{
                  flex: 1,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--text)",
                }}
              />
            ) : (
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--text-dim)",
                }}
              >
                 {t("sidebar.selectProject")}
              </span>
            )}
            {hasOtherWorkspaceActivity && (
              <span
                title={t("sidebar.newActivity")}
                aria-label={t("sidebar.newActivity")}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  flexShrink: 0,
                  marginLeft: 6,
                  background: "var(--accent)",
                }}
              />
            )}
          </button>

          <AnimatedDropdown
            open={dropdownOpen}
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: 0,
              right: 0,
              zIndex: 100,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
              overflow: "hidden",
            }}
          >
              {showProjectFilter && (
                <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                  <input
                    value={projectFilter}
                    onChange={(e) => setProjectFilter(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setProjectFilter("");
                        setProjectDeleteError(null);
                        setDropdownOpen(false);
                      }
                    }}
                     placeholder={t("sidebar.filterProjects")}
                    autoFocus
                    style={{
                      width: "100%",
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                      padding: "5px 8px",
                      border: "1px solid var(--border)",
                      borderRadius: 5,
                      outline: "none",
                      background: "var(--bg)",
                      color: "var(--text)",
                      boxSizing: "border-box",
                    }}
                  />
                </div>
              )}
              <div style={{ maxHeight: "min(50vh, 380px)", overflowY: "auto" }}>
                {visibleProjects.map((project) => {
                  if (projectDeleteConfirm === project) {
                    const hasSessions = sessionProjectSet.has(project);
                    return (
                      <div key={project} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", borderBottom: "1px solid var(--border)", background: "rgba(239,68,68,0.06)" }}>
                        <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 2 }}>
                          <span style={{ fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "normal" }}>
                            {hasSessions ? t("sidebar.deleteProjectWithSessions") : t("sidebar.deleteProjectEmpty")}
                          </span>
                          {projectDeleteError && <span role="alert" style={{ fontSize: 10, color: "#dc2626", overflowWrap: "anywhere" }}>{projectDeleteError}</span>}
                        </div>
                        <button
                          type="button"
                          disabled={projectDeleteBusy}
                          onClick={() => void handleDeleteProject(project)}
                          style={{ padding: "3px 9px", background: "#ef4444", border: "none", borderRadius: 5, color: "#fff", fontSize: 11, fontWeight: 600, cursor: projectDeleteBusy ? "wait" : "pointer", flexShrink: 0 }}
                        >
                          {t("sidebar.deleteProject")}
                        </button>
                        <button
                          type="button"
                          disabled={projectDeleteBusy}
                          onClick={() => { setProjectDeleteConfirm(null); setProjectDeleteError(null); }}
                          style={{ padding: "3px 9px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", fontSize: 11, cursor: projectDeleteBusy ? "wait" : "pointer", flexShrink: 0 }}
                        >
                          {t("sidebar.cancel")}
                        </button>
                      </div>
                    );
                  }
                  return (
                    <div key={project} style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)" }}>
                      <button
                        onClick={() => {
                          setSelectedCwd(project);
                          setProjectFilter("");
                          setProjectDeleteError(null);
                          setCustomPathOpen(false);
                          setCustomPathValue("");
                          setCustomPathError(null);
                          setDropdownOpen(false);
                        }}
                        onContextMenu={(e) => {
                          if (!knownProjectPaths.has(project) || sessionProjectSet.has(project)) return;
                          e.preventDefault();
                          setProjectDeleteError(null);
                          setProjectDeleteConfirm(project);
                        }}
                        title={knownProjectPaths.has(project) && !sessionProjectSet.has(project) ? t("sidebar.deleteProjectHint") : project}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          display: "flex",
                          alignItems: "center",
                          gap: 7,
                          padding: "8px 10px",
                          background: "var(--bg)",
                          border: "none",
                          color: project === selectedProject ? "var(--text)" : "var(--text-muted)",
                          cursor: "pointer",
                          textAlign: "left",
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {project === selectedProject && (
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                            <polyline points="1.5 5 4 7.5 8.5 2.5" />
                          </svg>
                        )}
                        {project !== selectedProject && <span style={{ width: 10, flexShrink: 0 }} />}
                        <PathLabel text={displayCwd(project, homeDir)} style={{ flex: 1 }} />
                      </button>
                      {showProjectActivity(projectActivity.get(project), t)}

                    </div>
                  );
                })}
                {visibleProjects.length === 0 && projectFilter.trim() && (
                   <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar.noMatchingProjects")}</div>
                )}
              </div>

              {/* Default cwd shortcut */}
              {!customPathOpen && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleDefaultCwd(); }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    width: "100%",
                    padding: "8px 10px",
                    background: "none",
                    border: "none",
                    borderTop: visibleProjects.length > 0 ? "1px solid var(--border)" : "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 11,
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
                  </svg>
                   <span>{t("sidebar.useDefaultDirectory")}</span>
                </button>
              )}

              {/* Custom path directory picker */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleCustomPathClick();
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  width: "100%",
                  padding: "8px 10px",
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  textAlign: "left",
                  fontSize: 11,
                }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" style={{ flexShrink: 0 }}>
                  <line x1="5" y1="1" x2="5" y2="9" />
                  <line x1="1" y1="5" x2="9" y2="5" />
                </svg>
                <span>{t("sidebar.customPath")}</span>
              </button>
          </AnimatedDropdown>
          </div>
        </div>

        {/* Worktree switcher — shown only for git projects at a checkout top
            level (repo subdirs keep their own project identity, so switching
            from them would jump projects). Rendered whenever the selected cwd
            belongs to the loaded project (not just when forCwd matches), so
            switching between worktrees of one project keeps the row mounted
            instead of flickering while data refetches: all worktrees of a
            project share the same list anyway. */}
        {showWorktreeSwitcher && (() => {
          if (!worktreeState) return null;
          const showWtFilter = worktreeState.worktrees.length >= 8;
          const visibleWorktrees = showWtFilter && wtFilter.trim()
            ? worktreeState.worktrees.filter((w) =>
                (w.branch ?? displayCwd(w.path, homeDir)).toLowerCase().includes(wtFilter.trim().toLowerCase()))
            : worktreeState.worktrees;
          return (
            <div ref={wtDropdownRef} style={{ position: "relative", marginTop: 6 }}>
              <button
                onClick={() => setWtDropdownOpen((v) => !v)}
                 title={currentWorktree ? t("sidebar.switchWorktreeTitle", { path: currentWorktree.path }) : t("sidebar.switchWorktree")}
                style={{
                  width: "100%",
                  height: 29,
                  boxSizing: "border-box",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "0 10px",
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  cursor: "pointer",
                  fontSize: 11,
                  lineHeight: 1.35,
                  color: "var(--text-muted)",
                  textAlign: "left",
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: currentWorktree && !currentWorktree.isMain ? "var(--accent)" : "var(--text-dim)" }}>
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                <PathLabel
                  text={currentWorktree ? (currentWorktree.branch ?? displayCwd(currentWorktree.path, homeDir)) : "…"}
                  style={{ flex: 1, fontFamily: "var(--font-mono)", color: "var(--text)" }}
                />
                {currentWorktree?.isMain && (
                   <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{t("sidebar.main")}</span>
                )}
                {worktreeState.worktrees.length > 1 && (
                  <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>
                    {worktreeState.worktrees.length}
                  </span>
                )}
                <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <polyline points="2 3.5 5 6.5 8 3.5" />
                </svg>
              </button>

              <AnimatedDropdown
                open={wtDropdownOpen}
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  left: 0,
                  right: 0,
                  zIndex: 100,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
                  overflow: "hidden",
                }}
              >
                  {showWtFilter && (
                    <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                      <input
                        value={wtFilter}
                        onChange={(e) => setWtFilter(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            setWtFilter("");
                            setWtDropdownOpen(false);
                          }
                        }}
                        placeholder={t("sidebar.filterWorktrees")}
                        autoFocus
                        style={{
                          width: "100%",
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          padding: "5px 8px",
                          border: "1px solid var(--border)",
                          borderRadius: 5,
                          outline: "none",
                          background: "var(--bg)",
                          color: "var(--text)",
                          boxSizing: "border-box",
                        }}
                      />
                    </div>
                  )}
                  <div style={{ maxHeight: "min(40vh, 300px)", overflowY: "auto" }}>
                    {visibleWorktrees.map((wt) => {
                      const isCurrent = wt.path === currentWorktreePath;
                      return (
                        <div
                          key={wt.path}
                          className="wt-row"
                          style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)" }}
                        >
                          <button
                            onClick={() => {
                              setSelectedCwd(wt.path);
                              setWtDropdownOpen(false);
                              setWtError(null);
                              setWtFilter("");
                            }}
                            title={wt.path}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              display: "flex",
                              alignItems: "center",
                              gap: 7,
                              padding: "8px 10px",
                              background: "var(--bg)",
                              border: "none",
                              color: isCurrent ? "var(--text)" : "var(--text-muted)",
                              cursor: "pointer",
                              textAlign: "left",
                              fontSize: 11,
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            {isCurrent ? (
                              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                <polyline points="1.5 5 4 7.5 8.5 2.5" />
                              </svg>
                            ) : (
                              <span style={{ width: 10, flexShrink: 0 }} />
                            )}
                            <PathLabel text={wt.branch ?? displayCwd(wt.path, homeDir)} style={{ flex: 1 }} />
                            {wt.isMain && <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{t("sidebar.main")}</span>}
                          </button>
                        </div>
                      );
                    })}
                    {showWtFilter && visibleWorktrees.length === 0 && wtFilter.trim() && (
                      <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar.noMatchingWorktrees")}</div>
                    )}
                  </div>

                  {!wtNewOpen ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setWtNewOpen(true);
                        setWtError(null);
                        setTimeout(() => wtNewInputRef.current?.focus(), 0);
                      }}
                      title={t("sidebar.createWorktreeTitle")}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        width: "100%",
                        padding: "8px 10px",
                        background: "none",
                        border: "none",
                        color: "var(--text-muted)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 11,
                      }}
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" style={{ flexShrink: 0 }}>
                        <line x1="5" y1="1" x2="5" y2="9" />
                        <line x1="1" y1="5" x2="9" y2="5" />
                      </svg>
                       <span>{t("sidebar.newWorktree")}</span>
                    </button>
                  ) : (
                    <div style={{ padding: "6px 8px" }}>
                      <input
                        ref={wtNewInputRef}
                        value={wtNewName}
                        onChange={(e) => {
                          setWtNewName(e.target.value);
                          setWtError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void handleCreateWorktree();
                          }
                          if (e.key === "Escape") {
                            setWtNewOpen(false);
                            setWtNewName("");
                            setWtError(null);
                          }
                        }}
                         placeholder={t("sidebar.branchName")}
                        style={{
                          width: "100%",
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          padding: "5px 8px",
                          border: "1px solid var(--accent)",
                          borderRadius: 5,
                          outline: "none",
                          background: "var(--bg)",
                          color: "var(--text)",
                          boxSizing: "border-box",
                        }}
                      />
                      <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                        <button
                          onClick={() => void handleCreateWorktree()}
                          disabled={wtBusy || !wtNewName.trim()}
                          style={{
                            flex: 1,
                            padding: "4px 0",
                            background: "var(--accent)",
                            border: "none",
                            borderRadius: 5,
                            color: "#fff",
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: wtBusy || !wtNewName.trim() ? "not-allowed" : "pointer",
                            opacity: wtBusy || !wtNewName.trim() ? 0.65 : 1,
                          }}
                        >
                           {wtBusy ? t("sidebar.creating") : t("sidebar.create")}
                        </button>
                        <button
                          onClick={() => { setWtNewOpen(false); setWtNewName(""); setWtError(null); }}
                          style={{
                            flex: 1,
                            padding: "4px 0",
                            background: "var(--bg-hover)",
                            border: "1px solid var(--border)",
                            borderRadius: 5,
                            color: "var(--text-muted)",
                            fontSize: 11,
                            cursor: "pointer",
                          }}
                        >
                           {t("sidebar.cancel")}
                        </button>
                      </div>
                    </div>
                  )}
                  {wtError && (
                    <div style={{
                      padding: "5px 10px 8px",
                      color: "#dc2626",
                      fontSize: 11,
                      lineHeight: 1.35,
                      overflowWrap: "anywhere",
                    }}>
                      {wtError}
                    </div>
                  )}
              </AnimatedDropdown>
            </div>
          );
        })()}
        {inactiveWorktreeSelector && (
          <button
            type="button"
            aria-disabled="true"
            tabIndex={-1}
            title={inactiveWorktreeSelector.title}
            style={{
              width: "100%",
              height: 29,
              boxSizing: "border-box",
              marginTop: 6,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "0 10px",
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "var(--bg-hover)",
              color: "var(--text-dim)",
              fontSize: 11,
              lineHeight: 1.35,
              whiteSpace: "nowrap",
              textAlign: "left",
              cursor: "default",
              opacity: 0.82,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{inactiveWorktreeSelector.label}</span>
          </button>
        )}
      </div>
      )}

      {/* Session list — collapsible independently from Reader */}
      {(
      <div
        style={{
          borderTop: "1px solid var(--border)",
          display: sessionsOpen && !readerMode ? "flex" : "none",
          flexDirection: "column",
          flex: sessionsOpen
            ? (explorerOpen && (selectedCwdProp || selectedCwd) ? "1 1 0" : "1 1 auto")
            : "0 0 auto",
          minHeight: sessionsOpen ? 80 : 0,
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 4, paddingRight: 6, flexShrink: 0 }}>
          <button
            onClick={() => setSessionsOpen((v) => !v)}
            style={{
              display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0,
              padding: "6px 10px", background: "none", border: "none",
              color: "var(--text-muted)", cursor: "pointer", fontSize: 11, fontWeight: 600,
              letterSpacing: "0.05em", textTransform: "uppercase", textAlign: "left",
            }}
            title={sessionsOpen ? t("sidebar.hideSessions") : t("sidebar.showSessions")}
          >
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ transform: sessionsOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}>
              <polyline points="3 2 7 5 3 8" />
            </svg>
            {showArchived ? t("sessionActivity.archivedSessions") : t("sessionActivity.activeSessions")}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowArchived((v) => !v);
            }}
            title={showArchived ? t("sessionActivity.showActive") : t("sessionActivity.showArchived")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              height: 22, padding: "0 7px", flexShrink: 0,
              background: showArchived ? "var(--bg-selected)" : "var(--bg-hover)",
              border: "1px solid var(--border)", borderRadius: 5,
              color: showArchived ? "var(--accent)" : "var(--text-dim)",
              cursor: "pointer", fontSize: 10, fontWeight: 600,
            }}
          >
            {showArchived ? t("sessionActivity.showActive") : t("sessionActivity.showArchived")}
          </button>
        </div>
        {sessionsOpen && (
          <div ref={sessionListRef} className="scrollbar-subtle" style={{ flex: 1, overflowY: "auto", padding: "0", minHeight: 0 }}>
            <div style={{ margin: "6px 8px 2px", flexShrink: 0, position: "relative" }}>
              <SessionSearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder={t("sidebar.searchPlaceholder")}
                title={t("sidebar.searchHint")}
                clearLabel={t("sidebar.clearSearch")}
              />
            </div>
            {searchQuery.trim().length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 14px 6px", color: "var(--text-muted)", fontSize: 11 }}>
                <span>{searchLoading ? t("sidebar.searching") : `${t("sidebar.searchResults")} ${visibleSearchResults.length}`}</span>
                {!searchLoading && <SessionSearchMatchFilterSelect value={searchMatchFilter} onChange={setSearchMatchFilter} />}
              </div>
            )}
            {loading && (
              <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>{t("sessionActivity.loading")}</div>
            )}
            {error && (
              <div style={{ padding: "12px 14px", color: "#f87171", fontSize: 12 }}>{error}</div>
            )}
            {!loading && !error && searchQuery.trim().length > 0 && !searchLoading && searchResults && visibleSearchResults.length === 0 && (
              <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
                {t("sidebar.searchNoResults")}
              </div>
            )}
            {!loading && !error && searchQuery.trim().length === 0 && visibleSubagentSessions.length === 0 && (
              <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
                {showArchived ? t("sessionActivity.noArchived") : t("sessionActivity.empty")}
              </div>
            )}
            {!loading && !error && searchQuery.trim().length > 0 && searchResults && visibleSearchResults.length > 0 && (
              <div ref={virtualContentRef}>
                <VirtualizedRows
                  rows={searchVirtualRows}
                  scrollTop={localVirtualScrollTop}
                  viewportHeight={localVirtualViewportHeight}
                  pinnedIds={virtualPinnedIds}
                  onMeasure={updateVirtualRowHeight}
                  renderRow={(row) => row.kind === "session" ? (
                    <SearchResultItem
                      hit={row.session}
                      selected={row.session.id === selectedSessionId}
                      highlighted={row.session.id === highlightedSessionId}
                      onSelect={() => handleSelectSessionFromList(row.session, row.session.contentMatchCount > 0 ? searchQuery.trim() : undefined)}
                      onSessionDeleted={handleSessionDeleted}
                      onChanged={() => setSearchNonce((n) => n + 1)}
                      subprojects={subprojects.filter((subproject) => projectKeysMatch(subproject.projectKey, row.session.projectKey))}
                      onMoveToSubproject={moveSessionToSubproject}
                      onInteractionChange={markVirtualInteraction}
                    />
                  ) : null}
                />
              </div>
            )}
            {searchQuery.trim().length === 0 && !loading && <label style={{ display: "flex", gap: 6, padding: "6px 14px", fontSize: 12 }}>
              <input type="checkbox" checked={groupByWorktree} onChange={event => setGroupByWorktree(event.target.checked)} />
              {t("sessionActivity.groupWorktree")}
            </label>}
            {searchQuery.trim().length === 0 && !loading && (groupByWorktree
              ? <div ref={virtualContentRef}>
                <WorktreeSessionBuckets
                  items={visibleSubagentSessions}
                  sessionOf={session => session}
                  focusSessionId={highlightedSessionId ?? undefined}
                  showProjectPath
                  onNewSession={onNewSession ? (cwd) => onNewSession(`session-${Date.now()}`, cwd) : undefined}
                  mainLabel={t("sessionActivity.worktreeMain")}
                  worktreeLabel={t("sessionActivity.worktreeLinked")}
                  renderItems={rows => rows.map((session) => renderVirtualSession(session, 0, false, false))}
                  virtualization={{
                    scrollTop: virtualViewport.scrollTop,
                    viewportHeight: virtualViewport.viewportHeight,
                    originOffset: virtualOrigin,
                    pinnedIds: virtualPinnedIds,
                    rowHeights: virtualRowHeights,
                    collapsedSessionIds,
                    buildTree: buildWorktreeTree,
                    renderSession: renderVirtualSession,
                    onRowMeasure: updateVirtualRowHeight,
                    onInteractionChange: markVirtualInteraction,
                  }}
                />
              </div>
              : selectedSubprojects.length > 0
              ? <div ref={virtualContentRef}>
                <VirtualizedRows
                  rows={subprojectVirtualRows}
                  scrollTop={localVirtualScrollTop}
                  viewportHeight={localVirtualViewportHeight}
                  pinnedIds={virtualPinnedIds}
                  onMeasure={updateVirtualRowHeight}
                  renderRow={renderVirtualSubprojectRow}
                />
              </div>
              : <div ref={virtualContentRef}>
                <VirtualizedRows
                  rows={treeVirtualRows}
                  scrollTop={localVirtualScrollTop}
                  viewportHeight={localVirtualViewportHeight}
                  pinnedIds={virtualPinnedIds}
                  onMeasure={updateVirtualRowHeight}
                  renderRow={(row) => row.kind === "session" ? renderVirtualSession(row.session, row.depth, row.hasChildren, row.collapsed) : null}
                />
              </div>)}
          </div>
        )}
      </div>
      )}

      {/* File Explorer section */}
      {(selectedCwdProp || selectedCwd) && explorerOpen && (
        <div
          style={{
            borderTop: readerMode ? "none" : "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            flex: explorerOpen ? "1 1 0" : "0 0 auto",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <ExplorerSection
            t={t}
            readerMode={readerMode}
            open={explorerOpen}
            filePanelOpen={filePanelOpen}
            cwd={selectedCwd ?? selectedCwdProp!}
            onEnsureOpen={() => setExplorerOpen(true)}
            leadingControl={reservedLeadingControl ?? explorerLeadingControl}
            folderControl={folderControl}
            showSessionToggle={!readerMode && !compactReaderMode}
            sessionsOpen={sessionsOpen}
            onToggleSessions={() => setSessionsOpen((v) => !v)}
            onOpenFile={onOpenFile ?? (() => {})}
            onPathRenamed={onPathRenamed}
            activeFilePath={activeFilePath}
            externalRefreshKey={explorerRefreshKey}
            onRefresh={onExplorerRefresh}
            onAtMention={onAtMention}
            onAtMentions={onAtMentions}
          />
        </div>
      )}
      {subagentContextMenu && (
        <SubagentVisibilityMenu
          position={{ x: subagentContextMenu.x, y: subagentContextMenu.y }}
          visible={visibleSubagentParentIds.has(subagentContextMenu.id)}
          onToggle={() => setSubagentVisibility(subagentContextMenu.id, !visibleSubagentParentIds.has(subagentContextMenu.id))}
          onClose={() => setSubagentContextMenu(null)}
          label={visibleSubagentParentIds.has(subagentContextMenu.id) ? t("sidebar.hideSubagents") : t("sidebar.showSubagents")}
        />
      )}
    </div>
  );
}

function SessionTreeItem({
  node,
  selectedSessionId,
  highlightedSessionId,
  runningSessionIds,
  unreadSessionIds,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  onSessionArchived,
  depth,
  subprojects = [],
  onMoveToSubproject,
  controlledCollapsed,
  onInteractionChange,
  onToggleCollapse,
  virtualized = false,
  hasChildrenOverride,
  hasSubagentChildren = () => false,
  subagentsVisible = () => false,
  onSubagentContextMenu,
}: {
  node: SessionTreeNode;
  selectedSessionId: string | null;
  highlightedSessionId?: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  onSessionArchived?: (id: string) => void;
  depth: number;
  subprojects?: SubprojectDefinition[];
  onMoveToSubproject?: (session: SessionInfo, subprojectId: string | null) => Promise<boolean>;
  controlledCollapsed?: boolean;
  onInteractionChange?: (id: string, active: boolean) => void;
  onToggleCollapse?: () => void;
  virtualized?: boolean;
  hasChildrenOverride?: boolean;
  hasSubagentChildren?: (sessionId: string) => boolean;
  subagentsVisible?: (sessionId: string) => boolean;
  onSubagentContextMenu?: (id: string, clientX: number, clientY: number) => void;
}) {
  const [localCollapsed, setLocalCollapsed] = useState(false);
  const collapsed = controlledCollapsed ?? localCollapsed;
  const hasChildren = hasChildrenOverride ?? node.children.length > 0;

  return (
    <div>
      <div style={{ position: "relative" }}>
        {/* Indent line for child sessions */}
        {depth > 0 && (
          <div style={{
            position: "absolute",
            left: depth * 12 + 6,
            top: 0, bottom: 0,
            width: 1,
            background: "color-mix(in srgb, var(--text-dim) 28%, transparent)",
            pointerEvents: "none",
          }} />
        )}
        <SessionItem
          session={node.session}
          isSelected={node.session.id === selectedSessionId}
          isHighlighted={node.session.id === highlightedSessionId}
          isRunning={runningSessionIds.has(node.session.id)}
          isUnread={unreadSessionIds.has(node.session.id)}
          onClick={() => onSelectSession(node.session)}
          onRenamed={onRenamed}
          onDeleted={(id) => onSessionDeleted?.(id)}
          onArchived={(id) => onSessionArchived?.(id)}
          depth={depth}
          hasChildren={hasChildren}
          hasSubagentChildren={hasSubagentChildren(node.session.id)}
          subagentsVisible={subagentsVisible(node.session.id)}
          onSubagentContextMenu={onSubagentContextMenu}
          collapsed={collapsed}
          onToggleCollapse={() => {
            if (onToggleCollapse) onToggleCollapse();
            else if (controlledCollapsed === undefined) setLocalCollapsed((v) => !v);
          }}
          onInteractionChange={onInteractionChange}
          subprojects={subprojects}
          onMoveToSubproject={onMoveToSubproject}
        />
      </div>
      {hasChildren && !collapsed && !virtualized && (
        <div>
          {node.children.map((child) => (
            <SessionTreeItem
              key={child.session.id}
              node={child}
              selectedSessionId={selectedSessionId}
              highlightedSessionId={highlightedSessionId}
              runningSessionIds={runningSessionIds}
              unreadSessionIds={unreadSessionIds}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              onSessionArchived={onSessionArchived}
              depth={depth + 1}
              subprojects={subprojects}
              onMoveToSubproject={onMoveToSubproject}
              hasSubagentChildren={hasSubagentChildren}
              subagentsVisible={subagentsVisible}
              onSubagentContextMenu={onSubagentContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}


/**
 * Compact per-project activity badges for the workspace selector dropdown items:
 * a spinning running icon + count and an unread dot + count. Renders nothing
 * when the project has no activity. Counts share the accent / unread colors of
 * the per-session indicators so the two stay visually consistent.
 */
function showProjectActivity(
  activity: { running: number; unread: number } | undefined,
  t: (key: string) => string,
): ReactNode {
  if (!activity || (activity.running === 0 && activity.unread === 0)) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, marginLeft: 6 }}>
      {activity.running > 0 && (
        <span
          title={t("sidebar.agentRunning")}
          aria-label={`${t("sidebar.agentRunning")} (${activity.running})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--accent)", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
            <g>
              <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
            </g>
          </svg>
          {activity.running}
        </span>
      )}
      {activity.unread > 0 && (
        <span
          title={t("sidebar.newSessionActivity")}
          aria-label={`${t("sidebar.newSessionActivity")} (${activity.unread})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "#0891b2", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
          {activity.unread}
        </span>
      )}
    </span>
  );
}

function SessionItem({
  session,
  isSelected,
  isHighlighted,
  isRunning,
  isUnread,
  onClick,
  onRenamed,
  onDeleted,
  onArchived,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
  subprojects = [],
  onMoveToSubproject,
  onInteractionChange,
  hasSubagentChildren = false,
  subagentsVisible = false,
  onSubagentContextMenu,
}: {
  session: SessionInfo;
  isSelected: boolean;
  isHighlighted?: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  onArchived?: (id: string) => void;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  subprojects?: SubprojectDefinition[];
  onMoveToSubproject?: (session: SessionInfo, subprojectId: string | null) => Promise<boolean>;
  onInteractionChange?: (id: string, active: boolean) => void;
  hasSubagentChildren?: boolean;
  subagentsVisible?: boolean;
  onSubagentContextMenu?: (id: string, clientX: number, clientY: number) => void;
}) {
  const { t } = useI18n();
  const hover = useSessionHover();
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onInteractionChange?.(
      session.id,
      renaming || confirmDelete || deleting || archiving || Boolean(deleteError || archiveError || renameError),
    );
  }, [archiveError, archiving, confirmDelete, deleteError, deleting, onInteractionChange, renameError, renaming, session.id]);

  // Select the whole name once the rename input is mounted (startRename's
  // immediate setTimeout can fire before the input exists).
  useEffect(() => {
    if (renaming) {
      const id = requestAnimationFrame(() => inputRef.current?.select());
      return () => cancelAnimationFrame(id);
    }
  }, [renaming]);

  const title = sessionDisplayTitle(session, 50);
  const lifecycleManagedByParent = session.relation?.kind === "subagent";
  const pointerDrag = useSessionSubprojectPointerDrag({
    projectKey: session.projectKey,
    disabled: session.transient || !onMoveToSubproject,
    onMove: (subprojectId) => onMoveToSubproject ? onMoveToSubproject(session, subprojectId) : Promise.resolve(false),
  });

  const startRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (session.transient) return;
    setRenameError(null);
    setRenameValue(session.name || title);
    setRenaming(true);
  }, [session.name, session.transient, title]);

  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    setRenaming(false);
    // No-op when unchanged: the fallback title (first message / id) isn't a
    // real stored name, so don't persist it as one. The rename input uses the
    // same compact title, so a skill-invoked session stays a no-op when untouched.
    if (renameValue === title || name === (session.name ?? "")) return;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        // A rejected rename (another Reader owns the session, the file is
        // gone, ...) must not look like success in the sidebar.
        const body = await response.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(typeof body?.error === "string" ? body.error : `Rename failed (${response.status})`);
      }
      setRenameError(null);
      onRenamed?.();
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error));
    }
  }, [renameValue, session.id, session.name, onRenamed, title]);

  const performDelete = useCallback(async () => {
    if (session.transient || lifecycleManagedByParent) return;
    setConfirmDelete(false);
    setDeleteError(null);
    setDeleting(true);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      await assertSessionMutationOk(response);
      clearSessionActivityCache();
      onDeleted?.(session.id);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
      setDeleting(false);
    }
  }, [lifecycleManagedByParent, session.id, session.transient, onDeleted]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (lifecycleManagedByParent) return;
    if (e.shiftKey) {
      void performDelete();
    } else {
      setConfirmDelete(true);
    }
  }, [lifecycleManagedByParent, performDelete]);

  const handleDeleteConfirm = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    void performDelete();
  }, [performDelete]);

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

  const handleArchiveClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (archiving || lifecycleManagedByParent) return;
    setArchiveError(null);
    setArchiving(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: !session.archived }),
      });
      await assertSessionMutationOk(res);
      clearSessionActivityCache();
      onArchived?.(session.id);
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : String(error));
    } finally {
      setArchiving(false);
    }
  }, [lifecycleManagedByParent, session.id, session.archived, onArchived, archiving]);

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (hasSubagentChildren && onSubagentContextMenu) {
      e.preventDefault();
      e.stopPropagation();
      onSubagentContextMenu(session.id, e.clientX, e.clientY);
      return;
    }
    const handled = dispatchSessionRowContextMenu({
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name,
      clientX: e.clientX,
      clientY: e.clientY,
      refresh: () => { onRenamed?.(); },
    });
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
  }, [hasSubagentChildren, onRenamed, onSubagentContextMenu, session.cwd, session.id, session.name, session.path]);

  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  const ITEM_HEIGHT = 54;
  const archiveTitle = archiveError ?? (lifecycleManagedByParent ? t("sessionActivity.subagentLifecycleRequiresParent") : isRunning ? "Stop the agent before archiving" : (session.archived ? "Unarchive" : "Archive"));

  return (
    <div
      onPointerDown={pointerDrag.onPointerDown}
      onPointerMove={pointerDrag.onPointerMove}
      onPointerUp={pointerDrag.onPointerUp}
      onPointerCancel={pointerDrag.onPointerCancel}
      onClickCapture={pointerDrag.onClickCapture}
      onClick={confirmDelete || renaming ? undefined : () => { setArchiveError(null); setDeleteError(null); onClick(); }}
      onContextMenu={confirmDelete || renaming ? undefined : handleContextMenu}
      data-talk-map-highlighted={isHighlighted ? "true" : undefined}
      ref={rowRef}
      onMouseEnter={hover.enter}
      onMouseLeave={hover.leave}
      style={{
        height: ITEM_HEIGHT,
        display: "flex",
        alignItems: "center",
        paddingLeft: depth > 0 ? depth * 12 + 14 : 14,
        paddingRight: 8,
        cursor: pointerDrag.dragging ? "grabbing" : confirmDelete || renaming ? "default" : "pointer",
        background: confirmDelete
          ? "rgba(239,68,68,0.06)"
          : isHighlighted || isSelected ? "var(--bg-selected)" : hover.hovered ? "var(--bg-hover)" : "transparent",
        borderLeft: confirmDelete
          ? "2px solid #ef4444"
          : isHighlighted || isSelected ? "2px solid var(--accent)" : "2px solid transparent",
        transition: "background 0.1s",
        opacity: pointerDrag.dragging || deleting || archiving ? 0.5 : 1,
        gap: 6,
        overflow: "hidden",
      }}
    >
      {confirmDelete ? (
        /* ── Delete confirmation: same height, two flat buttons ── */
        <>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("sidebar.deleteSession", { title: title.slice(0, 22) + (title.length > 22 ? "…" : "") })}
          </div>
          <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
            <button
              onClick={handleDeleteConfirm}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                height: 30, padding: "0 11px",
                background: "#ef4444", border: "none",
                borderRadius: 6, color: "#fff",
                cursor: "pointer", fontSize: 12, fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              {t("sidebar.delete")}
            </button>
            <button
              onClick={handleDeleteCancel}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                height: 30, padding: "0 11px",
                background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 6, color: "var(--text-muted)",
                cursor: "pointer", fontSize: 12, fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              {t("sidebar.cancel")}
            </button>
          </div>
        </>
      ) : renaming ? (
        /* ── Rename: input fills the same row ── */
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          style={{
            flex: 1,
            fontSize: 12,
            padding: "5px 8px",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
            height: 30,
          }}
        />
      ) : (
        /* ── Normal view ── */
        <>
          {session.contextSourceSessionId && (
            <span title={t("sessionActivity.contextInjectedSession")} style={{ display: "inline-flex", flexShrink: 0 }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label={t("sessionActivity.contextInjectedSession")} style={{ opacity: 0.85 }}>
                <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.07 0l-3 3A5 5 0 0 0 9 21l1.71-1.71" />
              </svg>
            </span>
          )}
          {session.relation?.kind === "subagent" ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label={t("sidebar.subagent")} style={{ flexShrink: 0 }}>
              <rect x="5" y="7" width="14" height="11" rx="2" />
              <path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
            </svg>
          ) : (session.parentSessionId || (!session.contextSourceSessionId && depth > 0)) ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label={t("sessionActivity.forkedSession")} style={{ flexShrink: 0 }}>
              <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          ) : null}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                minWidth: 0,
                fontSize: 12,
                fontWeight: isHighlighted || isSelected ? 500 : 400,
                lineHeight: 1.4,
                color: "var(--text)",
              }}
              title={title}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {title}
              </span>
              {(archiveError || deleteError || renameError) && <span role="alert" title={archiveError ?? deleteError ?? renameError ?? undefined} aria-label={archiveError ?? deleteError ?? renameError ?? undefined} style={{ color: "#dc2626", fontSize: 11, fontWeight: 700, flexShrink: 0, cursor: "help" }}>!</span>}
            </div>
            <SessionListMeta session={session} isRunning={isRunning} isUnread={isUnread} />
          </div>

          {/* Collapse toggle — always visible when has children */}
          {hasChildren && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
              title={collapsed ? t("sidebar.expandForks") : t("sidebar.collapseForks")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, padding: 0, flexShrink: 0,
                background: "none", border: "none",
                color: "var(--text-dim)", cursor: "pointer",
                transform: collapsed ? "rotate(-90deg)" : "none",
                transition: "transform 0.15s",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          )}

          {/* Action buttons — shown on hover */}
          {hover.hovered && !session.transient && (
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              {onMoveToSubproject && <SessionSubprojectMenu subprojects={subprojects} currentSubprojectId={session.subprojectId} onMove={(subprojectId) => onMoveToSubproject(session, subprojectId)} />}
              <button
                onClick={startRename}
                title={t("sidebar.rename")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 7, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s, border-color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-selected)";
                  e.currentTarget.style.color = "var(--accent)";
                  e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.borderColor = "var(--border)";
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
              <button
                onClick={handleArchiveClick}
                disabled={isRunning || lifecycleManagedByParent}
                title={archiveTitle}
                aria-label={archiveTitle}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 7, color: "var(--text-muted)",
                  cursor: isRunning || lifecycleManagedByParent ? "default" : "pointer", flexShrink: 0,
                  opacity: isRunning || lifecycleManagedByParent ? 0.5 : 1,
                  transition: "background 0.12s, color 0.12s, border-color 0.12s",
                }}
                onMouseEnter={(e) => {
                  if (isRunning || lifecycleManagedByParent) return;
                  e.currentTarget.style.background = "var(--bg-selected)";
                  e.currentTarget.style.color = "var(--accent)";
                  e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.borderColor = "var(--border)";
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="21 8 21 21 3 21 3 8" />
                  <rect x="1" y="3" width="22" height="5" />
                  <line x1="10" y1="12" x2="14" y2="12" />
                </svg>
              </button>
              <button
                onClick={handleDeleteClick}
                disabled={lifecycleManagedByParent}
                title={lifecycleManagedByParent ? t("sessionActivity.subagentLifecycleRequiresParent") : t("sidebar.deleteWithShiftClick")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 7, color: "var(--text-muted)",
                  cursor: lifecycleManagedByParent ? "default" : "pointer", flexShrink: 0,
                  opacity: lifecycleManagedByParent ? 0.5 : 1,
                  transition: "background 0.12s, color 0.12s, border-color 0.12s",
                }}
                onMouseEnter={(e) => {
                  if (lifecycleManagedByParent) return;
                  e.currentTarget.style.background = "rgba(239,68,68,0.08)";
                  e.currentTarget.style.color = "#ef4444";
                  e.currentTarget.style.borderColor = "rgba(239,68,68,0.35)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.borderColor = "var(--border)";
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            </div>
          )}
        </>
      )}
      <SessionHoverPreview
        sessionId={session.id}
        version={session.modified}
        session={session}
        isRunning={isRunning}
        isUnread={isUnread}
        anchorRef={rowRef}
        visible={hover.hovered && !confirmDelete && !renaming && !session.transient}
        onMouseEnter={hover.enter}
        onMouseLeave={hover.leave}
        onDismiss={hover.dismiss}
      />
    </div>
  );
}

function SearchResultItem({
  hit,
  selected,
  highlighted,
  onSelect,
  onSessionDeleted,
  onChanged,
  subprojects = [],
  onMoveToSubproject,
  onInteractionChange,
}: {
  hit: SessionSearchResult;
  selected: boolean;
  highlighted?: boolean;
  onSelect: () => void;
  onSessionDeleted?: (id: string) => void;
  onChanged: () => void;
  subprojects?: SubprojectDefinition[];
  onMoveToSubproject?: (session: SessionInfo, subprojectId: string | null) => Promise<boolean>;
  onInteractionChange?: (id: string, active: boolean) => void;
}) {
  const { t } = useI18n();
  const hover = useSessionHover();
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    onInteractionChange?.(hit.id, renaming || confirmDelete || busy || Boolean(archiveError));
  }, [archiveError, busy, confirmDelete, hit.id, onInteractionChange, renaming]);
  // Same title source as SessionTreeItem rows.
  const title = hit.name?.trim() || hit.firstMessage?.trim().split("\n")[0]?.slice(0, 50) || hit.id.slice(0, 12);
  const lifecycleManagedByParent = hit.relation?.kind === "subagent";
  const archiveTitle = archiveError ?? (lifecycleManagedByParent ? t("sessionActivity.subagentLifecycleRequiresParent") : (hit.archived ? "Unarchive" : "Archive"));
  const searchLabels = sessionSearchResultSources(hit).map((source) => source === "content"
    ? t("sessionActivity.searchContentMatch", { count: hit.contentMatchCount })
    : source === "title"
      ? t("sessionActivity.searchTitleMatch", { count: hit.titleMatchCount ?? 0 })
      : t("sessionActivity.searchIdMatch"));
  const searchLabelText = searchLabels.join(" · ");

  const commitRename = async () => {
    const name = renameValue.trim();
    setRenaming(false);
    if (!name || name === (hit.name ?? "")) return;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(hit.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) onChanged();
    } catch {
      // ignore
    }
  };

  const archive = async () => {
    if (busy || lifecycleManagedByParent) return;
    setArchiveError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(hit.id)}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: !hit.archived }),
      });
      await assertSessionMutationOk(res);
      onChanged();
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy || lifecycleManagedByParent) return;
    setConfirmDelete(false);
    setArchiveError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(hit.id)}`, { method: "DELETE" });
      await assertSessionMutationOk(res);
      clearSessionActivityCache();
      onSessionDeleted?.(hit.id);
      onChanged();
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={rowRef}
      onMouseEnter={hover.enter}
      onMouseLeave={hover.leave}
      style={{
        padding: "6px 10px",
        borderBottom: "1px solid var(--border)",
        background: confirmDelete ? "rgba(239,68,68,0.06)" : highlighted || selected ? "var(--bg-selected)" : hover.hovered ? "var(--bg-hover)" : "transparent",
        borderLeft: highlighted ? "2px solid var(--accent)" : "2px solid transparent",
        opacity: busy ? 0.55 : 1,
      }}
    >
      {confirmDelete ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("sidebar.deleteSession", { title: title.slice(0, 22) + (title.length > 22 ? "…" : "") })}
          </span>
          <button
            onClick={remove}
            style={{ padding: "4px 10px", background: "#ef4444", border: "none", borderRadius: 5, color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
          >
            {t("sidebar.delete")}
          </button>
          <button
            onClick={() => setConfirmDelete(false)}
            style={{ padding: "4px 10px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", fontSize: 11, cursor: "pointer", flexShrink: 0 }}
          >
            {t("sidebar.cancel")}
          </button>
        </div>
      ) : renaming ? (
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          style={{
            flex: 1,
            width: "100%",
            fontSize: 11,
            padding: "4px 8px",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
            boxSizing: "border-box",
          }}
        />
      ) : (
        <>
          <button
            onClick={() => { setArchiveError(null); onSelect(); }}
            title={title}
            style={{
              display: "block",
              width: "100%",
              background: "none",
              border: "none",
              padding: 0,
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, color: selected ? "var(--accent)" : "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
              {archiveError && <span role="alert" title={archiveError} aria-label={archiveError} style={{ color: "#dc2626", fontSize: 11, fontWeight: 700, flexShrink: 0, cursor: "help" }}>!</span>}
            </div>
            {searchLabels.length > 0 && <div title={searchLabelText} style={{ marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--accent)", fontSize: 9 }}>{searchLabelText}</div>}
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {searchLabels.length === 0 && <>{t("sidebar.searchMatches", { count: hit.matchCount })} · </>}{relativeTime(hit.activityAt ?? hit.modified)}
            </div>
          </button>
          {hover.hovered && (
            <div style={{ display: "flex", gap: 4, marginTop: 4, flexShrink: 0 }}>
              {onMoveToSubproject && !hit.transient && <SessionSubprojectMenu subprojects={subprojects} currentSubprojectId={hit.subprojectId} onMove={(subprojectId) => onMoveToSubproject(hit, subprojectId)} onMoved={onChanged} />}

              <button
                title={t("sidebar.rename")}
                aria-label={t("sidebar.rename")}
                onClick={(e) => { e.stopPropagation(); setRenameValue(hit.name ?? ""); setRenaming(true); setTimeout(() => inputRef.current?.select(), 0); }}
                style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer" }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
              </button>
              <button
                title={archiveTitle}
                aria-label={archiveTitle}
                disabled={lifecycleManagedByParent}
                onClick={(e) => { e.stopPropagation(); void archive(); }}
                style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text-muted)", cursor: lifecycleManagedByParent ? "default" : "pointer", opacity: lifecycleManagedByParent ? 0.5 : 1 }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="21 8 21 21 3 21 3 8" /><rect x="1" y="3" width="22" height="5" /><line x1="10" y1="12" x2="14" y2="12" /></svg>
              </button>
              <button
                title={lifecycleManagedByParent ? t("sessionActivity.subagentLifecycleRequiresParent") : t("sidebar.delete")}
                aria-label={lifecycleManagedByParent ? t("sessionActivity.subagentLifecycleRequiresParent") : t("sidebar.delete")}
                disabled={lifecycleManagedByParent}
                onClick={(e) => { e.stopPropagation(); if (!lifecycleManagedByParent) setConfirmDelete(true); }}
                style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "#ef4444", cursor: lifecycleManagedByParent ? "default" : "pointer", opacity: lifecycleManagedByParent ? 0.5 : 1 }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
              </button>
            </div>
          )}
        </>
      )}
      <SessionHoverPreview
        sessionId={hit.id}
        version={hit.activityAt ?? hit.modified}
        session={hit}
        anchorRef={rowRef}
        visible={hover.hovered && !confirmDelete && !renaming && !hit.transient}
        onMouseEnter={hover.enter}
        onMouseLeave={hover.leave}
        onDismiss={hover.dismiss}
      />
    </div>
  );
}

function relativeTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "-";
  const deltaSeconds = Math.round((Date.now() - timestamp) / 1000);
  const abs = Math.abs(deltaSeconds);
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 60) return fmt.format(deltaSeconds >= 0 ? -Math.max(1, abs) : Math.max(1, abs), "second");
  if (abs < 3600) return fmt.format(deltaSeconds >= 0 ? -Math.round(abs / 60) : Math.round(abs / 60), "minute");
  if (abs < 86400) return fmt.format(deltaSeconds >= 0 ? -Math.round(abs / 3600) : Math.round(abs / 3600), "hour");
  if (abs < 7 * 86400) return fmt.format(deltaSeconds >= 0 ? -Math.round(abs / 86400) : Math.round(abs / 86400), "day");
  return new Date(timestamp).toLocaleDateString();
}
