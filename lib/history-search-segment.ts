import type { HistoryContentPage, HistorySearchMatch } from "./session-history-types";

export interface LocatedHistoryMatch extends HistorySearchMatch { revision: string }

/** Select the exact visible block/offset from a bounded search-content response. */
export function historySearchSegment(page: HistoryContentPage | null, match: LocatedHistoryMatch | null) {
  if (!page || !match || page.entryId !== match.entryId || page.revision !== match.revision
    || page.surface !== "visible" || page.path !== `/visible/${match.blockIndex}` || page.format !== "text") return null;
  const start = match.offset - page.offset;
  if (start < 0 || start + match.match.length > page.text.length) return null;
  const hit = page.text.slice(start, start + match.match.length);
  if (hit.toLocaleLowerCase() !== match.match.toLocaleLowerCase()) return null;
  return {
    key: `${match.entryId}:${match.blockIndex}:${match.offset}`,
    before: page.text.slice(0, start), hit, after: page.text.slice(start + hit.length),
  };
}
