import type { Content, Link, Parent, Root } from "mdast";
import type { Element as HastElement, Root as HastRoot, RootContent as HastContent } from "hast";
import { defaultUrlTransform, type Options as ReactMarkdownOptions } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Extension } from "micromark-util-types";
import type { Plugin } from "unified";

const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
    span: [...(defaultSchema.attributes?.span || []), ["className"], ["style"]],
    div: [...(defaultSchema.attributes?.div || []), ["className"], ["style"]],
  },
  // KaTeX may emit annotation/math-ish nodes; keep common presentation tags.
  tagNames: [
    ...(defaultSchema.tagNames || []),
    "math", "semantics", "mrow", "mi", "mo", "mn", "msup", "msub", "mfrac",
    "msqrt", "mroot", "mtable", "mtr", "mtd", "mspace", "annotation",
  ],
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file"],
  },
  strip: [...(defaultSchema.strip || []), "iframe", "object", "style", "form"],
};

// Shared KaTeX options: tolerate MathType/Word-export quirks (boldsymbol, etc.).
const katexOptions = {
  throwOnError: false,
  strict: false as const,
  trust: false,
  macros: {
    "\\boldsymbol": "\\mathbf{#1}",
    "\\bm": "\\mathbf{#1}",
  },
};

// singleDollarTextMath: $...$ inline, as academic Markdown/MathType exports usually use.

export function markdownUrlTransform(value: string): string {
  return /^file:/i.test(value) ? value : defaultUrlTransform(value);
}

/**
 * `value.replace(pattern, replace)` as if `pattern` began with the lookbehind
 * `(?<![notAfter])`. Safari only parses lookbehind from 16.4, and one regex
 * literal it cannot parse fails the whole script chunk, which left iOS 16.2 on
 * a blank page (#753). The sticky `pattern` is tried at each `opener` in turn,
 * the order in which the lookbehind version tries start positions.
 */
function replaceNotPrecededBy(
  value: string,
  opener: string,
  notAfter: string,
  pattern: RegExp,
  replace: (match: RegExpExecArray) => string,
): string {
  let result = "";
  let copied = 0;
  for (let index = value.indexOf(opener); index !== -1; index = value.indexOf(opener, index + 1)) {
    if (index > 0 && notAfter.includes(value[index - 1])) continue;
    pattern.lastIndex = index;
    const match = pattern.exec(value);
    if (!match) continue;
    result += value.slice(copied, index) + replace(match);
    copied = pattern.lastIndex;
    index = copied - 1;
  }
  return result + value.slice(copied);
}

// The closing backtick must not follow `\\` or another backtick, so the content
// ends with a character that is neither.
const escapedInlineCodePattern = /`((?:[^`\n]|\\`)*?[^\\`\n])`(?!`)/y;

