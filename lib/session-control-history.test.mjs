import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "reader-history-upgrade-"));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
test.after(() => { if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir; rmSync(root, { recursive: true, force: true }); });
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { createSessionControlExtension } = await jiti.import("./session-control.ts");
function fixture(entries) {
  let tool; createSessionControlExtension().factory({ registerTool(v) { tool = v; } });
  const manager = { getEntries: () => entries, getLeafId: () => entries.at(-1)?.id ?? null, getSessionId: () => "target", getSessionFile: () => "/tmp/history.jsonl", getHeader: () => ({ id: "target", cwd: "/fixture" }), getSessionName: () => "target" };
  const session = { sessionId: "target", sessionFile: "/tmp/history.jsonl", cwd: "/fixture", inner: { sessionManager: manager }, isAlive: () => true, isRunning: () => false, onEvent: () => () => {} };
  const old = globalThis.__piSessions; globalThis.__piSessions = new Map([["target", session]]);
  return { session, restore: () => { globalThis.__piSessions = old; }, run: async params => {
    const result = await tool.execute("history-check", { target: "target", ...params }, undefined, undefined, { cwd: "/fixture", sessionManager: { getSessionId: () => "caller", getSessionFile: () => "/tmp/caller.jsonl" } });
    assert.ok(result.content[0].text.length <= 48000); return JSON.parse(result.content[0].text);
  } };
}
function entries(count, text = "x".repeat(1600)) { return Array.from({ length: count }, (_, i) => ({ type: "message", id: "e" + i, parentId: i ? "e" + (i - 1) : null, timestamp: "2026-10-03T00:00:00Z", message: { role: "user", content: text } })); }
test("size-limited history pagination never skips selected entries", async t => {
  const f = fixture(entries(100)); t.after(f.restore); const seen = []; let before;
  do { const page = await f.run({ action: "read_history", limit: 100, before }); assert.equal(page.error, undefined); seen.unshift(...page.context.entryIds); before = page.nextBefore; } while (before);
  assert.deepEqual(seen, entries(100).map(e => e.id));
});

test("custom-message display is a UI hint, not a history read permission", async t => {
  const rows = [{
    type: "custom_message",
    id: "peer-hidden",
    parentId: null,
    timestamp: "2026-10-03T00:00:00Z",
    customType: "pi-web:session-peer",
    content: "hidden peer body",
    display: false,
    details: { source: "session-control", messageId: "peer-hidden" },
  }];
  const f = fixture(rows); t.after(f.restore);
  const history = await f.run({ action: "read_history" });
  assert.deepEqual(history.context.entryIds, ["peer-hidden"]);
  assert.equal((await f.run({ action: "search_history", query: "peer body" })).results.length, 1);
});

test("unknown hidden extension custom messages remain unreadable", async t => {
  const rows = [{ type: "custom_message", id: "hidden-extension", parentId: null, timestamp: "2026-10-03T00:00:00Z", customType: "third-party", content: "secret extension body", display: false, details: { private: true } }];
  const f = fixture(rows); t.after(f.restore);
  const history = await f.run({ action: "read_history" });
  assert.deepEqual(history.context.entryIds, []);
  assert.equal((await f.run({ action: "search_history", query: "secret extension" })).results.length, 0);
});

