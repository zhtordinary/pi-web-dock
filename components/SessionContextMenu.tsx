"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  FolderGit2,
  MessageSquare,
  Pencil,
  Star,
  Trash2,
} from "lucide-react";
import { clampFloatingMenuPosition } from "@/lib/floating-menu-position";
import type { SessionActivityItem, SessionActivityResponse } from "@/lib/session-activity-types";
import type { SessionStorageCategory } from "@/lib/session-category-state";
import { projectKeysMatch } from "@/lib/subproject-groups";

export interface SessionContextMenuProps {
  item: SessionActivityItem;
  canMutateAny: boolean;
  busy: boolean;
  mutateTitle: string | null;
  position: { x: number; y: number } | null;
  onClose: () => void;
  // Subprojects
  subprojects?: NonNullable<SessionActivityResponse["subprojects"]>;
  onMoveToSubproject?: (item: SessionActivityItem, subprojectId: string | null) => Promise<boolean>;
  // Subagents
  hasSubagents?: boolean;
  subagentsVisible?: boolean;
  onToggleSubagents?: () => void;
  // Favorite
  onFavorite?: () => Promise<boolean> | void;
  onUnfavorite?: () => Promise<boolean> | void;
  // Categories
  onSetCategory?: (sessionId: string, category: SessionStorageCategory | null, deviceId?: string) => Promise<boolean> | void;
  // Hide / Unhide
  onHide?: () => void;
  onUnhide?: () => void;
  // Rename
  onRename: () => void;
  // Archive & Delete
  onArchive?: () => void;
  archiveDisabled?: boolean;
  archiveTitle?: string;
  onDelete?: () => void;
  deleteDisabled?: boolean;
  deleteTitle?: string;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const contextMenuStyle: React.CSSProperties = {
  position: "fixed",
  zIndex: 1300,
  display: "grid",
  width: "max-content",
  minWidth: 170,
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

const contextMenuItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
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
  boxSizing: "border-box",
};

const separatorStyle: React.CSSProperties = {
  height: 1,
  alignSelf: "stretch",
  margin: "3px 4px",
  background: "var(--border)",
};

export function SessionContextMenu({
  item,
  canMutateAny,
  busy,
  mutateTitle,
  position,
  onClose,
  subprojects = [],
  onMoveToSubproject,
  hasSubagents = false,
  subagentsVisible = false,
  onToggleSubagents,
  onFavorite,
  onUnfavorite,
  onSetCategory,
  onHide,
  onUnhide,
  onRename,
  onArchive,
  archiveDisabled = false,
  archiveTitle,
  onDelete,
  deleteDisabled = false,
  deleteTitle,
  t,
}: SessionContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const subprojectItemRef = useRef<HTMLButtonElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);

  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [submenuPosition, setSubmenuPosition] = useState<{ left: number; top: number } | null>(null);
  const [subprojectMoving, setSubprojectMoving] = useState(false);

  const availableSubprojects = subprojects.filter(
    (sp) => sp.deviceId === item.device.id && projectKeysMatch(sp.projectKey, item.projectKey)
  );

  const reposition = useCallback(() => {
    if (!position || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const next = clampFloatingMenuPosition(
      position,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight }
    );
    setMenuPosition((cur) => (cur?.left === next.left && cur.top === next.top ? cur : next));
  }, [position]);

  const repositionSubmenu = useCallback(() => {
    if (!submenuOpen || !subprojectItemRef.current) return;
    const rect = subprojectItemRef.current.getBoundingClientRect();
    const subRect = submenuRef.current?.getBoundingClientRect();
    const width = subRect?.width || 180;
    const height = subRect?.height || 140;
    const right = rect.right + 4;
    const left = right + width <= window.innerWidth - 8 ? right : Math.max(8, rect.left - width - 4);
    const top = Math.min(Math.max(8, rect.top), Math.max(8, window.innerHeight - height - 8));
    setSubmenuPosition({ left, top });
  }, [submenuOpen]);

