import type { CustomPromptEditValue } from "./custom-prompt-types.ts";

export const EMBEDDED_MODAL_STATE_EVENT = "pi-web-embedded-modal-state";
export const EMBEDDED_SIDEKICK_DISMISS_EVENT = "pi-web-sidekick-dismiss";

export type EmbeddedModalKind = "config" | "talk-map" | "file-viewer" | "image-preview" | "sidekick" | "slash-detail";

export const EMBEDDED_SLASH_DETAILS_EVENT = "pi-web-embedded-slash-details";
export const EMBEDDED_SLASH_DETAILS_CLOSE_EVENT = "pi-web-embedded-slash-details-close";

export const EMBEDDED_QUOTE_ANNOTATION_EVENT = "pi-web:embedded-quote-annotation";
export const EMBEDDED_QUOTE_ANNOTATION_RESULT_EVENT = "pi-web:embedded-quote-annotation-result";
export const EMBEDDED_QUOTE_ANNOTATION_CLOSE_EVENT = "pi-web:embedded-quote-annotation-close";
export const EMBEDDED_QUOTE_ANNOTATION_DELETE_EVENT = "pi-web:embedded-quote-annotation-delete";

export interface EmbeddedQuoteAnnotationState {
  canDelete?: boolean;
  open: boolean;
  requestId: number;
  quoteText: string;
  initialReply?: string;
  targetName?: string;
}

/** Serializable presentation state for a slash-command detail modal. */
export interface EmbeddedSlashDetailsState {
  open: boolean;
  requestId: number;
  label?: string;
  content?: string;
  loading?: boolean;
  error?: string | null;
  sourcePath?: string;
  cwd?: string;
  sessionId?: string;
  editablePrompt?: CustomPromptEditValue;
}

export function notifyEmbeddedModalState(open: boolean, kind: EmbeddedModalKind = "config"): void {
  if (typeof window === "undefined" || window.parent === window) return;
  window.parent.postMessage({ type: EMBEDDED_MODAL_STATE_EVENT, open, kind }, "*");
}

export function prepareEmbeddedModal(kind: Exclude<EmbeddedModalKind, "image-preview"> = "config"): void {
  if (typeof window === "undefined" || window.parent === window) return;
  window.parent.postMessage({ type: EMBEDDED_MODAL_STATE_EVENT, open: true, kind, phase: "prepare" }, "*");
}

export const EMBEDDED_IMAGE_PREVIEW_EVENT = "pi-web-embedded-image-preview";
export const EMBEDDED_IMAGE_PREVIEW_ACK_EVENT = "pi-web-embedded-image-preview-ack";
export const EMBEDDED_IMAGE_PREVIEW_CLOSE_EVENT = "pi-web-embedded-image-preview-close";
export const EMBEDDED_IMAGE_PREVIEW_MAX_IMAGES = 32;
export const EMBEDDED_IMAGE_PREVIEW_MAX_SOURCE_LENGTH = 14 * 1024 * 1024;
export const EMBEDDED_IMAGE_PREVIEW_MAX_TOTAL_LENGTH = 128 * 1024 * 1024;
export const EMBEDDED_IMAGE_PREVIEW_MAX_ALT_LENGTH = 1024;

export interface EmbeddedImagePreviewView {
  src: string;
  images?: string[];
  initialIndex?: number;
  alt?: string;
}

export interface EmbeddedImagePreviewState extends EmbeddedImagePreviewView {
  documentId: string;
  requestId: number;
  phase: "prepare" | "ready" | "closed";
}

/** A closed request retains its identity so delayed messages cannot reopen it. */
export function reduceEmbeddedImagePreview(
  current: EmbeddedImagePreviewState | null,
  message: unknown,
): EmbeddedImagePreviewState | null {
  if (!message || typeof message !== "object") return current;
  const data = message as Record<string, unknown>;
  if (data.type !== EMBEDDED_IMAGE_PREVIEW_EVENT || !Number.isSafeInteger(data.requestId) || Number(data.requestId) <= 0) return current;
  if (typeof data.documentId !== "string" || !/^[a-f0-9]{32}$/.test(data.documentId)) return current;
  if (current && current.documentId !== data.documentId) return current;
  const requestId = data.requestId as number;
  if (data.phase === "prepare") {
    if (current && requestId <= current.requestId) return current;
    const validSource = (value: unknown): value is string => typeof value === "string"
      && value.length <= EMBEDDED_IMAGE_PREVIEW_MAX_SOURCE_LENGTH
      && /^(?:https?:\/\/|data:image\/|blob:)/i.test(value);
    if (!validSource(data.src)) return current;
    if (data.images !== undefined && (
      !Array.isArray(data.images) || !data.images.length
      || data.images.length > EMBEDDED_IMAGE_PREVIEW_MAX_IMAGES || !data.images.every(validSource)
      || data.images.reduce((length, src) => length + src.length, data.src.length) > EMBEDDED_IMAGE_PREVIEW_MAX_TOTAL_LENGTH
    )) return current;
    if (data.initialIndex !== undefined && (!Number.isSafeInteger(data.initialIndex) || Number(data.initialIndex) < 0)) return current;
    return {
      documentId: data.documentId,
      requestId,
      phase: "prepare",
      src: data.src,
      ...(Array.isArray(data.images) ? { images: data.images as string[] } : {}),
      ...(typeof data.initialIndex === "number" ? { initialIndex: data.initialIndex } : {}),
      ...(typeof data.alt === "string" ? { alt: data.alt.slice(0, EMBEDDED_IMAGE_PREVIEW_MAX_ALT_LENGTH) } : {}),
    };
  }
  if (!current || current.requestId !== requestId || current.phase === "closed") return current;
  if (data.phase === "ready" && current.phase === "prepare") return { ...current, phase: "ready" };
  if (data.phase === "closed") return { ...current, phase: "closed" };
  return current;
}

