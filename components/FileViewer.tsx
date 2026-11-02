"use client";

import Image from "next/image";
import { useEffect, useState, useRef, useCallback, useMemo, type CSSProperties, type MouseEvent, type RefObject, type UIEventHandler } from "react";
import {
  Prism as SyntaxHighlighter,
  createElement as renderSyntaxNode,
  type SyntaxHighlighterProps,
} from "react-syntax-highlighter";
import { vs } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";
import ReactMarkdown, { type Components } from "react-markdown";
import { MarkdownTable } from "./MarkdownTable";
import { useTheme } from "@/hooks/useTheme";
import {
  DOCX_PREVIEW_MAX_BYTES,
  getFileExt,
  isAudioPath,
  isDocumentPreviewPath,
  isImagePath,
  isVideoPath,
} from "@/lib/file-types";
import { TEXT_EDIT_MAX_BYTES } from "@/lib/file-edit-constants";
import { getFileDirectory, getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { fileApiPath, apiPathForPeer, htmlPreviewResourceBase } from "@/lib/file-api";
import { addHtmlPreviewBase } from "@/lib/html-preview";

const openMenuItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  width: "100%",
  minHeight: 30,
  padding: "0 8px",
  border: 0,
  borderRadius: 3,
  background: "transparent",
  color: "var(--text)",
  cursor: "pointer",
  textAlign: "left",
  fontSize: 11,
  whiteSpace: "nowrap",
};
import { parsePdfPageFragment, resolveLocalFileHref } from "@/lib/file-links";
import {
  markdownPreviewRehypePlugins,
  markdownPreviewRemarkPlugins,
  markdownUrlTransform,
  normalizeDisplayMath,
  normalizeMathMarkdown,
} from "@/lib/markdown";
import { parseFrontmatter } from "@/lib/frontmatter";
import { scrollToMarkdownAnchor } from "@/lib/scroll-to-heading";
import { CodeBlock, MermaidBlock } from "./MermaidBlock";
import { FrontmatterCard } from "./FrontmatterCard";
import { MarkdownTocPanel, markdownHasToc } from "./MarkdownToc";
import { SearchReplaceBar } from "./SearchReplaceBar";
import { parseUnifiedPatch } from "@/lib/patch";
import type { GitFileDiffResponse } from "@/lib/git-types";
import { useI18n } from "@/hooks/useI18n";
import {
  resolveInitialFileDisplayMode,
  type FileEditDraft,
  type FileViewerDisplayMode as DisplayMode,
  type FileViewerState,
} from "@/lib/file-viewer-state";

export type { FileViewerState } from "@/lib/file-viewer-state";

interface Props {
  filePath: string;
  cwd?: string;
  remotePeer?: string;
  sourceSessionId?: string | null;
  initialPage?: number;
  onOpenFile?: (filePath: string, page?: number) => void;
  onMentionLines?: (filePath: string, startLine: number, endLine: number) => void;
  /** Insert this file's source path into the chat input (@ mention). */
  onAtMention?: (filePath: string, isDir: boolean) => void;
  gitRefreshKey?: number;
  /** False when the parent right panel is collapsed; hides viewport-fixed chrome. */
  panelOpen?: boolean;
  initialDisplayMode?: DisplayMode;
  initialState?: FileViewerState;
  onStateChange?: (state: FileViewerState) => void;
  onDirtyChange?: (dirty: boolean) => void;
  watchEnabled?: boolean;
  onOpenInReaderView?: () => void;
  onClose?: () => void;
}

interface FileData {
  content: string;
  language: string;
  size: number;
  version: string;
  editable: boolean;
  /** The server found binary content and returned no text to display. */
  binary?: boolean;
}

const SOURCE_HIGHLIGHT_MAX_LINES = 1_000;
const DISPLAY_MODE_LABELS: Record<DisplayMode, string> = {
  source: "Source",
  preview: "Preview",
  diff: "Diff",
};

const FILE_LINE_NUMBER_WIDTH = 48;
const FILE_LINE_NUMBER_HORIZONTAL_PADDING = 10;

const FILE_CODE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  lineHeight: "21px",
};

const FILE_LINE_NUMBER_STYLE: CSSProperties = {
  width: FILE_LINE_NUMBER_WIDTH,
  minWidth: FILE_LINE_NUMBER_WIDTH,
  padding: `0 ${FILE_LINE_NUMBER_HORIZONTAL_PADDING}px`,
  textAlign: "right",
  color: "var(--text-dim)",
  background: "var(--bg-panel)",
  borderRight: "1px solid var(--border)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontStyle: "normal",
  fontVariantNumeric: "tabular-nums",
  lineHeight: "21px",
  userSelect: "none",
  flexShrink: 0,
  verticalAlign: "top",
};

const FILE_PINNED_LINE_NUMBER_STYLE: CSSProperties = {
  ...FILE_LINE_NUMBER_STYLE,
  position: "sticky",
  left: 0,
  zIndex: 1,
};

type SourceCodeRendererProps = Parameters<NonNullable<SyntaxHighlighterProps["renderer"]>>[0] & {
  wrapLines: boolean;
};

interface SelectedLineRange {
  startLine: number;
  endLine: number;
}

function MentionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </svg>
  );
}

function closestSourceLine(node: Node): HTMLElement | null {
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
  return element?.closest<HTMLElement>(".file-source-line[data-line-number]") ?? null;
}

function getSelectedSourceLineRange(root: HTMLElement, selection: Selection | null): SelectedLineRange | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;

  let startElement = closestSourceLine(range.startContainer);
  let endElement = closestSourceLine(range.endContainer);
  if (!startElement || !endElement || !root.contains(startElement) || !root.contains(endElement)) return null;

  let startLine = Number(startElement.dataset.lineNumber);
  let endLine = Number(endElement.dataset.lineNumber);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;

  if (startLine < endLine) {
    // Browser ranges can start at the end of the preceding line or end at the
    // start of the following line. Exclude either boundary line when none of
    // its source text is actually selected.
    const startContent = startElement.querySelector<HTMLElement>(".file-source-line-content");
    if (startContent?.contains(range.startContainer)) {
      const selectedSuffix = document.createRange();
      selectedSuffix.selectNodeContents(startContent);
      selectedSuffix.setStart(range.startContainer, range.startOffset);
      if (selectedSuffix.toString().length === 0) {
        const nextLine = startElement.nextElementSibling;
        if (nextLine instanceof HTMLElement && nextLine.matches(".file-source-line[data-line-number]")) {
          startElement = nextLine;
          startLine = Number(startElement.dataset.lineNumber);
        }
      }
    }

    const endContent = endElement.querySelector<HTMLElement>(".file-source-line-content");
    if (endContent?.contains(range.endContainer)) {
      const selectedPrefix = document.createRange();
      selectedPrefix.selectNodeContents(endContent);
      selectedPrefix.setEnd(range.endContainer, range.endOffset);
      if (selectedPrefix.toString().length === 0) {
        const previousLine = endElement.previousElementSibling;
        if (previousLine instanceof HTMLElement && previousLine.matches(".file-source-line[data-line-number]")) {
          endElement = previousLine;
          endLine = Number(endElement.dataset.lineNumber);
        }
      }
    }
  }

  if (startLine > endLine) return null;
  return { startLine, endLine };
}

function SourceCodeRenderer({ rows, stylesheet, useInlineStyles, wrapLines }: SourceCodeRendererProps) {
  return rows.map((row, lineIndex) => {
    const children = row.children ?? [];
    const firstChildClasses = children[0]?.properties?.className;
    const hasLineNumber = Array.isArray(firstChildClasses)
      && firstChildClasses.includes("react-syntax-highlighter-line-number");
    const lineNumberNode = hasLineNumber ? children[0] : null;
    const contentNodes = hasLineNumber ? children.slice(1) : children;

    return (
      <span
        className="file-source-line"
        data-line-number={lineIndex + 1}
        key={`source-line-${lineIndex}`}
        style={{ display: "flex", minWidth: "100%" }}
      >
        {lineNumberNode && renderSyntaxNode({
          node: lineNumberNode,
          stylesheet,
          useInlineStyles,
          key: `source-line-number-${lineIndex}`,
        })}
        <span
          className="file-source-line-content"
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            overflowWrap: wrapLines ? "anywhere" : "normal",
            whiteSpace: wrapLines ? "pre-wrap" : "pre",
          }}
        >
          {contentNodes.map((node, tokenIndex) => renderSyntaxNode({
            node,
            stylesheet,
            useInlineStyles,
            key: `source-token-${lineIndex}-${tokenIndex}`,
          }))}
        </span>
      </span>
    );
  });
}

function getFileApiUrl(
  filePath: string,
  type: "read" | "download" | "meta" | "preview" | "watch" | "write",
  sourceSessionId?: string | null,
  params: Record<string, string | number | undefined> = {},
  remotePeer?: string,
): string {
  return fileApiPath(filePath, type, sourceSessionId, remotePeer, params);
}

function openAppStorageKey(remotePeer?: string): string {
  return `pi-web-open-app:${remotePeer ?? "local"}`;
}

function DownloadLink({ filePath, sourceSessionId, remotePeer }: { filePath: string; sourceSessionId?: string | null; remotePeer?: string }) {
  const { t } = useI18n();
  return (
    <a
      href={getFileApiUrl(filePath, "download", sourceSessionId, {}, remotePeer)}
      download={getFileName(filePath)}
      title={t("i18n.downloadFile")}
      aria-label={t("i18n.downloadFile")}
      className="file-viewer-icon-button"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </a>
  );
}

