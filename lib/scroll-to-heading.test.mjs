import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { scrollToMarkdownAnchor, scrollToHeadingSourceLine } = await jiti.import("./scroll-to-heading.ts");
const { buildMarkdownToc } = await jiti.import("./markdown-toc.ts");

test("TOC navigation follows source lines even when Setext or raw HTML headings precede it", () => {
  const source = "Setext\n======\n\n<h2>HTML</h2>\n\n## Second\n\n## Second";
  const toc = buildMarkdownToc(source);
  assert.deepEqual(toc.map(item => item.sourceLine), [6, 8]);
  const headings = [1, 4, 6, 8].map((line, index) => ({ dataset: { headingSourceLine: String(line) }, getBoundingClientRect: () => ({ top: 100 * index }) }));
  const calls = [];
  const root = { scrollTop: 0, querySelectorAll: () => headings, getBoundingClientRect: () => ({ top: 0 }), scrollTo: value => calls.push(value) };
  assert.equal(scrollToHeadingSourceLine(root, toc[0].sourceLine, { behavior: "auto", offset: 12 }), true);
  assert.deepEqual(calls, [{ top: 188, behavior: "auto" }]);
  assert.equal(scrollToHeadingSourceLine(root, 99), false);
});

test("fragments resolve only within their own document and tolerate encoded slugs", () => {
  const calls = [];
  const heading = (id, owner) => ({ dataset: { headingAnchor: id }, scrollIntoView: () => calls.push(owner) });
  const first = { querySelectorAll: () => [heading("target", "first")] };
  const second = { querySelectorAll: () => [heading("target", "second"), heading("中文-1", "chinese")] };
  assert.equal(scrollToMarkdownAnchor(first, "#target"), true);
  assert.equal(scrollToMarkdownAnchor(second, "#user-content-target"), true);
  assert.equal(scrollToMarkdownAnchor(second, "#%E4%B8%AD%E6%96%87-1"), true);
  assert.equal(scrollToMarkdownAnchor(second, "#missing"), false);
  assert.equal(scrollToMarkdownAnchor(second, "#%bad"), false);
  assert.equal(scrollToMarkdownAnchor(second, "file.md#target"), false);
  assert.deepEqual(calls, ["first", "second", "chinese"]);
});
