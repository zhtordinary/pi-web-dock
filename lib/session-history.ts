import { createHash } from "node:crypto";
import type { AgentMessage, AssistantMessage, SessionEntry } from "./types";
import { entryToUiMessage, getSessionDisplayEntries } from "./session-reader";
import { getSessionMessageTextSegments } from "./session-search";
import { formatUserQuestion, sessionDisplayInputs } from "./session-hover-preview";
import { findFinalAssistantIndex, isResponseTurnAnchor } from "./response-duration";
import { splitFinalAssistantBlocks } from "./message-display";
import { historyOrderKeys, historyClientMessageIds } from "./transcript-order";
import { historyImageUrl, readBase64ImageBlock } from "./session-history-media";
import {
  HISTORY_CONTENT_CHARACTERS,
  HISTORY_INDEX_NODES,
  HISTORY_INLINE_MESSAGE_BYTES,
  HISTORY_PAGE_BYTES,
  HISTORY_PAGE_MESSAGES,
  HISTORY_PAGE_TURNS,
  HISTORY_MAX_TURNS,
  HISTORY_PREVIEW_CHARACTERS,
  HISTORY_SEARCH_MATCHES,
  type HistoryContentOptions,
  type HistoryContentPage,
  type HistoryDeferredContent,
  type HistoryIndexOptions,
  type HistoryIndexPage,
  type HistoryNode,
  type HistoryQuestionAnchor,
  type HistoryOrderKey,
  type HistoryPage,
  type HistoryRequest,
  type HistoryScope,
  type HistorySearchOptions,
  type HistorySearchPage,
  type HistoryWindowItem,
  type HistoryWindowOptions,
  type HistoryWindowPage,
} from "./session-history-types";

export class HistoryReadError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly revision?: string,
  ) {
    super(message);
    this.name = "HistoryReadError";
  }
}

export interface HistoryProjection extends HistoryScope {
  readonly requestedLeafId?: string | null;
  readonly entries: readonly SessionEntry[];
  readonly positions: ReadonlyMap<string, number>;
  readonly orderKeys: ReadonlyMap<string, HistoryOrderKey>;
  readonly clientMessageIds: ReadonlyMap<string, string>;
  readonly nodes: readonly HistoryNode[];
  readonly questions: readonly HistoryQuestionAnchor[];
  readonly displayInputs: ReadonlyMap<string, string>;
  readonly firstUserEntryId: string | null;
}

interface ProjectionOptions {
  sessionId: string;
  leafId?: string | null;
  currentLeafId?: string | null;
  /** Derived from the same read snapshot, never from a second stat of the file. */
  sourceRevision?: string;
}

const MAX_QUERY_CHARACTERS = 256;
const MAX_STRUCTURE_ITEMS = 64;
const MAX_POINTER_CHARACTERS = 2048;
const MAX_STRUCTURE_DEPTH = 12;
const SNIPPET_CHARACTERS = 90;

function badRequest(message: string): never {
  throw new HistoryReadError(400, "history_invalid_request", message);
}

function integer(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum) badRequest("Invalid history count or offset");
  return Math.min(value, maximum);
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function assertBudget<T extends HistoryPage>(page: T): T {
  if (byteLength(page) > HISTORY_PAGE_BYTES) {
    throw new HistoryReadError(413, "history_response_too_large", "History response exceeds its byte budget");
  }
  return page;
}

function scope(projection: HistoryProjection): HistoryScope {
  return { sessionId: projection.sessionId, leafId: projection.leafId, revision: projection.revision };
}

function assertRevision(projection: HistoryProjection, revision?: string): void {
  if (revision !== undefined && revision !== projection.revision) {
    throw new HistoryReadError(409, "history_revision_changed", "History snapshot changed", projection.revision);
  }
}

/** End offsets never bisect a UTF-16 surrogate pair. */
function textBoundary(text: string, end: number): number {
  if (end > 0 && end < text.length) {
    const before = text.charCodeAt(end - 1);
    const after = text.charCodeAt(end);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) return end - 1;
  }
  return end;
}

