"use client";

import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { buildMarkdownToc, flattenToc, type TocItem } from "@/lib/markdown-toc";
import { scrollToHeadingSourceLine } from "@/lib/scroll-to-heading";
import { useI18n } from "@/hooks/useI18n";

function collectExpandableIds(items: TocItem[]): string[] {
  const ids: string[] = [];
  const walk = (nodes: TocItem[]) => {
    for (const n of nodes) {
      if (n.children.length > 0) {
        ids.push(n.id);
        walk(n.children);
      }
    }
  };
  walk(items);
  return ids;
}

function TocNode({
  item,
  depth,
  expanded,
  activeIndex,
  onToggle,
  onNavigate,
}: {
  item: TocItem;
  depth: number;
  expanded: Set<string>;
  activeIndex: number | null;
  onToggle: (id: string) => void;
  onNavigate: (item: TocItem) => void;
}) {
  const { t } = useI18n();
  const hasChildren = item.children.length > 0;
  const isOpen = expanded.has(item.id);
  const active = activeIndex === item.index;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          paddingLeft: 6 + depth * 12,
          paddingRight: 8,
          minHeight: 28,
          borderRadius: 4,
          background: active ? "var(--bg-selected)" : "transparent",
        }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(item.id)}
            aria-label={isOpen ? t("toc.collapse") : t("i18n.expand")}
            style={{
              width: 18,
              height: 18,
              padding: 0,
              border: "none",
              background: "none",
              color: "var(--text-dim)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <svg
              width="9"
              height="9"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform 0.12s" }}
            >
              <polyline points="3 2 7 5 3 8" />
            </svg>
          </button>
        ) : (
          <span style={{ width: 18, flexShrink: 0 }} />
        )}
        <button
          type="button"
          onClick={() => onNavigate(item)}
          title={item.text}
          style={{
            flex: 1,
            minWidth: 0,
            border: "none",
            background: "none",
            color: active ? "var(--accent)" : "var(--text)",
            cursor: "pointer",
            textAlign: "left",
            fontSize: depth === 0 ? 12 : 11,
            fontWeight: active || depth === 0 ? 600 : 400,
            lineHeight: 1.35,
            padding: "4px 0",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {item.text}
        </button>
      </div>
      {hasChildren && isOpen && (
        <div>
          {item.children.map((child) => (
            <TocNode
              key={`${child.index}-${child.id}`}
              item={child}
              depth={depth + 1}
              expanded={expanded}
              activeIndex={activeIndex}
              onToggle={onToggle}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Docked right panel. Jumps use the rendered heading's source line. */
export function MarkdownTocPanel({
  source,
  scrollRootRef,
}: {
  source: string;
  scrollRootRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const tree = useMemo(() => buildMarkdownToc(source), [source]);
  const flatItems = useMemo(() => flattenToc(tree), [tree]);
  const indexBySourceLine = useMemo(() => new Map(flatItems.map((item) => [item.sourceLine, item.index])), [flatItems]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  useEffect(() => {
    setExpanded(new Set(collectExpandableIds(tree)));
    setActiveIndex(tree[0]?.index ?? null);
  }, [tree]);

  const onToggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onNavigate = useCallback(
    (item: TocItem) => {
      const root = scrollRootRef.current;
      if (!root) return;

      const run = () => scrollToHeadingSourceLine(root, item.sourceLine, { behavior: "smooth", offset: 12 });
      if (!run()) {
        requestAnimationFrame(() => {
          run();
        });
      }
      setActiveIndex(item.index);
    },
    [scrollRootRef],
  );

  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root || tree.length === 0) return;

    const onScroll = () => {
      const headings = root.querySelectorAll<HTMLElement>("[data-heading-source-line]");
      if (headings.length === 0) return;
      const top = root.scrollTop + 48;
      let current = flatItems[0]?.index ?? 0;
      headings.forEach((heading) => {
        const index = indexBySourceLine.get(Number(heading.dataset.headingSourceLine));
        const y = heading.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
        if (index !== undefined && y <= top) current = index;
      });
      setActiveIndex(current);
    };

    onScroll();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, [scrollRootRef, tree, flatItems, indexBySourceLine, source]);

  if (tree.length === 0) return null;

  return (
    <div
      className="doc-toc-panel"
      style={{
        width: 260,
        minWidth: 260,
        maxWidth: 260,
        flexShrink: 0,
        height: "100%",
        borderLeft: "1px solid var(--border)",
        background: "var(--bg-panel)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 36,
          padding: "0 10px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.04em" }}>
          {t("toc.title")}
        </span>
        <div style={{ display: "flex", gap: 2 }}>
          <button
            type="button"
            title={t("toc.expandAll")}
            onClick={() => setExpanded(new Set(collectExpandableIds(tree)))}
            style={{ border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 11, padding: "2px 6px" }}
          >
            {t("i18n.expand")}
          </button>
          <button
            type="button"
            title={t("toc.collapseAll")}
            onClick={() => setExpanded(new Set())}
            style={{ border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 11, padding: "2px 6px" }}
          >
            {t("toc.collapse")}
          </button>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "6px 4px 12px" }}>
        {tree.map((item) => (
          <TocNode
            key={`${item.index}-${item.id}`}
            item={item}
            depth={0}
            expanded={expanded}
            activeIndex={activeIndex}
            onToggle={onToggle}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </div>
  );
}

export function markdownHasToc(source: string): boolean {
  return buildMarkdownToc(source).length > 0;
}
