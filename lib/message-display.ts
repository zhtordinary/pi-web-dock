import type { AgentMessage, AssistantContentBlock, AssistantMessage, ThinkingContent, ToolCallContent } from "./types";

interface DisplayOptions {
  isStreaming?: boolean;
}

export function getThinkingPreview(thinking: string): string {
  return thinking.trimStart().match(/^[^\r\n]{0,240}/u)?.[0].trimEnd() ?? "";
}

export const THINKING_PIECE_CHARS = 8_000;

/** A piece of a thinking text; `lineBreak`: a "\n" follows it there, left out of the pieces. */
export interface ThinkingPiece {
  text: string;
  lineBreak: boolean;
}

/**
 * Cuts a long thinking text at the first line break past each
 * THINKING_PIECE_CHARS characters, so the expanded block lays it out piece
 * by piece (#1196). The line break at a cut is left out: the block boundary
 * stands in for it. One that ends an empty line is never a cut. A piece with
 * no line break by twice THINKING_PIECE_CHARS is cut there, losing nothing
 * and never splitting a surrogate pair. A cut depends only on the text
 * before it, so while thinking streams only the last piece changes. Text that
 * fits one piece stays one.
 */
export function splitThinkingPieces(thinking: string): ThinkingPiece[] {
  const pieces: ThinkingPiece[] = [];
  let start = 0;
  while (thinking.length - start > THINKING_PIECE_CHARS) {
    const from = start + THINKING_PIECE_CHARS;
    const hardCut = from + THINKING_PIECE_CHARS;
    // Searched up to the hard cut only: an unbroken line is not scanned to
    // its end again for every piece.
    const window = thinking.slice(from, hardCut + 1);
    let found = window.indexOf("\n");
    // Never at a "\n" that ends an empty line: the piece would end in a line
    // break, and a block draws no line for a trailing one, so that empty line
    // would be lost.
    while (found >= 0 && /\n\r?$/.test(thinking.slice(from + found - 2, from + found))) {
      found = window.indexOf("\n", found + 1);
    }
    if (found >= 0) {
      const lineBreak = from + found;
      if (lineBreak === thinking.length - 1) break;
      pieces.push({ text: thinking.slice(start, lineBreak), lineBreak: true });
      start = lineBreak + 1;
    } else if (thinking.length > hardCut) {
      const last = thinking.charCodeAt(hardCut - 1);
      const cut = last >= 0xd800 && last <= 0xdbff ? hardCut - 1 : hardCut;
      pieces.push({ text: thinking.slice(start, cut), lineBreak: false });
      start = cut;
    } else {
      break;
    }
  }
  pieces.push({ text: thinking.slice(start), lineBreak: false });
  return pieces;
}

export function isMessageGroupAnchor(message: { role?: AgentMessage["role"]; customType?: string }): boolean {
  // A background subagent completion starts a new displayed turn, same as a
  // user message or compaction summary. Other custom messages stay inside the turn.
  return message.role === "user"
    || (message.role === "custom" && (
      message.customType === "compaction"
      || message.customType === "pi-web:subagent-notification"
    ));
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === "";
}

/**
 * Keep one active empty thinking block at the streaming tail as a progress
 * anchor, while hiding stale empty blocks from earlier protocol phases.
 */
export function isDisplayableAssistantBlock(
  block: AssistantContentBlock,
  index: number,
  blockCount: number,
  options: DisplayOptions = {},
): boolean {
  if (!isEmptyThinkingBlock(block, { isStreaming: false })) return true;
  return options.isStreaming === true && index === blockCount - 1;
}

/** Older or third-party session files may store assistant content as a plain string; read it as one text block. */
function assistantBlocks(message: AssistantMessage): AssistantContentBlock[] {
  const content: unknown = message.content;
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return Array.isArray(content) ? content as AssistantContentBlock[] : [];
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  const blocks = assistantBlocks(message);
  return blocks.filter((block, index) => isDisplayableAssistantBlock(block, index, blocks.length, options));
}

export function getAssistantErrorMessage(
  message: AssistantMessage,
  options: DisplayOptions = {},
): string | null {
  if (options.isStreaming || message.stopReason !== "error") return null;
  return message.errorMessage?.trim() || "Unknown provider error";
}

/**
 * A turn that ended on `stopReason: "length"` spent its whole output budget
 * (often on reasoning alone) and produced no final answer; without a notice it
 * looks like a hung session. The copy lives in i18n (`chat.truncatedByOutputLimit`).
 */
export function isAssistantTruncated(
  message: AssistantMessage,
  options: DisplayOptions = {},
): boolean {
  return !options.isStreaming && message.stopReason === "length";
}

/** Text, an image, or a tool call is an answer. Thinking alone is not. */
export function hasAssistantAnswer(message: AssistantMessage): boolean {
  return assistantBlocks(message).some((block) => {
    if (block.type === "text") return block.text.trim().length > 0;
    return block.type === "image" || block.type === "toolCall";
  });
}

function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" || block.type === "image";
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block));
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] };
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  };
}

export type LiveTailItem =
  | { kind: "messages"; indices: number[] }
  | { kind: "errors"; indices: number[] };

function isPureAssistantError(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return getAssistantErrorMessage(message) !== null
    && splitFinalAssistantBlocks(message).answerBlocks.length === 0;
}

/** Split a live tail into contiguous groups without changing transcript order. */
export function splitLiveTailItems(
  messages: AgentMessage[],
  startIndex: number,
  endIndex: number,
): LiveTailItem[] {
  const items: LiveTailItem[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const kind = isPureAssistantError(messages[index]) ? "errors" : "messages";
    const last = items.at(-1);
    if (last?.kind === kind) last.indices.push(index);
    else items.push({ kind, indices: [index] });
  }
  return items;
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block): block is ToolCallContent => block.type === "toolCall").length;
}
