import type { UserMessage, TextContent, ImageContent } from "./types";
import type { HistoryContentOptions, HistoryContentPage, HistoryScope } from "./session-history-types";

export interface HistoryEditIntent {
  text?: string;
  transformInput?: (input: string) => string;
  sideBranchAnchor?: string;
}

/** An explicit edit may read one original message, never the whole transcript. */
export async function readHistoryEditMessage(
  identity: HistoryScope & { entryId: string },
  read: (options: HistoryContentOptions) => Promise<HistoryContentPage | null>,
  isCurrent: () => boolean,
  intent?: HistoryEditIntent,
): Promise<UserMessage> {
  const readComplete = async (surface: "source" | "input") => {
    const parts: string[] = [];
    let offset = 0;
    let total: number | undefined;
    for (;;) {
      if (!isCurrent()) throw new Error("History edit target changed");
      const page = await read({ entryId: identity.entryId, surface, path: "", offset });
      if (!isCurrent()) throw new Error("History edit target changed");
      if (!page || page.kind !== "content" || page.surface !== surface || page.path !== "" || page.format !== (surface === "source" ? "json" : "text")
        || page.sessionId !== identity.sessionId
        || page.entryId !== identity.entryId || page.offset !== offset
        || (total !== undefined && total !== page.totalChars)) throw new Error("History edit snapshot changed or is incomplete");
      if (page.totalChars > 256 * 1024 * 1024) throw new Error("History message exceeds the editable payload budget");
      total = page.totalChars;
      parts.push(page.text);
      const end = offset + page.text.length;
      if (page.nextOffset === null) {
        if (end !== total) throw new Error("History edit payload is incomplete");
        break;
      }
      if (page.nextOffset !== end || end <= offset) throw new Error("History edit continuation is invalid");
      offset = end;
    }
    return parts.join("");
  };
  const source = await readComplete("source");
  const input = await readComplete("input");
  let message: unknown;
  try {
    message = JSON.parse(source);
  } catch (cause) {
    throw new Error("History edit payload is not valid JSON", { cause });
  }
  if (!message || typeof message !== "object" || (message as UserMessage).role !== "user"
    || (typeof (message as UserMessage).content !== "string" && !Array.isArray((message as UserMessage).content))) {
    throw new Error("History edit target is not a complete user message");
  }
  const original = message as UserMessage;
  const text = intent?.text ?? intent?.transformInput?.(input) ?? input;
  if (typeof original.content === "string") return { ...original, content: text };
  const originalText = original.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  if (text === originalText) return original;
  let replaced = false;
  const content: Array<TextContent | ImageContent> = [];
  for (const block of original.content) {
    if (block.type !== "text") { content.push(block); continue; }
    if (replaced) continue;
    replaced = true;
    content.push({ ...block, text });
  }
  if (!replaced && text) content.unshift({ type: "text", text });
  return { ...original, content };
}
