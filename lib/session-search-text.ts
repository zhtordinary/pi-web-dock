import { unified } from "unified";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import { normalizeDisplayMath } from "./markdown";
import { skillExpansionToCommand } from "./slash-display";

export const MAX_SEARCHABLE_MARKDOWN_CHARS = 100_000;
const BLOCK_SEPARATOR = "\u0000";
const parser = unified()
  .use(remarkParse)
  .use(remarkGfm, { singleTilde: false })
  .use(remarkFrontmatter)
  .use(remarkMath, { singleDollarTextMath: true });

/**
 * Convert one Markdown message block to the text surface used by the transcript
 * find bar. Block code and Mermaid source stay out of the contract because the
 * rendered code widget is an independent, chrome-heavy surface; inline code
 * remains ordinary visible text.
 */
export function visibleMarkdownText(text: string, options: { collapseSkill?: boolean } = {}): string {
  if (options.collapseSkill) {
    const compactSkill = skillExpansionToCommand(text);
    if (compactSkill) return compactSkill;
  }
  if (text.length > MAX_SEARCHABLE_MARKDOWN_CHARS) return "";
  const tree = parser.parse(normalizeDisplayMath(stripDangerousHtmlOutsideCode(text))) as MarkdownNode;
  return visit(tree);
}

type MarkdownNode = {
  type?: string;
  value?: unknown;
  alt?: unknown;
  children?: MarkdownNode[];
};

function visit(node: MarkdownNode | undefined): string {
  if (!node || typeof node !== "object") return "";
  switch (node.type) {
    case "text":
    case "inlineCode":
      return typeof node.value === "string" ? node.value : "";
    case "image":
    case "math":
    case "inlineMath":
    case "code":
    case "yaml":
    case "toml":
    case "definition":
    case "footnoteDefinition":
    case "footnoteReference":
      return "";
    case "break":
      return "";
    case "html":
      return typeof node.value === "string"
        ? node.value
          .replace(/<\s*(script|style|iframe|object|form)\b[\s\S]*?<\/\s*\1\s*>/gi, "")
          .replace(/<[^>]+>/g, "")
        : "";
    default:
      return visitSequence(node.children ?? [], node.type);
  }
}

function stripDangerousHtmlOutsideCode(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] === "`") {
      const run = text.slice(index).match(/^`+/)?.[0] ?? "`";
      const close = text.indexOf(run, index + run.length);
      const end = close === -1 ? text.length : close + run.length;
      result += text.slice(index, end);
      index = end;
      continue;
    }
    const opening = text.slice(index).match(/^<\s*(script|style|iframe|object|form)\b[^>]*>/i);
    if (opening) {
      const tag = opening[1];
      const rest = text.slice(index + opening[0].length);
      const closing = rest.search(new RegExp(`<\\/\\s*${tag}\\s*>`, "i"));
      index = closing === -1
        ? text.length
        : index + opening[0].length + closing + rest.slice(closing).match(new RegExp(`^<\\/\\s*${tag}\\s*>`, "i"))![0].length;
      continue;
    }
    result += text[index];
    index += 1;
  }
  return result;
}

function visitSequence(children: MarkdownNode[], type: unknown): string {
  let hiddenTag: string | null = null;
  const values: string[] = [];
  for (const child of children) {
    if (child.type === "html" && typeof child.value === "string") {
      const raw = child.value;
      const closing = raw.match(/^\s*<\/\s*(script|style|iframe|object|form)\b/i);
      if (hiddenTag) {
        if (closing?.[1].toLowerCase() === hiddenTag) hiddenTag = null;
        continue;
      }
      const opening = raw.match(/<\s*(script|style|iframe|object|form)\b/i);
      if (opening) {
        const tag = opening[1].toLowerCase();
        if (!new RegExp(`<\\/\\s*${tag}\\s*>`, "i").test(raw)) hiddenTag = tag;
        continue;
      }
      values.push(raw.replace(/<[^>]+>/g, ""));
      continue;
    }
    if (hiddenTag) continue;
    values.push(visit(child));
  }
  return values.filter(Boolean).join(childrenJoiner(type));
}

function childrenJoiner(type: unknown): string {
  return type === "root"
    || type === "blockquote"
    || type === "list"
    || type === "listItem"
    || type === "table"
    || type === "tableRow"
    || type === "footnoteDefinition"
    ? BLOCK_SEPARATOR
    : "";
}