function clip(text: string, count: number): string {
  return text.slice(0, textBoundary(text, Math.min(count, text.length)));
}

function messageForEntry(projection: Pick<HistoryProjection, "displayInputs">, entry: SessionEntry): AgentMessage {
  const message = entryToUiMessage(entry, {});
  if (!message) throw new HistoryReadError(500, "history_invalid_projection", "History entry is not displayable");
  const input = projection.displayInputs.get(entry.id);
  if (message.role !== "user" || input === undefined) return message;
  if (typeof message.content === "string") return { ...message, content: input };
  // Keep media at its physical block index: image URLs address the original entry.
  let replaced = false;
  const content = message.content.map((block) => {
    if (block.type !== "text") return block;
    const text = replaced ? "" : input;
    replaced = true;
    return { ...block, text };
  });
  if (!replaced) content.push({ type: "text", text: input });
  return { ...message, content };
}

function rawPreview(entry: SessionEntry, displayInputs: ReadonlyMap<string, string>): string {
  if (entry.type === "compaction") return clip(entry.summary, HISTORY_PREVIEW_CHARACTERS);
  if (entry.type === "branch_summary") return clip(entry.summary, HISTORY_PREVIEW_CHARACTERS);
  if (entry.type !== "message" || entry.message.role !== "user") return "";
  let text = displayInputs.get(entry.id);
  if (text === undefined) {
    const content = entry.message.content;
    if (typeof content === "string") text = clip(content, 8192);
    else {
      text = "";
      for (const block of content.slice(0, MAX_STRUCTURE_ITEMS)) {
        if (block.type === "text") text += `${clip(block.text, 8192 - text.length)}\n`;
        if (text.length >= 8192) break;
      }
    }
  }
  return clip(formatUserQuestion(clip(text, 8192), 2), HISTORY_PREVIEW_CHARACTERS);
}

/** A display-only parent chain. No SessionManager navigation or JSONL write occurs. */
export function createHistoryProjection(entries: SessionEntry[], options: ProjectionOptions): HistoryProjection {
  const leafId = options.leafId !== undefined
    ? options.leafId
    : options.currentLeafId !== undefined ? options.currentLeafId : entries.at(-1)?.id ?? null;
  if (leafId !== null && !entries.some((entry) => entry.id === leafId)) {
    throw new HistoryReadError(404, "history_leaf_not_found", "Selected history branch does not exist");
  }
  const selected = getSessionDisplayEntries(entries, leafId);
  const displayInputs = sessionDisplayInputs(entries);
  const orderKeys = historyOrderKeys(entries);
  const clientMessageIds = historyClientMessageIds(entries);
  const hash = createHash("sha256").update(JSON.stringify({
    sessionId: options.sessionId, leafId, source: options.sourceRevision ?? null,
  }));
  const positions = new Map<string, number>();
  const nodes: HistoryNode[] = [];
  const questions: HistoryQuestionAnchor[] = [];
  let firstUserEntryId: string | null = null;
  for (let index = 0; index < selected.length; index += 1) {
    const entry = selected[index];
    positions.set(entry.id, index);
    // Trusted source fingerprints already version immutable SDK/disk records.
    // Synthetic callers without a fingerprint hash entries separately, never a full-array JSON string.
    hash.update("\n").update(options.sourceRevision === undefined ? JSON.stringify(entry) : entry.id);
    const input = displayInputs.get(entry.id);
    if (options.sourceRevision === undefined && input !== undefined) hash.update("\ninput:").update(JSON.stringify(input));
    const question = entry.type === "message" && entry.message.role === "user";
    if (question && firstUserEntryId === null) firstUserEntryId = entry.id;
    if (!question && entry.type !== "compaction" && entry.type !== "branch_summary") continue;
    const preview = rawPreview(entry, displayInputs);
    const questionIndex = question ? questions.length : undefined;
    if (questionIndex !== undefined) questions.push({ entryId: entry.id, messageIndex: index, questionIndex, preview });
    nodes.push({
      entryId: entry.id,
      nodeIndex: nodes.length,
      orderKey: orderKeys.get(entry.id)!,
      messageIndex: index,
      kind: question ? "question" : entry.type === "compaction" ? "compaction" : "branch_summary",
      questionIndex, preview,
    });
  }
  // Imported/assistant-only transcripts still have a stable navigation target.
  if (nodes.length === 0 && selected.length > 0) {
    nodes.push({ entryId: selected[0].id, orderKey: orderKeys.get(selected[0].id)!, nodeIndex: 0, messageIndex: 0, kind: "message", preview: "" });
  }
  return {
    sessionId: options.sessionId, leafId, revision: hash.digest("base64url"),
    requestedLeafId: options.leafId, entries: selected, positions, orderKeys, clientMessageIds, nodes, questions, displayInputs, firstUserEntryId,
  };
}