type DiffLine = {
  type: "unchanged" | "removed" | "added" | "hunk";
  text: string;
  oldLineNo: number | null;
  newLineNo: number | null;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function countLines(text: string): number {
  let count = 1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count++;
  return count;
}

function diffLines(patch: string): DiffLine[] {
  const files = parseUnifiedPatch(patch);
  if (!files) return [];

  return files.flatMap((file) => file.rows.flatMap((row): DiffLine[] => {
    if (row.type === "hunk") return [{ type: "hunk", text: row.text, oldLineNo: null, newLineNo: null }];
    if (row.left.type === "context" && row.right.type === "context") {
      return [{
        type: "unchanged",
        text: row.right.text,
        oldLineNo: row.left.lineNo,
        newLineNo: row.right.lineNo,
      }];
    }

    const lines: DiffLine[] = [];
    if (row.left.type === "removed") {
      lines.push({
        type: "removed",
        text: row.left.text,
        oldLineNo: row.left.lineNo,
        newLineNo: null,
      });
    }
    if (row.right.type === "added") {
      lines.push({
        type: "added",
        text: row.right.text,
        oldLineNo: null,
        newLineNo: row.right.lineNo,
      });
    }
    return lines;
  }));
}

function DiffView({ patch }: { patch: string }) {
  const { t } = useI18n();
  const diff = diffLines(patch);

  const hasChanges = diff.some((l) => l.type === "added" || l.type === "removed");
  if (!hasChanges) {
    return (
      <div style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
        {t("i18n.noChanges")}
      </div>
    );
  }

  // Render with context: show 3 lines around each change, collapse the rest
  const CONTEXT = 3;
  const changed = new Set(diff.flatMap((l, i) => (l.type === "added" || l.type === "removed" ? [i] : [])));
  const visible = new Set(diff.flatMap((l, i) => l.type === "hunk" ? [i] : []));
  for (const ci of changed) {
    for (let j = Math.max(0, ci - CONTEXT); j <= Math.min(diff.length - 1, ci + CONTEXT); j++) {
      visible.add(j);
    }
  }

  const segments: Array<{ hidden: true; count: number } | { hidden: false; lines: DiffLine[] }> = [];
  let i = 0;
  while (i < diff.length) {
    if (visible.has(i)) {
      const block: DiffLine[] = [];
      while (i < diff.length && visible.has(i)) {
        block.push(diff[i]);
        i++;
      }
      segments.push({ hidden: false, lines: block });
    } else {
      let count = 0;
      while (i < diff.length && !visible.has(i)) {
        count++;
        i++;
      }
      segments.push({ hidden: true, count });
    }
  }

  return (
    <div
      className="file-diff-view"
      style={{
        width: "max-content",
        minWidth: "100%",
        ...FILE_CODE_STYLE,
      }}
    >
      {segments.map((seg, si) => {
        if (seg.hidden) {
          const result = (
            <div
              key={si}
              style={{
                padding: "2px 16px",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                fontSize: 11,
                borderTop: "1px solid var(--border)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              ... {seg.count} unchanged lines ...
            </div>
          );
          return result;
        }
        const lines = seg.lines.map((line, li) => {
          if (line.type === "hunk") {
            return <div key={li} style={{ padding: "2px 16px", color: "var(--text-dim)", background: "var(--bg-panel)", fontSize: 11 }}>{line.text}</div>;
          }
          const bg =
            line.type === "added"
              ? "rgba(0,200,80,0.12)"
              : line.type === "removed"
              ? "rgba(240,60,60,0.14)"
              : "transparent";
          const prefix =
            line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
          const prefixColor =
            line.type === "added" ? "#4ade80" : line.type === "removed" ? "#f87171" : "var(--text-dim)";

          return (
            <div
              key={li}
              className="file-diff-line"
              style={{
                display: "flex",
                minWidth: "100%",
                background: bg,
                borderLeft: line.type === "added"
                  ? "3px solid #4ade80"
                  : line.type === "removed"
                  ? "3px solid #f87171"
                  : "3px solid transparent",
              }}
            >
              <span
                style={FILE_LINE_NUMBER_STYLE}
              >
                {line.type === "removed" ? line.oldLineNo : line.newLineNo}
              </span>
              <span
                style={{
                  minWidth: 16,
                  padding: "0 6px",
                  color: prefixColor,
                  userSelect: "none",
                  flexShrink: 0,
                  fontWeight: 600,
                }}
              >
                {prefix}
              </span>
              <span
                className="file-diff-line-content"
                style={{
                  flexShrink: 0,
                  padding: "0 8px 0 0",
                  whiteSpace: "pre",
                  color: "var(--text)",
                }}
              >
                {line.text || "\u00a0"}
              </span>
            </div>
          );
        });
        return <div key={si}>{lines}</div>;
      })}
    </div>
  );
}

function ImageViewer({ filePath, cwd, remotePeer, sourceSessionId, watchEnabled = true, onOpenInReaderView, onClose }: Props) {
  const { t } = useI18n();
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const syncRequestRef = useRef(0);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    setSize(null);
    setNaturalSize(null);
    setError(null);
    setWatching(false);
  }, [filePath, remotePeer, sourceSessionId]);

  useEffect(() => {
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    if (!watchEnabled) return;

    let active = true;
    const synchronize = () => {
      const requestId = ++syncRequestRef.current;
      fetch(getFileApiUrl(filePath, "meta", sourceSessionId, {}, remotePeer))
        .then((response) => response.json())
        .then((next: { size?: number; error?: string }) => {
          if (!active || requestId !== syncRequestRef.current) return;
          if (next.error) {
            setError(next.error);
            return;
          }
          if (typeof next.size === "number") setSize(next.size);
          setNaturalSize(null);
          setError(null);
          setBust((value) => value + 1);
        })
        .catch((nextError) => {
          if (active && requestId === syncRequestRef.current) setError(String(nextError));
        });
    };

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId, {}, remotePeer));
    esRef.current = es;

    es.addEventListener("connected", () => {
      setWatching(true);
      synchronize();
    });
    es.addEventListener("change", (e) => {
      syncRequestRef.current += 1;
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      setNaturalSize(null);
      setError(null);
      setBust((b) => b + 1);
    });
    const markDisconnected = () => {
      setWatching(false);
    };
    es.addEventListener("error", markDisconnected);
    es.onerror = markDisconnected;

    return () => {
      active = false;
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [filePath, remotePeer, sourceSessionId, watchEnabled]);

  const src = getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined, remotePeer);

  const formatSizeStr = size != null ? formatSize(size) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span style={{ marginLeft: "auto" }}>{ext || "image"}</span>
        {naturalSize && <span>{naturalSize.w} × {naturalSize.h}</span>}
        {formatSizeStr && <span>{formatSizeStr}</span>}
        <span
          title={watching ? t("i18n.liveSync") : t("i18n.notWatching")}
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "#4ade80" : "var(--text-dim)" }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "#4ade80" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? "live" : "static"}
        </span>
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} remotePeer={remotePeer} />
        {onOpenInReaderView && (
          <button
            type="button"
            onClick={onOpenInReaderView}
            title={t("files.openInReaderView")}
            aria-label={t("files.openInReaderView")}
            className="file-viewer-icon-button"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
            </svg>
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title={t("i18n.close")}
            aria-label={t("i18n.close")}
            className="file-viewer-icon-button"
            style={{ marginLeft: 2 }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        )}
      </div>
      <div
        style={{
          flex: 1,
          overflow: "auto",
          background: "var(--bg-panel)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          backgroundImage:
            "linear-gradient(45deg, var(--bg) 25%, transparent 25%), linear-gradient(-45deg, var(--bg) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--bg) 75%), linear-gradient(-45deg, transparent 75%, var(--bg) 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
        }}
      >
        {error ? (
          <div style={{ color: "#f87171", fontSize: 13 }}>{error}</div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={filePath}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            onError={() => setError("Failed to load image")}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
              boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            }}
          />
        )}
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  const totalSeconds = Math.round(seconds);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function AudioViewer({ filePath, cwd, remotePeer, sourceSessionId, watchEnabled = true, onOpenInReaderView, onClose }: Props) {
  const { t } = useI18n();
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const syncRequestRef = useRef(0);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    setSize(null);
    setDuration(null);
    setError(null);
    setWatching(false);
  }, [filePath, remotePeer, sourceSessionId]);

  useEffect(() => {
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    if (!watchEnabled) return;

    let active = true;
    const synchronize = () => {
      const requestId = ++syncRequestRef.current;
      fetch(getFileApiUrl(filePath, "meta", sourceSessionId, {}, remotePeer))
        .then((response) => response.json())
        .then((next: { size?: number; error?: string }) => {
          if (!active || requestId !== syncRequestRef.current) return;
          if (next.error) {
            setError(next.error);
            return;
          }
          if (typeof next.size === "number") setSize(next.size);
          setDuration(null);
          setError(null);
          setBust((value) => value + 1);
        })
        .catch((nextError) => {
          if (active && requestId === syncRequestRef.current) setError(String(nextError));
        });
    };

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId, {}, remotePeer));
    esRef.current = es;

    es.addEventListener("connected", () => {
      setWatching(true);
      synchronize();
    });
    es.addEventListener("change", (e) => {
      syncRequestRef.current += 1;
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      setDuration(null);
      setError(null);
      setBust((b) => b + 1);
    });
    const markDisconnected = () => {
      setWatching(false);
    };
    es.addEventListener("error", markDisconnected);
    es.onerror = markDisconnected;

    return () => {
      active = false;
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [filePath, remotePeer, sourceSessionId, watchEnabled]);

  const src = getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined, remotePeer);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span style={{ marginLeft: "auto" }}>{ext || "audio"}</span>
        {duration != null && <span>{formatDuration(duration)}</span>}
        {size != null && <span>{formatSize(size)}</span>}
        <span
          title={watching ? t("i18n.liveSync") : t("i18n.notWatching")}
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "#4ade80" : "var(--text-dim)" }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "#4ade80" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? "live" : "static"}
        </span>
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} remotePeer={remotePeer} />
        {onOpenInReaderView && (
          <button
            type="button"
            onClick={onOpenInReaderView}
            title={t("files.openInReaderView")}
            aria-label={t("files.openInReaderView")}
            className="file-viewer-icon-button"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
            </svg>
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title={t("i18n.close")}
            aria-label={t("i18n.close")}
            className="file-viewer-icon-button"
            style={{ marginLeft: 2 }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        )}
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "var(--bg-panel)",
        }}
      >
        <div style={{ width: "min(680px, 100%)" }}>
          {error && (
            <div style={{ color: "#f87171", fontSize: 13, marginBottom: 12, textAlign: "center" }}>
              {error}
            </div>
          )}
          <audio
            key={src}
            controls
            preload="metadata"
            src={src}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onError={() => setError("Failed to load audio")}
            style={{ width: "100%" }}
          />
        </div>
      </div>
    </div>
  );
}

