"use client";

import Image from "next/image";
import { FilePlus2, FolderPlus, Upload } from "lucide-react";
import { forwardRef, useState, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { getFileIcon, FolderIcon } from "./FileIcons";
import { DismissButton } from "./DismissButton";
import {
  encodeFilePathForApi,
  getFileDirectory,
  getFileName,
  getRelativeFilePath,
  joinFilePath,
  normalizeFilePathSlashes,
} from "@/lib/file-paths";
import { apiPathForPeer } from "@/lib/file-api";
import { createLatestFileListing } from "@/lib/file-explorer-listing";
import type { GitCommitDetail, GitCommitSummary, GitFileStatus, GitFileStatusKind, GitStatusResponse } from "@/lib/git-types";
import type { GitHubReadOnlySnapshot, GitHubUnavailableReason } from "@/lib/git-github";
import type { GitAiMode } from "@/lib/git-summary";
import {
  DEFAULT_EXPLORER_FILTER,
  EXPLORER_FILTER_CHANGED_EVENT,
  HIDEABLE_FILE_EXTS,
  HIDEABLE_FOLDER_NAMES,
  customNamesToText,
  explorerFilterToQuery,
  getExplorerFilterProjectKey,
  loadStoredExplorerFilter,
  parseCustomNamesText,
  type ExplorerFilterSettings,
} from "@/lib/explorer-filter";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/hooks/useI18n";
import {
  captureRenameTarget,
  isRenameRequestCurrent,
  migrateRenamedPath,
  type RenameWorkspace,
} from "./file-explorer-rename-state";
type Translate = ReturnType<typeof useI18n>["t"];

interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
  isSymlink?: boolean;
  /** Link approval returned by older peer versions. */
  outsideLinkTarget?: string;
  /** That target contains the project or the home folder. */
  outsideLinkEncloses?: boolean;
}

interface FileNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  children?: FileNode[];
  loaded?: boolean;
  isSymlink?: boolean;
  outsideLinkTarget?: string;
  outsideLinkEncloses?: boolean;
}

type PendingFileDelete = FileNode & { cwd: string; peer?: string };
interface FileDeleteConfirmation {
  path: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

interface Props {
  cwd: string;
  /** Reader local patch: browse a remote device's files via /api/remote proxy. */
  remotePeer?: string;
  activeFilePath?: string | null;
  onOpenFile: (filePath: string, fileName: string, options?: OpenFileOptions) => void;
  onPathRenamed?: (oldPath: string, newPath: string, isDir: boolean, peer?: string) => void;
  refreshKey?: number;
  onAtMention?: (filePath: string, isDir: boolean) => void;
  onAtMentions?: (filePaths: string[]) => void;
  onUploadBusyChange?: (busy: boolean) => void;
  changesCollapsed: boolean;
  /** Eye-button state: true while any hiding rule is active (default). */
  onHiddenChange?: (hiddenActive: boolean) => void;
  /** Filter settings panel open state. */
  onFilterSettingsOpenChange?: (open: boolean) => void;
  /** Shares the loaded project filter with search and composer callers. */
  onFilterChange?: (filter: ExplorerFilterSettings) => void;
}

export type FileNavigationDirection = "next" | "previous";

export interface FileExplorerHandle {
  openUploadPicker: (directory?: string) => void;
  openCreate: (kind: CreateKind, directory?: string) => void;
  openFilterSettings: () => void;
  toggleFilterSettings: () => void;
  closeFilterSettings: () => void;
  navigateFile: (direction: FileNavigationDirection) => Promise<boolean>;
  expandToPath: (targetDir: string) => void;
  /** Eye button: reveal/restore all hidden entries (see impl). */
  toggleHiddenVisibility: () => void;
  locateFile: (filePath: string) => void;
}

type UploadPhase = "idle" | "checking" | "uploading";
type UploadConflictStrategy = "error" | "overwrite" | "skip";
type GitRepositoryState = "loading" | "repository" | "not-repository" | "error";
type GitAiState = "idle" | "loading" | "ready" | "error";
type GitHubClientState = "idle" | "loading" | "ready" | "error";
type GitHubTab = "pulls" | "issues" | "checks";
type GitWriteAction = "stage" | "commit" | "push" | "create-branch" | "create-pr";
interface PendingGitWrite {
  action: GitWriteAction;
  paths: string[];
  cwd: string;
  peer?: string;
  generation: number;
}
type GitInfo = Pick<GitStatusResponse, "branch" | "upstream" | "ahead" | "behind">;

const EMPTY_GIT_INFO: GitInfo = { branch: null, upstream: null, ahead: 0, behind: 0 };

interface UploadError {
  name: string;
  error: string;
}

interface UploadResponse {
  uploaded?: string[];
  skipped?: string[];
  errors?: UploadError[];
  conflicts?: string[];
  nonReplaceable?: string[];
  error?: string;
}

interface UploadSummary {
  context: FileExplorerRequestContext;
  uploaded: string[];
  skipped: string[];
  errors: UploadError[];
}

interface CreateResponse {
  created?: boolean;
  path?: string;
  name?: string;
  isDir?: boolean;
  error?: string;
}

type CreateKind = "file" | "folder";

interface PendingCreate {
  directory: string;
  kind: CreateKind;
}

interface DeleteResponse {
  error?: string;
}

interface RenameResponse {
  error?: string;
  path?: string;
}

interface PendingConflict {
  context: FileExplorerRequestContext;
  files: File[];
  conflicts: string[];
  nonReplaceable: string[];
}

async function responseError(res: Response, fallback: string): Promise<Error> {
  let message = `${fallback} (HTTP ${res.status})`;
  try {
    const data = await res.json() as { error?: string };
    if (data.error) message = data.error;
  } catch {
    // ignore non-JSON error bodies
  }
  return new Error(message);
}

export interface FileExplorerRequestContext {
  generation: number;
  requestId: number;
  cwd: string;
  peer?: string;
  targetDirectory: string;
}

export function isFileExplorerRequestCurrent(
  context: FileExplorerRequestContext,
  current: Pick<FileExplorerRequestContext, "generation" | "requestId" | "cwd" | "peer">,
): boolean {
  return context.generation === current.generation
    && context.requestId === current.requestId
    && context.cwd === current.cwd
    && context.peer === current.peer;
}

export function createUploadProgressHandler(
  context: FileExplorerRequestContext,
  isCurrent: (context: FileExplorerRequestContext) => boolean,
  setProgress: (progress: number) => void,
): (progress: number) => void {
  return (progress) => {
    if (isCurrent(context)) setProgress(progress);
  };
}

function apiFor(peer: string | undefined, path: string): string {
  return apiPathForPeer(peer, path);
}

function getPathWithinCwd(filePath: string, cwd: string): string | null {
  const normalizedFile = normalizeFilePathSlashes(filePath).replace(/\/$/, "");
  const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
  if (normalizedFile === normalizedCwd) return "";
  const prefix = normalizedCwd ? normalizedCwd + "/" : "/";
  if (!normalizedFile.startsWith(prefix)) return null;
  return normalizedFile.slice(prefix.length);
}

async function fetchEntries(dirPath: string, filter: ExplorerFilterSettings, peer?: string, signal?: AbortSignal): Promise<FileNode[]> {
  const encoded = encodeFilePathForApi(dirPath);
  const filterQuery = explorerFilterToQuery(filter);
  const res = await fetch(apiFor(peer, `files/${encoded}?type=list&${filterQuery}`), { signal });
  if (!res.ok) {
    let message = `Failed to load files (HTTP ${res.status})`;
    try {
      const data = await res.json() as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(message);
  }
  const data = await res.json() as { entries?: FileEntry[] };
  return (data.entries ?? []).map((e) => ({
    name: e.name,
    fullPath: joinFilePath(dirPath, e.name),
    isDir: e.isDir,
    size: e.size,
    children: e.isDir ? [] : undefined,
    loaded: !e.isDir,
    isSymlink: e.isSymlink,
    outsideLinkTarget: e.outsideLinkTarget,
    outsideLinkEncloses: e.outsideLinkEncloses,
  }));
}

// Sends the target the operator was shown, so a link pointed elsewhere since
// the listing is refused instead of granting a directory nobody looked at.
async function allowOutsideLink(linkPath: string, target: string, peer?: string): Promise<void> {
  const res = await fetch(apiFor(peer, `files/${encodeFilePathForApi(linkPath)}?type=allow-link`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target }),
  });
  if (!res.ok) throw await responseError(res, "Failed to allow the linked folder");
}

async function fetchGitStatus(cwd: string, peer?: string): Promise<GitStatusResponse> {
  const params = new URLSearchParams({ cwd });
  const res = await fetch(`${apiFor(peer, `git/status?${params.toString()}`)}`);
  if (!res.ok) throw new Error(`Failed to load Git status (HTTP ${res.status})`);
  return res.json() as Promise<GitStatusResponse>;
}

async function fetchGitHistory(cwd: string, peer?: string): Promise<GitCommitSummary[]> {
  const params = new URLSearchParams({ cwd, limit: "20" });
  const res = await fetch(`${apiFor(peer, `git/history?${params.toString()}`)}`);
  const body = await res.json().catch(() => ({})) as { history?: unknown; error?: unknown };
  if (!res.ok || !Array.isArray(body.history)) {
    throw new Error(typeof body.error === "string" ? body.error : `Failed to load Git history (HTTP ${res.status})`);
  }
  return body.history as GitCommitSummary[];
}

async function fetchGitCommitDetail(cwd: string, hash: string, peer?: string): Promise<GitCommitDetail> {
  const params = new URLSearchParams({ cwd, hash });
  const res = await fetch(`${apiFor(peer, `git/history?${params.toString()}`)}`);
  const body = await res.json().catch(() => ({})) as { detail?: unknown; error?: unknown };
  if (!res.ok || !body.detail || typeof body.detail !== "object") {
    throw new Error(typeof body.error === "string" ? body.error : `Failed to load commit (HTTP ${res.status})`);
  }
  return body.detail as GitCommitDetail;
}

async function fetchGitHubSnapshot(cwd: string, peer?: string): Promise<GitHubReadOnlySnapshot> {
  const params = new URLSearchParams({ cwd });
  const res = await fetch(`${apiFor(peer, `git/github?${params.toString()}`)}`);
  const body = await res.json().catch(() => ({})) as { snapshot?: unknown; error?: unknown };
  if (!res.ok || !body.snapshot || typeof body.snapshot !== "object" || typeof (body.snapshot as { available?: unknown }).available !== "boolean") {
    throw new Error(typeof body.error === "string" ? body.error : `Failed to load GitHub data (HTTP ${res.status})`);
  }
  return body.snapshot as GitHubReadOnlySnapshot;
}

