import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
// One module graph, so the component reads the same i18n context the test provides.
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, jsx: { runtime: "automatic" }, fsCache: false });
const { WorktreeSessionBuckets, parseInventory } = await jiti.import("./WorktreeSessionBuckets.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const renderBuckets = (props) => renderToStaticMarkup(React.createElement(I18nProvider, { initialLocale: "en" }, React.createElement(WorktreeSessionBuckets, props)));
test("renders accessible main and linked-worktree buckets with counts", () => {
 const sessions = [{ id: "linked", cwd: "/wt/a", projectRoot: "/repo", isGit: true, isWorktree: true, branch: "feature" }, { id: "main", cwd: "/repo", isGit: true, isWorktree: false, branch: "main" }];
 const html = renderBuckets({ items: sessions, sessionOf: x => x, mainLabel: "Mainline", worktreeLabel: "Worktree", renderItems: rows => rows.map(x => React.createElement("span", { key: x.id }, x.id)) });
 assert.ok(html.indexOf("Mainline") < html.indexOf("Worktree"));
 assert.match(html, /aria-expanded="true"/);
 assert.match(html, /Worktree · feature/);
 assert.equal((html.match(/\(1\)/g) ?? []).length, 2);
 assert.doesNotMatch(html, /draggable|ondrop|New session/);
});
test("all three list surfaces use the shared worktree renderer", async () => {
 const panel = await readFile(new URL("./SessionActivityPanel.tsx", import.meta.url), "utf8");
 const sidebar = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
 assert.equal((panel.match(/return <WorktreeSessionBuckets/g) ?? []).length, 2);
 assert.match(sidebar, /<WorktreeSessionBuckets/);
 assert.match(panel, /parsed.group === "worktree"/);
 assert.match(panel, /current.group === "worktree"/);
});

test("ordinary sidebar renders one project heading for its main and linked trees", () => {
 const sessions = [{ id: "a", cwd: "/tree", projectRoot: "/repo", isGit: true, isWorktree: true, branch: "feature" }, { id: "m", cwd: "/repo", projectRoot: "/repo", isGit: true, branch: "main" }];
 const html = renderBuckets({ items: sessions, sessionOf: x => x, showProjectPath: true, mainLabel: "Mainline", worktreeLabel: "Worktree", renderItems: () => null });
 assert.equal((html.match(/>\/repo<\/div>/g) ?? []).length, 1);
});


test("inventory envelope validation returns linked checkouts and rejects the wrong project or malformed rows", () => {
 const body = {
  projectKey: "/repo",
  projectRoot: "/repo",
  worktrees: [
   { path: "/repo", branch: "main", isMain: true },
   { path: "/repo-worktrees/session-界面", branch: "session-界面", isMain: false },
   { path: "/repo-worktrees/detached", branch: null, isMain: false },
  ],
 };
 assert.deepEqual(parseInventory(body, { projectKey: "/repo", projectRoot: "/repo", deviceId: "debian", peerId: "debian" }), {
  projectKey: "/repo",
  worktrees: [{ path: "/repo-worktrees/session-界面", branch: "session-界面" }, { path: "/repo-worktrees/detached", branch: null }],
 });
 assert.equal(parseInventory({ ...body, projectKey: "/other" }, { projectKey: "/repo", projectRoot: "/repo" }), null);
 assert.equal(parseInventory({ ...body, worktrees: body.worktrees.slice(1) }, { projectKey: "/repo", projectRoot: "/repo" }), null);
 assert.equal(parseInventory({ ...body, worktrees: [...body.worktrees, { path: "/x", branch: 7, isMain: false }] }, { projectKey: "/repo", projectRoot: "/repo" }), null);
 assert.equal(parseInventory(body, { projectKey: "/repo", projectRoot: "/repo", deviceId: "macmini", peerId: "debian" }), null);
});

test("exact device/session focus expands only the matching bucket", () => {
 const duplicate = (device) => ({ device, session: { id: "duplicate", cwd: `/wt/${device}`, projectRoot: "/repo", isGit: true, isWorktree: true, branch: "feature" } });
 const html = renderBuckets({
  items: [duplicate("local"), duplicate("remote")],
  sessionOf: item => item.session,
  deviceOf: item => item.device,
  focusSessionKey: "remote:duplicate",
  mainLabel: "Mainline",
  worktreeLabel: "Worktree",
  renderItems: rows => rows.map(row => React.createElement("span", { key: row.device, "data-focused-row": row.device }, row.device)),
 });
 assert.match(html, /data-focused-row="remote"/);
 assert.doesNotMatch(html, /data-focused-row="local"/);
});

test("worktree inline management stays on the inventory owner's plain worktree API", async () => {
  const source = await readFile(new URL("./WorktreeSessionBuckets.tsx", import.meta.url), "utf8");
  assert.match(source, /const peer = url\.searchParams\.get\("peer"\) \?\? undefined/);
  assert.match(source, /apiPathForPeer\(peer, "worktrees"\)/);
  assert.match(source, /runMutation\("PATCH", \{ path: group\.path, branch: next \}\)/);
  assert.match(source, /runMutation\("DELETE", \{ path: group\.path \}\)/);
  assert.doesNotMatch(source, /deleteNeedsForce|force: true|deleteDirtyConfirm/);
  assert.match(source, /worktreeBuckets\.deleteDirtyBlocked/);
  assert.match(source, /worktreeGraph\.cleanupResultUnknown/);
  assert.match(source, /pi-web:worktree-management-changed/);
  assert.match(source, /activity-subproject-rename-inline/);
  assert.match(source, /role="menuitem"/);
});

test("dirty worktree refusal never offers or sends a force retry", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://reader.test/", pretendToBeVisual: true });
  const previous = new Map();
  const requests = [];
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    HTMLIFrameElement: dom.window.HTMLIFrameElement, CustomEvent: dom.window.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url, init) => { requests.push({ url, init }); return { ok: false, status: 409, json: async () => ({ dirty: true }) }; },
  };
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    const sessions = [{ id: "s", cwd: "/repo/task", projectRoot: "/repo", isGit: true, isWorktree: true, branch: "task" }];
    await React.act(async () => {
      root.render(React.createElement(I18nProvider, { initialLocale: "en" }, React.createElement(WorktreeSessionBuckets, {
        items: sessions, sessionOf: (item) => item, inventoryProjectRoot: "/repo", mainLabel: "Main", worktreeLabel: "Worktree", renderItems: () => null,
      })));
      await tick();
    });
    const group = container.querySelector("button[aria-expanded]");
    assert.ok(group);
    await React.act(async () => { group.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })); await tick(); });
    const remove = document.querySelector('[role="menuitem"][data-danger="true"]');
    assert.ok(remove);
    await React.act(async () => { remove.click(); await tick(); });
    const confirm = container.querySelector('.activity-subproject-delete-confirm button');
    assert.ok(confirm);
    await React.act(async () => { confirm.click(); await tick(); });
    assert.equal(requests.length, 1);
    assert.deepEqual(JSON.parse(requests[0].init.body), { cwd: "/repo", path: "/repo/task" });
    assert.match(container.textContent, /uncommitted or untracked files and cannot be removed/i);
    assert.doesNotMatch(container.textContent, /discard them/i);
  } finally {
    await React.act(async () => { root.unmount(); await tick(); });
    dom.window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test("mainline sessions in project root render with subproject header styling and mainLabel, never raw path", () => {
  const sessions = [
    { id: "s1", cwd: "/Users/alice/Projects/my-app", projectRoot: "/Users/alice/Projects/my-app", isGit: true },
    { id: "s2", cwd: "/Users/alice/Projects/my-app", projectRoot: "/Users/alice/Projects/my-app", isGit: true },
  ];
  const html = renderBuckets({
    items: sessions,
    sessionOf: x => x,
    mainLabel: "主线",
    worktreeLabel: "工作树",
    renderItems: rows => rows.map(x => React.createElement("span", { key: x.id }, x.id)),
  });
  assert.match(html, /activity-subproject-header/);
  assert.match(html, /主线/);
  assert.doesNotMatch(html, />\/Users\/alice\/Projects\/my-app/);
});


test("worktree bucket collapse state can be manually toggled even when it contains the focused session", () => {
  const sessions = [{ id: "focused-session", cwd: "/repo", projectRoot: "/repo", isGit: true }];
  // Initially, it has focus so it is expanded
  const htmlExpanded = renderBuckets({
    items: sessions,
    sessionOf: x => x,
    focusSessionId: "focused-session",
    mainLabel: "主线",
    worktreeLabel: "工作树",
    renderItems: rows => rows.map(x => React.createElement("span", { key: x.id }, x.id)),
  });
  assert.match(htmlExpanded, /aria-expanded="true"/);
  assert.match(htmlExpanded, /focused-session/);
});


test("virtual worktree seam windows large buckets and retains project/header rows", () => {
  const sessions = Array.from({ length: 10_000 }, (_, index) => ({ id: `session-${index}`, cwd: "/repo", projectRoot: "/repo", isGit: true, branch: "main" }));
  const html = renderBuckets({
    items: sessions,
    sessionOf: x => x,
    showProjectPath: true,
    mainLabel: "Mainline",
    worktreeLabel: "Worktree",
    renderItems: () => null,
    virtualization: {
      scrollTop: 0,
      viewportHeight: 54 * 6,
      originOffset: 0,
      overscanRows: 2,
      pinnedIds: new Set(["session-0", "session-1"]),
      collapsedSessionIds: new Set(),
      buildTree: items => items.map(item => ({ item, children: [] })),
      renderSession: (item, depth, hasChildren, collapsed) => React.createElement("span", { "data-session-row": item.id, "data-depth": depth, "data-has-children": hasChildren, "data-collapsed": collapsed }, item.id),
    },
  });
  const mounted = (html.match(/data-virtual-row-id=/g) ?? []).length;
  assert.ok(mounted <= 6 + 4 + 2 + 2);
  assert.match(html, /data-virtual-worktree-window/);
  assert.match(html, /data-virtual-row-id="project:\/repo"/);
  assert.match(html, /data-session-row="session-0"/);
  assert.doesNotMatch(html, /data-session-row="session-9999"/);
});
