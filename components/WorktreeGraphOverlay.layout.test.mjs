import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const source = await readFile(new URL("./WorktreeGraphOverlay.tsx", import.meta.url), "utf8");

test("the desktop-only reading guide and marker legend occupy separate rows", () => {
  const guide = source.slice(source.indexOf("{/* Reading guide */}"), source.indexOf("{error && ("));
  assert.match(guide, /display: isMobile \? "none" : "flex"/);
  assert.match(source, /data-testid="worktree-graph-how-to-read"/);
  assert.match(source, /data-testid="worktree-graph-legend"/);
  assert.match(source, /worktreeGraph\.howToReadTitle/);
  assert.match(source, /worktreeGraph\.howToRead/);
  assert.match(source, /worktreeGraph\.legendTitle/);
  assert.match(source, /paddingTop: 7,[\s\S]*borderTop: "1px solid color-mix/);
});

test("header keeps actions in the title row and places search beside the filters", () => {
  const bar = source.slice(source.indexOf("{/* Top Header Bar */}"), source.indexOf("{/* Main Content Area */}"));
  const title = bar.slice(0, bar.indexOf("{/* Center filters */}"));
  assert.match(title, /display: isMobile \? "grid" : "flex"/);
  assert.match(title, /gridTemplateColumns: isMobile \? "minmax\(0, 1fr\) auto" : undefined/);
  const filters = bar.slice(bar.indexOf("{/* Center filters */}"), bar.indexOf("{/* Search */}"));
  // Labels stay on one line, but the group wraps rather than refusing to shrink.
  assert.match(filters, /whiteSpace: "nowrap"/);
  assert.match(filters.slice(0, filters.indexOf("[")), /flexWrap: "wrap"/);
  assert.doesNotMatch(filters.slice(0, filters.indexOf("[")), /flexShrink: 0/);
  assert.match(filters, /gridColumn: isMobile \? "1 \/ -1" : undefined, gridRow: isMobile \? 2 : undefined/);
  const search = bar.slice(bar.indexOf("{/* Search */}"), bar.indexOf("{/* Refresh, GitHub & Close */}"));
  assert.match(search, /width: isMobile \? "100%" : 320/);
  assert.match(search, /flex: isMobile \? undefined : "0 1 320px"/);
  assert.match(search, /gridColumn: isMobile \? "1 \/ -1" : undefined,\n\s+gridRow: isMobile \? 3 : undefined/);
  assert.equal(search.match(/\{searchControl\}/g)?.length, 1);
  const right = bar.slice(bar.indexOf("{/* Refresh, GitHub & Close */}"));
  assert.doesNotMatch(right.slice(right.indexOf("<div"), right.indexOf("<button")), /flexShrink: 0/);
  assert.match(right, /marginLeft: "auto", minWidth: 0/);
  assert.match(right, /gridColumn: isMobile \? 2 : undefined, gridRow: isMobile \? 1 : undefined/);
  const close = right.slice(right.indexOf("onClick={onClose}"));
  assert.match(close.slice(0, close.indexOf("</button>")), /flexShrink: 0/);
});

test("the graph renders one search input and only the supported filter buttons", async () => {
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true, fsCache: false, jsx: { runtime: "automatic" } });
  const { WorktreeGraphOverlay } = await jiti.import("./WorktreeGraphOverlay.tsx");
  const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(WorktreeGraphOverlay, {
    open: true, projectRoot: "/project", onClose() {}, onOpenSession() {}, onNewSessionFromNode() {},
  })));
  assert.equal((html.match(/data-testid="worktree-graph-search"/g) ?? []).length, 1);
  assert.match(html, /<input[^>]*class="worktree-graph-search-input"/);
  assert.equal((source.match(/\{searchControl\}/g) ?? []).length, 1);
  for (const label of ["当前与待处理", "全部", "有未合入提交", "尚无新提交"]) assert.match(html, new RegExp(`>${label} \\(0\\)</button>`));
  assert.doesNotMatch(html, />(?:已合入主线|有未提交修改) \(0\)<\/button>/);
});

