"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Search, ChevronDown, ChevronUp, X, Replace } from "lucide-react";
import { useI18n } from "@/hooks/useI18n";

export interface SearchReplaceBarProps {
  isOpen: boolean;
  initialShowReplace?: boolean;
  onClose: () => void;
  text: string;
  onTextChange?: (newText: string) => void;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  contentContainerRef?: React.RefObject<HTMLDivElement | null>;
  /** Render kind of the read-only content: "source" uses .file-source-line rows,
   *  "markdown" scrolls to the nearest visible text block. */
  containerKind?: "source" | "markdown";
  /** Vertical offset when the bar is anchored inside a viewer shell. */
  topOffset?: number;
}

export interface SearchTextRange {
  start: number;
  end: number;
}

/** Deterministic, DOM-free match finder. Returns all [start,end) spans of
 *  `needle` inside `text` (case-insensitive unless exactCase). Used for
 *  textarea selection and per-line source targeting. */
export function findMatchSpans(
  text: string,
  needle: string,
  exactCase = false,
): SearchTextRange[] {
  if (!needle) return [];
  const haystack = exactCase ? text : text.toLowerCase();
  const key = exactCase ? needle : needle.toLowerCase();
  const spans: SearchTextRange[] = [];
  let idx = 0;
  while ((idx = haystack.indexOf(key, idx)) !== -1) {
    spans.push({ start: idx, end: idx + needle.length });
    idx += needle.length;
  }
  return spans;
}

const TEXTAREA_MIRROR_PROPERTIES = [
  "box-sizing",
  "direction",
  "font-family",
  "font-size",
  "font-style",
  "font-stretch",
  "font-variant",
  "font-weight",
  "letter-spacing",
  "line-height",
  "overflow-wrap",
  "padding",
  "tab-size",
  "text-align",
  "text-indent",
  "text-transform",
  "white-space",
  "word-break",
  "word-spacing",
] as const;

function scrollTextareaToOffset(textarea: HTMLTextAreaElement, offset: number): void {
  if (typeof document === "undefined" || typeof window === "undefined" || !document.body || textarea.clientWidth === 0) return;
  const computed = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  const marker = document.createElement("span");
  const value = textarea.value.slice(0, Math.max(0, Math.min(offset, textarea.value.length)));

  mirror.setAttribute("aria-hidden", "true");
  mirror.style.position = "absolute";
  mirror.style.left = "-100000px";
  mirror.style.top = "0";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.boxSizing = "border-box";
  mirror.style.border = "0";
  mirror.style.overflow = "visible";
  for (const property of TEXTAREA_MIRROR_PROPERTIES) {
    mirror.style.setProperty(property, computed.getPropertyValue(property));
  }

  mirror.textContent = value;
  marker.textContent = "\u200b";
  marker.style.display = "inline-block";
  marker.style.width = "1px";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  try {
    const markerTop = marker.offsetTop;
    const markerHeight = Math.max(marker.offsetHeight, Number.parseFloat(computed.lineHeight) || 16);
    textarea.scrollTop = Math.max(0, (markerTop + markerHeight / 2) - textarea.clientHeight / 2);
  } finally {
    mirror.remove();
  }
}

export interface RenderedMatchSegment {
  nodeIndex: number;
  start: number;
  end: number;
}

export interface RenderedMatch {
  segments: RenderedMatchSegment[];
}

/** Map rendered text across inline nodes back to exact match segments. */
export function findRenderedMatchSegments(
  textNodes: string[],
  needle: string,
  exactCase = false,
): RenderedMatch[] {
  const spans = findMatchSpans(textNodes.join(""), needle, exactCase);
  return spans.map((span) => {
    const segments: RenderedMatchSegment[] = [];
    let nodeStart = 0;
    for (let nodeIndex = 0; nodeIndex < textNodes.length; nodeIndex += 1) {
      const nodeEnd = nodeStart + textNodes[nodeIndex].length;
      const start = Math.max(span.start, nodeStart);
      const end = Math.min(span.end, nodeEnd);
      if (start < end) {
        segments.push({ nodeIndex, start: start - nodeStart, end: end - nodeStart });
      }
      nodeStart = nodeEnd;
      if (nodeStart >= span.end) break;
    }
    return { segments };
  }).filter((match) => match.segments.length > 0);
}

