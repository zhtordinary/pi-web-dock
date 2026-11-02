import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  createHistoryProjection,
  getHistoryIndex,
  getHistoryWindow,
  searchHistory,
  readHistoryContent,
  parseHistoryRequest,
  HistoryReadError,
} = await jiti.import("./session-history.ts");
const {
  HISTORY_PAGE_TURNS,
  HISTORY_PAGE_BYTES,
  HISTORY_INDEX_NODES,
  HISTORY_CONTENT_CHARACTERS,
} = await jiti.import("./session-history-types.ts");

const timestamp = "2026-10-18T00:00:00.000Z";
function message(id, parentId, role = "user", content = id) {
  return {
    type: "message", id, parentId, timestamp,
    message: role === "assistant"
      ? { role, content: [{ type: "text", text: content }], model: "test", provider: "test" }
      : { role, content },
  };
}
function transcript(size) {
  return Array.from({ length: size }, (_, index) => message(
    `e${index}`, index === 0 ? null : `e${index - 1}`,
    index % 2 === 0 ? "user" : "assistant", `message ${index}`,
  ));
}
function projection(entries, options = {}) {
  return createHistoryProjection(entries, { sessionId: "history-test", ...options });
}
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const isError = (status, code) => (error) => error instanceof HistoryReadError
  && error.status === status && (!code || error.code === code);

test("a single turn with over-budget row metadata pages every process identity exactly once", () => {
  const entries=[message('q',null)];
  for(let index=0;index<8_000;index++) entries.push({type:'message',id:`t${index}`,parentId:entries.at(-1).id,timestamp,message:{role:'toolResult',toolCallId:`call-${index}`,toolName:'read',content:[{type:'text',text:'result'}],isError:false}});
  entries.push(message('answer',entries.at(-1).id,'assistant','done'));
  const p=projection(entries),ids=[];
  let after;
  for(let pageNumber=0;pageNumber<20;pageNumber++) {
    const page=getHistoryWindow(p,{after});
    assert.ok(bytes(page)<=HISTORY_PAGE_BYTES);
    if(pageNumber===0) {assert.equal(page.items[0].entryId,'q');assert.equal(page.coverage.end,false);}
    ids.push(...page.items.map(item=>item.entryId));
    if(page.coverage.end) break;
    assert.notEqual(page.after,after);
    after=page.after;
  }
  assert.deepEqual(ids,entries.map(entry=>entry.id));
});

test("explicit root is empty; omitted leaf selects the snapshot's active branch", () => {
  const entries = [message("root", null), message("left", "root"), message("right", "root")];
  const active = projection(entries, { currentLeafId: "left" });
  assert.deepEqual(getHistoryWindow(active).items.map((item) => item.entryId), ["root", "left"]);
  const root = projection(entries, { currentLeafId: "left", leafId: null });
  assert.equal(root.leafId, null);
  assert.equal(getHistoryIndex(root).total, 0);
  assert.equal(getHistoryWindow(root).totalMessages, 0);
  assert.equal(searchHistory(root, { q: "root" }).total, 0);
  assert.throws(() => projection(entries, { leafId: "missing" }), isError(404));
  assert.throws(() => getHistoryWindow(active, { around: "right" }), isError(404));
  assert.throws(() => readHistoryContent(active, { entryId: "right", blockIndex: 0 }), isError(404));
});

