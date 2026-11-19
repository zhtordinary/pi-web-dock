import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import test from "node:test";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false, jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { WorktreeGraphOverlay } = await jiti.import("./WorktreeGraphOverlay.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { computeWorktreeGraphFromDag } = await jiti.import("../lib/worktree-graph-types.ts");
const { clearSessionActivityCache } = await jiti.import("../lib/session-activity-fetch.ts");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

for (const mobile of [false, true]) {
 test(`opening the graph waits for the current session and uses a provisional hint on ${mobile ? "mobile" : "desktop"}`, async () => {
  const main = "/repo", linked = "/repo/.worktrees/task";
  const graph = computeWorktreeGraphFromDag(main, [
    { path: main, branch: "main", head: "head", isMain: true },
    { path: linked, branch: "task", head: "head", isMain: false },
  ], ["head"], new Map());
  graph.worktrees.find((item) => item.path === linked).dirtySummary = { state: "clean", hasUncommitted: false, dirtyCount: 0, stagedCount: 0, unstagedCount: 0, untrackedCount: 0, ignoredCount: 0 };
  let resolveHint, resolveComplete, historyCalls = 0;
  const hint = new Promise((resolve) => { resolveHint = resolve; });
  const complete = new Promise((resolve) => { resolveComplete = resolve; });
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://reader.test/" });
  if (mobile) dom.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const previous = new Map();
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    Text: dom.window.Text, Document: dom.window.Document, Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent, DOMException: dom.window.DOMException,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (input) => {
      const url = new URL(String(input), "http://reader.test/");
      let body;
      if (url.pathname === "/api/session-runs") body = { sessions: [] };
      else if (url.searchParams.has("graph")) body = { graph, sessionWorktreePath: main };
      else if (url.searchParams.has("inspect")) body = { inspection: { path: linked, dirtyCount: 0, dirtyFiles: [], commitMode: "since-base", commits: [] } };
      else if (url.searchParams.has("creationHistory")) {
        assert.equal(url.searchParams.get("sessionId"), "owner");
        body = ++historyCalls === 1 ? await hint : await complete;
      } else throw new Error(`Unexpected request: ${url}`);
      return { ok: true, json: async () => body };
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(React.createElement(I18nProvider, null, React.createElement(WorktreeGraphOverlay, {
        open: true, projectRoot: main, currentWorktreePath: main, currentSessionId: "owner",
        onClose() {}, onOpenSession() {}, onNewSessionFromNode() {}, onSwitchWorktree() {},
      })));
      await tick();
    });
    const inspector = container.querySelector('[data-testid="worktree-graph-inspector"]');
    assert.ok(inspector);
    assert.doesNotMatch(inspector.querySelector("summary").textContent, / · main/, "do not show the wrong main worktree while resolving the current session");
    await React.act(async () => {
      resolveHint({ records: [], bindings: [], provisionalRecords: [{ worktreePath: linked, sessionId: "owner", createdAt: "2026-01-01" }], partial: true, priorityPending: true, progress: { running: true, processedBytes: 20, totalBytes: 100 } });
      await tick();
    });
    assert.match(inspector.querySelector("summary").textContent, / · task/, "a provisional hint can locate the current session");
    assert.match(inspector.textContent, /使用上次关联定位，正在核验/, "the provisional selection is clearly labelled");
    if (mobile) assert.match(inspector.querySelector("summary").textContent, /使用上次关联定位，正在核验/, "the closed mobile inspector must still disclose the hint");
    assert.equal(inspector.querySelector('[data-worktree-associated-session="owner"]'), null, "a hint must not become a verified association");
    const cleanup = [...container.querySelectorAll("button[title]")].find((button) => /server checks again|服务端会再次检查|伺服器會再次檢查/.test(button.title));
    assert.ok(cleanup?.disabled, "a provisional hint cannot enable worktree removal");
    const newSession = [...inspector.querySelectorAll("button")].find((button) => button.textContent.includes("在此工作树新建会话"));
    const switchWorktree = [...inspector.querySelectorAll("button")].find((button) => button.textContent.includes("切换到此工作树"));
    assert.ok(newSession?.disabled && switchWorktree?.disabled, "unverified hints must not direct workspace actions");
    const taskNode = container.querySelector('[role="button"][aria-label="task"]');
    assert.ok(taskNode);
    await React.act(async () => { taskNode.click(); await tick(); });
    assert.equal(newSession.disabled, false, "an explicit choice permits an action on that worktree");
    assert.equal(switchWorktree.disabled, false);
    await React.act(async () => {
      resolveComplete({ records: [{ worktreePath: linked, sessionId: "owner", createdAt: "2026-01-01" }], bindings: [], provisionalRecords: [], partial: false, priorityPending: false, progress: { running: false, processedBytes: 100, totalBytes: 100 } });
      await tick();
    });
    assert.match(inspector.querySelector("summary").textContent, / · task/);
    assert.doesNotMatch(inspector.textContent, /使用上次关联定位，正在核验/);
    assert.ok(inspector.querySelector('[data-worktree-associated-session="owner"]'));
    const mainNode = container.querySelector('[role="button"][aria-label="main"]');
    assert.ok(mainNode);
    await React.act(async () => { mainNode.click(); await tick(); });
    assert.match(inspector.querySelector("summary").textContent, / · main/);
    await React.act(async () => { window.dispatchEvent(new CustomEvent("pi-web:worktree-management-changed")); await tick(); });
    assert.match(inspector.querySelector("summary").textContent, / · main/, "a background refresh must not override the user's selection");
  } finally {
    await React.act(async () => { root.unmount(); await tick(); });
    clearSessionActivityCache(); dom.window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
 });
}