const SEARCH_BLOCK_SELECTOR = "p,li,td,th,h1,h2,h3,h4,h5,h6,pre,code,blockquote,.markdown-table-wrap,.markdown-frontmatter-title,.markdown-frontmatter-tag,.markdown-frontmatter-row";

function searchBlockFor(node: Node): HTMLElement | null {
  const parent = node.parentElement;
  if (!parent || parent.closest("[data-search-replace-bar='true']") || parent.closest("mark[data-search-word-match]")) return null;
  return parent.closest<HTMLElement>(SEARCH_BLOCK_SELECTOR);
}

export function clearSearchHighlights(root: HTMLElement | null | undefined): void {
  if (!root) return;
  for (const mark of Array.from(root.querySelectorAll<HTMLElement>("mark[data-search-word-match]"))) {
    mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
  }
  root.normalize();
  root.classList.remove("search-flash-highlight");
  const els = root.querySelectorAll<HTMLElement>(".search-flash-highlight");
  for (const el of els) el.classList.remove("search-flash-highlight");
}

/** Apply exact word marks to rendered Markdown and return one anchor per match. */
function renderedMatchAnchors(root: HTMLElement, needle: string, exactCase: boolean): HTMLElement[] {
  if (!needle) return [];
  const textNodesByBlock = new Map<HTMLElement, Text[]>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    const block = searchBlockFor(node);
    if (block) {
      const textNode = node as Text;
      const nodes = textNodesByBlock.get(block);
      if (nodes) nodes.push(textNode);
      else textNodesByBlock.set(block, [textNode]);
    }
    node = walker.nextNode();
  }

  const anchors: HTMLElement[] = [];
  for (const nodes of textNodesByBlock.values()) {
    const matches = findRenderedMatchSegments(nodes.map((textNode) => textNode.nodeValue ?? ""), needle, exactCase);
    const segmentsByNode = new Map<number, Array<RenderedMatchSegment & { matchIndex: number }>>();
    const matchBase = anchors.length;
    matches.forEach((match, matchIndex) => {
      const globalMatchIndex = matchBase + matchIndex;
      for (const segment of match.segments) {
        const list = segmentsByNode.get(segment.nodeIndex);
        const item = { ...segment, matchIndex: globalMatchIndex };
        if (list) list.push(item);
        else segmentsByNode.set(segment.nodeIndex, [item]);
      }
    });

    for (const [nodeIndex, segments] of segmentsByNode) {
      const textNode = nodes[nodeIndex];
      const value = textNode.nodeValue ?? "";
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const segment of segments.sort((left, right) => left.start - right.start)) {
        if (segment.start > cursor) fragment.appendChild(document.createTextNode(value.slice(cursor, segment.start)));
        const mark = document.createElement("mark");
        mark.dataset.searchWordMatch = String(segment.matchIndex);
        mark.textContent = value.slice(segment.start, segment.end);
        fragment.appendChild(mark);
        if (!anchors[segment.matchIndex]) anchors[segment.matchIndex] = mark;
        cursor = segment.end;
      }
      if (cursor < value.length) fragment.appendChild(document.createTextNode(value.slice(cursor)));
      textNode.replaceWith(fragment);
    }
  }
  return anchors;
}

/** Find the row element that visually contains `textOffset` for the current
 *  read-only source/markdown render. Source rows expose data-line-number;
 *  fall back to the deepest visible block that contains the offset's text. */
function rowForOffset(root: HTMLElement, text: string, offset: number, containerKind: string): HTMLElement | null {
  const before = text.slice(0, offset);
  const lineNo = before.split("\n").length;
  if (containerKind !== "markdown") {
    const lineEl = root.querySelector<HTMLElement>(`.file-source-line[data-line-number="${lineNo}"]`);
    if (lineEl) return lineEl;
  }
  // Generic fallback: walk text nodes inside scroll content, track cumulative
  // offsets using the raw rendered text so selection scrolls to the right block.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  let node: Node | null = walker.nextNode();
  while (node) {
    const value = node.nodeValue ?? "";
    if (offset >= consumed && offset < consumed + value.length + 1) {
      const parent = node.parentElement;
      if (parent) {
        const block = parent.closest<HTMLElement>("p,li,td,th,h1,h2,h3,h4,h5,h6,pre,code,.file-source-line,.markdown-table-wrap");
        return block ?? parent;
      }
      return null;
    }
    consumed += value.length + 1;
    node = walker.nextNode();
  }
  return null;
}