test("index and windows share compaction display order, stable ids and the true first user", () => {
  const entries = [
    message("q1", null), message("a1", "q1", "assistant"),
    message("q2", "a1"), message("a2", "q2", "assistant"),
    { type: "compaction", id: "c1", parentId: "a2", timestamp,
      firstKeptEntryId: "q2", summary: "summary", tokensBefore: 100 },
    message("q3", "c1"),
    { type: "custom", id: "metadata", parentId: "q3", timestamp,
      customType: "session-recap-title:result", data: { title: "not a message" } },
  ];
  const p = projection(entries);
  const page = getHistoryWindow(p, { around: "q2" });
  assert.deepEqual(page.items.map((item) => item.entryId), ["q1", "a1", "c1", "q2", "a2", "q3"]);
  assert.equal(page.firstUserEntryId, "q1");
  assert.equal(page.leafId, "metadata", "a display-window tail must not become the selected/runtime leaf");
  const index = getHistoryIndex(p);
  assert.deepEqual(index.nodes.map((node) => node.entryId), ["q1", "c1", "q2", "q3"]);
  assert.deepEqual(index.nodes.map((node) => node.messageIndex), [0, 2, 3, 5]);
  assert.equal(index.totalMessages, page.totalMessages);
  assert.equal(index.revision, page.revision);
});

for (const size of [1_000, 10_000]) {
  test(`${size} messages: distant navigation reads a bounded target page, not its prefix`, () => {
    const p = projection(transcript(size));
    const latest = getHistoryWindow(p);
    assert.equal(latest.items.length, HISTORY_PAGE_TURNS * 2);
    assert.equal(latest.coverage.end, true);
    assert.equal(latest.coverage.start, false);
    const target = getHistoryWindow(p, { around: "e100", turns: HISTORY_PAGE_TURNS });
    assert.ok(target.items.some((item) => item.entryId === "e100"));
    assert.ok(target.items.length <= HISTORY_PAGE_TURNS * 2);
    assert.ok(target.items[0].messageIndex > 0);
    assert.equal(target.totalMessages, size);
    assert.ok(bytes(target) <= HISTORY_PAGE_BYTES);
    const index = getHistoryIndex(p, { offset: 400 });
    assert.ok(index.nodes.length <= HISTORY_INDEX_NODES);
    assert.equal(index.nodes[0].nodeIndex, 400);
    assert.equal(index.nodes[0].entryId, "e800");
    assert.ok(index.nodes.every((node) => !Object.hasOwn(node, "message")));
    assert.ok(bytes(index) <= HISTORY_PAGE_BYTES);
  });
}

test("adjacent turn cursors are exclusive and leave neither duplicates nor gaps", () => {
  const p = projection(transcript(137));
  const pages = [];
  let before;
  do {
    const page = getHistoryWindow(p, { before, turns: 10 });
    pages.unshift(page);
    before = page.before ?? undefined;
  } while (before);
  assert.deepEqual(pages.flatMap(page => page.items.map(item => item.entryId)),
    Array.from({ length: 137 }, (_, index) => `e${index}`));
  assert.equal(pages[0].coverage.start, true);
  const forward = getHistoryWindow(p, { after: pages[0].items.at(-1).entryId });
  assert.deepEqual(forward.items.map(item => item.entryId), pages[1].items.map(item => item.entryId));
  assert.equal(getHistoryWindow(p, { before: "e0" }).items.length, 0);
  assert.equal(getHistoryWindow(p, { after: "e136" }).items.length, 0);
});

test("branch search enumerates the complete locatable body and excludes titles and sibling branches", () => {
  const entries = transcript(1_000);
  entries[2].message.content = "needle needle";
  entries[801].message.content = [{ type: "text", text: "**needle** in a distant answer" }];
  entries.push(message("sibling", "e0", "user", "needle"));
  entries.push({ type: "session_info", id: "title", parentId: "e999", timestamp, name: "needle needle" });
  const p = projection(entries, { leafId: "title" });
  const first = searchHistory(p, { q: "needle", limit: 1 });
  assert.equal(first.total, 3);
  assert.equal(first.matches.length, 1);
  const second = searchHistory(p, { q: "needle", limit: 1, cursor: first.after });
  const third = searchHistory(p, { q: "needle", limit: 1, cursor: second.after });
  assert.deepEqual([first, second, third].map((page) => page.matches[0].entryId), ["e2", "e2", "e801"]);
  assert.equal(third.after, null);
  for (const page of [first, second, third]) {
    const hit = page.matches[0];
    assert.ok(getHistoryWindow(p, { around: hit.entryId }).items.some((item) => item.entryId === hit.entryId));
    assert.equal(page.revision, first.revision);
  }
  assert.equal(searchHistory(p, { q: "absent" }).total, 0);
});