function VideoViewer({ filePath, cwd, remotePeer, sourceSessionId, watchEnabled = true, onOpenInReaderView, onClose }: Props) {
  const { t } = useI18n();
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const syncRequestRef = useRef(0);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    setSize(null);
    setDuration(null);
    setError(null);
    setWatching(false);
  }, [filePath, sourceSessionId]);

  useEffect(() => {
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    if (!watchEnabled) return;

    let active = true;
    const synchronize = () => {
      const requestId = ++syncRequestRef.current;
      fetch(getFileApiUrl(filePath, "meta", sourceSessionId, undefined, remotePeer))
        .then((response) => response.json())
        .then((next: { size?: number; error?: string }) => {
          if (!active || requestId !== syncRequestRef.current) return;
          if (next.error) {
            setError(next.error);
            return;
          }
          if (typeof next.size === "number") setSize(next.size);
          setDuration(null);
          setError(null);
          setBust((value) => value + 1);
        })
        .catch((nextError) => {
          if (active && requestId === syncRequestRef.current) setError(String(nextError));
        });
    };

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId, undefined, remotePeer));
    esRef.current = es;

    es.addEventListener("connected", () => {
      setWatching(true);
      synchronize();
    });
    es.addEventListener("change", (e) => {
      syncRequestRef.current += 1;
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      setDuration(null);
      setError(null);
      setBust((b) => b + 1);
    });
    const markDisconnected = () => {
      setWatching(false);
    };
    es.addEventListener("error", markDisconnected);
    es.onerror = markDisconnected;

    return () => {
      active = false;
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [filePath, remotePeer, sourceSessionId, watchEnabled]);

  const src = getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined, remotePeer);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span style={{ marginLeft: "auto" }}>{ext || "video"}</span>
        {duration != null && <span>{formatDuration(duration)}</span>}
        {size != null && <span>{formatSize(size)}</span>}
        <span
          title={watching ? t("i18n.liveSync") : t("i18n.notWatching")}
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "#4ade80" : "var(--text-dim)" }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "#4ade80" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? "live" : "static"}
        </span>
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} remotePeer={remotePeer} />
        {onOpenInReaderView && (
          <button
            type="button"
            onClick={onOpenInReaderView}
            title={t("files.openInReaderView")}
            style={{
              padding: "2px 6px",
              fontSize: 11,
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text-dim)",
              cursor: "pointer",
            }}
          >
            {t("files.readerView")}
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title={t("i18n.close")}
            style={{
              padding: "2px 6px",
              fontSize: 11,
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text-dim)",
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        )}
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "var(--bg-panel)",
          minHeight: 0,
        }}
      >
        <div style={{ width: "min(960px, 100%)", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 0 }}>
          {error && (
            <div style={{ color: "#f87171", fontSize: 13, marginBottom: 12, textAlign: "center" }}>
              {error}
            </div>
          )}
          <video
            key={src}
            controls
            playsInline
            preload="metadata"
            src={src}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onError={() => setError("Failed to load video")}
            style={{ maxWidth: "100%", maxHeight: "100%" }}
          />
        </div>
      </div>
    </div>
  );
}

function DocumentViewer({ filePath, cwd, remotePeer, sourceSessionId, initialPage, watchEnabled = true, onOpenInReaderView, onClose }: Props) {
  const { t } = useI18n();
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const syncRequestRef = useRef(0);

  const ext = getFileExt(filePath);
  const isPdf = ext === "pdf";
  const pageFragment = isPdf && initialPage && initialPage > 0 ? `#page=${initialPage}` : "";
  const previewUrl = isPdf
    ? `${getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined, remotePeer)}${pageFragment}`
    : getFileApiUrl(filePath, "preview", sourceSessionId, bust ? { v: bust } : undefined, remotePeer);

  useEffect(() => {
    setBust(0);
    setSize(null);
    setError(null);
    setWatching(false);

    let active = true;
    const requestId = ++syncRequestRef.current;
    fetch(getFileApiUrl(filePath, "meta", sourceSessionId, {}, remotePeer))
      .then((r) => r.json())
      .then((d: { size?: number; error?: string }) => {
        if (!active || requestId !== syncRequestRef.current) return;
        if (d.error) setError(d.error);
        if (typeof d.size === "number") {
          setSize(d.size);
          if (!isPdf && d.size > DOCX_PREVIEW_MAX_BYTES) {
            setError("DOCX too large for preview (>10MB)");
          }
        }
      })
      .catch((nextError) => {
        if (active && requestId === syncRequestRef.current) setError(String(nextError));
      });

    return () => {
      active = false;
    };
  }, [filePath, isPdf, remotePeer, sourceSessionId]);

  useEffect(() => {
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    if (!watchEnabled) return;

    let active = true;
    const synchronize = () => {
      const requestId = ++syncRequestRef.current;
      fetch(getFileApiUrl(filePath, "meta", sourceSessionId, {}, remotePeer))
        .then((r) => r.json())
        .then((d: { size?: number; error?: string }) => {
          if (!active || requestId !== syncRequestRef.current) return;
          if (d.error) {
            setError(d.error);
            return;
          }
          if (typeof d.size === "number") {
            setSize(d.size);
            if (!isPdf && d.size > DOCX_PREVIEW_MAX_BYTES) {
              setError("DOCX too large for preview (>10MB)");
              return;
            }
          }
          setError(null);
          setBust((value) => value + 1);
        })
        .catch((nextError) => {
          if (active && requestId === syncRequestRef.current) setError(String(nextError));
        });
    };

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId, {}, remotePeer));
    esRef.current = es;

    es.addEventListener("connected", () => {
      setWatching(true);
      synchronize();
    });
    es.addEventListener("change", (e) => {
      syncRequestRef.current += 1;
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") {
          setSize(d.size);
          if (!isPdf && d.size > DOCX_PREVIEW_MAX_BYTES) {
            setError("DOCX too large for preview (>10MB)");
            return;
          }
        }
      } catch { /* ignore */ }
      setError(null);
      setBust((b) => b + 1);
    });
    const markDisconnected = () => {
      setWatching(false);
    };
    es.addEventListener("error", markDisconnected);
    es.onerror = markDisconnected;

    return () => {
      active = false;
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [filePath, isPdf, remotePeer, sourceSessionId, watchEnabled]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span style={{ marginLeft: "auto" }}>{ext === "docx" ? "docx preview" : "pdf"}</span>
        {size != null && <span>{formatSize(size)}</span>}
        {isPdf && (
          <a href={previewUrl} target="_blank" rel="noopener noreferrer" title={t("files.openPdfInNewTab")} aria-label={t("files.openPdfInNewTab")} className="file-viewer-icon-button">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 3h7v7M21 3l-9 9" />
              <path d="M21 14v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h6" />
            </svg>
          </a>
        )}
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} remotePeer={remotePeer} />
        {onOpenInReaderView && (
          <button
            type="button"
            onClick={onOpenInReaderView}
            title={t("files.openInReaderView")}
            aria-label={t("files.openInReaderView")}
            className="file-viewer-icon-button"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
            </svg>
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title={t("i18n.close")}
            aria-label={t("i18n.close")}
            className="file-viewer-icon-button"
            style={{ marginLeft: 2 }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        )}
        <span
          title={watching ? t("i18n.liveSync") : t("i18n.notWatching")}
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "#4ade80" : "var(--text-dim)", flexShrink: 0 }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "#4ade80" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? "live" : "static"}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, background: "var(--bg-panel)" }}>
        {error ? (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, color: "#f87171", fontSize: 13, textAlign: "center" }}>
            {error}
          </div>
        ) : (
          <iframe
            key={previewUrl}
            src={previewUrl}
            sandbox={isPdf ? undefined : "allow-same-origin"}
            title={t("i18n.previewFile", { file: getFileName(filePath) })}
            style={{ width: "100%", height: "100%", border: "none", background: isPdf ? "var(--bg)" : "#eef1f5" }}
          />
        )}
      </div>
    </div>
  );
}

