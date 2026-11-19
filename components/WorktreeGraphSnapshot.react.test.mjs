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
  test(`reopening a ${mobile ? "mobile" : "desktop"} graph shows only a non-actionable local snapshot until refreshed`, async () => {
    const main = mobile ? "/snapshot-mobile" : "/snapshot-desktop", linked = `${main}/.worktrees/task`;
    const worktrees = [
      { path: main, branch: "main", head: "head", isMain: true },
      { path: linked, branch: "task", head: "head", isMain: false },
    ];
    const graph = computeWorktreeGraphFromDag(main, worktrees, ["head"], new Map());
    graph.worktrees.find((item) => item.path === linked).dirtySummary = { state: "clean", hasUncommitted: false, dirtyCount: 0, stagedCount: 0, unstagedCount: 0, untrackedCount: 0, ignoredCount: 0 };
    const updatedGraph = computeWorktreeGraphFromDag(main, [worktrees[0]], ["head"], new Map());
    let phase = 1, resolveGraph, resolveHistory, resolvePeerGraph, resolvePeerHistory;
    const refreshedGraph = new Promise((resolve) => { resolveGraph = resolve; });
    const refreshedHistory = new Promise((resolve) => { resolveHistory = resolve; });
    const peerGraph = new Promise((resolve) => { resolvePeerGraph = resolve; });
    const peerHistory = new Promise((resolve) => { resolvePeerHistory = resolve; });
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
        if (url.pathname.endsWith("/session-runs")) body = { sessions: [] };
        else if (url.searchParams.has("graph")) body = phase === 1 ? { graph, sessionWorktreePath: main } : phase === 2 ? await refreshedGraph : await peerGraph;
        else if (url.searchParams.has("inspect")) body = { inspection: { path: linked, dirtyCount: 0, dirtyFiles: [], commitMode: "since-base", commits: [] } };
        else if (url.searchParams.has("creationHistory")) body = phase === 1
          ? { records: [{ worktreePath: linked, sessionId: "owner", createdAt: "2026-01-01" }], bindings: [], partial: false, priorityPending: false }
          : phase === 2 ? await refreshedHistory : await peerHistory;
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
    let actions = 0;
    const render = (peer) => React.createElement(I18nProvider, null, React.createElement(WorktreeGraphOverlay, {
      open: true, projectRoot: main, currentWorktreePath: main, currentSessionId: "owner", remotePeer: peer,
      onClose() {}, onOpenSession() { actions++; }, onNewSessionFromNode() { actions++; }, onSwitchWorktree() { actions++; },
    }));
    try {
      await React.act(async () => { root.render(render()); await tick(); });
      assert.match(container.querySelector('[data-testid="worktree-graph-inspector"] summary').textContent, / · task/);
      await React.act(async () => { root.render(null); await tick(); });
      phase = 2;
      await React.act(async () => { root.render(render()); await tick(); });
      const inspector = container.querySelector('[data-testid="worktree-graph-inspector"]');
      assert.ok(container.querySelector('[role="button"][aria-label="task"]'), "the last graph is visible before either request completes");
      assert.match(inspector.querySelector("summary").textContent, / · task/, "the last verified association is shown only as a hint");
      assert.match(inspector.textContent, /使用上次关联定位，正在核验/);
      assert.equal(inspector.querySelector('[data-worktree-associated-session="owner"]'), null, "cached hints are not verified associations");
      assert.ok(container.querySelector('[data-testid="worktree-wip-unavailable"]'), "cached dirty status is unknown");
      await React.act(async () => { container.querySelector('[role="button"][aria-label="task"]').click(); await tick(); });
      const newSession = [...container.querySelectorAll("button")].filter((button) => button.textContent.includes("在此工作树新建会话"));
      const switchWorktree = [...inspector.querySelectorAll("button")].find((button) => button.textContent.includes("切换到此工作树"));
      const cleanup = [...container.querySelectorAll("button[title]")].find((button) => /server checks again|服务端会再次检查|伺服器會再次檢查/.test(button.title));
      assert.ok(newSession.length && newSession.every((button) => button.disabled), "even a manual choice cannot act on an unverified graph");
      assert.ok(switchWorktree?.disabled && cleanup?.disabled);
      for (const button of newSession) button.click();
      assert.equal(actions, 0);
      await React.act(async () => {
        resolveGraph({ graph: updatedGraph, sessionWorktreePath: main });
        resolveHistory({ records: [], bindings: [], partial: false, priorityPending: false });
        await tick();
      });
      assert.equal(container.querySelector('[role="button"][aria-label="task"]'), null, "a removed worktree disappears when the authoritative graph arrives");
      assert.match(inspector.querySelector("summary").textContent, / · main/);
      await React.act(async () => { root.render(null); await tick(); });
      phase = 3;
      await React.act(async () => { root.render(render("other-device")); await tick(); });
      assert.equal(container.querySelector('[role="button"][aria-label="main"]'), null, "snapshots are isolated by device");
      await React.act(async () => {
        resolvePeerGraph({ graph: updatedGraph, sessionWorktreePath: main });
        resolvePeerHistory({ records: [], bindings: [], partial: true, failure: mobile ? "entry_too_large" : "unavailable", priorityPending: false });
        await tick();
      });
      const peerInspector = container.querySelector('[data-testid="worktree-graph-inspector"]');
      const peerAction = [...peerInspector.querySelectorAll("button")].find((button) => button.textContent.includes("在主线新建会话"));
      assert.ok(peerAction?.disabled, "an incomplete inventory cannot silently direct implicit actions to main");
      await React.act(async () => { container.querySelector('[role="button"][aria-label="main"]').click(); await tick(); });
      assert.equal(peerAction.disabled, false, "a manual choice on the refreshed graph remains possible");
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
