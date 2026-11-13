import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import test from "node:test";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".module.css")) return nextLoad(url, context);
    return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_, key) => String(key) });" };
  },
});

const mock = fileURLToPath(new URL("./AppShell.session-ownership.test-support.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, {
  alias: { "./ChatWindow": mock, "./SessionSidebar": mock, "./SessionActivityPanel": mock, "./ExplorerSection": mock, "next/navigation": mock },
  fsCache: false,
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

function installDom(embedded = false) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: embedded ? "http://reader.test/?piWebEmbedded=1" : "http://reader.test/" });
  const previous = new Map();
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    HTMLIFrameElement: dom.window.HTMLIFrameElement, Text: dom.window.Text, Document: dom.window.Document,
    Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, DOMException: dom.window.DOMException,
    MutationObserver: dom.window.MutationObserver, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  };
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  dom.window.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0);
  dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
  dom.window.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  const observer = class { observe() {} disconnect() {} unobserve() {} };
  dom.window.ResizeObserver = observer;
  dom.window.IntersectionObserver = observer;
  globalThis.ResizeObserver = observer;
  globalThis.IntersectionObserver = observer;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame;
  globalThis.EventSource = class { constructor(url) { this.url = String(url); this.readyState = 1; } close() { this.readyState = 2; } };
  window.EventSource = globalThis.EventSource;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/remote/sessions?peer=peer-a") && globalThis.__readerOwnerProbe.deferForkList) {
      return new Promise((resolve) => { globalThis.__readerOwnerProbe.resolveForkList = resolve; });
    }
    const body = url.includes("/api/cwd/validate") ? { cwd: "/tmp/reader-ownership-project" }
      : url.includes("/api/session-control") ? { waits: [], sources: [] }
      : url.includes("/api/sessions") ? { sessions: [] }
      : url.includes("/api/session-runs") ? { sessions: [], devices: [], device: { id: "local", name: "local" } }
      : url.includes("/api/models") ? { models: [] }
      : {};
    return { ok: true, status: 200, json: async () => body };
  };
  globalThis.__readerOwnerProbe = { next: 0, owners: new Map() };
  return () => {
    dom.window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(message);
}
async function click(selector) {
  const button = document.querySelector(selector);
  assert.ok(button, `missing button ${selector}`);
  await React.act(async () => { button.click(); await tick(); });
}
async function mount(embedded = false) {
  const previous = new Map(["fetch", "EventSource", "ResizeObserver", "IntersectionObserver", "requestAnimationFrame", "cancelAnimationFrame", "__readerOwnerProbe"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const restore = installDom(embedded);
  const { AppShell } = await jiti.import("./AppShell.tsx");
  const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = () => React.createElement(I18nProvider, { initialLocale: "en" }, React.createElement(AppShell, { localDeviceId: "local", localDeviceName: "local" }));
  await React.act(async () => { root.render(render()); await tick(); await tick(); });
  return {
    container,
    async rerender() { await React.act(async () => { root.render(render()); await tick(); await tick(); }); },
    async unmount() {
      await React.act(async () => { root.unmount(); await tick(); });
      restore();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

test("AppShell releases the old local chat when opening each collection view", async () => {
  for (const collection of ["favorites", "hidden", "discuss", "revise", "completed"]) {
    const app = await mount(true);
    try {
      await waitFor(() => document.querySelector("[data-test-cwd]"), "the real shell did not mount the original sidebar");
      await click("[data-test-cwd]");
      await click("[data-test-local]");
      await waitFor(() => document.querySelector('[data-test-chat][data-test-session="local-a"]'), "the shell did not open the local session");
      await click("[data-test-emit]");
      const oldChat = document.querySelector("[data-test-chat]");
      const oldOwner = Number(oldChat.dataset.testChat);
      const oldRecord = globalThis.__readerOwnerProbe.owners.get(oldOwner);
      assert.match(oldChat.textContent, /live/);
      window.history.replaceState(null, "", "/");
      await app.rerender();
      await waitFor(() => document.querySelector(`[data-test-${collection}]`), "the normal activity sidebar did not mount");
      await click(`[data-test-${collection}]`);
      await waitFor(() => document.querySelector('[data-test-chat][data-test-session="draft"]'), "the collection did not switch to a draft context");
      const newChat = document.querySelector("[data-test-chat]");
      assert.notEqual(Number(newChat.dataset.testChat), oldOwner, `${collection} must use a new chat owner`);
      assert.equal(oldRecord.mounted, false, `${collection} must unmount the old chat`);
      await React.act(async () => { oldRecord.emit("late"); await tick(); });
      assert.doesNotMatch(newChat.textContent, /live|late/, `${collection} must not show old or late content`);
    } finally { await app.unmount(); }
  }
});

test("remote fork metadata still updates the current fork when navigation has not changed", async () => {
  const app = await mount();
  try {
    await waitFor(() => document.querySelector("[data-test-new-remote]"), "the activity sidebar did not mount");
    await click("[data-test-new-remote]");
    await click("[data-test-promote]");
    await waitFor(() => document.querySelector('[data-test-chat][data-test-peer="peer-a"][data-test-session="promoted-a"]'), "the source session did not promote");
    globalThis.__readerOwnerProbe.deferForkList = true;
    await click("[data-test-fork-session]");
    await waitFor(() => globalThis.__readerOwnerProbe.resolveForkList, "the source peer did not request fork metadata");
    await React.act(async () => {
      globalThis.__readerOwnerProbe.resolveForkList({ ok: true, status: 200, json: async () => ({ sessions: [{ id: "fork-from-a", cwd: "/tmp/reader-ownership-project", path: "/tmp/fork-from-a.jsonl" }] }) });
      await tick(); await tick();
    });
    await waitFor(() => document.querySelector('[data-test-chat][data-test-session="fork-from-a"]')?.dataset.testPath === "/tmp/fork-from-a.jsonl", "the current fork must accept its own metadata");
  } finally { await app.unmount(); }
});

test("late remote fork callbacks and metadata cannot replace a newer peer", async () => {
  const app = await mount();
  try {
    await waitFor(() => document.querySelector("[data-test-new-remote]"), "the activity sidebar did not mount");
    await click("[data-test-new-remote]");
    await click("[data-test-promote]");
    await waitFor(() => document.querySelector('[data-test-chat][data-test-peer="peer-a"][data-test-session="promoted-a"]'), "the source session did not promote");
    const source = document.querySelector("[data-test-chat]");
    const sourceRecord = globalThis.__readerOwnerProbe.owners.get(Number(source.dataset.testChat));
    globalThis.__readerOwnerProbe.deferForkList = true;
    await click("[data-test-fork-session]");
    await waitFor(() => globalThis.__readerOwnerProbe.resolveForkList, "the source peer did not request fork metadata");
    await waitFor(() => document.querySelector('[data-test-chat][data-test-peer="peer-a"][data-test-session="fork-from-a"]'), "the fork fallback was not shown");
    await click("[data-test-other-remote]");
    await waitFor(() => document.querySelector('[data-test-chat][data-test-peer="peer-b"][data-test-session="promoted-a"]'), "the newer peer did not open");
    await React.act(async () => { sourceRecord.fork({ restoreMessage: { role: "user", content: "late fork" } }); await tick(); });
    assert.ok(document.querySelector('[data-test-chat][data-test-peer="peer-b"][data-test-session="promoted-a"]'), "a stale first-message fork must not replace the newer peer");
    await React.act(async () => {
      globalThis.__readerOwnerProbe.resolveForkList({ ok: true, status: 200, json: async () => ({ sessions: [{ id: "fork-from-a", cwd: "/tmp/reader-ownership-project", path: "/tmp/fork-from-a.jsonl" }] }) });
      await tick(); await tick();
    });
    assert.ok(document.querySelector('[data-test-chat][data-test-peer="peer-b"][data-test-session="promoted-a"]'), "stale fork metadata must not replace the newer peer");
  } finally { await app.unmount(); }
});

test("AppShell retains a remote draft owner during promotion but isolates another draft and peer", async () => {
  const app = await mount();
  try {
    await waitFor(() => document.querySelector("[data-test-new-remote]"), "the activity sidebar did not mount");
    await click("[data-test-new-remote]");
    await waitFor(() => document.querySelector('[data-test-chat][data-test-peer="peer-a"][data-test-session="draft"]'), "the remote draft did not mount");
    await click("[data-test-emit]");
    const before = document.querySelector("[data-test-chat]");
    const first = Number(before.dataset.testChat);
    const record = globalThis.__readerOwnerProbe.owners.get(first);
    await click("[data-test-promote]");
    await waitFor(() => document.querySelector('[data-test-chat][data-test-session="promoted-a"]'), "remote promotion did not update the real shell");
    const promoted = document.querySelector("[data-test-chat]");
    assert.equal(Number(promoted.dataset.testChat), first, "promotion must retain the existing remote chat owner");
    assert.equal(record.mounted, true);
    assert.match(promoted.textContent, /live/);
    await click("[data-test-same-remote]");
    assert.equal(Number(document.querySelector("[data-test-chat]").dataset.testChat), first, "reselecting the promoted peer/session must keep its owner");
    assert.equal(record.mounted, true);
    await React.act(async () => { record.emit("-after"); await tick(); });
    assert.match(promoted.textContent, /live-after/);
    await click("[data-test-fork-first]");
    await waitFor(() => document.querySelector('[data-test-chat][data-test-peer="peer-a"][data-test-session="draft"]'), "forking the first message must create a remote draft");
    const forkDraft = document.querySelector("[data-test-chat]");
    const forkOwner = Number(forkDraft.dataset.testChat);
    assert.notEqual(forkOwner, first, "the forked draft must not retain its source session owner");
    await click("[data-test-emit]");
    await click("[data-test-promote]");
    await waitFor(() => document.querySelector('[data-test-chat][data-test-session="promoted-a"]'), "the forked draft must also promote");
    assert.equal(Number(document.querySelector("[data-test-chat]").dataset.testChat), forkOwner);
    assert.match(document.querySelector("[data-test-chat]").textContent, /live/);
    const forkRecord = globalThis.__readerOwnerProbe.owners.get(forkOwner);
    await click("[data-test-other-remote]");
    await waitFor(() => document.querySelector('[data-test-chat][data-test-peer="peer-b"][data-test-session="promoted-a"]'), "the same session id on the other peer did not open");
    const otherPeer = document.querySelector("[data-test-chat]");
    assert.notEqual(Number(otherPeer.dataset.testChat), forkOwner, "same session id on another peer must use another owner");
    assert.equal(forkRecord.mounted, false);
    await React.act(async () => { forkRecord.emit("late-peer-a"); await tick(); });
    assert.doesNotMatch(otherPeer.textContent, /live|late-peer-a/);
    await click("[data-test-new-remote]");
    await waitFor(() => document.querySelector('[data-test-chat][data-test-peer="peer-a"][data-test-session="draft"]'), "the next remote draft did not mount");
    const second = document.querySelector("[data-test-chat]");
    assert.notEqual(Number(second.dataset.testChat), first, "a second draft in the same cwd is a new owner");
    assert.notEqual(Number(second.dataset.testChat), forkOwner, "a new draft must not reuse the promoted fork owner");
    assert.equal(record.mounted, false);
    assert.doesNotMatch(second.textContent, /live/);
  } finally { await app.unmount(); }
});