  useLayoutEffect(() => {
    if (!position) {
      setMenuPosition(null);
      setSubmenuOpen(false);
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

  useLayoutEffect(() => {
    if (!submenuOpen) {
      setSubmenuPosition(null);
      return;
    }
    const frame = window.requestAnimationFrame(repositionSubmenu);
    window.addEventListener("resize", repositionSubmenu);
    window.addEventListener("scroll", repositionSubmenu, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", repositionSubmenu);
      window.removeEventListener("scroll", repositionSubmenu, true);
    };
  }, [submenuOpen, repositionSubmenu]);

  useEffect(() => {
    if (!position) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (menuRef.current?.contains(target) || submenuRef.current?.contains(target))
      ) {
        return;
      }
      onClose();
    };
    const closeOnContextMenu = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (menuRef.current?.contains(target) || submenuRef.current?.contains(target))
      ) {
        return;
      }
      onClose();
    };
    const closeOnFocusIn = (event: FocusEvent) => {
      if (event.target instanceof HTMLIFrameElement) onClose();
    };
    const closeOnWindowBlur = () => {
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (submenuOpen) {
          setSubmenuOpen(false);
          subprojectItemRef.current?.focus();
        } else {
          onClose();
        }
      }
    };
    document.addEventListener("pointerdown", closeOnPointerDown, true);
    document.addEventListener("contextmenu", closeOnContextMenu, true);
    document.addEventListener("focusin", closeOnFocusIn);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", closeOnWindowBlur);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown, true);
      document.removeEventListener("contextmenu", closeOnContextMenu, true);
      document.removeEventListener("focusin", closeOnFocusIn);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", closeOnWindowBlur);
    };
  }, [onClose, position, submenuOpen]);

  const handleSubprojectChoose = async (subprojectId: string | null) => {
    if (subprojectMoving || !onMoveToSubproject) return;
    if (subprojectId === (item.session.subprojectId ?? null)) {
      onClose();
      return;
    }
    setSubprojectMoving(true);
    try {
      await onMoveToSubproject(item, subprojectId);
      onClose();
    } finally {
      setSubprojectMoving(false);
    }
  };

  const handleCategoryToggle = async (targetCategory: SessionStorageCategory) => {
    if (!onSetCategory) return;
    const nextCategory = item.category === targetCategory ? null : targetCategory;
    onClose();
    await onSetCategory(item.session.id, nextCategory, item.device.id);
  };

  if (!position || typeof document === "undefined") return null;

  const menuPositionStyle: React.CSSProperties = {
    left: menuPosition?.left ?? -10_000,
    top: menuPosition?.top ?? -10_000,
    visibility: menuPosition ? "visible" : "hidden",
  };

  const submenuPositionStyle: React.CSSProperties = {
    left: submenuPosition?.left ?? -10_000,
    top: submenuPosition?.top ?? -10_000,
    visibility: submenuPosition ? "visible" : "hidden",
  };

  return createPortal(
    <>
      <div
        ref={menuRef}
        role="menu"
        tabIndex={-1}
        aria-label={item.session.name || item.session.id}
        onContextMenu={(event) => event.preventDefault()}
        style={{ ...contextMenuStyle, ...menuPositionStyle }}
      >
        {/* 1. 转移到子项目（首项，按项目分组的子项目需要） */}
        <button
          ref={subprojectItemRef}
          className="reader-context-menu-item"
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={submenuOpen}
          disabled={!onMoveToSubproject || item.device.online === false || busy || item.session.transient}
          onClick={() => setSubmenuOpen((open) => !open)}
          onMouseEnter={() => {
            if (availableSubprojects.length > 0) setSubmenuOpen(true);
          }}
          style={{
            ...contextMenuItemStyle,
            opacity: !onMoveToSubproject || item.device.online === false || busy ? 0.5 : 1,
            justifyContent: "space-between",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <FolderGit2 size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>{t("sessionActivity.moveToSubproject")}</span>
          </span>
          <ChevronRight size={14} strokeWidth={1.8} style={{ opacity: 0.6, flexShrink: 0 }} aria-hidden="true" />
        </button>

        <div role="separator" aria-orientation="horizontal" style={separatorStyle} />

        {/* 2. 收藏 / 取消收藏 */}
        {(onFavorite || onUnfavorite) && (
          <button
            className="reader-context-menu-item"
            type="button"
            role="menuitem"
            disabled={!canMutateAny || busy}
            onClick={() => {
              onClose();
              void (item.favorite ? onUnfavorite : onFavorite)?.();
            }}
            style={{ ...contextMenuItemStyle, justifyContent: "space-between" }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <Star
                size={14}
                strokeWidth={1.8}
                fill={item.favorite ? "var(--accent)" : "none"}
                color={item.favorite ? "var(--accent)" : "currentColor"}
                aria-hidden="true"
              />
              <span>{item.favorite ? t("sessionActivity.unfavoriteSession") : t("sessionActivity.favoriteSession")}</span>
            </span>
            {item.favorite && <Check size={14} strokeWidth={2} style={{ color: "var(--accent)", flexShrink: 0 }} aria-hidden="true" />}
          </button>
        )}

        {/* 3. 待讨论 */}
        {onSetCategory && (
          <button
            className="reader-context-menu-item"
            type="button"
            role="menuitem"
            disabled={!canMutateAny || busy}
            onClick={() => void handleCategoryToggle("to_discuss")}
            style={{ ...contextMenuItemStyle, justifyContent: "space-between" }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <MessageSquare
                size={14}
                strokeWidth={1.8}
                color={item.category === "to_discuss" ? "#3b82f6" : "currentColor"}
                aria-hidden="true"
              />
              <span>{t("sessionActivity.toDiscuss")}</span>
            </span>
            {item.category === "to_discuss" && (
              <Check size={14} strokeWidth={2} style={{ color: "#3b82f6", flexShrink: 0 }} aria-hidden="true" />
            )}
          </button>
        )}

        {/* 4. 待修改 */}
        {onSetCategory && (
          <button
            className="reader-context-menu-item"
            type="button"
            role="menuitem"
            disabled={!canMutateAny || busy}
            onClick={() => void handleCategoryToggle("to_revise")}
            style={{ ...contextMenuItemStyle, justifyContent: "space-between" }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <Pencil
                size={14}
                strokeWidth={1.8}
                color={item.category === "to_revise" ? "#f59e0b" : "currentColor"}
                aria-hidden="true"
              />
              <span>{t("sessionActivity.toRevise")}</span>
            </span>
            {item.category === "to_revise" && (
              <Check size={14} strokeWidth={2} style={{ color: "#f59e0b", flexShrink: 0 }} aria-hidden="true" />
            )}
          </button>
        )}

        {/* 5. 已完成 */}
        {onSetCategory && (
          <button
            className="reader-context-menu-item"
            type="button"
            role="menuitem"
            disabled={!canMutateAny || busy}
            onClick={() => void handleCategoryToggle("completed")}
            style={{ ...contextMenuItemStyle, justifyContent: "space-between" }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <Check
                size={14}
                strokeWidth={2}
                color={item.category === "completed" ? "#10b981" : "currentColor"}
                aria-hidden="true"
              />
              <span>{t("sessionActivity.completed")}</span>
            </span>
            {item.category === "completed" && (
              <Check size={14} strokeWidth={2} style={{ color: "#10b981", flexShrink: 0 }} aria-hidden="true" />
            )}
          </button>
        )}

        <div role="separator" aria-orientation="horizontal" style={separatorStyle} />

        {/* 6. 子 Agent 与隐藏 */}
        {hasSubagents && onToggleSubagents && (
          <button
            className="reader-context-menu-item"
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              onToggleSubagents();
            }}
            style={contextMenuItemStyle}
          >
            {subagentsVisible ? <EyeOff size={14} strokeWidth={1.8} aria-hidden="true" /> : <Eye size={14} strokeWidth={1.8} aria-hidden="true" />}
            <span>{subagentsVisible ? t("sidebar.hideSubagents") : t("sidebar.showSubagents")}</span>
          </button>
        )}
        {onUnhide ? (
          <button
            className="reader-context-menu-item"
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => {
              onClose();
              void onUnhide();
            }}
            style={{ ...contextMenuItemStyle, color: "var(--text-dim)" }}
          >
            <EyeOff size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>{t("sessionActivity.unhideSession")}</span>
          </button>
        ) : onHide ? (
          <button
            className="reader-context-menu-item"
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => {
              onClose();
              void onHide();
            }}
            style={{ ...contextMenuItemStyle, color: "var(--accent)" }}
          >
            <Eye size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>{t("sessionActivity.hideSession")}</span>
          </button>
        ) : null}

        <div role="separator" aria-orientation="horizontal" style={separatorStyle} />

        {/* 7. 重命名 */}
        <button
          className="reader-context-menu-item"
          type="button"
          role="menuitem"
          disabled={!canMutateAny || busy}
          onClick={() => {
            onClose();
            onRename();
          }}
          style={contextMenuItemStyle}
        >
          <Pencil size={14} strokeWidth={1.8} aria-hidden="true" />
          <span>{mutateTitle ?? t("sessionActivity.rename")}</span>
        </button>

        {/* 8. 归档 / 恢复 */}
        {onArchive && (
          <button
            className="reader-context-menu-item"
            type="button"
            role="menuitem"
            disabled={archiveDisabled || !canMutateAny || busy}
            onClick={() => {
              onClose();
              onArchive();
            }}
            style={{
              ...contextMenuItemStyle,
              opacity: archiveDisabled || !canMutateAny || busy ? 0.5 : 1,
            }}
          >
            <Archive size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>{archiveTitle ?? (item.session.archived ? t("sessionActivity.restore") : t("sessionActivity.archive"))}</span>
          </button>
        )}

        {/* 9. 删除 */}
        {onDelete && (
          <button
            className="reader-context-menu-item"
            data-danger="true"
            type="button"
            role="menuitem"
            disabled={deleteDisabled || !canMutateAny || busy}
            onClick={() => {
              onClose();
              onDelete();
            }}
            style={{
              ...contextMenuItemStyle,
              color: "#dc2626",
              opacity: deleteDisabled || !canMutateAny || busy ? 0.5 : 1,
            }}
          >
            <Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>{deleteTitle ?? t("sessionActivity.delete")}</span>
          </button>
        )}
      </div>

      {/* 转移到子项目 子菜单 */}
      {submenuOpen && (
        <div
          ref={submenuRef}
          role="menu"
          tabIndex={-1}
          aria-label={t("sessionActivity.moveToSubproject")}
          onContextMenu={(event) => event.preventDefault()}
          style={{ ...contextMenuStyle, ...submenuPositionStyle }}
        >
          {/* 未分类 */}
          <button
            className="reader-context-menu-item"
            type="button"
            role="menuitem"
            disabled={subprojectMoving}
            onClick={() => void handleSubprojectChoose(null)}
            style={{ ...contextMenuItemStyle, justifyContent: "space-between" }}
          >
            <span>{t("sessionActivity.unclassified")}</span>
            {!item.session.subprojectId && (
              <Check size={14} strokeWidth={2} style={{ color: "var(--accent)", flexShrink: 0 }} aria-hidden="true" />
            )}
          </button>

          {availableSubprojects.length > 0 && (
            <div role="separator" aria-orientation="horizontal" style={separatorStyle} />
          )}

          {availableSubprojects.map((subproject) => (
            <button
              key={subproject.id}
              className="reader-context-menu-item"
              type="button"
              role="menuitem"
              disabled={subprojectMoving}
              onClick={() => void handleSubprojectChoose(subproject.id)}
              style={{ ...contextMenuItemStyle, justifyContent: "space-between" }}
            >
              <span>{subproject.label}</span>
              {item.session.subprojectId === subproject.id && (
                <Check size={14} strokeWidth={2} style={{ color: "var(--accent)", flexShrink: 0 }} aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
      )}
    </>,
    document.body
  );
}
