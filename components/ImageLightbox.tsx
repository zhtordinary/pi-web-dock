"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { listenForStackedDialogEscape } from "@/lib/stacked-dialog";

const IMAGE_PREVIEW_MIN_ZOOM = 0.5;
const IMAGE_PREVIEW_MAX_ZOOM = 3;
const IMAGE_PREVIEW_WHEEL_STEP = 0.05;
const IMAGE_PREVIEW_WHEEL_INTERVAL_MS = 80;
const IMAGE_PREVIEW_DRAG_SUPPRESS_PX = 4;

type Point = { x: number; y: number };

type DragState = Point & {
  pointerId: number;
  startX: number;
  startY: number;
};

function clampPan(point: Point, zoom: number, viewport: HTMLDivElement, image: HTMLImageElement): Point {
  if (zoom <= 1) return { x: 0, y: 0 };
  const maxX = Math.max(0, (image.offsetWidth * zoom - viewport.clientWidth) / 2);
  const maxY = Math.max(0, (image.offsetHeight * zoom - viewport.clientHeight) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, point.x)),
    y: Math.min(maxY, Math.max(-maxY, point.y)),
  };
}

export function ImageLightbox({
  src,
  onClose,
  images,
  initialIndex,
  alt = "Image preview",
  onReady,
}: {
  src: string;
  onClose: () => void;
  /** 多图画廊：传入时支持左右切换；单图或未传保持原行为 */
  images?: string[];
  initialIndex?: number;
  alt?: string;
  onReady?: () => void;
}) {
  const gallery = images && images.length > 1 ? images : null;
  const [index, setIndex] = useState(() => {
    if (gallery) {
      const fromSrc = gallery.indexOf(src);
      const base = initialIndex ?? (fromSrc >= 0 ? fromSrc : 0);
      return Math.min(gallery.length - 1, Math.max(0, base));
    }
    return 0;
  });
  const currentSrc = gallery ? gallery[index] : src;
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const lastWheelAtRef = useRef(0);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    onReady?.();
  }, [onReady]);

  // This lightbox is a modal above Settings/Chat. Capture Escape at document
  // level so the lower slash handler cannot stop the run or close its panel.
  // Focus is restored to the opener when the lightbox unmounts.
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus({ preventScroll: true });
    const releaseEscape = listenForStackedDialogEscape(document, onClose);
    return () => {
      releaseEscape();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [onClose]);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const goTo = useCallback(
    (next: number) => {
      if (!gallery) return;
      const clamped = Math.min(gallery.length - 1, Math.max(0, next));
      if (clamped === index) return;
      setIndex(clamped);
      resetView();
    },
    [gallery, index, resetView]
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        if (gallery) {
          event.preventDefault();
          goTo(index - 1);
        }
      } else if (event.key === "ArrowRight") {
        if (gallery) {
          event.preventDefault();
          goTo(index + 1);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, gallery, index, goTo]);

  const changeZoom = (nextZoom: number) => {
    const boundedZoom = Math.min(IMAGE_PREVIEW_MAX_ZOOM, Math.max(IMAGE_PREVIEW_MIN_ZOOM, nextZoom));
    setZoom(boundedZoom);
    setPan((current) => {
      const viewport = viewportRef.current;
      const image = imageRef.current;
      if (boundedZoom <= 1 || !viewport || !image) return { x: 0, y: 0 };
      return clampPan(current, boundedZoom, viewport, image);
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
    setPan(viewport && image ? clampPan(next, zoom, viewport, image) : next);
  };

  const finishPointerDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= IMAGE_PREVIEW_DRAG_SUPPRESS_PX) {
      suppressClickRef.current = true;
    }
    dragRef.current = null;
    setDragging(false);
  };

  // 点击图片实体以外的区域关闭；拖拽平移产生的 click 不计入关闭
  const handleViewportClick = (event: MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (event.target === event.currentTarget) onClose();
  };

  // Match official ImagePreview chrome while keeping Reader gallery controls.
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
    transition: "background-color 0.12s, color 0.12s",
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

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1500,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        overscrollBehavior: "none",
        background: "rgba(0,0,0,0.72)",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, height: "100%", overflow: "hidden" }}>
        <div
          data-image-preview-close-controls
          onClick={(event) => {
            event.stopPropagation();
            if (event.target === event.currentTarget) onClose();
          }}
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 6,
            paddingTop: "max(14px, env(safe-area-inset-top))",
            paddingRight: "max(16px, env(safe-area-inset-right))",
            paddingLeft: "max(16px, env(safe-area-inset-left))",
            flexShrink: 0,
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 2,
          }}
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
            ref={closeButtonRef}
            aria-label="Close image preview"
            title="Close"
            style={buttonStyle}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = "var(--bg-hover)";
              event.currentTarget.style.color = "var(--text)";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = "var(--bg-panel)";
              event.currentTarget.style.color = "var(--text-muted)";
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="5" y1="5" x2="19" y2="19" />
              <line x1="19" y1="5" x2="5" y2="19" />
            </svg>
          </button>
        </div>
        <div
          ref={viewportRef}
          onWheel={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const now = Date.now();
            if (now - lastWheelAtRef.current < IMAGE_PREVIEW_WHEEL_INTERVAL_MS) return;
            lastWheelAtRef.current = now;
            changeZoom(zoom + (event.deltaY < 0 ? IMAGE_PREVIEW_WHEEL_STEP : -IMAGE_PREVIEW_WHEEL_STEP));
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
          {gallery && index > 0 && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                goTo(index - 1);
              }}
              aria-label="Previous image"
              title="Previous image"
              style={{ ...arrowStyle, left: 14 }}
              onMouseEnter={handleButtonEnter}
              onMouseLeave={handleButtonLeave}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          )}
          {gallery && index < gallery.length - 1 && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                goTo(index + 1);
              }}
              aria-label="Next image"
              title="Next image"
              style={{ ...arrowStyle, right: 14 }}
              onMouseEnter={handleButtonEnter}
              onMouseLeave={handleButtonLeave}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
              src={currentSrc}
              alt={alt}
              draggable={false}
              style={{
                display: "block",
                pointerEvents: "auto",
                maxWidth: "min(90vw, 1200px)",
                maxHeight: "calc(100vh - 120px)",
                borderRadius: 8,
                boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
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
          data-image-preview-zoom-controls
          onClick={(event) => {
            event.stopPropagation();
            if (event.target === event.currentTarget) onClose();
          }}
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
          {gallery && (
            <span
              style={{
                position: "absolute",
                left: 16,
                top: "50%",
                transform: "translateY(-50%)",
                color: "rgba(255,255,255,0.75)",
                fontSize: 12,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {index + 1} / {gallery.length}
            </span>
          )}
          <button
            type="button"
            onClick={() => changeZoom(zoom - 0.25)}
            disabled={zoom <= IMAGE_PREVIEW_MIN_ZOOM}
            aria-label="Zoom out"
            title="Zoom out"
            style={{ ...buttonStyle, opacity: zoom <= IMAGE_PREVIEW_MIN_ZOOM ? 0.45 : 1, cursor: zoom <= IMAGE_PREVIEW_MIN_ZOOM ? "not-allowed" : "pointer" }}
            onMouseEnter={handleButtonEnter}
            onMouseLeave={handleButtonLeave}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => changeZoom(1)}
            aria-label="Reset zoom"
            title="Reset zoom"
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
            aria-label="Zoom in"
            title="Zoom in"
            style={{ ...buttonStyle, opacity: zoom >= IMAGE_PREVIEW_MAX_ZOOM ? 0.45 : 1, cursor: zoom >= IMAGE_PREVIEW_MAX_ZOOM ? "not-allowed" : "pointer" }}
            onMouseEnter={handleButtonEnter}
            onMouseLeave={handleButtonLeave}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="5" y1="12" x2="19" y2="12" />
              <line x1="12" y1="5" x2="12" y2="19" />
            </svg>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
