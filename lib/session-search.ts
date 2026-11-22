import type { AssistantMessage, SessionInfo } from "./types";
import { splitFinalAssistantBlocks } from "./message-display";
import { visibleMarkdownText } from "./session-search-text";
import { readSessionRecap } from "./session-recap";

export interface SessionSearchResult {
  session: SessionInfo;
  entryId?: string;
  blockIndex: number;
  before: string;
  match: string;
  after: string;
}

export interface SessionSearchResponse {
  results: SessionSearchResult[];
  truncated: boolean;
}

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";

/**
 * Session-content search uses the same visible-text boundary as the find bar:
 * user text and final assistant answer text only. Tool/process details,
 * question-analysis records, metadata and oversized collapsed payloads are not
 * searchable because the opened transcript cannot locate them.
 */

const SNIPPET_RADIUS = 90;

/** Clip `t` around the first occurrence of `q`, returning a readable excerpt. */
function clipText(t: string, q: string, radius: number, prefix = ""): string {
  const ti = t.toLowerCase().indexOf(q);
  if (ti === -1) return "";
  const start = Math.max(0, ti - radius);
  const end = Math.min(t.length, ti + q.length + radius);
  return (
    prefix +
    (start > 0 ? "…" : "") +
    t.slice(start, end) +
    (end < t.length ? "…" : "")
  );
}

/** Extract visible transcript segments with the same block boundaries as MessageView. */
export function getSessionMessageTextSegments(message: { role?: string; content?: unknown } | undefined): string[] {
  if (!message) return [];
  let content = message.content;
  if (message.role === "assistant" && Array.isArray(content)) {
    content = splitFinalAssistantBlocks({ ...message, content } as AssistantMessage).answerBlocks;
  }
  const rawTexts: string[] = [];
  if (Array.isArray(content)) {
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      const part = c as { type?: string; text?: unknown };
      if (part.type === "text" && typeof part.text === "string") rawTexts.push(part.text);
    }
  } else if (typeof content === "string") {
    rawTexts.push(content);
  }
  if (message.role === "user") {
    const visible = visibleMarkdownText(rawTexts.join("\n"), { collapseSkill: true });
    return visible ? [visible] : [];
  }
  return rawTexts.map((text) => visibleMarkdownText(text)).filter(Boolean);
}

export interface SessionSearchCount {
  /** Total occurrences across visible message text and session titles. */
  matchCount: number;
  /** Occurrences inside user/assistant text; title matches are excluded. */
  contentMatchCount: number;
  /** Occurrences inside session names and persisted recap titles. */
  titleMatchCount: number;
  snippets: string[];
}

/** Match a session ID case-insensitively, including partial IDs. */
export function sessionIdMatchesQuery(sessionId: string, q: string): boolean {
  const query = q.trim().toLowerCase();
  return query.length >= 2 && sessionId.trim().toLowerCase().includes(query);
}

interface SearchAccumulator {
  snippets: string[];
  seen: Set<string>;
  matchCount: number;
  contentMatchCount: number;
  titleMatchCount: number;
}

const SEARCHABLE_MESSAGE_ROLE_RE = /"message"\s*:\s*\{\s*"role"\s*:\s*"(user|assistant)"/;
const MAX_NON_SEARCHABLE_LINE_PARSE_CHARS = 64 * 1024;
const SEARCH_CACHE_MAX_ENTRIES = 64;
const SEARCH_CACHE_MAX_CHARS = 8 * 1024 * 1024;

type SearchCacheEntry = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; text: string };
const searchCache = new Map<string, SearchCacheEntry>();
let searchCacheChars = 0;

/** Split terms without treating punctuation or regex operators specially. */
export function parseSessionSearchTerms(query: string): string[] {
  const terms: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of query.trim()) {
    if (char === '"' && (quoted || !current)) {
      if (quoted && current) terms.push(current);
      if (quoted) current = "";
      quoted = !quoted;
    } else if (!quoted && /\s/u.test(char)) {
      if (current) terms.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) terms.push(current);
  return [...new Set(terms)];
}

function emptySearchCount(): SessionSearchCount {
  return { matchCount: 0, contentMatchCount: 0, titleMatchCount: 0, snippets: [] };
}

function mergeTermCounts(states: SearchAccumulator[], terms: string[]): SessionSearchCount {
  if (states.length === 0) return emptySearchCount();
  const contentComplete = states.every((state) => state.contentMatchCount > 0);
  const titleComplete = states.every((state) => state.titleMatchCount > 0);
  if (!contentComplete && !titleComplete) return emptySearchCount();
  const useContent = contentComplete;
  const counts = states.map((state) => useContent ? state.contentMatchCount : state.titleMatchCount);
  const matchCount = Math.min(...counts);
  const contentMatchCount = useContent ? matchCount : 0;
  const titleMatchCount = useContent ? 0 : matchCount;
  const snippets: string[] = [];
  const seen = new Set<string>();
  for (const state of states) {
    for (const snippet of state.snippets) {
      if (snippets.length >= 3 || seen.has(snippet)) continue;
      seen.add(snippet);
      snippets.push(snippet);
    }
  }
  return { matchCount, contentMatchCount, titleMatchCount, snippets };
}