interface Cursor {
  kind: "index" | "search";
  revision: string;
  offset: number;
  query?: string;
}

function cursor(projection: HistoryProjection, kind: Cursor["kind"], offset: number, query?: string): string {
  return Buffer.from(JSON.stringify({ kind, revision: projection.revision, offset, query }), "utf8").toString("base64url");
}

function pageOffset(projection: HistoryProjection, kind: Cursor["kind"], options: HistoryIndexOptions, query?: string): number {
  assertRevision(projection, options.revision);
  if (options.cursor !== undefined && options.offset !== undefined) badRequest("Use cursor or offset, not both");
  if (options.cursor === undefined) return integer(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  let decoded: Cursor;
  try {
    if (options.cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(options.cursor)) throw new Error("cursor");
    decoded = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")) as Cursor;
    if (!decoded || typeof decoded.revision !== "string" || decoded.kind !== kind || decoded.query !== query || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) {
      throw new Error("cursor");
    }
  } catch {
    return badRequest("Invalid history cursor");
  }
  assertRevision(projection, decoded.revision);
  return decoded.offset;
}

export function getHistoryIndex(projection: HistoryProjection, options: HistoryIndexOptions = {}): HistoryIndexPage {
  const limit = integer(options.limit, HISTORY_INDEX_NODES, 1, HISTORY_INDEX_NODES);
  const offset = Math.min(pageOffset(projection, "index", options), projection.nodes.length);
  const nodes = projection.nodes.slice(offset, offset + limit);
  return assertBudget({
    ...scope(projection), kind: "index", nodes, total: projection.nodes.length,
    totalMessages: projection.entries.length, offset,
    before: offset > 0 ? cursor(projection, "index", Math.max(0, offset - limit)) : null,
    after: offset + nodes.length < projection.nodes.length ? cursor(projection, "index", offset + nodes.length) : null,
  });
}

function deferredValue(value: unknown, path: string, previewChars: number): HistoryDeferredContent {
  const { format, text } = contentValue(value);
  return { path, format, totalChars: text.length, previewChars };
}

interface HistoryContentValue { format: "text" | "json"; text: string }

function contentValue(value: unknown): HistoryContentValue {
  if (typeof value === "string") return { format: "text", text: value };
  const text = JSON.stringify(value);
  if (text === undefined) throw new HistoryReadError(404, "history_content_not_found", "Content is not serializable");
  return { format: "json", text };
}

/** Only oversized whole messages are deferred; ordinary text is never field-clipped. */
function deferredMessage(message: AgentMessage, surface: "message" | "answer" = "message"): { message: AgentMessage; deferred: HistoryDeferredContent[] } {
  let placeholder: AgentMessage;
  switch (message.role) {
    case "assistant": placeholder = { role: "assistant", content: [], model: clip(message.model ?? "", 128), provider: clip(message.provider ?? "", 128) }; break;
    case "toolResult": placeholder = { role: "toolResult", toolCallId: clip(message.toolCallId, 256), content: [] }; break;
    case "bashExecution": placeholder = { role: "bashExecution", command: clip(message.command, 128), output: "" }; break;
    case "custom": placeholder = { role: "custom", customType: clip(message.customType, 128), display: message.display, content: "" }; break;
    default: placeholder = { role: "user", content: "" };
  }
  return { message: placeholder, deferred: [{ ...deferredValue(message, "", 0), surface }] };
}

function messageWithMedia(projection: HistoryProjection, entry: SessionEntry): AgentMessage {
  const message = messageForEntry(projection, entry);
  if (message.role === "bashExecution" || typeof message.content === "string") return message;
  const content = message.content.map((block, blockIndex) => {
    const image = readBase64ImageBlock(block);
    return image ? { type: "image", source: { type: "url", media_type: image.mime, url: historyImageUrl(projection, entry.id, blockIndex, projection.requestedLeafId) } } : block;
  });
  // SAFETY: only image blocks change, retaining their physical source indices.
  return { ...message, content } as AgentMessage;
}

function turnAnchorForMessage(projection: HistoryProjection, messageIndex: number): HistoryQuestionAnchor | null {
  let low = 0;
  let high = projection.questions.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (projection.questions[middle].messageIndex <= messageIndex) low = middle + 1;
    else high = middle;
  }
  return projection.questions[low - 1] ?? null;
}

