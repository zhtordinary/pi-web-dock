"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FileViewer, type FileViewerState } from "./FileViewer";
import { useI18n } from "@/hooks/useI18n";
import { notifyEmbeddedModalState } from "@/lib/embedded-modal";
import { getFileName } from "@/lib/file-paths";

export interface FileViewerModalProps {
  filePath: string;
  cwd?: string;
  remotePeer?: string;
  sourceSessionId?: string | null;
  initialPage?: number;
  onOpenInReaderView?: (filePath: string, page?: number, anchor?: string) => void;
  onClose: () => void;
  onMentionLines?: (filePath: string, startLine: number, endLine: number) => void;
  onAtMention?: (filePath: string, isDir: boolean) => void;
}

export function FileViewerModal({
  filePath,
  cwd,
  remotePeer,
  sourceSessionId,
  initialPage,
  onOpenInReaderView,
  onClose,
  onMentionLines,
  onAtMention,
}: FileViewerModalProps) {
  const { t } = useI18n();
  const [history, setHistory] = useState<{ filePath: string; page?: number; anchor?: string; viewerState?: FileViewerState }[]>([{ filePath, page: initialPage }]);
  const [dirty, setDirty] = useState(false);
  const current = history[history.length - 1];
  const canLeave = useCallback(() => !dirty || window.confirm(t("files.unsavedChangesConfirm", { name: getFileName(current.filePath) })), [current.filePath, dirty, t]);
  const close = useCallback(() => { if (canLeave()) onClose(); }, [canLeave, onClose]);

  useEffect(() => {
    setHistory([{ filePath, page: initialPage }]);
    setDirty(false);
  }, [filePath, initialPage, remotePeer, sourceSessionId]);

  useEffect(() => {
    // Embedded iframes must tell the outer shell that a file viewer overlay is
    // open so its sidebar/control chrome can be dimmed or hidden too.
    notifyEmbeddedModalState(true, "file-viewer");
    return () => notifyEmbeddedModalState(false, "file-viewer");
  }, []);

  useEffect(() => {
    const handleGlobalKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
    };
    window.addEventListener("keydown", handleGlobalKey, true);
    return () => window.removeEventListener("keydown", handleGlobalKey, true);
  }, [close]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      data-file-viewer-modal
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0, 0, 0, 0.5)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        style={{
          width: "min(1120px, calc(100vw - 28px))",
          height: "min(88vh, calc(100dvh - 36px))",
          background: "var(--bg, #ffffff)",
          border: "1px solid var(--border, #e5e7eb)",
          borderRadius: 10,
          boxShadow: "0 24px 64px rgba(0, 0, 0, 0.36)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {history.length > 1 && (
          <div style={{ padding: "6px 12px", borderBottom: "1px solid var(--border)" }}>
            <button type="button" className="file-viewer-back-button" aria-label={t("files.back")} title={t("files.back")} onClick={() => {
              if (!canLeave()) return;
              setDirty(false);
              setHistory((previous) => previous.slice(0, -1));
            }}>
              ← {t("files.back")}
            </button>
          </div>
        )}
        <FileViewer
          key={`${history.length}:${current.filePath}:${current.page ?? ""}:${current.anchor ?? ""}`}
          filePath={current.filePath}
          cwd={cwd}
          remotePeer={remotePeer}
          sourceSessionId={sourceSessionId}
          initialPage={current.page}
          initialAnchor={current.anchor}
          initialDisplayMode={current.anchor ? "preview" : undefined}
          initialState={current.viewerState}
          onStateChange={(viewerState) => setHistory((previous) => {
            const index = previous.indexOf(current);
            if (index < 0 || index === previous.length - 1) return previous;
            const next = [...previous];
            const saved = { ...viewerState };
            delete saved.editDraft;
            next[index] = { ...current, anchor: undefined, viewerState: saved };
            return next;
          })}
          onOpenFile={(nextPath, page, anchor) => {
            if (!canLeave()) return;
            setDirty(false);
            setHistory((previous) => [...previous, { filePath: nextPath, page, anchor }]);
          }}
          onDirtyChange={setDirty}
          watchEnabled={true}
          panelOpen={true}
          onMentionLines={onMentionLines}
          onAtMention={onAtMention}
          onOpenInReaderView={onOpenInReaderView ? () => {
            if (canLeave()) onOpenInReaderView(current.filePath, current.page, current.anchor);
          } : undefined}
          onClose={close}
        />
      </div>
    </div>,
    document.body
  );
}
