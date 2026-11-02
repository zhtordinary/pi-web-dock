"use client";

import { useLayoutEffect, useState, type RefObject } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { QuoteContextItem } from "@/lib/quote-context";

export interface QuoteHighlight {
  quote: QuoteContextItem;
  quoteIndex: number;
  ranges: Range[];
}

type Rectangle = { left: number; top: number; width: number; height: number };
type HighlightRectangle = Rectangle & { key: string; color: string; kind: "quote" | "search" };
type Badge = { quote: QuoteContextItem; quoteIndex: number; left: number; top: number };

function rangeRectangles(range: Range, host: HTMLElement, hostRect: DOMRect, clips: Map<Element, { x: boolean; y: boolean; rect: DOMRect }>): Rectangle[] {
  if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) return [];
  let left = -Infinity, right = Infinity, top = -Infinity, bottom = Infinity;
  for (let element = range.startContainer.parentElement; element && element !== host; element = element.parentElement) {
    let clip = clips.get(element);
    if (!clip) {
      const style = getComputedStyle(element);
      clip = {
        x: /^(auto|scroll|hidden|clip)$/.test(style.overflowX),
        y: /^(auto|scroll|hidden|clip)$/.test(style.overflowY),
        rect: element.getBoundingClientRect(),
      };
      clips.set(element, clip);
    }
    if (clip.x) { left = Math.max(left, clip.rect.left); right = Math.min(right, clip.rect.right); }
    if (clip.y) { top = Math.max(top, clip.rect.top); bottom = Math.min(bottom, clip.rect.bottom); }
  }
  return Array.from(range.getClientRects()).flatMap((rect) => {
    const x = Math.max(rect.left, left), y = Math.max(rect.top, top);
    const width = Math.min(rect.right, right) - x, height = Math.min(rect.bottom, bottom) - y;
    return width > 0 && height > 0 ? [{ left: x - hostRect.left, top: y - hostRect.top, width, height }] : [];
  });
}

export function TranscriptHighlights({ hostRef, contentRef, quotes, searchRanges, flashingQuoteId, onBadgeClick, onBadgeHover, onBadgeLeave }: {
  hostRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  quotes: QuoteHighlight[];
  searchRanges: Range[];
  flashingQuoteId: string | null;
  onBadgeClick: (quote: QuoteContextItem) => void;
  onBadgeHover: (quote: QuoteContextItem, badge: HTMLElement) => void;
  onBadgeLeave: () => void;
}) {
  const { t } = useI18n();
  const [geometry, setGeometry] = useState<{ rectangles: HighlightRectangle[]; badges: Badge[] }>({ rectangles: [], badges: [] });

  useLayoutEffect(() => {
    const host = hostRef.current, content = contentRef.current;
    if (!host || !content) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const hostRect = host.getBoundingClientRect();
      const clips = new Map<Element, { x: boolean; y: boolean; rect: DOMRect }>();
      const rectangles: HighlightRectangle[] = [], badges: Badge[] = [];
      searchRanges.forEach((range, index) => {
        rangeRectangles(range, host, hostRect, clips).forEach((rect, part) => rectangles.push({
          ...rect, key: `search-${index}-${part}`, color: "rgba(250, 204, 21, 0.5)", kind: "search",
        }));
      });
      quotes.forEach(({ quote, quoteIndex, ranges }) => {
        ranges.forEach((range, index) => {
          const rects = rangeRectangles(range, host, hostRect, clips);
          rects.forEach((rect, part) => rectangles.push({
            ...rect, key: `quote-${quote.id}-${index}-${part}`,
            color: flashingQuoteId === quote.id ? "rgba(250, 204, 21, 0.65)" : "rgba(59, 130, 246, 0.2)", kind: "quote",
          }));
          if (index === ranges.length - 1 && rects.length) {
            const rect = rects[rects.length - 1];
            const endpoint = Array.from(range.getClientRects()).at(-1);
            if (endpoint && Math.abs(rect.left + rect.width + hostRect.left - endpoint.right) < 1
              && Math.abs(rect.top + rect.height + hostRect.top - endpoint.bottom) < 1) {
              badges.push({ quote, quoteIndex, left: Math.max(0, Math.min(rect.left + rect.width + 3, hostRect.width - 18)), top: Math.max(0, rect.top + rect.height - 18) });
            }
          }
        });
      });
      setGeometry({ rectangles, badges });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(host);
    observer?.observe(content);
    host.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      host.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [contentRef, flashingQuoteId, hostRef, quotes, searchRanges]);

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 1 }}>
      <svg aria-hidden="true" width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
        {geometry.rectangles.map((rect) => (
          <rect key={rect.key} x={rect.left} y={rect.top} width={rect.width} height={rect.height} rx={2} fill={rect.color}
            data-reader-quote-mark={rect.kind === "quote" ? "true" : undefined}
            data-session-search-match={rect.kind === "search" ? "true" : undefined} />
        ))}
      </svg>
      {geometry.badges.map(({ quote, quoteIndex, left, top }) => (
        <button key={quote.id} type="button" data-reader-quote-badge="true" data-quote-id={quote.id} data-quote-index={quoteIndex}
          className="reader-quote-badge" title={t("quote.badgeEditTitle")} aria-label={t("quote.editBadge", { index: quoteIndex + 1 })}
          onMouseEnter={(event) => { event.currentTarget.style.transform = "scale(1.12)"; event.currentTarget.style.filter = "brightness(1.1)"; onBadgeHover(quote, event.currentTarget); }}
          onMouseLeave={(event) => { event.currentTarget.style.transform = "none"; event.currentTarget.style.filter = "none"; onBadgeLeave(); }}
          onFocus={(event) => onBadgeHover(quote, event.currentTarget)} onBlur={onBadgeLeave}
          onClick={(event) => { event.stopPropagation(); onBadgeClick(quote); }}
          style={{ position: "absolute", left, top, pointerEvents: "auto", display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 18, height: 18, padding: 0, border: 0, borderRadius: "50%", backgroundColor: "var(--accent, #2563eb)",
            color: "#fff", fontSize: 11, fontWeight: 700, fontFamily: "var(--font-mono, monospace)", lineHeight: 1,
            cursor: "pointer", userSelect: "none", boxShadow: "0 1px 3px rgba(0, 0, 0, 0.25)", transition: "transform 0.15s, filter 0.15s" }}>
          {quoteIndex + 1}
        </button>
      ))}
    </div>
  );
}