function windowItem(projection: HistoryProjection, entry: SessionEntry, messageIndex: number, message = messageWithMedia(projection, entry), answerOnly = false): HistoryWindowItem {
  const body = byteLength(message) <= HISTORY_INLINE_MESSAGE_BYTES
    ? { message, deferred: [] } : deferredMessage(message, answerOnly ? "answer" : "message");
  return { entryId: entry.id, orderKey: projection.orderKeys.get(entry.id)!, clientMessageId: projection.clientMessageIds.get(entry.id),
    role: message.role, sourceType: entry.type, messageIndex, turnAnchor: turnAnchorForMessage(projection, messageIndex),
    contentState: answerOnly ? "answer" : "full", process: false,
    toolCallCount: message.role === "assistant" && Array.isArray(message.content) ? message.content.filter(block => block.type === "toolCall").length : 0, ...body };
}

function nodeOffsetForMessage(projection: HistoryProjection, messageIndex: number): number {
  let low = 0;
  let high = projection.nodes.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (projection.nodes[middle].messageIndex <= messageIndex) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

function position(projection: HistoryProjection, entryId: string): number {
  const index = projection.positions.get(entryId);
  if (index === undefined) throw new HistoryReadError(404, "history_entry_not_on_branch", "Entry is not on the selected history branch");
  return index;
}

interface WindowSlice {
  start: number;
  end: number;
  items: HistoryWindowItem[];
}

function turnStarts(projection: HistoryProjection): number[] {
  const starts = [0];
  for (const question of projection.questions) {
    let start = question.messageIndex;
    // Compaction cards immediately before a question belong to that visible page.
    while (start > 0 && projection.entries[start - 1].type === "compaction") start -= 1;
    if (start > starts[starts.length - 1]) starts.push(start);
  }
  return starts;
}

function collapsedTurn(projection: HistoryProjection, start: number, end: number, turnStart: number, turnEnd: number): WindowSlice {
  const messages = projection.entries.slice(turnStart, turnEnd).map(entry => messageWithMedia(projection, entry));
  const finals = new Set<number>();
  let groupStart = -1;
  for (let index = 0; index <= messages.length; index++) {
    if (index === messages.length || isResponseTurnAnchor(messages[index])) {
      const final = findFinalAssistantIndex(messages, groupStart, index);
      if (final >= 0) finals.add(final + turnStart);
      groupStart = index;
    }
  }
  const slice: WindowSlice = { start, end, items: [] };
  for (let index = start; index < end; index++) {
    const entry = projection.entries[index];
    const message = messages[index - turnStart];
    const split = message.role === "assistant" && finals.has(index) ? splitFinalAssistantBlocks(message) : null;
    const process = message.role === "toolResult" || message.role === "bashExecution"
      || (message.role === "assistant" && (!finals.has(index) || !!split?.processBlocks.length));
    const answer = split && process && split.answerBlocks.length > 0;
    const item = windowItem(projection, entry, index, answer ? { ...message, content: split.answerBlocks } as AssistantMessage : message, Boolean(answer));
    item.process = process;
    item.toolCallCount = message.role === "assistant" && Array.isArray(message.content) ? message.content.filter(block => block.type === "toolCall").length : 0;
    if (process && !answer) { item.message = null; item.contentState = "placeholder"; item.deferred = []; }
    slice.items.push(item);
  }
  return slice;
}

export function getHistoryWindow(projection: HistoryProjection, options: HistoryWindowOptions = {}): HistoryWindowPage {
  const targets = [options.around, options.before, options.after].filter(value => value !== undefined);
  if (targets.length > 1 || targets.some(value => value.trim() === "")) badRequest("Use one nonempty history window target");
  const range = options.from !== undefined || options.to !== undefined;
  if (range && (!options.from || !options.to || options.around !== undefined || options.before !== undefined || options.turns !== undefined)) {
    badRequest("Process expansion requires from/to and optionally after/limit");
  }
  if (options.turns !== undefined && options.limit !== undefined) badRequest("Use turns or limit, not both");
  const total = projection.entries.length;
  let start: number;
  let end: number;
  let target: number | undefined;
  const slices: WindowSlice[] = [];
  if (range) {
    const first = position(projection, options.from!);
    end = position(projection, options.to!) + 1;
    if (first >= end) badRequest("Process range is reversed");
    start = options.after === undefined ? first : position(projection, options.after) + 1;
    if (start < first || start > end) badRequest("Process continuation is outside its range");
    const limit = integer(options.limit, HISTORY_PAGE_MESSAGES, 1, HISTORY_PAGE_MESSAGES);
    for (let index = start; index < Math.min(end, start + limit); index++) {
      slices.push({ start: index, end: index + 1, items: [windowItem(projection, projection.entries[index], index)] });
    }
  } else {
    const count = integer(options.turns ?? options.limit, HISTORY_PAGE_TURNS, 1, HISTORY_MAX_TURNS);
    const starts = turnStarts(projection);
    const turnAt = (index: number) => Math.max(0, starts.findLastIndex(value => value <= index));
    start = 0; end = total;
    let first: number;
    let last: number;
    if (options.before !== undefined) {
      end = position(projection, options.before);
      last = end === 0 ? -1 : turnAt(end - 1);
      first = Math.max(0, last - count + 1);
    } else if (options.after !== undefined) {
      start = position(projection, options.after) + 1;
      first = turnAt(start);
      last = Math.min(starts.length - 1, first + count - 1);
    } else {
      target = options.around === undefined ? undefined : position(projection, options.around);
      first = target === undefined ? Math.max(0, starts.length - count)
        : Math.max(0, Math.min(turnAt(target) - Math.floor(count / 2), starts.length - count));
      last = Math.min(starts.length - 1, first + count - 1);
    }
    for (let turn = first; turn <= last; turn++) {
      const turnStart = starts[turn];
      const turnEnd = starts[turn + 1] ?? total;
      const from = Math.max(start, turnStart);
      const to = Math.min(end, turnEnd);
      if (from < to) slices.push(collapsedTurn(projection, from, to, turnStart, turnEnd));
    }
  }
  const rangeEnd = end;
  const makePage = (): HistoryWindowPage => {
    const first = slices[0]?.start ?? start;
    const last = slices.at(-1)?.end ?? end;
    return {
      ...scope(projection), kind: "window", items: slices.flatMap(slice => slice.items),
      totalMessages: total, firstUserEntryId: projection.firstUserEntryId,
      lastUserEntryId: projection.questions.at(-1)?.entryId ?? null,
      nodeCount: projection.nodes.length, nodeOffset: nodeOffsetForMessage(projection, first),
      before: first > 0 ? projection.entries[first]?.id ?? null : null,
      after: last < (range ? rangeEnd : total) ? projection.entries[last - 1]?.id ?? null : null,
      coverage: { start: first === 0, end: last === total },
    };
  };
  let page = makePage();
  while (byteLength(page) > HISTORY_PAGE_BYTES && slices.length > 1) {
    let removeEnd = range || options.after !== undefined;
    if (target !== undefined) {
      const first = slices[0], last = slices.at(-1)!;
      removeEnd = target < last.start && (target < first.end || target - first.start < last.end - 1 - target);
    }
    if (removeEnd) slices.pop(); else slices.shift();
    page = makePage();
  }
  if (byteLength(page) > HISTORY_PAGE_BYTES) {
    for (const slice of slices) for (const item of slice.items) {
      if (item.message && !item.deferred.length) Object.assign(item, deferredMessage(item.message, item.contentState === "answer" ? "answer" : "message"));
    }
    page = makePage();
  }
  if (byteLength(page) > HISTORY_PAGE_BYTES && slices[0]?.items.length > 1) {
    const slice = slices[0], all = slice.items;
    const focus = target === undefined ? 0 : Math.max(0, all.findIndex(item => item.messageIndex! >= target));
    const take = (count: number) => {
      const first = target === undefined ? 0 : Math.max(0, Math.min(focus - Math.floor(count / 2), all.length - count));
      slice.items = all.slice(first, first + count);
      slice.start = slice.items[0].messageIndex!;
      slice.end = slice.items.at(-1)!.messageIndex! + 1;
      return makePage();
    };
    let low = 1, high = all.length, best = 1;
    while (low <= high) {
      const count = Math.floor((low + high) / 2);
      if (byteLength(take(count)) <= HISTORY_PAGE_BYTES) { best = count; low = count + 1; }
      else high = count - 1;
    }
    page = take(best);
  }
  return assertBudget(page);
}

function literalPattern(query: string): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
}