test("precise reads preserve Unicode, tool arguments and explicit thinking", async t => {
  const text = "中文😀\\\n".repeat(1000); const rows = entries(1);
  rows[0].message = { role: "assistant", content: [{ type: "text", text }, { type: "thinking", thinking: "private thought" }, { type: "toolCall", id: "call", name: "tool", arguments: { text } }, { type: "image", data: "not-returned", mimeType: "image/png" }] };
  const f = fixture(rows); t.after(f.restore);
  const preview = await f.run({ action: "read_history" });
  assert.equal(preview.context.fieldsTruncated, true); assert.equal(preview.context.pageTruncated, false);
  assert.equal(preview.context.messages[0].entryId, "e0");
  assert.equal(preview.context.messages[0].content[0].originalLength, Array.from(text).length);
  let offset = 0, whole = "";
  do { const part = await f.run({ action: "read_entry", entryId: "e0", blockIndex: 0, offset, limit: 113 }); assert.equal(part.error, undefined); whole += part.text; offset = part.nextOffset; } while (offset !== null);
  assert.equal(whole, text);
  const args = await f.run({ action: "read_entry", entryId: "e0", blockIndex: 2, limit: 12000 }); assert.equal(JSON.parse(args.text).text, text);
  assert.match((await f.run({ action: "read_entry", entryId: "e0", blockIndex: 1 })).error, /thinking/);
  assert.equal((await f.run({ action: "read_entry", entryId: "e0", blockIndex: 1, includeThinking: true })).text, "private thought");
  assert.equal((await f.run({ action: "read_entry", entryId: "e0", blockIndex: 3 })).omitted, true);
  assert.ok((await f.run({ action: "read_entry", entryId: "missing", blockIndex: 0 })).error);
  assert.ok((await f.run({ action: "read_entry", entryId: "e0", offset: -1 })).error);
  assert.ok((await f.run({ action: "read_entry", entryId: "e0", blockIndex: 9 })).error);
  assert.ok((await f.run({ action: "read_entry", entryId: "e0", target: "caller" })).error);
});
test("compaction, empty/root pages and fork boundaries preserve chronological continuity", async t => {
  const rows = entries(20, "hello");
  rows[10] = { ...rows[10], type: "compaction", summary: "compressed", firstKeptEntryId: "e5", tokensBefore: 100 };
  rows.splice(19, 0, { type: "message", id: "other", parentId: "e0", timestamp: rows[0].timestamp, message: { role: "user", content: "unselected branch" } });
  const f = fixture(rows); t.after(f.restore); let before; const seen = [];
  do { const page = await f.run({ action: "read_history", limit: 3, before }); seen.unshift(...page.context.entryIds); before = page.nextBefore; } while (before);
  assert.deepEqual(seen, entries(20).map(e => e.id));
  assert.equal((await f.run({ action: "read_history", before: "e0" })).context.returnedMessages, 0);
  assert.ok((await f.run({ action: "read_history", before: "other" })).error);
  assert.ok((await f.run({ action: "read_entry", entryId: "other" })).error);
});
test("search pages locate raw text, tools and Unicode without crossing snapshot/branch", async t => {
  const rows = entries(3, "😀İ WORD word");
  rows[1].message = { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "word " + "z".repeat(30000) + " word" }] };
  rows[2].message = { role: "assistant", content: [{ type: "thinking", thinking: "word" }] };
  const f = fixture(rows); t.after(f.restore);
  let cursor; const hits = [];
  do { const page = await f.run({ action: "search_history", query: "word", limit: 1, cursor }); assert.equal(page.error, undefined); hits.push(...page.results); cursor = page.nextCursor; } while (cursor);
  assert.equal(hits.length, 4);
  for (const hit of hits) { const part = await f.run({ action: "read_entry", ...hit.read, limit: hit.length }); assert.equal(part.text.toLowerCase(), "word"); }
  const unicode = await f.run({ action: "search_history", query: "i", limit: 1 }); assert.equal(unicode.results[0].offset, 1); assert.equal(unicode.results[0].match, "İ");
  const withThinking = await f.run({ action: "search_history", query: "word", includeThinking: true }); assert.equal(withThinking.results.length, 5);
  assert.equal((await f.run({ action: "search_history", query: "missing" })).results.length, 0);
  const first = await f.run({ action: "search_history", query: "word", limit: 1 });
  assert.ok((await f.run({ action: "search_history", query: "changed", cursor: first.nextCursor })).error);
  rows[0].message.content = "edited";
  assert.match((await f.run({ action: "search_history", query: "word", cursor: first.nextCursor })).error, /restart/);
});
test("large blocks remain valid bounded JSON and empty histories terminate", async t => {
  const f = fixture(entries(1, "\u0001".repeat(12000))); t.after(f.restore);
  let offset = 0, joined = "";
  do { const part = await f.run({ action: "read_entry", entryId: "e0", limit: 12000, offset }); joined += part.text; offset = part.nextOffset; } while (offset !== null);
  assert.equal(joined.length, 12000);
});

