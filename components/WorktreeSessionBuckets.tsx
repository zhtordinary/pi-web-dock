"use client";
import { Check, ChevronRight, MessageSquarePlus, Pencil, Trash2, X } from "lucide-react";
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SessionInfo } from "@/lib/types";
import { addEmptyWorktreeGroups, groupSessionsByWorktree, sortWorktreeSessionGroups, type LinkedWorktree, type WorktreeSessionGroup } from "@/lib/worktree-groups";
import { clampFloatingMenuPosition } from "@/lib/floating-menu-position";
import { apiPathForPeer } from "@/lib/file-api";
import { getVirtualRowWindow, PROJECT_ROW_HEIGHT, SESSION_ROW_HEIGHT, SUBPROJECT_ROW_HEIGHT, type SessionSidebarRow } from "./session-sidebar-virtual";
import { useI18n } from "@/hooks/useI18n";

type InventoryState = { url: string } & ParsedInventory;

export interface WorktreeVirtualTreeNode<T> {
  item: T;
  children: WorktreeVirtualTreeNode<T>[];
}

export interface WorktreeVirtualization<T> {
  scrollTop: number;
  viewportHeight: number;
  originOffset: number;
  overscanRows?: number;
  pinnedIds?: ReadonlySet<string>;
  rowHeights?: Readonly<Record<string, number>>;
  collapsedSessionIds?: ReadonlySet<string>;
  buildTree: (items: T[]) => WorktreeVirtualTreeNode<T>[];
  renderSession: (item: T, depth: number, hasChildren: boolean, collapsed: boolean) => ReactNode;
  onRowMeasure?: (rowId: string, height: number) => void;
  onInteractionChange?: (rowId: string, active: boolean) => void;
}

export interface WorktreeInventoryExpectations {
  projectKey?: string;
  projectRoot?: string;
  deviceId?: string;
  peerId?: string | null;
}

function normalizedPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const root = /^[A-Za-z]:\/$/.test(normalized) || normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
  return root || "/";
}

function sameInventoryPath(left: string, right: string): boolean {
  const a = normalizedPath(left);
  const b = normalizedPath(right);
  return a === b || (a.length >= 2 && b.length >= 2 && /^[A-Za-z]:/.test(a) && /^[A-Za-z]:/.test(b) && a.toLowerCase() === b.toLowerCase());
}

function inventoryPeerId(url: string): string | null {
  try {
    return new URL(url, "http://reader.invalid").searchParams.get("peer");
  } catch {
    return null;
  }
}

export interface ParsedInventory {
  projectKey?: string;
  worktrees: LinkedWorktree[];
}

/** Validate the server envelope and return the linked (non-main) checkouts it lists. */
export function parseInventory(body: unknown, expected: WorktreeInventoryExpectations = {}): ParsedInventory | null {
  if (!body || typeof body !== "object") return null;
  const value = body as { projectKey?: unknown; projectRoot?: unknown; worktrees?: unknown };
  if (!Array.isArray(value.worktrees)) return null;
  if (expected.projectKey !== undefined && (typeof value.projectKey !== "string" || value.projectKey !== expected.projectKey)) return null;
  if (expected.projectRoot !== undefined && (typeof value.projectRoot !== "string" || !sameInventoryPath(value.projectRoot, expected.projectRoot))) return null;
  if (expected.deviceId && expected.peerId && expected.deviceId !== expected.peerId) return null;

  const linked: LinkedWorktree[] = [];
  let projectRootListed = false;
  for (const row of value.worktrees) {
    if (!row || typeof row !== "object") return null;
    const worktree = row as { path?: unknown; branch?: unknown; isMain?: unknown };
    if (typeof worktree.path !== "string" || !worktree.path || typeof worktree.isMain !== "boolean" || (worktree.branch !== null && typeof worktree.branch !== "string")) return null;
    if (expected.projectRoot && sameInventoryPath(worktree.path, expected.projectRoot)) projectRootListed = true;
    if (!worktree.isMain) linked.push({ path: worktree.path, branch: typeof worktree.branch === "string" ? worktree.branch : null });
  }
  if (expected.projectRoot && !projectRootListed) return null;
  return { ...(typeof value.projectKey === "string" ? { projectKey: value.projectKey } : {}), worktrees: linked };
}

const contextMenuItemStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 12px",
  border: 0,
  borderRadius: 4,
  background: "transparent",
  color: "var(--text)",
  cursor: "pointer",
  textAlign: "left",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  fontSize: 12,
  fontWeight: 400,
  lineHeight: 1.35,
  whiteSpace: "nowrap",
  width: "100%",
};

function MeasuredWorktreeVirtualRow({
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
  return <div ref={ref} data-virtual-row-id={rowId} style={{ position: "absolute", top, left: 0, right: 0, minHeight: height }}>{children}</div>;
}

function WorktreeContextMenu({
  group,
  onRenameRequest,
  onDeleteRequest,
  onNewSessionRequest,
  onOpenChange,
  children,
}: {
  group: WorktreeSessionGroup;
  onRenameRequest?: () => void;
  onDeleteRequest?: () => void;
  onNewSessionRequest?: () => void;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onOpenChange?.(Boolean(position));
  }, [onOpenChange, position]);

  const closeMenu = useCallback(() => {
    setPosition(null);
    setMenuPosition(null);
  }, []);

  const openMenu = useCallback((point: { x: number; y: number }) => {
    setMenuPosition(null);
    setPosition(point);
  }, []);

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
      closeMenu();
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

  const menu = position && typeof document !== "undefined"
    ? createPortal(
      <div
        ref={menuRef}
        role="menu"
        tabIndex={-1}
        aria-label={t("worktreeBuckets.menuLabel", { label: group.label })}
        onClick={(e) => e.stopPropagation()}
        style={{
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
          boxShadow: "0 8px 24px rgba(0, 0, 0, 0.2)",
          left: menuPosition?.left ?? -10000,
          top: menuPosition?.top ?? -10000,
          visibility: menuPosition ? "visible" : "hidden",
        }}
      >
        {onNewSessionRequest && (
          <button
            className="reader-context-menu-item"
            type="button"
            role="menuitem"
            onClick={() => { closeMenu(); onNewSessionRequest(); }}
            style={contextMenuItemStyle}
          >
            <MessageSquarePlus size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>{group.kind === "main" ? t("worktreeBuckets.newSessionMain") : group.kind === "project" ? t("worktreeBuckets.newSessionProject") : t("worktreeBuckets.newSessionWorktree")}</span>
          </button>
        )}
        {onRenameRequest && (
          <button
            className="reader-context-menu-item"
            type="button"
            role="menuitem"
            onClick={() => { closeMenu(); onRenameRequest(); }}
            style={contextMenuItemStyle}
          >
            <Pencil size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>{t("worktreeBuckets.renameBranch")}</span>
          </button>
        )}
        {onDeleteRequest && (
          <>
            <div className="reader-context-menu-separator" role="separator" aria-orientation="horizontal" style={{ height: 1, margin: "3px 4px", background: "var(--border)" }} />
            <button
              className="reader-context-menu-item"
              data-danger="true"
              type="button"
              role="menuitem"
              onClick={() => { closeMenu(); onDeleteRequest(); }}
              style={{ ...contextMenuItemStyle, color: "#dc2626" }}
            >
              <Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>{t("worktreeBuckets.deleteWorktree")}</span>
            </button>
          </>
        )}
      </div>,
      document.body,
    ) : null;

  return (
    <span ref={anchorRef} style={{ display: "contents", userSelect: "none" }} onContextMenu={handleContextMenu} onKeyDown={handleContextMenuKey}>
      {children}
      {menu}
    </span>
  );
}

