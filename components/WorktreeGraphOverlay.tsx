"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  GitBranch,
  GitFork,
  GitMerge,
  MessageSquarePlus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { apiPathForPeer } from "@/lib/file-api";
import { copyText } from "@/lib/clipboard";
import { shortenPath } from "@/lib/display-path";
import { fetchSessionActivity } from "@/lib/session-activity-fetch";
import type { SessionActivityItem, SessionActivityResponse } from "@/lib/session-activity-types";
import { listSessionFamilies } from "@/lib/session-family";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { notifyEmbeddedModalState } from "@/lib/embedded-modal";
import { sessionActivityStatusColor } from "./SessionActivityMeta";
import {
  buildWorktreeNodePrompt,
  WORKTREE_LANE_COLORS,
  worktreeLaneColor,
  worktreeNeedsAttention,
  type WorktreeGraph,
  type WorktreeGraphItem,
  type WorktreeInspection,
} from "@/lib/worktree-graph-types";

interface Props {
  open: boolean;
  projectRoot: string | null;
  deviceName?: string | null;
  currentWorktreePath?: string | null;
  currentSessionId?: string | null;
  remotePeer?: string;
  onClose: () => void;
  onSwitchWorktree?: (path: string) => void;
  onOpenSession: (sessionId: string, worktreePath: string) => void;
  onNewSessionFromNode: (worktree: WorktreeGraphItem, initialPrompt: string) => void;
}

type FilterTab = "attention" | "all" | "active" | "at_base";

type WorktreeAssociationRelation = "cwd" | "creator" | "task-root";

interface WorktreeCreationHistory {
  records: Array<{ worktreePath: string; sessionId: string; createdAt: string; sessionName?: string }>;
  bindings?: Array<{ worktreePath: string; sessionId: string; relation: "creator" | "task-root"; createdAt: string; sessionName?: string }>;
  partial: boolean;
}

interface WorktreeAssociatedSession {
  id: string;
  title: string;
  status?: SessionActivityItem["status"];
  relations: WorktreeAssociationRelation[];
}

function GitHubIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

function shortPath(fullPath: string, root: string | null): string {
  if (!root || fullPath === root) return shortenPath(fullPath);
  if (fullPath.startsWith(root)) {
    const rel = fullPath.slice(root.length).replace(/^[/\\]+/, "");
    if (!rel) return shortenPath(fullPath);
    return rel.startsWith(".") ? rel : `./${rel}`;
  }
  return shortenPath(fullPath);
}