test("an oversized single preview retains its locator instead of cutting JSON", async t => {
  const rows = entries(1); rows[0].message = { role: "assistant", content: Array.from({ length: 40 }, () => ({ type: "text", text: "x".repeat(1600) })) };
  const f = fixture(rows); t.after(f.restore);
  const page = await f.run({ action: "read_history" }); assert.equal(page.error, undefined);
  assert.deepEqual(page.context.entryIds, ["e0"]); assert.equal(page.context.fieldsTruncated, true);
  assert.equal(page.context.messages[0].originalBlockCount, 40);
  assert.equal((await f.run({ action: "read_entry", entryId: "e0", blockIndex: 39 })).text, "x".repeat(1600));
});
test("live context omits system messages before applying the limit", async t => {
  const f = fixture([]); t.after(f.restore);
  f.session.inner.agent = { state: { messages: [
    { role: "user", content: "visible question" },
    { role: "system", content: "private system text", sections: { preamble: "private section" } },
  ] } };
  const context = await f.run({ action: "read_context", limit: 1 });
  assert.equal(context.error, undefined);
  assert.equal(context.returnedMessages, 1);
  assert.equal(context.messages[0].role, "user");
  assert.match(JSON.stringify(context), /visible question/);
  assert.doesNotMatch(JSON.stringify(context), /private system text|private section/);
});

test("persisted context follows the same resolved leaf as history", async t => {
  const directory = join(root, "archived_sessions", "--fixture--"); mkdirSync(directory, { recursive: true });
  const at = minute => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;
  const custom = (id, parentId, minute) => ({ type: "custom", customType: "plan-mode-state", id, parentId, timestamp: at(minute), data: {} });
  const row = (id, parentId, minute, content) => ({ type: "message", id, parentId, timestamp: at(minute), message: { role: "user", content } });
  const rows = [row("u1", null, 1, "first question"), custom("main", "u1", 2), custom("side", "u1", 3), row("u2", "main", 4, "latest question"), custom("side2", "side", 5)];
  writeFileSync(join(directory, "2026-10-03_resolved-leaf-target.jsonl"), [JSON.stringify({ type: "session", version: 3, id: "resolved-leaf-target", timestamp: at(0), cwd: "/fixture" }), ...rows.map(value => JSON.stringify(value))].join("\n") + "\n");
  const f = fixture([]); t.after(f.restore);
  const history = await f.run({ action: "read_history", target: "resolved-leaf-target" });
  const context = await f.run({ action: "read_context", target: "resolved-leaf-target" });
  assert.equal(history.error, undefined); assert.equal(context.error, undefined);
  assert.deepEqual(history.context.entryIds, ["u1", "u2"]);
  assert.deepEqual(context.messages.filter(message => message.role === "user").map(message => message.content[0].text), ["first question", "latest question"]);
});

test("persisted archived sessions use the shared resolver for preview, search and precise reads", async t => {
  const directory = join(root, "archived_sessions", "--fixture--"); mkdirSync(directory, { recursive: true });
  const rows = entries(1, "archived words");
  writeFileSync(join(directory, "2026-10-03_archived-target.jsonl"), [JSON.stringify({ type: "session", version: 3, id: "archived-target", timestamp: "2026-10-03T00:00:00Z", cwd: "/fixture" }), ...rows.map(row => JSON.stringify(row))].join("\n") + "\n");
  const f = fixture([]); t.after(f.restore);
  const page = await f.run({ action: "read_history", target: "archived-target" }); assert.equal(page.error, undefined); assert.equal(page.source, "persisted-jsonl");
  assert.equal((await f.run({ action: "read_entry", target: "archived-target", entryId: "e0" })).text, "archived words");
  assert.equal((await f.run({ action: "search_history", target: "archived-target", query: "words" })).results.length, 1);
});
