"use client";

import { Eye, EyeOff } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { clampFloatingMenuPosition } from "@/lib/floating-menu-position";

interface Props {
  position: { x: number; y: number } | null;
  visible: boolean;
  onToggle: () => void;
  onClose: () => void;
  label: string;
}

const menuStyle: React.CSSProperties = {
  position: "fixed",
  zIndex: 1300,
  minWidth: 170,
  padding: 4,
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--bg-panel)",
  boxShadow: "0 10px 28px rgba(15,23,42,0.16)",
};

const itemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
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
  whiteSpace: "nowrap",
};

export function SubagentVisibilityMenu({ position, visible, onToggle, onClose, label }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!position || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    setMenuPosition(clampFloatingMenuPosition(
      position,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    ));
  }, [position]);

  useEffect(() => {
    if (!position) return;
    const close = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      onClose();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("contextmenu", close, true);
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("contextmenu", close, true);
      document.removeEventListener("keydown", keydown);
    };
  }, [onClose, position]);

  if (!position || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      onContextMenu={(event) => event.preventDefault()}
      style={{
        ...menuStyle,
        left: menuPosition?.left ?? -10_000,
        top: menuPosition?.top ?? -10_000,
        visibility: menuPosition ? "visible" : "hidden",
      }}
    >
      <button
        type="button"
        role="menuitem"
        className="reader-context-menu-item"
        onClick={() => { onToggle(); onClose(); }}
        style={itemStyle}
      >
        {visible ? <EyeOff size={14} strokeWidth={1.8} aria-hidden="true" /> : <Eye size={14} strokeWidth={1.8} aria-hidden="true" />}
        <span>{label}</span>
      </button>
    </div>,
    document.body,
  );
}