test("index/search revision and cursor scope remain independent of stable body cursors", () => {
  const entries = transcript(120);
  const old = projection(entries);
  const current = projection([...entries, message("new", "e119")]);
  assert.notEqual(old.revision, current.revision);
  assert.equal(getHistoryWindow(current, { revision: old.revision }).coverage.end, true);
  const cursor = getHistoryIndex(old, { limit: 1 }).after;
  assert.throws(() => getHistoryIndex(current, { cursor }), isError(409));
  const searchCursor = searchHistory(old, { q: "message", limit: 1 }).after;
  assert.throws(() => searchHistory(old, { q: "different", cursor: searchCursor }), isError(400));
});

test("large Unicode messages are explicit continuations; every JSON response respects the UTF-8 budget", () => {
  const text = "中文🙂\u0000".repeat(90_000);
  const p = projection([message("large", null, "user", text)]);
  const window = getHistoryWindow(p);
  assert.ok(bytes(window) <= HISTORY_PAGE_BYTES);
  const item = window.items[0];
  const ref = item.deferred.find((part) => part.path === "");
  assert.ok(ref, "an omitted body must expose a continuation, not silently truncate");
  assert.ok(ref.totalChars > text.length);
  let offset = 0;
  let restored = "";
  do {
    const part = readHistoryContent(p, { entryId: "large", surface: "message", path: ref.path, offset });
    assert.ok(part.text.length <= HISTORY_CONTENT_CHARACTERS);
    assert.ok(bytes(part) <= HISTORY_PAGE_BYTES);
    assert.equal(part.text.includes("\ufffd"), false);
    restored += part.text;
    if (part.nextOffset === null) break;
    assert.ok(part.nextOffset > offset);
    offset = part.nextOffset;
  } while (true);
  assert.equal(JSON.parse(restored).content, text);
});

test("a huge tool input and result remain readable without lifting message or response limits", () => {
  const entries = [message("q", null)];
  const assistant = message("a", "q", "assistant", "running");
  assistant.message.content = [{ type: "toolCall", toolCallId: "call", toolName: "bash", input: { command: "x".repeat(500_000) } }];
  entries.push(assistant, { type: "message", id: "tool", parentId: "a", timestamp,
    message: { role: "toolResult", toolCallId: "call", content: [{ type: "text", text: "结果".repeat(500_000) }] } });
  const p = projection(entries);
  const page = getHistoryWindow(p);
  assert.ok(bytes(page) <= HISTORY_PAGE_BYTES);
  assert.deepEqual(page.items.map(item => item.entryId), ["q", "a", "tool"]);
  assert.ok(page.items.slice(1).every(item => item.message === null));
  const expanded = getHistoryWindow(p, { from: "a", to: "tool" });
  assert.ok(expanded.items.every(item => item.deferred.length > 0));
  const next = readHistoryContent(p, { entryId: "tool", surface: "source", path: "/content/0/text" });
  assert.equal(next.text, "结果".repeat(500_000).slice(0, next.text.length));
});

test("request parsing distinguishes explicit root, rejects contradictory targets and validates budgets", () => {
  assert.equal(parseHistoryRequest(new URLSearchParams("mode=window&leafId=")).leafId, null);
  assert.equal(parseHistoryRequest(new URLSearchParams("mode=window")).leafId, undefined);
  for (const query of [
    "mode=window&around=a&before=b", "mode=window&before=a&after=b",
    "mode=index&cursor=a&offset=1", "mode=window&limit=-1",
    "mode=window&limit=1.2", "mode=content&entryId=a&offset=-1", "mode=unknown",
  ]) assert.throws(() => parseHistoryRequest(new URLSearchParams(query)), isError(400), query);
});

