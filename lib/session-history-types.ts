import type { AgentMessage, SessionEntry } from "./types";

/** Shared transport and residency budgets; these are not browser heap measurements. */
export const HISTORY_PAGE_MESSAGES = 50;
export const HISTORY_PAGE_TURNS = 10;
export const HISTORY_MAX_TURNS = 50;
export const HISTORY_WINDOW_PAGES = 3;
export const HISTORY_PAGE_BYTES = 1024 * 1024;
export const HISTORY_INDEX_NODES = 200;
export const HISTORY_SEARCH_MATCHES = 50;
export const HISTORY_CONTENT_CHARACTERS = 32 * 1024;
export const HISTORY_PREVIEW_CHARACTERS = 160;
export const HISTORY_INLINE_MESSAGE_BYTES = 128 * 1024;

export interface HistoryScope {
  sessionId: string;
  /** The actual snapshot leaf, not the last entry in a returned body window. */
  leafId: string | null;
  revision: string;
}

export type HistoryOrderKey = readonly [appendOrdinal: number, phase: number, sourceOrdinal: number];

export interface HistoryNode {
  entryId: string;
  orderKey: HistoryOrderKey;
  nodeIndex: number;
  messageIndex: number;
  kind: "question" | "compaction" | "branch_summary" | "message";
  questionIndex?: number;
  preview: string;
}

export interface HistoryDeferredContent {
  /** Window continuations automatically recover the complete message or its visible answer. */
  surface?: "message" | "answer";
  path: string;
  format: "text" | "json";
  totalChars: number;
  previewChars: number;
}

export interface HistoryQuestionAnchor {
  entryId: string;
  messageIndex: number;
  questionIndex: number;
  preview: string;
}

export interface HistoryWindowItem {
  entryId: string;
  orderKey: HistoryOrderKey;
  clientMessageId?: string;
  role: AgentMessage["role"];
  sourceType: SessionEntry["type"];
  messageIndex?: number;
  turnAnchor: HistoryQuestionAnchor | null;
  message: AgentMessage | null;
  contentState: "placeholder" | "answer" | "full";
  process: boolean;
  toolCallCount: number;
  deferred: HistoryDeferredContent[];
}

/** A local expansion request addresses existing rows, not a second representation of them. */
export interface HistoryProcessRange {
  firstEntryId: string;
  lastEntryId: string;
}

export interface HistoryIndexPage extends HistoryScope {
  kind: "index";
  nodes: HistoryNode[];
  total: number;
  totalMessages: number;
  offset: number;
  before: string | null;
  after: string | null;
}

export interface HistoryWindowPage extends HistoryScope {
  kind: "window";
  items: HistoryWindowItem[];
  totalMessages: number;
  firstUserEntryId: string | null;
  lastUserEntryId: string | null;
  /** Seek a bounded node page without first fetching every node. */
  nodeCount: number;
  nodeOffset: number;
  before: string | null;
  after: string | null;
  coverage: { start: boolean; end: boolean };
}

export interface HistorySearchMatch {
  entryId: string;
  messageIndex: number;
  /** Position in the same visible-text block projection used to count matches. */
  blockIndex: number;
  offset: number;
  matchIndex: number;
  before: string;
  match: string;
  after: string;
}

export interface HistorySearchPage extends HistoryScope {
  kind: "search";
  query: string;
  matches: HistorySearchMatch[];
  total: number;
  offset: number;
  before: string | null;
  after: string | null;
}

export interface HistoryContentPage extends HistoryScope {
  kind: "content";
  entryId: string;
  surface: "source" | "visible" | "input" | "message" | "answer";
  path: string;
  format: "text" | "json";
  text: string;
  offset: number;
  totalChars: number;
  previousOffset: number | null;
  nextOffset: number | null;
}

export interface HistoryReadOptions {
  limit?: number;
  revision?: string;
}

export interface HistoryIndexOptions extends HistoryReadOptions {
  cursor?: string;
  offset?: number;
}

export interface HistoryWindowOptions extends HistoryReadOptions {
  /** Defaults to HISTORY_PAGE_TURNS; limit is accepted as a legacy count alias. */
  turns?: number;
  /** Inclusive process expansion bounds; after advances only within this range. */
  from?: string;
  to?: string;
  around?: string;
  before?: string;
  after?: string;
}

export interface HistorySearchOptions extends HistoryIndexOptions {
  q: string;
}

export interface HistoryContentOptions extends HistoryReadOptions {
  entryId: string;
  /** Visible blocks use search offsets; source fields retain their original Markdown/JSON. */
  /** message restores all UI blocks; answer preserves a collapsed final-answer projection. */
  surface?: "source" | "visible" | "input" | "message" | "answer";
  path?: string;
  blockIndex?: number;
  offset?: number;
}

interface HistoryRequestScope {
  /** undefined selects the snapshot's active branch; null explicitly selects root. */
  leafId?: string | null;
}

export type HistoryRequest = HistoryRequestScope & (
  | ({ mode: "index" } & HistoryIndexOptions)
  | ({ mode: "window" } & HistoryWindowOptions)
  | ({ mode: "search" } & HistorySearchOptions)
  | ({ mode: "content" } & HistoryContentOptions)
);

export type HistoryPage = HistoryIndexPage | HistoryWindowPage | HistorySearchPage | HistoryContentPage;

export interface HistoryErrorResponse {
  error: string;
  code: string;
  revision?: string;
}
