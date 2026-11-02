export interface TocItem {
  id: string;
  /** Document order among ATX headings (0-based). */
  index: number;
  sourceLine: number;
  level: number;
  text: string;
  children: TocItem[];
}

function stripInlineNoise(text: string): string {
  return text
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$[^$\n]+\$/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable, DOM-friendly id from heading text. */
export function slugifyHeading(text: string, used: Map<string, number>): string {
  const base = stripInlineNoise(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "section";
  const n = (used.get(base) ?? 0) + 1;
  used.set(base, n);
  return n === 1 ? base : `${base}-${n}`;
}

export interface FlatHeading {
  level: number;
  sourceLine: number;
  text: string;
  id: string;
}

/** Ordered ATX headings with stable ids (shared by TOC + heading anchors). */
export function extractFlatHeadings(source: string): FlatHeading[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const flats: FlatHeading[] = [];
  const used = new Map<string, number>();
  let inFence = false;

  for (const [lineIndex, line] of lines.entries()) {
    const fence = line.match(/^(`{3,}|~{3,})/);
    if (fence) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    const level = m[1].length;
    const text = stripInlineNoise(m[2]);
    if (!text) continue;
    // id from the same cleaned text the TOC displays
    flats.push({ level, sourceLine: lineIndex + 1, text, id: slugifyHeading(text, used) });
  }
  return flats;
}

/**
 * Build a hierarchical TOC from Markdown ATX headings (# … ######).
 * Skips fenced code blocks so `#` inside code is ignored.
 */
export function buildMarkdownToc(source: string): TocItem[] {
  const flats = extractFlatHeadings(source);
  const roots: TocItem[] = [];
  const stack: TocItem[] = [];

  flats.forEach((h, index) => {
    const node: TocItem = { id: h.id, index, sourceLine: h.sourceLine, level: h.level, text: h.text, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }
    stack.push(node);
  });

  return roots;
}

export function flattenToc(items: TocItem[]): TocItem[] {
  const out: TocItem[] = [];
  const walk = (nodes: TocItem[]) => {
    for (const n of nodes) {
      out.push(n);
      if (n.children.length) walk(n.children);
    }
  };
  walk(items);
  return out;
}