function formatDate(isoOrTs: string | number, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (!isoOrTs) return "";
  const d = typeof isoOrTs === "number" ? new Date(isoOrTs > 1e11 ? isoOrTs : isoOrTs * 1000) : new Date(isoOrTs);
  if (Number.isNaN(d.getTime())) return String(isoOrTs);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return t("worktreeGraph.timeJustNow");
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t("worktreeGraph.timeMinutesAgo", { count: diffMin });
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return t("worktreeGraph.timeHoursAgo", { count: diffHour });
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return t("worktreeGraph.timeDaysAgo", { count: diffDay });
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatFullDate(isoOrTs: string | number): string {
  if (!isoOrTs) return "";
  const d = typeof isoOrTs === "number" ? new Date(isoOrTs > 1e11 ? isoOrTs : isoOrTs * 1000) : new Date(isoOrTs);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

function normalizeWorktreePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

function sameWorktreePath(left: string, right: string): boolean {
  return normalizeWorktreePath(left) === normalizeWorktreePath(right);
}

export function preferredWorktreePath(
  worktrees: readonly WorktreeGraphItem[],
  currentWorktreePath: string | null | undefined,
  currentSessionId: string | null | undefined,
  history: WorktreeCreationHistory | null,
): string | null {
  const historyMatches = (history?.records ?? [])
    .filter((record) => record.sessionId === currentSessionId)
    .map((record) => worktrees.find((worktree) => sameWorktreePath(worktree.path, record.worktreePath)))
    .filter((worktree): worktree is WorktreeGraphItem => Boolean(worktree));
  return historyMatches.find((worktree) => !worktree.isMain)?.path
    ?? historyMatches[0]?.path
    ?? worktrees.find((worktree) => currentWorktreePath && sameWorktreePath(worktree.path, currentWorktreePath))?.path
    ?? null;
}

function associatedSessionTitle(session: SessionActivityItem["session"]): string {
  return session.name?.trim() || session.firstMessage?.trim().split("\n")[0]?.slice(0, 100) || session.id;
}

function addAssociationRelation(item: WorktreeAssociatedSession, relation: WorktreeAssociationRelation): void {
  if (!item.relations.includes(relation)) item.relations.push(relation);
}

export function mergeAssociatedWorktreeSessions(
  selectedPath: string | null,
  sessions: readonly SessionActivityItem[],
  history: WorktreeCreationHistory | null,
): WorktreeAssociatedSession[] {
  if (!selectedPath) return [];
  const sessionsById = new Map(sessions.map((item) => [item.session.id, item]));
  const ownerBySessionId = new Map<string, SessionActivityItem>();
  for (const family of listSessionFamilies(sessions.map((item) => item.session))) {
    const owner = sessionsById.get(family.root.id);
    if (!owner) continue;
    ownerBySessionId.set(owner.session.id, owner);
    for (const subagent of family.subagents) ownerBySessionId.set(subagent.id, owner);
  }
  const associated = new Map<string, WorktreeAssociatedSession>();
  const ensure = (sessionId: string, title: string, status: SessionActivityItem["status"] | undefined, relation: WorktreeAssociationRelation) => {
    const existing = associated.get(sessionId);
    if (existing) {
      addAssociationRelation(existing, relation);
      if (existing.status === undefined && status !== undefined) existing.status = status;
      return;
    }
    associated.set(sessionId, { id: sessionId, title, ...(status ? { status } : {}), relations: [relation] });
  };
  const ensureActivityOwner = (activity: SessionActivityItem, relation: WorktreeAssociationRelation) => {
    const owner = ownerBySessionId.get(activity.session.id);
    if (!owner) return;
    ensure(owner.session.id, associatedSessionTitle(owner.session), owner.status, relation);
  };
  for (const item of sessions) {
    if (sameWorktreePath(item.session.cwd, selectedPath)) ensureActivityOwner(item, "cwd");
  }
  for (const record of history?.records ?? []) {
    if (!sameWorktreePath(record.worktreePath, selectedPath)) continue;
    const activity = sessionsById.get(record.sessionId);
    if (activity) {
      ensureActivityOwner(activity, "creator");
    } else {
      ensure(record.sessionId, record.sessionName || record.sessionId, undefined, "creator");
    }
  }
  for (const record of history?.bindings ?? []) {
    if (!sameWorktreePath(record.worktreePath, selectedPath)) continue;
    const activity = sessionsById.get(record.sessionId);
    if (activity) {
      ensureActivityOwner(activity, "task-root");
    } else {
      ensure(record.sessionId, record.sessionName || record.sessionId, undefined, "task-root");
    }
  }
  return [...associated.values()];
}

function associationRelationLabel(
  relation: WorktreeAssociationRelation,
  translate: (key: string) => string,
): string {
  switch (relation) {
    case "cwd": return translate("worktreeGraph.relationCwd");
    case "creator": return translate("worktreeGraph.relationCreator");
    case "task-root": return translate("worktreeGraph.relationTaskRoot");
  }
}

function worktreeSourceLabel(
  sourceKind: WorktreeGraphItem["sourceKind"],
  translate: (key: string) => string,
): string {
  switch (sourceKind) {
    case "main": return translate("worktreeGraph.sourceMain");
    case "integration": return translate("worktreeGraph.sourceIntegration");
    case "task": return translate("worktreeGraph.sourceTask");
    case "devspace": return translate("worktreeGraph.sourceDevspace");
    default: return translate("worktreeGraph.sourceWorktree");
  }
}

function newSessionLabel(
  worktree: WorktreeGraphItem,
  translate: (key: string) => string,
): string {
  return translate(worktree.isMain ? "worktreeGraph.newSessionFromMain" : "worktreeGraph.newSessionFromWorktree");
}

export const WORKTREE_GRAPH_GEOMETRY = {
  timelinePaddingLeft: 12,
  spineLeft: 20,
  spineWidth: 2,
  headSize: 12,
  commitSize: 10,
  statusMarkerLeft: 8,
} as const;

// Node markers are positioned inside the node wrapper, which starts after the
// timeline's left padding. Compute their left edge from the rail center so the
// declared border-box width stays centered if the rail geometry changes.
export function getWorktreeGraphMarkerLeft(size: number): number {
  return WORKTREE_GRAPH_GEOMETRY.spineLeft
    + WORKTREE_GRAPH_GEOMETRY.spineWidth / 2
    - WORKTREE_GRAPH_GEOMETRY.timelinePaddingLeft
    - size / 2;
}

export function WorktreeGraphOverlay({
  open,
  projectRoot,
  deviceName,
  currentWorktreePath,
  currentSessionId,
  remotePeer,
  onClose,
  onSwitchWorktree,
  onOpenSession,
  onNewSessionFromNode,
}: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [graph, setGraph] = useState<WorktreeGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filterTab, setFilterTab] = useState<FilterTab>("attention");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [collapsedNodes, setCollapsedNodes] = useState<Record<string, boolean>>({});
  const [inspection, setInspection] = useState<WorktreeInspection | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [associatedSessions, setAssociatedSessions] = useState<SessionActivityItem[]>([]);
  const [associatedSessionsLoading, setAssociatedSessionsLoading] = useState(false);
  const [associatedSessionsError, setAssociatedSessionsError] = useState<string | null>(null);
  const [associatedSessionsRefreshKey, setAssociatedSessionsRefreshKey] = useState(0);
  const [creationHistory, setCreationHistory] = useState<WorktreeCreationHistory | null>(null);
  const [creationHistoryLoading, setCreationHistoryLoading] = useState(false);
  const [creationHistoryError, setCreationHistoryError] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const graphRequestRef = useRef(0);
  const sessionRequestRef = useRef(0);
  const creationHistoryRequestRef = useRef(0);
  const selectionManuallySetRef = useRef(false);

  useEffect(() => {
    setGraph(null);
    setFilterTab("attention");
    setSearch("");
    setSelectedPath(null);
    setInspection(null);
    setAssociatedSessions([]);
    setAssociatedSessionsError(null);
    setAssociatedSessionsLoading(false);
    setCreationHistory(null);
    setCreationHistoryError(false);
    setCreationHistoryLoading(false);
    setError(null);
    selectionManuallySetRef.current = false;
  }, [projectRoot, remotePeer]);

  useEffect(() => {
    if (!open) return;
    notifyEmbeddedModalState(true, "talk-map");
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      notifyEmbeddedModalState(false, "talk-map");
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  const fetchGraph = useCallback(
    async (forceRefresh = false) => {
      if (!projectRoot) return;
      const requestId = graphRequestRef.current + 1;
      graphRequestRef.current = requestId;
      setLoading(true);
      setError(null);
      try {
        const query = new URLSearchParams({
          cwd: projectRoot,
          graph: "1",
          ...(forceRefresh ? { refresh: "1" } : {}),
        });
        const url = apiPathForPeer(remotePeer, `worktrees?${query.toString()}`);
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const data = (await res.json()) as { graph?: WorktreeGraph; error?: string };
        if (data.error) throw new Error(data.error);
        if (requestId !== graphRequestRef.current) return;
        if (data.graph) {
          setGraph(data.graph);
        } else {
          setGraph(null);
          setSelectedPath(null);
        }
      } catch (err) {
        if (requestId === graphRequestRef.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (requestId === graphRequestRef.current) setLoading(false);
      }
    },
    [projectRoot, remotePeer],
  );

  useEffect(() => {
    if (open && projectRoot) {
      void fetchGraph(false);
    }
  }, [open, projectRoot, fetchGraph]);

  const fetchAssociatedSessions = useCallback(async () => {
    if (!open || !projectRoot) return;
    const requestId = sessionRequestRef.current + 1;
    sessionRequestRef.current = requestId;
    setAssociatedSessionsLoading(true);
    setAssociatedSessionsError(null);
    try {
      const data = await fetchSessionActivity<SessionActivityResponse>(
        apiPathForPeer(remotePeer, "session-runs?scope=local"),
        { force: true },
      );
      if (requestId !== sessionRequestRef.current) return;
      setAssociatedSessions(data.sessions);
    } catch (err) {
      if (requestId !== sessionRequestRef.current) return;
      setAssociatedSessions([]);
      setAssociatedSessionsError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === sessionRequestRef.current) setAssociatedSessionsLoading(false);
    }
  }, [open, projectRoot, remotePeer]);

  useEffect(() => {
    if (!open || !projectRoot) {
      setAssociatedSessions([]);
      setAssociatedSessionsError(null);
      setAssociatedSessionsLoading(false);
      return;
    }
    void fetchAssociatedSessions();
  }, [associatedSessionsRefreshKey, fetchAssociatedSessions, open, projectRoot]);

  const fetchCreationHistory = useCallback(async () => {
    if (!open || !projectRoot) return;
    const requestId = ++creationHistoryRequestRef.current;
    setCreationHistoryLoading(true);
    setCreationHistoryError(false);
    try {
      const query = new URLSearchParams({ cwd: projectRoot, creationHistory: "1" });
      const response = await fetch(apiPathForPeer(remotePeer, `worktrees?${query}`), { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as WorktreeCreationHistory;
      if (!Array.isArray(data.records) || typeof data.partial !== "boolean") throw new Error("Invalid creation history");
      if (requestId === creationHistoryRequestRef.current) setCreationHistory(data);
    } catch {
      if (requestId === creationHistoryRequestRef.current) {
        setCreationHistory(null);
        setCreationHistoryError(true);
      }
    } finally {
      if (requestId === creationHistoryRequestRef.current) setCreationHistoryLoading(false);
    }
  }, [open, projectRoot, remotePeer]);

  useEffect(() => {
    if (!open || !projectRoot) {
      creationHistoryRequestRef.current += 1;
      setCreationHistory(null);
      setCreationHistoryError(false);
      setCreationHistoryLoading(false);
      return;
    }
    void fetchCreationHistory();
    return () => { creationHistoryRequestRef.current += 1; };
  }, [associatedSessionsRefreshKey, fetchCreationHistory, open, projectRoot]);

  useEffect(() => {
    if (!open) return;
    const refresh = () => {
      void fetchGraph(true);
      setAssociatedSessionsRefreshKey((value) => value + 1);
    };
    window.addEventListener("pi-web:worktree-management-changed", refresh);
    return () => window.removeEventListener("pi-web:worktree-management-changed", refresh);
  }, [fetchGraph, open]);

  const selectedWorktree = useMemo(() => {
    if (!graph || !selectedPath) return null;
    return graph.worktrees.find((w) => w.path === selectedPath) ?? null;
  }, [graph, selectedPath]);

  const selectedWorktreeSessions = useMemo(
    () => mergeAssociatedWorktreeSessions(selectedPath, associatedSessions, creationHistory),
    [associatedSessions, creationHistory, selectedPath],
  );
  const associatedSessionsIncomplete = Boolean(associatedSessionsError || creationHistoryError || creationHistory?.partial);

  const githubUrl = graph?.githubUrl ?? null;
  const githubRepo = graph?.githubRepository ?? null;
  const selectedWorktreeGithubUrl = useMemo(() => {
    if (!githubUrl || !selectedWorktree) return null;
    if (selectedWorktree.branch) {
      return `${githubUrl}/tree/${encodeURIComponent(selectedWorktree.branch)}`;
    }
    return githubUrl;
  }, [githubUrl, selectedWorktree]);

  useEffect(() => {
    if (!selectedPath || !projectRoot || !open) {
      setInspection(null);
      setInspectLoading(false);
      return;
    }
    let cancelled = false;
    // A graph refresh may update the same selected path. Drop the previous
    // inspection immediately so its file names cannot be shown for a newer
    // status snapshot while the detail request is in flight.
    setInspection(null);
    setInspectLoading(true);
    const query = new URLSearchParams({
      cwd: projectRoot,
      inspect: selectedPath,
    });
    const url = apiPathForPeer(remotePeer, `worktrees?${query.toString()}`);
    fetch(url, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { inspection?: WorktreeInspection }) => {
        if (!cancelled && data.inspection) {
          setInspection(data.inspection);
        }
      })
      .catch(() => {
        if (!cancelled) setInspection(null);
      })
      .finally(() => {
        if (!cancelled) setInspectLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedPath, projectRoot, remotePeer, open, graph]);

  const handleCopy = useCallback((key: string, text: string) => {
    void copyText(text);
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((curr) => (curr === key ? null : curr));
    }, 1800);
  }, []);

  const handleDeleteWorktree = useCallback(async (targetPath: string) => {
    if (!projectRoot) return;
    if (!window.confirm(t("worktreeGraph.removeConfirm"))) return;
    setDeletingPath(targetPath);
    try {
      const res = await fetch(apiPathForPeer(remotePeer, "worktrees"), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectRoot, path: targetPath, force: true }),
      });
      if (res.ok) {
        setSelectedPath(null);
        await fetchGraph(true);
      } else {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        alert(t("worktreeGraph.cleanupFailed", { error: err.error || res.statusText }));
      }
    } catch (e) {
      alert(t("worktreeGraph.cleanupRequestFailed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setDeletingPath(null);
    }
  }, [projectRoot, remotePeer, fetchGraph, t]);

  const toggleNodeSection = useCallback((nodeSha: string, section: "fanOut" | "merged" | "atBase") => {
    const key = `${nodeSha}:${section}`;
    setCollapsedNodes((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const worktreeByPath = useMemo(() => {
    if (!graph) return new Map<string, WorktreeGraphItem>();
    return new Map(graph.worktrees.map((w) => [w.path, w]));
  }, [graph]);

  const sessionPreferredPath = useMemo(
    () => preferredWorktreePath(graph?.worktrees ?? [], currentWorktreePath, currentSessionId, creationHistory),
    [creationHistory, currentSessionId, currentWorktreePath, graph],
  );

  const filteredWorktrees = useMemo(() => {
    if (!graph) return [];
    const term = search.trim().toLowerCase();
    return graph.worktrees.filter((w) => {
      const isSessionPreferred = Boolean(sessionPreferredPath && sameWorktreePath(w.path, sessionPreferredPath));
      if (filterTab === "attention" && !isSessionPreferred && !worktreeNeedsAttention(w, currentWorktreePath)) return false;
      if (filterTab === "active" && w.status !== "active") return false;
      if (filterTab === "at_base" && w.status !== "at_base") return false;
      if (!term) return true;
      const haystack = [
        w.label,
        w.branch || "",
        w.path,
        w.shortHead,
        w.headSubject,
        w.shortBase,
        w.baseSubject,
        w.dirtySummary ? String(w.dirtySummary.dirtyCount) : "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [currentWorktreePath, filterTab, graph, search, sessionPreferredPath]);

  const matchedPaths = useMemo(() => {
    return new Set(filteredWorktrees.map((w) => w.path));
  }, [filteredWorktrees]);
  const hasWorktreeFilter = filterTab !== "all" || search.trim().length > 0;

  const selectedInspection = selectedWorktree && inspection?.path === selectedWorktree.path
    ? inspection
    : null;

  useEffect(() => {
    if (!graph) return;
    setSelectedPath((currentPath) => {
      const currentPathIsVisible = Boolean(currentPath && filteredWorktrees.some((w) => w.path === currentPath));
      if (selectionManuallySetRef.current && currentPathIsVisible) return currentPath;
      const preferredPath = sessionPreferredPath && filteredWorktrees.some((w) => w.path === sessionPreferredPath)
        ? sessionPreferredPath
        : null;
      if (preferredPath) return preferredPath;
      if (currentPathIsVisible) return currentPath;
      if (filteredWorktrees.length > 0) return filteredWorktrees[0]?.path ?? null;
      return hasWorktreeFilter ? null : currentPath;
    });
  }, [filteredWorktrees, graph, hasWorktreeFilter, sessionPreferredPath]);

  const searchControl = (
    <div
      data-testid="worktree-graph-search"
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        width: "100%",
        minWidth: 0,
      }}
    >
      <Search
        size={13}
        style={{
          position: "absolute",
          left: 8,
          color: "var(--text-dim)",
          pointerEvents: "none",
        }}
      />
      <input
        type="text"
        className="worktree-graph-search-input"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t("worktreeGraph.filterPlaceholder")}
        style={{
          width: "100%",
          height: 27,
          boxSizing: "border-box",
          padding: "0 8px 0 26px",
          borderRadius: 5,
          border: "1px solid var(--border)",
          background: "var(--bg)",
          color: "var(--text)",
          fontSize: 11,
          outline: "none",
        }}
      />
      {search && (
        <button
          type="button"
          onClick={() => setSearch("")}
          style={{
            position: "absolute",
            right: 6,
            background: "none",
            border: "none",
            color: "var(--text-dim)",
            cursor: "pointer",
            padding: 2,
            display: "flex",
          }}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("worktreeGraph.title")}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        color: "var(--text)",
        fontFamily: "var(--font-sans)",
        userSelect: "none",
      }}
    >
      {/* Top Header Bar */}
      <div
        style={{
          display: isMobile ? "grid" : "flex",
          gridTemplateColumns: isMobile ? "minmax(0, 1fr) auto" : undefined,
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
          rowGap: 8,
          padding: "10px 18px",
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        {/* Left identity & stats */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 30,
              height: 30,
              borderRadius: 7,
              background: "color-mix(in srgb, var(--accent) 12%, transparent)",
              color: "var(--accent)",
              flexShrink: 0,
            }}
          >
            <GitFork size={17} strokeWidth={2.2} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", flexWrap: isMobile ? "wrap" : undefined, gap: 8, overflowWrap: "anywhere" }}>
              <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: "-0.01em" }}>
                {t("worktreeGraph.title")}
              </span>
              {graph?.targetBranch && (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "1px 7px",
                    borderRadius: 4,
                    background: "var(--bg-hover)",
                    border: "1px solid var(--border)",
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    color: "var(--text-muted)",
                  }}
                >
                  <GitBranch size={11} strokeWidth={2} />
                  {graph.targetBranch}
                </span>
              )}
              {deviceName && (
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>· {deviceName}</span>
              )}
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                marginTop: 2,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {graph ? t("worktreeGraph.subtitle") : t("worktreeGraph.refreshing")}
            </div>
          </div>
        </div>

        {/* Center filters */}
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 5, minWidth: 0, gridColumn: isMobile ? "1 / -1" : undefined, gridRow: isMobile ? 2 : undefined }}>
          {(
            [
              ["attention", t("worktreeGraph.filterAttention", { count: graph?.worktrees.filter((worktree) => Boolean(sessionPreferredPath && sameWorktreePath(worktree.path, sessionPreferredPath)) || worktreeNeedsAttention(worktree, currentWorktreePath)).length ?? 0 })],
              ["all", t("worktreeGraph.filterAll", { count: graph?.totalWorktrees ?? 0 })],
              ["active", t("worktreeGraph.filterActive", { count: graph?.counts.active ?? 0 })],
              ["at_base", t("worktreeGraph.filterAtBase", { count: graph?.counts.atBase ?? 0 })],
            ] as const
          ).map(([key, label]) => {
            const active = filterTab === key;
            const hint = key === "attention"
              ? t("worktreeGraph.filterAttentionHint")
              : key === "all"
              ? t("worktreeGraph.filterAllHint")
              : key === "active"
                ? t("worktreeGraph.filterActiveHint")
                : t("worktreeGraph.filterAtBaseHint");
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                title={hint}
                onClick={() => setFilterTab(key)}
                style={{
                  height: 27,
                  padding: "0 10px",
                  borderRadius: 5,
                  fontSize: 11,
                  fontWeight: active ? 600 : 500,
                  border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
                  background: active
                    ? "color-mix(in srgb, var(--accent) 14%, transparent)"
                    : "var(--bg)",
                  color: active ? "var(--accent)" : "var(--text-muted)",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  lineHeight: 1,
                  transition: "background-color 0.12s, border-color 0.12s, color 0.12s",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Search */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            width: isMobile ? "100%" : 320,
            maxWidth: "100%",
            minWidth: 0,
            flex: isMobile ? undefined : "0 1 320px",
            gridColumn: isMobile ? "1 / -1" : undefined,
            gridRow: isMobile ? 3 : undefined,
          }}
        >
          {searchControl}
        </div>

        {/* Refresh, GitHub & Close */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto", minWidth: 0, gridColumn: isMobile ? 2 : undefined, gridRow: isMobile ? 1 : undefined }}>
          <button
            type="button"
            onClick={() => {
              void fetchGraph(true);
              setAssociatedSessionsRefreshKey((value) => value + 1);
            }}
            disabled={loading || associatedSessionsLoading}
            title={t("worktreeGraph.refresh")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 27,
              height: 27,
              flexShrink: 0,
              borderRadius: 5,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: loading ? "var(--accent)" : "var(--text-muted)",
              cursor: loading ? "not-allowed" : "pointer",
            }}
          >
            <RefreshCw
              size={13}
              className={loading ? "animate-spin" : undefined}
              style={{
                animation: loading ? "spin 1s linear infinite" : undefined,
              }}
            />
          </button>

          {githubUrl && (
            <a
              href={githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={`${t("worktreeGraph.openInGithub")}${githubRepo ? ` (${githubRepo.owner}/${githubRepo.repo})` : ""}`}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 27,
                height: 27,
                flexShrink: 0,
                borderRadius: 5,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text-muted)",
                textDecoration: "none",
                cursor: "pointer",
              }}
            >
              <GitHubIcon size={14} />
            </a>
          )}

          <button
            type="button"
            onClick={onClose}
            title={`${t("i18n.close")} (Esc)`}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 27,
              height: 27,
              flexShrink: 0,
              borderRadius: 5,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div
        data-testid="worktree-graph-content"
        style={{
          flex: 1,
          display: "flex",
          flexDirection: isMobile ? "column" : "row",
          minHeight: 0,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Left Graph Stage */}
        <div
          style={{
            flex: "1 1 0",
            minWidth: 0,
            minHeight: 0,
            overflowY: "auto",
            padding: isMobile ? "12px 12px 28px" : "16px 24px 40px",
            background: "var(--bg)",
          }}
        >
          {/* Reading guide */}
          <div
            style={{
              display: isMobile ? "none" : "flex",
              flexDirection: "column",
              gap: 8,
              padding: "9px 12px",
              background: "var(--bg-panel)",
              borderRadius: 6,
              border: "1px solid var(--border)",
              fontSize: 11,
              color: "var(--text-muted)",
              marginBottom: 16,
            }}
          >
            <div
              data-testid="worktree-graph-how-to-read"
              style={{ display: "flex", alignItems: "flex-start", gap: 10, lineHeight: 1.55 }}
            >
              <span style={{ fontWeight: 700, color: "var(--text)", flexShrink: 0 }}>
                {t("worktreeGraph.howToReadTitle")}
              </span>
              <span>{t("worktreeGraph.howToRead")}</span>
            </div>
            <div
              data-testid="worktree-graph-legend"
              style={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 12,
                paddingTop: 7,
                borderTop: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
              }}
            >
              <div
                data-testid="worktree-graph-color-legend"
                style={{ display: "flex", alignItems: "flex-start", gap: 8, width: "100%", lineHeight: 1.55 }}
              >
                <span aria-hidden="true" style={{ display: "inline-flex", gap: 3, paddingTop: 4, flexShrink: 0 }}>
                  {WORKTREE_LANE_COLORS.map((color) => (
                    <span
                      key={color}
                      style={{ width: 8, height: 8, borderRadius: "50%", border: `2px solid ${color}`, boxSizing: "border-box" }}
                    />
                  ))}
                </span>
                <span>{t("worktreeGraph.legendColors")}</span>
              </div>
              <span style={{ fontWeight: 600, color: "var(--text)", flexShrink: 0 }}>
                {t("worktreeGraph.legendTitle")}
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    border: "2px solid var(--text-muted)",
                    background: "transparent",
                    boxSizing: "border-box",
                  }}
                />
                {t("worktreeGraph.legendActive")}
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: "var(--text-muted)",
                  }}
                />
                {t("worktreeGraph.legendMerged")}
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    transform: "rotate(45deg)",
                    border: "1.5px solid var(--text-dim)",
                  }}
                />
                {t("worktreeGraph.legendAtBase")}
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    background: "var(--accent)",
                    borderRadius: 1.5,
                  }}
                />
                {t("worktreeGraph.legendMain")}
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 18,
                    height: 12,
                    borderRadius: 3,
                    border: "1px solid var(--accent)",
                    background: "color-mix(in srgb, var(--accent) 12%, var(--bg-hover))",
                    boxSizing: "border-box",
                    flexShrink: 0,
                  }}
                />
                {t("worktreeGraph.legendSelected")}
              </span>
            </div>
          </div>

          {error && (
            <div
              style={{
                padding: "12px 16px",
                borderRadius: 7,
                background: "rgba(239, 68, 68, 0.08)",
                border: "1px solid #ef4444",
                color: "#ef4444",
                fontSize: 12,
                marginBottom: 16,
              }}
            >
              {error}
            </div>
          )}

          {loading && !graph && (
            <div
              style={{
                padding: "60px 0",
                textAlign: "center",
                color: "var(--text-muted)",
                fontSize: 12,
              }}
            >
              <RefreshCw
                size={18}
                style={{ animation: "spin 1s linear infinite", margin: "0 auto 8px" }}
              />
              <div>{t("worktreeGraph.refreshing")}</div>
            </div>
          )}

          {graph && graph.nodes.length === 0 && (
            <div
              style={{
                padding: "60px 0",
                textAlign: "center",
                color: "var(--text-dim)",
                fontSize: 12,
              }}
            >
              {t("worktreeGraph.empty")}
            </div>
          )}

          {/* Timeline Spine & Nodes */}
          {graph && (
            hasWorktreeFilter && filteredWorktrees.length === 0 ? (
              <div
                style={{
                  padding: "56px 20px",
                  textAlign: "center",
                  color: "var(--text-dim)",
                  fontSize: 12,
                }}
              >
                <div>{t("worktreeGraph.noMatches")}</div>
                <button
                  type="button"
                  onClick={() => {
                    setFilterTab("all");
                    setSearch("");
                  }}
                  style={{
                    marginTop: 10,
                    padding: "5px 10px",
                    borderRadius: 5,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 11,
                  }}
                >
                  {t("worktreeGraph.clearFilters")}
                </button>
              </div>
            ) : (
            <div style={{ position: "relative", paddingLeft: WORKTREE_GRAPH_GEOMETRY.timelinePaddingLeft }}>
              {/* Continuous vertical spine rail */}
              <div
                style={{
                  position: "absolute",
                  left: WORKTREE_GRAPH_GEOMETRY.spineLeft,
                  top: 14,
                  bottom: 14,
                  width: WORKTREE_GRAPH_GEOMETRY.spineWidth,
                  background: "color-mix(in srgb, var(--accent) 45%, var(--border))",
                }}
              />

              {graph.nodes.map((node) => {
                const nodeMain = (node.mainPaths ?? [])
                  .map((p) => worktreeByPath.get(p)!)
                  .filter((w) => Boolean(w) && matchedPaths.has(w.path));
                const nodeFanOut = node.fanOutPaths
                  .map((p) => worktreeByPath.get(p)!)
                  .filter((w) => Boolean(w) && matchedPaths.has(w.path) && w.status !== "merged");
                const nodeMerged = node.mergedPaths
                  .map((p) => worktreeByPath.get(p)!)
                  .filter((w) => Boolean(w) && matchedPaths.has(w.path));
                const nodeAtBase = node.atBasePaths
                  .map((p) => worktreeByPath.get(p)!)
                  .filter((w) => Boolean(w) && matchedPaths.has(w.path));

                // Keep the main HEAD as the timeline anchor, but hide unrelated nodes while filtering.
                if (
                  hasWorktreeFilter
                  && !node.isMainHead
                  && nodeMain.length === 0
                  && nodeFanOut.length === 0
                  && nodeMerged.length === 0
                  && nodeAtBase.length === 0
                ) {
                  return null;
                }

                const fanOutCollapsed = collapsedNodes[`${node.sha}:fanOut`];
                const mergedCollapsed = collapsedNodes[`${node.sha}:merged`];
                const atBaseCollapsed = collapsedNodes[`${node.sha}:atBase`];

                return (
                  <div
                    key={node.sha}
                    style={{
                      position: "relative",
                      marginBottom: 20,
                      paddingLeft: 30,
                    }}
                  >
                    {/* Spine Node Marker */}
                    <div
                      style={{
                        position: "absolute",
                        left: node.isMainHead
                          ? getWorktreeGraphMarkerLeft(WORKTREE_GRAPH_GEOMETRY.headSize)
                          : getWorktreeGraphMarkerLeft(WORKTREE_GRAPH_GEOMETRY.commitSize),
                        top: 2,
                        width: node.isMainHead ? WORKTREE_GRAPH_GEOMETRY.headSize : WORKTREE_GRAPH_GEOMETRY.commitSize,
                        height: node.isMainHead ? WORKTREE_GRAPH_GEOMETRY.headSize : WORKTREE_GRAPH_GEOMETRY.commitSize,
                        borderRadius: node.isMainHead ? 3 : "50%",
                        background: node.isMainHead
                          ? "var(--accent)"
                          : "var(--bg)",
                        border: `2.5px solid ${node.isMainHead ? "var(--accent)" : "color-mix(in srgb, var(--accent) 70%, var(--border))"}`,
                        zIndex: 2,
                        boxShadow: "0 0 0 3px var(--bg)",
                        boxSizing: "border-box",
                      }}
                    />

                    {/* Node Header Row */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 8,
                        fontSize: 12,
                        marginBottom: 6,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 11,
                          fontWeight: 700,
                          color: node.isMainHead ? "var(--accent)" : "var(--text)",
                        }}
                      >
                        {node.shortSha}
                      </span>
                      {node.isMainHead && (
                        <span
                          style={{
                            padding: "0 6px",
                            borderRadius: 4,
                            background: "var(--accent)",
                            color: "#fff",
                            fontSize: 10,
                            fontWeight: 700,
                          }}
                        >
                          HEAD
                        </span>
                      )}
                      <span
                        style={{
                          color: "var(--text-dim)",
                          fontSize: 11,
                        }}
                        title={
                          (node.timestamp || node.isoDate)
                            ? t("worktreeGraph.headCommitTime", { time: formatFullDate(node.timestamp || node.isoDate) })
                            : undefined
                        }
                      >
                        {formatDate(node.timestamp || node.isoDate, t)}
                      </span>
                      <span
                        style={{
                          color: "var(--text-muted)",
                          fontSize: 11,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          maxWidth: 520,
                        }}
                        title={node.subject}
                      >
                        {node.subject || "(no commit message)"}
                      </span>
                    </div>

                    {/* Mainline Checkout Worktree */}
                    {nodeMain.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 8 }}>
                        {nodeMain.map((wt) => renderWorktreeRow(wt))}
                      </div>
                    )}

                    {/* Merged Into this node section */}
                    {nodeMerged.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <button
                          type="button"
                          onClick={() => toggleNodeSection(node.sha, "merged")}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                            padding: "2px 8px",
                            borderRadius: 4,
                            border: "1px solid var(--border)",
                            background: "color-mix(in srgb, #6b7280 8%, transparent)",
                            color: "var(--text-muted)",
                            fontSize: 11,
                            cursor: "pointer",
                            marginBottom: 4,
                          }}
                        >
                          <GitMerge size={12} strokeWidth={2} style={{ color: "#6b7280" }} />
                          <span>
                            {mergedCollapsed
                              ? t("worktreeGraph.expandMerged", { count: nodeMerged.length })
                              : t("worktreeGraph.collapseMerged")}
                          </span>
                          <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                            ({nodeMerged.length})
                          </span>
                          {mergedCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                        </button>

                        {!mergedCollapsed && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 4 }}>
                            {nodeMerged.map((wt) => renderWorktreeRow(wt))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Forked out from this node section */}
                    {nodeFanOut.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <button
                          type="button"
                          onClick={() => toggleNodeSection(node.sha, "fanOut")}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                            padding: "2px 8px",
                            borderRadius: 4,
                            border: "1px solid var(--border)",
                            background: "color-mix(in srgb, #10b981 8%, transparent)",
                            color: "var(--text-muted)",
                            fontSize: 11,
                            cursor: "pointer",
                            marginBottom: 4,
                          }}
                        >
                          <GitFork size={12} strokeWidth={2} style={{ color: "#10b981" }} />
                          <span>
                            {fanOutCollapsed
                              ? t("worktreeGraph.expandFanOut", { count: nodeFanOut.length })
                              : t("worktreeGraph.collapseFanOut")}
                          </span>
                          <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                            ({nodeFanOut.length})
                          </span>
                          {fanOutCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                        </button>

                        {!fanOutCollapsed && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 4 }}>
                            {nodeFanOut.map((wt) => renderWorktreeRow(wt))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Sitting at base with 0 new commits */}
                    {nodeAtBase.length > 0 && (
                      <div>
                        <button
                          type="button"
                          onClick={() => toggleNodeSection(node.sha, "atBase")}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                            padding: "2px 8px",
                            borderRadius: 4,
                            border: "1px solid var(--border)",
                            background: "var(--bg-hover)",
                            color: "var(--text-dim)",
                            fontSize: 10,
                            cursor: "pointer",
                            marginBottom: 4,
                            whiteSpace: "nowrap",
                          }}
                        >
                          <span>{t("worktreeGraph.filterAtBase", { count: nodeAtBase.length })}</span>
                          {atBaseCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                        </button>
                        {!atBaseCollapsed && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 4 }}>
                            {nodeAtBase.map((wt) => renderWorktreeRow(wt))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            )
          )}
        </div>

        {/* Right Inspector Sidebar */}
        <details
          data-testid="worktree-graph-inspector"
          open={!isMobile}
          style={{
            width: isMobile ? "100%" : 380,
            maxHeight: isMobile ? "min(48vh, 520px)" : undefined,
            minHeight: 0,
            flexShrink: 0,
            borderLeft: isMobile ? "none" : "1px solid var(--border)",
            borderTop: isMobile ? "1px solid var(--border)" : "none",
            background: "var(--bg-panel)",
            overflowY: "auto",
            boxSizing: "border-box",
          }}
        >
          <summary
            style={{
              display: isMobile ? "list-item" : "none",
              padding: "12px 18px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              overflowWrap: "anywhere",
            }}
          >
            {t("worktreeGraph.nodeInspector")}{selectedWorktree ? ` · ${selectedWorktree.label}` : ""}
          </summary>
          {selectedWorktree ? (
            <div style={{ padding: isMobile ? 12 : "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Header Info */}
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span
                    style={{
                      width: selectedWorktree.status === "at_base" ? 9 : 10,
                      height: selectedWorktree.status === "at_base" ? 9 : 10,
                      borderRadius: selectedWorktree.status === "at_base" ? 1 : "50%",
                      transform: selectedWorktree.status === "at_base" ? "rotate(45deg)" : "none",
                      border:
                        selectedWorktree.status === "active"
                          ? `2px solid ${worktreeLaneColor(selectedWorktree.laneColorIndex)}`
                          : selectedWorktree.status === "at_base"
                            ? "1.5px solid var(--text-dim)"
                            : "none",
                      background:
                        selectedWorktree.status === "merged" || selectedWorktree.status === "main"
                          ? worktreeLaneColor(selectedWorktree.laneColorIndex)
                          : "transparent",
                    }}
                  />
                  <span style={{ fontWeight: 700, fontSize: 13, wordBreak: "break-all" }}>
                    {selectedWorktree.label}
                  </span>
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 10,
                      padding: "1px 6px",
                      borderRadius: 4,
                      background: "var(--bg-hover)",
                      border: "1px solid var(--border)",
                      color: "var(--text-dim)",
                    }}
                  >
                    {worktreeSourceLabel(selectedWorktree.sourceKind, t)}
                  </span>
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11,
                    color: "var(--text-muted)",
                    fontFamily: "var(--font-mono)",
                    wordBreak: "break-all",
                  }}
                >
                  <span style={{ flex: 1 }} title={selectedWorktree.path}>{shortPath(selectedWorktree.path, projectRoot)}</span>
                  <button
                    type="button"
                    onClick={() => handleCopy("path", selectedWorktree.path)}
                    title={t("worktreeGraph.copyPath")}
                    style={{
                      background: "none",
                      border: "none",
                      color: copiedKey === "path" ? "var(--accent)" : "var(--text-dim)",
                      cursor: "pointer",
                      padding: 2,
                    }}
                  >
                    {copiedKey === "path" ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                  {selectedWorktreeGithubUrl && (
                    <a
                      href={selectedWorktreeGithubUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={selectedWorktree.branch ? t("worktreeGraph.openBranchInGithub") : t("worktreeGraph.openInGithub")}
                      style={{
                        background: "none",
                        border: "none",
                        color: "var(--text-dim)",
                        cursor: "pointer",
                        padding: 2,
                        display: "flex",
                        alignItems: "center",
                        textDecoration: "none",
                      }}
                    >
                      <GitHubIcon size={12} />
                    </a>
                  )}
                </div>
              </div>

              {/* Sessions associated with this checkout. */}
              <section data-testid="worktree-associated-sessions" aria-labelledby="worktree-associated-sessions-title">
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 7 }}>
                  <span id="worktree-associated-sessions-title" style={{ fontSize: 12, fontWeight: 650, color: "var(--text)" }}>{t("worktreeGraph.associatedSessions")}</span>
                  {!associatedSessionsLoading && !creationHistoryLoading && !associatedSessionsIncomplete && <span style={{ fontSize: 10, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>({selectedWorktreeSessions.length})</span>}
                </div>
                {associatedSessionsLoading || creationHistoryLoading ? (
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("worktreeGraph.associatedSessionsLoading")}</div>
                ) : selectedWorktreeSessions.length === 0 && associatedSessionsIncomplete ? (
                  <div role="status" style={{ fontSize: 11, color: "#b45309", lineHeight: 1.4 }}>{t("worktreeGraph.associatedSessionsUnavailable")}</div>
                ) : selectedWorktreeSessions.length === 0 ? (
                  <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.4 }}>{t("worktreeGraph.noAssociatedSessions")}</div>
                ) : (
                  <>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      {selectedWorktreeSessions.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          data-worktree-associated-session={item.id}
                          title={item.title}
                          aria-label={item.title}
                          onClick={() => {
                            onOpenSession(item.id, selectedWorktree.path);
                          }}
                          style={{ minWidth: 0, width: "100%", padding: "7px 8px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "inherit", font: "inherit", textAlign: "left", cursor: "pointer", overflow: "hidden" }}
                        >
                          <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: 11, fontWeight: 600 }}>{item.title}</span>
                          <span style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3, minWidth: 0, color: "var(--text-dim)", fontSize: 10, lineHeight: 1.3 }}>
                            <span title={item.id} style={{ flexShrink: 0, fontFamily: "var(--font-mono)" }}>{t("worktreeGraph.sessionId")} #{item.id.slice(0, 8)}</span>
                            {item.relations.map((relation) => <span key={relation} style={{ flexShrink: 0, padding: "1px 4px", borderRadius: 3, background: "var(--bg-hover)", color: "var(--text-muted)" }}>{associationRelationLabel(relation, t)}</span>)}
                            {item.status && <><span aria-hidden="true">·</span><span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: sessionActivityStatusColor(item.status) }}>{t(`sessionActivity.status.${item.status}`)}</span></>}
                          </span>
                        </button>
                      ))}
                    </div>
                    {associatedSessionsIncomplete && <div role="status" style={{ fontSize: 10, color: "#b45309", lineHeight: 1.4, marginTop: 4 }}>{t("worktreeGraph.associatedSessionsPartial")}</div>}
                  </>
                )}
              </section>

              {/* Primary Action Button: reuse the selected checkout for a new session */}
              <div
                style={{
                  padding: "12px",
                  borderRadius: 8,
                  background: "color-mix(in srgb, var(--accent) 8%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    const prompt = buildWorktreeNodePrompt(selectedWorktree);
                    onNewSessionFromNode(selectedWorktree, prompt);
                    onClose();
                  }}
                  style={{
                    width: "100%",
                    height: 32,
                    borderRadius: 6,
                    background: "var(--accent)",
                    border: "none",
                    color: "#fff",
                    fontSize: 12,
                    fontWeight: 600,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                    cursor: "pointer",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
                  }}
                >
                  <MessageSquarePlus size={14} strokeWidth={2} />
                  <span>{newSessionLabel(selectedWorktree, t)}</span>
                </button>
                <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.35 }}>
                  {t("worktreeGraph.newSessionReuseHint")}
                </div>

                {onSwitchWorktree && (
                  <button
                    type="button"
                    onClick={() => {
                      onSwitchWorktree(selectedWorktree.path);
                      onClose();
                    }}
                    style={{
                      width: "100%",
                      height: 28,
                      borderRadius: 6,
                      background: "var(--bg)",
                      border: "1px solid var(--border)",
                      color: "var(--text)",
                      fontSize: 11,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 5,
                    }}
                  >
                    <ExternalLink size={12} />
                    <span>{t("worktreeGraph.switchToWorktree")}</span>
                  </button>
                )}

                {selectedWorktreeGithubUrl && (
                  <a
                    href={selectedWorktreeGithubUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      width: "100%",
                      height: 28,
                      borderRadius: 6,
                      background: "var(--bg)",
                      border: "1px solid var(--border)",
                      color: "var(--text)",
                      fontSize: 11,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 6,
                      textDecoration: "none",
                      boxSizing: "border-box",
                    }}
                  >
                    <GitHubIcon size={13} />
                    <span>{selectedWorktree.branch ? t("worktreeGraph.openBranchInGithub") : t("worktreeGraph.openInGithub")}</span>
                    <ExternalLink size={11} style={{ opacity: 0.6 }} />
                  </a>
                )}

                {!selectedWorktree.isMain && selectedWorktree.path !== currentWorktreePath && (
                  <button
                    type="button"
                    disabled={deletingPath === selectedWorktree.path}
                    onClick={() => void handleDeleteWorktree(selectedWorktree.path)}
                    style={{
                      width: "100%",
                      height: 28,
                      borderRadius: 6,
                      background: "var(--bg)",
                      border: "1px solid color-mix(in srgb, #ef4444 40%, var(--border))",
                      color: "#ef4444",
                      fontSize: 11,
                      cursor: deletingPath === selectedWorktree.path ? "not-allowed" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 5,
                      marginTop: 2,
                    }}
                  >
                    <Trash2 size={12} />
                    <span>{deletingPath === selectedWorktree.path ? t("worktreeGraph.cleaningUp") : t("worktreeGraph.cleanupWorktree")}</span>
                  </button>
                )}
              </div>

              {/* Git Node Lineage Info */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  padding: "10px",
                  borderRadius: 6,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  fontSize: 11,
                }}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  <span style={{ color: "var(--text-dim)", minWidth: 62 }}>{t("worktreeGraph.head")}:</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>
                    {selectedWorktree.shortHead}
                  </span>
                  <span style={{ color: "var(--text-muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {selectedWorktree.headSubject}
                  </span>
                </div>

                <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  <span style={{ color: "var(--text-dim)", minWidth: 62 }}>{t("worktreeGraph.forkPoint")}:</span>
                  <span style={{ fontFamily: "var(--font-mono)" }}>{selectedWorktree.shortBase}</span>
                  <span style={{ color: "var(--text-muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {selectedWorktree.baseSubject}
                  </span>
                </div>

                <div
                  title={t("worktreeGraph.deltaBasisHint")}
                  style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)" }}
                >
                  <span style={{ color: "var(--text-dim)", minWidth: 62 }}>{t("worktreeGraph.delta")}:</span>
                  <span style={{ color: selectedWorktree.ahead > 0 ? "var(--accent)" : "inherit" }}>
                    {t("worktreeGraph.aheadBehind", {
                      ahead: selectedWorktree.ahead,
                      behind: selectedWorktree.behind,
                    })}
                  </span>
                </div>

                {selectedWorktree.shortMergedInto && (
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span style={{ color: "var(--text-dim)", minWidth: 62 }}>{t("worktreeGraph.mergedPoint")}:</span>
                    <span style={{ fontFamily: "var(--font-mono)", color: "#10b981", fontWeight: 600 }}>
                      {selectedWorktree.shortMergedInto}
                    </span>
                    <span style={{ color: "var(--text-muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {selectedWorktree.mergedIntoSubject}
                    </span>
                  </div>
                )}
              </div>

              {/* Working Tree Dirty Files & Status */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  padding: "10px",
                  borderRadius: 6,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  fontSize: 11,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontWeight: 600, color: "var(--text)" }}>
                    {t("worktreeGraph.uncommittedChanges")}
                  </span>
                  <span
                    style={{
                      color:
                        (selectedInspection?.dirtyCount ?? selectedWorktree.dirtySummary?.dirtyCount ?? 0) > 0 ? "#f59e0b" : "#10b981",
                      fontSize: 10,
                      fontWeight: 600,
                    }}
                  >
                    {inspectLoading
                      ? t("worktreeGraph.inspecting")
                      : selectedInspection
                        ? selectedInspection.dirtyCount > 0
                          ? t("worktreeGraph.dirtyFiles", { count: selectedInspection.dirtyCount })
                          : t("worktreeGraph.cleanWorkingTree")
                        : selectedWorktree.dirtySummary?.state === "unavailable"
                          ? t("worktreeGraph.dirtyUnavailable")
                          : selectedWorktree.dirtySummary
                            ? selectedWorktree.dirtySummary.dirtyCount > 0
                              ? t("worktreeGraph.dirtyFiles", { count: selectedWorktree.dirtySummary.dirtyCount })
                              : t("worktreeGraph.cleanWorkingTree")
                        : "—"}
                  </span>
                </div>

                {selectedWorktree.dirtySummary && selectedWorktree.dirtySummary.state !== "unavailable" && (
                  <div style={{ color: "var(--text-dim)", fontSize: 10 }}>
                    {t("worktreeGraph.dirtyBreakdown", {
                      staged: selectedWorktree.dirtySummary.stagedCount,
                      unstaged: selectedWorktree.dirtySummary.unstagedCount,
                      untracked: selectedWorktree.dirtySummary.untrackedCount,
                      ignored: selectedWorktree.dirtySummary.ignoredCount,
                    })}
                  </div>
                )}

                {selectedInspection && selectedInspection.dirtyFiles.length > 0 && (
                  <div
                    style={{
                      maxHeight: 180,
                      overflowY: "auto",
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                      marginTop: 4,
                      borderTop: "1px solid var(--border)",
                      paddingTop: 6,
                    }}
                  >
                    {selectedInspection.dirtyFiles.map((f, i) => {
                      const isMod = f.status.includes("M");
                      const isDel = f.status.includes("D");
                      const isAdd = f.status.includes("A") || f.status.includes("?");
                      const badgeColor = isMod ? "#f59e0b" : isDel ? "#ef4444" : isAdd ? "#10b981" : "var(--text-dim)";
                      const mtimeFormatted = f.mtimeMs ? formatDate(f.mtimeMs, t) : "";
                      const mtimeFull = f.mtimeMs ? formatFullDate(f.mtimeMs) : "";
                      return (
                        <div
                          key={i}
                          title={mtimeFull ? `${f.path} · ${t("worktreeGraph.fileModifiedTime", { time: mtimeFull })}` : f.path}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 7,
                            padding: "2px 4px",
                            borderRadius: 4,
                            minWidth: 0,
                          }}
                        >
                          <span
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: 10,
                              fontWeight: 700,
                              width: 14,
                              textAlign: "center",
                              flexShrink: 0,
                              color: badgeColor,
                            }}
                          >
                            {f.status.trim() || "M"}
                          </span>
                          <span
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: 11,
                              lineHeight: 1.4,
                              color: "var(--text-muted)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              flex: 1,
                            }}
                          >
                            {f.path}
                          </span>
                          {mtimeFormatted ? (
                            <span
                              style={{
                                color: "var(--text-dim)",
                                fontSize: 10,
                                flexShrink: 0,
                                marginLeft: "auto",
                              }}
                            >
                              {mtimeFormatted}
                            </span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Commits */}
              {selectedInspection && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    padding: "10px",
                    borderRadius: 6,
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    fontSize: 11,
                  }}
                >
                  <div style={{ fontWeight: 600, color: "var(--text)" }}>
                    {t(selectedInspection.commitMode === "head-history" ? "worktreeGraph.headHistory" : "worktreeGraph.newCommits")}
                  </div>
                  {selectedInspection.commits.length > 0 ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      {selectedInspection.commits.map((commit) => {
                        const commitTimeFormatted = commit.isoDate ? formatDate(commit.isoDate, t) : "";
                        const commitTimeFull = commit.isoDate ? formatFullDate(commit.isoDate) : "";
                        const tooltip = [
                          commit.subject,
                          commit.author ? `Author: ${commit.author}` : null,
                          commitTimeFull ? t("worktreeGraph.headCommitTime", { time: commitTimeFull }) : null,
                        ].filter(Boolean).join(" · ");
                        return (
                          <div key={commit.sha} style={{ display: "flex", gap: 6, minWidth: 0, alignItems: "baseline" }}>
                            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>{commit.shortSha}</span>
                            <span title={tooltip} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.4, flex: 1, minWidth: 0 }}>{commit.subject}</span>
                            {commitTimeFormatted ? (
                              <span style={{ color: "var(--text-dim)", fontSize: 10, flexShrink: 0, marginLeft: "auto" }}>
                                {commitTimeFormatted}
                              </span>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ color: "var(--text-dim)", fontSize: 10 }}>
                      {t(selectedInspection.commitMode === "head-history" ? "worktreeGraph.noHeadHistory" : "worktreeGraph.noNewCommits")}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div
              style={{
                padding: "60px 20px",
                textAlign: "center",
                color: "var(--text-dim)",
                fontSize: 12,
              }}
            >
              {t("worktreeGraph.selectHint")}
            </div>
          )}
        </details>
      </div>
    </div>
  );

  function renderWorktreeRow(wt: WorktreeGraphItem) {
    const isSelected = selectedPath === wt.path;
    const isCurrent = Boolean(
      (sessionPreferredPath && sameWorktreePath(sessionPreferredPath, wt.path))
      || (currentWorktreePath && sameWorktreePath(currentWorktreePath, wt.path)),
    );
    const laneColor = worktreeLaneColor(wt.laneColorIndex);

    return (
      <div
        key={wt.path}
        role="button"
        tabIndex={0}
        aria-pressed={isSelected}
        aria-label={wt.label}
        title={t("worktreeGraph.deltaBasisHint")}
        onClick={() => {
          selectionManuallySetRef.current = true;
          setSelectedPath(wt.path);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            selectionManuallySetRef.current = true;
            setSelectedPath(wt.path);
          }
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          position: "relative",
          padding: "6px 10px 6px 24px",
          borderRadius: 6,
          background: isSelected
            ? "color-mix(in srgb, var(--accent) 12%, var(--bg-hover))"
            : "color-mix(in srgb, var(--bg-panel) 60%, transparent)",
          border: isSelected
            ? "1px solid var(--accent)"
            : "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
          cursor: "pointer",
          fontSize: 11,
          transition: "background-color 0.12s, border-color 0.12s, color 0.12s, transform 0.12s",
        }}
      >
        {/* Elbow connector dot */}
        <div
          style={{
            position: "absolute",
            left: WORKTREE_GRAPH_GEOMETRY.statusMarkerLeft,
            top: "50%",
            width: wt.status === "at_base" ? 9 : 10,
            height: wt.status === "at_base" ? 9 : 10,
            borderRadius: wt.status === "at_base" ? 1 : "50%",
            transform: wt.status === "at_base" ? "translateY(-50%) rotate(45deg)" : "translateY(-50%)",
            border:
              wt.status === "active"
                ? `2px solid ${laneColor}`
                : wt.status === "at_base"
                  ? "1.5px solid var(--text-dim)"
                  : "none",
            background:
              wt.status === "merged" || wt.status === "main"
                ? laneColor
                : "transparent",
            flexShrink: 0,
          }}
          title={`${
            wt.status === "active"
              ? t("worktreeGraph.legendActive")
              : wt.status === "merged"
                ? t("worktreeGraph.legendMerged")
                : wt.status === "main"
                  ? t("worktreeGraph.legendMain")
                  : t("worktreeGraph.legendAtBase")
          }\n${t("worktreeGraph.forkPoint")}: ${wt.shortBase}\n${t("worktreeGraph.legendColors")}`}
        />

        {/* Branch / Label Chip */}
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "1px 6px",
            borderRadius: 4,
            background: "var(--bg)",
            border: `1px solid color-mix(in srgb, ${laneColor} 40%, var(--border))`,
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            fontWeight: 600,
            flexShrink: 0,
            maxWidth: "45%",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={`${wt.branch || wt.label} · ${wt.path}${wt.dirtySummary?.state === "clean" ? ` · ${t("worktreeGraph.cleanWorkingTree")}` : ""}`}
        >
          <span style={{ fontSize: 11 }}>{wt.isMain ? "✏️" : "🌲"}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{wt.label}</span>
        </div>

        {/* Working tree dirty status badge */}
        {wt.dirtySummary?.hasUncommitted && (
          <span
            data-testid="worktree-wip-inline"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "1px 6px",
              borderRadius: 4,
              background: "color-mix(in srgb, #f59e0b 16%, transparent)",
              border: "1px solid color-mix(in srgb, #f59e0b 45%, var(--border))",
              color: "#d97706",
              fontSize: 10,
              fontWeight: 700,
              flexShrink: 0,
            }}
            title={
              wt.dirtySummary
                ? `${t("worktreeGraph.dirtyFiles", { count: wt.dirtySummary.dirtyCount })} (${t("worktreeGraph.dirtyBreakdown", {
                    staged: wt.dirtySummary.stagedCount,
                    unstaged: wt.dirtySummary.unstagedCount,
                    untracked: wt.dirtySummary.untrackedCount,
                    ignored: wt.dirtySummary.ignoredCount,
                  })})`
                : t("worktreeGraph.dirtyFiles", { count: 0 })
            }
          >
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#d97706" }} />
            {t("worktreeGraph.wipFiles", { count: wt.dirtySummary.dirtyCount })}
          </span>
        )}

        {wt.dirtySummary?.state === "unavailable" && (
          <span
            data-testid="worktree-wip-unavailable"
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "1px 5px",
              borderRadius: 3,
              background: "color-mix(in srgb, #f59e0b 10%, transparent)",
              border: "1px solid color-mix(in srgb, #f59e0b 30%, var(--border))",
              color: "#f59e0b",
              fontSize: 10,
              fontWeight: 600,
              flexShrink: 0,
            }}
            title={t("worktreeGraph.dirtyUnavailable")}
          >
            {t("worktreeGraph.dirtyStatusUnknown")}
          </span>
        )}

        {/* Head Subject / Message */}
        <span
          style={{
            color: "var(--text-muted)",
            fontSize: 11,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
          title={wt.headSubject}
        >
          {wt.headSubject}
        </span>

        {/* Relative Time */}
        <span
          style={{
            color: "var(--text-dim)",
            fontSize: 10,
            flexShrink: 0,
          }}
          title={
            (wt.headTimestamp || wt.headIsoDate)
              ? t("worktreeGraph.headCommitTime", { time: formatFullDate(wt.headTimestamp || wt.headIsoDate) })
              : undefined
          }
        >
          {formatDate(wt.headTimestamp || wt.headIsoDate, t)}
        </span>

        {/* Quick Action: start a session in this existing checkout */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            const prompt = buildWorktreeNodePrompt(wt);
            onNewSessionFromNode(wt, prompt);
            onClose();
          }}
          title={newSessionLabel(wt, t)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            height: 22,
            padding: "0 7px",
            borderRadius: 4,
            border: "1px solid color-mix(in srgb, var(--accent) 40%, var(--border))",
            background: "color-mix(in srgb, var(--accent) 10%, transparent)",
            color: "var(--accent)",
            fontSize: 10,
            fontWeight: 600,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <MessageSquarePlus size={11} strokeWidth={2} />
          <span>{newSessionLabel(wt, t)}</span>
        </button>

        {isCurrent && (
          <span
            style={{
              padding: "0 5px",
              borderRadius: 3,
              fontSize: 9,
              fontWeight: 700,
              background: "var(--bg-hover)",
              color: "var(--accent)",
              border: "1px solid var(--accent)",
              flexShrink: 0,
            }}
          >
            CURRENT
          </span>
        )}
      </div>
    );
  }
}
