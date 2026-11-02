import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { FileActionIcon, FileActionMenuItem, FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { getFileIcon, FolderIcon } from "./FileIcons";
import { SessionSearchInput } from "./SessionSearchInput";
import { ToolbarIconButton } from "./ToolbarIconButton";
import { GitBranch } from "lucide-react";
import { getFileDirectory, joinFilePath, getRelativeFilePath } from "@/lib/file-paths";
import { apiPathForPeer } from "@/lib/file-api";
import { buildFileSearchTree, collectFileSearchDirectories, flattenFileSearchTree, searchMatchIndices, type FileSearchMatch } from "@/lib/file-search-tree";
import type { ExplorerFilterSettings } from "@/lib/explorer-filter";
import type { TranslationParams } from "@/lib/i18n/types";

interface ExplorerSectionProps {
  t: (key: string, params?: TranslationParams) => string;
  /** Reader mode: use the larger reader header styling. */
  readerMode?: boolean;
  /** Explorer expanded (AppShell activity mode / sidebar both control this externally). */
  open: boolean;
  /** Reader local patch: browse a remote device via /api/remote proxy. */
  remotePeer?: string;
  /** Current project cwd; null hides the whole section body (AppShell activity mode). */
  cwd: string | null;
  onEnsureOpen: () => void;
  onToggleSessions?: () => void;
  showSessionToggle?: boolean;
  sessionsOpen?: boolean;
  filePanelOpen?: boolean;
  onOpenFile: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff"; reuseActiveTab?: boolean }) => void;
  onPathRenamed?: (oldPath: string, newPath: string, isDir: boolean, peer?: string) => void;
  activeFilePath?: string | null;
  /** Shell-level refresh key (AppShell shared key / sidebar explorerKey); changes advance the internal key. */
  externalRefreshKey?: number;
  /** Refresh handler; when absent the section bumps its own internal key. */
  onRefresh?: () => void;
  onAtMention?: (filePath: string, isDir: boolean) => void;
  onAtMentions?: (filePaths: string[]) => void;
  /** Scroll container style for the explorer body (AppShell: maxHeight 38vh; sidebar: flex 1). */
  contentStyle?: CSSProperties;
  /** Optional control occupying the first cell of the left toolbar. */
  leadingControl?: ReactNode;
  folderControl?: ReactNode;
}

/**
 * File-explorer toolbar row + body, shared by AppShell (activity mode) and
 * SessionSidebar (classic/reader mode). All interaction state lives here;
 * callers only supply the open flag, cwd and refresh wiring.
 */
export function ExplorerSection({
  t,
  readerMode = false,
  open,
  cwd,
  remotePeer,
  onEnsureOpen,
  onToggleSessions,
  showSessionToggle = false,
  sessionsOpen = true,
  filePanelOpen = false,
  onOpenFile,
  onPathRenamed,
  activeFilePath,
  externalRefreshKey,
  onRefresh,
  onAtMention,
  onAtMentions,
  contentStyle,
  leadingControl,
  folderControl,
}: ExplorerSectionProps) {
  const remotePeerRef = useRef(remotePeer);
  remotePeerRef.current = remotePeer;
  const api = (path: string) => apiPathForPeer(remotePeerRef.current, path);
  const [explorerKey, setExplorerKey] = useState(0);
  const [explorerCwd, setExplorerCwd] = useState<string | null>(cwd);
  const [changesCollapsed, setChangesCollapsed] = useState(true);
  useEffect(() => {
    setChangesCollapsed(true);
  }, [cwd]);
  const [searchQuery, setSearchQuery] = useState("");
  const [hideGitIgnored, setHideGitIgnored] = useState(false);
  const [searchResults, setSearchResults] = useState<FileSearchMatch[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchSeqRef = useRef(0);
  const [searchExpandedPaths, setSearchExpandedPaths] = useState<Set<string>>(new Set());
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleFocusSearch = () => {
      if (!open) onEnsureOpen();
      setTimeout(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }, 50);
    };
    window.addEventListener("reader:focus-file-search", handleFocusSearch);
    return () => window.removeEventListener("reader:focus-file-search", handleFocusSearch);
  }, [open, onEnsureOpen]);

  // Debounced on-demand file search via the existing /api/file-index
  // (git ls-files or depth/walk-capped fallback, 10s per-cwd cache, ranked
  // fuzzy matching). Runs only while a query is active — no index resident
  // in memory outside the 10s server-side cache window.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q || !explorerCwd) {
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
    setSearchLoading(true);
    setSearchError(null);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const hideIgnoredQuery = hideGitIgnored ? "&hideGitIgnored=1" : "";
      void fetch(api(`file-index?cwd=${encodeURIComponent(explorerCwd)}&q=${encodeURIComponent(q)}&limit=50${hideIgnoredQuery}`), { signal: controller.signal })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<{ matches?: FileSearchMatch[]; error?: string }>;
        })
        .then((data) => {
          if (searchSeqRef.current !== seq) return;
          if (data.error) throw new Error(data.error);
          setSearchResults(data.matches ?? []);
          setSearchLoading(false);
        })
        .catch((error) => {
          if (controller.signal.aborted || searchSeqRef.current !== seq) return;
          setSearchResults([]);
          setSearchError(error instanceof Error ? error.message : String(error));
          setSearchLoading(false);
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [hideGitIgnored, searchQuery, explorerCwd]);

  const searchTree = useMemo(
    () => buildFileSearchTree(searchResults ?? []),
    [searchResults],
  );
  const visibleSearchTree = useMemo(
    () => flattenFileSearchTree(searchTree, searchExpandedPaths),
    [searchExpandedPaths, searchTree],
  );

  useEffect(() => {
    setSearchExpandedPaths(new Set(collectFileSearchDirectories(searchTree)));
  }, [searchTree]);

  useEffect(() => {
    setSelectedIndex(null);
  }, [searchQuery]);

  useEffect(() => {
    if (selectedIndex !== null && visibleSearchTree[selectedIndex]) {
      const nodePath = visibleSearchTree[selectedIndex].node.path;
      const el = rowRefs.current.get(nodePath);
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, visibleSearchTree]);

  const toggleSearchFolder = (path: string) => {
    setSearchExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const [uploadBusy, setUploadBusy] = useState(false);
  const [fileActionMenuOpen, setFileActionMenuOpen] = useState(false);
  const [hiddenActive, setHiddenActive] = useState(true);
  const [refreshDone, setRefreshDone] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const explorerRef = useRef<FileExplorerHandle>(null);
  const handleExplorerFilterChange = useCallback((settings: ExplorerFilterSettings) => {
    setHideGitIgnored(settings.hideGitIgnored);
  }, []);
  const [pendingLocatePath, setPendingLocatePath] = useState<string | null>(null);
  const autoLocateKeyRef = useRef<string | null>(null);
  const activeFileRelativePath = activeFilePath && cwd ? getRelativeFilePath(activeFilePath, cwd) : null;
  const canLocateActiveFile = Boolean(activeFilePath && (cwd || explorerCwd));

  // Reset an externally re-rooted tree when caller workspace changes. Keep
  // external roots while only the active file changes so locate can finish.
  const previousCwdRef = useRef(cwd);
  useEffect(() => {
    if (previousCwdRef.current === cwd) return;
    previousCwdRef.current = cwd;
    setExplorerCwd(cwd);
    setHideGitIgnored(false);
    setPendingLocatePath(null);
  }, [cwd]);

  useEffect(() => {
    setHideGitIgnored(false);
  }, [explorerCwd]);

  // Files inside the selected workspace use its normal tree root. External
  // files keep the current root until the user presses locate.
  useEffect(() => {
    const activeFileIsInsideCwd = Boolean(
      activeFilePath && cwd && getRelativeFilePath(activeFilePath, cwd) !== activeFilePath,
    );
    if (!activeFilePath || activeFileIsInsideCwd) setExplorerCwd(cwd);
  }, [activeFilePath, cwd]);

  // A shell-level refresh (shared key) also advances the internal key, which
  // drives the mounted FileExplorer. Skip the first render so mounting does
  // not trigger a spurious refresh.
  const prevExternalKey = useRef(externalRefreshKey);
  useEffect(() => {
    if (externalRefreshKey !== undefined && externalRefreshKey !== prevExternalKey.current) {
      setExplorerKey((k) => k + 1);
    }
    prevExternalKey.current = externalRefreshKey;
  }, [externalRefreshKey]);

  const handleRefreshClick = () => {
    if (onRefresh) onRefresh();
    else setExplorerKey((k) => k + 1);
    setRefreshDone(true);
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => setRefreshDone(false), 2000);
  };

  // Body visibility follows the Explorer state in every layout mode.
  const showActions = open && Boolean(explorerCwd);

  useEffect(() => {
    if (!fileActionMenuOpen) return;
    const close = (event?: Event) => {
      if (event?.target instanceof Element && event.target.closest("[data-file-action-menu]")) return;
      setFileActionMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [fileActionMenuOpen]);

  useEffect(() => {
    if (!pendingLocatePath || !showActions || !explorerRef.current) return;
    explorerRef.current.locateFile(pendingLocatePath);
    setPendingLocatePath(null);
  }, [explorerCwd, pendingLocatePath, showActions]);

  useEffect(() => {
    if (!filePanelOpen || !open || !activeFilePath) return;
    const handleFileNavigationKey = (event: globalThis.KeyboardEvent) => {
      if (event.repeat || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, button, a, [contenteditable='true']")) return;
      event.preventDefault();
      void explorerRef.current?.navigateFile(event.key === "ArrowDown" ? "next" : "previous");
    };
    window.addEventListener("keydown", handleFileNavigationKey);
    return () => window.removeEventListener("keydown", handleFileNavigationKey);
  }, [activeFilePath, filePanelOpen, open]);

  const handleLocateActiveFile = useCallback(() => {
    if (!activeFilePath || !canLocateActiveFile) return;
    setSearchQuery("");
    const activeFileIsInsideCwd = Boolean(
      cwd && activeFileRelativePath && activeFileRelativePath !== activeFilePath,
    );
    const targetRoot = activeFileIsInsideCwd ? cwd : getFileDirectory(activeFilePath);
    if (!targetRoot) return;
    if (!showActions || targetRoot !== explorerCwd) {
      setExplorerCwd(targetRoot);
      setPendingLocatePath(activeFilePath);
      if (!showActions) onEnsureOpen();
      return;
    }
    explorerRef.current?.locateFile(activeFilePath);
  }, [activeFilePath, activeFileRelativePath, canLocateActiveFile, cwd, explorerCwd, onEnsureOpen, showActions]);

  // VS Code-style Auto Reveal: active tab changes automatically reveal its file.
  useEffect(() => {
    if (!activeFilePath || !canLocateActiveFile) {
      autoLocateKeyRef.current = null;
      return;
    }
    const autoLocateKey = `${remotePeer ?? "local"}:${cwd ?? ""}:${activeFilePath}`;
    if (autoLocateKeyRef.current === autoLocateKey) return;
    autoLocateKeyRef.current = autoLocateKey;
    handleLocateActiveFile();
  }, [activeFilePath, canLocateActiveFile, cwd, handleLocateActiveFile, remotePeer]);

  const handleGitModeToggle = () => {
    if (!open) {
      setChangesCollapsed(false);
      onEnsureOpen();
      return;
    }
    setChangesCollapsed((value) => !value);
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;

    if (visibleSearchTree.length === 0) {
      if (event.key === "Escape") {
        if (searchQuery.trim().length > 0) {
          event.preventDefault();
          setSearchQuery("");
          if (activeFilePath && canLocateActiveFile) {
            explorerRef.current?.locateFile(activeFilePath);
          }
        } else {
          event.currentTarget.blur();
        }
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((prev) => {
        if (prev === null || prev < 0) return 0;
        return Math.min(prev + 1, visibleSearchTree.length - 1);
      });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((prev) => {
        if (prev === null || prev <= 0) return null;
        return prev - 1;
      });
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = (selectedIndex !== null && visibleSearchTree[selectedIndex])
        ? visibleSearchTree[selectedIndex]
        : visibleSearchTree.find((item) => !item.node.isDir) ?? visibleSearchTree[0];
      if (target && explorerCwd) {
        const fullPath = joinFilePath(explorerCwd, target.node.path);
        if (target.node.isDir) {
          toggleSearchFolder(target.node.path);
        } else {
          if (selectedIndex === null) {
            const idx = visibleSearchTree.indexOf(target);
            if (idx >= 0) setSelectedIndex(idx);
          }
          onOpenFile(fullPath, target.node.name);
        }
      }
    } else if (event.key === "ArrowRight") {
      if (selectedIndex !== null && visibleSearchTree[selectedIndex]?.node.isDir) {
        const target = visibleSearchTree[selectedIndex];
        if (!searchExpandedPaths.has(target.node.path)) {
          event.preventDefault();
          toggleSearchFolder(target.node.path);
        }
      }
    } else if (event.key === "ArrowLeft") {
      if (selectedIndex !== null && visibleSearchTree[selectedIndex]?.node.isDir) {
        const target = visibleSearchTree[selectedIndex];
        if (searchExpandedPaths.has(target.node.path)) {
          event.preventDefault();
          toggleSearchFolder(target.node.path);
        }
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (searchQuery.trim().length > 0) {
        setSearchQuery("");
        if (activeFilePath && canLocateActiveFile) {
          explorerRef.current?.locateFile(activeFilePath);
        }
      } else {
        event.currentTarget.blur();
      }
    }
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", flexShrink: 0, height: 36, minHeight: 36, borderBottom: "1px solid var(--border)", background: "var(--bg-panel)", boxSizing: "border-box" }}>
        {leadingControl}
        {showSessionToggle && onToggleSessions && !leadingControl ? (
          <button
            type="button"
            onClick={onToggleSessions}
            aria-expanded={sessionsOpen}
            aria-label={sessionsOpen ? t("sidebar.hideSessions") : t("sidebar.showSessions")}
            title={sessionsOpen ? t("sidebar.hideSessions") : t("sidebar.showSessions")}
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              gap: 6,
              minWidth: "max-content",
              flexShrink: 0,
              padding: "0 10px",
              background: "none",
              border: "none",
              color: "var(--text)",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: "0.02em",
              textAlign: "left",
              whiteSpace: "nowrap",
            }}
          >
            <svg
              width="9" height="9" viewBox="0 0 10 10" fill="none"
              stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
              style={{ transform: sessionsOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
              aria-hidden="true"
            >
              <polyline points="3 2 7 5 3 8" />
            </svg>
          </button>
        ) : (
          <>
            {folderControl}
          </>
        )}
        <div style={{ flex: 1, minWidth: 0 }} />
        {Boolean(cwd) && (
          <ToolbarIconButton
            onClick={handleGitModeToggle}
            title={t("files.gitMode")}
            ariaPressed={!changesCollapsed}
            color={changesCollapsed ? "var(--text-dim)" : "var(--accent)"}
            background={changesCollapsed ? "none" : "var(--bg-selected)"}
          >
            <GitBranch size={13} strokeWidth={1.8} aria-hidden="true" />
          </ToolbarIconButton>
        )}
        {showActions && (
          <div data-file-action-menu="true" style={{ position: "relative", flexShrink: 0 }}>
            <ToolbarIconButton
              onClick={() => setFileActionMenuOpen((open) => !open)}
              title={t("files.actionMenuTitle")}
              ariaPressed={fileActionMenuOpen}
              color={fileActionMenuOpen ? "var(--accent)" : "var(--text-dim)"}
              background={fileActionMenuOpen ? "var(--bg-selected)" : "none"}
            >
              <FileActionIcon kind="folder" size={13} />
            </ToolbarIconButton>
            {fileActionMenuOpen && (
              <div
                data-file-action-menu="true"
                role="menu"
                onPointerDown={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.preventDefault()}
                style={{ position: "absolute", top: 30, right: 0, zIndex: 400, minWidth: 166, padding: 4, border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg-panel)", boxShadow: "0 8px 24px rgba(0,0,0,0.18)" }}
              >
                <FileActionMenuItem kind="folder" label={t("files.newFolder")} onClick={() => { setFileActionMenuOpen(false); explorerRef.current?.openCreate("folder", cwd ?? explorerCwd ?? undefined); }} />
                <FileActionMenuItem kind="file" label={t("files.newDocument")} onClick={() => { setFileActionMenuOpen(false); explorerRef.current?.openCreate("file", cwd ?? explorerCwd ?? undefined); }} />
                <FileActionMenuItem kind="upload" label={t("sidebar.uploadFiles")} disabled={uploadBusy} onClick={() => { setFileActionMenuOpen(false); explorerRef.current?.openUploadPicker(cwd ?? explorerCwd ?? undefined); }} />
              </div>
            )}
          </div>
        )}
        {showActions && (
          <button
            type="button"
            onClick={() => explorerRef.current?.openFilterSettings()}
            title={t("files.filterSettings")}
            aria-label={t("files.filterSettings")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 26, padding: 0,
              background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", borderRadius: 5, flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        )}
        <ToolbarIconButton
          onClick={() => explorerRef.current?.toggleHiddenVisibility()}
          title={hiddenActive ? t("files.showHiddenItems") : t("files.restoreHiddenSettings")}
          ariaPressed={!hiddenActive}
          color={hiddenActive ? "var(--text-dim)" : "var(--accent)"}
          background={hiddenActive ? "none" : "var(--bg-selected)"}
        >
          {hiddenActive ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
              <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
              <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
              <line x1="2" x2="22" y1="2" y2="22" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          )}
        </ToolbarIconButton>
        <ToolbarIconButton
          onClick={handleRefreshClick}
          title={t("sidebar.refreshExplorer")}
          skipHover={refreshDone}
          color={refreshDone ? "#4ade80" : "var(--text-dim)"}
          background={refreshDone ? "rgba(74,222,128,0.18)" : "none"}
          marginRight={6}
        >
          {refreshDone ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          )}
        </ToolbarIconButton>
      </div>
      {showActions && explorerCwd && (
        <>
          <div style={{ margin: "6px 8px 2px", flexShrink: 0 }}>
            <SessionSearchInput
              inputRef={searchInputRef}
              value={searchQuery}
              onChange={(val) => {
                setSearchQuery(val);
                if (!val && activeFilePath && canLocateActiveFile) {
                  explorerRef.current?.locateFile(activeFilePath);
                }
              }}
              onKeyDown={handleSearchKeyDown}
              placeholder={t("files.searchPlaceholder")}
              title={t("files.searchHint")}
              clearLabel={t("files.clearSearch")}
            />
          </div>
          {searchQuery.trim().length > 0 && (
            <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", ...contentStyle }}>
              <div style={{ padding: "6px 12px 4px", color: "var(--text-muted)", fontSize: 11 }}>
                {searchLoading ? t("files.searching") : `${t("files.searchResults")} ${searchResults?.length ?? 0}`}
              </div>
              {searchError && (
                <div style={{ padding: "12px 14px", color: "#f87171", fontSize: 11 }}>{searchError}</div>
              )}
              {!searchLoading && !searchError && searchResults && searchResults.length === 0 && (
                <div style={{ padding: "18px 14px", color: "var(--text-muted)", fontSize: 12 }}>{t("files.searchNoResults")}</div>
              )}
              {!searchLoading && searchResults && searchResults.length > 0 && (
                <div role="tree" aria-label={t("files.searchResults")} style={{ paddingBottom: 8 }}>
                  {visibleSearchTree.map(({ node, depth }, index) => {
                    const fullPath = joinFilePath(explorerCwd, node.path);
                    const expanded = node.isDir && searchExpandedPaths.has(node.path);
                    const toggleLabel = t(expanded ? "files.searchCollapseFolder" : "files.searchExpandFolder");
                    const openFolderTitle = `${t("files.searchOpenFolder")}: ${node.path}`;
                    const highlightedIndices = new Set(searchMatchIndices(node.name, searchQuery));
                    const isSelected = selectedIndex === index;
                    const isActive = !node.isDir && activeFilePath === fullPath;
                    const parentDir = !node.isDir && node.path.includes("/")
                      ? node.path.slice(0, node.path.lastIndexOf("/"))
                      : "";

                    return (
                      <div
                        key={node.path}
                        ref={(el) => {
                          if (el) rowRefs.current.set(node.path, el);
                          else rowRefs.current.delete(node.path);
                        }}
                        role="treeitem"
                        aria-level={depth + 1}
                        aria-selected={isSelected || isActive}
                        aria-expanded={node.isDir ? expanded : undefined}
                        aria-current={isActive ? "true" : undefined}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          minWidth: 0,
                          minHeight: 28,
                          paddingRight: 6,
                          paddingLeft: depth * 14,
                          background: isSelected
                            ? "var(--bg-selected)"
                            : isActive
                              ? "var(--bg-hover)"
                              : undefined,
                          borderRadius: 4,
                          borderLeft: isActive
                            ? "2px solid var(--accent)"
                            : isSelected
                              ? "2px solid var(--text-muted)"
                              : "2px solid transparent",
                        }}
                      >
                        {node.isDir ? (
                          <button
                            type="button"
                            onClick={() => toggleSearchFolder(node.path)}
                            title={`${toggleLabel}: ${node.name}`}
                            aria-label={`${toggleLabel}: ${node.name}`}
                            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 26, padding: 0, border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", flexShrink: 0 }}
                            onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
                            onMouseLeave={(event) => { event.currentTarget.style.background = "none"; }}
                          >
                            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.12s" }} aria-hidden="true">
                              <polyline points="3 2 7 5 3 8" />
                            </svg>
                          </button>
                        ) : (
                          <span aria-hidden="true" style={{ width: 22, flexShrink: 0 }} />
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedIndex(index);
                            if (node.isDir) {
                              toggleSearchFolder(node.path);
                            } else {
                              onOpenFile(fullPath, node.name);
                            }
                          }}
                          title={node.isDir ? openFolderTitle : node.path}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 7,
                            minWidth: 0,
                            flex: 1,
                            height: 28,
                            padding: "0 6px 0 0",
                            border: "none",
                            background: "none",
                            textAlign: "left",
                            color: isActive ? "var(--accent)" : node.matched ? "var(--text)" : "var(--text-muted)",
                            cursor: "pointer",
                            fontWeight: isActive ? 600 : undefined,
                          }}
                          onMouseEnter={(event) => { if (!isSelected && !isActive) event.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(event) => { if (!isSelected && !isActive) event.currentTarget.style.background = "none"; }}
                        >
                          {node.isDir ? <FolderIcon size={14} open={expanded} /> : getFileIcon(node.name, 14)}
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }}>
                            {Array.from(node.name).map((character, charIdx) => (
                              <span key={`${node.path}:${charIdx}`} style={highlightedIndices.has(charIdx) ? { textDecoration: "underline", textDecorationColor: "#facc15", textUnderlineOffset: 2 } : undefined}>{character}</span>
                            ))}
                          </span>
                          {parentDir && (
                            <span
                              style={{
                                marginLeft: "auto",
                                paddingLeft: 6,
                                fontSize: 10,
                                color: "var(--text-dim)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                maxWidth: "45%",
                              }}
                              title={parentDir}
                            >
                              {parentDir}
                            </span>
                          )}
                        </button>
                        <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                          {!node.isDir && onAtMention && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                const sourceCwd = cwd ?? explorerCwd;
                                if (sourceCwd) onAtMention(joinFilePath(sourceCwd, node.path), false);
                              }}
                              title={`@ ${node.path}`}
                              aria-label={`@ ${node.path}`}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                width: 18,
                                height: 18,
                                padding: 0,
                                border: "1px solid var(--border)",
                                background: "var(--bg-panel)",
                                color: "var(--accent)",
                                borderRadius: 3,
                                fontSize: 10,
                                fontWeight: 700,
                                cursor: "pointer",
                              }}
                            >
                              @
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              explorerRef.current?.expandToPath(fullPath);
                              if (!node.isDir) {
                                explorerRef.current?.locateFile(fullPath);
                              }
                              setSearchQuery("");
                            }}
                            title={t("files.locateInTree")}
                            aria-label={t("files.locateInTree")}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              width: 18,
                              height: 18,
                              padding: 0,
                              border: "none",
                              background: "none",
                              color: "var(--text-dim)",
                              cursor: "pointer",
                              borderRadius: 3,
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.color = "var(--accent)";
                              e.currentTarget.style.background = "var(--bg-hover)";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.color = "var(--text-dim)";
                              e.currentTarget.style.background = "none";
                            }}
                          >
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                              <circle cx="12" cy="12" r="3" />
                              <path d="M12 2v5M12 17v5M2 12h5M17 12h5" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              overflowX: "hidden",
              ...contentStyle,
              // Keep the tree mounted while searching so expandToPath state
              // (expandedPaths) survives clearing the query.
              display: searchQuery.trim().length > 0 ? "none" : undefined,
            }}
          >
            <FileExplorer
              ref={explorerRef}
              cwd={explorerCwd}
              remotePeer={remotePeer}
              activeFilePath={activeFilePath}
              onOpenFile={onOpenFile}
              onPathRenamed={onPathRenamed}
              refreshKey={explorerKey}
              onAtMention={onAtMention}
              onAtMentions={onAtMentions}
              onUploadBusyChange={setUploadBusy}
              changesCollapsed={changesCollapsed}
              onHiddenChange={setHiddenActive}
              onFilterChange={handleExplorerFilterChange}
            />
          </div>
        </>
      )}
    </>
  );
}
