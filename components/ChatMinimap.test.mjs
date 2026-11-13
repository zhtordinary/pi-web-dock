import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".module.css")) return nextLoad(url, context);
    return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_, key) => String(key) });" };
  },
});

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { AssistantOutline } = await jiti.import("./ChatMinimap.tsx");
const source = await readFile(new URL("./ChatMinimap.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("./ChatMinimap.module.css", import.meta.url), "utf8");

test("renders math and keeps heading navigation in the bounded preview", () => {
  const html = renderToStaticMarkup(React.createElement(AssistantOutline, {
    markdown: String.raw`# Inline $f_{k,t+1}$

## Parentheses \(x^2 + y^2\)`,
    onHeadingClick() {},
  }));
  assert.match(html, /class="katex"/);
  assert.match(html, /data-preview-heading-index="0"/);
  assert.match(html, /data-preview-heading-index="1"/);
  assert.doesNotMatch(html, /disabled=""/);
});

test("uses history index ordinals instead of DOM message positions", () => {
  assert.match(source, /historyNodes\?: readonly HistoryNode\[\]/);
  assert.match(source, /historyNodeCount\?: number/);
  assert.match(source, /for \(const node of historyNodes\)/);
  assert.doesNotMatch(source, /nextRuntimeNodeIndex|Runtime-only rows/);
  assert.match(source, /nodeIndex/);
  assert.match(source, /onNavigateEntry/);
  assert.match(source, /const previewNodes = positionedNodes;/);
  assert.doesNotMatch(source, /PREVIEW_NEIGHBOR_COUNT/);
});

test("the hover preview keeps every indexed question available to its own scroll container", () => {
  assert.match(source, /const previewNodes = positionedNodes;/);
  assert.match(styles, /\.preview \{[\s\S]*overflow-y: auto;/);
});

test("the complete indexed rail has no body-preload arrow and retains bottom navigation", () => {
  assert.doesNotMatch(source, /data-minimap-history-(all|step)|onLoadEarlierHistory|canExpandHistory|canLoadEarlierHistory/);
  assert.match(source, /data-minimap-bottom-actions/);
  const start = source.indexOf("  const scrollToBottom = useCallback");
  const end = source.indexOf("  const scrollToAssistant = useCallback", start);
  assert.ok(start >= 0 && end > start);
  let calls = 0;
  const context = { useCallback: fn => fn, onScrollToBottom: () => { calls++; },
    pendingNavigationRef: { current: {} }, activeNodeLockRef: { current: {} } };
  vm.runInNewContext(stripTypeScriptTypes(source.slice(start, end) + "\nglobalThis.bottom = scrollToBottom;"), context);
  context.bottom();
  assert.equal(calls, 1, "bottom navigation delegates once to the viewport owner");
  assert.equal(context.pendingNavigationRef.current, null);
  assert.equal(context.activeNodeLockRef.current, null);
});

test("indexed nodes keep a folded short window navigable before the rail ref exists", () => {
  const start = source.indexOf("  const updateVisibility = useCallback");
  const end = source.indexOf("  const measureNodes = useCallback", start);
  assert.ok(start >= 0 && end > start);
  for (const [historyNodeCount, historyNodes, scrollHeight, expected] of [
    [0, [], 300, false], [1, [], 300, true], [2, [], 300, true],
    [undefined, [{}, {}], 300, true], [0, [], 340, true],
  ]) {
    let visible;
    const ctx = { useCallback: fn => fn, historyNodeCount, historyNodes,
      scrollContainer: { current: { scrollHeight, clientHeight: 300 } }, setVisible: value => { visible = value; } };
    vm.runInNewContext(stripTypeScriptTypes(source.slice(start, end) + "\nglobalThis.update = updateVisibility;"), ctx);
    ctx.update();
    assert.equal(visible, expected);
  }
  assert.match(source, /const syncLayout = \(\) => \{\s*updateVisibility\(\);\s*measureNodes\(\);\s*\};/);
  assert.match(source, /const content = el\.firstElementChild;\s*if \(content\) ro\?\.observe\(content\);/);
  assert.match(source, /\[measureNodes, scrollContainer, updateVisibility, visible\]/);
});

test("keeps semantic question, answer, and compaction colors", () => {
  assert.match(styles, /\.user \{[\s\S]*?color: var\(--accent\);/);
  assert.match(styles, /\.compaction \{[\s\S]*?color: color-mix\(in srgb, #16a34a 80%, var\(--text\)\);/);
  assert.match(styles, /\.heading\[data-level="1"\][\s\S]*?color: var\(--text\);/);
});
