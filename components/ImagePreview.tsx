"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import { startEmbeddedImagePreview, type EmbeddedImagePreviewLifecycle } from "@/lib/embedded-modal";
import { useI18n } from "@/hooks/useI18n";
import { listenForStackedDialogEscape } from "@/lib/stacked-dialog";

const IMAGE_PREVIEW_MIN_ZOOM = 0.5;
const IMAGE_PREVIEW_MAX_ZOOM = 3;
const IMAGE_PREVIEW_WHEEL_STEP = 0.05;
const IMAGE_PREVIEW_WHEEL_INTERVAL_MS = 80;
const IMAGE_PREVIEW_DRAG_SUPPRESS_PX = 4;

export interface ImagePreviewDialogLike {
  open: boolean;
  showModal: () => void;
  close: () => void;
}

export type ImagePreviewPoint = { x: number; y: number };

type Point = ImagePreviewPoint;

type DragState = Point & {
  pointerId: number;
  startX: number;
  startY: number;
};

function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(index, 0), Math.max(length - 1, 0));
}

export function getImagePreviewInitialIndex(src: string, images: string[], initialIndex?: number): number {
  const fromSrc = images.indexOf(src);
  return clampIndex(initialIndex ?? (fromSrc >= 0 ? fromSrc : 0), images.length || 1);
}

export function getImagePreviewNextIndex(index: number, direction: number, length: number): number {
  return clampIndex(index + Math.sign(direction), length);
}

export function clampImagePreviewZoom(zoom: number): number {
  return Math.min(IMAGE_PREVIEW_MAX_ZOOM, Math.max(IMAGE_PREVIEW_MIN_ZOOM, zoom));
}

export function getImagePreviewWheelZoom(zoom: number, deltaY: number): number {
  return clampImagePreviewZoom(zoom + (deltaY < 0 ? IMAGE_PREVIEW_WHEEL_STEP : -IMAGE_PREVIEW_WHEEL_STEP));
}

export function clampImagePreviewPan(point: Point, zoom: number, viewport: { clientWidth: number; clientHeight: number }, image: { offsetWidth: number; offsetHeight: number }): Point {
  if (zoom <= 1) return { x: 0, y: 0 };
  const maxX = Math.max(0, (image.offsetWidth * zoom - viewport.clientWidth) / 2);
  const maxY = Math.max(0, (image.offsetHeight * zoom - viewport.clientHeight) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, point.x)),
    y: Math.min(maxY, Math.max(-maxY, point.y)),
  };
}

export function finishImagePreviewPointerDrag(
  drag: Pick<DragState, "startX" | "startY"> | null,
  clientX: number,
  clientY: number,
): { suppressClick: boolean } {
  if (!drag) return { suppressClick: false };
  return { suppressClick: Math.hypot(clientX - drag.startX, clientY - drag.startY) >= IMAGE_PREVIEW_DRAG_SUPPRESS_PX };
}

export function activateNativeImagePreview(dialog: ImagePreviewDialogLike, focusClose: () => void): void {
  dialog.showModal();
  focusClose();
}

export function deactivateNativeImagePreview(dialog: ImagePreviewDialogLike, restoreTrigger: () => void): void {
  if (dialog.open) dialog.close();
  restoreTrigger();
}

interface ImagePreviewProps {
  src: string;
  alt?: string;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** Images in the same logical group. When present, the native dialog becomes a gallery. */
  images?: string[];
  /** Zero-based index of the trigger image in `images`. */
  initialIndex?: number;
}

