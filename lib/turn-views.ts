import type { AssistantContentBlock, AssistantMessage } from "./types";
import { getAssistantErrorMessage, isAssistantTruncated, splitFinalAssistantBlocks } from "./message-display";
import type { WrittenFile } from "./turn-written-files";

export interface FinalAnswerViews {
  answer: AssistantMessage | null;
  process: AssistantMessage | null;
  split: ReturnType<typeof splitFinalAssistantBlocks>;
  writtenFiles?: WrittenFile[];
}

export function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  return next;
}

/**
 * Stored messages are replaced, never mutated. Keep derived views per object,
 * so a streamed chunk/notice elsewhere does not bypass MessageView's memo.
 * The streaming message itself is not cached by ChatWindow.
 */
export function getFinalAnswerViews(
  cache: WeakMap<AssistantMessage, FinalAnswerViews>,
  message: AssistantMessage,
): FinalAnswerViews {
  const cached = cache.get(message);
  if (cached) return cached;
  const split = splitFinalAssistantBlocks(message);
  const failed = split.answerBlocks.length === 0 && getAssistantErrorMessage(message) !== null;
  const answer = split.answerBlocks.length > 0 || isAssistantTruncated(message)
    ? withAssistantBlocks(message, split.answerBlocks)
    : null;
  // Keep the original prefix, not the display-filtered processBlocks: lazy
  // thinking URLs use stored block indices, including preceding empty blocks.
  const processEnd = (message.content ?? []).indexOf(split.answerBlocks[0]);
  const process = split.processBlocks.length > 0
    ? withAssistantBlocks(message, (message.content ?? []).slice(0, processEnd < 0 ? undefined : processEnd), { omitUsage: true })
    : failed ? message : null;
  const views: FinalAnswerViews = { answer, process, split };
  cache.set(message, views);
  return views;
}

/** Recompute from current results/cwd, then retain identity only for equal paths. */
export function keepWrittenFiles(views: FinalAnswerViews, next: WrittenFile[]): WrittenFile[] {
  const previous = views.writtenFiles;
  if (previous && previous.length === next.length
    && previous.every((file, index) => file.filePath === next[index].filePath)) return previous;
  views.writtenFiles = next;
  return next;
}