test("entry cursors and content survive append revisions but still reject a switched branch", () => {
  const entries = transcript(6);
  const old = projection(entries);
  const current = projection([...entries, message("e6", "e5")]);
  assert.deepEqual(getHistoryWindow(current, { after: "e5", revision: old.revision, turns: 1 }).items.map(item => item.entryId), ["e6"]);
  assert.equal(readHistoryContent(current, { entryId: "e0", revision: old.revision }).text, "message 0");
  const switched = projection([...entries, message("side", "e0")], { currentLeafId: "side" });
  assert.throws(() => getHistoryWindow(switched, { after: "e5", revision: old.revision }), isError(404, "history_entry_not_on_branch"));
  assert.throws(() => readHistoryContent(switched, { entryId: "e5", revision: old.revision }), isError(404, "history_entry_not_on_branch"));
});

test("turn pages retain a thousand process identities without bodies and expand without gaps", () => {
  const entries = [message("old-q", null), message("old-a", "old-q", "assistant"), message("q", "old-a")];
  for (let index = 0; index < 1000; index++) entries.push({
    type: "message", id: `t${index}`, parentId: index ? `t${index - 1}` : "q", timestamp,
    message: { role: "toolResult", toolCallId: `call-${index}`, toolName: "bash", content: [{ type: "text", text: "private process body" }] },
  });
  entries.push(message("answer", "t999", "assistant", "complete answer"));
  const p = projection(entries);
  const page = getHistoryWindow(p, { turns: 1 });
  assert.deepEqual(page.items.filter(item => item.message).map(item => item.entryId), ["q", "answer"]);
  assert.equal(JSON.stringify(page).includes("private process body"), false);
  const process = page.items.filter(item => item.process);
  assert.equal(process.length, 1000);
  assert.deepEqual(process.map(item => item.entryId), Array.from({length:1000},(_,i)=>`t${i}`));
  assert.equal(page.before, "q");
  const older = getHistoryWindow(p, { turns: 1, before: page.before });
  assert.deepEqual(older.items.map(item => item.entryId), ["old-q", "old-a"]);
  assert.equal(older.coverage.start, true);
  const expanded = [];
  let after;
  do {
    const part = getHistoryWindow(p, { from: process[0].entryId, to: process.at(-1).entryId, after });
    expanded.push(...part.items.map(item => item.entryId));
    after = part.after ?? undefined;
  } while (after);
  assert.deepEqual(expanded, Array.from({ length: 1000 }, (_, i) => `t${i}`));
});

test("ordinary long text is complete; oversized messages have one transparent full-message continuation", () => {
  const text = "完整🙂".repeat(5000);
  const page = getHistoryWindow(projection([message("q", null, "user", text)]));
  assert.equal(page.items[0].message.content, text);
  assert.deepEqual(page.items[0].deferred, []);
  const huge = text.repeat(50);
  const p = projection([message("q", null, "user", huge)]);
  const item = getHistoryWindow(p).items[0];
  assert.deepEqual(item.deferred.map(ref => ref.path), [""]);
  let restored = "";
  let offset = 0;
  do {
    const part = readHistoryContent(p, { entryId: "q", surface: "message", path: "", offset });
    restored += part.text;
    if (part.nextOffset === null) break;
    offset = part.nextOffset;
  } while (true);
  assert.equal(JSON.parse(restored).content, huge);
});

test("range bounds and pagination parameters are checked before a source is read", () => {
  for (const query of ["mode=window&turns=0", "mode=window&from=a", "mode=window&to=b", "mode=window&from=a&to=b&turns=1", "mode=window&from=a&to=b&before=c", "mode=index&turns=1"]) {
    assert.throws(() => parseHistoryRequest(new URLSearchParams(query)), isError(400), query);
  }
  const p = projection(transcript(6));
  assert.throws(() => getHistoryWindow(p, { from: "e4", to: "e1" }), isError(400));
  assert.throws(() => getHistoryWindow(p, { from: "e1", to: "e4", after: "e5" }), isError(400));
  assert.throws(() => getHistoryWindow(p, { from: "e1", to: "missing" }), isError(404, "history_entry_not_on_branch"));
});

