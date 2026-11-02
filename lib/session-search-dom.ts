type SearchElement = HTMLElement & {
  scrollHeight?: number;
  clientHeight?: number;
};

function isScrollable(element: SearchElement): boolean {
  const scrollHeight = element.scrollHeight ?? 0;
  const clientHeight = element.clientHeight ?? 0;
  if (scrollHeight <= clientHeight + 1) return false;
  const overflowY = typeof window === "undefined"
    ? element.style?.overflowY
    : window.getComputedStyle(element).overflowY;
  return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
}

function revealSearchTarget(target: SearchElement, container: SearchElement): void {
  const targetRect = target.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const padding = 8;
  const top = containerRect.top + padding;
  const bottom = containerRect.bottom - padding;
  if (targetRect.top < top) {
    container.scrollTop -= top - targetRect.top;
  } else if (targetRect.bottom > bottom) {
    container.scrollTop += targetRect.bottom - bottom;
  }
}

/** Reveal both the transcript row and any nested message scrollports. */
export function scrollSessionSearchTarget(mark: HTMLElement, transcript: HTMLElement, scrollToEntry: (element: HTMLElement, offset: number) => void): void {

  // Open any collapsed <details> ancestors so the match is visible
  for (let current = mark.parentElement; current && current !== transcript; current = current.parentElement) {
    if (current.tagName === "DETAILS" && !(current as HTMLDetailsElement).open) {
      (current as HTMLDetailsElement).open = true;
    }
  }

  const nestedScrollports: SearchElement[] = [];
  for (let current = mark.parentElement as SearchElement | null; current && current !== transcript; current = current.parentElement as SearchElement | null) {
    if (isScrollable(current)) nestedScrollports.push(current);
  }

  // Reveal nested scrollports first so the mark position within the transcript is settled
  for (const scrollport of nestedScrollports) revealSearchTarget(mark, scrollport);

  const height = mark.getBoundingClientRect().height;
  scrollToEntry(mark, Math.max(16, (transcript.clientHeight - height) / 2));
}
