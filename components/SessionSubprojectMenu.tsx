"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SubprojectDefinition } from "@/lib/subproject-state";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  subprojects: readonly SubprojectDefinition[];
  currentSubprojectId?: string;
  disabled?: boolean;
  onMove: (subprojectId: string | null) => Promise<boolean>;
  onMoved?: () => void;
  compact?: boolean;
  ownerId?: string;
}

interface MenuPosition {
  left: number;
  top: number;
}

const MENU_WIDTH = 190;
const VIEWPORT_GUTTER = 8;

function menuPositionFor(trigger: HTMLElement, menu: HTMLElement | null): MenuPosition {
  const rect = trigger.getBoundingClientRect();
  const menuRect = menu?.getBoundingClientRect();
  const width = menuRect?.width || MENU_WIDTH;
  const height = menuRect?.height || 180;
  const maxLeft = Math.max(VIEWPORT_GUTTER, window.innerWidth - width - VIEWPORT_GUTTER);
  const left = Math.min(Math.max(VIEWPORT_GUTTER, rect.right - width), maxLeft);
  const below = rect.bottom + 4;
  const top = below + height <= window.innerHeight - VIEWPORT_GUTTER || rect.top - height - 4 < VIEWPORT_GUTTER
    ? below
    : rect.top - height - 4;
  return { left, top: Math.max(VIEWPORT_GUTTER, top) };
}

export function SessionSubprojectMenu({ subprojects, currentSubprojectId, disabled = false, onMove, onMoved, compact = false, ownerId }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    setPosition(menuPositionFor(trigger, menuRef.current));
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
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target))) setOpen(false);
    };
    const closeOnContextMenu = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target))) setOpen(false);
    };
    const closeOnFocusIn = (event: FocusEvent) => {
      if (event.target instanceof HTMLIFrameElement) setOpen(false);
    };
    const closeOnWindowBlur = () => {
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
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
  }, [open]);

  if (subprojects.length === 0) return null;
  const triggerSize = compact ? 24 : 32;

  const choose = async (subprojectId: string | null) => {
    if (busy || disabled || subprojectId === (currentSubprojectId ?? null)) return;
    setBusy(true);
    setError(false);
    try {
      if (await onMove(subprojectId)) {
        setOpen(false);
        onMoved?.();
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const menu = open && !disabled && typeof document !== "undefined"
    ? createPortal(
      <div
        ref={menuRef}
        data-session-row-extra-actions={ownerId}
        role="menu"
        aria-label={t("sessionActivity.moveToSubproject")}
        onClick={(event) => event.stopPropagation()}
        style={{
          position: "fixed",
          left: position?.left ?? -MENU_WIDTH,
          top: position?.top ?? -200,
          zIndex: 1000,
          width: MENU_WIDTH,
          maxWidth: "calc(100vw - 16px)",
          maxHeight: "calc(100vh - 16px)",
          overflowY: "auto",
          boxSizing: "border-box",
          padding: 4,
          border: "1px solid var(--border)",
          borderRadius: 7,
          background: "var(--bg-panel)",
          color: "var(--text)",
          boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
          visibility: position ? "visible" : "hidden",
        }}
      >
        <button type="button" role="menuitem" disabled={busy || !currentSubprojectId} onClick={() => void choose(null)} style={menuItemStyle}>
          {t("sessionActivity.unclassified")}
        </button>
        {subprojects.map((subproject) => (
          <button key={subproject.id} type="button" role="menuitem" disabled={busy || subproject.id === currentSubprojectId} onClick={() => void choose(subproject.id)} style={menuItemStyle}>
            {subproject.label}
          </button>
        ))}
        {error && <div role="alert" style={{ padding: "5px 7px", color: "#dc2626", fontSize: 10 }}>{t("sessionActivity.moveFailed")}</div>}
      </div>,
      document.body,
    )
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        title={disabled ? t("sessionActivity.moveUnavailable") : t("sessionActivity.moveToSubproject")}
        aria-label={disabled ? t("sessionActivity.moveUnavailable") : t("sessionActivity.moveToSubproject")}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || busy}
        onClick={(event) => {
          event.stopPropagation();
          setError(false);
          setOpen((value) => !value);
        }}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", width: triggerSize, height: triggerSize,
          padding: 0, background: "var(--bg-hover)", border: "1px solid var(--border)",
          borderRadius: compact ? 6 : 7, color: "var(--text-muted)", cursor: disabled || busy ? "not-allowed" : "pointer",
          opacity: disabled || busy ? 0.45 : 1, flexShrink: 0,
        }}
      >
        <span aria-hidden="true">⇄</span>
      </button>
      {menu}
    </>
  );
}

const menuItemStyle: React.CSSProperties = {
  display: "block", width: "100%", minHeight: 30, padding: "6px 8px", border: 0, borderRadius: 5,
  background: "var(--bg-panel)", color: "var(--text)", textAlign: "left", cursor: "pointer", fontSize: 11,
};