test("mixed final thinking/answer and controls keep display order without leaking collapsed text", () => {
  const entries = [message("q", null)];
  const answer = message("a", "q", "assistant", "answer");
  answer.message.content.unshift({ type: "thinking", thinking: "hidden reasoning" });
  entries.push(answer, { type: "compaction", id: "c", parentId: "a", timestamp, firstKeptEntryId: "next", summary: "compacted", tokensBefore: 100 }, message("next", "c"));
  const p = projection(entries);
  const page = getHistoryWindow(p, { turns: 1, before: "c" });
  assert.deepEqual(page.items.map(item => item.entryId), ["q", "a"]);
  assert.deepEqual(page.items[1].message.content, [{ type: "text", text: "answer" }]);
  assert.equal(JSON.stringify(page).includes("hidden reasoning"), false);
  assert.deepEqual(page.items.filter(item => item.process).map(item => item.entryId), ["a"]);
  const expanded = getHistoryWindow(p, { from: "a", to: "a" });
  assert.equal(expanded.items[0].message.content[0].thinking, "hidden reasoning");
  const latest = getHistoryWindow(p, { turns: 1 });
  assert.deepEqual(latest.items.map(item => item.entryId), ["c", "next"]);
});

test("byte budget shrinks whole turns, retaining complete long text and cursor progress", () => {
  const entries = transcript(100);
  for (const entry of entries) if (entry.message.role === "user") entry.message.content = "文".repeat(35_000);
  const p = projection(entries);
  const seen = [];
  let before;
  do {
    const page = getHistoryWindow(p, { turns: 50, before });
    assert.ok(bytes(page) <= HISTORY_PAGE_BYTES);
    assert.equal(page.items[0].message.role, "user");
    assert.equal(page.items.at(-1).message.role, "assistant");
    for (const item of page.items) if (item.message.role === "user") assert.equal(item.message.content.length, 35_000);
    seen.unshift(...page.items.map(item => item.entryId));
    assert.notEqual(page.before, before);
    before = page.before ?? undefined;
  } while (before);
  assert.deepEqual(seen, entries.map(entry => entry.id));
});

test("byte-budget contraction never removes the around target's long tool turn", () => {
  const entries = [];
  let parent = null;
  for (let turn = 0; turn < 6; turn++) {
    const question = message(`q${turn}`, parent, "user", "x".repeat(100_000));
    entries.push(question); parent = question.id;
    if (turn === 5) for (let index = 0; index < 100; index++) {
      const id = `tool-${index}`;
      entries.push({ type: "message", id, parentId: parent, timestamp,
        message: { role: "toolResult", toolCallId: `call-${index}`, toolName: "read", content: [{ type: "text", text: "small" }] } });
      parent = id;
    }
    const reply = message(`a${turn}`, parent, "assistant", "x".repeat(100_000));
    entries.push(reply); parent = reply.id;
  }
  const p = projection(entries);
  for (const target of ["q5", "tool-50", "a5"]) {
    const page = getHistoryWindow(p, { around: target, turns: 6 });
    assert.ok(bytes(page) <= HISTORY_PAGE_BYTES);
    assert.ok(page.items.some(item => item.entryId === "q5"), `budget discarded the target question for ${target}`);
    assert.ok(page.items.some(item => item.entryId === "a5"), `budget discarded the target answer for ${target}`);
    assert.equal(page.items.filter(item => item.process).at(-1).entryId, "tool-99");
  }
});

