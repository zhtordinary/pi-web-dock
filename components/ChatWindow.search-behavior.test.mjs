import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { historySearchSegment } from "../lib/history-search-segment.ts";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
import { createJiti } from "jiti";
const { TranscriptReader } = await createJiti(import.meta.url).import("../lib/transcript-reader.ts");
const match = { entryId: "target", blockIndex: 2, offset: 10000, matchIndex: 3, match: "needle" };
const content = { kind: "content", sessionId: "s", leafId: "leaf", revision: "rev", entryId: "target", surface: "visible", path: "/visible/2", format: "text", text: "needle after", offset: 10000, totalChars: 20000, nextOffset: 10012, previousOffset: 0 };

function searchHarness(changeQuery = false) {
  const calls = [], located = [];
  const scope = { sessionId: "s", peer: null, leafId: "leaf" };
  const ctx = {
    useCallback: (fn) => fn, sessionSearchQuery: "needle", sessionSearchQueryRef: { current: "needle" },
    sessionSearchMatchIndex: -1, historyScopeReady: true, historyLoading: false,
    historyNavigationRef: { current: 0 }, readingIntentRef: { current: "following" }, pendingHistoryRefreshRef: { current: false },
    setFollow() {},
    setSessionSearchMatchIndex: (value) => { ctx.sessionSearchMatchIndex = value; },
    setLocatedSearchMatch: (value) => located.push(value), scrollContainerRef: { current: null }, scrollSessionSearchMatch() {},
  };
  const reader = new TranscriptReader(scope);
  reader.goToEntry = async (entryId) => {
    calls.push({ kind: "window", entryId });
    if (changeQuery) ctx.sessionSearchQueryRef.current = "different";
  };
  reader.loadContent = async (request) => { calls.push({ kind: "content", ...request }); return content; };
  ctx.reader = reader;
  ctx.history = { search: { current: { query: "needle", matches: [match], before: null, after: null } } };
  vm.createContext(ctx);
  const start = source.indexOf("  const navigateSessionSearch = useCallback");
  const end = source.indexOf("\n\n", start);
  vm.runInContext(stripTypeScriptTypes(source.slice(start, end) + "\nglobalThis.navigate = navigateSessionSearch;"), ctx);
  return { ctx, calls, located };
}

test("search navigation actually requests the matching visible body block and offset", async () => {
  const h = searchHarness();
  await h.ctx.navigate(1);
  assert.deepEqual(h.calls.map((call) => call.kind), ["window", "content"]);
  assert.equal(h.calls[1].entryId, "target");
  assert.equal(h.calls[1].blockIndex, 2);
  assert.equal(h.calls[1].offset, 10000);
  assert.equal(h.calls[1].surface, "visible");
  assert.equal(h.located[0].revision, "rev");
});

test("a changed query cannot publish a stale search-content focus", async () => {
  const h = searchHarness(true);
  await h.ctx.navigate(1);
  assert.equal(h.located.length, 0);
});

test("the loaded segment selects the exact entry/block/offset, not the row's first mark", () => {
  const focused = { ...match, revision: "rev" };
  assert.deepEqual(historySearchSegment(content, focused), { key: "target:2:10000", before: "", hit: "needle", after: " after" });
  assert.equal(historySearchSegment(content, { ...focused, blockIndex: 1 }), null);
  assert.equal(historySearchSegment(content, { ...focused, revision: "older" }), null);
  assert.equal(historySearchSegment(content, { ...focused, offset: 0 }), null);
});

