export interface ExtensionDialogEscapeEvent {
  key: string;
  defaultPrevented: boolean;
  isComposing?: boolean;
  keyCode?: number;
  preventDefault(): void;
  stopPropagation(): void;
}

type ModalTarget = {
  closest?: (selectors: string) => unknown;
};

type ModalSurface = {
  contains?: (node: Node | null) => boolean;
} | null;

function modalOwner(target: unknown): unknown {
  if (!target || typeof target !== "object") return null;
  const closest = (target as ModalTarget).closest;
  if (typeof closest !== "function") return null;
  return closest.call(target, "dialog[open], [aria-modal=\"true\"], [data-native-modal=\"true\"]");
}

export function isForeignNativeModalOwner(
  eventTarget: unknown,
  activeElement: unknown,
  dialogSurface: ModalSurface,
): boolean {
  const owner = modalOwner(eventTarget) ?? modalOwner(activeElement);
  if (!owner) return false;
  if (!dialogSurface) return true;
  if (owner === dialogSurface) return false;
  return !(typeof dialogSurface.contains === "function" && dialogSurface.contains(owner as Node));
}

export const COMPOSITION_END_ENTER_GRACE_MS = 100;

export function getExtensionDialogInputCompositionEndAtOnBlur(
  compositionActive: boolean,
  compositionEndedAt: number,
  now = Date.now(),
): number {
  return compositionActive ? now : compositionEndedAt;
}

export interface ExtensionDialogInputKeyEvent {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
  preventDefault(): void;
}

/** Keeps an IME confirmation Enter from becoming a dialog submission. */
export function handleExtensionDialogInputKeyDown(
  event: ExtensionDialogInputKeyEvent,
  compositionActive: boolean,
  compositionEndedAt: number,
  onSubmit: () => void,
  now = Date.now(),
): boolean {
  if (event.key !== "Enter") return false;
  const recentlyComposed = compositionEndedAt > 0
    && now >= compositionEndedAt
    && now - compositionEndedAt < COMPOSITION_END_ENTER_GRACE_MS;
  const isComposing = compositionActive || event.isComposing === true || event.keyCode === 229;
  if (isComposing || recentlyComposed) {
    if (recentlyComposed) event.preventDefault();
    return true;
  }
  event.preventDefault();
  onSubmit();
  return true;
}

export function handleExtensionDialogEscape(
  event: ExtensionDialogEscapeEvent,
  onCancel: () => void,
  options?: { nativeModalOwned?: boolean },
): boolean {
  if (
    event.key !== "Escape"
    || event.defaultPrevented
    || event.isComposing
    || event.keyCode === 229
    || options?.nativeModalOwned
  ) return false;
  event.preventDefault();
  event.stopPropagation();
  onCancel();
  return true;
}
