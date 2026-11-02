"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { FileViewer } from "./FileViewer";
import { notifyEmbeddedModalState } from "@/lib/embedded-modal";

export interface FileViewerModalProps {
  filePath: string;
  cwd?: string;
  remotePeer?: string;
  sourceSessionId?: string | null;
  initialPage?: number;
  onOpenInReaderView?: () => void;
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
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleGlobalKey);
    return () => window.removeEventListener("keydown", handleGlobalKey);
  }, [onClose]);

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
        if (e.target === e.currentTarget) onClose();
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
        <FileViewer
          filePath={filePath}
          cwd={cwd}
          remotePeer={remotePeer}
          sourceSessionId={sourceSessionId}
          initialPage={initialPage}
          watchEnabled={true}
          panelOpen={true}
          onMentionLines={onMentionLines}
          onAtMention={onAtMention}
          onOpenInReaderView={onOpenInReaderView}
          onClose={onClose}
        />
      </div>
    </div>,
    document.body
  );
}
