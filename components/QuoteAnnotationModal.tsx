"use client";

import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { X, CornerDownLeft, MessageSquarePlus, Plus, Trash2 } from "lucide-react";
import { useI18n } from "@/hooks/useI18n";
import {
  getExtensionDialogInputCompositionEndAtOnBlur,
  handleExtensionDialogInputKeyDown,
} from "@/lib/extension-dialog-keyboard";

export interface QuoteAnnotationModalProps {
  isOpen: boolean;
  quoteText: string;
  initialReply?: string;
  onConfirm: (reply: string) => void;
  onClose: () => void;
  onDelete?: () => void;
}

export function QuoteAnnotationModal({
  isOpen,
  quoteText,
  initialReply = "",
  onConfirm,
  onClose,
  onDelete,
}: QuoteAnnotationModalProps) {
  const { t } = useI18n();
  const [reply, setReply] = useState(initialReply);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const compositionActiveRef = useRef(false);
  const compositionEndAtRef = useRef(0);

  useEffect(() => {
    setReply(initialReply);
  }, [initialReply, isOpen]);

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxH = Math.max(160, Math.min(window.innerHeight - 380, 420));
    const nextH = Math.min(Math.max(el.scrollHeight, 90), maxH);
    el.style.height = `${nextH}px`;
    el.style.overflowY = el.scrollHeight > maxH ? "auto" : "hidden";
  }, []);

  useLayoutEffect(() => {
    if (isOpen) {
      resizeTextarea();
    }
  }, [isOpen, reply, resizeTextarea]);

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          const el = textareaRef.current;
          el.setSelectionRange(el.value.length, el.value.length);
          el.scrollTop = el.scrollHeight;
        }
      });
    }
  }, [isOpen, initialReply]);

  const handleConfirm = useCallback(() => {
    const trimmed = reply.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  }, [reply, onConfirm]);

  const insertNewline = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.setRangeText("\n", el.selectionStart, el.selectionEnd, "end");
    setReply(el.value);
    el.focus();
    resizeTextarea();
  }, [resizeTextarea]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        handleExtensionDialogInputKeyDown(
          e.nativeEvent,
          compositionActiveRef.current,
          compositionEndAtRef.current,
          handleConfirm,
        );
      }
    },
    [handleConfirm, onClose],
  );

  if (!isOpen || typeof document === "undefined") return null;

  const canSubmit = reply.trim().length > 0;
  const placeholder = t("quote.replyPlaceholder");

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1500,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        boxSizing: "border-box",
      }}
      role="dialog"
      aria-modal="true"
      aria-label={t("quote.dialogLabel")}
    >
      {/* 全屏背景遮罩 */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0, 0, 0, 0.45)",
          backdropFilter: "blur(2px)",
          zIndex: 1500,
        }}
      />

      {/* 居中弹窗卡片 */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          zIndex: 1501,
          width: "92%",
          maxWidth: 620,
          maxHeight: "min(88vh, 760px)",
          background: "var(--bg, #ffffff)",
          border: "1px solid var(--border, #e5e7eb)",
          borderRadius: 12,
          boxShadow: "0 16px 48px rgba(0, 0, 0, 0.22)",
          padding: "16px 18px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          overflow: "hidden",
          boxSizing: "border-box",
        }}
      >
        {/* 顶部标题区 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            paddingBottom: 10,
            borderBottom: "1px solid var(--border, #e5e7eb)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 22,
                height: 22,
                borderRadius: 5,
                background: "var(--bg-selected, rgba(59, 130, 246, 0.1))",
                color: "var(--accent, #3b82f6)",
                flexShrink: 0,
              }}
            >
              <MessageSquarePlus size={13} strokeWidth={2.2} />
            </span>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
              {t("chat.askInCurrent")}
            </span>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label={t("i18n.close")}
            title={t("i18n.close")}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              padding: 4,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 6,
              transition: "color 0.15s, background-color 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--text)";
              e.currentTarget.style.backgroundColor = "rgba(0,0,0,0.06)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--text-muted)";
              e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            <X size={15} />
          </button>
        </div>

        {/* 划选内容预览卡片 */}
        <div
          style={{
            display: "flex",
            gap: 10,
            padding: "10px 12px",
            background: "var(--bg-panel, #f8fafc)",
            border: "1px solid var(--border, #e5e7eb)",
            borderLeft: "3px solid var(--accent, #3b82f6)",
            borderRadius: 8,
            maxHeight: "min(220px, 28vh)",
            overflowY: "auto",
            overflowX: "hidden",
            scrollbarWidth: "thin",
            boxSizing: "border-box",
          }}
          title={t("quote.selection")}
        >
          <div
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 13,
              lineHeight: 1.6,
              color: "var(--text-muted)",
              wordBreak: "break-word",
              whiteSpace: "pre-wrap",
              userSelect: "text",
            }}
          >
            {quoteText}
          </div>
        </div>

        {/* 回复输入区域（输入框 + 底部操作条） */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            border: "1px solid var(--border, #e5e7eb)",
            borderRadius: 8,
            background: "var(--bg, #ffffff)",
            padding: "8px 10px 6px 10px",
            boxSizing: "border-box",
            transition: "border-color 0.15s",
          }}
        >
          <textarea
            ref={textareaRef}
            value={reply}
            onChange={(e) => {
              setReply(e.target.value);
              resizeTextarea();
            }}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              compositionActiveRef.current = true;
            }}
            onBlur={() => {
              compositionEndAtRef.current = getExtensionDialogInputCompositionEndAtOnBlur(
                compositionActiveRef.current,
                compositionEndAtRef.current,
              );
              compositionActiveRef.current = false;
            }}
            onCompositionEnd={() => {
              compositionActiveRef.current = false;
              compositionEndAtRef.current = Date.now();
            }}
            placeholder={placeholder}
            wrap="soft"
            style={{
              width: "100%",
              boxSizing: "border-box",
              border: "none",
              outline: "none",
              background: "transparent",
              color: "var(--text)",
              fontSize: 13,
              lineHeight: 1.6,
              resize: "none",
              minHeight: 90,
              maxHeight: "min(360px, 40vh)",
              padding: "4px 2px",
              fontFamily: "inherit",
              overflowX: "hidden",
              overflowY: "auto",
              scrollbarWidth: "thin",
            }}
          />
          {/* 底部操作条 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 8,
              paddingTop: 6,
              marginTop: 4,
              borderTop: "1px solid var(--border-subtle, rgba(0,0,0,0.06))",
            }}
          >
            <span
              style={{
                fontSize: 11,
                color: "var(--text-dim, #9ca3af)",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <CornerDownLeft size={11} /> {t("quote.keyboardHint")}
            </span>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
              {onDelete && (
                <button
                  type="button"
                  onClick={onDelete}
                  className="quote-delete-button"
                  aria-label={t("quote.delete")}
                  title={t("quote.delete")}
                >
                  <Trash2 size={12} />
                  <span>{t("i18n.delete")}</span>
                </button>
              )}
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={insertNewline}
                aria-label={t("chat.insertNewline")}
                title={t("quote.newlineTitle")}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "5px 8px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text-muted)",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                <CornerDownLeft size={12} />
                <span>{t("chat.insertNewline")}</span>
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={!canSubmit}
                aria-label={t("quote.add")}
                title={canSubmit ? t("quote.addTitle") : t("quote.addDisabledTitle")}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "5px 12px",
                  borderRadius: 6,
                  border: "none",
                  background: canSubmit ? "var(--accent, #3b82f6)" : "var(--bg-panel, rgba(0,0,0,0.05))",
                  color: canSubmit ? "#ffffff" : "var(--text-dim, #9ca3af)",
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: canSubmit ? "pointer" : "not-allowed",
                  transition: "background-color 0.15s, opacity 0.15s",
                }}
              >
                <Plus size={12} strokeWidth={2} />
                <span>{t("quote.add")}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
