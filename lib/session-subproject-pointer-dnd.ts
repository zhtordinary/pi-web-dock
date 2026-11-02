import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import { projectKeysMatch } from "./subproject-groups.ts";

export const SESSION_SUBPROJECT_DROP_SELECTOR = "[data-session-subproject-drop]";
const POINTER_DRAG_THRESHOLD = 6;

type SessionPointerDropTarget = {
  projectKey: string;
  deviceId?: string;
  subprojectId: string | null;
  element: HTMLElement;
};

type SessionPointerDrag = {
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  owner: HTMLElement;
  target: SessionPointerDropTarget | null;
};

export function isSessionSubprojectPointerDropValid(
  sourceProjectKey: string,
  sourceDeviceId: string | undefined,
  target: Pick<SessionPointerDropTarget, "projectKey" | "deviceId">,
): boolean {
  return projectKeysMatch(sourceProjectKey, target.projectKey)
    && (!sourceDeviceId || target.deviceId === sourceDeviceId);
}

/** Keep ordinary session clicks usable while allowing drag from the row surface. */
export function canStartSessionSubprojectPointerDrag(target: EventTarget | null): boolean {
  const element = target as (EventTarget & { closest?: (selector: string) => (EventTarget & { closest?: (selector: string) => unknown }) | null }) | null;
  if (!element || typeof element.closest !== "function") return true;
  if (element.closest("input, textarea, select, a, [data-session-no-drag]")) return false;
  const button = element.closest("button");
  if (button && !(button as HTMLElement).hasAttribute("data-session-open")) return false;
  // The activity-panel session body is itself a button that opens the
  // session. It is the row's ordinary content, so it must remain a valid
  // drag origin now that the dedicated handle is gone; action buttons still
  // stay blocked below.
  if (element.closest("[data-session-open]")) return true;
  return !button;
}

/** HTML5 subproject rows are draggable, but nested controls must never reorder from their pointer origin. */
export function isSubprojectReorderDragBlocked(target: EventTarget | null): boolean {
  const element = target as (EventTarget & { closest?: (selector: string) => unknown }) | null;
  return Boolean(element && typeof element.closest === "function"
    && element.closest('input, textarea, select, a, button, [role="button"], [data-subproject-no-drag]'));
}

function targetAt(clientX: number, clientY: number): SessionPointerDropTarget | null {
  const element = document.elementFromPoint(clientX, clientY);
  if (!(element instanceof HTMLElement)) return null;
  const target = element.closest(SESSION_SUBPROJECT_DROP_SELECTOR) as HTMLElement | null;
  if (!target?.dataset.sessionProjectKey) return null;
  return {
    projectKey: target.dataset.sessionProjectKey,
    deviceId: target.dataset.sessionDeviceId,
    subprojectId: target.dataset.sessionSubprojectId || null,
    element: target,
  };
}

/**
 * A session move gesture must not leave behind, or keep growing, a native text
 * selection: the browser starts one as soon as the pointer travels over row
 * text, and the rows can be released far from where the drag began.
 */
function clearTextSelection(): void {
  if (typeof window === "undefined") return;
  window.getSelection()?.removeAllRanges();
}

function clearDropMarks(): void {
  document.querySelectorAll<HTMLElement>(`${SESSION_SUBPROJECT_DROP_SELECTOR}.pointer-drag-over`).forEach((element) => {
    element.classList.remove("pointer-drag-over");
  });
}

export function useSessionSubprojectPointerDrag({
  projectKey,
  deviceId,
  disabled = false,
  onMove,
  onMoveFailed,
}: {
  projectKey?: string;
  deviceId?: string;
  disabled?: boolean;
  onMove: (subprojectId: string | null) => Promise<boolean>;
  onMoveFailed?: () => void;
}) {
  const dragRef = useRef<SessionPointerDrag | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const finish = useCallback((event: ReactPointerEvent<HTMLElement>, commit: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const target = drag.target;
    if (drag.owner.hasPointerCapture?.(drag.pointerId)) drag.owner.releasePointerCapture(drag.pointerId);
    dragRef.current = null;
    clearDropMarks();
    setDragging(false);
    if (!drag.active) return;
    clearTextSelection();
    suppressClickRef.current = true;
    window.setTimeout(() => { suppressClickRef.current = false; }, 500);
    if (!commit || !target || !projectKey || !isSessionSubprojectPointerDropValid(projectKey, deviceId, target)) return;
    void onMove(target.subprojectId).then((moved) => {
      if (!moved) onMoveFailed?.();
    }).catch(() => onMoveFailed?.());
  }, [deviceId, onMove, onMoveFailed, projectKey]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (disabled || !projectKey || event.button !== 0 || !event.isPrimary) return;
    if (!canStartSessionSubprojectPointerDrag(event.target)) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      owner: event.currentTarget,
      target: null,
    };
  }, [disabled, projectKey]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < POINTER_DRAG_THRESHOLD) return;
      drag.active = true;
      drag.owner.setPointerCapture?.(drag.pointerId);
      clearTextSelection();
      setDragging(true);
      document.body.classList.add("session-subproject-pointer-dragging");
    }
    event.preventDefault();
    clearDropMarks();
    drag.target = targetAt(event.clientX, event.clientY);
    drag.target?.element.classList.add("pointer-drag-over");
  }, []);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current?.active) event.preventDefault();
    document.body.classList.remove("session-subproject-pointer-dragging");
    finish(event, true);
  }, [finish]);

  const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    document.body.classList.remove("session-subproject-pointer-dragging");
    finish(event, false);
  }, [finish]);

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return { dragging, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture };
}