export function SearchReplaceBar({
  isOpen,
  initialShowReplace = false,
  onClose,
  text,
  onTextChange,
  textareaRef,
  contentContainerRef,
  containerKind = "source",
  topOffset = 8,
}: SearchReplaceBarProps) {
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [showReplace, setShowReplace] = useState(initialShowReplace);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);

  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initialShowReplace) {
      setShowReplace(true);
    }
  }, [initialShowReplace]);

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    }
  }, [isOpen]);

  // Compute all match positions via the shared, deterministic helper
  const matches = useRef<SearchTextRange[]>([]);
  matches.current = findMatchSpans(text, searchQuery, caseSensitive);
  const [previewMatchCount, setPreviewMatchCount] = useState(0);

  useEffect(() => {
    if (containerKind !== "markdown" || !searchQuery || !contentContainerRef?.current) {
      setPreviewMatchCount(0);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const root = contentContainerRef.current;
      if (!root) {
        setPreviewMatchCount(0);
        return;
      }
      clearSearchHighlights(root);
      setPreviewMatchCount(renderedMatchAnchors(root, searchQuery, caseSensitive).length);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [caseSensitive, containerKind, contentContainerRef, searchQuery, text]);

  const matchCount = containerKind === "markdown" ? previewMatchCount : matches.current.length;
  const safeIndex = matchCount > 0 ? Math.min(currentMatchIndex, matchCount - 1) : 0;

  // Highlight bookkeeping: never leave a stale highlight behind when the
  // query changes, the bar closes, or the component unmounts.
  const highlightTimerRef = useRef<number | null>(null);
  const clearTimer = useCallback(() => {
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
  }, []);

  const flashRow = useCallback((row: HTMLElement) => {
    row.classList.remove("search-flash-highlight");
    void (row as HTMLElement).offsetWidth; // reflow so transition can restart
    row.classList.add("search-flash-highlight");
    clearTimer();
    highlightTimerRef.current = window.setTimeout(() => {
      row.classList.remove("search-flash-highlight");
      highlightTimerRef.current = null;
    }, 1200);
  }, [clearTimer]);

  const selectMatch = useCallback(
    (index: number, options?: { focusEditor?: boolean }) => {
      const focusEditor = options?.focusEditor ?? false;
      const root = contentContainerRef?.current;
      // Remove stale highlights in the current container regardless of match.
      clearSearchHighlights(root);

      // 1. Edit mode uses the native textarea selection surface.
      const textarea = textareaRef?.current;
      if (textarea) {
        const spans = matches.current;
        if (spans.length === 0) return;
        const span = spans[index % spans.length];
        const activeInput = document.activeElement;
        const keepInputFocus = activeInput instanceof HTMLElement && activeInput.closest("[data-search-replace-bar='true']");
        if (focusEditor && !keepInputFocus) textarea.focus();
        textarea.setSelectionRange(span.start, span.end);
        scrollTextareaToOffset(textarea, span.start);
        if (keepInputFocus && activeInput instanceof HTMLElement && activeInput !== document.activeElement) {
          activeInput.focus();
        }
        return;
      }

      // 2. Read-only source/Markdown: navigate the selected rendered target.
      if (!root) return;
      if (containerKind === "markdown") {
        const targets = renderedMatchAnchors(root, searchQuery, caseSensitive);
        if (targets.length === 0) return;
        const activeMatch = String(index % targets.length);
        for (const mark of root.querySelectorAll<HTMLElement>("mark[data-search-word-match]")) {
          mark.dataset.searchActive = mark.dataset.searchWordMatch === activeMatch ? "true" : "false";
        }
        const target = targets[index % targets.length];
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        return;
      }

      if (matches.current.length === 0) return;
      const span = matches.current[index % matches.current.length];
      const row = rowForOffset(root, text, span.start, containerKind);
      if (row) {
        row.scrollIntoView({ block: "center", behavior: "smooth" });
        flashRow(row);
      }
    },
    [caseSensitive, containerKind, searchQuery, textareaRef, contentContainerRef, flashRow, text]
  );

  // The input onChange callback belongs to the previous render, so selecting
  // there would see the old query and an empty match list. Select the first
  // match after React commits the new query state instead.
  const selectMatchRef = useRef(selectMatch);
  selectMatchRef.current = selectMatch;

  useEffect(() => {
    if (!isOpen || !searchQuery) {
      clearSearchHighlights(contentContainerRef?.current);
      clearTimer();
      return;
    }
    const frame = window.requestAnimationFrame(() => selectMatchRef.current(0, { focusEditor: false }));
    return () => window.cancelAnimationFrame(frame);
  }, [caseSensitive, clearTimer, contentContainerRef, isOpen, searchQuery]);

  // Clean highlights when the search component unmounts or its container changes.
  useEffect(() => {
    const container = contentContainerRef?.current;
    return () => {
      clearTimer();
      clearSearchHighlights(container);
    };
  }, [clearTimer, contentContainerRef]);

  const handleNext = useCallback(() => {
    if (matchCount === 0) return;
    const next = (safeIndex + 1) % matchCount;
    setCurrentMatchIndex(next);
    selectMatch(next, { focusEditor: false });
  }, [matchCount, safeIndex, selectMatch]);

  const handlePrev = useCallback(() => {
    if (matchCount === 0) return;
    const prev = (safeIndex - 1 + matchCount) % matchCount;
    setCurrentMatchIndex(prev);
    selectMatch(prev, { focusEditor: false });
  }, [matchCount, safeIndex, selectMatch]);

  const handleReplaceCurrent = useCallback(() => {
    if (matchCount === 0 || !onTextChange) return;
    const span = matches.current[safeIndex];
    const nextText = text.substring(0, span.start) + replaceQuery + text.substring(span.end);
    onTextChange(nextText);
    requestAnimationFrame(() => {
      selectMatch(safeIndex % (matchCount > 1 ? matchCount - 1 : 1));
    });
  }, [matchCount, safeIndex, text, replaceQuery, onTextChange, selectMatch]);

  const handleReplaceAll = useCallback(() => {
    if (matchCount === 0 || !onTextChange) return;
    const haystack = caseSensitive ? text : text.toLowerCase();
    const needle = caseSensitive ? searchQuery : searchQuery.toLowerCase();
    let result = "";
    let lastIdx = 0;
    let idx = 0;
    while ((idx = haystack.indexOf(needle, lastIdx)) !== -1) {
      result += text.substring(lastIdx, idx) + replaceQuery;
      lastIdx = idx + needle.length;
    }
    result += text.substring(lastIdx);
    onTextChange(result);
  }, [matchCount, caseSensitive, text, searchQuery, replaceQuery, onTextChange]);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) handlePrev();
      else handleNext();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  useEffect(() => {
    if (!isOpen) {
      clearSearchHighlights(contentContainerRef?.current);
      clearTimer();
    }
  }, [clearTimer, contentContainerRef, isOpen]);

  if (!isOpen) return null;

  return (
    <div
      data-search-replace-bar="true"
      style={{
        position: "absolute",
        top: topOffset,
        right: 16,
        zIndex: 500,
        background: "var(--bg-panel, #ffffff)",
        border: "1px solid var(--border, #e5e7eb)",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.16)",
        padding: "6px 8px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontSize: 12,
        minWidth: 320,
      }}
    >
      <style>{`
        .search-flash-highlight {
          background-color: rgba(250, 204, 21, 0.35) !important;
          transition: background-color 0.4s ease;
        }
        mark[data-search-word-match] {
          background-color: rgba(250, 204, 21, 0.55) !important;
          color: inherit !important;
          border-radius: 2px;
          padding: 0;
        }
        mark[data-search-word-match][data-search-active="true"] {
          background-color: rgba(34, 197, 94, 0.65) !important;
          outline: 1px solid rgba(22, 163, 74, 0.75);
        }
      `}</style>

      {/* Search Row */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {onTextChange && (
          <button
            type="button"
            onClick={() => setShowReplace((v) => !v)}
            title={showReplace ? t("searchReplace.hideReplace") : t("searchReplace.showReplace")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 20,
              height: 20,
              border: "none",
              background: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              padding: 0,
            }}
          >
            <ChevronDown
              size={14}
              style={{
                transform: showReplace ? "rotate(0deg)" : "rotate(-90deg)",
                transition: "transform 0.15s ease",
              }}
            />
          </button>
        )}

        <div style={{ position: "relative", flex: 1, display: "flex", alignItems: "center" }}>
          <Search size={13} style={{ position: "absolute", left: 7, color: "var(--text-muted)" }} />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => {
              clearSearchHighlights(contentContainerRef?.current);
              clearTimer();
              setSearchQuery(e.target.value);
              setCurrentMatchIndex(0);
            }}
            onKeyDown={handleSearchKeyDown}
            placeholder={t("searchReplace.findPlaceholder")}
            style={{
              width: "100%",
              height: 26,
              paddingLeft: 24,
              paddingRight: 8,
              borderRadius: 4,
              border: "1px solid var(--border, #e5e7eb)",
              background: "var(--bg, #ffffff)",
              color: "var(--text, #111827)",
              fontSize: 12,
              outline: "none",
            }}
          />
        </div>

        {searchQuery && (
          <span
            style={{
              fontSize: 11,
              color: matchCount > 0 ? "var(--text-muted)" : "#ef4444",
              fontFamily: "var(--font-mono)",
              whiteSpace: "nowrap",
            }}
          >
            {matchCount > 0 ? `${safeIndex + 1}/${matchCount}` : t("searchReplace.noMatches")}
          </span>
        )}

        <button
          type="button"
          onClick={() => setCaseSensitive((v) => !v)}
          title={caseSensitive ? t("searchReplace.caseSensitiveOn") : t("searchReplace.caseSensitiveOff")}
          style={{
            padding: "2px 5px",
            borderRadius: 3,
            border: caseSensitive ? "1px solid var(--accent, #3b82f6)" : "1px solid transparent",
            background: caseSensitive ? "var(--bg-selected, rgba(59, 130, 246, 0.1))" : "transparent",
            color: caseSensitive ? "var(--accent, #3b82f6)" : "var(--text-muted)",
            fontSize: 11,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Aa
        </button>

        <button
          type="button"
          onClick={handlePrev}
          disabled={matchCount === 0}
          title={t("searchReplace.previous")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            border: "none",
            background: "none",
            color: matchCount > 0 ? "var(--text)" : "var(--text-dim, #999)",
            cursor: matchCount > 0 ? "pointer" : "default",
          }}
        >
          <ChevronUp size={14} />
        </button>

        <button
          type="button"
          onClick={handleNext}
          disabled={matchCount === 0}
          title={t("searchReplace.next")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            border: "none",
            background: "none",
            color: matchCount > 0 ? "var(--text)" : "var(--text-dim, #999)",
            cursor: matchCount > 0 ? "pointer" : "default",
          }}
        >
          <ChevronDown size={14} />
        </button>

        <button
          type="button"
          onClick={onClose}
          title={t("searchReplace.close")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            border: "none",
            background: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
          }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Replace Row */}
      {showReplace && onTextChange && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 26 }}>
          <div style={{ position: "relative", flex: 1, display: "flex", alignItems: "center" }}>
            <Replace size={13} style={{ position: "absolute", left: 7, color: "var(--text-muted)" }} />
            <input
              type="text"
              value={replaceQuery}
              onChange={(e) => setReplaceQuery(e.target.value)}
              placeholder={t("searchReplace.replacePlaceholder")}
              style={{
                width: "100%",
                height: 26,
                paddingLeft: 24,
                paddingRight: 8,
                borderRadius: 4,
                border: "1px solid var(--border, #e5e7eb)",
                background: "var(--bg, #ffffff)",
                color: "var(--text, #111827)",
                fontSize: 12,
                outline: "none",
              }}
            />
          </div>

          <button
            type="button"
            onClick={handleReplaceCurrent}
            disabled={matchCount === 0}
            style={{
              padding: "3px 8px",
              borderRadius: 4,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: matchCount > 0 ? "var(--text)" : "var(--text-dim, #999)",
              fontSize: 11,
              cursor: matchCount > 0 ? "pointer" : "default",
              whiteSpace: "nowrap",
            }}
          >
            {t("searchReplace.replace")}
          </button>

          <button
            type="button"
            onClick={handleReplaceAll}
            disabled={matchCount === 0}
            style={{
              padding: "3px 8px",
              borderRadius: 4,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: matchCount > 0 ? "var(--text)" : "var(--text-dim, #999)",
              fontSize: 11,
              cursor: matchCount > 0 ? "pointer" : "default",
              whiteSpace: "nowrap",
            }}
          >
            {t("searchReplace.replaceAll")}
          </button>
        </div>
      )}
    </div>
  );
}
