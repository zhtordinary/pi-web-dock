"use client";

import { useEffect, useRef } from "react";
import type { NoticeItem } from "@/hooks/useAgentSession";

export function NoticeShelf({
  notices,
  floating = false,
  align = "left",
  onHoverChange,
  onDismissOutside,
}: {
  notices: NoticeItem[];
  floating?: boolean;
  align?: "left" | "right";
  onHoverChange?: (hovered: boolean) => void;
  onDismissOutside?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!onDismissOutside || notices.length === 0) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current && rootRef.current.contains(target)) return;
      onDismissOutside();
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [notices.length, onDismissOutside]);

  if (notices.length === 0) return null;
  return (
    <div
      ref={rootRef}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: align === "right" ? "flex-end" : "stretch",
        marginBottom: floating ? 0 : 10,
        // Floating shelf sits inside a pointer-events:none overlay; re-enable
        // pointer events (and shrink to fit) so the notice content can be
        // selected/copied and hover can pause the expiry timer.
        width: floating ? "fit-content" : undefined,
        pointerEvents: floating ? "auto" : undefined,
        userSelect: "text",
      }}
      onMouseEnter={onHoverChange ? () => onHoverChange(true) : undefined}
      onMouseLeave={onHoverChange ? () => onHoverChange(false) : undefined}
    >
      {notices.map((notice, index) => {
        const color = notice.type === "error"
          ? "#ef4444"
          : notice.type === "warning"
            ? "#d97706"
            : notice.type === "success"
              ? "#10b981"
              : "var(--accent)";
        const multiline = notice.message.includes("\n");
        return (
          <div
            key={notice.id}
            className="notice-shelf-item"
            style={{
              display: "flex",
              alignItems: multiline ? "flex-start" : "center",
              gap: 10,
              minHeight: 0,
              marginBottom: index === notices.length - 1 ? 0 : 6,
              overflow: "hidden",
              borderRadius: 14,
              border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              width: "fit-content",
              maxWidth: "min(100%, 620px)",
              boxShadow: floating
                ? "0 1px 2px rgba(15,23,42,0.05), 0 10px 28px -14px rgba(15,23,42,0.24)"
                : "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              fontSize: 12,
              lineHeight: 1.45,
              transformOrigin: "top center",
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out both",
              padding: multiline ? "10px 12px" : "0.25em 12px",
              userSelect: "text",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
                alignSelf: multiline ? "flex-start" : undefined,
                marginTop: multiline ? 4 : undefined,
              }}
            />
            <span
              style={{
                display: multiline ? "block" : undefined,
                padding: 0,
                minWidth: 0,
                maxWidth: "100%",
                maxHeight: multiline ? 360 : undefined,
                overflowX: "hidden",
                overflowY: multiline ? "auto" : "hidden",
                overflowWrap: "anywhere",
                textOverflow: multiline ? undefined : "ellipsis",
                whiteSpace: multiline ? "pre-wrap" : "nowrap",
                userSelect: "text",
              }}
            >
              {notice.message}
            </span>
          </div>
        );
      })}
    </div>
  );
}
