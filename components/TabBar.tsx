"use client";

import { useEffect, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import { getFileIcon } from "./FileIcons";
import { useI18n } from "@/hooks/useI18n";
import type { FileViewerDisplayMode, FileViewerState } from "@/lib/file-viewer-state";

export interface Tab {
  id: string;
  label: string;
  filePath: string;
  remotePeer?: string;
  cwd?: string;
  projectRoot?: string;
  kind?: "file" | "terminal" | "sidekick";
  closing?: boolean;
  sourceSessionId?: string | null;
  initialDisplayMode?: FileViewerDisplayMode;
  page?: number;
  anchor?: string;
  viewerState?: FileViewerState;
  viewerRevision?: number;
  dirty?: boolean;
}

interface Props {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onReorderTab?: (source: string, target: string, after: boolean) => void;
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, onReorderTab }: Props) {
  const { t } = useI18n();
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const draggedId = useRef<string | null>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX) || list.scrollWidth <= list.clientWidth) return;
      event.preventDefault();
      list.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? list.clientWidth : 1);
    };
    list.addEventListener("wheel", onWheel, { passive: false });
    return () => list.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const list = listRef.current;
    const tab = list?.querySelector<HTMLElement>('[data-active="true"]');
    if (!list || !tab) return;
    const strip = list.getBoundingClientRect();
    const bounds = tab.getBoundingClientRect();
    if (bounds.left < strip.left) list.scrollLeft -= strip.left - bounds.left;
    else if (bounds.right > strip.right) list.scrollLeft += bounds.right - strip.right;
  }, [activeTabId, tabs.length]);

  return (
    <div
      ref={listRef}
      role="tablist"
      tabIndex={0}
      className="tabbar-scroll"
      style={{
        display: "flex",
        alignItems: "stretch",
        background: "var(--bg-panel)",
        overflowX: "auto",
        overflowY: "hidden",
        flexShrink: 0,
        height: 36,
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            data-active={isActive ? "true" : undefined}
            draggable={Boolean(onReorderTab && !tab.closing)}
            onDragStart={(event) => {
              if (!onReorderTab || tab.closing) return;
              draggedId.current = tab.id;
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", tab.id);
            }}
            onDragOver={(event) => {
              if (!draggedId.current || draggedId.current === tab.id || tab.closing) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              const rect = event.currentTarget.getBoundingClientRect();
              const after = event.clientX >= rect.left + rect.width / 2;
              setDropTarget((prev) => prev?.id === tab.id && prev.after === after ? prev : { id: tab.id, after });
            }}
            onDrop={(event) => {
              if (!draggedId.current || draggedId.current === tab.id || tab.closing) return;
              event.preventDefault();
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              onReorderTab?.(draggedId.current, tab.id, event.clientX >= rect.left + rect.width / 2);
              draggedId.current = null;
              setDropTarget(null);
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setDropTarget((prev) => prev?.id === tab.id ? null : prev);
            }}
            onDragEnd={() => {
              draggedId.current = null;
              setDropTarget(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectTab(tab.id);
                return;
              }
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const index = tabs.findIndex((item) => item.id === tab.id);
              const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
                : Math.max(0, Math.min(tabs.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)));
              onSelectTab(tabs[next].id);
              (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
            }}
            onClick={() => onSelectTab(tab.id)}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault();
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              e.stopPropagation();
              onCloseTab(tab.id);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              paddingLeft: 12,
              paddingRight: 6,
              borderRight: "1px solid var(--border)",
              background: isActive ? "var(--bg)" : "var(--bg-panel)",
              cursor: "pointer",
              fontSize: 12,
              color: isActive ? "var(--text)" : "var(--text-muted)",
              whiteSpace: "nowrap",
              maxWidth: 180,
              minWidth: 80,
              flexShrink: 0,
              userSelect: "none",
              transition: "background 0.1s, color 0.1s",
              boxShadow: dropTarget?.id === tab.id ? `inset ${dropTarget.after ? "-2px" : "2px"} 0 var(--accent)` : undefined,
            }}
          >
            <span style={{ flexShrink: 0, opacity: isActive ? 1 : 0.7, display: "flex", alignItems: "center" }}>
              {tab.kind === "sidekick" ? (
                <MessageSquare size={13} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                getFileIcon(tab.label, 13)
              )}
            </span>
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                flex: 1,
                fontWeight: isActive ? 500 : 400,
              }}
              title={tab.filePath}
            >
              {tab.label}
            </span>
            {tab.dirty && (
              <span
                title={t("files.unsavedChanges")}
                aria-label={t("files.unsavedChanges")}
                style={{ color: "var(--accent)", fontSize: 10, lineHeight: 1, flexShrink: 0 }}
              >
                ●
              </span>
            )}
            <button
              type="button"
              draggable={false}
              onDragStart={(event) => event.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              onMouseEnter={() => setHoveredClose(tab.id)}
              onMouseLeave={() => setHoveredClose(null)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 24, height: 24,
                background: hoveredClose === tab.id ? "var(--bg-hover)" : "transparent",
                border: "none",
                borderRadius: 4,
                color: hoveredClose === tab.id ? "var(--text)" : "var(--text-dim)",
                cursor: "pointer",
                padding: 0,
                flexShrink: 0,
                transition: "background 0.1s, color 0.1s",
              }}
               title={t("i18n.close")}
               aria-label={`${t("i18n.close")} ${tab.label}`}
            >
              <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <line x1="2" y1="2" x2="8" y2="8" />
                <line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