export function FileViewer({ filePath, cwd, remotePeer, sourceSessionId, initialPage, onOpenFile, onMentionLines, onAtMention, gitRefreshKey, panelOpen = true, initialDisplayMode, initialState, onStateChange, onDirtyChange, watchEnabled = true, onOpenInReaderView, onClose }: Props) {
  if (isImagePath(filePath)) {
    return <ImageViewer filePath={filePath} cwd={cwd} remotePeer={remotePeer} sourceSessionId={sourceSessionId} watchEnabled={watchEnabled} onOpenInReaderView={onOpenInReaderView} onClose={onClose} />;
  }
  if (isAudioPath(filePath)) {
    return <AudioViewer filePath={filePath} cwd={cwd} remotePeer={remotePeer} sourceSessionId={sourceSessionId} watchEnabled={watchEnabled} onOpenInReaderView={onOpenInReaderView} onClose={onClose} />;
  }
  if (isVideoPath(filePath)) {
    return <VideoViewer filePath={filePath} cwd={cwd} remotePeer={remotePeer} sourceSessionId={sourceSessionId} watchEnabled={watchEnabled} onOpenInReaderView={onOpenInReaderView} onClose={onClose} />;
  }
  if (isDocumentPreviewPath(filePath)) {
    return <DocumentViewer filePath={filePath} cwd={cwd} remotePeer={remotePeer} sourceSessionId={sourceSessionId} initialPage={initialPage} watchEnabled={watchEnabled} onOpenInReaderView={onOpenInReaderView} onClose={onClose} />;
  }
  return (
    <TextFileViewer
      filePath={filePath}
      cwd={cwd}
      remotePeer={remotePeer}
      sourceSessionId={sourceSessionId}
      onOpenFile={onOpenFile}
      onMentionLines={onMentionLines}
      onAtMention={onAtMention}
      gitRefreshKey={gitRefreshKey}
      panelOpen={panelOpen}
      initialDisplayMode={initialDisplayMode}
      initialState={initialState}
      onStateChange={onStateChange}
      onDirtyChange={onDirtyChange}
      watchEnabled={watchEnabled}
      onOpenInReaderView={onOpenInReaderView}
      onClose={onClose}
    />
  );
}

