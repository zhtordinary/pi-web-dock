"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { CodeBlock } from "./MermaidBlock";

/**
 * A ```svg fence rendered as an isolated preview.
 *
 * Model-authored SVG is untrusted markup. It is never inserted into the page
 * DOM: it becomes an `<img src="data:image/svg+xml,...">`, which browsers render
 * in an isolated document where scripts, event handlers and `foreignObject`
 * have no access to the Reader origin. The source stays available, so the
 * reader can inspect or copy what was actually produced.
 *
 * A streamed fence is still being written; previewing half a document would
 * show a broken or misleading picture, so the source view is used until it
 * completes.
 */

function svgDataUrl(source: string): string {
  // encodeURIComponent keeps the markup readable and avoids base64 growth.
  // Quotes and '#' are the characters that break a data URL or a fragment.
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
}

/** Only a complete, self-contained SVG document is worth previewing. */
function looksLikeCompleteSvg(source: string): boolean {
  const trimmed = source.trim();
  if (!trimmed.startsWith("<svg") || !trimmed.endsWith("</svg>")) return false;
  return true;
}

export function SvgBlock({ code, isStreaming }: { code: string; isStreaming?: boolean }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const previewable = useMemo(() => !isStreaming && looksLikeCompleteSvg(code), [code, isStreaming]);
  const dataUrl = useMemo(() => (previewable ? svgDataUrl(code) : null), [code, previewable]);

  if (!previewable || mode === "source" || !dataUrl) {
    return (
      <div className="svg-block">
        <div className="svg-block-toolbar">
          {previewable && (
            <button type="button" onClick={() => setMode("preview")}>{t("markdown.svgPreview")}</button>
          )}
          <a href={dataUrl ?? undefined} download="image.svg" aria-disabled={dataUrl ? undefined : true}>
            {t("markdown.svgDownload")}
          </a>
        </div>
        <CodeBlock code={code} lang="svg" isStreaming={isStreaming} />
      </div>
    );
  }

  return (
    <div className="svg-block">
      <div className="svg-block-toolbar">
        <button type="button" onClick={() => setMode("source")}>{t("markdown.svgSource")}</button>
        <a href={dataUrl} download="image.svg">{t("markdown.svgDownload")}</a>
      </div>
      <div className="svg-block-preview">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={dataUrl} alt={t("markdown.svgPreviewAlt")} />
      </div>
    </div>
  );
}
