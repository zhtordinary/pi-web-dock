import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import ts from "typescript";
import { installEnglishTestLocale, markupText, testTranslator } from "./test-locale.mjs";

const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const chat = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, { fsCache: false, jsx: { runtime: "automatic" }, tsconfigPaths: true });
await installEnglishTestLocale(jiti);
const inPageFork = markupText(testTranslator("en")("message.inPageFork"));
const { MessageView } = await jiti.import("./MessageView.tsx");
const { ProcessDetailsGroup } = await jiti.import("./ProcessDetailsGroup.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const flush = () => new Promise(resolve => setImmediate(resolve));

function runningHarness() {
  const start = shell.indexOf("  const [runningSessionIds, setRunningSessionIds]");
  const end = shell.indexOf("  const [newSessionCwd, setNewSessionCwd]", start);
  assert.ok(start >= 0 && end > start);
  const effects = [], requests = [], timers = new Map(), listeners = new Map();
  const source = { close() { this.closed = true; } };
  const document = {
    visibilityState: "visible",
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type) { listeners.delete(type); },
  };
  let state, nextTimer = 0;
  const window = {
    setTimeout(callback, ms) { const id = ++nextTimer; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const useState = initial => {
    state = typeof initial === "function" ? initial() : initial;
    return [state, next => { state = typeof next === "function" ? next(state) : next; }];
  };
  const fetch = (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
  const body = stripTypeScriptTypes(shell.slice(start, end));
  new Function("useState", "useRef", "useCallback", "useEffect", "openReaderEventSource", "window", "document", "fetch", "AbortController", "RUNNING_SESSIONS_POLL_MS", "RUNNING_SESSIONS_POLL_TIMEOUT_MS", body)(
    useState, current => ({ current }), fn => fn, effect => effects.push(effect), () => source,
    window, document, fetch, AbortController, 5000, 4000,
  );
  const cleanups = effects.map(effect => effect()).filter(Boolean);
  return {
    requests, source, document, listeners,
    ids: () => state,
    event: ids => source.onmessage({ data: JSON.stringify({ type: "running", runningSessionIds: ids }) }),
    tick(ms) {
      const entry = [...timers].find(([, timer]) => timer.ms === ms);
      assert.ok(entry, `expected a ${ms}ms timer`);
      timers.delete(entry[0]); entry[1].callback();
    },
    cleanup() { cleanups.forEach(cleanup => cleanup()); },
  };
}

function chatExpression(name, arguments_) {
  const tree = ts.createSourceFile("ChatWindow.tsx", chat, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) initializer = node.initializer;
    if (!initializer) ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(initializer, `missing ${name}`);
  return new Function(...Object.keys(arguments_), `return (${initializer.getText(tree)});`)(...Object.values(arguments_));
}

function renderState(ids, { agentRunning = false, observedSessionRunning = false, bashRunning = false, isStreaming = false, isCompacting = false, activityActive = false, execution = { active: false }, continueUi = { kind: "idle" } } = {}) {
  const sessionBusy = chatExpression("sessionBusy", {
    sessionRunning: ids.has("s"), observedSessionRunning, agentRunning, bashRunning,
    isStreaming, isCompacting,
  });
  const canStop = chatExpression("canStopExecution", { sessionBusy, activityActive, execution, continueUi });
  const isLiveTail = chatExpression("isLiveTail", { sessionBusy, unfinishedAssistantTail: false, isCurrentTail: true });
  const process = renderToStaticMarkup(React.createElement(ProcessDetailsGroup, {
    active: isLiveTail, initiallyExpanded: false, messageCount: 1, toolCallCount: 0, t: key => key,
  }, "process"));
  const message = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(MessageView, {
      message: { role: "user", content: "second turn" }, entryId: "user-2",
      prevAssistantEntryId: sessionBusy ? undefined : "assistant-1",
      onNavigate: sessionBusy ? undefined : () => true,
      onEditContent: sessionBusy ? undefined : () => {},
      onStartSideBranch: sessionBusy ? undefined : () => {},
    })));
  const answer = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(MessageView, {
      message: { role: "assistant", provider: "test", model: "test-model", content: [{ type: "text", text: "finished answer" }] },
      entryId: "assistant-2", onStartSideBranch: sessionBusy ? undefined : () => {},
    })));
  return { canStop, process, message, answer };
}

