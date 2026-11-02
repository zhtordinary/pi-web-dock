import { createHash } from "node:crypto";
import { entryToUiMessage, getSessionBranchEntries } from "./session-reader";
import type { SessionEntry } from "./types";
import { isSessionPeerMessage } from "./session-peer-message";

export type HistorySource = { sessionId: string; entries: SessionEntry[]; leafId: string | null };
export const RESULT_CHAR_BUDGET = 48_000;
export const HISTORY_CHAR_BUDGET = RESULT_CHAR_BUDGET - 4_000;
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function historyEntries(source: HistorySource) {
  // Reader's branch resolver and entry converter are the shared source of identity/content.
  return getSessionBranchEntries(source.entries, source.leafId).flatMap(entry => {
    // display=false remains a UI hint only for the one Reader-owned peer
    // category. Other extension custom messages retain the SDK's hidden
    // history contract and are not made readable by this tool.
    if (entry.type === "custom_message" && !entry.display && !isSessionPeerMessage(entry)) return [];
    const message = entryToUiMessage(entry, { deferThinking: false, deferToolResultImages: false, deferToolResultText: false });
    return message ? [{ entry, message }] : [];
  });
}
export function snapshotId(source: HistorySource): string {
  const hash = createHash("sha256").update(source.sessionId).update(source.leafId ?? "");
  for (const entry of getSessionBranchEntries(source.entries, source.leafId)) hash.update(JSON.stringify(entry)).update("\n");
  return hash.digest("hex");
}
export function blocksOf(message: unknown): unknown[] {
  if (!record(message)) return [];
  if (Array.isArray(message.content)) return message.content;
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  if (message.role === "bashExecution") return [{ type: "text", text: String(message.command ?? "") }, { type: "text", text: String(message.output ?? "") }];
  return [];
}
export function blockText(block: unknown, includeThinking: boolean): { type: string; text: string } | null {
  if (!record(block)) return null;
  if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
  if (block.type === "thinking" && typeof block.thinking === "string" && includeThinking) return { type: "thinking", text: block.thinking };
  if (block.type === "toolCall") return { type: "toolCall", text: JSON.stringify(block.input ?? block.arguments ?? {}) };
  return null;
}
function integer(value: unknown, fallback: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) throw new Error(`${name} is out of range`);
  return value as number;
}
export function readHistoryEntry(source: HistorySource, params: Record<string, unknown>) {
  if (typeof params.entryId !== "string" || !params.entryId) throw new Error("entryId is required");
  const row = historyEntries(source).find(row => row.entry.id === params.entryId);
  if (!row) throw new Error("entry is not readable on the current branch");
  const blockIndex = integer(params.blockIndex, 0, Number.MAX_SAFE_INTEGER, "blockIndex");
  const block = blocksOf(row.message)[blockIndex];
  if (!block) throw new Error("blockIndex does not exist");
  const identity = { sessionId: source.sessionId, entryId: row.entry.id, blockIndex, snapshotId: snapshotId(source) };
  if (record(block) && block.type === "image") return { ...identity, contentType: "image", omitted: true, reason: "image payloads are not exported" };
  const content = blockText(block, params.includeThinking === true);
  if (!content) throw new Error("unsupported block type or thinking not explicitly enabled");
  const chars = Array.from(content.text);
  const offset = integer(params.offset, 0, chars.length, "offset");
  let length = integer(params.limit, 4000, 12000, "limit");
  if (!length) throw new Error("limit must be positive");
  const build = () => ({ ...identity, contentType: content.type, offset, text: chars.slice(offset, offset + length).join(""), originalLength: chars.length, nextOffset: offset + length < chars.length ? offset + length : null, hasMore: offset + length < chars.length });
  let result = build();
  while (JSON.stringify(result).length > HISTORY_CHAR_BUDGET && length > 1) { length = Math.max(1, Math.floor(length / 2)); result = build(); }
  return result;
}
// Lowercase expansion (for example İ) maps each folded UTF-16 unit back to its source code point.
function folded(text: string) {
  const positions: number[] = []; let value = "";
  Array.from(text).forEach((char, index) => { const lower = char.toLowerCase(); value += lower; for (let i = 0; i < lower.length; i++) positions.push(index); });
  return { value, positions };
}
export function searchHistory(source: HistorySource, params: Record<string, unknown>) {
  if (typeof params.query !== "string" || !params.query.trim() || params.query.length > 500) throw new Error("query must contain 1..500 characters");
  const query = params.query.trim(); const includeThinking = params.includeThinking === true;
  const snapshot = snapshotId(source); const binding = createHash("sha256").update(JSON.stringify([source.sessionId, snapshot, query, includeThinking])).digest("hex");
  let start = 0;
  if (params.cursor !== undefined) {
    if (typeof params.cursor !== "string" || params.cursor.length > 512) throw new Error("invalid search cursor; restart search");
    try { const cursor = JSON.parse(Buffer.from(params.cursor, "base64url").toString("utf8")); if (cursor.binding !== binding || !Number.isSafeInteger(cursor.start) || cursor.start < 0) throw new Error(); start = cursor.start; }
    catch { throw new Error("search snapshot or cursor changed; restart search"); }
  }
  const limit = integer(params.limit, 20, 50, "limit"); if (!limit) throw new Error("limit must be positive");
  const needle = folded(query).value; const results: Array<Record<string, unknown>> = []; let seen = 0; let more = false;
  outer: for (const row of historyEntries(source)) {
    const blocks = blocksOf(row.message);
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
      const content = blockText(blocks[blockIndex], includeThinking); if (!content) continue;
      const chars = Array.from(content.text); const lower = folded(content.text);
      for (let at = lower.value.indexOf(needle); at !== -1; at = lower.value.indexOf(needle, at + needle.length)) {
        if (seen++ < start) continue;
        if (results.length === limit) { more = true; break outer; }
        const offset = lower.positions[at]; const end = lower.positions[at + needle.length - 1] + 1;
        results.push({ entryId: row.entry.id, blockIndex, contentType: content.type, offset, length: end - offset, before: chars.slice(Math.max(0, offset - 60), offset).join(""), match: chars.slice(offset, end).join(""), after: chars.slice(end, end + 60).join(""), read: { entryId: row.entry.id, blockIndex, offset, includeThinking } });
      }
    }
  }
  const build = () => ({ sessionId: source.sessionId, snapshotId: snapshot, query, results, hasMore: more, nextCursor: more ? Buffer.from(JSON.stringify({ binding, start: start + results.length })).toString("base64url") : null });
  let result = build();
  while (JSON.stringify(result).length > HISTORY_CHAR_BUDGET && results.length > 1) { results.pop(); more = true; result = build(); }
  if (!results.length && start && !more) throw new Error("search cursor is beyond the available results; restart search");
  return result;
}