test("automatic oversized answer restoration does not fetch collapsed thinking", () => {
  const reply = message("a", "q", "assistant", "A".repeat(140_000));
  reply.message.content.unshift({ type: "thinking", thinking: "H".repeat(2_000_000) });
  const p = projection([message("q", null), reply]);
  const page = getHistoryWindow(p);
  const item = page.items.find(item => item.entryId === "a");
  assert.equal(item.deferred.length, 1);
  const restore = surface => {
    const parts = []; let offset = 0;
    for (;;) {
      const content = readHistoryContent(p, { entryId: "a", surface, path: "", offset });
      parts.push(content.text);
      if (content.nextOffset === null) return JSON.parse(parts.join(""));
      offset = content.nextOffset;
    }
  };
  const visible = restore(item.deferred[0].surface ?? "message");
  assert.deepEqual(visible.content, [{ type: "text", text: "A".repeat(140_000) }], "automatic answer recovery must preserve its visible projection");
  const full = restore("message");
  assert.equal(full.content[0].thinking.length, 2_000_000, "explicit process expansion must still recover the complete source entry");
  assert.equal(full.content[1].text.length, 140_000);
});

test("whole-turn budget fallback keeps an answer inside a process range on its answer surface", () => {
  const reply = message("a", "q", "assistant", "A".repeat(100_000));
  reply.message.content.unshift({ type: "thinking", thinking: "H".repeat(2_000_000) });
  const entries = [message("q", null), reply, { type: "message", id: "t", parentId: "a", timestamp,
    message: { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "small" }] } }];
  for (let index = 0; index < 10; index++) entries.push({ type: "custom_message", id: `c${index}`, parentId: index ? `c${index - 1}` : "t", timestamp,
    customType: "fixture", display: true, content: "C".repeat(100_000) });
  const p = projection(entries), page = getHistoryWindow(p);
  assert.ok(bytes(page) <= HISTORY_PAGE_BYTES);
  assert.deepEqual(page.items.filter(item => item.process).map(item => item.entryId), ["a", "t"]);
  const field = page.items.find(item => item.entryId === "a").deferred[0];
  assert.equal(field.surface, "answer");
  const parts = []; let offset = 0;
  for (;;) {
    const content = readHistoryContent(p, { entryId: "a", surface: field.surface, path: "", offset });
    assert.equal(content.totalChars, field.totalChars, "the declared projection and continuation length must agree");
    parts.push(content.text);
    if (content.nextOffset === null) break;
    offset = content.nextOffset;
  }
  assert.deepEqual(JSON.parse(parts.join("")).content, [{ type: "text", text: "A".repeat(100_000) }]);
  assert.ok(readHistoryContent(p, { entryId: "a", surface: "message", path: "" }).totalChars > 2_000_000,
    "the explicit process endpoint must still retain thinking");
});

test("a live process suffix returns an ordered placeholder even without a visible body", () => {
  const entries = [message("q", null), { type: "message", id: "t", parentId: "q", timestamp,
    message: { role: "toolResult", toolCallId: "call", toolName: "bash", content: [{ type: "text", text: "running" }] } }];
  const page = getHistoryWindow(projection(entries), { after: "q", turns: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].entryId, "t");
  assert.equal(page.items[0].message, null);
  assert.equal(page.coverage.end, true);
});

test("compaction and branch-summary control anchors do not hide the answer preceding them", () => {
  const entries = [message("q", null), message("a", "q", "assistant", "before control"),
    { type: "compaction", id: "c", parentId: "a", timestamp, firstKeptEntryId: "missing", summary: "control", tokensBefore: 1 },
    message("resumed", "c", "assistant", "after compaction"),
    { type: "branch_summary", id: "branch", parentId: "resumed", timestamp, summary: "returned branch" },
    message("last", "branch", "assistant", "after branch")];
  const page = getHistoryWindow(projection(entries), { turns: 1 });
  assert.deepEqual(page.items.map(item => item.entryId), entries.map(entry => entry.id));
  assert.equal(Object.hasOwn(page, "processSummaries"), false);
});
