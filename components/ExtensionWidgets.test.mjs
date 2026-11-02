import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import { installEnglishTestLocale } from "./test-locale.mjs";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
await installEnglishTestLocale(jiti);
const {
  AsyncStatusSnapshotContent,
  ExtensionWidgets,
  formatExtensionWidgetContent,
  getExpandedExtensionWidget,
  getVisibleExtensionWidgets,
  getNextExpandedWidgetKey,
  getUpdatedExtensionWidgetKeys,
  snapshotExtensionWidgetContents,
  parseAsyncStatusSnapshot,
  formatAsyncStatusDuration,
  formatAgentGroupLabel,
  collectAsyncStatusIds,
  mergeAsyncStatusModelMetadata,
} = await jiti.import("./ExtensionWidgets.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

function renderWidgets(props) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ExtensionWidgets, props),
    ),
  );
}

test("keeps short extension widgets collapsed until clicked", () => {
  const html = renderWidgets({
    widgets: [{ key: "short", lines: ["first", "second"], placement: "aboveEditor" }],
  });

  assert.doesNotMatch(html, /widget truncated/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /<section/);
  assert.match(html, /data-direction="up"/);
  assert.doesNotMatch(html, /[\u2191\u2193]/);
});

test("collapses long widgets by default", () => {
  const lines = Array.from(
    { length: 12 },
    (_, index) => `line-${index + 1}`,
  );
  const html = renderWidgets({
    widgets: [{ key: "long", lines, placement: "belowEditor" }],
  });

  assert.ok(lines.length > 3);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /data-direction="down"/);
  assert.doesNotMatch(html, /<pre/);
  assert.doesNotMatch(html, /line-1/);
  assert.doesNotMatch(html, /line-10/);
  assert.doesNotMatch(html, /line-12/);
});

test("keeps all widget lines available for the scrollable expanded panel", () => {
  const lines = Array.from(
    { length: 12 },
    (_, index) => `line-${index + 1}`,
  );
  const content = formatExtensionWidgetContent(lines);

  assert.match(content, /line-10/);
  assert.match(content, /line-12/);
  assert.doesNotMatch(content, /widget truncated/);
});

test("keeps compact widgets collapsed by default", () => {
  const lines = Array.from(
    { length: 3 },
    (_, index) => `line-${index + 1}`,
  );
  const html = renderWidgets({
    widgets: [{ key: "compact", lines, placement: "aboveEditor" }],
  });

  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /<pre/);
});