function rewriteEscapedInlineCodeBackticks(line: string): string {
  return replaceNotPrecededBy(line, "`", "\\`", escapedInlineCodePattern, ([match, content]) => {
    const code = content.replace(/\\`/g, "`");
    if (code === content) return match;
    const marker = "`".repeat(Math.max(...(code.match(/`+/g)?.map((run) => run.length) ?? [0])) + 1);
    return `${marker}${code}${marker}`;
  });
}

export function normalizeDisplayMath(markdown: string): string {
  const lineBreak = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  const normalized: string[] = [];
  let fence: { marker: string; size: number } | null = null;
  let inlineCodeMarkerSize = 0;
  let rawCodeTag: string | null = null;
  const unmatchedDisplayMathUntil = new Map<string, number>();

  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];

    if (rawCodeTag) {
      normalized.push(line);
      if (new RegExp(`</${rawCodeTag}\\s*>`, "i").test(line)) rawCodeTag = null;
      continue;
    }

    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      const size = fenceMatch[1].length;
      if (!fence) fence = { marker, size };
      else if (marker === fence.marker && size >= fence.size) fence = null;
      inlineCodeMarkerSize = 0;
      normalized.push(line);
      continue;
    }

    if (fence) {
      normalized.push(line);
      continue;
    }

    const rawCodeOpen = line.match(/<(code|pre|script|style)\b/i);
    if (rawCodeOpen) {
      const tag = rawCodeOpen[1].toLowerCase();
      const remainder = line.slice((rawCodeOpen.index ?? 0) + rawCodeOpen[0].length);
      if (!new RegExp(`</${tag}\\s*>`, "i").test(remainder)) rawCodeTag = tag;
      inlineCodeMarkerSize = 0;
      normalized.push(line);
      continue;
    }

    if (/^(?: {4}|\t)/.test(line) || line.trim() === "") {
      inlineCodeMarkerSize = 0;
      normalized.push(line);
      continue;
    }

    if (!inlineCodeMarkerSize) line = rewriteEscapedInlineCodeBackticks(line);

    if (inlineCodeMarkerSize || line.includes("`")) {
      inlineCodeMarkerSize = updateInlineCodeMarker(line, inlineCodeMarkerSize);
      normalized.push(line);
      continue;
    }

    const bracketDisplayOneLine = line.match(/^([ ]{0,3})\\\[[ \t]*(.+?)[ \t]*\\\][ \t]*$/);
    if (bracketDisplayOneLine) {
      const math = bracketDisplayOneLine[2].trim();
      if (math) {
        // Keep the content line indented together with the `$$` fence. When the
        // formula is nested inside a GFM list item (indented `$$`), a content line
        // at column 0 becomes a "lazy continuation" line, which makes remark-math
        // mis-parse the fence pair: the opening `$$` turns into an empty math node
        // and the closing one swallows the rest of the document as math content.
        normalized.push(
          `${bracketDisplayOneLine[1]}$$`,
          `${bracketDisplayOneLine[1]}${math}`,
          `${bracketDisplayOneLine[1]}$$`,
        );
        continue;
      }
    }

    const looseBracketDisplayOneLine = line.match(/^([ ]{0,3})\[[ \t]*(.+?)[ \t]*\][ \t]*$/);
    if (looseBracketDisplayOneLine) {
      const math = looseBracketDisplayOneLine[2].trim();
      if (isLikelyMathExpression(math)) {
        normalized.push(
          `${looseBracketDisplayOneLine[1]}$$`,
          `${looseBracketDisplayOneLine[1]}${math}`,
          `${looseBracketDisplayOneLine[1]}$$`,
        );
        continue;
      }
    }

    const bracketDisplayStart = line.match(/^([ ]{0,3})\\\[[ \t]*$/);
    if (bracketDisplayStart) {
      const closingIndex = findBracketDisplayClose(lines, index + 1);
      if (closingIndex !== -1) {
        // Same lazy-continuation guard as above: indent content lines that sit at
        // column 0 so the block stays parseable when nested inside a list item.
        normalized.push(
          `${bracketDisplayStart[1]}$$`,
          ...lines.slice(index + 1, closingIndex).map((mathLine) =>
            indentDisplayMathContent(mathLine, bracketDisplayStart[1]),
          ),
          `${bracketDisplayStart[1]}$$`,
        );
        index = closingIndex;
        continue;
      }
    }

    const displayMathMatch = line.match(/^([ \t]{0,3})\$\$(.+)\$\$[ \t]*$/);
    if (displayMathMatch) {
      const math = displayMathMatch[2].trim();
      if (math) {
        // See the comment on bracketDisplayOneLine: without matching indentation,
        // a formula nested in a GFM list item is mis-parsed by remark-math and the
        // text after the formula renders as a garbled KaTeX error block.
        normalized.push(
          `${displayMathMatch[1]}$$`,
          `${displayMathMatch[1]}${math}`,
          `${displayMathMatch[1]}$$`,
        );
        continue;
      }
    }

    // remark-math requires both `$$` delimiters to sit on their own lines, but
    // models also emit display math as a multi-line block where the opening `$$`
    // is glued to the first formula line and/or the closing `$$` is glued to the
    // end of the last one (`$$x = 1` + `y = 2$$`). Without normalization such a
    // block swallows the following text as math content and renders as garbage.
    const displayMathMultiLine = line.match(/^([ \t]{0,3})\$\$(.+)$/);
    if (displayMathMultiLine) {
      const indent = displayMathMultiLine[1];
      const firstLine = displayMathMultiLine[2].trimEnd();
      // Only treat this as a block opener if no other `$$` is embedded mid-line
      // (e.g. `$$x$$ and text` stays untouched and is rendered as inline math).
      if (firstLine && !firstLine.includes("$$")) {
        const closing = findDisplayMathClose(
          lines,
          index + 1,
          indent,
          unmatchedDisplayMathUntil,
        );
        if (closing) {
          normalized.push(`${indent}$$`, `${indent}${firstLine}`);
          for (let j = index + 1; j < closing.index; j++) {
            normalized.push(indentDisplayMathContent(lines[j], indent));
          }
          if (closing.content) normalized.push(`${indent}${closing.content}`);
          normalized.push(`${indent}$$`);
          index = closing.index;
          continue;
        }
      }
    }

    // Bare `$$` opener (possibly indented inside a GFM list item). Two problems
    // need fixing: (1) when the closing `$$` is glued to the last content line
    // (e.g. `z = w$$`) remark-math never finds a valid closing fence and swallows
    // the rest of the document; (2) inside a list item, content lines at column 0
    // are lazy continuations that break the math flow. Both are fixed by moving
    // the closing `$$` to its own line and re-indenting lazy content lines.
    // A column-0 block with a properly detached closing `$$` is left untouched
    // (remark-math already parses it correctly).
    const displayMathBareOpen = line.match(/^([ \t]{0,3})\$\$\s*$/);
    if (displayMathBareOpen) {
      const indent = displayMathBareOpen[1];
      const closing = findDisplayMathClose(
        lines,
        index + 1,
        indent,
        unmatchedDisplayMathUntil,
      );
      if (closing && (closing.glued || indent !== "")) {
        normalized.push(`${indent}$$`);
        for (let j = index + 1; j < closing.index; j++) {
          normalized.push(indentDisplayMathContent(lines[j], indent));
        }
        if (closing.content) normalized.push(`${indent}${closing.content}`);
        normalized.push(`${indent}$$`);
        index = closing.index;
        continue;
      }
    }

    normalized.push(normalizeInlineLatexMath(line));
  }

  return normalized.join(lineBreak);
}

interface DisplayMathClose {
  index: number;
  content: string;
  glued: boolean;
}

function findDisplayMathClose(
  lines: string[],
  startIndex: number,
  indent: string,
  unmatchedUntil: Map<string, number>,
): DisplayMathClose | null {
  const knownUnmatchedUntil = unmatchedUntil.get(indent);
  if (knownUnmatchedUntil !== undefined && startIndex < knownUnmatchedUntil) return null;

  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index];
    if (isDisplayMathFence(line, indent)) return { index, content: "", glued: false };

    // A new Markdown block cannot belong to the preceding formula. In particular,
    // do not let a later sibling list item provide a closing `$$` for this block.
    if (isDisplayMathBlockBoundary(line) || isDisplayMathOpeningLine(line)) {
      unmatchedUntil.set(indent, index);
      return null;
    }

    const content = getDisplayMathGluedCloseContent(line, indent);
    if (content !== null) return { index, content, glued: true };
  }

  // Multiple unmatched glued openers with the same indentation previously each
  // scanned to EOF. Cache this range so the overall search remains linear.
  unmatchedUntil.set(indent, lines.length);
  return null;
}

function isDisplayMathFence(line: string, indent: string): boolean {
  if (indent === "") return /^ {0,3}\$\$\s*$/.test(line);
  return line.startsWith(indent) && /^\$\$\s*$/.test(line.slice(indent.length));
}

function getDisplayMathGluedCloseContent(line: string, indent: string): string | null {
  if (!line.startsWith(indent)) return null;

  const match = line.slice(indent.length).match(/^(.+?)\$\$\s*$/);
  if (!match) return null;

  const content = match[1].trimEnd();
  return content && !content.includes("$$") ? content : null;
}

function isDisplayMathOpeningLine(line: string): boolean {
  return /^ {0,3}\$\$(?:\S|[ \t]+\S)/.test(line);
}

function isDisplayMathBlockBoundary(line: string): boolean {
  return (
    /^ {0,3}(`{3,}|~{3,})/.test(line) ||
    /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/.test(line) ||
    /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(line) ||
    /^ {0,3}>/.test(line) ||
    /<(code|pre|script|style)\b/i.test(line)
  );
}

function indentDisplayMathContent(line: string, indent: string): string {
  if (!indent || !line || line.startsWith("\t")) return line;

  const leadingSpaces = line.match(/^ */)?.[0].length ?? 0;
  if (leadingSpaces >= indent.length) return line;
  return `${indent.slice(leadingSpaces)}${line}`;
}

function findBracketDisplayClose(lines: string[], startIndex: number): number {
  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index];
    if (/^ {0,3}\\\][ \t]*$/.test(line)) return index;

    // Do not pair delimiters across another Markdown block boundary.
    if (
      /^ {0,3}(`{3,}|~{3,})/.test(line) ||
      /^ {0,3}\\\[[ \t]*$/.test(line) ||
      /<(code|pre|script|style)\b/i.test(line)
    ) {
      return -1;
    }
  }

  return -1;
}

function updateInlineCodeMarker(line: string, initialMarkerSize: number): number {
  let markerSize = initialMarkerSize;
  for (let cursor = 0; cursor < line.length;) {
    if (line[cursor] !== "`") {
      cursor++;
      continue;
    }

    let end = cursor + 1;
    while (line[end] === "`") end++;
    const runSize = end - cursor;
    if (markerSize === 0) markerSize = runSize;
    else if (runSize === markerSize) markerSize = 0;
    cursor = end;
  }
  return markerSize;
}

function isLikelyMathExpression(value: string): boolean {
  return /\\[A-Za-z]+/.test(value) && !/\b(?:https?|file|mailto):|\b[A-Za-z]:\\|^\\\\/i.test(value);
}

// `\\(` … `\\)` whose closing backslash is not itself escaped.
const inlineLatexMathPattern = /\\\(([^`\r\n$]*?[^`\r\n$\\])\\\)/y;

function normalizeInlineLatexMath(line: string): string {
  if (
    /^\s{0,3}\[[^\]]+\]:/.test(line) ||
    /]\s*\(/.test(line) ||
    /<(?:!--|\/?[A-Za-z][^>]*>)/.test(line) ||
    /\b(?:https?|file|mailto):/i.test(line) ||
    /\b[A-Za-z]:\\/.test(line)
  ) {
    return line;
  }

  return replaceNotPrecededBy(line, "\\(", "\\", inlineLatexMathPattern, ([match, math]) =>
    math.trim() ? `$${math}$` : match,
  );
}

// Parse YAML frontmatter into a `yaml` node before the math/GFM plugins run, so
// the raw metadata never leaks into the rendered output (without it, the opening
// `---` becomes an <hr> and the closing `---` turns the YAML into a setext heading).
// singleTilde:false requires ~~double~~ tildes for strikethrough. A single `~`
// is the standard CJK numeric-range separator (e.g. "5~7U", "100~200倍"), and
// GFM's default single-tilde strikethrough silently mangled such ranges (#385).
// Reader keeps currency-safe remarkMath (singleDollarTextMath) for MathType/Word $...$
// inline math compatibility.
const remarkGfmOptions = { singleTilde: false } as const;

// GFM autolink literals stop only at whitespace, and the trailing-punctuation
// trim knows only ASCII punctuation. Split a literal at CJK sentence punctuation
// while leaving ideographs inside genuine CJK URL paths intact.
const cjkPunctuationPattern =
  /[\u3001\u3002\u3008-\u3011\u3014-\u301B\uFF01\uFF08\uFF09\uFF0C\uFF1A\uFF1B\uFF1F\u2018\u2019\u201C\u201D\u2013\u2014\u2026\u00B7\uFF5E\u301C]/;

export function splitAutolinkLiteralsAtCjkPunctuation(tree: Root, source: string): void {
  const walk = (node: Root | Parent): void => {
    const children = node.children as Content[];
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (child.type === "link") splitAutolinkLiteral(children, index, child, source);
      const current = children[index];
      if ("children" in current && Array.isArray(current.children)) walk(current as Parent);
    }
  };
  walk(tree);
}

function splitAutolinkLiteral(
  siblings: Content[],
  index: number,
  node: Link,
  source: string,
): void {
  if (node.title != null || node.children.length !== 1) return;
  const textNode = node.children[0];
  if (textNode.type !== "text") return;

  const start = node.position?.start;
  const end = node.position?.end;
  if (start?.offset == null || end?.offset == null) return;
  if (source.slice(start.offset, end.offset) !== textNode.value) return;

  const text = textNode.value;
  const cut = text.search(cjkPunctuationPattern);
  if (cut <= 0 || !node.url.endsWith(text)) return;

  const head = text.slice(0, cut);
  const boundary = { line: start.line, column: start.column + cut, offset: start.offset + cut };
  node.url = node.url.slice(0, node.url.length - text.length) + head;
  textNode.value = head;
  node.position = { start, end: boundary };
  siblings.splice(index + 1, 0, {
    type: "text",
    value: text.slice(cut),
    position: { start: boundary, end },
  });
}

function remarkSplitAutolinkLiterals() {
  return (tree: Root, file: { value?: unknown }): void => {
    splitAutolinkLiteralsAtCjkPunctuation(tree, typeof file.value === "string" ? file.value : "");
  };
}

function remarkWindowsFileLinks() {
  return (tree: Root): void => {
    const walk = (node: Root | Content): void => {
      if ((node.type === "link" || node.type === "definition") && /^\/?[A-Za-z]:\//.test(node.url)) {
        node.url = `file:///${node.url.replace(/^\//, "")}`;
      }
      if ("children" in node) node.children.forEach(walk);
    };
    walk(tree);
  };
}

// Reject ambiguous single-dollar pairs during tokenization, before math can
// swallow Markdown emphasis or links. Preserve real single-dollar math,
// balanced padding and multiline math while keeping prices as prose.
const remarkCurrencySafeMath: Plugin = function () {
  remarkMath.call(this);
  const data = this.data() as { micromarkExtensions?: Extension[] };
  const extension = data.micromarkExtensions?.at(-1);
  const constructs = extension?.text?.[36];
  for (const construct of Array.isArray(constructs) ? constructs : constructs ? [constructs] : []) {
    if (construct.name !== "mathText") continue;
    const tokenize = construct.tokenize;
    construct.tokenize = function (effects, ok, nok) {
      const start = this.now();
      return tokenize.call(this, effects, (code) => {
        const source = this.sliceSerialize({ start, end: this.now() });
        if (source.startsWith("$") && !source.startsWith("$$")) {
          const content = source.slice(1, -1);
          const startsWithAmount = /^\s*[+-]?(?:\d|\.\d)/.test(content);
          const closesBeforeNumber = code !== null && code >= 48 && code <= 57;
          const mismatchedPadding = /^\s/.test(content) !== /\s$/.test(content);
          if (startsWithAmount && (closesBeforeNumber || mismatchedPadding)) return nok(code);
        }
        return ok(code);
      }, nok);
    };
  }
};

// User messages keep every typed line break, including CR-only input. Code,
// inline code, math and raw HTML retain their own semantics.
interface MarkdownTreeNode {
  type: string;
  value?: string;
  children?: MarkdownTreeNode[];
  data?: { hName?: string };
}

const LINE_ENDING = /[ \t]*(?:\r\n|\r|\n)[ \t]*/;
const PHRASING_BLOCK_TYPES = new Set(["paragraph", "heading", "tableCell"]);
const RAW_TEXT_OPEN_TAG = /^<(?:iframe|noembed|noframes|noscript|plaintext|script|style|textarea|title|xmp)(?=[\s/>]|$)/i;

function opensRawTextElement(node: MarkdownTreeNode): boolean {
  if (node.type === "html") return RAW_TEXT_OPEN_TAG.test(node.value ?? "");
  return node.children?.some(opensRawTextElement) ?? false;
}

function lineBreakNode(): MarkdownTreeNode {
  return { type: "lineBreak", data: { hName: "br" } };
}

function keepLineBreaks(parent: MarkdownTreeNode): void {
  if (!parent.children) return;
  if (PHRASING_BLOCK_TYPES.has(parent.type) && opensRawTextElement(parent)) return;
  parent.children = parent.children.flatMap((node) => {
    if (node.type === "break") return [lineBreakNode()];
    if (node.type !== "text" || !node.value) {
      keepLineBreaks(node);
      return [node];
    }
    return node.value.split(LINE_ENDING).flatMap((line, index) => [
      ...(index > 0 ? [lineBreakNode()] : []),
      ...(line ? [{ type: "text", value: line }] : []),
    ]);
  });
}

function remarkKeepLineBreaks() {
  return (tree: MarkdownTreeNode) => keepLineBreaks(tree);
}

function remarkLiteralHtml() {
  const visit = (node: MarkdownTreeNode): void => {
    if (node.type === "html") node.type = "text";
    node.children?.forEach(visit);
  };
  return visit;
}

export const markdownUserRemarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [
  [remarkFrontmatter, ["yaml"]],
  [remarkGfm, remarkGfmOptions],
  remarkSplitAutolinkLiterals,
  remarkCurrencySafeMath,
  remarkWindowsFileLinks,
  remarkKeepLineBreaks,
];

export const markdownLiteralUserRemarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [
  ...(markdownUserRemarkPlugins ?? []).slice(0, -1),
  remarkLiteralHtml,
  remarkKeepLineBreaks,
];

interface MarkdownImageNode {
  type?: string;
  url?: string;
  children?: MarkdownImageNode[];
}

export function remarkDedupeImages() {
  return (tree: MarkdownImageNode) => {
    const seen = new Set<string>();

    const visit = (node: MarkdownImageNode) => {
      if (!Array.isArray(node.children)) return;
      const nextChildren: MarkdownImageNode[] = [];
      for (const child of node.children) {
        if (child.type === "image" && typeof child.url === "string") {
          if (seen.has(child.url)) continue;
          seen.add(child.url);
        }
        visit(child);
        if (child.type === "paragraph" && child.children?.length === 0) continue;
        nextChildren.push(child);
      }
      node.children = nextChildren;
    };

    visit(tree);
  };
}

export const markdownRemarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [
  [remarkFrontmatter, ["yaml"]],
  [remarkGfm, remarkGfmOptions],
  remarkSplitAutolinkLiterals,
  remarkCurrencySafeMath,
  remarkWindowsFileLinks,
];
export const markdownPreviewRemarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [
  [remarkFrontmatter, ["yaml"]],
  [remarkGfm, remarkGfmOptions],
  remarkSplitAutolinkLiterals,
  remarkCurrencySafeMath,
  remarkWindowsFileLinks,
];

export const markdownRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  [rehypeKatex, katexOptions],
];

export function isExternalMarkdownHref(href: string | undefined): boolean {
  return Boolean(href && /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href));
}