test("graph header explains the view without repeating filter counts", () => {
  const subtitle = source.slice(source.indexOf("{/* Left identity & stats */}"), source.indexOf("{/* Center filters */}"));
  assert.match(subtitle, /worktreeGraph\.subtitle/);
  assert.doesNotMatch(subtitle, /graph\.counts|graph\.totalWorktrees/);
});

test("mobile graph gives the timeline full width and defaults the bottom inspector to collapsed", () => {
  const content = source.slice(source.indexOf('data-testid="worktree-graph-content"'), source.indexOf("{/* Left Graph Stage */}"));
  assert.match(content, /flexDirection: isMobile \? "column" : "row"/);

  const stage = source.slice(source.indexOf("{/* Left Graph Stage */}"), source.indexOf("{/* Right Inspector Sidebar */}"));
  assert.match(stage, /padding: isMobile \? "12px 12px 28px" : "16px 24px 40px"/);

  const inspector = source.slice(source.indexOf("{/* Right Inspector Sidebar */}"), source.indexOf("  function renderWorktreeRow"));
  assert.match(inspector, /<details\s+data-testid="worktree-graph-inspector"\s+open=\{!isMobile\}/);
  assert.match(inspector, /<summary[\s\S]*display: isMobile \? "list-item" : "none"/);
  assert.match(inspector, /worktreeGraph\.nodeInspector/);
  assert.match(inspector, /selectedWorktree\.label/);
  assert.match(inspector, /width: isMobile \? "100%" : 380/);
  assert.match(inspector, /maxHeight: isMobile \? "min\(48vh, 520px\)" : undefined/);
  assert.match(inspector, /borderLeft: isMobile \? "none" : "1px solid var\(--border\)"/);
  assert.match(inspector, /borderTop: isMobile \? "1px solid var\(--border\)" : "none"/);
});

test("rendered inspector uses native disclosure semantics only on mobile", () => {
  const tree = ts.createSourceFile("WorktreeGraphOverlay.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let inspector;
  const visit = (node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === "details"
      && node.openingElement.attributes.getText(tree).includes('data-testid="worktree-graph-inspector"')) inspector = node;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(inspector);
  const summary = inspector.children.find(node => ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === "summary");
  assert.ok(summary);
  const compiled = { exports: {} };
  const code = ts.transpileModule(`module.exports = ({isMobile, selectedWorktree, t}) => (${inspector.getText(tree)});
    module.exports.summary = ({isMobile, selectedWorktree, t}) => (${summary.getText(tree)});`,
  { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { module: compiled, React });
  for (const isMobile of [true, false]) {
    const props = { isMobile, selectedWorktree: null, t: key => key };
    const html = renderToStaticMarkup(compiled.exports(props));
    assert.equal(/<details[^>]*\sopen=""/.test(html), !isMobile);
    assert.match(html, new RegExp(`display:${isMobile ? "list-item" : "none"}`));
    assert.match(html, /worktreeGraph.selectHint/);
    const selectedSummary = renderToStaticMarkup(compiled.exports.summary({ ...props, selectedWorktree: { label: "fix/mobile-layout" } }));
    assert.match(selectedSummary, /worktreeGraph.nodeInspector · fix\/mobile-layout/);
  }
});

test("topology stays in the inspector rather than on each row", async () => {
  const row = source.slice(source.indexOf("  function renderWorktreeRow"));
  assert.match(source.slice(0, source.indexOf("  function renderWorktreeRow")), /worktreeGraph\.aheadBehind/);
  assert.match(source, /worktreeGraph\.deltaBasisHint/);
  assert.doesNotMatch(row, /worktreeGraph\.aheadBehind|wt\.shortHead/);
  const graphTypes = await readFile(new URL("../lib/worktree-graph-types.ts", import.meta.url), "utf8");
  assert.match(graphTypes, /topology-fork-base-first-parent/);
});
