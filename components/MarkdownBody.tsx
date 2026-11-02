"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type MouseEvent, type ReactNode, type SyntheticEvent } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Maximize2 } from "lucide-react";
import { parsePdfPageFragment, resolveLocalFileHref, shouldOpenLocalFileInApp } from "@/lib/file-links";
import { fileApiPath } from "@/lib/file-api";
import { startEmbeddedImagePreview, type EmbeddedImagePreviewLifecycle } from "@/lib/embedded-modal";
import { useI18n } from "@/hooks/useI18n";
import { isExternalMarkdownHref, markdownDocumentRehypePlugins, markdownRemarkPlugins, markdownUrlTransform, markdownUserRemarkPlugins, markdownLiteralUserRemarkPlugins, normalizeDisplayMath, remarkDedupeImages } from "@/lib/markdown";
import { scrollToMarkdownAnchor } from "@/lib/scroll-to-heading";
import { copyText } from "@/lib/clipboard";
import { imageGenerationCostsForFile, type ImageGenerationCost as ImageCost } from "@/lib/image-generation-cost";
import { isAudioPath, isVideoPath } from "@/lib/file-types";
import { ImageGenerationCost } from "./ImageGenerationCost";
import { ImageLightbox } from "./ImageLightbox";
import { MermaidBlock, CodeBlock } from "./MermaidBlock";
import { SvgBlock } from "./SvgBlock";
import { MarkdownTable } from "./MarkdownTable";

const MarkdownLinkContext = createContext(false);

/**
 * Media extensions that Markdown can only express as an image. Rendering them
 * as a player needs the same authorized file URL, so the decision is made from
 * the resolved local path, never from the raw `src`.
 */
function markdownMediaKind(filePath: string): "audio" | "video" | null {
  if (isAudioPath(filePath)) return "audio";
  if (isVideoPath(filePath)) return "video";
  return null;
}

/**
 * An inline audio/video player for a local media path. The controls own the
 * interaction: a surrounding link would nest them inside an anchor.
 */
function MarkdownMedia({ kind, src, title }: { kind: "audio" | "video"; src: string; title?: string }) {
  const insideLink = useContext(MarkdownLinkContext);
  const style = { display: "block", width: "100%", maxWidth: "100%", margin: "0.5rem 0", borderRadius: 6 } as const;
  if (insideLink) {
    // Nested interactive controls are invalid HTML and steal the click that
    // belongs to the link; keep only the label.
    return <span>{title || src}</span>;
  }
  return kind === "audio"
    ? <audio controls preload="metadata" src={src} title={title} style={style} />
    : <video controls preload="metadata" src={src} title={title} style={style} />;
}

export function getMarkdownImageWidth(naturalWidth: number, naturalHeight: number): "50%" | "100%" {
  return naturalHeight >= naturalWidth ? "50%" : "100%";
}

