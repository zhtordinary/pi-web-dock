export const CHAT_SCROLL_TAIL_TOLERANCE = 8;
export const CHAT_SCROLL_REATTACH_TOLERANCE = 96;
export const CHAT_SCROLL_HEAD_TOLERANCE = 8;

/**
 * Identity for one transcript row.
 *
 * An array index is a position, not the identity of a transcript entry. When
 * earlier history is inserted, React can replace a rendered child window or
 * reuse a node for a different entry, so a captured physical anchor cannot be
 * trusted to represent the same message. Persisted entry ids remain stable
 * across history changes and keep the anchor tied to that message.
 *
 * Optimistic and streaming rows may not have a persisted entry id yet; use a
 * scoped index fallback until the server supplies one.
 */
export function getMessageRowKey(
  keyPrefix: string,
  entryId: string | undefined,
  index: number,
): string {
  return entryId ? `${keyPrefix}-${entryId}` : `${keyPrefix}-idx-${index}`;
}

export function captureScrollDistance(scrollHeight: number, scrollTop: number): number {
  return scrollHeight - scrollTop;
}

export function restoreScrollTop(scrollHeight: number, savedDistance: number): number {
  return Math.max(0, scrollHeight - savedDistance);
}

export function isScrollAtTail(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  tolerance = CHAT_SCROLL_TAIL_TOLERANCE,
): boolean {
  return scrollTop + clientHeight >= scrollHeight - tolerance;
}

export function isScrollAtHead(
  scrollTop: number,
  tolerance = CHAT_SCROLL_HEAD_TOLERANCE,
): boolean {
  return scrollTop <= tolerance;
}

export function getLiveFollowAttached(
  wasAttached: boolean,
  previousScrollTop: number,
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  reattachTolerance = CHAT_SCROLL_REATTACH_TOLERANCE,
): boolean {
  if (scrollTop === previousScrollTop) return wasAttached;
  if (isScrollAtTail(scrollTop, clientHeight, scrollHeight)) return true;
  if (scrollTop < previousScrollTop) return false;
  if (!wasAttached && scrollTop > previousScrollTop && isScrollAtTail(scrollTop, clientHeight, scrollHeight, reattachTolerance)) return true;
  return wasAttached;
}

export function shouldShowScrollToLatest(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  tolerance = CHAT_SCROLL_TAIL_TOLERANCE,
): boolean {
  if (scrollHeight <= clientHeight) return false;
  return !isScrollAtTail(scrollTop, clientHeight, scrollHeight, tolerance);
}

export function getPromptAnchorSpacerHeight(
  targetTop: number,
  contentEnd: number,
  clientHeight: number,
): number {
  const clampedTargetTop = Math.max(0, targetTop);
  if (clampedTargetTop === 0) return 0;

  return Math.max(0, Math.ceil(
    clampedTargetTop + clientHeight - Math.max(0, contentEnd),
  ));
}
