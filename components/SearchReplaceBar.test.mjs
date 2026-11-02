import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const src = await readFile(new URL("./SearchReplaceBar.tsx", import.meta.url), "utf8");

const helperStart = src.indexOf("export function findMatchSpans(");
const helperEnd = src.indexOf("\n\nconst SEARCH_BLOCK_SELECTOR", helperStart);
const helperModule = ts.transpileModule(
  `${src.slice(helperStart, helperEnd).replace(/^export /gm, "")}\nreturn { findRenderedMatchSegments };`,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
);
const { findRenderedMatchSegments } = new Function(helperModule.outputText)();

test("maps exact matches across inline rendered text nodes", () => {
  assert.deepEqual(
    findRenderedMatchSegments(["high", "er"], "higher"),
    [{ segments: [{ nodeIndex: 0, start: 0, end: 4 }, { nodeIndex: 1, start: 0, end: 2 }] }],
  );
});

test("edit navigation uses the native textarea selection surface", () => {
  assert.match(src, /textareaRef\?\.current/);
  assert.match(src, /textarea\.focus\(\)/);
  assert.match(src, /textarea\.setSelectionRange\(span\.start, span\.end\)/);
  assert.match(src, /scrollTextareaToOffset\(textarea, span\.start\)/);
  assert.match(src, /getComputedStyle\(textarea\)/);
  assert.doesNotMatch(src, /editorRef|contenteditable|setTextSelection|scrollTextSelectionIntoView/);
});

test("highlights are always cleared on query/close/unmount", () => {
  assert.match(src, /clearSearchHighlights\(root\)/);
  assert.match(src, /classList\.remove\("search-flash-highlight"\)/);
  assert.match(src, /highlightTimerRef\.current = window\.setTimeout/);
  assert.match(src, /if \(!isOpen\) \{[\s\S]*clearSearchHighlights/);
  assert.match(src, /rowForOffset\(root, text, span\.start, containerKind\)/);
  // Preview (markdown) must not rely on .file-source-line selectors only.
  assert.match(src, /containerKind !== "markdown"/);
  assert.match(src, /p,li,td,th,h1,h2,h3,h4,h5,h6,pre,code/);
});

test("selects the first match after the query state commits without stealing input focus", () => {
  assert.match(src, /selectMatchRef\.current\(0, \{ focusEditor: false \}\)/);
  assert.match(src, /keepInputFocus/);
  assert.match(src, /window\.cancelAnimationFrame\(frame\)/);
  assert.doesNotMatch(src, /if \(e\.target\.value\) \{\s*requestAnimationFrame\(\(\) => selectMatch\(0\)\);/);
});

test("preview matching marks exact words across rendered nodes", () => {
  assert.match(src, /findRenderedMatchSegments/);
  assert.match(src, /mark\.dataset\.searchWordMatch/);
  assert.match(src, /mark\.dataset\.searchActive/);
  assert.match(src, /mark\[data-search-word-match\]/);
  assert.match(src, /textNode\.replaceWith\(fragment\)/);
  assert.doesNotMatch(src, /flashRow\(target\)/);
});

test("preview navigation advances through rendered matches", () => {
  const markdownStart = src.indexOf('if (containerKind === "markdown")');
  const sourceStart = src.indexOf('const row = rowForOffset', markdownStart);
  assert.ok(markdownStart >= 0, "markdown search branch missing");
  assert.ok(sourceStart > markdownStart, "source fallback must follow markdown branch");
  const markdownBranch = src.slice(markdownStart, sourceStart);
  assert.match(markdownBranch, /index/);
  assert.match(markdownBranch, /renderedMatchAnchors/);
  assert.match(markdownBranch, /mark\.dataset\.searchActive/);
  assert.doesNotMatch(markdownBranch, /flashRow\(target\)/);
});