function MarkdownImage({ src, alt, onLoad, onError, imageCost, ...props }: ComponentProps<"img"> & {
  imageCost?: ReturnType<typeof imageGenerationCostsForFile>;
}) {
  const { t } = useI18n();
  const insideLink = useContext(MarkdownLinkContext);
  const [displayWidth, setDisplayWidth] = useState<"50%" | "100%">("100%");
  const [imageError, setImageError] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewLifecycleRef = useRef<EmbeddedImagePreviewLifecycle | null>(null);
  const previewTriggerRef = useRef<HTMLButtonElement>(null);
  const previewSrc = typeof src === "string" ? src : null;

  useEffect(() => {
    setDisplayWidth("100%");
    setImageError(false);
  }, [src]);

  useEffect(() => () => previewLifecycleRef.current?.close(), []);

  const handleLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    onLoad?.(event);
    const { naturalWidth, naturalHeight } = event.currentTarget;
    if (naturalWidth > 0 && naturalHeight > 0) {
      setDisplayWidth(getMarkdownImageWidth(naturalWidth, naturalHeight));
    }
  };

  const handleError = (event: SyntheticEvent<HTMLImageElement>) => {
    onError?.(event);
    setImageError(true);
  };

  const image = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt ?? ""}
      {...props}
      loading={props.loading ?? "lazy"}
      onLoad={handleLoad}
      onError={handleError}
      style={{
        ...props.style,
        display: "block",
        width: "100%",
        maxWidth: "100%",
        height: "auto",
        margin: 0,
        borderRadius: 6,
      }}
    />
  );

  const costCaption = !insideLink && imageCost && <ImageGenerationCost costs={imageCost.costs} batch={imageCost.batch} image />;
  if (imageError) {
    const imageName = alt?.trim();
    const unavailableLabel = t("chat.imageUnavailable");
    return (
      <>
      <span
        className="markdown-image-unavailable"
        role="img"
        aria-label={imageName ? `${unavailableLabel}: ${imageName}` : unavailableLabel}
        title={imageName || unavailableLabel}
      >
        <span className="markdown-image-unavailable-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <circle cx="8.5" cy="9" r="1.5" />
            <path d="m21 15-4.2-4.2L9 18" />
            <path d="m3 3 18 18" />
          </svg>
        </span>
        <span className="markdown-image-unavailable-content">
          <strong className="markdown-image-unavailable-title">{unavailableLabel}</strong>
          {imageName && <span className="markdown-image-unavailable-name">{imageName}</span>}
          <span className="markdown-image-unavailable-detail">{t("chat.imageUnavailableHint")}</span>
        </span>
      </span>
      {costCaption}
      </>
    );
  }

  // A preview button inside an <a> creates nested interactive controls. Keep
  // the routed image itself, but leave the link as the only interactive owner.
  if (insideLink) return image;

  return (
    <>
      <span
        className="markdown-image-frame"
        style={{ position: "relative", display: "block", width: displayWidth, maxWidth: "100%", margin: "8px 0" }}
      >
        {image}
        {previewSrc && (
          <button
            ref={previewTriggerRef}
            type="button"
            onClick={() => {
              previewLifecycleRef.current?.close();
              const trigger = previewTriggerRef.current;
              previewLifecycleRef.current = startEmbeddedImagePreview(
                { src: previewSrc, alt: alt ?? "" },
                () => setPreviewOpen(true),
                () => {
                  setPreviewOpen(false);
                  if (trigger?.isConnected) trigger.focus({ preventScroll: true });
                },
              );
            }}
            aria-label={t("markdown.zoomImage")}
            title={t("markdown.zoomImage")}
            style={{
              position: "absolute",
              top: 6,
              right: 6,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 24,
              height: 24,
              borderRadius: 4,
              background: "rgba(0, 0, 0, 0.55)",
              color: "#fff",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            <Maximize2 size={13} />
          </button>
        )}
        {costCaption}
      </span>
      {previewSrc && previewOpen && !previewLifecycleRef.current?.embedded && (
        <ImageLightbox src={previewSrc} alt={alt ?? ""} onClose={() => {
          previewLifecycleRef.current?.close();
          setPreviewOpen(false);
        }} />
      )}
    </>
  );
}

function MathDisplay({ source, children }: { source: string; children: ReactNode }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="markdown-math-display">
      {children}
      <button type="button" className="markdown-code-action markdown-math-copy" onClick={() => {
        void copyText(source).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
      }}>{copied ? t("i18n.copied") : t("i18n.copy")}</button>
    </div>
  );
}

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  sessionId?: string;
  remotePeer?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  /** A document reader's own links: relative paths and `#headings` stay in the reader. */
  onNavigateLink?: (href: string) => void;
  dedupeImages?: boolean;
  imageGenerationCosts?: readonly ImageCost[];
  /** Render every user-entered line ending as a visible break. */
  keepLineBreaks?: boolean;
  /** Show user-entered HTML as text rather than interpreting it. */
  literalHtml?: boolean;
}

