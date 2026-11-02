import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

async function runSourceSlice(path, beginText, endText, exports, context) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const begin = source.indexOf(beginText);
  const end = source.indexOf(endText, begin);
  assert.ok(begin >= 0 && end > begin, "must isolate the production interaction callbacks");
  vm.createContext(context);
  vm.runInContext(stripTypeScriptTypes(source.slice(begin, end)) + `\nObject.assign(globalThis, { ${exports} });`, context);
  return source;
}

test("body quote preview stays open while entering its controls and removes only the selected quote", async () => {
  const timers = new Map();
  const removed = [];
  let modal = { quoteId: "second" };
  let preview = { quote: { id: "first" } };
  const context = {
    useRef: value => ({ current: value }), useCallback: fn => fn, useEffect() {},
    setTimeout: fn => { const id = Symbol(); timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
    setHoveredBadgeInfo: value => { preview = value; },
    setAnnotationModal: update => { modal = update(modal); },
    chatInputRef: { current: { removeQuote: id => removed.push(id) } },
  };
  const source = await runSourceSlice("./ChatWindow.tsx", "  const badgeHoverTimerRef =", "  const checkSelection =",
    "keepBadgePreviewOpen, scheduleBadgePreviewClose, handleRemoveQuote", context);
  context.scheduleBadgePreviewClose();
  assert.equal(timers.size, 1);
  assert.notEqual(preview, null, "leaving the badge must allow time to enter the preview");
  context.keepBadgePreviewOpen();
  assert.equal(timers.size, 0, "entering the preview must cancel dismissal");
  context.handleRemoveQuote("first");
  assert.deepEqual(removed, ["first"]);
  assert.equal(preview, null);
  assert.equal(modal.quoteId, "second", "another quote's editor must remain intact");
  context.handleRemoveQuote("second");
  assert.equal(modal, null, "deleting the edited quote must also close its editor");
  context.scheduleBadgePreviewClose();
  [...timers.values()][0]();
  assert.equal(preview, null);
  const popover = source.slice(source.indexOf('{hoveredBadgeInfo && typeof document'), source.indexOf('{!embeddedInParent && annotationModal?.isOpen'));
  assert.match(popover, /onMouseEnter=\{keepBadgePreviewOpen\}/);
  assert.match(popover, /onMouseLeave=\{scheduleBadgePreviewClose\}/);
  assert.match(popover, /onClick=\{\(\) => handleRemoveQuote\(hoveredBadgeInfo\.quote\.id\)\}/);
  assert.doesNotMatch(popover, /pointerEvents: "none"/);
  assert.match(popover, /<section className="quote-preview-source" aria-label=\{t\("quote\.selectedText"\)\}[\s\S]*?\{hoveredBadgeInfo\.quote\.text\}[\s\S]*?<\/section>/);
  assert.match(popover, /<section className="quote-preview-comment" aria-label=\{t\("quote\.userComment"\)\}[\s\S]*?className="quote-preview-comment-text"[\s\S]*?\{hoveredBadgeInfo\.quote\.reply \|\| t\("quote\.noComment"\)\}/);
  assert.doesNotMatch(popover, /hoveredBadgeInfo\.quote\.reply \|\| hoveredBadgeInfo\.quote\.text/, "a comment must not hide the original quote");
  assert.match(popover, /className="quote-preview-actions"[\s\S]*?<\/div>\s*<div className="quote-preview-content">/, "body previews keep actions outside the scrollable content too");
  assert.match(popover, /<span className="quote-preview-comment-label">Reply:<\/span>/);
  assert.match(popover, /overflowY: "auto"[\s\S]*?overflowX: "hidden"[\s\S]*?flexDirection: "column"/);
});

test("embedded annotation deletion requires the current parent, request and an existing quote", async () => {
  const parent = {};
  const deleted = [];
  const context = {
    window: { parent }, annotationModal: { isOpen: true, mode: "edit", quoteId: "second" },
    quoteModalRequestIdRef: { current: 7 },
    EMBEDDED_QUOTE_ANNOTATION_DELETE_EVENT: "delete",
    EMBEDDED_QUOTE_ANNOTATION_RESULT_EVENT: "confirm",
    EMBEDDED_QUOTE_ANNOTATION_CLOSE_EVENT: "close",
    handleRemoveQuote: id => deleted.push(id), handleConfirmAnnotation() {}, setAnnotationModal() {},
  };
  await runSourceSlice("./ChatWindow.tsx", "    const handleParentQuoteResult =", '    window.addEventListener("message", handleParentQuoteResult)',
    "handleParentQuoteResult", context);
  const message = { source: parent, data: { type: "delete", requestId: 7 } };
  context.handleParentQuoteResult({ ...message, source: {} });
  context.handleParentQuoteResult({ ...message, data: { type: "delete", requestId: 6 } });
  context.annotationModal.mode = "create";
  context.handleParentQuoteResult(message);
  assert.deepEqual(deleted, []);
  context.annotationModal.mode = "edit";
  context.handleParentQuoteResult(message);
  assert.deepEqual(deleted, ["second"]);
  context.annotationModal = null;
  context.handleParentQuoteResult(message);
  assert.deepEqual(deleted, ["second"], "closed editors must ignore late deletion messages");
});

test("outer annotation modal exposes deletion only for existing quotes and posts to the originating iframe", async () => {
  const sent = [];
  const context = {
    useCallback: fn => fn, URL, window: { location: { origin: "https://local.example", href: "https://local.example/" } },
    embeddedReaderUrl: "https://remote.example:30144/",
    embeddedQuoteAnnotationRef: { current: { canDelete: false, requestId: 7 } },
    embeddedIframeRef: { current: { contentWindow: { postMessage: (...args) => sent.push(args) } } },
    setEmbeddedQuoteAnnotation() {}, EMBEDDED_QUOTE_ANNOTATION_DELETE_EVENT: "delete",
  };
  const source = await runSourceSlice("./AppShell.tsx", "  const handleEmbeddedQuoteDelete =", "  const handleEmbeddedQuoteClose =",
    "handleEmbeddedQuoteDelete", context);
  context.handleEmbeddedQuoteDelete();
  assert.equal(sent.length, 0, "new annotations have nothing to delete");
  context.embeddedQuoteAnnotationRef.current.canDelete = true;
  context.handleEmbeddedQuoteDelete();
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0].type, "delete");
  assert.equal(sent[0][0].requestId, 7);
  assert.equal(sent[0][1], "https://remote.example:30144");
  assert.match(source, /canDelete: annotation\.canDelete === true/);
  assert.match(source, /onDelete=\{embeddedQuoteAnnotation\.canDelete \? handleEmbeddedQuoteDelete : undefined\}/);
  const modal = await readFile(new URL("./QuoteAnnotationModal.tsx", import.meta.url), "utf8");
  assert.match(modal, /\{onDelete && \(/);
  assert.match(modal, /onClick=\{onDelete\}/);
  assert.match(modal, /aria-label=\{t\("quote\.delete"\)\}/);
});