export function searchHistory(projection: HistoryProjection, options: HistorySearchOptions): HistorySearchPage {
  const query = options.q.trim();
  if (query.length > MAX_QUERY_CHARACTERS) badRequest("History query is too long");
  const limit = integer(options.limit, HISTORY_SEARCH_MATCHES, 1, HISTORY_SEARCH_MATCHES);
  const offset = pageOffset(projection, "search", options, query);
  const matches: HistorySearchPage["matches"] = [];
  let total = 0;
  if (query !== "") {
    for (let messageIndex = 0; messageIndex < projection.entries.length; messageIndex += 1) {
      const entry = projection.entries[messageIndex];
      const message = messageForEntry(projection, entry);
      if (message.role !== "user" && message.role !== "assistant") continue;
      const segments = getSessionMessageTextSegments(message);
      for (let blockIndex = 0; blockIndex < segments.length; blockIndex += 1) {
        const text = segments[blockIndex];
        for (const match of text.matchAll(literalPattern(query))) {
          const matchIndex = total++;
          if (matchIndex < offset || matches.length >= limit) continue;
          const index = match.index;
          matches.push({
            entryId: entry.id, messageIndex, blockIndex, offset: index, matchIndex,
            before: text.slice(Math.max(0, index - SNIPPET_CHARACTERS), index),
            match: match[0], after: text.slice(index + match[0].length, index + match[0].length + SNIPPET_CHARACTERS),
          });
        }
      }
    }
  }
  return assertBudget({
    ...scope(projection), kind: "search", query, matches, total, offset,
    before: offset > 0 ? cursor(projection, "search", Math.max(0, offset - limit), query) : null,
    after: offset + matches.length < total ? cursor(projection, "search", offset + matches.length, query) : null,
  });
}