export interface EmbeddedImagePreviewLifecycle {
  documentId: string;
  embedded: boolean;
  requestId: number;
  close: () => void;
}

export interface EmbeddedImagePreviewBridge {
  post: (message: unknown) => void;
  listen: (listener: (message: unknown) => void) => () => void;
}

// The document token separates reloads; the sequence orders opens within it.
let imagePreviewDocumentId: string | null = null;
let imagePreviewRequestId = Math.floor((typeof performance === "undefined"
  ? Date.now() : performance.timeOrigin + performance.now()) * 1000);

/** The parent acknowledges only after the global image surface mounts. */
export function connectEmbeddedImagePreview(
  bridge: EmbeddedImagePreviewBridge,
  view: EmbeddedImagePreviewView,
  onReady: () => void,
  onClose: () => void,
): EmbeddedImagePreviewLifecycle {
  const documentId = imagePreviewDocumentId ??= Array.from(
    globalThis.crypto.getRandomValues(new Uint32Array(4)),
    (part) => part.toString(16).padStart(8, "0"),
  ).join("");
  const requestId = ++imagePreviewRequestId;
  let closed = false;
  let ready = false;
  let prepared = false;
  let stopListening = () => {};
  const close = () => {
    if (closed) return;
    closed = true;
    stopListening();
    bridge.post({ type: EMBEDDED_IMAGE_PREVIEW_EVENT, documentId, requestId, phase: "closed" });
  };
  stopListening = bridge.listen((message) => {
    if (closed || !message || typeof message !== "object") return;
    const data = message as Record<string, unknown>;
    if (data.requestId !== requestId || data.documentId !== documentId) return;
    if (data.type === EMBEDDED_IMAGE_PREVIEW_ACK_EVENT && prepared && !ready) {
      ready = true;
      onReady();
      if (!closed) bridge.post({ type: EMBEDDED_IMAGE_PREVIEW_EVENT, documentId, requestId, phase: "ready" });
    } else if (data.type === EMBEDDED_IMAGE_PREVIEW_CLOSE_EVENT) {
      close();
      onClose();
    }
  });
  prepared = true;
  bridge.post({ ...view, type: EMBEDDED_IMAGE_PREVIEW_EVENT, documentId, requestId, phase: "prepare" });
  return { embedded: true, documentId, requestId, close };
}

export function startEmbeddedImagePreview(
  view: EmbeddedImagePreviewView,
  onReady: () => void,
  onClose: () => void,
): EmbeddedImagePreviewLifecycle {
  if (typeof window === "undefined" || window.parent === window) {
    onReady();
    return { embedded: false, documentId: "", requestId: 0, close: () => {} };
  }
  let absoluteView: EmbeddedImagePreviewView;
  try {
    const absoluteSource = (src: string) => new URL(src, window.location.href).href;
    absoluteView = {
      ...view,
      src: absoluteSource(view.src),
      ...(view.images ? { images: view.images.map(absoluteSource) } : {}),
    };
  } catch {
    onClose();
    return { embedded: true, documentId: "", requestId: 0, close: () => {} };
  }
  if (!reduceEmbeddedImagePreview(null, { ...absoluteView, type: EMBEDDED_IMAGE_PREVIEW_EVENT, documentId: "0".repeat(32), requestId: 1, phase: "prepare" })) {
    onClose();
    return { embedded: true, documentId: "", requestId: 0, close: () => {} };
  }
  return connectEmbeddedImagePreview({
    post: (message) => window.parent.postMessage(message, "*"),
    listen: (listener) => {
      const receive = (event: MessageEvent) => {
        if (event.source === window.parent) listener(event.data);
      };
      window.addEventListener("message", receive);
      return () => window.removeEventListener("message", receive);
    },
  }, absoluteView, onReady, onClose);
}