export function WorktreeSessionBuckets<T>({ items, sessionOf, deviceOf, renderItems, mainLabel, worktreeLabel, focusSessionId, focusSessionKey, showProjectPath, inventoryUrl, inventoryProjectKey, inventoryProjectRoot, inventoryDeviceId, onNewSession, virtualization }: {
  items: readonly T[];
  sessionOf: (item: T) => SessionInfo;
  deviceOf?: (item: T) => string;
  renderItems: (items: T[]) => ReactNode;
  mainLabel: string;
  worktreeLabel: string;
  focusSessionId?: string;
  focusSessionKey?: string;
  showProjectPath?: boolean;
  inventoryUrl?: string;
  inventoryProjectKey?: string;
  inventoryProjectRoot?: string;
  inventoryDeviceId?: string;
  onNewSession?: (cwd: string, deviceId?: string) => void;
  virtualization?: WorktreeVirtualization<T>;
}) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [inventory, setInventory] = useState<InventoryState | null>(null);
  const requestId = useRef(0);
  const [refreshRevision, setRefreshRevision] = useState(0);

  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [deleteNeedsForce, setDeleteNeedsForce] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const displayLabel = (group: WorktreeSessionGroup) => group.kind === "main"
    ? mainLabel
    : group.kind === "project"
      ? group.label
      : group.label && group.label !== group.path ? `${worktreeLabel} · ${group.label}` : worktreeLabel;

  useEffect(() => {
    const refresh = () => setRefreshRevision((value) => value + 1);
    window.addEventListener("pi-web:worktree-management-changed", refresh);
    return () => window.removeEventListener("pi-web:worktree-management-changed", refresh);
  }, []);

  useEffect(() => {
    const currentRequest = ++requestId.current;
    if (!inventoryUrl) {
      setInventory(null);
      return;
    }
    const controller = new AbortController();
    const clearInventory = () => {
      if (!controller.signal.aborted && currentRequest === requestId.current) setInventory({ url: inventoryUrl, worktrees: [] });
    };
    void fetch(inventoryUrl, { signal: controller.signal }).then(async response => {
      if (!response.ok) {
        clearInventory();
        return;
      }
      const body = await response.json().catch(() => null);
      const parsed = parseInventory(body, {
        projectKey: inventoryProjectKey,
        projectRoot: inventoryProjectRoot,
        deviceId: inventoryDeviceId,
        peerId: inventoryPeerId(inventoryUrl),
      });
      if (controller.signal.aborted || currentRequest !== requestId.current) return;
      setInventory({ url: inventoryUrl, ...(parsed ?? { worktrees: [] }) });
    }).catch(clearInventory);
    return () => controller.abort();
  }, [inventoryDeviceId, inventoryProjectKey, inventoryProjectRoot, inventoryUrl, refreshRevision]);

  // Mutations go to the device that owns the inventory, with its project root as cwd.
  const canManage = Boolean(inventoryUrl || inventoryProjectRoot);
  const runMutation = async (method: "PATCH" | "DELETE", body: Record<string, unknown>): Promise<{ ok: boolean; dirty: boolean }> => {
    setMutationBusy(true);
    setMutationError(null);
    try {
      const url = new URL(inventoryUrl ?? "/api/worktrees", window.location.origin);
      const peer = url.searchParams.get("peer") ?? undefined;
      const cwd = url.searchParams.get("cwd") ?? inventoryProjectRoot;
      const res = await fetch(apiPathForPeer(peer, "worktrees"), {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, ...body }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null) as { error?: string; dirty?: boolean } | null;
        if (err?.dirty === true) return { ok: false, dirty: true };
        throw new Error(err?.error || `HTTP ${res.status}`);
      }
      window.dispatchEvent(new CustomEvent("pi-web:worktree-management-changed"));
      return { ok: true, dirty: false };
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : t("worktreeBuckets.actionFailed"));
      return { ok: false, dirty: false };
    } finally {
      setMutationBusy(false);
    }
  };

  const handleRename = async (group: WorktreeSessionGroup) => {
    const next = renameValue.trim();
    if (!next || next === group.branch) {
      setRenamingKey(null);
      return;
    }
    const result = await runMutation("PATCH", { path: group.path, branch: next });
    if (result.ok) setRenamingKey(null);
  };

  const handleDelete = async (group: WorktreeSessionGroup) => {
    const result = await runMutation("DELETE", { path: group.path, force: deleteNeedsForce });
    if (result.ok) {
      setDeletingKey(null);
      setDeleteNeedsForce(false);
    } else if (result.dirty) {
      setDeleteNeedsForce(true);
    }
  };

  const cancelDelete = () => {
    setDeletingKey(null);
    setDeleteNeedsForce(false);
    setMutationError(null);
  };

  const groupActions = (group: WorktreeSessionGroup) => ({
    newSession: onNewSession && group.path ? () => onNewSession(group.path, inventoryDeviceId) : undefined,
    rename: canManage && group.kind === "worktree" && group.branch ? () => {
      setRenamingKey(group.key);
      setRenameValue(group.branch ?? "");
    } : undefined,
    remove: canManage && group.kind === "worktree" ? () => {
      setDeleteNeedsForce(false);
      setMutationError(null);
      setDeletingKey(group.key);
    } : undefined,
  });

  const renderDeleteConfirm = (group: WorktreeSessionGroup) => (
    <div className="activity-subproject-delete-confirm" role="alert" style={{ padding: "4px 10px" }}>
      <span>{deleteNeedsForce ? t("worktreeBuckets.deleteDirtyConfirm", { label: group.label }) : t("worktreeBuckets.deleteConfirm", { label: group.label })}</span>
      <button type="button" disabled={mutationBusy} onClick={() => void handleDelete(group)}>{t("chat.confirm")}</button>
      <button type="button" disabled={mutationBusy} onClick={cancelDelete}>{t("i18n.cancel")}</button>
    </div>
  );

  useEffect(() => {
    const id = renamingKey ?? deletingKey;
    virtualization?.onInteractionChange?.(id ? `bucket:${id}` : "", Boolean(id));
  }, [deletingKey, renamingKey, virtualization]);

  if (showProjectPath && !virtualization) {
    const projects = new Map<string, T[]>();
    for (const item of items) {
      const session = sessionOf(item);
      const key = JSON.stringify([deviceOf?.(item) ?? "local", session.projectKey ?? session.projectRoot ?? session.cwd]);
      const rows = projects.get(key) ?? [];
      rows.push(item);
      projects.set(key, rows);
    }
    return [...projects].map(([key, rows]) => {
      const session = sessionOf(rows[0]);
      const path = session.projectRoot ?? session.cwd;
      return <section key={key}>
        <div style={{ padding: "4px 10px", color: "#60a5fa", overflowWrap: "anywhere", fontSize: 11 }}>{path}</div>
        <WorktreeSessionBuckets items={rows} sessionOf={sessionOf} deviceOf={deviceOf} renderItems={renderItems}
          mainLabel={mainLabel} worktreeLabel={worktreeLabel} focusSessionId={focusSessionId} focusSessionKey={focusSessionKey}
          inventoryProjectKey={session.projectKey} inventoryProjectRoot={path} inventoryDeviceId={deviceOf?.(rows[0])}
          inventoryUrl={`/api/worktrees?cwd=${encodeURIComponent(path)}`} onNewSession={onNewSession} />
      </section>;
    });
  }

  const activeInventory = inventory?.url === inventoryUrl ? inventory : null;
  const groups = groupSessionsByWorktree(items, sessionOf, deviceOf);
  const projectKey = inventoryProjectKey ?? activeInventory?.projectKey;
  if (activeInventory && projectKey) addEmptyWorktreeGroups(groups, activeInventory.worktrees, projectKey, inventoryDeviceId);
  const orderedGroups = sortWorktreeSessionGroups(groups);
  if (virtualization) {
    const virtualRows: Array<SessionSidebarRow<T, WorktreeSessionGroup>> = [];
    if (showProjectPath) {
      const first = items[0] ? sessionOf(items[0]) : null;
      if (first) {
        const projectPath = first.projectRoot ?? first.cwd;
        virtualRows.push({
          kind: "project",
          id: `project:${projectPath}`,
          path: projectPath,
          height: virtualization.rowHeights?.[`project:${projectPath}`] ?? PROJECT_ROW_HEIGHT,
        });
      }
    }
    const appendTreeRows = (nodes: WorktreeVirtualTreeNode<T>[], depth: number) => {
      for (const node of nodes) {
        const session = sessionOf(node.item);
        const id = session.id;
        const collapsed = virtualization.collapsedSessionIds?.has(id) ?? false;
        virtualRows.push({
          kind: "session",
          id,
          session: node.item,
          depth,
          hasChildren: node.children.length > 0,
          collapsed,
          height: virtualization.rowHeights?.[id] ?? SESSION_ROW_HEIGHT,
        });
        if (node.children.length > 0 && !collapsed) appendTreeRows(node.children, depth + 1);
      }
    };
    for (const group of orderedGroups) {
      const groupItems = items.filter(item => group.items.some(session => session === sessionOf(item) || (!deviceOf && session.id === sessionOf(item).id)));
      if (group.kind === "project") {
        appendTreeRows(virtualization.buildTree(groupItems), 0);
        continue;
      }
      const groupHasFocus = group.items.some(session => {
        const item = groupItems.find(candidate => sessionOf(candidate).id === session.id);
        if (!item) return false;
        return focusSessionKey
          ? `${deviceOf?.(item) ?? "local"}:${session.id}` === focusSessionKey
          : session.id === focusSessionId;
      });
      const closed = collapsed[group.key] !== undefined ? collapsed[group.key] : (group.kind === "worktree" && !groupHasFocus);
      virtualRows.push({
        kind: "bucket",
        id: `bucket:${group.key}`,
        bucket: { id: group.key, label: group.label, items: groupItems, value: group },
        collapsed: closed,
        height: virtualization.rowHeights?.[`bucket:${group.key}`] ?? SUBPROJECT_ROW_HEIGHT,
      });
      if (!closed) appendTreeRows(virtualization.buildTree(groupItems), 0);
    }
    const localTop = Math.max(0, virtualization.scrollTop - virtualization.originOffset);
    const localViewport = Math.max(0, virtualization.viewportHeight - Math.max(0, virtualization.originOffset - virtualization.scrollTop));
    const window = getVirtualRowWindow(virtualRows, localTop, localViewport, virtualization.overscanRows ?? 4, virtualization.pinnedIds);

    const renderBucketHeader = (group: WorktreeSessionGroup, groupItems: T[], closed: boolean): ReactNode => {
      const label = displayLabel(group);
      const isEditing = renamingKey === group.key;
      const isConfirmingDelete = deletingKey === group.key;
      const actions = groupActions(group);
      const toggle = (
        <button className="activity-subproject-toggle" type="button" onClick={() => setCollapsed((current) => ({ ...current, [group.key]: !closed }))} aria-expanded={!closed} title={group.path || undefined} aria-label={closed ? t("worktreeBuckets.expand", { label }) : t("worktreeBuckets.collapse", { label })}>
          <span style={{ display: "inline-flex", flexShrink: 0, color: closed ? "#dc2626" : undefined, transform: closed ? "none" : "rotate(90deg)", transition: "transform 0.12s" }}><ChevronRight size={11} strokeWidth={1.9} aria-hidden="true" /></span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        </button>
      );
      const title = isEditing ? (
        <>
          <button className="activity-subproject-toggle activity-subproject-toggle-editing" type="button" onClick={() => setCollapsed((current) => ({ ...current, [group.key]: !closed }))} aria-expanded={!closed}>
            <span style={{ display: "inline-flex", flexShrink: 0, color: closed ? "#dc2626" : undefined, transform: closed ? "none" : "rotate(90deg)", transition: "transform 0.12s" }}><ChevronRight size={11} strokeWidth={1.9} aria-hidden="true" /></span>
          </button>
          <div className="activity-subproject-rename activity-subproject-rename-inline" role="group" aria-label={t("worktreeBuckets.renameBranchFor", { label: group.label })} onClick={(e) => e.stopPropagation()}>
            <input autoFocus value={renameValue} disabled={mutationBusy} onChange={(e) => setRenameValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void handleRename(group); if (e.key === "Escape") setRenamingKey(null); }} aria-label={t("worktreeBuckets.renameBranch")} />
            <button type="button" disabled={mutationBusy || !renameValue.trim()} onClick={() => void handleRename(group)} title={t("chat.confirm")} aria-label={t("chat.confirm")}><Check size={13} aria-hidden="true" /></button>
            <button type="button" disabled={mutationBusy} onClick={() => setRenamingKey(null)} title={t("i18n.cancel")} aria-label={t("i18n.cancel")}><X size={13} aria-hidden="true" /></button>
          </div>
        </>
      ) : toggle;
      return (
        <>
          <div className="activity-subproject-header activity-subproject-header-sidebar">
            <WorktreeContextMenu group={group} onRenameRequest={actions.rename} onDeleteRequest={actions.remove} onNewSessionRequest={actions.newSession} onOpenChange={(open) => virtualization.onInteractionChange?.(`bucket:${group.key}`, open)}>
              {title}
            </WorktreeContextMenu>
            <span style={{ flexShrink: 0, color: "inherit", fontSize: 10, fontWeight: 500 }}>({groupItems.length})</span>
            {actions.newSession && <button className="activity-project-action" type="button" onClick={(e) => { e.stopPropagation(); actions.newSession!(); }} title={t("worktreeBuckets.newSessionIn", { label })} aria-label={t("worktreeBuckets.newSessionIn", { label })}><MessageSquarePlus size={14} strokeWidth={1.8} aria-hidden="true" /></button>}
          </div>
          {mutationError && isEditing && <div role="alert" style={{ padding: "2px 10px 4px", color: "#dc2626", fontSize: 10 }}>{mutationError}</div>}
          {isConfirmingDelete && renderDeleteConfirm(group)}
          {mutationError && isConfirmingDelete && <div role="alert" style={{ padding: "2px 10px 4px", color: "#dc2626", fontSize: 10 }}>{mutationError}</div>}
        </>
      );
    };

    return (
      <div data-virtual-worktree-window="true" style={{ position: "relative", height: window.totalHeight }}>
        {window.indices.map((index) => {
          const row = virtualRows[index];
          return (
            <MeasuredWorktreeVirtualRow key={row.id} rowId={row.id} top={window.offsets[index]} height={row.height} onMeasure={virtualization.onRowMeasure}>
              {row.kind === "project"
                ? <div style={{ padding: "4px 10px", color: "#60a5fa", overflowWrap: "anywhere", fontSize: 11 }}>{row.path}</div>
                : row.kind === "bucket"
                  ? renderBucketHeader(row.bucket.value, row.bucket.items, row.collapsed)
                  : virtualization.renderSession(row.session, row.depth, row.hasChildren, row.collapsed)}
            </MeasuredWorktreeVirtualRow>
          );
        })}
      </div>
    );
  }

  return orderedGroups.map((group) => {
    const groupItems = items.filter(item => group.items.some(session => session === sessionOf(item) || (!deviceOf && session.id === sessionOf(item).id)));
    if (group.kind === "project") {
      return <div key={group.key}>{renderItems(groupItems)}</div>;
    }
    const groupHasFocus = group.items.some(session => {
      const item = groupItems.find(candidate => sessionOf(candidate).id === session.id);
      if (!item) return false;
      return focusSessionKey
        ? `${deviceOf?.(item) ?? "local"}:${session.id}` === focusSessionKey
        : session.id === focusSessionId;
    });
    const closed = collapsed[group.key] !== undefined ? collapsed[group.key] : (group.kind === "worktree" && !groupHasFocus);
    const label = displayLabel(group);

    const isEditing = renamingKey === group.key;
    const isConfirmingDelete = deletingKey === group.key;
    const actions = groupActions(group);

    const toggle = (
      <button
        className="activity-subproject-toggle"
        type="button"
        onClick={() => setCollapsed((current) => ({ ...current, [group.key]: !closed }))}
        aria-expanded={!closed}
        title={group.path || undefined}
        aria-label={closed ? t("worktreeBuckets.expand", { label }) : t("worktreeBuckets.collapse", { label })}
      >
        <span style={{ display: "inline-flex", flexShrink: 0, color: closed ? "#dc2626" : undefined, transform: closed ? "none" : "rotate(90deg)", transition: "transform 0.12s" }}>
          <ChevronRight size={11} strokeWidth={1.9} aria-hidden="true" />
        </span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {label}
        </span>
      </button>
    );

    const title = isEditing ? (
      <>
        <button className="activity-subproject-toggle activity-subproject-toggle-editing" type="button" onClick={() => setCollapsed((current) => ({ ...current, [group.key]: !closed }))} aria-expanded={!closed}>
          <span style={{ display: "inline-flex", flexShrink: 0, color: closed ? "#dc2626" : undefined, transform: closed ? "none" : "rotate(90deg)", transition: "transform 0.12s" }}><ChevronRight size={11} strokeWidth={1.9} aria-hidden="true" /></span>
        </button>
        <div className="activity-subproject-rename activity-subproject-rename-inline" role="group" aria-label={t("worktreeBuckets.renameBranchFor", { label: group.label })} onClick={(e) => e.stopPropagation()}>
          <input
            autoFocus
            value={renameValue}
            disabled={mutationBusy}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleRename(group);
              if (e.key === "Escape") setRenamingKey(null);
            }}
            aria-label={t("worktreeBuckets.renameBranch")}
          />
          <button type="button" disabled={mutationBusy || !renameValue.trim()} onClick={() => void handleRename(group)} title={t("chat.confirm")} aria-label={t("chat.confirm")}><Check size={13} aria-hidden="true" /></button>
          <button type="button" disabled={mutationBusy} onClick={() => setRenamingKey(null)} title={t("i18n.cancel")} aria-label={t("i18n.cancel")}><X size={13} aria-hidden="true" /></button>
        </div>
      </>
    ) : toggle;

    return (
      <section key={group.key} data-worktree-group={group.kind}>
        <div className="activity-subproject-header activity-subproject-header-sidebar">
          <WorktreeContextMenu
            group={group}
            onRenameRequest={actions.rename}
            onDeleteRequest={actions.remove}
            onNewSessionRequest={actions.newSession}
          >
            {title}
          </WorktreeContextMenu>
          <span style={{ flexShrink: 0, color: "inherit", fontSize: 10, fontWeight: 500 }}>({group.items.length})</span>
          {actions.newSession && (
            <button
              className="activity-project-action"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                actions.newSession!();
              }}
              title={t("worktreeBuckets.newSessionIn", { label })}
              aria-label={t("worktreeBuckets.newSessionIn", { label })}
            >
              <MessageSquarePlus size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
        </div>
        {mutationError && isEditing && <div role="alert" style={{ padding: "2px 10px 4px", color: "#dc2626", fontSize: 10 }}>{mutationError}</div>}
        {isConfirmingDelete && renderDeleteConfirm(group)}
        {mutationError && isConfirmingDelete && <div role="alert" style={{ padding: "2px 10px 4px", color: "#dc2626", fontSize: 10 }}>{mutationError}</div>}
        {!closed && renderItems(groupItems)}
      </section>
    );
  });
}