function hastText(node: HastContent): string {
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(hastText).join("");
  return "";
}

// After sanitization, only parsed math blocks receive this internal copy source.
function rehypeDisplayMathSource() {
  return (tree: HastRoot): void => {
    const visit = (parent: HastRoot | HastElement): void => {
      parent.children = parent.children.map((child) => {
        if (child.type !== "element") return child;
        const code = child.tagName === "pre" && child.children.length === 1 ? child.children[0] : null;
        const classes = code?.type === "element" && code.tagName === "code" ? code.properties.className : null;
        if (Array.isArray(classes) && classes.includes("language-math")) {
          return { type: "element", tagName: "div", properties: { dataMathSource: hastText(child).replace(/\n$/, "") }, children: [child] };
        }
        visit(child);
        return child;
      });
    };
    visit(tree);
  };
}

/** GitHub's heading slugs for `#fragment` links, as a data attribute: two rendered documents never share an id. */
function markdownHeadingAnchors() {
  return (tree: HastRoot) => {
    const seen = new Map<string, number>();
    const visit = (node: HastRoot | HastElement) => node.children.forEach((child) => {
      if (child.type !== "element") return;
      if (/^h[1-6]$/.test(child.tagName)) {
        const base = hastText(child).toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, "").replace(/ /g, "-");
        let slug = base;
        while (seen.has(slug)) {
          const count = (seen.get(base) ?? 0) + 1;
          seen.set(base, count);
          slug = `${base}-${count}`;
        }
        seen.set(slug, 0);
        child.properties = child.properties ?? {};
        child.properties.dataHeadingAnchor = slug;
        if (child.position?.start.line) child.properties.dataHeadingSourceLine = child.position.start.line;
      }
      visit(child);
    });
    visit(tree);
  };
}

// A document whose `#fragment` links lead to its headings (Settings › Skills).
export const markdownDocumentRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  markdownHeadingAnchors,
  rehypeDisplayMathSource,
  [rehypeKatex, katexOptions],
];

export const markdownPreviewRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  markdownHeadingAnchors,
  [rehypeKatex, katexOptions],
];

/**
 * Light cleanup for MathType / Word / 定稿 exports that often break TeX slightly.
 * Does not rewrite valid LaTeX; only common broken tokens.
 */
export function normalizeMathMarkdown(source: string): string {
  return source
    // Some converters turn "\\times" into "|times"
    .replace(/\|(times|leq|geq|neq|approx|pm|mp|cdot|cdots|ldots)\b/g, "\\$1")
    // \tag{2-5} is fine in KaTeX display; ensure blank line before $$ blocks is ok
    .replace(/([^\n])\n(\$\$)/g, "$1\n\n$2")
    .replace(/(\$\$)\n([^\n])/g, "$1\n\n$2");
}