// Execute the production DOM effect alongside the production navigation callback.
// The stand-in DOM can expose fewer inline hits than the persisted search page;
// it deliberately does not render the separately excluded deferred-content panel.
function installHighlightEffect(h, inlineText = null) {
  const { ctx } = h;
  const parent = { tagName: "P", closest: () => null, replaceChild() { assert.fail("React text must not be replaced"); } };
  const textNode = { textContent: inlineText, parentElement: parent,
    ownerDocument: { createRange: () => ({ setStart() {}, setEnd() {} }) } };
  Object.assign(ctx, {
    useEffect: (fn) => { ctx.highlightEffect = fn; },
    searchEffectRunRef: { current: 0 }, messageContentRef: { current: null },
    session: { id: "s" }, background: false, highlightTerm: null,
    sessionSearchSessionTotal: 6, locatedSearchMatch: null, hasEarlierMessages: false,
    messages: [{ role: "user", content: inlineText ?? "bounded preview", id: "target" }],
    setSessionSearchMountedMatchCount: (value) => { ctx.mountedCount = value; },
    setSessionSearchRanges: (value) => { ctx.highlightRanges = typeof value === "function" ? value(ctx.highlightRanges ?? []) : value; },
    setTimeout: () => 1, clearTimeout() {},
    visibleMarkdownText: (text) => text,
    splitFinalAssistantBlocks: () => ({ answerBlocks: [] }),
    NodeFilter: { SHOW_TEXT: 4 },
    document: {
      createTreeWalker: () => { let seen = false; return { currentNode: textNode,
        nextNode: () => { if (seen) return false; seen = true; return true; } }; },
      createDocumentFragment: () => ({ children: [], appendChild(child) { this.children.push(child); } }),
      createElement: () => ({ dataset: {}, style: {}, replaceWith() {} }),
      createTextNode: (textContent) => ({ textContent }),
    },
  });
  ctx.scrollContainerRef.current = {
    querySelectorAll: (selector) => selector === "[data-session-searchable='true']"
      ? (inlineText === null ? [] : [parent]) : [],
    normalize() { assert.fail("React text must not be normalized"); },
  };
  const start = source.indexOf("  useEffect(() => {\n    const runId = searchEffectRunRef.current + 1;");
  const end = source.indexOf("\n  const navigateSessionSearch =", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(stripTypeScriptTypes(source.slice(start, end)), ctx);
  let cleanup;
  return () => { cleanup?.(); cleanup = ctx.highlightEffect(); };
}

for (const inlineText of [null, "one inline needle"]) {
  test(`server search cursor survives DOM highlighting with ${inlineText === null ? "only deferred hits" : "fewer mounted hits"}`, async () => {
    const h = searchHarness();
    const hits = Array.from({ length: 6 }, (_, index) => ({ ...match, offset: 10000 + index * 100, matchIndex: index }));
    const pages = [0, 3].map((offset) => ({ query: "needle", total: 6, offset,
      matches: hits.slice(offset, offset + 3), before: offset ? "before" : null, after: offset ? null : "after" }));
    h.ctx.history.search.current = pages[0];
    h.ctx.reader.nextSearchPage = async () => (h.ctx.history.search.current = pages[1]);
    h.ctx.reader.previousSearchPage = async () => (h.ctx.history.search.current = pages[0]);
    const highlight = installHighlightEffect(h, inlineText);
    highlight();
    // Render and reflow after each navigation. DOM work must neither reset nor
    // clamp the persisted cursor to the number of currently mounted marks.
    for (let index = 0; index < 5; index += 1) {
      await h.ctx.navigate(1);
      h.ctx.messages = [{ ...h.ctx.messages[0], id: `window-${index}` }];
      highlight();
      assert.equal(h.ctx.sessionSearchMatchIndex, index % 3);
    }
    assert.deepEqual(h.calls.filter((call) => call.kind === "content").map((call) => call.offset),
      [10000, 10100, 10200, 10300, 10400]);
    await h.ctx.navigate(-1);
    highlight();
    await h.ctx.navigate(-1);
    highlight();
    assert.equal(h.ctx.history.search.current.offset, 0);
    assert.equal(h.ctx.sessionSearchMatchIndex, 2);
    assert.deepEqual(h.calls.filter((call) => call.kind === "content").slice(-2).map((call) => call.offset), [10300, 10200]);
    assert.equal(h.ctx.mountedCount, inlineText === null ? 0 : 1);
    assert.equal(h.ctx.highlightRanges.length, inlineText === null ? 0 : 1);
  });
}

test("production initial state plus the real search response locates the first server hit on first Next", async () => {
  const h = searchHarness();
  const hits = Array.from({ length: 3 }, (_, index) => ({ ...match, entryId: `window-${index}`, offset: 10000 + index * 100, matchIndex: index }));
  const page = { query: "needle", total: 3, offset: 0, matches: hits, before: null, after: null };
  h.ctx.history.search.current = null;
  h.ctx.reader.searchHistory = async () => { h.ctx.history.search.current = page; return page; };
  const initial = source.match(/const \[sessionSearchMatchIndex, setSessionSearchMatchIndex\] = useState\((-?\d+)\)/);
  assert.ok(initial);
  h.ctx.sessionSearchMatchIndex = Number(initial[1]);
  Object.assign(h.ctx, { sessionSearchOpen: true,
    useEffect: fn => { h.ctx.searchEffect = fn; },
    setSessionSearchSessionTotal: value => { h.ctx.total = value; },
    setTimeout: callback => { callback(); return 1; }, clearTimeout() {},
  });
  const start = source.indexOf("  // Search is produced by the same branch projection");
  const end = source.indexOf("  useEffect(() => {\n    const runId = searchEffectRunRef.current + 1;", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(stripTypeScriptTypes(source.slice(start, end)), h.ctx);
  h.ctx.searchEffect();
  await Promise.resolve();
  const before = { index: h.ctx.sessionSearchMatchIndex, located: h.located.length, total: h.ctx.total };
  await h.ctx.navigate(1);
  assert.equal(h.calls.find(call => call.kind === "window").entryId, "window-0", "initial cursor must not skip unlocated first match");
});