function TextFileViewer({
  filePath,
  cwd,
  remotePeer,
  sourceSessionId,
  onOpenFile,
  onMentionLines,
  onAtMention,
  gitRefreshKey,
  panelOpen = true,
  initialDisplayMode,
  initialState,
  onStateChange,
  onDirtyChange,
  watchEnabled = true,
  onOpenInReaderView,
  onClose,
}: Props) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchReplaceMode, setSearchReplaceMode] = useState(false);
  const [editText, setEditText] = useState("");
  const { isDark } = useTheme();
  const { t } = useI18n();
  const [data, setData] = useState<FileData | null>(null);
  const [gitDiff, setGitDiff] = useState<GitFileDiffResponse | null>(null);
  const [gitDiffLoading, setGitDiffLoading] = useState(false);
  const [gitDiffResolved, setGitDiffResolved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const displayedEditError = data && !data.editable ? t("files.editUnavailable") : editError;
  const requestedInitialDisplayMode = resolveInitialFileDisplayMode(initialState, initialDisplayMode);
  const initialWrapLines = initialState?.wrapLines ?? true;
  const initialScrollTop = initialState?.scrollTop ?? 0;
  const initialScrollLeft = initialState?.scrollLeft ?? 0;
  const [displayMode, setDisplayMode] = useState<DisplayMode>(requestedInitialDisplayMode);
  const [wrapLines, setWrapLines] = useState(initialWrapLines);
  const [watching, setWatching] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  // 本地打开操作（数据所属设备 = 本服务实例）：用（偏好）应用打开文件 / 在文件管理器中显示。
  const [openBusy, setOpenBusy] = useState<"open" | "reveal" | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [openApps, setOpenApps] = useState<Array<{ id: string; label: string }> | null>(null);
  const [appMenuOpen, setAppMenuOpen] = useState(false);
  const [appSearch, setAppSearch] = useState("");
  const [appMenuView, setAppMenuView] = useState<"list" | "add">("list");
  const [addableApps, setAddableApps] = useState<Array<{ id: string; label: string }> | null>(null);
  const [preferredApp, setPreferredApp] = useState<string | null>(() => {
    try {
      const stored = localStorage.getItem(openAppStorageKey(remotePeer));
      return stored && stored !== "default" ? stored : null;
    } catch {
      return null;
    }
  });

  // 挂载时拉一次本机应用清单（按文件类型过滤，菜单用）；失败不阻塞主按钮。
  useEffect(() => {
    let cancelled = false;
    const fileExt = getFileName(filePath).toLowerCase().split(".").pop() ?? "";
    fetch(apiPathForPeer(remotePeer, `files/open-apps?ext=${encodeURIComponent(fileExt)}`))
      .then((response) => response.json())
      .then((body: { apps?: Array<{ id: string; label: string }> } | null) => {
        if (!cancelled && body?.apps) setOpenApps(body.apps);
      })
      .catch(() => { /* ignore: 菜单为空时仅显示系统默认 */ });
    return () => { cancelled = true; };
  }, [filePath, remotePeer]);

  useEffect(() => {
    if (!appMenuOpen) return;
    const close = (event: Event) => {
      if (event.target instanceof Element && event.target.closest("[data-file-viewer-open-menu]")) return;
      setAppMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [appMenuOpen]);

  const runOpen = useCallback(async (appId: string | null) => {
    if (openBusy) return;
    setOpenBusy("open");
    setOpenError(null);
    setAppMenuOpen(false);
    try {
      const response = await fetch(apiPathForPeer(remotePeer, "files/open"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, app: appId ?? undefined }),
      });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    } catch (cause) {
      setOpenError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpenBusy(null);
    }
  }, [filePath, openBusy, remotePeer]);

  // 主按钮 = 偏好应用（未设 = 系统默认）；下拉菜单可换应用并记住偏好。
  const openWithPreferredApp = useCallback(() => {
    void runOpen(preferredApp);
  }, [preferredApp, runOpen]);

  const chooseOpenApp = useCallback((appId: string | null) => {
    try {
      localStorage.setItem(openAppStorageKey(remotePeer), appId ?? "default");
    } catch { /* ignore */ }
    setPreferredApp(appId);
    void runOpen(appId);
  }, [runOpen, remotePeer]);

  // 「− 减去应用」/「+ 添加应用…」：写本机 open-apps.json（增删后本地清单同步更新）。
  const removeOpenApp = useCallback(async (appId: string) => {
    setOpenBusy("open");
    setOpenError(null);
    try {
      const response = await fetch(apiPathForPeer(remotePeer, "files/open-apps"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", appId }),
      });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      setOpenApps((current) => current?.filter((app) => app.id !== appId) ?? current);
      if (preferredApp === appId) {
        try { localStorage.removeItem(openAppStorageKey(remotePeer)); } catch { /* ignore */ }
        setPreferredApp(null);
      }
    } catch (cause) {
      setOpenError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpenBusy(null);
    }
  }, [preferredApp, remotePeer]);

  const openAddAppView = useCallback(() => {
    setAppMenuView("add");
    setAppSearch("");
    setAddableApps((current) => {
      if (current) return current;
      void fetch(apiPathForPeer(remotePeer, "files/open-apps"))
        .then((response) => response.json())
        .then((body: { apps?: Array<{ id: string; label: string }> } | null) => {
          const allApps = body?.apps;
          if (!allApps) return;
          setOpenApps((shown) => {
            const shownIds = new Set((shown ?? []).map((app) => app.id));
            setAddableApps(allApps.filter((app) => !shownIds.has(app.id)));
            return shown;
          });
        })
        .catch(() => setAddableApps([]));
      return current;
    });
  }, [remotePeer]);

  const addOpenApp = useCallback(async (appId: string) => {
    setOpenBusy("open");
    setOpenError(null);
    try {
      const response = await fetch(apiPathForPeer(remotePeer, "files/open-apps"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add", appId }),
      });
      const body = await response.json().catch(() => null) as { apps?: Array<{ id: string; label: string }>; error?: string } | null;
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      setAddableApps((current) => current?.filter((app) => app.id !== appId) ?? current);
      if (body?.apps) {
        const added = body.apps.find((app) => app.id === appId);
        if (added) setOpenApps((current) => [...(current ?? []), added]);
      }
    } catch (cause) {
      setOpenError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpenBusy(null);
    }
  }, [remotePeer]);

  const revealInFileManager = useCallback(async () => {
    if (openBusy) return;
    setOpenBusy("reveal");
    setOpenError(null);
    try {
      const response = await fetch(apiPathForPeer(remotePeer, "files/reveal"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath }),
      });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    } catch (cause) {
      setOpenError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpenBusy(null);
    }
  }, [filePath, openBusy, remotePeer]);
  const esRef = useRef<EventSource | null>(null);
  const contentRequestRef = useRef(0);
  const gitDiffRequestRef = useRef(0);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const initialEditDraftRef = useRef<FileEditDraft | undefined>(initialState?.editDraft);
  const editDraftRef = useRef<FileEditDraft | undefined>(initialState?.editDraft);
  const editBaselineRef = useRef("");
  const editVersionRef = useRef("");
  const autoDiffAppliedRef = useRef(false);
  const defaultPreviewEligibleRef = useRef(
    initialState === undefined && initialDisplayMode === undefined,
  );
  const scrollRestorePendingRef = useRef(true);
  const viewerStateRef = useRef<FileViewerState>({
    displayMode: requestedInitialDisplayMode,
    wrapLines: initialWrapLines,
    scrollTop: initialScrollTop,
    scrollLeft: initialScrollLeft,
  });
  const onStateChangeRef = useRef(onStateChange);
  const [selectedLineRange, setSelectedLineRange] = useState<SelectedLineRange | null>(null);

  onStateChangeRef.current = onStateChange;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!isEditing) return;
    const textarea = editTextareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.scrollTop = viewerStateRef.current.scrollTop;
    textarea.scrollLeft = viewerStateRef.current.scrollLeft;
  }, [isEditing]);

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  const updateDisplayMode = useCallback((nextDisplayMode: DisplayMode) => {
    viewerStateRef.current.displayMode = nextDisplayMode;
    setDisplayMode(nextDisplayMode);
  }, []);

  const toggleWrapLines = useCallback(() => {
    setWrapLines((current) => {
      const next = !current;
      viewerStateRef.current.wrapLines = next;
      return next;
    });
  }, []);

  useEffect(() => {
    const nextState: FileViewerState = {
      displayMode: requestedInitialDisplayMode,
      wrapLines: initialWrapLines,
      scrollTop: initialScrollTop,
      scrollLeft: initialScrollLeft,
    };

    viewerStateRef.current = nextState;
    scrollRestorePendingRef.current = true;
    autoDiffAppliedRef.current = false;
    setDisplayMode(requestedInitialDisplayMode);
    setWrapLines(initialWrapLines);

    return () => {
      const nextState = { ...viewerStateRef.current };
      if (editDraftRef.current) nextState.editDraft = editDraftRef.current;
      else delete nextState.editDraft;
      onStateChangeRef.current?.(nextState);
    };
  }, [
    filePath,
    remotePeer,
    sourceSessionId,
    requestedInitialDisplayMode,
    initialWrapLines,
    initialScrollTop,
    initialScrollLeft,
  ]);

  const fetchContent = useCallback((filePath: string) => {
    const requestId = ++contentRequestRef.current;
    return fetch(getFileApiUrl(filePath, "read", sourceSessionId, {}, remotePeer))
      .then((r) => r.json())
      .then((d: FileData & { error?: string }) => {
        if (requestId !== contentRequestRef.current) return null;
        if (d.error) {
          setError(d.error);
          return null;
        }
        setError(null);
        setData(d);
        return d;
      })
      .catch((e) => {
        if (requestId !== contentRequestRef.current) return null;
        setError(String(e));
        return null;
      });
  }, [remotePeer, sourceSessionId]);

  const fetchGitDiff = useCallback(async (targetPath: string) => {
    const requestId = ++gitDiffRequestRef.current;
    setGitDiffLoading(true);
    if (!cwd) {
      setGitDiff(null);
      setGitDiffLoading(false);
      setGitDiffResolved(true);
      return;
    }

    try {
      const params = new URLSearchParams({ cwd, path: targetPath });
      const response = await fetch(apiPathForPeer(remotePeer, `git/diff?${params.toString()}`));
      const next = await response.json() as GitFileDiffResponse & { error?: string };
      if (requestId !== gitDiffRequestRef.current) return;
      setGitDiff(response.ok && next.supported && typeof next.patch === "string" ? next : null);
    } catch {
      if (requestId === gitDiffRequestRef.current) setGitDiff(null);
    } finally {
      if (requestId === gitDiffRequestRef.current) {
        setGitDiffLoading(false);
        setGitDiffResolved(true);
      }
    }
  }, [cwd, remotePeer]);

  const beginEditing = useCallback(() => {
    if (!data?.editable || !data.version || data.size > TEXT_EDIT_MAX_BYTES) return;
    editBaselineRef.current = data.content;
    editVersionRef.current = data.version;
    editDraftRef.current = undefined;
    setEditError(null);
    setDirty(false);
    setEditText(data.content);
    setIsEditing(true);
  }, [data]);

  const cancelEditing = useCallback(() => {
    if (isSaving) return;
    editDraftRef.current = undefined;
    setIsEditing(false);
    setDirty(false);
    setEditError(null);
  }, [isSaving]);

  const saveEditing = useCallback(async () => {
    if (!data || isSaving || !dirty) return;
    if (!data.editable) {
      setEditError(t("files.editUnavailable"));
      return;
    }

    const nextContent = editText;
    const byteLength = new TextEncoder().encode(nextContent).byteLength;
    if (byteLength > TEXT_EDIT_MAX_BYTES) {
      setEditError(t("files.editTooLarge"));
      return;
    }

    const version = editVersionRef.current || data.version;
    if (!version) {
      setEditError(t("files.editUnavailable"));
      return;
    }

    setIsSaving(true);
    setEditError(null);
    try {
      const response = await fetch(getFileApiUrl(filePath, "write", sourceSessionId, {}, remotePeer), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: nextContent, version }),
      });
      const body = await response.json().catch(() => null) as {
        error?: unknown;
        size?: unknown;
        version?: unknown;
      } | null;
      if (!response.ok) {
        if (response.status === 409) throw new Error(t("files.editConflict"));
        if (response.status === 413) throw new Error(t("files.editTooLarge"));
        const message = typeof body?.error === "string" ? body.error : `HTTP ${response.status}`;
        throw new Error(message);
      }
      if (typeof body?.version !== "string") throw new Error(t("files.invalidSaveResponse"));

      setData((current) => current
        ? { ...current, content: nextContent, size: typeof body.size === "number" ? body.size : byteLength, version: body.version as string }
        : current);
      editBaselineRef.current = nextContent;
      editVersionRef.current = body.version;
      editDraftRef.current = undefined;
      setDirty(false);
      setIsEditing(false);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }, [data, dirty, editText, filePath, isSaving, remotePeer, sourceSessionId, t]);

  // Reset and load the file itself when its identity changes. Live watching is
  // managed separately so pausing it never clears the displayed content.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setTocOpen(false);
    setIsEditing(false);
    setIsSaving(false);
    setDirty(false);
    setEditError(null);
    setData(null);
    setGitDiff(null);
    setGitDiffResolved(false);
    setWatching(false);
    editDraftRef.current = initialEditDraftRef.current;

    fetchContent(filePath)
      .then((loaded) => {
        const draft = initialEditDraftRef.current;
        if (!active || !loaded || !draft) return;
        editBaselineRef.current = loaded.content;
        editVersionRef.current = draft.version;
        editDraftRef.current = draft;
        setEditText(draft.content);
        setIsEditing(true);
        setDirty(draft.content !== loaded.content);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [filePath, fetchContent, sourceSessionId]);

  useEffect(() => {
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    if (!watchEnabled || isEditing) return;

    const synchronize = () => {
      void fetchContent(filePath);
      void fetchGitDiff(filePath);
    };

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId, {}, remotePeer));
    esRef.current = es;

    es.addEventListener("connected", () => {
      setWatching(true);
      // The server emits connected only after its watcher exists. Reading now
      // closes the gap between the last snapshot and live events.
      synchronize();
    });

    es.addEventListener("change", synchronize);

    const markDisconnected = () => {
      setWatching(false);
    };
    es.addEventListener("error", markDisconnected);
    es.onerror = markDisconnected;

    return () => {
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [filePath, fetchContent, fetchGitDiff, isEditing, remotePeer, sourceSessionId, watchEnabled]);

  useEffect(() => {
    void fetchGitDiff(filePath);
  }, [fetchGitDiff, filePath, gitRefreshKey]);

  useEffect(() => {
    // HTML gets the same rendered-first treatment as markdown: a generated page
    // is usually more useful viewed than read as source. Both have a preview
    // mode already; the source tab stays one click away. A restored choice or
    // explicit mode hint always wins over this default.
    if (
      defaultPreviewEligibleRef.current
      && (data?.language === "markdown" || data?.language === "html")
    ) {
      defaultPreviewEligibleRef.current = false;
      updateDisplayMode("preview");
    }
  }, [data?.language, updateDisplayMode]);

  const hasGitDiff = gitDiff?.supported === true && typeof gitDiff.patch === "string";
  const isDeletedDiff = hasGitDiff && gitDiff.status === "deleted";

  useEffect(() => {
    if (gitDiffResolved && !hasGitDiff && displayMode === "diff") updateDisplayMode("source");
  }, [displayMode, gitDiffResolved, hasGitDiff, updateDisplayMode]);

  // Wait for the git request before restoring diff mode so the unresolved
  // placeholder cannot immediately demote it back to source.
  useEffect(() => {
    if (requestedInitialDisplayMode === "diff" && hasGitDiff && !autoDiffAppliedRef.current) {
      autoDiffAppliedRef.current = true;
      updateDisplayMode("diff");
    }
  }, [requestedInitialDisplayMode, hasGitDiff, updateDisplayMode]);

  const markdownPreview = useMemo(
    () => (!isEditing && data?.language === "markdown"
      ? normalizeMathMarkdown(normalizeDisplayMath(data.content))
      : ""),
    [data, isEditing],
  );
  // buildMarkdownToc is a full document scan; memoize so toggling the TOC or
  // re-rendering does not re-scan the whole file on every render.
  const markdownTocAvailable = useMemo(
    () => !isEditing && markdownHasToc(data?.content ?? ""),
    [data, isEditing],
  );


  const frontmatter = useMemo(
    () => (!isEditing && data?.language === "markdown" ? parseFrontmatter(data.content) : null),
    [data, isEditing],
  );

  const viewerContent = data?.content ?? "";
  const isBinary = data?.binary === true;
  const sourceLines = useMemo(() => (isEditing || isBinary ? [] : viewerContent.split("\n")), [isEditing, isBinary, viewerContent]);
  const language = data?.language ?? "text";
  const isHtml = language === "html";
  const isMarkdown = language === "markdown";
  const hasPreview = !isBinary && (isHtml || isMarkdown);
  const effectiveDisplayMode = isDeletedDiff ? "diff" : isEditing ? "source" : displayMode;
  const lineCount = isEditing ? countLines(viewerContent) : sourceLines.length;
  const useLightweightSource = lineCount > SOURCE_HIGHLIGHT_MAX_LINES
    && !(effectiveDisplayMode === "diff" && hasGitDiff)
    && !(effectiveDisplayMode === "preview" && hasPreview);

  // react-syntax-highlighter rebuilds every token element on each render, which
  // costs hundreds of milliseconds on large files. Cache the rendered trees so
  // unrelated re-renders (panel open/close, selection changes) reuse them as-is.
  const highlightedSource = useMemo(
    () => (
      <SyntaxHighlighter
        className={wrapLines ? "file-source-view is-wrapped" : "file-source-view"}
        language={language === "text" ? "plaintext" : language}
        style={isDark ? vscDarkPlus : vs}
        showLineNumbers
        lineNumberStyle={{
          ...FILE_PINNED_LINE_NUMBER_STYLE,
        }}
        customStyle={{
          margin: 0,
          padding: 0,
          border: 0,
          background: "var(--bg)",
          ...FILE_CODE_STYLE,
          width: wrapLines ? "100%" : "max-content",
          minWidth: "100%",
          minHeight: "100%",
          overflow: "visible",
        }}
        codeTagProps={{
          style: {
            ...FILE_CODE_STYLE,
            overflowWrap: wrapLines ? "anywhere" : "normal",
          },
        }}
        renderer={(rendererProps) => (
          <SourceCodeRenderer {...rendererProps} wrapLines={wrapLines} />
        )}
        wrapLongLines={wrapLines}
      >
        {viewerContent}
      </SyntaxHighlighter>
    ),
    [isDark, language, viewerContent, wrapLines],
  );


  const lightweightSourceLines = useMemo(
    () => (useLightweightSource ? sourceLines.map((line, lineIndex) => (
      <span
        className="file-source-line"
        data-line-number={lineIndex + 1}
        key={`source-line-${lineIndex}`}
        style={{ display: "flex", minWidth: "100%" }}
      >
        <span aria-hidden="true" style={FILE_LINE_NUMBER_STYLE}>
          {lineIndex + 1}
        </span>
        <span
          className="file-source-line-content"
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            overflowWrap: wrapLines ? "anywhere" : "normal",
            whiteSpace: wrapLines ? "pre-wrap" : "pre",
          }}
        >
          {line}
        </span>
      </span>
    )) : null),
    [sourceLines, useLightweightSource, wrapLines],
  );

  useEffect(() => {
    const updateSelectedLineRange = () => {
      const root = contentRef.current;
      setSelectedLineRange((current) => {
        const next = onMentionLines && displayMode === "source" && root
          ? getSelectedSourceLineRange(root, window.getSelection())
          : null;
        // Skip no-op updates: selectionchange fires continuously while dragging,
        // and a fresh-but-equal range object would re-render the whole viewer.
        if (current === null && next === null) return current;
        if (current && next && current.startLine === next.startLine && current.endLine === next.endLine) return current;
        return next;
      });
    };

    updateSelectedLineRange();
    if (!onMentionLines || displayMode !== "source") return;

    document.addEventListener("selectionchange", updateSelectedLineRange);
    return () => document.removeEventListener("selectionchange", updateSelectedLineRange);
  }, [data?.content, displayMode, onMentionLines]);

  const mentionLineRange = useCallback((lineRange: SelectedLineRange | null) => {
    if (!onMentionLines || !lineRange) return;
    onMentionLines(
      filePath,
      lineRange.startLine,
      lineRange.endLine,
    );
  }, [cwd, filePath, onMentionLines]);

  useEffect(() => {
    if (!onMentionLines || displayMode !== "source") return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.key.toLowerCase() !== "i" || (!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey) return;

      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, [contenteditable='true']")) return;

      const root = contentRef.current;
      const lineRange = root ? getSelectedSourceLineRange(root, window.getSelection()) : null;
      if (!lineRange) return;

      event.preventDefault();
      mentionLineRange(lineRange);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [displayMode, mentionLineRange, onMentionLines]);

  useEffect(() => {
    if (!scrollRestorePendingRef.current || loading) return;
    if (error && !isDeletedDiff) return;
    if (requestedInitialDisplayMode === "diff" && !gitDiffResolved) return;
    if (requestedInitialDisplayMode === "diff" && hasGitDiff && displayMode !== "diff") return;

    const content = isEditing ? editTextareaRef.current : contentRef.current;
    if (!content) return;

    content.scrollTop = viewerStateRef.current.scrollTop;
    content.scrollLeft = viewerStateRef.current.scrollLeft;
    scrollRestorePendingRef.current = false;
  }, [
    data?.content,
    displayMode,
    error,
    gitDiffResolved,
    hasGitDiff,
    isDeletedDiff,
    isEditing,
    loading,
    requestedInitialDisplayMode,
  ]);

  if (loading || (requestedInitialDisplayMode === "diff" && gitDiffLoading && !data)) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
        {t("i18n.loading")}
      </div>
    );
  }

  if (error && !isDeletedDiff) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171", fontSize: 13 }}>
        {error}
      </div>
    );
  }

  if (!data && !isDeletedDiff) return null;

  const content = viewerContent;
  const canEdit = Boolean(!isDeletedDiff && displayMode !== "diff" && data?.editable === true && data?.version && (data?.size ?? Infinity) <= TEXT_EDIT_MAX_BYTES);
  const markdownDirectory = getFileDirectory(filePath);
  const displayModes: DisplayMode[] = isDeletedDiff
    ? ["diff"]
    : [
        "source",
        ...(hasPreview ? ["preview" as const] : []),
        ...(hasGitDiff ? ["diff" as const] : []),
      ];
  const metadata = isDeletedDiff
    ? t("files.deleted")
    : `${language} · ${lineCount} lines · ${formatSize(data!.size)}`;

  return (
    <div className="file-viewer-shell" style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        className="file-viewer-toolbar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 12px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <span className="file-viewer-path" style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 1, minWidth: 40 }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>

        <span className="file-viewer-meta" title={metadata}>{metadata}</span>
        {isEditing && dirty && (
          <span className="file-viewer-edit-status" title={t("files.unsavedChanges")}>
            {t("files.unsavedChanges")}
          </span>
        )}
        {!isDeletedDiff && (
          <span
            title={watching ? t("i18n.liveSync") : t("i18n.notWatching")}
            aria-label={watching ? t("i18n.liveSync") : t("i18n.notWatching")}
            className="file-viewer-live-indicator"
            style={{
              background: watching ? "#4ade80" : "var(--border)",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
        )}

        <div className="file-viewer-controls" style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
          {!isEditing && displayModes.length > 1 && (
            <div className="file-viewer-mode-switch" aria-label={t("i18n.fileViewMode")}>
              {displayModes.map((mode) => {
                const active = effectiveDisplayMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => updateDisplayMode(mode)}
                    title={mode === "diff" ? t("i18n.compareHead") : undefined}
                    aria-pressed={active}
                    className="file-viewer-mode-button"
                    style={{
                      background: active ? "var(--bg-selected)" : "transparent",
                      color: active ? "var(--text)" : "var(--text-muted)",
                    }}
                  >
                    {DISPLAY_MODE_LABELS[mode]}
                  </button>
                );
              })}
            </div>
          )}

          {!isEditing && isMarkdown && effectiveDisplayMode === "preview" && markdownTocAvailable && (
            <button
              type="button"
              onClick={() => setTocOpen((value) => !value)}
              title={tocOpen ? t("toc.hide") : t("toc.show")}
              aria-label={t("toc.title")}
              aria-pressed={tocOpen}
              className="file-viewer-icon-button"
              style={{
                background: tocOpen ? "var(--bg-selected)" : "transparent",
                color: tocOpen ? "var(--accent)" : "var(--text-muted)",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" />
                <line x1="3" y1="12" x2="3.01" y2="12" />
                <line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
            </button>
          )}

          <div className="file-viewer-actions">
            {!isEditing && (
              <button
                type="button"
                onClick={() => {
                  setSearchOpen((v) => !v);
                  setSearchReplaceMode(false);
                }}
                title={t("files.searchInFileTitle")}
                aria-label={t("i18n.search")}
                className="file-viewer-icon-button"
                style={{
                  color: searchOpen ? "var(--accent)" : "var(--text-muted)",
                  background: searchOpen ? "var(--bg-selected)" : "transparent",
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </button>
            )}
            {!isDeletedDiff && !isEditing && (
              <>
                {data?.editable && (
                  <button
                    type="button"
                    onClick={beginEditing}
                    disabled={!canEdit}
                    title={canEdit ? t("files.edit") : t("files.editTooLarge")}
                    aria-label={canEdit ? t("files.edit") : t("files.editTooLarge")}
                    className="file-viewer-icon-button"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z" />
                    </svg>
                  </button>
                )}
                <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }} data-file-viewer-open-menu="true">
                  <button
                    type="button"
                    onClick={openWithPreferredApp}
                    disabled={openBusy !== null}
                    title={preferredApp ? t("files.openWithApp", { app: preferredApp }) : t("files.openWithDefaultApp")}
                    aria-label={preferredApp ? t("files.openWithApp", { app: preferredApp }) : t("files.openWithDefaultApp")}
                    className="file-viewer-icon-button"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M15 3h6v6" />
                      <path d="M10 14 21 3" />
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAppMenuOpen((value) => {
                        if (!value) { setAppMenuView("list"); setAppSearch(""); }
                        return !value;
                      });
                    }}
                    disabled={openBusy !== null}
                    title={t("files.chooseOpenApp")}
                    aria-label={t("files.chooseOpenApp")}
                    aria-expanded={appMenuOpen}
                    className="file-viewer-icon-button"
                    style={{ marginLeft: 1 }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>
                  {appMenuOpen && (
                    <div
                      role="menu"
                      style={{
                        position: "absolute",
                        top: "calc(100% + 6px)",
                        right: 0,
                        zIndex: 400,
                        width: 260,
                        maxHeight: 360,
                        display: "flex",
                        flexDirection: "column",
                        padding: 4,
                        border: "1px solid var(--border)",
                        borderRadius: 5,
                        background: "var(--bg-panel)",
                        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
                      }}
                    >
                      <input
                        type="search"
                        value={appSearch}
                        onChange={(event) => setAppSearch(event.target.value)}
                        placeholder={t("files.searchApps")}
                        aria-label={t("files.searchApps")}
                        autoFocus
                        style={{
                          flex: "0 0 auto",
                          margin: "2px 4px 4px",
                          padding: "5px 8px",
                          border: "1px solid var(--border)",
                          borderRadius: 4,
                          background: "var(--bg)",
                          color: "var(--text)",
                          fontSize: 11,
                          outline: "none",
                        }}
                      />
                      {appMenuView === "add" ? (
                        <div style={{ flex: "0 0 auto", overflowY: "auto", maxHeight: 300 }}>
                          <button type="button" role="menuitem" onClick={() => setAppMenuView("list")} style={{ ...openMenuItemStyle, color: "var(--text-dim)" }}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="m15 18-6-6 6-6" />
                            </svg>
                            {t("files.back")}
                          </button>
                          {(addableApps ?? [])
                            .filter((app) => app.label.toLowerCase().includes(appSearch.trim().toLowerCase()))
                            .map((app) => (
                              <button
                                key={app.id}
                                type="button"
                                role="menuitem"
                                onClick={() => void addOpenApp(app.id)}
                                style={{ ...openMenuItemStyle, display: "flex", alignItems: "center", gap: 6 }}
                              >
                                <span style={{ flex: "0 0 auto", width: 16, color: "var(--accent)", textAlign: "center" }}>+</span>
                                <Image unoptimized
                                  src={apiPathForPeer(remotePeer, `files/open-apps/${encodeURIComponent(app.id)}/icon`)}
                                  alt=""
                                  width={16}
                                  height={16}
                                  style={{ flex: "0 0 16px", objectFit: "contain" }}
                                  onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
                                />
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{app.label}</span>
                              </button>
                            ))}
                          {addableApps !== null && addableApps.filter((app) => app.label.toLowerCase().includes(appSearch.trim().toLowerCase())).length === 0 && (
                            <div style={{ padding: "6px 8px", color: "var(--text-muted)", fontSize: 10 }}>{t("files.noMatchingApps")}</div>
                          )}
                          {addableApps === null && (
                            <div style={{ padding: "6px 8px", color: "var(--text-muted)", fontSize: 10 }}>{t("files.appListUnavailable")}</div>
                          )}
                        </div>
                      ) : (
                      <div style={{ flex: "0 0 auto", overflowY: "auto", maxHeight: 300 }}>
                        <button type="button" role="menuitem" onClick={() => chooseOpenApp(null)} style={openMenuItemStyle}>
                          <span style={{ flex: "0 0 auto", width: 16, color: preferredApp === null ? "var(--accent)" : "transparent", textAlign: "center" }}>✓</span>
                          <span style={{ flex: "0 0 auto", width: 16 }} aria-hidden="true" />
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("files.openWithDefaultApp")}</span>
                        </button>
                        {(openApps ?? [])
                          .filter((app) => app.label.toLowerCase().includes(appSearch.trim().toLowerCase()))
                          .map((app) => (
                            <div
                              key={app.id}
                              style={{ display: "flex", alignItems: "center", gap: 6 }}
                            >
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => chooseOpenApp(app.id)}
                                style={{ ...openMenuItemStyle, flex: "1 1 auto", minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}
                              >
                                <span style={{ flex: "0 0 auto", width: 16, color: preferredApp === app.id ? "var(--accent)" : "transparent", textAlign: "center" }}>✓</span>
                                <Image unoptimized
                                  src={apiPathForPeer(remotePeer, `files/open-apps/${encodeURIComponent(app.id)}/icon`)}
                                  alt=""
                                  width={16}
                                  height={16}
                                  style={{ flex: "0 0 16px", objectFit: "contain" }}
                                  onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
                                />
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{app.label}</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => void removeOpenApp(app.id)}
                                title={t("files.removeApp")}
                                aria-label={t("files.removeApp")}
                                style={{ flex: "0 0 auto", width: 22, height: 22, padding: 0, border: 0, borderRadius: 3, background: "transparent", color: "var(--text-dim)", cursor: "pointer", fontSize: 13, lineHeight: 1 }}
                              >
                                −
                              </button>
                            </div>
                          ))}
                        {openApps !== null && openApps.filter((app) => app.label.toLowerCase().includes(appSearch.trim().toLowerCase())).length === 0 && (
                          <div style={{ padding: "6px 8px", color: "var(--text-muted)", fontSize: 10 }}>{t("files.noMatchingApps")}</div>
                        )}
                        {openApps === null && (
                          <div style={{ padding: "6px 8px", color: "var(--text-muted)", fontSize: 10 }}>{t("files.appListUnavailable")}</div>
                        )}
                        <button type="button" role="menuitem" onClick={openAddAppView} style={{ ...openMenuItemStyle, marginTop: 2, borderTop: "1px solid var(--border)", borderRadius: 0, color: "var(--text-muted)" }}>
                          <span style={{ flex: "0 0 auto", width: 16, color: "var(--accent)", textAlign: "center" }}>+</span>
                          <span style={{ flex: "0 0 auto", width: 16 }} aria-hidden="true" />
                          <span>{t("files.addApp")}</span>
                        </button>
                      </div>
                      )}
                    </div>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => void revealInFileManager()}
                  disabled={openBusy !== null}
                  title={t("files.openInFolder")}
                  aria-label={t("files.openInFolder")}
                  className="file-viewer-icon-button"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 10.5 12 3l9 7.5" />
                    <path d="M5 9.5V21h14V9.5" />
                    <path d="M9 21v-6h6v6" />
                  </svg>
                </button>
                {openError && (
                  <span role="alert" title={openError} style={{ color: "#dc2626", fontSize: 10, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {openError}
                  </span>
                )}
              </>
            )}
            {isEditing && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setSearchOpen((v) => !v);
                    setSearchReplaceMode(false);
                  }}
                  title={t("files.searchReplaceTitle")}
                  aria-label={t("files.searchReplace")}
                  className="file-viewer-icon-button"
                  style={{ color: searchOpen ? "var(--accent)" : "var(--text-muted)" }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => void saveEditing()}
                  disabled={!dirty || isSaving || !data?.editable}
                  title={t("files.save")}
                  aria-label={t("files.save")}
                  className="file-viewer-icon-button"
                  style={{ color: dirty && !isSaving && data?.editable ? "var(--accent)" : "var(--text-muted)" }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 3h12l2 2v16H5z" />
                    <path d="M8 3v6h8V3" />
                    <path d="M8 21v-6h8v6" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={cancelEditing}
                  disabled={isSaving}
                  title={t("files.cancelEdit")}
                  aria-label={t("files.cancelEdit")}
                  className="file-viewer-icon-button"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                </button>
                {displayedEditError && (
                  <span role="alert" title={displayedEditError} style={{ color: "#dc2626", fontSize: 10, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {displayedEditError}
                  </span>
                )}
              </>
            )}
            {!isEditing && (onAtMention || onMentionLines) && (
              <button
                type="button"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  // Mention selected lines when a range is active (and line
                  // mention is wired up); otherwise fall back to a whole-file
                  // @mention. Same button, behavior follows the selection.
                  if (selectedLineRange && onMentionLines) {
                    mentionLineRange(selectedLineRange);
                  } else {
                    onAtMention?.(filePath, false);
                  }
                }}
                title={
                  selectedLineRange && onMentionLines
                    ? `${t("i18n.mentionSelectedLines")} (L${selectedLineRange.startLine}${selectedLineRange.startLine !== selectedLineRange.endLine ? `-L${selectedLineRange.endLine}` : ""})`
                    : t("files.insertPath")
                }
                aria-label={t("files.mention")}
                disabled={!onAtMention && !onMentionLines}
                className="file-viewer-icon-button"
              >
                <MentionIcon />
              </button>
            )}
            {(isEditing || (!isEditing && effectiveDisplayMode === "source")) && (
              <button
                type="button"
                onClick={toggleWrapLines}
                title={wrapLines ? t("i18n.disableWrap") : t("i18n.enableWrap")}
                aria-label={wrapLines ? t("i18n.disableWrap") : t("i18n.enableWrap")}
                aria-pressed={wrapLines}
                className="file-viewer-icon-button"
                style={{
                  background: wrapLines ? "var(--bg-selected)" : "transparent",
                  color: wrapLines ? "var(--text)" : "var(--text-muted)",
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 6h18" />
                  <path d="M3 12h15a3 3 0 1 1 0 6h-4" />
                  <path d="m16 16-2 2 2 2" />
                  <path d="M3 18h7" />
                </svg>
              </button>
            )}
          </div>

          {!isDeletedDiff && <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} remotePeer={remotePeer} />}
          {onOpenInReaderView && (
            <button
              type="button"
              onClick={onOpenInReaderView}
              title={t("files.openInReaderView")}
              aria-label={t("files.openInReaderView")}
              className="file-viewer-icon-button"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
              </svg>
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title={t("i18n.close")}
              aria-label={t("i18n.close")}
              className="file-viewer-icon-button"
              style={{ marginLeft: 2 }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {panelOpen && (
        <SearchReplaceBar
          isOpen={searchOpen}
          initialShowReplace={isEditing && searchReplaceMode}
          onClose={() => setSearchOpen(false)}
          text={isEditing ? editText : content}
          onTextChange={isEditing ? (nextText) => {
            const nextDirty = nextText !== editBaselineRef.current;
            editDraftRef.current = nextDirty ? { content: nextText, version: editVersionRef.current } : undefined;
            setDirty(nextDirty);
            setEditText(nextText);
          } : undefined}
          textareaRef={isEditing ? editTextareaRef : undefined}
          contentContainerRef={contentRef}
          containerKind={!isEditing && effectiveDisplayMode === "preview" ? "markdown" : "source"}
          topOffset={40}
        />
      )}

      {/* Content area */}

      <div
        ref={isMarkdown && effectiveDisplayMode === "preview" ? undefined : contentRef}
        className="file-viewer-content"
        onScroll={(event) => {
          viewerStateRef.current.scrollTop = event.currentTarget.scrollTop;
          viewerStateRef.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
        style={{ flex: 1, overflow: isMarkdown && effectiveDisplayMode === "preview" ? "hidden" : "auto", background: "var(--bg)", minHeight: 0 }}
      >
        {isEditing ? (
          <div style={{ width: "100%", height: "100%", overflow: "hidden", background: "var(--bg)" }}>
            <textarea
              ref={editTextareaRef}
              value={editText}
              onChange={(event) => {
                const value = event.currentTarget.value;
                const nextDirty = value !== editBaselineRef.current;
                editDraftRef.current = nextDirty
                  ? { content: value, version: editVersionRef.current }
                  : undefined;
                setDirty(nextDirty);
                setEditText(value);
              }}
              onScroll={(event) => {
                viewerStateRef.current.scrollTop = event.currentTarget.scrollTop;
                viewerStateRef.current.scrollLeft = event.currentTarget.scrollLeft;
              }}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
                  event.preventDefault();
                  setSearchOpen(true);
                  setSearchReplaceMode(false);
                }
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "h") {
                  event.preventDefault();
                  setSearchOpen(true);
                  setSearchReplaceMode(true);
                }
                if (event.key === "Tab") {
                  event.preventDefault();
                  const target = event.currentTarget;
                  const start = target.selectionStart;
                  const end = target.selectionEnd;
                  const inserted = "  ";
                  const nextValue = target.value.substring(0, start) + inserted + target.value.substring(end);
                  const nextDirty = nextValue !== editBaselineRef.current;
                  editDraftRef.current = nextDirty
                    ? { content: nextValue, version: editVersionRef.current }
                    : undefined;
                  setDirty(nextDirty);
                  setEditText(nextValue);
                  requestAnimationFrame(() => {
                    target.selectionStart = target.selectionEnd = start + inserted.length;
                  });
                }
              }}
              disabled={isSaving}
              spellCheck={false}
              aria-label={getRelativeFilePath(filePath, cwd)}
              className="file-editor-input"
              style={{
                display: "block",
                width: "100%",
                height: "100%",
                boxSizing: "border-box",
                padding: "0 16px 16px",
                border: 0,
                outline: "none",
                resize: "none",
                overflow: "auto",
                background: "var(--bg)",
                color: "var(--text)",
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                lineHeight: "21px",
                whiteSpace: wrapLines ? "pre-wrap" : "pre",
                overflowWrap: wrapLines ? "anywhere" : "normal",
                caretColor: "var(--accent)",
              }}
            />
          </div>
        ) : effectiveDisplayMode === "diff" && hasGitDiff ? (
          <DiffView patch={gitDiff.patch!} />
        ) : isHtml && effectiveDisplayMode === "preview" ? (
          <iframe
            key={`${filePath}:${data?.version ?? ""}`}
            srcDoc={addHtmlPreviewBase(content, htmlPreviewResourceBase(filePath, sourceSessionId, remotePeer))}
            sandbox="allow-scripts allow-popups"
            style={{ width: "100%", height: "100%", border: "none", background: "var(--bg)" }}
             title={t("i18n.htmlPreview")}
          />
        ) : isMarkdown && effectiveDisplayMode === "preview" ? (
          <MarkdownPreviewWithToc
            content={markdownPreview || content}
            frontmatterData={frontmatter?.data ?? null}
            markdownDirectory={markdownDirectory}
            cwd={cwd}
            sourceSessionId={sourceSessionId}
            remotePeer={remotePeer}
            onOpenFile={onOpenFile}
            scrollRef={contentRef}
            onScroll={(event) => {
              viewerStateRef.current.scrollTop = event.currentTarget.scrollTop;
              viewerStateRef.current.scrollLeft = event.currentTarget.scrollLeft;
            }}
            tocOpen={tocOpen}
          />
        ) : isBinary ? (
          <div
            className="file-viewer-binary"
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              padding: 24,
              color: "var(--text-muted)",
              fontSize: 13,
              textAlign: "center",
            }}
          >
            <span>{t("files.binaryPreview")}</span>
            <a
              href={getFileApiUrl(filePath, "download", sourceSessionId, {}, remotePeer)}
              download={getFileName(filePath)}
              className="file-viewer-binary-download"
              style={{ color: "var(--accent)", textDecoration: "underline" }}
            >
              {t("i18n.downloadFile")}
            </a>
          </div>
        ) : useLightweightSource ? (
          <div
            className="file-source-view is-lightweight"
            style={{
              width: wrapLines ? "100%" : "max-content",
              minWidth: "100%",
              minHeight: "100%",
              background: "var(--bg)",
              ...FILE_CODE_STYLE,
            }}
          >
            {lightweightSourceLines}
          </div>
        ) : (
          highlightedSource
        )}
      </div>
    </div>
  );
}

