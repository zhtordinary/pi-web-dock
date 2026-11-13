import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import reactSyntaxHighlighter from "react-syntax-highlighter";

const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const markdownTableSource = await readFile(new URL("./MarkdownTable.tsx", import.meta.url), "utf8");
const { Prism: SyntaxHighlighter } = reactSyntaxHighlighter;

function functionBlock(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = nextName ? source.indexOf(`function ${nextName}(`, start) : source.length;
  assert.notEqual(start, -1, `${name} not found`);
  assert.notEqual(end, -1, `${nextName} not found after ${name}`);
  return source.slice(start, end);
}

for (const [name, nextName] of [
  ["ImageViewer", "formatDuration"],
  ["AudioViewer", "VideoViewer"],
  ["VideoViewer", "DocumentViewer"],
  ["DocumentViewer", "FileViewer"],
  ["TextFileViewer", null],
]) {
  test(`${name} pauses its watcher and synchronizes after connecting`, () => {
    const block = functionBlock(name, nextName);
    const guard = block.indexOf("if (!watchEnabled");
    const eventSource = block.indexOf("new EventSource", guard);
    const synchronize = block.indexOf("synchronize();", eventSource);

    assert.ok(guard >= 0, "watchEnabled guard missing");
    assert.match(block, /if \(!watchEnabled(?: \|\| isEditing)?\) return;/);
    assert.ok(eventSource > guard, "EventSource created before watchEnabled guard");
    assert.ok(synchronize > eventSource, "connected synchronization missing");
    assert.match(block, /\}, \[[^\]]*watchEnabled[^\]]*\]\);/);
  });
}

test("FileViewer forwards watcher state to every viewer implementation", () => {
  const block = functionBlock("FileViewer", "TextFileViewer");
  assert.equal(block.match(/watchEnabled=\{watchEnabled\}/g)?.length, 5);
});

test("FileViewer forwards modal actions to the text viewer", () => {
  const block = functionBlock("FileViewer", "TextFileViewer");
  assert.match(block, /onOpenInReaderView=\{onOpenInReaderView\}/);
  assert.match(block, /onClose=\{onClose\}/);
});

test("TextFileViewer snapshots and restores lightweight tab state", () => {
  const block = functionBlock("TextFileViewer", null);
  assert.match(block, /nextState\.editDraft = editDraftRef\.current/);
  assert.match(block, /displayMode: requestedInitialDisplayMode/);
  assert.match(block, /viewerStateRef\.current\.displayMode = nextDisplayMode/);
  assert.match(block, /viewerStateRef\.current\.wrapLines = next/);
  assert.match(block, /viewerStateRef\.current\.scrollTop = event\.currentTarget\.scrollTop/);
  assert.match(block, /viewerStateRef\.current\.scrollLeft = event\.currentTarget\.scrollLeft/);
  assert.match(block, /content\.scrollTop = viewerStateRef\.current\.scrollTop/);
  assert.match(block, /content\.scrollLeft = viewerStateRef\.current\.scrollLeft/);
});

