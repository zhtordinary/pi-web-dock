import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import ts from "typescript";

test("QuoteAnnotationModal keeps IME confirmation Enter out of annotation submit", async () => {
  const source = await readFile(new URL("./QuoteAnnotationModal.tsx", import.meta.url), "utf8");
  assert.match(source, /handleExtensionDialogInputKeyDown\(\s*e\.nativeEvent,/);
  assert.match(source, /getExtensionDialogInputCompositionEndAtOnBlur/);
  assert.match(source, /onCompositionStart=\{\(\) => \{/);
  assert.match(source, /onCompositionEnd=\{\(\) => \{/);
});

test("QuoteAnnotationModal renders read-only quote preview, reply textarea, and confirm button", async () => {
  const source = await readFile(new URL("./QuoteAnnotationModal.tsx", import.meta.url), "utf8");

  // Read-only quote preview with border styling
  assert.match(source, /borderLeft:/, "must style quote preview with left border");
  assert.match(source, /\{quoteText\}/, "must render original quote text");

  // Reply textarea and generic placeholder
  assert.match(source, /<textarea/, "must render reply textarea");
  assert.match(source, /placeholder=\{placeholder\}/, "must set reply placeholder");
  assert.match(source, /const placeholder = t\("quote\.replyPlaceholder"\);/, "must use a generic reply placeholder");
  assert.doesNotMatch(source, /targetName|回复 \$\{/, "must not personalize the reply placeholder");

  // Confirm button and keyboard actions
  assert.match(source, /onConfirm\(trimmed\)/, "must invoke onConfirm with trimmed reply");
  assert.match(source, /e\.key === "Enter" && !e\.shiftKey/, "must submit on Enter without Shift");
  assert.match(source, /e\.key === "Escape"/, "must close modal on Escape");
  assert.match(source, /role="dialog"/, "must have accessible dialog role");
  assert.match(source, /aria-modal="true"/, "must mark modal dialog");

  // Add the annotation to the composer, rather than send a message
  assert.match(source, /<MessageSquarePlus size=\{13\}/, "must use a conversation icon in the heading");
  assert.doesNotMatch(source, /<Quote\b/, "must not render redundant quote icons");
  assert.match(source, /\{t\("quote\.keyboardHint"\)\}/, "must describe Enter as adding the annotation");
  assert.match(source, /aria-label=\{t\("quote\.add"\)\}/, "must label the action as add for assistive technology");
  assert.match(source, /title=\{canSubmit \? t\("quote\.addTitle"\)/, "must describe the enabled action as add");
  assert.match(source, /<Plus size=\{12\}/, "must use an add icon for the action");
  assert.match(source, /<span>\{t\("quote\.add"\)\}<\/span>/, "must label the button as add");
  assert.doesNotMatch(source, /发送|<Send\b|确认提问/, "must not imply immediate message delivery");
});

test("QuoteCardGroup renders individual cards horizontally with drag reordering and hover popover", async () => {
  const source = await readFile(new URL("./QuoteCardGroup.tsx", import.meta.url), "utf8");

  // Individual cards layout and drag-to-reorder
  assert.match(source, /data-quotes-group="true"/, "must mark quotes group container");
  assert.match(source, /quotes\.map/, "must render each quote as an individual card");
  assert.match(source, /\[\{num\}\]/, "must render numbered badges [1], [2] on each card");
  assert.match(source, /draggable=\{!isEditing\}/, "must support dragging quote cards to reorder");
  assert.match(source, /onReorderQuotes\?\.\(dragQuoteIdx, index\)/, "must dispatch reorder callback when dropped");

  // Hover popover on each card
  assert.match(source, /isHovered && !isEditing/, "must show popover on hover");
  assert.doesNotMatch(source, /所选文本:/, "must omit the redundant selected-text heading");
  assert.ok(source.includes('<span className="quote-preview-comment-label">Reply:</span>{" "}'), "must keep the reply label inline");
  assert.match(source, /\{quote\.reply \|\| t\("quote\.noComment"\)\}/, "must render complete user reply");

  // Actions on card and popover
  assert.match(source, /onEditQuote/, "must support onEditQuote callback");
  assert.match(source, /onRemoveQuote/, "must support onRemoveQuote callback");
  assert.match(source, /onJumpToQuote/, "must support onJumpToQuote navigation callback");
});

test("ChatWindow manages quote highlights, badges, badge tooltips, and annotation modals", async () => {
  const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

  // Ranges and their visual decorations must leave message text under React ownership.
  const layer = await readFile(new URL("./TranscriptHighlights.tsx", import.meta.url), "utf8");
  assert.match(source, /findQuoteHighlights/, "must locate quote ranges");
  assert.match(source, /<TranscriptHighlights/, "must render the separate highlight layer");
  assert.match(layer, /data-reader-quote-mark/, "must display highlighted text");
  assert.match(layer, /data-reader-quote-badge/, "must render the numbered quote badge");
  assert.match(layer, /reader-quote-badge/, "must have badge CSS class");

  // Badge tooltip with full user reply
  assert.match(source, /hoveredBadgeInfo/, "must track hoveredBadgeInfo state");
  assert.match(source, /\{hoveredBadgeInfo\.quote\.text\}/, "must render the original text even when a comment is present");
  assert.match(source, /hoveredBadgeInfo\.quote\.reply \|\| t\("quote\.noComment"\)/, "must render the full comment or its empty state separately");

  // Modal integration
  assert.match(source, /<QuoteAnnotationModal/, "must mount QuoteAnnotationModal");
  assert.match(source, /handleConfirmAnnotation/, "must handle annotation confirmation");
  assert.match(source, /handleJumpToQuote/, "must implement smooth jump to quote position");
  assert.match(source, /handleEditQuote/, "must support opening edit modal from badge and card");
});

test("ChatInput and ChatWindow support segregated image and quote groups with drag reordering and code-block quote highlighting", async () => {
  const chatInputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

  // ChatInput image and quote segregation and reordering
  assert.match(chatInputSource, /data-image-group="true"/, "must group attached images in image group");
  assert.match(chatInputSource, /reorderImages/, "must implement reorderImages callback");
  assert.match(chatInputSource, /handleReorderQuotes/, "must implement handleReorderQuotes callback");
  assert.match(chatInputSource, /onReorderQuotes=\{handleReorderQuotes\}/, "must pass reorder callback to QuoteCardGroup");

  // ChatWindow code block and cross-block quote highlighting
  assert.match(chatWindowSource, /startSnippet/, "must calculate startSnippet for boundary matching");
  assert.match(chatWindowSource, /endSnippet/, "must calculate endSnippet for boundary matching");
  assert.match(chatWindowSource, /quoteNodeRanges/, "must locate cross-node highlights without replacing message text");
  assert.match(chatWindowSource, /function quoteBlockAncestor/, "must distinguish inline Markdown nodes from block boundaries");

  // Ensure code blocks are not excluded from quote highlighting:
  const syntax = ts.createSourceFile("ChatWindow.tsx", chatWindowSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const applyHighlights = syntax.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "findQuoteHighlights");
  assert.ok(applyHighlights, "must isolate the quote-highlighting helper, excluding adjacent history renderers");
  const applyHighlightsSnippet = applyHighlights.getText(syntax);
  assert.match(applyHighlightsSnippet, /quoteBlockAncestor/, "must join text across inline Markdown elements without a false line break");
  assert.match(applyHighlightsSnippet, /lastBlockParent/, "must track rendered block boundaries rather than every parent element");
  assert.doesNotMatch(applyHighlightsSnippet, /lastParent && lastParent !== parent/, "must not treat inline parent changes as block boundaries");
  assert.doesNotMatch(
    applyHighlightsSnippet,
    /data-session-search-exclude/,
    "findQuoteHighlights must NOT exclude code blocks with data-session-search-exclude",
  );
});


test("cross-inline quote ranges preserve the original message text nodes", async () => {
  const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const start = source.indexOf("const QUOTE_BLOCK_TAGS");
  const end = source.indexOf("function HistorySearchContent(", start);
  assert.ok(start >= 0 && end > start);
  const row = { tagName: "DIV", getAttribute: (name) => name === "data-entry-id" ? "entry" : null };
  const paragraph = { tagName: "P", parentElement: row, replaceChild() { assert.fail("React text must not be replaced"); } };
  const strong = { tagName: "STRONG", parentElement: paragraph, replaceChild() { assert.fail("React text must not be replaced"); } };
  const document = {
    createRange: () => ({ setStart(node, offset) { this.start = [node, offset]; }, setEnd(node, offset) { this.end = [node, offset]; } }),
    createTreeWalker: () => { let index = -1; return { get currentNode() { return nodes[index]; }, nextNode: () => ++index < nodes.length }; },
  };
  const nodes = [
    { textContent: "alpha ", parentElement: paragraph, ownerDocument: document },
    { textContent: "beta", parentElement: strong, ownerDocument: document },
  ];
  const container = { querySelectorAll: () => [row], normalize() { assert.fail("React text must not be normalized"); } };
  row.parentElement = container;
  const find = new Function("document", "NodeFilter", stripTypeScriptTypes(source.slice(start, end)) + "; return findQuoteHighlights;")(document, { SHOW_TEXT: 4 });
  assert.deepEqual(find(container, []), []);
  const result = find(container, [{ id: "q", text: "alpha beta", sourceEntryId: "entry" }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].ranges.length, 2);
  assert.deepEqual(result[0].ranges.map((range) => [range.start[0], range.start[1], range.end[1]]),
    [[nodes[0], 0, 6], [nodes[1], 0, 4]]);
  assert.deepEqual(nodes.map((node) => node.textContent), ["alpha ", "beta"]);
});

test("quote modal focuses the comment end and inserts newlines at the current selection", async () => {
  const vm = await import("node:vm");
  const { stripTypeScriptTypes } = await import("node:module");
  const source = await readFile(new URL("./QuoteAnnotationModal.tsx", import.meta.url), "utf8");
  const begin = source.indexOf("export function QuoteAnnotationModal(");
  const end = source.indexOf("  return createPortal(", begin);
  assert.ok(begin >= 0 && end > begin);
  const setup = source.slice(begin, end).replace("export function", "function") + "return { placeholder, insertNewline }; }";
  const textarea = {
    value: "原有评论\n继续补充🙂", style: {}, scrollHeight: 220, scrollTop: 0,
    focus() { this.focused = true; },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    select() { assert.fail("editing must not select all existing comments"); },
    setRangeText(text, start, end, mode) {
      assert.equal(mode, "end");
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
      this.setSelectionRange(start + text.length, start + text.length);
    },
  };
  const replies = [];
  const ctx = { document: {}, window: { innerHeight: 900 }, useI18n: () => ({ t: value => value }),
    useState: value => [value, next => replies.push(next)], useRef: () => ({ current: textarea }),
    useEffect: fn => fn(), useLayoutEffect: fn => fn(), useCallback: fn => fn,
    requestAnimationFrame: fn => fn() };
  vm.createContext(ctx);
  vm.runInContext(stripTypeScriptTypes(setup) + "\nglobalThis.modal = QuoteAnnotationModal;", ctx);
  assert.equal(ctx.modal({ isOpen: true, quoteText: "fixture", targetName: "Alice", initialReply: textarea.value, onConfirm() {}, onClose() {} }).placeholder, "quote.replyPlaceholder");
  assert.equal(textarea.focused, true);
  assert.equal(textarea.selectionStart, textarea.value.length);
  assert.equal(textarea.selectionEnd, textarea.value.length);
  assert.equal(textarea.scrollTop, textarea.scrollHeight);
  const modal = ctx.modal({ isOpen: true, quoteText: "fixture", onConfirm() {}, onClose() {} });
  assert.equal(modal.placeholder, "quote.replyPlaceholder");
  for (const [value, start, end, expected] of [
    ["", 0, 0, "\n"],
    ["末尾🙂", 4, 4, "末尾🙂\n"],
    ["前后", 1, 1, "前\n后"],
    ["前选区后", 1, 3, "前\n后"],
  ]) {
    textarea.value = value;
    textarea.setSelectionRange(start, end);
    modal.insertNewline();
    assert.equal(replies.at(-1), expected);
    assert.equal(textarea.value, expected);
    assert.equal(textarea.selectionStart, start + 1);
    assert.equal(textarea.selectionEnd, start + 1);
    assert.equal(textarea.focused, true);
  }
  assert.match(source, /aria-label=\{t\("chat\.insertNewline"\)\}/);
  assert.match(source, /onClick=\{insertNewline\}/);
});