function valueAtPointer(message: AgentMessage, path: string): HistoryContentValue {
  if (path === "") return contentValue(message);
  if (!path.startsWith("/") || path.length > MAX_POINTER_CHARACTERS) badRequest("Invalid content pointer");
  const parts = path.slice(1).split("/");
  if (parts.length > MAX_STRUCTURE_DEPTH + 1) badRequest("Content pointer is too deep");
  let value: unknown = message;
  for (const part of parts) {
    if (/~(?![01])/.test(part)) badRequest("Invalid content pointer escape");
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) {
      throw new HistoryReadError(404, "history_content_not_found", "Message content field does not exist");
    }
    value = (value as Record<string, unknown>)[key];
  }
  return contentValue(value);
}

function blockPointer(message: AgentMessage, blockIndex: number): string {
  if (message.role === "bashExecution") {
    if (blockIndex !== 0) badRequest("Invalid content block index");
    return "/output";
  }
  if (typeof message.content === "string") {
    if (blockIndex !== 0) badRequest("Invalid content block index");
    return "/content";
  }
  const block = message.content[blockIndex];
  if (!block) throw new HistoryReadError(404, "history_content_not_found", "Content block does not exist");
  if (block.type === "text") return `/content/${blockIndex}/text`;
  if (block.type === "thinking") return `/content/${blockIndex}/thinking`;
  if (block.type === "toolCall") return `/content/${blockIndex}/input`;
  return `/content/${blockIndex}`;
}