test("association progress is shown while bounded scans continue, then the creator is visible", async () => {
  const main = "/repo", linked = "/repo/.worktrees/task";
  const graph = computeWorktreeGraphFromDag(main, [
    { path: main, branch: "main", head: "head", isMain: true },
    { path: linked, branch: "task", head: "head", isMain: false },
  ], ["head"], new Map());
  graph.worktrees.find((item) => item.path === linked).dirtySummary = { state: "clean", hasUncommitted: false, dirtyCount: 0, stagedCount: 0, unstagedCount: 0, untrackedCount: 0, ignoredCount: 0 };
  let requests = 0;
  let opened = null;
  let failureResponse = null;
  let interceptBackoff = false, releaseBackoff;
  const realSetTimeout = globalThis.setTimeout;
  let resolveNext, resolveFinal, resolveRefresh;
  const next = new Promise((resolve) => { resolveNext = resolve; });
  const final = new Promise((resolve) => { resolveFinal = resolve; });
  const refresh = new Promise((resolve) => { resolveRefresh = resolve; });
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://reader.test/" });
  const previous = new Map();
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    Text: dom.window.Text, Document: dom.window.Document, Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent, DOMException: dom.window.DOMException,
    IS_REACT_ACT_ENVIRONMENT: true,
    setTimeout: (callback, delay, ...args) => {
      if (interceptBackoff && delay === 100) {
        interceptBackoff = false;
        releaseBackoff = () => callback(...args);
        return 0;
      }
      return realSetTimeout(callback, delay, ...args);
    },
    fetch: async (input) => {
      const url = new URL(String(input), "http://reader.test/");
      let body;
      if (url.pathname === "/api/session-runs") body = { sessions: [] };
      else if (url.searchParams.has("graph")) body = { graph, sessionWorktreePath: main };
      else if (url.searchParams.has("inspect")) body = { inspection: { path: linked, dirtyCount: 0, dirtyFiles: [], commitMode: "since-base", commits: [] } };
      else if (url.searchParams.has("creationHistory")) {
        requests++;
        body = failureResponse ?? (requests === 1
          ? { records: [{ worktreePath: linked, sessionId: "creator", createdAt: "2026-01-01" }], bindings: [], partial: true, progress: { running: true, processedBytes: 50, totalBytes: 100 } }
          : requests === 2 ? await next : requests === 3 ? await final : await refresh);
      } else throw new Error(`Unexpected request: ${url}`);
      return { ok: true, json: async () => body };
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(React.createElement(I18nProvider, null, React.createElement(WorktreeGraphOverlay, {
        open: true, projectRoot: main, currentWorktreePath: main, preferredPath: linked,
        onClose() {}, onOpenSession(id, path) { opened = [id, path]; }, onNewSessionFromNode() {},
      })));
      await tick();
    });
    const section = container.querySelector('[data-testid="worktree-associated-sessions"]');
    assert.ok(section);
    assert.match(section.textContent, /50%/);
    const creator = section.querySelector('[data-worktree-associated-session="creator"]');
    assert.ok(creator, "already confirmed associations remain available while the rest is scanning");
    await React.act(async () => { creator.click(); await tick(); });
    assert.deepEqual(opened, ["creator", linked], "a confirmed result can be opened before the rest finishes");
    const cleanup = [...container.querySelectorAll("button[title]")].find((button) => /server checks again|服务端会再次检查|伺服器會再次檢查/.test(button.title));
    assert.ok(cleanup?.disabled, "partial history must keep worktree removal disabled");
    assert.equal(requests, 2, "advancing progress continues without the old fixed wait");
    await React.act(async () => {
      interceptBackoff = true;
      resolveNext({ records: [{ worktreePath: linked, sessionId: "creator", createdAt: "2026-01-01" }], bindings: [], partial: true, progress: { running: true, processedBytes: 50, totalBytes: 100 } });
      await tick();
    });
    assert.equal(requests, 2, "unchanged progress backs off instead of spinning");
    assert.equal(typeof releaseBackoff, "function", "stalled progress schedules the bounded retry delay");
    await React.act(async () => { releaseBackoff(); await tick(); });
    assert.equal(requests, 3);
    await React.act(async () => {
      resolveFinal({ records: [{ worktreePath: linked, sessionId: "creator", createdAt: "2026-01-01" }], bindings: [], partial: false, progress: { running: false, processedBytes: 100, totalBytes: 100 } });
      await tick();
    });
    assert.ok(section.querySelector('[data-worktree-associated-session="creator"]'));
    assert.doesNotMatch(section.textContent, /50%/);
    await React.act(async () => {
      window.dispatchEvent(new CustomEvent("pi-web:worktree-management-changed"));
      await tick();
    });
    assert.equal(section.querySelector('[data-worktree-associated-session="creator"]'), null, "a new scan must not show an old unverified association");
    assert.equal(cleanup.disabled, true, "removal stays disabled while an empty history is still loading");
    await React.act(async () => {
      resolveRefresh({ records: [], bindings: [], partial: false, progress: { running: false, processedBytes: 100, totalBytes: 100 } });
      await tick();
    });
    assert.equal(section.querySelector('[data-worktree-associated-session="creator"]'), null);
    assert.equal(cleanup.disabled, false, "a complete empty history permits the normal removal check");
    await React.act(async () => {
      failureResponse = { records: [], bindings: [], partial: true, failure: "entry_too_large", progress: { running: false, processedBytes: 0, totalBytes: 100 } };
      window.dispatchEvent(new CustomEvent("pi-web:worktree-management-changed"));
      await tick();
    });
    assert.match(section.textContent, /32 MiB/, "an oversized entry needs a specific warning rather than an endless refresh hint");
    assert.equal(cleanup.disabled, true, "an incomplete history never enables removal");
  } finally {
    await React.act(async () => { root.unmount(); await tick(); });
    clearSessionActivityCache();
    dom.window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

for (const timeoutFirst of [false, true]) test(`the first history hint yields to the graph with ${timeoutFirst ? "a bounded timeout" : "normal completion"}`, async () => {
  const main = timeoutFirst ? "/cold-graph-timeout" : "/cold-graph", graph = computeWorktreeGraphFromDag(main, [{ path: main, branch: "main", head: "head", isMain: true }], ["head"], new Map());
  let resolveGraph, releaseTimer, historyCalls = 0;
  const realSetTimeout = globalThis.setTimeout;
  const graphResponse = new Promise((resolve) => { resolveGraph = resolve; });
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://reader.test/" });
  const previous = new Map();
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    Text: dom.window.Text, Document: dom.window.Document, Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent, DOMException: dom.window.DOMException,
    IS_REACT_ACT_ENVIRONMENT: true,
    setTimeout: (callback, delay, ...args) => {
      if (delay === 400) { releaseTimer = () => callback(...args); return -1; }
      return realSetTimeout(callback, delay, ...args);
    },
    fetch: async (input) => {
      const url = new URL(String(input), "http://reader.test/");
      let body;
      if (url.pathname === "/api/session-runs") body = { sessions: [] };
      else if (url.searchParams.has("graph")) body = await graphResponse;
      else if (url.searchParams.has("inspect")) body = { inspection: { path: main, dirtyCount: 0, dirtyFiles: [], commitMode: "head-history", commits: [] } };
      else if (url.searchParams.has("creationHistory")) body = ++historyCalls === 1
        ? { records: [], provisionalRecords: [{ worktreePath: main, sessionId: "owner", createdAt: "2026-01-01" }], partial: true, priorityPending: true, progress: { running: true, processedBytes: 10, totalBytes: 100 } }
        : { records: [], partial: false, priorityPending: false, progress: { running: false, processedBytes: 100, totalBytes: 100 } };
      else throw new Error(`Unexpected request: ${url}`);
      return { ok: true, json: async () => body };
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(React.createElement(I18nProvider, null, React.createElement(WorktreeGraphOverlay, {
        open: true, projectRoot: main, currentWorktreePath: main, currentSessionId: "owner",
        onClose() {}, onOpenSession() {}, onNewSessionFromNode() {},
      })));
      await tick();
    });
    assert.equal(historyCalls, 1, "let the graph load before issuing more expensive scan slices");
    assert.ok(releaseTimer, "the wait must have a bound");
    await React.act(async () => {
      if (timeoutFirst) releaseTimer();
      else resolveGraph({ graph, sessionWorktreePath: main });
      await tick();
    });
    assert.equal(historyCalls, 2, "continue scanning after the graph settles or the wait expires");
    if (timeoutFirst) await React.act(async () => { resolveGraph({ graph, sessionWorktreePath: main }); await tick(); });
  } finally {
    await React.act(async () => { root.unmount(); await tick(); });
    clearSessionActivityCache(); dom.window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