test("an unmounted session sidebar cannot strand stop, process details and inline fork after a missed terminal event", async () => {
  const h = runningHarness();
  try {
    h.event(["s"]);
    let view = renderState(h.ids());
    assert.equal(view.canStop, true);
    assert.match(view.process, /aria-expanded="true"/);
    assert.ok(!view.message.includes(inPageFork));
    assert.ok(!view.answer.includes(inPageFork));
    assert.equal(h.requests.length, 1, "AppShell must recover even while only the activity panel is mounted");
    h.requests[0].resolve({ ok: true, json: async () => ({ runningSessionIds: ["s"] }) });
    await flush();
    h.tick(5000);
    h.requests[1].resolve({ ok: true, json: async () => ({ runningSessionIds: [] }) });
    await flush();
    view = renderState(h.ids());
    assert.equal(view.canStop, false);
    assert.match(view.process, /aria-expanded="false"/);
    assert.ok(view.message.includes(inPageFork));
    assert.ok(view.answer.includes(inPageFork));
  } finally { h.cleanup(); }
});

test("a new running event wins over an older idle response even while its body is being read", async () => {
  const h = runningHarness();
  try {
    assert.equal(h.requests.length, 1);
    let finishBody;
    h.requests[0].resolve({ ok: true, json: () => new Promise(resolve => { finishBody = resolve; }) });
    await flush();
    h.event(["s"]);
    finishBody({ runningSessionIds: [] });
    await flush();
    assert.equal(h.ids().has("s"), true);
    assert.equal(renderState(h.ids()).canStop, true);
  } finally { h.cleanup(); }
});

test("failed or malformed fallback snapshots keep the last known running state", async () => {
  const h = runningHarness();
  try {
    h.event(["s"]);
    h.requests[0].resolve({ ok: true, json: async () => ({ runningSessionIds: [null] }) });
    await flush();
    h.tick(5000);
    h.requests[1].resolve({ ok: true, json: async () => ({ runningSessionIds: [null] }) });
    await flush();
    assert.equal(h.ids().has("s"), true);
    h.event([null]);
    assert.equal(h.ids().has("s"), true);
    h.tick(5000);
    h.requests[2].reject(new Error("offline"));
    await flush();
    assert.equal(h.ids().has("s"), true);
  } finally { h.cleanup(); }
});

test("hidden tabs abort old reads and cannot apply their late snapshots", async () => {
  const h = runningHarness();
  try {
    h.event(["s"]);
    h.document.visibilityState = "hidden";
    h.listeners.get("visibilitychange")();
    assert.equal(h.requests[0].options.signal.aborted, true);
    h.requests[0].resolve({ ok: true, json: async () => ({ runningSessionIds: [] }) });
    await flush();
    assert.equal(h.ids().has("s"), true);
    h.document.visibilityState = "visible";
    h.listeners.get("visibilitychange")();
    h.requests[1].resolve({ ok: true, json: async () => ({ runningSessionIds: [] }) });
    await flush();
    assert.equal(h.ids().has("s"), false);
  } finally { h.cleanup(); }
  assert.equal(h.source.closed, true);
});

test("an obsolete local running hint cannot override settled authoritative signals", () => {
  const view = renderState(new Set(), { observedSessionRunning: true });
  assert.equal(view.canStop, false);
  assert.match(view.process, /aria-expanded="false"/);
  assert.ok(view.message.includes(inPageFork));
  assert.ok(view.answer.includes(inPageFork));
});

test("background execution and retry remain stoppable even after the parent becomes idle", () => {
  assert.equal(renderState(new Set(), { activityActive: true }).canStop, true);
  assert.equal(renderState(new Set(), { execution: { active: true } }).canStop, true);
  assert.equal(renderState(new Set(), { continueUi: { kind: "running" } }).canStop, true);
  for (const active of [{ agentRunning: true }, { bashRunning: true }, { isStreaming: true }, { isCompacting: true }]) {
    const live = renderState(new Set(), active);
    assert.equal(live.canStop, true);
    assert.match(live.process, /aria-expanded="true"/);
  }
});