test("keeps multiple compact widgets collapsed until one is selected", () => {
  const html = renderWidgets({
    widgets: [
      { key: "first", lines: ["one", "two"], placement: "aboveEditor" },
      { key: "second", lines: ["three", "four"], placement: "belowEditor" },
    ],
  });

  assert.equal((html.match(/aria-expanded="false"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /<section/);
});

test("switching widgets closes the previously expanded widget", () => {
  assert.equal(getNextExpandedWidgetKey(null, "first"), "first");
  assert.equal(getNextExpandedWidgetKey("first", "second"), "second");
  assert.equal(getNextExpandedWidgetKey("second", "second"), null);
});

test("closes an expanded widget when the pointer lands outside its panel and triggers", async () => {
  const source = await readFile(new URL("./ExtensionWidgets.tsx", import.meta.url), "utf8");
  assert.match(source, /const expandedPanelRef = useRef<HTMLDivElement>\(null\);/);
  assert.match(source, /const triggerGroupRef = useRef<HTMLDivElement>\(null\);/);
  assert.match(source, /if \(expandedWidgetKey === null\) return;[\s\S]*?document\.addEventListener\("pointerdown", handlePointerDown\)/);
  assert.match(source, /expandedPanelRef\.current\?\.contains\(target\) \|\| triggerGroupRef\.current\?\.contains\(target\)/);
  assert.match(source, /<div ref=\{expandedPanelRef\} className="extension-widget-panels">/);
  assert.match(source, /<div ref=\{triggerGroupRef\} className="extension-widget-triggers"/);
});

test("detects only existing widgets whose line content changed", () => {
  const previous = snapshotExtensionWidgetContents([
    { key: "changed", lines: ["one"], placement: "aboveEditor" },
    { key: "same", lines: ["ready"], placement: "belowEditor" },
    { key: "removed", lines: ["gone"], placement: "belowEditor" },
  ]);
  const next = snapshotExtensionWidgetContents([
    { key: "same", lines: ["ready"], placement: "aboveEditor" },
    { key: "changed", lines: ["one", "two"], placement: "belowEditor" },
    { key: "added", lines: ["new"], placement: "aboveEditor" },
  ]);

  assert.deepEqual(getUpdatedExtensionWidgetKeys(previous, next), ["changed"]);
  assert.deepEqual(getUpdatedExtensionWidgetKeys(null, next), []);
});

test("compares widget lines without delimiter collisions", () => {
  const previous = new Map([["status", ["one", "two"]]]);
  const next = new Map([["status", ["one\ntwo"]]]);

  assert.deepEqual(getUpdatedExtensionWidgetKeys(previous, next), ["status"]);
});

test("hides empty widgets instead of rendering inert controls", () => {
  const html = renderWidgets({
    widgets: [{ key: "empty-widget", lines: [], placement: "aboveEditor" }],
  });

  assert.doesNotMatch(html, /extension-widget-trigger/);
  assert.doesNotMatch(html, /extension-widget-panels/);
});

test("empty expanded keys cannot produce a panel", () => {
  const widgets = [{ key: "todo", lines: [], placement: "belowEditor" }];
  const ansiOnly = [{ key: "ansi-only", lines: ["\x1b[0m"], placement: "belowEditor" }];

  assert.deepEqual(getVisibleExtensionWidgets(widgets), []);
  assert.deepEqual(getVisibleExtensionWidgets(ansiOnly), []);
  assert.equal(getExpandedExtensionWidget(widgets, "todo"), undefined);
});

test("single-line widgets are expandable triggers showing content when open", () => {
  const html = renderWidgets({
    widgets: [{ key: "status", lines: ["ready"], placement: "belowEditor" }],
  });

  // 单行 widget 也是可点击触发器（视觉与多行一致），默认折叠、可展开查看完整内容。
  assert.match(html, /<button[^>]*extension-widget-trigger/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /extension-widget-key/);
  assert.match(html, /extension-widget-update-pulse/);
  assert.doesNotMatch(html, />ready</);
  assert.doesNotMatch(html, /<pre/);
});

test("parses structured async status snapshot v1 and renders structured tree", () => {
  const payload = {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs: [
      {
        id: "run-1",
        kind: "subagent",
        label: "programmer-super",
        state: "running",
        model: "CPA GPT/gpt-5.6-luna",
        thinking: "max",
        activity: { state: "active_long_running", currentTool: "bash", lastActivityAt: 100, turnCount: 3, toolCount: 5 },
        children: [{
          id: "review-1",
          kind: "host-step",
          label: "review",
          state: "partial",
          hostStep: {
            kind: "review",
            state: "complete",
            provider: "pi",
            role: "reviewer",
            verdict: "changes-requested",
            reasonCode: "needs-fix",
            report: "review.md",
          },
        }],
      },
    ],
  };
  const lines = ["PI_SUBAGENT_ASYNC_JSON:" + JSON.stringify(payload)];
  const snapshot = parseAsyncStatusSnapshot(lines);
  assert.ok(snapshot);
  assert.equal(snapshot.runs.length, 1);
  assert.equal(snapshot.runs[0].label, "programmer-super");
  assert.equal(snapshot.runs[0].state, "running");
  assert.equal(snapshot.runs[0].activity.lastActivityAt, 100);
  assert.equal(snapshot.runs[0].children[0].hostStep.report, "review.md");
  assert.equal(snapshot.runs[0].children[0].state, "partial");

  const structuredHtml = renderToStaticMarkup(
    React.createElement(AsyncStatusSnapshotContent, { snapshot }),
  );
  assert.match(structuredHtml, /async-status-snapshot/);
  assert.doesNotMatch(structuredHtml, /Async roots/);
  assert.match(structuredHtml, /data-state="running"/);
  const structuredHeader = structuredHtml.match(/async-status-card-header">([\s\S]*?)<\/div>/)?.[1] ?? "";
  assert.doesNotMatch(structuredHeader, /gpt-5\.6-luna|async-status-model-detail/);
  assert.match(structuredHtml, /async-status-node-status-dot/);
  assert.doesNotMatch(structuredHtml, />[✓⟳×◐Ⅱ■○]</);
  assert.match(structuredHtml, /data-state="partial"/);
  assert.match(structuredHtml, /async-status-node-kind[^>]*>subagent</);
  assert.match(structuredHtml, /async-status-node-kind[^>]*>host-step</);
  assert.doesNotMatch(structuredHtml, /programmer-super/);
  assert.match(structuredHtml, /id: run-1/);
  assert.match(structuredHtml, /id: review-1/);
  assert.match(structuredHtml, /async-status-step-state">partial</);
  assert.match(structuredHtml, /activity: active_long_running/);
  assert.match(structuredHtml, /reason: needs-fix/);
  assert.match(structuredHtml, /out: review.md/);
  assert.match(structuredHtml, /tool: bash/);

  const collapsedHtml = renderWidgets({
    widgets: [{ key: "subagent-status", lines, placement: "belowEditor" }],
  });
  assert.match(collapsedHtml, /extension-widget-trigger/);
  assert.doesNotMatch(collapsedHtml, /async-status-snapshot/);
});

test("formats running and terminal async durations from snapshot timestamps", () => {
  assert.equal(
    formatAsyncStatusDuration({ state: "running", startedAt: 10_000 }, 71_000),
    "1m 1s",
  );
  assert.equal(
    formatAsyncStatusDuration({ state: "complete", startedAt: 10_000, endedAt: 74_000 }, 0),
    "1m 4s",
  );
  assert.equal(
    formatAsyncStatusDuration({ state: "failed", startedAt: 10_000, updatedAt: 12_500 }, 0),
    "2s",
  );

  const snapshot = parseAsyncStatusSnapshot([
    "PI_SUBAGENT_ASYNC_JSON:" + JSON.stringify({
      kind: "pi-subagents.async-status-snapshot",
      version: 1,
      omitted: { runs: 0, children: 0, byteLimitExceeded: false },
      runs: [{
        id: "workflow-duration",
        kind: "workflow",
        label: "duration-workflow",
        state: "complete",
        startedAt: 10_000,
        endedAt: 74_000,
        children: [{
          id: "step-duration",
          kind: "step",
          label: "duration-step",
          state: "complete",
          startedAt: 10_000,
          endedAt: 74_000,
        }],
      }],
    }),
  ]);
  assert.ok(snapshot);
  const html = renderToStaticMarkup(
    React.createElement(AsyncStatusSnapshotContent, { snapshot }),
  );
  assert.match(html, /async-status-duration/);
  assert.equal((html.match(/data-duration="1m 4s"/g) ?? []).length, 2);
});

test("distinguishes same-label workflow and step nodes without deduplicating them", () => {
  const payload = {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs: [{
      id: "workflow-1",
      kind: "workflow",
      label: "custom-executor",
      state: "running",
      children: [{
        id: "step-1",
        kind: "step",
        label: "custom-executor",
        state: "running",
      }],
    }],
  };
  const snapshot = parseAsyncStatusSnapshot([
    "PI_SUBAGENT_ASYNC_JSON:" + JSON.stringify(payload),
  ]);
  assert.ok(snapshot);
  const html = renderToStaticMarkup(
    React.createElement(AsyncStatusSnapshotContent, { snapshot }),
  );
  assert.equal((html.match(/custom-executor/g) ?? []).length, 1);
  assert.match(html, /async-status-node-kind[^>]*>workflow</);
  assert.match(html, /async-status-node-kind[^>]*>step</);
  assert.match(html, /id: workflow-1/);
  assert.match(html, /id: step-1/);
});


test("scopes async metadata IDs by root run and preserves duplicate child identities", () => {
  const snapshot = {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs: [
      { id: "run-a", kind: "workflow", label: "a", state: "running", children: [{ id: "step:0", kind: "step", label: "a", state: "running" }] },
      { id: "run-b", kind: "workflow", label: "b", state: "running", children: [{ id: "step:0", kind: "step", label: "b", state: "running" }] },
    ],
  };
  const ids = collectAsyncStatusIds(snapshot);
  assert.equal(new Set(ids).size, 4);
  assert.ok(ids.some((id) => id.startsWith("run-a::")));
  assert.ok(ids.some((id) => id.startsWith("run-b::")));
});

test("falls back to plain AnsiText for malformed or object-valued fields without crashing", async () => {
  const malformed = {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs: [
      {
        id: "r1",
        kind: "subagent",
        label: "malformed-node",
        state: "running",
        hostStep: { state: "ok", verdict: { malicious: "object" } },
      },
    ],
  };
  const lines = ["PI_SUBAGENT_ASYNC_JSON:" + JSON.stringify(malformed)];
  const snapshot = parseAsyncStatusSnapshot(lines);
  assert.equal(snapshot, null);

  const source = await (await import("node:fs/promises")).readFile(new URL("./ExtensionWidgets.tsx", import.meta.url), "utf8");
  assert.match(source, /snapshot \? \([\s\S]*?<AsyncStatusSnapshotContent snapshot=\{snapshot\} modelMetadata=\{modelMetadata\} \/>[\s\S]*?: \([\s\S]*?<pre className="extension-widget-content">[\s\S]*?<AnsiText text=\{formatExtensionWidgetContent\(widget\.lines\)\} \/>/);
  assert.equal(parseAsyncStatusSnapshot(["ordinary widget text"]), null);
});


test("refreshes async model metadata when widget snapshot contents change", async () => {
  const source = await readFile(new URL("./ExtensionWidgets.tsx", import.meta.url), "utf8");
  assert.match(source, /const asyncSnapshotContentKey = expandedWidget \? expandedWidget\.lines\.join\("\\n"\) : "";/);
  assert.match(source, /\}, \[asyncSnapshotContentKey, asyncSnapshotIdsKey, remotePeer, sessionId\]\);/);
});

test("retains last-known model metadata when a refresh returns only partial fields", () => {
  const key = "workflow-current::A1";
  const merged = mergeAsyncStatusModelMetadata(
    {
      [key]: {
        agent: "custom-executor",
        model: "CPA GPT/gpt-5.6-luna:max",
        thinking: "max",
      },
    },
    { [key]: { agent: "custom-executor" } },
    [key],
  );
  assert.deepEqual(merged, {
    [key]: {
      agent: "custom-executor",
      model: "CPA GPT/gpt-5.6-luna:max",
      thinking: "max",
    },
  });
});

test("does not render a leading separator when step metrics have no model", () => {
  const payload = {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs: [{
      id: "workflow-current",
      kind: "workflow",
      label: "custom-executor",
      state: "running",
      children: [{
        id: "A1",
        kind: "step",
        label: "Execute A1",
        state: "complete",
        activity: { turnCount: 192 },
      }],
    }],
  };
  const snapshot = parseAsyncStatusSnapshot([
    "PI_SUBAGENT_ASYNC_JSON:" + JSON.stringify(payload),
  ]);
  assert.ok(snapshot);
  const html = renderToStaticMarkup(
    React.createElement(AsyncStatusSnapshotContent, { snapshot }),
  );
  assert.match(html, /192 turns/);
  assert.doesNotMatch(html, /async-status-step-sep\">·<\/span><span class=\"async-status-step-metrics\">192 turns/);
});

test("renders workflow roots as cards with task counts, IDs, and trustworthy totals", () => {
  const payload = {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs: [{
      id: "workflow-1",
      kind: "workflow",
      label: "custom-explorer, custom-explorer",
      state: "running",
      activity: { turnCount: 30, toolCount: 50 },
      children: [
        {
          id: "task-1",
          kind: "step",
          label: "Inspect docs",
          state: "complete",
          activity: { turnCount: 10, toolCount: 20 },
        },
        {
          id: "task-2",
          kind: "step",
          label: "Run tests",
          state: "running",
          activity: { turnCount: 20, toolCount: 30 },
        },
      ],
    }],
  };
  const snapshot = parseAsyncStatusSnapshot([
    "PI_SUBAGENT_ASYNC_JSON:" + JSON.stringify(payload),
  ]);
  assert.ok(snapshot);

  const html = renderToStaticMarkup(
    React.createElement(AsyncStatusSnapshotContent, { snapshot }),
  );
  assert.match(html, /async-status-card/);
  assert.match(html, /data-kind="workflow"/);
  const workflowHeader = html.match(/async-status-card-header">([\s\S]*?)<\/div>/)?.[1] ?? "";
  assert.doesNotMatch(workflowHeader, /async-status-node-status-dot|async-status-state|custom-explorer/);
  assert.match(html, /async-status-agent-badge/);
  assert.match(html, /2 tasks/);
  assert.match(html, /Workflow total: 30 turns · 50 tools/);
  assert.match(html, /id: workflow-1/);
  assert.match(html, /id: task-1/);
  assert.match(html, /Inspect docs/);
  assert.match(html, /Run tests/);
});

test("suppresses aggregate turns and tools on nested non-leaf task rows", () => {
  const payload = {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs: [{
      id: "workflow-nested",
      kind: "workflow",
      label: "nested",
      state: "running",
      children: [{
        id: "task-parent",
        kind: "step",
        label: "Parent task",
        state: "running",
        activity: { turnCount: 99, toolCount: 100 },
        children: [{
          id: "task-leaf",
          kind: "step",
          label: "Leaf task",
          state: "running",
          activity: { turnCount: 2, toolCount: 3 },
        }],
      }],
    }],
  };
  const snapshot = parseAsyncStatusSnapshot([
    "PI_SUBAGENT_ASYNC_JSON:" + JSON.stringify(payload),
  ]);
  assert.ok(snapshot);
  const html = renderToStaticMarkup(
    React.createElement(AsyncStatusSnapshotContent, { snapshot }),
  );
  assert.doesNotMatch(html, /99 turns|100 tools/);
  assert.match(html, /2 turns/);
  assert.match(html, /3 tools/);
});

test("renders duplicate agent labels with a multiplication count", () => {
  assert.equal(formatAgentGroupLabel("custom-explorer"), "custom-explorer");
  assert.equal(
    formatAgentGroupLabel("custom-explorer, custom-explorer, custom-explorer, +3 more"),
    "custom-explorer ×6",
  );
  assert.equal(formatAgentGroupLabel("agent-a, agent-b"), "agent-a, agent-b");
  assert.equal(formatAgentGroupLabel("worker, reviewer, worker"), "worker ×2, reviewer");
});

test("keeps turns and tools on task rows and suppresses an untrusted root aggregate", () => {
  const payload = {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs: [{
      id: "workflow-untrusted",
      kind: "workflow",
      label: "custom-executor",
      state: "running",
      activity: { turnCount: 999, toolCount: 999 },
      children: [
        {
          id: "task-a",
          kind: "step",
          label: "First task",
          state: "running",
          activity: { turnCount: 3, toolCount: 4 },
        },
        {
          id: "task-b",
          kind: "step",
          label: "Second task",
          state: "running",
          activity: { turnCount: 5, toolCount: 6 },
        },
      ],
    }],
  };
  const snapshot = parseAsyncStatusSnapshot([
    "PI_SUBAGENT_ASYNC_JSON:" + JSON.stringify(payload),
  ]);
  assert.ok(snapshot);

  const html = renderToStaticMarkup(
    React.createElement(AsyncStatusSnapshotContent, { snapshot }),
  );
  assert.doesNotMatch(html, /Workflow total/);
  assert.doesNotMatch(html, /999 turns|999 tools/);
  assert.equal((html.match(/3 turns/g) ?? []).length, 1);
  assert.equal((html.match(/4 tools/g) ?? []).length, 1);
  assert.equal((html.match(/5 turns/g) ?? []).length, 1);
  assert.equal((html.match(/6 tools/g) ?? []).length, 1);
});

test("does not duplicate metrics for a single-task workflow", () => {
  const payload = {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs: [{
      id: "workflow-single",
      kind: "workflow",
      label: "custom-executor",
      state: "running",
      activity: { currentTool: "bash", turnCount: 209, toolCount: 288 },
      children: [{
        id: "task-1",
        kind: "step",
        label: "Execute approved plan",
        state: "running",
        activity: { currentTool: "bash", turnCount: 209, toolCount: 288 },
      }],
    }],
  };
  const snapshot = parseAsyncStatusSnapshot([
    "PI_SUBAGENT_ASYNC_JSON:" + JSON.stringify(payload),
  ]);
  assert.ok(snapshot);

  const html = renderToStaticMarkup(
    React.createElement(AsyncStatusSnapshotContent, { snapshot }),
  );
  assert.match(html, /1 task/);
  assert.doesNotMatch(html, /Workflow total/);
  assert.equal((html.match(/209 turns/g) ?? []).length, 1);
  assert.equal((html.match(/288 tools/g) ?? []).length, 1);
});

test("standalone async roots retain their own turn and tool metrics", async () => {
  const source = await readFile(new URL("./ExtensionWidgets.tsx", import.meta.url), "utf8");
  assert.match(source, /!children\.length && activity\?\.turnCount/);
  assert.match(source, /!children\.length && activity\?\.toolCount/);
});


test("uses Reader semantic colors for async states and removes internal summary chrome", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\.async-status-summary/);
  assert.doesNotMatch(css, /\.async-status-node-icon/);
  assert.match(css, /data-state="running"[\s\S]*?async-status-node-status-dot[\s\S]*?#16a34a/);
  assert.match(css, /data-state="complete"[\s\S]*?async-status-node-status-dot[\s\S]*?#2563eb/);
  assert.match(css, /data-state="paused"[\s\S]*?async-status-node-status-dot[\s\S]*?#9333ea/);
  assert.match(css, /data-state="failed"[\s\S]*?async-status-node-status-dot[\s\S]*?#dc2626/);
  assert.match(css, /\.async-status-agent-badge \{[\s\S]*?color: var\(--text\);/);
  assert.doesNotMatch(css, /\.async-status-agent-badge \{[\s\S]*?color: var\(--accent\);/);
});

test("renders compact step rows with agent badges, unified metrics, and header id", () => {
  const payload = {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs: [{
      id: "45de9ef9-fa63-449d-9596-527dd38929d9",
      kind: "workflow",
      label: "custom-explorer, researcher",
      state: "running",
      children: [
        {
          id: "current-reader",
          kind: "step",
          label: "审查当前 Reader 基线",
          state: "running",
          activity: { turnCount: 6, toolCount: 20 },
        },
        {
          id: "official-latest",
          kind: "step",
          label: "核查官方最新版本",
          state: "running",
          activity: { turnCount: 6, toolCount: 19 },
        },
      ],
    }],
  };
  const snapshot = parseAsyncStatusSnapshot([
    "PI_SUBAGENT_ASYNC_JSON:" + JSON.stringify(payload),
  ]);
  assert.ok(snapshot);

  const modelMetadata = {
    "45de9ef9-fa63-449d-9596-527dd38929d9::current-reader": {
      agent: "custom-explorer",
      model: "CPA GPT/gpt-5.6-luna:max",
      thinking: "max",
    },
    "45de9ef9-fa63-449d-9596-527dd38929d9::official-latest": {
      agent: "researcher",
      model: "CPA GPT/gpt-5.6-luna:medium",
      thinking: "medium",
    },
  };

  const html = renderToStaticMarkup(
    React.createElement(AsyncStatusSnapshotContent, { snapshot, modelMetadata }),
  );

  // Workflow header: id is on the header row, no separate id line
  const headerHtml = html.match(/async-status-card-header">([\s\S]*?)<\/div>/)?.[1] ?? "";
  assert.match(headerHtml, /id:\s*45de9ef9/);
  assert.match(headerHtml, /2 tasks/);

  // Steps have agent badges
  assert.match(html, /async-status-agent-badge[^>]*>\[custom-explorer\]</);
  assert.match(html, /async-status-agent-badge[^>]*>\[researcher\]</);

  // Steps have metrics and model details on step row
  assert.match(html, /6 turns · 20 tools/);
  assert.match(html, /6 turns · 19 tools/);
  assert.match(html, /CPA GPT\/gpt-5\.6-luna \(max\)/);
  assert.match(html, /CPA GPT\/gpt-5\.6-luna \(medium\)/);
  assert.ok(html.indexOf("CPA GPT/gpt-5.6-luna (max)") < html.indexOf("6 turns · 20 tools"));
  // verified badge
  // verified badge
  assert.match(html, /id: current-reader/);
  assert.match(html, /id: official-latest/);

  // No separate empty identity detail line
  assert.doesNotMatch(html, /async-status-identity-detail/);
});


test("keeps root subagent model out of the card header", () => {
  const payload = {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs: [{
      id: "0658414e-6f2b-4c2f-9c2f-8d7f9d1e7a0a",
      kind: "subagent",
      label: "programmer-grade-1",
      state: "running",
      model: "CPA GPT/gpt-6.1-sol",
      thinking: "max",
      children: [{
        id: "step:0",
        kind: "step",
        label: "programmer-grade-1",
        state: "running",
        activity: { turnCount: 3, toolCount: 3 },
      }],
    }],
  };
  const snapshot = parseAsyncStatusSnapshot([
    "PI_SUBAGENT_ASYNC_JSON:" + JSON.stringify(payload),
  ]);
  assert.ok(snapshot);
  const html = renderToStaticMarkup(
    React.createElement(AsyncStatusSnapshotContent, {
      snapshot,
      modelMetadata: {
        "0658414e-6f2b-4c2f-9c2f-8d7f9d1e7a0a::step%3A0": {
          model: "CPA GPT/gpt-6.1-sol",
          thinking: "max",
        },
      },
    }),
  );
  const header = html.match(/async-status-card-header">([\s\S]*?)<\/div>/)?.[1] ?? "";
  assert.match(header, /id: 0658414e/);
  assert.match(header, /1 task/);
  assert.doesNotMatch(header, /programmer-grade-1|gpt-6\.1-sol|model-detail/);
  assert.match(html, /3 turns · 3 tools/);
  assert.match(html, /gpt-6\.1-sol \(max\)/);
});