test("TextFileViewer keeps first-mount preview eligibility across Strict Effects cleanup", () => {
  const block = functionBlock("TextFileViewer", null);
  assert.match(block, /defaultPreviewEligibleRef = useRef\(/);
  assert.match(block, /defaultPreviewEligibleRef\.current[\s\S]*updateDisplayMode\("preview"\)/);
});

test("keeps Markdown frontmatter inside the document scroll viewport", () => {
  const block = functionBlock("TextFileViewer", null);
  assert.match(block, /ref=\{isMarkdown && effectiveDisplayMode === "preview" \? undefined : contentRef\}/);
  assert.match(block, /frontmatterData=\{frontmatter\?\.data \?\? null\}/);
  assert.match(block, /scrollRef=\{contentRef\}/);
  assert.match(block, /onScroll=\{\(event\) => \{/);

  const previewStart = source.indexOf("function MarkdownPreviewWithToc(");
  assert.notEqual(previewStart, -1, "MarkdownPreviewWithToc not found");
  const preview = source.slice(previewStart);
  assert.match(preview, /frontmatterData && <FrontmatterCard data=\{frontmatterData\} \/>/);
  assert.match(preview, /<div ref=\{scrollRef\} onScroll=\{onScroll\}/);
});

test("file preview tables use the shared per-table layout toggle", () => {
  const previewStart = source.indexOf("function MarkdownPreviewWithToc(");
  assert.notEqual(previewStart, -1, "MarkdownPreviewWithToc not found");
  const preview = source.slice(previewStart);
  assert.match(preview, /table\(\{ children \}\)[\s\S]*<MarkdownTable>\{children\}<\/MarkdownTable>/);
  assert.match(source, /import \{ MarkdownTable \} from "\.\/MarkdownTable";/);
  assert.match(cssSource, /\.markdown-table-scroll\s*\{[\s\S]*?overflow-x:\s*auto;/);
});

test("Markdown preview preserves selectable inline code in horizontally scrolling tables", () => {
  const previewStart = source.indexOf("function MarkdownPreviewWithToc(");
  assert.notEqual(previewStart, -1, "MarkdownPreviewWithToc not found");
  const preview = source.slice(previewStart);
  assert.match(preview, /return \(\s*<code className=\{className\} \{\.\.\.props\}>\s*\{children\}\s*<\/code>\s*\);/);
  assert.match(markdownTableSource, /className="markdown-table-scroll"/);
  const codeRule = cssSource.match(/\.markdown-file-preview code \{[^}]*\}/)?.[0] ?? "";
  assert.ok(codeRule, "FileViewer inline-code style missing");
  assert.doesNotMatch(codeRule, /user-select:\s*none/i);
  assert.match(cssSource, /\.markdown-table-wrap \{[\s\S]*?overflow-x:\s*auto;/);
});

test("markdown table tokens stay inline despite Tailwind's table utility", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      SyntaxHighlighter,
      { language: "markdown" },
      "| Name | Desc |\n| --- | --- |\n| A | first |",
    ),
  );

  assert.match(html, /class="token table[ "]/);
  assert.match(cssSource, /span\.token\.table\s*\{[^}]*display:\s*inline;/);
});

test("keeps Markdown preview renderer identities stable across parent re-renders", () => {
  const previewStart = source.indexOf("function MarkdownPreviewWithToc(");
  assert.notEqual(previewStart, -1, "MarkdownPreviewWithToc not found");
  const preview = source.slice(previewStart);
  assert.match(preview, /const markdownComponents = useMemo<Components>\(\(\) => \(\{/);
  assert.match(preview, /const markdownComponents[\s\S]*?\}\), \[markdownDirectory, onOpenFile, remotePeer, scrollRef, sourceSessionId\]\);/);
  assert.match(source, /const contentRef = useRef<HTMLDivElement \| null>\(null\)/);
  assert.match(source, /scrollRef=\{contentRef\}/);
});

test("source view and edit mode default to soft wrap", () => {
  assert.match(source, /initialState\?\.wrapLines \?\? true/);
  assert.match(source, /whiteSpace: wrapLines \? "pre-wrap" : "pre"/);
});

test("does not leave the search overlay visible while the file panel is closed", () => {
  const block = functionBlock("TextFileViewer", null);
  assert.match(block, /\{panelOpen && \([\s\S]*<SearchReplaceBar/);
});

test("keeps editing on one native textarea surface", () => {
  const block = functionBlock("TextFileViewer", null);
  assert.match(block, /<textarea/);
  assert.match(block, /ref=\{editTextareaRef\}/);
  assert.match(block, /value=\{editText\}/);
  assert.match(block, /onChange=\{/);
  assert.match(block, /onScroll=\{\(event\) => \{/);
  assert.match(block, /className="file-editor-input"/);
  assert.doesNotMatch(block, /contentEditable=|highlightedEdit|editGutterRef|readTextSelection/);
});