async function revealInFileManager(filePath: string, peer?: string): Promise<void> {
  const response = await fetch(`${apiFor(peer, "files/reveal")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath }),
  });
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(body?.error || `Unable to open folder (HTTP ${response.status})`);
}

const GIT_STATUS_KEYS: Record<GitFileStatusKind, string> = {
  modified: "files.modified",
  added: "files.added",
  deleted: "files.deleted",
  renamed: "files.renamed",
  untracked: "files.untracked",
  conflict: "files.conflict",
};

const GIT_STATUS_COLORS: Record<GitFileStatusKind, string> = {
  modified: "#b45309",
  added: "#16a34a",
  deleted: "#dc2626",
  renamed: "#2563eb",
  untracked: "#16a34a",
  conflict: "#dc2626",
};

function GitStatusBadge({ status, t }: { status: GitFileStatus; t: Translate }) {
  return (
    <span
      title={t(GIT_STATUS_KEYS[status.status])}
      aria-label={t(GIT_STATUS_KEYS[status.status])}
      style={{
        width: 14,
        height: 14,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: GIT_STATUS_COLORS[status.status],
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {status.code}
    </span>
  );
}

function uploadFiles(
  targetDirectory: string,
  files: File[],
  strategy: UploadConflictStrategy,
  onProgress: (progress: number) => void,
  peer?: string,
): Promise<{ status: number; data: UploadResponse }> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    files.forEach((file) => formData.append("files", file, file.name));

    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      apiFor(peer, `files/${encodeFilePathForApi(targetDirectory)}?type=upload&conflict=${strategy}`),
    );
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new Error("Network error while uploading files"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.onload = () => {
      let data: UploadResponse = {};
      try {
        data = JSON.parse(xhr.responseText) as UploadResponse;
      } catch {
        if (xhr.responseText) data.error = xhr.responseText;
      }
      resolve({ status: xhr.status, data });
    };
    xhr.send(formData);
  });
}

async function createPath(
  targetDirectory: string,
  name: string,
  kind: CreateKind,
  peer?: string,
): Promise<CreateResponse> {
  const type = kind === "folder" ? "create-folder" : "create-file";
  const response = await fetch(apiFor(peer, `files/${encodeFilePathForApi(targetDirectory)}?type=${type}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await response.json().catch(() => ({})) as CreateResponse;
  if (!response.ok || typeof data.path !== "string") {
    throw new Error(data.error ?? `Failed to create item (HTTP ${response.status})`);
  }
  return data;
}

export function FileActionIcon({ kind, size = 14 }: { kind: "folder" | "file" | "upload"; size?: number }) {
  const Icon = kind === "folder" ? FolderPlus : kind === "file" ? FilePlus2 : Upload;
  return <Icon size={size} strokeWidth={1.8} aria-hidden="true" />;
}

export function FileActionMenuItem({
  kind,
  label,
  onClick,
  disabled = false,
}: {
  kind: "folder" | "file" | "upload";
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", minHeight: 30, padding: "0 8px", border: 0, borderRadius: 3, background: "transparent", color: disabled ? "var(--text-dim)" : "var(--text)", cursor: disabled ? "default" : "pointer", textAlign: "left", fontSize: 11 }}
    >
      <FileActionIcon kind={kind} />
      <span>{label}</span>
    </button>
  );
}

async function movePathToTrash(filePath: string, peer?: string): Promise<void> {
  const res = await fetch(apiFor(peer, `files/${encodeFilePathForApi(filePath)}`), { method: "DELETE" });
  const data = await res.json().catch(() => ({})) as DeleteResponse;
  if (!res.ok) throw new Error(data.error ?? `Failed to move item to trash (HTTP ${res.status})`);
}

async function renamePath(filePath: string, name: string, peer?: string): Promise<string> {
  const res = await fetch(apiFor(peer, `files/${encodeFilePathForApi(filePath)}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await res.json().catch(() => ({})) as RenameResponse;
  if (!res.ok) throw new Error(data.error ?? `Failed to rename item (HTTP ${res.status})`);
  if (!data.path) throw new Error("Rename response missing path");
  return data.path;
}

function MentionIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </svg>
  );
}

function OutsideLinkIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

export function TreeNode({
  node,
  depth,
  cwd,
  peer,
  onOpenFile,
  onAtMention,
  expandedPaths,
  onToggleExpanded,
  refreshToken,
  highlightedPaths,
  locatedPath,
  filter,
  gitStatusByPath,
  changedDirectoryPaths,
  t,
  onRequestDelete,
  deleteConfirmation,
  onRequestRename,
  onRequestCreate,
  onRequestUpload,
  dropTargetPath,
  onDropFiles,
  onDropTargetChange,
  onChildrenLoaded,
  onChildrenLoadSettled,
}: {
  node: FileNode;
  depth: number;
  cwd: string;
  peer?: string;
  onOpenFile: (filePath: string, fileName: string, options?: OpenFileOptions) => void;
  onAtMention?: (filePath: string, isDir: boolean) => void;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  refreshToken: string;
  highlightedPaths: Set<string>;
  locatedPath: string | null;
  filter: ExplorerFilterSettings;
  gitStatusByPath: Map<string, GitFileStatus>;
  changedDirectoryPaths: Set<string>;
  t: Translate;
  onRequestDelete: (node: FileNode) => void;
  deleteConfirmation?: FileDeleteConfirmation;
  onRequestRename: (node: FileNode) => void;
  onRequestCreate: (directory: string, kind: CreateKind) => void;
  onRequestUpload: (directory: string) => void;
  dropTargetPath?: string | null;
  onDropFiles?: (directory: string, files: File[]) => void;
  onDropTargetChange?: (path: string | null) => void;
  onChildrenLoaded: (directory: string, entries: FileNode[]) => void;
  onChildrenLoadSettled: (directory: string) => void;
}) {
  const open = expandedPaths.has(node.fullPath);
  const isDropTarget = node.isDir && dropTargetPath === node.fullPath;
  const highlighted = highlightedPaths.has(node.fullPath);
  const normalizedPath = normalizeFilePathSlashes(node.fullPath);
  const located = locatedPath === normalizedPath;
  const confirmingDelete = deleteConfirmation?.path === node.fullPath ? deleteConfirmation : null;
  const rowRef = useRef<HTMLDivElement>(null);
  const gitStatus = gitStatusByPath.get(normalizedPath);
  const containsGitChanges = node.isDir && (
    gitStatus !== undefined || changedDirectoryPaths.has(normalizedPath)
  );
  const [children, setChildren] = useState<FileNode[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const childListingsRef = useRef(createLatestFileListing<FileNode[]>());

  useEffect(() => () => childListingsRef.current.cancel(), []);
  const [hovered, setHovered] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!located) return;
    rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [children.length, loaded, located, open]);

  const [revealBusy, setRevealBusy] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [openBusy, setOpenBusy] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [copyBusy, setCopyBusy] = useState<"relative" | "absolute" | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  // 二级菜单：main = 打开操作；apps = 应用列表（点「选择其他应用…」进入）。
  const [openMenuView, setOpenMenuView] = useState<"main" | "apps" | "add">("main");
  const [openApps, setOpenApps] = useState<Array<{ id: string; label: string }> | null>(null);
  const [addableApps, setAddableApps] = useState<Array<{ id: string; label: string }> | null>(null);
  const [appSearch, setAppSearch] = useState("");
  const [preferredApp, setPreferredApp] = useState<string | null>(() => {
    try {
      const stored = localStorage.getItem(`pi-web-open-app:${peer ?? "local"}`);
      return stored && stored !== "default" ? stored : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (!contextMenu) return;
    const close = (event?: Event) => {
      if (event?.target instanceof Element && event.target.closest("[data-file-context-menu]")) return;
      setContextMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("contextmenu", close, true);
    document.addEventListener("focusin", close);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("contextmenu", close, true);
      document.removeEventListener("focusin", close);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  const handleReveal = useCallback(async () => {
    if (revealBusy) return;
    setRevealBusy(true);
    setRevealError(null);
    try {
      await revealInFileManager(node.fullPath, peer);
      setContextMenu(null);
    } catch (error) {
      setRevealError(error instanceof Error ? error.message : String(error));
    } finally {
      setRevealBusy(false);
    }
  }, [node.fullPath, peer, revealBusy]);

  const handleCopyPath = useCallback(async (kind: "relative" | "absolute") => {
    if (copyBusy) return;
    setCopyBusy(kind);
    setCopyError(null);
    try {
      const value = kind === "relative" ? getRelativeFilePath(node.fullPath, cwd) : node.fullPath;
      await copyText(value);
      setContextMenu(null);
    } catch (error) {
      setCopyError(error instanceof Error && error.message ? error.message : t("files.copyPathFailed"));
    } finally {
      setCopyBusy(null);
    }
  }, [copyBusy, cwd, node.fullPath, t]);

  // 用数据所属设备的指定应用打开文件本身（peer 经 /api/remote 代理；appId 空 = 系统默认）。
  const runOpenWithApp = useCallback(async (appId: string | null) => {
    if (openBusy) return;
    setOpenBusy(true);
    setOpenError(null);
    try {
      const response = await fetch(apiFor(peer, "files/open"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: node.fullPath, app: appId ?? undefined }),
      });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      setContextMenu(null);
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpenBusy(false);
    }
  }, [node.fullPath, openBusy, peer]);

  const openWithPreferredApp = useCallback(() => {
    void runOpenWithApp(preferredApp);
  }, [preferredApp, runOpenWithApp]);

  // 展开「选择其他应用…」时懒加载设备应用清单（peer 代理同路径，按文件类型过滤）。
  const openAppPicker = useCallback(() => {
    setAppSearch("");
    setOpenMenuView("apps");
    setOpenApps((current) => {
      if (current) return current;
      const fileExt = node.fullPath.toLowerCase().split(".").pop() ?? "";
      void fetch(apiFor(peer, `files/open-apps?ext=${encodeURIComponent(fileExt)}`))
        .then((response) => response.json())
        .then((body: { apps?: Array<{ id: string; label: string }> } | null) => {
          if (body?.apps) setOpenApps(body.apps);
        })
        .catch(() => { /* ignore: 菜单显示「应用清单不可用」 */ });
      return current;
    });
  }, [node.fullPath, peer]);

  const chooseOpenApp = useCallback((appId: string | null) => {
    try {
      localStorage.setItem(`pi-web-open-app:${peer ?? "local"}`, appId ?? "default");
    } catch { /* ignore */ }
    setPreferredApp(appId);
    void runOpenWithApp(appId);
  }, [peer, runOpenWithApp]);

  // 增删应用清单（写持有文件设备——peer 场景经代理写对端 open-apps.json）。
  const removeOpenApp = useCallback(async (appId: string) => {
    setOpenBusy(true);
    setOpenError(null);
    try {
      const response = await fetch(apiFor(peer, "files/open-apps"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", appId }),
      });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      setOpenApps((current) => current?.filter((app) => app.id !== appId) ?? current);
      if (preferredApp === appId) {
        try { localStorage.removeItem(`pi-web-open-app:${peer ?? "local"}`); } catch { /* ignore */ }
        setPreferredApp(null);
      }
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpenBusy(false);
    }
  }, [peer, preferredApp]);

  const openAddAppView = useCallback(() => {
    setOpenMenuView("add");
    setAppSearch("");
    setAddableApps((current) => {
      if (current) return current;
      void fetch(apiFor(peer, "files/open-apps"))
        .then((response) => response.json())
        .then((body: { apps?: Array<{ id: string; label: string }> } | null) => {
          const allApps = body?.apps;
          if (!allApps) return;
          setOpenApps((shown) => {
            const shownIds = new Set((shown ?? []).map((app) => app.id));
            setAddableApps(allApps.filter((app) => !shownIds.has(app.id)));
            return shown;
          });
        })
        .catch(() => setAddableApps([]));
      return current;
    });
  }, [peer]);

  const addOpenApp = useCallback(async (appId: string) => {
    setOpenBusy(true);
    setOpenError(null);
    try {
      const response = await fetch(apiFor(peer, "files/open-apps"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add", appId }),
      });
      const body = await response.json().catch(() => null) as { apps?: Array<{ id: string; label: string }>; error?: string } | null;
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      setAddableApps((current) => current?.filter((app) => app.id !== appId) ?? current);
      if (body?.apps) {
        const added = body.apps.find((app) => app.id === appId);
        if (added) setOpenApps((current) => [...(current ?? []), added]);
      }
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpenBusy(false);
    }
  }, [peer]);

  const handleContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setRevealError(null);
    setCopyError(null);
    setOpenMenuView("main");
    setContextMenu({
      x: Math.min(event.clientX, Math.max(8, window.innerWidth - 218)),
      y: Math.min(event.clientY, Math.max(8, window.innerHeight - 205)),
    });
  }, []);
  const [allowedLinkTarget, setAllowedLinkTarget] = useState<string | null>(null);
  const [allowingLink, setAllowingLink] = useState(false);
  const [allowLinkError, setAllowLinkError] = useState<string | null>(null);
  // A link leading outside the project is refused until the operator allows
  // its target, so it asks for that instead of listing (#748).
  const pendingLinkTarget = node.outsideLinkTarget && node.outsideLinkTarget !== allowedLinkTarget
    ? node.outsideLinkTarget
    : null;

  // A listing that reports the link again (a server restart forgets allowed
  // targets, or the link was pointed elsewhere) needs a new decision.
  useEffect(() => {
    setAllowedLinkTarget(null);
    setAllowLinkError(null);
  }, [node, peer, cwd]);

  const loadChildren = useCallback(async (force = false, allowPendingLink = false) => {
    if (pendingLinkTarget && !allowPendingLink) return;
    if (!force && (loaded || childListingsRef.current.pending)) return;
    await childListingsRef.current.run(
      (signal) => fetchEntries(node.fullPath, filter, peer, signal),
      {
        start: () => { setLoading(true); setLoadError(null); },
        success: (entries) => {
          setChildren(entries);
          setLoaded(true);
          onChildrenLoaded(node.fullPath, entries);
        },
        error: (error) => setLoadError(error instanceof Error ? error.message : String(error)),
        finish: () => {
          setLoading(false);
          onChildrenLoadSettled(node.fullPath);
        },
      },
    );
  }, [filter, loaded, node.fullPath, peer, pendingLinkTarget]);

  // Re-fetch open directories when the tree refreshes or filter/sort settings change.
  // Mark closed directories stale too, so reopening them uses the new order.
  useEffect(() => {
    childListingsRef.current.cancel();
    if (!node.isDir) return;
    setLoaded(false);
    setLoading(false);
    if (open) void loadChildren(true);
    // Reload only when the directory identity/settings change, not when loaded changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken, filter, node.fullPath, node.isDir, peer]);

  // Load children as soon as a directory becomes open (covers expandToPath
  // from file search, where expandedPaths changes without a click).
  useEffect(() => {
    if (node.isDir && open && !loaded && !pendingLinkTarget) loadChildren();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, node.isDir, pendingLinkTarget]);

  const handleClick = useCallback(() => {
    if (node.isDir) {
      const next = !open;
      onToggleExpanded(node.fullPath, next);
      if (next && !loaded && !pendingLinkTarget) loadChildren();
    } else {
      onOpenFile(node.fullPath, node.name);
    }
  }, [node.isDir, node.fullPath, node.name, loaded, open, pendingLinkTarget, loadChildren, onOpenFile, onToggleExpanded]);

  const handleAllowLink = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!pendingLinkTarget) return;
    // A link to `/`, `~` or a parent of the project opens far more than a
    // sibling folder, and a cloned repository can contain one.
    if (node.outsideLinkEncloses && !window.confirm(t("files.allowEnclosingLinkConfirm", { target: pendingLinkTarget }))) {
      return;
    }
    setAllowingLink(true);
    setAllowLinkError(null);
    try {
      await allowOutsideLink(node.fullPath, pendingLinkTarget, peer);
      setAllowedLinkTarget(pendingLinkTarget);
      await loadChildren(true, true);
    } catch (error) {
      setAllowLinkError(error instanceof Error ? error.message : String(error));
    } finally {
      setAllowingLink(false);
    }
  }, [node.fullPath, node.outsideLinkEncloses, pendingLinkTarget, loadChildren, peer, t]);

  return (
    <div>
      <div
        ref={rowRef}
        data-file-tree-path={normalizedPath}
        data-file-tree-located={located ? "true" : undefined}
        onClick={confirmingDelete ? undefined : handleClick}
        onContextMenu={confirmingDelete ? undefined : handleContextMenu}
        onDragOver={node.isDir ? (event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "copy";
          onDropTargetChange?.(node.fullPath);
        } : undefined}
        onDrop={node.isDir ? (event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.stopPropagation();
          onDropTargetChange?.(null);
          onDropFiles?.(node.fullPath, Array.from(event.dataTransfer.files));
        } : undefined}
        onKeyDown={(event) => {
          if (confirmingDelete && event.key === "Escape" && !confirmingDelete.busy) {
            event.preventDefault();
            event.stopPropagation();
            confirmingDelete.onCancel();
          }
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          position: "relative",
          display: confirmingDelete ? "grid" : "flex",
          gridTemplateColumns: confirmingDelete ? "minmax(0, 1fr) max-content" : undefined,
          alignItems: "center",
          gap: 4,
          paddingLeft: confirmingDelete ? 8 : 8 + depth * 14,
          paddingRight: 8,
          height: "var(--file-tree-row-height)",
          cursor: confirmingDelete ? "default" : "pointer",
          background: (typeof isDropTarget !== "undefined" && isDropTarget) ? "color-mix(in srgb, var(--accent) 16%, transparent)" : confirmingDelete ? "rgba(239,68,68,0.08)" : located ? "rgba(37,99,235,0.16)" : hovered ? "var(--bg-hover)" : "transparent",
          boxShadow: confirmingDelete ? "inset 3px 0 0 #ef4444" : located ? "inset 3px 0 0 #3b82f6, 0 0 0 1px rgba(59,130,246,0.28), 0 0 8px rgba(59,130,246,0.18)" : undefined,
          outline: isDropTarget ? "1px dashed var(--accent)" : "none",
          outlineOffset: -1,
          borderRadius: 4,
          userSelect: "none",
        }}
      >
        {node.isDir && !confirmingDelete && (
          <svg
            width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.1s" }}
          >
            <polyline points="3 2 7 5 3 8" />
          </svg>
        )}
        {!node.isDir && !confirmingDelete && <span style={{ width: 10, flexShrink: 0 }} />}
        {!confirmingDelete && (
          <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
            {node.isDir ? <FolderIcon size={14} open={open} /> : getFileIcon(node.name, 14)}
          </span>
        )}
        <span
          style={{
            minWidth: 0,
            fontSize: 12,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
          title={node.fullPath}
        >
          {node.name}
        </span>
        {confirmingDelete && (
          <div data-file-delete-confirm="true" style={{ display: "flex", gap: 4, flexShrink: 0 }}>
            <button
              type="button"
              disabled={confirmingDelete.busy}
              title={t("files.deleteConfirm", { name: node.name })}
              aria-label={t("files.deleteConfirm", { name: node.name })}
              onClick={(event) => { event.stopPropagation(); confirmingDelete.onConfirm(); }}
              style={{ height: "calc(var(--file-tree-row-height) - 2px)", padding: "0 8px", border: 0, borderRadius: 4, background: "#ef4444", color: "#fff", cursor: confirmingDelete.busy ? "wait" : "pointer", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}
            >
              {confirmingDelete.busy ? t("files.deleting") : t("sidebar.confirm")}
            </button>
            <button
              type="button"
              autoFocus
              disabled={confirmingDelete.busy}
              onClick={(event) => { event.stopPropagation(); confirmingDelete.onCancel(); }}
              style={{ height: "calc(var(--file-tree-row-height) - 2px)", padding: "0 8px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text-muted)", cursor: confirmingDelete.busy ? "wait" : "pointer", fontSize: 11, whiteSpace: "nowrap" }}
            >
              {t("files.cancel")}
            </button>
          </div>
        )}
        {!hovered && !confirmingDelete && pendingLinkTarget && (
          <span
            title={t("files.outsideLink", { target: pendingLinkTarget })}
            aria-label={t("files.outsideLink", { target: pendingLinkTarget })}
            style={{ width: 14, height: 14, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)" }}
          >
            <OutsideLinkIcon />
          </span>
        )}
        {highlighted && !confirmingDelete && (
          <span
            title={t("files.newlyUploaded")}
            aria-label={t("files.newlyUploaded")}
            style={{ width: 14, height: 14, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#3b82f6" }} />
          </span>
        )}
        {!hovered && !confirmingDelete && !node.isDir && gitStatus && (
          <GitStatusBadge status={gitStatus} t={t} />
        )}
        {!hovered && !confirmingDelete && containsGitChanges && (
          <span
            title={t("files.containsChangedFiles")}
            aria-label={t("files.containsChangedFiles")}
            style={{
              width: 14,
              height: 14,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#d6a84b" }} />
          </span>
        )}
        {loading && !confirmingDelete && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
          </svg>
        )}
        {onAtMention && hovered && !confirmingDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAtMention(node.fullPath, node.isDir);
            }}
            title={t("files.insertPath")}
            style={{
              position: "absolute",
              right: !node.isDir ? "calc(4px + var(--file-tree-action-step) + var(--file-tree-action-step))" : "calc(4px + var(--file-tree-action-step))",
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 8px",
              height: "var(--file-tree-action-size)",
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            <MentionIcon />
            {t("files.mention")}
          </button>
        )}
        {hovered && !node.isDir && !confirmingDelete && (
          <a
            href={apiFor(peer, `files/${encodeFilePathForApi(node.fullPath)}?type=download`)}
            download
            onClick={(e) => e.stopPropagation()}
            title={t("files.download")}
            style={{
              position: "absolute",
              right: "calc(4px + var(--file-tree-action-step))",
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 5px",
              minWidth: "var(--file-tree-action-size)",
              height: "var(--file-tree-action-size)",
              boxSizing: "border-box",
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
              textDecoration: "none",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </a>
        )}
        {hovered && !confirmingDelete && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onRequestDelete(node);
            }}
            title={t("files.delete")}
            aria-label={t("files.delete")}
            style={{
              position: "absolute",
              right: 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "var(--file-tree-action-size)",
              height: "var(--file-tree-action-size)",
              padding: 0,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "#f87171",
              cursor: "pointer",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            </svg>
          </button>
        )}
      </div>
      {confirmingDelete && confirmingDelete.error && (
        <div role="alert" style={{ paddingLeft: 8, paddingRight: 8, paddingTop: 3, paddingBottom: 5, color: "#ef4444", fontSize: 11, overflowWrap: "anywhere" }}>
          {t("files.deleteFailed")}: {confirmingDelete.error}
        </div>
      )}
      {contextMenu && (
        <div
          data-file-context-menu="true"
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
          style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, zIndex: 300, minWidth: 190, padding: 4, border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg-panel)", boxShadow: "0 8px 24px rgba(0,0,0,0.18)" }}
        >
          {node.isDir && (
            <>
              <FileActionMenuItem kind="folder" label={t("files.newFolder")} onClick={() => { setContextMenu(null); onRequestCreate(node.fullPath, "folder"); }} />
              <FileActionMenuItem kind="file" label={t("files.newDocument")} onClick={() => { setContextMenu(null); onRequestCreate(node.fullPath, "file"); }} />
              <FileActionMenuItem kind="upload" label={t("files.uploadHere")} onClick={() => { setContextMenu(null); onRequestUpload(node.fullPath); }} />
              <div style={{ margin: "4px 0", borderTop: "1px solid var(--border)" }} />
            </>
          )}
          <button type="button" role="menuitem" onClick={() => void openWithPreferredApp()} disabled={openBusy} style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", minHeight: 30, padding: "0 8px", border: 0, borderRadius: 3, background: "transparent", color: "var(--text)", cursor: openBusy ? "wait" : "pointer", textAlign: "left", fontSize: 11 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 3h6v6" />
              <path d="M10 14 21 3" />
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            </svg>
            {openBusy ? t("files.openingWithDefaultApp") : preferredApp ? t("files.openWithApp", { app: preferredApp }) : t("files.openWithDefaultApp")}
          </button>
          <button type="button" role="menuitem" onClick={openAppPicker} style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", minHeight: 30, padding: "0 8px", border: 0, borderRadius: 3, background: "transparent", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m9 18 6-6-6-6" />
            </svg>
            {t("files.chooseOtherApp")}
          </button>
          {openMenuView !== "main" && (
            <div role="menu" data-file-context-menu="true" style={{ marginTop: 4, paddingTop: 4, borderTop: "1px solid var(--border)" }}>
              <button type="button" role="menuitem" onClick={() => setOpenMenuView("main")} style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", minHeight: 28, padding: "0 8px", border: 0, borderRadius: 3, background: "transparent", color: "var(--text-dim)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m15 18-6-6 6-6" />
                </svg>
                {t("files.back")}
              </button>
              <input
                type="search"
                value={appSearch}
                onChange={(event) => setAppSearch(event.target.value)}
                placeholder={t("files.searchApps")}
                aria-label={t("files.searchApps")}
                autoFocus
                style={{ width: "calc(100% - 16px)", margin: "2px 8px 4px", padding: "5px 8px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)", fontSize: 11, outline: "none" }}
              />
              {openMenuView === "add" ? (
                <div style={{ maxHeight: 260, overflowY: "auto" }}>
                  {(addableApps ?? [])
                    .filter((app) => app.label.toLowerCase().includes(appSearch.trim().toLowerCase()))
                    .map((app) => (
                      <button key={app.id} type="button" role="menuitem" onClick={() => void addOpenApp(app.id)} style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", minHeight: 30, padding: "0 8px", border: 0, borderRadius: 3, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>
                        <span style={{ flex: "0 0 auto", width: 16, color: "var(--accent)", textAlign: "center" }}>+</span>
                        <Image unoptimized
                          src={apiFor(peer, `files/open-apps/${encodeURIComponent(app.id)}/icon`)}
                          alt=""
                          width={16}
                          height={16}
                          style={{ flex: "0 0 16px", objectFit: "contain" }}
                          onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
                        />
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{app.label}</span>
                      </button>
                    ))}
                  {addableApps !== null && addableApps.filter((app) => app.label.toLowerCase().includes(appSearch.trim().toLowerCase())).length === 0 && (
                    <div style={{ padding: "6px 8px", color: "var(--text-muted)", fontSize: 10 }}>{t("files.noMatchingApps")}</div>
                  )}
                  {addableApps === null && (
                    <div style={{ padding: "6px 8px", color: "var(--text-muted)", fontSize: 10 }}>{t("files.appListUnavailable")}</div>
                  )}
                </div>
              ) : (
                <div style={{ maxHeight: 260, overflowY: "auto" }}>
                  <button type="button" role="menuitem" onClick={() => chooseOpenApp(null)} style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", minHeight: 30, padding: "0 8px", border: 0, borderRadius: 3, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>
                    <span style={{ flex: "0 0 auto", width: 16, color: preferredApp === null ? "var(--accent)" : "transparent", textAlign: "center" }}>✓</span>
                    <span style={{ flex: "0 0 auto", width: 16 }} aria-hidden="true" />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("files.openWithDefaultApp")}</span>
                  </button>
                  {(openApps ?? [])
                    .filter((app) => app.label.toLowerCase().includes(appSearch.trim().toLowerCase()))
                    .map((app) => (
                      <div key={app.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <button type="button" role="menuitem" onClick={() => chooseOpenApp(app.id)} style={{ display: "flex", alignItems: "center", gap: 6, flex: "1 1 auto", minWidth: 0, minHeight: 30, padding: "0 8px", border: 0, borderRadius: 3, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>
                          <span style={{ flex: "0 0 auto", width: 16, color: preferredApp === app.id ? "var(--accent)" : "transparent", textAlign: "center" }}>✓</span>
                          <Image unoptimized
                            src={apiFor(peer, `files/open-apps/${encodeURIComponent(app.id)}/icon`)}
                            alt=""
                            width={16}
                            height={16}
                            style={{ flex: "0 0 16px", objectFit: "contain" }}
                            onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
                          />
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{app.label}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeOpenApp(app.id)}
                          title={t("files.removeApp")}
                          aria-label={t("files.removeApp")}
                          style={{ flex: "0 0 auto", width: 22, height: 22, padding: 0, border: 0, borderRadius: 3, background: "transparent", color: "var(--text-dim)", cursor: "pointer", fontSize: 13, lineHeight: 1 }}
                        >
                          −
                        </button>
                      </div>
                    ))}
                  {openApps !== null && openApps.filter((app) => app.label.toLowerCase().includes(appSearch.trim().toLowerCase())).length === 0 && (
                    <div style={{ padding: "6px 8px", color: "var(--text-muted)", fontSize: 10 }}>{t("files.noMatchingApps")}</div>
                  )}
                  {openApps === null && (
                    <div style={{ padding: "6px 8px", color: "var(--text-muted)", fontSize: 10 }}>{t("files.appListUnavailable")}</div>
                  )}
                  <button type="button" role="menuitem" onClick={openAddAppView} style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", minHeight: 30, marginTop: 2, padding: "0 8px", border: 0, borderTop: "1px solid var(--border)", borderRadius: 0, background: "transparent", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>
                    <span style={{ flex: "0 0 auto", width: 16, color: "var(--accent)", textAlign: "center" }}>+</span>
                    <span style={{ flex: "0 0 auto", width: 16 }} aria-hidden="true" />
                    <span>{t("files.addApp")}</span>
                  </button>
                </div>
              )}
            </div>
          )}
          <button type="button" role="menuitem" onClick={() => { setContextMenu(null); onRequestRename(node); }} style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", minHeight: 30, padding: "0 8px", border: 0, borderRadius: 3, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z" />
            </svg>
            {t(node.isDir ? "files.renameFolder" : "files.renameFile")}
          </button>
          <button type="button" role="menuitem" onClick={() => void handleCopyPath("relative")} disabled={copyBusy !== null} style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", minHeight: 30, padding: "0 8px", border: 0, borderRadius: 3, background: "transparent", color: "var(--text)", cursor: copyBusy !== null ? "wait" : "pointer", textAlign: "left", fontSize: 11 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="11" height="11" rx="1.5" />
              <path d="M5 15V5.5A1.5 1.5 0 0 1 6.5 4H15" />
            </svg>
            {copyBusy === "relative" ? t("files.copyingPath") : t("files.copyRelativePath")}
          </button>
          <button type="button" role="menuitem" onClick={() => void handleCopyPath("absolute")} disabled={copyBusy !== null} style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", minHeight: 30, padding: "0 8px", border: 0, borderRadius: 3, background: "transparent", color: "var(--text)", cursor: copyBusy !== null ? "wait" : "pointer", textAlign: "left", fontSize: 11 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="11" height="11" rx="1.5" />
              <path d="M5 15V5.5A1.5 1.5 0 0 1 6.5 4H15" />
            </svg>
            {copyBusy === "absolute" ? t("files.copyingPath") : t("files.copyAbsolutePath")}
          </button>
          {copyError && <div role="alert" style={{ padding: "5px 8px", color: "#dc2626", fontSize: 10, overflowWrap: "anywhere" }}>{copyError}</div>}
          {openError && <div role="alert" style={{ padding: "5px 8px", color: "#dc2626", fontSize: 10, overflowWrap: "anywhere" }}>{openError}</div>}
          <button type="button" role="menuitem" onClick={() => void handleReveal()} disabled={revealBusy} style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", minHeight: 30, padding: "0 8px", border: 0, borderRadius: 3, background: "transparent", color: "var(--text)", cursor: revealBusy ? "wait" : "pointer", textAlign: "left", fontSize: 11 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 10.5 12 3l9 7.5" />
              <path d="M5 9.5V21h14V9.5" />
              <path d="M9 21v-6h6v6" />
            </svg>
            {revealBusy ? t("files.openingFolder") : t("files.openInFolder")}
          </button>
          {revealError && <div role="alert" style={{ padding: "5px 8px", color: "#dc2626", fontSize: 10, overflowWrap: "anywhere" }}>{revealError}</div>}
        </div>
      )}
      {node.isDir && open && pendingLinkTarget && (
        <div
          style={{
            paddingLeft: 8 + (depth + 1) * 14,
            paddingRight: 8,
            paddingTop: 3,
            paddingBottom: 5,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: 4,
            fontSize: 11,
            color: "var(--text-dim)",
          }}
        >
          <span style={{ wordBreak: "break-all" }}>{t("files.outsideLink", { target: pendingLinkTarget })}</span>
          {node.outsideLinkEncloses && (
            <span style={{ color: "#f59e0b" }}>{t("files.outsideLinkEncloses")}</span>
          )}
          <button
            type="button"
            onClick={handleAllowLink}
            disabled={allowingLink}
            title={t("files.allowOutsideLinkTitle", { target: pendingLinkTarget })}
            style={{
              height: 20,
              padding: "0 8px",
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--accent)",
              cursor: allowingLink ? "default" : "pointer",
              opacity: allowingLink ? 0.6 : 1,
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            {t("files.allowOutsideLink")}
          </button>
          {allowLinkError && (
            <span role="alert" style={{ color: "#f87171", wordBreak: "break-word" }}>{allowLinkError}</span>
          )}
        </div>
      )}
      {node.isDir && open && !pendingLinkTarget && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={`${peer ?? "local"}:${cwd}:${child.fullPath}`}
              node={child}
              depth={depth + 1}
              cwd={cwd}
              peer={peer}
              onOpenFile={onOpenFile}
              onAtMention={onAtMention}
              expandedPaths={expandedPaths}
              onToggleExpanded={onToggleExpanded}
              refreshToken={refreshToken}
              highlightedPaths={highlightedPaths}
              locatedPath={locatedPath}
              filter={filter}
              gitStatusByPath={gitStatusByPath}
              changedDirectoryPaths={changedDirectoryPaths}
              t={t}
              onRequestDelete={onRequestDelete}
              deleteConfirmation={deleteConfirmation}
              onRequestRename={onRequestRename}
              onRequestCreate={onRequestCreate}
              onRequestUpload={onRequestUpload}
              dropTargetPath={dropTargetPath}
              onDropFiles={onDropFiles}
              onDropTargetChange={onDropTargetChange}
              onChildrenLoaded={onChildrenLoaded}
              onChildrenLoadSettled={onChildrenLoadSettled}
            />
          ))}
          {children.length === 0 && loaded && !loadError && (
            <div style={{ paddingLeft: 8 + (depth + 1) * 14, fontSize: 11, color: "var(--text-dim)", height: 22, display: "flex", alignItems: "center" }}>
              empty
            </div>
          )}
          {loadError && (
            <div role="alert" style={{ paddingLeft: 8 + (depth + 1) * 14, paddingRight: 8, paddingTop: 3, paddingBottom: 3, fontSize: 11, color: "#f87171", wordBreak: "break-word" }}>
              {loadError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type OpenFileOptions = { sourceSessionId?: string | null; modeHint?: "diff"; reuseActiveTab?: boolean };

type OpenFileHandler = (filePath: string, fileName: string, options?: OpenFileOptions) => void;

function ChangeRow({
  status,
  cwd,
  onOpenFile,
  t,
}: {
  status: GitFileStatus;
  cwd: string;
  onOpenFile: OpenFileHandler;
  t: Translate;
}) {
  const [hovered, setHovered] = useState(false);
  const name = getFileName(status.filePath);
  const rel = getRelativeFilePath(status.filePath, cwd);
  const dir = rel.length > name.length ? rel.slice(0, rel.length - name.length).replace(/\/$/, "") : "";

  return (
    <div
      onClick={() => onOpenFile(status.filePath, name, { modeHint: "diff" })}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={status.filePath}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        paddingLeft: 10,
        paddingRight: 10,
        height: "var(--file-change-row-height)",
        cursor: "pointer",
        background: hovered ? "var(--bg-hover)" : "transparent",
        borderRadius: 4,
        userSelect: "none",
      }}
    >
      <span style={{ flexShrink: 0, display: "flex", alignItems: "center", opacity: 0.85 }}>
        {getFileIcon(name, 13)}
      </span>
      <span
        style={{
          fontSize: 12,
          color: "var(--text)",
          fontWeight: 500,
          flexShrink: 0,
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </span>
      {dir && (
        <span
          style={{
            fontSize: 10,
            color: "var(--text-dim)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            direction: "rtl",
            textAlign: "left",
            flex: 1,
            minWidth: 0,
            opacity: 0.7,
            fontFamily: "var(--font-mono)",
          }}
        >
          {dir}
        </span>
      )}
      <div style={{ marginLeft: "auto", flexShrink: 0, display: "flex", alignItems: "center" }}>
        <GitStatusBadge status={status} t={t} />
      </div>
    </div>
  );
}

export const FileExplorer = forwardRef<FileExplorerHandle, Props>(function FileExplorer({
  cwd,
  remotePeer,
  activeFilePath,
  onOpenFile,
  onPathRenamed,
  refreshKey,
  onAtMention,
  onAtMentions,
  onUploadBusyChange,
  changesCollapsed,
  onHiddenChange,
  onFilterSettingsOpenChange,
  onFilterChange,
}, ref) {
  const { t, locale } = useI18n();
  const remotePeerRef = useRef(remotePeer);
  remotePeerRef.current = remotePeer;
  const uploadTargetRef = useRef(cwd);
  const uploadRequestRef = useRef(0);
  const workspaceRef = useRef({ cwd, peer: remotePeer, generation: 0 });
  if (workspaceRef.current.cwd !== cwd || workspaceRef.current.peer !== remotePeer) {
    workspaceRef.current = {
      cwd,
      peer: remotePeer,
      generation: workspaceRef.current.generation + 1,
    };
    uploadRequestRef.current += 1;
    uploadTargetRef.current = cwd;
  }
  const currentWorkspaceRef = useRef<RenameWorkspace>({ cwd, peer: remotePeer });
  currentWorkspaceRef.current = { cwd, peer: remotePeer };
  const renameWorkspaceRef = useRef<RenameWorkspace>({ cwd, peer: remotePeer });
  const renameRequestRef = useRef(0);
  const onPathRenamedRef = useRef(onPathRenamed);
  onPathRenamedRef.current = onPathRenamed;
  const api = useCallback((path: string) => apiFor(remotePeerRef.current, path), []);
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [highlightedPaths, setHighlightedPaths] = useState<Set<string>>(new Set());
  const [locatedPath, setLocatedPath] = useState<string | null>(null);
  const [gitFiles, setGitFiles] = useState<GitFileStatus[]>([]);
  const gitStatusGenerationRef = useRef<number | null>(null);
  const gitWriteRequestRef = useRef(0);
  const [gitLineStats, setGitLineStats] = useState({ additions: 0, deletions: 0 });
  const [gitRepositoryState, setGitRepositoryState] = useState<GitRepositoryState>("loading");
  const [gitInfo, setGitInfo] = useState<GitInfo>(EMPTY_GIT_INFO);
  const [gitAiState, setGitAiState] = useState<GitAiState>("idle");
  const [gitAiMode, setGitAiMode] = useState<GitAiMode>("summary");
  const [gitAiText, setGitAiText] = useState("");
  const [gitAiError, setGitAiError] = useState<string | null>(null);
  const [gitAiCopyError, setGitAiCopyError] = useState<string | null>(null);
  const [releaseNotesModalOpen, setReleaseNotesModalOpen] = useState(false);
  const gitAiRequestRef = useRef(0);
  const handleCopyGitAiText = useCallback(async () => {
    if (!gitAiText) return;
    setGitAiCopyError(null);
    try {
      await copyText(gitAiText);
    } catch (error) {
      setGitAiCopyError(error instanceof Error && error.message ? error.message : t("files.copyPathFailed"));
    }
  }, [gitAiText, t]);
  const [gitHistoryOpen, setGitHistoryOpen] = useState(false);
  const [gitHistoryState, setGitHistoryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [gitHistory, setGitHistory] = useState<GitCommitSummary[]>([]);
  const [gitHistoryError, setGitHistoryError] = useState<string | null>(null);
  const [gitCommitDetail, setGitCommitDetail] = useState<GitCommitDetail | null>(null);
  const [gitCommitDetailState, setGitCommitDetailState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [gitCommitDetailError, setGitCommitDetailError] = useState<string | null>(null);
  const [gitHubState, setGitHubState] = useState<GitHubClientState>("idle");
  const [gitHubSnapshot, setGitHubSnapshot] = useState<GitHubReadOnlySnapshot | null>(null);
  const [gitHubError, setGitHubError] = useState<string | null>(null);
  const [gitHubTab, setGitHubTab] = useState<GitHubTab>("pulls");
  const [pendingGitWrite, setPendingGitWrite] = useState<PendingGitWrite | null>(null);
  const [gitWriteBusy, setGitWriteBusy] = useState(false);
  const [gitWriteState, setGitWriteState] = useState<"idle" | "success" | "error">("idle");
  const [gitWriteError, setGitWriteError] = useState<string | null>(null);
  const [gitWriteFeedback, setGitWriteFeedback] = useState<string | null>(null);
  const [gitWriteMessage, setGitWriteMessage] = useState("");
  const [gitWriteBranchName, setGitWriteBranchName] = useState("");
  const [gitPrTitle, setGitPrTitle] = useState("");
  const [gitPrBody, setGitPrBody] = useState("");
  const [gitPrBase, setGitPrBase] = useState("");
  const gitHistoryRequestRef = useRef(0);
  const gitCommitDetailRequestRef = useRef(0);
  const gitHubRequestRef = useRef(0);
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSummary, setUploadSummary] = useState<UploadSummary | null>(null);
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingFileDelete | null>(null);
  const deleteRequestRef = useRef<PendingFileDelete | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pendingRename, setPendingRename] = useState<FileNode | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [createValue, setCreateValue] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  const createRequestRef = useRef(0);
  const [rootContextMenu, setRootContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [filter, setFilter] = useState<ExplorerFilterSettings>(DEFAULT_EXPLORER_FILTER);
  const [filterReady, setFilterReady] = useState(false);
  const [filterScope, setFilterScope] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const [draftCustomText, setDraftCustomText] = useState("");
  const [fileDragActive, setFileDragActive] = useState(false);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const fileDragDepthRef = useRef(0);
  const loadedChildrenRef = useRef(new Map<string, FileNode[]>());
  const navigationWaitersRef = useRef(new Map<string, Array<(children: FileNode[]) => void>>());
  const navigatingRef = useRef(false);
  const [navigationRevision, setNavigationRevision] = useState(0);
  const hiddenOverrideRef = useRef<ExplorerFilterSettings | null>(null);
  const hiddenActive = !!(
    filter.hideGitIgnored ||
    filter.hideDot ||
    filter.customNames.length > 0 ||
    filter.hideExts.length > 0 ||
    filter.hideFolders.length > 0
  );

  useEffect(() => {
    onHiddenChange?.(hiddenActive);
  }, [hiddenActive, onHiddenChange]);

  useEffect(() => {
    onFilterSettingsOpenChange?.(settingsOpen);
  }, [onFilterSettingsOpenChange, settingsOpen]);

  useEffect(() => {
    onFilterChange?.(filter);
  }, [filter, onFilterChange]);

  useEffect(() => {
    const previousWorkspace = renameWorkspaceRef.current;
    const workspaceChanged = previousWorkspace.cwd !== cwd || previousWorkspace.peer !== remotePeer;
    renameWorkspaceRef.current = { cwd, peer: remotePeer };
    if (!workspaceChanged) return;
    renameRequestRef.current += 1;
    createRequestRef.current += 1;
    deleteRequestRef.current = null;
    setPendingDelete(null);
    setDeleteError(null);
    setDeleteBusy(false);
    setPendingRename(null);
    setRenameValue("");
    setRenameError(null);
    setRenameBusy(false);
    setPendingCreate(null);
    setCreateValue("");
    setCreateError(null);
    setCreateBusy(false);
  }, [cwd, remotePeer]);

  useEffect(() => () => {
    renameRequestRef.current += 1;
    uploadRequestRef.current += 1;
    deleteRequestRef.current = null;
  }, []);

  const prevWorkspaceRef = useRef<{ cwd: string; peer?: string } | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const refreshToken = `${refreshKey ?? 0}:${treeRefreshKey}`;
  const uploadBusy = uploadPhase !== "idle";
  const filterProjectKey = getExplorerFilterProjectKey(cwd);

  // Load per-project ignore rules from the device settings file
  // (/api/explorer-filter, ~/.config/pi-web-reader/explorer-filter.json).
  // When the file has no record for this project yet, migrate the browser
  // localStorage copy over once (file becomes the source of truth).
  useEffect(() => {
    let cancelled = false;
    setFilterScope(null);
    setLoading(true);
    const apply = (loaded: ExplorerFilterSettings) => {
      if (cancelled) return;
      setFilter(loaded);
      setDraftCustomText(customNamesToText(loaded.customNames));
      setFilterScope(getExplorerFilterProjectKey(cwd));
      setFilterReady(true);
    };
    fetch(api(`explorer-filter?cwd=${encodeURIComponent(cwd)}`))
      .then((r) => r.json())
      .then((data: { filter?: ExplorerFilterSettings | null }) => {
        if (data.filter) { apply(data.filter); return; }
        const migrated = loadStoredExplorerFilter(cwd);
        if (migrated) {
          void fetch(api("explorer-filter"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cwd, settings: migrated }),
          }).catch(() => { /* keep */ });
          apply(migrated);
          return;
        }
        apply(DEFAULT_EXPLORER_FILTER);
      })
      .catch(() => apply(DEFAULT_EXPLORER_FILTER));
    return () => { cancelled = true; };
  }, [api, cwd, remotePeer]);

  const applyFilter = useCallback((next: ExplorerFilterSettings) => {
    const normalized = {
      ...next,
      customNames: parseCustomNamesText(customNamesToText(next.customNames)),
    };
    setFilter(normalized);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(EXPLORER_FILTER_CHANGED_EVENT, {
        detail: { cwd, peer: remotePeerRef.current ?? null, settings: normalized },
      }));
    }
    void fetch(api("explorer-filter"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, settings: normalized }),
    }).catch(() => { /* keep local state; next load re-reads the file */ });
    setTreeRefreshKey((k) => k + 1);
  }, [api, cwd]);

  const closeFilterSettings = useCallback(() => {
    const nextCustomNames = parseCustomNamesText(draftCustomText);
    const hasCustomChanged = JSON.stringify(nextCustomNames) !== JSON.stringify(filter.customNames);
    if (hasCustomChanged) {
      applyFilter({ ...filter, customNames: nextCustomNames });
    }
    setSettingsOpen(false);
  }, [applyFilter, draftCustomText, filter]);

  const openFilterSettings = useCallback(() => {
    setDraftCustomText(customNamesToText(filter.customNames));
    setSettingsOpen(true);
  }, [filter.customNames]);

  const toggleFilterSettings = useCallback(() => {
    if (settingsOpenRef.current) {
      closeFilterSettings();
    } else {
      openFilterSettings();
    }
  }, [closeFilterSettings, openFilterSettings]);

  useEffect(() => {
    if (!settingsOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeFilterSettings();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeFilterSettings, settingsOpen]);

  const handleRequestDelete = useCallback((node: FileNode) => {
    if (deleteRequestRef.current || currentWorkspaceRef.current.cwd !== cwd || currentWorkspaceRef.current.peer !== remotePeer) return;
    setDeleteError(null);
    setPendingDelete({ ...node, cwd, peer: remotePeer });
  }, [cwd, remotePeer]);

  const handleRequestRename = useCallback((node: FileNode) => {
    setRenameError(null);
    setRenameValue(node.name);
    setPendingRename(node);
  }, []);

  const requestCreate = useCallback((kind: CreateKind, directory = cwd) => {
    if (createBusy) return;
    setCreateError(null);
    setCreateValue(kind === "file" ? t("files.newDocumentDefaultName") : t("files.newFolderDefaultName"));
    setPendingCreate({ directory, kind });
  }, [createBusy, cwd, t]);

  const requestUpload = useCallback((directory: string) => {
    if (uploadBusy) return;
    uploadTargetRef.current = directory;
    uploadInputRef.current?.click();
  }, [uploadBusy]);

  const handleRequestCreate = useCallback((directory: string, kind: CreateKind) => {
    requestCreate(kind, directory);
  }, [requestCreate]);

  const handleRequestUpload = useCallback((directory: string) => {
    requestUpload(directory);
  }, [requestUpload]);

  const handleRootContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setRootContextMenu({
      x: Math.min(event.clientX, Math.max(8, window.innerWidth - 226)),
      y: Math.min(event.clientY, Math.max(8, window.innerHeight - 116)),
    });
  }, []);

  useEffect(() => {
    if (!rootContextMenu) return;
    const close = (event?: Event) => {
      if (event?.target instanceof Element && event.target.closest("[data-file-action-menu]")) return;
      setRootContextMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRootContextMenu(null);
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("contextmenu", close, true);
    document.addEventListener("focusin", close);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("contextmenu", close, true);
      document.removeEventListener("focusin", close);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", close);
    };
  }, [rootContextMenu]);

  useEffect(() => {
    if (!pendingCreate) return;
    const frame = requestAnimationFrame(() => {
      createInputRef.current?.focus();
      createInputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingCreate]);

  const handleCreateConfirm = useCallback(async () => {
    if (!pendingCreate || createBusy) return;
    const nextName = createValue.trim();
    if (!nextName) {
      setCreateError(t("files.createNameRequired"));
      return;
    }

    const target = pendingCreate;
    const targetPeer = remotePeerRef.current;
    const requestId = ++createRequestRef.current;
    setCreateBusy(true);
    setCreateError(null);
    try {
      const result = await createPath(target.directory, nextName, target.kind, targetPeer);
      if (requestId !== createRequestRef.current || currentWorkspaceRef.current.peer !== targetPeer) return;
      setPendingCreate(null);
      setCreateValue("");
      setHighlightedPaths(new Set([result.path ?? joinFilePath(target.directory, nextName)]));
      setTreeRefreshKey((key) => key + 1);
      if (target.kind === "file" && result.path) onOpenFile(result.path, nextName);
    } catch (error) {
      if (requestId !== createRequestRef.current) return;
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === createRequestRef.current) setCreateBusy(false);
    }
  }, [createBusy, createValue, onOpenFile, pendingCreate, t]);

  const handleCreateCancel = useCallback(() => {
    if (createBusy) return;
    createRequestRef.current += 1;
    setPendingCreate(null);
    setCreateValue("");
    setCreateError(null);
  }, [createBusy]);

  useEffect(() => {
    if (!pendingRename) return;
    const frame = requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingRename]);

  const handleRenameConfirm = useCallback(async () => {
    if (!pendingRename || renameBusy) return;
    const nextName = renameValue.trim();
    if (!nextName) {
      setRenameError(t("files.renameNameRequired"));
      return;
    }
    if (nextName === pendingRename.name) {
      setPendingRename(null);
      setRenameError(null);
      return;
    }

    const renameTarget = captureRenameTarget(cwd, remotePeer, pendingRename.fullPath, pendingRename.isDir);
    const requestId = ++renameRequestRef.current;
    setRenameBusy(true);
    setRenameError(null);
    try {
      const nextPath = await renamePath(renameTarget.path, nextName, renameTarget.peer);
      if (!isRenameRequestCurrent(renameTarget, currentWorkspaceRef.current, requestId, renameRequestRef.current)) return;
      const pathChanged = (value: string) => migrateRenamedPath(value, renameTarget, nextPath);
      setExpandedPaths((current) => new Set([...current].map(pathChanged)));
      setHighlightedPaths((current) => new Set([...current].map(pathChanged)));
      setLocatedPath((current) => current ? pathChanged(current) : current);
      setPendingRename(null);
      setTreeRefreshKey((key) => key + 1);
      onPathRenamedRef.current?.(renameTarget.path, nextPath, renameTarget.isDir, renameTarget.peer);
    } catch (error) {
      if (!isRenameRequestCurrent(renameTarget, currentWorkspaceRef.current, requestId, renameRequestRef.current)) return;
      setRenameError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === renameRequestRef.current) setRenameBusy(false);
    }
  }, [cwd, pendingRename, remotePeer, renameBusy, renameValue, t]);

  const handleRenameCancel = useCallback(() => {
    if (renameBusy) return;
    setPendingRename(null);
    setRenameError(null);
  }, [renameBusy]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!pendingDelete || deleteRequestRef.current
      || currentWorkspaceRef.current.cwd !== pendingDelete.cwd || currentWorkspaceRef.current.peer !== pendingDelete.peer) return;
    const target = pendingDelete;
    deleteRequestRef.current = target;
    const isCurrent = () => deleteRequestRef.current === target
      && currentWorkspaceRef.current.cwd === target.cwd && currentWorkspaceRef.current.peer === target.peer;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await movePathToTrash(target.fullPath, target.peer);
      if (!isCurrent()) return;
      setPendingDelete(null);
      setTreeRefreshKey((key) => key + 1);
    } catch (error) {
      if (!isCurrent()) return;
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      if (deleteRequestRef.current === target) {
        deleteRequestRef.current = null;
        setDeleteBusy(false);
      }
    }
  }, [pendingDelete]);

  const handleDeleteCancel = useCallback(() => {
    if (deleteRequestRef.current) return;
    setPendingDelete(null);
    setDeleteError(null);
  }, []);

  const deleteConfirmation: FileDeleteConfirmation | undefined = pendingDelete && pendingDelete.cwd === cwd && pendingDelete.peer === remotePeer
    ? { path: pendingDelete.fullPath, busy: deleteBusy, error: deleteError, onConfirm: handleDeleteConfirm, onCancel: handleDeleteCancel }
    : undefined;

  const stagedGitPaths = useMemo(() => gitFiles
    .filter((status) => status.indexStatus !== " " && status.indexStatus !== "?")
    .map((status) => getRelativeFilePath(status.filePath, cwd)), [cwd, gitFiles]);

  const gitStatusByPath = useMemo(() => new Map(
    gitFiles.map((status) => [normalizeFilePathSlashes(status.filePath), status]),
  ), [gitFiles]);

  const changedDirectoryPaths = useMemo(() => {
    const directories = new Set<string>();
    const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
    for (const status of gitFiles) {
      let directory = getFileDirectory(normalizeFilePathSlashes(status.filePath));
      while (directory === normalizedCwd || directory.startsWith(`${normalizedCwd}/`)) {
        directories.add(directory);
        if (directory === normalizedCwd) break;
        const parent = getFileDirectory(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    return directories;
  }, [cwd, gitFiles]);

  const expandPath = useCallback((targetPath: string) => {
    const normalizedTarget = normalizeFilePathSlashes(targetPath);
    const relative = getPathWithinCwd(normalizedTarget, cwd) ?? normalizedTarget.replace(/^[/\\]/, "");
    const parts = relative.split("/").filter(Boolean);
    if (parts.length === 0) return;
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      let acc = cwd;
      for (const part of parts) {
        acc = joinFilePath(acc, part);
        next.add(acc);
      }
      return next;
    });
  }, [cwd]);

  const locateFile = useCallback((filePath: string) => {
    const normalized = normalizeFilePathSlashes(filePath).replace(/\/$/, "");
    const relative = getPathWithinCwd(normalized, cwd);
    if (!relative) return;
    setLocatedPath(normalized);
    expandPath(getFileDirectory(normalized));
  }, [cwd, expandPath]);

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
  }, []);

  const settleNavigationWaiters = useCallback((directory: string, children: FileNode[]) => {
    const waiters = navigationWaitersRef.current.get(directory);
    if (!waiters) return;
    navigationWaitersRef.current.delete(directory);
    for (const resolve of waiters) resolve(children);
  }, []);

  const handleChildrenLoaded = useCallback((directory: string, entries: FileNode[]) => {
    loadedChildrenRef.current.set(directory, entries);
    setNavigationRevision((value) => value + 1);
    settleNavigationWaiters(directory, entries);
  }, [settleNavigationWaiters]);

  const handleChildrenLoadSettled = useCallback((directory: string) => {
    settleNavigationWaiters(directory, loadedChildrenRef.current.get(directory) ?? []);
  }, [settleNavigationWaiters]);

  const waitForChildren = useCallback((directory: string): Promise<FileNode[]> => {
    const loadedChildren = loadedChildrenRef.current.get(directory);
    if (loadedChildren) return Promise.resolve(loadedChildren);
    return new Promise((resolve) => {
      const waiter = (children: FileNode[]) => {
        clearTimeout(timer);
        resolve(children);
      };
      const timer = setTimeout(() => {
        const waiters = navigationWaitersRef.current.get(directory) ?? [];
        navigationWaitersRef.current.set(directory, waiters.filter((candidate) => candidate !== waiter));
        resolve([]);
      }, 10000);
      const waiters = navigationWaitersRef.current.get(directory) ?? [];
      waiters.push(waiter);
      navigationWaitersRef.current.set(directory, waiters);
    });
  }, []);

  const visibleNodes = useMemo(() => {
    const result: FileNode[] = [];
    const visit = (nodes: FileNode[]) => {
      for (const node of nodes) {
        result.push(node);
        if (!node.isDir || !expandedPaths.has(node.fullPath)) continue;
        const children = loadedChildrenRef.current.get(node.fullPath);
        if (children) visit(children);
      }
    };
    visit(roots);
    return result;
  }, [expandedPaths, navigationRevision, roots]);

  const ensureDirectoryChildren = useCallback(async (directory: FileNode) => {
    setExpandedPaths((current) => new Set(current).add(directory.fullPath));
    const loadedChildren = loadedChildrenRef.current.get(directory.fullPath);
    return loadedChildren ?? waitForChildren(directory.fullPath);
  }, [waitForChildren]);

  const findFirstFile = useCallback(async function findFirstFileIn(nodes: FileNode[]): Promise<FileNode | null> {
    for (const node of nodes) {
      if (!node.isDir) return node;
      if (node.outsideLinkTarget || node.isSymlink) continue;
      const children = await ensureDirectoryChildren(node);
      const file = await findFirstFileIn(children);
      if (file) return file;
    }
    return null;
  }, [ensureDirectoryChildren]);

  const navigateFile = useCallback(async (direction: FileNavigationDirection) => {
    if (!activeFilePath || navigatingRef.current) return false;
    navigatingRef.current = true;
    try {
      const currentPath = normalizeFilePathSlashes(activeFilePath);
      const currentIndex = visibleNodes.findIndex((node) => normalizeFilePathSlashes(node.fullPath) === currentPath);
      let index = currentIndex === -1
        ? (direction === "next" ? 0 : visibleNodes.length - 1)
        : currentIndex + (direction === "next" ? 1 : -1);
      const step = direction === "next" ? 1 : -1;
      while (index >= 0 && index < visibleNodes.length) {
        const node = visibleNodes[index];
        if (!node.isDir) {
          locateFile(node.fullPath);
          onOpenFile(node.fullPath, node.name, { reuseActiveTab: true });
          return true;
        }
        if (!node.outsideLinkTarget && !node.isSymlink) {
          const file = await findFirstFile([node]);
          if (file) {
            locateFile(file.fullPath);
            onOpenFile(file.fullPath, file.name, { reuseActiveTab: true });
            return true;
          }
        }
        index += step;
      }
      return false;
    } finally {
      navigatingRef.current = false;
    }
  }, [activeFilePath, findFirstFile, locateFile, onOpenFile, visibleNodes]);

  const clearNavigationState = useCallback(() => {
    loadedChildrenRef.current.clear();
    for (const waiters of navigationWaitersRef.current.values()) {
      for (const resolve of waiters) resolve([]);
    }
    navigationWaitersRef.current.clear();
    setNavigationRevision((value) => value + 1);
  }, []);

  const captureUploadContext = useCallback((targetDirectory: string): FileExplorerRequestContext => ({
    ...workspaceRef.current,
    requestId: ++uploadRequestRef.current,
    targetDirectory,
  }), []);

  const isUploadContextCurrent = useCallback((context: FileExplorerRequestContext) => (
    isFileExplorerRequestCurrent(context, {
      ...workspaceRef.current,
      requestId: uploadRequestRef.current,
    })
  ), []);

  const applyUploadResult = useCallback((data: UploadResponse, context: FileExplorerRequestContext) => {
    if (!isUploadContextCurrent(context)) return;
    const uploaded = data.uploaded ?? [];
    const skipped = data.skipped ?? [];
    const errors = data.errors ?? [];
    setUploadSummary({ context, uploaded, skipped, errors });

    if (uploaded.length > 0) {
      setHighlightedPaths(new Set(uploaded.map((name) => joinFilePath(context.targetDirectory, name))));
      setTreeRefreshKey((key) => key + 1);
    }
  }, [isUploadContextCurrent]);

  const performUpload = useCallback(async (
    files: File[],
    strategy: UploadConflictStrategy,
    context: FileExplorerRequestContext,
  ) => {
    if (!isUploadContextCurrent(context)) return;
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("uploading");

    try {
      const onProgress = createUploadProgressHandler(context, isUploadContextCurrent, setUploadProgress);
      const { status, data } = await uploadFiles(context.targetDirectory, files, strategy, onProgress, context.peer);
      if (!isUploadContextCurrent(context)) return;
      if (status === 409 && data.conflicts?.length) {
        setPendingConflict({
          context,
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }
      if (status < 200 || status >= 300) {
        throw new Error(data.error ?? `Upload failed (HTTP ${status})`);
      }
      setUploadProgress(100);
      applyUploadResult(data, context);
    } catch (uploadFailure) {
      if (isUploadContextCurrent(context)) {
        setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
      }
    } finally {
      if (isUploadContextCurrent(context)) setUploadPhase("idle");
    }
  }, [applyUploadResult, isUploadContextCurrent]);

  const prepareUpload = useCallback(async (files: File[], context: FileExplorerRequestContext) => {
    if (files.length === 0 || uploadBusy || !isUploadContextCurrent(context)) return;
    setUploadSummary(null);
    setHighlightedPaths(new Set());
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("checking");

    try {
      const res = await fetch(
        `${apiFor(context.peer, `files/${encodeFilePathForApi(context.targetDirectory)}?type=upload-check`)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileNames: files.map((file) => file.name) }),
        },
      );
      const data = await res.json().catch(() => ({})) as UploadResponse;
      if (!isUploadContextCurrent(context)) return;
      if (!res.ok) throw new Error(data.error ?? `Upload check failed (HTTP ${res.status})`);

      if (data.conflicts?.length) {
        setPendingConflict({
          context,
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }

      await performUpload(files, "error", context);
    } catch (uploadFailure) {
      if (isUploadContextCurrent(context)) {
        setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
      }
    } finally {
      if (isUploadContextCurrent(context)) setUploadPhase("idle");
    }
  }, [performUpload, uploadBusy, isUploadContextCurrent]);

  const resetFileDrag = useCallback(() => {
    fileDragDepthRef.current = 0;
    setFileDragActive(false);
    setDropTargetPath(null);
  }, []);

  const handleExplorerDragEnter = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    fileDragDepthRef.current += 1;
    setFileDragActive(true);
  }, []);

  const handleExplorerDragOver = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropTargetPath((prev) => (prev === null ? prev : null));
  }, []);

  const handleExplorerDragLeave = useCallback(() => {
    if (fileDragDepthRef.current <= 0) return;
    fileDragDepthRef.current -= 1;
    if (fileDragDepthRef.current === 0) {
      resetFileDrag();
    }
  }, [resetFileDrag]);

  const handleDropFiles = useCallback((directory: string, files: File[]) => {
    resetFileDrag();
    if (files.length === 0) return;
    void prepareUpload(files, captureUploadContext(directory));
  }, [captureUploadContext, prepareUpload, resetFileDrag]);

  const handleExplorerDrop = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    handleDropFiles(dropTargetPath ?? cwd, Array.from(event.dataTransfer.files));
  }, [cwd, dropTargetPath, handleDropFiles]);

  const handleDropTargetChange = useCallback((path: string | null) => {
    setDropTargetPath((prev) => (prev === path ? prev : path));
  }, []);

  const handleUploadInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    void prepareUpload(files, captureUploadContext(uploadTargetRef.current));
  }, [captureUploadContext, prepareUpload]);

  useImperativeHandle(ref, () => ({
    openUploadPicker(directory = cwd) {
      requestUpload(directory);
    },
    openCreate(kind, directory = cwd) {
      requestCreate(kind, directory);
    },
    openFilterSettings,
    toggleFilterSettings,
    closeFilterSettings,
    /** Eye button: one click shows every hidden entry (dotfiles, custom names,
     *  folders, extensions) without writing to the persisted per-project file
     *  (config survives in the file and is restored on the second click). */
    toggleHiddenVisibility() {
      if (hiddenActive) {
        hiddenOverrideRef.current = filter;
        applyFilter({ ...filter, hideGitIgnored: false, hideDot: false, customNames: [], hideExts: [], hideFolders: [] });
      } else {
        applyFilter(hiddenOverrideRef.current ?? DEFAULT_EXPLORER_FILTER);
      }
    },
    /** Navigate to the next or previous visible file, expanding folders on demand. */
    navigateFile,
    /** Expand the tree along the path from cwd to targetDir (used by search). */
    expandToPath: expandPath,
    /** Locate the active file, expand its parent directories and scroll to it. */
    locateFile,
  // ponytail: settings edits while the eye-override is active POST partial config;
  // the next eye click restores the snapshot (and the persisted file with it).
  }), [applyFilter, closeFilterSettings, cwd, expandPath, filter, hiddenActive, locateFile, navigateFile, openFilterSettings, requestCreate, requestUpload, toggleFilterSettings]);

  useEffect(() => {
    onUploadBusyChange?.(uploadBusy);
  }, [onUploadBusyChange, uploadBusy]);

  useEffect(() => () => onUploadBusyChange?.(false), [onUploadBusyChange]);

  useEffect(() => {
    const workspaceChanged = prevWorkspaceRef.current === null || prevWorkspaceRef.current.cwd !== cwd || prevWorkspaceRef.current.peer !== remotePeer;
    prevWorkspaceRef.current = { cwd, peer: remotePeer };
    clearNavigationState();

    // Reset workspace-derived UI when cwd or owning peer changes, not on refreshKey bumps.
    if (workspaceChanged) {
      setSettingsOpen(false);
      setRoots([]);
      setLoading(true);
      setError(null);
      setExpandedPaths(new Set());
      setLocatedPath(null);
      setHighlightedPaths(new Set());
      setUploadSummary(null);
      setPendingConflict(null);
      setUploadError(null);
      setUploadProgress(0);
      setUploadPhase("idle");
      uploadRequestRef.current += 1;
      uploadTargetRef.current = cwd;
    }

    if (!filterReady || filterScope !== filterProjectKey) return;
    setError(null);
    const requestPeer = remotePeer;
    let cancelled = false;
    fetchEntries(cwd, filter, requestPeer)
      .then((entries) => { if (!cancelled) setRoots(entries); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [clearNavigationState, cwd, remotePeer, filter, filterProjectKey, filterReady, filterScope, refreshKey, treeRefreshKey]);

  useEffect(() => {
    let cancelled = false;
    const generation = workspaceRef.current.generation;
    gitStatusGenerationRef.current = null;
    gitAiRequestRef.current += 1;
    gitHistoryRequestRef.current += 1;
    gitCommitDetailRequestRef.current += 1;
    setGitRepositoryState("loading");
    setGitInfo(EMPTY_GIT_INFO);
    setGitAiState("idle");
    setGitAiText("");
    setGitAiError(null);
    setGitHistoryOpen(false);
    setGitHistoryState("idle");
    setGitHistory([]);
    setGitHistoryError(null);
    setGitCommitDetail(null);
    setGitCommitDetailState("idle");
    setGitCommitDetailError(null);
    gitHubRequestRef.current += 1;
    setGitHubState("idle");
    setGitHubSnapshot(null);
    setGitHubError(null);
    setGitHubTab("pulls");
    setGitFiles([]);
    setGitLineStats({ additions: 0, deletions: 0 });
    const requestPeer = remotePeer;
    fetchGitStatus(cwd, requestPeer)
      .then((status) => {
        if (!cancelled && generation === workspaceRef.current.generation) {
          gitStatusGenerationRef.current = status.isGitRepository ? generation : null;
          setGitRepositoryState(status.isGitRepository ? "repository" : "not-repository");
          setGitInfo(status.isGitRepository
            ? { branch: status.branch, upstream: status.upstream, ahead: status.ahead, behind: status.behind }
            : EMPTY_GIT_INFO);
          setGitFiles(status.isGitRepository ? status.files : []);
          setGitLineStats(status.isGitRepository
            ? { additions: status.additions, deletions: status.deletions }
            : { additions: 0, deletions: 0 });
        }
      })
      .catch(() => {
        if (!cancelled && generation === workspaceRef.current.generation) {
          setGitRepositoryState("error");
          setGitFiles([]);
          setGitLineStats({ additions: 0, deletions: 0 });
        }
      });
    return () => { cancelled = true; };
  }, [cwd, remotePeer, refreshKey, treeRefreshKey]);

  const runGitAi = useCallback(async (mode: GitAiMode) => {
    if (gitRepositoryState !== "repository" || (gitFiles.length === 0 && mode !== "release-notes") || gitAiState === "loading") return;
    if (mode === "release-notes") setReleaseNotesModalOpen(true);
    const requestId = gitAiRequestRef.current + 1;
    gitAiRequestRef.current = requestId;
    setGitAiMode(mode);
    setGitAiState("loading");
    setGitAiText("");
    setGitAiError(null);
    try {
      const response = await fetch(api("git/summary"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, mode, locale }),
      });
      const body = await response.json().catch(() => ({})) as { text?: unknown; error?: unknown };
      if (!response.ok || typeof body.text !== "string") {
        throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
      }
      if (requestId !== gitAiRequestRef.current) return;
      const aiResultText = body.text.trim();
      setGitAiText(aiResultText);
      setGitAiState("ready");
      if (mode === "commit-message") {
        setGitWriteMessage(aiResultText);
      } else {
        setReleaseNotesModalOpen(true);
      }
    } catch (error) {
      if (requestId !== gitAiRequestRef.current) return;
      setGitAiError(error instanceof Error ? error.message : String(error));
      setGitAiState("error");
    }
  }, [api, cwd, gitAiState, gitFiles.length, gitRepositoryState, locale]);

  const loadGitHistory = useCallback(async () => {
    const requestId = gitHistoryRequestRef.current + 1;
    gitHistoryRequestRef.current = requestId;
    setGitHistoryState("loading");
    setGitHistoryError(null);
    try {
      const history = await fetchGitHistory(cwd, remotePeerRef.current);
      if (requestId !== gitHistoryRequestRef.current) return;
      setGitHistory(history);
      setGitHistoryState("ready");
    } catch (error) {
      if (requestId !== gitHistoryRequestRef.current) return;
      setGitHistoryError(error instanceof Error ? error.message : String(error));
      setGitHistoryState("error");
    }
  }, [cwd]);

  const loadGitCommitDetail = useCallback(async (hash: string) => {
    const requestId = gitCommitDetailRequestRef.current + 1;
    gitCommitDetailRequestRef.current = requestId;
    setGitCommitDetailState("loading");
    setGitCommitDetailError(null);
    try {
      const detail = await fetchGitCommitDetail(cwd, hash, remotePeerRef.current);
      if (requestId !== gitCommitDetailRequestRef.current) return;
      setGitCommitDetail(detail);
      setGitCommitDetailState("ready");
    } catch (error) {
      if (requestId !== gitCommitDetailRequestRef.current) return;
      setGitCommitDetailError(error instanceof Error ? error.message : String(error));
      setGitCommitDetailState("error");
    }
  }, [cwd]);

  const loadGitHub = useCallback(async () => {
    const requestId = gitHubRequestRef.current + 1;
    gitHubRequestRef.current = requestId;
    setGitHubState("loading");
    setGitHubError(null);
    try {
      const snapshot = await fetchGitHubSnapshot(cwd, remotePeerRef.current);
      if (requestId !== gitHubRequestRef.current) return;
      setGitHubSnapshot(snapshot);
      setGitHubState("ready");
    } catch (error) {
      if (requestId !== gitHubRequestRef.current) return;
      setGitHubError(error instanceof Error ? error.message : String(error));
      setGitHubState("error");
    }
  }, [cwd]);

  const toggleGitHistory = useCallback(() => {
    if (gitHistoryOpen) {
      setGitHistoryOpen(false);
      return;
    }
    setGitHistoryOpen(true);
    if (gitHistoryState === "idle" || gitHistoryState === "error") void loadGitHistory();
    if (gitHubState === "idle" || gitHubState === "error") void loadGitHub();
  }, [gitHistoryOpen, gitHistoryState, gitHubState, loadGitHistory, loadGitHub]);

  const gitHubReasonText = (reason?: GitHubUnavailableReason): string => {
    switch (reason) {
      case "no-github-remote": return t("files.gitHubNoRemote");
      case "auth-required": return t("files.gitHubAuthRequired");
      case "auth-failed": return t("files.gitHubAuthFailed");
      case "repository-not-found": return t("files.gitHubRepositoryNotFound");
      case "rate-limited": return t("files.gitHubRateLimited");
      default: return t("files.gitHubUnavailable");
    }
  };

  const beginGitWrite = useCallback((action: GitWriteAction) => {
    if (gitWriteBusy || gitStatusGenerationRef.current !== workspaceRef.current.generation) return;
    const paths = action === "stage"
      ? gitFiles.map((status) => getRelativeFilePath(status.filePath, cwd))
      : action === "commit"
        ? stagedGitPaths
        : [];
    if (action === "stage" && paths.length === 0) return;
    if (action === "commit" && paths.length === 0) return;
    setGitWriteState("idle");
    setGitWriteError(null);
    setGitWriteFeedback(null);
    setGitWriteMessage(action === "commit" && gitAiMode === "commit-message" ? gitAiText : "");
    setGitWriteBranchName("");
    setGitPrTitle(action === "create-pr" ? gitHistory[0]?.subject ?? "" : "");
    setGitPrBody("");
    setGitPrBase(action === "create-pr" ? gitHubSnapshot?.defaultBranch ?? "" : "");
    setPendingGitWrite({ action, paths, ...workspaceRef.current });
  }, [cwd, gitAiMode, gitAiText, gitFiles, gitHistory, gitHubSnapshot, gitWriteBusy, stagedGitPaths]);

  const confirmGitWrite = useCallback(async () => {
    if (!pendingGitWrite || gitWriteBusy || pendingGitWrite.generation !== workspaceRef.current.generation) return;
    if (pendingGitWrite.action === "commit" && !gitWriteMessage.trim()) {
      setGitWriteError(t("files.gitWriteMessageRequired"));
      setGitWriteState("error");
      return;
    }
    if (pendingGitWrite.action === "create-branch" && !gitWriteBranchName.trim()) {
      setGitWriteError(t("files.gitWriteBranchRequired"));
      setGitWriteState("error");
      return;
    }
    if (pendingGitWrite.action === "create-pr" && !gitPrTitle.trim()) {
      setGitWriteError(t("files.gitPrTitleRequired"));
      setGitWriteState("error");
      return;
    }
    if (pendingGitWrite.action === "create-pr" && !gitPrBase.trim()) {
      setGitWriteError(t("files.gitPrBaseRequired"));
      setGitWriteState("error");
      return;
    }
    const requestId = ++gitWriteRequestRef.current;
    const isCurrent = () => requestId === gitWriteRequestRef.current
      && pendingGitWrite.generation === workspaceRef.current.generation;
    setGitWriteBusy(true);
    setGitWriteState("idle");
    setGitWriteError(null);
    try {
      const isPullRequest = pendingGitWrite.action === "create-pr";
      const response = await fetch(apiFor(pendingGitWrite.peer, isPullRequest ? "git/github" : "git/write"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isPullRequest
          ? { cwd: pendingGitWrite.cwd, title: gitPrTitle, body: gitPrBody, base: gitPrBase }
          : {
            cwd: pendingGitWrite.cwd,
            action: pendingGitWrite.action,
            paths: pendingGitWrite.paths,
            ...(pendingGitWrite.action === "commit" ? { message: gitWriteMessage } : {}),
            ...(pendingGitWrite.action === "create-branch" ? { branchName: gitWriteBranchName } : {}),
          }),
      });
      const body = await response.json().catch(() => ({})) as { ok?: unknown; error?: unknown; pullRequest?: { number?: unknown } };
      if (!isCurrent()) return;
      if (!response.ok || body.ok !== true) {
        throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
      }
      setPendingGitWrite(null);
      setGitWriteState("success");
      setGitWriteFeedback(isPullRequest && typeof body.pullRequest?.number === "number"
        ? t("files.gitPrCreated", { number: body.pullRequest.number })
        : t("files.gitWriteDone"));
      if (isPullRequest) {
        setGitHubState("idle");
        void loadGitHub();
      } else {
        setTreeRefreshKey((key) => key + 1);
      }
    } catch (error) {
      if (isCurrent()) {
        setGitWriteState("error");
        setGitWriteError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (isCurrent()) setGitWriteBusy(false);
    }
  }, [gitPrBase, gitPrBody, gitPrTitle, gitWriteBranchName, gitWriteBusy, gitWriteMessage, loadGitHub, pendingGitWrite, t]);

  useEffect(() => {
    setPendingGitWrite(null);
    setGitWriteBusy(false);
    setGitWriteState("idle");
    setGitWriteError(null);
    setGitWriteFeedback(null);
    setGitWriteMessage("");
    setGitWriteBranchName("");
    setGitPrTitle("");
    setGitPrBody("");
    setGitPrBase("");
  }, [cwd, remotePeer]);

  useEffect(() => () => { gitWriteRequestRef.current += 1; }, []);

  useEffect(() => {
    if (!pendingGitWrite || gitWriteBusy) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPendingGitWrite(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [gitWriteBusy, pendingGitWrite]);

  useEffect(() => {
    if (!releaseNotesModalOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setReleaseNotesModalOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [releaseNotesModalOpen]);

  const gitWriteCommand = pendingGitWrite?.action === "stage"
    ? `git add --\n${pendingGitWrite.paths.join("\n")}`
    : pendingGitWrite?.action === "commit"
      ? `git commit -m <message> --\n${pendingGitWrite.paths.join("\n")}`
      : pendingGitWrite?.action === "push"
        ? "git push"
        : pendingGitWrite?.action === "create-pr"
          ? `POST GitHub pull request\nhead: ${gitInfo.branch ?? "<current-branch>"}\nbase: ${gitPrBase || "<base-branch>"}`
          : pendingGitWrite
            ? `git switch -c ${gitWriteBranchName || "<branch-name>"}`
            : "";

  const showUploadFeedback = uploadBusy || pendingConflict !== null || uploadError !== null || uploadSummary !== null;

  const addUploadedFilesToChat = useCallback(() => {
    if (!uploadSummary || uploadSummary.uploaded.length === 0) return;
    onAtMentions?.(
      uploadSummary.uploaded.map((name) => getRelativeFilePath(joinFilePath(uploadSummary.context.targetDirectory, name), cwd)),
    );
  }, [cwd, onAtMentions, uploadSummary]);

  return (
    <div
      style={{ minHeight: "100%" }}
      onDragEnter={handleExplorerDragEnter}
      onDragOver={handleExplorerDragOver}
      onDragLeave={handleExplorerDragLeave}
      onDrop={handleExplorerDrop}
    >
      <input ref={uploadInputRef} type="file" multiple hidden onChange={handleUploadInput} />
      {showUploadFeedback && (
        <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
        {uploadBusy && (
          <div role="status" aria-live="polite" aria-label={uploadPhase === "checking" ? t("files.checking") : t("files.uploading", { progress: uploadProgress })}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: 14, color: "var(--text-muted)" }}>
              {uploadPhase === "checking" ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-5.7-8.4" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 16V4" />
                  <path d="m7 9 5-5 5 5" />
                  <path d="M5 20h14" />
                </svg>
              )}
              {uploadPhase === "uploading" && <span style={{ fontSize: 10 }}>{uploadProgress}%</span>}
            </div>
            {uploadPhase === "uploading" && (
              <div style={{ height: 3, marginTop: 4, overflow: "hidden", borderRadius: 2, background: "var(--border)" }}>
                <div style={{ width: `${uploadProgress}%`, height: "100%", background: "var(--text-muted)", transition: "width 120ms ease" }} />
              </div>
            )}
          </div>
        )}

        {pendingConflict && (
          <div role="alert" style={{ padding: 7, border: "1px solid color-mix(in srgb, #f59e0b 55%, var(--border))", borderRadius: 4, background: "color-mix(in srgb, #f59e0b 9%, var(--bg-panel))" }}>
            <div style={{ fontSize: 11, color: "var(--text)", lineHeight: 1.35, overflowWrap: "anywhere" }}>
              {t("files.conflictSummary", { count: pendingConflict.conflicts.length, countSuffix: pendingConflict.conflicts.length === 1 ? "" : "s", files: pendingConflict.conflicts.join(", ") })}
            </div>
            {pendingConflict.nonReplaceable.length > 0 && (
              <div style={{ marginTop: 3, fontSize: 10, color: "#f59e0b", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                {t("files.cannotReplace", { files: pendingConflict.nonReplaceable.join(", ") })}
              </div>
            )}
            <div style={{ display: "flex", gap: 5, marginTop: 7 }}>
              <button type="button" onClick={() => void performUpload(pendingConflict.files, "overwrite", pendingConflict.context)} style={{ height: 22, padding: "0 7px", border: "1px solid #ef4444", borderRadius: 4, background: "transparent", color: "#ef4444", cursor: "pointer", fontSize: 10 }}>
                {t("files.replace")}
              </button>
              <button type="button" onClick={() => void performUpload(pendingConflict.files, "skip", pendingConflict.context)} style={{ height: 22, padding: "0 7px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 10 }}>
                {t("files.skipExisting")}
              </button>
              <button type="button" onClick={() => setPendingConflict(null)} style={{ height: 22, padding: "0 7px", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 10 }}>
                {t("files.cancel")}
              </button>
            </div>
          </div>
        )}

        {uploadError && (
          <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 11, lineHeight: 1.35, color: "#f87171" }}>
            <span style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>{uploadError}</span>
            <DismissButton onClick={() => setUploadError(null)} title={t("files.dismissError")} />
          </div>
        )}

        {uploadSummary && (
          <div aria-live="polite">
            <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 22, fontSize: 11 }}>
              <div style={{ minWidth: 0, flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
                {uploadSummary.uploaded.length > 0 && (
                  <span title={`${uploadSummary.uploaded.length} uploaded`} aria-label={`${uploadSummary.uploaded.length} uploaded`} style={{ display: "flex", alignItems: "center", gap: 3, color: "#22c55e" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m5 12 4 4L19 6" />
                    </svg>
                    <span>{uploadSummary.uploaded.length}</span>
                  </span>
                )}
                {uploadSummary.skipped.length > 0 && (
                  <span title={`${uploadSummary.skipped.length} skipped`} aria-label={`${uploadSummary.skipped.length} skipped`} style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--text-dim)" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M8 12h8" />
                    </svg>
                    <span>{uploadSummary.skipped.length}</span>
                  </span>
                )}
                {uploadSummary.errors.length > 0 && (
                  <span title={`${uploadSummary.errors.length} failed`} aria-label={`${uploadSummary.errors.length} failed`} style={{ display: "flex", alignItems: "center", gap: 3, color: "#f87171" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 3 2.5 20h19L12 3Z" />
                      <path d="M12 9v4" />
                      <path d="M12 17h.01" />
                    </svg>
                    <span>{uploadSummary.errors.length}</span>
                  </span>
                )}
              </div>
              {uploadSummary.uploaded.length > 0 && onAtMentions && (
                <button
                  type="button"
                  onClick={addUploadedFilesToChat}
                  title={uploadSummary.uploaded.length === 1 ? t("files.addUploadedFile") : t("files.addAllUploadedFiles")}
                  aria-label={uploadSummary.uploaded.length === 1 ? t("files.addUploadedFile") : t("files.addAllUploadedFiles")}
                  style={{ height: 22, padding: "0 7px", display: "flex", alignItems: "center", justifyContent: "center", gap: 4, flexShrink: 0, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--accent)", cursor: "pointer", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}
                >
                  <MentionIcon />
                  {t("files.mention")}
                </button>
              )}
              <DismissButton onClick={() => setUploadSummary(null)} title={t("files.dismissUploadResults")} />
            </div>
            {uploadSummary.errors.map((item) => (
              <div key={item.name} title={item.error} style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3, minWidth: 0, fontSize: 10, color: "#f87171" }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v5" />
                  <path d="M12 17h.01" />
                </svg>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
              </div>
            ))}
          </div>
        )}
        </div>
      )}

      {settingsOpen && (
        <div style={{ padding: "10px 10px 12px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{t("explorerFilter.title")}</div>
            <button
              type="button"
              onClick={closeFilterSettings}
              style={{ border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 12 }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              {t("settings.saveAndClose")}
            </button>
          </div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6 }}>{t("files.sortBy")}</div>
          <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
            {(["name", "modified"] as const).map((key) => {
              const active = filter.sortBy === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => applyFilter({ ...filter, sortBy: key })}
                  style={{
                    flex: 1, height: 26, borderRadius: 6, fontSize: 11, cursor: "pointer",
                    border: active ? "1px solid rgba(37,99,235,0.35)" : "1px solid var(--border)",
                    background: active ? "var(--bg-selected)" : "var(--bg)",
                    color: active ? "var(--accent)" : "var(--text-muted)",
                  }}
                >
                  {key === "name" ? t("files.sortByName") : t("files.sortByModified")}
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
            {(["asc", "desc"] as const).map((key) => {
              const active = filter.sortOrder === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => applyFilter({ ...filter, sortOrder: key })}
                  style={{
                    flex: 1, height: 26, borderRadius: 6, fontSize: 11, cursor: "pointer",
                    border: active ? "1px solid rgba(37,99,235,0.35)" : "1px solid var(--border)",
                    background: active ? "var(--bg-selected)" : "var(--bg)",
                    color: active ? "var(--accent)" : "var(--text-muted)",
                  }}
                >
                  {key === "asc" ? t("files.sortAsc") : t("files.sortDesc")}
                </button>
              );
            })}
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text)", marginBottom: 12, cursor: "pointer" }}>
            <input type="checkbox" checked={filter.hideDot} onChange={(e) => applyFilter({ ...filter, hideDot: e.target.checked })} />
            {t("explorerFilter.hideDot")}
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text)", marginBottom: 12, cursor: "pointer" }}>
            <input type="checkbox" checked={filter.hideGitIgnored} onChange={(e) => applyFilter({ ...filter, hideGitIgnored: e.target.checked })} />
            {t("explorerFilter.hideGitIgnored")}
          </label>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6 }}>{t("explorerFilter.customNames")}</div>
          <textarea
            value={draftCustomText}
            onChange={(e) => setDraftCustomText(e.target.value)}
            onBlur={() => applyFilter({ ...filter, customNames: parseCustomNamesText(draftCustomText) })}
            placeholder={t("explorerFilter.customNamesPlaceholder")}
            rows={4}
            style={{ width: "100%", boxSizing: "border-box", resize: "vertical", fontSize: 12, fontFamily: "var(--font-mono)", padding: 8, borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", marginBottom: 12 }}
          />
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6 }}>{t("explorerFilter.commonFolders")}</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginBottom: 12, maxHeight: 140, overflowY: "auto" }}>
            {HIDEABLE_FOLDER_NAMES.map((name) => {
              const checked = filter.hideFolders.some((f) => f.toLowerCase() === name.toLowerCase());
              return (
                <label key={name} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text)", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...filter.hideFolders, name]
                        : filter.hideFolders.filter((f) => f.toLowerCase() !== name.toLowerCase());
                      applyFilter({ ...filter, hideFolders: next });
                    }}
                  />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                </label>
              );
            })}
          </div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6 }}>{t("explorerFilter.fileFormats")}</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, marginBottom: 10, maxHeight: 140, overflowY: "auto" }}>
            {HIDEABLE_FILE_EXTS.map((ext) => {
              const checked = filter.hideExts.includes(ext.toLowerCase());
              return (
                <label key={ext} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text)", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...filter.hideExts, ext]
                        : filter.hideExts.filter((x) => x.toLowerCase() !== ext.toLowerCase());
                      applyFilter({ ...filter, hideExts: next });
                    }}
                  />
                  .{ext}
                </label>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => { setDraftCustomText(""); applyFilter(DEFAULT_EXPLORER_FILTER); }} style={{ height: 28, padding: "0 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>{t("explorerFilter.restoreDefaults")}</button>
            <button type="button" onClick={closeFilterSettings} style={{ height: 28, padding: "0 10px", borderRadius: 6, border: "1px solid var(--accent)", background: "var(--accent)", color: "#fff", cursor: "pointer", fontSize: 11 }}>{t("explorerFilter.done")}</button>
          </div>
          <div style={{ marginTop: 8, fontSize: 10, color: "var(--text-dim)", lineHeight: 1.45 }}>{t("explorerFilter.gitIgnoredHint")}</div>
        </div>
      )}

      {!changesCollapsed && (
        <div style={{ padding: "0 4px 2px" }}>
          {/* 分支与远端顶栏 */}
          {gitRepositoryState === "repository" && (
            <div
              aria-label={gitInfo.branch ? t("files.gitBranch", { branch: gitInfo.branch }) : t("files.gitDetached")}
              style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 28, padding: "2px 10px 6px", fontSize: 11, color: "var(--text-muted)" }}
            >
              <button
                type="button"
                onClick={() => beginGitWrite("create-branch")}
                title={t("files.gitCreateBranch")}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  height: 24,
                  padding: "0 8px",
                  border: "1px solid var(--border)",
                  borderRadius: 12,
                  background: "var(--bg-panel)",
                  color: "var(--text)",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                  maxWidth: 150,
                  flexShrink: 0,
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.8 }}>
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {gitInfo.branch ?? t("files.gitDetached")}
                </span>
              </button>
              {gitInfo.upstream && (
                <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0, overflow: "hidden", color: "var(--text-dim)", fontSize: 10 }}>
                  <span style={{ maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {gitInfo.upstream}
                  </span>
                  {gitInfo.ahead !== 0 || gitInfo.behind !== 0 ? (
                    <span style={{ color: gitInfo.ahead > 0 ? "var(--accent)" : "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 600 }}>
                      {gitInfo.ahead > 0 ? `↑${gitInfo.ahead}` : ""} {gitInfo.behind > 0 ? `↓${gitInfo.behind}` : ""}
                    </span>
                  ) : (
                    <span style={{ color: "#16a34a", fontSize: 10, fontWeight: 700 }} title={t("files.gitCleanAndSynced")}>✓</span>
                  )}
                </div>
              )}
              {gitFiles.length > 0 && gitInfo.upstream && gitInfo.ahead > 0 && (
                <button
                  type="button"
                  onClick={() => beginGitWrite("push")}
                  title={t("files.gitPushAhead", { count: gitInfo.ahead })}
                  style={{
                    marginLeft: "auto",
                    height: 22,
                    padding: "0 7px",
                    border: "1px solid var(--accent)",
                    borderRadius: 4,
                    background: "color-mix(in srgb, var(--accent) 10%, var(--bg))",
                    color: "var(--accent)",
                    cursor: "pointer",
                    fontSize: 10,
                    fontWeight: 600,
                    display: "flex",
                    alignItems: "center",
                    gap: 3,
                    flexShrink: 0,
                    whiteSpace: "nowrap",
                    lineHeight: 1,
                  }}
                >
                  <span>↑{gitInfo.ahead}</span>
                  <span>{t("files.gitPushCompact")}</span>
                </button>
              )}
            </div>
          )}

          {gitRepositoryState === "loading" ? (
            <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
              {t("files.gitStatusLoading")}
            </div>
          ) : gitRepositoryState === "not-repository" ? (
            <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
              {t("files.notGitRepository")}
            </div>
          ) : gitRepositoryState === "error" ? (
            <div style={{ padding: "8px 12px", fontSize: 11, color: "#dc2626" }}>
              {t("files.gitStatusUnavailable")}
            </div>
          ) : gitFiles.length > 0 ? (
            <>
              {/* Trae 风格 Commit Box */}
              <div style={{ padding: "0 10px 8px" }}>
                <div style={{
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  background: "var(--bg-panel)",
                  overflow: "hidden",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
                }}>
                  <div style={{ position: "relative", padding: "6px 8px" }}>
                    <textarea
                      value={gitWriteMessage}
                      onChange={(event) => setGitWriteMessage(event.target.value)}
                      placeholder={t("files.gitCommitPlaceholder")}
                      rows={2}
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        border: "none",
                        background: "transparent",
                        color: "var(--text)",
                        font: "12px/1.4 var(--font-sans, inherit)",
                        resize: "none",
                        outline: "none",
                        padding: 0,
                        paddingRight: 28,
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => void runGitAi("commit-message")}
                      disabled={gitAiState === "loading"}
                      title={t("files.gitAiCommitMessage")}
                      style={{
                        position: "absolute",
                        top: 6,
                        right: 6,
                        width: 22,
                        height: 22,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        border: "1px solid color-mix(in srgb, var(--accent) 25%, transparent)",
                        borderRadius: 4,
                        background: "color-mix(in srgb, var(--accent) 10%, var(--bg-panel))",
                        color: "var(--accent)",
                        cursor: gitAiState === "loading" ? "wait" : "pointer",
                        opacity: gitAiState === "loading" ? 0.6 : 1,
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M8 1L9.2 5.8L14 7L9.2 8.2L8 13L6.8 8.2L2 7L6.8 5.8L8 1Z" />
                        <path d="M13 10L13.5 12L15.5 12.5L13.5 13L13 15L12.5 13L10.5 12.5L12.5 12L13 10Z" opacity="0.8" />
                      </svg>
                    </button>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px 6px", borderTop: "1px solid var(--border)" }}>
                    {stagedGitPaths.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => beginGitWrite("commit")}
                        title={t("files.gitCommitStaged")}
                        style={{
                          flex: 1,
                          height: 25,
                          padding: "0 10px",
                          border: "none",
                          borderRadius: 4,
                          background: "var(--accent)",
                          color: "#fff",
                          cursor: "pointer",
                          fontSize: 11,
                          fontWeight: 600,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 4,
                        }}
                      >
                        <span>{t("files.gitCommitStaged")} ({stagedGitPaths.length})</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => beginGitWrite("stage")}
                        title={t("files.gitStageChanges")}
                        style={{
                          flex: 1,
                          height: 25,
                          padding: "0 10px",
                          border: "1px solid var(--border)",
                          borderRadius: 4,
                          background: "var(--bg)",
                          color: "var(--text)",
                          cursor: "pointer",
                          fontSize: 11,
                          fontWeight: 550,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <span>{t("files.gitStageChanges")}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void runGitAi("summary")}
                      disabled={gitAiState === "loading"}
                      title={t("files.gitAiSummary")}
                      style={{
                        height: 25,
                        padding: "0 8px",
                        border: "1px solid var(--border)",
                        borderRadius: 4,
                        background: "var(--bg)",
                        color: "var(--text-dim)",
                        cursor: gitAiState === "loading" ? "wait" : "pointer",
                        fontSize: 10,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t("files.gitAiSummary")}
                    </button>
                  </div>
                </div>
                {gitWriteState === "success" && gitWriteFeedback && <div role="status" style={{ color: "#16a34a", fontSize: 10, marginTop: 4 }}>{gitWriteFeedback}</div>}
                {gitWriteState === "error" && gitWriteError && <div role="alert" style={{ color: "#dc2626", fontSize: 10, marginTop: 4, overflowWrap: "anywhere" }}>{t("files.gitWriteFailed", { error: gitWriteError })}</div>}
              </div>

              {/* Section 1: 更改手风琴 (CHANGES) */}
              <div
                aria-label={t("files.changeStats", {
                  count: gitFiles.length,
                  additions: gitLineStats.additions,
                  deletions: gitLineStats.deletions,
                })}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  height: 24,
                  padding: "0 10px",
                  color: "var(--text-muted)",
                  fontSize: 11,
                  fontWeight: 600,
                  userSelect: "none",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ textTransform: "uppercase", letterSpacing: "0.03em" }}>
                    {t("files.changedCount", { count: gitFiles.length })}
                  </span>
                  <span style={{ color: GIT_STATUS_COLORS.added, fontFamily: "var(--font-mono)", fontSize: 10, marginLeft: 3 }}>+{gitLineStats.additions}</span>
                  <span style={{ color: GIT_STATUS_COLORS.deleted, fontFamily: "var(--font-mono)", fontSize: 10 }}>-{gitLineStats.deletions}</span>
                </div>
                <button
                  type="button"
                  onClick={() => beginGitWrite("stage")}
                  title={t("files.gitStageChanges")}
                  style={{
                    width: 20,
                    height: 20,
                    padding: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: "none",
                    borderRadius: 3,
                    background: "transparent",
                    color: "var(--text-dim)",
                    cursor: "pointer",
                  }}
                  onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; }}
                  onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; event.currentTarget.style.color = "var(--text-dim)"; }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
              </div>

              {/* 文件行列表 */}
              {gitFiles.map((status) => (
                <ChangeRow key={status.filePath} status={status} cwd={cwd} onOpenFile={onOpenFile} t={t} />
              ))}
            </>
          ) : (
            <div style={{
              margin: "8px 10px 12px",
              padding: "16px 12px 14px",
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "color-mix(in srgb, var(--bg) 85%, var(--bg-panel))",
              textAlign: "center",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
            }}>
              <div style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                background: "rgba(22, 163, 74, 0.12)",
                color: "#16a34a",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                {t("files.gitCleanTitle")}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.4, maxWidth: 220 }}>
                {gitInfo.upstream && gitInfo.ahead === 0 && gitInfo.behind === 0
                  ? t("files.gitCleanAndSynced")
                  : (t("files.gitCleanDesc") || t("files.noChangedFiles"))}
              </div>

              {gitInfo.upstream && gitInfo.ahead > 0 && (
                <div style={{ marginTop: 4 }}>
                  <button
                    type="button"
                    onClick={() => beginGitWrite("push")}
                    title={t("files.gitPushAhead", { count: gitInfo.ahead })}
                    style={{
                      height: 26,
                      padding: "0 11px",
                      border: "1px solid var(--accent)",
                      borderRadius: 5,
                      background: "var(--accent)",
                      color: "#fff",
                      cursor: "pointer",
                      fontSize: 11,
                      fontWeight: 500,
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                    }}
                  >
                    <span>↑{gitInfo.ahead}</span>
                    <span>{t("files.gitPush")}</span>
                  </button>
                </div>
              )}

              <div style={{ marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
                <button
                  type="button"
                  onClick={() => beginGitWrite("create-branch")}
                  title={t("files.gitCreateBranch")}
                  style={{
                    height: 24,
                    padding: "0 8px",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    background: "var(--bg)",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 10,
                    display: "flex",
                    alignItems: "center",
                    gap: 3,
                  }}
                >
                  <span style={{ fontSize: 12, lineHeight: 1 }}>+</span>
                  <span>{t("files.gitCreateBranch")}</span>
                </button>
                {gitHubSnapshot && gitHubSnapshot.available && gitHubSnapshot.repository && gitHubSnapshot.defaultBranch && gitInfo.branch && gitInfo.branch !== gitHubSnapshot.defaultBranch && gitInfo.upstream && gitInfo.ahead === 0 && gitInfo.behind === 0 && (
                  <button
                    type="button"
                    onClick={() => beginGitWrite("create-pr")}
                    title={t("files.gitCreatePr")}
                    style={{
                      height: 24,
                      padding: "0 8px",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      background: "var(--bg)",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: 10,
                    }}
                  >
                    {t("files.gitCreatePr")}
                  </button>
                )}
              </div>

              {gitWriteState === "success" && gitWriteFeedback && <span role="status" style={{ color: "#16a34a", fontSize: 10, marginTop: 4 }}>{gitWriteFeedback}</span>}
              {gitWriteState === "error" && gitWriteError && <span role="alert" style={{ color: "#dc2626", fontSize: 10, overflowWrap: "anywhere", marginTop: 4 }}>{t("files.gitWriteFailed", { error: gitWriteError })}</span>}
            </div>
          )}

          {/* Section 2: 提交历史沉底手风琴 (COMMITS) */}
          {gitRepositoryState === "repository" && (
            <div style={{ marginTop: 8, borderTop: "1px solid var(--border)" }}>
              <div
                onClick={toggleGitHistory}
                title={t("files.gitHistory")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  height: 26,
                  padding: "0 10px",
                  color: "var(--text-muted)",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ fontSize: 9, transform: gitHistoryOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s ease", display: "inline-block" }}>▶</span>
                  <span style={{ textTransform: "uppercase", letterSpacing: "0.03em" }}>{t("files.gitHistoryTitle")}</span>
                  {gitHistory.length > 0 && <span style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 500 }}>({gitHistory.length})</span>}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  {gitHistory.length > 0 && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (gitAiText && gitAiMode === "release-notes" && gitAiState === "ready") {
                          setReleaseNotesModalOpen(true);
                        } else {
                          void runGitAi("release-notes");
                        }
                      }}
                      disabled={gitAiState === "loading"}
                      title={t("files.gitAiReleaseNotes")}
                      style={{
                        height: 20,
                        padding: "0 6px",
                        border: "1px solid var(--border)",
                        borderRadius: 3,
                        background: "var(--bg)",
                        color: "var(--text-dim)",
                        cursor: gitAiState === "loading" ? "wait" : "pointer",
                        fontSize: 10,
                        display: "flex",
                        alignItems: "center",
                        gap: 3,
                      }}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3Z" />
                      </svg>
                      <span>{gitAiText && gitAiMode === "release-notes" && gitAiState === "ready"
                        ? t("files.gitAiReleaseNotesView")
                        : t("files.gitAiReleaseNotes")}</span>
                    </button>
                  )}
                </div>
              </div>

              {gitHistoryOpen && (
                <div style={{ padding: "4px 6px 10px" }}>
                  {gitHistoryState === "loading" ? (
                    <div role="status" aria-live="polite" style={{ padding: "6px 8px", color: "var(--text-dim)", fontSize: 10 }}>{t("files.gitHistoryLoading")}</div>
                  ) : gitHistoryState === "error" ? (
                    <div role="alert" style={{ padding: "6px 8px", color: "#dc2626", fontSize: 10, overflowWrap: "anywhere" }}>{t("files.gitHistoryFailed", { error: gitHistoryError ?? "" })}</div>
                  ) : gitHistory.length === 0 ? (
                    <div style={{ padding: "6px 8px", color: "var(--text-dim)", fontSize: 10 }}>{t("files.gitHistoryEmpty")}</div>
                  ) : (
                    <div style={{ display: "grid", gap: 2, maxHeight: 220, overflowY: "auto" }}>
                      {gitHistory.map((commit) => (
                        <button
                          key={commit.hash}
                          type="button"
                          onClick={() => void loadGitCommitDetail(commit.hash)}
                          style={{
                            display: "block",
                            width: "100%",
                            padding: "4px 6px",
                            border: "1px solid transparent",
                            borderRadius: 4,
                            background: gitCommitDetail?.hash === commit.hash ? "var(--bg-hover)" : "transparent",
                            color: "var(--text)",
                            cursor: "pointer",
                            textAlign: "left",
                          }}
                        >
                          <div style={{ display: "flex", gap: 6, minWidth: 0, alignItems: "baseline" }}>
                            <code style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{commit.shortHash}</code>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, fontWeight: 500 }}>{commit.subject}</span>
                          </div>
                          <div style={{ marginTop: 2, color: "var(--text-dim)", fontSize: 9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {commit.author} · {commit.authoredAt.slice(0, 10)}{commit.refs.length > 0 ? ` · ${commit.refs.join(", ")}` : ""}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}

                  {gitCommitDetailState === "loading" && (
                    <div role="status" aria-live="polite" style={{ marginTop: 6, padding: "0 6px", color: "var(--text-dim)", fontSize: 10 }}>{t("files.gitCommitDetailLoading")}</div>
                  )}
                  {gitCommitDetailState === "error" && gitCommitDetailError && (
                    <div role="alert" style={{ marginTop: 6, padding: "0 6px", color: "#dc2626", fontSize: 10, overflowWrap: "anywhere" }}>{t("files.gitCommitDetailFailed", { error: gitCommitDetailError })}</div>
                  )}
                  {gitCommitDetailState === "ready" && gitCommitDetail && (
                    <div style={{ marginTop: 6, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg-panel)" }}>
                      <div style={{ color: "var(--text)", fontSize: 11, fontWeight: 500 }}>{gitCommitDetail.subject}</div>
                      <div style={{ marginTop: 2, color: "var(--text-dim)", fontSize: 9 }}>{gitCommitDetail.author} · {gitCommitDetail.authoredAt}</div>
                      {gitCommitDetail.files.length > 0 ? (
                        <div style={{ display: "grid", gap: 2, marginTop: 5 }}>
                          {gitCommitDetail.files.map((file) => (
                            <div key={`${file.status}:${file.path}`} style={{ display: "flex", gap: 5, minWidth: 0, color: "var(--text-dim)", font: "10px/1.35 var(--font-mono)" }}>
                              <span style={{ flexShrink: 0 }}>{file.status}</span>
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div style={{ marginTop: 5, color: "var(--text-dim)", fontSize: 10 }}>{t("files.gitNoCommitFiles")}</div>
                      )}
                    </div>
                  )}

                  {gitHubState === "loading" && (
                    <div role="status" aria-live="polite" style={{ marginTop: 6, padding: "0 6px", color: "var(--text-dim)", fontSize: 10 }}>{t("files.gitHubLoading")}</div>
                  )}
                  {gitHubState === "error" && gitHubError && (
                    <div role="alert" style={{ marginTop: 6, padding: "0 6px", color: "#dc2626", fontSize: 10, overflowWrap: "anywhere" }}>{t("files.gitHubRequestFailed", { error: gitHubError })}</div>
                  )}
                  {gitHubState === "ready" && gitHubSnapshot && !gitHubSnapshot.available && (
                    <div style={{ marginTop: 6, padding: "0 6px", color: "var(--text-dim)", fontSize: 10 }}>{gitHubReasonText(gitHubSnapshot.reason)}</div>
                  )}
                  {gitHubState === "ready" && gitHubSnapshot && gitHubSnapshot.available && gitHubSnapshot.repository && (
                    <div style={{ marginTop: 8, paddingTop: 6, borderTop: "1px solid var(--border)" }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0, color: "var(--text-muted)", fontSize: 10 }}>
                        <span>{t("files.gitHub")}</span>
                        <code style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)" }}>{gitHubSnapshot.repository.owner}/{gitHubSnapshot.repository.repo}</code>
                      </div>
                      <div role="tablist" aria-label={t("files.gitHub")} style={{ display: "flex", gap: 4, marginTop: 6 }}>
                        {(["pulls", "issues", "checks"] as GitHubTab[]).map((tab) => (
                          <button key={tab} type="button" role="tab" aria-selected={gitHubTab === tab} onClick={() => setGitHubTab(tab)} style={{ height: 22, padding: "0 6px", border: `1px solid ${gitHubTab === tab ? "var(--accent)" : "var(--border)"}`, borderRadius: 4, background: gitHubTab === tab ? "color-mix(in srgb, var(--accent) 12%, var(--bg))" : "var(--bg)", color: gitHubTab === tab ? "var(--text)" : "var(--text-dim)", cursor: "pointer", fontSize: 10 }}>
                            {tab === "pulls" ? t("files.gitHubPullRequests") : tab === "issues" ? t("files.gitHubIssues") : t("files.gitHubChecks")}
                          </button>
                        ))}
                      </div>
                      {gitHubSnapshot.warnings.length > 0 && (
                        <div style={{ marginTop: 5, color: "var(--text-dim)", fontSize: 9 }}>{t("files.gitHubPartial")}</div>
                      )}
                      {gitHubTab === "pulls" && (gitHubSnapshot.pullRequests.length === 0 ? (
                        <div style={{ marginTop: 6, color: "var(--text-dim)", fontSize: 10 }}>{t("files.gitHubNoItems")}</div>
                      ) : (
                        <div style={{ display: "grid", gap: 2, marginTop: 6, maxHeight: 160, overflowY: "auto" }}>
                          {gitHubSnapshot.pullRequests.map((item) => (
                            <a key={item.number} href={item.htmlUrl} target="_blank" rel="noreferrer" style={{ display: "block", padding: "3px 4px", borderRadius: 4, color: "var(--text)", textDecoration: "none" }}>
                              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10 }}>#{item.number} {item.title}</div>
                              <div style={{ marginTop: 1, color: "var(--text-dim)", fontSize: 9 }}>{item.author ?? "-"} · {item.updatedAt.slice(0, 10)}{item.draft ? ` · ${t("files.gitHubDraft")}` : ""}</div>
                            </a>
                          ))}
                        </div>
                      ))}
                      {gitHubTab === "issues" && (gitHubSnapshot.issues.length === 0 ? (
                        <div style={{ marginTop: 6, color: "var(--text-dim)", fontSize: 10 }}>{t("files.gitHubNoItems")}</div>
                      ) : (
                        <div style={{ display: "grid", gap: 2, marginTop: 6, maxHeight: 160, overflowY: "auto" }}>
                          {gitHubSnapshot.issues.map((item) => (
                            <a key={item.number} href={item.htmlUrl} target="_blank" rel="noreferrer" style={{ display: "block", padding: "3px 4px", borderRadius: 4, color: "var(--text)", textDecoration: "none" }}>
                              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10 }}>#{item.number} {item.title}</div>
                              <div style={{ marginTop: 1, color: "var(--text-dim)", fontSize: 9 }}>{item.author ?? "-"} · {item.updatedAt.slice(0, 10)}</div>
                            </a>
                          ))}
                        </div>
                      ))}
                      {gitHubTab === "checks" && (gitHubSnapshot.checks.length === 0 ? (
                        <div style={{ marginTop: 6, color: "var(--text-dim)", fontSize: 10 }}>{t("files.gitHubNoChecks")}</div>
                      ) : (
                        <div style={{ display: "grid", gap: 2, marginTop: 6, maxHeight: 160, overflowY: "auto" }}>
                          {gitHubSnapshot.checks.map((item) => (
                            item.htmlUrl ? (
                              <a key={`${item.name}:${item.startedAt ?? ""}`} href={item.htmlUrl} target="_blank" rel="noreferrer" style={{ display: "block", padding: "3px 4px", borderRadius: 4, color: "var(--text)", textDecoration: "none" }}>
                                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10 }}>{item.name}</div>
                                <div style={{ marginTop: 1, color: "var(--text-dim)", fontSize: 9 }}>{item.status}{item.conclusion ? ` · ${item.conclusion}` : ""}</div>
                              </a>
                            ) : (
                              <div key={`${item.name}:${item.startedAt ?? ""}`} style={{ padding: "3px 4px", color: "var(--text)", fontSize: 10 }}>
                                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10 }}>{item.name}</div>
                                <div style={{ marginTop: 1, color: "var(--text-dim)", fontSize: 9 }}>{item.status}{item.conclusion ? ` · ${item.conclusion}` : ""}</div>
                              </div>
                            )
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {changesCollapsed && (
        <div style={{ padding: "2px 4px" }} onContextMenu={handleRootContextMenu}>
          {!filterReady || loading ? (
            <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>{t("files.loading")}</div>
          ) : error ? (
            <div style={{ padding: "8px 12px", fontSize: 11, color: "#f87171" }}>{error}</div>
          ) : (
            roots.map((node) => (
              <TreeNode
                key={`${remotePeer ?? "local"}:${cwd}:${node.fullPath}`}
                node={node}
                depth={0}
                cwd={cwd}
                peer={remotePeerRef.current}
                onOpenFile={onOpenFile}
                onChildrenLoaded={handleChildrenLoaded}
                onChildrenLoadSettled={handleChildrenLoadSettled}
                onAtMention={onAtMention}
                expandedPaths={expandedPaths}
                onToggleExpanded={handleToggleExpanded}
                refreshToken={refreshToken}
                highlightedPaths={highlightedPaths}
                locatedPath={locatedPath}
                filter={filter}
                gitStatusByPath={gitStatusByPath}
                changedDirectoryPaths={changedDirectoryPaths}
                t={t}
                onRequestDelete={handleRequestDelete}
                deleteConfirmation={deleteConfirmation}
                onRequestRename={handleRequestRename}
                onRequestCreate={handleRequestCreate}
                onRequestUpload={handleRequestUpload}
                dropTargetPath={dropTargetPath}
                onDropFiles={handleDropFiles}
                onDropTargetChange={handleDropTargetChange}
              />
            ))
          )}
          {filterReady && !loading && !error && roots.length === 0 && (
            <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
              {t("files.noFiles")}
            </div>
          )}
        </div>
      )}
      {rootContextMenu && (
        <div
          data-file-action-menu="true"
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
          style={{ position: "fixed", left: rootContextMenu.x, top: rootContextMenu.y, zIndex: 300, minWidth: 212, padding: 4, border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg-panel)", boxShadow: "0 8px 24px rgba(0,0,0,0.18)" }}
        >
          <FileActionMenuItem kind="folder" label={t("files.newFolder")} onClick={() => { setRootContextMenu(null); requestCreate("folder", cwd); }} />
          <FileActionMenuItem kind="file" label={t("files.newDocument")} onClick={() => { setRootContextMenu(null); requestCreate("file", cwd); }} />
          <FileActionMenuItem kind="upload" label={t("files.uploadToRoot")} onClick={() => { setRootContextMenu(null); requestUpload(cwd); }} />
        </div>
      )}
      {pendingGitWrite && pendingGitWrite.generation === workspaceRef.current.generation && (
        <div
          role="presentation"
          onClick={(event) => {
            if (!gitWriteBusy && event.target === event.currentTarget) setPendingGitWrite(null);
          }}
          style={{ position: "fixed", inset: 0, zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,0.4)" }}
        >
          <div role="dialog" aria-modal="true" aria-labelledby="git-write-title" style={{ width: 520, maxWidth: "100%", maxHeight: "calc(100vh - 32px)", overflow: "auto", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", boxShadow: "0 12px 36px rgba(0,0,0,0.28)" }}>
            <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid var(--border)" }}>
              <h3 id="git-write-title" style={{ margin: 0, color: "var(--text)", fontSize: 14 }}>{pendingGitWrite.action === "stage" ? t("files.gitStageChanges") : pendingGitWrite.action === "commit" ? t("files.gitCommitStaged") : pendingGitWrite.action === "push" ? t("files.gitPush") : pendingGitWrite.action === "create-pr" ? t("files.gitCreatePr") : t("files.gitCreateBranch")}</h3>
              <div style={{ marginTop: 5, color: "var(--text-muted)", fontSize: 11 }}>{t("files.gitWriteWarning")}</div>
            </div>
            <div style={{ display: "grid", gap: 7, padding: 16, color: "var(--text-muted)", fontSize: 11 }}>
              <div><strong>{t("files.gitWriteDevice")}:</strong> {pendingGitWrite.peer ?? t("files.gitLocalDevice")}</div>
              <div><strong>{t("files.gitWriteRepository")}:</strong> <code style={{ overflowWrap: "anywhere" }}>{pendingGitWrite.cwd}</code></div>
              <div><strong>{t("files.gitWriteBranch")}:</strong> {gitInfo.branch ?? t("files.gitDetached")}</div>
              <div><strong>{t("files.gitWriteUpstream")}:</strong> {gitInfo.upstream ?? t("files.gitNoUpstream")}</div>
              {pendingGitWrite.action === "create-pr" && gitHubSnapshot?.repository && (
                <div><strong>{t("files.gitWriteRemote")}:</strong> <code>{gitHubSnapshot.repository.owner}/{gitHubSnapshot.repository.repo}</code></div>
              )}
              {pendingGitWrite.paths.length > 0 && (
                <div><strong>{t("files.gitWriteFiles")}:</strong> {pendingGitWrite.paths.length}
                  <pre style={{ maxHeight: 150, margin: "5px 0 0", overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--text-dim)", font: "10px/1.4 var(--font-mono)" }}>{pendingGitWrite.paths.join("\n")}</pre>
                </div>
              )}
              <div><strong>{t("files.gitWriteCommand")}:</strong><pre style={{ margin: "5px 0 0", padding: 7, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)", font: "10px/1.4 var(--font-mono)" }}>{gitWriteCommand}</pre></div>
              {pendingGitWrite.action === "commit" && (
                <label style={{ display: "grid", gap: 4 }}>
                  <span>{t("files.gitWriteMessage")}</span>
                  <textarea value={gitWriteMessage} onChange={(event) => setGitWriteMessage(event.target.value)} rows={5} autoFocus style={{ width: "100%", boxSizing: "border-box", resize: "vertical", padding: 7, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)", font: "11px/1.45 var(--font-mono)" }} />
                </label>
              )}
              {pendingGitWrite.action === "create-branch" && (
                <label style={{ display: "grid", gap: 4 }}>
                  <span>{t("files.gitWriteBranchName")}</span>
                  <input value={gitWriteBranchName} onChange={(event) => setGitWriteBranchName(event.target.value)} autoFocus placeholder="feature/example" style={{ width: "100%", boxSizing: "border-box", padding: "7px 8px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)", font: "11px var(--font-mono)" }} />
                </label>
              )}
              {pendingGitWrite.action === "create-pr" && (
                <>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span>{t("files.gitPrTitle")}</span>
                    <input value={gitPrTitle} onChange={(event) => setGitPrTitle(event.target.value)} autoFocus style={{ width: "100%", boxSizing: "border-box", padding: "7px 8px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)", font: "11px var(--font-mono)" }} />
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span>{t("files.gitPrBase")}</span>
                    <input value={gitPrBase} onChange={(event) => setGitPrBase(event.target.value)} placeholder="main" style={{ width: "100%", boxSizing: "border-box", padding: "7px 8px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)", font: "11px var(--font-mono)" }} />
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span>{t("files.gitPrBody")}</span>
                    <textarea value={gitPrBody} onChange={(event) => setGitPrBody(event.target.value)} rows={6} style={{ width: "100%", boxSizing: "border-box", resize: "vertical", padding: 7, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)", font: "11px/1.45 var(--font-mono)" }} />
                  </label>
                </>
              )}
              {gitWriteState === "error" && gitWriteError && <div role="alert" style={{ color: "#f87171", overflowWrap: "anywhere" }}>{t("files.gitWriteFailed", { error: gitWriteError })}</div>}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "0 16px 14px" }}>
              <button type="button" onClick={() => setPendingGitWrite(null)} disabled={gitWriteBusy} style={{ height: 30, padding: "0 11px", border: "1px solid var(--border)", borderRadius: 5, background: "transparent", color: "var(--text-muted)", cursor: gitWriteBusy ? "not-allowed" : "pointer", fontSize: 11 }}>{t("files.gitWriteCancel")}</button>
              <button type="button" onClick={() => void confirmGitWrite()} disabled={gitWriteBusy || (pendingGitWrite.action === "commit" && !gitWriteMessage.trim()) || (pendingGitWrite.action === "create-branch" && !gitWriteBranchName.trim()) || (pendingGitWrite.action === "create-pr" && (!gitPrTitle.trim() || !gitPrBase.trim()))} style={{ height: 30, padding: "0 11px", border: "1px solid var(--accent)", borderRadius: 5, background: "var(--accent)", color: "#fff", cursor: gitWriteBusy ? "wait" : "pointer", opacity: gitWriteBusy ? 0.7 : 1, fontSize: 11 }}>{gitWriteBusy ? t("files.gitWriteWorking") : t("files.gitWriteConfirm")}</button>
            </div>
          </div>
        </div>
      )}
      {pendingCreate && (
        <div
          role="presentation"
          onClick={(event) => {
            if (!createBusy && event.target === event.currentTarget) handleCreateCancel();
          }}
          style={{ position: "fixed", inset: 0, zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,0.4)" }}
        >
          <div role="dialog" aria-modal="true" aria-labelledby="file-create-title" style={{ width: 440, maxWidth: "100%", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", boxShadow: "0 12px 36px rgba(0,0,0,0.24)", overflow: "hidden" }}>
            <div style={{ padding: "18px 18px 14px" }}>
              <div id="file-create-title" style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
                {t(pendingCreate.kind === "folder" ? "files.newFolder" : "files.newDocument")}
              </div>
              <label htmlFor="file-create-input" style={{ display: "grid", gap: 6, marginTop: 14, color: "var(--text-muted)", fontSize: 12 }}>
                {t(pendingCreate.kind === "folder" ? "files.createFolderPrompt" : "files.createDocumentPrompt")}
                <input
                  ref={createInputRef}
                  id="file-create-input"
                  value={createValue}
                  disabled={createBusy}
                  onChange={(event) => setCreateValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") { event.preventDefault(); handleCreateCancel(); }
                    if (event.key === "Enter") { event.preventDefault(); void handleCreateConfirm(); }
                  }}
                  style={{ width: "100%", boxSizing: "border-box", height: 34, padding: "0 9px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none" }}
                />
              </label>
              <code style={{ display: "block", marginTop: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10, overflowWrap: "anywhere" }}>
                {pendingCreate.directory}
              </code>
              {createError && (
                <div role="alert" style={{ marginTop: 10, color: "#ef4444", fontSize: 12, lineHeight: 1.5, overflowWrap: "anywhere" }}>
                  {t("files.createFailed")}: {createError}
                </div>
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
              <button type="button" onClick={handleCreateCancel} disabled={createBusy} style={{ height: 32, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 5, background: "transparent", color: "var(--text-muted)", cursor: createBusy ? "not-allowed" : "pointer", fontSize: 12 }}>{t("files.cancel")}</button>
              <button type="button" onClick={() => void handleCreateConfirm()} disabled={createBusy || !createValue.trim()} style={{ height: 32, padding: "0 12px", border: "1px solid var(--accent)", borderRadius: 5, background: "var(--accent)", color: "#fff", cursor: createBusy ? "wait" : "pointer", opacity: createBusy ? 0.7 : 1, fontSize: 12, fontWeight: 600 }}>{createBusy ? t("files.creating") : t("files.createConfirm")}</button>
            </div>
          </div>
        </div>
      )}
      {pendingRename && (
        <div
          role="presentation"
          onClick={(event) => {
            if (!renameBusy && event.target === event.currentTarget) handleRenameCancel();
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            background: "rgba(0,0,0,0.4)",
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="file-rename-title"
            style={{
              width: 440,
              maxWidth: "100%",
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--bg-panel)",
              boxShadow: "0 12px 36px rgba(0,0,0,0.24)",
              overflow: "hidden",
            }}
          >
            <div style={{ padding: "18px 18px 14px" }}>
              <div id="file-rename-title" style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
                {t(pendingRename.isDir ? "files.renameFolder" : "files.renameFile")}
              </div>
              <label htmlFor="file-rename-input" style={{ display: "grid", gap: 6, marginTop: 14, color: "var(--text-muted)", fontSize: 12 }}>
                {t(pendingRename.isDir ? "files.renameFolderPrompt" : "files.renameFilePrompt")}
                <input
                  ref={renameInputRef}
                  id="file-rename-input"
                  value={renameValue}
                  disabled={renameBusy}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") { event.preventDefault(); handleRenameCancel(); }
                    if (event.key === "Enter") { event.preventDefault(); void handleRenameConfirm(); }
                  }}
                  style={{ width: "100%", boxSizing: "border-box", height: 34, padding: "0 9px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none" }}
                />
              </label>
              <code style={{ display: "block", marginTop: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10, overflowWrap: "anywhere" }}>
                {pendingRename.fullPath}
              </code>
              {renameError && (
                <div role="alert" style={{ marginTop: 10, color: "#ef4444", fontSize: 12, lineHeight: 1.5, overflowWrap: "anywhere" }}>
                  {t("files.renameFailed")}: {renameError}
                </div>
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
              <button
                type="button"
                onClick={handleRenameCancel}
                disabled={renameBusy}
                style={{ height: 32, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 5, background: "transparent", color: "var(--text-muted)", cursor: renameBusy ? "not-allowed" : "pointer", fontSize: 12 }}
              >
                {t("files.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void handleRenameConfirm()}
                disabled={renameBusy || !renameValue.trim()}
                style={{ height: 32, padding: "0 12px", border: "1px solid var(--accent)", borderRadius: 5, background: "var(--accent)", color: "#fff", cursor: renameBusy ? "wait" : "pointer", opacity: renameBusy ? 0.7 : 1, fontSize: 12, fontWeight: 600 }}
              >
                {renameBusy ? t("files.renaming") : t("files.renameConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
      {releaseNotesModalOpen && (
        <div
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setReleaseNotesModalOpen(false);
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            background: "rgba(0,0,0,0.45)",
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="git-release-notes-title"
            style={{
              width: 580,
              maxWidth: "100%",
              maxHeight: "calc(100vh - 48px)",
              display: "flex",
              flexDirection: "column",
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--bg-panel)",
              boxShadow: "0 16px 40px rgba(0,0,0,0.3)",
              overflow: "hidden",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px 10px", borderBottom: "1px solid var(--border)" }}>
              <div>
                <h3 id="git-release-notes-title" style={{ margin: 0, color: "var(--text)", fontSize: 14, fontWeight: 650 }}>
                  {t("files.gitAiReleaseNotesModalTitle") || t("files.gitAiReleaseNotesResult")}
                </h3>
                <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 11 }}>
                  {t("files.gitAiReleaseNotesHint")}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setReleaseNotesModalOpen(false)}
                aria-label={t("files.cancel")}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "var(--text-dim)",
                  cursor: "pointer",
                  fontSize: 16,
                  lineHeight: 1,
                  padding: "4px 6px",
                  borderRadius: 4,
                }}
              >
                ✕
              </button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: 16, minHeight: 120, maxHeight: "calc(70vh - 100px)" }}>
              {gitAiState === "loading" && (
                <div role="status" aria-live="polite" style={{ padding: "20px 0", textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>
                  {t("files.gitAiWorking")}
                </div>
              )}
              {gitAiState === "error" && gitAiError && (
                <div role="alert" style={{ padding: "12px 0", color: "#f87171", fontSize: 11, overflowWrap: "anywhere" }}>
                  {t("files.gitAiFailed", { error: gitAiError })}
                </div>
              )}
              {gitAiState === "ready" && gitAiText && (
                <pre style={{ margin: 0, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--text)", font: "11px/1.6 var(--font-mono)" }}>
                  {gitAiText}
                </pre>
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderTop: "1px solid var(--border)", background: "var(--bg)" }}>
              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                {t("files.gitAiDraftNotice")}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                {gitAiState === "ready" && gitAiText && (
                  <button
                    type="button"
                    onClick={() => void handleCopyGitAiText()}
                    style={{
                      height: 28,
                      padding: "0 12px",
                      border: "1px solid var(--border)",
                      borderRadius: 5,
                      background: "var(--bg-panel)",
                      color: "var(--text)",
                      cursor: "pointer",
                      fontSize: 11,
                      fontWeight: 500,
                    }}
                  >
                    {t("files.gitAiCopy")}
                  </button>
                )}
                {gitAiCopyError && <span role="alert" style={{ alignSelf: "center", maxWidth: 220, color: "#dc2626", fontSize: 10, overflowWrap: "anywhere" }}>{gitAiCopyError}</span>}
                <button
                  type="button"
                  onClick={() => setReleaseNotesModalOpen(false)}
                  style={{
                    height: 28,
                    padding: "0 14px",
                    border: "1px solid var(--accent)",
                    borderRadius: 5,
                    background: "var(--accent)",
                    color: "#fff",
                    cursor: "pointer",
                    fontSize: 11,
                    fontWeight: 500,
                  }}
                >
                  {t("files.cancel")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {fileDragActive && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "sticky",
            bottom: 0,
            zIndex: 1,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 8px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-panel)",
            fontSize: 11,
            color: "var(--accent)",
            userSelect: "none",
            pointerEvents: "none",
          }}
        >
          <Upload size={13} style={{ flexShrink: 0 }} />
          <span>
            {t("files.dropToUpload", {
              directory: dropTargetPath
                ? (getRelativeFilePath(dropTargetPath, cwd) || dropTargetPath)
                : (getFileName(cwd) || cwd),
            })}
          </span>
        </div>
      )}
    </div>
  );
});
