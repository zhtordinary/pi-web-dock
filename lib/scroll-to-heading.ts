/** Scroll the heading rendered from a source line into a specific container. */
export function scrollToHeadingSourceLine(
  root: HTMLElement,
  sourceLine: number,
  opts?: { behavior?: ScrollBehavior; offset?: number },
): boolean {
  const headings = root.querySelectorAll<HTMLElement>("[data-heading-source-line]");
  const el = Array.from(headings).find((heading) => Number(heading.dataset.headingSourceLine) === sourceLine);
  if (!el) return false;

  const offset = opts?.offset ?? 12;
  const behavior = opts?.behavior ?? "smooth";

  // Distance from heading top to the scrollport top, independent of offsetParent chain.
  const rootRect = root.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const nextTop = root.scrollTop + (elRect.top - rootRect.top) - offset;

  root.scrollTo({ top: Math.max(0, nextTop), behavior });
  return true;
}

/** Resolve a fragment only within its rendered Markdown document. */
export function scrollToMarkdownAnchor(root: ParentNode | null, href: string): boolean {
  if (!root || !href.startsWith("#") || href.length === 1) return false;
  let anchor = href.slice(1);
  try { anchor = decodeURIComponent(anchor); } catch { /* Keep the original fragment. */ }
  const headings = Array.from(root.querySelectorAll<HTMLElement>("[data-heading-anchor]"));
  const find = (id: string) => headings.find((heading) => heading.dataset.headingAnchor === id);
  const target = find(anchor) ?? (anchor.startsWith("user-content-") ? find(anchor.slice("user-content-".length)) : undefined);
  if (!target) return false;
  target.scrollIntoView({ block: "start" });
  return true;
}