export function ImagePreview({ src, alt = "", children, className, style, images, initialIndex }: ImagePreviewProps) {
  const { t } = useI18n();
  const previewLabel = t("chat.previewImage");
  const triggerLabel = alt.trim() ? `${previewLabel}: ${alt}` : previewLabel;
  const gallery = (images?.length ? images : [src]).filter((image): image is string => Boolean(image));
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(() => getImagePreviewInitialIndex(src, gallery, initialIndex));
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const lastWheelAtRef = useRef(0);
  const previewLifecycleRef = useRef<EmbeddedImagePreviewLifecycle | null>(null);

  const currentSrc = gallery[index] ?? src;

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const closePreview = () => {
    previewLifecycleRef.current?.close();
    if (dialogRef.current?.open) dialogRef.current.close();
    setOpen(false);
  };

  useEffect(() => () => previewLifecycleRef.current?.close(), []);

  useEffect(() => {
    if (!open) return;
    if (previewLifecycleRef.current?.embedded) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const trigger = triggerRef.current;

    activateNativeImagePreview(
      dialog,
      () => closeButtonRef.current?.focus({ preventScroll: true }),
    );
    // Native dialog cancel events do not consistently stop document/window
    // listeners. Capture here so an outer slash/global abort cannot see the
    // same Escape; the helper also preserves IME composition.
    const releaseEscape = listenForStackedDialogEscape(document, closePreview);

    return () => {
      releaseEscape();
      deactivateNativeImagePreview(
        dialog,
        () => {
          if (trigger?.isConnected) trigger.focus({ preventScroll: true });
        },
      );
    };
  }, [open]);

  const openPreview = () => {
    const nextIndex = getImagePreviewInitialIndex(src, gallery, initialIndex);
    setIndex(nextIndex);
    resetView();
    previewLifecycleRef.current?.close();
    const trigger = triggerRef.current;
    previewLifecycleRef.current = startEmbeddedImagePreview(
      { src, images: gallery, initialIndex: nextIndex, alt },
      () => setOpen(true),
      () => {
        setOpen(false);
        if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      },
    );
  };

  const goTo = useCallback((next: number) => {
    if (gallery.length <= 1) return;
    const nextIndex = getImagePreviewNextIndex(index, next, gallery.length);
    if (nextIndex === index) return;
    setIndex(nextIndex);
    resetView();
  }, [gallery.length, index, resetView]);

  const changeZoom = (nextZoom: number) => {
    const boundedZoom = clampImagePreviewZoom(nextZoom);
    setZoom(boundedZoom);
    setPan((current) => {
      const viewport = viewportRef.current;
      const image = imageRef.current;
      if (boundedZoom <= 1 || !viewport || !image) return { x: 0, y: 0 };
      return clampImagePreviewPan(current, boundedZoom, viewport, image);
    });
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || zoom <= 1) return;
    const target = event.target as HTMLElement;
    if (target.closest("button")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: pan.x,
      y: pan.y,
    };
    setDragging(true);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const viewport = viewportRef.current;
    const image = imageRef.current;
    const next = {
      x: drag.x + event.clientX - drag.startX,
      y: drag.y + event.clientY - drag.startY,
    };
    setPan(viewport && image ? clampImagePreviewPan(next, zoom, viewport, image) : next);
  };

  const finishPointerDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (finishImagePreviewPointerDrag(drag, event.clientX, event.clientY).suppressClick) {
      suppressClickRef.current = true;
    }
    dragRef.current = null;
    setDragging(false);
  };

  const handleViewportClick = (event: MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (event.target === event.currentTarget) closePreview();
  };

  const buttonStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 36,
    height: 36,
    padding: 0,
    border: "1px solid var(--border)",
    borderRadius: 6,
    background: "var(--bg-panel)",
    color: "var(--text-muted)",
    boxShadow: "0 2px 10px rgba(0,0,0,0.28)",
    cursor: "pointer",
    touchAction: "manipulation",
  };

  const arrowStyle: CSSProperties = {
    ...buttonStyle,
    position: "absolute",
    top: "50%",
    transform: "translateY(-50%)",
    zIndex: 1,
  };

  const handleButtonEnter = (event: MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.style.background = "var(--bg-hover)";
    event.currentTarget.style.color = "var(--text)";
  };

  const handleButtonLeave = (event: MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.style.background = "var(--bg-panel)";
    event.currentTarget.style.color = "var(--text-muted)";
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={className}
        style={{
          display: "block",
          padding: 0,
          border: "none",
          background: "none",
          color: "inherit",
          cursor: "zoom-in",
          ...style,
        }}
        onClick={openPreview}
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={previewLabel}
      >
        {children}
      </button>
      {open && !previewLifecycleRef.current?.embedded && (
        <dialog
          ref={dialogRef}
          className="image-preview-dialog"
          aria-label={triggerLabel}
          onCancel={(event) => {
            event.preventDefault();
            event.stopPropagation();
            closePreview();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closePreview();
            } else if (event.key === "ArrowLeft" && gallery.length > 1) {
              event.preventDefault();
              event.stopPropagation();
              goTo(-1);
            } else if (event.key === "ArrowRight" && gallery.length > 1) {
              event.preventDefault();
              event.stopPropagation();
              goTo(1);
            }
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) closePreview();
          }}
        >
          <div
            style={{ position: "relative", display: "flex", flexDirection: "column", width: "100%", height: "100%", minWidth: 0, minHeight: 0, overflow: "hidden" }}
            onClick={(event) => {
              if (event.target === event.currentTarget) closePreview();
            }}
          >
            <button
              ref={closeButtonRef}
              type="button"
              className="image-preview-close"
              onClick={closePreview}
              aria-label={t("chat.close")}
              title={t("chat.close")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
            <div
              ref={viewportRef}
              onWheel={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const now = Date.now();
                if (now - lastWheelAtRef.current < IMAGE_PREVIEW_WHEEL_INTERVAL_MS) return;
                lastWheelAtRef.current = now;
                changeZoom(getImagePreviewWheelZoom(zoom, event.deltaY));
              }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={finishPointerDrag}
              onPointerCancel={finishPointerDrag}
              onClick={handleViewportClick}
              style={{
                flex: 1,
                minHeight: 0,
                minWidth: 0,
                position: "relative",
                overflow: "hidden",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 24,
                boxSizing: "border-box",
                cursor: zoom > 1 ? (dragging ? "grabbing" : "grab") : "default",
                touchAction: "none",
                userSelect: "none",
                overscrollBehavior: "contain",
              }}
            >
              {gallery.length > 1 && index > 0 && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    goTo(-1);
                  }}
                  aria-label={t("chat.previousImage")}
                  title={t("chat.previousImage")}
                  style={{ ...arrowStyle, left: 14 }}
                  onMouseEnter={handleButtonEnter}
                  onMouseLeave={handleButtonLeave}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                </button>
              )}
              {gallery.length > 1 && index < gallery.length - 1 && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    goTo(1);
                  }}
                  aria-label={t("chat.nextImage")}
                  title={t("chat.nextImage")}
                  style={{ ...arrowStyle, right: 14 }}
                  onMouseEnter={handleButtonEnter}
                  onMouseLeave={handleButtonLeave}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              )}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  pointerEvents: "none",
                  transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`,
                  transition: dragging ? "none" : "transform 0.15s ease-out",
                  willChange: "transform",
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={imageRef}
                  className="image-preview-image"
                  src={currentSrc}
                  alt={alt || previewLabel}
                  draggable={false}
                  onLoad={() => {
                    const viewport = viewportRef.current;
                    const image = imageRef.current;
                    if (viewport && image) setPan((current) => clampImagePreviewPan(current, zoom, viewport, image));
                  }}
                  style={{
                    display: "block",
                    pointerEvents: "auto",
                    maxWidth: "min(90vw, 1200px)",
                    maxHeight: "calc(100dvh - 120px)",
                    objectFit: "contain",
                    transform: `scale(${zoom})`,
                    transformOrigin: "center center",
                    transition: dragging ? "none" : "transform 0.15s ease-out",
                    willChange: "transform",
                  }}
                />
              </div>
            </div>
            <div
              onClick={(event) => event.stopPropagation()}
              style={{
                display: "flex",
                justifyContent: "center",
                gap: 6,
                paddingTop: 0,
                paddingRight: "max(16px, env(safe-area-inset-right))",
                paddingBottom: "max(16px, env(safe-area-inset-bottom))",
                paddingLeft: "max(16px, env(safe-area-inset-left))",
                flexShrink: 0,
                position: "absolute",
                bottom: 0,
                left: 0,
                right: 0,
                zIndex: 2,
              }}
            >
              {gallery.length > 1 && (
                <span
                  aria-live="polite"
                  style={{
                    position: "absolute",
                    left: "max(16px, env(safe-area-inset-left))",
                    top: "50%",
                    transform: "translateY(-50%)",
                    color: "rgba(255,255,255,0.75)",
                    fontSize: 12,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {t("chat.imageCounter", { current: index + 1, total: gallery.length })}
                </span>
              )}
              <button
                type="button"
                onClick={() => changeZoom(zoom - 0.25)}
                disabled={zoom <= IMAGE_PREVIEW_MIN_ZOOM}
                aria-label={t("i18n.zoomOut")}
                title={t("i18n.zoomOut")}
                style={{ ...buttonStyle, opacity: zoom <= IMAGE_PREVIEW_MIN_ZOOM ? 0.45 : 1, cursor: zoom <= IMAGE_PREVIEW_MIN_ZOOM ? "not-allowed" : "pointer" }}
                onMouseEnter={handleButtonEnter}
                onMouseLeave={handleButtonLeave}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => changeZoom(1)}
                aria-label={t("chat.resetImageZoom")}
                title={t("chat.resetImageZoom")}
                style={{ ...buttonStyle, width: 58, fontSize: 12, fontVariantNumeric: "tabular-nums" }}
                onMouseEnter={handleButtonEnter}
                onMouseLeave={handleButtonLeave}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                onClick={() => changeZoom(zoom + 0.25)}
                disabled={zoom >= IMAGE_PREVIEW_MAX_ZOOM}
                aria-label={t("i18n.zoomIn")}
                title={t("i18n.zoomIn")}
                style={{ ...buttonStyle, opacity: zoom >= IMAGE_PREVIEW_MAX_ZOOM ? 0.45 : 1, cursor: zoom >= IMAGE_PREVIEW_MAX_ZOOM ? "not-allowed" : "pointer" }}
                onMouseEnter={handleButtonEnter}
                onMouseLeave={handleButtonLeave}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <line x1="12" y1="5" x2="12" y2="19" />
                </svg>
              </button>
            </div>
          </div>
        </dialog>
      )}
    </>
  );
}
