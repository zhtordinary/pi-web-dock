"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { X, Pencil, Trash2, Check } from "lucide-react";
import { getQuotePreviewMaxHeight, type QuoteContextItem } from "@/lib/quote-context";
import { useI18n } from "@/hooks/useI18n";

export interface QuoteCardGroupProps {
  quotes: QuoteContextItem[];
  onRemoveQuote: (id: string) => void;
  onUpdateQuote?: (id: string, text: string) => void;
  onEditQuote?: (quote: QuoteContextItem) => void;
  onJumpToQuote?: (id: string) => void;
  onReorderQuotes?: (fromIndex: number, toIndex: number) => void;
  compact?: boolean;
}

function getVisibleTopBoundary(element: HTMLElement): number {
  let visibleTop = window.visualViewport?.offsetTop ?? 0;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "hidden" || overflowY === "clip") {
      visibleTop = Math.max(visibleTop, parent.getBoundingClientRect().top + parent.clientTop);
    }
  }
  return visibleTop;
}

export function QuoteCardGroup({
  quotes,
  onRemoveQuote,
  onUpdateQuote,
  onEditQuote,
  onJumpToQuote,
  onReorderQuotes,
  compact = false,
}: QuoteCardGroupProps) {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);

  const [hoveredQuoteId, setHoveredQuoteId] = useState<string | null>(null);
  const hoverTimerRef = useRef<NodeJS.Timeout | null>(null);

  const [dragQuoteIdx, setDragQuoteIdx] = useState<number | null>(null);
  const [dragOverQuoteIdx, setDragOverQuoteIdx] = useState<number | null>(null);

  const startEdit = useCallback(
    (quote: QuoteContextItem) => {
      if (onEditQuote) {
        onEditQuote(quote);
        return;
      }
      setEditingId(quote.id);
      setEditText(quote.reply || quote.text);
    },
    [onEditQuote],
  );

  const saveEdit = useCallback(() => {
    if (editingId) {
      const trimmed = editText.trim();
      if (trimmed) {
        onUpdateQuote?.(editingId, trimmed);
      } else {
        onRemoveQuote(editingId);
      }
      setEditingId(null);
    }
  }, [editingId, editText, onRemoveQuote, onUpdateQuote]);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
  }, []);

  const handleCardMouseEnter = useCallback((id: string, anchor?: HTMLElement) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    if (anchor) {
      const maxHeight = getQuotePreviewMaxHeight(anchor.getBoundingClientRect().top, getVisibleTopBoundary(anchor));
      anchor.style.setProperty("--quote-preview-max-height", `${maxHeight}px`);
    }
    setHoveredQuoteId(id);
  }, []);

  const handleCardMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setHoveredQuoteId(null);
    }, 400);
  }, []);

  useEffect(() => {
    if (editingId && editTextareaRef.current) {
      editTextareaRef.current.focus();
      editTextareaRef.current.select();
    }
  }, [editingId]);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  if (!quotes.length) return null;

  return (
    <div
      data-quotes-group="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        flexWrap: "wrap",
        maxWidth: "100%",
      }}
    >
      {quotes.map((quote, index) => {
        const num = index + 1;
        const isEditing = editingId === quote.id;
        const isHovered = hoveredQuoteId === quote.id;
        const isDragging = dragQuoteIdx === index;
        const isDragOver = dragOverQuoteIdx === index;

        return (
          <div
            key={quote.id}
            draggable={!isEditing}
            onDragStart={(e) => {
              e.dataTransfer.setData("type", "quote-card");
              e.dataTransfer.effectAllowed = "move";
              setDragQuoteIdx(index);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dragQuoteIdx !== null && dragQuoteIdx !== index) {
                setDragOverQuoteIdx(index);
              }
            }}
            onDragLeave={() => {
              setDragOverQuoteIdx(null);
            }}
            onDragEnd={() => {
              setDragQuoteIdx(null);
              setDragOverQuoteIdx(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragQuoteIdx !== null && dragQuoteIdx !== index) {
                onReorderQuotes?.(dragQuoteIdx, index);
              }
              setDragQuoteIdx(null);
              setDragOverQuoteIdx(null);
            }}
            onMouseEnter={(e) => handleCardMouseEnter(quote.id, e.currentTarget)}
            onMouseLeave={(e) => {
              if (!e.currentTarget.contains(document.activeElement)) handleCardMouseLeave();
            }}
            onFocus={(e) => handleCardMouseEnter(quote.id, e?.currentTarget)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) handleCardMouseLeave();
            }}
            style={{
              position: "relative",
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            {/* 单个横向排列的卡片 */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => {
                handleCardMouseEnter(quote.id);
                onJumpToQuote?.(quote.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onJumpToQuote?.(quote.id);
                }
              }}
              className="quote-number-button"
              aria-label={t("quote.badgeLabel", { num })}
              title={t("quote.badgeTitle")}
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: compact ? "2px 0" : "3px 0",
                borderRadius: 4,
                outline: isDragOver ? "1.5px dashed var(--accent, #3b82f6)" : undefined,
                cursor: "grab",
                opacity: isDragging ? 0.4 : 1,
                userSelect: "none",
                transition: "opacity 0.15s",
              }}
            >
              {/* 序号标注 [{num}] */}
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "0 4px",
                  height: 16,
                  borderRadius: 4,
                  background: "var(--accent, #3b82f6)",
                  color: "#ffffff",
                  fontSize: 10,
                  fontWeight: 700,
                  fontFamily: "var(--font-mono, monospace)",
                  lineHeight: 1,
                  flexShrink: 0,
                }}
              >
                [{num}]
              </span>

            </div>

            {/* 编号的引用详情 */}
            {isHovered && !isEditing && (
              <div
                onClick={(e) => e.stopPropagation()}
                onMouseEnter={() => handleCardMouseEnter(quote.id)}
                onMouseLeave={handleCardMouseLeave}
                style={{
                  position: "absolute",
                  bottom: "calc(100% + 6px)",
                  left: 0,
                  zIndex: 1200,
                  minWidth: 280,
                  maxWidth: compact ? 300 : 400,
                  maxHeight: "var(--quote-preview-max-height, calc(100dvh - 24px))",
                  overflowY: "auto",
                  overflowX: "hidden",
                  borderRadius: 12,
                  background: "var(--bg, #ffffff)",
                  border: "1px solid var(--border)",
                  boxShadow: "0 8px 24px rgba(0, 0, 0, 0.14)",
                  display: "flex",
                  flexDirection: "column",
                  cursor: "default",
                }}
              >
                <div className="quote-preview-actions" style={{ width: "max-content", gap: 2 }}>
                  <button
                    type="button"
                    title={t("quote.reEdit")}
                    aria-label={`${t("quote.reEdit")} [${num}]`}
                    onClick={(e) => {
                      e.stopPropagation();
                      startEdit(quote);
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      padding: 5,
                      width: 28,
                      height: 28,
                      cursor: "pointer",
                      color: "var(--text-muted)",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: 4,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = "var(--text)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = "var(--text-muted)";
                    }}
                  >
                    <Pencil size={13} strokeWidth={1.8} />
                  </button>
                  <button
                    type="button"
                    className="quote-delete-button"
                    style={{ boxSizing: "border-box", width: 28, minWidth: 28, height: 28, minHeight: 28, padding: 5 }}
                    aria-label={`${t("quote.remove")} [${num}]`}
                    title={`${t("quote.remove")} [${num}]`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveQuote(quote.id);
                      if (editingId === quote.id) setEditingId(null);
                    }}
                  >
                    <Trash2 size={13} strokeWidth={1.8} />
                  </button>
                </div>

                <div className="quote-preview-content">
                  <button
                    type="button"
                    className="quote-preview-source"
                    onClick={() => onJumpToQuote?.(quote.id)}
                    title={t("quote.jumpToSelection")}
                  >
                    {quote.text}
                  </button>

                  <div className="quote-preview-comment">
                    <span className="quote-preview-comment-label">Reply:</span>{" "}
                    <span className="quote-preview-comment-text">
                      {quote.reply || t("quote.noComment")}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* 行内重新编辑浮层（兼容性回退） */}
            {isEditing && (
              <div
                style={{
                  position: "absolute",
                  bottom: "calc(100% + 6px)",
                  left: 0,
                  zIndex: 1200,
                  width: 320,
                  padding: 10,
                  borderRadius: 8,
                  background: "var(--bg, #ffffff)",
                  border: "1px solid var(--border)",
                  boxShadow: "0 6px 20px rgba(0,0,0,0.18)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text)" }}>
                    {t("quote.reEdit")} [{num}]
                  </span>
                  <button
                    type="button"
                    onClick={cancelEdit}
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      padding: 2,
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
                <textarea
                  ref={editTextareaRef}
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  placeholder={t("quote.placeholder")}
                  rows={3}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      saveEdit();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelEdit();
                    }
                  }}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    fontSize: 12,
                    lineHeight: 1.45,
                    padding: "6px 8px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel, rgba(0,0,0,0.02))",
                    color: "var(--text)",
                    resize: "vertical",
                    minHeight: 50,
                    maxHeight: 160,
                    fontFamily: "inherit",
                  }}
                />
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                  <button
                    type="button"
                    onClick={cancelEdit}
                    style={{
                      padding: "3px 8px",
                      borderRadius: 5,
                      border: "1px solid var(--border)",
                      background: "transparent",
                      color: "var(--text-muted)",
                      fontSize: 11,
                      cursor: "pointer",
                    }}
                  >
                    {t("quote.cancelEdit")}
                  </button>
                  <button
                    type="button"
                    onClick={saveEdit}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "3px 10px",
                      borderRadius: 5,
                      border: "none",
                      background: "var(--accent, #3b82f6)",
                      color: "#ffffff",
                      fontSize: 11,
                      fontWeight: 500,
                      cursor: "pointer",
                    }}
                  >
                    <Check size={12} strokeWidth={2.2} />
                    <span>{t("quote.saveEdit")}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