export function readHistoryContent(projection: HistoryProjection, options: HistoryContentOptions): HistoryContentPage {
  const entry = projection.entries[position(projection, options.entryId)];
  const surface = options.surface ?? "source";
  let message = surface === "message" || surface === "answer" ? messageWithMedia(projection, entry) : surface === "source" && entry.type === "message" && entry.message.role === "user"
    ? entry.message as AgentMessage
    : surface === "source" ? entryToUiMessage(entry, {}) : messageForEntry(projection, entry);
  if (!message) throw new HistoryReadError(404, "history_content_not_found", "Message is unavailable");
  if (surface === "answer") {
    if (message.role !== "assistant") badRequest("Answer content requires an assistant message");
    message = { ...message, content: splitFinalAssistantBlocks(message).answerBlocks };
  }
  if (options.path !== undefined && options.blockIndex !== undefined) badRequest("Use path or blockIndex, not both");
  let path: string;
  let value: HistoryContentValue;
  if (surface === "message" || surface === "answer") {
    if (options.blockIndex !== undefined || (options.path !== undefined && options.path !== "")) badRequest("Message content uses the complete message root");
    path = "";
    value = contentValue(message);
  } else if (surface === "input") {
    if (message.role !== "user" || options.blockIndex !== undefined || (options.path !== undefined && options.path !== "")) badRequest("Input content requires a user message root");
    path = "";
    value = { format: "text", text: projection.displayInputs.get(entry.id) ?? (typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")) };
  } else if (surface === "visible") {
    if (options.path !== undefined) badRequest("Visible content uses a blockIndex, not a source pointer");
    const blockIndex = integer(options.blockIndex, 0, 0, Number.MAX_SAFE_INTEGER);
    const segments = message.role === "user" || message.role === "assistant" ? getSessionMessageTextSegments(message) : [];
    const text = segments[blockIndex];
    if (text === undefined) throw new HistoryReadError(404, "history_content_not_found", "Visible text block does not exist");
    path = `/visible/${blockIndex}`;
    value = { format: "text", text };
  } else {
    path = options.path ?? blockPointer(message, integer(options.blockIndex, 0, 0, Number.MAX_SAFE_INTEGER));
    value = valueAtPointer(message, path);
  }
  const { format, text } = value;
  const limit = integer(options.limit, HISTORY_CONTENT_CHARACTERS, 2, HISTORY_CONTENT_CHARACTERS);
  const requestedOffset = integer(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  if (requestedOffset > text.length) badRequest("Invalid content offset");
  const offset = textBoundary(text, requestedOffset);
  const end = textBoundary(text, Math.min(text.length, offset + limit));
  return assertBudget({
    ...scope(projection), kind: "content", entryId: entry.id, surface, path, format,
    text: text.slice(offset, end), offset, totalChars: text.length,
    previousOffset: offset > 0 ? textBoundary(text, Math.max(0, offset - limit)) : null,
    nextOffset: end < text.length ? end : null,
  });
}

/** Parse and reject conflicting forms before resolving a session or reading a file. */
export function parseHistoryRequest(params: URLSearchParams): HistoryRequest {
  const read = (name: string): string | undefined => {
    if (params.getAll(name).length > 1) badRequest(`Duplicate history parameter: ${name}`);
    const value = params.get(name);
    if (value === null) return undefined;
    if (value.length > (name === "cursor" ? 4096 : MAX_POINTER_CHARACTERS)) badRequest(`History parameter is too long: ${name}`);
    return value;
  };
  const count = (name: string, minimum: number): number | undefined => {
    const raw = read(name);
    if (raw === undefined) return undefined;
    if (!/^\d+$/.test(raw)) return badRequest(`Invalid history integer: ${name}`);
    return integer(Number(raw), minimum, minimum, Number.MAX_SAFE_INTEGER);
  };
  const target = (name: string): string | undefined => {
    const value = read(name);
    if (value !== undefined && value.trim() === "") badRequest(`History parameter must not be empty: ${name}`);
    return value;
  };
  const mode = read("mode") ?? "window";
  const rawLeaf = read("leafId");
  const common = {
    leafId: rawLeaf === undefined ? undefined : rawLeaf.trim() || null,
    revision: target("revision"), limit: count("limit", 1),
  };
  const around = target("around");
  const before = target("before");
  const after = target("after");
  const from = target("from");
  const to = target("to");
  const turns = count("turns", 1);
  const pageCursor = target("cursor");
  const offset = count("offset", 0);
  if ([around, before, after].filter((value) => value !== undefined).length > 1) badRequest("History targets are mutually exclusive");
  if (pageCursor !== undefined && offset !== undefined) badRequest("Use cursor or offset, not both");
  if (mode !== "window" && [around, before, after].some((value) => value !== undefined)) badRequest("Window target is not valid for this mode");
  if (mode !== "window" && [from, to, turns].some(value => value !== undefined)) badRequest("Turn/range options require window mode");
  if (turns !== undefined && common.limit !== undefined) badRequest("Use turns or limit, not both");
  if ((from !== undefined || to !== undefined) && (!from || !to || around !== undefined || before !== undefined || turns !== undefined)) badRequest("Process expansion requires from/to and optionally after/limit");
  switch (mode) {
    case "index": return { ...common, mode, cursor: pageCursor, offset };
    case "window":
      if (pageCursor !== undefined || offset !== undefined) badRequest("Use an entry target for a body window");
      return { ...common, mode, around, before, after, turns, from, to };
    case "search": {
      const q = read("q") ?? "";
      if (q.length > MAX_QUERY_CHARACTERS) badRequest("History query is too long");
      return { ...common, mode, q, cursor: pageCursor, offset };
    }
    case "content": {
      const entryId = target("entryId");
      if (!entryId) return badRequest("Content entryId is required");
      if (pageCursor !== undefined) badRequest("Content uses an offset, not a cursor");
      const path = read("path");
      const blockIndex = count("blockIndex", 0);
      if (path !== undefined && blockIndex !== undefined) badRequest("Use path or blockIndex, not both");
      const surface = read("surface");
      if (surface !== undefined && surface !== "source" && surface !== "visible" && surface !== "input" && surface !== "message" && surface !== "answer") badRequest("Invalid content surface");
      if (surface === "visible" && path !== undefined) badRequest("Visible content uses a blockIndex, not a source pointer");
      if ((surface === "input" || surface === "message" || surface === "answer") && (blockIndex !== undefined || (path !== undefined && path !== ""))) badRequest("Input content uses the message root");
      if (common.limit === 1) badRequest("Content limit must allow a complete Unicode character");
      return { ...common, mode, entryId, path, blockIndex, offset, surface };
    }
    default: return badRequest("Unknown history mode");
  }
}

export function readHistoryPage(projection: HistoryProjection, request: HistoryRequest): HistoryPage {
  switch (request.mode) {
    case "index": return getHistoryIndex(projection, request);
    case "window": return getHistoryWindow(projection, request);
    case "search": return searchHistory(projection, request);
    case "content": return readHistoryContent(projection, request);
  }
}