function MarkdownPreviewWithToc({
  content,
  frontmatterData,
  markdownDirectory,
  cwd,
  sourceSessionId,
  remotePeer,
  onOpenFile,
  scrollRef,
  onScroll,
  tocOpen,
}: {
  content: string;
  frontmatterData: Record<string, unknown> | null;
  markdownDirectory: string;
  cwd?: string;
  sourceSessionId?: string | null;
  remotePeer?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: UIEventHandler<HTMLDivElement>;
  tocOpen: boolean;
}) {
  // Caller (FileViewer) passes fully normalized markdown
  // (normalizeMathMarkdown over normalizeDisplayMath); no second scan here.
  const normalized = content;

  const markdownComponents = useMemo<Components>(() => ({
    code({ className, children, ...props }) {
      const lang = className?.replace("language-", "").toLowerCase() ?? "";
      const raw = String(children);
      const isBlock = className?.includes("language-") || raw.includes("\n");
      if (isBlock) {
        if (lang === "mermaid") {
          return <MermaidBlock code={raw.replace(/\n$/, "")} defaultPreview />;
        }
        return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} wrapLines={false} />;
      }
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
    pre({ children }) {
      // Render the code block directly — CodeBlock provides its own wrapping.
      return <>{children}</>;
    },
    a({ href, children, ...props }) {
      delete props.node;
      if (href?.startsWith("#")) {
        return <a href={href} {...props} onClick={(event) => {
          if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          scrollToMarkdownAnchor(scrollRef.current, href);
        }}>{children}</a>;
      }
      const linkedFile = onOpenFile
        ? resolveLocalFileHref(href, markdownDirectory, cwd ?? markdownDirectory)
        : null;
      if (!linkedFile || !onOpenFile) {
        return <a href={href} {...props}>{children}</a>;
      }
      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onOpenFile(linkedFile, parsePdfPageFragment(href) ?? undefined);
      };
      return <a href={href} {...props} onClick={handleClick}>{children}</a>;
    },
    img({ src, alt, ...props }) {
      const source = typeof src === "string" ? src : "";
      if (!source || /^(https?:|data:|blob:|\/api\/)/i.test(source)) {
        // eslint-disable-next-line @next/next/no-img-element
        return <img src={source} alt={alt ?? ""} style={{ maxWidth: "100%", height: "auto" }} {...props} />;
      }
      const filePath =
        resolveLocalFileHref(source, markdownDirectory, cwd ?? markdownDirectory)
        ?? resolveLocalFileHref(source, markdownDirectory, markdownDirectory);
      const resolved = filePath
        ? getFileApiUrl(filePath, "read", sourceSessionId, {}, remotePeer)
        : source;
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={resolved} alt={alt ?? ""} style={{ maxWidth: "100%", height: "auto" }} {...props} />;
    },
    table({ children }) {
      return <MarkdownTable>{children}</MarkdownTable>;
    },
  }), [cwd, markdownDirectory, onOpenFile, remotePeer, scrollRef, sourceSessionId]);

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0, width: "100%" }}>
      <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
        <div className="markdown-body markdown-file-preview" style={{ padding: "24px 32px" }}>
          {frontmatterData && <FrontmatterCard data={frontmatterData} />}
          <ReactMarkdown
            key={normalized}
            remarkPlugins={markdownPreviewRemarkPlugins}
            rehypePlugins={markdownPreviewRehypePlugins}
            urlTransform={markdownUrlTransform}
            components={markdownComponents}
          >
            {normalized}
          </ReactMarkdown>
        </div>
      </div>
      {tocOpen && <MarkdownTocPanel source={normalized} scrollRootRef={scrollRef} />}
    </div>
  );
}