function recordMatches(text: string, q: string, prefix: string, state: SearchAccumulator, source: "content" | "title"): void {
  if (!q) return;
  const lower = text.toLowerCase();
  let idx = lower.indexOf(q);
  while (idx !== -1) {
    state.matchCount += 1;
    if (source === "content") state.contentMatchCount += 1;
    else state.titleMatchCount += 1;
    if (state.snippets.length < 3) {
      const snip = clipText(text, q, SNIPPET_RADIUS, prefix);
      if (snip && !state.seen.has(snip)) {
        state.seen.add(snip);
        state.snippets.push(snip);
      }
    }
    idx = lower.indexOf(q, idx + q.length);
  }
}

function countQueryInLine(line: string, q: string, state: SearchAccumulator): void {
  if (!q) return;
  // Tool-result and metadata lines can contain megabytes of output. Their role
  // is emitted near the start of normal Pi JSON, so skip oversized non-searchable
  // lines before allocating another lower-case copy or JSON object. Searchable
  // message lines must still be parsed when the query only appears after the
  // visible Markdown/skill extraction step.
  const searchableMessageLine = SEARCHABLE_MESSAGE_ROLE_RE.test(line);
  if (!searchableMessageLine && line.length > MAX_NON_SEARCHABLE_LINE_PARSE_CHARS) return;
  if (!searchableMessageLine && !line.toLowerCase().includes(q)) return;

  let obj: unknown = null;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  if (!obj || typeof obj !== "object") return;
  const record = obj as {
    type?: unknown;
    name?: unknown;
    message?: { role?: string; content?: unknown };
  };
  const message = record.message;
  if (message?.role === "user" || message?.role === "assistant") {
    for (const text of getSessionMessageTextSegments(message)) recordMatches(text, q, `${message.role}: `, state, "content");
    return;
  }

  if (record.type === "session_info" && typeof record.name === "string") {
    recordMatches(record.name, q, "title: ", state, "title");
    return;
  }
  const recapTitle = readSessionRecap(record)?.title;
  if (recapTitle) recordMatches(recapTitle, q, "title: ", state, "title");
  // All other custom/metadata rows stay outside the locatable message surface.
}

function finishSearch(state: SearchAccumulator): SessionSearchCount {
  return {
    matchCount: state.matchCount,
    contentMatchCount: state.contentMatchCount,
    titleMatchCount: state.titleMatchCount,
    snippets: state.snippets,
  };
}

/** Count query occurrences within visible message and session-title text. */
export function countQueryInSession(text: string, q: string): SessionSearchCount {
  const query = q.trim();
  if (!query) return emptySearchCount();
  const terms = parseSessionSearchTerms(query);
  // `""` is intentionally a literal query, matching the upstream search contract.
  const effectiveTerms = terms.length > 0 ? terms : [query];
  const states = effectiveTerms.map((): SearchAccumulator => ({
    snippets: [], seen: new Set(), matchCount: 0, contentMatchCount: 0, titleMatchCount: 0,
  }));
  for (const line of text.split("\n")) {
    effectiveTerms.forEach((term, index) => countQueryInLine(line, term.toLowerCase(), states[index]));
  }
  return effectiveTerms.length === 1 ? finishSearch(states[0]) : mergeTermCounts(states, effectiveTerms);
}

async function readSearchText(filePath: string): Promise<string> {
  let stamp;
  try {
    const current = await stat(filePath);
    stamp = { dev: current.dev, ino: current.ino, size: current.size, mtimeMs: current.mtimeMs, ctimeMs: current.ctimeMs };
  } catch {
    throw new Error("Session file is unavailable");
  }
  const cached = searchCache.get(filePath);
  if (cached && Object.entries(stamp).every(([key, value]) => cached[key as keyof typeof stamp] === value)) {
    return cached.text;
  }
  if (cached) {
    searchCache.delete(filePath);
    searchCacheChars -= cached.text.length;
  }

  const chunks: string[] = [];
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) chunks.push(line);
  } finally {
    lines.close();
    input.destroy();
  }
  const text = chunks.join("\n");
  // Re-stat after reading: an append or atomic replacement during the scan is
  // not stored under the earlier stamp and will be read fresh next time.
  let after;
  try {
    const current = await stat(filePath);
    after = { dev: current.dev, ino: current.ino, size: current.size, mtimeMs: current.mtimeMs, ctimeMs: current.ctimeMs };
  } catch {
    return text;
  }
  if (text.length <= SEARCH_CACHE_MAX_CHARS && Object.entries(stamp).every(([key, value]) => after[key as keyof typeof stamp] === value)) {
    while (searchCache.size >= SEARCH_CACHE_MAX_ENTRIES || searchCacheChars + text.length > SEARCH_CACHE_MAX_CHARS) {
      const oldest = searchCache.entries().next().value as [string, SearchCacheEntry] | undefined;
      if (!oldest) break;
      searchCache.delete(oldest[0]);
      searchCacheChars -= oldest[1].text.length;
    }
    if (searchCache.size < SEARCH_CACHE_MAX_ENTRIES && searchCacheChars + text.length <= SEARCH_CACHE_MAX_CHARS) {
      searchCache.set(filePath, { ...stamp, text });
      searchCacheChars += text.length;
    }
  }
  return text;
}

/** Stream a session file, reusing a bounded stamp-keyed text cache. */
export async function countQueryInSessionFile(filePath: string, q: string): Promise<SessionSearchCount> {
  if (!q.trim()) return emptySearchCount();
  return countQueryInSession(await readSearchText(filePath), q);
}