export function MarkdownBody({ children, className, isStreaming, cwd, sessionId, remotePeer, onOpenFile, onNavigateLink, dedupeImages, imageGenerationCosts, keepLineBreaks, literalHtml }: MarkdownBodyProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(children), [children]);
  const baseRemarkPlugins = literalHtml ? markdownLiteralUserRemarkPlugins : keepLineBreaks ? markdownUserRemarkPlugins : markdownRemarkPlugins;
  const remarkPlugins = useMemo(
    () => dedupeImages ? [...(baseRemarkPlugins ?? []), remarkDedupeImages] : baseRemarkPlugins,
    [baseRemarkPlugins, dedupeImages],
  );

  const components = useMemo<Components>(() => ({
    code({ className, children, ...props }) {
      const match = /language-(\w+)/.exec(className || "");
      const lang = match ? match[1] : undefined;
      const raw = String(children);
      const isBlock = className?.includes("language-") || raw.includes("\n");
      if (isBlock) {
        if (lang === "mermaid") {
          return <MermaidBlock code={raw.replace(/\n$/, "")} isStreaming={isStreaming} defaultPreview />;
        }
        if (lang === "svg") {
          // Never dangerouslySetInnerHTML model SVG: an <img> data URL keeps it
          // out of the page DOM and out of the Reader origin.
          return <SvgBlock code={raw.replace(/\n$/, "")} isStreaming={isStreaming} />;
        }
        return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang ?? ""} isStreaming={isStreaming} />;
      }
      return (
        <code
          className="markdown-inline-code"
          {...props}
        >
          {children}
        </code>
      );
    },
    a({ href, children, node, ...props }) {
      const imageNode = node?.children.length === 1 && node.children[0].type === "element" && node.children[0].tagName === "img"
        ? node.children[0] : undefined;
      const imageHref = typeof imageNode?.properties.src === "string" ? imageNode.properties.src : undefined;
      const imageCost = imageGenerationCostsForFile(imageHref, cwd, imageGenerationCosts ?? []);
      const withImageCost = (link: ReactNode) => imageCost
        ? <span style={{ display: "block" }}>{link}<ImageGenerationCost costs={imageCost.costs} batch={imageCost.batch} image /></span> : link;
      if (onNavigateLink && href && !isExternalMarkdownHref(href)) {
        const navigate = () => onNavigateLink(href);
        return withImageCost(
          <MarkdownLinkContext.Provider value={true}>
            <a
              {...props}
              role="link"
              tabIndex={0}
              className="text-accent underline hover:opacity-80"
              style={{ cursor: "pointer" }}
              onClick={(e) => {
                e.preventDefault();
                navigate();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  navigate();
                }
              }}
            >
              {children}
            </a>
          </MarkdownLinkContext.Provider>
        );
      }
      const page = href ? parsePdfPageFragment(href) : null;
      const filePath = onOpenFile ? resolveLocalFileHref(href, cwd) : null;
      const openFile = onOpenFile;

      if (!filePath || !openFile) {
        const isLocal = href && /^file:/i.test(href);
        const isHashOnly = href && href.startsWith("#");
        return withImageCost(
          <MarkdownLinkContext.Provider value={true}>
            <a
              href={href}
              {...props}
              onClick={isHashOnly ? (event) => {
                if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                scrollToMarkdownAnchor(rootRef.current, href);
              } : undefined}
              target={isLocal || isHashOnly ? undefined : "_blank"}
              rel={isLocal || isHashOnly ? undefined : "noopener noreferrer"}
              className="text-accent underline hover:opacity-80"
            >
              {children}
            </a>
          </MarkdownLinkContext.Provider>
        );
      }

      return withImageCost(
        <MarkdownLinkContext.Provider value={true}>
          <a
            href={href}
            {...props}
            onClick={(e: MouseEvent<HTMLAnchorElement>) => {
              if (!shouldOpenLocalFileInApp(e)) return;
              e.preventDefault();
              openFile(filePath, page ?? undefined);
            }}
          >
            {children}
          </a>
        </MarkdownLinkContext.Provider>
      );
    },
    img({ src, alt, ...props }) {
      delete (props as { node?: unknown }).node;
      const filePath = typeof src === "string" ? resolveLocalFileHref(src, cwd) : null;
      // Markdown has no audio/video syntax, so a local media path is written as
      // an image. Resolve it through the same authorized file API as images so
      // the session reference and peer routing still apply.
      const mediaKind = filePath ? markdownMediaKind(filePath) : null;
      if (filePath && mediaKind) {
        return (
          <MarkdownMedia
            kind={mediaKind}
            src={fileApiPath(filePath, "read", sessionId, remotePeer)}
            title={alt ?? undefined}
          />
        );
      }
      const imageSrc = filePath
        ? fileApiPath(filePath, "read", sessionId, remotePeer)
        : src;
      const imageCost = imageGenerationCostsForFile(typeof src === "string" ? src : undefined, cwd, imageGenerationCosts ?? []);
      return <MarkdownImage src={imageSrc} alt={alt} imageCost={imageCost} {...props} />;
    },
    div({ node, children, ...props }) {
      const source = node?.properties?.dataMathSource;
      if (typeof source === "string") return <MathDisplay source={source}>{children}</MathDisplay>;
      return <div {...props}>{children}</div>;
    },
    table({ children }) {
      return <MarkdownTable>{children}</MarkdownTable>;
    },
  }), [cwd, dedupeImages, imageGenerationCosts, isStreaming, onNavigateLink, onOpenFile, remotePeer, sessionId]);

  return (
    <div ref={rootRef} className={`markdown-body ${className || ""}`}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={markdownDocumentRehypePlugins}
        components={components}
        urlTransform={markdownUrlTransform}
      >
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
}
